//! The workspace bed against the browser (`workspace-bed-vectors.json`):
//! every configuration's bed size, printable area and height and every plate
//! tower's keep-out answer byte for byte, each malformed request is refused,
//! and opened projects answer for each of their plates.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::model::{Decode, ProjectState};
use orcaxr_project::placement::bed::{INVALID_REQUEST, bed_json, state_bed_json};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/workspace-bed-vectors.json"
    ))
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
fn beds_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 74);
    for case in cases {
        let reply = bed_json(case["request"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["reply"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let refusals = corpus["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 14);
    for case in refusals {
        assert_eq!(
            bed_json(case["request"].as_str().unwrap()),
            Err(INVALID_REQUEST),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn projects_answer_for_their_plates() {
    let corpus = corpus();
    let states = corpus["states"].as_array().unwrap();
    assert_eq!(states.len(), 3);
    let mut beds = 0;
    for project in states {
        let state =
            ProjectState::from_value(parse(project["stateJson"].as_str().unwrap()).unwrap())
                .unwrap();
        for bed in project["beds"].as_array().unwrap() {
            let reply = state_bed_json(&state, bed["request"].as_str().unwrap()).unwrap();
            assert_eq!(reply, bed["reply"].as_str().unwrap(), "{}", project["name"]);
            beds += 1;
        }
        assert_eq!(state_bed_json(&state, "{}"), Err(INVALID_REQUEST));
        assert_eq!(
            state_bed_json(&state, r#"{"plateId":3}"#),
            Err(INVALID_REQUEST)
        );
    }
    assert_eq!(beds, 12);
}
