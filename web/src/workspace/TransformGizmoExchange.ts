/**
 * The hosts' contract for the workspace's transform gizmo: three.js r184's own
 * `TransformControls`, configured as `OrcaWorkspace.setup2DControls` configures
 * it (size 1, world space, no snaps, every axis shown; Move, Rotate and Scale
 * choose `translate`, `rotate` and `scale`), driven through its pointer API.
 * The shared Rust core answers the same requests
 * (`orcaxr_project::placement::gizmo`).
 *
 * The scene is the browser's: a `Scene` holding the printer-space root (the
 * surface's `root`, rotated −90° about X and scaled to world units) with the
 * attached proxy inside it, and the controls' helper beside it; a
 * `PerspectiveCamera` (zoom 1) at a position, looking at a target with an up.
 *
 * Every pointer event is preceded by a render (`scene.updateMatrixWorld(true)`)
 * so the drag plane and the handles are current when it arrives. A press is
 * `onPointerDown`'s hover then down, with a render between them: in the browser
 * a mouse's hover has already aligned the plane to the pressed axis, while a
 * touch press would use the previous frame's plane; this contract models the
 * former for every pointer. A press whose ray misses the drag plane starts no
 * drag (three would start one from stale start values).
 *
 * - `transformGizmoExchange`: `{"camera","events","mode","proxy","root","space"}`
 *   → `{"steps":[{"changed","view"}]}`, one step per event; `view` is
 *   `{"axis","dragging","handles","proxy"}` after the event, `handles` every
 *   handle of the mode's gizmo then helper group in child order:
 *   `{"color","group","matrix","name","opacity","tag","visible"}` (the colour
 *   in three's linear working space, after highlighting).
 * - `transformGizmoGeometryExchange`: the baked handle geometry of every
 *   group and the drag plane (Float32 positions, the index or `null`).
 * - `transformGizmoChangesExchange`: `{"initialProxy","mode","origins","proxy"}`
 *   → `{"changes"}`, what a drag submits (`setup2DControls`'s `objectChange`),
 *   or `{"error":"invalid_drag","message"}`.
 *
 * A camera is `{"aspect","far","fov","near","position","target","up"}`, a pose
 * `{"position","quaternion","scale"}`, an event `{"kind","x","y"}` with
 * `kind` one of `hover`, `press`, `move`, `release` and the pointer in
 * normalized device coordinates. A value JSON cannot carry is `null`. A
 * malformed request is refused as `invalid_request`.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { canonicalStringify } from '../project/domain/canonical';
import type { InstanceId } from '../project/domain/ids';
import type { Transform } from '../project/domain/model';
import type { MultiInstanceTransformMode, MultiInstanceTransformOrigin } from './multiInstanceTransform';
import { gizmoDragChanges, transformFromObject } from './transformGizmoChanges';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';
/** The code of a drag whose changes the workspace cannot project. */
export const INVALID_DRAG = 'invalid_drag';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type GizmoMode = 'translate' | 'rotate' | 'scale';
type GizmoSpace = 'world' | 'local';
/** A pointer event's kind. */
export type TransformGizmoEventKind = 'hover' | 'press' | 'move' | 'release';

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, keys: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function finite(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}
function numbers(value: Json | undefined, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) invalid();
  return value.map(finite);
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}
function oneOf<T extends string>(value: Json | undefined, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) invalid();
  return value as T;
}

interface Pose {
  readonly position: number[];
  readonly quaternion: number[];
  readonly scale: number[];
}
function pose(value: Json | undefined): Pose {
  const fields = object(value, ['position', 'quaternion', 'scale']);
  return {
    position: numbers(fields.position, 3),
    quaternion: numbers(fields.quaternion, 4),
    scale: numbers(fields.scale, 3),
  };
}
function place(target: THREE.Object3D, value: Pose): void {
  target.position.fromArray(value.position);
  target.quaternion.fromArray(value.quaternion);
  target.scale.fromArray(value.scale);
}

interface Camera {
  readonly aspect: number;
  readonly far: number;
  readonly fov: number;
  readonly near: number;
  readonly position: number[];
  readonly target: number[];
  readonly up: number[];
}
/** A perspective camera: a field of view inside (0°, 180°), a positive aspect and 0 < near < far. */
function camera(value: Json | undefined): Camera {
  const fields = object(value, ['aspect', 'far', 'fov', 'near', 'position', 'target', 'up']);
  const view = {
    aspect: finite(fields.aspect),
    far: finite(fields.far),
    fov: finite(fields.fov),
    near: finite(fields.near),
    position: numbers(fields.position, 3),
    target: numbers(fields.target, 3),
    up: numbers(fields.up, 3),
  };
  if (!(view.fov > 0 && view.fov < 180 && view.aspect > 0 && view.near > 0 && view.far > view.near)) invalid();
  return view;
}

/** The gizmo's request: its camera, root and proxy, mode and space. */
export interface TransformGizmoSetup {
  readonly camera: Camera;
  readonly mode: GizmoMode;
  readonly proxy: Pose;
  readonly root: Pose;
  readonly space: GizmoSpace;
}

/** A live gizmo scene as the workspace builds it, for the exchange and its reference generator. */
export interface TransformGizmoScene {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TransformControls;
  readonly proxy: THREE.Object3D;
  readonly scene: THREE.Scene;
  /** One render's matrix update. */
  render(): void;
  /** The handles of a group of the current mode, in child order. */
  handles(group: 'gizmo' | 'picker' | 'helper'): THREE.Object3D[];
}

interface GizmoInternals {
  _gizmo: Record<'gizmo' | 'picker' | 'helper', Record<GizmoMode, THREE.Object3D>>;
  _plane: THREE.Mesh;
}

/** Build the workspace's gizmo scene for a setup. */
export function createTransformGizmoScene(setup: TransformGizmoSetup): TransformGizmoScene {
  const view = new THREE.PerspectiveCamera(setup.camera.fov, setup.camera.aspect, setup.camera.near, setup.camera.far);
  view.position.fromArray(setup.camera.position);
  view.up.fromArray(setup.camera.up);
  view.lookAt(new THREE.Vector3().fromArray(setup.camera.target));
  const scene = new THREE.Scene();
  const root = new THREE.Object3D();
  place(root, setup.root);
  scene.add(root);
  const proxy = new THREE.Object3D();
  place(proxy, setup.proxy);
  root.add(proxy);
  const controls = new TransformControls(view);
  controls.setMode(setup.mode);
  controls.setSpace(setup.space);
  scene.add(controls.getHelper());
  controls.attach(proxy);
  const internals = controls as unknown as GizmoInternals;
  return {
    camera: view,
    controls,
    proxy,
    scene,
    render: () => scene.updateMatrixWorld(true),
    handles: (group) => [...internals._gizmo[group][controls.mode as GizmoMode].children],
  };
}

function setupOf(fields: JsonObject): TransformGizmoSetup {
  return {
    camera: camera(fields.camera),
    mode: oneOf(fields.mode, ['translate', 'rotate', 'scale'] as const),
    proxy: pose(fields.proxy),
    root: pose(fields.root),
    space: oneOf(fields.space, ['world', 'local'] as const),
  };
}

const value = (number: number): number | null => (Number.isFinite(number) ? number : null);
const values = (list: ArrayLike<number>): (number | null)[] => Array.from(list, value);

type Material = THREE.Material & { color: THREE.Color; opacity: number };
type Handle = THREE.Object3D & { material: Material; tag?: string };

/** What the gizmo shows after an event: the axis, the drag, the proxy and every handle. */
export function transformGizmoView(gizmo: TransformGizmoScene): Json {
  const handle = (group: 'gizmo' | 'helper') => (object: THREE.Object3D) => {
    const { material, tag } = object as Handle;
    return {
      color: values([material.color.r, material.color.g, material.color.b]),
      group,
      matrix: values(object.matrixWorld.elements),
      name: object.name,
      opacity: value(material.opacity),
      tag: tag ?? null,
      visible: object.visible,
    };
  };
  const { proxy, controls } = gizmo;
  return {
    axis: controls.axis,
    dragging: controls.dragging,
    handles: [...gizmo.handles('gizmo').map(handle('gizmo')), ...gizmo.handles('helper').map(handle('helper'))],
    proxy: {
      position: values(proxy.position.toArray()),
      quaternion: values(proxy.quaternion.toArray()),
      scale: values(proxy.scale.toArray()),
    },
  };
}

/** Whether a press's ray misses the drag plane as the last render placed it. */
function missesPlane(gizmo: TransformGizmoScene, pointer: THREE.Vector2): boolean {
  const raycaster = gizmo.controls.getRaycaster();
  raycaster.setFromCamera(pointer, gizmo.camera);
  return raycaster.intersectObject((gizmo.controls as unknown as GizmoInternals)._plane, true).length === 0;
}

/** Drive one event through the controls, a render before each pointer call and after the event; whether the proxy changed. */
export function transformGizmoStep(
  gizmo: TransformGizmoScene,
  kind: TransformGizmoEventKind,
  x: number,
  y: number,
): boolean {
  const { controls } = gizmo;
  let changed = false;
  const onChange = () => {
    changed = true;
  };
  controls.addEventListener('objectChange', onChange);
  const pointer = (button: number) => ({ x, y, button }) as unknown as PointerEvent;
  gizmo.render();
  switch (kind) {
    case 'hover':
      controls.pointerHover(pointer(-1));
      break;
    case 'press':
      controls.pointerHover(pointer(0));
      gizmo.render();
      // Deliberate: no drag from a press that misses the plane.
      if (controls.axis !== null && !controls.dragging && missesPlane(gizmo, new THREE.Vector2(x, y))) break;
      controls.pointerDown(pointer(0));
      break;
    case 'move':
      controls.pointerMove(pointer(-1));
      break;
    case 'release':
      controls.pointerUp(pointer(0));
      break;
  }
  gizmo.render();
  controls.removeEventListener('objectChange', onChange);
  return changed;
}

/** `{"camera","events","mode","proxy","root","space"}` → each event's view. */
export function transformGizmoExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['camera', 'events', 'mode', 'proxy', 'root', 'space']);
  const setup = setupOf(fields);
  if (!Array.isArray(fields.events)) invalid();
  const events = fields.events.map((entry) => {
    const event = object(entry, ['kind', 'x', 'y']);
    return {
      kind: oneOf(event.kind, ['hover', 'press', 'move', 'release'] as const),
      x: finite(event.x),
      y: finite(event.y),
    };
  });
  const gizmo = createTransformGizmoScene(setup);
  const steps = events.map((event) => {
    const changed = transformGizmoStep(gizmo, event.kind, event.x, event.y);
    return { changed, view: transformGizmoView(gizmo) };
  });
  return canonicalStringify({ steps });
}

/** Every group's baked handle geometry and the drag plane's. */
export function transformGizmoGeometryExchange(): string {
  const gizmo = createTransformGizmoScene({
    camera: { aspect: 1, far: 10, fov: 50, near: 0.1, position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0] },
    mode: 'translate',
    proxy: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    root: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    space: 'world',
  });
  const internals = gizmo.controls as unknown as GizmoInternals;
  const shape = (object: THREE.Object3D) => {
    const { geometry } = object as THREE.Mesh;
    const index = geometry.getIndex();
    return {
      index: index ? Array.from(index.array) : null,
      kind: (object as THREE.Line).isLine ? 'line' : 'mesh',
      name: object.name,
      positions: values(geometry.getAttribute('position').array as Float32Array),
      tag: (object as Handle).tag ?? null,
    };
  };
  const groups = (group: 'gizmo' | 'picker' | 'helper') =>
    Object.fromEntries(
      (['translate', 'rotate', 'scale'] as const).map((mode) => [
        mode,
        internals._gizmo[group][mode].children.map(shape),
      ]),
    );
  return canonicalStringify({
    gizmo: groups('gizmo'),
    helper: groups('helper'),
    picker: groups('picker'),
    plane: shape(internals._plane),
  });
}

function transformJson(transform: Transform): Json {
  return {
    rotation: values(transform.rotation),
    scale: values(transform.scale),
    translationMm: values(transform.translationMm),
  };
}
function transform(value: Json | undefined): Transform {
  const fields = object(value, ['rotation', 'scale', 'translationMm']);
  const [x, y, z] = numbers(fields.translationMm, 3);
  const [qx, qy, qz, qw] = numbers(fields.rotation, 4);
  const [sx, sy, sz] = numbers(fields.scale, 3);
  return { translationMm: [x, y, z], rotation: [qx, qy, qz, qw], scale: [sx, sy, sz] };
}
function proxyObject(value: Pose): THREE.Object3D {
  const proxy = new THREE.Object3D();
  place(proxy, value);
  return proxy;
}

/**
 * `{"initialProxy","mode","origins","proxy"}` → the changes a drag submits for
 * the proxy's pose: the instance alone, or the selection carried around the
 * pose the proxy had when the drag began.
 */
export function transformGizmoChangesExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['initialProxy', 'mode', 'origins', 'proxy']);
  const mode: MultiInstanceTransformMode = oneOf(fields.mode, ['move', 'rotate', 'scale'] as const);
  if (!Array.isArray(fields.origins) || fields.origins.length === 0) invalid();
  const origins: MultiInstanceTransformOrigin[] = fields.origins.map((entry) => {
    const origin = object(entry, ['instanceId', 'transform']);
    return { instanceId: text(origin.instanceId) as InstanceId, transform: transform(origin.transform) };
  });
  const initial = transformFromObject(proxyObject(pose(fields.initialProxy)));
  const current = transformFromObject(proxyObject(pose(fields.proxy)));
  try {
    const changes = gizmoDragChanges(origins, initial, current, mode);
    return canonicalStringify({
      changes: changes.map((change) => ({ instanceId: change.instanceId, transform: transformJson(change.transform) })),
    });
  } catch (error) {
    return canonicalStringify({ error: INVALID_DRAG, message: (error as Error).message });
  }
}
