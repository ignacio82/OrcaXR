//! Real plate, object and transform command/history allocation evidence, not device performance.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    clipboard::ClipboardData,
    commands::{staged::CapturedCommand, *},
    history::*,
    ids::*,
    model::*,
    selection::*,
    store::*,
    validation::*,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
const ASSIGNED: usize = 100_000;
const PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
struct Counted;
fn record(size: usize) {
    if TRACK.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
        TOTAL.fetch_add(size, Ordering::Relaxed);
        if size >= PAYLOAD_BYTES {
            LARGE.fetch_add(1, Ordering::Relaxed);
        }
    }
}
// SAFETY: The unchanged System allocator contract is forwarded for every call;
// counters allocate no memory and cannot alter pointer ownership or alignment.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: Forward the original System allocation and its layout.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: Forward ownership, layout and requested nonzero size unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;
fn object(value: &mut Value) -> &mut BTreeMap<Vec<u16>, Value> {
    let Value::Object(fields) = value else {
        panic!()
    };
    fields
}
fn field<'a>(value: &'a mut Value, name: &str) -> &'a mut Value {
    object(value)
        .get_mut(&name.encode_utf16().collect::<Vec<_>>())
        .unwrap()
}
fn first(value: &mut Value) -> &mut Value {
    let Value::Array(values) = value else {
        panic!()
    };
    &mut values[0]
}

fn main() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-validation-vectors.json"
    ))
    .unwrap();
    let base = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "base")
        .unwrap();
    let mut value = parse(base["stateJson"].as_str().unwrap()).unwrap();
    let mesh = field(first(field(&mut value, "sourceAssets")), "mesh");
    *field(mesh, "triangleCount") = Value::Number(1_897_256.0);
    let volume = first(field(
        first(field(first(field(&mut value, "plates")), "objects")),
        "volumes",
    ));
    *field(field(volume, "source"), "triangleCount") = Value::Number(1_897_256.0);
    *field(
        first(field(field(volume, "annotations"), "color")),
        "triangles",
    ) = Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect());
    let mut state = ProjectState::from_value(value).unwrap();
    let source_plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let source_object = Arc::make_mut(&mut Arc::make_mut(&mut source_plate.objects)[0]);
    let mut instances = source_object.instances.to_vec();
    let mut second = (*instances[0]).clone();
    second.id =
        orcaxr_project::ids::InstanceId::try_from_utf16(utf16("import:bench:second")).unwrap();
    instances.push(Arc::new(second));
    source_object.instances = instances.into();
    let mut destination = source_plate.clone();
    destination.id =
        orcaxr_project::ids::PlateId::try_from_utf16(utf16("import:bench:destination")).unwrap();
    destination.order = Number::new(1.0).unwrap();
    destination.objects = Arc::from([]);
    let mut plates = state.plates.to_vec();
    plates.push(Arc::new(destination));
    state.plates = plates.into();
    let config = Value::Object(BTreeMap::from([
        (
            "notes".encode_utf16().collect(),
            Value::String(vec![b'x' as u16; PAYLOAD_BYTES / 2]),
        ),
        (
            "metadata".encode_utf16().collect(),
            Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect()),
        ),
    ]));
    // Equal but separately owned config values exercise structural comparison,
    // including a wide array. Create the payloads before tracking validation.
    state.config = JsonObject::new(config.clone()).unwrap();
    state.settings_base_config = Some(JsonObject::new(config).unwrap());
    state.settings_overrides = Some(JsonObject::new(Value::Object(BTreeMap::new())).unwrap());
    let bytes = vec![0u8; PAYLOAD_BYTES];
    let descriptor = Arc::make_mut(&mut Arc::make_mut(&mut state.source_assets)[0]);
    descriptor.byte_length = Number::new(PAYLOAD_BYTES as f64).unwrap();
    descriptor.digest = Text::from_utf8(&content_digest(&bytes));
    let mut assets = AssetRepository::new();
    assets.put(&descriptor.to_value().unwrap(), &bytes).unwrap();
    let asset = assets.peek(&descriptor.id).unwrap();
    let original_annotations = state.plates[0].objects[0].volumes[0].annotations.clone();
    let original_config = state.config.clone();
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    );
    let project = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    let original = project.snapshot();
    let source = &original.state().plates[0];
    let intent = serde_json::json!({"version":1,"command":{"duplicatePlate":{
        "sourcePlateId":source.id.as_utf16(), "plateId":utf16("import:bench:duplicate"),
        "objects":source.objects.iter().enumerate().map(|(i,o)|serde_json::json!({
            "objectId":utf16(&format!("import:object:{i}")),
            "volumeIds":o.volumes.iter().enumerate().map(|(j,_)|utf16(&format!("import:volume:{i}-{j}"))).collect::<Vec<_>>(),
            "instanceIds":o.instances.iter().enumerate().map(|(j,_)|utf16(&format!("import:instance:{i}-{j}"))).collect::<Vec<_>>(),
            "layerRangeIds":o.layer_ranges.iter().enumerate().map(|(j,_)|utf16(&format!("import:range:{i}-{j}"))).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "customGcodeIds":original.state().custom_gcode.iter().filter(|c|c.scope == GcodeScope::Plate && c.plate_id.as_ref() == Some(&source.id)).enumerate().map(|(i,_)|utf16(&format!("import:bench:gcode-{i}"))).collect::<Vec<_>>(),
        "thumbnailIds":original.state().thumbnails.iter().filter(|t|t.plate_id.as_ref() == Some(&source.id)).enumerate().map(|(i,_)|utf16(&format!("import:bench:thumbnail-{i}"))).collect::<Vec<_>>()
    }}}).to_string();
    let duplicate = prepare_intent(&intent).unwrap();
    let deletion = prepare_intent(&serde_json::json!({"version":1,"command":{"deletePlate":{"plateId":utf16("import:bench:duplicate")}}}).to_string()).unwrap();
    let failure = prepare_intent(&serde_json::json!({"version":1,"command":{"activatePlate":{"plateId":utf16("import:missing:plate")}}}).to_string()).unwrap();
    let change = serde_json::json!({"instanceId":source.objects[0].instances[0].id.as_utf16(),"transform":{"translationMm":[1.25,2.5,-0.5],"rotation":[0,0,0,1],"scale":[-1,1,0.5]}});
    let single = prepare_intent(&serde_json::json!({"version":1,"command":{"setInstanceTransform":{"instanceId":change["instanceId"],"transform":change["transform"],"gestureId":utf16("bench")}}}).to_string()).unwrap();
    let batch = prepare_intent(&serde_json::json!({"version":1,"command":{"setInstanceTransforms":{"changes":[change],"gestureId":utf16("bench")}}}).to_string()).unwrap();
    let object = &source.objects[0];
    let ids = serde_json::json!({
        "objectId":utf16("import:bench:object-copy"),
        "volumeIds":object.volumes.iter().enumerate().map(|(i,_)|utf16(&format!("import:bench:volume-{i}"))).collect::<Vec<_>>(),
        "instanceIds":object.instances.iter().enumerate().map(|(i,_)|utf16(&format!("import:bench:instance-{i}"))).collect::<Vec<_>>(),
        "layerRangeIds":object.layer_ranges.iter().enumerate().map(|(i,_)|utf16(&format!("import:bench:range-{i}"))).collect::<Vec<_>>()
    });
    let lifecycle = [
        serde_json::json!({"deleteObject":{"objectId":object.id.as_utf16()}}),
        serde_json::json!({"deletePlateObjects":{"plateId":source.id.as_utf16()}}),
        serde_json::json!({"deleteInstance":{"instanceId":object.instances[1].id.as_utf16()}}),
        serde_json::json!({"moveObjectToPlate":{"objectId":object.id.as_utf16(),"destinationPlateId":utf16("import:bench:destination")}}),
        serde_json::json!({"duplicateObject":{"sourceObjectId":object.id.as_utf16(),"ids":ids,"destinationPlateId":{"absent":{}},"name":{"absent":{}}}}),
        serde_json::json!({"convertInstanceToObject":{"instanceId":object.instances[1].id.as_utf16(),"ids":{"objectId":ids["objectId"],"volumeIds":ids["volumeIds"],"instanceId":ids["instanceIds"][0],"layerRangeIds":ids["layerRangeIds"]},"name":{"absent":{}}}}),
    ].map(|command| prepare_intent(&serde_json::json!({"version":1,"command":command}).to_string()).unwrap());
    let mut new_instance = (*object.instances[0]).clone();
    new_instance.id = InstanceId::try_from_str("import:bench:created-instance").unwrap();
    let captured = [
        PreparedCommand::create_instance(object.id.clone(), Arc::new(new_instance), None),
        PreparedCommand::paste_object(
            object.clone(),
            IndependentObjectIds {
                object_id: ObjectId::try_from_str("import:bench:pasted").unwrap(),
                volume_ids: object
                    .volumes
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        VolumeId::try_from_str(&format!("import:bench:pasted-volume-{i}")).unwrap()
                    })
                    .collect(),
                instance_ids: object
                    .instances
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        InstanceId::try_from_str(&format!("import:bench:pasted-instance-{i}"))
                            .unwrap()
                    })
                    .collect(),
                layer_range_ids: object
                    .layer_ranges
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        LayerRangeId::try_from_str(&format!("import:bench:pasted-range-{i}"))
                            .unwrap()
                    })
                    .collect(),
            },
            None,
            None,
        )
        .unwrap(),
    ];
    let mut bus = CommandBus::new(
        project,
        SelectionStore::default(),
        assets,
        policy,
        HistoryOptions::default(),
    );
    let mut retained = Vec::with_capacity(200);
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        let result = bus.execute(duplicate.clone(), true);
        assert!(result.result.unwrap());
        retained.extend(result.events);
        let current = bus.snapshot();
        assert!(Arc::ptr_eq(
            &current.state().plates[1].objects[0].volumes[0].annotations,
            &original_annotations
        ));
        assert!(current.state().config.same_allocation(&original_config));
        let result = bus.undo();
        assert!(result.result.unwrap());
        retained.extend(result.events);
        let result = bus.redo();
        assert!(result.result.unwrap());
        retained.extend(result.events);
        let result = bus.execute(deletion.clone(), true);
        assert!(result.result.unwrap());
        retained.extend(result.events);
        let result = bus.undo();
        assert!(result.result.unwrap());
        retained.extend(result.events);
        let result = bus.undo();
        assert!(result.result.unwrap());
        retained.extend(result.events);
        assert!(bus.snapshot().project().same_allocation(original.project()));
        let result = bus.execute_batch(
            Text::from_utf8("failed duplicate transaction"),
            vec![duplicate.clone(), failure.clone()],
        );
        assert!(result.result.is_err());
        retained.extend(result.events);
        assert!(bus.snapshot().project().same_allocation(original.project()));
        assert!(bus.assets().peek(asset.id()).unwrap().same_record(&asset));
        let result = bus.clear_history(true);
        assert!(result.result.unwrap());
        retained.extend(result.events);
    }
    for _ in 0..20 {
        for command in [&single, &batch]
            .into_iter()
            .chain(lifecycle.iter())
            .chain(captured.iter())
        {
            let outcome = bus.execute(command.clone(), true);
            assert!(outcome.result.unwrap());
            retained.extend(outcome.events);
            let current = bus.snapshot();
            for plate in current.state().plates.iter() {
                for object in plate.objects.iter() {
                    assert!(Arc::ptr_eq(
                        &object.volumes[0].annotations,
                        &original_annotations
                    ));
                }
            }
            assert!(current.state().config.same_allocation(&original_config));
            let outcome = bus.undo();
            assert!(outcome.result.unwrap());
            retained.extend(outcome.events);
            assert!(
                bus.snapshot()
                    .project()
                    .data()
                    .same_content(original.project().data())
            );
            assert!(bus.assets().peek(asset.id()).unwrap().same_record(&asset));
        }
    }
    TRACK.store(false, Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "commands copied large graph or mesh payloads"
    );
    assert!(
        largest < 1024 * 1024,
        "command path materialized a wide payload"
    );
    let revision = bus.snapshot().revision();
    let events = retained.len();
    assert_eq!(revision, 580);
    TRACK.store(true, Ordering::SeqCst);
    let public_copy = bus.assets().get(asset.id()).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        1,
        "probe detects actual public mesh copy"
    );
    drop(bus);
    assert_eq!(public_copy.bytes.len(), PAYLOAD_BYTES);
    assert!(!retained.is_empty());
    let clipboard = clipboard_probe(original.state().clone(), &asset);
    println!(
        "{{\"declaredSourceTriangles\":1897256,\"assignedTriangles\":{ASSIGNED},\"meshPayloadBytes\":{PAYLOAD_BYTES},\"configurationTextBytes\":{PAYLOAD_BYTES},\"commandCycles\":20,\"singleTransformUndoPairs\":20,\"batchTransformUndoPairs\":20,\"objectLifecycleUndoPairs\":120,\"capturedRecordUndoPairs\":40,\"retainedEvents\":{events},\"projectRevision\":{revision},\"internalAllocationBytes\":{total},\"largestInternalAllocationBytes\":{largest},\"internalPayloadAllocations\":0,\"publicCopyPayloadAllocations\":1,\"clipboard\":{clipboard}}}"
    );
}
fn clipboard_probe(mut state: ProjectState, source: &AssetLease) -> serde_json::Value {
    // This separate repository performs its public borrowed import before tracking.
    // The measured capture starts with an admitted immutable object and an 8 MiB record.
    let mut assets = AssetRepository::new();
    assets.put(source.descriptor(), source.bytes()).unwrap();
    let record = assets.peek(source.id()).unwrap();
    let object = state.plates[0].objects[0].clone();
    LARGE.store(0, Ordering::SeqCst);
    TOTAL.store(0, Ordering::SeqCst);
    LARGEST.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let clipboard = Arc::new(
        ClipboardData::capture(&state, &assets, &object.id, 1, PAYLOAD_BYTES as u64).unwrap(),
    );
    assert!(Arc::ptr_eq(clipboard.object(), &object));
    for plate in Arc::make_mut(&mut state.plates) {
        Arc::make_mut(plate).objects = Arc::from([]);
    }
    state.source_assets = Arc::from([]);
    state.thumbnails = Arc::from([]);
    state.extension_blobs = Arc::from([]);
    assets.remove(source.id());
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    );
    let project = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    let empty = project.snapshot();
    let mut bus = CommandBus::new(
        project,
        SelectionStore::default(),
        assets,
        policy,
        HistoryOptions::default(),
    );
    let ids = IndependentObjectIds {
        object_id: ObjectId::try_from_str("import:clipboard:pasted").unwrap(),
        volume_ids: object
            .volumes
            .iter()
            .enumerate()
            .map(|(i, _)| VolumeId::try_from_str(&format!("import:clipboard:volume-{i}")).unwrap())
            .collect(),
        instance_ids: object
            .instances
            .iter()
            .enumerate()
            .map(|(i, _)| {
                InstanceId::try_from_str(&format!("import:clipboard:instance-{i}")).unwrap()
            })
            .collect(),
        layer_range_ids: object
            .layer_ranges
            .iter()
            .enumerate()
            .map(|(i, _)| {
                LayerRangeId::try_from_str(&format!("import:clipboard:range-{i}")).unwrap()
            })
            .collect(),
    };
    let mut units = 0;
    for _ in 0..20 {
        units = CapturedCommand::clipboard_paste(
            clipboard.clone(),
            ids.clone(),
            None,
            16 * 1024 * 1024,
        )
        .unwrap()
        .units();
        let c = PreparedCommand::paste_clipboard(clipboard.clone(), ids.clone(), None).unwrap();
        assert!(bus.execute(c, true).result.unwrap());
        assert!(bus.assets().peek(record.id()).unwrap().same_record(&record));
        let after = bus.snapshot();
        assert!(Arc::ptr_eq(
            &after.state().plates[0].objects[0].volumes[0].annotations,
            &object.volumes[0].annotations
        ));
        assert!(bus.undo().result.unwrap());
        assert_eq!(bus.snapshot().hash(), empty.hash());
        assert!(bus.assets().is_empty());
        assert!(bus.redo().result.unwrap());
        assert_eq!(bus.snapshot().hash(), after.hash());
        assert!(bus.assets().peek(record.id()).unwrap().same_record(&record));
        assert!(bus.undo().result.unwrap());
        assert!(bus.clear_history(true).result.unwrap());
    }
    TRACK.store(false, Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "clipboard copied mesh or configuration payload"
    );
    assert!(
        largest < 1024 * 1024,
        "clipboard materialized a wide graph payload"
    );
    // A positive control on the same record detects a real public mesh copy.
    assert!(!bus.redo().result.unwrap());
    let c = PreparedCommand::paste_clipboard(clipboard, ids, None).unwrap();
    assert!(bus.execute(c, true).result.unwrap());
    TRACK.store(true, Ordering::SeqCst);
    let copy = bus.assets().get(record.id()).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(copy.bytes.len(), PAYLOAD_BYTES);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    serde_json::json!({"cycles":20,"meshPayloadBytes":PAYLOAD_BYTES,"inputUnits":units,"internalAllocationBytes":total,"largestInternalAllocationBytes":largest,"internalPayloadAllocations":0,"publicCopyPayloadAllocations":1})
}
fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
