import {
  MalformedModelSourceError,
  type DecodedImportNotice,
  type DecodedTriangleMesh,
  type ModelImportFormat,
  type ModelImportLimits,
} from './types';

/**
 * Deterministic vertex welder shared by every mesh decoder. Vertices are
 * merged on exact float32 bit equality, matching the engine's own indexed
 * mesh construction, and emitted in first-seen order so a given source file
 * always produces byte-identical canonical assets.
 */
export class TriangleMeshBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly scratch = new Float32Array(3);
  private readonly scratchWords = new Uint32Array(this.scratch.buffer);
  private degenerate = 0;

  constructor(
    private readonly limits: ModelImportLimits,
    private readonly format: ModelImportFormat,
    private readonly path: string,
  ) {}

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get degenerateCount(): number {
    return this.degenerate;
  }

  addTriangle(corners: readonly [number, number, number][]): void {
    const resolved: number[] = [];
    for (const corner of corners) resolved.push(this.addVertex(corner[0], corner[1], corner[2]));
    if (resolved[0] === resolved[1] || resolved[1] === resolved[2] || resolved[0] === resolved[2]) {
      this.degenerate += 1;
      return;
    }
    if (this.triangleCount + 1 > this.limits.maxTriangles) {
      throw new MalformedModelSourceError(
        `${this.path} exceeds the ${this.limits.maxTriangles.toLocaleString('en-US')} triangle import limit`,
        'limit-exceeded',
        this.format,
      );
    }
    this.indices.push(resolved[0], resolved[1], resolved[2]);
  }

  addVertex(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new MalformedModelSourceError(`${this.path} contains a non-finite vertex`, 'invalid-geometry', this.format);
    }
    this.scratch[0] = x;
    this.scratch[1] = y;
    this.scratch[2] = z;
    const [bx, by, bz] = [this.scratch[0], this.scratch[1], this.scratch[2]];
    const key = hashWords(this.scratchWords[0], this.scratchWords[1], this.scratchWords[2]);
    const bucket = this.buckets.get(key);
    if (bucket) {
      for (const candidate of bucket) {
        const offset = candidate * 3;
        if (
          Object.is(this.positions[offset], bx) &&
          Object.is(this.positions[offset + 1], by) &&
          Object.is(this.positions[offset + 2], bz)
        ) {
          return candidate;
        }
      }
    }
    if (this.vertexCount + 1 > this.limits.maxVertices) {
      throw new MalformedModelSourceError(
        `${this.path} exceeds the ${this.limits.maxVertices.toLocaleString('en-US')} vertex import limit`,
        'limit-exceeded',
        this.format,
      );
    }
    const index = this.vertexCount;
    this.positions.push(bx, by, bz);
    if (bucket) bucket.push(index);
    else this.buckets.set(key, [index]);
    return index;
  }

  /** Append an already-resolved triangle; corners must come from `addVertex`. */
  addIndexedTriangle(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) {
      this.degenerate += 1;
      return;
    }
    const vertices = this.vertexCount;
    if (a < 0 || b < 0 || c < 0 || a >= vertices || b >= vertices || c >= vertices) {
      throw new MalformedModelSourceError(
        `${this.path} references a vertex outside its declared range`,
        'invalid-geometry',
        this.format,
      );
    }
    if (this.triangleCount + 1 > this.limits.maxTriangles) {
      throw new MalformedModelSourceError(
        `${this.path} exceeds the ${this.limits.maxTriangles.toLocaleString('en-US')} triangle import limit`,
        'limit-exceeded',
        this.format,
      );
    }
    this.indices.push(a, b, c);
  }

  build(): DecodedTriangleMesh {
    if (this.triangleCount === 0) {
      throw new MalformedModelSourceError(`${this.path} contains no printable triangles`, 'no-geometry', this.format);
    }
    return Object.freeze({
      positions: Float32Array.from(this.positions),
      indices: Uint32Array.from(this.indices),
    });
  }

  /** Repair notice describing dropped degenerate facets, when any were found. */
  repairNotice(): DecodedImportNotice | undefined {
    if (this.degenerate === 0) return undefined;
    return {
      kind: 'geometry-repair',
      code: 'degenerate-triangles-dropped',
      path: this.path,
      message: `Dropped ${this.degenerate} degenerate triangle${this.degenerate === 1 ? '' : 's'} with repeated vertices`,
    };
  }
}

function hashWords(a: number, b: number, c: number): number {
  let hash = 0x811c9dc5;
  hash = Math.imul(hash ^ (a & 0xffff), 0x01000193);
  hash = Math.imul(hash ^ (a >>> 16), 0x01000193);
  hash = Math.imul(hash ^ (b & 0xffff), 0x01000193);
  hash = Math.imul(hash ^ (b >>> 16), 0x01000193);
  hash = Math.imul(hash ^ (c & 0xffff), 0x01000193);
  hash = Math.imul(hash ^ (c >>> 16), 0x01000193);
  return hash >>> 0;
}

/** Control characters never reach canonical names, 3MF attributes, or the DOM. */
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ');
}

export function boundedName(value: string | undefined, fallback: string, limits: ModelImportLimits): string {
  const trimmed = stripControlCharacters(value ?? '').trim();
  if (!trimmed) return fallback;
  return trimmed.length > limits.maxNameLength ? trimmed.slice(0, limits.maxNameLength) : trimmed;
}
