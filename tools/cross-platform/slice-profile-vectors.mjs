// Live profile preflight references from the production browser
// `deriveLiveProfilePreflightConstraints`, `authoredProjectPreflightTarget` and
// `LiveProfileSlicePreflight`, replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { STRING_VECTOR_KEYS } from "../../web/src/settings/configSerialization.ts";
import {
  deriveLiveProfilePreflightConstraints,
  LiveProfileSlicePreflight,
} from "../../web/src/workspace/ProfilePreflightConstraints.ts";
import { authoredProjectPreflightTarget } from "../../web/src/workspace/AuthoredSlicingTarget.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  encodeProjectPreflightEntity,
  encodeProjectPreflightIssue,
  encodeProjectPreflightOmission,
  encodeProjectPreflightRequest,
  encodeProjectPreflightSummary,
  PROJECT_INTENT_VERSION,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

/** The wire shape both sides read: only the fields the derivation consumes. */
const profileJson = (profile) =>
  profile
    ? {
        ...(profile.machinePresetId !== undefined
          ? { machinePresetId: profile.machinePresetId }
          : {}),
        ...(profile.processPresetId !== undefined
          ? { processPresetId: profile.processPresetId }
          : {}),
        ...(profile.filamentPresetId !== undefined
          ? { filamentPresetId: profile.filamentPresetId }
          : {}),
        config: profile.config,
      }
    : null;
const targetJson = (target) => ({
  source: target.source ?? "catalog",
  toolCount: target.toolCount,
  primary: profileJson(target.primaryProfile),
  filaments: Array.from(target.filamentProfiles, profileJson),
});
const derivationJson = (derived) => ({
  constraints: {
    ...(derived.constraints.buildVolume
      ? { buildVolume: derived.constraints.buildVolume }
      : {}),
    ...(derived.constraints.tools
      ? { tools: Array.from(derived.constraints.tools, (t) => t ?? null) }
      : {}),
    ...(derived.constraints.printer
      ? { printer: derived.constraints.printer }
      : {}),
  },
  blockingDiagnostics: derived.blockingDiagnostics,
  omissions: derived.omissions,
});

const derivations = [];
function derive(name, target) {
  assert.ok(!derivations.some((c) => c.name === name), name);
  derivations.push({
    name,
    targetJson: canonicalStringify(targetJson(target)),
    derivationJson: canonicalStringify(
      derivationJson(deriveLiveProfilePreflightConstraints(target)),
    ),
  });
}
const preset = (kind, name) => `preset:${kind}:${name}`;
function profile(filament, config, ids = {}) {
  return {
    id: `fixture|process|${filament}`,
    displayName: filament,
    machineName: "Fixture printer",
    processName: "Fixture process",
    filamentName: filament,
    machinePresetId: preset("machine", "fixture"),
    processPresetId: preset("process", "fixture"),
    filamentPresetId: preset("filament", filament),
    ...ids,
    config: { ...config },
  };
}
const bed = {
  printable_area: "0.5x1,270.5x1,270.5x271,0.5x271",
  printable_height: "270.05",
  nozzle_diameter: "0.4",
};
const pla = profile("pla", {
  ...bed,
  filament_type: "PLA",
  nozzle_temperature_range_low: "190",
  nozzle_temperature_range_high: "240",
});
const petg = profile("petg", {
  ...bed,
  filament_type: " PETG ",
  nozzle_temperature_range_low: "220",
  nozzle_temperature_range_high: "270",
});

derive("catalog-exact", {
  primaryProfile: pla,
  filamentProfiles: [pla, petg],
  toolCount: 2,
});
derive("catalog-missing-everything", {
  primaryProfile: undefined,
  filamentProfiles: [undefined, undefined],
  toolCount: 2,
});
derive("catalog-ambiguous", {
  primaryProfile: profile("pla", {
    printable_area: "0x0,10x10,10x0,0x10",
    printable_height: "250,260",
    nozzle_diameter: "0.4,0.6",
    filament_type: "PLA",
  }),
  filamentProfiles: [pla, undefined, pla],
  toolCount: 3,
});
derive("catalog-optional-omissions", {
  primaryProfile: profile("plain", {
    printable_area: " 0x0, 200x0 ,200x200,0x200,0x0 ",
    printable_height: "200",
    nozzle_diameter: "0.6",
    filament_type: "PLA;PETG",
    nozzle_temperature_range_low: "not-a-number",
  }),
  filamentProfiles: [
    profile("plain", {
      filament_type: "PLA;PETG",
      nozzle_temperature_range_low: "not-a-number",
    }),
  ],
  toolCount: 1,
});
derive("catalog-descending-range", {
  primaryProfile: pla,
  filamentProfiles: [
    profile("hot", {
      filament_type: "ASA",
      nozzle_temperature_range_low: "280",
      nozzle_temperature_range_high: "240",
    }),
  ],
  toolCount: 1,
});
derive("catalog-foreign-process", {
  primaryProfile: pla,
  filamentProfiles: [
    profile("pla", pla.config, { processPresetId: preset("process", "other") }),
    profile("pla", pla.config, { filamentPresetId: "  " }),
  ],
  toolCount: 2,
});
derive("catalog-blank-primary-ids", {
  primaryProfile: profile("pla", pla.config, { machinePresetId: " \t" }),
  filamentProfiles: [pla],
  toolCount: 1,
});
for (const [name, toolCount] of [
  ["tool-count-zero", 0],
  ["tool-count-fraction", 1.5],
  ["tool-count-negative", -1],
  ["tool-count-unsafe", 2 ** 53],
]) {
  derive(name, { primaryProfile: pla, filamentProfiles: [pla], toolCount });
}
for (const [name, area] of [
  ["area-closed-ring", "0x0,220x0,220x220,0x220,0x0"],
  ["area-signed", "+0x-0,220x0,220x220.,-0x220"],
  ["area-decimals", ".5x.5,10.25x.5,10.25x20,.5x20"],
  ["area-diagonal", "0x0,220x220,220x0,0x220"],
  ["area-triangle", "0x0,220x0,0x220"],
  ["area-duplicate", "0x0,220x0,220x0,0x220"],
  ["area-pentagon", "0x0,100x0,220x0,220x220,0x220"],
  ["area-exponent", "0x0,1e2x0,1e2x1e2,0x1e2"],
  ["area-spaces", "0 x0,220x0,220x220,0x220"],
  ["area-empty", " "],
  ["area-semicolon", "0x0;220x0;220x220;0x220"],
  ["area-huge", `0x0,${"9".repeat(400)}x0,${"9".repeat(400)}x9,0x9`],
  ["area-unicode-digits", "0x0,２20x0,220x220,0x220"],
]) {
  derive(name, {
    primaryProfile: profile("pla", { ...pla.config, printable_area: area }),
    filamentProfiles: [pla],
    toolCount: 1,
  });
}
for (const [name, nozzles, height] of [
  ["nozzle-uniform", "0.4", "250"],
  ["nozzle-per-tool", "0.4;0.6, 0.8", "0x10"],
  ["nozzle-blank-entry", "0.4,,0.4", " 250 "],
  ["nozzle-zero", "0,0.4,0.4", "-1"],
  ["nozzle-mismatch", "0.4,0.6", "Infinity"],
]) {
  derive(name, {
    primaryProfile: profile("pla", {
      ...pla.config,
      nozzle_diameter: nozzles,
      printable_height: height,
    }),
    filamentProfiles: [pla, petg, pla],
    toolCount: 3,
  });
}
derive("authored-embedded", {
  source: "authored-project",
  primaryProfile: { config: { ...bed, nozzle_diameter: "0.4,0.4" } },
  filamentProfiles: [
    { config: { filament_type: "PLA", nozzle_temperature_range_low: "190" } },
    { config: {} },
  ],
  toolCount: 2,
});
derive("authored-missing", {
  source: "authored-project",
  primaryProfile: undefined,
  filamentProfiles: [undefined],
  toolCount: 1,
});

// Authored targets come from canonical state alone.
const authored = [];
function author(name, state) {
  // Live states are canonical JSON round trips; member order follows from it.
  const canonical = JSON.parse(canonicalStringify(state));
  const target = authoredProjectPreflightTarget({
    printer: canonical.printer,
    config: canonical.settingsBaseConfig ?? canonical.config,
    filaments: canonical.filaments,
  });
  authored.push({
    name,
    stateJson: canonicalStringify(canonical),
    targetJson: canonicalStringify(targetJson(target)),
    derivationJson: canonicalStringify(
      derivationJson(deriveLiveProfilePreflightConstraints(target)),
    ),
  });
}
{
  const state = cloneProjectState(createProjectFixture().state);
  author("fixture", state);
  state.config = {
    ...state.config,
    printable_area: ["0x0", "220x0", "220x220", "0x220"],
    printable_height: 250,
    nozzle_diameter: [0.4, 0.6],
    filament_type: ["PLA", "PETG"],
    nozzle_temperature_range_low: "190,220",
    nozzle_temperature_range_high: [240, 270],
    printer_settings_id: "Snapmaker U1",
    post_process: ["a", null, ["b", null]],
    wipe_tower_x: [1.5, -0],
    enable_support: true,
    unicode: "é\ud800\u0001",
    object_value: { 10: "ten", 2: "two", b: [1, { c: null }], a: '"\\\n' },
    empty: [],
    nothing: null,
  };
  author("project-vectors", state);
  state.filaments.physical[1].config = {
    filament_type: "TPU",
    nozzle_temperature_range_low: 0x10,
  };
  state.filaments.physical[0].material = "";
  author("filament-overrides", state);
  state.settingsBaseConfig = {
    printable_area: "0x0,180x0,180x180,0x180",
    printable_height: "180",
    nozzle_diameter: "0.4",
    filament_type: "PLA;;",
    nozzle_temperature_range_low: " 200 ; 210",
  };
  author("settings-base", state);
  state.printer.toolCount = 3;
  state.filaments.physical.push({
    ...state.filaments.physical[0],
    id: "import:profile:third",
    toolId: 2,
    material: "ABS",
    config: { filament_type: { odd: 1 } },
  });
  author("third-tool", state);
}

// Live preflights: attestation errors merge into the canonical result. Each
// case also pins the host exchange in the generated contract encoding.
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const camel = (text) => text.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const optionalText = (text) =>
  text === undefined ? { absent: {} } : { value: units(text) };
const entityWire = (entity) =>
  entity.kind === "project"
    ? { project: {} }
    : { [camel(entity.kind)]: units(entity.id) };
const profileWire = (profile) =>
  profile
    ? {
        value: {
          machinePresetId: optionalText(profile.machinePresetId),
          processPresetId: optionalText(profile.processPresetId),
          filamentPresetId: optionalText(profile.filamentPresetId),
          printableArea: optionalText(profile.config.printable_area),
          printableHeight: optionalText(profile.config.printable_height),
          nozzleDiameter: optionalText(profile.config.nozzle_diameter),
          filamentType: optionalText(profile.config.filament_type),
          nozzleTemperatureRangeLow: optionalText(
            profile.config.nozzle_temperature_range_low,
          ),
          nozzleTemperatureRangeHigh: optionalText(
            profile.config.nozzle_temperature_range_high,
          ),
        },
      }
    : { absent: {} };
const budget = {
  assetBytes: 1 << 20,
  vertices: 1 << 16,
  indices: 1 << 16,
  assets: 16,
  vertexVisits: 1 << 20,
  tools: 64,
};
const issueWire = (issue) => ({
  id: units(issue.id),
  code: camel(issue.code),
  detailCode: optionalText(issue.detailCode),
  severity: issue.severity,
  message: units(issue.message),
  help: units(issue.help),
  path: optionalText(issue.path),
  entities: issue.entities.map(entityWire),
  actions: issue.actions.map((action) => ({
    id: camel(action.id),
    label: units(action.label),
    entity: action.entity
      ? { value: entityWire(action.entity) }
      : { absent: {} },
    settingKey: optionalText(action.settingKey),
  })),
});
const attestations = [];
function attest(name, state, assets, target) {
  const derivation = deriveLiveProfilePreflightConstraints(target);
  const plateId = state.activePlateId;
  const result = new LiveProfileSlicePreflight(derivation).evaluate(
    { state, assets, sourceRevision: 1, sourceHash: "h", sourceAssetHash: "a" },
    plateId,
  );
  const authoredTarget = target.source === "authored-project";
  attestations.push({
    name,
    stateJson: canonicalStringify(state),
    assets: assets.map((p) => ({
      descriptorJson: canonicalStringify(p.descriptor),
      bytes: Array.from(p.bytes),
    })),
    targetJson: canonicalStringify(targetJson(target)),
    resultJson: canonicalStringify(result),
    requestJson: encodeProjectPreflightRequest({
      version: PROJECT_INTENT_VERSION,
      plateId: units(plateId),
      target: authoredTarget
        ? { authored: {} }
        : {
            catalog: {
              toolCount: target.toolCount,
              primary: profileWire(target.primaryProfile),
              filaments: Array.from(target.filamentProfiles, profileWire),
            },
          },
      budget,
    }),
    summaryJson: encodeProjectPreflightSummary({
      plateId: units(result.plateId),
      canSlice: result.canSlice,
      blockingCount: result.blockingCount,
      issueCount: result.issues.length,
      omissionCount: derivation.omissions.length,
      printableInstanceCount: result.printableInstanceIds.length,
      usedFilamentCount: result.usedFilamentIds.length,
    }),
    issueJsons: result.issues.map((issue) =>
      encodeProjectPreflightIssue(issueWire(issue)),
    ),
    omissionJsons: derivation.omissions.map((omission) =>
      encodeProjectPreflightOmission({
        code: camel(omission.code),
        message: units(omission.message),
        path: units(omission.path),
        toolId: omission.toolId,
      }),
    ),
    instanceJsons: result.printableInstanceIds.map((id) =>
      encodeProjectPreflightEntity({ instance: units(id) }),
    ),
    filamentJsons: result.usedFilamentIds.map((id) =>
      encodeProjectPreflightEntity({ filament: units(id) }),
    ),
  });
}
const authoredLive = (state) =>
  authoredProjectPreflightTarget({
    printer: state.printer,
    config: state.settingsBaseConfig ?? state.config,
    filaments: state.filaments,
  });
{
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  attest("unbound-catalog", state, [fixture.asset], {
    primaryProfile: undefined,
    filamentProfiles: [undefined, undefined],
    toolCount: 2,
  });
  attest("bound-catalog", state, [fixture.asset], {
    primaryProfile: pla,
    filamentProfiles: [pla, petg],
    toolCount: 2,
  });
  attest("one-tool-target", state, [fixture.asset], {
    primaryProfile: pla,
    filamentProfiles: [pla],
    toolCount: 1,
  });
  // An imported project without its own bed facts cannot be attested.
  attest("authored-incomplete", state, [fixture.asset], authoredLive(state));
  state.config = {
    ...state.config,
    printable_area: "0x0,8x0,8x8,0x8",
    printable_height: 250,
    nozzle_diameter: [0.4, 0.6],
    filament_type: ["PLA", "PETG"],
    nozzle_temperature_range_low: "190,230",
  };
  attest("authored-attested", state, [fixture.asset], authoredLive(state));
  state.filaments.physical[1].toolId = 3;
  state.printer.toolCount = 4;
  attest("authored-sparse-tools", state, [fixture.asset], authoredLive(state));
  attest("unmatched-tool-entity", state, [fixture.asset], {
    primaryProfile: profile("pla", { ...pla.config, printable_height: "x" }),
    filamentProfiles: [pla, undefined, undefined, pla],
    toolCount: 4,
  });
}

const sources = [
  "tools/cross-platform/slice-profile-vectors.mjs",
  "web/src/workspace/ProfilePreflightConstraints.ts",
  "web/src/workspace/AuthoredSlicingTarget.ts",
  "web/src/settings/configSerialization.ts",
  "web/src/project/slicing/preflight.ts",
  "web/src/project/__tests__/fixtures.ts",
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
      stringVectorKeys: [...STRING_VECTOR_KEYS].sort(),
      derivations,
      authored,
      attestations,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/slice-profile-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Slice profile reference drift",
  );
console.log(
  `slice profile: ${derivations.length} derivations, ${authored.length} authored targets, ${attestations.length} attestations`,
);
