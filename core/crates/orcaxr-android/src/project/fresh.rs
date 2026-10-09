//! The project a session starts with and the one "New project" replaces it
//! with (`orcaxr_project::model::{empty_project, fresh_project}`), as the
//! canonical document bytes an upload opens. The host supplies the random
//! words the browser's UUID source would draw and its clock's ISO timestamp.
use super::*;
use orcaxr_project::ids::UuidIdSource;
use orcaxr_project::model::{Encode, Text, empty_project, fresh_project};

/// Sixteen words for each of the two identifiers a new project draws.
const WORDS: i32 = 32;
/// An ISO timestamp is 24 units; anything far past that is not one.
const MAX_TIMESTAMP_UNITS: i32 = 64;

fn words(env: &mut JNIEnv<'_>, values: &JDoubleArray<'_>) -> Result<std::vec::IntoIter<f64>> {
    if env.get_array_length(values).map_err(|_| "invalid_words")? != WORDS {
        return Err("invalid_words");
    }
    let mut result = vec![0.; WORDS as usize];
    env.get_double_array_region(values, 0, &mut result)
        .map_err(|_| "invalid_words")?;
    Ok(result.into_iter())
}
fn timestamp(env: &mut JNIEnv<'_>, now: &JString<'_>) -> Result<Text> {
    let length = env
        .call_method(now, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_timestamp")?;
    if !(1..=MAX_TIMESTAMP_UNITS).contains(&length) {
        return Err("invalid_timestamp");
    }
    let value: String = env.get_string(now).map_err(|_| "invalid_timestamp")?.into();
    Ok(Text::from_utf8(&value))
}
fn document(env: &mut JNIEnv<'_>, state: &impl Encode) -> Result<jbyteArray> {
    let mut bytes = Vec::new();
    state
        .write_json(&mut bytes)
        .map_err(|_| "allocation_failed")?;
    env.byte_array_from_slice(&bytes)
        .map(|v| v.into_raw())
        .map_err(|_| "allocation_failed")
}
pub(super) fn project_empty(
    env: &mut JNIEnv<'_>,
    words_drawn: JDoubleArray<'_>,
    now: JString<'_>,
) -> Result<jbyteArray> {
    let mut drawn = words(env, &words_drawn)?;
    let now = timestamp(env, &now)?;
    let mut ids = UuidIdSource::new(move || drawn.next().unwrap_or(0.));
    document(env, &empty_project(&mut ids, now, None, None, None))
}
pub(super) fn project_fresh(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    words_drawn: JDoubleArray<'_>,
    now: JString<'_>,
) -> Result<jbyteArray> {
    let mut drawn = words(env, &words_drawn)?;
    let now = timestamp(env, &now)?;
    let mut ids = UuidIdSource::new(move || drawn.next().unwrap_or(0.));
    let state = with_project(handle, |p| Ok(fresh_project(p.state(), &mut ids, now)))?;
    document(env, &state)
}
