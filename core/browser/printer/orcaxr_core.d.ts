/* tslint:disable */
/* eslint-disable */

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

export function core_info(): string;

/**
 * A `TransportFailure`; how it reads, as `PrinterText`.
 */
export function describe_transport_failure(request: string): string;

export function evaluate(request: string): string;

/**
 * A Snapmaker filament query reply as received; the `FilamentSlotsReply`.
 */
export function filament_slots(text: string): string;

/**
 * `/printer/gcode/help` reply text; the command names, or unknown.
 */
export function gcode_commands(text: string): string;

/**
 * A `GuardedPrinterActionsRequest`; the `GuardedPrinterActions` to offer.
 */
export function guarded_printer_actions(request: string): string;

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
 * A metadata reply's text and the `PrinterText` filename asked about; the
 * `PrintFileIdentityReply`.
 */
export function print_file_identity(text: string, filename: string): string;

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
 * `/printer/objects/list` reply text; the objects, or unknown.
 */
export function printer_objects(text: string): string;

/**
 * A `PrinterStatusRequest`; the `PrinterStatusSummary` compact surfaces show.
 */
export function printer_status_summary(request: string): string;

/**
 * A `PrinterText` filename; the sanitized upload name.
 */
export function sanitize_gcode_filename(request: string): string;

/**
 * `/server/info` reply text; the components, or unknown.
 */
export function server_components(text: string): string;

/**
 * A `ToolMappingRequest`; the `ToolMappingReport`.
 */
export function tool_mapping(request: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_holdtoconfirm_free: (a: number, b: number) => void;
    readonly __wbg_moonrakertransport_free: (a: number, b: number) => void;
    readonly __wbg_printersession_free: (a: number, b: number) => void;
    readonly __wbg_printjobstatus_free: (a: number, b: number) => void;
    readonly __wbg_printworkflow_free: (a: number, b: number) => void;
    readonly __wbg_toolusagescanner_free: (a: number, b: number) => void;
    readonly core_info: () => [number, number];
    readonly describe_transport_failure: (a: number, b: number) => [number, number, number, number];
    readonly evaluate: (a: number, b: number) => [number, number];
    readonly filament_slots: (a: number, b: number) => [number, number, number, number];
    readonly gcode_commands: (a: number, b: number) => [number, number, number, number];
    readonly guarded_printer_actions: (a: number, b: number) => [number, number, number, number];
    readonly holdtoconfirm_cancel: (a: number) => [number, number, number, number];
    readonly holdtoconfirm_new: () => number;
    readonly holdtoconfirm_poll: (a: number, b: number) => [number, number, number, number];
    readonly holdtoconfirm_press: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly holdtoconfirm_release: (a: number, b: number) => [number, number, number, number];
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
    readonly print_file_identity: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly print_job_availability: (a: number, b: number) => [number, number, number, number];
    readonly print_job_command_failure: (a: number, b: number) => [number, number, number, number];
    readonly print_job_command_plan: (a: number, b: number) => [number, number, number, number];
    readonly print_preparation_plan: (a: number, b: number) => [number, number, number, number];
    readonly print_preparation_send: (a: number, b: number) => [number, number, number, number];
    readonly print_readiness: (a: number, b: number) => [number, number, number, number];
    readonly print_readiness_failure: (a: number, b: number) => [number, number, number, number];
    readonly print_start_options: (a: number, b: number) => [number, number, number, number];
    readonly printer_objects: (a: number, b: number) => [number, number, number, number];
    readonly printer_status_summary: (a: number, b: number) => [number, number, number, number];
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
    readonly sanitize_gcode_filename: (a: number, b: number) => [number, number, number, number];
    readonly server_components: (a: number, b: number) => [number, number, number, number];
    readonly tool_mapping: (a: number, b: number) => [number, number, number, number];
    readonly toolusagescanner_append: (a: number, b: number, c: number) => [number, number];
    readonly toolusagescanner_finish: (a: number) => [number, number, number, number];
    readonly toolusagescanner_new: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
