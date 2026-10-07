// Independent production TypeScript authority for full-record staging and the
// generated resource-reference protocol. This does not imply a WASM/JNI upload API.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import {
  AsyncEditorSession,
  AsyncSessionError,
} from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { objectAssetIds } from "../../web/src/project/objects/commands.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import {
  captureInstanceCommand,
  capturePasteCommand,
  captureClipboardPasteCommand,
  captureSmallIntentJson,
  singleStagedWork,
  transactionStagedWork,
  StagedInputError,
} from "../../web/src/project/StagedProjectCommands.ts";
import { encodeProjectSessionRequest } from "../../contracts/generated/project-intents.ts";
process.env.TZ = "UTC";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root), "utf8");
const corpus = JSON.parse(
  read("testdata/cross-platform/project-captured-command-vectors.json"),
);
const nonce = [0, 1, 2147483648, 4294967295],
  input = { maxUnits: 4_000_000, maxNodes: 1_000_000, maxDepth: 128 };
const limits = { maxResources: 4, maxCommands: 100, maxUnits: 8_000_000 };
const units = (s) =>
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)),
  text = (u) => (u === null ? undefined : String.fromCharCode(...u));
const contents = [],
  traces = [];
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
function captureCommand(c, clips, assets) {
  if (c.intent)
    return captureSmallIntentJson(
      JSON.stringify({ version: 1, command: c.intent }),
      input.maxUnits,
    );
  if (c.clipboard) {
    const clip = clips.get(c.clipboard);
    return captureClipboardPasteCommand(
      clip.object,
      {
        objectId: text(c.ids.objectId),
        volumeIds: c.ids.volumeIds.map(text),
        instanceIds: c.ids.instanceIds.map(text),
        layerRangeIds: c.ids.layerRangeIds.map(text),
      },
      text(c.destination),
      assets,
      clip.assets,
      input,
    );
  }
  const record = JSON.parse(c.recordJson);
  if (c.kind === "instance")
    return captureInstanceCommand(
      text(c.objectId),
      record,
      c.index ?? undefined,
      input,
    );
  return capturePasteCommand(
    record,
    {
      objectId: text(c.ids.objectId),
      volumeIds: c.ids.volumeIds.map(text),
      instanceIds: c.ids.instanceIds.map(text),
      layerRangeIds: c.ids.layerRangeIds.map(text),
    },
    text(c.destination),
    text(c.name),
    input,
  );
}
function captureWork(w, clips, assets) {
  return w.single
    ? singleStagedWork(captureCommand(w.single, clips, assets))
    : transactionStagedWork(
        text(w.label),
        w.commands.map((c) => captureCommand(c, clips, assets)),
        input.maxUnits,
      );
}
const code = (e) =>
  e instanceof AsyncSessionError
    ? e.code === "invalid-request"
      ? "invalidRequest"
      : e.code
    : e instanceof StagedInputError && e.code === "limit"
      ? "resourceLimit"
      : "invalidRequest";
async function scenario(name, fixture, body) {
  const assets = new InMemoryAssetRepository();
  for (const p of fixture.assets ?? [fixture.asset])
    assets.put(JSON.parse(p.descriptorJson), Uint8Array.from(p.bytes));
  const session = new EditorSession({
    initialState: JSON.parse(fixture.stateJson),
    assets,
    history: fixture.options,
    serializer: {
      async serialize() {
        throw Error("unused");
      },
      async deserialize() {
        throw Error("unused");
      },
    },
  });
  const facade = new AsyncEditorSession(session),
    endpoint = new ProjectSessionEndpoint(facade, nonce, 1),
    guards = new Map(),
    resources = new Map(),
    clips = new Map(),
    effects = [],
    steps = [];
  let sequence = 0;
  const wire = (operation) =>
    encodeProjectSessionRequest({
      protocolVersion: 1,
      generation: nonce,
      requestId: ++sequence,
      operation,
    });
  const observe = () => ({
    snapshot: snapshot(session.project.getSnapshot()),
    selection: selection(session.selection.getSnapshot()),
    history: history(session.commands.getHistorySnapshot()),
    historyRevision: session.commands.getHistoryRevision(),
    assets: assets.bundleFingerprint(),
    staging: endpoint.stagingUsage(),
  });
  session.project.subscribe((c) =>
    effects.push({
      kind: "project",
      previous: snapshot(c.previous),
      current: snapshot(c.current),
      reason: units(c.reason),
      dirtyCategories: c.dirtyCategories,
    }),
  );
  session.selection.subscribe((current, previous) =>
    effects.push({
      kind: "selection",
      previous: selection(previous),
      current: selection(current),
    }),
  );
  session.commands.subscribeHistory((current, previous) =>
    effects.push({
      kind: "history",
      previous: history(previous),
      current: history(current),
    }),
  );
  const initial = observe();
  async function group(actions) {
    effects.length = 0;
    const outcomes = [],
      requests = [];
    for (const op of actions) {
      let result = null;
      try {
        if (op.kind === "configure") endpoint.configureStaging(op.limits);
        else if (op.kind === "guard")
          guards.set(op.name, facade.captureGuard());
        else if (op.kind === "copy") {
          const guard =
            op.guard === undefined
              ? facade.captureGuard()
              : guards.get(op.guard);
          if (!facade.isCurrent(guard)) throw new AsyncSessionError("stale");
          const object =
            session.project.getSnapshot().state.plates[op.plate].objects[
              op.object
            ];
          const selected = assets.captureSelection(objectAssetIds(object), {
            maxAssets: op.assets,
            maxBytes: op.bytes,
          });
          clips.set(op.name, { object, assets: selected });
          result = [
            object.volumes.length,
            object.instances.length,
            object.layerRanges.length,
            selected.descriptors.length,
            selected.byteLength,
          ];
        } else if (op.kind === "dropClipboard") clips.delete(op.name);
        else if (op.kind === "stage") {
          const guard =
            op.guard === undefined
              ? facade.captureGuard()
              : guards.get(op.guard);
          assert.ok(guard);
          const work = captureWork(op.work, clips, assets),
            id = endpoint.stage(work, guard);
          resources.set(op.name, id);
          result = { id, units: work.inputUnits, commands: work.commandCount };
        } else if (op.kind === "request") {
          requests.push(endpoint.handle(op.json));
          result = { reply: requests.length - 1 };
        } else if (op.kind === "checkpoint") session.commands.markCheckpoint();
        else if (op.kind === "selection")
          session.selection.set(
            op.refs.map((r) =>
              r.kind === "project" ? r : { ...r, id: text(r.id) },
            ),
          );
        else if (op.kind === "dispose") endpoint.dispose();
        else throw Error("unknown host action");
      } catch (e) {
        result = { error: code(e) };
      }
      outcomes.push(result);
    }
    const queued = observe().staging;
    const replies = (await Promise.all(requests)).map((r) => JSON.parse(r));
    steps.push({
      actions,
      outcomes,
      queued,
      replies,
      effects: [...effects],
      ...observe(),
    });
    return outcomes;
  }
  const request = (operation) => ({ kind: "request", json: wire(operation) });
  await body({
    group,
    request,
    resources,
    guard: () => wireSessionGuard(facade.captureGuard()),
    session,
  });
  traces.push({
    name,
    stateJson: fixture.stateJson,
    asset: fixture.asset,
    ...(fixture.assets ? { assets: fixture.assets } : {}),
    options: fixture.options,
    initial,
    steps,
  });
  endpoint.dispose();
  session.dispose();
}
const hello = {
  hello: {
    minProtocolVersion: 1,
    maxProtocolVersion: 1,
    projectSchemaVersion: 1,
    intentVersion: 1,
  },
};
for (const trace of corpus.traces)
  await scenario(
    `captured:${trace.name}`,
    trace,
    async ({ group, request, resources, guard }) => {
      await group([{ kind: "configure", limits }, request(hello)]);
      let index = 0;
      for (const step of trace.steps) {
        const op = step.operation;
        if (op.kind === "captured" || op.kind === "capturedBatch") {
          const name = `work-${index++}`;
          const work =
            op.kind === "captured"
              ? { single: op.command }
              : { commands: op.commands, label: op.label };
          const [outcome] = await group([{ kind: "stage", name, work }]);
          if (!outcome.error)
            await group([
              request({ executeStaged: { stagedId: resources.get(name) } }),
            ]);
        } else if (op.kind === "undo" || op.kind === "redo")
          await group([request({ [op.kind]: guard() })]);
        else if (op.kind === "checkpoint" || op.kind === "selection")
          await group([op]);
      }
      await group([request({ query: {} }), request({ close: {} })]);
    },
  );
const base = corpus.traces[0],
  sample = base.steps.find((s) => s.operation.kind === "captured").operation
    .command;
for (const mode of [
  "cancel",
  "close",
  "host-dispose",
  "checkpoint",
  "queued-edit",
  "selection",
  "release-ready",
  "release-queued",
  "budget-while-queued",
  "unknown-after-take",
])
  await scenario(
    `staging:${mode}`,
    base,
    async ({ group, request, resources, guard, session }) => {
      await group([
        { kind: "configure", limits: { ...limits, maxResources: 1 } },
        request(hello),
      ]);
      await group([{ kind: "stage", name: "one", work: { single: sample } }]);
      const id = resources.get("one");
      if (mode === "release-ready") {
        await group([
          request({ releaseStaged: { stagedId: id } }),
          request({ executeStaged: { stagedId: id } }),
        ]);
        return;
      }
      const edit = request({ executeStaged: { stagedId: id } }),
        target = JSON.parse(edit.json).requestId;
      if (mode === "cancel")
        await group([edit, request({ cancel: { targetRequestId: target } })]);
      if (mode === "close") await group([edit, request({ close: {} })]);
      if (mode === "host-dispose") await group([edit, { kind: "dispose" }]);
      if (mode === "checkpoint") await group([edit, { kind: "checkpoint" }]);
      if (mode === "selection")
        await group([
          edit,
          {
            kind: "selection",
            refs: [
              {
                kind: "plate",
                id: units(session.project.getSnapshot().state.activePlateId),
              },
            ],
          },
        ]);
      if (mode === "release-queued")
        await group([edit, request({ releaseStaged: { stagedId: id } })]);
      if (mode === "budget-while-queued")
        await group([
          edit,
          { kind: "stage", name: "overflow", work: { single: sample } },
          {
            kind: "configure",
            limits: { maxResources: 0, maxCommands: 0, maxUnits: 0 },
          },
        ]);
      if (mode === "unknown-after-take")
        await group([
          edit,
          request({ executeStaged: { stagedId: id } }),
          request({ cancel: { targetRequestId: target + 1 } }),
        ]);
      if (mode === "queued-edit") {
        // Keep increasing request IDs in actual dispatch order.
        const first = request({
          execute: {
            guard: guard(),
            intent: {
              version: 1,
              command: {
                renameObject: {
                  objectId: sample.objectId,
                  name: units("prior edit"),
                },
              },
            },
          },
        });
        await group([first, request({ executeStaged: { stagedId: id } })]);
      }
    },
  );
await scenario(
  "staging:preparation-guard-and-resource-boundaries",
  base,
  async ({ group, request, resources }) => {
    await group([
      request(hello),
      { kind: "stage", name: "disabled", work: { single: sample } },
    ]);
    await group([
      { kind: "configure", limits },
      { kind: "guard", name: "original" },
      { kind: "checkpoint" },
    ]);
    await group([
      {
        kind: "stage",
        name: "stale",
        guard: "original",
        work: { single: sample },
      },
    ]);
    for (const limited of [
      { ...limits, maxCommands: 0 },
      { ...limits, maxUnits: 1 },
      { ...limits, maxResources: 0 },
    ]) {
      await group([
        { kind: "configure", limits: limited },
        { kind: "stage", name: "refused", work: { single: sample } },
      ]);
    }
    await group([
      { kind: "configure", limits },
      { kind: "stage", name: "released", work: { single: sample } },
    ]);
    const id = resources.get("released");
    await group([
      request({ releaseStaged: { stagedId: id } }),
      request({ releaseStaged: { stagedId: id } }),
      request({ executeStaged: { stagedId: id } }),
    ]);
    await group([{ kind: "stage", name: "newer", work: { single: sample } }]);
    assert.ok(resources.get("newer") > id);
    await group([request({ close: {} })]);
  },
);
await scenario(
  "staging:release-at-full-queue",
  base,
  async ({ group, request, resources }) => {
    await group([{ kind: "configure", limits }, request(hello)]);
    await group([{ kind: "stage", name: "ready", work: { single: sample } }]);
    const id = resources.get("ready");
    await group([
      ...Array.from({ length: 32 }, () => request({ query: {} })),
      request({ executeStaged: { stagedId: id } }),
      request({ releaseStaged: { stagedId: id } }),
    ]);
  },
);
const clipboard = JSON.parse(
  read("testdata/cross-platform/project-clipboard-vectors.json"),
).traces[0].clipboard;
const clipboardBase = {
  stateJson: clipboard.stateJson,
  asset: clipboard.assets[0],
  assets: clipboard.assets,
  options: {},
};
const clipboardObject = JSON.parse(clipboard.stateJson).plates[0].objects[0];
const paste = (suffix = "host-copy") => ({
  clipboard: "copy",
  ids: {
    objectId: units(`import:object:${suffix}`),
    volumeIds: clipboardObject.volumes.map((_, i) =>
      units(`import:volume:${suffix}:${i}`),
    ),
    instanceIds: clipboardObject.instances.map((_, i) =>
      units(`import:instance:${suffix}:${i}`),
    ),
    layerRangeIds: clipboardObject.layerRanges.map((_, i) =>
      units(`import:range:${suffix}:${i}`),
    ),
  },
  destination: null,
});
const copy = {
  kind: "copy",
  name: "copy",
  plate: 0,
  object: 0,
  assets: 4096,
  bytes: 512 * 1024 * 1024,
};
const sortedClipboard = JSON.parse(clipboard.stateJson);
sortedClipboard.plates[0].order = 4;
sortedClipboard.plates.push({
  ...structuredClone(sortedClipboard.plates[0]),
  id: "import:plate:before",
  order: 0,
  objects: [],
});
for (const mode of [
  "roundtrip",
  "sorted-projection",
  "deleted",
  "stale",
  "replace",
  "cancel",
  "close",
  "transaction",
  "invalid-destination",
]) {
  await scenario(
    `clipboard:${mode}`,
    mode === "sorted-projection"
      ? { ...clipboardBase, stateJson: canonicalStringify(sortedClipboard) }
      : clipboardBase,
    async ({ group, request, resources, guard }) => {
      await group([
        { kind: "configure", limits },
        request(hello),
        mode === "sorted-projection" ? { ...copy, queryPlate: 1 } : copy,
      ]);
      const edit = async (command) =>
        group([
          request({
            execute: { guard: guard(), intent: { version: 1, command } },
          }),
        ]);
      if (mode === "deleted")
        await edit({ deleteObject: { objectId: units(clipboardObject.id) } });
      if (mode === "replace")
        await edit({
          renameObject: {
            objectId: units(clipboardObject.id),
            name: units("Newer clipboard"),
          },
        });
      if (mode === "stale") {
        await group([{ kind: "guard", name: "old" }, { kind: "checkpoint" }]);
        await group([
          { ...copy, guard: "old" },
          {
            kind: "stage",
            name: "stale",
            guard: "old",
            work: { single: paste() },
          },
        ]);
      }
      const command = paste();
      if (mode === "invalid-destination")
        command.destination = units("import:plate:missing");
      if (mode === "transaction") {
        await group([
          {
            kind: "stage",
            name: "failed",
            work: {
              commands: [paste("collision"), paste("collision")],
              label: units("Rollback clipboard"),
            },
          },
        ]);
        await group([
          request({ executeStaged: { stagedId: resources.get("failed") } }),
        ]);
      }
      await group([
        {
          kind: "stage",
          name: "ready",
          work:
            mode === "transaction"
              ? {
                  commands: [paste("first"), paste("second")],
                  label: units("Two pasted objects 😀\ud800"),
                }
              : { single: command },
        },
      ]);
      if (mode === "replace") await group([copy]);
      await group([{ kind: "dropClipboard", name: "copy" }]);
      const execute = request({
        executeStaged: { stagedId: resources.get("ready") },
      });
      if (mode === "cancel") {
        await group([
          execute,
          request({
            cancel: { targetRequestId: JSON.parse(execute.json).requestId },
          }),
        ]);
        return;
      }
      if (mode === "close") {
        await group([execute, request({ close: {} })]);
        return;
      }
      await group([execute]);
      await group([request({ undo: guard() })]);
      await group([request({ redo: guard() })]);
      await group([request({ query: {} }), request({ close: {} })]);
    },
  );
}
const sources = [
  "tools/cross-platform/project-staged-session-vectors.mjs",
  "testdata/cross-platform/project-captured-command-vectors.json",
  "testdata/cross-platform/project-clipboard-vectors.json",
  "web/src/project/StagedProjectCommands.ts",
  "web/src/project/ProjectSessionEndpoint.ts",
  "web/src/project/AsyncEditorSession.ts",
  "web/src/project/ProjectSessionClient.ts",
  "web/src/project/session.ts",
  "web/src/project/PreparedProjectCommands.ts",
  "web/src/project/objects/commands.ts",
  "web/src/project/history/commandBus.ts",
  "web/src/project/store.ts",
  "web/src/project/selection.ts",
  "web/src/project/assets.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/validation.ts",
  "contracts/project-intents.json",
  "contracts/generated/project-intents.ts",
  "contracts/runtime/project-intents.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      generation: nonce,
      inputLimits: input,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      contents,
      traces,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/project-staged-session-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Staged session reference drift",
  );
console.log(
  `Staged session references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} groups, ${traces.reduce((n, t) => n + t.steps.reduce((s, g) => s + g.replies.length, 0), 0)} requests, ${contents.length} contents`,
);
