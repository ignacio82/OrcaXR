//! Mesh renderer packets against the browser: every packet of the browser's
//! script answers its reply and bytes exactly (paged), and the vertex normals
//! equal three.js's own normal attribute bit for bit, apart from the packer.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, history::*, mesh::decode_indexed, mesh_packet, model::*, selection::*, session::*,
    validation::*,
};
use serde_json::Value;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/mesh-packet-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn bytes(asset: &Value) -> Vec<u8> {
    asset["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn mesh_packets_match_the_browser() {
    let f = fixture();
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in f["assets"].as_array().unwrap() {
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes(asset),
            )
            .unwrap();
    }
    let session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        },
        NONCE,
    )
    .unwrap();
    let (mut prepared, mut refused, mut chunks) = (0, 0, 0);
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let request = wire::decode_mesh_packet_request(step["request"].as_str().unwrap()).unwrap();
        let packet = session.mesh_packet(&request).unwrap();
        assert_eq!(
            wire::encode_mesh_packet_reply(packet.reply()).unwrap(),
            step["reply"].as_str().unwrap(),
            "step {i}"
        );
        let wire::MeshPacketReply::Prepared(reply) = packet.reply() else {
            assert!(packet.bytes(0, 1).is_none());
            refused += 1;
            continue;
        };
        prepared += 1;
        chunks += reply.chunk_count;
        let mut all = Vec::new();
        while (all.len() as u64) < reply.byte_length {
            let count = (reply.byte_length - all.len() as u64).min(mesh_packet::MAX_PAGE);
            all.extend_from_slice(packet.bytes(all.len() as u64, count).unwrap());
        }
        assert_eq!(sha256(&all), step["bytes"].as_str().unwrap(), "step {i}");
        assert_eq!(
            step.get("window")
                .map(|_| sha256(packet.bytes(16, 64).unwrap())),
            step.get("window").map(|w| w.as_str().unwrap().to_owned()),
            "step {i}"
        );
        assert!(packet.bytes(reply.byte_length, 1).is_none());
        // The normals alone, as three.js stores them (NaNs as computed).
        let id = orcaxr_project::ids::AssetId::try_from_utf16(reply.asset_id.clone()).unwrap();
        let mesh = decode_indexed(&session.assets().peek(&id).unwrap()).unwrap();
        let positions: Vec<[f32; 3]> = mesh.positions.iter().map(|p| p.map(|v| v as f32)).collect();
        let normals: Vec<u8> = mesh_packet::vertex_normals(&positions, &mesh.indices)
            .iter()
            .flatten()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        assert_eq!(
            sha256(&normals),
            step["normals"].as_str().unwrap(),
            "step {i}"
        );
    }
    assert_eq!((prepared, refused, chunks), (53, 3, 8_307));
}
