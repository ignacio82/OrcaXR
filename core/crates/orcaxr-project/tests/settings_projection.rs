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

/// Settings sessions open the editor the browser's adapters open for every
/// node, and turn a commit into the browser's intent.
#[test]
fn settings_sessions_match_the_browser() {
    use orcaxr_contracts::project_intent_types as wire;
    use orcaxr_project::settings::{
        editor::{Mode, Requested},
        options::DEFINITIONS,
        presets::{AsciiRootCollation, NonAsciiText},
        session::SettingsSession,
    };
    let f = corpus();
    let snapshots: Vec<(String, orcaxr_project::store::ProjectSnapshot)> = f["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let state =
                ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap())
                    .unwrap();
            let store = ProjectStore::new(
                ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
            );
            (case["name"].as_str().unwrap().to_owned(), store.snapshot())
        })
        .collect();
    let id_of = |key: &str| DEFINITIONS.iter().find(|d| d.key == key).unwrap().id;
    let mut sessions = 0;
    for case in f["sessions"].as_array().unwrap() {
        let (_, snapshot) = snapshots
            .iter()
            .find(|(name, _)| name == case["state"].as_str().unwrap())
            .unwrap();
        let option = targets(snapshot.state())
            .into_iter()
            .find(|t| utf16(&t.id) == case["target"].as_str().unwrap())
            .unwrap();
        let mode = if case["mode"] == "simple" {
            Mode::Simple
        } else {
            Mode::Develop
        };
        let label = format!("{} {} {:?}", case["state"], case["target"], mode);
        let mut session =
            SettingsSession::open::<NonAsciiText>(snapshot, &option.target, mode, Requested::Fff)
                .unwrap();
        for step in case["steps"].as_array().unwrap() {
            let key = step["key"].as_str().unwrap();
            let result = session
                .editor
                .set_draft::<NonAsciiText>(id_of(key), &units(step["value"].as_str().unwrap()));
            match step["error"].as_str() {
                Some(message) => {
                    assert_eq!(utf16(&result.unwrap_err().message()), message, "{label}")
                }
                None => result.unwrap(),
            }
        }
        for state in case["states"].as_array().unwrap() {
            let s = session
                .editor
                .field_state::<NonAsciiText>(id_of(state["key"].as_str().unwrap()))
                .unwrap();
            assert_eq!(
                s.serialized.as_deref().map(utf16).as_deref(),
                state["serialized"].as_str(),
                "{label}"
            );
            assert_eq!(
                s.origin.as_str(),
                state["origin"].as_str().unwrap(),
                "{label}"
            );
        }
        let commit = session.editor.commit(&mut AsciiRootCollation).unwrap();
        assert_eq!(
            commit.changes.len() as u64,
            case["changes"].as_u64().unwrap(),
            "{label}"
        );
        let intent = session.binding.intent(&commit).unwrap();
        assert_eq!(
            wire::encode_intent(&intent).unwrap(),
            case["intentJson"].as_str().unwrap(),
            "{label}"
        );
        sessions += 1;
    }
    assert_eq!(sessions, 30);
}

/// The projection and session exchange answer with the browser's encodings,
/// as the bindings do.
#[test]
fn host_exchange_matches_the_browser_codecs() {
    use orcaxr_contracts::project_intent_types as wire;
    use orcaxr_project::settings::{
        editor::exchange::HostEditor,
        presets::{AsciiRootCollation, NonAsciiText},
        projection_exchange as p,
    };
    let f = corpus();
    let mut replies = 0;
    for case in f["states"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let state =
            ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let store = ProjectStore::new(
            ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
        );
        let snapshot = store.snapshot();
        let w = &case["wire"];
        let text = |v: &Json| v.as_str().unwrap().to_owned();
        for palette in w["palettes"].as_array().unwrap() {
            let request =
                wire::decode_paint_palette_request(&text(&palette["requestJson"])).unwrap();
            let p = orcaxr_project::facets::palette::project_palette(
                &snapshot.state().filaments,
                request.include_unavailable,
            );
            let reply = orcaxr_project::facets::palette::wire_palette(&p);
            assert_eq!(
                wire::encode_paint_palette(&reply).unwrap(),
                text(&palette["replyJson"]),
                "{name}"
            );
            replies += 1;
        }
        for page in w["pages"].as_array().unwrap() {
            let request =
                wire::decode_settings_target_page_request(&text(&page["requestJson"])).unwrap();
            let reply = p::target_page(&snapshot, &request).unwrap();
            assert_eq!(
                wire::encode_settings_target_page(&reply).unwrap(),
                text(&page["replyJson"]),
                "{name}"
            );
            replies += 1;
        }
        for kind in ["snapshots", "unknown"] {
            for s in w[kind].as_array().unwrap() {
                let request =
                    wire::decode_settings_target_request(&text(&s["requestJson"])).unwrap();
                let reply = p::snapshot(&snapshot, &request).unwrap();
                assert_eq!(
                    wire::encode_settings_snapshot_result(&reply).unwrap(),
                    text(&s["replyJson"]),
                    "{name}"
                );
                replies += 1;
            }
        }
        for e in w["explanations"].as_array().unwrap() {
            let request = wire::decode_settings_explain_request(&text(&e["requestJson"])).unwrap();
            let reply = p::explain(&snapshot, &request).unwrap();
            assert_eq!(
                wire::encode_settings_explain_result(&reply).unwrap(),
                text(&e["replyJson"]),
                "{name}"
            );
            replies += 1;
        }
        assert!(
            p::target_page(
                &snapshot,
                &wire::SettingsTargetPageRequest {
                    start: 0,
                    count: 65
                }
            )
            .is_err()
        );
        for session in f["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["state"] == name)
        {
            let request =
                wire::decode_settings_session_request(&text(&session["requestJson"])).unwrap();
            let mut editor = HostEditor::open::<NonAsciiText>(&snapshot, &request).unwrap();
            assert!(editor.intent().is_none());
            for step in session["steps"].as_array().unwrap() {
                let edit = wire::decode_editor_edit(&text(&step["editJson"])).unwrap();
                let reply = editor.edit::<NonAsciiText>(&edit);
                assert_eq!(
                    wire::encode_editor_edit_result(&reply).unwrap(),
                    text(&step["resultJson"])
                );
                replies += 1;
            }
            let commit = editor.commit(&mut AsciiRootCollation).unwrap();
            assert_eq!(
                wire::encode_editor_commit_result(&commit).unwrap(),
                text(&session["commitJson"])
            );
            let intent = editor.intent().unwrap();
            assert_eq!(
                wire::encode_intent(intent).unwrap(),
                text(&session["intentJson"])
            );
            replies += 2;
        }
    }
    println!("projection exchange: {replies} replies");
}

/// The loop closes natively: a node's editor commits, its intent executes in a
/// real session, and the node then stores exactly the committed overrides
/// while keeping the keys its scope does not own.
#[test]
fn session_intents_apply_in_a_native_session() {
    use orcaxr_contracts::project_intent_types as wire;
    use orcaxr_project::{
        assets::AssetRepository,
        history::HistoryOptions,
        selection::SelectionStore,
        session::{ProjectSession, Submission},
        settings::{
            editor::{Mode, Requested},
            options::DEFINITIONS,
            presets::{AsciiRootCollation, NonAsciiText},
            session::SettingsSession,
        },
    };
    let f = corpus();
    let asset = &f["assets"][0];
    let generation = [0, 1, 2147483648, 4294967295];
    let mut applied = 0;
    for session_case in f["sessions"].as_array().unwrap() {
        if session_case["mode"] != "develop" {
            continue;
        }
        let case = f["states"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == session_case["state"])
            .unwrap();
        let state =
            ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
        let mut assets = AssetRepository::new();
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &asset["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        let mut session = ProjectSession::new(
            project,
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions {
                max_entries: 16,
                max_estimated_bytes: 1 << 20,
            },
            generation,
        )
        .unwrap();
        let mut request_id = 0;
        let mut submit = |session: &mut ProjectSession<_>, operation: wire::SessionOperation| {
            request_id += 1;
            let request = wire::encode_session_request(&wire::SessionRequest {
                protocol_version: 1,
                generation: generation.iter().map(|g| u64::from(*g)).collect(),
                request_id,
                operation,
            })
            .unwrap();
            let wire_reply = match session.submit(&request) {
                Submission::Ready(response) => response.wire().to_owned(),
                // Queued work completes on the session's own turn.
                Submission::Queued { .. } => session.run_next().unwrap().wire().to_owned(),
            };
            wire::decode_session_reply(&wire_reply).unwrap().result
        };
        let ack = |result: wire::SessionResult| match result {
            wire::SessionResult::Acknowledged(ack) => ack,
            other => panic!("{other:?}"),
        };
        let welcome = submit(
            &mut session,
            wire::SessionOperation::Hello(wire::Hello {
                min_protocol_version: 1,
                max_protocol_version: 1,
                project_schema_version: 1,
                intent_version: 1,
            }),
        );
        assert!(
            matches!(welcome, wire::SessionResult::Welcome(_)),
            "{welcome:?}"
        );
        let guard = ack(submit(
            &mut session,
            wire::SessionOperation::Query(wire::Empty {}),
        ))
        .guard;
        let snapshot = session.snapshot();
        let option = targets(snapshot.state())
            .into_iter()
            .find(|t| utf16(&t.id) == session_case["target"].as_str().unwrap())
            .unwrap();
        let mut settings = SettingsSession::open::<NonAsciiText>(
            &snapshot,
            &option.target,
            Mode::Develop,
            Requested::Fff,
        )
        .unwrap();
        for step in session_case["steps"].as_array().unwrap() {
            let id = DEFINITIONS
                .iter()
                .find(|d| d.key == step["key"].as_str().unwrap())
                .unwrap()
                .id;
            let _ = settings
                .editor
                .set_draft::<NonAsciiText>(id, &units(step["value"].as_str().unwrap()));
        }
        let commit = settings.editor.commit(&mut AsciiRootCollation).unwrap();
        let intent = settings.binding.intent(&commit).unwrap();
        let ack = ack(submit(
            &mut session,
            wire::SessionOperation::Execute(wire::GuardedIntent { guard, intent }),
        ));
        assert_eq!(
            ack.changed,
            !commit.changes.is_empty(),
            "{}",
            session_case["target"]
        );
        let after = session.snapshot();
        let node = scoped::snapshot(&after, &option.target).unwrap();
        let before = scoped::snapshot(&snapshot, &option.target).unwrap();
        // The node's in-scope overrides are the commit's; foreign keys stay.
        let expected: Json = serde_json::from_str(&canonical(
            &orcaxr_project::settings::options::apply_settings_commit(
                // The project panel commits over the raw overrides, foreign
                // keys included; a node over its in-scope overrides.
                &if matches!(option.target, Target::Project) {
                    project_overrides(&snapshot).overrides
                } else {
                    before.overrides.clone()
                },
                &commit
                    .changes
                    .iter()
                    .map(|c| match c {
                        orcaxr_project::settings::editor::Change::Set {
                            key, serialized, ..
                        } => orcaxr_project::settings::options::Change::Set {
                            key: units(key),
                            serialized: Some(serialized.clone()),
                        },
                        orcaxr_project::settings::editor::Change::Remove { key, .. } => {
                            orcaxr_project::settings::options::Change::Remove { key: units(key) }
                        }
                    })
                    .collect::<Vec<_>>(),
            )
            .map(Value::Object)
            .unwrap(),
        ))
        .unwrap();
        if matches!(option.target, Target::Project) {
            let project = project_overrides(&after);
            assert_eq!(
                serde_json::from_str::<Json>(&canonical(&config(&project.overrides))).unwrap(),
                expected
            );
        } else {
            assert_eq!(
                serde_json::from_str::<Json>(&canonical(&config(&node.overrides))).unwrap(),
                expected
            );
            assert_eq!(
                canonical(&config(&node.foreign)),
                canonical(&config(&before.foreign))
            );
        }
        applied += 1;
    }
    assert_eq!(applied, 15);
}
