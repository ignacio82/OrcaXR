//! The printer directory against the production browser
//! (`printer-directory-vectors.mjs`): every load, save and edit must be the
//! browser's, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::directory;
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn the_directory_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-directory-vectors.json"
    ))
    .unwrap();
    let section = |name: &str| corpus[name].as_array().unwrap().clone();
    let reply = |answer: wire::PrinterDirectoryReply, case: &Json, label: &str| {
        let actual = wire::encode_printer_directory_reply(&answer).unwrap();
        assert_eq!(actual, text(&case["replyJson"]), "{label} {case}");
    };
    for case in &section("loads") {
        let loaded = directory::load(case["stored"].as_str());
        let actual = wire::encode_printer_directory(&loaded).unwrap();
        assert_eq!(actual, text(&case["replyJson"]), "load {case}");
    }
    for case in &section("saves") {
        let request = wire::decode_printer_directory(text(&case["requestJson"])).unwrap();
        let stored = String::from_utf16(&directory::save(&request)).unwrap();
        assert_eq!(stored, text(&case["stored"]), "save {case}");
    }
    for case in &section("adds") {
        let request = wire::decode_printer_directory_add(text(&case["requestJson"])).unwrap();
        reply(directory::add(&request), case, "add");
    }
    for case in &section("updates") {
        let request = wire::decode_printer_directory_update(text(&case["requestJson"])).unwrap();
        reply(directory::update(&request), case, "update");
    }
    for case in &section("removes") {
        let request = wire::decode_printer_directory_select(text(&case["requestJson"])).unwrap();
        reply(directory::remove(&request), case, "remove");
    }
    for case in &section("defaults") {
        let request = wire::decode_printer_directory_select(text(&case["requestJson"])).unwrap();
        reply(directory::set_default(&request), case, "default");
    }
    for case in &section("adopts") {
        let request = wire::decode_printer_directory_adopt(text(&case["requestJson"])).unwrap();
        let actual = wire::encode_printer_directory(&directory::adopt(&request)).unwrap();
        assert_eq!(actual, text(&case["replyJson"]), "adopt {case}");
    }
    let counts: Vec<usize> = [
        "loads", "saves", "adds", "updates", "removes", "defaults", "adopts",
    ]
    .iter()
    .map(|name| section(name).len())
    .collect();
    assert_eq!(counts, [37, 25, 160, 60, 44, 41, 15]);
}
