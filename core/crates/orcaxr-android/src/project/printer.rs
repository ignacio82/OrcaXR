//! Printer workflow policy (`orcaxr_printer`) for Android hosts: the print job
//! status model, fed the reply and event text the host's transport received.
use super::*;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_contracts::project_intents::InvalidIntent;
use orcaxr_printer::{
    control::{self, HoldToConfirm},
    preparation,
    status::{JobStatus, LIMITS},
    summary, tools,
    workflow::{PrintWorkflow, Refusal},
};

/// Text a printer sent, within the model's bounds.
fn printer_text(env: &mut JNIEnv<'_>, text: &JString<'_>) -> Result<String> {
    let length = env
        .call_method(text, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_request")?;
    if length < 0 || length as usize > LIMITS.bytes {
        return Err("input_limit");
    }
    Ok(env.get_string(text).map_err(|_| "invalid_request")?.into())
}
fn with_status<R>(handle: jlong, call: impl FnOnce(&mut JobStatus) -> Result<R>) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::PrintJobStatus(status)) => call(status),
        _ => Err("invalid_handle_kind"),
    })
}
fn snapshot(env: &mut JNIEnv<'_>, snapshot: &wire::PrintJobSnapshot) -> Result<jstring> {
    let json = wire::encode_print_job_snapshot(snapshot).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_job_status_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::PrintJobStatus(Box::default()))
}
/// A `/printer/objects/query` result; the model's new `PrintJobSnapshot`.
pub(super) fn print_job_status_query(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    text: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let text = printer_text(env, &text)?;
    let json = with_status(handle, |s| {
        let next = s.apply_query(&text, now_ms).map_err(|e| e.code())?;
        wire::encode_print_job_snapshot(next).map_err(|_| "output_limit")
    })?;
    string(env, json)
}
/// `notify_status_update` params; null when the patch concerns no object
/// the model reads.
pub(super) fn print_job_status_notify(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    text: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let text = printer_text(env, &text)?;
    let json = with_status(handle, |s| match s.apply_notification(&text, now_ms) {
        Ok(Some(next)) => wire::encode_print_job_snapshot(next)
            .map(Some)
            .map_err(|_| "output_limit"),
        Ok(None) => Ok(None),
        Err(refusal) => Err(refusal.code()),
    })?;
    match json {
        Some(json) => string(env, json),
        None => Ok(std::ptr::null_mut()),
    }
}
pub(super) fn print_job_status_reset(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let next = with_status(handle, |s| Ok(s.reset().clone()))?;
    snapshot(env, &next)
}
pub(super) fn print_job_status_snapshot(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let current = with_status(handle, |s| Ok(s.snapshot().clone()))?;
    snapshot(env, &current)
}

fn exchange<T, R>(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
    decode: fn(&str) -> std::result::Result<T, InvalidIntent>,
    answer: impl FnOnce(&T) -> R,
    encode: fn(&R) -> std::result::Result<String, InvalidIntent>,
) -> Result<jstring> {
    let request = decode(&intent_text(env, &request)?).map_err(|_| "invalid_request")?;
    let json = encode(&answer(&request)).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_job_availability(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
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
pub(super) fn print_job_command_plan(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_job_command_check_request,
        control::plan,
        wire::encode_print_job_command_plan,
    )
}
pub(super) fn print_job_command_failure(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_job_command_failure_request,
        control::failure,
        wire::encode_print_job_command_refusal,
    )
}
pub(super) fn printer_status_summary(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_printer_status_request,
        summary::summarize,
        wire::encode_printer_status_summary,
    )
}
pub(super) fn guarded_printer_actions(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_guarded_printer_actions_request,
        control::guarded,
        wire::encode_guarded_printer_actions,
    )
}
fn with_hold<R>(handle: jlong, call: impl FnOnce(&mut HoldToConfirm) -> Result<R>) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::HoldToConfirm(hold)) => call(hold),
        _ => Err("invalid_handle_kind"),
    })
}
fn hold_state(env: &mut JNIEnv<'_>, state: &wire::HoldToConfirmState) -> Result<jstring> {
    let json = wire::encode_hold_to_confirm_state(state).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn hold_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::HoldToConfirm(Box::default()))
}
pub(super) fn hold_press(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    action: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let action = wire::decode_guarded_printer_action(&intent_text(env, &action)?)
        .map_err(|_| "invalid_request")?;
    let state = with_hold(handle, |h| Ok(h.press(&action, now_ms)))?;
    hold_state(env, &state)
}
pub(super) fn hold_poll(env: &mut JNIEnv<'_>, handle: jlong, now_ms: f64) -> Result<jstring> {
    let state = with_hold(handle, |h| Ok(h.poll(now_ms)))?;
    hold_state(env, &state)
}
pub(super) fn hold_release(env: &mut JNIEnv<'_>, handle: jlong, now_ms: f64) -> Result<jstring> {
    let release = with_hold(handle, |h| Ok(h.release(now_ms)))?;
    let json = wire::encode_hold_to_confirm_release(&release).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn hold_cancel(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let state = with_hold(handle, |h| Ok(h.cancel()))?;
    hold_state(env, &state)
}

pub(super) fn filament_slots(env: &mut JNIEnv<'_>, text: JString<'_>) -> Result<jstring> {
    let text = printer_text(env, &text)?;
    let json = wire::encode_filament_slots_reply(&tools::filament_slots(&text))
        .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn tool_mapping(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_tool_mapping_request,
        tools::mapping,
        wire::encode_tool_mapping_report,
    )
}
pub(super) fn tool_usage_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::ToolUsage(Box::default()))
}
pub(super) fn tool_usage_append(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let bytes = input_bytes(env, &bytes)?;
    registry().slot(handle)?.with(|record| match record {
        Some(Record::ToolUsage(scanner)) => {
            scanner.append(&bytes);
            Ok(())
        }
        _ => Err("invalid_handle_kind"),
    })
}
/// The usage; the scanner is spent and its handle released.
pub(super) fn tool_usage_finish(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let scanner = registry().slot(handle)?.with(|record| match record {
        Some(Record::ToolUsage(scanner)) => Ok(std::mem::take(&mut **scanner)),
        _ => Err("invalid_handle_kind"),
    })?;
    registry().close(handle)?;
    let json = wire::encode_gcode_tool_usage(&scanner.finish()).map_err(|_| "output_limit")?;
    string(env, json)
}

fn printer_reply(
    env: &mut JNIEnv<'_>,
    text: JString<'_>,
    read: impl FnOnce(&str) -> std::result::Result<String, InvalidIntent>,
) -> Result<jstring> {
    let text = printer_text(env, &text)?;
    let json = read(&text).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn printer_objects(env: &mut JNIEnv<'_>, text: JString<'_>) -> Result<jstring> {
    printer_reply(env, text, |t| {
        wire::encode_optional_text_list(&preparation::printer_objects(t))
    })
}
pub(super) fn server_components(env: &mut JNIEnv<'_>, text: JString<'_>) -> Result<jstring> {
    printer_reply(env, text, |t| {
        wire::encode_optional_text_list(&preparation::server_components(t))
    })
}
pub(super) fn gcode_commands(env: &mut JNIEnv<'_>, text: JString<'_>) -> Result<jstring> {
    printer_reply(env, text, |t| {
        wire::encode_optional_text_list(&preparation::gcode_commands(t))
    })
}
pub(super) fn print_start_options(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_printer_capability_report,
        preparation::start_options,
        wire::encode_print_start_options,
    )
}
pub(super) fn print_preparation_plan(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_preparation_plan_request,
        preparation::preparation_plan,
        wire::encode_print_preparation_plan,
    )
}
pub(super) fn print_preparation_send(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_preparation_step,
        preparation::preparation_send,
        wire::encode_printer_send,
    )
}
pub(super) fn print_readiness(env: &mut JNIEnv<'_>, text: JString<'_>) -> Result<jstring> {
    printer_reply(env, text, |t| {
        wire::encode_print_readiness(&preparation::readiness(t))
    })
}
pub(super) fn print_readiness_failure(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_readiness_failure,
        preparation::readiness_unavailable,
        wire::encode_print_readiness,
    )
}
pub(super) fn sanitize_gcode_filename(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_printer_text,
        |r| wire::PrinterText {
            text: preparation::sanitize_filename(&r.text),
        },
        wire::encode_printer_text,
    )
}
pub(super) fn describe_transport_failure(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_transport_failure,
        |r| wire::PrinterText {
            text: preparation::describe_failure(r),
        },
        wire::encode_printer_text,
    )
}
pub(super) fn print_file_identity(
    env: &mut JNIEnv<'_>,
    text: JString<'_>,
    filename: JString<'_>,
) -> Result<jstring> {
    let text = printer_text(env, &text)?;
    exchange(
        env,
        filename,
        wire::decode_printer_text,
        |f| preparation::file_identity(&text, &f.text),
        wire::encode_print_file_identity_reply,
    )
}

fn with_workflow<R>(
    handle: jlong,
    call: impl FnOnce(&mut PrintWorkflow) -> std::result::Result<R, Refusal>,
) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::PrintWorkflow(workflow)) => call(workflow).map_err(Refusal::code),
        _ => Err("invalid_handle_kind"),
    })
}
fn workflow_step(env: &mut JNIEnv<'_>, step: wire::PrintWorkflowStep) -> Result<jstring> {
    let json = wire::encode_print_workflow_step(&step).map_err(|_| "output_limit")?;
    string(env, json)
}
fn effect_id(id: jlong) -> Result<u64> {
    u64::try_from(id).map_err(|_| "invalid_request")
}
pub(super) fn print_workflow_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::PrintWorkflow(Box::default()))
}
pub(super) fn print_workflow_busy(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jboolean> {
    with_workflow(handle, |w| Ok(u8::from(w.busy())))
}
/// A `PrintWorkflowIntent`: send a sliced artifact.
pub(super) fn print_workflow_run(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    intent: JString<'_>,
) -> Result<jstring> {
    let intent = wire::decode_print_workflow_intent(&intent_text(env, &intent)?)
        .map_err(|_| "invalid_request")?;
    let step = with_workflow(handle, |w| w.run(intent))?;
    workflow_step(env, step)
}
/// A `PrinterText` naming a stored file to start.
pub(super) fn print_workflow_start_stored(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    path: JString<'_>,
) -> Result<jstring> {
    let path =
        wire::decode_printer_text(&intent_text(env, &path)?).map_err(|_| "invalid_request")?;
    let step = with_workflow(handle, |w| w.start_stored(&path.text))?;
    workflow_step(env, step)
}
/// A `PrintWorkflowOutcome` answering effect `id`.
pub(super) fn print_workflow_resolve(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    outcome: JString<'_>,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let outcome = wire::decode_print_workflow_outcome(&intent_text(env, &outcome)?)
        .map_err(|_| "invalid_request")?;
    let step = with_workflow(handle, |w| w.resolve(id, outcome))?;
    workflow_step(env, step)
}
/// The reply a request or upload received: Moonraker's `result`, as JSON.
pub(super) fn print_workflow_reply(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    text: JString<'_>,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let text = printer_text(env, &text)?;
    let step = with_workflow(handle, |w| w.resolve_reply(id, &text))?;
    workflow_step(env, step)
}
pub(super) fn print_workflow_cancel(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_workflow(handle, |w| Ok(w.cancel()))?;
    workflow_step(env, step)
}
pub(super) fn print_workflow_dispose(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_workflow(handle, |w| Ok(w.dispose()))?;
    workflow_step(env, step)
}
