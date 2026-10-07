// Independent production-browser expectations for staging decoded models into
// an open project (`ModelImportParser.parse`, merge mode). Every accepted case
// of the model decoding corpus is staged into an empty project with and without
// bed placement; chained cases stage into projects that already hold the same
// mesh and object names, and into a non-first active plate. Rows record the
// deterministic ID requests, the complete staged state (full canonical JSON, or
// its digest for large cases), every returned asset (descriptor and byte
// digest), the imported asset IDs and the repair/dropped/diagnostic notices.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ModelImportParser } from "../../web/src/project/import/ModelImportParser.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";

const root = new URL("../../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text) => new TextEncoder().encode(text);
const IMPORTED_AT = "2026-10-07T12:00:00.000Z";
const FULL_STATE_BYTES = 64 * 1024;

const decoding = JSON.parse(readFileSync(new URL("testdata/cross-platform/model-import-vectors.json", root), "utf8"));
const text = (value) => (typeof value === "string" ? value : String.fromCharCode(...value));
const bytesOf = (row) =>
  row.bytesBase64 ? new Uint8Array(Buffer.from(row.bytesBase64, "base64")) : new Uint8Array(readFileSync(new URL(row.path, root)));

const plate = (id, order) => ({ id, name: `Plate ${order + 1}`, order, printable: true, config: {}, objects: [] });
const EMPTY = {
  schemaVersion: 1,
  id: "import:model-test:project",
  name: "Model staging",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  printer: { toolCount: 1 },
  config: {},
  activePlateId: "import:model-test:plate-a",
  plates: [plate("import:model-test:plate-a", 0)],
  filaments: { physical: [], mixed: [] },
  sourceAssets: [],
  customGcode: [],
  thumbnails: [],
  extensionBlobs: [],
};
const SECOND_ACTIVE = {
  ...EMPTY,
  activePlateId: "import:model-test:plate-b",
  plates: [plate("import:model-test:plate-a", 0), plate("import:model-test:plate-b", 1)],
};

class CountingIds {
  constructor() {
    this.requests = [];
  }
  next(kind) {
    const id = `import:model-test:${kind}-${this.requests.length + 1}`;
    this.requests.push(kind);
    return id;
  }
}

async function stage(base, row, placement) {
  const ids = new CountingIds();
  const parser = new ModelImportParser({
    idSource: ids,
    clock: () => IMPORTED_AT,
    ...(row.limits ? { limits: row.limits } : {}),
    ...(placement ? { placement } : {}),
  });
  try {
    const parsed = await parser.parse({
      bytes: bytesOf(row),
      source: { filename: text(row.filename) },
      mode: "merge",
      base: { state: base.state, assets: base.assets, sourceRevision: 1, sourceHash: "base" },
    });
    return { ids, parsed };
  } catch (error) {
    return { ids, error };
  }
}
function expectation({ ids, parsed, error }) {
  if (error) return { error: [error.name, error.reasonCode ?? null, error.format ?? null] };
  const stateJson = canonicalStringify(parsed.state);
  return {
    idRequests: ids.requests,
    ...(stateJson.length <= FULL_STATE_BYTES ? { stateJson } : { stateSha256: sha256(utf8(stateJson)) }),
    assets: parsed.assets.map((asset) => ({
      descriptorJson: canonicalStringify(asset.descriptor),
      bytesSha256: sha256(asset.bytes),
    })),
    importedAssetIds: parsed.importedAssetIds,
    repairs: canonicalStringify(parsed.repairs),
    droppedFields: canonicalStringify(parsed.droppedFields),
    diagnostics: canonicalStringify(parsed.diagnostics),
  };
}

const PLACEMENTS = {
  source: undefined,
  bed: { bedSizeMm: [220, 220], dropToBed: true },
  centre: { bedSizeMm: [256.5, 180] },
  drop: { dropToBed: true },
};
const cases = [];
const empty = { state: EMPTY, assets: [] };
for (const row of decoding.cases) {
  if (!row.expected.ok) continue;
  const placements = row.path ? ["bed"] : ["source", "bed"];
  for (const placement of placements) {
    const result = await stage(empty, row, PLACEMENTS[placement]);
    cases.push({ name: `${row.name}#${placement}`, decode: row.name, base: "empty", placement, expected: expectation(result) });
  }
}

// Chained stages: a project already holding the cube mesh and object names.
const find = (name) => decoding.cases.find((c) => c.name === name);
const first = await stage(empty, find("stl-binary/cube"), PLACEMENTS.bed);
const holding = { state: first.parsed.state, assets: first.parsed.assets };
const bases = { empty, holding, "second-active": { state: SECOND_ACTIVE, assets: [] } };
for (const [decode, base, placement] of [
  ["stl-binary/cube", "holding", "bed"],
  ["stl-binary/cube", "holding", "source"],
  ["stl-ascii/cube", "holding", "centre"],
  ["obj/objects", "holding", "drop"],
  ["zip/stored", "holding", "bed"],
  ["amf/constellation", "holding", "bed"],
  ["amf/metadata-and-materials", "holding", "bed"],
  ["obj/groups-and-materials", "second-active", "bed"],
  ["stl-binary/cube", "second-active", "source"],
]) {
  const result = await stage(bases[base], find(decode), PLACEMENTS[placement]);
  cases.push({ name: `chain/${decode}#${base}#${placement}`, decode, base, placement, expected: expectation(result) });
}
// A third identical import picks the next free suffix.
const second = await stage(holding, find("stl-binary/cube"), PLACEMENTS.bed);
const twice = { state: second.parsed.state, assets: second.parsed.assets };
const third = await stage(twice, find("stl-binary/cube"), PLACEMENTS.bed);
cases.push({ name: "chain/stl-binary/cube#twice#bed", decode: "stl-binary/cube", base: "twice", placement: "bed", expected: expectation(third) });

const names = new Set(cases.map((c) => c.name));
assert.equal(names.size, cases.length, "case names are unique");
const sources = [
  "web/src/project/import/ModelImportParser.ts",
  "web/src/project/meshCodec.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/model.ts",
  "testdata/cross-platform/model-import-vectors.json",
].map((path) => ({ path, sha256: sha256(readFileSync(new URL(path, root))) }));
const header = JSON.stringify({
  format: 1,
  importedAt: IMPORTED_AT,
  placements: PLACEMENTS,
  bases: { empty: canonicalStringify(EMPTY), "second-active": canonicalStringify(SECOND_ACTIVE) },
  sources,
});
const output = `${header.slice(0, -1)},"cases":[\n${cases.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
const target = new URL("testdata/cross-platform/model-stage-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "model staging references are stale; rerun with --write");
console.log(JSON.stringify({ cases: cases.length, staged: cases.filter((c) => !c.expected.error).length }));
