use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::settings::{
    SettingScope,
    editor::*,
    options::{DEFINITIONS, OptionValue, option_value},
    presets::{AsciiRootCollation, NonAsciiText},
};
use serde_json::{Value as Json, json};
use std::collections::HashMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/settings-editor-vectors.json"
    ))
    .unwrap()
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn utf16(units: &[u16]) -> String {
    String::from_utf16(units).unwrap()
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn value_json(value: &OptionValue) -> String {
    canonical(&value.to_value())
}
fn values(json: &Value) -> ValueMap {
    let Value::Object(fields) = json else {
        panic!()
    };
    fields
        .iter()
        .map(|(k, v)| (k.clone(), option_value(v).unwrap()))
        .collect()
}
fn field_member<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    fields.get(&units(name))
}

/// The browser's folding: ASCII lowercases; other text as the corpus folded it.
struct TableFolding(HashMap<Vec<u16>, Vec<u16>>);
impl SearchFolding for TableFolding {
    type Error = NonAsciiText;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, NonAsciiText> {
        if text.iter().all(|u| *u < 0x80) {
            return Ok(AsciiFolding.fold(text).unwrap());
        }
        Ok(self
            .0
            .get(text)
            .unwrap_or_else(|| panic!("no folding for {:?}", utf16(text)))
            .clone())
    }
}
fn folding(f: &Json) -> TableFolding {
    TableFolding(
        f["foldings"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (units(k), units(v.as_str().unwrap())))
            .collect(),
    )
}
const SURFACES: [Option<Surface>; 6] = [
    None,
    Some(Surface::Process),
    Some(Surface::Filament),
    Some(Surface::Printer),
    Some(Surface::Object),
    Some(Surface::Plate),
];
fn surface(name: &str) -> Surface {
    SURFACES
        .iter()
        .flatten()
        .copied()
        .find(|s| s.as_str() == name)
        .unwrap()
}
fn mode(name: &str) -> Mode {
    [Mode::Simple, Mode::Advanced, Mode::Develop]
        .into_iter()
        .find(|m| m.as_str() == name)
        .unwrap()
}
fn requested(name: &str) -> Requested {
    match name {
        "fff" => Requested::Fff,
        "sla" => Requested::Sla,
        "any" => Requested::Any,
        other => panic!("{other}"),
    }
}
fn scope(name: &str) -> SettingScope {
    SettingScope::from_utf16(&units(name)).unwrap()
}
/// A JSON number as JavaScript writes it: integral values without a fraction.
fn number(n: f64) -> Json {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn support_text(support: &Support) -> String {
    match support {
        Support::Implemented => String::new(),
        Support::Unavailable(reason) => reason.clone(),
    }
}

#[test]
fn field_projections_match_the_browser() {
    let f = corpus();
    let projections = f["projections"].as_array().unwrap();
    assert_eq!(projections.len(), DEFINITIONS.len());
    for p in projections {
        let index = p["index"].as_u64().unwrap() as usize;
        let field = project_field(index, Requested::Any, None);
        let label = DEFINITIONS[index].key;
        assert_eq!(utf16(&field.label), p["label"].as_str().unwrap(), "{label}");
        assert_eq!(
            field.full_label.as_deref().map(utf16).as_deref(),
            p["fullLabel"].as_str()
        );
        assert_eq!(utf16(&field.category), p["category"].as_str().unwrap());
        assert_eq!(
            field.tooltip.as_deref().map(utf16).as_deref(),
            p["tooltip"].as_str()
        );
        assert_eq!(
            field.unit.as_deref().map(utf16).as_deref(),
            p["unit"].as_str()
        );
        assert_eq!(field.mode.as_str(), p["mode"].as_str().unwrap());
        assert_eq!(field.technology.as_str(), p["technology"].as_str().unwrap());
        assert_eq!(json!(field.locations), p["locations"], "{label}");
        for (i, surface) in SURFACES.iter().enumerate() {
            let projected = project_field(index, Requested::Any, *surface);
            assert_eq!(
                json!(projected.primary),
                p["primary"][i],
                "{label} {surface:?}"
            );
            assert_eq!(
                support_text(&projected.support),
                p["support"][i].as_str().unwrap(),
                "{label} {surface:?}"
            );
        }
        for (i, technology) in [Requested::Fff, Requested::Sla, Requested::Any]
            .into_iter()
            .enumerate()
        {
            assert_eq!(
                project_field(index, technology, None)
                    .applicability
                    .as_str(),
                p["applicability"][i].as_str().unwrap()
            );
        }
    }
}

#[test]
fn field_queries_match_the_browser() {
    let f = corpus();
    let mut folding = folding(&f);
    for case in f["queryCases"].as_array().unwrap() {
        let q: Json = serde_json::from_str(case["queryJson"].as_str().unwrap()).unwrap();
        let query = Query {
            mode: mode(q["mode"].as_str().unwrap()),
            technology: requested(q["technology"].as_str().unwrap()),
            surface: q["guiSurface"].as_str().map(surface),
            scope: q["scope"].as_str().map(scope),
            search: units(q["search"].as_str().unwrap_or("")),
            include_non_applicable: q["includeNonApplicable"].as_bool().unwrap_or(false),
            include_unknown_applicability: q["includeUnknownApplicability"]
                .as_bool()
                .unwrap_or(false),
            include_unavailable: q["includeUnavailable"].as_bool().unwrap_or(true),
        };
        let fields = query_fields(&query, &mut AsciiRootCollation, &mut folding).unwrap();
        let expected = case["fields"].as_array().unwrap();
        assert_eq!(fields.len(), expected.len(), "{q}");
        for (field, e) in fields.iter().zip(expected) {
            if q.get("search").is_some() {
                assert_eq!(json!(field.index), e[0], "{q}");
                let matches: Vec<Json> = field
                    .matches
                    .iter()
                    .map(|m| json!([m.field.as_str(), m.start, m.length, utf16(&m.text)]))
                    .collect();
                assert_eq!(json!(matches), e[1], "{q} {}", field.definition().key);
            } else {
                assert_eq!(json!(field.index), *e, "{q}");
            }
        }
    }
}

fn state_json(s: &FieldState) -> Json {
    let mut out = json!({
        "field": s.field.index,
        "origin": s.origin.as_str(),
        "hasLocalOverride": s.has_local_override,
        "changed": s.changed,
        "draftChanged": s.draft_changed,
        "issues": s.issues.iter().map(|i| json!({"code": i.code, "path": i.path, "message": utf16(&i.message)})).collect::<Vec<_>>(),
    });
    let o = out.as_object_mut().unwrap();
    if let Some(v) = &s.value {
        o.insert("valueJson".into(), json!(value_json(v)));
    }
    if let Some(t) = &s.serialized {
        o.insert("serialized".into(), json!(utf16(t)));
    }
    if let Some(t) = &s.draft_raw {
        o.insert("draftRaw".into(), json!(utf16(t)));
    }
    if let Some(v) = &s.draft_value {
        o.insert("draftValueJson".into(), json!(value_json(v)));
    }
    if let Some(t) = &s.draft_serialized {
        o.insert("draftSerialized".into(), json!(utf16(t)));
    }
    out
}
fn comparison_json(c: &Comparison, index: usize) -> Json {
    let mut out = json!({
        "field": index,
        "effectiveEqualsDefault": c.effective_equals_default,
        "draftEqualsEffective": c.draft_equals_effective,
    });
    let o = out.as_object_mut().unwrap();
    for (name, value) in [
        ("defaultJson", &c.default),
        ("inheritedJson", &c.inherited),
        ("overrideJson", &c.overridden),
        ("effectiveJson", &c.effective),
        ("draftJson", &c.draft),
    ] {
        if let Some(v) = value {
            o.insert(name.into(), json!(value_json(v)));
        }
    }
    out
}
fn overrides_json(map: &ValueMap) -> String {
    canonical(&Value::Object(
        map.iter().map(|(k, v)| (k.clone(), v.to_value())).collect(),
    ))
}
fn error_json<E>(e: &EditorError<E>) -> Json {
    let mut out = json!({ "error": utf16(&e.message()) });
    if let EditorError::Invalid(issues) = e {
        out["issues"] = json!(
            issues
                .iter()
                .map(|i| json!({"code": i.code, "path": i.path, "message": utf16(&i.message)}))
                .collect::<Vec<_>>()
        );
    }
    out
}

#[test]
fn draft_editors_match_the_browser() {
    let f = corpus();
    for scenario in f["editors"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let options = parse(scenario["optionsJson"].as_str().unwrap()).unwrap();
        let text = |key: &str| match field_member(&options, key) {
            Some(Value::String(t)) => Some(utf16(t)),
            _ => None,
        };
        let created = DraftEditor::new::<NonAsciiText>(
            text("mode").map_or(Mode::Advanced, |m| mode(&m)),
            text("technology").map_or(Requested::Fff, |t| requested(&t)),
            text("guiSurface").map(|s| surface(&s)),
            text("scope").map(|s| scope(&s)),
            field_member(&options, "inherited").map_or_else(ValueMap::new, values),
            field_member(&options, "overrides").map_or_else(ValueMap::new, values),
        );
        let mut editor = match created {
            Err(e) => {
                assert_eq!(
                    utf16(&e.message()),
                    scenario["error"].as_str().unwrap(),
                    "{name}"
                );
                continue;
            }
            Ok(editor) => {
                assert!(scenario.get("error").is_none(), "{name}");
                editor
            }
        };
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {index}");
            let s: Json = serde_json::from_str(step["stepJson"].as_str().unwrap()).unwrap();
            let id = s["field"].as_str().unwrap_or("");
            let raw = units(s["raw"].as_str().unwrap_or(""));
            let position = field_index(id).unwrap_or(usize::MAX);
            let actual: Json = match s["op"].as_str().unwrap() {
                "state" => editor
                    .field_state::<NonAsciiText>(id)
                    .map_or_else(|e| error_json(&e), |v| json!({ "ok": state_json(&v) })),
                "compare" => editor.compare::<NonAsciiText>(id).map_or_else(
                    |e| error_json(&e),
                    |v| json!({ "ok": comparison_json(&v, position) }),
                ),
                "set" => editor
                    .set_draft::<NonAsciiText>(id, &raw)
                    .map_or_else(|e| error_json(&e), |_| json!({ "ok": null })),
                "clear" => editor
                    .clear_draft::<NonAsciiText>(id)
                    .map_or_else(|e| error_json(&e), |_| json!({ "ok": null })),
                "inherit" => editor
                    .reset_to_inherited::<NonAsciiText>(id)
                    .map_or_else(|e| error_json(&e), |_| json!({ "ok": null })),
                "default" => editor
                    .reset_to_default::<NonAsciiText>(id)
                    .map_or_else(|e| error_json(&e), |_| json!({ "ok": null })),
                "commit" => match editor.commit(&mut AsciiRootCollation) {
                    Err(e) => error_json(&e),
                    Ok(c) => json!({ "ok": {
                        "baseRevision": c.base_revision,
                        "revision": c.revision,
                        "changes": c.changes.iter().map(|ch| match ch {
                            Change::Set { field_id, previous, value, serialized, .. } => {
                                let mut out = json!({
                                    "field": field_index(field_id).unwrap(),
                                    "action": "set",
                                    "valueJson": value_json(value),
                                    "serialized": utf16(serialized),
                                });
                                if let Some(p) = previous {
                                    out["previousJson"] = json!(value_json(p));
                                }
                                out
                            }
                            Change::Remove { field_id, previous, .. } => json!({
                                "field": field_index(field_id).unwrap(),
                                "action": "remove",
                                "previousJson": value_json(previous),
                            }),
                        }).collect::<Vec<_>>(),
                        "nextOverridesJson": overrides_json(&c.next_overrides),
                    }}),
                },
                other => panic!("{other}"),
            };
            let mut expected = step.clone();
            let e = expected.as_object_mut().unwrap();
            e.remove("stepJson");
            let revision = e.remove("revision").unwrap();
            let overrides = e.remove("overridesJson").unwrap();
            assert_eq!(actual, expected, "{label}");
            assert_eq!(json!(editor.revision()), revision, "{label}");
            assert_eq!(
                overrides_json(editor.overrides()),
                overrides.as_str().unwrap(),
                "{label}"
            );
        }
    }
}

#[test]
fn stepping_matches_the_browser() {
    let f = corpus();
    for (index, origins) in f["steps"].as_array().unwrap().iter().enumerate() {
        for origin in origins.as_array().unwrap() {
            let current = units(origin[0].as_str().unwrap());
            for (i, up) in [(1, true), (2, false)] {
                let actual = match step_value(index, &current, up) {
                    Step::Value(v) => json!(utf16(&v)),
                    Step::Refused(r) => json!({ "refusal": r.as_str() }),
                    Step::Codec(issues) => {
                        json!({ "throws": utf16(&orcaxr_project::settings::options::joined(&issues)) })
                    }
                };
                assert_eq!(actual, origin[i], "{} {origin}", DEFINITIONS[index].key);
            }
        }
    }
    for case in f["stepForCases"].as_array().unwrap() {
        let step = step_for(case[0].as_f64().unwrap(), case[1].as_f64().unwrap());
        assert_eq!(
            step.to_bits(),
            case[2].as_f64().unwrap().to_bits(),
            "{case}"
        );
    }
}

#[test]
fn stepper_rows_match_the_browser() {
    let f = corpus();
    let mut folding = folding(&f);
    for case in f["rowCases"].as_array().unwrap() {
        let scope = scope(case["scope"].as_str().unwrap());
        let snapshot = parse(case["snapshotJson"].as_str().unwrap()).unwrap();
        let editor = DraftEditor::new::<NonAsciiText>(
            mode(case["mode"].as_str().unwrap()),
            Requested::Fff,
            Some(surface_for_scope(scope)),
            (scope != SettingScope::Project).then_some(scope),
            values(field_member(&snapshot, "inherited").unwrap()),
            values(field_member(&snapshot, "overrides").unwrap()),
        )
        .unwrap();
        let rows = stepper_rows(&editor, scope, &mut AsciiRootCollation, &mut folding).unwrap();
        assert_eq!(json!(rows.unavailable), case["unavailable"]);
        let expected = case["rows"].as_array().unwrap();
        assert_eq!(rows.rows.len(), expected.len());
        for (row, e) in rows.rows.iter().zip(expected) {
            let d = row.field.definition();
            let mut actual = json!({
                "field": row.field.index,
                "label": utf16(&row.field.label),
                "group": utf16(&row.group),
                "value": utf16(&row.value),
                "unit": row.field.unit.as_deref().map(utf16).unwrap_or_default(),
                "overridden": row.overridden,
                "steppable": row.refusal.is_none(),
                "kind": row.kind.as_str(),
                "choices": orcaxr_project::settings::options::enum_choices(d).map(|(s, l)| json!([s, l])).collect::<Vec<_>>(),
                "integer": d.option_type == orcaxr_project::settings::options::OptionType::CoInt,
                "typeable": row.kind != RowKind::ReadOnly,
            });
            let o = actual.as_object_mut().unwrap();
            if let Some(r) = row.refusal {
                o.insert("reason".into(), json!(r.reason()));
            }
            if let Some(min) = d.min {
                o.insert("minimum".into(), number(min));
            }
            if let Some(max) = d.max {
                o.insert("maximum".into(), number(max));
            }
            assert_eq!(actual, *e, "{scope:?} {}", d.key);
        }
    }
}

#[test]
fn full_spectrum_rules_match_the_browser() {
    let f = corpus();
    for case in f["fullSpectrum"].as_array().unwrap() {
        let effective = values(&parse(case["valuesJson"].as_str().unwrap()).unwrap());
        for expansion in case["expansions"].as_array().unwrap() {
            let changed: Vec<Vec<u16>> = expansion["changedKeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| units(k.as_str().unwrap()))
                .collect();
            match expand_transaction(&changed, &effective) {
                Err(e) => assert_eq!(e.message(), expansion["error"].as_str().unwrap()),
                Ok(e) => {
                    assert_eq!(
                        overrides_json(&e.effective),
                        expansion["effectiveJson"].as_str().unwrap()
                    );
                    assert_eq!(json!(e.implicit), expansion["implicit"]);
                }
            }
        }
        for d in case["dependencies"].as_array().unwrap() {
            let state = dependency(&units(d[0].as_str().unwrap()), &effective);
            assert_eq!(json!(state.map(|s| s.enabled)), d[1]);
        }
        let issues: Vec<String> = cross_field_issue(&effective)
            .iter()
            .map(|m| utf16(m))
            .collect();
        assert_eq!(json!(issues), case["crossField"]);
    }
    for case in f["specialEditors"].as_array().unwrap() {
        let required = requires_structured_editor(&units(case[0].as_str().unwrap()));
        assert_eq!(json!(required.then_some(STRUCTURED_EDITOR_REASON)), case[1]);
    }
}
