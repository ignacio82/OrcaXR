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
import { scopesForSetting, settingScopeAllows, type SettingScope } from './settingScopes';

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

export interface IgnoredScopedSetting {
  key: string;
  scope: ConfigScopeRef;
  reason: string;
}

export interface ResolvedConfig {
  effective: ConfigMap;
  inherited: ConfigMap;
  local: ConfigMap;
  sourceByKey: Record<string, ConfigScopeRef>;
  /**
   * Keys stored at a scope the engine does not read them from. Reported rather
   * than layered, so a UI can say why a value that looks set has no effect
   * instead of showing it as if it did.
   */
  ignored: IgnoredScopedSetting[];
}

const SCOPE_REF_TO_SETTING_SCOPE: Readonly<Record<ConfigScopeRef['kind'], SettingScope>> = {
  project: 'project',
  plate: 'plate',
  object: 'object',
  volume: 'part',
  'layer-range': 'layerRange',
};

/**
 * Layer the scopes the way `region_config_from_model_volume` does.
 *
 * A part and a height range are not siblings: the engine applies the object's
 * config, then the part's, then the range's, so a range that cuts through a
 * part overrides it. The push order below *is* that precedence — see
 * `domain/settingScopes.ts`, where the same order is generated from the pinned
 * engine source rather than assumed.
 */
export function resolveConfig(state: ProjectState, request: ConfigResolutionRequest): ResolvedConfig {
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
  const ignored: IgnoredScopedSetting[] = [];
  for (const scope of scopes) {
    const settingScope = SCOPE_REF_TO_SETTING_SCOPE[scope.ref.kind];
    for (const [key, value] of Object.entries(scope.config)) {
      // Storing a key where the engine will not read it is not a weaker form of
      // setting it — it does nothing at all, so layering it here would make
      // every reader disagree with the slice.
      if (!settingScopeAllows(settingScope, key)) {
        ignored.push({ key, scope: scope.ref, reason: describeOutOfScope(settingScope, key) });
        continue;
      }
      effective[key] = value;
      sourceByKey[key] = scope.ref;
    }
  }
  const stored = scopes.at(-1)?.config ?? {};
  const local: ConfigMap = {};
  for (const [key, value] of Object.entries(stored)) {
    if (Object.prototype.hasOwnProperty.call(effective, key)) local[key] = value;
  }
  const inherited: ConfigMap = {};
  for (const [key, value] of Object.entries(effective)) {
    if (!Object.prototype.hasOwnProperty.call(local, key)) inherited[key] = value;
  }
  return {
    effective: { ...effective },
    inherited,
    local,
    sourceByKey,
    ignored,
  };
}

function describeOutOfScope(scope: SettingScope, key: string): string {
  const allowed = scopesForSetting(key);
  if (allowed.length === 0) return `${key} is not a setting the engine reads from a project node`;
  return `${key} is read from the ${allowed.join(', ')} scope, not from the ${scope} scope`;
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
