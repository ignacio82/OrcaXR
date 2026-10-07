use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::*, history::*, ids::*, model::*, selection::*, session::*, store::*, validation::*,
};
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-session-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn text(v: &Value) -> Text {
    Text::new(
        v.as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect::<Vec<_>>(),
    )
}
fn reference(v: &Value) -> SelectionRef {
    let id = || text(&v["id"]).units().to_vec();
    match v["kind"].as_str().unwrap() {
        "project" => SelectionRef::Project,
        "plate" => SelectionRef::Plate(PlateId::try_from_utf16(id()).unwrap()),
        "object" => SelectionRef::Object(ObjectId::try_from_utf16(id()).unwrap()),
        "volume" => SelectionRef::Volume(VolumeId::try_from_utf16(id()).unwrap()),
        "instance" => SelectionRef::Instance(InstanceId::try_from_utf16(id()).unwrap()),
        "layer-range" => SelectionRef::LayerRange(LayerRangeId::try_from_utf16(id()).unwrap()),
        "filament" => SelectionRef::Filament(FilamentId::try_from_utf16(id()).unwrap()),
        _ => panic!(),
    }
}
fn encode_ref(r: &SelectionRef) -> Value {
    let (kind, id) = match r {
        SelectionRef::Project => return json!({"kind":"project"}),
        SelectionRef::Plate(id) => ("plate", id.as_utf16()),
        SelectionRef::Object(id) => ("object", id.as_utf16()),
        SelectionRef::Volume(id) => ("volume", id.as_utf16()),
        SelectionRef::Instance(id) => ("instance", id.as_utf16()),
        SelectionRef::LayerRange(id) => ("layer-range", id.as_utf16()),
        SelectionRef::Filament(id) => ("filament", id.as_utf16()),
    };
    json!({"kind":kind,"id":id})
}
fn selection_value(s: &SelectionSnapshot) -> Value {
    json!({"refs":s.refs().iter().map(encode_ref).collect::<Vec<_>>(),"primary":s.primary().map(encode_ref)})
}
fn state_json(s: &ProjectState) -> String {
    let mut bytes = vec![];
    s.write_json(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
struct Recorder<'a> {
    contents: &'a [Value],
}
impl Recorder<'_> {
    fn snapshot(&self, snapshot: &ProjectSnapshot) -> Value {
        let text = state_json(snapshot.state());
        let content = self
            .contents
            .iter()
            .position(|v| v.as_str() == Some(&text))
            .expect("complete reference content");
        json!({"revision":snapshot.revision(),"hash":snapshot.hash(),"content":content})
    }
    fn effect(&self, event: &DomainEvent) -> Value {
        match event {
            DomainEvent::Project(c) => {
                json!({"kind":"project","previous":self.snapshot(c.previous()),"current":self.snapshot(c.current()),"reason":c.reason().units(),"dirtyCategories":c.dirty_categories()})
            }
            DomainEvent::Selection(c) => {
                json!({"kind":"selection","previous":selection_value(c.previous()),"current":selection_value(c.current())})
            }
            DomainEvent::History { previous, current } => {
                json!({"kind":"history","previous":history_value(previous),"current":history_value(current)})
            }
        }
    }
    fn observe<P: TimestampPolicy>(&self, bus: &ProjectSession<P>) -> Value {
        json!({"snapshot":self.snapshot(&bus.snapshot()),"selection":selection_value(&bus.selection()),"history":history_value(&bus.history()),"historyRevision":bus.history_revision(),"assets":bus.assets().bundle_fingerprint()})
    }
}
fn history_value(h: &HistorySnapshot) -> Value {
    json!({"undoCount":h.undo_count,"redoCount":h.redo_count,"undoLabel":h.undo_label.as_ref().map(Text::units),"redoLabel":h.redo_label.as_ref().map(Text::units),"dirtyCategories":h.dirty_categories.as_ref()})
}
fn session(trace: &Value) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let state =
        ProjectState::from_value(parse(trace["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(trace["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &trace["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: trace["options"]["maxEntries"].as_u64().unwrap_or(100) as usize,
            max_estimated_bytes: trace["options"]["maxEstimatedBytes"]
                .as_u64()
                .unwrap_or(32 * 1024 * 1024),
        },
        [0, 1, 2147483648, 4294967295],
    )
    .unwrap()
}
#[test]
fn owned_session_matches_typescript_queue_protocol_commands_and_effects() {
    let f = fixture();
    let recorder = Recorder {
        contents: f["contents"].as_array().unwrap(),
    };
    let mut groups = 0;
    let mut requests = 0;
    for trace in f["traces"].as_array().unwrap() {
        let mut session = session(trace);
        let initial_assets = session.assets().capture_internal();
        let asset = session
            .assets()
            .peek(&session.snapshot().state().source_assets[0].id)
            .unwrap();
        assert_eq!(recorder.observe(&session), trace["initial"]);
        let mut retained = vec![];
        let mut saved = std::collections::BTreeMap::new();
        for (index, group) in trace["steps"].as_array().unwrap().iter().enumerate() {
            groups += 1;
            retained.push((session.snapshot(), state_json(session.snapshot().state())));
            let mut effects = vec![];
            let mut replies = vec![];
            let mut pending = std::collections::BTreeMap::new();
            for request in group["requests"].as_array().unwrap() {
                requests += 1;
                let slot = replies.len();
                replies.push(Value::Null);
                match session.submit(request.as_str().unwrap()) {
                    Submission::Ready(response) => {
                        effects.extend(response.events().iter().map(|e| recorder.effect(e)));
                        replies[slot] = serde_json::from_str(response.wire()).unwrap();
                    }
                    Submission::Queued { request_id } => {
                        assert!(pending.insert(request_id, slot).is_none());
                    }
                }
            }
            let mut host_outcomes = vec![];
            for op in group["host"].as_array().unwrap() {
                let mut host_outcome = Value::Null;
                match op["kind"].as_str().unwrap() {
                    "checkpoint" => {
                        let guard = session.capture_guard().unwrap();
                        effects.extend(
                            session
                                .acknowledge_checkpoint(&guard)
                                .unwrap()
                                .iter()
                                .map(|e| recorder.effect(e)),
                        );
                    }
                    "selection" => {
                        let guard = session.capture_guard().unwrap();
                        let refs = op["refs"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(reference)
                            .collect::<Vec<_>>();
                        if let Some(c) = session.select(&guard, &refs, None).unwrap() {
                            effects.push(recorder.effect(&DomainEvent::Selection(c)));
                        }
                    }
                    "captureSave" => {
                        saved.insert(
                            op["name"].as_str().unwrap(),
                            session.capture_guard().unwrap(),
                        );
                    }
                    "saveCheckpoint" => {
                        match session.acknowledge_checkpoint(&saved[op["name"].as_str().unwrap()]) {
                            Ok(changes) => {
                                effects.extend(changes.iter().map(|e| recorder.effect(e)));
                                host_outcome = json!("saved");
                            }
                            Err(orcaxr_contracts::project_intent_types::SessionError::Stale) => {
                                host_outcome = json!("stale")
                            }
                            Err(e) => panic!("unexpected save acknowledgement failure: {e:?}"),
                        }
                    }
                    "dispose" => session.dispose(),
                    _ => panic!("unknown host operation"),
                }
                host_outcomes.push(host_outcome);
            }
            while let Some(response) = session.run_next() {
                let value: Value = serde_json::from_str(response.wire()).unwrap();
                let slot = pending
                    .remove(&value["requestId"].as_u64().unwrap())
                    .expect("queued response has one owner");
                effects.extend(response.events().iter().map(|e| recorder.effect(e)));
                replies[slot] = value;
            }
            assert!(pending.is_empty());
            assert_eq!(session.pending_count(), 0);
            let mut actual = recorder.observe(&session);
            actual["requests"] = group["requests"].clone();
            actual["host"] = group["host"].clone();
            actual["hostOutcomes"] = json!(host_outcomes);
            actual["replies"] = json!(replies);
            actual["effects"] = json!(effects);
            assert_eq!(&actual, group, "{} group {index}", trace["name"]);
            assert!(
                session
                    .assets()
                    .capture_internal()
                    .same_version(&initial_assets)
            );
            assert!(
                session
                    .assets()
                    .peek(asset.id())
                    .unwrap()
                    .same_record(&asset)
            );
            for (snapshot, content) in &retained {
                assert_eq!(state_json(snapshot.state()), *content);
            }
        }
        // The lease outlives the session with the trace's exact bytes.
        drop(session);
        assert_eq!(
            asset.bytes().len(),
            trace["asset"]["bytes"].as_array().unwrap().len()
        );
    }
    assert_eq!((groups, requests), (1905, 1970));
}
#[test]
fn local_guards_are_owner_bound_and_checkpoints_invalidate_old_work() {
    let f = fixture();
    let mut a = session(&f["traces"][0]);
    let mut b = session(&f["traces"][0]);
    let guard = a.capture_guard().unwrap();
    assert!(a.is_current(&guard));
    assert!(!b.is_current(&guard));
    assert!(matches!(
        b.acknowledge_checkpoint(&guard),
        Err(orcaxr_contracts::project_intent_types::SessionError::Stale)
    ));
    assert!(matches!(
        b.select(&guard, &[SelectionRef::Project], None),
        Err(orcaxr_contracts::project_intent_types::SessionError::Stale)
    ));
    assert!(a.acknowledge_checkpoint(&guard).unwrap().is_empty());
    assert!(!a.is_current(&guard));
    assert!(a.is_export_current(&guard));
    assert!(a.acknowledge_checkpoint(&guard).unwrap().is_empty());
    let current = a.capture_guard().unwrap();
    a.select(&current, &[SelectionRef::Project], None).unwrap();
    assert!(a.is_current(&current));
    a.dispose();
    assert!(!a.is_current(&current));
    assert!(a.capture_guard().is_err());
    assert!(matches!(
        a.acknowledge_checkpoint(&current),
        Err(orcaxr_contracts::project_intent_types::SessionError::Disposed)
    ));
    assert!(matches!(
        a.select(&current, &[], None),
        Err(orcaxr_contracts::project_intent_types::SessionError::Disposed)
    ));
}

#[test]
fn bundle_admission_matches_reference_without_publishing_an_invalid_authority() {
    let f = fixture();
    for case in f["bundles"].as_array().unwrap() {
        let state =
            ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
        let mut assets = AssetRepository::new();
        for asset in case["assets"].as_array().unwrap() {
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
        }
        let actual = match ProjectSession::new(
            project,
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions::default(),
            [0; 4],
        ) {
            Ok(session) => {
                assert_eq!(session.snapshot().revision(), 0);
                assert_eq!(session.history_revision(), 1);
                Value::Null
            }
            Err(error) => {
                assert!(!format!("{error:?} {error}").contains("import:"));
                json!(error.user_message().units())
            }
        };
        assert_eq!(actual, case["error"], "{}", case["name"]);
    }
}
