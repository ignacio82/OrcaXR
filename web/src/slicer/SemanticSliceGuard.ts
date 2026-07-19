/** A semantic slice must fail closed; substituting a different material intent is data loss. */
export class SemanticSliceError extends Error {
  readonly code = 'SEMANTIC_SLICE_FAILED';

  constructor(
    readonly workflow: 'painted' | 'fullspectrum',
    cause: unknown,
  ) {
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : '';
    super(
      workflow === 'painted'
        ? `Multi-colour slicing failed; no monochrome substitute was generated.${detail}`
        : `FullSpectrum slicing failed; no geometry-only substitute was generated.${detail}`,
      { cause },
    );
    this.name = 'SemanticSliceError';
  }
}

/** Exact, platform-neutral bytes for one geometry attribute. */
export interface SemanticBufferSnapshot {
  readonly arrayType: string;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly bytes: Uint8Array;
}

/**
 * Everything that must still match before an immutable, as-authored project
 * may be sliced. Project bytes cover geometry, transforms, plates, and the
 * selected profile triple; colour buffers and controls cover intent that the
 * lightweight project writer cannot currently encode.
 */
export interface SemanticProjectSnapshot {
  readonly projectBytes: Uint8Array;
  readonly colorBuffers: ReadonlyArray<SemanticBufferSnapshot | null>;
  readonly controls: string;
}

/**
 * Holds an output together with the exact semantic input that produced it.
 * Reads fail closed when current project intent differs, while keeping the
 * prior value available if undo later restores the byte-identical snapshot.
 */
export class SemanticSliceArtifact<T> {
  private value: T | null = null;
  private source: SemanticProjectSnapshot | null = null;

  publish(value: T, source: SemanticProjectSnapshot): void {
    this.value = value;
    this.source = cloneSemanticProjectSnapshot(source);
  }

  /** Publish only when the live project is still the submitted project. */
  publishIfCurrent(value: T, submitted: SemanticProjectSnapshot, current: SemanticProjectSnapshot): boolean {
    if (!sameSemanticProjectSnapshot(submitted, current)) return false;
    this.publish(value, submitted);
    return true;
  }

  read(current: SemanticProjectSnapshot): T | null {
    if (this.value === null || this.source === null) return null;
    return sameSemanticProjectSnapshot(this.source, current) ? this.value : null;
  }

  clear(): void {
    this.value = null;
    this.source = null;
  }

  get hasArtifact(): boolean {
    return this.value !== null && this.source !== null;
  }
}

export type SemanticSliceRoute = 'fullspectrum' | 'painted' | 'geometry';

export interface SemanticSliceRouteInput {
  readonly hasFullSpectrumSource: boolean;
  readonly paintedInputAvailable: boolean;
  readonly distinctPaintAssignments: number;
  readonly paintedEngineEnabled: boolean;
  readonly externalGeometryEndpoint: boolean;
}

/** Combining FullSpectrum intent with another imported project needs a live canonical serializer. */
export function combinedSemanticImportRequiresCanonicalSlice(input: {
  readonly sourceWasExclusive: boolean;
  readonly hadFullSpectrumSource: boolean;
  readonly incomingVirtualFilamentCount: number;
}): boolean {
  return !input.sourceWasExclusive && (input.hadFullSpectrumSource || input.incomingVirtualFilamentCount > 0);
}

/** Choose a route without ever degrading material intent to plain geometry. */
export function selectSemanticSliceRoute(input: SemanticSliceRouteInput): SemanticSliceRoute {
  if (input.hasFullSpectrumSource) return 'fullspectrum';
  if (!input.paintedInputAvailable) {
    throw new Error('The plated geometry could not be encoded for slicing.');
  }
  if (input.distinctPaintAssignments <= 1) return 'geometry';
  if (!input.paintedEngineEnabled) {
    throw new SemanticSliceError(
      'painted',
      new Error('Painted slicing is disabled; enable the semantic painted engine before slicing.'),
    );
  }
  if (input.externalGeometryEndpoint) {
    throw new SemanticSliceError(
      'painted',
      new Error('The external geometry endpoint cannot preserve facet assignments; use the local isolated engine.'),
    );
  }
  return 'painted';
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Exact equality: no tolerance is safe when deciding whether edits can be ignored. */
export function sameSemanticProjectSnapshot(left: SemanticProjectSnapshot, right: SemanticProjectSnapshot): boolean {
  if (left.controls !== right.controls || !sameBytes(left.projectBytes, right.projectBytes)) return false;
  if (left.colorBuffers.length !== right.colorBuffers.length) return false;

  for (let i = 0; i < left.colorBuffers.length; i++) {
    const a = left.colorBuffers[i];
    const b = right.colorBuffers[i];
    if (a === null || b === null) {
      if (a !== b) return false;
      continue;
    }
    if (
      a.arrayType !== b.arrayType ||
      a.itemSize !== b.itemSize ||
      a.normalized !== b.normalized ||
      !sameBytes(a.bytes, b.bytes)
    ) {
      return false;
    }
  }
  return true;
}

function cloneSemanticProjectSnapshot(source: SemanticProjectSnapshot): SemanticProjectSnapshot {
  return {
    projectBytes: source.projectBytes.slice(),
    colorBuffers: source.colorBuffers.map((buffer) =>
      buffer
        ? {
            arrayType: buffer.arrayType,
            itemSize: buffer.itemSize,
            normalized: buffer.normalized,
            bytes: buffer.bytes.slice(),
          }
        : null,
    ),
    controls: source.controls,
  };
}

export async function requireSemanticSlice<T>(
  workflow: 'painted' | 'fullspectrum',
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new SemanticSliceError(workflow, cause);
  }
}
