import { TriangleMeshBuilder, boundedName } from './mesh';
import { defaultObjectName } from './stl';
import {
  IDENTITY_TRANSFORM,
  MalformedModelSourceError,
  type DecodedImportNotice,
  type DecodedModelImport,
  type DecodedObject,
  type DecodedVolume,
  type ModelImportLimits,
} from './types';

export interface ObjDecodeOptions {
  readonly filename: string;
  readonly limits: ModelImportLimits;
  /** Resolves `mtllib` companions; ZIP imports supply their sibling members. */
  readonly resolveCompanion?: (name: string) => Uint8Array | undefined;
}

interface PendingVolume {
  name: string;
  materialName?: string;
  builder: TriangleMeshBuilder;
}

interface PendingObject {
  name: string;
  volumes: PendingVolume[];
}

/**
 * Decode Wavefront OBJ. `o` records become canonical objects and each
 * `usemtl`/`g` section becomes a part inside its object, so imported material
 * boundaries stay independently assignable instead of collapsing into one
 * unnamed mesh. OBJ declares no unit, so millimetres are assumed and reported.
 */
export function decodeObj(bytes: Uint8Array, options: ObjDecodeOptions): DecodedModelImport {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const notices: DecodedImportNotice[] = [];
  const limits = options.limits;

  const vertices: number[] = [];
  const vertexColors = new Map<number, string>();
  const objects: PendingObject[] = [];
  const materials = new Map<string, string>();
  let currentObject: PendingObject | undefined;
  let currentVolume: PendingVolume | undefined;
  let currentMaterial: string | undefined;
  let currentGroup: string | undefined;
  let lineNumber = 0;
  let polygonsTriangulated = 0;
  let ignoredCurves = 0;

  const startObject = (name: string | undefined): PendingObject => {
    if (objects.length + 1 > limits.maxObjects) {
      throw new MalformedModelSourceError(
        `${options.filename} declares more than ${limits.maxObjects} objects`,
        'limit-exceeded',
        'obj',
      );
    }
    const pending: PendingObject = {
      name: boundedName(name, `${defaultObjectName(options.filename)} ${objects.length + 1}`, limits),
      volumes: [],
    };
    objects.push(pending);
    currentObject = pending;
    currentVolume = undefined;
    return pending;
  };

  const activeVolume = (): PendingVolume => {
    const object = currentObject ?? startObject(defaultObjectName(options.filename));
    if (currentVolume) return currentVolume;
    if (object.volumes.length + 1 > limits.maxVolumesPerObject) {
      throw new MalformedModelSourceError(
        `${options.filename} object "${object.name}" declares more than ${limits.maxVolumesPerObject} parts`,
        'limit-exceeded',
        'obj',
      );
    }
    const label = currentMaterial ?? currentGroup;
    const volume: PendingVolume = {
      name: boundedName(
        label,
        object.volumes.length === 0 ? object.name : `${object.name} part ${object.volumes.length + 1}`,
        limits,
      ),
      materialName: currentMaterial,
      builder: new TriangleMeshBuilder(limits, 'obj', options.filename),
    };
    object.volumes.push(volume);
    currentVolume = volume;
    return volume;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const space = line.search(/\s/);
    const keyword = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const rest = space < 0 ? '' : line.slice(space + 1).trim();

    switch (keyword) {
      case 'v': {
        const parts = rest.split(/\s+/).filter(Boolean);
        if (parts.length < 3) {
          throw new MalformedModelSourceError(
            `${options.filename} line ${lineNumber}: vertex needs three coordinates`,
            'invalid-syntax',
            'obj',
          );
        }
        const coordinates = parts.slice(0, 3).map(Number);
        if (coordinates.some((value) => !Number.isFinite(value))) {
          throw new MalformedModelSourceError(
            `${options.filename} line ${lineNumber}: vertex has a non-numeric coordinate`,
            'invalid-geometry',
            'obj',
          );
        }
        if (vertices.length / 3 + 1 > limits.maxVertices) {
          throw new MalformedModelSourceError(
            `${options.filename} exceeds the vertex import limit`,
            'limit-exceeded',
            'obj',
          );
        }
        vertices.push(coordinates[0], coordinates[1], coordinates[2]);
        // xyzrgb exporters append colours after the coordinates (never w-only).
        if (parts.length >= 6) {
          const rgb = parts.slice(parts.length === 7 ? 4 : 3, parts.length === 7 ? 7 : 6).map(Number);
          if (rgb.length === 3 && rgb.every((value) => Number.isFinite(value))) {
            vertexColors.set(vertices.length / 3 - 1, rgbToHex(rgb));
          }
        }
        break;
      }
      case 'vn':
      case 'vt':
      case 'vp':
      case 's':
        break;
      case 'o':
        startObject(rest);
        currentGroup = undefined;
        currentVolume = undefined;
        break;
      case 'g':
        currentGroup = rest || undefined;
        currentVolume = undefined;
        break;
      case 'usemtl':
        currentMaterial = rest || undefined;
        currentVolume = undefined;
        break;
      case 'mtllib': {
        const loaded = loadMaterials(rest, options, materials, notices);
        if (!loaded) {
          notices.push({
            kind: 'dropped-field',
            code: 'obj-mtllib-not-loaded',
            path: `${options.filename}:${lineNumber}`,
            message: `Material library "${rest}" is not part of this import, so its colours were not applied`,
          });
        }
        break;
      }
      case 'l':
      case 'p':
      case 'curv':
      case 'curv2':
      case 'surf':
        ignoredCurves += 1;
        break;
      case 'f': {
        const corners = rest.split(/\s+/).filter(Boolean);
        if (corners.length < 3) {
          throw new MalformedModelSourceError(
            `${options.filename} line ${lineNumber}: a face needs at least three corners`,
            'invalid-syntax',
            'obj',
          );
        }
        const volume = activeVolume();
        const resolved = corners.map((corner) =>
          resolveVertexIndex(corner, vertices.length / 3, options.filename, lineNumber),
        );
        if (corners.length > 3) polygonsTriangulated += 1;
        // Fan triangulation matches the pinned engine's OBJ polygon handling.
        for (let corner = 1; corner + 1 < resolved.length; corner += 1) {
          volume.builder.addTriangle([
            vertexAt(vertices, resolved[0]),
            vertexAt(vertices, resolved[corner]),
            vertexAt(vertices, resolved[corner + 1]),
          ]);
        }
        break;
      }
      default:
        throw new MalformedModelSourceError(
          `${options.filename} line ${lineNumber}: unsupported OBJ keyword "${keyword}"`,
          'invalid-syntax',
          'obj',
        );
    }
  }

  const decoded: DecodedObject[] = [];
  for (const pending of objects) {
    const volumes: DecodedVolume[] = [];
    for (const volume of pending.volumes) {
      if (volume.builder.triangleCount === 0) continue;
      const repair = volume.builder.repairNotice();
      if (repair) notices.push(repair);
      volumes.push(
        Object.freeze({
          name: volume.name,
          role: 'model' as const,
          mesh: volume.builder.build(),
          materialName: volume.materialName,
          colorHex: volume.materialName ? materials.get(volume.materialName) : undefined,
        }),
      );
    }
    if (volumes.length === 0) continue;
    decoded.push(
      Object.freeze({
        name: pending.name,
        volumes: Object.freeze(volumes),
        instances: Object.freeze([Object.freeze({ transform: IDENTITY_TRANSFORM })]),
      }),
    );
  }

  if (decoded.length === 0) {
    throw new MalformedModelSourceError(`${options.filename} contains no faces`, 'no-geometry', 'obj');
  }
  if (polygonsTriangulated > 0) {
    notices.push({
      kind: 'geometry-repair',
      code: 'obj-polygons-triangulated',
      path: options.filename,
      message: `Triangulated ${polygonsTriangulated} polygon face${polygonsTriangulated === 1 ? '' : 's'} with a vertex fan`,
    });
  }
  if (ignoredCurves > 0) {
    notices.push({
      kind: 'dropped-field',
      code: 'obj-non-surface-elements-dropped',
      path: options.filename,
      message: `Dropped ${ignoredCurves} line, point, or curve element${ignoredCurves === 1 ? '' : 's'}; only surfaces can be printed`,
    });
  }
  if (vertexColors.size > 0) {
    notices.push({
      kind: 'dropped-field',
      code: 'obj-vertex-colours-not-assigned',
      path: options.filename,
      message: `Kept geometry from ${vertexColors.size} coloured vertices, but per-vertex colour is not a canonical filament assignment; paint or assign filaments after import`,
    });
  }
  if (decoded.some((object) => object.volumes.length > 1)) {
    notices.push({
      kind: 'material-substitution',
      code: 'obj-material-sections-as-parts',
      path: options.filename,
      message:
        'Each OBJ material or group section was imported as a separate part so it stays independently assignable',
    });
  }
  notices.push({
    kind: 'assumed-unit',
    code: 'obj-assumed-millimetres',
    path: options.filename,
    message: 'OBJ carries no unit; coordinates were imported as millimetres',
  });

  return Object.freeze({
    format: 'obj',
    filename: options.filename,
    unitScaleToMm: 1,
    sourceUnit: 'millimeter',
    objects: Object.freeze(decoded),
    notices: Object.freeze(notices),
  });
}

function loadMaterials(
  reference: string,
  options: ObjDecodeOptions,
  into: Map<string, string>,
  notices: DecodedImportNotice[],
): boolean {
  if (!reference || !options.resolveCompanion) return false;
  let loaded = false;
  for (const name of reference.split(/\s+/).filter(Boolean)) {
    const bytes = options.resolveCompanion(name);
    if (!bytes) continue;
    loaded = true;
    parseMaterialLibrary(new TextDecoder('utf-8', { fatal: false }).decode(bytes), into);
  }
  if (loaded) {
    notices.push({
      kind: 'material-substitution',
      code: 'obj-mtllib-loaded',
      path: options.filename,
      message: `Applied diffuse colours from ${reference}`,
    });
  }
  return loaded;
}

function parseMaterialLibrary(text: string, into: Map<string, string>): void {
  let current: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    const lower = keyword.toLowerCase();
    if (lower === 'newmtl') current = rest.join(' ').trim() || undefined;
    else if (lower === 'kd' && current) {
      const rgb = rest.slice(0, 3).map(Number);
      if (rgb.length === 3 && rgb.every((value) => Number.isFinite(value))) into.set(current, rgbToHex(rgb));
    }
  }
}

function resolveVertexIndex(corner: string, declared: number, filename: string, lineNumber: number): number {
  const raw = corner.split('/')[0];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed === 0) {
    throw new MalformedModelSourceError(
      `${filename} line ${lineNumber}: face corner "${corner}" is not a vertex reference`,
      'invalid-syntax',
      'obj',
    );
  }
  const index = parsed > 0 ? parsed - 1 : declared + parsed;
  if (index < 0 || index >= declared) {
    throw new MalformedModelSourceError(
      `${filename} line ${lineNumber}: face references vertex ${parsed} outside the declared range`,
      'invalid-geometry',
      'obj',
    );
  }
  return index;
}

function vertexAt(vertices: readonly number[], index: number): [number, number, number] {
  const offset = index * 3;
  return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash < 0 ? line : line.slice(0, hash);
}

function rgbToHex(rgb: readonly number[]): string {
  const channel = (value: number): string => {
    const scaled = value <= 1 ? value * 255 : value;
    const clamped = Math.max(0, Math.min(255, Math.round(scaled)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}
