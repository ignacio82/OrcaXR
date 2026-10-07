//! Session bundle/queue ownership evidence, not device performance.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::{
    assets::*, clipboard::ClipboardCapture, commands::staged::*, history::HistoryOptions,
    ids::InstanceId, ingress::command_work::CommandUpload, model::*, selection::*, session::*,
    staging_layout as staging, validation::*,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
const QUEUED_ID_UNITS: usize = 120_000;
const PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
static LIVE: AtomicUsize = AtomicUsize::new(0);
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
        {
            // SAFETY: Forward the caller's valid allocation layout.
            let p = unsafe { System.alloc(layout) };
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        {
            // SAFETY: Forward the caller's valid allocation layout.
            let p = unsafe { System.alloc_zeroed(layout) };
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: Forward the original System allocation and its layout.
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        {
            // SAFETY: Forward ownership, layout and requested nonzero size unchanged.
            let p = unsafe { System.realloc(pointer, layout, size) };
            if !p.is_null() {
                LIVE.fetch_add(size, Ordering::Relaxed);
                LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn object(value: &mut Value) -> &mut BTreeMap<Vec<u16>, Value> {
    let Value::Object(v) = value else { panic!() };
    v
}
fn status(response: Response, expected: &str) {
    let reply: serde_json::Value = serde_json::from_str(response.wire()).unwrap();
    assert_eq!(reply["result"]["error"], expected);
    assert!(response.events().is_empty());
}
fn main() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-command-vectors.json"
    ))
    .unwrap();
    let trace = &fixture["traces"][0];
    let mut state =
        ProjectState::from_value(parse(trace["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut descriptor = parse(trace["asset"]["descriptorJson"].as_str().unwrap()).unwrap();
    let bytes = vec![0u8; PAYLOAD_BYTES];
    object(&mut descriptor).insert(units("byteLength"), Value::Number(PAYLOAD_BYTES as f64));
    object(&mut descriptor).insert(
        units("digest"),
        Value::String(units(&content_digest(&bytes))),
    );
    object(&mut descriptor).insert(
        units("sourceFilename"),
        Value::String(vec![b'x' as u16; PAYLOAD_BYTES / 2]),
    );
    object(&mut descriptor).insert(
        units("foreign"),
        Value::Object(BTreeMap::from([
            (
                units("text"),
                Value::String(vec![b'y' as u16; PAYLOAD_BYTES / 2]),
            ),
            (
                units("wide"),
                Value::Array((0..100_000).map(|i| Value::Number(i as f64)).collect()),
            ),
        ])),
    );
    let mut assets = AssetRepository::new();
    assets.put(&descriptor, &bytes).unwrap();
    Arc::make_mut(&mut state.source_assets)[0] =
        Arc::new(SourceAssetDescriptor::from_value(descriptor).unwrap());
    let lease = assets.peek(&state.source_assets[0].id).unwrap();
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    );
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    TRACK.store(true, Ordering::SeqCst);
    let mut session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        policy,
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let guard = session.capture_guard().unwrap();
    assert!(session.is_current(&guard));
    TRACK.store(false, Ordering::SeqCst);
    let admission_bytes = TOTAL.load(Ordering::SeqCst);
    let admission_largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "bundle admission copied a known or unknown metadata payload"
    );
    let mut request = wire::SessionRequest {
        protocol_version: 1,
        generation: vec![0, 1, 2, 3],
        request_id: 1,
        operation: wire::SessionOperation::Hello(wire::Hello {
            min_protocol_version: 1,
            max_protocol_version: 1,
            project_schema_version: 1,
            intent_version: 1,
        }),
    };
    let Submission::Ready(welcome) =
        session.submit(&wire::encode_session_request(&request).unwrap())
    else {
        panic!()
    };
    drop(welcome);
    request.request_id = 2;
    request.operation = wire::SessionOperation::Query(wire::Empty {});
    assert!(matches!(
        session.submit(&wire::encode_session_request(&request).unwrap()),
        Submission::Queued { .. }
    ));
    let response = session.run_next().unwrap();
    let parsed = wire::decode_session_reply(response.wire()).unwrap();
    let wire::SessionResult::Acknowledged(ack) = parsed.result else {
        panic!()
    };
    drop(response);
    let mut long_id = units("import:queued:");
    long_id.resize(QUEUED_ID_UNITS, b'x' as u16);
    request.operation = wire::SessionOperation::Execute(wire::GuardedIntent {
        guard: ack.guard,
        intent: wire::Intent {
            version: 1,
            command: wire::Command::AddPlate(wire::AddPlate {
                plate_id: long_id,
                name: units("Queued"),
                order: 1.0,
                activate: true,
            }),
        },
    });
    let baseline = LIVE.load(Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    for id in 3..35 {
        request.request_id = id;
        assert!(matches!(
            session.submit(&wire::encode_session_request(&request).unwrap()),
            Submission::Queued { .. }
        ));
    }
    TRACK.store(false, Ordering::SeqCst);
    let retained = LIVE.load(Ordering::SeqCst) - baseline;
    assert!(
        retained >= 32 * QUEUED_ID_UNITS * 2,
        "probe actually retains all prepared ID payloads"
    );
    request.request_id = 35;
    let Submission::Ready(busy) = session.submit(&wire::encode_session_request(&request).unwrap())
    else {
        panic!()
    };
    status(busy, "busy");
    for id in 3..35 {
        let cancel = wire::SessionRequest {
            protocol_version: 1,
            generation: vec![0, 1, 2, 3],
            request_id: id + 33,
            operation: wire::SessionOperation::Cancel(wire::Cancel {
                target_request_id: id,
            }),
        };
        let Submission::Ready(reply) =
            session.submit(&wire::encode_session_request(&cancel).unwrap())
        else {
            panic!()
        };
        assert!(matches!(
            wire::decode_session_reply(reply.wire()).unwrap().result,
            wire::SessionResult::Cancelled(wire::CancelStatus::Requested)
        ));
    }
    let after_cancel = LIVE.load(Ordering::SeqCst).saturating_sub(baseline);
    assert!(
        after_cancel < 64 * 1024,
        "cancellation must drop prepared payloads before the host drains replies"
    );
    assert_eq!(session.pending_count(), 32);
    for _ in 0..32 {
        status(session.run_next().unwrap(), "cancelled");
    }
    assert_eq!(session.snapshot().revision(), 0);
    assert_eq!(session.history_revision(), 1);
    // Preparation/input decoding has its own budget. Start with each already
    // owned large record, then measure capture, admission and ready/queued release.
    session
        .configure_staging(StagingLimits {
            max_resources: 1,
            max_commands: 1,
            max_units: PAYLOAD_BYTES as u64,
            max_asset_bytes: 16_000_000,
        })
        .unwrap();
    let queued_operation = request.operation.clone();
    TOTAL.store(0, Ordering::SeqCst);
    LARGEST.store(0, Ordering::SeqCst);
    let mut staged_retained = 0;
    let mut staged_released = 0;
    for (cycle, queued) in [false, true].into_iter().enumerate() {
        let baseline = LIVE.load(Ordering::SeqCst);
        let snapshot = session.snapshot();
        let object = &snapshot.state().plates[0].objects[0];
        let mut instance = (*object.instances[0]).clone();
        instance.id = InstanceId::try_from_str("import:instance:large-staged").unwrap();
        instance.extension_data = Some(
            JsonObject::from_value(Value::Object(BTreeMap::from([(
                units("large"),
                Value::String(vec![b's' as u16; PAYLOAD_BYTES / 2]),
            )])))
            .unwrap(),
        );
        let instance = Arc::new(instance);
        let weak = Arc::downgrade(&instance);
        TRACK.store(true, Ordering::SeqCst);
        let captured =
            CapturedCommand::instance(object.id.clone(), instance, None, PAYLOAD_BYTES as u64)
                .unwrap();
        let charge = captured.units();
        let id = session.stage(&guard, StagedWork::single(captured)).unwrap();
        assert_eq!(
            session.staging_usage(),
            StagingUsage {
                resources: 1,
                commands: 1,
                units: charge,
                asset_bytes: 0,
            }
        );
        staged_retained = staged_retained.max(LIVE.load(Ordering::SeqCst) - baseline);
        if queued {
            request.request_id = 70 + cycle as u64 * 2;
            request.operation =
                wire::SessionOperation::ExecuteStaged(wire::StagedReference { staged_id: id });
            let encoded = wire::encode_session_request(&request).unwrap();
            assert!(matches!(
                session.submit(&encoded),
                Submission::Queued { .. }
            ));
            assert!(
                !session.release_staged(id),
                "accepted work belongs to its queued request"
            );
            assert_eq!(session.staging_usage().units, charge);
            let cancel = wire::SessionRequest {
                operation: wire::SessionOperation::Cancel(wire::Cancel {
                    target_request_id: request.request_id,
                }),
                request_id: request.request_id + 1,
                ..request.clone()
            };
            assert!(matches!(
                session.submit(&wire::encode_session_request(&cancel).unwrap()),
                Submission::Ready(_)
            ));
            assert_eq!(session.pending_count(), 1);
        } else {
            assert!(session.release_staged(id));
        }
        assert_eq!(session.staging_usage(), StagingUsage::default());
        assert!(
            weak.upgrade().is_none(),
            "release destroys the full record before queued settlement"
        );
        let remaining = LIVE.load(Ordering::SeqCst).saturating_sub(baseline);
        staged_released = staged_released.max(remaining);
        assert!(remaining < 64 * 1024);
        if queued {
            status(session.run_next().unwrap(), "cancelled");
        }
        TRACK.store(false, Ordering::SeqCst);
    }
    assert!(staged_retained >= PAYLOAD_BYTES);
    let staged_allocation = TOTAL.load(Ordering::SeqCst);
    let staged_largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "measuring/queuing a captured record must not copy its metadata"
    );
    let clipboard = clipboard_preparation(&mut session, &guard);
    // Restore the large small-intent input for the independent close probe.
    request.operation = queued_operation;
    let baseline = LIVE.load(Ordering::SeqCst);
    for id in 100..132 {
        request.request_id = id;
        assert!(matches!(
            session.submit(&wire::encode_session_request(&request).unwrap()),
            Submission::Queued { .. }
        ));
    }
    session.dispose();
    let after_close = LIVE.load(Ordering::SeqCst).saturating_sub(baseline);
    assert!(
        after_close < 64 * 1024,
        "close must release queued payloads before draining"
    );
    for _ in 0..32 {
        status(session.run_next().unwrap(), "disposed");
    }
    assert!(
        session
            .assets()
            .peek(lease.id())
            .unwrap()
            .same_record(&lease)
    );
    assert_eq!(LARGE.load(Ordering::SeqCst), 0);
    TRACK.store(true, Ordering::SeqCst);
    let copy = session.assets().get(lease.id()).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        3,
        "public get copies the mesh and both metadata strings"
    );
    assert_eq!(copy.bytes.len(), PAYLOAD_BYTES);
    let adoption = document_adoption(session.snapshot().project().clone(), &lease);
    drop(session);
    assert_eq!(lease.bytes().len(), PAYLOAD_BYTES);
    println!(
        "{{\"meshPayloadBytes\":{PAYLOAD_BYTES},\"eachMetadataStringBytes\":{PAYLOAD_BYTES},\"admissionAllocationBytes\":{admission_bytes},\"largestAdmissionAllocationBytes\":{admission_largest},\"queuedRequests\":32,\"preparedIdUnits\":{QUEUED_ID_UNITS},\"queueRetainedBytes\":{retained},\"afterCancellationRetainedBytes\":{after_cancel},\"afterCloseRetainedBytes\":{after_close},\"stagedRecordRetainedBytes\":{staged_retained},\"stagedRecordAfterReleaseBytes\":{staged_released},\"stagedAllocationBytes\":{staged_allocation},\"stagedLargestAllocationBytes\":{staged_largest},\"internalPayloadAllocations\":0,\"publicCopyPayloadAllocations\":3,\"clipboardPreparation\":{clipboard},\"documentAdoption\":{adoption}}}"
    );
}
fn clipboard_preparation<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    guard: &LocalGuard,
) -> serde_json::Value {
    session
        .configure_staging(StagingLimits {
            max_resources: 1,
            max_commands: 1,
            max_units: 16 * 1024 * 1024,
            max_asset_bytes: 16_000_000,
        })
        .unwrap();
    let snapshot = session.snapshot();
    let node = orcaxr_project::query::QueryNode::new(snapshot.clone())
        .children(orcaxr_project::query::layout::Relation::Plates, 1)
        .unwrap()
        .node(0)
        .unwrap()
        .children(orcaxr_project::query::layout::Relation::Objects, 0)
        .unwrap()
        .node(0)
        .unwrap();
    let object = &snapshot.state().plates[0].objects[0];
    let data = serde_json::json!([
        staging::VERSION,
        [
            staging::WORK_SINGLE,
            [
                staging::COMMAND_CLIPBOARD_PASTE,
                "import:object:clipboard-bench",
                object
                    .volumes
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("import:volume:clipboard-{i}"))
                    .collect::<Vec<_>>(),
                object
                    .instances
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("import:instance:clipboard-{i}"))
                    .collect::<Vec<_>>(),
                object
                    .layer_ranges
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("import:range:clipboard-{i}"))
                    .collect::<Vec<_>>(),
                null,
            ]
        ]
    ])
    .to_string()
    .into_bytes();
    TOTAL.store(0, Ordering::SeqCst);
    LARGEST.store(0, Ordering::SeqCst);
    let mut charge = 0;
    let mut remaining = 0;
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        let baseline = LIVE.load(Ordering::SeqCst);
        let clip = ClipboardCapture::from_query(
            session,
            guard,
            &node,
            staging::ClipboardOptions {
                assets: 1,
                bytes: PAYLOAD_BYTES,
            },
        )
        .unwrap();
        let weak = Arc::downgrade(&clip.data());
        let mut input = CommandUpload::new_clipboard(
            session,
            guard.clone(),
            clip.data(),
            data.len(),
            staging::InputOptions {
                bytes: data.len(),
                nodes: 1000,
                text_units: 4096,
                number_bytes: 128,
                depth: 16,
                commands: 1,
                input_units: 16 * 1024 * 1024,
                assets: 64,
                asset_bytes: 16_000_000,
            },
        )
        .unwrap();
        drop(clip);
        for (i, chunk) in data.chunks(7).enumerate() {
            input.append(i * 7, chunk).unwrap();
        }
        input.seal().unwrap();
        charge = input.units().unwrap();
        assert!(
            charge > PAYLOAD_BYTES as u64,
            "probe retains both large descriptor strings"
        );
        let id = input.admit(session).unwrap();
        assert!(weak.upgrade().is_some());
        assert!(session.release_staged(id));
        assert!(
            weak.upgrade().is_none(),
            "ready release must destroy the clipboard capture"
        );
        remaining = remaining.max(LIVE.load(Ordering::SeqCst).saturating_sub(baseline));
        assert!(remaining < 64 * 1024);
    }
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "clipboard capture/upload copied source payloads"
    );
    serde_json::json!({"cycles":20,"uploadBytes":data.len(),"inputUnits":charge,"internalAllocationBytes":TOTAL.load(Ordering::SeqCst),"largestInternalAllocationBytes":LARGEST.load(Ordering::SeqCst),"afterReleaseBytes":remaining,"internalPayloadAllocations":0})
}

fn document_adoption(project: ValidatedProject, source: &AssetLease) -> serde_json::Value {
    let repository = || {
        let mut assets = AssetRepository::new();
        assets
            .put_owned(AssetPayload {
                descriptor: source.descriptor().clone(),
                bytes: source.bytes().to_vec(),
            })
            .unwrap();
        assets
    };
    let mut owner = ProjectSession::new(
        project.clone(),
        SelectionStore::default(),
        repository(),
        V8Timestamps::new(
            timestamp::V8IntegerMode::Smi32,
            |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
        ),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    LARGE.store(0, Ordering::SeqCst);
    TOTAL.store(0, Ordering::SeqCst);
    LARGEST.store(0, Ordering::SeqCst);
    for index in 0..20 {
        // The input transfer owns its allocation before preparation/adoption.
        // Measure bundle proof/fingerprinting and commit, not creation of test data.
        let assets = repository();
        let lease = assets.peek(source.id()).unwrap();
        TRACK.store(true, Ordering::SeqCst);
        let document = PreparedDocument::new(project.clone(), assets).unwrap();
        let ticket = owner.begin_open().unwrap();
        let events = owner.finish_open(&ticket, document).unwrap();
        assert_eq!(owner.snapshot().revision(), index + 1);
        assert!(owner.snapshot().project().same_allocation(&project));
        assert!(
            owner
                .assets()
                .peek(source.id())
                .unwrap()
                .same_record(&lease)
        );
        drop(events);
        drop(ticket);
        TRACK.store(false, Ordering::SeqCst);
    }
    let total = TOTAL.load(Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "adoption must move admitted records without payload copies"
    );
    TRACK.store(true, Ordering::SeqCst);
    let copied = owner.assets().get(source.id()).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 3);
    drop(copied);
    serde_json::json!({"cycles":20,"internalAllocationBytes":total,"largestInternalAllocationBytes":largest,"internalPayloadAllocations":0,"publicCopyPayloadAllocations":3})
}
