import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import {
  BbsPlateCoordinateError,
  Bbs3mfProjectSerializer,
  ORCAXR_EXTENSION_PATH,
  UnsafeThreeMfArchiveError,
  canonicalStringify,
  entityId,
  projectFingerprint,
  readSafeZip,
  writeDeterministicZip,
  type ProjectArchiveSnapshot,
} from '..';
import { createProjectFixture } from './fixtures';

const CORE_MODEL_PATH = '3D/3dmodel.model';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function archiveFixture(): ProjectArchiveSnapshot {
  const fixture = createProjectFixture();
  return {
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 7,
    sourceHash: projectFingerprint(fixture.state),
  };
}

await test('emits a deterministic BBS-compatible core plus lossless canonical envelope', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = archiveFixture();
  const first = await serializer.serialize(snapshot);
  const second = await serializer.serialize(snapshot);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.mediaType, 'model/3mf');
  assert.equal(first.sourceRevision, snapshot.sourceRevision);
  assert.equal(first.sourceHash, snapshot.sourceHash);

  const files = readSafeZip(first.bytes);
  for (const path of [
    '[Content_Types].xml',
    '_rels/.rels',
    CORE_MODEL_PATH,
    '3D/_rels/3dmodel.model.rels',
    'Metadata/model_settings.config',
    'Metadata/project_settings.config',
    ORCAXR_EXTENSION_PATH,
  ]) {
    assert.ok(files.has(path), `expected package entry ${path}`);
  }
  const core = text(files.get(CORE_MODEL_PATH)!);
  assert.match(core, /xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02"/);
  assert.match(core, /<metadata name="Application">BambuStudio-/);
  assert.match(core, /<metadata name="BambuStudio:3mfVersion">1<\/metadata>/);
  assert.match(core, /<components>/);
  assert.match(core, /paint_color="0C"/);
  const settings = JSON.parse(text(files.get('Metadata/project_settings.config')!));
  assert.deepEqual(settings.filament_colour, ['#FF0000', '#0000FF']);
  assert.equal(typeof settings.mixed_filament_definitions, 'string');

  const reopened = await serializer.deserialize(first.bytes);
  assert.equal(canonicalStringify(reopened.state), canonicalStringify(snapshot.state));
  assert.equal(reopened.assets.length, 1);
  assert.deepEqual(reopened.assets[0].bytes, snapshot.assets[0].bytes);
  const savedAgain = await serializer.serialize({
    state: reopened.state,
    assets: reopened.assets,
    sourceRevision: snapshot.sourceRevision,
    sourceHash: snapshot.sourceHash,
  });
  assert.deepEqual(savedAgain.bytes, first.bytes);
});

await test('preserves newly encountered safe ZIP entries byte-for-byte across reopen-save', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const initial = await serializer.serialize(archiveFixture());
  const injected = readSafeZip(initial.bytes);
  const opaque = new Uint8Array([0, 255, 17, 23, 42]);
  const metadata = new TextEncoder().encode('<vendor setting="keep-me"/>\n');
  const projectSettings = JSON.parse(text(injected.get('Metadata/project_settings.config')!));
  projectSettings.vendor_future_setting = 'keep-me';
  const modifiedProjectSettings = new TextEncoder().encode(`${JSON.stringify(projectSettings)}\n`);
  injected.set('Extensions/vendor/opaque.bin', opaque);
  injected.set('Metadata/vendor_extension.xml', metadata);
  injected.set('Metadata/project_settings.config', modifiedProjectSettings);
  injected.set(
    '[Content_Types].xml',
    new TextEncoder().encode(
      text(injected.get('[Content_Types].xml')!).replace(
        'Extension="bin" ContentType="application/octet-stream"',
        'Extension="bin" ContentType="application/x-vendor-opaque"',
      ),
    ),
  );
  injected.set(
    '_rels/.rels',
    new TextEncoder().encode(
      text(injected.get('_rels/.rels')!).replace(
        '</Relationships>',
        ' <Relationship Id="rel-vendor" Type="urn:vendor:opaque" Target="/Extensions/vendor/opaque.bin"/>\n</Relationships>',
      ),
    ),
  );
  const external = writeDeterministicZip(injected);

  const reopened = await serializer.deserialize(external);
  assert.deepEqual(reopened.state.extensionBlobs.map((entry) => entry.path).sort(), [
    'Extensions/vendor/opaque.bin',
    'Metadata/project_settings.config',
    'Metadata/vendor_extension.xml',
  ]);
  assert.match(reopened.warnings.join('\n'), /Preserved 3 package entries/);
  const saved = await serializer.serialize({
    state: reopened.state,
    assets: reopened.assets,
    sourceRevision: 8,
    sourceHash: projectFingerprint(reopened.state),
  });
  const output = readSafeZip(saved.bytes);
  assert.deepEqual(output.get('Extensions/vendor/opaque.bin'), opaque);
  assert.deepEqual(output.get('Metadata/vendor_extension.xml'), metadata);
  assert.deepEqual(output.get('Metadata/project_settings.config'), modifiedProjectSettings);
  assert.match(text(output.get('_rels/.rels')!), /Id="rel-vendor" Type="urn:vendor:opaque"/);
  assert.match(text(output.get('[Content_Types].xml')!), /Extension="bin" ContentType="application\/x-vendor-opaque"/);

  const reopenedAgain = await serializer.deserialize(saved.bytes);
  const savedAgain = await serializer.serialize({
    state: reopenedAgain.state,
    assets: reopenedAgain.assets,
    sourceRevision: 8,
    sourceHash: projectFingerprint(reopenedAgain.state),
  });
  assert.deepEqual(savedAgain.bytes, saved.bytes);
});

await test('rejects traversal, truncation, corrupt metadata, size violations, and cancellation', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const serialized = await serializer.serialize(archiveFixture());
  assert.throws(
    () => readSafeZip(serialized.bytes.subarray(0, serialized.bytes.byteLength - 5)),
    UnsafeThreeMfArchiveError,
  );
  const traversal = zipSync({ '../escape.txt': new Uint8Array([1]) });
  assert.throws(() => readSafeZip(traversal), /unsafe segment/i);
  const storedPayload = new Uint8Array([11, 22, 33, 44, 55, 66, 77]);
  const damaged = writeDeterministicZip(new Map([['Metadata/check.png', storedPayload]])).slice();
  const payloadOffset = findBytes(damaged, storedPayload);
  assert.ok(payloadOffset >= 0);
  damaged[payloadOffset + 3] ^= 0xff;
  assert.throws(() => readSafeZip(damaged), /CRC-32 integrity check/);

  const tinyLimit = new Bbs3mfProjectSerializer({ zipLimits: { maxEntryBytes: 16 } });
  await assert.rejects(tinyLimit.deserialize(serialized.bytes), /per-entry size limit/i);

  const corruptFiles = readSafeZip(serialized.bytes);
  corruptFiles.set(ORCAXR_EXTENSION_PATH, new TextEncoder().encode('{not-json'));
  await assert.rejects(
    serializer.deserialize(writeDeterministicZip(corruptFiles)),
    /Invalid OrcaXR canonical metadata/,
  );
  await assert.rejects(serializer.serialize(archiveFixture(), { aborted: true, reason: 'test stop' }), {
    name: 'AbortError',
    message: 'test stop',
  });
});

await test('normalizes official BBS virtual-bed offsets and restores them only in the standard projection', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const source = foreignMultiPlateArchive();
  const imported = await serializer.deserialize(source);
  assert.deepEqual(
    imported.state.plates.map((plate) => plate.objects[0].instances[0].transform.translationMm),
    [
      [15, 25, 0],
      [30, 40, 0],
    ],
  );
  assert.match(imported.warnings.join('\n'), /Normalized 1 BBS build transform/);

  const saved = await serializer.serialize({
    state: imported.state,
    assets: imported.assets,
    sourceRevision: 3,
    sourceHash: projectFingerprint(imported.state),
  });
  const files = readSafeZip(saved.bytes);
  assert.deepEqual(buildItemTranslations(text(files.get(CORE_MODEL_PATH)!)), [
    [15, 25, 0],
    [270, 40, 0],
  ]);
  assert.deepEqual(files.get('Extensions/vendor-coordinate-data.bin'), new Uint8Array([3, 1, 4, 1, 5]));

  const reopened = await serializer.deserialize(saved.bytes);
  assert.deepEqual(
    reopened.state.plates.map((plate) => plate.objects[0].instances[0].transform.translationMm),
    [
      [15, 25, 0],
      [30, 40, 0],
    ],
  );
  assert.equal(canonicalStringify(reopened.state), canonicalStringify(imported.state));
});

await test('emits empty intermediate and trailing plates without corrupting virtual-grid coordinates', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = archiveFixture();
  const object = snapshot.state.plates[0].objects.pop()!;
  object.instances[0].transform.translationMm = [30, 40, 0];
  const secondPlate = {
    id: entityId<'plate'>('import:test:bbs-empty-plate-2'),
    name: 'Empty intermediate',
    order: 1,
    printable: true,
    config: {},
    objects: [],
  };
  const thirdPlate = {
    id: entityId<'plate'>('import:test:bbs-used-plate-3'),
    name: 'Used third',
    order: 2,
    printable: true,
    config: {},
    objects: [object],
  };
  const fourthPlate = {
    id: entityId<'plate'>('import:test:bbs-empty-plate-4'),
    name: 'Empty trailing',
    order: 3,
    printable: true,
    config: {},
    objects: [],
  };
  snapshot.state.plates.push(secondPlate, thirdPlate, fourthPlate);
  snapshot.state.activePlateId = thirdPlate.id;
  snapshot.state.config.printable_area = ['0x0', '200x0', '200x100', '0x100'];
  snapshot.sourceHash = projectFingerprint(snapshot.state);

  const saved = await serializer.serialize(snapshot);
  const files = readSafeZip(saved.bytes);
  const modelSettings = text(files.get('Metadata/model_settings.config')!);
  assert.deepEqual(
    [...modelSettings.matchAll(/<metadata key="plater_id" value="(\d+)"\/>/g)].map((match) => Number(match[1])),
    [1, 2, 3, 4],
  );
  assert.deepEqual(buildItemTranslations(text(files.get(CORE_MODEL_PATH)!)), [[30, -80, 0]]);

  files.delete(ORCAXR_EXTENSION_PATH);
  const foreignReopen = await serializer.deserialize(writeDeterministicZip(files));
  assert.deepEqual(
    foreignReopen.state.plates.map((plate) => plate.objects.length),
    [0, 0, 1, 0],
  );
  assert.deepEqual(foreignReopen.state.plates[2].objects[0].instances[0].transform.translationMm, [30, 40, 0]);
});

await test('fails closed when a used BBS virtual plate has no authoritative printable area', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  await assert.rejects(serializer.deserialize(foreignMultiPlateArchive({ includePrintableArea: false })), (error) => {
    assert.ok(error instanceof BbsPlateCoordinateError);
    assert.equal(error.code, 'missing-printable-area');
    assert.match(error.message, /plate 2.*printable_area/i);
    return true;
  });

  const imported = await serializer.deserialize(foreignMultiPlateArchive());
  delete imported.state.config.printable_area;
  await assert.rejects(
    serializer.serialize({
      state: imported.state,
      assets: imported.assets,
      sourceRevision: 4,
      sourceHash: projectFingerprint(imported.state),
    }),
    (error) => {
      assert.ok(error instanceof BbsPlateCoordinateError);
      assert.equal(error.code, 'missing-printable-area');
      assert.match(error.message, /global build coordinates/i);
      return true;
    },
  );
});

await test('opens an older canonical envelope safely when only its standard BBS projection lacks plate dimensions', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const imported = await serializer.deserialize(foreignMultiPlateArchive());
  const saved = await serializer.serialize({
    state: imported.state,
    assets: imported.assets,
    sourceRevision: 5,
    sourceHash: projectFingerprint(imported.state),
  });
  const files = readSafeZip(saved.bytes);
  const envelope = JSON.parse(text(files.get(ORCAXR_EXTENSION_PATH)!)) as {
    state: { config: Record<string, unknown> };
  };
  delete envelope.state.config.printable_area;
  files.set(ORCAXR_EXTENSION_PATH, new TextEncoder().encode(`${canonicalStringify(envelope)}\n`));

  const reopened = await serializer.deserialize(writeDeterministicZip(files));
  assert.deepEqual(
    reopened.state.plates.map((plate) => plate.objects[0].instances[0].transform.translationMm),
    [
      [15, 25, 0],
      [30, 40, 0],
    ],
  );
  assert.equal(reopened.state.config.printable_area, undefined);
  assert.match(reopened.warnings.join('\n'), /canonical OrcaXR envelope safely.*cannot be regenerated/i);
});

await test('fails closed instead of guessing a plate for contradictory BBS membership', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  await assert.rejects(serializer.deserialize(foreignMultiPlateArchive({ contradictoryMembership: true })), (error) => {
    assert.ok(error instanceof BbsPlateCoordinateError);
    assert.equal(error.code, 'unassigned-build-item');
    assert.match(error.message, /unassigned or conflicting/i);
    return true;
  });
});

await test('imports qualified Production Extension graphs and preserves split members deterministically', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const source = foreignSplitProductionArchive();
  const originalFiles = readSafeZip(source);
  const imported = await serializer.deserialize(source);
  assert.match(imported.warnings.join('\n'), /Resolved 2 referenced 3MF Production Extension model parts/);
  const plate = imported.state.plates[0];
  assert.equal(plate.objects.length, 3);
  const assemblyA = plate.objects.find((object) => object.name === 'Assembly A')!;
  const assemblyB = plate.objects.find((object) => object.name === 'Assembly B')!;
  const directB = plate.objects.find((object) => object !== assemblyB && object.name === 'B mesh')!;
  assert.ok(assemblyA && assemblyB && directB);
  assert.deepEqual(
    assemblyA.volumes.map((volume) => volume.name),
    ['A leaf', 'A leaf'],
  );
  assert.deepEqual(
    assemblyA.volumes.map((volume) => roundedTuple(volume.transform.translationMm)),
    [
      [10, 2, 0],
      [22, 0, 0],
    ],
  );
  assert.deepEqual(roundedTuple(assemblyB.volumes[0].transform.translationMm), [0, 33, 0]);
  assert.deepEqual(roundedTuple(assemblyA.instances[0].transform.translationMm), [100, 0, 0]);
  assert.deepEqual(roundedTuple(assemblyB.instances[0].transform.translationMm), [200, 0, 0]);
  assert.deepEqual(roundedTuple(directB.instances[0].transform.translationMm), [300, 0, 0]);
  assert.equal(assemblyA.volumes[0].source.assetId, assemblyA.volumes[1].source.assetId);
  assert.notEqual(assemblyA.volumes[0].source.assetId, assemblyB.volumes[0].source.assetId);
  assert.equal(assemblyA.volumes[0].filamentId, imported.state.filaments.physical[0].id);
  assert.equal(assemblyB.volumes[0].name, 'B leaf');
  assert.equal(assemblyB.volumes[0].filamentId, imported.state.filaments.physical[1].id);
  assert.ok(imported.state.extensionBlobs.some((blob) => blob.path === '3D/Objects/A.model'));
  assert.ok(imported.state.extensionBlobs.some((blob) => blob.path === '3D/Objects/B.model'));

  const snapshot = {
    state: imported.state,
    assets: imported.assets,
    sourceRevision: 9,
    sourceHash: projectFingerprint(imported.state),
  };
  const saved = await serializer.serialize(snapshot);
  const savedAgain = await serializer.serialize(snapshot);
  assert.deepEqual(savedAgain.bytes, saved.bytes);
  const output = readSafeZip(saved.bytes);
  assert.deepEqual(output.get('3D/Objects/A.model'), originalFiles.get('3D/Objects/A.model'));
  assert.deepEqual(output.get('3D/Objects/B.model'), originalFiles.get('3D/Objects/B.model'));
  assert.doesNotMatch(text(output.get(CORE_MODEL_PATH)!), /\bp:path=/);
  assert.match(text(output.get('3D/_rels/3dmodel.model.rels')!), /Target="\/3D\/Objects\/A\.model"/);
  const reopened = await serializer.deserialize(saved.bytes);
  assert.equal(canonicalStringify(reopened.state), canonicalStringify(imported.state));
  const resaved = await serializer.serialize({ ...snapshot, state: reopened.state, assets: reopened.assets });
  assert.deepEqual(resaved.bytes, saved.bytes);
});

await test('rejects unsafe or unresolved Production Extension resource graphs without guessing', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const mutate = (change: (files: Map<string, Uint8Array>) => void): Uint8Array => {
    const files = readSafeZip(foreignSplitProductionArchive());
    change(files);
    return writeDeterministicZip(files);
  };
  const replaceText = (files: Map<string, Uint8Array>, path: string, from: string, to: string): void => {
    const source = text(files.get(path)!);
    assert.ok(source.includes(from), `fixture ${path} must contain mutation source`);
    files.set(path, new TextEncoder().encode(source.replace(from, to)));
  };

  await assert.rejects(
    serializer.deserialize(
      mutate((files) => replaceText(files, CORE_MODEL_PATH, '/3D/Objects/A.model', '/3D/Objects/Missing.model')),
    ),
    /missing model part 3D\/Objects\/Missing\.model/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) =>
        replaceText(
          files,
          CORE_MODEL_PATH,
          'p:path="/3D/Objects/A.model" objectid="3"',
          'p:path="/3D/Objects/A.model" objectid="99"',
        ),
      ),
    ),
    /missing object 3D\/Objects\/A\.model#99/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) => replaceText(files, '3D/Objects/A.model', '<component objectid="1"', '<component objectid="3"')),
    ),
    /component graph contains a cycle/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) => {
        files.set('3D/Objects/A.model', new TextEncoder().encode(deepProductionModel(66)));
        replaceText(files, CORE_MODEL_PATH, 'A.model" objectid="3"', 'A.model" objectid="66"');
      }),
    ),
    /exceeds the maximum depth/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) => {
        const repeated = '<component objectid="1"/>'.repeat(16_385);
        files.set('3D/Objects/A.model', new TextEncoder().encode(externalProductionModel('A mesh', repeated)));
      }),
    ),
    /graph expansion exceeds the limit/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) => replaceText(files, CORE_MODEL_PATH, '/3D/Objects/A.model', '/3D/../escape.model')),
    ),
    /invalid 3MF Production Extension path/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) =>
        replaceText(
          files,
          '3D/Objects/A.model',
          '<component objectid="1"',
          '<component p:path="/3D/Objects/B.model" objectid="1"',
        ),
      ),
    ),
    /p:path on a non-root component/i,
  );
  await assert.rejects(
    serializer.deserialize(mutate((files) => replaceText(files, '3D/Objects/A.model', '</resources>', '</resource>'))),
    /mismatched XML closing tag/i,
  );
  await assert.rejects(
    serializer.deserialize(
      mutate((files) => {
        replaceText(
          files,
          CORE_MODEL_PATH,
          'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"',
          'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:q="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"',
        );
        replaceText(
          files,
          CORE_MODEL_PATH,
          'p:path="/3D/Objects/A.model" objectid="3"',
          'p:path="/3D/Objects/A.model" q:path="/3D/Objects/B.model" objectid="3"',
        );
      }),
    ),
    /conflicting Production Extension path attributes/i,
  );
});

await test('imports the structural parity oracle and retains unsupported BBS metadata', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const referenceBytes = new Uint8Array(
    await readFile(resolve(import.meta.dirname, '../../../../testdata/parity/fixtures/reference.3mf')),
  );
  const originalFiles = readSafeZip(referenceBytes);
  const imported = await serializer.deserialize(referenceBytes);
  assert.deepEqual(
    imported.state.plates.map((plate) => [plate.name, plate.objects.length]),
    [
      ['Primary', 2],
      ['Secondary', 1],
    ],
  );
  assert.deepEqual(imported.state.plates[1].objects[0].instances[0].transform.translationMm, [60, 20, 0]);
  assert.deepEqual(imported.state.plates[1].objects[0].volumes[1].transform.translationMm, [12, 0, 0]);
  assert.match(imported.warnings.join('\n'), /without OrcaXR canonical metadata/);
  assert.ok(imported.state.extensionBlobs.some((entry) => entry.path === 'Extensions/opaque.txt'));

  const saved = await serializer.serialize({
    state: imported.state,
    assets: imported.assets,
    sourceRevision: 1,
    sourceHash: projectFingerprint(imported.state),
  });
  const output = readSafeZip(saved.bytes);
  assert.deepEqual(output.get('Extensions/opaque.txt'), originalFiles.get('Extensions/opaque.txt'));
  assert.deepEqual(output.get('Metadata/model_settings.config'), originalFiles.get('Metadata/model_settings.config'));
  assert.deepEqual(
    output.get('Metadata/project_settings.config'),
    originalFiles.get('Metadata/project_settings.config'),
  );
  const rootRelationships = text(output.get('_rels/.rels')!);
  const modelRelationships = text(output.get('3D/_rels/3dmodel.model.rels')!);
  const projectedCore = text(output.get(CORE_MODEL_PATH)!);
  assert.match(rootRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/project-config"/);
  assert.match(modelRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/custom-gcode"/);
  assert.match(modelRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/extension"/);
  assert.match(projectedCore, /:face-tag="preserve-me"/);
  assert.match(projectedCore, /paint_color="1F"/);
  assert.match(projectedCore, /:stable-id="object-assembly"/);
  assert.match(projectedCore, /:instance-id="instance-a"/);

  const canonical = await serializer.deserialize(saved.bytes);
  assert.equal(canonicalStringify(canonical.state), canonicalStringify(imported.state));
});

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function foreignMultiPlateArchive(
  options: { includePrintableArea?: boolean; contradictoryMembership?: boolean } = {},
): Uint8Array {
  const includePrintableArea = options.includePrintableArea ?? true;
  const core = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">Virtual plate coordinates</metadata>
 <resources>
  <object id="1" type="model"><mesh><vertices>
   <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/>
  </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 15 25 0" printable="1"/>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 270 40 0" printable="1"/>
 </build>
</model>
`;
  const secondAssignment = options.contradictoryMembership
    ? '<model_instance object_id="1" instance_id="0"/>'
    : '<model_instance object_id="1" instance_id="1"/>';
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1"><part id="1" subtype="normal_part"/></object>
 <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="First"/>
  <model_instance object_id="1" instance_id="0"/>
 </plate>
 <plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Second"/>
  ${secondAssignment}
 </plate>
</config>
`;
  const projectSettings = {
    type: 'project_settings',
    filament_colour: ['#cccccc'],
    ...(includePrintableArea ? { printable_area: ['0.5x1', '200.5x1', '200.5x101', '0.5x101'] } : {}),
  };
  return writeDeterministicZip(
    new Map([
      [CORE_MODEL_PATH, new TextEncoder().encode(core)],
      ['Metadata/model_settings.config', new TextEncoder().encode(modelSettings)],
      ['Metadata/project_settings.config', new TextEncoder().encode(`${JSON.stringify(projectSettings)}\n`)],
      ['Extensions/vendor-coordinate-data.bin', new Uint8Array([3, 1, 4, 1, 5])],
    ]),
  );
}

function foreignSplitProductionArchive(): Uint8Array {
  const productionNamespace = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const core = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="${productionNamespace}" requiredextensions="p">
 <metadata name="Title">Split production graph</metadata>
 <resources>
  <object id="10" type="model" name="Root A"><components>
   <component p:path="/3D/Objects/A.model" objectid="3" transform="0 1 0 -1 0 0 0 0 1 10 0 0"/>
   <component p:path="/3D/Objects/A.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
  </components></object>
  <object id="20" type="model" name="Root B"><components>
   <component p:path="/3D/Objects/B.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 0 30 0"/>
  </components></object>
 </resources>
 <build>
  <item objectid="10" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>
  <item objectid="20" transform="1 0 0 0 1 0 0 0 1 200 0 0"/>
  <item p:path="/3D/Objects/B.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 300 0 0"/>
 </build>
</model>
`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="10"><metadata key="name" value="Assembly A"/><part id="1" subtype="normal_part"><metadata key="name" value="A leaf"/><metadata key="extruder" value="1"/></part></object>
 <object id="20"><metadata key="name" value="Assembly B"/><part id="1" subtype="normal_part"><metadata key="name" value="B leaf"/><metadata key="extruder" value="2"/></part></object>
 <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Production"/>
  <model_instance object_id="10" instance_id="0"/><model_instance object_id="20" instance_id="0"/><model_instance object_id="1" instance_id="0"/>
 </plate>
</config>
`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel-a" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/Objects/A.model"/>
 <Relationship Id="rel-b" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/Objects/B.model"/>
</Relationships>
`;
  return writeDeterministicZip(
    new Map([
      [CORE_MODEL_PATH, new TextEncoder().encode(core)],
      [
        '3D/Objects/A.model',
        new TextEncoder().encode(
          externalProductionModel('A mesh', '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>'),
        ),
      ],
      [
        '3D/Objects/B.model',
        new TextEncoder().encode(
          externalProductionModel('B mesh', '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 3 0"/>', 5),
        ),
      ],
      ['3D/_rels/3dmodel.model.rels', new TextEncoder().encode(relationships)],
      ['Metadata/model_settings.config', new TextEncoder().encode(modelSettings)],
      [
        'Metadata/project_settings.config',
        new TextEncoder().encode(`${JSON.stringify({ filament_colour: ['#FF0000', '#00FF00'] })}\n`),
      ],
    ]),
  );
}

function externalProductionModel(name: string, components: string, vertexOffset = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
  <object id="1" type="model" name="${name}"><mesh><vertices>
   <vertex x="${vertexOffset}" y="0" z="0"/><vertex x="${vertexOffset + 1}" y="0" z="0"/><vertex x="${vertexOffset}" y="1" z="0"/>
  </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
  <object id="3" type="model"><components>${components}</components></object>
 </resources>
 <build/>
</model>
`;
}

function deepProductionModel(depth: number): string {
  const objects = [
    '<object id="1" type="model" name="A mesh"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>',
  ];
  for (let id = 2; id <= depth; id += 1) {
    objects.push(`<object id="${id}" type="model"><components><component objectid="${id - 1}"/></components></object>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join(
    '',
  )}</resources><build/></model>
`;
}

function roundedTuple(values: readonly number[]): number[] {
  return values.map((value) => Math.round(value * 1e9) / 1e9);
}

function buildItemTranslations(core: string): number[][] {
  return [...core.matchAll(/<item\b[^>]*\btransform="([^"]+)"/g)].map((match) =>
    match[1].trim().split(/\s+/).slice(9, 12).map(Number),
  );
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return start;
  }
  return -1;
}

console.log(`\nBBS-compatible 3MF serializer: ${passed} tests passed.`);
