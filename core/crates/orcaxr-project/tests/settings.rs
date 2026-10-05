use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ids::*,
    model::{ConfigMap, Decode, Encode, ProjectState, Text},
    settings::*,
};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;

fn fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/settings-resolution-vectors.json"
    ))
    .unwrap()
}
fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn utf16(value: &Json) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit.as_u64().unwrap() as u16)
        .collect()
}
fn string(value: &str) -> Value {
    Value::String(units(value))
}
fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn canonical(value: &Value) -> String {
    let mut out = vec![];
    value.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn encoded(value: &impl Encode) -> String {
    let mut out = vec![];
    value.write_json(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn issue(issue: &ScopeIssue) -> Value {
    object([
        ("code", string(issue.code.as_str())),
        ("path", issue.path.to_value().unwrap()),
        ("scope", issue.scope.to_value().unwrap()),
        ("key", issue.key.to_value().unwrap()),
        ("message", issue.message.to_value().unwrap()),
    ])
}
fn issues(values: &[ScopeIssue]) -> Value {
    Value::Array(values.iter().map(issue).collect())
}
struct Layer {
    scope: Text,
    id: Option<Text>,
    overrides: ConfigMap,
}
fn layers(source: &str) -> Vec<Layer> {
    let Value::Array(values) = parse(source).unwrap() else {
        panic!()
    };
    values
        .into_iter()
        .map(|value| {
            let Value::Object(mut fields) = value else {
                panic!()
            };
            Layer {
                scope: Text::from_value(fields.remove(&units("scope")).unwrap()).unwrap(),
                id: fields
                    .remove(&units("id"))
                    .map(|value| Text::from_value(value).unwrap()),
                overrides: ConfigMap::from_value(fields.remove(&units("overrides")).unwrap())
                    .unwrap(),
            }
        })
        .collect()
}
fn explain(value: SettingResolution<'_>) -> Value {
    let mut fields = BTreeMap::from([
        (units("key"), value.key.to_value().unwrap()),
        (
            units("source"),
            string(value.source.map(SettingScope::as_str).unwrap_or("base")),
        ),
        (
            units("shadowed"),
            Value::Array(
                value
                    .shadowed
                    .iter()
                    .map(|entry| {
                        let mut fields = BTreeMap::from([
                            (units("scope"), string(entry.scope.as_str())),
                            (units("value"), entry.value.clone()),
                        ]);
                        if let Some(id) = entry.id {
                            fields.insert(units("id"), id.to_value().unwrap());
                        }
                        Value::Object(fields)
                    })
                    .collect(),
            ),
        ),
    ]);
    if let Some(v) = value.value {
        fields.insert(units("value"), v.clone());
    }
    if let Some(id) = value.source_id {
        fields.insert(units("sourceId"), id.to_value().unwrap());
    }
    Value::Object(fields)
}
#[test]
fn scope_provenance_and_every_known_and_unknown_key_match_the_browser() {
    let fixture = fixture();
    assert_eq!(SOURCE_COMMIT, fixture["source"]["commit"]);
    assert_eq!(SOURCE_DIGEST, fixture["source"]["digest"]);
    assert_eq!(
        json!(
            SOURCE_FILES
                .iter()
                .map(|(path, blob)| json!({"path":path,"blob":blob}))
                .collect::<Vec<_>>()
        ),
        fixture["source"]["files"]
    );
    assert_eq!(
        SCOPE_ORDER
            .iter()
            .map(|scope| scope.as_str())
            .collect::<Vec<_>>(),
        ["project", "plate", "object", "part", "layerRange"]
    );
    for entry in fixture["membership"].as_array().unwrap() {
        let key = utf16(&entry["keyUtf16"]);
        let allowed: Vec<_> = scopes_for_setting(&key).map(SettingScope::as_str).collect();
        assert_eq!(json!(allowed), entry["scopes"]);
        assert_eq!(
            json!(narrowest_scope_for_setting(&key).map(SettingScope::as_str)),
            entry["narrowest"]
        );
    }
}
#[test]
fn strict_layer_validation_resolution_and_explanations_match_independent_reference() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().unwrap() {
        let base =
            ConfigMap::from_value(parse(case["baseJson"].as_str().unwrap()).unwrap()).unwrap();
        let owned = layers(case["layersJson"].as_str().unwrap());
        let layers: Vec<_> = owned
            .iter()
            .map(|layer| ScopedOverrideLayer {
                scope: &layer.scope,
                id: layer.id.as_ref(),
                overrides: &layer.overrides,
            })
            .collect();
        let actual = validate_scoped_overrides(&layers);
        assert_eq!(
            canonical(&issues(&actual)),
            case["issuesJson"],
            "{}",
            case["name"]
        );
        let resolved = resolve_scoped_config(&base, &layers);
        if case["resolvedJson"].is_null() {
            let rejected = resolved.unwrap_err();
            assert_eq!(rejected.issues, actual);
            assert_eq!(
                canonical(&object([
                    ("name", string(ScopeError::NAME)),
                    ("message", rejected.message().to_value().unwrap())
                ])),
                case["errorJson"]
            );
            let key = Text::from_utf8("wall_loops");
            let Err(explanation) = explain_setting(&base, &layers, &key) else {
                panic!("invalid layers accepted")
            };
            assert_eq!(explanation.issues, actual);
            assert_eq!(
                scoped_config_bytes(&base, &layers).unwrap_err().issues,
                actual
            );
        } else {
            let resolved = resolved.unwrap();
            assert_eq!(encoded(&resolved), case["resolvedJson"]);
            assert_eq!(
                canonical(&resolved.to_value().unwrap()),
                case["resolvedJson"]
            );
            assert_eq!(
                scoped_config_bytes(&base, &layers).unwrap(),
                case["resolvedJson"]
            );
            for query in case["explanations"].as_array().unwrap() {
                let key = Text::new(utf16(&query["keyUtf16"]));
                assert_eq!(
                    canonical(&explain(explain_setting(&base, &layers, &key).unwrap())),
                    query["resultJson"],
                    "{}",
                    case["name"]
                );
            }
        }
        assert_eq!(encoded(&base), case["baseJson"]);
    }
}
#[test]
fn import_sanitization_reports_every_removed_value_in_canonical_order() {
    let fixture = fixture();
    for case in fixture["sanitize"].as_array().unwrap() {
        let scope = SettingScope::from_utf16(&units(case["scope"].as_str().unwrap())).unwrap();
        let id = (!case["idUtf16"].is_null()).then(|| Text::new(utf16(&case["idUtf16"])));
        let config =
            ConfigMap::from_value(parse(case["overridesJson"].as_str().unwrap()).unwrap()).unwrap();
        let result = sanitize_scoped_overrides(scope, &config, id.as_ref());
        assert_eq!(
            canonical(&object([
                ("overrides", result.overrides.to_value().unwrap()),
                ("removed", issues(&result.removed))
            ])),
            case["resultJson"]
        );
        assert_eq!(encoded(&config), case["overridesJson"]);
    }
}
fn scope_ref(scope: ConfigScopeRef<'_>) -> Value {
    let mut fields = BTreeMap::from([(units("kind"), string(scope.kind()))]);
    if let Some(id) = scope.id() {
        fields.insert(units("id"), Value::String(id.to_vec()));
    }
    Value::Object(fields)
}
fn result(result: ResolvedConfig<'_>) -> Value {
    object([
        ("effective", result.effective.to_value().unwrap()),
        ("inherited", result.inherited.to_value().unwrap()),
        ("local", result.local.to_value().unwrap()),
        (
            "sourceByKey",
            Value::Object(
                result
                    .source_by_key
                    .into_iter()
                    .map(|(key, scope)| (key.to_vec(), scope_ref(scope)))
                    .collect(),
            ),
        ),
        (
            "ignored",
            Value::Array(
                result
                    .ignored
                    .into_iter()
                    .map(|entry| {
                        object([
                            ("key", Value::String(entry.key.to_vec())),
                            ("scope", scope_ref(entry.scope)),
                            ("reason", entry.reason.to_value().unwrap()),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}
fn take_id<K>(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str) -> Option<EntityId<K>> {
    fields
        .remove(&units(key))
        .map(|value| EntityId::from_value(value).unwrap())
}
#[test]
fn project_queries_preserve_engine_precedence_inheritance_diagnostics_and_parent_errors() {
    let fixture = fixture();
    for case in fixture["graph"].as_array().unwrap() {
        let state =
            ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        for query in case["queries"].as_array().unwrap() {
            let Value::Object(mut fields) = parse(query["requestJson"].as_str().unwrap()).unwrap()
            else {
                panic!()
            };
            let plate = take_id(&mut fields, "plateId").unwrap();
            let object_id = take_id(&mut fields, "objectId");
            let volume = take_id(&mut fields, "volumeId");
            let range = take_id(&mut fields, "layerRangeId");
            let resolved = resolve_config(
                &state,
                ConfigResolutionRequest {
                    plate_id: &plate,
                    object_id: object_id.as_ref(),
                    volume_id: volume.as_ref(),
                    layer_range_id: range.as_ref(),
                },
            );
            let actual = match resolved {
                Ok(v) => object([("value", result(v))]),
                Err(error) => {
                    assert!(!format!("{error:?}").contains("absent"));
                    object([("error", error.message().to_value().unwrap())])
                }
            };
            assert_eq!(canonical(&actual), query["resultJson"], "{}", case["name"]);
        }
        assert_eq!(encoded(&state), case["stateJson"]);
    }
}
#[test]
fn views_borrow_original_values_and_mutable_exports_cannot_change_the_source() {
    let base = ConfigMap::from_value(
        parse(r#"{"notes":{"__proto__":{"private":"data"}},"wall_loops":1}"#).unwrap(),
    )
    .unwrap();
    let override_value = ConfigMap::from_value(parse(r#"{"wall_loops":[3,4]}"#).unwrap()).unwrap();
    let scope = Text::from_utf8("object");
    let layers = [ScopedOverrideLayer {
        scope: &scope,
        id: None,
        overrides: &override_value,
    }];
    let resolved = resolve_scoped_config(&base, &layers).unwrap();
    let Value::Object(base_fields) = base.value() else {
        panic!()
    };
    let Value::Object(override_fields) = override_value.value() else {
        panic!()
    };
    assert!(std::ptr::eq(
        resolved.get(&units("notes")).unwrap(),
        base_fields.get(&units("notes")).unwrap()
    ));
    assert!(std::ptr::eq(
        resolved.get(&units("wall_loops")).unwrap(),
        override_fields.get(&units("wall_loops")).unwrap()
    ));
    let Value::Object(mut exported) = resolved.to_value().unwrap() else {
        panic!()
    };
    exported.insert(units("notes"), Value::Null);
    assert_eq!(
        encoded(&base),
        r#"{"notes":{"__proto__":{"private":"data"}},"wall_loops":1}"#
    );
    assert!(!format!("{resolved:?}").contains("private"));
}
