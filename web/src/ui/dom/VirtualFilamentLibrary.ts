import {
  MATCH_RECIPE_SEARCH_COVERAGE,
  MAX_AUTHORING_PHYSICAL_TOOL_ID,
  normalizeColorMatchWeights,
  normalizeRatioTriangleBarycentricWeights,
  normalizeRatioTriangleWeights,
  projectMixedFilamentAuthoring,
  rankColorMatchCandidates,
  type MixedFilamentSerializableProjection,
  type RankedMatchRecipeCandidate,
} from '../../project/filaments/mixedFilamentAuthoring';
import { SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE } from '../../project/filaments/colorMatchSearch';
import {
  blendPairFilamentPigment,
  filamentRgbToHex,
  parseOrcaMixedColor,
} from '../../project/filaments/filamentPigmentMixer';
import { FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM } from '../../project/filaments/fullSpectrumRecipe';
import { t } from '../../l10n/t';
import {
  appendManualCycleQuickToken,
  parseManualCyclePattern,
  type ManualCyclePatternParseResult,
} from '../../project/filaments/manualCyclePattern';

type MaybePromise = void | Promise<void>;

export const VIRTUAL_FILAMENT_NAME_LIMIT = 120;
export const VIRTUAL_FILAMENT_MATCH_COVERAGE = MATCH_RECIPE_SEARCH_COVERAGE;

export type VirtualFilamentMode = 'ratio' | 'cycle' | 'match' | 'gradient';

export interface VirtualFilamentPhysicalChoice {
  readonly id: string;
  /** One-based transient tool ID understood by the pinned engine. */
  readonly toolId: number;
  readonly name: string;
  readonly material: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly compatible: boolean;
  readonly incompatibilityReason?: string;
}

export interface VirtualFilamentMatchCandidateComponent {
  readonly filamentId: string;
  readonly weight: number;
}

/**
 * A candidate preview must come from the pinned pigment model. This surface
 * ranks only these supplied candidates and never substitutes RGB averaging.
 */
export interface VirtualFilamentMatchCandidate {
  readonly id: string;
  readonly label?: string;
  readonly components: readonly VirtualFilamentMatchCandidateComponent[];
  readonly previewColor: string;
}

export interface VirtualFilamentValidatedComponent {
  readonly filamentId: string;
  readonly toolId: number;
}

export interface VirtualFilamentValidatedWeightedComponent extends VirtualFilamentValidatedComponent {
  readonly weight: number;
}

interface VirtualFilamentValidatedDraftBase {
  readonly name: string;
  readonly displayColor: string;
  readonly componentASurfaceOffsetMm: number;
  readonly componentBSurfaceOffsetMm: number;
  readonly mode: VirtualFilamentMode;
}

export interface VirtualFilamentRatioDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'ratio';
  readonly components: readonly VirtualFilamentValidatedComponent[];
  readonly mixBPercent: number;
  /** The exact user-authored proportions. The projection records normalized wire weights. */
  readonly triangleWeightsPercent?: readonly [number, number, number];
  readonly projection: MixedFilamentSerializableProjection;
}

export interface VirtualFilamentCycleDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'cycle';
  /** Exact accepted authoring text; it is not rewritten behind the user's cursor. */
  readonly manualPattern: string;
  /** Exact bracket syntax consumed by the pinned engine. */
  readonly normalizedPattern: string;
  readonly components: readonly VirtualFilamentValidatedComponent[];
  readonly groups: readonly (readonly number[])[];
  readonly sequence: readonly number[];
}

export interface VirtualFilamentMatchDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'match';
  readonly targetColor: string;
  readonly normalizedTargetColor: string;
  readonly minComponentPercent: number;
  readonly selectedCandidateId: string;
  readonly previewColor: string;
  readonly deltaE2000: number;
  readonly components: readonly VirtualFilamentValidatedWeightedComponent[];
  readonly projection: MixedFilamentSerializableProjection;
}

export interface VirtualFilamentGradientDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'gradient';
  readonly components: readonly [VirtualFilamentValidatedComponent, VirtualFilamentValidatedComponent];
  readonly direction: 'a-to-b' | 'b-to-a';
  readonly localZMaxSublayers: number;
  readonly projection: MixedFilamentSerializableProjection;
}

export type VirtualFilamentValidatedDraft =
  VirtualFilamentRatioDraft | VirtualFilamentCycleDraft | VirtualFilamentMatchDraft | VirtualFilamentGradientDraft;

export interface VirtualFilamentLibraryRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly draft: VirtualFilamentValidatedDraft;
  /** Human-readable canonical references shown before destructive deletion. */
  readonly dependencyLabels?: readonly string[];
}

/** Immutable canonical projection consumed by the DOM-only surface. */
export interface VirtualFilamentLibrarySnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly physicalChoices: readonly VirtualFilamentPhysicalChoice[];
  readonly mixedRows: readonly VirtualFilamentLibraryRow[];
  readonly matchCandidates: readonly VirtualFilamentMatchCandidate[];
}

export interface VirtualFilamentRequestGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
}

export interface VirtualFilamentMatchSearchRequest extends VirtualFilamentRequestGuard {
  readonly targetColor: string;
  readonly minComponentPercent: number;
}

export interface AddVirtualFilamentRequest extends VirtualFilamentRequestGuard {
  readonly draft: VirtualFilamentValidatedDraft;
}

export interface EditVirtualFilamentRequest extends VirtualFilamentRequestGuard {
  readonly filamentId: string;
  readonly draft: VirtualFilamentValidatedDraft;
}

export interface DuplicateVirtualFilamentRequest extends VirtualFilamentRequestGuard {
  readonly sourceFilamentId: string;
  readonly draft: VirtualFilamentValidatedDraft;
}

export interface SetVirtualFilamentEnabledRequest extends VirtualFilamentRequestGuard {
  readonly filamentId: string;
  readonly enabled: boolean;
  readonly draft: VirtualFilamentValidatedDraft;
}

export interface DeleteVirtualFilamentRequest extends VirtualFilamentRequestGuard {
  readonly filamentId: string;
  readonly draft: VirtualFilamentValidatedDraft;
}

/**
 * Canonical commands, history, stable-ID allocation, dependency policy, and
 * stale guards remain behind this adapter. A successful callback must not be
 * interpreted as permission for optimistic DOM state.
 */
export interface VirtualFilamentLibraryAdapter {
  getSnapshot(): VirtualFilamentLibrarySnapshot;
  subscribe?(listener: () => void): () => void;
  /**
   * Optional exact target-dependent search. Results are merged with persisted
   * candidates and still ranked/validated by the shared pinned projection.
   */
  searchMatchCandidates?(request: VirtualFilamentMatchSearchRequest): Promise<readonly VirtualFilamentMatchCandidate[]>;
  cancelMatchCandidateSearch?(reason?: unknown): void;
  onAdd(request: AddVirtualFilamentRequest): MaybePromise;
  onEdit(request: EditVirtualFilamentRequest): MaybePromise;
  onDuplicate(request: DuplicateVirtualFilamentRequest): MaybePromise;
  onSetEnabled(request: SetVirtualFilamentEnabledRequest): MaybePromise;
  onDelete(request: DeleteVirtualFilamentRequest): MaybePromise;
  onError?(error: unknown): void;
}

export interface VirtualFilamentLibraryOptions {
  readonly heading?: string;
  /** Test seam; production input remains deliberately debounced. */
  readonly matchSearchDebounceMs?: number;
}

type AuthorOperation = 'add' | 'edit' | 'duplicate';

interface RatioFormState {
  componentCount: 2 | 3;
  componentIds: string[];
  mixBPercent: string;
  triangleWeights: [string, string, string];
}

interface CycleFormState {
  manualPattern: string;
}

interface MatchFormState {
  targetColor: string;
  minComponentPercent: string;
  selectedCandidateId?: string;
}

interface GradientFormState {
  componentIds: [string, string];
  direction: 'a-to-b' | 'b-to-a';
  localZMaxSublayers: string;
}

interface AuthorDialogState {
  readonly kind: 'author';
  readonly operation: AuthorOperation;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly targetId?: string;
  readonly returnFocus?: HTMLElement;
  name: string;
  displayColor: string;
  componentASurfaceOffsetMm: string;
  componentBSurfaceOffsetMm: string;
  mode: VirtualFilamentMode;
  ratio: RatioFormState;
  cycle: CycleFormState;
  match: MatchFormState;
  gradient: GradientFormState;
  busy: boolean;
  operationError?: string;
}

interface DeleteDialogState {
  readonly kind: 'delete';
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly row: VirtualFilamentLibraryRow;
  readonly returnFocus?: HTMLElement;
  busy: boolean;
  operationError?: string;
}

type DialogState = AuthorDialogState | DeleteDialogState;

interface UiIssue {
  readonly message: string;
  readonly field?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

interface MatchRankView {
  readonly candidate: VirtualFilamentMatchCandidate;
  readonly ranked: RankedMatchRecipeCandidate;
}

interface MatchRanking {
  readonly normalizedTargetColor?: string;
  readonly ranked: readonly MatchRankView[];
  readonly issues: readonly UiIssue[];
}

interface MatchSearchState {
  readonly key: string;
  readonly token: number;
  readonly status: 'pending' | 'ready' | 'error';
  readonly candidates: readonly VirtualFilamentMatchCandidate[];
  readonly error?: string;
}

interface DraftValidation {
  readonly draft?: VirtualFilamentValidatedDraft;
  readonly issues: readonly UiIssue[];
  readonly preview: string;
  readonly matchRanking?: MatchRanking;
}

const TOUCH_BUTTON_STYLE =
  'box-sizing:border-box;min-width:44px;min-height:44px;border:1px solid var(--oxr-color-stroke);' +
  'border-radius:7px;background:var(--oxr-surface);color:inherit;padding:8px 11px;' +
  'font:inherit;cursor:pointer;';
const INPUT_STYLE =
  'box-sizing:border-box;min-height:44px;width:100%;border:1px solid var(--oxr-color-stroke);' +
  'border-radius:7px;background:var(--oxr-color-bg-sunken,#0006);color:inherit;padding:8px 10px;font:inherit;';
const MUTED_STYLE = 'margin:0;color:var(--oxr-color-text-muted);font-size:12px;';
const PANEL_STYLE =
  'display:grid;min-width:0;gap:10px;padding:12px;border:1px solid var(--oxr-color-stroke);' +
  'border-radius:10px;background:var(--oxr-color-bg-sunken,#0003);';
const DEFAULT_MATCH_SEARCH_DEBOUNCE_MS = 160;

let virtualFilamentLibrarySequence = 0;

/** Accessible DOM library plus guarded authoring/confirmation dialogs. */
export class VirtualFilamentLibrary {
  private readonly instanceId = ++virtualFilamentLibrarySequence;
  private root?: HTMLElement;
  private rowsHost?: HTMLElement;
  private physicalHost?: HTMLElement;
  private statusNode?: HTMLElement;
  private errorNode?: HTMLElement;
  private addButton?: HTMLButtonElement;
  private dialogOverlay?: HTMLElement;
  private dialogCard?: HTMLElement;
  private dialogFeedback?: HTMLElement;
  private dialogPreview?: HTMLElement;
  private matchCandidatesHost?: HTMLElement;
  private submitButton?: HTMLButtonElement;
  private snapshot?: VirtualFilamentLibrarySnapshot;
  private snapshotError?: string;
  private operationStatus = '';
  private operationBusy = false;
  private operationError?: string;
  private dialog?: DialogState;
  private focusAfterRefresh?: { readonly filamentId?: string; readonly action: string };
  private unsubscribe?: () => void;
  private matchSearch?: MatchSearchState;
  private matchSearchTimer?: ReturnType<typeof setTimeout>;
  private matchSearchSequence = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: VirtualFilamentLibraryAdapter,
    private readonly options: VirtualFilamentLibraryOptions = {},
  ) {}

  mount(): void {
    if (this.root) return;
    this.buildShell();
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    try {
      this.snapshot = immutableSnapshot(this.adapter.getSnapshot());
      this.snapshotError = undefined;
    } catch (error) {
      this.snapshot = undefined;
      this.snapshotError = `Virtual filament data is unavailable: ${errorMessage(error)}`;
      this.reportError(error);
    }
    this.renderLibrary();
    if (this.dialog) this.updateDialogFeedback();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.closeDialog(false);
    this.root?.remove();
    this.root = undefined;
    this.rowsHost = undefined;
    this.physicalHost = undefined;
    this.statusNode = undefined;
    this.errorNode = undefined;
    this.addButton = undefined;
    this.snapshot = undefined;
  }

  private buildShell(): void {
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.virtualFilamentLibrary = 'true';
    root.setAttribute('aria-labelledby', this.id('heading'));
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:12px;color:var(--oxr-color-text);' +
      'font:13px/1.4 system-ui,sans-serif;';

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;min-width:0;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;';
    const heading = document.createElement('h2');
    heading.id = this.id('heading');
    heading.textContent = this.options.heading ?? 'Virtual filaments';
    heading.style.cssText = 'margin:0;font-size:17px;line-height:1.3;';
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.virtualFilamentAdd = 'true';
    add.textContent = t('ui.virtualFilamentLibrary.addVirtualFilament', 'Add virtual filament');
    add.style.cssText = TOUCH_BUTTON_STYLE;
    add.addEventListener('click', () => this.openAuthorDialog('add', undefined, add));
    header.append(heading, add);
    root.appendChild(header);

    const status = document.createElement('p');
    status.dataset.virtualFilamentStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = MUTED_STYLE;
    root.appendChild(status);

    const error = document.createElement('p');
    error.dataset.virtualFilamentError = 'true';
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'assertive');
    error.hidden = true;
    error.style.cssText =
      'margin:0;padding:9px;border:1px solid var(--oxr-danger);border-radius:8px;background:var(--oxr-danger-surface);color:var(--oxr-danger);';
    root.appendChild(error);

    const physicalSection = document.createElement('section');
    physicalSection.setAttribute('aria-labelledby', this.id('physical-heading'));
    physicalSection.style.cssText = PANEL_STYLE;
    const physicalHeading = document.createElement('h3');
    physicalHeading.id = this.id('physical-heading');
    physicalHeading.textContent = t('ui.virtualFilamentLibrary.physicalComponents', 'Physical components');
    physicalHeading.style.cssText = 'margin:0;font-size:14px;';
    const physicalHelp = document.createElement('p');
    physicalHelp.textContent = t(
      'ui.virtualFilamentLibrary.recipesReferenceTheseStablePhysical',
      'Recipes reference these stable physical heads. Disabled or incompatible heads remain visible but cannot be newly selected.',
    );
    physicalHelp.style.cssText = MUTED_STYLE;
    const physicalHost = document.createElement('ul');
    physicalHost.dataset.virtualPhysicalChoices = 'true';
    physicalHost.style.cssText = 'display:grid;gap:7px;margin:0;padding:0;list-style:none;';
    physicalSection.append(physicalHeading, physicalHelp, physicalHost);
    root.appendChild(physicalSection);

    const mixedSection = document.createElement('section');
    mixedSection.setAttribute('aria-labelledby', this.id('mixed-heading'));
    mixedSection.style.cssText = PANEL_STYLE;
    const mixedHeading = document.createElement('h3');
    mixedHeading.id = this.id('mixed-heading');
    mixedHeading.textContent = t('ui.virtualFilamentLibrary.virtualLibrary', 'Virtual library');
    mixedHeading.style.cssText = 'margin:0;font-size:14px;';
    const rows = document.createElement('ul');
    rows.dataset.virtualFilamentRows = 'true';
    rows.style.cssText = 'display:grid;gap:9px;margin:0;padding:0;list-style:none;';
    mixedSection.append(mixedHeading, rows);
    root.appendChild(mixedSection);

    this.container.replaceChildren(root);
    this.root = root;
    this.statusNode = status;
    this.errorNode = error;
    this.physicalHost = physicalHost;
    this.rowsHost = rows;
    this.addButton = add;
  }

  private renderLibrary(): void {
    const snapshot = this.snapshot;
    const physicalHost = this.physicalHost;
    const rowsHost = this.rowsHost;
    if (!physicalHost || !rowsHost || !this.statusNode || !this.errorNode || !this.addButton) return;

    const visibleError = this.snapshotError ?? this.operationError;
    this.errorNode.hidden = !visibleError;
    this.errorNode.textContent = visibleError ?? '';

    physicalHost.replaceChildren();
    rowsHost.replaceChildren();
    if (!snapshot) {
      this.statusNode.textContent = this.operationStatus || 'No valid virtual filament snapshot is available.';
      this.addButton.disabled = true;
      return;
    }

    const selectable = selectablePhysical(snapshot);
    this.addButton.disabled = selectable.length < 2 || this.operationBusy;
    this.addButton.title =
      selectable.length < 2 ? 'At least two enabled compatible physical components are required' : '';

    for (const physical of snapshot.physicalChoices) physicalHost.appendChild(this.createPhysicalRow(physical));
    if (snapshot.physicalChoices.length === 0) {
      physicalHost.appendChild(this.emptyListItem('No physical heads are available.'));
    }

    for (const row of snapshot.mixedRows) rowsHost.appendChild(this.createMixedRow(row, snapshot));
    if (snapshot.mixedRows.length === 0) {
      rowsHost.appendChild(this.emptyListItem('No virtual filaments have been authored.'));
    }

    this.statusNode.textContent =
      this.operationStatus ||
      `${snapshot.mixedRows.length} virtual ${snapshot.mixedRows.length === 1 ? 'filament' : 'filaments'}; ` +
        `${selectable.length} of ${snapshot.physicalChoices.length} physical heads selectable.`;
    this.restorePostMutationFocus();
  }

  private createPhysicalRow(choice: VirtualFilamentPhysicalChoice): HTMLLIElement {
    const document = this.container.ownerDocument;
    const row = document.createElement('li');
    row.dataset.virtualPhysicalId = choice.id;
    row.dataset.toolId = String(choice.toolId);
    row.style.cssText =
      'display:flex;min-width:0;align-items:center;gap:10px;padding:8px;border:1px solid ' +
      'var(--oxr-color-stroke,var(--oxr-stroke-strong));border-radius:8px;';
    row.appendChild(colorSwatch(document, choice.color, `${choice.name} color ${choice.color}`));
    const copy = document.createElement('span');
    copy.style.cssText = 'min-width:0;overflow-wrap:anywhere;';
    const name = document.createElement('strong');
    name.textContent = `H${choice.toolId} · ${choice.name}`;
    const details = document.createElement('span');
    details.style.cssText = `display:block;${MUTED_STYLE}`;
    const state = choice.enabled ? (choice.compatible ? 'Available' : 'Incompatible') : 'Disabled';
    details.textContent = `${choice.material} · ${choice.color} · ${state}${
      choice.incompatibilityReason ? `: ${choice.incompatibilityReason}` : ''
    }`;
    copy.append(name, details);
    row.appendChild(copy);
    return row;
  }

  private createMixedRow(row: VirtualFilamentLibraryRow, snapshot: VirtualFilamentLibrarySnapshot): HTMLLIElement {
    const document = this.container.ownerDocument;
    const item = document.createElement('li');
    item.dataset.virtualFilamentRow = row.id;
    item.dataset.enabled = String(row.enabled);
    item.style.cssText =
      'display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:9px;padding:10px;border:1px solid ' +
      'var(--oxr-color-stroke,var(--oxr-stroke-strong));border-radius:9px;background:var(--oxr-surface);';

    item.appendChild(
      colorSwatch(document, row.draft.displayColor, `${row.draft.name} badge ${row.draft.displayColor}`),
    );
    const copy = document.createElement('span');
    copy.style.cssText = 'min-width:150px;flex:1 1 180px;overflow-wrap:anywhere;';
    const name = document.createElement('strong');
    name.textContent = row.draft.name;
    const details = document.createElement('span');
    details.style.cssText = `display:block;${MUTED_STYLE}`;
    details.textContent = `${modeLabel(row.draft.mode)} · ${row.enabled ? 'Enabled' : 'Disabled'} · ${row.draft.displayColor}`;
    const recipe = document.createElement('span');
    recipe.style.cssText = `display:block;${MUTED_STYLE}`;
    recipe.textContent = draftSummary(row.draft, snapshot);
    copy.append(name, details, recipe);
    item.appendChild(copy);

    const controls = document.createElement('div');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', `Actions for ${row.draft.name}`);
    controls.style.cssText = 'display:flex;flex:1 1 320px;flex-wrap:wrap;justify-content:flex-end;gap:6px;';
    controls.append(
      this.rowButton(row, 'edit', 'Edit', (button) => this.openAuthorDialog('edit', row, button)),
      this.rowButton(row, 'duplicate', 'Duplicate', (button) => this.openAuthorDialog('duplicate', row, button)),
      this.rowButton(row, 'enabled', row.enabled ? 'Disable' : 'Enable', () => void this.setEnabled(row, !row.enabled)),
      this.rowButton(row, 'delete', 'Delete', (button) => this.openDeleteDialog(row, button)),
    );
    item.appendChild(controls);
    return item;
  }

  private rowButton(
    row: VirtualFilamentLibraryRow,
    action: string,
    label: string,
    run: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.virtualFilamentAction = action;
    button.dataset.filamentId = row.id;
    button.textContent = label;
    button.style.cssText = TOUCH_BUTTON_STYLE;
    button.disabled = this.operationBusy;
    button.addEventListener('click', () => run(button));
    return button;
  }

  private openAuthorDialog(
    operation: AuthorOperation,
    row: VirtualFilamentLibraryRow | undefined,
    returnFocus: HTMLElement,
  ): void {
    const snapshot = this.snapshot;
    if (!snapshot || this.dialog) return;
    const defaults = defaultAuthorState(snapshot);
    const source = row?.draft;
    if (source) loadDraft(defaults, source);
    if (operation === 'duplicate' && source) defaults.name = duplicateName(source.name);
    this.dialog = {
      kind: 'author',
      operation,
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
      ...(row ? { targetId: row.id } : {}),
      returnFocus,
      name: defaults.name,
      displayColor: defaults.displayColor,
      componentASurfaceOffsetMm: defaults.componentASurfaceOffsetMm,
      componentBSurfaceOffsetMm: defaults.componentBSurfaceOffsetMm,
      mode: defaults.mode,
      ratio: defaults.ratio,
      cycle: defaults.cycle,
      match: defaults.match,
      gradient: defaults.gradient,
      busy: false,
    };
    this.renderDialog();
  }

  private openDeleteDialog(row: VirtualFilamentLibraryRow, returnFocus: HTMLElement): void {
    const snapshot = this.snapshot;
    if (!snapshot || this.dialog) return;
    this.dialog = {
      kind: 'delete',
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
      row,
      returnFocus,
      busy: false,
    };
    this.renderDialog();
  }

  private renderDialog(): void {
    this.removeDialogNodes();
    const state = this.dialog;
    if (!state) return;
    const document = this.container.ownerDocument;
    const overlay = document.createElement('div');
    overlay.dataset.virtualFilamentDialogOverlay = 'true';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:120;display:grid;place-items:center;padding:16px;background:#000b;';
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && !state.busy) this.closeDialog();
    });
    overlay.addEventListener('keydown', (event) => this.handleDialogKeydown(event));

    const card = document.createElement(state.kind === 'author' ? 'form' : 'section');
    card.dataset.virtualFilamentDialog = state.kind;
    card.setAttribute('role', state.kind === 'delete' ? 'alertdialog' : 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', this.id('dialog-heading'));
    card.setAttribute('aria-describedby', this.id('dialog-description'));
    card.style.cssText =
      'box-sizing:border-box;display:flex;width:min(760px,96vw);max-height:min(880px,94vh);min-width:0;' +
      'flex-direction:column;gap:12px;overflow:auto;padding:18px;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:12px;background:var(--oxr-color-bg-card,var(--oxr-bg-elevated));color:var(--oxr-color-text);' +
      'font:13px/1.4 system-ui,sans-serif;box-shadow:0 24px 80px #0009;';
    if (card.tagName === 'FORM') {
      (card as HTMLFormElement).noValidate = true;
      card.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.submitAuthorDialog();
      });
    }
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.dialogOverlay = overlay;
    this.dialogCard = card;

    if (state.kind === 'delete') this.renderDeleteDialog(card, state);
    else this.renderAuthorDialog(card, state);
  }

  private renderDeleteDialog(card: HTMLElement, state: DeleteDialogState): void {
    const document = card.ownerDocument;
    const heading = document.createElement('h2');
    heading.id = this.id('dialog-heading');
    heading.textContent = `Delete ${state.row.draft.name}?`;
    heading.style.cssText = 'margin:0;font-size:18px;';
    const description = document.createElement('p');
    description.id = this.id('dialog-description');
    description.textContent = t(
      'ui.virtualFilamentLibrary.deletionIsSentAsOne',
      'Deletion is sent as one guarded canonical request. This dialog does not remove or remap anything itself.',
    );
    description.style.cssText = MUTED_STYLE;
    card.append(heading, description);

    const impact = document.createElement('div');
    impact.style.cssText = PANEL_STYLE;
    const impactHeading = document.createElement('strong');
    impactHeading.textContent =
      state.row.dependencyLabels && state.row.dependencyLabels.length > 0
        ? 'Canonical dependency review'
        : 'No dependencies were reported in this snapshot';
    impact.appendChild(impactHeading);
    if (state.row.dependencyLabels && state.row.dependencyLabels.length > 0) {
      const list = document.createElement('ul');
      list.dataset.virtualDeleteDependencies = 'true';
      for (const dependency of state.row.dependencyLabels) {
        const item = document.createElement('li');
        item.textContent = dependency;
        list.appendChild(item);
      }
      impact.appendChild(list);
    }
    card.appendChild(impact);

    const feedback = this.createDialogFeedback(state.operationError);
    card.appendChild(feedback);
    this.dialogFeedback = feedback;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;';
    const cancel = this.dialogButton('delete-cancel', 'Cancel', () => this.closeDialog(), false);
    const confirm = this.dialogButton(
      'delete-confirm',
      'Delete virtual filament',
      () => void this.confirmDelete(),
      true,
    );
    cancel.disabled = state.busy;
    confirm.disabled = state.busy || this.dialogIsStale(state);
    actions.append(cancel, confirm);
    card.appendChild(actions);
    this.submitButton = confirm;
    card.setAttribute('aria-busy', String(state.busy));
    queueMicrotask(() => cancel.focus());
  }

  private renderAuthorDialog(card: HTMLElement, state: AuthorDialogState): void {
    const document = card.ownerDocument;
    const heading = document.createElement('h2');
    heading.id = this.id('dialog-heading');
    heading.textContent =
      state.operation === 'add'
        ? 'Add virtual filament'
        : state.operation === 'edit'
          ? `Edit ${state.name}`
          : `Duplicate ${state.name}`;
    heading.style.cssText = 'margin:0;font-size:18px;';
    const description = document.createElement('p');
    description.id = this.id('dialog-description');
    description.textContent = t(
      'ui.virtualFilamentLibrary.choosePhysicalHeadsAndAuthor',
      'Choose physical heads and author one pinned FullSpectrum mode. Apply is available only for a complete validated recipe.',
    );
    description.style.cssText = MUTED_STYLE;
    card.append(heading, description);

    const common = document.createElement('div');
    common.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;';
    common.append(
      this.textField('name', 'Name', state.name, VIRTUAL_FILAMENT_NAME_LIMIT, (value) => {
        state.name = value;
      }),
      this.colorField(state),
      this.numberField(
        'component-a-surface-offset',
        'Component A surface offset (mm)',
        state.componentASurfaceOffsetMm,
        String(-FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM),
        String(FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM),
        '0.01',
        (value) => {
          state.componentASurfaceOffsetMm = value;
        },
      ),
      this.numberField(
        'component-b-surface-offset',
        'Component B surface offset (mm)',
        state.componentBSurfaceOffsetMm,
        String(-FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM),
        String(FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM),
        '0.01',
        (value) => {
          state.componentBSurfaceOffsetMm = value;
        },
      ),
    );
    card.appendChild(common);

    const modeFieldset = document.createElement('fieldset');
    modeFieldset.dataset.virtualModeChoices = 'true';
    modeFieldset.style.cssText =
      'display:flex;flex-wrap:wrap;gap:7px;margin:0;padding:9px;border:1px solid ' +
      'var(--oxr-color-stroke,var(--oxr-stroke-strong));border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = t('ui.virtualFilamentLibrary.authoringMode', 'Authoring mode');
    legend.style.cssText = 'padding:0 4px;font-weight:700;';
    modeFieldset.appendChild(legend);
    for (const mode of ['ratio', 'cycle', 'match', 'gradient'] as const) {
      const label = document.createElement('label');
      label.style.cssText =
        'box-sizing:border-box;display:flex;min-height:44px;align-items:center;gap:7px;padding:7px 10px;' +
        'border:1px solid var(--oxr-color-stroke);border-radius:7px;cursor:pointer;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = this.id('mode');
      radio.value = mode;
      radio.dataset.virtualMode = mode;
      radio.checked = state.mode === mode;
      radio.disabled = state.busy;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        if (state.mode === 'match' && mode !== 'match') {
          this.cancelMatchSearch('Match authoring mode changed');
        }
        state.mode = mode;
        this.renderDialog();
      });
      label.append(radio, modeLabel(mode));
      modeFieldset.appendChild(label);
    }
    card.appendChild(modeFieldset);

    const modePanel = document.createElement('section');
    modePanel.dataset.virtualModePanel = state.mode;
    modePanel.setAttribute('aria-label', `${modeLabel(state.mode)} authoring`);
    modePanel.style.cssText = PANEL_STYLE;
    if (state.mode === 'ratio') this.renderRatioMode(modePanel, state);
    else if (state.mode === 'cycle') this.renderCycleMode(modePanel, state);
    else if (state.mode === 'match') this.renderMatchMode(modePanel, state);
    else this.renderGradientMode(modePanel, state);
    card.appendChild(modePanel);

    const feedback = this.createDialogFeedback(state.operationError);
    card.appendChild(feedback);
    this.dialogFeedback = feedback;
    const preview = document.createElement('p');
    preview.dataset.virtualDraftPreview = 'true';
    preview.setAttribute('role', 'status');
    preview.setAttribute('aria-live', 'polite');
    preview.style.cssText = `${MUTED_STYLE}box-sizing:border-box;min-height:44px;padding:7px 9px;border-inline-start:12px solid transparent;`;
    card.appendChild(preview);
    this.dialogPreview = preview;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;';
    const cancel = this.dialogButton('author-cancel', 'Cancel', () => this.closeDialog(), false);
    const submit = this.dialogButton(
      'author-submit',
      state.operation === 'add' ? 'Add' : state.operation === 'edit' ? 'Apply changes' : 'Create duplicate',
      () => undefined,
      true,
    );
    submit.type = 'submit';
    cancel.disabled = state.busy;
    actions.append(cancel, submit);
    card.appendChild(actions);
    this.submitButton = submit;
    card.setAttribute('aria-busy', String(state.busy));
    this.updateDialogFeedback();
    queueMicrotask(() => card.querySelector<HTMLInputElement>('[data-virtual-field="name"]')?.focus());
  }

  private renderRatioMode(panel: HTMLElement, state: AuthorDialogState): void {
    const document = panel.ownerDocument;
    const countFieldset = document.createElement('fieldset');
    countFieldset.style.cssText =
      'display:flex;flex-wrap:wrap;gap:7px;margin:0;padding:8px;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Components';
    countFieldset.appendChild(legend);
    for (const count of [2, 3] as const) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;min-height:44px;align-items:center;gap:7px;padding:0 8px;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = this.id('ratio-count');
      radio.value = String(count);
      radio.dataset.virtualRatioCount = String(count);
      radio.checked = state.ratio.componentCount === count;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.ratio.componentCount = count;
        this.renderDialog();
      });
      label.append(radio, `${count} physical heads`);
      countFieldset.appendChild(label);
    }
    panel.appendChild(countFieldset);
    const components = document.createElement('div');
    components.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px;';
    for (let index = 0; index < state.ratio.componentCount; index += 1) {
      components.appendChild(
        this.componentSelect(
          `ratio-component-${index}`,
          `Component ${String.fromCharCode(65 + index)}`,
          state.ratio.componentIds[index],
          (value) => {
            state.ratio.componentIds[index] = value;
          },
        ),
      );
    }
    panel.appendChild(components);

    const ratio = document.createElement('div');
    ratio.style.cssText =
      'display:grid;grid-template-columns:minmax(180px,1fr) minmax(100px,160px);gap:9px;align-items:end;';
    const sliderLabel = document.createElement('label');
    sliderLabel.textContent = t('ui.virtualFilamentLibrary.componentBPercent', 'Component B percent');
    sliderLabel.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = validRangeValue(state.ratio.mixBPercent, 0, 100, 50);
    slider.dataset.virtualField = 'ratio-slider';
    slider.style.cssText = 'box-sizing:border-box;min-height:44px;width:100%;';
    const number = this.numberInput('ratio-mix-b', state.ratio.mixBPercent, '0', '100', '1', (value) => {
      state.ratio.mixBPercent = value;
      slider.value = validRangeValue(value, 0, 100, Number(slider.value));
    });
    slider.addEventListener('input', () => {
      state.ratio.mixBPercent = slider.value;
      number.value = slider.value;
      this.updateDialogFeedback();
    });
    sliderLabel.appendChild(slider);
    const numericLabel = document.createElement('label');
    numericLabel.textContent = t('ui.virtualFilamentLibrary.exactPercent', 'Exact percent');
    numericLabel.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    numericLabel.appendChild(number);
    ratio.append(sliderLabel, numericLabel);
    panel.appendChild(ratio);

    if (state.ratio.componentCount === 3) {
      const weights = document.createElement('fieldset');
      weights.style.cssText =
        'display:grid;grid-template-columns:repeat(3,minmax(90px,1fr));gap:8px;margin:0;padding:9px;border:1px solid ' +
        'var(--oxr-color-stroke,var(--oxr-stroke-strong));border-radius:8px;';
      const weightsLegend = document.createElement('legend');
      weightsLegend.textContent = t('ui.virtualFilamentLibrary.triangleProportions', 'Triangle proportions');
      weights.appendChild(weightsLegend);
      const weightInputs: HTMLInputElement[] = [];
      state.ratio.triangleWeights.forEach((value, index) => {
        const label = document.createElement('label');
        label.textContent = `Weight ${String.fromCharCode(65 + index)}`;
        label.style.cssText = 'display:grid;gap:5px;font-weight:650;';
        const input = this.numberInput(`ratio-weight-${index}`, value, '0', undefined, '0.1', (next) => {
          state.ratio.triangleWeights[index] = next;
        });
        weightInputs.push(input);
        label.appendChild(input);
        weights.appendChild(label);
      });
      weights.appendChild(this.ratioTrianglePicker(state, weightInputs));
      panel.appendChild(weights);
      const note = document.createElement('p');
      note.textContent = t(
        'ui.virtualFilamentLibrary.theseAreTriangleCoordinatesThe',
        'These are triangle coordinates. The preview below reports the exact clamped, renormalized integer weights that will be submitted.',
      );
      note.style.cssText = MUTED_STYLE;
      panel.appendChild(note);
    }

    const predicted = document.createElement('div');
    predicted.dataset.virtualRatioPigmentPreview = 'true';
    predicted.setAttribute('role', 'img');
    predicted.style.cssText =
      'box-sizing:border-box;display:grid;min-height:58px;place-items:center;padding:9px;border:2px solid var(--oxr-stroke-strong);' +
      'border-radius:9px;background:#555;color:var(--oxr-text);text-align:center;text-shadow:0 1px 3px #000,0 0 2px #000;';
    panel.appendChild(predicted);
    this.updateRatioPigmentPreview(state, predicted);
  }

  private ratioTrianglePicker(state: AuthorDialogState, weightInputs: readonly HTMLInputElement[]): SVGSVGElement {
    const document = this.container.ownerDocument;
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.dataset.virtualRatioTriangle = 'true';
    svg.setAttribute('viewBox', '0 0 240 216');
    svg.setAttribute('role', 'slider');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute(
      'aria-label',
      t(
        'ui.virtualFilamentLibrary.threeFilamentRatioTriangleUse',
        'Three-filament Ratio triangle. Use arrow keys or drag the marker.',
      ),
    );
    svg.setAttribute('aria-valuemin', '0');
    svg.setAttribute('aria-valuemax', '100');
    svg.style.cssText =
      'grid-column:1/-1;box-sizing:border-box;width:min(100%,360px);min-height:216px;justify-self:center;' +
      'touch-action:none;border:1px solid var(--oxr-color-stroke);border-radius:9px;background:var(--oxr-bg-sunken);';

    const vertices = [
      { x: 120, y: 18, label: 'A' },
      { x: 18, y: 198, label: 'B' },
      { x: 222, y: 198, label: 'C' },
    ] as const;
    const polygon = document.createElementNS(namespace, 'polygon');
    polygon.setAttribute('points', vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' '));
    // Paint through `style`, not through the presentation attribute: a
    // presentation attribute is not CSS and does not resolve `var()`, so a
    // token written there renders as the default black.
    polygon.style.fill = 'var(--oxr-bg-card)';
    polygon.style.stroke = 'var(--oxr-stroke-strong)';
    polygon.setAttribute('stroke-width', '2');
    svg.appendChild(polygon);

    const byId = new Map((this.snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
    vertices.forEach((vertex, index) => {
      const physical = byId.get(state.ratio.componentIds[index]);
      const dot = document.createElementNS(namespace, 'circle');
      dot.setAttribute('cx', String(vertex.x));
      dot.setAttribute('cy', String(vertex.y));
      dot.setAttribute('r', '10');
      // The dot is a filament's own colour and stays a literal; the ring
      // around it is chrome and follows the theme.
      dot.setAttribute('fill', physical?.color ?? '#777777');
      dot.style.stroke = 'var(--oxr-bg-card)';
      dot.setAttribute('stroke-width', '2');
      const label = document.createElementNS(namespace, 'text');
      label.setAttribute('x', String(vertex.x + (index === 1 ? -16 : index === 2 ? 16 : 0)));
      label.setAttribute('y', String(vertex.y + (index === 0 ? -5 : 5)));
      label.setAttribute('text-anchor', 'middle');
      label.style.fill = 'var(--oxr-text)';
      label.setAttribute('font-size', '14');
      label.setAttribute('font-weight', '700');
      label.textContent = `${vertex.label} · H${physical?.toolId ?? '?'}`;
      svg.append(dot, label);
    });

    const marker = document.createElementNS(namespace, 'circle');
    marker.dataset.virtualRatioTriangleMarker = 'true';
    marker.setAttribute('r', '8');
    marker.style.fill = 'var(--oxr-warn)';
    marker.style.stroke = 'var(--oxr-text)';
    marker.setAttribute('stroke-width', '3');
    svg.appendChild(marker);

    const currentWeights = (): [number, number, number] => {
      const parsed = state.ratio.triangleWeights.map((value) => Number(value));
      return normalizeTriangleVisualWeights(parsed);
    };
    const markerPoint = (): { x: number; y: number } => {
      const [a, b, c] = currentWeights();
      return {
        x: (a * vertices[0].x + b * vertices[1].x + c * vertices[2].x) / 100,
        y: (a * vertices[0].y + b * vertices[1].y + c * vertices[2].y) / 100,
      };
    };
    const updateMarker = (): void => {
      const weights = currentWeights();
      const point = markerPoint();
      marker.setAttribute('cx', point.x.toFixed(3));
      marker.setAttribute('cy', point.y.toFixed(3));
      svg.setAttribute('aria-valuenow', weights[0].toFixed(1));
      svg.setAttribute(
        'aria-valuetext',
        `A ${weights[0].toFixed(1)}%, B ${weights[1].toFixed(1)}%, C ${weights[2].toFixed(1)}%`,
      );
    };
    const applyPoint = (x: number, y: number): void => {
      const weights = triangleWeightsAtPoint(x, y, vertices);
      weights.forEach((weight, index) => {
        const text = String(Number(weight.toFixed(2)));
        state.ratio.triangleWeights[index] = text;
        if (weightInputs[index]) weightInputs[index].value = text;
      });
      updateMarker();
      this.updateDialogFeedback();
    };
    const applyPointer = (event: PointerEvent): void => {
      const bounds = svg.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      applyPoint(
        ((event.clientX - bounds.left) / bounds.width) * 240,
        ((event.clientY - bounds.top) / bounds.height) * 216,
      );
    };
    let pointerId: number | undefined;
    svg.addEventListener('pointerdown', (event) => {
      pointerId = event.pointerId;
      svg.setPointerCapture?.(event.pointerId);
      applyPointer(event);
    });
    svg.addEventListener('pointermove', (event) => {
      if (pointerId === event.pointerId) applyPointer(event);
    });
    const release = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) return;
      svg.releasePointerCapture?.(event.pointerId);
      pointerId = undefined;
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    svg.addEventListener('keydown', (event) => {
      const delta =
        event.key === 'ArrowLeft'
          ? { x: -5, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: 5, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: -5 }
              : event.key === 'ArrowDown'
                ? { x: 0, y: 5 }
                : undefined;
      if (!delta) return;
      event.preventDefault();
      const point = markerPoint();
      applyPoint(point.x + delta.x, point.y + delta.y);
    });
    weightInputs.forEach((input) => input.addEventListener('input', updateMarker));
    updateMarker();
    return svg;
  }

  private renderCycleMode(panel: HTMLElement, state: AuthorDialogState): void {
    const document = panel.ownerDocument;
    const label = document.createElement('label');
    label.htmlFor = this.id('cycle-pattern');
    label.textContent = t('ui.virtualFilamentLibrary.manualCyclePattern', 'Manual cycle pattern');
    label.style.cssText = 'font-weight:700;';
    const input = document.createElement('textarea');
    input.id = label.htmlFor;
    input.dataset.virtualField = 'cycle-pattern';
    input.value = state.cycle.manualPattern;
    input.rows = 3;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-describedby', this.id('cycle-help'));
    input.style.cssText = `${INPUT_STYLE}resize:vertical;font-family:ui-monospace,SFMono-Regular,monospace;`;
    input.addEventListener('input', () => {
      state.cycle.manualPattern = input.value;
      this.updateDialogFeedback();
    });
    const help = document.createElement('p');
    help.id = this.id('cycle-help');
    help.textContent = t(
      'ui.virtualFilamentLibrary.useCompact19IDs',
      'Use compact 1–9 IDs, [N] for multi-digit IDs, or slash-delimited authoring; commas start a new perimeter group.',
    );
    help.style.cssText = MUTED_STYLE;
    panel.append(label, input, help);

    const quick = document.createElement('div');
    quick.setAttribute('role', 'group');
    quick.setAttribute(
      'aria-label',
      t('ui.virtualFilamentLibrary.insertPhysicalFilamentToken', 'Insert physical filament token'),
    );
    quick.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const choice of this.snapshot?.physicalChoices ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.virtualQuickTool = String(choice.toolId);
      button.textContent = `Insert H${choice.toolId}`;
      button.title = `${choice.name} · ${choice.color}`;
      button.style.cssText = TOUCH_BUTTON_STYLE;
      button.disabled = !choice.enabled || !choice.compatible || state.busy;
      button.addEventListener('click', () => {
        state.cycle.manualPattern = appendManualCycleQuickToken(state.cycle.manualPattern, choice.toolId);
        input.value = state.cycle.manualPattern;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        this.updateDialogFeedback();
      });
      quick.appendChild(button);
    }
    const comma = document.createElement('button');
    comma.type = 'button';
    comma.dataset.virtualQuickGroup = 'true';
    comma.textContent = t('ui.virtualFilamentLibrary.newPerimeterGroup', 'New perimeter group');
    comma.style.cssText = TOUCH_BUTTON_STYLE;
    comma.addEventListener('click', () => {
      state.cycle.manualPattern += ',';
      input.value = state.cycle.manualPattern;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      this.updateDialogFeedback();
    });
    quick.appendChild(comma);
    panel.appendChild(quick);
  }

  private renderMatchMode(panel: HTMLElement, state: AuthorDialogState): void {
    const document = panel.ownerDocument;
    const coverage = document.createElement('p');
    const hasExactSearch = this.adapter.searchMatchCandidates !== undefined;
    coverage.dataset.virtualMatchCoverage = hasExactSearch
      ? SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE
      : VIRTUAL_FILAMENT_MATCH_COVERAGE;
    coverage.textContent = hasExactSearch
      ? 'Coverage: pinned bounded pair/triple search over the currently supplied, material-compatible physical palette.'
      : 'Coverage: supplied pigment-rendered candidates only. This is not a complete material-compatible gamut search.';
    coverage.style.cssText =
      'margin:0;padding:8px;border:1px solid var(--oxr-warn);border-radius:var(--oxr-radius-md);' +
      'background:var(--oxr-warn-surface);color:var(--oxr-text);';
    panel.appendChild(coverage);

    const fields = document.createElement('div');
    fields.style.cssText = 'display:grid;grid-template-columns:minmax(180px,1fr) minmax(130px,180px);gap:9px;';
    const targetLabel = document.createElement('label');
    targetLabel.textContent = t('ui.virtualFilamentLibrary.targetHexColor', 'Target hex color');
    targetLabel.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    const target = document.createElement('input');
    target.type = 'text';
    target.inputMode = 'text';
    target.value = state.match.targetColor;
    target.maxLength = 7;
    target.placeholder = t('ui.virtualFilamentLibrary.rRGGBB', '#RRGGBB');
    target.dataset.virtualField = 'match-target';
    target.style.cssText = INPUT_STYLE;
    target.addEventListener('input', () => {
      state.match.targetColor = target.value;
      state.match.selectedCandidateId = undefined;
      this.cancelMatchSearch('Match target changed');
      this.updateDialogFeedback();
    });
    targetLabel.appendChild(target);
    const minimumLabel = document.createElement('label');
    minimumLabel.textContent = t('ui.virtualFilamentLibrary.minimumComponent', 'Minimum component %');
    minimumLabel.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    minimumLabel.appendChild(
      this.numberInput('match-minimum', state.match.minComponentPercent, '0', '50', '1', (value) => {
        state.match.minComponentPercent = value;
        state.match.selectedCandidateId = undefined;
        this.cancelMatchSearch('Match minimum changed');
      }),
    );
    fields.append(targetLabel, minimumLabel);
    panel.appendChild(fields);

    const candidates = document.createElement('fieldset');
    candidates.dataset.virtualMatchCandidates = 'true';
    candidates.style.cssText =
      'display:grid;gap:7px;margin:0;padding:9px;border:1px solid var(--oxr-color-stroke);border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = t('ui.virtualFilamentLibrary.rankedSuppliedCandidates', 'Ranked supplied candidates');
    candidates.appendChild(legend);
    panel.appendChild(candidates);
    this.matchCandidatesHost = candidates;
  }

  private renderGradientMode(panel: HTMLElement, state: AuthorDialogState): void {
    const document = panel.ownerDocument;
    const components = document.createElement('div');
    components.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(190px,1fr));gap:9px;';
    components.append(
      this.componentSelect('gradient-component-0', 'Component A', state.gradient.componentIds[0], (value) => {
        state.gradient.componentIds[0] = value;
      }),
      this.componentSelect('gradient-component-1', 'Component B', state.gradient.componentIds[1], (value) => {
        state.gradient.componentIds[1] = value;
      }),
    );
    panel.appendChild(components);

    const direction = document.createElement('fieldset');
    direction.style.cssText =
      'display:flex;flex-wrap:wrap;gap:7px;margin:0;padding:8px;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Direction';
    direction.appendChild(legend);
    for (const entry of [
      { id: 'a-to-b', label: 'A→B · A is 80% at the start and 20% at the end' },
      { id: 'b-to-a', label: 'B→A · A is 20% at the start and 80% at the end' },
    ] as const) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;min-height:44px;flex:1 1 260px;align-items:center;gap:7px;padding:0 8px;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = this.id('gradient-direction');
      radio.value = entry.id;
      radio.dataset.virtualGradientDirection = entry.id;
      radio.checked = state.gradient.direction === entry.id;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.gradient.direction = entry.id;
        this.updateDialogFeedback();
      });
      label.append(radio, entry.label);
      direction.appendChild(label);
    }
    panel.appendChild(direction);

    const sublayersLabel = document.createElement('label');
    sublayersLabel.textContent = t(
      'ui.virtualFilamentLibrary.localZSublayersPerNominal',
      'Local-Z sublayers per nominal layer',
    );
    sublayersLabel.style.cssText = 'display:grid;max-width:260px;gap:5px;font-weight:650;';
    sublayersLabel.appendChild(
      this.numberInput('gradient-sublayers', state.gradient.localZMaxSublayers, '2', undefined, '1', (value) => {
        state.gradient.localZMaxSublayers = value;
      }),
    );
    panel.appendChild(sublayersLabel);

    const visual = document.createElement('div');
    visual.dataset.virtualGradientPreview = 'true';
    visual.setAttribute('role', 'img');
    visual.style.cssText =
      'box-sizing:border-box;display:grid;min-height:96px;place-items:center;border:2px solid var(--oxr-stroke-strong);border-radius:9px;' +
      'padding:9px;color:var(--oxr-text);text-align:center;text-shadow:0 1px 3px #000,0 0 2px #000;background:#555;';
    panel.appendChild(visual);
    this.updateGradientVisual(state, visual);
  }

  private colorField(state: AuthorDialogState): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:grid;grid-template-columns:1fr 52px;gap:6px;align-items:end;';
    const textLabel = document.createElement('label');
    textLabel.textContent = t('ui.virtualFilamentLibrary.displayBadgeColor', 'Display badge color');
    textLabel.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    const text = document.createElement('input');
    text.type = 'text';
    text.value = state.displayColor;
    text.maxLength = 7;
    text.placeholder = t('ui.virtualFilamentLibrary.rRGGBB2', '#RRGGBB');
    text.dataset.virtualField = 'display-color';
    text.style.cssText = INPUT_STYLE;
    const pickerLabel = document.createElement('label');
    pickerLabel.textContent = 'Picker';
    pickerLabel.style.cssText = 'display:grid;gap:5px;font-size:11px;';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = /^#[0-9a-f]{6}$/i.test(state.displayColor) ? state.displayColor : '#808080';
    picker.dataset.virtualField = 'display-color-picker';
    picker.setAttribute(
      'aria-label',
      t('ui.virtualFilamentLibrary.chooseDisplayBadgeColor', 'Choose display badge color'),
    );
    picker.style.cssText = 'box-sizing:border-box;width:52px;min-height:44px;padding:3px;';
    text.addEventListener('input', () => {
      state.displayColor = text.value;
      if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
      this.updateDialogFeedback();
    });
    picker.addEventListener('input', () => {
      state.displayColor = picker.value.toUpperCase();
      text.value = state.displayColor;
      this.updateDialogFeedback();
    });
    textLabel.appendChild(text);
    pickerLabel.appendChild(picker);
    wrapper.append(textLabel, pickerLabel);
    return wrapper;
  }

  private textField(
    field: string,
    labelText: string,
    value: string,
    maxLength: number,
    update: (value: string) => void,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const label = document.createElement('label');
    label.textContent = labelText;
    label.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = maxLength + 1;
    input.dataset.virtualField = field;
    input.style.cssText = INPUT_STYLE;
    input.addEventListener('input', () => {
      update(input.value);
      this.updateDialogFeedback();
    });
    label.appendChild(input);
    return label;
  }

  private numberInput(
    field: string,
    value: string,
    min: string | undefined,
    max: string | undefined,
    step: string,
    update: (value: string) => void,
  ): HTMLInputElement {
    const input = this.container.ownerDocument.createElement('input');
    input.type = 'number';
    input.value = value;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.step = step;
    input.dataset.virtualField = field;
    input.style.cssText = INPUT_STYLE;
    input.addEventListener('input', () => {
      update(input.value);
      this.updateDialogFeedback();
    });
    return input;
  }

  private numberField(
    field: string,
    labelText: string,
    value: string,
    min: string | undefined,
    max: string | undefined,
    step: string,
    update: (value: string) => void,
  ): HTMLElement {
    const label = this.container.ownerDocument.createElement('label');
    label.textContent = labelText;
    label.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    label.appendChild(this.numberInput(field, value, min, max, step, update));
    return label;
  }

  private componentSelect(
    field: string,
    labelText: string,
    selectedId: string | undefined,
    update: (value: string) => void,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const label = document.createElement('label');
    label.textContent = labelText;
    label.style.cssText = 'display:grid;gap:5px;font-weight:650;';
    const select = document.createElement('select');
    select.dataset.virtualField = field;
    select.style.cssText = INPUT_STYLE;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('ui.virtualFilamentLibrary.chooseAPhysicalHead', 'Choose a physical head');
    placeholder.disabled = true;
    select.appendChild(placeholder);
    for (const choice of this.snapshot?.physicalChoices ?? []) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = `H${choice.toolId} · ${choice.name} · ${choice.material} · ${choice.color}${
        choice.enabled && choice.compatible ? '' : ` · ${choice.enabled ? 'incompatible' : 'disabled'}`
      }`;
      option.disabled = (!choice.enabled || !choice.compatible) && choice.id !== selectedId;
      select.appendChild(option);
    }
    select.value = selectedId ?? '';
    if (!select.value) placeholder.selected = true;
    select.addEventListener('change', () => {
      update(select.value);
      this.updateDialogFeedback();
    });
    label.appendChild(select);
    return label;
  }

  private ensureMatchSearch(state: AuthorDialogState): void {
    const search = this.adapter.searchMatchCandidates;
    const snapshot = this.snapshot;
    if (!search || !snapshot || this.dialog !== state || state.mode !== 'match') return;

    const targetColor = normalizeMatchTargetColor(state.match.targetColor);
    const minComponentPercent = parseStrictInteger(state.match.minComponentPercent);
    if (!targetColor || minComponentPercent === undefined || minComponentPercent < 0 || minComponentPercent > 50) {
      this.cancelMatchSearch('Match search input is incomplete');
      return;
    }

    const key = `${state.sourceRevision}\u0000${state.sourceHash}\u0000` + `${targetColor}\u0000${minComponentPercent}`;
    if (this.matchSearch?.key === key) return;

    this.cancelMatchSearch('A newer Match search was requested');
    const token = ++this.matchSearchSequence;
    this.matchSearch = {
      key,
      token,
      status: 'pending',
      candidates: Object.freeze([]),
    };
    const debounceMs = Math.max(0, this.options.matchSearchDebounceMs ?? DEFAULT_MATCH_SEARCH_DEBOUNCE_MS);
    this.matchSearchTimer = setTimeout(() => {
      this.matchSearchTimer = undefined;
      const current = this.matchSearch;
      if (!current || current.token !== token || current.key !== key) return;
      const request = freezeRequest<VirtualFilamentMatchSearchRequest>({
        expectedRevision: state.sourceRevision,
        sourceHash: state.sourceHash,
        targetColor,
        minComponentPercent,
      });
      void Promise.resolve()
        .then(() => search.call(this.adapter, request))
        .then((candidates) => {
          const active = this.matchSearch;
          if (
            this.dialog !== state ||
            state.mode !== 'match' ||
            !active ||
            active.token !== token ||
            active.key !== key ||
            this.dialogIsStale(state)
          ) {
            return;
          }
          this.matchSearch = {
            key,
            token,
            status: 'ready',
            candidates: Object.freeze([...candidates]),
          };
          this.updateDialogFeedback();
        })
        .catch((error: unknown) => {
          const active = this.matchSearch;
          if (
            this.dialog !== state ||
            state.mode !== 'match' ||
            !active ||
            active.token !== token ||
            active.key !== key ||
            this.dialogIsStale(state)
          ) {
            return;
          }
          this.matchSearch = {
            key,
            token,
            status: 'error',
            candidates: Object.freeze([]),
            error: errorMessage(error),
          };
          this.reportError(error);
          this.updateDialogFeedback();
        });
    }, debounceMs);
  }

  private cancelMatchSearch(reason?: unknown): void {
    const pending = this.matchSearch?.status === 'pending';
    if (this.matchSearchTimer !== undefined) {
      clearTimeout(this.matchSearchTimer);
      this.matchSearchTimer = undefined;
    }
    this.matchSearchSequence += 1;
    this.matchSearch = undefined;
    if (!pending) return;
    try {
      this.adapter.cancelMatchCandidateSearch?.(reason);
    } catch (error) {
      this.reportError(error);
    }
  }

  private updateDialogFeedback(): void {
    const state = this.dialog;
    if (!state) return;
    const stale = this.dialogIsStale(state);
    if (state.kind === 'delete') {
      if (this.dialogFeedback) {
        this.dialogFeedback.textContent = state.operationError ?? (stale ? staleDialogMessage() : '');
        this.dialogFeedback.hidden = !this.dialogFeedback.textContent;
      }
      if (this.submitButton) this.submitButton.disabled = state.busy || stale;
      return;
    }

    if (state.mode === 'match') {
      if (stale) this.cancelMatchSearch('Canonical virtual filament snapshot changed');
      else this.ensureMatchSearch(state);
    }
    const validation = this.validateAuthorState(state);
    if (state.mode === 'match') this.renderMatchCandidates(validation.matchRanking, state);
    if (state.mode === 'ratio') {
      const visual = this.dialogCard?.querySelector<HTMLElement>('[data-virtual-ratio-pigment-preview]');
      if (visual) this.updateRatioPigmentPreview(state, visual);
    }
    if (state.mode === 'gradient') {
      const visual = this.dialogCard?.querySelector<HTMLElement>('[data-virtual-gradient-preview]');
      if (visual) this.updateGradientVisual(state, visual);
    }
    const issues = stale
      ? [{ message: staleDialogMessage() }, ...validation.issues]
      : state.operationError
        ? [{ message: state.operationError }, ...validation.issues]
        : validation.issues;
    this.renderDialogIssues(issues);
    if (this.dialogPreview) this.dialogPreview.textContent = validation.preview;
    if (this.dialogPreview) {
      this.dialogPreview.style.borderLeftColor = /^#[0-9a-fA-F]{6}$/.test(state.displayColor)
        ? state.displayColor
        : 'transparent';
      this.dialogPreview.setAttribute('aria-label', `Display badge ${state.displayColor}. ${validation.preview}`);
    }
    if (this.submitButton) {
      this.submitButton.disabled = state.busy || stale || this.matchSearch?.status === 'pending' || !validation.draft;
    }
  }

  private updateRatioPigmentPreview(state: AuthorDialogState, visual: HTMLElement): void {
    const byId = new Map((this.snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
    const choices = state.ratio.componentIds.slice(0, state.ratio.componentCount).map((id) => byId.get(id));
    let predictedColor: string | undefined;
    let method: string | undefined;
    if (state.ratio.componentCount === 2) {
      const mixBPercent = parseStrictInteger(state.ratio.mixBPercent);
      if (choices[0] && choices[1] && mixBPercent !== undefined && mixBPercent >= 0 && mixBPercent <= 100) {
        predictedColor = blendPairFilamentPigment(choices[0].color, choices[1].color, mixBPercent / 100);
        method = 'pinned two-filament pigment model';
      }
    } else {
      const weights = state.ratio.triangleWeights.map(parseStrictFinite);
      if (
        choices.length === 3 &&
        choices.every((choice) => choice !== undefined) &&
        weights.every((weight) => weight !== undefined && weight >= 0) &&
        weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) > 0
      ) {
        const normalized = normalizeRatioTriangleWeights(weights as [number, number, number]);
        const first = parseOrcaMixedColor(choices[0]!.color);
        const second = parseOrcaMixedColor(choices[1]!.color);
        const third = parseOrcaMixedColor(choices[2]!.color);
        predictedColor = filamentRgbToHex([
          Math.round(first[0] * normalized[0] + second[0] * normalized[1] + third[0] * normalized[2]),
          Math.round(first[1] * normalized[0] + second[1] * normalized[1] + third[1] * normalized[2]),
          Math.round(first[2] * normalized[0] + second[2] * normalized[1] + third[2] * normalized[2]),
        ]);
        method = 'pinned triangle weighted-sRGB preview';
      }
    }
    if (!predictedColor || !method) {
      visual.style.background = '#555';
      visual.textContent = t(
        'ui.virtualFilamentLibrary.completeTheRatioRecipeTo',
        'Complete the Ratio recipe to predict its live mix color.',
      );
      visual.setAttribute('aria-label', visual.textContent);
      return;
    }
    visual.style.background = predictedColor;
    visual.textContent = `Predicted mix ${predictedColor} · ${method}. Saved badge remains ${state.displayColor}.`;
    visual.setAttribute('aria-label', visual.textContent);
  }

  private updateGradientVisual(state: AuthorDialogState, visual: HTMLElement): void {
    const snapshot = this.snapshot;
    const byId = new Map((snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
    const first = byId.get(state.gradient.componentIds[0]);
    const second = byId.get(state.gradient.componentIds[1]);
    const top = state.gradient.direction === 'a-to-b' ? first : second;
    const bottom = state.gradient.direction === 'a-to-b' ? second : first;
    if (!first || !second) {
      visual.style.background = '#555';
      visual.textContent = t(
        'ui.virtualFilamentLibrary.chooseTwoPhysicalHeadsFor',
        'Choose two physical heads for the vertical gradient preview.',
      );
      visual.setAttribute('aria-label', visual.textContent);
      return;
    }
    visual.style.background = `linear-gradient(to bottom, ${top!.color}, ${bottom!.color})`;
    visual.textContent =
      `${state.gradient.direction === 'a-to-b' ? 'A→B' : 'B→A'} vertical preview · ` +
      `A ${state.gradient.direction === 'a-to-b' ? '80%→20%' : '20%→80%'} · ` +
      `${first.name} / ${second.name}`;
    visual.setAttribute('aria-label', visual.textContent);
  }

  private renderMatchCandidates(ranking: MatchRanking | undefined, state: AuthorDialogState): void {
    const host = this.matchCandidatesHost;
    if (!host) return;
    [
      ...host.querySelectorAll(
        '[data-virtual-match-candidate], [data-virtual-match-empty], [data-virtual-match-pending]',
      ),
    ].forEach((node) => node.remove());
    const document = host.ownerDocument;
    const search = this.matchSearch;
    const pending = search?.status === 'pending';
    host.setAttribute('aria-busy', String(pending));
    if (pending) {
      const status = document.createElement('p');
      status.dataset.virtualMatchPending = 'true';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = t(
        'ui.virtualFilamentLibrary.searchingTheCompatiblePhysicalPalette',
        'Searching the compatible physical palette…',
      );
      status.style.cssText = MUTED_STYLE;
      host.appendChild(status);
    }
    if (!ranking || ranking.ranked.length === 0) {
      if (pending) return;
      const empty = document.createElement('p');
      empty.dataset.virtualMatchEmpty = 'true';
      empty.textContent =
        search?.status === 'error'
          ? 'Pinned Match search did not complete.'
          : 'No supplied candidate satisfies this target and minimum.';
      empty.style.cssText = MUTED_STYLE;
      host.appendChild(empty);
      return;
    }
    ranking.ranked.forEach((entry, index) => {
      const label = document.createElement('label');
      label.dataset.virtualMatchCandidate = entry.candidate.id;
      label.style.cssText =
        'box-sizing:border-box;display:grid;grid-template-columns:auto 36px 1fr;min-height:52px;gap:9px;' +
        'align-items:center;padding:7px;border:1px solid var(--oxr-color-stroke);border-radius:8px;cursor:pointer;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = this.id('match-candidate');
      radio.value = entry.candidate.id;
      radio.checked = state.match.selectedCandidateId === entry.candidate.id;
      radio.dataset.virtualMatchCandidateChoice = entry.candidate.id;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.match.selectedCandidateId = entry.candidate.id;
        this.updateDialogFeedback();
      });
      const swatch = colorSwatch(
        document,
        entry.ranked.previewColor,
        `Predicted candidate color ${entry.ranked.previewColor}`,
      );
      swatch.style.width = '34px';
      swatch.style.height = '34px';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = `#${index + 1} · ${entry.candidate.label ?? entry.candidate.id}`;
      const detail = document.createElement('span');
      detail.style.cssText = `display:block;${MUTED_STYLE}`;
      detail.textContent =
        `${componentSummary(entry.candidate.components, this.snapshot)} · predicted ${entry.ranked.previewColor} · ` +
        `ΔE2000 ${entry.ranked.deltaE2000.toFixed(2)}`;
      copy.append(title, detail);
      label.append(radio, swatch, copy);
      host.appendChild(label);
    });
  }

  private renderDialogIssues(issues: readonly UiIssue[]): void {
    const host = this.dialogFeedback;
    if (!host) return;
    this.dialogCard
      ?.querySelectorAll<HTMLElement>('[data-virtual-field], [data-virtual-match-candidates]')
      .forEach((control) => {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-errormessage');
      });
    for (const issue of issues) {
      if (!issue.field) continue;
      const selector =
        issue.field === 'match-candidate' ? '[data-virtual-match-candidates]' : `[data-virtual-field="${issue.field}"]`;
      const control = this.dialogCard?.querySelector<HTMLElement>(selector);
      control?.setAttribute('aria-invalid', 'true');
      control?.setAttribute('aria-errormessage', host.id);
    }
    host.replaceChildren();
    host.hidden = issues.length === 0;
    if (issues.length === 0) return;
    const document = host.ownerDocument;
    const list = document.createElement('ul');
    list.style.cssText = 'display:grid;gap:5px;margin:0;padding-inline-start:20px;';
    for (const issue of issues) {
      const item = document.createElement('li');
      if (issue.field === 'cycle-pattern' && issue.startOffset !== undefined && issue.endOffset !== undefined) {
        const startOffset = issue.startOffset;
        const endOffset = issue.endOffset;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.virtualCycleIssue = `${startOffset}:${endOffset}`;
        button.textContent = `${issue.message} Location: characters ${startOffset + 1}–${Math.max(
          startOffset + 1,
          endOffset,
        )}.`;
        button.style.cssText = `${TOUCH_BUTTON_STYLE}min-width:0;text-align: start;`;
        button.addEventListener('click', () => {
          const input = this.dialogCard?.querySelector<HTMLTextAreaElement>('[data-virtual-field="cycle-pattern"]');
          input?.focus();
          input?.setSelectionRange(startOffset, endOffset);
        });
        item.appendChild(button);
      } else {
        item.textContent = issue.message;
      }
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  private validateAuthorState(state: AuthorDialogState): DraftValidation {
    const snapshot = this.snapshot;
    const commonIssues = validateCommon(state);
    if (!snapshot) {
      return { issues: [...commonIssues, { message: 'No canonical snapshot is available.' }], preview: '' };
    }
    if (state.mode === 'ratio') return validateRatio(state, snapshot, commonIssues);
    if (state.mode === 'cycle') return validateCycle(state, snapshot, commonIssues);
    if (state.mode === 'match') return validateMatch(state, snapshot, commonIssues, this.matchSearch);
    return validateGradient(state, snapshot, commonIssues);
  }

  private async submitAuthorDialog(): Promise<void> {
    const state = this.dialog;
    if (!state || state.kind !== 'author' || state.busy || this.dialogIsStale(state)) return;
    const validation = this.validateAuthorState(state);
    if (!validation.draft) {
      this.updateDialogFeedback();
      focusFirstIssue(this.dialogCard, validation.issues);
      return;
    }
    state.busy = true;
    state.operationError = undefined;
    this.syncDialogPending(true);
    const guard = { expectedRevision: state.sourceRevision, sourceHash: state.sourceHash };
    try {
      if (state.operation === 'add') {
        await this.adapter.onAdd(freezeRequest<AddVirtualFilamentRequest>({ ...guard, draft: validation.draft }));
      } else if (state.operation === 'edit' && state.targetId) {
        await this.adapter.onEdit(
          freezeRequest<EditVirtualFilamentRequest>({
            ...guard,
            filamentId: state.targetId,
            draft: validation.draft,
          }),
        );
      } else if (state.operation === 'duplicate' && state.targetId) {
        await this.adapter.onDuplicate(
          freezeRequest<DuplicateVirtualFilamentRequest>({
            ...guard,
            sourceFilamentId: state.targetId,
            draft: validation.draft,
          }),
        );
      } else {
        throw new Error('Virtual filament dialog has an invalid operation target');
      }
      this.operationError = undefined;
      this.operationStatus =
        state.operation === 'add'
          ? `Add request accepted for ${validation.draft.name}.`
          : state.operation === 'edit'
            ? `Edit request accepted for ${validation.draft.name}.`
            : `Duplicate request accepted for ${validation.draft.name}.`;
      this.focusAfterRefresh =
        state.operation === 'add'
          ? { action: 'add' }
          : {
              filamentId: state.targetId,
              action: state.operation === 'edit' ? 'edit' : 'duplicate',
            };
      this.closeDialog(false);
      this.refresh();
    } catch (error) {
      state.busy = false;
      state.operationError = `The recipe was not changed: ${errorMessage(error)}`;
      this.reportError(error);
      this.renderDialog();
    }
  }

  private async setEnabled(row: VirtualFilamentLibraryRow, enabled: boolean): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.operationBusy) return;
    this.operationError = undefined;
    this.operationBusy = true;
    this.operationStatus = enabled ? `Enabling ${row.draft.name}…` : `Disabling ${row.draft.name}…`;
    this.renderLibrary();
    try {
      await this.adapter.onSetEnabled(
        freezeRequest<SetVirtualFilamentEnabledRequest>({
          expectedRevision: snapshot.sourceRevision,
          sourceHash: snapshot.sourceHash,
          filamentId: row.id,
          enabled,
          draft: row.draft,
        }),
      );
      this.operationBusy = false;
      this.operationStatus = `${enabled ? 'Enable' : 'Disable'} request accepted for ${row.draft.name}.`;
      this.focusAfterRefresh = { filamentId: row.id, action: 'enabled' };
      this.refresh();
    } catch (error) {
      this.operationBusy = false;
      this.operationStatus = '';
      this.operationError = `${row.draft.name} was not changed: ${errorMessage(error)}`;
      this.reportError(error);
      this.focusAfterRefresh = { filamentId: row.id, action: 'enabled' };
      this.renderLibrary();
    }
  }

  private async confirmDelete(): Promise<void> {
    const state = this.dialog;
    if (!state || state.kind !== 'delete' || state.busy || this.dialogIsStale(state)) return;
    state.busy = true;
    state.operationError = undefined;
    this.syncDialogPending(true);
    try {
      await this.adapter.onDelete(
        freezeRequest<DeleteVirtualFilamentRequest>({
          expectedRevision: state.sourceRevision,
          sourceHash: state.sourceHash,
          filamentId: state.row.id,
          draft: state.row.draft,
        }),
      );
      this.operationError = undefined;
      this.operationStatus = `Delete request accepted for ${state.row.draft.name}.`;
      this.focusAfterRefresh = { action: 'add' };
      this.closeDialog(false);
      this.refresh();
    } catch (error) {
      state.busy = false;
      state.operationError = `${state.row.draft.name} was not deleted: ${errorMessage(error)}`;
      this.reportError(error);
      this.renderDialog();
    }
  }

  private syncDialogPending(pending: boolean): void {
    const card = this.dialogCard;
    if (!card) return;
    card.setAttribute('aria-busy', String(pending));
    card
      .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, button, select, textarea',
      )
      .forEach((control) => {
        control.disabled = pending;
      });
  }

  private dialogIsStale(state: DialogState): boolean {
    const snapshot = this.snapshot;
    return !snapshot || snapshot.sourceRevision !== state.sourceRevision || snapshot.sourceHash !== state.sourceHash;
  }

  private handleDialogKeydown(event: KeyboardEvent): void {
    const state = this.dialog;
    const card = this.dialogCard;
    if (!state || !card) return;
    if (event.key === 'Escape' && !state.busy) {
      event.preventDefault();
      event.stopPropagation();
      this.closeDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')].filter(
      (element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && !element.hidden,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && card.ownerDocument.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && card.ownerDocument.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private closeDialog(restoreFocus = true): void {
    const returnFocus = this.dialog?.returnFocus;
    this.cancelMatchSearch('Virtual filament dialog closed');
    this.dialog = undefined;
    this.removeDialogNodes();
    if (restoreFocus && returnFocus?.isConnected) queueMicrotask(() => returnFocus.focus());
  }

  private removeDialogNodes(): void {
    this.dialogOverlay?.remove();
    this.dialogOverlay = undefined;
    this.dialogCard = undefined;
    this.dialogFeedback = undefined;
    this.dialogPreview = undefined;
    this.matchCandidatesHost = undefined;
    this.submitButton = undefined;
  }

  private dialogButton(action: string, label: string, run: () => void, primary: boolean): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.virtualDialogAction = action;
    button.textContent = label;
    button.style.cssText =
      TOUCH_BUTTON_STYLE +
      (primary ? 'background:var(--oxr-color-accent);color:var(--oxr-on-accent);font-weight:750;' : '');
    button.addEventListener('click', run);
    return button;
  }

  private createDialogFeedback(initial?: string): HTMLElement {
    const node = this.container.ownerDocument.createElement('div');
    node.id = this.id('dialog-errors');
    node.dataset.virtualDialogErrors = 'true';
    node.setAttribute('role', 'alert');
    node.setAttribute('aria-live', 'assertive');
    node.hidden = !initial;
    node.textContent = initial ?? '';
    node.style.cssText =
      'margin:0;padding:9px;border:1px solid var(--oxr-danger);border-radius:8px;background:var(--oxr-danger-surface);color:var(--oxr-danger);';
    return node;
  }

  private emptyListItem(text: string): HTMLLIElement {
    const item = this.container.ownerDocument.createElement('li');
    item.textContent = text;
    item.style.cssText = MUTED_STYLE;
    return item;
  }

  private reportError(error: unknown): void {
    this.adapter.onError?.(error);
  }

  private restorePostMutationFocus(): void {
    const target = this.focusAfterRefresh;
    if (!target) return;
    this.focusAfterRefresh = undefined;
    queueMicrotask(() => {
      const selector =
        target.action === 'add'
          ? '[data-virtual-filament-add]'
          : `[data-virtual-filament-action="${target.action}"][data-filament-id="${target.filamentId ?? ''}"]`;
      this.root?.querySelector<HTMLElement>(selector)?.focus();
    });
  }

  private id(suffix: string): string {
    return `orcaxr-virtual-filament-${this.instanceId}-${suffix}`;
  }
}

interface MutableAuthorDefaults {
  name: string;
  displayColor: string;
  componentASurfaceOffsetMm: string;
  componentBSurfaceOffsetMm: string;
  mode: VirtualFilamentMode;
  ratio: RatioFormState;
  cycle: CycleFormState;
  match: MatchFormState;
  gradient: GradientFormState;
}

function defaultAuthorState(snapshot: VirtualFilamentLibrarySnapshot): MutableAuthorDefaults {
  const selectable = selectablePhysical(snapshot);
  const first = selectable[0]?.id ?? '';
  const second = selectable[1]?.id ?? '';
  const third = selectable[2]?.id ?? first;
  return {
    name: 'Virtual filament',
    displayColor: '#808080',
    componentASurfaceOffsetMm: '0',
    componentBSurfaceOffsetMm: '0',
    mode: 'ratio',
    ratio: {
      componentCount: 2,
      componentIds: [first, second, third],
      mixBPercent: '50',
      triangleWeights: ['34', '33', '33'],
    },
    cycle: { manualPattern: '' },
    match: { targetColor: '#808080', minComponentPercent: '10' },
    gradient: { componentIds: [first, second], direction: 'a-to-b', localZMaxSublayers: '2' },
  };
}

function loadDraft(target: MutableAuthorDefaults, source: VirtualFilamentValidatedDraft): void {
  target.name = source.name;
  target.displayColor = source.displayColor;
  target.componentASurfaceOffsetMm = String(source.componentASurfaceOffsetMm);
  target.componentBSurfaceOffsetMm = String(source.componentBSurfaceOffsetMm);
  target.mode = source.mode;
  if (source.mode === 'ratio') {
    target.ratio.componentCount = source.components.length === 3 ? 3 : 2;
    target.ratio.componentIds = source.components.map((component) => component.filamentId);
    target.ratio.mixBPercent = String(source.mixBPercent);
    if (source.triangleWeightsPercent) {
      target.ratio.triangleWeights = source.triangleWeightsPercent.map(String) as [string, string, string];
    }
  } else if (source.mode === 'cycle') {
    target.cycle.manualPattern = source.manualPattern;
  } else if (source.mode === 'match') {
    target.match.targetColor = source.targetColor;
    target.match.minComponentPercent = String(source.minComponentPercent);
    target.match.selectedCandidateId = source.selectedCandidateId;
  } else {
    target.gradient.componentIds = [source.components[0].filamentId, source.components[1].filamentId];
    target.gradient.direction = source.direction;
    target.gradient.localZMaxSublayers = String(source.localZMaxSublayers);
  }
}

function validateCommon(state: AuthorDialogState): UiIssue[] {
  const issues: UiIssue[] = [];
  if (!state.name) issues.push({ message: 'Name is required.', field: 'name' });
  else if (state.name !== state.name.trim()) {
    issues.push({ message: 'Name must not start or end with whitespace.', field: 'name' });
  } else if (state.name.length > VIRTUAL_FILAMENT_NAME_LIMIT) {
    issues.push({
      message: `Name cannot exceed ${VIRTUAL_FILAMENT_NAME_LIMIT} characters.`,
      field: 'name',
    });
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(state.displayColor)) {
    issues.push({ message: 'Display badge color must be exactly #RRGGBB.', field: 'display-color' });
  }
  for (const [label, field, value] of [
    ['Component A', 'component-a-surface-offset', state.componentASurfaceOffsetMm],
    ['Component B', 'component-b-surface-offset', state.componentBSurfaceOffsetMm],
  ] as const) {
    const parsed = parseStrictFinite(value);
    if (parsed === undefined || Math.abs(parsed) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
      issues.push({
        message: `${label} surface offset must be a finite number from -${FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM} to +${FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM} mm.`,
        field,
      });
    }
  }
  return issues;
}

function validatedSurfaceOffsets(
  state: AuthorDialogState,
): Pick<VirtualFilamentValidatedDraftBase, 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'> {
  const componentASurfaceOffsetMm = parseStrictFinite(state.componentASurfaceOffsetMm);
  const componentBSurfaceOffsetMm = parseStrictFinite(state.componentBSurfaceOffsetMm);
  if (
    componentASurfaceOffsetMm === undefined ||
    componentBSurfaceOffsetMm === undefined ||
    Math.abs(componentASurfaceOffsetMm) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM ||
    Math.abs(componentBSurfaceOffsetMm) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM
  ) {
    throw new Error('Surface offsets were requested before common authoring validation passed');
  }
  return { componentASurfaceOffsetMm, componentBSurfaceOffsetMm };
}

function validateRatio(
  state: AuthorDialogState,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly UiIssue[],
): DraftValidation {
  const issues = [...commonIssues];
  const count = state.ratio.componentCount;
  const selectedIds = state.ratio.componentIds.slice(0, count);
  const components = resolveComponents(selectedIds, snapshot, issues, 'ratio-component');
  const mixBPercent = parseStrictInteger(state.ratio.mixBPercent);
  if (mixBPercent === undefined) {
    issues.push({ message: 'Component B percent must be an integer from 0 to 100.', field: 'ratio-mix-b' });
  }
  let triangle: [number, number, number] | undefined;
  if (count === 3) {
    const parsed = state.ratio.triangleWeights.map(parseStrictFinite);
    if (parsed.some((value) => value === undefined || value < 0)) {
      issues.push({
        message: 'All three triangle proportions must be finite non-negative numbers.',
        field: 'ratio-weight-0',
      });
    } else {
      triangle = parsed as [number, number, number];
    }
  }

  let projection: MixedFilamentSerializableProjection | undefined;
  if (components.length === count && mixBPercent !== undefined && (count === 2 || triangle)) {
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: components.map((component) => component.toolId),
        mixBPercent,
        ...(triangle ? { triangleWeightsPercent: triangle } : {}),
      },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.projection) projection = result.projection;
    else issues.push(...result.issues.map(authoringIssue));
  }

  const preview = projection
    ? count === 2
      ? `Exact cadence: A ${projection.ratio_a} layer${projection.ratio_a === 1 ? '' : 's'} / B ${
          projection.ratio_b
        } layer${projection.ratio_b === 1 ? '' : 's'}; badge ${state.displayColor}.`
      : `Exact saved triangle weights: ${projection.gradient_component_weights.replaceAll(
          '/',
          '% / ',
        )}%; badge ${state.displayColor}.`
    : 'Complete the Ratio recipe to preview its exact pinned-engine fields.';
  if (!projection || issues.length > 0) return { issues: freezeArray(issues), preview };
  return {
    draft: freezeDraft<VirtualFilamentRatioDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'ratio',
      components,
      mixBPercent: mixBPercent!,
      ...(triangle ? { triangleWeightsPercent: Object.freeze([...triangle]) as [number, number, number] } : {}),
      projection,
    }),
    issues: Object.freeze([]),
    preview,
  };
}

function validateCycle(
  state: AuthorDialogState,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly UiIssue[],
): DraftValidation {
  const issues = [...commonIssues];
  const availableToolIds = selectablePhysical(snapshot).map((choice) => choice.toolId);
  const parsed = parseManualCyclePattern(state.cycle.manualPattern, { availableToolIds });
  issues.push(...parsed.issues.map(cycleIssue));
  const uniqueToolIds = [...new Set(parsed.sequence)];
  const byTool = new Map(snapshot.physicalChoices.map((choice) => [choice.toolId, choice]));
  const components = uniqueToolIds.flatMap((toolId) => {
    const choice = byTool.get(toolId);
    return choice ? [{ filamentId: choice.id, toolId }] : [];
  });
  const cycleWarning =
    uniqueToolIds.length === 1
      ? ' Warning: one distinct head cannot produce a new mixed color.'
      : uniqueToolIds.length > 4
        ? ' Warning: more than four heads may reduce recipe quality.'
        : '';
  const preview = parsed.syntaxValid
    ? `Exact engine pattern: ${parsed.normalized || '(none)'}; groups: ${patternGroupSummary(
        parsed,
        byTool,
      )}.${cycleWarning}`
    : 'Fix the located pattern errors before this exact sequence can be submitted.';
  if (!parsed.ok || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview };
  }
  return {
    draft: freezeDraft<VirtualFilamentCycleDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'cycle',
      manualPattern: state.cycle.manualPattern,
      normalizedPattern: parsed.normalized,
      components,
      groups: parsed.groups.map((group) => Object.freeze(group.tokens.map((token) => token.toolId))),
      sequence: Object.freeze([...parsed.sequence]),
    }),
    issues: Object.freeze([]),
    preview,
  };
}

function validateMatch(
  state: AuthorDialogState,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly UiIssue[],
  search?: MatchSearchState,
): DraftValidation {
  const issues = [...commonIssues];
  const minimum = parseStrictInteger(state.match.minComponentPercent);
  if (minimum === undefined || minimum < 0 || minimum > 50) {
    issues.push({
      message: 'Minimum component percent must be an integer from 0 to 50.',
      field: 'match-minimum',
    });
  }
  if (search?.status === 'error') {
    issues.push({
      message: `Pinned Match search is unavailable: ${search.error ?? 'Unknown search error'}`,
      field: 'match-candidate',
    });
  }
  const dynamicCandidates = search?.status === 'ready' ? search.candidates : undefined;
  const ranking =
    minimum === undefined
      ? { ranked: Object.freeze([]), issues: Object.freeze([]) }
      : rankSuppliedCandidates(
          snapshot,
          state.match.targetColor,
          minimum,
          dynamicCandidates
            ? dedupeMatchCandidates([...dynamicCandidates, ...snapshot.matchCandidates])
            : snapshot.matchCandidates,
        );
  issues.push(...ranking.issues);
  const selected = ranking.ranked.find((entry) => entry.candidate.id === state.match.selectedCandidateId);
  if (ranking.ranked.length > 0 && !selected) {
    issues.push({
      message: 'Explicitly select one ranked supplied candidate.',
      field: 'match-candidate',
    });
  }
  const preview = selected
    ? `Selected ${selected.candidate.label ?? selected.candidate.id}: predicted ${
        selected.ranked.previewColor
      }, target ${ranking.normalizedTargetColor}, ΔE2000 ${selected.ranked.deltaE2000.toFixed(2)}.`
    : search?.status === 'pending'
      ? 'Searching the compatible physical palette for the closest pinned Match recipe.'
      : 'Enter a valid target and minimum, then explicitly select one supplied candidate.';
  if (!selected || minimum === undefined || !ranking.normalizedTargetColor || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview, matchRanking: ranking };
  }
  const physicalById = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const normalizedWeights = normalizeColorMatchWeights(
    selected.candidate.components.map((component) => component.weight),
    selected.candidate.components.length,
  );
  const components = selected.candidate.components.map((component, index) => {
    const physical = physicalById.get(component.filamentId)!;
    return Object.freeze({
      filamentId: physical.id,
      toolId: physical.toolId,
      weight: normalizedWeights[index],
    });
  });
  return {
    draft: freezeDraft<VirtualFilamentMatchDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'match',
      targetColor: state.match.targetColor,
      normalizedTargetColor: ranking.normalizedTargetColor,
      minComponentPercent: minimum,
      selectedCandidateId: selected.candidate.id,
      previewColor: selected.ranked.previewColor,
      deltaE2000: selected.ranked.deltaE2000,
      components,
      projection: selected.ranked.projection,
    }),
    issues: Object.freeze([]),
    preview,
    matchRanking: ranking,
  };
}

function validateGradient(
  state: AuthorDialogState,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly UiIssue[],
): DraftValidation {
  const issues = [...commonIssues];
  const components = resolveComponents(state.gradient.componentIds, snapshot, issues, 'gradient-component');
  const sublayers = parseStrictInteger(state.gradient.localZMaxSublayers);
  if (sublayers === undefined || sublayers < 2) {
    issues.push({
      message: 'Gradient Local-Z sublayers must be a safe integer of at least 2.',
      field: 'gradient-sublayers',
    });
  }
  let projection: MixedFilamentSerializableProjection | undefined;
  if (components.length === 2 && sublayers !== undefined && sublayers >= 2) {
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'gradient',
        componentIds: components.map((component) => component.toolId),
        direction: state.gradient.direction,
        localZMaxSublayers: sublayers,
      },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.projection) projection = result.projection;
    else issues.push(...result.issues.map(authoringIssue));
  }
  const preview = projection
    ? `${state.gradient.direction === 'a-to-b' ? 'A→B' : 'B→A'}: component A ${Math.round(
        projection.gradient_start * 100,
      )}% → ${Math.round(projection.gradient_end * 100)}%; component B ${Math.round(
        (1 - projection.gradient_start) * 100,
      )}% → ${Math.round((1 - projection.gradient_end) * 100)}%; ${projection.local_z_max_sublayers} Local-Z sublayers.`
    : 'Choose two distinct physical heads and at least two Local-Z sublayers.';
  if (!projection || components.length !== 2 || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview };
  }
  return {
    draft: freezeDraft<VirtualFilamentGradientDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'gradient',
      components: Object.freeze([components[0], components[1]]),
      direction: state.gradient.direction,
      localZMaxSublayers: sublayers!,
      projection,
    }),
    issues: Object.freeze([]),
    preview,
  };
}

function rankSuppliedCandidates(
  snapshot: VirtualFilamentLibrarySnapshot,
  targetColor: string,
  minComponentPercent: number,
  candidates: readonly VirtualFilamentMatchCandidate[] = snapshot.matchCandidates,
): MatchRanking {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const eligible: VirtualFilamentMatchCandidate[] = [];
  const candidateIssues: UiIssue[] = [];
  for (const candidate of candidates) {
    const selectable = candidate.components.every((component) => {
      const physical = byId.get(component.filamentId);
      return physical?.enabled === true && physical.compatible;
    });
    if (!selectable) continue;
    const components = candidate.components.flatMap((component) => {
      const physical = byId.get(component.filamentId);
      return physical ? [{ toolId: physical.toolId, weight: component.weight }] : [];
    });
    const result = projectMixedFilamentAuthoring(
      { mode: 'match', components, targetColor, minComponentPercent },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.ok) eligible.push(candidate);
  }
  const ranked = rankColorMatchCandidates({
    physicalToolCount: snapshot.physicalChoices.length,
    targetColor,
    minComponentPercent,
    candidates: eligible.map((candidate) => ({
      components: candidate.components.map((component) => ({
        toolId: byId.get(component.filamentId)!.toolId,
        weight: component.weight,
      })),
      previewColor: candidate.previewColor,
    })),
  });
  if (!ranked.ok) candidateIssues.push(...ranked.issues.map(authoringIssue));
  const views = ranked.candidates.map((entry) =>
    Object.freeze({
      candidate: eligible[entry.sourceIndex],
      ranked: entry,
    }),
  );
  return Object.freeze({
    ...(ranked.normalizedTargetColor ? { normalizedTargetColor: ranked.normalizedTargetColor } : {}),
    ranked: Object.freeze(views),
    issues: freezeArray(dedupeIssues(candidateIssues)),
  });
}

function dedupeMatchCandidates(
  candidates: readonly VirtualFilamentMatchCandidate[],
): readonly VirtualFilamentMatchCandidate[] {
  const ids = new Set<string>();
  return Object.freeze(
    candidates.filter((candidate) => {
      if (ids.has(candidate.id)) return false;
      ids.add(candidate.id);
      return true;
    }),
  );
}

function resolveComponents(
  ids: readonly string[],
  snapshot: VirtualFilamentLibrarySnapshot,
  issues: UiIssue[],
  fieldPrefix: string,
): VirtualFilamentValidatedComponent[] {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const seen = new Set<string>();
  const components: VirtualFilamentValidatedComponent[] = [];
  ids.forEach((id, index) => {
    const field = `${fieldPrefix}-${index}`;
    const choice = byId.get(id);
    if (!choice) {
      issues.push({ message: `Component ${index + 1} must choose a physical head.`, field });
      return;
    }
    if (!choice.enabled) issues.push({ message: `${choice.name} is disabled.`, field });
    if (!choice.compatible) {
      issues.push({
        message: `${choice.name} is incompatible${choice.incompatibilityReason ? `: ${choice.incompatibilityReason}` : '.'}`,
        field,
      });
    }
    if (seen.has(id)) {
      issues.push({ message: 'A recipe cannot select the same physical head more than once.', field });
      return;
    }
    seen.add(id);
    components.push(Object.freeze({ filamentId: id, toolId: choice.toolId }));
  });
  return components;
}

function immutableSnapshot(input: VirtualFilamentLibrarySnapshot): VirtualFilamentLibrarySnapshot {
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    throw new Error('sourceRevision must be a non-negative safe integer');
  }
  if (!input.sourceHash || input.sourceHash !== input.sourceHash.trim()) {
    throw new Error('sourceHash must be non-empty canonical text');
  }
  if (input.physicalChoices.length > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
    throw new Error(`At most ${MAX_AUTHORING_PHYSICAL_TOOL_ID} physical heads are supported`);
  }
  const physicalIds = new Set<string>();
  const toolIds = new Set<number>();
  const physicalChoices = input.physicalChoices.map((choice) => {
    assertIdentifier(choice.id, 'physical filament ID');
    if (physicalIds.has(choice.id)) throw new Error(`Duplicate physical filament ID ${choice.id}`);
    physicalIds.add(choice.id);
    if (!Number.isSafeInteger(choice.toolId) || choice.toolId < 1 || choice.toolId > input.physicalChoices.length) {
      throw new Error(`Physical tool ID ${choice.toolId} must be within 1..${input.physicalChoices.length}`);
    }
    if (toolIds.has(choice.toolId)) throw new Error(`Duplicate physical tool ID ${choice.toolId}`);
    toolIds.add(choice.toolId);
    if (!choice.name.trim() || !choice.material.trim()) throw new Error('Physical choice labels must not be empty');
    if (!/^#[0-9a-fA-F]{6}$/.test(choice.color)) throw new Error(`Invalid physical color ${choice.color}`);
    return Object.freeze({ ...choice });
  });
  const expectedTools = Array.from({ length: physicalChoices.length }, (_, index) => index + 1);
  if (expectedTools.some((toolId) => !toolIds.has(toolId))) {
    throw new Error('Physical tool IDs must form the contiguous pinned-engine namespace 1..N');
  }

  const candidateIds = new Set<string>();
  const matchCandidates = input.matchCandidates.map((candidate) => {
    assertIdentifier(candidate.id, 'Match candidate ID');
    if (candidateIds.has(candidate.id)) throw new Error(`Duplicate Match candidate ID ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (!/^#[0-9a-fA-F]{6}$/.test(candidate.previewColor)) {
      throw new Error(`Invalid Match preview color ${candidate.previewColor}`);
    }
    if (candidate.components.length < 2 || candidate.components.length > 4) {
      throw new Error(`Match candidate ${candidate.id} must have two to four components`);
    }
    const seen = new Set<string>();
    const components = candidate.components.map((component) => {
      if (!physicalIds.has(component.filamentId)) {
        throw new Error(`Match candidate ${candidate.id} references unknown physical filament ${component.filamentId}`);
      }
      if (seen.has(component.filamentId)) {
        throw new Error(`Match candidate ${candidate.id} repeats physical filament ${component.filamentId}`);
      }
      seen.add(component.filamentId);
      if (!Number.isSafeInteger(component.weight) || component.weight < 0) {
        throw new Error(`Match candidate ${candidate.id} has an invalid weight`);
      }
      return Object.freeze({ ...component });
    });
    return Object.freeze({ ...candidate, components: Object.freeze(components) });
  });

  const mixedIds = new Set<string>();
  const mixedRows = input.mixedRows.map((row) => {
    assertIdentifier(row.id, 'virtual filament ID');
    if (mixedIds.has(row.id)) throw new Error(`Duplicate virtual filament ID ${row.id}`);
    mixedIds.add(row.id);
    assertSnapshotDraft(row.draft, physicalChoices);
    const dependencyLabels = Object.freeze([...(row.dependencyLabels ?? [])]);
    return Object.freeze({
      id: row.id,
      enabled: row.enabled,
      draft: cloneFrozenDraft(row.draft),
      ...(dependencyLabels.length > 0 ? { dependencyLabels } : {}),
    });
  });
  return Object.freeze({
    sourceRevision: input.sourceRevision,
    sourceHash: input.sourceHash,
    physicalChoices: Object.freeze(physicalChoices),
    mixedRows: Object.freeze(mixedRows),
    matchCandidates: Object.freeze(matchCandidates),
  });
}

function assertSnapshotDraft(
  draft: VirtualFilamentValidatedDraft,
  physicalChoices: readonly VirtualFilamentPhysicalChoice[],
): void {
  if (!draft.name || draft.name !== draft.name.trim() || draft.name.length > VIRTUAL_FILAMENT_NAME_LIMIT) {
    throw new Error('Virtual filament draft has an invalid name');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(draft.displayColor)) {
    throw new Error(`Virtual filament ${draft.name} has an invalid display color`);
  }
  for (const offset of [draft.componentASurfaceOffsetMm, draft.componentBSurfaceOffsetMm]) {
    if (!Number.isFinite(offset) || Math.abs(offset) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
      throw new Error(`Virtual filament ${draft.name} has an invalid component surface offset`);
    }
  }
  const byId = new Map(physicalChoices.map((choice) => [choice.id, choice]));
  const validateComponents = (
    components: readonly VirtualFilamentValidatedComponent[],
    minimum: number,
    maximum: number,
  ): number[] => {
    if (components.length < minimum || components.length > maximum) {
      throw new Error(`Virtual filament ${draft.name} has an invalid component count`);
    }
    const ids = new Set<string>();
    return components.map((component) => {
      const physical = byId.get(component.filamentId);
      if (!physical || physical.toolId !== component.toolId || ids.has(component.filamentId)) {
        throw new Error(`Virtual filament ${draft.name} has an invalid physical component`);
      }
      ids.add(component.filamentId);
      return component.toolId;
    });
  };

  if (draft.mode === 'ratio') {
    const toolIds = validateComponents(draft.components, 2, 3);
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: toolIds,
        mixBPercent: draft.mixBPercent,
        ...(draft.triangleWeightsPercent ? { triangleWeightsPercent: draft.triangleWeightsPercent } : {}),
      },
      { physicalToolCount: physicalChoices.length },
    );
    requireMatchingProjection(draft, result.projection);
    return;
  }
  if (draft.mode === 'cycle') {
    const toolIds = validateComponents(draft.components, 1, MAX_AUTHORING_PHYSICAL_TOOL_ID);
    const parsed = parseManualCyclePattern(draft.manualPattern, {
      availableToolIds: physicalChoices.map((choice) => choice.toolId),
    });
    if (
      !parsed.ok ||
      parsed.normalized !== draft.normalizedPattern ||
      !sameNumbers(parsed.sequence, draft.sequence) ||
      parsed.groups.length !== draft.groups.length ||
      parsed.groups.some(
        (group, index) =>
          !sameNumbers(
            group.tokens.map((token) => token.toolId),
            draft.groups[index],
          ),
      ) ||
      !sameNumbers([...new Set(parsed.sequence)], toolIds)
    ) {
      throw new Error(`Virtual filament ${draft.name} has an invalid Cycle draft`);
    }
    return;
  }
  if (draft.mode === 'match') {
    const toolIds = validateComponents(draft.components, 2, 4);
    if (
      !draft.selectedCandidateId ||
      !/^#[0-9a-fA-F]{6}$/.test(draft.previewColor) ||
      !Number.isFinite(draft.deltaE2000) ||
      draft.deltaE2000 < 0
    ) {
      throw new Error(`Virtual filament ${draft.name} has invalid Match result metadata`);
    }
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'match',
        components: toolIds.map((toolId, index) => ({
          toolId,
          weight: draft.components[index].weight,
        })),
        targetColor: draft.targetColor,
        minComponentPercent: draft.minComponentPercent,
      },
      { physicalToolCount: physicalChoices.length },
    );
    if (result.normalizedTargetColor !== draft.normalizedTargetColor) {
      throw new Error(`Virtual filament ${draft.name} has a mismatched normalized Match target`);
    }
    requireMatchingProjection(draft, result.projection);
    return;
  }
  const toolIds = validateComponents(draft.components, 2, 2);
  if (!Number.isSafeInteger(draft.localZMaxSublayers) || draft.localZMaxSublayers < 2) {
    throw new Error(`Virtual filament ${draft.name} has an invalid Local-Z sublayer count`);
  }
  const result = projectMixedFilamentAuthoring(
    {
      mode: 'gradient',
      componentIds: toolIds,
      direction: draft.direction,
      localZMaxSublayers: draft.localZMaxSublayers,
    },
    { physicalToolCount: physicalChoices.length },
  );
  requireMatchingProjection(draft, result.projection);
}

function requireMatchingProjection(
  draft: { readonly name: string; readonly projection: MixedFilamentSerializableProjection },
  projection: MixedFilamentSerializableProjection | null,
): void {
  if (!projection || !sameProjection(projection, draft.projection)) {
    throw new Error(`Virtual filament ${draft.name} has a mismatched pinned-engine projection`);
  }
}

function sameProjection(
  first: MixedFilamentSerializableProjection,
  second: MixedFilamentSerializableProjection,
): boolean {
  return (
    first.ui_mode === second.ui_mode &&
    first.component_a === second.component_a &&
    first.component_b === second.component_b &&
    first.mix_b_percent === second.mix_b_percent &&
    first.ratio_a === second.ratio_a &&
    first.ratio_b === second.ratio_b &&
    first.manual_pattern === second.manual_pattern &&
    first.gradient_component_ids === second.gradient_component_ids &&
    first.gradient_component_weights === second.gradient_component_weights &&
    first.distribution_mode === second.distribution_mode &&
    first.local_z_max_sublayers === second.local_z_max_sublayers &&
    first.gradient_enabled === second.gradient_enabled &&
    first.gradient_start === second.gradient_start &&
    first.gradient_end === second.gradient_end &&
    first.custom === second.custom
  );
}

function sameNumbers(first: readonly number[], second: readonly number[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function cloneFrozenDraft(draft: VirtualFilamentValidatedDraft): VirtualFilamentValidatedDraft {
  if (draft.mode === 'ratio') {
    return freezeDraft<VirtualFilamentRatioDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      ...(draft.triangleWeightsPercent
        ? {
            triangleWeightsPercent: Object.freeze([...draft.triangleWeightsPercent]) as [number, number, number],
          }
        : {}),
      projection: Object.freeze({ ...draft.projection }),
    });
  }
  if (draft.mode === 'cycle') {
    return freezeDraft<VirtualFilamentCycleDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      groups: draft.groups.map((group) => [...group]),
      sequence: [...draft.sequence],
    });
  }
  if (draft.mode === 'match') {
    return freezeDraft<VirtualFilamentMatchDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      projection: Object.freeze({ ...draft.projection }),
    });
  }
  return freezeDraft<VirtualFilamentGradientDraft>({
    ...draft,
    components: [{ ...draft.components[0] }, { ...draft.components[1] }],
    projection: Object.freeze({ ...draft.projection }),
  });
}

function freezeDraft<T extends VirtualFilamentValidatedDraft>(draft: T): T {
  if ('components' in draft) {
    (draft as { components: readonly object[] }).components = Object.freeze(
      draft.components.map((component) => Object.freeze({ ...component })),
    );
  }
  if (draft.mode === 'cycle') {
    (draft as VirtualFilamentCycleDraft & { groups: readonly (readonly number[])[] }).groups = Object.freeze(
      draft.groups.map((group) => Object.freeze([...group])),
    );
    (draft as VirtualFilamentCycleDraft & { sequence: readonly number[] }).sequence = Object.freeze([
      ...draft.sequence,
    ]);
  }
  if (draft.mode === 'ratio' && draft.triangleWeightsPercent) {
    (
      draft as VirtualFilamentRatioDraft & {
        triangleWeightsPercent: readonly [number, number, number];
      }
    ).triangleWeightsPercent = Object.freeze([...draft.triangleWeightsPercent]) as [number, number, number];
  }
  if ('projection' in draft) {
    (draft as { projection: MixedFilamentSerializableProjection }).projection = Object.freeze({
      ...draft.projection,
    });
  }
  return Object.freeze(draft);
}

function freezeRequest<T extends object>(request: T): T {
  return Object.freeze(request);
}

function selectablePhysical(snapshot: VirtualFilamentLibrarySnapshot): readonly VirtualFilamentPhysicalChoice[] {
  return snapshot.physicalChoices.filter((choice) => choice.enabled && choice.compatible);
}

function authoringIssue(issue: { readonly message: string; readonly location: { readonly path: string } }): UiIssue {
  return Object.freeze({ message: issue.message, field: pathToField(issue.location.path) });
}

function cycleIssue(issue: {
  readonly message: string;
  readonly location: { readonly startOffset: number; readonly endOffset: number };
}): UiIssue {
  return Object.freeze({
    message: issue.message,
    field: 'cycle-pattern',
    startOffset: issue.location.startOffset,
    endOffset: issue.location.endOffset,
  });
}

function pathToField(path: string): string | undefined {
  if (path.includes('mixBPercent')) return 'ratio-mix-b';
  if (path.includes('triangleWeightsPercent')) return 'ratio-weight-0';
  if (path.includes('targetColor')) return 'match-target';
  if (path.includes('minComponentPercent')) return 'match-minimum';
  if (path.includes('localZMaxSublayers')) return 'gradient-sublayers';
  return undefined;
}

function parseStrictInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseStrictFinite(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeMatchTargetColor(value: string): string | undefined {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined;
}

function validRangeValue(value: string, min: number, max: number, fallback: number): string {
  const parsed = parseStrictInteger(value);
  return String(parsed === undefined ? fallback : Math.min(max, Math.max(min, parsed)));
}

function normalizeTriangleVisualWeights(values: readonly number[]): [number, number, number] {
  const safe = [0, 1, 2].map((index) => {
    const value = values[index];
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }) as [number, number, number];
  const total = safe[0] + safe[1] + safe[2];
  if (total <= 0) return [34, 33, 33];
  return safe.map((value) => (value * 100) / total) as [number, number, number];
}

function triangleWeightsAtPoint(
  x: number,
  y: number,
  vertices: readonly { readonly x: number; readonly y: number }[],
): [number, number, number] {
  const [a, b, c] = vertices;
  if (!a || !b || !c) return [34, 33, 33];
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < Number.EPSILON) return [34, 33, 33];
  const weightA = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const weightB = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  return normalizeRatioTriangleBarycentricWeights([weightA, weightB, 1 - weightA - weightB]).map(
    (weight) => weight * 100,
  ) as [number, number, number];
}

function patternGroupSummary(
  parsed: ManualCyclePatternParseResult,
  byTool: ReadonlyMap<number, VirtualFilamentPhysicalChoice>,
): string {
  return parsed.groups
    .map((group, index) => {
      const names = group.tokens.map((token) => {
        const physical = byTool.get(token.toolId);
        return physical ? `H${token.toolId} ${physical.name}` : `H${token.toolId}`;
      });
      return `group ${index + 1}: ${names.join(' → ') || 'empty'}`;
    })
    .join('; ');
}

function draftSummary(draft: VirtualFilamentValidatedDraft, snapshot: VirtualFilamentLibrarySnapshot): string {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  if (draft.mode === 'ratio') {
    const names = draft.components.map((component) => byId.get(component.filamentId)?.name ?? component.filamentId);
    return draft.components.length === 2
      ? `${names.join(' + ')} · B ${draft.mixBPercent}%`
      : `${names.join(' + ')} · triangle ${draft.projection.gradient_component_weights}`;
  }
  if (draft.mode === 'cycle') return `Pattern ${draft.normalizedPattern}`;
  if (draft.mode === 'match') {
    return `Target ${draft.normalizedTargetColor} · predicted ${draft.previewColor} · candidate ${draft.selectedCandidateId}`;
  }
  return `${draft.direction === 'a-to-b' ? 'A→B' : 'B→A'} · A ${Math.round(
    draft.projection.gradient_start * 100,
  )}%→${Math.round(draft.projection.gradient_end * 100)}% · ${draft.localZMaxSublayers} sublayers`;
}

function componentSummary(
  components: readonly VirtualFilamentMatchCandidateComponent[],
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
): string {
  const byId = new Map((snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
  const normalized = normalizeColorMatchWeights(
    components.map((component) => component.weight),
    components.length,
  );
  return `Saved weights: ${components
    .map((component, index) => {
      const physical = byId.get(component.filamentId);
      return `${physical ? `H${physical.toolId} ${physical.name}` : component.filamentId} ${normalized[index]}%`;
    })
    .join(' / ')}`;
}

function modeLabel(mode: VirtualFilamentMode): string {
  switch (mode) {
    case 'ratio':
      return 'Ratio';
    case 'cycle':
      return 'Cycle';
    case 'match':
      return 'Match';
    case 'gradient':
      return 'Gradient';
  }
}

function duplicateName(name: string): string {
  const suffix = ' copy';
  return name.length + suffix.length <= VIRTUAL_FILAMENT_NAME_LIMIT
    ? `${name}${suffix}`
    : `${name.slice(0, VIRTUAL_FILAMENT_NAME_LIMIT - suffix.length)}${suffix}`;
}

function staleDialogMessage(): string {
  return 'The canonical snapshot changed while this dialog was open. Cancel and reopen it before applying.';
}

function colorSwatch(document: Document, color: string, label: string): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.setAttribute('role', 'img');
  swatch.setAttribute('aria-label', label);
  swatch.title = label;
  swatch.style.cssText =
    `box-sizing:border-box;width:38px;height:38px;flex:0 0 38px;border:2px solid var(--oxr-stroke-strong);border-radius:50%;` +
    `background:${color};box-shadow:inset 0 0 0 1px #0006;`;
  return swatch;
}

function focusFirstIssue(card: HTMLElement | undefined, issues: readonly UiIssue[]): void {
  const field = issues.find((issue) => issue.field)?.field;
  if (!field) return;
  card?.querySelector<HTMLElement>(`[data-virtual-field="${field}"]`)?.focus();
}

function dedupeIssues(issues: readonly UiIssue[]): UiIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field ?? ''}|${issue.startOffset ?? ''}|${issue.endOffset ?? ''}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim() || value.length > 256) throw new Error(`${label} is invalid`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
