/**
 * The hosts' contract for arranging catalogue actions (`ActionPresentation.ts`):
 * each request and reply is a canonical JSON document, every answer comes from
 * the production helpers, and the shared Rust core answers the same requests
 * (`orcaxr_project::action_presentation`).
 *
 * - `commandPaletteExchange`: `{"actions":[{"hint"?,"id","label"}],"query"}`
 *   → `{"matches":[index]}`, the palette's search over the actions as the
 *   shell shows them, by their positions in the request.
 * - `actionGroupsExchange`: `{"actions":[id],"layout":"context"|"toolbar"}` →
 *   `{"groups":[{"actions":[index],"group","label"}]}`, a context menu's
 *   sections or the toolbar's runs, each with the catalogue group's id and
 *   label.
 *
 * A malformed request, or an action the catalogue does not have, is refused as
 * `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { ActionRegistry, GroupId } from '../actions/ActionRegistry';
import { catalogGroups, paletteMatches, toolbarRuns, type CatalogGroup } from './ActionPresentation';
import { buildRegistry } from '../actions/catalog';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}
function object(value: Json | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) invalid();
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

/** The palette's search over the request's actions. */
export function commandPaletteExchange(requestJson: string): string {
  const request = object(read(requestJson), ['actions', 'query']);
  const query = text(request.query);
  const actions = list(request.actions).map((entry, index) => {
    const fields = object(entry, ['id', 'label'], ['hint']);
    return {
      index,
      id: text(fields.id),
      label: text(fields.label),
      ...(fields.hint === undefined ? {} : { hint: text(fields.hint) }),
    };
  });
  return canonicalStringify({ matches: paletteMatches(actions, query).map((action) => action.index) });
}

let catalog: ActionRegistry | undefined;

/** A context menu's sections or the toolbar's runs over the request's actions. */
export function actionGroupsExchange(requestJson: string): string {
  const request = object(read(requestJson), ['actions', 'layout']);
  const layout = text(request.layout);
  if (layout !== 'context' && layout !== 'toolbar') invalid();
  catalog ??= buildRegistry();
  const registry = catalog;
  const actions = list(request.actions).map((entry, index) => {
    const action = registry.get(text(entry));
    if (!action) invalid();
    return { index, group: action.group as GroupId };
  });
  const groups: CatalogGroup<{ index: number; group: GroupId }>[] =
    layout === 'context' ? catalogGroups(actions) : toolbarRuns(actions);
  return canonicalStringify({
    groups: groups.map(({ group, actions: members }) => ({
      actions: members.map((member) => member.index),
      group: group.id,
      label: group.label,
    })),
  });
}
