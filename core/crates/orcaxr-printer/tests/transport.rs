//! The Moonraker transport against the production browser
//! (`moonraker-transport-vectors.mjs`): every recorded input, fed in order,
//! must produce the browser's step and state, or its reply, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::transport::{self, MoonrakerTransport};
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}
fn signal(value: &Json) -> wire::MoonrakerSignal {
    transport::signal_named(text(value)).unwrap()
}
fn reason(value: &Json) -> wire::MoonrakerDisconnectReason {
    transport::reason_named(text(value)).unwrap()
}

#[test]
fn moonraker_transport_steps_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/moonraker-transport-vectors.json"
    ))
    .unwrap();
    let scenarios = corpus["scenarios"].as_array().unwrap();
    let mut counts = [0usize; 5];
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut transport: Option<MoonrakerTransport> = None;
        for (i, record) in scenario["records"].as_array().unwrap().iter().enumerate() {
            let now = record["now"].as_f64().unwrap();
            let (kind, value) = record["input"].as_object().unwrap().iter().next().unwrap();
            let label = format!("{name}, input {i}: {kind}");
            if kind == "create" {
                let config = wire::decode_moonraker_transport_config(text(value)).unwrap();
                let reply = match MoonrakerTransport::new(&config) {
                    Ok((created, state)) => {
                        transport = Some(created);
                        wire::MoonrakerTransportReply::State(state)
                    }
                    Err(fault) => wire::MoonrakerTransportReply::Refused(fault),
                };
                assert_eq!(
                    wire::encode_moonraker_transport_reply(&reply).unwrap(),
                    text(&record["reply"]),
                    "{label}"
                );
                counts[1] += 1;
                continue;
            }
            let t = transport.as_mut().unwrap();
            let step = match kind.as_str() {
                "credentials" | "clearCredentials" => {
                    let refused = if kind == "credentials" {
                        t.set_credentials(
                            &wire::decode_moonraker_credentials(text(value)).unwrap(),
                            now,
                        )
                        .err()
                    } else {
                        t.clear_credentials(now);
                        None
                    };
                    let expected = record.get("refused").map(|r| text(r).to_owned());
                    assert_eq!(
                        refused.map(|f| wire::encode_moonraker_transport_fault(&f).unwrap()),
                        expected,
                        "{label}"
                    );
                    let (api_key, bearer) = t.credential_metadata();
                    assert_eq!(
                        (api_key, bearer),
                        (
                            record["hasApiKey"].as_bool().unwrap(),
                            record["hasBearerToken"].as_bool().unwrap()
                        ),
                        "{label}"
                    );
                    counts[1] += 1;
                    continue;
                }
                "subscription" => {
                    let entries = (!value.is_null())
                        .then(|| wire::decode_moonraker_object_subscription(text(value)).unwrap());
                    match t.set_subscription(entries.as_deref(), now) {
                        Ok(step) => Ok(step),
                        Err(fault) => {
                            assert_eq!(
                                wire::encode_moonraker_transport_fault(&fault).unwrap(),
                                text(&record["refused"]),
                                "{label}"
                            );
                            counts[2] += 1;
                            continue;
                        }
                    }
                }
                "connect" => Ok(t.connect(signal(&value["signal"]), now)),
                "disconnect" => Ok(t.disconnect(reason(value), now)),
                "dispose" => Ok(t.dispose(now)),
                "request" => {
                    Ok(t.request(&wire::decode_moonraker_request(text(value)).unwrap(), now))
                }
                "upload" => {
                    Ok(t.upload(&wire::decode_moonraker_request(text(value)).unwrap(), now))
                }
                "download" => {
                    Ok(t.download(&wire::decode_moonraker_request(text(value)).unwrap(), now))
                }
                "recovery" => Ok(t.recovery(
                    &wire::decode_moonraker_recovery_request(text(value)).unwrap(),
                    now,
                )),
                "abort" => Ok(t.abort(value.as_u64().unwrap(), now)),
                "resolve" => t
                    .resolve(
                        value["id"].as_u64().unwrap(),
                        wire::decode_moonraker_transport_outcome(text(&value["outcome"])).unwrap(),
                        now,
                    )
                    .map_err(|r| r.code()),
                "text" => t
                    .resolve_text(value["id"].as_u64().unwrap(), text(&value["text"]), now)
                    .map_err(|r| r.code()),
                "socketOpen" => Ok(t.socket_open(value.as_u64().unwrap(), now)),
                "socketError" => Ok(t.socket_error(value.as_u64().unwrap(), now)),
                "socketClose" => Ok(t.socket_close(value.as_u64().unwrap(), now)),
                "socketMessage" => Ok(t.socket_message(
                    value["socket"].as_u64().unwrap(),
                    text(&value["text"]),
                    now,
                )),
                "timer" => Ok(t.timer(value.as_u64().unwrap(), now)),
                other => panic!("unknown input {other}"),
            };
            match step {
                Ok(step) => {
                    assert_eq!(
                        wire::encode_moonraker_transport_step(&step).unwrap(),
                        text(&record["step"]),
                        "{label}"
                    );
                    // Result and params texts leave beside the step, each once.
                    let mut results = Vec::new();
                    for finished in &step.finished {
                        if let wire::MoonrakerTaskResult::Result(result) = &finished.result {
                            let taken = t.take_result(finished.task).unwrap();
                            assert_eq!(taken.encode_utf16().count() as u64, result.units);
                            assert_eq!(t.take_result(finished.task), None, "{label}");
                            results
                                .push(serde_json::json!({ "task": finished.task, "text": taken }));
                        }
                    }
                    let mut params = Vec::new();
                    for output in &step.outputs {
                        if let wire::MoonrakerTransportOutput::Notification(n) = output {
                            params.push(Json::String(t.take_params(n.id).unwrap()));
                            assert_eq!(t.take_params(n.id), None, "{label}");
                        }
                    }
                    let expected = |key: &str| {
                        record
                            .get(key)
                            .and_then(Json::as_array)
                            .cloned()
                            .unwrap_or_default()
                    };
                    assert_eq!(results, expected("results"), "{label} (results)");
                    assert_eq!(params, expected("params"), "{label} (params)");
                    counts[4] += results.len() + params.len();
                    assert_eq!(
                        wire::encode_moonraker_connection_state(&t.state()).unwrap(),
                        text(&record["state"]),
                        "{label} (state)"
                    );
                    counts[0] += 1;
                }
                Err(code) => {
                    assert_eq!(code, text(&record["refused"]), "{label}");
                    counts[2] += 1;
                }
            }
        }
        counts[3] += 1;
    }
    assert_eq!(counts, [2533, 94, 20, 88, 64]);
}
