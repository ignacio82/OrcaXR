/**
 * XrSettingsPanel — the generated settings tree, in the headset.
 *
 * The immersive shell showed six rows and a line reading "94 more are
 * unavailable". That number was honest and the surface was not: the ninety-four
 * were not unavailable, they were *unsteppable* — an unbounded float cannot be
 * reached by a pair of arrows — and every one of them is an ordinary setting
 * the flat panel edits without ceremony. The limitation was the input method,
 * so the input method is what changed: {@link renderXrKeypad} writes an exact
 * value through the same draft editor a typed character goes through, and this
 * panel offers the whole query.
 *
 * What it draws is decided entirely by {@link ScopedStepperView}:
 *
 *  - the **scope** is the view's target — project, plate, object, part, height
 *    range — cycled or selected, exactly as the flat shell scopes an override;
 *  - the **rows** are the same query the DOM panel runs, so a setting cannot
 *    exist on one surface and be missing on the other;
 *  - the **editor** per row is the row's own `kind`, so a boolean gets a
 *    switch, an enumeration gets its choices, and a number gets arrows and a
 *    keypad;
 *  - a row that still cannot be edited **says why**, in place, rather than
 *    being dropped from the list.
 *
 * Search is done here rather than in the engine because it is presentation: the
 * rows are already loaded, and a filter that had to round-trip through a
 * revision guard would make typing feel broken.
 */
import type { ScopedStepperRow, ScopedStepperView } from '../../settings/editor/scopedStepper';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrColumn,
  createXrField,
  createXrHeading,
  createXrIconButton,
  createXrRow,
  createXrSegmented,
  createXrTextButton,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrSettingsPanelContext {
  readonly view: ScopedStepperView | null;
  readonly search: string;
  /** Rows drawn before the list is cut off; the rest are reached by searching. */
  readonly limit?: number;
  onCycleTarget(direction: 1 | -1): void;
  onEditSearch(): void;
  onStep(fieldId: string, direction: 1 | -1): void;
  onSetValue(fieldId: string, raw: string): void;
  /** Open the keypad for a numeric or free-text row. */
  onEditValue(row: ScopedStepperRow): void;
}

export interface XrSettingsPanelRender<PanelNode> {
  readonly root: PanelNode;
  /** Field ids in draw order; the automation seam and what the tests read. */
  readonly fieldIds: readonly string[];
}

const DEFAULT_LIMIT = 40;

/** The rows a query leaves, matched on the words an operator would search. */
export function xrFilterSettings(rows: readonly ScopedStepperRow[], search: string): readonly ScopedStepperRow[] {
  const query = search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(
    (row) =>
      row.label.toLowerCase().includes(query) ||
      row.key.toLowerCase().includes(query) ||
      row.group.toLowerCase().includes(query),
  );
}

export function renderXrSettingsPanel<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrSettingsPanelContext,
): XrSettingsPanelRender<PanelNode> {
  const body = createXrColumn(ui, { gap: tokens.space.sm, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(root, body);

  const view = ctx.view;
  if (!view || view.status !== 'ready') {
    ui.appendChild(
      body,
      ui.createText(view?.message ?? t('ui.xrSettingsPanel.loading', 'Loading the settings schema…'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
    return { root: body, fieldIds: [] };
  }

  // ---- Scope -------------------------------------------------------------
  const scopeRow = createXrRow(ui, { gap: 5, flexShrink: 0 });
  ui.appendChild(
    scopeRow,
    createXrIconButton(ui, { icon: 'chevron_right', size: 32, iconSize: 14, onClick: () => ctx.onCycleTarget(-1) })
      .root,
  );
  const scope = createXrSegmented(ui, [{ id: 'target', label: view.targetLabel }], 'target', () =>
    ctx.onCycleTarget(1),
  );
  ui.appendChild(scopeRow, scope.root);
  ui.appendChild(
    scopeRow,
    ui.createText(`${view.targetIndex + 1}/${view.targetCount}`, {
      fontSize: XR_TYPE.micro,
      color: C.textMuted,
      flexShrink: 0,
    }),
  );
  ui.appendChild(
    scopeRow,
    createXrIconButton(ui, { icon: 'chevron_right', size: 32, iconSize: 14, onClick: () => ctx.onCycleTarget(1) }).root,
  );
  ui.appendChild(body, scopeRow);

  // ---- Search and the modified count -------------------------------------
  const rows = xrFilterSettings(view.rows, ctx.search);
  const modified = view.rows.filter((row) => row.overridden).length;
  const searchRow = createXrRow(ui, { gap: 6, flexShrink: 0 });
  const search = createXrField(ui, {
    value: ctx.search,
    placeholder: t('ui.xrSettingsPanel.search', 'Search {count} settings').replace('{count}', String(view.rows.length)),
    icon: 'search',
    onClick: () => ctx.onEditSearch(),
  });
  ui.appendChild(searchRow, search.root);
  const modifiedTag = ui.createPanel({
    flexShrink: 0,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    paddingTop: 6,
    paddingBottom: 6,
    cornerRadius: tokens.radius.sm,
    fillColor: modified > 0 ? C.warnSurface : C.surface,
    justifyContent: 'center',
  });
  ui.appendChild(
    modifiedTag,
    ui.createText(t('ui.xrSettingsPanel.modified', 'Modified {count}').replace('{count}', String(modified)), {
      fontSize: XR_TYPE.caption,
      color: modified > 0 ? C.accentSoft : C.textMuted,
    }),
  );
  ui.appendChild(searchRow, modifiedTag);
  ui.appendChild(body, searchRow);

  // ---- The tree ----------------------------------------------------------
  const list = createXrColumn(ui, { gap: 4, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);

  const fieldIds: string[] = [];
  const limit = ctx.limit ?? DEFAULT_LIMIT;
  let group = '';
  for (const row of rows.slice(0, limit)) {
    if (row.group !== group) {
      group = row.group;
      ui.appendChild(list, createXrHeading(ui, group));
    }
    ui.appendChild(list, settingRow(ui, row, ctx));
    fieldIds.push(row.fieldId);
  }

  if (rows.length === 0) {
    ui.appendChild(
      list,
      ui.createText(t('ui.xrSettingsPanel.noMatches', 'No setting matches that.'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
  } else if (rows.length > limit) {
    ui.appendChild(
      list,
      ui.createText(
        t('ui.xrSettingsPanel.more', '{count} more — search to narrow the list.').replace(
          '{count}',
          String(rows.length - limit),
        ),
        { fontSize: XR_TYPE.micro, color: C.textMuted },
      ),
    );
  }

  // The schema's own casualties, still counted rather than quietly dropped.
  if (view.unavailable > 0) {
    ui.appendChild(
      body,
      ui.createText(
        t('ui.xrSettingsPanel.unavailable', '{count} settings are unavailable on every surface.').replace(
          '{count}',
          String(view.unavailable),
        ),
        { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 },
      ),
    );
  }

  return { root: body, fieldIds };
}

/** One setting, with the editor its own definition calls for. */
function settingRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  row: ScopedStepperRow,
  ctx: XrSettingsPanelContext,
): PanelNode {
  const line = createXrRow(ui, {
    minHeight: 40,
    gap: 6,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    paddingTop: 4,
    paddingBottom: 4,
    cornerRadius: tokens.radius.sm,
    fillColor: row.overridden ? C.warnSurface : C.surfaceDisabled,
  });
  const label = createXrColumn(ui, { gap: 1, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(
    label,
    ui.createText(row.label, { fontSize: XR_TYPE.caption, color: row.overridden ? C.text : C.textMuted }),
  );
  // A row that cannot be edited here says so where the value would be, which is
  // the only place an operator looks for it.
  if (row.kind === 'read-only') {
    ui.appendChild(
      label,
      ui.createText(t('ui.xrSettingsPanel.readOnly', 'Read-only'), { fontSize: XR_TYPE.tag, color: C.warn }),
    );
  }
  ui.appendChild(line, label);

  const unit = row.unit ? ` ${row.unit}` : '';
  switch (row.kind) {
    case 'bool': {
      const on = row.value === '1' || row.value === 'true';
      const toggle = ui.createPanel({
        width: 52,
        height: 30,
        flexShrink: 0,
        cornerRadius: 15,
        padding: 3,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: on ? 'flex-end' : 'flex-start',
        fillColor: on ? C.accent : C.strokeStrong,
        onClick: () => ctx.onSetValue(row.fieldId, on ? '0' : '1'),
      });
      ui.appendChild(toggle, ui.createPanel({ width: 24, height: 24, cornerRadius: 12, fillColor: C.text }));
      ui.appendChild(line, toggle);
      break;
    }
    case 'enum': {
      const current = row.choices.find((choice) => choice.serialized === row.value);
      const button = createXrTextButton(ui, {
        label: `${current?.label ?? row.value} ⌄`,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 10,
        // A single press cycles, which is what upstream's own stepper does for
        // an enumeration: a ring of choices has no end to bump into, and a
        // spatial dropdown for a two-value option would be a worse control.
        onClick: () => ctx.onStep(row.fieldId, 1),
      });
      ui.appendChild(line, button.root);
      break;
    }
    case 'numeric': {
      const controls = createXrRow(ui, { width: 'auto', flexShrink: 0, gap: 5 });
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'minus',
          size: 32,
          iconSize: 14,
          enabled: row.steppable,
          onClick: () => ctx.onStep(row.fieldId, -1),
        }).root,
      );
      const value = createXrTextButton(ui, {
        label: `${row.value}${unit}`,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 8,
        enabled: row.typeable,
        onClick: () => ctx.onEditValue(row),
      });
      ui.setPanelProperties(value.root, { minWidth: 74, fillColor: C.bgSunken });
      ui.appendChild(controls, value.root);
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'plus',
          size: 32,
          iconSize: 14,
          enabled: row.steppable,
          onClick: () => ctx.onStep(row.fieldId, 1),
        }).root,
      );
      ui.appendChild(line, controls);
      break;
    }
    default: {
      const value = createXrTextButton(ui, {
        label: row.value === '' ? '—' : `${row.value}${unit}`,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 10,
        enabled: row.typeable,
        onClick: () => ctx.onEditValue(row),
      });
      ui.setPanelProperties(value.root, { minWidth: 74, fillColor: C.bgSunken });
      ui.appendChild(line, value.root);
      break;
    }
  }
  return line;
}
