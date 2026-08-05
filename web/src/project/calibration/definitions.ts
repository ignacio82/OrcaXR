import { contentDigest } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import {
  CALIBRATION_WORKFLOW_IDS,
  PINNED_CALIBRATION_COMMIT,
  calibrationInventory,
  type CalibrationParameter,
  type CalibrationWorkflow,
  type CalibrationWorkflowId,
  type JsonValue,
} from '../../features/calibrationInventory';
import {
  CALIBRATION_JOB_DEFINITION_VERSION,
  CALIBRATION_JOB_SCHEMA_VERSION,
  type CalibrationFirmwareCapability,
  type CalibrationFirmwareFlavor,
  type CalibrationJobDefinition,
  type CalibrationNumericRange,
  type CalibrationParameterDefinition,
  type CalibrationParameterValue,
  type CalibrationPlanEffectKind,
} from './types';

interface WorkflowDefinitionSpec {
  readonly effectKind: CalibrationPlanEffectKind;
  readonly geometryKind: CalibrationJobDefinition['geometry']['kind'];
  readonly sourceEnvelopeMm: readonly [number, number, number];
  readonly zTrimmable: boolean;
  readonly minBuildHeightMm: number;
  readonly minMaxPrintSpeedMmPerS?: number;
  readonly minMaxAccelerationMmPerS2?: number;
  readonly nozzleTemperature?: boolean;
  readonly filamentTemperature?: boolean;
  readonly filamentFlowRatio?: boolean;
  readonly filamentMaxVolumetricSpeed?: boolean;
  readonly filamentRetractionLength?: boolean;
  readonly processLayerHeight?: boolean;
  readonly processLineWidth?: boolean;
  readonly processOuterWallSpeed?: boolean;
  readonly processAcceleration?: boolean;
  readonly processXyCompensation?: boolean;
  readonly firmwareFlavors?: readonly CalibrationFirmwareFlavor[];
  readonly firmwareCapabilities?: readonly CalibrationFirmwareCapability[];
}

/**
 * Source envelopes were audited directly from the pinned blobs. STEP bounds
 * use all CARTESIAN_POINT entities; 3MF bounds include build transforms.
 * They are conservative fit inputs, not claims that generation is complete.
 */
const WORKFLOW_SPECS = {
  'temperature-tower': spec('band', 'resource', [44.488, 10.001, 370], 10, {
    zTrimmable: true,
    nozzleTemperature: true,
    filamentTemperature: true,
    processLayerHeight: true,
    firmwareCapabilities: ['nozzle-temperature'],
  }),
  'flow-pass-1': spec('object', 'resource', [124, 94, 2], 2, {
    filamentFlowRatio: true,
    processLayerHeight: true,
  }),
  'flow-pass-2': spec('object', 'resource', [124, 126, 2], 2, {
    filamentFlowRatio: true,
    processLayerHeight: true,
  }),
  'flow-yolo': spec('object', 'resource', [123, 94, 2], 2, {
    filamentFlowRatio: true,
    processLayerHeight: true,
  }),
  'flow-yolo-perfectionist': spec('object', 'resource', [123, 125, 2], 2, {
    filamentFlowRatio: true,
    processLayerHeight: true,
  }),
  'pressure-advance-tower': spec('band', 'resource', [70, 70, 60], 2, {
    zTrimmable: true,
    filamentFlowRatio: true,
    processLayerHeight: true,
    firmwareCapabilities: ['pressure-advance'],
  }),
  'pressure-advance-line': spec('line', 'hybrid', [67.973, 14.266, 0.201], 1, {
    filamentFlowRatio: true,
    processLayerHeight: true,
    processLineWidth: true,
    firmwareCapabilities: ['pressure-advance'],
  }),
  'pressure-advance-pattern': spec('line', 'hybrid', [5, 5, 0.85], 1, {
    filamentFlowRatio: true,
    processLayerHeight: true,
    processLineWidth: true,
    processAcceleration: true,
    firmwareCapabilities: ['pressure-advance'],
  }),
  'retraction-tower': spec('band', 'resource', [40, 15, 80.401], 2, {
    zTrimmable: true,
    filamentRetractionLength: true,
    processLayerHeight: true,
  }),
  'max-volumetric-speed': spec('band', 'resource', [190.006, 171, 280.001], 2, {
    zTrimmable: true,
    filamentFlowRatio: true,
    filamentMaxVolumetricSpeed: true,
    processLayerHeight: true,
    processLineWidth: true,
    processOuterWallSpeed: true,
  }),
  'junction-deviation': spec('band', 'resource', [120.001, 120, 60], 2, {
    zTrimmable: true,
    minMaxPrintSpeedMmPerS: 200,
    minMaxAccelerationMmPerS2: 2_000,
    processLayerHeight: true,
    processOuterWallSpeed: true,
    processAcceleration: true,
    firmwareFlavors: ['marlin'],
    firmwareCapabilities: ['junction-deviation'],
  }),
  'input-shaping-frequency': spec('band', 'resource', [120.001, 120, 60], 2, {
    zTrimmable: true,
    minMaxPrintSpeedMmPerS: 200,
    minMaxAccelerationMmPerS2: 2_000,
    processLayerHeight: true,
    processOuterWallSpeed: true,
    processAcceleration: true,
    firmwareCapabilities: ['input-shaping'],
  }),
  'input-shaping-damping': spec('band', 'resource', [120.001, 120, 60], 2, {
    zTrimmable: true,
    minMaxPrintSpeedMmPerS: 200,
    minMaxAccelerationMmPerS2: 2_000,
    processLayerHeight: true,
    processOuterWallSpeed: true,
    processAcceleration: true,
    firmwareCapabilities: ['input-shaping'],
  }),
  vfa: spec('band', 'resource', [112.881, 113.248, 300], 5, {
    zTrimmable: true,
    minMaxPrintSpeedMmPerS: 200,
    processLayerHeight: true,
    processOuterWallSpeed: true,
  }),
  'tolerance-extension': spec('object', 'resource', [57.937, 14.401, 6.401], 6.401, {
    processLayerHeight: true,
    processXyCompensation: true,
  }),
} as const satisfies Readonly<Record<CalibrationWorkflowId, WorkflowDefinitionSpec>>;

function spec(
  effectKind: CalibrationPlanEffectKind,
  geometryKind: CalibrationJobDefinition['geometry']['kind'],
  sourceEnvelopeMm: readonly [number, number, number],
  minBuildHeightMm: number,
  options: Omit<
    Partial<WorkflowDefinitionSpec>,
    'effectKind' | 'geometryKind' | 'sourceEnvelopeMm' | 'minBuildHeightMm'
  >,
): WorkflowDefinitionSpec {
  return {
    effectKind,
    geometryKind,
    sourceEnvelopeMm,
    minBuildHeightMm,
    zTrimmable: false,
    ...options,
  };
}

const ALL_FIRMWARE_FLAVORS = ['klipper', 'marlin', 'reprap'] as const;

function buildDefinition(workflow: CalibrationWorkflow): CalibrationJobDefinition {
  const workflowSpec = WORKFLOW_SPECS[workflow.id];
  const parameters = workflow.parameters.map((parameter) => parameterDefinition(workflow.id, parameter));
  const body = {
    schemaVersion: CALIBRATION_JOB_SCHEMA_VERSION,
    definitionVersion: CALIBRATION_JOB_DEFINITION_VERSION,
    id: workflow.id,
    label: workflow.label,
    sourceCommit: PINNED_CALIBRATION_COMMIT,
    inventoryEffectCategories: [...new Set(workflow.effects.map((effect) => effect.category))],
    effectKind: workflowSpec.effectKind,
    parameters,
    prerequisites: {
      printer: {
        minBedWidthMm: workflowSpec.sourceEnvelopeMm[0],
        minBedDepthMm: workflowSpec.sourceEnvelopeMm[1],
        minBuildHeightMm: workflowSpec.minBuildHeightMm,
        minMaxPrintSpeedMmPerS: workflowSpec.minMaxPrintSpeedMmPerS ?? 1,
        minMaxAccelerationMmPerS2: workflowSpec.minMaxAccelerationMmPerS2 ?? 1,
      },
      nozzle: {
        minDiameterMm: 0.1,
        maxDiameterMm: 1.2,
        requiresTemperatureEnvelope: workflowSpec.nozzleTemperature ?? false,
      },
      filament: {
        requiresTemperatureEnvelope: workflowSpec.filamentTemperature ?? false,
        requiresFlowRatio: workflowSpec.filamentFlowRatio ?? false,
        requiresMaxVolumetricSpeed: workflowSpec.filamentMaxVolumetricSpeed ?? false,
        requiresRetractionLength: workflowSpec.filamentRetractionLength ?? false,
      },
      process: {
        requiresLayerHeight: workflowSpec.processLayerHeight ?? false,
        requiresLineWidth: workflowSpec.processLineWidth ?? false,
        requiresOuterWallSpeed: workflowSpec.processOuterWallSpeed ?? false,
        requiresAcceleration: workflowSpec.processAcceleration ?? false,
        requiresXyCompensation: workflowSpec.processXyCompensation ?? false,
      },
      firmware: {
        allowedFlavors: workflowSpec.firmwareFlavors ?? ALL_FIRMWARE_FLAVORS,
        capabilities: workflowSpec.firmwareCapabilities ?? [],
      },
    },
    geometry: {
      kind: workflowSpec.geometryKind,
      resources: workflow.resources,
      sourceEnvelopeMm: workflowSpec.sourceEnvelopeMm,
      zTrimmable: workflowSpec.zTrimmable,
    },
    resultFields: workflow.resultFields,
    presetTargets: workflow.presetTargets,
  } satisfies Omit<CalibrationJobDefinition, 'fingerprint'>;
  return deepFreeze({
    ...body,
    fingerprint: contentDigest(new TextEncoder().encode(canonicalStringify(body))),
  });
}

function parameterDefinition(
  workflowId: CalibrationWorkflowId,
  parameter: CalibrationParameter,
): CalibrationParameterDefinition {
  const kind = parameter.kind === 'positive-integer-list' ? 'number-list' : parameter.kind;
  return {
    key: parameter.key,
    label: parameter.label,
    kind,
    unit: parameter.unit,
    editable: parameter.editable,
    default: parameterDefault(workflowId, parameter),
    choices: parameter.choices,
    range: kind === 'number' || kind === 'number-list' ? parameterRange(workflowId, parameter.key) : null,
    maxItems: kind === 'number-list' ? (workflowId === 'tolerance-extension' ? 6 : 32) : null,
  };
}

function parameterDefault(
  workflowId: CalibrationWorkflowId,
  parameter: CalibrationParameter,
): CalibrationParameterValue {
  const value = parameter.default;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new Error(`Calibration ${workflowId}.${parameter.key} has a non-numeric list default`);
    }
    return [...value] as readonly number[];
  }
  if (isJsonRecord(value)) {
    const selector = workflowId === 'temperature-tower' ? 'PLA' : 'DDE';
    const selected = value[selector];
    if (typeof selected === 'number' && Number.isFinite(selected)) return selected;
  }
  throw new Error(`Calibration ${workflowId}.${parameter.key} has no executable default`);
}

function parameterRange(workflowId: CalibrationWorkflowId, key: string): CalibrationNumericRange {
  const id = `${workflowId}.${key}`;
  if (id === 'temperature-tower.start' || id === 'temperature-tower.end') return range(170, 350, 5);
  if (id === 'temperature-tower.step') return range(5, 5, 1);
  if (id.endsWith('.pass'))
    return range(
      id.includes('pass-2') || id.includes('perfectionist') ? 2 : 1,
      id.includes('pass-2') || id.includes('perfectionist') ? 2 : 1,
      1,
    );
  if (id.endsWith('.modifierStep'))
    return range(id.includes('perfectionist') ? 0.005 : 0.01, id.includes('perfectionist') ? 0.005 : 0.01, 0.001);
  if (id.startsWith('pressure-advance-') && key === 'start') return range(0, 2, 0.000_001);
  if (id.startsWith('pressure-advance-') && key === 'end') return range(0.000_001, 2, 0.000_001);
  if (id.startsWith('pressure-advance-') && key === 'step') return range(0.000_001, 1, 0.000_001);
  if (id.startsWith('pressure-advance-') && (key === 'accelerations' || key === 'speeds')) {
    return range(1, 1_000_000, 1);
  }
  if (id === 'retraction-tower.start' || id === 'retraction-tower.end') return range(0, 50, 0.001);
  if (id === 'retraction-tower.step') return range(0.001, 10, 0.001);
  if (id === 'max-volumetric-speed.start' || id === 'max-volumetric-speed.end') return range(0.1, 200, 0.1);
  if (id === 'max-volumetric-speed.step') return range(0.1, 50, 0.1);
  if (id === 'junction-deviation.start') return range(0, 1, 0.001, true, false);
  if (id === 'junction-deviation.end') return range(0, 1, 0.001, false, false);
  if (id.startsWith('input-shaping-frequency.freq')) return range(0, 500, 0.01);
  if (id === 'input-shaping-frequency.damping') return range(0, 1, 0.001, true, false);
  if (id === 'input-shaping-damping.frequencyX' || id === 'input-shaping-damping.frequencyY') {
    return range(0, 500, 0.01);
  }
  if (id === 'input-shaping-damping.start') return range(0, 1, 0.001, true, false);
  if (id === 'input-shaping-damping.end') return range(0, 1, 0.001, false, true);
  if (id === 'vfa.start' || id === 'vfa.end') return range(10, 1_000, 1, false, true);
  if (id === 'vfa.step') return range(0.1, 500, 0.1);
  if (id === 'tolerance-extension.testClearances') return range(0, 1, 0.001);
  throw new Error(`Calibration ${id} is missing a numeric range`);
}

function range(
  min: number,
  max: number,
  step: number,
  minInclusive = true,
  maxInclusive = true,
): CalibrationNumericRange {
  return { min, max, step, minInclusive, maxInclusive };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const definitions = calibrationInventory.workflows.map(buildDefinition);
if (definitions.length !== CALIBRATION_WORKFLOW_IDS.length) {
  throw new Error('Calibration definition count differs from the pinned workflow inventory');
}

export const CALIBRATION_JOB_DEFINITIONS: readonly CalibrationJobDefinition[] = deepFreeze(definitions);

/** Unknown IDs never fall back to a different calibration definition. */
export function getCalibrationJobDefinition(id: string): CalibrationJobDefinition | undefined {
  return CALIBRATION_JOB_DEFINITIONS.find((definition) => definition.id === id);
}
