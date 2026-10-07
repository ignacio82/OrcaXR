// Independent production-browser expectations for complete native foreign
// 3MF/BBS import. Three sources feed the corpus:
//   1. every package the browser writes for the package-corpus inputs, with its
//      OrcaXR envelope and canonical asset members removed, leaving a standard
//      BBS package exactly as another BBS producer would see it;
//   2. redistributable real Orca/BBS archives already shipped in this repository;
//   3. authored edge cases for metadata members the bulk corpus rarely reaches.
// Expectations are the production serializer's complete Open result. Bulk rows
// carry digests; real and authored rows carry full canonical JSON so a native
// mismatch can be diagnosed without rerunning the browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { canonicalStringify, projectFingerprint } from "../../web/src/project/domain/canonical.ts";
import { readSafeZip, writeDeterministicZip } from "../../web/src/project/serialization/deterministicZip.ts";

const root = new URL("../../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (value) => new TextEncoder().encode(value);
const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
// Well-formed text stays a JSON string; lone surrogates need unit arrays.
const encoded = (text) => (text.isWellFormed() ? text : units(text));

async function expectation(bytes, full) {
  try {
    const opened = await new Bbs3mfProjectSerializer().deserialize(bytes);
    const stateJson = canonicalStringify(opened.state);
    const assets = opened.assets
      .map((asset) => {
        const descriptorJson = canonicalStringify(asset.descriptor);
        return {
          id: asset.descriptor.id,
          ...(full ? { descriptorJson } : { descriptorSha256: sha256(utf8(descriptorJson)) }),
          bytesSha256: sha256(asset.bytes),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      accepted: true,
      ...(full ? { stateJson } : { stateSha256: sha256(utf8(stateJson)) }),
      assets,
      warnings: opened.warnings.map(encoded),
    };
  } catch {
    return { accepted: false };
  }
}
/** A standard BBS package: no OrcaXR envelope or canonical asset members. */
function foreign(bytes) {
  const files = readSafeZip(bytes);
  for (const path of [...files.keys()]) if (path.startsWith("Metadata/orcaxr/")) files.delete(path);
  return writeDeterministicZip(files);
}

const cases = [];
const sources = ["bbs-model", "bbs-metadata", "bbs-settings", "package-input"];
for (const source of sources) {
  const corpus = JSON.parse(readFileSync(new URL(`testdata/cross-platform/${source}-vectors.json`, root), "utf8"));
  for (const [index, input] of corpus.cases.entries()) {
    const state = JSON.parse(input.stateJson);
    const assets = input.assets.map((p) => ({
      descriptor: JSON.parse(p.descriptorJson),
      bytes: new Uint8Array(p.bytes),
    }));
    let saved;
    try {
      saved = await new Bbs3mfProjectSerializer().serialize({
        state,
        assets,
        sourceRevision: 7,
        sourceHash: projectFingerprint(state),
      });
    } catch {
      continue; // The package corpus already covers authoring refusals.
    }
    const bytes = foreign(saved.bytes);
    cases.push({
      name: `${source}/${index}/${input.name}`,
      archiveBase64: Buffer.from(bytes).toString("base64"),
      expected: await expectation(bytes, false),
    });
  }
}

const real = [
  "web/public/models/multicolor_hexagon.3mf",
  "web/public/models/IM-Logo.3mf",
  "web/public/calibration/Orca-LinearFlow.3mf",
  "web/public/calibration/Orca-LinearFlow_fine.3mf",
  "web/public/calibration/flowrate-test-pass1.3mf",
  "web/public/calibration/flowrate-test-pass2.3mf",
  "testdata/parity/fixtures/reference.3mf",
  "testdata/parity/fixtures/mutations/changed-setting.3mf",
  "testdata/parity/fixtures/mutations/missing-mixed-definition.3mf",
  "testdata/parity/fixtures/mutations/missing-paint-facet.3mf",
  "testdata/parity/fixtures/mutations/missing-part-assignment.3mf",
];
for (const path of real) {
  const bytes = new Uint8Array(readFileSync(new URL(path, root)));
  cases.push({ name: `real/${path}`, archivePath: path, archiveSha256: sha256(bytes), expected: await expectation(bytes, true) });
}

// Authored metadata members. Each starts from one ordinary two-plate package.
const coreNs = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const triangle = (id, name) =>
  `<object id="${id}" type="model" name="${name}"><mesh><vertices>` +
  `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>` +
  `</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
const model = (build) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="${coreNs}">` +
  `<metadata name="Title">Authored</metadata><resources>${triangle(1, "One")}${triangle(2, "Two")}</resources>` +
  `<build>${build}</build></model>`;
const twoItems = '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 10 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 252 12 0"/>';
const plates = (extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n` +
  ` <object id="1"><metadata key="name" value="First &amp;amp; one"/><metadata key="extruder" value="2"/>` +
  `<part id="1" subtype="normal_part"><metadata key="name" value="Body"/><metadata key="wall_loops" value="3"/></part>` +
  `<layer_range min_z="0.2" max_z="1.5"><metadata key="extruder" value="1"/><metadata key="sparse_infill_density" value="20%"/></layer_range></object>\n` +
  ` <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Left"/>` +
  `<model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate>\n` +
  ` <plate id="2" name="Right" locked="true"><metadata key="plater_id" value="2"/>` +
  `<model_instance object_id="2" instance_id="0"/></plate>\n${extra}</config>`;
const project = (config) => JSON.stringify({ type: "project", name: "x", version: "2.3.4", ...config });
const bed = { printable_area: ["0x0", "220x0", "220x220", "0x220"], filament_colour: ["#FF0000", "#00ff00cc"] };
const authored = [
  ["two-plates-on-the-virtual-grid", { "3D/3dmodel.model": model(twoItems), "Metadata/model_settings.config": plates(), "Metadata/project_settings.config": project(bed) }],
  ["missing-printable-area", { "3D/3dmodel.model": model(twoItems), "Metadata/model_settings.config": plates(), "Metadata/project_settings.config": project({ filament_colour: ["#FF0000"] }) }],
  ["unassigned-second-item", { "3D/3dmodel.model": model(twoItems), "Metadata/model_settings.config": plates().replace('<model_instance object_id="2" instance_id="0"/>', ""), "Metadata/project_settings.config": project(bed) }],
  ["xml-project-settings-and-scalars", { "3D/3dmodel.model": model(twoItems), "Metadata/model_settings.config": plates(), "Metadata/project_settings.config": `<config><setting key="printable_area" value="0x0,220x0,220x220,0x220"/><setting key="filament_colour" value="#123456;#654321"/><setting key="layer_height" value="0.20"/><setting key="enable_prime_tower" value="1"/><setting key="wipe_tower_x" value=" 15;40"/><setting key="wipe_tower_y" value="20"/><setting key="wipe_tower_filament" value="2"/><setting key="flag" value="true"/><setting key="note" value="&amp;lt;x&amp;gt;"/></config>` }],
  ["layer-members", {
    "3D/3dmodel.model": model(twoItems),
    "Metadata/model_settings.config": plates(),
    "Metadata/project_settings.config": project(bed),
    "Metadata/layer_config_ranges.xml": `<objects><object id="2"><range min_z="1" max_z="2"><option opt_key="extruder">1</option><option opt_key="wall_loops">4</option></range></object></objects>`,
    "Metadata/custom_gcode_per_layer.xml": `<custom_gcodes_per_layer><plate><plate_info id="2"/><layer top_z="0.6" type="0" extruder="2" color="#00FF00"/><layer top_z="1.2" type="1" extra="Swap"/><layer top_z="1.4" gcode="M600"/><layer top_z="-1" type="4" extra="bad"/></plate><plate><plate_info id="9"/><layer top_z="1" type="4" extra="G4 P1"/></plate></custom_gcodes_per_layer>`,
    "Metadata/brim_ear_points.txt": "brim_points_format_version=0\nobject_id=2|1.000000 2.000000 0.000000 1.500000 9 9\nobject_id=7|1 1 1 1\nmalformed\n",
    "Metadata/layer_heights_profile.txt": "object_id=1|0.000000;0.200000;5.000000;0.100000\nobject_id=2|0;0.2\nnot a profile\n",
  }],
  ["full-spectrum-rows", {
    "3D/3dmodel.model": model(twoItems),
    "Metadata/model_settings.config": plates(),
    "Metadata/project_settings.config": project({ ...bed, filament_colour: ["#FF0000", "#00FF00", "#0000FF"], mixed_filament_definitions: "1,2,1,1,50,0,g1/3,w40/60,m1,u77,cm3,r1/0.70/0.30;2,3,1,0,25,12,u77,cm0;1,3,0,1,10,u0;1,9,1,1,50;1,2,1,1,50,121,cm1;" }),
  }],
  ["refuse-ambiguous-and-duplicate-metadata", { "3D/3dmodel.model": model(twoItems), "Metadata/model_settings.config": plates('<object id="1"><metadata key="name" value="again"/></object>'), "Metadata/project_settings.config": project(bed) }],
  ["refuse-unsafe-project-key", { "3D/3dmodel.model": model(twoItems), "Metadata/project_settings.config": '{"nested":{"__proto__":1}}' }],
];
for (const [name, entries] of authored) {
  const bytes = writeDeterministicZip(new Map(Object.entries(entries).map(([path, value]) => [path, utf8(value)])));
  cases.push({ name: `authored/${name}`, archiveBase64: Buffer.from(bytes).toString("base64"), expected: await expectation(bytes, true) });
}

const accepted = cases.filter((c) => c.expected.accepted).length;
const sourceFiles = [
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/filaments/fullSpectrumImport.ts",
  "web/src/project/filaments/manualCyclePattern.ts",
  "web/src/project/serialization/brimEarPoints.ts",
  "web/src/project/serialization/layerHeightsProfile.ts",
  "web/src/project/serialization/embossTextConfig.ts",
  ...sources.map((source) => `testdata/cross-platform/${source}-vectors.json`),
  ...real,
].map((path) => ({ path, sha256: sha256(readFileSync(new URL(path, root))) }));
const header = JSON.stringify({ format: 1, sources: sourceFiles });
// One compact case per line keeps the corpus reviewable as line diffs.
const output = `${header.slice(0, -1)},"cases":[\n${cases.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
const target = new URL("testdata/cross-platform/foreign-import-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "foreign import references are stale; rerun with --write");
console.log(JSON.stringify({ cases: cases.length, accepted, refused: cases.length - accepted }));
