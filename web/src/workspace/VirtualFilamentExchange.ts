/**
 * The hosts' contract for the virtual filament library: each request and
 * reply is a canonical JSON document, every answer comes from the production
 * modules the browser's library runs (`virtualFilamentLibraryModel.ts`,
 * `CanonicalVirtualFilamentLibraryAdapter.ts`, `VirtualFilamentMutation.ts`,
 * the pinned Match search), and the shared Rust core answers the same
 * requests (`orcaxr_project::filaments::library::exchange`).
 *
 * - `virtualFilamentLibraryExchange(state, "{}")`: the library the project
 *   shows — `{"physicalChoices","mixedRows","matchCandidates","status"}`,
 *   each row with its one-line `summary` — or `{"error"}` when it cannot be
 *   shown. A `library` below is this reply.
 * - `virtualFilamentFormDefaultsExchange({"library","operation","filamentId"})`:
 *   the author dialog's fields for adding (`filamentId` null), editing or
 *   duplicating a row.
 * - `virtualFilamentFormExchange({"library","form","search"})`: what the
 *   dialog shows for its fields — `{"issues","preview"}` and, when complete,
 *   the validated `draft`; the Match `ranking` and the search the fields ask
 *   for (`matchSearch`, null while incomplete), the Ratio pigment preview and
 *   triangle marker, the Gradient preview (null while incomplete). `search`
 *   is null or `{"status","candidates","error"?}`.
 * - `virtualFilamentTriangleExchange({"x","y"})`: the proportions the
 *   triangle picker writes for a point of its view box.
 * - `virtualFilamentMatchSearchExchange({"library","targetColor","minComponentPercent"})`:
 *   the pinned search's candidates over the library's compatible heads.
 * - `virtualFilamentMutationExchange(state, {"operation",...})`: one library
 *   edit planned on the project — `{"batchJson","label","step","outcome",...}`,
 *   the step's commands as one intent batch — or `{"error"}` in the
 *   recipe's or controller's words.
 *
 * A malformed request is refused as `invalid_request`.
 */
import {
  encodeProjectBatch,
  PROJECT_INTENT_VERSION,
  type ProjectCommandWire,
} from '../../../contracts/generated/project-intents';
import { canonicalStringify } from '../project/domain/canonical';
import type { MixedFilamentId, PhysicalFilamentId } from '../project/domain/ids';
import type { ProjectState } from '../project/domain/model';
import { searchSuppliedPaletteColorMatch } from '../project/filaments/colorMatchSearch';
import type { MixedFilamentSerializableProjection } from '../project/filaments/mixedFilamentAuthoring';
import {
  authorFormFor,
  draftSummary,
  gradientPreview,
  immutableSnapshot,
  libraryStatus,
  matchCandidateDetail,
  matchCandidateTitle,
  normalizeMatchTargetColor,
  parseStrictInteger,
  ratioPigmentPreview,
  triangleMarker,
  triangleWeightTextsAt,
  validateAuthorForm,
  type VirtualFilamentAuthorForm,
  type VirtualFilamentAuthorOperation,
  type VirtualFilamentIssue,
  type VirtualFilamentLibraryRow,
  type VirtualFilamentLibrarySnapshot,
  type VirtualFilamentMatchCandidate,
  type VirtualFilamentMatchSearchStatus,
  type VirtualFilamentPhysicalChoice,
  type VirtualFilamentValidatedDraft,
} from '../project/filaments/virtualFilamentLibraryModel';
import { createIntentTextEncoder } from '../project/PreparedProjectCommands';
import {
  matchSearchCandidates,
  matchSearchEligible,
  matchSearchInput,
  projectCanonicalVirtualFilamentLibrary,
  toFullSpectrumRecipeDraft,
} from '../ui/dom/CanonicalVirtualFilamentLibraryAdapter';
import {
  planVirtualFilamentMutation,
  virtualFilamentLibraryCanonical,
  type CanonicalVirtualFilamentLibrarySnapshot,
} from './VirtualFilamentMutation';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

/** The revision and hash an exchange's snapshot carries: the hosts guard the project themselves. */
const EXCHANGE_REVISION = 0;
const EXCHANGE_HASH = 'exchange';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) invalid();
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function number(value: Json | undefined): number {
  if (typeof value !== 'number') invalid();
  return value;
}
function bool(value: Json | undefined): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function texts(value: Json | undefined): string[] {
  return list(value).map(text);
}
function numbers(value: Json | undefined): number[] {
  return list(value).map(number);
}
function oneOf<T extends string>(value: Json | undefined, choices: readonly T[]): T {
  const chosen = text(value);
  if (!(choices as readonly string[]).includes(chosen)) invalid();
  return chosen as T;
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}
/** A refusal the production modules throw, in their own words. */
function refused(error: unknown): string {
  if (!(error instanceof Error) || error.message === INVALID_REQUEST) throw error;
  return canonicalStringify({ error: error.message });
}

// --- Library documents -------------------------------------------------------------------------

const MODES = ['ratio', 'cycle', 'match', 'gradient'] as const;
const DIRECTIONS = ['a-to-b', 'b-to-a'] as const;

function projectionJson(projection: MixedFilamentSerializableProjection): Json {
  return { ...projection };
}
function readProjection(value: Json | undefined): MixedFilamentSerializableProjection {
  const fields = object(value, [
    'component_a',
    'component_b',
    'custom',
    'distribution_mode',
    'gradient_component_ids',
    'gradient_component_weights',
    'gradient_enabled',
    'gradient_end',
    'gradient_start',
    'local_z_max_sublayers',
    'manual_pattern',
    'mix_b_percent',
    'ratio_a',
    'ratio_b',
    'ui_mode',
  ]);
  const uiMode = number(fields.ui_mode);
  const distributionMode = number(fields.distribution_mode);
  if (![0, 2, 3].includes(uiMode) || ![0, 2].includes(distributionMode) || fields.custom !== true) invalid();
  return {
    ui_mode: uiMode as 0 | 2 | 3,
    component_a: number(fields.component_a),
    component_b: number(fields.component_b),
    mix_b_percent: number(fields.mix_b_percent),
    ratio_a: number(fields.ratio_a),
    ratio_b: number(fields.ratio_b),
    manual_pattern: text(fields.manual_pattern),
    gradient_component_ids: text(fields.gradient_component_ids),
    gradient_component_weights: text(fields.gradient_component_weights),
    distribution_mode: distributionMode as 0 | 2,
    local_z_max_sublayers: number(fields.local_z_max_sublayers),
    gradient_enabled: bool(fields.gradient_enabled),
    gradient_start: number(fields.gradient_start),
    gradient_end: number(fields.gradient_end),
    custom: true,
  };
}

function componentJson(component: { readonly filamentId: string; readonly toolId: number }): Json {
  return { filamentId: component.filamentId, toolId: component.toolId };
}
function readComponent(value: Json): { filamentId: string; toolId: number } {
  const fields = object(value, ['filamentId', 'toolId']);
  return { filamentId: text(fields.filamentId), toolId: number(fields.toolId) };
}
function readWeightedComponent(value: Json): { filamentId: string; toolId: number; weight: number } {
  const fields = object(value, ['filamentId', 'toolId', 'weight']);
  return { filamentId: text(fields.filamentId), toolId: number(fields.toolId), weight: number(fields.weight) };
}

/** A validated draft as the library and the dialog hold it. */
export function draftJson(draft: VirtualFilamentValidatedDraft): Json {
  const common = {
    componentASurfaceOffsetMm: draft.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: draft.componentBSurfaceOffsetMm,
    displayColor: draft.displayColor,
    mode: draft.mode,
    name: draft.name,
  };
  switch (draft.mode) {
    case 'ratio':
      return {
        ...common,
        components: draft.components.map(componentJson),
        mixBPercent: draft.mixBPercent,
        projection: projectionJson(draft.projection),
        ...(draft.triangleWeightsPercent ? { triangleWeightsPercent: [...draft.triangleWeightsPercent] } : {}),
      };
    case 'cycle':
      return {
        ...common,
        components: draft.components.map(componentJson),
        groups: draft.groups.map((group) => [...group]),
        manualPattern: draft.manualPattern,
        normalizedPattern: draft.normalizedPattern,
        sequence: [...draft.sequence],
      };
    case 'match':
      return {
        ...common,
        components: draft.components.map((component) => ({
          filamentId: component.filamentId,
          toolId: component.toolId,
          weight: component.weight,
        })),
        deltaE2000: draft.deltaE2000,
        minComponentPercent: draft.minComponentPercent,
        normalizedTargetColor: draft.normalizedTargetColor,
        previewColor: draft.previewColor,
        projection: projectionJson(draft.projection),
        selectedCandidateId: draft.selectedCandidateId,
        targetColor: draft.targetColor,
      };
    case 'gradient':
      return {
        ...common,
        components: draft.components.map(componentJson),
        direction: draft.direction,
        localZMaxSublayers: draft.localZMaxSublayers,
        projection: projectionJson(draft.projection),
      };
  }
}
const COMMON_DRAFT = ['componentASurfaceOffsetMm', 'componentBSurfaceOffsetMm', 'displayColor', 'mode', 'name'];
export function readDraft(value: Json | undefined): VirtualFilamentValidatedDraft {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  const draftMode = oneOf(value.mode, MODES);
  const keys =
    draftMode === 'ratio'
      ? { required: [...COMMON_DRAFT, 'components', 'mixBPercent', 'projection'], optional: ['triangleWeightsPercent'] }
      : draftMode === 'cycle'
        ? { required: [...COMMON_DRAFT, 'components', 'groups', 'manualPattern', 'normalizedPattern', 'sequence'] }
        : draftMode === 'match'
          ? {
              required: [
                ...COMMON_DRAFT,
                'components',
                'deltaE2000',
                'minComponentPercent',
                'normalizedTargetColor',
                'previewColor',
                'projection',
                'selectedCandidateId',
                'targetColor',
              ],
            }
          : { required: [...COMMON_DRAFT, 'components', 'direction', 'localZMaxSublayers', 'projection'] };
  const fields = object(value, keys.required, 'optional' in keys ? keys.optional : []);
  const common = {
    name: text(fields.name),
    displayColor: text(fields.displayColor),
    componentASurfaceOffsetMm: number(fields.componentASurfaceOffsetMm),
    componentBSurfaceOffsetMm: number(fields.componentBSurfaceOffsetMm),
  };
  if (draftMode === 'ratio') {
    const triangle = fields.triangleWeightsPercent === undefined ? undefined : numbers(fields.triangleWeightsPercent);
    if (triangle && triangle.length !== 3) invalid();
    return {
      ...common,
      mode: 'ratio',
      components: list(fields.components).map(readComponent),
      mixBPercent: number(fields.mixBPercent),
      ...(triangle ? { triangleWeightsPercent: triangle as [number, number, number] } : {}),
      projection: readProjection(fields.projection),
    };
  }
  if (draftMode === 'cycle') {
    return {
      ...common,
      mode: 'cycle',
      manualPattern: text(fields.manualPattern),
      normalizedPattern: text(fields.normalizedPattern),
      components: list(fields.components).map(readComponent),
      groups: list(fields.groups).map(numbers),
      sequence: numbers(fields.sequence),
    };
  }
  if (draftMode === 'match') {
    return {
      ...common,
      mode: 'match',
      targetColor: text(fields.targetColor),
      normalizedTargetColor: text(fields.normalizedTargetColor),
      minComponentPercent: number(fields.minComponentPercent),
      selectedCandidateId: text(fields.selectedCandidateId),
      previewColor: text(fields.previewColor),
      deltaE2000: number(fields.deltaE2000),
      components: list(fields.components).map(readWeightedComponent),
      projection: readProjection(fields.projection),
    };
  }
  const components = list(fields.components).map(readComponent);
  if (components.length !== 2) invalid();
  return {
    ...common,
    mode: 'gradient',
    components: [components[0], components[1]],
    direction: oneOf(fields.direction, DIRECTIONS),
    localZMaxSublayers: number(fields.localZMaxSublayers),
    projection: readProjection(fields.projection),
  };
}

function choiceJson(choice: VirtualFilamentPhysicalChoice): Json {
  return {
    color: choice.color,
    compatible: choice.compatible,
    enabled: choice.enabled,
    id: choice.id,
    ...(choice.incompatibilityReason !== undefined ? { incompatibilityReason: choice.incompatibilityReason } : {}),
    material: choice.material,
    name: choice.name,
    toolId: choice.toolId,
  };
}
function readChoice(value: Json): VirtualFilamentPhysicalChoice {
  const fields = object(
    value,
    ['color', 'compatible', 'enabled', 'id', 'material', 'name', 'toolId'],
    ['incompatibilityReason'],
  );
  return {
    id: text(fields.id),
    toolId: number(fields.toolId),
    name: text(fields.name),
    material: text(fields.material),
    color: text(fields.color),
    enabled: bool(fields.enabled),
    compatible: bool(fields.compatible),
    ...(fields.incompatibilityReason !== undefined
      ? { incompatibilityReason: text(fields.incompatibilityReason) }
      : {}),
  };
}
function candidateJson(candidate: VirtualFilamentMatchCandidate): Json {
  return {
    components: candidate.components.map((component) => ({
      filamentId: component.filamentId,
      weight: component.weight,
    })),
    id: candidate.id,
    ...(candidate.label !== undefined ? { label: candidate.label } : {}),
    previewColor: candidate.previewColor,
  };
}
function readCandidate(value: Json): VirtualFilamentMatchCandidate {
  const fields = object(value, ['components', 'id', 'previewColor'], ['label']);
  return {
    id: text(fields.id),
    ...(fields.label !== undefined ? { label: text(fields.label) } : {}),
    components: list(fields.components).map((component) => {
      const entry = object(component, ['filamentId', 'weight']);
      return { filamentId: text(entry.filamentId), weight: number(entry.weight) };
    }),
    previewColor: text(fields.previewColor),
  };
}
function rowJson(row: VirtualFilamentLibraryRow, snapshot: VirtualFilamentLibrarySnapshot): Json {
  return {
    ...(row.dependencyLabels ? { dependencyLabels: [...row.dependencyLabels] } : {}),
    draft: draftJson(row.draft),
    enabled: row.enabled,
    id: row.id,
    summary: draftSummary(row.draft, snapshot),
  };
}
function readRow(value: Json): VirtualFilamentLibraryRow {
  const fields = object(value, ['draft', 'enabled', 'id', 'summary'], ['dependencyLabels']);
  text(fields.summary);
  return {
    id: text(fields.id),
    enabled: bool(fields.enabled),
    draft: readDraft(fields.draft),
    ...(fields.dependencyLabels !== undefined ? { dependencyLabels: texts(fields.dependencyLabels) } : {}),
  };
}
function libraryJson(snapshot: VirtualFilamentLibrarySnapshot): Json {
  return {
    matchCandidates: snapshot.matchCandidates.map(candidateJson),
    mixedRows: snapshot.mixedRows.map((row) => rowJson(row, snapshot)),
    physicalChoices: snapshot.physicalChoices.map(choiceJson),
    status: libraryStatus(snapshot),
  };
}
/** A `library` field: the library exchange's reply. */
function readLibrary(value: Json | undefined): VirtualFilamentLibrarySnapshot {
  const fields = object(value, ['matchCandidates', 'mixedRows', 'physicalChoices', 'status']);
  text(fields.status);
  return {
    sourceRevision: EXCHANGE_REVISION,
    sourceHash: EXCHANGE_HASH,
    physicalChoices: list(fields.physicalChoices).map(readChoice),
    mixedRows: list(fields.mixedRows).map(readRow),
    matchCandidates: list(fields.matchCandidates).map(readCandidate),
  };
}

function formJson(form: VirtualFilamentAuthorForm): Json {
  return {
    componentASurfaceOffsetMm: form.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: form.componentBSurfaceOffsetMm,
    cycle: { manualPattern: form.cycle.manualPattern },
    displayColor: form.displayColor,
    gradient: {
      componentIds: [...form.gradient.componentIds],
      direction: form.gradient.direction,
      localZMaxSublayers: form.gradient.localZMaxSublayers,
    },
    match: {
      minComponentPercent: form.match.minComponentPercent,
      ...(form.match.selectedCandidateId !== undefined ? { selectedCandidateId: form.match.selectedCandidateId } : {}),
      targetColor: form.match.targetColor,
    },
    mode: form.mode,
    name: form.name,
    ratio: {
      componentCount: form.ratio.componentCount,
      componentIds: [...form.ratio.componentIds],
      mixBPercent: form.ratio.mixBPercent,
      triangleWeights: [...form.ratio.triangleWeights],
    },
  };
}
function readForm(value: Json | undefined): VirtualFilamentAuthorForm {
  const fields = object(value, [
    'componentASurfaceOffsetMm',
    'componentBSurfaceOffsetMm',
    'cycle',
    'displayColor',
    'gradient',
    'match',
    'mode',
    'name',
    'ratio',
  ]);
  const ratio = object(fields.ratio, ['componentCount', 'componentIds', 'mixBPercent', 'triangleWeights']);
  const componentCount = number(ratio.componentCount);
  if (componentCount !== 2 && componentCount !== 3) invalid();
  const triangleWeights = texts(ratio.triangleWeights);
  if (triangleWeights.length !== 3) invalid();
  const cycle = object(fields.cycle, ['manualPattern']);
  const match = object(fields.match, ['minComponentPercent', 'targetColor'], ['selectedCandidateId']);
  const gradient = object(fields.gradient, ['componentIds', 'direction', 'localZMaxSublayers']);
  const gradientIds = texts(gradient.componentIds);
  if (gradientIds.length !== 2) invalid();
  return {
    name: text(fields.name),
    displayColor: text(fields.displayColor),
    componentASurfaceOffsetMm: text(fields.componentASurfaceOffsetMm),
    componentBSurfaceOffsetMm: text(fields.componentBSurfaceOffsetMm),
    mode: oneOf(fields.mode, MODES),
    ratio: {
      componentCount,
      componentIds: texts(ratio.componentIds),
      mixBPercent: text(ratio.mixBPercent),
      triangleWeights: triangleWeights as [string, string, string],
    },
    cycle: { manualPattern: text(cycle.manualPattern) },
    match: {
      targetColor: text(match.targetColor),
      minComponentPercent: text(match.minComponentPercent),
      ...(match.selectedCandidateId !== undefined ? { selectedCandidateId: text(match.selectedCandidateId) } : {}),
    },
    gradient: {
      componentIds: [gradientIds[0], gradientIds[1]],
      direction: oneOf(gradient.direction, DIRECTIONS),
      localZMaxSublayers: text(gradient.localZMaxSublayers),
    },
  };
}
function readSearch(value: Json | undefined): VirtualFilamentMatchSearchStatus | undefined {
  if (value === null) return undefined;
  const fields = object(value, ['candidates', 'status'], ['error']);
  return {
    status: oneOf(fields.status, ['pending', 'ready', 'error'] as const),
    candidates: list(fields.candidates).map(readCandidate),
    ...(fields.error !== undefined ? { error: text(fields.error) } : {}),
  };
}
function issueJson(issue: VirtualFilamentIssue): Json {
  return {
    ...(issue.endOffset !== undefined ? { endOffset: issue.endOffset } : {}),
    ...(issue.field !== undefined ? { field: issue.field } : {}),
    message: issue.message,
    ...(issue.startOffset !== undefined ? { startOffset: issue.startOffset } : {}),
  };
}

// --- Exchanges ---------------------------------------------------------------------------------

/** `{}` → the library `state` shows, or `{"error"}` when it cannot be shown. */
export function virtualFilamentLibraryExchange(state: ProjectState, requestJson: string): string {
  object(read(requestJson), []);
  try {
    return canonicalStringify(libraryJson(librarySnapshot(state)));
  } catch (error) {
    return refused(error);
  }
}

/** The library as the browser's library renders it (`immutableSnapshot` of the adapter's projection). */
function librarySnapshot(state: ProjectState): VirtualFilamentLibrarySnapshot {
  return immutableSnapshot(projectCanonicalVirtualFilamentLibrary(canonicalOf(state), []));
}
function canonicalOf(state: ProjectState): CanonicalVirtualFilamentLibrarySnapshot {
  return virtualFilamentLibraryCanonical(state, EXCHANGE_REVISION, EXCHANGE_HASH);
}

/** `{"library","operation","filamentId"}` → the author dialog's opening fields. */
export function virtualFilamentFormDefaultsExchange(requestJson: string): string {
  const request = object(read(requestJson), ['filamentId', 'library', 'operation']);
  const library = readLibrary(request.library);
  const operation = oneOf<VirtualFilamentAuthorOperation>(request.operation, ['add', 'edit', 'duplicate']);
  let row: VirtualFilamentLibraryRow | undefined;
  if (operation === 'add') {
    if (request.filamentId !== null) invalid();
  } else {
    const id = text(request.filamentId);
    row = library.mixedRows.find((candidate) => candidate.id === id) ?? invalid();
  }
  return canonicalStringify(formJson(authorFormFor(library, operation, row)));
}

/** `{"library","form","search"}` → the dialog's issues, preview, draft and mode views. */
export function virtualFilamentFormExchange(requestJson: string): string {
  const request = object(read(requestJson), ['form', 'library', 'search']);
  const library = readLibrary(request.library);
  const form = readForm(request.form);
  const search = readSearch(request.search);
  const validation = validateAuthorForm(form, library, search);
  const reply: JsonObject = {
    issues: validation.issues.map(issueJson),
    preview: validation.preview,
  };
  if (validation.draft) reply.draft = draftJson(validation.draft);
  if (validation.matchRanking) {
    const ranking = validation.matchRanking;
    reply.ranking = {
      issues: ranking.issues.map(issueJson),
      ...(ranking.normalizedTargetColor !== undefined ? { normalizedTargetColor: ranking.normalizedTargetColor } : {}),
      ranked: ranking.ranked.map((view, index) => ({
        candidateId: view.candidate.id,
        deltaE2000: view.ranked.deltaE2000,
        detail: matchCandidateDetail(view, library),
        previewColor: view.ranked.previewColor,
        title: matchCandidateTitle(index, view.candidate),
      })),
    };
  }
  if (form.mode === 'ratio') {
    const preview = ratioPigmentPreview(form, library);
    reply.ratioPreview = preview ? { color: preview.color, text: preview.text } : null;
    if (form.ratio.componentCount === 3) {
      const marker = triangleMarker(form.ratio.triangleWeights);
      reply.triangle = { valueText: marker.valueText, weights: [...marker.weights], x: marker.x, y: marker.y };
    }
  }
  if (form.mode === 'gradient') {
    const preview = gradientPreview(form, library);
    reply.gradientPreview = preview ? { bottom: preview.bottom, text: preview.text, top: preview.top } : null;
  }
  if (form.mode === 'match') {
    // The dialog's `ensureMatchSearch`: a search only for a strict target and a minimum within 0–50.
    const targetColor = normalizeMatchTargetColor(form.match.targetColor);
    const minComponentPercent = parseStrictInteger(form.match.minComponentPercent);
    reply.matchSearch =
      targetColor && minComponentPercent !== undefined && minComponentPercent >= 0 && minComponentPercent <= 50
        ? { minComponentPercent, targetColor }
        : null;
  }
  return canonicalStringify(reply);
}

/**
 * `{"x","y"}` → `{"weights"}`, the three proportions the triangle picker
 * writes; `{"error"}` where a point is so far off that its barycentric
 * weights are not finite.
 */
export function virtualFilamentTriangleExchange(requestJson: string): string {
  const request = object(read(requestJson), ['x', 'y']);
  const x = number(request.x);
  const y = number(request.y);
  try {
    return canonicalStringify({ weights: triangleWeightTextsAt(x, y) });
  } catch (error) {
    return refused(error);
  }
}

/** `{"library","targetColor","minComponentPercent"}` → `{"candidates"}` the pinned search proposes. */
export function virtualFilamentMatchSearchExchange(requestJson: string): string {
  const request = object(read(requestJson), ['library', 'minComponentPercent', 'targetColor']);
  const library = readLibrary(request.library);
  const targetColor = text(request.targetColor);
  const minComponentPercent = number(request.minComponentPercent);
  // The library's choices are the adapter's canonical heads: normalized colours, the material as named.
  const eligible = matchSearchEligible(
    library.physicalChoices.map((choice) => ({
      id: choice.id as PhysicalFilamentId,
      engineToolId: choice.toolId,
      name: choice.name,
      material: choice.material,
      color: choice.color,
      enabled: choice.enabled,
    })),
  );
  if (eligible.length < 2) return canonicalStringify({ candidates: [] });
  const result = searchSuppliedPaletteColorMatch(matchSearchInput(eligible, { targetColor, minComponentPercent }));
  return canonicalStringify({ candidates: matchSearchCandidates(result, eligible).map(candidateJson) });
}

/**
 * `{"operation", ...}` on `state` → the step one library edit submits:
 * `add` `{"draft","newId"}`, `edit` `{"filamentId","draft"}`, `duplicate`
 * `{"sourceFilamentId","draft","newId"}`, `set-enabled`
 * `{"filamentId","enabled"}`, `delete` `{"filamentId"}`. A draft is the form
 * exchange's validated `draft`, converted as the browser's adapter converts it.
 */
export function virtualFilamentMutationExchange(state: ProjectState, requestJson: string): string {
  const raw = read(requestJson);
  const operation = oneOf(
    object(raw, ['operation'], ['draft', 'enabled', 'filamentId', 'newId', 'sourceFilamentId']).operation,
    ['add', 'edit', 'duplicate', 'set-enabled', 'delete'] as const,
  );
  const request =
    operation === 'add'
      ? object(raw, ['draft', 'newId', 'operation'])
      : operation === 'edit'
        ? object(raw, ['draft', 'filamentId', 'operation'])
        : operation === 'duplicate'
          ? object(raw, ['draft', 'newId', 'operation', 'sourceFilamentId'])
          : operation === 'set-enabled'
            ? object(raw, ['enabled', 'filamentId', 'operation'])
            : object(raw, ['filamentId', 'operation']);
  const draft = request.draft === undefined ? undefined : readDraft(request.draft);
  const newId = request.newId === undefined ? undefined : (text(request.newId) as MixedFilamentId);
  const filamentId = request.filamentId === undefined ? undefined : text(request.filamentId);
  const sourceFilamentId = request.sourceFilamentId === undefined ? undefined : text(request.sourceFilamentId);
  const enabled = request.enabled === undefined ? undefined : bool(request.enabled);
  try {
    const canonical = canonicalOf(state);
    const resolve = (value: string): MixedFilamentId => {
      const row = canonical.mixed.find((entry) => String(entry.filament.id) === value);
      if (!row) throw new Error(`Unknown virtual filament ${value}`);
      return row.filament.id;
    };
    const plan = planVirtualFilamentMutation(
      state,
      operation === 'add'
        ? { operation, draft: toFullSpectrumRecipeDraft(draft!, canonical), requestedId: newId! }
        : operation === 'edit'
          ? (() => {
              const id = resolve(filamentId!);
              return { operation, filamentId: id, draft: toFullSpectrumRecipeDraft(draft!, canonical, id) };
            })()
          : operation === 'duplicate'
            ? (() => {
                const id = resolve(sourceFilamentId!);
                return {
                  operation,
                  sourceFilamentId: id,
                  draft: toFullSpectrumRecipeDraft(draft!, canonical, id, true),
                  requestedDuplicateId: newId!,
                };
              })()
            : operation === 'set-enabled'
              ? { operation, filamentId: resolve(filamentId!), enabled: enabled! }
              : { operation, filamentId: resolve(filamentId!) },
      // Every new filament is named by the request.
      () => invalid(),
    );
    const encode = createIntentTextEncoder();
    const commands: ProjectCommandWire[] =
      plan.step.kind === 'intent' ? [plan.step.command(encode)] : plan.step.wire(encode);
    const outcome = plan.outcome;
    return canonicalStringify({
      batchJson: encodeProjectBatch({ version: PROJECT_INTENT_VERSION, label: encode(plan.label), commands }),
      label: plan.label,
      operation: outcome.operation,
      step: plan.step.kind,
      ...('filamentId' in outcome ? { filamentId: outcome.filamentId } : {}),
      ...('outcome' in outcome ? { dependencyPaths: [...outcome.dependencyPaths], outcome: outcome.outcome } : {}),
    });
  } catch (error) {
    return refused(error);
  }
}
