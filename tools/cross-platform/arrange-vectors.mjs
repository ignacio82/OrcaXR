// Plate arrangement and bed-fill references from the production browser
// (`planArrangementWire` / `planBedFillWire` over `arrange.ts`): the picking
// scene's sphere, terrain and modifier instances plus boxes of several scaled
// footprints, a non-printable box and a second plate, arranged and filled
// under default and explicit spacing and margins, keep-out regions, locked
// instances, a too-small bed, printable areas offset from the bed corner (the
// U1's and a far one) and other role sets — with every refusal.
// Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { entityId } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import {
  planArrangementWire,
  planBedFillWire,
} from "../../web/src/project/objects/arrangeExchange.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import {
  decodeProjectArrangeRequest,
  decodeProjectBedFillRequest,
  encodeProjectArrangeReply,
  encodeProjectArrangeRequest,
  encodeProjectBedFillReply,
  encodeProjectBedFillRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const fixture = createPickingFixture();
const state = structuredClone(fixture.state);
const plate = state.plates[0];
const template = plate.objects[0];
const cubeAsset = template.volumes[1].source.assetId;
// Boxes from the 6 mm cube, scaled to several footprints; one is not printable.
const box = (name, scale, at, printable = true) => ({
  ...structuredClone(template),
  id: entityId(`import:object:arrange-${name}`),
  name,
  layerRanges: [],
  volumes: [
    {
      ...structuredClone(template.volumes[1]),
      id: entityId(`import:volume:arrange-${name}`),
      name,
      role: "model",
      transform: {
        translationMm: [0, 0, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
  ],
  instances: [
    {
      ...structuredClone(template.instances[0]),
      id: entityId(`import:instance:arrange-${name}`),
      printable,
      transform: {
        translationMm: [...at, 0],
        rotation: [0, 0, 0, 1],
        scale,
      },
    },
  ],
});
plate.objects.push(
  box("wide", [6, 2, 1], [30, 200]),
  box("deep", [2, 7, 1], [150, 30]),
  box("square", [4, 4, 2], [220, 120]),
  box("small", [1, 1, 1], [5, 5]),
  box("parked", [3, 3, 1], [240, 240], false),
);
const second = {
  ...structuredClone(plate),
  id: entityId("import:plate:arrange-second"),
  name: "Second",
  order: 1,
  objects: [box("alone", [5, 5, 1], [60, 60])],
};
state.plates.push(second);
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets)
  assets.put(payload.descriptor, payload.bytes);

const absent = { absent: {} };
const area = (xMin, yMin, xMax, yMax) => ({ xMin, yMin, xMax, yMax });
const U1 = area(0.5, 1, 270.5, 271);
const FAR = area(180, 150, 300, 260);
const constraints = (extra = {}) => ({
  bedAreaMm: area(0, 0, 270, 270),
  spacingMm: absent,
  bedMarginMm: absent,
  exclusions: [],
  lockedInstanceIds: [],
  volumeRoles: absent,
  ...extra,
});
const tower = { minX: 200, minY: 200, maxX: 260, maxY: 260 };
const cases = [];
function arrange(name, plateId, extra) {
  const text = encodeProjectArrangeRequest({
    plateId: units(plateId),
    constraints: constraints(extra),
  });
  const reply = planArrangementWire(
    state,
    assets,
    decodeProjectArrangeRequest(text),
  );
  cases.push({ name, arrange: text, reply: encodeProjectArrangeReply(reply) });
}
function fill(name, plateId, instanceId, extra, maxNewInstances = absent) {
  const text = encodeProjectBedFillRequest({
    plateId: units(plateId),
    instanceId: units(instanceId),
    maxNewInstances,
    constraints: constraints(extra),
  });
  const reply = planBedFillWire(
    state,
    assets,
    decodeProjectBedFillRequest(text),
  );
  cases.push({ name, fill: text, reply: encodeProjectBedFillReply(reply) });
}

const sphereInstance = plate.objects[0].instances[0].id;
const turnedInstance = plate.objects[0].instances[1].id;
const squareInstance = "import:instance:arrange-square";
arrange("default", plate.id);
arrange("tight", plate.id, {
  spacingMm: { value: 0 },
  bedMarginMm: { value: 0 },
});
arrange("roomy", plate.id, {
  spacingMm: { value: 12 },
  bedMarginMm: { value: 10 },
});
arrange("around a tower", plate.id, { exclusions: [tower] });
arrange("around locked parts", plate.id, {
  lockedInstanceIds: [units(sphereInstance), units(squareInstance)],
});
arrange("on a small bed", plate.id, { bedAreaMm: area(0, 0, 60, 45) });
arrange("on the U1's area", plate.id, { bedAreaMm: U1 });
arrange("on a far area", plate.id, { bedAreaMm: FAR });
arrange("on a far area around a tower", plate.id, {
  bedAreaMm: FAR,
  exclusions: [{ minX: 250, minY: 210, maxX: 300, maxY: 260 }],
});
arrange("by modifiers", plate.id, {
  volumeRoles: { value: ["parameterModifier"] },
});
arrange("by models and negatives", plate.id, {
  volumeRoles: { value: ["model", "negativeVolume"] },
});
arrange("second plate", second.id);
arrange("no bed", plate.id, { bedAreaMm: area(0, 0, 0, 270) });
arrange("inverted area", plate.id, { bedAreaMm: area(300, 150, 180, 260) });
arrange("negative spacing", plate.id, { spacingMm: { value: -1 } });
arrange("negative margin", plate.id, { bedMarginMm: { value: -0.5 } });
arrange("inverted exclusion", plate.id, {
  exclusions: [{ minX: 10, minY: 10, maxX: 5, maxY: 20 }],
});
arrange("unknown plate", "import:plate:missing");

fill("default", plate.id, sphereInstance);
fill("capped", plate.id, sphereInstance, {}, { value: 3 });
fill("around a tower", plate.id, squareInstance, { exclusions: [tower] });
fill("tight", plate.id, turnedInstance, {
  spacingMm: { value: 0 },
  bedMarginMm: { value: 0 },
});
fill("on a small bed", plate.id, squareInstance, { bedAreaMm: area(0, 0, 80, 70) });
fill("on the U1's area", plate.id, squareInstance, { bedAreaMm: U1 });
fill("on a far area", plate.id, squareInstance, { bedAreaMm: FAR });
fill("onto the second plate", second.id, squareInstance);
fill("by modifiers", plate.id, sphereInstance, {
  volumeRoles: { value: ["parameterModifier"] },
});
fill("no limit", plate.id, sphereInstance, {}, { value: 0 });
fill("fractional limit", plate.id, sphereInstance, {}, { value: 2.5 });
fill("no bed", plate.id, sphereInstance, { bedAreaMm: area(0, 0, 270, -1) });
fill("inverted area", plate.id, sphereInstance, { bedAreaMm: area(0, 260, 270, 150) });
fill("negative spacing", plate.id, sphereInstance, {
  spacingMm: { value: -2 },
});
fill("unknown instance", plate.id, "import:instance:missing");
fill("unknown plate", "import:plate:missing", sphereInstance);
fill("source without the roles", plate.id, squareInstance, {
  volumeRoles: { value: ["negativeVolume"] },
});

const sources = [
  "tools/cross-platform/arrange-vectors.mjs",
  "web/src/project/objects/arrangeExchange.ts",
  "web/src/project/objects/arrange.ts",
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
const path = new URL("testdata/cross-platform/arrange-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Arrange reference drift");
const refused = cases.filter((c) => c.reply.startsWith('{"refused"')).length;
console.log(
  `arrangements: ${cases.filter((c) => "arrange" in c).length} arrange and ${cases.filter((c) => "fill" in c).length} fill requests (${refused} refusals)`,
);
