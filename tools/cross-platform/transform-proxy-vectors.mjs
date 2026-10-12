// Transform proxy references from the production browser
// (`transformProxy.ts` through `TransformProxyExchange.ts`): where
// `OrcaWorkspace.syncTransformProxy` stands the gizmo's proxy for a selection
// and the origins `captureSelectedInstanceOrigins` gives a drag — one
// instance's own pose (plain, rotated and non-uniformly scaled, mirrored, on a
// second plate), the centre of a selection's bounds (a sphere with its
// modifier, an open terrain, every role measured), the primary's plate
// filtering the selection, a primary outside the selection, unknown and
// empty identities, a duplicated selection's refusal — over the picking scene
// with a second plate, and the exchange's malformed requests. Replayed by Rust,
// by WASM in Node and Chrome, and over JNI on a live session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import { transformProxyExchange } from "../../web/src/workspace/TransformProxyExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

const fixture = createPickingFixture();
const state = structuredClone(fixture.state);
const [sphere, terrain] = state.plates[0].objects;
// A second plate holding another terrain, turned 45° about Z and scaled.
const far = structuredClone(terrain);
far.id = "import:object:pick-terrain-far";
far.name = "Far terrain";
far.volumes[0].id = "import:volume:pick-terrain-far";
far.instances[0].id = "import:instance:pick-far";
far.instances[0].transform = {
  translationMm: [140, 90, 0],
  rotation: [0, 0, 0.3826834323650898, 0.9238795325112867],
  scale: [1.5, 1.25, 1],
};
state.plates.push({ ...structuredClone(state.plates[0]), id: "import:plate:pick-far", name: "Plate 2", order: 1, objects: [far] });
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets) assets.put(payload.descriptor, payload.bytes);

const [plain, turned] = sphere.instances.map((i) => i.id);
const mirrored = terrain.instances[0].id;
const distant = far.instances[0].id;
const cases = [];
function proxy(name, primaryInstanceId, selectedInstanceIds) {
  const request = JSON.stringify({ primaryInstanceId, selectedInstanceIds });
  cases.push({ name, request, reply: transformProxyExchange(state, assets, request) });
}
proxy("nothing selected", null, []);
proxy("a selection without a primary", null, [plain, turned]);
proxy("a primary alone", plain, []);
proxy("one instance", plain, [plain]);
proxy("a rotated, scaled instance", turned, [turned]);
proxy("a mirrored instance", mirrored, [mirrored]);
proxy("an instance on the second plate", distant, [distant]);
proxy("a pair", plain, [plain, turned]);
proxy("a pair by its second", turned, [plain, turned]);
proxy("the plate", mirrored, [plain, turned, mirrored]);
proxy("the plate in another order", plain, [mirrored, turned, plain]);
proxy("across plates", plain, [plain, distant, turned]);
proxy("across plates from the second", distant, [plain, distant, turned]);
proxy("a primary outside the selection", distant, [plain, turned]);
proxy("an unknown selected instance", plain, [plain, "import:instance:missing", turned]);
proxy("an unknown primary", "import:instance:missing", [plain]);
proxy("an empty primary", "", [plain, turned]);
proxy("a lone surrogate", "instance:\ud800", [plain]);
proxy("a duplicated selection", plain, [plain, turned, plain]);

const refusals = [];
function refuse(request) {
  assert.throws(() => transformProxyExchange(state, assets, request), /invalid_request/, request);
  refusals.push(request);
}
refuse("{");
refuse("[]");
refuse(JSON.stringify({ primaryInstanceId: plain }));
refuse(JSON.stringify({ selectedInstanceIds: [plain] }));
refuse(JSON.stringify({ primaryInstanceId: 7, selectedInstanceIds: [] }));
refuse(JSON.stringify({ primaryInstanceId: plain, selectedInstanceIds: plain }));
refuse(JSON.stringify({ primaryInstanceId: plain, selectedInstanceIds: [plain, 7] }));
refuse(JSON.stringify({ primaryInstanceId: plain, selectedInstanceIds: [], extra: 1 }));

const sources = [
  "tools/cross-platform/transform-proxy-vectors.mjs",
  "web/src/workspace/TransformProxyExchange.ts",
  "web/src/workspace/transformProxy.ts",
  "web/src/project/objects/bounds.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/__tests__/pickingFixture.ts",
  "web/node_modules/three/src/math/Quaternion.js",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    engine: { v8: process.versions.v8 },
    stateJson: canonicalStringify(state),
    assets: fixture.assets.map((a) => ({ descriptorJson: canonicalStringify(a.descriptor), bytes: [...a.bytes] })),
    cases,
    refusals,
  }) + "\n";
const path = new URL("testdata/cross-platform/transform-proxy-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Transform proxy reference drift");
const placed = cases.filter((c) => c.reply.startsWith('{"origins"')).length;
const refused = cases.filter((c) => c.reply.startsWith('{"error"')).length;
console.log(
  `Transform proxy references: ${cases.length} selections (${placed} placed, ` +
    `${cases.length - placed - refused} without a proxy, ${refused} refused), ${refusals.length} malformed requests`,
);
