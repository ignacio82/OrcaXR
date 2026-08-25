/**
 * XrObjectsPanel — the canonical Objects hierarchy, in the headset.
 *
 * The immersive shell used to show a flat row per top-level model, which is not
 * what the project contains. A print is objects, and under them volumes,
 * modifiers, negative parts, support enforcers and blockers, per-node settings
 * and height ranges — and an operator who cannot see that structure in a
 * headset cannot select a modifier to move it or a height range to edit it.
 *
 * Nothing about the tree is decided here. It is the same
 * {@link buildObjectTreeView} projection the DOM {@link ObjectsPanel} renders,
 * from the same canonical snapshot, with the same expansion and filter
 * semantics — so a row that exists on a screen exists in the headset, at the
 * same depth, with the same badges. The only thing this file owns is how a row
 * looks at 0.95 m.
 */
import type { VolumeRole } from '../../project/domain/model';
import {
  buildObjectTreeView,
  type ObjectTreeEntityRef,
  type ObjectTreeProjection,
  type ObjectTreeRowKey,
  type ObjectTreeSelectionSnapshot,
  type ObjectTreeVisibleRow,
} from '../../project/objects';
import { t } from '../../l10n/t';
import { xrIcon } from '../icons';
import { tokens } from '../tokens';
import { XR_TYPE, createXrColumn, createXrField, createXrRow, createXrTextButton } from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

/** How far one level of nesting steps in, in layout pixels. */
const INDENT = 16;

/** One glyph per canonical volume role, so a modifier does not read as a part. */
const VOLUME_ROLE_ICONS: Readonly<Record<VolumeRole, string>> = {
  model: 'cube',
  'parameter-modifier': 'modifier',
  'negative-volume': 'negative_part',
  'support-enforcer': 'support_enforcer',
  'support-blocker': 'support_blocker',
};

export interface XrObjectsPanelContext {
  readonly projection: ObjectTreeProjection;
  readonly selection: ObjectTreeSelectionSnapshot;
  readonly expandedKeys: ReadonlySet<ObjectTreeRowKey>;
  readonly filterQuery: string;
  /** Row actions for whatever is selected, drawn as a footer. */
  readonly selectionActions: readonly { readonly id: string; readonly label: string; readonly enabled: boolean }[];
  onToggleExpanded(key: ObjectTreeRowKey): void;
  onSelect(entity: ObjectTreeEntityRef, key: ObjectTreeRowKey): void;
  onEditFilter(): void;
  onRunSelectionAction(id: string): void;
}

export interface XrObjectsPanelRender<PanelNode> {
  readonly root: PanelNode;
  /** Row keys in draw order; what the tests and automation read. */
  readonly rowKeys: readonly ObjectTreeRowKey[];
}

/** The glyph for a row kind, using the icons both shells already vendor. */
function rowIcon(row: ObjectTreeVisibleRow): string {
  switch (row.kind) {
    case 'plate':
      return 'plate';
    case 'object':
      return 'cube';
    case 'volume':
      return VOLUME_ROLE_ICONS[row.indicators.volumeRole ?? 'model'];
    case 'layer-range':
    case 'layer-group':
      return 'height_range';
    case 'settings':
      return 'settings_import';
    case 'error':
      return 'bug';
    default:
      return 'scene';
  }
}

export function renderXrObjectsPanel<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrObjectsPanelContext,
): XrObjectsPanelRender<PanelNode> {
  const body = createXrColumn(ui, { gap: tokens.space.sm, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(root, body);

  const header = createXrRow(ui, { gap: 6, flexShrink: 0 });
  const filter = createXrField(ui, {
    value: ctx.filterQuery,
    placeholder: t('ui.xrObjectsPanel.filter', 'Filter objects'),
    icon: 'search',
    onClick: () => ctx.onEditFilter(),
  });
  ui.appendChild(header, filter.root);
  ui.appendChild(body, header);

  const view = buildObjectTreeView(ctx.projection, {
    expandedKeys: ctx.expandedKeys,
    filterQuery: ctx.filterQuery,
    selection: ctx.selection,
  });

  const list = createXrColumn(ui, { gap: 2, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);

  if (view.rows.length === 0) {
    ui.appendChild(
      list,
      ui.createText(t('ui.xrObjectsPanel.empty', 'Nothing on this plate yet.'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
  }

  const rowKeys: ObjectTreeRowKey[] = [];
  for (const row of view.rows) {
    const selected = row.accessibility.selected;
    const line = createXrRow(ui, {
      minHeight: 34,
      marginLeft: (row.accessibility.level - 1) * INDENT,
      paddingLeft: 6,
      paddingRight: 6,
      gap: 6,
      cornerRadius: tokens.radius.sm,
      fillColor: selected ? C.warnSurface : '#00000000',
      strokeWidth: 1,
      strokeColor: selected ? C.accent : '#00000000',
      onClick: () => {
        if (row.entity) ctx.onSelect(row.entity, row.key);
      },
    });

    // The twisty is its own target: expanding a node and selecting it are
    // different intentions, and a headset cannot express the difference with a
    // modifier key the way a screen can.
    const expandable = row.childrenKeys.length > 0;
    const twisty = ui.createPanel({
      width: 20,
      height: 26,
      flexShrink: 0,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 4,
      fillColor: '#00000000',
      onClick: expandable ? () => ctx.onToggleExpanded(row.key) : undefined,
    });
    ui.appendChild(
      twisty,
      ui.createText(expandable ? (row.accessibility.expanded ? '⌄' : '›') : '', {
        fontSize: XR_TYPE.micro,
        color: C.textMuted,
      }),
    );
    ui.appendChild(line, twisty);

    ui.appendImage(
      line,
      ui.createImage(xrIcon(rowIcon(row)), {
        width: 16,
        height: 16,
        flexShrink: 0,
        color: selected ? C.accentSoft : C.textMuted,
      }),
    );

    ui.appendChild(
      line,
      ui.createText(row.label, {
        fontSize: row.accessibility.level === 1 ? XR_TYPE.dense : XR_TYPE.caption,
        fontWeight: row.accessibility.level === 1 ? 'bold' : 'normal',
        color: row.indicators.printable === false ? C.textMuted : C.text,
        flexGrow: 1,
        flexShrink: 1,
      }),
    );

    const filament = row.indicators.filament;
    if (filament) {
      const badge = createXrRow(ui, {
        width: 'auto',
        flexShrink: 0,
        gap: 4,
        paddingLeft: 5,
        paddingRight: 5,
        paddingTop: 2,
        paddingBottom: 2,
        cornerRadius: 5,
        fillColor: C.surface,
        opacity: filament.inherited ? 0.6 : 1,
      });
      ui.appendChild(badge, ui.createPanel({ width: 8, height: 8, cornerRadius: 4, fillColor: filament.color }));
      ui.appendChild(badge, ui.createText(filament.name, { fontSize: XR_TYPE.tag, color: C.text }));
      ui.appendChild(line, badge);
    }
    if (row.indicators.printable === false) {
      ui.appendChild(
        line,
        ui.createText(t('ui.xrObjectsPanel.hidden', 'not printed'), {
          fontSize: XR_TYPE.tag,
          color: C.warn,
          flexShrink: 0,
        }),
      );
    }

    ui.appendChild(list, line);
    rowKeys.push(row.key);
  }

  // ---- What can be done to the selection ---------------------------------
  if (ctx.selectionActions.length > 0) {
    const footer = createXrColumn(ui, { gap: 5, flexShrink: 0, paddingTop: 6 });
    ui.appendChild(
      footer,
      ui.createText(
        ctx.selection.primary
          ? t('ui.xrObjectsPanel.selection', 'Selection')
          : t('ui.xrObjectsPanel.noSelection', 'Nothing selected'),
        { fontSize: XR_TYPE.tag, fontWeight: 'bold', letterSpacing: 0.8, color: C.textMuted },
      ),
    );
    const grid = createXrRow(ui, { flexWrap: 'wrap', gap: 5 });
    for (const action of ctx.selectionActions) {
      const button = createXrTextButton(ui, {
        label: action.label,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 10,
        danger: action.id === 'delete_models',
        enabled: action.enabled,
        onClick: () => ctx.onRunSelectionAction(action.id),
      });
      ui.appendChild(grid, button.root);
    }
    ui.appendChild(footer, grid);
    ui.appendChild(body, footer);
  }

  return { root: body, rowKeys };
}
