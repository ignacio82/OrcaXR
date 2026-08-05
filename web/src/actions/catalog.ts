/**
 * Assembles every group's actions into one {@link ActionRegistry} — the single
 * catalog both shells and the command palette render from. New capabilities are
 * added by extending a group file under `groups/`, never by editing a shell.
 */
import { ActionRegistry } from './ActionRegistry';
import { fileActions } from './groups/file';
import { editActions } from './groups/edit';
import { viewActions } from './groups/view';
import { sceneActions } from './groups/scene';
import { gizmoActions } from './groups/gizmos';
import { sliceActions } from './groups/slice';
import { outputActions } from './groups/output';
import { calibrationActions } from './groups/calibration';
import { advancedActions } from './groups/advanced';
import { helpActions } from './groups/help';
import { objectsActions } from './groups/objects';

export function buildRegistry(): ActionRegistry {
  return new ActionRegistry()
    .addAll(fileActions)
    .addAll(editActions)
    .addAll(objectsActions)
    .addAll(viewActions)
    .addAll(sceneActions)
    .addAll(gizmoActions)
    .addAll(sliceActions)
    .addAll(outputActions)
    .addAll(calibrationActions)
    .addAll(advancedActions)
    .addAll(helpActions);
}
