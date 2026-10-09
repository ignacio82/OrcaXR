//! The printer session against the production browser
//! (`printer-session-vectors.mjs`): every recorded input, fed in order,
//! must produce the browser's step and view, or its reply, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::session::{PrinterSession, command_named};
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn printer_session_steps_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-session-vectors.json"
    ))
    .unwrap();
    let scenarios = corpus["scenarios"].as_array().unwrap();
    let mut counts = [0usize; 4];
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut session = PrinterSession::new();
        for (i, record) in scenario["records"].as_array().unwrap().iter().enumerate() {
            let (kind, value) = record["input"].as_object().unwrap().iter().next().unwrap();
            let label = format!("{name}, input {i}: {kind} {value}");
            let id = || value["id"].as_u64().unwrap();
            let now = || value["now"].as_f64().unwrap();
            let step = match kind.as_str() {
                "select" => session.select(wire::decode_printer_selection(text(value)).unwrap()),
                "clear" => Ok(session.clear()),
                "dispose" => Ok(session.dispose()),
                "connect" => Ok(session.connect()),
                "refresh" => Ok(session.refresh()),
                "execute" => {
                    Ok(session
                        .execute(wire::decode_print_job_execute_request(text(value)).unwrap()))
                }
                "state" => Ok(session.transport_state(
                    value["transport"].as_u64().unwrap(),
                    wire::decode_connection_signal(text(&value["signal"])).unwrap(),
                )),
                "notification" => session.notification(
                    value["transport"].as_u64().unwrap(),
                    text(&value["method"]),
                    text(&value["params"]),
                    now(),
                ),
                "resolve" => session.resolve(
                    id(),
                    wire::decode_printer_session_outcome(text(&value["outcome"])).unwrap(),
                ),
                "reply" => session.resolve_reply(id(), text(&value["text"]), now()),
                "captureIntent" => {
                    let reply = session.capture_intent(command_named(text(value)).unwrap());
                    assert_eq!(
                        wire::encode_print_job_intent_reply(&reply).unwrap(),
                        text(&record["intent"]),
                        "{label}"
                    );
                    counts[1] += 1;
                    continue;
                }
                "confirm" => {
                    let reply = session.confirm(value.as_u64().unwrap());
                    assert_eq!(
                        wire::encode_print_job_confirm_reply(&reply).unwrap(),
                        text(&record["token"]),
                        "{label}"
                    );
                    counts[1] += 1;
                    continue;
                }
                "captureLease" => {
                    let reply = session.capture_lease();
                    assert_eq!(
                        wire::encode_printer_session_lease_reply(&reply).unwrap(),
                        text(&record["lease"]),
                        "{label}"
                    );
                    counts[1] += 1;
                    continue;
                }
                "leaseCurrent" => {
                    let lease = wire::decode_printer_session_lease(text(value)).unwrap();
                    assert_eq!(
                        session.lease_current(&lease),
                        record["current"].as_bool().unwrap(),
                        "{label}"
                    );
                    counts[1] += 1;
                    continue;
                }
                other => panic!("unknown input {other}"),
            };
            match step {
                Ok(step) => {
                    assert_eq!(
                        wire::encode_printer_session_step(&step).unwrap(),
                        text(&record["step"]),
                        "{label}"
                    );
                    assert_eq!(
                        wire::encode_printer_session_view(&session.view()).unwrap(),
                        text(&record["view"]),
                        "{label} (view)"
                    );
                    counts[0] += 1;
                }
                Err(refusal) => {
                    assert_eq!(refusal.code(), text(&record["refused"]), "{label}");
                    counts[2] += 1;
                }
            }
        }
        counts[3] += 1;
    }
    assert_eq!(counts, [3254, 557, 8, 80]);
}
