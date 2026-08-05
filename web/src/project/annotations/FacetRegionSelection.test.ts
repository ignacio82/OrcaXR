import assert from 'node:assert/strict';
import type { FilamentId } from '../domain/ids';
import type { FacetAnnotations, Vec3 } from '../domain/model';
import {
  ORCA_BRUSH_RADIUS_MAX_MM,
  ORCA_BRUSH_RADIUS_MIN_MM,
  ORCA_GAP_AREA_MAX_MM2,
  ORCA_GAP_AREA_MIN_MM2,
  ORCA_GAP_AREA_STEP_MM2,
  ORCA_HEIGHT_RANGE_MAX_MM,
  ORCA_HEIGHT_RANGE_MIN_MM,
  ORCA_OVERHANG_ANGLE_MAX_DEGREES,
  ORCA_OVERHANG_ANGLE_MIN_DEGREES,
  ORCA_REFINEMENT_ENCODING_VERSION,
  ORCA_TRIANGLE_SELECTOR_EPSILON,
  applyFacetRefinedSelection,
  applyFacetRefinedStateUpdates,
  buildOrcaFaceNeighbors,
  constrainPainterDragPoint,
  selectFacetRegion,
  type FacetRefinementEncoding,
  type FacetRefinementNode,
  type FacetRegionTool,
  type FacetSelectionMesh,
  type FacetSelectionTransform,
} from './FacetRegionSelection';
import { FacetAnnotationValidationError, StaleFacetAnnotationResultError } from './types';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const FILAMENT_A = 'import:test:filament-a' as FilamentId;
const FILAMENT_B = 'import:test:filament-b' as FilamentId;
const FILAMENT_C = 'import:test:filament-c' as FilamentId;

function annotations(triangleCount: number, topologyRevision = 7): FacetAnnotations {
  void triangleCount;
  return {
    topologyRevision,
    color: [],
    support: [],
    seam: [],
    fuzzySkin: [],
    brim: [],
  };
}

function unpaintedLeaf(): FacetRefinementNode {
  return { kind: 'leaf', state: { kind: 'unpainted' } };
}

function assignedLeaf(value: FilamentId): FacetRefinementNode {
  return { kind: 'leaf', state: { kind: 'assigned', value } };
}

function refinement(roots: readonly FacetRefinementNode[]): FacetRefinementEncoding {
  return {
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots,
  };
}

function stripMesh(): FacetSelectionMesh {
  return {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
      [3, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
      [1, 4, 3],
      [4, 5, 3],
      [5, 6, 3],
    ],
  };
}

function gapStripMesh(): FacetSelectionMesh {
  return {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
      [3, 0, 0],
      [3, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
      [1, 4, 3],
      [4, 5, 3],
      [4, 6, 5],
      [6, 7, 5],
    ],
  };
}

function request(
  mesh: FacetSelectionMesh,
  current: FacetAnnotations,
  overrides: Partial<Parameters<typeof selectFacetRegion<'color'>>[0]> = {},
): Parameters<typeof selectFacetRegion<'color'>>[0] {
  return {
    mesh,
    annotations: current,
    channel: 'color',
    guard: {
      topologyRevision: current.topologyRevision,
      triangleCount: mesh.triangles.length,
    },
    seedTriangle: 0,
    tool: { kind: 'fill', edgeDetection: false },
    ...overrides,
  };
}

function assertValidationIssue(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof FacetAnnotationValidationError && error.issues.some((issue) => issue.code === code),
  );
}

test('builds pinned oriented-index adjacency and pairs non-manifold edges deterministically', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, -1, 0],
      [0, 0, 0],
      [1, 0, 0],
      [0, -1, 0],
      [3, 0, 0],
      [4, 0, 0],
      [3, 1, 0],
      [4, 1, 0],
    ],
    triangles: [
      [0, 1, 2], // edge 0 -> 1 pairs the first reverse-wound face below
      [1, 0, 3],
      [1, 0, 4], // same non-manifold edge remains open
      [8, 9, 10],
      [8, 9, 11], // same-wound edge does not connect
      [6, 5, 7], // equal coordinates with different indices do not connect
    ],
  };

  const neighbors = buildOrcaFaceNeighbors(mesh);
  assert.deepEqual(neighbors, [
    [1, -1, -1],
    [0, -1, -1],
    [-1, -1, -1],
    [-1, -1, -1],
    [-1, -1, -1],
    [-1, -1, -1],
  ]);
  assert.equal(Object.isFrozen(neighbors), true);
  assert.equal(Object.isFrozen(neighbors[0]), true);
});

test('Triangle selects exactly one unsplit source face and returns commit-ready ranges', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  const result = selectFacetRegion(
    request(mesh, current, {
      seedTriangle: 3,
      tool: { kind: 'triangle' },
    }),
  );

  assert.deepEqual(result, {
    triangleIndices: [3],
    ranges: [{ start: 3, endExclusive: 4 }],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.triangleIndices), true);
  assert.equal(Object.isFrozen(result.ranges[0]), true);
});

test('Fill crosses only edge-connected faces with the seed facet state, including unpainted', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  current.color = [
    { value: FILAMENT_A, triangles: [2, 3] },
    { value: FILAMENT_B, triangles: [4] },
  ];

  assert.deepEqual(selectFacetRegion(request(mesh, current)).triangleIndices, [0, 1]);
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: 2,
      }),
    ),
    {
      triangleIndices: [2, 3],
      ranges: [{ start: 2, endExclusive: 4 }],
    },
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: 4,
      }),
    ).triangleIndices,
    [4],
  );
});

test('Fill applies the angle between each adjacent pair and the pinned 1e-4 threshold tolerance', () => {
  const angleDegrees = 30;
  const radians = (angleDegrees * Math.PI) / 180;
  const vertices: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, -Math.cos(radians), Math.sin(radians)],
  ];
  const mesh: FacetSelectionMesh = {
    vertices,
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
  };
  const current = annotations(mesh.triangles.length);

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 29.99 },
        },
      }),
    ).triangleIndices,
    [0, 1],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 29.98 },
        },
      }),
    ).triangleIndices,
    [0],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: { kind: 'fill', edgeDetection: false },
      }),
    ).triangleIndices,
    [0, 1],
  );
});

test('Fill preserves the pinned normal clamp at 90 degrees and degenerate-normal behavior', () => {
  const oppositeMesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
  };
  const oppositeAnnotations = annotations(oppositeMesh.triangles.length);
  assert.deepEqual(
    selectFacetRegion(
      request(oppositeMesh, oppositeAnnotations, {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 90 },
        },
      }),
    ).triangleIndices,
    [0, 1],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(oppositeMesh, oppositeAnnotations, {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 89.99 },
        },
      }),
    ).triangleIndices,
    [0],
  );

  const degenerateMesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [2, 0, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
  };
  assert.deepEqual(
    selectFacetRegion(
      request(degenerateMesh, annotations(degenerateMesh.triangles.length), {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 0 },
        },
      }),
    ).triangleIndices,
    [0, 1],
  );
});

test('Fill compares adjacent normals rather than every face against the seed normal', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0.9698463103929542, 0.9698463103929542, -0.24184476264797522],
      [1.828641640789276, -0.11105097999663248, -0.5486535436792914],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
      [1, 4, 3],
    ],
  };
  const current = annotations(mesh.triangles.length);

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: {
          kind: 'fill',
          edgeDetection: { maxAdjacentAngleDegrees: 25 },
        },
      }),
    ).triangleIndices,
    [0, 1, 2],
  );
});

test('clipping rejects a neighbor when any vertex is above the plane but never drops the seed', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  const clippingPlane = { normal: [1, 0, 0] as Vec3, offset: 1.5 };

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        clippingPlane,
      }),
    ).triangleIndices,
    [0, 1],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: 2,
        clippingPlane,
      }),
    ).triangleIndices,
    [0, 1, 2],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        clippingPlane: { normal: [1, 0, 0], offset: 2 },
      }),
    ).triangleIndices,
    [0, 1, 2, 3],
  );
});

test('Circle uses a screen-facing projected radius while Sphere uses a true 3D radius', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0.25, 0.05, -2],
      [0.35, 0.05, -2],
      [0.3, 0.15, -2],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const geometry = {
    center: [0, 0, 0] as Vec3,
    cameraPosition: [0, 0, 2] as Vec3,
    radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
  };

  assert.deepEqual(
    selectFacetRegion(request(mesh, current, { tool: { kind: 'circle', ...geometry } })).triangleIndices,
    [0],
  );
  assert.deepEqual(selectFacetRegion(request(mesh, current, { tool: { kind: 'sphere', ...geometry } })), {
    triangleIndices: [],
    ranges: [],
  });
});

test('Sphere includes an edge endpoint exactly on its radius while Circle keeps its strict projected boundary', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0.4, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const geometry = {
    center: [0, 0, 0] as Vec3,
    cameraPosition: [0, 0, 2] as Vec3,
    radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
  };

  assert.deepEqual(
    selectFacetRegion(request(mesh, current, { tool: { kind: 'circle', ...geometry } })).triangleIndices,
    [],
  );
  assert.deepEqual(
    selectFacetRegion(request(mesh, current, { tool: { kind: 'sphere', ...geometry } })).triangleIndices,
    [0],
  );
});

test('dragged Circle and Sphere select the swept middle that either single-point cursor misses', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [-0.1, -0.1, 0],
      [0.1, -0.1, 0],
      [0, 0.1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);

  for (const kind of ['circle', 'sphere'] as const) {
    const single = {
      kind,
      center: [1, 0, 0],
      cameraPosition: [-1, 0, 2],
      radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
    } satisfies Extract<FacetRegionTool, { kind: 'circle' | 'sphere' }>;
    assert.deepEqual(selectFacetRegion(request(mesh, current, { tool: single })).triangleIndices, []);
    assert.deepEqual(
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            ...single,
            previousCenter: [-1, 0, 0],
          },
        }),
      ).triangleIndices,
      [0],
    );
  }
});

test('swept Capsule2D and Capsule3D preserve edge-intersection clipping bypass', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [-0.5, 1, 0],
      [0.5, 1, 0],
      [0, -1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const clippingPlane = { normal: [0, 0, 1] as Vec3, offset: -1 };

  for (const kind of ['circle', 'sphere'] as const) {
    assert.deepEqual(
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind,
            previousCenter: [-2, 0, 0],
            center: [2, 0, 0],
            cameraPosition: [-2, 0, 2],
            radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
          },
          clippingPlane,
        }),
      ).triangleIndices,
      [0],
    );
  }
});

test('swept Capsule2D and Capsule3D include their pinned lateral body boundary', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0.4, 0],
      [0.1, 0.4, 0],
      [0, 0.4, 0.1],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);

  for (const kind of ['circle', 'sphere'] as const) {
    assert.deepEqual(
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind,
            previousCenter: [-1, 0, 0],
            center: [1, 0, 0],
            cameraPosition: [-1, 0, 2],
            radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
          },
        }),
      ).triangleIndices,
      [0],
    );
  }
});

test('swept Circle and Sphere measure the whole segment in non-uniformly transformed world millimetres', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0.3, 0],
      [0.1, 0.3, 0],
      [0, 0.3, 0.1],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const transform: FacetSelectionTransform = {
    linear: [
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 1],
    ],
    translation: [10, -4, 3],
    scalingFactors: [1, 2, 1],
  };

  for (const kind of ['circle', 'sphere'] as const) {
    const tool: FacetRegionTool = {
      kind,
      previousCenter: [-1, 0, 0],
      center: [1, 0, 0],
      cameraPosition: [-1, 0, 2],
      radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
    };
    assert.deepEqual(selectFacetRegion(request(mesh, current, { tool })).triangleIndices, [0]);
    assert.deepEqual(selectFacetRegion(request(mesh, current, { tool, transform })).triangleIndices, []);
  }
});

test('Circle propagates only through front-facing facets while Sphere crosses either winding and stays connected', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
      [4, 5, 6],
    ],
  };
  const current = annotations(mesh.triangles.length);
  const geometry = {
    center: [0.2, 0.2, 0] as Vec3,
    cameraPosition: [0.2, 0.2, 2] as Vec3,
    radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
  };

  assert.deepEqual(
    selectFacetRegion(request(mesh, current, { tool: { kind: 'circle', ...geometry } })).triangleIndices,
    [0],
  );
  assert.deepEqual(
    selectFacetRegion(request(mesh, current, { tool: { kind: 'sphere', ...geometry } })).triangleIndices,
    [0, 1],
  );
});

test('the pinned ray-through-triangle test selects a whole source facet even when radius and clipping contain no vertex', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [-5, -5, 0],
      [5, -5, 0],
      [0, 5, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const result = selectFacetRegion(
    request(mesh, current, {
      tool: {
        kind: 'sphere',
        center: [0, 0, 0],
        cameraPosition: [0, 0, 2],
        radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
      },
      clippingPlane: { normal: [0, 0, 1], offset: -1 },
    }),
  );

  assert.deepEqual(result, {
    triangleIndices: [0],
    ranges: [{ start: 0, endExclusive: 1 }],
  });
});

test('brush edge intersection preserves the pinned clipping bypass for unsplit source facets', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const clippingPlane = { normal: [1, 0, 0] as Vec3, offset: -1 };

  for (const kind of ['circle', 'sphere'] as const) {
    assert.deepEqual(
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind,
            center: [0.2, 0.2, 0],
            cameraPosition: [0.2, 0.2, 2],
            radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
          },
          clippingPlane,
        }),
      ).triangleIndices,
      [0],
    );
  }
});

test('Circle and Sphere measure a non-uniformly transformed mesh in world millimetres', () => {
  const transform: FacetSelectionTransform = {
    linear: [
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [10, -4, 3],
    scalingFactors: [2, 1, 1],
  };
  const xOffsetMesh: FacetSelectionMesh = {
    vertices: [
      [0.25, 0.05, 0],
      [0.35, 0.05, 0],
      [0.3, 0.15, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const yOffsetMesh: FacetSelectionMesh = {
    vertices: [
      [0.05, 0.25, 0],
      [0.05, 0.35, 0],
      [0.15, 0.3, 0],
    ],
    triangles: [[0, 1, 2]],
  };

  for (const kind of ['circle', 'sphere'] as const) {
    const tool: FacetRegionTool = {
      kind,
      center: [0, 0, 0],
      cameraPosition: [0, 0, 2],
      radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
    };
    assert.deepEqual(selectFacetRegion(request(xOffsetMesh, annotations(1), { tool, transform })).triangleIndices, []);
    assert.deepEqual(selectFacetRegion(request(yOffsetMesh, annotations(1), { tool, transform })).triangleIndices, [0]);
  }
});

test('uniform scaling keeps brush math volume-local and converts the world radius exactly once', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0.25, 0.05, 0],
      [0.35, 0.05, 0],
      [0.3, 0.15, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const tool: FacetRegionTool = {
    kind: 'sphere',
    center: [0, 0, 0],
    cameraPosition: [0, 0, 2],
    radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
  };
  const transform: FacetSelectionTransform = {
    linear: [
      [2, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
    ],
    translation: [100, -50, 20],
    scalingFactors: [2, 2, 2],
  };

  assert.deepEqual(selectFacetRegion(request(mesh, current, { tool })).triangleIndices, [0]);
  assert.deepEqual(selectFacetRegion(request(mesh, current, { tool, transform })).triangleIndices, []);
});

test('Circle transforms neighbor normals by inverse transpose under non-uniform scale', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [1.5, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
  };
  const transform: FacetSelectionTransform = {
    linear: [
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
    scalingFactors: [2, 1, 1],
  };

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, annotations(2), {
        tool: {
          kind: 'circle',
          center: [0, 0, 0.5],
          cameraPosition: [-1, -1, 0.5],
          radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
        },
        transform,
      }),
    ).triangleIndices,
    [0, 1],
  );
});

test('overhang-only brush filtering uses the strict pinned angle and translation-free inverse transpose', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 1],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  const tool: FacetRegionTool = {
    kind: 'sphere',
    center: [0.2, 0.2, 0.2],
    cameraPosition: [0.2, 0.2, 2],
    radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
  };
  const transform: FacetSelectionTransform = {
    linear: [
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [100, -50, 20],
    scalingFactors: [2, 1, 1],
  };
  const strictBoundaryAngle = Math.fround(44.999996185302734);

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool,
        highlightByAngleDegrees: 0,
      }),
    ).triangleIndices,
    [0],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool,
        highlightByAngleDegrees: strictBoundaryAngle,
      }),
    ).triangleIndices,
    [],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool,
        highlightByAngleDegrees: 45,
      }),
    ).triangleIndices,
    [0],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool,
        highlightByAngleDegrees: 40,
      }),
    ).triangleIndices,
    [],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool,
        transform,
        highlightByAngleDegrees: 40,
      }),
    ).triangleIndices,
    [0],
  );
});

test('Height Range scans every source facet in transformed plate/world Z and ignores seed connectivity and clipping', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0.4, 0, 0],
      [0.4, 1, 0],
      [0.4, 0, 1],
      [0.5, 0, 0],
      [0.5, 1, 0],
      [0.5, 0, 1],
      [0.6, 0, 0],
      [0.6, 1, 0],
      [0.6, 0, 1],
    ],
    triangles: [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
  };
  const transform: FacetSelectionTransform = {
    linear: [
      [0, 0, 1],
      [0, 1, 0],
      [2, 0, 0],
    ],
    translation: [3, -2, 10],
    scalingFactors: [2, 1, 1],
  };

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, annotations(3), {
        seedTriangle: 0,
        tool: { kind: 'heightRange', startZMm: 11, heightMm: ORCA_HEIGHT_RANGE_MIN_MM },
        transform,
        clippingPlane: { normal: [1, 0, 0], offset: -1 },
      }),
    ),
    {
      triangleIndices: [1],
      ranges: [{ start: 1, endExclusive: 2 }],
    },
  );
});

test('Height Range applies overhang-only filtering globally while Triangle and Fill ignore that brush-only gate', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [2, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  const current = annotations(2);

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: {
          kind: 'heightRange',
          startZMm: 0,
          heightMm: ORCA_HEIGHT_RANGE_MIN_MM,
        },
        highlightByAngleDegrees: 45,
      }),
    ).triangleIndices,
    [0],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: 1,
        tool: { kind: 'triangle' },
        highlightByAngleDegrees: 45,
      }),
    ).triangleIndices,
    [1],
  );
  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: 1,
        tool: { kind: 'fill', edgeDetection: false },
        highlightByAngleDegrees: 45,
      }),
    ).triangleIndices,
    [1],
  );
});

test('Height Range includes facets exactly on its epsilon-expanded bounds and excludes facets wholly beyond them', () => {
  const start = Math.fround(1);
  const height = Math.fround(ORCA_HEIGHT_RANGE_MIN_MM);
  const bottom = Math.fround(start - ORCA_TRIANGLE_SELECTOR_EPSILON);
  const top = Math.fround(Math.fround(start + height) + ORCA_TRIANGLE_SELECTOR_EPSILON);
  const below = Math.fround(bottom - 0.0002);
  const above = Math.fround(top + 0.0002);
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, bottom],
      [1, 0, bottom],
      [0, 1, bottom],
      [0, 0, top],
      [1, 0, top],
      [0, 1, top],
      [0, 0, below],
      [1, 0, below],
      [0, 1, below],
      [0, 0, above],
      [1, 0, above],
      [0, 1, above],
    ],
    triangles: [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
    ],
  };

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, annotations(4), {
        tool: { kind: 'heightRange', startZMm: start, heightMm: height },
      }),
    ).triangleIndices,
    [0, 1],
  );
});

test('Gap Fill remaps every qualifying patch from one snapshot and ignores seed, clipping, and transforms', () => {
  const strip = gapStripMesh();
  const mesh: FacetSelectionMesh = {
    vertices: strip.vertices,
    triangles: strip.triangles.slice(0, 3),
  };
  const current = annotations(mesh.triangles.length);
  current.color = [
    { value: FILAMENT_A, triangles: [0] },
    { value: FILAMENT_B, triangles: [1] },
    { value: FILAMENT_C, triangles: [2] },
  ];

  const result = selectFacetRegion(
    request(mesh, current, {
      seedTriangle: -999,
      tool: {
        kind: 'gapFill',
        maxAreaMm2: 0.75,
        stateOrder: [FILAMENT_A, FILAMENT_B, FILAMENT_C],
      },
      clippingPlane: { normal: [0, 0, 1], offset: -1 },
      highlightByAngleDegrees: 45,
      transform: {
        linear: [
          [10, 0, 0],
          [0, 10, 0],
          [0, 0, 10],
        ],
        translation: [100, -50, 20],
        scalingFactors: [10, 10, 10],
      },
    }),
  );

  assert.deepEqual(result, {
    triangleIndices: [0, 1, 2],
    ranges: [{ start: 0, endExclusive: 3 }],
    gapFillReplacements: [
      {
        areaMm2: 0.5,
        source: { kind: 'assigned', value: FILAMENT_A },
        target: { kind: 'assigned', value: FILAMENT_B },
        triangleIndices: [0],
        ranges: [{ start: 0, endExclusive: 1 }],
      },
      {
        areaMm2: 0.5,
        source: { kind: 'assigned', value: FILAMENT_B },
        target: { kind: 'assigned', value: FILAMENT_A },
        triangleIndices: [1],
        ranges: [{ start: 1, endExclusive: 2 }],
      },
      {
        areaMm2: 0.5,
        source: { kind: 'assigned', value: FILAMENT_C },
        target: { kind: 'assigned', value: FILAMENT_B },
        triangleIndices: [2],
        ranges: [{ start: 2, endExclusive: 3 }],
      },
    ],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.gapFillReplacements), true);
  assert.equal(Object.isFrozen(result.gapFillReplacements?.[0]), true);
  assert.equal(Object.isFrozen(result.gapFillReplacements?.[0]?.source), true);
});

test('Gap Fill gives the implicit unpainted state numeric priority zero', () => {
  const strip = gapStripMesh();
  const mesh: FacetSelectionMesh = {
    vertices: strip.vertices,
    triangles: strip.triangles.slice(0, 3),
  };
  const current = annotations(mesh.triangles.length);
  current.color = [
    { value: FILAMENT_A, triangles: [1] },
    { value: FILAMENT_B, triangles: [2] },
  ];

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        tool: {
          kind: 'gapFill',
          maxAreaMm2: 0.75,
          stateOrder: [FILAMENT_A, FILAMENT_B],
        },
      }),
    ),
    {
      triangleIndices: [0, 1, 2],
      ranges: [{ start: 0, endExclusive: 3 }],
      gapFillReplacements: [
        {
          areaMm2: 0.5,
          source: { kind: 'unpainted' },
          target: { kind: 'assigned', value: FILAMENT_A },
          triangleIndices: [0],
          ranges: [{ start: 0, endExclusive: 1 }],
        },
        {
          areaMm2: 0.5,
          source: { kind: 'assigned', value: FILAMENT_A },
          target: { kind: 'unpainted' },
          triangleIndices: [1],
          ranges: [{ start: 1, endExclusive: 2 }],
        },
        {
          areaMm2: 0.5,
          source: { kind: 'assigned', value: FILAMENT_B },
          target: { kind: 'assigned', value: FILAMENT_A },
          triangleIndices: [2],
          ranges: [{ start: 2, endExclusive: 3 }],
        },
      ],
    },
  );
});

test('Gap Fill measures connected same-state patches in volume-local area and uses a strict threshold', () => {
  const mesh = gapStripMesh();
  const current = annotations(mesh.triangles.length);
  current.color = [
    { value: FILAMENT_C, triangles: [0, 1] },
    { value: FILAMENT_A, triangles: [2] },
    { value: FILAMENT_B, triangles: [3, 4, 5] },
  ];
  const transform: FacetSelectionTransform = {
    linear: [
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ],
    translation: [100, -50, 20],
    scalingFactors: [10, 10, 10],
  };
  const tool = (maxAreaMm2: number): FacetRegionTool => ({
    kind: 'gapFill',
    maxAreaMm2,
    stateOrder: [FILAMENT_B, FILAMENT_C, FILAMENT_A],
  });

  assert.deepEqual(
    selectFacetRegion(
      request(mesh, current, {
        seedTriangle: -1,
        tool: tool(0.75),
        clippingPlane: { normal: [0, 0, 1], offset: -1 },
        transform,
      }),
    ),
    {
      triangleIndices: [2],
      ranges: [{ start: 2, endExclusive: 3 }],
      gapFillReplacements: [
        {
          areaMm2: 0.5,
          source: { kind: 'assigned', value: FILAMENT_A },
          target: { kind: 'assigned', value: FILAMENT_B },
          triangleIndices: [2],
          ranges: [{ start: 2, endExclusive: 3 }],
        },
      ],
    },
  );
  assert.deepEqual(selectFacetRegion(request(mesh, current, { tool: tool(0.5) })), {
    triangleIndices: [],
    ranges: [],
    gapFillReplacements: [],
  });
  assert.deepEqual(selectFacetRegion(request(mesh, current, { tool: tool(0.5001) })).triangleIndices, [2]);
});

test('accepts exact pinned tool limits and axis filters', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [-1, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);

  for (const radiusMm of [ORCA_BRUSH_RADIUS_MIN_MM, ORCA_BRUSH_RADIUS_MAX_MM]) {
    assert.deepEqual(
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'sphere',
            center: [0, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm,
          },
        }),
      ).triangleIndices,
      [0],
    );
  }
  for (const heightMm of [ORCA_HEIGHT_RANGE_MIN_MM, ORCA_HEIGHT_RANGE_MAX_MM]) {
    assert.doesNotThrow(() =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'heightRange', startZMm: 0, heightMm },
        }),
      ),
    );
  }
  for (const maxAreaMm2 of [ORCA_GAP_AREA_MIN_MM2, ORCA_GAP_AREA_MAX_MM2]) {
    assert.doesNotThrow(() =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'gapFill', maxAreaMm2, stateOrder: [] },
        }),
      ),
    );
  }
  for (const highlightByAngleDegrees of [ORCA_OVERHANG_ANGLE_MIN_DEGREES, ORCA_OVERHANG_ANGLE_MAX_DEGREES]) {
    assert.doesNotThrow(() =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'sphere',
            center: [0, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm: ORCA_BRUSH_RADIUS_MIN_MM,
          },
          highlightByAngleDegrees,
        }),
      ),
    );
  }
  assert.equal(ORCA_GAP_AREA_STEP_MM2, 0.2);

  assert.deepEqual(constrainPainterDragPoint([2, 3], [5, 7], 'none'), [5, 7]);
  assert.deepEqual(constrainPainterDragPoint([2, 3], [5, 7], 'vertical'), [2, 7]);
  assert.deepEqual(constrainPainterDragPoint([2, 3], [5, 7], 'horizontal'), [5, 3]);
});

test('supports every annotation channel with independent state boundaries', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  current.support = [
    { value: 'enforce', triangles: [0, 1] },
    { value: 'block', triangles: [2] },
  ];
  current.seam = [{ value: 'prefer', triangles: [1] }];

  assert.deepEqual(
    selectFacetRegion({
      ...request(mesh, current),
      channel: 'support',
    }).triangleIndices,
    [0, 1],
  );
  assert.deepEqual(
    selectFacetRegion({
      ...request(mesh, current),
      channel: 'seam',
      seedTriangle: 0,
    }).triangleIndices,
    [0],
  );
});

test('fails closed on stale topology, malformed mesh/state, seed, angle, and clipping inputs', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);

  assert.throws(
    () =>
      selectFacetRegion(
        request(
          mesh,
          { ...current, topologyRevision: 8 },
          {
            guard: { topologyRevision: 7, triangleCount: mesh.triangles.length },
          },
        ),
      ),
    StaleFacetAnnotationResultError,
  );
  assert.throws(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          guard: { topologyRevision: 7, triangleCount: mesh.triangles.length + 1 },
        }),
      ),
    StaleFacetAnnotationResultError,
  );

  const duplicate = annotations(mesh.triangles.length);
  duplicate.color = [
    { value: FILAMENT_A, triangles: [1] },
    { value: FILAMENT_B, triangles: [1] },
  ];
  assert.throws(() => selectFacetRegion(request(mesh, duplicate)), FacetAnnotationValidationError);

  const invalidMesh: FacetSelectionMesh = {
    vertices: mesh.vertices,
    triangles: [[0, 1, 99]],
  };
  assert.throws(
    () =>
      selectFacetRegion(
        request(invalidMesh, annotations(1), {
          guard: { topologyRevision: 7, triangleCount: 1 },
        }),
      ),
    (error: unknown) =>
      error instanceof FacetAnnotationValidationError &&
      error.issues.some((issue) => issue.code === 'invalid-facet-mesh-triangle'),
  );
  assert.throws(
    () => selectFacetRegion(request(mesh, current, { seedTriangle: -1 })),
    (error: unknown) =>
      error instanceof FacetAnnotationValidationError &&
      error.issues.some((issue) => issue.code === 'invalid-seed-triangle'),
  );
  assert.throws(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'fill',
            edgeDetection: { maxAdjacentAngleDegrees: 90.01 },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof FacetAnnotationValidationError &&
      error.issues.some((issue) => issue.code === 'invalid-smart-fill-angle'),
  );
  assert.throws(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          clippingPlane: { normal: [Number.NaN, 0, 1], offset: 0 },
        }),
      ),
    (error: unknown) =>
      error instanceof FacetAnnotationValidationError &&
      error.issues.some((issue) => issue.code === 'invalid-facet-clipping-plane'),
  );
});

test('fails closed on brush, height, Gap Fill, transform, channel, and float32 boundary violations', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  const assertIssue = (run: () => unknown, code: string): void => {
    assert.throws(
      run,
      (error: unknown) =>
        error instanceof FacetAnnotationValidationError && error.issues.some((issue) => issue.code === code),
    );
  };
  const brush = (radiusMm: number): FacetRegionTool => ({
    kind: 'circle',
    center: [0, 0, 0],
    cameraPosition: [0, 0, 2],
    radiusMm,
  });

  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: brush(ORCA_BRUSH_RADIUS_MIN_MM - 0.001),
        }),
      ),
    'invalid-brush-radius',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: brush(ORCA_BRUSH_RADIUS_MAX_MM + 0.001),
        }),
      ),
    'invalid-brush-radius',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'sphere',
            center: [0, 0, 0],
            cameraPosition: [0, 0, 0],
            radiusMm: 1,
          },
        }),
      ),
    'invalid-brush-direction',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'circle',
            center: [Number.NaN, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm: 1,
          },
        }),
      ),
    'invalid-brush-position',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'sphere',
            previousCenter: [Number.NaN, 0, 0],
            center: [1, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm: 1,
          },
        }),
      ),
    'invalid-brush-position',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'sphere',
            previousCenter: [0, 0, 0],
            center: [0, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm: 1,
          },
        }),
      ),
    'invalid-brush-sweep',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'circle',
            previousCenter: [0, 0, 2],
            center: [1, 0, 0],
            cameraPosition: [0, 0, 2],
            radiusMm: 1,
          },
        }),
      ),
    'invalid-brush-direction',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: brush(1),
          transform: {
            linear: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            translation: [0, 0, 0],
            scalingFactors: [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE],
          },
        }),
      ),
    'invalid-resolved-brush-radius',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'heightRange', startZMm: 0, heightMm: ORCA_HEIGHT_RANGE_MIN_MM - 0.001 },
        }),
      ),
    'invalid-height-range-height',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'heightRange', startZMm: 0, heightMm: ORCA_HEIGHT_RANGE_MAX_MM + 0.001 },
        }),
      ),
    'invalid-height-range-height',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'heightRange', startZMm: Number.POSITIVE_INFINITY, heightMm: 1 },
        }),
      ),
    'invalid-height-range-start',
  );
  for (const highlightByAngleDegrees of [
    ORCA_OVERHANG_ANGLE_MIN_DEGREES - 0.001,
    ORCA_OVERHANG_ANGLE_MAX_DEGREES + 0.001,
    Number.NaN,
  ]) {
    assertIssue(
      () =>
        selectFacetRegion(
          request(mesh, current, {
            highlightByAngleDegrees,
          }),
        ),
      'invalid-overhang-highlight-angle',
    );
  }
  for (const maxAreaMm2 of [ORCA_GAP_AREA_MIN_MM2 - 0.001, ORCA_GAP_AREA_MAX_MM2 + 0.001, Number.NaN]) {
    assertIssue(
      () =>
        selectFacetRegion(
          request(mesh, current, {
            tool: { kind: 'gapFill', maxAreaMm2, stateOrder: [] },
          }),
        ),
      'invalid-gap-fill-area',
    );
  }

  const assigned = annotations(mesh.triangles.length);
  assigned.color = [{ value: FILAMENT_A, triangles: [0] }];
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, assigned, {
          tool: { kind: 'gapFill', maxAreaMm2: 1, stateOrder: [] },
        }),
      ),
    'missing-gap-fill-state',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'gapFill',
            maxAreaMm2: 1,
            stateOrder: [FILAMENT_A, FILAMENT_A],
          },
        }),
      ),
    'duplicate-gap-fill-state',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: {
            kind: 'gapFill',
            maxAreaMm2: 1,
            stateOrder: [true],
          },
        }),
      ),
    'invalid-gap-fill-state',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          clippingPlane: { normal: [0, 0, 0], offset: 0 },
        }),
      ),
    'invalid-facet-clipping-plane',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          transform: {
            linear: [
              [1, 0, 0],
              [0, 0, 0],
              [0, 0, 1],
            ],
            translation: [0, 0, 0],
            scalingFactors: [1, 1, 1],
          },
        }),
      ),
    'invalid-facet-selection-transform',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          transform: {
            linear: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            translation: [0, 0, 0],
            scalingFactors: [1, 0, 1],
          },
        }),
      ),
    'invalid-facet-selection-transform',
  );
  assertIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          transform: {
            linear: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            translation: [Number.NaN, 0, 0],
            scalingFactors: [1, 1, 1],
          },
        }),
      ),
    'invalid-facet-selection-transform',
  );
  assertIssue(
    () =>
      selectFacetRegion({
        ...request(mesh, current),
        channel: 'unsupported' as 'color',
      }),
    'invalid-facet-selection-channel',
  );

  const overflowMesh: FacetSelectionMesh = {
    vertices: [
      [Number.MAX_VALUE, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    triangles: [[0, 1, 2]],
  };
  assertIssue(
    () =>
      selectFacetRegion(
        request(overflowMesh, annotations(1), {
          guard: { topologyRevision: 7, triangleCount: 1 },
        }),
      ),
    'invalid-facet-mesh-vertex',
  );
  assertIssue(() => constrainPainterDragPoint([0, 0], [Number.NaN, 1], 'none'), 'invalid-painter-screen-point');
});

test('reconstructs every pinned split topology in deterministic root/child order', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const cases: readonly {
    readonly node: FacetRefinementNode;
    readonly derivedVertices: readonly Vec3[];
    readonly leaves: readonly (readonly [number, number, number])[];
  }[] = [
    {
      node: {
        kind: 'split',
        splitSides: 1,
        specialSide: 0,
        children: [unpaintedLeaf(), unpaintedLeaf()],
      },
      derivedVertices: [[0.5, 0.5, 0]],
      leaves: [
        [0, 1, 3],
        [3, 2, 0],
      ],
    },
    {
      node: {
        kind: 'split',
        splitSides: 2,
        specialSide: 0,
        children: [unpaintedLeaf(), unpaintedLeaf(), unpaintedLeaf()],
      },
      derivedVertices: [
        [0.5, 0, 0],
        [0, 0.5, 0],
      ],
      leaves: [
        [0, 3, 4],
        [3, 1, 4],
        [1, 2, 4],
      ],
    },
    {
      node: {
        kind: 'split',
        splitSides: 3,
        specialSide: 0,
        children: [unpaintedLeaf(), unpaintedLeaf(), unpaintedLeaf(), unpaintedLeaf()],
      },
      derivedVertices: [
        [0.5, 0, 0],
        [0.5, 0.5, 0],
        [0, 0.5, 0],
      ],
      leaves: [
        [0, 3, 5],
        [3, 1, 4],
        [4, 2, 5],
        [3, 4, 5],
      ],
    },
  ];

  for (const expected of cases) {
    const inputRefinement = refinement([expected.node]);
    const input = request(mesh, annotations(1), {
      tool: { kind: 'triangle', hit: [0.1, 0.1, 0] },
      refinement: inputRefinement,
    });
    const first = selectFacetRegion(input);
    const second = selectFacetRegion(input);
    assert.deepEqual(first, second);
    assert.deepEqual(first.refinement?.encoding, inputRefinement);
    assert.deepEqual(first.refinement?.vertices.slice(3), expected.derivedVertices);
    assert.deepEqual(
      first.refinement?.leaves.map((leaf) => leaf.vertexIndices),
      expected.leaves,
    );
    assert.deepEqual(
      first.refinement?.leaves.map((leaf) => ({
        sourceTriangle: leaf.sourceTriangle,
        path: leaf.path,
        selected: leaf.selected,
      })),
      expected.leaves.map((_, index) => ({
        sourceTriangle: 0,
        path: [index],
        selected: index === 0,
      })),
    );
    assert.equal(Object.isFrozen(first.refinement?.encoding.roots[0]), true);
    assert.equal(Object.isFrozen(first.refinement?.vertices[3]), true);
  }
});

test('reuses shared midpoints and propagates Fill between split leaves and a coarser neighbor', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
    ],
  };
  const prior = refinement([
    {
      kind: 'split',
      splitSides: 1,
      specialSide: 0,
      children: [unpaintedLeaf(), unpaintedLeaf()],
    },
    unpaintedLeaf(),
  ]);
  const splitNeighbor = selectFacetRegion(
    request(mesh, annotations(2), {
      tool: { kind: 'triangle', hit: [0.75, 0.1, 0] },
      refinement: refinement([
        prior.roots[0],
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 1,
          children: [unpaintedLeaf(), unpaintedLeaf()],
        },
      ]),
    }),
  );
  assert.equal(splitNeighbor.refinement?.vertices.length, 5);
  assert.deepEqual(
    splitNeighbor.refinement?.leaves.map((leaf) => leaf.vertexIndices),
    [
      [0, 1, 4],
      [4, 2, 0],
      [3, 2, 4],
      [4, 1, 3],
    ],
  );

  const result = selectFacetRegion(
    request(mesh, annotations(2), {
      seedTriangle: 0,
      tool: { kind: 'fill', hit: [0.75, 0.1, 0], edgeDetection: false },
      refinement: prior,
    }),
  );

  assert.deepEqual(result.triangleIndices, [0, 1]);
  assert.deepEqual(result.refinement?.vertices, [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0.5, 0.5, 0],
  ]);
  assert.deepEqual(
    result.refinement?.leaves.map(({ sourceTriangle, path, vertexIndices, selected }) => ({
      sourceTriangle,
      path,
      vertexIndices,
      selected,
    })),
    [
      { sourceTriangle: 0, path: [0], vertexIndices: [0, 1, 4], selected: true },
      { sourceTriangle: 0, path: [1], vertexIndices: [4, 2, 0], selected: true },
      { sourceTriangle: 1, path: [], vertexIndices: [1, 3, 2], selected: true },
    ],
  );

  const nested = selectFacetRegion(
    request(mesh, annotations(2), {
      seedTriangle: 0,
      tool: { kind: 'fill', hit: [0.8, 0.05, 0], edgeDetection: false },
      refinement: refinement([
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            {
              kind: 'split',
              splitSides: 1,
              specialSide: 0,
              children: [unpaintedLeaf(), unpaintedLeaf()],
            },
            unpaintedLeaf(),
          ],
        },
        unpaintedLeaf(),
      ]),
    }),
  );
  assert.deepEqual(
    nested.refinement?.leaves.map(({ sourceTriangle, path, selected }) => ({
      sourceTriangle,
      path,
      selected,
    })),
    [
      { sourceTriangle: 0, path: [0, 0], selected: true },
      { sourceTriangle: 0, path: [0, 1], selected: true },
      { sourceTriangle: 0, path: [1], selected: true },
      { sourceTriangle: 1, path: [], selected: true },
    ],
  );
});

test('Gap Fill measures and replaces a split-leaf component through propagated adjacency', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
    ],
  };
  const prior = refinement([
    {
      kind: 'split',
      splitSides: 1,
      specialSide: 0,
      children: [assignedLeaf(FILAMENT_A), assignedLeaf(FILAMENT_B)],
    },
    assignedLeaf(FILAMENT_B),
  ]);
  const result = selectFacetRegion(
    request(mesh, annotations(2), {
      tool: {
        kind: 'gapFill',
        maxAreaMm2: 0.3,
        stateOrder: [FILAMENT_A, FILAMENT_B],
      },
      refinement: prior,
    }),
  );

  assert.deepEqual(result.triangleIndices, [0]);
  assert.deepEqual(result.gapFillReplacements, [
    {
      areaMm2: 0.25,
      source: { kind: 'assigned', value: FILAMENT_A },
      target: { kind: 'assigned', value: FILAMENT_B },
      triangleIndices: [0],
      ranges: [{ start: 0, endExclusive: 1 }],
      refinedLeaves: [{ sourceTriangle: 0, path: [0] }],
    },
  ]);
  assert.deepEqual(
    result.refinement?.leaves.map((leaf) => leaf.selected),
    [true, false, false],
  );
});

test('adaptive splitting keeps the strict edge limit and selects only contained refined leaves', () => {
  const scaledRadius = Math.fround(0.4) / 10;
  const radiusSquared = Math.fround(scaledRadius * scaledRadius);
  const edgeLimit = Math.fround(
    Math.min(Math.fround(Math.fround(Math.sqrt(Math.fround(radiusSquared))) / Math.fround(5)), Math.fround(0.05)),
  );
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [edgeLimit, 0, 0],
      [0, edgeLimit, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const transform: FacetSelectionTransform = {
    linear: [
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ],
    translation: [0, 0, 0],
    scalingFactors: [10, 10, 10],
  };
  const result = selectFacetRegion(
    request(mesh, annotations(1), {
      tool: {
        kind: 'sphere',
        center: [0.04, 0, 0],
        cameraPosition: [0.04, 0, 1],
        radiusMm: 0.4,
        triangleSplitting: true,
      },
      transform,
    }),
  );

  assert.equal(result.refinement?.edgeLimitMm, edgeLimit);
  assert.deepEqual(result.refinement?.encoding.roots[0], {
    kind: 'split',
    splitSides: 1,
    specialSide: 0,
    children: [unpaintedLeaf(), unpaintedLeaf()],
  });
  assert.deepEqual(result.triangleIndices, [0]);
  assert.deepEqual(
    result.refinement?.leaves.map((leaf) => leaf.selected),
    [true, false],
  );
});

test('Height Range measures split edges locally for uniform scale and in world space for non-uniform scale', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [0.1, 0, 0],
      [0, 0, 0.1],
    ],
    triangles: [[0, 1, 2]],
  };
  const select = (transform: FacetSelectionTransform) =>
    selectFacetRegion(
      request(mesh, annotations(1), {
        tool: {
          kind: 'heightRange',
          startZMm: 0.04,
          heightMm: 0.1,
          triangleSplitting: true,
        },
        transform,
      }),
    );
  const uniform = select({
    linear: [
      [2, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
    ],
    translation: [0, 0, 0],
    scalingFactors: [2, 2, 2],
  });
  const nonUniform = select({
    linear: [
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
    scalingFactors: [2, 1, 1],
  });

  const uniformRoot = uniform.refinement?.encoding.roots[0];
  const nonUniformRoot = nonUniform.refinement?.encoding.roots[0];
  assert.equal(uniformRoot?.kind, 'split');
  assert.equal(uniformRoot?.kind === 'split' ? uniformRoot.splitSides : undefined, 1);
  assert.equal(uniformRoot?.kind === 'split' ? uniformRoot.specialSide : undefined, 0);
  assert.equal(nonUniformRoot?.kind, 'split');
  assert.equal(nonUniformRoot?.kind === 'split' ? nonUniformRoot.splitSides : undefined, 2);
  assert.equal(nonUniformRoot?.kind === 'split' ? nonUniformRoot.specialSide : undefined, 1);
  assert.equal(uniform.refinement?.edgeLimitMm, Math.fround(0.1));
  assert.equal(nonUniform.refinement?.edgeLimitMm, Math.fround(0.1));
});

test('refinement validation rejects malformed trees, invalid states, and ambiguous split seeds', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const current = annotations(1);
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          refinement: refinement([]),
        }),
      ),
    'invalid-facet-refinement-root-count',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          refinement: refinement([
            {
              kind: 'split',
              splitSides: 1,
              specialSide: 0,
              children: [unpaintedLeaf()],
            } as FacetRefinementNode,
          ]),
        }),
      ),
    'invalid-facet-refinement-child-count',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          refinement: refinement([
            {
              kind: 'leaf',
              state: { kind: 'assigned', value: true },
            } as FacetRefinementNode,
          ]),
        }),
      ),
    'invalid-facet-refinement-state',
  );
  assertValidationIssue(
    () =>
      selectFacetRegion(
        request(mesh, current, {
          tool: { kind: 'triangle' },
          refinement: refinement([
            {
              kind: 'split',
              splitSides: 1,
              specialSide: 0,
              children: [unpaintedLeaf(), unpaintedLeaf()],
            },
          ]),
        }),
      ),
    'missing-refinement-hit',
  );
});

test('refined commit applies the target state and collapses homogeneous children', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
  };
  const inputRefinement = refinement([
    {
      kind: 'split',
      splitSides: 3,
      specialSide: 0,
      children: [
        assignedLeaf(FILAMENT_B),
        assignedLeaf(FILAMENT_A),
        assignedLeaf(FILAMENT_A),
        assignedLeaf(FILAMENT_A),
      ],
    },
  ]);
  const result = selectFacetRegion(
    request(mesh, annotations(1), {
      tool: { kind: 'triangle', hit: [0.1, 0.1, 0] },
      refinement: inputRefinement,
    }),
  );
  const refined = result.refinement!;
  const before = JSON.stringify(refined);
  const committed = applyFacetRefinedSelection('color', refined, {
    kind: 'assigned',
    value: FILAMENT_A,
  });

  assert.deepEqual(committed, refinement([assignedLeaf(FILAMENT_A)]));
  assert.equal(Object.isFrozen(committed), true);
  assert.equal(Object.isFrozen(committed.roots[0]), true);
  assert.equal(JSON.stringify(refined), before);

  const alreadyTarget = selectFacetRegion(
    request(mesh, annotations(1), {
      tool: {
        kind: 'sphere',
        center: [0.01, 0.01, 0],
        cameraPosition: [0.01, 0.01, 1],
        radiusMm: 0.4,
        triangleSplitting: true,
      },
    }),
  ).refinement!;
  assert.equal(alreadyTarget.encoding.roots[0].kind, 'split');
  assert.deepEqual(
    applyFacetRefinedSelection('color', alreadyTarget, { kind: 'unpainted' }),
    refinement([unpaintedLeaf()]),
  );
});

test('refined per-leaf updates support Gap Fill and reject ambiguous targets', () => {
  const mesh: FacetSelectionMesh = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
    ],
  };
  const result = selectFacetRegion(
    request(mesh, annotations(2), {
      tool: {
        kind: 'gapFill',
        maxAreaMm2: 0.3,
        stateOrder: [FILAMENT_A, FILAMENT_B],
      },
      refinement: refinement([
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [assignedLeaf(FILAMENT_A), assignedLeaf(FILAMENT_B)],
        },
        assignedLeaf(FILAMENT_B),
      ]),
    }),
  );
  const refined = result.refinement!;
  const replacement = result.gapFillReplacements![0];
  const committed = applyFacetRefinedStateUpdates(
    'color',
    refined,
    replacement.refinedLeaves!.map((leaf) => ({ ...leaf, target: replacement.target })),
  );
  assert.deepEqual(committed, refinement([assignedLeaf(FILAMENT_B), assignedLeaf(FILAMENT_B)]));

  const duplicate = { sourceTriangle: 0, path: [0], target: replacement.target } as const;
  assertValidationIssue(
    () => applyFacetRefinedStateUpdates('color', refined, [duplicate, duplicate]),
    'duplicate-refined-leaf-update',
  );
  assertValidationIssue(
    () =>
      applyFacetRefinedStateUpdates('color', refined, [{ sourceTriangle: 0, path: [3], target: replacement.target }]),
    'missing-refined-leaf',
  );
  assertValidationIssue(
    () =>
      applyFacetRefinedStateUpdates('support', refined, [
        { sourceTriangle: 0, path: [0], target: { kind: 'assigned', value: FILAMENT_A } },
      ]),
    'invalid-facet-refinement-state',
  );
});

test('does not mutate mesh, annotations, or request data', () => {
  const mesh = stripMesh();
  const current = annotations(mesh.triangles.length);
  current.color = [{ value: FILAMENT_A, triangles: [1, 2] }];
  const input = request(mesh, current);
  const before = JSON.stringify(input);

  selectFacetRegion(input);

  assert.equal(JSON.stringify(input), before);
});

console.log(`\nCanonical facet region selection: ${passed} tests passed.`);
