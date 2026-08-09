import assert from 'node:assert/strict';

import type { FacetSelectionMesh } from '../../annotations';
import { InMemoryAssetRepository } from '../../assets';
import { canonicalStringify } from '../../domain/canonical';
import { entityId, seededRandom, UuidIdSource } from '../../domain/ids';
import { createEmptyProject, emptyFacetAnnotations, identityTransform, type Vec3 } from '../../domain/model';
import { CommandBus } from '../../history/commandBus';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { SelectionStore } from '../../selection';
import { ProjectStore } from '../../store';
import { ReplaceVolumeMeshCommand } from '../topologyCommands';
import {
  DEFAULT_SIMPLIFY_CONFIGURATION,
  PINNED_SIMPLIFY_SOURCE,
  SIMPLIFY_DEFAULT_DECIMATE_RATIO,
  SIMPLIFY_DEFAULT_MAX_ERROR,
  SimplifyError,
  simplifyMesh,
  wantedTriangleCount,
} from '../simplify';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A UV sphere: dense, closed, and with a known bounding radius. */
function sphere(segments: number, rings: number, radius: number): FacetSelectionMesh {
  const vertices: Vec3[] = [[0, 0, radius]];
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (Math.PI * ring) / rings;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (2 * Math.PI * segment) / segments;
      vertices.push([
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      ]);
    }
  }
  vertices.push([0, 0, -radius]);
  const south = vertices.length - 1;
  const at = (ring: number, segment: number): number => 1 + (ring - 1) * segments + (segment % segments);
  const triangles: [number, number, number][] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    triangles.push([0, at(1, segment), at(1, segment + 1)]);
  }
  for (let ring = 1; ring < rings - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      triangles.push([at(ring, segment), at(ring + 1, segment), at(ring + 1, segment + 1)]);
      triangles.push([at(ring, segment), at(ring + 1, segment + 1), at(ring, segment + 1)]);
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    triangles.push([south, at(rings - 1, segment + 1), at(rings - 1, segment)]);
  }
  return Object.freeze({ vertices: Object.freeze(vertices), triangles: Object.freeze(triangles) });
}

/** A 10 mm cube: already minimal, so a decimator must not wreck it. */
function cube(side = 10): FacetSelectionMesh {
  const s = side;
  return Object.freeze({
    vertices: Object.freeze([
      [0, 0, 0],
      [s, 0, 0],
      [s, s, 0],
      [0, s, 0],
      [0, 0, s],
      [s, 0, s],
      [s, s, s],
      [0, s, s],
    ] as Vec3[]),
    triangles: Object.freeze([
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [3, 7, 6],
      [3, 6, 2],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ] as [number, number, number][]),
  });
}

function boundingRadius(vertices: readonly Vec3[]): number {
  let maximum = 0;
  for (const vertex of vertices) maximum = Math.max(maximum, Math.hypot(vertex[0], vertex[1], vertex[2]));
  return maximum;
}

test('pins the upstream configuration defaults and ratio maths', () => {
  assert.equal(PINNED_SIMPLIFY_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.equal(SIMPLIFY_DEFAULT_DECIMATE_RATIO, 50);
  assert.equal(SIMPLIFY_DEFAULT_MAX_ERROR, 1);
  assert.deepEqual(DEFAULT_SIMPLIFY_CONFIGURATION, { useCount: true, decimateRatio: 50, maxError: 1 });

  // Pinned `fix_count_by_ratio`, including both saturating ends.
  assert.equal(wantedTriangleCount(1000, 0), 1000);
  assert.equal(wantedTriangleCount(1000, -5), 1000);
  assert.equal(wantedTriangleCount(1000, 100), 0);
  assert.equal(wantedTriangleCount(1000, 250), 0);
  assert.equal(wantedTriangleCount(1000, 50), 500);
  assert.equal(wantedTriangleCount(999, 50), 500, 'the pinned formula rounds');
  assert.equal(wantedTriangleCount(7, 30), 5);
});

test('a count-driven run reaches the requested budget and keeps the shape', () => {
  const source = sphere(24, 12, 10);
  const before = source.triangles.length;
  const result = simplifyMesh(source, { useCount: true, decimateRatio: 50, maxError: 1 });

  assert.equal(result.sourceTriangleCount, before);
  assert.ok(result.triangles.length <= wantedTriangleCount(before, 50), 'the budget is respected');
  assert.ok(result.triangles.length > 0);
  assert.equal(result.stoppedOnError, false, 'a count-driven run is not limited by error');
  // A decimated sphere is still a sphere of about the same size.
  assert.ok(Math.abs(boundingRadius(result.vertices) - 10) < 0.75);

  // Every surviving triangle indexes a real, distinct vertex.
  for (const triangle of result.triangles) {
    assert.equal(new Set(triangle).size, 3, 'no degenerate triangle survives');
    for (const vertex of triangle) {
      assert.ok(vertex >= 0 && vertex < result.vertices.length);
    }
  }
  assert.ok(result.vertices.length < source.vertices.length, 'vertices are compacted too');
});

test('the same input decimates identically every time', () => {
  const source = sphere(16, 8, 6);
  const first = simplifyMesh(source, { useCount: true, decimateRatio: 60, maxError: 1 });
  const second = simplifyMesh(source, { useCount: true, decimateRatio: 60, maxError: 1 });
  assert.deepEqual(second.triangles, first.triangles);
  assert.deepEqual(second.vertices, first.vertices);
});

test('an error-driven run stops at the threshold instead of a count', () => {
  const source = sphere(20, 10, 8);
  const tight = simplifyMesh(source, { useCount: false, decimateRatio: 50, maxError: 1e-6 });
  assert.equal(tight.triangles.length, source.triangles.length, 'a tiny budget removes nothing');
  assert.equal(tight.stoppedOnError, true);
  assert.equal(tight.maxAppliedError, 0);

  const loose = simplifyMesh(source, { useCount: false, decimateRatio: 50, maxError: 1 });
  assert.ok(loose.triangles.length < source.triangles.length, 'a real budget removes something');
  assert.ok(loose.maxAppliedError < 1, 'no collapse above the threshold is ever applied');
});

test('asking for at least the current count changes nothing at all', () => {
  const source = cube(10);
  const untouched = simplifyMesh(source, { useCount: true, decimateRatio: 0, maxError: 1 });
  assert.deepEqual(untouched.triangles, source.triangles);
  assert.deepEqual(untouched.vertices, source.vertices);
  assert.equal(untouched.maxAppliedError, 0);
  assert.equal(untouched.stoppedOnError, false);
});

test('the source mesh is never mutated', () => {
  const source = sphere(12, 6, 4);
  const vertexSnapshot = JSON.stringify(source.vertices);
  const triangleSnapshot = JSON.stringify(source.triangles);
  simplifyMesh(source, { useCount: true, decimateRatio: 70, maxError: 1 });
  assert.equal(JSON.stringify(source.vertices), vertexSnapshot);
  assert.equal(JSON.stringify(source.triangles), triangleSnapshot);
});

test('progress is reported and cancellation stops the run without a result', () => {
  const source = sphere(24, 12, 10);
  const percents: number[] = [];
  simplifyMesh(
    source,
    { useCount: true, decimateRatio: 80, maxError: 1 },
    { onProgress: (percent) => percents.push(percent) },
  );
  assert.ok(percents.length > 0, 'progress is reported');
  assert.equal(percents[percents.length - 1], 100, 'the run finishes at 100');
  assert.ok(percents.every((percent) => percent >= 0 && percent <= 100));

  assert.throws(
    () => simplifyMesh(source, { useCount: true, decimateRatio: 80, maxError: 1 }, { isCancelled: () => true }),
    (error: unknown) => error instanceof SimplifyError && error.code === 'cancelled',
  );
});

test('degenerate meshes and impossible settings fail closed', () => {
  assert.throws(
    () => simplifyMesh({ vertices: [], triangles: [] }),
    (error: unknown) => error instanceof SimplifyError && error.code === 'degenerate-mesh',
  );
  assert.throws(
    () => simplifyMesh(cube(10), { useCount: false, decimateRatio: 50, maxError: 0 }),
    (error: unknown) => error instanceof SimplifyError && error.code === 'invalid-configuration',
    'a non-positive maximum error decimates nothing upstream, so it is refused here',
  );
  assert.throws(
    () => simplifyMesh(cube(10), { useCount: true, decimateRatio: Number.NaN, maxError: 1 }),
    (error: unknown) => error instanceof SimplifyError && error.code === 'invalid-configuration',
  );
  // Asking for everything to go leaves nothing to install, which is refused.
  assert.throws(
    () => simplifyMesh(cube(10), { useCount: true, decimateRatio: 100, maxError: 1 }),
    (error: unknown) => error instanceof SimplifyError && error.code === 'degenerate-mesh',
  );
});

test('a decimated result installs through the guarded topology command as one entry', () => {
  const fixtureMesh = sphere(16, 8, 6);
  const asset = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:simplify-src'),
    positions: fixtureMesh.vertices.flatMap((vertex) => [...vertex]),
    indices: fixtureMesh.triangles.flatMap((triangle) => [...triangle]),
    sourceFilename: 'sphere.stl',
  });
  const ids = new UuidIdSource(seededRandom(0x5117));
  const state = createEmptyProject({ idSource: ids, now: '2026-08-09T00:00:00.000Z', toolCount: 1 });
  const volumeId = ids.next('volume');
  state.sourceAssets.push(asset.descriptor);
  state.plates[0].objects.push({
    id: ids.next('object'),
    name: 'Sphere',
    config: {},
    volumes: [
      {
        id: volumeId,
        name: 'Body',
        role: 'model',
        source: {
          assetId: asset.descriptor.id,
          topologyRevision: 0,
          triangleCount: fixtureMesh.triangles.length,
        },
        transform: identityTransform(),
        config: {},
        annotations: {
          ...emptyFacetAnnotations(),
          support: [{ triangles: [0, 1], value: 'enforce' }],
        },
      },
    ],
    instances: [{ id: ids.next('instance'), transform: identityTransform(), printable: true }],
    layerRanges: [],
  });

  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection: new SelectionStore(), assets });
  commands.markCheckpoint();
  const before = canonicalStringify(project.getSnapshot().state as never);
  const undoBefore = commands.getHistorySnapshot().undoCount;

  const guard = {
    volumeId,
    assetId: asset.descriptor.id,
    assetDigest: asset.descriptor.digest,
    topologyRevision: 0,
    triangleCount: fixtureMesh.triangles.length,
  };
  const simplified = simplifyMesh(fixtureMesh, { useCount: true, decimateRatio: 50, maxError: 1 });
  const replacement = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:simplify-out'),
    positions: simplified.vertices.flatMap((vertex) => [...vertex]),
    indices: simplified.triangles.flatMap((triangle) => [...triangle]),
    sourceFilename: 'sphere.stl',
  });
  commands.execute(new ReplaceVolumeMeshCommand(guard, replacement));

  const after = project.getSnapshot().state.plates[0].objects[0].volumes[0];
  assert.equal(after.source.triangleCount, simplified.triangles.length);
  assert.equal(after.source.topologyRevision, 1, 'topology revision advances');
  assert.deepEqual(after.annotations.support, [], 'triangle-indexed painting is invalidated');
  assert.equal(commands.getHistorySnapshot().undoCount, undoBefore + 1, 'the whole change is one entry');

  assert.equal(commands.undo(), true);
  assert.equal(
    canonicalStringify(project.getSnapshot().state as never),
    before,
    'undo restores the exact mesh and its painting',
  );
});

console.log(`\nCanonical simplification: ${passed} tests passed.`);
