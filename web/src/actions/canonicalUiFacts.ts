import type { ProjectState } from '../project/domain/model';
import type { CommandHistorySnapshot } from '../project/history/commandBus';
import type { SelectionSnapshot } from '../project/selection';
import type { UiStateShape } from './UiState';

/** The registry facts that only the canonical session decides. */
export type CanonicalUiFacts = Readonly<
  Pick<
    UiStateShape,
    'modelCount' | 'plateCount' | 'hasSelection' | 'hasInstanceSelection' | 'canUndo' | 'canRedo' | 'dirty'
  >
>;

/**
 * Read the registry's project facts from one canonical boundary, so every
 * shell — and the native core, which ports this — enables the same actions for
 * the same project. Models are the instances on the active plate.
 */
export function canonicalUiFacts(
  state: Readonly<ProjectState>,
  selection: Readonly<SelectionSnapshot>,
  history: Readonly<CommandHistorySnapshot>,
): CanonicalUiFacts {
  const active = state.plates.find((plate) => plate.id === state.activePlateId);
  return Object.freeze({
    modelCount: active ? active.objects.reduce((count, object) => count + object.instances.length, 0) : 0,
    plateCount: state.plates.length,
    hasSelection: selection.refs.length > 0,
    hasInstanceSelection: selection.primary?.kind === 'instance',
    canUndo: history.undoCount > 0,
    canRedo: history.redoCount > 0,
    dirty: history.dirtyCategories.length > 0,
  });
}
