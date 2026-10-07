use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::*, history::*, model::*, selection::*, session::*, store::*, validation::*,
};
use serde_json::{Value, json};
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
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

fn bundle(document: &Value, invalid: bool) -> (ValidatedProject, AssetRepository) {
    let state =
        ProjectState::from_value(parse(document["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    if !invalid {
        for item in document["assets"].as_array().unwrap() {
            assets
                .put_owned(AssetPayload {
                    descriptor: parse(item["descriptorJson"].as_str().unwrap()).unwrap(),
                    bytes: item["bytes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect(),
                })
                .unwrap();
        }
    }
    (project, assets)
}
fn setup(document: &Value) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let (project, assets) = bundle(document, false);
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap()
}
#[test]
fn document_open_and_reset_match_independent_browser_authority() {
    use orcaxr_contracts::project_intent_types::SessionError;
    let f: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-document-vectors.json"
    ))
    .unwrap();
    let recorder = Recorder {
        contents: f["contents"].as_array().unwrap(),
    };
    let mut count = 0;
    for trace in f["traces"].as_array().unwrap() {
        let mut owner = setup(&f["documents"][0]);
        let mut opens = Vec::<(String, DocumentOpen)>::new();
        let mut initial = recorder.observe(&owner);
        initial["opens"] = json!([]);
        assert_eq!(initial, trace["initial"], "{} initial", trace["name"]);
        let mut request_id = 0;
        let mut retained = Vec::new();
        for step in trace["steps"].as_array().unwrap() {
            count += 1;
            retained.push(owner.snapshot());
            let action = &step["action"];
            let name = action["name"].as_str().unwrap_or("");
            let ticket = opens.iter().find(|(n, _)| n == name).map(|(_, t)| t);
            let mut effects = vec![];
            let mut outcome = Value::Null;
            match action["kind"].as_str().unwrap() {
                "begin" => opens.push((name.into(), owner.begin_open().unwrap())),
                "finish" | "finishInvalid" | "reset" | "resetInvalid" => {
                    let reset = action["kind"].as_str().unwrap().starts_with("reset");
                    let invalid = action["kind"].as_str().unwrap().ends_with("Invalid");
                    let doc = &f["documents"][action["document"].as_u64().unwrap() as usize];
                    let (project, assets) = bundle(doc, invalid);
                    match PreparedDocument::new(project, assets) {
                        Err(_) => {
                            if let Some(t) = ticket {
                                owner.cancel_open(t);
                            }
                            outcome = json!("failed");
                        }
                        Ok(doc) => {
                            let result = if reset {
                                owner.reset_document(&owner.capture_guard().unwrap(), doc)
                            } else {
                                owner.finish_open(ticket.unwrap(), doc)
                            };
                            outcome = match result {
                                Ok(events) => {
                                    effects = events;
                                    json!(if reset { "reset" } else { "opened" })
                                }
                                Err(SessionError::Disposed) => json!("disposed"),
                                Err(SessionError::Stale) => json!("stale"),
                                Err(e) => panic!("unexpected adoption error {e:?}"),
                            };
                        }
                    }
                }
                "fail" | "cancel" => {
                    let current = owner.is_open_current(ticket.unwrap());
                    owner.cancel_open(ticket.unwrap());
                    outcome = json!(if action["kind"] == "cancel" {
                        "cancelled"
                    } else if current {
                        "failed"
                    } else {
                        "stale"
                    });
                }
                "checkpoint" => {
                    effects = owner
                        .acknowledge_checkpoint(&owner.capture_guard().unwrap())
                        .unwrap()
                }
                "select" => {
                    if let Some(change) = owner
                        .select(
                            &owner.capture_guard().unwrap(),
                            &[SelectionRef::Project],
                            None,
                        )
                        .unwrap()
                    {
                        effects.push(DomainEvent::Selection(change));
                    }
                }
                "dispose" => owner.dispose(),
                "edit" | "undo" => {
                    if request_id == 0 {
                        let hello = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":1,"operation":{"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}});
                        assert!(matches!(
                            owner.submit(&hello.to_string()),
                            Submission::Ready(_)
                        ));
                        request_id = 1;
                    }
                    request_id += 1;
                    // Obtain the bounded wire guard through an ordered query acknowledgement.
                    let query = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":request_id,"operation":{"query":{}}});
                    assert!(matches!(
                        owner.submit(&query.to_string()),
                        Submission::Queued { .. }
                    ));
                    let reply: Value =
                        serde_json::from_str(owner.run_next().unwrap().wire()).unwrap();
                    let guard = reply["result"]["acknowledged"]["guard"].clone();
                    let operation = if action["kind"] == "edit" {
                        json!({"execute":{"guard":guard,"intent":action["intent"]}})
                    } else {
                        json!({"undo":guard})
                    };
                    request_id += 1;
                    let request = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":request_id,"operation":operation});
                    assert!(matches!(
                        owner.submit(&request.to_string()),
                        Submission::Queued { .. }
                    ));
                    let (wire, events) = owner.run_next().unwrap().into_parts();
                    assert!(
                        serde_json::from_str::<Value>(&wire).unwrap()["result"]
                            .get("acknowledged")
                            .is_some(),
                        "{wire}"
                    );
                    effects = events;
                }
                _ => panic!("unknown document action"),
            }
            let mut actual = recorder.observe(&owner);
            actual["opens"] = json!(
                opens
                    .iter()
                    .map(|(n, t)| json!([n, owner.is_open_current(t)]))
                    .collect::<Vec<_>>()
            );
            actual["outcome"] = outcome;
            actual["effects"] = json!(
                effects
                    .iter()
                    .map(|e| recorder.effect(e))
                    .collect::<Vec<_>>()
            );
            for key in [
                "snapshot",
                "selection",
                "history",
                "historyRevision",
                "assets",
                "opens",
                "outcome",
                "effects",
            ] {
                assert_eq!(
                    actual[key], step[key],
                    "{} action {action}: {key}",
                    trace["name"]
                );
            }
            for capture in &retained {
                assert!(
                    f["contents"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v.as_str() == Some(&state_json(capture.state())))
                );
            }
        }
    }
    assert_eq!(count, 59);
}

#[test]
fn adoption_moves_records_preserves_clipboard_owner_and_rejects_foreign_or_consumed_opens() {
    use orcaxr_project::clipboard::ClipboardData;
    use std::sync::Arc;
    let f: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-document-vectors.json"
    ))
    .unwrap();
    let mut owner = setup(&f["documents"][0]);
    let mut foreign = setup(&f["documents"][0]);
    let first = owner.begin_open().unwrap();
    let other = foreign.begin_open().unwrap();
    assert!(!owner.is_open_current(&other));
    assert!(!owner.cancel_open(&other));
    let (project, assets) = bundle(&f["documents"][1], false);
    let weak = Arc::downgrade(&project.state().plates[0].objects[0]);
    let document = PreparedDocument::new(project, assets).unwrap();
    assert!(matches!(
        owner.finish_open(&other, document),
        Err(orcaxr_contracts::project_intent_types::SessionError::Stale)
    ));
    assert!(
        weak.upgrade().is_none(),
        "rejected input is destroyed immediately"
    );
    assert!(owner.is_open_current(&first));
    assert!(foreign.is_open_current(&other));
    let state = owner.snapshot();
    let clipboard = ClipboardData::capture(
        state.state(),
        owner.assets(),
        &state.state().plates[0].objects[0].id,
        2,
        4096,
    )
    .unwrap();
    let (project, assets) = bundle(&f["documents"][1], false);
    let record = assets.peek(&project.state().source_assets[0].id).unwrap();
    let source_graph = project.clone();
    let events = owner
        .finish_open(&first, PreparedDocument::new(project, assets).unwrap())
        .unwrap();
    assert!(
        owner
            .assets()
            .peek(record.id())
            .unwrap()
            .same_record(&record)
    );
    assert!(owner.snapshot().project().same_allocation(&source_graph));
    assert!(
        owner.assets().owns_selection(clipboard.assets()),
        "replacement preserves repository ownership"
    );
    assert!(!owner.is_open_current(&first));
    assert_eq!(events.len(), 1);
    let (project, assets) = bundle(&f["documents"][2], false);
    assert!(matches!(
        owner.finish_open(&first, PreparedDocument::new(project, assets).unwrap()),
        Err(orcaxr_contracts::project_intent_types::SessionError::Stale)
    ));
    assert!(
        owner
            .assets()
            .peek(record.id())
            .unwrap()
            .same_record(&record)
    );
}

#[test]
fn replacement_keeps_staged_work_charged_until_its_stale_settlement() {
    use orcaxr_project::commands::staged::{CapturedCommand, StagedWork};
    let f: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-document-vectors.json"
    ))
    .unwrap();
    let mut owner = setup(&f["documents"][0]);
    owner
        .configure_staging(StagingLimits {
            max_resources: 1,
            max_commands: 1,
            max_units: 4096,
        })
        .unwrap();
    let guard = owner.capture_guard().unwrap();
    let command=json!({"version":1,"command":{"renamePlate":{"plateId":owner.snapshot().state().active_plate_id.as_utf16(),"name":[110,101,119]}}}).to_string();
    let stage = owner
        .stage(
            &guard,
            StagedWork::single(CapturedCommand::intent(&command, 4096).unwrap()),
        )
        .unwrap();
    let wire = |id, operation| {
        json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":id,"operation":operation})
            .to_string()
    };
    assert!(matches!(owner.submit(&wire(1,json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}))),Submission::Ready(_)));
    let (project, assets) = bundle(&f["documents"][1], false);
    owner
        .reset_document(&guard, PreparedDocument::new(project, assets).unwrap())
        .unwrap();
    assert_eq!(owner.staging_usage().resources, 1);
    assert!(matches!(
        owner.submit(&wire(2, json!({"executeStaged":{"stagedId":stage}}))),
        Submission::Queued { .. }
    ));
    assert_eq!(owner.staging_usage().resources, 1);
    let reply: Value = serde_json::from_str(owner.run_next().unwrap().wire()).unwrap();
    assert_eq!(reply["result"]["error"], "stale");
    assert_eq!(owner.staging_usage().resources, 0);
    assert_eq!(
        state_json(owner.snapshot().state()),
        f["documents"][1]["stateJson"]
    );
    assert!(owner.history().dirty_categories.is_empty());
}
