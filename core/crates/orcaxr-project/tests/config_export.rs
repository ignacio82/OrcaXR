//! File → Export Config… (`config-export-vectors.json`, from the browser's
//! `exportProfileConfigJson`): every profile of the bundled catalog and of the
//! synthetic catalogs, built from the same JSON text, written byte for byte.
use orcaxr_project::{
    ingress::json::JsonLimits,
    settings::{catalog_exchange::*, presets::AsciiRootCollation},
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/config-export-vectors.json"
    ))
    .unwrap()
}

fn catalog(bytes: &[u8]) -> HostCatalog {
    let limits = JsonLimits {
        max_bytes: 8 << 20,
        max_nodes: 1 << 20,
        max_text_units: 8 << 20,
        max_number_bytes: 64,
        max_depth: 64,
    };
    let mut upload = CatalogUpload::new(bytes.len(), limits).unwrap();
    for (i, chunk) in bytes.chunks(65536).enumerate() {
        upload.append(i * 65536, chunk).unwrap();
    }
    upload.build(&mut AsciiRootCollation).unwrap()
}

/// The catalog's files by profile ID.
fn files(host: &HostCatalog) -> HashMap<String, String> {
    (0..host.profile_count())
        .map(|i| {
            let profile = host.profile(i).unwrap();
            (
                String::from_utf16(&profile.id).unwrap(),
                host.config_json(i).unwrap(),
            )
        })
        .collect()
}

#[test]
fn bundled_profiles_are_the_browsers() {
    let fixture = corpus();
    let host = catalog(include_bytes!(
        "../../../../web/public/profiles/catalog.json"
    ));
    let files = files(&host);
    let cases = fixture["bundled"]["profiles"].as_array().unwrap();
    assert_eq!(files.len(), cases.len());
    for case in cases {
        let file = &files[case["id"].as_str().unwrap()];
        let hex: String = Sha256::digest(file.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            (file.len() as u64, hex.as_str()),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap()
            ),
            "{}",
            case["id"]
        );
    }
    assert_eq!(host.config_json(host.profile_count()), None);
}

#[test]
fn synthetic_profiles_are_the_browsers() {
    let fixture = corpus();
    let mut count = 0;
    for catalog_case in fixture["synthetic"].as_array().unwrap() {
        let host = catalog(catalog_case["catalogText"].as_str().unwrap().as_bytes());
        let files = files(&host);
        for case in catalog_case["profiles"].as_array().unwrap() {
            assert_eq!(
                files[case["id"].as_str().unwrap()],
                case["json"].as_str().unwrap(),
                "{}",
                case["id"]
            );
            count += 1;
        }
    }
    assert_eq!(count, 9);
}
