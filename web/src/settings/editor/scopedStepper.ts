/**
 * Scoped settings without a keyboard (P6.5).
 *
 * P6.5 asks that project, plate, object, part and height-range overrides share
 * one draft and one validation across desktop, touch and XR. Two of those three
 * surfaces were real: the DOM panel types into a field, and the touch shell uses
 * the same panel. XR had nothing at all, because every path into a setting ended
 * at a text input, and the acceptance test stood in for the missing surface by
 * handing the shared editor a value a stepper *would* have produced.
 *
 * This is that surface's engine. It holds no DOM and no headset types — it owns
 * the target being edited, the {@link SettingsDraftEditor} bound to that target,
 * and the rows a spatial shell renders. What it deliberately does not own is the
 * commit: it hands the editor's commit to the same adapter the DOM panel applies
 * through, so the two surfaces cannot drift into two write paths. That is the
 * whole claim P6.5 makes, expressed as a structure rather than a promise.
 *
 * Two rules keep it honest:
 *
 * - **Every field the DOM offers is listed**, using the same query, so a setting
 *   cannot exist on one surface and be missing on the other. A row that cannot
 *   be stepped says why instead of disappearing — an operator who cannot find a
 *   setting cannot tell "absent" from "not supported here".
 * - **A step is the editor's, not this file's.** The value goes in as a draft
 *   and comes out of `commit()`, so an XR press is validated by exactly the code
 *   that validates a typed character.
 */

import { EngineOptionCatalog } from '../generated/loader';
import type { SettingScope } from '../generated/settingScopes';
import type { EngineGuiSurface } from '../generated/types';
import { SettingsDraftEditor } from './SettingsDraftEditor';
import { enumChoicesFor } from './codec';
import { STEP_REFUSAL_REASON, stepSettingValue } from './stepper';
import type {
  SettingsDraftCommit,
  SettingsEditorMode,
  SettingsEnumChoice,
  SettingsTechnology,
  SettingsValueMap,
} from './types';

/**
 * Which upstream tab supplies the controls for a scope.
 *
 * Every model scope reads from the process tab: upstream's `TabPrintModel`
 * reuses the print tab's own pages and simply narrows which options it shows.
 * A plate is the exception — its handful of options are laid out on the plate
 * dialog and appear nowhere else.
 */
export function guiSurfaceForScope(scope: SettingScope): EngineGuiSurface {
  return scope === 'plate' ? 'plate' : 'process';
}

/** One addressable node, named the way a person reads the scene. */
export interface ScopedStepperTarget {
  readonly id: string;
  readonly scope: SettingScope;
  readonly label: string;
  readonly path: string;
  readonly overrideCount: number;
}

/**
 * The mutation seam, structurally identical to the DOM panel's adapter.
 *
 * Same shape on purpose: the shell hands this controller the very adapter the
 * DOM settings panel already uses, so "one commit path" is a fact about the
 * object graph rather than a convention two files agree to follow.
 */
export interface ScopedStepperSnapshot {
  readonly revision: number;
  readonly sourceHash: string;
  readonly inherited: SettingsValueMap;
  readonly overrides: SettingsValueMap;
}

export interface ScopedStepperAdapter {
  load(): ScopedStepperSnapshot | Promise<ScopedStepperSnapshot>;
  subscribe?(listener: () => void): () => void;
  apply(request: {
    readonly expectedRevision: number;
    readonly sourceHash: string;
    readonly mode: SettingsEditorMode;
    readonly technology: SettingsTechnology;
    readonly commit: SettingsDraftCommit;
  }): ScopedStepperSnapshot | Promise<ScopedStepperSnapshot>;
}

/**
 * What kind of control a row needs.
 *
 * A stepper is not the only editor a headset can draw, and pretending it was is
 * what limited the immersive settings surface to a handful of rows. A boolean
 * wants a switch, an enumeration wants a list, and a number wants a keypad as
 * well as a pair of arrows — the shell needs to be told which, and the engine
 * option's own definition already knows.
 */
export type ScopedStepperRowKind = 'numeric' | 'bool' | 'enum' | 'text' | 'read-only';

export interface ScopedStepperRow {
  readonly fieldId: string;
  readonly key: string;
  readonly label: string;
  readonly group: string;
  /** Serialized effective value, exactly as the DOM panel displays it. */
  readonly value: string;
  readonly unit: string;
  /** True when this node stores the value rather than inheriting it. */
  readonly overridden: boolean;
  readonly steppable: boolean;
  /** Present when `steppable` is false: why this surface will not offer it. */
  readonly reason?: string;
  readonly kind: ScopedStepperRowKind;
  /** Every value an enumeration offers, in the order upstream declares them. */
  readonly choices: readonly SettingsEnumChoice[];
  /** Declared bounds, when the definition has them; a keypad enforces these. */
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer: boolean;
  /**
   * Whether an arbitrary value may be written to this row.
   *
   * `steppable` and `typeable` are different questions with different answers.
   * An unbounded float cannot be stepped — the increment would be a guess — but
   * it can perfectly well be typed, and refusing to let a headset type it is
   * exactly the gap the keypad was built to close. A read-only option is
   * neither.
   */
  readonly typeable: boolean;
}

export interface ScopedStepperView {
  readonly status: 'loading' | 'ready' | 'error';
  readonly targetIndex: number;
  readonly targetCount: number;
  readonly targetLabel: string;
  readonly scope: SettingScope;
  readonly rows: readonly ScopedStepperRow[];
  /**
   * Fields the generated schema cannot support at all — a bad default, a codec
   * the bridge does not implement. The DOM panel renders them disabled for the
   * same reason; this surface counts them instead of drawing ninety-four rows
   * nobody can act on, and says so rather than letting the list look complete.
   */
  readonly unavailable: number;
  readonly message?: string;
}

/** The narrow face a spatial shell needs; the controller implements it. */
export interface ScopedStepperSurface {
  getView(): ScopedStepperView;
  cycleTarget(direction: 1 | -1): void;
  selectTarget(targetId: string): void;
  step(fieldId: string, direction: 1 | -1): void;
  /**
   * Write one exact value, as the keypad and the enum list produce.
   *
   * It takes the same path a step takes — `setDraft` then `commit` then the
   * shared adapter — so a value entered in a headset is validated by precisely
   * the code that validates a typed character on a screen, and is refused the
   * same way. Nothing here decides what is legal.
   */
  setValue(fieldId: string, raw: string): void;
}

export interface ScopedStepperOptions {
  readonly loadCatalog: () => Promise<EngineOptionCatalog>;
  readonly listTargets: () => readonly ScopedStepperTarget[];
  readonly adapterFor: (targetId: string) => ScopedStepperAdapter;
  /** Called whenever {@link ScopedSettingsStepper.view} would return something new. */
  readonly onChange: () => void;
  readonly onError?: (error: unknown) => void;
  readonly mode?: SettingsEditorMode;
  readonly technology?: SettingsTechnology;
}

const EMPTY_VIEW: ScopedStepperView = Object.freeze({
  status: 'loading',
  targetIndex: 0,
  targetCount: 0,
  targetLabel: 'Project',
  scope: 'project' as SettingScope,
  rows: Object.freeze([]),
  unavailable: 0,
});

export class ScopedSettingsStepper implements ScopedStepperSurface {
  private readonly mode: SettingsEditorMode;
  private readonly technology: SettingsTechnology;
  private catalog: EngineOptionCatalog | null = null;
  private editor: SettingsDraftEditor | null = null;
  private snapshot: ScopedStepperSnapshot | null = null;
  private adapter: ScopedStepperAdapter | null = null;
  private unsubscribe: (() => void) | undefined;
  private selectedId = 'project';
  private view: ScopedStepperView = EMPTY_VIEW;
  /** Serializes presses: each step reads the snapshot the previous one wrote. */
  private queue: Promise<void> = Promise.resolve();
  private loading = false;
  private disposed = false;

  constructor(private readonly options: ScopedStepperOptions) {
    this.mode = options.mode ?? 'simple';
    this.technology = options.technology ?? 'fff';
  }

  /**
   * The current rows, always answerable.
   *
   * A spatial shell renders synchronously inside a frame, so this never waits;
   * the first call starts the load and returns the loading view, and `onChange`
   * brings the shell back once there is something to draw.
   */
  getView(): ScopedStepperView {
    if (!this.disposed && !this.editor && !this.loading) this.enqueue(() => this.reload());
    return this.view;
  }

  /**
   * Resolves once every queued load and press has been applied.
   *
   * Presses are serialized rather than concurrent — each one must read the
   * snapshot the previous one wrote, or its guard is stale before it is sent —
   * so there is a real queue, and a caller that needs to know the project has
   * caught up (a test, a shell closing down) can wait for it.
   */
  whenIdle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /**
   * Edit a named node, if the project still has it.
   *
   * Used to follow a selection: pointing at a model in a headset is a far
   * better way to choose what to edit than cycling past every plate and part.
   * An id the project no longer has is ignored rather than throwing, because a
   * selection can outlive the node it named — a deleted object should leave the
   * panel where it was, not break it.
   */
  selectTarget(targetId: string): void {
    if (targetId === this.selectedId) return;
    if (!this.safeTargets().some((target) => target.id === targetId)) return;
    this.selectedId = targetId;
    this.editor = null;
    this.snapshot = null;
    this.enqueue(() => this.reload());
  }

  /** Move to the next or previous addressable node, wrapping at the ends. */
  cycleTarget(direction: 1 | -1): void {
    const targets = this.safeTargets();
    if (targets.length === 0) return;
    const index = targets.findIndex((target) => target.id === this.selectedId);
    const from = index === -1 ? 0 : index;
    const next = targets[(from + direction + targets.length) % targets.length];
    if (next.id === this.selectedId) return;
    this.selectedId = next.id;
    this.editor = null;
    this.snapshot = null;
    this.enqueue(() => this.reload());
  }

  /**
   * One press on a row.
   *
   * The stepped value goes through `setDraft`/`commit`, so the same validation a
   * typed character gets runs here, and the same adapter applies the result.
   */
  step(fieldId: string, direction: 1 | -1): void {
    this.enqueue(() => this.runStep(fieldId, direction));
  }

  /** One exact value, from a keypad, a switch, or a list of choices. */
  setValue(fieldId: string, raw: string): void {
    this.enqueue(() => this.runSetValue(fieldId, raw));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => this.fail(error));
  }

  private async runSetValue(fieldId: string, raw: string): Promise<void> {
    if (this.disposed) return;
    const editor = this.editor;
    const snapshot = this.snapshot;
    const adapter = this.adapter;
    if (!editor || !snapshot || !adapter) return;
    const state = editor.getFieldState(fieldId);
    if (state.field.definition.presentation.readonly.value) {
      this.publish({ ...this.view, message: STEP_REFUSAL_REASON['read-only'] });
      return;
    }
    editor.setDraft(fieldId, raw);
    // The editor validates the draft; an invalid one is reported in place
    // rather than sent to the adapter, which is what the DOM panel does with a
    // badly typed character.
    const issues = editor.getFieldState(fieldId).issues;
    if (issues.length > 0) {
      editor.setDraft(fieldId, state.serializedValue ?? '');
      this.publish({ ...this.view, message: issues[0].message });
      return;
    }
    const commit = editor.commit();
    const next = await adapter.apply({
      expectedRevision: snapshot.revision,
      sourceHash: snapshot.sourceHash,
      mode: this.mode,
      technology: this.technology,
      commit,
    });
    this.adopt(next);
  }

  private async runStep(fieldId: string, direction: 1 | -1): Promise<void> {
    if (this.disposed) return;
    const editor = this.editor;
    const snapshot = this.snapshot;
    const adapter = this.adapter;
    if (!editor || !snapshot || !adapter) return;
    const state = editor.getFieldState(fieldId);
    const current = state.draftSerialized ?? state.serializedValue ?? '';
    const outcome = stepSettingValue(state.field.definition, current, direction);
    if (outcome.value === null) {
      // A refusal is shown, not swallowed: the row already says the setting is
      // not steppable, and a press that did nothing without saying why reads as
      // a broken control.
      this.publish({ ...this.view, message: STEP_REFUSAL_REASON[outcome.refusal ?? 'not-numeric'] });
      return;
    }
    editor.setDraft(fieldId, outcome.value);
    const commit = editor.commit();
    const next = await adapter.apply({
      expectedRevision: snapshot.revision,
      sourceHash: snapshot.sourceHash,
      mode: this.mode,
      technology: this.technology,
      commit,
    });
    this.adopt(next);
  }

  private async reload(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    const targetId = this.selectedId;
    try {
      if (!this.catalog) this.catalog = await this.options.loadCatalog();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      const adapter = this.options.adapterFor(targetId);
      // The target may have been cycled again while the catalog was loading;
      // the later choice wins rather than the earlier one landing on top of it.
      if (this.selectedId !== targetId || this.disposed) return;
      this.adapter = adapter;
      this.unsubscribe = adapter.subscribe?.(() => {
        if (this.selectedId === targetId) this.enqueue(() => this.refreshFromAuthority(targetId));
      });
      this.adopt(await adapter.load(), targetId);
    } catch (error) {
      this.fail(error);
    } finally {
      this.loading = false;
    }
  }

  /** Re-read the authority after someone else changed the project. */
  private async refreshFromAuthority(targetId: string): Promise<void> {
    const adapter = this.adapter;
    if (!adapter || this.disposed) return;
    try {
      const next = await adapter.load();
      if (this.selectedId === targetId) this.adopt(next, targetId);
    } catch (error) {
      this.fail(error);
    }
  }

  private adopt(snapshot: ScopedStepperSnapshot, targetId = this.selectedId): void {
    const catalog = this.catalog;
    if (!catalog || this.disposed) return;
    const target = this.targetFor(targetId);
    const scope = target?.scope ?? 'project';
    this.snapshot = snapshot;
    this.editor = new SettingsDraftEditor(catalog, {
      mode: this.mode,
      technology: this.technology,
      guiSurface: guiSurfaceForScope(scope),
      // The project scope stores the whole config rather than an override map,
      // so it is the one target the editor is left unscoped for — exactly as the
      // DOM panel does it.
      ...(scope === 'project' ? {} : { scope }),
      inherited: snapshot.inherited,
      overrides: snapshot.overrides,
    });
    this.publish(this.build(scope, targetId));
  }

  private build(scope: SettingScope, targetId: string): ScopedStepperView {
    const editor = this.editor!;
    const targets = this.safeTargets();
    const index = Math.max(
      0,
      targets.findIndex((entry) => entry.id === targetId),
    );
    // The same query the DOM panel runs, so neither surface can hold a setting
    // the other does not.
    const fields = editor.query({
      mode: this.mode,
      technology: this.technology,
      guiSurface: guiSurfaceForScope(scope),
      ...(scope === 'project' ? {} : { scope }),
      includeUnavailable: true,
      includeUnknownApplicability: true,
    });
    const rows: ScopedStepperRow[] = [];
    let unavailable = 0;
    for (const field of fields) {
      // A field the schema cannot support is unavailable on every surface, not
      // withheld from this one, so it is counted rather than drawn: a stepper
      // row that can never move is worse than a stated number.
      if (field.support.status === 'unavailable') {
        unavailable += 1;
        continue;
      }
      const state = editor.getFieldState(field.id);
      const value = state.serializedValue ?? '';
      // Steppability is asked of the stepper itself rather than re-derived here,
      // so one rule decides what a press may reach on every surface.
      const outcome = stepSettingValue(field.definition, value, 1);
      const reason = outcome.value === null ? STEP_REFUSAL_REASON[outcome.refusal ?? 'not-numeric'] : undefined;
      const definition = field.definition;
      const readOnly = definition.presentation.readonly.value;
      const choices = enumChoicesFor(definition);
      const numeric = ['coFloat', 'coInt', 'coPercent', 'coFloatOrPercent'].includes(definition.storage.optionType);
      const kind: ScopedStepperRowKind = readOnly
        ? 'read-only'
        : choices.length > 0
          ? 'enum'
          : definition.storage.optionType === 'coBool'
            ? 'bool'
            : numeric && definition.storage.shape === 'scalar'
              ? 'numeric'
              : 'text';
      const minimum = definition.constraints.min.value;
      const maximum = definition.constraints.max.value;
      rows.push({
        fieldId: field.id,
        key: field.key,
        label: field.label,
        group: groupLabel(field),
        value,
        unit: field.unit ?? '',
        overridden: state.hasLocalOverride,
        steppable: reason === undefined,
        ...(reason ? { reason } : {}),
        kind,
        choices,
        ...(minimum === null ? {} : { minimum }),
        ...(maximum === null ? {} : { maximum }),
        integer: definition.storage.optionType === 'coInt',
        typeable: !readOnly,
      });
    }
    const target = targets[index];
    return {
      status: 'ready',
      targetIndex: index,
      targetCount: targets.length,
      targetLabel: target ? target.path : 'Project',
      scope,
      rows,
      unavailable,
    };
  }

  private targetFor(id: string): ScopedStepperTarget | undefined {
    return this.safeTargets().find((target) => target.id === id);
  }

  /**
   * The node list, tolerant of a shell that is still starting.
   *
   * Listing targets reads canonical project state, which throws before the
   * workspace has one. A settings surface that crashed the whole panel because
   * it opened a frame early would be worse than one that says "loading".
   */
  private safeTargets(): readonly ScopedStepperTarget[] {
    try {
      return this.options.listTargets();
    } catch {
      return [];
    }
  }

  private publish(view: ScopedStepperView): void {
    this.view = view;
    if (!this.disposed) this.options.onChange();
  }

  private fail(error: unknown): void {
    this.options.onError?.(error);
    this.publish({
      ...this.view,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Where upstream puts the field, or the metadata category when it puts it
 * nowhere. A blank group label is a real placement with no heading — the plate
 * dialog is like this — so the scope's own name stands in rather than an empty
 * header.
 */
function groupLabel(field: {
  primaryGuiLocation?: { group: { label: string }; tab: { label: string } };
  category: string;
}): string {
  const location = field.primaryGuiLocation;
  if (!location) return field.category || 'Other';
  return location.group.label || location.tab.label || field.category || 'Other';
}
