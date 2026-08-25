/**
 * XrLayout — where the immersive shell's surfaces sit around the operator.
 *
 * The XR shell used to place its cards by hand: a lateral offset, a height, a
 * depth nudge, and `rotation.set(0, yaw, 0)` for every one of them. That has
 * two consequences you can see the moment you put the headset on. Every panel
 * is *parallel* to the one dead ahead, so a rail half a metre to the left is
 * read at a glancing angle; and because the offsets are metres rather than
 * angles, panels that look separated on paper overlap in the field of view
 * while the rest of the room stays empty.
 *
 * So the arrangement is expressed the way it is actually experienced: as
 * **angles from the head**. Each surface declares an azimuth, an elevation, a
 * radius and a physical size; {@link surfaceTransform} turns that into a world
 * position on the sphere around the operator plus an orientation that faces
 * them. Constant radius keeps every panel at one focus distance and one
 * apparent size — the two things that make a spatial UI restful — and facing
 * the head is what makes text legible off-axis.
 *
 * The numbers below are ergonomics, not taste:
 *
 *  - **±35° azimuth** is the comfortable range for eyes-only scanning; beyond
 *    ~55° an adult is turning their neck for every glance.
 *  - **+20° / −40° elevation**: looking down is markedly more comfortable than
 *    looking up, which is why the work sits low and only the menu bar is above
 *    the horizon.
 *  - **0.8–1.1 m radius** clears arm's reach for direct touch while staying
 *    inside the range where vergence and focus still agree. A surface that is
 *    *spawned at the hand* — a context menu, a keypad — is deliberately closer,
 *    because it belongs to the fingertip that opened it.
 *  - A control is comfortably hittable at about **2.5° of arc** or more, which
 *    at 1 m is a ~45 mm target. The redesign's floor is 58 mm, drawn as 58
 *    layout px, which is why {@link XR_PIXEL_SIZE} is exactly a millimetre.
 *
 * Two facts about a surface are separate on purpose and are what the geometry
 * tests read:
 *
 *  - {@link XrSurfaceSpec.layer} is *behaviour* — whether the operator may pick
 *    the panel up, whether it takes the middle of the view, whether it belongs
 *    to a fingertip. It is the vocabulary the redesign uses.
 *  - {@link XrSurfaceSpec.presence} plus {@link XrSurfaceSpec.modes} is
 *    *coexistence* — which surfaces are actually up together, and therefore
 *    which pairs may not crowd each other. A sheet the operator opened is
 *    allowed to cover the inspector it was opened from; the cockpit that is
 *    always up is not.
 *
 * `__tests__/xr-layout.test.ts` holds the geometry to those numbers, and —
 * because "crammed together" is the complaint this module exists to answer —
 * asserts that no two surfaces which are up in the same workspace mode overlap
 * in the field of view.
 */
import * as THREE from 'three';

/** Every spatial surface the immersive shell can put in front of the operator. */
export type XrSurfaceId =
  | 'menubar'
  | 'tools'
  | 'inspector'
  | 'desk'
  | 'palette'
  | 'menu'
  | 'context'
  | 'keypad'
  | 'keyboard'
  | 'sheet'
  | 'scrubber';

/**
 * How a surface behaves once it is up.
 *
 * `anchored` surfaces never move: the menu bar and the action desk are where
 * the operator looks when they are lost, so they may not wander. `grabbable`
 * surfaces start on their anchor and can be pulled off it, placed where the
 * work is, and pinned there. A `modal` surface is shown alone, in front of the
 * work, and is allowed to cover whatever it needs to. A `transient` surface is
 * spawned at the hand or at the field it edits and is gone on the next press.
 */
export type XrSurfaceLayer = 'anchored' | 'grabbable' | 'modal' | 'transient';

/**
 * Whether a surface is part of the cockpit or is opened deliberately.
 *
 * Only `default` surfaces compete for space: they are up together for as long
 * as the session lasts, so two of them overlapping is a defect. An `on-demand`
 * surface is the answer to a press and may cover what it was opened from.
 */
export type XrSurfacePresence = 'default' | 'on-demand';

/** The four workspaces, mirroring the flat shell's tab strip. */
export type XrWorkspaceMode = 'prepare' | 'preview' | 'device' | 'project';

export const XR_WORKSPACE_MODES: readonly XrWorkspaceMode[] = ['prepare', 'preview', 'device', 'project'];

/**
 * Metres per layout pixel.
 *
 * Exactly one millimetre, so a panel's drawn geometry and its physical size are
 * the same number in two units: a 58 px button is a 58 mm target, and the
 * 880 px menu bar the redesign was drawn at is 0.88 m wide. Card sizes below
 * and layout pixels inside them therefore cannot disagree — which they did,
 * when a 1.0 m strip declared 1000 px at 0.0012 m/px and uikit laid out 1.2 m
 * of content inside a 1.0 m card.
 */
export const XR_PIXEL_SIZE = 0.001;

export interface XrSurfaceSpec {
  readonly id: XrSurfaceId;
  /** Degrees around the operator; positive is to their right. */
  readonly azimuthDeg: number;
  /** Degrees from eye level; positive is above the horizon. */
  readonly elevationDeg: number;
  /** Distance from the head, in metres. */
  readonly radius: number;
  /** Physical panel size in metres. */
  readonly sizeX: number;
  readonly sizeY: number;
  /**
   * Degrees laid back from facing the operator, toward lying flat. A low
   * surface that merely faces the head stands up like a wall in front of the
   * work; leaning it back turns it into a drafting table, and foreshortens it
   * so it takes less of the view.
   */
  readonly leanDeg?: number;
  readonly layer: XrSurfaceLayer;
  readonly presence: XrSurfacePresence;
  /** Workspace modes this surface is up in. Only meaningful when `default`. */
  readonly modes: readonly XrWorkspaceMode[];
}

const ALL_MODES = XR_WORKSPACE_MODES;

/**
 * The arrangement.
 *
 * Read it as a cockpit: the work (the build plate) sits low and central at
 * arm's length, the menu bar rides just above it, the tools fall under the
 * left hand and the panel host under the right, and the primary actions lie
 * below the plate tilted up like a control desk. Nothing is directly overhead
 * and nothing is behind the plate.
 *
 * Every surface names the flat-shell chrome it mirrors, because that is the
 * whole point of the redesign: the same menu bar, the same workspace tabs, the
 * same tool rail, the same panels under the same names.
 */
export const XR_SURFACES: readonly XrSurfaceSpec[] = [
  // The flat shell's menu strip and tab strip, stacked. It carries the seven
  // MENU_SECTIONS, the Panels section, the command palette, undo/redo,
  // recenter, Exit XR, the four workspace tabs and the printer status — which
  // is why it is the widest surface in the layout and the one that never moves.
  {
    id: 'menubar',
    azimuthDeg: 0,
    elevationDeg: 18,
    radius: 1.05,
    sizeX: 0.88,
    sizeY: 0.17,
    layer: 'anchored',
    presence: 'default',
    modes: ALL_MODES,
  },
  // Tool rail, under the left hand and turned toward the operator. Three
  // columns of 58 mm targets: 0.20 m clipped its third group entirely.
  {
    id: 'tools',
    azimuthDeg: -38,
    elevationDeg: -10,
    radius: 0.9,
    sizeX: 0.21,
    sizeY: 0.72,
    leanDeg: 18,
    layer: 'grabbable',
    presence: 'default',
    modes: ALL_MODES,
  },
  // The panel host: whatever the flat shell's sidebar would be showing. Open
  // panels stack as tabs, because a column of fold-away cards is right for a
  // 1600 px window and wrong for a 720 px spatial panel. (The drawing also
  // tears a tab off into a surface of its own; that is not implemented.)
  //
  // The drawing puts this at +36°. One degree further out is what keeps a
  // finger's width of clear space between it and the preview scrubber, which
  // is 0.62 m wide and centred; at +36° the two were 2.98° apart.
  {
    id: 'inspector',
    azimuthDeg: 37,
    // Drawn at −4°. Dropped to −11° because the menu bar above it is 0.88 m
    // wide — ±22.8° — and the inspector's own inner edge is at +23.4°: the two
    // are within a degree of each other horizontally, so the clear space
    // between them has to be vertical.
    elevationDeg: -11,
    radius: 0.95,
    sizeX: 0.46,
    sizeY: 0.72,
    layer: 'grabbable',
    presence: 'default',
    modes: ALL_MODES,
  },
  // Primary actions, plates and slice progress, below the plate and tilted up
  // like a control desk.
  {
    id: 'desk',
    azimuthDeg: 0,
    // Drawn at −44°, which puts the desk's lower edge 48° below eye level —
    // past this layout's own comfort floor. Raised to −41.5°: the same desk,
    // still well clear of the plate's near edge at −33.7°, and its bottom edge
    // lands at −45.9°.
    elevationDeg: -41.5,
    radius: 0.85,
    sizeX: 0.64,
    sizeY: 0.15,
    leanDeg: 30,
    layer: 'anchored',
    presence: 'default',
    modes: ALL_MODES,
  },
  // G-code toolpath scrubbing, docked at the front of the plate — which is
  // where a physical machine puts its controls, and where the operator is
  // already looking while a layer is being read.
  {
    id: 'scrubber',
    azimuthDeg: 0,
    elevationDeg: -24,
    radius: 0.88,
    sizeX: 0.62,
    sizeY: 0.17,
    leanDeg: 20,
    layer: 'grabbable',
    presence: 'default',
    modes: ['preview'],
  },
  // Every action by name. Modal because it is the answer to "where is…", and
  // nothing else should be competing for the operator's attention while they
  // are reading a list of 163 things.
  {
    id: 'palette',
    azimuthDeg: 0,
    elevationDeg: -8,
    radius: 0.8,
    sizeX: 0.6,
    sizeY: 0.46,
    layer: 'modal',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
  // Wide panels that will not fit the inspector: Plate Manager, Preset
  // Library, Printer Camera, Calibration History, and the Device and Project
  // workspaces. Modal rather than grabbable: it is a page, it is dead centre
  // because that is where a page belongs, and it is closed rather than parked.
  {
    id: 'sheet',
    azimuthDeg: 0,
    elevationDeg: -4,
    radius: 0.9,
    sizeX: 0.76,
    sizeY: 0.68,
    layer: 'modal',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
  // A menu bar section's rows. Drawn where its own title is, which is the only
  // placement that answers "which menu is this?" without a heading.
  {
    id: 'menu',
    azimuthDeg: 0,
    // The azimuth is taken from whichever title opened it; this elevation is
    // what makes it hang *below* the bar rather than across it.
    elevationDeg: -6,
    radius: 1.0,
    sizeX: 0.4,
    sizeY: 0.56,
    layer: 'transient',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
  // Long-pinch a model or the bed. Spawned at the fingertip, which is why its
  // radius is nearer than anything in the cockpit.
  {
    id: 'context',
    azimuthDeg: 0,
    elevationDeg: -14,
    radius: 0.45,
    sizeX: 0.26,
    sizeY: 0.4,
    layer: 'transient',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
  // Numeric entry, spawned beside the field it edits.
  {
    id: 'keypad',
    azimuthDeg: 0,
    elevationDeg: -14,
    radius: 0.55,
    sizeX: 0.3,
    sizeY: 0.34,
    layer: 'transient',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
  // Text entry. Ten 58 mm keys across is 0.64 m of headset whichever way it is
  // arranged, so this is the one surface whose size is set by the hand rather
  // than by what it says: a keyboard narrow enough to sit where the keypad sits
  // would have keys below the tracking floor.
  {
    id: 'keyboard',
    azimuthDeg: 0,
    elevationDeg: -22,
    radius: 0.72,
    sizeX: 0.72,
    sizeY: 0.48,
    layer: 'transient',
    presence: 'on-demand',
    modes: ALL_MODES,
  },
];

/**
 * Surfaces the operator may pick up, place, and pin.
 *
 * Exactly the `grabbable` ones, listed rather than derived so a recentre — the
 * one gesture that is always the way home — reads from a constant instead of
 * from a filter that a later edit could quietly widen. Anything else either
 * never moves (the menu bar, the desk) or is gone before it could be parked.
 */
export const XR_PINNABLE: readonly XrSurfaceId[] = ['tools', 'inspector', 'scrubber'];

const byId = new Map(XR_SURFACES.map((surface) => [surface.id, surface]));

export function xrSurface(id: XrSurfaceId): XrSurfaceSpec {
  const surface = byId.get(id);
  if (!surface) throw new Error(`XrLayout: no surface named ${id}`);
  return surface;
}

/** The cockpit for one workspace mode: everything up without being asked for. */
export function xrSurfacesInMode(mode: XrWorkspaceMode): readonly XrSurfaceSpec[] {
  return XR_SURFACES.filter((surface) => surface.presence === 'default' && surface.modes.includes(mode));
}

/** Where the operator's head is, and which way it is looking. */
export interface XrHeadPose {
  readonly position: THREE.Vector3;
  /** Gaze direction; only its horizontal component sets the layout's yaw. */
  readonly forward: THREE.Vector3;
}

export interface XrSurfaceTransform {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
}

/** The layout's yaw: the head's facing flattened onto the floor plane. */
function layoutYaw(forward: THREE.Vector3): number {
  const flat = new THREE.Vector3(forward.x, 0, forward.z);
  if (flat.lengthSq() < 1e-8) flat.set(0, 0, -1);
  flat.normalize();
  return Math.atan2(flat.x, flat.z);
}

/**
 * Place one surface around `head`.
 *
 * The position is spherical about the head, so every surface sits at the same
 * focus distance. The orientation starts by facing the head — that is what a
 * side panel needs in order to be read at all — and then applies the surface's
 * own pitch, so a low panel can lie back like a desk instead of standing up
 * like a wall.
 */
export function surfaceTransform(spec: XrSurfaceSpec, head: XrHeadPose): XrSurfaceTransform {
  const yaw = layoutYaw(head.forward);
  const azimuth = THREE.MathUtils.degToRad(spec.azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(spec.elevationDeg);

  // Direction from the head, in the layout's yaw frame. Forward is -Z.
  const direction = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    -Math.cos(azimuth) * Math.cos(elevation),
  ).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI);

  const position = head.position.clone().addScaledVector(direction, spec.radius);
  return { position, quaternion: facing(direction, spec.leanDeg ?? 0) };
}

/**
 * Place a transient surface at the point that spawned it.
 *
 * A context menu belongs to the model the operator long-pinched and a keypad
 * belongs to the field it edits, so neither can be a fixed angle from the head.
 * What they *do* need is the surface's declared radius: a menu drawn at the
 * fingertip 0.25 m away renders at twice the intended angular size and lands
 * inside the operator's near clipping comfort, so the anchor sets the direction
 * and the spec sets the distance.
 */
export function anchoredTransform(spec: XrSurfaceSpec, anchor: THREE.Vector3, head: XrHeadPose): XrSurfaceTransform {
  const direction = anchor.clone().sub(head.position);
  if (direction.lengthSq() < 1e-8) {
    // Nothing to aim at — fall back to the surface's own place in the layout.
    return surfaceTransform(spec, head);
  }
  direction.normalize();
  const position = head.position.clone().addScaledVector(direction, spec.radius);
  return { position, quaternion: facing(direction, spec.leanDeg ?? 0) };
}

/**
 * Drop a surface out of the control that opened it.
 *
 * The azimuth comes from the anchor — that is what makes a File menu appear
 * under the word "File" rather than dead ahead, which is the only thing that
 * answers "which menu is this?" without a heading — while the elevation and
 * radius stay the surface's own, so the popover hangs below the bar instead of
 * across it.
 */
export function droppedTransform(spec: XrSurfaceSpec, anchor: THREE.Vector3, head: XrHeadPose): XrSurfaceTransform {
  const toAnchor = anchor.clone().sub(head.position);
  if (toAnchor.lengthSq() < 1e-8) return surfaceTransform(spec, head);
  // The bearing is read straight off the anchor in world space, so there is no
  // layout frame to rotate back out of: a unit vector on bearing θ is
  // (sin θ, 0, cos θ), tilted by the surface's own elevation.
  const bearing = Math.atan2(toAnchor.x, toAnchor.z);
  const elevation = THREE.MathUtils.degToRad(spec.elevationDeg);
  const direction = new THREE.Vector3(
    Math.sin(bearing) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(bearing) * Math.cos(elevation),
  );
  const position = head.position.clone().addScaledVector(direction, spec.radius);
  return { position, quaternion: facing(direction, spec.leanDeg ?? 0) };
}

/**
 * Turn to face the head along `direction`, then lie back by `leanDeg`.
 *
 * The pitch is taken from the outgoing direction rather than from a vector
 * pointing back at the head: a panel above the horizon has to tilt *down* to be
 * read, and reading the sign off the return vector turns it the wrong way by
 * twice the elevation.
 */
function facing(direction: THREE.Vector3, leanDeg: number): THREE.Quaternion {
  const toHead = direction.clone().negate();
  const facingYaw = Math.atan2(toHead.x, toHead.z);
  const facingPitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
  const pitch = facingPitch - THREE.MathUtils.degToRad(leanDeg);
  // YXZ keeps the panel's up axis in the world's vertical plane, so a surface
  // off to one side is turned toward the operator without rolling its horizon.
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, facingYaw, 0, 'YXZ'));
}

/** The angular box a surface occupies in the field of view, in degrees. */
export interface XrAngularExtent {
  readonly id: XrSurfaceId;
  readonly azimuthDeg: readonly [number, number];
  readonly elevationDeg: readonly [number, number];
}

/**
 * How much of the field of view a surface takes.
 *
 * A panel that faces the operator subtends `2·atan(size / 2r)`. This is the
 * small-angle rectangle that approximation gives, which is what the separation
 * check needs — it is deliberately not a projection of the panel's corners,
 * because a rectangle is the shape a person reads a panel as occupying.
 */
export function angularExtent(spec: XrSurfaceSpec): XrAngularExtent {
  const halfAz = THREE.MathUtils.radToDeg(Math.atan(spec.sizeX / 2 / spec.radius));
  // A pitched panel is foreshortened: its vertical extent shrinks by the
  // cosine of the lean, which is exactly why the action desk can sit low
  // without crowding the plate above it.
  const lean = THREE.MathUtils.degToRad(spec.leanDeg ?? 0);
  const halfEl = THREE.MathUtils.radToDeg(Math.atan(((spec.sizeY / 2) * Math.cos(lean)) / spec.radius));
  return {
    id: spec.id,
    azimuthDeg: [spec.azimuthDeg - halfAz, spec.azimuthDeg + halfAz],
    elevationDeg: [spec.elevationDeg - halfEl, spec.elevationDeg + halfEl],
  };
}

/** Degrees of clear space between two surfaces; negative means they overlap. */
export function angularGapDeg(a: XrSurfaceSpec, b: XrSurfaceSpec): number {
  const ea = angularExtent(a);
  const eb = angularExtent(b);
  const azGap = Math.max(eb.azimuthDeg[0] - ea.azimuthDeg[1], ea.azimuthDeg[0] - eb.azimuthDeg[1]);
  const elGap = Math.max(eb.elevationDeg[0] - ea.elevationDeg[1], ea.elevationDeg[0] - eb.elevationDeg[1]);
  // Separated on either axis is separated; the gap is the better of the two.
  return Math.max(azGap, elGap);
}

/** Layout pixels across a surface, so a card's metres and its pixels agree. */
export function xrCardPixels(spec: XrSurfaceSpec): { readonly width: number; readonly height: number } {
  return { width: Math.round(spec.sizeX / XR_PIXEL_SIZE), height: Math.round(spec.sizeY / XR_PIXEL_SIZE) };
}
