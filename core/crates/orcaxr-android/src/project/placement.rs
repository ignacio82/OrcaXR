//! The workspace's bed, the transform inspector's fields and gizmo, new geometry, what
//! a split would split and how the shells arrange catalogue actions
//! (`orcaxr_project::placement::{bed, fields, gizmo}`, `orcaxr_project::primitives`,
//! `orcaxr_project::split::source`, `orcaxr_project::action_presentation`):
//! canonical JSON requests and replies over a configuration, a captured
//! project, a session, three field texts or the actions a shell shows.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::action_presentation;
use orcaxr_project::placement::{bed, fields, gizmo};
use orcaxr_project::primitives;

fn exchange(
    env: &mut JNIEnv<'_>,
    request: &JString<'_>,
    answer: fn(&str) -> Result<String>,
) -> Result<jstring> {
    let request = bounded_text(env, request, MAX_INPUT_BYTES)?;
    let json = answer(&request)?;
    string(env, json)
}
/// `{"config","wipeTower"}` → a configuration's bed and a tower's keep-out.
pub(super) fn workspace_bed(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, bed::bed_json)
}
/// `{"plateId"}` → a captured project's bed and that plate's keep-out.
pub(super) fn project_workspace_bed(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_project(handle, |p| bed::state_bed_json(p.state(), &request))?;
    string(env, json)
}
/// `{"instanceId","target","triangleLimit"}` → what a split of a captured
/// project would split (`orcaxr_project::split::source`), or its refusal.
pub(super) fn project_split_source(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_project(handle, |p| {
        orcaxr_project::split::source::source_json(p.state(), &request)
    })?;
    string(env, json)
}
/// `{"objectId","selectedLayerRangeId"}` → one object's height ranges as the
/// semantic editor shows them (`orcaxr_project::layer_range_editor`).
pub(super) fn project_layer_range_editor(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_project(handle, |p| {
        orcaxr_project::layer_range_editor::projection_json(p.state(), &request)
    })?;
    string(env, json)
}
/// Typed height-range bounds, checked as the semantic editor checks them.
pub(super) fn layer_range_bounds(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        &request,
        orcaxr_project::layer_range_editor::bounds_json,
    )
}
/// A typed split height, checked as the semantic editor checks it.
pub(super) fn layer_range_split(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        &request,
        orcaxr_project::layer_range_editor::split_json,
    )
}
/// What a height-range operation says while it runs and once it is done.
pub(super) fn layer_range_messages(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(
        env,
        &request,
        orcaxr_project::layer_range_editor::messages_json,
    )
}
/// `{"tool","transform"}` → what the tool's three fields show.
pub(super) fn transform_fields(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, fields::fields_json)
}
/// `{"origins","primaryInstanceId","texts","tool"}` → what a field edit submits.
pub(super) fn transform_field_edit(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, fields::edit_json)
}
/// `{"rotation"}` ↔ `{"eulerRadians"}`, as three converts them.
pub(super) fn transform_rotation(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, fields::rotation_json)
}
/// `{"proxy"}` → a transform gizmo attached to a proxy pose
/// (`orcaxr_project::placement::gizmo`).
pub(super) fn transform_gizmo_attach(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, &request, gizmo::attach_json)
}
/// `{"camera","event","mode","root","space","state"}` → the gizmo's state after one pointer event.
pub(super) fn transform_gizmo_step(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, gizmo::step_json)
}
/// `{"camera","mode","root","space","state"}` → what the gizmo shows: axis, drag, proxy, handles.
pub(super) fn transform_gizmo_present(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, &request, gizmo::present_json)
}
/// Every gizmo handle's baked geometry and the drag plane's.
pub(super) fn transform_gizmo_geometry(env: &mut JNIEnv<'_>) -> Result<jstring> {
    let json = gizmo::geometry_json()?;
    string(env, json)
}
/// `{"initialProxy","mode","origins","proxy"}` → the instance transforms a gizmo drag submits.
pub(super) fn transform_gizmo_changes(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, &request, gizmo::changes_json)
}
/// `{"actions":[{"hint"?,"id","label"}],"query"}` → the command palette's matches.
pub(super) fn command_palette(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, action_presentation::palette_json)
}
/// `{"actions":[id],"layout"}` → a context menu's sections or the toolbar's runs.
pub(super) fn action_groups(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, &request, action_presentation::groups_json)
}
/// `{"kind","sizeMm"}` → a primitive's or the helper cube's canonical mesh payload.
pub(super) fn primitive_payload(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jbyteArray> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let bytes = primitives::payload_json(&request)?;
    env.byte_array_from_slice(&bytes)
        .map(|array| array.into_raw())
        .map_err(|_| "output_limit")
}
/// A primitive as a new object of the session's acknowledged state.
pub(super) fn session_primitive_object(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_session(handle, |s| s.plan_primitive_object(&request))?;
    string(env, json)
}
/// Where the transform gizmo's proxy stands for a selection, in the session's acknowledged state.
pub(super) fn session_transform_proxy(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_session(handle, |s| s.plan_transform_proxy(&request))?;
    string(env, json)
}
/// A helper volume for the object a selection names, in the session's acknowledged state.
pub(super) fn session_helper_volume(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_session(handle, |s| s.plan_helper_volume(&request))?;
    string(env, json)
}
