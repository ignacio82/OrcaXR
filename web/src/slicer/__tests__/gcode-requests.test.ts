import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateGcodeRequest } from '../../../../contracts/generated/gcode-requests';
import { encodeGcodeInspection } from '../core/GcodeRequests';

const corpus = JSON.parse(
  readFileSync(new URL('../../../../testdata/cross-platform/request-vectors.json', import.meta.url), 'utf8'),
);
for (const vector of corpus.vectors) {
  const check = () => validateGcodeRequest(vector.kind, JSON.parse(vector.json));
  if (vector.shapeValid) assert.doesNotThrow(check, vector.id);
  else assert.throws(check, vector.id);
}
const request = {
  mode: 'Tool',
  layerTimes: { secondsByLayerBits: new Uint32Array([0xffffffff]), provenance: new Uint16Array([0xd800, 0xdc00]) },
};
assert.doesNotThrow(() => validateGcodeRequest('PreviewRequest', request));
const detached = new Uint32Array([1]);
structuredClone(detached.buffer, { transfer: [detached.buffer] });
assert.throws(() => validateGcodeRequest('LayerTimesBits', { secondsByLayerBits: detached, provenance: [] }));
assert.throws(() =>
  validateGcodeRequest('LayerTimesBits', {
    secondsByLayerBits: new Uint32Array(new SharedArrayBuffer(4)),
    provenance: [],
  }),
);
assert.throws(() => validateGcodeRequest('InspectionRequest', Object.create({ singleLayer: true })));
let reads = 0;
assert.throws(() =>
  validateGcodeRequest('InspectionRequest', {
    get singleLayer() {
      reads++;
      return true;
    },
  }),
);
assert.equal(reads, 0);
assert.deepEqual(JSON.parse(encodeGcodeInspection([], {}, false)), {
  version: 1,
  operation: 'inspection',
  window: [],
  request: {},
  includeSource: false,
});
console.log(
  `Generated request contract: ${corpus.vectors.length} independent cases and typed-array/object guards passed.`,
);
