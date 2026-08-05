import type {
  CalibrationEffectCategory,
  CalibrationPresetTarget,
  CalibrationResource,
  CalibrationResultField,
  CalibrationWorkflowId,
  JsonValue,
} from '../../features/calibrationInventory';

export const CALIBRATION_JOB_SCHEMA_VERSION = 1 as const;
export const CALIBRATION_JOB_DEFINITION_VERSION = 1 as const;

export type CalibrationExecutionMode = 'manual' | 'automatic';
export type CalibrationFirmwareFlavor = 'klipper' | 'marlin' | 'reprap';
export type CalibrationFirmwareCapability =
  'nozzle-temperature' | 'pressure-advance' | 'input-shaping' | 'junction-deviation';
export type CalibrationPlanEffectKind = 'band' | 'object' | 'line';
export type CalibrationParameterValue = string | number | boolean | readonly number[];

export interface CalibrationNumericRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly minInclusive: boolean;
  readonly maxInclusive: boolean;
}

export interface CalibrationParameterDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: 'choice' | 'number' | 'boolean' | 'number-list';
  readonly unit: string | null;
  readonly editable: boolean;
  readonly default: CalibrationParameterValue;
  readonly choices: readonly string[];
  readonly range: CalibrationNumericRange | null;
  readonly maxItems: number | null;
}

export interface CalibrationPrinterPrerequisiteDefinition {
  readonly minBedWidthMm: number;
  readonly minBedDepthMm: number;
  readonly minBuildHeightMm: number;
  readonly minMaxPrintSpeedMmPerS: number;
  readonly minMaxAccelerationMmPerS2: number;
}

export interface CalibrationNozzlePrerequisiteDefinition {
  readonly minDiameterMm: number;
  readonly maxDiameterMm: number;
  readonly requiresTemperatureEnvelope: boolean;
}

export interface CalibrationFilamentPrerequisiteDefinition {
  readonly requiresTemperatureEnvelope: boolean;
  readonly requiresFlowRatio: boolean;
  readonly requiresMaxVolumetricSpeed: boolean;
  readonly requiresRetractionLength: boolean;
}

export interface CalibrationProcessPrerequisiteDefinition {
  readonly requiresLayerHeight: boolean;
  readonly requiresLineWidth: boolean;
  readonly requiresOuterWallSpeed: boolean;
  readonly requiresAcceleration: boolean;
  readonly requiresXyCompensation: boolean;
}

export interface CalibrationFirmwarePrerequisiteDefinition {
  readonly allowedFlavors: readonly CalibrationFirmwareFlavor[];
  readonly capabilities: readonly CalibrationFirmwareCapability[];
}

export interface CalibrationGeometryDefinition {
  readonly kind: 'resource' | 'generated' | 'hybrid';
  readonly resources: readonly CalibrationResource[];
  /**
   * Planning envelope from the pinned asset audit. It is for safe placement,
   * not a geometry-oracle claim.
   */
  readonly sourceEnvelopeMm: readonly [number, number, number];
  readonly zTrimmable: boolean;
}

export interface CalibrationJobDefinition {
  readonly schemaVersion: typeof CALIBRATION_JOB_SCHEMA_VERSION;
  readonly definitionVersion: typeof CALIBRATION_JOB_DEFINITION_VERSION;
  readonly id: CalibrationWorkflowId;
  readonly fingerprint: string;
  readonly label: string;
  readonly sourceCommit: string;
  readonly inventoryEffectCategories: readonly CalibrationEffectCategory[];
  readonly effectKind: CalibrationPlanEffectKind;
  readonly parameters: readonly CalibrationParameterDefinition[];
  readonly prerequisites: {
    readonly printer: CalibrationPrinterPrerequisiteDefinition;
    readonly nozzle: CalibrationNozzlePrerequisiteDefinition;
    readonly filament: CalibrationFilamentPrerequisiteDefinition;
    readonly process: CalibrationProcessPrerequisiteDefinition;
    readonly firmware: CalibrationFirmwarePrerequisiteDefinition;
  };
  readonly geometry: CalibrationGeometryDefinition;
  readonly resultFields: readonly CalibrationResultField[];
  readonly presetTargets: readonly CalibrationPresetTarget[];
}

export interface CalibrationPrinterPrerequisites {
  readonly id: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly bedWidthMm: number;
  readonly bedDepthMm: number;
  readonly buildHeightMm: number;
  readonly maxPrintSpeedMmPerS: number;
  readonly maxAccelerationMmPerS2: number;
}

export interface CalibrationNozzlePrerequisites {
  readonly diameterMm: number;
  readonly minTemperatureC: number;
  readonly maxTemperatureC: number;
  readonly maxLayerHeightMm: number;
}

export interface CalibrationFilamentPrerequisites {
  readonly id: string;
  readonly name: string;
  readonly material: string;
  readonly minTemperatureC: number;
  readonly maxTemperatureC: number;
  readonly flowRatio: number;
  readonly maxVolumetricSpeedMm3PerS: number;
  readonly retractionLengthMm: number;
}

export interface CalibrationProcessPrerequisites {
  readonly id: string;
  readonly layerHeightMm: number;
  readonly firstLayerHeightMm: number;
  readonly lineWidthMm: number;
  readonly outerWallSpeedMmPerS: number;
  readonly defaultAccelerationMmPerS2: number;
  readonly xyHoleCompensationMm: number;
  readonly xyContourCompensationMm: number;
}

export interface CalibrationFirmwarePrerequisites {
  readonly flavor: CalibrationFirmwareFlavor;
  readonly nozzleTemperature: boolean;
  readonly pressureAdvance: boolean;
  readonly inputShaping: boolean;
  readonly junctionDeviation: boolean;
  readonly maxInputShapingFrequencyHz: number;
}

export interface CalibrationJobPrerequisites {
  readonly printer: CalibrationPrinterPrerequisites;
  readonly nozzle: CalibrationNozzlePrerequisites;
  readonly filament: CalibrationFilamentPrerequisites;
  readonly process: CalibrationProcessPrerequisites;
  readonly firmware: CalibrationFirmwarePrerequisites;
}

export interface CalibrationJobRequest {
  readonly schemaVersion: typeof CALIBRATION_JOB_SCHEMA_VERSION;
  readonly definitionId: CalibrationWorkflowId;
  readonly definitionVersion: typeof CALIBRATION_JOB_DEFINITION_VERSION;
  readonly definitionFingerprint: string;
  readonly execution: CalibrationExecutionMode;
  readonly parameters: Readonly<Record<string, CalibrationParameterValue>>;
  readonly prerequisites: CalibrationJobPrerequisites;
}

export interface CalibrationEngineOverride {
  readonly scope: 'layer' | 'object' | 'print';
  readonly key: string;
  readonly value: string | number | boolean;
}

export interface CalibrationPlanEffect {
  readonly kind: CalibrationPlanEffectKind;
  readonly order: number;
  readonly label: string;
  readonly parameterKey: string;
  readonly value: string | number;
  readonly unit: string | null;
  readonly zRangeMm: readonly [number, number] | null;
  readonly positionMm: readonly [number, number, number] | null;
  readonly lineMm: {
    readonly start: readonly [number, number, number];
    readonly end: readonly [number, number, number];
  } | null;
  readonly engineOverrides: readonly CalibrationEngineOverride[];
  readonly customGcode: string | null;
}

export interface CalibrationSliceAssertion {
  readonly id: string;
  readonly kind:
    | 'effect-count'
    | 'label-count'
    | 'actionable-effects'
    | 'z-range'
    | 'resource-blob'
    | 'override-key'
    | 'gcode-prefix';
  readonly path: string;
  readonly operator: 'equals' | 'contains' | 'less-than-or-equal';
  readonly expected: JsonValue;
}

export interface CalibrationJobPlan {
  readonly schemaVersion: typeof CALIBRATION_JOB_SCHEMA_VERSION;
  readonly jobId: string;
  readonly definitionId: CalibrationWorkflowId;
  readonly definitionVersion: typeof CALIBRATION_JOB_DEFINITION_VERSION;
  readonly definitionFingerprint: string;
  readonly label: string;
  readonly execution: 'manual';
  readonly parameters: Readonly<Record<string, CalibrationParameterValue>>;
  readonly prerequisites: CalibrationJobPrerequisites;
  readonly geometry: {
    readonly kind: CalibrationGeometryDefinition['kind'];
    readonly resources: readonly CalibrationResource[];
    readonly sourceEnvelopeMm: readonly [number, number, number];
    readonly requiredEnvelopeMm: readonly [number, number, number];
    readonly translationMm: readonly [number, number, number];
  };
  readonly effects: readonly CalibrationPlanEffect[];
  readonly expectedLabels: readonly string[];
  readonly sliceAssertions: readonly CalibrationSliceAssertion[];
  readonly resultFields: readonly CalibrationResultField[];
  readonly presetTargets: readonly CalibrationPresetTarget[];
  readonly warnings: readonly string[];
}
