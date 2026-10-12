//! The volume-role editor replays the browser's answers
//! (`volume-role-vectors.json`): every volume's role choices, the conversion
//! command's decision for every role and for role texts Orca lacks, each
//! conversion's words, and malformed requests refused — on real store
//! snapshots of each recorded state. The conversion command refuses exactly
//! what the decision blocks, in the same words.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    commands::{VolumeRoleDecision, inspect_volume_role_conversion},
    model::*,
    store::ProjectStore,
    validation::*,
    volume_role_editor as roles,
};
use serde_json::Value as Json;
use std::collections::HashMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/volume-role-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}
fn store(case: &Json) -> ProjectStore {
    let state = ProjectState::from_value(parse(text(&case["stateJson"])).unwrap()).unwrap();
    ProjectStore::new(ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap())
}

#[test]
fn volume_role_editor_matches_the_browser() {
    let f = corpus();
    let stores: HashMap<&str, ProjectStore> = f["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| (text(&case["name"]), store(case)))
        .collect();
    for case in f["states"].as_array().unwrap() {
        let snapshot = stores[text(&case["name"])].snapshot();
        assert_eq!(
            snapshot.hash(),
            text(&case["hash"]),
            "{}",
            text(&case["name"])
        );
    }
    for case in f["projections"].as_array().unwrap() {
        let snapshot = stores[text(&case["state"])].snapshot();
        assert_eq!(
            roles::projection_json(snapshot.state(), text(&case["requestJson"])).unwrap(),
            text(&case["replyJson"]),
            "{}",
            text(&case["requestJson"])
        );
    }
    let mut blocked = 0;
    for case in f["decisions"].as_array().unwrap() {
        let snapshot = stores[text(&case["state"])].snapshot();
        let request = text(&case["requestJson"]);
        assert_eq!(
            roles::decision_json(snapshot.state(), request).unwrap(),
            text(&case["replyJson"]),
            "{request}"
        );
        let fields = parse(request).unwrap();
        let orcaxr_contracts::canonical::Value::Object(fields) = fields else {
            unreachable!()
        };
        let units = |key: &str| match &fields[&key.encode_utf16().collect::<Vec<_>>()] {
            orcaxr_contracts::canonical::Value::String(units) => units.clone(),
            _ => unreachable!(),
        };
        if let VolumeRoleDecision::Blocked { .. } =
            inspect_volume_role_conversion(snapshot.state(), &units("volumeId"), &units("role"))
        {
            blocked += 1;
        }
    }
    for case in f["messages"].as_array().unwrap() {
        assert_eq!(
            roles::messages_json(text(&case["requestJson"])).unwrap(),
            text(&case["replyJson"]),
            "{}",
            text(&case["requestJson"])
        );
    }
    let rich = stores["rich"].snapshot();
    for r in f["refusals"].as_array().unwrap() {
        let request = text(&r["request"]);
        let refused = match text(&r["exchange"]) {
            "projection" => roles::projection_json(rich.state(), request),
            "decision" => roles::decision_json(rich.state(), request),
            "messages" => roles::messages_json(request),
            other => panic!("{other}"),
        };
        assert_eq!(refused, Err(roles::INVALID_REQUEST), "{request}");
    }
    assert_eq!(
        [
            f["states"].as_array().unwrap().len(),
            f["projections"].as_array().unwrap().len(),
            f["decisions"].as_array().unwrap().len(),
            blocked,
            f["messages"].as_array().unwrap().len(),
            f["refusals"].as_array().unwrap().len(),
        ],
        [3, 38, 330, 243, 25, 12]
    );
}
