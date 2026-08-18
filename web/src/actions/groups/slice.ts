/**
 * Slice group — the primary Slice action, plus toolpath preview.
 * Paint mode is its own tool (scene group); painted multi-color slicing is
 * wired in Phase 3.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

export const sliceActions: Action[] = [
  {
    id: 'slice_active_plate',
    context: ['plate'],
    mcpTool: 'slice_active_plate',
    label: 'Slice',
    icon: 'slice',
    group: 'slice',
    disclosure: 'primary',
    hint: 'Slice the plated models to G-code',
    isEnabled: (s) => s.modelCount > 0 && !s.isSlicing && !s.preflightBlocked,
    run: (ctx) => ctx.slice(),
  },
  {
    id: 'slice_all_plates',
    label: 'Slice All Plates',
    icon: 'slice',
    group: 'slice',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Slice every printable plate and keep each plate’s own result',
    isEnabled: (s) => s.modelCount > 0 && !s.isSlicing && !s.preflightBlocked,
    run: (ctx) => ctx.sliceAllPlates(),
  },
  {
    id: 'slice_cancel',
    mcpTool: 'cancel_slice',
    label: 'Cancel Slice',
    icon: 'slice',
    group: 'slice',
    disclosure: 'primary',
    hint: 'Stop the slice that is running',
    // Nothing else can end a slice now that a quiet engine is left to work:
    // how long a large model takes is not knowable in advance, so stopping it
    // is the operator's call and needs to be one click away while it runs.
    isEnabled: (s) => s.isSlicing,
    run: (ctx) => ctx.cancelSlice(),
  },
  {
    id: 'toggle_preview',
    label: 'Preview',
    icon: 'preview',
    group: 'slice',
    disclosure: 'primary',
    hint: 'Toggle the sliced toolpath preview',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.applyTogglePreview(),
  },
];
