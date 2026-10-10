//! The transform inspector's fields against the browser
//! (`transform-field-vectors.json`): what each tool's fields show, every
//! Euler ↔ quaternion conversion three.js makes, and the changes (or the
//! workspace's refusal) every field edit submits, byte for byte.
use orcaxr_project::placement::fields::{INVALID_REQUEST, edit_json, fields_json, rotation_json};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/transform-field-vectors.json"
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
fn fields_show_what_the_browser_shows() {
    let corpus = corpus();
    let reads = corpus["reads"].as_array().unwrap();
    assert_eq!(reads.len(), 101);
    for case in reads {
        let request = case["request"].as_str().unwrap();
        assert_eq!(
            fields_json(request).unwrap(),
            case["reply"].as_str().unwrap(),
            "{request}"
        );
    }
}

#[test]
fn rotations_convert_as_three_converts_them() {
    let corpus = corpus();
    let conversions = corpus["conversions"].as_array().unwrap();
    assert_eq!(conversions.len(), 1720);
    for case in conversions {
        let request = case["request"].as_str().unwrap();
        assert_eq!(
            rotation_json(request).unwrap(),
            case["reply"].as_str().unwrap(),
            "{request}"
        );
    }
}

#[test]
fn edits_submit_what_the_browser_submits() {
    let corpus = corpus();
    let edits = corpus["edits"].as_array().unwrap();
    assert_eq!(edits.len(), 94);
    for case in edits {
        let reply = edit_json(case["request"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["reply"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let refusals = corpus["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 19);
    for case in refusals {
        let request = case["request"].as_str().unwrap();
        let reply = match case["exchange"].as_str().unwrap() {
            "fields" => fields_json(request),
            "edit" => edit_json(request),
            _ => rotation_json(request),
        };
        assert_eq!(reply, Err(INVALID_REQUEST), "{request}");
    }
}
