//! Native G-code document windows and search against independent
//! production-browser expectations (tools/cross-platform/gcode-document-vectors.mjs).
use orcaxr_gcode::{
    Cancellation,
    document::{Document, WindowLimits},
};
use serde_json::Value;

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
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        other => panic!("number expected, got {other}"),
    }
}

#[test]
fn document_windows_and_search_match_production_browser() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/gcode-document-vectors.json"
    ))
    .unwrap();
    let limits = WindowLimits {
        lines: 64,
        units: 1 << 20,
    };
    let cancellation = Cancellation::default();
    let (mut windows, mut searches) = (0, 0);
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let document = Document::new(units(&case["source"]).into(), &cancellation).unwrap();
        assert_eq!(
            document.line_count() as u64,
            case["lineCount"].as_u64().unwrap(),
            "{name}"
        );
        for window in case["windows"].as_array().unwrap() {
            let lines = document
                .window(number(&window["from"]), number(&window["count"]), limits)
                .unwrap();
            let expected = window["lines"].as_array().unwrap();
            assert_eq!(lines.len(), expected.len(), "{name} {window}");
            for (line, expected) in lines.iter().zip(expected) {
                assert_eq!(line.number as u64, expected["number"].as_u64().unwrap());
                assert_eq!(
                    line.text,
                    units(&expected["text"]),
                    "{name} line {}",
                    line.number
                );
            }
            windows += 1;
        }
        for search in case["searches"].as_array().unwrap() {
            let query = units(&search["query"]);
            let limit = search["limit"].as_u64().unwrap() as usize;
            let result = document.search(&query, limit, &cancellation).unwrap();
            let expected: Vec<usize> = search["lineNumbers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as usize)
                .collect();
            assert_eq!(
                result.line_numbers, expected,
                "{name} {query:x?} limit {limit}"
            );
            assert_eq!(
                result.truncated,
                search["truncated"].as_bool().unwrap(),
                "{name} {query:x?}"
            );
            searches += 1;
        }
    }
    assert_eq!((windows, searches), (1536, 18710));
}
