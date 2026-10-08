// Canonical state shapes, field by field: every schema position of complete
// project states (every record, optional field and distribution variant of
// `project-model-vectors`) deleted, nulled or replaced by each other JSON
// type, then admitted as an Open stages an envelope's state
// (`admitCanonicalState`: migrations, shape checks and graph validation).
// Each records the browser's acceptance and, when accepted, the admitted
// state and warnings; the native core (`canonical::admit_state`) must agree
// on every one. Positions are deduplicated across the states with array
// indices collapsed, and a mixed distribution's fields are told apart by its
// mode, so each field of each record type is mutated once. States are named
// from `project-model-vectors`, not copied.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalStringify,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
import { admitCanonicalState } from "../../web/src/project/serialization/CanonicalEnvelope.ts";

const root = new URL("../../", import.meta.url);
// Date.parse is host-dependent; the native replay supplies this exact zone.
process.env.TZ = "UTC";
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const sha256 = (text) =>
  createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
// Text holding a lone surrogate travels as its UTF-16 units.
const encoded = (text) =>
  /[\ud800-\udfff]/.test(text)
    ? Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
    : text;

function admit(state) {
  try {
    const admitted = admitCanonicalState(state);
    return {
      accepted: true,
      stateSha256: sha256(canonicalStringify(admitted.state)),
      warnings: admitted.warnings.map(encoded),
    };
  } catch {
    return { accepted: false };
  }
}

/** Every value position as a path, with the schema position it stands for. */
function positions(value, path = [], out = []) {
  if (path.length > 0) out.push(path);
  if (Array.isArray(value))
    value.forEach((item, index) => positions(item, [...path, index], out));
  else if (value !== null && typeof value === "object")
    for (const key of Object.keys(value))
      positions(value[key], [...path, key], out);
  return out;
}
const MUTATIONS = {
  delete: undefined,
  null: null,
  string: "x",
  number: 7,
  boolean: true,
  array: [],
  object: {},
};
/** Apply one mutation at a path; deletion only of object members. */
function mutated(state, path, kind) {
  const next = cloneJson(state);
  let parent = next;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const last = path.at(-1);
  if (kind === "delete") {
    if (Array.isArray(parent)) return undefined;
    delete parent[last];
  } else {
    parent[last] = cloneJson(MUTATIONS[kind]);
  }
  return next;
}

const models = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
);
const leaf = (value) => ({
  kind: "leaf",
  state: value === null ? { kind: "unpainted" } : { kind: "assigned", value },
});
const split = (a, b) => ({
  kind: "split",
  splitSides: 1,
  specialSide: 0,
  children: [leaf(a), leaf(b)],
});
/** The complete state as an older build wrote it: a legacy false fuzzy-skin
 * assignment and a dense (one root per triangle) seam refinement on its
 * painted volume. Only that volume's annotations are mutated in it, so both
 * migrations meet every malformed shape there. */
function legacyState() {
  const state = JSON.parse(models.cases[0].stateJson);
  const annotations = state.plates[0].objects[0].volumes[0].annotations;
  annotations.fuzzySkin = [
    { value: true, triangles: [0] },
    { value: false, triangles: [2] },
  ];
  // Beside the subdivided (version 2) color channel already there.
  annotations.refinement.seam = {
    version: 1,
    roots: [
      leaf("prefer"),
      split("prefer", "avoid"),
      leaf(null),
      leaf("avoid"),
    ],
    ignored: 7,
  };
  return state;
}
const LEGACY_ANNOTATIONS = [
  "plates",
  0,
  "objects",
  0,
  "volumes",
  0,
  "annotations",
];
const bases = [
  ...models.cases.map((c) => ({
    model: c.name,
    state: JSON.parse(c.stateJson),
    within: [],
  })),
  {
    model: models.cases[0].name,
    state: legacyState(),
    within: LEGACY_ANNOTATIONS,
    legacy: true,
  },
];
const cases = [];
const seen = new Set();
for (const [index, base] of bases.entries()) {
  const { state, within } = base;
  const unmutated = admit(state);
  assert.ok(unmutated.accepted, `${base.model} admits unmutated`);
  assert.equal(
    unmutated.warnings.length,
    base.legacy ? 2 : 0,
    `${base.model} migrations`,
  );
  for (const path of positions(state)) {
    if (!within.every((key, i) => path[i] === key)) continue;
    let parent = state;
    const steps = path.map((key) => {
      const step =
        typeof key === "number"
          ? "#"
          : key === "distribution" && typeof parent?.[key]?.mode === "string"
            ? `distribution(${parent[key].mode})`
            : key;
      parent = parent?.[key];
      return step;
    });
    const position = `${base.legacy ? "legacy:" : ""}${steps.join("/")}`;
    if (seen.has(position)) continue;
    seen.add(position);
    for (const kind of Object.keys(MUTATIONS)) {
      const next = mutated(state, path, kind);
      if (next === undefined) continue;
      cases.push({
        base: index,
        path: path.map((key) => (typeof key === "number" ? key : encoded(key))),
        kind,
        expected: admit(next),
      });
    }
  }
}

const sources = [
  "tools/cross-platform/canonical-shape-vectors.mjs",
  "web/src/project/serialization/CanonicalEnvelope.ts",
  "web/src/project/domain/projectShape.ts",
  "contracts/generated/project-shape.ts",
  "web/src/project/domain/validation.ts",
  "testdata/cross-platform/project-model-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    // A model's state by name, or a derived state in full.
    bases: bases.map((base) =>
      base.legacy
        ? { model: base.model, stateJson: canonicalStringify(base.state) }
        : { model: base.model },
    ),
    cases,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/canonical-shape-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Canonical shape reference drift",
  );
console.log(
  `canonical shapes: ${cases.length} mutations of ${seen.size} positions in ${bases.length} states (${cases.filter((c) => c.expected.accepted).length} accepted, ${cases.filter((c) => !c.expected.accepted).length} refused)`,
);
