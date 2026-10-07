#[allow(dead_code)]
#[path = "package.rs"]
pub mod package_support;
use orcaxr_archive::{
    Archive, ZipLimits,
    canonical::{CanonicalArchiveSource, CompleteLimits, CompletedCanonicalArchive, ImportWarning},
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
    use orcaxr_archive::opc::Warning as O;
    let state = source.project().state();
    let mut result = vec![];
    for w in source.warnings() {
        let text = match w {
            ImportWarning::DenseChannels(n) => units(&format!(
                "Converted {n} facet refinement channel{} from the per-triangle encoding to the subdivided-facet encoding",
                if *n == 1 { "" } else { "s" }
            )),
            ImportWarning::FalseFuzzyAssignments(n) => units(&format!(
                "Removed {n} legacy false fuzzy-skin facet assignment{}; false represented the inherited/unpainted state",
                if *n == 1 { "" } else { "s" }
            )),
            ImportWarning::UnsupportedDigest { asset } => {
                let d = &state.source_assets[*asset];
                [
                    units("Asset "),
                    d.id.as_utf16().to_vec(),
                    units(" uses unsupported digest "),
                    d.digest.units().to_vec(),
                    units("; ZIP CRC and byte length were validated"),
                ]
                .concat()
            }
            ImportWarning::UnresolvedPlateCoordinates => units(&format!(
                "Opened the canonical OrcaXR envelope safely, but standard BBS metadata cannot be regenerated until its plate coordinates are resolvable: Cannot project {} canonical plates into BBS global build coordinates: project config has no valid printable_area",
                state.plates.len()
            )),
            ImportWarning::PreservedOriginal { blob } => [
                units("Detected externally modified "),
                state.extension_blobs[*blob].path.units().to_vec(),
                units("; preserving its original bytes as opaque BBS metadata"),
            ]
            .concat(),
            ImportWarning::PreservedEntries(n) => units(&format!(
                "Preserved {n} package entr{} as opaque canonical assets",
                if *n == 1 { "y" } else { "ies" }
            )),
            ImportWarning::Opc(o) => match o {
                O::IncompleteRelationship { source } => units(&format!(
                    "Ignored an incomplete OPC relationship in {}",
                    source.member()
                )),
                O::MissingContentTypes => units(
                    "3MF is missing [Content_Types].xml; a valid content-type manifest will be generated on save",
                ),
                O::MissingRelationshipTarget { source, id, target } => [
                    units("Preserved OPC relationship "),
                    id.units().to_vec(),
                    units(&format!(" from {}, but target ", source.member())),
                    target.units().to_vec(),
                    units(" is missing"),
                ]
                .concat(),
                O::MissingOverride { part_name } => [
                    units("Preserved content-type override for missing package part "),
                    part_name.units().to_vec(),
                ]
                .concat(),
                O::DroppedRelationships { .. } => panic!("import does not drop relationships"),
            },
        };
        result.push(text);
    }
    result.sort();
    result.dedup();
    result
}
