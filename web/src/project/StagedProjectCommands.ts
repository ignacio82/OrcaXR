import {
  decodeProjectIntent,
  encodeProjectIntent,
  type ProjectIntentWire,
} from '../../../contracts/generated/project-intents';
import { isStableEntityId, type ObjectId, type PlateId } from './domain/ids';
import type { ProjectInstance, ProjectObject } from './domain/model';
import { CreateInstanceCommand, PasteObjectCommand, type IndependentObjectIds } from './objects/commands';
import { prepareProjectIntent } from './PreparedProjectCommands';
import type { ProjectCommand } from './history/command';
import type { AssetRepository, AssetRepositorySelection } from './assets';

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
}
export interface CapturedProjectCommand {
  readonly inputUnits: number;
}
export interface StagedProjectWork {
  readonly inputUnits: number;
  readonly commandCount: number;
}
export interface ProjectStagingLimits {
  readonly maxResources: number;
  readonly maxCommands: number;
  readonly maxUnits: number;
}
export interface ProjectStagingUsage {
  readonly resources: number;
  readonly commands: number;
  readonly units: number;
}
interface OwnedWork {
  readonly commands: readonly ProjectCommand[];
  readonly label?: string;
}
const commands = new WeakMap<CapturedProjectCommand, ProjectCommand>();
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
function captured(command: ProjectCommand, inputUnits: number): CapturedProjectCommand {
  const result = Object.freeze({ inputUnits });
  commands.set(result, command);
  return result;
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
  const result = Object.freeze({ inputUnits: command.inputUnits, commandCount: 1 });
  work.set(result, { commands: [owned] });
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
  for (const value of capturedValues) commands.delete(value);
  const result = Object.freeze({ inputUnits, commandCount: owned.length });
  work.set(result, { label, commands: owned });
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
