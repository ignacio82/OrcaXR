import assert from 'node:assert/strict';
import generatedInventory from './generated/calibration-inventory.json' with { type: 'json' };
import {
  CALIBRATION_MODES,
  CALIBRATION_WORKFLOW_IDS,
  CalibrationInventoryValidationError,
  calibrationInventory,
  getCalibrationWorkflow,
  parseCalibrationInventory,
} from './calibrationInventory';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

function workflow(id: (typeof CALIBRATION_WORKFLOW_IDS)[number]) {
  const found = getCalibrationWorkflow(id);
  assert.ok(found, `missing ${id}`);
  return found;
}

function rejectMutation(name: string, mutate: (draft: any) => void) {
  test(`fails closed when ${name}`, () => {
    const draft = structuredClone(generatedInventory);
    mutate(draft);
    assert.throws(
      () => parseCalibrationInventory(draft),
      (error: unknown) => error instanceof CalibrationInventoryValidationError && error.message.startsWith('$'),
    );
  });
}

test('catalog is pinned to the exact upstream commit, tree, enum blob, and parity task', () => {
  assert.equal(calibrationInventory.upstream.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.equal(calibrationInventory.upstream.tree, '612a77a60f923a2b117de7fd695512e5451a179f');
  assert.equal(calibrationInventory.modeSource.blob, 'd7db10fd81bad818de9e76aee9408709b4815c85');
  assert.equal(calibrationInventory.modeSource.parityTask, 'P8.1');
  assert.equal(calibrationInventory.modeSource.count, 11);
});

test('all 11 non-None CalibMode values and exact 14 pinned menu variants are present', () => {
  assert.deepEqual(
    calibrationInventory.modes.map((mode) => mode.name),
    CALIBRATION_MODES,
  );
  assert.deepEqual(
    calibrationInventory.modes.map((mode) => mode.value),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    calibrationInventory.workflows.filter((entry) => entry.origin === 'pinned-menu').map((entry) => entry.id),
    CALIBRATION_WORKFLOW_IDS.slice(0, 14),
  );
});

test('tolerance is an explicit documented non-enum extension with its pinned model', () => {
  const tolerance = workflow('tolerance-extension');
  assert.equal(tolerance.origin, 'documented-extension');
  assert.equal(tolerance.enumMode, null);
  assert.equal(tolerance.menu, null);
  assert.deepEqual(tolerance.parameters[0]?.default, [0, 0.05, 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(tolerance.resources, [
    {
      path: 'resources/handy_models/OrcaToleranceTest.stl',
      blob: '3f4e87eb9436d000b15b6f853675c262f821f45f',
      role: 'model',
    },
  ]);
});

test('dialog defaults preserve conditional PA and material temperature values', () => {
  const pattern = workflow('pressure-advance-pattern');
  assert.deepEqual(pattern.parameters.find((parameter) => parameter.key === 'end')?.default, { DDE: 0.08, Bowden: 1 });
  assert.deepEqual(pattern.parameters.find((parameter) => parameter.key === 'step')?.default, {
    DDE: 0.005,
    Bowden: 0.05,
  });
  assert.equal(
    pattern.parameters.find((parameter) => parameter.key === 'accelerations')?.enabledWhen,
    'method == PA Pattern',
  );

  const temperature = workflow('temperature-tower');
  assert.deepEqual(temperature.parameters.find((parameter) => parameter.key === 'start')?.default, {
    PLA: 230,
    'ABS/ASA': 270,
    PETG: 250,
    PCTG: 280,
    TPU: 240,
    'PA-CF': 320,
    'PET-CF': 320,
    Custom: 230,
  });
  assert.equal(temperature.parameters.find((parameter) => parameter.key === 'step')?.editable, false);
});

test('flow variants retain exact resources and YOLO menu step choices', () => {
  assert.equal(workflow('flow-pass-1').resources[0]?.blob, '20c997da020fc8b4d0b3481c04efa44454049c6e');
  assert.equal(workflow('flow-pass-2').resources[0]?.blob, '97978494050f01e29cd2ffe7c7f4e0a74d70c295');
  assert.equal(workflow('flow-yolo').parameters.find((parameter) => parameter.key === 'modifierStep')?.default, 0.01);
  assert.equal(
    workflow('flow-yolo-perfectionist').parameters.find((parameter) => parameter.key === 'modifierStep')?.default,
    0.005,
  );
});

test('effect categories, result fields, and preset targets remain workflow-specific', () => {
  assert.deepEqual(
    workflow('pressure-advance-pattern').effects.map((effect) => effect.category),
    ['per-object', 'generated-gcode'],
  );
  assert.deepEqual(
    workflow('temperature-tower').presetTargets.map((target) => target.key),
    ['nozzle_temperature', 'nozzle_temperature_initial_layer'],
  );
  assert.deepEqual(
    workflow('input-shaping-frequency').resultFields.map((field) => field.key),
    ['frequencyXHz', 'frequencyYHz'],
  );
  assert.equal(workflow('max-volumetric-speed').presetTargets[0]?.key, 'filament_max_volumetric_speed');
});

test('local bindings distinguish alpha geometry from currently unbound variants', () => {
  assert.equal(workflow('temperature-tower').localBinding.status, 'alpha-geometry-only');
  assert.equal(workflow('pressure-advance-line').localBinding.actionId, 'calib_pressure_advance');
  assert.equal(workflow('flow-yolo-perfectionist').localBinding.status, 'unbound');
  assert.equal(workflow('junction-deviation').localBinding.status, 'unbound');
  assert.equal(workflow('input-shaping-frequency').localBinding.status, 'unbound');
  assert.equal(workflow('input-shaping-damping').localBinding.status, 'unbound');
});

test('proprietary automatic calibration is explicit and unavailable for OrcaXR', () => {
  assert.equal(calibrationInventory.deviceAutomation.orcaxrPolicy, 'manual-only');
  assert.equal(calibrationInventory.deviceAutomation.supportedTransport, 'moonraker');
  assert.deepEqual(calibrationInventory.deviceAutomation.unavailableTransports, ['vendor-cloud', 'serial', 'usb']);
  assert.equal(workflow('pressure-advance-tower').deviceGating.automation, 'bambu-proprietary-auto');
  assert.equal(workflow('pressure-advance-tower').deviceGating.orcaxrStatus, 'blocked-proprietary-auto');
  assert.ok(
    workflow('flow-pass-1').deviceGating.requirements.some((requirement) =>
      requirement.includes('is_support_flow_calibration'),
    ),
  );
});

test('runtime catalog is recursively frozen and unknown IDs have no fallback', () => {
  assert.ok(Object.isFrozen(calibrationInventory));
  assert.ok(Object.isFrozen(calibrationInventory.workflows));
  assert.ok(Object.isFrozen(calibrationInventory.workflows[0]?.parameters));
  assert.ok(Object.isFrozen(calibrationInventory.workflows[0]?.parameters[0]?.constraints));
  assert.equal(getCalibrationWorkflow('not-a-real-workflow'), undefined);
});

rejectMutation('the schema version changes', (draft) => {
  draft.schemaVersion = 2;
});

rejectMutation('an unknown root field appears', (draft) => {
  draft.untrusted = true;
});

rejectMutation('the pinned commit changes', (draft) => {
  draft.upstream.commit = '0000000000000000000000000000000000000000';
});

rejectMutation('a required mode-source field is missing', (draft) => {
  delete draft.modeSource.blob;
});

rejectMutation('a non-None enum mode disappears', (draft) => {
  draft.modes.pop();
});

rejectMutation('an enum value is reordered', (draft) => {
  draft.modes[0].value = 2;
});

rejectMutation('a source blob is malformed', (draft) => {
  draft.sources[0].blob = 'dirty-worktree';
});

rejectMutation('a source path escapes the repository', (draft) => {
  draft.sources[1].path = '../MainFrame.cpp';
});

rejectMutation('a workflow ID is substituted', (draft) => {
  draft.workflows[0].id = 'flow-pass-1';
});

rejectMutation('the tolerance extension is assigned an enum', (draft) => {
  draft.workflows[14].enumMode = 'Calib_Temp_Tower';
});

rejectMutation('a menu object gains an unknown field', (draft) => {
  draft.workflows[0].menu.fallback = 'something else';
});

rejectMutation('a parameter gains an unknown field', (draft) => {
  draft.workflows[0].parameters[0].minimum = 0;
});

rejectMutation('a numeric default becomes non-finite', (draft) => {
  draft.workflows[0].parameters[1].default.PLA = Number.NaN;
});

rejectMutation('a resource blob is malformed', (draft) => {
  draft.workflows[0].resources[0].blob = 'not-a-blob';
});

rejectMutation('an unknown effect category appears', (draft) => {
  draft.workflows[0].effects[0].category = 'implicit-fallback';
});

rejectMutation('a result required flag is coerced', (draft) => {
  draft.workflows[0].resultFields[0].required = 'yes';
});

rejectMutation('an unknown preset scope appears', (draft) => {
  draft.workflows[0].presetTargets[0].scope = 'cloud';
});

rejectMutation('an unbound action claims an action ID', (draft) => {
  draft.workflows[4].localBinding.actionId = 'calib_flow_yolo';
});

rejectMutation('proprietary automation loses its requirements', (draft) => {
  draft.workflows[1].deviceGating.requirements = [];
});

rejectMutation('a workflow references an unknown source', (draft) => {
  draft.workflows[0].sourceRefs[0] = 'dirty-file';
});

rejectMutation('device gating is silently removed', (draft) => {
  draft.deviceAutomation.gates.pop();
});

console.log(`\nCalibration inventory: ${passed} tests passed.`);
