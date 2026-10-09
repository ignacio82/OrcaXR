//! Printer workflow policy (`orcaxr_printer`) for Android hosts: the print job
//! status model, fed the reply and event text the host's transport received.
use super::*;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_contracts::project_intents::InvalidIntent;
use orcaxr_printer::{
    control::{self, HoldToConfirm},
    history, moonraker, preparation, reply,
    session::{self, PrinterSession},
    status::{JobStatus, LIMITS},
    storage, summary, tools,
    transport::{self, MoonrakerTransport},
    workflow::{PrintWorkflow, Refusal},
};

/// Text a printer sent, within the model's bounds.
fn printer_text(env: &mut JNIEnv<'_>, text: &JString<'_>) -> Result<String> {
    bounded_text(env, text, LIMITS.bytes)
}
fn bounded_text(env: &mut JNIEnv<'_>, text: &JString<'_>, bytes: usize) -> Result<String> {
    let length = env
        .call_method(text, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_request")?;
    if length < 0 || length as usize > bytes {
        return Err("input_limit");
    }
    let text: String = env.get_string(text).map_err(|_| "invalid_request")?.into();
    if text.len() > bytes {
        return Err("input_limit");
    }
    Ok(text)
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

fn with_session<R>(
    handle: jlong,
    call: impl FnOnce(&mut PrinterSession) -> std::result::Result<R, session::Refusal>,
) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::PrinterSession(session)) => call(session).map_err(session::Refusal::code),
        _ => Err("invalid_handle_kind"),
    })
}
fn session_step(env: &mut JNIEnv<'_>, step: wire::PrinterSessionStep) -> Result<jstring> {
    let json = wire::encode_printer_session_step(&step).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn printer_session_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::PrinterSession(Box::default()))
}
/// A `PrinterSelection`.
pub(super) fn printer_session_select(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    selection: JString<'_>,
) -> Result<jstring> {
    let selection = wire::decode_printer_selection(&intent_text(env, &selection)?)
        .map_err(|_| "invalid_request")?;
    let step = with_session(handle, |s| s.select(selection))?;
    session_step(env, step)
}
pub(super) fn printer_session_clear(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_session(handle, |s| Ok(s.clear()))?;
    session_step(env, step)
}
pub(super) fn printer_session_dispose(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_session(handle, |s| Ok(s.dispose()))?;
    session_step(env, step)
}
pub(super) fn printer_session_connect(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_session(handle, |s| Ok(s.connect()))?;
    session_step(env, step)
}
pub(super) fn printer_session_refresh(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let step = with_session(handle, |s| Ok(s.refresh()))?;
    session_step(env, step)
}
/// A `PrintJobExecuteRequest`.
pub(super) fn printer_session_execute(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = wire::decode_print_job_execute_request(&intent_text(env, &request)?)
        .map_err(|_| "invalid_request")?;
    let step = with_session(handle, |s| Ok(s.execute(request)))?;
    session_step(env, step)
}
/// A `ConnectionSignal` from transport `transport`.
pub(super) fn printer_session_state(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    transport: jlong,
    signal: JString<'_>,
) -> Result<jstring> {
    let transport = effect_id(transport)?;
    let signal = wire::decode_connection_signal(&intent_text(env, &signal)?)
        .map_err(|_| "invalid_request")?;
    let step = with_session(handle, |s| Ok(s.transport_state(transport, signal)))?;
    session_step(env, step)
}
/// A notification's method and params (JSON) as transport `transport`
/// received them at `now_ms`.
pub(super) fn printer_session_notification(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    transport: jlong,
    method: JString<'_>,
    params: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let transport = effect_id(transport)?;
    let method = printer_text(env, &method)?;
    let params = printer_text(env, &params)?;
    let step = with_session(handle, |s| {
        s.notification(transport, &method, &params, now_ms)
    })?;
    session_step(env, step)
}
/// A `PrinterSessionOutcome` answering effect `id`.
pub(super) fn printer_session_resolve(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    outcome: JString<'_>,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let outcome = wire::decode_printer_session_outcome(&intent_text(env, &outcome)?)
        .map_err(|_| "invalid_request")?;
    let step = with_session(handle, |s| s.resolve(id, outcome))?;
    session_step(env, step)
}
/// A request's reply (Moonraker's `result`, as JSON) received at `now_ms`.
pub(super) fn printer_session_reply(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    text: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let text = printer_text(env, &text)?;
    let step = with_session(handle, |s| s.resolve_reply(id, &text, now_ms))?;
    session_step(env, step)
}
pub(super) fn printer_session_view(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let view = with_session(handle, |s| Ok(s.view()))?;
    let json = wire::encode_printer_session_view(&view).map_err(|_| "output_limit")?;
    string(env, json)
}
/// A command's wire name; the `PrintJobIntentReply`.
pub(super) fn printer_session_capture_intent(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    command: JString<'_>,
) -> Result<jstring> {
    let command = session::command_named(&intent_text(env, &command)?).ok_or("invalid_request")?;
    let reply = with_session(handle, |s| Ok(s.capture_intent(command)))?;
    let json = wire::encode_print_job_intent_reply(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
/// An intent id; the `PrintJobConfirmReply`.
pub(super) fn printer_session_confirm(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    intent: jlong,
) -> Result<jstring> {
    let intent = effect_id(intent)?;
    let reply = with_session(handle, |s| Ok(s.confirm(intent)))?;
    let json = wire::encode_print_job_confirm_reply(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn printer_session_capture_lease(
    env: &mut JNIEnv<'_>,
    handle: jlong,
) -> Result<jstring> {
    let reply = with_session(handle, |s| Ok(s.capture_lease()))?;
    let json = wire::encode_printer_session_lease_reply(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
/// A `PrinterSessionLease`; whether it is still current.
pub(super) fn printer_session_lease_current(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    lease: JString<'_>,
) -> Result<jboolean> {
    let lease = wire::decode_printer_session_lease(&intent_text(env, &lease)?)
        .map_err(|_| "invalid_request")?;
    with_session(handle, |s| Ok(u8::from(s.lease_current(&lease))))
}

pub(super) fn moonraker_endpoint(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_endpoint_request,
        moonraker::normalize_endpoint,
        wire::encode_moonraker_endpoint_reply,
    )
}
pub(super) fn moonraker_path(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_path_request,
        moonraker::join_path,
        wire::encode_moonraker_path_reply,
    )
}
pub(super) fn moonraker_credentials(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_credential_check,
        moonraker::credential_check,
        wire::encode_moonraker_credential_reply,
    )
}
pub(super) fn moonraker_error_response(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_error_response,
        moonraker::error_response,
        wire::encode_moonraker_transport_fault,
    )
}
pub(super) fn moonraker_handshake(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_handshake_request,
        moonraker::handshake,
        wire::encode_moonraker_handshake_reply,
    )
}
pub(super) fn moonraker_reconnect_policy(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_reconnect_policy_input,
        moonraker::reconnect_policy,
        wire::encode_moonraker_reconnect_policy_reply,
    )
}
pub(super) fn moonraker_reconnect_delay(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jdouble> {
    let request = wire::decode_moonraker_reconnect_delay_request(&intent_text(env, &request)?)
        .map_err(|_| "invalid_request")?;
    Ok(moonraker::reconnect_delay(&request))
}
pub(super) fn moonraker_subscription(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_object_subscription,
        |entries| moonraker::subscription_reply(entries),
        wire::encode_moonraker_subscription_reply,
    )
}
pub(super) fn moonraker_method_check(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_moonraker_method_check,
        moonraker::method_check,
        wire::encode_moonraker_check_reply,
    )
}
pub(super) fn printer_storage_plan(
    env: &mut JNIEnv<'_>,
    operation: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        operation,
        wire::decode_printer_storage_operation,
        storage::plan,
        wire::encode_printer_storage_plan,
    )
}
pub(super) fn printer_storage_finish(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_printer_storage_finish,
        storage::finish,
        wire::encode_printer_storage_result,
    )
}
pub(super) fn printer_storage_read(
    env: &mut JNIEnv<'_>,
    operation: JString<'_>,
    reply: JString<'_>,
) -> Result<jstring> {
    let operation = wire::decode_printer_storage_operation(&intent_text(env, &operation)?)
        .map_err(|_| "invalid_request")?;
    let reply = bounded_text(env, &reply, reply::LIMITS.bytes)?;
    let json = wire::encode_printer_storage_result(&storage::read(&operation, &reply))
        .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn printer_storage_size(env: &mut JNIEnv<'_>, bytes: f64) -> Result<jstring> {
    let json = wire::encode_optional_text(&storage::size(bytes)).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn print_history_plan(env: &mut JNIEnv<'_>, operation: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        operation,
        wire::decode_print_history_operation,
        history::plan,
        wire::encode_print_history_plan,
    )
}
pub(super) fn print_history_finish(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        request,
        wire::decode_print_history_finish,
        history::finish,
        wire::encode_print_history_result,
    )
}
pub(super) fn print_history_read(
    env: &mut JNIEnv<'_>,
    operation: JString<'_>,
    reply: JString<'_>,
) -> Result<jstring> {
    let operation = wire::decode_print_history_operation(&intent_text(env, &operation)?)
        .map_err(|_| "invalid_request")?;
    let reply = bounded_text(env, &reply, reply::LIMITS.bytes)?;
    let json = wire::encode_print_history_result(&history::read(&operation, &reply))
        .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_history_duration(env: &mut JNIEnv<'_>, seconds: f64) -> Result<jstring> {
    let json = wire::encode_optional_text(&reply::optional_text(history::duration_text(seconds)))
        .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_history_filament(env: &mut JNIEnv<'_>, millimetres: f64) -> Result<jstring> {
    let json =
        wire::encode_optional_text(&reply::optional_text(history::filament_text(millimetres)))
            .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_history_job_view(env: &mut JNIEnv<'_>, job: JString<'_>) -> Result<jstring> {
    let job = wire::decode_print_history_job(&bounded_text(env, &job, wire::BULK.bytes)?)
        .map_err(|_| "invalid_request")?;
    let json = wire::encode_print_history_job_view(&history::job_view(&job))
        .map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn print_history_totals_text(
    env: &mut JNIEnv<'_>,
    totals: JString<'_>,
) -> Result<jstring> {
    exchange(
        env,
        totals,
        wire::decode_optional_print_history_totals,
        |t| wire::PrinterText {
            text: history::totals_text(t).encode_utf16().collect(),
        },
        wire::encode_printer_text,
    )
}
pub(super) fn print_history_page_view(env: &mut JNIEnv<'_>, shape: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        shape,
        wire::decode_print_history_page_shape,
        history::page_view,
        wire::encode_print_history_page_view,
    )
}

fn with_transport<R>(
    handle: jlong,
    call: impl FnOnce(&mut MoonrakerTransport) -> std::result::Result<R, transport::Refusal>,
) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::MoonrakerTransport(transport)) => {
            call(transport).map_err(transport::Refusal::code)
        }
        _ => Err("invalid_handle_kind"),
    })
}
fn transport_step(env: &mut JNIEnv<'_>, step: wire::MoonrakerTransportStep) -> Result<jstring> {
    let json = wire::encode_moonraker_transport_step(&step).map_err(|_| "output_limit")?;
    string(env, json)
}
/// Text a printer sent: at most `MAX_TEXT_UNITS + 1` UTF-16 units, which is
/// all that decides any outcome.
fn received_text(env: &mut JNIEnv<'_>, text: &JString<'_>) -> Result<String> {
    let length = env
        .call_method(text, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_request")?;
    if length < 0 || length as usize > transport::MAX_TEXT_UNITS + 1 {
        return Err("input_limit");
    }
    Ok(env.get_string(text).map_err(|_| "invalid_request")?.into())
}
fn transport_config(
    env: &mut JNIEnv<'_>,
    config: &JString<'_>,
) -> Result<wire::MoonrakerTransportConfig> {
    wire::decode_moonraker_transport_config(&intent_text(env, config)?)
        .map_err(|_| "invalid_request")
}
fn transport_request(
    env: &mut JNIEnv<'_>,
    request: &JString<'_>,
) -> Result<wire::MoonrakerRequest> {
    wire::decode_moonraker_request(&intent_text(env, request)?).map_err(|_| "invalid_request")
}
/// A `MoonrakerTransportConfig`; the `MoonrakerTransportReply` creating a
/// transport from it answers: its first state, or why it is refused.
pub(super) fn moonraker_transport_configure(
    env: &mut JNIEnv<'_>,
    config: JString<'_>,
) -> Result<jstring> {
    let config = transport_config(env, &config)?;
    let reply = match MoonrakerTransport::new(&config) {
        Ok((_, state)) => wire::MoonrakerTransportReply::State(state),
        Err(fault) => wire::MoonrakerTransportReply::Refused(fault),
    };
    let json = wire::encode_moonraker_transport_reply(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
/// A `MoonrakerTransportConfig` that `configure` accepts.
pub(super) fn moonraker_transport_new(env: &mut JNIEnv<'_>, config: JString<'_>) -> Result<jlong> {
    let config = transport_config(env, &config)?;
    let (transport, _) = MoonrakerTransport::new(&config).map_err(|_| "invalid_request")?;
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::MoonrakerTransport(Box::new(transport)))
}
/// Past this many UTF-16 units, text decides outcomes by its length alone.
pub(super) fn moonraker_transport_text_units(_: &mut JNIEnv<'_>) -> Result<jlong> {
    Ok(transport::MAX_TEXT_UNITS as jlong)
}
/// The JSON text of finished task `task`'s result, once.
pub(super) fn moonraker_transport_take_result(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    task: jlong,
) -> Result<jstring> {
    let task = effect_id(task)?;
    let text = with_transport(handle, |t| Ok(t.take_result(task)))?.ok_or("not_pending")?;
    string(env, text)
}
/// The JSON text of notification `notification`'s params, once.
pub(super) fn moonraker_transport_take_params(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    notification: jlong,
) -> Result<jstring> {
    let id = effect_id(notification)?;
    let text = with_transport(handle, |t| Ok(t.take_params(id)))?.ok_or("not_pending")?;
    string(env, text)
}
pub(super) fn moonraker_transport_state(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let state = with_transport(handle, |t| Ok(t.state()))?;
    let json = wire::encode_moonraker_connection_state(&state).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn moonraker_transport_has_api_key(
    _: &mut JNIEnv<'_>,
    handle: jlong,
) -> Result<jboolean> {
    with_transport(handle, |t| Ok(u8::from(t.credential_metadata().0)))
}
pub(super) fn moonraker_transport_has_bearer_token(
    _: &mut JNIEnv<'_>,
    handle: jlong,
) -> Result<jboolean> {
    with_transport(handle, |t| Ok(u8::from(t.credential_metadata().1)))
}
/// `MoonrakerCredentials`; an `OptionalMoonrakerTransportFault`.
pub(super) fn moonraker_transport_credentials(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    credentials: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let credentials = wire::decode_moonraker_credentials(&intent_text(env, &credentials)?)
        .map_err(|_| "invalid_request")?;
    let refused = with_transport(handle, |t| {
        Ok(match t.set_credentials(&credentials, now_ms) {
            Ok(()) => wire::OptionalMoonrakerTransportFault::Absent(wire::Empty {}),
            Err(fault) => wire::OptionalMoonrakerTransportFault::Value(fault),
        })
    })?;
    let json =
        wire::encode_optional_moonraker_transport_fault(&refused).map_err(|_| "output_limit")?;
    string(env, json)
}
pub(super) fn moonraker_transport_clear_credentials(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    now_ms: f64,
) -> Result<()> {
    with_transport(handle, |t| {
        t.clear_credentials(now_ms);
        Ok(())
    })
}
/// A `MoonrakerObjectSubscription`; the `MoonrakerTransportStepReply`.
pub(super) fn moonraker_transport_subscription(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    entries: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let entries = wire::decode_moonraker_object_subscription(&intent_text(env, &entries)?)
        .map_err(|_| "invalid_request")?;
    let reply = with_transport(handle, |t| {
        Ok(match t.set_subscription(Some(&entries), now_ms) {
            Ok(step) => wire::MoonrakerTransportStepReply::Step(step),
            Err(fault) => wire::MoonrakerTransportStepReply::Refused(fault),
        })
    })?;
    let json = wire::encode_moonraker_transport_step_reply(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
/// No object subscription.
pub(super) fn moonraker_transport_clear_subscription(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let step = with_transport(handle, |t| {
        Ok(t.set_subscription(None, now_ms)
            .map_err(|_| "invalid_request"))
    })??;
    transport_step(env, step)
}
/// A signal by name: `none`, `live` or `aborted`.
pub(super) fn moonraker_transport_connect(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    signal: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let signal = transport::signal_named(&intent_text(env, &signal)?).ok_or("invalid_request")?;
    let step = with_transport(handle, |t| Ok(t.connect(signal, now_ms)))?;
    transport_step(env, step)
}
/// A reason by name: `user`, `cancelled` or `disposed`.
pub(super) fn moonraker_transport_disconnect(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    reason: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let reason = transport::reason_named(&intent_text(env, &reason)?).ok_or("invalid_request")?;
    let step = with_transport(handle, |t| Ok(t.disconnect(reason, now_ms)))?;
    transport_step(env, step)
}
pub(super) fn moonraker_transport_dispose(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let step = with_transport(handle, |t| Ok(t.dispose(now_ms)))?;
    transport_step(env, step)
}
/// A `MoonrakerRequest`.
pub(super) fn moonraker_transport_request(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let request = transport_request(env, &request)?;
    let step = with_transport(handle, |t| Ok(t.request(&request, now_ms)))?;
    transport_step(env, step)
}
/// A `MoonrakerRequest` whose body is the host's file.
pub(super) fn moonraker_transport_upload(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let request = transport_request(env, &request)?;
    let step = with_transport(handle, |t| Ok(t.upload(&request, now_ms)))?;
    transport_step(env, step)
}
/// A `MoonrakerRequest` read as bytes.
pub(super) fn moonraker_transport_download(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let request = transport_request(env, &request)?;
    let step = with_transport(handle, |t| Ok(t.download(&request, now_ms)))?;
    transport_step(env, step)
}
/// A `MoonrakerRecoveryRequest`.
pub(super) fn moonraker_transport_recovery(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let request = wire::decode_moonraker_recovery_request(&intent_text(env, &request)?)
        .map_err(|_| "invalid_request")?;
    let step = with_transport(handle, |t| Ok(t.recovery(&request, now_ms)))?;
    transport_step(env, step)
}
/// The live signal of task `task` aborts.
pub(super) fn moonraker_transport_abort(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    task: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let task = effect_id(task)?;
    let step = with_transport(handle, |t| Ok(t.abort(task, now_ms)))?;
    transport_step(env, step)
}
/// A `MoonrakerTransportOutcome` answering effect `id`.
pub(super) fn moonraker_transport_resolve(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    outcome: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let outcome = wire::decode_moonraker_transport_outcome(&intent_text(env, &outcome)?)
        .map_err(|_| "invalid_request")?;
    let step = with_transport(handle, |t| t.resolve(id, outcome, now_ms))?;
    transport_step(env, step)
}
/// A body read as text, answering effect `id`.
pub(super) fn moonraker_transport_text(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    id: jlong,
    text: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let id = effect_id(id)?;
    let text = received_text(env, &text)?;
    let step = with_transport(handle, |t| t.resolve_text(id, &text, now_ms))?;
    transport_step(env, step)
}
pub(super) fn moonraker_transport_socket_open(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    socket: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let socket = effect_id(socket)?;
    let step = with_transport(handle, |t| Ok(t.socket_open(socket, now_ms)))?;
    transport_step(env, step)
}
pub(super) fn moonraker_transport_socket_error(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    socket: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let socket = effect_id(socket)?;
    let step = with_transport(handle, |t| Ok(t.socket_error(socket, now_ms)))?;
    transport_step(env, step)
}
pub(super) fn moonraker_transport_socket_close(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    socket: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let socket = effect_id(socket)?;
    let step = with_transport(handle, |t| Ok(t.socket_close(socket, now_ms)))?;
    transport_step(env, step)
}
/// A text frame socket `socket` received.
pub(super) fn moonraker_transport_socket_message(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    socket: jlong,
    text: JString<'_>,
    now_ms: f64,
) -> Result<jstring> {
    let socket = effect_id(socket)?;
    let text = received_text(env, &text)?;
    let step = with_transport(handle, |t| Ok(t.socket_message(socket, &text, now_ms)))?;
    transport_step(env, step)
}
/// Timer `timer` fired.
pub(super) fn moonraker_transport_timer(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    timer: jlong,
    now_ms: f64,
) -> Result<jstring> {
    let timer = effect_id(timer)?;
    let step = with_transport(handle, |t| Ok(t.timer(timer, now_ms)))?;
    transport_step(env, step)
}
