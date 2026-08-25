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
  XR_PINNABLE,
  XR_PIXEL_SIZE,
  XR_SURFACES,
  XR_WORKSPACE_MODES,
  anchoredTransform,
  droppedTransform,
  angularExtent,
  angularGapDeg,
  surfaceTransform,
  xrCardPixels,
  xrSurface,
  xrSurfacesInMode,
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

/** Surfaces the operator reads from a fixed place in the layout. */
const placed = XR_SURFACES.filter((surface) => surface.layer !== 'transient');

test('every surface sits in the comfortable field of view', () => {
  for (const surface of placed) {
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

test('every placed surface is within reach and at one focus distance', () => {
  for (const surface of placed) {
    assert.ok(
      surface.radius >= 0.7 && surface.radius <= 1.2,
      `${surface.id} sits at ${surface.radius} m; outside 0.7–1.2 m the panels stop agreeing on depth`,
    );
  }
});

test('a surface spawned at its trigger stays inside arm’s reach', () => {
  // A transient surface is drawn where the thing that opened it is: a context
  // menu at the fingertip, a menu popover under its own title in the bar. So
  // its radius spans the two — never nearer than the eyes can converge, never
  // further than the chrome it hangs off.
  for (const surface of XR_SURFACES.filter((s) => s.layer === 'transient')) {
    assert.ok(
      surface.radius >= 0.35 && surface.radius <= 1.1,
      `${surface.id} is spawned at ${surface.radius} m; a transient surface belongs between 0.35 m and 1.1 m`,
    );
  }
});

test('nothing that is up in the same workspace overlaps', () => {
  const crowded: string[] = [];
  for (const mode of XR_WORKSPACE_MODES) {
    const cockpit = xrSurfacesInMode(mode);
    for (let i = 0; i < cockpit.length; i++) {
      for (let j = i + 1; j < cockpit.length; j++) {
        const gap = angularGapDeg(cockpit[i], cockpit[j]);
        // Three degrees is about a finger's width at arm's length: less than
        // that reads as one crowded mass rather than two surfaces.
        if (gap < 3) crowded.push(`${mode}: ${cockpit[i].id}↔${cockpit[j].id} ${gap.toFixed(1)}°`);
      }
    }
  }
  assert.deepEqual(crowded, [], `surfaces crowd each other: ${crowded.join(', ')}`);
});

test('exactly the grabbable surfaces can be pinned', () => {
  // A recentre skips whatever is pinned, so this list decides what an operator
  // can keep in place — and it must not quietly widen to a surface that has no
  // manipulator to be moved by in the first place.
  assert.deepEqual(
    [...XR_PINNABLE].sort(),
    XR_SURFACES.filter((surface) => surface.layer === 'grabbable')
      .map((surface) => surface.id)
      .sort(),
  );
});

test('the cockpit is the same surfaces the redesign names', () => {
  assert.deepEqual(
    xrSurfacesInMode('prepare').map((surface) => surface.id),
    ['menubar', 'tools', 'inspector', 'desk'],
  );
  assert.deepEqual(
    xrSurfacesInMode('preview').map((surface) => surface.id),
    ['menubar', 'tools', 'inspector', 'desk', 'scrubber'],
  );
  // Everything else is the answer to a press and may cover what opened it.
  assert.deepEqual(
    XR_SURFACES.filter((surface) => surface.presence === 'on-demand').map((surface) => surface.id),
    ['palette', 'sheet', 'menu', 'context', 'keypad', 'keyboard'],
  );
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

test('a card’s metres and its layout pixels are the same number', () => {
  // One millimetre per layout pixel, so the redesign's 58 px hit target is the
  // 58 mm hand-tracking floor and its 880 px menu bar is 0.88 m of headset.
  assert.equal(XR_PIXEL_SIZE, 0.001);
  const menubar = xrCardPixels(xrSurface('menubar'));
  assert.equal(menubar.width, 880);
  assert.equal(menubar.height, 170);
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

test('a transient surface opens toward what spawned it, at its own radius', () => {
  const keypad = xrSurface('keypad');
  // A field out to the operator's right; the keypad must open that way rather
  // than dead ahead, and must not render at the anchor's own distance.
  const anchor = new THREE.Vector3(0.6, 1.4, -0.3);
  const { position, quaternion } = anchoredTransform(keypad, anchor, head);
  assert.ok(Math.abs(position.distanceTo(head.position) - keypad.radius) < 1e-6, 'keypad ignored its declared radius');
  const toAnchor = anchor.clone().sub(head.position).normalize();
  const toKeypad = position.clone().sub(head.position).normalize();
  assert.ok(toAnchor.dot(toKeypad) > 0.999, 'keypad did not open toward the field it edits');
  const face = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  assert.ok(face.dot(toKeypad.clone().negate()) > 0.999, 'keypad does not face the operator');
});

test('a menu drops out of its own title, at its own height', () => {
  const menu = xrSurface('menu');
  const bar = xrSurface('menubar');
  // A title out to the right of the bar, at the bar's own elevation.
  const title = new THREE.Vector3(0.3, head.position.y + 0.32, -0.98);
  const { position } = droppedTransform(menu, title, head);
  const toTitle = title.clone().sub(head.position);
  const toMenu = position.clone().sub(head.position);
  const azimuth = (vector: THREE.Vector3) => Math.atan2(vector.x, vector.z);
  assert.ok(
    Math.abs(azimuth(toTitle) - azimuth(toMenu)) < 1e-6,
    'the popover must open under the title that opened it',
  );
  assert.ok(toMenu.y < toTitle.y, 'and hang below the bar rather than across it');
  assert.ok(Math.abs(toMenu.length() - menu.radius) < 1e-6);
  // Its whole box clears the bar's, so the menu never covers the strip it
  // was opened from.
  assert.ok(angularExtent(menu).elevationDeg[1] < angularExtent(bar).elevationDeg[0]);
});

test('a transient surface with no anchor falls back to its place in the layout', () => {
  const context = xrSurface('context');
  const fallback = anchoredTransform(context, head.position.clone(), head);
  const layout = surfaceTransform(context, head);
  assert.ok(fallback.position.distanceTo(layout.position) < 1e-6);
});

test('the layout follows the operator rather than the world axes', () => {
  const ahead = surfaceTransform(xrSurface('tools'), head).position;
  const turned = surfaceTransform(xrSurface('tools'), {
    position: head.position,
    forward: new THREE.Vector3(1, 0, 0),
  }).position;
  assert.ok(ahead.distanceTo(turned) > 0.5, 'turning the head must carry the layout with it');
});

test('the work stays clear: nothing in the prepare cockpit sits over the plate', () => {
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
    presence: 'on-demand',
    modes: XR_WORKSPACE_MODES,
  };
  // Prepare is the mode in which the plate is the work. In Preview the work is
  // the toolpath, and the scrubber deliberately docks at the plate's near edge
  // — the operator is reading a layer through the control that chose it.
  for (const surface of xrSurfacesInMode('prepare')) {
    assert.ok(angularGapDeg(surface, plate) >= 0, `${surface.id} covers the build plate`);
  }
});

console.log(`\nXR layout: ${passed} tests passed.`);
