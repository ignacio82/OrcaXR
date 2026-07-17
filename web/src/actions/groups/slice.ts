/**
 * Slice group — the primary Slice action, plus toolpath preview.
 * Paint mode is its own tool (scene group); painted multi-color slicing is
 * wired in Phase 3.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

export const sliceActions: Action[] = [
  {
    id: 'slice_active_plate',
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
    id: 'toggle_preview',
    label: 'Preview',
    icon: 'preview',
    group: 'slice',
    disclosure: 'primary',
    hint: 'Toggle the sliced toolpath preview',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.togglePreview(),
  },
];
