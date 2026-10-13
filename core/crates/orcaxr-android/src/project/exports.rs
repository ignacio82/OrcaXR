//! The File menu's model exports (`orcaxr_archive::exports`, the browser's
//! `modelExportExchange.ts`): an export capture's STL — one merged file, or
//! one per instance in the browser's own ZIP — streamed to the host in
//! bounded chunks with the exchange's reply, and the names outputs are
//! offered under.
use super::json_sink::Sink;
use super::*;
use jni::objects::JDoubleArray;
use orcaxr_archive::exports;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;

/// `stlExportExchange` on export capture [handle]: the file to [target] (a
/// `ProjectJsonSink`, chunks of at most 64 KiB) and the reply. A refusal
/// writes nothing and is a reply; a destination's failure is an error.
pub(super) fn export_stl<'local>(
    env: &mut JNIEnv<'local>,
    handle: jlong,
    request: JString<'_>,
    target: JObject<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let request = exports::StlRequest::parse(&request)?;
    let capture = with_export(handle, |e| Ok(e.clone()))?;
    let reply = {
        let mut sink = Sink::open(env, handle, layout::MAX_BUDGET, target)?;
        let outcome = exports::export_stl(
            capture.project().state(),
            &|id| capture.asset_by_id(id),
            &request,
            &mut sink,
        );
        match exports::stl_reply(&outcome) {
            Some(reply) if outcome.is_ok() => {
                sink.flush().map_err(|_| sink.failure())?;
                reply
            }
            Some(reply) => reply,
            None => return Err(sink.failure()),
        }
    };
    string(env, reply)
}

/// Export as 3MF… of export capture [handle] under the archive policy
/// [options]: the browser's package streamed to [target] and the reply, or
/// the refusal (a reply too, before the first byte). A destination's failure
/// is an error.
pub(super) fn export_project_archive<'local>(
    env: &mut JNIEnv<'local>,
    handle: jlong,
    version: jint,
    options: JDoubleArray<'_>,
    target: JObject<'_>,
) -> Result<jstring> {
    let policy = super::archive::policy(env, version, &options)?;
    let capture = with_export(handle, |e| Ok(e.clone()))?;
    let reply = {
        let mut sink = Sink::open(env, handle, layout::MAX_BUDGET, target)?;
        match exports::project_archive_json(&capture, policy.package(), &mut sink) {
            Ok(reply) => {
                sink.flush().map_err(|_| sink.failure())?;
                reply
            }
            Err(_) => return Err(sink.failure()),
        }
    };
    string(env, reply)
}

/// `exportNameExchange`: `{"kind","name"}` → `{"filename"}`.
pub(super) fn export_name(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = exports::export_name_json(&request)?;
    string(env, json)
}
