import type { FilamentId, PlateId } from '../project/domain/ids';
import type {
  CanonicalSlicePreflightPort,
  CanonicalSlicePreflightResult,
  SlicePreflightConstraints,
  SlicePreflightIssue,
  ToolFilamentConstraints,
} from '../project/slicing';
import { CanonicalSlicePreflightValidator } from '../project/slicing';
import type { CanonicalProjectSliceSnapshot } from '../project/slicing/types';
import type { SlicerProfile } from '../slicer/ProfileLoader';

export type LiveProfileConstraintDiagnosticCode =
  | 'missing-exact-printer-profile'
  | 'invalid-tool-count'
  | 'ambiguous-printable-area'
  | 'ambiguous-printable-height'
  | 'ambiguous-nozzle-map'
  | 'missing-exact-filament-profile';

export type LiveProfileConstraintOmissionCode =
  | 'material-not-declared'
  | 'temperature-lower-bound-not-declared'
  | 'temperature-upper-bound-not-declared'
  | 'temperature-range-invalid';

export interface LiveProfileConstraintDiagnostic {
  readonly code: LiveProfileConstraintDiagnosticCode;
  readonly message: string;
  readonly help: string;
  readonly path?: string;
  readonly toolId?: number;
}

export interface LiveProfileConstraintOmission {
  readonly code: LiveProfileConstraintOmissionCode;
  readonly message: string;
  readonly path: string;
  readonly toolId: number;
}

export interface LiveProfilePreflightTarget {
  /** Exact resolved machine/process/primary-filament catalog entry. */
  readonly primaryProfile: SlicerProfile | null | undefined;
  /** Exact resolved filament catalog entry for each canonical physical tool. */
  readonly filamentProfiles: readonly (SlicerProfile | undefined)[];
  readonly toolCount: number;
  /**
   * Where the target came from. `catalog` requires exact catalog preset
   * identity. `authored-project` is an imported project that slices
   * as authored: its own embedded machine/filament configuration is the
   * authority, so preset identity is not required — but every safety fact
   * still has to be declared exactly by that configuration.
   */
  readonly source?: 'catalog' | 'authored-project';
}

export interface LiveProfileConstraintDerivation {
  readonly constraints: SlicePreflightConstraints;
  /** Missing target facts that make a live slice unsafe to submit. */
  readonly blockingDiagnostics: readonly LiveProfileConstraintDiagnostic[];
  /** Optional constraints absent from the profile corpus; never guessed. */
  readonly omissions: readonly LiveProfileConstraintOmission[];
}

const AUTHORED_HELP =
  'This project was imported with its own printer and filament configuration. Re-open it with complete embedded settings, or select a catalog printer, process, and filament to slice against instead.';

const PROFILE_HELP =
  'Choose a complete catalog-backed printer, process, and filament combination before slicing. No target value is inferred from the scene or a display label.';

/**
 * Derive only constraints that have one exact interpretation in the resolved
 * live profile selection. Required target facts fail closed; optional
 * filament facts are recorded as omissions instead of being guessed.
 */
export function deriveLiveProfilePreflightConstraints(
  target: LiveProfilePreflightTarget,
): LiveProfileConstraintDerivation {
  const blockingDiagnostics: LiveProfileConstraintDiagnostic[] = [];
  const omissions: LiveProfileConstraintOmission[] = [];
  const primary = target.primaryProfile;

  const authoredProject = target.source === 'authored-project';
  if (!authoredProject && !hasExactPresetIdentity(primary)) {
    blockingDiagnostics.push({
      code: 'missing-exact-printer-profile',
      message: 'The live printer, process, and primary filament selection is not bound to exact catalog presets.',
      help: PROFILE_HELP,
    });
  }
  if (authoredProject && !primary) {
    blockingDiagnostics.push({
      code: 'missing-exact-printer-profile',
      message: 'The imported project does not carry an embedded printer configuration to slice against.',
      help: AUTHORED_HELP,
    });
  }
  if (!Number.isSafeInteger(target.toolCount) || target.toolCount < 1) {
    blockingDiagnostics.push({
      code: 'invalid-tool-count',
      message: 'The live slicing target does not declare a positive physical tool count.',
      help: PROFILE_HELP,
      path: 'printer.toolCount',
    });
  }

  const buildVolume = primary ? parseBuildVolume(primary.config) : undefined;
  if (primary && !buildVolume) {
    const area = parseRectangularArea(primary.config['printable_area']);
    if (!area) {
      blockingDiagnostics.push({
        code: 'ambiguous-printable-area',
        message: 'The selected printer profile does not declare one axis-aligned rectangular printable area.',
        help: 'Choose a printer profile with an explicit rectangular printable_area; arbitrary bed polygons are not approximated.',
        path: 'config.printable_area',
      });
    }
    if (!parsePositiveScalar(primary.config['printable_height'])) {
      blockingDiagnostics.push({
        code: 'ambiguous-printable-height',
        message: 'The selected printer profile does not declare one positive printable height.',
        help: 'Choose a printer profile with an explicit printable_height; a fallback height is not safe for slicing.',
        path: 'config.printable_height',
      });
    }
  }

  const toolCount = Number.isSafeInteger(target.toolCount) && target.toolCount > 0 ? target.toolCount : 0;
  const nozzles = primary ? parseNozzleMap(primary.config, toolCount) : undefined;
  if (primary && toolCount > 0 && !nozzles) {
    blockingDiagnostics.push({
      code: 'ambiguous-nozzle-map',
      message: `The selected printer profile cannot map its nozzle diameters exactly to ${toolCount} physical tool${
        toolCount === 1 ? '' : 's'
      }.`,
      help: 'Select a profile whose nozzle_diameter count matches its tools, or an explicitly declared single-extruder multi-material profile.',
      path: 'config.nozzle_diameter',
    });
  }

  const tools: Array<ToolFilamentConstraints | undefined> = Array.from({ length: toolCount });
  for (let toolId = 0; toolId < toolCount; toolId += 1) {
    const filament = target.filamentProfiles[toolId];
    // An authored project's embedded per-filament configuration is its own
    // authority; a catalog target must resolve an exact compatible preset.
    const usable = authoredProject
      ? Boolean(filament?.config)
      : hasExactPresetIdentity(filament) && sameMachineAndProcess(primary, filament);
    if (!usable || !filament) {
      blockingDiagnostics.push({
        code: 'missing-exact-filament-profile',
        message: authoredProject
          ? `Physical tool ${toolId + 1} has no embedded filament configuration in the imported project.`
          : `Physical tool ${toolId + 1} is not bound to an exact compatible filament preset.`,
        help: authoredProject ? AUTHORED_HELP : PROFILE_HELP,
        path: `filaments.physical[${toolId}].presetId`,
        toolId,
      });
      if (nozzles?.[toolId] !== undefined) {
        tools[toolId] = Object.freeze({ nozzleDiameterMm: nozzles[toolId] });
      }
      continue;
    }

    const constraint: {
      nozzleDiameterMm?: number;
      supportedMaterials?: readonly string[];
      minHotendTemperatureC?: number;
      maxHotendTemperatureC?: number;
    } = {};
    if (nozzles?.[toolId] !== undefined) constraint.nozzleDiameterMm = nozzles[toolId];

    const material = parseNonEmptyScalar(filament.config['filament_type']);
    if (material) {
      constraint.supportedMaterials = Object.freeze([material]);
    } else {
      omissions.push({
        code: 'material-not-declared',
        message: `Filament tool ${toolId + 1} does not declare one unambiguous filament_type.`,
        path: `filaments.physical[${toolId}].config.filament_type`,
        toolId,
      });
    }

    const lower = parseFiniteScalar(filament.config['nozzle_temperature_range_low']);
    const upper = parseFiniteScalar(filament.config['nozzle_temperature_range_high']);
    if (lower === undefined) {
      omissions.push({
        code: 'temperature-lower-bound-not-declared',
        message: `Filament tool ${toolId + 1} does not declare one nozzle temperature lower bound.`,
        path: `filaments.physical[${toolId}].config.nozzle_temperature_range_low`,
        toolId,
      });
    }
    if (upper === undefined) {
      omissions.push({
        code: 'temperature-upper-bound-not-declared',
        message: `Filament tool ${toolId + 1} does not declare one nozzle temperature upper bound.`,
        path: `filaments.physical[${toolId}].config.nozzle_temperature_range_high`,
        toolId,
      });
    }
    if (lower !== undefined && upper !== undefined && upper < lower) {
      omissions.push({
        code: 'temperature-range-invalid',
        message: `Filament tool ${toolId + 1} declares a descending nozzle temperature range.`,
        path: `filaments.physical[${toolId}].config.nozzle_temperature_range_low`,
        toolId,
      });
    } else {
      if (lower !== undefined) constraint.minHotendTemperatureC = lower;
      if (upper !== undefined) constraint.maxHotendTemperatureC = upper;
    }
    tools[toolId] = Object.freeze(constraint);
  }

  return Object.freeze({
    constraints: Object.freeze({
      ...(buildVolume ? { buildVolume: Object.freeze(buildVolume) } : {}),
      ...(tools.length > 0 ? { tools: Object.freeze(tools) } : {}),
    }),
    blockingDiagnostics: Object.freeze(blockingDiagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
    omissions: Object.freeze(omissions.map((omission) => Object.freeze({ ...omission }))),
  });
}

/**
 * Integration adapter shared by the live banner and slice coordinator. It adds
 * profile-binding failures to the canonical validator without weakening or
 * changing the project-level preflight implementation.
 */
export class LiveProfileSlicePreflight implements CanonicalSlicePreflightPort {
  private readonly validator: CanonicalSlicePreflightValidator;

  constructor(readonly derivation: LiveProfileConstraintDerivation) {
    this.validator = new CanonicalSlicePreflightValidator(derivation.constraints);
  }

  evaluate(snapshot: CanonicalProjectSliceSnapshot, plateId: PlateId): CanonicalSlicePreflightResult {
    const canonical = this.validator.evaluate(snapshot, plateId);
    if (this.derivation.blockingDiagnostics.length === 0) return canonical;

    const profileIssues = this.derivation.blockingDiagnostics.map((diagnostic) =>
      profileDiagnosticIssue(diagnostic, snapshot),
    );
    const issues = Object.freeze(
      [...canonical.issues, ...profileIssues].sort(
        (left, right) =>
          severityRank(left.severity) - severityRank(right.severity) ||
          left.code.localeCompare(right.code) ||
          left.id.localeCompare(right.id),
      ),
    );
    const blockingCount = issues.filter((issue) => issue.severity === 'error').length;
    return Object.freeze({
      ...canonical,
      canSlice: blockingCount === 0,
      blockingCount,
      issues,
    });
  }
}

function profileDiagnosticIssue(
  diagnostic: LiveProfileConstraintDiagnostic,
  snapshot: CanonicalProjectSliceSnapshot,
): SlicePreflightIssue {
  const filamentId =
    diagnostic.toolId === undefined
      ? undefined
      : snapshot.state.filaments.physical.find((filament) => filament.toolId === diagnostic.toolId)?.id;
  const entities = filamentId
    ? Object.freeze([{ kind: 'filament' as const, id: filamentId as FilamentId }])
    : Object.freeze([{ kind: 'project' as const }]);
  const detailCode = diagnostic.toolId === undefined ? diagnostic.code : `${diagnostic.code}-tool-${diagnostic.toolId}`;
  return Object.freeze({
    id: `slice-preflight:missing-profile-attestation:${detailCode}`,
    code: 'missing-profile-attestation',
    detailCode,
    severity: 'error',
    message: diagnostic.message,
    help: diagnostic.help,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    entities,
    actions: Object.freeze([]),
  });
}

function parseBuildVolume(config: Readonly<Record<string, string>>):
  | {
      minXmm: number;
      maxXmm: number;
      minYmm: number;
      maxYmm: number;
      minZmm: number;
      maxZmm: number;
    }
  | undefined {
  const area = parseRectangularArea(config['printable_area']);
  const height = parsePositiveScalar(config['printable_height']);
  if (!area || height === undefined) return undefined;
  return { ...area, minZmm: 0, maxZmm: height };
}

function parseRectangularArea(value: string | undefined):
  | {
      minXmm: number;
      maxXmm: number;
      minYmm: number;
      maxYmm: number;
    }
  | undefined {
  if (!value?.trim()) return undefined;
  const points = value.split(',').map(parsePoint);
  if (points.some((point) => !point)) return undefined;
  const concrete = points as Array<readonly [number, number]>;
  if (concrete.length > 1 && samePoint(concrete[0], concrete.at(-1)!)) concrete.pop();
  if (concrete.length !== 4) return undefined;

  const unique = new Set(concrete.map(([x, y]) => `${x}:${y}`));
  if (unique.size !== 4) return undefined;
  const xs = [...new Set(concrete.map(([x]) => x))].sort((left, right) => left - right);
  const ys = [...new Set(concrete.map(([, y]) => y))].sort((left, right) => left - right);
  if (xs.length !== 2 || ys.length !== 2 || xs[1] <= xs[0] || ys[1] <= ys[0]) return undefined;
  if (!xs.every((x) => ys.every((y) => unique.has(`${x}:${y}`)))) return undefined;
  for (let index = 0; index < concrete.length; index += 1) {
    const current = concrete[index];
    const next = concrete[(index + 1) % concrete.length];
    if ((current[0] === next[0]) === (current[1] === next[1])) return undefined;
  }
  return { minXmm: xs[0], maxXmm: xs[1], minYmm: ys[0], maxYmm: ys[1] };
}

function parsePoint(value: string): readonly [number, number] | undefined {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))x([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

function parseNozzleMap(config: Readonly<Record<string, string>>, toolCount: number): readonly number[] | undefined {
  if (toolCount < 1) return undefined;
  const nozzles = parsePositiveList(config['nozzle_diameter']);
  if (!nozzles) return undefined;
  if (nozzles.length === toolCount) return Object.freeze(nozzles);
  if (nozzles.length !== 1 || !declaresSingleExtruderMultiMaterial(config)) return undefined;
  return Object.freeze(Array.from({ length: toolCount }, () => nozzles[0]));
}

function parsePositiveList(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.split(/[;,]/);
  if (raw.some((entry) => !entry.trim())) return undefined;
  const parsed = raw.map((entry) => Number(entry.trim()));
  return parsed.every((entry) => Number.isFinite(entry) && entry > 0) ? parsed : undefined;
}

function parsePositiveScalar(value: string | undefined): number | undefined {
  const parsed = parseFiniteScalar(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseFiniteScalar(value: string | undefined): number | undefined {
  const scalar = parseNonEmptyScalar(value);
  if (scalar === undefined) return undefined;
  const parsed = Number(scalar);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNonEmptyScalar(value: string | undefined): string | undefined {
  if (!value?.trim() || /[;,]/.test(value)) return undefined;
  return value.trim();
}

function declaresSingleExtruderMultiMaterial(config: Readonly<Record<string, string>>): boolean {
  const value = parseNonEmptyScalar(config['single_extruder_multi_material'])?.toLowerCase();
  return value === '1' || value === 'true';
}

function hasExactPresetIdentity(
  profile: SlicerProfile | null | undefined,
): profile is SlicerProfile &
  Required<Pick<SlicerProfile, 'machinePresetId' | 'processPresetId' | 'filamentPresetId'>> {
  return Boolean(
    profile?.machinePresetId?.trim() && profile.processPresetId?.trim() && profile.filamentPresetId?.trim(),
  );
}

function sameMachineAndProcess(primary: SlicerProfile | null | undefined, filament: SlicerProfile): boolean {
  return Boolean(
    primary?.machinePresetId &&
    primary.processPresetId &&
    primary.machinePresetId === filament.machinePresetId &&
    primary.processPresetId === filament.processPresetId,
  );
}

function samePoint(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function severityRank(severity: SlicePreflightIssue['severity']): number {
  return severity === 'error' ? 0 : 1;
}
