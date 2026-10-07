//! Native model decoding against the production browser's `decodeModelImport`
//! (`tools/cross-platform/model-import-vectors.mjs`): every accepted case must
//! match format, units, names, roles, colours, materials, instance transform
//! bits, mesh digests and the exact notice list; every refusal must match the
//! browser's error class, reason and format.
use orcaxr_archive::models::{self, Decoded, Error, Limits, Role};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/model-import-vectors.json"
    ))
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn text(value: &Value) -> Vec<u16> {
    match value {
        Value::String(s) => s.encode_utf16().collect(),
        Value::Array(units) => units.iter().map(|u| u.as_u64().unwrap() as u16).collect(),
        other => panic!("text {other}"),
    }
}
fn encoded(units: &[u16]) -> Value {
    match String::from_utf16(units) {
        Ok(s) => json!(s),
        Err(_) => json!(units),
    }
}
fn bits(value: f64) -> Value {
    json!(format!("{:016x}", value.to_bits()))
}
fn digest(bytes: impl Iterator<Item = [u8; 4]>) -> String {
    let mut hash = Sha256::new();
    bytes.for_each(|b| hash.update(b));
    format!("{:x}", hash.finalize())
}
fn limits(value: Option<&Value>) -> Limits {
    let mut limits = Limits::default();
    if let Some(Value::Object(fields)) = value {
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
                other => panic!("limit {other}"),
            }
        }
    }
    limits
}
/// The browser's expectation shape, rendered from the native result.
fn render(result: Result<Decoded, Error>) -> Value {
    match result {
        Err(Error::Unsupported(reason, format)) => {
            json!({ "error": ["unsupported", reason.code(), format.map(|f| f.code())] })
        }
        Err(Error::Malformed(reason, format)) => {
            json!({ "error": ["malformed", reason.code(), format.map(|f| f.code())] })
        }
        Err(Error::Cancelled) => json!("cancelled"),
        Ok(d) => json!({ "ok": {
            "format": d.format.code(),
            "filename": encoded(&d.filename),
            "unitScaleToMm": bits(d.unit_scale_to_mm),
            "sourceUnit": d.source_unit,
            "objects": d.objects.iter().map(|o| {
                let mut object = serde_json::Map::new();
                object.insert("name".into(), encoded(&o.name));
                object.insert("instances".into(), json!(o.instances.iter().map(|t| {
                    t.translation_mm.iter().chain(&t.rotation).chain(&t.scale).map(|v| bits(*v)).collect::<Vec<_>>()
                }).collect::<Vec<_>>()));
                object.insert("volumes".into(), json!(o.volumes.iter().map(|v| {
                    let mut volume = serde_json::Map::new();
                    volume.insert("name".into(), encoded(&v.name));
                    volume.insert("role".into(), json!(match v.role { Role::Model => "model", Role::ParameterModifier => "parameter-modifier" }));
                    if let Some(color) = &v.color_hex { volume.insert("colorHex".into(), json!(color)); }
                    if let Some(material) = &v.material_name { volume.insert("materialName".into(), encoded(material)); }
                    volume.insert("vertices".into(), json!(v.mesh.positions.len() / 3));
                    volume.insert("triangles".into(), json!(v.mesh.indices.len() / 3));
                    volume.insert("positionsSha256".into(), json!(digest(v.mesh.positions.iter().map(|p| p.to_le_bytes()))));
                    volume.insert("indicesSha256".into(), json!(digest(v.mesh.indices.iter().map(|i| i.to_le_bytes()))));
                    Value::Object(volume)
                }).collect::<Vec<_>>()));
                Value::Object(object)
            }).collect::<Vec<_>>(),
            "notices": d.notices.iter().map(|n| json!([n.kind.code(), n.code, encoded(&n.path), encoded(&n.message)])).collect::<Vec<_>>(),
        }}),
    }
}

#[test]
fn native_decoding_matches_every_browser_case() {
    let corpus = corpus();
    let mut failures = Vec::new();
    let mut accepted = 0;
    for case in corpus["cases"].as_array().unwrap() {
        let bytes = match &case["bytesBase64"] {
            Value::String(b64) => base64(b64),
            _ => std::fs::read(root().join(case["path"].as_str().unwrap())).unwrap(),
        };
        let actual = render(models::decode(
            &bytes,
            &text(&case["filename"]),
            &limits(case.get("limits")),
            || false,
        ));
        let expected = &case["expected"];
        if actual != *expected {
            failures.push(format!(
                "{}\n  expected {}\n  actual   {}",
                case["name"], expected, actual
            ));
        } else if expected.get("ok").is_some() {
            accepted += 1;
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(accepted >= 100, "{accepted}");
}

#[test]
fn cancellation_publishes_nothing() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "real/web/public/models/3dbenchy.stl")
        .unwrap();
    let bytes = std::fs::read(root().join(case["path"].as_str().unwrap())).unwrap();
    let mut calls = 0;
    let result = models::decode(&bytes, &text(&case["filename"]), &Limits::default(), || {
        calls += 1;
        calls > 3
    });
    assert_eq!(result.unwrap_err(), Error::Cancelled);
}

#[test]
fn reference_sources_match_current_production_decoders() {
    for row in corpus()["sources"].as_array().unwrap() {
        let bytes = std::fs::read(root().join(row["path"].as_str().unwrap())).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
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
