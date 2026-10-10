//! One-plate slice projection and plate print overrides against the browser's
//! (`plate-projection-vectors.json`), byte for byte.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ids::{AssetId, PlateId},
    model::*,
    slicing::plate::*,
    validation::*,
};
use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet};

fn corpus(name: &str) -> Json {
    let text = match name {
        "plate" => {
            include_str!("../../../../testdata/cross-platform/plate-projection-vectors.json")
        }
        _ => include_str!("../../../../testdata/cross-platform/project-model-vectors.json"),
    };
    serde_json::from_str(text).unwrap()
}
/// The model corpus's states, by the names the plate corpus gives them.
fn sources() -> BTreeMap<String, String> {
    let model = corpus("model");
    model["factories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            (
                format!("factory:{}", each["seed"]),
                each["stateJson"].as_str().unwrap().to_owned(),
            )
        })
        .chain(model["cases"].as_array().unwrap().iter().map(|each| {
            (
                format!("case:{}", each["name"].as_str().unwrap()),
                each["stateJson"].as_str().unwrap().to_owned(),
            )
        }))
        .collect()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn canonical(value: &impl Encode) -> String {
    let mut bytes = Vec::new();
    value.write_json(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn canonical_value(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn units(json: &Json) -> Vec<u16> {
    match parse(json.as_str().unwrap()).unwrap() {
        Value::String(units) => units,
        other => panic!("not a string: {other:?}"),
    }
}
fn asset_ids(json: &Json) -> BTreeSet<AssetId> {
    let Value::Array(items) = parse(json.as_str().unwrap()).unwrap() else {
        panic!("not an array");
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(units) => AssetId::try_from_utf16(units).unwrap(),
            other => panic!("not an ID: {other:?}"),
        })
        .collect()
}

#[test]
fn a_plate_projects_and_overrides_as_the_browser_does() {
    let vectors = corpus("plate");
    let named = sources();
    let cases = vectors["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    let mut outcomes = BTreeMap::<String, usize>::new();
    for case in cases {
        let source = case["source"].as_str().unwrap();
        let text = case["sourceJson"]
            .as_str()
            .map_or_else(|| named[source].clone(), str::to_owned);
        let state = ProjectState::from_value(parse(&text).unwrap()).unwrap();
        let plate_id: PlateId = match case["plateIndex"].as_u64() {
            Some(index) => state.plates[index as usize].id.clone(),
            None => PlateId::try_from_utf16(units(&case["plateIdJson"])).unwrap(),
        };
        let omitted = case
            .get("omittedJson")
            .map_or_else(BTreeSet::new, asset_ids);
        let label = format!("{source} {:?}", case["plateIndex"]);
        let result = &case["result"];
        match project_plate(&state, &plate_id, |id| !omitted.contains(id), &mut utc()) {
            Ok(projection) => {
                assert_eq!(
                    canonical(projection.project.state()),
                    result["stateJson"].as_str().unwrap(),
                    "{label}"
                );
                assert_eq!(
                    projection.source_hash(),
                    result["sourceHash"].as_str().unwrap(),
                    "{label}"
                );
                assert_eq!(
                    projection.assets.iter().cloned().collect::<BTreeSet<_>>(),
                    asset_ids(&result["assetIdsJson"]),
                    "{label}"
                );
                let order: Vec<Value> = projection
                    .assets
                    .iter()
                    .map(|id| Value::String(id.as_utf16().to_vec()))
                    .collect();
                assert_eq!(
                    parse(&canonical_value(&Value::Array(order))).unwrap(),
                    parse(result["assetIdsJson"].as_str().unwrap()).unwrap(),
                    "{label} asset order"
                );
                *outcomes.entry("projected".into()).or_default() += 1;
            }
            Err(error) => {
                let code = match error {
                    ProjectionError::UnknownPlate => "unknown-plate",
                    ProjectionError::PlateNotPrintable => "plate-not-printable",
                    ProjectionError::MissingAsset(_) => "missing-asset",
                    ProjectionError::Invalid(_) => "invalid",
                    other => panic!("{label}: unexpected {other}"),
                };
                assert_eq!(code, result["error"].as_str().unwrap(), "{label}");
                assert_eq!(
                    error.message(&plate_id),
                    units(&result["messageJson"]),
                    "{label} message"
                );
                *outcomes.entry(code.into()).or_default() += 1;
            }
        }
        let overrides: BTreeMap<Vec<u16>, Value> = plate_print_overrides(&state, &plate_id)
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect();
        assert_eq!(
            canonical_value(&Value::Object(overrides)),
            case["overridesJson"].as_str().unwrap(),
            "{label} overrides"
        );
    }
    assert_eq!(
        outcomes,
        BTreeMap::from([
            ("missing-asset".into(), 1),
            ("plate-not-printable".into(), 1),
            ("projected".into(), 16),
            ("unknown-plate".into(), 1),
        ])
    );
}

/// The state-document exchange both bindings expose answers each case as the
/// browser recorded it: the projected state's text, its hash and kept assets,
/// or the refusal's message; and the overrides byte for byte.
#[test]
fn the_binding_exchange_answers_every_case() {
    let vectors = corpus("plate");
    let named = sources();
    let mut checked = 0;
    for case in vectors["cases"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let text = case["sourceJson"]
            .as_str()
            .map_or_else(|| named[source].clone(), str::to_owned);
        let plate_id = match case["plateIndex"].as_u64() {
            Some(index) => {
                let state = ProjectState::from_value(parse(&text).unwrap()).unwrap();
                canonical_value(&Value::String(
                    state.plates[index as usize].id.as_utf16().to_vec(),
                ))
            }
            None => case["plateIdJson"].as_str().unwrap().to_owned(),
        };
        let omitted = case["omittedJson"].as_str().unwrap_or("[]");
        let answer = projection_json(&text, &plate_id, omitted, &mut utc()).unwrap();
        let Value::Object(answer) = parse(&answer).unwrap() else {
            panic!("not an object");
        };
        let get = |name: &str| answer[&name.encode_utf16().collect::<Vec<_>>()].clone();
        let result = &case["result"];
        match result["error"].as_str() {
            None => {
                assert_eq!(
                    get("stateJson"),
                    Value::String(
                        result["stateJson"]
                            .as_str()
                            .unwrap()
                            .encode_utf16()
                            .collect()
                    ),
                    "{source}"
                );
                assert_eq!(
                    get("sourceHash"),
                    Value::String(
                        result["sourceHash"]
                            .as_str()
                            .unwrap()
                            .encode_utf16()
                            .collect()
                    )
                );
                assert_eq!(
                    canonical_value(&get("assetIds")),
                    canonical_value(&parse(result["assetIdsJson"].as_str().unwrap()).unwrap())
                );
            }
            Some(code) => {
                let code = format!("plate_projection_{}", code.replace('-', "_"))
                    .replace("plate_not_printable", "not_printable");
                assert_eq!(get("error"), Value::String(code.encode_utf16().collect()));
                assert_eq!(get("message"), Value::String(units(&result["messageJson"])));
            }
        }
        assert_eq!(
            print_overrides_json(&text, &plate_id).unwrap(),
            case["overridesJson"].as_str().unwrap()
        );
        checked += 1;
    }
    assert_eq!(checked, 19);
}

#[test]
fn bookkeeping_keys_and_nulls_are_not_print_configuration() {
    let model = corpus("model");
    let text = model["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|each| each["name"] == "minimal")
        .unwrap()["stateJson"]
        .as_str()
        .unwrap();
    let mut state = ProjectState::from_value(parse(text).unwrap()).unwrap();
    let key = |text: &str| text.encode_utf16().collect::<Vec<_>>();
    let config: BTreeMap<Vec<u16>, Value> = BTreeMap::from([
        (key("plater_id"), Value::Number(3.0)),
        (key("locked"), Value::Bool(true)),
        (key("layer_height"), Value::Number(0.28)),
        (key("gone"), Value::Null),
        (
            key("colours"),
            Value::Array(vec![Value::Null, Value::String(key("#fff"))]),
        ),
    ]);
    let mut plate = (*state.plates[0]).clone();
    plate.config = JsonObject::new(Value::Object(config)).unwrap();
    let plate_id = plate.id.clone();
    state.plates = vec![std::sync::Arc::new(plate)].into();
    let overrides = plate_print_overrides(&state, &plate_id);
    assert_eq!(
        overrides,
        BTreeMap::from([
            (key("colours"), key("null,#fff")),
            (key("layer_height"), key("0.28"))
        ])
    );
}
