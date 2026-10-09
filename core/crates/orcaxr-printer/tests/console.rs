//! The printer console against the production browser
//! (`printer-console-vectors.mjs`): every assessment, plan, finish, read,
//! invocation and transcript line must be the browser's, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::console;
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn the_console_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-console-vectors.json"
    ))
    .unwrap();
    let section = |name: &str| corpus[name].as_array().unwrap().clone();
    let check = |actual: String, case: &Json, label: &str| {
        assert_eq!(actual, text(&case["replyJson"]), "{label} {case}");
    };
    for case in &section("assessments") {
        let request = wire::decode_gcode_assess_request(text(&case["requestJson"])).unwrap();
        let job = match request.job_state {
            wire::OptionalPrintJobState::Value(state) => Some(state),
            wire::OptionalPrintJobState::Absent(_) => None,
        };
        let answer = console::assess(&request.script, job);
        check(
            wire::encode_gcode_assessment(&answer).unwrap(),
            case,
            "assess",
        );
    }
    for case in &section("plans") {
        let op = wire::decode_console_operation(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_console_plan(&console::plan(&op)).unwrap(),
            case,
            "plan",
        );
    }
    for case in &section("finishes") {
        let request = wire::decode_console_finish(text(&case["requestJson"])).unwrap();
        let answer = console::finish(&request);
        check(
            wire::encode_console_result(&answer).unwrap(),
            case,
            "finish",
        );
    }
    for case in &section("reads") {
        let op = wire::decode_console_operation(text(&case["operationJson"])).unwrap();
        let answer = console::read(&op, text(&case["reply"]));
        check(wire::encode_console_result(&answer).unwrap(), case, "read");
    }
    for case in &section("invocations") {
        let request = wire::decode_macro_invocation_request(text(&case["requestJson"])).unwrap();
        let answer = console::invocation(&request);
        check(
            wire::encode_macro_invocation(&answer).unwrap(),
            case,
            "invocation",
        );
    }
    for case in &section("lines") {
        let request = wire::decode_console_line_request(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_console_line(&console::line(&request)).unwrap(),
            case,
            "line",
        );
    }
    for case in &section("notifications") {
        let request =
            wire::decode_console_notification_request(text(&case["requestJson"])).unwrap();
        let answer = match console::notification(&request, text(&case["params"])) {
            Some(line) => wire::OptionalConsoleLine::Value(line),
            None => wire::OptionalConsoleLine::Absent(wire::Empty {}),
        };
        check(
            wire::encode_optional_console_line(&answer).unwrap(),
            case,
            "notification",
        );
    }
    for case in &section("recents") {
        let request = wire::decode_console_recent_request(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_text_list(&console::recent(&request)).unwrap(),
            case,
            "recent",
        );
    }
    let counts: Vec<usize> = [
        "assessments",
        "plans",
        "finishes",
        "reads",
        "invocations",
        "lines",
        "notifications",
        "recents",
    ]
    .iter()
    .map(|name| section(name).len())
    .collect();
    assert_eq!(counts, [408, 44, 284, 51, 76, 33, 34, 28]);
}
