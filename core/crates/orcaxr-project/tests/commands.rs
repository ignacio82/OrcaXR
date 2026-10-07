use orcaxr_contracts::canonical::parse;
use orcaxr_project::ingress::{
    command_record::{InstanceInput, ObjectInput},
    json::JsonLimits,
};
use orcaxr_project::{
    assets::*, commands::*, history::*, ids::*, model::*, selection::*, store::*, validation::*,
};
use orcaxr_project::{clipboard::ClipboardData, commands::staged::CapturedCommand};
use serde_json::{Value, json};
use std::sync::Arc;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-command-vectors.json"
    ))
    .unwrap()
}
fn prepare_captured(v: &Value) -> Result<PreparedCommand, PreparationError> {
    if let Some(intent) = v.get("intent") {
        return prepare_intent(&json!({"version":1,"command":intent}).to_string());
    }
    let record = v["recordJson"].as_str().unwrap().as_bytes();
    let limits = JsonLimits {
        max_bytes: record.len(),
        max_nodes: 100_000,
        max_text_units: record.len(),
        max_number_bytes: 128,
        max_depth: 64,
    };
    if v["kind"] == "instance" {
        let mut input = InstanceInput::new(record.len(), limits).unwrap();
        for (i, chunk) in record.chunks(7).enumerate() {
            input.append(i * 7, chunk).unwrap();
        }
        Ok(PreparedCommand::create_instance(
            ObjectId::try_from_utf16(text(&v["objectId"]).units().to_vec()).unwrap(),
            input.finish().unwrap(),
            v["index"].as_f64().map(|n| Number::new(n).unwrap()),
        ))
    } else {
        let mut input = ObjectInput::new(record.len(), limits).unwrap();
        for (i, chunk) in record.chunks(7).enumerate() {
            input.append(i * 7, chunk).unwrap();
        }
        PreparedCommand::paste_object(
            input.finish().unwrap(),
            IndependentObjectIds {
                object_id: ObjectId::try_from_utf16(text(&v["ids"]["objectId"]).units().to_vec())
                    .unwrap(),
                volume_ids: v["ids"]["volumeIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| VolumeId::try_from_utf16(text(v).units().to_vec()).unwrap())
                    .collect(),
                instance_ids: v["ids"]["instanceIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| InstanceId::try_from_utf16(text(v).units().to_vec()).unwrap())
                    .collect(),
                layer_range_ids: v["ids"]["layerRangeIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| LayerRangeId::try_from_utf16(text(v).units().to_vec()).unwrap())
                    .collect(),
            },
            (!v["destination"].is_null()).then(|| {
                PlateId::try_from_utf16(text(&v["destination"]).units().to_vec()).unwrap()
            }),
            (!v["name"].is_null()).then(|| text(&v["name"])),
        )
    }
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
    fn observe<P: TimestampPolicy>(&self, bus: &CommandBus<PreparedCommand, P>) -> Value {
        json!({"snapshot":self.snapshot(&bus.snapshot()),"selection":selection_value(&bus.selection()),"history":history_value(&bus.history()),"historyRevision":bus.history_revision(),"assets":bus.assets().bundle_fingerprint()})
    }
}
fn history_value(h: &HistorySnapshot) -> Value {
    json!({"undoCount":h.undo_count,"redoCount":h.redo_count,"undoLabel":h.undo_label.as_ref().map(Text::units),"redoLabel":h.redo_label.as_ref().map(Text::units),"dirtyCategories":h.dirty_categories.as_ref()})
}
#[test]
fn prepared_commands_and_history_match_every_typescript_step() {
    replay(fixture(), 1267);
}
#[test]
fn captured_commands_and_history_match_every_typescript_step() {
    replay(
        serde_json::from_str(include_str!(
            "../../../../testdata/cross-platform/project-captured-command-vectors.json"
        ))
        .unwrap(),
        197,
    );
}
#[test]
fn clipboard_commands_and_assets_match_every_typescript_step() {
    replay(
        serde_json::from_str(include_str!(
            "../../../../testdata/cross-platform/project-clipboard-vectors.json"
        ))
        .unwrap(),
        130,
    );
}
fn payload(value: &Value) -> AssetPayload {
    AssetPayload {
        descriptor: parse(value["descriptorJson"].as_str().unwrap()).unwrap(),
        bytes: value["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect(),
    }
}
fn asset_id(value: &orcaxr_contracts::canonical::Value) -> AssetId {
    match value {
        orcaxr_contracts::canonical::Value::Object(v) => {
            AssetId::from_value(v[&"id".encode_utf16().collect::<Vec<_>>()].clone()).unwrap()
        }
        _ => panic!(),
    }
}
fn clipboard_command(
    value: &Value,
    clipboard: &Arc<ClipboardData>,
    units: &mut Value,
    foreign: bool,
) -> Result<PreparedCommand, PreparationError> {
    if value.get("intent").is_some() {
        return prepare_captured(value);
    }
    let ids = IndependentObjectIds {
        object_id: ObjectId::try_from_utf16(text(&value["ids"]["objectId"]).units().to_vec())
            .unwrap(),
        volume_ids: value["ids"]["volumeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| VolumeId::try_from_utf16(text(v).units().to_vec()).unwrap())
            .collect(),
        instance_ids: value["ids"]["instanceIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| InstanceId::try_from_utf16(text(v).units().to_vec()).unwrap())
            .collect(),
        layer_range_ids: value["ids"]["layerRangeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| LayerRangeId::try_from_utf16(text(v).units().to_vec()).unwrap())
            .collect(),
    };
    let destination = (!value["destination"].is_null())
        .then(|| PlateId::try_from_utf16(text(&value["destination"]).units().to_vec()).unwrap());
    if !foreign {
        *units = json!(
            CapturedCommand::clipboard_paste(
                clipboard.clone(),
                ids.clone(),
                destination.clone(),
                1_000_000
            )
            .unwrap()
            .units()
        );
    }
    PreparedCommand::paste_clipboard(clipboard.clone(), ids, destination)
}
fn replay(f: Value, expected_steps: usize) {
    let recorder = Recorder {
        contents: f["contents"].as_array().unwrap(),
    };
    let mut total = 0;
    for trace in f["traces"].as_array().unwrap() {
        let state =
            ProjectState::from_value(parse(trace["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let store = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
        let mut assets = AssetRepository::new();
        let mut foreign_owner = None;
        let clipboard = trace.get("clipboard").map(|capture| {
            for value in capture["assets"].as_array().unwrap() {
                assets.put_owned(payload(value)).unwrap();
            }
            let state =
                ProjectState::from_value(parse(capture["stateJson"].as_str().unwrap()).unwrap())
                    .unwrap();
            let capture = Arc::new(
                ClipboardData::capture(&state, &assets, &state.plates[0].objects[0].id, 2, 4096)
                    .unwrap(),
            );
            assert!(Arc::ptr_eq(capture.object(), &state.plates[0].objects[0]));
            if trace["clipboard"]["foreign"] == true {
                foreign_owner = Some(std::mem::take(&mut assets));
            }
            let desired = trace["assets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| (payload(v), v["sameCaptured"] == true))
                .collect::<Vec<_>>();
            for id in assets.ids().cloned().collect::<Vec<_>>() {
                if !desired.iter().any(|(p, same)| {
                    *same && asset_id(&p.descriptor) == id && assets.get(&id).as_ref() == Some(p)
                }) {
                    assets.remove(&id);
                }
            }
            for (p, _) in desired {
                assets.put_owned(p).unwrap();
            }
            capture
        });
        let original_lease = if clipboard.is_none() {
            let p = payload(&trace["asset"]);
            let id = asset_id(&p.descriptor);
            assets.put_owned(p).unwrap();
            Some(assets.peek(&id).unwrap())
        } else {
            None
        };
        let mut bus = CommandBus::<PreparedCommand, _>::new(
            store,
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions {
                max_entries: trace["options"]["maxEntries"].as_u64().unwrap_or(100) as usize,
                max_estimated_bytes: trace["options"]["maxEstimatedBytes"]
                    .as_u64()
                    .unwrap_or(32 * 1024 * 1024),
            },
        );
        assert_eq!(recorder.observe(&bus), trace["initial"]);
        let mut retained = vec![];
        for (index, expected) in trace["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            let op = &expected["operation"];
            retained.push((bus.snapshot(), state_json(bus.snapshot().state())));
            let mut result = Value::Null;
            let mut error = Value::Null;
            let mut effects = vec![];
            let mut input_units = Value::Null;
            let outcome = match op["kind"].as_str().unwrap() {
                "clipboard" => match clipboard_command(
                    &op["command"],
                    clipboard.as_ref().unwrap(),
                    &mut input_units,
                    foreign_owner.is_some(),
                ) {
                    Ok(c) => Some(bus.execute(c, true)),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "clipboardBatch" => match op["commands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        clipboard_command(
                            c,
                            clipboard.as_ref().unwrap(),
                            &mut input_units,
                            foreign_owner.is_some(),
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(commands) => Some(bus.execute_batch(text(&op["label"]), commands)),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "captured" => match prepare_captured(&op["command"]) {
                    Ok(c) => Some(bus.execute(c, true)),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "capturedBatch" => match op["commands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(prepare_captured)
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(commands) => Some(bus.execute_batch(text(&op["label"]), commands)),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "intent" => match prepare_intent(op["json"].as_str().unwrap()) {
                    Ok(c) => Some(bus.execute(c, op["coalesce"].as_bool().unwrap())),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "batch" => match prepare_batch(op["json"].as_str().unwrap()) {
                    Ok(batch) => Some(bus.execute_batch(batch.label, batch.commands)),
                    Err(e) => {
                        error = json!(e.user_message().units());
                        None
                    }
                },
                "undo" => Some(bus.undo()),
                "redo" => Some(bus.redo()),
                "checkpoint" => Some(bus.mark_checkpoint()),
                "clear" => Some(bus.clear_history(op["mark"].as_bool().unwrap())),
                "selection" => {
                    let refs = op["refs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(reference)
                        .collect::<Vec<_>>();
                    if let Some(c) = bus.set_selection(&refs, None).unwrap() {
                        effects.push(recorder.effect(&DomainEvent::Selection(c)));
                    }
                    None
                }
                _ => panic!("unknown operation"),
            };
            if let Some(outcome) = outcome {
                match outcome.result {
                    Ok(changed) => {
                        if op["kind"] == "undo" || op["kind"] == "redo" {
                            result = json!(changed);
                        }
                    }
                    Err(e) => error = json!(e.user_message().units()),
                }
                effects.extend(outcome.events.iter().map(|e| recorder.effect(e)));
            }
            let mut actual = recorder.observe(&bus);
            actual["operation"] = op.clone();
            actual["result"] = result;
            actual["error"] = error;
            actual["effects"] = json!(effects);
            for key in [
                "result",
                "error",
                "snapshot",
                "selection",
                "history",
                "historyRevision",
                "assets",
                "effects",
            ] {
                assert_eq!(
                    &actual[key], &expected[key],
                    "{} step {index}: {key}",
                    trace["name"]
                );
            }
            if let Some(lease) = &original_lease {
                assert!(
                    bus.assets().peek(lease.id()).unwrap().same_record(lease),
                    "prepared editing commands preserve mesh identity"
                );
            }
            if let Some(capture) = &clipboard {
                assert_eq!(
                    input_units, expected["inputUnits"],
                    "{} step {index}: input units",
                    trace["name"]
                );
                let records = bus.assets().ids().map(|id| {
                    let lease = bus.assets().peek(id).unwrap();
                    let mut bytes = vec![];
                    lease.descriptor().write_canonical(&mut bytes).unwrap();
                    json!({"descriptorJson":String::from_utf8(bytes).unwrap(), "bytes":lease.bytes(), "sameCaptured":capture.assets().leases().any(|c| c.same_record(&lease))})
                }).collect::<Vec<_>>();
                assert_eq!(
                    json!(records),
                    expected["records"],
                    "{} step {index}: asset contents/identity",
                    trace["name"]
                );
            }
            for (snapshot, content) in &retained {
                assert_eq!(
                    state_json(snapshot.state()),
                    *content,
                    "retained snapshots are immutable"
                );
            }
        }
    }
    assert_eq!(total, expected_steps);
}
