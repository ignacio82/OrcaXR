import { isStableEntityId } from './ids';
import { assertCanonicalSerializable, canonicalStringify, isDeeplyFrozen } from './canonical';
import {
  facetAnnotationsHaveAssignments,
  validateFacetRefinementChannel,
  type FacetRefinementChannel,
} from './facetRefinement';
import type { FilamentId, PhysicalFilamentId } from './ids';
import type {
  ConfigMap,
  FacetAnnotations,
  JsonValue,
  MixedFilament,
  ProjectState,
  SourceAssetDescriptor,
  Transform,
  TriangleAssignments,
} from './model';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: ValidationSeverity;
}

/** Taller than any printable Z on a consumer FFF machine; a guard, not a bed limit. */
const MAX_LAYER_EVENT_Z_MM = 10_000;

const SUPPORTED_VOLUME_ROLES = new Set([
  'model',
  'negative-volume',
  'parameter-modifier',
  'support-blocker',
  'support-enforcer',
]);

export class ProjectValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    const errors = issues.filter((issue) => issue.severity === 'error');
    // Name the first failure: this message is what a status line or a rejected
    // command shows, and "1 errors" tells the operator nothing actionable.
    const first = errors[0];
    super(`Invalid project state (${errors.length} errors)` + (first ? `: ${first.message} at ${first.path}` : ''));
    this.name = 'ProjectValidationError';
  }
}

export function assertValidProjectState(state: ProjectState): void {
  const issues = validateProjectState(state);
  if (issues.some((issue) => issue.severity === 'error')) throw new ProjectValidationError(issues);
}

/**
 * Validation results for states that can never change again.
 *
 * Preflight validates the state it was handed, and on the live path that state
 * came straight out of the store, which already validated and froze it. On a
 * large painted project that repeat cost most of a second on every profile,
 * filament, and placement change. The answer is a pure function of the state,
 * so for a provably immutable one it is computed once.
 */
const frozenResults = new WeakMap<object, readonly ValidationIssue[]>();

export function validateProjectState(state: ProjectState): ValidationIssue[] {
  const memoized = frozenResults.get(state as unknown as object);
  if (memoized) return memoized.map((issue) => ({ ...issue }));
  const computed = computeProjectStateIssues(state);
  if (isDeeplyFrozen(state)) {
    frozenResults.set(
      state as unknown as object,
      computed.map((issue) => Object.freeze({ ...issue })),
    );
  }
  return computed;
}

function computeProjectStateIssues(state: ProjectState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Map<string, string>();
  const add = (code: string, path: string, message: string, severity: ValidationSeverity = 'error') =>
    issues.push({ code, path, message, severity });
  const id = (value: string, path: string) => {
    if (!isStableEntityId(value)) add('invalid-id', path, `"${value}" is not a stable entity ID`);
    const previous = seenIds.get(value);
    if (previous) add('duplicate-id', path, `ID is already used at ${previous}`);
    else seenIds.set(value, path);
  };

  try {
    // The exception is the whole point of this check; the string never was.
    assertCanonicalSerializable(state);
  } catch (error) {
    add('non-serializable-state', '$', error instanceof Error ? error.message : 'Project state is not serializable');
    return issues;
  }

  if (state.schemaVersion !== 1) add('unsupported-schema', 'schemaVersion', 'Expected schema 1');
  id(state.id, 'id');
  if (!state.name.trim()) add('empty-name', 'name', 'Project name cannot be empty');
  if (!Number.isFinite(Date.parse(state.createdAt))) {
    add('invalid-timestamp', 'createdAt', 'createdAt must be ISO-compatible');
  }
  if (!Number.isFinite(Date.parse(state.updatedAt))) {
    add('invalid-timestamp', 'updatedAt', 'updatedAt must be ISO-compatible');
  }
  if (!Number.isInteger(state.printer.toolCount) || state.printer.toolCount < 1) {
    add('invalid-tool-count', 'printer.toolCount', 'Printer toolCount must be a positive integer');
  }
  validateConfig(state.config, 'config', add);
  let settingsBaseConfig: ConfigMap | undefined;
  if (state.settingsBaseConfig !== undefined) {
    const base = state.settingsBaseConfig as unknown;
    if (base === null || typeof base !== 'object' || Array.isArray(base)) {
      add('invalid-settings-base-config', 'settingsBaseConfig', 'Inherited project settings must be a JSON object');
    } else {
      settingsBaseConfig = base as ConfigMap;
      validateConfig(settingsBaseConfig, 'settingsBaseConfig', add);
    }
  }
  let settingsOverrides: ConfigMap | undefined;
  if (state.settingsOverrides !== undefined) {
    const overrides = state.settingsOverrides as unknown;
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      add('invalid-settings-overrides', 'settingsOverrides', 'Project setting overrides must be a JSON object');
    } else {
      settingsOverrides = overrides as ConfigMap;
      validateConfig(settingsOverrides, 'settingsOverrides', add);
    }
  }
  if (settingsOverrides && !settingsBaseConfig) {
    add(
      'missing-settings-base-config',
      'settingsBaseConfig',
      'Explicit project setting overrides require an inherited settings base',
    );
  }
  if (settingsBaseConfig) {
    const expectedEffective = { ...settingsBaseConfig, ...(settingsOverrides ?? {}) };
    if (canonicalStringify(expectedEffective) !== canonicalStringify(state.config)) {
      add(
        'mismatched-effective-settings-config',
        'config',
        'Effective project configuration must equal inherited settings plus explicit overrides',
      );
    }
  }
  validateExtensionData(state.extensionData, 'extensionData', add);

  const assetIds = new Set<string>();
  const assetById = new Map<string, SourceAssetDescriptor>();
  state.sourceAssets.forEach((asset, index) => {
    const path = `sourceAssets[${index}]`;
    id(asset.id, `${path}.id`);
    assetIds.add(asset.id);
    assetById.set(asset.id, asset);
    if (!asset.digest.trim()) add('missing-digest', `${path}.digest`, 'Asset digest is required');
    if (!Number.isInteger(asset.byteLength) || asset.byteLength < 0) {
      add('invalid-byte-length', `${path}.byteLength`, 'Asset byteLength must be non-negative');
    }
    validateMeshDescriptor(asset, path, add);
  });

  const physicalIds = new Set<string>();
  const mixedIds = new Set<string>();
  const filamentIds = new Set<string>();
  const occupiedTools = new Set<number>();
  state.filaments.physical.forEach((filament, index) => {
    const path = `filaments.physical[${index}]`;
    id(filament.id, `${path}.id`);
    physicalIds.add(filament.id);
    filamentIds.add(filament.id);
    if (!Number.isInteger(filament.toolId) || filament.toolId < 0 || filament.toolId >= state.printer.toolCount) {
      add(
        'tool-out-of-range',
        `${path}.toolId`,
        `Tool ${filament.toolId} is outside [0, ${state.printer.toolCount - 1}]`,
      );
    }
    if (occupiedTools.has(filament.toolId)) {
      add('duplicate-tool', `${path}.toolId`, `Tool ${filament.toolId} has multiple physical filaments`);
    }
    occupiedTools.add(filament.toolId);
    validateConfig(filament.config, `${path}.config`, add);
    validateExtensionData(filament.extensionData, `${path}.extensionData`, add);
  });
  state.filaments.mixed.forEach((filament, index) => {
    const path = `filaments.mixed[${index}]`;
    id(filament.id, `${path}.id`);
    mixedIds.add(filament.id);
    filamentIds.add(filament.id);
    validateMixedShape(filament, path, add);
    validateConfig(filament.config, `${path}.config`, add);
    validateExtensionData(filament.extensionData, `${path}.extensionData`, add);
  });
  validateMixedReferencesAndCycles(state.filaments.mixed, physicalIds, mixedIds, add);

  const plateIds = new Set<string>();
  state.plates.forEach((plate, plateIndex) => {
    const platePath = `plates[${plateIndex}]`;
    id(plate.id, `${platePath}.id`);
    plateIds.add(plate.id);
    validateConfig(plate.config, `${platePath}.config`, add);
    validateExtensionData(plate.extensionData, `${platePath}.extensionData`, add);
    if (!Number.isInteger(plate.order) || plate.order < 0) {
      add('invalid-plate-order', `${platePath}.order`, 'Plate order must be a non-negative integer');
    }
    if (plate.wipeTower) {
      validateFiniteArray(plate.wipeTower.positionMm, `${platePath}.wipeTower.positionMm`, add);
      if (plate.wipeTower.filamentId && !filamentIds.has(plate.wipeTower.filamentId)) {
        add('dangling-filament', `${platePath}.wipeTower.filamentId`, 'Unknown filament reference');
      }
    }

    plate.objects.forEach((object, objectIndex) => {
      const objectPath = `${platePath}.objects[${objectIndex}]`;
      id(object.id, `${objectPath}.id`);
      validateConfig(object.config, `${objectPath}.config`, add);
      validateExtensionData(object.extensionData, `${objectPath}.extensionData`, add);
      validateFilamentRef(object.filamentId, filamentIds, `${objectPath}.filamentId`, add);
      if (object.instances.length === 0) {
        add('object-without-instance', `${objectPath}.instances`, 'An object needs at least one instance');
      }
      if (!object.volumes.some((volume) => volume.role === 'model')) {
        add('object-without-model-volume', `${objectPath}.volumes`, 'An object needs a model volume');
      }

      object.volumes.forEach((volume, volumeIndex) => {
        const volumePath = `${objectPath}.volumes[${volumeIndex}]`;
        id(volume.id, `${volumePath}.id`);
        if (!SUPPORTED_VOLUME_ROLES.has(volume.role)) {
          add(
            'unsupported-volume-role',
            `${volumePath}.role`,
            `Volume role ${JSON.stringify(volume.role)} is not supported by Snapmaker Orca v2.3.4`,
          );
        }
        validateTransform(volume.transform, `${volumePath}.transform`, add);
        validateConfig(volume.config, `${volumePath}.config`, add);
        validateExtensionData(volume.extensionData, `${volumePath}.extensionData`, add);
        validateFilamentRef(volume.filamentId, filamentIds, `${volumePath}.filamentId`, add);
        if (!assetIds.has(volume.source.assetId)) {
          add('dangling-asset', `${volumePath}.source.assetId`, 'Unknown source asset');
        }
        const asset = assetById.get(volume.source.assetId);
        if (asset?.kind !== 'mesh') {
          add('non-mesh-source', `${volumePath}.source.assetId`, 'A volume must reference a mesh asset');
        }
        if (asset?.mesh && asset.mesh.triangleCount !== volume.source.triangleCount) {
          add(
            'triangle-count-mismatch',
            `${volumePath}.source.triangleCount`,
            'Volume triangle count differs from its asset descriptor',
          );
        }
        if (volume.source.topologyRevision < 0 || !Number.isInteger(volume.source.topologyRevision)) {
          add(
            'invalid-topology-revision',
            `${volumePath}.source.topologyRevision`,
            'Topology revision must be a non-negative integer',
          );
        }
        if (
          (volume.role === 'negative-volume' ||
            volume.role === 'support-enforcer' ||
            volume.role === 'support-blocker') &&
          volume.filamentId
        ) {
          add(
            'incompatible-modifier-filament',
            `${volumePath}.filamentId`,
            `${volume.role} cannot own a filament assignment`,
          );
        }
        if (volume.role !== 'model' && facetAnnotationsHaveAssignments(volume.annotations)) {
          add(
            'incompatible-modifier-annotations',
            `${volumePath}.annotations`,
            `${volume.role} cannot own facet paint annotations`,
          );
        }
        validateAnnotations(
          volume.annotations,
          volume.source.topologyRevision,
          volume.source.triangleCount,
          volumePath,
          filamentIds,
          add,
        );
      });

      object.instances.forEach((instance, instanceIndex) => {
        const instancePath = `${objectPath}.instances[${instanceIndex}]`;
        id(instance.id, `${instancePath}.id`);
        validateTransform(instance.transform, `${instancePath}.transform`, add);
        validateExtensionData(instance.extensionData, `${instancePath}.extensionData`, add);
      });

      (object.brimEars ?? []).forEach((ear, earIndex) => {
        const earPath = `${objectPath}.brimEars[${earIndex}]`;
        if (ear.positionMm.length !== 3 || !ear.positionMm.every(Number.isFinite)) {
          add('invalid-brim-ear', `${earPath}.positionMm`, 'A brim ear needs three finite coordinates');
        }
        if (!Number.isFinite(ear.headFrontRadiusMm) || ear.headFrontRadiusMm <= 0) {
          add('invalid-brim-ear', `${earPath}.headFrontRadiusMm`, 'A brim ear needs a positive front radius');
        }
      });

      const ranges = [...object.layerRanges].sort((a, b) => a.minZMm - b.minZMm);
      ranges.forEach((range, rangeIndex) => {
        const originalIndex = object.layerRanges.indexOf(range);
        const rangePath = `${objectPath}.layerRanges[${originalIndex}]`;
        id(range.id, `${rangePath}.id`);
        if (
          !Number.isFinite(range.minZMm) ||
          !Number.isFinite(range.maxZMm) ||
          range.minZMm < 0 ||
          range.maxZMm <= range.minZMm
        ) {
          add('invalid-layer-range', rangePath, 'Layer range must have 0 <= minZMm < maxZMm');
        }
        if (rangeIndex > 0 && range.minZMm < ranges[rangeIndex - 1].maxZMm) {
          add('overlapping-layer-range', rangePath, 'Layer ranges on an object may not overlap');
        }
        validateConfig(range.config, `${rangePath}.config`, add);
        validateFilamentRef(range.filamentId, filamentIds, `${rangePath}.filamentId`, add);
      });
    });
  });

  if (!plateIds.has(state.activePlateId)) {
    add('dangling-active-plate', 'activePlateId', 'Active plate does not exist');
  }
  if (new Set(state.plates.map((plate) => plate.order)).size !== state.plates.length) {
    add('duplicate-plate-order', 'plates', 'Plate order values must be unique');
  }

  const eventHeightsByPlate = new Map<string, Set<string>>();
  state.customGcode.forEach((entry, index) => {
    const path = `customGcode[${index}]`;
    id(entry.id, `${path}.id`);
    if (entry.scope === 'plate' && (!entry.plateId || !plateIds.has(entry.plateId))) {
      add('dangling-gcode-plate', `${path}.plateId`, 'Plate-scoped G-code needs an existing plate');
    }
    if (entry.scope === 'project' && entry.plateId) {
      add('incompatible-gcode-scope', `${path}.plateId`, 'Project-scoped G-code cannot name a plate');
    }
    const event = entry.layerEvent;
    if (!event) return;
    // Layer events are a per-plate concept in the engine's own format; a
    // project-scoped one would have no plate to attach to on export.
    if (entry.scope !== 'plate' || !entry.plateId) {
      add('layer-event-scope', `${path}.scope`, 'A layer event must be scoped to one plate');
    }
    if (!Number.isFinite(event.topZMm) || event.topZMm <= 0 || event.topZMm > MAX_LAYER_EVENT_Z_MM) {
      add('layer-event-height', `${path}.layerEvent.topZMm`, 'Layer-event height must be above the plate and finite');
    }
    if (event.type === 'custom' && entry.code.trim().length === 0) {
      add('layer-event-empty-code', `${path}.code`, 'A custom layer event needs G-code to emit');
    }
    if (event.type !== 'custom' && entry.code.length > 0) {
      add(
        'layer-event-unexpected-code',
        `${path}.code`,
        'Only a custom layer event carries its own G-code; the others come from the printer profile',
      );
    }
    if (
      (event.type === 'color-change' || event.type === 'tool-change') &&
      (!Number.isInteger(event.toolIndex) || (event.toolIndex ?? 0) < 1)
    ) {
      add('layer-event-tool', `${path}.layerEvent.toolIndex`, 'Colour and tool changes address a 1-based tool');
    }
    if (entry.plateId) {
      const heights = eventHeightsByPlate.get(entry.plateId) ?? new Set<string>();
      const key = event.topZMm.toFixed(4);
      if (heights.has(key)) {
        add('duplicate-layer-event', `${path}.layerEvent.topZMm`, 'One layer event per height on a plate');
      }
      heights.add(key);
      eventHeightsByPlate.set(entry.plateId, heights);
    }
  });
  state.thumbnails.forEach((thumbnail, index) => {
    const path = `thumbnails[${index}]`;
    id(thumbnail.id, `${path}.id`);
    if (!assetIds.has(thumbnail.assetId)) add('dangling-asset', `${path}.assetId`, 'Unknown thumbnail asset');
    if (thumbnail.plateId && !plateIds.has(thumbnail.plateId)) {
      add('dangling-thumbnail-plate', `${path}.plateId`, 'Unknown thumbnail plate');
    }
    if (
      !Number.isInteger(thumbnail.width) ||
      thumbnail.width < 1 ||
      !Number.isInteger(thumbnail.height) ||
      thumbnail.height < 1
    ) {
      add('invalid-thumbnail-size', path, 'Thumbnail dimensions must be positive integers');
    }
  });
  state.extensionBlobs.forEach((blob, index) => {
    const path = `extensionBlobs[${index}]`;
    id(blob.id, `${path}.id`);
    if (!assetIds.has(blob.assetId)) add('dangling-asset', `${path}.assetId`, 'Unknown extension asset');
    if (!blob.namespace.trim()) add('missing-extension-namespace', `${path}.namespace`, 'Namespace is required');
    if (blob.path.startsWith('/') || blob.path.split('/').includes('..')) {
      add('unsafe-extension-path', `${path}.path`, 'Extension paths must be relative and cannot traverse');
    }
  });

  return issues;
}

type AddIssue = (code: string, path: string, message: string, severity?: ValidationSeverity) => void;

function validateTransform(transform: Transform, path: string, add: AddIssue): void {
  validateFiniteArray(transform.translationMm, `${path}.translationMm`, add);
  validateFiniteArray(transform.rotation, `${path}.rotation`, add);
  validateFiniteArray(transform.scale, `${path}.scale`, add);
  if (transform.scale.some((component) => Math.abs(component) < 1e-12)) {
    add('non-invertible-transform', `${path}.scale`, 'Transform scale cannot contain zero');
  }
  const normSquared = transform.rotation.reduce((sum, component) => sum + component * component, 0);
  if (!Number.isFinite(normSquared) || normSquared < 1e-12) {
    add('non-invertible-transform', `${path}.rotation`, 'Rotation quaternion cannot be zero');
  }
}

function validateFiniteArray(values: readonly number[], path: string, add: AddIssue): void {
  if (values.some((value) => !Number.isFinite(value))) add('non-finite-number', path, 'All values must be finite');
}

function validateConfig(config: ConfigMap, path: string, add: AddIssue): void {
  for (const [key, value] of Object.entries(config)) {
    if (!key.trim()) add('empty-config-key', path, 'Configuration keys cannot be empty');
    validateJson(value, `${path}.${key}`, add);
  }
}

function validateExtensionData(data: Record<string, JsonValue> | undefined, path: string, add: AddIssue): void {
  if (!data) return;
  for (const [key, value] of Object.entries(data)) validateJson(value, `${path}.${key}`, add);
}

function validateJson(value: JsonValue, path: string, add: AddIssue): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) add('non-finite-number', path, 'JSON numbers must be finite');
    return;
  }
  if (Array.isArray(value)) {
    // The child path is built only when a child can actually report something.
    // Building one per element allocated a string for every number in every
    // config array on every canonical commit, which is pure waste in the
    // overwhelmingly common case where nothing is wrong.
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (child !== null && typeof child === 'object') {
        validateJson(child, `${path}[${index}]`, add);
      } else if (typeof child === 'number' && !Number.isFinite(child)) {
        add('non-finite-number', `${path}[${index}]`, 'JSON numbers must be finite');
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) validateJson(child, `${path}.${key}`, add);
  }
}

function validateFilamentRef(
  value: FilamentId | undefined,
  filamentIds: Set<string>,
  path: string,
  add: AddIssue,
): void {
  if (value && !filamentIds.has(value)) add('dangling-filament', path, 'Unknown filament reference');
}

function validateMeshDescriptor(asset: SourceAssetDescriptor, path: string, add: AddIssue): void {
  if (asset.kind === 'mesh' && !asset.mesh) add('missing-mesh-layout', `${path}.mesh`, 'Mesh asset needs a layout');
  if (asset.kind !== 'mesh' && asset.mesh) {
    add('unexpected-mesh-layout', `${path}.mesh`, 'Only mesh assets can have a layout');
  }
  if (!asset.mesh) return;
  if (!Number.isInteger(asset.mesh.triangleCount) || asset.mesh.triangleCount < 0) {
    add('invalid-triangle-count', `${path}.mesh.triangleCount`, 'Triangle count must be non-negative');
  }
  for (const [name, view] of Object.entries({ positions: asset.mesh.positions, indices: asset.mesh.indices })) {
    if (!view) continue;
    if (view.byteOffset < 0 || view.byteLength < 0 || view.byteOffset + view.byteLength > asset.byteLength) {
      add('buffer-view-out-of-range', `${path}.mesh.${name}`, 'Buffer view exceeds asset bounds');
    }
    if (!Number.isInteger(view.count) || view.count < 0) {
      add('invalid-buffer-count', `${path}.mesh.${name}.count`, 'Buffer count must be non-negative');
    }
  }
}

function validateMixedShape(filament: MixedFilament, path: string, add: AddIssue): void {
  if (filament.components.length < 2) {
    add('mixed-component-count', `${path}.components`, 'Mixed filament needs at least two components');
  }
  filament.components.forEach((component, index) => {
    if (!Number.isFinite(component.weight) || component.weight < 0) {
      add('invalid-mixed-weight', `${path}.components[${index}].weight`, 'Weight must be non-negative');
    }
  });
  if (filament.components.length > 0 && filament.components.every((component) => component.weight === 0)) {
    add('invalid-mixed-weight-total', `${path}.components`, 'At least one mixed-filament weight must be positive');
  }
  const distribution = filament.distribution;
  if (
    distribution.mode === 'cycle' &&
    distribution.cycleLengthMm !== undefined &&
    (!Number.isFinite(distribution.cycleLengthMm) || distribution.cycleLengthMm <= 0)
  ) {
    add('invalid-cycle-length', `${path}.distribution.cycleLengthMm`, 'Cycle length must be greater than zero');
  }
  if (distribution.mode === 'gradient') {
    if (
      (distribution.startZMm === undefined) !== (distribution.endZMm === undefined) ||
      (distribution.startZMm !== undefined &&
        distribution.endZMm !== undefined &&
        (distribution.startZMm < 0 || distribution.endZMm <= distribution.startZMm))
    ) {
      add('invalid-gradient-range', `${path}.distribution`, 'Gradient range must increase above zero');
    }
    if (
      distribution.startWeights.length !== filament.components.length ||
      distribution.endWeights.length !== filament.components.length
    ) {
      add('invalid-gradient-weights', `${path}.distribution`, 'Gradient weights must match component count');
    }
    if (
      [...distribution.startWeights, ...distribution.endWeights].some(
        (weight) => !Number.isFinite(weight) || weight < 0,
      )
    ) {
      add('invalid-gradient-weights', `${path}.distribution`, 'Gradient weights must be finite and non-negative');
    }
  }
  validateFullSpectrumRecipe(filament, path, add);
}

function validateFullSpectrumRecipe(filament: MixedFilament, path: string, add: AddIssue): void {
  const recipe = filament.fullSpectrum;
  if (!recipe) return;
  const recipePath = `${path}.fullSpectrum`;
  if (recipe.schemaVersion !== 1)
    add('invalid-fullspectrum-schema', `${recipePath}.schemaVersion`, 'Expected schema 1');
  if (![-1, 0, 1, 2, 3].includes(recipe.uiMode)) {
    add('invalid-fullspectrum-ui-mode', `${recipePath}.uiMode`, 'UI mode must be -1 or one of the four pinned modes');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(recipe.upstreamStableId)) {
    add('invalid-fullspectrum-stable-id', `${recipePath}.upstreamStableId`, 'Expected unsigned decimal text');
  } else {
    try {
      if (BigInt(recipe.upstreamStableId) > 0xffff_ffff_ffff_ffffn) {
        add('invalid-fullspectrum-stable-id', `${recipePath}.upstreamStableId`, 'Stable ID exceeds uint64');
      }
    } catch {
      add('invalid-fullspectrum-stable-id', `${recipePath}.upstreamStableId`, 'Expected unsigned decimal text');
    }
  }
  const physicalComponents = new Set(filament.components.map((component) => component.filamentId));
  const checkPhysical = (id: PhysicalFilamentId, fieldPath: string) => {
    if (!physicalComponents.has(id)) {
      add('missing-fullspectrum-component', fieldPath, 'Engine field must reference a canonical recipe component');
    }
  };
  checkPhysical(recipe.componentAId, `${recipePath}.componentAId`);
  checkPhysical(recipe.componentBId, `${recipePath}.componentBId`);
  if (recipe.componentAId === recipe.componentBId) {
    add('duplicate-fullspectrum-pair', recipePath, 'Component A and B must be different physical filaments');
  }
  recipe.manualPatternGroups.forEach((group, groupIndex) => {
    if (group.length === 0)
      add(
        'empty-fullspectrum-pattern-group',
        `${recipePath}.manualPatternGroups[${groupIndex}]`,
        'Pattern groups cannot be empty',
      );
    group.forEach((id, index) => checkPhysical(id, `${recipePath}.manualPatternGroups[${groupIndex}][${index}]`));
  });
  recipe.gradientComponentIds.forEach((id, index) => checkPhysical(id, `${recipePath}.gradientComponentIds[${index}]`));
  if (
    recipe.gradientComponentWeights.length > 0 &&
    recipe.gradientComponentWeights.length !== recipe.gradientComponentIds.length
  ) {
    add(
      'invalid-fullspectrum-gradient-weights',
      `${recipePath}.gradientComponentWeights`,
      'Gradient component weights must align with component IDs',
    );
  }
  if (
    recipe.gradientComponentWeights.some((weight) => !Number.isSafeInteger(weight) || weight < 0) ||
    (recipe.gradientComponentWeights.length > 0 && recipe.gradientComponentWeights.every((weight) => weight === 0))
  ) {
    add(
      'invalid-fullspectrum-gradient-weights',
      `${recipePath}.gradientComponentWeights`,
      'Gradient component weights must be non-negative integers with a positive total',
    );
  }
  for (const [field, value] of [
    ['ratioA', recipe.ratioA],
    ['ratioB', recipe.ratioB],
    ['mixBPercent', recipe.mixBPercent],
    ['localZMaxSublayers', recipe.localZMaxSublayers],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      add('invalid-fullspectrum-integer', `${recipePath}.${field}`, 'Expected a non-negative safe integer');
    }
  }
  if (recipe.mixBPercent > 100) {
    add('invalid-fullspectrum-percent', `${recipePath}.mixBPercent`, 'Mix percentage cannot exceed 100');
  }
  for (const [field, value] of [
    ['gradientStart', recipe.gradientStart],
    ['gradientEnd', recipe.gradientEnd],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      add('invalid-fullspectrum-gradient', `${recipePath}.${field}`, 'Gradient endpoints must be inside (0, 1)');
    }
  }
  if (recipe.gradientEnabled && Math.abs(recipe.gradientStart - recipe.gradientEnd) < 0.05) {
    add('invalid-fullspectrum-gradient', recipePath, 'Enabled gradient endpoints must differ by at least 0.05');
  }
  for (const [field, value] of [
    ['componentASurfaceOffsetMm', recipe.componentASurfaceOffsetMm],
    ['componentBSurfaceOffsetMm', recipe.componentBSurfaceOffsetMm],
  ] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > 2) {
      add(
        'invalid-fullspectrum-offset',
        `${recipePath}.${field}`,
        'Offset must be within the pinned -2 mm to 2 mm range',
      );
    }
  }
  if (recipe.pointillismAllFilaments !== false || (recipe.distributionMode !== 0 && recipe.distributionMode !== 2)) {
    add('unsupported-fullspectrum-distribution', recipePath, 'The pinned build supports LayerCycle or Simple only');
  }
}

function validateMixedReferencesAndCycles(
  mixed: MixedFilament[],
  physicalIds: Set<string>,
  mixedIds: Set<string>,
  add: AddIssue,
): void {
  const byId = new Map(mixed.map((entry) => [entry.id as string, entry]));
  mixed.forEach((entry, index) => {
    entry.components.forEach((component, componentIndex) => {
      if (!physicalIds.has(component.filamentId) && !mixedIds.has(component.filamentId)) {
        add(
          'dangling-mixed-component',
          `filaments.mixed[${index}].components[${componentIndex}].filamentId`,
          'Unknown mixed-filament component',
        );
      } else if (mixedIds.has(component.filamentId)) {
        add(
          'nested-mixed-component',
          `filaments.mixed[${index}].components[${componentIndex}].filamentId`,
          'Snapmaker v2.3.4 mixed-filament components must reference physical filaments',
        );
      }
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, path: string[]) => {
    if (visiting.has(id)) {
      add('cyclic-mixed-filament', 'filaments.mixed', `Mixed filament cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const entry = byId.get(id);
    entry?.components.forEach((component) => {
      if (mixedIds.has(component.filamentId)) walk(component.filamentId, [...path, id]);
    });
    visiting.delete(id);
    visited.add(id);
  };
  mixed.forEach((entry) => walk(entry.id, []));
}

function validateAnnotations(
  annotations: FacetAnnotations,
  topologyRevision: number,
  triangleCount: number,
  path: string,
  filamentIds: Set<string>,
  add: AddIssue,
): void {
  if (annotations.topologyRevision !== topologyRevision) {
    add(
      'stale-annotation-topology',
      `${path}.annotations.topologyRevision`,
      'Facet annotations target a different topology revision',
    );
  }
  const channels: Array<[string, TriangleAssignments<JsonValue>[]]> = [
    ['color', annotations.color],
    ['support', annotations.support],
    ['seam', annotations.seam],
    ['fuzzySkin', annotations.fuzzySkin],
    ['brim', annotations.brim],
  ];
  for (const [name, assignments] of channels) {
    const seen = new Set<number>();
    assignments.forEach((assignment, assignmentIndex) => {
      if (name === 'color' && !filamentIds.has(assignment.value as string)) {
        add('dangling-filament', `${path}.annotations.color[${assignmentIndex}].value`, 'Unknown paint filament');
      }
      const validValue =
        (name === 'color' && typeof assignment.value === 'string') ||
        (name === 'support' && (assignment.value === 'enforce' || assignment.value === 'block')) ||
        (name === 'seam' && (assignment.value === 'prefer' || assignment.value === 'avoid')) ||
        (name === 'fuzzySkin' && assignment.value === true) ||
        (name === 'brim' && typeof assignment.value === 'boolean');
      if (!validValue) {
        add(
          'invalid-facet-value',
          `${path}.annotations.${name}[${assignmentIndex}].value`,
          `Invalid ${name} annotation value`,
        );
      }
      assignment.triangles.forEach((triangle, triangleIndex) => {
        const trianglePath = `${path}.annotations.${name}[${assignmentIndex}].triangles[${triangleIndex}]`;
        if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) {
          add('facet-index-out-of-range', trianglePath, `Triangle must be in [0, ${triangleCount - 1}]`);
        }
        if (seen.has(triangle)) {
          add('duplicate-facet-assignment', trianglePath, `Triangle ${triangle} is assigned twice`);
        }
        seen.add(triangle);
      });
    });
  }
  const refinement = annotations.refinement as unknown;
  if (refinement !== undefined) {
    if (refinement === null || typeof refinement !== 'object' || Array.isArray(refinement)) {
      add(
        'invalid-facet-refinements',
        `${path}.annotations.refinement`,
        'Facet refinements must be a per-channel object',
      );
      return;
    }
    const refinementKeys = Object.keys(refinement);
    const knownChannels = new Set(channels.map(([name]) => name));
    if (refinementKeys.length === 0) {
      add('empty-facet-refinements', `${path}.annotations.refinement`, 'Empty facet refinements must be omitted');
    }
    refinementKeys
      .filter((name) => !knownChannels.has(name))
      .forEach((name) =>
        add(
          'unknown-facet-refinement-channel',
          `${path}.annotations.refinement.${name}`,
          `Unknown facet refinement channel ${name}`,
        ),
      );
    for (const [name, assignments] of channels) {
      const candidate = (refinement as Record<string, unknown>)[name];
      if (candidate === undefined) continue;
      for (const issue of validateFacetRefinementChannel(name as FacetRefinementChannel, candidate, assignments, {
        triangleCount,
        filamentIds,
        path: `${path}.annotations.refinement.${name}`,
      })) {
        add(issue.code, issue.path, issue.message);
      }
    }
  }
}
