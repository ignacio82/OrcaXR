import assert from 'node:assert/strict';
import { createProjectFixture } from './fixtures';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { BbsProjectImportParser } from '../import/BbsProjectImportParser';
import { assetBundleFingerprint } from '../assets';
import { projectFingerprint } from '../domain/canonical';
import { sha256Bytes } from '../../slicer/Utf8Sha256';

const fixture = createProjectFixture();
const guard = {
  projectId: fixture.ids.project,
  revision: 7,
  semanticHash: projectFingerprint(fixture.state),
  assetFingerprint: assetBundleFingerprint([fixture.asset]),
};
const archive = await new Bbs3mfProjectSerializer().serialize({
  state: fixture.state,
  assets: [fixture.asset],
  sourceRevision: guard.revision,
  sourceHash: guard.semanticHash,
});
const parser = new BbsProjectImportParser();
const proof = { guard, archiveDigest: sha256Bytes(archive.bytes) };
await assert.rejects(
  parser.parseArchive(archive.bytes, undefined, { ...proof, archiveDigest: `sha256:${'0'.repeat(64)}` }),
  /integrity/,
);
for (const mismatch of [
  { projectId: 'different-project' as typeof guard.projectId },
  { semanticHash: 'fnv1a64:0000000000000000' },
  { assetFingerprint: 'fnv1a64:0000000000000000' },
]) {
  await assert.rejects(
    parser.parseArchive(archive.bytes, undefined, { ...proof, guard: { ...guard, ...mismatch } }),
    /recovery metadata/i,
  );
}
const parsed = await parser.parseArchive(archive.bytes, undefined, proof);
assert.deepEqual(parsed.state, fixture.state);
assert.deepEqual(parsed.assets, [fixture.asset]);
console.log('Recovery proof rejects archive, project, semantic and asset mismatches before import.');
