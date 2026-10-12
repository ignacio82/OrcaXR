/**
 * How the shells arrange catalogue actions, kept free of any presentation so
 * every shell (DOM, XR and the native one, through the shared core's
 * `orcaxr_project::action_presentation`) arranges them alike:
 *
 *  - {@link paletteMatches}: the command palette's search, in the order given;
 *  - {@link catalogGroups}: a context menu's sections, one per catalogue group
 *    in {@link GROUPS} order, each keeping the order given;
 *  - {@link toolbarRuns}: the model toolbar's runs, a separator wherever the
 *    group changes;
 *  - {@link groupLabel} and {@link menuSectionLabel}: a section's heading and a
 *    menu bar's section, in the operator's language.
 *
 * `ActionPresentationExchange.ts` answers the same questions over canonical
 * JSON, which is how the Rust port is held to these.
 */
import { GROUPS, MENU_SECTIONS, type ActionGroup, type GroupId, type MenuSection } from '../actions/ActionRegistry';
import { t } from '../l10n/t';

/** The text the palette searches: an action's id, its label and its hint, as the shell shows them. */
export interface PaletteSearchable {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * The palette's search: the actions whose label, id or hint contains the
 * query, trimmed, ignoring case (`toLowerCase`, no locale), in the order given.
 * An empty query keeps every action. No ranking beyond that order: the catalog
 * order is the order a person learns.
 */
export function paletteMatches<T extends PaletteSearchable>(actions: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actions];
  return actions.filter(
    (action) =>
      action.label.toLowerCase().includes(q) ||
      action.id.toLowerCase().includes(q) ||
      (action.hint ?? '').toLowerCase().includes(q),
  );
}

/** One section of a grouped menu. */
export interface CatalogGroup<T> {
  readonly group: ActionGroup;
  readonly actions: readonly T[];
}

/**
 * A context menu's sections: the actions partitioned by catalogue group, the
 * groups in {@link GROUPS}' declared order and the actions in the order given (the
 * catalog's, from `forContext`), empty groups left out.
 */
export function catalogGroups<T extends { readonly group: GroupId }>(actions: readonly T[]): CatalogGroup<T>[] {
  const byGroup = new Map<GroupId, T[]>();
  for (const action of actions) {
    const members = byGroup.get(action.group) ?? [];
    members.push(action);
    byGroup.set(action.group, members);
  }
  return GROUPS.filter((group) => byGroup.has(group.id)).map((group) => ({
    group,
    actions: byGroup.get(group.id) ?? [],
  }));
}

/**
 * The model toolbar's runs: consecutive actions of one group, in the order
 * given, so a separator goes in wherever the group changes. A group may come
 * back in a later run.
 */
export function toolbarRuns<T extends { readonly group: GroupId }>(actions: readonly T[]): CatalogGroup<T>[] {
  const runs: { group: ActionGroup; actions: T[] }[] = [];
  for (const action of actions) {
    const last = runs.at(-1);
    if (last && last.group.id === action.group) last.actions.push(action);
    else runs.push({ group: groupOf(action.group), actions: [action] });
  }
  return runs;
}

/**
 * A catalogue group's label in the operator's language: the heading of a
 * context menu's section, the name of an XR inspector panel.
 *
 * The ids are derived from {@link GROUPS} (`actionGroup.<id>.label`) and
 * extracted from it by construction, as the actions' own labels are from the
 * registry, so a menu of translated entries is never headed in English (the
 * headings were English in every language before).
 */
export function groupLabel(id: GroupId): string {
  const group = GROUPS.find((candidate) => candidate.id === id);
  return group ? t(`actionGroup.${group.id}.label`, group.label) : id;
}

/** A menu-bar section's label in the operator's language (`menuSection.<id>.label`, from {@link MENU_SECTIONS}). */
export function menuSectionLabel(id: MenuSection): string {
  const section = MENU_SECTIONS.find((candidate) => candidate.id === id);
  return section ? t(`menuSection.${section.id}.label`, section.label) : id;
}

function groupOf(id: GroupId): ActionGroup {
  const group = GROUPS.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Unknown action group "${id}"`);
  return group;
}
