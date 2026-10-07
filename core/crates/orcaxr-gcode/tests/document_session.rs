//! The G-code session's text transport replays the independent browser document
//! corpus: chunked UTF-16 input, sealing, JSON windows and bounded search.
use orcaxr_gcode::{Cancellation, Session, SessionError, layout};
use serde_json::{Value, json};

fn units(value: &Value) -> Vec<u16> {
    match value {
        Value::String(text) => text.encode_utf16().collect(),
        Value::Array(list) => list.iter().map(|u| u.as_u64().unwrap() as u16).collect(),
        other => panic!("text expected, got {other}"),
    }
}
fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        other => panic!("number expected, got {other}"),
    }
}
fn open(source: &[u16]) -> Session {
    let mut session = Session::new(source.len(), "{}", Cancellation::default()).unwrap();
    // Odd chunks split surrogate pairs and lines across appends.
    for (i, chunk) in source.chunks(4093).enumerate() {
        session.append(i * 4093, chunk).unwrap();
    }
    session.seal().unwrap();
    session
}

#[test]
fn session_text_transport_matches_production_browser_documents() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/gcode-document-vectors.json"
    ))
    .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut session = open(&units(&case["source"]));
        for window in case["windows"].as_array().unwrap() {
            let reply: Value = serde_json::from_str(
                &session
                    .text_window(number(&window["from"]), number(&window["count"]))
                    .unwrap(),
            )
            .unwrap();
            let lines: Vec<Value> = window["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| json!({"number": l["number"], "text": units(&l["text"])}))
                .collect();
            assert_eq!(
                reply,
                json!({"lineCount": case["lineCount"], "lines": lines}),
                "{name} {window}"
            );
        }
        for search in case["searches"].as_array().unwrap() {
            let limit = search["limit"].as_u64().unwrap() as usize;
            let reply: Value = serde_json::from_str(
                &session
                    .text_search(&units(&search["query"]), limit)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                reply,
                json!({"lineNumbers": search["lineNumbers"], "truncated": search["truncated"]}),
                "{name}"
            );
        }
    }
}

#[test]
fn session_text_requests_are_bounded_and_require_a_sealed_source() {
    let source: Vec<u16> = "G1 X1\n".repeat(2_000).encode_utf16().collect();
    let mut unsealed = Session::new(source.len(), "{}", Cancellation::default()).unwrap();
    assert_eq!(
        unsealed.text_window(1.0, 1.0),
        Err(SessionError::InvalidState)
    );
    assert_eq!(
        unsealed.text_search(&[0x47], 1),
        Err(SessionError::InvalidState)
    );
    let mut session = open(&source);
    assert_eq!(
        session.text_window(1.0, (layout::MAX_TEXT_WINDOW_LINES + 1) as f64),
        Err(SessionError::ResourceLimit)
    );
    assert!(
        session
            .text_window(1.0, layout::MAX_TEXT_WINDOW_LINES as f64)
            .is_ok()
    );
    assert_eq!(
        session.text_search(&[0x47], layout::MAX_SEARCH_LIMIT + 1),
        Err(SessionError::ResourceLimit)
    );
    assert_eq!(
        session.text_search(&vec![0x47; layout::MAX_QUERY_UNITS + 1], 1),
        Err(SessionError::ResourceLimit)
    );
    let reply: Value =
        serde_json::from_str(&session.text_search(&[0x67, 0x31], 2_000).unwrap()).unwrap();
    assert_eq!(reply["lineNumbers"].as_array().unwrap().len(), 2_000);
    assert_eq!(reply["truncated"], false, "exactly the limit is complete");
    // A long line is refused rather than allocating beyond the unit budget.
    let long: Vec<u16> = format!("; {}\n", "x".repeat(layout::MAX_TEXT_WINDOW_UNITS))
        .encode_utf16()
        .collect();
    let mut session = open(&long);
    assert_eq!(
        session.text_window(1.0, 1.0),
        Err(SessionError::ResourceLimit)
    );
    let cancellation = Cancellation::default();
    let mut cancelled = Session::new(source.len(), "{}", cancellation.clone()).unwrap();
    cancelled.append(0, &source).unwrap();
    cancelled.seal().unwrap();
    cancellation.cancel();
    assert_eq!(
        cancelled.text_window(1.0, 1.0),
        Err(SessionError::Cancelled)
    );
    assert_eq!(
        cancelled.text_search(&[0x47], 1),
        Err(SessionError::Cancelled)
    );
}
