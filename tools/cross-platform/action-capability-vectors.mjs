// Action availability references from the production registry
// (`ActionRegistry.availability`, `forSurface`, `forContext`): every action on
// every surface over a corpus of workspace states — the initial state,
// representative workflows, every startup phase of every feature, and seeded
// combinations of every field a rule reads. Replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildRegistry } from "../../web/src/actions/catalog.ts";
import { INITIAL_UI_STATE } from "../../web/src/actions/UiState.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

const registry = buildRegistry();
const actions = registry.allSource();
const SURFACES = [
  "dom-scene",
  "xr-scene",
  "dom-primary",
  "dom-toolbar",
  "dom-menu",
  "dom-inspector",
  "dom-context",
  "command-palette",
  "keyboard",
  "xr-primary",
  "xr-toolbar",
  "xr-menu",
  "xr-inspector",
  "xr-context",
  "automation",
];
for (const a of actions)
  for (const s of a.capability.surfaces) assert.ok(SURFACES.includes(s), s);

// Every application feature, as `ApplicationInitialization` defines them.
const FEATURES = [
  ["workspace", "Workspace"],
  ["shell", "Application controls"],
  ["profiles", "Printer profiles"],
  ["settings", "Settings schema"],
  ["camera", "Camera"],
  ["ai", "AI integration"],
  ["printer", "Printer connection"],
  ["xr", "Immersive XR"],
];
const initialization = (phases, boot = "loading") => ({
  phase: boot,
  features: FEATURES.map(([id, label], i) => ({
    id,
    label,
    core: i < 4,
    phase: phases[id] ?? "ready",
    reason:
      (phases[id] ?? "ready") === "failed"
        ? `${label} could not start — réseau indisponible 🛰.`
        : "",
  })),
});

const states = [["initial", INITIAL_UI_STATE]];
const state = (name, patch) =>
  states.push([name, { ...INITIAL_UI_STATE, ...patch }]);
state("one-model", {
  modelCount: 1,
  hasSelection: true,
  hasInstanceSelection: true,
  dirty: true,
  canUndo: true,
});
state("two-models", {
  modelCount: 2,
  plateCount: 2,
  hasSelection: true,
  canUndo: true,
  canRedo: true,
});
state("slicing", { modelCount: 3, isSlicing: true, progress: 40 });
state("sliced", { modelCount: 1, gcodeReady: true, mode: "preview" });
state("preview-empty", { mode: "preview" });
state("preflight-blocked", { modelCount: 1, preflightBlocked: true });
state("projection-failed", {
  modelCount: 1,
  projectionHealthy: false,
  dirty: true,
});
state("clipboard", { hasClipboard: true });
state("simplify", {
  modelCount: 1,
  hasSelection: true,
  hasInstanceSelection: true,
  simplifyPreviewing: true,
});
state("calibration", { modelCount: 1, calibrationSessionOpen: true });
for (const job of [
  "standby",
  "printing",
  "paused",
  "complete",
  "cancelled",
  "error",
  "unknown",
])
  state(`printer-${job}`, {
    modelCount: 1,
    gcodeReady: true,
    printerJobState: job,
  });
state("optional-flags-absent", {
  modelCount: 1,
  simplifyPreviewing: undefined,
  calibrationSessionOpen: undefined,
});
const busy = {
  modelCount: 2,
  hasSelection: true,
  hasInstanceSelection: true,
  gcodeReady: true,
  canUndo: true,
};
state("startup-ready", {
  ...busy,
  initialization: initialization({}, "ready"),
});
for (const [id] of FEATURES)
  for (const phase of ["idle", "loading", "failed"])
    state(`startup-${id}-${phase}`, {
      ...busy,
      initialization: initialization({ [id]: phase }),
    });
state("startup-order", {
  ...busy,
  initialization: initialization(
    { settings: "failed", shell: "loading", profiles: "failed" },
    "degraded",
  ),
});
state("startup-empty", {
  ...busy,
  initialization: { phase: "failed", features: [] },
});

// Seeded combinations of every field a rule reads.
let seed = 0x5eed;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];
const flag = () => random() < 0.5;
for (let i = 0; i < 64; i += 1)
  state(`seeded-${i}`, {
    mode: pick(["prepare", "preview"]),
    modelCount: pick([0, 1, 2, 3, 17]),
    plateCount: pick([1, 1, 2, 5]),
    hasSelection: flag(),
    simplifyPreviewing: pick([true, false, undefined]),
    calibrationSessionOpen: pick([true, false, undefined]),
    hasInstanceSelection: flag(),
    canUndo: flag(),
    canRedo: flag(),
    dirty: flag(),
    projectionHealthy: random() < 0.8,
    hasClipboard: flag(),
    isSlicing: random() < 0.3,
    gcodeReady: flag(),
    preflightBlocked: random() < 0.3,
    printerJobState: pick([
      "disconnected",
      "standby",
      "printing",
      "paused",
      "complete",
      "cancelled",
      "error",
      "unknown",
    ]),
    ...(random() < 0.3
      ? {
          initialization: initialization(
            Object.fromEntries(
              FEATURES.map(([id]) => [
                id,
                pick(["ready", "ready", "ready", "loading", "failed", "idle"]),
              ]),
            ),
            pick(["loading", "ready", "degraded", "failed"]),
          ),
        }
      : {}),
  });

// Availability as `e` (enabled) or `d<reason>` / `h<reason>`, reasons interned.
const reasons = [];
const reasonIndex = new Map();
const intern = (text) => {
  if (!reasonIndex.has(text)) {
    reasonIndex.set(text, reasons.length);
    reasons.push(text);
  }
  return reasonIndex.get(text);
};
const cases = states.map(([name, ui]) => ({
  name,
  stateJson: JSON.stringify(ui),
  availability: Object.fromEntries(
    SURFACES.map((surface) => [
      surface,
      actions
        .map((action) => {
          const a = registry.availability(action, surface, ui);
          if (a.state === "enabled") {
            assert.equal(a.reason, undefined);
            return "e";
          }
          return `${a.state[0]}${intern(a.reason)}`;
        })
        .join(" "),
    ]),
  ),
}));
assert.deepEqual(
  registry.availability("not_an_action", "dom-menu", INITIAL_UI_STATE),
  {
    state: "hidden",
    reason: "Unknown action.",
  },
);

// Paths no catalog action takes today, through the registry itself: a
// visibility rule that hides, and a disabling status declared without a reason.
const probe = registry.get("edit_undo");
assert.ok(probe.capability.surfaces.includes("dom-menu"));
const hidden = registry.availability(
  { ...probe, isVisible: (s) => s.hasSelection },
  "dom-menu",
  INITIAL_UI_STATE,
);
assert.equal(hidden.state, "hidden");
const blocked = registry.availability(
  {
    ...probe,
    capability: { ...probe.capability, status: "blocked", reason: undefined },
  },
  "dom-menu",
  INITIAL_UI_STATE,
);
assert.equal(blocked.state, "disabled");
const syntheticReasons = {
  notApplicable: hidden.reason,
  unavailable: blocked.reason,
};

const ids = actions.map((a) => a.id);
const indices = (list) => list.map((a) => ids.indexOf(a.id));
const sources = [
  "tools/cross-platform/action-capability-vectors.mjs",
  "web/src/actions/ActionRegistry.ts",
  "web/src/actions/UiState.ts",
  "web/src/startup/InitializationPolicy.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      actions: ids,
      surfaces: SURFACES,
      forSurface: Object.fromEntries(
        SURFACES.map((s) => [s, indices(registry.forSurface(s))]),
      ),
      forContext: Object.fromEntries(
        ["dom-context", "xr-context"].flatMap((surface) =>
          ["object", "plate"].map((target) => [
            `${surface}:${target}`,
            indices(registry.forContext(target, surface)),
          ]),
        ),
      ),
      reasons,
      syntheticReasons,
      cases,
    },
    null,
    1,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/action-capability-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Action capability reference drift",
  );
console.log(
  `action capabilities: ${ids.length} actions, ${cases.length} states, ${reasons.length} reasons`,
);
