import type { FilamentId } from '../../project/domain/ids';
import { t } from '../../l10n/t';
import type {
  CanonicalFilamentAssignableEntityRef,
  CanonicalFilamentAssignmentSnapshot,
  CanonicalFilamentAssignmentScope,
  CanonicalFilamentOption,
} from '../../workspace/CanonicalWorkspaceController';

type MaybePromise = void | Promise<void>;
type AssignmentChoice = FilamentId | null | undefined;

export interface FilamentAssignmentApplyRequest {
  readonly entities: readonly CanonicalFilamentAssignableEntityRef[];
  /** null removes every selected scope's local override. */
  readonly filamentId: FilamentId | null;
  readonly sourceRevision: number;
  readonly sourceHash: string;
}

/** Projection and command callbacks stay outside the reusable DOM surface. */
export interface FilamentAssignmentSelectorAdapter {
  getSnapshot(): CanonicalFilamentAssignmentSnapshot;
  subscribe?(listener: () => void): () => void;
  onApply(request: FilamentAssignmentApplyRequest): MaybePromise;
  onError?(error: unknown): void;
}

export interface FilamentAssignmentSelectorOptions {
  readonly heading?: string;
}

let selectorSequence = 0;

/** Accessible stable-ID selector for object, part, and height-range assignments. */
export class FilamentAssignmentSelector {
  private readonly instanceId = ++selectorSequence;
  private root?: HTMLElement;
  private snapshot?: CanonicalFilamentAssignmentSnapshot;
  private pendingChoice: AssignmentChoice;
  private currentChoice: AssignmentChoice;
  private fieldset?: HTMLFieldSetElement;
  private applyButton?: HTMLButtonElement;
  private choiceStatus?: HTMLElement;
  private unsubscribe?: () => void;
  private applying = false;
  private errorMessage?: string;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: FilamentAssignmentSelectorAdapter,
    private readonly options: FilamentAssignmentSelectorOptions = {},
  ) {}

  mount(): void {
    if (this.root) return;
    const root = this.container.ownerDocument.createElement('section');
    root.dataset.filamentAssignmentSelector = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-filament-assignment-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text,#fff);' +
      'font:13px/1.4 system-ui,sans-serif;';
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    this.snapshot = this.adapter.getSnapshot();
    this.currentChoice = uniformLocalChoice(this.snapshot.scopes);
    this.pendingChoice = this.currentChoice;
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
    this.snapshot = undefined;
    this.fieldset = undefined;
    this.applyButton = undefined;
    this.choiceStatus = undefined;
  }

  private render(): void {
    const root = this.root;
    const snapshot = this.snapshot;
    if (!root || !snapshot) return;
    const document = root.ownerDocument;
    const fragment = document.createDocumentFragment();

    const heading = document.createElement('h2');
    heading.id = `orcaxr-filament-assignment-heading-${this.instanceId}`;
    heading.textContent = this.options.heading ?? 'Filament assignment';
    heading.style.cssText = 'margin:0;font-size:16px;line-height:1.3;';
    fragment.appendChild(heading);

    const scopeSummary = document.createElement('div');
    scopeSummary.id = `orcaxr-filament-assignment-scopes-${this.instanceId}`;
    scopeSummary.appendChild(this.createScopeSummary(snapshot));
    fragment.appendChild(scopeSummary);

    const blocked = snapshot.scopes.length === 0 || snapshot.unsupportedSelection.length > 0;
    if (snapshot.unsupportedSelection.length > 0) {
      const warning = document.createElement('p');
      warning.dataset.filamentAssignmentBlocked = 'true';
      warning.setAttribute('role', 'alert');
      warning.textContent = `${snapshot.unsupportedSelection.length} selected row${
        snapshot.unsupportedSelection.length === 1 ? '' : 's'
      } cannot receive a filament assignment. Adjust the selection before applying.`;
      warning.style.cssText =
        'margin:0;padding:8px;border:1px solid #ef535066;border-radius:7px;background:#7f1d1d35;color:#ffd9d7;';
      fragment.appendChild(warning);
    } else if (snapshot.scopes.length === 0) {
      const empty = document.createElement('p');
      empty.dataset.filamentAssignmentEmpty = 'true';
      empty.textContent = t(
        'ui.filamentAssignmentSelector.selectOneOrMoreObjects',
        'Select one or more objects, parts, or height ranges to assign a filament.',
      );
      empty.style.cssText = 'margin:0;color:var(--oxr-color-text-muted,#a0aab5);';
      fragment.appendChild(empty);
    }

    const fieldset = document.createElement('fieldset');
    fieldset.disabled = blocked || this.applying;
    fieldset.setAttribute('aria-describedby', scopeSummary.id);
    fieldset.style.cssText =
      'display:grid;gap:8px;margin:0;padding:10px;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
      'border-radius:8px;min-width:0;';
    const legend = document.createElement('legend');
    legend.textContent = t('ui.filamentAssignmentSelector.chooseAssignment', 'Choose assignment');
    legend.style.cssText = 'padding:0 4px;font-weight:650;';
    fieldset.appendChild(legend);
    fieldset.appendChild(this.createInheritChoice(snapshot));

    const physical = snapshot.options.filter((option) => option.kind === 'physical');
    const mixed = snapshot.options.filter((option) => option.kind === 'mixed');
    fieldset.appendChild(this.createOptionGroup('Physical heads', physical));
    if (mixed.length > 0) fieldset.appendChild(this.createOptionGroup('Virtual / mixed filaments', mixed));
    fragment.appendChild(fieldset);
    this.fieldset = fieldset;

    const status = document.createElement('p');
    status.id = `orcaxr-filament-assignment-status-${this.instanceId}`;
    status.dataset.filamentAssignmentStatus = 'true';
    status.setAttribute('role', this.errorMessage ? 'alert' : 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = `margin:0;min-height:1.4em;color:${
      this.errorMessage ? '#ffb4ab' : 'var(--oxr-color-text-muted,#a0aab5)'
    };`;
    fragment.appendChild(status);
    this.choiceStatus = status;

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.dataset.filamentAssignmentApply = 'true';
    apply.textContent = this.applying ? 'Applying…' : 'Apply to selection';
    apply.style.cssText =
      'align-self:flex-end;border:0;border-radius:7px;background:var(--oxr-color-accent,#ffb74d);' +
      'color:var(--oxr-color-on-accent,#17120b);padding:8px 13px;font-weight:700;';
    apply.addEventListener('click', () => void this.apply());
    fragment.appendChild(apply);
    this.applyButton = apply;

    root.replaceChildren(fragment);
    this.updateActionState();
  }

  private createScopeSummary(snapshot: CanonicalFilamentAssignmentSnapshot): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${snapshot.scopes.length} assignable scope${snapshot.scopes.length === 1 ? '' : 's'}`;
    wrapper.appendChild(title);
    if (snapshot.scopes.length === 0) return wrapper;

    const options = new Map(snapshot.options.map((option) => [option.id, option]));
    const list = document.createElement('ul');
    list.dataset.filamentAssignmentScopes = 'true';
    list.style.cssText = 'display:grid;gap:3px;margin:5px 0 0;padding-inline-start:20px;';
    for (const scope of snapshot.scopes) {
      const item = document.createElement('li');
      item.dataset.filamentAssignmentScope = scope.entity.kind;
      const local = scope.localFilamentId ? optionName(options, scope.localFilamentId) : 'Default / inherit';
      const effective = scope.effectiveFilamentId
        ? optionName(options, scope.effectiveFilamentId)
        : 'No effective filament';
      item.textContent = `${scope.label} — local: ${local}; effective: ${effective}`;
      list.appendChild(item);
    }
    wrapper.appendChild(list);
    return wrapper;
  }

  private createInheritChoice(snapshot: CanonicalFilamentAssignmentSnapshot): HTMLElement {
    const document = this.container.ownerDocument;
    const label = document.createElement('label');
    label.dataset.filamentAssignmentOption = 'inherit';
    label.style.cssText = optionCardStyle(this.pendingChoice === null, false);
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `orcaxr-filament-assignment-${this.instanceId}`;
    radio.dataset.filamentAssignmentKind = 'inherit';
    radio.checked = this.pendingChoice === null;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      this.pendingChoice = null;
      this.errorMessage = undefined;
      this.updateActionState();
    });
    label.appendChild(radio);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = t('ui.filamentAssignmentSelector.defaultInherit', 'Default / inherit');
    const detail = document.createElement('span');
    detail.textContent = snapshot.scopes.some((scope) => scope.entity.kind === 'object')
      ? 'Remove local assignments. Objects return to no explicit default; child scopes inherit their object.'
      : 'Remove local assignments so every selected scope inherits its object default.';
    detail.style.cssText = 'display:block;color:var(--oxr-color-text-muted,#a0aab5);font-size:12px;';
    copy.append(name, detail);
    label.appendChild(copy);
    return label;
  }

  private createOptionGroup(titleText: string, options: readonly CanonicalFilamentOption[]): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    const title = document.createElement('h3');
    title.id = `orcaxr-filament-group-${this.instanceId}-${titleText.startsWith('Physical') ? 'physical' : 'mixed'}`;
    title.textContent = titleText;
    title.style.cssText =
      'margin:5px 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;' +
      'color:var(--oxr-color-text-muted,#a0aab5);';
    group.setAttribute('aria-labelledby', title.id);
    group.appendChild(title);
    if (options.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('ui.filamentAssignmentSelector.noConfiguredOptions', 'No configured options.');
      empty.style.cssText = 'margin:0;color:var(--oxr-color-text-muted,#a0aab5);';
      group.appendChild(empty);
      return group;
    }
    for (const option of options) group.appendChild(this.createFilamentChoice(option));
    return group;
  }

  private createFilamentChoice(option: CanonicalFilamentOption): HTMLElement {
    const document = this.container.ownerDocument;
    const selected = this.pendingChoice === option.id;
    const label = document.createElement('label');
    label.dataset.filamentAssignmentOption = option.kind;
    label.dataset.filamentId = option.id;
    label.style.cssText = optionCardStyle(selected, !option.enabled);

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `orcaxr-filament-assignment-${this.instanceId}`;
    radio.value = option.id;
    radio.dataset.filamentAssignmentKind = 'filament';
    radio.dataset.filamentId = option.id;
    radio.checked = selected;
    radio.disabled = !option.enabled;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      this.pendingChoice = option.id;
      this.errorMessage = undefined;
      this.updateActionState();
    });
    label.appendChild(radio);

    const swatch = document.createElement('span');
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.cssText =
      'width:18px;height:18px;flex:0 0 18px;border:1px solid #ffffff66;border-radius:50%;background:#808080;';
    swatch.style.background = option.color;
    label.appendChild(swatch);

    const copy = document.createElement('span');
    copy.style.cssText = 'min-width:0;flex:1;';
    const name = document.createElement('strong');
    name.textContent = option.name;
    name.style.display = 'block';
    copy.appendChild(name);
    const badge = document.createElement('span');
    badge.textContent = optionBadge(option);
    badge.style.cssText = 'display:block;color:var(--oxr-color-text-muted,#a0aab5);font-size:12px;';
    copy.appendChild(badge);
    const metadata = document.createElement('span');
    metadata.textContent = optionMetadata(option);
    metadata.style.cssText = 'display:block;color:var(--oxr-color-text-muted,#a0aab5);font-size:11px;';
    copy.appendChild(metadata);
    const stableId = document.createElement('code');
    stableId.textContent = option.id;
    stableId.style.cssText =
      'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oxr-color-text-muted,#a0aab5);font-size:10px;';
    copy.appendChild(stableId);
    if (option.recipe.length > 0) {
      const recipe = document.createElement('span');
      recipe.dataset.filamentRecipe = 'true';
      recipe.textContent = `Recipe: ${formatRecipe(option)}`;
      recipe.style.cssText = 'display:block;margin-top:2px;font-size:11px;';
      for (const component of option.recipe) {
        const componentId = document.createElement('span');
        componentId.dataset.recipeComponentId = component.filamentId;
        componentId.hidden = true;
        recipe.appendChild(componentId);
      }
      copy.appendChild(recipe);
    }
    if (option.warnings.length > 0) {
      const warnings = document.createElement('ul');
      warnings.dataset.filamentWarnings = 'true';
      warnings.style.cssText = 'margin:3px 0 0;padding-inline-start:17px;color:#ffd18b;font-size:11px;';
      for (const warning of option.warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        warnings.appendChild(item);
      }
      copy.appendChild(warnings);
    }
    label.appendChild(copy);
    return label;
  }

  private updateActionState(): void {
    const snapshot = this.snapshot;
    const fieldset = this.fieldset;
    const button = this.applyButton;
    const status = this.choiceStatus;
    if (!snapshot || !button || !status) return;
    const blocked = snapshot.scopes.length === 0 || snapshot.unsupportedSelection.length > 0;
    const unchanged = choicesEqual(this.pendingChoice, this.currentChoice);
    if (fieldset) fieldset.disabled = blocked || this.applying;
    button.disabled = blocked || this.applying || this.pendingChoice === undefined || unchanged;
    button.setAttribute('aria-disabled', String(button.disabled));
    button.style.opacity = button.disabled ? '0.55' : '1';
    button.textContent = this.applying ? 'Applying…' : 'Apply to selection';
    status.setAttribute('role', this.errorMessage ? 'alert' : 'status');
    status.style.color = this.errorMessage ? '#ffb4ab' : 'var(--oxr-color-text-muted,#a0aab5)';
    for (const label of this.root?.querySelectorAll<HTMLElement>('[data-filament-assignment-option]') ?? []) {
      const id = label.dataset.filamentId;
      const selected = id ? this.pendingChoice === id : this.pendingChoice === null;
      const disabled = label.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled ?? false;
      label.style.cssText = optionCardStyle(selected, disabled);
    }
    status.textContent =
      this.errorMessage ??
      (this.applying
        ? 'Applying one canonical assignment transaction…'
        : this.pendingChoice === undefined
          ? 'Selected scopes currently have multiple local assignments. Choose a destination or inherit.'
          : unchanged
            ? 'No assignment change is pending.'
            : `Ready to update ${snapshot.scopes.length} scope${snapshot.scopes.length === 1 ? '' : 's'} atomically.`);
  }

  private async apply(): Promise<void> {
    const snapshot = this.snapshot;
    const choice = this.pendingChoice;
    if (
      !snapshot ||
      choice === undefined ||
      snapshot.scopes.length === 0 ||
      snapshot.unsupportedSelection.length > 0 ||
      choicesEqual(choice, this.currentChoice) ||
      this.applying
    ) {
      return;
    }
    this.applying = true;
    this.errorMessage = undefined;
    this.updateActionState();
    try {
      await this.adapter.onApply(
        Object.freeze({
          entities: Object.freeze(snapshot.scopes.map((scope) => Object.freeze({ ...scope.entity }))),
          filamentId: choice,
          sourceRevision: snapshot.sourceRevision,
          sourceHash: snapshot.sourceHash,
        }),
      );
      if (!this.root) return;
      this.applying = false;
      this.refresh();
    } catch (error) {
      if (!this.root) return;
      this.applying = false;
      this.errorMessage = boundedError(error);
      this.adapter.onError?.(error);
      this.updateActionState();
    }
  }
}

function uniformLocalChoice(scopes: readonly CanonicalFilamentAssignmentScope[]): AssignmentChoice {
  if (scopes.length === 0) return undefined;
  const first = scopes[0].localFilamentId ?? null;
  return scopes.every((scope) => (scope.localFilamentId ?? null) === first) ? first : undefined;
}

function choicesEqual(left: AssignmentChoice, right: AssignmentChoice): boolean {
  return left === right;
}

function optionName(options: ReadonlyMap<FilamentId, CanonicalFilamentOption>, id: FilamentId): string {
  return options.get(id)?.name ?? `Unavailable filament (${id})`;
}

function optionBadge(option: CanonicalFilamentOption): string {
  if (option.kind === 'physical') {
    return `Physical head${option.toolId === undefined ? '' : ` H-${option.toolId + 1}`}${
      option.enabled ? '' : ' · disabled'
    }`;
  }
  return `Virtual / mixed · ${option.distributionMode ?? 'unknown mode'}${option.enabled ? '' : ' · disabled'}`;
}

function optionMetadata(option: CanonicalFilamentOption): string {
  return [
    option.material ? `Material ${option.material}` : undefined,
    option.presetId ? `Preset ${option.presetId}` : 'No preset ID',
    `Color ${option.color}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function formatRecipe(option: CanonicalFilamentOption): string {
  const total = option.recipe.reduce((sum, component) => sum + component.weight, 0);
  return option.recipe
    .map((component) => {
      const weight = total > 0 ? `${Math.round((component.weight / total) * 1000) / 10}%` : String(component.weight);
      return `${component.name} ${weight}`;
    })
    .join(' + ');
}

function optionCardStyle(selected: boolean, disabled: boolean): string {
  return (
    'display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:7px;border:1px solid ' +
    `${selected ? 'var(--oxr-color-accent,#ffb74d)' : 'var(--oxr-color-stroke,#ffffff1f)'};` +
    `background:${selected ? 'var(--oxr-color-selection,#ffb74d22)' : 'var(--oxr-color-surface,#ffffff0a)'};` +
    `opacity:${disabled ? '0.62' : '1'};cursor:${disabled ? 'not-allowed' : 'pointer'};`
  );
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Assignment failed: ${Array.from(message, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)}`;
}
