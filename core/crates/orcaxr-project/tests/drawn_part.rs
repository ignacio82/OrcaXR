//! Drawn parts against the browser: on the project the browser's Emboss and
//! SVG part tools made (text parts, SVG parts, plain parts), every part
//! answers whether it is embossed text or an SVG part as the browser's
//! `drawnPartWire` does, and an unknown part is refused in its words.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/drawn-part-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("base64 {c}"),
    } as u32;
    let mut out = Vec::new();
    for chunk in text.trim_end_matches('=').as_bytes().chunks(4) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |word, (i, &c)| word | value(c) << (18 - 6 * i));
        out.extend(&word.to_be_bytes()[1..chunk.len()]);
    }
    out
}

#[test]
fn drawn_parts_answer_as_the_browser_does() {
    let f = fixture();
    let parts = &f["parts"];
    let state =
        ProjectState::from_value(parse(parts["projectJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in parts["assets"].as_array().unwrap() {
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &base64(asset["bytes"].as_str().unwrap()),
            )
            .unwrap();
    }
    let mut session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        },
        [1, 2, 3, 4],
    )
    .unwrap();
    let mut kinds = [0; 4];
    for (i, step) in parts["steps"].as_array().unwrap().iter().enumerate() {
        let request = wire::decode_drawn_part_request(step["request"].as_str().unwrap()).unwrap();
        let reply = session.drawn_part(&request).unwrap();
        assert_eq!(
            wire::encode_drawn_part_reply(&reply).unwrap(),
            step["reply"].as_str().unwrap(),
            "step {i}"
        );
        kinds[match reply {
            wire::DrawnPartReply::Part(wire::DrawnPart { text: true, .. }) => 0,
            wire::DrawnPartReply::Part(wire::DrawnPart { svg: true, .. }) => 1,
            wire::DrawnPartReply::Part(_) => 2,
            wire::DrawnPartReply::Refused(_) => 3,
        }] += 1;
    }
    assert_eq!(kinds, [3, 3, 3, 2]);
    session.dispose();
    assert!(
        session
            .drawn_part(&wire::DrawnPartRequest {
                volume_id: vec![0x61]
            })
            .is_err()
    );
}
