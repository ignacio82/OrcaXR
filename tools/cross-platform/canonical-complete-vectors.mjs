// Complete production browser canonical import is the independent authority.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import {
  readSafeZip,
  writeDeterministicZip,
} from "../../web/src/project/serialization/deterministicZip.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { contentDigest } from "../../web/src/project/assets.ts";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root));
const path = "Metadata/orcaxr/project-v1.json",
  enc = new TextEncoder(),
  dec = new TextDecoder();
const serializer = new Bbs3mfProjectSerializer(),
  cases = [];
const stage = JSON.parse(
  read("testdata/cross-platform/canonical-archive-vectors.json"),
);
const base = Buffer.from(
  stage.cases.find((c) => c.name === "current").archiveHex,
  "hex",
);
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
async function add(name, bytes) {
  let expected = null;
  try {
    const opened = await serializer.deserialize(bytes);
    expected = {
      stateJson: canonicalStringify(opened.state),
      warnings: (opened.warnings ?? []).map(units),
      assets: opened.assets.map((a) => ({
        id: units(a.descriptor.id),
        descriptorJson: canonicalStringify(a.descriptor),
        bytesHex: Buffer.from(a.bytes).toString("hex"),
      })),
    };
  } catch {
    /* Independent refusal. */
  }
  cases.push({
    name,
    archiveHex: Buffer.from(bytes).toString("hex"),
    expected,
  });
}
async function edit(name, fn) {
  const files = readSafeZip(base),
    envelope = JSON.parse(dec.decode(files.get(path)));
  fn(envelope, files);
  files.set(path, enc.encode(JSON.stringify(envelope)));
  await add(name, writeDeterministicZip(files));
}
for (const c of stage.cases)
  await add(`stage/${c.name}`, Buffer.from(c.archiveHex, "hex"));
// Feed complete canonical state even when its standard BBS projection cannot be
// regenerated. Import must either preserve the allowed coordinate fallback or
// refuse the same invalid projection as the production browser.
for (const source of ["bbs-metadata", "bbs-settings"]) {
  const rows = JSON.parse(
    read(`testdata/cross-platform/${source}-vectors.json`),
  ).cases;
  for (const row of rows.filter(
    (r) =>
      !r.name.startsWith("core-") &&
      !/^(vector-fallback-|reset-declaration-|exact-random-pattern-)/.test(
        r.name,
      ),
  )) {
    const files = readSafeZip(base),
      envelope = JSON.parse(dec.decode(files.get(path)));
    envelope.state = JSON.parse(row.stateJson);
    envelope.assetEntries = [];
    const payloads = new Map();
    for (const [i, asset] of row.assets.entries()) {
      const d = JSON.parse(asset.descriptorJson),
        bytes = Uint8Array.from(asset.bytes),
        name = `Metadata/orcaxr/input-${i}.bin`;
      envelope.assetEntries.push({ assetId: d.id, path: name });
      files.set(name, bytes);
      payloads.set(d.id, bytes);
    }
    for (const blob of envelope.state.extensionBlobs)
      if (payloads.has(blob.assetId))
        files.set(blob.path, payloads.get(blob.assetId));
    files.set(path, enc.encode(JSON.stringify(envelope)));
    await add(`projection/${source}/${row.name}`, writeDeterministicZip(files));
  }
}
for (const name of [
  "Metadata/project_settings.config",
  "Metadata/model_settings.config",
  "Metadata/layer_config_ranges.xml",
  "Metadata/custom_gcode_per_layer.xml",
]) {
  await edit(`changed/${name}`, (_, f) =>
    f.set(name, enc.encode("externally changed private metadata")),
  );
  await edit(`empty/${name}`, (_, f) => f.set(name, new Uint8Array()));
  await edit(`absent/${name}`, (_, f) => f.delete(name));
}
await edit("unowned-order-media", (_, f) => {
  for (const name of [
    "unknown/Z.bin",
    "unknown/a.JSON",
    "unknown/é.xml",
    "unknown/😀.txt",
    "unknown/\ue000.config",
    "unknown/file.webp",
    "unknown/file.gcode",
    "__proto__",
    "\ufeffa.bin",
  ])
    f.set(name, enc.encode(name));
});
await edit("missing-content-types", (_, f) => f.delete("[Content_Types].xml"));
await edit("missing-opc-target", (_, f) =>
  f.set(
    "_rels/.rels",
    enc.encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="missing" Type="private" Target="absent.bin"/></Relationships>',
    ),
  ),
);
await edit("discard-broken-core-projection", (_, f) =>
  f.set("3D/3dmodel.model", enc.encode("unparseable foreign model")),
);
function multi(e) {
  const first = e.state.plates[0],
    second = structuredClone(first);
  second.id = "import:complete:second-plate";
  second.order = 1;
  second.objects.forEach((o, i) => {
    o.id = `import:complete:object-${i}`;
    o.volumes.forEach((v, j) => (v.id = `import:complete:volume-${i}-${j}`));
    o.instances.forEach(
      (v, j) => (v.id = `import:complete:instance-${i}-${j}`),
    );
    o.layerRanges.forEach((v, j) => (v.id = `import:complete:range-${i}-${j}`));
  });
  e.state.plates.push(second);
  delete e.state.config.printable_area;
  if (e.state.settingsBaseConfig)
    delete e.state.settingsBaseConfig.printable_area;
  if (e.state.settingsOverrides)
    delete e.state.settingsOverrides.printable_area;
}
await edit("unresolved-plate-origin", multi);
for (const drawPath of [
  "Metadata/model_settings.config",
  "../private.svg",
  "valid.svg",
])
  await edit(`unresolved-origin-svg-${drawPath}`, (e, f) => {
    multi(e);
    const id = "import:complete:drawing",
      bytes = enc.encode("<svg/>");
    e.state.sourceAssets.push({
      id,
      kind: "extension",
      digest: contentDigest(bytes),
      byteLength: bytes.length,
      mediaType: "image/svg+xml",
    });
    e.assetEntries.push({
      assetId: id,
      path: "Metadata/orcaxr/assets/drawing.bin",
    });
    f.set("Metadata/orcaxr/assets/drawing.bin", bytes);
    e.state.plates[0].objects[0].volumes[0].embossSvg = {
      drawingAssetId: id,
      pathIn3mf: drawPath,
      depthMm: 1,
      useSurface: false,
      widthMm: 10,
    };
  });
for (const key of ["depthMm", "useSurface", "widthMm"])
  await edit(`unresolved-origin-missing-svg-${key}`, (e) => {
    multi(e);
    const svg = {
      drawingAssetId: e.state.sourceAssets[0].id,
      pathIn3mf: "valid.svg",
      depthMm: 1,
      useSurface: false,
      widthMm: 10,
    };
    delete svg[key];
    e.state.plates[0].objects[0].volumes[0].embossSvg = svg;
  });
for (const [width, height] of [
  [1, 2],
  [100000, 100000],
  [0, 2],
  [100001, 1],
]) {
  for (const name of [
    "Metadata/plate_1.png",
    "metadata/PLATE_0001.PNG",
    "Metadata/plate_2.png",
  ])
    await edit(`thumbnail-${name}-${width}-${height}`, (_, f) => {
      const bytes = new Uint8Array(24);
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
      const v = new DataView(bytes.buffer);
      v.setUint32(16, width);
      v.setUint32(20, height);
      f.set(name, bytes);
    });
}
await edit("thumbnail-false-signature", (_, f) =>
  f.set("Metadata/plate_1.png", new Uint8Array(24)),
);
await edit("thumbnail-short", (_, f) =>
  f.set(
    "Metadata/plate_1.png",
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  ),
);
const paths = [
  "tools/cross-platform/canonical-complete-vectors.mjs",
  "testdata/cross-platform/canonical-archive-vectors.json",
  "testdata/cross-platform/bbs-metadata-vectors.json",
  "testdata/cross-platform/bbs-settings-vectors.json",
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/serialization/opcPackage.ts",
  "web/src/project/serialization/CanonicalEnvelope.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/assets.ts",
];
const sources = Object.fromEntries(
  paths.map((p) => [p, createHash("sha256").update(read(p)).digest("hex")]),
);
const output = JSON.stringify({ version: 1, sources, cases }, null, 2) + "\n";
const target = new URL(
  "testdata/cross-platform/canonical-complete-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(target, output);
else
  assert.equal(
    readFileSync(target, "utf8"),
    output,
    "Regenerate complete canonical import vectors",
  );
assert(cases.find((c) => c.name === "unresolved-plate-origin").expected);
assert(
  !cases.find((c) => c.name === "unresolved-origin-svg-../private.svg")
    .expected,
);
assert(
  cases.find((c) => c.name === "unresolved-origin-svg-valid.svg").expected,
);
for (const key of ["depthMm", "useSurface", "widthMm"])
  assert(
    !cases.find((c) => c.name === `unresolved-origin-missing-svg-${key}`)
      .expected,
  );
console.log(
  `Verified ${cases.length} complete canonical browser imports (${cases.filter((c) => c.expected).length} accepted)`,
);
