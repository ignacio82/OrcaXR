//! The project's slicing configuration from catalog profiles
//! (`orcaxr_project::slicing::configuration_exchange`): canonical JSON
//! requests and replies over a loaded catalog, a state document or a live
//! session. States and configurations travel as JSON text; the host supplies
//! the random words new FullSpectrum pair identities draw, sixteen each.
use super::*;
use orcaxr_project::slicing::configuration_exchange::{self as exchange, MAX_EXCHANGE_BYTES};

/// Sixteen words for each of the at most C(64, 2) pairs one exchange creates.
const MAX_WORDS: usize = 16 * 64 * 63 / 2;

fn request_text(env: &mut JNIEnv<'_>, request: &JString<'_>) -> Result<String> {
    bounded_text(env, request, MAX_EXCHANGE_BYTES)
}
fn words(env: &mut JNIEnv<'_>, values: &JDoubleArray<'_>) -> Result<Vec<f64>> {
    if values.is_null() {
        return Err("invalid_words");
    }
    let length = env.get_array_length(values).map_err(|_| "invalid_words")?;
    if length < 0 || length as usize > MAX_WORDS {
        return Err("input_limit");
    }
    let mut result = vec![0.; length as usize];
    env.get_double_array_region(values, 0, &mut result)
        .map_err(|_| "invalid_words")?;
    Ok(result)
}
fn catalog_exchange(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    answer: fn(Option<&orcaxr_project::settings::catalog::ProfileCatalog>, &str) -> Result<String>,
) -> Result<jstring> {
    let request = request_text(env, &request)?;
    let json = with_catalog(handle, |c| answer(c.catalog(), &request))?;
    string(env, json)
}
/// `{"machinePresetId"?, "processPresetId"?}` → the pickers' choices.
pub(super) fn catalog_slicing_choices(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    catalog_exchange(env, handle, request, exchange::choices_json)
}
/// `{"live","request"}` → a selection by preset ID.
pub(super) fn catalog_slicing_select(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    catalog_exchange(env, handle, request, exchange::select_json)
}
/// `{"live","machine","process","filament"}` → a selection by typed names.
pub(super) fn catalog_slicing_select_by_names(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    catalog_exchange(env, handle, request, exchange::select_by_names_json)
}
/// `{"live"}` → the catalog's default triple selected.
pub(super) fn catalog_slicing_default(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    catalog_exchange(env, handle, request, exchange::default_selection_json)
}
/// `{"live","stateJson"}` → the live choice's configuration, the state
/// admitted under the host's resolver and integer profile.
pub(super) fn catalog_slicing_configuration(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jstring> {
    let request = request_text(env, &request)?;
    let mut timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let json = with_catalog(handle, |c| {
        exchange::configuration_json(c.catalog(), &request, &mut timestamps)
    })?;
    string(env, json)
}
/// `{"options","query"}` → the one option a typed name means.
pub(super) fn slicing_match(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = request_text(env, &request)?;
    let json = exchange::match_json(&request)?;
    string(env, json)
}
/// `{"autoPairs","configurationJson","stateJson"}` → the state a
/// configuration leads to, admitted under the host's resolver.
pub(super) fn slicing_next_state(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
    words_drawn: JDoubleArray<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jstring> {
    let request = request_text(env, &request)?;
    let words = words(env, &words_drawn)?;
    let mut timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let json = exchange::next_state_json(&request, &words, &mut timestamps)?;
    string(env, json)
}
/// `{"autoPairs","live"}` → the session's live choice staged as one
/// "Update slicing configuration" replacement for `executeStaged`.
pub(super) fn stage_slicing_configuration(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    catalog: jlong,
    request: JString<'_>,
    words_drawn: JDoubleArray<'_>,
) -> Result<jstring> {
    let request = request_text(env, &request)?;
    let words = words(env, &words_drawn)?;
    let json = with_catalog(catalog, |c| {
        with_session(handle, |s| {
            exchange::stage_json(s, c.catalog(), &request, &words)
        })
    })?;
    string(env, json)
}
