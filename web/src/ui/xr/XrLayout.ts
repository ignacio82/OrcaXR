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
 *    looking up, which is why the work sits low and only the mode strip is
 *    above the horizon.
 *  - **0.8–1.1 m radius** clears arm's reach for direct touch while staying
 *    inside the range where vergence and focus still agree.
 *  - A control is comfortably hittable at about **2.5° of arc** or more, which
 *    at 1 m is a ~45 mm target.
 *
 * `XrLayout.test.ts` holds the geometry to those numbers, and — because
 * "crammed together" is the complaint this module exists to answer — asserts
 * that no two simultaneously visible surfaces overlap in the field of view.
 */
import * as THREE from 'three';

/** Every spatial surface the immersive shell can put in front of the operator. */
export type XrSurfaceId = 'menu' | 'tools' | 'inspector' | 'actions' | 'status' | 'sheet' | 'progress';

/**
 * How a surface competes for space.
 *
 * `persistent` surfaces are up together and therefore may not overlap each
 * other. A `modal` surface is shown alone, in front of the work, and is
 * allowed to cover whatever it needs to.
 */
export type XrSurfaceLayer = 'persistent' | 'modal';

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
}

/**
 * The arrangement.
 *
 * Read it as a cockpit: the work (the build plate) sits low and central at
 * arm's length, the mode strip rides just above it, the tools fall under the
 * left hand and the contextual panel under the right, and the primary actions
 * lie below the plate tilted up like a control desk. Nothing is directly
 * overhead and nothing is behind the plate.
 */
export const XR_SURFACES: readonly XrSurfaceSpec[] = [
  // Mode + menu launcher. Small, above the plate, the only surface over the
  // horizon — it is glanced at, not worked in.
  // Two rows deep, because it carries the flat shell's menu strip *and* its
  // tab strip — the same header, stacked instead of side by side.
  { id: 'menu', azimuthDeg: 0, elevationDeg: 17, radius: 1.0, sizeX: 0.66, sizeY: 0.22, layer: 'persistent' },
  // Tool rail, under the left hand and turned toward the operator.
  // Tall enough for its whole content: the rail deliberately does not scroll,
  // so anything that does not fit is simply clipped off the bottom.
  { id: 'tools', azimuthDeg: -33, elevationDeg: -12, radius: 0.92, sizeX: 0.2, sizeY: 0.7, layer: 'persistent' },
  // The contextual panel: profile, settings, whatever the current task needs.
  { id: 'inspector', azimuthDeg: 35, elevationDeg: -6, radius: 0.95, sizeX: 0.42, sizeY: 0.6, layer: 'persistent' },
  // Primary actions, below the plate and tilted up like a control desk.
  {
    id: 'actions',
    azimuthDeg: 0,
    // Below the plate's near edge, not level with it: at 0.82 m and -39° the
    // desk sat at the same radius as the front of the bed and cut through it.
    elevationDeg: -42,
    radius: 0.86,
    sizeX: 0.56,
    sizeY: 0.13,
    leanDeg: 25,
    layer: 'persistent',
  },
  // Printer status: worth a glance, never in the way. Above the tool rail.
  { id: 'status', azimuthDeg: -33, elevationDeg: 19, radius: 1.05, sizeX: 0.38, sizeY: 0.16, layer: 'persistent' },
  // Menus and full panels open as one sheet in front of the work.
  { id: 'sheet', azimuthDeg: 0, elevationDeg: -4, radius: 0.88, sizeX: 0.62, sizeY: 0.62, layer: 'modal' },
  // Slice progress: centred, small, and gone when it is finished.
  { id: 'progress', azimuthDeg: 0, elevationDeg: 0, radius: 0.85, sizeX: 0.5, sizeY: 0.2, layer: 'modal' },
];

const byId = new Map(XR_SURFACES.map((surface) => [surface.id, surface]));

export function xrSurface(id: XrSurfaceId): XrSurfaceSpec {
  const surface = byId.get(id);
  if (!surface) throw new Error(`XrLayout: no surface named ${id}`);
  return surface;
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

  // Face the head, then lie back by the surface's own lean. The pitch is taken
  // from the outgoing direction rather than from `toHead.y`: a panel above the
  // horizon has to tilt *down* to be read, and reading the sign off the vector
  // pointing back at the head turns it the wrong way by twice the elevation.
  const toHead = direction.clone().negate();
  const facingYaw = Math.atan2(toHead.x, toHead.z);
  const facingPitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
  const pitch = facingPitch - THREE.MathUtils.degToRad(spec.leanDeg ?? 0);
  // YXZ keeps the panel's up axis in the world's vertical plane, so a surface
  // off to one side is turned toward the operator without rolling its horizon.
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, facingYaw, 0, 'YXZ'));

  return { position, quaternion };
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
