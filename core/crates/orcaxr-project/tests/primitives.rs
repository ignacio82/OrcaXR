//! Primitives and helper volumes against the browser (`primitive-vectors.json`):
//! every mesh payload byte for byte (or by its digest at sizes the corpus does
//! not spell out), each malformed request refused, and every plan — a
//! primitive's object and shared asset, a helper volume's part — answered in
//! its recorded state exactly as the production controller built it.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::assets::AssetRepository;
use orcaxr_project::model::{Decode, ProjectState};
use orcaxr_project::primitives::{
    INVALID_REQUEST, helper_volume_json, payload_json, primitive_object_json,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/primitive-vectors.json"
    ))
    .unwrap()
}

fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("base64 {c}"),
    } as u32;
    let mut out = Vec::new();
    for chunk in text.trim_end_matches('=').as_bytes().chunks(4) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |word, (i, &c)| word | value(c) << (18 - 6 * i));
        out.extend(&word.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn fnv(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash = (hash ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[test]
fn reference_sources_are_current() {
    for source in corpus()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn meshes_match_the_browser() {
    let corpus = corpus();
    let meshes = corpus["meshes"].as_array().unwrap();
    assert_eq!(meshes.len(), 48);
    let mut exact = 0;
    for case in meshes {
        let request = case["request"].as_str().unwrap();
        let bytes = payload_json(request).unwrap();
        assert_eq!(
            bytes.len() as u64,
            case["byteLength"].as_u64().unwrap(),
            "{request}"
        );
        assert_eq!(fnv(&bytes), case["digest"].as_str().unwrap(), "{request}");
        if let Some(payload) = case["payload"].as_str() {
            assert_eq!(bytes, base64(payload), "{request}");
            exact += 1;
        }
    }
    assert_eq!(exact, 7);
    let refusals = corpus["meshRefusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 11);
    for case in refusals {
        assert_eq!(
            payload_json(case["request"].as_str().unwrap()),
            Err(INVALID_REQUEST),
            "{}",
            case["name"]
        );
    }
}

fn open(entry: &Value) -> (ProjectState, AssetRepository) {
    let state =
        ProjectState::from_value(parse(entry["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in entry["assets"].as_array().unwrap() {
        let descriptor = parse(asset["descriptorJson"].as_str().unwrap()).unwrap();
        assets
            .put(&descriptor, &base64(asset["bytes"].as_str().unwrap()))
            .unwrap();
    }
    (state, assets)
}

#[test]
fn plans_match_the_browser() {
    let corpus = corpus();
    let states = corpus["states"].as_array().unwrap();
    assert_eq!(states.len(), 5);
    let (mut primitives, mut helpers, mut refused) = (0, 0, 0);
    for entry in states {
        let (state, assets) = open(entry);
        for plan in entry["plans"].as_array().unwrap() {
            let request = plan["request"].as_str().unwrap();
            let reply = match plan["kind"].as_str().unwrap() {
                "primitive" => {
                    primitives += 1;
                    primitive_object_json(&state, &assets, request)
                }
                _ => {
                    helpers += 1;
                    helper_volume_json(&state, request)
                }
            }
            .unwrap();
            assert_eq!(
                reply,
                plan["reply"].as_str().unwrap(),
                "{} {request}",
                entry["name"]
            );
            refused += usize::from(reply.starts_with(r#"{"refusal""#));
        }
    }
    assert_eq!((primitives, helpers, refused), (26, 11, 6));
    let refusals = corpus["planRefusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 16);
    for case in refusals {
        let name = case["state"].as_str().unwrap_or("empty");
        let entry = states.iter().find(|s| s["name"] == name).unwrap();
        let (state, assets) = open(entry);
        let request = case["request"].as_str().unwrap();
        let reply = match case["kind"].as_str().unwrap() {
            "primitive" => primitive_object_json(&state, &assets, request),
            _ => helper_volume_json(&state, request),
        };
        assert_eq!(reply, Err(INVALID_REQUEST), "{}", case["name"]);
    }
}

/// Every primitive and the helper volumes' cube is one closed surface the
/// engine can slice: each edge of one triangle is the reverse edge of exactly
/// one other, no triangle names a vertex twice, and the surface has the genus
/// its shape has (V − E + F = 2, a torus 0). Stored as a triangle soup, a
/// cylinder, cone, sphere or disc sliced to "The print is empty" and a torus
/// lost its layers.
#[test]
fn every_primitive_is_one_closed_surface() {
    use orcaxr_project::primitives::{Shape, mesh};
    use std::collections::HashMap;
    for shape in Shape::ALL.iter().copied() {
        for size in [0.5, 20.0, 250.0] {
            let mesh = mesh(shape, size);
            let mut edges: HashMap<(u32, u32), usize> = HashMap::new();
            for triangle in mesh.indices.chunks(3) {
                let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
                assert!(
                    a != b && b != c && a != c,
                    "{shape:?} {size}: a degenerate triangle"
                );
                for edge in [(a, b), (b, c), (c, a)] {
                    *edges.entry(edge).or_default() += 1;
                }
            }
            for (&(a, b), &count) in &edges {
                assert_eq!(
                    count, 1,
                    "{shape:?} {size}: edge {a}-{b} used {count} times"
                );
                assert_eq!(
                    edges.get(&(b, a)),
                    Some(&1),
                    "{shape:?} {size}: open edge {a}-{b}"
                );
            }
            let vertices = mesh.positions.len() / 3;
            assert!(mesh.indices.iter().all(|&i| (i as usize) < vertices));
            let euler =
                vertices as i64 - (edges.len() / 2) as i64 + (mesh.indices.len() / 3) as i64;
            assert_eq!(
                euler,
                if shape == Shape::Torus { 0 } else { 2 },
                "{shape:?} {size}"
            );
        }
    }
}
