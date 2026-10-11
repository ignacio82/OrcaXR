// Virtual filament library references from the production browser: the
// library a project shows (`virtualFilamentLibraryModel.ts` over the
// adapter's projection), the author dialog's opening fields and everything it
// computes from its fields in each mode (issues, previews, the validated
// draft, the Match ranking, the triangle picker), the pinned Match search
// (`colorMatchSearch.ts`, through the adapter's candidates) and each library
// edit's step (`VirtualFilamentMutation.ts`, as `CanonicalWorkspaceController`
// executes it), through `VirtualFilamentExchange.ts`; with the modules beneath
// them — the Cycle grammar, the pinned authoring projection and ranking,
// ΔE2000 in binary64 and float-staged, the sequential pigment blend and the
// canonical recipe. States derive from the browser fixture: heads in engine
// order with mixed, disabled and uncategorized materials, colours in either
// case and with alpha, every mode's recipe, a tombstone, a legacy recipe, a
// referenced recipe, an automatic pair, eleven heads for bracketed Cycle
// tokens, a library that cannot be shown and labels that once hid it. A journey runs the browser's
// library adapter over the controller on the state's canonical 3MF — add a
// recipe in each mode (the Match one from the search), edit, duplicate,
// disable, enable, delete unreferenced and referenced, and a refusal —
// recording each step's fields, draft, hash and undo label, then undoes
// every entry. Replayed by Rust, WASM and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { createFullSpectrumMixedFilament } from "../../web/src/project/filaments/fullSpectrumRecipe.ts";
import { parseManualCyclePattern } from "../../web/src/project/filaments/manualCyclePattern.ts";
import {
  colorDeltaE2000,
  projectMixedFilamentAuthoring,
  rankColorMatchCandidates,
} from "../../web/src/project/filaments/mixedFilamentAuthoring.ts";
import {
  pinnedColorDeltaE2000,
  searchSuppliedPaletteColorMatch,
} from "../../web/src/project/filaments/colorMatchSearch.ts";
import { blendMultiFilamentPigment } from "../../web/src/project/filaments/filamentPigmentMixer.ts";
import { CanonicalVirtualFilamentLibraryAdapter } from "../../web/src/ui/dom/CanonicalVirtualFilamentLibraryAdapter.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import {
  readDraft,
  virtualFilamentFormDefaultsExchange,
  virtualFilamentFormExchange,
  virtualFilamentLibraryExchange,
  virtualFilamentMatchSearchExchange,
  virtualFilamentMutationExchange,
  virtualFilamentTriangleExchange,
} from "../../web/src/workspace/VirtualFilamentExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";
const json = (value) => canonicalStringify(value);

// --- States ------------------------------------------------------------------------------------

const fixture = createProjectFixture();
const ids = new UuidIdSource(seededRandom(0xf11d));
const physical = (name, toolId, material, color, extra = {}) => ({
  id: ids.next("physical-filament"),
  name,
  toolId,
  material,
  color,
  config: {},
  enabled: true,
  ...extra,
});
const rich = structuredClone(fixture.state);
const [crimson, ocean] = rich.filaments.physical;
crimson.name = "Crimson PLA";
ocean.name = "Ocean PLA";
ocean.color = "#0000FF";
const lemon = physical("Lemon PLA-CF", 2, "pla-cf", "#ffff00");
const night = physical("Night PETG", 3, "PETG", "#000000");
const spare = physical("Spare PLA", 4, "PLA", "#FFFFFF", { enabled: false });
const mystery = physical("", 5, "", "#808080");
const clear = physical("Clear PC", 6, " pc ", "#C0C0C0AA");
rich.printer.toolCount = 7;
rich.filaments.physical = [crimson, ocean, lemon, night, spare, mystery, clear];
const recipe = (name, draft, extra = {}) => {
  const filament = createFullSpectrumMixedFilament(ids.next("mixed-filament"), rich.filaments.physical, {
    name,
    displayColor: "#777777",
    ...draft,
  });
  Object.assign(filament, extra);
  return filament;
};
const sunset = recipe("Sunset", { mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 30 });
const triad = recipe("Triad", {
  mode: "ratio",
  componentFilamentIds: [crimson.id, ocean.id, lemon.id],
  mixBPercent: 50,
  triangleWeightsPercent: [50, 30.5, 20],
  componentASurfaceOffsetMm: 0.25,
  componentBSurfaceOffsetMm: -1.5,
});
const stripes = recipe("Stripes", {
  mode: "cycle",
  manualPatternGroups: [[crimson.id, ocean.id, ocean.id], [lemon.id]],
  displayColor: "#123abc",
});
const plum = recipe("Plum", {
  mode: "match",
  components: [
    { filamentId: crimson.id, weight: 55 },
    { filamentId: ocean.id, weight: 45 },
  ],
  targetColor: "#800080",
  minComponentPercent: 10,
});
const autumn = recipe("Autumn", {
  mode: "match",
  components: [
    { filamentId: crimson.id, weight: 20 },
    { filamentId: lemon.id, weight: 50 },
    { filamentId: clear.id, weight: 30 },
  ],
  targetColor: "#c08040",
  minComponentPercent: 5,
});
const dusk = recipe("  Dusk", {
  mode: "gradient",
  componentFilamentIds: [ocean.id, lemon.id],
  direction: "b-to-a",
  localZMaxSublayers: 4,
});
const resting = recipe("Resting", { mode: "ratio", componentFilamentIds: [ocean.id, lemon.id], mixBPercent: 0 }, { enabled: false });
const gone = recipe("Gone", { mode: "ratio", componentFilamentIds: [crimson.id, lemon.id], mixBPercent: 100 });
gone.fullSpectrum.deleted = true;
const paired = recipe("Auto pair", { mode: "ratio", componentFilamentIds: [crimson.id, clear.id], mixBPercent: 50 });
paired.fullSpectrum.originAuto = true;
// The fixture's "Purple mix" keeps no FullSpectrum state: listed nowhere in the library.
rich.filaments.mixed.push(sunset, triad, stripes, plum, autumn, dusk, resting, gone, paired);
// A recipe the model references: the fixture object's own filament.
rich.plates[0].objects[0].filamentId = stripes.id;
assertValidProjectState(rich);

// Eleven heads: bracketed Cycle tokens and slash-written gradient IDs.
const wide = structuredClone(fixture.state);
wide.printer.toolCount = 11;
wide.filaments.mixed = [];
wide.plates[0].objects[0].volumes[0].annotations.color = [];
for (let tool = 2; tool < 11; tool += 1) {
  wide.filaments.physical.push(physical(`Head ${tool + 1}`, tool, tool % 3 === 0 ? "PLA-CF" : "PLA", `#${(tool * 0x151515).toString(16).padStart(6, "0").slice(-6)}`));
}
const wideHeads = wide.filaments.physical;
wide.filaments.mixed.push(
  createFullSpectrumMixedFilament(ids.next("mixed-filament"), wideHeads, {
    name: "Ten and eleven",
    displayColor: "#445566",
    mode: "cycle",
    manualPatternGroups: [[wideHeads[9].id, wideHeads[10].id, wideHeads[0].id], [wideHeads[2].id]],
  }),
  createFullSpectrumMixedFilament(ids.next("mixed-filament"), wideHeads, {
    name: "Wide triad",
    displayColor: "#556677",
    mode: "ratio",
    componentFilamentIds: [wideHeads[10].id, wideHeads[1].id, wideHeads[9].id],
    mixBPercent: 50,
    triangleWeightsPercent: [1, 1, 1],
  }),
  createFullSpectrumMixedFilament(ids.next("mixed-filament"), wideHeads, {
    name: "Wide match",
    displayColor: "#667788",
    mode: "match",
    components: [
      { filamentId: wideHeads[3].id, weight: 40 },
      { filamentId: wideHeads[10].id, weight: 35 },
      { filamentId: wideHeads[4].id, weight: 25 },
    ],
    targetColor: "556677",
    minComponentPercent: 0,
  }),
);
assertValidProjectState(wide);

// A library that cannot be shown: a recipe's colour. And odd labels that once hid the whole
// library: a name the projection cuts to a trailing space, a head with a blank name and material.
const badColor = structuredClone(rich);
badColor.filaments.mixed.find((filament) => filament.name === "Sunset").displayColor = "purple";
assertValidProjectState(badColor);
const labels = structuredClone(rich);
labels.filaments.mixed.find((filament) => filament.name === "Sunset").name = `${"n".repeat(119)} tail`;
labels.filaments.physical[5].name = "   ";
labels.filaments.physical[5].material = " \t";
assertValidProjectState(labels);

// One head: nothing selectable; no heads at all.
const single = structuredClone(fixture.state);
single.filaments.physical = [single.filaments.physical[0]];
single.filaments.mixed = [];
single.plates[0].objects[0].volumes[0].annotations.color = [];
assertValidProjectState(single);
const empty = createEmptyProject({ idSource: new UuidIdSource(seededRandom(0xf11e)), now: "2026-10-10T00:00:00.000Z" });
assertValidProjectState(empty);

// The journey's 3MF: whole characters only.
const journeyState = structuredClone(rich);
assertValidProjectState(journeyState);

const states = { rich, wide, badColor, labels, single, empty };

// --- Library and dialog -----------------------------------------------------------------------

const libraries = [];
const libraryOf = {};
for (const [name, state] of Object.entries(states)) {
  const replyJson = virtualFilamentLibraryExchange(state, "{}");
  libraries.push({ state: name, requestJson: "{}", replyJson });
  libraryOf[name] = JSON.parse(replyJson);
}
assert.ok(libraryOf.badColor.error && !libraryOf.labels.error && libraryOf.rich.mixedRows.length === 8);
assert.equal(libraryOf.labels.mixedRows[0].draft.name, "n".repeat(119));
assert.equal(libraryOf.labels.physicalChoices[5].name, "Head 6");
assert.equal(libraryOf.rich.mixedRows.find((row) => row.draft.name === "Dusk").draft.mode, "gradient");

const defaults = [];
const formOf = {};
function defaultsFor(stateName, operation, filamentId) {
  const requestJson = json({ filamentId: filamentId ?? null, library: libraryOf[stateName], operation });
  const replyJson = virtualFilamentFormDefaultsExchange(requestJson);
  defaults.push({ requestJson, replyJson });
  return JSON.parse(replyJson);
}
for (const stateName of ["rich", "wide", "single", "empty"]) {
  formOf[`${stateName}:add`] = defaultsFor(stateName, "add");
  for (const row of libraryOf[stateName].mixedRows) {
    formOf[`${stateName}:edit:${row.draft.name}`] = defaultsFor(stateName, "edit", row.id);
    formOf[`${stateName}:duplicate:${row.draft.name}`] = defaultsFor(stateName, "duplicate", row.id);
  }
}
{
  const long = structuredClone(libraryOf.rich);
  long.mixedRows[0].draft.name = "x".repeat(118);
  defaults.push({
    requestJson: json({ filamentId: long.mixedRows[0].id, library: long, operation: "duplicate" }),
    replyJson: virtualFilamentFormDefaultsExchange(json({ filamentId: long.mixedRows[0].id, library: long, operation: "duplicate" })),
  });
  assert.equal(JSON.parse(defaults.at(-1).replyJson).name, `${"x".repeat(115)} copy`);
}

const validations = [];
function validate(stateName, form, search = null, library = libraryOf[stateName]) {
  const requestJson = json({ form, library, search });
  const replyJson = virtualFilamentFormExchange(requestJson);
  validations.push({ requestJson, replyJson });
  return JSON.parse(replyJson);
}
const patch = (form, change) => {
  const next = structuredClone(form);
  change(next);
  return next;
};
const addRich = formOf["rich:add"];
const id = (head) => head.id;
// Common fields.
for (const name of ["", " Lead", "Trail ", "x".repeat(120), "x".repeat(121), "🌈 rainbow", "lone \udc00 unit"])
  validate("rich", patch(addRich, (form) => (form.name = name)));
for (const color of ["#ABCDEF", "#abcdef", "#12345", "#1234567", "123456", "#GGGGGG", " #123456", "#ﬀ0000"])
  validate("rich", patch(addRich, (form) => (form.displayColor = color)));
for (const offset of ["", " ", "2", "-2", "2.0001", "-2.5", "abc", "1e0", "0x1", "Infinity", "-0", "0.125", " 1 ", "1_0"])
  validate("rich", patch(addRich, (form) => (form.componentASurfaceOffsetMm = offset)));
validate("rich", patch(addRich, (form) => (form.componentBSurfaceOffsetMm = "-3")));
// Ratio, two heads.
for (const mix of ["", "50", "0", "100", "101", "-1", "33", "1.5", "007", "-0", "1e2", " 5", "9007199254740993"])
  validate("rich", patch(addRich, (form) => (form.ratio.mixBPercent = mix)));
for (const [a, b] of [
  [crimson, ocean],
  [ocean, crimson],
  [crimson, crimson],
  [crimson, spare],
  [crimson, mystery],
  [crimson, night],
  [lemon, clear],
])
  validate("rich", patch(addRich, (form) => (form.ratio.componentIds = [id(a), id(b), id(lemon)])));
validate("rich", patch(addRich, (form) => (form.ratio.componentIds = ["", id(ocean), id(lemon)])));
validate("rich", patch(addRich, (form) => (form.ratio.componentIds = ["import:physical:none", id(ocean)])));
// Ratio, three heads.
for (const weights of [
  ["34", "33", "33"],
  ["1", "0", "0"],
  ["0", "0", "0"],
  ["-1", "50", "50"],
  ["a", "1", "1"],
  ["1e2", "50", "25"],
  ["90", "5", "5"],
  ["10.5", "20.25", "30.125"],
  ["", "1", "1"],
])
  validate(
    "rich",
    patch(addRich, (form) => {
      form.ratio.componentCount = 3;
      form.ratio.triangleWeights = weights;
    }),
  );
validate("rich", patch(addRich, (form) => {
  form.ratio.componentCount = 3;
  form.ratio.componentIds = [id(crimson), id(ocean)];
}));
validate("rich", patch(addRich, (form) => {
  form.ratio.componentCount = 3;
  form.ratio.componentIds = [id(crimson), id(ocean), id(crimson)];
}));
// Cycle.
for (const pattern of [
  "",
  "12",
  "1,2",
  "12,,3",
  "1/2/3",
  "[3]1",
  "1/[3]",
  "0",
  "01",
  "[]",
  "[1",
  "a",
  "😀",
  "\ud800",
  "1 2",
  "5",
  "6",
  "4",
  "100",
  "[100]",
  "/1",
  "1/",
  "1//2",
  ",",
  "ﬀ",
  "[07]",
  "[1a]",
  "1/02",
  "11111",
  "1,2,3,4,7",
  "1234",
  "7",
  "1/1/1",
])
  validate("rich", patch(addRich, (form) => {
    form.mode = "cycle";
    form.cycle.manualPattern = pattern;
  }));
const addWide = formOf["wide:add"];
for (const pattern of ["[10][11]", "10/11/1", "[10]1,2/[11]", "[12]", "1/12", "[11]5[10]"])
  validate("wide", patch(addWide, (form) => {
    form.mode = "cycle";
    form.cycle.manualPattern = pattern;
  }));
// Gradient.
for (const sublayers of ["", "1", "2", "10", "9007199254740993", "-3", "2.5", " 2"])
  validate("rich", patch(addRich, (form) => {
    form.mode = "gradient";
    form.gradient.localZMaxSublayers = sublayers;
  }));
for (const [direction, a, b] of [
  ["a-to-b", crimson, ocean],
  ["b-to-a", crimson, ocean],
  ["a-to-b", crimson, crimson],
  ["a-to-b", spare, ocean],
  ["b-to-a", lemon, clear],
])
  validate("rich", patch(addRich, (form) => {
    form.mode = "gradient";
    form.gradient.direction = direction;
    form.gradient.componentIds = [id(a), id(b)];
  }));
validate("rich", patch(addRich, (form) => {
  form.mode = "gradient";
  form.gradient.componentIds = ["", id(ocean)];
}));
// Match: the library's own saved candidates, then the pinned search's.
const matchSearches = [];
function search(stateName, targetColor, minComponentPercent, library = libraryOf[stateName]) {
  const requestJson = json({ library, minComponentPercent, targetColor });
  const replyJson = virtualFilamentMatchSearchExchange(requestJson);
  matchSearches.push({ requestJson, replyJson });
  return JSON.parse(replyJson).candidates;
}
const matchRich = patch(addRich, (form) => (form.mode = "match"));
for (const target of ["#808080", "#80808", "red", "#ﬀ0000", " #800080", "800080", "#800080 "])
  validate("rich", patch(matchRich, (form) => (form.match.targetColor = target)));
for (const minimum of ["", "0", "10", "50", "51", "-1", "1.5"])
  validate("rich", patch(matchRich, (form) => (form.match.minComponentPercent = minimum)));
const plumRow = libraryOf.rich.mixedRows.find((row) => row.draft.name === "Plum");
const autumnRow = libraryOf.rich.mixedRows.find((row) => row.draft.name === "Autumn");
for (const selected of [`persisted:${plumRow.id}`, `persisted:${autumnRow.id}`, "persisted:none"])
  for (const minimum of ["0", "10", "25"])
    validate("rich", patch(matchRich, (form) => {
      form.match.selectedCandidateId = selected;
      form.match.minComponentPercent = minimum;
    }));
for (const [target, minimum] of [
  ["#808080", 10],
  ["#FF8000", 0],
  ["#123456", 50],
  ["#FFFFFF", 25],
  ["#000000", 1],
  ["#00FF00", 5],
  ["#7F007F", 0],
]) {
  const candidates = search("rich", target, minimum);
  assert.ok(candidates.length >= 1);
  for (const selected of [undefined, candidates[0].id, candidates.at(-1).id])
    validate(
      "rich",
      patch(matchRich, (form) => {
        form.match.targetColor = target;
        form.match.minComponentPercent = String(minimum);
        if (selected) form.match.selectedCandidateId = selected;
      }),
      { candidates, status: "ready" },
    );
}
validate("rich", patch(matchRich, (form) => (form.match.targetColor = "#123456")), { candidates: [], status: "pending" });
validate("rich", patch(matchRich, (form) => (form.match.targetColor = "#123456")), {
  candidates: [],
  error: "Worker crashed",
  status: "error",
});
validate("rich", patch(matchRich, (form) => (form.match.targetColor = "#123456")), { candidates: [], status: "error" });
for (const [target, minimum] of [
  ["#556677", 0],
  ["#A0A0A0", 20],
])
  search("wide", target, minimum);
search("single", "#808080", 10);
search("empty", "#808080", 10);
// The rows' own recipes, reopened: each validates to its saved draft (save for duplicates' names).
for (const [key, form] of Object.entries(formOf)) {
  const [stateName] = key.split(":");
  validate(stateName, form);
}
// No selectable heads at all.
validate("single", formOf["single:add"]);
validate("empty", patch(formOf["empty:add"], (form) => (form.mode = "match")));

const triangles = [];
for (const [x, y] of [
  [120, 18],
  [18, 198],
  [222, 198],
  [120, 138],
  [0, 0],
  [240, 216],
  [-50, 300],
  [120.5, 100.25],
  [1e9, -1e9],
  [60, 108],
  [119.99, 197.99],
  [1e308, -1e308],
]) {
  const requestJson = json({ x, y });
  triangles.push({ requestJson, replyJson: virtualFilamentTriangleExchange(requestJson) });
}

// --- Library edits -----------------------------------------------------------------------------

const mutations = [];
function mutate(stateName, request) {
  const requestJson = json(request);
  const replyJson = virtualFilamentMutationExchange(states[stateName], requestJson);
  mutations.push({ state: stateName, requestJson, replyJson });
  return JSON.parse(replyJson);
}
const draftOf = (stateName, form, searchState = null) => {
  const reply = validate(stateName, form, searchState);
  assert.ok(reply.draft, JSON.stringify(reply.issues));
  return reply.draft;
};
const newId = () => ids.next("mixed-filament");
const ratioDraft = draftOf("rich", patch(addRich, (form) => (form.name = "New sunset")));
const triadDraft = draftOf("rich", patch(addRich, (form) => {
  form.ratio.componentCount = 3;
  form.ratio.triangleWeights = ["10.5", "20.25", "30.125"];
  form.componentBSurfaceOffsetMm = "0.5";
}));
const cycleDraft = draftOf("rich", patch(addRich, (form) => {
  form.mode = "cycle";
  form.cycle.manualPattern = "21,3/1,7";
}));
const gradientDraft = draftOf("rich", patch(addRich, (form) => {
  form.mode = "gradient";
  form.gradient.componentIds = [id(ocean), id(clear)];
  form.gradient.localZMaxSublayers = "6";
}));
const searched = search("rich", "#6A3D9A", 10);
const matchDraft = draftOf(
  "rich",
  patch(matchRich, (form) => {
    form.match.targetColor = "#6a3d9a";
    form.match.selectedCandidateId = searched[0].id;
  }),
  { candidates: searched, status: "ready" },
);
const wideDraft = draftOf("wide", patch(addWide, (form) => {
  form.mode = "cycle";
  form.cycle.manualPattern = "[10]1,2/[11]";
}));
for (const draft of [ratioDraft, triadDraft, cycleDraft, gradientDraft, matchDraft])
  mutate("rich", { draft, newId: newId(), operation: "add" });
mutate("wide", { draft: wideDraft, newId: newId(), operation: "add" });
for (const row of libraryOf.rich.mixedRows) {
  mutate("rich", { draft: row.draft, filamentId: row.id, operation: "edit" });
  mutate("rich", { draft: { ...row.draft, name: `${row.draft.name} copy` }, newId: newId(), operation: "duplicate", sourceFilamentId: row.id });
  mutate("rich", { enabled: !row.enabled, filamentId: row.id, operation: "set-enabled" });
  mutate("rich", { filamentId: row.id, operation: "delete" });
}
mutate("rich", { draft: gradientDraft, filamentId: libraryOf.rich.mixedRows[0].id, operation: "edit" });
// Refusals: an incompatible pair, a disabled head, an unknown head, an unknown recipe, a blank name.
mutate("rich", { draft: { ...ratioDraft, components: [{ filamentId: crimson.id, toolId: 1 }, { filamentId: night.id, toolId: 4 }] }, newId: newId(), operation: "add" });
mutate("rich", { draft: { ...ratioDraft, components: [{ filamentId: crimson.id, toolId: 1 }, { filamentId: spare.id, toolId: 5 }] }, newId: newId(), operation: "add" });
mutate("rich", { draft: { ...ratioDraft, components: [{ filamentId: crimson.id, toolId: 1 }, { filamentId: "import:physical:none", toolId: 9 }] }, newId: newId(), operation: "add" });
mutate("rich", { draft: ratioDraft, filamentId: "import:mixed:none", operation: "edit" });
mutate("rich", { enabled: false, filamentId: "import:mixed:none", operation: "set-enabled" });
mutate("rich", { filamentId: "import:mixed:none", operation: "delete" });
mutate("rich", { filamentId: gone.id, operation: "delete" });
mutate("rich", { draft: { ...ratioDraft, name: "   " }, newId: newId(), operation: "add" });
mutate("rich", { draft: { ...ratioDraft, displayColor: "#12" }, newId: newId(), operation: "add" });
mutate("rich", { draft: { ...cycleDraft, groups: [[1], []] }, newId: newId(), operation: "add" });
mutate("rich", { draft: { ...ratioDraft, componentASurfaceOffsetMm: 3 }, newId: newId(), operation: "add" });
mutate("single", { draft: ratioDraft, newId: newId(), operation: "add" });
const refusedEdits = mutations.filter((each) => JSON.parse(each.replyJson).error).length;
assert.ok(refusedEdits >= 12);
assert.ok(mutations.some((each) => JSON.parse(each.replyJson).outcome === "tombstoned"));
assert.ok(mutations.some((each) => JSON.parse(each.replyJson).outcome === "removed"));

// --- Malformed requests ------------------------------------------------------------------------

const refusals = [
  { exchange: "library", requestJson: "{" },
  { exchange: "library", requestJson: json({ x: 1 }) },
  { exchange: "defaults", requestJson: json({ filamentId: null, library: libraryOf.rich }) },
  { exchange: "defaults", requestJson: json({ filamentId: null, library: libraryOf.rich, operation: "edit" }) },
  { exchange: "defaults", requestJson: json({ filamentId: "missing", library: libraryOf.rich, operation: "edit" }) },
  { exchange: "defaults", requestJson: json({ filamentId: "x", library: libraryOf.rich, operation: "add" }) },
  { exchange: "defaults", requestJson: json({ filamentId: null, library: libraryOf.badColor, operation: "add" }) },
  { exchange: "form", requestJson: json({ form: addRich, library: libraryOf.rich }) },
  { exchange: "form", requestJson: json({ form: { ...addRich, mode: "pointillism" }, library: libraryOf.rich, search: null }) },
  { exchange: "form", requestJson: json({ form: { ...addRich, ratio: { ...addRich.ratio, componentCount: 4 } }, library: libraryOf.rich, search: null }) },
  { exchange: "form", requestJson: json({ form: addRich, library: libraryOf.rich, search: { candidates: [], status: "done" } }) },
  { exchange: "form", requestJson: json({ form: { ...addRich, name: 7 }, library: libraryOf.rich, search: null }) },
  { exchange: "triangle", requestJson: json({ x: 1 }) },
  { exchange: "triangle", requestJson: json({ x: "1", y: 2 }) },
  { exchange: "search", requestJson: json({ library: libraryOf.rich, minComponentPercent: "10", targetColor: "#808080" }) },
  { exchange: "mutation", requestJson: json({ operation: "rename", filamentId: plum.id }) },
  { exchange: "mutation", requestJson: json({ filamentId: plum.id, operation: "set-enabled" }) },
  { exchange: "mutation", requestJson: json({ draft: ratioDraft, operation: "add" }) },
  { exchange: "mutation", requestJson: json({ draft: { ...ratioDraft, mode: "cycle" }, newId: "x", operation: "add" }) },
  { exchange: "mutation", requestJson: json({ filamentId: plum.id, newId: "x", operation: "delete" }) },
];
const exchanges = {
  library: (request) => virtualFilamentLibraryExchange(rich, request),
  defaults: virtualFilamentFormDefaultsExchange,
  form: virtualFilamentFormExchange,
  triangle: virtualFilamentTriangleExchange,
  search: virtualFilamentMatchSearchExchange,
  mutation: (request) => virtualFilamentMutationExchange(rich, request),
};
for (const refusal of refusals)
  assert.throws(() => exchanges[refusal.exchange](refusal.requestJson), /invalid_request/, refusal.requestJson);

// --- What lies beneath (Rust only) -------------------------------------------------------------

let state = 0x5eed1234;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
};
const hex = () =>
  `#${Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0")}`;

const cycles = [];
for (const pattern of [
  "",
  "1",
  "12,34",
  "1,,2",
  ",1",
  "1,",
  "1/2,3",
  "[12]",
  "[099]",
  "[0]",
  "[9a]",
  "[",
  "1[2",
  "]",
  "x1",
  "😀1",
  "𐀀",
  "1/2/",
  "/",
  "1//",
  "99/100",
  "1234567890123456789012",
  "[1234567890123456789012]",
  "1/00",
  "1,2,3,4,5,6,7,8,9",
  "  1",
])
  for (const available of [null, [1, 2, 3, 4], [1, 3, 12, 99]]) {
    const result = parseManualCyclePattern(pattern, available ? { availableToolIds: available } : {});
    cycles.push({ requestJson: json({ availableToolIds: available, pattern }), replyJson: json(result) });
  }

const authoring = [];
const author = (input, physicalToolCount) => {
  const result = projectMixedFilamentAuthoring(input, { physicalToolCount });
  authoring.push({ requestJson: json({ input, physicalToolCount }), replyJson: json(result) });
};
for (const count of [1, 2, 4, 64, 65, 2.5])
  author({ mode: "ratio", componentIds: [1, 2], mixBPercent: 50 }, count);
for (const mix of [0, 1, 25, 33, 50, 64, 99, 100, 101, -1, 12.5])
  author({ mode: "ratio", componentIds: [2, 1], mixBPercent: mix }, 4);
for (const triangle of [[1, 1, 1], [100, 0, 0], [0, 0, 0], [5, 3, 2], [0.1, 0.1, 99.8], [1, 2], [1, -1, 1], [33.3, 33.3, 33.4]])
  author({ mode: "ratio", componentIds: [1, 3, 4], mixBPercent: 50, triangleWeightsPercent: triangle }, 4);
author({ mode: "ratio", componentIds: [1, 2], mixBPercent: 50, triangleWeightsPercent: [1, 1, 1] }, 4);
author({ mode: "ratio", componentIds: [1, 2, 3], mixBPercent: 50 }, 4);
for (const ids_ of [[1], [1, 1], [0, 2], [1, 5], [1.5, 2], [1, 2, 3, 4], [10, 11]])
  author({ mode: "ratio", componentIds: ids_, mixBPercent: 50 }, 11);
for (const [direction, sublayers] of [["a-to-b", 0], ["b-to-a", 2], ["a-to-b", 9], ["sideways", 2], ["a-to-b", -1], ["a-to-b", 2.5]])
  author({ mode: "gradient", componentIds: [2, 1], direction, localZMaxSublayers: sublayers }, 3);
for (const [components, target, minimum] of [
  [[[1, 50], [2, 50]], "#808080", 10],
  [[[1, 95], [2, 5]], "808080", 10],
  [[[1, 100], [2, 0]], "#808080", 0],
  [[[1, 1], [2, 2], [3, 3]], "#ABCDEF", 0],
  [[[3, 30], [1, 30], [2, 40]], "#abcdef", 20],
  [[[1, 70], [2, 20], [3, 10]], "#123456", 15],
  [[[1, 50], [2, 50], [3, 0]], "#123456", 0],
  [[[1, 25], [2, 25], [3, 25], [4, 25]], "#123456", 25],
  [[[1, 10], [2, 10], [3, 10], [4, 10], [5, 10]], "#123456", 0],
  [[[1, 1.5], [2, 2]], "#123456", 0],
  [[[1, 50], [2, 50]], "#12345", 0],
  [[[1, 50], [2, 50]], " ﬀ0000 ", 0],
  [[[1, 50], [2, 50]], "#808080", 51],
  [[[1, 0], [2, 0]], "#808080", 0],
  [[[1, -5], [2, 5]], "#808080", 0],
  [[[10, 50], [11, 50]], "#808080", 0],
  [[[11, 30], [10, 30], [2, 40]], "#808080", 0],
])
  author(
    { mode: "match", components: components.map(([toolId, weight]) => ({ toolId, weight })), targetColor: target, minComponentPercent: minimum },
    11,
  );

const rankings = [];
const rank = (input) => rankings.push({ requestJson: json(input), replyJson: json(rankColorMatchCandidates(input)) });
const candidate = (components, previewColor) => ({ components: components.map(([toolId, weight]) => ({ toolId, weight })), previewColor });
rank({ physicalToolCount: 4, targetColor: "#808080", minComponentPercent: 10, candidates: [] });
rank({
  physicalToolCount: 4,
  targetColor: "#808080",
  minComponentPercent: 10,
  candidates: [candidate([[1, 50], [2, 50]], "#7F7F7F"), candidate([[1, 40], [2, 30], [3, 30]], "#808080"), candidate([[3, 50], [4, 50]], "#808081")],
});
rank({
  physicalToolCount: 4,
  targetColor: "#FF0000",
  minComponentPercent: 0,
  candidates: [candidate([[1, 40], [2, 30], [3, 30]], "#FE0000"), candidate([[1, 50], [2, 50]], "#00FF00"), candidate([[2, 50], [3, 50]], "#FD0101")],
});
rank({ physicalToolCount: 4, targetColor: "red", minComponentPercent: 0, candidates: [candidate([[1, 50], [2, 50]], "#FE0000")] });
rank({ physicalToolCount: 4, targetColor: "#808080", minComponentPercent: 60, candidates: [] });
rank({
  physicalToolCount: 4,
  targetColor: "#808080",
  minComponentPercent: 20,
  candidates: [candidate([[1, 90], [2, 10]], "#808080"), candidate([[1, 50], [2, 50]], "#zz0000"), candidate([[1, 50], [2, 50]], "#808080")],
});
for (let round = 0; round < 40; round += 1) {
  const target = hex();
  const candidates = Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
    const three = random() < 0.4;
    const first = 1 + Math.floor(random() * 30);
    const second = 1 + Math.floor(random() * (three ? 30 : 70));
    return three ? candidate([[1, first], [2, second], [3, 100 - first - second]], hex()) : candidate([[1, 100 - second], [4, second]], hex());
  });
  rank({ physicalToolCount: 4, targetColor: target, minComponentPercent: Math.floor(random() * 11), candidates });
}

const deltas = [];
for (let pair = 0; pair < 3000; pair += 1) {
  const first = pair < 16 ? ["#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#808080", "#010101", "#FEFEFE"][pair % 8] : hex();
  const second = pair < 16 ? ["#000000", "#FFFFFF", "#7F7F7F", "#FF0001", "#0A0A0A", "#808080", "#000000", "#FFFFFF"][Math.floor(pair / 2) % 8] : hex();
  deltas.push([first, second, colorDeltaE2000(first, second), pinnedColorDeltaE2000(first, second)]);
}

const blends = [];
for (let round = 0; round < 400; round += 1) {
  const parts = Array.from({ length: 1 + Math.floor(random() * 5) }, () => [
    random() < 0.05 ? "not a colour" : hex(),
    random() < 0.1 ? 0 : random() < 0.1 ? -3 : Math.floor(random() * 100) + (random() < 0.3 ? random() : 0),
  ]);
  blends.push([parts, blendMultiFilamentPigment(parts)]);
}
blends.push([[], blendMultiFilamentPigment([])]);

const paletteSearches = [];
const paletteSearch = (input) => {
  const result = searchSuppliedPaletteColorMatch(input);
  paletteSearches.push({ requestJson: json(input), replyJson: json(result) });
  return result;
};
const palette = (entries) => entries.map(([color, filamentType]) => ({ color, filamentType }));
const fourPla = palette([["#FF0000", "PLA"], ["#0000FF", "PLA"], ["#FFFF00", "PLA-CF"], ["#FFFFFF", "PLA"]]);
for (const [target, minimum] of [["#808080", 10], ["#7F007F", 0], ["#00FF00", 5], ["#FFA500", 25], ["#000000", 50], ["#FFFFFF", 0]])
  paletteSearch({ palette: fourPla, targetColor: target, minComponentPercent: minimum });
// The pair at 50 % is exact: the early exit.
paletteSearch({ palette: fourPla, targetColor: searchSuppliedPaletteColorMatch({ palette: fourPla, targetColor: "#808080", minComponentPercent: 10 }).bestPair.previewColor, minComponentPercent: 10 });
const ten = palette(Array.from({ length: 10 }, (_, index) => [hex(), index % 4 === 3 ? "PETG" : index % 4 === 2 ? "PC" : "PLA"]));
for (const target of ["#336699", "#996633", "#CCCCCC"]) paletteSearch({ palette: ten, targetColor: target, minComponentPercent: 10 });
paletteSearch({ palette: palette([["#FF0000", "PLA"], ["#00FF00", "PETG"]]), targetColor: "#808000", minComponentPercent: 10 });
paletteSearch({ palette: palette([["#FF0000", "PLA"], ["#00FF00", "PVA"], ["#0000FF", "BVOH"]]), targetColor: "#008080", minComponentPercent: 10 });
paletteSearch({ palette: palette([["#FF0000", "PLA"]]), targetColor: "#808080", minComponentPercent: 10 });
paletteSearch({ palette: palette([["#FF0000", "PLA"], ["#00FF0", "PLA"], ["#0000FF", "NYLON"]]), targetColor: "#80808", minComponentPercent: 51 });
paletteSearch({ palette: palette([[" ff0000 ", " pla "], ["#00FF00", "pla"]]), targetColor: "808000", minComponentPercent: 0 });
paletteSearch({ palette: fourPla, targetColor: "#808080", minComponentPercent: 1.5 });

const recipes = [];
const recipePhysical = rich.filaments.physical;
const recipeCase = (draft, upstream) => {
  let replyJson;
  try {
    replyJson = json(createFullSpectrumMixedFilament("6f0c2c4e-1b7a-4d8e-9f00-0a1b2c3d4e5f", recipePhysical, draft, upstream));
  } catch (error) {
    replyJson = json({ error: error.message });
  }
  recipes.push({ requestJson: json({ draft, upstreamStableId: upstream ?? null }), replyJson });
};
const base = { name: " Recipe ", displayColor: "#abcdef80" };
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [ocean.id, crimson.id], mixBPercent: 40 });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [ocean.id, crimson.id, clear.id], mixBPercent: 40, triangleWeightsPercent: [2, 1, 1] });
recipeCase({ ...base, mode: "cycle", manualPatternGroups: [[lemon.id, lemon.id, clear.id], [ocean.id]] });
recipeCase({ ...base, mode: "cycle", manualPatternGroups: [[clear.id]] });
recipeCase({ ...base, mode: "cycle", manualPatternGroups: [[crimson.id, ocean.id], [lemon.id, crimson.id, clear.id]], enabled: false });
recipeCase({ ...base, mode: "match", components: [{ filamentId: crimson.id, weight: 30 }, { filamentId: ocean.id, weight: 70 }], targetColor: "800080", minComponentPercent: 10 });
recipeCase({ ...base, mode: "match", components: [{ filamentId: crimson.id, weight: 30 }, { filamentId: ocean.id, weight: 30 }, { filamentId: lemon.id, weight: 40 }], targetColor: "#aa00aa", minComponentPercent: 0 });
recipeCase({ ...base, mode: "gradient", componentFilamentIds: [lemon.id, ocean.id], direction: "a-to-b", localZMaxSublayers: 0 });
recipeCase({ ...base, mode: "gradient", componentFilamentIds: [lemon.id, ocean.id], direction: "b-to-a", localZMaxSublayers: 7, componentASurfaceOffsetMm: 2, componentBSurfaceOffsetMm: -2 });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, night.id], mixBPercent: 40 });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, mystery.id], mixBPercent: 40 });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, spare.id], mixBPercent: 40 });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40, componentASurfaceOffsetMm: 2.5 });
recipeCase({ ...base, name: "  ", mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40 });
recipeCase({ ...base, displayColor: "teal", mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40 });
recipeCase({ ...base, mode: "cycle", manualPatternGroups: [[crimson.id], []] });
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40 }, "18446744073709551615");
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40 }, "18446744073709551616");
recipeCase({ ...base, mode: "ratio", componentFilamentIds: [crimson.id, ocean.id], mixBPercent: 40 }, "007");

// --- Journey -----------------------------------------------------------------------------------

const assets = new InMemoryAssetRepository();
assets.put(fixture.asset.descriptor, fixture.asset.bytes);
const serializer = new Bbs3mfProjectSerializer();
const source = new EditorSession({ initialState: journeyState, assets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const archive = serialized.bytes;
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0xf11f)),
  clock: () => "2026-10-10T00:00:00.000Z",
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(archive), []);
const adapter = new CanonicalVirtualFilamentLibraryAdapter({
  getSnapshot: () => controller.getVirtualFilamentLibrarySnapshot(),
  subscribe: () => () => {},
  mutate: (request) => controller.mutateVirtualFilament(request),
  searchMatch: async (input) => searchSuppliedPaletteColorMatch(input),
  cancelMatchSearch: () => {},
});
const observe = () => {
  const summary = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: summary.history.undoCount,
    undoLabel: summary.history.undoLabel ?? null,
  };
};
const opened = observe();
assert.equal(opened.undoCount, 0);
const currentState = () => controller.session.project.getSnapshot().state;
const currentLibrary = () => virtualFilamentLibraryExchange(currentState(), "{}");
const steps = [];
/**
 * One library edit as the browser's dialog makes it: the fields opened for
 * `operation` on the row named `rowName`, changed by `change`, the Match
 * search when asked, validated, and submitted through the adapter.
 */
async function step(operation, rowName, change = () => {}, matchSearch = false) {
  const libraryJson = currentLibrary();
  const library = JSON.parse(libraryJson);
  // The adapter's snapshot is the exchange's answer for the state the controller holds.
  const snapshot = adapter.getSnapshot();
  assert.equal(json(library.physicalChoices), json(snapshot.physicalChoices));
  assert.equal(json(library.matchCandidates), json(snapshot.matchCandidates));
  assert.deepEqual(
    library.mixedRows.map((entry) => [entry.id, entry.enabled, entry.dependencyLabels ?? []]),
    snapshot.mixedRows.map((entry) => [entry.id, entry.enabled, [...(entry.dependencyLabels ?? [])]]),
  );
  const row = rowName ? library.mixedRows.find((entry) => entry.draft.name === rowName) : undefined;
  if (rowName) assert.ok(row, rowName);
  const stateBefore = currentState();
  const record = { operation, filamentId: row?.id ?? null, libraryJson, stateJson: json(stateBefore) };
  const before = new Set(library.mixedRows.map((entry) => entry.id));
  const guard = { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash };
  let refusal = null;
  try {
    if (operation === "add" || operation === "edit" || operation === "duplicate") {
      const form = JSON.parse(
        virtualFilamentFormDefaultsExchange(json({ filamentId: row?.id ?? null, library, operation })),
      );
      record.openedJson = json(form);
      change(form);
      let searchState = null;
      if (matchSearch) {
        const ask = JSON.parse(virtualFilamentFormExchange(json({ form, library, search: null }))).matchSearch;
        const candidates = JSON.parse(
          virtualFilamentMatchSearchExchange(json({ library, minComponentPercent: ask.minComponentPercent, targetColor: ask.targetColor })),
        ).candidates;
        // The adapter's own search answers the same candidates.
        assert.equal(json(await adapter.searchMatchCandidates({ ...guard, ...ask })), json(candidates));
        searchState = { candidates, status: "ready" };
        form.match.selectedCandidateId = candidates[0].id;
      }
      const validation = JSON.parse(virtualFilamentFormExchange(json({ form, library, search: searchState })));
      assert.ok(validation.draft, JSON.stringify(validation.issues));
      record.formJson = json(form);
      record.searchJson = json(searchState);
      record.draftJson = json(validation.draft);
      const draft = readDraft(validation.draft);
      if (operation === "add") await adapter.onAdd({ ...guard, draft });
      else if (operation === "edit") await adapter.onEdit({ ...guard, filamentId: row.id, draft });
      else await adapter.onDuplicate({ ...guard, sourceFilamentId: row.id, draft });
    } else if (operation === "set-enabled") {
      record.enabled = !row.enabled;
      await adapter.onSetEnabled({ ...guard, filamentId: row.id, enabled: !row.enabled, draft: readDraft(row.draft) });
    } else {
      await adapter.onDelete({ ...guard, filamentId: row.id, draft: readDraft(row.draft) });
    }
  } catch (error) {
    refusal = error.message;
  }
  const added = JSON.parse(currentLibrary()).mixedRows.filter((entry) => !before.has(entry.id));
  record.newId = added.length === 1 ? added[0].id : null;
  // The exchange plans the same step on the state it started from: the controller's label, or its refusal.
  const draft = record.draftJson ? JSON.parse(record.draftJson) : undefined;
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const request =
    operation === "add"
      ? { draft, newId: record.newId ?? placeholder, operation }
      : operation === "edit"
        ? { draft, filamentId: row.id, operation }
        : operation === "duplicate"
          ? { draft, newId: record.newId ?? placeholder, operation, sourceFilamentId: row.id }
          : operation === "set-enabled"
            ? { enabled: record.enabled, filamentId: row.id, operation }
            : { filamentId: row.id, operation };
  record.mutationRequestJson = json(request);
  record.mutationReplyJson = virtualFilamentMutationExchange(stateBefore, record.mutationRequestJson);
  const planned = JSON.parse(record.mutationReplyJson);
  const observed = observe();
  if (refusal === null) assert.equal(planned.label, observed.undoLabel, record.mutationReplyJson);
  else assert.equal(planned.error, refusal);
  steps.push({ ...record, refusal, ...observed });
}
await step("add", undefined, (form) => {
  form.name = "Journey ratio";
  form.ratio.mixBPercent = "25";
});
await step("add", undefined, (form) => {
  form.name = "Journey triangle";
  form.ratio.componentCount = 3;
  form.ratio.triangleWeights = ["50", "25", "25"];
});
await step("add", undefined, (form) => {
  form.name = "Journey cycle";
  form.mode = "cycle";
  form.cycle.manualPattern = "12,3/7";
});
await step(
  "add",
  undefined,
  (form) => {
    form.name = "Journey match";
    form.mode = "match";
    form.match.targetColor = "#6A3D9A";
  },
  true,
);
await step("add", undefined, (form) => {
  form.name = "Journey gradient";
  form.mode = "gradient";
  form.gradient.direction = "b-to-a";
  form.gradient.localZMaxSublayers = "3";
});
await step("edit", "Journey ratio", (form) => {
  form.mode = "gradient";
  form.displayColor = "#00AA55";
});
await step("duplicate", "Plum");
await step("set-enabled", "Triad");
await step("set-enabled", "Resting");
await step("delete", "Journey cycle");
await step("delete", "Stripes");
await step("delete", "Auto pair");
await step("edit", "Sunset", (form) => {
  form.ratio.componentIds = [night.id, crimson.id, lemon.id];
});
await step("edit", "Dusk", (form) => (form.name = "Dawn"));
const landed = steps.filter((each) => each.refusal === null);
assert.equal(steps.filter((each) => each.refusal !== null).length, 1);
assert.deepEqual(
  [...new Set(steps.map((each) => each.undoLabel))].sort(),
  [
    "Add Journey cycle",
    "Add Journey gradient",
    "Add Journey match",
    "Add Journey ratio",
    "Add Journey triangle",
    "Add Plum copy",
    "Delete mixed filament",
    "Disable mixed filament",
    "Edit mixed filament",
    "Enable mixed filament",
    "Remove mixed filament",
  ],
);
const undo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  undo.push(observe());
}
assert.equal(undo.at(-1).semanticHash, opened.semanticHash);

// --- Output ------------------------------------------------------------------------------------

const sources = [
  "tools/cross-platform/virtual-filament-vectors.mjs",
  "web/src/workspace/VirtualFilamentExchange.ts",
  "web/src/workspace/VirtualFilamentMutation.ts",
  "web/src/project/filaments/virtualFilamentLibraryModel.ts",
  "web/src/ui/dom/CanonicalVirtualFilamentLibraryAdapter.ts",
  "web/src/project/filaments/mixedFilamentAuthoring.ts",
  "web/src/project/filaments/manualCyclePattern.ts",
  "web/src/project/filaments/colorMatchSearch.ts",
  "web/src/project/filaments/filamentPigmentMixer.ts",
  "web/src/project/filaments/fullSpectrumRecipe.ts",
  "web/src/project/filaments/fullSpectrumCompatibility.ts",
  "web/src/project/filaments/mixedCommands.ts",
  "web/src/project/intentWire.ts",
  "web/src/project/__tests__/fixtures.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    states: Object.fromEntries(Object.entries(states).map(([name, value]) => [name, json(value)])),
    assets: [{ descriptorJson: json(fixture.asset.descriptor), bytes: [...fixture.asset.bytes] }],
    libraries,
    defaults,
    validations,
    triangles,
    matchSearches,
    mutations,
    refusals,
    cycles,
    authoring,
    rankings,
    deltas,
    blends,
    paletteSearches,
    recipes,
    journey: {
      archive: Buffer.from(archive).toString("base64"),
      opened,
      steps,
      undo,
    },
  }) + "\n";
const path = new URL("testdata/cross-platform/virtual-filament-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Virtual filament reference drift");
const errors = (list) => list.filter((each) => JSON.parse(each.replyJson).error).length;
console.log(
  `Virtual filament references: ${libraries.length} libraries (${errors(libraries)} unavailable), ` +
    `${defaults.length} opened dialogs, ${validations.length} validations ` +
    `(${validations.filter((each) => JSON.parse(each.replyJson).draft).length} complete), ${triangles.length} triangle points, ` +
    `${matchSearches.length} searches, ${mutations.length} edits (${errors(mutations)} refused), ${refusals.length} malformed; ` +
    `beneath: ${cycles.length} patterns, ${authoring.length} projections, ${rankings.length} rankings, ${deltas.length} ΔE pairs, ` +
    `${blends.length} blends, ${paletteSearches.length} palette searches, ${recipes.length} recipes; ` +
    `a ${steps.length}-step journey (${landed.length} landed) and ${undo.length} undo entries.`,
);
controller.dispose?.();
source.dispose?.();
