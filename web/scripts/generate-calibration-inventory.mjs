import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626';
const UPSTREAM_REPOSITORY = 'https://github.com/Snapmaker/OrcaSlicer.git';
const webRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(webRoot, '..');
const upstreamRoot = resolve(repositoryRoot, 'third_party', 'SnapmakerOrca');
const parityPath = resolve(repositoryRoot, 'docs', 'parity', 'snapmaker-v2.3.4.json');
const outputPath = resolve(webRoot, 'src', 'features', 'generated', 'calibration-inventory.json');
const actionSourcePath = resolve(webRoot, 'src', 'actions', 'groups', 'calibration.ts');
const workspaceSourcePath = resolve(webRoot, 'src', 'workspace', 'OrcaWorkspace.ts');
const checkOnly = process.argv.includes('--check');

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(', ')}`);
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', ['-C', upstreamRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function pinnedText(path) {
  return git(['show', `${PINNED_COMMIT}:${path}`]);
}

function pinnedBlob(path) {
  const blob = git(['rev-parse', `${PINNED_COMMIT}:${path}`]);
  if (!/^[0-9a-f]{40}$/.test(blob) || git(['cat-file', '-t', blob]) !== 'blob') {
    throw new Error(`Expected ${path} at ${PINNED_COMMIT} to resolve to a Git blob`);
  }
  return blob;
}

function assertIncludes(text, expected, description) {
  if (!text.includes(expected)) {
    throw new Error(`Pinned source mismatch for ${description}: missing ${JSON.stringify(expected)}`);
  }
}

function assertEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${description} mismatch\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

// Without the pinned developer checkout (CI, clean clones) the generated
// inventory can still be verified for integrity: it is committed, strictly
// typed at runtime, and declares the commit it was derived from. Re-deriving it
// from upstream blobs needs the checkout and is reported as skipped.
if (!existsSync(join(upstreamRoot, '.git'))) {
  if (!checkOnly) {
    throw new Error(`Generating the calibration inventory needs the pinned upstream checkout at ${upstreamRoot}`);
  }
  verifyCommittedInventory();
  process.exit(process.exitCode ?? 0);
}

const resolvedCommit = git(['rev-parse', '--verify', `${PINNED_COMMIT}^{commit}`]);
assertEqual(resolvedCommit, PINNED_COMMIT, 'pinned upstream commit');
const pinnedTree = git(['rev-parse', `${PINNED_COMMIT}^{tree}`]);

const sourceSpecs = [
  {
    id: 'calib-mode',
    path: 'src/libslic3r/calib.hpp',
    role: 'enum',
    anchors: ['enum class CalibMode : int', 'Calib_None = 0', 'Calib_Junction_Deviation'],
  },
  {
    id: 'main-menu',
    path: 'src/slic3r/GUI/MainFrame.cpp',
    role: 'menu',
    anchors: [
      '_L("Temperature Calibration")',
      'm_plater->calib_flowrate(false, 1)',
      'm_plater->calib_flowrate(false, 2)',
      'm_plater->calib_flowrate(true, 1)',
      'm_plater->calib_flowrate(true, 2)',
      '_L("YOLO (perfectionist version)")',
      'new PA_Calibration_Dlg',
      'new Retraction_Test_Dlg',
      'new MaxVolumetricSpeed_Test_Dlg',
      'new Junction_Deviation_Test_Dlg',
      'new Input_Shaping_Freq_Test_Dlg',
      'new Input_Shaping_Damp_Test_Dlg',
      'new VFA_Test_Dlg',
    ],
  },
  {
    id: 'dialogs',
    path: 'src/slic3r/GUI/calib_dlg.cpp',
    role: 'dialog',
    anchors: [
      '{ _L("PA Tower"), _L("PA Line"), _L("PA Pattern") }',
      'm_params.step < EPSILON',
      'm_params.end < m_params.start + m_params.step',
      '{ _L("PLA"), _L("ABS/ASA"), _L("PETG"), _L("PCTG"), _L("TPU"), _L("PA-CF"), _L("PET-CF"), _L("Custom") }',
      'start > 350 || end < 170  || end > (start - 5)',
      'm_params.start <= 10 || m_params.step <= 0',
      'm_params.start < 0 || m_params.step <= 0',
      'm_params.freqStartY < 0 || m_params.freqEndX > 500',
      'm_params.start < 0 || m_params.end > 1',
      'm_params.end >= 1 || m_params.start >= m_params.end',
    ],
  },
  {
    id: 'plater-workflows',
    path: 'src/slic3r/GUI/Plater.cpp',
    role: 'workflow',
    anchors: [
      '/calib/pressure_advance/pressure_advance_test.stl',
      '/calib/pressure_advance/tower_with_seam.stl',
      'Orca-LinearFlow.3mf',
      'Orca-LinearFlow_fine.3mf',
      'flowrate-test-pass1.3mf',
      'flowrate-test-pass2.3mf',
      '/calib/temperature_tower/temperature_tower.stl',
      '/calib/volumetric_speed/SpeedTestStructure.step',
      '/calib/retraction/retraction_tower.stl',
      '/calib/vfa/VFA.stl',
      '/calib/input_shaping/ringing_tower.stl',
      '/calib/input_shaping/fast_tower_test.stl',
      'generate_custom_gcodes',
      'set_key_value("print_flow_ratio"',
    ],
  },
  {
    id: 'layer-gcode',
    path: 'src/libslic3r/GCode.cpp',
    role: 'gcode',
    anchors: [
      'case CalibMode::Calib_PA_Tower',
      'case CalibMode::Calib_Temp_Tower',
      'case CalibMode::Calib_VFA_Tower',
      'case CalibMode::Calib_Vol_speed_Tower',
      'case CalibMode::Calib_Retraction_tower',
      'case CalibMode::Calib_Input_shaping_freq',
      'case CalibMode::Calib_Input_shaping_damp',
      'case CalibMode::Calib_Junction_Deviation',
      'writer().set_junction_deviation',
    ],
  },
  {
    id: 'calib-core',
    path: 'src/libslic3r/calib.cpp',
    role: 'gcode',
    anchors: ['CalibPressureAdvanceLine', 'CalibPressureAdvancePattern'],
  },
  {
    id: 'calib-utils',
    path: 'src/slic3r/Utils/CalibUtils.cpp',
    role: 'workflow',
    anchors: [
      '/calib/pressure_advance/pa_pattern.3mf',
      'validate_input_k_value',
      'validate_input_flow_ratio',
      'params.mode = CalibMode::Calib_Flow_Rate',
    ],
  },
  {
    id: 'device-start-gates',
    path: 'src/slic3r/GUI/CalibrationWizardStartPage.cpp',
    role: 'device-gate',
    anchors: [
      '!obj->is_support_pa_calibration',
      '!obj->is_support_flow_calibration',
      'PrinterSeries::SERIES_X1',
      'obj->cali_version',
    ],
  },
  {
    id: 'device-preset-gates',
    path: 'src/slic3r/GUI/CalibrationWizardPresetPage.cpp',
    role: 'device-gate',
    anchors: [
      'obj_->is_connecting() || !obj_->is_connected()',
      'obj_->is_in_printing()',
      '!obj_->is_support_print_without_sd',
      'obj_->is_lan_mode_printer()',
    ],
  },
  {
    id: 'device-firmware-gate',
    path: 'src/slic3r/GUI/CalibrationWizardPage.cpp',
    role: 'device-gate',
    anchors: ['The current firmware version of the printer does not support calibration.'],
  },
  {
    id: 'wizard-results',
    path: 'src/slic3r/GUI/CalibrationWizardSavePage.cpp',
    role: 'results',
    anchors: ['_L("Factor K")', '_L("Flow Ratio")', 'item.n_coef', 'item.flow_ratio'],
  },
  {
    id: 'tolerance-doc',
    path: 'doc/calibration/tolerance-calib.md',
    role: 'extension',
    anchors: [
      '# Filament Tolerance Calibration',
      '0.0 mm, 0.05 mm, 0.1 mm, 0.2 mm, 0.3 mm, and 0.4 mm',
      'X-Y hole compensation',
      'X-Y contour compensation',
    ],
  },
  {
    id: 'handy-model-menu',
    path: 'src/slic3r/GUI/GUI_Factories.cpp',
    role: 'extension',
    anchors: ['L("Orca Tolerance Test")', 'OrcaToleranceTest.stl'],
  },
];

const sourceTexts = new Map();
for (const source of sourceSpecs) {
  const text = pinnedText(source.path);
  sourceTexts.set(source.id, text);
  for (const anchor of source.anchors) {
    assertIncludes(text, anchor, `${source.path} (${source.id})`);
  }
}

function parseCalibModes(source) {
  const enumMatch = source.match(/enum class CalibMode\s*:\s*int\s*\{([\s\S]*?)\};/);
  if (!enumMatch) throw new Error('Unable to parse CalibMode from the pinned calib.hpp blob');

  const body = enumMatch[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let nextValue = 0;
  const entries = body
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(Calib_[A-Za-z0-9_]+)(?:\s*=\s*(-?\d+))?$/);
      if (!match) throw new Error(`Unsupported CalibMode entry: ${JSON.stringify(entry)}`);
      if (match[2] !== undefined) nextValue = Number.parseInt(match[2], 10);
      const parsed = { name: match[1], value: nextValue };
      nextValue++;
      return parsed;
    });
  return entries;
}

const allModes = parseCalibModes(sourceTexts.get('calib-mode'));
assertEqual(allModes[0], { name: 'Calib_None', value: 0 }, 'CalibMode sentinel');
const modes = allModes.slice(1);
const expectedModes = [
  'Calib_PA_Line',
  'Calib_PA_Pattern',
  'Calib_PA_Tower',
  'Calib_Flow_Rate',
  'Calib_Temp_Tower',
  'Calib_Vol_speed_Tower',
  'Calib_VFA_Tower',
  'Calib_Retraction_tower',
  'Calib_Input_shaping_freq',
  'Calib_Input_shaping_damp',
  'Calib_Junction_Deviation',
];
assertEqual(
  modes.map((mode) => mode.name),
  expectedModes,
  'non-None CalibMode definitions',
);
assertEqual(
  modes.map((mode) => mode.value),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'CalibMode numeric values',
);

const parity = JSON.parse(readFileSync(parityPath, 'utf8'));
assertEqual(parity.upstream?.commit, PINNED_COMMIT, 'parity inventory commit');
assertEqual(parity.counts?.calibrationFlows, 11, 'parity calibration flow count');
const parityFlows = parity.inventory?.calibrationFlows;
if (!Array.isArray(parityFlows)) throw new Error('Parity calibrationFlows must be an array');
assertEqual([...parityFlows.map((flow) => flow.mode)].sort(), [...expectedModes].sort(), 'parity calibration modes');
const enumBlob = pinnedBlob('src/libslic3r/calib.hpp');
for (const flow of parityFlows) {
  assertEqual(flow.disposition?.id, 'P8.1', `parity disposition for ${flow.mode}`);
  assertEqual(flow.sources?.[0]?.path, 'src/libslic3r/calib.hpp', `parity source path for ${flow.mode}`);
  assertEqual(flow.sources?.[0]?.blob, enumBlob, `parity source blob for ${flow.mode}`);
}

const mainMenu = sourceTexts.get('main-menu');
const flowCalls = [...mainMenu.matchAll(/calib_flowrate\((true|false),\s*([12])\)/g)].map(
  (match) => `${match[1]}:${match[2]}`,
);
assertEqual(
  [...new Set(flowCalls)].sort(),
  ['false:1', 'false:2', 'true:1', 'true:2'],
  'unique flow-rate menu invocations',
);
for (const call of new Set(flowCalls)) {
  assertEqual(
    flowCalls.filter((candidate) => candidate === call).length,
    2,
    `platform menu copies for calib_flowrate(${call})`,
  );
}
const pressureMethods = sourceTexts
  .get('dialogs')
  .match(/m_rbMethod\s*=\s*new RadioGroup\(this,\s*\{([^}]+)\}/)?.[1]
  ?.match(/_L\("([^"]+)"\)/g)
  ?.map((value) => value.slice(4, -2));
assertEqual(pressureMethods, ['PA Tower', 'PA Line', 'PA Pattern'], 'pressure-advance dialog methods');

const actionSource = readFileSync(actionSourcePath, 'utf8');
const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
const actionBindings = new Map(
  [...actionSource.matchAll(/id:\s*'([^']+)'[\s\S]*?run:\s*\(ctx\)\s*=>\s*ctx\.addCalibration\('([^']+)'\),/g)].map(
    (match) => [match[1], match[2]],
  ),
);
const expectedActionBindings = {
  calib_temperature: 'tower',
  calib_flow_pass1: 'flow_pass1',
  calib_flow_pass2: 'flow_pass2',
  calib_flow_yolo: 'flow_yolo',
  calib_flow_yolo_perfectionist: 'flow_yolo_perfectionist',
  calib_pressure_advance: 'pressure_advance',
  calib_retraction: 'retraction',
  calib_max_flow: 'max_flow',
  calib_vfa: 'vfa',
  calib_tolerance: 'tolerance',
  calib_junction_deviation: 'junction_deviation',
  calib_input_shaping_frequency: 'input_shaping_frequency',
  calib_input_shaping_damping: 'input_shaping_damping',
};
assertEqual(Object.fromEntries(actionBindings), expectedActionBindings, 'current local calibration action bindings');
assertIncludes(workspaceSource, 'new CalibrationRampGenerator()', 'local alpha calibration generator');
for (const argument of Object.values(expectedActionBindings)) {
  assertIncludes(workspaceSource, `case '${argument}':`, `local calibration case ${argument}`);
}

function resource(path, role = 'model') {
  return { path, blob: pinnedBlob(path), role };
}

function effect(category, detail) {
  return { category, detail };
}

function resultField(key, label, unit = null, required = true) {
  return { key, label, unit, required };
}

function presetTarget(scope, key, application = 'manual') {
  return { scope, key, application };
}

function parameter({
  key,
  label,
  kind,
  unit = null,
  defaultValue,
  choices = [],
  editable = true,
  enabledWhen = null,
  constraints = [],
}) {
  return {
    key,
    label,
    kind,
    unit,
    default: defaultValue,
    choices,
    editable,
    enabledWhen,
    constraints,
  };
}

function localBinding(actionId) {
  if (actionId === null) {
    return {
      actionId: null,
      argument: null,
      status: 'unbound',
      detail: 'No current ActionRegistry action exposes this distinct pinned workflow.',
    };
  }
  const argument = actionBindings.get(actionId);
  if (!argument) throw new Error(`Missing parsed local action binding for ${actionId}`);
  return {
    actionId,
    argument,
    status: 'alpha-geometry-only',
    detail:
      'The action only adds CalibrationRampGenerator geometry; pinned resources, dialog validation, calibration effects, result capture, and preset application are not implemented.',
  };
}

const manualDeviceGate = {
  automation: 'manual-only',
  requirements: [],
  orcaxrStatus: 'local-generation-does-not-require-device',
};

function proprietaryDeviceGate(capability) {
  return {
    automation: 'bambu-proprietary-auto',
    requirements: [
      'A selected connected upstream MachineObject',
      'Supported Bambu printer series and calibration firmware version',
      `MachineObject.${capability} == true`,
      'Vendor device protocol, result retrieval, and save workflow',
    ],
    orcaxrStatus: 'blocked-proprietary-auto',
  };
}

function paParameters(method, ddeEnd, ddeStep, printNumbers, printNumbersEditable, listsEditable) {
  return [
    parameter({
      key: 'extruderType',
      label: 'Extruder type',
      kind: 'choice',
      defaultValue: 'DDE',
      choices: ['DDE', 'Bowden'],
    }),
    parameter({
      key: 'method',
      label: 'Method',
      kind: 'choice',
      defaultValue: method,
      choices: [method],
      editable: false,
    }),
    parameter({
      key: 'start',
      label: 'Start PA',
      kind: 'number',
      defaultValue: 0,
      constraints: ['finite number', 'start >= 0'],
    }),
    parameter({
      key: 'end',
      label: 'End PA',
      kind: 'number',
      defaultValue: { DDE: ddeEnd, Bowden: 1 },
      constraints: ['finite number', 'end >= start + step'],
    }),
    parameter({
      key: 'step',
      label: 'PA step',
      kind: 'number',
      defaultValue: { DDE: ddeStep, Bowden: method === 'PA Pattern' ? 0.05 : 0.02 },
      constraints: ['finite number', 'step >= EPSILON'],
    }),
    parameter({
      key: 'printNumbers',
      label: 'Print numbers',
      kind: 'boolean',
      defaultValue: printNumbers,
      editable: printNumbersEditable,
    }),
    parameter({
      key: 'accelerations',
      label: 'Accelerations',
      kind: 'positive-integer-list',
      unit: 'mm/s²',
      defaultValue: [],
      editable: listsEditable,
      enabledWhen: listsEditable ? 'method == PA Pattern' : null,
      constraints: ['comma-separated integers', 'values > 0', 'empty uses current outer/inner/default acceleration'],
    }),
    parameter({
      key: 'speeds',
      label: 'Speeds',
      kind: 'positive-integer-list',
      unit: 'mm/s',
      defaultValue: [],
      editable: listsEditable,
      enabledWhen: listsEditable ? 'method == PA Pattern' : null,
      constraints: ['comma-separated integers', 'values > 0', 'empty uses calculated optimal PA speed'],
    }),
  ];
}

const flowResult = [resultField('flowRatio', 'Flow ratio')];
const flowTargets = [presetTarget('filament', 'filament_flow_ratio')];
const paResults = [
  resultField('pressureAdvanceK', 'Factor K'),
  resultField('adaptivePressureAdvanceN', 'Factor N', null, false),
];
const paTargets = [presetTarget('filament', 'enable_pressure_advance'), presetTarget('filament', 'pressure_advance')];

const workflows = [
  {
    id: 'temperature-tower',
    origin: 'pinned-menu',
    label: 'Temperature',
    enumMode: 'Calib_Temp_Tower',
    menu: {
      path: ['Calibration', 'Temperature'],
      label: 'Temperature',
      invocation: 'Temp_Calibration_Dlg → Plater::calib_temp',
    },
    parameters: [
      parameter({
        key: 'filamentType',
        label: 'Filament type',
        kind: 'choice',
        defaultValue: 'PLA',
        choices: ['PLA', 'ABS/ASA', 'PETG', 'PCTG', 'TPU', 'PA-CF', 'PET-CF', 'Custom'],
      }),
      parameter({
        key: 'start',
        label: 'Start temp',
        kind: 'number',
        unit: '°C',
        defaultValue: {
          PLA: 230,
          'ABS/ASA': 270,
          PETG: 250,
          PCTG: 280,
          TPU: 240,
          'PA-CF': 320,
          'PET-CF': 320,
          Custom: 230,
        },
        constraints: [
          'unsigned integer',
          'start <= 350',
          'focus loss clamps to 170..350 and floors to a multiple of 5',
        ],
      }),
      parameter({
        key: 'end',
        label: 'End temp',
        kind: 'number',
        unit: '°C',
        defaultValue: {
          PLA: 190,
          'ABS/ASA': 230,
          PETG: 230,
          PCTG: 240,
          TPU: 210,
          'PA-CF': 280,
          'PET-CF': 280,
          Custom: 190,
        },
        constraints: [
          'unsigned integer',
          'end >= 170',
          'end <= start - 5',
          'focus loss clamps to 170..350 and floors to a multiple of 5',
        ],
      }),
      parameter({
        key: 'step',
        label: 'Temp step',
        kind: 'number',
        unit: '°C',
        defaultValue: 5,
        editable: false,
        constraints: ['fixed at 5'],
      }),
    ],
    resources: [resource('resources/calib/temperature_tower/temperature_tower.stl')],
    effects: [
      effect('per-height', 'Sets nozzle temperature to start - floor(print_z / 10.001) × 5.'),
      effect('per-object', 'Cuts the pinned tower to the selected range and applies calibration brim/seam settings.'),
    ],
    resultFields: [resultField('bestNozzleTemperatureC', 'Selected nozzle temperature', '°C')],
    presetTargets: [
      presetTarget('filament', 'nozzle_temperature'),
      presetTarget('filament', 'nozzle_temperature_initial_layer'),
    ],
    localBinding: localBinding('calib_temperature'),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: [],
  },
  {
    id: 'flow-pass-1',
    origin: 'pinned-menu',
    label: 'Flow rate — Pass 1',
    enumMode: 'Calib_Flow_Rate',
    menu: {
      path: ['Calibration', 'Flow rate', 'Pass 1'],
      label: 'Pass 1',
      invocation: 'Plater::calib_flowrate(false, 1)',
    },
    parameters: [
      parameter({
        key: 'linearMode',
        label: 'Linear mode',
        kind: 'boolean',
        defaultValue: false,
        editable: false,
      }),
      parameter({ key: 'pass', label: 'Pass', kind: 'number', defaultValue: 1, editable: false }),
    ],
    resources: [resource('resources/calib/filament_flow/flowrate-test-pass1.3mf', 'template')],
    effects: [
      effect('per-object', 'Reads each flowrate_* object modifier and sets print_flow_ratio to 1 + modifier / 100.'),
    ],
    resultFields: flowResult,
    presetTargets: flowTargets,
    localBinding: localBinding('calib_flow_pass1'),
    deviceGating: proprietaryDeviceGate('is_support_flow_calibration'),
    sourceRefs: ['main-menu', 'plater-workflows', 'calib-utils', 'device-start-gates', 'wizard-results'],
    notes: ['The pinned menu workflow has no parameter dialog.'],
  },
  {
    id: 'flow-pass-2',
    origin: 'pinned-menu',
    label: 'Flow rate — Pass 2',
    enumMode: 'Calib_Flow_Rate',
    menu: {
      path: ['Calibration', 'Flow rate', 'Pass 2'],
      label: 'Pass 2',
      invocation: 'Plater::calib_flowrate(false, 2)',
    },
    parameters: [
      parameter({
        key: 'linearMode',
        label: 'Linear mode',
        kind: 'boolean',
        defaultValue: false,
        editable: false,
      }),
      parameter({ key: 'pass', label: 'Pass', kind: 'number', defaultValue: 2, editable: false }),
    ],
    resources: [resource('resources/calib/filament_flow/flowrate-test-pass2.3mf', 'template')],
    effects: [
      effect('per-object', 'Reads each flowrate_* object modifier and sets print_flow_ratio to 1 + modifier / 100.'),
    ],
    resultFields: flowResult,
    presetTargets: flowTargets,
    localBinding: localBinding('calib_flow_pass2'),
    deviceGating: proprietaryDeviceGate('is_support_flow_calibration'),
    sourceRefs: ['main-menu', 'plater-workflows', 'calib-utils', 'device-start-gates', 'wizard-results'],
    notes: ['The pinned menu workflow has no parameter dialog.'],
  },
  {
    id: 'flow-yolo',
    origin: 'pinned-menu',
    label: 'Flow rate — YOLO (Recommended)',
    enumMode: 'Calib_Flow_Rate',
    menu: {
      path: ['Calibration', 'Flow rate', 'YOLO (Recommended)'],
      label: 'YOLO (Recommended)',
      invocation: 'Plater::calib_flowrate(true, 1)',
    },
    parameters: [
      parameter({
        key: 'linearMode',
        label: 'Linear mode',
        kind: 'boolean',
        defaultValue: true,
        editable: false,
      }),
      parameter({ key: 'pass', label: 'Pass', kind: 'number', defaultValue: 1, editable: false }),
      parameter({
        key: 'modifierStep',
        label: 'Flow-ratio step',
        kind: 'number',
        defaultValue: 0.01,
        editable: false,
      }),
    ],
    resources: [resource('resources/calib/filament_flow/Orca-LinearFlow.3mf', 'template')],
    effects: [
      effect(
        'per-object',
        'Reads each flowrate_* object modifier and sets print_flow_ratio to (current filament flow ratio + modifier) / current filament flow ratio.',
      ),
    ],
    resultFields: flowResult,
    presetTargets: flowTargets,
    localBinding: localBinding('calib_flow_yolo'),
    deviceGating: proprietaryDeviceGate('is_support_flow_calibration'),
    sourceRefs: ['main-menu', 'plater-workflows', 'device-start-gates', 'wizard-results'],
    notes: ['The pinned menu tooltip identifies a 0.01 step; there is no parameter dialog.'],
  },
  {
    id: 'flow-yolo-perfectionist',
    origin: 'pinned-menu',
    label: 'Flow rate — YOLO (perfectionist version)',
    enumMode: 'Calib_Flow_Rate',
    menu: {
      path: ['Calibration', 'Flow rate', 'YOLO (perfectionist version)'],
      label: 'YOLO (perfectionist version)',
      invocation: 'Plater::calib_flowrate(true, 2)',
    },
    parameters: [
      parameter({
        key: 'linearMode',
        label: 'Linear mode',
        kind: 'boolean',
        defaultValue: true,
        editable: false,
      }),
      parameter({ key: 'pass', label: 'Pass', kind: 'number', defaultValue: 2, editable: false }),
      parameter({
        key: 'modifierStep',
        label: 'Flow-ratio step',
        kind: 'number',
        defaultValue: 0.005,
        editable: false,
      }),
    ],
    resources: [resource('resources/calib/filament_flow/Orca-LinearFlow_fine.3mf', 'template')],
    effects: [
      effect(
        'per-object',
        'Reads each flowrate_* object modifier and sets print_flow_ratio to (current filament flow ratio + modifier) / current filament flow ratio.',
      ),
    ],
    resultFields: flowResult,
    presetTargets: flowTargets,
    localBinding: localBinding(null),
    deviceGating: proprietaryDeviceGate('is_support_flow_calibration'),
    sourceRefs: ['main-menu', 'plater-workflows', 'device-start-gates', 'wizard-results'],
    notes: ['The pinned menu tooltip identifies a 0.005 step; there is no parameter dialog.'],
  },
  {
    id: 'pressure-advance-tower',
    origin: 'pinned-menu',
    label: 'Pressure advance — PA Tower',
    enumMode: 'Calib_PA_Tower',
    menu: {
      path: ['Calibration', 'Pressure advance', 'PA Tower'],
      label: 'PA Tower',
      invocation: 'PA_Calibration_Dlg → Plater::calib_pa(Calib_PA_Tower)',
    },
    parameters: paParameters('PA Tower', 0.1, 0.002, false, false, false),
    resources: [resource('resources/calib/pressure_advance/tower_with_seam.stl')],
    effects: [
      effect('per-height', 'Sets pressure advance to start + integer(print_z) × step.'),
      effect('per-object', 'Cuts the tower to the sweep height and applies pinned wall, seam, and brim settings.'),
    ],
    resultFields: paResults,
    presetTargets: paTargets,
    localBinding: localBinding('calib_pressure_advance'),
    deviceGating: proprietaryDeviceGate('is_support_pa_calibration'),
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode', 'device-start-gates', 'wizard-results'],
    notes: ['The implementation accepts step >= EPSILON although its validation message says step >= 0.001.'],
  },
  {
    id: 'pressure-advance-line',
    origin: 'pinned-menu',
    label: 'Pressure advance — PA Line',
    enumMode: 'Calib_PA_Line',
    menu: {
      path: ['Calibration', 'Pressure advance', 'PA Line'],
      label: 'PA Line',
      invocation: 'PA_Calibration_Dlg → Plater::calib_pa(Calib_PA_Line)',
    },
    parameters: paParameters('PA Line', 0.1, 0.002, true, true, false),
    resources: [resource('resources/calib/pressure_advance/pressure_advance_test.stl')],
    effects: [
      effect(
        'generated-gcode',
        'CalibPressureAdvanceLine generates labelled line-test G-code over the selected PA range.',
      ),
    ],
    resultFields: paResults,
    presetTargets: paTargets,
    localBinding: localBinding('calib_pressure_advance'),
    deviceGating: proprietaryDeviceGate('is_support_pa_calibration'),
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'calib-core', 'device-start-gates', 'wizard-results'],
    notes: ['The implementation accepts step >= EPSILON although its validation message says step >= 0.001.'],
  },
  {
    id: 'pressure-advance-pattern',
    origin: 'pinned-menu',
    label: 'Pressure advance — PA Pattern',
    enumMode: 'Calib_PA_Pattern',
    menu: {
      path: ['Calibration', 'Pressure advance', 'PA Pattern'],
      label: 'PA Pattern',
      invocation: 'PA_Calibration_Dlg → Plater::calib_pa(Calib_PA_Pattern)',
    },
    parameters: paParameters('PA Pattern', 0.08, 0.005, true, false, true),
    resources: [resource('resources/calib/pressure_advance/pa_pattern.3mf', 'device-template')],
    effects: [
      effect('per-object', 'Creates and arranges anchor objects with optional per-object speed and acceleration.'),
      effect('generated-gcode', 'CalibPressureAdvancePattern generates and merges custom G-code for every pattern.'),
    ],
    resultFields: paResults,
    presetTargets: paTargets,
    localBinding: localBinding('calib_pressure_advance'),
    deviceGating: proprietaryDeviceGate('is_support_pa_calibration'),
    sourceRefs: [
      'main-menu',
      'dialogs',
      'plater-workflows',
      'calib-core',
      'calib-utils',
      'device-start-gates',
      'wizard-results',
    ],
    notes: [
      'The manual menu path generates pattern geometry/G-code; the pinned pa_pattern.3mf is used by the device-oriented CalibUtils path.',
      'The implementation accepts step >= EPSILON although its validation message says step >= 0.001.',
    ],
  },
  {
    id: 'retraction-tower',
    origin: 'pinned-menu',
    label: 'Retraction test',
    enumMode: 'Calib_Retraction_tower',
    menu: {
      path: ['Calibration', 'Retraction test'],
      label: 'Retraction test',
      invocation: 'Retraction_Test_Dlg → Plater::calib_retraction',
    },
    parameters: [
      parameter({
        key: 'start',
        label: 'Start retraction length',
        kind: 'number',
        unit: 'mm',
        defaultValue: 0,
        constraints: ['finite number', 'start >= 0'],
      }),
      parameter({
        key: 'end',
        label: 'End retraction length',
        kind: 'number',
        unit: 'mm',
        defaultValue: 2,
        constraints: ['finite number', 'end >= start + step'],
      }),
      parameter({
        key: 'step',
        label: 'Step',
        kind: 'number',
        unit: 'mm',
        defaultValue: 0.1,
        constraints: ['finite number', 'step > 0'],
      }),
    ],
    resources: [resource('resources/calib/retraction/retraction_tower.stl')],
    effects: [
      effect('per-height', 'Sets retraction_length to start + floor(max(0, print_z - 0.4)) × step.'),
      effect('per-object', 'Cuts the tower to the sweep height and applies two-wall, hollow calibration settings.'),
    ],
    resultFields: [resultField('retractionLengthMm', 'Selected retraction length', 'mm')],
    presetTargets: [presetTarget('printer', 'retraction_length')],
    localBinding: localBinding('calib_retraction'),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: ['The implementation permits start == 0 and requires step > 0 despite the dialog message wording.'],
  },
  {
    id: 'max-volumetric-speed',
    origin: 'pinned-menu',
    label: 'Max flowrate',
    enumMode: 'Calib_Vol_speed_Tower',
    menu: {
      path: ['Calibration', 'Max flowrate'],
      label: 'Max flowrate',
      invocation: 'MaxVolumetricSpeed_Test_Dlg → Plater::calib_max_vol_speed',
    },
    parameters: [
      parameter({
        key: 'start',
        label: 'Start volumetric speed',
        kind: 'number',
        unit: 'mm³/s',
        defaultValue: 5,
        constraints: ['finite number', 'start > 0'],
      }),
      parameter({
        key: 'end',
        label: 'End volumetric speed',
        kind: 'number',
        unit: 'mm³/s',
        defaultValue: 20,
        constraints: ['finite number', 'end >= start + step'],
      }),
      parameter({
        key: 'step',
        label: 'Step',
        kind: 'number',
        unit: 'mm³/s',
        defaultValue: 0.5,
        constraints: ['finite number', 'step > 0'],
      }),
    ],
    resources: [resource('resources/calib/volumetric_speed/SpeedTestStructure.step')],
    effects: [
      effect(
        'per-height',
        'Converts the volumetric sweep through line flow and sets rounded outer_wall_speed to start + print_z × step.',
      ),
      effect('per-object', 'Scales/cuts the tower for the bed and applies single-wall spiral calibration settings.'),
    ],
    resultFields: [resultField('maxVolumetricSpeedMm3PerS', 'Maximum acceptable volumetric speed', 'mm³/s')],
    presetTargets: [presetTarget('filament', 'filament_max_volumetric_speed')],
    localBinding: localBinding('calib_max_flow'),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: ['The implementation requires step > 0 despite the dialog message saying step >= 0.'],
  },
  {
    id: 'junction-deviation',
    origin: 'pinned-menu',
    label: 'Junction Deviation',
    enumMode: 'Calib_Junction_Deviation',
    menu: {
      path: ['Calibration', 'Cornering', 'Junction Deviation'],
      label: 'Junction Deviation',
      invocation: 'Junction_Deviation_Test_Dlg → Plater::calib_junction_deviation',
    },
    parameters: [
      parameter({
        key: 'testModel',
        label: 'Test model',
        kind: 'choice',
        defaultValue: 'Ringing Tower',
        choices: ['Ringing Tower', 'Fast Tower'],
      }),
      parameter({
        key: 'start',
        label: 'Start junction deviation',
        kind: 'number',
        unit: 'mm',
        defaultValue: 0,
        constraints: ['finite number', 'start >= 0', 'start < end'],
      }),
      parameter({
        key: 'end',
        label: 'End junction deviation',
        kind: 'number',
        unit: 'mm',
        defaultValue: 0.25,
        constraints: ['finite number', 'end < 1', 'end > start', 'end > 0.3 displays a layer-shift warning'],
      }),
    ],
    resources: [
      resource('resources/calib/input_shaping/ringing_tower.stl'),
      resource('resources/calib/input_shaping/fast_tower_test.stl'),
    ],
    effects: [
      effect('per-height', 'Interpolates junction deviation from start to end using layer index / layer count.'),
      effect('per-object', 'Applies single-wall spiral settings and disables competing PA/resonance effects.'),
    ],
    resultFields: [resultField('junctionDeviationMm', 'Selected junction deviation', 'mm')],
    presetTargets: [presetTarget('process', 'default_junction_deviation')],
    localBinding: localBinding(null),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: [],
  },
  {
    id: 'input-shaping-frequency',
    origin: 'pinned-menu',
    label: 'Input Shaping Frequency',
    enumMode: 'Calib_Input_shaping_freq',
    menu: {
      path: ['Calibration', 'Input Shaping', 'Input Shaping Frequency'],
      label: 'Input Shaping Frequency',
      invocation: 'Input_Shaping_Freq_Test_Dlg → Plater::calib_input_shaping_freq',
    },
    parameters: [
      parameter({
        key: 'testModel',
        label: 'Test model',
        kind: 'choice',
        defaultValue: 'Ringing Tower',
        choices: ['Ringing Tower', 'Fast Tower'],
      }),
      parameter({
        key: 'freqStartX',
        label: 'X start',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 15,
        constraints: ['finite number', 'freqStartX >= 0', 'freqStartX < freqEndX'],
      }),
      parameter({
        key: 'freqEndX',
        label: 'X end',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 110,
        constraints: ['finite number', 'freqEndX <= 500', 'freqEndX > freqStartX'],
      }),
      parameter({
        key: 'freqStartY',
        label: 'Y start',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 15,
        constraints: ['finite number', 'freqStartY >= 0', 'freqStartY < freqEndY'],
      }),
      parameter({
        key: 'freqEndY',
        label: 'Y end',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 110,
        constraints: [
          'finite number',
          'freqEndY > freqStartY',
          'pinned implementation accidentally rechecks freqEndX, so freqEndY has no enforced 500 Hz ceiling',
        ],
      }),
      parameter({
        key: 'damping',
        label: 'Damp',
        kind: 'number',
        defaultValue: 0.15,
        constraints: ['finite number', 'damping >= 0', 'damping < 1'],
      }),
    ],
    resources: [
      resource('resources/calib/input_shaping/ringing_tower.stl'),
      resource('resources/calib/input_shaping/fast_tower_test.stl'),
    ],
    effects: [
      effect(
        'per-height',
        'Emits the damping setup on layer 1, then linearly interpolates X/Y (or combined A) shaping frequency.',
      ),
      effect('per-object', 'Applies single-wall spiral settings and disables competing PA/resonance effects.'),
    ],
    resultFields: [
      resultField('frequencyXHz', 'Selected X input-shaper frequency', 'Hz'),
      resultField('frequencyYHz', 'Selected Y input-shaper frequency', 'Hz'),
    ],
    presetTargets: [
      presetTarget('firmware', 'input_shaper.frequency_x', 'manual-transfer'),
      presetTarget('firmware', 'input_shaper.frequency_y', 'manual-transfer'),
    ],
    localBinding: localBinding(null),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: [
      'The dialog recommends damping 0 but initializes 0.15.',
      'The implementation accepts a zero start frequency and damping 0, contrary to its warning text.',
    ],
  },
  {
    id: 'input-shaping-damping',
    origin: 'pinned-menu',
    label: 'Input Shaping Damping/zeta factor',
    enumMode: 'Calib_Input_shaping_damp',
    menu: {
      path: ['Calibration', 'Input Shaping', 'Input Shaping Damping/zeta factor'],
      label: 'Input Shaping Damping/zeta factor',
      invocation: 'Input_Shaping_Damp_Test_Dlg → Plater::calib_input_shaping_damp',
    },
    parameters: [
      parameter({
        key: 'testModel',
        label: 'Test model',
        kind: 'choice',
        defaultValue: 'Ringing Tower',
        choices: ['Ringing Tower', 'Fast Tower'],
      }),
      parameter({
        key: 'frequencyX',
        label: 'Frequency X',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 30,
        constraints: ['finite number', '0 <= frequencyX <= 500'],
      }),
      parameter({
        key: 'frequencyY',
        label: 'Frequency Y',
        kind: 'number',
        unit: 'Hz',
        defaultValue: 30,
        constraints: ['finite number', '0 <= frequencyY <= 500'],
      }),
      parameter({
        key: 'start',
        label: 'Damp start',
        kind: 'number',
        defaultValue: 0,
        constraints: ['finite number', 'start >= 0', 'start < end'],
      }),
      parameter({
        key: 'end',
        label: 'Damp end',
        kind: 'number',
        defaultValue: 0.4,
        constraints: ['finite number', 'end <= 1', 'end > start'],
      }),
    ],
    resources: [
      resource('resources/calib/input_shaping/ringing_tower.stl'),
      resource('resources/calib/input_shaping/fast_tower_test.stl'),
    ],
    effects: [
      effect(
        'per-height',
        'Emits fixed X/Y frequencies on layer 1, then linearly interpolates the combined damping factor.',
      ),
      effect('per-object', 'Applies single-wall spiral settings and disables competing PA/resonance effects.'),
    ],
    resultFields: [resultField('dampingRatio', 'Selected damping/zeta factor')],
    presetTargets: [presetTarget('firmware', 'input_shaper.damping_ratio', 'manual-transfer')],
    localBinding: localBinding(null),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: ['Zero frequency is accepted by the implementation despite the dialog warning text.'],
  },
  {
    id: 'vfa',
    origin: 'pinned-menu',
    label: 'VFA',
    enumMode: 'Calib_VFA_Tower',
    menu: {
      path: ['Calibration', 'VFA'],
      label: 'VFA',
      invocation: 'VFA_Test_Dlg → Plater::calib_VFA',
    },
    parameters: [
      parameter({
        key: 'start',
        label: 'Start speed',
        kind: 'number',
        unit: 'mm/s',
        defaultValue: 40,
        constraints: ['finite number', 'start > 10'],
      }),
      parameter({
        key: 'end',
        label: 'End speed',
        kind: 'number',
        unit: 'mm/s',
        defaultValue: 200,
        constraints: ['finite number', 'end >= start + step'],
      }),
      parameter({
        key: 'step',
        label: 'Step',
        kind: 'number',
        unit: 'mm/s',
        defaultValue: 10,
        constraints: ['finite number', 'step > 0'],
      }),
    ],
    resources: [resource('resources/calib/vfa/VFA.stl')],
    effects: [
      effect('per-height', 'Sets rounded outer_wall_speed to start + floor(print_z / 5) × step.'),
      effect('per-object', 'Cuts the VFA model and applies single-wall spiral calibration settings.'),
    ],
    resultFields: [
      resultField('artifactFreeSpeedMinMmPerS', 'Artifact-free speed range minimum', 'mm/s'),
      resultField('artifactFreeSpeedMaxMmPerS', 'Artifact-free speed range maximum', 'mm/s'),
    ],
    presetTargets: [presetTarget('process', 'outer_wall_speed'), presetTarget('process', 'inner_wall_speed')],
    localBinding: localBinding('calib_vfa'),
    deviceGating: manualDeviceGate,
    sourceRefs: ['main-menu', 'dialogs', 'plater-workflows', 'layer-gcode'],
    notes: ['The implementation requires step > 0 despite the dialog message saying step >= 0.'],
  },
  {
    id: 'tolerance-extension',
    origin: 'documented-extension',
    label: 'Orca Tolerance Test',
    enumMode: null,
    menu: null,
    parameters: [
      parameter({
        key: 'testClearances',
        label: 'Model clearances',
        kind: 'number-list',
        unit: 'mm',
        defaultValue: [0, 0.05, 0.1, 0.2, 0.3, 0.4],
        editable: false,
        constraints: ['fixed by the documented model'],
      }),
    ],
    resources: [resource('resources/handy_models/OrcaToleranceTest.stl')],
    effects: [
      effect(
        'per-object',
        'Prints a documented six-clearance fit model; no CalibMode or calibration G-code effect exists.',
      ),
    ],
    resultFields: [
      resultField('passingClearanceMm', 'Smallest freely fitting clearance', 'mm'),
      resultField('xyHoleCompensationMm', 'Derived X-Y hole compensation', 'mm', false),
      resultField('xyContourCompensationMm', 'Derived X-Y contour compensation', 'mm', false),
    ],
    presetTargets: [
      presetTarget('process', 'xy_hole_compensation'),
      presetTarget('process', 'xy_contour_compensation'),
    ],
    localBinding: localBinding('calib_tolerance'),
    deviceGating: manualDeviceGate,
    sourceRefs: ['tolerance-doc', 'handy-model-menu'],
    notes: [
      'This is deliberately outside CalibMode and the 14 pinned Calibration-menu variants.',
      'Upstream exposes the model through Add Handy Model and documents manual caliper/fit evaluation.',
    ],
  },
];

assertEqual(workflows.filter((workflow) => workflow.origin === 'pinned-menu').length, 14, 'pinned menu variant count');
assertEqual(
  workflows.filter((workflow) => workflow.origin === 'documented-extension').map((workflow) => workflow.id),
  ['tolerance-extension'],
  'documented non-enum extensions',
);

/**
 * Where each workflow is documented upstream (P8.3).
 *
 * The mapping is editorial — upstream does not link a guide from the menu — so
 * it is authored here and then *proved*: every path is resolved to a Git blob
 * at the pinned commit, which fails outright if the file is not there. Emitting
 * the result into the inventory is what lets a checkout without the upstream
 * clone verify the same links, because a blob id could only have come from the
 * tree.
 */
const documentationSpecs = [
  { workflowId: 'temperature-tower', file: 'temp-calib.md' },
  { workflowId: 'flow-pass-1', file: 'flow-rate-calib.md' },
  { workflowId: 'flow-pass-2', file: 'flow-rate-calib.md' },
  { workflowId: 'flow-yolo', file: 'flow-rate-calib.md' },
  { workflowId: 'flow-yolo-perfectionist', file: 'flow-rate-calib.md' },
  { workflowId: 'pressure-advance-tower', file: 'pressure-advance-calib.md' },
  { workflowId: 'pressure-advance-line', file: 'pressure-advance-calib.md' },
  { workflowId: 'pressure-advance-pattern', file: 'adaptive-pressure-advance-calib.md' },
  { workflowId: 'retraction-tower', file: 'retraction-calib.md' },
  { workflowId: 'max-volumetric-speed', file: 'volumetric-speed-calib.md' },
  { workflowId: 'junction-deviation', file: 'cornering-calib.md' },
  { workflowId: 'input-shaping-frequency', file: 'input-shaping-calib.md' },
  { workflowId: 'input-shaping-damping', file: 'input-shaping-calib.md' },
  { workflowId: 'vfa', file: 'vfa-calib.md' },
  { workflowId: 'tolerance-extension', file: 'tolerance-calib.md' },
];

assertEqual(
  documentationSpecs.map((spec) => spec.workflowId).sort(),
  workflows.map((workflow) => workflow.id).sort(),
  'documented workflow coverage',
);

const documentation = documentationSpecs.map((spec) => {
  const path = `doc/calibration/${spec.file}`;
  return { workflowId: spec.workflowId, path, blob: pinnedBlob(path) };
});

const mappedModeCounts = Object.fromEntries(expectedModes.map((mode) => [mode, 0]));
for (const workflow of workflows) {
  if (workflow.enumMode !== null) mappedModeCounts[workflow.enumMode]++;
}
assertEqual(
  mappedModeCounts,
  {
    Calib_PA_Line: 1,
    Calib_PA_Pattern: 1,
    Calib_PA_Tower: 1,
    Calib_Flow_Rate: 4,
    Calib_Temp_Tower: 1,
    Calib_Vol_speed_Tower: 1,
    Calib_VFA_Tower: 1,
    Calib_Retraction_tower: 1,
    Calib_Input_shaping_freq: 1,
    Calib_Input_shaping_damp: 1,
    Calib_Junction_Deviation: 1,
  },
  'workflow coverage by CalibMode',
);

const catalog = {
  schemaVersion: 1,
  upstream: {
    repository: UPSTREAM_REPOSITORY,
    commit: PINNED_COMMIT,
    tree: pinnedTree,
  },
  modeSource: {
    sourceId: 'calib-mode',
    path: 'src/libslic3r/calib.hpp',
    blob: enumBlob,
    parityPath: 'docs/parity/snapmaker-v2.3.4.json',
    parityTask: 'P8.1',
    excludedMode: 'Calib_None',
    count: modes.length,
  },
  modes,
  sources: sourceSpecs.map(({ id, path, role }) => ({ id, path, blob: pinnedBlob(path), role })),
  effectCategories: [
    {
      id: 'per-height',
      description: 'The calibration value changes by print height or layer in the normal slicer G-code path.',
    },
    {
      id: 'per-object',
      description: 'Objects or their effective print settings carry distinct calibration behavior.',
    },
    {
      id: 'generated-gcode',
      description: 'A dedicated generator emits standalone or custom calibration G-code.',
    },
  ],
  workflows,
  documentation,
  deviceAutomation: {
    orcaxrPolicy: 'manual-only',
    supportedTransport: 'moonraker',
    unavailableTransports: ['vendor-cloud', 'serial', 'usb'],
    targetPrinters: ['Snapmaker U1', 'Elegoo Centauri Carbon'],
    gates: [
      {
        id: 'pressure-advance-auto',
        workflowIds: ['pressure-advance-tower', 'pressure-advance-line', 'pressure-advance-pattern'],
        upstreamRequirements: [
          'selected connected MachineObject',
          'Bambu X1 printer series for the automatic control',
          'is_support_pa_calibration',
          'compatible cali_version / firmware',
          'vendor result retrieval and save APIs',
        ],
        orcaxrDecision:
          'Unavailable: OrcaXR has no Bambu vendor-cloud/device protocol and must not present this automatic path as supported.',
      },
      {
        id: 'flow-rate-auto',
        workflowIds: ['flow-pass-1', 'flow-pass-2', 'flow-yolo', 'flow-yolo-perfectionist'],
        upstreamRequirements: [
          'selected connected MachineObject',
          'Bambu X1 printer series for the automatic control',
          'is_support_flow_calibration',
          'compatible cali_version / firmware',
          'Micro-Lidar-compatible material and vendor result APIs',
        ],
        orcaxrDecision:
          'Unavailable: OrcaXR has no Bambu Micro-Lidar/vendor result protocol; manual model workflows remain separate.',
      },
      {
        id: 'device-print-dispatch',
        workflowIds: [],
        upstreamRequirements: [
          'connected and idle printer',
          'printer not upgrading or force-upgrade blocked',
          'compatible filament',
          'SD card when the printer or LAN path requires it',
        ],
        orcaxrDecision:
          'Not inherited: any future Moonraker calibration dispatch requires OrcaXR-owned P9 safety and capability checks.',
      },
    ],
  },
  localImplementation: {
    actionSource: 'src/actions/groups/calibration.ts',
    workspaceSource: 'src/workspace/OrcaWorkspace.ts',
    generatorSource: 'src/features/CalibrationRampGenerator.ts',
    statusMeaning: {
      'alpha-geometry-only':
        'A real action adds locally generated geometry, but does not implement the pinned calibration workflow.',
      unbound: 'No distinct current ActionRegistry binding exists.',
    },
  },
};

const rendered = `${JSON.stringify(catalog, null, 2)}\n`;
if (checkOnly) {
  let current;
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    throw new Error(`Missing generated calibration inventory: ${outputPath}`);
  }
  if (current !== rendered) {
    throw new Error(
      'Generated calibration inventory is stale. Run `npm --prefix web run calibration:sync` and commit the result.',
    );
  }
  console.log('Calibration inventory matches exact pinned Git blobs and current local action bindings.');
} else {
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${outputPath}`);
}

/** Integrity check for the committed inventory when upstream is unavailable. */
function verifyCommittedInventory() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch (error) {
    console.error(`Generated calibration inventory is missing or malformed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const problems = [];
  if (parsed?.schemaVersion !== 1) problems.push('schemaVersion is not 1');
  if (parsed?.upstream?.commit !== PINNED_COMMIT) {
    problems.push(`upstream commit is ${parsed?.upstream?.commit} instead of ${PINNED_COMMIT}`);
  }
  if (!Array.isArray(parsed?.workflows) || parsed.workflows.length === 0) problems.push('no workflows are present');
  if (!Array.isArray(parsed?.modes) || parsed.modes.length === 0) problems.push('no calibration modes are present');
  for (const source of parsed?.sources ?? []) {
    if (!/^[0-9a-f]{40}$/.test(source?.blob ?? '')) problems.push(`source ${source?.id} has no pinned blob hash`);
  }
  // The blobs below are what a checkout without the upstream clone verifies
  // against: the shipped calibration geometry is hashed on load and compared to
  // `resources[].blob`, and the documentation links are compared to
  // `documentation[].path`. A Git blob id could only have been produced from
  // the pinned tree, so a malformed one means the artifact was not generated.
  for (const workflow of parsed?.workflows ?? []) {
    for (const resource of workflow?.resources ?? []) {
      if (!/^[0-9a-f]{40}$/.test(resource?.blob ?? '')) {
        problems.push(`resource ${resource?.path} of ${workflow?.id} has no pinned blob hash`);
      }
    }
  }
  if (!Array.isArray(parsed?.documentation) || parsed.documentation.length === 0) {
    problems.push('no documentation targets are recorded');
  }
  for (const entry of parsed?.documentation ?? []) {
    if (!/^[0-9a-f]{40}$/.test(entry?.blob ?? '')) {
      problems.push(`documentation target ${entry?.path} has no pinned blob hash`);
    }
    if (!/^doc\/calibration\/[a-z0-9-]+\.md$/.test(entry?.path ?? '')) {
      problems.push(`documentation target ${entry?.path} is not an upstream calibration guide`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `Committed calibration inventory failed verification:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Calibration inventory: ${parsed.workflows.length} workflows, ${parsed.modes.length} modes and ` +
      `${parsed.documentation.length} documentation targets recorded at ${PINNED_COMMIT} ` +
      '(upstream re-derivation skipped: no pinned checkout).',
  );
}
