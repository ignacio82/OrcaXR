use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetLease, AssetPayload, AssetRepository},
    ids::{AssetId, InstanceId},
    mesh::{self, BoundsLimits, Coordinates, EncodeOptions, Error, Limits, Mesh},
    model::{AssetProvenance, Decode, ProjectState, Text, Transform, VolumeRole},
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/mesh-vectors.json"
    ))
    .unwrap()
}
fn limits() -> Limits {
    Limits {
        asset_bytes: 64 << 20,
        vertices: 1_000_000,
        indices: 3_000_000,
    }
}
fn json(v: &Value) -> String {
    let mut out = vec![];
    v.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn payload(v: &Json) -> AssetPayload {
    AssetPayload {
        descriptor: parse(v["descriptorJson"].as_str().unwrap()).unwrap(),
        bytes: v["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect(),
    }
}
fn admit(payload: AssetPayload) -> Option<AssetLease> {
    let mut repo = AssetRepository::new();
    let Value::Object(fields) = &payload.descriptor else {
        panic!()
    };
    let id = AssetId::from_value(fields[&"id".encode_utf16().collect::<Vec<_>>()].clone()).unwrap();
    repo.put_owned(payload).ok()?;
    repo.peek(&id)
}
fn options(v: &str) -> EncodeOptions {
    let Value::Object(mut fields) = parse(v).unwrap() else {
        panic!()
    };
    let mut get = |n: &str| fields.remove(&n.encode_utf16().collect::<Vec<_>>());
    EncodeOptions {
        metadata_bytes: 1 << 20,
        id: AssetId::from_value(get("id").unwrap()).unwrap(),
        source_filename: get("sourceFilename").map(|v| Text::from_value(v).unwrap()),
        provenance: get("provenance").map(|v| Arc::new(AssetProvenance::from_value(v).unwrap())),
    }
}
fn numbers(v: &Json) -> Vec<u32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect()
}
fn f64_bits(v: &Json) -> u64 {
    u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()
}
#[test]
fn exact_encoding_matches_typescript_including_float_rounding_signed_zero_and_metadata() {
    for (i, row) in corpus()["encoding"].as_array().unwrap().iter().enumerate() {
        let positions: Vec<_> = row["positionsBits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| f64::from_bits(f64_bits(v)))
            .collect();
        let indices = (!row["indices"].is_null()).then(|| numbers(&row["indices"]));
        let result = mesh::encode(
            options(row["optionsJson"].as_str().unwrap()),
            Coordinates::Float64(&positions),
            indices.as_deref(),
            limits(),
            || false,
        );
        if row["error"] == true {
            assert!(result.is_err(), "case {i}");
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("case {i}: {e}"));
        let expected = payload(&row["expected"]);
        assert_eq!(result.bytes, expected.bytes, "case {i}");
        assert_eq!(
            json(&result.descriptor),
            json(&expected.descriptor),
            "case {i}"
        );
        // The f32 entry point encodes the already-rounded representation identically.
        let rounded: Vec<_> = positions.iter().map(|v| *v as f32).collect();
        let again = mesh::encode(
            options(row["optionsJson"].as_str().unwrap()),
            Coordinates::Float32(&rounded),
            indices.as_deref(),
            limits(),
            || false,
        )
        .unwrap();
        assert_eq!(again.bytes, result.bytes);
        assert_eq!(again.descriptor, result.descriptor);
    }
}
#[test]
fn borrowed_decode_matches_strides_unaligned_bytes_indices_and_expansion() {
    for row in corpus()["decoding"].as_array().unwrap() {
        let result = admit(payload(row)).map(|lease| Mesh::open(lease, limits(), || false));
        if row["error"] == true {
            assert!(!matches!(result, Some(Ok(_))), "{}", row["name"]);
            continue;
        }
        let mesh = result
            .unwrap()
            .unwrap_or_else(|e| panic!("{}: {e}", row["name"]));
        let expected = &row["expected"];
        assert_eq!(
            mesh.positions()
                .flatten()
                .map(f32::to_bits)
                .collect::<Vec<_>>(),
            numbers(&expected["positionsBits"]),
            "{}",
            row["name"]
        );
        assert_eq!(
            mesh.triangles().flatten().collect::<Vec<_>>(),
            numbers(&expected["indices"]),
            "{}",
            row["name"]
        );
        assert_eq!(
            mesh.expand(64 << 20, || false)
                .unwrap()
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            numbers(&expected["expandedBits"]),
            "{}",
            row["name"]
        );
        assert_eq!(mesh.position(mesh.vertex_count()), None);
        assert_eq!(mesh.triangle(mesh.triangle_count()), None);
        assert_eq!(mesh.index(mesh.index_count()), None);
    }
}
fn selected(row: &Json) -> Vec<InstanceId> {
    row["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            InstanceId::try_from_utf16(
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        })
        .collect()
}
fn bounds_limits() -> BoundsLimits {
    BoundsLimits {
        mesh: limits(),
        selected: 100,
        assets: 100,
        vertex_visits: 1_000_000,
    }
}
#[test]
fn complete_canonical_bounds_match_exact_typescript_bits_and_refusals() {
    for row in corpus()["bounds"].as_array().unwrap() {
        let state =
            ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
        let mut repo = AssetRepository::new();
        for p in row["assets"].as_array().unwrap() {
            repo.put_owned(payload(p)).unwrap();
        }
        let ids = selected(row);
        let roles = row.get("roles").map(|v| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|v| VolumeRole::from_value(parse(&v.to_string()).unwrap()).unwrap())
                .collect::<Vec<_>>()
        });
        let result = mesh::instance_bounds(
            &state,
            &repo.capture_internal(),
            &ids,
            roles.as_deref(),
            bounds_limits(),
            || false,
        );
        if row["error"] == true {
            assert!(result.is_err(), "{}", row["name"]);
            continue;
        }
        let b = result.unwrap_or_else(|e| panic!("{}: {e}", row["name"]));
        assert_eq!(
            b.min
                .into_iter()
                .chain(b.max)
                .map(f64::to_bits)
                .collect::<Vec<_>>(),
            row["expectedBits"]
                .as_array()
                .unwrap()
                .iter()
                .map(f64_bits)
                .collect::<Vec<_>>(),
            "{}",
            row["name"]
        );
    }
}
#[test]
fn caps_cancellation_and_immutable_proof_lifetimes() {
    let c = corpus();
    let row = &c["encoding"][1]["expected"];
    let p = payload(row);
    let mut repo = AssetRepository::new();
    repo.put_owned(p).unwrap();
    let id = AssetId::try_from_utf16("import:mesh:reference".encode_utf16().collect::<Vec<_>>())
        .unwrap();
    let lease = repo.peek(&id).unwrap();
    let pointer = lease.bytes().as_ptr();
    assert!(matches!(
        Mesh::open(lease.clone(), Limits::default(), || false),
        Err(Error::Limits)
    ));
    assert!(matches!(
        Mesh::open(lease.clone(), limits(), || true),
        Err(Error::Cancelled)
    ));
    for l in [
        Limits {
            asset_bytes: lease.bytes().len() - 1,
            ..limits()
        },
        Limits {
            vertices: 2,
            ..limits()
        },
        Limits {
            indices: 2,
            ..limits()
        },
    ] {
        assert!(matches!(
            Mesh::open(lease.clone(), l, || false),
            Err(Error::Limits)
        ));
    }
    let mesh = Mesh::open(lease.clone(), limits(), || false).unwrap();
    let retained = mesh.clone();
    drop(mesh);
    drop(repo);
    assert!(retained.asset().same_record(&lease));
    assert_eq!(retained.asset().bytes().as_ptr(), pointer);
    assert_eq!(retained.expand(35, || false), Err(Error::Limits));
    assert_eq!(retained.expand(36, || true), Err(Error::Cancelled));
    let mut expanded = retained.expand(36, || false).unwrap();
    expanded.fill(33.0);
    assert_eq!(retained.position(0).unwrap(), [0.0, 0.0, 0.0]);
    let opts = r#"{"id":"import:mesh:large"}"#;
    let mut too_small = options(opts);
    too_small.metadata_bytes = 1;
    assert!(matches!(
        mesh::encode(too_small, Coordinates::Float32(&[]), None, limits(), || {
            false
        }),
        Err(Error::Limits)
    ));
    let positions = vec![0.0; 9 * 4096];
    let big = mesh::encode(
        options(opts),
        Coordinates::Float64(&positions),
        None,
        limits(),
        || false,
    )
    .unwrap();
    let lease = admit(big).unwrap();
    let mut checks = 0;
    assert!(matches!(
        Mesh::open(lease.clone(), limits(), || {
            checks += 1;
            checks == 3
        }),
        Err(Error::Cancelled)
    ));
    let big = Mesh::open(lease, limits(), || false).unwrap();
    let mut checks = 0;
    assert_eq!(
        big.expand(1 << 20, || {
            checks += 1;
            checks == 3
        }),
        Err(Error::Cancelled)
    );
    let mut metadata_checks = 0;
    mesh::encode(
        options(opts),
        Coordinates::Float32(&[]),
        None,
        limits(),
        || {
            metadata_checks += 1;
            false
        },
    )
    .unwrap();
    let mut checks = 0;
    assert!(matches!(
        mesh::encode(
            options(opts),
            Coordinates::Float64(&positions),
            None,
            limits(),
            || {
                checks += 1;
                checks == metadata_checks + 2
            }
        ),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        mesh::encode(
            options(opts),
            Coordinates::Float64(&positions),
            None,
            Limits::default(),
            || false
        ),
        Err(Error::Limits)
    ));
    let t = Transform::from_value(
        parse(r#"{"translationMm":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1]}"#).unwrap(),
    )
    .unwrap();
    let mut checks = 0;
    assert_eq!(
        big.bounds(&t, &t, || {
            checks += 1;
            checks == 3
        }),
        Err(Error::Cancelled)
    );
}
#[test]
fn bounds_host_budgets_and_cancellation_are_not_live_mutations() {
    let c = corpus();
    let row = &c["bounds"][0];
    let state =
        ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut repo = AssetRepository::new();
    for p in row["assets"].as_array().unwrap() {
        repo.put_owned(payload(p)).unwrap();
    }
    let snapshot = repo.capture_internal();
    let ids = selected(row);
    for l in [
        BoundsLimits {
            selected: 0,
            ..bounds_limits()
        },
        BoundsLimits {
            assets: 0,
            ..bounds_limits()
        },
        BoundsLimits {
            vertex_visits: 3,
            ..bounds_limits()
        },
    ] {
        assert_eq!(
            mesh::instance_bounds(&state, &snapshot, &ids, None, l, || false),
            Err(Error::Limits)
        );
    }
    assert_eq!(
        mesh::instance_bounds(&state, &snapshot, &ids, None, bounds_limits(), || true),
        Err(Error::Cancelled)
    );
    assert!(snapshot.same_version(&repo.capture_internal()));
}
#[test]
fn source_reference_hashes_are_current() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for (path, hash) in corpus()["sources"].as_object().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).unwrap())
            ),
            hash.as_str().unwrap()
        );
    }
}
