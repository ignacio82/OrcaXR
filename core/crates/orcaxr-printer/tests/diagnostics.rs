//! File → Export Diagnostics… (`diagnostics-vectors.json`, from the browser's
//! `diagnosticsExchange.ts`): every bundle's file, preview and kept entries,
//! every recorded event and the facts a bundle states, byte for byte; every
//! malformed request refused.
use orcaxr_printer::diagnostics;
use serde_json::Value as Json;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/diagnostics-vectors.json"
    ))
    .unwrap()
}

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn every_bundle_and_event_is_the_browsers() {
    let fixture = corpus();
    for case in fixture["bundles"].as_array().unwrap() {
        let reply = diagnostics::bundle_json(text(&case["requestJson"])).unwrap();
        assert_eq!(reply, text(&case["replyJson"]), "{}", case["name"]);
    }
    for request in fixture["bundleRefusals"].as_array().unwrap() {
        assert_eq!(
            diagnostics::bundle_json(text(request)),
            Err(diagnostics::INVALID_REQUEST),
            "{request}"
        );
    }
    for case in fixture["entries"].as_array().unwrap() {
        let reply = diagnostics::entry_json(text(&case["requestJson"])).unwrap();
        assert_eq!(reply, text(&case["replyJson"]), "{}", case["requestJson"]);
    }
    for request in fixture["entryRefusals"].as_array().unwrap() {
        assert_eq!(
            diagnostics::entry_json(text(request)),
            Err(diagnostics::INVALID_REQUEST),
            "{request}"
        );
    }
    assert_eq!(diagnostics::facts_json(), text(&fixture["factsJson"]));
    assert_eq!(
        (
            fixture["bundles"].as_array().unwrap().len(),
            fixture["entries"].as_array().unwrap().len()
        ),
        (12, 11)
    );
}
