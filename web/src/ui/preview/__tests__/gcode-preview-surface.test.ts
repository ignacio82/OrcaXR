import assert from 'node:assert/strict';

import * as THREE from 'three';

import {
  GCODE_PREVIEW_EVENT_COUNT,
  projectGcodePreview,
  type ReadyGcodePreviewProjection,
} from '../../../slicer/GcodePreviewModel';
import { GCODE_RECORD_KIND, parseRichGcodeModel, type RichGcodeModel } from '../../../slicer/RichGcodeModel';
import { GcodePreviewSurface } from '../GcodePreviewSurface';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function arcFixture(): RichGcodeModel {
  return parseRichGcodeModel(['G90', 'M83', ';LAYER_CHANGE', 'G1 X0 Y0 Z0.2', 'G2 X10 Y0 I5 J0 E1'].join('\n'));
}

function extrusionProjection(model: RichGcodeModel): ReadyGcodePreviewProjection {
  const eventVisibility = new Uint8Array(GCODE_PREVIEW_EVENT_COUNT);
  eventVisibility[GCODE_RECORD_KIND.EXTRUDE] = 1;
  const projection = projectGcodePreview(model, { mode: 'FeatureType', eventVisibility });
  assert.equal(projection.status, 'ready');
  if (projection.status !== 'ready') throw new Error('fixture projection unexpectedly unavailable');
  return projection;
}

function approximately(actual: number, expected: number, epsilon = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} within ${epsilon} of ${expected}`);
}

function lines(surface: GcodePreviewSurface): THREE.LineSegments {
  assert.equal(surface.object.children.length, 1);
  const child = surface.object.children[0];
  assert.ok(child instanceof THREE.LineSegments);
  return child;
}

test('renders every arc edge while retaining one projected record and one projection colour', () => {
  const model = arcFixture();
  const projection = extrusionProjection(model);
  assert.equal(projection.count, 1, 'the G2 command remains one semantic projection record');
  const record = projection.recordIndices[0];
  const expectedSegments = model.columns.pathPointCount[record] + 1;
  assert.ok(expectedSegments > 2);

  const surface = new GcodePreviewSurface({
    parent: new THREE.Group(),
    worldUnitsPerMm: 0.1,
    originOffsetMm: [1, 2, 3],
  });
  const result = surface.render(model, projection);
  assert.deepEqual(result, { segmentCount: expectedSegments, recordCount: 1, skippedRecordCount: 0 });

  const geometry = lines(surface).geometry;
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  assert.equal(position.count, expectedSegments * 2);
  assert.equal(color.count, expectedSegments * 2);
  approximately(position.getX(0), 0.1);
  approximately(position.getY(0), 0.32);
  approximately(position.getZ(0), -0.2);
  approximately(position.getX(position.count - 1), 1.1);
  approximately(position.getY(position.count - 1), 0.32);
  approximately(position.getZ(position.count - 1), -0.2);
  for (let vertex = 0; vertex < color.count; vertex += 1) {
    approximately(color.getX(vertex), projection.colorsRgba[0]);
    approximately(color.getY(vertex), projection.colorsRgba[1]);
    approximately(color.getZ(vertex), projection.colorsRgba[2]);
  }
  surface.dispose();
});

test('retains the pinned zero-length terminal arc edge when interpolation reaches the endpoint', () => {
  const model = structuredClone(arcFixture()) as RichGcodeModel;
  const projection = extrusionProjection(model);
  const record = projection.recordIndices[0];
  const count = model.columns.pathPointCount[record];
  assert.ok(count > 0);
  const finalPoint = model.columns.pathPointOffset[record] + count - 1;
  model.pathPoints.x[finalPoint] = model.columns.endX[record];
  model.pathPoints.y[finalPoint] = model.columns.endY[record];
  model.pathPoints.z[finalPoint] = model.columns.endZ[record];

  const surface = new GcodePreviewSurface({ parent: new THREE.Group(), worldUnitsPerMm: 1 });
  const result = surface.render(model, projection);
  assert.equal(result.segmentCount, count + 1);
  const position = lines(surface).geometry.getAttribute('position');
  const terminal = position.count - 2;
  approximately(position.getX(terminal), position.getX(terminal + 1));
  approximately(position.getY(terminal), position.getY(terminal + 1));
  approximately(position.getZ(terminal), position.getZ(terminal + 1));
  surface.dispose();
});

test('renders a valid zero-point tiny-radius arc as the pinned single terminal edge', () => {
  const model = parseRichGcodeModel(['G90', 'M83', ';LAYER_CHANGE', 'G1 Z0.2', 'G2 X0 Y0 I0.01 J0 P1 E1'].join('\n'));
  const projection = extrusionProjection(model);
  const record = projection.recordIndices[0];
  assert.equal(model.columns.pathPointCount[record], 0);
  const surface = new GcodePreviewSurface({ parent: new THREE.Group(), worldUnitsPerMm: 1 });
  assert.deepEqual(surface.render(model, projection), {
    segmentCount: 1,
    recordCount: 1,
    skippedRecordCount: 0,
  });
  const position = lines(surface).geometry.getAttribute('position');
  assert.equal(position.count, 2);
  approximately(position.getX(0), position.getX(1));
  approximately(position.getY(0), position.getY(1));
  approximately(position.getZ(0), position.getZ(1));
  surface.dispose();
});

test('rejects segment-cap overflow and transformed Float32 overflow before attaching geometry', () => {
  const model = arcFixture();
  const projection = extrusionProjection(model);
  const capped = new GcodePreviewSurface({
    parent: new THREE.Group(),
    worldUnitsPerMm: 1,
    maxRenderedSegments: 1,
  });
  assert.throws(() => capped.render(model, projection), /more than 1 rendered segments/);
  assert.equal(capped.object.children.length, 0);

  const overflowing = new GcodePreviewSurface({
    parent: new THREE.Group(),
    worldUnitsPerMm: Number.MAX_VALUE,
    originOffsetMm: [1, 0, 0],
  });
  assert.throws(() => overflowing.render(model, projection), /finite Float32 world domain/);
  assert.equal(overflowing.object.children.length, 0);
  capped.dispose();
  overflowing.dispose();
});

test('does not trust malformed ready projections or path sidecars', () => {
  const model = arcFixture();
  const projection = extrusionProjection(model);
  const invalidColors = projection.colorsRgba.slice();
  invalidColors[0] = Number.NaN;
  const forgedProjection = { ...projection, colorsRgba: invalidColors } as ReadyGcodePreviewProjection;
  const surface = new GcodePreviewSurface({ parent: new THREE.Group(), worldUnitsPerMm: 1 });
  assert.throws(() => surface.render(model, forgedProjection), /invalid projection colour/);

  const corruptModel = structuredClone(model) as RichGcodeModel;
  corruptModel.columns.pathPointOffset[1] = 1;
  assert.throws(() => surface.render(corruptModel, projection), /non-canonical path-point slice/);
  assert.equal(surface.object.children.length, 0);
  surface.dispose();
});

console.log(`\n${passed} G-code preview-surface tests passed.`);
