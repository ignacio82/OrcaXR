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
  'tool_brim_ears',
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
  tool('tool_brim_ears', 'Brim Ears', 'brim_ears', 'Place brim "mouse ears" at chosen points', 'brimEars', 'toolbar'),
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
