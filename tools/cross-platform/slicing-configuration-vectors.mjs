// Catalog profile selection and slicing configuration references from the
// production browser (`CatalogSlicingConfiguration.ts` through its host
// exchange, `CatalogSlicingConfigurationExchange.ts`): the pickers' choices
// over the bundled catalog and a synthetic one, typed-name matching, the
// default triple, selections by ID and by name, the slicing configuration of
// each resulting live choice against project states, and the project state
// each configuration leads to under every auto-pair policy. Hostile cases:
// orphaned mixed components, unchanged configurations, override overlays,
// more than four physical filaments, missing exact filament profiles, unknown
// presets, disambiguated labels, a palette past its limit, exhausted
// identity words and malformed requests. Replayed by Rust, WASM and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify, projectFingerprint } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { ProfileCatalog } from "../../web/src/slicer/ProfileLoader.ts";
import {
  defaultProfileSelectionExchange,
  nextSlicingStateExchange,
  presetMatchExchange,
  profileSelectionByNamesExchange,
  profileSelectionExchange,
  slicingChoicesExchange,
  slicingConfigurationExchange,
} from "../../web/src/workspace/CatalogSlicingConfigurationExchange.ts";
import { FilamentPalette } from "../../web/src/workspace/FilamentPalette.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
// Own `__proto__` members survive: JSON copies them as data.
const clone = (value) => JSON.parse(JSON.stringify(value));
// Member order follows canonical JSON, as a native host receives it.
const canonical = (value) => JSON.parse(canonicalStringify(value));
const catalogPath = "web/public/profiles/catalog.json";

// --- Catalogs ----------------------------------------------------------------------------------

const synthetic = {
  Acme: {
    machine: [
      {
        name: "Twin",
        from: "system",
        nozzle_diameter: ["0.4", "0.6"],
        default_print_profile: "Std @Acme",
        default_filament_profile: ["PLA @Acme", "Blend"],
        printable_area: ["0x0", "200x0", "200x200", "0x200"],
      },
      {
        name: "Mono",
        from: "system",
        nozzle_diameter: ["0.4"],
        single_extruder_multi_material: "1",
      },
      { name: "Many", from: "system", nozzle_diameter: Array.from({ length: 17 }, () => "0.4") },
      { name: "Odd", from: "system", nozzle_diameter: ["0.4;abc", "0", " 0.6 ", "-1"] },
      { name: "Bare", from: "system" },
    ],
    process: [
      { name: "Std @Acme", from: "system", layer_height: "0.2" },
      { name: "Fine @Acme", from: "system", layer_height: "0.1", compatible_printers: ["Twin", "Mono"] },
    ],
    filament: [
      { name: "PLA @Acme", from: "system", filament_type: ["PLA"], filament_vendor: ["Acme"] },
      { name: "PLA @Twin", from: "system", filament_type: ["PLA"], compatible_printers: ["Twin"] },
      { name: "Blend", from: "system", filament_type: ["PLA;PETG"] },
      { name: "@Nameless", from: "system", filament_type: [""] },
      { name: "PETG", from: "system", filament_type: "PETG", compatible_prints: ["Std @Acme"] },
    ],
  },
  "B&B Labs": {
    filament: [{ name: "PLA @Acme", from: "system", filament_type: ["PLA"] }],
  },
};
const catalogs = {
  bundled: ProfileCatalog.fromRaw(canonical(JSON.parse(read(catalogPath)))),
  synthetic: ProfileCatalog.fromRaw(canonical(synthetic)),
};
for (const catalog of Object.values(catalogs)) assert.ok(catalog.profiles.length > 0);

// --- Choices -----------------------------------------------------------------------------------

const choices = [];
function choose(catalog, request) {
  const requestJson = json(request);
  choices.push({ catalog, requestJson, replyJson: slicingChoicesExchange(catalogs[catalog], requestJson) });
}
for (const name of Object.keys(catalogs)) {
  const profiles = catalogs[name].profiles;
  choose(name, {});
  const machines = [...new Set(profiles.map((p) => p.machinePresetId))];
  for (const machine of machines) choose(name, { machinePresetId: machine });
  const pairs = [...new Set(profiles.map((p) => `${p.machinePresetId}\n${p.processPresetId}`))];
  for (const pair of pairs) {
    const [machine, process] = pair.split("\n");
    choose(name, { machinePresetId: machine, processPresetId: process });
  }
  // Unknown and mismatched presets offer nothing.
  choose(name, { machinePresetId: "preset:Nobody:machine:None" });
  choose(name, { machinePresetId: machines[0], processPresetId: "preset:Nobody:process:None" });
  choose(name, { processPresetId: profiles[0].processPresetId });
  choose(name, { machinePresetId: "", processPresetId: "" });
}
const labelled = choices.filter((c) => c.catalog === "synthetic").map((c) => JSON.parse(c.replyJson));
assert.ok(
  labelled.some((reply) => reply.filaments.some((o) => o.label.includes(" — B&B Labs"))),
  "a label disambiguated by vendor",
);
assert.ok(
  labelled.some((reply) => reply.filaments.some((o) => o.label === "PLA @Twin")),
  "a label disambiguated by name",
);

// --- Matching ----------------------------------------------------------------------------------

const matches = [];
function match(options, query) {
  const requestJson = json({ options, query });
  matches.push({ requestJson, replyJson: presetMatchExchange(requestJson) });
}
{
  const bundled = JSON.parse(choices.find((c) => c.catalog === "bundled" && c.requestJson.includes("processPresetId")).replyJson);
  const machines = bundled.machines;
  const processes = bundled.processes;
  const filaments = bundled.filaments;
  for (const query of [
    "",
    "   ",
    "u1",
    "U1",
    "Snapmaker U1 (0.4 nozzle)",
    "  snapmaker u1 (0.4 NOZZLE) ",
    "snapmaker",
    "centauri",
    "0.4",
    "nothing like it",
  ])
    match(machines, query);
  for (const query of ["0.20 Standard", "standard", "0.2", "fine", "Extra Fine", "@"]) match(processes, query);
  for (const query of ["PLA", "pla", "Snapmaker PLA", "matte", "petg", "PLA-CF", "Generic", "@U1"])
    match(filaments, query);
  // Exact labels before names before parts; ambiguity matches nothing.
  const opt = (id, name, label) => ({ id, name, label });
  const unicode = [
    opt("preset:a:filament:1", "ΣΑΣ Sigma", "σας"),
    opt("preset:a:filament:2", "İstanbul", "İ"),
    opt("preset:a:filament:3", "Straße", "STRASSE"),
    opt("preset:a:filament:4", "lone \ud800 unit", "\udc00"),
    opt("preset:a:filament:5", "ﬀ ligature", "Kelvin K"),
    opt("preset:a:filament:6", "same", "twin"),
    opt("preset:a:filament:7", "same", "twin"),
    opt("preset:a:filament:8", "Label", "name"),
    opt("preset:a:filament:9", "name", "Other"),
  ];
  for (const query of [
    "σας",
    "ΣΑΣ",
    "σασ",
    "i̇",
    "İ",
    "istanbul",
    "straße",
    "STRASSE",
    "strasse",
    "\ud800",
    "\udc00",
    "FF",
    "ﬀ",
    "kelvin k",
    "KELVIN K",
    "twin",
    "same",
    "name",
    "label",
    "a",
    " σας﻿",
  ])
    match(unicode, query);
  match([], "pla");
}

// --- Selections --------------------------------------------------------------------------------

const palette = new FilamentPalette().list();
const triple = (profile) =>
  profile
    ? {
        filamentPresetId: profile.filamentPresetId,
        machinePresetId: profile.machinePresetId,
        processPresetId: profile.processPresetId,
      }
    : null;
const empty = { heads: [], nozzles: [], palette, profile: null };
const selections = [];
/** One selection's reply; the live choice it leads to, when it applied. */
function select(catalog, kind, request) {
  const requestJson = json(request);
  const exchange =
    kind === "ids"
      ? profileSelectionExchange
      : kind === "names"
        ? profileSelectionByNamesExchange
        : defaultProfileSelectionExchange;
  const replyJson = exchange(catalogs[catalog], requestJson);
  selections.push({ catalog, kind, requestJson, replyJson });
  return JSON.parse(replyJson).live;
}
const find = (catalog, machine, process, filament) => catalogs[catalog].find(machine, process, filament);
const lives = { bundled: [], synthetic: [] };
const keep = (catalog, live) => {
  if (live) lives[catalog].push(live);
  return live;
};

// The bundled catalog: the default triple, then edits to every part of it.
const u1 = keep("bundled", select("bundled", "default", { live: empty }));
assert.ok(u1 && u1.heads.length === 4);
const u1Profile = catalogs.bundled.profiles.find(
  (p) => p.machinePresetId === u1.profile.machinePresetId && p.filamentPresetId === u1.profile.filamentPresetId && p.processPresetId === u1.profile.processPresetId,
);
const sameMachine = catalogs.bundled.profiles.filter((p) => p.machinePresetId === u1Profile.machinePresetId);
const processes = [...new Set(sameMachine.map((p) => p.processPresetId))];
const sameProcess = sameMachine.filter((p) => p.processPresetId === u1Profile.processPresetId);
const otherMachine = catalogs.bundled.profiles.find((p) => p.machineName.includes("Centauri"));
assert.ok(otherMachine, "a second printer");
select("bundled", "ids", { live: empty, request: {} });
select("bundled", "ids", { live: empty, request: { processPresetId: u1Profile.processPresetId } });
keep("bundled", select("bundled", "ids", { live: u1, request: { processPresetId: processes.at(-1) } }));
keep(
  "bundled",
  select("bundled", "ids", {
    live: u1,
    request: { filamentPresetIds: sameProcess.slice(1, 5).map((p) => p.filamentPresetId) },
  }),
);
const centauri = keep("bundled", select("bundled", "ids", { live: u1, request: { machinePresetId: otherMachine.machinePresetId } }));
keep("bundled", select("bundled", "ids", { live: centauri, request: { machinePresetId: u1Profile.machinePresetId } }));
select("bundled", "ids", { live: u1, request: { machinePresetId: "preset:Nobody:machine:None" } });
select("bundled", "ids", { live: u1, request: { machinePresetId: "" } });
keep("bundled", select("bundled", "ids", { live: u1, request: { processPresetId: "preset:Nobody:process:None" } }));
keep(
  "bundled",
  select("bundled", "ids", {
    live: u1,
    request: {
      filamentPresetIds: [
        "preset:Nobody:filament:None",
        null,
        "",
        otherMachine.filamentPresetId,
        sameProcess[2].filamentPresetId,
        sameProcess[3].filamentPresetId,
      ],
    },
  }),
);
keep("bundled", select("bundled", "ids", { live: u1, request: { filamentPresetIds: [] } }));
// A profile the catalog no longer holds reads as none.
select("bundled", "ids", {
  live: { ...u1, profile: { ...u1.profile, filamentPresetId: "preset:Gone:filament:Gone" } },
  request: { filamentPresetIds: [sameProcess[1].filamentPresetId] },
});
// A wider palette keeps its extra slots; a narrower one grows to the printer.
keep(
  "bundled",
  select("bundled", "ids", {
    live: {
      ...u1,
      palette: [...palette, { color: "#123456", type: "PETG" }, { color: "#abcdef", type: "" }],
      heads: [...u1.heads, { name: "Extra", presetId: sameProcess[1].filamentPresetId }, { name: "" }],
      nozzles: [...u1.nozzles, "0.6", "x"],
    },
    request: { processPresetId: processes[0] },
  }),
);
keep(
  "bundled",
  select("bundled", "ids", {
    live: { ...empty, palette: [{ color: "#000000", type: "ABS" }] },
    request: { machinePresetId: u1Profile.machinePresetId },
  }),
);
for (const [machine, process, filament] of [
  ["u1", "", ""],
  ["", "", ""],
  ["", "0.20 Standard", "matte"],
  ["Snapmaker U1 (0.4 nozzle)", "standard", "PLA"],
  ["centauri", "", ""],
  ["snapmaker", "", ""],
  ["", "nonsense process", ""],
  ["", "", "nonsense filament"],
  ["", "", "pla"],
  ["U1", "0.08", "SnapSpeed"],
  [" u1﻿", "", ""],
])
  keep("bundled", select("bundled", "names", { live: u1, machine, process, filament }));
select("bundled", "names", { live: empty, machine: "", process: "Standard", filament: "" });
select("bundled", "names", { live: empty, machine: "", process: "", filament: "" });

// The synthetic catalog: labels, odd nozzles, a palette past its limit.
const twin = keep("synthetic", select("synthetic", "default", { live: empty }));
const syntheticIds = (name) => catalogs.synthetic.profiles.find((p) => p.machineName === name);
for (const name of ["Twin", "Mono", "Many", "Odd", "Bare"]) {
  const profile = syntheticIds(name);
  assert.ok(profile, name);
  keep("synthetic", select("synthetic", "ids", { live: empty, request: { machinePresetId: profile.machinePresetId } }));
  keep("synthetic", select("synthetic", "ids", { live: twin, request: { machinePresetId: profile.machinePresetId } }));
}
const many = lives.synthetic.find((live) => live.palette.length === 16);
assert.ok(many, "a 17-nozzle printer fills the palette's 16 slots");
const nameless = catalogs.synthetic.profiles.find((p) => p.filamentPresetName === "@Nameless" && p.machineName === "Mono");
assert.ok(nameless && nameless.filamentName === "");
keep(
  "synthetic",
  select("synthetic", "ids", {
    live: empty,
    request: {
      machinePresetId: nameless.machinePresetId,
      processPresetId: nameless.processPresetId,
      filamentPresetIds: [nameless.filamentPresetId],
    },
  }),
);
for (const [machine, process, filament] of [
  ["twin", "fine", "pla"],
  ["Twin", "", "PLA @Acme"],
  ["Twin", "", "PLA"],
  ["mono", "", "blend"],
  ["", "", "petg"],
  ["Many", "Std", ""],
])
  keep("synthetic", select("synthetic", "names", { live: twin, machine, process, filament }));
// The default of a catalog without the bundled triple is its first profile.
assert.equal(
  JSON.parse(selections.find((s) => s.catalog === "synthetic" && s.kind === "default").replyJson).live.profile.machinePresetId,
  catalogs.synthetic.profiles[0].machinePresetId,
);

// --- States ------------------------------------------------------------------------------------

const model = JSON.parse(read("testdata/cross-platform/project-model-vectors.json"));
const named = new Map(model.cases.map((each) => [each.name, each.stateJson]));
const valid = (state) => {
  assert.deepEqual(
    validateProjectState(state).filter((issue) => issue.severity === "error"),
    [],
  );
  return state;
};
/** A corpus state without objects or assets, so a host can open it alone. */
function assetFree(name) {
  const state = JSON.parse(named.get(name));
  for (const plate of state.plates) plate.objects = [];
  state.sourceAssets = [];
  state.thumbnails = [];
  state.extensionBlobs = [];
  return valid(state);
}
const ids = new UuidIdSource(seededRandom(0x51ce));
const now = "2026-10-10T08:00:00.000Z";
const fresh = valid(createEmptyProject({ idSource: ids, now }));
const physical = (id, toolId, extra = {}) => ({
  id,
  name: `Tool ${toolId + 1}`,
  toolId,
  material: "PLA",
  color: "#808080",
  config: {},
  enabled: true,
  ...extra,
});
const fourTools = (() => {
  const state = clone(fresh);
  state.printer = { profileId: "Somewhere", toolCount: 4 };
  state.filaments.physical = [0, 1, 2, 3].map((tool) => physical(`import:physical:tool-${tool}`, tool));
  return valid(state);
})();
/** A mixed filament of two physical ones: authored, not a FullSpectrum row. */
const mixed = (id, a, b) => ({
  id,
  name: "Blend",
  displayColor: "#777777",
  components: [
    { filamentId: a, weight: 50 },
    { filamentId: b, weight: 50 },
  ],
  distribution: { mode: "ratio" },
  config: {},
  enabled: true,
});
const sixTools = (() => {
  const state = clone(fourTools);
  state.printer.toolCount = 6;
  state.filaments.physical.push(physical("import:physical:tool-4", 4), physical("import:physical:tool-5", 5));
  // A mixed filament on tool 6 is orphaned once the palette has four slots.
  state.filaments.mixed = [mixed("import:mixed:late", "import:physical:tool-0", "import:physical:tool-5")];
  return valid(state);
})();
const wipeOnTool3 = (() => {
  const state = clone(fourTools);
  state.plates[0].wipeTower = { enabled: true, positionMm: [10, 10], rotationDeg: 0, filamentId: "import:physical:tool-3" };
  return valid(state);
})();
const overridden = (() => {
  const state = clone(fourTools);
  state.settingsBaseConfig = { layer_height: "0.2", wall_loops: "2" };
  state.settingsOverrides = JSON.parse('{"__proto__":null,"wall_loops":5}');
  state.config = JSON.parse('{"__proto__":null,"layer_height":"0.2","wall_loops":5}');
  return valid(state);
})();
const states = {
  fresh,
  fourTools,
  sixTools,
  wipeOnTool3,
  overridden,
  rich: assetFree("complete-schema-with-unknowns"),
  utf16: assetFree("utf16-identities-and-references"),
  minimal: valid(JSON.parse(named.get("minimal"))),
};

// --- Configurations ----------------------------------------------------------------------------

const configurations = [];
/** The configuration a live choice describes against a state. */
function configure(catalog, live, stateName) {
  const requestJson = json({ live, stateJson: json(states[stateName]) });
  const replyJson = slicingConfigurationExchange(catalogs[catalog], requestJson);
  configurations.push({ catalog, live, state: stateName, replyJson });
  return JSON.parse(replyJson).configurationJson ?? undefined;
}
const configured = [];
for (const [catalog, list] of Object.entries(lives)) {
  for (const [index, live] of list.entries()) {
    const stateName = ["fresh", "fourTools", "rich", "utf16", "overridden", "wipeOnTool3", "sixTools", "minimal"][index % 8];
    const configurationJson = configure(catalog, live, stateName);
    if (configurationJson) configured.push({ catalog, live, stateName, configurationJson, index: configurations.length - 1 });
  }
}
// Hostile live choices over the bundled U1.
const head = (presetId, name) => ({ name, ...(presetId ? { presetId } : {}) });
const hostileLives = [
  // A head whose preset is another printer's: the catalog's first name match, else the profile.
  { ...u1, heads: [head(otherMachine.filamentPresetId, "Snapmaker PLA Matte"), head(undefined, "petg"), head(undefined, "zzz"), head(undefined, "")] },
  // Nozzles of every kind.
  { ...u1, nozzles: ["abc", "-1", "0", "  0.6 "] },
  { ...u1, nozzles: ["1e-1", "0x10", "Infinity", ""] },
  // Fewer heads and nozzles than slots; more of both.
  { ...u1, heads: u1.heads.slice(0, 1), nozzles: [] },
  { ...u1, heads: [...u1.heads, head(undefined, "spare")], nozzles: [...u1.nozzles, "0.8"] },
  // Palette types, colours and length.
  { ...u1, palette: [{ color: "#ﬀ0000", type: "" }, { color: " #00ff00 ", type: "PETG" }, { color: "red", type: "PLA" }, { color: "#0000FF", type: "TPU" }] },
  { ...u1, palette: [...palette, { color: "#101010", type: "PLA" }] },
  { ...u1, palette: [...palette, { color: "#101010", type: "PLA" }, { color: "#202020", type: "PLA" }] },
  { ...u1, palette: palette.slice(0, 2) },
  // No profile: nothing to configure.
  { ...u1, profile: null },
];
for (const [n, live] of hostileLives.entries())
  for (const stateName of ["fourTools", "sixTools", ["rich", "wipeOnTool3", "overridden"][n % 3]]) {
    const configurationJson = configure("bundled", live, stateName);
    if (configurationJson)
      configured.push({ catalog: "bundled", live, stateName, configurationJson, index: configurations.length - 1, hostile: true });
  }
// The nameless filament: a slot with neither preset nor name records none.
{
  const live = lives.synthetic.find((l) => l.profile.filamentPresetId === nameless.filamentPresetId);
  const blank = { ...live, heads: live.heads.map(() => ({ name: "" })) };
  const configurationJson = configure("synthetic", blank, "fourTools");
  const configuration = JSON.parse(configurationJson);
  assert.ok(configuration.filaments.physical.every((filament) => !("presetId" in filament)), "no undefined preset");
  configured.push({ catalog: "synthetic", live: blank, stateName: "fourTools", configurationJson, index: configurations.length - 1 });
}
const outcomes = (list) => {
  const counts = new Map();
  for (const each of list) {
    const reply = JSON.parse(each.replyJson);
    const key = reply.error ?? (reply.configurationJson === null ? "none" : reply.unchanged ? "unchanged" : "ok");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
assert.ok(outcomes(configurations).get("orphaned-mixed-component") > 0, "an orphaned component");
assert.ok(outcomes(configurations).get("none") > 0, "no profile");

// --- Next states -------------------------------------------------------------------------------

const nextStates = [];
const policies = {
  off: { enabled: false, confirmedCounts: [] },
  on: { enabled: true, confirmedCounts: [] },
  confirmed: { enabled: true, confirmedCounts: [5, 6, 16] },
};
const plenty = (() => {
  const next = seededRandom(0x7a17);
  return Array.from({ length: 16 * 120 }, () => next());
})();
/**
 * The state a configuration leads to, with exactly the words its new
 * identities draw. `from` names a corpus state or the index of an earlier
 * case whose result it continues from; `configuration` is the index of a
 * configuration case or a configuration document.
 */
function advance(from, configuration, policy, words = undefined) {
  const stateJson = typeof from === "string" ? json(states[from]) : JSON.parse(nextStates[from].replyJson).stateJson;
  const configurationJson =
    typeof configuration === "number" ? JSON.parse(configurations[configuration].replyJson).configurationJson : configuration;
  const requestJson = json({ autoPairs: policies[policy], configurationJson, stateJson });
  let used = words;
  if (!used) {
    const reply = JSON.parse(nextSlicingStateExchange(requestJson, plenty));
    const before = new Set(JSON.parse(configurationJson).filaments.mixed.map((m) => m.id));
    const created = reply.stateJson
      ? JSON.parse(reply.stateJson).filaments.mixed.filter((m) => !before.has(m.id)).length
      : 0;
    used = plenty.slice(0, 16 * created);
  }
  const replyJson = nextSlicingStateExchange(requestJson, used);
  nextStates.push({
    ...(typeof from === "string" ? { state: from } : { after: from }),
    ...(typeof configuration === "number" ? { configuration } : { configurationJson }),
    autoPairs: policies[policy],
    words: used,
    replyJson,
  });
  return JSON.parse(replyJson);
}
for (const [n, each] of configured.entries()) {
  const chosen = each.hostile ? ["off", "on", "confirmed"] : [["off", "on", "confirmed"][n % 3]];
  for (const policy of chosen) {
    const reply = advance(each.stateName, each.index, policy);
    // A configuration applied to the state it produced changes nothing.
    if (reply.stateJson && n % 4 === 0) advance(nextStates.length - 1, each.index, policy);
  }
}
// Hand-made configurations: submitted overrides, duplicate physical IDs, a
// broken FullSpectrum identity, dangling references, too few words.
{
  const base = JSON.parse(
    configured.find((c) => c.catalog === "synthetic" && c.stateName === "fourTools" && !c.hostile).configurationJson,
  );
  const variant = (change) => {
    const configuration = clone(base);
    change(configuration);
    return json(configuration);
  };
  advance("overridden", variant((c) => (c.settingsOverrides = { wall_loops: 3, layer_height: "0.28" })), "off");
  advance("overridden", variant((c) => (c.settingsOverrides = {})), "on");
  advance("rich", variant((c) => (c.settingsOverrides = JSON.parse('{"__proto__":null,"\\ud800":"lone"}'))), "off");
  const duplicate = variant((c) => (c.filaments.physical[1].id = c.filaments.physical[0].id));
  advance("fourTools", duplicate, "on");
  advance("fourTools", duplicate, "off");
  const withRichMixed = (stableId) =>
    variant((c) => {
      c.filaments.physical[0].id = "import:physical:0";
      c.filaments.physical[1].id = "import:physical:1";
      c.filaments.mixed = clone(states.rich.filaments.mixed);
      c.filaments.mixed[0].fullSpectrum.upstreamStableId = stableId;
    });
  advance("rich", withRichMixed("0"), "on");
  advance("rich", withRichMixed("0"), "off");
  advance("rich", withRichMixed("18446744073709551616"), "on");
  advance("rich", withRichMixed("18446744073709551615"), "on");
  advance("wipeOnTool3", variant((c) => c.filaments.physical.splice(3)), "on");
  advance("fourTools", variant(() => {}), "on", []);
  advance("fourTools", variant(() => {}), "on", plenty.slice(0, 20));
  advance(
    "fourTools",
    variant((c) => (c.printer = { profileId: "Elsewhere", profileHash: "kept", toolCount: 4 })),
    "off",
  );
}
const nextOutcomes = outcomes(nextStates);
for (const key of ["ok", "unchanged", "invalid", "auto-pairs", "ids-exhausted"])
  assert.ok(nextOutcomes.get(key) > 0, `the corpus exercises ${key}`);
// Past four physical filaments, pairs regenerate only for a confirmed count.
{
  const autoRows = (each) => {
    const reply = JSON.parse(each.replyJson);
    return reply.stateJson
      ? JSON.parse(reply.stateJson).filaments.mixed.filter((m) => m.fullSpectrum?.originAuto && !m.fullSpectrum.custom).length
      : -1;
  };
  const wide = nextStates.filter(
    (each) =>
      each.configuration !== undefined &&
      JSON.parse(JSON.parse(configurations[each.configuration].replyJson).configurationJson).filaments.physical
        .length > 4,
  );
  assert.ok(wide.some((each) => each.autoPairs === policies.on && autoRows(each) === 0), "an unconfirmed count");
  assert.ok(wide.some((each) => each.autoPairs === policies.confirmed && autoRows(each) >= 10), "a confirmed count");
}
assert.ok(
  nextStates.some((each) => {
    const reply = JSON.parse(each.replyJson);
    return reply.stateJson && JSON.parse(reply.stateJson).filaments.mixed.some((m) => m.fullSpectrum?.originAuto && !m.fullSpectrum.custom);
  }),
  "automatic pairs generated",
);

// --- Session commits ---------------------------------------------------------------------------

// The live choice committed on a session opened from the state: the state the
// browser's commit leads to (by fingerprint), nothing, or its refusal.
const commits = [];
for (const [n, each] of nextStates.entries()) {
  if (each.state === undefined || each.configuration === undefined || n % 3 !== 0) continue;
  const configuration = configurations[each.configuration];
  if (configuration.state !== each.state) continue;
  const reply = JSON.parse(each.replyJson);
  commits.push({
    catalog: configuration.catalog,
    state: each.state,
    live: configuration.live,
    autoPairs: each.autoPairs,
    words: each.words,
    expectedJson: json(
      reply.stateJson
        ? { stateHash: projectFingerprint(JSON.parse(reply.stateJson)) }
        : reply.unchanged
          ? { unchanged: true }
          : reply,
    ),
  });
}
for (const each of configurations.filter((c) => JSON.parse(c.replyJson).error).slice(0, 2))
  commits.push({
    catalog: each.catalog,
    state: each.state,
    live: each.live,
    autoPairs: policies.on,
    words: [],
    expectedJson: each.replyJson,
  });
{
  const none = configurations.find((c) => JSON.parse(c.replyJson).configurationJson === null);
  commits.push({
    catalog: none.catalog,
    state: none.state,
    live: none.live,
    autoPairs: policies.off,
    words: [],
    expectedJson: json({ unchanged: true }),
  });
}
const commitOutcomes = new Map();
for (const each of commits) {
  const expected = JSON.parse(each.expectedJson);
  const key = "stateHash" in expected ? "committed" : (expected.error ?? "unchanged");
  commitOutcomes.set(key, (commitOutcomes.get(key) ?? 0) + 1);
}
for (const key of ["committed", "unchanged", "orphaned-mixed-component"])
  assert.ok(commitOutcomes.get(key) > 0, `a ${key} commit`);

// --- Malformed requests ------------------------------------------------------------------------

const refusals = [
  { exchange: "choices", requestJson: '{"machinePresetId":1}' },
  { exchange: "choices", requestJson: '{"other":"x"}' },
  { exchange: "choices", requestJson: "[]" },
  { exchange: "match", requestJson: '{"options":[{"id":"x","name":"y"}],"query":"y"}' },
  { exchange: "select", requestJson: json({ live: { ...empty, heads: [{ presetId: "x" }] }, request: {} }) },
  { exchange: "select", requestJson: json({ live: empty, request: { filamentPresetIds: [1] } }) },
  { exchange: "select", requestJson: json({ live: { ...empty, profile: { machinePresetId: "x" } }, request: {} }) },
  { exchange: "names", requestJson: json({ live: empty, machine: "u1", process: "" }) },
  { exchange: "default", requestJson: json({ live: { ...empty, nozzles: [0.4] } }) },
  { exchange: "configuration", requestJson: json({ live: u1, stateJson: "{}" }) },
  { exchange: "configuration", requestJson: json({ live: u1, stateJson: "not json" }) },
  { exchange: "next", requestJson: json({ autoPairs: { enabled: "yes", confirmedCounts: [] }, configurationJson: "{}", stateJson: json(fresh) }) },
  { exchange: "next", requestJson: json({ autoPairs: policies.off, configurationJson: "{}", stateJson: json(fresh) }) },
  { exchange: "next", requestJson: json({ autoPairs: policies.off, configurationJson: json({ config: {}, filaments: { mixed: [] }, printer: {} }), stateJson: json(fresh) }) },
];
const exchanges = {
  choices: (r) => slicingChoicesExchange(catalogs.bundled, r),
  match: presetMatchExchange,
  select: (r) => profileSelectionExchange(catalogs.bundled, r),
  names: (r) => profileSelectionByNamesExchange(catalogs.bundled, r),
  default: (r) => defaultProfileSelectionExchange(catalogs.bundled, r),
  configuration: (r) => slicingConfigurationExchange(catalogs.bundled, r),
  next: (r) => nextSlicingStateExchange(r, []),
};
for (const refusal of refusals) assert.throws(() => exchanges[refusal.exchange](refusal.requestJson), /invalid_request/);

// --- Output ------------------------------------------------------------------------------------

/**
 * A large reply is pinned by the SHA-256 of its UTF-8 text: a replay feeds
 * its own replies forward (a configuration into the next state, a next state
 * into the one after), so each is checked before it is used.
 */
const pinned = ({ replyJson, ...rest }) =>
  replyJson.length <= 8192
    ? { ...rest, replyJson }
    : { ...rest, replySha256: createHash("sha256").update(replyJson).digest("hex"), replyLength: replyJson.length };

const sources = [
  "tools/cross-platform/slicing-configuration-vectors.mjs",
  "web/src/workspace/CatalogSlicingConfiguration.ts",
  "web/src/workspace/CatalogSlicingConfigurationExchange.ts",
  "web/src/workspace/FilamentPalette.ts",
  "web/src/project/filaments/autoPairReconciliation.ts",
  "web/src/project/filaments/autoPairProjection.ts",
  "web/src/project/filaments/filamentPigmentMixer.ts",
  "web/src/project/filaments/filamentMixerModel.ts",
  "web/src/project/settingsOverrides.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/validation.ts",
  "web/src/slicer/ProfileLoader.ts",
  "web/src/settings/presets/PresetGraph.ts",
  "testdata/cross-platform/project-model-vectors.json",
  catalogPath,
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    syntheticCatalogJson: json(synthetic),
    states: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, json(state)])),
    choices,
    matches,
    selections,
    configurations: configurations.map(pinned),
    nextStates: nextStates.map(pinned),
    commits,
    refusals,
  }) + "\n";
const path = new URL("testdata/cross-platform/slicing-configuration-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Slicing configuration reference drift");
const describe = (counts) => [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
console.log(
  `Slicing configuration references: ${choices.length} choices, ${matches.length} matches, ` +
    `${selections.length} selections, ${configurations.length} configurations (${describe(outcomes(configurations))}), ` +
    `${nextStates.length} next states (${describe(nextOutcomes)}), ${commits.length} commits (${describe(commitOutcomes)}), ` +
    `${refusals.length} refusals.`,
);
