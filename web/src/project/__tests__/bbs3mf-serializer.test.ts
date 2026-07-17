import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import {
  Bbs3mfProjectSerializer,
  ORCAXR_EXTENSION_PATH,
  UnsafeThreeMfArchiveError,
  canonicalStringify,
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
