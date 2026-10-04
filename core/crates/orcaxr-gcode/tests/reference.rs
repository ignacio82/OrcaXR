use orcaxr_gcode::{Model, Options, index, parse, parse_window};
use serde_json::{Value, json};
use std::sync::Arc;

fn snapshot(model: &Model) -> Value {
    let mut value = serde_json::to_value(model).unwrap();
    macro_rules! floats { ($($field:ident => $name:literal),* $(,)?) => {$(
        value["columns"][$name] = json!({"$f32": model.columns.$field.iter().map(|value| value.to_bits()).collect::<Vec<_>>()});
    )*}; }
    floats!(start_x => "startX", start_y => "startY", start_z => "startZ", end_x => "endX", end_y => "endY", end_z => "endZ",
        delta_e => "deltaE", feedrate_mm_per_second => "feedrateMmPerSecond", width_mm => "widthMm", height_mm => "heightMm",
        mm3_per_mm => "mm3PerMm", volumetric_flow_mm3_per_second => "volumetricFlowMm3PerSecond", fan_percent => "fanPercent",
        hotend_temperature_c => "hotendTemperatureC", arc_center_x => "arcCenterX", arc_center_y => "arcCenterY");
    for (name, points) in [
        ("x", &model.path_points.x),
        ("y", &model.path_points.y),
        ("z", &model.path_points.z),
    ] {
        value["pathPoints"][name] =
            json!({"$f32": points.iter().map(|value| value.to_bits()).collect::<Vec<_>>()});
    }
    value
}

fn equal(actual: &Value, expected: &Value, path: &str) {
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

#[test]
fn matches_production_parser_index_and_each_window() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/gcode-vectors.json"
    ))
    .unwrap();
    for vector in corpus["vectors"].as_array().unwrap() {
        let id = vector["id"].as_str().unwrap();
        let source: Arc<[u16]> = serde_json::from_value::<Vec<u16>>(vector["sourceUnits"].clone())
            .unwrap()
            .into();
        let options: Options = serde_json::from_value(vector["options"].clone()).unwrap();
        equal(
            &snapshot(&parse(&source, &options).unwrap()),
            &vector["model"],
            &format!("{id}.model"),
        );
        let index = index(source, &options).unwrap();
        equal(
            &serde_json::to_value(&index).unwrap(),
            &vector["index"],
            &format!("{id}.index"),
        );
        for (entry, window) in vector["windows"].as_array().unwrap().iter().enumerate() {
            equal(
                &snapshot(&parse_window(&index, entry as isize, entry as isize, &options).unwrap()),
                window,
                &format!("{id}.window[{entry}]"),
            );
        }
    }
}
