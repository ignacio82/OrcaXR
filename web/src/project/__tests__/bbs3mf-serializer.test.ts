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
  contentDigest,
  entityId,
  layerEventEntry,
  projectFingerprint,
  readSafeZip,
  writeDeterministicZip,
  type ProjectArchiveSnapshot,
} from '..';
import { createProjectFixture } from './fixtures';
import { encodeBbsFacetRoot } from '../serialization/bbsFacetCodec';

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

await test('migrates legacy sparse false fuzzy-skin assignments to inherited state before v1 validation', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize(archiveFixture());
  const files = readSafeZip(saved.bytes);
  const envelope = JSON.parse(text(files.get(ORCAXR_EXTENSION_PATH)!));
  envelope.state.plates[0].objects[0].volumes[0].annotations.fuzzySkin = [{ value: false, triangles: [0] }];
  files.set(ORCAXR_EXTENSION_PATH, new TextEncoder().encode(`${JSON.stringify(envelope)}\n`));

  const reopened = await serializer.deserialize(writeDeterministicZip(files));
  assert.deepEqual(reopened.state.plates[0].objects[0].volumes[0].annotations.fuzzySkin, []);
  assert.match(reopened.warnings.join('\n'), /legacy false fuzzy-skin facet assignment/);

  envelope.state.plates[0].objects[0].volumes[0].annotations.fuzzySkin = [{ value: false, triangles: [99] }];
  files.set(ORCAXR_EXTENSION_PATH, new TextEncoder().encode(`${JSON.stringify(envelope)}\n`));
  await assert.rejects(serializer.deserialize(writeDeterministicZip(files)), /Triangle must be in/);
});

await test('persists refined leaves and round-trips the exact BBS tree without the canonical envelope', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = archiveFixture();
  const volume = snapshot.state.plates[0].objects[0].volumes[0];
  const [first, second] = snapshot.state.filaments.physical;
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: first.id } },
            { kind: 'leaf', state: { kind: 'assigned', value: second.id } },
          ],
        },
      ],
    },
    support: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: 'enforce' } },
            { kind: 'leaf', state: { kind: 'assigned', value: 'block' } },
          ],
        },
      ],
    },
    seam: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: 'prefer' } },
            { kind: 'leaf', state: { kind: 'assigned', value: 'avoid' } },
          ],
        },
      ],
    },
    fuzzySkin: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: true } },
            { kind: 'leaf', state: { kind: 'unpainted' } },
          ],
        },
      ],
    },
    brim: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: true } },
            { kind: 'leaf', state: { kind: 'assigned', value: false } },
          ],
        },
      ],
    },
  };
  volume.annotations.support = [];
  volume.annotations.seam = [];
  volume.annotations.fuzzySkin = [];
  volume.annotations.brim = [];
  snapshot.sourceHash = projectFingerprint(snapshot.state);

  const saved = await serializer.serialize(snapshot);
  assert.match((saved.warnings ?? []).join('\n'), /refined brim facet annotations.*no standard brim-paint attribute/);
  const core = text(readSafeZip(saved.bytes).get(CORE_MODEL_PATH)!);
  assert.match(core, /paint_color="481"/);
  assert.match(core, /paint_supports="481"/);
  assert.match(core, /paint_seam="481"/);
  assert.match(core, /paint_fuzzy_skin="401"/);
  const files = readSafeZip(saved.bytes);
  files.delete(ORCAXR_EXTENSION_PATH);
  const reopened = await serializer.deserialize(writeDeterministicZip(files));
  const importedVolume = reopened.state.plates[0].objects[0].volumes[0];
  assert.deepEqual(importedVolume.annotations.color, []);
  assert.equal(importedVolume.annotations.refinement?.color?.roots[0].kind, 'split');
  assert.equal(importedVolume.annotations.refinement?.support?.roots[0].kind, 'split');
  assert.equal(importedVolume.annotations.refinement?.seam?.roots[0].kind, 'split');
  assert.equal(importedVolume.annotations.refinement?.fuzzySkin?.roots[0].kind, 'split');
  const importedRoot = importedVolume.annotations.refinement!.color!.roots[0];
  assert.deepEqual(
    importedRoot.kind === 'split'
      ? importedRoot.children.map((child) =>
          child.kind === 'leaf' && child.state.kind === 'assigned' ? child.state.value : null,
        )
      : [],
    reopened.state.filaments.physical.slice(0, 2).map((filament) => filament.id),
  );
  const resaved = await serializer.serialize({
    state: reopened.state,
    assets: reopened.assets,
    sourceRevision: 1,
    sourceHash: projectFingerprint(reopened.state),
  });
  assert.match(text(readSafeZip(resaved.bytes).get(CORE_MODEL_PATH)!), /paint_color="481"/);
});

await test('canonical facet attributes win over colliding preserved extension metadata', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = archiveFixture();
  const volume = snapshot.state.plates[0].objects[0].volumes[0];
  volume.annotations.support = [{ value: 'enforce', triangles: [0] }];
  volume.annotations.seam = [{ value: 'prefer', triangles: [0] }];
  volume.annotations.fuzzySkin = [{ value: true, triangles: [0] }];
  volume.extensionData = {
    ...volume.extensionData,
    'https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes': [
      {
        triangle: 0,
        attributes: [
          { namespace: '', name: 'v1', value: '999' },
          { namespace: '', name: 'paint_color', value: '4' },
          { namespace: '', name: 'paint_supports', value: '8' },
          { namespace: '', name: 'paint_seam', value: '8' },
          { namespace: '', name: 'paint_fuzzy_skin', value: '8' },
          { namespace: '', name: 'paint_fuzzy', value: '8' },
          { namespace: 'urn:vendor:facet', name: 'face-tag', value: 'preserve-me' },
        ],
      },
    ],
  };
  snapshot.sourceHash = projectFingerprint(snapshot.state);

  const core = text(readSafeZip((await serializer.serialize(snapshot)).bytes).get(CORE_MODEL_PATH)!);
  assert.match(core, /<triangle v1="0" v2="1" v3="2"/);
  assert.match(core, /paint_color="0C"/);
  assert.match(core, /paint_supports="4"/);
  assert.match(core, /paint_seam="4"/);
  assert.match(core, /paint_fuzzy_skin="4"/);
  assert.match(core, /:face-tag="preserve-me"/);
  assert.doesNotMatch(core, /v1="999"|paint_color="4"|paint_supports="8"|paint_seam="8"/);
  assert.doesNotMatch(core, /paint_fuzzy_skin="8"| paint_fuzzy=/);
});

await test('rejects malformed, deep, trailing, and unresolved BBS facet paint atomically', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = archiveFixture();
  const volume = snapshot.state.plates[0].objects[0].volumes[0];
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: snapshot.state.filaments.physical[0].id } },
            { kind: 'leaf', state: { kind: 'assigned', value: snapshot.state.filaments.physical[1].id } },
          ],
        },
      ],
    },
  };
  snapshot.sourceHash = projectFingerprint(snapshot.state);
  const saved = await serializer.serialize(snapshot);
  const deepStream = [...new Array(65).fill(1), 0, ...new Array(65).fill(0)];
  const deep = deepStream
    .reverse()
    .map((nibble) => nibble.toString(16))
    .join('');
  for (const [encoded, message] of [
    ['1', /truncated/],
    ['4481', /trailing data/],
    [deep, /depth limit/],
  ] as const) {
    const files = readSafeZip(saved.bytes);
    files.delete(ORCAXR_EXTENSION_PATH);
    files.set(
      CORE_MODEL_PATH,
      new TextEncoder().encode(
        text(files.get(CORE_MODEL_PATH)!).replace('paint_color="481"', `paint_color="${encoded}"`),
      ),
    );
    await assert.rejects(serializer.deserialize(writeDeterministicZip(files)), message);
  }
  const unresolved = readSafeZip(saved.bytes);
  unresolved.delete(ORCAXR_EXTENSION_PATH);
  unresolved.set(
    CORE_MODEL_PATH,
    new TextEncoder().encode(text(unresolved.get(CORE_MODEL_PATH)!).replace('paint_color="481"', 'paint_color="1C"')),
  );
  await assert.rejects(serializer.deserialize(writeDeterministicZip(unresolved)), /unavailable material slot 4/);
});

await test('bounds facet trees across unique meshes and repeated component materialization', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize(archiveFixture());
  const baseFiles = readSafeZip(saved.bytes);
  baseFiles.delete(ORCAXR_EXTENSION_PATH);
  const baseCore = text(baseFiles.get(CORE_MODEL_PATH)!).replace(/paint_color="[^"]+"/, 'paint_color="481"');
  const meshObject = / {2}<object id="1"[\s\S]*? {2}<\/object>/.exec(baseCore)?.[0];
  const component = / {4}<component\b[^>]*objectid="1"[^>]*\/>/.exec(baseCore)?.[0];
  assert.ok(meshObject && component, 'fixture must contain one mesh object and one component edge');

  const duplicateMesh = meshObject.replace('id="1"', 'id="3"');
  const uniqueMeshCore = baseCore
    .replace('  <object id="2"', `${duplicateMesh}\n  <object id="2"`)
    .replace(component, `${component}\n${component.replace('objectid="1"', 'objectid="3"')}`);
  const uniqueMeshFiles = new Map(baseFiles);
  uniqueMeshFiles.set(CORE_MODEL_PATH, new TextEncoder().encode(uniqueMeshCore));
  const boundedDecode = new Bbs3mfProjectSerializer({ maxImportedFacetRefinementNodes: 5 });
  await assert.rejects(boundedDecode.deserialize(writeDeterministicZip(uniqueMeshFiles)), /node limit/);

  const repeatedCore = baseCore.replace(component, `${component}\n${component}`);
  const repeatedFiles = new Map(baseFiles);
  repeatedFiles.set(CORE_MODEL_PATH, new TextEncoder().encode(repeatedCore));
  const boundedMaterialization = new Bbs3mfProjectSerializer({
    maxImportedFacetAnnotationMaterializationUnits: 5,
  });
  await assert.rejects(
    boundedMaterialization.deserialize(writeDeterministicZip(repeatedFiles)),
    /Expanded 3MF component facet annotations exceed the materialization limit of 5/,
  );

  const plainLeafCore = text(baseFiles.get(CORE_MODEL_PATH)!)
    .replace(/paint_color="[^"]+"/, 'paint_color="4"')
    .replace(component, `${component}\n${component}`);
  const plainLeafFiles = new Map(baseFiles);
  plainLeafFiles.set(CORE_MODEL_PATH, new TextEncoder().encode(plainLeafCore));
  await assert.rejects(
    new Bbs3mfProjectSerializer({ maxImportedFacetAnnotationMaterializationUnits: 3 }).deserialize(
      writeDeterministicZip(plainLeafFiles),
    ),
    /Expanded 3MF component facet annotations exceed the materialization limit of 3/,
  );

  const mixedCore = repeatedCore.replace('paint_color="481"', 'paint_color="481" paint_supports="4"');
  const mixedFiles = new Map(baseFiles);
  mixedFiles.set(CORE_MODEL_PATH, new TextEncoder().encode(mixedCore));
  await assert.rejects(
    new Bbs3mfProjectSerializer({ maxImportedFacetAnnotationMaterializationUnits: 9 }).deserialize(
      writeDeterministicZip(mixedFiles),
    ),
    /Expanded 3MF component facet annotations exceed the materialization limit of 9/,
  );
});

await test('imports the pinned legacy paint_fuzzy attribute and enforces the 64-slot color consumer cap', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fuzzySnapshot = archiveFixture();
  fuzzySnapshot.state.plates[0].objects[0].volumes[0].annotations.fuzzySkin = [{ triangles: [0], value: true }];
  fuzzySnapshot.sourceHash = projectFingerprint(fuzzySnapshot.state);
  const fuzzySaved = await serializer.serialize(fuzzySnapshot);
  const fuzzyFiles = readSafeZip(fuzzySaved.bytes);
  fuzzyFiles.delete(ORCAXR_EXTENSION_PATH);
  fuzzyFiles.set(
    CORE_MODEL_PATH,
    new TextEncoder().encode(
      text(fuzzyFiles.get(CORE_MODEL_PATH)!).replace('paint_fuzzy_skin="4"', 'paint_fuzzy_skin="" paint_fuzzy="4"'),
    ),
  );
  const fuzzyReopened = await serializer.deserialize(writeDeterministicZip(fuzzyFiles));
  assert.deepEqual(fuzzyReopened.state.plates[0].objects[0].volumes[0].annotations.fuzzySkin, [
    { triangles: [0], value: true },
  ]);

  const unavailableSplit = archiveFixture();
  unavailableSplit.state.filaments.mixed[0].enabled = false;
  const unavailableVolume = unavailableSplit.state.plates[0].objects[0].volumes[0];
  unavailableVolume.annotations.color = [];
  unavailableVolume.annotations.refinement = {
    color: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: unavailableSplit.state.filaments.mixed[0].id } },
            { kind: 'leaf', state: { kind: 'assigned', value: unavailableSplit.state.filaments.physical[0].id } },
          ],
        },
      ],
    },
  };
  unavailableSplit.sourceHash = projectFingerprint(unavailableSplit.state);
  const unavailableSaved = await serializer.serialize(unavailableSplit);
  assert.doesNotMatch(text(readSafeZip(unavailableSaved.bytes).get(CORE_MODEL_PATH)!), /paint_color=/);
  assert.match((unavailableSaved.warnings ?? []).join('\n'), /cannot be assigned a BBS material slot/);
  assert.match((unavailableSaved.warnings ?? []).join('\n'), /entire standard BBS paint_color root was omitted/);

  const boundary = archiveFixture();
  boundary.state.filaments.mixed = [];
  const template = boundary.state.filaments.physical[0];
  while (boundary.state.filaments.physical.length < 65) {
    const toolId = boundary.state.filaments.physical.length;
    boundary.state.filaments.physical.push({
      ...template,
      id: entityId<'physical-filament'>(`import:test:paint-boundary-${toolId + 1}`),
      name: `Boundary ${toolId + 1}`,
      toolId,
    });
  }
  boundary.state.printer.toolCount = 65;
  const boundaryVolume = boundary.state.plates[0].objects[0].volumes[0];
  boundaryVolume.annotations.color = [{ triangles: [0], value: boundary.state.filaments.physical[63].id }];
  boundary.sourceHash = projectFingerprint(boundary.state);
  const state64 = await serializer.serialize(boundary);
  const encoded64 = encodeBbsFacetRoot({ kind: 'leaf', state: { kind: 'assigned', value: 64 } }, (value) => value);
  assert.match(text(readSafeZip(state64.bytes).get(CORE_MODEL_PATH)!), new RegExp(`paint_color="${encoded64}"`));

  boundaryVolume.annotations.color = [{ triangles: [0], value: boundary.state.filaments.physical[64].id }];
  boundary.sourceHash = projectFingerprint(boundary.state);
  const state65 = await serializer.serialize(boundary);
  assert.doesNotMatch(text(readSafeZip(state65.bytes).get(CORE_MODEL_PATH)!), /paint_color=/);
  assert.match((state65.warnings ?? []).join('\n'), /supports 64 material states/);

  const invalid65 = readSafeZip(state64.bytes);
  invalid65.delete(ORCAXR_EXTENSION_PATH);
  const encoded65 = encodeBbsFacetRoot({ kind: 'leaf', state: { kind: 'assigned', value: 65 } }, (value) => value);
  invalid65.set(
    CORE_MODEL_PATH,
    new TextEncoder().encode(
      text(invalid65.get(CORE_MODEL_PATH)!).replace(`paint_color="${encoded64}"`, `paint_color="${encoded65}"`),
    ),
  );
  await assert.rejects(
    serializer.deserialize(writeDeterministicZip(invalid65)),
    /state 65 is invalid for this channel/,
  );
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
  // Genuinely unsupported entries are preserved byte for byte.
  assert.deepEqual(output.get('Extensions/opaque.txt'), originalFiles.get('Extensions/opaque.txt'));
  // Metadata the importer consumed is regenerated from canonical state instead.
  // Writing the original bytes back would make the canonical model decorative:
  // every edit would be discarded on save, and model_settings.config would
  // reinstate object ids the regenerated core no longer has, which makes the
  // pinned engine reject the whole archive.
  assert.equal(
    imported.state.extensionBlobs.some(
      (entry) => entry.path === 'Metadata/model_settings.config' || entry.path === 'Metadata/project_settings.config',
    ),
    false,
    'consumed metadata must not also be preserved as an opaque blob',
  );
  const savedModelSettings = text(output.get('Metadata/model_settings.config')!);
  const savedCore = text(output.get(CORE_MODEL_PATH)!);
  for (const objectId of [...savedModelSettings.matchAll(/<object id="(\d+)"/g)].map((match) => match[1])) {
    assert.match(
      savedCore,
      new RegExp(`<object id="${objectId}"`),
      `model_settings.config object ${objectId} must exist in the regenerated core model`,
    );
  }
  const savedProjectSettings = JSON.parse(text(output.get('Metadata/project_settings.config')!)) as Record<
    string,
    unknown
  >;
  assert.equal(savedProjectSettings.from, 'project', 'project settings are regenerated, not copied');
  assert.deepEqual(
    savedProjectSettings.filament_colour,
    imported.state.filaments.physical.map((filament) => filament.color.slice(0, 7)),
    'regenerated project settings carry the canonical filaments',
  );
  const rootRelationships = text(output.get('_rels/.rels')!);
  const modelRelationships = text(output.get('3D/_rels/3dmodel.model.rels')!);
  const projectedCore = text(output.get(CORE_MODEL_PATH)!);
  assert.match(rootRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/project-config"/);
  assert.match(modelRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/custom-gcode"/);
  assert.match(modelRelationships, /Type="http:\/\/schemas\.orcaxr\.test\/relationships\/extension"/);
  assert.match(projectedCore, /:face-tag="preserve-me"/);
  assert.match(projectedCore, /paint_color="8"/);
  assert.match(projectedCore, /:stable-id="object-assembly"/);
  assert.match(projectedCore, /:instance-id="instance-a"/);

  const canonical = await serializer.deserialize(saved.bytes);
  assert.equal(canonicalStringify(canonical.state), canonicalStringify(imported.state));

  // A projection that omits preserved members (the one-plate slice archive
  // drops every opaque entry) must not emit a relationship to a missing part:
  // the pinned engine refuses to load the whole package when one dangles.
  const projected = structuredClone(imported.state) as typeof imported.state;
  projected.extensionBlobs = [];
  const withoutBlobs = await serializer.serialize({
    state: projected,
    assets: imported.assets,
    sourceRevision: 1,
    sourceHash: projectFingerprint(projected),
  });
  const pruned = readSafeZip(withoutBlobs.bytes);
  const prunedRoot = text(pruned.get('_rels/.rels')!);
  const prunedModel = text(pruned.get('3D/_rels/3dmodel.model.rels')!);
  const resolveTarget = (source: string, target: string) => {
    const segments = target.startsWith('/')
      ? target.slice(1).split('/')
      : [...(source === '/' ? [] : source.split('/').slice(0, -1)), ...target.split('/')];
    const resolved: string[] = [];
    for (const segment of segments) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') resolved.pop();
      else resolved.push(segment);
    }
    return resolved.join('/');
  };
  for (const [document, source] of [
    [prunedRoot, '/'],
    [prunedModel, CORE_MODEL_PATH],
  ] as const) {
    for (const target of [...document.matchAll(/Target="([^"]+)"/g)].map((match) => match[1])) {
      const path = resolveTarget(source, target);
      assert.ok(pruned.has(path), `relationship target ${target} is missing from the package`);
    }
  }
  assert.match((withoutBlobs.warnings ?? []).join('\n'), /Dropped \d+ preserved package relationship/);
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

await test('projects layer events into the engine format and reads them back', async () => {
  const fixture = createProjectFixture();
  const plateId = fixture.state.plates[0].id;
  fixture.state.customGcode = [
    layerEventEntry({
      id: entityId<'custom-gcode'>('import:test:fixture-pause'),
      plateId,
      type: 'pause',
      topZMm: 4.2,
      message: 'Insert the magnet',
    }),
    layerEventEntry({
      id: entityId<'custom-gcode'>('import:test:fixture-custom'),
      plateId,
      type: 'custom',
      topZMm: 1.6,
      code: 'M117 half way',
    }),
    layerEventEntry({
      id: entityId<'custom-gcode'>('import:test:fixture-colour'),
      plateId,
      type: 'color-change',
      topZMm: 8,
      toolIndex: 2,
      color: '#00FF00',
    }),
  ];
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 11,
    sourceHash: projectFingerprint(fixture.state),
  });
  const files = readSafeZip(saved.bytes);
  const xml = new TextDecoder().decode(files.get('Metadata/custom_gcode_per_layer.xml'));

  // Exactly the attributes the pinned importer reads, in print order, with the
  // engine's own numeric type codes.
  const layers = [...xml.matchAll(/<layer\b([^>]*)\/>/g)].map((match) => match[1]);
  assert.equal(layers.length, 3);
  assert.match(layers[0], /top_z="1\.6"[\s\S]*type="4"[\s\S]*extra="M117 half way"[\s\S]*gcode="M117 half way"/);
  assert.match(layers[1], /top_z="4\.2"[\s\S]*type="1"[\s\S]*extra="Insert the magnet"[\s\S]*gcode="M601"/);
  assert.match(layers[2], /top_z="8"[\s\S]*type="0"[\s\S]*extruder="2"[\s\S]*color="#00FF00"[\s\S]*gcode="M600"/);
  assert.match(xml, /<plate_info id="1"\/>/);
  assert.match(xml, /<mode value="MultiExtruder"\/>/);

  // Canonical reopen keeps the authored events verbatim.
  const reopened = await serializer.deserialize(saved.bytes);
  assert.deepEqual(
    reopened.state.customGcode.map((entry) => entry.layerEvent),
    fixture.state.customGcode.map((entry) => entry.layerEvent),
  );

  // A foreign project — the same package without the OrcaXR envelope — has to
  // recover the same events from the engine file alone.
  files.delete(ORCAXR_EXTENSION_PATH);
  const foreign = await serializer.deserialize(writeDeterministicZip(files));
  assert.deepEqual(
    foreign.state.customGcode
      .map((entry) => entry.layerEvent)
      .sort((left, right) => (left?.topZMm ?? 0) - (right?.topZMm ?? 0)),
    [
      { type: 'custom', topZMm: 1.6, toolIndex: 1 },
      { type: 'pause', topZMm: 4.2, toolIndex: 1, message: 'Insert the magnet' },
      { type: 'color-change', topZMm: 8, toolIndex: 2, color: '#00FF00' },
    ],
  );
  assert.equal(foreign.state.customGcode.find((entry) => entry.layerEvent?.type === 'custom')?.code, 'M117 half way');
});

await test('an embossed volume reopens with its text still editable', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const volume = fixture.state.plates[0].objects[0].volumes[0];
  volume.embossText = {
    text: 'Drew\nwas here',
    styleName: 'DejaVu Sans',
    fontDescriptor: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    fontDescriptorType: 'file_name',
    font: {
      charGapMm: 0.4,
      lineGapMm: 1.5,
      lineHeightMm: 14,
      boldnessMm: 0.1,
      skew: 0.2,
      perGlyph: true,
      horizontal: 'right',
      vertical: 'bottom',
      collection: 1,
    },
    projection: { depthMm: 2.5, useSurface: true },
    family: 'DejaVu Sans',
    faceName: 'DejaVu Sans Book',
    style: 'Book',
    weight: '400',
  };

  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 11,
    sourceHash: projectFingerprint(fixture.state),
  });

  // The recipe lands on the part, where the pinned reader looks for it.
  const settings = new TextDecoder().decode(readSafeZip(archive.bytes).get('Metadata/model_settings.config')!);
  assert.match(settings, /<slic3rpe:text /);
  assert.match(settings, /<slic3rpe:shape /);
  assert.match(settings, /vertical="bottom"/);
  assert.match(settings, /depth="2.5"/);

  const reopened = await serializer.deserialize(archive.bytes);
  assert.deepEqual(
    reopened.state.plates[0].objects[0].volumes[0].embossText,
    volume.embossText,
    'every field of the recipe survives the round trip',
  );
});

await test('a BBS project written elsewhere brings its emboss text across', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 3,
    sourceHash: projectFingerprint(fixture.state),
  });

  // Rebuild the package as a foreign BBS one: drop the canonical envelope and
  // inject the emboss elements the way another slicer would have written them.
  const files = readSafeZip(archive.bytes);
  const settings = new TextDecoder()
    .decode(files.get('Metadata/model_settings.config')!)
    .replace(
      /<mesh_stat/,
      '<slic3rpe:text text="Hi" style_name="S" font_descriptor="f.ttf" font_descriptor_type="file_name" line_height="8" horizontal="left" vertical="middle"/>\n   <slic3rpe:shape depth="1.75"/>\n   <mesh_stat',
    );
  const rebuilt: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    if (path === ORCAXR_EXTENSION_PATH) continue;
    rebuilt[path] = path === 'Metadata/model_settings.config' ? new TextEncoder().encode(settings) : bytes;
  }

  const imported = await serializer.deserialize(zipSync(rebuilt));
  const embossed = imported.state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .find((candidate) => candidate.embossText !== undefined);
  assert.ok(embossed, 'the imported project must carry the emboss recipe');
  assert.equal(embossed.embossText?.text, 'Hi');
  assert.equal(embossed.embossText?.font.lineHeightMm, 8);
  // "middle" is how upstream spells a vertically centred block.
  assert.equal(embossed.embossText?.font.vertical, 'center');
  assert.equal(embossed.embossText?.projection.depthMm, 1.75);
});

await test('an SVG part carries its drawing into the archive and back', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const drawing =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
    '<rect width="40" height="20"/></svg>';
  const drawingBytes = new TextEncoder().encode(drawing);
  const drawingAsset = {
    descriptor: {
      id: entityId<'asset'>('import:test:svg-drawing'),
      kind: 'extension' as const,
      digest: contentDigest(drawingBytes),
      byteLength: drawingBytes.byteLength,
      mediaType: 'image/svg+xml',
    },
    bytes: drawingBytes,
  };
  fixture.state.sourceAssets.push(drawingAsset.descriptor);
  const volume = fixture.state.plates[0].objects[0].volumes[0];
  volume.embossSvg = {
    pathIn3mf: 'Metadata/svg/part-1/logo.svg',
    drawingAssetId: drawingAsset.descriptor.id,
    depthMm: 2,
    useSurface: false,
    widthMm: 40,
  };

  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset, drawingAsset],
    sourceRevision: 9,
    sourceHash: projectFingerprint(fixture.state),
  });

  // The reference must name a file the package actually contains.
  const files = readSafeZip(archive.bytes);
  const stored = files.get('Metadata/svg/part-1/logo.svg');
  assert.ok(stored, 'the drawing itself is written into the archive');
  assert.equal(new TextDecoder().decode(stored), drawing);

  const reopened = await serializer.deserialize(archive.bytes);
  const restored = reopened.state.plates[0].objects[0].volumes[0].embossSvg;
  assert.equal(restored?.pathIn3mf, 'Metadata/svg/part-1/logo.svg');
  assert.equal(restored?.depthMm, 2);
  // The drawing comes back as a canonical asset, so the part can be re-cut.
  const recovered = reopened.assets.find((asset) => asset.descriptor.id === restored?.drawingAssetId);
  assert.ok(recovered, 'the drawing is recovered as an asset');
  assert.equal(new TextDecoder().decode(recovered.bytes), drawing);
});

await test('an SVG part reopens with its drawing and parameters', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const volume = fixture.state.plates[0].objects[0].volumes[0];
  volume.embossSvg = {
    pathIn3mf: 'Metadata/svg/part-1/logo.svg',
    drawingAssetId: fixture.asset.descriptor.id,
    sourcePath: '/home/ignacio/Downloads/logo.svg',
    depthMm: 1.75,
    useSurface: true,
    widthMm: 42.5,
  };

  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 5,
    sourceHash: projectFingerprint(fixture.state),
  });

  const settings = new TextDecoder().decode(readSafeZip(archive.bytes).get('Metadata/model_settings.config')!);
  // The pinned writer names these exactly; a different spelling is a file the
  // desktop slicer silently ignores.
  assert.match(settings, /filepath3mf="Metadata\/svg\/part-1\/logo.svg"/);
  assert.match(settings, /filepath="\/home\/ignacio\/Downloads\/logo.svg"/);
  assert.match(settings, /depth="1.75"/);
  assert.match(settings, /use_surface="1"/);
  // An SVG part carries no text element.
  assert.equal(settings.includes('<slic3rpe:text'), false);

  const reopened = await serializer.deserialize(archive.bytes);
  const restored = reopened.state.plates[0].objects[0].volumes[0].embossSvg;
  assert.equal(restored?.pathIn3mf, 'Metadata/svg/part-1/logo.svg');
  assert.equal(restored?.sourcePath, '/home/ignacio/Downloads/logo.svg');
  assert.equal(restored?.depthMm, 1.75);
  assert.equal(restored?.useSurface, true);
});

await test('a BBS shape with no SVG reference is not mistaken for an SVG part', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 2,
    sourceHash: projectFingerprint(fixture.state),
  });
  const files = readSafeZip(archive.bytes);
  const settings = new TextDecoder()
    .decode(files.get('Metadata/model_settings.config')!)
    .replace(/<mesh_stat/, '<slic3rpe:shape depth="2"/>\n   <mesh_stat');
  const rebuilt: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    if (path === ORCAXR_EXTENSION_PATH) continue;
    rebuilt[path] = path === 'Metadata/model_settings.config' ? new TextEncoder().encode(settings) : bytes;
  }
  const imported = await serializer.deserialize(zipSync(rebuilt));
  const volumes = imported.state.plates.flatMap((plate) => plate.objects).flatMap((object) => object.volumes);
  assert.equal(
    volumes.some((candidate) => candidate.embossSvg !== undefined),
    false,
    'a shape without filepath3mf describes no drawing',
  );
});

await test('a variable layer-height profile round-trips through the archive', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const object = fixture.state.plates[0].objects[0];
  // A real edited profile: fixed first layer, a thinner band, then the top.
  object.layerHeightProfile = [0, 0.2, 0.2, 0.2, 8, 0.12, 12, 0.12, 20, 0.2];

  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 13,
    sourceHash: projectFingerprint(fixture.state),
  });

  const written = readSafeZip(archive.bytes).get('Metadata/layer_heights_profile.txt');
  assert.ok(written, 'the pinned profile file is written');
  const text = new TextDecoder().decode(written);
  // Object ids are 1-based and every number is %f, which is what desktop Orca
  // parses; anything else it silently ignores.
  assert.match(text, /^object_id=1\|0\.000000;0\.200000;/);

  const reopened = await serializer.deserialize(archive.bytes);
  assert.deepEqual(
    reopened.state.plates[0].objects[0].layerHeightProfile,
    object.layerHeightProfile,
    'the profile survives to the six decimals the format stores',
  );
});

await test('an object with no profile writes no profile file at all', async () => {
  const serializer = new Bbs3mfProjectSerializer();
  const fixture = createProjectFixture();
  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 14,
    sourceHash: projectFingerprint(fixture.state),
  });
  // Writing a flat profile for every object would grow every archive for no
  // information, and upstream does not do it either.
  assert.equal(readSafeZip(archive.bytes).has('Metadata/layer_heights_profile.txt'), false);
  const reopened = await serializer.deserialize(archive.bytes);
  assert.equal(reopened.state.plates[0].objects[0].layerHeightProfile, undefined);
});

console.log(`\nBBS-compatible 3MF serializer: ${passed} tests passed.`);
