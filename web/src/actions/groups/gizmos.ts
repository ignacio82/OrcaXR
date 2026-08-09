/**
 * Gizmos & mesh-ops group — mirrors Snapmaker Orca's left gizmo tool rail
 * (cut, painting variants, measure, assembly…), the top-toolbar object ops
 * (arrange, split), and the object right-click context menu (modifiers,
 * support enforcer/blocker, height-range, negative part).
 *
 * OrcaXR's manipulation gizmos (move / rotate / scale / lay-flat / color paint)
 * live in `scene.ts` on the tool rail; the mesh booleans and repair/simplify
 * live in `scene.ts`'s Tools menu. Some actions have local alpha
 * implementations and others remain unavailable; acceptance status is tracked
 * in `docs/parity.md`.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

const UNAVAILABLE_TOOL_IDS = new Set([
  'split_to_parts',
  'tool_face_detector',
  'tool_svg',
  'tool_hollow',
  'add_modifier',
  'add_support_enforcer',
  'add_support_blocker',
  'add_height_range',
  'set_negative_part',
  'variable_layer_height',
]);

function tool(
  id: string,
  label: string,
  icon: string,
  hint: string,
  runProp: string,
  disclosure: 'menu' | 'toolbar' = 'menu',
): Action {
  return {
    id,
    label,
    icon,
    group: 'scene',
    disclosure,
    menuSection: disclosure === 'menu' ? 'tools' : undefined,
    hint,
    ...(UNAVAILABLE_TOOL_IDS.has(id) ? {} : { run: (ctx: any) => ctx[runProp]() }),
  };
}

export const gizmoActions: Action[] = [
  // ---- Completes the mesh-boolean trio (union/subtract already exist) ----
  {
    id: 'mesh_boolean_intersection',
    mcpTool: 'mesh_boolean',
    label: 'Intersect (overlap)',
    icon: 'intersect',
    group: 'scene',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Boolean-intersect the selected and other model',
    isEnabled: (s) => s.modelCount >= 2,
    run: (ctx) => ctx.boolean('INTERSECTION'),
  },

  // ---- Plate-level object ops (top toolbar in Orca) ----
  {
    id: 'arrange_all',
    label: 'Auto-arrange Plate',
    icon: 'arrange',
    group: 'scene',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Lay all models out in a centred grid so nothing overlaps',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.arrangePlate(),
  },
  {
    id: 'duplicate_plate',
    label: 'Duplicate Current Plate',
    icon: 'plate',
    group: 'scene',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Clone the active build plate and its models onto a new plate',
    run: (ctx, invocation) =>
      ctx.duplicatePlate(invocation.plateTarget?.plateId ?? invocation.plateId, invocation.plateTarget?.sourceRevision),
  },
  {
    id: 'split_to_objects',
    label: 'Split to Objects',
    icon: 'split_objects',
    group: 'scene',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Split a multi-body mesh into separate objects',
    isEnabled: (s) => s.hasInstanceSelection,
    run: (ctx) => ctx.splitToObjects(),
  },
  tool(
    'split_to_parts',
    'Split to Parts',
    'split_parts',
    'Split the selected object into editable parts',
    'splitToParts',
  ),

  // ---- Gizmo tool rail (Orca left bar) ----
  {
    id: 'tool_cut',
    label: 'Cut (Plane)',
    icon: 'cut',
    group: 'scene',
    disclosure: 'toolbar',
    hint: 'Cut the selected model in two with a horizontal plane',
    isEnabled: (s) => s.hasInstanceSelection,
    run: (ctx) => ctx.cutPlane(),
  },
  {
    id: 'tool_support_paint',
    label: 'Support Painting',
    icon: 'support_paint',
    group: 'paint',
    disclosure: 'toolbar',
    tool: 'support_paint',
    hint: 'Paint support enforcers and blockers onto the mesh',
    isEnabled: (s) => s.hasInstanceSelection,
    run: (ctx) => ctx.applyTool('support_paint'),
  },
  {
    id: 'tool_seam_paint',
    label: 'Seam Painting',
    icon: 'seam_paint',
    group: 'paint',
    disclosure: 'toolbar',
    tool: 'seam_paint',
    hint: 'Paint where layer seams may or may not be placed',
    isEnabled: (s) => s.hasInstanceSelection,
    run: (ctx) => ctx.applyTool('seam_paint'),
  },
  {
    id: 'tool_fuzzy_skin',
    label: 'Fuzzy-skin Painting',
    icon: 'fuzzy_skin',
    group: 'paint',
    disclosure: 'toolbar',
    tool: 'fuzzy_skin',
    hint: 'Paint regions that should get a fuzzy surface',
    isEnabled: (s) => s.hasInstanceSelection,
    run: (ctx) => ctx.applyTool('fuzzy_skin'),
  },
  // Smart Paint opens the assistant panel; it never sends anything by itself.
  {
    id: 'tool_smart_paint',
    label: 'Smart Paint',
    icon: 'smart_paint',
    group: 'scene',
    disclosure: 'toolbar',
    hint: 'Propose paint regions with an assistant, then correct and apply them yourself',
    xrUnsupportedReason:
      'Smart Paint consent and its prompt are entered in a DOM panel; no in-headset consent or text flow exists yet.',
    run: (ctx) => ctx.smartPaint(),
  },
  {
    id: 'tool_smart_paint_image',
    label: 'Smart Paint (Image)',
    icon: 'smart_paint_image',
    group: 'scene',
    disclosure: 'toolbar',
    hint: 'Propose paint regions from a reference image you explicitly allow sending',
    xrUnsupportedReason:
      'Smart Paint consent and its prompt are entered in a DOM panel; no in-headset consent or text flow exists yet.',
    run: (ctx) => ctx.smartPaintImage(),
  },
  {
    id: 'tool_brim_ears',
    label: 'Brim Ears',
    icon: 'brim_ears',
    group: 'scene',
    disclosure: 'toolbar',
    tool: 'brim_ears',
    hint: 'Click the selected part to place brim "mouse ears" that reach the slicer',
    isEnabled: (s) => s.hasInstanceSelection,
    xrUnsupportedReason:
      'Brim-ear radius and the placed-ear list are edited in the DOM inspector; no in-headset flow exists yet.',
    run: (ctx) => ctx.brimEars(),
  },
  {
    id: 'brim_ears_configure',
    label: 'Set brim-ear radius',
    icon: 'brim_ears',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Choose the front radius the next placed ear uses',
    xrUnsupportedReason:
      'Brim-ear radius and the placed-ear list are edited in the DOM inspector; no in-headset flow exists yet.',
    run: (ctx, invocation) => {
      const radius = invocation.brimEarRadiusMm;
      if (radius === undefined) {
        ctx.reportCapabilityUnavailable('Set brim-ear radius', 'Choose a radius in the Brim ears panel.');
        return;
      }
      ctx.setBrimEarRadius(radius);
    },
  },
  {
    id: 'brim_ears_remove',
    label: 'Remove a brim ear',
    icon: 'delete',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Remove one placed ear; it comes back at its original index on undo',
    xrUnsupportedReason:
      'Brim-ear radius and the placed-ear list are edited in the DOM inspector; no in-headset flow exists yet.',
    run: (ctx, invocation) => {
      const index = invocation.brimEarIndex;
      if (index === undefined) {
        ctx.reportCapabilityUnavailable('Remove a brim ear', 'Choose an ear in the Brim ears panel.');
        return;
      }
      ctx.removeBrimEar(index);
    },
  },
  {
    id: 'brim_ears_clear',
    label: 'Clear brim ears',
    icon: 'delete',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Remove every brim ear from the selected part as one undoable command',
    xrUnsupportedReason:
      'Brim-ear radius and the placed-ear list are edited in the DOM inspector; no in-headset flow exists yet.',
    run: (ctx) => ctx.clearBrimEars(),
  },
  {
    id: 'add_emboss',
    mcpTool: 'emboss_model',
    label: 'Emboss Text',
    icon: 'emboss',
    group: 'scene',
    disclosure: 'toolbar',
    menuSection: 'tools',
    tool: 'emboss',
    hint: 'Cut text as a new part of the selected model',
    isEnabled: (s) => s.modelCount > 0,
    xrUnsupportedReason:
      'Embossing needs a font file the operator picks and a text field to type in; both are DOM-only, and no in-headset file picker or keyboard flow exists yet.',
    run: (ctx) => ctx.emboss(),
  },
  {
    id: 'emboss_load_font',
    label: 'Load an emboss font',
    icon: 'emboss',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Choose a .ttf file; a browser cannot read the fonts installed on this machine',
    xrUnsupportedReason: 'Choosing a font file needs the DOM file picker; no in-headset file browser exists yet.',
    run: (ctx, invocation) => {
      const font = invocation.emboss?.font;
      if (!font) {
        ctx.reportCapabilityUnavailable('Load an emboss font', 'Choose a .ttf file in the Emboss panel.');
        return;
      }
      ctx.loadEmbossFont(font.name, font.bytes);
    },
  },
  {
    id: 'emboss_configure',
    label: 'Set the emboss text and shape',
    icon: 'emboss',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Change the text, size, depth, spacing, or alignment before cutting it',
    xrUnsupportedReason: 'The emboss recipe is typed into a DOM panel; no in-headset text entry exists yet.',
    run: (ctx, invocation) => {
      const recipe = invocation.emboss?.recipe;
      if (!recipe) {
        ctx.reportCapabilityUnavailable('Set the emboss text and shape', 'Edit the fields in the Emboss panel.');
        return;
      }
      ctx.setEmbossRecipe(recipe);
    },
  },
  {
    id: 'emboss_apply',
    label: 'Add embossed text',
    icon: 'emboss',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Cut the text and add it to the selected part, or re-cut the selected text part',
    isEnabled: (s) => s.modelCount > 0,
    xrUnsupportedReason:
      'Embossing needs a font file the operator picks and a text field to type in; both are DOM-only, and no in-headset file picker or keyboard flow exists yet.',
    run: (ctx) => ctx.applyEmboss(),
  },
  {
    id: 'tool_measure',
    label: 'Measure',
    icon: 'measure',
    group: 'scene',
    disclosure: 'toolbar',
    tool: 'measure',
    hint: 'Click two features to measure the distance, angle, or hole diameter between them',
    isEnabled: (s) => s.modelCount > 0,
    xrUnsupportedReason: 'Measurements are read from the DOM inspector; no in-headset readout surface exists yet.',
    run: (ctx) => ctx.measureTool(),
  },
  {
    id: 'measure_clear',
    label: 'Clear measurement',
    icon: 'delete',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Drop both picked features and start a new measurement',
    xrUnsupportedReason: 'Measurements are read from the DOM inspector; no in-headset readout surface exists yet.',
    run: (ctx) => ctx.clearMeasureSelection(),
  },
  {
    id: 'tool_assembly',
    label: 'Assembly',
    icon: 'assembly',
    group: 'scene',
    disclosure: 'toolbar',
    tool: 'measure',
    hint: 'Pick two faces on different models, then align them',
    isEnabled: (s) => s.modelCount > 1,
    xrUnsupportedReason:
      'Assembly alignment is driven from the DOM inspector; no in-headset alignment surface exists yet.',
    run: (ctx) => ctx.assemblyView(),
  },
  {
    id: 'assembly_align',
    label: 'Align picked faces',
    icon: 'assembly',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Apply one pinned alignment to the second picked model as a single undoable move',
    xrUnsupportedReason:
      'Assembly alignment is driven from the DOM inspector; no in-headset alignment surface exists yet.',
    run: (ctx, invocation) => {
      const request = invocation.assemblyAlignment;
      if (!request) {
        ctx.reportCapabilityUnavailable('Align picked faces', 'Pick two faces in the Measure panel first.');
        return;
      }
      ctx.applyAssemblyAlignment(request.kind, request.parameter);
    },
  },
  tool(
    'tool_face_detector',
    'Auto Face Orientation',
    'face_detector',
    'Detect the best flat face and orient to it',
    'faceDetector',
    'toolbar',
  ),
  tool('tool_svg', 'SVG Emboss', 'svg', 'Emboss / cut an SVG onto the model surface', 'svgEmboss', 'toolbar'),
  tool('tool_hollow', 'Hollow', 'hollow', 'Hollow the model with an internal shell', 'hollowModel', 'toolbar'),

  // ---- Object context-menu ops (Orca right-click) ----
  tool('add_modifier', 'Add Modifier', 'modifier', 'Add a modifier volume with per-region settings', 'addModifier'),
  tool(
    'add_support_enforcer',
    'Add Support Enforcer',
    'support_enforcer',
    'Add a volume that forces supports inside it',
    'addSupportEnforcer',
  ),
  tool(
    'add_support_blocker',
    'Add Support Blocker',
    'support_blocker',
    'Add a volume that blocks supports inside it',
    'addSupportBlocker',
  ),
  tool(
    'add_height_range',
    'Add Height-range Modifier',
    'height_range',
    'Override settings for a Z height range',
    'addHeightRange',
  ),
  tool(
    'set_negative_part',
    'Set as Negative Part',
    'negative_part',
    'Turn the selected part into a negative (cut) volume',
    'setNegativePart',
  ),
  tool(
    'variable_layer_height',
    'Variable Layer Height',
    'layers_edit',
    'Paint per-Z layer heights on the model',
    'variableLayerHeight',
  ),
];
