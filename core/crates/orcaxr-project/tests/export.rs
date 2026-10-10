use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository},
    export::ExportCapture,
    history::HistoryOptions,
    model::*,
    selection::SelectionStore,
    session::{PreparedDocument, ProjectSession},
    validation::*,
};
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    )
}
fn source() -> (ValidatedProject, AssetRepository) {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-clipboard-vectors.json"
    ))
    .unwrap();
    let source = &corpus["traces"][0]["clipboard"];
    let state =
        ProjectState::from_value(parse(source["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut assets = AssetRepository::new();
    for record in source["assets"].as_array().unwrap() {
        assets
            .put_owned(AssetPayload {
                descriptor: parse(record["descriptorJson"].as_str().unwrap()).unwrap(),
                bytes: record["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u8)
                    .collect(),
            })
            .unwrap();
    }
    (
        ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap(),
        assets,
    )
}
#[test]
fn export_retains_one_exact_bundle_across_history_reset_and_source_disposal() {
    let (project, assets) = source();
    let mut owner = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let guard = owner.capture_guard().unwrap();
    let captured = ExportCapture::new(&owner, &guard).unwrap();
    let before = owner.snapshot();
    let expected = before
        .state()
        .source_assets
        .iter()
        .map(|d| owner.assets().peek(&d.id).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(captured.asset_count(), expected.len());
    assert!(
        captured
            .project()
            .project()
            .same_allocation(before.project())
    );
    for (index, original) in expected.iter().enumerate() {
        assert!(captured.asset(index).unwrap().same_record(original));
    }
    assert!(captured.asset(expected.len()).is_none());
    owner.acknowledge_checkpoint(&guard).unwrap();
    assert!(!owner.is_current(&guard));
    assert!(ExportCapture::new(&owner, &guard).is_some());
    let (other_project, other_assets) = source();
    let foreign = ProjectSession::new(
        other_project,
        SelectionStore::default(),
        other_assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    assert!(ExportCapture::new(&owner, &foreign.capture_guard().unwrap()).is_none());
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-model-vectors.json"
    ))
    .unwrap();
    let empty = ProjectState::from_value(
        parse(fixtures["factories"][0]["stateJson"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    owner
        .reset_document(
            &guard,
            PreparedDocument::new(
                ValidatedProject::new(ProjectData::new(empty).unwrap(), &mut utc()).unwrap(),
                AssetRepository::new(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(ExportCapture::new(&owner, &guard).is_none());
    assert!(owner.snapshot().state().source_assets.is_empty());
    drop(owner);
    let captured = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        captured.project().state().write_json(&mut bytes).unwrap();
        assert!(!bytes.is_empty());
        captured
    })
    .join()
    .unwrap();
    for (index, original) in expected.iter().enumerate() {
        let actual = captured.asset(index).unwrap();
        assert_eq!(actual.id(), original.id());
        assert!(actual.same_record(original));
        assert_eq!(actual.bytes(), original.bytes());
    }
}

#[test]
fn a_plate_capture_is_the_projection_over_the_frozen_bundle() {
    use orcaxr_project::{ids::PlateId, slicing::plate::*};
    let (project, assets) = source();
    let owner = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let guard = owner.capture_guard().unwrap();
    let captured = ExportCapture::new(&owner, &guard).unwrap();
    let state = captured.project().state().clone();
    let plate_id = state.plates[0].id.clone();
    let plate = captured.plate(&plate_id, &mut utc()).unwrap();
    let expected = project_plate(&state, &plate_id, |_| true, &mut utc()).unwrap();
    // The archive's sourceHash, at the live capture's revision.
    assert_eq!(plate.project().hash(), expected.source_hash());
    assert_eq!(plate.project().revision(), captured.project().revision());
    assert_eq!(plate.project().state().plates.len(), 1);
    // Only the kept assets, in descriptor order, as the very frozen records.
    assert!(expected.assets.len() < state.source_assets.len());
    assert_eq!(plate.asset_count(), expected.assets.len());
    for (index, id) in expected.assets.iter().enumerate() {
        let lease = plate.asset(index).unwrap();
        assert_eq!(lease.id(), id);
        assert!(lease.same_record(&owner.assets().peek(id).unwrap()));
    }
    assert!(plate.asset(expected.assets.len()).is_none());
    let unknown = PlateId::try_from_str("import:plate:unknown").unwrap();
    assert!(matches!(
        captured.plate(&unknown, &mut utc()),
        Err(ProjectionError::UnknownPlate)
    ));
    // The state-document exchange answers the same projection.
    let mut json = Vec::new();
    state.write_json(&mut json).unwrap();
    let json = String::from_utf8(json).unwrap();
    let id_json = format!("\"{}\"", String::from_utf16(plate_id.as_utf16()).unwrap());
    let answer: serde_json::Value =
        serde_json::from_str(&projection_json(&json, &id_json, "[]", &mut utc()).unwrap()).unwrap();
    assert_eq!(answer["sourceHash"], plate.project().hash());
    let mut projected = Vec::new();
    plate.project().state().write_json(&mut projected).unwrap();
    assert_eq!(answer["stateJson"], String::from_utf8(projected).unwrap());
    let refused: serde_json::Value = serde_json::from_str(
        &projection_json(&json, "\"import:plate:unknown\"", "[]", &mut utc()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        refused,
        serde_json::json!({
            "error": "plate_projection_unknown_plate",
            "message": "Unknown plate import:plate:unknown"
        })
    );
    for bad in ["", "3", "\"\"", "[\"x\"]"] {
        assert_eq!(
            projection_json(&json, bad, "[]", &mut utc()),
            Err(INVALID_REQUEST)
        );
    }
    assert_eq!(
        projection_json(&json, &id_json, "{}", &mut utc()),
        Err(INVALID_REQUEST)
    );
    assert_eq!(print_overrides_json("{}", &id_json), Err(INVALID_REQUEST));
    assert_eq!(
        print_overrides_json(&json, &id_json).unwrap(),
        r#"{"layer_height":"0.2"}"#
    );
}
