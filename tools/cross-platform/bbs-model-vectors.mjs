// Exact complete core-model XML from the production browser archive projection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildBbsCore,
  CORE_MODEL_PATH,
} from "../../web/src/project/serialization/bbsCore.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { contentDigest } from "../../web/src/project/assets.ts";
const root = new URL("../../", import.meta.url),
  ns = "https://orcaxr.martinez.fyi/3mf/project/1";
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const keys = Object.fromEntries(
  ["object", "component", "build", "facet"].map((v) => [
    v,
    `${ns}/core-${v}-attributes`,
  ]),
);
const attr = (namespace, name, value) => ({ namespace, name, value });
const cases = [];
function add(name, edit = () => {}) {
  const f = createProjectFixture();
  const state = cloneProjectState(f.state);
  let assets = [
    {
      descriptor: JSON.parse(canonicalStringify(f.asset.descriptor)),
      bytes: f.asset.bytes.slice(),
    },
  ];
  const object = state.plates[0].objects[0],
    volume = object.volumes[0];
  const c = {
    state,
    object,
    volume,
    assets,
    replaceMesh(positions, indices) {
      const p = encodeIndexedMeshAsset({
        id: volume.source.assetId,
        positions,
        indices,
      });
      state.sourceAssets = [p.descriptor];
      assets.splice(0, assets.length, p);
      volume.source.triangleCount = p.descriptor.mesh.triangleCount;
      volume.annotations = emptyFacetAnnotations(0);
    },
  };
  edit(c);
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
    row.xml = new TextDecoder().decode(result.files.get(CORE_MODEL_PATH));
    row.browserWarnings = result.warnings;
  } catch (e) {
    row.error = e.message;
  }
  cases.push(row);
}
add("basic");
add("empty", (c) => (c.state.plates[0].objects = []));
add("missing-mesh", (c) => (c.assets.length = 0));
add("invalid-mesh", (c) => {
  new DataView(c.assets[0].bytes.buffer).setFloat32(0, NaN, true);
  c.assets[0].descriptor.digest = contentDigest(c.assets[0].bytes);
  c.state.sourceAssets[0] = c.assets[0].descriptor;
});
for (const color of [
  "abcdef",
  "#aabbccdd",
  "  #Aa1234\ufeff",
  "bad",
  "",
  "#abc",
  "\u0085abcdef",
  "\u2003abcdef\u2028",
])
  add(`color-${cases.length}`, (c) => {
    c.state.filaments.physical[0].color = color;
    c.state.filaments.mixed[0].displayColor = color;
  });
add("xml-text", (c) => {
  c.state.name = `Title <&>'"😀`;
  c.object.name = "Name & <x>";
  c.volume.name = '"quoted"\npart';
  c.state.filaments.mixed[0].name = "Материал & 混合";
});
add(
  "disabled-physical-included",
  (c) => (c.state.filaments.physical[0].enabled = false),
);
add("disabled-mixed", (c) => {
  c.state.filaments.mixed[0].enabled = false;
  c.volume.filamentId = c.state.filaments.mixed[0].id;
});
add("no-materials", (c) => {
  delete c.object.filamentId;
  c.volume.annotations = emptyFacetAnnotations(0);
  c.state.filaments = { physical: [], mixed: [] };
});
for (let count of [2, 3, 4, 5, 9, 10])
  for (const bed of [
    ["0x0", "250x200"],
    "-5x-10,245x190",
    "0x0;250x200",
    "0x0, .25 x 2.",
    undefined,
    ["+0x0", "250x200"],
    ["0e0x0", "250x200"],
  ])
    add(`plates-${count}-${cases.length}`, (c) => {
      if (bed !== undefined) c.state.config.printable_area = bed;
      for (let i = 1; i < count; i++) {
        const p = structuredClone(c.state.plates[0]);
        p.id = `import:plate:${i}`;
        p.order = count - i;
        p.objects[0].id = `import:object:${i}`;
        p.objects[0].volumes[0].id = `import:volume:${i}`;
        p.objects[0].instances[0].id = `import:instance:${i}`;
        p.objects[0].layerRanges = [];
        p.objects[0].instances[0].transform.translationMm = [i * 3, i * 5, i];
        p.printable = i % 2 === 0;
        c.state.plates.push(p);
      }
    });
add("empty-extra-plates-no-bed", (c) => {
  c.state.plates.push({
    ...structuredClone(c.state.plates[0]),
    id: "import:plate:empty",
    order: 1,
    objects: [],
  });
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
    v.id = "import:volume:role";
    v.role = role;
    v.annotations = emptyFacetAnnotations(0);
    c.object.volumes.push(v);
  });
add("shared-mesh-components", (c) => {
  for (let i = 0; i < 4; i++) {
    const v = structuredClone(c.volume);
    v.id = `import:volume:copy${i}`;
    v.transform.scale = [i % 2 ? -1 : 1, 2, 3];
    v.transform.rotation = [i + 0.1, 2, 3, 4];
    v.transform.translationMm = [i, i * 2, i * 3];
    c.object.volumes.push(v);
  }
  for (let i = 0; i < 4; i++) {
    const v = structuredClone(c.object.instances[0]);
    v.id = `import:instance:copy${i}`;
    v.transform.translationMm = [i * 20, -i * 12, 3];
    v.printable = i % 2 === 0;
    c.object.instances.push(v);
  }
});
for (const indices of [undefined, [0, 1, 2, 2, 1, 0], []])
  add(`packed-${cases.length}`, (c) =>
    c.replaceMesh([0, -0, 1 / 3, -25.7756138, 1e-29, 1e27, 4, 5, 6], indices),
  );
const leaf = (value) =>
  value === null
    ? { kind: "leaf", state: { kind: "unpainted" } }
    : { kind: "leaf", state: { kind: "assigned", value } };
const refined = (triangleCount, values) => ({
  version: 2,
  triangleCount,
  splits: [
    {
      triangle: 0,
      node: {
        kind: "split",
        splitSides: values.length - 1,
        specialSide: values.length === 4 ? 0 : 2,
        children: values.map(leaf),
      },
    },
  ],
});
for (const channel of ["color", "support", "seam", "fuzzySkin", "brim"]) {
  add(`whole-${channel}`, (c) => {
    c.volume.annotations = emptyFacetAnnotations(0);
    c.volume.annotations[channel] = [
      {
        triangles: [0],
        value:
          channel === "color"
            ? c.state.filaments.physical[1].id
            : channel === "support"
              ? "block"
              : channel === "seam"
                ? "avoid"
                : true,
      },
    ];
  });
  add(`split-${channel}`, (c) => {
    c.volume.annotations = emptyFacetAnnotations(0);
    c.volume.annotations.refinement = {
      [channel]: refined(1, [
        channel === "color"
          ? c.state.filaments.physical[1].id
          : channel === "support"
            ? "enforce"
            : channel === "seam"
              ? "prefer"
              : true,
        null,
      ]),
    };
  });
}
add("all-paint-channels", (c) => {
  c.volume.annotations.support = [{ triangles: [0], value: "enforce" }];
  c.volume.annotations.seam = [{ triangles: [0], value: "avoid" }];
  c.volume.annotations.fuzzySkin = [{ triangles: [0], value: true }];
  c.volume.annotations.brim = [{ triangles: [0], value: false }];
});
for (const total of [64, 65, 68])
  add(`material-states-${total}`, (c) => {
    const first = c.state.filaments.mixed[0];
    for (let i = 1; i < total - 2; i++)
      c.state.filaments.mixed.push({
        ...structuredClone(first),
        id: `import:mixed:${i}`,
        name: `Mix ${i}`,
      });
    c.volume.annotations = emptyFacetAnnotations(0);
    c.volume.annotations.refinement = {
      color: refined(1, [
        c.state.filaments.physical[0].id,
        c.state.filaments.mixed.at(-1).id,
      ]),
    };
  });
add("disabled-refined-root", (c) => {
  c.state.filaments.mixed[0].enabled = false;
  c.volume.annotations = emptyFacetAnnotations(0);
  c.volume.annotations.refinement = {
    color: refined(1, [
      c.state.filaments.physical[0].id,
      c.state.filaments.mixed[0].id,
    ]),
  };
});
for (const location of ["object", "volume", "component", "build", "facet"])
  add(`extensions-${location}`, (c) => {
    const entries = [
      attr("urn:z", "last", "Z&"),
      attr("urn:a", "first", "😀"),
      attr("", "unqualified", "v"),
      attr(ns, "user", "ox"),
      attr("urn:𐀀", "astral", "<"),
      attr("urn:\ue000", "bmp", ">"),
    ];
    if (location === "facet")
      c.volume.extensionData = {
        [keys.facet]: [{ triangle: 0, attributes: entries }],
      };
    else if (location === "build")
      c.object.instances[0].extensionData = { [keys.build]: entries };
    else if (location === "object")
      c.object.extensionData = { [keys.object]: entries };
    else
      c.volume.extensionData = {
        [keys[location === "volume" ? "object" : "component"]]: entries,
      };
  });
add("many-namespaces-prefix-order", (c) => {
  c.volume.extensionData = {
    [keys.object]: Array.from({ length: 13 }, (_, i) =>
      attr(`urn:${String(i).padStart(2, "0")}`, "v", String(i)),
    ),
  };
});
add("reserved-ignored", (c) => {
  c.volume.extensionData = {
    [keys.object]: ["id", "name", "type", "pid", "pindex"]
      .map((n) => attr("", n, "\0"))
      .concat([attr(ns, "stable-id", "\0")]),
    [keys.facet]: [
      {
        triangle: 0,
        attributes: [
          "v1",
          "v2",
          "v3",
          "paint_color",
          "paint_supports",
          "paint_seam",
          "paint_fuzzy_skin",
          "paint_fuzzy",
        ].map((n) => attr("", n, "\0")),
      },
    ],
  };
});
add("facet-duplicate-last-wins", (c) => {
  c.volume.extensionData = {
    [keys.facet]: [
      {
        triangle: 0,
        attributes: [attr("urn:x", "value", "old"), attr("", "v", "first")],
      },
      {
        triangle: 0,
        attributes: [attr("urn:x", "value", "new"), attr("", "v", "last")],
      },
    ],
  };
});
add("facet-duplicate-invalid-earlier", (c) => {
  c.volume.extensionData = {
    [keys.facet]: [
      { triangle: 0, attributes: [attr("", "v", "\0"), attr("", "v", "safe")] },
    ],
  };
});
for (const key of [keys.object, keys.component, keys.build])
  add(`duplicate-${key}`, (c) => {
    const data = { [key]: [attr("urn:x", "v", "1"), attr("urn:x", "v", "2")] };
    if (key === keys.build) c.object.instances[0].extensionData = data;
    else c.volume.extensionData = data;
  });
for (const bad of [
  null,
  {},
  42,
  [null],
  [{}],
  [attr("", "1bad", "v")],
  [attr("", "α", "v")],
  [attr("", "a:b", "v")],
  [attr("", "a", "\0")],
  [attr("\0", "a", "v")],
  [attr("", "a", "\ud800")],
])
  add(
    `bad-attribute-${cases.length}`,
    (c) => (c.volume.extensionData = { [keys.object]: bad }),
  );
for (const bad of [
  null,
  {},
  [{ triangle: -1 }],
  [{ triangle: 1 }],
  [{ triangle: 0.5 }],
  [{ triangle: 0, attributes: null }],
  [{}],
])
  add(
    `bad-facet-${cases.length}`,
    (c) => (c.volume.extensionData = { [keys.facet]: bad }),
  );
add("omitted-invalid-value-not-rendered", (c) => {
  c.assets.length = 0;
  c.volume.extensionData = { [keys.object]: [attr("", "a", "\0")] };
  c.object.extensionData = { [keys.object]: [attr("", "a", "\0")] };
});
let seed = 0xaac0123;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
for (let i = 0; i < 96; i++)
  add(`random-mesh-transform-${i}`, (c) => {
    const pos = Array.from({ length: 9 * ((i % 5) + 1) }, () =>
      Math.fround((random() - 0.5) * 2 ** Math.floor(random() * 100 - 50)),
    );
    c.replaceMesh(
      pos,
      i % 3
        ? undefined
        : Array.from({ length: 3 * (i % 9) }, () =>
            Math.floor((random() * pos.length) / 3),
          ),
    );
    c.volume.transform.rotation = Array.from(
      { length: 4 },
      () => random() - 0.5,
    );
    c.volume.transform.scale = Array.from(
      { length: 3 },
      () => random() * 8 - 4,
    );
    c.volume.transform.translationMm = Array.from(
      { length: 3 },
      () => random() * 500,
    );
    c.object.instances[0].transform.rotation = Array.from(
      { length: 4 },
      () => random() - 0.5,
    );
    c.object.instances[0].transform.scale = Array.from(
      { length: 3 },
      () => random() * 8 - 4,
    );
    c.object.instances[0].transform.translationMm = Array.from(
      { length: 3 },
      () => random() * 500,
    );
    c.object.instances[0].printable = i % 2 === 0;
    const count = c.volume.source.triangleCount;
    if (count) {
      c.volume.annotations.color = [
        { triangles: [count - 1], value: c.state.filaments.mixed[0].id },
      ];
      c.volume.extensionData = {
        [keys.facet]: [
          {
            triangle: Math.floor(random() * count),
            attributes: [attr("urn:random", "tag", `case${i}`)],
          },
        ],
      };
    }
  });
add("unsorted-whole-paint", (c) => {
  c.replaceMesh(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2],
  );
  c.volume.annotations.color = [
    { triangles: [4, 0, 2], value: c.state.filaments.physical[0].id },
    { triangles: [3, 1], value: c.state.filaments.mixed[0].id },
  ];
  c.volume.annotations.support = [
    { triangles: [4, 1, 0], value: "block" },
    { triangles: [3, 2], value: "enforce" },
  ];
});
add("mixed-whole-and-refined", (c) => {
  c.replaceMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  c.volume.annotations.color = [
    { triangles: [2, 1], value: c.state.filaments.physical[0].id },
  ];
  c.volume.annotations.refinement = {
    color: refined(3, [
      c.state.filaments.physical[0].id,
      c.state.filaments.physical[1].id,
      null,
      c.state.filaments.mixed[0].id,
    ]),
  };
});
const sources = [
  "tools/cross-platform/bbs-model-vectors.mjs",
  "web/src/project/__tests__/fixtures.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/serialization/bbsNumbers.ts",
  "web/src/project/serialization/bbsXml.ts",
  "web/src/project/serialization/embossTextConfig.ts",
  "web/src/project/serialization/bbsFacetCodec.ts",
  "web/src/project/meshCodec.ts",
  "web/src/project/domain/model.ts",
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
};
const result = JSON.stringify(value, null, 2) + "\n";
const path = new URL("testdata/cross-platform/bbs-model-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, result);
else
  assert.equal(
    readFileSync(path, "utf8"),
    result,
    "BBS core model vectors are stale",
  );
console.log(
  `BBS core model: ${cases.length} cases (${cases.filter((c) => c.xml).length} accepted)`,
);
