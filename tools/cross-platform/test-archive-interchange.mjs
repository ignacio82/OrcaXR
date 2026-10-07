// Actual browser/native bytes and commands; no imported ID normalization.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
import {
  canonicalStringify,
  projectFingerprint,
} from "../../web/src/project/domain/canonical.ts";
import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  RenamePlateCommand,
  SelectionStore,
} from "../../web/src/project/index.ts";
const [mode, directory] = process.argv.slice(2),
  root = resolve(directory);
const corpus = new URL("../../testdata/cross-platform/", import.meta.url);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const serializer = new Bbs3mfProjectSerializer();
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const inventory = (bytes) =>
  [...readSafeZip(bytes)]
    .map(([path, payload]) => [
      path,
      payload.length,
      createHash("sha256").update(payload).digest("hex"),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const sortAssets = (assets) =>
  assets.sort((a, b) => {
    const left = JSON.parse(a.descriptorJson).id,
      right = JSON.parse(b.descriptorJson).id;
    return left < right ? -1 : left > right ? 1 : 0;
  });
function snapshot(result) {
  return {
    stateJson: canonicalStringify(result.state),
    assets: sortAssets(
      result.assets.map((a) => ({
        id: units(a.descriptor.id),
        descriptorJson: canonicalStringify(a.descriptor),
        bytesHex: Buffer.from(a.bytes).toString("hex"),
      })),
    ),
  };
}
function equal(actual, expected, label) {
  assert.deepEqual(
    { ...actual, assets: sortAssets(actual.assets) },
    snapshot(expected),
    label,
  );
}
const warnings = (result) =>
  [...new Set(result.warnings ?? [])].sort().map(units);
async function open(bytes) {
  try {
    return { result: await serializer.deserialize(bytes) };
  } catch (error) {
    return { error: error.message };
  }
}
async function save(result) {
  try {
    return {
      result: await serializer.serialize({
        ...result,
        sourceRevision: 1,
        sourceHash: projectFingerprint(result.state),
      }),
    };
  } catch (error) {
    return { error: error.message };
  }
}
function rename(result, name) {
  const project = new ProjectStore(result.state),
    repository = new InMemoryAssetRepository();
  for (const a of result.assets) repository.put(a.descriptor, a.bytes);
  const bus = new CommandBus({
    project,
    assets: repository,
    selection: new SelectionStore(),
  });
  bus.execute(new RenamePlateCommand(result.state.plates[0].id, name));
  const state = project.getSnapshot().state;
  assert.equal(state.plates[0].name, name);
  return { ...result, state };
}
if (mode === "prepare") {
  mkdirSync(root, { recursive: true });
  const rows = [];
  function add(name, bytes) {
    const path = `browser-${rows.length}.3mf`;
    writeFileSync(join(root, path), bytes);
    rows.push({ name, path, edit: "Native edit & 雪" });
  }
  for (const c of read(new URL("canonical-complete-vectors.json", corpus))
    .cases)
    add(`canonical/${c.name}`, Buffer.from(c.archiveHex, "hex"));
  const sources = Object.fromEntries(
    ["bbs-model", "bbs-metadata", "bbs-settings", "package-input"].map((s) => [
      s,
      read(new URL(`${s}-vectors.json`, corpus)),
    ]),
  );
  for (const c of read(new URL("package-vectors.json", corpus)).cases.filter(
    (r) => r.members,
  )) {
    const input = sources[c.source].cases[c.index];
    const source = {
      state: JSON.parse(input.stateJson),
      assets: input.assets.map((a) => ({
        descriptor: JSON.parse(a.descriptorJson),
        bytes: new Uint8Array(a.bytes),
      })),
    };
    const saved = await save(source);
    assert.ok(saved.result, `${c.source}/${c.name}: ${saved.error}`);
    add(`package/${c.source}/${c.name}`, saved.result.bytes);
  }
  write(join(root, "input.json"), rows);
  console.log(JSON.stringify({ browserInputs: rows.length }));
} else if (mode === "exchange") {
  const rows = read(join(root, "input.json")),
    native = read(join(root, "native/report.json"));
  assert.equal(native.length, rows.length);
  const returns = [],
    expected = [];
  const counts = {
    cases: rows.length,
    importRefusals: 0,
    nativeEdits: 0,
    saveRefusals: 0,
    nativeSaves: 0,
    browserEdits: 0,
    browserSaves: 0,
  };
  mkdirSync(join(root, "returns"), { recursive: true });
  for (const [i, row] of rows.entries()) {
    const actual = native[i],
      label = row.name;
    assert.equal(actual.name, label);
    const opened = await open(
      new Uint8Array(readFileSync(join(root, row.path))),
    );
    assert.equal(
      !!actual.imported,
      !!opened.result,
      `${label}: import acceptance; native ${actual.error}, browser ${opened.error}`,
    );
    if (!opened.result) {
      counts.importRefusals++;
      continue;
    }
    equal(actual.imported, opened.result, `${label}: imported state/assets`);
    assert.deepEqual(
      actual.warnings,
      warnings(opened.result),
      `${label}: import warnings`,
    );
    const edited = rename(opened.result, row.edit);
    equal(
      actual.edited,
      edited,
      `${label}: native session versus browser command`,
    );
    counts.nativeEdits++;
    const browserSaved = await save(edited);
    assert.equal(
      !!actual.saved,
      !!browserSaved.result,
      `${label}: Save acceptance; native ${actual.saveError}, browser ${browserSaved.error}`,
    );
    if (!actual.saved) {
      counts.saveRefusals++;
      continue;
    }
    const nativeBytes = new Uint8Array(
      readFileSync(join(root, "native", actual.saved.path)),
    );
    assert.equal(nativeBytes.length, actual.saved.bytes);
    assert.deepEqual(
      inventory(nativeBytes),
      inventory(browserSaved.result.bytes),
      `${label}: exact Save members after the same edit`,
    );
    const reopened = await open(nativeBytes);
    assert.ok(
      reopened.result,
      `${label}: browser opens actual native Save: ${reopened.error}`,
    );
    equal(
      actual.reopened,
      reopened.result,
      `${label}: both readers of native bytes`,
    );
    assert.deepEqual(
      actual.reopenedWarnings,
      warnings(reopened.result),
      `${label}: native output warnings`,
    );
    // A save must retain every declared immutable payload and its original ID.
    for (const a of edited.assets) {
      const b = reopened.result.assets.find(
        (v) => v.descriptor.id === a.descriptor.id,
      );
      assert.ok(b, `${label}: original asset survives native Save`);
      assert.equal(
        canonicalStringify(b.descriptor),
        canonicalStringify(a.descriptor),
      );
      assert.deepEqual(b.bytes, a.bytes);
    }
    assert.equal(reopened.result.state.plates[0].name, row.edit);
    counts.nativeSaves++;
    const browserEdited = rename(reopened.result, "Browser return & 水");
    counts.browserEdits++;
    const returned = await save(browserEdited);
    assert.ok(
      returned.result,
      `${label}: browser second edit Save: ${returned.error}`,
    );
    const again = await open(returned.result.bytes);
    assert.ok(
      again.result,
      `${label}: browser reopens its second Save: ${again.error}`,
    );
    assert.equal(again.result.state.plates[0].name, "Browser return & 水");
    const path = `return-${i}.3mf`;
    writeFileSync(join(root, "returns", path), returned.result.bytes);
    returns.push({ name: label, path });
    expected.push({
      name: label,
      imported: snapshot(again.result),
      warnings: warnings(again.result),
    });
    counts.browserSaves++;
  }
  assert.ok(
    counts.nativeSaves > 0 &&
      counts.importRefusals > 0 &&
      counts.saveRefusals > 0,
  );
  write(join(root, "returns/input.json"), returns);
  write(join(root, "returns/expected.json"), expected);
  write(join(root, "counts.json"), counts);
  console.log(JSON.stringify(counts));
} else if (mode === "verify") {
  const expected = read(join(root, "returns/expected.json")),
    actual = read(join(root, "returned/report.json"));
  assert.equal(actual.length, expected.length);
  for (const [i, row] of expected.entries()) {
    const value = actual[i];
    assert.equal(value.name, row.name);
    assert.ok(
      value.imported,
      `${row.name}: native reimport of real browser edit: ${value.error}`,
    );
    sortAssets(value.imported.assets);
    sortAssets(row.imported.assets);
    assert.deepEqual(
      value,
      row,
      `${row.name}: exact returned state/assets/warnings`,
    );
  }
  const counts = {
    ...read(join(root, "counts.json")),
    nativeReimports: actual.length,
  };
  assert.equal(counts.nativeReimports, counts.browserSaves);
  write(join(root, "result.json"), counts);
  console.log(JSON.stringify(counts));
} else throw new Error("expected prepare, exchange or verify");
