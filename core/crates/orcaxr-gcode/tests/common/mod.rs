use orcaxr_gcode::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub fn read<T: DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap()
}
pub fn floats(v: &Value) -> Vec<f32> {
    read::<Vec<u32>>(&v["$f32"])
        .into_iter()
        .map(f32::from_bits)
        .collect()
}
pub fn bits(v: &[f32]) -> Value {
    json!({"$f32": v.iter().map(|n| n.to_bits()).collect::<Vec<_>>()})
}
pub fn model(v: &Value) -> Model {
    let c = &v["columns"];
    let mut columns = Columns {
        count: read(&c["count"]),
        ..Default::default()
    };
    macro_rules! fields {($decode:ident; $($field:ident => $name:literal),* $(,)?) => {$(columns.$field = $decode(&c[$name]);)*};}
    fields!(floats; start_x => "startX", start_y => "startY", start_z => "startZ", end_x => "endX", end_y => "endY", end_z => "endZ",
        delta_e => "deltaE", feedrate_mm_per_second => "feedrateMmPerSecond", width_mm => "widthMm", height_mm => "heightMm",
        mm3_per_mm => "mm3PerMm", volumetric_flow_mm3_per_second => "volumetricFlowMm3PerSecond", fan_percent => "fanPercent",
        hotend_temperature_c => "hotendTemperatureC", arc_center_x => "arcCenterX", arc_center_y => "arcCenterY");
    fields!(read; kind => "kind", layer => "layer", role => "role", tool => "tool", filament => "filament", source_line => "sourceLine",
        source_start_offset => "sourceStartOffset", source_end_offset => "sourceEndOffset", command_line_number => "commandLineNumber",
        path_kind => "pathKind", path_point_offset => "pathPointOffset", path_point_count => "pathPointCount");
    let path = &v["pathPoints"];
    Model {
        columns,
        path_points: PathPoints {
            count: read(&path["count"]),
            x: floats(&path["x"]),
            y: floats(&path["y"]),
            z: floats(&path["z"]),
        },
        roles: read(&v["roles"]),
        filaments: v["filaments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| Filament {
                id: read(&f["id"]),
                tool: read(&f["tool"]),
                color: read(&f["color"]),
                source: match f["source"].as_str().unwrap() {
                    "tool" => "tool",
                    "color-change" => "color-change",
                    other => panic!("unmapped source {other}"),
                },
            })
            .collect(),
        record_offset: read(&v["recordOffset"]),
        layer_count: read(&v["layerCount"]),
        // Neither preview nor inspection consumes parser diagnostics. Keep input
        // fixtures intact, but don't duplicate the parser's string-enum decoder.
        warnings: vec![],
        source_length: read(&v["sourceLength"]),
        parsed_characters: read(&v["parsedCharacters"]),
        source_line_offset: read(&v["sourceLineOffset"]),
        parsed_lines: read(&v["parsedLines"]),
        complete: read(&v["complete"]),
        termination_reason: match v["terminationReason"].as_str() {
            None => None,
            Some("input-cap") => Some(Termination::InputCap),
            Some("line-cap") => Some(Termination::LineCap),
            Some("record-cap") => Some(Termination::RecordCap),
            Some("path-point-cap") => Some(Termination::PathPointCap),
            Some("numeric-cap") => Some(Termination::NumericCap),
            Some("index-cap") => Some(Termination::IndexCap),
            Some(other) => panic!("unknown termination {other}"),
        },
        limits: read(&v["limits"]),
    }
}
pub fn equal(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}.length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equal(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path} keys"
            );
            for (key, a) in a {
                equal(a, &b[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
