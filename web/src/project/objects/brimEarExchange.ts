/**
 * Brim-ear detection over a live session, in the shared contract's encoding.
 *
 * Ears are object-local: the engine moves each by its instance's transform
 * only, so the first layer an ear holds is the object's model volumes, each
 * moved by its own transform into object space (composed as three.js does,
 * `picking.ts`). Detection finds the outward corners of that layer
 * (`brimEarDetection.ts`); the stranded check names the placed ears whose
 * discs reach neither the layer nor an anchored ear (`brimEarPreview.ts`).
 * The Rust core answers the same requests
 * (`orcaxr_project::brim_ears`).
 */
import type {
  ProjectBrimEarDetectReplyWire,
  ProjectBrimEarDetectRequestWire,
  ProjectBrimEarRefusalCodeWire,
  ProjectBrimEarStrandedReplyWire,
  ProjectBrimEarStrandedRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { ObjectId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { decodeIndexedMeshAsset } from '../meshCodec';
import { applyMatrix, composeTransform } from '../picking';
import { DEFAULT_BRIM_EAR_DETECTION, detectBrimEars } from './brimEarDetection';
import { brimEarOutline, findDisconnectedBrimEars } from './brimEarPreview';

/** Why an object's ears cannot be read. */
export class BrimEarRefusal extends Error {
  constructor(
    message: string,
    readonly code: ProjectBrimEarRefusalCodeWire,
  ) {
    super(message);
    this.name = 'BrimEarRefusal';
  }
}

/** One object's model volumes in object space, as one indexed mesh. */
export interface ObjectModelMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

/**
 * Every model volume of one object, in volume order, moved by its own
 * transform into object-local millimetres. Throws `BrimEarRefusal`.
 */
export function objectModelMesh(state: ProjectState, assets: AssetRepository, objectId: ObjectId): ObjectModelMesh {
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId);
  if (!object) throw new BrimEarRefusal(`Unknown object ${objectId}`, 'unknownObject');
  const positions: number[] = [];
  const indices: number[] = [];
  for (const volume of object.volumes) {
    if (volume.role !== 'model') continue;
    const payload = assets.get(volume.source.assetId);
    if (!payload) throw new BrimEarRefusal(`Volume ${volume.id} has no stored mesh asset`, 'missingAsset');
    let mesh;
    try {
      mesh = decodeIndexedMeshAsset(payload);
    } catch (error) {
      throw new BrimEarRefusal((error as Error).message, 'invalidMesh');
    }
    const matrix = composeTransform(volume.transform);
    const offset = positions.length / 3;
    for (const vertex of mesh.vertices) positions.push(...applyMatrix(vertex, matrix));
    for (const triangle of mesh.triangles)
      indices.push(offset + triangle[0], offset + triangle[1], offset + triangle[2]);
  }
  return { positions, indices };
}

function refusal(error: unknown): { refused: { code: ProjectBrimEarRefusalCodeWire; message: number[] } } {
  if (!(error instanceof BrimEarRefusal)) throw error;
  return { refused: { code: error.code, message: wireUnits(error.message) } };
}

/** `BrimEarDetectRequest` → `BrimEarDetectReply`: the corners that would lift. */
export function detectObjectBrimEarsWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectBrimEarDetectRequestWire,
): ProjectBrimEarDetectReplyWire {
  let mesh;
  try {
    mesh = objectModelMesh(state, assets, wireText(request.objectId) as ObjectId);
  } catch (error) {
    return refusal(error);
  }
  const detected = detectBrimEars(mesh.positions, mesh.indices, {
    maxAngleDeg: request.maxAngleDeg,
    detectionRadiusMm: request.detectionRadiusMm,
    headFrontRadiusMm: request.headFrontRadiusMm,
    ...('value' in request.sampleHeightMm ? { sampleHeightMm: request.sampleHeightMm.value } : {}),
  });
  return {
    detected: {
      ears: detected.ears.map((ear) => ({
        positionMm: [...ear.point.positionMm],
        headFrontRadiusMm: ear.point.headFrontRadiusMm,
        angleDeg: ear.angleDeg,
      })),
      reason: detected.reason === undefined ? { absent: {} } : { value: wireUnits(detected.reason) },
    },
  };
}

/** `BrimEarStrandedRequest` → `BrimEarStrandedReply`: placed ears reaching nothing. */
export function strandedObjectBrimEarsWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectBrimEarStrandedRequestWire,
): ProjectBrimEarStrandedReplyWire {
  const objectId = wireText(request.objectId) as ObjectId;
  let mesh;
  try {
    mesh = objectModelMesh(state, assets, objectId);
  } catch (error) {
    return refusal(error);
  }
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId)!;
  const ears = object.brimEars ?? [];
  const outline =
    ears.length === 0 ? null : brimEarOutline(mesh.positions, mesh.indices, DEFAULT_BRIM_EAR_DETECTION.sampleHeightMm);
  const indices = outline
    ? findDisconnectedBrimEars(
        ears.map((ear) => ({ x: ear.positionMm[0], y: ear.positionMm[1], radiusMm: ear.headFrontRadiusMm })),
        outline.loops,
      )
    : [];
  return { stranded: { indices: [...indices] } };
}
