//! Smart Paint subsystem JNI bindings (P4.9).
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::mesh::decode_indexed;
use orcaxr_project::smart_paint::{
    build_smart_paint_batch, describe_geometry, parse_proposal, project_proposal,
    SmartPaintRegionAssignment,
};
use serde_json::json;

pub(super) fn smart_paint_validate_proposal(
    env: &mut JNIEnv<'_>,
    proposal: JString<'_>,
) -> Result<jstring> {
    let text = bounded_text(env, &proposal, MAX_INPUT_BYTES)?;
    let reply = match parse_proposal(&text) {
        Ok(parsed) => json!({
            "valid": true,
            "proposal": parsed,
        }),
        Err(err) => json!({
            "valid": false,
            "error": err.code.as_str(),
            "message": err.message,
        }),
    };
    let json_str = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json_str)
}

pub(super) fn smart_paint_describe_geometry(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    volume_id: JString<'_>,
) -> Result<jstring> {
    let vid_str = bounded_text(env, &volume_id, MAX_INPUT_BYTES)?;
    let vid_u16: Vec<u16> = vid_str.encode_utf16().collect();
    let reply = with_session(handle, |session| {
        let snapshot = session.snapshot();
        let state = snapshot.state();
        let volume = state
            .plates
            .iter()
            .flat_map(|p| p.objects.iter())
            .flat_map(|o| o.volumes.iter())
            .find(|v| v.id.as_utf16() == vid_u16.as_slice())
            .ok_or("unknown_volume")?;
        let lease = session.assets().peek(&volume.source.asset_id).ok_or("invalid_mesh")?;
        let decoded = decode_indexed(&lease).map_err(|_| "invalid_mesh")?;
        let triangles: Vec<[u32; 3]> = decoded
            .indices
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        let desc = describe_geometry(&decoded.positions, &triangles).ok_or("degenerate_mesh")?;
        serde_json::to_string(&desc).map_err(|_| "output_limit")
    })?;
    string(env, reply)
}

pub(super) fn smart_paint_project(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    volume_id: JString<'_>,
    proposal: JString<'_>,
) -> Result<jstring> {
    let vid_str = bounded_text(env, &volume_id, MAX_INPUT_BYTES)?;
    let prop_str = bounded_text(env, &proposal, MAX_INPUT_BYTES)?;
    let vid_u16: Vec<u16> = vid_str.encode_utf16().collect();
    let parsed_proposal = parse_proposal(&prop_str).map_err(|_| "invalid_proposal")?;

    let reply = with_session(handle, |session| {
        let snapshot = session.snapshot();
        let state = snapshot.state();
        let volume = state
            .plates
            .iter()
            .flat_map(|p| p.objects.iter())
            .flat_map(|o| o.volumes.iter())
            .find(|v| v.id.as_utf16() == vid_u16.as_slice())
            .ok_or("unknown_volume")?;
        let lease = session.assets().peek(&volume.source.asset_id).ok_or("invalid_mesh")?;
        let decoded = decode_indexed(&lease).map_err(|_| "invalid_mesh")?;
        let triangles: Vec<[u32; 3]> = decoded
            .indices
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        let projection = project_proposal(
            &parsed_proposal,
            &decoded.positions,
            &triangles,
            &vid_str,
            volume.source.topology_revision.get() as u64,
        ).map_err(|_| "projection_failed")?;
        serde_json::to_string(&projection).map_err(|_| "output_limit")
    })?;
    string(env, reply)
}

pub(super) fn smart_paint_build_batch(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    volume_id: JString<'_>,
    channel: JString<'_>,
    proposal: JString<'_>,
    assignments: JString<'_>,
) -> Result<jstring> {
    let vid_str = bounded_text(env, &volume_id, MAX_INPUT_BYTES)?;
    let chan_str = bounded_text(env, &channel, MAX_INPUT_BYTES)?;
    let prop_str = bounded_text(env, &proposal, MAX_INPUT_BYTES)?;
    let assign_str = bounded_text(env, &assignments, MAX_INPUT_BYTES)?;

    let vid_u16: Vec<u16> = vid_str.encode_utf16().collect();
    let parsed_proposal = parse_proposal(&prop_str).map_err(|_| "invalid_proposal")?;
    let parsed_assignments: Vec<SmartPaintRegionAssignment> =
        serde_json::from_str(&assign_str).map_err(|_| "invalid_assignments")?;

    let reply = with_session(handle, |session| {
        let snapshot = session.snapshot();
        let state = snapshot.state();
        let volume = state
            .plates
            .iter()
            .flat_map(|p| p.objects.iter())
            .flat_map(|o| o.volumes.iter())
            .find(|v| v.id.as_utf16() == vid_u16.as_slice())
            .ok_or("unknown_volume")?;
        let lease = session.assets().peek(&volume.source.asset_id).ok_or("invalid_mesh")?;
        let decoded = decode_indexed(&lease).map_err(|_| "invalid_mesh")?;
        let triangles: Vec<[u32; 3]> = decoded
            .indices
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        let projection = project_proposal(
            &parsed_proposal,
            &decoded.positions,
            &triangles,
            &vid_str,
            volume.source.topology_revision.get() as u64,
        ).map_err(|_| "projection_failed")?;
        let guard = wire::FacetGuard {
            revision: snapshot.revision(),
            hash: snapshot.hash().encode_utf16().collect(),
            volume_id: volume.id.as_utf16().to_vec(),
            topology_revision: volume.source.topology_revision.get() as u64,
            triangle_count: volume.source.triangle_count.get() as u64,
        };
        let batch = build_smart_paint_batch(guard, &chan_str, &projection, &parsed_assignments)
            .map_err(|_| "build_batch_failed")?;
        wire::encode_batch(&batch).map_err(|_| "encode_batch_failed")
    })?;
    string(env, reply)
}
