//! Complete native foreign BBS/3MF import against independent production-browser
//! Open results (tools/cross-platform/foreign-import-vectors.mjs and
//! foreign-bbs-vectors.mjs): acceptance, canonical state, asset descriptors and
//! bytes, and the sorted unique warning set.
#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod support;
use orcaxr_archive::{
    Archive, ZipLimits, archive_layout::ArchiveOptions, bbs::foreign,
    canonical::CompletedCanonicalArchive, open as archive_open, policy::Policy,
};
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

/// `applyArchiveEdits` (`archive-wasm-replay.mjs`): byte edits of a base,
/// each applied to the result of the ones before it.
fn apply_edits(base: &[u8], edits: &Value) -> Vec<u8> {
    let mut bytes = base.to_vec();
    let at = |pair: &Value, i: usize| pair[i].as_u64().unwrap() as usize;
    for edit in edits.as_array().unwrap() {
        if let Some(flip) = edit.get("flip") {
            if at(flip, 0) < bytes.len() {
                bytes[at(flip, 0)] ^= 1 << at(flip, 1);
            }
        } else if let Some(set) = edit.get("set") {
            if at(set, 0) < bytes.len() {
                bytes[at(set, 0)] = at(set, 1) as u8;
            }
        } else if let Some(length) = edit.get("truncate") {
            bytes.truncate(length.as_u64().unwrap() as usize);
        } else if let Some(insert) = edit.get("insert") {
            let position = at(insert, 0).min(bytes.len());
            let inserted: Vec<u8> = insert[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            bytes.splice(position..position, inserted);
        } else {
            let remove = &edit["remove"];
            let from = at(remove, 0).min(bytes.len());
            let to = (from + at(remove, 1)).min(bytes.len());
            bytes.drain(from..to);
        }
    }
    bytes
}

/// Canonical or foreign, as the host's one Open dispatches, under the
/// production policy the bindings derive from browser-equivalent budgets
/// (`archive-wasm-replay.mjs`), not the tighter test limits above.
fn open_any(bytes: Vec<u8>) -> Result<CompletedCanonicalArchive, String> {
    let policy = Policy::new(ArchiveOptions {
        archive_bytes: 1 << 30,
        entries: 4096,
        entry_bytes: 512 << 20,
        total_bytes: 2 << 30,
        vertices: 16_000_000,
        triangles: 16_000_000,
        records: 2_000_000,
        text_units: 64 << 20,
        paint_nodes: 256_000_000,
        assets: 4096,
        asset_bytes: 512 << 20,
        total_asset_bytes: 2 << 30,
        warnings: 1_000_000,
    });
    let archive =
        Archive::open(Cursor::new(bytes), policy.zip(), || false).map_err(|e| format!("{e:?}"))?;
    archive_open::open(archive, policy.open(), &mut support::utc(), || false)
        .map_err(|e| format!("{e:?}"))
}

#[test]
fn hostile_archives_match_production_browser_open() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/hostile-archive-vectors.json"
    ))
    .unwrap();
    let bases: Vec<Vec<u8>> = corpus["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| base64(b["archiveBase64"].as_str().unwrap()))
        .collect();
    let mut failures = Vec::new();
    let (mut accepted, mut refused) = (0, 0);
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = match &case["archiveBase64"] {
            Value::String(text) => base64(text),
            _ => apply_edits(
                &bases[case["base"].as_u64().unwrap() as usize],
                &case["edits"],
            ),
        };
        let expected = &case["expected"];
        match (open_any(bytes), expected["accepted"].as_bool().unwrap()) {
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
    assert_eq!((accepted, refused), (55, 414));
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
