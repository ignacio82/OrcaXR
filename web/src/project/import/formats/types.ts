import type { Transform, VolumeRole } from '../../domain/model';

/**
 * Concrete model container recognised by the import dispatcher. Detection is
 * always signature-first: an extension alone never selects a decoder, and a
 * mismatch between the two is a hard failure rather than a silent
 * reinterpretation of the bytes as another mesh format.
 */
export type ModelImportFormat =
  | 'stl-binary'
  | 'stl-ascii'
  | 'obj'
  | 'amf'
  | 'amf-compressed'
  | 'zip-archive'
  | 'project-3mf'
  | 'step'
  | 'svg'
  | 'gcode';

/** Machine-readable reason a recognised container cannot be decoded here. */
export type UnsupportedModelFormatReason =
  | 'empty-input'
  | 'unknown-signature'
  | 'extension-signature-mismatch'
  | 'requires-project-import'
  | 'requires-native-kernel'
  | 'requires-emboss-workflow'
  | 'not-a-model-format';

/** Machine-readable reason a recognised container failed to decode. */
export type MalformedModelSourceReason =
  'truncated' | 'invalid-syntax' | 'invalid-geometry' | 'no-geometry' | 'limit-exceeded' | 'unsafe-archive';

export class UnsupportedModelFormatError extends Error {
  constructor(
    message: string,
    readonly reasonCode: UnsupportedModelFormatReason,
    readonly format?: ModelImportFormat,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'UnsupportedModelFormatError';
  }
}

export class MalformedModelSourceError extends Error {
  constructor(
    message: string,
    readonly reasonCode: MalformedModelSourceReason,
    readonly format?: ModelImportFormat,
  ) {
    super(message);
    this.name = 'MalformedModelSourceError';
  }
}

/** Immutable triangle soup in source units; the decoder never rescales in place. */
export interface DecodedTriangleMesh {
  /** Interleaved xyz vertex positions in the source file's own unit. */
  readonly positions: Float32Array;
  /** Triangle corner indices into `positions`. */
  readonly indices: Uint32Array;
}

export interface DecodedVolume {
  readonly name: string;
  readonly role: VolumeRole;
  readonly mesh: DecodedTriangleMesh;
  /** `#rrggbb` when the source carried an explicit per-volume colour. */
  readonly colorHex?: string;
  /** Source material/appearance name, retained for provenance and warnings. */
  readonly materialName?: string;
}

export interface DecodedInstance {
  readonly name?: string;
  /** Placement of this instance in source units, before unit conversion. */
  readonly transform: Transform;
}

export interface DecodedObject {
  readonly name: string;
  readonly volumes: readonly DecodedVolume[];
  /** At least one instance; AMF constellations may repeat one object. */
  readonly instances: readonly DecodedInstance[];
}

export type DecodedImportNoticeKind =
  | 'unit-conversion'
  | 'assumed-unit'
  | 'dropped-field'
  | 'ignored-member'
  | 'geometry-repair'
  | 'material-substitution'
  | 'limit-warning';

/**
 * One structured observation about the decode. Every notice is surfaced to the
 * user through the transactional import preview; nothing is dropped silently.
 */
export interface DecodedImportNotice {
  readonly kind: DecodedImportNoticeKind;
  /** Stable machine-readable code, e.g. `obj-mtllib-not-loaded`. */
  readonly code: string;
  /** Source-relative location, e.g. `part.obj` or `$.amf.object[2]`. */
  readonly path: string;
  readonly message: string;
}

export interface DecodedModelImport {
  readonly format: ModelImportFormat;
  /** Source filename as supplied by the caller. */
  readonly filename: string;
  /**
   * Multiplier converting source coordinates to millimetres. Decoders report
   * it instead of pre-multiplying so callers can show the exact conversion.
   */
  readonly unitScaleToMm: number;
  /** Declared or assumed source unit name (`millimeter`, `inch`, ...). */
  readonly sourceUnit: string;
  readonly objects: readonly DecodedObject[];
  readonly notices: readonly DecodedImportNotice[];
}

/** Hard caps that keep hostile or accidental inputs bounded and cancellable. */
export interface ModelImportLimits {
  readonly maxBytes: number;
  readonly maxTriangles: number;
  readonly maxVertices: number;
  readonly maxObjects: number;
  readonly maxVolumesPerObject: number;
  readonly maxInstancesPerObject: number;
  readonly maxArchiveMembers: number;
  readonly maxNameLength: number;
  readonly maxXmlDepth: number;
}

export const DEFAULT_MODEL_IMPORT_LIMITS: ModelImportLimits = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxTriangles: 8_000_000,
  maxVertices: 24_000_000,
  maxObjects: 4096,
  maxVolumesPerObject: 512,
  maxInstancesPerObject: 4096,
  maxArchiveMembers: 512,
  maxNameLength: 200,
  maxXmlDepth: 64,
});

export function resolveModelImportLimits(overrides: Partial<ModelImportLimits> = {}): ModelImportLimits {
  const resolved: ModelImportLimits = { ...DEFAULT_MODEL_IMPORT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Model import limit ${key} must be a positive number`);
  }
  return Object.freeze(resolved);
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  translationMm: Object.freeze([0, 0, 0]) as unknown as Transform['translationMm'],
  rotation: Object.freeze([0, 0, 0, 1]) as unknown as Transform['rotation'],
  scale: Object.freeze([1, 1, 1]) as unknown as Transform['scale'],
});

/** Source units accepted by AMF plus the aliases the pinned engine tolerates. */
export const UNIT_SCALE_TO_MM: Readonly<Record<string, number>> = Object.freeze({
  millimeter: 1,
  millimetre: 1,
  mm: 1,
  micron: 0.001,
  micrometer: 0.001,
  meter: 1000,
  metre: 1000,
  m: 1000,
  centimeter: 10,
  centimetre: 10,
  cm: 10,
  inch: 25.4,
  in: 25.4,
  feet: 304.8,
  foot: 304.8,
  ft: 304.8,
});
