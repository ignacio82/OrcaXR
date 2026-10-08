/**
 * Ray picking in printer space (millimetres, bed-corner origin, Z up): the
 * nearest front-facing facet of a plate's volumes that a ray meets. Each
 * volume's matrix is its instance's transform then its own, composed,
 * multiplied and inverted exactly as three.js does for the workspace's display
 * meshes (front-side materials, so back faces are culled), and the ray meets
 * each facet with three's `Ray.intersectTriangle`. The hit names the facet and
 * reports the point in printer and volume space, the ray origin in volume
 * space (a camera ray's eye, as a brush stroke needs it) and the distance.
 * Ties go to the earlier volume, then the lower facet. The Rust core answers
 * the same picks (`orcaxr_project::picking`). A ray's direction is normalized
 * as three normalizes a raycaster's.
 */
import type {
  ProjectPickRayWire,
  ProjectPickReplyWire,
  ProjectPickSceneRequestWire,
} from '../../../contracts/generated/project-intents';
import { wireText, wireUnits } from './annotations/FacetRegionExchange';
import type { AssetRepository } from './assets';
import type { InstanceId, ObjectId, VolumeId } from './domain/ids';
import type { ProjectState, Transform, Vec3 } from './domain/model';
import { decodeIndexedMeshAsset } from './meshCodec';

export interface PickHit {
  readonly objectId: ObjectId;
  readonly instanceId: InstanceId;
  readonly volumeId: VolumeId;
  readonly triangle: number;
  readonly point: Vec3;
  readonly localPoint: Vec3;
  readonly localOrigin: Vec3;
  readonly distance: number;
}

/** A column-major 4×4 matrix, as three's `Matrix4.elements`. */
type Matrix = number[];

/** `Matrix4.compose` after `Quaternion.fromArray(...).normalize()`. */
export function composeTransform(transform: Transform): Matrix {
  let [x, y, z, w] = transform.rotation;
  let l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l === 0) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    l = 1 / l;
    x = x * l;
    y = y * l;
    z = z * l;
    w = w * l;
  }
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const [sx, sy, sz] = transform.scale;
  const [px, py, pz] = transform.translationMm;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    px,
    py,
    pz,
    1,
  ];
}

/** `Matrix4.multiplyMatrices(a, b)`. */
export function multiplyMatrices(ae: Matrix, be: Matrix): Matrix {
  const [a11, a21, a31, a41, a12, a22, a32, a42, a13, a23, a33, a43, a14, a24, a34, a44] = ae;
  const [b11, b21, b31, b41, b12, b22, b32, b42, b13, b23, b33, b43, b14, b24, b34, b44] = be;
  return [
    a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
    a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
    a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
    a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
    a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
    a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
    a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
    a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
    a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
    a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
    a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
    a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
    a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
    a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
    a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
    a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
  ];
}

/** `Matrix4.invert()`: a singular matrix inverts to zeros. */
export function invertMatrix(te: Matrix): Matrix {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = te;
  const t1 = n11 * n22 - n21 * n12,
    t2 = n11 * n32 - n31 * n12,
    t3 = n11 * n42 - n41 * n12,
    t4 = n21 * n32 - n31 * n22,
    t5 = n21 * n42 - n41 * n22,
    t6 = n31 * n42 - n41 * n32,
    t7 = n13 * n24 - n23 * n14,
    t8 = n13 * n34 - n33 * n14,
    t9 = n13 * n44 - n43 * n14,
    t10 = n23 * n34 - n33 * n24,
    t11 = n23 * n44 - n43 * n24,
    t12 = n33 * n44 - n43 * n34;
  const det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
  if (det === 0) return new Array(16).fill(0);
  const detInv = 1 / det;
  return [
    (n22 * t12 - n32 * t11 + n42 * t10) * detInv,
    (n31 * t11 - n21 * t12 - n41 * t10) * detInv,
    (n24 * t6 - n34 * t5 + n44 * t4) * detInv,
    (n33 * t5 - n23 * t6 - n43 * t4) * detInv,
    (n32 * t9 - n12 * t12 - n42 * t8) * detInv,
    (n11 * t12 - n31 * t9 + n41 * t8) * detInv,
    (n34 * t3 - n14 * t6 - n44 * t2) * detInv,
    (n13 * t6 - n33 * t3 + n43 * t2) * detInv,
    (n12 * t11 - n22 * t9 + n42 * t7) * detInv,
    (n21 * t9 - n11 * t11 - n41 * t7) * detInv,
    (n14 * t5 - n24 * t3 + n44 * t1) * detInv,
    (n23 * t3 - n13 * t5 - n43 * t1) * detInv,
    (n22 * t8 - n12 * t10 - n32 * t7) * detInv,
    (n11 * t10 - n21 * t8 + n31 * t7) * detInv,
    (n24 * t2 - n14 * t4 - n34 * t1) * detInv,
    (n13 * t4 - n23 * t2 + n33 * t1) * detInv,
  ];
}

/** `Vector3.applyMatrix4`. */
export function applyMatrix(v: Vec3, e: Matrix): Vec3 {
  const [x, y, z] = v;
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
  return [
    (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
    (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
    (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
  ];
}

/** `Vector3.normalize`: `divideScalar(length || 1)`. */
function normalize(v: Vec3): Vec3 {
  const s = 1 / (Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1);
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** `Vector3.transformDirection`. */
function transformDirection(v: Vec3, e: Matrix): Vec3 {
  const [x, y, z] = v;
  return normalize([e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z]);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** `Vector3.crossVectors(a, b)`. */
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** `Ray.intersectTriangle(a, b, c, true)`: the distance along the ray, or `undefined`. */
export function intersectTriangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): number | undefined {
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const normal = cross(edge1, edge2);
  let DdN = dot(direction, normal);
  let sign: number;
  // Front sides only: a ray along the normal meets a back face.
  if (DdN > 0) return undefined;
  if (DdN < 0) {
    sign = -1;
    DdN = -DdN;
  } else return undefined;
  const diff = sub(origin, a);
  const DdQxE2 = sign * dot(direction, cross(diff, edge2));
  if (DdQxE2 < 0) return undefined;
  const DdE1xQ = sign * dot(direction, cross(edge1, diff));
  if (DdE1xQ < 0) return undefined;
  if (DdQxE2 + DdE1xQ > DdN) return undefined;
  const QdN = -sign * dot(diff, normal);
  if (QdN < 0) return undefined;
  return QdN / DdN;
}

/** `Ray.at(t)`: `direction * t + origin`. */
const at = (origin: Vec3, direction: Vec3, t: number): Vec3 => [
  direction[0] * t + origin[0],
  direction[1] * t + origin[1],
  direction[2] * t + origin[2],
];

export type PickRefusalCode = 'unknown-plate' | 'invalid-mesh';

export class PickRefusal extends Error {
  constructor(readonly code: PickRefusalCode) {
    super(`Pick refused (${code})`);
    this.name = 'PickRefusal';
  }
}

interface SceneVolume {
  readonly objectId: ObjectId;
  readonly instanceId: InstanceId;
  readonly volumeId: VolumeId;
  readonly matrix: Matrix;
  readonly inverse: Matrix;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * One plate's volumes captured for picking: decoded meshes shared by asset,
 * each instance-and-volume matrix and its inverse, in plate order (objects,
 * then instances, then volumes). Picks run against the capture, not the
 * project, so a host re-captures when the project changes.
 */
export class ProjectPickScene {
  private constructor(private readonly volumes: readonly SceneVolume[]) {}

  static capture(
    state: ProjectState,
    assets: Pick<AssetRepository, 'peek'>,
    request: ProjectPickSceneRequestWire,
  ): ProjectPickScene {
    const plateId = wireText(request.plateId);
    const plate = state.plates.find((candidate) => candidate.id === plateId);
    if (!plate) throw new PickRefusal('unknown-plate');
    const meshes = new Map<string, { positions: Float32Array; indices: Uint32Array }>();
    const volumes: SceneVolume[] = [];
    for (const object of plate.objects) {
      for (const instance of object.instances) {
        const instanceMatrix = composeTransform(instance.transform);
        for (const volume of object.volumes) {
          if (request.modelsOnly && volume.role !== 'model') continue;
          let mesh = meshes.get(volume.source.assetId);
          if (!mesh) {
            const payload = assets.peek(volume.source.assetId);
            if (!payload) throw new PickRefusal('invalid-mesh');
            try {
              mesh = decodeIndexedMeshAsset(payload);
            } catch {
              throw new PickRefusal('invalid-mesh');
            }
            meshes.set(volume.source.assetId, mesh);
          }
          const matrix = multiplyMatrices(instanceMatrix, composeTransform(volume.transform));
          volumes.push({
            objectId: object.id,
            instanceId: instance.id,
            volumeId: volume.id,
            matrix,
            inverse: invertMatrix(matrix),
            positions: mesh.positions,
            indices: mesh.indices,
          });
        }
      }
    }
    return new ProjectPickScene(volumes);
  }

  /** The nearest front-facing facet a printer-space ray meets, or a miss. */
  pick(ray: ProjectPickRayWire): ProjectPickReplyWire {
    const hit = this.nearest(vector(ray.origin), vector(ray.direction));
    if (!hit) return { miss: {} };
    return {
      hit: {
        objectId: wireUnits(hit.objectId),
        instanceId: wireUnits(hit.instanceId),
        volumeId: wireUnits(hit.volumeId),
        triangle: hit.triangle,
        point: [...hit.point],
        localPoint: [...hit.localPoint],
        localOrigin: [...hit.localOrigin],
        distance: hit.distance,
      },
    };
  }

  nearest(origin: Vec3, rayDirection: Vec3): PickHit | undefined {
    const direction = normalize(rayDirection);
    let best: PickHit | undefined;
    for (const volume of this.volumes) {
      const localOrigin = applyMatrix(origin, volume.inverse);
      const localDirection = transformDirection(direction, volume.inverse);
      const { positions, indices } = volume;
      const vertex = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
        const t = intersectTriangle(
          localOrigin,
          localDirection,
          vertex(indices[triangle * 3]),
          vertex(indices[triangle * 3 + 1]),
          vertex(indices[triangle * 3 + 2]),
        );
        if (t === undefined) continue;
        const localPoint = at(localOrigin, localDirection, t);
        const point = applyMatrix(localPoint, volume.matrix);
        const d = sub(point, origin);
        const distance = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        if (best && !(distance < best.distance)) continue;
        best = {
          objectId: volume.objectId,
          instanceId: volume.instanceId,
          volumeId: volume.volumeId,
          triangle,
          point,
          localPoint,
          localOrigin,
          distance,
        };
      }
    }
    return best;
  }
}

const vector = (value: readonly number[]): Vec3 => [value[0], value[1], value[2]];
