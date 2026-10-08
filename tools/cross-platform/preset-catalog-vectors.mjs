// Preset graph and profile catalog references from the production browser
// (`PresetGraph.ts`, `ProfileLoader.ts`) over the bundled profile corpus and
// synthetic catalogs, replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import {
  PresetGraph,
  PresetGraphError,
} from "../../web/src/settings/presets/PresetGraph.ts";
import {
  flattenPreset,
  ProfileCatalog,
  ProfileCatalogLoadError,
} from "../../web/src/slicer/ProfileLoader.ts";
import { META_KEYS, SAFE_KEYS } from "../../web/src/slicer/profileKeys.ts";
import { compareCanonicalText } from "../../web/src/project/domain/canonical.ts";
import { catalogPreflightTarget } from "../../web/src/workspace/AuthoredSlicingTarget.ts";
import {
  encodeProjectCatalogConfig,
  encodeProjectCatalogDiagnostic,
  encodeProjectCatalogPreflightTarget,
  encodeProjectCatalogPreset,
  encodeProjectCatalogProfile,
  encodeProjectCatalogSelection,
  encodeProjectCatalogSelectionRequest,
  encodeProjectCatalogTargetRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const catalogPath = "web/public/profiles/catalog.json";
// Member order follows canonical JSON, as a native host receives it.
const canonical = (value) => JSON.parse(canonicalStringify(value));
const json = (value) => canonicalStringify(value);

// The browser's own collation of preset text, over ASCII with its controls.
let seed = 0x5eed;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const alphabet = " \t\n\x01\x7f_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$09aAbBzZ";
const text = () => {
  let out = "";
  for (let i = Math.floor(random() * 7); i > 0; i -= 1)
    out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
};
const collation = [];
for (let i = 0; i < 4000; i += 1) {
  const a = text();
  const b = random() < 0.2 ? a.toUpperCase() : text();
  collation.push([a, b, Math.sign(a.localeCompare(b, "en"))]);
}
for (const [a, b] of [
  ["Elegoo PLA-CF @base", "Elegoo PLA+ @0.2 nozzle"],
  ["a_1", "a1"],
  ["PLA", "pla"],
  ["pla", "PLa"],
  ["a\x01b", "ab"],
  ["", "\x01"],
  ["0.20mm Standard", "0.16mm Optimal"],
])
  collation.push([a, b, Math.sign(a.localeCompare(b, "en"))]);

const nodeJson = (node) =>
  json({
    id: node.id,
    vendor: node.vendor,
    kind: node.kind,
    name: node.name,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    source: node.source,
    isSystem: node.isSystem,
    isDefault: node.isDefault,
    isVisible: node.isVisible,
    effective: node.effective,
  });
const selectionJson = (selection) =>
  json({
    printer: selection.printer.id,
    process: selection.process?.id ?? null,
    filaments: selection.filaments.map((f) => f?.id ?? null),
    substitutions: selection.substitutions,
    diagnostics: selection.diagnostics,
    complete: selection.complete,
  });
const assessmentJson = (a) => json(a);

/** Everything a catalog yields, or the exact refusal. */
function evaluate(input, requests, assessments) {
  let graph;
  try {
    graph = PresetGraph.build(input);
  } catch (error) {
    assert.ok(error instanceof PresetGraphError || error instanceof URIError);
    let catalogError;
    try {
      ProfileCatalog.fromRaw(input);
    } catch (e) {
      assert.ok(e instanceof ProfileCatalogLoadError);
      catalogError = e.diagnostics;
    }
    return {
      graphError: json(
        error instanceof PresetGraphError
          ? { issues: error.issues }
          : { message: error.message },
      ),
      catalogError: json(catalogError),
    };
  }
  const catalog = ProfileCatalog.fromRaw(input);
  const flats = new Map();
  for (const kind of ["machine", "process", "filament"])
    for (const node of graph.selectable(kind))
      flats.set(node.id, flattenPreset(node));
  for (const profile of catalog.profiles)
    assert.deepEqual(profile.config, {
      ...flats.get(profile.machinePresetId),
      ...flats.get(profile.processPresetId),
      ...flats.get(profile.filamentPresetId),
    });
  const selections = requests(graph).map((request) => {
    const result = catalog.reconcileSelection(request);
    return {
      requestJson: json({
        ...request,
        ...(request.filamentIds
          ? { filamentIds: request.filamentIds.map((id) => id ?? null) }
          : {}),
      }),
      resultJson: result.selection
        ? selectionJson(result.selection)
        : json({ unavailable: result.unavailableReason }),
    };
  });
  return {
    nodeJsons: graph.list().map(nodeJson),
    auxiliaryJson: json(graph.auxiliaryPayloads),
    flatJsons: [...flats].map(([id, config]) => json({ id, config })),
    profilesJson: json(
      catalog.profiles.map(({ config, ...summary }) => summary),
    ),
    diagnosticsJson: json(catalog.diagnostics),
    assessments: assessments(graph).map(([candidate, printer, print]) => ({
      candidate,
      printer,
      print: print ?? null,
      resultJson: assessmentJson(
        print
          ? graph.assessPrintCompatibility(candidate, print, printer)
          : graph.assessPrinterCompatibility(candidate, printer),
      ),
    })),
    selections,
  };
}

// The bundled corpus: every machine/process and filament/machine pair, the
// print rules on one machine per vendor, and reconciliation requests.
const corpus = canonical(JSON.parse(read(catalogPath)));
const ids = (graph, kind) => graph.selectable(kind).map((n) => n.id);
const real = evaluate(
  corpus,
  (graph) => {
    const requests = [];
    const machines = ids(graph, "machine");
    const filaments = ids(graph, "filament");
    for (const printerId of machines) {
      const compatible = graph.compatibleProcesses(printerId).map((n) => n.id);
      const foreign = ids(graph, "process").find(
        (id) => !compatible.includes(id),
      );
      requests.push({ printerId });
      requests.push({ printerId, processId: compatible.at(-1) });
      if (foreign) requests.push({ printerId, processId: foreign });
      requests.push({ printerId, processId: "preset:missing:process:x" });
      const fits = compatible.length
        ? graph.compatibleFilaments(printerId, compatible[0]).map((n) => n.id)
        : [];
      const misfit = filaments.find((id) => !fits.includes(id));
      requests.push({
        printerId,
        processId: compatible[0],
        filamentIds: [
          fits.at(-1),
          misfit,
          undefined,
          "",
          "preset:x:filament:y",
        ],
      });
      requests.push({
        printerId,
        processId: compatible[1],
        filamentIds: [fits[1]],
        installedVendors: [graph.get(printerId).vendor],
      });
      requests.push({ printerId, installedVendors: [] });
    }
    requests.push({ printerId: "preset:missing:machine:x" });
    requests.push({ printerId: ids(graph, "process")[0] });
    return requests;
  },
  (graph) => {
    const pairs = [];
    const machines = ids(graph, "machine");
    for (const printer of machines) {
      for (const process of ids(graph, "process"))
        pairs.push([process, printer]);
      for (const filament of ids(graph, "filament"))
        pairs.push([filament, printer]);
    }
    for (const vendor of ["Elegoo", "Snapmaker"]) {
      const printer = machines.find((id) => graph.get(id).vendor === vendor);
      const processes = graph.compatibleProcesses(printer).map((n) => n.id);
      for (const process of processes.slice(0, 3))
        for (const filament of ids(graph, "filament"))
          pairs.push([filament, printer, process]);
    }
    // Kind mismatches.
    pairs.push([machines[0], machines[1]]);
    pairs.push([ids(graph, "process")[0], ids(graph, "process")[1]]);
    pairs.push([
      ids(graph, "process")[0],
      machines[0],
      ids(graph, "process")[1],
    ]);
    return pairs;
  },
);

// Synthetic catalogs: every graph refusal, then a graph that exercises each
// compatibility rule and replacement score.
const chain = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `L${i}`,
    ...(i > 0 ? { inherits: `L${i - 1}` } : {}),
  }));
const refusals = {
  "not-an-object": [],
  groups: {
    "": {},
    " ": {},
    Vendor: [],
    Other: { machine: {}, extra: [], process: [{ name: "P" }] },
  },
  payloads: {
    V: {
      machine: [
        [],
        "x",
        { name: 5 },
        { name: "M", inherits: null, from: 1, type: "process" },
        {
          name: "N",
          compatible_printers: "x",
          compatible_prints: [1],
          default_filament_profile: ["a", 2],
          excluded_printers: {},
          instantiation: "yes",
          compatible_printers_condition: [],
          compatible_prints_condition: false,
        },
      ],
    },
  },
  references: {
    A: {
      machine: [
        { name: "Base" },
        { name: "Base" },
        { name: "Orphan", inherits: "Nobody" },
      ],
      process: [{ name: "Shared" }],
    },
    B: { process: [{ name: "Shared" }] },
    C: { process: [{ name: "Child", inherits: "Shared" }] },
  },
  cycle: {
    V: {
      filament: [
        { name: "A", inherits: "B" },
        { name: "B", inherits: "C" },
        { name: "C", inherits: "A" },
        { name: "D", inherits: "A" },
      ],
    },
  },
  depth: { V: { process: chain(66).reverse() } },
  "lone-surrogate": { "V\ud800": { machine: [{ name: "M" }] } },
};
const synthetic = {
  V: {
    machine: [
      {
        name: "Base printer",
        from: "system",
        instantiation: "false",
        nozzle_diameter: ["0.4"],
      },
      {
        name: "U1 (0.4 nozzle)",
        inherits: "Base printer",
        from: " SYSTEM ",
        instantiation: true,
        nozzle_diameter: ["0.4", "0.4", "0.4", "0.4"],
        default_print_profile: "0.20mm Standard @U1",
        default_filament_profile: ["Generic PLA @U1", "", "Generic PETG @U1"],
        printable_area: ["0x0", "270x0", "270x270", "0x270"],
        printable_height: "270",
        printer_notes: "kept out",
        bed_exclude_area: [],
        thumbnails: { size: "300x300" },
      },
      {
        name: "My U1",
        inherits: "U1 (0.4 nozzle)",
        from: "user",
        nozzle_diameter: 0.4,
      },
      { name: "Tiny", from: "system", nozzle_diameter: null },
      { name: "Nothing fits", from: "system" },
      { compatible: "unnamed rule table" },
    ],
    process: [
      {
        name: "0.20mm Standard @U1",
        from: "system",
        layer_height: "0.2",
        alias: "Standard",
        compatible_printers: ["U1 (0.4 nozzle)", "Tiny"],
      },
      {
        name: "0.20mm Strength @U1",
        from: "system",
        layer_height: 0.2,
        compatible_printers: ["U1 (0.4 nozzle)"],
      },
      {
        name: "0.16mm Optimal @U1",
        from: "system",
        layer_height: ["0.16"],
        alias: "Optimal",
        compatible_printers: ["U1 (0.4 nozzle)", "Tiny"],
      },
      {
        name: "default process",
        from: "default",
        compatible_printers: ["Nothing fits"],
      },
      {
        name: "External",
        from: "External",
        compatible_printers: ["U1 (0.4 nozzle)"],
      },
      {
        name: "Conditional",
        compatible_printers_condition: "nozzle_diameter[0]==0.4",
      },
      { name: "Hidden", instantiation: "false" },
      { name: "pla", compatible_printers: [] },
    ],
    filament: [
      {
        name: "Generic PLA @U1",
        from: "system",
        filament_type: ["PLA"],
        alias: "Generic PLA",
        filament_vendor: [" Generic "],
        compatible_printers: ["U1 (0.4 nozzle)", "Tiny"],
        nozzle_temperature: [220],
      },
      {
        name: "Generic PLA+ @U1",
        from: "system",
        filament_type: "PLA",
        compatible_printers: ["U1 (0.4 nozzle)"],
      },
      {
        name: "Generic PLA-CF @U1",
        from: "system",
        filament_type: ["PLA-CF"],
        compatible_printers: ["U1 (0.4 nozzle)"],
        excluded_printers: ["Tiny"],
      },
      {
        name: "Generic PETG @U1",
        from: "system",
        filament_type: ["PETG"],
        compatible_printers: ["U1 (0.4 nozzle)"],
        compatible_prints: ["0.20mm Strength @U1"],
      },
      {
        name: "Draft only",
        filament_type: [""],
        compatible_prints_condition: "layer_height > 0.3",
      },
      { name: "Excluded", excluded_printers: ["My U1", "Tiny"] },
      { name: "default filament", from: "default" },
    ],
  },
  W: {
    filament: [
      {
        name: "W PLA",
        inherits: "Generic PLA @U1",
        filament_vendor: "",
        alias: "Generic PLA",
      },
    ],
  },
};
// Explicit lists only: one printer no process accepts, one no filament fits.
const narrow = {
  X: {
    machine: [
      { name: "Lonely" },
      { name: "Picky", nozzle_diameter: ["0.4", "0.6"] },
    ],
    process: [{ name: "Picky process", compatible_printers: ["Picky"] }],
    filament: [
      { name: "Elsewhere", compatible_printers: ["Lonely"] },
      { name: "Wrong print", compatible_prints: ["Other process"] },
    ],
  },
};
const cases = {};
for (const [name, input] of Object.entries(refusals))
  cases[name] = evaluate(
    canonical(input),
    () => [],
    () => [],
  );
cases.narrow = evaluate(
  canonical(narrow),
  (graph) => [
    { printerId: graph.find("X", "machine", "Lonely").id },
    {
      printerId: graph.find("X", "machine", "Picky").id,
      filamentIds: [graph.find("X", "filament", "Elsewhere").id],
    },
  ],
  (graph) =>
    graph
      .list("filament")
      .flatMap((f) =>
        graph
          .list("machine")
          .map((m) => [f.id, m.id, graph.list("process")[0].id]),
      ),
);
cases.synthetic = evaluate(
  canonical(synthetic),
  (graph) => {
    const id = (kind, name, vendor = "V") => graph.find(vendor, kind, name)?.id;
    const u1 = id("machine", "U1 (0.4 nozzle)");
    const mine = id("machine", "My U1");
    const tiny = id("machine", "Tiny");
    const none = id("machine", "Nothing fits");
    const standard = id("process", "0.20mm Standard @U1");
    const strength = id("process", "0.20mm Strength @U1");
    const optimal = id("process", "0.16mm Optimal @U1");
    const pla = id("filament", "Generic PLA @U1");
    const petg = id("filament", "Generic PETG @U1");
    const cf = id("filament", "Generic PLA-CF @U1");
    const wpla = id("filament", "W PLA", "W");
    return [
      { printerId: u1 },
      { printerId: u1, processId: optimal, filamentIds: [cf] },
      {
        printerId: u1,
        processId: strength,
        filamentIds: [petg, undefined, pla, ""],
      },
      { printerId: mine, processId: standard, filamentIds: [wpla] },
      { printerId: tiny, processId: strength, filamentIds: [cf, pla] },
      { printerId: tiny, processId: optimal },
      { printerId: none },
      { printerId: u1, processId: optimal, installedVendors: ["W"] },
      {
        printerId: u1,
        processId: standard,
        filamentIds: [wpla],
        installedVendors: ["V"],
      },
      { printerId: id("machine", "Base printer") },
    ];
  },
  (graph) => {
    const pairs = [];
    for (const candidate of graph.list())
      for (const printer of graph.list("machine")) {
        pairs.push([candidate.id, printer.id]);
        for (const print of graph.list("process"))
          if (candidate.kind === "filament")
            pairs.push([candidate.id, printer.id, print.id]);
      }
    return pairs;
  },
);

// The host exchange, encoded by the generated TypeScript codecs: what a
// binding reads back from the bundled catalog and from a refused one.
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const camel = (value) => value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const optionalText = (value) =>
  value === undefined || value === null
    ? { absent: {} }
    : { value: units(value) };
const optionalCounter = (value) =>
  value === undefined ? { absent: {} } : { value };
const facts = (profile) =>
  profile
    ? {
        value: {
          machinePresetId: optionalText(profile.machinePresetId),
          processPresetId: optionalText(profile.processPresetId),
          filamentPresetId: optionalText(profile.filamentPresetId),
          printableArea: optionalText(profile.config.printable_area),
          printableHeight: optionalText(profile.config.printable_height),
          nozzleDiameter: optionalText(profile.config.nozzle_diameter),
          filamentType: optionalText(profile.config.filament_type),
          nozzleTemperatureRangeLow: optionalText(
            profile.config.nozzle_temperature_range_low,
          ),
          nozzleTemperatureRangeHigh: optionalText(
            profile.config.nozzle_temperature_range_high,
          ),
        },
      }
    : { absent: {} };
function exchange(input, requests, targets) {
  let catalog;
  let diagnostics;
  try {
    catalog = ProfileCatalog.fromRaw(input);
    diagnostics = catalog.diagnostics;
  } catch (error) {
    assert.ok(error instanceof ProfileCatalogLoadError);
    diagnostics = error.diagnostics;
  }
  const profiles = catalog?.profiles ?? [];
  const graph = catalog ? PresetGraph.build(input) : undefined;
  const sample = profiles.filter(
    (_, i) => i % 37 === 0 || i === profiles.length - 1,
  );
  return {
    diagnosticJsons: diagnostics.map((d) =>
      encodeProjectCatalogDiagnostic({
        code: camel(d.code),
        error: d.severity === "error",
        message: units(d.message),
        machineName: optionalText(d.machineName),
        processName: optionalText(d.processName),
        presetId: optionalText(d.presetId),
      }),
    ),
    presetJsons: (graph?.list() ?? []).map((n) =>
      encodeProjectCatalogPreset({
        id: units(n.id),
        vendor: units(n.vendor),
        kind: n.kind,
        name: units(n.name),
        parentId: optionalText(n.parentId),
        source: n.source,
        isSystem: n.isSystem,
        isDefault: n.isDefault,
        isVisible: n.isVisible,
      }),
    ),
    profileCount: profiles.length,
    profiles: sample.map((p) => ({
      index: profiles.indexOf(p),
      profileJson: encodeProjectCatalogProfile({
        id: units(p.id),
        displayName: units(p.displayName),
        machineName: units(p.machineName),
        processName: units(p.processName),
        filamentName: units(p.filamentName),
        filamentPresetName: units(p.filamentPresetName),
        filamentVendor: optionalText(p.filamentVendor),
        machinePresetId: units(p.machinePresetId),
        processPresetId: units(p.processPresetId),
        filamentPresetId: units(p.filamentPresetId),
      }),
      configJson: encodeProjectCatalogConfig({
        entries: Object.keys(p.config)
          .sort(compareCanonicalText)
          .map((key) => ({ key: units(key), value: units(p.config[key]) })),
      }),
    })),
    selections: requests.map((request) => {
      const result = catalog
        ? catalog.reconcileSelection(request)
        : {
            unavailableReason:
              "The profile catalog has not loaded or failed validation.",
          };
      const s = result.selection;
      return {
        requestJson: encodeProjectCatalogSelectionRequest({
          printerId: units(request.printerId),
          processId: optionalText(request.processId),
          filamentIds: (request.filamentIds ?? []).map(optionalText),
          installedVendors: request.installedVendors
            ? { value: request.installedVendors.map(units) }
            : { absent: {} },
        }),
        resultJson: encodeProjectCatalogSelection(
          s
            ? {
                resolved: {
                  printer: units(s.printer.id),
                  process: optionalText(s.process?.id),
                  filaments: s.filaments.map((f) => optionalText(f?.id)),
                  substitutions: s.substitutions.map((x) => ({
                    kind: x.kind,
                    slot: optionalCounter(x.slot),
                    previousId: optionalText(x.previousId),
                    nextId: optionalText(x.nextId),
                    reason: camel(x.reason),
                  })),
                  diagnostics: s.diagnostics.map((d) => ({
                    code: camel(d.code),
                    presetId: optionalText(d.presetId),
                    slot: optionalCounter(d.slot),
                    message: units(d.message),
                  })),
                  complete: s.complete,
                },
              }
            : { unavailable: units(result.unavailableReason) },
        ),
      };
    }),
    targets: targets.map(({ machine, process, filament, heads, toolCount }) => {
      const primary = profiles.find(
        (p) =>
          p.machinePresetId === machine &&
          p.processPresetId === process &&
          p.filamentPresetId === filament,
      );
      const target = catalogPreflightTarget(
        profiles,
        primary,
        heads,
        toolCount,
      );
      return {
        requestJson: encodeProjectCatalogTargetRequest({
          machinePresetId: units(machine),
          processPresetId: units(process),
          filamentPresetId: units(filament),
          headFilamentIds: heads.map(optionalText),
          toolCount,
        }),
        resultJson: encodeProjectCatalogPreflightTarget({
          toolCount,
          primary: facts(target.primaryProfile),
          filaments: Array.from(target.filamentProfiles, facts),
        }),
      };
    }),
  };
}
const bundledProfiles = ProfileCatalog.fromRaw(corpus).profiles;
const u1 = bundledProfiles.find((p) => p.machineName.includes("U1"));
const sameProcess = bundledProfiles.filter(
  (p) =>
    p.machinePresetId === u1.machinePresetId &&
    p.processPresetId === u1.processPresetId,
);
const targetRequests = [
  {
    machine: u1.machinePresetId,
    process: u1.processPresetId,
    filament: u1.filamentPresetId,
    heads: sameProcess.slice(0, 4).map((p) => p.filamentPresetId),
    toolCount: 4,
  },
  {
    machine: u1.machinePresetId,
    process: u1.processPresetId,
    filament: u1.filamentPresetId,
    heads: [
      sameProcess[1].filamentPresetId,
      undefined,
      "",
      "preset:x:filament:y",
    ],
    toolCount: 2.5,
  },
  {
    machine: u1.machinePresetId,
    process: bundledProfiles.at(-1).processPresetId,
    filament: u1.filamentPresetId,
    heads: [u1.filamentPresetId],
    toolCount: 1,
  },
  { machine: "", process: "", filament: "", heads: [], toolCount: 0 },
];
const exchangeRequests = JSON.parse(
  JSON.stringify(real.selections.map((s) => JSON.parse(s.requestJson))),
).map((r) => ({
  ...r,
  ...(r.filamentIds
    ? { filamentIds: r.filamentIds.map((id) => id ?? undefined) }
    : {}),
}));
const exchanges = {
  bundled: exchange(corpus, exchangeRequests, targetRequests),
  refused: exchange(
    canonical(refusals.references),
    exchangeRequests.slice(0, 2),
    targetRequests.slice(0, 1),
  ),
};

// The exact catalog each case builds from, for the native replay.
for (const [name, input] of Object.entries({ ...refusals, narrow, synthetic }))
  cases[name].inputJson = json(input);

const sources = [
  "tools/cross-platform/preset-catalog-vectors.mjs",
  "web/src/settings/presets/PresetGraph.ts",
  "web/src/slicer/ProfileLoader.ts",
  "web/src/slicer/profileKeys.ts",
  "web/src/workspace/AuthoredSlicingTarget.ts",
  "contracts/project-intents.json",
  "web/src/settings/configSerialization.ts",
  catalogPath,
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      metaKeys: [...META_KEYS].sort(),
      safeKeys: [...SAFE_KEYS].sort(),
      collationJson: json(collation),
      real,
      cases,
      exchanges,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/preset-catalog-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Preset catalog reference drift",
  );
console.log(
  `preset catalog: ${real.nodeJsons.length} nodes, ${JSON.parse(real.profilesJson).length} profiles, ` +
    `${real.assessments.length + cases.synthetic.assessments.length} assessments, ` +
    `${real.selections.length + cases.synthetic.selections.length} selections, ${Object.keys(cases).length} synthetic catalogs`,
);
