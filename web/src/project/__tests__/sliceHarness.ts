/**
 * A project, an engine, and the G-code it produced.
 *
 * The slice tests all need the same three things — a solid worth slicing, a
 * real profile config, and the shipped WASM engine — and they had started
 * copying them. This is that shared ground, kept deliberately small: callers
 * describe what they want to change about a canonical project and get bytes the
 * engine will accept.
 *
 * It exists because an archive assertion proves the file and not the feature.
 * Every claim about what reaches the print has to be put to the engine, and
 * that should cost one function call rather than sixty lines.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { contentDigest } from '../assets';
import { cloneProjectState, projectFingerprint } from '../domain/canonical';
import { emptyFacetAnnotations } from '../domain/model';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import { createProjectFixture } from './fixtures';
import type { FacetAnnotations, ProjectState } from '../domain/model';
import type { ProjectArchiveSnapshot } from '..';

export const CUBE_MM = 20;

/**
 * Triangle indices of the cube's faces, in the order {@link cubeMesh} emits
 * them, so a test can paint "the wall at y = 0" instead of guessing at numbers.
 */
export const CUBE_FACES = Object.freeze({
  bottom: Object.freeze([0, 1]),
  top: Object.freeze([2, 3]),
  frontY0: Object.freeze([4, 5]),
  rightX: Object.freeze([6, 7]),
  backY: Object.freeze([8, 9]),
  leftX: Object.freeze([10, 11]),
});

/**
 * A closed axis-aligned cube as the indexed float32 mesh the archive stores.
 *
 * `liftMm` raises it off the bed, which is the cheapest honest overhang: the
 * whole underside then needs support, where an unlifted cube needs none at all
 * and would make any support test a measurement of nothing.
 */
export function cubeMesh(liftMm = 0): { bytes: Uint8Array; triangleCount: number } {
  const p: [number, number, number][] = [
    [0, 0, 0],
    [CUBE_MM, 0, 0],
    [CUBE_MM, CUBE_MM, 0],
    [0, CUBE_MM, 0],
    [0, 0, CUBE_MM],
    [CUBE_MM, 0, CUBE_MM],
    [CUBE_MM, CUBE_MM, CUBE_MM],
    [0, CUBE_MM, CUBE_MM],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const vertices = faces.flat().map((index) => p[index]);
  const bytes = new Uint8Array(vertices.length * 12);
  const view = new DataView(bytes.buffer);
  vertices.forEach((vertex, vertexIndex) => {
    vertex.forEach((coordinate, component) => {
      view.setFloat32(vertexIndex * 12 + component * 4, component === 2 ? coordinate + liftMm : coordinate, true);
    });
  });
  return { bytes, triangleCount: faces.length };
}

/**
 * A cantilever: a base on the bed and an arm jutting out above it.
 *
 * This is the shape a support test actually needs. A lifted cube is not an
 * overhang, it is a floating object, and the engine rightly refuses to slice
 * one; a plain cube has no overhang at all. Here the base holds the part down
 * and the arm's underside has nothing beneath it, so support is meaningful and
 * optional — which is what makes painting it observable.
 */
export function cantileverMesh(): { bytes: Uint8Array; triangleCount: number; armBottom: readonly number[] } {
  const boxes: [number, number, number, number, number, number][] = [
    [0, 0, 0, CUBE_MM, CUBE_MM, CUBE_MM / 2],
    [CUBE_MM, 0, CUBE_MM / 2, CUBE_MM * 2, CUBE_MM, CUBE_MM],
  ];
  const vertices: [number, number, number][] = [];
  boxes.forEach(([x0, y0, z0, x1, y1, z1]) => {
    const p: [number, number, number][] = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    for (const face of [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ]) {
      for (const index of face) vertices.push(p[index]);
    }
  });
  const bytes = new Uint8Array(vertices.length * 12);
  const view = new DataView(bytes.buffer);
  vertices.forEach((vertex, vertexIndex) => {
    vertex.forEach((coordinate, component) => {
      view.setFloat32(vertexIndex * 12 + component * 4, coordinate, true);
    });
  });
  // The arm is the second box, and its bottom is that box's first two faces.
  return { bytes, triangleCount: vertices.length / 3, armBottom: Object.freeze([12, 13]) };
}

/** A real catalog profile's flattened config, so the slice is a real slice. */
export async function baseSliceConfig(): Promise<Record<string, string>> {
  const raw = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../../public/profiles/catalog.json'), 'utf8'),
  ) as unknown;
  const catalog = ProfileCatalog.fromRaw(raw);
  const profile = catalog.find('Snapmaker U1 (0.4 nozzle)', '', '') ?? catalog.profiles[0];
  assert.ok(profile, 'the bundled catalog offers a profile to slice with');
  return { ...profile.config };
}

export interface SliceArchiveOptions {
  /** Keys layered onto the project config. */
  readonly config?: Record<string, string>;
  readonly plateConfig?: Record<string, unknown>;
  readonly objectConfig?: Record<string, unknown>;
  readonly partConfig?: Record<string, unknown>;
  /** Replaces the volume's facet annotations wholesale. */
  readonly annotations?: (empty: FacetAnnotations) => FacetAnnotations;
  /** Raise the solid off the bed. Rarely what a test wants — see {@link cantileverMesh}. */
  readonly liftMm?: number;
  /** Slice a cantilever instead of a cube, for anything about overhangs. */
  readonly cantilever?: boolean;
  /** Applied last, for anything the options above do not name. */
  readonly mutate?: (state: ProjectState) => void;
}

/**
 * The shared fixture with its triangle swapped for a cube and its config taken
 * from a real profile. Starting from the fixture is what keeps this a valid
 * canonical state rather than a hand-built approximation of one.
 */
export async function buildSliceArchive(options: SliceArchiveOptions = {}): Promise<Uint8Array> {
  const fixture = createProjectFixture();
  const mesh = options.cantilever ? cantileverMesh() : cubeMesh(options.liftMm ?? 0);
  const descriptor = {
    ...fixture.asset.descriptor,
    digest: contentDigest(mesh.bytes),
    byteLength: mesh.bytes.byteLength,
    sourceFilename: 'cube.stl',
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: mesh.bytes.byteLength,
        componentType: 'float32',
        componentCount: 3,
        count: mesh.triangleCount * 3,
      },
      triangleCount: mesh.triangleCount,
    },
  } as typeof fixture.asset.descriptor;

  const config = { ...(await baseSliceConfig()), ...(options.config ?? {}) };
  const state = cloneProjectState(fixture.state);
  state.config = config as never;
  state.sourceAssets = [descriptor];
  for (const plate of state.plates) {
    plate.config = (options.plateConfig ?? {}) as never;
    for (const object of plate.objects) {
      object.config = (options.objectConfig ?? {}) as never;
      object.layerRanges = [];
      for (const volume of object.volumes) {
        volume.source = { assetId: descriptor.id, topologyRevision: 0, triangleCount: mesh.triangleCount };
        volume.config = (options.partConfig ?? {}) as never;
        volume.annotations = options.annotations
          ? options.annotations(emptyFacetAnnotations(0))
          : emptyFacetAnnotations(0);
      }
    }
  }
  options.mutate?.(state);

  const snapshot: ProjectArchiveSnapshot = {
    state,
    assets: [{ descriptor, bytes: mesh.bytes }],
    sourceRevision: 1,
    sourceHash: projectFingerprint(state),
  };
  return (await new Bbs3mfProjectSerializer().serialize(snapshot)).bytes;
}

/** Slice one archive through the shipped engine and return its G-code. */
export async function sliceArchive(
  archive: Uint8Array,
  label: string,
  overrides: Record<string, string> = {},
): Promise<string> {
  const createEngine = (await import('../../../public/slicer/slic3r.mjs')).default;
  const engine = await createEngine();
  engine.FS.writeFile(`/tmp/${label}.3mf`, archive);
  const output = engine.sliceProjectSync(`/tmp/${label}.3mf`, 1, JSON.stringify(overrides));
  if (output.startsWith('ORCAXR_ERROR:')) throw new Error(output.slice('ORCAXR_ERROR:'.length).trim());
  return output;
}

/** The engine's own filament total — the honest measure of "more material". */
export function filamentUsedMm(gcode: string): number {
  const match = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcode);
  assert.ok(match, 'the engine reports its own filament total');
  return Number.parseFloat(match[1]);
}
