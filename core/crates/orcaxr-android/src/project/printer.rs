//! Printer workflow policy (`orcaxr_printer`) for Android hosts: the print job
//! status model, fed the reply and event text the host's transport received.
use super::*;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::status::{JobStatus, LIMITS};

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
