use orcaxr_contracts::evaluate;
use serde_json::{Value, json};

#[test]
fn raw_request_envelopes_match_the_shared_transport_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/canonical-requests.json"
    ))
    .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let encoded = evaluate(case["request"].as_str().unwrap());
        let result: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(result["type"], case["type"], "{}", case["id"]);
        assert_eq!(result["requestId"], case["requestId"], "{}", case["id"]);
        if case["type"] == "canonicalized" {
            assert_eq!(result["canonical"], case["canonical"], "{}", case["id"]);
        } else {
            assert_eq!(result["error"]["code"], case["code"], "{}", case["id"]);
            assert!(!encoded.contains("PRIVATE_MARKER"));
        }
    }
}

#[test]
fn matches_independent_typescript_vectors() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/canonical-vectors.json"
    ))
    .unwrap();
    for vector in corpus["vectors"].as_array().unwrap() {
        let response: Value = serde_json::from_str(&evaluate(&json!({
            "protocolVersion": 1, "requestId": vector["id"], "operation": "canonicalize", "input": vector["input"],
        }).to_string())).unwrap();
        assert_eq!(response["type"], "canonicalized", "{}", vector["id"]);
        for field in ["canonical", "semanticHash", "sha256"] {
            assert_eq!(response[field], vector[field], "{}: {field}", vector["id"]);
        }
    }
    for vector in corpus["invalid"].as_array().unwrap() {
        let response: Value = serde_json::from_str(&evaluate(&json!({
            "protocolVersion": 1, "requestId": vector["id"], "operation": "canonicalize", "input": vector["input"],
        }).to_string())).unwrap();
        assert_eq!(response["error"]["code"], vector["code"]);
    }
}

#[test]
fn rejects_unknown_protocol_invalid_envelopes_and_resource_exhaustion() {
    for request in [
        json!({"protocolVersion": 2, "requestId": "test", "operation": "canonicalize", "input": "{}"}),
        json!({"protocolVersion": 1, "requestId": "test", "operation": "unknown", "input": "{}"}),
        json!({"protocolVersion": 1, "requestId": "test", "operation": "canonicalize", "input": "{}", "unexpected": true}),
        json!({"protocolVersion": 1, "requestId": "private secret", "operation": "canonicalize", "input": "{}"}),
        json!({"protocolVersion": 1, "requestId": "test", "operation": "canonicalize", "input": " ".repeat(1_048_577)}),
    ] {
        let response: Value = serde_json::from_str(&evaluate(&request.to_string())).unwrap();
        assert_eq!(response["type"], "error");
        assert!(!response.to_string().contains("private secret"));
    }
}

#[test]
fn validates_protocol_numbers_by_value_without_integer_truncation() {
    for (version, expected) in [
        ("1.0", "canonicalized"),
        ("1e0", "canonicalized"),
        ("1.5", "error"),
        ("true", "error"),
    ] {
        let response: Value = serde_json::from_str(&evaluate(&format!(
            r#"{{"protocolVersion":{version},"requestId":"version","operation":"canonicalize","input":"null"}}"#
        ))).unwrap();
        assert_eq!(response["type"], expected);
    }
}

#[test]
fn shares_strict_request_id_rules_with_hosts() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/request-ids.json"
    ))
    .unwrap();
    for kind in ["valid", "invalid"] {
        for id in corpus[kind].as_array().unwrap() {
            let response: Value = serde_json::from_str(&evaluate(&json!({
                "protocolVersion": 1, "requestId": id, "operation": "canonicalize", "input": "null",
            }).to_string())).unwrap();
            assert_eq!(response["type"] == "canonicalized", kind == "valid", "{id}");
        }
    }
}
