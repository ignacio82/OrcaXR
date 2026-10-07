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
