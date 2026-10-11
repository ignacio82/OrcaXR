/**
 * The virtual filament library's canonical side, free of the controller: the
 * library snapshot a project state shows (its physical heads in engine order
 * and its live mixed filaments with their references) and the plan of each
 * library edit — add, edit, duplicate, enable or disable, delete — as the
 * commands one undoable step submits and the label it records.
 * `CanonicalWorkspaceController` executes these plans; the shared Rust core
 * plans the same edits for the Android app
 * (`orcaxr_project::filaments::library`).
 */
import type { ProjectCommandWire } from '../../../contracts/generated/project-intents';
import { cloneJson } from '../project/domain/canonical';
import type { MixedFilamentId, PhysicalFilamentId } from '../project/domain/ids';
import type { MixedFilament, ProjectState } from '../project/domain/model';
import {
  createFullSpectrumMixedFilament,
  replaceFullSpectrumMixedFilament,
  type FullSpectrumRecipeDraft,
} from '../project/filaments/fullSpectrumRecipe';
import {
  AddMixedFilamentCommand,
  EditMixedFilamentCommand,
  findFilamentDependentPaths,
  RemoveMixedFilamentCommand,
  SetMixedFilamentEnabledCommand,
  TombstoneMixedFilamentCommand,
} from '../project/filaments/mixedCommands';
import type { ProjectCommand } from '../project/history/command';
import {
  fullSpectrumWire,
  mixedComponentWire,
  mixedDistributionWire,
  mixedFilamentWire,
  type IntentText,
} from '../project/intentWire';

type Immutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

export interface CanonicalVirtualFilamentLibrarySnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  /** Current one-based transient engine order paired with stable physical IDs. */
  readonly physical: readonly {
    readonly id: PhysicalFilamentId;
    readonly engineToolId: number;
    readonly name: string;
    readonly material: string;
    readonly color: string;
    readonly enabled: boolean;
  }[];
  readonly mixed: readonly {
    readonly filament: Immutable<MixedFilament>;
    readonly dependencyPaths: readonly string[];
    readonly hasExactFullSpectrumState: boolean;
  }[];
}

/** One library edit, without the revision guard the controller checks first. */
export type VirtualFilamentMutation =
  | { readonly operation: 'add'; readonly draft: FullSpectrumRecipeDraft; readonly requestedId?: MixedFilamentId }
  | {
      readonly operation: 'edit';
      readonly filamentId: MixedFilamentId;
      readonly draft: FullSpectrumRecipeDraft;
    }
  | {
      readonly operation: 'duplicate';
      readonly sourceFilamentId: MixedFilamentId;
      readonly draft: FullSpectrumRecipeDraft;
      readonly requestedDuplicateId?: MixedFilamentId;
    }
  | { readonly operation: 'set-enabled'; readonly filamentId: MixedFilamentId; readonly enabled: boolean }
  | { readonly operation: 'delete'; readonly filamentId: MixedFilamentId };

export type VirtualFilamentMutationOutcome =
  | { readonly operation: 'add' | 'duplicate'; readonly filamentId: MixedFilamentId }
  | { readonly operation: 'edit' | 'set-enabled' }
  | {
      readonly operation: 'delete';
      readonly outcome: 'removed' | 'tombstoned';
      readonly dependencyPaths: readonly string[];
    };

/**
 * One undoable step: a single intent (its label the command's own) or a
 * labelled transaction, which reconciles automatic pairs when `reconcile`
 * and the workspace generates them.
 */
export type VirtualFilamentMutationStep =
  | { readonly kind: 'intent'; readonly command: (text: IntentText) => ProjectCommandWire }
  | {
      readonly kind: 'transaction';
      readonly commands: readonly ProjectCommand[];
      readonly wire: (text: IntentText) => ProjectCommandWire[];
      readonly reconcile: boolean;
    };

export interface VirtualFilamentMutationPlan {
  /** The label the step records in history. */
  readonly label: string;
  readonly step: VirtualFilamentMutationStep;
  readonly outcome: VirtualFilamentMutationOutcome;
}

/** The library snapshot of `state`: physical heads in engine order, live (untombstoned) mixed filaments. */
export function virtualFilamentLibraryCanonical(
  state: ProjectState,
  sourceRevision: number,
  sourceHash: string,
): CanonicalVirtualFilamentLibrarySnapshot {
  return {
    sourceRevision,
    sourceHash,
    physical: state.filaments.physical.map((filament, index) => ({
      id: filament.id,
      engineToolId: index + 1,
      name: filament.name,
      material: filament.material,
      color: filament.color,
      enabled: filament.enabled,
    })),
    mixed: state.filaments.mixed
      .filter((filament) => !filament.fullSpectrum?.deleted)
      .map((filament) => ({
        filament: cloneJson(filament),
        dependencyPaths: findFilamentDependentPaths(state, filament.id),
        hasExactFullSpectrumState: filament.fullSpectrum !== undefined,
      })),
  };
}

/**
 * Plan `mutation` on `state`: the recipe built (or replaced) from its draft,
 * refused in the recipe's words, and the step that submits it. `nextId`
 * names a new filament when the request names none.
 */
export function planVirtualFilamentMutation(
  state: ProjectState,
  mutation: VirtualFilamentMutation,
  nextId: () => MixedFilamentId,
): VirtualFilamentMutationPlan {
  switch (mutation.operation) {
    case 'add': {
      const id = mutation.requestedId ?? nextId();
      const filament = createFullSpectrumMixedFilament(id, state.filaments.physical, mutation.draft);
      return { ...addStep(filament), outcome: { operation: 'add', filamentId: id } };
    }
    case 'edit': {
      const current = state.filaments.mixed.find((filament) => filament.id === mutation.filamentId);
      if (!current) throw new Error(`Unknown mixed filament ${mutation.filamentId}`);
      const replacement = replaceFullSpectrumMixedFilament(current, state.filaments.physical, mutation.draft);
      const edit = new EditMixedFilamentCommand(mutation.filamentId, {
        name: replacement.name,
        displayColor: replacement.displayColor,
        components: replacement.components,
        distribution: replacement.distribution,
        fullSpectrum: replacement.fullSpectrum,
      });
      return {
        label: 'Edit mixed filament',
        step: {
          kind: 'transaction',
          commands: [edit],
          reconcile: true,
          wire: (text) => [
            {
              editMixedFilament: {
                mixedFilamentId: text(mutation.filamentId),
                name: { value: text(replacement.name) },
                displayColor: { value: text(replacement.displayColor) },
                components: {
                  value: replacement.components.map((component) => mixedComponentWire(component, text)),
                },
                distribution: { value: mixedDistributionWire(replacement.distribution, text) },
                fullSpectrum: replacement.fullSpectrum
                  ? { value: fullSpectrumWire(replacement.fullSpectrum, text) }
                  : { absent: {} },
                configJson: { absent: {} },
              },
            },
          ],
        },
        outcome: { operation: 'edit' },
      };
    }
    case 'duplicate': {
      if (!state.filaments.mixed.some((filament) => filament.id === mutation.sourceFilamentId)) {
        throw new Error(`Unknown mixed filament ${mutation.sourceFilamentId}`);
      }
      const id = mutation.requestedDuplicateId ?? nextId();
      const duplicate = createFullSpectrumMixedFilament(id, state.filaments.physical, mutation.draft);
      return { ...addStep(duplicate), outcome: { operation: 'duplicate', filamentId: id } };
    }
    case 'set-enabled': {
      const { filamentId, enabled } = mutation;
      if (!state.filaments.mixed.some((filament) => filament.id === filamentId)) {
        throw new Error(`Unknown mixed filament ${filamentId}`);
      }
      const command = new SetMixedFilamentEnabledCommand(filamentId, enabled, 'virtual-filament-library');
      return {
        label: command.label,
        step: {
          kind: 'intent',
          command: (text) => ({
            setMixedFilamentEnabled: {
              mixedFilamentId: text(filamentId),
              enabled,
              reason: { value: text('virtual-filament-library') },
            },
          }),
        },
        outcome: { operation: 'set-enabled' },
      };
    }
    case 'delete': {
      const { filamentId } = mutation;
      const filament = state.filaments.mixed.find((candidate) => candidate.id === filamentId);
      if (!filament) throw new Error(`Unknown mixed filament ${filamentId}`);
      const dependencyPaths = findFilamentDependentPaths(state, filamentId);
      if (dependencyPaths.length > 0 || filament.fullSpectrum?.originAuto) {
        const reason = dependencyPaths.length > 0 ? 'delete-with-canonical-dependencies' : 'delete-auto-pair';
        const tombstone = new TombstoneMixedFilamentCommand(filamentId, reason);
        return {
          label: tombstone.label,
          step: {
            kind: 'transaction',
            commands: [tombstone],
            reconcile: filament.fullSpectrum?.originAuto === true,
            wire: (text) => [
              { tombstoneMixedFilament: { mixedFilamentId: text(filamentId), reason: { value: text(reason) } } },
            ],
          },
          outcome: { operation: 'delete', outcome: 'tombstoned', dependencyPaths: Object.freeze(dependencyPaths) },
        };
      }
      const remove = new RemoveMixedFilamentCommand(filamentId);
      return {
        label: remove.label,
        step: { kind: 'intent', command: (text) => ({ removeMixedFilament: { mixedFilamentId: text(filamentId) } }) },
        outcome: { operation: 'delete', outcome: 'removed', dependencyPaths: Object.freeze([]) },
      };
    }
  }
}

function addStep(filament: MixedFilament): Pick<VirtualFilamentMutationPlan, 'label' | 'step'> {
  const command = new AddMixedFilamentCommand(filament);
  return {
    label: command.label,
    step: {
      kind: 'intent',
      command: (text) => ({ addMixedFilament: { filament: mixedFilamentWire(filament, text) } }),
    },
  };
}
