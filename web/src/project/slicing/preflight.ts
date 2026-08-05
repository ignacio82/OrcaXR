import { InMemoryAssetRepository, type AssetRepository } from '../assets';
import { cloneJson, deepFreeze } from '../domain/canonical';
import type {
  CustomGcodeId,
  FilamentId,
  InstanceId,
  MixedFilamentId,
  PhysicalFilamentId,
  PlateId,
} from '../domain/ids';
import type { ConfigMap, PhysicalFilament, ProjectPlate, ProjectState } from '../domain/model';
import { findPlate, resolveFilament } from '../domain/selectors';
import { validateProjectState } from '../domain/validation';
import { computeCanonicalInstanceBounds, type CanonicalBounds3 } from '../objects/bounds';
import type { SelectionRef } from '../selection';
import type { CanonicalProjectSliceSnapshot } from './types';

export const PINNED_SLICE_PREFLIGHT_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  modelValidation: 'src/libslic3r/Model.cpp',
  gcodeValidation: 'src/libslic3r/GCode/GCodeProcessor.hpp',
});

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
  | 'filament-nozzle-mismatch'
  | 'unsupported-filament-material'
  | 'invalid-filament-temperature'
  | 'filament-temperature-out-of-range'
  | 'missing-profile-attestation'
  | 'wipe-tower-outside-build-volume'
  | 'wipe-tower-requires-physical-filament'
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

export interface SlicePreflightConstraints {
  readonly buildVolume?: RectangularBuildVolume;
  /** Indexed by the canonical zero-based physical tool ID. */
  readonly tools?: readonly (ToolFilamentConstraints | undefined)[];
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
  if (printable.length === 0) {
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
  const usedPhysicalComponents = checkFilaments(issues, request.state, usedFilaments, request.constraints);
  checkWipeTower(issues, request.state, plate, request.constraints?.buildVolume);
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
    for (const component of mixed.components) {
      usedPhysical.add(component.filamentId);
      const componentFilament = physicalById.get(component.filamentId);
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
    checkPhysicalFilament(issues, filament, entity, constraints?.tools?.[filament.toolId]);
  }
  return usedPhysical;
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

function checkWipeTower(
  issues: SlicePreflightIssue[],
  state: ProjectState,
  plate: ProjectPlate,
  buildVolume: RectangularBuildVolume | undefined,
): void {
  const tower = plate.wipeTower;
  if (!tower?.enabled) return;
  const plateEntity: SelectionRef = { kind: 'plate', id: plate.id };
  if (
    buildVolume &&
    (tower.positionMm[0] < buildVolume.minXmm ||
      tower.positionMm[0] > buildVolume.maxXmm ||
      tower.positionMm[1] < buildVolume.minYmm ||
      tower.positionMm[1] > buildVolume.maxYmm)
  ) {
    addIssue(issues, {
      code: 'wipe-tower-outside-build-volume',
      severity: 'error',
      message: `Wipe-tower origin ${tower.positionMm.join(', ')} mm is outside the build volume.`,
      help: PREFLIGHT_HELP,
      entities: [plateEntity],
      actions: [
        { id: 'reveal', label: 'Reveal wipe tower', entity: plateEntity },
        { id: 'disable-wipe-tower', label: 'Disable wipe tower', entity: plateEntity },
      ],
    });
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
      left.code.localeCompare(right.code) ||
      left.id.localeCompare(right.id),
  );
  const blockingCount = issues.filter((issue) => issue.severity === 'error').length;
  return Object.freeze({
    plateId,
    canSlice: blockingCount === 0,
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
