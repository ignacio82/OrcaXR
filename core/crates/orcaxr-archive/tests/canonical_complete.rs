#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod support;
use orcaxr_archive::{Archive, ZipLimits, canonical::CanonicalArchiveSource};
use orcaxr_project::{ids::AssetId, model::Encode};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use support::*;
#[test]
fn complete_import_matches_production_browser_states_assets_ids_and_warnings() {
    let corpus = corpus();
    let mut failures = vec![];
    for c in corpus["cases"].as_array().unwrap() {
        let archive = Archive::open(
            Cursor::new(unhex(c["archiveHex"].as_str().unwrap())),
            ZipLimits::default(),
            || false,
        )
        .unwrap();
        let result = CanonicalArchiveSource::decode(archive, input_limits(), &mut utc(), || false)
            .and_then(|source| source.complete(limits(), &mut utc(), || false));
        let expected = &c["expected"];
        if result.is_ok() == expected.is_null() {
            failures.push(format!("{}: {:?}", c["name"], result.err()));
            continue;
        }
        if expected.is_null() {
            continue;
        }
        let source = result.unwrap();
        let mut state = vec![];
        source.project().state().write_json(&mut state).unwrap();
        assert_eq!(
            String::from_utf8(state).unwrap(),
            expected["stateJson"].as_str().unwrap(),
            "{}",
            c["name"]
        );
        assert_eq!(
            serde_json::to_value(warnings(&source)).unwrap(),
            expected["warnings"],
            "{}",
            c["name"]
        );
        assert_eq!(
            source.project().state().source_assets.len(),
            expected["assets"].as_array().unwrap().len()
        );
        for a in expected["assets"].as_array().unwrap() {
            let id = AssetId::try_from_utf16(
                a["id"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            let lease = source.asset(&id).unwrap();
            assert_eq!(lease.bytes(), unhex(a["bytesHex"].as_str().unwrap()));
            let mut text = vec![];
            lease.descriptor().write_canonical(&mut text).unwrap();
            assert_eq!(
                String::from_utf8(text).unwrap(),
                a["descriptorJson"].as_str().unwrap()
            );
        }
        source.into_prepared().unwrap();
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
#[test]
fn completion_preserves_original_asset_records_and_reference_sources() {
    let corpus = corpus();
    let c = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "unowned-order-media")
        .unwrap();
    let source = input(c);
    let id = source.project().state().source_assets[0].id.clone();
    let original = source.asset(&id).unwrap();
    let completed = source.complete(limits(), &mut utc(), || false).unwrap();
    assert!(original.same_record(&completed.asset(&id).unwrap()));
    for (p, h) in corpus["sources"].as_object().unwrap() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(p);
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
            h.as_str().unwrap(),
            "{p}"
        );
    }
}

#[test]
fn explicit_budgets_cancellation_and_timestamp_failure_never_publish_a_document() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "unowned-order-media")
        .unwrap();
    for index in 0..11 {
        let mut l = limits();
        match index {
            0 => l.records = 0,
            1 => l.text_units = 0,
            2 => l.assets = 1,
            3 => l.asset_bytes = 1,
            4 => l.total_asset_bytes = 1,
            5 => l.warnings = 0,
            6 => l.regenerated_bytes = 1,
            7 => l.model.records = 0,
            8 => l.metadata.records = 0,
            9 => l.settings.records = 0,
            10 => l.opc.part_bytes = 1,
            _ => unreachable!(),
        }
        let source = input(case);
        let id = source.project().state().source_assets[0].id.clone();
        let lease = source.asset(&id).unwrap();
        let before = Sha256::digest(lease.bytes());
        let result = source.complete(l, &mut utc(), || false);
        assert!(result.is_err(), "budget {index}");
        assert_eq!(Sha256::digest(lease.bytes()), before);
    }
    let mut checks = 0;
    input(case)
        .complete(limits(), &mut utc(), || {
            checks += 1;
            false
        })
        .unwrap();
    assert!(checks > 100);
    for stop in [0, 1, 5, 25, 100, checks / 2, checks - 1] {
        let mut seen = 0;
        let result = input(case).complete(limits(), &mut utc(), || {
            let cancel = seen == stop;
            seen += 1;
            cancel
        });
        assert!(result.is_err(), "cancel at {stop}/{checks}");
    }
    let mut timestamps = |_: &[u16]| Err::<bool, _>("private timezone service details");
    let error = input(case)
        .complete(limits(), &mut timestamps, || false)
        .err()
        .unwrap();
    assert!(matches!(
        error,
        orcaxr_archive::canonical::Error::Document(_)
    ));
    assert!(!format!("{error:?}").contains("private"));
}

#[test]
fn completed_archive_enters_session_only_under_original_open_guard() {
    use orcaxr_project::{
        assets::{AssetPayload, AssetRepository},
        history::HistoryOptions,
        selection::SelectionStore,
        session::ProjectSession,
    };
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    let base = cases.iter().find(|v| v["name"] == "stage/current").unwrap();
    let changed = cases
        .iter()
        .find(|v| v["name"] == "unowned-order-media")
        .unwrap();
    let source = input(base);
    let mut assets = AssetRepository::new();
    for d in source.project().state().source_assets.iter() {
        let lease = source.asset(&d.id).unwrap();
        assets
            .put_owned(AssetPayload {
                descriptor: lease.descriptor().clone(),
                bytes: lease.bytes().to_vec(),
            })
            .unwrap();
    }
    let mut owner = ProjectSession::new(
        source.project().clone(),
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let first = owner.begin_open().unwrap();
    let second = owner.begin_open().unwrap();
    let original_hash = owner.snapshot().hash().to_owned();
    let (document, _) = input(changed)
        .complete(limits(), &mut utc(), || false)
        .unwrap()
        .into_prepared()
        .unwrap();
    assert!(owner.finish_open(&first, document).is_err());
    assert_eq!(owner.snapshot().hash(), original_hash);
    let completed = input(changed)
        .complete(limits(), &mut utc(), || false)
        .unwrap();
    let expected = completed.project().fingerprint().to_owned();
    let id = completed
        .project()
        .state()
        .source_assets
        .last()
        .unwrap()
        .id
        .clone();
    let lease = completed.asset(&id).unwrap();
    let (document, _) = completed.into_prepared().unwrap();
    let effects = owner.finish_open(&second, document).unwrap();
    assert!(!effects.is_empty());
    assert_eq!(owner.snapshot().hash(), expected);
    assert_eq!(owner.history().undo_count, 0);
    assert!(lease.same_record(&owner.assets().peek(&id).unwrap()));
}
