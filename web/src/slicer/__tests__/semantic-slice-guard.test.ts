import assert from 'node:assert/strict';
import {
  combinedSemanticImportRequiresCanonicalSlice,
  requireSemanticSlice,
  sameSemanticProjectSnapshot,
  selectSemanticSliceRoute,
  SemanticSliceError,
  type SemanticProjectSnapshot,
} from '../SemanticSliceGuard';

assert.equal(
  combinedSemanticImportRequiresCanonicalSlice({
    sourceWasExclusive: false,
    hadFullSpectrumSource: true,
    incomingVirtualFilamentCount: 0,
  }),
  true,
);
assert.equal(
  combinedSemanticImportRequiresCanonicalSlice({
    sourceWasExclusive: false,
    hadFullSpectrumSource: false,
    incomingVirtualFilamentCount: 1,
  }),
  true,
);
assert.equal(
  combinedSemanticImportRequiresCanonicalSlice({
    sourceWasExclusive: false,
    hadFullSpectrumSource: false,
    incomingVirtualFilamentCount: 0,
  }),
  false,
);
assert.equal(
  combinedSemanticImportRequiresCanonicalSlice({
    sourceWasExclusive: true,
    hadFullSpectrumSource: true,
    incomingVirtualFilamentCount: 3,
  }),
  false,
);

function snapshot(): SemanticProjectSnapshot {
  return {
    projectBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    colorBuffers: [
      {
        arrayType: 'Float32Array',
        itemSize: 3,
        normalized: false,
        bytes: new Uint8Array(new Float32Array([1, 0.5, 0]).buffer),
      },
      null,
    ],
    controls: '{"profile":"as-authored"}',
  };
}

function cloneSnapshot(source: SemanticProjectSnapshot): SemanticProjectSnapshot {
  return {
    projectBytes: source.projectBytes.slice(),
    colorBuffers: source.colorBuffers.map((buffer) =>
      buffer
        ? {
            ...buffer,
            bytes: buffer.bytes.slice(),
          }
        : null,
    ),
    controls: source.controls,
  };
}

const baseline = snapshot();
assert.equal(sameSemanticProjectSnapshot(baseline, cloneSnapshot(baseline)), true);

const changedProject = cloneSnapshot(baseline);
changedProject.projectBytes[1] ^= 0xff;
assert.equal(sameSemanticProjectSnapshot(baseline, changedProject), false);

const changedColor = cloneSnapshot(baseline);
changedColor.colorBuffers[0]!.bytes[0] ^= 0xff;
assert.equal(sameSemanticProjectSnapshot(baseline, changedColor), false);

const colorShapeSource = cloneSnapshot(baseline);
const changedColorShape: SemanticProjectSnapshot = {
  ...colorShapeSource,
  colorBuffers: [{ ...colorShapeSource.colorBuffers[0]!, itemSize: 4 }, colorShapeSource.colorBuffers[1]],
};
assert.equal(sameSemanticProjectSnapshot(baseline, changedColorShape), false);

const changedControls: SemanticProjectSnapshot = {
  ...cloneSnapshot(baseline),
  controls: '{"profile":"edited"}',
};
assert.equal(sameSemanticProjectSnapshot(baseline, changedControls), false);

const routeInput = {
  hasFullSpectrumSource: false,
  paintedInputAvailable: true,
  distinctPaintAssignments: 2,
  paintedEngineEnabled: true,
  externalGeometryEndpoint: false,
};
assert.equal(selectSemanticSliceRoute(routeInput), 'painted');
assert.equal(selectSemanticSliceRoute({ ...routeInput, distinctPaintAssignments: 1 }), 'geometry');
assert.equal(
  selectSemanticSliceRoute({
    ...routeInput,
    hasFullSpectrumSource: true,
    paintedEngineEnabled: false,
    externalGeometryEndpoint: true,
  }),
  'fullspectrum',
);
assert.throws(
  () => selectSemanticSliceRoute({ ...routeInput, paintedEngineEnabled: false }),
  /no monochrome substitute.*Painted slicing is disabled/,
);
assert.throws(
  () => selectSemanticSliceRoute({ ...routeInput, externalGeometryEndpoint: true }),
  /no monochrome substitute.*external geometry endpoint/,
);
assert.throws(() => selectSemanticSliceRoute({ ...routeInput, paintedInputAvailable: false }), /could not be encoded/);

const expected = 'G1 X10 E1';
assert.equal(await requireSemanticSlice('painted', async () => expected), expected);

const engineFailure = new Error('engine aborted');
await assert.rejects(
  requireSemanticSlice('painted', async () => {
    throw engineFailure;
  }),
  (error: unknown) => {
    assert.ok(error instanceof SemanticSliceError);
    assert.equal(error.code, 'SEMANTIC_SLICE_FAILED');
    assert.equal(error.workflow, 'painted');
    assert.equal(error.cause, engineFailure);
    assert.match(error.message, /no monochrome substitute/);
    assert.match(error.message, /engine aborted/);
    return true;
  },
);

await assert.rejects(
  requireSemanticSlice('fullspectrum', async () => {
    throw new Error('canonical live-project slicing is required');
  }),
  (error: unknown) => {
    assert.ok(error instanceof SemanticSliceError);
    assert.equal(error.workflow, 'fullspectrum');
    assert.match(error.message, /no geometry-only substitute/);
    assert.match(error.message, /canonical live-project slicing is required/);
    return true;
  },
);

console.log('semantic slice fail-closed guard tests passed');
