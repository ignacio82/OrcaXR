// The capability projection's references from the production browser: the
// registry facts the canonical session decides at every session trace step
// (`canonicalUiFacts`), and capability pages answered over real TypeScript
// sessions opened from each distinct trace state — as opened, with a
// selection, and after an acknowledged edit — in the shared contract's
// encoding. Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import { AsyncEditorSession } from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { buildRegistry } from "../../web/src/actions/catalog.ts";
import { INITIAL_UI_STATE } from "../../web/src/actions/UiState.ts";
import { canonicalUiFacts } from "../../web/src/actions/canonicalUiFacts.ts";
import {
  encodeProjectCapabilityPage,
  encodeProjectCapabilityRequest,
  encodeProjectSessionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const sessions = JSON.parse(
  read("testdata/cross-platform/project-session-vectors.json"),
);
const registry = buildRegistry();
const factList = (f) => [
  f.modelCount,
  f.plateCount,
  f.hasSelection,
  f.hasInstanceSelection,
  f.canUndo,
  f.canRedo,
  f.dirty,
];

// The facts every session trace step decides, from its recorded state.
const text = (u) => String.fromCharCode(...u);
const selectionOf = (s) => ({
  refs: s.refs.map((r) =>
    r.kind === "project" ? r : { ...r, id: text(r.id) },
  ),
  ...(s.primary
    ? {
        primary:
          s.primary.kind === "project"
            ? s.primary
            : { ...s.primary, id: text(s.primary.id) },
      }
    : {}),
});
const traces = sessions.traces.map((trace) => ({
  name: trace.name,
  facts: [trace.initial, ...trace.steps].map((step) =>
    factList(
      canonicalUiFacts(
        JSON.parse(sessions.contents[step.snapshot.content]),
        selectionOf(step.selection),
        step.history,
      ),
    ),
  ),
}));

// Host facts a shell owns, in the registry's shape.
const FEATURES = [
  ["workspace", "Workspace"],
  ["shell", "Application controls"],
  ["profiles", "Printer profiles"],
  ["settings", "Settings schema"],
  ["printer", "Printer connection"],
];
const startup = (phases, boot) => ({
  phase: boot,
  features: FEATURES.map(([id, label]) => ({
    id,
    label,
    phase: phases[id] ?? "ready",
    reason:
      (phases[id] ?? "ready") === "failed" ? `${label} — délai dépassé 🛰.` : "",
  })),
});
const HOSTS = [
  { mode: "prepare", projectionHealthy: true, printerJobState: "disconnected" },
  {
    mode: "preview",
    projectionHealthy: true,
    gcodeReady: true,
    hasClipboard: true,
    printerJobState: "printing",
  },
  {
    mode: "prepare",
    projectionHealthy: true,
    isSlicing: true,
    preflightBlocked: true,
    simplifyPreviewing: true,
    calibrationSessionOpen: true,
    printerJobState: "paused",
  },
  {
    mode: "prepare",
    projectionHealthy: true,
    printerJobState: "standby",
    initialization: startup({ shell: "loading", settings: "idle" }, "loading"),
  },
  {
    mode: "preview",
    projectionHealthy: false,
    gcodeReady: true,
    printerJobState: "error",
    initialization: startup({ profiles: "failed" }, "degraded"),
  },
];
const flags = [
  "simplifyPreviewing",
  "calibrationSessionOpen",
  "projectionHealthy",
  "hasClipboard",
  "isSlicing",
  "gcodeReady",
  "preflightBlocked",
];
const wireHost = (h) => ({
  initialization: h.initialization
    ? {
        value: {
          phase: h.initialization.phase,
          features: h.initialization.features.map((f) => ({
            id: units(f.id),
            label: units(f.label),
            phase: f.phase,
            reason: units(f.reason),
          })),
        },
      }
    : { absent: {} },
  mode: h.mode,
  ...Object.fromEntries(flags.map((k) => [k, h[k] === true])),
  printerJobState: h.printerJobState,
});
const uiHost = (h) => ({
  ...INITIAL_UI_STATE,
  ...(h.initialization ? { initialization: h.initialization } : {}),
  mode: h.mode,
  ...Object.fromEntries(flags.map((k) => [k, h[k] === true])),
  printerJobState: h.printerJobState,
});
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
const NAMED = [
  "edit_undo",
  "edit_redo",
  "edit_delete_selected",
  "slice_active_plate",
  "not_an_action",
  "printer_pause",
  "help_search",
];

// `ActionRegistry.availability` as the contract's `ActionAvailability`.
const wireAvailability = (a) =>
  a.state === "enabled"
    ? { enabled: {} }
    : {
        [a.state]: {
          code: camel(a.code),
          prerequisite: a.prerequisite
            ? { value: camel(a.prerequisite) }
            : { absent: {} },
          text: units(a.reason),
        },
      };
function answer(session, history, request, host) {
  const snapshot = session.project.getSnapshot();
  const facts = canonicalUiFacts(
    snapshot.state,
    session.selection.getSnapshot(),
    session.commands.getHistorySnapshot(),
  );
  const ui = { ...uiHost(host), ...facts };
  const surface = request.surface;
  const entry = (action) => ({
    id: units(action.id),
    label: units(action.label),
    availability: wireAvailability(registry.availability(action, surface, ui)),
  });
  let total, actions;
  if (request.query.kind === "actions") {
    actions = request.query.ids.map((id) => {
      const action = registry.get(id);
      return action
        ? entry(action)
        : {
            id: units(id),
            label: [],
            availability: wireAvailability(
              registry.availability(id, surface, ui),
            ),
          };
    });
    total = actions.length;
  } else {
    const listed =
      request.query.kind === "page"
        ? registry.forSurface(surface)
        : registry.forContext(request.query.target, surface);
    total = listed.length;
    actions = listed
      .slice(request.query.start, request.query.start + request.query.count)
      .map(entry);
  }
  return encodeProjectCapabilityPage({
    sourceRevision: snapshot.revision,
    historyRevision: history(),
    facts: Object.fromEntries(
      [
        "modelCount",
        "plateCount",
        "hasSelection",
        "hasInstanceSelection",
        "canUndo",
        "canRedo",
        "dirty",
      ].map((k) => [k, facts[k]]),
    ),
    total,
    actions,
  });
}
const wireRequest = (request, host) =>
  encodeProjectCapabilityRequest({
    surface: camel(request.surface),
    host: wireHost(host),
    query:
      request.query.kind === "page"
        ? { page: { start: request.query.start, count: request.query.count } }
        : request.query.kind === "context"
          ? {
              context: {
                target: request.query.target,
                start: request.query.start,
                count: request.query.count,
              },
            }
          : { actions: { ids: request.query.ids.map(units) } },
  });

// Every distinct trace state, opened as a real session.
const nonce = sessions.generation;
const distinct = [];
for (const trace of sessions.traces)
  if (!distinct.some((d) => d.stateJson === trace.stateJson))
    distinct.push(trace);
let rotation = 0;
const states = [];
for (const fixture of distinct) {
  const assets = new InMemoryAssetRepository();
  assets.put(
    JSON.parse(fixture.asset.descriptorJson),
    Uint8Array.from(fixture.asset.bytes),
  );
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
  const facade = new AsyncEditorSession(session);
  const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
  const history = () => session.commands.getHistoryRevision();
  const queries = () => {
    const out = [];
    const ask = (request) => {
      const host = HOSTS[rotation % HOSTS.length];
      rotation += 1;
      out.push({
        requestJson: wireRequest(request, host),
        replyJson: answer(session, history, request, host),
      });
    };
    const surface = SURFACES[rotation % SURFACES.length];
    ask({ surface, query: { kind: "page", start: 0, count: 64 } });
    ask({
      surface: "command-palette",
      query: { kind: "page", start: 60 + (rotation % 120), count: 12 },
    });
    ask({
      surface: rotation % 2 ? "xr-context" : "dom-context",
      query: { kind: "context", target: "object", start: 0, count: 8 },
    });
    ask({
      surface: "dom-context",
      query: { kind: "context", target: "plate", start: 2, count: 8 },
    });
    ask({
      surface: SURFACES[(rotation * 7) % SURFACES.length],
      query: { kind: "actions", ids: NAMED },
    });
    ask({
      surface: "automation",
      query: { kind: "page", start: 9999, count: 0 },
    });
    return out;
  };
  const phases = [{ name: "opened", queries: queries() }];

  // A selection: the active plate's instances, the first primary; the
  // project when the plate is empty.
  const state = session.project.getSnapshot().state;
  const plate = state.plates.find((p) => p.id === state.activePlateId);
  const instances = plate.objects
    .flatMap((o) => o.instances.map((i) => ({ kind: "instance", id: i.id })))
    .slice(0, 3);
  const refs = instances.length
    ? [...instances, { kind: "object", id: plate.objects[0].id }]
    : [{ kind: "project" }];
  session.selection.set(refs, refs[0]);
  phases.push({
    name: "selected",
    selection: {
      refs: refs.map((r) =>
        r.kind === "project" ? r : { kind: r.kind, id: units(r.id) },
      ),
      primary: 0,
    },
    queries: queries(),
  });

  // An acknowledged edit through the session's own wire protocol.
  // (A project or object whose ID alone fills the intent's text budget
  // cannot be guarded or named.)
  const object =
    state.id.length < 1024
      ? state.plates.flatMap((p) => p.objects).find((o) => o.id.length < 1024)
      : undefined;
  if (object) {
    let sequence = 0;
    const wire = (operation) =>
      encodeProjectSessionRequest({
        protocolVersion: 1,
        generation: nonce,
        requestId: ++sequence,
        operation,
      });
    const requests = [
      wire({
        hello: {
          minProtocolVersion: 1,
          maxProtocolVersion: 1,
          projectSchemaVersion: 1,
          intentVersion: 1,
        },
      }),
    ];
    const replies = [await endpoint.handle(requests[0])];
    requests.push(
      wire({
        execute: {
          guard: wireSessionGuard(facade.captureGuard()),
          intent: {
            version: 1,
            command: {
              renameObject: {
                objectId: units(object.id),
                name: units("Capability probe ✓"),
              },
            },
          },
        },
      }),
    );
    replies.push(await endpoint.handle(requests[1]));
    assert.ok(
      JSON.parse(replies[1]).result.acknowledged,
      "the edit is acknowledged",
    );
    assert.equal(session.commands.getHistorySnapshot().undoCount, 1);
    phases.push({ name: "edited", requests, replies, queries: queries() });
  }
  states.push({
    name: fixture.name,
    options: fixture.options,
    stateJson: fixture.stateJson,
    asset: fixture.asset,
    phases,
  });
  session.dispose();
}

const sources = [
  "tools/cross-platform/capability-exchange-vectors.mjs",
  "web/src/actions/canonicalUiFacts.ts",
  "web/src/actions/ActionRegistry.ts",
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
      generation: nonce,
      traces,
      states,
    },
    null,
    1,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/capability-exchange-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Capability exchange reference drift",
  );
const queries = states.reduce(
  (n, s) => n + s.phases.reduce((m, p) => m + p.queries.length, 0),
  0,
);
console.log(
  `capability exchange: ${traces.length} traces, ${states.length} states, ${queries} pages`,
);
