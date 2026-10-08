use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    facets::palette::{Entry, project_palette},
    model::{Decode, Filaments},
};
use std::collections::BTreeMap;

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/paint-palette-vectors.json"
    ))
    .unwrap()
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn string(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (units(k), v)))
            .collect::<BTreeMap<_, _>>(),
    )
}
fn entry(e: &Entry) -> Value {
    object(vec![
        ("filamentId", e.filament_id.as_deref().map(string)),
        ("kind", Some(string(&units(e.kind.as_str())))),
        ("name", Some(string(&e.name))),
        ("displayColor", Some(string(&e.display_color))),
        (
            "gradient",
            e.gradient
                .as_ref()
                .map(|g| Value::Array(g.iter().map(|s| string(s)).collect())),
        ),
        ("badge", Some(string(&e.badge))),
        ("recipeSummary", e.recipe_summary.as_deref().map(string)),
        (
            "keyboardNumber",
            e.keyboard_number.map(|n| Value::Number(f64::from(n))),
        ),
        ("engineSlot", e.engine_slot.map(|n| Value::Number(n as f64))),
        ("selectable", Some(Value::Bool(e.selectable))),
        (
            "unavailableReason",
            e.unavailable_reason.as_deref().map(string),
        ),
    ])
}

#[test]
fn palettes_match_the_browser() {
    let f = corpus();
    let mut checked = 0;
    for case in f["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let filaments =
            Filaments::from_value(parse(case["filamentsJson"].as_str().unwrap()).unwrap()).unwrap();
        for (i, include) in [false, true].into_iter().enumerate() {
            let p = project_palette(&filaments, include);
            let actual = object(vec![
                (
                    "entries",
                    Some(Value::Array(p.entries.iter().map(entry).collect())),
                ),
                (
                    "physicalCount",
                    Some(Value::Number(p.physical_count as f64)),
                ),
                (
                    "enabledMixedCount",
                    Some(Value::Number(p.enabled_mixed_count as f64)),
                ),
            ]);
            assert_eq!(
                canonical(&actual),
                case["palettes"][i].as_str().unwrap(),
                "{name} {include}"
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 310);
}
