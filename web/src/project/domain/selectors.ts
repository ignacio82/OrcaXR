import type {
  ConfigMap,
  JsonValue,
  LayerRange,
  ProjectInstance,
  ProjectObject,
  ProjectPlate,
  ProjectState,
  ProjectVolume,
} from './model';
import type { FilamentId, InstanceId, LayerRangeId, ObjectId, PlateId, VolumeId } from './ids';

export function findPlate(state: ProjectState, id: PlateId): ProjectPlate | undefined {
  return state.plates.find((plate) => plate.id === id);
}

export function findObject(
  state: ProjectState,
  id: ObjectId,
): { plate: ProjectPlate; object: ProjectObject } | undefined {
  for (const plate of state.plates) {
    const object = plate.objects.find((candidate) => candidate.id === id);
    if (object) return { plate, object };
  }
  return undefined;
}

export function findVolume(
  state: ProjectState,
  id: VolumeId,
): { plate: ProjectPlate; object: ProjectObject; volume: ProjectVolume } | undefined {
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      const volume = object.volumes.find((candidate) => candidate.id === id);
      if (volume) return { plate, object, volume };
    }
  }
  return undefined;
}

export function findInstance(
  state: ProjectState,
  id: InstanceId,
): { plate: ProjectPlate; object: ProjectObject; instance: ProjectInstance } | undefined {
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      const instance = object.instances.find((candidate) => candidate.id === id);
      if (instance) return { plate, object, instance };
    }
  }
  return undefined;
}

export function findLayerRange(
  state: ProjectState,
  id: LayerRangeId,
): { plate: ProjectPlate; object: ProjectObject; layerRange: LayerRange } | undefined {
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      const layerRange = object.layerRanges.find((candidate) => candidate.id === id);
      if (layerRange) return { plate, object, layerRange };
    }
  }
  return undefined;
}

export type ConfigScopeRef =
  | { kind: 'project' }
  | { kind: 'plate'; id: PlateId }
  | { kind: 'object'; id: ObjectId }
  | { kind: 'volume'; id: VolumeId }
  | { kind: 'layer-range'; id: LayerRangeId };

export interface ConfigResolutionRequest {
  plateId: PlateId;
  objectId?: ObjectId;
  volumeId?: VolumeId;
  layerRangeId?: LayerRangeId;
}

export interface ResolvedConfig {
  effective: ConfigMap;
  inherited: ConfigMap;
  local: ConfigMap;
  sourceByKey: Record<string, ConfigScopeRef>;
}

export function resolveConfig(state: ProjectState, request: ConfigResolutionRequest): ResolvedConfig {
  if (request.volumeId && request.layerRangeId) {
    throw new Error('Volume and layer-range settings are sibling scopes, not a combined scope');
  }
  const plate = findPlate(state, request.plateId);
  if (!plate) throw new Error(`Unknown plate ${request.plateId}`);

  const scopes: Array<{ ref: ConfigScopeRef; config: ConfigMap }> = [
    { ref: { kind: 'project' }, config: state.config },
    { ref: { kind: 'plate', id: plate.id }, config: plate.config },
  ];
  let object: ProjectObject | undefined;
  if (request.objectId) {
    object = plate.objects.find((candidate) => candidate.id === request.objectId);
    if (!object) throw new Error(`Object ${request.objectId} is not on plate ${plate.id}`);
    scopes.push({ ref: { kind: 'object', id: object.id }, config: object.config });
  }
  if (request.volumeId) {
    if (!object) throw new Error('Resolving a volume requires objectId');
    const volume = object.volumes.find((candidate) => candidate.id === request.volumeId);
    if (!volume) throw new Error(`Volume ${request.volumeId} is not on object ${object.id}`);
    scopes.push({ ref: { kind: 'volume', id: volume.id }, config: volume.config });
  }
  if (request.layerRangeId) {
    if (!object) throw new Error('Resolving a layer range requires objectId');
    const range = object.layerRanges.find((candidate) => candidate.id === request.layerRangeId);
    if (!range) throw new Error(`Layer range ${request.layerRangeId} is not on object ${object.id}`);
    scopes.push({ ref: { kind: 'layer-range', id: range.id }, config: range.config });
  }

  const effective: ConfigMap = {};
  const sourceByKey: Record<string, ConfigScopeRef> = {};
  for (const scope of scopes) {
    for (const [key, value] of Object.entries(scope.config)) {
      effective[key] = value;
      sourceByKey[key] = scope.ref;
    }
  }
  const local = scopes.at(-1)?.config ?? {};
  const inherited: ConfigMap = {};
  for (const [key, value] of Object.entries(effective)) {
    if (!Object.prototype.hasOwnProperty.call(local, key)) inherited[key] = value;
  }
  return {
    effective: { ...effective },
    inherited,
    local: { ...local },
    sourceByKey,
  };
}

export interface ResolvedFilament {
  effective?: FilamentId;
  local?: FilamentId;
  inherited?: FilamentId;
  source: 'none' | 'object' | 'volume' | 'layer-range';
}

export function resolveFilament(object: ProjectObject, child?: ProjectVolume | LayerRange): ResolvedFilament {
  if (child?.filamentId) {
    return {
      effective: child.filamentId,
      local: child.filamentId,
      inherited: object.filamentId,
      source: 'role' in child ? 'volume' : 'layer-range',
    };
  }
  if (object.filamentId) {
    return {
      effective: object.filamentId,
      inherited: object.filamentId,
      source: 'object',
    };
  }
  return { source: 'none' };
}

export function allProjectObjects(state: ProjectState): ProjectObject[] {
  return state.plates.flatMap((plate) => plate.objects);
}

export function configValue(resolution: ResolvedConfig, key: string): JsonValue | undefined {
  return resolution.effective[key];
}

export interface TopologyGuard {
  volumeId: VolumeId;
  topologyRevision: number;
}

export function isTopologyCurrent(state: ProjectState, guard: TopologyGuard): boolean {
  const found = findVolume(state, guard.volumeId);
  return found?.volume.source.topologyRevision === guard.topologyRevision;
}
