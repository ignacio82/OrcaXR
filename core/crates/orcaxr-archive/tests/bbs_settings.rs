use orcaxr_archive::bbs::{
    model::{
        self,
        settings::{self, Error, Warning},
    },
    numbers,
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetLease, AssetPayload, AssetRepository},
    ids::AssetId,
    model::{Decode, ProjectData, ProjectState},
    validation::ValidatedProject,
};
use serde_json::Value as Json;
use std::io::{self, Write};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-settings-vectors.json"
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
fn limits() -> settings::Limits {
    settings::Limits {
        records: 1_000_000,
        config_nodes: 1_000_000,
        config_depth: 128,
        text_units: 64 << 20,
        derived_values: 1_000_000,
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

#[test]
fn complete_member_matches_independent_browser_bytes_and_refusals() {
    let mut failures = vec![];
    for row in corpus()["cases"].as_array().unwrap() {
        let (project, assets) = input(row);
        let model = model::Authoring::new(&project, assets, model_limits(), || false).unwrap();
        let result = settings::Authoring::new(&model, limits(), || false).and_then(|settings| {
            let mut bytes = vec![];
            let n = settings.write(&mut bytes, || false)?;
            assert_eq!(n, bytes.len());
            let warnings: Vec<_> = settings
                .warnings()
                .iter()
                .map(|w| match w {
                    Warning::ApproximateGradient { mixed } => {
                        format!("ApproximateGradient:{mixed}")
                    }
                    Warning::ApproximateCycle { mixed } => format!("ApproximateCycle:{mixed}"),
                    Warning::ApproximateMatch { mixed } => format!("ApproximateMatch:{mixed}"),
                    w => format!("{w:?}"),
                })
                .collect();
            Ok((String::from_utf8(bytes).unwrap(), warnings))
        });
        if row.get("error").is_some() {
            if result.is_ok() {
                failures.push(format!("{}: accepted browser refusal", row["name"]));
            }
        } else {
            match result {
                Ok((text, warnings)) => {
                    if text != row["settings"].as_str().unwrap() {
                        failures.push(format!(
                            "{}: bytes differ\nNATIVE {text}\nBROWSER {}",
                            row["name"],
                            row["settings"].as_str().unwrap()
                        ));
                    }
                    if serde_json::to_value(&warnings).unwrap() != row["warningCodes"] {
                        failures.push(format!(
                            "{}: warnings {warnings:?} != {}",
                            row["name"], row["warningCodes"]
                        ));
                    }
                }
                Err(e) => failures.push(format!("{}: {e:?}", row["name"])),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn fixed_four_matches_javascript_for_independent_double_bits() {
    for row in corpus()["numbers"].as_array().unwrap() {
        let v = f64::from_bits(u64::from_str_radix(row["bits"].as_str().unwrap(), 16).unwrap());
        assert_eq!(
            numbers::fixed4(v).unwrap().as_str(),
            row["fixed4"].as_str().unwrap(),
            "{v:?}"
        );
    }
    for v in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        assert!(numbers::fixed4(v).is_err());
    }
}
#[test]
fn resource_depth_and_output_limits_refuse_provisional_work() {
    let c = corpus();
    let (p, a) = input(row(&c, "all-json-values"));
    let model = model::Authoring::new(&p, a, model_limits(), || false).unwrap();
    for field in 0..5 {
        let mut l = limits();
        match field {
            0 => l.records = 0,
            1 => l.config_nodes = 0,
            2 => l.text_units = 0,
            3 => l.derived_values = 0,
            _ => l.config_depth = 1,
        }
        assert!(
            matches!(
                settings::Authoring::new(&model, l, || false),
                Err(Error::ResourceLimit)
            ),
            "{field}"
        );
    }
    assert!(matches!(
        settings::Authoring::new(&model, settings::Limits::default(), || false),
        Err(Error::ResourceLimit)
    ));
    assert!(matches!(
        settings::Authoring::new(&model, limits(), || true),
        Err(Error::Cancelled)
    ));
    let mut polls = 0;
    assert!(matches!(
        settings::Authoring::new(&model, limits(), || {
            polls += 1;
            polls > 15
        }),
        Err(Error::Cancelled)
    ));
    let size = row(&c, "all-json-values")["settings"]
        .as_str()
        .unwrap()
        .len();
    for cap in [0, size - 1, size] {
        let mut l = limits();
        l.output_bytes = cap;
        let s = settings::Authoring::new(&model, l, || false).unwrap();
        let mut out = vec![];
        let result = s.write(&mut out, || false);
        assert!(out.len() <= cap);
        if cap == size {
            assert_eq!(result, Ok(size));
        } else {
            assert_eq!(result, Err(Error::OutputLimit));
        }
    }
}
#[test]
fn short_interrupted_io_cancellation_and_private_failures() {
    struct Sink {
        bytes: Vec<u8>,
        writes: usize,
        fail: bool,
        forever: bool,
    }
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            assert!(b.len() <= 4096);
            self.writes += 1;
            if self.fail {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private host path and credentials",
                ));
            }
            if self.forever || self.writes % 2 == 1 {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = b.len().min(3);
            self.bytes.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host owns flush/publication")
        }
    }
    let c = corpus();
    let (p, a) = input(row(&c, "all-json-values"));
    let model = model::Authoring::new(&p, a, model_limits(), || false).unwrap();
    let s = settings::Authoring::new(&model, limits(), || false).unwrap();
    let mut sink = Sink {
        bytes: vec![],
        writes: 0,
        fail: false,
        forever: false,
    };
    s.write(&mut sink, || false).unwrap();
    assert_eq!(
        sink.bytes,
        row(&c, "all-json-values")["settings"]
            .as_str()
            .unwrap()
            .as_bytes()
    );
    sink.fail = true;
    let error = s.write(&mut sink, || false).unwrap_err();
    assert_eq!(error, Error::Io(io::ErrorKind::PermissionDenied));
    assert!(!error.to_string().contains("private"));
    sink.fail = false;
    sink.forever = true;
    let mut polls = 0;
    assert_eq!(
        s.write(&mut sink, || {
            polls += 1;
            polls > 10_000
        }),
        Err(Error::Cancelled)
    );
    assert_eq!(s.write(&mut vec![], || true), Err(Error::Cancelled));
    // A full fixed slice reports zero, unlike std::io::empty's discard writer.
    let mut zero: &mut [u8] = &mut [];
    assert_eq!(
        s.write(&mut zero, || false),
        Err(Error::Io(io::ErrorKind::WriteZero))
    );
    // A failed attempt owns no state: a fresh private stream is deterministic.
    let mut again = vec![];
    s.write(&mut again, || false).unwrap();
    assert_eq!(again, sink.bytes);
}
