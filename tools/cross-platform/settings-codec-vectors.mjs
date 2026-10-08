// Engine-option value codec references from the production browser
// (`codec.ts`, `configBridge.ts`) over the pinned schema, replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { createEngineOptionCatalog } from "../../web/src/settings/generated/loader.ts";
import {
  codecContractIssue,
  enumChoicesFor,
  parseSettingDraft,
  serializeSettingValue,
  validateSettingValue,
} from "../../web/src/settings/editor/codec.ts";
import {
  applySettingsCommitToConfig,
  decodeSettingsConfig,
} from "../../web/src/settings/editor/configBridge.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const schemaPath = "web/src/settings/generated/engine-options.schema.json";
const catalog = createEngineOptionCatalog(JSON.parse(read(schemaPath)));

// Definitions sharing a storage contract, bounds and enum domain behave
// identically; one representative of each keeps the corpus bounded.
const signature = (d) =>
  JSON.stringify([
    d.storage,
    d.constraints.min.value,
    d.constraints.max.value,
    d.enum.values.map((v) => v.value),
    d.enum.labels.map((v) => v.value),
  ]);
const representatives = new Map();
for (const d of catalog.definitions)
  if (!representatives.has(signature(d))) representatives.set(signature(d), d);

const attempt = (run) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: error.message };
  }
};
const drafts = (d) => {
  const enumValues = d.enum.values.map((v) => v.value);
  const min = d.constraints.min.value;
  const max = d.constraints.max.value;
  const near = [min, max]
    .filter((v) => v !== null)
    .flatMap((v) => [String(v), String(v - 1), String(v + 1), `${v}%`]);
  return [
    ...new Set([
      "",
      " ",
      "0",
      "1",
      "-0",
      "+5",
      " 7 ",
      "1.5",
      ".5",
      "5.",
      "1e3",
      "1E-2",
      "1e",
      "1e400",
      "9007199254740993",
      "0x10",
      "Infinity",
      "abc",
      "true",
      " FALSE ",
      "TRUE",
      "nil",
      " nil ",
      "50%",
      " 50% ",
      "50 %",
      "%",
      "1x2",
      "1x2x3",
      "1,2",
      "1, 2",
      "1,2,3",
      "1x2,3x4",
      "1;2",
      "a;b",
      ";",
      ",",
      "1,,2",
      "nil,1",
      "1,nil",
      "１",
      " 1 ",
      "\ud800",
      ...enumValues,
      ...enumValues.map((v) => ` ${v} `),
      ...enumValues.map((v) => v.toUpperCase()),
      enumValues.join(","),
      ...near,
    ]),
  ];
};
const values = (d) => {
  const min = d.constraints.min.value;
  const max = d.constraints.max.value;
  const enumValues = d.enum.values.map((v) => v.value);
  return [
    null,
    true,
    false,
    0,
    1,
    1.5,
    -1,
    1e300,
    "PLA",
    "",
    "a;b",
    [],
    [1, 2],
    [1, "a"],
    [true, false],
    [null],
    [null, 1],
    { percent: true, value: 5 },
    { percent: false, value: -1 },
    [{ percent: true, value: 1 }],
    [[1, 2]],
    [
      [1, 2],
      [3, 4],
    ],
    [1, 2, 3],
    ["a", "b"],
    ["a;b"],
    ["a,b"],
    enumValues[0] ?? "x",
    enumValues.slice(0, 2),
    ...(min === null ? [] : [min - 1, [min - 1], [[min - 1, min]]]),
    ...(max === null ? [] : [max + 1, [max + 1], [[max, max + 1]]]),
  ];
};

const codec = [];
for (const d of representatives.values()) {
  codec.push({
    id: d.id,
    contract: codecContractIssue(d) ?? null,
    choices: enumChoicesFor(d),
    drafts: drafts(d).map((raw) => ({
      raw,
      result: parseSettingDraft(d, raw),
    })),
    values: values(d).map((value) => ({
      value,
      issues: validateSettingValue(d, value),
      serialized: attempt(() => serializeSettingValue(d, value)),
    })),
  });
}

// Configuration decoding over every key, foreign keys and stored values that
// no definition, or several definitions differently, accept.
const sample = (d) =>
  d.storage.valueType === "enum"
    ? (d.enum.values[0]?.value ?? "")
    : d.storage.valueType === "bool"
      ? "1"
      : d.storage.valueType === "string"
        ? "text"
        : d.storage.valueType.startsWith("point")
          ? d.storage.shape === "vector"
            ? "0x0,10x10"
            : d.storage.valueType === "point3"
              ? "1,2,3"
              : "1,2"
          : d.storage.valueType === "float-or-percent"
            ? "50%"
            : "1";
const everyKey = Object.fromEntries(
  catalog.definitions.map((d) => [d.key, sample(d)]),
);
const configs = [
  { name: "every-key", config: everyKey },
  {
    name: "mixed-json",
    config: {
      layer_height: 0.2,
      wall_loops: "3",
      enable_support: true,
      sparse_infill_density: "15%",
      outer_wall_speed: { percent: true, value: 50 },
      nozzle_diameter: [0.4, 0.6],
      filament_type: ["PLA", "PETG"],
      printable_area: "0x0,220x0,220x220,0x220",
      bed_exclude_area: [],
      seam_position: "aligned",
      chamber_temperature: "35",
      "": "x",
      future_setting: "1",
      "\ud800": "y",
      ["__proto__"]: "kept",
      layer_heightz: "0.2",
    },
  },
  {
    name: "invalid-values",
    config: {
      layer_height: "fast",
      wall_loops: "2.5",
      enable_support: "yes",
      sparse_infill_density: ["15%"],
      seam_position: "nowhere",
      nozzle_diameter: "0.4;0.6",
      outer_wall_speed: { percent: true, value: 50, extra: 1 },
      printable_area: [[0, 0]],
      filament_type: "PLA;PETG",
      wipe_tower_x: null,
    },
  },
];
const decoded = configs.map(({ name, config }) => ({
  name,
  config,
  result: decodeSettingsConfig(catalog, config),
}));
const commits = [
  {
    previous: { layer_height: "0.2", future: "kept" },
    changes: [
      { key: "layer_height", action: "set", serialized: "0.28" },
      { key: "wall_loops", action: "set", serialized: "3" },
      { key: "future", action: "remove" },
    ],
  },
  { previous: {}, changes: [{ key: " ", action: "set", serialized: "1" }] },
  {
    previous: {},
    changes: [
      { key: "a", action: "remove" },
      { key: "a", action: "set", serialized: "1" },
    ],
  },
  { previous: {}, changes: [{ key: "b\ud800", action: "set" }] },
  { previous: { nested: { a: [1, null] } }, changes: [] },
].map((c) => ({
  ...c,
  result: attempt(() =>
    applySettingsCommitToConfig(c.previous, {
      baseRevision: 0,
      revision: 1,
      changes: c.changes.map((change) => ({
        fieldId: change.key,
        owner: "",
        ...change,
      })),
      nextOverrides: {},
    }),
  ),
}));

const contracts = Object.fromEntries(
  catalog.definitions.map((d) => [d.id, codecContractIssue(d) ?? null]),
);
const sources = [
  "tools/cross-platform/settings-codec-vectors.mjs",
  "web/src/settings/editor/codec.ts",
  "web/src/settings/editor/configBridge.ts",
  "web/src/settings/generated/loader.ts",
  schemaPath,
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      definitions: catalog.definitions.length,
      representatives: codec.length,
      contractsJson: canonicalStringify(contracts),
      codecJsons: codec.map((c) => canonicalStringify(c)),
      decodedJson: canonicalStringify(decoded),
      commitsJson: canonicalStringify(commits),
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/settings-codec-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Settings codec reference drift",
  );
console.log(
  `settings codec: ${catalog.definitions.length} definitions, ${codec.length} contracts, ` +
    `${codec.reduce((n, c) => n + c.drafts.length + c.values.length, 0)} cases, ${decoded.length} configs, ${commits.length} commits`,
);
