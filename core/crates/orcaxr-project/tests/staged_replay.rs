use orcaxr_contracts::canonical::parse;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::{
    assets::*,
    clipboard::{ClipboardCapture, ClipboardHostError},
    history::*,
    ids::*,
    model::*,
    selection::*,
    session::*,
    store::*,
    validation::*,
};
use orcaxr_project::{
    commands::{
        BooleanGuard, BooleanOp, IndependentObjectIds, PartPlacement, Recipe, SeparatedObject,
        SplitPart, StagedAsset, TopologyGuard, VolumeSplitGuard, staged::*,
    },
    ingress::{
        command_record::{InstanceInput, ObjectInput},
        json::JsonLimits,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-staged-session-vectors.json"
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
        json!({"snapshot":self.snapshot(&bus.snapshot()),"selection":selection_value(&bus.selection()),"history":history_value(&bus.history()),"historyRevision":bus.history_revision(),"assets":bus.assets().bundle_fingerprint(),"staging":usage(bus)})
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
    let payloads = trace["assets"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(&trace["asset"]));
    for payload in payloads {
        assets
            .put(
                &parse(payload["descriptorJson"].as_str().unwrap()).unwrap(),
                &payload["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
    }
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
fn usage<P: TimestampPolicy>(session: &ProjectSession<P>) -> Value {
    let u = session.staging_usage();
    json!({"resources":u.resources,"commands":u.commands,"units":u.units,"assetBytes":u.asset_bytes})
}
fn capture_error(error: CaptureError) -> wire::SessionError {
    match error {
        CaptureError::Limit => wire::SessionError::ResourceLimit,
        _ => wire::SessionError::InvalidRequest,
    }
}
fn capture_command(
    v: &Value,
    clips: &std::collections::BTreeMap<String, ClipboardCapture>,
) -> Result<CapturedCommand, wire::SessionError> {
    const LIMIT: u64 = 4_000_000;
    if let Some(intent) = v.get("intent") {
        return CapturedCommand::intent(&json!({"version":1,"command":intent}).to_string(), LIMIT)
            .map_err(capture_error);
    }
    let invalid = || wire::SessionError::InvalidRequest;
    if let Some(name) = v["clipboard"].as_str() {
        let ids = IndependentObjectIds {
            object_id: ObjectId::try_from_utf16(text(&v["ids"]["objectId"]).units().to_vec())
                .map_err(|_| invalid())?,
            volume_ids: v["ids"]["volumeIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| VolumeId::try_from_utf16(text(v).units().to_vec()).map_err(|_| invalid()))
                .collect::<Result<_, _>>()?,
            instance_ids: v["ids"]["instanceIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| {
                    InstanceId::try_from_utf16(text(v).units().to_vec()).map_err(|_| invalid())
                })
                .collect::<Result<_, _>>()?,
            layer_range_ids: v["ids"]["layerRangeIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| {
                    LayerRangeId::try_from_utf16(text(v).units().to_vec()).map_err(|_| invalid())
                })
                .collect::<Result<_, _>>()?,
        };
        let destination = (!v["destination"].is_null())
            .then(|| PlateId::try_from_utf16(text(&v["destination"]).units().to_vec()).unwrap());
        return CapturedCommand::clipboard_paste(clips[name].data(), ids, destination, LIMIT)
            .map_err(capture_error);
    }
    if v["kind"]
        .as_str()
        .is_some_and(|k| k != "instance" && k != "object")
    {
        return capture_asset_command(v);
    }
    let bytes = v["recordJson"].as_str().unwrap().as_bytes();
    let limits = JsonLimits {
        max_bytes: bytes.len(),
        max_nodes: 1_000_000,
        max_text_units: 4_000_000,
        max_number_bytes: 128,
        max_depth: 128,
    };
    if v["kind"] == "instance" {
        let mut input = InstanceInput::new(bytes.len(), limits).map_err(|_| invalid())?;
        for (i, c) in bytes.chunks(97).enumerate() {
            input.append(i * 97, c).map_err(|_| invalid())?;
        }
        CapturedCommand::instance(
            ObjectId::try_from_utf16(text(&v["objectId"]).units().to_vec())
                .map_err(|_| invalid())?,
            input.finish().map_err(|_| invalid())?,
            v["index"].as_f64().map(|n| Number::new(n).unwrap()),
            LIMIT,
        )
        .map_err(capture_error)
    } else {
        let mut input = ObjectInput::new(bytes.len(), limits).map_err(|_| invalid())?;
        for (i, c) in bytes.chunks(97).enumerate() {
            input.append(i * 97, c).map_err(|_| invalid())?;
        }
        CapturedCommand::paste(
            input.finish().map_err(|_| invalid())?,
            IndependentObjectIds {
                object_id: ObjectId::try_from_utf16(text(&v["ids"]["objectId"]).units().to_vec())
                    .map_err(|_| invalid())?,
                volume_ids: v["ids"]["volumeIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        VolumeId::try_from_utf16(text(v).units().to_vec()).map_err(|_| invalid())
                    })
                    .collect::<Result<_, _>>()?,
                instance_ids: v["ids"]["instanceIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        InstanceId::try_from_utf16(text(v).units().to_vec()).map_err(|_| invalid())
                    })
                    .collect::<Result<_, _>>()?,
                layer_range_ids: v["ids"]["layerRangeIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        LayerRangeId::try_from_utf16(text(v).units().to_vec())
                            .map_err(|_| invalid())
                    })
                    .collect::<Result<_, _>>()?,
            },
            (!v["destination"].is_null()).then(|| {
                PlateId::try_from_utf16(text(&v["destination"]).units().to_vec()).unwrap()
            }),
            (!v["name"].is_null()).then(|| text(&v["name"])),
            LIMIT,
        )
        .map_err(capture_error)
    }
}
fn utf16(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u16)
        .collect()
}
fn staged_asset(value: &Value) -> Result<StagedAsset, wire::SessionError> {
    StagedAsset::new(AssetPayload {
        descriptor: parse(value["descriptorJson"].as_str().unwrap()).unwrap(),
        bytes: value["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect(),
    })
    .map_err(|_| wire::SessionError::InvalidRequest)
}
fn decoded<T: Decode>(json: &Value) -> Result<T, wire::SessionError> {
    T::from_value(parse(json.as_str().unwrap()).unwrap())
        .map_err(|_| wire::SessionError::InvalidRequest)
}
fn stable<K>(value: &Value) -> Result<EntityId<K>, wire::SessionError> {
    EntityId::try_from_utf16(utf16(value)).map_err(|_| wire::SessionError::InvalidRequest)
}
fn split_guard(g: &Value) -> VolumeSplitGuard {
    VolumeSplitGuard {
        volume_id: utf16(&g["volumeId"]),
        asset_id: utf16(&g["assetId"]),
        asset_digest: utf16(&g["assetDigest"]),
        topology_revision: g["topologyRevision"].as_f64().unwrap(),
        triangle_count: g["triangleCount"].as_f64().unwrap(),
        volume_fingerprint: utf16(&g["volumeFingerprint"]),
    }
}
fn split_parts(parts: &Value) -> Result<Vec<SplitPart>, wire::SessionError> {
    parts
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            Ok(SplitPart {
                volume_id: utf16(&p["volumeId"]),
                asset: staged_asset(&p["asset"])?,
                transform: decoded(&p["transformJson"])?,
                source_triangles: p["sourceTriangleIndices"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_f64().unwrap())
                    .collect(),
            })
        })
        .collect()
}
fn placement(p: &Value) -> Result<PartPlacement, wire::SessionError> {
    Ok(PartPlacement {
        object: stable(&p["objectId"])?,
        volume: stable(&p["volumeId"])?,
        asset: stable(&p["assetId"])?,
        transform: decoded(&p["transformJson"])?,
    })
}
/// The payload-carrying kinds, in the asset corpus's wire form.
fn capture_asset_command(v: &Value) -> Result<CapturedCommand, wire::SessionError> {
    const LIMIT: u64 = 4_000_000;
    let record = || v["recordJson"].clone();
    let triangles = || v["triangleCount"].as_f64().unwrap();
    let captured = match v["kind"].as_str().unwrap() {
        "addObject" => CapturedCommand::add_object(
            stable(&v["plateId"])?,
            Arc::new(decoded(&record())?),
            LIMIT,
        ),
        "addObjectWithAsset" => CapturedCommand::add_object_with_asset(
            stable(&v["plateId"])?,
            Arc::new(decoded(&record())?),
            staged_asset(&v["asset"])?,
            LIMIT,
        ),
        "addVolume" => CapturedCommand::add_volume(
            stable(&v["objectId"])?,
            Arc::new(decoded(&record())?),
            staged_asset(&v["asset"])?,
            LIMIT,
        ),
        "replaceVolumeMesh" => {
            let g = &v["guard"];
            CapturedCommand::replace_volume_mesh(
                TopologyGuard {
                    volume_id: utf16(&g["volumeId"]),
                    asset_id: utf16(&g["assetId"]),
                    asset_digest: utf16(&g["assetDigest"]),
                    topology_revision: g["topologyRevision"].as_f64().unwrap(),
                    triangle_count: g["triangleCount"].as_f64().unwrap(),
                },
                staged_asset(&v["asset"])?,
                LIMIT,
            )
        }
        "meshBoolean" => {
            let g = &v["guard"];
            CapturedCommand::mesh_boolean(
                BooleanGuard {
                    target_instance_id: utf16(&g["targetInstanceId"]),
                    target_volume_id: utf16(&g["targetVolumeId"]),
                    target_asset_id: utf16(&g["targetAssetId"]),
                    target_asset_digest: utf16(&g["targetAssetDigest"]),
                    target_topology_revision: g["targetTopologyRevision"].as_f64().unwrap(),
                    target_triangle_count: g["targetTriangleCount"].as_f64().unwrap(),
                    other_instance_id: utf16(&g["otherInstanceId"]),
                },
                staged_asset(&v["asset"])?,
                match v["op"].as_str().unwrap() {
                    "UNION" => BooleanOp::Union,
                    "A_NOT_B" => BooleanOp::ANotB,
                    _ => BooleanOp::Intersection,
                },
                LIMIT,
            )
        }
        "splitVolumeToParts" => CapturedCommand::split_volume_to_parts(
            split_guard(&v["guard"]),
            split_parts(&v["parts"])?,
            LIMIT,
        ),
        "addSvgPart" => CapturedCommand::add_drawn_part(
            placement(&v["placement"])?,
            staged_asset(&v["asset"])?,
            triangles(),
            Recipe::Svg {
                drawing: Some(staged_asset(&v["drawing"])?),
                part: Arc::new(decoded(&v["partJson"])?),
            },
            Some(Text::new(utf16(&v["name"]))),
            LIMIT,
        ),
        "editSvgPart" => CapturedCommand::recut_part(
            stable(&v["volumeId"])?,
            staged_asset(&v["asset"])?,
            triangles(),
            Recipe::Svg {
                drawing: None,
                part: Arc::new(decoded(&v["partJson"])?),
            },
            LIMIT,
        ),
        "addEmbossText" => CapturedCommand::add_drawn_part(
            placement(&v["placement"])?,
            staged_asset(&v["asset"])?,
            triangles(),
            Recipe::Text(Arc::new(decoded(&v["configurationJson"])?)),
            None,
            LIMIT,
        ),
        "editEmbossText" => CapturedCommand::recut_part(
            stable(&v["volumeId"])?,
            staged_asset(&v["asset"])?,
            triangles(),
            Recipe::Text(Arc::new(decoded(&v["configurationJson"])?)),
            LIMIT,
        ),
        "replaceProject" => CapturedCommand::replace_project(
            decoded(&v["stateJson"])?,
            (!v["label"].is_null()).then(|| Text::new(utf16(&v["label"]))),
            LIMIT,
        ),
        kind => panic!("unknown staged command {kind}"),
    };
    captured.map_err(capture_error)
}
fn capture_work(
    v: &Value,
    clips: &std::collections::BTreeMap<String, ClipboardCapture>,
) -> Result<StagedWork, wire::SessionError> {
    if let Some(split) = v.get("splitToObjects") {
        let identities = split["identities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                Ok(SeparatedObject {
                    source_volume: stable(&i["sourceVolumeId"])?,
                    object: stable(&i["objectId"])?,
                    instances: i["instanceIds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(stable)
                        .collect::<Result<_, _>>()?,
                })
            })
            .collect::<Result<_, wire::SessionError>>()?;
        return StagedWork::split_to_objects(
            split_guard(&split["guard"]),
            split_parts(&split["parts"])?,
            identities,
            4_000_000,
        )
        .map_err(capture_error);
    }
    if let Some(single) = v.get("single") {
        Ok(StagedWork::single(capture_command(single, clips)?))
    } else {
        StagedWork::transaction(
            text(&v["label"]),
            v["commands"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| capture_command(c, clips))
                .collect::<Result<_, _>>()?,
            4_000_000,
        )
        .map_err(capture_error)
    }
}
#[test]
fn staged_ownership_and_protocol_match_independent_typescript_authority() {
    let f = fixture();
    let recorder = Recorder {
        contents: f["contents"].as_array().unwrap(),
    };
    let mut groups = 0;
    let mut requests = 0;
    for trace in f["traces"].as_array().unwrap() {
        let mut owner = session(trace);
        let asset = owner
            .assets()
            .peek(&owner.snapshot().state().source_assets[0].id)
            .unwrap();
        let mut guards = std::collections::BTreeMap::new();
        let mut clips = std::collections::BTreeMap::new();
        let mut retained = vec![];
        assert_eq!(recorder.observe(&owner), trace["initial"]);
        for (index, expected) in trace["steps"].as_array().unwrap().iter().enumerate() {
            groups += 1;
            retained.push((owner.snapshot(), state_json(owner.snapshot().state())));
            let mut outcomes = vec![];
            let mut effects = vec![];
            let mut replies = vec![];
            let mut pending = std::collections::BTreeMap::new();
            for action in expected["actions"].as_array().unwrap() {
                let outcome = (|| -> Result<Value, wire::SessionError> {
                    match action["kind"].as_str().unwrap() {
                        "configure" => owner.configure_staging(StagingLimits {
                            max_resources: action["limits"]["maxResources"].as_u64().unwrap()
                                as usize,
                            max_commands: action["limits"]["maxCommands"].as_u64().unwrap()
                                as usize,
                            max_units: action["limits"]["maxUnits"].as_u64().unwrap(),
                            max_asset_bytes: action["limits"]["maxAssetBytes"].as_u64().unwrap(),
                        })?,
                        "guard" => {
                            guards.insert(
                                action["name"].as_str().unwrap().to_owned(),
                                owner.capture_guard()?,
                            );
                        }
                        "copy" => {
                            let guard = if let Some(name) = action["guard"].as_str() {
                                guards[name].clone()
                            } else {
                                owner.capture_guard()?
                            };
                            let capture = ClipboardCapture::new(
                                &owner,
                                &guard,
                                action["plate"].as_u64().unwrap() as usize,
                                action["object"].as_u64().unwrap() as usize,
                                orcaxr_project::staging_layout::ClipboardOptions {
                                    assets: action["assets"].as_u64().unwrap() as usize,
                                    bytes: action["bytes"].as_u64().unwrap() as usize,
                                },
                            )
                            .map_err(|e| match e {
                                ClipboardHostError::Stale => wire::SessionError::Stale,
                                ClipboardHostError::Limit => wire::SessionError::ResourceLimit,
                                _ => wire::SessionError::InvalidRequest,
                            })?;
                            let info = capture.info().map(|n| n as u64);
                            clips.insert(action["name"].as_str().unwrap().to_owned(), capture);
                            return Ok(json!(info));
                        }
                        "dropClipboard" => {
                            clips.remove(action["name"].as_str().unwrap());
                        }
                        "stage" => {
                            let guard = if let Some(name) = action["guard"].as_str() {
                                guards[name].clone()
                            } else {
                                owner.capture_guard()?
                            };
                            let work = capture_work(&action["work"], &clips)?;
                            let units = work.units();
                            let commands = work.command_count();
                            let asset_bytes = work.asset_bytes();
                            let id = owner.stage(&guard, work)?;
                            return Ok(
                                json!({"id":id,"units":units,"commands":commands,"assetBytes":asset_bytes}),
                            );
                        }
                        "request" => {
                            requests += 1;
                            let slot = replies.len();
                            replies.push(Value::Null);
                            match owner.submit(action["json"].as_str().unwrap()) {
                                Submission::Ready(r) => {
                                    effects.extend(r.events().iter().map(|e| recorder.effect(e)));
                                    replies[slot] = serde_json::from_str(r.wire()).unwrap();
                                }
                                Submission::Queued { request_id } => {
                                    pending.insert(request_id, slot);
                                }
                            }
                            return Ok(json!({"reply":slot}));
                        }
                        "checkpoint" => {
                            let guard = owner.capture_guard()?;
                            effects.extend(
                                owner
                                    .acknowledge_checkpoint(&guard)?
                                    .iter()
                                    .map(|e| recorder.effect(e)),
                            );
                        }
                        "selection" => {
                            let refs = action["refs"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(reference)
                                .collect::<Vec<_>>();
                            if let Some(c) = owner.select(&owner.capture_guard()?, &refs, None)? {
                                effects.push(recorder.effect(&DomainEvent::Selection(c)));
                            }
                        }
                        "dispose" => owner.dispose(),
                        _ => panic!("unknown host action"),
                    }
                    Ok(Value::Null)
                })();
                outcomes.push(outcome.unwrap_or_else(|e| json!({"error":match e {wire::SessionError::InvalidRequest=>"invalidRequest",wire::SessionError::ResourceLimit=>"resourceLimit",wire::SessionError::Stale=>"stale",wire::SessionError::Busy=>"busy",wire::SessionError::Disposed=>"disposed",_=>panic!("unexpected host error")}})));
            }
            let queued = usage(&owner);
            while let Some(r) = owner.run_next() {
                let decoded: Value = serde_json::from_str(r.wire()).unwrap();
                let id = decoded["requestId"].as_u64().unwrap();
                let slot = pending.remove(&id).unwrap();
                replies[slot] = decoded;
                effects.extend(r.events().iter().map(|e| recorder.effect(e)));
            }
            assert!(pending.is_empty());
            let mut actual = recorder.observe(&owner);
            actual["actions"] = expected["actions"].clone();
            actual["outcomes"] = json!(outcomes);
            actual["queued"] = queued;
            actual["replies"] = json!(replies);
            actual["effects"] = json!(effects);
            for key in [
                "outcomes",
                "queued",
                "replies",
                "effects",
                "snapshot",
                "selection",
                "history",
                "historyRevision",
                "assets",
                "staging",
            ] {
                assert_eq!(
                    actual[key], expected[key],
                    "{} group {index}: {key}",
                    trace["name"]
                );
            }
            // Mesh edits may drop the first payload; while present it is the
            // record the session started with.
            if let Some(current) = owner.assets().peek(asset.id()) {
                assert!(current.same_record(&asset));
            }
            for (s, json) in &retained {
                assert_eq!(state_json(s.state()), *json, "immutable retained graph");
            }
        }
    }
    assert_eq!((groups, requests), (895, 665));
}
