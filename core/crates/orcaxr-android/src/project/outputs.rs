//! A slice's outputs (`orcaxr_project::slicing::{thumbnails, plate}`,
//! `orcaxr_archive::thumbnail`): what a printer's `thumbnails` value asks
//! for, a block in the engine's wire format, where blocks go in a G-code, the
//! thumbnail camera, which plates a slice slices — canonical JSON requests and
//! replies, as the browser's exchanges answer them — and a capture's pictures,
//! rendered from its plate by the shared core; and what binds a slice's
//! output (`orcaxr_project::slicing::sidecar`): the plate's profile snapshot,
//! the output binding, this device's route and the sidecar published beside
//! the G-code.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::slicing::{plate as slice_plate, sidecar, thumbnails};

fn exchange(
    env: &mut JNIEnv<'_>,
    request: &JString<'_>,
    answer: fn(&str) -> Result<String>,
) -> Result<jstring> {
    let request = bounded_text(env, request, MAX_INPUT_BYTES)?;
    let json = answer(&request)?;
    string(env, json)
}
/// `{"value"?}` → `{"problems","requests"}`.
pub(super) fn slice_thumbnail_list(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, thumbnails::list_json)
}
/// `{"image","request"}` → the block's text as a JSON string.
pub(super) fn slice_thumbnail_block(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, thumbnails::block_json)
}
/// `{"blocks","gcode"}` → the G-code with its blocks as a JSON string.
pub(super) fn slice_thumbnail_inject(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, &request, thumbnails::inject_json)
}
/// `{"aspect","max","min"}` → `{"fovDeg","position","target"}`.
pub(super) fn slice_thumbnail_view(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, thumbnails::view_json)
}
/// `{"scope","stateJson"}` → `{"plateIds"}` or `{"refusal"}`.
pub(super) fn slice_plan(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, slice_plate::plan_json)
}
/// `"current-plate"` or `"all-plates"` → the plates a captured project's
/// slice of that scope slices, as [`slice_plan`] answers.
pub(super) fn project_slice_plan(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    scope: JString<'_>,
) -> Result<jstring> {
    let scope = match bounded_text(env, &scope, 32)?.as_str() {
        "current-plate" => slice_plate::Scope::CurrentPlate,
        "all-plates" => slice_plate::Scope::AllPlates,
        _ => return Err("invalid_request"),
    };
    let json = with_project(handle, |p| {
        Ok(slice_plate::plan_reply(slice_plate::slice_plan(
            p.state(),
            scope,
        )))
    })?;
    string(env, json)
}
/// `{"plateId","stateJson"}` → the plate's profile snapshot, or `{"error"}`.
pub(super) fn slice_profiles(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, sidecar::profiles_json)
}
/// `{"binding"}` → `{"valid":true}`, or `{"error"}` naming the first refusal.
pub(super) fn slice_binding(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, sidecar::binding_json)
}
/// `{"engine"}` → this device's route metadata, or `{"error"}`.
pub(super) fn slice_native_route(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, sidecar::native_route_json)
}
/// `{"binding","gcodeBytes","profiles","route","summary","warnings"}` → the
/// sidecar document, or `{"error"}`.
pub(super) fn slice_sidecar(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, sidecar::sidecar_json)
}
/// The profile snapshot a captured project's plate (`plateId` as JSON text)
/// is sliced with, as [`slice_profiles`] answers.
pub(super) fn project_slice_profiles(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    plate_id: JString<'_>,
) -> Result<jstring> {
    let plate_id = slice_plate::read_plate(&bounded_text(env, &plate_id, MAX_INPUT_BYTES)?)?;
    let json = with_project(handle, |p| {
        sidecar::profiles_reply(sidecar::profiles(p.state(), &plate_id))
    })?;
    string(env, json)
}
/// The pictures an export capture's project asks for, drawn from its active
/// plate (a plate capture's only one): `{"problems","thumbnails":[{"block",
/// "coverage","format","height","width"}]}`. The capture is shared, not
/// copied, and drawn outside its slot.
pub(super) fn export_thumbnails(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let capture = with_export(handle, |e| Ok(e.clone()))?;
    let json = orcaxr_archive::thumbnail::capture_json(&capture).map_err(|e| e.code())?;
    string(env, json)
}
