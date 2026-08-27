/**
 * XrPrintSubmissionDialog — in-headset spatial Print Submission & Slot Mapping Dialog in XR.
 *
 * Provides feature parity with the desktop PrintSubmissionDialog:
 *  - Target Printer picker.
 *  - Bed Plate and nozzle compatibility verification.
 *  - Multi-material filament slot mapping (mapping sliced extruder tools T0..TN to physical AMS slots).
 *  - Print summary (estimated print duration, filament weight, cost).
 *  - Action buttons: "Send & Print" (primary), "Send Only", "Cancel".
 */
import { createXrButton, createXrSectionHeading } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export interface XrPrintToolSlotMap {
  readonly toolNumber: number;
  readonly toolName: string;
  readonly toolColor: string;
  readonly toolType: string;
  readonly mappedPrinterSlot: number;
  readonly printerSlotColor?: string;
  readonly printerSlotType?: string;
}

/**
 * One thing the printer can do around this print, as the headset shows it.
 *
 * The flat shell's send dialog offers exactly these, read from the same
 * capability assessment; the two shells differ in how a row is pressed, never
 * in what is on offer.
 */
export interface XrPrintStartOptionRow {
  readonly id: string;
  readonly label: string;
  /** What it will do, or — when unavailable — the printer's reason it cannot. */
  readonly detail: string;
  readonly available: boolean;
  readonly enabled: boolean;
}

export interface XrPrintSubmissionContext {
  readonly printerName: string;
  readonly availablePrinters: readonly string[];
  readonly plateName: string;
  /**
   * Facts about the job. Every one is optional because the send confirmation
   * genuinely may not know it, and a headset is the worst place to invent one:
   * an operator reading "1h 15m" over a plate has no way to tell a real
   * estimate from a placeholder. Absent renders as "not reported", never as a
   * plausible number.
   */
  readonly nozzleMm?: number;
  readonly bedType?: string;
  readonly estimatedDurationFormatted?: string;
  readonly estimatedWeightGrams?: number;
  readonly estimatedCostFormatted?: string;
  readonly toolSlots: readonly XrPrintToolSlotMap[];
  /**
   * What the send confirmation says about filaments, in its own words — shown
   * when there is no per-tool map to draw, so the sheet reports the mapping it
   * has rather than sketching one it does not.
   */
  readonly toolSummaryText?: string;
  readonly readyToPrint: boolean;
  readonly blockedReason?: string;
  /** Pre-print options this machine reported; empty when it reported none. */
  readonly startOptions?: readonly XrPrintStartOptionRow[];
  onToggleStartOption?(id: string): void;
  onSelectPrinter?(printer: string): void;
  onCycleSlotMapping?(toolNumber: number): void;
  onSendAndPrint?(): void;
  onSendOnly?(): void;
  onCancel?(): void;
}

export function renderXrPrintSubmissionDialog<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrPrintSubmissionContext,
): PanelNode {
  const container = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    fillColor: '#0d141cF5',
    cornerRadius: tokens.radius.lg,
    padding: 16,
    gap: 12,
    strokeWidth: 1,
    strokeColor: '#ffffff1a',
    overflow: 'scroll',
  });
  ui.appendChild(root, container);

  // Header
  const header = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  });
  ui.appendChild(container, header);

  const title = ui.createText('Print Submission', {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(header, title);

  if (ctx.onCancel) {
    const closeBtn = createXrButton(ui, {
      label: '✕',
      fontSize: 14,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: ctx.onCancel,
    });
    ui.appendChild(header, closeBtn.root);
  }

  // Section 1: Target Printer & Plate Info
  const printerHeading = createXrSectionHeading(ui, 'Target Printer & Plate');
  ui.appendChild(container, printerHeading);

  const printerCard = ui.createPanel({
    width: '100%',
    padding: 12,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
    flexDirection: 'column',
    gap: 4,
  });
  ui.appendChild(container, printerCard);

  const pRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  });
  const pName = ui.createText(ctx.printerName || 'Default Printer', {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(pRow, pName);

  if (ctx.availablePrinters.length > 1) {
    const switchBtn = createXrButton(ui, {
      label: 'Switch Printer ↷',
      fontSize: 11,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: () => {
        const idx = ctx.availablePrinters.indexOf(ctx.printerName);
        const next = ctx.availablePrinters[(idx + 1) % ctx.availablePrinters.length];
        ctx.onSelectPrinter?.(next);
      },
    });
    ui.appendChild(pRow, switchBtn.root);
  }
  ui.appendChild(printerCard, pRow);

  const metaText = ui.createText(
    [
      `Plate: ${ctx.plateName}`,
      ...(ctx.nozzleMm !== undefined ? [`Nozzle: ${ctx.nozzleMm.toFixed(2)} mm`] : []),
      ...(ctx.bedType ? [`Bed: ${ctx.bedType}`] : []),
    ].join(' · '),
    { fontSize: 12, color: '#a0aab5' },
  );
  ui.appendChild(printerCard, metaText);

  // Section 2: Filament Slot Mapping
  if (ctx.toolSlots.length === 0 && ctx.toolSummaryText) {
    ui.appendChild(container, ui.createText(ctx.toolSummaryText, { fontSize: 12, color: C.textMuted, paddingTop: 2 }));
  }
  if (ctx.toolSlots.length > 0) {
    const slotHeading = createXrSectionHeading(ui, 'Filament Slot Mapping (Tool → AMS Slot)');
    ui.appendChild(container, slotHeading);

    for (const slot of ctx.toolSlots) {
      const slotRow = ui.createPanel({
        width: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        cornerRadius: tokens.radius.sm,
        fillColor: C.surface,
      });

      const toolInfo = ui.createPanel({ flexDirection: 'row', alignItems: 'center', gap: 8 });
      const swatch = ui.createPanel({
        width: 16,
        height: 16,
        cornerRadius: 8,
        fillColor: slot.toolColor,
      });
      ui.appendChild(toolInfo, swatch);

      const label = ui.createText(`Tool ${slot.toolNumber}: ${slot.toolType}`, {
        fontSize: 13,
        fontWeight: 'bold',
        color: '#ffffff',
      });
      ui.appendChild(toolInfo, label);
      ui.appendChild(slotRow, toolInfo);

      const mappingBtn = createXrButton(ui, {
        label: `→ Printer Slot ${slot.mappedPrinterSlot} ↷`,
        fontSize: 12,
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 4,
        paddingBottom: 4,
        onClick: () => ctx.onCycleSlotMapping?.(slot.toolNumber),
      });
      ui.appendChild(slotRow, mappingBtn.root);

      ui.appendChild(container, slotRow);
    }
  }

  // Section 3: Summary Estimates
  const summaryHeading = createXrSectionHeading(ui, 'Print Summary');
  ui.appendChild(container, summaryHeading);

  const summaryCard = ui.createPanel({
    width: '100%',
    padding: 12,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
    flexDirection: 'row',
    justifyContent: 'space-between',
  });
  ui.appendChild(container, summaryCard);

  const durationCol = ui.createPanel({ flexDirection: 'column', gap: 2 });
  ui.appendChild(durationCol, ui.createText('ESTIMATED TIME', { fontSize: 10, fontWeight: 'bold', color: '#8a94a0' }));
  ui.appendChild(
    durationCol,
    ui.createText(ctx.estimatedDurationFormatted || 'not reported', {
      fontSize: 15,
      fontWeight: 'bold',
      color: ctx.estimatedDurationFormatted ? '#ffffff' : C.textMuted,
    }),
  );
  ui.appendChild(summaryCard, durationCol);

  const weightCol = ui.createPanel({ flexDirection: 'column', gap: 2 });
  ui.appendChild(weightCol, ui.createText('MATERIAL WEIGHT', { fontSize: 10, fontWeight: 'bold', color: '#8a94a0' }));
  ui.appendChild(
    weightCol,
    ui.createText(
      ctx.estimatedWeightGrams === undefined ? 'not reported' : `${ctx.estimatedWeightGrams.toFixed(1)} g`,
      {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#ffffff',
      },
    ),
  );
  ui.appendChild(summaryCard, weightCol);

  if (ctx.estimatedCostFormatted) {
    const costCol = ui.createPanel({ flexDirection: 'column', gap: 2 });
    ui.appendChild(costCol, ui.createText('ESTIMATED COST', { fontSize: 10, fontWeight: 'bold', color: '#8a94a0' }));
    ui.appendChild(
      costCol,
      ui.createText(ctx.estimatedCostFormatted, { fontSize: 15, fontWeight: 'bold', color: '#ffffff' }),
    );
    ui.appendChild(summaryCard, costCol);
  }

  if (ctx.blockedReason) {
    const blockNotice = ui.createText(ctx.blockedReason, {
      fontSize: 12,
      color: C.warn,
      paddingTop: 4,
    });
    ui.appendChild(container, blockNotice);
  }

  // What the machine can do around the print. An unavailable row stays on
  // screen carrying the printer's own reason, exactly as the flat dialog does:
  // "this printer has no timelapse component" is worth knowing, and hiding it
  // would leave an operator hunting for a control they know from the desktop.
  if ((ctx.startOptions?.length ?? 0) > 0) {
    const optionsCard = ui.createPanel({
      width: '100%',
      flexDirection: 'column',
      gap: 6,
      padding: 10,
      cornerRadius: tokens.radius.md,
      fillColor: '#ffffff0a',
      strokeWidth: 1,
      strokeColor: '#ffffff14',
    });
    ui.appendChild(container, optionsCard);
    ui.appendChild(optionsCard, ui.createText('Before printing', { fontSize: 12, color: C.textMuted }));
    for (const option of ctx.startOptions ?? []) {
      const row = ui.createPanel({
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 8,
        paddingBottom: 8,
        cornerRadius: tokens.radius.sm,
        fillColor: option.available ? '#ffffff12' : '#ffffff08',
        opacity: option.available ? 1 : 0.55,
        ...(option.available && ctx.onToggleStartOption ? { onClick: () => ctx.onToggleStartOption?.(option.id) } : {}),
      });
      // The tick is a filled box rather than a glyph: at this size a checkmark
      // is a smudge, and fill reads as state from across the room.
      const box = ui.createPanel({
        width: 22,
        height: 22,
        cornerRadius: tokens.radius.sm,
        flexShrink: 0,
        fillColor: option.enabled && option.available ? C.accent : '#00000000',
        strokeWidth: 2,
        strokeColor: option.available ? C.accent : C.textMuted,
      });
      ui.appendChild(row, box);
      const text = ui.createPanel({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, gap: 2 });
      ui.appendChild(text, ui.createText(option.label, { fontSize: 14, color: C.text }));
      ui.appendChild(text, ui.createText(option.detail, { fontSize: 11, color: C.textMuted }));
      ui.appendChild(row, text);
      ui.appendChild(optionsCard, row);
    }
  }

  // Action Buttons: Send & Print (primary), Send Only, Cancel
  const actionRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    gap: 8,
    paddingTop: 8,
  });
  ui.appendChild(container, actionRow);

  const sendAndPrintBtn = createXrButton(ui, {
    label: 'Send & Print',
    primary: true,
    flexGrow: 2,
    enabled: ctx.readyToPrint,
    onClick: ctx.onSendAndPrint,
  });
  ui.appendChild(actionRow, sendAndPrintBtn.root);

  const sendOnlyBtn = createXrButton(ui, {
    label: 'Send Only',
    flexGrow: 1,
    enabled: ctx.readyToPrint,
    onClick: ctx.onSendOnly,
  });
  ui.appendChild(actionRow, sendOnlyBtn.root);

  const cancelBtn = createXrButton(ui, {
    label: 'Cancel',
    flexGrow: 1,
    onClick: ctx.onCancel,
  });
  ui.appendChild(actionRow, cancelBtn.root);

  return container;
}
