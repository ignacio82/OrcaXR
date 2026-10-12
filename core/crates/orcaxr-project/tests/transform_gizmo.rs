//! The workspace's transform gizmo against the browser's three.js
//! `TransformControls` (`transform-gizmo-vectors.json`): the baked handle
//! geometry byte for byte; every pointer sequence replayed through the JSON
//! state (attach, then one step per event), each step's `changed` and the
//! SHA-256 of its view — axis, drag, proxy and every handle's visibility,
//! world matrix, colour and opacity — exactly; the changes drags submit; and
//! the exchanges' refusals.
use orcaxr_project::placement::gizmo::{
    INVALID_REQUEST, attach_json, changes_json, geometry_json, present_json, step_json,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/transform-gizmo-vectors.json"
    ))
    .unwrap()
}
fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
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
fn handle_geometry_is_what_three_bakes() {
    assert_eq!(
        geometry_json().unwrap(),
        corpus()["geometry"].as_str().unwrap()
    );
}

#[test]
fn pointer_sequences_replay_as_three_controls_them() {
    let corpus = corpus();
    let sequences = corpus["sequences"].as_array().unwrap();
    assert_eq!(sequences.len(), 564);
    let mut steps = 0;
    for case in sequences {
        let request: Value = serde_json::from_str(case["request"].as_str().unwrap()).unwrap();
        let scene = format!(
            r#""camera":{},"mode":{},"root":{},"space":{}"#,
            request["camera"], request["mode"], request["root"], request["space"]
        );
        let mut state = attach_json(&format!(r#"{{"proxy":{}}}"#, request["proxy"])).unwrap();
        let events = request["events"].as_array().unwrap();
        let expected = case["steps"].as_array().unwrap();
        assert_eq!(events.len(), expected.len());
        for (index, (event, step)) in events.iter().zip(expected).enumerate() {
            state = step_json(&format!(r#"{{{scene},"event":{event},"state":{state}}}"#)).unwrap();
            let parsed: Value = serde_json::from_str(&state).unwrap();
            let label = format!("{} step {index} {event}", case["name"]);
            assert_eq!(parsed["changed"], step["changed"], "{label}");
            let view = present_json(&format!(r#"{{{scene},"state":{state}}}"#)).unwrap();
            assert_eq!(
                sha256(&view),
                step["view"].as_str().unwrap(),
                "{label}\n{view}"
            );
            steps += 1;
        }
    }
    assert_eq!(steps, 14161);
}

#[test]
fn drags_submit_what_the_browser_submits() {
    let corpus = corpus();
    let changes = corpus["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 198);
    for case in changes {
        let reply = changes_json(case["request"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["reply"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let refusals = corpus["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 34);
    for case in refusals {
        let request = case["request"].as_str().unwrap();
        let reply = match case["exchange"].as_str().unwrap() {
            "attach" => attach_json(request),
            "step" => step_json(request),
            "present" => present_json(request),
            _ => changes_json(request),
        };
        assert_eq!(reply, Err(INVALID_REQUEST), "{request}");
    }
}

#[test]
fn states_round_trip_exactly() {
    // A state carries -0, NaN and the infinities as strings, and reads back
    // to the same text; a fresh state is three's new controls.
    let state =
        attach_json(r#"{"proxy":{"position":[1,2,3],"quaternion":[0,0,0,1],"scale":[1,1,1]}}"#)
            .unwrap();
    assert_eq!(
        state,
        r#"{"axis":null,"changed":false,"dragging":false,"proxy":{"position":[1,2,3],"quaternion":[0,0,0,1],"scale":[1,1,1]},"rotationAxis":[0,0,0],"start":{"point":[0,0,0],"position":[0,0,0],"quaternion":[0,0,0,1],"scale":[0,0,0],"worldPosition":[0,0,0],"worldQuaternion":[0,0,0,1]}}"#
    );
    let special = state
        .replace(r#""scale":[1,1,1]"#, r#""scale":["-0","NaN","Infinity"]"#)
        .replace(r#""axis":null"#, r#""axis":"XYZE""#);
    let scene = r#""camera":{"aspect":1,"far":100,"fov":50,"near":0.1,"position":[0,0,5],"target":[0,0,0],"up":[0,1,0]},"mode":"rotate","root":{"position":[0,0,0],"quaternion":[0,0,0,1],"scale":[1,1,1]},"space":"world""#;
    let stepped = step_json(&format!(
        r#"{{{scene},"event":{{"kind":"release","x":0,"y":0}},"state":{special}}}"#
    ))
    .unwrap();
    assert!(
        stepped.contains(r#""scale":["-0","NaN","Infinity"]"#),
        "{stepped}"
    );
    assert!(stepped.contains(r#""axis":null"#), "{stepped}");
    for bad in [
        special.replace(r#""axis":"XYZE""#, r#""axis":"W""#),
        special.replace(r#""NaN""#, r#""nan""#),
        special.replace(r#""changed":false,"#, ""),
        special.replace(r#""dragging":false"#, r#""dragging":0"#),
    ] {
        assert_eq!(
            step_json(&format!(
                r#"{{{scene},"event":{{"kind":"hover","x":0,"y":0}},"state":{bad}}}"#
            )),
            Err(INVALID_REQUEST),
            "{bad}"
        );
    }
}
