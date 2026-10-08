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
import { createEngineOptionCatalog } from "../../web/src/settings/generated/loader.ts";
import { SettingsDraftEditor } from "../../web/src/settings/editor/SettingsDraftEditor.ts";
import {
  applySettingsCommitToConfig,
  decodeSettingsConfig,
} from "../../web/src/settings/editor/configBridge.ts";
import { guiSurfaceForScope } from "../../web/src/settings/editor/scopedStepper.ts";
import {
  encodeProjectEditorCommitResult,
  encodeProjectEditorEdit,
  encodeProjectEditorEditResult,
  encodeProjectIntent,
  encodeProjectSettingsExplainRequest,
  encodeProjectSettingsExplainResult,
  encodeProjectSettingsSessionRequest,
  encodeProjectSettingsSnapshotResult,
  encodeProjectSettingsTargetPage,
  encodeProjectSettingsTargetPageRequest,
  encodeProjectSettingsTargetRequest,
} from "../../contracts/generated/project-intents.ts";

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

// The host exchange, encoded by the generated TypeScript codecs.
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const wireTarget = (t) =>
  t.scope === "project"
    ? { project: {} }
    : t.scope === "plate"
      ? { plate: { plateId: units(t.plateId) } }
      : t.scope === "object"
        ? { object: { objectId: units(t.objectId) } }
        : t.scope === "part"
          ? { part: { volumeId: units(t.volumeId) } }
          : { layerRange: { layerRangeId: units(t.layerRangeId) } };
const optionalText = (v) =>
  v === undefined ? { absent: {} } : { value: units(v) };
const wireSnapshot = (s) => ({
  snapshot: {
    sourceRevision: s.sourceRevision,
    sourceHash: units(s.sourceHash),
    label: units(s.label),
    overridesJson: units(json(s.overrides)),
    foreignJson: units(json(s.foreign)),
    foreignIssues: s.foreignIssues.map((i) => ({
      code: units(i.code),
      path: units(i.path),
      scope: units(i.scope),
      key: units(i.key),
      message: units(i.message),
    })),
    chain: s.chain.map((c) => ({
      scope: c.scope,
      id: optionalText(c.id),
      label: units(c.label),
      overridesJson: units(json(c.overrides)),
      isTarget: c.isTarget,
    })),
    inheritedConfigJson: units(json(s.inheritedConfig)),
    effectiveConfigJson: units(json(s.effectiveConfig)),
  },
});
const wireExplanation = (e) => ({
  explanation: {
    valueJson:
      e.value === undefined ? { absent: {} } : { value: units(json(e.value)) },
    source: e.source === "base" ? { absent: {} } : { value: e.source },
    sourceId: optionalText(e.sourceId),
    shadowed: e.shadowed.map((x) => ({
      scope: x.scope,
      id: optionalText(x.id),
      valueJson: units(json(x.value)),
    })),
  },
});
for (const [n, [name, state]] of Object.entries({
  fixture,
  full,
  empty,
}).entries()) {
  const snapshot = new ProjectStore(state).getSnapshot();
  const targets = scopedOverrideTargets(snapshot.state);
  const record = states[n];
  assert.equal(record.name, name);
  record.wire = {
    pages: [
      [0, 64],
      [1, 2],
      [99, 5],
    ].map(([start, count]) => ({
      requestJson: encodeProjectSettingsTargetPageRequest({ start, count }),
      replyJson: encodeProjectSettingsTargetPage({
        total: targets.length,
        targets: targets.slice(start, start + count).map((t) => ({
          id: units(t.id),
          target: wireTarget(t.target),
          label: units(t.label),
          path: units(t.path),
          overrideCount: t.overrideCount,
        })),
      }),
    })),
    snapshots: targets.map((t) => ({
      requestJson: encodeProjectSettingsTargetRequest({
        target: wireTarget(t.target),
      }),
      replyJson: encodeProjectSettingsSnapshotResult(
        wireSnapshot(scopedOverrideSnapshot(snapshot, t.target)),
      ),
    })),
    explanations: targets.flatMap((t) =>
      keys.map((key) => ({
        requestJson: encodeProjectSettingsExplainRequest({
          target: wireTarget(t.target),
          key: units(key),
        }),
        replyJson: encodeProjectSettingsExplainResult(
          wireExplanation(explainScopedSetting(snapshot, t.target, key)),
        ),
      })),
    ),
    unknown: record.unknown.map((u) => {
      const target = {
        scope: u.scope,
        ...{
          plate: { plateId: u.targetId },
          object: { objectId: u.targetId },
          part: { volumeId: u.targetId },
          layerRange: { layerRangeId: u.targetId },
        }[u.scope],
      };
      return {
        requestJson: encodeProjectSettingsTargetRequest({
          target: wireTarget(target),
        }),
        replyJson: encodeProjectSettingsSnapshotResult({
          unknown: units(u.message),
        }),
      };
    }),
  };
}

// Settings sessions: the editor the browser's project and node adapters open
// for each target, a scripted draft, and the intent its commit becomes.
const catalog = createEngineOptionCatalog(
  JSON.parse(read("web/src/settings/generated/engine-options.schema.json")),
);
const edits = {
  project: [
    ["layer_height", "0.28"],
    ["sparse_infill_density", "30%"],
    ["enable_support", "1"],
  ],
  plate: [
    ["print_sequence", "by layer"],
    ["wall_loops", "3"],
  ],
  object: [
    ["brim_type", "no_brim"],
    ["layer_height", "0.3"],
  ],
  part: [
    ["wall_loops", "6"],
    ["layer_height", "0.1"],
  ],
  layerRange: [["layer_height", "0.06"]],
};
const sessions = [];
for (const [name, state] of Object.entries({ fixture, full })) {
  const snapshot = new ProjectStore(state).getSnapshot();
  for (const option of scopedOverrideTargets(snapshot.state)) {
    const scope = option.scope;
    const raw =
      scope === "project"
        ? projectSettingsOverrideSnapshot(snapshot)
        : scopedOverrideSnapshot(snapshot, option.target);
    for (const mode of ["simple", "develop"]) {
      const editor = new SettingsDraftEditor(catalog, {
        mode,
        technology: "fff",
        guiSurface: guiSurfaceForScope(scope),
        ...(scope === "project" ? {} : { scope }),
        inherited: decodeSettingsConfig(catalog, raw.inheritedConfig).values,
        overrides: decodeSettingsConfig(catalog, raw.overrides).values,
      });
      const steps = edits[scope].map(([key, value]) => {
        const editJson = encodeProjectEditorEdit({
          set: { fieldId: units(catalog.get(key).id), raw: units(value) },
        });
        try {
          editor.setDraft(catalog.get(key).id, value);
          return {
            key,
            value,
            editJson,
            resultJson: encodeProjectEditorEditResult({ applied: {} }),
          };
        } catch (error) {
          return {
            key,
            value,
            error: error.message,
            editJson,
            resultJson: encodeProjectEditorEditResult({
              refused: { message: units(error.message), issues: [] },
            }),
          };
        }
      });
      const states = ["layer_height", "wall_loops", "print_sequence"].map(
        (key) => {
          const s = editor.getFieldState(catalog.get(key).id);
          return {
            key,
            ...(s.serializedValue !== undefined
              ? { serialized: s.serializedValue }
              : {}),
            origin: s.origin,
          };
        },
      );
      const commit = editor.commit();
      const commitJson = encodeProjectEditorCommitResult({
        committed: {
          baseRevision: commit.baseRevision,
          revision: commit.revision,
          changes: commit.changes.map((ch) => ({
            fieldId: units(ch.fieldId),
            key: units(ch.key),
            owner: units(ch.owner),
            action: ch.action,
            previousJson:
              ch.previousValue === undefined
                ? { absent: {} }
                : { value: units(json(ch.previousValue)) },
            valueJson:
              ch.value === undefined
                ? { absent: {} }
                : { value: units(json(ch.value)) },
            serialized:
              ch.serialized === undefined
                ? { absent: {} }
                : { value: units(ch.serialized) },
          })),
          nextOverridesJson: units(json(commit.nextOverrides)),
        },
      });
      const next = applySettingsCommitToConfig(raw.overrides, commit);
      const guard = {
        sourceRevision: raw.sourceRevision,
        sourceHash: units(raw.sourceHash),
      };
      const target = option.target;
      const command =
        scope === "project"
          ? {
              setProjectSettingsOverrides: {
                guard,
                inheritedConfigJson: units(json(raw.inheritedConfig)),
                overridesJson: units(json(next)),
              },
            }
          : {
              setScopedOverrides: {
                guard,
                target:
                  scope === "plate"
                    ? { plate: { plateId: units(target.plateId) } }
                    : scope === "object"
                      ? { object: { objectId: units(target.objectId) } }
                      : scope === "part"
                        ? { part: { volumeId: units(target.volumeId) } }
                        : {
                            layerRange: {
                              layerRangeId: units(target.layerRangeId),
                            },
                          },
                overridesJson: units(json(next)),
              },
            };
      sessions.push({
        state: name,
        target: option.id,
        mode,
        steps,
        states,
        changes: commit.changes.length,
        requestJson: encodeProjectSettingsSessionRequest({
          target: wireTarget(option.target),
          mode,
          technology: "fff",
        }),
        commitJson,
        intentJson: encodeProjectIntent({ version: 1, command }),
      });
    }
  }
}

const sources = [
  "tools/cross-platform/settings-projection-vectors.mjs",
  "web/src/project/scopedOverrides.ts",
  "web/src/project/settingsOverrides.ts",
  "web/src/project/domain/settingScopes.ts",
  "web/src/project/__tests__/fixtures.ts",
  "web/src/settings/editor/configBridge.ts",
  "web/src/ui/dom/mountSettingsEditors.ts",
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
      keys,
      states,
      sessions,
      assets: [
        {
          descriptorJson: json(createProjectFixture().asset.descriptor),
          bytes: Array.from(createProjectFixture().asset.bytes),
        },
      ],
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
