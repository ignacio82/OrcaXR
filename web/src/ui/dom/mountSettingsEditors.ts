import { t } from '../../l10n/t';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';
import type { ActionRegistry } from '../../actions/ActionRegistry';
import type { ActionContext } from '../../actions/ActionContext';
import type { UiState } from '../../actions/UiState';
import type { InitializationScope } from '../../startup/FeatureInitialization';
import type { ConfigMap } from '../../project/domain/model';
import type { GeneratedSettingsPanelAdapter } from './GeneratedSettingsPanel';
import { loadEngineOptionCatalog, type EngineOptionCatalog } from '../../settings/generated/loader';
import { applySettingsCommitToConfig, decodeSettingsConfig } from '../../settings/editor';
import type { ProjectSettingsOverrideSnapshot } from '../../project/settingsOverrides';
import type { ScopedOverrideSnapshot, ScopedOverrideTargetOption } from '../../project/scopedOverrides';

export interface SettingsEditorsOptions {
  readonly workspace: OrcaWorkspace;
  readonly registry: ActionRegistry;
  readonly actionCtx: ActionContext;
  readonly uiState: UiState;
  readonly settingsHost: HTMLElement;
  readonly statusText: HTMLElement;
}

/** A fresh schema and both shared editors live and fail as one owned feature. */
export async function mountSettingsEditors(options: SettingsEditorsOptions, scope: InitializationScope): Promise<void> {
  const { workspace, registry, actionCtx, uiState, settingsHost, statusText } = options;
  let mounting = true;
  let mountFailure: unknown;
  const catalog = await scope.load(
    loadEngineOptionCatalog(undefined, (input, init) => fetch(input, { ...init, signal: scope.signal })),
  );
  const catalogPromise = Promise.resolve(catalog);
  const projectPanelSnapshot = (catalog: EngineOptionCatalog, raw: ProjectSettingsOverrideSnapshot) => ({
    revision: raw.sourceRevision,
    sourceHash: raw.sourceHash,
    inherited: decodeSettingsConfig(catalog, raw.inheritedConfig as unknown as Readonly<ConfigMap>).values,
    overrides: decodeSettingsConfig(catalog, raw.overrides as unknown as Readonly<ConfigMap>).values,
  });
  // A factory rather than one shared object, because two surfaces now read
  // through this adapter. The snapshot it last handed out is what its stale
  // guard compares against, so a single instance shared between the panel and
  // the headset would let one surface's apply move the other's guard — and the
  // second surface would then be told its own draft was stale with no way to
  // notice it had gone out of date.
  const makeProjectAdapter = (): GeneratedSettingsPanelAdapter => {
    let displayedRaw: ProjectSettingsOverrideSnapshot | undefined;
    return {
      load: async () => {
        const catalog = await catalogPromise;
        displayedRaw = workspace.getProjectSettingsOverrideSnapshot();
        return projectPanelSnapshot(catalog, displayedRaw);
      },
      subscribe: (listener) =>
        workspace.subscribeCanonicalState(() => {
          const current = workspace.getProjectSettingsOverrideSnapshot();
          if (
            !displayedRaw ||
            current.sourceRevision !== displayedRaw.sourceRevision ||
            current.sourceHash !== displayedRaw.sourceHash
          ) {
            listener();
          }
        }),
      apply: async (request) => {
        const raw = displayedRaw;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
        const overrides = applySettingsCommitToConfig(raw.overrides as unknown as Readonly<ConfigMap>, request.commit);
        const invoked = await registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, uiState.get(), {
          projectSettingsApply: {
            inheritedConfig: raw.inheritedConfig as unknown as Readonly<ConfigMap>,
            overrides,
            sourceRevision: raw.sourceRevision,
            sourceHash: raw.sourceHash,
          },
        });
        if (!invoked) throw new Error('The project settings action is unavailable in the current workspace state.');
        displayedRaw = workspace.getProjectSettingsOverrideSnapshot();
        return projectPanelSnapshot(await catalogPromise, displayedRaw);
      },
      cancel: (request) => {
        const raw = displayedRaw;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
      },
      onError: (error) => {
        if (mounting) mountFailure = error;
        statusText.textContent = t('startup.projectSettingsError', 'Project settings: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    };
  };
  const projectAdapter = makeProjectAdapter();

  // A plate, object, part, or height range stores overrides alone, so its
  // adapter reads the resolved chain as "inherited" and writes only the map
  // for that node. One panel, one commit path; the scope decides what may be
  // stored and who wins (P6.5).
  const nodeAdapter = (option: ScopedOverrideTargetOption): GeneratedSettingsPanelAdapter => {
    let displayed: ScopedOverrideSnapshot | undefined;
    const project = async (raw: ScopedOverrideSnapshot) => {
      const catalog = await catalogPromise;
      return {
        revision: raw.sourceRevision,
        sourceHash: raw.sourceHash,
        inherited: decodeSettingsConfig(catalog, raw.inheritedConfig).values,
        overrides: decodeSettingsConfig(catalog, raw.overrides).values,
      };
    };
    return {
      load: async () => {
        displayed = workspace.getScopedOverrideSnapshot(option.target);
        return project(displayed);
      },
      subscribe: (listener) =>
        workspace.subscribeCanonicalState(() => {
          const current = workspace.getScopedOverrideSnapshot(option.target);
          if (
            !displayed ||
            current.sourceRevision !== displayed.sourceRevision ||
            current.sourceHash !== displayed.sourceHash
          ) {
            listener();
          }
        }),
      apply: async (request) => {
        const raw = displayed;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
        const overrides = applySettingsCommitToConfig(raw.overrides, request.commit);
        const invoked = await registry.invoke('settings_apply_scoped', 'dom-inspector', actionCtx, uiState.get(), {
          scopedSettingsApply: {
            target: option.target,
            overrides,
            sourceRevision: raw.sourceRevision,
            sourceHash: raw.sourceHash,
          },
        });
        if (!invoked) throw new Error('The scoped settings action is unavailable in the current workspace state.');
        displayed = workspace.getScopedOverrideSnapshot(option.target);
        return project(displayed);
      },
      cancel: (request) => {
        const raw = displayed;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
      },
      onError: (error) => {
        if (mounting) mountFailure = error;
        statusText.textContent = t('startup.scopedSettingsError', '{scope} settings: {reason}', {
          scope: option.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    };
  };

  // Inspector-gated: scoped overrides are a panel an operator opens.
  const { ScopedSettingsPanel } = await scope.import(import('./ScopedSettingsPanel'));
  const { ScopedSettingsStepper } = await scope.import(import('../../settings/editor/scopedStepper'));

  // The headset gets the same settings through the same adapters. Not a
  // second settings implementation: one query, one draft editor, one commit
  // path, and a different way of naming a value — pressed rather than typed
  // (P6.5).
  const stepper = new ScopedSettingsStepper({
    loadCatalog: () => catalogPromise,
    listTargets: () => workspace.listScopedOverrideTargets(),
    adapterFor: (targetId) => {
      if (targetId === 'project') return makeProjectAdapter();
      const option = workspace.listScopedOverrideTargets().find((entry) => entry.id === targetId);
      if (!option) throw new Error(`No settings target named ${targetId} is in the project.`);
      return nodeAdapter(option);
    },
    onChange: () => workspace.refreshXrScopedSettings(),
    onError: (error) => {
      if (mounting) mountFailure = error;
      statusText.textContent = t('startup.settingsError', 'Settings: {reason}', {
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  });
  scope.own(stepper);
  workspace.setScopedSettingsPort(stepper);
  scope.defer(() => workspace.setScopedSettingsPort(null));
  // The spatial panel follows what the operator is pointing at. Only on a
  // *changed* selection: reasserting it on every canonical revision would
  // drag the panel back off a plate or a part the operator had cycled to.
  let followedTarget: string | null = null;
  scope.defer(
    workspace.subscribeCanonicalState(() => {
      const target = workspace.scopedOverrideTargetIdForSelection();
      if (target === followedTarget) return;
      followedTarget = target;
      if (target) stepper.selectTarget(target);
    }),
  );

  const settingsPanel = new ScopedSettingsPanel(
    settingsHost,
    {
      listTargets: () => workspace.listScopedOverrideTargets(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      adapterFor: (option) => (option.scope === 'project' ? projectAdapter : nodeAdapter(option)),
      onError: (error) => {
        if (mounting) mountFailure = error;
        statusText.textContent = t('startup.settingsError', 'Settings: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    },
    { panel: { loadCatalog: () => catalogPromise } },
  );
  scope.own(settingsPanel);
  await scope.load(settingsPanel.mount());
  stepper.getView();
  await scope.load(stepper.whenIdle());
  if (mountFailure) throw mountFailure;
  if (stepper.getView().status !== 'ready') throw new Error('The settings controls could not read the project.');
  mounting = false;
}
