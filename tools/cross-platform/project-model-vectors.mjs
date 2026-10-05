// Execute the existing TypeScript model/selectors; native code never supplies expectations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "../../web/node_modules/typescript/lib/typescript.js";
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
} from "../../web/src/project/domain/model.ts";
import {
  UuidIdSource,
  seededRandom,
} from "../../web/src/project/domain/ids.ts";
import {
  canonicalStringify,
  projectFingerprint,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import {
  findPlate,
  findObject,
  findVolume,
  findInstance,
  findLayerRange,
  allProjectObjects,
  isTopologyCurrent,
  resolveFilament,
} from "../../web/src/project/domain/selectors.ts";
const root = new URL("../../", import.meta.url);
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const json = canonicalStringify;
const id = (kind, n) => `import:${kind}:${n}`;
const text = "PRIVATE_MODEL_TEXT\u0000\ud800\udfff\ud800\udc00\ue000";
const unknown = () =>
  JSON.parse(
    '{"__proto__":{"value":"data"},"constructor":{"not":"code"},"\\ud800":"lone","\\ud800\\udc00":1,"\\ue000":2,"negativeZero":-0,"smallest":5e-324,"largest":1.7976931348623157e308}',
  );
const extra = () => ({
  "future-field": unknown(),
  ["__proto__"]: { tag: "own data" },
});
function decorate(target, ...sources) {
  for (const source of sources)
    for (const [key, value] of Object.entries(source))
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return target;
}
const n0 = id("physical", 0),
  n1 = id("physical", 1),
  mixed = id("mixed", 0),
  meshId = id("asset", "mesh");
const model = createEmptyProject({
  idSource: new UuidIdSource(seededRandom(2026)),
  now: "2026-10-05T00:00:00Z",
  toolCount: 2,
  name: text,
  firstPlateName: text,
});
decorate(model, extra(), {
  settingsBaseConfig: { layer_height: 0.2, ...unknown() },
  settingsOverrides: { layer_height: 0.3 },
  config: { layer_height: 0.3, ...unknown() },
  extensionData: unknown(),
});
decorate(model.printer, extra(), {
  profileId: text,
  profileHash: "profile-hash",
});
model.filaments.physical = [n0, n1].map((id, toolId) => ({
  id,
  toolId,
  name: text,
  presetId: text,
  presetHash: text,
  material: "PLA",
  vendor: text,
  color: toolId ? "#ffffff" : "#000000",
  nozzleDiameterMm: 0.4,
  config: unknown(),
  enabled: true,
  extensionData: unknown(),
  ...extra(),
}));
model.filaments.mixed = [
  {
    id: mixed,
    name: text,
    displayColor: "#808080",
    components: [
      { filamentId: n0, weight: 0.5, ...extra() },
      { filamentId: n1, weight: 0.5, ...extra() },
    ],
    distribution: { mode: "ratio", ...extra() },
    fullSpectrum: {
      schemaVersion: 1,
      upstreamStableId: "18446744073709551615",
      uiMode: 0,
      componentAId: n0,
      componentBId: n1,
      ratioA: 1,
      ratioB: 1,
      mixBPercent: 50,
      manualPatternGroups: [[n0, n1], [n1]],
      gradientComponentIds: [n0, n1],
      gradientComponentWeights: [1, 1],
      pointillismAllFilaments: false,
      distributionMode: 0,
      localZMaxSublayers: 4,
      gradientEnabled: true,
      gradientStart: 0.2,
      gradientEnd: 0.8,
      componentASurfaceOffsetMm: -0.4,
      componentBSurfaceOffsetMm: 0.4,
      deleted: false,
      custom: true,
      originAuto: false,
      ...extra(),
    },
    config: unknown(),
    enabled: true,
    extensionData: unknown(),
    ...extra(),
  },
];
decorate(model.filaments, extra());
model.sourceAssets = ["mesh", "archive", "thumbnail", "extension"].map(
  (kind, index) => ({
    id: index ? id("asset", kind) : meshId,
    kind,
    digest: "opaque",
    byteLength: index ? 4 : 144,
    mediaType: "application/octet-stream",
    sourceFilename: text,
    provenance: {
      source: ["import", "generated", "recovered", "import"][index],
      uri: text,
      importedAt: text,
      ...extra(),
    },
    ...(index
      ? {}
      : {
          mesh: {
            triangleCount: 4,
            positions: {
              byteOffset: 0,
              byteLength: 96,
              componentType: "float32",
              componentCount: 3,
              count: 8,
              byteStride: 12,
              ...extra(),
            },
            indices: {
              byteOffset: 96,
              byteLength: 48,
              componentType: "uint32",
              componentCount: 1,
              count: 12,
              ...extra(),
            },
            ...extra(),
          },
        }),
    ...extra(),
  }),
);
const annotated = () => {
  const value = {
    ...emptyFacetAnnotations(),
    color: [{ value: n0, triangles: [0, 3], ...extra() }],
    support: [
      { value: "enforce", triangles: [0] },
      { value: "block", triangles: [1] },
    ],
    seam: [
      { value: "prefer", triangles: [0] },
      { value: "avoid", triangles: [1] },
    ],
    fuzzySkin: [{ value: true, triangles: [0] }],
    brim: [
      { value: true, triangles: [0] },
      { value: false, triangles: [1] },
    ],
    refinement: {
      color: {
        version: 2,
        triangleCount: 4,
        splits: [
          {
            triangle: 1,
            node: {
              kind: "split",
              splitSides: 1,
              specialSide: 2,
              children: [
                { kind: "leaf", state: { kind: "assigned", value: n0 } },
                { kind: "leaf", state: { kind: "unpainted" } },
              ],
            },
          },
        ],
      },
    },
    ...extra(),
  };
  return value;
};
const transform = () => ({ ...identityTransform(), ...extra() });
const volume = (objectIndex, role, volumeIndex) => ({
  id: id("volume", `${objectIndex}-${volumeIndex}`),
  name: text,
  role,
  source: {
    assetId: meshId,
    topologyRevision: 0,
    triangleCount: 4,
    ...extra(),
  },
  transform: transform(),
  config: unknown(),
  ...(["model", "parameter-modifier"].includes(role)
    ? { filamentId: volumeIndex ? n1 : mixed }
    : {}),
  annotations:
    role === "model" ? annotated() : { ...emptyFacetAnnotations(), ...extra() },
  embossText: {
    text,
    styleName: text,
    fontDescriptor: text,
    fontDescriptorType: text,
    font: {
      charGapMm: 0,
      lineGapMm: 1,
      lineHeightMm: 10,
      boldnessMm: 0.2,
      skew: 0.1,
      perGlyph: true,
      horizontal: "center",
      vertical: "bottom",
      collection: 0,
      ...extra(),
    },
    projection: { depthMm: 1, useSurface: false, ...extra() },
    family: text,
    faceName: text,
    style: text,
    weight: text,
    ...extra(),
  },
  embossSvg: {
    pathIn3mf: "3D/drawing.svg",
    drawingAssetId: id("asset", "extension"),
    sourcePath: text,
    depthMm: 1,
    useSurface: true,
    widthMm: 20,
    ...extra(),
  },
  extensionData: unknown(),
  ...extra(),
});
const object = (i) => ({
  id: id("object", i),
  name: text,
  config: unknown(),
  filamentId: n0,
  volumes: [
    "model",
    "parameter-modifier",
    "negative-volume",
    "support-enforcer",
    "support-blocker",
  ].map((role, j) => volume(i, role, j)),
  instances: [0, 1].map((j) => ({
    id: id("instance", `${i}-${j}`),
    name: text,
    transform: transform(),
    printable: j === 0,
    extensionData: unknown(),
    ...extra(),
  })),
  layerRanges: [
    {
      id: id("range", `${i}-high`),
      minZMm: 10,
      maxZMm: 20,
      config: unknown(),
      filamentId: n1,
      ...extra(),
    },
    {
      id: id("range", `${i}-low`),
      minZMm: 0,
      maxZMm: 10,
      config: unknown(),
      ...extra(),
    },
  ],
  brimEars: [{ positionMm: [1, 2, 0], headFrontRadiusMm: 5, ...extra() }],
  layerHeightProfile: [0, 0.2, 20, 0.1],
  extensionData: unknown(),
  ...extra(),
});
decorate(model.plates[0], extra(), {
  config: unknown(),
  objects: [object(0)],
  wipeTower: {
    enabled: true,
    positionMm: [10, 20],
    rotationDeg: 90,
    filamentId: mixed,
    ...extra(),
  },
  extensionData: unknown(),
});
model.plates.push({
  ...cloneJson(model.plates[0]),
  id: id("plate", 1),
  order: 1,
  objects: [object(1)],
});
model.customGcode = [
  "color-change",
  "pause",
  "tool-change",
  "template",
  "custom",
].map((type, i) => ({
  id: id("gcode", i),
  scope: "plate",
  plateId: model.plates[0].id,
  trigger: "before-layer",
  code: type === "custom" ? "G4 P200" : "",
  layerEvent: {
    type,
    topZMm: i + 1,
    toolIndex: 1,
    filamentId: n0,
    color: "#000000",
    message: text,
    ...extra(),
  },
  ...extra(),
}));
model.customGcode.push({
  id: id("gcode", "project"),
  scope: "project",
  trigger: "before-plate",
  code: text,
  ...extra(),
});
model.thumbnails = [
  {
    id: id("thumbnail", 0),
    assetId: id("asset", "thumbnail"),
    plateId: model.plates[0].id,
    width: 48,
    height: 48,
    ...extra(),
  },
];
model.extensionBlobs = [
  {
    id: id("extension", 0),
    namespace: text,
    path: "Metadata/extension.json",
    assetId: id("asset", "extension"),
    relationships: [text, "3D/3dmodel.model"],
    ...extra(),
  },
];
assert.deepEqual(validateProjectState(model), []);
function selectors(state) {
  const queries = {};
  for (const kind of ["plate", "object", "volume", "instance", "range"]) {
    const candidates =
      kind === "plate"
        ? state.plates
        : kind === "object"
          ? allProjectObjects(state)
          : allProjectObjects(state).flatMap((o) =>
              kind === "volume"
                ? o.volumes
                : kind === "instance"
                  ? o.instances
                  : o.layerRanges,
            );
    const lookup = {
      plate: findPlate,
      object: findObject,
      volume: findVolume,
      instance: findInstance,
      range: findLayerRange,
    }[kind];
    queries[kind] = [...candidates.map((v) => v.id), id(kind, "missing")].map(
      (id) => {
        const found = lookup(state, id);
        return {
          idUtf16: units(id),
          result: found === undefined ? null : json(found),
        };
      },
    );
  }
  queries.allObjects = allProjectObjects(state).map((v) => units(v.id));
  queries.topology = allProjectObjects(state).flatMap((o) =>
    o.volumes.flatMap((v) =>
      [0, 1].map((topologyRevision) => ({
        idUtf16: units(v.id),
        revision: topologyRevision,
        current: isTopologyCurrent(state, { volumeId: v.id, topologyRevision }),
      })),
    ),
  );
  queries.filaments = allProjectObjects(state).flatMap((o) => [
    {
      objectId: units(o.id),
      kind: "object",
      result: json(cloneJson(resolveFilament(o))),
    },
    ...o.volumes.map((v) => ({
      objectId: units(o.id),
      childId: units(v.id),
      kind: "volume",
      result: json(JSON.parse(JSON.stringify(resolveFilament(o, v)))),
    })),
    ...o.layerRanges.map((v) => ({
      objectId: units(o.id),
      childId: units(v.id),
      kind: "range",
      result: json(JSON.parse(JSON.stringify(resolveFilament(o, v)))),
    })),
  ]);
  return queries;
}
const cases = [];
function add(name, state) {
  assert.deepEqual(validateProjectState(state), [], name);
  cases.push({
    name,
    stateJson: json(state),
    fingerprint: projectFingerprint(state),
    selectors: selectors(state),
  });
}
add("complete-schema-with-unknowns", model);
for (const distribution of [
  { mode: "ratio" },
  { mode: "cycle" },
  { mode: "cycle", cycleLengthMm: 0.4 },
  { mode: "match", targetColor: "#fedcba" },
  { mode: "gradient", startWeights: [1, 0], endWeights: [0, 1] },
  {
    mode: "gradient",
    startZMm: 0,
    endZMm: 40,
    startWeights: [1, 0],
    endWeights: [0, 1],
  },
]) {
  const state = cloneJson(model);
  state.filaments.mixed[0].distribution = { ...distribution, ...extra() };
  add(`distribution-${json(distribution)}`, state);
}
const unassigned = cloneJson(model);
for (const object of allProjectObjects(unassigned)) {
  delete object.filamentId;
  for (const volume of object.volumes) delete volume.filamentId;
  for (const range of object.layerRanges) delete range.filamentId;
}
add("unassigned-filament-inheritance", unassigned);
const minimal = createEmptyProject({
  idSource: new UuidIdSource(seededRandom(1)),
  now: "2026-10-05T01:02:03Z",
});
add("minimal", minimal);
const huge = cloneJson(minimal);
huge.plates[0].order = 1e100;
huge.printer.toolCount = 1e100;
add("large-integral-domain-numbers", huge);
// Exercise the complete graph with identifiers JS strings can represent but
// UTF-8 strings cannot: NULs, paired surrogates and isolated surrogate halves.
const unicodeIds = new Map();
function collectIds(value) {
  if (value === null || typeof value !== "object") return;
  if (Object.hasOwn(value, "id") && typeof value.id === "string")
    unicodeIds.set(
      value.id,
      `import:unicode:${value.id}:\ud800\u0000\udfff\ud800\udc00`,
    );
  for (const child of Object.values(value)) collectIds(child);
}
collectIds(model);
assert.ok(unicodeIds.size > 20);
function remapIds(value) {
  if (typeof value === "string") return unicodeIds.get(value) ?? value;
  if (Array.isArray(value)) return value.map(remapIds);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, remapIds(child)]),
  );
}
add("utf16-identities-and-references", remapIds(model));
const edits = [];
let edited = cloneJson(model);
for (const operation of [
  "rename-project",
  "translate-instance",
  "rename-plate",
  "remove-settings-overrides",
  "reverse-plates",
]) {
  if (operation === "rename-project") edited.name = "renamed\ud800";
  if (operation === "translate-instance")
    edited.plates[0].objects[0].instances[0].transform.translationMm[0] = 12.5;
  if (operation === "rename-plate") edited.plates[0].name = "new plate";
  if (operation === "remove-settings-overrides") {
    delete edited.settingsOverrides;
    edited.config = cloneJson(edited.settingsBaseConfig);
  }
  if (operation === "reverse-plates") edited.plates.reverse();
  assert.deepEqual(validateProjectState(edited), []);
  edits.push({
    operation,
    stateJson: json(edited),
    fingerprint: projectFingerprint(edited),
  });
}
const large = cloneJson(model);
const assigned = 300_000;
const mesh = large.sourceAssets[0];
mesh.mesh.triangleCount = assigned;
mesh.mesh.positions.count = assigned * 3;
mesh.mesh.positions.byteLength = assigned * 36;
mesh.mesh.indices.count = assigned * 3;
mesh.mesh.indices.byteOffset = assigned * 36;
mesh.mesh.indices.byteLength = assigned * 12;
mesh.byteLength = assigned * 48;
for (const object of allProjectObjects(large))
  for (const volume of object.volumes) {
    volume.source.triangleCount = assigned;
    for (const channel of Object.values(volume.annotations.refinement ?? {}))
      channel.triangleCount = assigned;
  }
const painted = large.plates[0].objects[0].volumes[0].annotations;
delete painted.refinement;
painted.color[0].triangles = Array.from({ length: assigned }, (_, i) => i);
assert.deepEqual(validateProjectState(large), []);
const resourceCase = {
  assignedTriangles: assigned,
  fingerprint: projectFingerprint(large),
};
const factories = [0, 1, 2026, 0xffffffff].map((seed) => {
  const state = createEmptyProject({
    idSource: new UuidIdSource(seededRandom(seed)),
    now: "2026-10-05T01:02:03Z",
  });
  return {
    seed,
    stateJson: json(state),
    fingerprint: projectFingerprint(state),
  };
});
// A complete TypeScript AST field inventory protects hand-ported record layouts.
// Inline printer/filament/provenance records are included under native names.
const records = {};
const literals = {};
function literalValues(type, source) {
  assert.ok(ts.isUnionTypeNode(type), "expected a literal union");
  return type.types.map((part) => {
    assert.ok(ts.isLiteralTypeNode(part));
    const value = part.literal;
    if (ts.isStringLiteral(value)) return value.text;
    const number = Number(value.getText(source));
    assert.ok(Number.isFinite(number));
    return number;
  });
}
const aliasLiterals = new Set([
  "MeshComponentType",
  "SourceAssetKind",
  "VolumeRole",
  "LayerEventType",
  "EmbossHorizontalAlign",
  "EmbossVerticalAlign",
]);
const inlineLiterals = {
  BufferViewDescriptor: { componentCount: "ComponentCount" },
  FullSpectrumRecipeState: {
    uiMode: "FullSpectrumUiMode",
    distributionMode: "DistributionMode",
  },
  CustomGcode: { scope: "GcodeScope", trigger: "GcodeTrigger" },
};
for (const sourcePath of [
  "web/src/project/domain/model.ts",
  "web/src/project/objects/emboss.ts",
]) {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(new URL(sourcePath, root), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const declaration of source.statements) {
    if (
      ts.isTypeAliasDeclaration(declaration) &&
      aliasLiterals.has(declaration.name.text)
    )
      literals[declaration.name.text] = literalValues(declaration.type, source);
    if (
      ts.isTypeAliasDeclaration(declaration) &&
      declaration.name.text === "MixedDistribution"
    ) {
      assert.ok(ts.isUnionTypeNode(declaration.type));
      assert.equal(declaration.type.types.length, 4);
      for (const variant of declaration.type.types) {
        const mode = variant.members.find(
          (v) => v.name?.getText(source) === "mode",
        ).type.literal.text;
        const name = {
          ratio: "RatioDistribution",
          cycle: "CycleDistribution",
          match: "MatchDistribution",
          gradient: "GradientDistribution",
        }[mode];
        assert.ok(name);
        records[name] = variant.members.map((v) => ({
          name: v.name.getText(source),
          optional: !!v.questionToken,
        }));
      }
    }
    if (!ts.isInterfaceDeclaration(declaration)) continue;
    for (const [field, name] of Object.entries(
      inlineLiterals[declaration.name.text] ?? {},
    )) {
      literals[name] = literalValues(
        declaration.members.find((v) => v.name?.getText(source) === field).type,
        source,
      );
    }
    records[declaration.name.text] = declaration.members
      .filter(ts.isPropertySignature)
      .map((v) => ({
        name: v.name.getText(source),
        optional: !!v.questionToken,
      }));
    if (declaration.name.text === "ProjectState")
      for (const name of ["printer", "filaments"]) {
        const member = declaration.members.find(
          (v) => v.name?.getText(source) === name,
        );
        records[name === "printer" ? "Printer" : "Filaments"] =
          member.type.members.map((v) => ({
            name: v.name.getText(source),
            optional: !!v.questionToken,
          }));
      }
    if (declaration.name.text === "SourceAssetDescriptor") {
      const member = declaration.members.find(
        (v) => v.name?.getText(source) === "provenance",
      );
      records.AssetProvenance = member.type.members.map((v) => ({
        name: v.name.getText(source),
        optional: !!v.questionToken,
      }));
    }
  }
}
const required = [
  "Transform",
  "BufferViewDescriptor",
  "IndexedMeshDescriptor",
  "AssetProvenance",
  "SourceAssetDescriptor",
  "MeshSourceRef",
  "FacetAnnotations",
  "EmbossFontProperty",
  "EmbossProjection",
  "EmbossTextConfiguration",
  "EmbossSvgPart",
  "ProjectVolume",
  "ProjectInstance",
  "LayerRange",
  "BrimEarPoint",
  "ProjectObject",
  "WipeTowerState",
  "ProjectPlate",
  "PhysicalFilament",
  "MixedComponent",
  "FullSpectrumRecipeState",
  "MixedFilament",
  "CustomGcodeLayerEvent",
  "CustomGcode",
  "ProjectThumbnail",
  "ExtensionBlob",
  "Printer",
  "Filaments",
  "ProjectState",
  "RatioDistribution",
  "CycleDistribution",
  "MatchDistribution",
  "GradientDistribution",
];
const sources = [
  "web/src/project/domain/model.ts",
  "web/src/project/domain/ids.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/objects/emboss.ts",
];
const result = {
  schemaVersion: 1,
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  })),
  records: Object.fromEntries(required.map((name) => [name, records[name]])),
  literals,
  factories,
  cases,
  edits,
  resourceCase,
};
const file = new URL(
  "testdata/cross-platform/project-model-vectors.json",
  root,
);
const output = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(file, output);
else
  assert.equal(
    readFileSync(file, "utf8"),
    output,
    "project model fixture drift",
  );
console.log(
  `Project model references: ${cases.length} full states, ${factories.length} factories, ${required.length} record layouts`,
);
