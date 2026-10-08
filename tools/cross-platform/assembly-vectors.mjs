// Assembly alignment references from the production browser
// (`assemblyExchange.ts` over `assembly.ts`, the pinned `GLGizmoAssembly`
// alignments): which actions plane pairs allow — skewed, parallel,
// anti-parallel, each side of the 1e-4 parallel test, already aligned within
// the 1e-3 guard, with non-unit and zero normals, and with points, edges and
// circles in either position — then every alignment kind with and without its
// parameter and reversing either feature, under identity, rotated, scaled and
// overflowing moving transforms; and view-only explosions at factor 1, above
// it, below it and past float range. Seeded random pairs join the curated
// ones. Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  assemblyAlignmentWire,
  assemblyAvailabilityWire,
  explosionWire,
} from "../../web/src/project/objects/assemblyExchange.ts";
import {
  decodeProjectAssemblyAlignmentRequest,
  decodeProjectAssemblyPair,
  decodeProjectExplosionRequest,
  encodeProjectAssemblyAlignmentReply,
  encodeProjectAssemblyAlignmentRequest,
  encodeProjectAssemblyAvailabilityReply,
  encodeProjectAssemblyPair,
  encodeProjectExplosionReply,
  encodeProjectExplosionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// xorshift64*, seeded.
let state = 0x2545f4914f6cdd1dn;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const vector = (scale = 50) => [
  uniform(-scale, scale),
  uniform(-scale, scale),
  uniform(-scale, scale),
];
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((c) => c / length);
};

const plane = (normal, origin = [0, 0, 0], index = 0) => ({
  plane: { index, normal, origin },
});
const point = (p) => ({ point: { point: p } });
const edge = (from, to) => ({ edge: { from, to, extraPoint: { absent: {} } } });
const circle = (center, normal, radius) => ({
  circle: { center, normal, radius },
});
const quaternion = () => {
  const q = [uniform(-1, 1), uniform(-1, 1), uniform(-1, 1), uniform(-1, 1)];
  return normalize(q);
};
const transforms = [
  { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  {
    translationMm: [12.5, -40, 3],
    rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
    scale: [1, 1, 1],
  },
  { translationMm: vector(), rotation: quaternion(), scale: [2, 0.5, 1.25] },
  {
    translationMm: [1e308, -1e308, 0],
    rotation: quaternion(),
    scale: [1, 1, 1],
  },
];

// --- Pairs ---------------------------------------------------------------------------
const pairs = [];
const z = [0, 0, 1];
const tilt = (epsilon) => normalize([epsilon, 0, 1]);
pairs.push(
  [plane(z, [0, 0, 10]), plane([0, 0, -1], [3, 4, 0])],
  [plane(z, [0, 0, 10]), plane(z, [3, 4, 2])],
  [plane([0, 0, 7], [0, 0, 10]), plane([0, 0, -0.25], [5, 5, 30])],
  [plane(z), plane(tilt(0.0139))],
  [plane(z), plane(tilt(0.0145))],
  [plane(z), plane([0, 0, -1].map((c, i) => (i === 0 ? 0.03 : c)))],
  [plane(z), plane(normalize([0.04, 0, -1]))],
  [plane([1, 0, 0], [0, 0, 0]), plane([0, 1, 0], [10, 10, 10])],
  [plane([1, 0, 0]), plane([-1, 0, 0], [20, 1, 2])],
  [plane([0.9999, 0.01, 0]), plane([0, 0, 1])],
  [plane([0, 0, 0]), plane(z)],
  [plane(z), plane([0, 0, 0])],
  [point([1, 2, 3]), plane(z)],
  [plane(z), point([1, 2, 3])],
  [plane(z), edge([0, 0, 0], [5, 0, 0])],
  [circle([0, 0, 0], z, 3), plane(z)],
  [plane(z), circle([1, 1, 1], z, 2)],
  [plane(z, [1e308, 0, 0]), plane([0, 0, -1], [-1e308, 0, 0])],
  [plane(z, [0, 0, -1e308]), plane(z, [0, 0, 1e308])],
);
for (let i = 0; i < 24; i += 1)
  pairs.push([plane(vector(2), vector()), plane(vector(2), vector())]);
for (let i = 0; i < 12; i += 1) {
  const n = normalize(vector());
  pairs.push([
    plane(n, vector()),
    plane(
      n.map((c) => -c * uniform(0.5, 3)),
      vector(),
    ),
  ]);
}

const steps = [];
for (const [first, second] of pairs) {
  const request = encodeProjectAssemblyPair({ first, second });
  steps.push({
    availability: request,
    reply: encodeProjectAssemblyAvailabilityReply(
      assemblyAvailabilityWire(decodeProjectAssemblyPair(request)),
    ),
  });
}
const kinds = [
  "parallel",
  "centerCoincidence",
  "parallelDistance",
  "reverseRotation",
  "aroundFaceCenter",
];
for (const [index, [first, second]] of pairs.entries()) {
  // A skewed pair refuses every parallel-only kind alike; two variants say so.
  const available = assemblyAvailabilityWire({ first, second });
  const parallel =
    "available" in available && available.available.hasParallelDistance;
  for (const kind of kinds) {
    const variants =
      kind === "parallelDistance"
        ? [
            { absent: {} },
            { value: 4.5 },
            { value: -2 },
            { value: 0 },
            { value: 1e308 },
          ]
        : kind === "aroundFaceCenter"
          ? [
              { absent: {} },
              { value: 90 },
              { value: -30 },
              { value: 0.05 },
              { value: 720 },
            ]
          : kind === "reverseRotation"
            ? [{ absent: {} }, { value: "first" }, { value: "second" }]
            : [{ absent: {} }];
    const parallelOnly =
      kind === "parallelDistance" || kind === "aroundFaceCenter";
    for (const variant of parallelOnly && !parallel
      ? variants.slice(0, 2)
      : variants) {
      const request = encodeProjectAssemblyAlignmentRequest({
        kind,
        first,
        second,
        movingTransform:
          transforms[(index + variants.indexOf(variant)) % transforms.length],
        parameter:
          kind === "reverseRotation" || !("value" in variant)
            ? { absent: {} }
            : variant,
        reverseFeature: kind === "reverseRotation" ? variant : { absent: {} },
      });
      steps.push({
        alignment: request,
        reply: encodeProjectAssemblyAlignmentReply(
          assemblyAlignmentWire(decodeProjectAssemblyAlignmentRequest(request)),
        ),
      });
    }
  }
}
const explosions = [
  { parts: [], factor: 2 },
  {
    parts: [{ id: units("import:instance:a"), centerMm: [10, -20, 5] }],
    factor: 3,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [10, -20, 5] },
      { id: units("import:instance:b"), centerMm: [-4, 7, 1] },
      { id: units("lone \ud800"), centerMm: [0, 0, -9] },
    ],
    factor: 1,
  },
  {
    parts: Array.from({ length: 9 }, (_, i) => ({
      id: units(`import:instance:p${i}`),
      centerMm: vector(80),
    })),
    factor: 2.75,
  },
  {
    parts: [{ id: units("import:instance:a"), centerMm: [1, 2, 3] }],
    factor: 0.5,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [1e308, 0, 0] },
      { id: units("import:instance:b"), centerMm: [-1e308, 0, 0] },
    ],
    factor: 4,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [1e300, 0, 0] },
      { id: units("import:instance:b"), centerMm: [-1e300, 0, 0] },
    ],
    factor: 1e10,
  },
];
for (const explosion of explosions) {
  const request = encodeProjectExplosionRequest(explosion);
  steps.push({
    explosion: request,
    reply: encodeProjectExplosionReply(
      explosionWire(decodeProjectExplosionRequest(request)),
    ),
  });
}

const sources = [
  "tools/cross-platform/assembly-vectors.mjs",
  "web/src/project/objects/assemblyExchange.ts",
  "web/src/project/objects/assembly.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/measureExchange.ts",
  "contracts/project-intents.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      steps,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/assembly-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Assembly reference drift");
const outcome = (s) => Object.keys(JSON.parse(s.reply))[0];
const tally = Object.groupBy(
  steps,
  (s) => `${Object.keys(s)[0]}:${outcome(s)}`,
);
console.log(
  `assembly: ${steps.length} requests (${Object.entries(tally)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")})`,
);
