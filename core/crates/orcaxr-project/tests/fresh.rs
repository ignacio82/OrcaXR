//! The project a session starts with and the one "New project" replaces it
//! with, against the browser's (`project-fresh-vectors.json`).
use orcaxr_contracts::canonical::parse;
use orcaxr_project::ids::{RandomWordSource, UuidIdSource};
use orcaxr_project::model::*;
use serde_json::Value as Json;

fn fixture(name: &str) -> Json {
    let text = match name {
        "fresh" => include_str!("../../../../testdata/cross-platform/project-fresh-vectors.json"),
        _ => include_str!("../../../../testdata/cross-platform/project-model-vectors.json"),
    };
    serde_json::from_str(text).unwrap()
}
fn canonical(value: &impl Encode) -> String {
    let mut bytes = Vec::new();
    value.write_json(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
/// The recorded words, in order, as the browser's UUID source drew them.
fn words(case: &Json) -> impl RandomWordSource {
    let mut words = case["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_f64().unwrap())
        .collect::<Vec<_>>()
        .into_iter();
    move || words.next().expect("every recorded word is drawn")
}

#[test]
fn a_session_starts_with_the_browsers_empty_project() {
    let corpus = fixture("fresh");
    for case in corpus["empty"].as_array().unwrap() {
        let mut ids = UuidIdSource::new(words(case));
        let state = empty_project(
            &mut ids,
            Text::from_utf8(case["now"].as_str().unwrap()),
            None,
            None,
            None,
        );
        assert_eq!(canonical(&state), case["stateJson"].as_str().unwrap());
    }
}

#[test]
fn new_project_keeps_the_printer_profile_and_physical_tools_as_the_browser_does() {
    let corpus = fixture("fresh");
    let model = fixture("model");
    let source = |name: &str| -> String {
        let (kind, key) = name.split_once(':').unwrap();
        let list = if kind == "factory" {
            &model["factories"]
        } else {
            &model["cases"]
        };
        list.as_array()
            .unwrap()
            .iter()
            .find(|each| {
                if kind == "factory" {
                    each["seed"]
                        .as_f64()
                        .is_some_and(|seed| seed.to_string() == key)
                } else {
                    each["name"] == key
                }
            })
            .unwrap()["stateJson"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let cases = corpus["fresh"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for case in cases {
        let text = match case["sourceJson"].as_str() {
            Some(embedded) => embedded.to_owned(),
            None => source(case["source"].as_str().unwrap()),
        };
        let current = ProjectState::from_value(parse(&text).unwrap()).unwrap();
        let mut ids = UuidIdSource::new(words(case));
        let state = fresh_project(
            &current,
            &mut ids,
            Text::from_utf8(case["now"].as_str().unwrap()),
        );
        assert_eq!(
            canonical(&state),
            case["stateJson"].as_str().unwrap(),
            "{}",
            case["source"]
        );
    }
}
