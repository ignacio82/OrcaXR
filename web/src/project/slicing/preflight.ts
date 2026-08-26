import { InMemoryAssetRepository, type AssetRepository } from '../assets';
import { cloneJson, compareCanonicalText, deepFreeze } from '../domain/canonical';
import { visitFacetRefinementAssignedValues } from '../domain/facetRefinement';
import type {
  CustomGcodeId,
  FilamentId,
  InstanceId,
  MixedFilamentId,
  PhysicalFilamentId,
  PlateId,
} from '../domain/ids';
import type { ConfigMap, MixedFilament, PhysicalFilament, ProjectPlate, ProjectState } from '../domain/model';
import { findPlate, resolveConfig, resolveFilament } from '../domain/selectors';
import { validateProjectState } from '../domain/validation';
import { inspectFullSpectrumCompatibility } from '../filaments/fullSpectrumCompatibility';
import { computeCanonicalInstanceBounds, type CanonicalBounds3 } from '../objects/bounds';
import { wipeTowerFootprintMarginMm } from '../objects/wipeTowerPlacement';
import type { SelectionRef } from '../selection';
import type { CanonicalProjectSliceSnapshot } from './types';

export const PINNED_SLICE_PREFLIGHT_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  modelValidation: 'src/libslic3r/Model.cpp',
  gcodeValidation: 'src/libslic3r/GCode/GCodeProcessor.hpp',
  engineLimits: 'src/libslic3r/libslic3r.h',
  mixedFilament: 'src/libslic3r/MixedFilament.cpp',
  mixedFilamentModel: 'src/libslic3r/MixedFilament.hpp',
  gradientApplication: 'src/libslic3r/PrintObjectSlice.cpp',
  wipeTowerValidation: 'src/libslic3r/Print.cpp',
});

/** Pinned `MAXIMUM_FILAMENT_NUMBER` (`libslic3r.h`). */
export const PINNED_MAXIMUM_FILAMENT_NUMBER = 64;

/** Pinned clamp applied by `MixedFilamentManager` whenever a gradient row is enabled. */
const GRADIENT_MIN_RATIO = 0.01;
const GRADIENT_MAX_RATIO = 0.99;

/** Pinned `Print::validate()` filament-diameter tolerance for the prime tower. */
const WIPE_TOWER_FILAMENT_DIAMETER_TOLERANCE = 0.1;

/** Pinned `Print::validate()` nozzle-diameter comparison epsilon. */
const WIPE_TOWER_NOZZLE_EPSILON = 1e-4;

export type SlicePreflightSeverity = 'warning' | 'error';

export type SlicePreflightCode =
  | 'invalid-project-state'
  | 'unknown-plate'
  | 'plate-not-printable'
  | 'no-printable-instance'
  | 'empty-model-mesh'
  | 'unreadable-model-mesh'
  | 'instance-outside-build-volume'
  | 'instance-below-build-plate'
  | 'instance-aabb-overlap'
  | 'disabled-filament-assignment'
  | 'deleted-mixed-filament-assignment'
  | 'disabled-mixed-component'
  | 'incompatible-mixed-components'
  | 'mixed-filament-unsupported-printer'
  | 'filament-tool-out-of-range'
  | 'filament-count-exceeds-engine-limit'
  | 'gradient-recipe-out-of-bounds'
  | 'filament-nozzle-mismatch'
  | 'unsupported-filament-material'
  | 'invalid-filament-temperature'
  | 'filament-temperature-out-of-range'
  | 'missing-profile-attestation'
  | 'wipe-tower-outside-build-volume'
  | 'wipe-tower-requires-physical-filament'
  | 'wipe-tower-requires-relative-e'
  | 'wipe-tower-ooze-prevention-conflict'
  | 'wipe-tower-mixed-extruder-diameters'
  | 'unsafe-custom-gcode';

export type SlicePreflightActionId =
  | 'reveal'
  | 'drop-to-bed'
  | 'move-inside-build-volume'
  | 'choose-filament'
  | 'choose-profile'
  | 'edit-custom-gcode'
  | 'disable-wipe-tower';

export interface SlicePreflightAction {
  readonly id: SlicePreflightActionId;
  readonly label: string;
  readonly entity?: SelectionRef;
  readonly settingKey?: string;
}

export interface SlicePreflightIssue {
  /** Stable across repeated evaluation of the same canonical fault. */
  readonly id: string;
  readonly code: SlicePreflightCode;
  readonly detailCode?: string;
  readonly severity: SlicePreflightSeverity;
  readonly message: string;
  readonly help: string;
  readonly path?: string;
  readonly entities: readonly SelectionRef[];
  readonly actions: readonly SlicePreflightAction[];
}

export interface RectangularBuildVolume {
  readonly minXmm: number;
  readonly maxXmm: number;
  readonly minYmm: number;
  readonly maxYmm: number;
  readonly minZmm?: number;
  readonly maxZmm: number;
}

export interface ToolFilamentConstraints {
  readonly nozzleDiameterMm?: number;
  readonly supportedMaterials?: readonly string[];
  readonly minHotendTemperatureC?: number;
  readonly maxHotendTemperatureC?: number;
}

/**
 * Capability facts the resolved printer target declares exactly. They are only
 * evaluated when a caller supplies them: FullSpectrum support is never inferred
 * from the fact that the authoring UI let a virtual filament be created.
 */
export interface PrinterCapabilityConstraints {
  /** Exact number of physical tool slots the resolved printer declares. */
  readonly physicalToolCount: number;
  /**
   * Ceiling on physical plus enabled virtual filaments. Defaults to the pinned
   * `MAXIMUM_FILAMENT_NUMBER`; a printer may declare a smaller exact limit.
   */
  readonly maxTotalFilaments?: number;
}

export interface SlicePreflightConstraints {
  readonly buildVolume?: RectangularBuildVolume;
  /** Indexed by the canonical zero-based physical tool ID. */
  readonly tools?: readonly (ToolFilamentConstraints | undefined)[];
  /** Exact printer capability declaration; absent means "not evaluated". */
  readonly printer?: PrinterCapabilityConstraints;
  readonly requireProfileAttestation?: boolean;
  readonly customGcodeByteLimit?: number;
  readonly geometryToleranceMm?: number;
}

export interface CanonicalSlicePreflightRequest {
  readonly state: ProjectState;
  readonly assets: AssetRepository;
  readonly plateId: PlateId;
  readonly constraints?: SlicePreflightConstraints;
}

export interface CanonicalSlicePreflightPort {
  evaluate(
    snapshot: CanonicalProjectSliceSnapshot,
    plateId: PlateId,
  ): CanonicalSlicePreflightResult | Promise<CanonicalSlicePreflightResult>;
}

export interface CanonicalSlicePreflightResult {
  readonly plateId: PlateId;
  readonly canSlice: boolean;
  readonly blockingCount: number;
  readonly issues: readonly SlicePreflightIssue[];
  readonly printableInstanceIds: readonly InstanceId[];
  readonly usedFilamentIds: readonly FilamentId[];
}

interface PrintableInstanceBounds {
  readonly instanceId: InstanceId;
  readonly bounds: CanonicalBounds3;
}

interface MutableIssue extends Omit<SlicePreflightIssue, 'id' | 'entities' | 'actions'> {
  entities?: readonly SelectionRef[];
  actions?: readonly SlicePreflightAction[];
}

const PREFLIGHT_HELP =
  'Resolve this issue before slicing or sending; the canonical project remains unchanged until an explicit fix runs.';
const DEFAULT_CUSTOM_GCODE_LIMIT = 256 * 1024;
const DEFAULT_GEOMETRY_TOLERANCE_MM = 1e-5;

/** Default coordinator adapter over one immutable canonical slice snapshot. */
export class CanonicalSlicePreflightValidator implements CanonicalSlicePreflightPort {
  private readonly constraints?: SlicePreflightConstraints;

  constructor(constraints?: SlicePreflightConstraints) {
    assertPreflightConstraints(constraints);
    this.constraints = constraints ? deepFreeze(cloneJson(constraints)) : undefined;
  }

  evaluate(snapshot: CanonicalProjectSliceSnapshot, plateId: PlateId): CanonicalSlicePreflightResult {
    const assets = new InMemoryAssetRepository();
    for (const asset of snapshot.assets) {
      assets.put(asset.descriptor, asset.bytes);
    }
    return runCanonicalSlicePreflight({
      state: snapshot.state,
      assets,
      plateId,
      ...(this.constraints ? { constraints: this.constraints } : {}),
    });
  }
}

/**
 * Deterministic, read-only preflight over canonical graph state and immutable
 * mesh bytes. It never consults Three.js projections and never mutates or
 * silently substitutes project intent.
 */
export function runCanonicalSlicePreflight(request: CanonicalSlicePreflightRequest): CanonicalSlicePreflightResult {
  assertPreflightConstraints(request.constraints);
  const issues: SlicePreflightIssue[] = [];
  const stateIssues = validateProjectState(request.state);
  for (const issue of stateIssues) {
    addIssue(issues, {
      code: 'invalid-project-state',
      detailCode: issue.code,
      severity: issue.severity,
      message: issue.message,
      help: PREFLIGHT_HELP,
      path: issue.path,
      entities: [],
      actions: [{ id: 'reveal', label: 'Reveal invalid project data' }],
    });
  }
  if (stateIssues.some((issue) => issue.severity === 'error')) {
    return finish(request.plateId, issues, [], []);
  }

  const plate = findPlate(request.state, request.plateId);
  if (!plate) {
    addIssue(issues, {
      code: 'unknown-plate',
      severity: 'error',
      message: `Plate ${request.plateId} does not exist.`,
      help: PREFLIGHT_HELP,
      entities: [],
      actions: [{ id: 'reveal', label: 'Show available plates' }],
    });
    return finish(request.plateId, issues, [], []);
  }
  const plateEntity: SelectionRef = { kind: 'plate', id: plate.id };
  if (!plate.printable) {
    addIssue(issues, {
      code: 'plate-not-printable',
      severity: 'error',
      message: `${plate.name} is excluded from printing.`,
      help: PREFLIGHT_HELP,
      entities: [plateEntity],
      actions: [{ id: 'reveal', label: 'Reveal plate', entity: plateEntity }],
    });
  }

  const printable = plate.objects.flatMap((object) =>
    object.instances.filter((instance) => instance.printable).map((instance) => ({ object, instance })),
  );
  if (plate.objects.length > 0 && printable.length === 0) {
    addIssue(issues, {
      code: 'no-printable-instance',
      severity: 'error',
      message: `${plate.name} contains no printable model instance.`,
      help: PREFLIGHT_HELP,
      entities: [plateEntity],
      actions: [{ id: 'reveal', label: 'Reveal plate', entity: plateEntity }],
    });
  }

  const bounded: PrintableInstanceBounds[] = [];
  for (const { object, instance } of printable) {
    const instanceEntity: SelectionRef = { kind: 'instance', id: instance.id };
    const modelVolumes = object.volumes.filter((volume) => volume.role === 'model');
    if (modelVolumes.some((volume) => volume.source.triangleCount === 0)) {
      const emptyVolumes = modelVolumes
        .filter((volume) => volume.source.triangleCount === 0)
        .map((volume) => ({ kind: 'volume', id: volume.id }) satisfies SelectionRef);
      addIssue(issues, {
        code: 'empty-model-mesh',
        severity: 'error',
        message: `${object.name} contains an empty model mesh.`,
        help: PREFLIGHT_HELP,
        entities: emptyVolumes,
        actions: emptyVolumes.map((entity) => ({
          id: 'reveal' as const,
          label: 'Reveal empty volume',
          entity,
        })),
      });
      continue;
    }
    try {
      const bounds = computeCanonicalInstanceBounds(request.state, request.assets, [instance.id], {
        volumeRoles: ['model'],
      });
      bounded.push({ instanceId: instance.id, bounds });
      checkBuildVolume(
        issues,
        bounds,
        instanceEntity,
        request.constraints?.buildVolume,
        request.constraints?.geometryToleranceMm ?? DEFAULT_GEOMETRY_TOLERANCE_MM,
      );
    } catch (error) {
      addIssue(issues, {
        code: 'unreadable-model-mesh',
        severity: 'error',
        message: `${object.name} cannot be decoded from its canonical mesh asset: ${boundedMessage(error)}`,
        help: PREFLIGHT_HELP,
        entities: [instanceEntity],
        actions: [{ id: 'reveal', label: 'Reveal model', entity: instanceEntity }],
      });
    }
  }

  checkPotentialOverlaps(issues, bounded, request.constraints?.geometryToleranceMm ?? DEFAULT_GEOMETRY_TOLERANCE_MM);
  const usedFilaments = collectUsedFilaments(plate);
  checkEngineFilamentCapacity(issues, request.state, request.constraints?.printer);
  const usedPhysicalComponents = checkFilaments(issues, request.state, usedFilaments, request.constraints);
  checkWipeTower(issues, request.state, plate, request.constraints, usedPhysicalComponents);
  checkCustomGcode(
    issues,
    request.state,
    plate,
    request.constraints?.customGcodeByteLimit ?? DEFAULT_CUSTOM_GCODE_LIMIT,
  );

  return finish(
    plate.id,
    issues,
    printable.map(({ instance }) => instance.id),
    [...new Set<FilamentId>([...usedFilaments, ...usedPhysicalComponents])],
  );
}

function checkBuildVolume(
  issues: SlicePreflightIssue[],
  bounds: CanonicalBounds3,
  entity: SelectionRef,
  volume: RectangularBuildVolume | undefined,
  tolerance: number,
): void {
  if (!volume) return;
  assertBuildVolume(volume);
  assertTolerance(tolerance);
  const minZ = volume.minZmm ?? 0;
  if (
    bounds.min[0] < volume.minXmm - tolerance ||
    bounds.max[0] > volume.maxXmm + tolerance ||
    bounds.min[1] < volume.minYmm - tolerance ||
    bounds.max[1] > volume.maxYmm + tolerance ||
    bounds.max[2] > volume.maxZmm + tolerance
  ) {
    addIssue(issues, {
      code: 'instance-outside-build-volume',
      severity: 'error',
      message:
        `Model bounds ${formatBounds(bounds)} exceed the configured build volume ` + `${formatBuildVolume(volume)}.`,
      help: PREFLIGHT_HELP,
      entities: [entity],
      actions: [
        { id: 'reveal', label: 'Reveal model', entity },
        { id: 'move-inside-build-volume', label: 'Move inside build volume', entity },
      ],
    });
  }
  if (bounds.min[2] < minZ - tolerance) {
    addIssue(issues, {
      code: 'instance-below-build-plate',
      severity: 'warning',
      message: `Model extends ${(minZ - bounds.min[2]).toFixed(3)} mm below the build plate.`,
      help: 'The pinned slicer may clip sinking geometry. Review the placement or explicitly drop the complete model to the bed.',
      entities: [entity],
      actions: [
        { id: 'reveal', label: 'Reveal sinking model', entity },
        { id: 'drop-to-bed', label: 'Drop model to bed', entity },
      ],
    });
  }
}

function checkPotentialOverlaps(
  issues: SlicePreflightIssue[],
  bounded: readonly PrintableInstanceBounds[],
  tolerance: number,
): void {
  assertTolerance(tolerance);
  for (let leftIndex = 0; leftIndex < bounded.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < bounded.length; rightIndex += 1) {
      const left = bounded[leftIndex];
      const right = bounded[rightIndex];
      if (!aabbPotentiallyOverlaps(left.bounds, right.bounds, tolerance)) continue;
      const leftEntity: SelectionRef = { kind: 'instance', id: left.instanceId };
      const rightEntity: SelectionRef = { kind: 'instance', id: right.instanceId };
      addIssue(issues, {
        code: 'instance-aabb-overlap',
        severity: 'warning',
        message:
          'Printable model bounds overlap. Exact mesh collision and sequential toolhead clearance still require engine validation.',
        help: PREFLIGHT_HELP,
        entities: [leftEntity, rightEntity],
        actions: [
          { id: 'reveal', label: 'Reveal first model', entity: leftEntity },
          { id: 'reveal', label: 'Reveal second model', entity: rightEntity },
        ],
      });
    }
  }
}

function collectUsedFilaments(plate: ProjectPlate): Set<FilamentId> {
  const used = new Set<FilamentId>();
  for (const object of plate.objects) {
    if (!object.instances.some((instance) => instance.printable)) continue;
    if (object.filamentId) used.add(object.filamentId);
    for (const volume of object.volumes) {
      if (volume.role !== 'model') continue;
      const resolved = resolveFilament(object, volume).effective;
      if (resolved) used.add(resolved);
      for (const assignment of volume.annotations.color) used.add(assignment.value);
      if (volume.annotations.refinement?.color) {
        visitFacetRefinementAssignedValues(volume.annotations.refinement.color, (value) => used.add(value));
      }
    }
    for (const range of object.layerRanges) {
      const resolved = resolveFilament(object, range).effective;
      if (resolved) used.add(resolved);
    }
  }
  if (plate.wipeTower?.enabled && plate.wipeTower.filamentId) {
    used.add(plate.wipeTower.filamentId);
  }
  return used;
}

function checkFilaments(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  usedIds: ReadonlySet<FilamentId>,
  constraints: SlicePreflightConstraints | undefined,
): ReadonlySet<PhysicalFilamentId> {
  const physicalById = new Map(state.filaments.physical.map((filament) => [filament.id, filament]));
  const mixedById = new Map(state.filaments.mixed.map((filament) => [filament.id, filament]));
  const usedPhysical = new Set<PhysicalFilamentId>();

  for (const filamentId of usedIds) {
    const entity: SelectionRef = { kind: 'filament', id: filamentId };
    const physical = physicalById.get(filamentId as PhysicalFilamentId);
    if (physical) {
      usedPhysical.add(physical.id);
      if (!physical.enabled) {
        addIssue(issues, disabledFilamentIssue(entity, physical.name));
      }
      continue;
    }
    const mixed = mixedById.get(filamentId as MixedFilamentId);
    if (!mixed) continue;
    if (!mixed.enabled) addIssue(issues, disabledFilamentIssue(entity, mixed.name));
    if (mixed.fullSpectrum?.deleted) {
      addIssue(issues, {
        code: 'deleted-mixed-filament-assignment',
        severity: 'error',
        message: `Assigned virtual filament ${mixed.name} is a deleted tombstone.`,
        help: PREFLIGHT_HELP,
        entities: [entity],
        actions: [
          { id: 'reveal', label: 'Reveal virtual filament', entity },
          { id: 'choose-filament', label: 'Choose a replacement filament', entity },
        ],
      });
    }
    checkMixedPrinterCapability(issues, mixed, entity, constraints?.printer);
    for (const component of mixed.components) {
      usedPhysical.add(component.filamentId);
      const componentFilament = physicalById.get(component.filamentId);
      // A component that is absent from the library is already a canonical
      // `dangling-mixed-component` error, so only availability is left here.
      if (!componentFilament?.enabled) {
        const componentEntity: SelectionRef = {
          kind: 'filament',
          id: component.filamentId,
        };
        addIssue(issues, {
          code: 'disabled-mixed-component',
          severity: 'error',
          message: `${mixed.name} uses unavailable physical component ${componentFilament?.name ?? component.filamentId}.`,
          help: PREFLIGHT_HELP,
          entities: [entity, componentEntity],
          actions: [
            { id: 'reveal', label: 'Reveal virtual filament', entity },
            { id: 'choose-filament', label: 'Replace unavailable component', entity: componentEntity },
          ],
        });
      }
    }
    checkMixedMaterialCompatibility(issues, state, mixed, entity, physicalById);
    checkGradientRecipe(issues, mixed, entity, physicalById, constraints?.printer);
  }

  if (constraints?.requireProfileAttestation) {
    if (!state.printer.profileId?.trim() || !state.printer.profileHash?.trim()) {
      addIssue(issues, {
        code: 'missing-profile-attestation',
        detailCode: 'printer',
        severity: 'error',
        message: 'The selected printer profile is missing an ID or content hash.',
        help: PREFLIGHT_HELP,
        entities: [],
        actions: [{ id: 'choose-profile', label: 'Choose an attested printer profile' }],
      });
    }
  }

  for (const physicalId of usedPhysical) {
    const filament = physicalById.get(physicalId);
    if (!filament) continue;
    const entity: SelectionRef = { kind: 'filament', id: filament.id };
    if (constraints?.requireProfileAttestation && (!filament.presetId?.trim() || !filament.presetHash?.trim())) {
      addIssue(issues, {
        code: 'missing-profile-attestation',
        detailCode: `filament-tool-${filament.toolId}`,
        severity: 'error',
        message: `${filament.name} is missing a preset ID or content hash.`,
        help: PREFLIGHT_HELP,
        entities: [entity],
        actions: [{ id: 'choose-profile', label: 'Choose an attested filament profile', entity }],
      });
    }
    checkPhysicalToolRange(issues, filament, entity, constraints?.printer);
    checkPhysicalFilament(issues, filament, entity, constraints?.tools?.[filament.toolId]);
  }
  return usedPhysical;
}

/**
 * `region_config_from_model_volume` clamps any per-object extruder above
 * `filament_diameter.size()` back to the first tool, which turns a correctly
 * assigned multicolor plate into a silent single-tool print. Refuse it instead.
 */
function checkPhysicalToolRange(
  issues: SlicePreflightIssue[],
  filament: PhysicalFilament,
  entity: SelectionRef,
  printer: PrinterCapabilityConstraints | undefined,
): void {
  if (!printer || filament.toolId < printer.physicalToolCount) return;
  addIssue(issues, {
    code: 'filament-tool-out-of-range',
    severity: 'error',
    message:
      `${filament.name} is assigned to physical tool ${filament.toolId + 1}, but the selected printer ` +
      `declares ${printer.physicalToolCount} tool${printer.physicalToolCount === 1 ? '' : 's'}. ` +
      'The engine would silently reassign it to the first tool.',
    help: PREFLIGHT_HELP,
    entities: [entity],
    actions: [
      { id: 'choose-filament', label: 'Reassign to a declared tool', entity },
      { id: 'choose-profile', label: 'Choose a printer with more tools' },
    ],
  });
}

/**
 * A FullSpectrum row resolves to two distinct physical heads. A target that
 * declares fewer than two physical tools cannot print one, and the engine would
 * collapse it to a single tool rather than report the mismatch.
 */
function checkMixedPrinterCapability(
  issues: SlicePreflightIssue[],
  mixed: MixedFilament,
  entity: SelectionRef,
  printer: PrinterCapabilityConstraints | undefined,
): void {
  if (!printer || printer.physicalToolCount >= 2) return;
  addIssue(issues, {
    code: 'mixed-filament-unsupported-printer',
    severity: 'error',
    message:
      `${mixed.name} is a mixed (FullSpectrum) filament, but the selected printer declares ` +
      `${printer.physicalToolCount} physical tool${printer.physicalToolCount === 1 ? '' : 's'}. ` +
      'Mixing needs at least two.',
    help: PREFLIGHT_HELP,
    entities: [entity],
    actions: [
      { id: 'choose-filament', label: 'Assign a physical filament instead', entity },
      { id: 'choose-profile', label: 'Choose a multi-tool printer' },
    ],
  });
}

/** Pinned `MixedColorMatchHelpers` category matrix; incompatible pairs never print. */
function checkMixedMaterialCompatibility(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  mixed: MixedFilament,
  entity: SelectionRef,
  physicalById: ReadonlyMap<PhysicalFilamentId, PhysicalFilament>,
): void {
  const componentIds = mixed.components
    .filter((component) => physicalById.has(component.filamentId))
    .map((component) => component.filamentId);
  if (componentIds.length < 2) return;
  const decision = inspectFullSpectrumCompatibility(state.filaments.physical, componentIds);
  if (decision.allowed) return;
  const entities: SelectionRef[] = [entity, { kind: 'filament', id: decision.firstId }];
  if (decision.secondId) entities.push({ kind: 'filament', id: decision.secondId });
  addIssue(issues, {
    code: 'incompatible-mixed-components',
    severity: 'error',
    message: `${mixed.name} mixes incompatible materials. ${decision.reason}`,
    help: PREFLIGHT_HELP,
    entities,
    actions: [
      { id: 'reveal', label: 'Reveal virtual filament', entity },
      { id: 'choose-filament', label: 'Choose compatible components', entity },
    ],
  });
}

/**
 * Canonical validation already rejects a gradient outside `(0, 1)`, endpoints
 * closer than `k_min_gradient_difference`, an A==B pair, mismatched weight
 * counts, and component IDs that are not recipe components. What it cannot see
 * is the narrower repair the pinned manager performs on an accepted recipe: it
 * clamps enabled endpoints into `[0.01, 0.99]`, and `decode_gradient_component_ids`
 * silently drops duplicates and any ID past the printer's physical tool count.
 * Each of those would print a mix the project never authored.
 */
function checkGradientRecipe(
  issues: SlicePreflightIssue[],
  mixed: MixedFilament,
  entity: SelectionRef,
  physicalById: ReadonlyMap<PhysicalFilamentId, PhysicalFilament>,
  printer: PrinterCapabilityConstraints | undefined,
): void {
  const recipe = mixed.fullSpectrum;
  if (!recipe?.gradientEnabled) return;
  const report = (detailCode: string, message: string): void => {
    addIssue(issues, {
      code: 'gradient-recipe-out-of-bounds',
      detailCode,
      severity: 'error',
      message: `${mixed.name}: ${message}`,
      help: PREFLIGHT_HELP,
      path: `filaments.mixed.${mixed.id}.fullSpectrum.${detailCode}`,
      entities: [entity],
      actions: [
        { id: 'reveal', label: 'Reveal virtual filament', entity },
        { id: 'choose-filament', label: 'Edit the gradient recipe', entity },
      ],
    });
  };

  for (const [field, value] of [
    ['gradientStart', recipe.gradientStart],
    ['gradientEnd', recipe.gradientEnd],
  ] as const) {
    if (Number.isFinite(value) && (value < GRADIENT_MIN_RATIO || value > GRADIENT_MAX_RATIO)) {
      report(
        field,
        `${field} is ${value}; the engine clamps an enabled gradient into ` +
          `[${GRADIENT_MIN_RATIO}, ${GRADIENT_MAX_RATIO}].`,
      );
    }
  }

  const seen = new Set<PhysicalFilamentId>();
  for (const componentId of recipe.gradientComponentIds) {
    const filament = physicalById.get(componentId);
    if (!filament) continue;
    if (seen.has(componentId)) {
      report(
        'gradientComponentIds',
        `gradient component ${filament.name} is listed twice; the engine keeps only the first occurrence.`,
      );
      continue;
    }
    seen.add(componentId);
    if (printer && filament.toolId >= printer.physicalToolCount) {
      report(
        'gradientComponentIds',
        `gradient component ${filament.name} sits on tool ${filament.toolId + 1}, beyond the printer's ` +
          `${printer.physicalToolCount}; the engine drops it while decoding.`,
      );
    }
  }
}

/**
 * `MixedFilamentManager::total_filaments` is compared against the pinned
 * `MAXIMUM_FILAMENT_NUMBER`; beyond it the engine cannot address a row at all.
 */
function checkEngineFilamentCapacity(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  printer: PrinterCapabilityConstraints | undefined,
): void {
  const limit = printer?.maxTotalFilaments ?? PINNED_MAXIMUM_FILAMENT_NUMBER;
  const physicalCount = state.filaments.physical.length;
  const virtualCount = state.filaments.mixed.filter((mixed) => mixed.enabled && !mixed.fullSpectrum?.deleted).length;
  const total = physicalCount + virtualCount;
  if (total <= limit) return;
  addIssue(issues, {
    code: 'filament-count-exceeds-engine-limit',
    severity: 'error',
    message:
      `The project declares ${physicalCount} physical and ${virtualCount} enabled virtual filaments ` +
      `(${total}); the engine addresses at most ${limit}.`,
    help: PREFLIGHT_HELP,
    entities: [{ kind: 'project' }],
    actions: [{ id: 'choose-filament', label: 'Remove or disable filaments' }],
  });
}

function disabledFilamentIssue(entity: SelectionRef, name: string): MutableIssue {
  return {
    code: 'disabled-filament-assignment',
    severity: 'error',
    message: `Assigned filament ${name} is disabled.`,
    help: PREFLIGHT_HELP,
    entities: [entity],
    actions: [
      { id: 'reveal', label: 'Reveal filament', entity },
      { id: 'choose-filament', label: 'Choose a replacement filament', entity },
    ],
  };
}

function checkPhysicalFilament(
  issues: SlicePreflightIssue[],
  filament: PhysicalFilament,
  entity: SelectionRef,
  constraint: ToolFilamentConstraints | undefined,
): void {
  if (!constraint) return;
  if (
    filament.nozzleDiameterMm !== undefined &&
    constraint.nozzleDiameterMm !== undefined &&
    Math.abs(filament.nozzleDiameterMm - constraint.nozzleDiameterMm) > 1e-6
  ) {
    addIssue(issues, {
      code: 'filament-nozzle-mismatch',
      severity: 'error',
      message:
        `${filament.name} targets a ${filament.nozzleDiameterMm} mm nozzle, but tool ` +
        `${filament.toolId + 1} is configured for ${constraint.nozzleDiameterMm} mm.`,
      help: PREFLIGHT_HELP,
      entities: [entity],
      actions: [{ id: 'choose-profile', label: 'Choose a compatible filament profile', entity }],
    });
  }
  if (
    constraint.supportedMaterials &&
    !constraint.supportedMaterials.some(
      (material) => material.trim().toLowerCase() === filament.material.trim().toLowerCase(),
    )
  ) {
    addIssue(issues, {
      code: 'unsupported-filament-material',
      severity: 'error',
      message: `${filament.material || filament.name} is not supported on tool ${filament.toolId + 1}.`,
      help: PREFLIGHT_HELP,
      entities: [entity],
      actions: [{ id: 'choose-filament', label: 'Choose a supported material', entity }],
    });
  }
  checkTemperatures(issues, filament, entity, constraint);
}

function checkTemperatures(
  issues: SlicePreflightIssue[],
  filament: PhysicalFilament,
  entity: SelectionRef,
  constraint: ToolFilamentConstraints,
): void {
  for (const key of ['nozzle_temperature', 'nozzle_temperature_initial_layer'] as const) {
    if (!(key in filament.config)) continue;
    const values = parseConfigNumbers(filament.config, key);
    if (!values || values.length === 0) {
      addIssue(issues, {
        code: 'invalid-filament-temperature',
        detailCode: key,
        severity: 'error',
        message: `${filament.name} has an invalid ${key} value.`,
        help: PREFLIGHT_HELP,
        path: `filaments.${filament.id}.config.${key}`,
        entities: [entity],
        actions: [
          {
            id: 'choose-profile',
            label: 'Choose a valid filament profile',
            entity,
            settingKey: key,
          },
        ],
      });
      continue;
    }
    const outOfRange = values.find(
      (value) =>
        (constraint.minHotendTemperatureC !== undefined && value < constraint.minHotendTemperatureC) ||
        (constraint.maxHotendTemperatureC !== undefined && value > constraint.maxHotendTemperatureC),
    );
    if (outOfRange === undefined) continue;
    addIssue(issues, {
      code: 'filament-temperature-out-of-range',
      detailCode: key,
      severity: 'error',
      message:
        `${filament.name} requests ${outOfRange} °C, outside tool ${filament.toolId + 1}'s ` +
        `${formatTemperatureRange(constraint)}.`,
      help: PREFLIGHT_HELP,
      path: `filaments.${filament.id}.config.${key}`,
      entities: [entity],
      actions: [
        {
          id: 'choose-profile',
          label: 'Choose a temperature-compatible profile',
          entity,
          settingKey: key,
        },
      ],
    });
  }
}

/**
 * What the prime tower actually occupies on the bed.
 *
 * `wipe_tower_x/y` is the body's left-front corner; the engine prints the brim
 * — and, for a rib wall, the diagonals it unions across the body — outside it.
 * The same bound the auto-placer reserves is what this checks, so a placement
 * the planner accepts is one preflight accepts.
 */
function wipeTowerFootprint(
  state: ProjectState,
  plate: ProjectPlate,
  positionMm: readonly [number, number] | readonly number[],
): { xMin: number; yMin: number; xMax: number; yMax: number } {
  const config = { ...state.config, ...plate.config };
  const width = Number(config.prime_tower_width ?? config.wipe_tower_width) || 60;
  const margin = wipeTowerFootprintMarginMm(config);
  const x = positionMm[0] ?? 0;
  const y = positionMm[1] ?? 0;
  return {
    xMin: x - margin,
    yMin: y - margin,
    xMax: x + width + margin,
    yMax: y + width + margin,
  };
}

function checkWipeTower(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  plate: ProjectPlate,
  constraints: SlicePreflightConstraints | undefined,
  usedPhysical: ReadonlySet<PhysicalFilamentId>,
): void {
  const tower = plate.wipeTower;
  if (!tower?.enabled) return;
  const buildVolume = constraints?.buildVolume;
  const plateEntity: SelectionRef = { kind: 'plate', id: plate.id };
  checkWipeTowerFeasibility(issues, state, plate, plateEntity, constraints, usedPhysical);
  if (buildVolume) {
    // The tower is a box with a brim, not a point. Checking only its origin
    // passed a 30 mm tower whose first layer printed 9 mm past the front-left
    // corner of the bed, because the corner it is anchored by was on the bed
    // and everything it drags with it was not.
    const footprint = wipeTowerFootprint(state, plate, tower.positionMm);
    if (
      footprint.xMin < buildVolume.minXmm ||
      footprint.xMax > buildVolume.maxXmm ||
      footprint.yMin < buildVolume.minYmm ||
      footprint.yMax > buildVolume.maxYmm
    ) {
      addIssue(issues, {
        code: 'wipe-tower-outside-build-volume',
        severity: 'error',
        message:
          `Wipe-tower footprint ${footprint.xMin.toFixed(1)}–${footprint.xMax.toFixed(1)} × ` +
          `${footprint.yMin.toFixed(1)}–${footprint.yMax.toFixed(1)} mm (origin ${tower.positionMm.join(', ')} mm, ` +
          `including its brim) leaves the build volume ` +
          `${buildVolume.minXmm.toFixed(1)}–${buildVolume.maxXmm.toFixed(1)} × ` +
          `${buildVolume.minYmm.toFixed(1)}–${buildVolume.maxYmm.toFixed(1)} mm.`,
        help: PREFLIGHT_HELP,
        entities: [plateEntity],
        actions: [
          { id: 'reveal', label: 'Reveal wipe tower', entity: plateEntity },
          { id: 'disable-wipe-tower', label: 'Disable wipe tower', entity: plateEntity },
        ],
      });
    }
  }
  if (tower.filamentId && !state.filaments.physical.some((filament) => filament.id === tower.filamentId)) {
    const filamentEntity: SelectionRef = { kind: 'filament', id: tower.filamentId };
    addIssue(issues, {
      code: 'wipe-tower-requires-physical-filament',
      severity: 'error',
      message: 'The wipe tower must use an enabled physical filament, not a virtual recipe.',
      help: PREFLIGHT_HELP,
      entities: [plateEntity, filamentEntity],
      actions: [{ id: 'choose-filament', label: 'Choose a physical wipe-tower filament', entity: plateEntity }],
    });
  }
}

/**
 * Exact prime-tower preconditions from the pinned `Print::validate()`:
 * relative extruder addressing is required, ooze prevention conflicts with
 * single-extruder multi-material, and mismatched nozzle or filament diameters
 * across the used tools are the upstream warning, not a hard stop.
 */
function checkWipeTowerFeasibility(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  plate: ProjectPlate,
  plateEntity: SelectionRef,
  constraints: SlicePreflightConstraints | undefined,
  usedPhysical: ReadonlySet<PhysicalFilamentId>,
): void {
  const config = resolveConfig(state, { plateId: plate.id }).effective;
  if (parseConfigBoolean(config, 'use_relative_e_distances') === false) {
    addIssue(issues, {
      code: 'wipe-tower-requires-relative-e',
      severity: 'error',
      message: 'The wipe tower needs relative extruder addressing (use_relative_e_distances = 1).',
      help: PREFLIGHT_HELP,
      path: 'config.use_relative_e_distances',
      entities: [plateEntity],
      actions: [
        { id: 'choose-profile', label: 'Enable relative E addressing', settingKey: 'use_relative_e_distances' },
        { id: 'disable-wipe-tower', label: 'Disable wipe tower', entity: plateEntity },
      ],
    });
  }
  if (
    parseConfigBoolean(config, 'ooze_prevention') === true &&
    parseConfigBoolean(config, 'single_extruder_multi_material') === true
  ) {
    addIssue(issues, {
      code: 'wipe-tower-ooze-prevention-conflict',
      severity: 'error',
      message: 'Ooze prevention only works with the wipe tower when single_extruder_multi_material is off.',
      help: PREFLIGHT_HELP,
      path: 'config.ooze_prevention',
      entities: [plateEntity],
      actions: [
        { id: 'choose-profile', label: 'Turn off ooze prevention', settingKey: 'ooze_prevention' },
        { id: 'disable-wipe-tower', label: 'Disable wipe tower', entity: plateEntity },
      ],
    });
  }

  const used = state.filaments.physical
    .filter((filament) => usedPhysical.has(filament.id))
    .sort((left, right) => left.toolId - right.toolId);
  if (used.length < 2) return;
  const nozzleOf = (filament: PhysicalFilament): number | undefined =>
    constraints?.tools?.[filament.toolId]?.nozzleDiameterMm ?? filament.nozzleDiameterMm;
  const firstNozzle = nozzleOf(used[0]);
  const firstDiameter = parseConfigNumbers(used[0].config, 'filament_diameter')?.[0];
  for (const filament of used.slice(1)) {
    const nozzle = nozzleOf(filament);
    const diameter = parseConfigNumbers(filament.config, 'filament_diameter')?.[0];
    const nozzleMismatch =
      firstNozzle !== undefined && nozzle !== undefined && Math.abs(nozzle - firstNozzle) > WIPE_TOWER_NOZZLE_EPSILON;
    const diameterMismatch =
      firstDiameter !== undefined &&
      diameter !== undefined &&
      firstDiameter !== 0 &&
      Math.abs((diameter - firstDiameter) / firstDiameter) > WIPE_TOWER_FILAMENT_DIAMETER_TOLERANCE;
    if (!nozzleMismatch && !diameterMismatch) continue;
    const entity: SelectionRef = { kind: 'filament', id: filament.id };
    addIssue(issues, {
      code: 'wipe-tower-mixed-extruder-diameters',
      detailCode: nozzleMismatch ? 'nozzle_diameter' : 'filament_diameter',
      severity: 'warning',
      message:
        `${filament.name} on tool ${filament.toolId + 1} uses a different ` +
        `${nozzleMismatch ? 'nozzle' : 'filament'} diameter than tool ${used[0].toolId + 1}; ` +
        'the pinned engine treats that as experimental with the prime tower.',
      help: PREFLIGHT_HELP,
      entities: [plateEntity, entity],
      actions: [{ id: 'choose-profile', label: 'Match the tool diameters', entity }],
    });
  }
}

function parseConfigBoolean(config: ConfigMap, key: string): boolean | undefined {
  const value = config[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

function checkCustomGcode(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  plate: ProjectPlate,
  byteLimit: number,
): void {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
    throw new Error('Custom G-code byte limit must be a positive safe integer');
  }
  const encoder = new TextEncoder();
  for (const entry of state.customGcode) {
    if (entry.scope === 'plate' && entry.plateId !== plate.id) continue;
    const bytes = encoder.encode(entry.code).byteLength;
    if (!entry.code.includes('\0') && bytes <= byteLimit) continue;
    const plateEntity: SelectionRef = { kind: 'plate', id: plate.id };
    addIssue(issues, {
      code: 'unsafe-custom-gcode',
      detailCode: entry.code.includes('\0') ? 'nul-byte' : 'byte-limit',
      severity: 'error',
      message: entry.code.includes('\0')
        ? 'Custom G-code contains a NUL byte and cannot be passed to the engine safely.'
        : `Custom G-code is ${bytes} bytes; the configured limit is ${byteLimit}.`,
      help: PREFLIGHT_HELP,
      path: `customGcode.${entry.id}.code`,
      entities: [plateEntity],
      actions: [
        {
          id: 'edit-custom-gcode',
          label: 'Edit custom G-code',
          entity: plateEntity,
          settingKey: entry.id satisfies CustomGcodeId,
        },
      ],
    });
  }
}

function parseConfigNumbers(config: ConfigMap, key: string): number[] | undefined {
  const value = config[key];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,]/) : [value];
  const parsed: number[] = [];
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      parsed.push(item);
    } else if (typeof item === 'string' && item.trim() && Number.isFinite(Number(item.trim()))) {
      parsed.push(Number(item.trim()));
    } else {
      return undefined;
    }
  }
  return parsed;
}

function addIssue(issues: SlicePreflightIssue[], issue: MutableIssue): void {
  const entities = (issue.entities ?? []).map((entity) => Object.freeze({ ...entity }));
  const actions = (issue.actions ?? []).map((action) =>
    Object.freeze({
      ...action,
      ...(action.entity ? { entity: Object.freeze({ ...action.entity }) } : {}),
    }),
  );
  const identity = [
    issue.code,
    issue.detailCode ?? '',
    issue.path ?? '',
    ...entities.map((entity) => (entity.kind === 'project' ? 'project' : `${entity.kind}:${entity.id}`)),
  ].join(':');
  issues.push(
    Object.freeze({
      ...issue,
      id: `slice-preflight:${identity}`,
      entities: Object.freeze(entities),
      actions: Object.freeze(actions),
    }),
  );
}

function finish(
  plateId: PlateId,
  sourceIssues: readonly SlicePreflightIssue[],
  printableInstanceIds: readonly InstanceId[],
  usedFilamentIds: readonly FilamentId[],
): CanonicalSlicePreflightResult {
  const issues = [...sourceIssues].sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareCanonicalText(left.code, right.code) ||
      compareCanonicalText(left.id, right.id),
  );
  const blockingCount = issues.filter((issue) => issue.severity === 'error').length;
  return Object.freeze({
    plateId,
    canSlice: blockingCount === 0 && printableInstanceIds.length > 0,
    blockingCount,
    issues: Object.freeze(issues),
    printableInstanceIds: Object.freeze([...printableInstanceIds].sort()),
    usedFilamentIds: Object.freeze([...usedFilamentIds].sort()),
  });
}

function severityRank(severity: SlicePreflightSeverity): number {
  return severity === 'error' ? 0 : 1;
}

function aabbPotentiallyOverlaps(left: CanonicalBounds3, right: CanonicalBounds3, tolerance: number): boolean {
  return (
    Math.min(left.max[0], right.max[0]) - Math.max(left.min[0], right.min[0]) > tolerance &&
    Math.min(left.max[1], right.max[1]) - Math.max(left.min[1], right.min[1]) > tolerance &&
    Math.min(left.max[2], right.max[2]) - Math.max(left.min[2], right.min[2]) >= -tolerance
  );
}

function assertBuildVolume(volume: RectangularBuildVolume): void {
  const minZ = volume.minZmm ?? 0;
  if (
    ![volume.minXmm, volume.maxXmm, volume.minYmm, volume.maxYmm, minZ, volume.maxZmm].every(Number.isFinite) ||
    volume.maxXmm <= volume.minXmm ||
    volume.maxYmm <= volume.minYmm ||
    volume.maxZmm <= minZ
  ) {
    throw new Error('Build volume must contain finite increasing axis bounds');
  }
}

function assertPreflightConstraints(constraints: SlicePreflightConstraints | undefined): void {
  if (!constraints) return;
  if (constraints.buildVolume) assertBuildVolume(constraints.buildVolume);
  if (constraints.geometryToleranceMm !== undefined) {
    assertTolerance(constraints.geometryToleranceMm);
  }
  if (
    constraints.customGcodeByteLimit !== undefined &&
    (!Number.isSafeInteger(constraints.customGcodeByteLimit) || constraints.customGcodeByteLimit < 1)
  ) {
    throw new Error('Custom G-code byte limit must be a positive safe integer');
  }
  const printer = constraints.printer;
  if (printer) {
    if (!Number.isSafeInteger(printer.physicalToolCount) || printer.physicalToolCount < 1) {
      throw new Error('Printer capability must declare a positive physical tool count');
    }
    if (
      printer.maxTotalFilaments !== undefined &&
      (!Number.isSafeInteger(printer.maxTotalFilaments) ||
        printer.maxTotalFilaments < 1 ||
        printer.maxTotalFilaments > PINNED_MAXIMUM_FILAMENT_NUMBER)
    ) {
      throw new Error(
        `Printer filament ceiling must be a positive integer no greater than ${PINNED_MAXIMUM_FILAMENT_NUMBER}`,
      );
    }
  }
  for (const [toolId, tool] of (constraints.tools ?? []).entries()) {
    if (!tool) continue;
    if (
      tool.nozzleDiameterMm !== undefined &&
      (!Number.isFinite(tool.nozzleDiameterMm) || tool.nozzleDiameterMm <= 0)
    ) {
      throw new Error(`Tool ${toolId + 1} nozzle diameter must be finite and positive`);
    }
    if (tool.supportedMaterials?.some((material) => typeof material !== 'string' || !material.trim())) {
      throw new Error(`Tool ${toolId + 1} supported materials must be non-empty strings`);
    }
    const minimum = tool.minHotendTemperatureC;
    const maximum = tool.maxHotendTemperatureC;
    if (
      (minimum !== undefined && !Number.isFinite(minimum)) ||
      (maximum !== undefined && !Number.isFinite(maximum)) ||
      (minimum !== undefined && maximum !== undefined && maximum < minimum)
    ) {
      throw new Error(`Tool ${toolId + 1} hotend temperature range is invalid`);
    }
  }
}

function assertTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('Geometry tolerance must be finite and non-negative');
  }
}

function formatBounds(bounds: CanonicalBounds3): string {
  return `[${bounds.min.map(formatMm).join(', ')}]–[${bounds.max.map(formatMm).join(', ')}] mm`;
}

function formatBuildVolume(volume: RectangularBuildVolume): string {
  return (
    `[${formatMm(volume.minXmm)}, ${formatMm(volume.minYmm)}, ${formatMm(volume.minZmm ?? 0)}]–` +
    `[${formatMm(volume.maxXmm)}, ${formatMm(volume.maxYmm)}, ${formatMm(volume.maxZmm)}] mm`
  );
}

function formatMm(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatTemperatureRange(constraint: ToolFilamentConstraints): string {
  const minimum = constraint.minHotendTemperatureC;
  const maximum = constraint.maxHotendTemperatureC;
  if (minimum !== undefined && maximum !== undefined) return `${minimum}–${maximum} °C range`;
  if (minimum !== undefined) return `minimum ${minimum} °C`;
  if (maximum !== undefined) return `maximum ${maximum} °C`;
  return 'configured temperature range';
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n\t]+/g, ' ').slice(0, 240) || 'unknown mesh error';
}
