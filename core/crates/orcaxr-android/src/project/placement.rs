//! The workspace's bed and the transform inspector's fields
//! (`orcaxr_project::placement::{bed, fields}`): canonical JSON requests and
//! replies over a configuration, a captured project or three field texts.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::placement::{bed, fields};

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
