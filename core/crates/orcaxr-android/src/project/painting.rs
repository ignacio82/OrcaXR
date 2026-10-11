//! The painter for native renderers and pointers
//! (`orcaxr_project::facets::{paint_tool, paint_facets}`): the paint stroke
//! sample a hit makes with the painter's settings, the colours paint draws in,
//! and paint facets — a volume channel's canonical facets or a stroke's live
//! preview — as a summary and packets of runs and leaves.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::facets::{paint_facets, paint_tool};

/// `{"channel","hit","settings","stateOrder"}` → `{"sample"}` or `{"error","message"}`.
pub(super) fn paint_tool_sample(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = paint_tool::sample_json(&request)?;
    string(env, json)
}
/// `{"channel","filaments","states"}` → `{"colors"}`.
pub(super) fn paint_facet_colors(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = paint_facets::colors_json(&request)?;
    string(env, json)
}
/// One sample of a stroke made with the painter's settings: `{"hit","settings"}`
/// → `{"reply","sample"}` or `{"error","message"}`.
pub(super) fn paint_stroke_sample_with(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let json = with_paint_stroke(handle, |stroke| stroke.sample_json(&request))?;
    string(env, json)
}
/// The paint facets of one volume's channel (a `PaintOverlayRequest`).
pub(super) fn session_paint_facets(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_paint_overlay_request)?;
    capture(|| {
        with_session(handle, |s| {
            s.paint_facets(&request)
                .map(|facets| Record::PaintFacets(Box::new(facets)))
                .map_err(|refusal| refusal.code())
        })
    })
}
/// A stroke's live preview as paint facets.
pub(super) fn paint_stroke_preview_facets(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        with_paint_stroke(handle, |stroke| {
            stroke
                .preview_facets()
                .map(|facets| Record::PaintFacets(Box::new(facets)))
                .map_err(|refusal| refusal.code())
        })
    })
}
pub(super) fn paint_facets_summary(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_paint_facets(handle, |facets| Ok(facets.summary()))?;
    string(env, json)
}
pub(super) fn paint_facets_runs(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let (start, count) = (index(start)?, index(count)?);
    let packet = with_paint_facets(handle, |facets| {
        facets
            .runs(start as u64, count as u64)
            .map_err(|refusal| refusal.code())
    })?;
    env.byte_array_from_slice(&packet)
        .map(|array| array.into_raw())
        .map_err(|_| "output_limit")
}
pub(super) fn paint_facets_leaves(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let (start, count) = (index(start)?, index(count)?);
    let packet = with_paint_facets(handle, |facets| {
        facets
            .leaves(start as u64, count as u64)
            .map_err(|refusal| refusal.code())
    })?;
    env.byte_array_from_slice(&packet)
        .map(|array| array.into_raw())
        .map_err(|_| "output_limit")
}
