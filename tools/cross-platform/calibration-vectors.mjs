// Calibration workflow references from the production browser
// (`project/calibration/*` and `features/calibrationInventory.ts`): definitions,
// compiler, parameter forms, instructions, history ledger, application rules,
// automation rules, line programs and resource patch matching across all 15
// pinned workflows. Replayed in Rust, in WASM, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  CALIBRATION_WORKFLOW_IDS,
  PINNED_CALIBRATION_COMMIT,
  calibrationInventory,
  getCalibrationWorkflow,
} from "../../web/src/features/calibrationInventory.ts";
import {
  getCalibrationJobDefinition,
} from "../../web/src/project/calibration/definitions.ts";
import {
  CalibrationJobValidationError,
  compileCalibrationJob,
  createDefaultCalibrationJobRequest,
} from "../../web/src/project/calibration/compiler.ts";
import {
  buildCalibrationForm,
} from "../../web/src/project/calibration/form.ts";
import {
  calibrationInstructions,
} from "../../web/src/project/calibration/instructions.ts";
import {
  assessCalibrationApplicability,
  calibrationMethodFromPlan,
  compareCalibrationRecords,
  exportCalibrationHistory,
  findSecretsInPayload,
  importCalibrationHistory,
  recordCalibrationRun,
} from "../../web/src/project/calibration/history.ts";
import {
  CALIBRATION_APPLICATION_RULES,
  planCalibrationApplication,
  describeCalibrationApplication,
} from "../../web/src/project/calibration/application.ts";
import {
  CALIBRATION_AUTOMATION_RULES,
  RESONANCE_ACCELEROMETERS,
  assessCalibrationAutomation,
} from "../../web/src/project/calibration/automation.ts";
import {
  pressureAdvanceLineProgram,
} from "../../web/src/project/calibration/lineProgram.ts";
import {
  flowPatchRatio,
  matchFlowPatches,
} from "../../web/src/project/calibration/resourceObjects.ts";
import {
  verifyCalibrationPlan,
} from "../../web/src/project/calibration/verify.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));

function defaultPrereqs(firmwareFlavor = "klipper") {
  return {
    printer: {
      id: "u1",
      manufacturer: "Snapmaker",
      model: "U1",
      bedWidthMm: 270,
      bedDepthMm: 270,
      buildHeightMm: 300,
      maxPrintSpeedMmPerS: 500,
      maxAccelerationMmPerS2: 20000,
    },
    nozzle: {
      diameterMm: 0.4,
      maxLayerHeightMm: 0.32,
      minTemperatureC: 170,
      maxTemperatureC: 300,
    },
    filament: {
      id: "pla",
      name: "Generic PLA",
      material: "PLA",
      minTemperatureC: 190,
      maxTemperatureC: 240,
      flowRatio: 0.98,
      maxVolumetricSpeedMm3PerS: 15,
      retractionLengthMm: 0.8,
    },
    process: {
      id: "standard",
      layerHeightMm: 0.2,
      firstLayerHeightMm: 0.2,
      lineWidthMm: 0.42,
      outerWallSpeedMmPerS: 120,
      defaultAccelerationMmPerS2: 5000,
      xyHoleCompensationMm: 0,
      xyContourCompensationMm: 0,
    },
    firmware: {
      flavor: firmwareFlavor,
      nozzleTemperature: true,
      pressureAdvance: true,
      inputShaping: true,
      junctionDeviation: firmwareFlavor === "marlin",
      maxInputShapingFrequencyHz: 200,
    },
  };
}

// 1. All 15 definitions
const definitions = CALIBRATION_WORKFLOW_IDS.map((id) => {
  const def = getCalibrationJobDefinition(id);
  assert.ok(def, `Missing definition ${id}`);
  return def;
});

// 2. Default compiled plans for all 15
const defaultPlans = CALIBRATION_WORKFLOW_IDS.map((id) => {
  const flavor = id === "junction-deviation" ? "marlin" : "klipper";
  const prereqs = defaultPrereqs(flavor);
  const req = createDefaultCalibrationJobRequest(id, prereqs);
  const plan = compileCalibrationJob(req, { jobId: `calibration:default:${id}` });
  const verification = verifyCalibrationPlan(plan);
  assert.equal(verification.satisfied, true, `Verification failed for ${id}: ${JSON.stringify(verification.failures)}`);
  return { id, request: req, plan };
});

// 3. Custom plans covering parameter sweeps and variations
const customCases = [
  {
    id: "temperature-tower",
    params: { start: 230, end: 200, step: 5 },
  },
  {
    id: "retraction-tower",
    params: { start: 0.2, end: 1.4, step: 0.2 },
  },
  {
    id: "max-volumetric-speed",
    params: { start: 5, end: 20, step: 2.5 },
  },
  {
    id: "vfa",
    params: { start: 40, end: 160, step: 20 },
  },
  {
    id: "pressure-advance-tower",
    params: { start: 0.01, end: 0.06, step: 0.01 },
  },
  {
    id: "pressure-advance-line",
    params: { start: 0.01, end: 0.05, step: 0.01 },
  },
  {
    id: "pressure-advance-pattern",
    params: { start: 0.01, end: 0.04, step: 0.01 },
  },
  {
    id: "junction-deviation",
    flavor: "marlin",
    params: { start: 0.01, end: 0.1, testModel: "Ringing Tower" },
  },
  {
    id: "input-shaping-frequency",
    params: { freqStartX: 20, freqEndX: 60, freqStartY: 20, freqEndY: 60, damping: 0.1, testModel: "Ringing Tower" },
  },
  {
    id: "input-shaping-damping",
    params: { start: 0.05, end: 0.25, frequencyX: 45, frequencyY: 45, testModel: "Ringing Tower" },
  },
];

const customPlans = customCases.map((testCase) => {
  const flavor = testCase.flavor ?? "klipper";
  const prereqs = defaultPrereqs(flavor);
  const req = createDefaultCalibrationJobRequest(testCase.id, prereqs, { parameters: testCase.params });
  const plan = compileCalibrationJob(req, { jobId: `calibration:custom:${testCase.id}` });
  return { id: testCase.id, params: testCase.params, plan };
});

// 4. Rejections
const rejectionCases = [
  {
    name: "unknown_definition",
    run: () => {
      const prereqs = defaultPrereqs();
      compileCalibrationJob(
        {
          schemaVersion: 1,
          definitionId: "unknown-calibration",
          definitionVersion: 1,
          definitionFingerprint: "fnv1a64:0000000000000000",
          execution: "manual",
          parameters: {},
          prerequisites: prereqs,
        },
        { jobId: "calibration:unknown" },
      );
    },
  },
  {
    name: "stale_fingerprint",
    run: () => {
      const prereqs = defaultPrereqs();
      const req = { ...createDefaultCalibrationJobRequest("temperature-tower", prereqs), definitionFingerprint: "fnv1a64:deadbeefcafebabe" };
      compileCalibrationJob(req, { jobId: "calibration:stale" });
    },
  },
  {
    name: "temp_safety_exceeded",
    run: () => {
      const prereqs = defaultPrereqs();
      const req = createDefaultCalibrationJobRequest("temperature-tower", prereqs, {
        parameters: { start: 290, end: 250, step: 5 },
      });
      compileCalibrationJob(req, { jobId: "calibration:hot" });
    },
  },
  {
    name: "non_integral_step",
    run: () => {
      const prereqs = defaultPrereqs();
      const req = createDefaultCalibrationJobRequest("temperature-tower", prereqs, {
        parameters: { start: 240, end: 200, step: 7 },
      });
      compileCalibrationJob(req, { jobId: "calibration:unaligned" });
    },
  },
  {
    name: "bed_overflow",
    run: () => {
      const prereqs = defaultPrereqs();
      prereqs.printer.bedWidthMm = 30; // Tower is 44.488 mm
      const req = createDefaultCalibrationJobRequest("temperature-tower", prereqs);
      compileCalibrationJob(req, { jobId: "calibration:tinybed" });
    },
  },
  {
    name: "missing_firmware_capability",
    run: () => {
      const prereqs = defaultPrereqs("klipper");
      prereqs.firmware.pressureAdvance = false;
      const req = createDefaultCalibrationJobRequest("pressure-advance-tower", prereqs);
      compileCalibrationJob(req, { jobId: "calibration:nopa" });
    },
  },
  {
    name: "wrong_firmware_flavor",
    run: () => {
      const prereqs = defaultPrereqs("klipper"); // junction deviation requires marlin
      const req = createDefaultCalibrationJobRequest("junction-deviation", prereqs);
      compileCalibrationJob(req, { jobId: "calibration:klipper_jd" });
    },
  },
  {
    name: "automatic_unsupported",
    run: () => {
      const prereqs = defaultPrereqs();
      const req = createDefaultCalibrationJobRequest("temperature-tower", prereqs, { execution: "automatic" });
      compileCalibrationJob(req, { jobId: "calibration:auto" });
    },
  },
];

const rejections = rejectionCases.map((c) => {
  try {
    c.run();
    assert.fail(`Expected failure for ${c.name}`);
  } catch (error) {
    assert.ok(error instanceof CalibrationJobValidationError, `Unexpected error: ${error}`);
    return { name: c.name, issues: error.issues };
  }
});

// 5. Form previews (defaults, edits, unreadable)
const formPreviews = [
  // Default form for all 15
  ...CALIBRATION_WORKFLOW_IDS.map((id) => {
    const flavor = id === "junction-deviation" ? "marlin" : "klipper";
    const prereqs = defaultPrereqs(flavor);
    const form = buildCalibrationForm(id, prereqs, {}, `calibration:form:${id}`);
    return { id, kind: "default", form };
  }),
  // Form with valid edits
  {
    id: "temperature-tower",
    kind: "edited",
    form: buildCalibrationForm("temperature-tower", defaultPrereqs(), { start: "235", end: "205", step: "5" }, "calibration:form:edited"),
  },
  // Form with unreadable values
  {
    id: "temperature-tower",
    kind: "unreadable",
    form: buildCalibrationForm("temperature-tower", defaultPrereqs(), { start: "not_a_number", step: "" }, "calibration:form:unreadable"),
  },
];

// 6. Instructions for all 15 default plans
const instructions = defaultPlans.map(({ id, plan }) => {
  return { id, instructions: calibrationInstructions(plan) };
});

// 7. History operations
const sampleConditions = {
  printerModel: "U1",
  firmwareFlavor: "klipper",
  firmwareVersion: "v0.12.0",
  nozzleDiameterMm: 0.4,
  filamentMaterial: "PLA",
  filamentPresetHash: "fnv1a64:1111222233334444",
  processPresetHash: "fnv1a64:5555666677778888",
};

const sampleMethod = calibrationMethodFromPlan(defaultPlans[0].plan); // temperature tower
const sampleEntry = {
  operator: "Operator",
  recordedAt: "2026-10-14T10:00:00Z",
  measurements: [{ key: "bestNozzleTemperatureC", value: 215 }],
  chosenKey: "bestNozzleTemperatureC",
  projectHash: "fnv1a64:9999000011112222",
  note: "Clean bridging at 215 C",
};

const recordedRun = recordCalibrationRun(sampleMethod, sampleConditions, sampleEntry);
assert.ok(recordedRun.record, "Failed to record run");

// Secret detection in payload
const secretIssues = findSecretsInPayload({
  token: "secret_123",
  address: "http://192.168.1.50/api",
  clean: "harmless",
});

// Applicability
const applicabilityExact = assessCalibrationApplicability(recordedRun.record, sampleConditions);
const applicabilityWrongNozzle = assessCalibrationApplicability(recordedRun.record, {
  ...sampleConditions,
  nozzleDiameterMm: 0.6,
});
const applicabilityWrongFilament = assessCalibrationApplicability(recordedRun.record, {
  ...sampleConditions,
  filamentMaterial: "PETG",
});
const applicabilityFirmwareChange = assessCalibrationApplicability(recordedRun.record, {
  ...sampleConditions,
  firmwareVersion: "v0.12.1",
});

// Comparison
const secondEntry = {
  ...sampleEntry,
  recordedAt: "2026-10-14T11:00:00Z",
  measurements: [{ key: "bestNozzleTemperatureC", value: 220 }],
  chosenKey: "bestNozzleTemperatureC",
};
const secondRecord = recordCalibrationRun(sampleMethod, sampleConditions, secondEntry).record;
const comparisonSame = compareCalibrationRecords(recordedRun.record, secondRecord);

const diffConditions = { ...sampleConditions, nozzleDiameterMm: 0.6 };
const thirdRecord = recordCalibrationRun(sampleMethod, diffConditions, secondEntry).record;
const comparisonDifferent = compareCalibrationRecords(recordedRun.record, thirdRecord);

// Export & Import
const exportResult = exportCalibrationHistory([recordedRun.record, secondRecord], "2026-10-14T11:05:00Z");
assert.equal(exportResult.issues.length, 0);
const exportJson = exportResult.text;
const importResult = importCalibrationHistory(exportJson);
assert.equal(importResult.records.length, 2);

const historyVectors = {
  recorded: recordedRun.record,
  secretIssues,
  applicability: {
    exact: applicabilityExact,
    wrongNozzle: applicabilityWrongNozzle,
    wrongFilament: applicabilityWrongFilament,
    firmwareChange: applicabilityFirmwareChange,
  },
  comparison: {
    same: comparisonSame,
    different: comparisonDifferent,
  },
  exportJson,
  importRecords: importResult.records,
};

// 8. Application rules for all 15 workflows
const applicationVectors = CALIBRATION_WORKFLOW_IDS.map((id) => {
  const rule = CALIBRATION_APPLICATION_RULES[id];
  return { id, rule };
});

// Test assessing application
const applicationAssessment = planCalibrationApplication(recordedRun.record, sampleConditions);

// 9. Automation rules for all 15 workflows
const automationVectors = CALIBRATION_WORKFLOW_IDS.map((id) => {
  const rule = CALIBRATION_AUTOMATION_RULES[id];
  const assessNoObjects = assessCalibrationAutomation(id, undefined);
  const assessWithTester = assessCalibrationAutomation(id, ["resonance_tester", "adxl345"]);
  const assessMissingSensor = assessCalibrationAutomation(id, ["resonance_tester"]);
  const assessNoTester = assessCalibrationAutomation(id, ["extruder", "heater_bed"]);
  return { id, rule, assessNoObjects, assessWithTester, assessMissingSensor, assessNoTester };
});

// 10. Line programs
const lineProgramLine = pressureAdvanceLineProgram(defaultPlans.find((p) => p.id === "pressure-advance-line").plan, {
  layerHeightMm: 0.2,
  lineWidthMm: 0.42,
  filamentDiameterMm: 1.75,
  printFeedMmPerMin: 3000,
  travelFeedMmPerMin: 12000,
});
const lineProgramPattern = pressureAdvanceLineProgram(defaultPlans.find((p) => p.id === "pressure-advance-pattern").plan, {
  layerHeightMm: 0.2,
  lineWidthMm: 0.42,
  filamentDiameterMm: 1.75,
  printFeedMmPerMin: 3000,
  travelFeedMmPerMin: 12000,
});

// 11. Resource patch matching
const flowArchives = [
  {
    name: "flowrate-test-pass1",
    patches: ["flowrate_0", "flowrate_10", "flowrate_15", "flowrate_20", "flowrate_5", "flowrate_m10", "flowrate_m15", "flowrate_m20", "flowrate_m5"],
    plan: defaultPlans.find((p) => p.id === "flow-pass-1").plan,
  },
  {
    name: "flowrate-test-pass2",
    patches: ["flowrate_0", "flowrate_m1", "flowrate_m2", "flowrate_m3", "flowrate_m4", "flowrate_m5", "flowrate_m6", "flowrate_m7", "flowrate_m8", "flowrate_m9"],
    plan: defaultPlans.find((p) => p.id === "flow-pass-2").plan,
  },
  {
    name: "Orca-LinearFlow",
    patches: ["flowrate_0", "flowrate_0.01", "flowrate_0.02", "flowrate_0.03", "flowrate_0.04", "flowrate_0.05", "flowrate_m0.01", "flowrate_m0.02", "flowrate_m0.03", "flowrate_m0.04", "flowrate_m0.05"],
    plan: compileCalibrationJob(
      createDefaultCalibrationJobRequest("flow-yolo", {
        ...defaultPrereqs(),
        filament: { ...defaultPrereqs().filament, flowRatio: 1 },
      }),
      { jobId: "calibration:flow-yolo:linear" },
    ),
  },
];

const flowMatchingVectors = flowArchives.map(({ name, patches, plan }) => {
  const mapping = matchFlowPatches(patches, plan.effects);
  assert.equal(mapping.problems.length, 0, `Flow patch matching failed for ${name}: ${mapping.problems.join(", ")}`);
  return { name, patches, mapping };
});

const sources = [
  "tools/cross-platform/calibration-vectors.mjs",
  "web/src/features/calibrationInventory.ts",
  "web/src/features/generated/calibration-inventory.json",
  "web/src/project/calibration/definitions.ts",
  "web/src/project/calibration/types.ts",
  "web/src/project/calibration/compiler.ts",
  "web/src/project/calibration/form.ts",
  "web/src/project/calibration/instructions.ts",
  "web/src/project/calibration/history.ts",
  "web/src/project/calibration/application.ts",
  "web/src/project/calibration/automation.ts",
  "web/src/project/calibration/lineProgram.ts",
  "web/src/project/calibration/resourceObjects.ts",
  "web/src/project/calibration/verify.ts",
];

const payload = {
  schemaVersion: 1,
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256").update(read(path)).digest("hex"),
  })),
  definitions,
  defaultPlans,
  customPlans,
  rejections,
  formPreviews,
  instructions,
  history: historyVectors,
  application: {
    rules: applicationVectors,
    sampleAssessment: applicationAssessment,
  },
  automation: automationVectors,
  linePrograms: {
    line: lineProgramLine,
    pattern: lineProgramPattern,
  },
  flowMatching: flowMatchingVectors,
};

const output = JSON.stringify(payload, null, 2) + "\n";
const target = new URL("testdata/cross-platform/calibration-vectors.json", root);
const definitionsTarget = new URL("contracts/calibration-definitions.json", root);
const definitionsOutput = JSON.stringify(definitions, null, 2) + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(target, output);
  writeFileSync(definitionsTarget, definitionsOutput);
  console.log(`Wrote ${output.length} bytes to ${target.pathname}`);
  console.log(`Wrote ${definitionsOutput.length} bytes to ${definitionsTarget.pathname}`);
} else {
  assert.equal(readFileSync(target, "utf8"), output, "Calibration vector drift; run with --write");
  assert.equal(readFileSync(definitionsTarget, "utf8"), definitionsOutput, "Calibration definitions drift; run with --write");
}
console.log(
  `Generated calibration vectors: ${definitions.length} definitions, ${defaultPlans.length} default plans, ${customPlans.length} custom plans, ${rejections.length} rejections, ${formPreviews.length} forms, ${instructions.length} instructions`,
);
