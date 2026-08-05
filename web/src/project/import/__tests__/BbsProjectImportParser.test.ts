import assert from 'node:assert/strict';

import { assetBundleFingerprint } from '../../assets';
import { projectFingerprint } from '../../domain/canonical';
import { Bbs3mfProjectSerializer } from '../../serialization/Bbs3mfProjectSerializer';
import { createProjectFixture } from '../../__tests__/fixtures';
import { BbsProjectImportParser } from '../BbsProjectImportParser';
import { ImportCancellationController } from '../types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function request(
  bytes: Uint8Array,
  options: { mode?: 'merge' | 'replace'; cancellation?: ImportCancellationController['token'] } = {},
) {
  const fixture = createProjectFixture();
  return {
    bytes,
    source: { filename: 'fixture.3mf', importedAt: '2026-07-20T12:00:00.000Z' },
    mode: options.mode ?? ('replace' as const),
    base: {
      state: fixture.state,
      assets: [fixture.asset],
      sourceRevision: 0,
      sourceHash: projectFingerprint(fixture.state),
    },
    cancellation: options.cancellation,
  };
}

await test('parses a canonical BBS archive as an isolated replace proposal', async () => {
  const fixture = createProjectFixture();
  const serializer = new Bbs3mfProjectSerializer();
  const archive = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 7,
    sourceHash: projectFingerprint(fixture.state),
  });
  const original = archive.bytes.slice();

  const parsed = await new BbsProjectImportParser().parse(request(archive.bytes));
  assert.equal(projectFingerprint(parsed.state), projectFingerprint(fixture.state));
  assert.equal(assetBundleFingerprint(parsed.assets), assetBundleFingerprint([fixture.asset]));
  assert.deepEqual(parsed.importedAssetIds, [fixture.asset.descriptor.id]);
  assert.deepEqual(archive.bytes, original);
  assert.deepEqual(parsed.diagnostics, []);
});

await test('fails closed for merge mode, non-3MF bytes, and pre-cancelled work', async () => {
  const parser = new BbsProjectImportParser();
  await assert.rejects(
    parser.parse(request(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { mode: 'merge' })),
    /replace mode/,
  );
  await assert.rejects(parser.parse(request(new Uint8Array([1, 2, 3, 4]))), /ZIP-signature 3MF/);

  const cancellation = new ImportCancellationController();
  cancellation.cancel('test stop');
  await assert.rejects(
    parser.parse(request(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { cancellation: cancellation.token })),
    /test stop/,
  );
});

console.log(`\nBBS project import parser: ${passed} tests passed.`);
