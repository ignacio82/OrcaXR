//! What a split would split, against the browser (`model-tool-vectors.json`,
//! `SplitSourceExchange.ts`): every instance of a project covering each of the
//! workspace's refusals, under both splits and several triangle limits,
//! answers byte for byte, and each malformed request is refused.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::model::{Decode, ProjectState};
use orcaxr_project::split::source::{INVALID_REQUEST, Target, check_object, source, source_json};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-tool-vectors.json"
    ))
    .unwrap()
}

fn state(corpus: &Value) -> ProjectState {
    ProjectState::from_value(parse(corpus["splitSources"]["stateJson"].as_str().unwrap()).unwrap())
        .unwrap()
}

#[test]
fn reference_sources_are_current() {
    for source in corpus()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn split_sources_match_the_browser() {
    let corpus = corpus();
    let state = state(&corpus);
    let cases = corpus["splitSources"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 100);
    let mut refused = 0;
    for case in cases {
        let reply = source_json(&state, case["request"].as_str().unwrap()).unwrap();
        assert_eq!(
            reply,
            case["reply"].as_str().unwrap(),
            "{}",
            case["request"]
        );
        refused += usize::from(reply.starts_with("{\"refusal\""));
    }
    assert_eq!(refused, 61);
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let state = state(&corpus);
    let refusals = corpus["splitSources"]["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 12);
    for case in refusals {
        assert_eq!(
            source_json(&state, case["request"].as_str().unwrap()),
            Err(INVALID_REQUEST),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn the_typed_source_names_the_object_and_its_placements() {
    let corpus = corpus();
    let state = state(&corpus);
    let id: Vec<u16> = "import:instance:pair-2".encode_utf16().collect();
    let found = source(&state, &id, Target::Objects, 50_000.0).unwrap();
    assert_eq!(found.object.instances.len(), 2);
    assert_eq!(found.triangle_count, 24.0);
    assert!(check_object(found.object, 23.0).is_err());
    assert!(check_object(found.object, 24.0).is_ok());
    let missing: Vec<u16> = "import:instance:none".encode_utf16().collect();
    let refusal = source(&state, &missing, Target::Parts, 1.0).err().unwrap();
    assert_eq!(
        String::from_utf16(&refusal).unwrap(),
        "Selected instance import:instance:none not found"
    );
}
