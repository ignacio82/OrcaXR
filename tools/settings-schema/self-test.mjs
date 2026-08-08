#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PinnedSource } from "../parity/source.mjs";
import {
  CONFIG_HEADER_PATH,
  PRINT_CONFIG_PATH,
  extractEngineOptionSchema,
} from "./source-parser.mjs";
import { TAB_SOURCE_PATH } from "./gui-source-parser.mjs";
import { MANIFEST_PATH, serializeSchema } from "./generate.mjs";

const manifestBytes = readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const baseline = new PinnedSource({ allowFetch: false });

function extract(
  snapshot = baseline,
  candidateManifest = manifest,
  allowSyntheticSource = false,
) {
  return extractEngineOptionSchema({
    snapshot,
    manifest: candidateManifest,
    manifestSha256,
    allowSyntheticSource,
  });
}

function option(schema, key, owner = null) {
  const matches = schema.definitions.filter(
    (definition) =>
      definition.key === key && (owner === null || definition.owner === owner),
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${key}${owner ? ` owned by ${owner}` : ""}`,
  );
  return matches[0];
}

function mutatedSnapshot(path, transform) {
  const original = baseline.read(path);
  const mutated = transform(original);
  assert.notEqual(mutated, original, `mutation did not alter ${path}`);
  return new PinnedSource({
    repository: baseline.repository,
    overrides: new Map([[path, mutated]]),
  });
}

function expectFailure(name, action, pattern) {
  assert.throws(action, pattern, name);
}

const first = extract();
const second = extract();
assert.equal(
  serializeSchema(first),
  serializeSchema(second),
  "extraction must be deterministic",
);
assert.equal(first.schemaVersion, 2);
assert.equal(first.status, "foundation-partial");
assert.equal(first.coverage.definitions, 816);
assert.equal(first.coverage.uniqueKeys, 809);
assert.equal(first.coverage.derivedAxisDefinitions, 12);
assert.equal(first.coverage.derivedNullableDefinitions, 18);
assert.equal(first.coverage.missingDefaults, 91);
assert.equal(first.coverage.unresolvedDefaults, 0);
assert.equal(first.coverage.unresolvedSourceValues, 0);
assert.equal(first.coverage.enumWithoutStorageMap, 0);
assert.equal(first.coverage.duplicateKeys.length, 7);
assert.deepEqual(first.guiLayout.coverage, {
  ambiguousDefinitionKeys: [
    "chamber_temperature",
    "outer_wall_acceleration",
    "retract_lift_above",
    "retract_lift_below",
  ],
  definitionsWithoutLiteralPlacement: 395,
  dynamicPlacements: 26,
  exactDefinitionBindings: 420,
  groups: 93,
  literalPlacements: 424,
  projectConfigWrites: 3,
  specialWidgets: 4,
  tabs: 21,
  uniqueLiteralPlacementKeys: 417,
});
assert.equal(
  new Set(first.definitions.map((definition) => definition.id)).size,
  first.definitions.length,
);

for (const definition of first.definitions) {
  assert.equal(definition.provenance.commit, manifest.upstream.commit);
  assert.equal(definition.provenance.tree, manifest.upstream.tree);
  assert.equal(
    definition.provenance.blob,
    "c0a2676191497a3f22733801939c4879c92f4dd3",
  );
}

const layerHeight = option(first, "layer_height");
assert.equal(layerHeight.storage.optionType, "coFloat");
assert.equal(layerHeight.storage.shape, "scalar");
assert.equal(layerHeight.default.value, 0.2);
assert.equal(layerHeight.constraints.min.value, 0);
assert.equal(layerHeight.presentation.label.value, "Layer height");
assert.equal(layerHeight.presentation.category.value, "Quality");
assert.equal(layerHeight.presentation.unit.value, "mm");
assert.equal(layerHeight.applicability.technology.value, "any");
const layerHeightPlacements = first.guiLayout.placements.filter(
  (placement) => placement.optionKey === "layer_height",
);
assert.equal(layerHeightPlacements.length, 2);
assert.equal(layerHeightPlacements[0].definitionBinding.status, "exact");
assert.equal(
  first.guiLayout.tabs.find((tab) => tab.id === layerHeightPlacements[0].tabId)
    .label,
  "Quality",
);
assert.equal(
  first.guiLayout.groups.find(
    (group) => group.id === layerHeightPlacements[0].groupId,
  ).label,
  "Layer height",
);

const filamentRetraction = option(first, "filament_retraction_length");
assert.equal(filamentRetraction.registrationKind, "derived-nullable");
assert.equal(filamentRetraction.storage.shape, "vector");
assert.equal(filamentRetraction.storage.nullable, true);
assert.equal(filamentRetraction.storage.serialization.collectionDelimiter, ",");
assert.equal(filamentRetraction.storage.serialization.nilToken, "nil");
assert.deepEqual(filamentRetraction.default.value, [0.8]);

const machineSpeedX = option(first, "machine_max_speed_x");
assert.equal(machineSpeedX.registrationKind, "derived-axis");
assert.equal(machineSpeedX.presentation.fullLabel.value, "Maximum speed X");
assert.deepEqual(machineSpeedX.default.value, [500, 200]);

const bedType = option(first, "curr_bed_type");
assert.equal(bedType.enum.storageMap.name, "BedType");
assert.deepEqual(
  bedType.enum.valuesU1.map((entry) => entry.value),
  ["Textured PEI Plate", "High Temp Plate", "Graphic Effect Plate"],
);
assert.equal(bedType.default.value, "Cool Plate");

const startGcode = option(first, "machine_start_gcode");
assert.equal(startGcode.presentation.multiline.value, true);
assert.equal(startGcode.presentation.fullWidth.value, true);
assert.equal(startGcode.presentation.height.value, 12);
assert.equal(startGcode.applicability.mode.value, "advanced");

const objectScale = option(
  first,
  "scale",
  "ObjectsInfoConfigDef::ObjectsInfoConfigDef",
);
assert.equal(objectScale.storage.optionType, "coStrings");
assert.equal(objectScale.storage.serialization.collectionDelimiter, ";");

expectFailure(
  "source blob drift must fail",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        'def = this->add("layer_height", coFloat);',
        'def = this->add("layer_height", coInt);',
      ),
    );
    extract(snapshot);
  },
  /Manifest\/source blob mismatch/,
);

expectFailure(
  "type drift must fail",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        'def = this->add("layer_height", coFloat);',
        'def = this->add("layer_height", coInt);',
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Type mismatch for layer_height/,
);

expectFailure(
  "unknown ConfigOptionDef fields must fail",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        'def = this->add("layer_height", coFloat);',
        'def = this->add("layer_height", coFloat);\n    def->future_ui_contract = true;',
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Unsupported ConfigOptionDef field future_ui_contract/,
);

expectFailure(
  "unknown dynamic registrations must fail",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        'def = this->add("layer_height", coFloat);',
        'def = this->add("future_" + runtime_suffix, coFloat);\n    def = this->add("layer_height", coFloat);',
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Unsupported dynamic this->add key/,
);

expectFailure(
  "source definitions missing from the manifest must fail",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        'def = this->add("printable_height", coFloat);',
        'def = this->add("schema_mutation_fixture", coFloat);\n    def = this->add("printable_height", coFloat);',
      ),
    );
    extract(snapshot, manifest, true);
  },
  /schema_mutation_fixture.*missing from the parity manifest/,
);

expectFailure(
  "manifest definitions missing from source must fail",
  () => {
    const changed = structuredClone(manifest);
    changed.inventory.settingDefinitions =
      changed.inventory.settingDefinitions.filter(
        (definition) => definition.key !== "layer_height",
      );
    extract(baseline, changed);
  },
  /layer_height.*missing from the parity manifest/,
);

expectFailure(
  "unsupported default expressions must fail closed",
  () => {
    const snapshot = mutatedSnapshot(PRINT_CONFIG_PATH, (source) =>
      source.replace(
        "new ConfigOptionFloat(0.2)",
        "new ConfigOptionFloat(runtime_layer_height)",
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Unsupported source expressions remain/,
);

expectFailure(
  "serialization authority drift must fail",
  () => {
    const snapshot = mutatedSnapshot(CONFIG_HEADER_PATH, (source) =>
      source.replace(
        "// semicolon-separated strings",
        "// mutated string delimiter documentation",
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Config\.hpp drift: missing coStrings semicolon serialization/,
);

expectFailure(
  "GUI source blob drift must fail",
  () => {
    const snapshot = mutatedSnapshot(TAB_SOURCE_PATH, (source) =>
      source.replace(
        'append_single_option_line("layer_height","quality_settings_layer_height")',
        'append_single_option_line("layer_height", "quality_settings_layer_height")',
      ),
    );
    extract(snapshot);
  },
  /Manifest\/source blob mismatch for src\/slic3r\/GUI\/Tab\.cpp/,
);

expectFailure(
  "GUI placement inventory drift must fail closed",
  () => {
    const snapshot = mutatedSnapshot(TAB_SOURCE_PATH, (source) =>
      source.replace(
        'append_single_option_line("layer_height","quality_settings_layer_height")',
        'append_single_option_line("schema_mutation_fixture","quality_settings_layer_height")',
      ),
    );
    extract(snapshot, manifest, true);
  },
  /Stale src\/slic3r\/GUI\/Tab\.cpp provenance|Manifest placement mismatch/,
);

process.stdout.write(
  "settings-schema self-test passed (816 definitions, 809 unique keys, 21 tabs, 93 groups, 424 literal placements, 10 fail-closed mutations)\n",
);
