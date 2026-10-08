use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::AssetRepository,
    mesh,
    model::*,
    slicing::{preflight::*, profile::*},
    validation::*,
};
use serde_json::Value as Json;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-profile-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    fields.get(&name.encode_utf16().collect::<Vec<_>>())
}
fn text(value: Option<&Value>) -> Option<Text> {
    match value {
        Some(Value::String(units)) => Some(Text::new(units.clone())),
        _ => None,
    }
}
fn profile(value: &Value) -> Option<Profile> {
    if matches!(value, Value::Null) {
        return None;
    }
    let Some(Value::Object(config)) = field(value, "config") else {
        panic!("profile config")
    };
    Some(Profile {
        machine_preset_id: text(field(value, "machinePresetId")),
        process_preset_id: text(field(value, "processPresetId")),
        filament_preset_id: text(field(value, "filamentPresetId")),
        config: config
            .iter()
            .map(|(k, v)| match v {
                Value::String(v) => (k.clone(), v.clone()),
                _ => panic!("wire strings"),
            })
            .collect(),
    })
}
fn target(json: &str) -> Target {
    let value = parse(json).unwrap();
    let Some(Value::Number(tool_count)) = field(&value, "toolCount") else {
        panic!()
    };
    let Some(Value::Array(filaments)) = field(&value, "filaments") else {
        panic!()
    };
    Target {
        primary: profile(field(&value, "primary").unwrap()),
        filaments: filaments.iter().map(profile).collect(),
        tool_count: *tool_count,
        source: match text(field(&value, "source")).unwrap().units() {
            u if u == "catalog".encode_utf16().collect::<Vec<_>>() => Source::Catalog,
            _ => Source::AuthoredProject,
        },
    }
}
fn canonical(value: Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn state(json: &Json) -> ProjectState {
    ProjectState::from_value(parse(json["stateJson"].as_str().unwrap()).unwrap()).unwrap()
}

#[test]
fn derivations_match_the_browser_reference() {
    let f = corpus();
    let cases = f["derivations"].as_array().unwrap();
    for case in cases {
        let target = target(case["targetJson"].as_str().unwrap());
        assert_eq!(
            canonical(target.to_value()),
            case["targetJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        let derived = derive(&target, 64).unwrap();
        assert_eq!(
            canonical(derived.to_value()),
            case["derivationJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        // Every derived constraint set is one preflight accepts.
        derived.constraints.validate().unwrap();
    }
    assert_eq!(cases.len(), 31);
}

#[test]
fn authored_targets_come_from_canonical_state_alone() {
    let f = corpus();
    let cases = f["authored"].as_array().unwrap();
    for case in cases {
        let target = authored_target(&state(case), 64).unwrap();
        assert_eq!(
            canonical(target.to_value()),
            case["targetJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            canonical(derive(&target, 64).unwrap().to_value()),
            case["derivationJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    assert_eq!(cases.len(), 5);
}

#[test]
fn attestation_errors_merge_into_the_canonical_result() {
    let f = corpus();
    let cases = f["attestations"].as_array().unwrap();
    for case in cases {
        let state = state(case);
        let plate = state.active_plate_id.clone();
        let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
        let mut repository = AssetRepository::new();
        for asset in case["assets"].as_array().unwrap() {
            let bytes: Vec<u8> = asset["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            repository
                .put(
                    &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                    &bytes,
                )
                .unwrap();
        }
        let limits = Limits {
            mesh: mesh::Limits {
                asset_bytes: 1 << 20,
                vertices: 1 << 16,
                indices: 1 << 16,
            },
            assets: 4,
            vertex_visits: 1 << 16,
        };
        let (result, _) = preflight_target(
            &project,
            &repository.capture_internal(),
            &plate,
            &target(case["targetJson"].as_str().unwrap()),
            limits,
            64,
            || false,
        )
        .unwrap();
        assert_eq!(
            canonical(result.to_value()),
            case["resultJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    assert_eq!(cases.len(), 4);
}

#[test]
fn wire_delimiters_and_tool_budgets_match_the_reference() {
    let f = corpus();
    let mut keys = STRING_VECTOR_KEYS.to_vec();
    keys.sort_unstable();
    assert_eq!(serde_json::to_value(&keys).unwrap(), f["stringVectorKeys"]);
    let mut target = target(f["derivations"][0]["targetJson"].as_str().unwrap());
    target.tool_count = 65.0;
    assert_eq!(derive(&target, 64), Err(Error::Limits));
    target.tool_count = 64.0;
    assert_eq!(derive(&target, 64).unwrap().constraints.tools.len(), 64);
    let mut state = state(&f["authored"][0]);
    state.printer.tool_count = Number::new(1e9).unwrap();
    assert_eq!(authored_target(&state, 64), Err(Error::Limits));
}
