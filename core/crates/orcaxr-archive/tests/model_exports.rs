//! The File menu's model exports (`model-export-vectors.json`, from the
//! browser's `modelExportExchange.ts`): every STL export of every recorded
//! state opened as a session — reply, file length and SHA-256 — every output
//! name, and every malformed request refused.
use orcaxr_archive::exports::{self, Exported, Failure};
use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::*, export::ExportCapture, history::*, model::*, selection::*, session::*, validation::*,
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-export-vectors.json"
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
        _ => 63,
    };
    let clean: Vec<u8> = text.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::new();
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= u32::from(value(c)) << (18 - 6 * i);
        }
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn session(fixture: &Json, state_json: &str) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let state = ProjectState::from_value(parse(state_json).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in fixture["assets"].as_array().unwrap() {
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &base64(asset["base64"].as_str().unwrap()),
            )
            .unwrap();
    }
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [1, 2, 3, 4],
    )
    .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn stl_exports_match_the_browser() {
    let fixture = corpus();
    let mut files = 0;
    let mut refused = 0;
    for state in fixture["states"].as_array().unwrap() {
        let session = session(&fixture, state["stateJson"].as_str().unwrap());
        assert_eq!(
            session.snapshot().revision(),
            state["revision"].as_u64().unwrap()
        );
        let capture = ExportCapture::new(&session, &session.capture_guard().unwrap()).unwrap();
        for case in fixture["stl"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["state"] == state["name"])
        {
            let mut bytes = Vec::new();
            let reply = exports::stl_export_json(
                &capture,
                case["requestJson"].as_str().unwrap(),
                &mut bytes,
            )
            .unwrap();
            assert_eq!(reply, case["replyJson"].as_str().unwrap(), "{case}");
            if let Some(sha) = case["sha256"].as_str() {
                assert_eq!(
                    bytes.len() as u64,
                    case["bytes"].as_u64().unwrap(),
                    "{case}"
                );
                assert_eq!(hex(&bytes), sha, "{case}");
                files += 1;
            } else {
                assert!(bytes.is_empty(), "a refusal writes nothing: {case}");
                refused += 1;
            }
        }
    }
    assert_eq!((files, refused), (85, 35));
}

#[test]
fn exported_lengths_are_known_before_writing() {
    let fixture = corpus();
    let state = &fixture["states"][1];
    let session = session(&fixture, state["stateJson"].as_str().unwrap());
    let capture = ExportCapture::new(&session, &session.capture_guard().unwrap()).unwrap();
    let request = exports::StlRequest {
        archive: false,
        selected: Vec::new(),
    };
    let mut bytes = Vec::new();
    let exported: Exported = exports::export_stl(
        capture.project().state(),
        &|id| capture.asset_by_id(id),
        &request,
        &mut bytes,
    )
    .unwrap();
    assert_eq!(exported.bytes, bytes.len() as u64);
    assert_eq!(&bytes[..27], b"OrcaXR canonical binary STL");
    // A destination that fails reports the failure, never a reply.
    struct Broken;
    impl std::io::Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("full"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for archive in [false, true] {
        let outcome = exports::export_stl(
            capture.project().state(),
            &|id| capture.asset_by_id(id),
            &exports::StlRequest {
                archive,
                selected: Vec::new(),
            },
            &mut Broken,
        );
        assert!(matches!(outcome, Err(Failure::Io(_))));
        assert_eq!(exports::stl_reply(&outcome), None);
    }
}

#[test]
fn names_match_the_browser() {
    let fixture = corpus();
    let cases = fixture["names"].as_array().unwrap();
    assert_eq!(cases.len(), 78);
    for case in cases {
        assert_eq!(
            exports::export_name_json(case["requestJson"].as_str().unwrap()).unwrap(),
            case["replyJson"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn malformed_requests_are_refused() {
    let fixture = corpus();
    let state = &fixture["states"][0];
    let session = session(&fixture, state["stateJson"].as_str().unwrap());
    let capture = ExportCapture::new(&session, &session.capture_guard().unwrap()).unwrap();
    let refusals = fixture["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 12);
    for refusal in refusals {
        let request = refusal["request"].as_str().unwrap();
        let outcome = if refusal["exchange"] == "stl" {
            exports::stl_export_json(&capture, request, &mut Vec::new())
        } else {
            exports::export_name_json(request)
        };
        assert_eq!(outcome, Err(exports::INVALID_REQUEST), "{refusal}");
    }
}
