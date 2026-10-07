// Native ZIP bytes are read and opened by the production browser implementation.
// Edited native import is qualified separately by test-archive-interchange.mjs.
// For this export-only comparison, the only normalization is
// newly imported opaque-record IDs, whose specified seed is the compressed ZIP
// hash (different DEFLATE encoders necessarily produce different seed bytes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
import {
  canonicalStringify,
  projectFingerprint,
  fnv1a64,
} from "../../web/src/project/domain/canonical.ts";
import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  RenamePlateCommand,
  SelectionStore,
} from "../../web/src/project/index.ts";
const manifest = resolve(process.argv[2]);
const rows = JSON.parse(readFileSync(manifest, "utf8"));
const root = new URL("../../testdata/cross-platform/", import.meta.url);
const references = JSON.parse(
  readFileSync(new URL("package-vectors.json", root), "utf8"),
);
const sources = Object.fromEntries(
  ["bbs-model", "bbs-metadata", "bbs-settings", "package-input"].map((s) => [
    s,
    JSON.parse(readFileSync(new URL(`${s}-vectors.json`, root), "utf8")),
  ]),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files) =>
  [...files]
    .map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
function normalize(result, source, bytes) {
  const state = structuredClone(result.state);
  const prefix = `import:zip:${fnv1a64(bytes)}-`;
  const original = new Set(
    [
      ...source.sourceAssets,
      ...source.extensionBlobs,
      ...source.thumbnails,
    ].map((v) => v.id),
  );
  const ids = new Map();
  for (const row of [
    ...state.sourceAssets,
    ...state.extensionBlobs,
    ...state.thumbnails,
  ]) {
    if (!original.has(row.id)) {
      assert.ok(
        row.id.startsWith(prefix),
        "only archive-seeded new records can be normalized",
      );
      ids.set(row.id, `import:zip:<archive>-${row.id.slice(prefix.length)}`);
    }
  }
  for (const row of [
    ...state.sourceAssets,
    ...state.extensionBlobs,
    ...state.thumbnails,
  ]) {
    row.id = ids.get(row.id) ?? row.id;
    if (row.assetId) row.assetId = ids.get(row.assetId) ?? row.assetId;
  }
  const assets = result.assets.map((p) => ({
    descriptor: {
      ...p.descriptor,
      id: ids.get(p.descriptor.id) ?? p.descriptor.id,
    },
    bytes: p.bytes.length,
    sha256: hash(p.bytes),
  }));
  assets.sort((a, b) =>
    a.descriptor.id < b.descriptor.id
      ? -1
      : a.descriptor.id > b.descriptor.id
        ? 1
        : 0,
  );
  return canonicalStringify({ state, assets, warnings: result.warnings });
}
const serializer = new Bbs3mfProjectSerializer();
async function open(bytes) {
  try {
    return { result: await serializer.deserialize(bytes) };
  } catch (error) {
    return { error: error.message };
  }
}
let opened = 0,
  refused = 0,
  edited = 0,
  resaved = 0;
for (const row of rows) {
  const reference = references.cases[row.reference];
  const input = sources[reference.source].cases[reference.index];
  let state = JSON.parse(input.stateJson);
  const assets = input.assets.map((p) => ({
    descriptor: JSON.parse(p.descriptorJson),
    bytes: new Uint8Array(p.bytes),
  }));
  if (row.edit) {
    const project = new ProjectStore(state),
      repository = new InMemoryAssetRepository();
    for (const a of assets) repository.put(a.descriptor, a.bytes);
    new CommandBus({
      project,
      selection: new SelectionStore(),
      assets: repository,
    }).execute(new RenamePlateCommand(state.plates[0].id, row.edit));
    state = project.getSnapshot().state;
    edited++;
  }
  const browser = await serializer.serialize({
    state,
    assets,
    sourceRevision: 0,
    sourceHash: projectFingerprint(state),
  });
  const native = new Uint8Array(
    readFileSync(resolve(dirname(manifest), row.path)),
  );
  assert.equal(native.length, row.bytes);
  assert.deepEqual(
    inventory(readSafeZip(native)),
    inventory(readSafeZip(browser.bytes)),
    row.path,
  );
  const expected = await open(browser.bytes),
    actual = await open(native);
  assert.equal(actual.error, expected.error, `${row.path} Open outcome`);
  if (actual.error) {
    refused++;
    continue;
  }
  assert.equal(
    normalize(actual.result, state, native),
    normalize(expected.result, state, browser.bytes),
    `${row.path} Open state/assets/warnings`,
  );
  opened++;
  // Repeated browser Save/Open of the actual native result. Compare against the
  // browser's own Save/Open of the same admitted input, including opaque bytes.
  const saved = await serializer.serialize({
    ...actual.result,
    sourceRevision: 1,
    sourceHash: projectFingerprint(actual.result.state),
  });
  const reopened = await open(saved.bytes);
  assert.ok(reopened.result, `${row.path} browser Save/Open`);
  const savedExpected = await serializer.serialize({
    ...expected.result,
    sourceRevision: 1,
    sourceHash: projectFingerprint(expected.result.state),
  });
  const reopenedExpected = await open(savedExpected.bytes);
  assert.ok(reopenedExpected.result, `${row.path} browser reference Save/Open`);
  assert.equal(
    normalize(reopened.result, state, native),
    normalize(reopenedExpected.result, state, browser.bytes),
    `${row.path} repeated Save/Open state/assets/warnings`,
  );
  for (const asset of actual.result.assets) {
    const restored = reopened.result.assets.find(
      (a) => a.descriptor.id === asset.descriptor.id,
    );
    assert.ok(restored, `${row.path} retained asset`);
    assert.equal(
      canonicalStringify(restored.descriptor),
      canonicalStringify(asset.descriptor),
    );
    assert.equal(hash(restored.bytes), hash(asset.bytes));
  }
  assert.equal(
    reopened.result.state.plates[0]?.name,
    actual.result.state.plates[0]?.name,
  );
  resaved++;
}
assert.equal(
  rows.filter((r) => !r.edit).length,
  references.cases.filter((r) => r.members).length,
);
assert.ok(edited > 0 && opened > 0);
console.log(
  JSON.stringify({
    packages: rows.length,
    opened,
    refused,
    nativeCommandEdits: edited,
    browserResaves: resaved,
  }),
);
