import { TriangleMeshBuilder, boundedName, stripControlCharacters } from './mesh';
import {
  IDENTITY_TRANSFORM,
  MalformedModelSourceError,
  type DecodedImportNotice,
  type DecodedModelImport,
  type ModelImportFormat,
  type ModelImportLimits,
} from './types';

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;

export interface StlDecodeOptions {
  readonly filename: string;
  readonly limits: ModelImportLimits;
  readonly format: ModelImportFormat;
  readonly objectName?: string;
}

/**
 * Decode binary or ASCII STL into one welded indexed mesh. STL carries no
 * units, no transforms, and no materials, so the result is deliberately a
 * single unnamed object in assumed millimetres, matching the pinned engine.
 */
export function decodeStl(bytes: Uint8Array, options: StlDecodeOptions): DecodedModelImport {
  const notices: DecodedImportNotice[] = [];
  const builder = new TriangleMeshBuilder(options.limits, options.format, options.filename);
  const solids =
    options.format === 'stl-binary'
      ? decodeBinaryStl(bytes, builder, options)
      : decodeAsciiStl(bytes, builder, options);

  const repair = builder.repairNotice();
  if (repair) notices.push(repair);
  if (solids.length > 1) {
    notices.push({
      kind: 'geometry-repair',
      code: 'stl-multiple-solids-merged',
      path: options.filename,
      message: `Merged ${solids.length} STL solids (${solids.slice(0, 4).join(', ')}${
        solids.length > 4 ? ', …' : ''
      }) into one object, as the pinned engine does; use Split to objects to separate them`,
    });
  }
  if (options.format === 'stl-binary' && solids[0]) {
    notices.push({
      kind: 'ignored-member',
      code: 'stl-binary-header',
      path: options.filename,
      message: `Binary STL header: "${solids[0]}"`,
    });
  }
  notices.push({
    kind: 'assumed-unit',
    code: 'stl-assumed-millimetres',
    path: options.filename,
    message: 'STL carries no unit; coordinates were imported as millimetres',
  });

  // Upstream names an imported mesh after its file, never its STL header.
  const name = boundedName(options.objectName, defaultObjectName(options.filename), options.limits);
  return Object.freeze({
    format: options.format,
    filename: options.filename,
    unitScaleToMm: 1,
    sourceUnit: 'millimeter',
    objects: Object.freeze([
      Object.freeze({
        name,
        volumes: Object.freeze([Object.freeze({ name, role: 'model' as const, mesh: builder.build() })]),
        instances: Object.freeze([Object.freeze({ transform: IDENTITY_TRANSFORM })]),
      }),
    ]),
    notices: Object.freeze(notices),
  });
}

function decodeBinaryStl(bytes: Uint8Array, builder: TriangleMeshBuilder, options: StlDecodeOptions): string[] {
  if (bytes.byteLength < BINARY_HEADER_BYTES) {
    throw new MalformedModelSourceError(
      `${options.filename} is shorter than a binary STL header`,
      'truncated',
      options.format,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  const available = Math.floor((bytes.byteLength - BINARY_HEADER_BYTES) / BINARY_TRIANGLE_BYTES);
  if (declared > available) {
    throw new MalformedModelSourceError(
      `${options.filename} declares ${declared} triangles but holds ${available}`,
      'truncated',
      options.format,
    );
  }
  if (declared > options.limits.maxTriangles) {
    throw new MalformedModelSourceError(
      `${options.filename} declares ${declared.toLocaleString('en-US')} triangles, above the import limit`,
      'limit-exceeded',
      options.format,
    );
  }
  for (let triangle = 0; triangle < declared; triangle += 1) {
    // Skip the per-facet normal: the engine recomputes it from winding order.
    const base = BINARY_HEADER_BYTES + triangle * BINARY_TRIANGLE_BYTES + 12;
    builder.addTriangle([
      [view.getFloat32(base, true), view.getFloat32(base + 4, true), view.getFloat32(base + 8, true)],
      [view.getFloat32(base + 12, true), view.getFloat32(base + 16, true), view.getFloat32(base + 20, true)],
      [view.getFloat32(base + 24, true), view.getFloat32(base + 28, true), view.getFloat32(base + 32, true)],
    ]);
  }
  // Exporters pad the fixed header with NULs; keep only the leading label.
  const header = stripControlCharacters(
    new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 80)).split('\u0000')[0],
  ).trim();
  return header ? [header] : [];
}

function decodeAsciiStl(bytes: Uint8Array, builder: TriangleMeshBuilder, options: StlDecodeOptions): string[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const solids: string[] = [];
  let corners: [number, number, number][] = [];
  let insideFacet = false;
  let lineNumber = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('solid')) {
      solids.push(line.slice(5).trim() || `solid ${solids.length + 1}`);
      continue;
    }
    if (lower.startsWith('endsolid') || lower.startsWith('outer loop') || lower.startsWith('endloop')) continue;
    if (lower.startsWith('facet')) {
      insideFacet = true;
      corners = [];
      continue;
    }
    if (lower.startsWith('endfacet')) {
      if (corners.length !== 3) {
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: a facet must declare exactly three vertices`,
          'invalid-syntax',
          options.format,
        );
      }
      builder.addTriangle(corners);
      corners = [];
      insideFacet = false;
      continue;
    }
    if (lower.startsWith('vertex')) {
      if (!insideFacet) {
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: vertex outside a facet`,
          'invalid-syntax',
          options.format,
        );
      }
      const parts = line.split(/\s+/);
      if (parts.length < 4) {
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: vertex needs three coordinates`,
          'invalid-syntax',
          options.format,
        );
      }
      const corner: [number, number, number] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (corner.some((value) => !Number.isFinite(value))) {
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: vertex has a non-numeric coordinate`,
          'invalid-geometry',
          options.format,
        );
      }
      if (corners.length === 3) {
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: a facet may not declare more than three vertices`,
          'invalid-syntax',
          options.format,
        );
      }
      corners.push(corner);
      continue;
    }
    throw new MalformedModelSourceError(
      `${options.filename} line ${lineNumber}: unsupported ASCII STL keyword "${line.split(/\s+/)[0]}"`,
      'invalid-syntax',
      options.format,
    );
  }
  if (insideFacet) {
    throw new MalformedModelSourceError(
      `${options.filename} ends inside an unterminated facet`,
      'truncated',
      options.format,
    );
  }
  return solids;
}

export function defaultObjectName(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? filename).trim();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem || 'Imported model';
}
