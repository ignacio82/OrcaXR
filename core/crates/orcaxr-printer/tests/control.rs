//! Printer control against the production browser (`printer-control-vectors.mjs`):
//! availability, send plans, failure sentences, status summaries, guarded
//! actions and hold-to-confirm traces, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::{
    control::{self, HoldToConfirm},
    summary,
};
use serde_json::Value as Json;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-control-vectors.json"
    ))
    .unwrap()
}
fn each(corpus: &Json, section: &str, mut answer: impl FnMut(&str) -> String) -> usize {
    let cases = corpus[section].as_array().unwrap();
    for (i, case) in cases.iter().enumerate() {
        assert_eq!(
            answer(case["requestJson"].as_str().unwrap()),
            case["replyJson"].as_str().unwrap(),
            "{section} {i}: {}",
            case["requestJson"]
        );
    }
    cases.len()
}

#[test]
fn printer_control_answers_as_the_browser_does() {
    let corpus = corpus();
    let counts = [
        each(&corpus, "availability", |r| {
            let request = wire::decode_print_job_availability_request(r).unwrap();
            let observed = match &request.observed {
                wire::OptionalPrintJobSnapshot::Value(s) => Some(s),
                wire::OptionalPrintJobSnapshot::Absent(_) => None,
            };
            wire::encode_print_job_command_descriptors(&control::availability(observed)).unwrap()
        }),
        each(&corpus, "checks", |r| {
            let request = wire::decode_print_job_command_check_request(r).unwrap();
            wire::encode_print_job_command_plan(&control::plan(&request)).unwrap()
        }),
        each(&corpus, "failures", |r| {
            let request = wire::decode_print_job_command_failure_request(r).unwrap();
            wire::encode_print_job_command_refusal(&control::failure(&request)).unwrap()
        }),
        each(&corpus, "summaries", |r| {
            let request = wire::decode_printer_status_request(r).unwrap();
            wire::encode_printer_status_summary(&summary::summarize(&request)).unwrap()
        }),
        each(&corpus, "guarded", |r| {
            let request = wire::decode_guarded_printer_actions_request(r).unwrap();
            wire::encode_guarded_printer_actions(&control::guarded(&request)).unwrap()
        }),
    ];
    let mut steps = 0;
    for trace in corpus["holds"].as_array().unwrap() {
        let mut hold = HoldToConfirm::new();
        for (i, step) in trace["steps"].as_array().unwrap().iter().enumerate() {
            let now = step["nowMs"].as_f64().unwrap();
            let reply = match step["op"].as_str().unwrap() {
                "press" => {
                    let action =
                        wire::decode_guarded_printer_action(step["actionJson"].as_str().unwrap())
                            .unwrap();
                    wire::encode_hold_to_confirm_state(&hold.press(&action, now)).unwrap()
                }
                "poll" => wire::encode_hold_to_confirm_state(&hold.poll(now)).unwrap(),
                "cancel" => wire::encode_hold_to_confirm_state(&hold.cancel()).unwrap(),
                "release" => wire::encode_hold_to_confirm_release(&hold.release(now)).unwrap(),
                op => panic!("unknown op {op}"),
            };
            assert_eq!(
                reply,
                step["replyJson"].as_str().unwrap(),
                "{} step {i}",
                trace["name"]
            );
            steps += 1;
        }
    }
    assert_eq!(counts, [45, 1125, 100, 1173, 540]);
    assert_eq!(steps, 35);
}
