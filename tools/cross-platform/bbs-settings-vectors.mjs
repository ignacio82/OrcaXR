// Independent engine-facing settings bytes from the production browser writer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "../../web/node_modules/typescript/lib/typescript.js";
import {
  buildBbsCore,
  PROJECT_SETTINGS_PATH,
} from "../../web/src/project/serialization/bbsCore.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const cases = [];
function warningCodes(warnings, state) {
  return warnings.flatMap((w) => {
    if (w.startsWith('Added "G92 E0"')) return ["RelativeExtruderReset"];
    if (w.startsWith("Per-plate wipe-tower rotations"))
      return ["WipeTowerRotations"];
    if (w.startsWith("Per-plate wipe-tower enabled states"))
      return ["WipeTowerEnabledStates"];
    for (const [i, f] of state.filaments.mixed.entries()) {
      for (const [prefix, code] of [
        ["Mixed gradient", "ApproximateGradient"],
        ["Mixed cycle", "ApproximateCycle"],
        ["Mixed match-color target", "ApproximateMatch"],
      ]) {
        if (w.startsWith(`${prefix} ${f.id} `)) return [`${code}:${i}`];
      }
    }
    return [];
  });
}
function capture(name, state, assets) {
  assert.equal(
    validateProjectState(state).filter((i) => i.severity === "error").length,
    0,
    name,
  );
  const stateJson = canonicalStringify(state);
  const row = {
    name,
    stateJson,
    assets: assets.map((a) => ({
      descriptorJson: canonicalStringify(a.descriptor),
      bytes: Array.from(a.bytes),
    })),
  };
  try {
    const result = buildBbsCore(
      state,
      new Map(assets.map((a) => [a.descriptor.id, a])),
    );
    row.settings = new TextDecoder().decode(
      result.files.get(PROJECT_SETTINGS_PATH),
    );
    row.warningCodes = warningCodes(result.warnings, state);
    row.browserWarnings = result.warnings;
  } catch (e) {
    row.error = e.message;
  }
  assert.equal(
    canonicalStringify(state),
    stateJson,
    `${name}: export mutated input`,
  );
  cases.push(row);
}
const core = JSON.parse(
  readFileSync(new URL("testdata/cross-platform/bbs-model-vectors.json", root)),
);
for (const row of core.cases.filter((r) => r.xml))
  capture(
    `core-${row.name}`,
    JSON.parse(row.stateJson),
    row.assets.map((a) => ({
      descriptor: JSON.parse(a.descriptorJson),
      bytes: Uint8Array.from(a.bytes),
    })),
  );
function add(name, edit = () => {}) {
  const fixture = createProjectFixture({ withObject: false });
  const state = cloneProjectState(fixture.state);
  edit(state);
  capture(name, state, [fixture.asset]);
}
function physicalCount(s, n) {
  const base = s.filaments.physical[0];
  s.filaments.physical = Array.from({ length: n }, (_, i) => ({
    ...structuredClone(base),
    id: `import:physical-filament:tool-${i}`,
    name: `Tool ${i}`,
    toolId: i,
  }));
  s.printer.toolCount = Math.max(n, 1);
  if (n < 2) s.filaments.mixed = [];
  else
    s.filaments.mixed[0].components = s.filaments.physical.map((p) => ({
      filamentId: p.id,
      weight: 1,
    }));
}
function exact(s) {
  const f = s.filaments.mixed[0],
    ids = s.filaments.physical.map((f) => f.id);
  f.fullSpectrum = {
    schemaVersion: 1,
    upstreamStableId: "18446744073709551615",
    componentAId: ids[0],
    componentBId: ids[1],
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 2,
    localZMaxSublayers: 0,
    gradientEnabled: false,
    gradientStart: 0.8,
    gradientEnd: 0.2,
    componentASurfaceOffsetMm: 0,
    componentBSurfaceOffsetMm: 0,
    deleted: false,
    custom: true,
    originAuto: false,
    uiMode: 0,
  };
  return f.fullSpectrum;
}
add("basic");
add("all-json-values", (s) => {
  Object.assign(s.config, {
    2: "two",
    10: "ten",
    nil: null,
    yes: true,
    no: false,
    zero: -0,
    tiny: Number.MIN_VALUE,
    huge: Number.MAX_VALUE,
    empty: [],
    nested: [
      null,
      [true, [false, 1]],
      { "\ud800": "\udfff", nul: "\0", emoji: "雪😀" },
    ],
    object: { "𐀀": "first", "\ue000": "last" },
    "\0\ud800\udfff": '\b\f\n\r\t\u0001\ufffe\uffff\\"',
  });
  Object.defineProperty(s.config, "__proto__", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { foreign: "preserved" },
  });
});
for (const n of [0, 1, 2, 10, 64, 65])
  add(`physical-count-${n}`, (s) => physicalCount(s, n));
for (const base of [
  undefined,
  null,
  [],
  [null],
  [null, 211],
  [210, 211],
  [210, 211, 212],
  222,
  { nested: [true, null] },
]) {
  for (const local of [undefined, null, 230, [240, 241]]) {
    add(`vector-fallback-${cases.length}`, (s) => {
      for (const p of s.filaments.physical) p.config = {};
      if (base !== undefined) s.config.nozzle_temperature = base;
      if (local !== undefined)
        s.filaments.physical[0].config.nozzle_temperature = local;
    });
  }
}
add("first-defined-null", (s) => {
  s.filaments.physical[0].config = { filament_diameter: null };
  s.filaments.physical[1].config = {};
});
add("late-defined-fallback", (s) => {
  s.filaments.physical[0].config = {};
  s.filaments.physical[1].config = { filament_diameter: 1.75 };
});
const ast = ts.createSourceFile(
  "bbsCore.ts",
  readFileSync(
    new URL("web/src/project/serialization/bbsCore.ts", root),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
let filamentKeys;
for (const statement of ast.statements)
  if (ts.isVariableStatement(statement))
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === "FILAMENT_VECTOR_KEYS")
        filamentKeys = d.initializer.elements.map((v) => v.text);
assert.equal(filamentKeys.length, 98);
add("every-physical-vector-key", (s) => {
  for (const key of filamentKeys) {
    s.config[key] = 7;
    s.filaments.physical[0].config[key] = 11;
    s.filaments.physical[1].config[key] = 13;
  }
  s.config.not_a_filament_vector = 19;
  s.filaments.physical[0].config.not_a_filament_vector = 23;
});
add("correct-length-vector-precedence", (s) => {
  for (const key of filamentKeys) s.config[key] = [null, "imported"];
});
for (const mode of ["absent", "empty", "present", "partial"])
  add(`optional-fields-${mode}`, (s) => {
    for (const [i, p] of s.filaments.physical.entries()) {
      p.enabled = i !== 0;
      if (mode !== "absent") {
        p.presetId = mode === "empty" ? "" : `Preset ${i}`;
        p.presetHash = mode === "empty" ? "" : `Hash ${i}`;
        p.vendor = mode === "empty" ? "" : "Vendor";
      }
      if (mode === "present" || (mode === "partial" && i === 0))
        p.nozzleDiameterMm = 0.4;
    }
    s.config.printer_settings_id = "imported";
    s.config.nozzle_diameter = [0.6];
    if (mode === "absent") delete s.printer.profileId;
    if (mode === "empty") s.printer.profileId = "";
  });
for (const relative of [
  undefined,
  null,
  false,
  true,
  0,
  1,
  2,
  "0",
  "1",
  "true",
  [],
  [1],
  {},
])
  for (const flavor of [undefined, "MaRLin2", "klipper", 7])
    add(`reset-declaration-${cases.length}`, (s) => {
      if (relative !== undefined) s.config.use_relative_e_distances = relative;
      if (flavor !== undefined) s.config.gcode_flavor = flavor;
      s.config.before_layer_change_gcode = "; before";
    });
for (const script of [
  "",
  "G92 E0",
  "g92e0",
  " \tg92\te0. \t;tail",
  "G92 E.000",
  "G92 E00",
  "G92 E0.1",
  "G92 E+0",
  "; G92 E0",
  "G92 E0 extra",
  "\u00a0G92 E0",
  "G92 E0\u00a0",
  "x\rG92 E0\rnext",
  "x\nG92 E0\nnext",
  "x\u2028G92 E0\u2029next",
  "G92 E0;\0\ud800",
  ["G92 E0"],
  42,
  null,
])
  for (const hook of ["before_layer_change_gcode", "layer_change_gcode"])
    add(`reset-script-${cases.length}`, (s) => {
      s.config[hook] = script;
    });
// Check the ASCII flavor fast path against ECMAScript Unicode lowercasing.
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const text = String.fromCodePoint(cp),
    lower = text.toLowerCase();
  if (lower.length === 1 && "marlin".includes(lower))
    assert.ok(text === lower || text === lower.toUpperCase());
}
for (const mode of ["disabled", "mixed", "all", "missing-slot"])
  add(`towers-${mode}`, (s) => {
    const template = s.plates[0],
      ids = s.filaments.physical.map((p) => p.id);
    s.plates = Array.from({ length: 4 }, (_, i) => ({
      ...structuredClone(template),
      id: i ? `import:plate:plate-${i}` : template.id,
      order: 3 - i,
      ...(i === 3
        ? {}
        : {
            wipeTower: {
              enabled: mode !== "disabled" && (mode === "all" || i < 2),
              positionMm: [i * 10 + 1, i * 10 + 2],
              rotationDeg: i ? 30 : 45,
              filamentId: ids[i % 2],
            },
          }),
    }));
    s.config.wipe_tower_filament = 81;
    s.config.wipe_tower_x = [82];
    s.config.enable_prime_tower = false;
    if (mode === "missing-slot") {
      s.filaments.mixed[0].enabled = false;
      s.plates[1].wipeTower.filamentId = s.filaments.mixed[0].id;
    }
  });
for (const weights of [
  [1, 1],
  [0, 1],
  [1, 0],
  [1, 2],
  [1e308, 1e308],
  [1e307, 1],
  [Number.MIN_VALUE, Number.MIN_VALUE],
  [Number.MIN_VALUE, Number.MAX_VALUE],
  [0, 1, 1],
  [1, 1, 1],
  [1, 1, 1, 1, 1, 1],
])
  for (const mode of ["ratio", "cycle", "match", "gradient"])
    add(`mixed-${mode}-${cases.length}`, (s) => {
      physicalCount(s, weights.length);
      const f = s.filaments.mixed[0];
      f.components.forEach((c, i) => (c.weight = weights[i]));
      f.enabled = false;
      f.distribution =
        mode === "gradient"
          ? {
              mode,
              startWeights: weights,
              endWeights: weights.slice().reverse(),
              startZMm: 1,
              endZMm: 10,
            }
          : mode === "match"
            ? { mode, targetColor: "#abcdef" }
            : mode === "cycle"
              ? { mode, cycleLengthMm: 0.2 }
              : { mode };
    });
add("gradient-zero-fallback", (s) => {
  s.filaments.mixed[0].distribution = {
    mode: "gradient",
    startWeights: [0, 0],
    endWeights: [0, 0],
  };
});
for (const id of [
  "import:mixed-filament:雪😀",
  "import:mixed-filament:\ud800",
  "import:mixed-filament:\udfff",
  "import:mixed-filament:\0",
])
  add(`stable-utf16-${cases.length}`, (s) => {
    s.filaments.mixed[0].id = id;
  });
add("multiple-mixed-rows", (s) => {
  const f = structuredClone(s.filaments.mixed[0]);
  f.id = "import:mixed-filament:second";
  f.distribution = { mode: "cycle" };
  f.enabled = false;
  s.filaments.mixed.push(f);
});
add("no-mixed-preserves-imported", (s) => {
  s.filaments.mixed = [];
  s.config.mixed_filament_definitions = "imported rows";
});
for (const n of [2, 10, 64, 65])
  add(`exact-library-${n}`, (s) => {
    physicalCount(s, n);
    const r = exact(s);
    r.gradientComponentIds = s.filaments.physical.map((p) => p.id);
    r.gradientComponentWeights = r.gradientComponentIds.map(() => 1);
  });
for (const uiMode of [-1, 0, 1, 2, 3])
  for (const distributionMode of [0, 2])
    add(`exact-modes-${uiMode}-${distributionMode}`, (s) => {
      Object.assign(exact(s), {
        uiMode,
        distributionMode,
        upstreamStableId: "0",
        custom: false,
        deleted: true,
        originAuto: true,
        localZMaxSublayers: 9007199254740991,
      });
      s.filaments.mixed[0].enabled = false;
    });
for (const v of [
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  0.00005,
  -0.00005,
  0.03125,
  -0.03125,
  1.23445,
  -1.23445,
  2,
  -2,
])
  add(`exact-offset-${cases.length}`, (s) => {
    const r = exact(s);
    r.componentASurfaceOffsetMm = v;
    r.componentBSurfaceOffsetMm = -v;
    r.gradientEnabled = true;
    r.gradientStart = 0.03125;
    r.gradientEnd = 0.99995;
  });
for (const groups of [
  [[2]],
  [[10]],
  [[64]],
  [[2, 2, 2], [1]],
  [[10, 3, 10], [3]],
  [[1, 10, 2, 64, 9]],
  [
    [64, 64, 3],
    [10, 10],
  ],
  [[1], [2, 2, 1, 1, 1]],
])
  for (const reverse of [false, true])
    add(`exact-pattern-${cases.length}`, (s) => {
      physicalCount(s, 64);
      const ids = s.filaments.physical.map((p) => p.id),
        r = exact(s);
      r.manualPatternGroups = groups.map((group) =>
        group.map((n) => ids[n - 1]),
      );
      if (reverse) s.filaments.physical.reverse();
    });
let seed = 0x14d86af9;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
for (let i = 0; i < 96; i++)
  add(`exact-random-pattern-${i}`, (s) => {
    physicalCount(s, 2 + (random() % 63));
    const r = exact(s),
      ids = s.filaments.physical.map((p) => p.id);
    r.manualPatternGroups = Array.from({ length: 1 + (random() % 7) }, () =>
      Array.from(
        { length: 1 + (random() % 31) },
        () => ids[random() % ids.length],
      ),
    );
  });
add("exact-group-average-below-half", (s) => {
  const r = exact(s),
    [a, b] = s.filaments.physical.map((p) => p.id);
  // 100 * (29 / 200) / 29 is the double immediately below 0.5. Adding 0.5
  // before flooring incorrectly changes the engine-facing B percentage to one.
  r.manualPatternGroups = [
    [...Array(29).fill(b), ...Array(171).fill(a)],
    ...Array.from({ length: 28 }, () => [a]),
  ];
});
assert.ok(
  JSON.parse(cases.at(-1).settings).mixed_filament_definitions.startsWith(
    "1,2,1,1,0,0,",
  ),
);
const view = new DataView(new ArrayBuffer(8)),
  numbers = [];
function number(value) {
  if (!Number.isFinite(value)) return;
  view.setFloat64(0, value);
  numbers.push({
    bits: view.getBigUint64(0).toString(16).padStart(16, "0"),
    fixed4: value.toFixed(4),
  });
}
for (const n of [
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  0.00005,
  -0.00005,
  0.03125,
  -0.03125,
  1.23445,
  1e20,
  1e21,
  Number.MAX_VALUE,
])
  number(n);
for (let i = 0; i < 4096; i++) {
  view.setUint32(0, random());
  view.setUint32(4, random());
  number(view.getFloat64(0));
}
const sources = [
  "tools/cross-platform/bbs-settings-vectors.mjs",
  "web/src/project/__tests__/fixtures.ts",
  "testdata/cross-platform/bbs-model-vectors.json",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/filaments/fullSpectrumRecipe.ts",
  "web/src/project/serialization/bbsNumbers.ts",
  "web/src/project/serialization/bbsXml.ts",
];
const output = new URL(
    "testdata/cross-platform/bbs-settings-vectors.json",
    root,
  ),
  bytes = `${JSON.stringify(
    {
      version: 1,
      sources: Object.fromEntries(
        sources.map((p) => [
          p,
          createHash("sha256")
            .update(readFileSync(new URL(p, root)))
            .digest("hex"),
        ]),
      ),
      cases,
      numbers,
    },
    null,
    2,
  )}\n`;
if (process.argv.includes("--write")) writeFileSync(output, bytes);
else
  assert.equal(
    readFileSync(output, "utf8"),
    bytes,
    "BBS settings references are stale",
  );
console.log(
  JSON.stringify({
    cases: cases.length,
    accepted: cases.filter((r) => r.settings).length,
    refused: cases.filter((r) => r.error).length,
    numbers: numbers.length,
  }),
);
