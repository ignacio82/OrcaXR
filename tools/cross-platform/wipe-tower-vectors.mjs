// Wipe-tower auto-placement references from the production browser
// (`planWipeTowerWire` over `wipeTowerPlacement.ts`): plates whose
// configuration exercises every coercion the planner reads — `printable_area`
// as a point list, a `;`-separated string, an offset U1-style bed and garbage;
// tower widths as strings, arrays, zero and absent; rib walls and null brims —
// with the picking scene's parts, an empty plate and a plate with an existing
// tower, under every bias and request override, plus each refusal. Replayed by
// Rust, by WASM in Node and Chrome, and over JNI.
//
// Then a journey: the production `CanonicalWorkspaceController` opens the same
// project (its own printable area set, as a 3MF needs) as a canonical 3MF and auto-places the active plate's tower as
// `OrcaWorkspace.autoPlaceWipeTower` does — the workspace's bed size, and its
// printable rectangle when a catalog profile states it — on each plate in
// turn (the U1 plate twice, the second time changing nothing, then after a
// model moved; a plate whose disabled tower keeps its rotation and filament;
// a plate with an unreadable area; an empty plate), recording the pick, the
// semantic hash and the undo label after every step, then undoing them all;
// the Android `ProjectWorkspace` takes the same steps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { workspaceBed } from "../../web/src/workspace/WorkspaceBed.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { entityId } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { planWipeTowerWire } from "../../web/src/project/objects/wipeTowerExchange.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import {
  decodeProjectWipeTowerRequest,
  encodeProjectWipeTowerReply,
  encodeProjectWipeTowerRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const fixture = createPickingFixture();
const state = structuredClone(fixture.state);
const first = state.plates[0];
// A copy of one object with every ID renamed, for another plate.
const copy = (object, suffix) => ({
  ...structuredClone(object),
  id: entityId(`import:object:tower-${suffix}`),
  layerRanges: [],
  volumes: object.volumes.map((v, i) => ({
    ...structuredClone(v),
    id: entityId(`import:volume:tower-${suffix}-${i}`),
  })),
  instances: object.instances.map((instance, i) => ({
    ...structuredClone(instance),
    id: entityId(`import:instance:tower-${suffix}-${i}`),
  })),
});
first.config = {
  ...first.config,
  printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"],
  prime_tower_width: "35",
  prime_tower_brim_width: 3,
};
const plate = (suffix, order, config, objects, extra = {}) => ({
  ...structuredClone(first),
  id: entityId(`import:plate:tower-${suffix}`),
  name: suffix,
  order,
  config,
  objects,
  ...extra,
});
const ribbed = plate(
  "ribbed",
  1,
  {
    printable_area: "0x0;220x0 , 220x220;0x220",
    wipe_tower_wall_type: " Rib ",
    wipe_tower_rib_width: 8,
    wipe_tower_extra_rib_length: ["10"],
    prime_tower_width: [40, 50],
    prime_tower_brim_width: null,
  },
  [copy(first.objects[1], "ribbed")],
  {
    wipeTower: {
      enabled: false,
      positionMm: [10, 10],
      rotationDeg: 15,
      filamentId: fixture.state.filaments.physical[1].id,
    },
  },
);
const bare = plate(
  "bare",
  2,
  { prime_tower_width: 0, printable_area: "garbage" },
  [copy(first.objects[0], "bare")],
);
const empty = plate("empty", 3, {}, []);
state.plates.push(ribbed, bare, empty);
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets)
  assets.put(payload.descriptor, payload.bytes);

const absent = { absent: {} };
const cases = [];
function place(name, plateId, extra = {}) {
  const text = encodeProjectWipeTowerRequest({
    plateId: units(plateId),
    bedRectMm: absent,
    bedSizeMm: absent,
    towerW: absent,
    towerD: absent,
    safetyMm: absent,
    marginMm: absent,
    bias: absent,
    volumeRoles: absent,
    ...extra,
  });
  const reply = planWipeTowerWire(
    state,
    assets,
    decodeProjectWipeTowerRequest(text),
  );
  cases.push({
    name,
    request: text,
    reply: encodeProjectWipeTowerReply(reply),
  });
}

for (const target of [first, ribbed, empty]) {
  place(`${target.name} by default`, target.id, {
    bedSizeMm: { value: [250, 250] },
  });
  for (const bias of [
    "backLeft",
    "backRight",
    "frontLeft",
    "frontRight",
    "largestClearance",
  ])
    place(`${target.name} ${bias}`, target.id, {
      bias: { value: bias },
      bedSizeMm: { value: [250, 250] },
    });
}
place("U1 with overrides", first.id, {
  towerW: { value: 20 },
  towerD: { value: 30 },
  safetyMm: { value: 0 },
  marginMm: { value: -4 },
});
place("U1 by an explicit rectangle", first.id, {
  bedRectMm: { value: { xMin: 10, yMin: 20, xMax: 140, yMax: 120 } },
});
place("U1 ignoring an empty rectangle", first.id, {
  bedRectMm: { value: { xMin: 10, yMin: 20, xMax: 10, yMax: 120 } },
});
place("U1 by modifiers", first.id, {
  volumeRoles: { value: ["parameterModifier"] },
});
place("a bed narrower than the tower", first.id, {
  bedRectMm: { value: { xMin: 0, yMin: 0, xMax: 40, yMax: 300 } },
});
place("bare plate from a size", bare.id, { bedSizeMm: { value: [180, 120] } });
place("bare plate with no usable bed", bare.id);
place("bare plate with a negative size", bare.id, {
  bedSizeMm: { value: [-1, 120] },
});
place("unknown plate", "import:plate:missing", {
  bedSizeMm: { value: [250, 250] },
});

// --- The journey ----------------------------------------------------------------
process.env.TZ = "UTC";
const NOW = "2026-10-12T00:00:00.000Z";
const serializer = new Bbs3mfProjectSerializer();
// A 3MF places several plates on one global bed, which the project's own printable area sizes.
const journeyState = structuredClone(state);
journeyState.config = { ...journeyState.config, printable_area: ["0x0", "270x0", "270x270", "0x270"] };
assertValidProjectState(journeyState);
const source = new EditorSession({ initialState: journeyState, assets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0x70e2)),
  clock: () => NOW,
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
const opened = controller.captureProjectExportGuard();
const observe = () => {
  const { history } = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: history.undoCount,
    undoLabel: history.undoLabel ?? null,
  };
};
const journeySteps = [];
async function step(operation, run) {
  let result = null;
  let refusal = null;
  try {
    result = (await run()) ?? null;
  } catch (error) {
    refusal = error.message;
  }
  journeySteps.push({ operation, result, refusal, ...observe() });
}
const activate = (plateId) =>
  step({ kind: "activate", plateId }, async () => {
    await controller.activatePlate(plateId);
  });
/** `OrcaWorkspace.autoPlaceWipeTower` on the active plate: the bed's size, and the printable rectangle a
 * catalog profile states ([fromProfile]; the workspace's profile is its catalog choice). */
const autoPlace = (fromProfile) =>
  step({ kind: "autoPlace", fromProfile }, async () => {
    const bed = workspaceBed(controller.getSlicingConfiguration().config);
    const plateId = controller.session.project.getSnapshot().state.activePlateId;
    const pick = await controller.autoPlaceWipeTower(plateId, {
      ...(fromProfile && bed.printableArea ? { bedRectMm: bed.printableArea } : {}),
      bedSizeMm: [bed.sizeMm[0], bed.sizeMm[1]],
    });
    return {
      xMm: pick.xMm,
      yMm: pick.yMm,
      clearanceMm: Number.isFinite(pick.clearanceMm) ? pick.clearanceMm : null,
      label: pick.label,
      footprint: pick.footprint,
    };
  });
await autoPlace(true);
await autoPlace(true);
// A model moved to the back right: the room around the tower changes.
const moved = first.objects[0].instances[0].id;
const movedTo = { ...controller.getInstanceTransform(moved), translationMm: [210, 230, 0] };
await step({ kind: "move", instanceId: moved, transform: movedTo }, async () => {
  await controller.setInstanceTransform(moved, movedTo, "setup:move");
});
await autoPlace(false);
await activate(ribbed.id);
await autoPlace(true);
await activate(bare.id);
await autoPlace(false);
await activate(empty.id);
await autoPlace(true);
const journeyUndo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  journeyUndo.push(observe());
}
assert.equal(journeyUndo.at(-1).semanticHash, opened.semanticHash);
const journey = {
  archive: Buffer.from(serialized.bytes).toString("base64"),
  opened: { semanticHash: opened.semanticHash },
  steps: journeySteps,
  undo: journeyUndo,
};
controller.dispose();

const sources = [
  "tools/cross-platform/wipe-tower-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/workspace/WorkspaceBed.ts",
  "web/node_modules/three/package.json",
  "web/src/project/objects/wipeTowerExchange.ts",
  "web/src/project/objects/wipeTowerPlacement.ts",
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
      journey,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/wipe-tower-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Wipe tower reference drift",
  );
const refused = cases.filter((c) => c.reply.startsWith('{"refused"')).length;
console.log(`wipe-tower journey: ${journeySteps.length} steps, ${journeyUndo.length} undo entries`);
console.log(
  `wipe towers: ${cases.length} requests (${cases.length - refused} plans, ${refused} refusals)`,
);
