use orcaxr_archive::bbs::{
    facets,
    model::{Authoring, Error, Limits, Warning},
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetLease, AssetPayload, AssetRepository},
    ids::AssetId,
    model::{Decode, ProjectData, ProjectState},
    validation::ValidatedProject,
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-model-vectors.json"
    ))
    .unwrap()
}
fn limits() -> Limits {
    Limits {
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
fn input(row: &Json) -> (ValidatedProject, Vec<AssetLease>) {
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
fn row<'a>(corpus: &'a Json, name: &str) -> &'a Json {
    corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()
}
fn render(
    project: &ValidatedProject,
    assets: Vec<AssetLease>,
    limits: Limits,
) -> Result<Vec<u8>, Error> {
    let model = Authoring::new(project, assets, limits, || false)?;
    let mut out = vec![];
    let size = model.write(&mut out, || false)?;
    assert_eq!(size, out.len());
    Ok(out)
}
#[test]
fn complete_standard_models_match_independent_browser_bytes_and_refusals() {
    let mut mismatches = vec![];
    for row in corpus()["cases"].as_array().unwrap() {
        let (project, assets) = input(row);
        let result = render(&project, assets, limits());
        if row.get("error").is_some() {
            if result.is_ok() {
                mismatches.push(format!("{}: native accepted browser refusal", row["name"]));
            }
        } else {
            match result {
                Ok(bytes) => {
                    if bytes != row["xml"].as_str().unwrap().as_bytes() {
                        std::fs::write("/tmp/orcaxr-bbs-model-actual.xml", &bytes).unwrap();
                        std::fs::write(
                            "/tmp/orcaxr-bbs-model-expected.xml",
                            row["xml"].as_str().unwrap(),
                        )
                        .unwrap();
                        mismatches.push(format!("{}: unequal XML", row["name"]));
                    }
                }
                Err(e) => mismatches.push(format!("{}: native {e}", row["name"])),
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
#[test]
fn captured_asset_membership_and_complete_metadata_are_checked() {
    let c = corpus();
    let (project, assets) = input(row(&c, "basic"));
    assert!(matches!(
        Authoring::new(
            &project,
            assets.iter().cloned().chain(assets.iter().cloned()),
            limits(),
            || false
        ),
        Err(Error::DuplicateAsset)
    ));
    let mut repo = AssetRepository::new();
    let mut descriptor = assets[0].descriptor().clone();
    let Value::Object(ref mut map) = descriptor else {
        panic!()
    };
    map.insert(
        "unknownMetadata".encode_utf16().collect(),
        Value::Bool(true),
    );
    repo.put_owned(AssetPayload {
        descriptor,
        bytes: assets[0].bytes().to_vec(),
    })
    .unwrap();
    let different = repo.peek(assets[0].id()).unwrap();
    assert!(matches!(
        Authoring::new(&project, [different], limits(), || false),
        Err(Error::AssetMetadata)
    ));
    let mut descriptor = assets[0].descriptor().clone();
    let Value::Object(ref mut map) = descriptor else {
        panic!()
    };
    map.insert(
        "id".encode_utf16().collect(),
        Value::String("import:asset:unknown".encode_utf16().collect()),
    );
    repo.put_owned(AssetPayload {
        descriptor,
        bytes: assets[0].bytes().to_vec(),
    })
    .unwrap();
    let unknown = repo
        .peek(&AssetId::try_from_str("import:asset:unknown").unwrap())
        .unwrap();
    assert!(matches!(
        Authoring::new(&project, [unknown], limits(), || false),
        Err(Error::UnexpectedAsset)
    ));
    let model = Authoring::new(&project, assets.clone(), limits(), || false).unwrap();
    drop(assets);
    let mut out = vec![];
    model.write(&mut out, || false).unwrap();
    assert_eq!(out, row(&c, "basic")["xml"].as_str().unwrap().as_bytes());
}
#[test]
fn omissions_are_explicit_and_unsupported_color_drops_the_entire_root() {
    let c = corpus();
    for name in [
        "missing-mesh",
        "invalid-mesh",
        "disabled-refined-root",
        "material-states-65",
        "whole-brim",
    ] {
        let (project, assets) = input(row(&c, name));
        let model = Authoring::new(&project, assets, limits(), || false).unwrap();
        assert!(!model.warnings().is_empty(), "{name}");
        if name.contains("refined") || name == "material-states-65" {
            assert!(
                model
                    .warnings()
                    .iter()
                    .any(|w| matches!(w, Warning::RefinedColor { .. }))
            );
            let mut out = vec![];
            model.write(&mut out, || false).unwrap();
            assert!(!String::from_utf8(out).unwrap().contains("paint_color=\""));
        }
    }
}
#[test]
fn explicit_limits_and_cancellation_do_not_silently_omit_oversized_geometry() {
    let c = corpus();
    let (project, assets) = input(row(&c, "basic"));
    for field in 0..7 {
        let mut cap = limits();
        match field {
            0 => cap.records = 0,
            1 => cap.text_units = 0,
            2 => cap.paint_entries = 0,
            3 => cap.vertices = 0,
            4 => cap.triangles = 0,
            5 => cap.mesh.vertices = 0,
            _ => cap.mesh.asset_bytes = 0,
        };
        assert!(
            Authoring::new(&project, assets.clone(), cap, || false).is_err(),
            "limit {field}"
        );
    }
    let (project, assets) = input(row(&c, "split-color"));
    let mut cap = limits();
    cap.paint_nodes = 0;
    assert!(matches!(
        Authoring::new(&project, assets.clone(), cap, || false),
        Err(Error::Paint(facets::Error::NodeLimit))
    ));
    assert!(matches!(
        Authoring::new(&project, assets.clone(), limits(), || true),
        Err(Error::Cancelled)
    ));
    let mut calls = 0;
    assert!(
        Authoring::new(&project, assets.clone(), limits(), || {
            calls += 1;
            calls == 10
        })
        .is_err()
    );
    let model = Authoring::new(&project, assets.clone(), limits(), || false).unwrap();
    let mut out = vec![];
    assert!(model.write(&mut out, || true).is_err());
    assert!(out.is_empty());
    let expected = row(&c, "split-color")["xml"].as_str().unwrap();
    for size in [0, 1, 100, expected.len() - 1, expected.len()] {
        let mut cap = limits();
        cap.output_bytes = size;
        let result = render(&project, assets.clone(), cap);
        if size == expected.len() {
            assert_eq!(result.unwrap(), expected.as_bytes());
        } else {
            assert!(result.is_err());
        }
    }
}
#[test]
fn reference_sources_are_current() {
    for (path, digest) in corpus()["sources"].as_object().unwrap() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .join(path),
        )
        .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            digest.as_str().unwrap(),
            "{path}"
        );
    }
}

#[test]
fn leaf_and_borrowed_tree_helpers_keep_wire_states_and_budgets() {
    use orcaxr_project::facets::{Node, PaintValue, State};
    let leaf = Node::leaf(State::Assigned(PaintValue::Bool(true)));
    for state in 0..=255 {
        let mut out = vec![];
        facets::write(
            facets::Tree::Computed(&leaf),
            |_| Some(state),
            &mut out,
            100,
            || false,
        )
        .unwrap();
        assert_eq!(facets::encode_leaf(state).as_bytes(), out);
    }
    let tree = Node::split(1, 2, vec![leaf, Node::leaf(State::Unpainted)]).unwrap();
    let mut values = vec![];
    assert_eq!(
        facets::visit_assigned(
            facets::Tree::Computed(&tree),
            3,
            |v| values.push(v == facets::Paint::Bool(true)),
            || false
        ),
        Ok(3)
    );
    assert_eq!(values, [true]);
    assert_eq!(
        facets::visit_assigned(facets::Tree::Computed(&tree), 2, |_| {}, || false),
        Err(facets::Error::NodeLimit)
    );
    assert_eq!(
        facets::visit_assigned(facets::Tree::Computed(&tree), 3, |_| {}, || true),
        Err(facets::Error::Cancelled)
    );
}
#[test]
fn complete_model_output_handles_short_interrupted_failed_and_cancelled_hosts() {
    use std::io::{self, Write};
    struct Sink {
        bytes: Vec<u8>,
        calls: usize,
        fail: bool,
    }
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.fail {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private host info",
                ));
            }
            if self.calls.is_multiple_of(3) {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = bytes.len().min(3);
            self.bytes.extend_from_slice(&bytes[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host owns flush")
        }
    }
    let c = corpus();
    let (project, assets) = input(row(&c, "split-color"));
    let model = Authoring::new(&project, assets, limits(), || false).unwrap();
    let mut sink = Sink {
        bytes: vec![],
        calls: 0,
        fail: false,
    };
    model.write(&mut sink, || false).unwrap();
    assert_eq!(
        sink.bytes,
        row(&c, "split-color")["xml"].as_str().unwrap().as_bytes()
    );
    sink.fail = true;
    let error = model.write(&mut sink, || false).unwrap_err();
    assert_eq!(
        error,
        Error::Xml(orcaxr_archive::bbs::xml::Error::Io(
            io::ErrorKind::PermissionDenied
        ))
    );
    assert!(!error.to_string().contains("private"));
    let mut polls = 0;
    let mut out = vec![];
    assert!(
        model
            .write(&mut out, || {
                polls += 1;
                polls > 50
            })
            .is_err()
    );
    assert!(out.is_empty());
}
