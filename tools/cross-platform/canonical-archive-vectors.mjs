// Production browser envelope, asset and blob helpers determine expected stage
// acceptance. Full serializer acceptance is recorded separately. Native comparison
// precedes OPC/BBS reconciliation and unknown-member adoption, not a full import.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  projectFingerprint,
} from "../../web/src/project/domain/canonical.ts";
import {
  Bbs3mfProjectSerializer,
  readCanonicalAssets,
  verifyCanonicalBlobs,
} from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import {
  ORCAXR_EXTENSION_PATH as path,
  readCanonicalEnvelope,
} from "../../web/src/project/serialization/CanonicalEnvelope.ts";
import {
  readSafeZip,
  writeDeterministicZip,
} from "../../web/src/project/serialization/deterministicZip.ts";
import { contentDigest } from "../../web/src/project/assets.ts";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = new TextEncoder(),
  serializer = new Bbs3mfProjectSerializer();
const fixture = createProjectFixture();
const packed = await serializer.serialize({
  state: fixture.state,
  assets: [fixture.asset],
  sourceRevision: 0,
  sourceHash: projectFingerprint(fixture.state),
});
const base = readSafeZip(packed.bytes),
  cases = [];
async function add(name, edit = () => {}, raw = null) {
  const files = new Map([...base].map(([k, v]) => [k, v.slice()]));
  const envelope = JSON.parse(new TextDecoder().decode(files.get(path)));
  edit(envelope, files);
  files.set(
    path,
    raw === null
      ? text.encode(JSON.stringify(envelope))
      : typeof raw === "function"
        ? raw(envelope)
        : raw,
  );
  const bytes = writeDeterministicZip(files);
  let expected = null;
  try {
    const opened = readSafeZip(bytes);
    const decoded = readCanonicalEnvelope(opened.get(path));
    const { repository } = readCanonicalAssets(
      decoded.state,
      decoded.assetEntries,
      opened,
      [],
    );
    verifyCanonicalBlobs(decoded.state, repository, opened);
    let fullImportAccepted = true;
    try {
      await serializer.deserialize(bytes);
    } catch {
      fullImportAccepted = false;
    }
    expected = {
      fullImportAccepted,
      stateJson: canonicalStringify(decoded.state),
      migrations: decoded.migrations,
      unsupportedDigests: decoded.state.sourceAssets.flatMap((d, i) =>
        d.digest.startsWith("fnv1a64:") ? [] : [i],
      ),
      mappings: decoded.assetEntries.map((m) => ({
        assetId: Array.from({ length: m.assetId.length }, (_, i) =>
          m.assetId.charCodeAt(i),
        ),
        path: m.path,
      })),
      assets: decoded.state.sourceAssets.map((d) => {
        const m = decoded.assetEntries.find((m) => m.assetId === d.id);
        return {
          descriptorJson: canonicalStringify(d),
          bytesHex: Buffer.from(opened.get(m.path)).toString("hex"),
        };
      }),
      members: [...opened].map(([path, b]) => ({
        path,
        bytes: b.length,
        sha256: sha(b),
      })),
    };
  } catch {
    /* Independent refusal; native diagnostics are separately tested. */
  }
  cases.push({
    name,
    archiveHex: Buffer.from(bytes).toString("hex"),
    expected,
  });
}
const annotations = (e) => e.state.plates[0].objects[0].volumes[0].annotations;
await add("current");
await add("unknown-fields-utf16", (e) => {
  e.extra = { ignored: "value" };
  e.state.future = { text: "😀\ud800\u0000", numbers: [-0, 1e-200] };
  e.state.name = "private 😀\udfff";
});
for (const bom of [true, false])
  await add(
    `bom-${bom}`,
    () => {},
    (e) =>
      Buffer.concat([
        Buffer.from(bom ? [239, 187, 191] : []),
        text.encode(JSON.stringify(e)),
      ]),
  );
await add(
  "double-bom",
  () => {},
  (e) =>
    Buffer.concat([
      Buffer.from([239, 187, 191, 239, 187, 191]),
      text.encode(JSON.stringify(e)),
    ]),
);
await add(
  "invalid-utf8",
  () => {},
  (e) => Buffer.concat([text.encode(JSON.stringify(e)), Buffer.from([255])]),
);
await add(
  "duplicate-envelope-last-wins",
  () => {},
  (e) => text.encode('{"state":null,"version":2,' + JSON.stringify(e).slice(1)),
);
await add(
  "duplicate-state-name-last-wins",
  () => {},
  (e) =>
    text.encode(
      JSON.stringify(e).replace('"state":{', '"state":{"name":"old",'),
    ),
);
for (const [key, value] of [
  ["format", "wrong"],
  ["version", 2],
  ["state", []],
  ["state", null],
  ["assetEntries", null],
  ["assetEntries", [null]],
  ["assetEntries", [{}]],
])
  await add(`invalid-${key}-${JSON.stringify(value)}`, (e) => {
    e[key] = value;
  });
for (const key of ["__proto__", "constructor", "prototype"])
  for (const location of ["envelope", "state", "mapping"])
    await add(`unsafe-${location}-${key}`, (e) => {
      const target =
        location === "envelope"
          ? e
          : location === "state"
            ? e.state
            : e.assetEntries[0];
      Object.defineProperty(target, key, {
        value: { private: "data" },
        enumerable: true,
      });
    });
for (const value of [false, true])
  await add(`fuzzy-${value}`, (e) => {
    annotations(e).fuzzySkin = [{ value, triangles: [0], future: "retained" }];
  });
for (const triangle of [-1, 1, 99, 0.5, "0", null])
  await add(`false-fuzzy-invalid-triangle-${triangle}`, (e) => {
    annotations(e).fuzzySkin = [{ value: false, triangles: [triangle] }];
  });
await add("false-fuzzy-invalid-reference", (e) => {
  annotations(e).fuzzySkin = [{ value: false, triangles: [0] }];
  e.state.plates[0].objects[0].volumes[0].source.assetId =
    "import:test:missing";
});
await add("false-fuzzy-multiple-volumes", (e) => {
  const v = e.state.plates[0].objects[0].volumes[0];
  v.annotations.fuzzySkin = [{ value: false, triangles: [0] }];
  const other = structuredClone(v);
  other.id = "import:test:second-volume";
  other.annotations.fuzzySkin = [{ value: false, triangles: [0] }];
  e.state.plates[0].objects[0].volumes.push(other);
});
const leaf = (value) => ({
  kind: "leaf",
  state: value === null ? { kind: "unpainted" } : { kind: "assigned", value },
});
const split = (a, b) => ({
  kind: "split",
  splitSides: 1,
  specialSide: 0,
  children: [leaf(a), leaf(b)],
});
for (const [channel, a, b] of [
  ["color", fixture.ids.physical0, fixture.ids.physical1],
  ["support", "enforce", "block"],
  ["seam", "prefer", "avoid"],
  ["fuzzySkin", true, false],
  ["brim", true, false],
]) {
  for (const [mode, root] of [
    ["assigned", leaf(a)],
    ["unpainted", leaf(null)],
    ["uniform", split(a, a)],
    ["split", split(a, b)],
    ["empty", { kind: "split", children: [] }],
    ["unknown-leaf", { kind: "leaf", state: { kind: "legacy", value: a } }],
  ]) {
    await add(`dense-${channel}-${mode}`, (e) => {
      annotations(e).refinement = {
        [channel]: { version: 1, roots: [root], ignored: 7 },
      };
    });
  }
}
await add("dense-malformed-collapsed-split", (e) => {
  annotations(e).refinement = {
    color: {
      roots: [
        {
          kind: "unknown",
          splitSides: 999,
          children: [leaf(fixture.ids.physical0)],
        },
      ],
    },
  };
});
await add("dense-authoritative-over-sparse", (e) => {
  annotations(e).color = [{ value: "import:test:missing", triangles: [99] }];
  annotations(e).refinement = {
    color: { roots: [leaf(fixture.ids.physical1)] },
  };
});
await add("dense-empty-roots", (e) => {
  annotations(e).refinement = { color: { roots: [] } };
});
await add("dense-invalid-root", (e) => {
  annotations(e).refinement = { color: { roots: [null] } };
});
await add("dense-invalid-leaf", (e) => {
  annotations(e).refinement = {
    color: { roots: [{ kind: "leaf", state: { kind: "assigned" } }] },
  };
});
await add("mapping-missing", (e) => {
  e.assetEntries = [];
});
await add("mapping-duplicate", (e) => {
  e.assetEntries.push(e.assetEntries[0]);
});
await add("mapping-undeclared", (e) => {
  e.assetEntries[0].assetId = "import:test:missing";
});
for (const p of [
  "../escape",
  "/absolute",
  "x\\y",
  "x//y",
  "C:drive",
  "x\u0000y",
  "x".repeat(513),
  "missing",
  "[Content_Types].xml",
  "_rels/.rels",
  "3D/3dmodel.model",
  "3D/_rels/3dmodel.model.rels",
  path,
  "Metadata/project_settings.config",
  "Metadata/model_settings.config",
  "Metadata/layer_config_ranges.xml",
  "Metadata/custom_gcode_per_layer.xml",
  "Metadata/brim_ear_points.txt",
  "Metadata/layer_heights_profile.txt",
])
  await add(`mapping-path-${cases.length}`, (e) => {
    e.assetEntries[0].path = p;
  });
for (const digest of [
  "fnv1a64:0000000000000000",
  "sha256:unsupported",
  "FNV1A64:unsupported",
  "fnv1a64:",
  "future:\ud800",
])
  await add(`digest-${cases.length}`, (e) => {
    e.state.sourceAssets[0].digest = digest;
  });
await add("asset-wrong-length", (e, f) => {
  f.set(e.assetEntries[0].path, new Uint8Array(37));
});
await add("asset-corrupt-content-valid-crc", (e, f) => {
  f.get(e.assetEntries[0].path)[0] ^= 1;
});
for (const mode of ["equal", "different", "missing", "unsafe", "same-path"])
  await add(`declared-blob-${mode}`, (e, f) => {
    const p =
      mode === "unsafe"
        ? "../unsafe"
        : mode === "same-path"
          ? e.assetEntries[0].path
          : "Metadata/opaque.bin";
    e.state.extensionBlobs.push({
      id: "import:test:blob",
      namespace: "test",
      path: p,
      assetId: e.state.sourceAssets[0].id,
      relationships: [],
    });
    if (mode !== "missing" && mode !== "unsafe") {
      const b = f.get(e.assetEntries[0].path).slice();
      if (mode === "different") b[0] ^= 1;
      f.set(p, b);
    }
  });
await add("unknown-members-retained", (e, f) => {
  for (const p of ["__proto__", "unknown.bin", "Metadata/private.txt"])
    f.set(p, text.encode(p));
});
await add("zero-length-asset", (e, f) => {
  const id = "import:test:empty";
  e.state.sourceAssets.push({
    id,
    kind: "extension",
    digest: contentDigest(new Uint8Array()),
    byteLength: 0,
    mediaType: "application/octet-stream",
    provenance: { source: "import" },
  });
  e.assetEntries.unshift({ assetId: id, path: "empty.bin" });
  f.set("empty.bin", new Uint8Array());
});
await add("multiple-mappings-same-path", (e) => {
  const d = structuredClone(e.state.sourceAssets[0]);
  d.id = "import:test:second";
  e.state.sourceAssets.push(d);
  e.assetEntries.push({ assetId: d.id, path: e.assetEntries[0].path });
});
await add("dense-multichannel-group-order", (e, f) => {
  const descriptor = e.state.sourceAssets[0],
    mapping = e.assetEntries[0];
  const data = Buffer.concat(
    Array.from({ length: 3 }, () => f.get(mapping.path)),
  );
  f.set(mapping.path, data);
  descriptor.byteLength = data.length;
  descriptor.digest = contentDigest(data);
  descriptor.mesh.positions.byteLength = data.length;
  descriptor.mesh.positions.count = 9;
  descriptor.mesh.triangleCount = 3;
  e.state.plates[0].objects[0].volumes[0].source.triangleCount = 3;
  annotations(e).refinement = {
    color: {
      roots: [
        leaf(fixture.ids.physical1),
        leaf(fixture.ids.physical0),
        leaf(fixture.ids.physical1),
      ],
    },
    fuzzySkin: { roots: [leaf(false), leaf(true), leaf(false)] },
    brim: { roots: [leaf(false), split(true, false), leaf(true)] },
  };
});
await add(
  "overwritten-unsafe-value",
  () => {},
  (e) =>
    text.encode(
      '{"ignored":{"constructor":1},"ignored":null,' +
        JSON.stringify(e).slice(1),
    ),
);
await add("mapping-utf16-asset-id", (e) => {
  const id = "import:test:asset-\ud800";
  e.state.sourceAssets[0].id = id;
  e.assetEntries[0].assetId = id;
  e.state.plates[0].objects[0].volumes[0].source.assetId = id;
});
const sources = [
  "tools/cross-platform/canonical-archive-vectors.mjs",
  "web/src/project/__tests__/fixtures.ts",
  "web/src/project/assets.ts",
  ...["domain", "migration", "serialization"].flatMap((dir) =>
    readdirSync(new URL(`web/src/project/${dir}/`, root))
      .filter((p) => p.endsWith(".ts"))
      .map((p) => `web/src/project/${dir}/${p}`),
  ),
].sort();
const result =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: sha(read(path)) })),
      cases,
    },
    null,
    2,
  ) + "\n";
const output = new URL(
  "testdata/cross-platform/canonical-archive-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(output, result);
else
  assert.equal(
    readFileSync(output, "utf8"),
    result,
    "Canonical archive references drift",
  );
console.log(
  `Canonical archive references: ${cases.length} cases; ${cases.filter((c) => c.expected).length} accepted`,
);
