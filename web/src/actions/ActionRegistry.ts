/**
 * ActionRegistry — the ONE declaration of everything OrcaXR can do.
 *
 * Both shells render from this list, so presentation reachability cannot drift
 * silently. A surface-specific exclusion must live here with an exact reason;
 * for example, an XR control is withheld while its only completion flow is a
 * DOM dialog.
 * Presentation metadata and executable capability truth are deliberately
 * separate. A visible control can therefore describe an unavailable upstream
 * outcome without pretending that a status message is an implementation.
 *
 * Handlers receive an {@link ActionContext} plus bounded transient invocation
 * data — they never touch presentation nodes, so the same guarded code path
 * runs from DOM, XR, keyboard, automation, or the command palette.
 */
import type { EmbossRecipePatch } from '../workspace/OrcaWorkspace';
import type { ActionContext } from './ActionContext';
import type { FilamentId, PlateId } from '../project/domain/ids';
import type { ConfigMap } from '../project/domain/model';
import type { ObjectTreeEntityRef } from '../project/objects';
import type { ScopedOverrideTarget } from '../project/scopedOverrides';
import type { PrinterConsoleOperation } from '../printer/PrinterConsole';
import type { PrinterStorageOperation } from '../printer/PrinterStorage';
import type { PresetLibraryOperation } from '../settings/presets/PresetLibrary';
import type { CalibrationHistoryOperation } from '../project/calibration/history';
import type { AssemblyAlignmentKind } from '../project/objects/assembly';
import type { PaintChannel, PaintToolKind } from '../project/painting/PaintStrokeService';
import type { GcodePreviewViewPatch } from '../slicer/GcodePreviewSession';
import type {
  CanonicalFilamentAssignableEntityRef,
  CanonicalLayerEventMutationRequest,
  CanonicalSemanticLayerRangeRequest,
  CanonicalSemanticVolumeRoleRequest,
  CanonicalVirtualFilamentMutationRequest,
} from '../workspace/CanonicalWorkspaceController';
import {
  parityHelpHrefForTask,
  parityTaskForAction,
  registryMetadataTestId,
  type ParityTaskId,
} from './CapabilityEvidence';
import type { UiStateShape } from './UiState';

/** Top-level taxonomy. Powers the Add/Tools menus, inspector, command palette. */
export type GroupId =
  | 'file'
  | 'edit'
  | 'view'
  | 'scene'
  | 'paint'
  | 'slice'
  | 'filament'
  | 'output'
  | 'calibration'
  | 'advanced'
  | 'help'
  | 'system';

/**
 * Where an action surfaces:
 *  - `primary`   — always-visible primary bar (Load / Slice / Preview / Download)
 *  - `toolbar`   — the left tool rail (modal gizmos, paint)
 *  - `menu`      — grouped `Add ▾` / `Tools ▾` popovers
 *  - `inspector` — contextual controls inside the right inspector panel
 * Every action is also reachable by name from the command palette.
 */
export type Disclosure = 'primary' | 'toolbar' | 'menu' | 'inspector';

export type CapabilityStatus = 'implemented' | 'partial' | 'unavailable' | 'blocked';

export type ActionSurface =
  | 'dom-primary'
  | 'dom-toolbar'
  | 'dom-menu'
  | 'dom-inspector'
  | 'dom-context'
  | 'command-palette'
  | 'keyboard'
  | 'xr-primary'
  | 'xr-toolbar'
  | 'xr-menu'
  | 'xr-inspector'
  | 'xr-context'
  | 'automation';

/**
 * What a context menu was opened *on* (P11.2).
 *
 * Upstream has two: right-click a model and right-click the bed. Empty space is
 * the plate rather than a third target, because that is what a right-click on
 * the bed means to the person doing it — "do something to this plate" — and a
 * menu that split them would ask the operator to know where the plate ends.
 */
export type ContextTarget = 'object' | 'plate';

export type PrerequisiteId =
  | 'has-model'
  | 'has-selection'
  | 'has-instance-selection'
  | 'has-clipboard'
  | 'has-gcode'
  | 'has-two-models'
  | 'has-multiple-plates'
  | 'not-slicing'
  | 'preflight-clear'
  | 'projection-healthy'
  | 'printer-printing'
  | 'printer-paused'
  | 'printer-job-active'
  | 'printer-connected';

export interface Capability {
  status: CapabilityStatus;
  /** Required unless status is implemented. Shown verbatim when disabled. */
  reason?: string;
  surfaces: readonly ActionSurface[];
  prerequisites: readonly PrerequisiteId[];
  /**
   * Evidence IDs for this declared status. `actions.registry.metadata-only.*`
   * proves registry metadata/reachability only, never behavioral acceptance.
   */
  testIds: readonly string[];
  /** Exact owning task in the pinned parity plan. */
  parityTaskId: ParityTaskId;
  /** Link to the owning task's real, linkable phase heading. */
  helpHref: string;
}

/** Transient, non-canonical target data supplied by a presentation surface. */
export interface ActionInvocation {
  /** Exact plate selected by a plate-local control; omitted for the active plate. */
  plateId?: PlateId;
  /** Revision-bound target emitted by the canonical plate manager. */
  plateTarget?: {
    readonly plateId: PlateId;
    readonly sourceRevision: number;
  };
  /** Bounded canonical plate rename request. */
  plateRename?: {
    readonly plateId: PlateId;
    readonly nextName: string;
    readonly sourceRevision: number;
  };
  /** Complete ordered plate-ID permutation from one canonical snapshot. */
  plateReorder?: {
    readonly orderedPlateIds: readonly PlateId[];
    readonly sourceRevision: number;
  };
  /** Canonical include/exclude request for one plate. */
  platePrintable?: {
    readonly plateId: PlateId;
    readonly printable: boolean;
    readonly sourceRevision: number;
  };
  /** Complete raw engine-wire settings maps guarded by their canonical source. */
  projectSettingsApply?: {
    readonly inheritedConfig: Readonly<ConfigMap>;
    readonly overrides: Readonly<ConfigMap>;
    readonly sourceRevision: number;
    readonly sourceHash: string;
  };
  /**
   * Complete next override map for one addressed node, guarded by the snapshot
   * it was drafted against. The map is the whole scope, not a patch, so an
   * omitted key means "inherit" rather than "leave alone".
   */
  scopedSettingsApply?: {
    readonly target: ScopedOverrideTarget;
    readonly overrides: Readonly<ConfigMap>;
    readonly sourceRevision: number;
    readonly sourceHash: string;
  };
  /** One printer-storage operation requested by a storage surface (P9.5). */
  printerStorage?: PrinterStorageOperation;
  /** One console command or macro invocation requested by a console surface (P9.6). */
  printerConsole?: PrinterConsoleOperation;
  /** Offset into the printer's own job ordering, for a paged history surface. */
  printHistoryStart?: number;
  /** Camera the surface wants shown; omitted keeps the current selection. */
  printerCameraUid?: string;
  /**
   * True when the surface already took an explicit confirmation gesture for a
   * destructive printer command — the status surface's hold (P9.7). The shell
   * then does not ask a second time; one act, one confirmation.
   */
  printJobPreconfirmed?: boolean;
  /** One calibration-ledger change requested by a history surface (P8.5). */
  calibrationHistory?: CalibrationHistoryOperation;
  /** One preset-library change requested by a setup surface (P6.4). */
  presetLibrary?: PresetLibraryOperation;
  /** Exact canonical entity set requested by an Objects surface. */
  objectsSelection?: {
    readonly refs: readonly ObjectTreeEntityRef[];
    readonly primary?: ObjectTreeEntityRef;
  };
  /** Bounded canonical rename request from an inline Objects editor. */
  objectsRename?: {
    readonly entity: Extract<ObjectTreeEntityRef, { kind: 'object' | 'volume' }>;
    readonly name: string;
  };
  /** Canonical row requested by an Objects reveal control. */
  objectsReveal?: ObjectTreeEntityRef;
  /** Revision-guarded stable-ID assignment requested by an Objects inspector. */
  objectsFilamentAssignment?: {
    readonly entities: readonly CanonicalFilamentAssignableEntityRef[];
    readonly filamentId: FilamentId | null;
    readonly sourceRevision: number;
    readonly sourceHash: string;
  };
  /** Revision/hash/object-bound conversion of one existing semantic volume. */
  semanticVolumeRole?: CanonicalSemanticVolumeRoleRequest;
  /** Revision/hash/object-bound height-range lifecycle request. */
  semanticLayerRange?: CanonicalSemanticLayerRangeRequest;
  /** Revision-guarded add/edit/delete of one authored layer event. */
  layerEventMutation?: CanonicalLayerEventMutationRequest;
  /** Complete revision/hash-guarded FullSpectrum add/edit/duplicate/toggle/delete request. */
  virtualFilamentMutation?: CanonicalVirtualFilamentMutationRequest;
  /** Explicit app preference plus the pinned count-bound confirmation, when required. */
  fullSpectrumAutoPairPreference?: {
    readonly enabled: boolean;
    readonly confirmedPhysicalCount?: number;
  };
  /**
   * Bounded colour-paint configuration from a paint surface. `filamentId`
   * carries a stable physical or mixed identity; `null` selects erase-to-inherit.
   */
  /** Bounded G-code preview view change from a viewer surface. */
  previewView?: GcodePreviewViewPatch;
  paintConfiguration?: {
    /** Facet channel the next stroke authors. */
    readonly channel?: PaintChannel;
    /** Assigned state for a non-colour channel, e.g. `enforce`. */
    readonly channelState?: string | boolean;
    readonly filamentId?: FilamentId | null;
    readonly mode?: 'paint' | 'erase';
    readonly tool?: PaintToolKind;
    readonly radiusMm?: number;
    readonly smartFillAngleDegrees?: number;
    readonly heightRangeMm?: number;
    readonly gapAreaMm2?: number;
  };
  /**
   * Bounded Smart Paint change from the assistant panel. Consent is explicit
   * per payload kind, and a region destination is a stable canonical state —
   * never a predicted colour.
   */
  smartPaint?: {
    readonly consent?: { readonly geometry?: boolean; readonly image?: boolean };
    readonly prompt?: string;
    /** Base64 reference image, or `null` to detach the current one. */
    readonly imageBase64?: string | null;
    readonly region?: { readonly id: string; readonly value: string | boolean | null };
  };
  /** Index of the placed brim ear to remove. */
  brimEarIndex?: number;
  /** Front radius, in millimetres, for the next placed brim ear. */
  brimEarRadiusMm?: number;
  /** Percent of triangles to remove, matching the pinned decimate ratio. */
  simplifyRatio?: number;
  /**
   * Drive decimation by quadric error instead of by count — the pinned
   * `use_count` switch, inverted. When set, `simplifyMaxError` is the limit and
   * `simplifyRatio` is ignored.
   */
  simplifyByError?: boolean;
  /** Largest quadric error a collapse may cost, when driving by error. */
  simplifyMaxError?: number;
  /** Exploded-view factor; 1 is fully assembled. View state, never canonical. */
  explosionFactor?: number;
  /** Which pinned calibration the parameter surface is configuring. */
  calibrationWorkflowId?: string;
  /** One calibration parameter, as typed; the form owns the parsing. */
  calibrationParameter?: { readonly key: string; readonly text: string };
  /**
   * Bounded emboss request. The font arrives as bytes the operator picked: a
   * browser cannot enumerate installed fonts and the CSP forbids fetching one,
   * so there is no name-only form of this parameter.
   */
  emboss?: {
    readonly font?: { readonly name: string; readonly bytes: Uint8Array };
    readonly recipe?: EmbossRecipePatch;
  };
  /**
   * Bounded SVG-part request. The drawing arrives as text the operator picked;
   * nothing is fetched, so there is no URL form of this parameter.
   */
  svg?: {
    readonly drawing?: { readonly name: string; readonly source: string };
    readonly size?: { readonly depthMm?: number; readonly widthMm?: number };
  };
  /** Bounded assembly alignment request from the Measure panel. */
  assemblyAlignment?: {
    readonly kind: AssemblyAlignmentKind;
    /** Millimetres for `parallel-distance`, degrees for `around-face-center`. */
    readonly parameter?: number;
  };
}

export type ActionHandler = (ctx: ActionContext, invocation: Readonly<ActionInvocation>) => void | Promise<void>;

/** Source presentation before ActionRegistry attaches validated capability truth. */
export interface ActionDefinition {
  /** Stable id; matches the MCP tool id where a 1:1 tool exists. */
  id: string;
  label: string;
  /** Semantic icon key resolved by `ui/icons.ts` for each shell. */
  icon: string;
  group: GroupId;
  disclosure: Disclosure;
  /**
   * For `disclosure: 'menu'` actions: which header menu they live under. The
   * order here is the left-to-right menu-bar order, mirroring Snapmaker Orca's
   * File / Edit / View / Add / Tools / Calibration / Help menu bar.
   */
  menuSection?: MenuSection;
  /** One-line description for tooltips / the command palette. */
  hint?: string;
  /** For toolbar tools: the tool this action selects (drives active state). */
  tool?: string;
  /**
   * Context menus this action belongs to, if any (P11.2).
   *
   * A context menu is a *placement*, not a second catalog: an action names the
   * targets it makes sense on, and every shell renders the same set with the
   * same availability. An action that needs a payload the menu cannot supply
   * stays out — a row that can only report "pick one first" is worse than no
   * row, because the operator already picked one.
   */
  context?: readonly ContextTarget[];
  /**
   * Canonical Android MCP tool this action drives, when one exists. Several UI
   * actions may map onto one tool (e.g. the three `add_primitive_*` buttons →
   * `add_primitive`). The parity test asserts every `mcpTool` is a real member
   * of the 163-tool MCP surface, tying the web UI to the canonical catalogue.
   */
  mcpTool?: string;
  /** Keyboard gestures routed through this same registry entry. */
  shortcuts?: readonly string[];
  /** Default true. Return false to render disabled for the given state. */
  isEnabled?(s: Readonly<UiStateShape>): boolean;
  /** Default true. Return false to hide entirely for the given state. */
  isVisible?(s: Readonly<UiStateShape>): boolean;
  /**
   * Exact reason this action is intentionally withheld from immersive XR.
   * Use this only when the current handler crosses into a DOM-only flow; the
   * registry then omits the XR presentation surface instead of advertising a
   * control that cannot be completed in-headset.
   */
  xrUnsupportedReason?: string;
  /** Omitted for unavailable/blocked outcomes. */
  run?: ActionHandler;
}

/** Fully normalized entry returned by ActionRegistry. */
export type Action = ActionDefinition & { readonly capability: Capability };

export type ActionAvailability =
  { state: 'hidden'; reason: string } | { state: 'disabled'; reason: string } | { state: 'enabled' };

/**
 * Menu-bar sections, in left-to-right order. Mirrors Snapmaker Orca's menu bar
 * (File / Edit / View / … Help) so a user of desktop Orca finds every command
 * where they expect it. `add` and `tools` are OrcaXR's consolidation of Orca's
 * top 3D toolbar (add primitive / import) and object operations.
 */
export type MenuSection = 'file' | 'edit' | 'view' | 'add' | 'tools' | 'calibration' | 'help';

export const MENU_SECTIONS: readonly { id: MenuSection; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'add', label: 'Add' },
  { id: 'tools', label: 'Tools' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'help', label: 'Help' },
];

export interface ActionGroup {
  id: GroupId;
  label: string;
  icon: string;
  /** Sort order in menus / group selectors. */
  order: number;
}

/**
 * The XR menu's own section for everything the DOM shell puts in its
 * inspector. It is not an upstream menu, so it is named here rather than in
 * {@link MENU_SECTIONS}.
 */
export const XR_PANELS_SECTION_ID = 'xr-panels';

export const GROUPS: readonly ActionGroup[] = [
  { id: 'file', label: 'File', icon: 'file', order: 0 },
  { id: 'edit', label: 'Edit', icon: 'edit', order: 1 },
  { id: 'view', label: 'View', icon: 'view', order: 2 },
  { id: 'scene', label: 'Scene', icon: 'scene', order: 3 },
  { id: 'paint', label: 'Paint', icon: 'paint', order: 4 },
  { id: 'slice', label: 'Slice', icon: 'slice', order: 5 },
  { id: 'filament', label: 'Filament', icon: 'filament', order: 6 },
  { id: 'output', label: 'Output', icon: 'output', order: 7 },
  { id: 'calibration', label: 'Calibration', icon: 'calibration', order: 8 },
  { id: 'advanced', label: 'Advanced', icon: 'advanced', order: 9 },
  { id: 'help', label: 'Help', icon: 'help', order: 10 },
  { id: 'system', label: 'System', icon: 'system', order: 11 },
];

const CANONICAL_CUTOVER_GATED_REASONS = {
  file_export_3mf:
    'Generic geometry 3MF export is disabled because the current exporter drops canonical project metadata and stable identities.',
  edit_cut:
    'Cut is disabled because the legacy clipboard drops canonical object metadata and cannot delete through the same atomic command.',
  edit_copy:
    'Copy is disabled because the legacy clipboard does not preserve the complete canonical object and instance graph.',
  edit_paste:
    'Paste is disabled until clipboard content can be validated and inserted through one canonical command with fresh stable IDs.',
  edit_delete_all:
    'Delete All is disabled until active-plate instances can be removed through one reversible canonical transaction.',
  repair_model:
    'Mesh repair is disabled until topology replacement invalidates facet metadata and commits through a guarded canonical command.',
  mesh_boolean_union:
    'Mesh union is disabled until topology-changing booleans preserve canonical metadata and commit atomically.',
  mesh_boolean_subtract:
    'Mesh subtraction is disabled until topology-changing booleans preserve canonical metadata and commit atomically.',
  mesh_boolean_intersection:
    'Mesh intersection is disabled until topology-changing booleans preserve canonical metadata and commit atomically.',
  tool_cut:
    'Plane cutting is disabled until canonical topology, annotations, assets, and stable IDs can be replaced atomically.',
  auto_place_wipe:
    'Wipe-tower auto-placement is disabled until its position is computed and stored through canonical project commands.',
} as const satisfies Readonly<Record<string, string>>;

const CANONICAL_CUTOVER_GATED_IDS = new Set<string>(Object.keys(CANONICAL_CUTOVER_GATED_REASONS));

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  ...CANONICAL_CUTOVER_GATED_REASONS,
  add_magnet: 'Magnet-hole geometry is not implemented yet; no model will be changed.',
  scan_network: 'Local-network printer discovery is not implemented yet.',
  recreate_model_colors_fullspectrum:
    'Canonical Full-Spectrum color recreation with facet assignments, preview, undo, persistence, and slice validation is not implemented yet.',
  file_export_all_plates: 'All-plate slicing and export is not implemented yet.',
  file_export_obj: 'Toolpath OBJ export is not implemented yet.',
  file_open_gcode: 'Standalone G-code import and viewing is not implemented yet.',
  help_config_folder: 'Browsers cannot reveal a native config folder; the web adaptation is not implemented yet.',
  // Not "not yet": the renderer's camera is created and owned by xrblocks as a
  // PerspectiveCamera, and inside a session WebXR supplies its own projection
  // matrix per view. Forcing an orthographic matrix onto it would render
  // orthographically while `Raycaster` still branched on the camera type, so
  // every pick would be computed against a projection the user is not looking
  // through — right-looking and wrong. Recorded as ADAPT-14.
  view_perspective_toggle:
    'Orthographic projection is unavailable: the render camera belongs to the XR runtime, which supplies its own perspective projection. See ADAPT-14.',
  view_auto_perspective:
    "Auto-switching needs an orthographic mode, which the XR runtime's camera does not offer. See ADAPT-14.",
  view_show_gcode_window: 'The G-code text inspector is not implemented yet.',
  split_to_parts: 'Splitting an object into editable parts is not implemented yet.',
  tool_face_detector: 'Face detection and selection is not implemented yet.',
  tool_hollow: 'Model hollowing is not implemented yet.',
  add_modifier: 'Parameter-modifier volumes are not implemented yet.',
  add_support_enforcer: 'Support-enforcer volumes are not implemented yet.',
  add_support_blocker: 'Support-blocker volumes are not implemented yet.',
  add_height_range: 'Layer-height-range settings are not implemented yet.',
  set_negative_part: 'Negative-part volume semantics are not implemented yet.',
  variable_layer_height: 'Variable layer-height editing is not implemented yet.',
};

const INSTANCE_SELECTION_PREREQUISITES = new Set([
  'edit_cut',
  'edit_copy',
  'edit_duplicate',
  'edit_delete_selected',
  'delete_models',
  'repair_model',
  'simplify_model',
  'drop_to_bed',
  'split_to_objects',
  'tool_move',
  'tool_rotate',
  'tool_scale',
  'tool_lay_on_face',
  'tool_paint',
  'tool_cut',
  'tool_smart_paint',
  'tool_smart_paint_image',
]);
const SELECTION_PREREQUISITES = new Set(['edit_deselect_all']);
const MODEL_PREREQUISITES = new Set([
  'edit_delete_all',
  'file_save_project',
  'file_save_project_as',
  'file_export_stl',
  'file_export_3mf',
  'view_show_labels',
  'view_show_overhang',
  'view_show_wireframe',
]);
const GCODE_PREREQUISITES = new Set([
  'file_export_gcode',
  'save_gcode_to_downloads',
  'send_to_printer',
  'toggle_preview',
]);
const TWO_MODEL_PREREQUISITES = new Set(['mesh_boolean_union', 'mesh_boolean_subtract', 'mesh_boolean_intersection']);

function prerequisitesFor(action: ActionDefinition): PrerequisiteId[] {
  const prerequisites: PrerequisiteId[] = [];
  if (INSTANCE_SELECTION_PREREQUISITES.has(action.id)) prerequisites.push('has-instance-selection');
  else if (SELECTION_PREREQUISITES.has(action.id)) prerequisites.push('has-selection');
  if (MODEL_PREREQUISITES.has(action.id)) prerequisites.push('has-model');
  if (GCODE_PREREQUISITES.has(action.id)) prerequisites.push('has-gcode');
  if (TWO_MODEL_PREREQUISITES.has(action.id)) prerequisites.push('has-two-models');
  if (action.id === 'edit_paste') prerequisites.push('has-clipboard');
  if (action.id === 'delete_plate') prerequisites.push('has-multiple-plates');
  if (action.id === 'file_save_project' || action.id === 'file_save_project_as') {
    prerequisites.push('projection-healthy');
  }
  if (action.id === 'slice_active_plate') {
    prerequisites.push('has-model', 'not-slicing', 'preflight-clear', 'projection-healthy');
  }
  if (action.id === 'printer_pause_print') prerequisites.push('printer-printing');
  if (action.id === 'printer_resume_print') prerequisites.push('printer-paused');
  if (action.id === 'printer_cancel_print') prerequisites.push('printer-job-active');
  // Deliberately not gated on a job: a hard stop is what an operator reaches
  // for when the machine is doing something it should not be doing at all.
  if (action.id === 'printer_emergency_stop') prerequisites.push('printer-connected');
  return [...new Set(prerequisites)];
}

/**
 * Menu actions that also own a dedicated inspector control. Orca keeps these in
 * a menu, but the panel that configures them carries the same action as a
 * button; without the extra surface that button would be silently hidden.
 */
const INSPECTOR_MIRRORED = new Set(['send_to_printer', 'view_webcam']);

function surfacesFor(action: ActionDefinition): ActionSurface[] {
  const surfaces: ActionSurface[] = ['command-palette'];
  if (action.disclosure === 'primary') {
    surfaces.push('dom-primary');
    if (!action.xrUnsupportedReason) surfaces.push('xr-primary');
  } else if (action.disclosure === 'toolbar') {
    surfaces.push('dom-toolbar');
    if (!action.xrUnsupportedReason) surfaces.push('xr-toolbar');
  } else if (action.disclosure === 'menu') {
    surfaces.push('dom-menu');
    if (!action.xrUnsupportedReason) surfaces.push('xr-menu');
  } else {
    surfaces.push('dom-inspector');
    // An inspector action is reachable in XR through the Panels menu. Without
    // this, every printer, preset, calibration, and settings control would be
    // silently absent from the headset rather than declared unsupported — the
    // registry test below refuses that outcome.
    if (!action.xrUnsupportedReason) surfaces.push('xr-inspector');
  }
  if (INSPECTOR_MIRRORED.has(action.id) && !surfaces.includes('dom-inspector')) surfaces.push('dom-inspector');
  if (action.context?.length) {
    surfaces.push('dom-context');
    // Same rule as every other XR surface: an action withheld from the headset
    // for a stated reason is withheld here too, rather than advertised on a
    // panel where it cannot be completed.
    if (!action.xrUnsupportedReason) surfaces.push('xr-context');
  }
  if (action.shortcuts?.length) surfaces.push('keyboard');
  if (action.mcpTool) surfaces.push('automation');
  return surfaces;
}

function capabilityFor(action: ActionDefinition): Capability {
  const unavailableReason = UNAVAILABLE_REASONS[action.id];
  const status: CapabilityStatus = unavailableReason ? 'unavailable' : 'partial';
  const parityTaskId = parityTaskForAction(action.id);
  return {
    status,
    reason:
      unavailableReason ??
      `Local behavior exists, but Snapmaker v2.3.4 parity has not passed its full acceptance and evidence gate. Tracked by ${parityTaskId}.`,
    surfaces: surfacesFor(action),
    prerequisites: prerequisitesFor(action),
    testIds: status === 'unavailable' ? [] : [registryMetadataTestId(action.id, parityTaskId)],
    parityTaskId,
    helpHref: parityHelpHrefForTask(parityTaskId),
  };
}

const PREREQUISITES: Readonly<
  Record<
    PrerequisiteId,
    {
      met: (state: Readonly<UiStateShape>) => boolean;
      reason: string;
    }
  >
> = {
  'has-model': { met: (state) => state.modelCount > 0, reason: 'Load or create a model first.' },
  'has-selection': { met: (state) => state.hasSelection, reason: 'Select a model first.' },
  'has-instance-selection': {
    met: (state) => state.hasInstanceSelection,
    reason: 'Select a model instance for this action.',
  },
  'has-clipboard': { met: (state) => state.hasClipboard, reason: 'Copy or cut a model first.' },
  'has-gcode': { met: (state) => state.gcodeReady, reason: 'Slice successfully first.' },
  'has-two-models': { met: (state) => state.modelCount >= 2, reason: 'Add at least two models first.' },
  'has-multiple-plates': { met: (state) => state.plateCount > 1, reason: 'The only build plate cannot be deleted.' },
  'not-slicing': { met: (state) => !state.isSlicing, reason: 'Wait for the current slice to finish or cancel it.' },
  'preflight-clear': { met: (state) => !state.preflightBlocked, reason: 'Resolve blocking preflight errors first.' },
  'projection-healthy': {
    met: (state) => state.projectionHealthy,
    reason:
      'The 3D project projection failed for this revision; recover or reopen the project before saving or slicing.',
  },
  // Printer lifecycle prerequisites read the machine's own reported state, so a
  // job started from the printer's screen enables these exactly as one sent
  // from here does.
  'printer-printing': {
    met: (state) => state.printerJobState === 'printing',
    reason: 'The connected printer is not printing.',
  },
  'printer-paused': {
    met: (state) => state.printerJobState === 'paused',
    reason: 'The connected printer has no paused print.',
  },
  'printer-job-active': {
    met: (state) => state.printerJobState === 'printing' || state.printerJobState === 'paused',
    reason: 'The connected printer has no job to act on.',
  },
  'printer-connected': {
    met: (state) => state.printerJobState !== 'disconnected',
    reason: 'Connect to a printer first.',
  },
};

export class ActionRegistry {
  private actions: Action[] = [];
  private byId = new Map<string, Action>();

  /** Register one action (throws on duplicate id — a parity/wiring bug). */
  add(definition: ActionDefinition): this {
    const capability = capabilityFor(definition);
    const canonicalCutoverGate = CANONICAL_CUTOVER_GATED_IDS.has(definition.id);
    if (
      (capability.status === 'unavailable' || capability.status === 'blocked') &&
      definition.run &&
      !canonicalCutoverGate
    ) {
      throw new Error(`ActionRegistry: ${capability.status} action "${definition.id}" must not have a handler`);
    }
    if ((capability.status === 'implemented' || capability.status === 'partial') && !definition.run) {
      throw new Error(`ActionRegistry: executable action "${definition.id}" has no handler`);
    }
    if (capability.status !== 'implemented' && !capability.reason?.trim()) {
      throw new Error(`ActionRegistry: ${capability.status} action "${definition.id}" needs a reason`);
    }
    if ((capability.status === 'implemented' || capability.status === 'partial') && capability.testIds.length === 0) {
      throw new Error(`ActionRegistry: executable action "${definition.id}" needs a test mapping`);
    }
    // Keep legacy implementations unreachable during the store-first cutover.
    // The registry is the invocation boundary, and only this exact audited set
    // may have a catalog handler deliberately stripped at registration time.
    const action: Action = {
      ...definition,
      ...(canonicalCutoverGate ? { run: undefined } : {}),
      capability,
    };
    if (this.byId.has(action.id)) {
      throw new Error(`ActionRegistry: duplicate action id "${action.id}"`);
    }
    this.byId.set(action.id, action);
    this.actions.push(action);
    return this;
  }

  addAll(actions: Iterable<ActionDefinition>): this {
    for (const a of actions) this.add(a);
    return this;
  }

  get(id: string): Action | undefined {
    return this.byId.get(id);
  }

  all(): readonly Action[] {
    return this.actions;
  }

  /** Actions with a given disclosure, optionally filtered by group. */
  byDisclosure(disclosure: Disclosure, group?: GroupId): Action[] {
    return this.actions.filter((a) => a.disclosure === disclosure && (group === undefined || a.group === group));
  }

  byGroup(group: GroupId): Action[] {
    return this.actions.filter((a) => a.group === group);
  }

  forSurface(surface: ActionSurface): Action[] {
    return this.actions.filter((action) => action.capability.surfaces.includes(surface));
  }

  /**
   * What a context menu on one target offers, in catalog order (P11.2).
   *
   * Order is the catalog's, not the caller's, so the same right-click gives the
   * same menu in the scene, in the Objects tree, and in the headset.
   */
  forContext(target: ContextTarget, surface: 'dom-context' | 'xr-context' = 'dom-context'): Action[] {
    return this.forSurface(surface).filter((action) => action.context?.includes(target));
  }

  availability(actionOrId: Action | string, surface: ActionSurface, state: Readonly<UiStateShape>): ActionAvailability {
    const action = typeof actionOrId === 'string' ? this.get(actionOrId) : actionOrId;
    if (!action) return { state: 'hidden', reason: 'Unknown action.' };
    if (!action.capability.surfaces.includes(surface)) {
      return {
        state: 'hidden',
        reason:
          surface.startsWith('xr-') && action.xrUnsupportedReason
            ? action.xrUnsupportedReason
            : `Not offered on ${surface}.`,
      };
    }
    if (action.isVisible && !action.isVisible(state)) {
      return { state: 'hidden', reason: 'Not applicable in the current workspace state.' };
    }
    if (action.capability.status === 'unavailable' || action.capability.status === 'blocked') {
      return { state: 'disabled', reason: action.capability.reason ?? 'Unavailable.' };
    }
    for (const prerequisite of action.capability.prerequisites) {
      const rule = PREREQUISITES[prerequisite];
      if (!rule.met(state)) return { state: 'disabled', reason: rule.reason };
    }
    if (action.isEnabled && !action.isEnabled(state)) {
      return { state: 'disabled', reason: 'Not available in the current workspace state.' };
    }
    return { state: 'enabled' };
  }

  async invoke(
    actionOrId: Action | string,
    surface: ActionSurface,
    ctx: ActionContext,
    state: Readonly<UiStateShape>,
    invocation: Readonly<ActionInvocation> = {},
  ): Promise<boolean> {
    const action = typeof actionOrId === 'string' ? this.get(actionOrId) : actionOrId;
    if (!action) return false;
    const availability = this.availability(action, surface, state);
    if (availability.state !== 'enabled') {
      if (availability.state === 'disabled') {
        ctx.reportCapabilityUnavailable(action.label, availability.reason);
      }
      return false;
    }
    await action.run?.(ctx, invocation);
    return true;
  }

  /** Compatibility wrappers for non-rendering callers; prefer availability(). */
  static enabled(a: Action, s: Readonly<UiStateShape>): boolean {
    if (a.capability.status === 'unavailable' || a.capability.status === 'blocked') return false;
    for (const prerequisite of a.capability.prerequisites) {
      if (!PREREQUISITES[prerequisite].met(s)) return false;
    }
    return a.isEnabled ? a.isEnabled(s) : true;
  }
  static visible(a: Action, s: Readonly<UiStateShape>): boolean {
    return a.isVisible ? a.isVisible(s) : true;
  }
  static disabledReason(a: Action, s: Readonly<UiStateShape>): string | undefined {
    if (a.capability.status === 'unavailable' || a.capability.status === 'blocked') {
      return a.capability.reason;
    }
    for (const prerequisite of a.capability.prerequisites) {
      const rule = PREREQUISITES[prerequisite];
      if (!rule.met(s)) return rule.reason;
    }
    if (a.isEnabled && !a.isEnabled(s)) return 'Not available in the current workspace state.';
    return undefined;
  }
}
