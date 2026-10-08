use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{model::JsonObject, settings::options::*};
use std::collections::BTreeSet;

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/settings-codec-vectors.json"
    ))
    .unwrap()
}
fn embedded(f: &serde_json::Value, key: &str) -> Value {
    parse(f[key].as_str().unwrap()).unwrap()
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
    let Value::Object(fields) = value else {
        panic!("object")
    };
    &fields[&units(name)]
}
fn array(value: &Value) -> &[Value] {
    let Value::Array(items) = value else {
        panic!("array")
    };
    items
}
fn text(value: &Value) -> &[u16] {
    let Value::String(units) = value else {
        panic!("string")
    };
    units
}
fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn issues(issues: &[Issue]) -> Value {
    Value::Array(
        issues
            .iter()
            .map(|i| {
                object([
                    ("code", Value::String(units(i.code))),
                    ("path", Value::String(units(&i.path))),
                    ("message", Value::String(i.message.clone())),
                ])
            })
            .collect(),
    )
}
fn definition(id: &[u16]) -> &'static Definition {
    DEFINITIONS
        .iter()
        .find(|d| d.id.encode_utf16().eq(id.iter().copied()))
        .expect("generated definition")
}

#[test]
fn every_storage_contract_matches_the_browser_codec() {
    let f = corpus();
    let contracts = embedded(&f, "contractsJson");
    assert_eq!(DEFINITIONS.len() as u64, f["definitions"].as_u64().unwrap());
    let ids: BTreeSet<_> = DEFINITIONS.iter().map(|d| d.id).collect();
    assert_eq!(ids.len(), DEFINITIONS.len());
    for d in DEFINITIONS {
        let expected = match field(&contracts, d.id) {
            Value::Null => None,
            value => Some(String::from_utf16(text(value)).unwrap()),
        };
        assert_eq!(contract_issue(d).map(str::to_owned), expected, "{}", d.id);
    }
    assert_eq!(SCHEMA_VERSION, 2);
    assert_eq!(SCHEMA_SHA256.len(), 64);
}

#[test]
fn drafts_values_and_serialization_match_the_browser_codec() {
    let f = corpus();
    let (mut drafts, mut values) = (0, 0);
    for json in f["codecJsons"].as_array().unwrap() {
        let case = &parse(json.as_str().unwrap()).unwrap();
        let d = definition(text(field(case, "id")));
        let choices = Value::Array(
            enum_choices(d)
                .map(|(serialized, label)| {
                    object([
                        ("serialized", Value::String(units(serialized))),
                        ("label", Value::String(units(label))),
                    ])
                })
                .collect(),
        );
        assert_eq!(
            canonical(&choices),
            canonical(field(case, "choices")),
            "{}",
            d.id
        );
        for draft in array(field(case, "drafts")) {
            let raw = text(field(draft, "raw"));
            let actual = match parse_setting_draft(d, raw) {
                Ok(parsed) => object([
                    ("ok", Value::Bool(true)),
                    ("value", parsed.value.to_value()),
                    ("serialized", Value::String(parsed.serialized)),
                ]),
                Err(found) => object([("ok", Value::Bool(false)), ("issues", issues(&found))]),
            };
            assert_eq!(
                canonical(&actual),
                canonical(field(draft, "result")),
                "{} draft {:?}",
                d.id,
                String::from_utf16_lossy(raw)
            );
            drafts += 1;
        }
        for entry in array(field(case, "values")) {
            let value = option_value(field(entry, "value")).expect("engine option value");
            assert_eq!(
                canonical(&issues(&validate_setting_value(d, &value))),
                canonical(field(entry, "issues")),
                "{} value {}",
                d.id,
                canonical(field(entry, "value"))
            );
            let serialized = match serialize_setting_value(d, &value) {
                Ok(text) => object([("ok", Value::String(text))]),
                Err(found) => object([("error", Value::String(joined(&found)))]),
            };
            assert_eq!(
                canonical(&serialized),
                canonical(field(entry, "serialized")),
                "{} serialize {}",
                d.id,
                canonical(field(entry, "value"))
            );
            values += 1;
        }
    }
    assert_eq!(drafts + values, 13191);
}

#[test]
fn configuration_decoding_matches_the_browser_bridge() {
    let f = corpus();
    for case in array(&embedded(&f, "decodedJson")) {
        let config = JsonObject::new(field(case, "config").clone()).unwrap();
        let decoded = decode_settings_config(&config);
        let actual = object([
            (
                "values",
                Value::Object(
                    decoded
                        .values
                        .iter()
                        .map(|(k, v)| (k.clone(), v.to_value()))
                        .collect(),
                ),
            ),
            (
                "diagnostics",
                Value::Array(
                    decoded
                        .diagnostics
                        .iter()
                        .map(|d| {
                            object([
                                ("key", Value::String(d.key.clone())),
                                ("code", Value::String(units(d.code))),
                                ("message", Value::String(d.message.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "unknownKeys",
                Value::Array(
                    decoded
                        .unknown_keys
                        .iter()
                        .map(|k| Value::String(k.clone()))
                        .collect(),
                ),
            ),
        ]);
        assert_eq!(
            canonical(&actual),
            canonical(field(case, "result")),
            "{}",
            String::from_utf16_lossy(text(field(case, "name")))
        );
    }
}

#[test]
fn settings_commits_match_the_browser_bridge() {
    let f = corpus();
    for case in array(&embedded(&f, "commitsJson")) {
        let previous = JsonObject::new(field(case, "previous").clone()).unwrap();
        let changes: Vec<Change> = array(field(case, "changes"))
            .iter()
            .map(|c| {
                let key = text(field(c, "key")).to_vec();
                if text(field(c, "action")) == units("remove").as_slice() {
                    Change::Remove { key }
                } else {
                    let Value::Object(fields) = c else {
                        unreachable!()
                    };
                    Change::Set {
                        key,
                        serialized: fields.get(&units("serialized")).map(|v| text(v).to_vec()),
                    }
                }
            })
            .collect();
        let actual = match apply_settings_commit(&previous, &changes) {
            Ok(next) => object([("ok", Value::Object(next))]),
            Err(error) => object([("error", Value::String(error.message()))]),
        };
        assert_eq!(canonical(&actual), canonical(field(case, "result")));
    }
}
