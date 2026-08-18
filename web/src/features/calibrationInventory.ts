import generatedInventory from './generated/calibration-inventory.json' with { type: 'json' };

export const PINNED_CALIBRATION_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626';

export const CALIBRATION_MODES = [
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
] as const;

export const CALIBRATION_WORKFLOW_IDS = [
  'temperature-tower',
  'flow-pass-1',
  'flow-pass-2',
  'flow-yolo',
  'flow-yolo-perfectionist',
  'pressure-advance-tower',
  'pressure-advance-line',
  'pressure-advance-pattern',
  'retraction-tower',
  'max-volumetric-speed',
  'junction-deviation',
  'input-shaping-frequency',
  'input-shaping-damping',
  'vfa',
  'tolerance-extension',
] as const;

export type CalibrationMode = (typeof CALIBRATION_MODES)[number];
export type CalibrationWorkflowId = (typeof CALIBRATION_WORKFLOW_IDS)[number];
export type CalibrationEffectCategory = 'per-height' | 'per-object' | 'generated-gcode';
export type CalibrationWorkflowOrigin = 'pinned-menu' | 'documented-extension';
export type CalibrationParameterKind = 'choice' | 'number' | 'boolean' | 'positive-integer-list' | 'number-list';
export type CalibrationPresetScope = 'filament' | 'printer' | 'process' | 'firmware';
export type CalibrationPresetApplication = 'manual' | 'manual-transfer';
export type CalibrationLocalStatus = 'alpha-geometry-only' | 'unbound';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CalibrationModeDefinition {
  readonly name: CalibrationMode;
  readonly value: number;
}

export interface CalibrationSource {
  readonly id: string;
  readonly path: string;
  readonly blob: string;
  readonly role: 'enum' | 'menu' | 'dialog' | 'workflow' | 'gcode' | 'device-gate' | 'results' | 'extension';
}

export interface CalibrationParameter {
  readonly key: string;
  readonly label: string;
  readonly kind: CalibrationParameterKind;
  readonly unit: string | null;
  readonly default: JsonValue;
  readonly choices: readonly string[];
  readonly editable: boolean;
  readonly enabledWhen: string | null;
  readonly constraints: readonly string[];
}

export interface CalibrationResource {
  readonly path: string;
  readonly blob: string;
  readonly role: 'model' | 'template' | 'device-template';
}

export interface CalibrationEffect {
  readonly category: CalibrationEffectCategory;
  readonly detail: string;
}

export interface CalibrationResultField {
  readonly key: string;
  readonly label: string;
  readonly unit: string | null;
  readonly required: boolean;
}

export interface CalibrationPresetTarget {
  readonly scope: CalibrationPresetScope;
  readonly key: string;
  readonly application: CalibrationPresetApplication;
}

export interface CalibrationLocalBinding {
  readonly actionId: string | null;
  readonly argument: string | null;
  readonly status: CalibrationLocalStatus;
  readonly detail: string;
}

export interface CalibrationDeviceGating {
  readonly automation: 'manual-only' | 'bambu-proprietary-auto';
  readonly requirements: readonly string[];
  readonly orcaxrStatus: 'local-generation-does-not-require-device' | 'blocked-proprietary-auto';
}

export interface CalibrationMenuBinding {
  readonly path: readonly string[];
  readonly label: string;
  readonly invocation: string;
}

export interface CalibrationWorkflow {
  readonly id: CalibrationWorkflowId;
  readonly origin: CalibrationWorkflowOrigin;
  readonly label: string;
  readonly enumMode: CalibrationMode | null;
  readonly menu: CalibrationMenuBinding | null;
  readonly parameters: readonly CalibrationParameter[];
  readonly resources: readonly CalibrationResource[];
  readonly effects: readonly CalibrationEffect[];
  readonly resultFields: readonly CalibrationResultField[];
  readonly presetTargets: readonly CalibrationPresetTarget[];
  readonly localBinding: CalibrationLocalBinding;
  readonly deviceGating: CalibrationDeviceGating;
  readonly sourceRefs: readonly string[];
  readonly notes: readonly string[];
}

/**
 * The upstream guide a workflow is documented by, resolved to a Git blob at the
 * pinned commit. The blob is what makes the link checkable without the upstream
 * clone: it could only have been produced by resolving the path in that tree,
 * so a build with no checkout still verifies the target it links to existed.
 */
export interface CalibrationDocumentationTarget {
  readonly workflowId: CalibrationWorkflowId;
  readonly path: string;
  readonly blob: string;
}

export interface CalibrationInventory {
  readonly schemaVersion: 1;
  readonly upstream: {
    readonly repository: 'https://github.com/Snapmaker/OrcaSlicer.git';
    readonly commit: typeof PINNED_CALIBRATION_COMMIT;
    readonly tree: string;
  };
  readonly modeSource: {
    readonly sourceId: 'calib-mode';
    readonly path: 'src/libslic3r/calib.hpp';
    readonly blob: string;
    readonly parityPath: 'docs/parity/snapmaker-v2.3.4.json';
    readonly parityTask: 'P8.1';
    readonly excludedMode: 'Calib_None';
    readonly count: 11;
  };
  readonly modes: readonly CalibrationModeDefinition[];
  readonly sources: readonly CalibrationSource[];
  readonly effectCategories: readonly {
    readonly id: CalibrationEffectCategory;
    readonly description: string;
  }[];
  readonly workflows: readonly CalibrationWorkflow[];
  readonly documentation: readonly CalibrationDocumentationTarget[];
  readonly deviceAutomation: {
    readonly orcaxrPolicy: 'manual-only';
    readonly supportedTransport: 'moonraker';
    readonly unavailableTransports: readonly ('vendor-cloud' | 'serial' | 'usb')[];
    readonly targetPrinters: readonly string[];
    readonly gates: readonly {
      readonly id: string;
      readonly workflowIds: readonly CalibrationWorkflowId[];
      readonly upstreamRequirements: readonly string[];
      readonly orcaxrDecision: string;
    }[];
  };
  readonly localImplementation: {
    readonly actionSource: 'src/actions/groups/calibration.ts';
    readonly workspaceSource: 'src/workspace/OrcaWorkspace.ts';
    readonly generatorSource: 'src/features/CalibrationRampGenerator.ts';
    readonly statusMeaning: {
      readonly 'alpha-geometry-only': string;
      readonly unbound: string;
    };
  };
}

export class CalibrationInventoryValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CalibrationInventoryValidationError';
  }
}

const SOURCE_IDS = [
  'calib-mode',
  'main-menu',
  'dialogs',
  'plater-workflows',
  'layer-gcode',
  'calib-core',
  'calib-utils',
  'device-start-gates',
  'device-preset-gates',
  'device-firmware-gate',
  'wizard-results',
  'tolerance-doc',
  'handy-model-menu',
] as const;

const EFFECT_CATEGORIES = ['per-height', 'per-object', 'generated-gcode'] as const;
const SHA1 = /^[0-9a-f]{40}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;

function fail(path: string, message: string): never {
  throw new CalibrationInventoryValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(path, 'expected a plain object');
  }
  const candidate = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of Object.keys(candidate)) {
    if (!expected.has(key)) fail(`${path}.${key}`, 'unknown field');
  }
  for (const key of keys) {
    if (!Object.hasOwn(candidate, key)) fail(`${path}.${key}`, 'missing field');
  }
  return candidate;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string');
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  return value as T;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function unique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(path, `duplicate value ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function gitBlob(value: unknown, path: string): string {
  const blob = string(value, path);
  if (!SHA1.test(blob)) fail(path, 'expected a lowercase 40-character Git object ID');
  return blob;
}

function relativePath(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!SAFE_RELATIVE_PATH.test(parsed)) fail(path, 'expected a safe repository-relative path');
  return parsed;
}

function jsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    finiteNumber(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonValue(item, `${path}[${index}]`));
    return;
  }
  const object = record(value, path, Object.keys(value as object));
  for (const [key, item] of Object.entries(object)) jsonValue(item, `${path}.${key}`);
}

function numericDefault(value: unknown, path: string): void {
  if (typeof value === 'number') {
    finiteNumber(value, path);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected a number or an object whose leaves are numbers');
  }
  const object = record(value, path, Object.keys(value as object));
  if (Object.keys(object).length === 0) fail(path, 'conditional numeric default must not be empty');
  for (const [key, item] of Object.entries(object)) numericDefault(item, `${path}.${key}`);
}

function validateMode(value: unknown, path: string, index: number): void {
  const mode = record(value, path, ['name', 'value']);
  literal(mode.name, CALIBRATION_MODES[index], `${path}.name`);
  literal(mode.value, index + 1, `${path}.value`);
}

function validateSource(value: unknown, path: string, index: number): void {
  const source = record(value, path, ['id', 'path', 'blob', 'role']);
  literal(source.id, SOURCE_IDS[index], `${path}.id`);
  relativePath(source.path, `${path}.path`);
  gitBlob(source.blob, `${path}.blob`);
  oneOf(
    source.role,
    ['enum', 'menu', 'dialog', 'workflow', 'gcode', 'device-gate', 'results', 'extension'],
    `${path}.role`,
  );
}

function validateParameter(value: unknown, path: string): void {
  const parameter = record(value, path, [
    'key',
    'label',
    'kind',
    'unit',
    'default',
    'choices',
    'editable',
    'enabledWhen',
    'constraints',
  ]);
  string(parameter.key, `${path}.key`);
  string(parameter.label, `${path}.label`);
  const kind = oneOf(
    parameter.kind,
    ['choice', 'number', 'boolean', 'positive-integer-list', 'number-list'],
    `${path}.kind`,
  );
  nullableString(parameter.unit, `${path}.unit`);
  jsonValue(parameter.default, `${path}.default`);
  const choices = strings(parameter.choices, `${path}.choices`);
  unique(choices, `${path}.choices`);
  boolean(parameter.editable, `${path}.editable`);
  nullableString(parameter.enabledWhen, `${path}.enabledWhen`);
  strings(parameter.constraints, `${path}.constraints`);

  if (kind === 'choice') {
    if (choices.length === 0) fail(`${path}.choices`, 'choice parameters require at least one choice');
    const selected = string(parameter.default, `${path}.default`);
    if (!choices.includes(selected)) fail(`${path}.default`, 'default must be one of choices');
  } else if (choices.length !== 0) {
    fail(`${path}.choices`, 'only choice parameters may define choices');
  }

  if (kind === 'number') numericDefault(parameter.default, `${path}.default`);
  if (kind === 'boolean' && typeof parameter.default !== 'boolean') {
    fail(`${path}.default`, 'boolean parameters require a boolean default');
  }
  if (kind === 'positive-integer-list') {
    for (const [index, item] of array(parameter.default, `${path}.default`).entries()) {
      const parsed = finiteNumber(item, `${path}.default[${index}]`);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        fail(`${path}.default[${index}]`, 'expected a positive integer');
      }
    }
  }
  if (kind === 'number-list') {
    for (const [index, item] of array(parameter.default, `${path}.default`).entries()) {
      finiteNumber(item, `${path}.default[${index}]`);
    }
  }
}

function validateResource(value: unknown, path: string): void {
  const resource = record(value, path, ['path', 'blob', 'role']);
  relativePath(resource.path, `${path}.path`);
  gitBlob(resource.blob, `${path}.blob`);
  oneOf(resource.role, ['model', 'template', 'device-template'], `${path}.role`);
}

function validateEffect(value: unknown, path: string): void {
  const effect = record(value, path, ['category', 'detail']);
  oneOf(effect.category, EFFECT_CATEGORIES, `${path}.category`);
  string(effect.detail, `${path}.detail`);
}

function validateResultField(value: unknown, path: string): void {
  const field = record(value, path, ['key', 'label', 'unit', 'required']);
  string(field.key, `${path}.key`);
  string(field.label, `${path}.label`);
  nullableString(field.unit, `${path}.unit`);
  boolean(field.required, `${path}.required`);
}

function validatePresetTarget(value: unknown, path: string): void {
  const target = record(value, path, ['scope', 'key', 'application']);
  oneOf(target.scope, ['filament', 'printer', 'process', 'firmware'], `${path}.scope`);
  string(target.key, `${path}.key`);
  oneOf(target.application, ['manual', 'manual-transfer'], `${path}.application`);
}

function validateLocalBinding(value: unknown, path: string): void {
  const binding = record(value, path, ['actionId', 'argument', 'status', 'detail']);
  const actionId = nullableString(binding.actionId, `${path}.actionId`);
  const argument = nullableString(binding.argument, `${path}.argument`);
  const status = oneOf(binding.status, ['alpha-geometry-only', 'unbound'], `${path}.status`);
  string(binding.detail, `${path}.detail`);
  if (status === 'unbound' && (actionId !== null || argument !== null)) {
    fail(path, 'unbound workflows must have null actionId and argument');
  }
  if (status === 'alpha-geometry-only' && (actionId === null || argument === null)) {
    fail(path, 'alpha-geometry-only workflows require actionId and argument');
  }
}

function validateDeviceGating(value: unknown, path: string): void {
  const gating = record(value, path, ['automation', 'requirements', 'orcaxrStatus']);
  const automation = oneOf(gating.automation, ['manual-only', 'bambu-proprietary-auto'], `${path}.automation`);
  const requirements = strings(gating.requirements, `${path}.requirements`);
  const status = oneOf(
    gating.orcaxrStatus,
    ['local-generation-does-not-require-device', 'blocked-proprietary-auto'],
    `${path}.orcaxrStatus`,
  );
  if (
    automation === 'manual-only' &&
    (requirements.length !== 0 || status !== 'local-generation-does-not-require-device')
  ) {
    fail(path, 'manual-only gating must have no device requirements and a local-generation status');
  }
  if (automation === 'bambu-proprietary-auto' && (requirements.length === 0 || status !== 'blocked-proprietary-auto')) {
    fail(path, 'proprietary automation must name its gates and remain blocked in OrcaXR');
  }
}

function validateMenu(value: unknown, path: string): void {
  const menu = record(value, path, ['path', 'label', 'invocation']);
  const menuPath = strings(menu.path, `${path}.path`);
  if (menuPath.length < 2 || menuPath[0] !== 'Calibration') {
    fail(`${path}.path`, 'pinned workflows require a Calibration-rooted menu path');
  }
  string(menu.label, `${path}.label`);
  string(menu.invocation, `${path}.invocation`);
}

function validateWorkflow(value: unknown, path: string, index: number): void {
  const workflow = record(value, path, [
    'id',
    'origin',
    'label',
    'enumMode',
    'menu',
    'parameters',
    'resources',
    'effects',
    'resultFields',
    'presetTargets',
    'localBinding',
    'deviceGating',
    'sourceRefs',
    'notes',
  ]);
  literal(workflow.id, CALIBRATION_WORKFLOW_IDS[index], `${path}.id`);
  const origin = oneOf(workflow.origin, ['pinned-menu', 'documented-extension'], `${path}.origin`);
  string(workflow.label, `${path}.label`);
  const enumMode = workflow.enumMode === null ? null : oneOf(workflow.enumMode, CALIBRATION_MODES, `${path}.enumMode`);

  if (origin === 'pinned-menu') {
    if (enumMode === null) fail(`${path}.enumMode`, 'pinned menu workflows require a CalibMode');
    if (workflow.menu === null) fail(`${path}.menu`, 'pinned menu workflows require a menu binding');
    validateMenu(workflow.menu, `${path}.menu`);
  } else {
    if (workflow.id !== 'tolerance-extension') {
      fail(`${path}.id`, 'schema v1 only permits the documented tolerance extension');
    }
    if (enumMode !== null) fail(`${path}.enumMode`, 'documented tolerance must remain explicitly non-enum');
    if (workflow.menu !== null) fail(`${path}.menu`, 'documented tolerance is not a pinned Calibration-menu variant');
  }

  const parameters = array(workflow.parameters, `${path}.parameters`);
  parameters.forEach((parameter, parameterIndex) =>
    validateParameter(parameter, `${path}.parameters[${parameterIndex}]`),
  );
  unique(
    parameters.map((parameter, parameterIndex) =>
      string((parameter as Record<string, unknown>).key, `${path}.parameters[${parameterIndex}].key`),
    ),
    `${path}.parameters`,
  );

  const resources = array(workflow.resources, `${path}.resources`);
  resources.forEach((resource, resourceIndex) => validateResource(resource, `${path}.resources[${resourceIndex}]`));
  unique(
    resources.map((resource, resourceIndex) =>
      string((resource as Record<string, unknown>).path, `${path}.resources[${resourceIndex}].path`),
    ),
    `${path}.resources`,
  );

  const effects = array(workflow.effects, `${path}.effects`);
  if (effects.length === 0) fail(`${path}.effects`, 'at least one effect is required');
  effects.forEach((effect, effectIndex) => validateEffect(effect, `${path}.effects[${effectIndex}]`));
  unique(
    effects.map((effect, effectIndex) =>
      string((effect as Record<string, unknown>).category, `${path}.effects[${effectIndex}].category`),
    ),
    `${path}.effects`,
  );

  const resultFields = array(workflow.resultFields, `${path}.resultFields`);
  if (resultFields.length === 0) fail(`${path}.resultFields`, 'at least one result field is required');
  resultFields.forEach((field, fieldIndex) => validateResultField(field, `${path}.resultFields[${fieldIndex}]`));
  unique(
    resultFields.map((field, fieldIndex) =>
      string((field as Record<string, unknown>).key, `${path}.resultFields[${fieldIndex}].key`),
    ),
    `${path}.resultFields`,
  );

  const presetTargets = array(workflow.presetTargets, `${path}.presetTargets`);
  presetTargets.forEach((target, targetIndex) => validatePresetTarget(target, `${path}.presetTargets[${targetIndex}]`));
  unique(
    presetTargets.map((target, targetIndex) => {
      const candidate = target as Record<string, unknown>;
      return `${string(candidate.scope, `${path}.presetTargets[${targetIndex}].scope`)}:${string(
        candidate.key,
        `${path}.presetTargets[${targetIndex}].key`,
      )}`;
    }),
    `${path}.presetTargets`,
  );

  validateLocalBinding(workflow.localBinding, `${path}.localBinding`);
  validateDeviceGating(workflow.deviceGating, `${path}.deviceGating`);
  const sourceRefs = strings(workflow.sourceRefs, `${path}.sourceRefs`);
  if (sourceRefs.length === 0) fail(`${path}.sourceRefs`, 'at least one pinned source reference is required');
  unique(sourceRefs, `${path}.sourceRefs`);
  for (const sourceRef of sourceRefs) {
    if (!(SOURCE_IDS as readonly string[]).includes(sourceRef)) {
      fail(`${path}.sourceRefs`, `unknown source reference ${JSON.stringify(sourceRef)}`);
    }
  }
  strings(workflow.notes, `${path}.notes`);
}

function validateDeviceAutomation(value: unknown, path: string): void {
  const automation = record(value, path, [
    'orcaxrPolicy',
    'supportedTransport',
    'unavailableTransports',
    'targetPrinters',
    'gates',
  ]);
  literal(automation.orcaxrPolicy, 'manual-only', `${path}.orcaxrPolicy`);
  literal(automation.supportedTransport, 'moonraker', `${path}.supportedTransport`);
  const unavailable = strings(automation.unavailableTransports, `${path}.unavailableTransports`);
  if (JSON.stringify(unavailable) !== JSON.stringify(['vendor-cloud', 'serial', 'usb'])) {
    fail(`${path}.unavailableTransports`, 'expected vendor-cloud, serial, and usb to remain unavailable');
  }
  const targetPrinters = strings(automation.targetPrinters, `${path}.targetPrinters`);
  if (JSON.stringify(targetPrinters) !== JSON.stringify(['Snapmaker U1', 'Elegoo Centauri Carbon'])) {
    fail(`${path}.targetPrinters`, 'unexpected OrcaXR calibration target printers');
  }
  const gates = array(automation.gates, `${path}.gates`);
  if (gates.length !== 3) fail(`${path}.gates`, 'expected exactly three explicit device gate records');
  const gateIds: string[] = [];
  for (const [index, value] of gates.entries()) {
    const gatePath = `${path}.gates[${index}]`;
    const gate = record(value, gatePath, ['id', 'workflowIds', 'upstreamRequirements', 'orcaxrDecision']);
    gateIds.push(string(gate.id, `${gatePath}.id`));
    const workflowIds = strings(gate.workflowIds, `${gatePath}.workflowIds`);
    unique(workflowIds, `${gatePath}.workflowIds`);
    for (const workflowId of workflowIds) {
      if (!(CALIBRATION_WORKFLOW_IDS as readonly string[]).includes(workflowId)) {
        fail(`${gatePath}.workflowIds`, `unknown workflow ${JSON.stringify(workflowId)}`);
      }
    }
    const requirements = strings(gate.upstreamRequirements, `${gatePath}.upstreamRequirements`);
    if (requirements.length === 0) fail(`${gatePath}.upstreamRequirements`, 'device gate must name requirements');
    string(gate.orcaxrDecision, `${gatePath}.orcaxrDecision`);
  }
  if (
    JSON.stringify(gateIds) !== JSON.stringify(['pressure-advance-auto', 'flow-rate-auto', 'device-print-dispatch'])
  ) {
    fail(`${path}.gates`, 'unexpected device gate IDs or ordering');
  }
}

function validateLocalImplementation(value: unknown, path: string): void {
  const implementation = record(value, path, ['actionSource', 'workspaceSource', 'generatorSource', 'statusMeaning']);
  literal(implementation.actionSource, 'src/actions/groups/calibration.ts', `${path}.actionSource`);
  literal(implementation.workspaceSource, 'src/workspace/OrcaWorkspace.ts', `${path}.workspaceSource`);
  literal(implementation.generatorSource, 'src/features/CalibrationRampGenerator.ts', `${path}.generatorSource`);
  const meanings = record(implementation.statusMeaning, `${path}.statusMeaning`, ['alpha-geometry-only', 'unbound']);
  string(meanings['alpha-geometry-only'], `${path}.statusMeaning.alpha-geometry-only`);
  string(meanings.unbound, `${path}.statusMeaning.unbound`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Parse an inventory without defaults or coercion. Unknown, missing, malformed,
 * future-schema, or semantically inconsistent data throws and therefore cannot
 * become an executable calibration catalog.
 */
export function parseCalibrationInventory(input: unknown): CalibrationInventory {
  const root = record(input, '$', [
    'schemaVersion',
    'upstream',
    'modeSource',
    'modes',
    'sources',
    'effectCategories',
    'workflows',
    'documentation',
    'deviceAutomation',
    'localImplementation',
  ]);
  literal(root.schemaVersion, 1, '$.schemaVersion');

  const upstream = record(root.upstream, '$.upstream', ['repository', 'commit', 'tree']);
  literal(upstream.repository, 'https://github.com/Snapmaker/OrcaSlicer.git', '$.upstream.repository');
  literal(upstream.commit, PINNED_CALIBRATION_COMMIT, '$.upstream.commit');
  gitBlob(upstream.tree, '$.upstream.tree');

  const modeSource = record(root.modeSource, '$.modeSource', [
    'sourceId',
    'path',
    'blob',
    'parityPath',
    'parityTask',
    'excludedMode',
    'count',
  ]);
  literal(modeSource.sourceId, 'calib-mode', '$.modeSource.sourceId');
  literal(modeSource.path, 'src/libslic3r/calib.hpp', '$.modeSource.path');
  const modeBlob = gitBlob(modeSource.blob, '$.modeSource.blob');
  literal(modeSource.parityPath, 'docs/parity/snapmaker-v2.3.4.json', '$.modeSource.parityPath');
  literal(modeSource.parityTask, 'P8.1', '$.modeSource.parityTask');
  literal(modeSource.excludedMode, 'Calib_None', '$.modeSource.excludedMode');
  literal(modeSource.count, 11, '$.modeSource.count');

  const modes = array(root.modes, '$.modes');
  if (modes.length !== CALIBRATION_MODES.length) fail('$.modes', 'expected exactly 11 non-None modes');
  modes.forEach((mode, index) => validateMode(mode, `$.modes[${index}]`, index));

  const sources = array(root.sources, '$.sources');
  if (sources.length !== SOURCE_IDS.length) fail('$.sources', `expected exactly ${SOURCE_IDS.length} sources`);
  sources.forEach((source, index) => validateSource(source, `$.sources[${index}]`, index));
  const enumSource = sources[0] as Record<string, unknown>;
  if (enumSource.blob !== modeBlob) fail('$.modeSource.blob', 'must match the calib-mode source blob');

  const effectCategories = array(root.effectCategories, '$.effectCategories');
  if (effectCategories.length !== EFFECT_CATEGORIES.length) {
    fail('$.effectCategories', 'expected exactly three effect category definitions');
  }
  effectCategories.forEach((value, index) => {
    const categoryPath = `$.effectCategories[${index}]`;
    const category = record(value, categoryPath, ['id', 'description']);
    literal(category.id, EFFECT_CATEGORIES[index], `${categoryPath}.id`);
    string(category.description, `${categoryPath}.description`);
  });

  const workflows = array(root.workflows, '$.workflows');
  if (workflows.length !== CALIBRATION_WORKFLOW_IDS.length) {
    fail('$.workflows', 'expected exactly 14 pinned menu variants plus tolerance');
  }
  workflows.forEach((workflow, index) => validateWorkflow(workflow, `$.workflows[${index}]`, index));

  const modeCounts = new Map<CalibrationMode, number>(CALIBRATION_MODES.map((mode) => [mode, 0]));
  const resourceBlobs = new Map<string, string>();
  for (const [index, rawWorkflow] of workflows.entries()) {
    const workflow = rawWorkflow as Record<string, unknown>;
    if (workflow.enumMode !== null) {
      const mode = workflow.enumMode as CalibrationMode;
      modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
    }
    for (const [resourceIndex, rawResource] of (workflow.resources as Record<string, unknown>[]).entries()) {
      const resource = rawResource;
      const path = resource.path as string;
      const blob = resource.blob as string;
      const prior = resourceBlobs.get(path);
      if (prior !== undefined && prior !== blob) {
        fail(`$.workflows[${index}].resources[${resourceIndex}].blob`, `conflicts with another reference to ${path}`);
      }
      resourceBlobs.set(path, blob);
    }
  }
  const expectedModeCounts: Record<CalibrationMode, number> = {
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
  };
  for (const mode of CALIBRATION_MODES) {
    if (modeCounts.get(mode) !== expectedModeCounts[mode]) {
      fail('$.workflows', `unexpected workflow coverage for ${mode}`);
    }
  }

  const documentation = array(root.documentation, '$.documentation');
  if (documentation.length !== CALIBRATION_WORKFLOW_IDS.length) {
    fail('$.documentation', 'every workflow must name exactly one documentation target');
  }
  documentation.forEach((value, index) => {
    const targetPath = `$.documentation[${index}]`;
    const target = record(value, targetPath, ['workflowId', 'blob', 'path']);
    literal(target.workflowId, CALIBRATION_WORKFLOW_IDS[index], `${targetPath}.workflowId`);
    const documentPath = string(target.path, `${targetPath}.path`);
    if (!/^doc\/calibration\/[a-z0-9-]+\.md$/.test(documentPath)) {
      fail(`${targetPath}.path`, 'expected an upstream calibration guide under doc/calibration/');
    }
    gitBlob(target.blob, `${targetPath}.blob`);
  });

  validateDeviceAutomation(root.deviceAutomation, '$.deviceAutomation');
  validateLocalImplementation(root.localImplementation, '$.localImplementation');
  return deepFreeze(input as CalibrationInventory);
}

export const calibrationInventory = parseCalibrationInventory(generatedInventory as unknown);

/** Unknown IDs return no workflow; callers must never fall back to a different calibration. */
export function getCalibrationWorkflow(id: string): CalibrationWorkflow | undefined {
  return calibrationInventory.workflows.find((workflow) => workflow.id === id);
}
