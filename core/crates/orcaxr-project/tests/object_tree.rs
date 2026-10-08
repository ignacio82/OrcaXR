//! The Objects tree against the production browser (`object-tree-vectors.mjs`):
//! every page, selection and refusal the browser answered, byte for byte, with
//! non-ASCII search text folded as the browser folded it.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    model::{Decode, ProjectState},
    objects_tree::answer,
    settings::editor::SearchFolding,
};
use serde_json::Value as Json;
use std::collections::HashMap;

/// The browser's folding of every non-ASCII text it folded.
struct TableFolding(HashMap<Vec<u16>, Vec<u16>>);
impl SearchFolding for TableFolding {
    type Error = ();
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, ()> {
        Ok(self
            .0
            .get(text)
            .unwrap_or_else(|| panic!("no folding for {:?}", String::from_utf16_lossy(text)))
            .clone())
    }
}
fn units(value: &Json) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}

#[test]
fn objects_tree_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/object-tree-vectors.json"
    ))
    .unwrap();
    let mut folding = TableFolding(
        corpus["foldings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| (units(&pair[0]), units(&pair[1])))
            .collect(),
    );
    let states: Vec<(String, ProjectState)> = corpus["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let state = ProjectState::from_value(parse(s["stateJson"].as_str().unwrap()).unwrap());
            (s["name"].as_str().unwrap().to_owned(), state.unwrap())
        })
        .collect();
    let (mut pages, mut selections, mut ignored, mut refused) = (0, 0, 0, 0);
    for (n, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let (name, state) = &states[case["state"].as_u64().unwrap() as usize];
        let request =
            wire::decode_object_tree_request(case["requestJson"].as_str().unwrap()).unwrap();
        match (answer(state, &request, &mut folding), case.get("replyJson")) {
            (Ok(reply), Some(expected)) => {
                assert_eq!(
                    wire::encode_object_tree_reply(&reply).unwrap(),
                    expected.as_str().unwrap(),
                    "{name} case {n}: {}",
                    case["requestJson"]
                );
                match reply {
                    wire::ObjectTreeReply::Page(_) => pages += 1,
                    wire::ObjectTreeReply::Selected(_) => selections += 1,
                    wire::ObjectTreeReply::Ignored(_) => ignored += 1,
                }
            }
            (Err(refusal), None) => {
                assert_eq!(
                    refusal.code(),
                    case["refusal"].as_str().unwrap(),
                    "{name} case {n}"
                );
                refused += 1;
            }
            (outcome, _) => panic!("{name} case {n}: {outcome:?} against {case}"),
        }
    }
    assert_eq!((pages, selections, ignored, refused), (751, 1148, 48, 10));
}
