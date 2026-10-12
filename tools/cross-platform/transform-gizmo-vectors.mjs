// Transform gizmo references from the production browser
// (`TransformGizmoExchange.ts` over three r184's own `TransformControls`, as
// `OrcaWorkspace.setup2DControls` configures it): pointer sequences — hovers
// aimed at every visible picker handle (triangle centres and vertices,
// projected through three's camera), misses, and press/move/release drags on
// every axis, plane and ring, E and XYZE included, with moves whose rays miss
// the drag plane — under cameras from oblique, top-down, edge-on, axis-aligned,
// near-threshold and from-below angles (fov 30–75°, several aspects), over the
// browser's printer-space root (0.00175 world units a millimetre), a metre root
// (0.001, as Android renders) and a millimetre one, with identity, rotated,
// scaled, mirrored and selection-pivot proxies, in all three modes and both
// spaces. Each step records whether the proxy changed and the SHA-256 of the
// view (axis, drag, proxy, every gizmo and helper handle's visibility, world
// matrix, colour and opacity); the handles' baked geometry is recorded whole.
// Then the changes drags submit for one instance or a selection, and the
// exchanges' refusals. Replayed by Rust, by WASM in Node and Chrome, and over
// JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import {
  createTransformGizmoScene,
  transformGizmoChangesExchange,
  transformGizmoExchange,
  transformGizmoGeometryExchange,
  transformGizmoStep,
} from "../../web/src/workspace/TransformGizmoExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// xorshift64*, seeded: the corpus is reproducible on any engine.
let seed = 0x9e3779b97f4a7c15n;
const next = () => {
  seed ^= seed >> 12n;
  seed ^= (seed << 25n) & 0xffffffffffffffffn;
  seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const pick = (list) => list[Math.floor(unit() * list.length)];
const degrees = (value) => (value * Math.PI) / 180;
const quaternion = (x, y, z) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(degrees(x), degrees(y), degrees(z))).toArray();
const pose = (position, rotation, scale) => ({ position, quaternion: rotation, scale });

// Roots: printer millimetres to world units, rotated −90° about X, the bed centred.
const rootPose = (scale, sizeMm = 270) =>
  pose(
    [(-sizeMm / 2) * scale, 0, (sizeMm / 2) * scale],
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).toArray(),
    [scale, scale, scale],
  );
const roots = [
  { name: "browser", pose: rootPose(0.00175, 200), scale: 0.00175 },
  { name: "metres", pose: rootPose(0.001), scale: 0.001 },
  { name: "millimetres", pose: rootPose(1), scale: 1 },
];
const proxies = [
  { name: "identity", pose: pose([135, 135, 10], [0, 0, 0, 1], [1, 1, 1]) },
  { name: "rotated", pose: pose([100, 160, 25], quaternion(25, -40, 70), [1, 1, 1]) },
  { name: "scaled", pose: pose([90, 120, 5], quaternion(0, 0, 30), [1.5, 0.75, 2]) },
  { name: "mirrored", pose: pose([150, 80, 12], quaternion(40, 10, 0), [-1, 1, 1]) },
  { name: "pivot", pose: pose([150.25, 120.5, 12.75], [0, 0, 0, 1], [1, 1, 1]) },
];
const near = Math.sqrt(1 - 0.99 * 0.99);
const views = [
  { name: "oblique", dir: [1, 0.8, 1.3], up: [0, 1, 0] },
  { name: "front", dir: [0, 0.3, 1], up: [0, 1, 0] },
  { name: "top-down", dir: [0, 1, 0], up: [0, 1, 0] },
  { name: "top-down rolled", dir: [0, 1, 0], up: [0, 0, -1] },
  { name: "edge-on", dir: [1, 0, 0.6], up: [0, 1, 0] },
  { name: "along x", dir: [1, 0, 0], up: [0, 1, 0] },
  { name: "near axis threshold", dir: [0.99, near, 0], up: [0, 1, 0] },
  { name: "near plane threshold", dir: [0.6, 0.2, 0.7745966692414834], up: [0, 1, 0] },
  { name: "from below", dir: [0.3, -0.8, 0.5], up: [0, 1, 0] },
  { name: "up along z", dir: [0.7, 0.4, -0.6], up: [0, 0, 1] },
];
for (let i = 0; i < 3; i += 1)
  views.push({ name: `seeded ${i}`, dir: [uniform(-1, 1), uniform(-1, 1), uniform(-1, 1)], up: [0, 1, 0] });
const configurations = [];
for (const mode of ["translate", "rotate", "scale"]) for (const space of ["world", "local"]) configurations.push({ mode, space });

/** The proxy's world position under a root, through three. */
function worldPosition(rootValue, proxyValue) {
  const scene = new THREE.Scene();
  const parent = new THREE.Object3D();
  parent.position.fromArray(rootValue.position);
  parent.quaternion.fromArray(rootValue.quaternion);
  parent.scale.fromArray(rootValue.scale);
  const child = new THREE.Object3D();
  child.position.fromArray(proxyValue.position);
  parent.add(child);
  scene.add(parent);
  scene.updateMatrixWorld(true);
  return child.getWorldPosition(new THREE.Vector3());
}
function cameraFor(view, rootEntry, proxyValue) {
  const center = worldPosition(rootEntry.pose, proxyValue.pose ?? proxyValue);
  const direction = new THREE.Vector3().fromArray(view.dir).normalize();
  const distance = uniform(0.8, 3.5) * rootEntry.scale * 270;
  const offset = new THREE.Vector3(uniform(-1, 1), uniform(-1, 1), uniform(-1, 1)).multiplyScalar(0.06 * distance);
  const target = view.name.startsWith("near") || view.name.startsWith("along") ? center : center.clone().add(offset);
  return {
    aspect: pick([0.5, 0.75, 1, 4 / 3, 16 / 9, 2.2]),
    far: distance * 20,
    fov: Math.round(uniform(30, 75)),
    near: distance / 100,
    position: center.clone().addScaledVector(direction, distance).toArray(),
    target: target.toArray(),
    up: view.up,
  };
}

/** NDC points on each visible picker handle: triangle centres and a vertex. */
function targets(gizmo) {
  gizmo.render();
  const out = [];
  for (const handle of gizmo.handles("picker")) {
    if (!handle.visible) continue;
    const position = handle.geometry.getAttribute("position");
    const index = handle.geometry.getIndex();
    const corner = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
    const count = index ? index.count : position.count;
    const points = [];
    for (let attempt = 0; attempt < 12 && points.length < 2; attempt += 1) {
      const triangle = Math.floor(unit() * (count / 3)) * 3;
      const point =
        points.length === 0
          ? corner(triangle).add(corner(triangle + 1)).add(corner(triangle + 2)).divideScalar(3)
          : corner(triangle + Math.floor(unit() * 3));
      const ndc = point.applyMatrix4(handle.matrixWorld).project(gizmo.camera);
      if (Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z > -1 && ndc.z < 1) points.push([ndc.x, ndc.y]);
    }
    if (points.length > 0) out.push({ name: handle.name, points });
  }
  return out;
}

const sequences = [];
const changeSources = [];
function sequence(name, setup, plan) {
  const gizmo = createTransformGizmoScene(setup);
  const events = [];
  let pressPose = null;
  const event = (kind, x, y) => {
    events.push({ kind, x, y });
    const wasDragging = gizmo.controls.dragging;
    transformGizmoStep(gizmo, kind, x, y);
    const proxyPose = {
      position: gizmo.proxy.position.toArray(),
      quaternion: gizmo.proxy.quaternion.toArray(),
      scale: gizmo.proxy.scale.toArray(),
    };
    if (!wasDragging && gizmo.controls.dragging) pressPose = proxyPose;
    if (kind === "move" && gizmo.controls.dragging && pressPose)
      changeSources.push({ mode: setup.mode, initialProxy: pressPose, proxy: proxyPose });
  };
  plan(gizmo, event);
  const request = JSON.stringify({ ...setup, events });
  const reply = JSON.parse(transformGizmoExchange(request));
  assert.equal(reply.steps.length, events.length);
  sequences.push({
    name,
    request,
    steps: reply.steps.map((step) => ({
      axis: step.view.axis,
      changed: step.changed,
      dragging: step.view.dragging,
      view: sha256(canonicalStringify(step.view)),
    })),
  });
}

/** A drag: press at a point, several moves, sometimes a ray past the plane, release. */
function drag(event, [x, y], moves, wild) {
  event("press", x, y);
  let [px, py] = [x, y];
  for (let i = 0; i < moves; i += 1) {
    px += uniform(-0.15, 0.15);
    py += uniform(-0.15, 0.15);
    event("move", px, py);
  }
  if (wild) event("move", px * 3, pick([-3, 3]));
  event("release", px, py);
}

let caseIndex = 0;
for (const configuration of configurations)
  for (const view of views)
    for (const rootEntry of roots)
      for (let k = 0; k < 2; k += 1) {
        const proxy = proxies[(caseIndex + k * 2) % proxies.length];
        const setup = {
          camera: cameraFor(view, rootEntry, proxy),
          mode: configuration.mode,
          proxy: proxy.pose,
          root: rootEntry.pose,
          space: configuration.space,
        };
        const index = caseIndex;
        sequence(
          `${configuration.mode} ${configuration.space} ${view.name} ${rootEntry.name} ${proxy.name}`,
          setup,
          (gizmo, event) => {
            event("hover", 0.97, -0.97);
            const aimed = targets(gizmo);
            for (const target of aimed) for (const [x, y] of target.points) event("hover", x, y);
            if (aimed.length === 0) {
              event("press", 0.97, -0.97);
              event("move", 0.5, 0.5);
              event("release", 0.5, 0.5);
              return;
            }
            // Two drags on handles chosen in turn, each from the then current pose.
            for (let d = 0; d < 2; d += 1) {
              const now = targets(gizmo);
              if (now.length === 0) break;
              const target = now[(index + d * 3) % now.length];
              drag(event, target.points[0], 3, (index + d) % 3 === 0);
            }
            if (index % 4 === 0) {
              // Hovering and pressing while dragging change nothing.
              const now = targets(gizmo);
              if (now.length > 0) {
                const [x, y] = now[index % now.length].points[0];
                event("press", x, y);
                event("hover", 0.97, 0.97);
                event("press", 0.2, 0.2);
                event("move", x + 0.05, y - 0.05);
                event("release", x + 0.05, y - 0.05);
              }
            }
            if (index % 5 === 1) {
              // A press on nothing starts no drag; moves then change nothing.
              event("press", 0.97, 0.97);
              event("move", 0.1, 0.1);
              event("release", 0.1, 0.1);
            }
          },
        );
        caseIndex += 1;
      }

// Every handle dragged in every mode and space, from the oblique camera.
for (const configuration of configurations)
  for (const rootEntry of roots) {
    const proxy = proxies[1];
    const setup = {
      camera: cameraFor(views[0], rootEntry, proxy),
      mode: configuration.mode,
      proxy: proxy.pose,
      root: rootEntry.pose,
      space: configuration.space,
    };
    const probe = createTransformGizmoScene(setup);
    const names = targets(probe).map((target) => target.name);
    for (const name of [...new Set(names)])
      sequence(`${configuration.mode} ${configuration.space} every handle ${rootEntry.name} ${name}`, setup, (gizmo, event) => {
        const target = targets(gizmo).find((entry) => entry.name === name);
        if (!target) return;
        drag(event, target.points[0], 4, true);
        const again = targets(gizmo).find((entry) => entry.name === name);
        if (again) drag(event, again.points.at(-1), 2, false);
      });
  }

// The changes drags submit: one instance takes the proxy's pose; a selection
// is carried around the proxy's pose at the press.
const changes = [];
const transform = (translationMm, rotation, scale) => ({ rotation, scale, translationMm });
const selection = [
  { instanceId: "instance:a", transform: transform([140, 130, 10], [0, 0, 0, 1], [1, 1, 1]) },
  { instanceId: "instance:b", transform: transform([160, 110, 15.5], quaternion(10, 20, 30), [0.5, 2, 1.25]) },
  { instanceId: "instance:\ud800c", transform: transform([150.5, 121, 12.75], quaternion(-45, 90, 0), [-1, 1, 1]) },
];
const toolMode = { translate: "move", rotate: "rotate", scale: "scale" };
function change(name, request) {
  const json = JSON.stringify(request);
  changes.push({ name, request: json, reply: transformGizmoChangesExchange(json) });
}
for (let i = 0; i < changeSources.length; i += Math.max(1, Math.floor(changeSources.length / 90))) {
  const source = changeSources[i];
  const mode = toolMode[source.mode];
  change(`single ${i}`, { initialProxy: source.initialProxy, mode, origins: [selection[0]], proxy: source.proxy });
  change(`selection ${i}`, { initialProxy: source.initialProxy, mode, origins: selection, proxy: source.proxy });
}
const identity = pose([150.25, 120.5, 12.75], [0, 0, 0, 1], [1, 1, 1]);
const unnormalized = pose([150, 120, 10], [0, 0, 0.5, 0.5], [2, 2, 2]);
for (const mode of ["move", "rotate", "scale"]) {
  change(`${mode} unnormalized proxy`, { initialProxy: unnormalized, mode, origins: selection, proxy: unnormalized });
  change(`${mode} still`, { initialProxy: identity, mode, origins: selection, proxy: identity });
  // The workspace's projection refusals, in its words.
  change(`${mode} duplicate selection`, {
    initialProxy: identity,
    mode,
    origins: [selection[0], selection[0]],
    proxy: identity,
  });
  change(`${mode} flat pivot`, {
    initialProxy: pose([150, 120, 10], [0, 0, 0, 1], [0, 1, 1]),
    mode,
    origins: selection,
    proxy: identity,
  });
  change(`${mode} zero rotation`, {
    initialProxy: identity,
    mode,
    origins: [selection[0], { instanceId: "instance:zero", transform: transform([0, 0, 0], [0, 0, 0, 0], [1, 1, 1]) }],
    proxy: pose([150.25, 120.5, 12.75], quaternion(0, 0, 15), [1, 1, 1]),
  });
}
change("single flat", {
  initialProxy: pose([150, 120, 10], [0, 0, 0, 1], [0, 1, 1]),
  mode: "scale",
  origins: [selection[1]],
  proxy: pose([150, 120, 10], [0, 0, 0, 0], [0, 1, 1]),
});

// Refusals, in the shapes hosts send the shared core (attach, step, present
// and changes), each also refused by the browser exchange.
const refusals = [];
const fresh = (proxy) => ({
  axis: null,
  changed: false,
  dragging: false,
  proxy,
  rotationAxis: [0, 0, 0],
  start: {
    point: [0, 0, 0],
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [0, 0, 0],
    worldPosition: [0, 0, 0],
    worldQuaternion: [0, 0, 0, 1],
  },
});
const good = JSON.parse(sequences[0].request);
const goodEvent = good.events[0];
const scene = { camera: good.camera, mode: good.mode, root: good.root, space: good.space };
/** A host request the core refuses, and the browser request that fails the same way. */
function refuse(exchange, request, browser) {
  const json = typeof request === "string" ? request : JSON.stringify(request);
  if (exchange === "changes") assert.throws(() => transformGizmoChangesExchange(json), /invalid_request/, json);
  else {
    const composite = typeof browser === "string" ? browser : JSON.stringify(browser);
    assert.throws(() => transformGizmoExchange(composite), /invalid_request/, composite);
  }
  refusals.push({ exchange, request: json });
}
const step = (overrides) => ({ ...scene, event: goodEvent, state: fresh(good.proxy), ...overrides });
const sequenceWith = (overrides) => ({ ...good, ...overrides });
refuse("step", "{", "{");
refuse("step", "[]", "[]");
refuse("present", "[]", "[]");
refuse("step", Object.fromEntries(Object.entries(step({})).filter(([k]) => k !== "event")),
  Object.fromEntries(Object.entries(good).filter(([k]) => k !== "events")));
refuse("step", step({ extra: 1 }), sequenceWith({ extra: 1 }));
refuse("step", step({ mode: "move" }), sequenceWith({ mode: "move" }));
refuse("present", { ...scene, mode: "move", state: fresh(good.proxy) }, sequenceWith({ mode: "move" }));
refuse("step", step({ space: "screen" }), sequenceWith({ space: "screen" }));
refuse("step", step({ event: { kind: "tap", x: 0, y: 0 } }), sequenceWith({ events: [{ kind: "tap", x: 0, y: 0 }] }));
refuse("step", step({ event: { kind: "hover", x: 0 } }), sequenceWith({ events: [{ kind: "hover", x: 0 }] }));
refuse("step", step({ event: { kind: "hover", x: "0", y: 0 } }), sequenceWith({ events: [{ kind: "hover", x: "0", y: 0 }] }));
refuse("step", step({ event: [] }), sequenceWith({ events: {} }));
refuse("attach", { proxy: { ...good.proxy, quaternion: [0, 0, 1] } }, sequenceWith({ proxy: { ...good.proxy, quaternion: [0, 0, 1] } }));
refuse("attach", { proxy: { ...good.proxy, scale: [1, 1, "1"] } }, sequenceWith({ proxy: { ...good.proxy, scale: [1, 1, "1"] } }));
refuse("attach", { proxy: good.proxy, extra: 1 }, sequenceWith({ proxy: { ...good.proxy, extra: 1 } }));
refuse("step", step({ root: { ...good.root, scale: [1, 1] } }), sequenceWith({ root: { ...good.root, scale: [1, 1] } }));
for (const camera of [
  { ...good.camera, fov: 0 },
  { ...good.camera, fov: 180 },
  { ...good.camera, aspect: 0 },
  { ...good.camera, near: 0 },
  { ...good.camera, far: good.camera.near },
  { ...good.camera, up: [0, 1] },
]) {
  refuse("step", step({ camera }), sequenceWith({ camera }));
  refuse("present", { ...scene, camera, state: fresh(good.proxy) }, sequenceWith({ camera }));
}
refuse("changes", "{");
refuse("changes", JSON.stringify({ initialProxy: identity, mode: "translate", origins: selection, proxy: identity }));
refuse("changes", JSON.stringify({ initialProxy: identity, mode: "move", origins: [], proxy: identity }));
refuse("changes", JSON.stringify({ initialProxy: identity, mode: "move", origins: [{ instanceId: 7, transform: selection[0].transform }], proxy: identity }));
refuse("changes", JSON.stringify({ initialProxy: identity, mode: "move", origins: selection, proxy: { ...identity, scale: [1, 1, "1"] } }));
refuse("changes", JSON.stringify({ initialProxy: identity, mode: "move", origins: selection }));

const sources = [
  "tools/cross-platform/transform-gizmo-vectors.mjs",
  "web/src/workspace/TransformGizmoExchange.ts",
  "web/src/workspace/transformGizmoChanges.ts",
  "web/src/workspace/multiInstanceTransform.ts",
  "web/src/project/domain/canonical.ts",
  "web/node_modules/three/examples/jsm/controls/TransformControls.js",
  "web/node_modules/three/src/core/Object3D.js",
  "web/node_modules/three/src/core/Raycaster.js",
  "web/node_modules/three/src/core/BufferGeometry.js",
  "web/node_modules/three/src/core/BufferAttribute.js",
  "web/node_modules/three/src/cameras/Camera.js",
  "web/node_modules/three/src/cameras/PerspectiveCamera.js",
  "web/node_modules/three/src/objects/Mesh.js",
  "web/node_modules/three/src/math/Matrix4.js",
  "web/node_modules/three/src/math/Quaternion.js",
  "web/node_modules/three/src/math/Vector3.js",
  "web/node_modules/three/src/math/Euler.js",
  "web/node_modules/three/src/math/Ray.js",
  "web/node_modules/three/src/math/Sphere.js",
  "web/node_modules/three/src/math/Box3.js",
  "web/node_modules/three/src/math/Color.js",
  "web/node_modules/three/src/math/ColorManagement.js",
  "web/node_modules/three/src/geometries/BoxGeometry.js",
  "web/node_modules/three/src/geometries/CylinderGeometry.js",
  "web/node_modules/three/src/geometries/OctahedronGeometry.js",
  "web/node_modules/three/src/geometries/PlaneGeometry.js",
  "web/node_modules/three/src/geometries/PolyhedronGeometry.js",
  "web/node_modules/three/src/geometries/SphereGeometry.js",
  "web/node_modules/three/src/geometries/TorusGeometry.js",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: sha256(read(path)) })),
    engine: { v8: process.versions.v8 },
    geometry: transformGizmoGeometryExchange(),
    sequences,
    changes,
    refusals,
  }) + "\n";
const path = new URL("testdata/cross-platform/transform-gizmo-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Transform gizmo reference drift");
const steps = sequences.flatMap((s) => s.steps);
const events = sequences.flatMap((s) => JSON.parse(s.request).events);
const counted = (kind) => events.filter((e) => e.kind === kind).length;
const missedMoves = sequences.reduce((total, s) => {
  const list = JSON.parse(s.request).events;
  return total + s.steps.filter((step, i) => list[i].kind === "move" && step.dragging && !step.changed).length;
}, 0);
const dragged = new Set(
  sequences.flatMap((s) => {
    const list = JSON.parse(s.request).events;
    const mode = JSON.parse(s.request).mode;
    return s.steps.flatMap((step, i) => (list[i].kind === "press" && step.dragging ? [`${mode} ${step.axis}`] : []));
  }),
);
const refused = changes.filter((c) => c.reply.startsWith('{"error"')).length;
console.log(
  `Transform gizmo references: ${sequences.length} sequences, ${steps.length} steps ` +
    `(${counted("hover")} hovers, ${counted("press")} presses, ${counted("move")} moves, ${counted("release")} releases; ` +
    `${steps.filter((s) => s.changed).length} changes, ${missedMoves} moves off the plane), ` +
    `${dragged.size} mode/axis drags [${[...dragged].sort().join(", ")}], ` +
    `${changes.length} drag changes (${refused} refused), ${refusals.length} malformed requests`,
);
