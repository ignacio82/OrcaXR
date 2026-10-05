use orcaxr_contracts::canonical::parse;
use orcaxr_project::{ids::*, model::*, validation::*};
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeSet, sync::Arc};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-validation-vectors.json"
    ))
    .unwrap()
}
fn candidate(case: &Value) -> ProjectData {
    ProjectData::new(
        ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap(),
    )
    .unwrap()
}
fn base() -> ProjectData {
    let f = fixture();
    candidate(
        f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "base")
            .unwrap(),
    )
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn issues(report: &ValidationReport) -> Value {
    json!(report.issues().iter().map(|i|json!({"code":i.code,"path":i.path.units(),"message":i.message.units(),"severity":i.severity.as_str()})).collect::<Vec<_>>())
}
fn number(n: f64) -> Number {
    Number::new(n).unwrap()
}
#[test]
fn ordered_graph_diagnostics_and_admission_match_the_typescript_reference() {
    let f = fixture();
    let mut covered = BTreeSet::new();
    for case in f["cases"].as_array().unwrap() {
        let candidate = candidate(case);
        assert_eq!(
            candidate.fingerprint(),
            case["fingerprint"],
            "{}",
            case["name"]
        );
        let report = validate_project(&candidate, &mut utc()).unwrap();
        assert_eq!(issues(&report), case["issues"], "{}", case["name"]);
        assert_eq!(
            json!(report.user_message().units()),
            case["errorMessage"],
            "{}",
            case["name"]
        );
        covered.extend(report.issues().iter().map(|i| i.code));
        match ValidatedProject::new(candidate.clone(), &mut utc()) {
            Ok(valid) => {
                assert!(report.is_valid());
                assert!(valid.data().same_allocation(&candidate));
                assert_eq!(valid.report(), &report);
            }
            Err(AdmissionError::Invalid(actual)) => {
                assert!(!report.is_valid());
                assert_eq!(actual, report);
            }
            Err(AdmissionError::Timestamp(_)) => panic!("fixed UTC is available"),
        }
    }
    assert_eq!(json!(covered), f["covered"]);
}
#[test]
fn immutable_admission_is_reused_without_copying_or_revalidating_the_graph() {
    let data = base();
    let before = data.fingerprint().to_owned();
    let calls = Cell::new(0);
    let mut policy = |_: &[u16]| {
        calls.set(calls.get() + 1);
        Ok::<_, ()>(true)
    };
    let valid = ValidatedProject::new(data.clone(), &mut policy).unwrap();
    assert_eq!(calls.get(), 2);
    for _ in 0..20 {
        let other = valid.clone();
        assert!(valid.same_allocation(&other));
        assert_eq!(other.fingerprint(), before);
        assert!(other.report().is_valid());
    }
    assert_eq!(calls.get(), 2);
    let mut edited = valid.to_candidate();
    edited.name = Text::from_utf8("");
    assert!(Arc::ptr_eq(&edited.plates, &valid.state().plates));
    let rejected = ProjectData::new(edited).unwrap();
    assert!(matches!(
        ValidatedProject::new(rejected, &mut policy),
        Err(AdmissionError::Invalid(_))
    ));
    assert_eq!(valid.fingerprint(), before);
    assert!(valid.data().same_allocation(&data));
    assert!(!valid.state().name.units().is_empty());
}
#[test]
fn timezone_failure_cannot_admit_a_project_or_become_an_invalid_timestamp_issue() {
    let mut state = base().to_candidate();
    state.created_at = Text::from_utf8("2026-10-05T12:00:00");
    state.name = Text::from_utf8("");
    let data = ProjectData::new(state).unwrap();
    let calls = Cell::new(0);
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi31,
        |_: timestamp::LocalDateTime| {
            calls.set(calls.get() + 1);
            Err::<i64, _>("PRIVATE_TIMESTAMP_SERVICE_DATA")
        },
    );
    let error = ValidatedProject::new(data, &mut policy).unwrap_err();
    assert_eq!(calls.get(), 1);
    assert!(matches!(
        error,
        AdmissionError::Timestamp("PRIVATE_TIMESTAMP_SERVICE_DATA")
    ));
    assert!(!format!("{error:?} {error}").contains("PRIVATE"));
}

#[test]
fn graph_admission_uses_the_explicit_v8_profile_and_host_timezone_before_time_clip() {
    let mut state = base().to_candidate();
    state.created_at = Text::from_utf8("Jan 1 1970 GMT+500000:00");
    let data = ProjectData::new(state.clone()).unwrap();
    assert!(ValidatedProject::new(data.clone(), &mut utc()).is_ok());
    let mut chromium = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi31,
        |_: timestamp::LocalDateTime| -> Result<i64, ()> { panic!("explicit offset") },
    );
    let report = validate_project(&data, &mut chromium).unwrap();
    assert_eq!(report.issues().len(), 1);
    assert_eq!(report.issues()[0].code, "invalid-timestamp");
    assert_eq!(report.issues()[0].path, Text::from_utf8("createdAt"));

    state.created_at = Text::from_utf8("+275760-09-13T00:00:00.001");
    let data = ProjectData::new(state).unwrap();
    assert!(!validate_project(&data, &mut utc()).unwrap().is_valid());
    let mut east = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi31,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds() - 14 * 3_600_000),
    );
    assert!(ValidatedProject::new(data, &mut east).is_ok());
}
#[test]
fn lossless_user_messages_are_explicit_while_debug_and_display_remain_redacted() {
    let f = fixture();
    let case = f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "self-cycle-private-utf16")
        .unwrap();
    let data = candidate(case);
    let report = validate_project(&data, &mut utc()).unwrap();
    let cycle = report
        .issues()
        .iter()
        .find(|i| i.code == "cyclic-mixed-filament")
        .unwrap();
    assert!(cycle.message.units().contains(&0xd800));
    assert!(cycle.message.units().contains(&0));
    let diagnostic = format!("{report:?} {report} {cycle:?}");
    assert!(!diagnostic.contains("PRIVATE_GRAPH_TEXT"));
    let error = ValidatedProject::new(data, &mut utc()).unwrap_err();
    assert!(!format!("{error:?} {error}").contains("PRIVATE_GRAPH_TEXT"));
}
#[test]
fn mixed_graph_depth_is_not_a_rust_call_stack_or_transport_limit() {
    let mut state = base().to_candidate();
    let template = state.filaments.mixed[0].clone();
    let count = 10_000;
    state.filaments.mixed = (0..count)
        .map(|i| {
            let mut f = (*template).clone();
            f.id = MixedFilamentId::try_from_str(&format!("import:deep:{i}")).unwrap();
            f.full_spectrum = None;
            let mut components = f.components.to_vec();
            components[0].filament_id = PhysicalFilamentId::try_from_str(&format!(
                "import:deep:{}",
                (i + 1).min(count - 1)
            ))
            .unwrap();
            f.components = components.into();
            Arc::new(f)
        })
        .collect::<Vec<_>>()
        .into();
    let data = ProjectData::new(state).unwrap();
    let report = validate_project(&data, &mut utc()).unwrap();
    assert_eq!(
        report
            .issues()
            .iter()
            .filter(|i| i.code == "nested-mixed-component")
            .count(),
        count
    );
    let cycles = report
        .issues()
        .iter()
        .filter(|i| i.code == "cyclic-mixed-filament")
        .collect::<Vec<_>>();
    assert_eq!(cycles.len(), 1);
    let mut expected = "Mixed filament cycle: ".encode_utf16().collect::<Vec<_>>();
    for i in 0..count {
        expected.extend(format!("import:deep:{i} -> ").encode_utf16());
    }
    expected.extend(format!("import:deep:{}", count - 1).encode_utf16());
    assert_eq!(cycles[0].message.units(), expected);
}
#[test]
fn shared_layer_records_and_large_finite_integers_keep_array_and_binary64_semantics() {
    let mut state = base().to_candidate();
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let range = object.layer_ranges[0].clone();
    object.layer_ranges = vec![range.clone(), range].into();
    state.printer.tool_count = number(1e100);
    let report = validate_project(&ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    assert!(
        !report
            .issues()
            .iter()
            .any(|i| i.code == "invalid-tool-count")
    );
    let duplicate = report
        .issues()
        .iter()
        .find(|i| i.code == "duplicate-id")
        .unwrap();
    assert_eq!(
        duplicate.path,
        Text::from_utf8("plates[0].objects[0].layerRanges[1].id")
    );
}
