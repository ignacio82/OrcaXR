//! Live slice preflight of an export capture. The capture slot stays the
//! owner: closing it cancels a running preflight. Replies are read one
//! contract value at a time, so no single message carries the whole result.
use super::*;
use orcaxr_contracts::project_intent_types as wire;
pub(super) use orcaxr_project::slicing::report::Report;
use orcaxr_project::slicing::report::RequestError;

pub(super) fn export_preflight(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = intent_text(env, &request)?;
    let request = wire::decode_preflight_request(&request).map_err(|_| "invalid_request")?;
    let slot = registry().slot(handle)?;
    let capture = slot.with(|record| match record {
        Some(Record::Export(e)) => Ok(e.clone()),
        _ => Err("invalid_handle_kind"),
    })?;
    let reserved = registry().reserve(false)?;
    let report = capture
        .preflight(&request, || slot.is_closed())
        .map_err(|error| match error {
            RequestError::InvalidRequest => "invalid_request",
            RequestError::Preflight(error) => error.code(),
        })?;
    reserved.insert(Record::Preflight(Box::new(report)))
}
fn reply<T>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    read: impl FnOnce(&Report) -> Option<T>,
    encode: fn(&T) -> std::result::Result<String, orcaxr_contracts::project_intents::InvalidIntent>,
) -> Result<jstring> {
    let json = with_preflight(handle, |report| {
        let value = read(report).ok_or("invalid_range")?;
        encode(&value).map_err(|_| "output_limit")
    })?;
    string(env, json)
}
pub(super) fn preflight_summary(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    reply(
        env,
        handle,
        |r| Some(r.summary()),
        wire::encode_preflight_summary,
    )
}
pub(super) fn preflight_issue(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |r| r.issue(position),
        wire::encode_preflight_issue,
    )
}
pub(super) fn preflight_omission(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |r| r.omission(position),
        wire::encode_preflight_omission,
    )
}
pub(super) fn preflight_instance(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |r| r.printable_instance(position),
        wire::encode_preflight_entity,
    )
}
pub(super) fn preflight_filament(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |r| r.used_filament(position),
        wire::encode_preflight_entity,
    )
}
