//! The generated host archive policy: option decoding refuses malformed input,
//! and limits derived from browser-equivalent budgets accept every Open and Save
//! the production browser accepts, while tight budgets refuse instead of
//! truncating.
#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod complete;
use complete::package_support as support;
use orcaxr_archive::{
    Archive, ZipLimits,
    archive_layout::{ArchiveOptions, VERSION, decode_options},
    open, package,
    policy::{Policy, archive_code, open_code, save_code},
};
use serde_json::Value;
use std::io::Cursor;

/// The browser's safe-ZIP defaults with budgets for multi-million-facet projects.
fn browser_equivalent() -> ArchiveOptions {
    ArchiveOptions {
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
    }
}
fn encode(o: ArchiveOptions) -> Vec<f64> {
    [
        o.archive_bytes,
        o.entries,
        o.entry_bytes,
        o.total_bytes,
        o.vertices,
        o.triangles,
        o.records,
        o.text_units,
        o.paint_nodes,
        o.assets,
        o.asset_bytes,
        o.total_asset_bytes,
        o.warnings,
    ]
    .map(|v| v as f64)
    .to_vec()
}
fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let bytes: Vec<u8> = text.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, c)| n | u32::from(value(*c)) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

#[test]
fn options_decode_exactly_and_refuse_malformed_budgets() {
    let valid = encode(browser_equivalent());
    assert_eq!(
        decode_options(VERSION as f64, &valid),
        Some(browser_equivalent())
    );
    assert_eq!(decode_options(VERSION as f64 + 1.0, &valid), None);
    assert_eq!(decode_options(VERSION as f64, &valid[1..]), None);
    for (index, bad) in [
        (0, 0.0),
        (1, 1.5),
        (2, -1.0),
        (3, f64::NAN),
        (4, f64::INFINITY),
        (5, 4_294_967_296.0),
    ] {
        let mut input = valid.clone();
        input[index] = bad;
        assert_eq!(decode_options(VERSION as f64, &input), None, "{index}");
    }
    let mut entry_over_total = valid.clone();
    entry_over_total[2] = entry_over_total[3] + 1.0;
    assert_eq!(decode_options(VERSION as f64, &entry_over_total), None);
    let mut asset_over_total = valid;
    asset_over_total[10] = asset_over_total[11] + 1.0;
    assert_eq!(decode_options(VERSION as f64, &asset_over_total), None);
    assert!(Policy::new(browser_equivalent()).zip().validate().is_ok());
}

#[test]
fn derived_limits_accept_every_browser_open_and_save() {
    let policy = Policy::new(browser_equivalent());
    // Browser refusals are invalid input, never a budget refusal.
    let open_archive = |bytes: Vec<u8>| {
        let archive = Archive::open(Cursor::new(bytes), policy.zip(), || false)
            .map_err(|e| format!("{e:?}"))?;
        open::open(archive, policy.open(), &mut complete::utc(), || false).map_err(|e| {
            assert_ne!(open_code(&e), "resource_limit", "{e:?}");
            format!("{e:?}")
        })
    };
    let mut failures = Vec::new();
    let canonical = complete::corpus();
    for case in canonical["cases"].as_array().unwrap() {
        let accepted = !case["expected"].is_null();
        let result = open_archive(complete::unhex(case["archiveHex"].as_str().unwrap()));
        if result.is_ok() != accepted {
            failures.push(format!("canonical {}: {:?}", case["name"], result.err()));
        }
    }
    let foreign: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-import-vectors.json"
    ))
    .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for case in foreign["cases"].as_array().unwrap() {
        let bytes = match &case["archiveBase64"] {
            Value::String(text) => base64(text),
            _ => std::fs::read(root.join(case["archivePath"].as_str().unwrap())).unwrap(),
        };
        let accepted = case["expected"]["accepted"].as_bool().unwrap();
        let result = open_archive(bytes);
        if result.is_ok() != accepted {
            failures.push(format!("foreign {}: {:?}", case["name"], result.err()));
        }
    }
    let sources = support::sources();
    let references = support::references();
    for row in references["cases"].as_array().unwrap() {
        let input = &sources[row["source"].as_str().unwrap()]["cases"]
            [row["index"].as_u64().unwrap() as usize];
        let (project, assets) = support::input(input);
        let result = package::write(
            &project,
            assets,
            &mut Cursor::new(vec![]),
            policy.package(),
            || false,
        );
        if result.is_ok() == row.get("error").is_some() {
            failures.push(format!("save {} {}", row["source"], row["name"]));
        }
        if let Err(e) = result {
            assert_ne!(save_code(e), "resource_limit", "{e:?}");
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn tight_budgets_refuse_instead_of_truncating() {
    let foreign: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-import-vectors.json"
    ))
    .unwrap();
    let case = foreign["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "real/web/public/models/multicolor_hexagon.3mf")
        .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = std::fs::read(root.join(case["archivePath"].as_str().unwrap())).unwrap();
    let base = browser_equivalent();
    for options in [
        ArchiveOptions {
            triangles: 10,
            ..base
        },
        ArchiveOptions {
            vertices: 10,
            ..base
        },
        ArchiveOptions {
            records: 10,
            ..base
        },
        ArchiveOptions {
            entry_bytes: 4096,
            ..base
        },
        ArchiveOptions {
            asset_bytes: 1024,
            ..base
        },
    ] {
        let policy = Policy::new(options);
        let code = match Archive::open(Cursor::new(bytes.clone()), policy.zip(), || false) {
            Err(e) => archive_code(e),
            Ok(archive) => match open::open(archive, policy.open(), &mut complete::utc(), || false)
            {
                Err(e) => open_code(&e),
                Ok(_) => "accepted",
            },
        };
        // Hosts can tell a budget refusal from an invalid archive.
        assert_eq!(code, "resource_limit", "{options:?}");
    }
    // The archive opens with default budgets, so each refusal is the budget's.
    let archive = Archive::open(Cursor::new(bytes), ZipLimits::default(), || false).unwrap();
    assert!(
        open::open(
            archive,
            Policy::new(base).open(),
            &mut complete::utc(),
            || false
        )
        .is_ok()
    );
}
