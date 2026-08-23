/**
 * XR layout tests (run: npx tsx xr-layout.test.ts).
 *
 * The immersive shell cannot be seen by a headless browser, so the things that
 * make it usable are asserted as geometry instead: that every surface is inside
 * the comfortable field of view, that it faces the operator, that it is big
 * enough to read and hit, and — the failure this module was written to answer —
 * that two surfaces which are up at the same time do not sit on top of each
 * other while the rest of the room stays empty.
 */
import assert from 'node:assert';
import * as THREE from 'three';
import {
  XR_SURFACES,
  angularExtent,
  angularGapDeg,
  surfaceTransform,
  xrSurface,
  type XrSurfaceSpec,
} from '../XrLayout';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const head = {
  position: new THREE.Vector3(0, 1.6, 0),
  forward: new THREE.Vector3(0, 0, -1),
};

test('every surface sits in the comfortable field of view', () => {
  for (const surface of XR_SURFACES) {
    const extent = angularExtent(surface);
    assert.ok(
      Math.abs(extent.azimuthDeg[0]) <= 55 && Math.abs(extent.azimuthDeg[1]) <= 55,
      `${surface.id} spans ${extent.azimuthDeg.map(Math.round).join('..')}° of azimuth; beyond ±55° is a neck turn`,
    );
    assert.ok(
      extent.elevationDeg[1] <= 26,
      `${surface.id} reaches ${Math.round(extent.elevationDeg[1])}° above eye level; looking up is fatiguing`,
    );
    assert.ok(
      extent.elevationDeg[0] >= -46,
      `${surface.id} reaches ${Math.round(extent.elevationDeg[0])}° below eye level`,
    );
  }
});

test('every surface is within reach and at one focus distance', () => {
  for (const surface of XR_SURFACES) {
    assert.ok(
      surface.radius >= 0.7 && surface.radius <= 1.2,
      `${surface.id} sits at ${surface.radius} m; outside 0.7–1.2 m the panels stop agreeing on depth`,
    );
  }
});

test('nothing that is up at the same time overlaps', () => {
  const persistent = XR_SURFACES.filter((surface) => surface.layer === 'persistent');
  const crowded: string[] = [];
  for (let i = 0; i < persistent.length; i++) {
    for (let j = i + 1; j < persistent.length; j++) {
      const gap = angularGapDeg(persistent[i], persistent[j]);
      // Three degrees is about a finger's width at arm's length: less than
      // that reads as one crowded mass rather than two surfaces.
      if (gap < 3) crowded.push(`${persistent[i].id}↔${persistent[j].id} ${gap.toFixed(1)}°`);
    }
  }
  assert.deepEqual(crowded, [], `surfaces crowd each other: ${crowded.join(', ')}`);
});

test('every surface is big enough to read and to hit', () => {
  for (const surface of XR_SURFACES) {
    const extent = angularExtent(surface);
    const width = extent.azimuthDeg[1] - extent.azimuthDeg[0];
    const height = extent.elevationDeg[1] - extent.elevationDeg[0];
    assert.ok(width >= 8, `${surface.id} is only ${width.toFixed(1)}° wide`);
    assert.ok(height >= 5, `${surface.id} is only ${height.toFixed(1)}° tall`);
  }
});

test('a surface faces the operator wherever they are looking', () => {
  const poses = [
    { position: new THREE.Vector3(0, 1.6, 0), forward: new THREE.Vector3(0, 0, -1) },
    { position: new THREE.Vector3(2, 1.4, -3), forward: new THREE.Vector3(1, 0, 0) },
    { position: new THREE.Vector3(-1, 1.7, 1), forward: new THREE.Vector3(-0.6, -0.3, 0.8).normalize() },
  ];
  for (const pose of poses) {
    for (const surface of XR_SURFACES) {
      const { position, quaternion } = surfaceTransform(surface, pose);
      // The panel's own +Z is its face; it must point back at the head.
      const face = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
      const toHead = pose.position.clone().sub(position).normalize();
      const lean = THREE.MathUtils.degToRad(surface.leanDeg ?? 0);
      const cos = face.dot(toHead);
      assert.ok(
        cos >= Math.cos(lean) - 1e-6,
        `${surface.id} turns ${THREE.MathUtils.radToDeg(Math.acos(cos)).toFixed(1)}° away from the operator`,
      );
    }
  }
});

test('a surface keeps its distance from the head, whatever the pose', () => {
  for (const surface of XR_SURFACES) {
    const { position } = surfaceTransform(surface, head);
    assert.ok(
      Math.abs(position.distanceTo(head.position) - surface.radius) < 1e-6,
      `${surface.id} is not on its own radius`,
    );
  }
});

test('the layout follows the operator rather than the world axes', () => {
  const ahead = surfaceTransform(xrSurface('tools'), head).position;
  const turned = surfaceTransform(xrSurface('tools'), {
    position: head.position,
    forward: new THREE.Vector3(1, 0, 0),
  }).position;
  assert.ok(ahead.distanceTo(turned) > 0.5, 'turning the head must carry the layout with it');
});

test('the work stays clear: nothing persistent sits between the eyes and the plate', () => {
  // The plate is the thing being worked on, and it is modelled by its edges
  // rather than by its centre. It is a 0.35 m bed lying flat, its middle 0.85 m
  // ahead and 0.45 m below the eyes, so the near edge rides much lower in the
  // view than the centre does — and the near edge is what a control bar below
  // the plate actually collides with. Averaging that away is what let a desk
  // at −39° pass a clearance check and still cut through the bed on screen.
  const bed = 0.35;
  const ahead = 0.85;
  const drop = 0.45;
  const edgeElevation = (horizontal: number) => -THREE.MathUtils.radToDeg(Math.atan2(drop, horizontal));
  const nearEdge = edgeElevation(ahead - bed / 2);
  const farEdge = edgeElevation(ahead + bed / 2);
  const centre = (nearEdge + farEdge) / 2;
  const plate: XrSurfaceSpec = {
    id: 'sheet',
    azimuthDeg: 0,
    elevationDeg: centre,
    radius: Math.hypot(ahead, drop),
    sizeX: bed,
    // Height in metres that reproduces the measured near→far angular span.
    sizeY: 2 * Math.hypot(ahead, drop) * Math.tan(THREE.MathUtils.degToRad((nearEdge - farEdge) / 2)),
    layer: 'modal',
  };
  for (const surface of XR_SURFACES.filter((s) => s.layer === 'persistent')) {
    assert.ok(angularGapDeg(surface, plate) >= 0, `${surface.id} covers the build plate`);
  }
});

console.log(`\nXR layout: ${passed} tests passed.`);
