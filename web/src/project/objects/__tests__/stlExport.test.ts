import assert from 'node:assert/strict';

import { createProjectFixture } from '../../__tests__/fixtures';
import { InMemoryAssetRepository } from '../../assets';
import { cloneProjectState } from '../../domain/canonical';
import { entityId } from '../../domain/ids';
import { emptyFacetAnnotations, identityTransform } from '../../domain/model';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { readSafeZip } from '../../serialization/deterministicZip';
import { plateGcodeFilename, toolpathObjFilename } from '../../outputNames';
import {
  exportCanonicalInstancesAsBinaryStl,
  exportCanonicalStlArchive,
  exportCanonicalStlFile,
  exportCanonicalVolumeAsBinaryStl,
  selectedActivePlateInstanceIds,
  stlExportedStatus,
  stlExportInstanceIds,
  suggestedStlFilename,
} from '../stlExport';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const asset = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    sourceFilename: 'triangle.stl',
  });
  state.sourceAssets = [asset.descriptor];
  const volume = state.plates[0].objects[0].volumes[0];
  volume.source = { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 1 };
  volume.transform = { ...identityTransform(), translationMm: [1, 2, 3] };
  const instance = state.plates[0].objects[0].instances[0];
  instance.transform = {
    translationMm: [10, 20, 30],
    rotation: [0, 0, 0, 1],
    scale: [-2, 1, 1],
  };
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  return { fixture, state, assets };
}

function vectorAt(view: DataView, offset: number): number[] {
  return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
}

test('writes deterministic transformed binary facets and corrects mirrored winding', () => {
  const { fixture, state, assets } = harness();
  const first = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance]);
  const second = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance]);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.byteLength, 134);
  assert.equal(first.triangleCount, 1);
  assert.equal(first.instanceCount, 1);
  assert.deepEqual(first.volumeIds, [fixture.ids.volume]);

  const view = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength);
  assert.equal(view.getUint32(80, true), 1);
  assert.deepEqual(vectorAt(view, 84), [0, 0, 1]);
  assert.deepEqual(vectorAt(view, 96), [8, 22, 33]);
  assert.deepEqual(vectorAt(view, 108), [8, 23, 33]);
  assert.deepEqual(vectorAt(view, 120), [6, 22, 33]);
  assert.equal(view.getUint16(132, true), 0);
});

test('merges an exact stable-ID set while excluding non-printing modifiers', () => {
  const { fixture, state, assets } = harness();
  const secondId = entityId<'instance'>('import:stl-export:second');
  state.plates[0].objects[0].instances.push({
    id: secondId,
    transform: { ...identityTransform(), translationMm: [0, 0, 5] },
    printable: true,
  });
  const modifierId = entityId<'volume'>('import:stl-export:modifier');
  state.plates[0].objects[0].volumes.push({
    ...state.plates[0].objects[0].volumes[0],
    id: modifierId,
    name: 'Ignored modifier',
    role: 'parameter-modifier',
    transform: identityTransform(),
    config: {},
    annotations: emptyFacetAnnotations(0),
  });

  const result = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance, secondId]);
  assert.equal(result.triangleCount, 2);
  assert.equal(result.instanceCount, 2);
  assert.deepEqual(result.volumeIds, [fixture.ids.volume, fixture.ids.volume]);
  assert.equal(result.bytes.byteLength, 184);
});

test('fails closed for CSG, duplicate or unknown targets, stale counts, and asset drift', () => {
  const { fixture, state, assets } = harness();
  assert.throws(() => exportCanonicalInstancesAsBinaryStl(state, assets, []), /at least one instance/i);
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance, fixture.ids.instance]),
    /duplicate instance/i,
  );
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(state, assets, [entityId<'instance'>('import:stl-export:missing')]),
    /unknown instance/i,
  );

  const stale = cloneProjectState(state);
  stale.plates[0].objects[0].volumes[0].source.triangleCount = 2;
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(stale, assets, [fixture.ids.instance]),
    /triangle count differs/i,
  );

  const mismatched = cloneProjectState(state);
  mismatched.sourceAssets[0].sourceFilename = 'different.stl';
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(mismatched, assets, [fixture.ids.instance]),
    /metadata differs/i,
  );

  const csg = cloneProjectState(state);
  csg.plates[0].objects[0].volumes[0].role = 'negative-volume';
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(csg, assets, [fixture.ids.instance]),
    /requires canonical CSG/i,
  );
});

test('exportCanonicalVolumeAsBinaryStl exports single volume in local space without instance transforms', () => {
  const { fixture, state, assets } = harness();
  const bytes = exportCanonicalVolumeAsBinaryStl(state, assets, fixture.ids.volume);
  assert.equal(bytes.byteLength, 84 + 50);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(80, true), 1);
  // First vertex is at local (0, 0, 0)
  assert.equal(view.getFloat32(84 + 12, true), 0);
  assert.equal(view.getFloat32(84 + 16, true), 0);
  assert.equal(view.getFloat32(84 + 20, true), 0);
});

test('the STL actions take the selected instances on the active plate, else the whole plate', () => {
  const { fixture, state } = harness();
  const object = state.plates[0].objects[0];
  const second = {
    ...structuredClone(object.instances[0]),
    id: entityId<'instance'>('00000000-0000-4000-8000-0000000000b2'),
  };
  object.instances.push(second);
  const unknown = entityId<'instance'>('00000000-0000-4000-8000-0000000000b9');
  assert.deepEqual(stlExportInstanceIds(state, []), [fixture.ids.instance, second.id]);
  assert.deepEqual(stlExportInstanceIds(state, [second.id, unknown]), [second.id]);
  assert.deepEqual(selectedActivePlateInstanceIds(state, [unknown]), []);
  assert.deepEqual(stlExportInstanceIds(state, [unknown]), [fixture.ids.instance, second.id]);
});

test('a merged STL is offered under its instance, object or project name', () => {
  const { fixture, state, assets } = harness();
  state.plates[0].objects[0].name = 'Bracket.STL';
  assert.equal(exportCanonicalStlFile(state, assets, [fixture.ids.instance]).suggestedFilename, 'Bracket.stl');
  state.plates[0].objects[0].instances[0].name = '';
  assert.equal(exportCanonicalStlFile(state, assets, [fixture.ids.instance]).suggestedFilename, 'OrcaXR-model.stl');
  assert.equal(suggestedStlFilename('\u0001a<b>:c. . '), '-a-b--c.stl');
  assert.equal(suggestedStlFilename('ﬁ①'), 'fi1.stl');
  assert.equal(suggestedStlFilename('x'.repeat(130)).length, 124);
  assert.equal(stlExportedStatus(1, 1), 'Exported 1 model as 1 STL triangle.');
  assert.equal(stlExportedStatus(2, 1234), `Exported 2 models as ${(1234).toLocaleString()} STL triangles.`);
});

test('every instance becomes its own ZIP member, repeated names numbered without regard to case', () => {
  const { fixture, state, assets } = harness();
  state.name = 'Projet été';
  const object = state.plates[0].objects[0];
  object.instances[0].name = 'Part';
  const copy = (id: string, name?: string) => {
    const instance = { ...structuredClone(object.instances[0]), id: entityId<'instance'>(id) };
    if (name === undefined) delete instance.name;
    else instance.name = name;
    return instance;
  };
  object.instances.push(
    copy('00000000-0000-4000-8000-0000000000c2', 'part'),
    copy('00000000-0000-4000-8000-0000000000c3', 'Part_2'),
    copy('00000000-0000-4000-8000-0000000000c4'),
  );
  const archive = exportCanonicalStlArchive(state, assets);
  assert.equal(archive.mediaType, 'application/zip');
  assert.equal(archive.suggestedFilename, 'Projet_t_stls.zip');
  assert.equal(archive.instanceCount, 4);
  assert.deepEqual([...readSafeZip(archive.bytes).keys()].sort(), [
    'Part.stl',
    'Part_2_2.stl',
    'Tiny_triangle.stl',
    'part_2.stl',
  ]);
  const single = exportCanonicalStlArchive(state, assets, [fixture.ids.instance]);
  assert.equal(single.mediaType, 'model/stl');
  assert.throws(
    () => exportCanonicalStlArchive({ ...state, plates: [{ ...state.plates[0], objects: [] }] }, assets),
    /No models to export/,
  );
});

test('plate outputs keep only A–Z a–z 0–9 . _ - (each other run one underscore)', () => {
  assert.equal(plateGcodeFilename('Plate 1'), 'Plate_1.gcode');
  assert.equal(plateGcodeFilename(undefined), 'plate.gcode');
  assert.equal(plateGcodeFilename('Été 😀 v1.2'), '_t_v1.2.gcode');
  assert.equal(toolpathObjFilename('Plate 2'), 'Plate_2_toolpaths.obj');
});

console.log(`\nCanonical binary STL export: ${passed} tests passed.`);
