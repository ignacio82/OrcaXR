// Drawn parts — embossed text and SVG parts — as the browser's workspace
// tools make them, for the shared core and the Android Workspace:
//
// - A journey: the production `CanonicalWorkspaceController` opens a
//   canonical 3MF (seeded IDs) and the Emboss and SVG part tools are applied
//   as `OrcaWorkspace.applyEmboss` and `applySvgPart` apply them — a new text
//   part of the selection's one object, a re-cut when the selection is one
//   text part, the same for SVG parts, a drawn part of the other kind left
//   alone, failures (no glyph, no geometry: their IDs still drawn) and no
//   object to add to — with the font and drawings the operator picked, read
//   as the tools read them (`readEmbossFontWire`, `readSvgDrawingWire`). After
//   each step: what the tools target (the object, a selected text or SVG
//   part), the semantic hash and the undo label; then every entry undone.
// - Drawn-part replies (`DrawnPartReply`) for every part of the journey's
//   project once its parts are made, and an unknown one, with the project's
//   state and assets to replay them on.
// - The tools' starting recipe (`DEFAULT_EMBOSS_TEXT_CONFIGURATION`) and depth.
//
// Replayed by Rust, by WASM in Node and Chrome and over JNI; the journey is
// taken through the Android workspace over JNI (ProjectDrawnPartEditChecks).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { createEmptyProject, emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  SYNTHETIC_SANS,
  trueTypeFont,
} from "../../web/src/project/objects/__tests__/syntheticFonts.ts";
import { DEFAULT_EMBOSS_TEXT_CONFIGURATION } from "../../web/src/project/objects/emboss.ts";
import { readEmbossFontWire } from "../../web/src/project/objects/embossFontExchange.ts";
import { DEFAULT_SVG_PART_DEPTH_MM } from "../../web/src/project/objects/svgCommands.ts";
import { readSvgDrawingWire } from "../../web/src/project/objects/svgPartExchange.ts";
import { drawnPartWire } from "../../web/src/project/objects/drawnPartExchange.ts";
import {
  encodeProjectDrawnPartReply,
  encodeProjectDrawnPartRequest,
  encodeProjectEmbossTextRequest,
  encodeProjectSvgDrawingReply,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

/** A recipe in the contract's encoding (`embossConfigurationFromWire`'s inverse). */
const wireRecipe = (recipe) => {
  const optional = (value) => (value === undefined ? { absent: {} } : { value: units(value) });
  return {
    text: units(recipe.text),
    styleName: units(recipe.styleName),
    fontDescriptor: units(recipe.fontDescriptor),
    fontDescriptorType: units(recipe.fontDescriptorType),
    font: { ...recipe.font },
    projection: { ...recipe.projection },
    family: optional(recipe.family),
    faceName: optional(recipe.faceName),
    style: optional(recipe.style),
    weight: optional(recipe.weight),
  };
};

// --- The project -------------------------------------------------------------------
process.env.TZ = "UTC";
const NOW = "2026-10-12T00:00:00.000Z";
const serializer = new Bbs3mfProjectSerializer();
function prism(outline, height) {
  const n = outline.length;
  const vertices = [...outline.map(([x, y]) => [x, y, 0]), ...outline.map(([x, y]) => [x, y, height])];
  const triangles = [];
  for (let i = 1; i + 1 < n; i++) triangles.push([0, i + 1, i], [n, n + i, n + i + 1]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { vertices, triangles };
}
const square = (size) => [
  [-size / 2, -size / 2],
  [size / 2, -size / 2],
  [size / 2, size / 2],
  [-size / 2, size / 2],
];
const payloads = Object.fromEntries(
  [
    ["slab", prism(square(30), 4)],
    ["post", prism(square(8), 20)],
  ].map(([name, mesh]) => [
    name,
    encodeIndexedMeshAsset({
      id: `import:asset:drawn-${name}`,
      positions: mesh.vertices.flat(),
      indices: mesh.triangles.flat(),
    }),
  ]),
);
const identity = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x, y) => ({ ...identity, translationMm: [x, y, 0] });
const { filamentId: _filament, ...template } = createProjectFixture().state.plates[0].objects[0];
const object = (key, volumes, instances) => ({
  ...structuredClone(template),
  id: `import:object:drawn-${key}`,
  name: key,
  layerRanges: [],
  volumes: volumes.map(([name, mesh, transform]) => ({
    id: `import:volume:drawn-${name}`,
    name,
    role: "model",
    source: {
      assetId: payloads[mesh].descriptor.id,
      topologyRevision: 0,
      triangleCount: payloads[mesh].descriptor.mesh.triangleCount,
    },
    transform: transform ?? identity,
    config: {},
    annotations: emptyFacetAnnotations(0),
  })),
  instances: instances.map((transform, i) => ({ id: `import:instance:drawn-${key}-${i + 1}`, transform, printable: true })),
});
const start = createEmptyProject({ idSource: new UuidIdSource(seededRandom(0xd7a1)), now: NOW });
start.config = { printable_area: ["0x0", "250x0", "250x250", "0x250"], printable_height: "250" };
start.plates[0].objects = [
  object("base", [["base", "slab"]], [at(60, 60)]),
  object("pair", [["left", "post"], ["right", "post", at(12, 0)]], [at(160, 160), at(190, 60)]),
];
start.sourceAssets = Object.values(payloads).map((payload) => payload.descriptor);
assertValidProjectState(start);
const startAssets = new InMemoryAssetRepository();
for (const payload of Object.values(payloads)) startAssets.put(payload.descriptor, payload.bytes);
const source = new EditorSession({ initialState: start, assets: startAssets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });

const SEED = 0xd7a2;
const seeded = new UuidIdSource(seededRandom(SEED));
const idSource = {
  drawn: 0,
  next(kind) {
    this.drawn += 1;
    return seeded.next(kind);
  },
};
const controller = CanonicalWorkspaceController.createEmpty({
  idSource,
  clock: () => NOW,
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [250, 250], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
const opened = controller.captureProjectExportGuard();
assert.equal(opened.semanticHash, source.captureExportGuard().semanticHash);
const skippedIds = idSource.drawn;
const live = () => controller.session.project.getSnapshot().state;
const observe = () => {
  const { history } = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: history.undoCount,
    undoLabel: history.undoLabel ?? null,
  };
};

// --- What the tools target (OrcaWorkspace) ------------------------------------------
/** `paintableSelectedVolumes`: the active plate's model parts the selection takes (all with nothing selected). */
function paintable() {
  const state = live();
  const refs = controller.session.selection.getSnapshot().refs;
  const volumes = new Set(refs.filter((r) => r.kind === "volume").map((r) => r.id));
  const instances = new Set(refs.filter((r) => r.kind === "instance").map((r) => r.id));
  const plate = state.plates.find((p) => p.id === state.activePlateId);
  const targets = [];
  for (const o of plate.objects)
    for (const instance of o.instances)
      for (const v of o.volumes) if (v.role === "model") targets.push({ volumeId: v.id, objectId: o.id, instanceId: instance.id });
  const objects = new Set([
    ...refs.filter((r) => r.kind === "object").map((r) => r.id),
    ...targets.filter((t) => instances.has(t.instanceId)).map((t) => t.objectId),
  ]);
  const all = volumes.size === 0 && objects.size === 0;
  const chosen = targets.filter((t) => all || volumes.has(t.volumeId) || objects.has(t.objectId));
  return { volumes: [...new Set(chosen.map((t) => t.volumeId))], objects: [...new Set(chosen.map((t) => t.objectId))] };
}
/** `brimEarTargetObject`, `embossTargetVolume` and `svgTargetVolume`. */
function target() {
  const { volumes, objects } = paintable();
  const single = volumes.length === 1 ? volumes[0] : undefined;
  const part = single === undefined ? undefined : controller.getDrawnPart(single);
  return {
    objectId: objects.length === 1 ? objects[0] : null,
    textVolumeId: part?.text ? single : null,
    svgVolumeId: part?.svg ? single : null,
  };
}

// --- The font and drawings the operator picked -------------------------------------------
const fontBytes = trueTypeFont(SYNTHETIC_SANS);
const { font } = readEmbossFontWire({ collection: 0 }, fontBytes);
assert.ok(font);
// `loadEmbossFont` names the recipe after the file.
const FONT_NAME = "sample.ttf";
let recipe = { ...DEFAULT_EMBOSS_TEXT_CONFIGURATION, styleName: FONT_NAME, fontDescriptor: FONT_NAME, fontDescriptorType: "file_name" };
const svg = (body, attributes = 'width="40mm" height="20mm" viewBox="0 0 40 20"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const drawings = {
  "badge.svg": svg('<path d="M0 0 H40 V20 H0 Z M5 5 V15 H35 V5 Z"/><circle cx="20" cy="10" r="3"/><text>x</text>'),
  "star.svg": svg('<polygon points="10,0 13,7 20,7 14,11 16,18 10,14 4,18 6,11 0,7 7,7"/>', 'width="20mm" height="18mm" viewBox="0 0 20 18"'),
  "words.svg": svg("<text>no shapes</text><rect width=\"10\" height=\"10\" fill=\"none\" stroke=\"#000\"/>"),
};
const drawingReads = Object.fromEntries(
  Object.entries(drawings).map(([name, text]) => [name, readSvgDrawingWire(new TextEncoder().encode(text))]),
);

// --- The journey -----------------------------------------------------------------
const steps = [];
async function step(operation, run) {
  const result = (await run()) ?? null;
  steps.push({ operation, result, target: target(), ...observe() });
}
const choose = (entity, id) =>
  step({ kind: "select", entity, id }, async () => {
    controller.setObjectsTreeSelection(entity === null ? [] : [{ kind: entity, id }]);
  });
/** `OrcaWorkspace.setEmbossRecipe` then `applyEmboss`. */
const emboss = (patch) =>
  step(
    { kind: "emboss", configuration: encodeProjectEmbossTextRequest({ configuration: wireRecipe((recipe = { ...recipe, ...patch, font: { ...recipe.font, ...(patch.font ?? {}) }, projection: { ...recipe.projection, ...(patch.projection ?? {}) } })) }) },
    async () => {
      const volumeId = target().textVolumeId;
      try {
        if (volumeId) {
          const mesh = await controller.editEmbossText(volumeId, recipe, font);
          return { outcome: "recut", volumeId, triangleCount: mesh.triangleCount, missingCodePoints: [...mesh.missingCodePoints] };
        }
        const objectId = target().objectId;
        if (!objectId) return { outcome: "noTarget" };
        const added = await controller.addEmbossText(objectId, recipe, font);
        return {
          outcome: "added",
          volumeId: added.volumeId,
          triangleCount: added.mesh.triangleCount,
          missingCodePoints: [...added.mesh.missingCodePoints],
        };
      } catch (error) {
        return { outcome: "failed", message: error.message };
      }
    },
  );
/** `OrcaWorkspace.loadSvgDrawing`, `setSvgPartSize` then `applySvgPart`. */
const cut = (fileName, depthMm, widthMm) =>
  step({ kind: "svg", fileName, depthMm, widthMm: widthMm ?? null }, async () => {
    const options = { fileName, depthMm, ...(widthMm !== undefined ? { widthMm } : {}) };
    const volumeId = target().svgVolumeId;
    try {
      let prepared;
      let added;
      if (volumeId) prepared = await controller.editSvgPart(volumeId, drawings[fileName], options);
      else {
        const objectId = target().objectId;
        if (!objectId) return { outcome: "noTarget" };
        ({ prepared, volumeId: added } = await controller.addSvgPart(objectId, drawings[fileName], options));
      }
      return {
        outcome: volumeId ? "recut" : "added",
        volumeId: volumeId ?? added,
        triangleCount: prepared.mesh.triangleCount,
        sizeMm: [...prepared.sizeMm],
        unsupportedCount: prepared.unsupported.length,
      };
    } catch (error) {
      return { outcome: "failed", message: error.message };
    }
  });
const id = (kind, key) => `import:${kind}:drawn-${key}`;

// Text on the base, then the text part re-cut, then a text the font cannot cut (its IDs still drawn).
await choose("instance", id("instance", "base-1"));
await emboss({ text: "AOi" });
const textPart = steps.at(-1).result.volumeId;
await choose("volume", textPart);
await emboss({ text: "LE\n8#", font: { horizontal: "left", lineGapMm: 1, charGapMm: 0.5 }, projection: { depthMm: 1.5 } });
await emboss({ text: "zz" });
// Nothing selected: two objects, nothing to add to; then the pair's two parts, one object.
await choose(null, null);
await emboss({ text: "Ä" });
await cut("star.svg", 2);
await choose("instance", id("instance", "pair-2"));
await emboss({ text: "AÄ", font: { vertical: "top", skew: 0.2 } });
// A drawing on the base (its text part is a part of it too), re-cut, then one with no geometry.
await choose("object", id("object", "base"));
await cut("badge.svg", 2);
const svgPart = steps.at(-1).result.volumeId;
await choose("volume", svgPart);
await cut("badge.svg", 3, 25);
await cut("words.svg", 3, 25);
// A drawn part of the other kind is not re-cut: each tool adds to its object instead.
await emboss({ text: "8" });
await choose("volume", textPart);
await cut("star.svg", 1.5);
// A plain part: added to its object.
await choose("volume", id("volume", "left"));
await cut("badge.svg", 2);

// --- Drawn-part replies on the project they made ---------------------------------------
const state = live();
const parts = [];
for (const plate of state.plates)
  for (const o of plate.objects)
    for (const v of o.volumes) {
      const request = encodeProjectDrawnPartRequest({ volumeId: units(v.id) });
      parts.push({ request, reply: encodeProjectDrawnPartReply(drawnPartWire(state, { volumeId: units(v.id) })) });
    }
for (const volumeId of ["import:volume:missing", textPart.toUpperCase()]) {
  parts.push({
    request: encodeProjectDrawnPartRequest({ volumeId: units(volumeId) }),
    reply: encodeProjectDrawnPartReply(drawnPartWire(state, { volumeId: units(volumeId) })),
  });
}
const projectJson = canonicalStringify(state);
const assets = state.sourceAssets.map((descriptor) => {
  const payload = controller.assets.get(descriptor.id);
  return { descriptorJson: canonicalStringify(payload.descriptor), bytes: Buffer.from(payload.bytes).toString("base64") };
});

const undo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  undo.push(observe());
}
assert.equal(undo.at(-1).semanticHash, opened.semanticHash);
controller.dispose();

const sources = [
  "tools/cross-platform/drawn-part-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/workspace/OrcaWorkspace.ts",
  "web/src/project/objects/drawnPartExchange.ts",
  "web/src/project/objects/embossCommands.ts",
  "web/src/project/objects/svgCommands.ts",
  "web/src/project/objects/emboss.ts",
  "web/src/project/objects/embossFontExchange.ts",
  "web/src/project/objects/__tests__/syntheticFonts.ts",
  "web/node_modules/three/package.json",
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
      defaults: {
        configuration: encodeProjectEmbossTextRequest({ configuration: wireRecipe(DEFAULT_EMBOSS_TEXT_CONFIGURATION) }),
        svgDepthMm: DEFAULT_SVG_PART_DEPTH_MM,
      },
      parts: { projectJson, assets, steps: parts },
      journey: {
        archive: Buffer.from(serialized.bytes).toString("base64"),
        opened: { semanticHash: opened.semanticHash },
        seed: SEED,
        skippedIds,
        importedAt: NOW,
        font: { name: FONT_NAME, bytes: Buffer.from(fontBytes).toString("base64") },
        drawings: Object.entries(drawings).map(([name, text]) => ({
          name,
          bytes: Buffer.from(text).toString("base64"),
          read: encodeProjectSvgDrawingReply(drawingReads[name]),
        })),
        steps,
        undo,
      },
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/drawn-part-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Drawn part reference drift");
const outcomes = Object.groupBy(
  steps.filter((s) => s.operation.kind !== "select"),
  (s) => `${s.operation.kind} ${s.result.outcome}`,
);
console.log(
  `drawn parts: journey of ${steps.length} steps (${Object.entries(outcomes)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}), ${undo.length} undo entries; ${parts.length} drawn-part replies`,
);
