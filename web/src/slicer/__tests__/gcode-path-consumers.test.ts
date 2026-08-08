import assert from 'node:assert/strict';

import { GcodeInspectionError, inspectGcode } from '../GcodeInspectionModel';
import { GCODE_PREVIEW_EVENT_COUNT, GcodePreviewProjectionError, projectGcodePreview } from '../GcodePreviewModel';
import { GcodeStatisticsError, classifyRichGcodeObservationCoverage } from '../GcodeStatisticsModel';
import { parseGcodeToolpath } from '../GcodeToolpath';
import { GCODE_RECORD_KIND, parseRichGcodeModel, type RichGcodeModel } from '../RichGcodeModel';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ARC_SOURCE = ['G90', 'M83', ';LAYER_CHANGE', 'G1 X0 Y0 Z0.2', 'G2 X10 Y0 I5 J0 E1'].join('\n');

function arcFixture(): RichGcodeModel {
  return parseRichGcodeModel(ARC_SOURCE);
}

function extrusionVisibility(): Uint8Array {
  const visibility = new Uint8Array(GCODE_PREVIEW_EVENT_COUNT);
  visibility[GCODE_RECORD_KIND.EXTRUDE] = 1;
  return visibility;
}

function expectAllConsumerValidatorsReject(model: RichGcodeModel): void {
  assert.throws(
    () => projectGcodePreview(model, { mode: 'FeatureType', eventVisibility: extrusionVisibility() }),
    (error: unknown) => error instanceof GcodePreviewProjectionError && error.code === 'invalid-model',
  );
  assert.throws(
    () => inspectGcode(model),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-model',
  );
  assert.throws(
    () => classifyRichGcodeObservationCoverage(model),
    (error: unknown) => error instanceof GcodeStatisticsError && error.code === 'invalid-model',
  );
}

test('legacy toolpath expands arc extrusion geometry without multiplying semantic records', () => {
  const model = arcFixture();
  const arcRecord = model.columns.kind.indexOf(GCODE_RECORD_KIND.EXTRUDE);
  assert.notEqual(arcRecord, -1);
  const expectedSegments = model.columns.pathPointCount[arcRecord] + 1;
  const toolpath = parseGcodeToolpath(ARC_SOURCE);
  assert.equal(toolpath.segmentCount, expectedSegments);
  const position = toolpath.geometry.getAttribute('position');
  const color = toolpath.geometry.getAttribute('color');
  assert.equal(position.count, expectedSegments * 2);
  assert.equal(color.count, expectedSegments * 2);
  assert.deepEqual(Array.from(position.array).slice(0, 3), [0, 0, model.columns.startZ[arcRecord]]);
  assert.deepEqual(Array.from(position.array).slice(-3), [10, 0, model.columns.endZ[arcRecord]]);
  toolpath.geometry.dispose();
});

test('inspection focus follows full-circle interpolation while the cursor stays on the semantic endpoint', () => {
  const model = parseRichGcodeModel(['G90', 'M83', ';LAYER_CHANGE', 'G1 Z0.2', 'G2 X0 Y0 I5 J0 P1 E1'].join('\n'));
  const arcRecord = model.columns.kind.indexOf(GCODE_RECORD_KIND.EXTRUDE);
  const state = inspectGcode(model);
  assert.equal(state.current?.record, arcRecord);
  assert.deepEqual(state.current?.positionMm, [0, 0, model.columns.endZ[arcRecord]]);
  assert.ok(state.focusBounds);
  assert.ok(state.focusBounds.maxMm[0] > 9.9);
  assert.ok(state.focusBounds.maxMm[1] > 4.9);
  assert.ok(state.focusBounds.minMm[1] < -4.9);
});

test('inspection focus retains a direct zero-XYZ retract or unretract toolhead point', () => {
  const state = inspectGcode(parseRichGcodeModel('M83\nG1 E1'));
  assert.deepEqual(state.focusBounds, { minMm: [0, 0, 0], maxMm: [0, 0, 0] });
});

test('preview, inspection, and statistics reject dense-slice and finite-coordinate corruption', () => {
  const badOffset = structuredClone(arcFixture()) as RichGcodeModel;
  // Every claimed slice still lies inside the sidecar and the final arc still
  // covers all points, but this empty direct slice is not at the dense prefix.
  badOffset.columns.pathPointOffset[1] = 1;
  expectAllConsumerValidatorsReject(badOffset);

  const badCount = structuredClone(arcFixture()) as RichGcodeModel;
  badCount.columns.pathPointCount[1] = 1;
  expectAllConsumerValidatorsReject(badCount);

  const badPoint = structuredClone(arcFixture()) as RichGcodeModel;
  badPoint.pathPoints.x[0] = Number.NaN;
  expectAllConsumerValidatorsReject(badPoint);

  const badCenter = structuredClone(arcFixture()) as RichGcodeModel;
  badCenter.columns.arcCenterY[2] = Number.POSITIVE_INFINITY;
  expectAllConsumerValidatorsReject(badCenter);
});

test('all consumers reject arc paths forged onto incompatible semantic move kinds', () => {
  const model = arcFixture();
  const arcRecord = model.columns.kind.indexOf(GCODE_RECORD_KIND.EXTRUDE);

  const pauseArc = structuredClone(model) as RichGcodeModel;
  pauseArc.columns.kind[arcRecord] = GCODE_RECORD_KIND.PAUSE;
  expectAllConsumerValidatorsReject(pauseArc);

  const travelWithExtrusion = structuredClone(model) as RichGcodeModel;
  travelWithExtrusion.columns.kind[arcRecord] = GCODE_RECORD_KIND.TRAVEL;
  expectAllConsumerValidatorsReject(travelWithExtrusion);

  const extrusionWithoutDelta = structuredClone(model) as RichGcodeModel;
  extrusionWithoutDelta.columns.deltaE[arcRecord] = 0;
  expectAllConsumerValidatorsReject(extrusionWithoutDelta);
});

test('statistics exact-object validation requires the new path sidecar schema and limit', () => {
  const model = arcFixture();
  assert.equal(classifyRichGcodeObservationCoverage(model).kind, 'complete');

  const missingPathPoints = { ...model } as unknown as Record<string, unknown>;
  delete missingPathPoints.pathPoints;
  expectAllConsumerValidatorsReject(missingPathPoints as unknown as RichGcodeModel);

  const wrongPathArray: RichGcodeModel = {
    ...model,
    pathPoints: {
      ...model.pathPoints,
      x: new Float64Array(model.pathPoints.x) as unknown as Float32Array,
    },
  };
  expectAllConsumerValidatorsReject(wrongPathArray);
});

console.log(`\n${passed} G-code path-consumer tests passed.`);
