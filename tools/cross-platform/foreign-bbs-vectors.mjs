// Independent browser expectations for native foreign-BBS/3MF import.
// This captures actual deterministic ZIP inputs and the production serializer's
// complete result as independent expectations for native structural projection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { writeDeterministicZip } from "../../web/src/project/serialization/deterministicZip.ts";

const root = resolve(import.meta.dirname, "../..");
const coreNs = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const productionNs = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const text = (value) => new TextEncoder().encode(value);
const triangle = (id = 1, name = "Triangle", offset = [0, 0, 0]) =>
  `<object id="${id}" type="model" name="${name}"><mesh><vertices>` +
  `<vertex x="${offset[0]}" y="${offset[1]}" z="${offset[2]}"/>` +
  `<vertex x="${offset[0] + 1}" y="${offset[1]}" z="${offset[2]}"/>` +
  `<vertex x="${offset[0]}" y="${offset[1] + 1}" z="${offset[2]}"/>` +
  `</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
const model = ({ unit = "millimeter", resources, build, namespaces = "", title = "Foreign fixture" }) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xmlns="${coreNs}" ${namespaces}>` +
  `<metadata name="Title">${title}</metadata><resources>${resources}</resources><build>${build}</build></model>`;

function archive(entries) {
  return writeDeterministicZip(new Map(Object.entries(entries).map(([path, value]) => [path, text(value)])));
}

const fixtures = [
  {
    name: "basic-millimeter",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources: triangle(1, "Basic triangle"),
        build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/>',
        title: "Fixture &amp; 🐟",
      }),
      "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#FF0000"] }),
    }),
  },
  {
    name: "legacy-project-settings-xml",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources: triangle(1, "Legacy settings"),
        build: '<item objectid="1"/>',
      }),
      "Metadata/project_settings.config":
        '<config><setting key="filament_colour" value="#00FF00"/>' +
        '<setting key="legacy_enabled" value="true"/></config>',
    }),
  },
  {
    name: "centimeter-unit-and-material",
    bytes: archive({
      "3D/3dmodel.model": model({
        unit: "centimeter",
        resources:
          '<basematerials id="4"><base name="Blue" displaycolor="#2040A0FF"/></basematerials>' +
          triangle(7, "Centimeter part", [1.25, 2.5, 3.75]).replace('<object id="7"', '<object id="7" pid="4" pindex="0"'),
        build: '<item objectid="7" transform="1 0 0 0 1 0 0 0 1 2 3 4" printable="0"/>',
      }),
    }),
  },
  {
    name: "painted-facets-and-refinement",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources:
          '<basematerials id="4"><base name="Red" displaycolor="#FF0000FF"/>' +
          '<base name="Blue" displaycolor="#0000FFFF"/></basematerials>' +
          '<object id="1" type="model" name="Painted" pid="4" pindex="0"><mesh>' +
          '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
          '<vertex x="0" y="1" z="0"/><vertex x="1" y="1" z="0"/></vertices>' +
          '<triangles><triangle v1="0" v2="1" v3="2" paint_color="4" paint_supports="4" paint_seam="8" paint_fuzzy_skin="" paint_fuzzy="4"/>' +
          '<triangle v1="1" v2="3" v3="2" paint_color="841"/></triangles></mesh></object>',
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "internal-component-expansion",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources:
          triangle(1, "Shared leaf") +
          '<object id="10" type="model" name="Assembly"><components>' +
          '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>' +
          '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 3 0"/>' +
          '</components></object>',
        build: '<item objectid="10" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>',
      }),
    }),
  },
  {
    name: "extension-attributes-preserved",
    bytes: archive({
      "3D/3dmodel.model": model({
        namespaces: 'xmlns:fixture="urn:orcaxr:foreign-fixture"',
        resources:
          '<object id="1" type="model" name="Leaf" fixture:object="leaf-value"><mesh>' +
          '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
          '<vertex x="0" y="1" z="0"/></vertices>' +
          '<triangles><triangle v1="0" v2="1" v3="2" fixture:facet="facet-value"/></triangles>' +
          '</mesh></object>' +
          '<object id="10" type="model" name="Assembly"><components>' +
          '<component objectid="1" fixture:component="edge-value"/></components></object>',
        build: '<item objectid="10" fixture:build="build-value"/>',
      }),
    }),
  },
  {
    name: "external-production-part-alias-prefix",
    bytes: archive({
      "3D/3dmodel.model": model({
        namespaces: `xmlns:prod="${productionNs}"`,
        resources:
          triangle(3, "Unreferenced root mesh") +
          '<object id="10" type="model" name="Assembly"><components>' +
          '<component prod:path="/3D/Objects/Leaf.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 4 5 6"/>' +
          '</components></object>',
        build: '<item objectid="10" transform="1 0 0 0 1 0 0 0 1 7 8 9"/>',
      }),
      "3D/Objects/Leaf.model": model({
        resources: triangle(2, "External leaf", [9, 8, 7]),
        build: "",
      }),
    }),
  },
  {
    name: "empty-project",
    bytes: archive({
      "3D/3dmodel.model": model({ resources: "", build: "" }),
    }),
  },
  {
    name: "refuse-unknown-unit",
    bytes: archive({
      "3D/3dmodel.model": model({ unit: "parsec", resources: triangle(), build: '<item objectid="1"/>' }),
    }),
  },
  {
    name: "refuse-duplicate-object-id",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources: triangle(1) + triangle(1, "Duplicate"),
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "refuse-component-cycle",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources:
          '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
          '<object id="2" type="model"><components><component objectid="1"/></components></object>',
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "refuse-missing-component-object",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources: '<object id="1" type="model"><components><component objectid="404"/></components></object>',
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "refuse-missing-production-part",
    bytes: archive({
      "3D/3dmodel.model": model({
        namespaces: `xmlns:prod="${productionNs}"`,
        resources:
          '<object id="1" type="model"><components><component prod:path="/3D/Missing.model" objectid="2"/></components></object>',
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "refuse-invalid-facet-channel-state",
    bytes: archive({
      "3D/3dmodel.model": model({
        resources: triangle().replace(
          '<triangle v1="0" v2="1" v3="2"/>',
          '<triangle v1="0" v2="1" v3="2" paint_supports="C"/>',
        ),
        build: '<item objectid="1"/>',
      }),
    }),
  },
  {
    name: "refuse-dtd",
    bytes: archive({
      "3D/3dmodel.model":
        `<?xml version="1.0"?><!DOCTYPE model [<!ENTITY x "bad">]>` +
        `<model unit="millimeter" xmlns="${coreNs}"><resources/>` +
        `<build/></model>`,
    }),
  },
];

const serializer = new Bbs3mfProjectSerializer();
const cases = [];
for (const fixture of fixtures) {
  const bytes = fixture.bytes;
  const row = {
    name: fixture.name,
    archiveBytesHex: Buffer.from(bytes).toString("hex"),
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const opened = await serializer.deserialize(bytes);
    row.expected = {
      accepted: true,
      stateJson: canonicalStringify(opened.state),
      assets: opened.assets.map((asset) => ({
        descriptorJson: canonicalStringify(asset.descriptor),
        bytesHex: Buffer.from(asset.bytes).toString("hex"),
      })),
      warnings: opened.warnings,
      preserved: opened.state.extensionBlobs.map((blob) => ({
        id: blob.id,
        path: blob.path,
        mediaType: blob.mediaType,
        bytesHex: Buffer.from(blob.bytes).toString("hex"),
      })),
    };
  } catch {
    row.expected = { accepted: false };
  }
  cases.push(row);
}

for (const name of ["basic-millimeter", "legacy-project-settings-xml", "centimeter-unit-and-material", "painted-facets-and-refinement", "internal-component-expansion", "extension-attributes-preserved", "external-production-part-alias-prefix", "empty-project"])
  assert.equal(cases.find((row) => row.name === name)?.expected.accepted, true, `${name} must import`);
for (const name of [
  "refuse-unknown-unit",
  "refuse-duplicate-object-id",
  "refuse-component-cycle",
  "refuse-missing-component-object",
  "refuse-missing-production-part",
  "refuse-invalid-facet-channel-state",
  "refuse-dtd",
])
  assert.equal(cases.find((row) => row.name === name)?.expected.accepted, false, `${name} must refuse`);

const sources = [
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/serialization/bbsXml.ts",
  "web/src/project/serialization/deterministicZip.ts",
].map((path) => ({
  path,
  sha256: createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"),
}));
const output = `${JSON.stringify({ format: 1, sources, cases }, null, 2)}\n`;
const target = resolve(root, "testdata/cross-platform/foreign-bbs-vectors.json");
if (process.argv.slice(2).includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "foreign BBS references are stale; rerun with --write");
console.log(JSON.stringify({ cases: cases.length, accepted: cases.filter((c) => c.expected.accepted).length }));
