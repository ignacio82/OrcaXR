import { isStableEntityId, type LayerRangeId, type ObjectId, type VolumeId } from '../../project/domain/ids';
import type { VolumeRole } from '../../project/domain/model';
import {
  ORCA_VOLUME_ROLE_ORDER,
  type VolumeRoleConversionDecision,
} from '../../project/objects/semanticVolumeCommands';

type MaybePromise = void | Promise<void>;
type OperationStatusKind = 'idle' | 'pending' | 'success' | 'error';

export interface SemanticVolumeRoleDecisionSnapshot {
  readonly role: VolumeRole;
  readonly decision: VolumeRoleConversionDecision;
}

export interface SemanticSelectedVolumeSnapshot {
  readonly id: VolumeId;
  readonly name: string;
  readonly role: VolumeRole;
  /** Decisions should come from `inspectVolumeRoleConversion`. */
  readonly roleDecisions: readonly SemanticVolumeRoleDecisionSnapshot[];
}

export interface SemanticLayerRangeSnapshot {
  readonly id: LayerRangeId;
  readonly minZMm: number;
  readonly maxZMm: number;
}

export type SemanticLayerRangeMergeDecision =
  | {
      readonly allowed: true;
      readonly otherRangeId: LayerRangeId;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly otherRangeId?: LayerRangeId;
    };

export interface SemanticSelectedLayerRangeSnapshot {
  readonly id: LayerRangeId;
  /** Exact compatibility decision for the preceding canonical range. */
  readonly mergePrevious: SemanticLayerRangeMergeDecision;
  /** Exact compatibility decision for the following canonical range. */
  readonly mergeNext: SemanticLayerRangeMergeDecision;
}

/** Immutable projection consumed by the DOM-only editor. */
export interface SemanticObjectEditorSnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly objectId: ObjectId;
  readonly objectName: string;
  readonly selectedVolume?: SemanticSelectedVolumeSnapshot;
  readonly layerRanges: readonly SemanticLayerRangeSnapshot[];
  readonly selectedLayerRange?: SemanticSelectedLayerRangeSnapshot;
}

export interface SemanticEditorRequestGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
  readonly objectId: ObjectId;
}

export interface ConvertSemanticVolumeRoleRequest extends SemanticEditorRequestGuard {
  readonly volumeId: VolumeId;
  readonly nextRole: VolumeRole;
}

export interface AddSemanticLayerRangeRequest extends SemanticEditorRequestGuard {
  readonly layerRangeId: LayerRangeId;
  readonly minZMm: number;
  readonly maxZMm: number;
}

export interface EditSemanticLayerRangeRequest extends SemanticEditorRequestGuard {
  readonly layerRangeId: LayerRangeId;
  readonly minZMm: number;
  readonly maxZMm: number;
}

export interface SplitSemanticLayerRangeRequest extends SemanticEditorRequestGuard {
  readonly layerRangeId: LayerRangeId;
  readonly splitZMm: number;
  readonly upperRangeId: LayerRangeId;
}

export interface MergeSemanticLayerRangesRequest extends SemanticEditorRequestGuard {
  readonly firstRangeId: LayerRangeId;
  readonly secondRangeId: LayerRangeId;
}

export interface DeleteSemanticLayerRangeRequest extends SemanticEditorRequestGuard {
  readonly layerRangeId: LayerRangeId;
}

/**
 * The adapter owns canonical commands, stable-ID allocation, revision guards,
 * and projection updates. The editor never mutates a supplied snapshot.
 */
export interface SemanticObjectEditorAdapter {
  getSnapshot(): SemanticObjectEditorSnapshot | undefined;
  subscribe?(listener: () => void): () => void;
  createLayerRangeId(): LayerRangeId;
  onConvertVolumeRole(request: ConvertSemanticVolumeRoleRequest): MaybePromise;
  onAddLayerRange(request: AddSemanticLayerRangeRequest): MaybePromise;
  onEditLayerRange(request: EditSemanticLayerRangeRequest): MaybePromise;
  onSplitLayerRange(request: SplitSemanticLayerRangeRequest): MaybePromise;
  onMergeLayerRanges(request: MergeSemanticLayerRangesRequest): MaybePromise;
  onDeleteLayerRange(request: DeleteSemanticLayerRangeRequest): MaybePromise;
  onError?(error: unknown): void;
}

export interface SemanticObjectEditorOptions {
  readonly heading?: string;
}

interface BoundsValidation {
  readonly valid: boolean;
  readonly message: string;
  readonly minZMm?: number;
  readonly maxZMm?: number;
}

interface OperationStatus {
  readonly kind: OperationStatusKind;
  readonly message: string;
}

let editorSequence = 0;

/** Accessible adapter-driven editor for canonical volume roles and height ranges. */
export class SemanticObjectEditor {
  private readonly instanceId = ++editorSequence;
  private root?: HTMLElement;
  private statusNode?: HTMLElement;
  private snapshot?: SemanticObjectEditorSnapshot;
  private unsubscribe?: () => void;
  private pending = false;
  private status: OperationStatus = {
    kind: 'idle',
    message: 'Changes are applied only after the canonical adapter accepts a guarded request.',
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SemanticObjectEditorAdapter,
    private readonly options: SemanticObjectEditorOptions = {},
  ) {}

  mount(): void {
    if (this.root) return;
    const root = this.container.ownerDocument.createElement('section');
    root.dataset.semanticObjectEditor = 'true';
    root.setAttribute('aria-labelledby', this.id('heading'));
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:12px;color:var(--oxr-color-text,#fff);' +
      'font:13px/1.4 system-ui,sans-serif;';
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
    this.statusNode = undefined;
    this.snapshot = undefined;
    this.pending = false;
  }

  private render(): void {
    const root = this.root;
    const snapshot = this.snapshot;
    if (!root) return;
    const document = root.ownerDocument;
    const fragment = document.createDocumentFragment();

    const heading = document.createElement('h2');
    heading.id = this.id('heading');
    heading.textContent = this.options.heading ?? 'Semantic object editing';
    heading.style.cssText = 'margin:0;font-size:16px;line-height:1.3;';
    fragment.appendChild(heading);

    if (!snapshot) {
      const empty = document.createElement('p');
      empty.dataset.semanticObjectEmpty = 'true';
      empty.textContent = 'Select an object, instance, part, or height range to edit semantic properties.';
      empty.style.cssText = mutedTextStyle;
      fragment.appendChild(empty);
      root.replaceChildren(fragment);
      root.removeAttribute('aria-busy');
      this.statusNode = undefined;
      return;
    }

    const context = document.createElement('p');
    context.dataset.semanticObjectContext = 'true';
    context.dataset.objectId = snapshot.objectId;
    context.textContent = snapshot.objectName;
    context.style.cssText = 'margin:0;color:var(--oxr-color-text-muted,#a0aab5);';
    fragment.appendChild(context);

    const status = document.createElement('p');
    status.id = this.id('status');
    status.dataset.semanticEditorStatus = this.status.kind;
    status.setAttribute('role', this.status.kind === 'error' ? 'alert' : 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = this.status.message;
    status.style.cssText = `margin:0;min-height:1.4em;color:${
      this.status.kind === 'error' ? '#ffb4ab' : 'var(--oxr-color-text-muted,#a0aab5)'
    };`;
    fragment.appendChild(status);
    this.statusNode = status;

    const snapshotProblem = inspectSnapshot(snapshot);
    if (snapshotProblem) {
      const warning = document.createElement('p');
      warning.dataset.semanticSnapshotError = 'true';
      warning.setAttribute('role', 'alert');
      warning.textContent = `Semantic editing is unavailable because the canonical snapshot is invalid: ${snapshotProblem}`;
      warning.style.cssText = alertStyle;
      fragment.appendChild(warning);
    }

    fragment.appendChild(this.createVolumeEditor(snapshot, Boolean(snapshotProblem)));
    fragment.appendChild(this.createLayerRangeEditor(snapshot, Boolean(snapshotProblem)));

    root.replaceChildren(fragment);
    root.setAttribute('aria-busy', String(this.pending));
    if (this.pending) this.setControlsPending(true);
  }

  private createVolumeEditor(snapshot: SemanticObjectEditorSnapshot, snapshotBlocked: boolean): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    section.dataset.semanticVolumeEditor = 'true';
    section.style.cssText = sectionStyle;
    const heading = document.createElement('h3');
    heading.id = this.id('volume-heading');
    heading.textContent = 'Volume role';
    heading.style.cssText = subsectionHeadingStyle;
    section.setAttribute('aria-labelledby', heading.id);
    section.appendChild(heading);

    const selected = snapshot.selectedVolume;
    if (!selected) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a part or semantic volume to inspect its role.';
      empty.style.cssText = mutedTextStyle;
      section.appendChild(empty);
      return section;
    }

    section.dataset.volumeId = selected.id;
    const summary = document.createElement('p');
    summary.textContent = `${selected.name} — ${roleLabel(selected.role)}`;
    summary.style.cssText = 'margin:0;';
    section.appendChild(summary);

    const fieldset = document.createElement('fieldset');
    fieldset.disabled = snapshotBlocked;
    fieldset.style.cssText = fieldsetStyle;
    const legend = document.createElement('legend');
    legend.textContent = 'Convert to';
    legend.style.cssText = legendStyle;
    fieldset.appendChild(legend);

    for (const role of ORCA_VOLUME_ROLE_ORDER) {
      fieldset.appendChild(this.createRoleChoice(snapshot, selected, role));
    }
    section.appendChild(fieldset);
    return section;
  }

  private createRoleChoice(
    snapshot: SemanticObjectEditorSnapshot,
    selected: SemanticSelectedVolumeSnapshot,
    role: VolumeRole,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.dataset.volumeRoleChoice = role;
    wrapper.style.cssText = 'display:grid;gap:3px;';
    const matching = selected.roleDecisions.filter((entry) => entry.role === role);
    const decision = matching.length === 1 ? matching[0].decision : undefined;
    const isCurrent = selected.role === role;
    const blockedReason = roleBlockReason(decision, isCurrent, matching.length);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.volumeRole = role;
    button.dataset.volumeId = selected.id;
    button.textContent = roleLabel(role);
    button.setAttribute('aria-pressed', String(isCurrent));
    button.style.cssText = touchButtonStyle;
    if (blockedReason) {
      const reasonId = this.id(`role-${role}-reason`);
      button.disabled = true;
      button.setAttribute('aria-describedby', reasonId);
      const reason = document.createElement('p');
      reason.id = reasonId;
      reason.dataset.roleBlockReason = role;
      reason.textContent = blockedReason;
      reason.style.cssText = mutedTextStyle;
      wrapper.append(button, reason);
      return wrapper;
    }

    button.addEventListener('click', () => {
      const request = freezeRequest<ConvertSemanticVolumeRoleRequest>({
        ...requestGuard(snapshot),
        volumeId: selected.id,
        nextRole: role,
      });
      void this.runOperation(
        `Converting ${selected.name} to ${roleLabel(role)}…`,
        `Converted ${selected.name} to ${roleLabel(role)}.`,
        () => this.adapter.onConvertVolumeRole(request),
      );
    });
    wrapper.appendChild(button);
    return wrapper;
  }

  private createLayerRangeEditor(snapshot: SemanticObjectEditorSnapshot, snapshotBlocked: boolean): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    section.dataset.semanticLayerRangeEditor = 'true';
    section.style.cssText = sectionStyle;
    const heading = document.createElement('h3');
    heading.id = this.id('ranges-heading');
    heading.textContent = 'Height ranges';
    heading.style.cssText = subsectionHeadingStyle;
    section.setAttribute('aria-labelledby', heading.id);
    section.appendChild(heading);

    const ordered = orderRanges(snapshot.layerRanges);
    section.appendChild(this.createRangeList(ordered, snapshot.selectedLayerRange?.id));
    section.appendChild(this.createBoundsForm(snapshot, ordered, 'add', undefined, snapshotBlocked));

    const selection = snapshot.selectedLayerRange;
    const selected = selection ? ordered.find((range) => range.id === selection.id) : undefined;
    if (!selection || !selected) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a height range to edit, split, merge, or delete it.';
      empty.style.cssText = mutedTextStyle;
      section.appendChild(empty);
      return section;
    }

    const selectedHeading = document.createElement('h4');
    selectedHeading.textContent = `Selected ${formatBounds(selected.minZMm, selected.maxZMm)}`;
    selectedHeading.style.cssText = 'margin:4px 0 0;font-size:13px;';
    section.appendChild(selectedHeading);
    section.appendChild(this.createBoundsForm(snapshot, ordered, 'edit', selected, snapshotBlocked));
    section.appendChild(this.createSplitForm(snapshot, selected, snapshotBlocked));
    section.appendChild(this.createMergeControls(snapshot, selected, selection, ordered, snapshotBlocked));
    section.appendChild(this.createDeleteControl(snapshot, selected, snapshotBlocked));
    return section;
  }

  private createRangeList(
    ranges: readonly SemanticLayerRangeSnapshot[],
    selectedId: LayerRangeId | undefined,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    if (ranges.length === 0) {
      const empty = document.createElement('p');
      empty.dataset.layerRangeEmpty = 'true';
      empty.textContent = 'No height ranges are defined.';
      empty.style.cssText = mutedTextStyle;
      return empty;
    }
    const list = document.createElement('ol');
    list.dataset.layerRangeList = 'true';
    list.style.cssText = 'display:grid;gap:4px;margin:0;padding-inline-start:22px;';
    for (const range of ranges) {
      const item = document.createElement('li');
      item.dataset.layerRangeId = range.id;
      item.textContent = formatBounds(range.minZMm, range.maxZMm);
      if (range.id === selectedId) item.setAttribute('aria-current', 'true');
      list.appendChild(item);
    }
    return list;
  }

  private createBoundsForm(
    snapshot: SemanticObjectEditorSnapshot,
    ranges: readonly SemanticLayerRangeSnapshot[],
    operation: 'add' | 'edit',
    selected: SemanticLayerRangeSnapshot | undefined,
    snapshotBlocked: boolean,
  ): HTMLFormElement {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    form.dataset.layerRangeOperation = operation;
    form.style.cssText = fieldsetStyle;
    const heading = document.createElement('h4');
    heading.textContent = operation === 'add' ? 'Add range' : 'Edit boundaries';
    heading.style.cssText = 'margin:0;font-size:13px;';
    form.appendChild(heading);

    const minInput = this.createNumberInput(form, `${operation}-min`, 'Minimum Z (mm)', selected?.minZMm);
    const maxInput = this.createNumberInput(form, `${operation}-max`, 'Maximum Z (mm)', selected?.maxZMm);
    const error = document.createElement('p');
    error.id = this.id(`${operation}-bounds-error`);
    error.dataset.layerRangeValidation = operation;
    error.setAttribute('aria-live', 'polite');
    error.style.cssText = validationStyle;
    minInput.setAttribute('aria-describedby', error.id);
    maxInput.setAttribute('aria-describedby', error.id);
    form.appendChild(error);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.dataset.layerRangeSubmit = operation;
    submit.textContent = operation === 'add' ? 'Add range' : 'Apply boundaries';
    submit.style.cssText = touchButtonStyle;
    form.appendChild(submit);

    let touched = false;
    const update = (): BoundsValidation => {
      const result = validateBounds(
        minInput.value,
        maxInput.value,
        ranges,
        operation === 'edit' ? selected?.id : undefined,
      );
      submit.disabled = snapshotBlocked || !result.valid;
      minInput.setAttribute('aria-invalid', String(touched && !result.valid));
      maxInput.setAttribute('aria-invalid', String(touched && !result.valid));
      error.textContent = touched || (operation === 'edit' && !result.valid) ? result.message : '';
      return result;
    };
    for (const input of [minInput, maxInput]) {
      input.disabled = snapshotBlocked;
      input.addEventListener('input', () => {
        touched = true;
        update();
      });
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      touched = true;
      const result = update();
      if (!result.valid || result.minZMm === undefined || result.maxZMm === undefined || this.pending) return;
      if (operation === 'add') {
        let layerRangeId: LayerRangeId;
        try {
          layerRangeId = this.adapter.createLayerRangeId();
          if (!isStableEntityId(layerRangeId))
            throw new Error(`Allocated layer-range ID ${layerRangeId} is not stable`);
        } catch (errorValue) {
          this.rejectLocally(errorValue);
          return;
        }
        const request = freezeRequest<AddSemanticLayerRangeRequest>({
          ...requestGuard(snapshot),
          layerRangeId,
          minZMm: result.minZMm,
          maxZMm: result.maxZMm,
        });
        void this.runOperation(
          `Adding ${formatBounds(result.minZMm, result.maxZMm)}…`,
          `Added ${formatBounds(result.minZMm, result.maxZMm)}.`,
          () => this.adapter.onAddLayerRange(request),
        );
        return;
      }
      if (!selected) return;
      const request = freezeRequest<EditSemanticLayerRangeRequest>({
        ...requestGuard(snapshot),
        layerRangeId: selected.id,
        minZMm: result.minZMm,
        maxZMm: result.maxZMm,
      });
      void this.runOperation(
        `Editing ${formatBounds(selected.minZMm, selected.maxZMm)}…`,
        `Updated range boundaries to ${formatBounds(result.minZMm, result.maxZMm)}.`,
        () => this.adapter.onEditLayerRange(request),
      );
    });
    update();
    return form;
  }

  private createSplitForm(
    snapshot: SemanticObjectEditorSnapshot,
    selected: SemanticLayerRangeSnapshot,
    snapshotBlocked: boolean,
  ): HTMLFormElement {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    form.dataset.layerRangeOperation = 'split';
    form.style.cssText = fieldsetStyle;
    const heading = document.createElement('h4');
    heading.textContent = 'Split range';
    heading.style.cssText = 'margin:0;font-size:13px;';
    form.appendChild(heading);
    const splitInput = this.createNumberInput(form, 'split-z', 'Split at Z (mm)', undefined);
    splitInput.min = String(selected.minZMm);
    splitInput.max = String(selected.maxZMm);
    const error = document.createElement('p');
    error.id = this.id('split-error');
    error.dataset.layerRangeValidation = 'split';
    error.setAttribute('aria-live', 'polite');
    error.style.cssText = validationStyle;
    splitInput.setAttribute('aria-describedby', error.id);
    form.appendChild(error);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.dataset.layerRangeSubmit = 'split';
    submit.textContent = 'Split range';
    submit.style.cssText = touchButtonStyle;
    form.appendChild(submit);

    let touched = false;
    const update = (): number | undefined => {
      const splitZMm = parseFiniteInput(splitInput.value);
      const valid = splitZMm !== undefined && splitZMm > selected.minZMm && splitZMm < selected.maxZMm;
      submit.disabled = snapshotBlocked || !valid;
      splitInput.setAttribute('aria-invalid', String(touched && !valid));
      error.textContent =
        touched && !valid
          ? `Split height must be strictly inside ${formatBounds(selected.minZMm, selected.maxZMm)}.`
          : '';
      return valid ? splitZMm : undefined;
    };
    splitInput.disabled = snapshotBlocked;
    splitInput.addEventListener('input', () => {
      touched = true;
      update();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      touched = true;
      const splitZMm = update();
      if (splitZMm === undefined || this.pending) return;
      let upperRangeId: LayerRangeId;
      try {
        upperRangeId = this.adapter.createLayerRangeId();
        if (!isStableEntityId(upperRangeId)) throw new Error(`Allocated layer-range ID ${upperRangeId} is not stable`);
      } catch (errorValue) {
        this.rejectLocally(errorValue);
        return;
      }
      const request = freezeRequest<SplitSemanticLayerRangeRequest>({
        ...requestGuard(snapshot),
        layerRangeId: selected.id,
        splitZMm,
        upperRangeId,
      });
      void this.runOperation(`Splitting range at ${formatMm(splitZMm)}…`, `Split range at ${formatMm(splitZMm)}.`, () =>
        this.adapter.onSplitLayerRange(request),
      );
    });
    update();
    return form;
  }

  private createMergeControls(
    snapshot: SemanticObjectEditorSnapshot,
    selected: SemanticLayerRangeSnapshot,
    selection: SemanticSelectedLayerRangeSnapshot,
    ordered: readonly SemanticLayerRangeSnapshot[],
    snapshotBlocked: boolean,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const fieldset = document.createElement('fieldset');
    fieldset.dataset.layerRangeOperation = 'merge';
    fieldset.disabled = snapshotBlocked;
    fieldset.style.cssText = fieldsetStyle;
    const legend = document.createElement('legend');
    legend.textContent = 'Merge range';
    legend.style.cssText = legendStyle;
    fieldset.appendChild(legend);
    fieldset.appendChild(this.createMergeChoice(snapshot, selected, selection.mergePrevious, ordered, 'previous'));
    fieldset.appendChild(this.createMergeChoice(snapshot, selected, selection.mergeNext, ordered, 'next'));
    return fieldset;
  }

  private createMergeChoice(
    snapshot: SemanticObjectEditorSnapshot,
    selected: SemanticLayerRangeSnapshot,
    decision: SemanticLayerRangeMergeDecision,
    ordered: readonly SemanticLayerRangeSnapshot[],
    direction: 'previous' | 'next',
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:grid;gap:3px;';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.layerRangeMerge = direction;
    button.textContent = `Merge with ${direction} range`;
    button.style.cssText = touchButtonStyle;
    const consistencyError = decision.allowed
      ? inspectAllowedMerge(selected.id, decision.otherRangeId, ordered, direction)
      : undefined;
    if (!decision.allowed || consistencyError) {
      const reasonId = this.id(`merge-${direction}-reason`);
      const reason = document.createElement('p');
      reason.id = reasonId;
      reason.dataset.mergeBlockReason = direction;
      reason.textContent = consistencyError ?? (decision.allowed ? '' : decision.reason);
      reason.style.cssText = mutedTextStyle;
      button.disabled = true;
      button.setAttribute('aria-describedby', reasonId);
      wrapper.append(button, reason);
      return wrapper;
    }

    button.dataset.otherRangeId = decision.otherRangeId;
    button.addEventListener('click', () => {
      const request = freezeRequest<MergeSemanticLayerRangesRequest>({
        ...requestGuard(snapshot),
        firstRangeId: selected.id,
        secondRangeId: decision.otherRangeId,
      });
      void this.runOperation(`Merging with the ${direction} range…`, `Merged with the ${direction} range.`, () =>
        this.adapter.onMergeLayerRanges(request),
      );
    });
    wrapper.appendChild(button);
    return wrapper;
  }

  private createDeleteControl(
    snapshot: SemanticObjectEditorSnapshot,
    selected: SemanticLayerRangeSnapshot,
    snapshotBlocked: boolean,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.dataset.layerRangeOperation = 'delete';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.layerRangeDelete = selected.id;
    button.textContent = 'Delete selected range';
    button.disabled = snapshotBlocked;
    button.style.cssText = `${touchButtonStyle}border-color:#ef535088;color:#ffb4ab;`;
    button.addEventListener('click', () => {
      const request = freezeRequest<DeleteSemanticLayerRangeRequest>({
        ...requestGuard(snapshot),
        layerRangeId: selected.id,
      });
      void this.runOperation('Deleting selected range…', 'Deleted selected range.', () =>
        this.adapter.onDeleteLayerRange(request),
      );
    });
    wrapper.appendChild(button);
    return wrapper;
  }

  private createNumberInput(
    parent: HTMLElement,
    suffix: string,
    labelText: string,
    value: number | undefined,
  ): HTMLInputElement {
    const document = this.container.ownerDocument;
    const label = document.createElement('label');
    label.htmlFor = this.id(suffix);
    label.textContent = labelText;
    label.style.cssText = 'display:grid;gap:4px;';
    const input = document.createElement('input');
    input.id = this.id(suffix);
    input.type = 'number';
    input.step = 'any';
    input.inputMode = 'decimal';
    input.dataset.layerRangeInput = suffix;
    input.style.cssText = touchInputStyle;
    if (value !== undefined) input.value = String(value);
    label.appendChild(input);
    parent.appendChild(label);
    return input;
  }

  private async runOperation(
    pendingMessage: string,
    successMessage: string,
    operation: () => MaybePromise,
  ): Promise<void> {
    if (this.pending || !this.root) return;
    this.pending = true;
    this.setStatus('pending', pendingMessage);
    this.setControlsPending(true);
    try {
      await operation();
    } catch (errorValue) {
      if (!this.root) return;
      this.pending = false;
      this.notifyError(errorValue);
      this.setControlsPending(false);
      this.setStatus(
        'error',
        `The guarded operation was rejected; the canonical view was not changed optimistically. ${errorMessage(errorValue)}`,
      );
      return;
    }
    if (!this.root) return;
    this.pending = false;
    this.status = { kind: 'success', message: successMessage };
    try {
      this.refresh();
    } catch (errorValue) {
      this.notifyError(errorValue);
      this.setControlsPending(false);
      this.setStatus(
        'error',
        `The operation returned, but the canonical snapshot could not be reloaded. ${errorMessage(errorValue)}`,
      );
    }
  }

  private rejectLocally(errorValue: unknown): void {
    this.notifyError(errorValue);
    this.setStatus('error', `The operation was not sent. ${errorMessage(errorValue)}`);
  }

  private notifyError(errorValue: unknown): void {
    try {
      this.adapter.onError?.(errorValue);
    } catch {
      // Error reporting must not hide the original adapter failure.
    }
  }

  private setStatus(kind: OperationStatusKind, message: string): void {
    this.status = { kind, message };
    const status = this.statusNode;
    if (!status) return;
    status.dataset.semanticEditorStatus = kind;
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    status.textContent = message;
    status.style.color = kind === 'error' ? '#ffb4ab' : 'var(--oxr-color-text-muted,#a0aab5)';
  }

  private setControlsPending(pending: boolean): void {
    const root = this.root;
    if (!root) return;
    root.setAttribute('aria-busy', String(pending));
    const controls = root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button');
    for (const control of controls) {
      if (pending) {
        if (!control.disabled) {
          control.dataset.semanticPendingDisabled = 'true';
          control.disabled = true;
        }
      } else if (control.dataset.semanticPendingDisabled === 'true') {
        delete control.dataset.semanticPendingDisabled;
        control.disabled = false;
      }
    }
  }

  private id(suffix: string): string {
    return `orcaxr-semantic-editor-${this.instanceId}-${suffix}`;
  }
}

function requestGuard(snapshot: SemanticObjectEditorSnapshot): SemanticEditorRequestGuard {
  return {
    expectedRevision: snapshot.sourceRevision,
    sourceHash: snapshot.sourceHash,
    objectId: snapshot.objectId,
  };
}

function freezeRequest<T extends object>(request: T): Readonly<T> {
  return Object.freeze({ ...request });
}

function roleBlockReason(
  decision: VolumeRoleConversionDecision | undefined,
  isCurrent: boolean,
  matchingDecisionCount: number,
): string | undefined {
  if (matchingDecisionCount !== 1 || !decision) return 'A unique canonical conversion decision was not provided.';
  if (isCurrent || (decision.allowed && decision.noop)) return 'This is the current role; no conversion is needed.';
  return decision.allowed ? undefined : decision.reason;
}

function validateBounds(
  rawMin: string,
  rawMax: string,
  ranges: readonly SemanticLayerRangeSnapshot[],
  excludedId?: LayerRangeId,
): BoundsValidation {
  const minZMm = parseFiniteInput(rawMin);
  const maxZMm = parseFiniteInput(rawMax);
  if (minZMm === undefined || maxZMm === undefined) {
    return { valid: false, message: 'Enter finite minimum and maximum Z values.' };
  }
  if (minZMm < 0 || maxZMm <= minZMm) {
    return { valid: false, message: 'Bounds must satisfy 0 ≤ minimum Z < maximum Z.' };
  }
  const overlap = ranges.find((range) => range.id !== excludedId && minZMm < range.maxZMm && range.minZMm < maxZMm);
  if (overlap) {
    return {
      valid: false,
      message: `${formatBounds(minZMm, maxZMm)} overlaps existing ${formatBounds(overlap.minZMm, overlap.maxZMm)}.`,
    };
  }
  return { valid: true, message: '', minZMm, maxZMm };
}

function parseFiniteInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inspectSnapshot(snapshot: SemanticObjectEditorSnapshot): string | undefined {
  if (!Number.isSafeInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 0) {
    return 'sourceRevision must be a non-negative safe integer.';
  }
  if (snapshot.sourceHash.trim() === '') return 'sourceHash is missing.';
  if (!isStableEntityId(snapshot.objectId)) return `object ID ${snapshot.objectId} is not stable.`;
  if (snapshot.selectedVolume && !isStableEntityId(snapshot.selectedVolume.id)) {
    return `volume ID ${snapshot.selectedVolume.id} is not stable.`;
  }
  const ids = new Set<LayerRangeId>();
  const ordered = orderRanges(snapshot.layerRanges);
  for (const range of ordered) {
    if (!isStableEntityId(range.id)) return `layer-range ID ${range.id} is not stable.`;
    if (ids.has(range.id)) return `layer-range ID ${range.id} is duplicated.`;
    ids.add(range.id);
    if (!Number.isFinite(range.minZMm) || !Number.isFinite(range.maxZMm) || range.minZMm < 0) {
      return `range ${range.id} has non-finite or negative bounds.`;
    }
    if (range.maxZMm <= range.minZMm) return `range ${range.id} does not have positive height.`;
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].minZMm < ordered[index - 1].maxZMm) {
      return `ranges ${ordered[index - 1].id} and ${ordered[index].id} overlap.`;
    }
  }
  if (snapshot.selectedLayerRange && !ids.has(snapshot.selectedLayerRange.id)) {
    return `selected layer range ${snapshot.selectedLayerRange.id} is not owned by this object.`;
  }
  return undefined;
}

function inspectAllowedMerge(
  selectedId: LayerRangeId,
  otherId: LayerRangeId,
  ordered: readonly SemanticLayerRangeSnapshot[],
  direction: 'previous' | 'next',
): string | undefined {
  const selectedIndex = ordered.findIndex((range) => range.id === selectedId);
  const expectedIndex = direction === 'previous' ? selectedIndex - 1 : selectedIndex + 1;
  const otherIndex = ordered.findIndex((range) => range.id === otherId);
  if (selectedIndex < 0 || otherIndex !== expectedIndex) {
    return `The declared ${direction} merge target is not the adjacent canonical range.`;
  }
  const lower = ordered[Math.min(selectedIndex, otherIndex)];
  const upper = ordered[Math.max(selectedIndex, otherIndex)];
  if (!lower || !upper || lower.maxZMm !== upper.minZMm) {
    return `The ${direction} range does not touch the selected range.`;
  }
  return undefined;
}

function orderRanges(ranges: readonly SemanticLayerRangeSnapshot[]): readonly SemanticLayerRangeSnapshot[] {
  return [...ranges].sort(
    (left, right) => left.minZMm - right.minZMm || left.maxZMm - right.maxZMm || left.id.localeCompare(right.id),
  );
}

function formatBounds(minZMm: number, maxZMm: number): string {
  return `${formatMm(minZMm)}–${formatMm(maxZMm)}`;
}

function formatMm(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4, useGrouping: false }).format(value)} mm`;
}

function roleLabel(role: VolumeRole): string {
  switch (role) {
    case 'model':
      return 'Part';
    case 'negative-volume':
      return 'Negative volume';
    case 'parameter-modifier':
      return 'Parameter modifier';
    case 'support-blocker':
      return 'Support blocker';
    case 'support-enforcer':
      return 'Support enforcer';
  }
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

const sectionStyle =
  'display:grid;gap:9px;margin:0;padding:10px;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
  'border-radius:8px;min-width:0;';
const fieldsetStyle =
  'display:grid;gap:7px;margin:0;padding:9px;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
  'border-radius:7px;min-width:0;';
const subsectionHeadingStyle = 'margin:0;font-size:14px;line-height:1.3;';
const legendStyle = 'padding:0 4px;font-weight:650;';
const mutedTextStyle = 'margin:0;color:var(--oxr-color-text-muted,#a0aab5);font-size:12px;';
const validationStyle = 'margin:0;min-height:1.3em;color:#ffb4ab;font-size:12px;';
const touchButtonStyle =
  'min-inline-size:44px;min-block-size:44px;padding:8px 11px;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
  'border-radius:7px;background:var(--oxr-color-surface,#20242b);color:inherit;font:inherit;font-weight:650;' +
  'touch-action:manipulation;';
const touchInputStyle =
  'box-sizing:border-box;min-block-size:44px;width:100%;padding:8px;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
  'border-radius:6px;background:var(--oxr-color-surface,#20242b);color:inherit;font:inherit;';
const alertStyle =
  'margin:0;padding:8px;border:1px solid #ef535066;border-radius:7px;background:#7f1d1d35;color:#ffd9d7;';
