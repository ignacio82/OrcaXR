import assert from 'node:assert/strict';

import * as THREE from 'three';

import {
  createTransformGizmoScene,
  transformGizmoChangesExchange,
  transformGizmoExchange,
  transformGizmoGeometryExchange,
  type TransformGizmoSetup,
} from '../TransformGizmoExchange';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = {
  position: [-0.135, 0, 0.135],
  quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).toArray(),
  scale: [0.001, 0.001, 0.001],
};
const proxy = { position: [135, 135, 10], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
const setup = (mode: TransformGizmoSetup['mode']): TransformGizmoSetup => ({
  camera: { aspect: 1, far: 50, fov: 50, near: 0.01, position: [0.2, 0.25, 0.3], target: [0, 0.01, 0], up: [0, 1, 0] },
  mode,
  proxy,
  root,
  space: 'world',
});

/** Where the centre of a picker handle's first triangle projects. */
function aim(mode: TransformGizmoSetup['mode'], name: string): [number, number] {
  const gizmo = createTransformGizmoScene(setup(mode));
  gizmo.render();
  const handle = gizmo.handles('picker').find((entry) => entry.name === name && entry.visible) as THREE.Mesh;
  const position = handle.geometry.getAttribute('position');
  const index = handle.geometry.getIndex();
  const corner = (i: number) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
  const ndc = corner(0)
    .add(corner(1))
    .add(corner(2))
    .divideScalar(3)
    .applyMatrix4(handle.matrixWorld)
    .project(gizmo.camera);
  return [ndc.x, ndc.y];
}

type View = { axis: string | null; dragging: boolean; proxy: { position: number[]; quaternion: number[] } };
function run(mode: TransformGizmoSetup['mode'], events: { kind: string; x: number; y: number }[]) {
  const reply = JSON.parse(transformGizmoExchange(JSON.stringify({ ...setup(mode), events }))) as {
    steps: { changed: boolean; view: View & { handles: { name: string; visible: boolean; color: number[] }[] } }[];
  };
  return reply.steps;
}

test('a hover over a handle names its axis and highlights it, a miss clears it', () => {
  const [x, y] = aim('translate', 'X');
  const [over, away] = run('translate', [
    { kind: 'hover', x, y },
    { kind: 'hover', x: 0.97, y: -0.97 },
  ]);
  assert.equal(over.view.axis, 'X');
  assert.deepEqual(over.view.handles.find((h) => h.name === 'X')?.color, [1, 1, 0]);
  assert.equal(away.view.axis, null);
  assert.deepEqual(away.view.handles.find((h) => h.name === 'X')?.color, [1, 0, 0]);
});

test('a drag on the X arrow moves the proxy along printer X only', () => {
  const [x, y] = aim('translate', 'X');
  const steps = run('translate', [
    { kind: 'press', x, y },
    { kind: 'move', x: x + 0.1, y },
    { kind: 'release', x: x + 0.1, y },
  ]);
  assert.equal(steps[0].view.dragging, true);
  assert.equal(steps[1].changed, true);
  const [px, py, pz] = steps[1].view.proxy.position;
  assert.ok(px !== 135);
  assert.ok(Math.abs(py - 135) < 1e-9 && Math.abs(pz - 10) < 1e-9);
  assert.equal(steps[2].view.dragging, false);
  assert.equal(steps[2].view.axis, null);
});

test('a ring drag rotates the proxy; a press on nothing starts no drag', () => {
  const [x, y] = aim('rotate', 'Z');
  const steps = run('rotate', [
    { kind: 'press', x, y },
    { kind: 'move', x: x + 0.05, y: y + 0.05 },
    { kind: 'release', x: 0, y: 0 },
    { kind: 'press', x: 0.97, y: 0.97 },
    { kind: 'move', x: 0.5, y: 0.5 },
  ]);
  assert.equal(steps[1].changed, true);
  assert.notDeepEqual(steps[1].view.proxy.quaternion, [0, 0, 0, 1]);
  assert.equal(steps[3].view.dragging, false);
  assert.equal(steps[4].changed, false);
});

test('the geometry lists every group of every mode and the plane', () => {
  const geometry = JSON.parse(transformGizmoGeometryExchange()) as Record<string, Record<string, unknown[]>>;
  assert.deepEqual(
    ['gizmo', 'picker', 'helper'].map((group) =>
      ['translate', 'rotate', 'scale'].map((m) => geometry[group][m].length),
    ),
    [
      [13, 5, 13],
      [10, 5, 10],
      [6, 1, 3],
    ],
  );
  assert.equal((geometry.plane as unknown as { index: number[] }).index.length, 24);
});

test('a drag submits the proxy for one instance and carries a selection around it', () => {
  const transform = { rotation: [0, 0, 0, 1], scale: [1, 1, 1], translationMm: [10, 0, 0] };
  const initial = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
  const moved = { position: [5, 0, 0], quaternion: [0, 0, 0, 2], scale: [1, 1, 1] };
  const one = JSON.parse(
    transformGizmoChangesExchange(
      JSON.stringify({
        initialProxy: initial,
        mode: 'move',
        origins: [{ instanceId: 'a', transform }],
        proxy: moved,
      }),
    ),
  );
  assert.deepEqual(one.changes[0].transform, { rotation: [0, 0, 0, 1], scale: [1, 1, 1], translationMm: [5, 0, 0] });
  const two = JSON.parse(
    transformGizmoChangesExchange(
      JSON.stringify({
        initialProxy: initial,
        mode: 'move',
        origins: [
          { instanceId: 'a', transform },
          { instanceId: 'b', transform: { ...transform, translationMm: [20, 0, 0] } },
        ],
        proxy: moved,
      }),
    ),
  );
  assert.deepEqual(
    two.changes.map((c: { transform: { translationMm: number[] } }) => c.transform.translationMm),
    [
      [15, 0, 0],
      [25, 0, 0],
    ],
  );
  assert.throws(() => transformGizmoChangesExchange('{}'), /invalid_request/);
});

console.log(`transform gizmo exchange: ${passed} passed`);
