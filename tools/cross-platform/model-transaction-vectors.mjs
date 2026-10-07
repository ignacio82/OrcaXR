// Independent production-browser expectations for the model import
// transaction: `ProjectImportCoordinator.prepare` with `ModelImportParser` over
// a real `CommandBus`, then explicit confirmation, one undoable commit, undo and
// redo. Rows record the complete preview, the staged bundle the commit would
// apply, the committed state, assets and history, and the restored state after
// undo. Negative rows exercise missing acknowledgements, a stale base, and
// cancellation. Bases are an empty project and projects already holding the
// imported mesh/name, so normalization's deduplication paths are reached.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { RenamePlateCommand } from "../../web/src/project/commands.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { ModelImportParser } from "../../web/src/project/import/ModelImportParser.ts";
import { ProjectImportCoordinator } from "../../web/src/project/import/ProjectImportCoordinator.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { ProjectStore } from "../../web/src/project/store.ts";

const root = new URL("../../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text) => new TextEncoder().encode(text);
const IMPORTED_AT = "2026-10-07T12:00:00.000Z";
const FULL_STATE_BYTES = 64 * 1024;
const decoding = JSON.parse(readFileSync(new URL("testdata/cross-platform/model-import-vectors.json", root), "utf8"));
const staging = JSON.parse(readFileSync(new URL("testdata/cross-platform/model-stage-vectors.json", root), "utf8"));
const rows = new Map(decoding.cases.map((c) => [c.name, c]));
const text = (value) => (typeof value === "string" ? value : String.fromCharCode(...value));
const bytesOf = (row) =>
  row.bytesBase64 ? new Uint8Array(Buffer.from(row.bytesBase64, "base64")) : new Uint8Array(readFileSync(new URL(row.path, root)));

/** Deterministic stable IDs in a per-transaction namespace. */
class CountingIds {
  constructor(namespace) {
    this.namespace = namespace;
    this.requests = [];
  }
  next(kind) {
    const id = `import:${this.namespace}:${kind}-${this.requests.length + 1}`;
    this.requests.push(kind);
    return id;
  }
}
function harness(base) {
  const project = new ProjectStore(base.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  for (const asset of base.assets) assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  return { project, assets, commands };
}
const stateRecord = (state) => {
  const json = canonicalStringify(state);
  return json.length <= FULL_STATE_BYTES ? { stateJson: json } : { stateSha256: sha256(utf8(json)) };
};
const assetRecord = (list) =>
  list.map((a) => ({ descriptorJson: canonicalStringify(a.descriptor), bytesSha256: sha256(a.bytes) }));
// Absent labels are undefined in the snapshot; JSON drops them.
const history = (h) => canonicalStringify(JSON.parse(JSON.stringify(h)));

async function prepare(base, row, placement, { stale = false, namespace }) {
  const h = harness(base);
  const ids = new CountingIds(namespace);
  const coordinator = new ProjectImportCoordinator({
    parser: new ModelImportParser({
      idSource: ids,
      clock: () => IMPORTED_AT,
      ...(row.limits ? { limits: row.limits } : {}),
      ...(placement ? { placement } : {}),
    }),
    commands: h.commands,
    now: () => IMPORTED_AT,
  });
  const prepared = await coordinator.prepare({ bytes: bytesOf(row), source: { filename: text(row.filename) }, mode: "merge" });
  if (stale) {
    const plate = h.project.getSnapshot().state.plates[0].id;
    h.commands.execute(new RenamePlateCommand(plate, "Edited meanwhile"), { coalesce: false });
  }
  return { h, ids, prepared };
}
const errorRecord = (error) => [error.name, ...(error.missingAcknowledgementIds ? [error.missingAcknowledgementIds] : [])];

async function transaction(base, row, placement, namespace) {
  let run;
  try {
    run = await prepare(base, row, placement, { namespace });
  } catch (error) {
    return { prepareError: error.name };
  }
  const { h, ids, prepared } = run;
  const record = {
    idRequests: ids.requests,
    preview: canonicalStringify(prepared.preview),
    staged: { ...stateRecord(prepared.staged.state), assets: assetRecord(prepared.staged.assets) },
  };
  const before = canonicalStringify(h.project.getSnapshot().state);
  if (prepared.preview.requiredAcknowledgementIds.length > 0) {
    try {
      prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] });
      record.unacknowledged = "committed";
    } catch (error) {
      record.unacknowledged = errorRecord(error);
    }
  }
  try {
    prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [...prepared.preview.requiredAcknowledgementIds] });
  } catch (error) {
    record.commitError = errorRecord(error);
    return record;
  }
  const committed = h.project.getSnapshot().state;
  record.committed = {
    ...stateRecord(committed),
    assets: assetRecord(h.assets.list()),
    history: history(h.commands.getHistorySnapshot()),
  };
  assert.equal(h.commands.undo(), true);
  record.undone = {
    restoresBase: canonicalStringify(h.project.getSnapshot().state) === before,
    assets: assetRecord(h.assets.list()),
    history: history(h.commands.getHistorySnapshot()),
  };
  assert.equal(h.commands.redo(), true);
  record.redone = {
    restoresCommitted: canonicalStringify(h.project.getSnapshot().state) === canonicalStringify(committed),
    history: history(h.commands.getHistorySnapshot()),
  };
  return record;
}

const placementOf = (name) => staging.placements[name];
const baseOf = (json) => ({ state: JSON.parse(json), assets: [] });
const empty = baseOf(staging.bases.empty);
async function committedBase(base, row) {
  const { h, prepared } = await prepare(base, row, placementOf("bed"), { namespace: "base" });
  prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [...prepared.preview.requiredAcknowledgementIds] });
  return { state: h.project.getSnapshot().state, assets: h.assets.list() };
}
const holding = await committedBase(empty, rows.get("stl-binary/cube"));
const bases = { empty, holding, "second-active": baseOf(staging.bases["second-active"]) };

const cases = [];
const selected = [
  ["stl-binary/cube", "empty", "bed"],
  ["stl-binary/cube", "holding", "bed"],
  ["stl-binary/cube", "second-active", "source"],
  ["stl-ascii/two-solids", "empty", "bed"],
  ["stl-binary/degenerate", "empty", "centre"],
  ["obj/groups-and-materials", "holding", "drop"],
  ["obj/curves-and-ignored", "empty", "bed"],
  ["obj/vertex-colors", "empty", "bed"],
  ["obj/mtllib-unresolved", "empty", "bed"],
  ["amf/metadata-and-materials", "empty", "bed"],
  ["amf/constellation", "holding", "bed"],
  ["amf-gzip/basic", "empty", "bed"],
  ["zip/mixed", "empty", "bed"],
  ["zip/stored", "holding", "source"],
  ["obj/huge-vertex-f32-overflow", "empty", "bed"],
  ["stl-binary/limit-triangles", "empty", "bed"],
  ["detect/step", "empty", "bed"],
  ["real/web/public/models/3dbenchy.stl", "holding", "bed"],
];
for (const [index, [decode, base, placement]] of selected.entries()) {
  const namespace = `tx${index}`;
  cases.push({ name: `${decode}#${base}#${placement}`, decode, base, placement, namespace, expected: await transaction(bases[base], rows.get(decode), placementOf(placement), namespace) });
}
// Reusing the base's ID namespace collides with its records: the preview reports
// every duplicate and blocks the commit.
cases.push({
  name: "collision/obj/groups-and-materials#holding#drop",
  decode: "obj/groups-and-materials",
  base: "holding",
  placement: "drop",
  namespace: "base",
  expected: await transaction(holding, rows.get("obj/groups-and-materials"), placementOf("drop"), "base"),
});
// A stale base refuses the commit and leaves the edit in place.
{
  const { h, prepared } = await prepare(empty, rows.get("stl-binary/cube"), placementOf("bed"), { stale: true, namespace: "stale" });
  let error;
  try {
    prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [...prepared.preview.requiredAcknowledgementIds] });
  } catch (caught) {
    error = errorRecord(caught);
  }
  cases.push({
    name: "stale/stl-binary/cube",
    decode: "stl-binary/cube",
    base: "empty",
    placement: "bed",
    namespace: "stale",
    stale: true,
    expected: { commitError: error, history: history(h.commands.getHistorySnapshot()), state: stateRecord(h.project.getSnapshot().state) },
  });
}
// Cancelling the prepared import refuses a later confirmation.
{
  const { prepared } = await prepare(empty, rows.get("stl-binary/cube"), placementOf("bed"), { namespace: "cancelled" });
  prepared.cancel("operator");
  let error;
  try {
    prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] });
  } catch (caught) {
    error = errorRecord(caught);
  }
  cases.push({ name: "cancelled/stl-binary/cube", decode: "stl-binary/cube", base: "empty", placement: "bed", namespace: "cancelled", cancelled: true, expected: { commitError: error } });
}

const sources = [
  "web/src/project/import/ProjectImportCoordinator.ts",
  "web/src/project/import/ImportProjectCommand.ts",
  "web/src/project/import/ModelImportParser.ts",
  "web/src/project/history/commandBus.ts",
  "web/src/project/assets.ts",
  "web/src/project/domain/validation.ts",
  "testdata/cross-platform/model-stage-vectors.json",
].map((path) => ({ path, sha256: sha256(readFileSync(new URL(path, root))) }));
const header = JSON.stringify({ format: 1, importedAt: IMPORTED_AT, sources });
const output = `${header.slice(0, -1)},"cases":[\n${cases.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
const target = new URL("testdata/cross-platform/model-transaction-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "model transaction references are stale; rerun with --write");
console.log(JSON.stringify({ cases: cases.length, committed: cases.filter((c) => c.expected.committed).length }));
