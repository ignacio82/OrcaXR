use orcaxr_contracts::canonical::parse;
use orcaxr_project::{ids::*, model::*, selection::*, store::*, validation::*};
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, sync::Arc};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-store-vectors.json"
    ))
    .unwrap()
}
fn data(f: &Value, index: usize) -> ProjectData {
    ProjectData::new(
        ProjectState::from_value(parse(f["states"][index]["stateJson"].as_str().unwrap()).unwrap())
            .unwrap(),
    )
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
fn options(v: &Value) -> ReplaceOptions {
    ReplaceOptions {
        reason: v.get("reason").map(text),
        dirty_categories: v.get("dirtyCategories").map(|v| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|v| match v.as_str().unwrap() {
                    "projectData" => DirtyCategory::ProjectData,
                    "presets" => DirtyCategory::Presets,
                    "printerDevice" => DirtyCategory::PrinterDevice,
                    _ => panic!(),
                })
                .collect::<Vec<_>>()
                .into()
        }),
    }
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
    identities: Vec<ProjectData>,
    contents: &'a Value,
}
impl Recorder<'_> {
    fn snapshot(&mut self, s: &ProjectSnapshot) -> Value {
        let identity = if let Some(i) = self
            .identities
            .iter()
            .position(|p| p.same_allocation(s.project().data()))
        {
            i + 1
        } else {
            self.identities.push(s.project().data().clone());
            self.identities.len()
        };
        let content = state_json(s.state());
        let content = self
            .contents
            .as_array()
            .unwrap()
            .iter()
            .position(|v| v.as_str() == Some(&content))
            .expect("reference contains complete state");
        json!({"identity":identity,"revision":s.revision(),"hash":s.hash(),"content":content})
    }
    fn project_change(&mut self, c: &ProjectChange) -> Value {
        json!({"kind":"project","previous":self.snapshot(c.previous()),"current":self.snapshot(c.current()),"reason":c.reason().units(),"dirtyCategories":c.dirty_categories()})
    }
}
fn error_value(error: ReplaceError<()>) -> Value {
    let ReplaceError::Admission(AdmissionError::Invalid(report)) = error else {
        panic!("unexpected error {error:?}");
    };
    json!({"kind":"invalidProject","message":report.user_message().units(),"issues":report.issues().iter().map(|i|json!({"code":i.code,"path":i.path.units(),"message":i.message.units(),"severity":i.severity.as_str()})).collect::<Vec<_>>()})
}

#[test]
fn complete_store_and_selection_trace_matches_typescript_after_every_step() {
    let f = fixture();
    let mut store = ProjectStore::admit(data(&f, 0), &mut utc()).unwrap();
    let mut selection = SelectionStore::default();
    let mut saved: BTreeMap<&str, (ProjectSnapshot, SelectionSnapshot, String)> = BTreeMap::new();
    let mut recorder = Recorder {
        identities: vec![],
        contents: &f["contents"],
    };
    assert_eq!(recorder.snapshot(&store.snapshot()), f["initial"]);
    for (index, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let op = &step["operation"];
        let mut result = Value::Null;
        let mut error = Value::Null;
        let mut effects = vec![];
        let mut project_change = None;
        let mut selection_change = None;
        match op["kind"].as_str().unwrap() {
            "capture" => {
                saved.insert(
                    op["name"].as_str().unwrap(),
                    (
                        store.snapshot(),
                        selection.snapshot(),
                        state_json(store.snapshot().state()),
                    ),
                );
            }
            "replace" => match store.replace(
                data(&f, op["state"].as_u64().unwrap() as usize),
                options(&op["options"]),
                &mut utc(),
            ) {
                Ok(c) => project_change = Some(c),
                Err(e) => error = error_value(e),
            },
            "frozen" => {
                project_change = Some(
                    store
                        .replace_validated(
                            saved[op["name"].as_str().unwrap()].0.project().clone(),
                            options(&op["options"]),
                        )
                        .unwrap(),
                )
            }
            "restore" => {
                project_change = Some(
                    store
                        .restore(
                            saved[op["name"].as_str().unwrap()].0.project().clone(),
                            op.get("reason").map(text),
                        )
                        .unwrap(),
                )
            }
            "same" => {
                result =
                    json!(store.has_same_content(&data(&f, op["state"].as_u64().unwrap() as usize)))
            }
            "guard" => {
                let mut guard = saved[op["name"].as_str().unwrap()].0.guard();
                if op["wrongRevision"] == true {
                    guard.revision += 1;
                }
                if op["wrongHash"] == true {
                    guard.hash = Text::from_utf8("fnv1a64:0000000000000000");
                }
                result = json!(store.is_current(&guard));
            }
            "foreignGuard" => {
                let foreign = ProjectStore::new(store.snapshot().project().clone());
                result = json!(store.is_current(&foreign.snapshot().guard()));
            }
            "set" => {
                let refs = op["refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(reference)
                    .collect::<Vec<_>>();
                match selection.set(&refs, op.get("primary").map(reference)) {
                    Ok(c) => selection_change = c,
                    Err(InvalidPrimary) => error = json!({"kind":"invalidPrimary"}),
                }
            }
            "add" => {
                selection_change = selection.add(
                    reference(&op["ref"]),
                    op["makePrimary"].as_bool().unwrap_or(true),
                )
            }
            "toggle" => selection_change = selection.toggle(reference(&op["ref"])),
            "clear" => selection_change = selection.clear(),
            "prune" => selection_change = selection.prune(store.snapshot().state()),
            "restoreSelection" => {
                selection_change = selection.restore(&saved[op["name"].as_str().unwrap()].1)
            }
            _ => panic!("unknown trace operation"),
        }
        if let Some(c) = project_change {
            effects.push(recorder.project_change(&c));
        }
        if let Some(c) = selection_change {
            effects.push(json!({"kind":"selection","previous":selection_value(c.previous()),"current":selection_value(c.current())}));
        }
        let actual = json!({"operation":op,"result":result,"error":error,"effects":effects,"snapshot":recorder.snapshot(&store.snapshot()),"selection":selection_value(&selection.snapshot())});
        assert_eq!(&actual, step, "step {index}, operation {}", op["kind"]);
        for (old, _, original) in saved.values() {
            assert_eq!(
                state_json(old.state()),
                *original,
                "retained snapshots never mutate"
            );
        }
    }
}

#[test]
fn failed_admission_and_timezone_services_publish_nothing_and_proofs_reuse_without_services() {
    let f = fixture();
    let calls = Cell::new(0);
    let mut policy = |_: &[u16]| {
        calls.set(calls.get() + 1);
        Ok::<_, ()>(true)
    };
    let mut store = ProjectStore::admit(data(&f, 0), &mut policy).unwrap();
    let original = store.snapshot();
    assert_eq!(calls.get(), 2);
    for _ in 0..20 {
        let change = store.restore(original.project().clone(), None).unwrap();
        assert!(
            change
                .current()
                .project()
                .same_allocation(original.project())
        );
        assert!(change.dirty_categories().is_empty());
    }
    assert_eq!(calls.get(), 2);
    let current = store.snapshot();
    let error = store
        .replace(
            data(&f, 0),
            ReplaceOptions::default(),
            &mut |_: &[u16]| Err::<bool, _>("PRIVATE_TIMEZONE_ERROR"),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ReplaceError::Admission(AdmissionError::Timestamp("PRIVATE_TIMEZONE_ERROR"))
    ));
    assert!(!format!("{error:?} {error}").contains("PRIVATE"));
    assert!(store.is_current(&current.guard()));
    assert!(
        store
            .snapshot()
            .project()
            .same_allocation(current.project())
    );
    assert!(
        store
            .replace(data(&f, 3), ReplaceOptions::default(), &mut policy)
            .is_err()
    );
    assert!(store.is_current(&current.guard()));
    let change = store
        .replace(data(&f, 1), ReplaceOptions::default(), &mut policy)
        .unwrap();
    assert_eq!(change.current().revision(), current.revision() + 1);
    assert_eq!(change.previous().revision(), current.revision());
    assert!(!format!("{store:?} {change:?}").contains("PRIVATE"));
}

#[test]
fn receipts_and_snapshots_survive_later_edits_and_owner_disposal() {
    let f = fixture();
    let mut store = ProjectStore::admit(data(&f, 0), &mut utc()).unwrap();
    let initial = store.snapshot();
    let mut categories: Arc<[DirtyCategory]> = vec![DirtyCategory::Presets].into();
    let receipt = store
        .replace(
            data(&f, 1),
            ReplaceOptions {
                reason: Some(Text::new(vec![0xd800, 0])),
                dirty_categories: Some(categories.clone()),
            },
            &mut utc(),
        )
        .unwrap();
    Arc::make_mut(&mut categories)[0] = DirtyCategory::PrinterDevice;
    let final_receipt = store.restore(initial.project().clone(), None).unwrap();
    drop(store);
    assert_eq!(receipt.dirty_categories(), &[DirtyCategory::Presets]);
    assert_eq!(receipt.reason().units(), &[0xd800, 0]);
    assert_eq!(receipt.current().revision(), 1);
    assert_eq!(final_receipt.current().revision(), 2);
    assert!(
        final_receipt
            .current()
            .project()
            .same_allocation(initial.project())
    );
    assert!(
        !receipt
            .current()
            .project()
            .same_allocation(initial.project())
    );
    assert_eq!(
        state_json(receipt.current().state()),
        f["states"][1]["stateJson"]
    );
}

#[test]
fn selection_receipts_preserve_entity_kinds_and_survive_disposal() {
    let mut selection = SelectionStore::default();
    let plate = SelectionRef::Plate(PlateId::try_from_str("import:same:\0\u{10000}").unwrap());
    let object = SelectionRef::Object(ObjectId::try_from_str("import:same:\0\u{10000}").unwrap());
    let first = selection
        .set(&[plate.clone(), object.clone(), plate.clone()], None)
        .unwrap()
        .unwrap();
    assert_eq!(first.current().refs(), &[plate.clone(), object.clone()]);
    assert_eq!(first.current().primary(), Some(&object));
    assert!(
        selection
            .set(first.current().refs(), Some(object.clone()))
            .unwrap()
            .is_none()
    );
    assert!(selection.set(&[], Some(plate)).is_err());
    let removed = selection.toggle(object).unwrap();
    drop(selection);
    assert_eq!(first.current().refs().len(), 2);
    assert_eq!(removed.current().refs().len(), 1);
    assert_eq!(removed.previous(), first.current());
}
