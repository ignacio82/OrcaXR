// Reference traces execute the existing TypeScript repository, never Rust output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  InMemoryAssetRepository,
  assetBundleFingerprint,
  contentDigest,
} from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
const root = new URL("../../", import.meta.url);
const units = (text) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const encode = (asset) => ({
  descriptorJson: canonicalStringify(asset.descriptor),
  bytes: Array.from(asset.bytes),
});
const assets = [];
function asset(id, bytes, extra = {}) {
  const data = Uint8Array.from(bytes);
  const descriptor = {
    id,
    kind: "extension",
    digest: contentDigest(data),
    byteLength: data.length,
    mediaType: "application/octet-stream",
    ...extra,
  };
  assets.push({ descriptor, bytes: data });
  return assets.length - 1;
}
const z = asset("import:test:z", [0, 1, 127, 128, 254, 255], {
  sourceFilename: "asset\u0000\ud800\udfff",
});
const a = asset("import:test:a", [0, 1, 127, 128, 254, 255]);
const empty = asset("import:test:empty", []);
const opaque = asset("import:test:opaque", [42], {
  digest: "sha256:opaque\ud800\u0000",
});
const uppercase = asset("import:test:uppercase", [99], {
  digest: "FNV1A64:UNVERIFIED",
});
const astral = asset("import:test:\ud800\udc00", [19]);
const bmp = asset("import:test:\ue000", [18]);
const nul = asset("import:test:\u0000\ud800", [17], {
  provenance: {
    source: "recovered",
    uri: "urn:\udfff\u0000",
    importedAt: "unknown",
  },
  mesh: {
    positions: {
      byteOffset: 0,
      byteLength: 0,
      componentType: "float32",
      componentCount: 3,
      count: 0,
      byteStride: 12,
    },
    triangleCount: 0,
  },
  metadata: JSON.parse(
    '{"10":10,"2":2,"0":0,"__proto__":{"__proto__":null},"constructor":"data","astral":"\\ud800\\udc00","surrogate":"\\ud800","negativeZero":-0,"small":5e-324,"large":1.7976931348623157e308}',
  ),
});
const mismatchBytes = asset("import:test:z", [255, 1, 127, 128, 254, 255], {
  digest: assets[z].descriptor.digest,
});
const conflictMetadata = asset("import:test:z", assets[z].bytes, {
  sourceFilename: "different",
});
const wrongLength = asset("import:test:bad-length", [1], { byteLength: 2 });
const shortDigest = asset("import:test:bad-digest", [2], {
  digest: "fnv1a64:",
});
const conflictOpaque = asset("import:test:opaque", [43], {
  digest: assets[opaque].descriptor.digest,
});
const steps = [];
const repository = new InMemoryAssetRepository();
const snapshots = new Map();
const payloads = new Map();
const records = new Map();
const versions = new Map();
function identity(map, value) {
  if (!map.has(value)) map.set(value, map.size + 1);
  return map.get(value);
}
function state() {
  const entries = repository.list();
  const fingerprint = repository.bundleFingerprint();
  assert.equal(fingerprint, assetBundleFingerprint(entries));
  return {
    version: identity(versions, repository.captureInternal()),
    fingerprint,
    entries: entries.map((entry) => ({
      ...encode(entry),
      record: identity(records, repository.peek(entry.descriptor.id)),
    })),
  };
}
function classify(error) {
  const text = String(error.message);
  if (/duplicate ID/.test(text)) return "duplicateId";
  if (/byte length|declares .* bytes/.test(text)) return "byteLengthMismatch";
  if (/digest/.test(text)) return "digestMismatch";
  if (/cannot be replaced/.test(text)) return "immutableConflict";
  if (/foreign/.test(text)) return "foreignSnapshot";
  throw error;
}
function run(operation) {
  let result = null,
    error = null;
  try {
    switch (operation.kind) {
      case "put": {
        const value = assets[operation.asset];
        repository.put(value.descriptor, value.bytes);
        break;
      }
      case "remove":
        repository.remove(operation.id);
        break;
      case "snapshot":
        snapshots.set(operation.name, repository.captureInternal());
        break;
      case "restoreInternal":
        repository.restoreInternal(snapshots.get(operation.name));
        break;
      case "foreign":
        repository.restoreInternal(
          new InMemoryAssetRepository().captureInternal(),
        );
        break;
      case "capture":
        payloads.set(operation.name, repository.capture());
        break;
      case "restoreCapture":
        repository.restore(payloads.get(operation.name));
        break;
      case "restore":
        repository.restore({
          entries: operation.assets.map((index) => assets[index]),
        });
        break;
      case "get":
        result = repository.get(operation.id);
        result = result ? encode(result) : null;
        break;
      case "find":
        result = repository.findByDigest(operation.digest);
        result = result ? encode(result) : null;
        break;
      case "has":
        result = repository.has(operation.id);
        break;
      case "mutateCopies": {
        for (const value of [
          repository.get(operation.id),
          repository.findByDigest(operation.digest),
          ...repository.list(),
          ...repository.capture().entries,
        ]) {
          if (value) {
            value.bytes.fill(200);
            value.descriptor.sourceFilename = "caller mutation";
          }
        }
        break;
      }
      default:
        throw new Error("Unknown trace operation");
    }
  } catch (caught) {
    error = classify(caught);
  }
  const wire = { ...operation };
  if ("id" in wire) {
    wire.idUtf16 = units(wire.id);
    delete wire.id;
  }
  if ("digest" in wire) {
    wire.digestUtf16 = units(wire.digest);
    delete wire.digest;
  }
  steps.push({ operation: wire, result, error, state: state() });
}
run({ kind: "snapshot", name: "empty" });
for (const index of [z, a, empty, opaque, uppercase, astral, bmp, nul])
  run({ kind: "put", asset: index });
run({ kind: "find", digest: assets[z].descriptor.digest });
run({
  kind: "mutateCopies",
  id: assets[z].descriptor.id,
  digest: assets[z].descriptor.digest,
});
run({ kind: "snapshot", name: "full" });
run({ kind: "put", asset: z });
run({ kind: "remove", id: "import:test:absent" });
for (const index of [
  mismatchBytes,
  conflictMetadata,
  wrongLength,
  shortDigest,
  conflictOpaque,
])
  run({ kind: "put", asset: index });
run({ kind: "foreign" });
run({ kind: "capture", name: "sorted" });
run({ kind: "remove", id: assets[z].descriptor.id });
run({ kind: "find", digest: assets[z].descriptor.digest });
run({ kind: "put", asset: z });
run({ kind: "find", digest: assets[z].descriptor.digest });
run({ kind: "snapshot", name: "branch" });
run({ kind: "restoreInternal", name: "empty" });
run({ kind: "get", id: assets[z].descriptor.id });
run({ kind: "has", id: assets[z].descriptor.id });
run({ kind: "restoreInternal", name: "full" });
run({ kind: "has", id: assets[z].descriptor.id });
for (const list of [
  [a, wrongLength],
  [z, z],
  [z, mismatchBytes],
  [a, mismatchBytes],
  [a, shortDigest],
])
  run({ kind: "restore", assets: list });
run({ kind: "restoreCapture", name: "sorted" });
run({ kind: "find", digest: assets[z].descriptor.digest });
run({ kind: "restoreInternal", name: "branch" });
run({ kind: "find", digest: assets[z].descriptor.digest });
run({ kind: "restore", assets: [] });
run({ kind: "restore", assets: [] });
// Deterministic mixed operations: independent expectation includes every version,
// entry, record identity, error and actual-byte fingerprint after every step.
let random = 0x12345678;
for (let index = 0; index < 180; index++) {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  const value = (random >>> 0) % 8;
  switch (index % 6) {
    case 0:
      run({ kind: "put", asset: value });
      break;
    case 1:
      run({ kind: "snapshot", name: "random" });
      break;
    case 2:
      run({ kind: "remove", id: assets[value].descriptor.id });
      break;
    case 3:
      run({ kind: "restoreInternal", name: "random" });
      break;
    case 4:
      run({ kind: "find", digest: assets[value].descriptor.digest });
      break;
    case 5:
      run({ kind: "restore", assets: [value, (value + 1) % 8] });
      break;
  }
}
const references = [
  "web/src/project/assets.ts",
  "web/src/project/domain/canonical.ts",
];
const data = {
  schemaVersion: 1,
  provenance:
    "Synthetic asset traces from TypeScript; no user data. JSON strings preserve UTF-16 escapes.",
  references: Object.fromEntries(
    references.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(new URL(path, root)))
        .digest("hex"),
    ]),
  ),
  assets: assets.map(encode),
  steps,
};
const path = new URL(
  "testdata/cross-platform/asset-repository-vectors.json",
  root,
);
const output = JSON.stringify(data, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Asset repository reference traces drifted",
  );
console.log(
  `Asset repository: ${assets.length} payloads, ${steps.length} reference operations.`,
);
