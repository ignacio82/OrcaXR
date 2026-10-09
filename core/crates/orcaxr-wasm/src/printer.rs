//! Printer workflow policy (`orcaxr_printer`) for browser hosts.
use crate::error;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_contracts::project_intents::InvalidIntent;
use orcaxr_printer::{
    camera, console, control, directory, history, moonraker, preparation, reply, session,
    status::JobStatus, storage, summary, tools, transport, workflow,
};
use wasm_bindgen::prelude::*;

fn encoded(snapshot: &wire::PrintJobSnapshot) -> Result<String, JsValue> {
    wire::encode_print_job_snapshot(snapshot).map_err(|_| error("output_limit"))
}

/// The print job status model: fed `/printer/objects/query` results and
/// `notify_status_update` params as received, it answers `PrintJobSnapshot`s.
#[wasm_bindgen]
#[derive(Default)]
pub struct PrintJobStatus {
    inner: JobStatus,
}
#[wasm_bindgen]
impl PrintJobStatus {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn apply_query(&mut self, text: &str, now_ms: f64) -> Result<String, JsValue> {
        let next = self
            .inner
            .apply_query(text, now_ms)
            .map_err(|e| error(e.code()))?;
        encoded(next)
    }
    /// `undefined` when the patch concerns no object the model reads.
    pub fn apply_notification(
        &mut self,
        text: &str,
        now_ms: f64,
    ) -> Result<Option<String>, JsValue> {
        match self.inner.apply_notification(text, now_ms) {
            Ok(Some(next)) => encoded(next).map(Some),
            Ok(None) => Ok(None),
            Err(refusal) => Err(error(refusal.code())),
        }
    }
    pub fn reset(&mut self) -> Result<String, JsValue> {
        encoded(self.inner.reset())
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        encoded(self.inner.snapshot())
    }
}

fn exchange<T, R>(
    request: &str,
    decode: fn(&str) -> Result<T, InvalidIntent>,
    answer: impl FnOnce(&T) -> R,
    encode: fn(&R) -> Result<String, InvalidIntent>,
) -> Result<String, JsValue> {
    if request.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    let request = decode(request).map_err(|_| error("invalid_request"))?;
    encode(&answer(&request)).map_err(|_| error("output_limit"))
}
/// A `PrintJobAvailabilityRequest`; the `PrintJobCommandDescriptors` the
/// observed state allows.
#[wasm_bindgen]
pub fn print_job_availability(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_job_availability_request,
        |r| {
            control::availability(match &r.observed {
                wire::OptionalPrintJobSnapshot::Value(s) => Some(s),
                wire::OptionalPrintJobSnapshot::Absent(_) => None,
            })
        },
        wire::encode_print_job_command_descriptors,
    )
}
/// A `PrintJobCommandCheckRequest`; the `PrintJobCommandPlan`.
#[wasm_bindgen]
pub fn print_job_command_plan(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_job_command_check_request,
        control::plan,
        wire::encode_print_job_command_plan,
    )
}
/// A `PrintJobCommandFailureRequest`; the `PrintJobCommandRefusal` it reports.
#[wasm_bindgen]
pub fn print_job_command_failure(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_job_command_failure_request,
        control::failure,
        wire::encode_print_job_command_refusal,
    )
}
/// A `PrinterStatusRequest`; the `PrinterStatusSummary` compact surfaces show.
#[wasm_bindgen]
pub fn printer_status_summary(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_status_request,
        summary::summarize,
        wire::encode_printer_status_summary,
    )
}
/// A `GuardedPrinterActionsRequest`; the `GuardedPrinterActions` to offer.
#[wasm_bindgen]
pub fn guarded_printer_actions(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_guarded_printer_actions_request,
        control::guarded,
        wire::encode_guarded_printer_actions,
    )
}

/// The hold-to-confirm gesture; each call takes the host's clock.
#[wasm_bindgen]
#[derive(Default)]
pub struct HoldToConfirm {
    inner: control::HoldToConfirm,
}
#[wasm_bindgen]
impl HoldToConfirm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    /// A `GuardedPrinterAction`; the `HoldToConfirmState`.
    pub fn press(&mut self, action: &str, now_ms: f64) -> Result<String, JsValue> {
        let action =
            wire::decode_guarded_printer_action(action).map_err(|_| error("invalid_request"))?;
        state(&self.inner.press(&action, now_ms))
    }
    pub fn poll(&self, now_ms: f64) -> Result<String, JsValue> {
        state(&self.inner.poll(now_ms))
    }
    /// The `HoldToConfirmRelease`: the command to run, if the hold was long enough.
    pub fn release(&mut self, now_ms: f64) -> Result<String, JsValue> {
        wire::encode_hold_to_confirm_release(&self.inner.release(now_ms))
            .map_err(|_| error("output_limit"))
    }
    pub fn cancel(&mut self) -> Result<String, JsValue> {
        state(&self.inner.cancel())
    }
}
fn state(state: &wire::HoldToConfirmState) -> Result<String, JsValue> {
    wire::encode_hold_to_confirm_state(state).map_err(|_| error("output_limit"))
}

/// A Snapmaker filament query reply as received; the `FilamentSlotsReply`.
#[wasm_bindgen]
pub fn filament_slots(text: &str) -> Result<String, JsValue> {
    if text.len() > orcaxr_printer::status::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    wire::encode_filament_slots_reply(&tools::filament_slots(text))
        .map_err(|_| error("output_limit"))
}
/// A `ToolMappingRequest`; the `ToolMappingReport`.
#[wasm_bindgen]
pub fn tool_mapping(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_tool_mapping_request,
        tools::mapping,
        wire::encode_tool_mapping_report,
    )
}
/// Which tools an artifact selects and the filament it declares, from its
/// bytes in order; `finish` answers the `GcodeToolUsage` and ends the scan.
#[wasm_bindgen]
#[derive(Default)]
pub struct ToolUsageScanner {
    inner: Option<tools::ToolUsageScanner>,
}
#[wasm_bindgen]
impl ToolUsageScanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Some(tools::ToolUsageScanner::new()),
        }
    }
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("finished"))?
            .append(bytes);
        Ok(())
    }
    pub fn finish(&mut self) -> Result<String, JsValue> {
        let usage = self.inner.take().ok_or_else(|| error("finished"))?.finish();
        wire::encode_gcode_tool_usage(&usage).map_err(|_| error("output_limit"))
    }
}

fn reply_text(text: &str) -> Result<&str, JsValue> {
    if text.len() > orcaxr_printer::status::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    Ok(text)
}
/// `/printer/objects/list` reply text; the objects, or unknown.
#[wasm_bindgen]
pub fn printer_objects(text: &str) -> Result<String, JsValue> {
    wire::encode_optional_text_list(&preparation::printer_objects(reply_text(text)?))
        .map_err(|_| error("output_limit"))
}
/// `/server/info` reply text; the components, or unknown.
#[wasm_bindgen]
pub fn server_components(text: &str) -> Result<String, JsValue> {
    wire::encode_optional_text_list(&preparation::server_components(reply_text(text)?))
        .map_err(|_| error("output_limit"))
}
/// `/printer/gcode/help` reply text; the command names, or unknown.
#[wasm_bindgen]
pub fn gcode_commands(text: &str) -> Result<String, JsValue> {
    wire::encode_optional_text_list(&preparation::gcode_commands(reply_text(text)?))
        .map_err(|_| error("output_limit"))
}
/// A `PrinterCapabilityReport`; the `PrintStartOptions` it supports.
#[wasm_bindgen]
pub fn print_start_options(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_capability_report,
        preparation::start_options,
        wire::encode_print_start_options,
    )
}
/// A `PrintPreparationPlanRequest`; the `PrintPreparationPlan`.
#[wasm_bindgen]
pub fn print_preparation_plan(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_preparation_plan_request,
        preparation::preparation_plan,
        wire::encode_print_preparation_plan,
    )
}
/// A `PrintPreparationStep`; the `PrinterSend` it posts.
#[wasm_bindgen]
pub fn print_preparation_send(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_preparation_step,
        preparation::preparation_send,
        wire::encode_printer_send,
    )
}
/// The readiness query's reply text; the `PrintReadiness`.
#[wasm_bindgen]
pub fn print_readiness(text: &str) -> Result<String, JsValue> {
    wire::encode_print_readiness(&preparation::readiness(reply_text(text)?))
        .map_err(|_| error("output_limit"))
}
/// A `PrintReadinessFailure`; the `PrintReadiness` of a failed query.
#[wasm_bindgen]
pub fn print_readiness_failure(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_readiness_failure,
        preparation::readiness_unavailable,
        wire::encode_print_readiness,
    )
}
/// A `PrinterText` filename; the sanitized upload name.
#[wasm_bindgen]
pub fn sanitize_gcode_filename(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_text,
        |r| wire::PrinterText {
            text: preparation::sanitize_filename(&r.text),
        },
        wire::encode_printer_text,
    )
}
/// A `TransportFailure`; how it reads, as `PrinterText`.
#[wasm_bindgen]
pub fn describe_transport_failure(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_transport_failure,
        |r| wire::PrinterText {
            text: preparation::describe_failure(r),
        },
        wire::encode_printer_text,
    )
}
/// A metadata reply's text and the `PrinterText` filename asked about; the
/// `PrintFileIdentityReply`.
#[wasm_bindgen]
pub fn print_file_identity(text: &str, filename: &str) -> Result<String, JsValue> {
    let text = reply_text(text)?;
    exchange(
        filename,
        wire::decode_printer_text,
        |f| preparation::file_identity(text, &f.text),
        wire::encode_print_file_identity_reply,
    )
}

/// The print submission workflow (`PrintWorkflowController`): a send or a
/// stored reprint, one `PrintWorkflowStep` per call. Each step names the
/// effects the host carries out and answers by id.
#[wasm_bindgen]
#[derive(Default)]
pub struct PrintWorkflow {
    inner: workflow::PrintWorkflow,
}
fn workflow_step(
    step: Result<wire::PrintWorkflowStep, workflow::Refusal>,
) -> Result<String, JsValue> {
    let step = step.map_err(|refusal| error(refusal.code()))?;
    wire::encode_print_workflow_step(&step).map_err(|_| error("output_limit"))
}
fn effect_id(id: f64) -> Result<u64, JsValue> {
    if id.is_finite() && id.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&id) {
        Ok(id as u64)
    } else {
        Err(error("invalid_request"))
    }
}
#[wasm_bindgen]
impl PrintWorkflow {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn busy(&self) -> bool {
        self.inner.busy()
    }
    /// A `PrintWorkflowIntent`: send a sliced artifact.
    pub fn run(&mut self, intent: &str) -> Result<String, JsValue> {
        if intent.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let intent =
            wire::decode_print_workflow_intent(intent).map_err(|_| error("invalid_request"))?;
        workflow_step(self.inner.run(intent))
    }
    /// A `PrinterText` naming a stored file to start.
    pub fn start_stored(&mut self, path: &str) -> Result<String, JsValue> {
        if path.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let path = wire::decode_printer_text(path).map_err(|_| error("invalid_request"))?;
        workflow_step(self.inner.start_stored(&path.text))
    }
    /// A `PrintWorkflowOutcome` answering effect `id`.
    pub fn resolve(&mut self, id: f64, outcome: &str) -> Result<String, JsValue> {
        if outcome.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let outcome =
            wire::decode_print_workflow_outcome(outcome).map_err(|_| error("invalid_request"))?;
        workflow_step(self.inner.resolve(effect_id(id)?, outcome))
    }
    /// The reply a request or upload received: Moonraker's `result`, as JSON.
    pub fn resolve_reply(&mut self, id: f64, text: &str) -> Result<String, JsValue> {
        let id = effect_id(id)?;
        workflow_step(self.inner.resolve_reply(id, reply_text(text)?))
    }
    pub fn cancel(&mut self) -> Result<String, JsValue> {
        workflow_step(Ok(self.inner.cancel()))
    }
    pub fn dispose(&mut self) -> Result<String, JsValue> {
        workflow_step(Ok(self.inner.dispose()))
    }
}

/// The printer session (`PrinterSessionController`): one selected printer
/// and every query, subscription and command in it. Stepping calls answer a
/// `PrinterSessionStep`; queries answer their own replies.
#[wasm_bindgen]
#[derive(Default)]
pub struct PrinterSession {
    inner: session::PrinterSession,
}
fn session_step(
    step: Result<wire::PrinterSessionStep, session::Refusal>,
) -> Result<String, JsValue> {
    let step = step.map_err(|refusal| error(refusal.code()))?;
    wire::encode_printer_session_step(&step).map_err(|_| error("output_limit"))
}
fn wire_text(text: &str) -> Result<&str, JsValue> {
    if text.len() > wire::MAX_BYTES {
        Err(error("input_limit"))
    } else {
        Ok(text)
    }
}
#[wasm_bindgen]
impl PrinterSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    /// A `PrinterSelection`.
    pub fn select(&mut self, selection: &str) -> Result<String, JsValue> {
        let selection = wire::decode_printer_selection(wire_text(selection)?)
            .map_err(|_| error("invalid_request"))?;
        session_step(self.inner.select(selection))
    }
    pub fn clear(&mut self) -> Result<String, JsValue> {
        session_step(Ok(self.inner.clear()))
    }
    pub fn dispose(&mut self) -> Result<String, JsValue> {
        session_step(Ok(self.inner.dispose()))
    }
    pub fn connect(&mut self) -> Result<String, JsValue> {
        session_step(Ok(self.inner.connect()))
    }
    pub fn refresh(&mut self) -> Result<String, JsValue> {
        session_step(Ok(self.inner.refresh()))
    }
    /// A `PrintJobExecuteRequest`.
    pub fn execute(&mut self, request: &str) -> Result<String, JsValue> {
        let request = wire::decode_print_job_execute_request(wire_text(request)?)
            .map_err(|_| error("invalid_request"))?;
        session_step(Ok(self.inner.execute(request)))
    }
    /// A `ConnectionSignal` from transport `transport`.
    pub fn transport_state(&mut self, transport: f64, signal: &str) -> Result<String, JsValue> {
        let transport = effect_id(transport)?;
        let signal = wire::decode_connection_signal(wire_text(signal)?)
            .map_err(|_| error("invalid_request"))?;
        session_step(Ok(self.inner.transport_state(transport, signal)))
    }
    /// A notification's method and params (JSON) as transport `transport`
    /// received them at `now_ms`.
    pub fn notification(
        &mut self,
        transport: f64,
        method: &str,
        params: &str,
        now_ms: f64,
    ) -> Result<String, JsValue> {
        let transport = effect_id(transport)?;
        session_step(self.inner.notification(
            transport,
            reply_text(method)?,
            reply_text(params)?,
            now_ms,
        ))
    }
    /// A `PrinterSessionOutcome` answering effect `id`.
    pub fn resolve(&mut self, id: f64, outcome: &str) -> Result<String, JsValue> {
        let outcome = wire::decode_printer_session_outcome(wire_text(outcome)?)
            .map_err(|_| error("invalid_request"))?;
        session_step(self.inner.resolve(effect_id(id)?, outcome))
    }
    /// A request's reply (Moonraker's `result`, as JSON) received at `now_ms`.
    pub fn resolve_reply(&mut self, id: f64, text: &str, now_ms: f64) -> Result<String, JsValue> {
        let id = effect_id(id)?;
        session_step(self.inner.resolve_reply(id, reply_text(text)?, now_ms))
    }
    /// The `PrinterSessionView`: generation, snapshot and availability.
    pub fn view(&self) -> Result<String, JsValue> {
        wire::encode_printer_session_view(&self.inner.view()).map_err(|_| error("output_limit"))
    }
    /// A command's wire name; the `PrintJobIntentReply`.
    pub fn capture_intent(&mut self, command: &str) -> Result<String, JsValue> {
        let command = session::command_named(command).ok_or_else(|| error("invalid_request"))?;
        wire::encode_print_job_intent_reply(&self.inner.capture_intent(command))
            .map_err(|_| error("output_limit"))
    }
    /// An intent id; the `PrintJobConfirmReply`.
    pub fn confirm(&mut self, intent: f64) -> Result<String, JsValue> {
        let intent = effect_id(intent)?;
        wire::encode_print_job_confirm_reply(&self.inner.confirm(intent))
            .map_err(|_| error("output_limit"))
    }
    /// The `PrinterSessionLeaseReply`.
    pub fn capture_lease(&self) -> Result<String, JsValue> {
        wire::encode_printer_session_lease_reply(&self.inner.capture_lease())
            .map_err(|_| error("output_limit"))
    }
    /// A `PrinterSessionLease`; whether it is still current.
    pub fn lease_current(&self, lease: &str) -> Result<bool, JsValue> {
        let lease = wire::decode_printer_session_lease(wire_text(lease)?)
            .map_err(|_| error("invalid_request"))?;
        Ok(self.inner.lease_current(&lease))
    }
}

/// The Moonraker transport (`MoonrakerTransport`): one printer's connection
/// and every request on it. Stepping calls answer a `MoonrakerTransportStep`.
#[wasm_bindgen]
pub struct MoonrakerTransport {
    inner: transport::MoonrakerTransport,
}
fn transport_step(
    step: Result<wire::MoonrakerTransportStep, transport::Refusal>,
) -> Result<String, JsValue> {
    let step = step.map_err(|refusal| error(refusal.code()))?;
    wire::encode_moonraker_transport_step(&step).map_err(|_| error("output_limit"))
}
/// Text a printer sent: at most `max_text_units() + 1` UTF-16 units, which
/// is all that decides any outcome.
fn received_text(text: &str) -> Result<&str, JsValue> {
    if text.len() > 3 * (transport::MAX_TEXT_UNITS + 1) {
        Err(error("input_limit"))
    } else {
        Ok(text)
    }
}
#[wasm_bindgen]
impl MoonrakerTransport {
    /// A `MoonrakerTransportConfig`; the `MoonrakerTransportReply` creating a
    /// transport from it answers: its first state, or why it is refused.
    pub fn configure(config: &str) -> Result<String, JsValue> {
        let config = wire::decode_moonraker_transport_config(wire_text(config)?)
            .map_err(|_| error("invalid_request"))?;
        let reply = match transport::MoonrakerTransport::new(&config) {
            Ok((_, state)) => wire::MoonrakerTransportReply::State(state),
            Err(fault) => wire::MoonrakerTransportReply::Refused(fault),
        };
        wire::encode_moonraker_transport_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// A `MoonrakerTransportConfig` that `configure` accepts.
    #[wasm_bindgen(constructor)]
    pub fn new(config: &str) -> Result<MoonrakerTransport, JsValue> {
        let config = wire::decode_moonraker_transport_config(wire_text(config)?)
            .map_err(|_| error("invalid_request"))?;
        let (inner, _) =
            transport::MoonrakerTransport::new(&config).map_err(|_| error("invalid_request"))?;
        Ok(Self { inner })
    }
    /// Past this many UTF-16 units, text decides outcomes by its length
    /// alone: pass at most one unit more.
    pub fn max_text_units() -> f64 {
        transport::MAX_TEXT_UNITS as f64
    }
    /// The JSON text of finished task `task`'s result, once.
    pub fn take_result(&mut self, task: f64) -> Result<String, JsValue> {
        let task = effect_id(task)?;
        self.inner
            .take_result(task)
            .ok_or_else(|| error("not_pending"))
    }
    /// The JSON text of notification `id`'s params, once.
    pub fn take_params(&mut self, id: f64) -> Result<String, JsValue> {
        let id = effect_id(id)?;
        self.inner
            .take_params(id)
            .ok_or_else(|| error("not_pending"))
    }
    /// The `MoonrakerConnectionState`.
    pub fn state(&self) -> Result<String, JsValue> {
        wire::encode_moonraker_connection_state(&self.inner.state())
            .map_err(|_| error("output_limit"))
    }
    pub fn has_api_key(&self) -> bool {
        self.inner.credential_metadata().0
    }
    pub fn has_bearer_token(&self) -> bool {
        self.inner.credential_metadata().1
    }
    /// `MoonrakerCredentials`; an `OptionalMoonrakerTransportFault`.
    pub fn set_credentials(&mut self, credentials: &str, now_ms: f64) -> Result<String, JsValue> {
        let credentials = wire::decode_moonraker_credentials(wire_text(credentials)?)
            .map_err(|_| error("invalid_request"))?;
        let refused = match self.inner.set_credentials(&credentials, now_ms) {
            Ok(()) => wire::OptionalMoonrakerTransportFault::Absent(wire::Empty {}),
            Err(fault) => wire::OptionalMoonrakerTransportFault::Value(fault),
        };
        wire::encode_optional_moonraker_transport_fault(&refused).map_err(|_| error("output_limit"))
    }
    pub fn clear_credentials(&mut self, now_ms: f64) {
        self.inner.clear_credentials(now_ms);
    }
    /// A `MoonrakerObjectSubscription`; the `MoonrakerTransportStepReply`.
    pub fn set_subscription(&mut self, entries: &str, now_ms: f64) -> Result<String, JsValue> {
        let entries = wire::decode_moonraker_object_subscription(wire_text(entries)?)
            .map_err(|_| error("invalid_request"))?;
        let reply = match self.inner.set_subscription(Some(&entries), now_ms) {
            Ok(step) => wire::MoonrakerTransportStepReply::Step(step),
            Err(fault) => wire::MoonrakerTransportStepReply::Refused(fault),
        };
        wire::encode_moonraker_transport_step_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// No object subscription.
    pub fn clear_subscription(&mut self, now_ms: f64) -> Result<String, JsValue> {
        let step = self
            .inner
            .set_subscription(None, now_ms)
            .map_err(|_| error("invalid_request"))?;
        transport_step(Ok(step))
    }
    /// A signal by name: `none`, `live` or `aborted`.
    pub fn connect(&mut self, signal: &str, now_ms: f64) -> Result<String, JsValue> {
        let signal = transport::signal_named(signal).ok_or_else(|| error("invalid_request"))?;
        transport_step(Ok(self.inner.connect(signal, now_ms)))
    }
    /// A reason by name: `user`, `cancelled` or `disposed`.
    pub fn disconnect(&mut self, reason: &str, now_ms: f64) -> Result<String, JsValue> {
        let reason = transport::reason_named(reason).ok_or_else(|| error("invalid_request"))?;
        transport_step(Ok(self.inner.disconnect(reason, now_ms)))
    }
    pub fn dispose(&mut self, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.dispose(now_ms)))
    }
    /// A `MoonrakerRequest`.
    pub fn request(&mut self, request: &str, now_ms: f64) -> Result<String, JsValue> {
        let request = wire::decode_moonraker_request(wire_text(request)?)
            .map_err(|_| error("invalid_request"))?;
        transport_step(Ok(self.inner.request(&request, now_ms)))
    }
    /// A `MoonrakerRequest` whose body is the host's file.
    pub fn upload(&mut self, request: &str, now_ms: f64) -> Result<String, JsValue> {
        let request = wire::decode_moonraker_request(wire_text(request)?)
            .map_err(|_| error("invalid_request"))?;
        transport_step(Ok(self.inner.upload(&request, now_ms)))
    }
    /// A `MoonrakerRequest` read as bytes.
    pub fn download(&mut self, request: &str, now_ms: f64) -> Result<String, JsValue> {
        let request = wire::decode_moonraker_request(wire_text(request)?)
            .map_err(|_| error("invalid_request"))?;
        transport_step(Ok(self.inner.download(&request, now_ms)))
    }
    /// A `MoonrakerRecoveryRequest`.
    pub fn recovery(&mut self, request: &str, now_ms: f64) -> Result<String, JsValue> {
        let request = wire::decode_moonraker_recovery_request(wire_text(request)?)
            .map_err(|_| error("invalid_request"))?;
        transport_step(Ok(self.inner.recovery(&request, now_ms)))
    }
    /// The live signal of task `task` aborts.
    pub fn abort(&mut self, task: f64, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.abort(effect_id(task)?, now_ms)))
    }
    /// A `MoonrakerTransportOutcome` answering effect `id`.
    pub fn resolve(&mut self, id: f64, outcome: &str, now_ms: f64) -> Result<String, JsValue> {
        let outcome = wire::decode_moonraker_transport_outcome(wire_text(outcome)?)
            .map_err(|_| error("invalid_request"))?;
        transport_step(self.inner.resolve(effect_id(id)?, outcome, now_ms))
    }
    /// A body read as text, answering effect `id`.
    pub fn resolve_text(&mut self, id: f64, text: &str, now_ms: f64) -> Result<String, JsValue> {
        let id = effect_id(id)?;
        transport_step(self.inner.resolve_text(id, received_text(text)?, now_ms))
    }
    pub fn socket_open(&mut self, socket: f64, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.socket_open(effect_id(socket)?, now_ms)))
    }
    pub fn socket_error(&mut self, socket: f64, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.socket_error(effect_id(socket)?, now_ms)))
    }
    pub fn socket_close(&mut self, socket: f64, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.socket_close(effect_id(socket)?, now_ms)))
    }
    /// A text frame socket `socket` received.
    pub fn socket_message(
        &mut self,
        socket: f64,
        text: &str,
        now_ms: f64,
    ) -> Result<String, JsValue> {
        let socket = effect_id(socket)?;
        transport_step(Ok(self.inner.socket_message(
            socket,
            received_text(text)?,
            now_ms,
        )))
    }
    /// Timer `timer` fired.
    pub fn timer(&mut self, timer: f64, now_ms: f64) -> Result<String, JsValue> {
        transport_step(Ok(self.inner.timer(effect_id(timer)?, now_ms)))
    }
}

/// A `MoonrakerEndpointRequest`; the `MoonrakerEndpointReply`.
#[wasm_bindgen]
pub fn moonraker_endpoint(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_endpoint_request,
        moonraker::normalize_endpoint,
        wire::encode_moonraker_endpoint_reply,
    )
}
/// A `MoonrakerPathRequest`; the `MoonrakerPathReply`.
#[wasm_bindgen]
pub fn moonraker_path(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_path_request,
        moonraker::join_path,
        wire::encode_moonraker_path_reply,
    )
}
/// A `MoonrakerCredentialCheck`; the `MoonrakerCredentialReply`.
#[wasm_bindgen]
pub fn moonraker_credentials(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_credential_check,
        moonraker::credential_check,
        wire::encode_moonraker_credential_reply,
    )
}
/// A `MoonrakerErrorResponse`; the `MoonrakerTransportFault` it is reported as.
#[wasm_bindgen]
pub fn moonraker_error_response(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_error_response,
        moonraker::error_response,
        wire::encode_moonraker_transport_fault,
    )
}
/// A `MoonrakerHandshakeRequest`; the `MoonrakerHandshakeReply`.
#[wasm_bindgen]
pub fn moonraker_handshake(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_handshake_request,
        moonraker::handshake,
        wire::encode_moonraker_handshake_reply,
    )
}
/// A `MoonrakerReconnectPolicyInput`; the `MoonrakerReconnectPolicyReply`.
#[wasm_bindgen]
pub fn moonraker_reconnect_policy(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_reconnect_policy_input,
        moonraker::reconnect_policy,
        wire::encode_moonraker_reconnect_policy_reply,
    )
}
/// A `MoonrakerReconnectDelayRequest`; the delay in milliseconds.
#[wasm_bindgen]
pub fn moonraker_reconnect_delay(request: &str) -> Result<f64, JsValue> {
    if request.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    let request = wire::decode_moonraker_reconnect_delay_request(request)
        .map_err(|_| error("invalid_request"))?;
    Ok(moonraker::reconnect_delay(&request))
}
/// A `MoonrakerObjectSubscription`; the `MoonrakerSubscriptionReply`.
#[wasm_bindgen]
pub fn moonraker_subscription(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_object_subscription,
        |entries| moonraker::subscription_reply(entries),
        wire::encode_moonraker_subscription_reply,
    )
}
/// A `MoonrakerMethodCheck`; the `MoonrakerCheckReply`.
#[wasm_bindgen]
pub fn moonraker_method_check(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_moonraker_method_check,
        moonraker::method_check,
        wire::encode_moonraker_check_reply,
    )
}
/// A `PrinterStorageOperation`; the `PrinterStoragePlan`: the request or
/// download it sends, or why it is refused before anything leaves.
#[wasm_bindgen]
pub fn printer_storage_plan(operation: &str) -> Result<String, JsValue> {
    exchange(
        operation,
        wire::decode_printer_storage_operation,
        storage::plan,
        wire::encode_printer_storage_plan,
    )
}
/// A `PrinterStorageFinish`; the `PrinterStorageResult` an exchange that
/// ended without a reply to read reads as.
#[wasm_bindgen]
pub fn printer_storage_finish(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_storage_finish,
        storage::finish,
        wire::encode_printer_storage_result,
    )
}
/// A `PrinterStorageOperation` and its listing or metadata reply (Moonraker's
/// `result`, as JSON); the `PrinterStorageResult`.
#[wasm_bindgen]
pub fn printer_storage_read(operation: &str, reply: &str) -> Result<String, JsValue> {
    if operation.len() > wire::MAX_BYTES || reply.len() > reply::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    let operation =
        wire::decode_printer_storage_operation(operation).map_err(|_| error("invalid_request"))?;
    wire::encode_printer_storage_result(&storage::read(&operation, reply))
        .map_err(|_| error("output_limit"))
}
/// A size in bytes; the `OptionalText` an operator reads it as.
#[wasm_bindgen]
pub fn printer_storage_size(bytes: f64) -> Result<String, JsValue> {
    wire::encode_optional_text(&storage::size(bytes)).map_err(|_| error("output_limit"))
}
/// A `PrintHistoryOperation`; the `PrintHistoryPlan`: the request it sends,
/// or why it is refused before anything leaves.
#[wasm_bindgen]
pub fn print_history_plan(operation: &str) -> Result<String, JsValue> {
    exchange(
        operation,
        wire::decode_print_history_operation,
        history::plan,
        wire::encode_print_history_plan,
    )
}
/// A `PrintHistoryFinish`; the `PrintHistoryResult` an exchange that ended
/// without a reply to read reads as.
#[wasm_bindgen]
pub fn print_history_finish(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_print_history_finish,
        history::finish,
        wire::encode_print_history_result,
    )
}
/// A `PrintHistoryOperation` and its reply (Moonraker's `result`, as JSON);
/// the `PrintHistoryResult`.
#[wasm_bindgen]
pub fn print_history_read(operation: &str, reply: &str) -> Result<String, JsValue> {
    if operation.len() > wire::MAX_BYTES || reply.len() > reply::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    let operation =
        wire::decode_print_history_operation(operation).map_err(|_| error("invalid_request"))?;
    wire::encode_print_history_result(&history::read(&operation, reply))
        .map_err(|_| error("output_limit"))
}
/// A duration in seconds; the `OptionalText` an operator reads it as.
#[wasm_bindgen]
pub fn print_history_duration(seconds: f64) -> Result<String, JsValue> {
    wire::encode_optional_text(&reply::optional_text(history::duration_text(seconds)))
        .map_err(|_| error("output_limit"))
}
/// A filament length in millimetres; the `OptionalText` an operator reads it as.
#[wasm_bindgen]
pub fn print_history_filament(millimetres: f64) -> Result<String, JsValue> {
    wire::encode_optional_text(&reply::optional_text(history::filament_text(millimetres)))
        .map_err(|_| error("output_limit"))
}
/// A `PrintHistoryJob` (on the bulk tier); its `PrintHistoryJobView`.
#[wasm_bindgen]
pub fn print_history_job_view(job: &str) -> Result<String, JsValue> {
    if job.len() > wire::BULK.bytes {
        return Err(error("input_limit"));
    }
    let job = wire::decode_print_history_job(job).map_err(|_| error("invalid_request"))?;
    wire::encode_print_history_job_view(&history::job_view(&job)).map_err(|_| error("output_limit"))
}
/// An `OptionalPrintHistoryTotals`; the `PrinterText` a panel shows.
#[wasm_bindgen]
pub fn print_history_totals_text(totals: &str) -> Result<String, JsValue> {
    exchange(
        totals,
        wire::decode_optional_print_history_totals,
        |t| wire::PrinterText {
            text: history::totals_text(t).encode_utf16().collect(),
        },
        wire::encode_printer_text,
    )
}
/// A `PrintHistoryPageShape`; the `PrintHistoryPageView` a pager shows.
#[wasm_bindgen]
pub fn print_history_page_view(shape: &str) -> Result<String, JsValue> {
    exchange(
        shape,
        wire::decode_print_history_page_shape,
        history::page_view,
        wire::encode_print_history_page_view,
    )
}
/// A `GcodeAssessRequest`; the `GcodeAssessment`: what sending the script at
/// this machine, right now, would do.
#[wasm_bindgen]
pub fn console_assess(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_gcode_assess_request,
        |r| {
            console::assess(
                &r.script,
                match r.job_state {
                    wire::OptionalPrintJobState::Value(state) => Some(state),
                    wire::OptionalPrintJobState::Absent(_) => None,
                },
            )
        },
        wire::encode_gcode_assessment,
    )
}
/// A `ConsoleOperation`; the `ConsolePlan`: the request it sends, or why it
/// is refused before anything leaves.
#[wasm_bindgen]
pub fn console_plan(operation: &str) -> Result<String, JsValue> {
    exchange(
        operation,
        wire::decode_console_operation,
        console::plan,
        wire::encode_console_plan,
    )
}
/// A `ConsoleFinish`; the `ConsoleResult` an exchange that ended without a
/// reply to read reads as.
#[wasm_bindgen]
pub fn console_finish(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_console_finish,
        console::finish,
        wire::encode_console_result,
    )
}
/// A `ConsoleOperation` and its reply (Moonraker's `result`, as JSON); the
/// `ConsoleResult`.
#[wasm_bindgen]
pub fn console_read(operation: &str, reply: &str) -> Result<String, JsValue> {
    if operation.len() > wire::MAX_BYTES || reply.len() > reply::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    let operation =
        wire::decode_console_operation(operation).map_err(|_| error("invalid_request"))?;
    wire::encode_console_result(&console::read(&operation, reply))
        .map_err(|_| error("output_limit"))
}
/// A `MacroInvocationRequest`; the `MacroInvocation`: the script, or why it
/// cannot be spelled.
#[wasm_bindgen]
pub fn console_invocation(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_macro_invocation_request,
        console::invocation,
        wire::encode_macro_invocation,
    )
}
/// A `ConsoleLineRequest`; the `ConsoleLine` the transcript keeps.
#[wasm_bindgen]
pub fn console_line(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_console_line_request,
        console::line,
        wire::encode_console_line,
    )
}
/// A `ConsoleNotificationRequest` and the notification's params (as JSON);
/// the `OptionalConsoleLine` it adds.
#[wasm_bindgen]
pub fn console_notification(request: &str, params: &str) -> Result<String, JsValue> {
    if request.len() > wire::MAX_BYTES || params.len() > reply::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    let request =
        wire::decode_console_notification_request(request).map_err(|_| error("invalid_request"))?;
    let line = match console::notification(&request, params) {
        Some(line) => wire::OptionalConsoleLine::Value(line),
        None => wire::OptionalConsoleLine::Absent(wire::Empty {}),
    };
    wire::encode_optional_console_line(&line).map_err(|_| error("output_limit"))
}
/// A `ConsoleRecentRequest`; the `TextList` of recent commands.
#[wasm_bindgen]
pub fn console_recent(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_console_recent_request,
        console::recent,
        wire::encode_text_list,
    )
}
/// `exchange` for an input on the intent contract's bulk tier: a request
/// carrying a printer's own text back.
fn bulk_exchange<T, R>(
    request: &str,
    decode: fn(&str) -> Result<T, InvalidIntent>,
    answer: impl FnOnce(&T) -> R,
    encode: fn(&R) -> Result<String, InvalidIntent>,
) -> Result<String, JsValue> {
    if request.len() > wire::BULK.bytes {
        return Err(error("input_limit"));
    }
    let request = decode(request).map_err(|_| error("invalid_request"))?;
    encode(&answer(&request)).map_err(|_| error("output_limit"))
}
/// The `PrinterSend` that lists a printer's cameras.
#[wasm_bindgen]
pub fn camera_list_plan() -> Result<String, JsValue> {
    wire::encode_printer_send(&camera::list_plan()).map_err(|_| error("output_limit"))
}
/// A `CameraListFinish`; the `CameraListResult` a listing that ended without
/// a reply to read reads as.
#[wasm_bindgen]
pub fn camera_list_finish(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_camera_list_finish,
        camera::list_finish,
        wire::encode_camera_list_result,
    )
}
/// A `CameraListRequest` and its `/server/webcams/list` reply (Moonraker's
/// `result`, as JSON); the `CameraListResult`.
#[wasm_bindgen]
pub fn camera_list_read(request: &str, reply: &str) -> Result<String, JsValue> {
    if request.len() > wire::MAX_BYTES || reply.len() > reply::LIMITS.bytes {
        return Err(error("input_limit"));
    }
    let request =
        wire::decode_camera_list_request(request).map_err(|_| error("invalid_request"))?;
    wire::encode_camera_list_result(&camera::list_read(&request, reply))
        .map_err(|_| error("output_limit"))
}
/// A `CameraSnapshotRequest`; the `CameraSnapshotPlan`: how one frame is fetched.
#[wasm_bindgen]
pub fn camera_snapshot_plan(request: &str) -> Result<String, JsValue> {
    bulk_exchange(
        request,
        wire::decode_camera_snapshot_request,
        camera::snapshot_plan,
        wire::encode_camera_snapshot_plan,
    )
}
/// A `CameraSnapshotFinish`; the `CameraFailure` a failed fetch reads as.
#[wasm_bindgen]
pub fn camera_snapshot_failure(request: &str) -> Result<String, JsValue> {
    bulk_exchange(
        request,
        wire::decode_camera_snapshot_finish,
        camera::snapshot_failure,
        wire::encode_camera_failure,
    )
}
/// A `CameraMechanismsRequest`; the `CameraMechanisms` worth trying, in order.
#[wasm_bindgen]
pub fn camera_mechanisms(request: &str) -> Result<String, JsValue> {
    bulk_exchange(
        request,
        wire::decode_camera_mechanisms_request,
        camera::mechanisms_for,
        wire::encode_camera_mechanisms,
    )
}
/// A `CameraDescribeRequest`; the `PrinterText` describing the service.
#[wasm_bindgen]
pub fn camera_describe(request: &str) -> Result<String, JsValue> {
    bulk_exchange(
        request,
        wire::decode_camera_describe_request,
        |r| wire::PrinterText {
            text: camera::describe(r),
        },
        wire::encode_printer_text,
    )
}
/// A `PrinterCamera`; the milliseconds between its frames.
#[wasm_bindgen]
pub fn camera_poll_interval(camera: &str) -> Result<f64, JsValue> {
    if camera.len() > wire::BULK.bytes {
        return Err(error("input_limit"));
    }
    let camera = wire::decode_printer_camera(camera).map_err(|_| error("invalid_request"))?;
    Ok(camera::poll_interval_ms(&camera))
}
/// A `CameraFrameRequest`; the `OptionalPrinterReplyText` frame URL.
#[wasm_bindgen]
pub fn camera_frame_url(request: &str) -> Result<String, JsValue> {
    bulk_exchange(
        request,
        wire::decode_camera_frame_request,
        camera::frame,
        wire::encode_optional_printer_reply_text,
    )
}
/// The stored directory text (none: nothing stored); the `PrinterDirectory`
/// it reads as.
#[wasm_bindgen]
pub fn printer_directory_load(stored: Option<String>) -> Result<String, JsValue> {
    if stored
        .as_ref()
        .is_some_and(|s| s.len() > reply::LIMITS.bytes)
    {
        return Err(error("input_limit"));
    }
    wire::encode_printer_directory(&directory::load(stored.as_deref()))
        .map_err(|_| error("output_limit"))
}
/// A `PrinterDirectory`; the text it is stored as.
#[wasm_bindgen]
pub fn printer_directory_save(directory_json: &str) -> Result<String, JsValue> {
    if directory_json.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    let request =
        wire::decode_printer_directory(directory_json).map_err(|_| error("invalid_request"))?;
    Ok(String::from_utf16_lossy(&directory::save(&request)))
}
/// A `PrinterDirectoryAdd`; the `PrinterDirectoryReply`.
#[wasm_bindgen]
pub fn printer_directory_add(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_directory_add,
        directory::add,
        wire::encode_printer_directory_reply,
    )
}
/// A `PrinterDirectoryUpdate`; the `PrinterDirectoryReply`.
#[wasm_bindgen]
pub fn printer_directory_update(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_directory_update,
        directory::update,
        wire::encode_printer_directory_reply,
    )
}
/// A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of removing it.
#[wasm_bindgen]
pub fn printer_directory_remove(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_directory_select,
        directory::remove,
        wire::encode_printer_directory_reply,
    )
}
/// A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of making it the default.
#[wasm_bindgen]
pub fn printer_directory_set_default(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_directory_select,
        directory::set_default,
        wire::encode_printer_directory_reply,
    )
}
/// A `PrinterDirectoryAdopt`; the `PrinterDirectory` with a legacy endpoint adopted.
#[wasm_bindgen]
pub fn printer_directory_adopt(request: &str) -> Result<String, JsValue> {
    exchange(
        request,
        wire::decode_printer_directory_adopt,
        directory::adopt,
        wire::encode_printer_directory,
    )
}
