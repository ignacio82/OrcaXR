/**
 * A picking scene shared by the browser test (which checks the reference
 * against three.js raycasts) and the cross-platform corpus: an icosphere with
 * a modifier cube on two instances (one rotated and non-uniformly scaled), an
 * open terrain on a mirrored instance, and deterministic rays — aimed at the
 * volumes, from below, along grazing angles and past everything.
 */
import { cloneJson } from '../domain/canonical';
import { entityId, seededRandom } from '../domain/ids';
import { emptyFacetAnnotations, type ProjectState, type Transform, type Vec3 } from '../domain/model';
import { encodeIndexedMeshAsset } from '../meshCodec';
import type { AssetPayload } from '../assets';
import { createProjectFixture } from './fixtures';

export interface PickingRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export interface PickingFixture {
  readonly state: ProjectState;
  readonly assets: readonly AssetPayload[];
  readonly plateId: string;
  readonly rays: readonly PickingRay[];
}

function icosphere(level: number, radius: number): { vertices: Vec3[]; triangles: [number, number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  let triangles: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let l = 0; l < level; l += 1) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let index = cache.get(key);
      if (index === undefined) {
        index = vertices.push(vertices[a].map((v, i) => (v + vertices[b][i]) / 2) as unknown as Vec3) - 1;
        cache.set(key, index);
      }
      return index;
    };
    triangles = triangles.flatMap(([a, b, c]) => {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ] as [number, number, number][];
    });
  }
  vertices = vertices.map((p) => p.map((v) => (v / Math.hypot(...p)) * radius) as unknown as Vec3);
  return { vertices, triangles };
}

function cube(size: number): { vertices: Vec3[]; triangles: [number, number, number][] } {
  const h = size / 2;
  const vertices: Vec3[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const triangles: [number, number, number][] = [
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
  return { vertices, triangles };
}

function terrain(n: number, step: number): { vertices: Vec3[]; triangles: [number, number, number][] } {
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];
  for (let y = 0; y <= n; y += 1)
    for (let x = 0; x <= n; x += 1)
      vertices.push([x * step, y * step, 2 + 1.5 * Math.sin(x * 0.8) * Math.cos(y * 0.6)]);
  const at = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1)
      triangles.push([at(x, y), at(x + 1, y), at(x + 1, y + 1)], [at(x, y), at(x + 1, y + 1), at(x, y + 1)]);
  return { vertices, triangles };
}

const asset = (id: string, mesh: { vertices: Vec3[]; triangles: [number, number, number][] }) =>
  encodeIndexedMeshAsset({
    id: entityId<'asset'>(id),
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
  });

const transform = (translationMm: Vec3, rotation: [number, number, number, number], scale: Vec3): Transform => ({
  translationMm,
  rotation,
  scale,
});

export function createPickingFixture(): PickingFixture {
  const fixture = createProjectFixture();
  const state = cloneJson(fixture.state);
  const sphere = asset('import:asset:pick-sphere', icosphere(2, 8));
  const box = asset('import:asset:pick-cube', cube(6));
  const ground = asset('import:asset:pick-terrain', terrain(8, 1.25));
  const object = state.plates[0].objects[0];
  const half = Math.SQRT1_2;
  object.volumes = [
    {
      ...object.volumes[0],
      source: { assetId: sphere.descriptor.id, topologyRevision: 0, triangleCount: 320 },
      annotations: emptyFacetAnnotations(0),
    },
    {
      ...cloneJson(object.volumes[0]),
      id: entityId<'volume'>('import:volume:pick-modifier'),
      name: 'Modifier',
      role: 'parameter-modifier',
      source: { assetId: box.descriptor.id, topologyRevision: 0, triangleCount: 12 },
      transform: transform([0, 0, 9], [0, 0, 0, 1], [1, 1, 1]),
      annotations: emptyFacetAnnotations(0),
    },
  ];
  object.instances = [
    { ...object.instances[0], transform: transform([50, 40, 8], [0, 0, 0, 1], [1, 1, 1]) },
    {
      ...cloneJson(object.instances[0]),
      id: entityId<'instance'>('import:instance:pick-turned'),
      // Unnormalized on purpose: the display normalizes the quaternion.
      transform: transform([120, 60, 10], [0.2, 0.1, 0.5, 2], [1.5, 1, 0.75]),
    },
  ];
  const terrainObject = cloneJson(object);
  terrainObject.id = entityId<'object'>('import:object:pick-terrain');
  terrainObject.layerRanges = [];
  terrainObject.volumes = [
    {
      ...cloneJson(object.volumes[0]),
      id: entityId<'volume'>('import:volume:pick-terrain'),
      name: 'Terrain',
      source: { assetId: ground.descriptor.id, topologyRevision: 0, triangleCount: 128 },
      transform: transform([0, 0, 0], [0, 0, half, half], [1, 1, 1]),
    },
  ];
  terrainObject.instances = [
    {
      ...cloneJson(object.instances[0]),
      id: entityId<'instance'>('import:instance:pick-mirrored'),
      transform: transform([20, 20, 0], [0, 0, 0, 1], [-1, 1, 1]),
    },
  ];
  state.plates[0].objects.push(terrainObject);
  state.sourceAssets = [sphere.descriptor, box.descriptor, ground.descriptor];

  const random = seededRandom(0x51c4);
  const targets: Vec3[] = [
    [50, 40, 8],
    [50, 40, 17],
    [120, 60, 10],
    [15, 25, 2],
  ];
  const rays: PickingRay[] = [];
  for (let i = 0; i < 240; i += 1) {
    const target = targets[i % targets.length];
    const aim: Vec3 = [
      target[0] + (random() - 0.5) * 16,
      target[1] + (random() - 0.5) * 16,
      target[2] + (random() - 0.5) * 12,
    ];
    const from: Vec3 =
      i % 5 === 4
        ? // From below the bed, meeting back faces of open and closed meshes.
          [aim[0] + (random() - 0.5) * 20, aim[1] + (random() - 0.5) * 20, -40]
        : [aim[0] + (random() - 0.5) * 120, aim[1] + (random() - 0.5) * 120, 60 + random() * 80];
    const scale = i % 7 === 0 ? 3.5 : 1;
    rays.push({
      origin: from,
      direction: [(aim[0] - from[0]) * scale, (aim[1] - from[1]) * scale, (aim[2] - from[2]) * scale],
    });
  }
  // Past everything, straight along an axis, and a degenerate direction.
  rays.push({ origin: [-50, -50, 50], direction: [-1, 0, 0] });
  rays.push({ origin: [50, 40, 100], direction: [0, 0, -1] });
  rays.push({ origin: [50, 40, 100], direction: [0, 0, 0] });
  return { state, assets: [sphere, box, ground], plateId: state.plates[0].id, rays };
}
