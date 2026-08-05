import assert from 'node:assert';
import {
  CORE_MODEL_PATH,
  MODEL_SETTINGS_PATH,
  PROJECT_SETTINGS_PATH,
  extractBbsPlateLayout,
  extractBbsPlateLayoutResult,
} from '../serialization/bbsCore';

const encode = (value: string) => new TextEncoder().encode(value);

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

function files(model: string, settings?: string, project?: Record<string, unknown>) {
  const result = new Map<string, Uint8Array>([[CORE_MODEL_PATH, encode(model)]]);
  if (settings) result.set(MODEL_SETTINGS_PATH, encode(settings));
  if (project) result.set(PROJECT_SETTINGS_PATH, encode(JSON.stringify(project)));
  return result;
}

const MODEL = `<?xml version="1.0"?>
<model><resources/>
 <build>
  <item objectid="7"/>
  <item objectid="7"/>
  <item objectid="9"/>
  <item objectid="11"/>
 </build>
</model>`;

test('maps nested BBS plate metadata by object and per-object occurrence', () => {
  const settings = `<?xml version="1.0"?>
<config>
 <plate>
  <metadata key="plater_id" value="2"/>
  <metadata key="plater_name" value="Second &amp; More"/>
  <model_instance><metadata key="object_id" value="7"/><metadata key="instance_id" value="1"/></model_instance>
 </plate>
 <plate>
  <metadata key="plater_id" value="1"/>
  <metadata key="plater_name" value="First"/>
  <model_instance><metadata key="object_id" value="7"/><metadata key="instance_id" value="0"/></model_instance>
 </plate>
 <plate>
  <metadata key="plater_id" value="3"/>
  <metadata key="plater_name" value="Third"/>
  <model_instance><metadata key="object_id" value="9"/><metadata key="instance_id" value="0"/></model_instance>
 </plate>
</config>`;
  const layout = extractBbsPlateLayout(
    files(MODEL, settings, {
      printable_area: ['0.5x1', '200.5x1', '200.5x101', '0.5x101'],
    }),
  );
  assert.ok(layout);
  assert.strictEqual(layout!.buildItemCount, 4);
  assert.deepStrictEqual(layout!.bedSizeMm, { x: 200, y: 100 });
  assert.deepStrictEqual(
    layout!.plates.map((plate) => [plate.sourceId, plate.name, plate.buildItemIndices]),
    [
      [1, 'First', [0]],
      [2, 'Second & More', [1]],
      [3, 'Third', [2]],
    ],
  );
  assert.deepStrictEqual(
    layout!.plates.map((plate) => plate.originMm),
    [
      { x: 0, y: 0 },
      { x: 240, y: 0 },
      { x: 0, y: -120 },
    ],
  );
  assert.deepStrictEqual(layout!.unassignedBuildItemIndices, [3]);
});

test('uses an object-level fallback only when its plate is unambiguous', () => {
  const model = '<model><resources/><build><item objectid="12"/><item objectid="12"/></build></model>';
  const settings = `<config><plate name="Only">
    <model_instance object_id="12" instance_id="7"/>
  </plate></config>`;
  const layout = extractBbsPlateLayout(files(model, settings));
  assert.ok(layout);
  assert.deepStrictEqual(layout!.plates[0].buildItemIndices, [0, 1]);
  assert.deepStrictEqual(layout!.unassignedBuildItemIndices, []);
});

test('parses mixed self-closing and nested instances without consuming neighbors', () => {
  const model = '<model><resources/><build><item objectid="4"/><item objectid="5"/></build></model>';
  const settings = `<config><plate name="Mixed">
    <model_instance object_id="4" instance_id="0"/>
    <model_instance><metadata key="object_id" value="5"/><metadata key="instance_id" value="0"/></model_instance>
  </plate></config>`;
  const layout = extractBbsPlateLayout(files(model, settings));
  assert.ok(layout);
  assert.deepStrictEqual(layout!.plates[0].buildItemIndices, [0, 1]);
  assert.deepStrictEqual(layout!.unassignedBuildItemIndices, []);
});

test('fails closed when the same object occurrence is assigned to different plates', () => {
  const model = '<model><resources/><build><item objectid="8"/></build></model>';
  const settings = `<config>
    <plate name="One"><model_instance object_id="8" instance_id="0"/></plate>
    <plate name="Two"><model_instance object_id="8" instance_id="0"/></plate>
  </config>`;
  const layout = extractBbsPlateLayout(files(model, settings));
  assert.ok(layout);
  assert.deepStrictEqual(
    layout!.plates.map((plate) => plate.buildItemIndices),
    [[], []],
  );
  assert.deepStrictEqual(layout!.unassignedBuildItemIndices, [0]);
});

test('returns null when official plate metadata is absent', () => {
  assert.strictEqual(extractBbsPlateLayout(files(MODEL)), null);
  assert.deepStrictEqual(extractBbsPlateLayoutResult(files(MODEL)), { status: 'absent', layout: null });
});

test('distinguishes declared plate metadata that cannot be parsed safely', () => {
  const malformed = '<config><plate name="Unclosed"><model_instance object_id="7" instance_id="0"/></config>';
  assert.deepStrictEqual(extractBbsPlateLayoutResult(files(MODEL, malformed)), { status: 'invalid', layout: null });
});

test('rejects duplicate, non-contiguous, and contradictory source plate IDs', () => {
  const duplicate = `<config>
    <plate id="1"><model_instance object_id="7" instance_id="0"/></plate>
    <plate id="1"><model_instance object_id="7" instance_id="1"/></plate>
  </config>`;
  const contradictory = `<config>
    <plate id="1"><metadata key="plater_id" value="2"/><model_instance object_id="7" instance_id="0"/></plate>
  </config>`;
  assert.deepStrictEqual(extractBbsPlateLayoutResult(files(MODEL, duplicate)), { status: 'invalid', layout: null });
  assert.deepStrictEqual(extractBbsPlateLayoutResult(files(MODEL, contradictory)), {
    status: 'invalid',
    layout: null,
  });
});

console.log(`\nBBS plate layout: ${passed} tests passed.`);
