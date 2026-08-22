import type { FilamentId } from '../../project/domain/ids';
import { t } from '../../l10n/t';
import type {
  CanonicalFilamentAssignmentSnapshot,
  CanonicalFilamentOption,
} from '../../workspace/CanonicalWorkspaceController';
import type { FilamentAssignmentApplyRequest } from './FilamentAssignmentSelector';

type MaybePromise = void | Promise<void>;

export interface SelectionFilamentBarAdapter {
  getSnapshot(): CanonicalFilamentAssignmentSnapshot;
  subscribe?(listener: () => void): () => void;
  onApply(request: FilamentAssignmentApplyRequest): MaybePromise;
  onError?(error: unknown): void;
}

let barSequence = 0;

/**
 * One click from a selected model to the filament it prints in.
 *
 * The inspector's full selector states every scope and its inheritance and then
 * asks for a confirming press, which is the right shape for a deliberate
 * multi-scope edit and the wrong shape for "make this one blue". This bar is
 * the same canonical action with the deliberation removed: it appears only when
 * the selection can actually take a filament, shows the loaded spools as they
 * are — colour, head, and the name the machine reported — and assigns on the
 * first press. It renders nothing of its own; every row comes from the same
 * revision-guarded snapshot the selector reads.
 */
export class SelectionFilamentBar {
  private readonly instanceId = ++barSequence;
  private root?: HTMLElement;
  private snapshot?: CanonicalFilamentAssignmentSnapshot;
  private unsubscribe?: () => void;
  private applying = false;
  private statusMessage?: string;
  private statusIsError = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SelectionFilamentBarAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const root = this.container.ownerDocument.createElement('div');
    root.dataset.selectionFilamentBar = 'true';
    root.className = 'selection-filament-bar';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', t('ui.selectionFilamentBar.filamentForSelection', 'Filament for the selection'));
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    this.snapshot = this.adapter.getSnapshot();
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
    this.snapshot = undefined;
  }

  private render(): void {
    const root = this.root;
    const snapshot = this.snapshot;
    if (!root || !snapshot) return;
    // Nothing selected that can take a filament is not a message; it is the bar
    // having no business being on screen.
    const assignable = snapshot.scopes.length > 0 && snapshot.unsupportedSelection.length === 0;
    this.container.hidden = !assignable;
    if (!assignable) {
      root.replaceChildren();
      return;
    }

    const document = root.ownerDocument;
    const fragment = document.createDocumentFragment();

    const label = document.createElement('span');
    label.className = 'selection-filament-label';
    label.dataset.selectionFilamentLabel = 'true';
    label.textContent = describeScopes(snapshot);
    fragment.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'selection-filament-chips';
    const current = uniformAssignment(snapshot);
    const physical = snapshot.options.filter((option) => option.kind === 'physical');
    const mixed = snapshot.options.filter((option) => option.kind === 'mixed');
    for (const option of [...physical, ...mixed]) {
      chips.appendChild(this.createChip(option, current === option.id));
    }
    chips.appendChild(this.createInheritChip(current === null));
    fragment.appendChild(chips);

    const status = document.createElement('span');
    status.className = 'selection-filament-status';
    status.dataset.selectionFilamentStatus = 'true';
    status.setAttribute('role', this.statusIsError ? 'alert' : 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = this.statusMessage ?? '';
    if (this.statusIsError) status.dataset.selectionFilamentError = 'true';
    fragment.appendChild(status);

    root.replaceChildren(fragment);
  }

  private createChip(option: CanonicalFilamentOption, pressed: boolean): HTMLElement {
    const document = this.container.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'selection-filament-chip';
    button.dataset.selectionFilamentChip = option.kind;
    button.dataset.filamentId = option.id;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.disabled = !option.enabled || this.applying;
    const head =
      option.kind === 'physical' && option.toolId !== undefined
        ? `${t('ui.selectionFilamentBar.head', 'Head')} ${option.toolId + 1}`
        : t('ui.selectionFilamentBar.mixed', 'Mixed');
    button.title = `${head} · ${option.name}`;
    if (option.warnings.length > 0) button.title += ` · ${option.warnings.join(' ')}`;

    const swatch = document.createElement('span');
    swatch.className = 'selection-filament-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.background = option.color;
    button.appendChild(swatch);

    const index = document.createElement('span');
    index.className = 'selection-filament-index';
    index.textContent = option.kind === 'physical' && option.toolId !== undefined ? String(option.toolId + 1) : 'M';
    button.appendChild(index);

    const name = document.createElement('span');
    name.className = 'selection-filament-name';
    name.textContent = option.name;
    button.appendChild(name);

    button.addEventListener('click', () => void this.assign(option.id, option.name));
    return button;
  }

  private createInheritChip(pressed: boolean): HTMLElement {
    const document = this.container.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'selection-filament-chip selection-filament-inherit';
    button.dataset.selectionFilamentChip = 'inherit';
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.disabled = this.applying;
    button.textContent = t('ui.selectionFilamentBar.default', 'Default');
    button.title = t(
      'ui.selectionFilamentBar.removeLocalAssignment',
      'Remove the local assignment so the selection follows its object default',
    );
    button.addEventListener('click', () => void this.assign(null, button.textContent ?? ''));
    return button;
  }

  private async assign(filamentId: FilamentId | null, name: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.applying) return;
    this.applying = true;
    this.statusMessage = t('ui.selectionFilamentBar.assigning', 'Assigning…');
    this.statusIsError = false;
    this.render();
    try {
      await this.adapter.onApply({
        entities: snapshot.scopes.map((scope) => scope.entity),
        filamentId,
        sourceRevision: snapshot.sourceRevision,
        sourceHash: snapshot.sourceHash,
      });
      this.statusMessage = filamentId
        ? `${name} ${t('ui.selectionFilamentBar.assigned', 'assigned')}`
        : t('ui.selectionFilamentBar.assignmentCleared', 'Local assignment removed');
      this.statusIsError = false;
    } catch (error) {
      this.statusMessage = error instanceof Error ? error.message : String(error);
      this.statusIsError = true;
      this.adapter.onError?.(error);
    } finally {
      this.applying = false;
      this.refresh();
    }
  }
}

/** What the bar is about to change, named the way the operator selected it. */
function describeScopes(snapshot: CanonicalFilamentAssignmentSnapshot): string {
  if (snapshot.scopes.length === 1) return snapshot.scopes[0].label;
  return `${snapshot.scopes.length} ${t('ui.selectionFilamentBar.selectedScopes', 'selected')}`;
}

/**
 * The choice every selected scope already shares, or undefined when they differ
 * — a mixed selection must not show one of its filaments as though it were the
 * answer for all of them.
 */
function uniformAssignment(snapshot: CanonicalFilamentAssignmentSnapshot): FilamentId | null | undefined {
  let choice: FilamentId | null | undefined;
  for (const [index, scope] of snapshot.scopes.entries()) {
    const local = scope.localFilamentId ?? null;
    if (index === 0) choice = local;
    else if (choice !== local) return undefined;
  }
  return choice;
}
