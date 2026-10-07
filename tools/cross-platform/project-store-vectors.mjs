// Independent store/selection traces execute the production TypeScript owners.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../web/src/project/store.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
import { ProjectValidationError } from "../../web/src/project/domain/validation.ts";
process.env.TZ = "UTC";
const root = new URL("../../", import.meta.url);
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const read = (p) => readFileSync(new URL(p, root), "utf8");
const initial = createProjectFixture().state;
const states = [];
function state(name, mutate = () => {}) {
  const next = cloneJson(initial);
  mutate(next);
  states.push({ name, value: next });
  return states.length - 1;
}
const base = state("base");
const renamed = state("utf16-name", (s) => {
  s.name = "PRIVATE_STORE_TEXT\0\ud800\udfff";
});
const noObjects = state("no-objects", (s) => {
  for (const p of s.plates) p.objects = [];
});
const emptyName = state("invalid-name", (s) => {
  s.name = "";
});
const missingPlate = state("invalid-active-plate", (s) => {
  s.activePlateId = "import:missing:plate";
});
const positiveZero = state("positive-zero", (s) => {
  s.extensionData = {
    zero: 0,
    values: [null, true, false, 5e-324, 1.7976931348623157e308],
  };
});
const negativeZero = state("negative-zero", (s) => {
  s.extensionData = {
    values: [null, true, false, 5e-324, 1.7976931348623157e308],
    zero: -0,
  };
});
const foreignMetadata = state("foreign-metadata", (s) => {
  s.extensionData = JSON.parse(
    '{"__proto__":{"private":"\\ud800"},"2":2,"10":10,"null":null}',
  );
});
const changedMetadata = state("changed-foreign-metadata", (s) => {
  s.extensionData = JSON.parse(
    '{"__proto__":{"private":"\\ud801"},"2":2,"10":10,"null":null}',
  );
});
const changedTimestamp = state("changed-timestamp", (s) => {
  s.updatedAt = "2030-01-01T00:00:00Z";
});
const changedOwner = state("changed-project-id", (s) => {
  s.id = "import:another:project";
});
const disabled = state("disabled-filaments", (s) => {
  for (const f of [...s.filaments.physical, ...s.filaments.mixed])
    f.enabled = false;
});
const project = new ProjectStore(initial);
const selection = new SelectionStore();
const saved = new Map(),
  identities = new Map(),
  contents = [];
function snapshot(s) {
  if (!identities.has(s.state)) identities.set(s.state, identities.size + 1);
  const text = canonicalStringify(s.state);
  let content = contents.indexOf(text);
  if (content === -1) {
    content = contents.length;
    contents.push(text);
  }
  return {
    revision: s.revision,
    hash: s.hash,
    identity: identities.get(s.state),
    content,
  };
}
const ref = (r) =>
  r.kind === "project" ? r : { kind: r.kind, id: units(r.id) };
const refs = (s) => ({
  refs: s.refs.map(ref),
  primary: s.primary ? ref(s.primary) : null,
});
const effects = [];
// Reference observers may fail, but publication and subsequent delivery survive.
project.subscribe(() => {
  throw new Error("PRIVATE_OBSERVER_FAILURE");
});
project.subscribe((c) =>
  effects.push({
    kind: "project",
    previous: snapshot(c.previous),
    current: snapshot(c.current),
    reason: units(c.reason),
    dirtyCategories: c.dirtyCategories,
  }),
);
selection.subscribe(() => {
  throw new Error("PRIVATE_OBSERVER_FAILURE");
});
selection.subscribe((current, previous) =>
  effects.push({
    kind: "selection",
    previous: refs(previous),
    current: refs(current),
  }),
);
const initialSnapshot = snapshot(project.getSnapshot());
const steps = [];
function run(operation) {
  effects.length = 0;
  let result = null,
    error = null;
  try {
    switch (operation.kind) {
      case "capture":
        saved.set(operation.name, {
          project: project.getSnapshot(),
          selection: selection.getSnapshot(),
        });
        break;
      case "replace":
        project.replaceState(states[operation.state].value, operation.options);
        break;
      case "frozen":
        project.replaceState(
          saved.get(operation.name).project.state,
          operation.options,
        );
        break;
      case "restore":
        project.restoreState(
          saved.get(operation.name).project.state,
          operation.reason,
        );
        break;
      case "same":
        result = project.hasSameContent(states[operation.state].value);
        break;
      case "guard": {
        const guard = { ...saved.get(operation.name).project };
        if (operation.wrongRevision) guard.revision += 1;
        if (operation.wrongHash) guard.hash = "fnv1a64:0000000000000000";
        result = project.isCurrent(guard);
        break;
      }
      case "foreignGuard":
        result = project.isCurrent(
          new ProjectStore(project.getSnapshot().state).getSnapshot(),
        );
        break;
      case "set":
        selection.set(operation.refs, operation.primary);
        break;
      case "add":
        selection.add(operation.ref, operation.makePrimary);
        break;
      case "toggle":
        selection.toggle(operation.ref);
        break;
      case "clear":
        selection.clear();
        break;
      case "prune":
        selection.prune(project.getSnapshot().state);
        break;
      case "restoreSelection":
        selection.restore(saved.get(operation.name).selection);
        break;
      default:
        throw new Error("unknown fixture operation");
    }
  } catch (e) {
    if (e instanceof ProjectValidationError)
      error = {
        kind: "invalidProject",
        message: units(e.message),
        issues: e.issues.map((i) => ({
          ...i,
          path: units(i.path),
          message: units(i.message),
        })),
      };
    else if (
      e.message === "Primary selection must be part of the selection set"
    )
      error = { kind: "invalidPrimary" };
    else throw e;
  }
  const wire = cloneJson(operation);
  if (wire.options?.reason !== undefined)
    wire.options.reason = units(wire.options.reason);
  if (wire.reason !== undefined) wire.reason = units(wire.reason);
  if (wire.refs) wire.refs = wire.refs.map(ref);
  if (wire.ref) wire.ref = ref(wire.ref);
  if (wire.primary) wire.primary = ref(wire.primary);
  steps.push({
    operation: wire,
    result,
    error,
    effects: cloneJson(effects),
    snapshot: snapshot(project.getSnapshot()),
    selection: refs(selection.getSnapshot()),
  });
}
const plate = initial.plates[0],
  object = plate.objects[0];
const allRefs = [
  { kind: "project" },
  { kind: "plate", id: plate.id },
  { kind: "object", id: object.id },
  { kind: "volume", id: object.volumes[0].id },
  { kind: "instance", id: object.instances[0].id },
  { kind: "layer-range", id: object.layerRanges[0].id },
  ...initial.filaments.physical.map((f) => ({ kind: "filament", id: f.id })),
  ...initial.filaments.mixed.map((f) => ({ kind: "filament", id: f.id })),
  { kind: "object", id: "import:private:\0\ud800" },
  { kind: "plate", id: object.id }, // Same ID text does not erase entity kind.
];
run({ kind: "capture", name: "root" });
run({ kind: "foreignGuard" });
run({ kind: "same", state: base });
run({ kind: "replace", state: base });
run({ kind: "guard", name: "root" });
run({ kind: "capture", name: "equal" });
run({
  kind: "frozen",
  name: "equal",
  options: { reason: "", dirtyCategories: [] },
});
for (const bad of [emptyName, missingPlate])
  run({ kind: "replace", state: bad });
run({
  kind: "replace",
  state: renamed,
  options: {
    reason: "PRIVATE_REASON\0\ud800",
    dirtyCategories: ["printerDevice", "presets", "projectData", "presets"],
  },
});
run({ kind: "capture", name: "renamed" });
run({ kind: "guard", name: "renamed" });
run({ kind: "guard", name: "renamed", wrongRevision: true });
run({ kind: "guard", name: "renamed", wrongHash: true });
run({ kind: "foreignGuard" });
run({ kind: "restore", name: "root" });
run({ kind: "guard", name: "root" });
run({ kind: "same", state: changedTimestamp });
run({ kind: "same", state: changedOwner });
for (const value of [
  positiveZero,
  foreignMetadata,
  changedMetadata,
  changedTimestamp,
  changedOwner,
  base,
]) {
  run({ kind: "replace", state: value });
  for (const other of [
    value,
    negativeZero,
    foreignMetadata,
    changedMetadata,
    base,
  ])
    run({ kind: "same", state: other });
}
run({ kind: "add", ref: allRefs[2], makePrimary: false });
run({ kind: "capture", name: "without-primary" });
run({ kind: "restoreSelection", name: "without-primary" });
run({
  kind: "set",
  refs: [allRefs[1], allRefs[1], allRefs[2]],
  primary: allRefs[1],
});
run({ kind: "set", refs: [allRefs[1]], primary: allRefs[2] });
run({ kind: "set", refs: [], primary: allRefs[0] });
run({ kind: "set", refs: allRefs });
run({ kind: "capture", name: "all" });
run({ kind: "prune" });
run({ kind: "replace", state: noObjects });
run({ kind: "prune" });
run({ kind: "restoreSelection", name: "all" });
run({ kind: "replace", state: disabled });
run({ kind: "prune" });
run({ kind: "clear" });
run({ kind: "clear" });
let random = 0x19b9c37f;
const rand = () => {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  return random >>> 0;
};
for (let i = 0; i < 240; i++) {
  const pick = () => allRefs[rand() % allRefs.length];
  switch (rand() % 8) {
    case 0:
      run({ kind: "set", refs: Array.from({ length: rand() % 8 }, pick) });
      break;
    case 1:
      run({ kind: "set", refs: [pick(), pick()], primary: pick() });
      break;
    case 2:
      run({ kind: "add", ref: pick(), makePrimary: Boolean(rand() & 1) });
      break;
    case 3:
      run({ kind: "toggle", ref: pick() });
      break;
    case 4:
      run({ kind: "prune" });
      break;
    case 5:
      run({
        kind: "replace",
        state: [base, noObjects, renamed, emptyName][rand() % 4],
      });
      break;
    case 6:
      run({
        kind: "restore",
        name: ["root", "renamed"][rand() % 2],
        reason: "trace-rollback",
      });
      break;
    case 7:
      run({
        kind: "restoreSelection",
        name: ["all", "without-primary"][rand() % 2],
      });
      break;
  }
}
const sources = [
  "tools/cross-platform/project-store-vectors.mjs",
  "web/src/project/store.ts",
  "web/src/project/selection.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/ids.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/domain/facetRefinement.ts",
  "web/src/project/__tests__/fixtures.ts",
  "contracts/project-intents.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      states: states.map((s) => ({
        name: s.name,
        stateJson: canonicalStringify(s.value),
      })),
      contents,
      initial: initialSnapshot,
      steps,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/project-store-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Project store/selection reference drift",
  );
console.log(
  `Project store/selection references: ${steps.length} steps, ${states.length} candidates, ${contents.length} retained contents`,
);
