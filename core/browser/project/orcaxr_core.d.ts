/* tslint:disable */
/* eslint-disable */

export class CapturedHistory {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    dirty_categories(): string;
    has_label(undo: boolean): boolean;
    label_length(undo: boolean): number;
    label_text(undo: boolean, start: number, count: number): Uint16Array;
    redo_count(): number;
    undo_count(): number;
}

export class CapturedProject {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Explicit bulk export, not a per-edit projection. A hard caller-supplied
     * output budget applies during writing. This synchronous operation must not
     * run on a production authority worker until task isolation is provided.
     */
    export_json(max_bytes: number): ProjectBytes;
    hash(): string;
    id(start: number, count: number): Uint16Array;
    id_length(): number;
    /**
     * A `PaintPaletteRequest`; returns the project's `PaintPalette`.
     */
    paint_palette(request: string): string;
    query(version: number): ProjectQueryNode;
    revision(): number;
    /**
     * A `SettingsSessionRequest`: the settings editor for one node, whose
     * commits become guarded project intents.
     */
    settings_editor(request: string, collator?: any | null, folder?: any | null): SettingsEditor;
    /**
     * A `SettingsExplainRequest`; returns a `SettingsExplainResult`.
     */
    settings_explain(request: string): string;
    /**
     * A `SettingsTargetRequest`; returns a `SettingsSnapshotResult`.
     */
    settings_snapshot(request: string): string;
    /**
     * A `SettingsTargetPageRequest`; returns a `SettingsTargetPage`.
     */
    settings_targets(request: string): string;
}

export class CapturedSelection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    id(position: number, start: number, count: number): Uint16Array;
    id_length(position: number): number;
    kind(position: number): number;
    primary_index(): number;
}

/**
 * Installed printers and custom presets over a pinned catalog.
 */
export class PresetLibrary {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A `LibraryOperation`; returns its `LibraryOutcome`.
     */
    apply(operation: string): string;
    /**
     * Consume an upload and move onto it; returns a `LibraryOutcome`.
     */
    apply_update(next: ProfileCatalogUpload): string;
    /**
     * A `LibraryBaseRequest`; returns `LibraryBases`.
     */
    bases(request: string): string;
    /**
     * The composed catalog, as the profile catalog the app reads.
     */
    catalog(): ProfileCatalog;
    /**
     * Consume `upload` as the system catalog. `stored` is the text the host
     * saved, if any; `limits` (bytes, nodes, text units, number bytes, depth)
     * bound reading it. Without a collator the exact ASCII root order applies.
     */
    static create(upload: ProfileCatalogUpload, stored: Uint8Array | null | undefined, limits: Float64Array, collator?: any | null): PresetLibrary;
    custom_preset(position: number): string;
    /**
     * The bundle to hand the operator, as UTF-8.
     */
    export_bundle(exported_at: string, max_bytes: number): Uint8Array;
    /**
     * A bundle's bytes; returns its `LibraryOutcome`.
     */
    import_bundle(bundle: Uint8Array, limits: Float64Array): string;
    inventory(): string;
    /**
     * The latest outcome's issue at `position`, as a `LibraryIssue`.
     */
    issue(position: number): string;
    issue_count(): number;
    /**
     * Consume an upload of a newer catalog; returns a `LibraryUpdatePlan`.
     */
    plan_update(next: ProfileCatalogUpload): string;
    /**
     * The text to store, as UTF-8.
     */
    state(max_bytes: number): Uint8Array;
    view(): string;
}

/**
 * A loaded catalog: compiled, or refused with its diagnostics.
 */
export class ProfileCatalog {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    diagnostic(position: number): string;
    diagnostic_count(): number;
    /**
     * `CatalogTargetRequest` in, the `CatalogPreflightTarget` of a
     * `PreflightRequest` out. More than `max_tools` tools is refused.
     */
    preflight_target(target: string, max_tools: number): string;
    preset(position: number): string;
    preset_count(): number;
    profile(position: number): string;
    profile_config(position: number): string;
    profile_count(): number;
    /**
     * `CatalogSelectionRequest` in, `CatalogSelection` out.
     */
    reconcile(selection: string): string;
}

/**
 * Own in a task worker; `build` consumes it.
 */
export class ProfileCatalogUpload {
    free(): void;
    [Symbol.dispose](): void;
    append(offset: number, bytes: Uint8Array): void;
    /**
     * Build the catalog. Without a collator the core's exact ASCII root
     * collation orders presets and refuses any other text.
     */
    build(collator?: any | null): ProfileCatalog;
    /**
     * `limits`: maximum bytes, nodes, text units, number bytes and depth.
     */
    constructor(bytes: number, limits: Float64Array);
}

export class ProjectArchiveImport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Takes the prepared document once for guarded adoption.
     */
    document(): ProjectDocument;
    /**
     * `FORMAT_CANONICAL` or `FORMAT_FOREIGN` from the generated layout.
     */
    format(): number;
    /**
     * Bounded UTF-16 reads; lone surrogates survive.
     */
    warning(position: number, start: number, count: number): Uint16Array;
    /**
     * The browser's sorted, unique warning texts.
     */
    warning_count(): number;
    warning_length(position: number): number;
}

export class ProjectArchiveOutput {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The checkpoint guard of the written capture, taken once. Acknowledge it
     * only after the host confirms the save handoff.
     */
    guard(): ProjectGuard;
    length(): number;
    /**
     * Copies one bounded chunk into host-owned memory.
     */
    read(start: number, count: number): Uint8Array;
    warning(position: number, start: number, count: number): Uint16Array;
    warning_count(): number;
    warning_length(position: number): number;
}

export class ProjectArchiveUpload {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Offsets make retries and out-of-order delivery explicit; a refused
     * chunk is not consumed.
     */
    append(offset: number, chunk: Uint8Array): void;
    /**
     * `archive_bytes` is the exact length, reserved up front after checking it
     * against the policy; omit it for open-ended input bounded by the policy.
     */
    constructor(version: number, archive_bytes: number | null | undefined, policy: Float64Array);
    /**
     * Consumes the upload on every outcome. Completes import privately: no
     * session state changes until the host adopts the returned document.
     */
    prepare(): ProjectArchiveImport;
}

export class ProjectAsset {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    digest(): string;
    length(): number;
    metadata(max_bytes: number): ProjectBytes;
    read(start: number, count: number): Uint8Array;
}

export class ProjectBytes {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    length(): number;
    read(start: number, count: number): Uint8Array;
}

export class ProjectClipboard {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Counts for allocating new editable IDs. Bytes and the source object stay
     * inside native ownership; free this host handle when replacing the copy.
     */
    info(): Float64Array;
}

/**
 * Explicit preparation owner. Cancellation drops parsed/sealed input and the
 * guard immediately; dropping/freeing the owner does the same. Use a separate
 * task for seal(). Session disposal invalidates admission, not captured input.
 */
export class ProjectCommandUpload {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    append(offset: number, bytes: Uint8Array): void;
    append_asset(offset: number, bytes: Uint8Array): void;
    /**
     * Payload bytes the sealed work holds (each distinct payload once).
     */
    asset_bytes(): number;
    /**
     * Payloads the sealed records declared, in first-declaration order.
     */
    asset_count(): number;
    /**
     * Start one declared payload; returns its exact byte length.
     */
    begin_asset(position: number): number;
    cancel(): void;
    cancel_asset(): void;
    command_count(): number;
    /**
     * Validates the payload; the last one prepares the work's commands.
     */
    finish_asset(): void;
    seal(): void;
    units(): number;
}

/**
 * Admission consumes the contents on every outcome. Free the empty wrapper
 * afterwards; reusing its consumed contents returns invalid_state.
 */
export class ProjectDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ProjectEffects {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    dirty_categories(position: number): string;
    history(position: number, previous: boolean): CapturedHistory;
    kind(position: number): number;
    project(position: number, previous: boolean): CapturedProject;
    reason(position: number, start: number, count: number): Uint16Array;
    reason_length(position: number): number;
    selection(position: number, previous: boolean): CapturedSelection;
}

export class ProjectExport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Live slice preflight of exactly this frozen bundle from a contract
     * `PreflightRequest`. Synchronous; run it on a worker.
     */
    preflight(request: string): ProjectPreflight;
}

export class ProjectGuard {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * The base an import is prepared against: guard, snapshot and asset copies.
 */
export class ProjectImportBase {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Consumes the upload on every outcome. `bed` is empty or `[width, depth]`
     * in millimetres. Production IDs come from a 32-byte random `id_seed`;
     * `id_namespace` selects deterministic `import:<namespace>:<kind>-<n>` IDs.
     */
    prepare_model(upload: ProjectModelUpload, filename: Uint16Array, imported_at: Uint16Array, bed: Float64Array, drop_to_bed: boolean, id_seed: Uint8Array, id_namespace?: string | null): ProjectImportPreview;
}

/**
 * The browser's preview (canonical JSON, bounded reads) and its commit token.
 */
export class ProjectImportPreview {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    blocked(): boolean;
    length(): number;
    read(start: number, count: number): Uint8Array;
}

export class ProjectModelUpload {
    free(): void;
    [Symbol.dispose](): void;
    append(offset: number, chunk: Uint8Array): void;
    /**
     * `model_bytes` is the exact length, or omitted for open-ended input; the
     * generated options are the browser's model import limits.
     */
    constructor(version: number, model_bytes: number | null | undefined, options: Float64Array);
}

export class ProjectOpen {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * One paint overlay's facets: a `PaintOverlaySummary`, then packets of
 * 40-byte facets (nine little-endian float32 corners and a uint32 state).
 */
export class ProjectPaintOverlay {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    packet(start: number, count: number): Uint8Array;
    summary(): string;
}

/**
 * One paint gesture, opened on a session guard. Samples and overlay pages
 * run here, off the session; the session stages its commit.
 */
export class ProjectPaintStroke {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A `PaintStrokeOverlayRequest`; returns a `PaintStrokeOverlay`.
     */
    overlay(request: string): string;
    /**
     * The stroke's live preview as an overlay capture.
     */
    preview(): ProjectPaintOverlay;
    /**
     * A `PaintStrokeSample`; returns a `PaintStrokeSampleReply`.
     */
    sample(request: string): string;
}

/**
 * One live preflight result, read item by item as contract JSON.
 */
export class ProjectPreflight {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    issue(position: number): string;
    omission(position: number): string;
    printable_instance(position: number): string;
    summary(): string;
    used_filament(position: number): string;
}

export class ProjectQueryList {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    node(position: number): ProjectQueryNode;
    page(start: number, count: number): Float64Array;
    snapshot(): CapturedProject;
}

export class ProjectQueryNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    children(relation: number, max_sort_entries: number): ProjectQueryList;
    metadata(): Float64Array;
    snapshot(): CapturedProject;
    text(field: number, start: number, count: number): Uint16Array;
    text_length(field: number): number;
}

export class ProjectReply {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Consume the response to transfer all effects; retain their order even
     * when the reply reports commandFailed after rollback.
     */
    effects(): ProjectEffects;
    wire(): string;
}

export class ProjectSelectionInput {
    free(): void;
    [Symbol.dispose](): void;
    add(kind: number, id: Uint16Array): void;
    constructor();
}

export class ProjectSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Call only after the host confirms successful save handoff. Merely reading
     * or serializing a capture never clears dirty state.
     */
    acknowledge_checkpoint(guard: ProjectGuard): ProjectEffects;
    asset(position: number): ProjectAsset;
    asset_fingerprint(): string;
    begin_open(): ProjectOpen;
    cancel_open(ticket: ProjectOpen): boolean;
    /**
     * A `CapabilityRequest` against the session's current state; returns a
     * `CapabilityPage`.
     */
    capabilities(request: string): string;
    capture_clipboard(guard: ProjectGuard, node: ProjectQueryNode, version: number, options: Float64Array): ProjectClipboard;
    /**
     * Freeze the project and its assets for an export or a live preflight.
     */
    capture_export(guard: ProjectGuard): ProjectExport;
    capture_guard(): ProjectGuard;
    capture_import_base(): ProjectImportBase;
    clipboard_upload(guard: ProjectGuard, clipboard: ProjectClipboard, version: number, bytes: number, options: Float64Array): ProjectCommandUpload;
    command_upload(guard: ProjectGuard, version: number, bytes: number, options: Float64Array): ProjectCommandUpload;
    /**
     * Dispatch the returned effects before reporting success. A refused
     * confirmation changes nothing and keeps the candidate for a retry; any
     * later outcome consumes it.
     */
    commit_import(preview: ProjectImportPreview, acknowledged: string[]): ProjectEffects;
    configure_staging(version: number, options: Float64Array): void;
    dispose(): void;
    /**
     * A `FacetRegionRequest` over the session's acknowledged state; returns a
     * `FacetRegionReply`.
     */
    facet_region(request: string): string;
    finish_open(ticket: ProjectOpen, document: ProjectDocument): ProjectEffects;
    history(): CapturedHistory;
    history_revision(): number;
    is_current(guard: ProjectGuard): boolean;
    is_disposed(): boolean;
    is_export_current(guard: ProjectGuard): boolean;
    is_open_current(ticket: ProjectOpen): boolean;
    /**
     * The canonical paint overlay of one volume's channel: a
     * `PaintOverlayRequest`. The capture owns its facets and packets.
     */
    paint_overlay(request: string): ProjectPaintOverlay;
    /**
     * Open a paint stroke on the state `guard` captured: a `PaintStrokeOpen`.
     * The stroke owns its mesh, so its samples never touch this session.
     */
    paint_stroke(guard: ProjectGuard, request: string): ProjectPaintStroke;
    pending_count(): number;
    release_staged(id: number): boolean;
    /**
     * A `RenderRequest`: a page of the renderer deltas from the snapshot the
     * host shows to the session's acknowledged one; returns a `RenderPage`.
     */
    render(request: string): string;
    reset_document(guard: ProjectGuard, document: ProjectDocument): ProjectEffects;
    run_next(): ProjectReply | undefined;
    select(guard: ProjectGuard, input: ProjectSelectionInput, primary: number): ProjectEffects;
    selection(): CapturedSelection;
    snapshot(): CapturedProject;
    stage_commands(input: ProjectCommandUpload): number;
    /**
     * Stage the stroke's whole gesture as one edit for `executeStaged`; 0
     * when it touched no facet. A stroke whose state changed refuses `stale`.
     */
    stage_paint_stroke(stroke: ProjectPaintStroke, label?: Uint16Array | null): number;
    staging_usage(): Float64Array;
    submit(request: string): ProjectReply | undefined;
    /**
     * Write the current immutable capture as a complete 3MF package. The guard
     * is captured with the same snapshot; writing never changes dirty state.
     */
    write_archive(version: number, policy: Float64Array): ProjectArchiveOutput;
}

export class ProjectUpload {
    free(): void;
    [Symbol.dispose](): void;
    append_asset(offset: number, bytes: Uint8Array): void;
    append_document(offset: number, bytes: Uint8Array): void;
    asset_count(): number;
    begin_asset(position: number): number;
    cancel_asset(): void;
    finish_asset(): void;
    constructor(version: number, document_bytes: number, options: Float64Array);
    /**
     * Takes ownership even on failure. The nonce is fresh host entropy, not
     * domain-ID entropy. No initial state is published until the bundle is full.
     */
    open(generation: Float64Array): ProjectSession;
    /**
     * Consumes the upload and verifies a complete immutable replacement bundle.
     * Preparation belongs to an owned import task; it publishes no live state.
     */
    prepare(): ProjectDocument;
    /**
     * Consumes staged document input, including on admission failure. This
     * synchronous finalization belongs to the host's owned opening task.
     */
    seal_document(): void;
}

/**
 * A settings draft over inherited values and one node's overrides.
 */
export class SettingsEditor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Commit every draft; returns an `EditorCommitResult`.
     */
    commit(): string;
    /**
     * An `EditorFieldRef`; returns its `EditorComparison`.
     */
    compare(field: string): string;
    /**
     * An `EditorEdit`; returns its `EditorEditResult`.
     */
    edit(edit: string): string;
    /**
     * The latest query's field at `position`, as an `EditorField`.
     */
    field(position: number): string;
    /**
     * For an editor opened on a project node: the project `Intent` that
     * applies its latest commit, guarded by the captured snapshot.
     */
    intent(): string;
    /**
     * An `EditorCreate`. Without a collator or folder the exact ASCII
     * policies apply and refuse other text.
     */
    constructor(create: string, collator?: any | null, folder?: any | null);
    /**
     * This node's overrides as canonical JSON.
     */
    overrides(): string;
    /**
     * An `EditorQuery`; returns the number of fields.
     */
    query(query: string): number;
    revision(): number;
    row(position: number): string;
    /**
     * An `EditorRowsRequest`; returns the number of rows.
     */
    rows(rows: string): number;
    /**
     * An `EditorFieldRef`; returns its `EditorFieldState`.
     */
    state(field: string): string;
    /**
     * Fields the latest rows left out because no surface supports them.
     */
    unavailable(): number;
}

/**
 * `coerceOverrideValue`: a `LibraryCoerceRequest` to a `LibraryCoercedValue`.
 */
export function coerce_override_value(request: string): string;

export function core_info(): string;

export function evaluate(request: string): string;

/**
 * `formatOverrideValue`: a `LibraryFormatRequest` to a `LibraryFormattedValue`.
 */
export function format_override_value(request: string): string;

/**
 * The Full Spectrum rules: an `EditorRuleRequest` to `EditorRules`.
 */
export function settings_rules(rules: string): string;

/**
 * `stepSettingValue`: an `EditorStepRequest` to an `EditorStep`.
 */
export function settings_step(step: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_capturedhistory_free: (a: number, b: number) => void;
    readonly __wbg_capturedproject_free: (a: number, b: number) => void;
    readonly __wbg_capturedselection_free: (a: number, b: number) => void;
    readonly __wbg_presetlibrary_free: (a: number, b: number) => void;
    readonly __wbg_profilecatalog_free: (a: number, b: number) => void;
    readonly __wbg_profilecatalogupload_free: (a: number, b: number) => void;
    readonly __wbg_projectarchiveimport_free: (a: number, b: number) => void;
    readonly __wbg_projectarchiveoutput_free: (a: number, b: number) => void;
    readonly __wbg_projectarchiveupload_free: (a: number, b: number) => void;
    readonly __wbg_projectasset_free: (a: number, b: number) => void;
    readonly __wbg_projectbytes_free: (a: number, b: number) => void;
    readonly __wbg_projectclipboard_free: (a: number, b: number) => void;
    readonly __wbg_projectcommandupload_free: (a: number, b: number) => void;
    readonly __wbg_projectdocument_free: (a: number, b: number) => void;
    readonly __wbg_projecteffects_free: (a: number, b: number) => void;
    readonly __wbg_projectexport_free: (a: number, b: number) => void;
    readonly __wbg_projectguard_free: (a: number, b: number) => void;
    readonly __wbg_projectimportbase_free: (a: number, b: number) => void;
    readonly __wbg_projectimportpreview_free: (a: number, b: number) => void;
    readonly __wbg_projectmodelupload_free: (a: number, b: number) => void;
    readonly __wbg_projectopen_free: (a: number, b: number) => void;
    readonly __wbg_projectpaintoverlay_free: (a: number, b: number) => void;
    readonly __wbg_projectpaintstroke_free: (a: number, b: number) => void;
    readonly __wbg_projectpreflight_free: (a: number, b: number) => void;
    readonly __wbg_projectquerylist_free: (a: number, b: number) => void;
    readonly __wbg_projectquerynode_free: (a: number, b: number) => void;
    readonly __wbg_projectreply_free: (a: number, b: number) => void;
    readonly __wbg_projectselectioninput_free: (a: number, b: number) => void;
    readonly __wbg_projectsession_free: (a: number, b: number) => void;
    readonly __wbg_projectupload_free: (a: number, b: number) => void;
    readonly __wbg_settingseditor_free: (a: number, b: number) => void;
    readonly capturedhistory_dirty_categories: (a: number) => [number, number];
    readonly capturedhistory_has_label: (a: number, b: number) => number;
    readonly capturedhistory_label_length: (a: number, b: number) => number;
    readonly capturedhistory_label_text: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly capturedhistory_redo_count: (a: number) => number;
    readonly capturedhistory_undo_count: (a: number) => number;
    readonly capturedproject_export_json: (a: number, b: number) => [number, number, number];
    readonly capturedproject_hash: (a: number) => [number, number];
    readonly capturedproject_id: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_id_length: (a: number) => number;
    readonly capturedproject_paint_palette: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_query: (a: number, b: number) => [number, number, number];
    readonly capturedproject_revision: (a: number) => number;
    readonly capturedproject_settings_editor: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly capturedproject_settings_explain: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_settings_snapshot: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_settings_targets: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedselection_count: (a: number) => number;
    readonly capturedselection_id: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly capturedselection_id_length: (a: number, b: number) => [number, number, number];
    readonly capturedselection_kind: (a: number, b: number) => [number, number, number];
    readonly capturedselection_primary_index: (a: number) => number;
    readonly coerce_override_value: (a: number, b: number) => [number, number, number, number];
    readonly core_info: () => [number, number];
    readonly evaluate: (a: number, b: number) => [number, number];
    readonly format_override_value: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_apply: (a: number, b: number, c: number) => [number, number, number, number];
    readonly presetlibrary_apply_update: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_bases: (a: number, b: number, c: number) => [number, number, number, number];
    readonly presetlibrary_catalog: (a: number) => [number, number, number];
    readonly presetlibrary_create: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly presetlibrary_custom_preset: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_export_bundle: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly presetlibrary_import_bundle: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly presetlibrary_inventory: (a: number) => [number, number, number, number];
    readonly presetlibrary_issue: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_issue_count: (a: number) => number;
    readonly presetlibrary_plan_update: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_state: (a: number, b: number) => [number, number, number, number];
    readonly presetlibrary_view: (a: number) => [number, number, number, number];
    readonly profilecatalog_diagnostic: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_diagnostic_count: (a: number) => number;
    readonly profilecatalog_preflight_target: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly profilecatalog_preset: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_preset_count: (a: number) => number;
    readonly profilecatalog_profile: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_profile_config: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_profile_count: (a: number) => number;
    readonly profilecatalog_reconcile: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalogupload_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly profilecatalogupload_build: (a: number, b: number) => [number, number, number];
    readonly profilecatalogupload_new: (a: number, b: number, c: number) => [number, number, number];
    readonly projectarchiveimport_document: (a: number) => [number, number, number];
    readonly projectarchiveimport_format: (a: number) => number;
    readonly projectarchiveimport_warning: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly projectarchiveimport_warning_count: (a: number) => number;
    readonly projectarchiveimport_warning_length: (a: number, b: number) => [number, number, number];
    readonly projectarchiveoutput_guard: (a: number) => [number, number, number];
    readonly projectarchiveoutput_length: (a: number) => number;
    readonly projectarchiveoutput_read: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectarchiveoutput_warning: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly projectarchiveoutput_warning_count: (a: number) => number;
    readonly projectarchiveoutput_warning_length: (a: number, b: number) => [number, number, number];
    readonly projectarchiveupload_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectarchiveupload_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly projectarchiveupload_prepare: (a: number) => [number, number, number];
    readonly projectasset_digest: (a: number) => [number, number];
    readonly projectasset_length: (a: number) => number;
    readonly projectasset_metadata: (a: number, b: number) => [number, number, number];
    readonly projectasset_read: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectbytes_length: (a: number) => number;
    readonly projectbytes_read: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectclipboard_info: (a: number) => [number, number];
    readonly projectcommandupload_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectcommandupload_append_asset: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectcommandupload_asset_bytes: (a: number) => [number, number, number];
    readonly projectcommandupload_asset_count: (a: number) => [number, number, number];
    readonly projectcommandupload_begin_asset: (a: number, b: number) => [number, number, number];
    readonly projectcommandupload_cancel: (a: number) => void;
    readonly projectcommandupload_cancel_asset: (a: number) => void;
    readonly projectcommandupload_command_count: (a: number) => [number, number, number];
    readonly projectcommandupload_finish_asset: (a: number) => [number, number];
    readonly projectcommandupload_seal: (a: number) => [number, number];
    readonly projectcommandupload_units: (a: number) => [number, number, number];
    readonly projecteffects_count: (a: number) => number;
    readonly projecteffects_dirty_categories: (a: number, b: number) => [number, number, number, number];
    readonly projecteffects_history: (a: number, b: number, c: number) => [number, number, number];
    readonly projecteffects_kind: (a: number, b: number) => [number, number, number];
    readonly projecteffects_project: (a: number, b: number, c: number) => [number, number, number];
    readonly projecteffects_reason: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly projecteffects_reason_length: (a: number, b: number) => [number, number, number];
    readonly projecteffects_selection: (a: number, b: number, c: number) => [number, number, number];
    readonly projectexport_preflight: (a: number, b: number, c: number) => [number, number, number];
    readonly projectimportbase_prepare_model: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly projectimportpreview_blocked: (a: number) => [number, number, number];
    readonly projectimportpreview_length: (a: number) => number;
    readonly projectimportpreview_read: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectmodelupload_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectmodelupload_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly projectpaintoverlay_packet: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintoverlay_summary: (a: number) => [number, number, number, number];
    readonly projectpaintstroke_overlay: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintstroke_preview: (a: number) => [number, number, number];
    readonly projectpaintstroke_sample: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpreflight_issue: (a: number, b: number) => [number, number, number, number];
    readonly projectpreflight_omission: (a: number, b: number) => [number, number, number, number];
    readonly projectpreflight_printable_instance: (a: number, b: number) => [number, number, number, number];
    readonly projectpreflight_summary: (a: number) => [number, number, number, number];
    readonly projectpreflight_used_filament: (a: number, b: number) => [number, number, number, number];
    readonly projectquerylist_count: (a: number) => number;
    readonly projectquerylist_node: (a: number, b: number) => [number, number, number];
    readonly projectquerylist_page: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectquerylist_snapshot: (a: number) => number;
    readonly projectquerynode_children: (a: number, b: number, c: number) => [number, number, number];
    readonly projectquerynode_metadata: (a: number) => [number, number, number, number];
    readonly projectquerynode_snapshot: (a: number) => number;
    readonly projectquerynode_text: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly projectquerynode_text_length: (a: number, b: number) => [number, number, number];
    readonly projectreply_effects: (a: number) => number;
    readonly projectreply_wire: (a: number) => [number, number];
    readonly projectselectioninput_add: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectselectioninput_new: () => number;
    readonly projectsession_acknowledge_checkpoint: (a: number, b: number) => [number, number, number];
    readonly projectsession_asset: (a: number, b: number) => [number, number, number];
    readonly projectsession_asset_fingerprint: (a: number) => [number, number];
    readonly projectsession_begin_open: (a: number) => [number, number, number];
    readonly projectsession_cancel_open: (a: number, b: number) => number;
    readonly projectsession_capabilities: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_capture_clipboard: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly projectsession_capture_export: (a: number, b: number) => [number, number, number];
    readonly projectsession_capture_guard: (a: number) => [number, number, number];
    readonly projectsession_capture_import_base: (a: number) => [number, number, number];
    readonly projectsession_clipboard_upload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly projectsession_command_upload: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly projectsession_commit_import: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_configure_staging: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectsession_dispose: (a: number) => void;
    readonly projectsession_facet_region: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_finish_open: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_history: (a: number) => number;
    readonly projectsession_history_revision: (a: number) => number;
    readonly projectsession_is_current: (a: number, b: number) => number;
    readonly projectsession_is_disposed: (a: number) => number;
    readonly projectsession_is_export_current: (a: number, b: number) => number;
    readonly projectsession_is_open_current: (a: number, b: number) => number;
    readonly projectsession_paint_overlay: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_paint_stroke: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_pending_count: (a: number) => number;
    readonly projectsession_release_staged: (a: number, b: number) => [number, number, number];
    readonly projectsession_render: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_reset_document: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_run_next: (a: number) => number;
    readonly projectsession_select: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_selection: (a: number) => number;
    readonly projectsession_snapshot: (a: number) => number;
    readonly projectsession_stage_commands: (a: number, b: number) => [number, number, number];
    readonly projectsession_stage_paint_stroke: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_staging_usage: (a: number) => [number, number];
    readonly projectsession_submit: (a: number, b: number, c: number) => number;
    readonly projectsession_write_archive: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectupload_append_asset: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectupload_append_document: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectupload_asset_count: (a: number) => [number, number, number];
    readonly projectupload_begin_asset: (a: number, b: number) => [number, number, number];
    readonly projectupload_cancel_asset: (a: number) => [number, number];
    readonly projectupload_finish_asset: (a: number) => [number, number];
    readonly projectupload_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectupload_open: (a: number, b: number, c: number) => [number, number, number];
    readonly projectupload_prepare: (a: number) => [number, number, number];
    readonly projectupload_seal_document: (a: number) => [number, number];
    readonly settings_rules: (a: number, b: number) => [number, number, number, number];
    readonly settings_step: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_commit: (a: number) => [number, number, number, number];
    readonly settingseditor_compare: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_edit: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_field: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_intent: (a: number) => [number, number, number, number];
    readonly settingseditor_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly settingseditor_overrides: (a: number) => [number, number];
    readonly settingseditor_query: (a: number, b: number, c: number) => [number, number, number];
    readonly settingseditor_revision: (a: number) => number;
    readonly settingseditor_row: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_rows: (a: number, b: number, c: number) => [number, number, number];
    readonly settingseditor_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_unavailable: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
