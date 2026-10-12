//! The generated settings panel and the height-range editor replay the
//! browser's answers (`settings-panel-vectors.json`): every session's views,
//! rows, drafts, states, applies and intents over an editor opened on a real
//! store snapshot, the scoped panel's target texts, and every height-range
//! projection, bounds and split check and operation message.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    layer_range_editor as ranges,
    model::*,
    settings::{
        editor::{AsciiFolding, SearchFolding, exchange::HostEditor, panel_exchange},
        presets::{AsciiRootCollation, NonAsciiText},
    },
    store::ProjectStore,
    validation::*,
};
use serde_json::Value as Json;
use std::collections::HashMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/settings-panel-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

/// The browser's folding: ASCII lowercases; other text as the corpus folded it.
struct TableFolding(HashMap<Vec<u16>, Vec<u16>>);
impl SearchFolding for TableFolding {
    type Error = NonAsciiText;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, NonAsciiText> {
        if text.iter().all(|u| *u < 0x80) {
            return Ok(AsciiFolding.fold(text).unwrap());
        }
        Ok(self
            .0
            .get(text)
            .unwrap_or_else(|| panic!("no folding for {:?}", String::from_utf16_lossy(text)))
            .clone())
    }
}

fn store(case: &Json) -> ProjectStore {
    let state = ProjectState::from_value(parse(text(&case["stateJson"])).unwrap()).unwrap();
    ProjectStore::new(ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap())
}

#[test]
fn settings_panel_sessions_match_the_browser() {
    let f = corpus();
    let mut folding = TableFolding(
        f["foldings"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (units(k), units(text(v))))
            .collect(),
    );
    let stores: HashMap<&str, ProjectStore> = f["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let store = store(case);
            let snapshot = store.snapshot();
            assert_eq!(snapshot.revision(), case["revision"].as_u64().unwrap());
            assert_eq!(snapshot.hash(), text(&case["hash"]));
            (text(&case["name"]), store)
        })
        .collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for session in f["sessions"].as_array().unwrap() {
        let label = format!("{} {}", text(&session["state"]), text(&session["target"]));
        let snapshot = stores[text(&session["state"])].snapshot();
        let request = wire::decode_settings_session_request(text(&session["requestJson"])).unwrap();
        let mut editor = HostEditor::open::<NonAsciiText>(&snapshot, &request).unwrap();
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            let kind = text(&step["kind"]);
            let at = format!("{label} step {index} {kind}");
            let request = step["requestJson"].as_str().unwrap_or("");
            let reply = match kind {
                "view" => Some(
                    editor
                        .panel_view(request, &mut AsciiRootCollation, &mut folding)
                        .unwrap(),
                ),
                "row" => Some(editor.panel_row::<NonAsciiText>(request).unwrap()),
                "edit" => Some(editor.panel_edit::<NonAsciiText>(request).unwrap()),
                "state" => Some(editor.panel_state::<NonAsciiText>().unwrap()),
                "apply" => {
                    let before = editor.intent().cloned();
                    let reply = editor.panel_apply(&mut AsciiRootCollation).unwrap();
                    match step["intentJson"].as_str() {
                        Some(intent) => assert_eq!(
                            wire::encode_intent(editor.intent().unwrap()).unwrap(),
                            intent,
                            "{at}"
                        ),
                        None => assert_eq!(editor.intent().cloned(), before, "{at}"),
                    }
                    Some(reply)
                }
                "cancel" => {
                    editor.panel_cancel();
                    None
                }
                other => panic!("{other}"),
            };
            if let Some(reply) = reply {
                assert_eq!(reply, text(&step["replyJson"]), "{at}");
            }
            *counts
                .entry(match kind {
                    "view" | "row" | "edit" | "state" | "apply" | "cancel" => kind,
                    _ => unreachable!(),
                })
                .or_default() += 1;
        }
    }
    let mut refused = 0;
    let request =
        wire::decode_settings_session_request(text(&f["sessions"][0]["requestJson"])).unwrap();
    let snapshot = stores[text(&f["sessions"][0]["state"])].snapshot();
    for r in f["refusals"].as_array().unwrap() {
        let mut editor = HostEditor::open::<NonAsciiText>(&snapshot, &request).unwrap();
        let request = text(&r["request"]);
        let failed = match text(&r["exchange"]) {
            "view" => editor
                .panel_view(request, &mut AsciiRootCollation, &mut folding)
                .is_err(),
            "row" => editor.panel_row::<NonAsciiText>(request).is_err(),
            "edit" => editor.panel_edit::<NonAsciiText>(request).is_err(),
            "targetText" => panel_exchange::target_text_json(request).is_err(),
            other => panic!("{other}"),
        };
        assert!(failed, "{request} was accepted");
        refused += 1;
    }
    for case in f["targetTexts"].as_array().unwrap() {
        assert_eq!(
            panel_exchange::target_text_json(text(&case["requestJson"])).unwrap(),
            text(&case["replyJson"])
        );
    }
    println!("settings panel: {counts:?}, {refused} refusals");
    assert_eq!(f["sessions"].as_array().unwrap().len(), 18);
    assert_eq!(refused, 11);
}

#[test]
fn height_range_editor_matches_the_browser() {
    let f = corpus();
    let l = &f["layerRanges"];
    let stores: HashMap<&str, ProjectStore> = f["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| (text(&case["name"]), store(case)))
        .collect();
    for case in l["projections"].as_array().unwrap() {
        let snapshot = stores[text(&case["state"])].snapshot();
        assert_eq!(
            ranges::projection_json(snapshot.state(), text(&case["requestJson"])).unwrap(),
            text(&case["replyJson"]),
            "{}",
            text(&case["requestJson"])
        );
    }
    for (kind, exchange) in [
        (
            "bounds",
            ranges::bounds_json as fn(&str) -> Result<String, &'static str>,
        ),
        ("splits", ranges::split_json),
        ("messages", ranges::messages_json),
    ] {
        for case in l[kind].as_array().unwrap() {
            assert_eq!(
                exchange(text(&case["requestJson"])).unwrap(),
                text(&case["replyJson"]),
                "{kind} {}",
                text(&case["requestJson"])
            );
        }
    }
    let rich = stores["rich"].snapshot();
    for r in l["refusals"].as_array().unwrap() {
        let request = text(&r["request"]);
        let refused = match text(&r["exchange"]) {
            "projection" => ranges::projection_json(rich.state(), request),
            "bounds" => ranges::bounds_json(request),
            "split" => ranges::split_json(request),
            "messages" => ranges::messages_json(request),
            other => panic!("{other}"),
        };
        assert_eq!(refused, Err(ranges::INVALID_REQUEST), "{request}");
    }
    assert_eq!(
        [
            l["projections"].as_array().unwrap().len(),
            l["bounds"].as_array().unwrap().len(),
            l["splits"].as_array().unwrap().len(),
            l["messages"].as_array().unwrap().len(),
            l["refusals"].as_array().unwrap().len(),
        ],
        [15, 384, 84, 42, 9]
    );
}
