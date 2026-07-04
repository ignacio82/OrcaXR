/**
 * Assembles every group's actions into one {@link ActionRegistry} — the single
 * catalog both shells and the command palette render from. New capabilities are
 * added by extending a group file under `groups/`, never by editing a shell.
 */
import { ActionRegistry } from './ActionRegistry';
import { sceneActions } from './groups/scene';
import { sliceActions } from './groups/slice';
import { outputActions } from './groups/output';
import { advancedActions } from './groups/advanced';

export function buildRegistry(): ActionRegistry {
  return new ActionRegistry()
    .addAll(sceneActions)
    .addAll(sliceActions)
    .addAll(outputActions)
    .addAll(advancedActions);
}
