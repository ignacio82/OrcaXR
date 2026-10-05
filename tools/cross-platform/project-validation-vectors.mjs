// Execute the browser graph validator. No native implementation supplies results.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneJson,
  projectFingerprint,
} from "../../web/src/project/domain/canonical.ts";
import {
  validateProjectState,
  ProjectValidationError,
} from "../../web/src/project/domain/validation.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
const root = new URL("../../", import.meta.url);
// Date.parse is host-dependent; the native replay supplies this exact fixed zone.
process.env.TZ = "UTC";
const read = (p) => readFileSync(new URL(p, root), "utf8");
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const obj = (s) => s.plates[0].objects[0],
  vol = (s) => obj(s).volumes[0],
  mix = (s) => s.filaments.mixed[0],
  recipe = (s) => mix(s).fullSpectrum;
const id = "import:validation:missing",
  privateId = "import:PRIVATE_GRAPH_TEXT:\0\ud800";
const models = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
);
const complete = JSON.parse(models.cases[0].stateJson);
const base = createProjectFixture().state;
base.settingsBaseConfig = cloneJson(base.config);
base.settingsOverrides = {};
base.sourceAssets[0].mesh.indices = {
  byteOffset: 0,
  byteLength: 0,
  componentType: "uint32",
  componentCount: 1,
  count: 0,
};
base.plates[0].wipeTower = {
  enabled: true,
  positionMm: [1, 2],
  rotationDeg: 0,
  filamentId: base.filaments.physical[0].id,
};
obj(base).brimEars = [{ positionMm: [0, 0, 0], headFrontRadiusMm: 1 }];
obj(base).layerRanges.push({
  ...cloneJson(obj(base).layerRanges[0]),
  id: "import:range:high",
  minZMm: 10,
  maxZMm: 20,
});
mix(base).fullSpectrum = JSON.parse(
  JSON.stringify(complete.filaments.mixed[0].fullSpectrum, (_k, v) =>
    v === complete.filaments.physical[0].id
      ? base.filaments.physical[0].id
      : v === complete.filaments.physical[1].id
        ? base.filaments.physical[1].id
        : v,
  ),
);
base.customGcode = [0.2, 0.3].map((topZMm, i) => ({
  id: `import:gcode:${i}`,
  scope: "plate",
  plateId: base.activePlateId,
  trigger: "before-layer",
  code: "",
  layerEvent: { type: "pause", topZMm },
}));
base.thumbnails = [
  {
    id: "import:thumbnail:0",
    assetId: base.sourceAssets[0].id,
    plateId: base.activePlateId,
    width: 1,
    height: 1,
  },
];
base.extensionBlobs = [
  {
    id: "import:extension:0",
    assetId: base.sourceAssets[0].id,
    namespace: "fixture",
    path: "Metadata/fixture.bin",
    relationships: [],
  },
];
assert.deepEqual(validateProjectState(base), []);
const cases = [];
function record(name, state) {
  const issues = validateProjectState(state);
  const reopened = JSON.parse(canonicalStringify(state));
  assert.deepEqual(
    validateProjectState(reopened),
    issues,
    `${name} diagnostics must survive persistence`,
  );
  cases.push({
    name,
    stateJson: canonicalStringify(state),
    fingerprint: projectFingerprint(state),
    issues: issues.map((i) => ({
      ...i,
      path: units(i.path),
      message: units(i.message),
    })),
    errorMessage: units(new ProjectValidationError(issues).message),
  });
}
function change(name, modify) {
  const state = cloneJson(base);
  modify(state);
  try {
    record(name, state);
  } catch (error) {
    throw new Error(`Graph fixture ${name} failed`, { cause: error });
  }
}
for (const c of models.cases)
  record(`model-${c.name}`, JSON.parse(c.stateJson));
record("base", base);
const negatives = [];
function bad(name, modify) {
  negatives.push([name, modify]);
  change(name, modify);
}
bad("empty-name", (s) => (s.name = "\ufeff\t\u2028"));
for (const [i, text] of [
  "",
  "no date",
  "Feb 31 2000 GMT",
  "Jan 1 1970 GMT+500000:00",
  "+275760-09-13T00:00:00.001Z",
  "2026-10-05\0garbage",
  "2026-10-05T12:34:56",
].entries())
  change(`timestamp-${i}`, (s) => {
    s.createdAt = text;
    s.updatedAt = text;
  });
for (const [i, n] of [0, -1, 0.5, 1, 1e100].entries())
  change(`tool-count-${i}`, (s) => (s.printer.toolCount = n));
bad("blank-config-keys", (s) => {
  s.config[""] = 1;
  s.config["\u2000"] = 2;
  s.settingsBaseConfig = cloneJson(s.config);
  obj(s).config["\n"] = 0;
  vol(s).config[" "] = 0;
  s.plates[0].config["\ufeff"] = 0;
  s.filaments.physical[0].config[""] = 0;
  mix(s).config[""] = 0;
  obj(s).layerRanges[0].config[""] = 0;
});
bad("missing-settings-base", (s) => delete s.settingsBaseConfig);
bad(
  "effective-settings-mismatch",
  (s) => (s.settingsOverrides.layer_height = 0.18),
);
for (const [i, value] of [
  null,
  { ["__proto__"]: { n: [1, -0, 5e-324] }, "\ud800": [null, true, "\udfff"] },
  [1, 2, { x: "long" }],
].entries())
  change(`effective-settings-identity-${i}`, (s) => {
    s.settingsBaseConfig = { v: value };
    s.settingsOverrides = {};
    s.config = cloneJson(s.settingsBaseConfig);
  });
change("effective-override-keys", (s) => {
  s.settingsBaseConfig = { a: 1, b: 2 };
  s.settingsOverrides = { b: null, c: { nested: [-0, 1e100] } };
  s.config = { ...s.settingsBaseConfig, ...s.settingsOverrides };
});
bad("effective-deep-mismatch", (s) => {
  s.settingsBaseConfig = { v: [{ a: 1 }] };
  s.settingsOverrides = {};
  s.config = { v: [{ a: 2 }] };
});
bad("empty-digest", (s) => (s.sourceAssets[0].digest = "\u3000"));
for (const [i, n] of [-1, 0.5, 0, 1e100].entries())
  change(`byte-length-${i}`, (s) => (s.sourceAssets[0].byteLength = n));
bad("missing-layout", (s) => delete s.sourceAssets[0].mesh);
bad("unexpected-layout", (s) => (s.sourceAssets[0].kind = "archive"));
for (const [i, n] of [-1, 0.5, 0, 1e100].entries())
  change(`triangle-count-${i}`, (s) => {
    s.sourceAssets[0].mesh.triangleCount = n;
    vol(s).source.triangleCount = n;
  });
for (const name of ["positions", "indices"])
  for (const [field, value] of [
    ["byteOffset", -1],
    ["byteLength", -1],
    ["byteLength", 100],
    ["count", -0.1],
    ["byteOffset", 0.5],
    ["byteStride", -4],
  ])
    change(
      `buffer-${name}-${field}-${value}`,
      (s) => (s.sourceAssets[0].mesh[name][field] = value),
    );
for (const [i, n] of [-1, 0.5, 2, 0, 1e100].entries())
  change(`physical-tool-${i}`, (s) => (s.filaments.physical[1].toolId = n));
bad("duplicate-tools", (s) => (s.filaments.physical[1].toolId = -0));
bad("mixed-empty", (s) => (mix(s).components = []));
bad("mixed-single", (s) => (mix(s).components.length = 1));
bad("negative-mixed-weight", (s) => (mix(s).components[0].weight = -1));
bad("zero-mixed-total", (s) =>
  mix(s).components.forEach((c) => (c.weight = 0)),
);
for (const [i, n] of [undefined, -1, 0, 0.5, 1e100].entries())
  change(
    `cycle-${i}`,
    (s) =>
      (mix(s).distribution = {
        mode: "cycle",
        ...(n === undefined ? {} : { cycleLengthMm: n }),
      }),
  );
for (const [i, d] of [
  { mode: "gradient", startWeights: [1, 0], endWeights: [0, 1] },
  { mode: "gradient", startZMm: 0, startWeights: [1, 0], endWeights: [0, 1] },
  { mode: "gradient", endZMm: 1, startWeights: [1, 0], endWeights: [0, 1] },
  {
    mode: "gradient",
    startZMm: -1,
    endZMm: 1,
    startWeights: [1, 0],
    endWeights: [0, 1],
  },
  {
    mode: "gradient",
    startZMm: 2,
    endZMm: 1,
    startWeights: [1],
    endWeights: [-1, 1],
  },
  {
    mode: "gradient",
    startZMm: 0,
    endZMm: 1,
    startWeights: [1, 0],
    endWeights: [0, 1],
  },
].entries())
  change(`gradient-${i}`, (s) => (mix(s).distribution = d));
for (const [i, text] of [
  "",
  "00",
  "01",
  "-1",
  "1.0",
  "0\n",
  "１２",
  "0",
  "18446744073709551615",
  "18446744073709551616",
  "9".repeat(300),
].entries())
  change(`stable-recipe-id-${i}`, (s) => (recipe(s).upstreamStableId = text));
bad("missing-recipe-components", (s) => {
  recipe(s).componentAId = id;
  recipe(s).componentBId = id;
  recipe(s).manualPatternGroups = [[], [id]];
  recipe(s).gradientComponentIds = [id];
});
for (const [i, weights] of [
  [],
  [0],
  [0, 0],
  [-1, 2],
  [0.5, 2],
  [9007199254740992, 1],
  [1, 2, 3],
  [1, 2],
].entries())
  change(
    `recipe-weights-${i}`,
    (s) => (recipe(s).gradientComponentWeights = weights),
  );
for (const field of ["ratioA", "ratioB", "mixBPercent", "localZMaxSublayers"])
  for (const [i, n] of [-1, 0.5, 9007199254740991, 9007199254740992].entries())
    change(`recipe-integer-${field}-${i}`, (s) => (recipe(s)[field] = n));
for (const field of ["gradientStart", "gradientEnd"])
  for (const [i, n] of [0, 1, -0.1, 0.5, 0.2].entries())
    change(`recipe-endpoint-${field}-${i}`, (s) => (recipe(s)[field] = n));
for (const [i, pair] of [
  [0.5, 0.54],
  [0.5, 0.55],
  [0.5, 0.45],
  [0.5, 0.46],
].entries())
  change(`recipe-gap-${i}`, (s) => {
    recipe(s).gradientStart = pair[0];
    recipe(s).gradientEnd = pair[1];
  });
for (const field of ["componentASurfaceOffsetMm", "componentBSurfaceOffsetMm"])
  for (const n of [-2.001, -2, 2, 2.001])
    change(`recipe-offset-${field}-${n}`, (s) => (recipe(s)[field] = n));
bad("dangling-mixed", (s) => (mix(s).components[0].filamentId = id));
bad("self-cycle-private-utf16", (s) => {
  mix(s).id = privateId;
  mix(s).components[0].filamentId = privateId;
});
change("diamond-cycles-and-last-duplicate-wins", (s) => {
  const a = cloneJson(mix(s)),
    b = cloneJson(a),
    c = cloneJson(a);
  a.id = "import:mix:a";
  b.id = "import:mix:b";
  c.id = privateId;
  a.components = [
    { filamentId: b.id, weight: 1 },
    { filamentId: c.id, weight: 1 },
  ];
  b.components = [
    { filamentId: c.id, weight: 1 },
    { filamentId: a.id, weight: 1 },
  ];
  c.components = [
    { filamentId: c.id, weight: 1 },
    { filamentId: a.id, weight: 1 },
  ];
  s.filaments.mixed = [
    a,
    b,
    c,
    {
      ...cloneJson(b),
      components: [
        { filamentId: a.id, weight: 1 },
        { filamentId: c.id, weight: 1 },
      ],
    },
  ];
});
bad("physical-and-mixed-same-id", (s) => {
  s.filaments.physical[0].id = mix(s).id;
  mix(s).components[0].filamentId = mix(s).id;
});
for (const [i, n] of [-1, 0.5, 0, 1e100].entries())
  change(`plate-order-${i}`, (s) => (s.plates[0].order = n));
bad("duplicate-plate-order", (s) =>
  s.plates.push({
    ...cloneJson(s.plates[0]),
    id: "import:plate:second",
    objects: [],
    order: -0,
  }),
);
bad("dangling-active", (s) => (s.activePlateId = id));
bad("wipe-filament", (s) => (s.plates[0].wipeTower.filamentId = id));
bad("object-filament", (s) => (obj(s).filamentId = id));
bad("volume-filament", (s) => (vol(s).filamentId = id));
bad("range-filament", (s) => (obj(s).layerRanges[0].filamentId = id));
bad("empty-instances", (s) => (obj(s).instances = []));
bad("empty-volumes", (s) => (obj(s).volumes = []));
for (const role of [
  "parameter-modifier",
  "negative-volume",
  "support-enforcer",
  "support-blocker",
])
  change(`role-${role}`, (s) => {
    vol(s).role = role;
    vol(s).filamentId = s.filaments.physical[0].id;
  });
for (const kind of ["volume", "instance"])
  for (const [i, transform] of [
    { scale: [1, 0, 1] },
    { scale: [1, 1e-13, 1] },
    { scale: [1, -1e-12, 1] },
    { rotation: [0, 0, 0, 0] },
    { rotation: [1e-7, 0, 0, 0] },
    { rotation: [1e308, 0, 0, 0] },
    { rotation: [0, 0, 0, 2] },
  ].entries())
    change(`transform-${kind}-${i}`, (s) =>
      Object.assign(
        (kind === "volume" ? vol(s) : obj(s).instances[0]).transform,
        transform,
      ),
    );
bad("unknown-volume-asset", (s) => (vol(s).source.assetId = id));
bad("known-nonmesh-volume-asset", (s) => {
  s.sourceAssets[0].kind = "archive";
  delete s.sourceAssets[0].mesh;
});
bad("volume-triangle-mismatch", (s) => (vol(s).source.triangleCount = 4));
for (const n of [-1, 0.5, 9007199254740992])
  change(`topology-${n}`, (s) => {
    vol(s).source.topologyRevision = n;
    vol(s).annotations.topologyRevision = n;
  });
bad("stale-annotation", (s) => (vol(s).source.topologyRevision = 1));
for (const n of [-1, 0, 5e-324])
  change(`brim-radius-${n}`, (s) => (obj(s).brimEars[0].headFrontRadiusMm = n));
for (const [i, pair] of [
  [-1, 1],
  [0, 0],
  [1, 0],
  [0, 20],
  [0, 1],
].entries())
  change(`range-${i}`, (s) => {
    obj(s).layerRanges[0].minZMm = pair[0];
    obj(s).layerRanges[0].maxZMm = pair[1];
  });
change("range-original-positions-and-signed-zero-ties", (s) => {
  const a = obj(s).layerRanges[0];
  obj(s).layerRanges = [
    { ...cloneJson(a), id: "import:range:late", minZMm: 20, maxZMm: 21 },
    { ...cloneJson(a), minZMm: 0 },
    { ...cloneJson(a), minZMm: -0 },
    a,
  ];
});
change("range-shared-record", (s) => {
  const a = obj(s).layerRanges[0];
  obj(s).layerRanges = [a, a];
});
for (const [i, n] of [-1, -0, 0, 10000, 10000.00001, 1e21].entries())
  change(
    `layer-event-height-${i}`,
    (s) => (s.customGcode[0].layerEvent.topZMm = n),
  );
bad("gcode-dangling-plate", (s) => (s.customGcode[0].plateId = id));
bad("gcode-project-plate", (s) => (s.customGcode[0].scope = "project"));
bad("gcode-missing-plate", (s) => delete s.customGcode[0].plateId);
bad("gcode-unscoped-layer-event", (s) => {
  s.customGcode[0].scope = "project";
  delete s.customGcode[0].plateId;
});
bad("gcode-empty-custom", (s) => {
  s.customGcode[0].layerEvent.type = "custom";
  s.customGcode[0].code = "\u3000";
});
bad("gcode-unexpected-code", (s) => (s.customGcode[0].code = " "));
for (const type of ["tool-change", "color-change"])
  for (const [i, n] of [undefined, -1, 0, 0.5, 1, 1e100].entries())
    change(`layer-tool-${type}-${i}`, (s) => {
      s.customGcode[0].layerEvent.type = type;
      if (n === undefined) delete s.customGcode[0].layerEvent.toolIndex;
      else s.customGcode[0].layerEvent.toolIndex = n;
    });
for (const [i, pair] of [
  [0, -0],
  [0, -5e-324],
  [0.03125, 0.0313],
  [1e21, 1e21],
  [0.2, 0.200049],
  [0.2, 0.200051],
].entries())
  change(`layer-collision-${i}`, (s) =>
    s.customGcode.forEach((e, j) => (e.layerEvent.topZMm = pair[j])),
  );
bad("thumbnail-asset", (s) => (s.thumbnails[0].assetId = id));
bad("thumbnail-plate", (s) => (s.thumbnails[0].plateId = id));
for (const field of ["width", "height"])
  for (const n of [0, -1, 0.5, 1e100])
    change(`thumbnail-${field}-${n}`, (s) => (s.thumbnails[0][field] = n));
bad("extension-asset", (s) => (s.extensionBlobs[0].assetId = id));
bad("extension-namespace", (s) => (s.extensionBlobs[0].namespace = "\ufeff"));
for (const [i, path] of [
  "/absolute",
  "..",
  "a/../b",
  "a\\..\\b",
  "./a",
  "a/%2e%2e/b",
  "a/..x",
  "\0private",
  "a//b",
].entries())
  change(`extension-path-${i}`, (s) => (s.extensionBlobs[0].path = path));
change("global-id-first-path-order", (s) => {
  const shared = s.id;
  for (const f of s.filaments.physical) f.id = shared;
  mix(s).id = shared;
  s.sourceAssets[0].id = shared;
  s.plates[0].id = shared;
  obj(s).id = shared;
  vol(s).id = shared;
  obj(s).instances[0].id = shared;
  obj(s).layerRanges.forEach((r) => (r.id = shared));
  s.customGcode.forEach((g) => (g.id = shared));
  s.thumbnails[0].id = shared;
  s.extensionBlobs[0].id = shared;
});
bad("empty-refinements", (s) => (vol(s).annotations.refinement = {}));
change(
  "unknown-refinement-keys",
  (s) =>
    (vol(s).annotations.refinement = Object.fromEntries(
      ["z", "10", "2", "a", "\ue000", "\ud800", "\ud800\udc00"].map((k) => [
        k,
        null,
      ]),
    )),
);
const facetCorpus = JSON.parse(
  read("testdata/cross-platform/facet-refinement-vectors.json"),
);
function withPaint(s, channel, assignments, count) {
  s.sourceAssets[0].mesh.triangleCount = count;
  vol(s).source.triangleCount = count;
  vol(s).annotations = { ...emptyFacetAnnotations(0), [channel]: assignments };
  for (const text of facetCorpus.filamentIds.map((u) =>
    String.fromCharCode(...u),
  ))
    if (!s.filaments.physical.some((f) => f.id === text))
      s.filaments.physical.push({
        ...cloneJson(s.filaments.physical[0]),
        id: text,
        toolId: s.filaments.physical.length,
      });
  s.printer.toolCount = s.filaments.physical.length;
}
const validAssignment = (channel, a) =>
  Array.isArray(a) &&
  a.every(
    (x) =>
      x &&
      Array.isArray(x.triangles) &&
      x.triangles.every(Number.isFinite) &&
      (channel === "color"
        ? typeof x.value === "string"
        : channel === "support"
          ? ["enforce", "block"].includes(x.value)
          : channel === "seam"
            ? ["prefer", "avoid"].includes(x.value)
            : channel === "fuzzySkin"
              ? x.value === true
              : typeof x.value === "boolean"),
  );
for (const c of facetCorpus.validation) {
  const assignments = JSON.parse(c.assignmentsJson);
  if (!validAssignment(c.channel, assignments)) continue;
  change(`refinement-${c.name}`, (s) => {
    withPaint(s, c.channel, assignments, c.triangleCount);
    vol(s).annotations.refinement = {
      [c.channel]: JSON.parse(c.candidateJson),
    };
  });
}
for (const c of facetCorpus.assignmentCases) {
  const assignments = JSON.parse(c.assignmentsJson);
  if (!validAssignment(c.channel, assignments)) continue;
  change(`assignments-${c.name}`, (s) =>
    withPaint(s, c.channel, assignments, 4),
  );
}
// Ordered compound failures distinguish traversal order from a set of codes.
let random = 0x123fab21;
const rand = () => {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  return random >>> 0;
};
const composable = negatives.filter(
  ([name]) => !["empty-volumes", "mixed-empty", "mixed-single"].includes(name),
);
for (let i = 0; i < 80; i++)
  change(`combined-${i}`, (s) => {
    for (let j = 0; j < 2 + (i % 5); j++) {
      const mutate = composable[rand() % composable.length][1];
      mutate(s);
    }
  });
const sourceCodes = [
  ...new Set(
    [
      ...read("web/src/project/domain/validation.ts").matchAll(
        /\badd\(\s*'([^']+)'/g,
      ),
    ].map((m) => m[1]),
  ),
].sort();
const structural = [
  "invalid-id",
  "unsupported-schema",
  "non-serializable-state",
  "non-finite-number",
  "invalid-settings-base-config",
  "invalid-settings-overrides",
  "unsupported-volume-role",
  "invalid-facet-value",
  "invalid-facet-refinements",
  "invalid-fullspectrum-schema",
  "invalid-fullspectrum-ui-mode",
  "unsupported-fullspectrum-distribution",
].sort();
const covered = [
  ...new Set(cases.flatMap((c) => c.issues.map((i) => i.code))),
].sort();
for (const code of sourceCodes)
  assert.ok(
    structural.includes(code) || covered.includes(code),
    `Uncovered graph rule ${code}`,
  );
const sources = [
  "tools/cross-platform/project-validation-vectors.mjs",
  "web/src/project/domain/validation.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/facetRefinement.ts",
  "web/src/project/__tests__/fixtures.ts",
  "testdata/cross-platform/project-model-vectors.json",
  "testdata/cross-platform/facet-refinement-vectors.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      timestampOracle: "Node Smi32, explicit UTC host timezone",
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      sourceCodes,
      structural,
      covered,
      cases,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/project-validation-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Graph validation reference drift",
  );
console.log(
  `Graph validation references: ${cases.length} states, ${covered.length} diagnostic codes; ${structural.length} source codes already excluded by typed decoding`,
);
