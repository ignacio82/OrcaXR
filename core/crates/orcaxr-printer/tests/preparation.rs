//! Print preparation and submission checks against the production browser
//! (`printer-preparation-vectors.mjs`), byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::preparation as p;
use serde_json::Value as Json;

fn cases<'a>(corpus: &'a Json, section: &str) -> &'a Vec<Json> {
    corpus[section].as_array().unwrap()
}
fn text(case: &Json, key: &str) -> String {
    case[key].as_str().unwrap().to_owned()
}

#[test]
fn printer_preparation_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-preparation-vectors.json"
    ))
    .unwrap();
    for (i, case) in cases(&corpus, "capabilities").iter().enumerate() {
        let body = text(case, "text");
        let reply = match case["kind"].as_str().unwrap() {
            "objects" => p::printer_objects(&body),
            "components" => p::server_components(&body),
            _ => p::gcode_commands(&body),
        };
        assert_eq!(
            wire::encode_optional_text_list(&reply).unwrap(),
            text(case, "replyJson"),
            "capability {i} {}: {body}",
            case["kind"]
        );
    }
    let check = |section: &str, answer: &dyn Fn(&Json) -> String| {
        for (i, case) in cases(&corpus, section).iter().enumerate() {
            assert_eq!(
                answer(case),
                text(case, "replyJson"),
                "{section} {i}: {case}"
            );
        }
        cases(&corpus, section).len()
    };
    let counts = [
        check("options", &|c| {
            let report = wire::decode_printer_capability_report(&text(c, "requestJson")).unwrap();
            wire::encode_print_start_options(&p::start_options(&report)).unwrap()
        }),
        check("plans", &|c| {
            let request =
                wire::decode_print_preparation_plan_request(&text(c, "requestJson")).unwrap();
            wire::encode_print_preparation_plan(&p::preparation_plan(&request)).unwrap()
        }),
        check("sends", &|c| {
            let step = wire::decode_print_preparation_step(&text(c, "requestJson")).unwrap();
            wire::encode_printer_send(&p::preparation_send(&step)).unwrap()
        }),
        check("readiness", &|c| {
            wire::encode_print_readiness(&p::readiness(&text(c, "text"))).unwrap()
        }),
        check("readinessFailures", &|c| {
            let request = wire::decode_print_readiness_failure(&text(c, "requestJson")).unwrap();
            wire::encode_print_readiness(&p::readiness_unavailable(&request)).unwrap()
        }),
        check("filenames", &|c| {
            let name = wire::decode_printer_text(&text(c, "requestJson")).unwrap();
            wire::encode_printer_text(&wire::PrinterText {
                text: p::sanitize_filename(&name.text),
            })
            .unwrap()
        }),
        check("failures", &|c| {
            let request = wire::decode_transport_failure(&text(c, "requestJson")).unwrap();
            wire::encode_printer_text(&wire::PrinterText {
                text: p::describe_failure(&request),
            })
            .unwrap()
        }),
        check("identities", &|c| {
            let name = wire::decode_printer_text(&text(c, "requestJson")).unwrap();
            wire::encode_print_file_identity_reply(&p::file_identity(&text(c, "text"), &name.text))
                .unwrap()
        }),
    ];
    assert_eq!(counts, [294, 110, 5, 221, 18, 20, 196, 14]);
    assert_eq!(cases(&corpus, "capabilities").len(), 51);
}
