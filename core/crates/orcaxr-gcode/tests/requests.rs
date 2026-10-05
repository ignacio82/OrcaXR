use orcaxr_gcode::{Cancellation, Session, SessionError, request_types};
use serde_json::Value;

#[test]
fn generated_shapes_and_actual_sessions_follow_independent_contract_vectors() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/request-vectors.json"
    ))
    .unwrap();
    let source: Vec<u16> = corpus["source"].as_str().unwrap().encode_utf16().collect();
    for case in corpus["vectors"].as_array().unwrap() {
        let json = case["json"].as_str().unwrap();
        let options = case["kind"] == "Options";
        let shape_valid = if options {
            serde_json::from_str::<request_types::Options>(json).is_ok()
        } else {
            serde_json::from_str::<request_types::Request>(json).is_ok()
        };
        assert_eq!(
            shape_valid,
            case["shapeValid"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
        let result = if options {
            Session::new(0, json, Cancellation::default()).map(|_| ())
        } else {
            let mut session = Session::new(source.len(), "{}", Cancellation::default()).unwrap();
            session.append(0, &source).unwrap();
            session.seal().unwrap();
            session.view(json).map(|_| ())
        };
        assert_eq!(
            result.err().map_or("ok", SessionError::code),
            case["result"].as_str().unwrap(),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn generated_objects_reject_duplicate_keys_including_nullable_fields() {
    for json in [
        r#"{"limits":{},"limits":{}}"#,
        r#"{"limits":{"records":null,"records":2}}"#,
    ] {
        assert!(matches!(
            Session::new(0, json, Cancellation::default()),
            Err(SessionError::InvalidOptions)
        ));
    }
    for json in [
        r#"{"version":1,"operation":"inspection","window":[],"request":{"currentRecord":null,"currentRecord":1}}"#,
        r#"{"version":1,"operation":"inspection","window":[],"request":{},"request":{}}"#,
        r#"{"version":1,"version":1,"operation":"inspection","window":[],"request":{}}"#,
    ] {
        assert!(serde_json::from_str::<request_types::Request>(json).is_err());
    }
}
