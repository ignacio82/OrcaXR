use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ids::{LayerRangeId, ObjectId, PlateId, VolumeId},
    model::*,
    settings::scoped::{self, Target, explain, project_overrides, targets},
    store::ProjectStore,
    validation::*,
};
use serde_json::Value as Json;
use std::collections::BTreeMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/settings-projection-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn utf16(units: &[u16]) -> String {
    String::from_utf16(units).unwrap()
}
fn string(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (units(k), v)))
            .collect::<BTreeMap<_, _>>(),
    )
}
fn config(map: &ConfigMap) -> Value {
    map.value().clone()
}

fn target(scope: &str, id: Option<&str>) -> Target {
    let id = id.unwrap_or("");
    match scope {
        "project" => Target::Project,
        "plate" => Target::Plate(PlateId::try_from_str(id).unwrap()),
        "object" => Target::Object(ObjectId::try_from_str(id).unwrap()),
        "part" => Target::Part(VolumeId::try_from_str(id).unwrap()),
        "layerRange" => Target::LayerRange(LayerRangeId::try_from_str(id).unwrap()),
        other => panic!("{other}"),
    }
}

#[test]
fn settings_projection_matches_the_browser() {
    let f = corpus();
    let keys: Vec<Text> = f["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| Text::from_utf8(k.as_str().unwrap()))
        .collect();
    let mut checked = 0;
    for case in f["states"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let state =
            ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let store = ProjectStore::new(
            ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
        );
        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.revision(),
            case["revision"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(snapshot.hash(), case["hash"].as_str().unwrap(), "{name}");

        let p = project_overrides(&snapshot);
        let project = object(vec![
            (
                "sourceRevision",
                Some(Value::Number(p.source_revision as f64)),
            ),
            ("sourceHash", Some(string(&units(&p.source_hash)))),
            ("inheritedConfig", Some(config(&p.inherited_config))),
            ("overrides", Some(config(&p.overrides))),
            ("effectiveConfig", Some(config(&p.effective_config))),
        ]);
        assert_eq!(
            canonical(&project),
            case["projectJson"].as_str().unwrap(),
            "{name}"
        );

        let options = targets(snapshot.state());
        let expected = case["targets"].as_array().unwrap();
        assert_eq!(options.len(), expected.len(), "{name}");
        for (option, e) in options.iter().zip(expected) {
            let label = format!("{name} {}", e["id"].as_str().unwrap());
            assert_eq!(utf16(&option.id), e["id"].as_str().unwrap());
            assert_eq!(option.target.scope().as_str(), e["scope"].as_str().unwrap());
            assert_eq!(
                option.target.id().map(utf16).as_deref(),
                e["targetId"].as_str(),
                "{label}"
            );
            assert_eq!(
                utf16(&option.label),
                e["label"].as_str().unwrap(),
                "{label}"
            );
            assert_eq!(utf16(&option.path), e["path"].as_str().unwrap(), "{label}");
            assert_eq!(
                option.override_count as u64,
                e["overrideCount"].as_u64().unwrap(),
                "{label}"
            );

            let s = scoped::snapshot(&snapshot, &option.target).unwrap();
            let issues = Value::Array(
                s.foreign_issues
                    .iter()
                    .map(|i| {
                        object(vec![
                            ("code", Some(string(&units(i.code.as_str())))),
                            ("path", Some(string(i.path.units()))),
                            ("scope", Some(string(i.scope.units()))),
                            ("key", Some(string(i.key.units()))),
                            ("message", Some(string(i.message.units()))),
                        ])
                    })
                    .collect(),
            );
            let chain = Value::Array(
                s.chain
                    .iter()
                    .map(|c| {
                        object(vec![
                            ("scope", Some(string(&units(c.scope.as_str())))),
                            ("id", c.id.as_ref().map(|id| string(id.units()))),
                            ("label", Some(string(&c.label))),
                            ("overrides", Some(config(&c.overrides))),
                            ("isTarget", Some(Value::Bool(c.is_target))),
                        ])
                    })
                    .collect(),
            );
            let actual = object(vec![
                (
                    "sourceRevision",
                    Some(Value::Number(s.source_revision as f64)),
                ),
                ("sourceHash", Some(string(&units(&s.source_hash)))),
                ("label", Some(string(&s.label))),
                ("overrides", Some(config(&s.overrides))),
                ("foreign", Some(config(&s.foreign))),
                ("foreignIssues", Some(issues)),
                ("chain", Some(chain)),
                ("inheritedConfig", Some(config(&s.inherited_config))),
                ("effectiveConfig", Some(config(&s.effective_config))),
            ]);
            assert_eq!(
                canonical(&actual),
                e["snapshotJson"].as_str().unwrap(),
                "{label}"
            );

            let explanations = Value::Array(
                keys.iter()
                    .map(|key| {
                        let r = explain(&s, snapshot.state(), key);
                        object(vec![
                            ("key", Some(string(key.units()))),
                            ("value", r.value),
                            (
                                "source",
                                Some(string(&units(
                                    r.source.map_or("base", |scope| scope.as_str()),
                                ))),
                            ),
                            ("sourceId", r.source_id.map(|id| string(id.units()))),
                            (
                                "shadowed",
                                Some(Value::Array(
                                    r.shadowed
                                        .iter()
                                        .map(|(scope, id, value)| {
                                            object(vec![
                                                ("scope", Some(string(&units(scope.as_str())))),
                                                ("id", id.as_ref().map(|id| string(id.units()))),
                                                ("value", Some(value.clone())),
                                            ])
                                        })
                                        .collect(),
                                )),
                            ),
                        ])
                    })
                    .collect(),
            );
            assert_eq!(
                canonical(&explanations),
                e["explanationsJson"].as_str().unwrap(),
                "{label}"
            );
            checked += 1;
        }
        for unknown in case["unknown"].as_array().unwrap() {
            let t = target(
                unknown["scope"].as_str().unwrap(),
                unknown["targetId"].as_str(),
            );
            let error = scoped::snapshot(&snapshot, &t).unwrap_err();
            assert_eq!(
                utf16(&error.message()),
                unknown["message"].as_str().unwrap()
            );
        }
    }
    assert_eq!(checked, 17);
}
