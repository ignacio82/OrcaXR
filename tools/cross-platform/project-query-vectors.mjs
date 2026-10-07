// Independent expectations read the production TypeScript model/selectors and
// object-tree ordering. No native implementation participates in generation.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  canonicalStringify,
  compareCanonicalText,
  cloneJson,
} from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { resolveFilament } from "../../web/src/project/domain/selectors.ts";
import { projectObjectsTree } from "../../web/src/project/objects/projection.ts";
const root = new URL("../../", import.meta.url);
process.env.TZ = "UTC";
const read = (path) => readFileSync(new URL(path, root), "utf8");
const layout = JSON.parse(read("contracts/project-query.json"));
const texts = [],
  textIds = new Map();
const units = (text) => {
  if (text === undefined) return null;
  if (!textIds.has(text)) {
    textIds.set(text, texts.length);
    texts.push(
      Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)),
    );
  }
  return textIds.get(text);
};
const values = [];
const model = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
);
for (const c of [...model.factories, ...model.cases])
  values.push({ name: c.name ?? `factory-${c.seed}`, stateJson: c.stateJson });
const sessions = JSON.parse(
  read("testdata/cross-platform/project-session-vectors.json"),
);
sessions.contents.forEach((stateJson, i) =>
  values.push({ name: `session-${i}`, stateJson }),
);
const validation = JSON.parse(
  read("testdata/cross-platform/project-validation-vectors.json"),
);
for (const c of validation.cases)
  if (!c.issues.length)
    values.push({ name: `admitted-${c.name}`, stateJson: c.stateJson });
const base = JSON.parse(
  validation.cases.find((c) => c.name === "base").stateJson,
);
const authored = (name, edit) => {
  const s = cloneJson(base);
  edit(s);
  values.push({ name: `authored/${name}`, stateJson: canonicalStringify(s) });
};
authored("large-utf16-text", (s) => {
  s.name = "X".repeat(20000) + "\0\ud800\udfff";
  s.plates[0].objects[0].instances[0].name = "";
});
authored("sorted-wide-list", (s) => {
  s.plates = Array.from({ length: 137 }, (_, i) => ({
    ...s.plates[0],
    id: `import:query-plate:${i}`,
    order: 136 - i,
    name: `Plate ${i}`,
    objects: [],
  }));
  s.activePlateId = s.plates[75].id;
  s.thumbnails = [];
  s.customGcode = [];
});
authored("descriptor-retains-authored-fractions", (s) => {
  const mesh = s.sourceAssets[0].mesh;
  mesh.positions.byteOffset = 0.25;
  mesh.positions.byteLength -= 0.25;
  mesh.positions.byteStride = -0.125;
});
authored("unicode-id-and-field-absence", (s) => {
  const p = s.plates[0];
  p.id = "import:plate:\ud800\0\udfff";
  s.activePlateId = p.id;
  for (const entry of [...s.thumbnails, ...s.customGcode])
    if (entry.plateId !== undefined) entry.plateId = p.id;
  const o = p.objects[0];
  delete o.filamentId;
  delete o.instances[0].name;
  o.volumes[0].name = "\udfff\0";
});
authored("inherited-filament-and-disabled-instance", (s) => {
  const o = s.plates[0].objects[0];
  o.filamentId = s.filaments.physical[0].id;
  for (const v of o.volumes) delete v.filamentId;
  s.plates[0].printable = false;
  o.instances[0].printable = true;
});
const kindNames = Object.keys(layout.nodes),
  fields = Object.keys(layout.numbers);
function project(state) {
  let browserTree;
  try {
    browserTree = projectObjectsTree(state);
  } catch (e) {
    if (!(e instanceof URIError)) throw e;
  }
  const nodes = [];
  function visit(kind, v, path = [], plate, object) {
    const n = {},
      t = {},
      children = {};
    const settings = () => {
      n.settingsCount = Object.keys(v.config).length;
    };
    const transform = () => {
      [
        ...v.transform.translationMm,
        ...v.transform.rotation,
        ...v.transform.scale,
      ].forEach(
        (x, i) =>
          (n[["tx", "ty", "tz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"][i]] =
            x),
      );
    };
    t.id = v.id;
    if ("name" in v) t.name = v.name;
    switch (kind) {
      case "project":
        settings();
        Object.assign(n, {
          toolCount: v.printer.toolCount,
          plateCount: v.plates.length,
          physicalCount: v.filaments.physical.length,
          mixedCount: v.filaments.mixed.length,
          assetCount: v.sourceAssets.length,
        });
        Object.assign(t, {
          profileId: v.printer.profileId,
          profileHash: v.printer.profileHash,
        });
        children.plates = [...v.plates].sort(
          (a, b) => a.order - b.order || compareCanonicalText(a.id, b.id),
        );
        children.physicalFilaments = v.filaments.physical;
        children.mixedFilaments = v.filaments.mixed;
        children.sourceAssets = v.sourceAssets;
        if (browserTree)
          assert.deepEqual(
            children.plates.map((p) => `plate:${p.id}`),
            [...browserTree.rootKeys],
          );
        break;
      case "plate":
        settings();
        Object.assign(n, {
          order: v.order,
          printable: +v.printable,
          active: +(v.id === state.activePlateId),
          objectCount: v.objects.length,
        });
        children.objects = v.objects;
        plate = v;
        break;
      case "object":
        settings();
        Object.assign(n, {
          volumeCount: v.volumes.length,
          instanceCount: v.instances.length,
          rangeCount: v.layerRanges.length,
        });
        t.localFilamentId = v.filamentId;
        t.effectiveFilamentId = resolveFilament(v).effective;
        children.volumes = v.volumes;
        children.instances = v.instances;
        children.layerRanges = [...v.layerRanges].sort(
          (a, b) => a.minZMm - b.minZMm || compareCanonicalText(a.id, b.id),
        );
        object = v;
        if (browserTree)
          assert.deepEqual(
            children.layerRanges.map((r) => `layer-range:${r.id}`),
            [...browserTree.rowsByKey.get(`layer-group:${v.id}`).childrenKeys],
          );
        break;
      case "volume":
        settings();
        transform();
        Object.assign(n, {
          role: layout.numbers.role.indexOf(v.role),
          triangleCount: v.source.triangleCount,
          topologyRevision: v.source.topologyRevision,
        });
        Object.assign(t, {
          localFilamentId: v.filamentId,
          effectiveFilamentId: resolveFilament(object, v).effective,
          assetId: v.source.assetId,
        });
        break;
      case "instance":
        transform();
        Object.assign(n, {
          printable: +v.printable,
          effectivePrintable: +(plate.printable && v.printable),
        });
        t.effectiveFilamentId = object.filamentId;
        break;
      case "layerRange":
        settings();
        Object.assign(n, { minZMm: v.minZMm, maxZMm: v.maxZMm });
        Object.assign(t, {
          localFilamentId: v.filamentId,
          effectiveFilamentId: resolveFilament(object, v).effective,
        });
        break;
      case "physicalFilament":
        settings();
        Object.assign(n, { toolId: v.toolId, enabled: +v.enabled });
        if (v.nozzleDiameterMm !== undefined)
          n.nozzleDiameterMm = v.nozzleDiameterMm;
        Object.assign(t, {
          color: v.color,
          material: v.material,
          profileId: v.presetId,
          profileHash: v.presetHash,
        });
        break;
      case "mixedFilament":
        settings();
        Object.assign(n, {
          enabled: +v.enabled,
          componentCount: v.components.length,
        });
        t.color = v.displayColor;
        break;
      case "asset":
        Object.assign(n, {
          assetKind: layout.numbers.assetKind.indexOf(v.kind),
          byteLength: v.byteLength,
        });
        Object.assign(t, {
          filename: v.sourceFilename,
          mediaType: v.mediaType,
          digest: v.digest,
        });
        if (v.mesh) {
          n.triangleCount = v.mesh.triangleCount;
          for (const prefix of ["positions", "indices"]) {
            const view = v.mesh[prefix];
            if (!view) continue;
            for (const [field, property] of [
              ["Offset", "byteOffset"],
              ["Length", "byteLength"],
              ["Components", "componentCount"],
              ["Count", "count"],
              ["Stride", "byteStride"],
            ])
              if (view[property] !== undefined)
                n[prefix + field] = view[property];
            n[prefix + "Type"] = layout.numbers[prefix + "Type"].indexOf(
              view.componentType,
            );
          }
        }
        break;
      default:
        throw Error("unknown reference kind");
    }
    const packet = [layout.version, kindNames.indexOf(kind)];
    for (const key of Object.keys(n).sort(
      (a, b) => fields.indexOf(a) - fields.indexOf(b),
    )) {
      assert.ok(fields.includes(key));
      packet.push(fields.indexOf(key), n[key]);
    }
    const texts = Object.fromEntries(
      layout.nodes[kind].texts.map((f) => [f, units(t[f])]),
    );
    nodes.push({
      path,
      kind,
      values: n,
      packet,
      texts,
      children: Object.fromEntries(
        Object.entries(children).map(([key, v]) => [key, v.length]),
      ),
    });
    for (const [relation, members] of Object.entries(children))
      members.forEach((item, i) =>
        visit(
          layout.relations[relation][1],
          item,
          [...path, relation, i],
          plate,
          object,
        ),
      );
  }
  visit("project", state);
  return nodes;
}
const cases = [],
  seen = new Set();
for (const c of values) {
  const state = JSON.parse(c.stateJson);
  const issues = validateProjectState(state);
  if (issues.some((i) => i.severity === "error")) {
    assert.ok(
      !c.name.startsWith("authored/"),
      `${c.name}: ${JSON.stringify(issues)}`,
    );
    continue;
  }
  const stateJson = canonicalStringify(state);
  if (seen.has(stateJson)) continue;
  seen.add(stateJson);
  cases.push({ name: c.name, stateJson, nodes: project(state) });
}
const paths = [
  "contracts/project-query.json",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/validation.ts",
  "web/src/project/objects/projection.ts",
  "testdata/cross-platform/project-model-vectors.json",
  "testdata/cross-platform/project-session-vectors.json",
  "testdata/cross-platform/project-validation-vectors.json",
  "tools/cross-platform/project-query-vectors.mjs",
];
const assets = [
  ...new Map(
    sessions.traces.map((t) => [
      JSON.parse(t.asset.descriptorJson).digest,
      t.asset.bytes,
    ]),
  ).entries(),
].map(([digest, bytes]) => ({ digest, bytes }));
const result = {
  schemaVersion: 1,
  sources: Object.fromEntries(
    paths.map((p) => [p, createHash("sha256").update(read(p)).digest("hex")]),
  ),
  texts,
  assets,
  cases,
};
const output = JSON.stringify(result, null, 2) + "\n",
  target = new URL("testdata/cross-platform/project-query-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else
  assert.equal(
    readFileSync(target, "utf8"),
    output,
    "Regenerate project query vectors",
  );
console.log(
  `Verified ${cases.length} project read captures / ${cases.reduce((sum, c) => sum + c.nodes.length, 0)} nodes`,
);
