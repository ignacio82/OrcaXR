import {
  decodeProjectIntent,
  encodeProjectIntent,
  type ProjectIntentWire,
} from '../../../contracts/generated/project-intents';
import { isStableEntityId, type ObjectId, type PlateId, type VolumeId } from './domain/ids';
import type { ProjectInstance, ProjectObject, ProjectState, ProjectVolume, EmbossSvgPart } from './domain/model';
import { CreateInstanceCommand, PasteObjectCommand, type IndependentObjectIds } from './objects/commands';
import { prepareProjectIntent } from './PreparedProjectCommands';
import type { ProjectCommand } from './history/command';
import type { CommandBus } from './history/commandBus';
import { contentDigest, type AssetPayload, type AssetRepository, type AssetRepositorySelection } from './assets';
import { AddObjectCommand, AddObjectWithAssetCommand, ReplaceProjectCommand } from './commands';
import { AddVolumeCommand } from './objects/semanticVolumeCommands';
import { ReplaceVolumeMeshCommand, type MeshTopologyReplacementGuard } from './objects/topologyCommands';
import { MeshBooleanCommand, type MeshBooleanGuard, type MeshBooleanOp } from './objects/meshBooleanCommands';
import {
  SplitVolumeToPartsCommand,
  type PreparedVolumeSplitPart,
  type VolumeSplitGuard,
} from './objects/splitCommands';
import { commitPreparedVolumeSplitToObjects, type SeparatedObjectIdentity } from './objects/splitToObjectsCommands';
import { AddSvgPartCommand, EditSvgPartCommand, type SvgPlacement } from './objects/svgCommands';
import { AddEmbossTextCommand, EditEmbossTextCommand, type EmbossPlacement } from './objects/embossCommands';
import type { EmbossTextConfiguration } from './objects/emboss';
import { commitFacetRefinement, type FacetRefinementCommitRequest } from './annotations/FacetAnnotationStrokeCommand';
import type { FacetAnnotationChannel } from './annotations/types';

export class StagedInputError extends Error {
  constructor(readonly code: 'limit' | 'invalid') {
    super(
      code === 'limit'
        ? 'The staged project input exceeds its resource budget.'
        : 'The staged project input is invalid.',
    );
    this.name = 'StagedInputError';
  }
}
/** Bulk preparation limits, distinct from the small request envelope and the
 * aggregate budget for completed staged resources. This work belongs in an
 * owned preparation task; it is not an authority-worker latency guarantee. */
export interface StagedInputLimits {
  readonly maxUnits: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  /** Distinct payloads one input may carry (default 0: none). */
  readonly maxAssets?: number;
  /** Their total bytes (default 0). */
  readonly maxAssetBytes?: number;
}
export interface CapturedProjectCommand {
  readonly inputUnits: number;
  /** Bytes of the distinct payloads this command carries. */
  readonly assetBytes: number;
}
export interface StagedProjectWork {
  readonly inputUnits: number;
  readonly commandCount: number;
  /** Each distinct payload once across the whole work. */
  readonly assetBytes: number;
}
export interface ProjectStagingLimits {
  readonly maxResources: number;
  readonly maxCommands: number;
  readonly maxUnits: number;
  readonly maxAssetBytes: number;
}
export interface ProjectStagingUsage {
  readonly resources: number;
  readonly commands: number;
  readonly units: number;
  readonly assetBytes: number;
}
interface OwnedWork {
  readonly commands: readonly ProjectCommand[];
  readonly label?: string;
  /** Work that runs its own checks and transaction on the session's bus. */
  readonly program?: (bus: CommandBus) => void;
}
interface OwnedCommand {
  readonly command: ProjectCommand;
  readonly payloads: readonly AssetPayload[];
}
const commands = new WeakMap<CapturedProjectCommand, OwnedCommand>();
const work = new WeakMap<StagedProjectWork, OwnedWork>();

/** Count and capture data properties together without invoking getters or
 * toJSON. The owned copy fixes the charged payload. Keys including __proto__
 * remain ordinary own data; complete UTF-16 is retained. */
function capture<T>(value: T, limits: StagedInputLimits): { value: T; units: number } {
  if (
    ![limits.maxUnits, limits.maxNodes, limits.maxDepth].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    limits.maxDepth > 128
  )
    throw new StagedInputError('invalid');
  let units = 0,
    nodes = 0;
  const visiting = new Set<object>();
  const charge = (n: number) => {
    if (n > limits.maxUnits - units) throw new StagedInputError('limit');
    units += n;
  };
  const text = (s: string) => {
    charge(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) charge(2);
      else if (c < 32) charge(6);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 &&
        s.charCodeAt(i + 1) <= 0xdfff
      ) {
        charge(2);
        i++;
      } else charge(c >= 0xd800 && c <= 0xdfff ? 6 : 1);
    }
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new StagedInputError('limit');
    if (v === null) {
      charge(4);
      return v;
    }
    if (typeof v === 'string') {
      text(v);
      return v;
    }
    if (typeof v === 'boolean') {
      charge(v ? 4 : 5);
      return v;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new StagedInputError('invalid');
      charge(JSON.stringify(v).length);
      return v;
    }
    if (typeof v !== 'object' || visiting.has(v)) throw new StagedInputError('invalid');
    const array = Array.isArray(v);
    const prototype = Object.getPrototypeOf(v);
    if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null))
      throw new StagedInputError('invalid');
    if (array && v.length > limits.maxNodes - nodes) throw new StagedInputError('limit');
    const keys = Reflect.ownKeys(v);
    if (keys.some((key) => typeof key !== 'string')) throw new StagedInputError('invalid');
    visiting.add(v);
    charge(2);
    if (array) {
      if (keys.length !== v.length + 1) throw new StagedInputError('invalid');
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new StagedInputError('invalid');
        if (i) charge(1);
        result.push(visit(descriptor.value, depth + 1));
      }
      visiting.delete(v);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new StagedInputError('invalid');
      if (i) charge(1);
      text(key);
      charge(1);
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    visiting.delete(v);
    return result;
  };
  return { value: visit(value, 0) as T, units };
}
function captured(
  command: ProjectCommand,
  inputUnits: number,
  payloads: readonly AssetPayload[] = [],
): CapturedProjectCommand {
  const result = Object.freeze({ inputUnits, assetBytes: distinctBytes(payloads) });
  commands.set(result, { command, payloads });
  return result;
}
/** Each distinct payload once; one asset ID must carry one payload throughout. */
function distinctBytes(payloads: readonly AssetPayload[]): number {
  const seen = new Map<string, AssetPayload>();
  let total = 0;
  for (const payload of payloads) {
    const existing = seen.get(payload.descriptor.id);
    if (existing) {
      if (!samePayload(existing, payload)) throw new StagedInputError('invalid');
      continue;
    }
    seen.set(payload.descriptor.id, payload);
    total += payload.bytes.byteLength;
  }
  return total;
}
function samePayload(left: AssetPayload, right: AssetPayload): boolean {
  return (
    JSON.stringify(sorted(left.descriptor)) === JSON.stringify(sorted(right.descriptor)) &&
    left.bytes.byteLength === right.bytes.byteLength &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}
/** The bytes of payloads whose captured descriptors already passed `capture`:
 * validated as the repository will store them (declared length and, for
 * fnv1a64 digests, content), copied, and kept within the input's payload
 * budget. Bytes never pass through `capture`, which refuses typed arrays. */
function ownPayloads(
  pairs: readonly (readonly [AssetPayload['descriptor'], AssetPayload])[],
  limits: StagedInputLimits,
): AssetPayload[] {
  const maxAssets = limits.maxAssets ?? 0,
    maxBytes = limits.maxAssetBytes ?? 0;
  if (![maxAssets, maxBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new StagedInputError('invalid');
  const owned = pairs.map(([descriptor, source]) => {
    const bytes = source?.bytes;
    if (!(bytes instanceof Uint8Array)) throw new StagedInputError('invalid');
    if (typeof descriptor?.id !== 'string' || !isStableEntityId(descriptor.id)) throw new StagedInputError('invalid');
    if (descriptor.byteLength !== bytes.byteLength || typeof descriptor.digest !== 'string')
      throw new StagedInputError('invalid');
    if (descriptor.digest.startsWith('fnv1a64:') && descriptor.digest !== contentDigest(bytes))
      throw new StagedInputError('invalid');
    return { descriptor, bytes: bytes.slice() };
  });
  const distinct = new Set(owned.map((payload) => payload.descriptor.id));
  if (distinct.size > maxAssets || distinctBytes(owned) > maxBytes) throw new StagedInputError('limit');
  return owned;
}
function plainStable(value: unknown): string {
  if (typeof value !== 'string' || !isStableEntityId(value)) throw new StagedInputError('invalid');
  return value;
}
function stable(value: unknown): void {
  if (typeof value !== 'string' || !isStableEntityId(value)) throw new StagedInputError('invalid');
}
function planField<K extends keyof IndependentObjectIds>(ids: IndependentObjectIds, key: K): IndependentObjectIds[K] {
  const field = Object.getOwnPropertyDescriptor(ids, key);
  if (!field?.enumerable || !('value' in field)) throw new StagedInputError('invalid');
  return field.value;
}
export function captureInstanceCommand(
  objectId: ObjectId,
  instance: ProjectInstance,
  insertionIndex: number | undefined,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, object, record, index],
    units,
  } = capture(['createInstance', objectId, instance, insertionIndex ?? null] as const, limits);
  stable(object);
  stable(record.id);
  return captured(new CreateInstanceCommand(object, record, index ?? undefined), units);
}
/** `AddObjectCommand`: a complete object record appended to a plate. */
export function captureAddObjectCommand(
  plateId: PlateId,
  object: ProjectObject,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, plate, record],
    units,
  } = capture(['addObject', plateId, object] as const, limits);
  return captured(new AddObjectCommand(plainStable(plate) as PlateId, record), units);
}
/** `AddObjectWithAssetCommand`: the record plus the payload it references. */
export function captureAddObjectWithAssetCommand(
  plateId: PlateId,
  object: ProjectObject,
  asset: AssetPayload,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, plate, record, descriptor],
    units,
  } = capture(['addObjectWithAsset', plateId, object, asset.descriptor] as const, limits);
  const [payload] = ownPayloads([[descriptor, asset]], limits);
  return captured(new AddObjectWithAssetCommand(plainStable(plate) as PlateId, record, payload), units, [payload]);
}
/** `AddVolumeCommand`. */
export function captureAddVolumeCommand(
  objectId: ObjectId,
  volume: ProjectVolume,
  asset: AssetPayload,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, object, record, descriptor],
    units,
  } = capture(['addVolume', objectId, volume, asset.descriptor] as const, limits);
  const [payload] = ownPayloads([[descriptor, asset]], limits);
  return captured(new AddVolumeCommand(plainStable(object) as ObjectId, record, payload), units, [payload]);
}
/** `ReplaceVolumeMeshCommand`; the guard travels with exactly its fields. */
export function captureReplaceVolumeMeshCommand(
  guard: MeshTopologyReplacementGuard,
  replacement: AssetPayload,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, owned, descriptor],
    units,
  } = capture(
    [
      'replaceVolumeMesh',
      {
        volumeId: guard.volumeId,
        assetId: guard.assetId,
        assetDigest: guard.assetDigest,
        topologyRevision: guard.topologyRevision,
        triangleCount: guard.triangleCount,
      },
      replacement.descriptor,
    ] as const,
    limits,
  );
  const [payload] = ownPayloads([[descriptor, replacement]], limits);
  return captured(new ReplaceVolumeMeshCommand(owned, payload), units, [payload]);
}
/** `MeshBooleanCommand`. */
export function captureMeshBooleanCommand(
  guard: MeshBooleanGuard,
  replacement: AssetPayload,
  op: MeshBooleanOp,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  if (op !== 'UNION' && op !== 'A_NOT_B' && op !== 'INTERSECTION') throw new StagedInputError('invalid');
  const {
    value: [, owned, descriptor],
    units,
  } = capture(
    [
      'meshBoolean',
      {
        targetInstanceId: guard.targetInstanceId,
        targetVolumeId: guard.targetVolumeId,
        targetAssetId: guard.targetAssetId,
        targetAssetDigest: guard.targetAssetDigest,
        targetTopologyRevision: guard.targetTopologyRevision,
        targetTriangleCount: guard.targetTriangleCount,
        otherInstanceId: guard.otherInstanceId,
      },
      replacement.descriptor,
      op,
    ] as const,
    limits,
  );
  const [payload] = ownPayloads([[descriptor, replacement]], limits);
  return captured(new MeshBooleanCommand(owned, payload, op), units, [payload]);
}
function splitGuardRecord(guard: VolumeSplitGuard): VolumeSplitGuard {
  return {
    volumeId: guard.volumeId,
    assetId: guard.assetId,
    assetDigest: guard.assetDigest,
    topologyRevision: guard.topologyRevision,
    triangleCount: guard.triangleCount,
    volumeFingerprint: guard.volumeFingerprint,
  };
}
function splitPartRecords(parts: readonly PreparedVolumeSplitPart[]) {
  return parts.map((part) => ({
    volumeId: part.volumeId,
    descriptor: part.asset.descriptor,
    transform: part.transform,
    sourceTriangleIndices: part.sourceTriangleIndices,
  }));
}
function ownedSplitParts(
  records: readonly {
    volumeId: VolumeId;
    descriptor: AssetPayload['descriptor'];
    transform: PreparedVolumeSplitPart['transform'];
    sourceTriangleIndices: readonly number[];
  }[],
  parts: readonly PreparedVolumeSplitPart[],
  limits: StagedInputLimits,
): PreparedVolumeSplitPart[] {
  const payloads = ownPayloads(
    records.map((record, index) => [record.descriptor, parts[index]!.asset] as const),
    limits,
  );
  return records.map((record, index) => ({
    volumeId: record.volumeId,
    asset: payloads[index]!,
    transform: record.transform,
    sourceTriangleIndices: record.sourceTriangleIndices,
  }));
}
/** `SplitVolumeToPartsCommand`. */
export function captureSplitVolumeToPartsCommand(
  guard: VolumeSplitGuard,
  parts: readonly PreparedVolumeSplitPart[],
  limits: StagedInputLimits,
): CapturedProjectCommand {
  if (!Array.isArray(parts)) throw new StagedInputError('invalid');
  const {
    value: [, owned, records],
    units,
  } = capture(['splitVolumeToParts', splitGuardRecord(guard), splitPartRecords(parts)] as const, limits);
  const split = ownedSplitParts(records, parts, limits);
  return captured(
    new SplitVolumeToPartsCommand(owned, split),
    units,
    split.map((part) => part.asset),
  );
}
function placementRecord(placement: SvgPlacement | EmbossPlacement) {
  return {
    objectId: plainStable(placement.objectId) as ObjectId,
    volumeId: plainStable(placement.volumeId) as VolumeId,
    assetId: plainStable(placement.assetId) as SvgPlacement['assetId'],
    transform: placement.transform,
  };
}
/** `AddSvgPartCommand`: the mesh, the drawing and the recipe that cut it. */
export function captureAddSvgPartCommand(
  placement: SvgPlacement,
  prepared: {
    readonly asset: AssetPayload;
    readonly drawing: AssetPayload;
    readonly mesh: { readonly triangleCount: number };
    readonly part: EmbossSvgPart;
  },
  name: string,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, owned, descriptor, drawingDescriptor, triangleCount, part, label],
    units,
  } = capture(
    [
      'addSvgPart',
      placementRecord(placement),
      prepared.asset.descriptor,
      prepared.drawing.descriptor,
      prepared.mesh.triangleCount,
      prepared.part,
      name,
    ] as const,
    limits,
  );
  const [asset, drawing] = ownPayloads(
    [
      [descriptor, prepared.asset],
      [drawingDescriptor, prepared.drawing],
    ],
    limits,
  );
  return captured(
    new AddSvgPartCommand(
      owned,
      {
        asset: asset!,
        drawing: drawing!,
        mesh: { triangleCount } as never,
        part,
        svgBytes: drawing!.bytes,
        unsupported: [],
        sizeMm: [0, 0],
      },
      label,
    ),
    units,
    [asset!, drawing!],
  );
}
/** `EditSvgPartCommand`. */
export function captureEditSvgPartCommand(
  volumeId: VolumeId,
  prepared: {
    readonly asset: AssetPayload;
    readonly mesh: { readonly triangleCount: number };
    readonly part: EmbossSvgPart;
  },
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, volume, descriptor, triangleCount, part],
    units,
  } = capture(
    ['editSvgPart', volumeId, prepared.asset.descriptor, prepared.mesh.triangleCount, prepared.part] as const,
    limits,
  );
  const [asset] = ownPayloads([[descriptor, prepared.asset]], limits);
  return captured(
    new EditSvgPartCommand(plainStable(volume) as VolumeId, {
      asset: asset!,
      drawing: asset!,
      mesh: { triangleCount } as never,
      part,
      svgBytes: new Uint8Array(),
      unsupported: [],
      sizeMm: [0, 0],
    }),
    units,
    [asset!],
  );
}
/** `AddEmbossTextCommand`. */
export function captureAddEmbossTextCommand(
  placement: EmbossPlacement,
  configuration: EmbossTextConfiguration,
  prepared: { readonly asset: AssetPayload; readonly mesh: { readonly triangleCount: number } },
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, owned, recipe, descriptor, triangleCount],
    units,
  } = capture(
    [
      'addEmbossText',
      placementRecord(placement),
      configuration,
      prepared.asset.descriptor,
      prepared.mesh.triangleCount,
    ] as const,
    limits,
  );
  const [asset] = ownPayloads([[descriptor, prepared.asset]], limits);
  return captured(new AddEmbossTextCommand(owned, recipe, { asset: asset!, mesh: { triangleCount } as never }), units, [
    asset!,
  ]);
}
/** `EditEmbossTextCommand`. */
export function captureEditEmbossTextCommand(
  volumeId: VolumeId,
  configuration: EmbossTextConfiguration,
  prepared: { readonly asset: AssetPayload; readonly mesh: { readonly triangleCount: number } },
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, volume, recipe, descriptor, triangleCount],
    units,
  } = capture(
    ['editEmbossText', volumeId, configuration, prepared.asset.descriptor, prepared.mesh.triangleCount] as const,
    limits,
  );
  const [asset] = ownPayloads([[descriptor, prepared.asset]], limits);
  return captured(
    new EditEmbossTextCommand(plainStable(volume) as VolumeId, recipe, {
      asset: asset!,
      mesh: { triangleCount } as never,
    }),
    units,
    [asset!],
  );
}
/** `ReplaceProjectCommand`: a complete next state. */
export function captureReplaceProjectCommand(
  state: ProjectState,
  label: string | undefined,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, next, owned],
    units,
  } = capture(['replaceProject', state, label ?? null] as const, limits);
  return captured(owned === null ? new ReplaceProjectCommand(next) : new ReplaceProjectCommand(next, owned), units);
}
const FACET_CHANNELS: readonly string[] = ['color', 'support', 'seam', 'fuzzySkin', 'brim'];
/** Selector nodes with exactly their fields and scalar paint values, so the
 * measured input is the input the native decoder accepts. */
function assertRefinementNode(node: unknown, depth = 0): void {
  if (depth > 64 || node === null || typeof node !== 'object' || Array.isArray(node))
    throw new StagedInputError('invalid');
  const value = node as Record<string, unknown>;
  const keys = Object.keys(value).sort().join();
  if (value.kind === 'leaf' && keys === 'kind,state') {
    const state = value.state as Record<string, unknown> | null;
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new StagedInputError('invalid');
    const stateKeys = Object.keys(state).sort().join();
    if (state.kind === 'unpainted' && stateKeys === 'kind') return;
    if (
      state.kind === 'assigned' &&
      stateKeys === 'kind,value' &&
      (typeof state.value === 'string' || typeof state.value === 'boolean')
    )
      return;
    throw new StagedInputError('invalid');
  }
  if (value.kind !== 'split' || keys !== 'children,kind,specialSide,splitSides') throw new StagedInputError('invalid');
  const sides = value.splitSides,
    special = value.specialSide;
  if (
    !Number.isInteger(sides) ||
    !Number.isInteger(special) ||
    (sides as number) < 1 ||
    (sides as number) > 3 ||
    (special as number) < 0 ||
    (special as number) > 2 ||
    (sides === 3 && special !== 0) ||
    !Array.isArray(value.children) ||
    value.children.length !== (sides as number) + 1
  )
    throw new StagedInputError('invalid');
  for (const child of value.children) assertRefinementNode(child, depth + 1);
}
/**
 * A refined selector result as one staged work: when it runs, it is
 * `commitFacetRefinement` on the session's bus, so its live-state checks refuse
 * without publishing and a result that changes nothing executes nothing.
 */
export function facetRefinementStagedWork<Channel extends FacetAnnotationChannel>(
  request: Pick<FacetRefinementCommitRequest<Channel>, 'guard' | 'channel' | 'encoding' | 'label'>,
  limits: StagedInputLimits,
): StagedProjectWork {
  const {
    value: [, guard, channel, roots, label],
    units,
  } = capture(
    [
      'facetRefinement',
      {
        revision: request.guard.revision,
        hash: request.guard.hash,
        volumeId: request.guard.volumeId,
        topologyRevision: request.guard.topologyRevision,
        triangleCount: request.guard.triangleCount,
      },
      request.channel,
      request.encoding.roots,
      request.label ?? null,
    ] as const,
    limits,
  );
  if (!FACET_CHANNELS.includes(channel) || !Number.isSafeInteger(guard.revision) || guard.revision < 0)
    throw new StagedInputError('invalid');
  plainStable(guard.volumeId);
  for (const root of roots) assertRefinementNode(root);
  const result = Object.freeze({ inputUnits: units, commandCount: 1, assetBytes: 0 });
  work.set(result, {
    commands: [],
    program: (bus) => {
      commitFacetRefinement(bus, {
        guard,
        channel: channel as Channel,
        encoding: {
          version: request.encoding.version,
          roots: roots as FacetRefinementCommitRequest<Channel>['encoding']['roots'],
        },
        ...(label === null ? {} : { label }),
      });
    },
  });
  return result;
}
/**
 * The single-volume split to objects as one staged work: the parts are
 * validated now, and the work runs `commitPreparedVolumeSplitToObjects` on the
 * session's bus, so its live-state checks refuse without publishing.
 */
export function splitToObjectsStagedWork(
  guard: VolumeSplitGuard,
  parts: readonly PreparedVolumeSplitPart[],
  identities: readonly SeparatedObjectIdentity[],
  limits: StagedInputLimits,
): StagedProjectWork {
  if (!Array.isArray(parts) || !Array.isArray(identities)) throw new StagedInputError('invalid');
  const {
    value: [, owned, records, people],
    units,
  } = capture(
    [
      'splitToObjects',
      splitGuardRecord(guard),
      splitPartRecords(parts),
      identities.map((identity) => ({
        sourceVolumeId: identity.sourceVolumeId,
        objectId: identity.objectId,
        instanceIds: identity.instanceIds,
      })),
    ] as const,
    limits,
  );
  for (const identity of people) {
    plainStable(identity.sourceVolumeId);
    plainStable(identity.objectId);
    identity.instanceIds.forEach(plainStable);
  }
  const split = ownedSplitParts(records, parts, limits);
  // Constructing validates the parts exactly as the commit will.
  void new SplitVolumeToPartsCommand(owned, split);
  const result = Object.freeze({
    inputUnits: units,
    commandCount: 2,
    assetBytes: distinctBytes(split.map((part) => part.asset)),
  });
  work.set(result, {
    commands: [],
    program: (bus) => commitPreparedVolumeSplitToObjects(bus, owned, split, people),
  });
  return result;
}
export function capturePasteCommand(
  template: ProjectObject,
  ids: IndependentObjectIds,
  destination: PlateId | undefined,
  name: string | undefined,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const {
    value: [, record, objectId, volumeIds, instanceIds, layerRangeIds, plate, label],
    units,
  } = capture(
    [
      'pasteObject',
      template,
      planField(ids, 'objectId'),
      planField(ids, 'volumeIds'),
      planField(ids, 'instanceIds'),
      planField(ids, 'layerRangeIds'),
      destination ?? null,
      name ?? null,
    ] as const,
    limits,
  );
  stable(objectId);
  volumeIds.forEach(stable);
  instanceIds.forEach(stable);
  layerRangeIds.forEach(stable);
  if (plate !== null) stable(plate);
  return captured(
    new PasteObjectCommand(
      record,
      { objectId, volumeIds, instanceIds, layerRangeIds },
      { ...(plate === null ? {} : { destinationPlateId: plate }), ...(label === null ? {} : { name: label }) },
    ),
    units,
  );
}
/** Local adapter with repository-owned TypeScript capabilities. Native hosts
 * use separate native clipboard captures; no payload bytes enter command JSON. */
export function captureClipboardPasteCommand(
  template: ProjectObject,
  ids: IndependentObjectIds,
  destination: PlateId | undefined,
  repository: AssetRepository,
  assets: AssetRepositorySelection,
  limits: StagedInputLimits,
): CapturedProjectCommand {
  const selected = repository.inspectSelection(assets);
  const {
    value: [, record, objectId, volumeIds, instanceIds, layerRangeIds, plate],
    units,
  } = capture(
    [
      'pasteObjectWithAssets',
      template,
      planField(ids, 'objectId'),
      planField(ids, 'volumeIds'),
      planField(ids, 'instanceIds'),
      planField(ids, 'layerRangeIds'),
      destination ?? null,
      selected.descriptors,
    ] as const,
    limits,
  );
  stable(objectId);
  volumeIds.forEach(stable);
  instanceIds.forEach(stable);
  layerRangeIds.forEach(stable);
  if (plate !== null) stable(plate);
  return captured(
    new PasteObjectCommand(
      record,
      { objectId, volumeIds, instanceIds, layerRangeIds },
      plate === null ? {} : { destinationPlateId: plate },
      selected,
    ),
    units,
  );
}

export function captureSmallIntent(intent: ProjectIntentWire, maxUnits: number): CapturedProjectCommand {
  return captureSmallIntentJson(encodeProjectIntent(intent), maxUnits);
}
export function captureSmallIntentJson(json: string, maxUnits: number): CapturedProjectCommand {
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new StagedInputError('invalid');
  const inputUnits = json.length + '["intent",]'.length;
  if (inputUnits > maxUnits) throw new StagedInputError('limit');
  return captured(prepareProjectIntent(decodeProjectIntent(json)), inputUnits);
}
export function singleStagedWork(command: CapturedProjectCommand): StagedProjectWork {
  const owned = commands.get(command);
  if (!owned) throw new StagedInputError('invalid');
  commands.delete(command);
  const result = Object.freeze({ inputUnits: command.inputUnits, commandCount: 1, assetBytes: command.assetBytes });
  work.set(result, { commands: [owned.command] });
  return result;
}
export function transactionStagedWork(
  label: string,
  values: readonly CapturedProjectCommand[],
  maxUnits: number,
): StagedProjectWork {
  const { units: overhead } = capture([label, []], { maxUnits, maxNodes: 3, maxDepth: 2 });
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype)
    throw new StagedInputError('invalid');
  if (values.length > maxUnits) throw new StagedInputError('limit');
  if (Reflect.ownKeys(values).length !== values.length + 1) throw new StagedInputError('invalid');
  const capturedValues: CapturedProjectCommand[] = [];
  for (let i = 0; i < values.length; i++) {
    const field = Object.getOwnPropertyDescriptor(values, String(i));
    if (!field?.enumerable || !('value' in field)) throw new StagedInputError('invalid');
    capturedValues.push(field.value);
  }
  if (new Set(capturedValues).size !== capturedValues.length) throw new StagedInputError('invalid');
  let inputUnits = overhead;
  const owned = capturedValues.map((value, i) => {
    const command = commands.get(value);
    if (!command) throw new StagedInputError('invalid');
    const units = value.inputUnits + Number(i > 0);
    if (units > maxUnits - inputUnits) throw new StagedInputError('limit');
    inputUnits += units;
    return command;
  });
  const assetBytes = distinctBytes(owned.flatMap((command) => command.payloads));
  for (const value of capturedValues) commands.delete(value);
  const result = Object.freeze({ inputUnits, commandCount: owned.length, assetBytes });
  work.set(result, { label, commands: owned.map((command) => command.command) });
  return result;
}
/** Session-only destructive handoff; arbitrary caller-authored objects never
 * become measured work. A rejected admission consumes and releases its input. */
export function takeStagedWork(value: StagedProjectWork): OwnedWork {
  const owned = work.get(value);
  if (!owned) throw new StagedInputError('invalid');
  work.delete(value);
  return owned;
}
export function discardStagedWork(value: StagedProjectWork): void {
  work.delete(value);
}
/** A queued closure keeps this small slot, not a captured command. Cancellation
 * releases its payload immediately; a reentrant cancellation during synchronous
 * commit cannot undo the local work already taken by the authority. */
export class StagedWorkSlot {
  private running = false;
  private released = false;
  constructor(
    private payload: OwnedWork | undefined,
    private readonly releaseCharge: () => void,
  ) {}
  take(): OwnedWork {
    if (!this.payload || this.running || this.released) throw new StagedInputError('invalid');
    const result = this.payload;
    this.payload = undefined;
    this.running = true;
    return result;
  }
  release(): void {
    if (this.running || this.released) return;
    this.payload = undefined;
    this.released = true;
    this.releaseCharge();
  }
  finish(): void {
    this.running = false;
    this.release();
  }
}
