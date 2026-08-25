/**
 * XrDesk — the primary bar and the plate strip, below the work.
 *
 * Three things the flat shell keeps at the bottom of its window live here:
 * the primary verbs (`xr-primary` — Load, Slice, Preview, Download, Print), the
 * plate strip, and the slice progress line.
 *
 * Progress is the reason this surface changed shape. It used to be a modal card
 * floating in the middle of the view — `progress` in the old layout, 0.5 × 0.2 m
 * at dead centre — so the moment a slice started, the plate the operator was
 * watching was behind a panel telling them about the plate. A slice takes tens
 * of seconds and the interesting part is the toolpath appearing, so progress
 * belongs on the desk, in the corner of the eye, and the centre of the view
 * belongs to the model.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrProgressBar,
  createXrRow,
  createXrSurfaceBody,
  createXrTextButton,
  type XrProgressBar,
  type XrTextButton,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrDeskPlate {
  readonly id: string;
  readonly label: string;
  readonly modelCount: number;
  readonly active: boolean;
}

export interface XrDeskContext {
  readonly registry: ActionRegistry;
  readonly state: Readonly<UiStateShape>;
  readonly plates: readonly XrDeskPlate[];
  /** The status line the flat shell shows; the same sentence, same place. */
  readonly status: string;
  /** `null` when nothing is running. */
  readonly progress: number | null;
  onRun(action: Action): void;
  onSelectPlate(plateId: string): void;
  onAddPlate(): void;
  onManagePlates(): void;
}

export interface XrDeskRender<PanelNode> {
  readonly root: PanelNode;
  /** The node `load_model_from_path` drew, which the ray probe watches. */
  readonly loadButton: PanelNode | null;
  refresh(ctx: XrDeskContext): void;
}

export function renderXrDesk<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrDeskContext,
): XrDeskRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { padding: tokens.space.sm, gap: 6 });
  ui.appendChild(root, body);

  // ---- The verbs ---------------------------------------------------------
  const verbs = createXrRow(ui, { gap: 6, flexShrink: 0 });
  ui.appendChild(body, verbs);

  let loadButton: PanelNode | null = null;
  const primaries: { action: Action; button: XrTextButton<PanelNode, TextNode> }[] = [];
  for (const action of ctx.registry.forSurface('xr-primary')) {
    const primary = action.id === 'slice_active_plate';
    const button = createXrTextButton(ui, {
      label: action.label,
      icon: action.icon,
      iconSize: 17,
      fontSize: XR_TYPE.body,
      height: 44,
      // Slice is the verb the desk exists for, so it is the one that is wider
      // as well as brighter.
      flexGrow: primary ? 1.6 : 1,
      primary,
      onClick: () => ctx.onRun(action),
    });
    // Load must end the immersive session before a file picker opens (browsers
    // suppress dialogs in XR); the per-frame ray probe watches this node.
    if (action.id === 'load_model_from_path') loadButton = button.root;
    primaries.push({ action, button });
    ui.appendChild(verbs, button.root);
  }

  // ---- Plates and progress ----------------------------------------------
  const strip = createXrRow(ui, { gap: 6, flexShrink: 0 });
  ui.appendChild(body, strip);
  ui.appendChild(
    strip,
    ui.createText(t('ui.xrDesk.plates', 'Plates'), { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 }),
  );

  const plateRow = createXrRow(ui, { gap: 5, flexShrink: 0, width: 'auto' });
  ui.appendChild(strip, plateRow);

  const addPlate = createXrTextButton(ui, {
    label: t('ui.xrDesk.addPlate', '+ Plate'),
    fontSize: XR_TYPE.caption,
    height: 32,
    paddingX: 10,
    onClick: () => ctx.onAddPlate(),
  });
  const managePlates = createXrTextButton(ui, {
    label: t('ui.xrDesk.managePlates', 'Manage…'),
    fontSize: XR_TYPE.caption,
    height: 32,
    paddingX: 10,
    onClick: () => ctx.onManagePlates(),
  });
  ui.appendChild(strip, addPlate.root);
  ui.appendChild(strip, managePlates.root);

  const statusText = ui.createText(ctx.status, {
    fontSize: XR_TYPE.caption,
    color: C.textMuted,
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: tokens.space.sm,
  });
  ui.appendChild(strip, statusText);
  const bar: XrProgressBar<PanelNode> = createXrProgressBar(ui);
  ui.setPanelProperties(bar.root, { maxWidth: 180, flexShrink: 0, flexGrow: 0, width: 180 });
  ui.appendChild(strip, bar.root);
  const percent = ui.createText('', { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 });
  ui.appendChild(strip, percent);

  const drawPlates = (plates: readonly XrDeskPlate[]): void => {
    ui.clearChildren(plateRow);
    for (const plate of plates) {
      const chip = createXrTextButton(ui, {
        label: `${plate.label}  ${plate.modelCount}`,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 10,
        selected: plate.active,
        onClick: () => ctx.onSelectPlate(plate.id),
      });
      ui.appendChild(plateRow, chip.root);
    }
  };

  const apply = (next: XrDeskContext): void => {
    for (const { action, button } of primaries) {
      button.setEnabled(next.registry.availability(action, 'xr-primary', next.state).state === 'enabled');
    }
    drawPlates(next.plates);
    ui.setText(statusText, next.status);
    bar.setProgress(next.progress);
    ui.setText(percent, next.progress === null ? '' : `${Math.round(next.progress * 100)}%`);
  };
  apply(ctx);

  return { root: body, loadButton, refresh: apply };
}
