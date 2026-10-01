import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  SetInstanceTransformCommand,
  contentDigest,
  identityTransform,
} from '..';
import { createProjectFixture } from './fixtures';

const fixture = createProjectFixture();
const bytes = new Uint8Array(8 * 1024 * 1024);
bytes.set(fixture.asset.bytes);
fixture.asset.bytes = bytes;
fixture.asset.descriptor.byteLength = bytes.byteLength;
fixture.asset.descriptor.digest = contentDigest(bytes);
const assets = new InMemoryAssetRepository();
assets.put(fixture.asset.descriptor, bytes);
const project = new ProjectStore(fixture.state);
const bus = new CommandBus({
  project,
  assets,
  selection: new SelectionStore(),
});
const initial = project.getSnapshot().hash;
const slice = Uint8Array.prototype.slice;
let copied = 0;
Uint8Array.prototype.slice = function (start?: number, end?: number) {
  const result = slice.call(this, start, end);
  copied += result.byteLength;
  return result;
};
const durations: number[] = [];
try {
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    bus.execute(
      new SetInstanceTransformCommand(fixture.ids.instance, {
        ...identityTransform(),
        translationMm: [i + 1, 0, 0],
      }),
      { coalesce: false },
    );
    bus.undo();
    assert.equal(project.getSnapshot().hash, initial);
    durations.push(performance.now() - start);
  }
} finally {
  Uint8Array.prototype.slice = slice;
}
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      assetBytes: bytes.byteLength,
      transformUndoPairs: durations.length,
      copiedBytes: copied,
      medianMs: durations[10],
      p95Ms: durations[18],
      assetFingerprint: assets.bundleFingerprint(),
      semanticHash: initial,
    },
    null,
    2,
  ),
);
assert.equal(copied, 0, 'Transform rollback must not copy mesh payload bytes');
