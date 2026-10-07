use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, commands::staged::*, history::*, ids::*, model::*, selection::*, session::*,
    validation::*,
};
use serde_json::{Value, json};
use std::sync::{Arc, Weak};
const NONCE: [u32; 4] = [0, 1, 2147483648, 4294967295];
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok(v.civil_milliseconds()),
    )
}
fn setup(large: bool) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-captured-command-vectors.json"
    ))
    .unwrap();
    let f = &f["traces"][0];
    let mut state =
        ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    if large {
        state.id =
            ProjectId::try_from_str(&format!("import:large:{}", "x".repeat(131_072))).unwrap();
    }
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(f["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &f["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    ProjectSession::new(
        ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        NONCE,
    )
    .unwrap()
}
fn limits() -> StagingLimits {
    StagingLimits {
        max_resources: 4,
        max_commands: 100,
        max_units: 8_000_000,
        max_asset_bytes: 16_000_000,
    }
}
fn captured<P: TimestampPolicy>(
    session: &ProjectSession<P>,
    suffix: &str,
) -> (CapturedCommand, Weak<ProjectInstance>) {
    let state = session.snapshot();
    let object = &state.state().plates[0].objects[0];
    let mut instance = (*object.instances[0]).clone();
    instance.id = InstanceId::try_from_str(&format!("import:instance:{suffix}")).unwrap();
    let instance = Arc::new(instance);
    let weak = Arc::downgrade(&instance);
    (
        CapturedCommand::instance(object.id.clone(), instance, None, 4_000_000).unwrap(),
        weak,
    )
}
fn work<P: TimestampPolicy>(
    session: &ProjectSession<P>,
    suffix: &str,
) -> (StagedWork, Weak<ProjectInstance>) {
    let (c, w) = captured(session, suffix);
    (StagedWork::single(c), w)
}
fn submit<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    sequence: &mut u64,
    operation: Value,
) -> Submission {
    *sequence += 1;
    session.submit(
        &json!({"protocolVersion":1,"generation":NONCE,"requestId":sequence,"operation":operation})
            .to_string(),
    )
}
fn reply(response: Response) -> Value {
    serde_json::from_str::<Value>(response.wire()).unwrap()["result"].clone()
}
fn run<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    sequence: &mut u64,
    operation: Value,
) -> Value {
    assert_eq!(session.pending_count(), 0);
    match submit(session, sequence, operation) {
        Submission::Ready(r) => reply(r),
        Submission::Queued { .. } => reply(session.run_next().unwrap()),
    }
}
fn hello<P: TimestampPolicy>(session: &mut ProjectSession<P>, sequence: &mut u64) {
    assert!(run(session,sequence,json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}})).get("welcome").is_some());
}
fn stage<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    suffix: &str,
) -> (u64, Weak<ProjectInstance>) {
    let (work, weak) = work(session, suffix);
    (
        session
            .stage(&session.capture_guard().unwrap(), work)
            .unwrap(),
        weak,
    )
}
#[test]
fn capture_charges_all_arguments_and_rejects_exact_budget_underflow() {
    let mut session = setup(false);
    session.configure_staging(limits()).unwrap();
    let snapshot = session.snapshot();
    let object = &snapshot.state().plates[0].objects[0];
    let record = object.instances[0].clone();
    let mut encoded = Vec::new();
    record.write_json(&mut encoded).unwrap();
    let args = format!(
        "[\"createInstance\",{},{}{}]",
        String::from_utf8({
            let mut b = Vec::new();
            object.id.write_json(&mut b).unwrap();
            b
        })
        .unwrap(),
        String::from_utf8(encoded).unwrap(),
        ",null"
    );
    let expected = args.encode_utf16().count() as u64;
    assert_eq!(
        CapturedCommand::instance(object.id.clone(), record.clone(), None, expected)
            .unwrap()
            .units(),
        expected
    );
    assert!(matches!(
        CapturedCommand::instance(object.id.clone(), record, None, expected - 1),
        Err(CaptureError::Limit)
    ));
    let (c, _) = captured(&session, "batch");
    let charge = c.units();
    let label = Text::new(vec![0xd83d, 0xde00, 0xd800]);
    let mut bytes = vec![];
    label.write_json(&mut bytes).unwrap();
    let units = 5 + String::from_utf8(bytes).unwrap().encode_utf16().count() as u64 + charge;
    assert_eq!(
        StagedWork::transaction(label, vec![c], units)
            .unwrap()
            .units(),
        units
    );
    let c = CapturedCommand::intent(
        r#"{"version":1,"command":{"activatePlate":{"plateId":[105,109,112,111,114,116,58,112,58,120]}}}"#,
        10,
    );
    assert!(matches!(c, Err(CaptureError::Limit)));
}
#[test]
fn finished_input_is_disabled_by_default_and_counts_ready_and_queued_work() {
    let mut session = setup(false);
    let mut seq = 0;
    let (w, weak) = work(&session, "disabled");
    assert_eq!(
        session
            .stage(&session.capture_guard().unwrap(), w)
            .unwrap_err(),
        wire::SessionError::ResourceLimit
    );
    assert!(weak.upgrade().is_none());
    session
        .configure_staging(StagingLimits {
            max_resources: 1,
            ..limits()
        })
        .unwrap();
    hello(&mut session, &mut seq);
    let (id, _) = stage(&mut session, "first");
    assert_eq!(id, 1);
    let usage = session.staging_usage();
    assert_eq!(usage.resources, 1);
    assert_eq!(usage.commands, 1);
    assert!(matches!(
        submit(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}})
        ),
        Submission::Queued { .. }
    ));
    assert_eq!(session.staging_usage(), usage);
    assert!(!session.release_staged(id));
    let (w, weak) = work(&session, "excess");
    assert_eq!(
        session
            .stage(&session.capture_guard().unwrap(), w)
            .unwrap_err(),
        wire::SessionError::ResourceLimit
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(
        session.configure_staging(StagingLimits::default()),
        Err(wire::SessionError::Busy)
    );
    assert_eq!(session.staging_usage(), usage);
    assert!(
        reply(session.run_next().unwrap())
            .get("acknowledged")
            .is_some()
    );
    assert_eq!(session.staging_usage(), StagingUsage::default());
    let (next, weak) = stage(&mut session, "next");
    assert!(next > id);
    assert_eq!(
        run(
            &mut session,
            &mut seq,
            json!({"releaseStaged":{"stagedId":next}})
        ),
        json!({"released":true})
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(
        run(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}})
        ),
        json!({"error":"invalidRequest"})
    );
    assert_eq!(
        run(
            &mut session,
            &mut seq,
            json!({"releaseStaged":{"stagedId":next}})
        ),
        json!({"released":false})
    );
}
#[test]
fn cancellation_and_close_drop_payloads_before_bounded_queue_settlement() {
    for close in [false, true] {
        let mut session = setup(false);
        session.configure_staging(limits()).unwrap();
        let mut seq = 0;
        hello(&mut session, &mut seq);
        let (id, weak) = stage(&mut session, "queued");
        assert!(weak.upgrade().is_some());
        assert!(matches!(
            submit(
                &mut session,
                &mut seq,
                json!({"executeStaged":{"stagedId":id}})
            ),
            Submission::Queued { .. }
        ));
        let target = seq;
        let control = if close {
            json!({"close":{}})
        } else {
            json!({"cancel":{"targetRequestId":target}})
        };
        assert!(matches!(
            submit(&mut session, &mut seq, control),
            Submission::Ready(_)
        ));
        assert!(weak.upgrade().is_none());
        assert_eq!(session.staging_usage(), StagingUsage::default());
        assert_eq!(session.pending_count(), 1);
        assert_eq!(
            reply(session.run_next().unwrap()),
            json!({"error":if close{"disposed"}else{"cancelled"}})
        );
        assert_eq!(session.pending_count(), 0);
    }
}
#[test]
fn all_admission_limits_and_owner_guards_precede_publication() {
    for limit in [
        StagingLimits {
            max_commands: 0,
            ..limits()
        },
        StagingLimits {
            max_units: 1,
            ..limits()
        },
        StagingLimits {
            max_resources: 0,
            ..limits()
        },
    ] {
        let mut session = setup(false);
        session.configure_staging(limit).unwrap();
        let before = session.snapshot();
        let (w, weak) = work(&session, "refuse");
        assert_eq!(
            session
                .stage(&session.capture_guard().unwrap(), w)
                .unwrap_err(),
            wire::SessionError::ResourceLimit
        );
        assert!(weak.upgrade().is_none());
        assert_eq!(session.snapshot().revision(), before.revision());
        assert_eq!(session.staging_usage(), StagingUsage::default());
    }
    let mut session = setup(false);
    session.configure_staging(limits()).unwrap();
    let foreign = setup(false);
    let (w, weak) = work(&session, "foreign");
    assert_eq!(
        session
            .stage(&foreign.capture_guard().unwrap(), w)
            .unwrap_err(),
        wire::SessionError::Stale
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(
        session.configure_staging(StagingLimits {
            max_units: u64::MAX,
            ..limits()
        }),
        Err(wire::SessionError::InvalidRequest)
    );
}
#[test]
fn preparation_guards_and_history_only_changes_refuse_rebasing() {
    let mut session = setup(false);
    session.configure_staging(limits()).unwrap();
    let mut seq = 0;
    hello(&mut session, &mut seq);
    let guard = session.capture_guard().unwrap();
    let (id, weak) = stage(&mut session, "stale");
    session.acknowledge_checkpoint(&guard).unwrap();
    let (w, other) = work(&session, "old");
    assert_eq!(
        session.stage(&guard, w).unwrap_err(),
        wire::SessionError::Stale
    );
    assert!(other.upgrade().is_none());
    assert_eq!(
        run(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}})
        ),
        json!({"error":"stale"})
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(session.staging_usage(), StagingUsage::default());
    let (id, _) = stage(&mut session, "selected");
    let plate = session.snapshot().state().active_plate_id.clone();
    session
        .select(
            &session.capture_guard().unwrap(),
            &[SelectionRef::Plate(plate)],
            None,
        )
        .unwrap();
    assert!(
        run(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}})
        )
        .get("acknowledged")
        .is_some()
    );
    assert_eq!(
        session.selection().primary(),
        Some(&SelectionRef::Instance(
            InstanceId::try_from_str("import:instance:selected").unwrap()
        ))
    );
}
#[test]
fn large_transactions_commit_one_history_entry_and_failed_members_roll_back() {
    for fail in [false, true] {
        let mut session = setup(false);
        session.configure_staging(limits()).unwrap();
        let mut seq = 0;
        hello(&mut session, &mut seq);
        let before = session.snapshot();
        let mut commands = (0..70)
            .map(|i| captured(&session, &format!("fill-{i}")).0)
            .collect::<Vec<_>>();
        if fail {
            commands.push(captured(&session, "fill-0").0);
        }
        let work =
            StagedWork::transaction(Text::from_utf8("Fill 70 instances"), commands, 4_000_000)
                .unwrap();
        let id = session
            .stage(&session.capture_guard().unwrap(), work)
            .unwrap();
        let result = run(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}}),
        );
        if fail {
            assert_eq!(result, json!({"error":"commandFailed"}));
            assert!(
                session
                    .snapshot()
                    .project()
                    .data()
                    .same_content(before.project().data())
            );
        } else {
            assert!(result.get("acknowledged").is_some());
            assert_eq!(session.history().undo_count, 1);
            assert_eq!(
                session.snapshot().state().plates[0].objects[0]
                    .instances
                    .len(),
                72
            );
            let g = &result["acknowledged"]["guard"];
            let undone = run(&mut session, &mut seq, json!({"undo":g}));
            assert!(
                session
                    .snapshot()
                    .project()
                    .data()
                    .same_content(before.project().data())
            );
            assert!(
                run(
                    &mut session,
                    &mut seq,
                    json!({"redo":undone["acknowledged"]["guard"]})
                )
                .get("acknowledged")
                .is_some()
            );
        }
        assert_eq!(session.staging_usage(), StagingUsage::default());
    }
}
#[test]
fn release_control_remains_available_at_queue_capacity() {
    let mut session = setup(false);
    session.configure_staging(limits()).unwrap();
    let mut seq = 0;
    hello(&mut session, &mut seq);
    let (id, weak) = stage(&mut session, "unconsumed");
    for _ in 0..MAX_PENDING {
        assert!(matches!(
            submit(&mut session, &mut seq, json!({"query":{}})),
            Submission::Queued { .. }
        ));
    }
    let Submission::Ready(result) = submit(
        &mut session,
        &mut seq,
        json!({"executeStaged":{"stagedId":id}}),
    ) else {
        panic!()
    };
    assert_eq!(reply(result), json!({"error":"busy"}));
    let Submission::Ready(result) = submit(
        &mut session,
        &mut seq,
        json!({"releaseStaged":{"stagedId":id}}),
    ) else {
        panic!()
    };
    assert_eq!(reply(result), json!({"released":true}));
    assert!(weak.upgrade().is_none());
    assert_eq!(session.staging_usage(), StagingUsage::default());
    while session.run_next().is_some() {}
}
#[test]
fn completed_mutation_retains_large_project_identity_even_without_encodable_summary() {
    let mut session = setup(true);
    session.configure_staging(limits()).unwrap();
    let mut seq = 0;
    hello(&mut session, &mut seq);
    let (id, _) = stage(&mut session, "wide");
    assert_eq!(
        run(
            &mut session,
            &mut seq,
            json!({"executeStaged":{"stagedId":id}})
        ),
        json!({"receiptUnavailable":true})
    );
    assert_eq!(
        session.snapshot().state().plates[0].objects[0]
            .instances
            .len(),
        3
    );
    assert_eq!(session.staging_usage(), StagingUsage::default());
}
