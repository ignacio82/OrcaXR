use orcaxr_archive::{
    bbs::model::{self, metadata, settings},
    canonical, opc, package, write,
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetLease, AssetPayload, AssetRepository},
    ids::AssetId,
    model::{Decode, ProjectData, ProjectState},
    validation::ValidatedProject,
};
use serde_json::Value as Json;
pub fn input(row: &Json) -> (ValidatedProject, Vec<AssetLease>) {
    let state =
        ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut timestamps = |text: &[u16]| {
        Ok::<_, ()>(
            text.iter()
                .copied()
                .eq("2026-07-17T00:00:00.000Z".encode_utf16()),
        )
    };
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut timestamps)
        .unwrap_or_else(|e| panic!("{}: {e:?}", row["name"]));
    let mut repo = AssetRepository::new();
    let mut leases = vec![];
    for row in row["assets"].as_array().unwrap() {
        let descriptor = parse(row["descriptorJson"].as_str().unwrap()).unwrap();
        let Value::Object(fields) = &descriptor else {
            panic!()
        };
        let id =
            AssetId::from_value(fields[&"id".encode_utf16().collect::<Vec<_>>()].clone()).unwrap();
        repo.put_owned(AssetPayload {
            descriptor,
            bytes: row["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect(),
        })
        .unwrap();
        leases.push(repo.peek(&id).unwrap());
    }
    (project, leases)
}
fn model_limits() -> model::Limits {
    model::Limits {
        mesh: orcaxr_project::mesh::Limits {
            asset_bytes: 64 << 20,
            vertices: 1_000_000,
            indices: 3_000_000,
        },
        records: 1_000_000,
        text_units: 64 << 20,
        paint_entries: 1_000_000,
        paint_nodes: 8_000_000,
        vertices: 1_000_000,
        triangles: 1_000_000,
        output_bytes: 64 << 20,
    }
}
pub fn limits() -> package::Limits {
    package::Limits {
        records: 1_000_000,
        text_units: 64 << 20,
        asset_bytes: 64 << 20,
        total_asset_bytes: 128 << 20,
        warnings: 1_000_000,
        model: model_limits(),
        metadata: metadata::Limits {
            records: 1_000_000,
            config_nodes: 1_000_000,
            config_depth: 128,
            text_units: 64 << 20,
            drawing_bytes: 64 << 20,
            output_bytes: 64 << 20,
        },
        settings: settings::Limits {
            records: 1_000_000,
            config_nodes: 1_000_000,
            config_depth: 128,
            text_units: 64 << 20,
            derived_values: 1_000_000,
            output_bytes: 64 << 20,
        },
        opc: opc::Limits {
            part_bytes: 4 << 20,
            tag_bytes: 1 << 20,
            records: 10000,
            text_units: 4 << 20,
            output_bytes: 4 << 20,
        },
        envelope: canonical::write::Limits {
            assets: 4096,
            path_bytes: 512,
            state_nodes: 8_000_000,
            state_depth: 256,
            output_bytes: 64 << 20,
        },
        zip: write::Limits::default(),
    }
}
pub fn sources() -> std::collections::BTreeMap<&'static str, Json> {
    [
        (
            "package-input",
            include_str!("../../../../../testdata/cross-platform/package-input-vectors.json"),
        ),
        (
            "bbs-model",
            include_str!("../../../../../testdata/cross-platform/bbs-model-vectors.json"),
        ),
        (
            "bbs-metadata",
            include_str!("../../../../../testdata/cross-platform/bbs-metadata-vectors.json"),
        ),
        (
            "bbs-settings",
            include_str!("../../../../../testdata/cross-platform/bbs-settings-vectors.json"),
        ),
    ]
    .into_iter()
    .map(|(name, json)| (name, serde_json::from_str(json).unwrap()))
    .collect()
}
pub fn references() -> Json {
    serde_json::from_str(include_str!(
        "../../../../../testdata/cross-platform/package-vectors.json"
    ))
    .unwrap()
}
