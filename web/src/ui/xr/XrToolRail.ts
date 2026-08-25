/**
 * XrToolRail — the flat shell's model toolbar, under the operator's left hand.
 *
 * Two things about the old rail made it worse than the toolbar it mirrors.
 *
 * It was **icon-only**. At 0.9 m an icon is about a degree and a half of arc
 * with no word beside it, and the difference between "seam paint" and "fuzzy
 * skin" as two small glyphs is not a difference anyone can read. Every button
 * here carries its label.
 *
 * It was **finite by exclusion**. Seven ids were allowed on the rail and every
 * other tool was pushed into a menu, which meant the support, seam and
 * fuzzy-skin painters — three of the four channels `PAINT_TOOL_CHANNELS`
 * declares — were two presses further away than the fourth for no reason the
 * operator could see. The rail now draws every `xr-toolbar` action, grouped the
 * way the flat toolbar groups them, in three columns of 58 mm targets. It is
 * 0.21 m wide because 0.20 m clipped the third group off the bottom.
 *
 * The groups are declared here rather than derived from `action.group`, because
 * the registry's groups are a *catalogue* taxonomy (`scene`, `paint`, `edit`)
 * and a tool rail is ordered by what the hand is doing: move it, paint it,
 * change the mesh, arrange the plate. Anything the registry offers that no
 * group claims is appended under "More", so a new toolbar action appears on the
 * rail without an edit here — the failure mode is an untidy rail, never a
 * missing tool.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';
import { t } from '../../l10n/t';
import { xrIcon } from '../icons';
import { tokens } from '../tokens';
import {
  XR_HIT,
  createXrColumn,
  createXrHeading,
  createXrIconButton,
  createXrRow,
  createXrSurfaceBody,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

interface RailGroup {
  readonly id: string;
  readonly title: () => string;
  readonly actionIds: readonly string[];
}

/**
 * The rail's own order, which is the order the hand works in.
 *
 * Titles resolve through `t()` at draw time rather than being stored as
 * literals: message extraction reads call sites, so an id built from a variable
 * is a label no translator ever sees.
 */
export const XR_RAIL_GROUPS: readonly RailGroup[] = [
  {
    id: 'transform',
    title: () => t('ui.xrToolRail.group.transform', 'Transform'),
    actionIds: [
      'tool_move',
      'tool_rotate',
      'tool_scale',
      'tool_lay_on_face',
      'tool_face_detector',
      'tool_cut',
      'tool_measure',
    ],
  },
  {
    id: 'paint',
    title: () => t('ui.xrToolRail.group.paint', 'Paint'),
    actionIds: ['tool_paint', 'tool_support_paint', 'tool_seam_paint', 'tool_fuzzy_skin', 'tool_smart_paint'],
  },
  {
    id: 'mesh',
    title: () => t('ui.xrToolRail.group.mesh', 'Mesh'),
    actionIds: [
      'tool_hollow',
      'simplify_model',
      'repair_model',
      'split_to_parts',
      'tool_emboss',
      'tool_svg',
      'tool_brim_ears',
    ],
  },
  {
    id: 'plate',
    title: () => t('ui.xrToolRail.group.plate', 'Plate'),
    actionIds: ['arrange_all', 'drop_to_bed', 'delete_models'],
  },
];

/** One swatch in the rail's paint strip; the canonical palette's own entry. */
export interface XrRailSwatch {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly selected: boolean;
}

/** One bounded number the active tool needs, stepped in place. */
export interface XrRailStepper {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit: string;
}

export interface XrToolRailContext {
  readonly registry: ActionRegistry;
  readonly state: Readonly<UiStateShape>;
  readonly activeTool: string | null;
  /**
   * The filament palette, when a paint tool owns the rail.
   *
   * A painter without a colour to paint with is not a tool, so the swatches are
   * on the rail rather than two presses away in a panel — and they are the same
   * canonical palette entries the flat shell paints from, so a spatial pinch
   * assigns the identical stable filament identity.
   */
  readonly swatches?: readonly XrRailSwatch[];
  /**
   * The active tool's own numbers — a brim ear's radius, an SVG part's depth.
   *
   * They used to be rows in a menu three presses from the tool that needed
   * them. A tool's parameter belongs beside the tool.
   */
  readonly steppers?: readonly XrRailStepper[];
  onRun(action: Action): void;
  onSelectSwatch?(id: string): void;
  onStep?(id: string, direction: 1 | -1): void;
}

export interface XrToolRailRender<PanelNode> {
  readonly root: PanelNode;
  /** Ids in draw order, so a test can assert nothing was dropped. */
  readonly actionIds: readonly string[];
  refresh(ctx: XrToolRailContext): void;
}

/**
 * The rail's contents: every toolbar action, in rail order, nothing dropped.
 *
 * Exported because "the rail is the toolbar" is the claim this module makes,
 * and a claim about a set is worth asserting directly.
 */
export function xrRailLayout(registry: ActionRegistry): readonly { title: string; actions: readonly Action[] }[] {
  const toolbar = registry.forSurface('xr-toolbar');
  const byId = new Map(toolbar.map((action) => [action.id, action]));
  const claimed = new Set<string>();
  const groups = XR_RAIL_GROUPS.map((group) => {
    const actions = group.actionIds
      .map((id) => byId.get(id))
      .filter((action): action is Action => action !== undefined);
    for (const action of actions) claimed.add(action.id);
    return { title: group.title(), actions };
  }).filter((group) => group.actions.length > 0);
  const rest = toolbar.filter((action) => !claimed.has(action.id));
  return rest.length > 0 ? [...groups, { title: t('ui.xrToolRail.group.more', 'More'), actions: rest }] : groups;
}

export function renderXrToolRail<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrToolRailContext,
): XrToolRailRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { padding: tokens.space.sm, gap: 6 });
  ui.appendChild(root, body);

  const column = createXrColumn(ui, { gap: 6, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, column);

  const actionIds: string[] = [];
  const buttons: {
    action: Action;
    root: PanelNode;
    icon: ImageNode;
    label: TextNode;
    danger: boolean;
  }[] = [];

  for (const group of xrRailLayout(ctx.registry)) {
    ui.appendChild(column, createXrHeading(ui, group.title));
    const grid = createXrRow(ui, { flexWrap: 'wrap', gap: 5, alignItems: 'flex-start' });
    ui.appendChild(column, grid);
    for (const action of group.actions) {
      const danger = action.id === 'delete_models';
      const button = ui.createPanel({
        width: XR_HIT.target,
        height: XR_HIT.target,
        flexShrink: 0,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        paddingLeft: 2,
        paddingRight: 2,
        cornerRadius: tokens.radius.md,
        fillColor: C.surface,
        strokeWidth: 1,
        strokeColor: danger ? C.dangerSurface : C.stroke,
        onClick: () => ctx.onRun(action),
      });
      const icon = ui.createImage(xrIcon(action.icon), { width: 22, height: 22, color: C.text });
      const label = ui.createText(action.label, {
        fontSize: 9,
        textAlign: 'center',
        color: C.textMuted,
        flexShrink: 1,
      });
      ui.appendImage(button, icon);
      ui.appendChild(button, label);
      ui.appendChild(grid, button);
      buttons.push({ action, root: button, icon, label, danger });
      actionIds.push(action.id);
    }
  }

  // ---- What the active tool needs ---------------------------------------
  const contextual = createXrColumn(ui, { gap: 5, flexShrink: 0, paddingTop: 4 });
  ui.appendChild(body, contextual);

  const drawContextual = (next: XrToolRailContext): void => {
    ui.clearChildren(contextual);
    const swatches = next.swatches ?? [];
    if (swatches.length > 0) {
      ui.appendChild(contextual, createXrHeading(ui, t('ui.xrToolRail.group.colour', 'Colour')));
      const grid = createXrRow(ui, { flexWrap: 'wrap', gap: 4 });
      for (const swatch of swatches) {
        const button = ui.createPanel({
          width: 40,
          height: 40,
          flexShrink: 0,
          cornerRadius: tokens.radius.sm,
          fillColor: swatch.color,
          strokeWidth: swatch.selected ? 3 : 1,
          strokeColor: swatch.selected ? C.text : C.stroke,
          justifyContent: 'center',
          alignItems: 'center',
          onClick: () => next.onSelectSwatch?.(swatch.id),
        });
        // The number is drawn on the swatch because two filaments can be the
        // same colour, and a palette that only differs by hue is unusable to a
        // colour-blind operator.
        ui.appendChild(button, ui.createText(swatch.label, { fontSize: 11, fontWeight: 'bold', color: C.onAccent }));
        ui.appendChild(grid, button);
      }
      ui.appendChild(contextual, grid);
    }
    for (const stepper of next.steppers ?? []) {
      const row = createXrRow(ui, {
        gap: 4,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 3,
        paddingBottom: 3,
        cornerRadius: tokens.radius.sm,
        fillColor: C.surfaceDisabled,
        flexWrap: 'wrap',
      });
      ui.appendChild(
        row,
        ui.createText(stepper.label, { fontSize: 10, color: C.textMuted, flexGrow: 1, flexShrink: 1 }),
      );
      const controls = createXrRow(ui, { width: 'auto', gap: 3, flexShrink: 0 });
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'minus',
          size: 28,
          iconSize: 12,
          onClick: () => next.onStep?.(stepper.id, -1),
        }).root,
      );
      ui.appendChild(
        controls,
        ui.createText(`${stepper.value}${stepper.unit ? ` ${stepper.unit}` : ''}`, {
          fontSize: 11,
          color: C.text,
          flexShrink: 0,
        }),
      );
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'plus',
          size: 28,
          iconSize: 12,
          onClick: () => next.onStep?.(stepper.id, 1),
        }).root,
      );
      ui.appendChild(row, controls);
      ui.appendChild(contextual, row);
    }
  };

  const apply = (next: XrToolRailContext): void => {
    for (const button of buttons) {
      const availability = next.registry.availability(button.action, 'xr-toolbar', next.state);
      const enabled = availability.state === 'enabled';
      const selected = button.action.tool !== undefined && button.action.tool === next.activeTool;
      ui.setPanelProperties(button.root, {
        fillColor: !enabled ? C.surfaceDisabled : selected ? C.warnSurface : C.surface,
        strokeColor: selected ? C.accent : button.danger ? C.dangerSurface : C.stroke,
        opacity: enabled ? 1 : 0.5,
      });
      ui.setImageColor(button.icon, !enabled ? C.textMuted : button.danger ? C.danger : C.text);
      ui.setTextProperties(button.label, {
        color: !enabled ? C.textMuted : selected ? C.accentSoft : button.danger ? C.danger : C.textMuted,
      });
    }
    drawContextual(next);
  };
  apply(ctx);

  return { root: body, actionIds, refresh: apply };
}
