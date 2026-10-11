//! Paint strokes over a live session against the browser: the browser-authored
//! project opens as a native session, and the host's script of strokes — opens
//! and their refusals, samples, overlay pages and commits — answers byte for
//! byte, each commit staged and executed leaving the browser's revision, hash
//! and undo label.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, facets::overlay::Overlay, facets::paint_facets::PaintFacets,
    facets::paint_stroke::PaintStroke, history::*, model::*, selection::*, session::*,
    validation::*,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/paint-stroke-vectors.json"
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

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// An overlay's summary, whole packet and, past two facets, the window of
/// facets 1 and 2, as the browser recorded them.
fn packets(overlay: &Overlay, step: &Value, i: usize) {
    assert_eq!(
        wire::encode_paint_overlay_summary(&overlay.summary()).unwrap(),
        step["summary"].as_str().unwrap(),
        "step {i} summary"
    );
    assert_eq!(
        sha256(&overlay.packet(0, 16384).unwrap()),
        step["packet"].as_str().unwrap(),
        "step {i} packet"
    );
    assert_eq!(
        step.get("window")
            .map(|_| sha256(&overlay.packet(1, 2).unwrap())),
        step.get("window").map(|w| w.as_str().unwrap().to_owned()),
        "step {i} window"
    );
    assert_eq!(
        overlay.facet_count() > 2,
        step.get("window").is_some(),
        "step {i}"
    );
}

/// Paint facets' summary, runs and leaves and, past two of each, their
/// windows of 1 and 2, as the browser recorded them.
fn facets(facets: &PaintFacets, step: &Value, i: usize) {
    assert_eq!(
        facets.summary(),
        step["summary"].as_str().unwrap(),
        "step {i} summary"
    );
    assert_eq!(
        sha256(&facets.runs(0, 16384).unwrap()),
        step["runs"].as_str().unwrap(),
        "step {i} runs"
    );
    assert_eq!(
        sha256(&facets.leaves(0, 16384).unwrap()),
        step["leaves"].as_str().unwrap(),
        "step {i} leaves"
    );
    for (key, count, page) in [
        ("runWindow", facets.run_count(), facets.runs(1, 2)),
        ("leafWindow", facets.leaf_count(), facets.leaves(1, 2)),
    ] {
        assert_eq!(
            (count > 2).then(|| sha256(&page.unwrap())),
            step.get(key).map(|w| w.as_str().unwrap().to_owned()),
            "step {i} {key}"
        );
    }
}

#[test]
fn paint_strokes_match_the_browser_over_a_live_session() {
    let f = fixture();
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in f["assets"].as_array().unwrap() {
        let bytes: Vec<u8> = asset["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes,
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
            max_asset_bytes: 0,
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

    let mut strokes: BTreeMap<String, PaintStroke> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let name = step["stroke"].as_str().unwrap_or_default().to_owned();
        let refusal = step.get("refusal").map(|code| code.as_str().unwrap());
        let kind = if step.get("previewFacets").is_some() {
            facets(&strokes[&name].preview_facets().unwrap(), step, i);
            "preview facets"
        } else if let Some(canonical) = step.get("canonicalFacets") {
            let request = wire::decode_paint_overlay_request(canonical.as_str().unwrap()).unwrap();
            let captured = session.paint_facets(&request);
            match (refusal, step.get("count")) {
                (Some(code), Some(count)) => {
                    let captured = captured.unwrap();
                    let count = count.as_u64().unwrap();
                    assert_eq!(
                        captured.runs(0, count).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    assert_eq!(
                        captured.leaves(0, count).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused facets packet"
                }
                (Some(code), None) => {
                    assert_eq!(
                        captured.map(|_| ()).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused facets"
                }
                (None, _) => {
                    facets(&captured.unwrap(), step, i);
                    "canonical facets"
                }
            }
        } else if step.get("preview").is_some() {
            let preview = strokes[&name].preview().unwrap();
            packets(&preview, step, i);
            "preview"
        } else if let Some(canonical) = step.get("canonical") {
            let request = wire::decode_paint_overlay_request(canonical.as_str().unwrap()).unwrap();
            let overlay = session.paint_overlay(&request);
            match (refusal, step.get("count")) {
                (Some(code), Some(count)) => {
                    assert_eq!(
                        overlay
                            .unwrap()
                            .packet(0, count.as_u64().unwrap())
                            .map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused packet"
                }
                (Some(code), None) => {
                    assert_eq!(
                        overlay.map(|_| ()).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused overlay"
                }
                (None, _) => {
                    packets(&overlay.unwrap(), step, i);
                    "canonical"
                }
            }
        } else if let Some(open) = step.get("open") {
            let request = wire::decode_paint_stroke_open(open.as_str().unwrap()).unwrap();
            let opened = session.paint_stroke(&session.capture_guard().unwrap(), &request);
            match refusal {
                Some(code) => {
                    assert_eq!(
                        opened.map(|_| ()).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused open"
                }
                None => {
                    strokes.insert(name, opened.unwrap());
                    "open"
                }
            }
        } else if let Some(sample) = step.get("sample") {
            let request = wire::decode_paint_stroke_sample(sample.as_str().unwrap()).unwrap();
            let reply = strokes.get_mut(&name).unwrap().sample(&request);
            assert_eq!(
                wire::encode_paint_stroke_sample_reply(&reply).unwrap(),
                step["reply"].as_str().unwrap(),
                "step {i}"
            );
            "sample"
        } else if let Some(overlay) = step.get("overlay") {
            let request =
                wire::decode_paint_stroke_overlay_request(overlay.as_str().unwrap()).unwrap();
            let page = strokes[&name].overlay(&request);
            match refusal {
                Some(code) => {
                    assert_eq!(
                        page.map(|_| ()).map_err(|r| r.code()),
                        Err(code),
                        "step {i}"
                    );
                    "refused overlay"
                }
                None => {
                    assert_eq!(
                        wire::encode_paint_stroke_overlay(&page.unwrap()).unwrap(),
                        step["reply"].as_str().unwrap(),
                        "step {i}"
                    );
                    "overlay"
                }
            }
        } else {
            let stroke = strokes.remove(&name).unwrap();
            let label = step["commit"].as_array().map(|_| units(&step["commit"]));
            let outcome = match session.stage_paint_stroke(&stroke, label) {
                Ok(None) => "noop",
                Err(wire::SessionError::Stale) => "stale",
                Ok(Some(id)) => {
                    let result = run(
                        &mut session,
                        &mut sequence,
                        json!({"executeStaged":{"stagedId":id}}),
                    );
                    match result["acknowledged"]["changed"].as_bool() {
                        Some(true) => "applied",
                        Some(false) => "unchanged",
                        None => panic!("step {i}: {result}"),
                    }
                }
                Err(error) => panic!("step {i}: {error:?}"),
            };
            assert_eq!(outcome, step["outcome"].as_str().unwrap(), "step {i}");
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
            outcome
        };
        *counts.entry(kind.to_owned()).or_default() += 1;
    }
    assert!(strokes.is_empty());
    assert_eq!(
        counts,
        BTreeMap::from(
            [
                ("refused open", 8),
                ("open", 14),
                ("sample", 22),
                ("overlay", 5),
                ("refused overlay", 2),
                ("refused packet", 1),
                ("preview", 22),
                ("canonical", 29),
                ("preview facets", 22),
                ("canonical facets", 29),
                ("refused facets", 1),
                ("refused facets packet", 1),
                ("applied", 11),
                ("unchanged", 1),
                ("noop", 1),
                ("stale", 1),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );

    // A disposed session opens nothing, even under a guard captured before.
    let request = wire::decode_paint_stroke_open(f["steps"][8]["open"].as_str().unwrap()).unwrap();
    let guard = session.capture_guard().unwrap();
    session.dispose();
    assert_eq!(
        session
            .paint_stroke(&guard, &request)
            .map(|_| ())
            .map_err(|r| r.code()),
        Err("disposed")
    );
}
