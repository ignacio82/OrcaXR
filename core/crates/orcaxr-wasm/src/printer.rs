//! Printer workflow policy (`orcaxr_printer`) for browser hosts.
use crate::project::error;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_contracts::project_intents::InvalidIntent;
use orcaxr_printer::{control, preparation, status::JobStatus, summary, tools, workflow};
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
