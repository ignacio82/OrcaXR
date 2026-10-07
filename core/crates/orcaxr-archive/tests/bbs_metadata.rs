use orcaxr_archive::bbs::{
    model::{
        self, Error,
        metadata::{self, Member},
    },
    numbers, xml,
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
use std::{
    collections::BTreeMap,
    io::{self, Write},
};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-metadata-vectors.json"
    ))
    .unwrap()
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
fn limits() -> metadata::Limits {
    metadata::Limits {
        records: 1_000_000,
        config_nodes: 1_000_000,
        config_depth: 128,
        text_units: 64 << 20,
        drawing_bytes: 64 << 20,
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
) -> Result<BTreeMap<String, String>, Error> {
    let model = model::Authoring::new(project, assets.clone(), model_limits(), || false)?;
    let metadata = metadata::Authoring::new(&model, assets, limits(), || false)?;
    let mut files = BTreeMap::new();
    for member in Member::ALL {
        let mut bytes = vec![];
        if let Some(n) = metadata.write(member, &mut bytes, || false)? {
            assert_eq!(n, bytes.len());
            files.insert(member.path().to_owned(), String::from_utf8(bytes).unwrap());
        } else {
            assert!(bytes.is_empty());
        }
    }
    Ok(files)
}
#[test]
fn complete_members_match_independent_browser_bytes_and_refusals() {
    let mut failures = vec![];
    for row in corpus()["cases"].as_array().unwrap() {
        let (project, assets) = input(row);
        let result = render(&project, assets.clone());
        if row.get("error").is_some() {
            if result.is_ok() {
                failures.push(format!("{}: native accepted browser refusal", row["name"]));
            }
            continue;
        }
        match result {
            Ok(files) if serde_json::to_value(&files).unwrap() == row["files"] => {}
            result => failures.push(format!("{}: differing files: {result:?}", row["name"])),
        }
        let model =
            model::Authoring::new(&project, assets.clone(), model_limits(), || false).unwrap();
        let metadata = metadata::Authoring::new(&model, assets, limits(), || false).unwrap();
        let drawings: BTreeMap<_, _> = metadata
            .drawings()
            .map(|(path, asset)| (String::from_utf16(path).unwrap(), asset.bytes().to_vec()))
            .collect();
        assert_eq!(
            serde_json::to_value(drawings).unwrap(),
            row["drawings"],
            "{}",
            row["name"]
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn six_decimal_and_emboss_numeric_policies_match_browser_bits() {
    for row in corpus()["numbers"].as_array().unwrap() {
        let v = f64::from_bits(u64::from_str_radix(row["bits"].as_str().unwrap(), 16).unwrap());
        assert_eq!(
            numbers::fixed6(v).unwrap().as_str(),
            row["fixed6"].as_str().unwrap(),
            "{v:?}"
        );
        assert_eq!(
            numbers::emboss(v).unwrap().as_str(),
            row["emboss"].as_str().unwrap(),
            "{v:?}"
        );
    }
    for v in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        assert!(numbers::fixed6(v).is_err());
        assert!(numbers::emboss(v).is_err());
    }
}
#[test]
fn preparation_and_output_budgets_are_explicit() {
    let c = corpus();
    let (p, a) = input(row(&c, "svg-present"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    for field in 0..4 {
        let mut l = limits();
        match field {
            0 => l.records = 0,
            1 => l.config_nodes = 0,
            2 => l.text_units = 0,
            _ => l.drawing_bytes = 0,
        }
        assert!(
            matches!(
                metadata::Authoring::new(&model, a.clone(), l, || false),
                Err(Error::ResourceLimit)
            ),
            "{field}"
        );
    }
    assert!(matches!(
        metadata::Authoring::new(&model, a.clone(), limits(), || true),
        Err(Error::Cancelled)
    ));
    let mut polls = 0;
    assert!(matches!(
        metadata::Authoring::new(&model, a.clone(), limits(), || {
            polls += 1;
            polls > 10
        }),
        Err(Error::Cancelled)
    ));
    let (p, a) = input(row(&c, "all-config-values"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    let mut l = limits();
    l.config_depth = 1;
    assert!(matches!(
        metadata::Authoring::new(&model, a.clone(), l, || false),
        Err(Error::ResourceLimit)
    ));
    let expected = row(&c, "all-config-values")["files"][Member::ModelSettings.path()]
        .as_str()
        .unwrap()
        .len();
    for cap in [0, expected - 1, expected] {
        let mut l = limits();
        l.output_bytes = cap;
        let metadata = metadata::Authoring::new(&model, a.clone(), l, || false).unwrap();
        let result = metadata.write(Member::ModelSettings, &mut vec![], || false);
        assert_eq!(result.is_ok(), cap == expected);
    }
}
#[test]
fn drawing_membership_is_checked_and_leases_survive_input_release() {
    let c = corpus();
    let (p, a) = input(row(&c, "svg-present"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    assert!(matches!(
        metadata::Authoring::new(
            &model,
            a.iter().cloned().chain(a.iter().cloned()),
            limits(),
            || false
        ),
        Err(Error::DuplicateAsset)
    ));
    let mut repository = AssetRepository::new();
    let mut descriptor = a[1].descriptor().clone();
    let Value::Object(ref mut fields) = descriptor else {
        panic!()
    };
    fields.insert("foreign".encode_utf16().collect(), Value::Bool(true));
    repository
        .put_owned(AssetPayload {
            descriptor,
            bytes: a[1].bytes().to_vec(),
        })
        .unwrap();
    assert!(matches!(
        metadata::Authoring::new(
            &model,
            [repository.peek(a[1].id()).unwrap()],
            limits(),
            || false
        ),
        Err(Error::AssetMetadata)
    ));
    let pointer = a[1].bytes().as_ptr();
    let metadata = metadata::Authoring::new(&model, a, limits(), || false).unwrap();
    assert_eq!(
        metadata.drawings().next().unwrap().1.bytes().as_ptr(),
        pointer
    );
    let (p, a) = input(row(&c, "svg-missing"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    let metadata = metadata::Authoring::new(&model, a, limits(), || false).unwrap();
    assert_eq!(
        metadata.warnings(),
        [metadata::Warning::MissingDrawing {
            plate: 0,
            object: 0,
            volume: 0
        }]
    );
    assert_eq!(metadata.drawings().len(), 0);
}
#[test]
fn a_missing_drawing_cannot_borrow_another_parts_path() {
    let c = corpus();
    let (p, a) = input(row(&c, "svg-shared-path-missing-source-omits-reference"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    let metadata = metadata::Authoring::new(&model, a, limits(), || false).unwrap();
    let mut output = Vec::new();
    metadata
        .write(Member::ModelSettings, &mut output, || false)
        .unwrap();
    assert_eq!(
        String::from_utf8(output)
            .unwrap()
            .matches("filepath3mf=")
            .count(),
        1
    );
    assert_eq!(
        metadata.warnings(),
        [metadata::Warning::MissingDrawing {
            plate: 0,
            object: 0,
            volume: 1
        }]
    );
}
#[test]
fn absent_members_do_not_write_and_io_failure_is_private() {
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
                    "private host detail",
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
    let (p, a) = input(row(&c, "basic"));
    let model = model::Authoring::new(&p, a.clone(), model_limits(), || false).unwrap();
    let metadata = metadata::Authoring::new(&model, a, limits(), || false).unwrap();
    let mut sink = Sink {
        bytes: vec![],
        calls: 0,
        fail: false,
    };
    assert_eq!(
        metadata
            .write(Member::LayerEvents, &mut sink, || false)
            .unwrap(),
        None
    );
    assert_eq!(sink.calls, 0);
    assert!(matches!(
        metadata.write(Member::LayerEvents, &mut sink, || true),
        Err(Error::Cancelled)
    ));
    metadata
        .write(Member::ModelSettings, &mut sink, || false)
        .unwrap();
    assert_eq!(
        sink.bytes,
        row(&c, "basic")["files"][Member::ModelSettings.path()]
            .as_str()
            .unwrap()
            .as_bytes()
    );
    sink.fail = true;
    let e = metadata
        .write(Member::ModelSettings, &mut sink, || false)
        .unwrap_err();
    assert_eq!(
        e,
        Error::Xml(xml::Error::Io(io::ErrorKind::PermissionDenied))
    );
    assert!(!e.to_string().contains("private"));
    let mut polls = 0;
    assert!(matches!(
        metadata.write(Member::ModelSettings, &mut vec![], || {
            polls += 1;
            polls > 10
        }),
        Err(Error::Xml(xml::Error::Cancelled))
    ));
}
#[test]
fn reference_sources_are_current() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for (path, digest) in corpus()["sources"].as_object().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).unwrap())
            ),
            digest.as_str().unwrap(),
            "{path}"
        );
    }
}
