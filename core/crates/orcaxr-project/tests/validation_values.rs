use orcaxr_project::model::Number;
use orcaxr_project::validation::{layer_event_height_key, timestamp};
use serde_json::Value;
use std::cell::Cell;
use timestamp::V8IntegerMode::{Smi31, Smi32};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/validation-value-vectors.json"
    ))
    .unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
        .collect()
}
fn number(value: &Value) -> Number {
    Number::new(f64::from_bits(
        u64::from_str_radix(value.as_str().unwrap(), 16).unwrap(),
    ))
    .unwrap()
}
fn parsed(text: &str) -> Option<timestamp::Timestamp> {
    timestamp::parse(&text.encode_utf16().collect::<Vec<_>>(), Smi32)
}

#[test]
fn matches_node_and_chromium_date_parse_in_three_fixed_timezones() {
    let data = fixture();
    let zones = data["zones"].as_array().unwrap();
    for case in data["timestamps"].as_array().unwrap() {
        let input = units(&case["units"]);
        for (mode, field) in [(Smi31, "smi31"), (Smi32, "smi32")] {
            for (i, zone) in zones.iter().enumerate() {
                let actual = timestamp::parse(&input, mode).and_then(|v| {
                    v.resolve(|local| {
                        Ok::<_, ()>(local.civil_milliseconds() - zone["eastMs"].as_i64().unwrap())
                    })
                    .unwrap()
                });
                assert_eq!(
                    actual,
                    case[field][i].as_i64(),
                    "{} / {field} / {}",
                    case["name"],
                    zone["name"]
                );
            }
        }
    }
}

#[test]
fn delegates_normalized_local_time_and_preserves_host_dst_and_history_results() {
    let data = fixture();
    for case in data["localTimes"].as_array().unwrap() {
        let input = units(&case["units"]);
        for (mode, field) in [(Smi31, "smi31"), (Smi32, "smi32")] {
            let parsed = timestamp::parse(&input, mode).unwrap();
            assert_eq!(
                parsed.local().unwrap().civil_milliseconds(),
                case["civil"].as_i64().unwrap()
            );
            for zone in case["zones"].as_array().unwrap() {
                let calls = Cell::new(0);
                // This is an oracle-backed host adapter, not a Rust timezone
                // implementation. Verify the input and preserve its exact result.
                let actual = parsed
                    .resolve(|local| {
                        calls.set(calls.get() + 1);
                        assert_eq!(local.civil_milliseconds(), case["civil"].as_i64().unwrap());
                        Ok::<_, ()>(zone[field].as_i64().unwrap())
                    })
                    .unwrap();
                assert_eq!(calls.get(), 1);
                assert_eq!(actual, zone[field].as_i64());
            }
        }
    }
}

#[test]
fn resolver_errors_never_become_invalid_data_or_an_implicit_utc_fallback() {
    let local = parsed("2026-10-05T12:00:00").unwrap();
    assert_eq!(
        local.resolve(|_| Err::<i64, _>("timezone unavailable")),
        Err("timezone unavailable")
    );
    for text in ["2026-10-05", "2026-10-05T12:00:00Z", "Jan 1 1970 GMT"] {
        let absolute = parsed(text).unwrap();
        assert_eq!(absolute.local(), None);
        assert!(
            absolute
                .resolve::<()>(|_| panic!("absolute date invoked timezone service"))
                .unwrap()
                .is_some()
        );
    }
    assert!(parsed("not a date").is_none());
    assert!(parsed("+275761-01-01T00:00:00").is_none());
    assert_eq!(local.resolve(|_| Ok::<_, ()>(i64::MIN)), Ok(None));
    assert_eq!(local.resolve(|_| Ok::<_, ()>(i64::MAX)), Ok(None));
}

#[test]
fn clips_after_local_conversion_but_rejects_an_out_of_range_explicit_utc_date() {
    let max = 8_640_000_000_000_000i64;
    let local = parsed("+275760-09-13T00:00:00.001").unwrap();
    assert_eq!(local.local().unwrap().civil_milliseconds(), max + 1);
    assert_eq!(
        local.resolve(|v| Ok::<_, ()>(v.civil_milliseconds())),
        Ok(None)
    );
    assert_eq!(
        local.resolve(|v| Ok::<_, ()>(v.civil_milliseconds() - 1)),
        Ok(Some(max))
    );
    assert!(parsed("+275760-09-13T00:00:00.001Z").is_none());
    let local = parsed("-271821-04-19T23:59:59.999").unwrap();
    assert_eq!(local.local().unwrap().civil_milliseconds(), -max - 1);
    assert_eq!(
        local.resolve(|v| Ok::<_, ()>(v.civil_milliseconds() + 1)),
        Ok(Some(-max))
    );
    let text = "Jan 1 1970 GMT+500000:00"
        .encode_utf16()
        .collect::<Vec<_>>();
    assert!(timestamp::parse(&text, Smi31).is_none());
    assert_eq!(
        timestamp::parse(&text, Smi32)
            .unwrap()
            .resolve::<()>(|_| panic!())
            .unwrap(),
        Some(-1_800_000_000_000)
    );
}

#[test]
fn exact_fixed_four_decimal_keys_match_both_javascript_engines() {
    let data = fixture();
    for case in data["heights"].as_array().unwrap() {
        assert_eq!(
            layer_event_height_key(number(&case[0])),
            case[1],
            "bits {}",
            case[0]
        );
    }
    for case in data["collisions"].as_array().unwrap() {
        assert_eq!(
            layer_event_height_key(number(&case[0])) == layer_event_height_key(number(&case[1])),
            case[2].as_bool().unwrap()
        );
    }
}

#[test]
fn no_input_length_or_recursion_limit_is_inherited_from_transport() {
    let mut input = vec![0x20; 300_000];
    input.extend(std::iter::repeat_n(0x28, 300_000));
    input.extend(std::iter::repeat_n(0x29, 300_000));
    input.extend("Jan 1 2000 GMT".encode_utf16());
    assert_eq!(
        timestamp::parse(&input, Smi32)
            .unwrap()
            .resolve::<()>(|_| panic!())
            .unwrap(),
        Some(946_684_800_000)
    );
    input.extend([0, 0xd800, b')' as u16]);
    assert_eq!(
        timestamp::parse(&input, Smi32)
            .unwrap()
            .resolve::<()>(|_| panic!())
            .unwrap(),
        Some(946_684_800_000)
    );
}
