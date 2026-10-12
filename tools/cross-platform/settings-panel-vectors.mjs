// Settings panel and height-range editor references from the production
// browser: the generated settings panel's model (`settingsPanel.ts` through
// `settingsPanelExchange.ts`) over the editor each node's settings open with
// (`mountSettingsEditors.ts`) — the views of detail levels and searches, rows,
// drafts set, inherited and reset to the default, the Full Spectrum rules,
// Apply's commit and the intent it becomes — the scoped panel's words for
// every target, and the semantic editor's height ranges
// (`layerRangeEditor.ts` through `layerRangeEditorExchange.ts`): projections
// with merge decisions, typed bounds, split heights and operation messages,
// heights formatted as `Intl.NumberFormat` rounds them. Replayed by Rust, by
// WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { ProjectStore } from "../../web/src/project/store.ts";
import {
  scopedOverrideSnapshot,
  scopedOverrideTargets,
} from "../../web/src/project/scopedOverrides.ts";
import { projectSettingsOverrideSnapshot } from "../../web/src/project/settingsOverrides.ts";
import { createEngineOptionCatalog } from "../../web/src/settings/generated/loader.ts";
import {
  applySettingsCommitToConfig,
  decodeSettingsConfig,
} from "../../web/src/settings/editor/configBridge.ts";
import { projectSettingsField } from "../../web/src/settings/editor/fields.ts";
import { enumChoicesFor } from "../../web/src/settings/editor/codec.ts";
import { guiSurfaceForScope } from "../../web/src/settings/editor/scopedStepper.ts";
import { SettingsPanelModel } from "../../web/src/settings/editor/settingsPanel.ts";
import {
  settingsPanelApplyExchange,
  settingsPanelEditExchange,
  settingsPanelRowExchange,
  settingsPanelStateExchange,
  settingsPanelViewExchange,
  settingsTargetTextExchange,
} from "../../web/src/settings/editor/settingsPanelExchange.ts";
import {
  layerRangeBoundsExchange,
  layerRangeEditorExchange,
  layerRangeMessagesExchange,
  layerRangeSplitExchange,
} from "../../web/src/project/objects/layerRangeEditorExchange.ts";
import {
  encodeProjectIntent,
  encodeProjectSettingsSessionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const catalog = createEngineOptionCatalog(
  JSON.parse(read("web/src/settings/generated/engine-options.schema.json")),
);
const id = (key) => catalog.get(key).id;

// Three states: the browser's fixture; a rich scene with overrides at every
// scope (Full Spectrum project keys, a foreign key, an out-of-bounds part
// value), mergeable and unmergeable height ranges, unnamed and non-ASCII
// nodes and fractional heights; and an empty plate.
const fixture = createProjectFixture().state;
const ids = new UuidIdSource(seededRandom(0x5e771));
const rich = clone(fixture);
rich.name = "Scène riche";
rich.settingsBaseConfig = { layer_height: 0.2, wall_loops: 2, curr_bed_type: "PEI" };
rich.settingsOverrides = {
  layer_height: 0.16,
  sparse_infill_density: 25,
  mixed_filament_height_lower_bound: 0.04,
  mixed_filament_height_upper_bound: 0.12,
};
rich.config = {
  layer_height: 0.16,
  wall_loops: 2,
  curr_bed_type: "PEI",
  sparse_infill_density: 25,
  mixed_filament_height_lower_bound: 0.04,
  mixed_filament_height_upper_bound: 0.12,
};
rich.plates[0].config = { print_sequence: "by object", layer_height: 0.2 };
const object = rich.plates[0].objects[0];
object.name = "Cube été";
object.config = {
  layer_height: 0.18,
  brim_type: "outer_only",
  wall_loops: 3,
  sparse_infill_density: 40,
  orcaxr_unknown_key: "kept",
};
object.volumes.push({
  ...clone(object.volumes[0]),
  id: ids.next("volume"),
  name: "",
  config: { wall_loops: 4, sparse_infill_density: 30, top_shell_layers: 9999 },
});
object.layerRanges = [
  { id: object.layerRanges[0].id, minZMm: 0, maxZMm: 2.5, config: { layer_height: 0.12 } },
  { id: ids.next("layer-range"), minZMm: 2.5, maxZMm: 5, config: { layer_height: 0.12 } },
  {
    id: ids.next("layer-range"),
    minZMm: 5,
    maxZMm: 7.300000000000001,
    config: { layer_height: 0.08, wall_loops: 5 },
  },
  {
    id: ids.next("layer-range"),
    minZMm: 7.300000000000001,
    maxZMm: 9.03125,
    config: { layer_height: 0.08, wall_loops: 5 },
    filamentId: fixture.filaments.physical[1].id,
  },
  { id: ids.next("layer-range"), minZMm: 12, maxZMm: 123456789.12345, config: {} },
];
const second = {
  ...clone(rich.plates[0]),
  id: ids.next("plate"),
  name: "",
  order: 2,
  config: {},
};
second.objects = [
  {
    ...clone(object),
    id: ids.next("object"),
    name: "",
    config: {},
    volumes: [{ ...clone(object.volumes[0]), id: ids.next("volume"), config: {} }],
    instances: [{ ...clone(object.instances[0]), id: ids.next("instance") }],
    layerRanges: [],
  },
];
rich.plates.push(second);
const empty = createProjectFixture({ withObject: false }).state;
empty.plates[0].name = "";
const named = { fixture, rich, empty };

const snapshots = Object.fromEntries(
  Object.entries(named).map(([name, state]) => [name, new ProjectStore(state).getSnapshot()]),
);
const states = Object.entries(snapshots).map(([name, snapshot]) => ({
  name,
  stateJson: json(snapshot.state),
  revision: snapshot.revision,
  hash: snapshot.hash,
}));

// The scoped panel's words for every target, and a few written by hand.
const targetTexts = [];
const textCase = (request) =>
  targetTexts.push({ requestJson: json(request), replyJson: settingsTargetTextExchange(json(request)) });
for (const snapshot of Object.values(snapshots))
  for (const t of scopedOverrideTargets(snapshot.state))
    textCase({ label: t.label, overrideCount: t.overrideCount, path: t.path, scope: t.scope });
textCase({ label: "", overrideCount: 1, path: "Plate 1 › Été", scope: "part" });
textCase({ label: "0.1–0.3 mm", overrideCount: 12, path: "P › O › 0.1–0.3 mm", scope: "layerRange" });

// Panel sessions: each node's panel, opened as the browser opens it, and a
// script of views, rows, drafts, states and applies.
const units = (value) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const wireTarget = (t) =>
  t.scope === "project"
    ? { project: {} }
    : t.scope === "plate"
      ? { plate: { plateId: units(t.plateId) } }
      : t.scope === "object"
        ? { object: { objectId: units(t.objectId) } }
        : t.scope === "part"
          ? { part: { volumeId: units(t.volumeId) } }
          : { layerRange: { layerRangeId: units(t.layerRangeId) } };
const view = (mode, search) => ({ kind: "view", request: { mode, search } });
const row = (key) => ({ kind: "row", request: { fieldId: id(key) } });
const set = (key, raw) => ({ kind: "edit", request: { fieldId: id(key), op: "set", raw } });
const inherit = (key) => ({ kind: "edit", request: { fieldId: id(key), op: "inherit" } });
const reset = (key) => ({ kind: "edit", request: { fieldId: id(key), op: "default" } });
const state = { kind: "state" };
const apply = { kind: "apply" };
const cancel = { kind: "cancel" };
const node = (first) => [
  view("simple", ""),
  view("develop", "wall"),
  view("advanced", "zzzq nothing"),
  view("advanced", "INFILL density"),
  row(first),
  row("wall_loops"),
  state,
  apply,
  set("wall_loops", "abc"),
  row("wall_loops"),
  state,
  apply,
  set("wall_loops", "3"),
  row("wall_loops"),
  set("sparse_infill_density", "25%"),
  row("sparse_infill_density"),
  set("print_sequence", "by layer"),
  inherit("layer_height"),
  row("layer_height"),
  reset("brim_type"),
  row("brim_type"),
  reset("top_shell_layers"),
  set("enable_support", "1"),
  row("enable_support"),
  { kind: "edit", request: { fieldId: "no-such-field", op: "set", raw: "1" } },
  { kind: "row", request: { fieldId: "no-such-field" } },
  set("wall_filament", "2"),
  state,
  view("simple", "wall"),
  apply,
  set("wall_loops", "-1"),
  apply,
  cancel,
  state,
  set("layer_height", "0.2"),
  set("layer_height", "0.2"),
  apply,
  view("simple", "layer"),
];
// The project's panel also runs the Full Spectrum rules.
const project = [
  view("simple", ""),
  view("advanced", "local"),
  set("dithering_local_z_mode", "1"),
  row("dithering_local_z_infill"),
  row("dithering_local_z_whole_objects"),
  state,
  set("dithering_local_z_mode", "0"),
  view("develop", "local"),
  set("mixed_filament_height_lower_bound", "0.5"),
  set("mixed_filament_height_upper_bound", "0.2"),
  row("mixed_filament_height_lower_bound"),
  row("mixed_filament_height_upper_bound"),
  state,
  apply,
  set("mixed_filament_height_upper_bound", "0.8"),
  state,
  apply,
  row("mixed_filament_definitions"),
  set("mixed_filament_definitions", "x"),
  set("wall_loops", "abc"),
  apply,
  cancel,
  set("dithering_local_z_mode", "not a bool"),
  state,
  apply,
  cancel,
  inherit("layer_height"),
  inherit("sparse_infill_density"),
  reset("wall_loops"),
  apply,
];
const sessions = [];
for (const name of ["fixture", "rich"]) {
  const snapshot = snapshots[name];
  let fullAdvanced = false;
  for (const option of scopedOverrideTargets(snapshot.state)) {
    const scope = option.scope;
    const raw =
      scope === "project"
        ? projectSettingsOverrideSnapshot(snapshot)
        : scopedOverrideSnapshot(snapshot, option.target);
    const model = new SettingsPanelModel(catalog, {
      technology: "fff",
      guiSurface: guiSurfaceForScope(scope),
      ...(scope === "project" ? {} : { scope }),
      inherited: decodeSettingsConfig(catalog, raw.inheritedConfig).values,
      overrides: decodeSettingsConfig(catalog, raw.overrides).values,
    });
    const script =
      scope === "project"
        ? project
        : node(scope === "plate" ? "print_sequence" : "layer_height");
    // One full Advanced view, of the rich scene's first object.
    if (name === "rich" && scope === "object" && !fullAdvanced) {
      script.splice(1, 0, view("advanced", ""));
      fullAdvanced = true;
    }
    const steps = script.map((step) => {
      const requestJson = step.request === undefined ? undefined : json(step.request);
      switch (step.kind) {
        case "view":
          return { kind: "view", requestJson, replyJson: settingsPanelViewExchange(model, requestJson) };
        case "row":
          return { kind: "row", requestJson, replyJson: settingsPanelRowExchange(model, requestJson) };
        case "edit":
          return { kind: "edit", requestJson, replyJson: settingsPanelEditExchange(model, requestJson) };
        case "state":
          return { kind: "state", replyJson: settingsPanelStateExchange(model) };
        case "cancel":
          model.discard();
          return { kind: "cancel" };
        case "apply": {
          const { reply, commit } = settingsPanelApplyExchange(model);
          if (!commit) return { kind: "apply", replyJson: reply };
          const next = applySettingsCommitToConfig(raw.overrides, commit);
          const guard = { sourceRevision: raw.sourceRevision, sourceHash: units(raw.sourceHash) };
          const command =
            scope === "project"
              ? {
                  setProjectSettingsOverrides: {
                    guard,
                    inheritedConfigJson: units(json(raw.inheritedConfig)),
                    overridesJson: units(json(next)),
                  },
                }
              : { setScopedOverrides: { guard, target: wireTarget(option.target), overridesJson: units(json(next)) } };
          return {
            kind: "apply",
            replyJson: reply,
            intentJson: encodeProjectIntent({ version: 1, command }),
          };
        }
        default:
          throw Error(step.kind);
      }
    });
    sessions.push({
      state: name,
      target: option.id,
      requestJson: encodeProjectSettingsSessionRequest({
        target: wireTarget(option.target),
        mode: "simple",
        technology: "fff",
      }),
      steps,
    });
  }
}

// Requests every panel exchange refuses.
const refusals = [
  { exchange: "view", request: json({ mode: "expert", search: "" }) },
  { exchange: "view", request: json({ mode: "simple" }) },
  { exchange: "view", request: json({ mode: "simple", search: 3 }) },
  { exchange: "view", request: "[]" },
  { exchange: "row", request: json({ fieldId: 7 }) },
  { exchange: "edit", request: json({ fieldId: id("wall_loops"), op: "set" }) },
  { exchange: "edit", request: json({ fieldId: id("wall_loops"), op: "clear" }) },
  { exchange: "edit", request: json({ fieldId: id("wall_loops"), op: "inherit", raw: "1" }) },
  { exchange: "targetText", request: json({ label: "", overrideCount: -1, path: "", scope: "object" }) },
  { exchange: "targetText", request: json({ label: "", overrideCount: 1.5, path: "", scope: "object" }) },
  { exchange: "targetText", request: json({ label: "", overrideCount: 0, path: "", scope: "volume" }) },
];
for (const r of refusals) {
  const model = new SettingsPanelModel(catalog, {
    technology: "fff",
    guiSurface: "process",
    inherited: {},
    overrides: {},
  });
  assert.throws(
    () =>
      ({
        view: () => settingsPanelViewExchange(model, r.request),
        row: () => settingsPanelRowExchange(model, r.request),
        edit: () => settingsPanelEditExchange(model, r.request),
        targetText: () => settingsTargetTextExchange(r.request),
      })[r.exchange](),
    /invalid_request/,
    `${r.exchange} ${r.request}`,
  );
}

// The height-range editor: every object's ranges with each range (and none)
// selected, typed bounds, split heights and operation messages.
const projections = [];
for (const [name, snapshot] of Object.entries(snapshots)) {
  const objects = snapshot.state.plates.flatMap((p) => p.objects);
  for (const o of objects)
    for (const selected of [null, ...o.layerRanges.map((r) => r.id), "00000000-0000-4000-8000-0000000000aa"]) {
      const requestJson = json({ objectId: o.id, selectedLayerRangeId: selected });
      projections.push({ state: name, requestJson, replyJson: layerRangeEditorExchange(snapshot.state, requestJson) });
    }
  const requestJson = json({ objectId: "00000000-0000-4000-8000-0000000000bb", selectedLayerRangeId: null });
  projections.push({ state: name, requestJson, replyJson: layerRangeEditorExchange(snapshot.state, requestJson) });
}
const ranges = rich.plates[0].objects[0].layerRanges.map((r) => ({ id: r.id, maxZMm: r.maxZMm, minZMm: r.minZMm }));
const texts = [
  "",
  "   ",
  "abc",
  "0",
  "-0",
  "-1",
  " 2 ",
  "1e1",
  "0x10",
  "Infinity",
  "1e400",
  "2.5",
  "5",
  "9.03125",
  "10",
  "11.99995",
  "12",
  "  3　",
  "1_0",
  ".5",
  "5.",
];
const bounds = [];
for (const rawMin of texts)
  for (const rawMax of ["", "abc", "0", "2.5", "3", "10", "11.99995", "1e21", "-0"])
    for (const excludedId of [null, ranges[2].id]) {
      const requestJson = json({ excludedId, ranges, rawMax, rawMin });
      bounds.push({ requestJson, replyJson: layerRangeBoundsExchange(requestJson) });
    }
for (const [rawMin, rawMax] of [
  ["0", "1"],
  ["9.5", "11"],
  ["0.1", "0.2"],
])
  for (const list of [[], ranges.slice(0, 1)]) {
    const requestJson = json({ excludedId: null, ranges: list, rawMax, rawMin });
    bounds.push({ requestJson, replyJson: layerRangeBoundsExchange(requestJson) });
  }
const splits = [];
for (const [minZMm, maxZMm] of [
  [0, 2.5],
  [5, 7.300000000000001],
  [12, 123456789.12345],
  [0.00005, 1e21],
])
  for (const raw of texts) {
    const requestJson = json({ maxZMm, minZMm, raw });
    splits.push({ requestJson, replyJson: layerRangeSplitExchange(requestJson) });
  }
const heights = [
  0,
  -0,
  0.00004,
  0.00005,
  -0.00001,
  0.03125,
  0.15625,
  1.00005,
  2.5e-5,
  1e-7,
  0.1 + 0.2,
  9.99995,
  99999.99995,
  123456789.12345,
  -1.23456,
  7.300000000000001,
  1e21,
  1.5e21,
  1.7976931348623157e308,
];
const messages = [];
const message = (request) => messages.push({ requestJson: json(request), replyJson: layerRangeMessagesExchange(json(request)) });
for (const h of heights) {
  message({ kind: "add", maxZMm: h + 1, minZMm: h });
  message({ kind: "split", splitZMm: h });
}
message({ fromMaxZMm: 5, fromMinZMm: 2.5, kind: "edit", maxZMm: 6.125, minZMm: 2.75 });
message({ direction: "previous", kind: "merge" });
message({ direction: "next", kind: "merge" });
message({ kind: "delete" });
const layerRangeRefusals = [
  { exchange: "projection", request: json({ objectId: 3, selectedLayerRangeId: null }) },
  { exchange: "projection", request: json({ objectId: "x" }) },
  { exchange: "bounds", request: json({ excludedId: null, ranges: [{ id: "x", minZMm: 0 }], rawMax: "", rawMin: "" }) },
  { exchange: "bounds", request: json({ excludedId: 1, ranges: [], rawMax: "", rawMin: "" }) },
  { exchange: "split", request: json({ maxZMm: "1", minZMm: 0, raw: "" }) },
  { exchange: "messages", request: json({ kind: "merge", direction: "up" }) },
  { exchange: "messages", request: json({ kind: "delete", extra: 1 }) },
  { exchange: "messages", request: json({ kind: "resize" }) },
  { exchange: "messages", request: json({ kind: "split", splitZMm: null }) },
];
for (const r of layerRangeRefusals)
  assert.throws(
    () =>
      ({
        projection: () => layerRangeEditorExchange(rich, r.request),
        bounds: () => layerRangeBoundsExchange(r.request),
        split: () => layerRangeSplitExchange(r.request),
        messages: () => layerRangeMessagesExchange(r.request),
      })[r.exchange](),
    /invalid_request/,
    `${r.exchange} ${r.request}`,
  );

// The folding a host performs, for every non-ASCII text a search folds.
const fold = (text) => text.normalize("NFKD").toLocaleLowerCase("en-US");
const folded = new Set();
for (const d of catalog.definitions) {
  const p = projectSettingsField(catalog, d, "fff", "process");
  for (const t of [p.label, p.fullLabel, p.category, p.tooltip, p.unit]) if (t) folded.add(t);
  for (const a of d.behavior.aliases.value) folded.add(a);
  for (const c of enumChoicesFor(d)) {
    folded.add(c.serialized);
    folded.add(c.label);
  }
}
for (const t of [...catalog.schema.guiLayout.tabs, ...catalog.schema.guiLayout.groups]) folded.add(t.label);
const foldings = {};
for (const t of [...folded].sort()) if (/[^\x00-\x7f]/.test(t)) foldings[t] = fold(t);

const sources = [
  "tools/cross-platform/settings-panel-vectors.mjs",
  "web/src/settings/editor/settingsPanel.ts",
  "web/src/settings/editor/settingsPanelExchange.ts",
  "web/src/settings/editor/SettingsDraftEditor.ts",
  "web/src/settings/editor/fullSpectrumSemantics.ts",
  "web/src/ui/dom/GeneratedSettingsPanel.ts",
  "web/src/ui/dom/ScopedSettingsPanel.ts",
  "web/src/ui/dom/mountSettingsEditors.ts",
  "web/src/project/objects/layerRangeEditor.ts",
  "web/src/project/objects/layerRangeEditorExchange.ts",
  "web/src/project/objects/layerRangeCommands.ts",
  "web/src/ui/dom/SemanticObjectEditor.ts",
  "web/src/settings/generated/engine-options.schema.json",
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
      foldings,
      states,
      assets: [
        {
          descriptorJson: json(createProjectFixture().asset.descriptor),
          bytes: Array.from(createProjectFixture().asset.bytes),
        },
      ],
      targetTexts,
      sessions,
      refusals,
      layerRanges: { projections, bounds, splits, messages, refusals: layerRangeRefusals },
    },
    null,
    2,
  ) + "\n";
const path = new URL("testdata/cross-platform/settings-panel-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Settings panel reference drift");
const steps = sessions.reduce((n, s) => n + s.steps.length, 0);
console.log(
  `settings panel: ${targetTexts.length} target texts, ${sessions.length} sessions (${steps} steps), ` +
    `${refusals.length} refusals; height ranges: ${projections.length} projections, ${bounds.length} bounds, ` +
    `${splits.length} splits, ${messages.length} messages, ${layerRangeRefusals.length} refusals`,
);
