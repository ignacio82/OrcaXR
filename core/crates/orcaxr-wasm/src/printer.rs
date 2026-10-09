//! Printer workflow policy (`orcaxr_printer`) for browser hosts.
use crate::project::error;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_contracts::project_intents::InvalidIntent;
use orcaxr_printer::{control, status::JobStatus, summary, tools};
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
