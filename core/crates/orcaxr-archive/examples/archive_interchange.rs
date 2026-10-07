//! Real browser archive -> guarded native Open/edit/Save -> browser edit/Save.
//! Inputs are actual bytes, and reports contain unnormalized full state/assets.
#[allow(dead_code)]
#[path = "../tests/support/canonical_complete.rs"]
mod support;
use orcaxr_archive::{Archive, ZipLimits, canonical::CanonicalArchiveSource, package};
use orcaxr_project::{
    assets::AssetRepository,
    history::HistoryOptions,
    ids::{SeededRandom, UuidIdSource},
    model::{Encode, ProjectData, Text, empty_project},
    selection::SelectionStore,
    session::{ProjectSession, Submission},
    validation::{TimestampPolicy, ValidatedProject},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};
use support::package_support;
fn read(path: &Path) -> Result<orcaxr_archive::canonical::CompletedCanonicalArchive, String> {
    let archive = Archive::open(File::open(path).unwrap(), ZipLimits::default(), || false)
        .map_err(|e| format!("{e:?}"))?;
    CanonicalArchiveSource::decode(
        archive,
        support::input_limits(),
        &mut support::utc(),
        || false,
    )
    .and_then(|s| s.complete(support::limits(), &mut support::utc(), || false))
    .map_err(|e| format!("{e:?}"))
}
fn owner() -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let state = empty_project(
        &mut UuidIdSource::new(SeededRandom::new(42.0)),
        Text::from_utf8("2026-07-17T00:00:00.000Z"),
        None,
        None,
        None,
    );
    let project =
        ValidatedProject::new(ProjectData::new(state).unwrap(), &mut support::utc()).unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        AssetRepository::new(),
        support::utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap()
}
fn snapshot<P: TimestampPolicy>(owner: &ProjectSession<P>) -> Value {
    let capture = owner.snapshot();
    let mut text = vec![];
    capture.state().write_json(&mut text).unwrap();
    let assets = capture.state().source_assets.iter().map(|d| {
        let a = owner.assets().peek(&d.id).unwrap();
        let mut descriptor = vec![];
        a.descriptor().write_canonical(&mut descriptor).unwrap();
        json!({"id":d.id.as_utf16(), "descriptorJson":String::from_utf8(descriptor).unwrap(), "bytesHex": a.bytes().iter().map(|b| format!("{b:02x}")).collect::<String>()})
    }).collect::<Vec<_>>();
    json!({"stateJson":String::from_utf8(text).unwrap(),"assets":assets})
}
fn rename<P: TimestampPolicy>(owner: &mut ProjectSession<P>, edit: &str) {
    let hello = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":1,"operation":{"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}});
    assert!(matches!(
        owner.submit(&hello.to_string()),
        Submission::Ready(_)
    ));
    let query =
        json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":2,"operation":{"query":{}}});
    assert!(matches!(
        owner.submit(&query.to_string()),
        Submission::Queued { .. }
    ));
    let reply: Value = serde_json::from_str(owner.run_next().unwrap().wire()).unwrap();
    let guard = reply["result"]["acknowledged"]["guard"].clone();
    assert!(!guard.is_null());
    let request = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":3,"operation":{"execute":{"guard":guard,"intent":{"version":1,"command":{"renamePlate":{"plateId":owner.snapshot().state().plates[0].id.as_utf16(),"name":edit.encode_utf16().collect::<Vec<_>>()}}}}}});
    assert!(matches!(
        owner.submit(&request.to_string()),
        Submission::Queued { .. }
    ));
    let (wire, events) = owner.run_next().unwrap().into_parts();
    assert!(
        serde_json::from_str::<Value>(&wire).unwrap()["result"]
            .get("acknowledged")
            .is_some(),
        "{wire}"
    );
    assert!(!events.is_empty());
    assert_eq!(owner.history().undo_count, 1);
    assert!(!owner.history().dirty_categories.is_empty());
}
fn main() {
    let manifest = PathBuf::from(std::env::args_os().nth(1).expect("input manifest"));
    let output = PathBuf::from(std::env::args_os().nth(2).expect("output directory"));
    fs::create_dir_all(&output).unwrap();
    let root = manifest.parent().unwrap();
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    let mut results = vec![];
    for (ordinal, row) in cases.iter().enumerate() {
        let mut owner = owner();
        let ticket = owner.begin_open().unwrap();
        let initial = owner.snapshot().hash().to_owned();
        let imported = match read(&root.join(row["path"].as_str().unwrap())) {
            Ok(v) => v,
            Err(error) => {
                owner.cancel_open(&ticket);
                assert_eq!(owner.snapshot().hash(), initial);
                assert_eq!(owner.history().undo_count, 0);
                results.push(json!({"name":row["name"],"error":error}));
                continue;
            }
        };
        let warnings = support::warnings(&imported);
        let leases = imported
            .project()
            .state()
            .source_assets
            .iter()
            .map(|d| imported.asset(&d.id).unwrap())
            .collect::<Vec<_>>();
        let (prepared, _) = imported.into_prepared().unwrap();
        assert!(!owner.finish_open(&ticket, prepared).unwrap().is_empty());
        assert_eq!(owner.history().undo_count, 0);
        let adopted = owner.snapshot();
        for (descriptor, lease) in adopted.state().source_assets.iter().zip(&leases) {
            assert!(lease.same_record(&owner.assets().peek(&descriptor.id).unwrap()));
        }
        let mut report =
            json!({"name":row["name"],"imported":snapshot(&owner),"warnings":warnings});
        if let Some(edit) = row["edit"].as_str() {
            rename(&mut owner, edit);
            report["edited"] = snapshot(&owner);
            let capture = owner.snapshot();
            let assets = capture
                .state()
                .source_assets
                .iter()
                .map(|d| owner.assets().peek(&d.id).unwrap())
                .collect::<Vec<_>>();
            let path = format!("native-{ordinal}.3mf");
            let result = package::write(
                capture.project(),
                assets,
                &mut File::create(output.join(&path)).unwrap(),
                package_support::limits(),
                || false,
            );
            assert_eq!(owner.snapshot().hash(), capture.hash());
            assert!(!owner.history().dirty_categories.is_empty());
            match result {
                Ok(receipt) => {
                    report["saved"] = json!({"path":path,"bytes":receipt.zip.bytes});
                    let reopened = read(&output.join(&path)).expect("native archive must reopen");
                    let warnings = support::warnings(&reopened);
                    let next = owner.begin_open().unwrap();
                    let (prepared, _) = reopened.into_prepared().unwrap();
                    owner.finish_open(&next, prepared).unwrap();
                    report["reopened"] = snapshot(&owner);
                    report["reopenedWarnings"] = json!(warnings);
                }
                Err(error) => {
                    fs::remove_file(output.join(&path)).unwrap();
                    report["saveError"] = json!(format!("{error:?}"));
                }
            }
        }
        results.push(report);
    }
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        json!({"cases":results.len(),"adopted":results.iter().filter(|r| r.get("imported").is_some()).count(),"saved":results.iter().filter(|r| r.get("saved").is_some()).count()})
    );
}
