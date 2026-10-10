// Transform inspector references from the production browser
// (`TransformFields.ts` through `TransformFieldsExchange.ts`, over three.js's
// own Euler and Quaternion): what the Move (mm), Rotate (deg) and Scale (%)
// fields show for a transform, what an edit of the three fields submits for
// one instance or a selection carried around its primary (the workspace's
// `primaryTransformEdit` and its transform validation), and the Euler ↔
// quaternion conversions themselves — gimbal-locked, unnormalized, mirrored
// and seeded random rotations, every field spelling `parseFloat` treats
// differently, and the workspace's refusals. Replayed by Rust, by WASM in
// Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  transformFieldEditExchange,
  transformFieldsExchange,
  transformRotationExchange,
} from "../../web/src/workspace/TransformFieldsExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

// xorshift64*, seeded: the corpus is reproducible on any engine.
let seed = 0x5deece66dn;
const next = () => {
  seed ^= seed >> 12n;
  seed ^= (seed << 25n) & 0xffffffffffffffffn;
  seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const degrees = (value) => (value * Math.PI) / 180;

/** The normalized quaternion of XYZ Euler angles in degrees, through the exchange itself. */
const quaternion = (x, y, z) =>
  JSON.parse(transformRotationExchange(JSON.stringify({ eulerRadians: [degrees(x), degrees(y), degrees(z)] }))).rotation;
const transform = (translationMm, rotation, scale) => ({ rotation, scale, translationMm });

const rotations = [
  [0, 0, 0, 1],
  [0, 0, 0, -1],
  [0, 0, 0, 2],
  [0, 0, 0, 0.5],
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0.5, 0.5, 0.5, 0.5],
  [-0.5, 0.5, -0.5, 0.5],
  [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
  [0.1, 0.7, -0.2, 0.68],
  [0.3, 0.2, 0.1, 0],
  [0, 0, 0, 0],
  [1e-9, 2e-9, -3e-9, 1],
  [3, -4, 12, 84],
  [1e200, 2e200, 3e200, 4e200],
  quaternion(10, 20, 30),
  quaternion(-45, 90, 0),
  quaternion(30, -90, 60),
  quaternion(0, 89.99999, 0),
  quaternion(0, 89.9744, 0),
  quaternion(0, 89.97, 0),
  quaternion(180, 0, 180),
  quaternion(179.999, -0.001, 90),
];
for (let i = 0; i < 40; i += 1) rotations.push([uniform(-1, 1), uniform(-1, 1), uniform(-1, 1), uniform(-1, 1)]);
for (let i = 0; i < 20; i += 1) rotations.push(quaternion(uniform(-180, 180), uniform(-90, 90), uniform(-180, 180)));

const translations = [
  [0, 0, 0],
  [12.5, -3.25, 0.004999],
  [135.25, 135.5, 10],
  [-0.005, 0.0049999999, 1e-7],
  [1e21, -1e21, 123456789.125],
  [uniform(-500, 500), uniform(-500, 500), uniform(0, 300)],
];
const scales = [
  [1, 1, 1],
  [-1, 1, 1],
  [0.5, 2, 1.25],
  [0.1234567, 1.0049999, 0.0001],
  [1e-13, 1, 1],
  [-2.5, -0.75, 3],
  [1e300, 1, 1],
];

const reads = [];
const tools = ["move", "rotate", "scale"];
function readFields(tool, value) {
  const request = JSON.stringify({ tool, transform: value });
  reads.push({ request, reply: transformFieldsExchange(request) });
}
for (const rotation of rotations) readFields("rotate", transform([1, 2, 3], rotation, [1, 1, 1]));
for (const translation of translations) readFields("move", transform(translation, [0, 0, 0, 1], [1, 1, 1]));
for (const scale of scales) readFields("scale", transform([0, 0, 0], [0, 0, 0, 1], scale));
for (const tool of tools) readFields(tool, transform(translations[1], rotations[11], scales[2]));

const conversions = [];
function toEuler(rotation) {
  const request = JSON.stringify({ rotation });
  conversions.push({ request, reply: transformRotationExchange(request) });
}
function toQuaternion(angles) {
  const request = JSON.stringify({ eulerRadians: angles });
  conversions.push({ request, reply: transformRotationExchange(request) });
}
for (const rotation of rotations) toEuler(rotation);
for (let x = -180; x <= 180; x += 45)
  for (let y = -180; y <= 180; y += 45) for (let z = -180; z <= 180; z += 45) toQuaternion([degrees(x), degrees(y), degrees(z)]);
for (const angles of [
  [0, 0, 0],
  [-0, -0, -0],
  [Math.PI, Math.PI / 2, -Math.PI],
  [1e-300, -1e-300, 5e-324],
  [1e6, -1e9, 1e15],
  [1e300, 2.5, -7],
])
  toQuaternion(angles);
for (let i = 0; i < 300; i += 1) toQuaternion([uniform(-4, 4), uniform(-4, 4), uniform(-4, 4)]);
// Round trips: the angles a field shows, read back as the rotation it sets.
for (let i = 0; i < 300; i += 1) {
  const angles = [uniform(-Math.PI, Math.PI), uniform(-Math.PI / 2, Math.PI / 2), uniform(-Math.PI, Math.PI)];
  toQuaternion(angles);
  toEuler(JSON.parse(conversions.at(-1).reply).rotation);
}

const edits = [];
function edit(name, tool, texts, origins, primaryInstanceId = origins[0].instanceId) {
  const request = JSON.stringify({ origins, primaryInstanceId, texts, tool });
  edits.push({ name, request, reply: transformFieldEditExchange(request) });
}
const plain = { instanceId: "instance:a", transform: transform([20, 30, 5], [0, 0, 0, 1], [1, 1, 1]) };
const turned = { instanceId: "instance:b", transform: transform([60, -10, 2.5], rotations[11], [0.5, 2, 1.25]) };
const mirrored = { instanceId: "instance:\ud800c", transform: transform([-15, 45, 0], rotations[18], [-1, 1, 1]) };
const spellings = [
  ["12.5", "-3.75", "0"],
  ["-0", "", "abc"],
  ["1e3", "  7", "12abc"],
  [".5", "+3", "0x10"],
  ["1,5", "٣", "−5"],
  ["0.001", "-0.004999", "135.255"],
  ["Infinityx", "-1e-400", " 42"],
];
for (const tool of tools)
  for (const [index, texts] of spellings.entries()) {
    edit(`${tool} plain ${index}`, tool, texts, [plain]);
    edit(`${tool} turned ${index}`, tool, texts, [turned]);
  }
for (const tool of tools) {
  edit(`${tool} selection`, tool, ["10", "20", "30"], [plain, turned, mirrored]);
  edit(`${tool} selection by second`, tool, ["-45", "90", "12.5"], [plain, turned, mirrored], turned.instanceId);
  edit(`${tool} selection by last`, tool, ["150", "50", "75"], [plain, turned, mirrored], mirrored.instanceId);
  edit(`${tool} pair`, tool, ["0", "0", "0"], [turned, plain]);
}
for (let i = 0; i < 30; i += 1) {
  const tool = tools[i % 3];
  const texts = [uniform(-400, 400), uniform(-400, 400), uniform(-400, 400)].map((v) => v.toFixed(i % 5));
  edit(`seeded ${i}`, tool, texts, [plain, turned, mirrored], [plain, turned, mirrored][i % 3].instanceId);
}
// The workspace's refusals, in its own words.
edit("scale to zero", "scale", ["0", "100", "100"], [plain]);
edit("scale to a sliver", "scale", ["1e-11", "100", "100"], [plain]);
edit("infinite move", "move", ["Infinity", "0", "0"], [plain]);
edit("overflowing scale", "scale", ["1e400", "100", "100"], [plain]);
edit("infinite rotation", "rotate", ["Infinity", "0", "0"], [plain]);
const flat = { instanceId: "instance:flat", transform: transform([0, 0, 0], [0, 0, 0, 1], [0, 1, 1]) };
edit("selection around a flat primary", "scale", ["50", "100", "100"], [flat, plain]);
edit("selection beside a flat instance", "scale", ["50", "100", "100"], [plain, flat]);
const unturned = { instanceId: "instance:zero", transform: transform([0, 0, 0], [0, 0, 0, 0], [1, 1, 1]) };
edit("selection around a zero rotation", "rotate", ["10", "0", "0"], [unturned, plain]);
edit("single zero rotation moved", "move", ["1", "2", "3"], [unturned]);
edit("duplicate selection", "move", ["1", "2", "3"], [plain, plain]);

const refusals = [];
function refuse(exchange, request) {
  const run = { fields: transformFieldsExchange, edit: transformFieldEditExchange, rotation: transformRotationExchange }[exchange];
  assert.throws(() => run(request), /invalid_request/, request);
  refusals.push({ exchange, request });
}
const t = transform([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
refuse("fields", "{");
refuse("fields", JSON.stringify({ tool: "paint", transform: t }));
refuse("fields", JSON.stringify({ tool: "move" }));
refuse("fields", JSON.stringify({ tool: "move", transform: { ...t, rotation: [0, 0, 1] } }));
refuse("fields", JSON.stringify({ tool: "move", transform: { ...t, scale: [1, "1", 1] } }));
refuse("fields", JSON.stringify({ tool: "move", transform: { ...t, extra: 1 } }));
refuse("fields", JSON.stringify({ tool: "move", transform: t, extra: 1 }));
refuse("edit", JSON.stringify({ origins: [plain], primaryInstanceId: "instance:a", texts: ["1", "2"], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [plain], primaryInstanceId: "instance:a", texts: ["1", "2", 3], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [], primaryInstanceId: "instance:a", texts: ["1", "2", "3"], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [plain], primaryInstanceId: "instance:missing", texts: ["1", "2", "3"], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [plain], primaryInstanceId: 7, texts: ["1", "2", "3"], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [{ instanceId: "instance:a" }], primaryInstanceId: "instance:a", texts: ["1", "2", "3"], tool: "move" }));
refuse("edit", JSON.stringify({ origins: [plain], primaryInstanceId: "instance:a", texts: ["1", "2", "3"], tool: "lay" }));
refuse("rotation", JSON.stringify({}));
refuse("rotation", JSON.stringify({ rotation: [0, 0, 1] }));
refuse("rotation", JSON.stringify({ eulerRadians: [0, 0, "1"] }));
refuse("rotation", JSON.stringify({ rotation: [0, 0, 0, 1], eulerRadians: [0, 0, 0] }));
refuse("rotation", "[]");

const sources = [
  "tools/cross-platform/transform-field-vectors.mjs",
  "web/src/workspace/TransformFields.ts",
  "web/src/workspace/TransformFieldsExchange.ts",
  "web/src/workspace/multiInstanceTransform.ts",
  "web/src/project/objects/transformValidation.ts",
  "web/src/project/domain/canonical.ts",
  "web/node_modules/three/src/math/Euler.js",
  "web/node_modules/three/src/math/Quaternion.js",
  "web/node_modules/three/src/math/Matrix4.js",
  "web/node_modules/three/src/math/MathUtils.js",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    engine: { v8: process.versions.v8 },
    reads,
    conversions,
    edits,
    refusals,
  }) + "\n";
const path = new URL("testdata/cross-platform/transform-field-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Transform field reference drift");
const refused = edits.filter((e) => e.reply.startsWith('{"error"')).length;
console.log(
  `Transform field references: ${reads.length} field reads, ${conversions.length} rotation conversions, ` +
    `${edits.length} edits (${refused} refused), ${refusals.length} malformed requests`,
);
