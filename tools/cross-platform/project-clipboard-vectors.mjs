// Browser-authored clipboard traces. Captures precede the destination fixture:
// this models retained local clipboard data without claiming native reset/adopt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../web/src/project/store.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { prepareProjectIntent } from "../../web/src/project/PreparedProjectCommands.ts";
import {
  PasteObjectCommand,
  objectAssetIds,
} from "../../web/src/project/objects/commands.ts";
import {
  captureClipboardPasteCommand,
  singleStagedWork,
  takeStagedWork,
} from "../../web/src/project/StagedProjectCommands.ts";
import {
  InMemoryAssetRepository,
  assetBundleFingerprint,
  contentDigest,
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
const payload = (p) => ({
  descriptorJson: canonicalStringify(p.descriptor),
  bytes: [...p.bytes],
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
function plan(object, suffix = "copied") {
  return {
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
  };
}
const decodeIds = (ids) => ({
  objectId: string(ids.objectId),
  volumeIds: ids.volumeIds.map(string),
  instanceIds: ids.instanceIds.map(string),
  layerRangeIds: ids.layerRangeIds.map(string),
});
function scenario(name, mode, options, work) {
  const f = createProjectFixture();
  f.object.name = 'Clipboard\\"\u0000\ud800😀';
  f.object.foreign = JSON.parse(
    '{"__proto__":{"kept":"\\udfff"},"10":10,"2":2}',
  );
  f.object.instances[0].extensionData = { owned: "instance" };
  f.asset.descriptor.foreign = { "\ud800": "\u0000😀" };
  if (mode === "byte-conflict")
    f.asset.descriptor.digest = "external:clipboard-content";
  const svgBytes = new TextEncoder().encode('<svg id="clipboard"/>');
  const svg = {
    descriptor: {
      id: "import:asset:svg",
      kind: "extension",
      mediaType: "image/svg+xml",
      byteLength: svgBytes.length,
      digest: contentDigest(svgBytes),
    },
    bytes: svgBytes,
  };
  f.object.volumes[0].embossSvg = {
    drawingAssetId: svg.descriptor.id,
    pathIn3mf: "Metadata/svg/source.svg",
    depthMm: 1,
    useSurface: false,
    widthMm: 10,
  };
  // Repeated dependencies must be retained once and in first-use order.
  f.object.volumes.push({
    ...cloneJson(f.object.volumes[0]),
    id: "import:volume:second",
  });
  f.state.sourceAssets.push(svg.descriptor);
  const unused = {
    descriptor: { ...cloneJson(svg.descriptor), id: "import:asset:unused" },
    bytes: svgBytes,
  };
  f.state.sourceAssets.push(unused.descriptor);
  const captureAssets = [f.asset, svg, unused],
    original = new InMemoryAssetRepository();
  for (const p of captureAssets) original.put(p.descriptor, p.bytes);
  const object = new ProjectStore(f.state).getSnapshot().state.plates[0]
    .objects[0];
  const captured = original.captureSelection(objectAssetIds(object), {
    maxAssets: 2,
    maxBytes: 4096,
  });
  assert.equal(captured.descriptors.length, 2);
  const leases = new Map(
    captured.descriptors.map((d) => [d.id, original.peek(d.id)]),
  );
  const state = cloneJson(f.state),
    assets = mode === "foreign" ? new InMemoryAssetRepository() : original;
  if (mode !== "present") state.plates[0].objects = [];
  if (!["present", "deleted"].includes(mode)) {
    state.sourceAssets = [];
    for (const p of original.list()) original.remove(p.descriptor.id);
  }
  if (mode === "partial") {
    state.sourceAssets = [cloneJson(svg.descriptor)];
    assets.mergeSelection(captured);
    assets.remove(f.ids.asset);
  }
  if (mode === "dangling-material")
    state.filaments = { physical: [], mixed: [] };
  if (mode === "undeclared") assets.put(f.asset.descriptor, f.asset.bytes);
  if (mode === "missing-bytes")
    state.sourceAssets = [cloneJson(f.asset.descriptor)];
  if (mode === "metadata-conflict") {
    const descriptor = {
      ...cloneJson(f.asset.descriptor),
      sourceFilename: "changed.stl",
    };
    state.sourceAssets = [descriptor];
    assets.put(descriptor, f.asset.bytes);
  }
  if (mode === "record-conflict") {
    // Keep the canonical declaration equal to the capture and alter the repository.
    state.sourceAssets = [cloneJson(f.asset.descriptor)];
    assets.put(
      { ...f.asset.descriptor, sourceFilename: "different-record.stl" },
      f.asset.bytes,
    );
  }
  if (mode === "byte-conflict") {
    state.sourceAssets = [cloneJson(f.asset.descriptor)];
    const bytes = f.asset.bytes.slice();
    bytes[0] ^= 1;
    assets.put(f.asset.descriptor, bytes);
  }
  const initialAssets = assets.list().map((p) => ({
    ...payload(p),
    sameCaptured: leases.get(p.descriptor.id) === assets.peek(p.descriptor.id),
  }));
  const project = new ProjectStore(state),
    selected = new SelectionStore();
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
  const records = () =>
    assets.list().map((p) => ({
      ...payload(p),
      sameCaptured:
        leases.get(p.descriptor.id) === assets.peek(p.descriptor.id),
    }));
  const initial = observe(),
    retained = [];
  function run(operation) {
    effects.length = 0;
    let result = null,
      error = null,
      inputUnits = null;
    retained.push([
      project.getSnapshot(),
      canonicalStringify(project.getSnapshot().state),
    ]);
    const prepare = (c) => {
      if (c.intent)
        return prepareProjectIntent({ version: 1, command: c.intent });
      const ids = decodeIds(c.ids),
        destination = string(c.destination);
      if (mode === "foreign")
        return new PasteObjectCommand(
          object,
          ids,
          destination === undefined ? {} : { destinationPlateId: destination },
          captured,
        );
      const prepared = captureClipboardPasteCommand(
        object,
        ids,
        destination,
        assets,
        captured,
        { maxUnits: 1_000_000, maxNodes: 100_000, maxDepth: 128 },
      );
      inputUnits = prepared.inputUnits;
      return takeStagedWork(singleStagedWork(prepared)).commands[0];
    };
    try {
      switch (operation.kind) {
        case "clipboard":
          bus.execute(prepare(operation.command), { coalesce: true });
          break;
        case "clipboardBatch": {
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
      inputUnits,
      effects: [...effects],
      records: records(),
      ...observe(),
    });
    for (const [s, json] of retained)
      assert.equal(canonicalStringify(s.state), json);
    return steps.at(-1);
  }
  const command = (suffix = "copied", destination = null) => ({
    ids: plan(object, suffix),
    destination: destination === null ? null : units(destination),
  });
  work({
    run,
    command,
    object,
    ids: f.ids,
    descriptors: captured.descriptors,
    assetBytes: captured.byteLength,
  });
  traces.push({
    name,
    options,
    stateJson: canonicalStringify(state),
    assets: initialAssets,
    clipboard: {
      stateJson: canonicalStringify(f.state),
      assets: captureAssets.map(payload),
      foreign: mode === "foreign",
    },
    initial,
    steps,
  });
}
const roundtrip = ({ run, command }) => {
  run({ kind: "clipboard", command: command() });
  run({ kind: "undo" });
  run({ kind: "redo" });
  run({ kind: "checkpoint" });
  run({ kind: "undo" });
  run({ kind: "redo" });
  run({ kind: "clear", mark: false });
};
for (const mode of [
  "present",
  "deleted",
  "reset",
  "partial",
  "foreign",
  "dangling-material",
  "undeclared",
  "missing-bytes",
  "metadata-conflict",
  "record-conflict",
  "byte-conflict",
])
  scenario(`clipboard-${mode}`, mode, {}, roundtrip);
scenario(
  "clipboard-id-and-destination-failures",
  "reset",
  {},
  ({ run, command, ids }) => {
    for (const mutate of [
      (c) => c.ids.volumeIds.pop(),
      (c) => c.ids.instanceIds.pop(),
      (c) => c.ids.layerRangeIds.push(units("import:range:extra")),
      (c) => (c.ids.volumeIds[0] = c.ids.volumeIds[1]),
      (c) => (c.ids.objectId = units(ids.project)),
      (c) => (c.ids.volumeIds[0] = units(ids.asset)),
      (c) => (c.destination = units("import:plate:missing")),
    ]) {
      const c = command();
      mutate(c);
      run({ kind: "clipboard", command: c });
    }
    roundtrip({ run, command });
  },
);
scenario(
  "clipboard-atomic-batches-and-shared-assets",
  "reset",
  {},
  ({ run, command }) => {
    const batch = (commands) =>
      run({
        kind: "clipboardBatch",
        label: units("Clipboard pair 😀\ud800"),
        commands,
      });
    batch([command("first"), command("first")]);
    batch([
      command("first"),
      { intent: { deleteObject: { objectId: units("import:object:absent") } } },
    ]);
    batch([command("first"), command("second")]);
    run({ kind: "undo" });
    run({ kind: "redo" });
    run({ kind: "undo" });
    run({ kind: "clipboard", command: command("first") });
    run({ kind: "clipboard", command: command("second") });
    for (let i = 0; i < 3; ++i) run({ kind: "undo" });
    for (let i = 0; i < 3; ++i) run({ kind: "redo" });
  },
);
// Derive history thresholds from actual reference publication, including bytes
// and descriptor metadata; an object-only accounting implementation fails here.
let exact;
scenario(
  "clipboard-history-size",
  "reset",
  {},
  ({ run, command, object, descriptors, assetBytes }) => {
    const c = command(),
      copied = cloneJson(object),
      ids = decodeIds(c.ids);
    copied.id = ids.objectId;
    copied.name += " copy";
    copied.volumes.forEach((v, i) => (v.id = ids.volumeIds[i]));
    copied.instances.forEach((v, i) => (v.id = ids.instanceIds[i]));
    copied.layerRanges.forEach((v, i) => (v.id = ids.layerRangeIds[i]));
    run({ kind: "clipboard", command: c });
    exact =
      canonicalStringify(copied).length +
      canonicalStringify(descriptors).length +
      assetBytes;
  },
);
for (const delta of [-1, 0, 1])
  scenario(
    `clipboard-retention-${delta}`,
    "reset",
    { maxEstimatedBytes: exact * 2 + delta },
    ({ run, command }) => {
      run({ kind: "clipboard", command: command("copied") });
      const second = run({ kind: "clipboard", command: command("second") });
      assert.equal(second.history.undoCount, delta < 0 ? 1 : 2);
      for (let i = 0; i < 3; ++i) run({ kind: "undo" });
      for (let i = 0; i < 3; ++i) run({ kind: "redo" });
    },
  );

const sources = [
  "tools/cross-platform/project-clipboard-vectors.mjs",
  "web/src/project/objects/commands.ts",
  "web/src/project/StagedProjectCommands.ts",
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
  "testdata/cross-platform/project-clipboard-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Clipboard reference drift");
console.log(
  `Clipboard references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`,
);
