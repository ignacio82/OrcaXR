/**
 * Brim-ear detection over a live session, in the shared contract's encoding.
 *
 * Ears are object-local: the engine moves each by its instance's transform
 * only, so the first layer an ear holds is the object's model volumes, each
 * moved by its own transform into object space (composed as three.js does,
 * `picking.ts`). Detection finds the outward corners of that layer
 * (`brimEarDetection.ts`); the stranded check names the placed ears whose
 * discs reach neither the layer nor an anchored ear (`brimEarPreview.ts`).
 * An object's view is what the workspace's brim-ear tool shows and places
 * with: its ears, the stranded ones and the base a placed ear sits on. The
 * Rust core answers the same requests (`orcaxr_project::brim_ears`).
 */
import type {
  ProjectBrimEarDetectReplyWire,
  ProjectBrimEarDetectRequestWire,
  ProjectBrimEarRefusalCodeWire,
  ProjectBrimEarStrandedReplyWire,
  ProjectBrimEarStrandedRequestWire,
  ProjectBrimEarViewReplyWire,
  ProjectBrimEarViewRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { ObjectId } from '../domain/ids';
import type { BrimEarPoint, ProjectState } from '../domain/model';
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

/**
 * The height a placed ear sits at: the object's lowest model point, or none
 * when it has no model geometry. An ear is a first-layer feature, and the
 * pinned engine discards any ear whose transformed Z is above the bed
 * (`Brim.cpp:867`), so a click up a wall still places the ear at the base.
 */
export function objectModelBaseZ(mesh: ObjectModelMesh | undefined): number | undefined {
  if (!mesh || mesh.positions.length < 3) return undefined;
  let base = Number.POSITIVE_INFINITY;
  for (let index = 2; index < mesh.positions.length; index += 3) base = Math.min(base, mesh.positions[index]);
  return base;
}

/** What the brim-ear tool shows of one object and places with. */
export interface ObjectBrimEarView {
  /** The placed ears, in order, as the project stores them. */
  readonly ears: readonly BrimEarPoint[];
  /** Indices into `ears` that reach neither the part nor an ear that does. */
  readonly stranded: readonly number[];
  /** Where a placed ear sits (`objectModelBaseZ`); absent without model geometry. */
  readonly baseZMm?: number;
}

/**
 * One object's ears, the stranded ones and its base. An object whose model
 * parts cannot be read still lists its ears, with none stranded and no base,
 * as the workspace shows them; only an unknown object throws
 * `BrimEarRefusal`.
 */
export function objectBrimEarView(state: ProjectState, assets: AssetRepository, objectId: ObjectId): ObjectBrimEarView {
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId);
  if (!object) throw new BrimEarRefusal(`Unknown object ${objectId}`, 'unknownObject');
  const ears = object.brimEars ?? [];
  let mesh: ObjectModelMesh | undefined;
  try {
    mesh = objectModelMesh(state, assets, objectId);
  } catch (error) {
    if (!(error instanceof BrimEarRefusal)) throw error;
  }
  const outline =
    mesh && ears.length > 0
      ? brimEarOutline(mesh.positions, mesh.indices, DEFAULT_BRIM_EAR_DETECTION.sampleHeightMm)
      : null;
  const stranded = outline
    ? findDisconnectedBrimEars(
        ears.map((ear) => ({ x: ear.positionMm[0], y: ear.positionMm[1], radiusMm: ear.headFrontRadiusMm })),
        outline.loops,
      )
    : [];
  const baseZMm = objectModelBaseZ(mesh);
  return { ears, stranded, ...(baseZMm === undefined ? {} : { baseZMm }) };
}

/** `BrimEarViewRequest` → `BrimEarViewReply`: an object's ears, the stranded ones and its base. */
export function brimEarViewWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectBrimEarViewRequestWire,
): ProjectBrimEarViewReplyWire {
  let view;
  try {
    view = objectBrimEarView(state, assets, wireText(request.objectId) as ObjectId);
  } catch (error) {
    return refusal(error);
  }
  return {
    view: {
      ears: view.ears.map((ear) => ({
        positionMm: [ear.positionMm[0], ear.positionMm[1], ear.positionMm[2]],
        headFrontRadiusMm: ear.headFrontRadiusMm,
      })),
      stranded: [...view.stranded],
      baseZMm: view.baseZMm === undefined ? { absent: {} } : { value: view.baseZMm },
    },
  };
}
