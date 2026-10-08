// Placement references from the production browser (`planPlacement` over the
// workspace's own transform operations): mirror, rotation/scale resets,
// centring, scale-to-fit, lay-flat by normal and by picked facet, and drop to
// bed, over a sphere (with a modifier) on a plain and a rotated, non-uniformly
// scaled instance and an open terrain on a mirrored instance — with every
// refusal the operations report over a valid project. Replayed by Rust, by
// WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { planPlacement } from "../../web/src/project/objects/placementExchange.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import {
  decodeProjectPlacementRequest,
  encodeProjectPlacementReply,
  encodeProjectPlacementRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const fixture = createPickingFixture();
const state = structuredClone(fixture.state);
const objects = state.plates[0].objects;
// A valid project: every object keeps a model volume, so model bounds exist.
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets)
  assets.put(payload.descriptor, payload.bytes);

const [plainId, turnedId] = objects[0].instances.map((i) => i.id);
const mirroredId = objects[1].instances[0].id;
const sphereVolume = objects[0].volumes[0].id;
const modifierVolume = objects[0].volumes[1].id;
const terrainVolume = objects[1].volumes[0].id;
const all = [plainId, turnedId, mirroredId];
const ids = (list) => list.map(units);

const cases = [];
function plan(name, request) {
  const text = encodeProjectPlacementRequest(request);
  const reply = planPlacement(
    state,
    assets,
    decodeProjectPlacementRequest(text),
  );
  cases.push({
    name,
    request: text,
    reply: encodeProjectPlacementReply(reply),
  });
}

for (const axis of ["x", "y", "z"]) {
  plan(`mirror ${axis}`, {
    mirror: { instanceIds: ids([turnedId, mirroredId, turnedId]), axis },
  });
}
plan("mirror nothing", { mirror: { instanceIds: [], axis: "x" } });
plan("mirror unknown", {
  mirror: { instanceIds: ids([plainId, "import:instance:missing"]), axis: "y" },
});
for (const kind of ["resetRotation", "resetScale", "resetTransform"]) {
  plan(kind, { [kind]: { instanceIds: ids(all) } });
}
for (const [name, list] of [
  ["plain", [plainId]],
  ["turned", [turnedId]],
  ["mirrored", [mirroredId]],
  ["all", [...all, plainId]],
]) {
  plan(`centre ${name}`, {
    centerOnPlate: { instanceIds: ids(list), bedSizeMm: [270, 250] },
  });
  for (const volumeMm of [
    [270, 270, 250],
    [10, 12, 8],
  ])
    plan(`scale ${name} to ${volumeMm.join("×")}`, {
      scaleToFit: { instanceIds: ids(list), volumeMm },
    });
  plan(`drop ${name}`, { dropToBed: { instanceIds: ids(list.slice(0, 3)) } });
}
plan("centre on no bed", {
  centerOnPlate: { instanceIds: ids([plainId]), bedSizeMm: [0, 250] },
});
plan("centre nothing", {
  centerOnPlate: { instanceIds: [], bedSizeMm: [1, 1] },
});
plan("centre unknown", {
  centerOnPlate: {
    instanceIds: ids(["import:instance:missing"]),
    bedSizeMm: [270, 250],
  },
});
plan("scale into no volume", {
  scaleToFit: { instanceIds: ids([plainId]), volumeMm: [1, 0, 1] },
});
plan("drop duplicates", {
  dropToBed: { instanceIds: ids([plainId, plainId]) },
});
plan("drop unknown", {
  dropToBed: { instanceIds: ids(["import:instance:missing"]) },
});
plan("drop nothing", { dropToBed: { instanceIds: [] } });
for (const id of all) {
  for (const normal of [
    [0, 0, 1],
    [1, 0, 0],
    [0, 0, -1],
    [0.3, -0.5, 0.8],
    [-2, 1e-3, 0],
  ])
    plan(`lay ${id} on ${normal.join(",")}`, {
      layOnFace: { instanceId: units(id), localNormal: normal },
    });
}
plan("lay on no normal", {
  layOnFace: { instanceId: units(plainId), localNormal: [0, 0, 0] },
});
plan("lay on a vanishing normal", {
  layOnFace: { instanceId: units(plainId), localNormal: [1e-10, 0, 0] },
});
plan("lay unknown", {
  layOnFace: {
    instanceId: units("import:instance:missing"),
    localNormal: [0, 0, 1],
  },
});
for (const [instanceId, volumeId] of [
  [plainId, sphereVolume],
  [turnedId, sphereVolume],
  [turnedId, modifierVolume],
  [mirroredId, terrainVolume],
]) {
  for (const triangle of [0, 17, 100, 127])
    plan(`lay ${instanceId} on facet ${triangle} of ${volumeId}`, {
      layOnFacet: {
        instanceId: units(instanceId),
        volumeId: units(volumeId),
        triangle,
      },
    });
}
plan("lay on a facet past the mesh", {
  layOnFacet: {
    instanceId: units(plainId),
    volumeId: units(sphereVolume),
    triangle: 320,
  },
});
plan("lay on another object's volume", {
  layOnFacet: {
    instanceId: units(plainId),
    volumeId: units(terrainVolume),
    triangle: 0,
  },
});

const sources = [
  "tools/cross-platform/placement-vectors.mjs",
  "web/src/project/objects/placementExchange.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/bounds.ts",
  "web/src/project/__tests__/pickingFixture.ts",
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
      stateJson: canonicalStringify(state),
      assets: fixture.assets.map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      cases,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/placement-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Placement reference drift");
const refused = cases.filter((c) => c.reply.startsWith('{"refused"')).length;
console.log(
  `placements: ${cases.length} requests (${cases.length - refused} plans, ${refused} refusals)`,
);
