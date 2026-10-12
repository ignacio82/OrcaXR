//! SVG parts against the browser: every reading of the reader corpus (curated
//! drawings and seeded random documents) yields the browser's contours bit
//! for bit, its size and every unsupported feature, or its refusal; every cut
//! of a drawing's file bytes (with its refusals) and each cut's mesh bytes
//! answer byte for byte, as does each drawing read on its own (its size and
//! notes, or its refusal); and the host's stages — new parts and re-cuts,
//! applied and refused — leave the browser's revision, hash and undo label
//! after every step.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*,
    history::*,
    model::*,
    selection::*,
    session::*,
    svg::{self, PreparedSvgPart, shapes},
    validation::*,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/svg-part-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn units(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}
fn run<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    sequence: &mut u64,
    operation: Value,
) -> Value {
    *sequence += 1;
    let request =
        json!({"protocolVersion":1,"generation":NONCE,"requestId":*sequence,"operation":operation});
    let response = match session.submit(&request.to_string()) {
        Submission::Ready(response) => response,
        Submission::Queued { .. } => session.run_next().unwrap(),
    };
    serde_json::from_str::<Value>(response.wire()).unwrap()["result"].clone()
}
fn bytes(asset: &Value) -> Vec<u8> {
    asset["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
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
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn from_bits(hex: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(hex, 16).unwrap())
}
fn bits(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

#[test]
fn the_reader_matches_the_browser_bit_for_bit() {
    let f = fixture();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, reading) in f["readings"].as_array().unwrap().iter().enumerate() {
        let source = reading["source"].as_str().unwrap();
        let width = reading["width"].as_str().map(from_bits);
        match shapes::read(source, width) {
            Ok(read) => {
                let mut flat: Vec<f64> = vec![read.contours.len() as f64];
                for contour in &read.contours {
                    flat.push(contour.len() as f64);
                    flat.extend(contour.iter().flatten());
                }
                let data: Vec<u8> = flat.iter().flat_map(|v| v.to_le_bytes()).collect();
                assert_eq!(
                    (
                        sha256(&data),
                        read.size_mm.map(bits).to_vec(),
                        read.unsupported
                            .iter()
                            .map(|f| json!([f.element, reason(f.reason), f.detail]))
                            .collect::<Vec<_>>(),
                    ),
                    (
                        reading["contours"].as_str().unwrap().to_owned(),
                        reading["sizeMm"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap().to_owned())
                            .collect::<Vec<_>>(),
                        reading["unsupported"].as_array().unwrap().clone(),
                    ),
                    "reading {i}: {source}"
                );
                *counts.entry("contours").or_default() += 1;
            }
            Err(error) => {
                let code = match error.code {
                    shapes::ErrorCode::InvalidSvg => "invalid-svg",
                    shapes::ErrorCode::NoGeometry => "no-geometry",
                };
                assert_eq!(
                    json!([code, error.message]),
                    reading["error"],
                    "reading {i}: {source}"
                );
                *counts.entry(code).or_default() += 1;
            }
        }
    }
    assert_eq!(
        counts,
        BTreeMap::from([("contours", 328), ("invalid-svg", 35), ("no-geometry", 171)])
    );
}

fn reason(reason: shapes::Reason) -> &'static str {
    use shapes::Reason::*;
    match reason {
        NeedsFont => "needs-font",
        RasterImage => "raster-image",
        ExternalReference => "external-reference",
        PaintEffect => "paint-effect",
        StrokeOnly => "stroke-only",
        UnsupportedUnit => "unsupported-unit",
        UnsupportedCommand => "unsupported-command",
        EmptyShape => "empty-shape",
        CssSelector => "css-selector",
    }
}

#[test]
fn svg_parts_match_the_browser_over_a_live_session() {
    let f = fixture();
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in f["assets"].as_array().unwrap() {
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes(asset),
            )
            .unwrap();
    }
    let mut session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        },
        NONCE,
    )
    .unwrap();
    session
        .configure_staging(StagingLimits {
            max_resources: 4,
            max_commands: 16,
            max_units: 64_000_000,
            max_asset_bytes: 16_000_000,
        })
        .unwrap();
    let mut sequence = 0;
    assert!(
        run(
            &mut session,
            &mut sequence,
            json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}})
        )
        .get("welcome")
        .is_some()
    );

    let mut cuts: BTreeMap<String, PreparedSvgPart> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let name = step["svg"].as_str().unwrap_or_default().to_owned();
        let kind = if let Some(request) = step["prepare"].as_str() {
            let drawing = base64(step["drawing"].as_str().unwrap());
            assert_eq!(
                wire::encode_svg_drawing_reply(&svg::read_drawing(&drawing)).unwrap(),
                step["read"].as_str().unwrap(),
                "step {i} read"
            );
            let cut = svg::prepare(&wire::decode_svg_part_request(request).unwrap(), &drawing);
            let reply = wire::encode_svg_part_reply(&cut.reply()).unwrap();
            assert_eq!(reply, step["reply"].as_str().unwrap(), "step {i}");
            let kind = match cut.reply() {
                wire::SvgPartReply::Prepared(preview) => {
                    let mesh = cut.mesh(0, preview.byte_length).unwrap();
                    assert_eq!(sha256(mesh), step["mesh"].as_str().unwrap(), "step {i}");
                    assert_eq!(
                        step.get("window")
                            .map(|_| sha256(cut.mesh(16, 64).unwrap())),
                        step.get("window").map(|w| w.as_str().unwrap().to_owned()),
                        "step {i}"
                    );
                    assert!(cut.mesh(preview.byte_length, 1).is_err());
                    "prepared"
                }
                wire::SvgPartReply::Refused(_) => "refused",
            };
            cuts.insert(name, cut);
            kind.to_owned()
        } else {
            let kind = if let Some(request) = step["stage"].as_str() {
                let request = wire::decode_svg_part_stage(request).unwrap();
                let outcome = match session.stage_svg_part(&cuts[&name], &request) {
                    Ok(id) => {
                        let result = run(
                            &mut session,
                            &mut sequence,
                            json!({"executeStaged":{"stagedId":id}}),
                        );
                        match (
                            result["acknowledged"]["changed"].as_bool(),
                            result["error"].as_str(),
                        ) {
                            (Some(true), _) => "applied",
                            (Some(false), _) => "unchanged",
                            (None, Some(error)) => error,
                            _ => panic!("step {i}: {result}"),
                        }
                        .to_owned()
                    }
                    Err(wire::SessionError::Stale) => "stale".to_owned(),
                    Err(wire::SessionError::InvalidRequest) => "invalidRequest".to_owned(),
                    Err(wire::SessionError::ResourceLimit) => "resourceLimit".to_owned(),
                    Err(error) => panic!("step {i}: {error:?}"),
                };
                assert_eq!(outcome, step["outcome"].as_str().unwrap(), "step {i}");
                outcome
            } else {
                let direction = step["history"].as_str().unwrap();
                let guard =
                    run(&mut session, &mut sequence, json!({"query":{}}))["acknowledged"]["guard"]
                        .clone();
                let result = run(&mut session, &mut sequence, json!({ direction: guard }));
                assert!(result.get("acknowledged").is_some(), "step {i}: {result}");
                direction.to_owned()
            };
            let snapshot = session.snapshot();
            assert_eq!(
                snapshot.revision(),
                step["revision"].as_u64().unwrap(),
                "step {i}"
            );
            assert_eq!(snapshot.hash(), step["hash"].as_str().unwrap(), "step {i}");
            assert_eq!(
                session
                    .history()
                    .undo_label
                    .map(|label| label.units().to_vec()),
                step["undoLabel"]
                    .as_array()
                    .map(|_| units(&step["undoLabel"])),
                "step {i}"
            );
            kind
        };
        *counts.entry(kind).or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from(
            [
                ("prepared", 11),
                ("refused", 11),
                ("applied", 7),
                ("commandFailed", 5),
                ("invalidRequest", 3),
                ("undo", 3),
                ("redo", 1),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );
}

#[test]
fn archive_paths_and_names_keep_the_browsers_utf16_rules() {
    let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    // A surrogate pair is two units, so two underscores; the name is cut to 64.
    assert_eq!(
        String::from_utf16_lossy(&svg::archive_path(&u("import:host:v 1"), &u("a😀b.svg"))),
        "Metadata/svg/import_host_v_1/a__b.svg"
    );
    assert_eq!(
        String::from_utf16_lossy(&svg::archive_path(&u("v"), &u(""))),
        "Metadata/svg/v/drawing.svg"
    );
    assert_eq!(
        svg::archive_path(&u("v"), &u(&"n".repeat(80))).len(),
        "Metadata/svg/v/".len() + 64
    );
    assert_eq!(svg::part_name(&u("Logo.SVG")), u("Logo"));
    assert_eq!(svg::part_name(&u(".svg")), u("SVG part"));
    assert_eq!(svg::part_name(&u("a.svg.svg")), u("a.svg"));
    assert_eq!(svg::part_name(&u("a.svgz")), u("a.svgz"));
}

#[test]
fn hostile_stylesheets_read_in_linear_time() {
    // The browser rescans for `{` from every at-rule, so `@a;` repeated with
    // no brace is quadratic, and it tests every rule against every element.
    // The same notes and paint must come back without either cost.
    let started = std::time::Instant::now();
    let at_rules = format!(
        r#"<svg width="10mm" height="10mm"><style>{}</style><rect width="5" height="5"/></svg>"#,
        "@a;".repeat(200_000)
    );
    let read = shapes::read(&at_rules, None).unwrap();
    assert_eq!(read.unsupported.len(), 200_000);
    let rules: String = (0..30_000)
        .map(|i| format!(".c{i}{{fill:none;stroke:#000}}"))
        .collect();
    let elements: String = (0..30_000)
        .map(|i| format!(r#"<rect class="c{i} c{i}" width="5" height="5"/>"#))
        .collect();
    let indexed = format!(
        r#"<svg width="10mm" height="10mm"><style>{rules}</style>{elements}<rect width="5" height="5"/></svg>"#
    );
    let read = shapes::read(&indexed, None).unwrap();
    assert_eq!(read.unsupported.len(), 30_000);
    assert_eq!(read.contours.len(), 1);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(30),
        "{:?}",
        started.elapsed()
    );
}
