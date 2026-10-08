// Settings projection references from the production browser
// (`scopedOverrides.ts`, `settingsOverrides.ts`): every node a scoped edit
// can address, each node's override snapshot, and setting explanations, over
// project states built from the browser's own fixture. Replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import {
  seededRandom,
  UuidIdSource,
} from "../../web/src/project/domain/ids.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { ProjectStore } from "../../web/src/project/store.ts";
import {
  explainScopedSetting,
  scopedOverrideSnapshot,
  scopedOverrideTargets,
} from "../../web/src/project/scopedOverrides.ts";
import { projectSettingsOverrideSnapshot } from "../../web/src/project/settingsOverrides.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

// Three states: the fixture, a fuller scene with foreign keys, unnamed
// nodes, fractional heights and out-of-order plates, and an empty one.
const fixture = createProjectFixture().state;
const ids = new UuidIdSource(seededRandom(0x5e77));
const full = clone(fixture);
full.name = "Sc\u00e8ne \u2014 full";
full.settingsBaseConfig = {
  layer_height: 0.2,
  wall_loops: 2,
  curr_bed_type: "PEI",
};
full.settingsOverrides = {
  layer_height: 0.16,
  curr_bed_type: "Cool Plate",
  sparse_infill_density: 25,
};
full.config = {
  layer_height: 0.16,
  wall_loops: 2,
  curr_bed_type: "Cool Plate",
  sparse_infill_density: 25,
};
full.plates[0].order = 5;
full.plates[0].config = {
  print_sequence: "by object",
  wall_loops: 9,
  layer_height: 0.2,
};
const object = full.plates[0].objects[0];
object.name = "";
object.config = {
  layer_height: 0.18,
  brim_type: "outer_only",
  print_sequence: "by layer",
};
object.volumes.push({
  ...clone(object.volumes[0]),
  id: ids.next("volume"),
  name: "",
  config: { wall_loops: 4, layer_height: 0.1, sparse_infill_density: 30 },
});
object.layerRanges.push({
  id: ids.next("layer-range"),
  minZMm: 5.1,
  maxZMm: 7.300000000000001,
  config: { layer_height: 0.08, brim_type: "no_brim" },
});
const second = {
  ...clone(full.plates[0]),
  id: ids.next("plate"),
  name: "",
  order: 2,
  config: {},
};
second.objects = [
  {
    ...clone(object),
    id: ids.next("object"),
    name: "Second été",
    config: {},
    volumes: [
      { ...clone(object.volumes[0]), id: ids.next("volume"), config: {} },
    ],
    instances: [{ ...clone(object.instances[0]), id: ids.next("instance") }],
    layerRanges: [],
  },
];
full.plates.push(second);
const empty = createProjectFixture({ withObject: false }).state;
empty.plates[0].name = "";

const keys = [
  "layer_height",
  "wall_loops",
  "sparse_infill_density",
  "print_sequence",
  "curr_bed_type",
  "brim_type",
  "not_a_setting",
];
const describe = (target) =>
  ({
    project: undefined,
    plate: target.plateId,
    object: target.objectId,
    part: target.volumeId,
    layerRange: target.layerRangeId,
  })[target.scope];
const states = Object.entries({ fixture, full, empty }).map(([name, state]) => {
  const snapshot = new ProjectStore(state).getSnapshot();
  const targets = scopedOverrideTargets(snapshot.state);
  const unknown = [
    { scope: "plate", plateId: "00000000-0000-4000-8000-000000000001" },
    { scope: "object", objectId: "00000000-0000-4000-8000-000000000002" },
    { scope: "part", volumeId: "00000000-0000-4000-8000-000000000003" },
    { scope: "layerRange", layerRangeId: "import:missing:range" },
  ];
  return {
    name,
    stateJson: json(snapshot.state),
    revision: snapshot.revision,
    hash: snapshot.hash,
    projectJson: json(projectSettingsOverrideSnapshot(snapshot)),
    targets: targets.map((t) => {
      const s = scopedOverrideSnapshot(snapshot, t.target);
      return {
        id: t.id,
        scope: t.scope,
        ...(describe(t.target) !== undefined
          ? { targetId: describe(t.target) }
          : {}),
        label: t.label,
        path: t.path,
        overrideCount: t.overrideCount,
        snapshotJson: json({
          sourceRevision: s.sourceRevision,
          sourceHash: s.sourceHash,
          label: s.label,
          overrides: s.overrides,
          foreign: s.foreign,
          foreignIssues: s.foreignIssues,
          chain: s.chain,
          inheritedConfig: s.inheritedConfig,
          effectiveConfig: s.effectiveConfig,
        }),
        explanationsJson: json(
          keys.map((key) => explainScopedSetting(snapshot, t.target, key)),
        ),
      };
    }),
    unknown: unknown.map((target) => {
      try {
        scopedOverrideSnapshot(snapshot, target);
        throw Error("expected a refusal");
      } catch (error) {
        return {
          scope: target.scope,
          targetId: describe(target),
          message: error.message,
        };
      }
    }),
  };
});

const sources = [
  "tools/cross-platform/settings-projection-vectors.mjs",
  "web/src/project/scopedOverrides.ts",
  "web/src/project/settingsOverrides.ts",
  "web/src/project/domain/settingScopes.ts",
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
      keys,
      states,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/settings-projection-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Settings projection reference drift",
  );
console.log(
  `settings projection: ${states.length} states, ` +
    `${states.reduce((n, s) => n + s.targets.length, 0)} targets, ` +
    `${states.reduce((n, s) => n + s.targets.length * keys.length, 0)} explanations`,
);
