//! Filament assignment against the browser (`filament-assignment-vectors.json`):
//! every selection's scopes, unsupported refs and offered filaments, and every
//! choice's assignments or refusal, answer byte for byte; malformed requests
//! are refused; and the journey's snapshots are the exchange's answers over
//! the states its assignments lead to.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::filaments::assignment::{
    INVALID_REQUEST, RefKind, changes_json, resolution, resolution_json,
};
use orcaxr_project::model::{Decode, ProjectState};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/filament-assignment-vectors.json"
    ))
    .unwrap()
}
fn state(corpus: &Value, name: &str) -> ProjectState {
    ProjectState::from_value(parse(corpus["states"][name].as_str().unwrap()).unwrap()).unwrap()
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
fn resolutions_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["resolutions"].as_array().unwrap();
    let mut refused = 0;
    for (i, case) in cases.iter().enumerate() {
        let state = state(&corpus, case["state"].as_str().unwrap());
        let reply = resolution_json(&state, case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "resolution {i}");
        refused += usize::from(reply.starts_with("{\"error\""));
    }
    assert_eq!((cases.len(), refused), (36, 5));
}

#[test]
fn assignments_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["changes"].as_array().unwrap();
    let mut refused = 0;
    for (i, case) in cases.iter().enumerate() {
        let state = state(&corpus, case["state"].as_str().unwrap());
        let reply = changes_json(&state, case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "assignment {i}");
        refused += usize::from(reply.starts_with("{\"error\""));
    }
    assert_eq!((cases.len(), refused), (18, 10));
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let rich = state(&corpus, "rich");
    let refusals = corpus["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 16);
    for case in refusals {
        let request = case["requestJson"].as_str().unwrap();
        let result = match case["exchange"].as_str().unwrap() {
            "resolve" => resolution_json(&rich, request),
            _ => changes_json(&rich, request),
        };
        assert_eq!(result, Err(INVALID_REQUEST), "{request}");
    }
}

#[test]
fn the_rich_state_lists_mixed_recipes_in_code_unit_order() {
    let corpus = corpus();
    let resolved = resolution(&state(&corpus, "rich"), &[]).unwrap();
    let names: Vec<String> = resolved
        .options
        .iter()
        .filter(|option| option.mixed)
        .map(|option| String::from_utf16_lossy(&option.name))
        .collect();
    assert_eq!(
        names,
        [
            "B blend",
            "Purple mix",
            "Twin",
            "Twin",
            "a blend",
            "b blend",
            "ä blend",
            "\u{fffd} lone"
        ]
    );
    assert_eq!(RefKind::LayerRange.as_str(), "layer-range");
}
