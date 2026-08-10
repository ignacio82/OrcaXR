/**
 * One editing path for overrides at every scope (P6.5).
 *
 * `settingsOverrides.ts` already owns the project scope, where the stored shape
 * is a triple — inherited base, explicit overrides, and the effective config
 * the engine receives. A plate, object, part, or height range stores only the
 * overrides; their base is the chain above them. Two storage shapes, but one
 * entry point, so a caller asks "set these keys on this node" and never has to
 * know which of the two it landed in.
 *
 * Three rules hold everywhere:
 *
 * - **Authoring is strict.** An override the engine will not read at that scope
 *   is refused, not dropped. `docs/parity.md` P6.5 asks for shared validation;
 *   the failure it prevents is a project that looks configured and slices as if
 *   it were not.
 *
 * - **Reading is lossless.** A node's stored map is not only overrides: a plate
 *   carries `locked`, an imported object can still carry `extruder`. Those keys
 *   are reported separately and written back untouched, because P1's lossless
 *   3MF guarantee outranks tidiness — a key silently dropped on open is a key
 *   the user never gets back.
 *
 * - **Precedence comes from the engine.** The chain is ordered by
 *   `SETTING_SCOPE_ORDER`, generated from `region_config_from_model_volume`, so
 *   a height range outranks the part it cuts through even though every UI nests
 *   it the other way round.
 */

import { canonicalStringify, cloneJson, cloneProjectState } from './domain/canonical';
import type { LayerRangeId, ObjectId, PlateId, VolumeId } from './domain/ids';
import type { ConfigMap, JsonValue, ProjectState } from './domain/model';
import { findLayerRange, findObject, findPlate, findVolume } from './domain/selectors';
import {
  SettingScopeError,
  explainSetting,
  resolveScopedConfig,
  sanitizeScopedOverrides,
  settingScopeAllows,
  type ScopedOverrideLayer,
  type SettingResolution,
  type SettingScope,
  type SettingScopeIssue,
  SETTING_SCOPE_KEYS,
} from './domain/settingScopes';
import { assertValidProjectState } from './domain/validation';
import type { CommandContext, ProjectCommand } from './history/command';
import { applyProjectSettingsOverrides } from './settingsOverrides';
import type { ProjectSnapshot } from './store';

export type ScopedOverrideTarget =
  | { readonly scope: 'project' }
  | { readonly scope: 'plate'; readonly plateId: PlateId }
  | { readonly scope: 'object'; readonly objectId: ObjectId }
  | { readonly scope: 'part'; readonly volumeId: VolumeId }
  | { readonly scope: 'layerRange'; readonly layerRangeId: LayerRangeId };

export interface ScopedOverrideGuard {
  readonly sourceRevision: number;
  readonly sourceHash: string;
}

/** One rung of the chain above a target, named so a UI can say who won. */
export interface ScopedOverrideChainEntry {
  readonly scope: SettingScope;
  readonly id?: string;
  readonly label: string;
  readonly overrides: Readonly<ConfigMap>;
  /** True for the rung the caller asked about. */
  readonly isTarget: boolean;
}

export interface ScopedOverrideSnapshot extends ScopedOverrideGuard {
  readonly target: ScopedOverrideTarget;
  readonly scope: SettingScope;
  readonly label: string;
  /** Every key the engine reads at this scope, sorted. */
  readonly allowedKeys: readonly string[];
  /** In-scope keys the node currently overrides. */
  readonly overrides: Readonly<ConfigMap>;
  /**
   * Keys stored on the node that this scope does not own. Preserved verbatim
   * on write; surfaced so the panel can explain them instead of hiding them.
   */
  readonly foreign: Readonly<ConfigMap>;
  readonly foreignIssues: readonly SettingScopeIssue[];
  readonly chain: readonly ScopedOverrideChainEntry[];
  /**
   * The chain resolved *without* this node's own overrides — what the node
   * would slice as if every one of its overrides were cleared. This is the
   * baseline an editor shows as "inherited".
   */
  readonly inheritedConfig: Readonly<ConfigMap>;
  /** The chain resolved in engine precedence order, project config included. */
  readonly effectiveConfig: Readonly<ConfigMap>;
}

export class UnknownScopedOverrideTargetError extends Error {
  override readonly name = 'UnknownScopedOverrideTargetError';

  constructor(target: ScopedOverrideTarget) {
    super(`No ${target.scope} node matches ${describeTargetId(target) ?? 'the requested target'}`);
  }
}

export class StaleScopedOverrideError extends Error {
  override readonly name = 'StaleScopedOverrideError';

  constructor() {
    super('Scoped setting overrides were prepared for a stale canonical project revision');
  }
}

function describeTargetId(target: ScopedOverrideTarget): string | undefined {
  switch (target.scope) {
    case 'plate':
      return target.plateId;
    case 'object':
      return target.objectId;
    case 'part':
      return target.volumeId;
    case 'layerRange':
      return target.layerRangeId;
    default:
      return undefined;
  }
}

interface ResolvedTarget {
  readonly label: string;
  /** The node's whole stored map, overrides and pass-through keys alike. */
  readonly stored: Readonly<ConfigMap>;
  /** Ancestors, highest scope first, excluding the target itself. */
  readonly ancestors: readonly ScopedOverrideChainEntry[];
  /** Replace the node's stored map inside a mutable state clone. */
  readonly write: (state: ProjectState, next: ConfigMap) => void;
}

function projectEntry(state: ProjectState): ScopedOverrideChainEntry {
  return {
    scope: 'project',
    label: 'Project',
    overrides: inScopeOnly('project', state.settingsOverrides ?? {}),
    isTarget: false,
  };
}

/**
 * Locate a target and everything above it.
 *
 * The ancestors are read from the *containment* path — the plate an object sits
 * on, the object a part belongs to — while their precedence comes from
 * `SETTING_SCOPE_ORDER`. Those two are not the same thing, which is the whole
 * reason the order is generated rather than inferred from the walk.
 */
function resolveTarget(state: ProjectState, target: ScopedOverrideTarget): ResolvedTarget {
  switch (target.scope) {
    case 'project':
      return {
        label: 'Project',
        stored: state.settingsOverrides ?? {},
        ancestors: [],
        write: () => {
          throw new Error('Project overrides are written through SetProjectSettingsOverridesCommand');
        },
      };
    case 'plate': {
      const plate = findPlate(state, target.plateId);
      if (!plate) throw new UnknownScopedOverrideTargetError(target);
      return {
        label: plate.name || 'Plate',
        stored: plate.config,
        ancestors: [projectEntry(state)],
        write: (next, config) => {
          const node = findPlate(next, target.plateId);
          if (!node) throw new UnknownScopedOverrideTargetError(target);
          node.config = config;
        },
      };
    }
    case 'object': {
      const found = findObject(state, target.objectId);
      if (!found) throw new UnknownScopedOverrideTargetError(target);
      return {
        label: found.object.name || 'Object',
        stored: found.object.config,
        ancestors: [projectEntry(state), plateEntry(found.plate)],
        write: (next, config) => {
          const node = findObject(next, target.objectId);
          if (!node) throw new UnknownScopedOverrideTargetError(target);
          node.object.config = config;
        },
      };
    }
    case 'part': {
      const found = findVolume(state, target.volumeId);
      if (!found) throw new UnknownScopedOverrideTargetError(target);
      return {
        label: found.volume.name || 'Part',
        stored: found.volume.config,
        ancestors: [projectEntry(state), plateEntry(found.plate), objectEntry(found.object)],
        write: (next, config) => {
          const node = findVolume(next, target.volumeId);
          if (!node) throw new UnknownScopedOverrideTargetError(target);
          node.volume.config = config;
        },
      };
    }
    case 'layerRange': {
      const found = findLayerRange(state, target.layerRangeId);
      if (!found) throw new UnknownScopedOverrideTargetError(target);
      const range = found.layerRange;
      return {
        label: `${range.minZMm}–${range.maxZMm} mm`,
        stored: range.config,
        ancestors: [projectEntry(state), plateEntry(found.plate), objectEntry(found.object)],
        write: (next, config) => {
          const node = findLayerRange(next, target.layerRangeId);
          if (!node) throw new UnknownScopedOverrideTargetError(target);
          node.layerRange.config = config;
        },
      };
    }
  }
}

function plateEntry(plate: { id: PlateId; name: string; config: ConfigMap }): ScopedOverrideChainEntry {
  return {
    scope: 'plate',
    id: plate.id,
    label: plate.name || 'Plate',
    overrides: inScopeOnly('plate', plate.config),
    isTarget: false,
  };
}

function objectEntry(object: { id: ObjectId; name: string; config: ConfigMap }): ScopedOverrideChainEntry {
  return {
    scope: 'object',
    id: object.id,
    label: object.name || 'Object',
    overrides: inScopeOnly('object', object.config),
    isTarget: false,
  };
}

/**
 * The part of a stored map this scope actually owns.
 *
 * Pass-through keys are excluded rather than raising, because a chain is built
 * for reading and a foreign key on some ancestor is not the caller's problem.
 */
function inScopeOnly(scope: SettingScope, stored: Readonly<ConfigMap>): ConfigMap {
  return sanitizeScopedOverrides(scope, stored).overrides;
}

/** Everything a surface needs to render and edit one node's overrides. */
export function scopedOverrideSnapshot(
  snapshot: ProjectSnapshot,
  target: ScopedOverrideTarget,
): ScopedOverrideSnapshot {
  const state = snapshot.state;
  const resolved = resolveTarget(state, target);
  const targetId = describeTargetId(target);
  const split = sanitizeScopedOverrides(target.scope, resolved.stored, targetId);
  const chain: ScopedOverrideChainEntry[] = [
    ...resolved.ancestors,
    {
      scope: target.scope,
      ...(targetId !== undefined ? { id: targetId } : {}),
      label: resolved.label,
      overrides: split.overrides,
      isTarget: true,
    },
  ];
  return {
    sourceRevision: snapshot.revision,
    sourceHash: snapshot.hash,
    target,
    scope: target.scope,
    label: resolved.label,
    allowedKeys: SETTING_SCOPE_KEYS[target.scope],
    overrides: split.overrides,
    foreign: foreignOf(resolved.stored, split.overrides),
    foreignIssues: split.removed,
    chain,
    inheritedConfig: resolveScopedConfig(baseConfigFor(state), layersOf(chain.filter((entry) => !entry.isTarget))),
    effectiveConfig: resolveScopedConfig(baseConfigFor(state), layersOf(chain)),
  };
}

/**
 * The config the whole chain layers on top of: the inherited profile config,
 * before the project's own overrides. Legacy states carry no separate base, and
 * for those `config` *is* the base with an empty override map.
 */
function baseConfigFor(state: ProjectState): Readonly<ConfigMap> {
  return state.settingsBaseConfig ?? state.config;
}

function layersOf(chain: readonly ScopedOverrideChainEntry[]): ScopedOverrideLayer[] {
  return chain.map((entry) => ({
    scope: entry.scope,
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    overrides: entry.overrides,
  }));
}

function foreignOf(stored: Readonly<ConfigMap>, kept: Readonly<ConfigMap>): ConfigMap {
  const foreign: ConfigMap = {};
  for (const key of Object.keys(stored)) {
    if (!Object.prototype.hasOwnProperty.call(kept, key)) foreign[key] = cloneJson(stored[key]);
  }
  return foreign;
}

export interface ScopedOverrideTargetOption {
  /** Stable, surface-neutral identity for a control's value attribute. */
  readonly id: string;
  readonly scope: SettingScope;
  readonly target: ScopedOverrideTarget;
  /** Node's own name. */
  readonly label: string;
  /** Containment path a person reads, e.g. `Plate 1 › Cube › Body`. */
  readonly path: string;
  /** How many overrides the node already carries at its scope. */
  readonly overrideCount: number;
}

/**
 * Every node a scoped edit can address, in containment order.
 *
 * Ordered the way a person scans the scene — project, then each plate with its
 * objects, their parts, and their height ranges — deliberately *not* in
 * precedence order, because the reader is looking for a thing, not for a rule.
 */
export function scopedOverrideTargets(state: ProjectState): ScopedOverrideTargetOption[] {
  const options: ScopedOverrideTargetOption[] = [
    {
      id: 'project',
      scope: 'project',
      target: { scope: 'project' },
      label: state.name || 'Project',
      path: state.name || 'Project',
      overrideCount: Object.keys(inScopeOnly('project', state.settingsOverrides ?? {})).length,
    },
  ];
  for (const plate of [...state.plates].sort((left, right) => left.order - right.order)) {
    const plateLabel = plate.name || 'Plate';
    options.push({
      id: `plate:${plate.id}`,
      scope: 'plate',
      target: { scope: 'plate', plateId: plate.id },
      label: plateLabel,
      path: plateLabel,
      overrideCount: Object.keys(inScopeOnly('plate', plate.config)).length,
    });
    for (const object of plate.objects) {
      const objectLabel = object.name || 'Object';
      options.push({
        id: `object:${object.id}`,
        scope: 'object',
        target: { scope: 'object', objectId: object.id },
        label: objectLabel,
        path: `${plateLabel} › ${objectLabel}`,
        overrideCount: Object.keys(inScopeOnly('object', object.config)).length,
      });
      for (const volume of object.volumes) {
        const volumeLabel = volume.name || 'Part';
        options.push({
          id: `part:${volume.id}`,
          scope: 'part',
          target: { scope: 'part', volumeId: volume.id },
          label: volumeLabel,
          path: `${plateLabel} › ${objectLabel} › ${volumeLabel}`,
          overrideCount: Object.keys(inScopeOnly('part', volume.config)).length,
        });
      }
      for (const range of object.layerRanges) {
        const rangeLabel = `${range.minZMm}–${range.maxZMm} mm`;
        options.push({
          id: `layerRange:${range.id}`,
          scope: 'layerRange',
          target: { scope: 'layerRange', layerRangeId: range.id },
          label: rangeLabel,
          path: `${plateLabel} › ${objectLabel} › ${rangeLabel}`,
          overrideCount: Object.keys(inScopeOnly('layerRange', range.config)).length,
        });
      }
    }
  }
  return options;
}

/** Why one key has the value it has at `target`, and what it shadowed. */
export function explainScopedSetting(
  snapshot: ProjectSnapshot,
  target: ScopedOverrideTarget,
  key: string,
): SettingResolution {
  const view = scopedOverrideSnapshot(snapshot, target);
  return explainSetting(baseConfigFor(snapshot.state), layersOf(view.chain), key);
}

/**
 * Replace the in-scope overrides of one node.
 *
 * `overrides` is the complete next map for the scope, not a patch: a key the
 * caller omits is cleared, which is what "reset to inherited" means. Keys the
 * scope does not own are copied through from what was already stored.
 */
export class SetScopedOverridesCommand implements ProjectCommand {
  readonly type = 'set-scoped-overrides';
  readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private readonly next: ConfigMap;
  private previous?: ConfigMap;

  constructor(
    private readonly guard: ScopedOverrideGuard,
    private readonly target: Exclude<ScopedOverrideTarget, { scope: 'project' }>,
    overrides: Readonly<Record<string, JsonValue>>,
  ) {
    this.label = `Update ${target.scope === 'layerRange' ? 'height range' : target.scope} settings`;
    const issues: SettingScopeIssue[] = [];
    const accepted: ConfigMap = {};
    for (const key of Object.keys(overrides).sort()) {
      if (settingScopeAllows(target.scope, key)) {
        accepted[key] = cloneJson(overrides[key]);
        continue;
      }
      issues.push({
        code: 'setting-not-in-scope',
        path: `${target.scope}.${key}`,
        scope: target.scope,
        key,
        message: `${key} cannot be set on a ${target.scope === 'layerRange' ? 'height range' : target.scope}`,
      });
    }
    if (issues.length > 0) throw new SettingScopeError(issues);
    this.next = accepted;
  }

  isNoop(context: CommandContext): boolean {
    this.assertInitialGuard(context);
    const state = context.project.getSnapshot().state;
    const stored = resolveTarget(state, this.target).stored;
    return canonicalStringify(this.merged(stored)) === canonicalStringify(stored);
  }

  apply(context: CommandContext): void {
    const current = context.project.getSnapshot();
    if (!this.previous) this.assertInitialGuard(context);
    const state = cloneProjectState(current.state);
    const resolved = resolveTarget(state, this.target);
    const stored = cloneJson(resolved.stored);
    if (this.previous && canonicalStringify(stored) !== canonicalStringify(this.previous)) {
      throw new Error('Cannot redo scoped setting overrides because the stored node config diverged');
    }
    if (!this.previous) this.previous = stored;
    resolved.write(state, this.merged(stored));
    assertValidProjectState(state);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('SetScopedOverridesCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    resolveTarget(state, this.target).write(state, cloneJson(this.previous));
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return canonicalStringify(this.next).length + (this.previous ? canonicalStringify(this.previous).length : 0);
  }

  /** Next overrides over the pass-through keys the scope does not own. */
  private merged(stored: Readonly<ConfigMap>): ConfigMap {
    const merged: ConfigMap = {};
    for (const key of Object.keys(stored)) {
      if (!settingScopeAllows(this.target.scope, key)) merged[key] = cloneJson(stored[key]);
    }
    for (const key of Object.keys(this.next)) merged[key] = cloneJson(this.next[key]);
    return merged;
  }

  private assertInitialGuard(context: CommandContext): void {
    if (
      !context.project.isCurrent({
        revision: this.guard.sourceRevision,
        hash: this.guard.sourceHash,
      })
    ) {
      throw new StaleScopedOverrideError();
    }
  }
}

/**
 * The next project state for a project-scope edit, in the shape
 * `SetProjectSettingsOverridesCommand` expects.
 *
 * Kept here so a caller can hand the same `{target, overrides}` pair to one
 * entry point regardless of scope, and the split between the two storage
 * shapes stays in this file instead of in every surface.
 */
export function projectScopeUpdate(
  snapshot: ProjectSnapshot,
  overrides: Readonly<Record<string, JsonValue>>,
): { inheritedConfig: ConfigMap; overrides: ConfigMap; effectiveConfig: ConfigMap } {
  const issues: SettingScopeIssue[] = [];
  for (const key of Object.keys(overrides).sort()) {
    if (settingScopeAllows('project', key)) continue;
    issues.push({
      code: 'setting-not-in-scope',
      path: `project.${key}`,
      scope: 'project',
      key,
      message: `${key} is not a project setting; the print preset does not hold it`,
    });
  }
  if (issues.length > 0) throw new SettingScopeError(issues);
  const inheritedConfig = cloneJson(snapshot.state.settingsBaseConfig ?? snapshot.state.config);
  const next = cloneJson(overrides) as ConfigMap;
  return {
    inheritedConfig,
    overrides: next,
    effectiveConfig: applyProjectSettingsOverrides(inheritedConfig, next),
  };
}
