//! The engine's own totals in a finished artifact, against the production
//! browser (`gcode-summary-vectors.json`, from `GcodeArtifactSummary.ts`):
//! every artifact summarized and worded exactly, and durations formatted.
use orcaxr_gcode::artifact::{ArtifactSummary, ToolUsage, describe, format_duration, summarize};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/gcode-summary-vectors.json"
    ))
    .unwrap()
}

/// The artifact's bytes, built from its parts as the generator built them.
fn bytes(parts: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        if let Some(text) = part["text"].as_str() {
            out.extend_from_slice(text.as_bytes());
        } else if let Some(text) = part["repeat"].as_str() {
            out.extend_from_slice(
                text.repeat(part["times"].as_u64().unwrap() as usize)
                    .as_bytes(),
            );
        } else if let Some(list) = part["repeatBytes"].as_array() {
            let unit: Vec<u8> = list.iter().map(|b| b.as_u64().unwrap() as u8).collect();
            for _ in 0..part["times"].as_u64().unwrap() {
                out.extend_from_slice(&unit);
            }
        } else {
            out.extend(
                part["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8),
            );
        }
    }
    out
}

/// A number as JavaScript writes it, with `-0` kept.
fn js(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".into()
    } else {
        ryu_js::Buffer::new().format(value).into()
    }
}

fn number(field: Option<f64>) -> Value {
    field.map_or(Value::Null, |value| Value::String(js(value)))
}

/// The summary in the corpus's own shape.
fn json(summary: &ArtifactSummary) -> Value {
    let tool = |tool: &ToolUsage| {
        let mut entry = serde_json::Map::new();
        entry.insert("toolIndex".into(), tool.tool_index.into());
        for (key, value) in [
            ("lengthMm", tool.length_mm),
            ("volumeCm3", tool.volume_cm3),
            ("weightG", tool.weight_g),
        ] {
            if value.is_some() {
                entry.insert(key.into(), number(value));
            }
        }
        for (key, value) in [("colorHex", &tool.color_hex), ("material", &tool.material)] {
            if let Some(value) = value {
                entry.insert(key.into(), value.clone().into());
            }
        }
        Value::Object(entry)
    };
    let mut out = serde_json::Map::new();
    out.insert("empty".into(), summary.empty.into());
    out.insert(
        "perTool".into(),
        summary.per_tool.iter().map(tool).collect::<Vec<_>>().into(),
    );
    for (key, value) in [
        ("totalWeightG", summary.total_weight_g),
        ("totalCost", summary.total_cost),
        ("toolChanges", summary.tool_changes),
        ("layerCount", summary.layer_count),
        ("estimatedSeconds", summary.estimated_seconds),
        ("firstLayerSeconds", summary.first_layer_seconds),
    ] {
        if value.is_some() {
            out.insert(key.into(), number(value));
        }
    }
    Value::Object(out)
}

#[test]
fn artifacts_summarize_and_read_as_the_browser_does() {
    let corpus = fixture();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 101);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let summary = summarize(&bytes(case["parts"].as_array().unwrap()));
        assert_eq!(json(&summary), case["summary"], "{name}");
        let description = describe(&summary);
        assert_eq!(
            description.totals,
            case["description"]["totals"].as_str().unwrap(),
            "{name}"
        );
        let tools = case["description"]["tools"].as_array().unwrap();
        assert_eq!(description.tools.len(), tools.len(), "{name}");
        for (line, expected) in description.tools.iter().zip(tools) {
            assert_eq!(
                u64::from(line.tool_index),
                expected["toolIndex"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                line.color_hex.as_deref(),
                expected["colorHex"].as_str(),
                "{name}"
            );
            assert_eq!(line.text, expected["text"].as_str().unwrap(), "{name}");
        }
    }
}

#[test]
fn durations_format_as_the_browser_does() {
    let corpus = fixture();
    for case in corpus["durations"].as_array().unwrap() {
        let seconds = case["seconds"].as_str().map(|text| match text {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => other.parse().unwrap(),
        });
        assert_eq!(
            format_duration(seconds),
            case["text"].as_str().unwrap(),
            "{seconds:?}"
        );
    }
}
