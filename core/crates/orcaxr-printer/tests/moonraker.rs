//! The Moonraker transport policy against the production browser
//! (`moonraker-policy-vectors.mjs`), byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::moonraker as m;
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn moonraker_policy_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/moonraker-policy-vectors.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    let mut check = |section: &str, answer: &dyn Fn(&str) -> String| {
        let cases = corpus[section].as_array().unwrap();
        for (i, case) in cases.iter().enumerate() {
            let request = text(&case["requestJson"]);
            let actual = answer(request);
            if actual != text(&case["replyJson"]) {
                failures.push(format!(
                    "{section} {i}: {request}\n  rust:    {actual}\n  browser: {}",
                    text(&case["replyJson"])
                ));
            }
        }
        cases.len()
    };
    let counts = [
        check("endpoints", &|r| {
            wire::encode_moonraker_endpoint_reply(&m::normalize_endpoint(
                &wire::decode_moonraker_endpoint_request(r).unwrap(),
            ))
            .unwrap()
        }),
        check("paths", &|r| {
            wire::encode_moonraker_path_reply(&m::join_path(
                &wire::decode_moonraker_path_request(r).unwrap(),
            ))
            .unwrap()
        }),
        check("credentials", &|r| {
            wire::encode_moonraker_credential_reply(&m::credential_check(
                &wire::decode_moonraker_credential_check(r).unwrap(),
            ))
            .unwrap()
        }),
        check("errors", &|r| {
            wire::encode_moonraker_transport_fault(&m::error_response(
                &wire::decode_moonraker_error_response(r).unwrap(),
            ))
            .unwrap()
        }),
        check("handshakes", &|r| {
            wire::encode_moonraker_handshake_reply(&m::handshake(
                &wire::decode_moonraker_handshake_request(r).unwrap(),
            ))
            .unwrap()
        }),
        check("policies", &|r| {
            wire::encode_moonraker_reconnect_policy_reply(&m::reconnect_policy(
                &wire::decode_moonraker_reconnect_policy_input(r).unwrap(),
            ))
            .unwrap()
        }),
        check("subscriptions", &|r| {
            wire::encode_moonraker_subscription_reply(&m::subscription_reply(
                &wire::decode_moonraker_object_subscription(r).unwrap(),
            ))
            .unwrap()
        }),
        check("methods", &|r| {
            wire::encode_moonraker_check_reply(&m::method_check(
                &wire::decode_moonraker_method_check(r).unwrap(),
            ))
            .unwrap()
        }),
    ];
    for (i, case) in corpus["delays"].as_array().unwrap().iter().enumerate() {
        let request =
            wire::decode_moonraker_reconnect_delay_request(text(&case["requestJson"])).unwrap();
        let delay = m::reconnect_delay(&request);
        if delay != case["delayMs"].as_f64().unwrap() {
            failures.push(format!(
                "delays {i}: {} → {delay}, browser {}",
                text(&case["requestJson"]),
                case["delayMs"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(counts, [85, 180, 14, 144, 44, 11, 14, 49]);
}
