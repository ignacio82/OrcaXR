/**
 * Painting group — canonical colour-paint configuration and erase actions.
 * Selection of a colour, tool, or brush parameter is a real invocation so DOM,
 * XR, shortcuts, and automation share one guarded gateway.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

/**
 * Upstream exposes `1`–`9` as nine discrete filament-selection commands, so the
 * catalog declares them as nine actions instead of one ambiguous chord owner.
 */
const filamentSlotActions: Action[] = Array.from({ length: 9 }, (_unused, index) => {
  const slot = index + 1;
  return {
    id: `paint_select_filament_${slot}`,
    label: `Paint with filament ${slot}`,
    icon: 'paint',
    group: 'paint',
    disclosure: 'inspector',
    shortcuts: [String(slot)],
    hint: `Select palette row ${slot} for the next colour stroke`,
    run: (ctx) => ctx.selectPaintFilamentSlot(slot),
  } satisfies Action;
});

export const paintingActions: Action[] = [
  ...filamentSlotActions,
  {
    id: 'paint_configure',
    label: 'Set paint colour and tool',
    icon: 'paint',
    group: 'paint',
    disclosure: 'inspector',
    hint: 'Choose the stable filament, tool, and brush parameters used by the next stroke',
    run: (ctx, invocation) => {
      const request = invocation.paintConfiguration;
      if (!request) {
        ctx.reportCapabilityUnavailable('Set paint colour and tool', 'Choose a colour or tool in the paint panel.');
        return;
      }
      ctx.configurePaint(request);
    },
  },
  {
    id: 'paint_erase_all',
    label: 'Erase all painting',
    icon: 'delete',
    group: 'paint',
    // Upstream keeps Erase All inside the paint gizmo panel, not the Edit menu.
    disclosure: 'inspector',
    hint: 'Remove every colour facet from the selected parts',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.eraseAllPaint(),
  },
];
