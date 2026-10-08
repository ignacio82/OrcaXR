use orcaxr_contracts::capabilities::{
    self, ACTIONS, Availability, BootPhase, ContextTarget, Feature, FeaturePhase, Initialization,
    Mode, PrinterJobState, Reason, Surface, UiState,
};
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/action-capability-vectors.json"
    ))
    .unwrap()
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn flag(state: &Value, key: &str) -> bool {
    state[key].as_bool().unwrap_or(false)
}
fn count(state: &Value, key: &str) -> u64 {
    state[key].as_u64().unwrap()
}
fn ui_state(state: &Value) -> UiState {
    UiState {
        initialization: state.get("initialization").map(|i| Initialization {
            phase: BootPhase::from_id(i["phase"].as_str().unwrap()).unwrap(),
            features: i["features"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| Feature {
                    id: units(f["id"].as_str().unwrap()),
                    label: units(f["label"].as_str().unwrap()),
                    phase: FeaturePhase::from_id(f["phase"].as_str().unwrap()).unwrap(),
                    reason: units(f["reason"].as_str().unwrap()),
                })
                .collect(),
        }),
        mode: Mode::from_id(state["mode"].as_str().unwrap()).unwrap(),
        model_count: count(state, "modelCount"),
        plate_count: count(state, "plateCount"),
        has_selection: flag(state, "hasSelection"),
        simplify_previewing: flag(state, "simplifyPreviewing"),
        calibration_session_open: flag(state, "calibrationSessionOpen"),
        has_instance_selection: flag(state, "hasInstanceSelection"),
        can_undo: flag(state, "canUndo"),
        can_redo: flag(state, "canRedo"),
        dirty: flag(state, "dirty"),
        projection_healthy: flag(state, "projectionHealthy"),
        has_clipboard: flag(state, "hasClipboard"),
        is_slicing: flag(state, "isSlicing"),
        gcode_ready: flag(state, "gcodeReady"),
        preflight_blocked: flag(state, "preflightBlocked"),
        printer_job_state: PrinterJobState::from_id(state["printerJobState"].as_str().unwrap())
            .unwrap(),
    }
}
/// A reason as the browser reports it: code, prerequisite and text.
fn reason_value(reason: &Reason<'_>) -> Value {
    let mut value = serde_json::json!({
        "code": reason.code(),
        "text": String::from_utf16(&reason.text()).unwrap(),
    });
    if let Some(p) = reason.prerequisite() {
        value["prerequisite"] = p.id().into();
    }
    value
}
fn indices(list: &Value) -> Vec<usize> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_u64().unwrap() as usize)
        .collect()
}
fn position(action: &capabilities::Action) -> usize {
    ACTIONS
        .iter()
        .position(|a| std::ptr::eq(a, action))
        .unwrap()
}

#[test]
fn the_catalog_and_its_surfaces_match_the_registry() {
    let corpus = corpus();
    let ids: Vec<&str> = corpus["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(ACTIONS.iter().map(|a| a.id).collect::<Vec<_>>(), ids);
    let surfaces: Vec<&str> = corpus["surfaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert_eq!(Surface::ALL.map(Surface::id).to_vec(), surfaces);
    for surface in Surface::ALL {
        let listed: Vec<usize> = capabilities::for_surface(surface).map(position).collect();
        assert_eq!(
            listed,
            indices(&corpus["forSurface"][surface.id()]),
            "{}",
            surface.id()
        );
    }
    for surface in [Surface::DomContext, Surface::XrContext] {
        for target in ContextTarget::ALL {
            let key = format!("{}:{}", surface.id(), target.id());
            let listed: Vec<usize> = capabilities::for_context(target, surface)
                .map(position)
                .collect();
            assert_eq!(listed, indices(&corpus["forContext"][&key]), "{key}");
        }
    }
    let initial = UiState::default();
    let unknown = capabilities::availability("not_an_action", Surface::DomMenu, &initial);
    assert_eq!(unknown, Availability::Hidden(Reason::UnknownAction));
    assert_eq!(
        reason_value(&Reason::UnknownAction),
        corpus["unknownAction"]
    );
}

#[test]
fn every_action_on_every_surface_matches_the_registry() {
    let corpus = corpus();
    let reasons = corpus["reasons"].as_array().unwrap();
    let mut compared = 0;
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let json: Value = serde_json::from_str(case["stateJson"].as_str().unwrap()).unwrap();
        let state = ui_state(&json);
        if name == "initial" {
            assert_eq!(state, UiState::default(), "the default is INITIAL_UI_STATE");
        }
        for surface in Surface::ALL {
            let expected: Vec<&str> = case["availability"][surface.id()]
                .as_str()
                .unwrap()
                .split(' ')
                .collect();
            assert_eq!(expected.len(), ACTIONS.len());
            for (action, expected) in ACTIONS.iter().zip(expected) {
                let label = format!("{name} {} {}", surface.id(), action.id);
                let actual = action.availability(surface, &state);
                assert_eq!(
                    capabilities::availability(action.id, surface, &state),
                    actual,
                    "{label} by id"
                );
                match actual {
                    Availability::Enabled => assert_eq!(expected, "e", "{label}"),
                    Availability::Hidden(reason) | Availability::Disabled(reason) => {
                        let kind = if matches!(actual, Availability::Hidden(_)) {
                            'h'
                        } else {
                            'd'
                        };
                        assert_eq!(expected.chars().next(), Some(kind), "{label}");
                        let index: usize = expected[1..].parse().unwrap();
                        assert_eq!(reason_value(&reason), reasons[index], "{label}");
                    }
                }
                compared += 1;
            }
        }
    }
    assert!(compared > 100_000, "{compared}");
}
