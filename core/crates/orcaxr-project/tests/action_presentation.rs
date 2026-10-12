//! How the shells arrange catalogue actions, against the browser
//! (`action-presentation-vectors.json`): the command palette's search over
//! every language's catalogue and the case-mapping edge cases, a context
//! menu's sections and the toolbar's runs, byte for byte, and the malformed
//! requests refused.
use orcaxr_project::action_presentation::{INVALID_REQUEST, groups_json, palette_json};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/action-presentation-vectors.json"
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
fn the_palette_finds_what_the_browser_finds() {
    let corpus = corpus();
    let catalogues: Vec<&str> = corpus["catalogues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["actions"].as_str().unwrap())
        .collect();
    assert_eq!(catalogues.len(), 21);
    let cases = corpus["palette"].as_array().unwrap();
    assert_eq!(cases.len(), 1827);
    for case in cases {
        let actions = catalogues[case["catalogue"].as_u64().unwrap() as usize];
        let query = case["query"].as_str().unwrap();
        let request = format!("{{\"actions\":{actions},\"query\":{query}}}");
        assert_eq!(
            palette_json(&request).unwrap(),
            case["reply"].as_str().unwrap(),
            "{query}"
        );
    }
}

#[test]
fn menus_and_the_toolbar_are_arranged_as_the_browser_arranges_them() {
    let corpus = corpus();
    let cases = corpus["groups"].as_array().unwrap();
    assert_eq!(cases.len(), 92);
    for case in cases {
        let request = case["request"].as_str().unwrap();
        assert_eq!(
            groups_json(request).unwrap(),
            case["reply"].as_str().unwrap(),
            "{request}"
        );
    }
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let refusals = corpus["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 23);
    for refusal in refusals {
        let request = refusal["request"].as_str().unwrap();
        let answer = match refusal["exchange"].as_str().unwrap() {
            "palette" => palette_json(request),
            _ => groups_json(request),
        };
        assert_eq!(answer, Err(INVALID_REQUEST), "{request}");
    }
}
