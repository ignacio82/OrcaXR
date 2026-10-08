// Preset library references from the production browser (`PresetLibrary.ts`):
// installation, custom presets, bundles, stored state and catalog updates over
// the bundled profile corpus and synthetic catalogs, replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalStringify,
  fnv1a64Text,
} from "../../web/src/project/domain/canonical.ts";
import { PINNED_PRESET_SEMANTICS } from "../../web/src/settings/presets/PresetGraph.ts";
import {
  PresetLibrary,
  PresetLibraryStore,
  coerceOverrideValue,
  formatOverrideValue,
  stableStringify,
} from "../../web/src/settings/presets/PresetLibrary.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const catalogPath = "web/public/profiles/catalog.json";
// Member order follows canonical JSON, as a native host receives it.
const canonical = (value) => JSON.parse(canonicalStringify(value));
const json = (value) => canonicalStringify(value);

// Every library string the corpus compares is ASCII, so the browser's `en`
// collation is the built-in ASCII root order on the native side.
const ascii = (text) => assert.ok(/^[\x00-\x7f]*$/.test(text), text);

const system = (kind, name, fields = {}) => ({
  type: kind,
  name,
  from: "system",
  instantiation: "true",
  ...fields,
});
const template = (kind, name, fields = {}) =>
  system(kind, name, { instantiation: "false", ...fields });
const machine = (name, model, variant, fields = {}) =>
  system("machine", name, {
    inherits: "fdm_acme_common",
    printer_model: model,
    ...(variant === undefined ? {} : { printer_variant: variant }),
    ...fields,
  });

// Shaped like the real corpus where it matters: model names with spaces,
// variants that inherit from a sibling variant, templates without a model, a
// variant named after its nozzle and one that is not a number.
const acme = {
  Acme: {
    machine: [
      template("machine", "fdm_acme_common", {
        nozzle_diameter: ["0.4"],
        printable_area: ["0x0", "200x0", "200x200", "0x200"],
      }),
      machine("Acme Big Printer 0.4 nozzle", "Acme Big Printer", "0.4", {
        nozzle_diameter: ["0.4"],
        printable_area: ["0x0", "220x0", "220x220", "0x220"],
      }),
      machine("Acme Big Printer 0.2 nozzle", "Acme Big Printer", "0.2", {
        inherits: "Acme Big Printer 0.4 nozzle",
        nozzle_diameter: ["0.2"],
      }),
      machine("Acme Big Printer 0.6 nozzle", "Acme Big Printer", undefined, {
        inherits: "fdm_acme_common",
        nozzle_diameter: ["0.60"],
      }),
      machine("Acme Big Printer 0.8 nozzle", "Acme Big Printer", "0.8", {
        nozzle_diameter: [0.8],
      }),
      machine("Acme Small Printer 0.4 nozzle", "Acme Small Printer", "0.4", {
        nozzle_diameter: ["0.4"],
      }),
      machine("Acme Small Printer HF", "Acme Small Printer", "HF", {
        nozzle_diameter: ["0.4"],
      }),
      machine("Acme Lab Printer", "acme lab", undefined, {
        nozzle_diameter: " 0.25 ",
      }),
      machine("Acme Mystery Printer", "Acme Mystery", undefined, {
        nozzle_diameter: ["wide"],
      }),
    ],
    process: [
      template("process", "fdm_process_common", { layer_height: "0.2" }),
      system("process", "Standard @Acme Big", {
        inherits: "fdm_process_common",
        compatible_printers: [
          "Acme Big Printer 0.4 nozzle",
          "Acme Big Printer 0.2 nozzle",
        ],
        sparse_infill_density: "15%",
      }),
      system("process", "Standard @Acme Small", {
        inherits: "fdm_process_common",
        compatible_printers: ["Acme Small Printer 0.4 nozzle"],
        wall_loops: "2",
      }),
      system("process", "Fine @Acme", {
        inherits: "fdm_process_common",
        layer_height: "0.12",
      }),
    ],
    filament: [
      template("filament", "fdm_filament_common", {
        filament_type: ["PLA"],
        nozzle_temperature: ["210"],
        compatible_printers: [],
        filament_flow_ratio: [0.98],
      }),
      system("filament", "Acme PLA", { inherits: "fdm_filament_common" }),
      system("filament", "Acme PETG", {
        inherits: "fdm_filament_common",
        filament_type: ["PETG"],
        nozzle_temperature: ["240"],
        compatible_printers: ["Acme Small Printer 0.4 nozzle"],
      }),
      system("filament", "Acme PLA @Big", {
        inherits: "fdm_filament_common",
        compatible_prints: ["Standard @Acme Big"],
        filament_settings_id: ["Acme PLA @Big"],
      }),
    ],
  },
  Zeta: {
    machine: [
      system("machine", "Zeta One 0.4", {
        printer_model: "Zeta One",
        printer_variant: "0.4",
        nozzle_diameter: ["0.4"],
      }),
    ],
    process: [
      system("process", "Zeta Standard", {
        compatible_printers: ["Zeta One 0.4"],
        layer_height: "0.2",
      }),
    ],
    filament: [
      system("filament", "Zeta PLA", {
        filament_type: ["PLA"],
        nozzle_temperature: ["205"],
      }),
      // A second vendor's preset of the same name: a custom preset that
      // names it cannot say which one it means.
      system("filament", "Shared PLA", { filament_type: ["PLA"] }),
    ],
  },
  Yolo: {
    filament: [system("filament", "Shared PLA", { filament_type: ["PLA"] })],
  },
};
// A newer catalog: one model and one variant gone, a model added, a filament
// base dropped, and a changed payload.
const acmeNext = structuredClone(acme);
acmeNext.Acme.machine = acmeNext.Acme.machine
  .filter((m) => m.printer_model !== "Acme Small Printer")
  .filter((m) => m.name !== "Acme Big Printer 0.2 nozzle")
  .concat([
    machine("Acme Huge Printer 0.4 nozzle", "Acme Huge Printer", "0.4", {
      nozzle_diameter: ["0.4"],
    }),
  ]);
acmeNext.Acme.process = acmeNext.Acme.process.map((p) =>
  p.name === "Standard @Acme Small"
    ? { ...p, compatible_printers: ["Acme Huge Printer 0.4 nozzle"] }
    : p,
);
acmeNext.Acme.filament = acmeNext.Acme.filament.filter(
  (f) => f.name !== "Acme PETG",
);
acmeNext.Zeta.filament[0].nozzle_temperature = ["210"];

const catalogs = {
  bundled: canonical(JSON.parse(read(catalogPath))),
  acme: canonical(acme),
  "acme-next": canonical(acmeNext),
  "acme-same": canonical(structuredClone(acme)),
  broken: canonical({ V: { machine: [{ name: "A", inherits: "Nobody" }] } }),
  "lone-surrogate": canonical({ "V\ud800": { machine: [{ name: "M" }] } }),
  "not-an-object": [],
};

/** A clock that moves one second per read. */
const clockValues = Array.from({ length: 120 }, (_, i) =>
  new Date(Date.UTC(2026, 7, 16, 0, 0, i)).toISOString(),
);
function makeClock() {
  const clock = { reads: 0 };
  clock.now = () => clockValues[clock.reads++];
  return clock;
}

const issuesJson = (issues) =>
  issues.map(({ code, severity, path, message }) => ({
    code,
    severity,
    path,
    message,
  }));
const resultJson = (result) =>
  json({ ok: result.ok, issues: issuesJson(result.issues) });
const lineagesJson = (list) =>
  list.map(({ vendor, kind, name }) => ({ vendor, kind, name }));
const planJson = (plan) =>
  json({
    previousFingerprint: plan.previousFingerprint,
    nextFingerprint: plan.nextFingerprint,
    changed: plan.changed,
    addedModels: lineagesJson(plan.addedModels),
    removedModels: lineagesJson(plan.removedModels),
    removedVariants: lineagesJson(plan.removedVariants),
    orphanedCustomPresets: lineagesJson(plan.orphanedCustomPresets),
    issues: issuesJson(plan.issues),
    applicable: plan.applicable,
  });
const inventoryJson = (inventory) =>
  json({
    vendors: inventory.vendors,
    models: inventory.models.map((m) => ({
      vendor: m.vendor,
      model: m.model,
      installed: m.installed,
      variants: m.variants.map((v) => ({
        variant: v.variant,
        presetName: v.presetName,
        presetId: v.presetId,
        ...(v.nozzleDiameter === undefined
          ? {}
          : { nozzleDiameter: v.nozzleDiameter }),
        installed: v.installed,
      })),
    })),
  });
/** Every composed node's identity, visibility and effective payload. */
const graphDigest = (graph) =>
  fnv1a64Text(
    graph
      .list()
      .map((n) =>
        [
          n.id,
          String(n.isVisible),
          n.source,
          stableStringify(n.effective),
        ].join("\u0000"),
      )
      .join("\n"),
  );

/** One step against a live library; returns what it observed. */
function step(state, op) {
  const library = state.library;
  const observed = {};
  switch (op.op) {
    case "install":
      observed.resultJson = resultJson(
        library.installPrinter(op.vendor, op.model, op.variants),
      );
      break;
    case "setInstalled":
      observed.resultJson = resultJson(library.setInstalled(op.selections));
      break;
    case "uninstall":
      observed.resultJson = resultJson(
        library.uninstallPrinter(op.vendor, op.model),
      );
      break;
    case "create":
      observed.resultJson = resultJson(library.createCustomPreset(op.draft));
      break;
    case "update":
      observed.resultJson = resultJson(
        library.updateCustomPreset(op.vendor, op.presetKind, op.name, op.draft),
      );
      break;
    case "delete":
      observed.resultJson = resultJson(
        library.deleteCustomPreset(op.vendor, op.presetKind, op.name),
      );
      break;
    case "import":
      observed.resultJson = resultJson(library.importBundle(op.bundle));
      break;
    case "export":
      observed.bundle = library.exportBundle(op.exportedAt);
      state.exported.push(observed.bundle);
      break;
    case "plan":
      observed.planJson = planJson(
        library.planCatalogUpdate(catalogs[op.catalog]),
      );
      break;
    case "apply": {
      const applied = library.applyCatalogUpdate(catalogs[op.catalog]);
      observed.resultJson = resultJson(applied);
      if (applied.library) state.library = applied.library;
      observed.fingerprint = state.library.catalogFingerprint;
      break;
    }
    case "bases":
      observed.ids = library
        .basePresetsFor(op.kind, {
          ...(op.printerId === undefined ? {} : { printerId: op.printerId }),
          ...(op.processId === undefined ? {} : { processId: op.processId }),
        })
        .map((n) => n.id);
      break;
    case "inventory":
      observed.inventoryJson = inventoryJson(library.inventory());
      break;
    case "views":
      observed.configured = library.isConfigured();
      observed.vendors = [...library.installedVendors()];
      observed.customs = Object.fromEntries(
        ["machine", "process", "filament"].map((kind) => [
          kind,
          library.customPresets(kind).map((p) => p.name),
        ]),
      );
      observed.composedDigest = fnv1a64Text(
        stableStringify(library.composeCatalog()),
      );
      observed.graphDigest = graphDigest(library.graph());
      break;
    default:
      throw Error(`unknown op ${op.op}`);
  }
  observed.stateJson = stableStringify(state.library.state);
  return observed;
}

/**
 * A scenario: a catalog, how the library is created (empty, from a stored
 * value, or from stored text the way `PresetLibraryStore` reads it), and its
 * steps. A step may use a bundle an earlier step exported.
 */
function scenario(name, catalog, start, ops) {
  const clock = makeClock();
  let created;
  if (start.storedText !== undefined) {
    // Stored text is read the way the browser store reads it. The store
    // stamps with the system clock, so these scenarios only observe.
    const store = new PresetLibraryStore(catalogs[catalog], {
      getItem: () => start.storedText,
      setItem() {},
      removeItem() {},
    });
    assert.ok(ops.every((op) => ["views", "inventory"].includes(op.op)));
    created = { library: store.library, issues: store.loadIssues };
  } else {
    created = PresetLibrary.create(catalogs[catalog], {
      clock,
      ...(start.state === undefined ? {} : { state: canonical(start.state) }),
    });
  }
  const initialStateJson = stableStringify(created.library.state);
  const state = { library: created.library, exported: [] };
  const steps = [];
  for (const op of ops) {
    const resolved = canonical(
      op.op === "import" && typeof op.bundle === "function"
        ? { ...op, bundle: op.bundle(state.exported) }
        : op,
    );
    steps.push({ opJson: json(resolved), ...step(state, resolved) });
  }
  for (const s of steps) ascii(JSON.stringify(s));
  return {
    name,
    catalog,
    ...(start.state === undefined ? {} : { stateJson: json(start.state) }),
    ...(start.storedText === undefined ? {} : { storedText: start.storedText }),
    createIssuesJson: json(issuesJson(created.issues)),
    initialStateJson,
    fingerprint: created.library.catalogFingerprint,
    steps,
    clockReads: clock.reads,
  };
}

const ACME_BIG = "Acme Big Printer";
const CUSTOM = "OrcaXR Custom";
const id = (vendor, kind, name) =>
  `preset:${encodeURIComponent(vendor)}:${kind}:${encodeURIComponent(name)}`;
const bundleBase = {
  format: "orcaxr.preset-bundle",
  schemaVersion: 1,
  exportedAt: "2026-08-16T00:00:00.000Z",
  engine: {
    repository: PINNED_PRESET_SEMANTICS.repository,
    commit: PINNED_PRESET_SEMANTICS.commit,
  },
  catalogFingerprint: "anything",
};
const provenance = (fields = {}) => ({
  source: "user-derived",
  license: "CC0",
  version: "1.0.0",
  derivedFrom: { vendor: "Acme", kind: "filament", name: "Acme PLA" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  ...fields,
});
const customRecord = (fields = {}) => ({
  vendor: CUSTOM,
  kind: "filament",
  name: "Imported PLA",
  inherits: "Acme PLA",
  overrides: { nozzle_temperature: ["205"] },
  provenance: provenance(),
  ...fields,
});
// Bundles are sorted JSON, as an export writes them; a native host reads
// members in canonical order.
const bundle = (fields) => stableStringify({ ...bundleBase, ...fields });
const deep = (depth) => (depth === 0 ? ["x"] : [deep(depth - 1)]);

const scenarios = [
  scenario("acme-install", "acme", {}, [
    { op: "views" },
    { op: "inventory" },
    { op: "install", vendor: "Acme", model: ACME_BIG, variants: ["0.4"] },
    { op: "views" },
    {
      op: "install",
      vendor: " Acme ",
      model: ` ${ACME_BIG} `,
      variants: [" 0.2 ", "0.4", "0.4", "0.8", " 0.6"],
    },
    {
      op: "install",
      vendor: "Acme",
      model: "Acme Small Printer",
      variants: ["HF", "0.4"],
    },
    { op: "install", vendor: "Acme", model: "acme lab", variants: ["0.25"] },
    {
      op: "install",
      vendor: "Acme",
      model: ACME_BIG,
      variants: ["0.3", "HF", "0.2"],
    },
    { op: "install", vendor: "Acme", model: "Nope", variants: ["0.4"] },
    { op: "install", vendor: "", model: "", variants: ["0.4"] },
    { op: "inventory" },
    { op: "views" },
    {
      op: "setInstalled",
      selections: [
        { vendor: "Zeta", model: "Zeta One", variants: ["0.4"] },
        { vendor: "Acme", model: ACME_BIG, variants: ["0.8"] },
        { vendor: "Acme", model: ACME_BIG, variants: ["0.2"] },
        { vendor: "Acme", model: "Acme Mystery", variants: [] },
      ],
    },
    {
      op: "setInstalled",
      selections: [
        { vendor: "Zeta", model: "Zeta One", variants: ["0.4"] },
        { vendor: "Acme", model: ACME_BIG, variants: ["0.8"] },
        { vendor: "Acme", model: ACME_BIG, variants: ["0.2", "0.8"] },
        { vendor: "Acme", model: "Acme Small Printer", variants: [] },
      ],
    },
    { op: "views" },
    { op: "uninstall", vendor: "Acme", model: "Acme Small Printer" },
    { op: "uninstall", vendor: "Zeta", model: "Zeta One" },
    { op: "install", vendor: "Acme", model: ACME_BIG, variants: [] },
    { op: "views" },
    { op: "inventory" },
  ]),
  scenario("acme-custom", "acme", {}, [
    {
      op: "install",
      vendor: "Acme",
      model: ACME_BIG,
      variants: ["0.4", "0.2"],
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "  My PLA  ",
        inherits: " Acme PLA ",
        overrides: { nozzle_temperature: ["205"], filament_flow_ratio: [0.95] },
        note: "  tuned  ",
      },
    },
    {
      op: "create",
      draft: {
        vendor: "  ",
        kind: "filament",
        name: "My PLA",
        inherits: "Acme PLA",
      },
    },
    {
      op: "create",
      draft: {
        vendor: "Acme",
        kind: "filament",
        name: "My PLA",
        inherits: "Acme PLA",
        license: " ",
        version: "2.0.0",
        source: "imported",
      },
    },
    {
      op: "create",
      draft: { kind: "filament", name: "Acme PLA", inherits: "Acme PLA" },
    },
    {
      op: "create",
      draft: { kind: "filament", name: "   ", inherits: "" },
    },
    {
      op: "create",
      draft: { kind: "filament", name: "x".repeat(121), inherits: "Nobody" },
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "Templated",
        inherits: "fdm_filament_common",
        overrides: {
          name: "Renamed",
          inherits: "x",
          is_default: true,
          not_a_key: 1,
          layer_height: "0.2",
          nozzle_temperature: deep(9),
          filament_type: deep(7),
        },
      },
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "Layered PLA",
        inherits: "My PLA",
        overrides: { filament_type: ["PLA+"] },
      },
    },
    {
      op: "create",
      draft: {
        kind: "process",
        name: "My Standard",
        inherits: "Standard @Acme Big",
        overrides: { layer_height: "0.16", sparse_infill_density: "20%" },
      },
    },
    {
      op: "create",
      draft: {
        kind: "machine",
        name: "My Big",
        inherits: "Acme Big Printer 0.4 nozzle",
        overrides: { printable_area: ["0x0", "230x0", "230x230", "0x230"] },
      },
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "Broken list",
        inherits: "Acme PLA",
        overrides: { compatible_printers: "Acme Big Printer 0.4 nozzle" },
      },
    },
    {
      op: "create",
      draft: { kind: "filament", name: "Ambiguous", inherits: "Shared PLA" },
    },
    { op: "views" },
    {
      op: "bases",
      kind: "filament",
    },
    {
      op: "bases",
      kind: "filament",
      printerId: id("Acme", "machine", "Acme Big Printer 0.4 nozzle"),
    },
    {
      op: "bases",
      kind: "filament",
      printerId: id("Acme", "machine", "Acme Big Printer 0.4 nozzle"),
      processId: id("Acme", "process", "Standard @Acme Big"),
    },
    {
      op: "bases",
      kind: "filament",
      printerId: id("Acme", "machine", "Acme Big Printer 0.4 nozzle"),
      processId: id("Acme", "process", "Missing"),
    },
    {
      op: "bases",
      kind: "process",
      printerId: id(CUSTOM, "machine", "My Big"),
    },
    {
      op: "bases",
      kind: "process",
      printerId: id("Acme", "machine", "Acme Small Printer 0.4 nozzle"),
    },
    { op: "bases", kind: "machine", printerId: id("Acme", "machine", "x") },
    { op: "bases", kind: "process", printerId: id("Acme", "machine", "x") },
    // Edits: a no-op, a rename, a re-base, a cycle and a collision.
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "My PLA",
      draft: {},
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "My PLA",
      draft: { name: "My PLA 2" },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "Layered PLA",
      draft: { name: "Layered PLA 2", note: "", license: "MIT" },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "My PLA",
      draft: { inherits: "Layered PLA 2" },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "Layered PLA 2",
      draft: { inherits: "Layered PLA 2" },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "Layered PLA 2",
      draft: { name: "My PLA" },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "filament",
      name: "My PLA",
      draft: {
        overrides: { nozzle_temperature: ["200"] },
        note: "  retuned ",
        source: "imported",
        version: "1.1.0",
      },
    },
    {
      op: "update",
      vendor: CUSTOM,
      presetKind: "process",
      name: "My PLA",
      draft: {},
    },
    { op: "uninstall", vendor: "Acme", model: ACME_BIG },
    { op: "install", vendor: "Acme", model: ACME_BIG, variants: [] },
    { op: "delete", vendor: CUSTOM, presetKind: "filament", name: "My PLA" },
    { op: "delete", vendor: CUSTOM, presetKind: "filament", name: "Nobody" },
    { op: "views" },
    { op: "export", exportedAt: "2026-08-20T00:00:00.000Z" },
    { op: "export" },
    // Catalog updates.
    { op: "plan", catalog: "acme-same" },
    { op: "plan", catalog: "acme-next" },
    { op: "plan", catalog: "broken" },
    { op: "plan", catalog: "lone-surrogate" },
    { op: "plan", catalog: "not-an-object" },
    { op: "apply", catalog: "broken" },
    {
      op: "delete",
      vendor: CUSTOM,
      presetKind: "process",
      name: "My Standard",
    },
    { op: "views" },
    { op: "apply", catalog: "acme-next" },
    { op: "views" },
    { op: "inventory" },
  ]),
  scenario("acme-orphans", "acme", {}, [
    {
      op: "install",
      vendor: "Acme",
      model: "Acme Small Printer",
      variants: ["0.4"],
    },
    {
      op: "create",
      draft: { kind: "filament", name: "My PETG", inherits: "Acme PETG" },
    },
    {
      op: "create",
      draft: { kind: "filament", name: "My PETG 2", inherits: "My PETG" },
    },
    { op: "plan", catalog: "acme-next" },
    { op: "apply", catalog: "acme-next" },
    { op: "views" },
  ]),
  scenario("acme-bundles", "acme", {}, [
    { op: "install", vendor: "Acme", model: ACME_BIG, variants: ["0.4"] },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "Exported PLA",
        inherits: "Acme PLA",
        overrides: { nozzle_temperature: ["215"] },
        note: "shared",
      },
    },
    { op: "export", exportedAt: "2026-08-21T00:00:00.000Z" },
    {
      op: "install",
      vendor: "Acme",
      model: "Acme Small Printer",
      variants: ["HF"],
    },
    { op: "import", bundle: (exported) => exported[0] },
    { op: "views" },
    { op: "import", bundle: "{ not json" },
    { op: "import", bundle: "[]" },
    { op: "import", bundle: '"text"' },
    { op: "import", bundle: '{"format":"something-else"}' },
    { op: "import", bundle: bundle({ schemaVersion: 99 }) },
    { op: "import", bundle: bundle({ schemaVersion: "1" }) },
    { op: "import", bundle: bundle({ schemaVersion: undefined }) },
    { op: "import", bundle: bundle({ schemaVersion: null }) },
    { op: "import", bundle: bundle({ schemaVersion: [1, 2] }) },
    { op: "import", bundle: bundle({ engine: { commit: "abc" } }) },
    { op: "import", bundle: bundle({ engine: "x" }) },
    {
      op: "import",
      bundle: bundle({
        engine: { commit: `  ${PINNED_PRESET_SEMANTICS.commit} ` },
      }),
    },
    { op: "import", bundle: bundle({ installed: {} }) },
    { op: "import", bundle: bundle({ customPresets: "x" }) },
    {
      op: "import",
      bundle: bundle({
        installed: [
          null,
          { vendor: "Acme", model: ACME_BIG },
          { vendor: " ", model: ACME_BIG, variants: [] },
          { vendor: "Acme", model: ACME_BIG, variants: ["0.4", 4, null] },
        ],
      }),
    },
    {
      op: "import",
      bundle: bundle({
        installed: [{ vendor: "Acme", model: "Unknown", variants: ["0.4"] }],
      }),
    },
    {
      op: "import",
      bundle: bundle({
        installed: [{ vendor: "Acme", model: ACME_BIG, variants: ["0.4"] }],
        customPresets: [
          customRecord(),
          customRecord({
            name: "Noted",
            provenance: provenance({ note: "  kept " }),
          }),
          customRecord({
            name: "Second",
            provenance: provenance({ derivedFrom: "x", source: "odd" }),
          }),
          customRecord({
            name: "Third",
            provenance: provenance({ derivedFrom: { name: " " } }),
          }),
          customRecord({ name: "Fourth", vendor: " " }),
        ],
      }),
    },
    { op: "views" },
    {
      op: "import",
      bundle: bundle({
        customPresets: [
          7,
          customRecord({ kind: "printer" }),
          customRecord({ kind: 4 }),
          customRecord({ kind: undefined }),
          customRecord({ name: " " }),
          customRecord({ inherits: 5 }),
          customRecord({ overrides: [] }),
          customRecord({ overrides: null }),
          customRecord({ provenance: undefined }),
          customRecord({ provenance: [] }),
          customRecord({
            provenance: provenance({
              license: "",
              version: 3,
              createdAt: "yesterday",
              updatedAt: "2026-13-45",
            }),
          }),
        ],
      }),
    },
    {
      op: "import",
      bundle: bundle({
        customPresets: [
          customRecord({ overrides: undefined }),
          customRecord({
            name: "Keys",
            overrides: {
              unknown_key: 1,
              name: "x",
              7: [],
              nozzle_temperature: deep(9),
            },
          }),
          customRecord({ name: "Orphan", inherits: "Missing base" }),
          customRecord({ name: "Imported PLA" }),
        ],
      }),
    },
    // Duplicate members resolve to the last value, as `JSON.parse` does.
    {
      op: "import",
      bundle: bundle({ customPresets: [] }).replace(
        '{"catalogFingerprint"',
        '{"format":"x","catalogFingerprint"',
      ),
    },
    // A number that overflows is malformed input, not a value.
    {
      op: "import",
      bundle: bundle({
        customPresets: [
          customRecord({ overrides: { filament_flow_ratio: [0.9] } }),
        ],
      }).replace("0.9", "1e999"),
    },
    // A lone surrogate survives parsing and is refused when composed.
    {
      op: "import",
      bundle: bundle({
        customPresets: [customRecord({ name: "Bad \\ud800 name" })],
      }).replace("\\\\ud800", "\\ud800"),
    },
    { op: "views" },
  ]),
  scenario(
    "stored-state",
    "acme",
    {
      state: {
        schemaVersion: 1,
        catalogFingerprint: "stale",
        installed: [
          { vendor: "Acme", model: ACME_BIG, variants: ["0.4", "0.9"] },
        ],
        customPresets: [customRecord()],
      },
    },
    [{ op: "views" }],
  ),
  scenario(
    "stored-state-partial",
    "acme",
    {
      state: {
        schemaVersion: 1,
        installed: [
          { vendor: "Acme", model: ACME_BIG, variants: ["0.4"] },
          "x",
        ],
        customPresets: [customRecord(), customRecord({ kind: "x" })],
      },
    },
    [{ op: "views" }],
  ),
  scenario("stored-array", "acme", { state: [] }, [{ op: "views" }]),
  scenario("stored-schema", "acme", { state: { schemaVersion: 2 } }, [
    { op: "views" },
  ]),
  scenario(
    "stored-installed",
    "acme",
    { state: { schemaVersion: 1, installed: 1 } },
    [{ op: "views" }],
  ),
  scenario(
    "stored-text",
    "acme",
    {
      storedText: stableStringify({
        schemaVersion: 1,
        catalogFingerprint: "",
        installed: [{ vendor: "Acme", model: ACME_BIG, variants: ["0.2"] }],
        customPresets: [customRecord()],
      }),
    },
    [{ op: "views" }],
  ),
  scenario("stored-garbage", "acme", { storedText: "{oops" }, [
    { op: "views" },
  ]),
  scenario(
    "stored-overflow",
    "acme",
    { storedText: '{"schemaVersion":1e999}' },
    [{ op: "views" }],
  ),
  scenario("stored-nothing", "acme", { storedText: null }, [{ op: "views" }]),
  scenario("bundled", "bundled", {}, [
    { op: "views" },
    { op: "inventory" },
    {
      op: "install",
      vendor: "Elegoo",
      model: "Elegoo Centauri Carbon",
      variants: ["0.4", "0.2"],
    },
    {
      op: "install",
      vendor: "Snapmaker",
      model: "Snapmaker U1",
      variants: ["0.4"],
    },
    { op: "views" },
    {
      op: "bases",
      kind: "process",
      printerId: id("Snapmaker", "machine", "Snapmaker U1 (0.4 nozzle)"),
    },
    {
      op: "bases",
      kind: "filament",
      printerId: id("Elegoo", "machine", "Elegoo Centauri Carbon 0.4 nozzle"),
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "My PLA Matte",
        inherits: "Elegoo PLA Matte @ECC",
        overrides: { nozzle_temperature: ["215"] },
      },
    },
    {
      op: "create",
      draft: {
        kind: "filament",
        name: "My PLA-CF",
        inherits: "Elegoo PLA-CF @ECC",
        overrides: {
          nozzle_temperature: ["230"],
          filament_flow_ratio: ["0.95"],
        },
      },
    },
    {
      op: "create",
      draft: {
        kind: "process",
        name: "My U1 Standard",
        inherits: "0.20 Standard @Snapmaker U1 (0.4 nozzle)",
        overrides: { sparse_infill_density: "25%" },
      },
    },
    { op: "views" },
    { op: "inventory" },
    { op: "uninstall", vendor: "Elegoo", model: "Elegoo Centauri Carbon" },
    { op: "export", exportedAt: "2026-08-22T00:00:00.000Z" },
    { op: "import", bundle: (exported) => exported[0] },
    { op: "plan", catalog: "bundled" },
    { op: "plan", catalog: "acme" },
    { op: "apply", catalog: "acme" },
  ]),
];

// Typed text in the shape of the inherited value, and its presentation.
const coerceCases = [
  [undefined, "  text  "],
  [null, "5"],
  [{}, "x"],
  ["0.2", " 0.3 "],
  [5, " 6 "],
  [5, "1e3"],
  [5, "0.10"],
  [5, "-0"],
  [5, "5abc"],
  [5, "Infinity"],
  [5, ".5"],
  [5, "1e21"],
  [5, "1e+21"],
  [5, ""],
  [true, " true "],
  [true, "1"],
  [false, "yes"],
  [["210"], " 205 ,  , 210,"],
  [[210], "205, 2x, 1e+21, -3.5"],
  [[], "a, b"],
  [[null], "1"],
  [["a"], ""],
].map(([inherited, text]) => ({
  ...(inherited === undefined ? {} : { inheritedJson: json(inherited) }),
  text,
  resultJson: json(coerceOverrideValue(inherited, text)),
}));
const formatCases = [
  undefined,
  null,
  "text",
  0,
  -0,
  1e21,
  0.1,
  true,
  false,
  {},
  [1, "a", [2, 3], null, {}, true],
  [],
].map((value) => ({
  ...(value === undefined ? {} : { valueJson: json(value) }),
  text: formatOverrideValue(value),
}));

// The export's sorted JSON and its digest.
const stableCases = [
  { b: 1, a: [true, null, "x"], 10: 2, 9: { z: -0, y: 1e21 } },
  [" ", "😀", "\ud800"],
].map((value) => ({
  valueJson: json(value),
  text: stableStringify(value),
  digest: fnv1a64Text(stableStringify(value)),
}));

// FNV-1a over WTF-8, lone surrogates included.
const digestCases = [
  "",
  "a",
  "\u00e9",
  "\u2028",
  "\ud83d\ude00",
  "\ud800",
  "x\udc00",
  "\ud800\ud800\udc00",
].map((text) => ({
  units: Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)),
  digest: fnv1a64Text(text),
}));

const sources = [
  "tools/cross-platform/preset-library-vectors.mjs",
  "web/src/settings/presets/PresetLibrary.ts",
  "web/src/settings/presets/PresetGraph.ts",
  "web/src/project/domain/canonical.ts",
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
      catalogs: Object.fromEntries(
        Object.entries(catalogs)
          .filter(([name]) => name !== "bundled")
          .map(([name, value]) => [name, json(value)]),
      ),
      clock: clockValues,
      scenarios,
      coerceCases,
      formatCases,
      stableCases,
      digestCases,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/preset-library-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Preset library reference drift",
  );
const steps = scenarios.reduce((n, s) => n + s.steps.length, 0);
console.log(
  `preset library: ${scenarios.length} scenarios, ${steps} steps, ` +
    `${coerceCases.length} coercions, ${formatCases.length} formats`,
);
