use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    clipboard::*,
    commands::{staged::*, *},
    history::*,
    ids::*,
    model::*,
    selection::*,
    store::*,
    validation::*,
};
use orcaxr_project::{
    session::{ProjectSession, StagingLimits},
    staging_layout as staging,
};
use std::{cell::Cell, rc::Rc, sync::Arc};
static HOST_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn source() -> (ProjectState, AssetRepository) {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-clipboard-vectors.json"
    ))
    .unwrap();
    let source = &f["traces"][0]["clipboard"];
    let state =
        ProjectState::from_value(parse(source["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut assets = AssetRepository::new();
    for p in source["assets"].as_array().unwrap() {
        assets
            .put_owned(AssetPayload {
                descriptor: parse(p["descriptorJson"].as_str().unwrap()).unwrap(),
                bytes: p["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u8)
                    .collect(),
            })
            .unwrap();
    }
    (state, assets)
}
fn ids(object: &ProjectObject) -> IndependentObjectIds {
    IndependentObjectIds {
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
    }
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    )
}
fn capture(state: &ProjectState, assets: &AssetRepository) -> ClipboardData {
    ClipboardData::capture(state, assets, &state.plates[0].objects[0].id, 2, 4096).unwrap()
}
fn clear(state: &mut ProjectState, assets: &mut AssetRepository) {
    for plate in Arc::make_mut(&mut state.plates) {
        Arc::make_mut(plate).objects = Arc::from([]);
    }
    state.source_assets = Arc::from([]);
    for id in assets.ids().cloned().collect::<Vec<_>>() {
        assets.remove(&id);
    }
}

#[test]
fn capture_shares_only_selected_records_and_refuses_inconsistent_sources() {
    let (mut state, mut assets) = source();
    let id = state.plates[0].objects[0].id.clone();
    let capture = capture(&state, &assets);
    assert!(Arc::ptr_eq(capture.object(), &state.plates[0].objects[0]));
    assert_eq!(capture.assets().len(), 2);
    assert_eq!(assets.len(), 3);
    let leases = capture.assets().leases().collect::<Vec<_>>();
    assert_eq!(leases[0].id(), &capture.object().volumes[0].source.asset_id);
    assert_eq!(
        leases[1].id(),
        &capture.object().volumes[0]
            .emboss_svg
            .as_ref()
            .unwrap()
            .drawing_asset_id
    );
    for (d, lease) in capture.descriptors().iter().zip(&leases) {
        assert!(lease.same_record(&assets.peek(lease.id()).unwrap()));
        assert!(Arc::ptr_eq(
            d,
            state.source_assets.iter().find(|v| v.id == d.id).unwrap()
        ));
    }
    let version = assets.capture_internal();
    let total = capture.assets().byte_length();
    for (count, bytes) in [(0, total), (1, total), (2, total - 1)] {
        assert_eq!(
            ClipboardData::capture(&state, &assets, &id, count, bytes).err(),
            Some(ClipboardError::Asset(AssetError::SelectionLimit))
        );
    }
    assert!(ClipboardData::capture(&state, &assets, &id, 2, total).is_ok());
    assert_eq!(
        ClipboardData::capture(
            &state,
            &assets,
            &ObjectId::try_from_str("import:object:missing").unwrap(),
            2,
            total
        )
        .err(),
        Some(ClipboardError::MissingObject)
    );
    let original = state.source_assets.clone();
    state.source_assets = state
        .source_assets
        .iter()
        .filter(|d| &d.id != leases[1].id())
        .cloned()
        .collect();
    assert_eq!(
        ClipboardData::capture(&state, &assets, &id, 2, total).err(),
        Some(ClipboardError::MissingDeclaration)
    );
    state.source_assets = original;
    let descriptor = Arc::make_mut(&mut Arc::make_mut(&mut state.source_assets)[0]);
    descriptor.source_filename = Some(Text::from_utf8("changed.stl"));
    assert_eq!(
        ClipboardData::capture(&state, &assets, &id, 2, total).err(),
        Some(ClipboardError::MetadataMismatch)
    );
    assert!(assets.capture_internal().same_version(&version));
    assets.remove(leases[0].id());
    assert_eq!(
        ClipboardData::capture(&state, &assets, &id, 2, total).err(),
        Some(ClipboardError::Asset(AssetError::MissingAsset))
    );
    // The object and selected declarations survive, but no entire plate is retained.
    let plate = Arc::downgrade(&state.plates[0]);
    drop(state);
    assert!(plate.upgrade().is_none());
    assert_eq!(capture.object().id, id);
}

#[test]
fn repository_subsets_are_bounded_owner_bound_and_all_conflicts_precede_publication() {
    let (state, mut assets) = source();
    let capture = capture(&state, &assets);
    let ids = capture
        .assets()
        .leases()
        .map(|l| l.id().clone())
        .collect::<Vec<_>>();
    let version = assets.capture_internal();
    assert!(!assets.merge_selection(capture.assets()).unwrap());
    assert!(assets.capture_internal().same_version(&version));
    assert_eq!(
        assets
            .capture_selection(&[ids[0].clone(), ids[0].clone()], 2, u64::MAX)
            .err(),
        Some(AssetError::DuplicateId)
    );
    assert_eq!(
        assets.capture_selection(&ids, 1, u64::MAX).err(),
        Some(AssetError::SelectionLimit)
    );
    assert!(assets.capture_selection(&[], 0, 0).unwrap().is_empty());
    for id in &ids {
        assets.remove(id);
    }
    let second = capture.assets().leases().nth(1).unwrap();
    let mut changed = second.descriptor().clone();
    let Value::Object(fields) = &mut changed else {
        panic!()
    };
    fields.insert(
        "sourceFilename".encode_utf16().collect(),
        Value::String("conflict.svg".encode_utf16().collect()),
    );
    assets.put(&changed, second.bytes()).unwrap();
    let before = assets.capture_internal();
    assert_eq!(
        assets.merge_selection(capture.assets()),
        Err(AssetError::ImmutableConflict)
    );
    assert!(assets.capture_internal().same_version(&before));
    assert!(!assets.has(&ids[0]));
    assets.remove(&ids[1]);
    assert!(assets.merge_selection(capture.assets()).unwrap());
    for lease in capture.assets().leases() {
        assert!(assets.peek(lease.id()).unwrap().same_record(&lease));
    }
    let mut foreign = AssetRepository::new();
    assert_eq!(
        foreign.merge_selection(capture.assets()),
        Err(AssetError::ForeignSelection)
    );
    drop(assets);
    assert_eq!(
        foreign.merge_selection(capture.assets()),
        Err(AssetError::ForeignSelection)
    );
    assert!(foreign.is_empty());
}

#[test]
fn captured_units_have_exact_boundaries_and_do_not_charge_asset_payload_as_json() {
    let (state, assets) = source();
    let clipboard = Arc::new(capture(&state, &assets));
    let ids = ids(clipboard.object());
    let units = CapturedCommand::clipboard_paste(clipboard.clone(), ids.clone(), None, u64::MAX)
        .unwrap()
        .units();
    assert!(matches!(
        CapturedCommand::clipboard_paste(clipboard.clone(), ids.clone(), None, units - 1),
        Err(CaptureError::Limit)
    ));
    assert_eq!(
        CapturedCommand::clipboard_paste(clipboard.clone(), ids.clone(), None, units)
            .unwrap()
            .units(),
        units
    );
    let c =
        || CapturedCommand::clipboard_paste(clipboard.clone(), ids.clone(), None, units).unwrap();
    let total = StagedWork::transaction(Text::from_utf8("Paste pair"), vec![c(), c()], u64::MAX)
        .unwrap()
        .units();
    assert!(matches!(
        StagedWork::transaction(Text::from_utf8("Paste pair"), vec![c(), c()], total - 1),
        Err(CaptureError::Limit)
    ));
    assert_eq!(
        StagedWork::transaction(Text::from_utf8("Paste pair"), vec![c(), c()], total)
            .unwrap()
            .command_count(),
        2
    );
}

#[test]
fn failed_apply_undo_and_redo_restore_asset_versions_and_remain_retryable() {
    let (mut state, mut assets) = source();
    let clipboard = Arc::new(capture(&state, &assets));
    let ids = ids(clipboard.object());
    clear(&mut state, &mut assets);
    let fail = Rc::new(Cell::new(false));
    let trigger = fail.clone();
    let mut timestamps = utc();
    let mut policy = move |text: &[u16]| {
        if trigger.replace(false) {
            Err(())
        } else {
            timestamps.is_valid(text)
        }
    };
    let store = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    let mut bus = CommandBus::new(
        store,
        SelectionStore::default(),
        assets,
        policy,
        HistoryOptions::default(),
    );
    let command = PreparedCommand::paste_clipboard(clipboard.clone(), ids, None).unwrap();
    let before = bus.snapshot();
    let empty = bus.assets().capture_internal();
    fail.set(true);
    let outcome = bus.execute(command.clone(), true);
    assert!(matches!(
        outcome.result,
        Err(CommandError::Admission(AdmissionError::Timestamp(())))
    ));
    assert_eq!(bus.snapshot().hash(), before.hash());
    assert!(bus.assets().capture_internal().same_version(&empty));
    assert_eq!(bus.history().undo_count, 0);
    assert!(bus.execute(command, true).result.unwrap());
    let after = bus.snapshot();
    let full = bus.assets().capture_internal();
    let selection = bus.selection();
    fail.set(true);
    assert!(bus.undo().result.is_err());
    assert_eq!(bus.snapshot().hash(), after.hash());
    assert!(bus.assets().capture_internal().same_version(&full));
    assert_eq!(bus.selection().refs(), selection.refs());
    assert_eq!(bus.history().undo_count, 1);
    assert!(bus.undo().result.unwrap());
    assert!(bus.assets().is_empty());
    let empty = bus.assets().capture_internal();
    fail.set(true);
    assert!(bus.redo().result.is_err());
    assert_eq!(bus.snapshot().hash(), before.hash());
    assert!(bus.assets().capture_internal().same_version(&empty));
    assert_eq!(bus.history().redo_count, 1);
    assert!(bus.redo().result.unwrap());
    assert_eq!(bus.snapshot().hash(), after.hash());
    for lease in clipboard.assets().leases() {
        assert!(bus.assets().peek(lease.id()).unwrap().same_record(&lease));
    }
}

#[test]
fn host_capture_permits_cover_concurrent_owners_and_release_on_every_failure() {
    let _test = HOST_TEST.lock().unwrap();
    let (state, assets) = source();
    let owner = ProjectSession::new(
        ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let guard = owner.capture_guard().unwrap();
    let limits = staging::ClipboardOptions {
        assets: 2,
        bytes: 4096,
    };
    for _ in 0..10 {
        assert!(matches!(
            ClipboardCapture::new(&owner, &guard, 1, 0, limits),
            Err(ClipboardHostError::InvalidIndex)
        ));
        assert!(matches!(
            ClipboardCapture::new(
                &owner,
                &guard,
                0,
                0,
                staging::ClipboardOptions {
                    assets: 1,
                    ..limits
                }
            ),
            Err(ClipboardHostError::Capture(ClipboardError::Asset(
                AssetError::SelectionLimit
            )))
        ));
    }
    let held = std::thread::scope(|scope| {
        let barrier = Arc::new(std::sync::Barrier::new(staging::MAX_CLIPBOARDS + 1));
        let threads = (0..=staging::MAX_CLIPBOARDS)
            .map(|_| {
                let barrier = barrier.clone();
                let owner = &owner;
                let guard = &guard;
                scope.spawn(move || {
                    barrier.wait();
                    ClipboardCapture::new(owner, guard, 0, 0, limits)
                })
            })
            .collect::<Vec<_>>();
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        held.iter().filter(|r| r.is_ok()).count(),
        staging::MAX_CLIPBOARDS
    );
    let data = held.iter().find_map(|r| r.as_ref().ok()).unwrap().data();
    drop(held);
    // Immutable data retained by a command must not retain host clipboard permits.
    let held = (0..staging::MAX_CLIPBOARDS)
        .map(|_| ClipboardCapture::new(&owner, &guard, 0, 0, limits).unwrap())
        .collect::<Vec<_>>();
    assert!(held.iter().all(|v| v.info() == [2., 1., 1., 2., 57.]));
    assert_eq!(data.assets().len(), 2);
    drop(held);
    for version in [0., 2., -1., f64::NAN] {
        assert!(staging::decode_clipboard(version, &[2., 4096.]).is_none());
    }
    for n in [-1., 0.5, f64::INFINITY, f64::NAN, 4_294_967_296.] {
        assert!(staging::decode_clipboard(1., &[n, 4096.]).is_none());
        assert!(staging::decode_clipboard(1., &[2., n]).is_none());
    }
    assert!(staging::decode_clipboard(1., &[0., 0.]).is_some());
    assert!(staging::decode_clipboard(1., &[1.]).is_none());
    assert!(staging::decode_clipboard(1., &[1., 2., 3.]).is_none());
}

#[test]
fn host_capture_resolves_sorted_query_nodes_and_requires_the_current_graph() {
    use orcaxr_project::query::{QueryNode, layout::Relation};
    use orcaxr_project::session::Submission;
    use serde_json::json;
    let _test = HOST_TEST.lock().unwrap();
    let setup = || {
        let (mut state, assets) = source();
        let mut plates = state.plates.to_vec();
        Arc::make_mut(&mut plates[0]).order = Number::new(4.).unwrap();
        let mut empty = (*plates[0]).clone();
        empty.id = PlateId::try_from_str("import:plate:before").unwrap();
        empty.order = Number::new(0.).unwrap();
        empty.objects = Arc::from([]);
        plates.push(Arc::new(empty));
        state.plates = plates.into();
        ProjectSession::new(
            ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions::default(),
            [0, 1, 2, 3],
        )
        .unwrap()
    };
    let mut owner = setup();
    let foreign = setup();
    let object = |root: &QueryNode| {
        root.children(Relation::Plates, 2)
            .unwrap()
            .node(1)
            .unwrap()
            .children(Relation::Objects, 0)
            .unwrap()
            .node(0)
            .unwrap()
    };
    let root = QueryNode::new(owner.snapshot());
    let node = object(&root);
    let guard = owner.capture_guard().unwrap();
    let limits = staging::ClipboardOptions {
        assets: 2,
        bytes: 57,
    };
    for wrong in [
        root.clone(),
        root.children(Relation::Plates, 2).unwrap().node(1).unwrap(),
    ] {
        assert!(matches!(
            ClipboardCapture::from_query(&owner, &guard, &wrong, limits),
            Err(ClipboardHostError::InvalidTarget)
        ));
    }
    let foreign_node = object(&QueryNode::new(foreign.snapshot()));
    assert!(matches!(
        ClipboardCapture::from_query(&owner, &guard, &foreign_node, limits),
        Err(ClipboardHostError::Stale)
    ));
    let captured = ClipboardCapture::from_query(&owner, &guard, &node, limits).unwrap();
    assert_eq!(captured.info(), [2., 1., 1., 2., 57.]);
    assert!(Arc::ptr_eq(
        captured.data().object(),
        &owner.snapshot().state().plates[0].objects[0]
    ));
    owner.acknowledge_checkpoint(&guard).unwrap();
    assert!(matches!(
        ClipboardCapture::from_query(&owner, &guard, &node, limits),
        Err(ClipboardHostError::Stale)
    ));
    let current = owner.capture_guard().unwrap();
    // History-only changes require a fresh guard but preserve graph query validity.
    drop(ClipboardCapture::from_query(&owner, &current, &node, limits).unwrap());
    owner
        .configure_staging(StagingLimits {
            max_resources: 1,
            max_commands: 1,
            max_units: 4_000_000,
        })
        .unwrap();
    let work = StagedWork::single(
        CapturedCommand::clipboard_paste(
            captured.data(),
            ids(captured.data().object()),
            None,
            4_000_000,
        )
        .unwrap(),
    );
    let staged = owner.stage(&current, work).unwrap();
    let wire = |id, operation| {
        json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":id,"operation":operation})
            .to_string()
    };
    assert!(matches!(owner.submit(&wire(1, json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}))), Submission::Ready(_)));
    assert!(matches!(
        owner.submit(&wire(2, json!({"executeStaged":{"stagedId":staged}}))),
        Submission::Queued { .. }
    ));
    let reply = owner.run_next().unwrap();
    assert!(
        serde_json::from_str::<serde_json::Value>(reply.wire()).unwrap()["result"]
            .get("acknowledged")
            .is_some()
    );
    let current = owner.capture_guard().unwrap();
    assert!(matches!(
        ClipboardCapture::from_query(&owner, &current, &node, limits),
        Err(ClipboardHostError::Stale)
    ));
    drop(
        ClipboardCapture::from_query(
            &owner,
            &current,
            &object(&QueryNode::new(owner.snapshot())),
            limits,
        )
        .unwrap(),
    );
}

#[test]
fn detached_clipboard_preparation_shares_owner_quota_and_never_reads_live_state() {
    use orcaxr_project::query::{QueryNode, layout::Relation};
    let _test = HOST_TEST.lock().unwrap();
    let setup = || {
        let (state, assets) = source();
        ProjectSession::new(
            ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions::default(),
            [0, 1, 2, 3],
        )
        .unwrap()
    };
    let mut owner = setup();
    let guard = owner.capture_guard().unwrap();
    let limits = staging::ClipboardOptions {
        assets: 2,
        bytes: 57,
    };
    let object = |root: &QueryNode| {
        root.children(Relation::Plates, 2)
            .unwrap()
            .node(0)
            .unwrap()
            .children(Relation::Objects, 0)
            .unwrap()
            .node(0)
            .unwrap()
    };
    let root = QueryNode::new(owner.snapshot());
    let node = object(&root);
    let foreign = object(&QueryNode::new(setup().snapshot()));
    for _ in 0..10 {
        assert!(matches!(
            ClipboardPreparation::new(&owner, &guard, limits)
                .unwrap()
                .capture(&root),
            Err(ClipboardHostError::InvalidTarget)
        ));
        assert!(matches!(
            ClipboardPreparation::new(&owner, &guard, limits)
                .unwrap()
                .capture(&foreign),
            Err(ClipboardHostError::Stale)
        ));
        assert!(matches!(
            ClipboardPreparation::new(
                &owner,
                &guard,
                staging::ClipboardOptions {
                    assets: 1,
                    bytes: 57
                }
            )
            .unwrap()
            .capture(&node),
            Err(ClipboardHostError::Capture(ClipboardError::Asset(
                AssetError::SelectionLimit
            )))
        ));
    }
    let mut inputs = (0..staging::MAX_CLIPBOARDS)
        .map(|_| ClipboardPreparation::new(&owner, &guard, limits).unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(
        ClipboardPreparation::new(&owner, &guard, limits),
        Err(ClipboardHostError::Limit)
    ));
    let finished = inputs.pop().unwrap().capture(&node).unwrap();
    assert!(matches!(
        ClipboardCapture::from_query(&owner, &guard, &node, limits),
        Err(ClipboardHostError::Limit)
    ));
    drop(finished);
    let late = ClipboardPreparation::new(&owner, &guard, limits).unwrap();
    drop(inputs);
    owner.acknowledge_checkpoint(&guard).unwrap();
    assert!(!owner.is_current(&guard));
    assert!(matches!(
        ClipboardPreparation::new(&owner, &guard, limits),
        Err(ClipboardHostError::Stale)
    ));
    // Only frozen project/asset data and its permit cross to the preparation
    // thread. Completion cannot read, mutate or retain a live session.
    drop(owner);
    let captured = std::thread::spawn(move || late.capture(&node).unwrap())
        .join()
        .unwrap();
    assert_eq!(captured.info(), [2., 1., 1., 2., 57.]);
    assert_eq!(
        captured
            .data()
            .assets()
            .leases()
            .map(|v| v.bytes().len())
            .sum::<usize>(),
        57
    );
}
