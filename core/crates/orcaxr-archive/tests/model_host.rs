//! The host model-import task: generated limit decoding, production UUIDv4 IDs
//! from a seed, and bounded failure codes.
#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod complete;
use orcaxr_archive::models::{
    Limits,
    host::{self, Base, Failure, Ids, Request},
    layout::{OPTION_COUNT, VERSION, decode_options},
    stage::Placement,
};
use orcaxr_contracts::canonical::{self, Value};
use orcaxr_project::{
    assets::AssetRepository,
    model::{Decode, ProjectData, ProjectState},
    selection::SelectionStore,
    session::ProjectSession,
    validation::ValidatedProject,
};
use std::collections::HashSet;

fn defaults() -> Vec<f64> {
    let d = Limits::default();
    [
        d.max_bytes,
        d.max_triangles,
        d.max_vertices,
        d.max_objects,
        d.max_volumes_per_object,
        d.max_instances_per_object,
        d.max_archive_members,
        d.max_name_length,
        d.max_xml_depth,
    ]
    .map(|v| v as f64)
    .to_vec()
}

#[test]
fn generated_limits_decode_exactly() {
    assert_eq!(
        decode_options(VERSION as f64, &defaults()),
        Some(Limits::default())
    );
    assert_eq!(decode_options(VERSION as f64 + 1.0, &defaults()), None);
    assert_eq!(decode_options(VERSION as f64, &defaults()[1..]), None);
    for bad in [0.0, -1.0, 0.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
        for index in 0..OPTION_COUNT {
            let mut input = defaults();
            input[index] = bad;
            assert_eq!(
                decode_options(VERSION as f64, &input),
                None,
                "{index} {bad}"
            );
        }
    }
}

fn cube() -> Vec<u8> {
    let corners = [
        [0., 0., 0.],
        [10., 0., 0.],
        [10., 10., 0.],
        [0., 10., 0.],
        [0., 0., 10.],
        [10., 0., 10.],
        [10., 10., 10.],
        [0., 10., 10.],
    ];
    let faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut bytes = vec![0u8; 84];
    bytes[80..84].copy_from_slice(&(faces.len() as u32).to_le_bytes());
    for face in faces {
        bytes.extend_from_slice(&[0; 12]);
        for corner in face {
            for value in corners[corner] {
                bytes.extend_from_slice(&(value as f32).to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0; 2]);
    }
    bytes
}
fn session() -> ProjectSession<impl orcaxr_project::validation::TimestampPolicy<Error = ()>> {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-stage-vectors.json"
    ))
    .unwrap();
    let state = ProjectState::from_value(
        canonical::parse(corpus["bases"]["empty"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let mut timestamps = complete::utc();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut timestamps).unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        AssetRepository::new(),
        timestamps,
        Default::default(),
        [0, 1, 2, 3],
    )
    .unwrap()
}
fn request(ids: Ids) -> Request {
    Request {
        filename: "cube.stl".encode_utf16().collect(),
        imported_at: "2026-10-07T12:00:00.000Z".encode_utf16().collect(),
        placement: Placement::default(),
        ids,
    }
}
fn staged_ids(prepared: &orcaxr_project::import::Prepared) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(value: &Value, key: Option<&str>, out: &mut Vec<String>) {
        match value {
            Value::Object(fields) => fields
                .iter()
                .for_each(|(k, v)| walk(v, Some(&String::from_utf16(k).unwrap()), out)),
            Value::Array(items) => items.iter().for_each(|v| walk(v, key, out)),
            Value::String(units) if key == Some("id") => {
                out.push(String::from_utf16(units).unwrap())
            }
            _ => {}
        }
    }
    walk(&prepared.state, None, &mut out);
    out
}

#[test]
fn production_ids_are_unique_uuid_v4() {
    let owner = session();
    let base = Base::capture(&owner).unwrap();
    let prepare = |seed| {
        host::prepare(
            &cube(),
            &request(Ids::Uuid(seed)),
            &Limits::default(),
            &base,
            &mut complete::utc(),
            || false,
        )
        .unwrap()
    };
    let first = staged_ids(&prepare([1, 2, 3, 4]));
    let again = staged_ids(&prepare([1, 2, 3, 4]));
    let other = staged_ids(&prepare([5, 6, 7, 8]));
    let uuid = |id: &str| {
        let b = id.as_bytes();
        id.len() == 36
            && b[8] == b'-'
            && b[13] == b'-'
            && b[14] == b'4'
            && b[18] == b'-'
            && matches!(b[19], b'8' | b'9' | b'a' | b'b')
            && b[23] == b'-'
            && id
                .chars()
                .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    };
    let staged: Vec<&String> = first
        .iter()
        .filter(|id| !id.starts_with("import:model-test:"))
        .collect();
    assert_eq!(staged.len(), 4, "{first:?}"); // asset, volume, object, instance
    assert!(staged.iter().all(|id| uuid(id)), "{staged:?}");
    assert_eq!(staged.iter().collect::<HashSet<_>>().len(), staged.len());
    assert_eq!(first, again, "a seed is deterministic");
    assert_ne!(first, other);
}

#[test]
fn failures_are_bounded_codes() {
    let owner = session();
    let base = Base::capture(&owner).unwrap();
    let run = |bytes: &[u8], limits: Limits| {
        host::prepare(
            bytes,
            &request(Ids::Counter("t".into())),
            &limits,
            &base,
            &mut complete::utc(),
            || false,
        )
        .map(|_| ())
        .unwrap_err()
    };
    // STEP bytes named cube.stl: the signature contradicts the extension.
    assert_eq!(
        run(b"ISO-10303-21;\n", Limits::default()).code(),
        "unsupported-format:extension-signature-mismatch"
    );
    assert_eq!(
        run(
            &cube(),
            Limits {
                max_triangles: 2,
                ..Limits::default()
            }
        )
        .code(),
        "malformed-model:limit-exceeded"
    );
    assert_eq!(
        run(&[], Limits::default()),
        Failure::Unsupported(orcaxr_archive::models::Unsupported::EmptyInput)
    );
    let cancelled = host::prepare(
        &cube(),
        &request(Ids::Counter("t".into())),
        &Limits::default(),
        &base,
        &mut complete::utc(),
        || true,
    );
    assert_eq!(cancelled.map(|_| ()).unwrap_err(), Failure::Cancelled);
}

#[test]
fn geometry_merge_3mf_imports_objects() {
    let mut owner = session();
    let base = Base::capture(&owner).unwrap();
    let three_mf = include_bytes!("../../../../web/public/models/multicolor_hexagon.3mf");
    let req = Request {
        filename: "hexagon.3mf".encode_utf16().collect(),
        imported_at: "2026-10-14T10:00:00.000Z".encode_utf16().collect(),
        placement: Placement::default(),
        ids: Ids::Uuid([10, 20, 30, 40]),
    };
    let prepared = host::prepare_geometry(
        three_mf,
        &req,
        &Limits::default(),
        &base,
        &mut complete::utc(),
        || false,
    )
    .unwrap();

    assert!(!prepared.is_blocked());
    let acks = prepared.required_acknowledgements().to_vec();
    let _ = owner.commit_import(&base.guard, prepared, &acks).unwrap();
    let objects: Vec<String> = owner
        .snapshot()
        .state()
        .plates
        .iter()
        .flat_map(|p| p.objects.iter().map(|o| String::from_utf16_lossy(o.name.units())))
        .collect();
    assert!(!objects.is_empty());
}

