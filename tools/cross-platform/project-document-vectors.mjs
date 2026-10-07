// Controlled deserialization executes the production EditorSession.open/reset
// boundary. No native result supplies expected graph, history or lifecycle data.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  EditorSession,
  StaleProjectResultError,
} from "../../web/src/project/session.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { prepareProjectIntent } from "../../web/src/project/PreparedProjectCommands.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root), "utf8");
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const source = JSON.parse(
  read("testdata/cross-platform/project-clipboard-vectors.json"),
).traces[0].clipboard;
const changed = JSON.parse(source.stateJson);
changed.id = "import:project:replacement";
changed.name = "Replacement 😀\ud800";
const empty = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
).factories[0];
const documents = [
  source,
  { ...source, stateJson: canonicalStringify(changed) },
  { stateJson: empty.stateJson, assets: [] },
];
const contents = [],
  traces = [];
const snapshot = (s) => {
  const json = canonicalStringify(s.state);
  let content = contents.indexOf(json);
  if (content < 0) {
    content = contents.length;
    contents.push(json);
  }
  return { revision: s.revision, hash: s.hash, content };
};
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
const materialize = (index) => {
  const doc = documents[index];
  return {
    state: JSON.parse(doc.stateJson),
    assets: doc.assets.map((a) => ({
      descriptor: JSON.parse(a.descriptorJson),
      bytes: Uint8Array.from(a.bytes),
    })),
    warnings: [],
  };
};
const scenarios = [
  [
    "clean-open",
    [
      { kind: "begin", name: "a" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "dirty-open",
    [
      { kind: "edit" },
      { kind: "select" },
      { kind: "begin", name: "a" },
      { kind: "finish", name: "a", document: 1 },
      { kind: "undo" },
    ],
  ],
  [
    "history-only",
    [
      { kind: "edit" },
      { kind: "begin", name: "a" },
      { kind: "checkpoint" },
      { kind: "finish", name: "a", document: 2 },
    ],
  ],
  [
    "selection-only",
    [
      { kind: "begin", name: "a" },
      { kind: "select" },
      { kind: "finish", name: "a", document: 0 },
    ],
  ],
  [
    "source-edited",
    [
      { kind: "begin", name: "a" },
      { kind: "edit" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "source-undone",
    [
      { kind: "begin", name: "a" },
      { kind: "edit" },
      { kind: "undo" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "newer-open",
    [
      { kind: "begin", name: "a" },
      { kind: "begin", name: "b" },
      { kind: "finish", name: "b", document: 1 },
      { kind: "finish", name: "a", document: 2 },
    ],
  ],
  [
    "failed-newer",
    [
      { kind: "begin", name: "a" },
      { kind: "begin", name: "b" },
      { kind: "fail", name: "b" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "older-fails",
    [
      { kind: "begin", name: "a" },
      { kind: "begin", name: "b" },
      { kind: "fail", name: "a" },
      { kind: "finish", name: "b", document: 1 },
    ],
  ],
  [
    "cancel-newer",
    [
      { kind: "begin", name: "a" },
      { kind: "begin", name: "b" },
      { kind: "cancel", name: "b" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "reset-open",
    [
      { kind: "begin", name: "a" },
      { kind: "reset", document: 1 },
      { kind: "finish", name: "a", document: 2 },
    ],
  ],
  [
    "equal-reset",
    [
      { kind: "edit" },
      { kind: "undo" },
      { kind: "select" },
      { kind: "begin", name: "a" },
      { kind: "reset", document: 0 },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "empty-reset",
    [
      { kind: "edit" },
      { kind: "reset", document: 2 },
      { kind: "undo" },
      { kind: "reset", document: 0 },
    ],
  ],
  [
    "dispose-open",
    [
      { kind: "begin", name: "a" },
      { kind: "dispose" },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
  [
    "invalid-open-bundle",
    [
      { kind: "edit" },
      { kind: "begin", name: "a" },
      { kind: "finishInvalid", name: "a", document: 1 },
    ],
  ],
  [
    "invalid-reset-preserves-open",
    [
      { kind: "begin", name: "a" },
      { kind: "resetInvalid", document: 1 },
      { kind: "finish", name: "a", document: 1 },
    ],
  ],
];
for (const [name, actions] of scenarios) {
  const base = materialize(0),
    assets = new InMemoryAssetRepository();
  assets.restore({ entries: base.assets });
  const opens = new Map();
  let active;
  const s = new EditorSession({
    initialState: base.state,
    assets,
    serializer: {
      async serialize() {
        throw Error("unused");
      },
      deserialize(_bytes, cancellation) {
        return new Promise((resolve, reject) =>
          Object.assign(active, { resolve, reject, cancellation }),
        );
      },
    },
  });
  const effects = [],
    steps = [];
  s.project.subscribe((c) =>
    effects.push({
      kind: "project",
      previous: snapshot(c.previous),
      current: snapshot(c.current),
      reason: units(c.reason),
      dirtyCategories: c.dirtyCategories,
    }),
  );
  s.selection.subscribe((current, previous) =>
    effects.push({
      kind: "selection",
      previous: selection(previous),
      current: selection(current),
    }),
  );
  s.commands.subscribeHistory((current, previous) =>
    effects.push({
      kind: "history",
      previous: history(previous),
      current: history(current),
    }),
  );
  const observe = () => ({
    snapshot: snapshot(s.project.getSnapshot()),
    selection: selection(s.selection.getSnapshot()),
    history: history(s.commands.getHistorySnapshot()),
    historyRevision: s.commands.getHistoryRevision(),
    assets: assets.bundleFingerprint(),
    opens: [...opens].map(([name, o]) => [name, !o.cancellation.aborted]),
  });
  const initial = observe();
  for (const action of actions) {
    effects.length = 0;
    let outcome = null;
    const o = opens.get(action.name);
    if (action.kind === "begin") {
      active = { aborted: false };
      const target = active;
      target.promise = s.open(new Uint8Array(), target).then(
        () => "opened",
        (e) => {
          if (e instanceof StaleProjectResultError) return "stale";
          if (e.message === "EditorSession is disposed") return "disposed";
          if (target.aborted) return "cancelled";
          return "failed";
        },
      );
      opens.set(action.name, target);
    } else if (action.kind === "finish" || action.kind === "finishInvalid") {
      const doc = materialize(action.document);
      if (action.kind === "finishInvalid") doc.assets = [];
      o.resolve(doc);
      outcome = await o.promise;
    } else if (action.kind === "fail" || action.kind === "cancel") {
      o.aborted = action.kind === "cancel";
      o.reject(Error("Preparation failed"));
      outcome = await o.promise;
    } else if (action.kind === "reset" || action.kind === "resetInvalid") {
      const doc = materialize(action.document);
      try {
        s.reset(doc.state, {
          entries: action.kind === "resetInvalid" ? [] : doc.assets,
        });
        outcome = "reset";
      } catch {
        outcome = "failed";
      }
    } else if (action.kind === "edit") {
      action.intent = {
        version: 1,
        command: {
          renamePlate: {
            plateId: units(s.project.getSnapshot().state.activePlateId),
            name: units("Changed plate"),
          },
        },
      };
      s.commands.execute(prepareProjectIntent(action.intent));
    } else if (action.kind === "select") s.selection.set([{ kind: "project" }]);
    else if (action.kind === "checkpoint") s.commands.markCheckpoint();
    else if (action.kind === "undo") s.commands.undo();
    else if (action.kind === "dispose") s.dispose();
    else throw Error("Unknown action");
    steps.push({ action, outcome, effects: [...effects], ...observe() });
  }
  traces.push({ name, initial, steps });
  s.dispose();
}
const sources = [
  "tools/cross-platform/project-document-vectors.mjs",
  "web/src/project/session.ts",
  "web/src/project/assets.ts",
  "web/src/project/history/commandBus.ts",
  "testdata/cross-platform/project-clipboard-vectors.json",
  "testdata/cross-platform/project-model-vectors.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: Object.fromEntries(
        sources.map((p) => [
          p,
          createHash("sha256").update(read(p)).digest("hex"),
        ]),
      ),
      documents,
      contents,
      traces,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/project-document-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Document lifecycle references drifted",
  );
console.log(
  `Document references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} contents`,
);
