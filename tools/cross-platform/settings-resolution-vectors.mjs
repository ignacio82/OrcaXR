// Expected results execute the browser domain, independently of native code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  SETTING_SCOPE_KEYS,
  SETTING_SCOPE_ORDER,
  SETTING_SCOPE_SOURCE,
  scopesForSetting,
  narrowestScopeForSetting,
  validateScopedOverrides,
  resolveScopedConfig,
  explainSetting,
  sanitizeScopedOverrides,
} from "../../web/src/project/domain/settingScopes.ts";
import { resolveConfig } from "../../web/src/project/domain/selectors.ts";
import {
  canonicalStringify as json,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
import { seededRandom } from "../../web/src/project/domain/ids.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const map = (key, value) => Object.fromEntries([[key, value]]);
const unknown = [
  "",
  "0",
  "2",
  "10",
  "__proto__",
  "constructor",
  "toString",
  "future-setting",
  "layer_height\0",
  "\ud800",
  "\ud800\udc00",
  "\ue000",
];
const keys = [
  ...new Set(SETTING_SCOPE_ORDER.flatMap((scope) => SETTING_SCOPE_KEYS[scope])),
].sort();
const membership = [...keys, ...unknown].map((key) => ({
  keyUtf16: units(key),
  scopes: scopesForSetting(key),
  narrowest: narrowestScopeForSetting(key) ?? null,
}));
const cases = [];
function add(name, base, layers, explainKeys) {
  const before = json({ base, layers });
  const issues = validateScopedOverrides(layers);
  let resolved = null;
  let error = null;
  const explanations = [];
  try {
    resolved = json(resolveScopedConfig(base, layers));
    for (const key of explainKeys)
      explanations.push({
        keyUtf16: units(key),
        resultJson: json(explainSetting(base, layers, key)),
      });
  } catch (failure) {
    assert.ok(issues.length > 0);
    error = { name: failure.name, message: failure.message };
    for (const key of explainKeys)
      assert.throws(
        () => explainSetting(base, layers, key),
        (failure) => json(failure.issues) === json(issues),
      );
  }
  assert.equal(json({ base, layers }), before, "reference input mutated");
  cases.push({
    name,
    baseJson: json(base),
    layersJson: json(layers),
    issuesJson: json(issues),
    resolvedJson: resolved,
    errorJson: error === null ? null : json(error),
    explanations,
  });
}
for (const key of [...keys, ...unknown]) {
  for (const scope of SETTING_SCOPE_ORDER)
    add(
      `matrix:${scope}:${keys.indexOf(key)}:${unknown.indexOf(key)}`,
      map(key, null),
      [
        {
          scope,
          id: "node\0\ud800",
          overrides: map(key, { source: scope, values: [false, 0, "\udfff"] }),
        },
      ],
      [key],
    );
  const layers = scopesForSetting(key)
    .map((scope, i) => ({ scope, id: `node-${i}`, overrides: map(key, i + 1) }))
    .reverse();
  add(
    `precedence:${keys.indexOf(key)}:${unknown.indexOf(key)}`,
    map(key, 0),
    layers,
    [key, "absent"],
  );
}
add(
  "empty-with-own-prototype-key",
  JSON.parse(
    '{"__proto__":{"own":true},"constructor":null,"values":[0,false,"x"]}',
  ),
  [],
  ["__proto__", "constructor", "absent"],
);
add(
  "stable-equal-scope-order",
  { wall_loops: 0 },
  ["z", "a", "m"].map((id, i) => ({
    scope: "object",
    id,
    overrides: { wall_loops: i + 1 },
  })),
  ["wall_loops"],
);
for (const id of [undefined, "", "node\0\ud800"]) {
  add(
    "duplicate-with-all-issues",
    {},
    [
      {
        scope: "plate",
        ...(id === undefined ? {} : { id }),
        overrides: { wall_loops: 1 },
      },
      {
        scope: "plate",
        ...(id === undefined ? {} : { id }),
        overrides: { future: null, layer_height: 0.2 },
      },
    ],
    ["wall_loops"],
  );
}
add(
  "omitted-and-empty-node-identity",
  {},
  [
    { scope: "part", overrides: {} },
    { scope: "part", id: "", overrides: {} },
  ],
  ["wall_loops"],
);
for (const scope of [
  "unknown",
  "plate\0",
  "__proto__",
  "constructor",
  "toString",
  "PROJECT",
  "layer-range",
  "\ud800",
  'a"\nb',
])
  add(
    "unknown-scope",
    {},
    [
      { scope, overrides: { wall_loops: 1 } },
      { scope, overrides: {} },
      { scope: "plate", overrides: { wall_loops: 2 } },
    ],
    ["wall_loops"],
  );
const random = seededRandom(2026);
for (let i = 0; i < 160; i++) {
  const layers = Array.from({ length: 1 + (i % 9) }, (_, n) => {
    const scope =
      SETTING_SCOPE_ORDER[Math.floor(random() * SETTING_SCOPE_ORDER.length)];
    const allowed = SETTING_SCOPE_KEYS[scope];
    const overrides = Object.fromEntries(
      Array.from({ length: 4 }, () => [
        allowed[Math.floor(random() * allowed.length)],
        [i, n, false, null, "\ud800", { ["__proto__"]: n }],
      ]),
    );
    return { scope, id: `node-${n}`, overrides };
  });
  add(
    `random:${i}`,
    { wall_loops: 1, unknown: { retained: true } },
    layers,
    [...new Set(layers.flatMap((layer) => Object.keys(layer.overrides)))].slice(
      0,
      4,
    ),
  );
}
const sanitize = [];
for (const scope of SETTING_SCOPE_ORDER)
  for (const id of [undefined, "", "id\0\ud800"]) {
    const overrides = Object.fromEntries(
      [...keys, ...unknown]
        .reverse()
        .map((key, i) => [key, { tag: i, ["__proto__"]: [false, null] }]),
    );
    const before = json(overrides);
    const output = sanitizeScopedOverrides(scope, overrides, id);
    assert.equal(json(overrides), before);
    sanitize.push({
      scope,
      idUtf16: id === undefined ? null : units(id),
      overridesJson: before,
      resultJson: json(output),
    });
  }

const model = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
);
const graph = [];
for (const name of [
  "complete-schema-with-unknowns",
  "minimal",
  "utf16-identities-and-references",
]) {
  const original = model.cases.find((entry) => entry.name === name);
  assert.ok(original, name);
  const state = JSON.parse(original.stateJson);
  const requests = [];
  for (const plate of state.plates) {
    requests.push({ plateId: plate.id });
    for (const object of plate.objects) {
      requests.push({ plateId: plate.id, objectId: object.id });
      for (const volume of object.volumes)
        requests.push({
          plateId: plate.id,
          objectId: object.id,
          volumeId: volume.id,
        });
      for (const range of object.layerRanges) {
        requests.push({
          plateId: plate.id,
          objectId: object.id,
          layerRangeId: range.id,
        });
        for (const volume of object.volumes)
          requests.push({
            plateId: plate.id,
            objectId: object.id,
            volumeId: volume.id,
            layerRangeId: range.id,
          });
      }
    }
  }
  const missing = "import:test:absent\0\ud800";
  const plate = state.plates[0];
  requests.push(
    { plateId: missing },
    { plateId: plate.id, objectId: missing },
    { plateId: plate.id, volumeId: missing },
    { plateId: plate.id, layerRangeId: missing },
  );
  const object = plate.objects[0];
  if (object) {
    requests.push(
      { plateId: plate.id, objectId: object.id, volumeId: missing },
      { plateId: plate.id, objectId: object.id, layerRangeId: missing },
    );
    const second = state.plates[1]?.objects[0];
    if (second)
      requests.push(
        { plateId: plate.id, objectId: second.id },
        {
          plateId: plate.id,
          objectId: object.id,
          volumeId: second.volumes[0].id,
        },
        {
          plateId: plate.id,
          objectId: object.id,
          layerRangeId: second.layerRanges[0].id,
        },
      );
  }
  const before = json(state);
  const queries = requests.map((request) => {
    let result;
    try {
      result = { value: resolveConfig(state, request) };
    } catch (error) {
      result = { error: error.message };
    }
    assert.equal(json(state), before);
    return { requestJson: json(request), resultJson: json(result) };
  });
  graph.push({ name, stateJson: before, queries });
}
// The regression that motivated correcting the browser projection is included
// independently of the authored model fixture's original property order.
const state = JSON.parse(
  model.cases.find((entry) => entry.name === "minimal").stateJson,
);
state.config = { wall_loops: 2, layer_height: 0.2 };
state.plates[0].config = {
  z_foreign: true,
  wall_loops: 99,
  10: 10,
  2: 2,
  print_sequence: "by object",
  a_foreign: false,
};
const request = { plateId: state.activePlateId };
assert.deepEqual(
  resolveConfig(state, request),
  resolveConfig(JSON.parse(json(state)), request),
);
graph.push({
  name: "ignored-local-is-inherited",
  stateJson: json(state),
  queries: [
    {
      requestJson: json(request),
      resultJson: json({ value: resolveConfig(state, request) }),
    },
  ],
});

const sources = [
  "web/src/project/domain/settingScopes.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/settings/generated/settingScopes.ts",
  "tools/settings-schema/generate-scopes.mjs",
  "testdata/cross-platform/project-model-vectors.json",
];
const result = {
  schemaVersion: 1,
  source: SETTING_SCOPE_SOURCE,
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256").update(read(path)).digest("hex"),
  })),
  membership,
  cases,
  sanitize,
  graph,
};
const output = JSON.stringify(result, null, 2) + "\n";
const path = new URL(
  "testdata/cross-platform/settings-resolution-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Settings reference drift");
console.log(
  `Settings references: ${membership.length} keys, ${cases.length} layer cases, ${sanitize.length} sanitizers, ${graph.reduce((sum, entry) => sum + entry.queries.length, 0)} graph queries`,
);
