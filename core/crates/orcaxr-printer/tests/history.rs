//! Print history against the production browser
//! (`printer-history-vectors.mjs`): every plan, finish, read, duration,
//! length, job, totals and page description must be the browser's, byte for
//! byte, and every job id the one the browser gave it.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::{history, reply, transport};
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}
/// A number the corpus spells as text when JSON cannot.
fn number(value: &Json) -> f64 {
    match value {
        Json::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            _ => f64::NEG_INFINITY,
        },
        number => number.as_f64().unwrap(),
    }
}
/// A page's job ids as the corpus records them: units (`,`) per id (`;`).
fn ids(result: &wire::PrintHistoryResult) -> String {
    let wire::PrintHistoryResult::Page(page) = result else {
        return String::new();
    };
    page.jobs
        .iter()
        .map(|job| {
            history::job_id(job)
                .iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join(";")
}

#[test]
fn print_history_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-history-vectors.json"
    ))
    .unwrap();
    let section = |name: &str| corpus[name].as_array().unwrap().clone();
    let check = |actual: String, case: &Json, label: &str| {
        assert_eq!(actual, text(&case["replyJson"]), "{label} {case}");
    };
    for case in &section("plans") {
        let op = wire::decode_print_history_operation(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_print_history_plan(&history::plan(&op)).unwrap(),
            case,
            "plan",
        );
    }
    for case in &section("finishes") {
        let request = wire::decode_print_history_finish(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_print_history_result(&history::finish(&request)).unwrap(),
            case,
            "finish",
        );
    }
    for case in &section("reads") {
        let op = wire::decode_print_history_operation(text(&case["operationJson"])).unwrap();
        let result = history::read(&op, text(&case["reply"]));
        assert_eq!(
            ids(&result),
            text(&case["ids"]),
            "ids {}",
            text(&case["reply"])
        );
        check(
            wire::encode_print_history_result(&result).unwrap(),
            case,
            "read",
        );
    }
    for case in &section("durations") {
        let seconds = number(&case["seconds"]);
        let answer = reply::optional_text(history::duration_text(seconds));
        check(
            wire::encode_optional_text(&answer).unwrap(),
            case,
            "duration",
        );
    }
    for case in &section("filaments") {
        let millimetres = number(&case["millimetres"]);
        let answer = reply::optional_text(history::filament_text(millimetres));
        check(
            wire::encode_optional_text(&answer).unwrap(),
            case,
            "filament",
        );
    }
    for case in &section("jobViews") {
        let job = wire::decode_print_history_job(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_print_history_job_view(&history::job_view(&job)).unwrap(),
            case,
            "job",
        );
    }
    for case in &section("totalsTexts") {
        let totals =
            wire::decode_optional_print_history_totals(text(&case["requestJson"])).unwrap();
        let answer = wire::PrinterText {
            text: history::totals_text(&totals).encode_utf16().collect(),
        };
        check(wire::encode_printer_text(&answer).unwrap(), case, "totals");
    }
    for case in &section("pageViews") {
        let shape = wire::decode_print_history_page_shape(text(&case["requestJson"])).unwrap();
        check(
            wire::encode_print_history_page_view(&history::page_view(&shape)).unwrap(),
            case,
            "page",
        );
    }
    let counts: Vec<usize> = [
        "plans",
        "finishes",
        "reads",
        "durations",
        "filaments",
        "jobViews",
        "totalsTexts",
        "pageViews",
    ]
    .iter()
    .map(|name| section(name).len())
    .collect();
    assert_eq!(counts, [290, 1363, 258, 55, 55, 76, 23, 39]);
}

#[test]
fn any_reply_the_transport_admits_crosses_a_binding() {
    let page = wire::PrintHistoryOperation::Page(wire::PrintHistoryPageRequest {
        start: wire::OptionalFinite::Absent(wire::Empty {}),
        limit: wire::OptionalFinite::Value(history::MAX_PAGE),
    });
    // A page of the widest text a reply can carry: ids, names and outcomes
    // of their own, filling the transport's bound.
    let wide = |units: usize| "\u{ffff}".repeat(units);
    for jobs in [1, 100] {
        let each = (transport::MAX_TEXT_UNITS - 64) / jobs / 3 - 64;
        let job = format!(
            r#"{{"job_id":"{}","filename":"{}","status":"{}x","start_time":1}}"#,
            wide(each),
            wide(each),
            wide(each)
        );
        let reply = format!(r#"{{"count":1,"jobs":[{}]}}"#, vec![job; jobs].join(","));
        assert!(reply.encode_utf16().count() <= transport::MAX_TEXT_UNITS);
        let result = history::read(&page, &reply);
        let json = wire::encode_print_history_result(&result).expect("within the bulk tier");
        assert_eq!(wire::decode_print_history_result(&json).unwrap(), result);
        let wire::PrintHistoryResult::Page(read) = result else {
            panic!("a page");
        };
        assert_eq!(read.jobs.len(), jobs);
        // Each job's view, its outcome quoting the printer's own word.
        for job in &read.jobs {
            let input = wire::encode_print_history_job(job).unwrap();
            assert!(input.len() <= wire::BULK.bytes);
            let view = history::job_view(&wire::decode_print_history_job(&input).unwrap());
            assert!(view.status.len() > each);
            wire::encode_print_history_job_view(&view).expect("within the bulk tier");
        }
    }
}
