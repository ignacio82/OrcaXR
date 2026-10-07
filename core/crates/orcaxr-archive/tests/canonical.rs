use orcaxr_archive::{
    Archive, ZipLimits,
    canonical::{CanonicalArchiveSource, Error, Failure},
};
use orcaxr_project::{
    ingress::{DocumentError, ProjectInputLimits, json::JsonLimits},
    model::Encode,
    validation::{AdmissionError, TimestampPolicy, V8Timestamps, timestamp},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    io::{self, Cursor, Read, Seek, SeekFrom},
    rc::Rc,
};
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/canonical-archive-vectors.json"
    ))
    .unwrap()
}
fn bytes(v: &str) -> Vec<u8> {
    v.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn limits() -> ProjectInputLimits {
    ProjectInputLimits {
        document: JsonLimits {
            max_bytes: 4 << 20,
            max_nodes: 1 << 20,
            max_text_units: 4 << 20,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 4096,
        max_asset_bytes: 16 << 20,
        max_total_asset_bytes: 32 << 20,
    }
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn input(case: &Value) -> Archive<Cursor<Vec<u8>>> {
    Archive::open(
        Cursor::new(bytes(case["archiveHex"].as_str().unwrap())),
        ZipLimits::default(),
        || false,
    )
    .unwrap()
}
fn case<'a>(c: &'a Value, name: &str) -> &'a Value {
    c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
}
#[test]
fn browser_envelopes_assets_migrations_and_retained_members() {
    let corpus = corpus();
    let mut mismatches = Vec::new();
    for c in corpus["cases"].as_array().unwrap() {
        let result = CanonicalArchiveSource::decode(input(c), limits(), &mut utc(), || false);
        let expected = &c["expected"];
        if result.is_ok() == expected.is_null() {
            mismatches.push(format!("{}: {:?}", c["name"], result.err()));
            continue;
        }
        if expected.is_null() {
            continue;
        }
        let mut source = result.unwrap();
        let mut encoded = Vec::new();
        source.project().state().write_json(&mut encoded).unwrap();
        assert_eq!(
            std::str::from_utf8(&encoded).unwrap(),
            expected["stateJson"].as_str().unwrap(),
            "{}",
            c["name"]
        );
        assert_eq!(
            source.migrations().dense_channels,
            expected["migrations"]["denseChannels"].as_u64().unwrap() as usize
        );
        assert_eq!(
            source.migrations().false_fuzzy_assignments,
            expected["migrations"]["falseFuzzyAssignments"]
                .as_u64()
                .unwrap() as usize
        );
        assert_eq!(
            source.unsupported_digest_indices(),
            expected["unsupportedDigests"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as usize)
                .collect::<Vec<_>>()
        );
        for (i, m) in source.mappings().iter().enumerate() {
            let want = &expected["mappings"][i];
            assert_eq!(
                m.asset_id.as_utf16(),
                want["assetId"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                source.entries()[m.entry].path(),
                want["path"].as_str().unwrap()
            );
        }
        for (i, d) in source.project().state().source_assets.iter().enumerate() {
            let want = &expected["assets"][i];
            let lease = source.asset(&d.id).unwrap();
            assert_eq!(lease.bytes(), bytes(want["bytesHex"].as_str().unwrap()));
            let mut encoded = Vec::new();
            lease.descriptor().write_canonical(&mut encoded).unwrap();
            assert_eq!(
                std::str::from_utf8(&encoded).unwrap(),
                want["descriptorJson"].as_str().unwrap()
            );
        }
        let members = expected["members"].as_array().unwrap();
        assert_eq!(source.entries().len(), members.len());
        for (i, want) in members.iter().enumerate() {
            assert_eq!(source.entries()[i].path(), want["path"].as_str().unwrap());
            let mut out = Vec::new();
            source.read_member(i, &mut out, || false).unwrap();
            assert_eq!(out.len() as u64, want["bytes"].as_u64().unwrap());
            assert_eq!(
                format!("{:x}", Sha256::digest(&out)),
                want["sha256"].as_str().unwrap()
            );
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
#[test]
fn reference_sources_have_not_drifted() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for s in corpus()["sources"].as_array().unwrap() {
        let data = std::fs::read(root.join(s["path"].as_str().unwrap())).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(data)),
            s["sha256"].as_str().unwrap(),
            "{}",
            s["path"]
        );
    }
}
#[test]
fn host_limits_precede_payload_allocation_and_service_errors_remain_distinct() {
    let corpus = corpus();
    let c = case(&corpus, "current");
    for index in 0..8 {
        let mut l = limits();
        match index {
            0 => l.document.max_bytes = 1,
            1 => l.document.max_nodes = 1,
            2 => l.document.max_text_units = 1,
            3 => l.document.max_depth = 1,
            4 => l.max_assets = 0,
            5 => l.max_asset_bytes = 35,
            6 => l.max_total_asset_bytes = 35,
            _ => l.document.max_depth = 129,
        };
        assert!(CanonicalArchiveSource::decode(input(c), l, &mut utc(), || false).is_err());
    }
    let mut bad_time = |_: &[u16]| Err::<bool, _>("private host failure");
    let error = CanonicalArchiveSource::decode(input(c), limits(), &mut bad_time, || false)
        .err()
        .unwrap();
    assert!(matches!(
        error,
        Error::Document(DocumentError::Admission(AdmissionError::Timestamp(
            "private host failure"
        )))
    ));
    assert!(!format!("{error:?}").contains("private"));
}
struct Owned {
    data: Cursor<Vec<u8>>,
    dropped: Rc<Cell<bool>>,
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.dropped.set(true);
    }
}
impl Read for Owned {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        let n = b.len().min(7);
        self.data.read(&mut b[..n])
    }
}
impl Seek for Owned {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        self.data.seek(p)
    }
}
#[test]
fn cancellation_drops_staging_and_success_keeps_source_and_asset_ownership() {
    let corpus = corpus();
    let c = case(&corpus, "unknown-members-retained");
    let count = Cell::new(0);
    let done = CanonicalArchiveSource::decode(input(c), limits(), &mut utc(), || {
        count.set(count.get() + 1);
        false
    })
    .unwrap();
    drop(done);
    for at in [1, 2, 10, 100, count.get() / 2, count.get() - 1, count.get()] {
        let dropped = Rc::new(Cell::new(false));
        let owned = Owned {
            data: Cursor::new(bytes(c["archiveHex"].as_str().unwrap())),
            dropped: dropped.clone(),
        };
        let archive = Archive::open(owned, ZipLimits::default(), || false).unwrap();
        let mut checks = 0;
        let error = CanonicalArchiveSource::decode(archive, limits(), &mut utc(), || {
            checks += 1;
            checks >= at
        })
        .err()
        .unwrap();
        assert!(matches!(
            error,
            Error::Failure(Failure::Cancelled | Failure::Archive(orcaxr_archive::Error::Cancelled))
        ));
        assert!(dropped.get());
    }
    let dropped = Rc::new(Cell::new(false));
    let owned = Owned {
        data: Cursor::new(bytes(c["archiveHex"].as_str().unwrap())),
        dropped: dropped.clone(),
    };
    let source = CanonicalArchiveSource::decode(
        Archive::open(owned, ZipLimits::default(), || false).unwrap(),
        limits(),
        &mut utc(),
        || false,
    )
    .unwrap();
    assert!(!dropped.get());
    let id = &source.project().state().source_assets[0].id;
    let lease = source.asset(id).unwrap();
    assert!(lease.same_record(&source.asset(id).unwrap()));
    drop(source);
    assert!(dropped.get());
    assert_eq!(lease.bytes().len(), 36);
}
#[test]
fn corrupt_unowned_member_is_not_ignored() {
    let corpus = corpus();
    let c = case(&corpus, "unknown-members-retained");
    let mut data = bytes(c["archiveHex"].as_str().unwrap());
    let mut altered = false;
    for i in 0..data.len() - 30 {
        if &data[i..i + 4] != b"PK\x03\x04" {
            continue;
        }
        let name = u16::from_le_bytes(data[i + 26..i + 28].try_into().unwrap()) as usize;
        if &data[i + 30..i + 30 + name] == b"unknown.bin" {
            let extra = u16::from_le_bytes(data[i + 28..i + 30].try_into().unwrap()) as usize;
            data[i + 30 + name + extra] ^= 1;
            altered = true;
            break;
        }
    }
    assert!(altered);
    let archive = Archive::open(Cursor::new(data), ZipLimits::default(), || false).unwrap();
    assert!(matches!(
        CanonicalArchiveSource::decode(archive, limits(), &mut utc(), || false),
        Err(Error::Failure(Failure::Archive(_)))
    ));
}
