//! The print submission workflow against the production browser
//! (`printer-workflow-vectors.mjs`): every recorded input, fed in order, must
//! produce the browser's step byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::workflow::{PrintWorkflow, Refusal};
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

/// Apply one recorded input; the encoded step, or the refusal's code.
fn apply(flow: &mut PrintWorkflow, input: &Json) -> Result<String, &'static str> {
    let (kind, value) = input.as_object().unwrap().iter().next().unwrap();
    let id = || value["id"].as_u64().unwrap();
    let step = match kind.as_str() {
        "run" => flow.run(wire::decode_print_workflow_intent(text(value)).unwrap()),
        "stored" => flow.start_stored(&wire::decode_printer_text(text(value)).unwrap().text),
        "resolve" => flow.resolve(
            id(),
            wire::decode_print_workflow_outcome(text(&value["outcome"])).unwrap(),
        ),
        "reply" => flow.resolve_reply(id(), text(&value["text"])),
        "cancel" => Ok(flow.cancel()),
        "dispose" => Ok(flow.dispose()),
        other => panic!("unknown input {other}"),
    };
    step.map(|step| wire::encode_print_workflow_step(&step).unwrap())
        .map_err(Refusal::code)
}

#[test]
fn print_workflow_steps_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-workflow-vectors.json"
    ))
    .unwrap();
    let scenarios = corpus["scenarios"].as_array().unwrap();
    let mut steps = 0;
    let mut refusals = 0;
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut flow = PrintWorkflow::new();
        for (i, record) in scenario["records"].as_array().unwrap().iter().enumerate() {
            match apply(&mut flow, &record["input"]) {
                Ok(step) => assert_eq!(
                    step,
                    text(&record["step"]),
                    "{name}, input {i}: {}",
                    record["input"]
                ),
                Err(message) => {
                    assert_eq!(message, text(&record["refused"]), "{name}, input {i}");
                    refusals += 1;
                }
            }
            steps += 1;
        }
        assert!(!flow.busy(), "{name} ends with nothing running");
    }
    assert_eq!((scenarios.len(), steps, refusals), (402, 19688, 13));
    // The recorder checked the browser's own words for a refused send.
    assert_eq!(
        Refusal::Unavailable.message(),
        "A send is unavailable or already pending."
    );
}
