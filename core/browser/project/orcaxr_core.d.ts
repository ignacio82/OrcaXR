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
    /**
     * A selection's assignable scopes, unsupported refs and offered
     * filaments (`filamentAssignmentExchange`): `{"refs"}` in,
     * `{"options","scopes","unsupportedSelection"}` or `{"error"}` out.
     */
    filament_assignment(request: string): string;
    /**
     * The assignments a filament choice makes (`filamentAssignmentChangesExchange`):
     * `{"entities","filamentId"}` in, `{"assignments"}` or `{"error"}` out.
     */
    filament_assignment_changes(request: string): string;
    /**
     * The filament slots this project's physical filaments describe
     * (`projectFilamentSlotsExchange`): `{"palette"}` in,
     * `{"heads","nozzles","palette"}` out.
     */
    filament_slots(request: string): string;
    hash(): string;
    id(start: number, count: number): Uint16Array;
    id_length(): number;
    /**
     * One object's height ranges as the semantic editor shows them
     * (`layerRangeEditorExchange`): `{"objectId","selectedLayerRangeId"}` in,
     * `{"projection"}` out.
     */
    layer_range_editor(request: string): string;
    /**
     * An `ObjectTreeRequest`; returns an `ObjectTreeReply`: one page of the
     * Objects tree's visible rows, or the selection activating a row commits.
     * The folder folds non-ASCII search text as the settings search does.
     */
    object_tree(request: string, folder?: any | null): string;
    /**
     * A `PaintPaletteRequest`; returns the project's `PaintPalette`.
     */
    paint_palette(request: string): string;
    /**
     * The print configuration plate `plate_id` (a JSON string) overrides, as
     * the canonical JSON object of engine wire strings a slice submission's
     * `overrides` field carries; an unknown plate overrides nothing.
     */
    plate_print_overrides(plate_id: string): string;
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
    /**
     * The plates a slice of `scope` (`current-plate` or `all-plates`)
     * slices: `{"plateIds"}` in slicing order, or the browser's `{"refusal"}`
     * (`orcaxr_project::slicing::plate::slice_plan`).
     */
    slice_plan(scope: string): string;
    /**
     * The profile snapshot the plate (`plateId` as JSON text) is sliced
     * with, or the browser's `{"error"}`
     * (`orcaxr_project::slicing::sidecar::profiles`).
     */
    slice_profiles(plate_id: string): string;
    /**
     * What a split would split (`splitSourceExchange`):
     * `{"instanceId","target","triangleLimit"}` in, `{"source"}` or
     * `{"refusal"}` out (`orcaxr_project::split::source`).
     */
    split_source(request: string): string;
    /**
     * The virtual filament library this project shows
     * (`virtualFilamentLibraryExchange`): `{}` in,
     * `{"matchCandidates","mixedRows","physicalChoices","status"}` or `{"error"}` out.
     */
    virtual_filament_library(request: string): string;
    /**
     * The step one library edit submits (`virtualFilamentMutationExchange`):
     * `{"operation",...}` in, `{"batchJson","label","operation","step",...}`
     * or `{"error"}` out.
     */
    virtual_filament_mutation(request: string): string;
    /**
     * The bed the workspace reads from this project and plate `plateId`'s
     * tower keep-out: `{"plateId": string | null}` in, the workspace bed
     * document (`orcaxr_project::placement::bed`) out.
     */
    workspace_bed(request: string): string;
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
 * The hold-to-confirm gesture; each call takes the host's clock.
 */
export class HoldToConfirm {
    free(): void;
    [Symbol.dispose](): void;
    cancel(): string;
    constructor();
    poll(now_ms: number): string;
    /**
     * A `GuardedPrinterAction`; the `HoldToConfirmState`.
     */
    press(action: string, now_ms: number): string;
    /**
     * The `HoldToConfirmRelease`: the command to run, if the hold was long enough.
     */
    release(now_ms: number): string;
}

/**
 * The Moonraker transport (`MoonrakerTransport`): one printer's connection
 * and every request on it. Stepping calls answer a `MoonrakerTransportStep`.
 */
export class MoonrakerTransport {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The live signal of task `task` aborts.
     */
    abort(task: number, now_ms: number): string;
    clear_credentials(now_ms: number): void;
    /**
     * No object subscription.
     */
    clear_subscription(now_ms: number): string;
    /**
     * A `MoonrakerTransportConfig`; the `MoonrakerTransportReply` creating a
     * transport from it answers: its first state, or why it is refused.
     */
    static configure(config: string): string;
    /**
     * A signal by name: `none`, `live` or `aborted`.
     */
    connect(signal: string, now_ms: number): string;
    /**
     * A reason by name: `user`, `cancelled` or `disposed`.
     */
    disconnect(reason: string, now_ms: number): string;
    dispose(now_ms: number): string;
    /**
     * A `MoonrakerRequest` read as bytes.
     */
    download(request: string, now_ms: number): string;
    has_api_key(): boolean;
    has_bearer_token(): boolean;
    /**
     * Past this many UTF-16 units, text decides outcomes by its length
     * alone: pass at most one unit more.
     */
    static max_text_units(): number;
    /**
     * A `MoonrakerTransportConfig` that `configure` accepts.
     */
    constructor(config: string);
    /**
     * A `MoonrakerRecoveryRequest`.
     */
    recovery(request: string, now_ms: number): string;
    /**
     * A `MoonrakerRequest`.
     */
    request(request: string, now_ms: number): string;
    /**
     * A `MoonrakerTransportOutcome` answering effect `id`.
     */
    resolve(id: number, outcome: string, now_ms: number): string;
    /**
     * A body read as text, answering effect `id`.
     */
    resolve_text(id: number, text: string, now_ms: number): string;
    /**
     * `MoonrakerCredentials`; an `OptionalMoonrakerTransportFault`.
     */
    set_credentials(credentials: string, now_ms: number): string;
    /**
     * A `MoonrakerObjectSubscription`; the `MoonrakerTransportStepReply`.
     */
    set_subscription(entries: string, now_ms: number): string;
    socket_close(socket: number, now_ms: number): string;
    socket_error(socket: number, now_ms: number): string;
    /**
     * A text frame socket `socket` received.
     */
    socket_message(socket: number, text: string, now_ms: number): string;
    socket_open(socket: number, now_ms: number): string;
    /**
     * The `MoonrakerConnectionState`.
     */
    state(): string;
    /**
     * The JSON text of notification `id`'s params, once.
     */
    take_params(id: number): string;
    /**
     * The JSON text of finished task `task`'s result, once.
     */
    take_result(task: number): string;
    /**
     * Timer `timer` fired.
     */
    timer(timer: number, now_ms: number): string;
    /**
     * A `MoonrakerRequest` whose body is the host's file.
     */
    upload(request: string, now_ms: number): string;
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
 * The print job status model: fed `/printer/objects/query` results and
 * `notify_status_update` params as received, it answers `PrintJobSnapshot`s.
 */
export class PrintJobStatus {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `undefined` when the patch concerns no object the model reads.
     */
    apply_notification(text: string, now_ms: number): string | undefined;
    apply_query(text: string, now_ms: number): string;
    constructor();
    reset(): string;
    snapshot(): string;
}

/**
 * The print submission workflow (`PrintWorkflowController`): a send or a
 * stored reprint, one `PrintWorkflowStep` per call. Each step names the
 * effects the host carries out and answers by id.
 */
export class PrintWorkflow {
    free(): void;
    [Symbol.dispose](): void;
    busy(): boolean;
    cancel(): string;
    dispose(): string;
    constructor();
    /**
     * A `PrintWorkflowOutcome` answering effect `id`.
     */
    resolve(id: number, outcome: string): string;
    /**
     * The reply a request or upload received: Moonraker's `result`, as JSON.
     */
    resolve_reply(id: number, text: string): string;
    /**
     * A `PrintWorkflowIntent`: send a sliced artifact.
     */
    run(intent: string): string;
    /**
     * A `PrinterText` naming a stored file to start.
     */
    start_stored(path: string): string;
}

/**
 * The printer session (`PrinterSessionController`): one selected printer
 * and every query, subscription and command in it. Stepping calls answer a
 * `PrinterSessionStep`; queries answer their own replies.
 */
export class PrinterSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A command's wire name; the `PrintJobIntentReply`.
     */
    capture_intent(command: string): string;
    /**
     * The `PrinterSessionLeaseReply`.
     */
    capture_lease(): string;
    clear(): string;
    /**
     * An intent id; the `PrintJobConfirmReply`.
     */
    confirm(intent: number): string;
    connect(): string;
    dispose(): string;
    /**
     * A `PrintJobExecuteRequest`.
     */
    execute(request: string): string;
    /**
     * A `PrinterSessionLease`; whether it is still current.
     */
    lease_current(lease: string): boolean;
    constructor();
    /**
     * A notification's method and params (JSON) as transport `transport`
     * received them at `now_ms`.
     */
    notification(transport: number, method: string, params: string, now_ms: number): string;
    refresh(): string;
    /**
     * A `PrinterSessionOutcome` answering effect `id`.
     */
    resolve(id: number, outcome: string): string;
    /**
     * A request's reply (Moonraker's `result`, as JSON) received at `now_ms`.
     */
    resolve_reply(id: number, text: string, now_ms: number): string;
    /**
     * A `PrinterSelection`.
     */
    select(selection: string): string;
    /**
     * A `ConnectionSignal` from transport `transport`.
     */
    transport_state(transport: number, signal: string): string;
    /**
     * The `PrinterSessionView`: generation, snapshot and availability.
     */
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
    /**
     * The pickers' choices (`slicingChoicesExchange`): canonical JSON
     * `{"machinePresetId"?, "processPresetId"?}` in, `{"machines",
     * "processes","filaments"}` of `{"id","label","name"}` out.
     */
    slicing_choices(request: string): string;
    /**
     * A live choice's slicing configuration against a state document,
     * admitted under the host's `Date.parse` (`slicingConfigurationExchange`).
     */
    slicing_configuration(request: string): string;
    /**
     * The catalog's default triple selected (`defaultProfileSelectionExchange`).
     */
    slicing_default(request: string): string;
    /**
     * A selection by preset ID from a live choice (`profileSelectionExchange`):
     * `{"live","request"}` in, `{"feedback","live"?}` out.
     */
    slicing_select(request: string): string;
    /**
     * A selection by typed names (`profileSelectionByNamesExchange`).
     */
    slicing_select_by_names(request: string): string;
    /**
     * One edit of a live choice's filament slots (`filamentSlotsExchange`):
     * `{"edit","live"}` in, `{"live"}`, `{"unchanged":true}` or
     * `{"error":"slot-limit","message"}` out.
     */
    slicing_slots(request: string): string;
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
     * The checkpoint guard of the written capture, taken once; an export
     * capture's archive has none. Acknowledge it only after the host confirms
     * the save handoff.
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

/**
 * One emboss cut, prepared from a recipe and the host's glyph outlines.
 */
export class ProjectEmboss {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes `start..start + count` of the cut's indexed-mesh payload.
     */
    mesh(start: number, count: number): Uint8Array;
    /**
     * The `EmbossReply`: the cut's summary, or the refusal.
     */
    reply(): string;
}

export class ProjectExport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The one-plate slice capture of `plate_id` (a JSON string): this
     * capture's project reduced to that plate as plate zero with only the
     * assets it keeps, admitted under the host's `Date.parse`, for
     * `write_archive` to package as the archive an external slicer loads.
     * Refused with `plate_projection_*` codes.
     */
    plate(plate_id: string): ProjectExport;
    /**
     * Live slice preflight of exactly this frozen bundle from a contract
     * `PreflightRequest`. Synchronous; run it on a worker.
     */
    preflight(request: string): ProjectPreflight;
    /**
     * The captured project: for a plate's capture, the projected one, whose
     * hash is its archive's `sourceHash`.
     */
    project(): CapturedProject;
    /**
     * The pictures this capture's project asks for (its `thumbnails`),
     * drawn from its active plate — a plate capture's only one — by the
     * shared core (`orcaxr_archive::thumbnail`), each as the G-code block
     * that carries it: `{"problems","thumbnails":[{"block","coverage",
     * "format","height","width"}]}`. Synchronous; run it on a worker.
     */
    thumbnails(): string;
    /**
     * Write this frozen capture — a plate's, for an external slicer — as a
     * complete 3MF package. It carries no checkpoint guard: an export is
     * never a save.
     */
    write_archive(version: number, policy: Float64Array): ProjectArchiveOutput;
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
     * Consumes the upload on every outcome. `bed` is empty or the printable
     * area `[x_min, y_min, x_max, y_max]` in printer millimetres. Production IDs come from a 32-byte random `id_seed`;
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

/**
 * One volume's features, captured for measuring.
 */
export class ProjectMeasureVolume {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A `MeasureFeatureRequest`; returns a `MeasureFeatureReply`.
     */
    feature(request: string): string;
    /**
     * The `MeasureVolumeReply`: plane and facet counts, or the refusal.
     */
    reply(): string;
}

/**
 * One mesh asset's renderer packet.
 */
export class ProjectMeshPacket {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes `start..start + count` of the packet: the chunk table, then the
     * chunks.
     */
    bytes(start: number, count: number): Uint8Array;
    /**
     * The `MeshPacketReply`: the packet's shape, or the refusal.
     */
    reply(): string;
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
 * One volume's paint facets: a canonical JSON summary, then packets of
 * 12-byte runs (uint32 first facet, count, state) and 44-byte leaves (nine
 * float32 corners, uint32 source facet and state), little-endian.
 */
export class ProjectPaintFacets {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    leaves(start: number, count: number): Uint8Array;
    runs(start: number, count: number): Uint8Array;
    summary(): string;
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
     * The stroke's live preview as paint facets.
     */
    preview_facets(): ProjectPaintFacets;
    /**
     * A `PaintStrokeSample`; returns a `PaintStrokeSampleReply`.
     */
    sample(request: string): string;
    /**
     * One sample made with the painter's settings: `{"hit","settings"}` in,
     * `{"reply","sample"}` or the painter's `{"error","message"}` out.
     */
    sample_with(request: string): string;
}

/**
 * One plate captured for picking; build it again when the project changes.
 */
export class ProjectPickScene {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A `PickRay` in printer space; returns a `PickReply`.
     */
    pick(ray: string): string;
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
    /**
     * The corners of one object's first layer an ear would hold down: a
     * `BrimEarDetectRequest`; returns a `BrimEarDetectReply`.
     */
    detect_brim_ears(request: string): string;
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
     * One volume's features captured for measuring: a
     * `MeasureVolumeRequest`. Its `reply` gives the counts or the refusal,
     * and `feature` resolves picks off this session.
     */
    measure_volume(request: string): ProjectMeasureVolume;
    /**
     * The renderer packet for one of the session's mesh assets: a
     * `MeshPacketRequest`. Its `reply` gives the packet's shape or the
     * refusal, and `bytes` pages the chunk table and chunks.
     */
    mesh_packet(request: string): ProjectMeshPacket;
    /**
     * The paint facets of one volume's channel: a `PaintOverlayRequest`.
     * The capture owns its runs, leaves and colours.
     */
    paint_facets(request: string): ProjectPaintFacets;
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
    /**
     * One plate's volumes captured for picking: a `PickSceneRequest`. The
     * scene owns its meshes, so picks run off the session.
     */
    pick_scene(request: string): ProjectPickScene;
    /**
     * One plate's arrangement: an `ArrangeRequest`; returns an `ArrangeReply`.
     */
    plan_arrangement(request: string): string;
    /**
     * Copies of one instance in a plate's free space: a `BedFillRequest`;
     * returns a `BedFillReply`.
     */
    plan_bed_fill(request: string): string;
    /**
     * A helper volume for the object a selection names:
     * `{"ids","primary","role","sizeMm"}` → `{"assetJson","idsUsed",
     * "objectId","volumeJson"}` or `{"refusal"}`.
     */
    plan_helper_volume(request: string): string;
    /**
     * The transforms one placement edit submits: a `PlacementRequest`;
     * returns a `PlacementReply`.
     */
    plan_placement(request: string): string;
    /**
     * A primitive as a new object of the acknowledged state
     * (`orcaxr_project::primitives`): `{"bedMm","ids","importedAt","kind",
     * "plateId","sizeMm"}` → `{"assetJson","idsUsed","objectJson","plateId",
     * "reusedAsset"}` or `{"refusal"}`.
     */
    plan_primitive_object(request: string): string;
    /**
     * The plate's wipe tower, auto-placed: a `WipeTowerRequest`; returns a
     * `WipeTowerReply`.
     */
    plan_wipe_tower(request: string): string;
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
     * Stage a prepared emboss cut (an `EmbossStage`) for `executeStaged`: a
     * new text part under the host's IDs, or a re-cut of a text part.
     */
    stage_emboss(emboss: ProjectEmboss, request: string): number;
    /**
     * Stage the stroke's whole gesture as one edit for `executeStaged`; 0
     * when it touched no facet. A stroke whose state changed refuses `stale`.
     */
    stage_paint_stroke(stroke: ProjectPaintStroke, label?: Uint16Array | null): number;
    /**
     * Stage the slicing configuration a live catalog choice describes
     * (`{"autoPairs","live"}`) as one "Update slicing configuration"
     * replacement for `executeStaged`; `words` are the random words new pair
     * identities draw. Answers `{"staged": id}`, `{"unchanged": true}` or
     * `{"error","message"}`; a disposed session or one without staging room
     * throws its code.
     */
    stage_slicing_configuration(catalog: ProfileCatalog, request: string, words: Float64Array): string;
    /**
     * Stage a prepared SVG cut (an `SvgPartStage`) for `executeStaged`: a
     * new part under the host's IDs, or a re-cut of an SVG part.
     */
    stage_svg_part(svg: ProjectSvgPart, request: string): number;
    /**
     * Stage a prepared decimation under the host's asset ID (a
     * `VolumeSimplifyStage`) for `executeStaged`. A run whose state changed
     * refuses `stale`.
     */
    stage_volume_simplify(simplify: ProjectVolumeSimplify, request: string): number;
    /**
     * Stage a prepared split under the host's names (a `VolumeSplitStage`)
     * for `executeStaged`. A split whose state changed refuses `stale`.
     */
    stage_volume_split(split: ProjectVolumeSplit, request: string): number;
    staging_usage(): Float64Array;
    /**
     * One object's placed ears that reach nothing: a
     * `BrimEarStrandedRequest`; returns a `BrimEarStrandedReply`.
     */
    stranded_brim_ears(request: string): string;
    submit(request: string): ProjectReply | undefined;
    /**
     * Decimate one volume's mesh on the state `guard` captured: a
     * `VolumeSimplifyRequest`. Its `reply` gives the summary, unchanged or
     * the refusal, and `mesh` pages the result's bytes.
     */
    volume_simplify(guard: ProjectGuard, request: string): ProjectVolumeSimplify;
    /**
     * Prepare one volume's split on the state `guard` captured: a
     * `VolumeSplitRequest`. Its `reply` gives the parts or the refusal.
     */
    volume_split(guard: ProjectGuard, request: string): ProjectVolumeSplit;
    /**
     * Write the current immutable capture as a complete 3MF package. The guard
     * is captured with the same snapshot; writing never changes dirty state.
     */
    write_archive(version: number, policy: Float64Array): ProjectArchiveOutput;
}

/**
 * One SVG cut, prepared from a drawing's file bytes and a recipe.
 */
export class ProjectSvgPart {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes `start..start + count` of the cut's indexed-mesh payload.
     */
    mesh(start: number, count: number): Uint8Array;
    /**
     * The `SvgPartReply`: the cut's summary, or the refusal.
     */
    reply(): string;
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
 * One volume's decimation, prepared on a session guard.
 */
export class ProjectVolumeSimplify {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes `start..start + count` of the result's indexed-mesh payload.
     */
    mesh(start: number, count: number): Uint8Array;
    /**
     * The `VolumeSimplifyReply`: the summary, unchanged, or the refusal.
     */
    reply(): string;
}

/**
 * One volume's split, prepared on a session guard.
 */
export class ProjectVolumeSplit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The `VolumeSplitReply`: the parts and geometries, or the refusal.
     */
    reply(): string;
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
     * Apply: the drafts' one commit, which becomes [`Self::intent`].
     */
    panel_apply(): string;
    /**
     * Cancel: every draft dropped.
     */
    panel_cancel(): void;
    /**
     * A draft set, inherited or reset to the default; returns its outcome.
     */
    panel_edit(request: string): string;
    /**
     * One field's row for `{"fieldId"}`, or the editor's refusal.
     */
    panel_row(request: string): string;
    /**
     * Whether Apply has something valid to apply.
     */
    panel_state(): string;
    /**
     * The generated settings panel (`settingsPanelExchange.ts`): what it
     * shows for `{"mode","search"}`.
     */
    panel_view(request: string): string;
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
 * Which tools an artifact selects and the filament it declares, from its
 * bytes in order; `finish` answers the `GcodeToolUsage` and ends the scan.
 */
export class ToolUsageScanner {
    free(): void;
    [Symbol.dispose](): void;
    append(bytes: Uint8Array): void;
    finish(): string;
    constructor();
}

/**
 * A context menu's sections or the model toolbar's runs (`actionGroupsExchange`):
 * `{"actions":[id],"layout"}` in, `{"groups":[{"actions","group","label"}]}` out.
 */
export function action_groups(request: string): string;

/**
 * The instance transform one pinned alignment produces: an
 * `AssemblyAlignmentRequest`; returns an `AssemblyAlignmentReply`.
 */
export function assembly_alignment(request: string): string;

/**
 * Which pinned assembly alignments two picked features allow: an
 * `AssemblyPair`; returns an `AssemblyAvailabilityReply`.
 */
export function assembly_availability(request: string): string;

/**
 * View-only exploded offsets: an `ExplosionRequest`; returns an
 * `ExplosionReply`.
 */
export function assembly_explosion(request: string): string;

/**
 * A `CameraDescribeRequest`; the `PrinterText` describing the service.
 */
export function camera_describe(request: string): string;

/**
 * A `CameraFrameRequest`; the `OptionalPrinterReplyText` frame URL.
 */
export function camera_frame_url(request: string): string;

/**
 * A `CameraListFinish`; the `CameraListResult` a listing that ended without
 * a reply to read reads as.
 */
export function camera_list_finish(request: string): string;

/**
 * The `PrinterSend` that lists a printer's cameras.
 */
export function camera_list_plan(): string;

/**
 * A `CameraListRequest` and its `/server/webcams/list` reply (Moonraker's
 * `result`, as JSON); the `CameraListResult`.
 */
export function camera_list_read(request: string, reply: string): string;

/**
 * A `CameraMechanismsRequest`; the `CameraMechanisms` worth trying, in order.
 */
export function camera_mechanisms(request: string): string;

/**
 * A `PrinterCamera`; the milliseconds between its frames.
 */
export function camera_poll_interval(camera: string): number;

/**
 * A `CameraSnapshotFinish`; the `CameraFailure` a failed fetch reads as.
 */
export function camera_snapshot_failure(request: string): string;

/**
 * A `CameraSnapshotRequest`; the `CameraSnapshotPlan`: how one frame is fetched.
 */
export function camera_snapshot_plan(request: string): string;

/**
 * `coerceOverrideValue`: a `LibraryCoerceRequest` to a `LibraryCoercedValue`.
 */
export function coerce_override_value(request: string): string;

/**
 * The command palette's search (`commandPaletteExchange`):
 * `{"actions":[{"hint"?,"id","label"}],"query"}` in, `{"matches":[index]}` out.
 */
export function command_palette(request: string): string;

/**
 * A `GcodeAssessRequest`; the `GcodeAssessment`: what sending the script at
 * this machine, right now, would do.
 */
export function console_assess(request: string): string;

/**
 * A `ConsoleFinish`; the `ConsoleResult` an exchange that ended without a
 * reply to read reads as.
 */
export function console_finish(request: string): string;

/**
 * A `MacroInvocationRequest`; the `MacroInvocation`: the script, or why it
 * cannot be spelled.
 */
export function console_invocation(request: string): string;

/**
 * A `ConsoleLineRequest`; the `ConsoleLine` the transcript keeps.
 */
export function console_line(request: string): string;

/**
 * A `ConsoleNotificationRequest` and the notification's params (as JSON);
 * the `OptionalConsoleLine` it adds.
 */
export function console_notification(request: string, params: string): string;

/**
 * A `ConsoleOperation`; the `ConsolePlan`: the request it sends, or why it
 * is refused before anything leaves.
 */
export function console_plan(operation: string): string;

/**
 * A `ConsoleOperation` and its reply (Moonraker's `result`, as JSON); the
 * `ConsoleResult`.
 */
export function console_read(operation: string, reply: string): string;

/**
 * A `ConsoleRecentRequest`; the `TextList` of recent commands.
 */
export function console_recent(request: string): string;

export function core_info(): string;

/**
 * The stored credentials text (none: nothing stored); the
 * `RememberedCredentials` it reads as.
 */
export function credentials_load(stored?: string | null): string;

/**
 * A `RememberedCredentials`; the text to store, or none to remove what is
 * stored.
 */
export function credentials_save(record: string): string | undefined;

/**
 * A `TransportFailure`; how it reads, as `PrinterText`.
 */
export function describe_transport_failure(request: string): string;

export function evaluate(request: string): string;

/**
 * An `ExternalSlicerArtifactRead` (the facts its host streamed); the
 * `ExternalSlicerArtifact`: accepted, with the job to release, or refused.
 */
export function external_slicer_artifact(read: string): string;

/**
 * An `ExternalSlicerReply` to the attestation; the `ExternalSlicerAttestation`
 * it reads as against the pinned build.
 */
export function external_slicer_attestation(reply: string): string;

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerAttestationPlan`:
 * the engine attestation it sends, or how it reads when none can be sent.
 */
export function external_slicer_attestation_plan(request: string): string;

/**
 * An `ExternalSlicerCancelRead`; the `ExternalSlicerCancelStep`.
 */
export function external_slicer_cancel(read: string): string;

/**
 * An `ExternalSlicerDownloadRead` (the attempt, and its transport's
 * failure or its artifact's verdict); the `ExternalSlicerDownloadStep`:
 * accept, fetch the retained result again, or fail.
 */
export function external_slicer_download(read: string): string;

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerEndpoint`: the
 * canonical endpoint a captured address names, or why none can be made.
 */
export function external_slicer_endpoint(request: string): string;

/**
 * An `ExternalSlicerJobRequest`; the `ExternalSlicerPlan` one step of a job sends.
 */
export function external_slicer_job_plan(request: string): string;

/**
 * An `ExternalSlicerPollRead`; the `ExternalSlicerPollStep`.
 */
export function external_slicer_poll(read: string): string;

/**
 * The external route's metadata (`sliceRouteExchange`):
 * `{"endpoint","engine":{"artifactHash","commit"}}` in,
 * `{"engine","id","kind","protocolVersion"}` or `{"error"}` out.
 */
export function external_slicer_route(request: string): string;

/**
 * An `ExternalSlicerSubmitRead`; the `ExternalSlicerSubmission`: a job to
 * poll or cancel, an artifact to read, or a failure.
 */
export function external_slicer_submission(read: string): string;

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerPlan` submitting a
 * project sends (the archive and overrides are the host's multipart fields).
 */
export function external_slicer_submit_plan(request: string): string;

/**
 * Whether the attested engine (`wasm` or `cli`) carries `feature`.
 */
export function external_slicer_supports(engine: string, feature: string): boolean;

/**
 * A Snapmaker filament query reply as received; the `FilamentSlotsReply`.
 */
export function filament_slots(text: string): string;

/**
 * `formatOverrideValue`: a `LibraryFormatRequest` to a `LibraryFormattedValue`.
 */
export function format_override_value(request: string): string;

/**
 * `/printer/gcode/help` reply text; the command names, or unknown.
 */
export function gcode_commands(text: string): string;

/**
 * A `GuardedPrinterActionsRequest`; the `GuardedPrinterActions` to offer.
 */
export function guarded_printer_actions(request: string): string;

/**
 * Typed height-range bounds (`layerRangeBoundsExchange`).
 */
export function layer_range_bounds(request: string): string;

/**
 * What a height-range operation says (`layerRangeMessagesExchange`).
 */
export function layer_range_messages(request: string): string;

/**
 * A typed split height (`layerRangeSplitExchange`).
 */
export function layer_range_split(request: string): string;

/**
 * The workspace's measurement of two features: a `MeasureRequest`; returns
 * a `MeasureReply`.
 */
export function measure_features(request: string): string;

/**
 * A `MoonrakerCredentialCheck`; the `MoonrakerCredentialReply`.
 */
export function moonraker_credentials(request: string): string;

/**
 * A `MoonrakerEndpointRequest`; the `MoonrakerEndpointReply`.
 */
export function moonraker_endpoint(request: string): string;

/**
 * A `MoonrakerErrorResponse`; the `MoonrakerTransportFault` it is reported as.
 */
export function moonraker_error_response(request: string): string;

/**
 * A `MoonrakerHandshakeRequest`; the `MoonrakerHandshakeReply`.
 */
export function moonraker_handshake(request: string): string;

/**
 * A `MoonrakerMethodCheck`; the `MoonrakerCheckReply`.
 */
export function moonraker_method_check(request: string): string;

/**
 * A `MoonrakerPathRequest`; the `MoonrakerPathReply`.
 */
export function moonraker_path(request: string): string;

/**
 * A `MoonrakerReconnectDelayRequest`; the delay in milliseconds.
 */
export function moonraker_reconnect_delay(request: string): number;

/**
 * A `MoonrakerReconnectPolicyInput`; the `MoonrakerReconnectPolicyReply`.
 */
export function moonraker_reconnect_policy(request: string): string;

/**
 * A `MoonrakerObjectSubscription`; the `MoonrakerSubscriptionReply`.
 */
export function moonraker_subscription(request: string): string;

/**
 * The colours a filament library paints states in (`paintFacetColorsExchange`):
 * `{"channel","filaments","states"}` in, `{"colors"}` out.
 */
export function paint_facet_colors(request: string): string;

/**
 * The paint stroke sample a pointer hit makes with the painter's settings
 * (`paintToolSampleExchange`): `{"channel","hit","settings","stateOrder"}`
 * in, `{"sample"}` or `{"error","message"}` out.
 */
export function paint_tool_sample(request: string): string;

/**
 * The print configuration a plate of a state document overrides
 * (`platePrintOverrides`), as a canonical JSON object of engine wire strings.
 */
export function plate_print_overrides(state: string, plate_id: string): string;

/**
 * One plate of a state document projected for an external slicer
 * (`projectPlateArchiveForSlice`), admitted under the host's `Date.parse`:
 * `plate_id` is a JSON string, `omitted` a JSON array of the source asset
 * IDs whose payloads the host does not hold. Answers canonical JSON —
 * `{"assetIds","sourceHash","stateJson"}`, or `{"error","message"}` with the
 * browser's message. A session's project is projected through
 * `ProjectExport.plate` instead.
 */
export function plate_projection(state: string, plate_id: string, omitted: string): string;

/**
 * Cut a recipe with the host's glyph outlines: an `EmbossRequest`.
 */
export function prepare_emboss(request: string): ProjectEmboss;

/**
 * Cut a drawing's file bytes with a recipe: an `SvgPartRequest`.
 */
export function prepare_svg_part(request: string, drawing: Uint8Array): ProjectSvgPart;

/**
 * A primitive's or the helper cube's canonical mesh payload
 * (`orcaxr_project::primitives::payload_json`): `{"kind","sizeMm"}` in, the
 * bytes the browser stores out.
 */
export function primitive_payload(request: string): Uint8Array;

/**
 * A metadata reply's text and the `PrinterText` filename asked about; the
 * `PrintFileIdentityReply`.
 */
export function print_file_identity(text: string, filename: string): string;

/**
 * A duration in seconds; the `OptionalText` an operator reads it as.
 */
export function print_history_duration(seconds: number): string;

/**
 * A filament length in millimetres; the `OptionalText` an operator reads it as.
 */
export function print_history_filament(millimetres: number): string;

/**
 * A `PrintHistoryFinish`; the `PrintHistoryResult` an exchange that ended
 * without a reply to read reads as.
 */
export function print_history_finish(request: string): string;

/**
 * A `PrintHistoryJob` (on the bulk tier); its `PrintHistoryJobView`.
 */
export function print_history_job_view(job: string): string;

/**
 * A `PrintHistoryPageShape`; the `PrintHistoryPageView` a pager shows.
 */
export function print_history_page_view(shape: string): string;

/**
 * A `PrintHistoryOperation`; the `PrintHistoryPlan`: the request it sends,
 * or why it is refused before anything leaves.
 */
export function print_history_plan(operation: string): string;

/**
 * A `PrintHistoryOperation` and its reply (Moonraker's `result`, as JSON);
 * the `PrintHistoryResult`.
 */
export function print_history_read(operation: string, reply: string): string;

/**
 * An `OptionalPrintHistoryTotals`; the `PrinterText` a panel shows.
 */
export function print_history_totals_text(totals: string): string;

/**
 * A `PrintJobAvailabilityRequest`; the `PrintJobCommandDescriptors` the
 * observed state allows.
 */
export function print_job_availability(request: string): string;

/**
 * A `PrintJobCommandFailureRequest`; the `PrintJobCommandRefusal` it reports.
 */
export function print_job_command_failure(request: string): string;

/**
 * A `PrintJobCommandCheckRequest`; the `PrintJobCommandPlan`.
 */
export function print_job_command_plan(request: string): string;

/**
 * A `PrintPreparationPlanRequest`; the `PrintPreparationPlan`.
 */
export function print_preparation_plan(request: string): string;

/**
 * A `PrintPreparationStep`; the `PrinterSend` it posts.
 */
export function print_preparation_send(request: string): string;

/**
 * The readiness query's reply text; the `PrintReadiness`.
 */
export function print_readiness(text: string): string;

/**
 * A `PrintReadinessFailure`; the `PrintReadiness` of a failed query.
 */
export function print_readiness_failure(request: string): string;

/**
 * A `PrinterCapabilityReport`; the `PrintStartOptions` it supports.
 */
export function print_start_options(request: string): string;

/**
 * A `PrinterDirectoryAdd`; the `PrinterDirectoryReply`.
 */
export function printer_directory_add(request: string): string;

/**
 * A `PrinterDirectoryAdopt`; the `PrinterDirectory` with a legacy endpoint adopted.
 */
export function printer_directory_adopt(request: string): string;

/**
 * The stored directory text (none: nothing stored); the `PrinterDirectory`
 * it reads as.
 */
export function printer_directory_load(stored?: string | null): string;

/**
 * A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of removing it.
 */
export function printer_directory_remove(request: string): string;

/**
 * A `PrinterDirectory`; the text it is stored as.
 */
export function printer_directory_save(directory_json: string): string;

/**
 * A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of making it the default.
 */
export function printer_directory_set_default(request: string): string;

/**
 * A `PrinterDirectoryUpdate`; the `PrinterDirectoryReply`.
 */
export function printer_directory_update(request: string): string;

/**
 * `/printer/objects/list` reply text; the objects, or unknown.
 */
export function printer_objects(text: string): string;

/**
 * A `PrinterStatusRequest`; the `PrinterStatusSummary` compact surfaces show.
 */
export function printer_status_summary(request: string): string;

/**
 * A `PrinterStorageFinish`; the `PrinterStorageResult` an exchange that
 * ended without a reply to read reads as.
 */
export function printer_storage_finish(request: string): string;

/**
 * A `PrinterStorageOperation`; the `PrinterStoragePlan`: the request or
 * download it sends, or why it is refused before anything leaves.
 */
export function printer_storage_plan(operation: string): string;

/**
 * A `PrinterStorageOperation` and its listing or metadata reply (Moonraker's
 * `result`, as JSON); the `PrinterStorageResult`.
 */
export function printer_storage_read(operation: string, reply: string): string;

/**
 * A size in bytes; the `OptionalText` an operator reads it as.
 */
export function printer_storage_size(bytes: number): string;

/**
 * A `PrinterText` filename; the sanitized upload name.
 */
export function sanitize_gcode_filename(request: string): string;

/**
 * `/server/info` reply text; the components, or unknown.
 */
export function server_components(text: string): string;

/**
 * The Full Spectrum rules: an `EditorRuleRequest` to `EditorRules`.
 */
export function settings_rules(rules: string): string;

/**
 * `stepSettingValue`: an `EditorStepRequest` to an `EditorStep`.
 */
export function settings_step(step: string): string;

/**
 * The scoped settings panel's words for a target
 * (`settingsTargetTextExchange`): `{"label","overrideCount","path","scope"}`
 * in, `{"heading","summary","text"}` out.
 */
export function settings_target_text(request: string): string;

/**
 * An output binding checked (`sliceBindingExchange`): `{"binding"}` in,
 * `{"valid":true}` or `{"error"}` out.
 */
export function slice_binding(request: string): string;

/**
 * This device's route (`orcaxr_project::slicing::sidecar::Route::android_native`):
 * `{"engine":{"artifactHash","commit"}}` in, the route's metadata or
 * `{"error"}` out.
 */
export function slice_native_route(request: string): string;

/**
 * The plates a slice slices (`slicePlanExchange`): `{"scope","stateJson"}`
 * in, `{"plateIds"}` or `{"refusal"}` out.
 */
export function slice_plan(request: string): string;

/**
 * The profile snapshot a plate is sliced with (`sliceProfilesExchange`):
 * `{"plateId","stateJson"}` in, `{"effectiveConfigHash","references"}` or
 * `{"error"}` out.
 */
export function slice_profiles(request: string): string;

/**
 * The sidecar published beside a plate's G-code:
 * `{"binding","gcodeBytes","profiles","route","summary","warnings"}` in, the
 * `orcaxr.slice-output` document or `{"error"}` out.
 */
export function slice_sidecar(request: string): string;

/**
 * One thumbnail in the engine's wire format (`thumbnailBlockExchange`):
 * `{"image","request"}` in, the block's text as a JSON string out.
 */
export function slice_thumbnail_block(request: string): string;

/**
 * A G-code with its thumbnail blocks (`thumbnailInjectExchange`):
 * `{"blocks","gcode"}` in, the G-code as a JSON string out.
 */
export function slice_thumbnail_inject(request: string): string;

/**
 * What a printer's `thumbnails` value asks for (`thumbnailListExchange`):
 * `{"value"?}` in, `{"problems","requests"}` out.
 */
export function slice_thumbnail_list(request: string): string;

/**
 * The thumbnail camera (`thumbnailViewExchange`): `{"aspect","max","min"}`
 * in, `{"fovDeg","position","target"}` out.
 */
export function slice_thumbnail_view(request: string): string;

/**
 * The one option a typed name means among `options` (`presetMatchExchange`):
 * `{"options","query"}` in, `{"option": option | null}` out.
 */
export function slicing_match(request: string): string;

/**
 * The state a slicing configuration leads to (`nextSlicingStateExchange`):
 * `{"autoPairs","configurationJson","stateJson"}` and the random words new
 * pair identities draw (sixteen each) in; `{"stateJson"}`,
 * `{"unchanged":true}` or `{"error","message"}` out, admitted under the
 * host's `Date.parse`.
 */
export function slicing_next_state(request: string, words: Float64Array): string;

/**
 * A `ToolMappingRequest`; the `ToolMappingReport`.
 */
export function tool_mapping(request: string): string;

/**
 * What an edit of the three fields submits (`transformFieldEditExchange`):
 * `{"origins","primaryInstanceId","texts","tool"}` in, `{"changes"}` or
 * `{"error":"invalid_edit","message"}` out.
 */
export function transform_field_edit(request: string): string;

/**
 * What a tool's three fields show (`transformFieldsExchange`):
 * `{"tool","transform"}` in, `{"texts","values"}` out.
 */
export function transform_fields(request: string): string;

/**
 * The transform gizmo attached to a proxy pose (`orcaxr_project::placement::gizmo`):
 * `{"proxy"}` in, the gizmo's state out.
 */
export function transform_gizmo_attach(request: string): string;

/**
 * What a gizmo drag submits (`transformGizmoChangesExchange`):
 * `{"initialProxy","mode","origins","proxy"}` in, `{"changes"}` or
 * `{"error":"invalid_drag","message"}` out.
 */
export function transform_gizmo_changes(request: string): string;

/**
 * Every gizmo handle's baked geometry and the drag plane's
 * (`transformGizmoGeometryExchange`).
 */
export function transform_gizmo_geometry(): string;

/**
 * What the gizmo shows: `{"camera","mode","root","space","state"}` in,
 * `{"axis","dragging","handles","proxy"}` out.
 */
export function transform_gizmo_present(request: string): string;

/**
 * One pointer event (`transformGizmoExchange`'s steps):
 * `{"camera","event","mode","root","space","state"}` in, the next state out.
 */
export function transform_gizmo_step(request: string): string;

/**
 * three's Euler ↔ quaternion conversion (`transformRotationExchange`):
 * `{"rotation"}` → `{"eulerRadians"}`, or `{"eulerRadians"}` → `{"rotation"}`.
 */
export function transform_rotation(request: string): string;

/**
 * What the dialog shows for its fields (`virtualFilamentFormExchange`):
 * `{"library","form","search"}` in, `{"issues","preview",...}` out.
 */
export function virtual_filament_form(request: string): string;

/**
 * The fields an author dialog opens with (`virtualFilamentFormDefaultsExchange`):
 * `{"library","operation","filamentId"}` in, the form out.
 */
export function virtual_filament_form_defaults(request: string): string;

/**
 * The pinned Match search's candidates (`virtualFilamentMatchSearchExchange`):
 * `{"library","targetColor","minComponentPercent"}` in, `{"candidates"}` out.
 */
export function virtual_filament_match_search(request: string): string;

/**
 * The proportions the triangle picker writes (`virtualFilamentTriangleExchange`):
 * `{"x","y"}` in, `{"weights"}` or `{"error"}` out.
 */
export function virtual_filament_triangle(request: string): string;

/**
 * A project configuration's bed and a plate tower's keep-out
 * (`workspaceBedExchange`): `{"config","wipeTower"}` in,
 * `{"keepOut","printableArea","printableHeightMm","sizeMm"}` out.
 */
export function workspace_bed(request: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_capturedhistory_free: (a: number, b: number) => void;
    readonly __wbg_capturedproject_free: (a: number, b: number) => void;
    readonly __wbg_capturedselection_free: (a: number, b: number) => void;
    readonly __wbg_holdtoconfirm_free: (a: number, b: number) => void;
    readonly __wbg_moonrakertransport_free: (a: number, b: number) => void;
    readonly __wbg_presetlibrary_free: (a: number, b: number) => void;
    readonly __wbg_printersession_free: (a: number, b: number) => void;
    readonly __wbg_printjobstatus_free: (a: number, b: number) => void;
    readonly __wbg_printworkflow_free: (a: number, b: number) => void;
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
    readonly __wbg_projectemboss_free: (a: number, b: number) => void;
    readonly __wbg_projectexport_free: (a: number, b: number) => void;
    readonly __wbg_projectguard_free: (a: number, b: number) => void;
    readonly __wbg_projectimportbase_free: (a: number, b: number) => void;
    readonly __wbg_projectimportpreview_free: (a: number, b: number) => void;
    readonly __wbg_projectmeasurevolume_free: (a: number, b: number) => void;
    readonly __wbg_projectmeshpacket_free: (a: number, b: number) => void;
    readonly __wbg_projectmodelupload_free: (a: number, b: number) => void;
    readonly __wbg_projectopen_free: (a: number, b: number) => void;
    readonly __wbg_projectpaintfacets_free: (a: number, b: number) => void;
    readonly __wbg_projectpaintoverlay_free: (a: number, b: number) => void;
    readonly __wbg_projectpaintstroke_free: (a: number, b: number) => void;
    readonly __wbg_projectpickscene_free: (a: number, b: number) => void;
    readonly __wbg_projectpreflight_free: (a: number, b: number) => void;
    readonly __wbg_projectquerylist_free: (a: number, b: number) => void;
    readonly __wbg_projectquerynode_free: (a: number, b: number) => void;
    readonly __wbg_projectreply_free: (a: number, b: number) => void;
    readonly __wbg_projectselectioninput_free: (a: number, b: number) => void;
    readonly __wbg_projectsession_free: (a: number, b: number) => void;
    readonly __wbg_projectsvgpart_free: (a: number, b: number) => void;
    readonly __wbg_projectupload_free: (a: number, b: number) => void;
    readonly __wbg_projectvolumesimplify_free: (a: number, b: number) => void;
    readonly __wbg_projectvolumesplit_free: (a: number, b: number) => void;
    readonly __wbg_settingseditor_free: (a: number, b: number) => void;
    readonly __wbg_toolusagescanner_free: (a: number, b: number) => void;
    readonly action_groups: (a: number, b: number) => [number, number, number, number];
    readonly assembly_alignment: (a: number, b: number) => [number, number, number, number];
    readonly assembly_availability: (a: number, b: number) => [number, number, number, number];
    readonly assembly_explosion: (a: number, b: number) => [number, number, number, number];
    readonly camera_describe: (a: number, b: number) => [number, number, number, number];
    readonly camera_frame_url: (a: number, b: number) => [number, number, number, number];
    readonly camera_list_finish: (a: number, b: number) => [number, number, number, number];
    readonly camera_list_plan: () => [number, number, number, number];
    readonly camera_list_read: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly camera_mechanisms: (a: number, b: number) => [number, number, number, number];
    readonly camera_poll_interval: (a: number, b: number) => [number, number, number];
    readonly camera_snapshot_failure: (a: number, b: number) => [number, number, number, number];
    readonly camera_snapshot_plan: (a: number, b: number) => [number, number, number, number];
    readonly capturedhistory_dirty_categories: (a: number) => [number, number];
    readonly capturedhistory_has_label: (a: number, b: number) => number;
    readonly capturedhistory_label_length: (a: number, b: number) => number;
    readonly capturedhistory_label_text: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly capturedhistory_redo_count: (a: number) => number;
    readonly capturedhistory_undo_count: (a: number) => number;
    readonly capturedproject_export_json: (a: number, b: number) => [number, number, number];
    readonly capturedproject_filament_assignment: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_filament_assignment_changes: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_filament_slots: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_hash: (a: number) => [number, number];
    readonly capturedproject_id: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_id_length: (a: number) => number;
    readonly capturedproject_layer_range_editor: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_object_tree: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly capturedproject_paint_palette: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_plate_print_overrides: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_query: (a: number, b: number) => [number, number, number];
    readonly capturedproject_revision: (a: number) => number;
    readonly capturedproject_settings_editor: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly capturedproject_settings_explain: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_settings_snapshot: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_settings_targets: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_slice_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_slice_profiles: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_split_source: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_virtual_filament_library: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_virtual_filament_mutation: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedproject_workspace_bed: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capturedselection_count: (a: number) => number;
    readonly capturedselection_id: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly capturedselection_id_length: (a: number, b: number) => [number, number, number];
    readonly capturedselection_kind: (a: number, b: number) => [number, number, number];
    readonly capturedselection_primary_index: (a: number) => number;
    readonly coerce_override_value: (a: number, b: number) => [number, number, number, number];
    readonly command_palette: (a: number, b: number) => [number, number, number, number];
    readonly console_assess: (a: number, b: number) => [number, number, number, number];
    readonly console_finish: (a: number, b: number) => [number, number, number, number];
    readonly console_invocation: (a: number, b: number) => [number, number, number, number];
    readonly console_line: (a: number, b: number) => [number, number, number, number];
    readonly console_notification: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly console_plan: (a: number, b: number) => [number, number, number, number];
    readonly console_read: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly console_recent: (a: number, b: number) => [number, number, number, number];
    readonly core_info: () => [number, number];
    readonly credentials_load: (a: number, b: number) => [number, number, number, number];
    readonly credentials_save: (a: number, b: number) => [number, number, number, number];
    readonly describe_transport_failure: (a: number, b: number) => [number, number, number, number];
    readonly evaluate: (a: number, b: number) => [number, number];
    readonly external_slicer_artifact: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_attestation: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_attestation_plan: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_cancel: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_download: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_endpoint: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_job_plan: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_poll: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_route: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_submission: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_submit_plan: (a: number, b: number) => [number, number, number, number];
    readonly external_slicer_supports: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly filament_slots: (a: number, b: number) => [number, number, number, number];
    readonly format_override_value: (a: number, b: number) => [number, number, number, number];
    readonly gcode_commands: (a: number, b: number) => [number, number, number, number];
    readonly guarded_printer_actions: (a: number, b: number) => [number, number, number, number];
    readonly holdtoconfirm_cancel: (a: number) => [number, number, number, number];
    readonly holdtoconfirm_new: () => number;
    readonly holdtoconfirm_poll: (a: number, b: number) => [number, number, number, number];
    readonly holdtoconfirm_press: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly holdtoconfirm_release: (a: number, b: number) => [number, number, number, number];
    readonly layer_range_bounds: (a: number, b: number) => [number, number, number, number];
    readonly layer_range_messages: (a: number, b: number) => [number, number, number, number];
    readonly layer_range_split: (a: number, b: number) => [number, number, number, number];
    readonly measure_features: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_credentials: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_endpoint: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_error_response: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_handshake: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_method_check: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_path: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_reconnect_delay: (a: number, b: number) => [number, number, number];
    readonly moonraker_reconnect_policy: (a: number, b: number) => [number, number, number, number];
    readonly moonraker_subscription: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_abort: (a: number, b: number, c: number) => [number, number, number, number];
    readonly moonrakertransport_clear_credentials: (a: number, b: number) => void;
    readonly moonrakertransport_clear_subscription: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_configure: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_connect: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_disconnect: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_dispose: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_download: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_has_api_key: (a: number) => number;
    readonly moonrakertransport_has_bearer_token: (a: number) => number;
    readonly moonrakertransport_max_text_units: () => number;
    readonly moonrakertransport_new: (a: number, b: number) => [number, number, number];
    readonly moonrakertransport_recovery: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_request: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_resolve: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly moonrakertransport_resolve_text: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly moonrakertransport_set_credentials: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_set_subscription: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly moonrakertransport_socket_close: (a: number, b: number, c: number) => [number, number, number, number];
    readonly moonrakertransport_socket_error: (a: number, b: number, c: number) => [number, number, number, number];
    readonly moonrakertransport_socket_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly moonrakertransport_socket_open: (a: number, b: number, c: number) => [number, number, number, number];
    readonly moonrakertransport_state: (a: number) => [number, number, number, number];
    readonly moonrakertransport_take_params: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_take_result: (a: number, b: number) => [number, number, number, number];
    readonly moonrakertransport_timer: (a: number, b: number, c: number) => [number, number, number, number];
    readonly moonrakertransport_upload: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly paint_facet_colors: (a: number, b: number) => [number, number, number, number];
    readonly paint_tool_sample: (a: number, b: number) => [number, number, number, number];
    readonly plate_print_overrides: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly plate_projection: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly prepare_emboss: (a: number, b: number) => [number, number, number];
    readonly prepare_svg_part: (a: number, b: number, c: number, d: number) => [number, number, number];
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
    readonly primitive_payload: (a: number, b: number) => [number, number, number, number];
    readonly print_file_identity: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly print_history_duration: (a: number) => [number, number, number, number];
    readonly print_history_filament: (a: number) => [number, number, number, number];
    readonly print_history_finish: (a: number, b: number) => [number, number, number, number];
    readonly print_history_job_view: (a: number, b: number) => [number, number, number, number];
    readonly print_history_page_view: (a: number, b: number) => [number, number, number, number];
    readonly print_history_plan: (a: number, b: number) => [number, number, number, number];
    readonly print_history_read: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly print_history_totals_text: (a: number, b: number) => [number, number, number, number];
    readonly print_job_availability: (a: number, b: number) => [number, number, number, number];
    readonly print_job_command_failure: (a: number, b: number) => [number, number, number, number];
    readonly print_job_command_plan: (a: number, b: number) => [number, number, number, number];
    readonly print_preparation_plan: (a: number, b: number) => [number, number, number, number];
    readonly print_preparation_send: (a: number, b: number) => [number, number, number, number];
    readonly print_readiness: (a: number, b: number) => [number, number, number, number];
    readonly print_readiness_failure: (a: number, b: number) => [number, number, number, number];
    readonly print_start_options: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_add: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_adopt: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_load: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_remove: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_save: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_set_default: (a: number, b: number) => [number, number, number, number];
    readonly printer_directory_update: (a: number, b: number) => [number, number, number, number];
    readonly printer_objects: (a: number, b: number) => [number, number, number, number];
    readonly printer_status_summary: (a: number, b: number) => [number, number, number, number];
    readonly printer_storage_finish: (a: number, b: number) => [number, number, number, number];
    readonly printer_storage_plan: (a: number, b: number) => [number, number, number, number];
    readonly printer_storage_read: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printer_storage_size: (a: number) => [number, number, number, number];
    readonly printersession_capture_intent: (a: number, b: number, c: number) => [number, number, number, number];
    readonly printersession_capture_lease: (a: number) => [number, number, number, number];
    readonly printersession_clear: (a: number) => [number, number, number, number];
    readonly printersession_confirm: (a: number, b: number) => [number, number, number, number];
    readonly printersession_connect: (a: number) => [number, number, number, number];
    readonly printersession_dispose: (a: number) => [number, number, number, number];
    readonly printersession_execute: (a: number, b: number, c: number) => [number, number, number, number];
    readonly printersession_lease_current: (a: number, b: number, c: number) => [number, number, number];
    readonly printersession_new: () => number;
    readonly printersession_notification: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly printersession_refresh: (a: number) => [number, number, number, number];
    readonly printersession_resolve: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printersession_resolve_reply: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly printersession_select: (a: number, b: number, c: number) => [number, number, number, number];
    readonly printersession_transport_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printersession_view: (a: number) => [number, number, number, number];
    readonly printjobstatus_apply_notification: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printjobstatus_apply_query: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printjobstatus_new: () => number;
    readonly printjobstatus_reset: (a: number) => [number, number, number, number];
    readonly printjobstatus_snapshot: (a: number) => [number, number, number, number];
    readonly printworkflow_busy: (a: number) => number;
    readonly printworkflow_cancel: (a: number) => [number, number, number, number];
    readonly printworkflow_dispose: (a: number) => [number, number, number, number];
    readonly printworkflow_new: () => number;
    readonly printworkflow_resolve: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printworkflow_resolve_reply: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly printworkflow_run: (a: number, b: number, c: number) => [number, number, number, number];
    readonly printworkflow_start_stored: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_diagnostic: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_diagnostic_count: (a: number) => number;
    readonly profilecatalog_preflight_target: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly profilecatalog_preset: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_preset_count: (a: number) => number;
    readonly profilecatalog_profile: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_profile_config: (a: number, b: number) => [number, number, number, number];
    readonly profilecatalog_profile_count: (a: number) => number;
    readonly profilecatalog_reconcile: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_choices: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_configuration: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_default: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_select: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_select_by_names: (a: number, b: number, c: number) => [number, number, number, number];
    readonly profilecatalog_slicing_slots: (a: number, b: number, c: number) => [number, number, number, number];
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
    readonly projectemboss_mesh: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectemboss_reply: (a: number) => [number, number, number, number];
    readonly projectexport_plate: (a: number, b: number, c: number) => [number, number, number];
    readonly projectexport_preflight: (a: number, b: number, c: number) => [number, number, number];
    readonly projectexport_project: (a: number) => number;
    readonly projectexport_thumbnails: (a: number) => [number, number, number, number];
    readonly projectexport_write_archive: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectimportbase_prepare_model: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly projectimportpreview_blocked: (a: number) => [number, number, number];
    readonly projectimportpreview_length: (a: number) => number;
    readonly projectimportpreview_read: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectmeasurevolume_feature: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectmeasurevolume_reply: (a: number) => [number, number, number, number];
    readonly projectmeshpacket_bytes: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectmeshpacket_reply: (a: number) => [number, number, number, number];
    readonly projectmodelupload_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly projectmodelupload_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly projectpaintfacets_leaves: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintfacets_runs: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintfacets_summary: (a: number) => [number, number];
    readonly projectpaintoverlay_packet: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintoverlay_summary: (a: number) => [number, number, number, number];
    readonly projectpaintstroke_overlay: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintstroke_preview: (a: number) => [number, number, number];
    readonly projectpaintstroke_preview_facets: (a: number) => [number, number, number];
    readonly projectpaintstroke_sample: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpaintstroke_sample_with: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectpickscene_pick: (a: number, b: number, c: number) => [number, number, number, number];
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
    readonly projectsession_detect_brim_ears: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_dispose: (a: number) => void;
    readonly projectsession_facet_region: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_finish_open: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_history: (a: number) => number;
    readonly projectsession_history_revision: (a: number) => number;
    readonly projectsession_is_current: (a: number, b: number) => number;
    readonly projectsession_is_disposed: (a: number) => number;
    readonly projectsession_is_export_current: (a: number, b: number) => number;
    readonly projectsession_is_open_current: (a: number, b: number) => number;
    readonly projectsession_measure_volume: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_mesh_packet: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_paint_facets: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_paint_overlay: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_paint_stroke: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_pending_count: (a: number) => number;
    readonly projectsession_pick_scene: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_plan_arrangement: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_plan_bed_fill: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_plan_helper_volume: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_plan_placement: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_plan_primitive_object: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_plan_wipe_tower: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_release_staged: (a: number, b: number) => [number, number, number];
    readonly projectsession_render: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_reset_document: (a: number, b: number, c: number) => [number, number, number];
    readonly projectsession_run_next: (a: number) => number;
    readonly projectsession_select: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_selection: (a: number) => number;
    readonly projectsession_snapshot: (a: number) => number;
    readonly projectsession_stage_commands: (a: number, b: number) => [number, number, number];
    readonly projectsession_stage_emboss: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_stage_paint_stroke: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_stage_slicing_configuration: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly projectsession_stage_svg_part: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_stage_volume_simplify: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_stage_volume_split: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_staging_usage: (a: number) => [number, number];
    readonly projectsession_stranded_brim_ears: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsession_submit: (a: number, b: number, c: number) => number;
    readonly projectsession_volume_simplify: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_volume_split: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsession_write_archive: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly projectsvgpart_mesh: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectsvgpart_reply: (a: number) => [number, number, number, number];
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
    readonly projectvolumesimplify_mesh: (a: number, b: number, c: number) => [number, number, number, number];
    readonly projectvolumesimplify_reply: (a: number) => [number, number, number, number];
    readonly projectvolumesplit_reply: (a: number) => [number, number, number, number];
    readonly sanitize_gcode_filename: (a: number, b: number) => [number, number, number, number];
    readonly server_components: (a: number, b: number) => [number, number, number, number];
    readonly settings_rules: (a: number, b: number) => [number, number, number, number];
    readonly settings_step: (a: number, b: number) => [number, number, number, number];
    readonly settings_target_text: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_commit: (a: number) => [number, number, number, number];
    readonly settingseditor_compare: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_edit: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_field: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_intent: (a: number) => [number, number, number, number];
    readonly settingseditor_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly settingseditor_overrides: (a: number) => [number, number];
    readonly settingseditor_panel_apply: (a: number) => [number, number, number, number];
    readonly settingseditor_panel_cancel: (a: number) => void;
    readonly settingseditor_panel_edit: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_panel_row: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_panel_state: (a: number) => [number, number, number, number];
    readonly settingseditor_panel_view: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_query: (a: number, b: number, c: number) => [number, number, number];
    readonly settingseditor_revision: (a: number) => number;
    readonly settingseditor_row: (a: number, b: number) => [number, number, number, number];
    readonly settingseditor_rows: (a: number, b: number, c: number) => [number, number, number];
    readonly settingseditor_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly settingseditor_unavailable: (a: number) => number;
    readonly slice_binding: (a: number, b: number) => [number, number, number, number];
    readonly slice_native_route: (a: number, b: number) => [number, number, number, number];
    readonly slice_plan: (a: number, b: number) => [number, number, number, number];
    readonly slice_profiles: (a: number, b: number) => [number, number, number, number];
    readonly slice_sidecar: (a: number, b: number) => [number, number, number, number];
    readonly slice_thumbnail_block: (a: number, b: number) => [number, number, number, number];
    readonly slice_thumbnail_inject: (a: number, b: number) => [number, number, number, number];
    readonly slice_thumbnail_list: (a: number, b: number) => [number, number, number, number];
    readonly slice_thumbnail_view: (a: number, b: number) => [number, number, number, number];
    readonly slicing_match: (a: number, b: number) => [number, number, number, number];
    readonly slicing_next_state: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly tool_mapping: (a: number, b: number) => [number, number, number, number];
    readonly toolusagescanner_append: (a: number, b: number, c: number) => [number, number];
    readonly toolusagescanner_finish: (a: number) => [number, number, number, number];
    readonly toolusagescanner_new: () => number;
    readonly transform_field_edit: (a: number, b: number) => [number, number, number, number];
    readonly transform_fields: (a: number, b: number) => [number, number, number, number];
    readonly transform_gizmo_attach: (a: number, b: number) => [number, number, number, number];
    readonly transform_gizmo_changes: (a: number, b: number) => [number, number, number, number];
    readonly transform_gizmo_geometry: () => [number, number, number, number];
    readonly transform_gizmo_present: (a: number, b: number) => [number, number, number, number];
    readonly transform_gizmo_step: (a: number, b: number) => [number, number, number, number];
    readonly transform_rotation: (a: number, b: number) => [number, number, number, number];
    readonly virtual_filament_form: (a: number, b: number) => [number, number, number, number];
    readonly virtual_filament_form_defaults: (a: number, b: number) => [number, number, number, number];
    readonly virtual_filament_match_search: (a: number, b: number) => [number, number, number, number];
    readonly virtual_filament_triangle: (a: number, b: number) => [number, number, number, number];
    readonly workspace_bed: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
