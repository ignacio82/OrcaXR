// Independent production-browser BBS member bytes and six-decimal policies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildBbsCore } from "../../web/src/project/serialization/bbsCore.ts";
import { encodeEmbossShape } from "../../web/src/project/serialization/embossTextConfig.ts";
import { DEFAULT_EMBOSS_FONT_PROPERTY } from "../../web/src/project/objects/emboss.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { contentDigest } from "../../web/src/project/assets.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const paths = [
  "Metadata/model_settings.config",
  "Metadata/layer_config_ranges.xml",
  "Metadata/custom_gcode_per_layer.xml",
  "Metadata/brim_ear_points.txt",
  "Metadata/layer_heights_profile.txt",
];
const cases = [];
function capture(name, state, assets) {
  const issues = validateProjectState(state).filter(
    (i) => i.severity === "error",
  );
  assert.equal(issues.length, 0, `${name}: ${canonicalStringify(issues)}`);
  const row = {
    name,
    stateJson: canonicalStringify(state),
    assets: assets.map((p) => ({
      descriptorJson: canonicalStringify(p.descriptor),
      bytes: Array.from(p.bytes),
    })),
  };
  try {
    const result = buildBbsCore(
      state,
      new Map(assets.map((p) => [p.descriptor.id, p])),
    );
    row.files = Object.fromEntries(
      paths
        .filter((p) => result.files.has(p))
        .map((p) => [p, new TextDecoder().decode(result.files.get(p))]),
    );
    row.drawings = Object.fromEntries(
      [...result.files]
        .filter(([path]) => !paths.includes(path) && path.endsWith(".svg"))
        .map(([path, bytes]) => [path, Array.from(bytes)]),
    );
    row.browserWarnings = result.warnings;
  } catch (e) {
    row.error = e.message;
  }
  cases.push(row);
}
const coreCases = JSON.parse(
  readFileSync(new URL("testdata/cross-platform/bbs-model-vectors.json", root)),
);
for (const row of coreCases.cases.filter((row) => row.xml)) {
  capture(
    `core-${row.name}`,
    JSON.parse(row.stateJson),
    row.assets.map((p) => ({
      descriptor: JSON.parse(p.descriptorJson),
      bytes: Uint8Array.from(p.bytes),
    })),
  );
}
function add(name, edit = () => {}) {
  const f = createProjectFixture(),
    state = cloneProjectState(f.state),
    assets = [
      {
        descriptor: structuredClone(f.asset.descriptor),
        bytes: f.asset.bytes.slice(),
      },
    ];
  const plate = state.plates[0],
    object = plate.objects[0],
    volume = object.volumes[0];
  edit({ state, plate, object, volume, assets });
  capture(name, state, assets);
}
const recipe = () => ({
  text: `Apostrophe ' & <quote>"\n雪😀`,
  styleName: "Style",
  fontDescriptor: "local:font",
  fontDescriptorType: "file_name",
  font: { ...DEFAULT_EMBOSS_FONT_PROPERTY },
  projection: { depthMm: 0.1234565, useSurface: false },
});
const svg = (c, suffix = "one", bytes = new TextEncoder().encode("<svg/>")) => {
  const d = {
    id: `import:asset:svg-${suffix}`,
    kind: "extension",
    digest: contentDigest(bytes),
    byteLength: bytes.length,
    mediaType: "image/svg+xml",
  };
  c.state.sourceAssets.push(d);
  c.assets.push({ descriptor: d, bytes });
  c.volume.embossSvg = {
    pathIn3mf: `Metadata/drawing-${suffix}.svg`,
    drawingAssetId: d.id,
    depthMm: 1.0000005,
    useSurface: true,
    widthMm: 20,
  };
};
add("basic");
for (const path of [
  "3D/3dmodel.model",
  "Metadata/model_settings.config",
  "Metadata/project_settings.config",
  "Metadata/layer_config_ranges.xml",
  "Metadata/custom_gcode_per_layer.xml",
  "Metadata/brim_ear_points.txt",
  "Metadata/layer_heights_profile.txt",
  "3D/_rels/3dmodel.model.rels",
  "Metadata/orcaxr/project-v1.json",
  "[Content_Types].xml",
  "_rels/.rels",
])
  add(`svg-reserved-${path}`, (c) => {
    svg(c);
    c.volume.embossSvg.pathIn3mf = path;
  });
for (const equal of [true, false])
  add(`svg-shared-path-${equal}`, (c) => {
    svg(c);
    const second = structuredClone(c.volume);
    second.id = "import:volume:second-svg";
    c.object.volumes.push(second);
    svg(
      { ...c, volume: second },
      "two",
      new TextEncoder().encode(equal ? "<svg/>" : "<svg>different</svg>"),
    );
    second.embossSvg.pathIn3mf = c.volume.embossSvg.pathIn3mf;
  });
add("all-config-values", (c) => {
  const config = {
    "a&\"'": [
      null,
      false,
      true,
      -0,
      1e-7,
      [1, [2, "<&"]],
      { "𐀀": "😀", "\ue000": "x", lone: "\ud800", nul: "\u0000" },
    ],
    2: "two",
    10: "ten",
    z: null,
    empty: [],
    object: { nested: [true, null, "\n"] },
  };
  Object.assign(c.object.config, config);
  Object.assign(c.volume.config, config);
  Object.assign(c.plate.config, config);
  Object.assign(c.object.layerRanges[0].config, config);
});
add("reserved-and-extruder-precedence", (c) => {
  Object.assign(c.plate.config, {
    plater_id: "\0",
    plater_name: "\0",
    printable: "\0",
    locked: [true, null],
  });
  c.object.config.extruder = 91;
  c.volume.config.extruder = 92;
  c.volume.filamentId = c.state.filaments.physical[1].id;
  Object.assign(c.object.layerRanges[0].config, {
    extruder: 93,
    aaa: 0,
    zzz: 1,
  });
  c.object.layerRanges[0].filamentId = c.state.filaments.physical[1].id;
});
add("disabled-range-retains-config", (c) => {
  c.state.filaments.mixed[0].enabled = false;
  c.object.layerRanges[0].filamentId = c.state.filaments.mixed[0].id;
  c.object.layerRanges[0].config.extruder = 88;
});
for (const locked of [
  undefined,
  null,
  false,
  true,
  0,
  2,
  "",
  "locked",
  { x: 1 },
])
  add(`locked-${cases.length}`, (c) => {
    if (locked !== undefined) c.plate.config.locked = locked;
  });
for (const role of [
  "model",
  "parameter-modifier",
  "negative-volume",
  "support-enforcer",
  "support-blocker",
])
  add(`role-${role}`, (c) => {
    const v = structuredClone(c.volume);
    v.id = `import:volume:${role}`;
    v.role = role;
    v.annotations = emptyFacetAnnotations(0);
    c.object.volumes.push(v);
  });
add("emboss-basic", (c) => {
  c.volume.embossText = recipe();
});
add("emboss-full", (c) => {
  const r = recipe();
  Object.assign(r, {
    family: "字 & Family",
    faceName: "A'B",
    style: "Regular",
    weight: "400",
    fontDescriptorType: "",
  });
  Object.assign(r.font, {
    charGapMm: -0.0000005,
    lineGapMm: 1.005,
    boldnessMm: 0.015625,
    skew: -0.1234565,
    perGlyph: true,
    horizontal: "right",
    vertical: "bottom",
    collection: 2,
  });
  r.projection.useSurface = true;
  c.volume.embossText = r;
});
for (const align of ["left", "center", "right"])
  for (const vertical of ["top", "center", "bottom"])
    add(`emboss-${align}-${vertical}`, (c) => {
      c.volume.embossText = recipe();
      Object.assign(c.volume.embossText.font, { horizontal: align, vertical });
    });
add("emboss-empty-optionals", (c) => {
  c.volume.embossText = {
    ...recipe(),
    family: "",
    faceName: "",
    style: "",
    weight: "",
  };
});
for (const text of [
  "\0",
  "\u0001",
  "\ud800",
  "\udc00",
  "\ufffe",
  "\uffff",
  "\t\r\n",
])
  add(`emboss-character-${cases.length}`, (c) => {
    c.volume.embossText = { ...recipe(), text };
  });
add("svg-present", (c) => {
  svg(c);
  c.volume.embossSvg.sourcePath = `a'\"<&\n.svg`;
});
add("svg-missing", (c) => {
  svg(c);
  c.assets.pop();
});
add("svg-no-source", (c) => {
  svg(c);
  c.volume.embossSvg.sourcePath = "";
});
add("svg-and-text", (c) => {
  svg(c);
  c.volume.embossText = recipe();
});
add("svg-omitted-mesh", (c) => {
  svg(c);
  c.assets.shift();
});
add("svg-shared-path-conflict-original-plate-order", (c) => {
  svg(c);
  const p = structuredClone(c.plate);
  p.id = "import:plate:last";
  p.order = 0;
  c.plate.order = 5;
  p.objects[0].id = "import:object:last";
  p.objects[0].volumes[0].id = "import:volume:last";
  p.objects[0].instances[0].id = "import:instance:last";
  p.objects[0].layerRanges = [];
  const originalPath = c.volume.embossSvg.pathIn3mf;
  svg(
    { ...c, volume: p.objects[0].volumes[0] },
    "two",
    new TextEncoder().encode("<svg>last</svg>"),
  );
  p.objects[0].volumes[0].embossSvg.pathIn3mf = originalPath;
  c.state.plates.push(p);
  c.state.config.printable_area = ["0x0", "200x200"];
});
add("svg-shared-path-missing-source-omits-reference", (c) => {
  svg(c);
  const v = structuredClone(c.volume);
  v.id = "import:volume:svg-other";
  v.embossSvg.drawingAssetId = "import:asset:missing";
  c.object.volumes.push(v);
});
for (const type of [
  "color-change",
  "pause",
  "tool-change",
  "template",
  "custom",
])
  add(`event-${type}`, (c) => {
    c.state.customGcode = [
      {
        id: "import:custom-gcode:event",
        scope: "plate",
        plateId: c.plate.id,
        trigger: "before-layer",
        code: type === "custom" ? `G1 X1\nM117 <go>&'\"` : "",
        layerEvent: {
          type,
          topZMm: 0.000123456789,
          toolIndex: 2,
          color: "#123456",
          message: `Message <&'\"`,
        },
      },
    ];
  });
add("event-order-multiple-plates", (c) => {
  c.state.plates.push({
    ...structuredClone(c.plate),
    id: "import:plate:events",
    order: 4,
    objects: [],
  });
  c.state.customGcode = [10, 2, 8, 4].map((z, index) => ({
    id: `import:custom-gcode:${index}`,
    scope: "plate",
    plateId: c.state.plates[index % 2].id,
    trigger: "before-layer",
    code: "",
    layerEvent: { type: "pause", topZMm: z },
  }));
});
add("non-event-hook-omitted", (c) => {
  c.state.customGcode = [
    {
      id: "import:custom-gcode:hook",
      scope: "project",
      trigger: "before-plate",
      code: "M117 only canonical",
    },
  ];
});
add("range-order-and-omitted-mesh", (c) => {
  c.object.layerRanges.push({
    ...structuredClone(c.object.layerRanges[0]),
    id: "import:layer-range:last",
    minZMm: 10,
    maxZMm: 20,
  });
  c.object.layerRanges.reverse();
  c.assets.length = 0;
});
add("brim-and-heights", (c) => {
  c.object.brimEars = [
    { positionMm: [-0.0000005, 1e21, -0], headFrontRadiusMm: 1.2345675 },
    { positionMm: [1.005, -1.005, 1e-7], headFrontRadiusMm: 0.015625 },
  ];
  c.object.layerHeightProfile = [0, 0.1234565, 5, 0.2000005];
});
for (const profile of [
  [],
  [0, 0.2],
  [0, 0.2, 1],
  [0, 0.2, 1, 0.3, 2],
  [0, 0.2, 10, 0.2],
])
  add(`profile-${profile.length}`, (c) => {
    c.object.layerHeightProfile = profile;
  });
add("all-sidecars-without-mesh", (c) => {
  c.object.brimEars = [{ positionMm: [1, 2, 3], headFrontRadiusMm: 2 }];
  c.object.layerHeightProfile = [0, 0.2, 10, 0.3];
  c.assets.length = 0;
});
for (const where of ["object", "volume", "plate", "range", "event"])
  for (const text of ["\0", "\ud800", "\uffff"])
    add(`illegal-${where}-${cases.length}`, (c) => {
      if (where === "event")
        c.state.customGcode = [
          {
            id: "import:custom-gcode:illegal",
            scope: "plate",
            plateId: c.plate.id,
            trigger: "before-layer",
            code: `M117 ${text}`,
            layerEvent: { type: "custom", topZMm: 1 },
          },
        ];
      else
        (where === "range"
          ? c.object.layerRanges[0]
          : c[where]
        ).config.foreign = text;
    });
let seed = 0x8150ff12;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const binary = new DataView(new ArrayBuffer(8));
const numbers = [];
const addNumber = (value) => {
  if (!Number.isFinite(value)) return;
  binary.setFloat64(0, value, false);
  numbers.push({
    bits: binary.getBigUint64(0, false).toString(16).padStart(16, "0"),
    fixed6: value.toFixed(6),
    emboss: encodeEmbossShape({ depthMm: value, useSurface: false }).match(
      /depth="([^"]*)"/,
    )[1],
  });
};
for (const v of [
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  1e-7,
  -1e-7,
  0.0000005,
  -0.0000005,
  0.015625,
  -0.015625,
  1.005,
  1.2345675,
  1e20,
  1e21,
  1e22,
  Number.MAX_VALUE,
])
  addNumber(v);
for (let i = 0; i < 4096; i++) {
  binary.setUint32(0, random());
  binary.setUint32(4, random());
  addNumber(binary.getFloat64(0));
}
const sources = [
  "tools/cross-platform/bbs-metadata-vectors.mjs",
  "web/src/project/__tests__/fixtures.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/assets.ts",
  "testdata/cross-platform/bbs-model-vectors.json",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/serialization/embossTextConfig.ts",
  "web/src/project/objects/emboss.ts",
  "web/src/project/serialization/brimEarPoints.ts",
  "web/src/project/serialization/layerHeightsProfile.ts",
  "web/src/project/serialization/bbsXml.ts",
  "web/src/project/serialization/bbsNumbers.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/validation.ts",
];
const value = {
  version: 1,
  sources: Object.fromEntries(
    sources.map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(new URL(p, root)))
        .digest("hex"),
    ]),
  ),
  cases,
  numbers,
};
const output = new URL(
    "testdata/cross-platform/bbs-metadata-vectors.json",
    root,
  ),
  bytes = `${JSON.stringify(value, null, 2)}\n`;
if (process.argv.includes("--write")) writeFileSync(output, bytes);
else
  assert.equal(
    readFileSync(output, "utf8"),
    bytes,
    "BBS metadata references are stale",
  );
console.log(
  JSON.stringify({
    cases: cases.length,
    accepted: cases.filter((r) => r.files).length,
    refused: cases.filter((r) => r.error).length,
    numbers: numbers.length,
  }),
);
