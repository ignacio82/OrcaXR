// Expectations come only from the production TypeScript implementation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  validateFacetRefinementChannel,
  collapseFacetRefinementRoots,
  expandFacetRefinementRoots,
  remapFacetChannelValues,
  replaceFacetRefinementRoots,
  visitFacetRefinementAssignedValues,
  facetRefinementAssignedLeafCount,
  facetRefinementSplitAt,
} from "../../web/src/project/domain/facetRefinement.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
} from "../../web/src/project/domain/model.ts";
import {
  UuidIdSource,
  seededRandom,
} from "../../web/src/project/domain/ids.ts";

const root = new URL("../../", import.meta.url);
const channels = ["color", "support", "seam", "fuzzySkin", "brim"];
const colors = [
  "import:filament:a",
  "import:filament:b",
  "import:filament:\ud800\udc00",
  "import:filament:\ue000",
  "import:filament:\udfff\u0000",
];
const values = {
  color: colors,
  support: ["enforce", "block"],
  seam: ["prefer", "avoid"],
  fuzzySkin: [true],
  brim: [false, true],
};
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const clone = (value) => JSON.parse(JSON.stringify(value));
const leaf = (value) => ({
  kind: "leaf",
  state:
    value === undefined ? { kind: "unpainted" } : { kind: "assigned", value },
});
const split = (children, specialSide = 0) => ({
  kind: "split",
  splitSides: children.length - 1,
  specialSide,
  children,
});
const chain = (levels, value) => {
  let node = leaf(value);
  for (let i = 0; i < levels; i++) node = split([node, leaf()]);
  return node;
};
const encoding = (node, triangleCount = 4, triangle = 1) => ({
  version: 2,
  triangleCount,
  splits: [{ triangle, node }],
});
const validation = [];
function record(
  name,
  channel,
  candidate,
  assignments = [],
  triangleCount = 4,
  extra = {},
) {
  const options = {
    triangleCount,
    filamentIds: new Set(colors),
    path: `paint.${channel}`,
    ...extra,
  };
  const expected = validateFacetRefinementChannel(
    channel,
    candidate,
    assignments,
    options,
  );
  validation.push({
    name,
    channel,
    candidateJson: canonicalStringify(candidate),
    assignmentsJson: canonicalStringify(assignments),
    triangleCount,
    requireSplit: options.requireSplit !== false,
    expected,
  });
}
for (const channel of channels) {
  const value = values[channel][0];
  const good = encoding(split([leaf(value), leaf()]));
  record(`${channel}-valid`, channel, good);
  record(`${channel}-conflict`, channel, good, [{ triangles: [1, 3], value }]);
  record(
    `${channel}-uniform`,
    channel,
    encoding(split([leaf(value), leaf(value)])),
  );
  record(
    `${channel}-nested-uniform`,
    channel,
    encoding(split([split([leaf(value), leaf(value)]), leaf()])),
  );
  for (const candidate of [null, [], false, 5, "invalid", {}])
    record(
      `${channel}-container-${JSON.stringify(candidate)}`,
      channel,
      candidate,
    );
  for (const [name, mutation] of [
    [
      "unknown-field",
      (v) => {
        v.extra = true;
      },
    ],
    [
      "missing-version",
      (v) => {
        delete v.version;
      },
    ],
    [
      "version-one",
      (v) => {
        v.version = 1;
      },
    ],
    [
      "wrong-count",
      (v) => {
        v.triangleCount = 5;
      },
    ],
    [
      "bad-splits",
      (v) => {
        v.splits = {};
      },
    ],
    [
      "empty",
      (v) => {
        v.splits = [];
      },
    ],
    [
      "missing-node",
      (v) => {
        delete v.splits[0].node;
      },
    ],
    [
      "extra-entry",
      (v) => {
        v.splits[0].extra = 0;
      },
    ],
    [
      "null-entry",
      (v) => {
        v.splits[0] = null;
      },
    ],
    [
      "bad-triangle",
      (v) => {
        v.splits[0].triangle = "1";
      },
    ],
    [
      "negative-triangle",
      (v) => {
        v.splits[0].triangle = -1;
      },
    ],
    [
      "fractional-triangle",
      (v) => {
        v.splits[0].triangle = 0.5;
      },
    ],
    [
      "end-triangle",
      (v) => {
        v.splits[0].triangle = 4;
      },
    ],
    [
      "repeated",
      (v) => {
        v.splits.push(clone(v.splits[0]));
      },
    ],
    [
      "unordered",
      (v) => {
        v.splits.push({ ...clone(v.splits[0]), triangle: 0 });
      },
    ],
    [
      "leaf-root",
      (v) => {
        v.splits[0].node = leaf(value);
      },
    ],
    [
      "nonobject-node",
      (v) => {
        v.splits[0].node = 7;
      },
    ],
    [
      "unknown-node-kind",
      (v) => {
        v.splits[0].node.kind = "other";
      },
    ],
    [
      "extra-node",
      (v) => {
        v.splits[0].node.extra = 1;
      },
    ],
    [
      "bad-sides",
      (v) => {
        v.splits[0].node.splitSides = 0;
      },
    ],
    [
      "fractional-sides",
      (v) => {
        v.splits[0].node.splitSides = 1.5;
      },
    ],
    [
      "bad-special-side",
      (v) => {
        v.splits[0].node.specialSide = 3;
      },
    ],
    [
      "three-special",
      (v) => {
        v.splits[0].node = split([leaf(value), leaf(), leaf(), leaf()], 1);
      },
    ],
    [
      "wrong-child-count",
      (v) => {
        v.splits[0].node.children.pop();
      },
    ],
    [
      "bad-children",
      (v) => {
        v.splits[0].node.children = null;
      },
    ],
    [
      "extra-leaf",
      (v) => {
        v.splits[0].node.children[0].extra = 3;
      },
    ],
    [
      "null-state",
      (v) => {
        v.splits[0].node.children[0].state = null;
      },
    ],
    [
      "unknown-state",
      (v) => {
        v.splits[0].node.children[0].state = { kind: "other" };
      },
    ],
    [
      "unpainted-extra",
      (v) => {
        v.splits[0].node.children[1].state.extra = 1;
      },
    ],
    [
      "assigned-extra",
      (v) => {
        v.splits[0].node.children[0].state.extra = 1;
      },
    ],
    [
      "missing-value",
      (v) => {
        delete v.splits[0].node.children[0].state.value;
      },
    ],
  ]) {
    const candidate = clone(good);
    mutation(candidate);
    record(`${channel}-${name}`, channel, candidate);
  }
  for (const invalid of [
    null,
    0,
    [],
    {},
    "unknown",
    false,
    true,
    "enforce",
    "block",
    "prefer",
    "avoid",
    colors[0],
  ]) {
    record(
      `${channel}-value-${JSON.stringify(invalid)}`,
      channel,
      encoding(split([leaf(invalid), leaf()])),
    );
  }
  record(
    `${channel}-allow-empty-transient`,
    channel,
    { version: 2, triangleCount: 4, splits: [] },
    [],
    4,
    { requireSplit: false },
  );
}
// Stored as a construction recipe: these exercise depth 64/65 without using
// the separate stateless canonicalizer's depth-64 parser as a project decoder.
const depthCases = [63, 64, 65, 80].map((levels) => ({
  levels,
  expected: validateFacetRefinementChannel(
    "color",
    encoding(chain(levels, colors[0])),
    [],
    { triangleCount: 4, filamentIds: new Set(colors), path: "paint.color" },
  ),
}));
record(
  "large-binary64-count",
  "color",
  encoding(split([leaf(colors[0]), leaf()]), 1e100, 1e90),
  [],
  1e100,
);
record(
  "negative-zero-triangle",
  "color",
  encoding(split([leaf(colors[0]), leaf()]), 4, -0),
);
record(
  "unsigned-surrogate-value",
  "color",
  encoding(split([leaf("\ud800\u0000"), leaf()])),
  [],
  4,
  { filamentIds: undefined },
);
validation.at(-1).unrestrictedColors = true;

// Annotation errors are extracted from the actual graph validator, which is
// the authority for sparse assignment values, references and duplicate indices.
const assignmentCases = [];
const base = createEmptyProject({
  idSource: new UuidIdSource(seededRandom(17)),
  now: "2026-10-05T00:00:00Z",
});
base.printer.toolCount = colors.length;
base.filaments.physical = colors.map((id, toolId) => ({
  id,
  toolId,
  name: "fixture",
  material: "PLA",
  color: "#ffffff",
  config: {},
  enabled: true,
}));
base.sourceAssets = [
  {
    id: "import:asset:mesh",
    kind: "mesh",
    digest: "opaque",
    byteLength: 0,
    mediaType: "model/stl",
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: 0,
        componentType: "float32",
        componentCount: 3,
        count: 0,
      },
      triangleCount: 4,
    },
  },
];
base.plates[0].objects = [
  {
    id: "import:object:one",
    name: "fixture",
    config: {},
    layerRanges: [],
    instances: [
      {
        id: "import:instance:one",
        transform: identityTransform(),
        printable: true,
      },
    ],
    volumes: [
      {
        id: "import:volume:one",
        name: "fixture",
        role: "model",
        config: {},
        transform: identityTransform(),
        source: {
          assetId: "import:asset:mesh",
          triangleCount: 4,
          topologyRevision: 0,
        },
        annotations: emptyFacetAnnotations(),
      },
    ],
  },
];
assert.deepEqual(validateProjectState(base), []);
for (const channel of channels)
  for (const [name, assignments] of [
    ["valid", [{ value: values[channel][0], triangles: [0, 3] }]],
    ["duplicate", [{ value: values[channel][0], triangles: [0, 0] }]],
    [
      "between-groups",
      [
        { value: values[channel][0], triangles: [1] },
        { value: values[channel][0], triangles: [1] },
      ],
    ],
    [
      "out-of-range",
      [{ value: values[channel][0], triangles: [-1, 0.25, 4, 1e100] }],
    ],
    ...[null, 3, {}, [], false, true, "unknown", ...colors].map((value, i) => [
      `value-${i}`,
      [{ value, triangles: [0] }],
    ]),
  ]) {
    const state = clone(base);
    state.plates[0].objects[0].volumes[0].annotations[channel] = assignments;
    const expected = validateProjectState(state).map(
      ({ code, path, message }) => ({
        code,
        path: path.replace("plates[0].objects[0].volumes[0].", ""),
        message,
      }),
    );
    assignmentCases.push({
      name: `${channel}-${name}`,
      channel,
      assignmentsJson: canonicalStringify(assignments),
      expected,
    });
  }
// Deterministic generated editing traces, including every split topology,
// unpainted leaves, all channel values, and UTF-16 canonical grouping order.
let randomState = 0x91e10da5;
function random(n) {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) % n;
}
function randomNode(channel, depth = 0) {
  if (depth === 4 || random(3) !== 0)
    return leaf(
      random(4) === 0
        ? undefined
        : values[channel][random(values[channel].length)],
    );
  const sides = 1 + random(3);
  return split(
    Array.from({ length: sides + 1 }, () => randomNode(channel, depth + 1)),
    sides === 3 ? 0 : random(3),
  );
}
const operations = [];
for (const channel of channels)
  for (let i = 0; i < 32; i++) {
    const roots = Array.from({ length: i === 0 ? 0 : 1 + random(24) }, () =>
      randomNode(channel),
    );
    if (i === 1)
      roots.push(
        split([leaf(values[channel][0]), leaf(values[channel].at(-1))]),
      );
    const collapsed = collapseFacetRefinementRoots(roots);
    const mapping = values[channel].map((from, j) => [
      from,
      i % 2 === 0
        ? values[channel][0]
        : values[channel][(j + 1) % values[channel].length],
    ]);
    const remap = (value) => mapping.find(([from]) => from === value)[1];
    const mapped = remapFacetChannelValues(
      collapsed.assignments,
      collapsed.encoding,
      remap,
    );
    const visits = [];
    if (collapsed.encoding)
      visitFacetRefinementAssignedValues(collapsed.encoding, (value, path) =>
        visits.push({ valueJson: canonicalStringify(value), path }),
      );
    const remove = Array.from(
      { length: roots.length },
      (_, index) => index,
    ).filter((index) => index % 3 === 0);
    const replaced = collapsed.encoding
      ? replaceFacetRefinementRoots(collapsed.encoding, new Set(remove))
      : undefined;
    const removed = {
      assignments: collapsed.assignments,
      encoding: replaced?.splits.length ? replaced : undefined,
    };
    const lookups = Array.from({ length: roots.length + 1 }, (_, index) =>
      facetRefinementSplitAt(collapsed.encoding, index),
    );
    operations.push({
      name: `${channel}-${i}`,
      channel,
      rootsJson: canonicalStringify(roots),
      collapsedJson: canonicalStringify(clone(collapsed)),
      expandedJson: canonicalStringify(
        expandFacetRefinementRoots(
          collapsed.encoding,
          collapsed.assignments,
          roots.length,
        ),
      ),
      mappingJson: canonicalStringify(mapping),
      mappedJson: canonicalStringify(clone(mapped)),
      visits,
      count: collapsed.encoding
        ? facetRefinementAssignedLeafCount(collapsed.encoding)
        : 0,
      remove,
      removedJson: canonicalStringify(clone(removed)),
      lookupsJson: canonicalStringify(lookups.map((v) => v ?? null)),
    });
  }
const sourcePaths = [
  "web/src/project/domain/facetRefinement.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/domain/canonical.ts",
];
const result = {
  schemaVersion: 1,
  sources: sourcePaths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  })),
  filamentIds: colors.map(units),
  validation,
  depthCases,
  assignmentCases,
  operations,
};
const output = new URL(
  "testdata/cross-platform/facet-refinement-vectors.json",
  root,
);
const data = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(output, data);
else
  assert.equal(
    readFileSync(output, "utf8"),
    data,
    "facet reference fixtures have drifted",
  );
console.log(
  `Facet references: ${validation.length} encoding cases, ${depthCases.length} depth cases, ${assignmentCases.length} assignment cases, ${operations.length} editing traces`,
);
