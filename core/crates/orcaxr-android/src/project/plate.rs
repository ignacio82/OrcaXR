//! One plate projected for an external slicer
//! (`orcaxr_project::slicing::plate`): an export capture reduced to the plate
//! as plate zero, for the archive writer to package, and the plate's print
//! overrides; plus the same projection over a state document, for hosts and
//! replays without a session. Plate IDs and asset IDs cross as JSON text, so
//! UTF-16 identities survive.
use super::*;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::slicing::plate::{
    self, MAX_EXCHANGE_BYTES, overrides_json, plate_print_overrides, read_plate,
};

/// An argument of a plate exchange, within the exchange's bound.
fn argument(env: &mut JNIEnv<'_>, text: &JString<'_>) -> Result<String> {
    bounded_text(env, text, MAX_EXCHANGE_BYTES)
}
/// The one-plate slice capture of an export capture's `plate_id`, in a slot
/// of its own: `exportArchive` packages it, `exportProject` reads the
/// projected project (its hash is the archive's `sourceHash`). The projection
/// is admitted under the host's timestamp resolver and integer profile.
pub(super) fn export_plate(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    plate_id: JString<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jlong> {
    let plate_id = read_plate(&argument(env, &plate_id)?)?;
    let mut timestamps = Timestamps::new(env, resolver, integer_mode)?;
    // The capture is shared, not copied; the resolver runs outside its slot.
    let capture = with_export(handle, |e| Ok(e.clone()))?;
    let reserved = registry().reserve(false)?;
    let projected = capture
        .plate(&plate_id, &mut timestamps)
        .map_err(|e| e.code())?;
    reserved.insert(Record::Export(projected))
}
/// The print configuration a captured project's plate overrides, as the
/// canonical JSON object of engine wire strings a submission carries.
pub(super) fn project_plate_overrides(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    plate_id: JString<'_>,
) -> Result<jstring> {
    let plate_id = read_plate(&argument(env, &plate_id)?)?;
    let json = with_project(handle, |p| {
        Ok(overrides_json(&plate_print_overrides(p.state(), &plate_id)))
    })?;
    string(env, json)
}
/// The ID plan a `duplicatePlate` of a captured project's plate needs
/// (`commands::duplicate_plate_shape`): the object count, each object's
/// volume, instance and layer-range counts, then the plate's custom G-code
/// and thumbnail counts; empty for an unknown plate.
pub(super) fn project_plate_shape(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    plate_id: JString<'_>,
) -> Result<jdoubleArray> {
    let plate_id = read_plate(&argument(env, &plate_id)?)?;
    let values = with_project(handle, |p| {
        let Some(shape) = orcaxr_project::commands::duplicate_plate_shape(p.state(), &plate_id)
        else {
            return Ok(Vec::new());
        };
        let mut values = Vec::with_capacity(3 + shape.objects.len() * 3);
        values.push(shape.objects.len() as f64);
        for counts in &shape.objects {
            values.extend(counts.iter().map(|count| *count as f64));
        }
        values.push(shape.custom_gcode as f64);
        values.push(shape.thumbnails as f64);
        Ok(values)
    })?;
    doubles(env, &values)
}
/// An instance ID carried as a JSON string, as plate IDs are.
fn read_instance(text: &str) -> Result<InstanceId> {
    match orcaxr_contracts::canonical::parse(text).map_err(|_| "invalid_request")? {
        orcaxr_contracts::canonical::Value::String(units) => {
            InstanceId::try_from_utf16(units).map_err(|_| "invalid_request")
        }
        _ => Err("invalid_request"),
    }
}
/// A copy of one instance on a current guard, staged as the browser's clone
/// (`ProjectSession::stage_instance_copy`): its one-use staged ID.
pub(super) fn stage_instance_copy(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    source_instance_id: JString<'_>,
    instance_id: JString<'_>,
) -> Result<jlong> {
    let source = read_instance(&argument(env, &source_instance_id)?)?;
    let id = read_instance(&argument(env, &instance_id)?)?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    with_session(handle, |s| {
        s.stage_instance_copy(&guard, &source, id)
            .map(|staged| staged as jlong)
            .map_err(|error| match error {
                wire::SessionError::Disposed => "disposed",
                wire::SessionError::Stale => "stale",
                wire::SessionError::ResourceLimit => "resource_limit",
                _ => "invalid_request",
            })
    })
}
/// A state document's plate projected: `{"assetIds","sourceHash","stateJson"}`
/// or `{"error","message"}`, as canonical JSON.
pub(super) fn plate_projection(
    env: &mut JNIEnv<'_>,
    state: JString<'_>,
    plate_id: JString<'_>,
    omitted: JString<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jstring> {
    let state = argument(env, &state)?;
    let plate_id = argument(env, &plate_id)?;
    let omitted = argument(env, &omitted)?;
    let mut timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let json = plate::projection_json(&state, &plate_id, &omitted, &mut timestamps)?;
    string(env, json)
}
/// A state document's plate's print overrides, as canonical JSON.
pub(super) fn plate_print_overrides_json(
    env: &mut JNIEnv<'_>,
    state: JString<'_>,
    plate_id: JString<'_>,
) -> Result<jstring> {
    let state = argument(env, &state)?;
    let plate_id = argument(env, &plate_id)?;
    let json = plate::print_overrides_json(&state, &plate_id)?;
    string(env, json)
}
