//! Complete native foreign BBS/3MF import against independent production-browser
//! Open results (tools/cross-platform/foreign-import-vectors.mjs and
//! foreign-bbs-vectors.mjs): acceptance, canonical state, asset descriptors and
//! bytes, and the sorted unique warning set.
#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod support;
use orcaxr_archive::{Archive, ZipLimits, bbs::foreign, canonical::CompletedCanonicalArchive};
use orcaxr_project::model::Encode;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Cursor;

fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("invalid base64"),
    };
    let bytes: Vec<u8> = text.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, c)| n | u32::from(value(*c)) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn units(value: &Value) -> Vec<u16> {
    match value {
        Value::String(text) => text.encode_utf16().collect(),
        Value::Array(list) => list.iter().map(|u| u.as_u64().unwrap() as u16).collect(),
        other => panic!("text expected, got {other}"),
    }
}
fn open(bytes: Vec<u8>) -> Result<CompletedCanonicalArchive, String> {
    let archive = Archive::open(Cursor::new(bytes), ZipLimits::default(), || false)
        .map_err(|e| format!("{e:?}"))?;
    foreign::import(
        archive,
        support::foreign_limits(),
        &mut support::utc(),
        || false,
    )
    .map_err(|e| format!("{e:?}"))
}
fn state_json(completed: &CompletedCanonicalArchive) -> String {
    let mut out = Vec::new();
    completed.project().state().write_json(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn compare(name: &str, completed: &CompletedCanonicalArchive, expected: &Value) -> Vec<String> {
    let mut failures = Vec::new();
    let state = state_json(completed);
    match (&expected["stateJson"], &expected["stateSha256"]) {
        (Value::String(json), _) if *json != state => failures.push(format!(
            "{name}: state differs\nnative:  {}\nbrowser: {}",
            &state[..state.len().min(4000)],
            &json[..json.len().min(4000)]
        )),
        (Value::Null, Value::String(digest)) if *digest != sha256(state.as_bytes()) => {
            failures.push(format!("{name}: state digest differs\nnative: {state}"))
        }
        _ => {}
    }
    let mut assets: Vec<(String, String, String)> = completed
        .project()
        .state()
        .source_assets
        .iter()
        .map(|d| {
            let lease = completed.asset(&d.id).expect("declared asset");
            let mut descriptor = Vec::new();
            lease.descriptor().write_canonical(&mut descriptor).unwrap();
            (
                String::from_utf16(d.id.as_utf16()).unwrap(),
                String::from_utf8(descriptor).unwrap(),
                sha256(lease.bytes()),
            )
        })
        .collect();
    assets.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let browser = expected["assets"].as_array().unwrap();
    if assets.len() != browser.len() {
        failures.push(format!(
            "{name}: {} native assets, {} browser assets",
            assets.len(),
            browser.len()
        ));
    }
    for ((id, descriptor, bytes), b) in assets.iter().zip(browser) {
        let same_descriptor = match (&b["descriptorJson"], &b["descriptorSha256"]) {
            (Value::String(json), _) => json == descriptor,
            (_, Value::String(digest)) => *digest == sha256(descriptor.as_bytes()),
            _ => false,
        };
        if b["id"] != id.as_str() || !same_descriptor || b["bytesSha256"] != bytes.as_str() {
            failures.push(format!("{name}: asset {id} differs: {descriptor}"));
        }
    }
    let native = support::warnings(completed);
    let browser: Vec<Vec<u16>> = expected["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(units)
        .collect();
    if native != browser {
        let show = |w: &Vec<Vec<u16>>| -> Vec<String> {
            w.iter().map(|t| String::from_utf16_lossy(t)).collect()
        };
        failures.push(format!(
            "{name}: warnings differ\nnative:  {:#?}\nbrowser: {:#?}",
            show(&native),
            show(&browser)
        ));
    }
    failures
}

#[test]
fn foreign_import_matches_production_browser_open() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-import-vectors.json"
    ))
    .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut failures = Vec::new();
    let (mut accepted, mut refused) = (0, 0);
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = match &case["archiveBase64"] {
            Value::String(text) => base64(text),
            _ => {
                let bytes =
                    std::fs::read(root.join(case["archivePath"].as_str().unwrap())).unwrap();
                assert_eq!(
                    sha256(&bytes),
                    case["archiveSha256"].as_str().unwrap(),
                    "{name}"
                );
                bytes
            }
        };
        let expected = &case["expected"];
        match (open(bytes), expected["accepted"].as_bool().unwrap()) {
            (Ok(completed), true) => {
                failures.extend(compare(name, &completed, expected));
                completed.into_prepared().unwrap();
                accepted += 1;
            }
            (Err(_), false) => refused += 1,
            (Ok(_), false) => failures.push(format!("{name}: native accepted a browser refusal")),
            (Err(e), true) => failures.push(format!("{name}: native refused: {e}")),
        }
    }
    let shown: Vec<_> = failures.iter().take(12).collect();
    assert!(
        failures.is_empty(),
        "{} failures:\n{shown:#?}",
        failures.len()
    );
    assert_eq!((accepted, refused), (949, 7));
}

#[test]
fn authored_foreign_archives_match_production_browser_open() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-bbs-vectors.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = support::unhex(case["archiveBytesHex"].as_str().unwrap());
        let expected = &case["expected"];
        match (open(bytes), expected["accepted"].as_bool().unwrap()) {
            (Ok(completed), true) => {
                let mut normalized = expected.clone();
                normalized["assets"] = Value::Array(
                    expected["assets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|a| {
                            let descriptor: Value =
                                serde_json::from_str(a["descriptorJson"].as_str().unwrap()).unwrap();
                            serde_json::json!({
                                "id": descriptor["id"],
                                "descriptorJson": a["descriptorJson"],
                                "bytesSha256": sha256(&support::unhex(a["bytesHex"].as_str().unwrap())),
                            })
                        })
                        .collect(),
                );
                normalized["assets"]
                    .as_array_mut()
                    .unwrap()
                    .sort_by(|a, b| {
                        a["id"]
                            .as_str()
                            .unwrap()
                            .encode_utf16()
                            .cmp(b["id"].as_str().unwrap().encode_utf16())
                    });
                failures.extend(compare(name, &completed, &normalized));
            }
            (Err(_), false) => {}
            (Ok(_), false) => failures.push(format!("{name}: native accepted a browser refusal")),
            (Err(e), true) => failures.push(format!("{name}: native refused: {e}")),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn foreign_import_observes_cancellation_and_publishes_nothing() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-bbs-vectors.json"
    ))
    .unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["expected"]["accepted"] == true)
        .unwrap();
    let bytes = support::unhex(case["archiveBytesHex"].as_str().unwrap());
    for after in [0usize, 1, 5, 20] {
        let archive =
            Archive::open(Cursor::new(bytes.clone()), ZipLimits::default(), || false).unwrap();
        let mut polls = 0usize;
        let result = foreign::import(
            archive,
            support::foreign_limits(),
            &mut support::utc(),
            || {
                polls += 1;
                polls > after
            },
        );
        assert!(
            result.is_err(),
            "cancellation after {after} polls must refuse"
        );
    }
}
