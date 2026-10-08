/**
 * The renderer's view of a canonical project, and the revisioned deltas a host
 * subscribes to instead of receiving the whole project after every edit.
 *
 * The projection is normalized so that one edit changes few records: a plate
 * carries whether it is active, an instance its own transform and printable
 * flag, and a volume — once per object, not per instance — its mesh, role,
 * transform and resolved display colour. Switching plates touches plates,
 * recolouring a filament touches the volumes that use it, and moving an
 * instance touches that instance alone. Names, paint and settings belong to
 * other projections; geometry bytes are read from the asset repository by ID.
 *
 * A {@link RenderFeed} answers pages of the change list between two acknowledged
 * snapshots. It retains the snapshots it has served, so a host that applied a
 * page's target asks for the next delta from it; a base it no longer holds is
 * answered from empty with no base, which tells the host to rebuild. The Rust
 * session serves the same pages (`orcaxr_project::render`).
 */
import type {
  ProjectOptionalRenderCursorWire,
  ProjectRenderChangeWire,
  ProjectRenderPageWire,
  ProjectRenderRequestWire,
  ProjectVolumeRoleNameWire,
} from '../../../contracts/generated/project-intents';
import type { AssetId, InstanceId, ObjectId, PlateId, VolumeId } from './domain/ids';
import type { ProjectObject, ProjectState, ProjectVolume, Transform, VolumeRole } from './domain/model';
import { resolveFilament } from './domain/selectors';
import type { ProjectSnapshot } from './store';

/** The most changes one page may hold. */
export const RENDER_PAGE_LIMIT = 64;
/** Served snapshots a feed keeps as bases and page targets. */
export const RENDER_RETAINED_SNAPSHOTS = 8;

export interface RenderPlate {
  readonly plateId: PlateId;
  readonly order: number;
  readonly printable: boolean;
  readonly active: boolean;
}

export interface RenderInstance {
  readonly instanceId: InstanceId;
  readonly objectId: ObjectId;
  readonly plateId: PlateId;
  readonly transform: Transform;
  readonly printable: boolean;
}

export interface RenderVolume {
  readonly volumeId: VolumeId;
  readonly objectId: ObjectId;
  readonly role: VolumeRole;
  readonly assetId: AssetId;
  readonly triangleCount: number;
  readonly transform: Transform;
  /** Absent when nothing is assigned: the host keeps its neutral material. */
  readonly color?: string;
}

/** Plates by order; objects, instances and volumes in document order. */
export interface RenderProjection {
  readonly plates: readonly RenderPlate[];
  readonly instances: readonly RenderInstance[];
  readonly volumes: readonly RenderVolume[];
}

export type RenderChange =
  | { readonly kind: 'plate'; readonly plate: RenderPlate }
  | { readonly kind: 'instance'; readonly instance: RenderInstance }
  | { readonly kind: 'volume'; readonly volume: RenderVolume }
  | { readonly kind: 'remove-plate'; readonly id: PlateId }
  | { readonly kind: 'remove-instance'; readonly id: InstanceId }
  | { readonly kind: 'remove-volume'; readonly id: VolumeId };

export interface RenderCursor {
  readonly revision: number;
  readonly semanticHash: string;
}

export interface RenderRequest {
  /** The snapshot the host shows; absent to start from empty. */
  readonly base?: RenderCursor;
  /** The snapshot being paged; absent for the session's current one. */
  readonly target?: RenderCursor;
  readonly start: number;
  readonly count: number;
}

export interface RenderPage {
  /** The base the changes apply to; absent when they start from empty. */
  readonly base?: RenderCursor;
  readonly target: RenderCursor;
  readonly total: number;
  readonly changes: readonly RenderChange[];
}

export type RenderRefusalCode = 'invalid-request' | 'stale';

export class RenderRefusal extends Error {
  constructor(readonly code: RenderRefusalCode) {
    super(
      code === 'stale' ? 'The requested render target is no longer retained' : 'Render pages hold at most 64 changes',
    );
    this.name = 'RenderRefusal';
  }
}

/**
 * Display colour of the filament a volume resolves to: a physical tool's own
 * colour, or a mixed recipe's stored display colour. Undefined when nothing is
 * assigned, never a guess borrowed from another tool.
 */
export function volumeDisplayColor(
  state: ProjectState,
  object: ProjectObject,
  volume: ProjectVolume,
): string | undefined {
  const filamentId = resolveFilament(object, volume).effective;
  if (!filamentId) return undefined;
  const physical = state.filaments.physical.find((filament) => filament.id === filamentId);
  if (physical) return physical.color;
  return state.filaments.mixed.find((filament) => filament.id === filamentId)?.displayColor;
}

export function projectRender(state: ProjectState): RenderProjection {
  const plates: RenderPlate[] = [];
  const instances: RenderInstance[] = [];
  const volumes: RenderVolume[] = [];
  for (const plate of [...state.plates].sort((left, right) => left.order - right.order)) {
    plates.push({
      plateId: plate.id,
      order: plate.order,
      printable: plate.printable,
      active: plate.id === state.activePlateId,
    });
    for (const object of plate.objects) {
      for (const instance of object.instances) {
        instances.push({
          instanceId: instance.id,
          objectId: object.id,
          plateId: plate.id,
          transform: instance.transform,
          printable: instance.printable,
        });
      }
      for (const volume of object.volumes) {
        const color = volumeDisplayColor(state, object, volume);
        volumes.push({
          volumeId: volume.id,
          objectId: object.id,
          role: volume.role,
          assetId: volume.source.assetId,
          triangleCount: volume.source.triangleCount,
          transform: volume.transform,
          ...(color === undefined ? {} : { color }),
        });
      }
    }
  }
  return { plates, instances, volumes };
}

/**
 * The changes that turn `base` (or an empty scene) into `target`: removals
 * first, children before parents, in the base's order; then records that are
 * new or differ, parents before children, in the target's order.
 */
export function diffRender(base: RenderProjection | undefined, target: RenderProjection): RenderChange[] {
  const changes: RenderChange[] = [];
  const removed = <T>(previous: readonly T[] | undefined, next: readonly T[], key: (record: T) => string) => {
    const kept = new Set(next.map(key));
    return (previous ?? []).filter((record) => !kept.has(key(record))).map(key);
  };
  const changed = <T>(
    previous: readonly T[] | undefined,
    next: readonly T[],
    key: (record: T) => string,
    same: (left: T, right: T) => boolean,
  ) => {
    const prior = new Map((previous ?? []).map((record) => [key(record), record]));
    return next.filter((record) => {
      const before = prior.get(key(record));
      return !before || !same(before, record);
    });
  };
  for (const id of removed(base?.volumes, target.volumes, (v) => v.volumeId)) {
    changes.push({ kind: 'remove-volume', id: id as VolumeId });
  }
  for (const id of removed(base?.instances, target.instances, (i) => i.instanceId)) {
    changes.push({ kind: 'remove-instance', id: id as InstanceId });
  }
  for (const id of removed(base?.plates, target.plates, (p) => p.plateId)) {
    changes.push({ kind: 'remove-plate', id: id as PlateId });
  }
  for (const plate of changed(base?.plates, target.plates, (p) => p.plateId, samePlate)) {
    changes.push({ kind: 'plate', plate });
  }
  for (const instance of changed(base?.instances, target.instances, (i) => i.instanceId, sameInstance)) {
    changes.push({ kind: 'instance', instance });
  }
  for (const volume of changed(base?.volumes, target.volumes, (v) => v.volumeId, sameVolume)) {
    changes.push({ kind: 'volume', volume });
  }
  return changes;
}

/**
 * Pages of revisioned deltas over one session's snapshots. `current` reads the
 * session's acknowledged snapshot; the feed never sees optimistic UI state.
 */
export class RenderFeed {
  private readonly retained: ProjectSnapshot[] = [];
  private cached: { base?: ProjectSnapshot; target: ProjectSnapshot; changes: RenderChange[] } | undefined;

  constructor(private readonly current: () => ProjectSnapshot) {}

  page(request: RenderRequest): RenderPage {
    if (request.count > RENDER_PAGE_LIMIT) throw new RenderRefusal('invalid-request');
    const current = this.current();
    const target = request.target ? this.find(current, request.target) : current;
    if (!target) throw new RenderRefusal('stale');
    const base = request.base ? this.find(current, request.base) : undefined;
    if (base) this.retain(base);
    this.retain(target);
    const changes = this.changes(base, target);
    const start = Math.min(request.start, changes.length);
    return {
      ...(base ? { base: cursorOf(base) } : {}),
      target: cursorOf(target),
      total: changes.length,
      changes: changes.slice(start, start + request.count),
    };
  }

  private changes(base: ProjectSnapshot | undefined, target: ProjectSnapshot): RenderChange[] {
    const cached = this.cached;
    if (cached && cached.base === base && cached.target === target) return cached.changes;
    const changes = diffRender(base && projectRender(base.state), projectRender(target.state));
    this.cached = { ...(base ? { base } : {}), target, changes };
    return changes;
  }

  private find(current: ProjectSnapshot, cursor: RenderCursor): ProjectSnapshot | undefined {
    const matches = (snapshot: ProjectSnapshot) =>
      snapshot.revision === cursor.revision && snapshot.hash === cursor.semanticHash;
    if (matches(current)) return current;
    return this.retained.find(matches);
  }

  /** Most recently served last; the oldest is released past the bound. */
  private retain(snapshot: ProjectSnapshot): void {
    const index = this.retained.findIndex((held) => held.revision === snapshot.revision && held.hash === snapshot.hash);
    if (index >= 0) this.retained.splice(index, 1);
    this.retained.push(snapshot);
    if (this.retained.length > RENDER_RETAINED_SNAPSHOTS) this.retained.shift();
  }
}

export function renderRequestFromWire(wire: ProjectRenderRequestWire, text: (units: readonly number[]) => string) {
  const cursor = (value: ProjectOptionalRenderCursorWire): RenderCursor | undefined =>
    'value' in value ? { revision: value.value.revision, semanticHash: text(value.value.semanticHash) } : undefined;
  const base = cursor(wire.base);
  const target = cursor(wire.target);
  return {
    ...(base ? { base } : {}),
    ...(target ? { target } : {}),
    start: wire.start,
    count: wire.count,
  } satisfies RenderRequest;
}

export function renderPageWire(page: RenderPage, units: (text: string) => number[]): ProjectRenderPageWire {
  const cursor = (value: RenderCursor) => ({ revision: value.revision, semanticHash: units(value.semanticHash) });
  const transform = (value: Transform) => ({
    translationMm: [...value.translationMm],
    rotation: [...value.rotation],
    scale: [...value.scale],
  });
  const change = (entry: RenderChange): ProjectRenderChangeWire => {
    switch (entry.kind) {
      case 'plate':
        return {
          plate: {
            plateId: units(entry.plate.plateId),
            order: entry.plate.order,
            printable: entry.plate.printable,
            active: entry.plate.active,
          },
        };
      case 'instance':
        return {
          instance: {
            instanceId: units(entry.instance.instanceId),
            objectId: units(entry.instance.objectId),
            plateId: units(entry.instance.plateId),
            transform: transform(entry.instance.transform),
            printable: entry.instance.printable,
          },
        };
      case 'volume':
        return {
          volume: {
            volumeId: units(entry.volume.volumeId),
            objectId: units(entry.volume.objectId),
            role: roleWire(entry.volume.role),
            assetId: units(entry.volume.assetId),
            triangleCount: entry.volume.triangleCount,
            transform: transform(entry.volume.transform),
            color: entry.volume.color === undefined ? { absent: {} } : { value: units(entry.volume.color) },
          },
        };
      case 'remove-plate':
        return { removePlate: units(entry.id) };
      case 'remove-instance':
        return { removeInstance: units(entry.id) };
      case 'remove-volume':
        return { removeVolume: units(entry.id) };
    }
  };
  return {
    base: page.base ? { value: cursor(page.base) } : { absent: {} },
    target: cursor(page.target),
    total: page.total,
    changes: page.changes.map(change),
  };
}

function roleWire(role: VolumeRole): ProjectVolumeRoleNameWire {
  return role.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as ProjectVolumeRoleNameWire;
}

function cursorOf(snapshot: ProjectSnapshot): RenderCursor {
  return { revision: snapshot.revision, semanticHash: snapshot.hash };
}

function sameTransform(left: Transform, right: Transform): boolean {
  const same = (a: readonly number[], b: readonly number[]) => a.every((value, index) => value === b[index]);
  return (
    same(left.translationMm, right.translationMm) &&
    same(left.rotation, right.rotation) &&
    same(left.scale, right.scale)
  );
}

function samePlate(left: RenderPlate, right: RenderPlate): boolean {
  return left.order === right.order && left.printable === right.printable && left.active === right.active;
}

function sameInstance(left: RenderInstance, right: RenderInstance): boolean {
  return (
    left.objectId === right.objectId &&
    left.plateId === right.plateId &&
    left.printable === right.printable &&
    sameTransform(left.transform, right.transform)
  );
}

function sameVolume(left: RenderVolume, right: RenderVolume): boolean {
  return (
    left.objectId === right.objectId &&
    left.role === right.role &&
    left.assetId === right.assetId &&
    left.triangleCount === right.triangleCount &&
    left.color === right.color &&
    sameTransform(left.transform, right.transform)
  );
}
