import { MAX_PROJECT_PLATES } from '../../project/commands';
import { isStableEntityId, type PlateId } from '../../project/domain/ids';

type MaybePromise = void | Promise<void>;

export const PLATE_MANAGER_LIMIT = MAX_PROJECT_PLATES;
export const PLATE_MANAGER_NAME_LIMIT = 120;

export interface PlateManagerPlate {
  readonly id: PlateId;
  readonly name: string;
  /** Canonical included/excluded metadata; this is not a slice-readiness claim. */
  readonly printable: boolean;
}

/** Ordered, immutable projection consumed by the DOM surface. */
export interface PlateManagerSnapshot {
  readonly sourceRevision: number;
  readonly activePlateId: PlateId;
  readonly plates: readonly PlateManagerPlate[];
}

export interface PlateManagerTargetRequest {
  readonly plateId: PlateId;
  readonly sourceRevision: number;
}

export interface PlateManagerRenameRequest extends PlateManagerTargetRequest {
  readonly previousName: string;
  readonly nextName: string;
}

export interface PlateManagerReorderRequest {
  /** A frozen, complete permutation of the snapshot's plate IDs. */
  readonly orderedPlateIds: readonly PlateId[];
  readonly sourceRevision: number;
}

export interface PlateManagerPrintableRequest extends PlateManagerTargetRequest {
  readonly printable: boolean;
}

/**
 * Canonical commands and stale-revision policy remain outside this reusable
 * projection. An adapter should reject requests whose source revision is stale.
 */
export interface PlateManagerAdapter {
  getSnapshot(): PlateManagerSnapshot;
  subscribe?(listener: () => void): () => void;
  onActivate(request: PlateManagerTargetRequest): MaybePromise;
  onRename(request: PlateManagerRenameRequest): MaybePromise;
  onDuplicate(request: PlateManagerTargetRequest): MaybePromise;
  onDelete(request: PlateManagerTargetRequest): MaybePromise;
  onReorder(request: PlateManagerReorderRequest): MaybePromise;
  onPrintableChange(request: PlateManagerPrintableRequest): MaybePromise;
  onError?(error: unknown): void;
}

export interface PlateManagerOptions {
  readonly heading?: string;
  readonly listLabel?: string;
}

type PlateControl =
  | 'primary'
  | 'printable'
  | 'rename'
  | 'duplicate'
  | 'delete'
  | 'move-earlier'
  | 'move-later'
  | 'rename-input'
  | 'rename-save'
  | 'rename-cancel';

interface FocusTarget {
  readonly plateId: PlateId;
  readonly control: PlateControl;
}

interface RenderOptions {
  readonly restoreFocus?: boolean;
}

const MUTATION_BUTTON_STYLE =
  'box-sizing:border-box;min-width:44px;min-height:44px;border:1px solid var(--oxr-color-stroke);' +
  'border-radius:7px;background:var(--oxr-surface);color:inherit;padding:7px 10px;' +
  'font:inherit;cursor:pointer;';
const MUTED_TEXT_STYLE = 'color:var(--oxr-color-text-muted);font-size:12px;';
let plateManagerSequence = 0;

/** Accessible, responsive DOM manager for an ordered canonical plate snapshot. */
export class PlateManager {
  private readonly instanceId = ++plateManagerSequence;
  private root?: HTMLElement;
  private snapshot?: PlateManagerSnapshot;
  private focusedPlateId?: PlateId;
  private focusTarget?: FocusTarget;
  private renamingPlateId?: PlateId;
  private renameDraft = '';
  private renameValidation?: string;
  private busyLabel?: string;
  private mutationError?: string;
  private snapshotError?: string;
  private unsubscribe?: () => void;
  private restoreFocusAfterRender = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: PlateManagerAdapter,
    private readonly options: PlateManagerOptions = {},
  ) {}

  mount(): void {
    if (this.root) return;
    const root = this.container.ownerDocument.createElement('section');
    root.dataset.plateManager = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-plate-manager-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text);' +
      'font:13px/1.4 system-ui,sans-serif;';
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    try {
      const next = immutableSnapshot(this.adapter.getSnapshot());
      this.snapshot = next;
      this.snapshotError = undefined;
      this.reconcileStableIds(next);
    } catch (error) {
      this.snapshot = undefined;
      this.snapshotError = `Plate data is unavailable: ${errorMessage(error)}`;
      this.reportError(error);
    }
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
    this.snapshot = undefined;
    this.focusedPlateId = undefined;
    this.focusTarget = undefined;
    this.renamingPlateId = undefined;
  }

  private reconcileStableIds(snapshot: PlateManagerSnapshot): void {
    const ids = new Set(snapshot.plates.map((plate) => plate.id));
    if (!this.focusedPlateId || !ids.has(this.focusedPlateId)) this.focusedPlateId = snapshot.activePlateId;
    if (this.focusTarget && !ids.has(this.focusTarget.plateId)) {
      this.focusTarget = { plateId: this.focusedPlateId, control: 'primary' };
    }
    if (this.renamingPlateId && !ids.has(this.renamingPlateId)) {
      this.renamingPlateId = undefined;
      this.renameDraft = '';
      this.renameValidation = undefined;
    }
  }

  private render(options: RenderOptions = {}): void {
    const root = this.root;
    if (!root) return;
    const document = root.ownerDocument;
    const hadFocus = root.contains(document.activeElement);
    this.restoreFocusAfterRender ||= options.restoreFocus === true || hadFocus;
    root.setAttribute('aria-busy', this.busyLabel ? 'true' : 'false');

    const fragment = document.createDocumentFragment();
    const heading = document.createElement('h2');
    heading.id = `orcaxr-plate-manager-heading-${this.instanceId}`;
    heading.textContent = this.options.heading ?? 'Plates';
    heading.style.cssText = 'margin:0;font-size:16px;line-height:1.3;';
    fragment.appendChild(heading);

    const status = document.createElement('p');
    status.id = `orcaxr-plate-manager-status-${this.instanceId}`;
    status.dataset.plateManagerStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = `margin:0;min-height:1.4em;${MUTED_TEXT_STYLE}`;
    status.textContent = this.statusText();
    fragment.appendChild(status);

    const visibleError = this.snapshotError ?? this.mutationError;
    if (visibleError) {
      const alert = document.createElement('p');
      alert.dataset.plateManagerError = 'true';
      alert.setAttribute('role', 'alert');
      alert.setAttribute('aria-live', 'assertive');
      alert.textContent = visibleError;
      alert.style.cssText =
        'margin:0;padding:8px;border:1px solid var(--oxr-danger);border-radius:7px;background:var(--oxr-danger-surface);color:var(--oxr-danger);';
      fragment.appendChild(alert);
    }

    const snapshot = this.snapshot;
    if (snapshot) fragment.appendChild(this.createPlateList(snapshot, status.id));
    root.replaceChildren(fragment);
    this.restoreRememberedFocus();
  }

  private statusText(): string {
    if (this.busyLabel) return this.busyLabel;
    if (!this.snapshot) return 'No valid plate snapshot is available.';
    const count = this.snapshot.plates.length;
    const base = `${count} of ${PLATE_MANAGER_LIMIT} plates.`;
    if (count === PLATE_MANAGER_LIMIT) return `${base} Plate limit reached; delete a plate before duplicating.`;
    if (count === 1) return `${base} The final plate cannot be deleted.`;
    return base;
  }

  private createPlateList(snapshot: PlateManagerSnapshot, statusId: string): HTMLOListElement {
    const document = this.container.ownerDocument;
    const list = document.createElement('ol');
    list.dataset.plateManagerList = 'true';
    list.setAttribute('aria-label', this.options.listLabel ?? 'Project plates');
    list.setAttribute('aria-describedby', statusId);
    list.style.cssText = 'display:grid;min-width:0;gap:8px;margin:0;padding:0;list-style:none;';
    snapshot.plates.forEach((plate, index) => list.appendChild(this.createPlateRow(plate, index, snapshot)));
    return list;
  }

  private createPlateRow(plate: PlateManagerPlate, index: number, snapshot: PlateManagerSnapshot): HTMLLIElement {
    const document = this.container.ownerDocument;
    const active = plate.id === snapshot.activePlateId;
    const row = document.createElement('li');
    row.dataset.plateManagerPlate = plate.id;
    row.dataset.active = String(active);
    row.style.cssText =
      'display:flex;min-width:0;flex-wrap:wrap;align-items:stretch;gap:8px;padding:8px;' +
      `border:1px solid ${active ? 'var(--oxr-color-accent,var(--oxr-warn))' : 'var(--oxr-color-stroke,var(--oxr-stroke-strong))'};` +
      'border-radius:9px;background:var(--oxr-color-bg-sunken,#0003);';

    if (this.renamingPlateId === plate.id) {
      row.appendChild(this.createRenameEditor(plate));
    } else {
      const primary = document.createElement('button');
      primary.type = 'button';
      primary.dataset.plateControl = 'primary';
      primary.dataset.plateId = plate.id;
      primary.setAttribute('aria-pressed', String(active));
      if (active) primary.setAttribute('aria-current', 'true');
      primary.setAttribute('aria-label', `${active ? 'Active plate' : 'Activate plate'}: ${plate.name}`);
      primary.setAttribute('aria-keyshortcuts', 'F2 Delete Control+ArrowUp Control+ArrowDown');
      primary.tabIndex = plate.id === this.focusedPlateId ? 0 : -1;
      primary.disabled = Boolean(this.busyLabel);
      primary.style.cssText =
        'display:flex;min-width:160px;min-height:48px;flex:1 1 180px;align-items:center;gap:9px;' +
        'border:0;border-radius:7px;background:transparent;color:inherit;padding:6px 8px;text-align: start;font:inherit;';
      const ordinal = document.createElement('span');
      ordinal.textContent = String(index + 1);
      ordinal.setAttribute('aria-hidden', 'true');
      ordinal.style.cssText =
        'display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;border-radius:50%;' +
        'background:var(--oxr-color-bg-raised,#ffffff12);font-weight:750;';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:0;overflow-wrap:anywhere;';
      const name = document.createElement('strong');
      name.textContent = plate.name;
      const state = document.createElement('span');
      state.textContent = `${active ? 'Active' : 'Inactive'} · ${plate.printable ? 'Included for printing' : 'Excluded from printing'}`;
      state.style.cssText = `display:block;${MUTED_TEXT_STYLE}`;
      label.append(name, state);
      primary.append(ordinal, label);
      this.rememberFocus(primary, plate.id, 'primary');
      primary.addEventListener('click', () => void this.activate(plate.id));
      primary.addEventListener('keydown', (event) => this.handlePrimaryKeydown(event, plate.id));
      row.appendChild(primary);
    }

    row.appendChild(this.createPlateControls(plate, index, snapshot));
    return row;
  }

  private createPlateControls(plate: PlateManagerPlate, index: number, snapshot: PlateManagerSnapshot): HTMLElement {
    const document = this.container.ownerDocument;
    const controls = document.createElement('div');
    controls.dataset.plateControls = plate.id;
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', `Actions for ${plate.name}`);
    controls.style.cssText =
      'display:flex;min-width:0;flex:1 1 300px;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;';

    const printable = document.createElement('label');
    printable.style.cssText =
      'box-sizing:border-box;display:flex;min-height:44px;align-items:center;gap:7px;padding:6px 9px;' +
      'border:1px solid var(--oxr-color-stroke);border-radius:7px;cursor:pointer;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = plate.printable;
    checkbox.disabled = Boolean(this.busyLabel);
    checkbox.dataset.plateControl = 'printable';
    checkbox.dataset.plateId = plate.id;
    checkbox.setAttribute('aria-label', `Include ${plate.name} for printing`);
    checkbox.style.cssText = 'width:22px;height:22px;margin:0;';
    this.rememberFocus(checkbox, plate.id, 'printable');
    checkbox.addEventListener('change', () => void this.changePrintable(plate.id, checkbox.checked));
    const printableCopy = document.createElement('span');
    printableCopy.textContent = plate.printable ? 'Included' : 'Excluded';
    printable.append(checkbox, printableCopy);
    controls.appendChild(printable);

    controls.appendChild(
      this.actionButton(plate, 'rename', 'Rename', () => this.beginRename(plate.id), Boolean(this.busyLabel)),
    );
    controls.appendChild(
      this.actionButton(
        plate,
        'move-earlier',
        'Move up',
        () => void this.reorder(plate.id, -1),
        Boolean(this.busyLabel) || index === 0,
      ),
    );
    controls.appendChild(
      this.actionButton(
        plate,
        'move-later',
        'Move down',
        () => void this.reorder(plate.id, 1),
        Boolean(this.busyLabel) || index === snapshot.plates.length - 1,
      ),
    );
    controls.appendChild(
      this.actionButton(
        plate,
        'duplicate',
        'Duplicate',
        () => void this.duplicate(plate.id),
        Boolean(this.busyLabel) || snapshot.plates.length >= PLATE_MANAGER_LIMIT,
        snapshot.plates.length >= PLATE_MANAGER_LIMIT
          ? `The ${PLATE_MANAGER_LIMIT}-plate limit has been reached`
          : undefined,
      ),
    );
    controls.appendChild(
      this.actionButton(
        plate,
        'delete',
        'Delete',
        () => void this.deletePlate(plate.id),
        Boolean(this.busyLabel) || snapshot.plates.length === 1,
        snapshot.plates.length === 1 ? 'The final plate cannot be deleted' : undefined,
      ),
    );
    return controls;
  }

  private actionButton(
    plate: PlateManagerPlate,
    control: Extract<PlateControl, 'rename' | 'duplicate' | 'delete' | 'move-earlier' | 'move-later'>,
    copy: string,
    activate: () => void,
    disabled: boolean,
    reason?: string,
  ): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.plateControl = control;
    button.dataset.plateId = plate.id;
    button.textContent = copy;
    button.disabled = disabled;
    button.style.cssText = MUTATION_BUTTON_STYLE;
    button.setAttribute('aria-label', `${copy} ${plate.name}`);
    if (reason) button.title = reason;
    this.rememberFocus(button, plate.id, control);
    button.addEventListener('click', activate);
    return button;
  }

  private createRenameEditor(plate: PlateManagerPlate): HTMLFormElement {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    form.dataset.plateRenameForm = plate.id;
    form.style.cssText =
      'display:flex;min-width:160px;flex:1 1 300px;flex-wrap:wrap;align-items:flex-end;gap:6px;padding:2px;';
    const field = document.createElement('label');
    field.style.cssText = 'display:grid;min-width:140px;flex:1 1 170px;gap:3px;';
    const label = document.createElement('span');
    label.textContent = `Rename ${plate.name}`;
    label.style.cssText = MUTED_TEXT_STYLE;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = this.renameDraft;
    input.maxLength = PLATE_MANAGER_NAME_LIMIT;
    input.autocomplete = 'off';
    input.dataset.plateControl = 'rename-input';
    input.dataset.plateId = plate.id;
    input.setAttribute('aria-label', `New name for ${plate.name}`);
    input.setAttribute('aria-invalid', String(Boolean(this.renameValidation)));
    input.style.cssText =
      'box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:7px;background:var(--oxr-color-bg-sunken,#0006);color:inherit;padding:7px 9px;font:inherit;';
    input.addEventListener('input', () => {
      this.renameDraft = input.value;
      if (this.renameValidation) {
        this.renameValidation = undefined;
        input.setAttribute('aria-invalid', 'false');
        form.querySelector('[data-plate-rename-error]')?.remove();
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.cancelRename(plate.id);
    });
    this.rememberFocus(input, plate.id, 'rename-input');
    field.append(label, input);
    form.appendChild(field);

    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save';
    save.dataset.plateControl = 'rename-save';
    save.dataset.plateId = plate.id;
    save.disabled = Boolean(this.busyLabel);
    save.style.cssText = MUTATION_BUTTON_STYLE;
    this.rememberFocus(save, plate.id, 'rename-save');
    form.appendChild(save);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.dataset.plateControl = 'rename-cancel';
    cancel.dataset.plateId = plate.id;
    cancel.disabled = Boolean(this.busyLabel);
    cancel.style.cssText = MUTATION_BUTTON_STYLE;
    this.rememberFocus(cancel, plate.id, 'rename-cancel');
    cancel.addEventListener('click', () => this.cancelRename(plate.id));
    form.appendChild(cancel);

    if (this.renameValidation) {
      const validation = document.createElement('span');
      validation.dataset.plateRenameError = 'true';
      validation.setAttribute('role', 'alert');
      validation.textContent = this.renameValidation;
      validation.style.cssText = 'flex-basis:100%;color:var(--oxr-danger);font-size:12px;';
      form.appendChild(validation);
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.commitRename(plate.id);
    });
    return form;
  }

  private rememberFocus(element: HTMLElement, plateId: PlateId, control: PlateControl): void {
    element.addEventListener('focus', () => {
      this.focusedPlateId = plateId;
      this.focusTarget = { plateId, control };
    });
  }

  private restoreRememberedFocus(): void {
    if (!this.restoreFocusAfterRender || !this.root || !this.snapshot) return;
    const remembered = this.focusTarget;
    let target = remembered ? this.findControl(remembered) : undefined;
    if (!target || isDisabledControl(target)) {
      target = this.findControl({ plateId: this.focusedPlateId ?? this.snapshot.activePlateId, control: 'primary' });
    }
    if (!target || isDisabledControl(target)) return;
    target.focus();
    this.restoreFocusAfterRender = false;
  }

  private findControl(target: FocusTarget): HTMLElement | undefined {
    if (!this.root) return undefined;
    return [...this.root.querySelectorAll<HTMLElement>('[data-plate-control][data-plate-id]')].find(
      (element) => element.dataset.plateId === target.plateId && element.dataset.plateControl === target.control,
    );
  }

  private focusPrimary(plateId: PlateId): void {
    if (!this.snapshot?.plates.some((plate) => plate.id === plateId)) return;
    this.focusedPlateId = plateId;
    this.focusTarget = { plateId, control: 'primary' };
    for (const primary of this.root?.querySelectorAll<HTMLButtonElement>('[data-plate-control="primary"]') ?? []) {
      primary.tabIndex = primary.dataset.plateId === plateId ? 0 : -1;
    }
    this.findControl(this.focusTarget)?.focus();
  }

  private handlePrimaryKeydown(event: KeyboardEvent, plateId: PlateId): void {
    const snapshot = this.snapshot;
    if (!snapshot || this.busyLabel) return;
    const index = snapshot.plates.findIndex((plate) => plate.id === plateId);
    if (index < 0) return;
    const direction = keyDirection(event.key);
    if ((event.ctrlKey || event.metaKey) && direction !== 0) {
      event.preventDefault();
      void this.reorder(plateId, direction);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && direction !== 0) {
      event.preventDefault();
      const target = snapshot.plates[clamp(index + direction, 0, snapshot.plates.length - 1)];
      if (target) this.focusPrimary(target.id);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      const first = snapshot.plates[0];
      if (first) this.focusPrimary(first.id);
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = snapshot.plates.at(-1);
      if (last) this.focusPrimary(last.id);
    } else if (event.key === 'F2') {
      event.preventDefault();
      this.beginRename(plateId);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void this.deletePlate(plateId);
    }
  }

  private beginRename(plateId: PlateId): void {
    const plate = this.snapshot?.plates.find((candidate) => candidate.id === plateId);
    if (!plate || this.busyLabel) return;
    this.focusedPlateId = plateId;
    this.renamingPlateId = plateId;
    this.renameDraft = plate.name;
    this.renameValidation = undefined;
    this.focusTarget = { plateId, control: 'rename-input' };
    this.render({ restoreFocus: true });
  }

  private cancelRename(plateId: PlateId): void {
    if (this.renamingPlateId !== plateId) return;
    this.renamingPlateId = undefined;
    this.renameDraft = '';
    this.renameValidation = undefined;
    this.focusTarget = { plateId, control: 'primary' };
    this.render({ restoreFocus: true });
  }

  private async commitRename(plateId: PlateId): Promise<void> {
    const snapshot = this.snapshot;
    const plate = snapshot?.plates.find((candidate) => candidate.id === plateId);
    if (!snapshot || !plate || this.busyLabel) return;
    const nextName = this.renameDraft.trim();
    const validation = validateName(nextName);
    if (validation) {
      this.renameValidation = validation;
      this.focusTarget = { plateId, control: 'rename-input' };
      this.render({ restoreFocus: true });
      return;
    }
    if (nextName === plate.name) {
      this.cancelRename(plateId);
      return;
    }
    const request: PlateManagerRenameRequest = Object.freeze({
      plateId,
      previousName: plate.name,
      nextName,
      sourceRevision: snapshot.sourceRevision,
    });
    this.renamingPlateId = undefined;
    this.renameValidation = undefined;
    this.focusTarget = { plateId, control: 'primary' };
    await this.execute(
      'Renaming plate…',
      'rename plate',
      () => this.adapter.onRename(request),
      () => {
        if (!this.snapshot?.plates.some((candidate) => candidate.id === plateId)) return;
        this.renamingPlateId = plateId;
        this.renameDraft = nextName;
        this.focusTarget = { plateId, control: 'rename-input' };
      },
    );
  }

  private async activate(plateId: PlateId): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.activePlateId === plateId || this.busyLabel) return;
    await this.execute('Activating plate…', 'activate plate', () =>
      this.adapter.onActivate(targetRequest(plateId, snapshot.sourceRevision)),
    );
  }

  private async duplicate(plateId: PlateId): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.busyLabel) return;
    if (snapshot.plates.length >= PLATE_MANAGER_LIMIT) {
      this.mutationError = `Cannot duplicate a plate: the ${PLATE_MANAGER_LIMIT}-plate limit has been reached.`;
      this.render({ restoreFocus: true });
      return;
    }
    await this.execute('Duplicating plate…', 'duplicate plate', () =>
      this.adapter.onDuplicate(targetRequest(plateId, snapshot.sourceRevision)),
    );
  }

  private async deletePlate(plateId: PlateId): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.busyLabel) return;
    if (snapshot.plates.length === 1) {
      this.mutationError = 'The final plate cannot be deleted.';
      this.render({ restoreFocus: true });
      return;
    }
    const index = snapshot.plates.findIndex((plate) => plate.id === plateId);
    if (index < 0) return;
    const previousFocus = this.focusedPlateId;
    const fallback = snapshot.plates[index + 1] ?? snapshot.plates[index - 1];
    if (fallback) {
      this.focusedPlateId = fallback.id;
      this.focusTarget = { plateId: fallback.id, control: 'primary' };
    }
    await this.execute(
      'Deleting plate…',
      'delete plate',
      () => this.adapter.onDelete(targetRequest(plateId, snapshot.sourceRevision)),
      () => {
        if (previousFocus && this.snapshot?.plates.some((plate) => plate.id === previousFocus)) {
          this.focusedPlateId = previousFocus;
          this.focusTarget = { plateId: previousFocus, control: 'primary' };
        }
      },
    );
  }

  private async reorder(plateId: PlateId, direction: -1 | 1): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.busyLabel) return;
    const index = snapshot.plates.findIndex((plate) => plate.id === plateId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= snapshot.plates.length) return;
    const orderedPlateIds = snapshot.plates.map((plate) => plate.id);
    [orderedPlateIds[index], orderedPlateIds[destination]] = [orderedPlateIds[destination], orderedPlateIds[index]];
    const request: PlateManagerReorderRequest = Object.freeze({
      orderedPlateIds: Object.freeze(orderedPlateIds),
      sourceRevision: snapshot.sourceRevision,
    });
    this.focusedPlateId = plateId;
    await this.execute('Reordering plates…', 'reorder plates', () => this.adapter.onReorder(request));
  }

  private async changePrintable(plateId: PlateId, printable: boolean): Promise<void> {
    const snapshot = this.snapshot;
    const plate = snapshot?.plates.find((candidate) => candidate.id === plateId);
    if (!snapshot || !plate || plate.printable === printable || this.busyLabel) return;
    const request: PlateManagerPrintableRequest = Object.freeze({
      plateId,
      printable,
      sourceRevision: snapshot.sourceRevision,
    });
    await this.execute('Updating plate inclusion…', 'update plate inclusion', () =>
      this.adapter.onPrintableChange(request),
    );
  }

  private async execute(
    busyLabel: string,
    errorAction: string,
    operation: () => MaybePromise,
    onFailure?: () => void,
  ): Promise<void> {
    if (this.busyLabel) return;
    this.busyLabel = busyLabel;
    this.mutationError = undefined;
    this.restoreFocusAfterRender = true;
    this.render();
    try {
      await operation();
      this.busyLabel = undefined;
      this.refresh();
    } catch (error) {
      this.busyLabel = undefined;
      this.mutationError = `Could not ${errorAction}: ${errorMessage(error)}`;
      onFailure?.();
      this.reportError(error);
      this.render({ restoreFocus: true });
    }
  }

  private reportError(error: unknown): void {
    try {
      this.adapter.onError?.(error);
    } catch {
      // Error reporting must not hide the original failure or break the surface.
    }
  }
}

function immutableSnapshot(snapshot: PlateManagerSnapshot): PlateManagerSnapshot {
  if (!Number.isSafeInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 0) {
    throw new Error('sourceRevision must be a non-negative safe integer');
  }
  if (!Array.isArray(snapshot.plates) || snapshot.plates.length === 0) {
    throw new Error('a project must contain at least one plate');
  }
  if (snapshot.plates.length > PLATE_MANAGER_LIMIT) {
    throw new Error(`a project cannot contain more than ${PLATE_MANAGER_LIMIT} plates`);
  }
  const ids = new Set<PlateId>();
  const plates = snapshot.plates.map((plate, index) => {
    if (!isStableEntityId(plate.id)) throw new Error(`plate ${index + 1} does not have a stable entity ID`);
    if (ids.has(plate.id)) throw new Error(`plate ID ${plate.id} occurs more than once`);
    ids.add(plate.id);
    const name = plate.name.trim();
    const validation = validateName(name);
    if (validation) throw new Error(`plate ${plate.id}: ${validation}`);
    if (typeof plate.printable !== 'boolean') throw new Error(`plate ${plate.id} has no printable flag`);
    return Object.freeze({ id: plate.id, name, printable: plate.printable });
  });
  if (!ids.has(snapshot.activePlateId)) throw new Error('activePlateId does not identify a plate in the snapshot');
  return Object.freeze({
    sourceRevision: snapshot.sourceRevision,
    activePlateId: snapshot.activePlateId,
    plates: Object.freeze(plates),
  });
}

function validateName(value: string): string | undefined {
  if (value.length === 0) return 'Plate name cannot be empty.';
  if (value.length > PLATE_MANAGER_NAME_LIMIT) {
    return `Plate name cannot exceed ${PLATE_MANAGER_NAME_LIMIT} characters.`;
  }
  if (/\p{Cc}/u.test(value)) return 'Plate name cannot contain control characters.';
  return undefined;
}

function targetRequest(plateId: PlateId, sourceRevision: number): PlateManagerTargetRequest {
  return Object.freeze({ plateId, sourceRevision });
}

function keyDirection(key: string): -1 | 0 | 1 {
  if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isDisabledControl(element: HTMLElement): boolean {
  return 'disabled' in element && (element as HTMLButtonElement | HTMLInputElement).disabled;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Unknown error';
}
