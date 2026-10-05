use orcaxr_contracts::{project_intent_types::*, project_intents::InvalidIntent};
use serde_json::Value;

#[test]
fn decodes_and_reencodes_shared_corpus() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-intent-vectors.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let raw = case["input"].as_str().unwrap();
        let decoded = if case["kind"] == "SessionRequest" {
            decode_session_request(raw).and_then(|value| encode_session_request(&value))
        } else if case["kind"] == "SessionReply" {
            decode_session_reply(raw).and_then(|value| encode_session_reply(&value))
        } else if case["kind"] == "Batch" {
            decode_batch(raw).and_then(|value| encode_batch(&value))
        } else {
            decode_intent(raw).and_then(|value| encode_intent(&value))
        };
        if case["expected"].is_null() {
            assert_eq!(decoded, Err(InvalidIntent), "{}", case["label"]);
        } else {
            let output: Value =
                serde_json::from_str(&decoded.unwrap_or_else(|_| panic!("{}", case["label"])))
                    .unwrap();
            assert!(equivalent(&output, &case["expected"]), "{}", case["label"]);
        }
    }
}

#[test]
fn rejects_resource_limits_before_unbounded_conversion_and_recovers() {
    let valid = r#"{"version":1,"command":{"deletePlate":{"plateId":[65]}}}"#;
    assert!(decode_intent(valid).is_ok());
    assert_eq!(
        decode_intent(&" ".repeat(MAX_BYTES + 1)),
        Err(InvalidIntent)
    );
    let nodes = format!(
        r#"{{"version":1,"command":{{"deletePlate":{{"plateId":[{}]}}}}}}"#,
        vec!["65"; MAX_NODES].join(",")
    );
    assert!(nodes.len() < MAX_BYTES);
    assert_eq!(decode_intent(&nodes), Err(InvalidIntent));
    let bytes = Intent {
        version: 1,
        command: Command::AddPlate(AddPlate {
            plate_id: vec![65],
            name: vec![65],
            order: f64::INFINITY,
            activate: true,
        }),
    };
    assert_eq!(encode_intent(&bytes), Err(InvalidIntent));
    assert!(decode_intent(valid).is_ok());
    assert_eq!(InvalidIntent.to_string(), "Invalid project command intent");
}

#[test]
fn preserves_every_utf16_unit_and_bounds_typed_output() {
    let intent = Intent {
        version: 1,
        command: Command::DeletePlate(DeletePlate {
            plate_id: (0..=u16::MAX).collect(),
        }),
    };
    assert_eq!(
        decode_intent(&encode_intent(&intent).unwrap()).unwrap(),
        intent
    );
    let too_many = Intent {
        version: 1,
        command: Command::DeletePlate(DeletePlate {
            plate_id: vec![65; MAX_NODES],
        }),
    };
    assert_eq!(encode_intent(&too_many), Err(InvalidIntent));
    let wide = Intent {
        version: 1,
        command: Command::DuplicatePlate(DuplicatePlate {
            source_plate_id: vec![65],
            plate_id: vec![65],
            custom_gcode_ids: vec![],
            thumbnail_ids: vec![],
            objects: vec![
                DuplicateObject {
                    object_id: vec![65],
                    volume_ids: vec![],
                    instance_ids: vec![],
                    layer_range_ids: vec![]
                };
                18000
            ],
        }),
    };
    assert_eq!(encode_intent(&wide), Err(InvalidIntent));
}

fn equivalent(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| equivalent(value, other)))
        }
        _ => left == right,
    }
}
