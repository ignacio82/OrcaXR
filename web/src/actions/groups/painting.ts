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
  // ---- Smart Paint (P4.9) ------------------------------------------------
  // The assistant flow completes through a DOM panel with consent checkboxes,
  // a text prompt, and a per-region destination list, so each action declares
  // an exact XR exclusion rather than advertising a stranded spatial control.
  {
    id: 'paint_smart_configure',
    label: 'Set Smart Paint consent and prompt',
    icon: 'smart_paint',
    group: 'paint',
    disclosure: 'inspector',
    hint: 'Choose what may be sent to the assistant, and describe the regions you want',
    xrUnsupportedReason:
      'Smart Paint consent and its prompt are entered in a DOM panel; no in-headset consent or text flow exists yet.',
    run: (ctx, invocation) => {
      const request = invocation.smartPaint;
      if (!request) {
        ctx.reportCapabilityUnavailable('Smart Paint', 'Open the Smart Paint panel to set consent and a prompt.');
        return;
      }
      ctx.configureSmartPaint(request);
    },
  },
  {
    id: 'paint_smart_request',
    label: 'Ask the Smart Paint assistant',
    icon: 'smart_paint',
    group: 'paint',
    disclosure: 'inspector',
    hint: 'Send one request and preview the proposed regions; nothing is painted yet',
    // Scope is judged canonically by the workspace, which knows how many parts
    // are actually in play and says so; a coarser selection gate here would
    // disagree with the panel and silently refuse an enabled button.
    isEnabled: (s) => s.modelCount > 0,
    xrUnsupportedReason:
      'Smart Paint consent and its prompt are entered in a DOM panel; no in-headset consent or text flow exists yet.',
    run: (ctx) => ctx.requestSmartPaint(),
  },
  {
    id: 'paint_smart_apply',
    label: 'Apply the Smart Paint mask',
    icon: 'smart_paint',
    group: 'paint',
    disclosure: 'inspector',
    hint: 'Commit the corrected mask as one undoable painting command',
    xrUnsupportedReason:
      'Smart Paint destinations are chosen per region in a DOM list; no in-headset region editor exists yet.',
    run: (ctx) => ctx.applySmartPaint(),
  },
  {
    id: 'paint_smart_cancel',
    label: 'Discard the Smart Paint mask',
    icon: 'delete',
    group: 'paint',
    disclosure: 'inspector',
    hint: 'Drop the proposed mask; the project is left exactly as it was',
    // Reachable in a headset, unlike the apply beside it. Discarding needs no
    // region editor — that reason describes choosing destinations, which is
    // what apply does. A mask proposed in the DOM shell survives into an
    // immersive session, so blocking this was leaving an operator with pending
    // state they could see and could not back out of. The proposal is a scene
    // overlay, so its disappearance is the confirmation.
    run: (ctx) => ctx.cancelSmartPaint(),
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
