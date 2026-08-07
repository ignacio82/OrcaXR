import assert from 'node:assert/strict';
import { zipSync } from 'fflate';

import { InMemoryAssetRepository } from '../../assets';
import { createEmptyProject, type ProjectState } from '../../domain/model';
import { UuidIdSource, seededRandom } from '../../domain/ids';
import { CommandBus } from '../../history/commandBus';
import { SelectionStore } from '../../selection';
import { ProjectStore } from '../../store';
import { decodeIndexedMeshAsset } from '../../meshCodec';
import { ModelImportParser } from '../ModelImportParser';
import { ProjectImportCoordinator } from '../ProjectImportCoordinator';
import { ImportPreparationError } from '../types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function createHarness(seed = 0x5106) {
  const ids = new UuidIdSource(seededRandom(seed));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-07T00:00:00.000Z' });
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  return { ids, project, selection, assets, commands };
}

function coordinatorFor(
  harness: ReturnType<typeof createHarness>,
  placement?: { bedSizeMm?: readonly [number, number]; dropToBed?: boolean },
) {
  return new ProjectImportCoordinator({
    parser: new ModelImportParser({
      idSource: harness.ids,
      clock: () => '2026-08-07T12:00:00.000Z',
      placement,
    }),
    commands: harness.commands,
    now: () => '2026-08-07T12:00:00.000Z',
  });
}

const TRIANGLE_STL = binaryStl([
  [
    [0, 0, 4],
    [10, 0, 4],
    [0, 10, 4],
  ],
]);

function binaryStl(triangles: readonly (readonly (readonly number[])[])[]): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  bytes.set(new TextEncoder().encode('orcaxr'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const corner of triangle) {
      view.setFloat32(offset, corner[0], true);
      view.setFloat32(offset + 4, corner[1], true);
      view.setFloat32(offset + 8, corner[2], true);
      offset += 12;
    }
  });
  return bytes;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

await test('stages an STL as one canonical object and commits it as a single undoable command', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness);
  const before = harness.project.getSnapshot();

  const prepared = await coordinator.prepare({ bytes: TRIANGLE_STL, source: { filename: 'wedge.stl' } });
  assert.equal(prepared.preview.blocked, false);
  assert.equal(prepared.preview.counts.objects, 1);
  assert.equal(prepared.preview.counts.importedAssets, 1);
  assert.equal(harness.project.getSnapshot().revision, before.revision, 'preview never mutates the project');

  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds });
  const after = harness.project.getSnapshot();
  const plate = after.state.plates[0];
  assert.equal(plate.objects.length, 1);
  assert.equal(plate.objects[0].name, 'wedge');
  assert.equal(plate.objects[0].volumes.length, 1);
  assert.equal(plate.objects[0].volumes[0].source.triangleCount, 1);
  assert.equal(plate.objects[0].instances.length, 1);
  assert.equal(harness.assets.list().length, 1);

  harness.commands.undo();
  assert.equal(harness.project.getSnapshot().state.plates[0].objects.length, 0);
  assert.equal(harness.assets.list().length, 0, 'undo releases the imported asset');
  harness.commands.redo();
  assert.equal(harness.project.getSnapshot().state.plates[0].objects.length, 1);
});

await test('centres and drops imported geometry when a bed placement is supplied', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness, { bedSizeMm: [200, 200], dropToBed: true });
  const prepared = await coordinator.prepare({ bytes: TRIANGLE_STL, source: { filename: 'wedge.stl' } });
  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds });

  const instance = harness.project.getSnapshot().state.plates[0].objects[0].instances[0];
  assert.deepEqual(instance.transform.translationMm, [95, 95, -4]);
});

await test('preserves OBJ object and material part structure with source provenance', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness);
  const obj = `o Frame
usemtl steel
v 0 0 0
v 10 0 0
v 0 10 0
f 1 2 3
usemtl trim
v 0 0 5
v 10 0 5
v 0 10 5
f 4 5 6
`;
  const prepared = await coordinator.prepare({ bytes: utf8(obj), source: { filename: 'frame.obj' } });
  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds });

  const object = harness.project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.name, 'Frame');
  assert.deepEqual(
    object.volumes.map((volume) => volume.name),
    ['steel', 'trim'],
  );
  assert.equal((object.extensionData?.['orcaxr:importSource'] as { format: string }).format, 'obj');
  assert.equal(
    (object.volumes[0].extensionData?.['orcaxr:sourceMaterial'] as { name: string }).name,
    'steel',
    'source material identity is retained for later assignment',
  );
});

await test('converts AMF units into canonical millimetre geometry and reports the conversion', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness);
  const amf = `<amf unit="inch">
  <object id="1">
    <metadata type="name">Inch part</metadata>
    <mesh>
      <vertices>
        <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>
      </vertices>
      <volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume>
    </mesh>
  </object>
  <constellation id="2">
    <instance objectid="1"><deltax>0</deltax><deltay>0</deltay><deltaz>0</deltaz></instance>
    <instance objectid="1"><deltax>2</deltax><deltay>0</deltay><deltaz>0</deltaz></instance>
  </constellation>
</amf>`;
  const prepared = await coordinator.prepare({ bytes: utf8(amf), source: { filename: 'inch.amf' } });
  const conversion = prepared.preview.repairs.find((repair) => repair.kind === 'unit-conversion');
  assert.ok(conversion && conversion.message.includes('25.4'));
  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds });

  const object = harness.project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.instances.length, 2);
  assert.deepEqual(object.instances[1].transform.translationMm, [50.8, 0, 0]);
  const asset = harness.assets.get(object.volumes[0].source.assetId);
  assert.ok(asset);
  const mesh = decodeIndexedMeshAsset(asset);
  assert.deepEqual(
    mesh.vertices.map((vertex) => vertex.map((value) => Math.round(value * 100) / 100)),
    [
      [0, 0, 0],
      [25.4, 0, 0],
      [0, 25.4, 0],
    ],
  );
});

await test('deduplicates identical archive meshes and disambiguates repeated names', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness);
  const archive = zipSync({ 'a/part.stl': TRIANGLE_STL, 'b/part.stl': TRIANGLE_STL });
  const prepared = await coordinator.prepare({ bytes: archive, source: { filename: 'twins.zip' } });
  assert.equal(prepared.preview.counts.objects, 2);
  assert.equal(prepared.preview.counts.importedAssets, 1, 'identical member geometry stores one asset');
  assert.ok(prepared.preview.repairs.some((repair) => repair.kind === 'asset-deduplication'));
  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds });

  const plate = harness.project.getSnapshot().state.plates[0];
  assert.deepEqual(
    plate.objects.map((object) => object.name),
    ['part', 'part (2)'],
  );
  assert.equal(plate.objects[0].volumes[0].source.assetId, plate.objects[1].volumes[0].source.assetId);
  assert.equal(harness.assets.list().length, 1);
});

await test('leaves the project untouched when a source cannot be decoded', async () => {
  const harness = createHarness();
  const coordinator = coordinatorFor(harness);
  const before = harness.project.getSnapshot();
  await assert.rejects(
    () => coordinator.prepare({ bytes: utf8('ISO-10303-21;\nHEADER;\nENDSEC;\n'), source: { filename: 'part.step' } }),
    (error: unknown) => error instanceof ImportPreparationError,
  );
  const after = harness.project.getSnapshot();
  assert.equal(after.revision, before.revision);
  assert.equal(after.state.plates[0].objects.length, 0);
  assert.equal(harness.commands.getHistorySnapshot().undoCount, 0);
});

console.log(`\nModel import staging: ${passed} tests passed.`);
