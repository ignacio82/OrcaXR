/**
 * The hosts' contract for turning a chosen catalog profile into the project's
 * own slicing configuration (`CatalogSlicingConfiguration.ts`): each request
 * and reply is a canonical JSON document, every answer comes from the
 * production module, and the shared Rust core answers the same requests
 * (`orcaxr_project::slicing::configuration_exchange`).
 *
 * A live choice (`live`) is the workspace's state these rules read:
 * `{"profile": {"machinePresetId","processPresetId","filamentPresetId"} | null,
 * "heads": [{"name","presetId"?}], "nozzles": [string], "palette": [{"color","type"}]}`.
 * A profile the catalog no longer holds reads as none, as a recomposed
 * catalog leaves the workspace. A malformed request is refused as
 * `invalid_request`; the state and configuration a host passes travel as
 * canonical JSON text.
 */
import { canonicalStringify } from '../project/domain/canonical';
import { UuidIdSource, type MixedFilamentId } from '../project/domain/ids';
import type { ProjectState } from '../project/domain/model';
import { ProjectValidationError, validateProjectState } from '../project/domain/validation';
import { FullSpectrumAutoPairProjectionError } from '../project/filaments/autoPairProjection';
import type { SlicerProfile } from '../slicer/ProfileLoader';
import type { CanonicalSlicingConfiguration } from './CanonicalWorkspaceController';
import {
  catalogDefaultProfile,
  editFilamentSlots,
  filamentPresetChoices,
  headSelectionFromProfile,
  liveSlicingConfiguration,
  machinePresetChoices,
  matchPresetOption,
  nextSlicingState,
  processPresetChoices,
  profileExtruderCount,
  projectFilamentSlots,
  resolvedProfileSlots,
  resolveProfileSelection,
  resolveProfileSelectionByNames,
  type FilamentSlotEdit,
  type HeadFilamentSelection,
  type LiveSlicingChoice,
  type ProfileSelectionOutcome,
  type SlicingProfileCatalog,
  type WorkspacePresetId,
  type WorkspacePresetOption,
} from './CatalogSlicingConfiguration';
import type { FilamentSlot } from './FilamentPalette';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';
/** The message of a configuration whose new filament identities ran out of host words. */
export const IDS_EXHAUSTED_MESSAGE = 'Too few random words were supplied for new filament identities.';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, keys: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
const has = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}

function option(value: Json): WorkspacePresetOption {
  const fields = object(value, ['id', 'label', 'name']);
  return { id: text(fields.id) as WorkspacePresetId, name: text(fields.name), label: text(fields.label) };
}
const optionJson = (option: WorkspacePresetOption) => ({ id: option.id, label: option.label, name: option.name });

function profileOf(catalog: SlicingProfileCatalog, value: Json | undefined): SlicerProfile | null {
  if (value === null) return null;
  const fields = object(value, ['filamentPresetId', 'machinePresetId', 'processPresetId']);
  const machine = text(fields.machinePresetId);
  const process = text(fields.processPresetId);
  const filament = text(fields.filamentPresetId);
  return (
    catalog.profiles.find(
      (profile) =>
        profile.machinePresetId === machine &&
        profile.processPresetId === process &&
        profile.filamentPresetId === filament,
    ) ?? null
  );
}
function head(value: Json): HeadFilamentSelection {
  const fields = object(value, ['name'], ['presetId']);
  return {
    ...(has(fields, 'presetId') ? { presetId: text(fields.presetId) as WorkspacePresetId } : {}),
    name: text(fields.name),
  };
}
function slot(value: Json): FilamentSlot {
  const fields = object(value, ['color', 'type']);
  return { color: text(fields.color), type: text(fields.type) };
}
function liveOf(catalog: SlicingProfileCatalog, value: Json | undefined): LiveSlicingChoice {
  const fields = object(value, ['heads', 'nozzles', 'palette', 'profile']);
  return {
    profile: profileOf(catalog, fields.profile),
    heads: list(fields.heads).map(head),
    nozzles: list(fields.nozzles).map(text),
    palette: list(fields.palette).map(slot),
  };
}
function liveJson(live: LiveSlicingChoice): Json {
  return {
    profile: live.profile
      ? {
          filamentPresetId: live.profile.filamentPresetId!,
          machinePresetId: live.profile.machinePresetId!,
          processPresetId: live.profile.processPresetId!,
        }
      : null,
    heads: live.heads.map((selection) => ({
      name: selection.name,
      ...(selection.presetId !== undefined ? { presetId: selection.presetId } : {}),
    })),
    nozzles: [...live.nozzles],
    palette: live.palette.map((entry) => ({ color: entry.color, type: entry.type })),
  };
}

/** A selection's reply: its feedback and, when it applied, the live choice that results. */
function selectionReply(outcome: ProfileSelectionOutcome, live: LiveSlicingChoice): string {
  const feedback = {
    applied: outcome.feedback.applied,
    messages: [...outcome.feedback.messages],
    severity: outcome.feedback.severity,
  };
  if (!outcome.profiles) return canonicalStringify({ feedback });
  const profile = outcome.profiles[0];
  const slots = resolvedProfileSlots(
    profile,
    outcome.profiles.map((each) => headSelectionFromProfile(each)),
    live.palette,
  );
  return canonicalStringify({ feedback, live: liveJson({ profile, ...slots }) });
}

/**
 * The pickers' choices: `{"machinePresetId"?, "processPresetId"?}` in,
 * `{"machines","processes","filaments"}` out, each a list of `{"id","label","name"}`,
 * with `"extruders"`, the printer's heads (`profileExtruderCount`; one without a printer).
 */
export function slicingChoicesExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), [], ['machinePresetId', 'processPresetId']);
  const machine = has(request, 'machinePresetId') ? (text(request.machinePresetId) as WorkspacePresetId) : undefined;
  const process = has(request, 'processPresetId') ? (text(request.processPresetId) as WorkspacePresetId) : undefined;
  return canonicalStringify({
    machines: machinePresetChoices(catalog.profiles).map(optionJson),
    processes: processPresetChoices(catalog.profiles, machine).map(optionJson),
    filaments: filamentPresetChoices(catalog.profiles, machine, process).map(optionJson),
    extruders: profileExtruderCount(
      (machine && catalog.profiles.find((profile) => profile.machinePresetId === machine)) || null,
    ),
  });
}

/** `{"options","query"}` in, `{"option": option | null}` out. */
export function presetMatchExchange(requestJson: string): string {
  const request = object(read(requestJson), ['options', 'query']);
  const match = matchPresetOption(list(request.options).map(option), text(request.query));
  return canonicalStringify({ option: match ? optionJson(match) : null });
}

/**
 * `{"live", "request": {"machinePresetId"?, "processPresetId"?, "filamentPresetIds"?: [id | null]}}`
 * in; `{"feedback": {"applied","messages","severity"}, "live"?}` out.
 */
export function profileSelectionExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), ['live', 'request']);
  const live = liveOf(catalog, request.live);
  const fields = object(request.request, [], ['filamentPresetIds', 'machinePresetId', 'processPresetId']);
  const outcome = resolveProfileSelection(catalog, live, {
    ...(has(fields, 'machinePresetId') ? { machinePresetId: text(fields.machinePresetId) as WorkspacePresetId } : {}),
    ...(has(fields, 'processPresetId') ? { processPresetId: text(fields.processPresetId) as WorkspacePresetId } : {}),
    ...(has(fields, 'filamentPresetIds')
      ? {
          filamentPresetIds: list(fields.filamentPresetIds).map((id) =>
            id === null ? undefined : (text(id) as WorkspacePresetId),
          ),
        }
      : {}),
  });
  return selectionReply(outcome, live);
}

/** `{"live","machine","process","filament"}` in (names as typed); a selection's reply out. */
export function profileSelectionByNamesExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), ['filament', 'live', 'machine', 'process']);
  const live = liveOf(catalog, request.live);
  return selectionReply(
    resolveProfileSelectionByNames(catalog, live, text(request.machine), text(request.process), text(request.filament)),
    live,
  );
}

/** `{"live"}` in; the selection of the catalog's default triple out, or `{}` for an empty catalog. */
export function defaultProfileSelectionExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), ['live']);
  const live = liveOf(catalog, request.live);
  const fallback = catalogDefaultProfile(catalog);
  if (!fallback) return canonicalStringify({});
  return selectionReply(
    resolveProfileSelection(catalog, live, {
      machinePresetId: fallback.machinePresetId,
      processPresetId: fallback.processPresetId,
      filamentPresetIds: [fallback.filamentPresetId],
    }),
    live,
  );
}

function slotIndex(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function slotEdit(value: Json | undefined): FilamentSlotEdit {
  const fields = object(value, [], ['add', 'color', 'nozzle', 'remove']);
  const kinds = Object.keys(fields);
  if (kinds.length !== 1) invalid();
  switch (kinds[0]) {
    case 'add':
      object(fields.add, []);
      return { kind: 'add' };
    case 'remove':
      return { kind: 'remove', index: slotIndex(object(fields.remove, ['index']).index) };
    case 'color': {
      const color = object(fields.color, ['color', 'index']);
      return { kind: 'color', index: slotIndex(color.index), color: text(color.color) };
    }
    default: {
      const nozzle = object(fields.nozzle, ['index', 'nozzle']);
      return { kind: 'nozzle', index: slotIndex(nozzle.index), nozzle: text(nozzle.nozzle) };
    }
  }
}

/**
 * `{"edit","live"}` in, an edit being `{"add":{}}`, `{"remove":{"index"}}`,
 * `{"color":{"color","index"}}` or `{"nozzle":{"index","nozzle"}}`;
 * `{"live"}` (the edited choice), `{"unchanged":true}` or
 * `{"error":"slot-limit","message"}` out.
 */
export function filamentSlotsExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), ['edit', 'live']);
  const live = liveOf(catalog, request.live);
  const outcome = editFilamentSlots(live, slotEdit(request.edit));
  switch (outcome.kind) {
    case 'edited':
      return canonicalStringify({ live: liveJson({ profile: live.profile, ...outcome.slots }) });
    case 'unchanged':
      return canonicalStringify({ unchanged: true });
    case 'refused':
      return canonicalStringify({ error: 'slot-limit', message: outcome.message });
  }
}

/**
 * `{"palette"}` in, against a project; `{"heads","nozzles","palette"}` out:
 * the slots its own physical filaments describe, as an opened project's.
 */
export function projectFilamentSlotsExchange(state: ProjectState, requestJson: string): string {
  const request = object(read(requestJson), ['palette']);
  const slots = projectFilamentSlots(state.filaments.physical, list(request.palette).map(slot));
  const json = liveJson({ profile: null, ...slots }) as JsonObject;
  return canonicalStringify({ heads: json.heads, nozzles: json.nozzles, palette: json.palette });
}

function stateOf(json: Json | undefined): ProjectState {
  const state = read(text(json)) as unknown as ProjectState;
  let valid: boolean;
  try {
    valid = !validateProjectState(state).some((issue) => issue.severity === 'error');
  } catch {
    // Not even the shape of a project.
    valid = false;
  }
  if (!valid) invalid();
  return state;
}

/**
 * `{"live","stateJson"}` in; `{"configurationJson": text | null}` (none without
 * a profile) or `{"error":"orphaned-mixed-component","message"}` out.
 */
export function slicingConfigurationExchange(catalog: SlicingProfileCatalog, requestJson: string): string {
  const request = object(read(requestJson), ['live', 'stateJson']);
  const live = liveOf(catalog, request.live);
  const state = stateOf(request.stateJson);
  let configuration: CanonicalSlicingConfiguration | undefined;
  try {
    configuration = liveSlicingConfiguration(catalog, live, state);
  } catch (error) {
    return canonicalStringify({ error: 'orphaned-mixed-component', message: (error as Error).message });
  }
  return canonicalStringify({ configurationJson: configuration ? canonicalStringify(configuration) : null });
}

/** A configuration document: its printer, base config, optional overrides and both filament lists. */
function configurationOf(json: Json | undefined): CanonicalSlicingConfiguration {
  const value = read(text(json));
  const fields = object(value, ['config', 'filaments', 'printer'], ['settingsOverrides']);
  for (const key of ['config', 'printer', 'settingsOverrides']) {
    const member = fields[key];
    if (has(fields, key) && (member === null || typeof member !== 'object' || Array.isArray(member))) invalid();
  }
  const filaments = object(fields.filaments, ['mixed', 'physical']);
  list(filaments.mixed);
  list(filaments.physical);
  return value as unknown as CanonicalSlicingConfiguration;
}

class WordsExhausted extends Error {}

/**
 * `{"autoPairs": {"enabled","confirmedCounts"}, "configurationJson", "stateJson"}`
 * and the host's random words for new identities in; `{"stateJson"}`,
 * `{"unchanged": true}`, or `{"error": "auto-pairs" | "invalid" | "ids-exhausted", "message"}` out.
 * Pairs regenerate when enabled for at most four physical filaments, or for a
 * count the operator confirmed.
 */
export function nextSlicingStateExchange(requestJson: string, words: readonly number[]): string {
  const request = object(read(requestJson), ['autoPairs', 'configurationJson', 'stateJson']);
  const autoPairs = object(request.autoPairs, ['confirmedCounts', 'enabled']);
  if (typeof autoPairs.enabled !== 'boolean') invalid();
  const enabled = autoPairs.enabled;
  const confirmed = new Set(
    list(autoPairs.confirmedCounts).map((count) => {
      if (typeof count !== 'number') invalid();
      return count;
    }),
  );
  const state = stateOf(request.stateJson);
  const configuration = configurationOf(request.configurationJson);
  let next = 0;
  const ids = new UuidIdSource(() => {
    if (next >= words.length) throw new WordsExhausted();
    return words[next++];
  });
  try {
    const result = nextSlicingState(state, configuration, {
      allowed: (count) => enabled && !(count > 4 && !confirmed.has(count)),
      createId: () => ids.next('mixed-filament') as MixedFilamentId,
    });
    return canonicalStringify(result ? { stateJson: canonicalStringify(result) } : { unchanged: true });
  } catch (error) {
    if (error instanceof WordsExhausted) {
      return canonicalStringify({ error: 'ids-exhausted', message: IDS_EXHAUSTED_MESSAGE });
    }
    if (error instanceof ProjectValidationError) {
      return canonicalStringify({ error: 'invalid', message: error.message });
    }
    if (error instanceof FullSpectrumAutoPairProjectionError) {
      return canonicalStringify({ error: 'auto-pairs', message: error.message });
    }
    throw error;
  }
}
