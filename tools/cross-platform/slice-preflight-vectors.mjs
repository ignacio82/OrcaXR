// Canonical slice preflight references from the production browser
// `runCanonicalSlicePreflight`, replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  contentDigest,
  InMemoryAssetRepository,
} from "../../web/src/project/assets.ts";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { identityTransform } from "../../web/src/project/domain/model.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { runCanonicalSlicePreflight } from "../../web/src/project/slicing/preflight.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

const buildVolume = {
  minXmm: 0,
  maxXmm: 250,
  minYmm: 0,
  maxYmm: 250,
  minZmm: 0,
  maxZmm: 250,
};
const wire = (p) => ({
  descriptorJson: canonicalStringify(p.descriptor),
  bytes: Array.from(p.bytes),
});

const cases = [];
function record(name, { state, assets, plateId, constraints }) {
  assert.ok(!cases.some((c) => c.name === name), name);
  const c = {
    name,
    stateJson: canonicalStringify(state),
    assets: assets.map(wire),
    plateId,
    constraintsJson:
      constraints === undefined ? null : canonicalStringify(constraints),
  };
  const repository = new InMemoryAssetRepository();
  for (const asset of assets) repository.put(asset.descriptor, asset.bytes);
  try {
    const result = runCanonicalSlicePreflight({
      state,
      assets: repository,
      plateId,
      ...(constraints === undefined ? {} : { constraints }),
    });
    c.resultJson = canonicalStringify(result);
  } catch (error) {
    c.error = error.message;
  }
  cases.push(c);
  return c;
}
function harness() {
  const fixture = createProjectFixture();
  return {
    fixture,
    ids: fixture.ids,
    state: cloneProjectState(fixture.state),
    assets: [fixture.asset],
  };
}
const run = (name, h, plateId, constraints) =>
  record(name, {
    state: h.state,
    assets: h.assets,
    plateId: plateId ?? h.ids.plate,
    constraints,
  });

/** A float32 position buffer followed by optional uint32 indices. */
function meshPayload(id, positions, indices, patch = {}) {
  const bytes = new Uint8Array(
    positions.length * 4 + (indices?.length ?? 0) * 4,
  );
  const view = new DataView(bytes.buffer);
  positions.forEach((v, i) => view.setFloat32(i * 4, v, true));
  indices?.forEach((v, i) =>
    view.setUint32(positions.length * 4 + i * 4, v, true),
  );
  const descriptor = {
    id,
    kind: "mesh",
    digest: contentDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: "application/vnd.orcaxr.indexed-mesh",
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: positions.length * 4,
        componentType: "float32",
        componentCount: 3,
        count: positions.length / 3,
      },
      ...(indices
        ? {
            indices: {
              byteOffset: positions.length * 4,
              byteLength: indices.length * 4,
              componentType: "uint32",
              componentCount: 1,
              count: indices.length,
            },
          }
        : {}),
      triangleCount: (indices?.length ?? positions.length) / 3,
      ...patch,
    },
  };
  return { descriptor, bytes };
}
/** Point the fixture volume at `asset`, declared in state and repository. */
function useAsset(
  h,
  asset,
  triangleCount = asset.descriptor.mesh.triangleCount,
) {
  h.state.sourceAssets[0] = asset.descriptor;
  const volume = h.state.plates[0].objects[0].volumes[0];
  volume.source = {
    assetId: asset.descriptor.id,
    topologyRevision: 0,
    triangleCount,
  };
  volume.annotations.color = [];
  h.assets = [asset];
}
function recipe(h, overrides) {
  return {
    schemaVersion: 1,
    upstreamStableId: "4242",
    uiMode: 3,
    componentAId: h.ids.physical0,
    componentBId: h.ids.physical1,
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 0,
    localZMaxSublayers: 0,
    gradientEnabled: true,
    gradientStart: 0.8,
    gradientEnd: 0.2,
    componentASurfaceOffsetMm: 0,
    componentBSurfaceOffsetMm: 0,
    deleted: false,
    custom: true,
    originAuto: false,
    ...overrides,
  };
}

// Plates and printable instances.
{
  const h = harness();
  run("base", h);
  run("base-build-volume", h, undefined, { buildVolume });
  run("unknown-plate", h, "import:preflight:missing");
}
{
  const h = harness();
  h.state.plates[0].printable = false;
  h.state.plates[0].objects[0].instances[0].printable = false;
  run("excluded-plate", h);
  h.state.plates[0].objects[0].instances[0].printable = true;
  run("excluded-plate-printable-instance", h, undefined, { buildVolume });
}
{
  const h = harness();
  h.state.plates[0].objects = [];
  run("empty-plate", h, undefined, { buildVolume });
}
{
  const h = harness();
  const object = h.state.plates[0].objects[0];
  object.instances[0].transform = {
    ...identityTransform(),
    translationMm: [245, 0, -2],
  };
  object.instances.push({
    id: "import:preflight:overlap",
    printable: true,
    transform: { ...identityTransform(), translationMm: [247, 1, -2] },
  });
  object.instances.push({
    id: "import:preflight:apart",
    printable: true,
    transform: { ...identityTransform(), translationMm: [100, 100, 0] },
  });
  object.instances.push({
    id: "import:preflight:stacked",
    printable: true,
    transform: { ...identityTransform(), translationMm: [100, 100, 0.000005] },
  });
  run("outside-sinking-overlap", h, undefined, { buildVolume });
  run("outside-loose-tolerance", h, undefined, {
    buildVolume: { ...buildVolume, minZmm: -1.5 },
    geometryToleranceMm: 2.0005,
  });
  run("outside-offset-bed", h, undefined, {
    buildVolume: {
      minXmm: 0.5,
      maxXmm: 270.5,
      minYmm: 1,
      maxYmm: 271,
      maxZmm: 0.1234567,
    },
    geometryToleranceMm: 0,
  });
  const drifted = { ...h, state: cloneProjectState(h.state) };
  drifted.state.sourceAssets[0].sourceFilename = "metadata-drift.stl";
  run("metadata-drift", drifted, undefined, { buildVolume });
  run("missing-payload", { ...h, assets: [] });
}
{
  const h = harness();
  const rotated = h.state.plates[0].objects[0];
  rotated.instances[0].transform = {
    translationMm: [10.0005, 20.00049999, 0.1],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    scale: [1.5, 2, 1],
  };
  rotated.volumes[0].transform = {
    translationMm: [0, 0, -0.5],
    rotation: [0.1, 0.2, 0.3, 0.9],
    scale: [1, 1, 3],
  };
  run("rotated-scaled-bounds", h, undefined, {
    buildVolume: { ...buildVolume, maxXmm: 12, maxYmm: 30 },
  });
}
{
  const h = harness();
  h.state.plates[0].objects[0].instances[0].transform = {
    ...identityTransform(),
    scale: [1e308, 1, 1],
  };
  run("non-finite-transformed-vertex", h, undefined, { buildVolume });
}
{
  const h = harness();
  useAsset(
    h,
    meshPayload(
      "import:preflight:bad-index",
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 5],
    ),
  );
  h.state.plates[0].objects[0].instances.push({
    id: "import:preflight:second",
    printable: true,
    transform: identityTransform(),
  });
  run("unreadable-index-range", h, undefined, { buildVolume });
}
{
  const h = harness();
  useAsset(
    h,
    meshPayload("import:preflight:nan", [0, 0, 0, NaN, 0, 0, 0, 1, 0]),
  );
  run("unreadable-non-finite-vertex", h);
}
{
  const h = harness();
  const asset = meshPayload(
    "import:preflight:view",
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 1, 2],
  );
  asset.descriptor.mesh.positions.count = 4;
  useAsset(h, asset, 1);
  run("unreadable-buffer-view", h);
}
{
  const h = harness();
  const asset = meshPayload(
    "import:preflight:stride",
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 1, 2],
  );
  asset.descriptor.mesh.positions.byteStride = 8;
  useAsset(h, asset, 1);
  run("unreadable-stride", h);
}
{
  const h = harness();
  const asset = meshPayload(
    "import:preflight:count",
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 1, 2],
  );
  asset.descriptor.mesh.triangleCount = 2;
  useAsset(h, asset, 2);
  run("unreadable-triangle-count", h);
}
{
  // Only a modifier: graph validation refuses it before bounds could.
  const h = harness();
  const object = h.state.plates[0].objects[0];
  object.volumes[0].role = "parameter-modifier";
  object.volumes[0].annotations.color = [];
  run("modifier-only-object", h);
}
{
  const h = harness();
  const empty = encodeIndexedMeshAsset({
    id: "import:preflight:empty",
    positions: [],
    indices: [],
  });
  useAsset(h, empty, 0);
  const object = h.state.plates[0].objects[0];
  object.name = "Empty \ud800 shell";
  object.volumes.push({
    ...object.volumes[0],
    id: "import:preflight:modifier",
    role: "parameter-modifier",
  });
  object.volumes.push({ ...object.volumes[0], id: "import:preflight:empty-2" });
  object.instances.push({
    id: "import:preflight:twin",
    printable: true,
    transform: identityTransform(),
  });
  run("empty-model-mesh", h, undefined, { buildVolume });
}

// Filament assignments, recipes and tool constraints.
{
  const h = harness();
  const object = h.state.plates[0].objects[0];
  object.filamentId = h.ids.mixed;
  h.state.filaments.mixed[0].enabled = false;
  h.state.filaments.mixed[0].fullSpectrum = recipe(h, {
    uiMode: 0,
    gradientEnabled: false,
    deleted: true,
    upstreamStableId: "7",
  });
  h.state.filaments.physical[1].enabled = false;
  h.state.filaments.physical[0].nozzleDiameterMm = 0.4;
  run("recipe-dependencies", h, undefined, {
    buildVolume,
    tools: [
      {
        nozzleDiameterMm: 0.6,
        supportedMaterials: ["PETG"],
        minHotendTemperatureC: 180,
        maxHotendTemperatureC: 210,
      },
    ],
  });
}
{
  const h = harness();
  const volume = h.state.plates[0].objects[0].volumes[0];
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 2,
      triangleCount: 1,
      splits: [
        {
          triangle: 0,
          node: {
            kind: "split",
            splitSides: 1,
            specialSide: 0,
            children: [
              { kind: "leaf", state: { kind: "assigned", value: h.ids.mixed } },
              {
                kind: "leaf",
                state: { kind: "assigned", value: h.ids.physical0 },
              },
            ],
          },
        },
      ],
    },
  };
  h.state.filaments.mixed[0].enabled = false;
  h.state.plates[0].objects[0].filamentId = undefined;
  delete h.state.plates[0].objects[0].filamentId;
  run("refined-leaves", h);
}
{
  // Filaments reached through volume overrides and layer ranges only.
  const h = harness();
  const object = h.state.plates[0].objects[0];
  delete object.filamentId;
  object.volumes[0].annotations.color = [];
  object.volumes[0].filamentId = h.ids.physical1;
  object.layerRanges[0].filamentId = h.ids.mixed;
  h.state.filaments.physical[0].enabled = false;
  run("volume-and-range-filaments", h, undefined, { buildVolume });
  object.instances[0].printable = false;
  run("unprintable-object-filaments", h, undefined, { buildVolume });
}
{
  const h = harness();
  h.state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [300, 300],
    rotationDeg: 0,
    filamentId: h.ids.mixed,
  };
  run("attestation-and-tower", h, undefined, {
    buildVolume,
    requireProfileAttestation: true,
  });
  h.state.printer.profileHash = "  ";
  h.state.filaments.physical[0].presetId = "pla";
  h.state.filaments.physical[0].presetHash = "sha256:1";
  h.state.filaments.physical[1].presetId = " ";
  h.state.filaments.physical[1].presetHash = "sha256:2";
  run("attestation-partial", h, undefined, { requireProfileAttestation: true });
  h.state.printer.profileHash = "sha256:printer";
  h.state.filaments.physical[1].presetId = "pla-2";
  h.state.plates[0].wipeTower.enabled = false;
  run("attestation-complete", h, undefined, {
    buildVolume,
    requireProfileAttestation: true,
  });
}
{
  const h = harness();
  h.state.config.prime_tower_width = "30";
  h.state.config.prime_tower_brim_width = "5";
  h.state.config.wipe_tower_wall_type = "rib";
  h.state.config.wipe_tower_rib_width = "8";
  h.state.config.wipe_tower_extra_rib_length = "8";
  h.state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [1, 100],
    rotationDeg: 0,
    filamentId: h.ids.physical0,
  };
  run("tower-brim-overhang", h, undefined, { buildVolume });
  h.state.plates[0].wipeTower.positionMm = [14, 100];
  run("tower-brim-seated", h, undefined, { buildVolume });
  // The plate overrides the project; arrays and odd spellings coerce as Number/String.
  h.state.plates[0].config.prime_tower_width = null;
  h.state.plates[0].config.wipe_tower_width = ["40", "1"];
  h.state.plates[0].config.prime_tower_brim_width = [" 2.5 "];
  h.state.plates[0].config.wipe_tower_wall_type = [" RiB "];
  h.state.plates[0].config.wipe_tower_rib_width = "-4";
  h.state.plates[0].config.wipe_tower_extra_rib_length = true;
  h.state.plates[0].wipeTower.positionMm = [208.25, 0.123456];
  run("tower-coerced-config", h, undefined, { buildVolume });
  h.state.plates[0].config.wipe_tower_width = "0";
  h.state.plates[0].config.wipe_tower_wall_type = "wall";
  h.state.plates[0].config.prime_tower_brim_width = "0x10";
  h.state.plates[0].wipeTower.positionMm = [-0.04, 189.95];
  run("tower-default-width", h, undefined, { buildVolume });
  h.state.plates[0].config.prime_tower_width = "Infinity";
  run("tower-infinite-width", h, undefined, { buildVolume });
}
{
  const h = harness();
  h.state.customGcode.push(
    {
      id: "import:preflight:gcode",
      scope: "plate",
      plateId: h.ids.plate,
      trigger: "before-layer",
      code: "G1 X1\0M112",
    },
    {
      id: "import:preflight:project-gcode",
      scope: "project",
      trigger: "before-plate",
      code: "M117 é😀\ud800",
    },
    {
      id: "import:preflight:short",
      scope: "project",
      trigger: "after-plate",
      code: "G28",
    },
  );
  run("custom-gcode-limits", h, undefined, { customGcodeByteLimit: 4 });
  run("custom-gcode-default-limit", h);
  h.state.customGcode[2].code = "G1 X1\n".repeat(50000);
  run("custom-gcode-large", h);
}
{
  const h = harness();
  h.state.plates.push({
    id: "import:preflight:plate-2",
    name: "Plate 2",
    order: 1,
    printable: true,
    config: {},
    objects: [],
  });
  h.state.customGcode.push({
    id: "import:preflight:other-plate",
    scope: "plate",
    plateId: "import:preflight:plate-2",
    trigger: "before-layer",
    code: "M600\0",
  });
  run("custom-gcode-other-plate", h, undefined, { customGcodeByteLimit: 1 });
  run("custom-gcode-second-plate", h, "import:preflight:plate-2", {
    customGcodeByteLimit: 1,
  });
}
{
  const h = harness();
  h.state.printer.toolCount = 0;
  run("invalid-state", h);
  h.state.name = " ";
  run("invalid-state-multiple", h, "import:preflight:missing");
}

// Constraint refusals.
{
  const h = harness();
  for (const [name, constraints] of [
    ["constraint-build-volume", { buildVolume: { ...buildVolume, maxXmm: 0 } }],
    [
      "constraint-build-volume-z",
      { buildVolume: { ...buildVolume, minZmm: 250 } },
    ],
    ["constraint-gcode-zero", { customGcodeByteLimit: 0 }],
    ["constraint-gcode-fraction", { customGcodeByteLimit: 1.5 }],
    ["constraint-gcode-unsafe", { customGcodeByteLimit: 2 ** 53 }],
    ["constraint-tolerance", { geometryToleranceMm: -1 }],
    ["constraint-tool-count", { printer: { physicalToolCount: 0 } }],
    [
      "constraint-ceiling",
      { printer: { physicalToolCount: 2, maxTotalFilaments: 65 } },
    ],
    ["constraint-nozzle", { tools: [null, { nozzleDiameterMm: 0 }] }],
    [
      "constraint-materials",
      { tools: [{ supportedMaterials: ["PLA", " \t"] }] },
    ],
    [
      "constraint-temperature",
      {
        tools: [
          null,
          null,
          { minHotendTemperatureC: 250, maxHotendTemperatureC: 200 },
        ],
      },
    ],
    [
      "constraint-order",
      {
        buildVolume: { ...buildVolume, maxYmm: -1 },
        customGcodeByteLimit: 0,
        printer: { physicalToolCount: 0 },
      },
    ],
  ])
    run(name, h, undefined, constraints);
}

// Printer capability, materials and gradients.
{
  const h = harness();
  run("single-tool-printer", h, undefined, {
    buildVolume,
    printer: { physicalToolCount: 1 },
  });
  run("two-tool-printer", h, undefined, {
    buildVolume,
    printer: { physicalToolCount: 2 },
  });
}
for (const [name, first, second] of [
  ["materials-pla-petg", "PLA", "PETG"],
  ["materials-pla-pc", " pla-cf ", "PC"],
  ["materials-long-s", "aſa", "PETG-CF"],
  ["materials-unknown", "PLA", "Wood"],
  ["materials-empty", "", "PLA"],
  ["materials-support", "PVA", "BVOH"],
  ["materials-abs-pla", "ABS", "PLA"],
]) {
  const h = harness();
  h.state.filaments.physical[0].material = first;
  h.state.filaments.physical[1].material = second;
  run(name, h, undefined, { buildVolume });
}
{
  const h = harness();
  h.state.filaments.mixed[0].fullSpectrum = recipe(h, {
    gradientStart: 0.995,
    gradientEnd: 0.005,
    gradientComponentIds: [h.ids.physical0, h.ids.physical1, h.ids.physical0],
  });
  run("gradient-out-of-bounds", h, undefined, {
    buildVolume,
    printer: { physicalToolCount: 2 },
  });
  h.state.filaments.mixed[0].fullSpectrum = recipe(h, {
    gradientComponentIds: [h.ids.physical0, h.ids.physical1],
    gradientComponentWeights: [70, 30],
  });
  run("gradient-clean", h, undefined, {
    buildVolume,
    printer: { physicalToolCount: 2 },
  });
  run("gradient-narrowed", h, undefined, {
    buildVolume,
    printer: { physicalToolCount: 1 },
  });
  h.state.filaments.mixed[0].fullSpectrum = recipe(h, {
    gradientStart: 0.01,
    gradientEnd: 0.99,
    gradientComponentIds: [
      h.ids.physical1,
      h.ids.physical1,
      h.ids.physical0,
      h.ids.physical1,
    ],
  });
  run("gradient-duplicates-ordered", h, undefined, {
    printer: { physicalToolCount: 1 },
  });
}
{
  const h = harness();
  const template = h.state.filaments.mixed[0];
  for (let index = 0; index < 62; index += 1) {
    h.state.filaments.mixed.push({
      ...template,
      id: `import:preflight:mix-${index}`,
      name: `Mix ${index}`,
    });
  }
  run("engine-ceiling", h);
  h.state.filaments.mixed[62].enabled = false;
  run("engine-ceiling-disabled", h);
  h.state.filaments.mixed[61].fullSpectrum = recipe(h, {
    uiMode: 0,
    gradientEnabled: false,
    deleted: true,
  });
  run("engine-ceiling-printer", h, undefined, {
    printer: { physicalToolCount: 2, maxTotalFilaments: 3 },
  });
}

// Physical filament tool constraints.
{
  const h = harness();
  const [first, second] = h.state.filaments.physical;
  first.material = " Pla ";
  second.material = "";
  first.config.nozzle_temperature = "200;250";
  first.config.nozzle_temperature_initial_layer = [" 205 ", 190];
  second.config.nozzle_temperature = "abc";
  second.config.nozzle_temperature_initial_layer = [];
  second.nozzleDiameterMm = 0.4000005;
  run("tool-constraints", h, undefined, {
    tools: [
      {
        supportedMaterials: ["PETG", "pla"],
        maxHotendTemperatureC: 240,
      },
      {
        nozzleDiameterMm: 0.4,
        supportedMaterials: ["PLA"],
        minHotendTemperatureC: 195.5,
      },
    ],
  });
  second.nozzleDiameterMm = 0.41;
  second.config.nozzle_temperature = true;
  second.config.nozzle_temperature_initial_layer = "0x10, 1e2";
  first.config.nozzle_temperature = null;
  first.config.nozzle_temperature_initial_layer = "";
  run("tool-constraints-coercion", h, undefined, {
    tools: [{}, { nozzleDiameterMm: 0.4, minHotendTemperatureC: 20 }],
  });
  first.config.nozzle_temperature = 250;
  delete first.config.nozzle_temperature_initial_layer;
  first.toolId = 3;
  h.state.printer.toolCount = 4;
  run("tool-constraints-sparse", h, undefined, {
    tools: [
      null,
      null,
      null,
      { minHotendTemperatureC: 260, maxHotendTemperatureC: 300 },
    ],
    printer: { physicalToolCount: 3 },
  });
}

// Prime-tower preconditions.
{
  const h = harness();
  h.state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [100, 100],
    rotationDeg: 0,
    filamentId: h.ids.physical0,
  };
  h.state.config.use_relative_e_distances = "0";
  h.state.config.ooze_prevention = "1";
  h.state.config.single_extruder_multi_material = "1";
  h.state.filaments.physical[0].config.filament_diameter = "1.75";
  h.state.filaments.physical[1].config.filament_diameter = "2.85";
  run("tower-preconditions", h, undefined, {
    buildVolume,
    tools: [{ nozzleDiameterMm: 0.4 }, { nozzleDiameterMm: 0.6 }],
  });
  h.state.config.use_relative_e_distances = "1";
  h.state.config.ooze_prevention = "0";
  run("tower-filament-diameter", h, undefined, {
    buildVolume,
    tools: [{ nozzleDiameterMm: 0.4 }, { nozzleDiameterMm: 0.4 }],
  });
  // Plate scope wins; object scope is not a plate setting.
  h.state.plates[0].config.use_relative_e_distances = false;
  h.state.plates[0].config.ooze_prevention = " TRUE ";
  h.state.config.single_extruder_multi_material = 1;
  h.state.plates[0].objects[0].config.use_relative_e_distances = "1";
  h.state.filaments.physical[1].config.filament_diameter = ["1.8", "x"];
  h.state.filaments.physical[0].nozzleDiameterMm = 0.6;
  h.state.filaments.physical[1].nozzleDiameterMm = 0.60009;
  run("tower-plate-scope", h, undefined, { buildVolume });
  h.state.config.use_relative_e_distances = false;
  h.state.config.ooze_prevention = " TRUE ";
  run("tower-project-flags", h, undefined, { buildVolume });
  h.state.config.use_relative_e_distances = "yes";
  h.state.config.single_extruder_multi_material = "  0 ";
  h.state.filaments.physical[0].config.filament_diameter = "0";
  // Tool order, not library order, picks the reference tool.
  h.state.filaments.physical[0].toolId = 1;
  h.state.filaments.physical[1].toolId = 0;
  h.state.filaments.physical[1].nozzleDiameterMm = 0.4;
  run("tower-unparsed-flags", h, undefined, { buildVolume });
  h.state.config.ooze_prevention = 0;
  h.state.filaments.physical[0].config.filament_diameter = [1.75];
  h.state.filaments.physical[1].config.filament_diameter = "1.9";
  run("tower-reordered-tools", h, undefined, {
    buildVolume,
    tools: [{ supportedMaterials: ["PLA"] }, { nozzleDiameterMm: 0.4 }],
  });
}

const result = (c) => (c.resultJson ? JSON.parse(c.resultJson) : undefined);
const codes = [
  ...new Set(cases.flatMap((c) => result(c)?.issues.map((i) => i.code) ?? [])),
].sort();
const sourceCodes = [
  ...read("web/src/project/slicing/preflight.ts").matchAll(
    /^ {2}\| '([a-z-]+)'$/gm,
  ),
]
  .map((m) => m[1])
  .filter((code) => !["warning", "error"].includes(code));
const issueCodes = sourceCodes.filter((code) =>
  read("web/src/project/slicing/preflight.ts").includes(`code: '${code}'`),
);
for (const code of issueCodes)
  assert.ok(codes.includes(code), `Uncovered preflight code ${code}`);
const unreadable = [
  ...new Set(
    cases.flatMap(
      (c) =>
        result(c)
          ?.issues.filter((i) => i.code === "unreadable-model-mesh")
          .map((i) =>
            i.message
              .replace(/^.*?asset: /, "")
              .replace(/import:\S+|[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>"),
          ) ?? [],
    ),
  ),
].sort();
const covered = new Set(unreadable);
for (const message of [
  "Asset repository metadata differs for <id>",
  "Canonical bounds contain a non-finite transformed vertex",
  "Mesh contains a non-finite vertex",
  "Mesh index is outside the vertex buffer",
  "Mesh index count does not match the declared triangle count",
  "Mesh position buffer view is outside the payload",
  "Mesh position stride is invalid",
  "Volume <id> references missing asset <id>",
])
  assert.ok(
    covered.has(message),
    `Uncovered mesh refusal ${message}: ${unreadable.join(" | ")}`,
  );
const errors = [
  ...new Set(cases.flatMap((c) => (c.error ? [c.error] : []))),
].sort();

const sources = [
  "tools/cross-platform/slice-preflight-vectors.mjs",
  "web/src/project/slicing/preflight.ts",
  "web/src/project/filaments/fullSpectrumCompatibility.ts",
  "web/src/project/objects/wipeTowerPlacement.ts",
  "web/src/project/objects/bounds.ts",
  "web/src/project/meshCodec.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/__tests__/fixtures.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      codes,
      unreadable,
      errors,
      cases,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/slice-preflight-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Slice preflight reference drift",
  );
console.log(
  `slice preflight: ${cases.length} cases, ${codes.length} codes, ${unreadable.length} mesh refusals, ${errors.length} constraint errors`,
);
