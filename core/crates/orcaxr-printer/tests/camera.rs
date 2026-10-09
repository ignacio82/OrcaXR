//! Printer cameras against the production browser
//! (`printer-camera-vectors.mjs`): every listing, frame route and failure,
//! route list, description, poll interval and frame URL must be the
//! browser's, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::camera;
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn cameras_answer_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-camera-vectors.json"
    ))
    .unwrap();
    let section = |name: &str| corpus[name].as_array().unwrap().clone();
    let check = |actual: String, case: &Json, label: &str| {
        assert_eq!(actual, text(&case["replyJson"]), "{label} {case}");
    };
    assert_eq!(
        wire::encode_printer_send(&camera::list_plan()).unwrap(),
        text(&corpus["listPlan"]["replyJson"])
    );
    for case in &section("listReads") {
        let request = wire::decode_camera_list_request(text(&case["requestJson"])).unwrap();
        let answer = camera::list_read(&request, text(&case["reply"]));
        check(
            wire::encode_camera_list_result(&answer).unwrap(),
            case,
            "list",
        );
    }
    for case in &section("listFinishes") {
        let request = wire::decode_camera_list_finish(text(&case["requestJson"])).unwrap();
        let answer = camera::list_finish(&request);
        check(
            wire::encode_camera_list_result(&answer).unwrap(),
            case,
            "finish",
        );
    }
    for case in &section("snapshotPlans") {
        let request = wire::decode_camera_snapshot_request(text(&case["requestJson"])).unwrap();
        let answer = camera::snapshot_plan(&request);
        check(
            wire::encode_camera_snapshot_plan(&answer).unwrap(),
            case,
            "plan",
        );
    }
    for case in &section("snapshotFailures") {
        let request = wire::decode_camera_snapshot_finish(text(&case["requestJson"])).unwrap();
        let answer = camera::snapshot_failure(&request);
        check(
            wire::encode_camera_failure(&answer).unwrap(),
            case,
            "failure",
        );
    }
    for case in &section("mechanisms") {
        let request = wire::decode_camera_mechanisms_request(text(&case["requestJson"])).unwrap();
        let answer = camera::mechanisms_for(&request);
        check(
            wire::encode_camera_mechanisms(&answer).unwrap(),
            case,
            "mechanisms",
        );
    }
    for case in &section("describes") {
        let request = wire::decode_camera_describe_request(text(&case["requestJson"])).unwrap();
        let answer = wire::PrinterText {
            text: camera::describe(&request),
        };
        check(
            wire::encode_printer_text(&answer).unwrap(),
            case,
            "describe",
        );
    }
    for case in &section("pollIntervals") {
        let camera_wire = wire::decode_printer_camera(text(&case["requestJson"])).unwrap();
        assert_eq!(
            camera::poll_interval_ms(&camera_wire),
            case["intervalMs"].as_f64().unwrap(),
            "poll {case}"
        );
    }
    for case in &section("frameUrls") {
        let request = wire::decode_camera_frame_request(text(&case["requestJson"])).unwrap();
        let answer = camera::frame(&request);
        check(
            wire::encode_optional_printer_reply_text(&answer).unwrap(),
            case,
            "frame",
        );
    }
    let counts: Vec<usize> = [
        "listReads",
        "listFinishes",
        "snapshotPlans",
        "snapshotFailures",
        "mechanisms",
        "describes",
        "pollIntervals",
        "frameUrls",
    ]
    .iter()
    .map(|name| section(name).len())
    .collect();
    assert_eq!(counts, [62, 12, 462, 462, 616, 308, 154, 154]);
}
