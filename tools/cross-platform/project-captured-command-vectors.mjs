// Independent references for local full-record commands. These deliberately do
// not claim generated-wire or session coverage; the original TS constructors
// own the expected behavior, including defensive capture of unknown metadata.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../web/src/project/store.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { prepareProjectIntent } from "../../web/src/project/PreparedProjectCommands.ts";
import {
  CreateInstanceCommand,
  PasteObjectCommand,
} from "../../web/src/project/objects/commands.ts";
import {
  InMemoryAssetRepository,
  assetBundleFingerprint,
} from "../../web/src/project/assets.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
process.env.TZ = "UTC";
const root = new URL("../../", import.meta.url),
  contents = [],
  traces = [];
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const string = (u) => (u === null ? undefined : String.fromCharCode(...u));
const ref = (r) =>
  r.kind === "project" ? r : { kind: r.kind, id: units(r.id) };
const selection = (s) => ({
  refs: s.refs.map(ref),
  primary: s.primary ? ref(s.primary) : null,
});
const history = (h) => ({
  ...h,
  undoLabel: h.undoLabel === undefined ? null : units(h.undoLabel),
  redoLabel: h.redoLabel === undefined ? null : units(h.redoLabel),
});
function snapshot(s) {
  const json = canonicalStringify(s.state);
  let content = contents.indexOf(json);
  if (content < 0) {
    content = contents.length;
    contents.push(json);
  }
  return { revision: s.revision, hash: s.hash, content };
}
function prepare(c) {
  if (c.intent) return prepareProjectIntent({ version: 1, command: c.intent });
  const record = JSON.parse(c.recordJson);
  let command;
  if (c.kind === "instance")
    command = new CreateInstanceCommand(
      string(c.objectId),
      record,
      c.index ?? undefined,
    );
  else {
    const ids = {
      objectId: string(c.ids.objectId),
      volumeIds: c.ids.volumeIds.map(string),
      instanceIds: c.ids.instanceIds.map(string),
      layerRangeIds: c.ids.layerRangeIds.map(string),
    };
    command = new PasteObjectCommand(record, ids, {
      ...(c.destination === null
        ? {}
        : { destinationPlateId: string(c.destination) }),
      ...(c.name === null ? {} : { name: string(c.name) }),
    });
    // Constructor must own the ID plan as well as the full template.
    ids.volumeIds.length = 0;
    ids.instanceIds.length = 0;
    ids.layerRangeIds.length = 0;
    ids.objectId = "import:object:mutated";
  }
  record.id = "import:record:mutated";
  record.name = "mutated";
  if (record.extensionData) record.extensionData.owned = "mutated";
  if (record.transform) record.transform.translationMm[0] = 999;
  if (record.volumes) record.volumes.length = 0;
  return command;
}
function scenario(name, options, work) {
  const f = createProjectFixture(),
    o = f.state.plates[0].objects[0];
  o.name = 'Template\\"\u0000\ud800😀';
  o.foreign = JSON.parse('{"__proto__":{"kept":"\\udfff"},"10":10,"2":2}');
  o.extensionData = { owned: "object" };
  o.instances[0].name = "";
  o.instances[0].foreign = { retained: true };
  o.instances[0].transform.foreign = { owned: "transform" };
  o.instances[0].extensionData = { owned: "instance" };
  o.instances.push({
    ...cloneJson(o.instances[0]),
    id: "import:instance:\u0000\ud800",
    name: " second ",
  });
  o.volumes[0].foreign = { owned: "volume" };
  o.layerRanges[0].foreign = { owned: "range" };
  const project = new ProjectStore(f.state),
    selected = new SelectionStore(),
    assets = new InMemoryAssetRepository();
  assets.put(f.asset.descriptor, f.asset.bytes);
  const bus = new CommandBus({ project, selection: selected, assets }, options),
    effects = [],
    steps = [];
  project.subscribe((c) =>
    effects.push({
      kind: "project",
      previous: snapshot(c.previous),
      current: snapshot(c.current),
      reason: units(c.reason),
      dirtyCategories: c.dirtyCategories,
    }),
  );
  selected.subscribe((current, previous) =>
    effects.push({
      kind: "selection",
      previous: selection(previous),
      current: selection(current),
    }),
  );
  bus.subscribeHistory((current, previous) =>
    effects.push({
      kind: "history",
      previous: history(previous),
      current: history(current),
    }),
  );
  const observe = () => ({
    snapshot: snapshot(project.getSnapshot()),
    selection: selection(selected.getSnapshot()),
    history: history(bus.getHistorySnapshot()),
    historyRevision: bus.getHistoryRevision(),
    assets: assetBundleFingerprint(assets.list()),
  });
  const initial = observe(),
    retained = [];
  function run(operation) {
    effects.length = 0;
    let result = null,
      error = null;
    retained.push([
      project.getSnapshot(),
      canonicalStringify(project.getSnapshot().state),
    ]);
    try {
      switch (operation.kind) {
        case "captured":
          bus.execute(prepare(operation.command), { coalesce: true });
          break;
        case "capturedBatch": {
          const commands = operation.commands.map(prepare);
          bus.transaction(string(operation.label), () => {
            for (const c of commands) bus.execute(c);
          });
          break;
        }
        case "undo":
          result = bus.undo();
          break;
        case "redo":
          result = bus.redo();
          break;
        case "checkpoint":
          bus.markCheckpoint();
          break;
        case "clear":
          bus.clearHistory({ markCheckpoint: operation.mark });
          break;
        case "selection":
          selected.set(
            operation.refs.map((r) => ({
              ...r,
              ...(r.id ? { id: string(r.id) } : {}),
            })),
          );
          break;
        default:
          throw new Error("unknown operation");
      }
    } catch (e) {
      error = units(e.message);
    }
    steps.push({
      operation,
      result,
      error,
      effects: [...effects],
      ...observe(),
    });
    for (const [s, json] of retained)
      assert.equal(canonicalStringify(s.state), json);
  }
  const execute = (command) => run({ kind: "captured", command }),
    batch = (commands, label = "Captured transaction") =>
      run({ kind: "capturedBatch", commands, label: units(label) });
  work({
    run,
    execute,
    batch,
    object: cloneJson(o),
    ids: f.ids,
    state: () => project.getSnapshot().state,
  });
  traces.push({
    name,
    options,
    stateJson: canonicalStringify(f.state),
    asset: {
      descriptorJson: canonicalStringify(f.asset.descriptor),
      bytes: [...f.asset.bytes],
    },
    initial,
    steps,
  });
}
function instance(object, suffix, index = null) {
  return {
    kind: "instance",
    objectId: units(object.id),
    recordJson: canonicalStringify({
      ...cloneJson(object.instances[0]),
      id: `import:instance:${suffix}`,
    }),
    index,
  };
}
function paste(object, suffix, destination = null, name = null) {
  return {
    kind: "object",
    recordJson: canonicalStringify(object),
    ids: {
      objectId: units(`import:object:${suffix}`),
      volumeIds: object.volumes.map((_, i) =>
        units(`import:volume:${suffix}:${i}`),
      ),
      instanceIds: object.instances.map((_, i) =>
        units(`import:instance:${suffix}:${i}`),
      ),
      layerRangeIds: object.layerRanges.map((_, i) =>
        units(`import:range:${suffix}:${i}`),
      ),
    },
    destination: destination === null ? null : units(destination),
    name: name === null ? null : units(name),
  };
}
const del = (id) => ({ intent: { deleteObject: { objectId: units(id) } } });
const rename = (id, name) => ({
  intent: { renameObject: { objectId: units(id), name: units(name) } },
});
const add = (id) => ({
  intent: {
    addPlate: {
      plateId: units(id),
      name: units("Destination"),
      order: 1,
      activate: true,
    },
  },
});
const editRecord = (command, edit) => {
  const record = JSON.parse(command.recordJson);
  edit(record);
  command.recordJson = canonicalStringify(record);
  return command;
};
const roundtrip = (execute, run, c) => {
  execute(c);
  run({ kind: "undo" });
  run({ kind: "redo" });
  run({ kind: "undo" });
};
scenario(
  "full-instance-capture-order-errors-and-history",
  {},
  ({ execute, batch, run, object, ids }) => {
    run({
      kind: "selection",
      refs: [
        { kind: "volume", id: units(ids.volume) },
        { kind: "instance", id: units(ids.instance) },
      ],
    });
    for (const index of [null, 0, -0, 1, 2])
      roundtrip(execute, run, instance(object, `position-${index}`, index));
    for (const index of [-1, 0.5, 3, 1e21, 1e-7, 1e100])
      execute(instance(object, "bad-index", index));
    for (const id of Object.values(ids))
      execute(editRecord(instance(object, "collision"), (r) => (r.id = id)));
    const unknown = instance(object, "missing");
    unknown.objectId = units("import:object:missing");
    execute(unknown);
    execute(
      editRecord(
        instance(object, "zero-scale"),
        (r) => (r.transform.scale[0] = 0),
      ),
    );
    roundtrip(
      execute,
      run,
      editRecord(instance(object, "absent-name"), (r) => delete r.name),
    );
    roundtrip(
      execute,
      run,
      editRecord(instance(object, "foreign-utf16"), (r) => {
        r.name = "\u0000\udfff😀";
        r.extensionData = JSON.parse(
          '{"__proto__":{"owned":"yes"},"\\ud800":"\\u0000"}',
        );
      }),
    );
    batch([
      instance(object, "atomic"),
      rename("import:object:missing", "fail"),
    ]);
    batch([instance(object, "atomic"), instance(object, "atomic")]);
    batch(
      [instance(object, "one"), instance(object, "two", 0)],
      "Two instances",
    );
    run({ kind: "undo" });
    run({ kind: "redo" });
    run({ kind: "checkpoint" });
    run({ kind: "undo" });
  },
);
scenario(
  "paste-owned-template-remapping-and-destination",
  {},
  ({ execute, batch, run, object, ids, state }) => {
    const destination = "import:plate:destination";
    execute(add(destination));
    execute(rename(ids.object, "later source"));
    execute(del(ids.object));
    for (const name of [
      null,
      " \ufeff\n",
      "",
      "\ufeff named 😀 \n",
      "\u0085",
      "\u0000\ud800",
    ]) {
      const c = paste(object, "copied", null, name);
      execute(c);
      if (name !== "" && name !== " \ufeff\n") {
        assert.equal(
          state().plates[1].objects[0].volumes[0].foreign.owned,
          "volume",
        );
        run({ kind: "undo" });
        run({ kind: "redo" });
        run({ kind: "undo" });
      }
    }
    roundtrip(execute, run, paste(object, "explicit", ids.plate));
    execute(paste(object, "unknown", "import:plate:missing"));
    for (const change of [
      (c) => c.ids.volumeIds.pop(),
      (c) => c.ids.instanceIds.pop(),
      (c) => c.ids.layerRangeIds.pop(),
      (c) => c.ids.volumeIds.push(units("import:volume:extra")),
      (c) => (c.ids.volumeIds[0] = c.ids.objectId),
      (c) => (c.ids.instanceIds[0] = c.ids.instanceIds[1]),
      (c) => (c.ids.objectId = units(ids.project)),
      (c) => (c.ids.layerRangeIds[0] = units(ids.asset)),
    ]) {
      const c = paste(object, "invalid");
      change(c);
      execute(c);
    }
    batch(
      [paste(object, "rolled-back"), del("import:object:missing")],
      "Rollback paste",
    );
    batch(
      [paste(object, "collision"), paste(object, "collision")],
      "Duplicate pasted IDs",
    );
    batch(
      [paste(object, "first"), paste(object, "never", null, " \ufeff ")],
      "Preparation fails before mutation",
    );
    execute(
      editRecord(
        paste(object, "invalid-graph"),
        (r) => (r.volumes[0].source.assetId = "import:asset:missing"),
      ),
    );
    execute(
      editRecord(paste(object, "empty-instances"), (r) => (r.instances = [])),
    );
  },
);
scenario(
  "capture-batches-exceed-small-wire-command-count",
  {},
  ({ execute, batch, run, object, state }) => {
    const placements = Array.from({ length: 70 }, (_, i) =>
      instance(object, `fill-${i}`),
    );
    batch(placements, "Fill 70 instances");
    assert.equal(state().plates[0].objects[0].instances.length, 72);
    run({ kind: "undo" });
    assert.equal(state().plates[0].objects[0].instances.length, 2);
    run({ kind: "redo" });
    run({ kind: "undo" });
    batch([...placements, instance(object, "fill-0")], "Rollback 70 instances");
    assert.equal(state().plates[0].objects[0].instances.length, 2);
    execute(paste(object, "after-fill"));
    run({ kind: "undo" });
  },
);
scenario(
  "local-batch-labels-preserve-domain-semantics",
  {},
  ({ batch, run, object }) => {
    for (const label of ["", " \ufeff ", "😀".repeat(300) + "\ud800"]) {
      batch([], label);
      batch([instance(object, "label")], label);
      run({ kind: "undo" });
      run({ kind: "redo" });
      run({ kind: "undo" });
    }
  },
);
// Derive exact independent history boundaries from the original constructors,
// then qualify both sides of the threshold; UTF-16 differs from UTF-8 byte size.
let sizes;
scenario("captured-retention-size-probe", {}, ({ object, execute, run }) => {
  const c = instance(object, "retained"),
    p = paste(object, "retained");
  const copied = cloneJson(object);
  copied.id = string(p.ids.objectId);
  copied.name += " copy";
  copied.volumes.forEach((v, i) => (v.id = string(p.ids.volumeIds[i])));
  copied.instances.forEach((v, i) => (v.id = string(p.ids.instanceIds[i])));
  copied.layerRanges.forEach((v, i) => (v.id = string(p.ids.layerRangeIds[i])));
  sizes = [
    canonicalStringify(JSON.parse(c.recordJson)).length,
    canonicalStringify(copied).length,
  ];
  assert.equal(prepare(c).estimateBytes(), sizes[0]);
  assert.equal(prepare(p).estimateBytes(), 1);
  execute(c);
  execute(p);
  run({ kind: "undo" });
  run({ kind: "redo" });
});
for (const size of sizes)
  for (const delta of [-1, 0, 1])
    scenario(
      `captured-retention-${size}-${delta}`,
      { maxEstimatedBytes: size + delta },
      ({ execute, run, object }) => {
        execute(instance(object, "retained"));
        execute(paste(object, "retained"));
        execute(instance(object, "following"));
        for (let i = 0; i < 4; i++) run({ kind: "undo" });
        for (let i = 0; i < 4; i++) run({ kind: "redo" });
        run({ kind: "checkpoint" });
        run({ kind: "clear", mark: false });
      },
    );
const sources = [
  "tools/cross-platform/project-captured-command-vectors.mjs",
  "web/src/project/objects/commands.ts",
  "web/src/project/commands.ts",
  "web/src/project/PreparedProjectCommands.ts",
  "web/src/project/history/command.ts",
  "web/src/project/history/commandBus.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/ids.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/store.ts",
  "web/src/project/selection.ts",
  "web/src/project/assets.ts",
  "web/src/project/__tests__/fixtures.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(new URL(path, root)))
          .digest("hex"),
      })),
      contents,
      traces,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/project-captured-command-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Captured command reference drift",
  );
console.log(
  `Captured command references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`,
);
