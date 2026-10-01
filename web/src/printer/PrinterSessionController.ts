import type { MoonrakerTransport, MoonrakerObjectSubscription } from './MoonrakerTransport';
import type { MoonrakerConnectionState, MoonrakerHandshake, MoonrakerNotification } from './MoonrakerTypes';
import {
  executePrintJobCommand,
  printJobCommandAvailability,
  PrintJobCommandError,
  type PrintJobCommand,
  type PrintJobCommandDescriptor,
  type PrintJobCommandTransport,
} from './PrintJobControl';
import {
  PRINT_JOB_OBJECTS,
  PRINT_JOB_QUERY_PATH,
  PrintJobStatusModel,
  isActivePrintState,
  type PrintJobSnapshot,
} from './PrintJobStatus';

export interface PrinterSelection {
  readonly id: string;
  readonly name?: string;
  readonly endpoint: string;
  readonly port: number;
  readonly apiKey?: string;
}

export interface PrinterSessionTransport extends PrintJobCommandTransport {
  readonly state: MoonrakerConnectionState;
  connect(options?: { readonly signal?: AbortSignal }): Promise<MoonrakerHandshake>;
  dispose(): void;
  setObjectSubscription(subscription: MoonrakerObjectSubscription | null): void;
  subscribeState(listener: (state: MoonrakerConnectionState) => void): () => void;
  subscribeNotifications(listener: (notification: MoonrakerNotification) => void): () => void;
  requestRecoveryCommand(command: 'emergency-stop' | 'firmware-restart', signal?: AbortSignal): Promise<unknown>;
}

export interface PrinterSessionLease<T extends PrinterSessionTransport = MoonrakerTransport> {
  readonly printerId: string;
  readonly label: string;
  readonly generation: number;
  readonly transport: T;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface PrintJobIdentity {
  readonly jobId: string;
  readonly startedAt: number;
  readonly filename: string;
  readonly size: number;
  readonly modified: number;
}

/** Created at click/press time, before any dialog or hold. Never rebound on release. */
export interface PrintJobCommandIntent {
  readonly printerId: string;
  readonly printerLabel: string;
  readonly generation: number;
  readonly command: PrintJobCommand;
  readonly displayedFilename?: string;
  readonly observedState: PrintJobSnapshot['state'];
  readonly job?: PrintJobIdentity;
}

/** Controller-issued, single-use proof of a gesture for this exact intent. */
export interface PrintJobConfirmation {
  readonly intent: PrintJobCommandIntent;
}

const IDENTITY_HELP =
  'Cannot identify the running job. Enable Moonraker history and file metadata, then reconnect to refresh the printer status.';
export const isPrinterRecoveryCommand = (command: PrintJobCommand): command is 'emergency-stop' | 'firmware-restart' =>
  command === 'emergency-stop' || command === 'firmware-restart';

/** Owns one selected printer and every query, subscription, and command in its session. */
export class PrinterSessionController<T extends PrinterSessionTransport = MoonrakerTransport> {
  private selected: PrinterSelection | null = null;
  private transportValue: T | null = null;
  private generationValue = 0;
  private epoch = new AbortController();
  private stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private model = new PrintJobStatusModel();
  private snapshotValue: PrintJobSnapshot | null = null;
  private identity: PrintJobIdentity | undefined;
  private stateValue: MoonrakerConnectionState | null = null;
  private refreshSequence = 0;
  private observationVersion = 0;
  private statusVerified = false;
  private identityFailure = IDENTITY_HELP;
  private ordinaryBusy: PrintJobCommandIntent | null = null;
  private readonly recoveryBusy = new Map<PrintJobCommand, PrintJobCommandIntent>();
  private readonly intents = new WeakSet<PrintJobCommandIntent>();
  private readonly confirmations = new WeakSet<PrintJobConfirmation>();
  private readonly consumed = new WeakSet<PrintJobCommandIntent>();
  private disposed = false;

  constructor(private readonly createTransport: (selection: PrinterSelection) => T) {}

  get transport(): T | null {
    return this.transportValue;
  }
  get snapshot(): PrintJobSnapshot | null {
    return this.snapshotValue;
  }
  get state(): MoonrakerConnectionState | null {
    return this.stateValue;
  }
  get generation(): number {
    return this.generationValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(selection: PrinterSelection): T {
    if (this.disposed) throw new Error('Printer session is disposed.');
    const previous = this.selected;
    if (
      previous &&
      previous.id === selection.id &&
      previous.endpoint === selection.endpoint &&
      previous.port === selection.port &&
      previous.apiKey === selection.apiKey &&
      this.transportValue
    ) {
      return this.transportValue;
    }
    this.clear();
    this.selected = Object.freeze({ ...selection });
    const transport = this.createTransport(selection);
    this.transportValue = transport;
    transport.setObjectSubscription(PRINT_JOB_OBJECTS);
    this.stops.push(
      transport.subscribeNotifications((notification) => {
        if (this.transportValue !== transport) return;
        if (notification.method === 'notify_history_changed') {
          this.identity = undefined;
          this.observationVersion++;
          this.emit();
          this.refreshInBackground();
        }
        if (notification.method !== 'notify_status_update' || this.stateValue?.status !== 'connected') return;
        const before = this.snapshotValue;
        const next = this.model.applyNotification(notification.params);
        if (!next) return;
        const changed =
          !sameJobState(before, next) ||
          (next.totalDurationS !== undefined &&
            before?.totalDurationS !== undefined &&
            next.totalDurationS < before.totalDurationS);
        this.snapshotValue = next;
        if (changed) {
          this.identity = undefined;
          this.observationVersion++;
        }
        this.emit();
        if (changed) this.refreshInBackground();
      }),
    );
    this.stops.push(
      transport.subscribeState((state) => {
        if (this.transportValue !== transport) return;
        const previousState = this.stateValue;
        if (
          previousState?.status !== state.status ||
          previousState.generation !== state.generation ||
          (previousState.status === 'connected' &&
            state.status === 'connected' &&
            previousState.socketEpoch !== state.socketEpoch)
        )
          this.invalidate();
        this.stateValue = state;
        this.emit();
        if (state.status === 'connected' && previousState?.status !== 'connected') this.refreshInBackground();
      }),
    );
    return transport;
  }

  async connect(signal?: AbortSignal): Promise<{ transport: T; handshake: MoonrakerHandshake }> {
    const transport = this.transportValue;
    if (!transport) throw new Error('Select a printer first.');
    const handshake = await transport.connect({ signal });
    if (this.transportValue !== transport) throw new Error('The selected printer changed during connection.');
    // Also repairs a failed status/identity read when HTTP and the socket stayed
    // connected: pressing Reconnect must actually refresh those prerequisites.
    if (!this.statusVerified) await this.refresh().catch(() => {});
    if (this.transportValue !== transport) throw new Error('The selected printer changed during connection.');
    return { transport, handshake };
  }

  captureLease(): PrinterSessionLease<T> {
    const selected = this.selected;
    const transport = this.transportValue;
    const generation = this.generationValue;
    if (!selected || !transport || this.stateValue?.status !== 'connected')
      throw new Error('Connect to the selected printer first.');
    return Object.freeze({
      printerId: selected.id,
      label: selected.name ?? selected.endpoint,
      generation,
      transport,
      signal: this.epoch.signal,
      assertCurrent: () => {
        if (
          this.disposed ||
          this.transportValue !== transport ||
          this.generationValue !== generation ||
          this.stateValue?.status !== 'connected'
        ) {
          throw new Error('The selected printer or connection changed. Confirm a new send.');
        }
      },
    });
  }

  clear(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.invalidate();
    this.transportValue?.dispose();
    this.transportValue = null;
    this.selected = null;
    this.stateValue = null;
    this.snapshotValue = null;
    this.model.reset();
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }

  availability(): readonly PrintJobCommandDescriptor[] {
    return printJobCommandAvailability(this.snapshotValue).map((action) => {
      const reason = !this.selected
        ? 'Select a printer first.'
        : isPrinterRecoveryCommand(action.command)
          ? this.recoveryBusy.has(action.command)
            ? 'This recovery command is already pending.'
            : undefined
          : this.ordinaryBusy
            ? 'A printer command is already pending.'
            : this.stateValue?.status !== 'connected'
              ? 'Reconnect to refresh the printer status.'
              : !this.statusVerified || !this.identity
                ? this.identityFailure
                : undefined;
      return reason ? Object.freeze({ ...action, allowed: false, reason }) : action;
    });
  }

  captureIntent(command: PrintJobCommand): PrintJobCommandIntent {
    const action = this.availability().find((entry) => entry.command === command);
    if (!this.selected || !action?.allowed) {
      throw new PrintJobCommandError(action?.reason ?? 'Select a printer first.', 'not-allowed', command);
    }
    const intent: PrintJobCommandIntent = Object.freeze({
      printerId: this.selected.id,
      printerLabel: this.selected.name ?? this.selected.endpoint,
      generation: this.generationValue,
      command,
      observedState: this.snapshotValue?.state ?? 'unknown',
      ...(this.snapshotValue?.filename ? { displayedFilename: this.snapshotValue.filename } : {}),
      ...(!isPrinterRecoveryCommand(command) && this.identity ? { job: this.identity } : {}),
    });
    this.intents.add(intent);
    return intent;
  }

  confirm(intent: PrintJobCommandIntent): PrintJobConfirmation {
    this.assertIntent(intent);
    const confirmation = Object.freeze({ intent });
    this.confirmations.add(confirmation);
    return confirmation;
  }

  async execute(
    intent: PrintJobCommandIntent,
    confirmation?: PrintJobConfirmation | ((intent: PrintJobCommandIntent, signal: AbortSignal) => Promise<boolean>),
  ): Promise<void> {
    this.assertIntent(intent);
    const recovery = isPrinterRecoveryCommand(intent.command);
    if (recovery ? this.recoveryBusy.has(intent.command) : this.ordinaryBusy) {
      throw new PrintJobCommandError(
        'A printer command is already pending; nothing else was sent.',
        'busy',
        intent.command,
      );
    }
    this.consumed.add(intent);
    if (recovery) this.recoveryBusy.set(intent.command, intent);
    else this.ordinaryBusy = intent;
    const transport = this.transportValue!;
    const signal = this.epoch.signal;
    let queriedJob = false;
    this.emit();
    try {
      if (intent.command !== 'pause' && intent.command !== 'resume') {
        if (typeof confirmation === 'function') {
          if (!(await abortableConfirmation(confirmation(intent, signal), signal)))
            throw new PrintJobCommandError('Command dismissed; nothing was sent.', 'cancelled', intent.command);
        } else if (!confirmation || confirmation.intent !== intent || !this.confirmations.delete(confirmation)) {
          throw new PrintJobCommandError(
            'Confirm this exact printer command first.',
            'confirmation-required',
            intent.command,
          );
        }
      }
      this.assertSession(intent);
      if (isPrinterRecoveryCommand(intent.command)) {
        await transport.requestRecoveryCommand(intent.command, signal);
      } else {
        queriedJob = true;
        const fresh = await this.readAuthoritative(signal);
        this.assertSession(intent);
        if (!sameIdentity(intent.job, fresh.identity) || intent.displayedFilename !== fresh.snapshot.filename) {
          throw new PrintJobCommandError(
            'The running job changed after you chose this command. Review the current job and try again.',
            'job-changed',
            intent.command,
          );
        }
        await executePrintJobCommand(transport, {
          command: intent.command,
          observed: fresh.snapshot,
          expectedFilename: intent.displayedFilename,
          signal,
        });
      }
      this.assertSession(intent);
    } catch (error) {
      if (error instanceof PrintJobCommandError) throw error;
      if (signal.aborted)
        throw new PrintJobCommandError(
          'The printer session changed; refresh before trying again.',
          'session-changed',
          intent.command,
        );
      throw new PrintJobCommandError(
        'The printer command could not be verified. Refresh the printer status before trying again; the request will not be retried automatically.',
        'request-failed',
        intent.command,
      );
    } finally {
      if (queriedJob && !signal.aborted) {
        // A completed command or rejected identity makes the old reading
        // unsuitable for another gesture. Keep controls unavailable until the
        // replacement refresh finishes, including during its first HTTP read.
        this.refreshSequence++;
        this.statusVerified = false;
        this.identity = undefined;
        this.identityFailure = 'Verifying the current printer job. Wait for the status refresh before trying again.';
      }
      if (recovery && this.recoveryBusy.get(intent.command) === intent) this.recoveryBusy.delete(intent.command);
      if (this.ordinaryBusy === intent) this.ordinaryBusy = null;
      this.emit();
      if (!signal.aborted) this.refreshInBackground();
    }
  }

  /** Explicit refreshes fail closed; incremental notifications never fill their missing fields. */
  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    const signal = this.epoch.signal;
    try {
      const fresh = await this.readAuthoritative(signal, (snapshot, model) => {
        if (sequence !== this.refreshSequence || signal.aborted) return;
        if (!sameJobState(this.snapshotValue, snapshot)) {
          this.statusVerified = false;
          this.identity = undefined;
        }
        this.model = model;
        this.snapshotValue = snapshot;
        this.emit();
      });
      if (sequence !== this.refreshSequence || signal.aborted) return;
      this.model = fresh.model;
      this.snapshotValue = fresh.snapshot;
      this.identity = fresh.identity;
      this.statusVerified = true;
      this.emit();
    } catch (error) {
      if (sequence === this.refreshSequence && !signal.aborted) {
        this.statusVerified = false;
        this.identity = undefined;
        this.identityFailure = IDENTITY_HELP;
        this.emit();
      }
      throw error;
    }
  }

  private async readAuthoritative(
    signal: AbortSignal,
    onReading?: (snapshot: PrintJobSnapshot, model: PrintJobStatusModel) => void,
  ) {
    const transport = this.transportValue;
    const generation = this.generationValue;
    const version = this.observationVersion;
    const assertCurrent = () => {
      if (
        !transport ||
        signal.aborted ||
        this.generationValue !== generation ||
        this.observationVersion !== version ||
        this.stateValue?.status !== 'connected'
      ) {
        throw new Error('The printer changed during status refresh.');
      }
    };
    assertCurrent();
    const request = (path: string) => {
      assertCurrent();
      return transport!.request<unknown>(path, { signal, operation: 'print_job_identity' });
    };
    const model = new PrintJobStatusModel();
    const snapshot = model.applyQuery(await request(PRINT_JOB_QUERY_PATH));
    assertCurrent();
    onReading?.(snapshot, model);
    if (snapshot.state === 'unknown' || snapshot.klippyState === undefined || snapshot.virtualSdActive === undefined) {
      throw new Error('The printer did not report complete readiness data.');
    }
    if (!isActivePrintState(snapshot.state)) return { model, snapshot, identity: undefined };
    if (!snapshot.filename) throw new Error(IDENTITY_HELP);
    const metadataPath = `/server/files/metadata?filename=${encodeURIComponent(snapshot.filename)}`;
    const metadata = await request(metadataPath);
    const identity = readIdentity(metadata, snapshot.filename);
    if (!identity) throw new Error(IDENTITY_HELP);
    const history = await request(`/server/history/job?uid=${encodeURIComponent(identity.jobId)}`);
    if (
      !isRecord(history) ||
      !isRecord(history.job) ||
      history.job.job_id !== identity.jobId ||
      history.job.filename !== identity.filename ||
      history.job.start_time !== identity.startedAt ||
      history.job.status !== 'in_progress' ||
      history.job.end_time !== null ||
      history.job.exists !== true
    ) {
      throw new Error(IDENTITY_HELP);
    }
    // Bracket the history read with fresh metadata/status so a replacement during
    // the read cannot combine the old history row with the new running file.
    const finalMetadata = readIdentity(await request(metadataPath), snapshot.filename);
    const finalSnapshot = model.applyQuery(await request(PRINT_JOB_QUERY_PATH));
    assertCurrent();
    if (!sameIdentity(identity, finalMetadata) || !sameJobState(snapshot, finalSnapshot))
      throw new Error(IDENTITY_HELP);
    return { model, snapshot: finalSnapshot, identity };
  }

  private assertIntent(intent: PrintJobCommandIntent): void {
    if (!this.intents.has(intent) || this.consumed.has(intent)) {
      throw new PrintJobCommandError(
        'This command intent is invalid or was already used.',
        'not-allowed',
        intent.command,
      );
    }
    this.assertSession(intent);
  }

  private assertSession(intent: PrintJobCommandIntent): void {
    if (
      this.disposed ||
      !this.selected ||
      !this.transportValue ||
      intent.printerId !== this.selected.id ||
      intent.generation !== this.generationValue
    ) {
      throw new PrintJobCommandError(
        'The selected printer or connection changed. Review it and confirm again.',
        'session-changed',
        intent.command,
      );
    }
  }

  private invalidate(): void {
    this.epoch.abort();
    this.epoch = new AbortController();
    this.generationValue++;
    this.refreshSequence++;
    this.identity = undefined;
    this.statusVerified = false;
    this.ordinaryBusy = null;
    this.recoveryBusy.clear();
    this.model.reset();
  }

  private refreshInBackground(): void {
    if (this.stateValue?.status === 'connected') void this.refresh().catch(() => {});
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function readIdentity(value: unknown, filename: string): PrintJobIdentity | undefined {
  if (
    !isRecord(value) ||
    value.filename !== filename ||
    typeof value.job_id !== 'string' ||
    !value.job_id.trim() ||
    !finitePositive(value.print_start_time) ||
    !finitePositive(value.modified) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  )
    return undefined;
  return Object.freeze({
    jobId: value.job_id,
    startedAt: value.print_start_time,
    filename,
    size: value.size,
    modified: value.modified,
  });
}

function sameIdentity(a: PrintJobIdentity | undefined, b: PrintJobIdentity | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.jobId === b.jobId &&
    a.startedAt === b.startedAt &&
    a.filename === b.filename &&
    a.size === b.size &&
    a.modified === b.modified
  );
}

function sameJobState(a: PrintJobSnapshot | null, b: PrintJobSnapshot): boolean {
  return (
    !!a &&
    a.state === b.state &&
    a.filename === b.filename &&
    a.klippyState === b.klippyState &&
    a.virtualSdActive === b.virtualSdActive
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function abortableConfirmation(answer: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new Error('Session changed.'));
    };
    if (signal.aborted) {
      reject(new Error('Session changed.'));
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
