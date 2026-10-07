//! Native model staging against the production browser's `ModelImportParser`
//! (`tools/cross-platform/model-stage-vectors.mjs`): identical stable-ID
//! requests, complete staged state, asset descriptors and bytes, imported asset
//! IDs and repair/dropped/diagnostic notices for every case, including chained
//! imports into projects that already hold the same meshes and names.
use orcaxr_archive::models::{
    self, Error, Limits,
    stage::{IdKind, Placement, StageError, Staged, stage, state_json},
};
use orcaxr_contracts::canonical::{self, Value};
use orcaxr_project::{
    assets::AssetPayload,
    model::{Decode, ProjectState},
};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-stage-vectors.json"
    ))
    .unwrap()
}
fn decoding() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-import-vectors.json"
    ))
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn units(value: &Json) -> Vec<u16> {
    match value {
        Json::String(s) => s.encode_utf16().collect(),
        Json::Array(u) => u.iter().map(|v| v.as_u64().unwrap() as u16).collect(),
        other => panic!("{other}"),
    }
}
fn canonical_json(value: &Value) -> String {
    let mut out = Vec::new();
    value.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn limits(value: Option<&Json>) -> Limits {
    let mut limits = Limits::default();
    if let Some(Json::Object(fields)) = value {
        for (key, value) in fields {
            let n = value.as_u64().unwrap() as usize;
            match key.as_str() {
                "maxBytes" => limits.max_bytes = n,
                "maxTriangles" => limits.max_triangles = n,
                "maxVertices" => limits.max_vertices = n,
                "maxObjects" => limits.max_objects = n,
                "maxVolumesPerObject" => limits.max_volumes_per_object = n,
                "maxInstancesPerObject" => limits.max_instances_per_object = n,
                "maxArchiveMembers" => limits.max_archive_members = n,
                "maxNameLength" => limits.max_name_length = n,
                "maxXmlDepth" => limits.max_xml_depth = n,
                other => panic!("{other}"),
            }
        }
    }
    limits
}
fn placement(value: &Json) -> Placement {
    Placement {
        bed_size_mm: value["bedSizeMm"]
            .as_array()
            .map(|v| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]),
        drop_to_bed: value["dropToBed"].as_bool().unwrap_or(false),
    }
}

#[derive(Clone)]
struct Base {
    state: ProjectState,
    assets: Vec<AssetPayload>,
}
struct Run {
    requests: Vec<&'static str>,
    result: Result<Staged, Json>,
}
fn run(base: &Base, row: &Json, placement: Placement, imported_at: &[u16]) -> Run {
    let bytes = match &row["bytesBase64"] {
        Json::String(b64) => base64(b64),
        _ => std::fs::read(root().join(row["path"].as_str().unwrap())).unwrap(),
    };
    let mut requests = Vec::new();
    let decoded = models::decode(
        &bytes,
        &units(&row["filename"]),
        &limits(row.get("limits")),
        || false,
    );
    let result = match decoded {
        Err(Error::Unsupported(r, f)) => Err(json!([
            "UnsupportedModelFormatError",
            r.code(),
            f.map(|f| f.code())
        ])),
        Err(Error::Malformed(r, f)) => Err(json!([
            "MalformedModelSourceError",
            r.code(),
            f.map(|f| f.code())
        ])),
        Err(Error::Cancelled) => Err(json!("cancelled")),
        Ok(decoded) => {
            let existing: Vec<Value> = base.assets.iter().map(|a| a.descriptor.clone()).collect();
            let mut next = |kind: IdKind| {
                requests.push(kind.code());
                format!("import:model-test:{}-{}", kind.code(), requests.len())
                    .encode_utf16()
                    .collect()
            };
            stage(
                &decoded,
                &base.state,
                &existing,
                imported_at,
                placement,
                &mut next,
                || false,
            )
            .map_err(|e| match e {
                StageError::Malformed(r, f) => {
                    json!(["MalformedModelSourceError", r.code(), f.code()])
                }
                StageError::Encoding => json!(["Error", null, null]),
                other => json!(format!("{other:?}")),
            })
        }
    };
    Run { requests, result }
}
fn render(base: &Base, run: &Run, full_limit: usize) -> Json {
    match &run.result {
        Err(error) => json!({ "error": error }),
        Ok(staged) => {
            let state = String::from_utf8(state_json(&staged.state)).unwrap();
            let mut out = serde_json::Map::new();
            out.insert("idRequests".into(), json!(run.requests));
            if state.len() <= full_limit {
                out.insert("stateJson".into(), json!(state));
            } else {
                out.insert("stateSha256".into(), json!(sha(state.as_bytes())));
            }
            out.insert(
                "assets".into(),
                json!(
                    base.assets
                        .iter()
                        .chain(&staged.new_assets)
                        .map(|a| json!({
                            "descriptorJson": canonical_json(&a.descriptor),
                            "bytesSha256": sha(&a.bytes),
                        }))
                        .collect::<Vec<_>>()
                ),
            );
            out.insert(
                "importedAssetIds".into(),
                json!(
                    staged
                        .imported_asset_ids
                        .iter()
                        .map(|id| String::from_utf16(id.as_utf16()).unwrap())
                        .collect::<Vec<_>>()
                ),
            );
            for (key, list) in [
                ("repairs", &staged.repairs),
                ("droppedFields", &staged.dropped_fields),
                ("diagnostics", &staged.diagnostics),
            ] {
                out.insert(
                    key.into(),
                    json!(canonical_json(&Value::Array(list.clone()))),
                );
            }
            Json::Object(out)
        }
    }
}
fn base_state(json: &str) -> ProjectState {
    ProjectState::from_value(canonical::parse(json).unwrap()).unwrap()
}
fn into_base(base: &Base, run: Run) -> Base {
    let staged = run.result.ok().unwrap();
    Base {
        state: staged.state,
        assets: base
            .assets
            .iter()
            .cloned()
            .chain(staged.new_assets)
            .collect(),
    }
}

#[test]
fn native_staging_matches_every_browser_case() {
    let corpus = corpus();
    let decoding = decoding();
    let rows: HashMap<&str, &Json> = decoding["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), c))
        .collect();
    let imported_at: Vec<u16> = corpus["importedAt"]
        .as_str()
        .unwrap()
        .encode_utf16()
        .collect();
    let placements = &corpus["placements"];
    let empty = Base {
        state: base_state(corpus["bases"]["empty"].as_str().unwrap()),
        assets: vec![],
    };
    let second = Base {
        state: base_state(corpus["bases"]["second-active"].as_str().unwrap()),
        assets: vec![],
    };
    let holding = into_base(
        &empty,
        run(
            &empty,
            rows["stl-binary/cube"],
            placement(&placements["bed"]),
            &imported_at,
        ),
    );
    let twice = into_base(
        &holding,
        run(
            &holding,
            rows["stl-binary/cube"],
            placement(&placements["bed"]),
            &imported_at,
        ),
    );
    let bases: HashMap<&str, &Base> = [
        ("empty", &empty),
        ("second-active", &second),
        ("holding", &holding),
        ("twice", &twice),
    ]
    .into();
    let mut failures = Vec::new();
    let mut staged = 0;
    for case in corpus["cases"].as_array().unwrap() {
        let base = bases[case["base"].as_str().unwrap()];
        let run = run(
            base,
            rows[case["decode"].as_str().unwrap()],
            placement(&placements[case["placement"].as_str().unwrap()]),
            &imported_at,
        );
        let actual = render(base, &run, 64 * 1024);
        if actual != case["expected"] {
            failures.push(format!(
                "{}\n  expected {}\n  actual   {}",
                case["name"], case["expected"], actual
            ));
        } else if run.result.is_ok() {
            staged += 1;
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(staged >= 200, "{staged}");
}

#[test]
fn reference_sources_match_current_production_parser() {
    for row in corpus()["sources"].as_array().unwrap() {
        let bytes = std::fs::read(root().join(row["path"].as_str().unwrap())).unwrap();
        assert_eq!(
            sha(&bytes),
            row["sha256"].as_str().unwrap(),
            "{}",
            row["path"]
        );
    }
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
