import { canonicalStringify, cloneJson, cloneProjectState } from './domain/canonical';
import { isStableEntityId, type CustomGcodeId, type PlateId } from './domain/ids';
import type { CustomGcode, CustomGcodeLayerEvent, LayerEventType, ProjectState } from './domain/model';
import { assertValidProjectState } from './domain/validation';
import type { CommandContext, ProjectCommand } from './history/command';

export interface LayerEventDraft {
  readonly id: CustomGcodeId;
  readonly plateId: PlateId;
  readonly type: LayerEventType;
  readonly topZMm: number;
  readonly toolIndex?: number;
  readonly filamentId?: CustomGcodeLayerEvent['filamentId'];
  readonly color?: string;
  readonly message?: string;
  /** Only a `custom` event carries a body; the rest come from the printer profile. */
  readonly code?: string;
}

export type LayerEventPatch = Omit<Partial<LayerEventDraft>, 'id' | 'plateId'>;

/** One authored event as the canonical entry the engine projection reads. */
export function layerEventEntry(draft: LayerEventDraft): CustomGcode {
  const event: CustomGcodeLayerEvent = {
    type: draft.type,
    topZMm: draft.topZMm,
    ...(draft.toolIndex !== undefined ? { toolIndex: draft.toolIndex } : {}),
    ...(draft.filamentId !== undefined ? { filamentId: draft.filamentId } : {}),
    ...(draft.color !== undefined ? { color: draft.color } : {}),
    ...(draft.message !== undefined ? { message: draft.message } : {}),
  };
  return {
    id: draft.id,
    scope: 'plate',
    plateId: draft.plateId,
    // The engine fires these before the layer they name is printed.
    trigger: 'before-layer',
    code: draft.type === 'custom' ? (draft.code ?? '') : '',
    layerEvent: event,
  };
}

/** Plate events in print order; the projection and every UI read this. */
export function plateLayerEvents(state: ProjectState, plateId: PlateId): readonly CustomGcode[] {
  return state.customGcode
    .filter((entry) => entry.layerEvent !== undefined && entry.scope === 'plate' && entry.plateId === plateId)
    .sort((left, right) => (left.layerEvent?.topZMm ?? 0) - (right.layerEvent?.topZMm ?? 0));
}

abstract class LayerEventCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previous?: CustomGcode[];

  protected abstract mutate(state: ProjectState): void;

  isNoop(context: CommandContext): boolean {
    const current = context.project.getSnapshot().state;
    const next = cloneProjectState(current);
    this.mutate(next);
    return canonicalStringify(current.customGcode) === canonicalStringify(next.customGcode);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    this.previous = cloneJson(state.customGcode);
    this.mutate(state);
    // Layer events change what the machine does mid-print; never let an
    // invalid one reach the project store.
    assertValidProjectState(state);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error(`${this.constructor.name} has not been applied`);
    const state = cloneProjectState(context.project.getSnapshot().state);
    state.customGcode = cloneJson(this.previous);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return this.previous ? canonicalStringify(this.previous).length : 1;
  }
}

export class AddLayerEventCommand extends LayerEventCommand {
  readonly type = 'add-layer-event';
  readonly label: string;
  private readonly entry: CustomGcode;

  constructor(draft: LayerEventDraft) {
    super();
    if (!isStableEntityId(draft.id)) throw new Error(`Layer event needs a stable ID, received "${draft.id}"`);
    this.entry = layerEventEntry(draft);
    this.label = `Add ${LABELS[draft.type]}`;
  }

  protected mutate(state: ProjectState): void {
    if (state.customGcode.some((entry) => entry.id === this.entry.id)) {
      throw new Error(`Custom G-code ${this.entry.id} already exists`);
    }
    state.customGcode = [...state.customGcode, cloneJson(this.entry)];
  }
}

export class EditLayerEventCommand extends LayerEventCommand {
  readonly type = 'edit-layer-event';
  readonly label = 'Edit layer event';

  constructor(
    private readonly id: CustomGcodeId,
    private readonly patch: LayerEventPatch,
  ) {
    super();
  }

  protected mutate(state: ProjectState): void {
    const index = state.customGcode.findIndex((entry) => entry.id === this.id && entry.layerEvent);
    if (index < 0) throw new Error(`Unknown layer event ${this.id}`);
    const current = state.customGcode[index];
    const event = current.layerEvent!;
    const next = layerEventEntry({
      id: current.id,
      plateId: current.plateId!,
      type: this.patch.type ?? event.type,
      topZMm: this.patch.topZMm ?? event.topZMm,
      ...pick('toolIndex', this.patch, event),
      ...pick('filamentId', this.patch, event),
      ...pick('color', this.patch, event),
      ...pick('message', this.patch, event),
      code: this.patch.code ?? current.code,
    });
    state.customGcode = state.customGcode.map((entry, position) => (position === index ? next : entry));
  }
}

export class DeleteLayerEventCommand extends LayerEventCommand {
  readonly type = 'delete-layer-event';
  readonly label = 'Delete layer event';

  constructor(private readonly id: CustomGcodeId) {
    super();
  }

  protected mutate(state: ProjectState): void {
    if (!state.customGcode.some((entry) => entry.id === this.id && entry.layerEvent)) {
      throw new Error(`Unknown layer event ${this.id}`);
    }
    state.customGcode = state.customGcode.filter((entry) => entry.id !== this.id);
  }
}

const LABELS: Readonly<Record<LayerEventType, string>> = Object.freeze({
  'color-change': 'colour change',
  pause: 'pause',
  'tool-change': 'tool change',
  template: 'template G-code',
  custom: 'custom G-code',
});

function pick<Key extends 'toolIndex' | 'filamentId' | 'color' | 'message'>(
  key: Key,
  patch: LayerEventPatch,
  event: CustomGcodeLayerEvent,
): Partial<Pick<LayerEventDraft, Key>> {
  const value = key in patch ? patch[key] : event[key];
  return value === undefined ? {} : ({ [key]: value } as Partial<Pick<LayerEventDraft, Key>>);
}
