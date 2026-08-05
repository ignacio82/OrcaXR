import {
  getCalibrationWorkflow,
  type CalibrationWorkflowId,
  type JsonValue,
} from '../../features/calibrationInventory';
import { cloneJson, deepFreeze } from '../domain/canonical';
import { getCalibrationJobDefinition } from './definitions';
import {
  CALIBRATION_JOB_DEFINITION_VERSION,
  CALIBRATION_JOB_SCHEMA_VERSION,
  type CalibrationEngineOverride,
  type CalibrationFirmwareCapability,
  type CalibrationFirmwarePrerequisites,
  type CalibrationJobDefinition,
  type CalibrationJobPlan,
  type CalibrationJobPrerequisites,
  type CalibrationJobRequest,
  type CalibrationParameterDefinition,
  type CalibrationParameterValue,
  type CalibrationPlanEffect,
  type CalibrationSliceAssertion,
} from './types';

export const MAX_CALIBRATION_EFFECTS = 512;

export interface CalibrationJobValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class CalibrationJobValidationError extends Error {
  public constructor(readonly issues: readonly CalibrationJobValidationIssue[]) {
    super(
      issues.length === 1
        ? `Invalid calibration job: ${issues[0].message}`
        : `Invalid calibration job (${issues.length} issues)`,
    );
    this.name = 'CalibrationJobValidationError';
  }
}

export interface CalibrationJobCompileOptions {
  /** Stable caller-owned identity; compilation never reads time or randomness. */
  readonly jobId: string;
}

export interface DefaultCalibrationJobRequestOptions {
  readonly execution?: CalibrationJobRequest['execution'];
  readonly parameters?: Readonly<Record<string, CalibrationParameterValue>>;
}

/**
 * Build a complete version/fingerprint-bound request from one definition.
 * Conditional upstream defaults are selected only when their selector was
 * explicitly overridden; unknown parameters remain for the compiler to reject.
 */
export function createDefaultCalibrationJobRequest(
  definitionId: CalibrationWorkflowId,
  prerequisites: CalibrationJobPrerequisites,
  options: DefaultCalibrationJobRequestOptions = {},
): CalibrationJobRequest {
  const definition = requireDefinition(definitionId);
  const supplied = options.parameters ?? {};
  const parameters: Record<string, CalibrationParameterValue> = Object.fromEntries(
    definition.parameters.map((parameter) => [parameter.key, cloneParameterValue(parameter.default)]),
  );
  applyConditionalDefaults(definitionId, parameters, supplied);
  for (const [key, value] of Object.entries(supplied)) parameters[key] = cloneParameterValue(value);
  return deepFreeze({
    schemaVersion: CALIBRATION_JOB_SCHEMA_VERSION,
    definitionId,
    definitionVersion: CALIBRATION_JOB_DEFINITION_VERSION,
    definitionFingerprint: definition.fingerprint,
    execution: options.execution ?? 'manual',
    parameters,
    prerequisites: cloneJson(prerequisites),
  });
}

/**
 * Compile a bounded, detached, presentation-neutral calibration plan. Nothing
 * is written to a project or preset here; callers must separately stage and
 * commit the plan through canonical project/history boundaries.
 */
export function compileCalibrationJob(
  request: CalibrationJobRequest,
  options: CalibrationJobCompileOptions,
): CalibrationJobPlan {
  const issues: CalibrationJobValidationIssue[] = [];
  validateJobId(options.jobId, issues);
  const definition = getCalibrationJobDefinition(request.definitionId);
  if (!definition) {
    issue(issues, 'unknown-definition', '$.definitionId', `Unknown calibration ${String(request.definitionId)}`);
    throw new CalibrationJobValidationError(issues);
  }
  validateEnvelope(request, definition, issues);
  const parameters = validateParameters(request.parameters, definition, issues);
  validatePrerequisites(request.prerequisites, definition, issues);
  if (issues.length === 0) validateCrossFieldParameters(definition, parameters, request.prerequisites, issues);
  if (issues.length > 0) throw new CalibrationJobValidationError(deepFreeze(issues));

  const effects = buildEffects(definition, parameters, request.prerequisites);
  if (effects.length === 0 || effects.length > MAX_CALIBRATION_EFFECTS) {
    throw new CalibrationJobValidationError([
      {
        code: 'effect-count',
        path: '$.parameters',
        message: `Calibration must produce between 1 and ${MAX_CALIBRATION_EFFECTS} effects`,
      },
    ]);
  }
  const requiredEnvelopeMm = requiredEnvelope(definition, parameters, request.prerequisites, effects.length);
  validateRequiredEnvelope(requiredEnvelopeMm, definition, request.prerequisites);
  const translationMm = [
    round((request.prerequisites.printer.bedWidthMm - requiredEnvelopeMm[0]) / 2),
    round((request.prerequisites.printer.bedDepthMm - requiredEnvelopeMm[1]) / 2),
    0,
  ] as const;
  const expectedLabels = effects.map((effect) => effect.label);
  const sliceAssertions = buildSliceAssertions(definition, effects, expectedLabels, requiredEnvelopeMm);

  return deepFreeze({
    schemaVersion: CALIBRATION_JOB_SCHEMA_VERSION,
    jobId: options.jobId,
    definitionId: definition.id,
    definitionVersion: definition.definitionVersion,
    definitionFingerprint: definition.fingerprint,
    label: definition.label,
    execution: 'manual',
    parameters: cloneParameters(parameters),
    prerequisites: cloneJson(request.prerequisites),
    geometry: {
      kind: definition.geometry.kind,
      resources: cloneJson(definition.geometry.resources),
      sourceEnvelopeMm: [...definition.geometry.sourceEnvelopeMm],
      requiredEnvelopeMm,
      translationMm,
    },
    effects,
    expectedLabels,
    sliceAssertions,
    resultFields: cloneJson(definition.resultFields),
    presetTargets: cloneJson(definition.presetTargets),
    warnings: planWarnings(definition, parameters),
  });
}

function validateEnvelope(
  request: CalibrationJobRequest,
  definition: CalibrationJobDefinition,
  issues: CalibrationJobValidationIssue[],
): void {
  if (request.schemaVersion !== CALIBRATION_JOB_SCHEMA_VERSION) {
    issue(issues, 'schema-version', '$.schemaVersion', `Expected schema version ${CALIBRATION_JOB_SCHEMA_VERSION}`);
  }
  if (request.definitionVersion !== definition.definitionVersion) {
    issue(
      issues,
      'definition-version',
      '$.definitionVersion',
      `Expected definition version ${definition.definitionVersion}`,
    );
  }
  if (request.definitionFingerprint !== definition.fingerprint) {
    issue(issues, 'definition-fingerprint', '$.definitionFingerprint', 'Calibration definition is stale');
  }
  if (request.execution !== 'manual') {
    issue(
      issues,
      'automatic-unavailable',
      '$.execution',
      'Automatic vendor calibration is unavailable; select the generic manual workflow',
    );
  }
}

function validateParameters(
  input: Readonly<Record<string, CalibrationParameterValue>>,
  definition: CalibrationJobDefinition,
  issues: CalibrationJobValidationIssue[],
): Record<string, CalibrationParameterValue> {
  if (!isPlainRecord(input)) {
    issue(issues, 'parameters-type', '$.parameters', 'Parameters must be a plain object');
    return {};
  }
  const output: Record<string, CalibrationParameterValue> = {};
  const definitions = new Map(definition.parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(input)) {
    if (!definitions.has(key)) issue(issues, 'unknown-parameter', `$.parameters.${key}`, 'Unknown parameter');
  }
  for (const parameter of definition.parameters) {
    if (!Object.hasOwn(input, parameter.key)) {
      issue(issues, 'missing-parameter', `$.parameters.${parameter.key}`, 'Missing parameter');
      continue;
    }
    const value = input[parameter.key];
    validateParameterValue(parameter, value, `$.parameters.${parameter.key}`, issues);
    output[parameter.key] = cloneParameterValue(value);
  }
  return output;
}

function validateParameterValue(
  definition: CalibrationParameterDefinition,
  value: CalibrationParameterValue,
  path: string,
  issues: CalibrationJobValidationIssue[],
): void {
  if (!definition.editable && !sameParameterValue(value, definition.default)) {
    issue(issues, 'fixed-parameter', path, `Fixed parameter must equal ${JSON.stringify(definition.default)}`);
  }
  switch (definition.kind) {
    case 'choice':
      if (typeof value !== 'string' || !definition.choices.includes(value)) {
        issue(issues, 'choice', path, `Expected one of ${definition.choices.join(', ')}`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issue(issues, 'boolean', path, 'Expected a boolean');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issue(issues, 'number', path, 'Expected a finite number');
        return;
      }
      validateNumericRange(value, definition, path, issues);
      return;
    case 'number-list':
      if (!Array.isArray(value)) {
        issue(issues, 'number-list', path, 'Expected a number list');
        return;
      }
      if (definition.maxItems !== null && value.length > definition.maxItems) {
        issue(issues, 'number-list-count', path, `Expected at most ${definition.maxItems} values`);
      }
      value.forEach((entry, index) => {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
          issue(issues, 'number-list-entry', `${path}[${index}]`, 'Expected a finite number');
        } else {
          validateNumericRange(entry, definition, `${path}[${index}]`, issues);
        }
      });
  }
}

function validateNumericRange(
  value: number,
  definition: CalibrationParameterDefinition,
  path: string,
  issues: CalibrationJobValidationIssue[],
): void {
  const range = definition.range;
  if (!range) {
    issue(issues, 'range-missing', path, 'Numeric parameter has no definition range');
    return;
  }
  const below = range.minInclusive ? value < range.min : value <= range.min;
  const above = range.maxInclusive ? value > range.max : value >= range.max;
  if (below || above) {
    issue(
      issues,
      'range',
      path,
      `Expected ${range.minInclusive ? '[' : '('}${range.min}, ${range.max}${range.maxInclusive ? ']' : ')'}`,
    );
    return;
  }
  const grid = (value - range.min) / range.step;
  if (Math.abs(grid - Math.round(grid)) > 1e-7 * Math.max(1, Math.abs(grid))) {
    issue(issues, 'step', path, `Value must align to step ${range.step} from ${range.min}`);
  }
}

function validatePrerequisites(
  prerequisites: CalibrationJobPrerequisites,
  definition: CalibrationJobDefinition,
  issues: CalibrationJobValidationIssue[],
): void {
  for (const [path, value] of [
    ['$.prerequisites.printer.id', prerequisites.printer?.id],
    ['$.prerequisites.printer.manufacturer', prerequisites.printer?.manufacturer],
    ['$.prerequisites.printer.model', prerequisites.printer?.model],
    ['$.prerequisites.filament.id', prerequisites.filament?.id],
    ['$.prerequisites.filament.name', prerequisites.filament?.name],
    ['$.prerequisites.filament.material', prerequisites.filament?.material],
    ['$.prerequisites.process.id', prerequisites.process?.id],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || hasControlCharacters(value)) {
      issue(issues, 'identity', path, 'Expected a bounded non-empty identifier');
    }
  }

  const numeric = [
    ['printer.bedWidthMm', prerequisites.printer?.bedWidthMm],
    ['printer.bedDepthMm', prerequisites.printer?.bedDepthMm],
    ['printer.buildHeightMm', prerequisites.printer?.buildHeightMm],
    ['printer.maxPrintSpeedMmPerS', prerequisites.printer?.maxPrintSpeedMmPerS],
    ['printer.maxAccelerationMmPerS2', prerequisites.printer?.maxAccelerationMmPerS2],
    ['nozzle.diameterMm', prerequisites.nozzle?.diameterMm],
    ['nozzle.maxLayerHeightMm', prerequisites.nozzle?.maxLayerHeightMm],
    ['filament.flowRatio', prerequisites.filament?.flowRatio],
    ['filament.maxVolumetricSpeedMm3PerS', prerequisites.filament?.maxVolumetricSpeedMm3PerS],
    ['filament.retractionLengthMm', prerequisites.filament?.retractionLengthMm],
    ['process.layerHeightMm', prerequisites.process?.layerHeightMm],
    ['process.firstLayerHeightMm', prerequisites.process?.firstLayerHeightMm],
    ['process.lineWidthMm', prerequisites.process?.lineWidthMm],
    ['process.outerWallSpeedMmPerS', prerequisites.process?.outerWallSpeedMmPerS],
    ['process.defaultAccelerationMmPerS2', prerequisites.process?.defaultAccelerationMmPerS2],
  ] as const;
  for (const [path, value] of numeric) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      issue(issues, 'positive-prerequisite', `$.prerequisites.${path}`, 'Expected a positive finite number');
    }
  }
  for (const [path, value] of [
    ['nozzle.minTemperatureC', prerequisites.nozzle?.minTemperatureC],
    ['nozzle.maxTemperatureC', prerequisites.nozzle?.maxTemperatureC],
    ['filament.minTemperatureC', prerequisites.filament?.minTemperatureC],
    ['filament.maxTemperatureC', prerequisites.filament?.maxTemperatureC],
    ['process.xyHoleCompensationMm', prerequisites.process?.xyHoleCompensationMm],
    ['process.xyContourCompensationMm', prerequisites.process?.xyContourCompensationMm],
    ['firmware.maxInputShapingFrequencyHz', prerequisites.firmware?.maxInputShapingFrequencyHz],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issue(issues, 'finite-prerequisite', `$.prerequisites.${path}`, 'Expected a finite number');
    }
  }
  if (prerequisites.nozzle?.minTemperatureC >= prerequisites.nozzle?.maxTemperatureC) {
    issue(issues, 'temperature-envelope', '$.prerequisites.nozzle', 'Nozzle minimum must be below maximum');
  }
  if (prerequisites.filament?.minTemperatureC >= prerequisites.filament?.maxTemperatureC) {
    issue(issues, 'temperature-envelope', '$.prerequisites.filament', 'Filament minimum must be below maximum');
  }
  if (prerequisites.process?.layerHeightMm > prerequisites.nozzle?.maxLayerHeightMm) {
    issue(issues, 'layer-height', '$.prerequisites.process.layerHeightMm', 'Layer height exceeds nozzle maximum');
  }
  if (prerequisites.process?.firstLayerHeightMm > prerequisites.nozzle?.maxLayerHeightMm) {
    issue(
      issues,
      'first-layer-height',
      '$.prerequisites.process.firstLayerHeightMm',
      'First-layer height exceeds nozzle maximum',
    );
  }

  const printer = definition.prerequisites.printer;
  if (prerequisites.printer?.bedWidthMm < printer.minBedWidthMm) {
    issue(issues, 'bed-width', '$.prerequisites.printer.bedWidthMm', `Requires at least ${printer.minBedWidthMm} mm`);
  }
  if (prerequisites.printer?.bedDepthMm < printer.minBedDepthMm) {
    issue(issues, 'bed-depth', '$.prerequisites.printer.bedDepthMm', `Requires at least ${printer.minBedDepthMm} mm`);
  }
  if (prerequisites.printer?.buildHeightMm < printer.minBuildHeightMm) {
    issue(
      issues,
      'build-height',
      '$.prerequisites.printer.buildHeightMm',
      `Requires at least ${printer.minBuildHeightMm} mm`,
    );
  }
  if (prerequisites.printer?.maxPrintSpeedMmPerS < printer.minMaxPrintSpeedMmPerS) {
    issue(
      issues,
      'printer-speed',
      '$.prerequisites.printer.maxPrintSpeedMmPerS',
      `Requires at least ${printer.minMaxPrintSpeedMmPerS} mm/s`,
    );
  }
  if (prerequisites.printer?.maxAccelerationMmPerS2 < printer.minMaxAccelerationMmPerS2) {
    issue(
      issues,
      'printer-acceleration',
      '$.prerequisites.printer.maxAccelerationMmPerS2',
      `Requires at least ${printer.minMaxAccelerationMmPerS2} mm/s²`,
    );
  }
  const nozzle = definition.prerequisites.nozzle;
  if (
    prerequisites.nozzle?.diameterMm < nozzle.minDiameterMm ||
    prerequisites.nozzle?.diameterMm > nozzle.maxDiameterMm
  ) {
    issue(
      issues,
      'nozzle-diameter',
      '$.prerequisites.nozzle.diameterMm',
      `Expected nozzle diameter in [${nozzle.minDiameterMm}, ${nozzle.maxDiameterMm}] mm`,
    );
  }
  if (!definition.prerequisites.firmware.allowedFlavors.includes(prerequisites.firmware?.flavor)) {
    issue(
      issues,
      'firmware-flavor',
      '$.prerequisites.firmware.flavor',
      `Calibration supports ${definition.prerequisites.firmware.allowedFlavors.join(', ')}`,
    );
  }
  for (const capability of definition.prerequisites.firmware.capabilities) {
    if (!hasFirmwareCapability(prerequisites.firmware, capability)) {
      issue(
        issues,
        'firmware-capability',
        `$.prerequisites.firmware.${firmwareCapabilityField(capability)}`,
        `Firmware does not declare ${capability}`,
      );
    }
  }
}

function validateCrossFieldParameters(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
  issues: CalibrationJobValidationIssue[],
): void {
  const start = optionalNumber(parameters.start);
  const end = optionalNumber(parameters.end);
  const step = optionalNumber(parameters.step);
  if (start !== undefined && end !== undefined && definition.id !== 'temperature-tower' && end <= start) {
    issue(issues, 'sweep-order', '$.parameters.end', 'End must be greater than start');
  }
  if (start !== undefined && end !== undefined && step !== undefined) {
    if (definition.id === 'temperature-tower') {
      if (start <= end) issue(issues, 'sweep-order', '$.parameters.end', 'Temperature end must be below start');
      validateAlignedSpan(start - end, step, issues);
    } else {
      if (end < start + step) issue(issues, 'sweep-step', '$.parameters.end', 'End must include at least one step');
      validateAlignedSpan(end - start, step, issues);
    }
  }

  if (definition.id === 'temperature-tower' && start !== undefined && end !== undefined) {
    const safeMin = Math.max(prerequisites.nozzle.minTemperatureC, prerequisites.filament.minTemperatureC);
    const safeMax = Math.min(prerequisites.nozzle.maxTemperatureC, prerequisites.filament.maxTemperatureC);
    if (end < safeMin || start > safeMax) {
      issue(
        issues,
        'temperature-safety',
        '$.parameters',
        `Temperature sweep must stay within the shared [${safeMin}, ${safeMax}] °C envelope`,
      );
    }
  }
  if (definition.id.startsWith('pressure-advance-')) {
    validateMotionList(parameters.speeds, prerequisites.printer.maxPrintSpeedMmPerS, 'speeds', issues);
    validateMotionList(parameters.accelerations, prerequisites.printer.maxAccelerationMmPerS2, 'accelerations', issues);
  }
  if (definition.id === 'vfa' && end !== undefined && end > prerequisites.printer.maxPrintSpeedMmPerS) {
    issue(issues, 'motion-limit', '$.parameters.end', 'VFA end speed exceeds the printer maximum');
  }
  if (definition.id === 'input-shaping-frequency') {
    for (const key of ['freqEndX', 'freqEndY'] as const) {
      const value = number(parameters, key);
      if (value > prerequisites.firmware.maxInputShapingFrequencyHz) {
        issue(issues, 'firmware-frequency', `$.parameters.${key}`, 'Frequency exceeds the firmware maximum');
      }
    }
    if (number(parameters, 'freqStartX') >= number(parameters, 'freqEndX')) {
      issue(issues, 'frequency-order', '$.parameters.freqEndX', 'X end frequency must exceed X start');
    }
    if (number(parameters, 'freqStartY') >= number(parameters, 'freqEndY')) {
      issue(issues, 'frequency-order', '$.parameters.freqEndY', 'Y end frequency must exceed Y start');
    }
  }
  if (definition.id === 'input-shaping-damping') {
    for (const key of ['frequencyX', 'frequencyY'] as const) {
      if (number(parameters, key) > prerequisites.firmware.maxInputShapingFrequencyHz) {
        issue(issues, 'firmware-frequency', `$.parameters.${key}`, 'Frequency exceeds the firmware maximum');
      }
    }
  }
  if (definition.id === 'max-volumetric-speed') {
    const maxWallSpeed = volumetricWallSpeed(number(parameters, 'end'), prerequisites);
    if (maxWallSpeed > prerequisites.printer.maxPrintSpeedMmPerS) {
      issue(
        issues,
        'motion-limit',
        '$.parameters.end',
        `Derived wall speed ${round(maxWallSpeed)} mm/s exceeds the printer maximum`,
      );
    }
  }
  if (definition.id === 'tolerance-extension') {
    const clearances = numberList(parameters, 'testClearances');
    const expected = [0, 0.05, 0.1, 0.2, 0.3, 0.4];
    if (!sameNumberList(clearances, expected)) {
      issue(issues, 'fixed-clearances', '$.parameters.testClearances', 'Pinned tolerance clearances cannot change');
    }
  }

  const predictedCount = predictedEffectCount(definition, parameters, prerequisites);
  if (!Number.isSafeInteger(predictedCount) || predictedCount < 1 || predictedCount > MAX_CALIBRATION_EFFECTS) {
    issue(
      issues,
      'effect-count',
      '$.parameters',
      `Parameter range produces ${predictedCount} effects; allowed range is 1..${MAX_CALIBRATION_EFFECTS}`,
    );
  }
  if (definition.id === 'pressure-advance-line') {
    const maxLines = Math.floor((prerequisites.printer.bedDepthMm - 10) / 3.5);
    if (predictedCount > maxLines) {
      issue(issues, 'bed-fit', '$.parameters', `Pressure-advance lines exceed the bed limit of ${maxLines}`);
    }
  }
}

function buildEffects(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
): readonly CalibrationPlanEffect[] {
  switch (definition.id) {
    case 'temperature-tower':
      return descendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step')).map(
        (value, order) =>
          effect(
            definition,
            order,
            'start',
            value,
            '°C',
            [order * 10, (order + 1) * 10],
            null,
            null,
            [override('layer', 'nozzle_temperature', value)],
            `M104 S${format(value)}\n`,
          ),
      );
    case 'flow-pass-1':
      return flowEffects(definition, [-20, -15, -10, -5, 0, 5, 10, 15, 20], prerequisites, false);
    case 'flow-pass-2':
      return flowEffects(definition, [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0], prerequisites, false);
    case 'flow-yolo':
      return flowEffects(
        definition,
        [-0.05, -0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05],
        prerequisites,
        true,
      );
    case 'flow-yolo-perfectionist':
      return flowEffects(
        definition,
        [-0.04, -0.035, -0.03, -0.025, -0.02, -0.015, -0.01, -0.005, 0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035],
        prerequisites,
        true,
      );
    case 'pressure-advance-tower':
      return ascendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step')).map(
        (value, order) =>
          effect(
            definition,
            order,
            'start',
            value,
            null,
            [order, order + 1],
            null,
            null,
            pressureAdvanceOverrides(value),
            pressureAdvanceGcode(value, prerequisites.firmware),
          ),
      );
    case 'pressure-advance-line':
      return pressureAdvanceLines(definition, parameters, prerequisites, false);
    case 'pressure-advance-pattern':
      return pressureAdvanceLines(definition, parameters, prerequisites, true);
    case 'retraction-tower':
      return ascendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step')).map(
        (value, order) => {
          const minZ = order === 0 ? 0 : 0.4 + order;
          const maxZ = 0.4 + order + 1;
          return effect(
            definition,
            order,
            'start',
            value,
            'mm',
            [minZ, maxZ],
            null,
            null,
            [override('layer', 'retraction_length', value)],
            `; Calib_Retraction_tower: Z_HEIGHT: ${format(minZ)}, length:${format(value)}\n`,
          );
        },
      );
    case 'max-volumetric-speed':
      return ascendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step')).map(
        (value, order) => {
          const speed = round(volumetricWallSpeed(value, prerequisites));
          return effect(definition, order, 'start', value, 'mm³/s', [order, order + 1], null, null, [
            override('layer', 'outer_wall_speed', speed),
          ]);
        },
      );
    case 'vfa':
      return ascendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step')).map(
        (value, order) =>
          effect(definition, order, 'start', value, 'mm/s', [order * 5, (order + 1) * 5], null, null, [
            override('layer', 'outer_wall_speed', Math.round(value)),
          ]),
      );
    case 'junction-deviation':
      return interpolatedLayerEffects(definition, parameters, prerequisites, (value) => ({
        overrides: [override('layer', 'default_junction_deviation', value)],
        gcode: `M205 J${value.toFixed(3)}\n`,
      }));
    case 'input-shaping-frequency':
      return inputShapingFrequencyEffects(definition, parameters, prerequisites);
    case 'input-shaping-damping':
      return inputShapingDampingEffects(definition, parameters, prerequisites);
    case 'tolerance-extension':
      return numberList(parameters, 'testClearances').map((value, order) =>
        effect(
          definition,
          order,
          'testClearances',
          value,
          'mm',
          null,
          [
            round(translationColumn(order, 6, prerequisites.printer.bedWidthMm)),
            prerequisites.printer.bedDepthMm / 2,
            0,
          ],
          null,
          [],
        ),
      );
  }
}

function flowEffects(
  definition: CalibrationJobDefinition,
  modifiers: readonly number[],
  prerequisites: CalibrationJobPrerequisites,
  linear: boolean,
): readonly CalibrationPlanEffect[] {
  return modifiers.map((modifier, order) => {
    const value = linear
      ? round((prerequisites.filament.flowRatio + modifier) / prerequisites.filament.flowRatio)
      : round(1 + modifier / 100);
    return effect(definition, order, 'modifier', value, null, null, null, null, [
      override('object', 'print_flow_ratio', value),
    ]);
  });
}

function pressureAdvanceLines(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
  pattern: boolean,
): readonly CalibrationPlanEffect[] {
  const values = ascendingSweep(number(parameters, 'start'), number(parameters, 'end'), number(parameters, 'step'));
  const columns = pattern ? Math.max(1, Math.ceil(Math.sqrt(values.length))) : 1;
  return values.map((value, order) => {
    const row = pattern ? Math.floor(order / columns) : order;
    const column = pattern ? order % columns : 0;
    const y = pattern
      ? translationColumn(row, Math.ceil(values.length / columns), prerequisites.printer.bedDepthMm)
      : 5 + order * 3.5;
    const startX = pattern ? translationColumn(column, columns, prerequisites.printer.bedWidthMm) - 8 : 10;
    const endX = pattern ? startX + 16 : prerequisites.printer.bedWidthMm - 10;
    return effect(
      definition,
      order,
      'start',
      value,
      null,
      null,
      null,
      { start: [round(startX), round(y), 0.2], end: [round(endX), round(y), 0.2] },
      pressureAdvanceOverrides(value),
      pressureAdvanceGcode(value, prerequisites.firmware),
    );
  });
}

function interpolatedLayerEffects(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
  action: (value: number) => { readonly overrides: readonly CalibrationEngineOverride[]; readonly gcode: string },
): readonly CalibrationPlanEffect[] {
  const layerCount = layerEffectCount(prerequisites, selectedTowerHeight(parameters));
  const start = number(parameters, 'start');
  const end = number(parameters, 'end');
  return Array.from({ length: layerCount }, (_, order) => {
    const value = round(start + ((end - start) * (order + 1)) / layerCount);
    const result = action(value);
    return effect(
      definition,
      order,
      'start',
      value,
      definition.id === 'junction-deviation' ? 'mm' : null,
      [order * prerequisites.process.layerHeightMm, (order + 1) * prerequisites.process.layerHeightMm],
      null,
      null,
      result.overrides,
      result.gcode,
    );
  });
}

function inputShapingFrequencyEffects(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
): readonly CalibrationPlanEffect[] {
  const count = layerEffectCount(prerequisites, selectedTowerHeight(parameters));
  const effects: CalibrationPlanEffect[] = [];
  const damping = number(parameters, 'damping');
  effects.push(
    effect(
      definition,
      0,
      'damping',
      damping,
      null,
      [0, prerequisites.process.layerHeightMm],
      null,
      null,
      [],
      inputShapingGcode('A', damping, 0, prerequisites.firmware),
    ),
  );
  for (let order = 1; order < count; order += 1) {
    const ratio = count <= 2 ? 0 : (order - 1) / (count - 2);
    const x = round(
      number(parameters, 'freqStartX') + (number(parameters, 'freqEndX') - number(parameters, 'freqStartX')) * ratio,
    );
    const y = round(
      number(parameters, 'freqStartY') + (number(parameters, 'freqEndY') - number(parameters, 'freqStartY')) * ratio,
    );
    const same = x === y;
    const gcode = same
      ? inputShapingGcode('A', 0, x, prerequisites.firmware)
      : inputShapingGcode('X', 0, x, prerequisites.firmware) + inputShapingGcode('Y', 0, y, prerequisites.firmware);
    effects.push(
      effect(
        definition,
        order,
        'freqStartX',
        same ? x : `${format(x)}/${format(y)}`,
        'Hz',
        [order * prerequisites.process.layerHeightMm, (order + 1) * prerequisites.process.layerHeightMm],
        null,
        null,
        [],
        gcode,
      ),
    );
  }
  return effects;
}

function inputShapingDampingEffects(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
): readonly CalibrationPlanEffect[] {
  const count = layerEffectCount(prerequisites, selectedTowerHeight(parameters));
  const effects: CalibrationPlanEffect[] = [];
  const x = number(parameters, 'frequencyX');
  const y = number(parameters, 'frequencyY');
  effects.push(
    effect(
      definition,
      0,
      'frequencyX',
      `${format(x)}/${format(y)}`,
      'Hz',
      [0, prerequisites.process.layerHeightMm],
      null,
      null,
      [],
      inputShapingGcode('X', 0, x, prerequisites.firmware) + inputShapingGcode('Y', 0, y, prerequisites.firmware),
    ),
  );
  for (let order = 1; order < count; order += 1) {
    const damping = round(
      number(parameters, 'start') + ((number(parameters, 'end') - number(parameters, 'start')) * (order + 1)) / count,
    );
    effects.push(
      effect(
        definition,
        order,
        'start',
        damping,
        null,
        [order * prerequisites.process.layerHeightMm, (order + 1) * prerequisites.process.layerHeightMm],
        null,
        null,
        [],
        inputShapingGcode('A', damping, 0, prerequisites.firmware),
      ),
    );
  }
  return effects;
}

function effect(
  definition: CalibrationJobDefinition,
  order: number,
  parameterKey: string,
  value: string | number,
  unit: string | null,
  zRangeMm: readonly [number, number] | null,
  positionMm: readonly [number, number, number] | null,
  lineMm: CalibrationPlanEffect['lineMm'],
  engineOverrides: readonly CalibrationEngineOverride[],
  customGcode: string | null = null,
): CalibrationPlanEffect {
  return {
    kind: definition.effectKind,
    order,
    label: `${format(value)}${unit ? ` ${unit}` : ''}`,
    parameterKey,
    value,
    unit,
    zRangeMm: zRangeMm ? [round(zRangeMm[0]), round(zRangeMm[1])] : null,
    positionMm: positionMm ? [round(positionMm[0]), round(positionMm[1]), round(positionMm[2])] : null,
    lineMm: lineMm
      ? {
          start: lineMm.start.map(round) as [number, number, number],
          end: lineMm.end.map(round) as [number, number, number],
        }
      : null,
    engineOverrides: engineOverrides.map((entry) => ({ ...entry })),
    customGcode,
  };
}

function override(
  scope: CalibrationEngineOverride['scope'],
  key: string,
  value: CalibrationEngineOverride['value'],
): CalibrationEngineOverride {
  return { scope, key, value };
}

function pressureAdvanceOverrides(value: number): readonly CalibrationEngineOverride[] {
  return [override('layer', 'enable_pressure_advance', true), override('layer', 'pressure_advance', value)];
}

function pressureAdvanceGcode(value: number, firmware: CalibrationFirmwarePrerequisites): string {
  if (firmware.flavor === 'klipper') return `SET_PRESSURE_ADVANCE ADVANCE=${format(value)}\n`;
  if (firmware.flavor === 'reprap') return `M572 D0 S${format(value)}\n`;
  return `M900 K${format(value)}\n`;
}

function inputShapingGcode(
  axis: 'A' | 'X' | 'Y',
  damping: number,
  frequency: number,
  firmware: CalibrationFirmwarePrerequisites,
): string {
  if (firmware.flavor === 'klipper') {
    const parts = ['SET_INPUT_SHAPER'];
    const axes = axis === 'A' ? (['X', 'Y'] as const) : ([axis] as const);
    for (const current of axes) {
      if (frequency > 0) parts.push(`SHAPER_FREQ_${current}=${frequency.toFixed(2)}`);
      if (damping > 0) parts.push(`DAMPING_RATIO_${current}=${damping.toFixed(3)}`);
    }
    return `${parts.join(' ')}\n`;
  }
  const parts = ['M593'];
  if (axis !== 'A') parts.push(axis);
  if (frequency > 0) parts.push(`F${frequency.toFixed(2)}`);
  if (damping > 0) parts.push(`D${damping.toFixed(3)}`);
  return `${parts.join(' ')}\n`;
}

function requiredEnvelope(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
  effectCount: number,
): readonly [number, number, number] {
  const source = definition.geometry.sourceEnvelopeMm;
  switch (definition.id) {
    case 'temperature-tower':
      return [source[0], source[1], effectCount * 10];
    case 'pressure-advance-tower':
      return [source[0], source[1], effectCount];
    case 'pressure-advance-line':
      return [Math.min(source[0], prerequisites.printer.bedWidthMm - 20), effectCount * 3.5 + 10, source[2]];
    case 'pressure-advance-pattern': {
      const columns = Math.ceil(Math.sqrt(effectCount));
      const rows = Math.ceil(effectCount / columns);
      return [columns * 20 + 20, rows * 20 + 20, source[2]];
    }
    case 'retraction-tower':
      return [
        source[0],
        source[1],
        1.4 + (number(parameters, 'end') - number(parameters, 'start')) / number(parameters, 'step'),
      ];
    case 'max-volumetric-speed':
      return [
        source[0],
        source[1],
        (number(parameters, 'end') - number(parameters, 'start') + 1) / number(parameters, 'step'),
      ];
    case 'vfa':
      return [source[0], source[1], effectCount * 5];
    case 'junction-deviation':
    case 'input-shaping-frequency':
    case 'input-shaping-damping':
      return selectedTowerEnvelope(parameters);
    default:
      return source;
  }
}

function validateRequiredEnvelope(
  envelope: readonly [number, number, number],
  definition: CalibrationJobDefinition,
  prerequisites: CalibrationJobPrerequisites,
): void {
  const problems: CalibrationJobValidationIssue[] = [];
  if (envelope.some((value) => !Number.isFinite(value) || value <= 0)) {
    issue(problems, 'geometry-envelope', '$.parameters', 'Generated geometry envelope is invalid');
  }
  if (envelope[0] > prerequisites.printer.bedWidthMm || envelope[1] > prerequisites.printer.bedDepthMm) {
    issue(problems, 'bed-fit', '$.prerequisites.printer', 'Generated calibration does not fit the bed');
  }
  if (envelope[2] > prerequisites.printer.buildHeightMm) {
    issue(
      problems,
      'build-height',
      '$.prerequisites.printer.buildHeightMm',
      'Generated calibration exceeds build height',
    );
  }
  if (definition.geometry.zTrimmable && envelope[2] > definition.geometry.sourceEnvelopeMm[2] + 1e-6) {
    issue(problems, 'source-height', '$.parameters', 'Requested sweep exceeds the pinned source model height');
  }
  if (problems.length > 0) throw new CalibrationJobValidationError(problems);
}

function buildSliceAssertions(
  definition: CalibrationJobDefinition,
  effects: readonly CalibrationPlanEffect[],
  labels: readonly string[],
  requiredEnvelopeMm: readonly [number, number, number],
): readonly CalibrationSliceAssertion[] {
  const overrideKeys = [...new Set(effects.flatMap((effect) => effect.engineOverrides.map((entry) => entry.key)))];
  const gcodePrefixes = [
    ...new Set(
      effects
        .map((effect) => effect.customGcode?.trim().split(/\s+/)[0])
        .filter((prefix): prefix is string => Boolean(prefix) && prefix !== ';'),
    ),
  ];
  return [
    assertion('effect-count', 'effect-count', '$.effects.length', 'equals', effects.length),
    assertion('label-count', 'label-count', '$.expectedLabels.length', 'equals', labels.length),
    assertion(
      'actionable-effects',
      'actionable-effects',
      '$.effects',
      'equals',
      effects.filter(
        (effect) =>
          effect.engineOverrides.length > 0 ||
          effect.customGcode !== null ||
          effect.positionMm !== null ||
          effect.lineMm !== null,
      ).length,
    ),
    assertion('z-range', 'z-range', '$.geometry.requiredEnvelopeMm[2]', 'less-than-or-equal', requiredEnvelopeMm[2]),
    ...definition.geometry.resources.map((resource, index) =>
      assertion(`resource-${index}`, 'resource-blob', `$.geometry.resources[${index}].blob`, 'equals', resource.blob),
    ),
    ...overrideKeys.map((key, index) =>
      assertion(`override-${index}`, 'override-key', '$.effects[].engineOverrides[].key', 'contains', key),
    ),
    ...gcodePrefixes.map((prefix, index) =>
      assertion(`gcode-${index}`, 'gcode-prefix', '$.effects[].customGcode', 'contains', prefix),
    ),
  ];
}

function assertion(
  id: string,
  kind: CalibrationSliceAssertion['kind'],
  path: string,
  operator: CalibrationSliceAssertion['operator'],
  expected: JsonValue,
): CalibrationSliceAssertion {
  return { id, kind, path, operator, expected };
}

function planWarnings(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
): readonly string[] {
  const warnings: string[] = [];
  const workflow = getCalibrationWorkflow(definition.id);
  if (workflow?.deviceGating.automation === 'bambu-proprietary-auto') {
    warnings.push('Vendor automatic measurement is not inherited; this plan is manual-only.');
  }
  if (definition.id === 'junction-deviation' && number(parameters, 'end') > 0.3) {
    warnings.push('The pinned dialog warns that junction deviation above 0.3 mm may cause layer shifts.');
  }
  if (definition.id === 'max-volumetric-speed') {
    warnings.push(
      'Wall-speed overrides use the pinned line-width/layer-height flow conversion and require slice-oracle verification.',
    );
  }
  return warnings;
}

function predictedEffectCount(
  definition: CalibrationJobDefinition,
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
  prerequisites: CalibrationJobPrerequisites,
): number {
  switch (definition.id) {
    case 'flow-pass-1':
      return 9;
    case 'flow-pass-2':
      return 10;
    case 'flow-yolo':
      return 11;
    case 'flow-yolo-perfectionist':
      return 16;
    case 'tolerance-extension':
      return numberList(parameters, 'testClearances').length;
    case 'junction-deviation':
    case 'input-shaping-frequency':
    case 'input-shaping-damping':
      return layerEffectCount(prerequisites, selectedTowerHeight(parameters));
    case 'temperature-tower':
      return sweepCount(number(parameters, 'start') - number(parameters, 'end'), number(parameters, 'step'));
    default:
      return sweepCount(number(parameters, 'end') - number(parameters, 'start'), number(parameters, 'step'));
  }
}

function selectedTowerEnvelope(
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
): readonly [number, number, number] {
  return parameters.testModel === 'Fast Tower' ? [40.282, 40.261, 60.001] : [120.001, 120, 60];
}

function selectedTowerHeight(parameters: Readonly<Record<string, CalibrationParameterValue>>): number {
  return selectedTowerEnvelope(parameters)[2];
}

function layerEffectCount(prerequisites: CalibrationJobPrerequisites, heightMm: number): number {
  return Math.ceil(heightMm / prerequisites.process.layerHeightMm);
}

function volumetricWallSpeed(value: number, prerequisites: CalibrationJobPrerequisites): number {
  const nozzle = prerequisites.nozzle.diameterMm;
  const lineWidth = nozzle * 1.75;
  const layerHeight = nozzle * 0.8;
  const crossSection = layerHeight * (lineWidth - layerHeight) + Math.PI * (layerHeight / 2) ** 2;
  return value / (crossSection * prerequisites.filament.flowRatio);
}

function validateAlignedSpan(span: number, step: number, issues: CalibrationJobValidationIssue[]): void {
  if (!Number.isFinite(step) || step <= 0) return;
  const count = span / step;
  if (Math.abs(count - Math.round(count)) > 1e-7 * Math.max(1, Math.abs(count))) {
    issue(issues, 'sweep-alignment', '$.parameters.step', 'Start/end span must contain a whole number of steps');
  }
}

function validateMotionList(
  value: CalibrationParameterValue | undefined,
  maximum: number,
  key: string,
  issues: CalibrationJobValidationIssue[],
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (entry > maximum) issue(issues, 'motion-limit', `$.parameters.${key}[${index}]`, `Value exceeds ${maximum}`);
  });
}

function hasFirmwareCapability(
  firmware: CalibrationFirmwarePrerequisites | undefined,
  capability: CalibrationFirmwareCapability,
): boolean {
  if (!firmware) return false;
  return firmware[firmwareCapabilityField(capability)];
}

function firmwareCapabilityField(
  capability: CalibrationFirmwareCapability,
): 'nozzleTemperature' | 'pressureAdvance' | 'inputShaping' | 'junctionDeviation' {
  switch (capability) {
    case 'nozzle-temperature':
      return 'nozzleTemperature';
    case 'pressure-advance':
      return 'pressureAdvance';
    case 'input-shaping':
      return 'inputShaping';
    case 'junction-deviation':
      return 'junctionDeviation';
  }
}

function applyConditionalDefaults(
  definitionId: CalibrationWorkflowId,
  output: Record<string, CalibrationParameterValue>,
  supplied: Readonly<Record<string, CalibrationParameterValue>>,
): void {
  const workflow = getCalibrationWorkflow(definitionId);
  if (!workflow) return;
  const selector =
    definitionId === 'temperature-tower'
      ? typeof supplied.filamentType === 'string'
        ? supplied.filamentType
        : undefined
      : definitionId.startsWith('pressure-advance-') && typeof supplied.extruderType === 'string'
        ? supplied.extruderType
        : undefined;
  if (!selector) return;
  for (const parameter of workflow.parameters) {
    if (Object.hasOwn(supplied, parameter.key) || !isJsonRecord(parameter.default)) continue;
    const selected = parameter.default[selector];
    if (typeof selected === 'number' && Number.isFinite(selected)) output[parameter.key] = selected;
  }
}

function requireDefinition(id: string): CalibrationJobDefinition {
  const definition = getCalibrationJobDefinition(id);
  if (!definition) {
    throw new CalibrationJobValidationError([
      { code: 'unknown-definition', path: '$.definitionId', message: `Unknown calibration ${id}` },
    ]);
  }
  return definition;
}

function validateJobId(jobId: string, issues: CalibrationJobValidationIssue[]): void {
  if (!/^calibration:[a-z0-9][a-z0-9._:-]{0,127}$/.test(jobId)) {
    issue(issues, 'job-id', '$.jobId', 'Expected a stable calibration:<id> identity');
  }
}

function issue(issues: CalibrationJobValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function isPlainRecord(value: unknown): value is Record<string, CalibrationParameterValue> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneParameters(
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
): Readonly<Record<string, CalibrationParameterValue>> {
  return Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, cloneParameterValue(value)]));
}

function cloneParameterValue(value: CalibrationParameterValue): CalibrationParameterValue {
  return Array.isArray(value) ? [...value] : value;
}

function sameParameterValue(left: CalibrationParameterValue, right: CalibrationParameterValue): boolean {
  return Array.isArray(left) && Array.isArray(right) ? sameNumberList(left, right) : left === right;
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function number(parameters: Readonly<Record<string, CalibrationParameterValue>>, key: string): number {
  const value = parameters[key];
  if (typeof value !== 'number') throw new Error(`Validated calibration parameter ${key} is not numeric`);
  return value;
}

function optionalNumber(value: CalibrationParameterValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function numberList(parameters: Readonly<Record<string, CalibrationParameterValue>>, key: string): readonly number[] {
  const value = parameters[key];
  if (!Array.isArray(value)) throw new Error(`Validated calibration parameter ${key} is not a number list`);
  return value;
}

function ascendingSweep(start: number, end: number, step: number): readonly number[] {
  return Array.from({ length: sweepCount(end - start, step) }, (_, index) => round(start + index * step));
}

function descendingSweep(start: number, end: number, step: number): readonly number[] {
  return Array.from({ length: sweepCount(start - end, step) }, (_, index) => round(start - index * step));
}

function sweepCount(span: number, step: number): number {
  return Math.round(span / step) + 1;
}

function translationColumn(index: number, count: number, extent: number): number {
  return ((index + 1) * extent) / (count + 1);
}

function format(value: string | number): string {
  return typeof value === 'number' ? String(round(value)) : value;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
