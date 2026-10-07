#[allow(dead_code)]
#[path = "package.rs"]
pub mod package_support;
use orcaxr_archive::{
    Archive, ZipLimits,
    bbs::{
        foreign,
        read_xml::{Limits as XmlLimits, graph, package, part},
    },
    canonical::{CanonicalArchiveSource, CompleteLimits, CompletedCanonicalArchive},
    open,
};
use orcaxr_project::{
    ingress::{ProjectInputLimits, json::JsonLimits},
    validation::{TimestampPolicy, V8Timestamps, timestamp},
};
use serde_json::Value;
use std::io::Cursor;
pub fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../testdata/cross-platform/canonical-complete-vectors.json"
    ))
    .unwrap()
}
pub fn unhex(v: &str) -> Vec<u8> {
    v.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}
pub fn input_limits() -> ProjectInputLimits {
    ProjectInputLimits {
        document: JsonLimits {
            max_bytes: 8 << 20,
            max_nodes: 1 << 20,
            max_text_units: 8 << 20,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 4096,
        max_asset_bytes: 16 << 20,
        max_total_asset_bytes: 32 << 20,
    }
}
pub fn limits() -> CompleteLimits {
    let p = package_support::limits();
    CompleteLimits {
        records: p.records,
        text_units: p.text_units,
        assets: 4096,
        asset_bytes: p.asset_bytes,
        total_asset_bytes: p.total_asset_bytes,
        warnings: p.warnings,
        regenerated_bytes: 128 << 20,
        model: p.model,
        metadata: p.metadata,
        settings: p.settings,
        opc: p.opc,
    }
}
pub fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
pub fn input(c: &Value) -> CanonicalArchiveSource<Cursor<Vec<u8>>> {
    CanonicalArchiveSource::decode(
        Archive::open(
            Cursor::new(unhex(c["archiveHex"].as_str().unwrap())),
            ZipLimits::default(),
            || false,
        )
        .unwrap(),
        input_limits(),
        &mut utc(),
        || false,
    )
    .unwrap()
}
pub fn units(v: &str) -> Vec<u16> {
    v.encode_utf16().collect()
}
pub fn warnings(source: &CompletedCanonicalArchive) -> Vec<Vec<u16>> {
    orcaxr_archive::text::import_warnings(source.project().state(), source.warnings())
}
/// Foreign import budgets large enough for the real archives in the corpus.
pub fn foreign_limits() -> foreign::Limits {
    foreign::Limits {
        model: package::Limits {
            xml: XmlLimits {
                input_bytes: 256 << 20,
                text_units: 256 << 20,
                token_bytes: 1 << 20,
                elements: 64 << 20,
                attributes: 256 << 20,
                depth: 128,
            },
            part: part::Limits {
                objects: 100_000,
                vertices: 16_000_000,
                triangles: 16_000_000,
                components: 1_000_000,
                build_items: 100_000,
                materials: 4096,
                title_text_units: 1 << 20,
                facet_encoded_bytes: 256 << 20,
                facet_refinement_nodes: 256_000_000,
                facet_materialization_units: 256_000_000,
                extension_attribute_count: 16_000_000,
                extension_attribute_text_units: 256 << 20,
            },
            graph: graph::Limits::default(),
            model_parts: 1024,
            model_bytes: 1 << 30,
        },
        metadata_bytes: 64 << 20,
        project_json: JsonLimits {
            max_bytes: 64 << 20,
            max_nodes: 2_000_000,
            max_text_units: 64 << 20,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        materialization_units: 256_000_000,
        complete: limits(),
    }
}
/// One host Open policy over both archive paths.
pub fn open_limits() -> open::Limits {
    open::Limits {
        canonical: input_limits(),
        complete: limits(),
        foreign: foreign_limits(),
    }
}
