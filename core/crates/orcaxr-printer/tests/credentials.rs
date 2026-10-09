//! Remembered credentials against the production browser
//! (`printer-credentials-vectors.mjs`): every stored record must load, and
//! every record save, as the browser's do, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::credentials;
use serde_json::Value as Json;

#[test]
fn remembered_credentials_answer_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-credentials-vectors.json"
    ))
    .unwrap();
    let loads = corpus["loads"].as_array().unwrap();
    for case in loads {
        let loaded = credentials::load(case["stored"].as_str());
        let actual = wire::encode_remembered_credentials(&loaded).unwrap();
        assert_eq!(actual, case["replyJson"].as_str().unwrap(), "load {case}");
    }
    let saves = corpus["saves"].as_array().unwrap();
    for case in saves {
        let record =
            wire::decode_remembered_credentials(case["requestJson"].as_str().unwrap()).unwrap();
        let stored = credentials::save(&record).map(|text| String::from_utf16(&text).unwrap());
        assert_eq!(stored.as_deref(), case["stored"].as_str(), "save {case}");
    }
    assert_eq!([loads.len(), saves.len()], [79, 63]);
}
