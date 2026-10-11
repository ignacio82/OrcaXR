//! A captured project's filaments: the slots its physical filaments describe
//! (`orcaxr_project::slicing::configuration_exchange::project_slots_json`),
//! filament assignment (`orcaxr_project::filaments::assignment`) and the
//! virtual filament library (`orcaxr_project::filaments::library`), as
//! canonical JSON requests and replies.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::filaments::assignment;
use orcaxr_project::filaments::library::exchange as library_exchange;
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
/// `{}` → the virtual filament library the project shows, or `{"error"}`.
pub(super) fn project_virtual_filament_library(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    project_exchange(env, handle, request, library_exchange::library_json)
}
/// `{"operation",...}` → the step one library edit submits, or `{"error"}`.
pub(super) fn project_virtual_filament_mutation(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    project_exchange(env, handle, request, library_exchange::mutation_json)
}

fn exchange(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
    answer: fn(&str) -> Result<String>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = answer(&request)?;
    string(env, json)
}
/// `{"library","operation","filamentId"}` → the author dialog's opening fields.
pub(super) fn virtual_filament_form_defaults(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, request, library_exchange::defaults_json)
}
/// `{"library","form","search"}` → the dialog's issues, preview, draft and mode views.
pub(super) fn virtual_filament_form(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    exchange(env, request, library_exchange::form_json)
}
/// `{"x","y"}` → the triangle picker's proportions, or `{"error"}`.
pub(super) fn virtual_filament_triangle(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, request, library_exchange::triangle_json)
}
/// `{"library","targetColor","minComponentPercent"}` → the pinned search's candidates.
pub(super) fn virtual_filament_match_search(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    exchange(env, request, library_exchange::match_search_json)
}
