//! A captured project's filaments: the slots its physical filaments describe
//! (`orcaxr_project::slicing::configuration_exchange::project_slots_json`)
//! and filament assignment (`orcaxr_project::filaments::assignment`), as
//! canonical JSON requests and replies.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::filaments::assignment;
use orcaxr_project::model::ProjectState;
use orcaxr_project::slicing::configuration_exchange::project_slots_json;

fn project_exchange(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    answer: fn(&ProjectState, &str) -> Result<String>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_project(handle, |p| answer(p.state(), &request))?;
    string(env, json)
}
/// `{"palette"}` → `{"heads","nozzles","palette"}` the project's physical filaments describe.
pub(super) fn project_filament_slots(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    project_exchange(env, handle, request, project_slots_json)
}
/// `{"refs"}` → `{"options","scopes","unsupportedSelection"}` or `{"error"}`.
pub(super) fn project_filament_assignment(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    project_exchange(env, handle, request, assignment::resolution_json)
}
/// `{"entities","filamentId"}` → `{"assignments"}` or `{"error"}`.
pub(super) fn project_filament_assignment_changes(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    project_exchange(env, handle, request, assignment::changes_json)
}
