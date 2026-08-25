/**
 * XrPanels — what the inspector can show, derived from the registry.
 *
 * The flat shell's sidebar is a stack of named panels. The registry does not
 * model panels — it models actions, and grants `xr-inspector` to every
 * `dom-inspector` action precisely so none of them is silently absent from the
 * headset. So the immersive inspector's panels are the registry's own groups,
 * plus the two surfaces that are more than a list of actions: the canonical
 * Objects tree and the generated settings tree.
 *
 * Deriving the list rather than hand-writing it is what makes the redesign's
 * promise structural: a group that gains an inspector action gains a panel
 * here, and an action added to the flat sidebar is reachable in a headset
 * without an XR change.
 */
import type { ActionRegistry, GroupId } from '../../actions/ActionRegistry';
import { GROUPS } from '../../actions/ActionRegistry';
import { t } from '../../l10n/t';

export type XrPanelId = 'objects' | 'settings' | `group:${GroupId}`;

export interface XrPanelDescriptor {
  readonly id: XrPanelId;
  readonly label: string;
  readonly icon: string;
  /** Inspector actions this panel carries; zero for the two built-in trees. */
  readonly actionCount: number;
}

/** The panel a group opens as. */
export function xrGroupPanelId(group: GroupId): XrPanelId {
  return `group:${group}`;
}

/** The group a `group:` panel id names, or `undefined` for a built-in tree. */
export function xrPanelGroup(id: XrPanelId): GroupId | undefined {
  return id.startsWith('group:') ? (id.slice('group:'.length) as GroupId) : undefined;
}

/**
 * Every panel the immersive inspector can open, in the order it offers them.
 *
 * Objects and Settings come first because they are what an operator is in the
 * inspector for; the groups follow in the registry's own order.
 */
export function xrInspectorPanels(registry: ActionRegistry): readonly XrPanelDescriptor[] {
  const inspector = registry.forSurface('xr-inspector');
  const panels: XrPanelDescriptor[] = [
    { id: 'objects', label: t('ui.xrPanels.objects', 'Objects'), icon: 'scene', actionCount: 0 },
    { id: 'settings', label: t('ui.xrPanels.settings', 'Settings'), icon: 'advanced', actionCount: 0 },
  ];
  for (const group of GROUPS) {
    const count = inspector.filter((action) => action.group === group.id).length;
    if (count === 0) continue;
    panels.push({ id: xrGroupPanelId(group.id), label: group.label, icon: group.icon, actionCount: count });
  }
  return panels;
}
