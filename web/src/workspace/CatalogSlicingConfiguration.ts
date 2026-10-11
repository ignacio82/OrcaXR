/**
 * The step that turns a chosen catalog profile into the project's own slicing
 * configuration: the pickers' preset choices and their labels, matching a
 * typed name, the catalog's default triple, reconciling a selection into one
 * exact profile per filament slot, the workspace's slots after a selection,
 * the canonical slicing configuration those slots describe, and the project
 * state that configuration leads to.
 *
 * `OrcaWorkspace` and `CanonicalWorkspaceController` hold the live state and
 * call these rules; the shared Rust core answers the same questions
 * (`orcaxr_project::slicing::{choices, configuration}`), pinned against this
 * module by `slicing-configuration-vectors.json`.
 */
import { canonicalStringify, cloneJson, cloneProjectState } from '../project/domain/canonical';
import { entityId, type MixedFilamentId } from '../project/domain/ids';
import type { ConfigMap, MixedFilament, PhysicalFilament, ProjectState } from '../project/domain/model';
import { assertValidProjectState } from '../project/domain/validation';
import {
  allocateFullSpectrumAutoPairIdentity,
  reconcileFullSpectrumAutoPairFilaments,
} from '../project/filaments/autoPairReconciliation';
import { fullSpectrumStableNumericId } from '../project/filaments/fullSpectrumRecipe';
import { applyProjectSettingsOverrides } from '../project/settingsOverrides';
import type { PresetSelectionRequest } from '../settings/presets/PresetGraph';
import type { ProfileCatalogSelectionResolution, SlicerProfile } from '../slicer/ProfileLoader';
import type { CanonicalSlicingConfiguration } from './CanonicalWorkspaceController';
import {
  FILAMENT_PALETTE_MAX_SLOTS,
  NEW_FILAMENT_SLOT,
  paletteSlotsFrom,
  slicerOverridesForSlots,
  type FilamentSlot,
} from './FilamentPalette';

export type WorkspacePresetId = NonNullable<SlicerProfile['machinePresetId']>;

export interface WorkspacePresetOption {
  readonly id: WorkspacePresetId;
  /** Exact canonical preset name. */
  readonly name: string;
  /** Compact, disambiguated picker label. */
  readonly label: string;
}

export interface WorkspaceProfileSelectionRequest {
  readonly machinePresetId?: WorkspacePresetId;
  readonly processPresetId?: WorkspacePresetId;
  readonly filamentPresetIds?: readonly (WorkspacePresetId | undefined)[];
}

export interface WorkspaceProfileSelectionFeedback {
  readonly applied: boolean;
  readonly severity: 'info' | 'warning' | 'error';
  readonly messages: readonly string[];
}

/** One filament slot's chosen filament: its exact preset, when it has one, and its name. */
export interface HeadFilamentSelection {
  readonly presetId?: WorkspacePresetId;
  readonly name: string;
}

/** What these rules read from the profile catalog (`ProfileCatalog`). */
export interface SlicingProfileCatalog {
  readonly profiles: readonly SlicerProfile[];
  find(machine: string, process: string, filament: string): SlicerProfile | null;
  reconcileSelection(request: PresetSelectionRequest): ProfileCatalogSelectionResolution;
}

/** The catalog triple a new document starts from, by name. */
export const CATALOG_DEFAULT_PROFILE = Object.freeze([
  'Snapmaker U1 (0.4 nozzle)',
  '0.20 Standard',
  'Snapmaker PLA',
] as const);

// --- Choices ---------------------------------------------------------------------------------

/** Complete printers in deterministic catalog order, keyed by canonical graph ID. */
export function machinePresetChoices(profiles: readonly SlicerProfile[]): WorkspacePresetOption[] {
  const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
  for (const profile of profiles) {
    if (!profile.machinePresetId || choices.has(profile.machinePresetId)) continue;
    choices.set(
      profile.machinePresetId,
      Object.freeze({
        id: profile.machinePresetId,
        name: profile.machineName,
        label: profile.machineName,
      }),
    );
  }
  return disambiguatePresetOptionLabels([...choices.values()]);
}

/** Compatibility-filtered processes for one exact printer preset. */
export function processPresetChoices(
  profiles: readonly SlicerProfile[],
  machinePresetId: WorkspacePresetId | undefined,
): WorkspacePresetOption[] {
  if (!machinePresetId) return [];
  const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
  for (const profile of profiles) {
    if (
      profile.machinePresetId !== machinePresetId ||
      !profile.processPresetId ||
      choices.has(profile.processPresetId)
    ) {
      continue;
    }
    choices.set(
      profile.processPresetId,
      Object.freeze({
        id: profile.processPresetId,
        name: profile.processName,
        label: profile.processName,
      }),
    );
  }
  return disambiguatePresetOptionLabels([...choices.values()]);
}

/** Compatibility-filtered filaments for one exact printer/process pair. */
export function filamentPresetChoices(
  profiles: readonly SlicerProfile[],
  machinePresetId: WorkspacePresetId | undefined,
  processPresetId: WorkspacePresetId | undefined,
): WorkspacePresetOption[] {
  if (!machinePresetId || !processPresetId) return [];
  const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
  for (const profile of profiles) {
    if (
      profile.machinePresetId !== machinePresetId ||
      profile.processPresetId !== processPresetId ||
      !profile.filamentPresetId ||
      choices.has(profile.filamentPresetId)
    ) {
      continue;
    }
    choices.set(
      profile.filamentPresetId,
      Object.freeze({
        id: profile.filamentPresetId,
        name: profile.filamentPresetName ?? profile.filamentName,
        label: profile.filamentName,
      }),
    );
  }
  return disambiguatePresetOptionLabels([...choices.values()]);
}

/**
 * A label shared by several options becomes the option's exact name, or, when
 * the name is shared too, the name and the vendor its preset ID encodes.
 */
export function disambiguatePresetOptionLabels(options: readonly WorkspacePresetOption[]): WorkspacePresetOption[] {
  const labelCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const option of options) {
    labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
    nameCounts.set(option.name, (nameCounts.get(option.name) ?? 0) + 1);
  }
  return options.map((option) =>
    labelCounts.get(option.label) === 1
      ? option
      : Object.freeze({
          ...option,
          label:
            nameCounts.get(option.name) === 1
              ? option.name
              : `${option.name} — ${presetVendorName(option.id) ?? 'another vendor'}`,
        }),
  );
}

function presetVendorName(id: WorkspacePresetId): string | undefined {
  const encoded = id.split(':')[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * The one option a typed name means: a unique exact label, else a unique
 * exact name, else the one option whose name or label contains it, ignoring
 * case. Anything ambiguous or absent matches nothing.
 */
export function matchPresetOption(
  options: readonly WorkspacePresetOption[],
  query: string,
): WorkspacePresetOption | undefined {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized) return undefined;
  const exactLabels = options.filter((option) => option.label.toLocaleLowerCase('en-US') === normalized);
  if (exactLabels.length === 1) return exactLabels[0];
  const exactNames = options.filter((option) => option.name.toLocaleLowerCase('en-US') === normalized);
  if (exactNames.length === 1) return exactNames[0];
  const partial = options.filter(
    (option) =>
      option.name.toLocaleLowerCase('en-US').includes(normalized) ||
      option.label.toLocaleLowerCase('en-US').includes(normalized),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

// --- Profile facts ----------------------------------------------------------------------------

/** A profile value that is one trimmed scalar, not a list. */
export function unambiguousProfileScalar(value: string | undefined): string | undefined {
  if (!value?.trim() || /[;,]/.test(value)) return undefined;
  return value.trim();
}

/** The nozzle a tool of the profile carries, as the head pickers show it. */
export function profileNozzleForTool(profile: SlicerProfile | null, toolId: number): string {
  const nozzles = profile?.config['nozzle_diameter']
    ?.split(/[;,]/)
    .map((value) => value.trim())
    .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (nozzles?.[toolId]) return nozzles[toolId];
  const singleExtruderMultiMaterial =
    unambiguousProfileScalar(profile?.config['single_extruder_multi_material'])?.toLowerCase() === '1' ||
    unambiguousProfileScalar(profile?.config['single_extruder_multi_material'])?.toLowerCase() === 'true';
  return nozzles?.length === 1 && singleExtruderMultiMaterial ? nozzles[0] : '0.4';
}

/** How many extruders the profile has: one per `nozzle_diameter` entry. */
export function profileExtruderCount(profile: SlicerProfile | null): number {
  if (!profile) return 1;
  const n = profile.config['nozzle_diameter'];
  if (!n) return 1;
  return n.split(',').length;
}

/** A slot holding the profile's own filament. */
export function headSelectionFromProfile(profile: SlicerProfile | null | undefined): HeadFilamentSelection {
  if (!profile) return Object.freeze({ name: '' });
  return Object.freeze({
    ...(profile.filamentPresetId ? { presetId: profile.filamentPresetId } : {}),
    name: profile.filamentName,
  });
}

// --- Selection --------------------------------------------------------------------------------

/** The profile catalog's default: the default triple, else its first profile. */
export function catalogDefaultProfile(catalog: SlicingProfileCatalog): SlicerProfile | null {
  return catalog.find(...CATALOG_DEFAULT_PROFILE) ?? catalog.profiles[0] ?? null;
}

/** The live choice a selection starts from: the selected profile and each slot's filament. */
export interface LiveProfileChoice {
  readonly profile: SlicerProfile | null;
  readonly heads: readonly HeadFilamentSelection[];
}

/** A reconciled selection: what to tell the operator and, when it applies, each slot's exact profile. */
export interface ProfileSelectionOutcome {
  readonly feedback: WorkspaceProfileSelectionFeedback;
  /** One exact profile per reconciled filament slot, the primary first; only when applied. */
  readonly profiles?: readonly SlicerProfile[];
}

const refused = (messages: readonly string[]): ProfileSelectionOutcome =>
  Object.freeze({ feedback: Object.freeze({ applied: false, severity: 'error' as const, messages }) });

/**
 * Reconcile exact graph identities and accept only a complete
 * printer/process/all-slot result. Compatible process and filament choices
 * survive printer/process changes; resolver substitutions are reported.
 */
export function resolveProfileSelection(
  catalog: SlicingProfileCatalog,
  current: LiveProfileChoice,
  request: WorkspaceProfileSelectionRequest,
): ProfileSelectionOutcome {
  const machinePresetId = request.machinePresetId ?? current.profile?.machinePresetId;
  if (!machinePresetId) {
    return refused(['Choose an available printer before selecting process or filament presets.']);
  }
  const processPresetId = request.processPresetId ?? current.profile?.processPresetId;
  const filamentPresetIds = request.filamentPresetIds ?? current.heads.map((selection) => selection.presetId);
  const resolution = catalog.reconcileSelection({
    printerId: machinePresetId,
    ...(processPresetId ? { processId: processPresetId } : {}),
    filamentIds: filamentPresetIds,
  });
  if (!resolution.selection) {
    return refused([resolution.unavailableReason ?? 'The requested profile selection is unavailable.']);
  }

  const resolved = resolution.selection;
  const messages = profileReconciliationMessages(catalog, resolved);
  if (!resolved.complete || !resolved.process || resolved.filaments.some((filament) => !filament)) {
    return refused(
      messages.length > 0
        ? messages
        : ['No complete compatible process and filament selection exists for this printer.'],
    );
  }

  const profiles = resolved.filaments.map((filament) =>
    filament
      ? catalog.profiles.find(
          (profile) =>
            profile.machinePresetId === resolved.printer.id &&
            profile.processPresetId === resolved.process?.id &&
            profile.filamentPresetId === filament.id,
        )
      : undefined,
  );
  if (!profiles[0] || profiles.some((profile) => !profile)) {
    return refused([
      'The resolver produced a combination that is absent from the validated slicing catalog; the prior selection was preserved.',
    ]);
  }
  return Object.freeze({
    feedback: Object.freeze({
      applied: true,
      severity: messages.length > 0 ? ('warning' as const) : ('info' as const),
      messages: messages.length > 0 ? messages : ['Profile selection is compatible.'],
    }),
    profiles: Object.freeze(profiles as SlicerProfile[]),
  });
}

function profileReconciliationMessages(
  catalog: SlicingProfileCatalog,
  resolved: NonNullable<ProfileCatalogSelectionResolution['selection']>,
): string[] {
  const messages: string[] = [];
  for (const substitution of resolved.substitutions) {
    const nextName = substitution.nextId
      ? presetDisplayName(catalog, substitution.kind, substitution.nextId)
      : undefined;
    const previousName = substitution.previousId
      ? presetDisplayName(catalog, substitution.kind, substitution.previousId)
      : undefined;
    if (substitution.kind === 'process') {
      if (nextName) {
        messages.push(
          previousName
            ? `${previousName} is unavailable for ${resolved.printer.name}; substituted ${nextName}.`
            : `Selected ${nextName} for ${resolved.printer.name}.`,
        );
      } else {
        messages.push(`No compatible process preset is available for ${resolved.printer.name}.`);
      }
      continue;
    }
    const slot = `Filament slot ${(substitution.slot ?? 0) + 1}`;
    if (nextName) {
      messages.push(
        previousName
          ? `${slot}: ${previousName} is unavailable for ${resolved.printer.name} / ${resolved.process?.name ?? 'the selected process'}; substituted ${nextName}.`
          : `${slot}: selected ${nextName}.`,
      );
    } else {
      messages.push(
        `${slot}: no compatible filament preset is available for ${resolved.printer.name} / ${resolved.process?.name ?? 'the selected process'}.`,
      );
    }
  }
  messages.push(...resolved.diagnostics.map((diagnostic) => diagnostic.message));
  return [...new Set(messages)];
}

function presetDisplayName(
  catalog: SlicingProfileCatalog,
  kind: 'process' | 'filament',
  id: WorkspacePresetId,
): string {
  const profile = catalog.profiles.find((candidate) =>
    kind === 'process' ? candidate.processPresetId === id : candidate.filamentPresetId === id,
  );
  if (!profile) return 'The previous preset';
  return kind === 'process' ? profile.processName : (profile.filamentPresetName ?? profile.filamentName);
}

/**
 * The legacy name adapter: printer, process and primary filament named as
 * typed (blank keeps the current one), matched against the pickers' choices,
 * then reconciled through stable IDs like any other selection.
 */
export function resolveProfileSelectionByNames(
  catalog: SlicingProfileCatalog,
  current: LiveProfileChoice,
  machine: string,
  process: string,
  filament: string,
): ProfileSelectionOutcome {
  const machineOption = machine.trim() ? matchPresetOption(machinePresetChoices(catalog.profiles), machine) : undefined;
  if (machine.trim() && !machineOption) {
    return refused([`Printer preset ${JSON.stringify(machine)} is unavailable.`]);
  }
  const machinePresetId = machineOption?.id ?? current.profile?.machinePresetId;
  const processOptions = processPresetChoices(catalog.profiles, machinePresetId);
  const processOption = process.trim() ? matchPresetOption(processOptions, process) : undefined;
  if (process.trim() && !processOption) {
    return refused([`Process preset ${JSON.stringify(process)} is unavailable for the selected printer.`]);
  }
  const processPresetId = processOption?.id ?? current.profile?.processPresetId;
  const filamentOptions = filamentPresetChoices(catalog.profiles, machinePresetId, processPresetId);
  const filamentOption = filament.trim() ? matchPresetOption(filamentOptions, filament) : undefined;
  if (filament.trim() && !filamentOption) {
    return refused([
      `Filament preset ${JSON.stringify(filament)} is unavailable for the selected printer and process.`,
    ]);
  }
  const filamentPresetIds = current.heads.map((selection) => selection.presetId);
  if (filamentOption) filamentPresetIds[0] = filamentOption.id;
  return resolveProfileSelection(catalog, current, {
    ...(machinePresetId ? { machinePresetId } : {}),
    ...(processPresetId ? { processPresetId } : {}),
    filamentPresetIds,
  });
}

// --- Live slots -------------------------------------------------------------------------------

/** The workspace's per-slot state: the palette, each slot's filament and its nozzle. */
export interface LiveProfileSlots {
  readonly palette: readonly FilamentSlot[];
  readonly heads: readonly HeadFilamentSelection[];
  readonly nozzles: readonly string[];
}

/**
 * The slots after a selection applies `profile`: the palette grows to the
 * profile's extruders (never past the palette's limit), each slot takes its
 * reconciled filament or the profile's own, and its nozzle from the profile.
 */
export function resolvedProfileSlots(
  profile: SlicerProfile,
  resolvedHeads: readonly HeadFilamentSelection[],
  palette: readonly FilamentSlot[],
): LiveProfileSlots {
  const count = profileExtruderCount(profile);
  const slots = palette.map((slot) => ({ ...slot }));
  while (slots.length < count && slots.length < FILAMENT_PALETTE_MAX_SLOTS) slots.push({ ...NEW_FILAMENT_SLOT });
  return {
    palette: slots,
    heads: Array.from(
      { length: slots.length },
      (_, index) => resolvedHeads[index] ?? headSelectionFromProfile(profile),
    ),
    nozzles: Array.from({ length: slots.length }, (_, toolId) => profileNozzleForTool(profile, toolId)),
  };
}

/** Each palette slot's filament and nozzle: extra ones dropped, missing ones the profile's. */
export function synchronizedHeadSlots(
  profile: SlicerProfile | null,
  heads: readonly HeadFilamentSelection[],
  nozzles: readonly string[],
  slotCount: number,
): { heads: HeadFilamentSelection[]; nozzles: string[] } {
  const nextHeads = heads.slice(0, Math.min(heads.length, slotCount));
  const nextNozzles = nozzles.slice(0, Math.min(nozzles.length, slotCount));
  while (nextHeads.length < slotCount) nextHeads.push(headSelectionFromProfile(profile));
  while (nextNozzles.length < slotCount) nextNozzles.push(profileNozzleForTool(profile, nextNozzles.length));
  return { heads: nextHeads, nozzles: nextNozzles };
}

/** One edit of the filament slots, as the Filament tab makes it. */
export type FilamentSlotEdit =
  | { readonly kind: 'add' }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'color'; readonly index: number; readonly color: string }
  | { readonly kind: 'nozzle'; readonly index: number; readonly nozzle: string };

/** What a slot edit does: the slots that result, nothing, or a refusal in the browser's words. */
export type FilamentSlotEditOutcome =
  | { readonly kind: 'edited'; readonly slots: LiveProfileSlots }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly message: string };

/** The refusal of a slot added past `FILAMENT_PALETTE_MAX_SLOTS`. */
export const FILAMENT_SLOT_LIMIT_MESSAGE = 'The 16-slot filament limit has been reached.';

/**
 * The Filament tab's slot edits (`OrcaWorkspace.addFilamentSlot`,
 * `removeAuxiliaryFilamentSlot`, `setHeadNozzle` and the palette's
 * `setColor`) on the live slots, each slot's filament and nozzle first
 * synchronized to the palette as the workspace keeps them. Adding appends a
 * `NEW_FILAMENT_SLOT` holding the profile's own filament and the nozzle the
 * profile gives that tool, refused at the palette's limit; only a palette
 * slot past the printer's heads can be removed; a colour or nozzle changes
 * only a slot that exists, a nozzle only when it differs.
 */
export function editFilamentSlots(live: LiveSlicingChoice, edit: FilamentSlotEdit): FilamentSlotEditOutcome {
  const palette = live.palette.map((slot) => ({ ...slot }));
  const { heads, nozzles } = synchronizedHeadSlots(live.profile, live.heads, live.nozzles, palette.length);
  const edited = (): FilamentSlotEditOutcome => ({ kind: 'edited', slots: { palette, heads, nozzles } });
  switch (edit.kind) {
    case 'add':
      if (palette.length >= FILAMENT_PALETTE_MAX_SLOTS)
        return { kind: 'refused', message: FILAMENT_SLOT_LIMIT_MESSAGE };
      heads.push(headSelectionFromProfile(live.profile));
      nozzles.push(profileNozzleForTool(live.profile, nozzles.length));
      palette.push({ ...NEW_FILAMENT_SLOT });
      return edited();
    case 'remove':
      if (edit.index < profileExtruderCount(live.profile) || edit.index >= palette.length) return { kind: 'unchanged' };
      heads.splice(edit.index, 1);
      nozzles.splice(edit.index, 1);
      palette.splice(edit.index, 1);
      return edited();
    case 'color':
      if (!palette[edit.index]) return { kind: 'unchanged' };
      palette[edit.index].color = edit.color;
      return edited();
    case 'nozzle':
      if (edit.index < 0 || edit.index >= nozzles.length || nozzles[edit.index] === edit.nozzle) {
        return { kind: 'unchanged' };
      }
      nozzles[edit.index] = edit.nozzle;
      return edited();
  }
}

/**
 * The slots an opened project's own filaments describe (`OrcaWorkspace`'s
 * project open): each physical filament by tool, its name and — when it is
 * a catalog preset (`preset:`) — its preset, its nozzle (0.4 mm when it
 * states none) and its colour and material as the palette takes them
 * (`paletteSlotsFrom`). A project without physical filaments keeps `palette`.
 */
export function projectFilamentSlots(
  physical: readonly Readonly<
    Pick<PhysicalFilament, 'name' | 'toolId' | 'presetId' | 'material' | 'color' | 'nozzleDiameterMm'>
  >[],
  palette: readonly FilamentSlot[],
): LiveProfileSlots {
  const sorted = [...physical].sort((left, right) => left.toolId - right.toolId);
  return {
    palette:
      sorted.length > 0
        ? paletteSlotsFrom(
            sorted.map((filament) => filament.color),
            sorted.map((filament) => filament.material),
          )
        : palette.map((slot) => ({ ...slot })),
    heads: sorted.map((filament) =>
      Object.freeze({
        name: filament.name,
        ...(filament.presetId?.startsWith('preset:') ? { presetId: filament.presetId as WorkspacePresetId } : {}),
      }),
    ),
    nozzles: sorted.map((filament) => String(filament.nozzleDiameterMm ?? 0.4)),
  };
}

// --- Configuration ----------------------------------------------------------------------------

/** The live slicing inputs: the selected profile and its slots. */
export interface LiveSlicingChoice extends LiveProfileSlots {
  readonly profile: SlicerProfile | null;
}

/**
 * The exact profile/filament state canonical save and slice consume: the
 * profile's configuration with the palette's colours, and one physical
 * filament per palette slot, keeping the identity the previous configuration
 * gave that tool. Mixed filaments are kept; a choice that would leave one of
 * their components without its filament is refused. Nothing without a profile.
 */
export function liveSlicingConfiguration(
  catalog: SlicingProfileCatalog,
  live: LiveSlicingChoice,
  previous: Pick<CanonicalSlicingConfiguration, 'filaments'>,
): CanonicalSlicingConfiguration | undefined {
  const profile = live.profile;
  if (!profile) return undefined;
  const slots = live.palette;
  const { heads, nozzles } = synchronizedHeadSlots(profile, live.heads, live.nozzles, slots.length);
  const previousPhysicalByTool = new Map(previous.filaments.physical.map((filament) => [filament.toolId, filament]));
  const config = {
    ...profile.config,
    ...slicerOverridesForSlots(slots),
    printer_settings_id: profile.machineName,
    print_settings_id: profile.processName,
  };
  const physical = slots.map((slot, index) => {
    const filamentSelection = heads[index] ?? headSelectionFromProfile(profile);
    const filamentName = filamentSelection.name || profile.filamentName;
    const exactFilamentProfile =
      profile.machinePresetId && profile.processPresetId && filamentSelection.presetId
        ? catalog.profiles.find(
            (candidate) =>
              candidate.machinePresetId === profile.machinePresetId &&
              candidate.processPresetId === profile.processPresetId &&
              candidate.filamentPresetId === filamentSelection.presetId,
          )
        : undefined;
    const filamentProfile =
      exactFilamentProfile ?? catalog.find(profile.machineName, profile.processName, filamentName) ?? profile;
    const exactMaterial = exactFilamentProfile
      ? unambiguousProfileScalar(exactFilamentProfile.config['filament_type'])
      : undefined;
    const nozzle = Number(nozzles[index] ?? '0.4');
    // A slot with neither a preset nor a name has no preset to record.
    const presetId = filamentSelection.presetId ?? (filamentName || undefined);
    return {
      id:
        previousPhysicalByTool.get(index)?.id ??
        entityId<'physical-filament'>(`import:live:filament-slot-${index + 1}`),
      name: filamentName || `Filament ${index + 1}`,
      toolId: index,
      ...(presetId !== undefined ? { presetId } : {}),
      material: (exactMaterial ?? slot.type) || 'Unknown',
      color: slot.color,
      ...(Number.isFinite(nozzle) && nozzle > 0 ? { nozzleDiameterMm: nozzle } : {}),
      config: { ...filamentProfile.config },
      enabled: true,
    };
  });
  const availableFilaments = new Set<string>([
    ...physical.map((filament) => filament.id),
    ...previous.filaments.mixed.map((filament) => filament.id),
  ]);
  const orphanedComponent = previous.filaments.mixed
    .flatMap((filament) => filament.components)
    .find((component) => !availableFilaments.has(component.filamentId));
  if (orphanedComponent) {
    throw new Error(
      `The selected profile would orphan mixed-filament component ${orphanedComponent.filamentId}; remap it before changing profiles.`,
    );
  }
  return {
    printer: {
      profileId: profile.machineName,
      toolCount: Math.max(1, slots.length),
    },
    config,
    filaments: {
      physical,
      mixed: previous.filaments.mixed,
    },
  };
}

// --- Project state ----------------------------------------------------------------------------

/** When automatic FullSpectrum pairs regenerate, and where their identities come from. */
export interface SlicingAutoPairPolicy {
  /** Whether pairs may be generated for this many physical filaments. */
  readonly allowed: (physicalCount: number) => boolean;
  /** A fresh mixed-filament identity. */
  readonly createId: () => MixedFilamentId;
}

/** `state` with its automatic pairs reconciled, when the policy allows them. */
export function withReconciledAutoPairs(state: ProjectState, policy: SlicingAutoPairPolicy): ProjectState {
  if (!policy.allowed(state.filaments.physical.length)) return state;
  const reconciliation = reconcileFullSpectrumAutoPairFilaments(
    state.filaments.physical,
    state.filaments.mixed,
    allocateFullSpectrumAutoPairIdentity(policy.createId, fullSpectrumStableNumericId),
  );
  if (!reconciliation.changed) return state;
  const next = cloneProjectState(state);
  next.filaments.mixed = reconciliation.filaments.map((filament) => cloneJson(filament));
  assertValidProjectState(next);
  return next;
}

/**
 * The validated state a slicing configuration leads to, or nothing when it is
 * the current one. Omitting settingsOverrides preserves the canonical explicit
 * map and overlays it on config; including a complete map replaces it.
 */
export function nextSlicingState(
  state: ProjectState,
  configuration: CanonicalSlicingConfiguration,
  policy: SlicingAutoPairPolicy,
): ProjectState | undefined {
  const submitsOverrides = Object.prototype.hasOwnProperty.call(configuration, 'settingsOverrides');
  if (submitsOverrides && configuration.settingsOverrides === undefined) {
    throw new Error('Submitted project setting overrides must be a complete JSON object');
  }
  const settingsOverrides = cloneJson(
    submitsOverrides ? configuration.settingsOverrides! : (state.settingsOverrides ?? {}),
  ) as ConfigMap;
  const baseConfig = cloneJson(configuration.config) as ConfigMap;
  const requested = {
    printer: cloneJson(configuration.printer) as ProjectState['printer'],
    baseConfig,
    config: applyProjectSettingsOverrides(baseConfig, settingsOverrides),
    settingsOverrides,
    filaments: {
      physical: cloneJson(configuration.filaments.physical) as PhysicalFilament[],
      mixed: cloneJson(configuration.filaments.mixed) as MixedFilament[],
    },
  };
  if (
    canonicalStringify({
      printer: state.printer,
      baseConfig: state.settingsBaseConfig ?? state.config,
      config: state.config,
      settingsOverrides: state.settingsOverrides ?? {},
      filaments: state.filaments,
    }) === canonicalStringify(requested)
  ) {
    return undefined;
  }
  const next = cloneProjectState(state);
  next.printer = requested.printer;
  next.config = requested.config;
  if (submitsOverrides || state.settingsBaseConfig !== undefined || state.settingsOverrides !== undefined) {
    next.settingsBaseConfig = requested.baseConfig;
  }
  if (submitsOverrides) next.settingsOverrides = requested.settingsOverrides;
  next.filaments = requested.filaments;
  const reconciled = withReconciledAutoPairs(next, policy);
  assertValidProjectState(reconciled);
  return reconciled;
}
