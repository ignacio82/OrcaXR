#[path = "support/package.rs"]
mod support;
use orcaxr_archive::{
    Archive,
    package::{self, Error},
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository},
    export::ExportCapture,
    history::HistoryOptions,
    selection::SelectionStore,
    session::{PreparedDocument, ProjectSession},
};
use std::{
    cell::Cell,
    io::{self, Cursor, Seek, SeekFrom, Write},
};
fn baseline() -> (
    orcaxr_project::validation::ValidatedProject,
    Vec<orcaxr_project::assets::AssetLease>,
) {
    support::input(&support::sources()["bbs-model"]["cases"][0])
}
#[test]
fn exact_capture_membership_metadata_and_all_budget_families_are_required() {
    let (project, assets) = baseline();
    let mut out = Cursor::new(vec![]);
    for provided in [vec![], vec![assets[0].clone(), assets[0].clone()]] {
        assert_eq!(
            package::write(&project, provided, &mut out, support::limits(), || false).unwrap_err(),
            Error::AssetMembership
        );
        assert!(out.get_ref().is_empty());
    }
    for unexpected in [false, true] {
        let mut descriptor = assets[0].descriptor().clone();
        let Value::Object(ref mut fields) = descriptor else {
            panic!()
        };
        if unexpected {
            fields.insert(
                "id".encode_utf16().collect(),
                Value::String("import:asset:unexpected".encode_utf16().collect()),
            );
        } else {
            fields.insert(
                "unknownMetadata".encode_utf16().collect(),
                Value::Bool(true),
            );
        }
        let mut repo = AssetRepository::new();
        let id = if unexpected {
            orcaxr_project::ids::AssetId::try_from_str("import:asset:unexpected").unwrap()
        } else {
            assets[0].id().clone()
        };
        repo.put_owned(AssetPayload {
            descriptor,
            bytes: assets[0].bytes().to_vec(),
        })
        .unwrap();
        let provided = [repo.peek(&id).unwrap()];
        assert_eq!(
            package::write(&project, provided, &mut out, support::limits(), || false).unwrap_err(),
            if unexpected {
                Error::AssetMembership
            } else {
                Error::AssetMetadata
            }
        );
        assert!(out.get_ref().is_empty());
    }
    for field in 0..16 {
        let mut limits = support::limits();
        match field {
            0 => limits.records = 0,
            1 => limits.text_units = 0,
            2 => limits.asset_bytes = 0,
            3 => limits.total_asset_bytes = 0,
            4 => limits.warnings = 0,
            5 => limits.model.records = 0,
            6 => limits.metadata.records = 0,
            7 => limits.settings.config_nodes = 0,
            8 => limits.opc.records = 0,
            9 => limits.envelope.assets = 0,
            10 => limits.zip.zip.entries = 1,
            11 => limits.zip.index_bytes = 0,
            12 => limits.zip.zip.total_uncompressed_bytes = 1,
            13 => limits.zip.zip.archive_bytes = 1,
            14 => limits.zip.zip.entry_bytes = 1,
            _ => limits.zip.zip.path_bytes = 4,
        }
        let mut output = Cursor::new(vec![]);
        assert!(
            package::write(&project, assets.clone(), &mut output, limits, || false).is_err(),
            "budget {field}"
        );
        assert!(
            Archive::open(output, support::limits().zip.zip, || false).is_err(),
            "no complete archive on failure {field}"
        );
    }
    let mut nonempty = Cursor::new(b"existing private destination".to_vec());
    assert_eq!(
        package::write(&project, assets, &mut nonempty, support::limits(), || false).unwrap_err(),
        Error::NonemptyOutput
    );
    assert_eq!(nonempty.into_inner(), b"existing private destination");
}
struct Host<'a> {
    bytes: Cursor<Vec<u8>>,
    calls: usize,
    fail_at: usize,
    zero: bool,
    interrupt: bool,
    cancel: Option<&'a Cell<bool>>,
}
impl Write for Host<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        if self.calls >= self.fail_at {
            if self.zero {
                return Ok(0);
            }
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private host credential path",
            ));
        }
        if self.interrupt && self.calls.is_multiple_of(3) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = self.bytes.write(&b[..b.len().min(19)])?;
        if let Some(c) = self.cancel {
            c.set(true);
        }
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("host owns flush")
    }
}
impl Seek for Host<'_> {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        self.bytes.seek(p)
    }
}
#[test]
fn cancellation_and_host_failures_never_return_a_successful_receipt() {
    let (project, assets) = baseline();
    let before = project.fingerprint().to_owned();
    let pointers: Vec<_> = assets.iter().map(|a| a.bytes().as_ptr()).collect();
    let mut normal = Cursor::new(vec![]);
    let mut polls = 0;
    package::write(
        &project,
        assets.clone(),
        &mut normal,
        support::limits(),
        || {
            polls += 1;
            false
        },
    )
    .unwrap();
    for stop in [
        0,
        1,
        5,
        10,
        polls / 4,
        polls / 2,
        polls * 3 / 4,
        polls - 2,
        polls - 1,
    ] {
        let mut calls = 0;
        let mut out = Cursor::new(vec![]);
        assert!(
            package::write(
                &project,
                assets.clone(),
                &mut out,
                support::limits(),
                || {
                    calls += 1;
                    calls > stop
                }
            )
            .is_err(),
            "cancel at {stop}/{polls}"
        );
    }
    for (fail_at, zero, interrupt, cancel_write) in [
        (usize::MAX, false, true, false),
        (1, false, false, false),
        (100, false, false, false),
        (1, true, false, false),
        (usize::MAX, false, false, true),
    ] {
        let cancel = Cell::new(false);
        let mut host = Host {
            bytes: Cursor::new(vec![]),
            calls: 0,
            fail_at,
            zero,
            interrupt,
            cancel: cancel_write.then_some(&cancel),
        };
        let result = package::write(
            &project,
            assets.clone(),
            &mut host,
            support::limits(),
            || cancel.get(),
        );
        if interrupt {
            assert!(result.is_ok());
            assert_eq!(host.bytes.get_ref(), normal.get_ref());
        } else {
            let error = result.unwrap_err();
            assert!(!format!("{error:?} {error}").contains("private host credential path"));
            assert!(Archive::open(host.bytes, support::limits().zip.zip, || false).is_err());
        }
    }
    assert_eq!(project.fingerprint(), before);
    assert_eq!(
        assets
            .iter()
            .map(|a| a.bytes().as_ptr())
            .collect::<Vec<_>>(),
        pointers
    );
    let mut retry = Cursor::new(vec![]);
    package::write(&project, assets, &mut retry, support::limits(), || false).unwrap();
    assert_eq!(retry.into_inner(), normal.into_inner());
}
#[test]
fn background_package_owns_the_original_capture_after_session_replacement_and_disposal() {
    let (project, assets) = baseline();
    let mut repo = AssetRepository::new();
    for a in assets {
        repo.put_owned(AssetPayload {
            descriptor: a.descriptor().clone(),
            bytes: a.bytes().to_vec(),
        })
        .unwrap();
    }
    let mut owner = ProjectSession::new(
        project,
        SelectionStore::default(),
        repo,
        |_: &[u16]| Ok::<_, ()>(true),
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap();
    let guard = owner.capture_guard().unwrap();
    let capture = ExportCapture::new(&owner, &guard).unwrap();
    let mut expected = Cursor::new(vec![]);
    package::write_capture(&capture, &mut expected, support::limits(), || false).unwrap();
    assert!(owner.is_current(&guard));
    let corpus = support::sources();
    let empty = corpus["bbs-model"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "empty")
        .unwrap();
    let (project, assets) = support::input(empty);
    let mut repo = AssetRepository::new();
    for a in assets {
        repo.put_owned(AssetPayload {
            descriptor: a.descriptor().clone(),
            bytes: a.bytes().to_vec(),
        })
        .unwrap();
    }
    owner
        .reset_document(&guard, PreparedDocument::new(project, repo).unwrap())
        .unwrap();
    assert!(!owner.is_export_current(&guard));
    drop(owner);
    let output = std::thread::spawn(move || {
        let mut output = Cursor::new(vec![]);
        package::write_capture(&capture, &mut output, support::limits(), || false).unwrap();
        output
    })
    .join()
    .unwrap();
    assert_eq!(output.into_inner(), expected.into_inner());
}
#[test]
fn reference_inputs_bind_all_current_source_bytes() {
    use sha2::{Digest, Sha256};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for (path, expected) in support::references()["sources"].as_object().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).unwrap())
            ),
            expected.as_str().unwrap(),
            "{path}"
        );
    }
}
