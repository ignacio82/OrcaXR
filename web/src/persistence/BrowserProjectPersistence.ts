import { t } from '../l10n/t';
import type { ProjectRecoveryProof } from '../project/ports';
import { WorkerProjectSerializer } from '../project/serialization/WorkerProjectSerializer';
import { InitializationScope } from '../startup/FeatureInitialization';
import { askUnsavedProjectDecision } from '../ui/dom/UnsavedProjectDialog';
import type { UnsavedProjectDecision } from '../ui/UnsavedProjectDecision';
import { IndexedDbRecoveryStore, type RecoveryKey } from './IndexedDbRecoveryStore';
import {
  ProjectPersistenceController,
  type NavigationReason,
  type PersistenceProjectPort,
  type RecoverySessionSummary,
} from './ProjectPersistenceController';

export { WorkerProjectSerializer };
export type RecoveryOperation = 'recover' | 'download' | 'discard';
export interface BrowserPersistenceOptions {
  readonly project: PersistenceProjectPort;
  readonly host: HTMLElement;
  download(filename: string, bytes: Uint8Array, mediaType: string): void;
  restore(bytes: Uint8Array, filename: string, proof: ProjectRecoveryProof, signal: AbortSignal): Promise<boolean>;
  report(message: string): void;
  isXrPresenting(): boolean;
  chooseInXr(projectName: string, signal: AbortSignal): Promise<UnsavedProjectDecision>;
  invoke(operation: RecoveryOperation, id: string): Promise<unknown>;
  directoryChanged(rows: readonly RecoverySessionSummary[], message: string): void;
}

/** Browser storage, downloads and navigation adapt the shared persistence controller. */
export class BrowserProjectPersistence {
  readonly controller: ProjectPersistenceController;
  private readonly scope = new InitializationScope();
  private readonly store: IndexedDbRecoveryStore;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly message: HTMLElement;
  private rows: readonly RecoverySessionSummary[] = [];
  private directoryGeneration = 0;
  private approvedNavigation?: string;
  private beforeUnloadRegistered = false;
  private updateRequest?: Promise<void>;

  constructor(private readonly options: BrowserPersistenceOptions) {
    let budgetBytes = 512 * 1024 * 1024;
    try {
      const stored = Number(localStorage.getItem('orcaxr.recovery.budgetMiB'));
      if (Number.isInteger(stored) && stored >= 1 && stored <= 1024) budgetBytes = stored * 1024 * 1024;
    } catch {
      /* Session defaults remain usable without preference storage. */
    }
    this.store = this.scope.own(new IndexedDbRecoveryStore({ budgetBytes }));
    const random = new Uint8Array(16);
    globalThis.crypto.getRandomValues(random);
    const sessionId = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.controller = this.scope.own(
      new ProjectPersistenceController(
        options.project,
        {
          download: async (snapshot) => {
            options.download(
              snapshot.serialized.suggestedFilename,
              snapshot.serialized.bytes,
              snapshot.serialized.mediaType,
            );
            options.report(
              t(
                'persistence.downloadStarted',
                'Project download started. The browser controls completion of the disk write.',
              ),
            );
          },
          storeRecovery: async (snapshot, projectName, editingSessionId, cancellation) => {
            const digest = snapshot.serialized.archiveDigest;
            if (!digest)
              throw new Error('The serializer did not provide an archive integrity proof. Recovery is unavailable.');
            await this.store.write(
              {
                guard: snapshot.guard,
                sessionId: editingSessionId,
                projectName,
                filename: snapshot.serialized.suggestedFilename,
                bytes: snapshot.serialized.bytes,
                digest,
              },
              cancellation,
            );
            await this.refresh();
          },
          discardRecovery: async (projectId, editingSessionId) => {
            try {
              await this.store.discardSession(projectId, editingSessionId);
            } catch (error) {
              this.showError(error);
            }
            await this.refresh();
          },
          confirmNavigation: (_reason, projectName) =>
            options.isXrPresenting()
              ? options.chooseInXr(projectName, this.scope.signal)
              : askUnsavedProjectDecision(projectName, this.scope.signal),
          recovery: {
            list: async () =>
              (await this.store.list())
                .map((row) => ({
                  id: JSON.stringify(row.key),
                  projectName:
                    row.metadata?.projectName ?? t('persistence.unknownRecovery', 'Recovery from another version'),
                  savedAt: row.metadata?.capturedAt ?? '',
                  byteLength: row.metadata?.byteLength ?? 0,
                  available: Boolean(row.metadata),
                  ...(row.problem ? { reason: row.problem } : {}),
                }))
                .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
            restore: async (id) => {
              const record = await this.store.read(parseKey(id));
              this.scope.assertActive();
              return options.restore(
                record.bytes,
                record.metadata.filename,
                { guard: record.metadata.guard, archiveDigest: record.metadata.digest },
                this.scope.signal,
              );
            },
            download: async (id) => {
              const record = await this.store.readForDownload(parseKey(id));
              this.scope.assertActive();
              options.download(record.filename, record.bytes, 'model/3mf');
            },
            discard: async (id) => {
              await this.store.discard(parseKey(id));
              await this.refresh();
            },
          },
        },
        sessionId,
      ),
    );

    this.root = document.createElement('section');
    this.root.dataset.recoveryPanel = 'true';
    this.root.style.cssText =
      'padding:12px;border:1px solid var(--oxr-color-stroke);border-radius:8px;margin-top:12px;';
    const heading = document.createElement('h3');
    heading.textContent = t('persistence.recoveryHeading', 'Project recovery');
    const description = document.createElement('p');
    description.textContent = t(
      'persistence.recoveryDescription',
      'Recovery snapshots stay in this browser. They do not replace saving a project file.',
    );
    this.message = document.createElement('p');
    this.message.setAttribute('role', 'status');
    this.list = document.createElement('div');
    const budgetLabel = document.createElement('label');
    budgetLabel.textContent = t('persistence.budgetLabel', 'Recovery budget (MiB)');
    const budgetInput = document.createElement('input');
    budgetInput.type = 'number';
    budgetInput.min = '1';
    budgetInput.max = '1024';
    budgetInput.value = String(budgetBytes / 1024 / 1024);
    budgetInput.dataset.recoveryBudget = 'true';
    budgetLabel.append(budgetInput);
    budgetInput.onchange = () => {
      const requested = Number(budgetInput.value);
      if (!Number.isInteger(requested) || requested < 1 || requested > 1024) {
        this.showError(new Error('Choose a recovery budget from 1 to 1024 MiB.'));
        return;
      }
      void this.setBudget(requested).then(
        (actual) => {
          budgetInput.value = String(actual);
        },
        (error) => this.showError(error),
      );
    };
    this.root.append(heading, description, budgetLabel, this.message, this.list);
    options.host.append(this.root);
    this.scope.defer(() => this.root.remove());
    this.scope.defer(
      this.controller.subscribe((status) => {
        if (status.phase === 'error') this.showError(new Error(status.message));
      }),
    );
    this.scope.defer(options.project.subscribe(() => this.updateBeforeUnload()));
    this.scope.defer(() => window.removeEventListener('beforeunload', this.beforeUnload));
    const captureWhenHidden = () => {
      if (document.visibilityState === 'hidden' && options.project.read().dirty)
        void this.controller.captureNow().catch((error) => this.showError(error));
    };
    document.addEventListener('visibilitychange', captureWhenHidden);
    this.scope.defer(() => document.removeEventListener('visibilitychange', captureWhenHidden));
    document.addEventListener('click', this.navigateLink, true);
    this.scope.defer(() => document.removeEventListener('click', this.navigateLink, true));
    this.updateBeforeUnload();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.directoryGeneration;
    try {
      const rows = await this.controller.listRecoverySessions();
      if (this.scope.signal.aborted || generation !== this.directoryGeneration) return;
      this.rows = rows;
      this.message.textContent = rows.length
        ? t('persistence.recoveryAvailable', 'Recovery snapshots are available below.')
        : t('persistence.recoveryEmpty', 'No recovery snapshots yet.');
      this.render();
      this.options.directoryChanged(rows, this.message.textContent);
    } catch (error) {
      this.showError(error);
    }
  }

  async navigate(reason: NavigationReason, leave: () => void | Promise<void>): Promise<boolean> {
    if (!(await this.controller.guardNavigation(reason))) return false;
    this.scope.assertActive();
    const approved = this.controller.approvedNavigationGuard;
    if (!approved || JSON.stringify(approved) !== JSON.stringify(this.options.project.read().guard)) return false;
    this.approvedNavigation = JSON.stringify(approved);
    try {
      await leave();
      return true;
    } catch (error) {
      this.approvedNavigation = undefined;
      throw error;
    }
  }
  checkForUpdates(): Promise<void> {
    if (this.updateRequest) return this.updateRequest;
    this.updateRequest = this.applyUpdate()
      .catch((error) => this.showError(error))
      .finally(() => {
        this.updateRequest = undefined;
      });
    return this.updateRequest;
  }

  private async applyUpdate(): Promise<void> {
    this.scope.assertActive();
    if (!('serviceWorker' in navigator)) {
      this.options.report(
        t('actions.actionContext.updateCheckIsUnavailableIn', 'Update check is unavailable in this browser.'),
      );
      return;
    }
    this.options.report(t('actions.actionContext.checkingForUpdates', 'Checking for updates…'));
    const registration = await this.scope.load(navigator.serviceWorker.getRegistration());
    if (!registration) {
      this.options.report(t('persistence.noUpdateChannel', 'No application update channel is available.'));
      return;
    }
    await this.scope.load(registration.update());
    const installing = registration.installing;
    if (installing && installing.state !== 'installed' && installing.state !== 'redundant') {
      await this.waitForWorkerEvent(
        installing,
        'statechange',
        () => installing.state === 'installed' || installing.state === 'redundant',
      );
    }
    const waiting = registration.waiting;
    if (!waiting) {
      this.options.report(t('persistence.upToDate', 'OrcaXR is up to date.'));
      return;
    }
    await this.navigate('update', async () => {
      if (registration.waiting !== waiting) throw new Error('The application update changed. Check for updates again.');
      const previous = navigator.serviceWorker.controller;
      const changed = this.waitForWorkerEvent(
        navigator.serviceWorker,
        'controllerchange',
        () => navigator.serviceWorker.controller !== previous,
      );
      waiting.postMessage({ type: 'SKIP_WAITING' });
      await changed;
      this.scope.assertActive();
      // Editing can continue while activation is in flight. Bind the reload to
      // the approved revision, and ask again if it has changed in the meantime.
      if (this.approvedNavigation !== JSON.stringify(this.options.project.read().guard)) {
        await this.navigate('reload', () => location.reload());
      } else location.reload();
    });
  }

  private async waitForWorkerEvent(target: EventTarget, type: string, ready: () => boolean): Promise<void> {
    const scope = new InitializationScope();
    const abort = () => scope.dispose(new Error('Application persistence is closed.'));
    this.scope.signal.addEventListener('abort', abort, { once: true });
    try {
      await scope.load(
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (ready()) resolve();
          };
          target.addEventListener(type, check);
          scope.defer(() => target.removeEventListener(type, check));
          const timer = setTimeout(
            () => reject(new Error('The application update timed out. Your project has been kept.')),
            30_000,
          );
          scope.defer(() => clearTimeout(timer));
          check();
        }),
      );
    } finally {
      this.scope.signal.removeEventListener('abort', abort);
      scope.dispose();
    }
  }

  private readonly navigateLink = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.hasAttribute('download') ||
      (link.target && link.target !== '_self')
    )
      return;
    const url = new URL(link.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    )
      return;
    if (!this.options.project.read().dirty) return;
    event.preventDefault();
    void this.navigate('navigate', () => location.assign(url.href)).catch((error) => this.showError(error));
  };

  dispose(): void {
    this.scope.dispose();
  }

  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    const state = this.options.project.read();
    if (!state.dirty || this.approvedNavigation === JSON.stringify(state.guard)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  private updateBeforeUnload(): void {
    const dirty = this.options.project.read().dirty;
    if (dirty && !this.beforeUnloadRegistered) window.addEventListener('beforeunload', this.beforeUnload);
    else if (!dirty && this.beforeUnloadRegistered) window.removeEventListener('beforeunload', this.beforeUnload);
    this.beforeUnloadRegistered = dirty;
  }
  private render(): void {
    this.list.replaceChildren();
    for (const row of this.rows) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:8px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
      const label = document.createElement('span');
      label.textContent = `${row.projectName}${row.savedAt ? ` · ${new Date(row.savedAt).toLocaleString()}` : ''}${row.reason ? ` · ${row.reason}` : ''}`;
      item.append(label);
      for (const [operation, text] of [
        ['recover', t('persistence.recover', 'Recover')],
        ['download', t('persistence.downloadRecovery', 'Download recovery file')],
        ['discard', t('persistence.discardRecovery', 'Discard recovery')],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.dataset.recoveryAction = operation;
        button.dataset.recoveryId = row.id;
        button.disabled = operation === 'recover' && !row.available;
        button.onclick = () => {
          void this.options.invoke(operation, row.id).catch((error) => this.showError(error));
        };
        item.append(button);
      }
      this.list.append(item);
    }
  }
  private async setBudget(mebibytes: number): Promise<number> {
    let available: number | undefined;
    try {
      const estimate = await navigator.storage?.estimate();
      if (estimate?.quota !== undefined && estimate.usage !== undefined)
        available = Math.floor(
          estimate.quota - estimate.usage + this.rows.reduce((sum, row) => sum + row.byteLength, 0),
        );
    } catch {
      /* Actual quota failures remain transactional and visible. */
    }
    this.scope.assertActive();
    if (available !== undefined && available < 1024 * 1024)
      throw new Error('Less than 1 MiB of recovery storage is available in this browser.');
    const actualBytes = this.store.setBudget(mebibytes * 1024 * 1024, available);
    const actual = Math.floor(actualBytes / 1024 / 1024);
    try {
      localStorage.setItem('orcaxr.recovery.budgetMiB', String(actual));
    } catch {
      /* The session setting still applies. */
    }
    return actual;
  }
  private showError(error: unknown): void {
    if (this.scope.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    this.message.textContent = message;
    this.options.report(message);
    this.options.directoryChanged(this.rows, message);
  }
}

function parseKey(id: string): RecoveryKey {
  if (id.length > 1024) throw new Error('Invalid recovery selection');
  const key: unknown = JSON.parse(id);
  if (
    !Array.isArray(key) ||
    key.length !== 3 ||
    typeof key[0] !== 'string' ||
    typeof key[1] !== 'string' ||
    !Number.isSafeInteger(key[2])
  )
    throw new Error('Invalid recovery selection');
  return key as [string, string, number];
}
