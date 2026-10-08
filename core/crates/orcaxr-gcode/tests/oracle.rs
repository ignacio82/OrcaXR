//! Independent expectations: hand-written outcomes for malformed numbers,
//! over-long lines, truncated and rejected arcs, invalid commands, letters
//! outside ASCII, every cap, BOM/CRLF and modal kinematics, which the
//! browser parser met when they were written and the Rust parser must meet
//! too; and the UTF-8 decode native hosts use, against Node's WHATWG
//! decoder, whole and streamed in the recorded chunks.
use orcaxr_gcode::{Options, Utf8Decoder, decode_utf8, parse};
use serde_json::{Value, json};

const KINDS: [&str; 14] = [
    "noop",
    "retract",
    "unretract",
    "reserved-seam",
    "tool-change",
    "color-change",
    "pause",
    "custom",
    "travel",
    "wipe",
    "extrude",
    "layer-change",
    "wipe-start",
    "wipe-end",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/gcode-oracle-vectors.json"
    ))
    .unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}

/// What the expectations name: warnings, records, layers, lines, the end.
fn summary(case: &Value) -> Value {
    let options: Options = serde_json::from_value(case["options"].clone()).unwrap();
    let model = parse(&units(&case["gcode"]), &options).unwrap();
    let c = &model.columns;
    let records: Vec<Value> = (0..c.count)
        .map(|i| {
            json!([
                KINDS[c.kind[i] as usize],
                f64::from(c.end_x[i]),
                f64::from(c.end_y[i]),
                f64::from(c.end_z[i]),
                f64::from(c.delta_e[i]),
                c.source_line[i]
            ])
        })
        .collect();
    json!({
        "warnings": model.warnings.iter().map(|w| json!([w.code, w.severity, w.line])).collect::<Vec<_>>(),
        "records": records,
        "layerCount": model.layer_count,
        "parsedLines": model.parsed_lines,
        "complete": model.complete,
        "termination": model.termination_reason.map(|t| serde_json::to_value(t).unwrap()),
    })
}

/// JSON spells 0 and 0.0 differently; the expectations mean the number.
fn numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers).collect()),
        Value::Object(fields) => {
            Value::Object(fields.into_iter().map(|(k, v)| (k, numbers(v))).collect())
        }
        other => other,
    }
}

#[test]
fn the_parser_meets_the_hand_written_expectations() {
    let f = fixture();
    let cases = f["oracle"].as_array().unwrap();
    for case in cases {
        let actual = summary(case);
        assert_eq!(
            numbers(actual),
            numbers(case["expected"].clone()),
            "{}",
            case["name"]
        );
    }
    assert_eq!(cases.len(), 13);
}

#[test]
fn fuzzed_documents_parse_as_the_browser_parses_them() {
    let f = fixture();
    let documents = f["fuzz"].as_array().unwrap();
    for (i, document) in documents.iter().enumerate() {
        assert_eq!(
            numbers(summary(document)),
            numbers(document["expected"].clone()),
            "document {i}: {:?}",
            String::from_utf16_lossy(&units(&document["gcode"]))
        );
    }
    assert_eq!(documents.len(), 400);
}

#[test]
fn utf8_decodes_as_the_browser_does_however_it_is_split() {
    let f = fixture();
    let decodes = f["utf8"].as_array().unwrap();
    for (i, case) in decodes.iter().enumerate() {
        let bytes: Vec<u8> = case["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();
        let expected = units(&case["units"]);
        assert_eq!(decode_utf8(&bytes), expected, "case {i}");
        let mut decoder = Utf8Decoder::new();
        let mut streamed = Vec::new();
        let mut from = 0;
        for split in case["splits"].as_array().unwrap() {
            let at = split.as_u64().unwrap() as usize;
            decoder.decode(&bytes[from..at], false, &mut streamed);
            from = at;
        }
        decoder.decode(&bytes[from..], true, &mut streamed);
        assert_eq!(streamed, expected, "case {i} streamed");
        // One byte at a time is the hardest split.
        let mut decoder = Utf8Decoder::new();
        let mut bytewise = Vec::new();
        for byte in &bytes {
            decoder.decode(std::slice::from_ref(byte), false, &mut bytewise);
        }
        decoder.decode(&[], true, &mut bytewise);
        assert_eq!(bytewise, expected, "case {i} bytewise");
    }
    assert_eq!(decodes.len(), 319);
}
