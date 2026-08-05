import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from './domain/canonical';
import type { ConfigMap, JsonValue, ProjectState } from './domain/model';
import { assertValidProjectState } from './domain/validation';
import type { CommandContext, ProjectCommand } from './history/command';
import type { ProjectSnapshot } from './store';

export interface ProjectSettingsOverrideGuard {
  readonly sourceRevision: number;
  readonly sourceHash: string;
}

export type ImmutableJsonValue =
  null | boolean | number | string | readonly ImmutableJsonValue[] | { readonly [key: string]: ImmutableJsonValue };

export interface ProjectSettingsOverrideUpdate {
  /** Complete next inherited/base config before explicit overrides. */
  readonly inheritedConfig: Readonly<Record<string, ImmutableJsonValue>>;
  /** Complete next explicit override map. */
  readonly overrides: Readonly<Record<string, ImmutableJsonValue>>;
}

export interface ProjectSettingsOverrideSnapshot extends ProjectSettingsOverrideGuard {
  readonly inheritedConfig: Readonly<Record<string, ImmutableJsonValue>>;
  readonly overrides: Readonly<Record<string, ImmutableJsonValue>>;
  readonly effectiveConfig: Readonly<Record<string, ImmutableJsonValue>>;
}

export class StaleProjectSettingsOverrideError extends Error {
  override readonly name = 'StaleProjectSettingsOverrideError';

  constructor() {
    super('Project setting overrides were prepared for a stale canonical project revision');
  }
}

interface PreviousSettingsState {
  config: ConfigMap;
  hadBaseConfig: boolean;
  baseConfig?: ConfigMap;
  hadOverrides: boolean;
  overrides?: ConfigMap;
}

/**
 * Return a caller-owned, deeply frozen view. Legacy states with no explicit
 * field project as an empty override map without mutating their hash.
 */
export function projectSettingsOverrideSnapshot(snapshot: ProjectSnapshot): ProjectSettingsOverrideSnapshot {
  return deepFreeze(
    cloneJson({
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
      inheritedConfig: snapshot.state.settingsBaseConfig ?? snapshot.state.config,
      overrides: snapshot.state.settingsOverrides ?? {},
      effectiveConfig: snapshot.state.config,
    }),
  ) as ProjectSettingsOverrideSnapshot;
}

/** Engine config maps are flat by key; an explicit override replaces one whole option value. */
export function applyProjectSettingsOverrides(
  baseConfig: Readonly<Record<string, JsonValue>>,
  overrides: Readonly<Record<string, JsonValue>>,
): ConfigMap {
  return {
    ...cloneJson(baseConfig),
    ...cloneJson(overrides),
  };
}

/**
 * One reversible canonical mutation for the explicit/effective config pair.
 * The guard is checked on first application; redo verifies the exact prior
 * pair instead because project revisions intentionally remain monotonic.
 */
export class SetProjectSettingsOverridesCommand implements ProjectCommand {
  readonly type = 'set-project-settings-overrides';
  readonly label = 'Update project setting overrides';
  readonly dirtyCategories = ['projectData'] as const;
  private readonly nextBaseConfig: ConfigMap;
  private readonly nextOverrides: ConfigMap;
  private readonly nextEffectiveConfig: ConfigMap;
  private previous?: PreviousSettingsState;

  constructor(
    private readonly guard: ProjectSettingsOverrideGuard,
    update: ProjectSettingsOverrideUpdate,
  ) {
    this.nextBaseConfig = cloneJson(update.inheritedConfig) as ConfigMap;
    this.nextOverrides = cloneJson(update.overrides) as ConfigMap;
    assertConfigMap(this.nextBaseConfig, 'Inherited project configuration');
    assertConfigMap(this.nextOverrides, 'Project setting overrides');
    this.nextEffectiveConfig = applyProjectSettingsOverrides(this.nextBaseConfig, this.nextOverrides);
  }

  isNoop(context: CommandContext): boolean {
    this.assertInitialGuard(context);
    const state = context.project.getSnapshot().state;
    return settingsPairMatches(state, this.nextBaseConfig, this.nextOverrides, this.nextEffectiveConfig);
  }

  apply(context: CommandContext): void {
    const current = context.project.getSnapshot();
    if (!this.previous) this.assertInitialGuard(context);
    else if (!previousPairMatches(current.state, this.previous)) {
      throw new Error('Cannot redo project setting overrides because the canonical settings pair diverged');
    }

    const next = cloneProjectState(current.state);
    next.settingsBaseConfig = cloneJson(this.nextBaseConfig);
    next.settingsOverrides = cloneJson(this.nextOverrides);
    next.config = cloneJson(this.nextEffectiveConfig);
    assertValidProjectState(next);
    if (!this.previous) this.previous = capturePrevious(current.state);
    context.project.replaceState(next, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('SetProjectSettingsOverridesCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    state.config = cloneJson(this.previous.config);
    if (this.previous.hadBaseConfig) state.settingsBaseConfig = cloneJson(this.previous.baseConfig!);
    else delete state.settingsBaseConfig;
    if (this.previous.hadOverrides) state.settingsOverrides = cloneJson(this.previous.overrides!);
    else delete state.settingsOverrides;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return (
      canonicalStringify(this.nextBaseConfig).length +
      canonicalStringify(this.nextOverrides).length +
      canonicalStringify(this.nextEffectiveConfig).length +
      (this.previous ? canonicalStringify(this.previous).length : 0)
    );
  }

  private assertInitialGuard(context: CommandContext): void {
    if (
      !context.project.isCurrent({
        revision: this.guard.sourceRevision,
        hash: this.guard.sourceHash,
      })
    ) {
      throw new StaleProjectSettingsOverrideError();
    }
  }
}

function capturePrevious(state: ProjectState): PreviousSettingsState {
  const hadBaseConfig = Object.prototype.hasOwnProperty.call(state, 'settingsBaseConfig');
  const hadOverrides = Object.prototype.hasOwnProperty.call(state, 'settingsOverrides');
  return {
    config: cloneJson(state.config),
    hadBaseConfig,
    ...(hadBaseConfig ? { baseConfig: cloneJson(state.settingsBaseConfig!) } : {}),
    hadOverrides,
    ...(hadOverrides ? { overrides: cloneJson(state.settingsOverrides!) } : {}),
  };
}

function settingsPairMatches(
  state: ProjectState,
  baseConfig: ConfigMap,
  overrides: ConfigMap,
  effectiveConfig: ConfigMap,
): boolean {
  return (
    canonicalStringify(state.settingsBaseConfig ?? state.config) === canonicalStringify(baseConfig) &&
    canonicalStringify(state.settingsOverrides ?? {}) === canonicalStringify(overrides) &&
    canonicalStringify(state.config) === canonicalStringify(effectiveConfig)
  );
}

function previousPairMatches(state: ProjectState, previous: PreviousSettingsState): boolean {
  const hasBaseConfig = Object.prototype.hasOwnProperty.call(state, 'settingsBaseConfig');
  const hasOverrides = Object.prototype.hasOwnProperty.call(state, 'settingsOverrides');
  return (
    hasBaseConfig === previous.hadBaseConfig &&
    hasOverrides === previous.hadOverrides &&
    canonicalStringify(state.config) === canonicalStringify(previous.config) &&
    (!hasBaseConfig || canonicalStringify(state.settingsBaseConfig) === canonicalStringify(previous.baseConfig)) &&
    (!hasOverrides || canonicalStringify(state.settingsOverrides) === canonicalStringify(previous.overrides))
  );
}

function assertConfigMap(config: ConfigMap, label: string): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const key of Object.keys(config)) {
    if (!key.trim()) throw new Error(`${label} contains an empty key`);
  }
  try {
    canonicalStringify(config);
  } catch (error) {
    throw new Error(`${label} must contain only finite canonical JSON values`, { cause: error });
  }
}
