use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ingress::json::{JsonInput, JsonLimits},
    settings::{
        library::*,
        presets::{AsciiRootCollation, JsonObject, Kind, NonAsciiText, PresetGraph},
    },
    validation::{V8Timestamps, timestamp},
};
use serde_json::Value as Json;
use std::{cell::Cell, rc::Rc};

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/preset-library-vectors.json"
    ))
    .unwrap()
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn string(text: &str) -> Value {
    Value::String(units(text))
}
fn text(value: &[u16]) -> Value {
    Value::String(value.to_vec())
}
fn utf16(value: &[u16]) -> String {
    String::from_utf16(value).unwrap()
}
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (units(k), v)))
            .collect(),
    )
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    fields.get(&units(name))
}
fn member(value: &Value, name: &str) -> Vec<u16> {
    let Some(Value::String(t)) = field(value, name) else {
        panic!("{name}")
    };
    t.clone()
}
fn optional(value: &Value, name: &str) -> Option<Vec<u16>> {
    field(value, name).map(|_| member(value, name))
}
fn texts(value: &Value) -> Vec<Vec<u16>> {
    let Value::Array(items) = value else { panic!() };
    items
        .iter()
        .map(|v| match v {
            Value::String(t) => t.clone(),
            _ => panic!(),
        })
        .collect()
}
fn kind(value: &[u16]) -> Kind {
    *Kind::ALL
        .iter()
        .find(|k| units(k.as_str()) == value)
        .unwrap()
}
fn source(value: Option<Vec<u16>>) -> Option<ProvenanceSource> {
    value.map(|s| {
        if s == units("imported") {
            ProvenanceSource::Imported
        } else {
            assert_eq!(s, units("user-derived"));
            ProvenanceSource::UserDerived
        }
    })
}
fn overrides(value: &Value) -> Option<JsonObject> {
    match field(value, "overrides") {
        None => None,
        Some(Value::Object(o)) => Some(o.clone()),
        Some(_) => panic!(),
    }
}

/// `JSON.parse` of host text: anything unreadable is `None`.
fn parse_text(text: &str) -> Option<Value> {
    let limits = JsonLimits {
        max_bytes: 8 << 20,
        max_nodes: 1 << 20,
        max_text_units: 8 << 20,
        max_number_bytes: 64,
        max_depth: 64,
    };
    let mut input = JsonInput::new(text.len(), limits).ok()?;
    if !text.is_empty() {
        input.append(0, text.as_bytes()).ok()?;
    }
    input.finish().ok()
}

type TestHost = Host<
    AsciiRootCollation,
    Box<dyn FnMut() -> Vec<u16>>,
    V8Timestamps<fn(timestamp::LocalDateTime) -> Result<i64, NonAsciiText>>,
>;
/// The browser's collation over ASCII, the corpus clock and UTC `Date.parse`.
fn host(clock: &[Vec<u16>], reads: Rc<Cell<usize>>) -> TestHost {
    let clock = clock.to_vec();
    Host {
        collation: AsciiRootCollation,
        clock: Box::new(move || {
            let read = reads.get();
            reads.set(read + 1);
            clock[read].clone()
        }),
        timestamps: V8Timestamps::new(timestamp::V8IntegerMode::Smi32, |local| {
            Ok(local.civil_milliseconds())
        }),
    }
}

fn issues(list: &[Issue]) -> Value {
    Value::Array(
        list.iter()
            .map(|i| {
                object(vec![
                    ("code", Some(string(i.code.as_str()))),
                    (
                        "severity",
                        Some(string(if i.error { "error" } else { "warning" })),
                    ),
                    ("path", Some(text(&i.path))),
                    ("message", Some(text(&i.message))),
                ])
            })
            .collect(),
    )
}
fn outcome(o: &Outcome) -> String {
    canonical(&object(vec![
        ("ok", Some(Value::Bool(o.ok))),
        ("issues", Some(issues(&o.issues))),
    ]))
}
fn lineages(list: &[Lineage]) -> Value {
    Value::Array(
        list.iter()
            .map(|l| {
                object(vec![
                    ("vendor", Some(text(&l.vendor))),
                    ("kind", Some(string(l.kind.as_str()))),
                    ("name", Some(text(&l.name))),
                ])
            })
            .collect(),
    )
}
fn plan(p: &UpdatePlan) -> String {
    canonical(&object(vec![
        ("previousFingerprint", Some(string(&p.previous_fingerprint))),
        ("nextFingerprint", Some(string(&p.next_fingerprint))),
        ("changed", Some(Value::Bool(p.changed))),
        ("addedModels", Some(lineages(&p.added_models))),
        ("removedModels", Some(lineages(&p.removed_models))),
        ("removedVariants", Some(lineages(&p.removed_variants))),
        (
            "orphanedCustomPresets",
            Some(lineages(&p.orphaned_custom_presets)),
        ),
        ("issues", Some(issues(&p.issues))),
        ("applicable", Some(Value::Bool(p.applicable))),
    ]))
}
fn inventory(i: &Inventory) -> String {
    canonical(&object(vec![
        (
            "vendors",
            Some(Value::Array(i.vendors.iter().map(|v| text(v)).collect())),
        ),
        (
            "models",
            Some(Value::Array(
                i.models
                    .iter()
                    .map(|m| {
                        object(vec![
                            ("vendor", Some(text(&m.vendor))),
                            ("model", Some(text(&m.model))),
                            ("installed", Some(Value::Bool(m.installed))),
                            (
                                "variants",
                                Some(Value::Array(
                                    m.variants
                                        .iter()
                                        .map(|v| {
                                            object(vec![
                                                ("variant", Some(text(&v.variant))),
                                                ("presetName", Some(text(&v.preset_name))),
                                                ("presetId", Some(string(&v.preset_id))),
                                                (
                                                    "nozzleDiameter",
                                                    v.nozzle_diameter.map(Value::Number),
                                                ),
                                                ("installed", Some(Value::Bool(v.installed))),
                                            ])
                                        })
                                        .collect(),
                                )),
                            ),
                        ])
                    })
                    .collect(),
            )),
        ),
    ]))
}
fn graph_digest(graph: &PresetGraph) -> String {
    let mut out = Vec::new();
    for (i, n) in graph.list(None).enumerate() {
        if i > 0 {
            out.extend(units("\n"));
        }
        out.extend(units(&n.id));
        out.push(0);
        out.extend(units(if n.is_visible { "true" } else { "false" }));
        out.push(0);
        out.extend(units(n.source.as_str()));
        out.push(0);
        out.extend(stable_stringify(&Value::Object((*n.effective).clone())));
    }
    fnv1a64_text(&out)
}

fn draft(value: &Value) -> Draft {
    Draft {
        vendor: optional(value, "vendor"),
        kind: kind(&member(value, "kind")),
        name: member(value, "name"),
        inherits: member(value, "inherits"),
        overrides: overrides(value),
        license: optional(value, "license"),
        version: optional(value, "version"),
        note: optional(value, "note"),
        source: source(optional(value, "source")),
    }
}
fn draft_update(value: &Value) -> DraftUpdate {
    DraftUpdate {
        vendor: optional(value, "vendor"),
        kind: optional(value, "kind").map(|k| kind(&k)),
        name: optional(value, "name"),
        inherits: optional(value, "inherits"),
        overrides: overrides(value),
        license: optional(value, "license"),
        version: optional(value, "version"),
        note: optional(value, "note"),
        source: source(optional(value, "source")),
    }
}
fn selections(value: &Value) -> Vec<Installed> {
    let Value::Array(items) = value else { panic!() };
    items
        .iter()
        .map(|s| Installed {
            vendor: member(s, "vendor"),
            model: member(s, "model"),
            variants: texts(field(s, "variants").unwrap()),
        })
        .collect()
}

fn catalogs(f: &Json) -> Vec<(String, Value)> {
    let mut all = vec![(
        "bundled".to_owned(),
        parse(include_str!("../../../../web/public/profiles/catalog.json")).unwrap(),
    )];
    for (name, json) in f["catalogs"].as_object().unwrap() {
        all.push((name.clone(), parse(json.as_str().unwrap()).unwrap()));
    }
    all
}

#[test]
fn library_scenarios_match_the_browser() {
    let f = corpus();
    let catalogs = catalogs(&f);
    let catalog = |name: &str| &catalogs.iter().find(|(n, _)| n == name).unwrap().1;
    let clock: Vec<Vec<u16>> = f["clock"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| units(t.as_str().unwrap()))
        .collect();
    let mut steps = 0;
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let reads = Rc::new(Cell::new(0));
        let mut host = host(&clock, reads.clone());
        let state = if let Some(json) = scenario["stateJson"].as_str() {
            Some(parse(json).unwrap())
        } else if let Some(stored) = scenario.get("storedText") {
            // What the browser store hands `create` for stored text.
            stored
                .as_str()
                .map(|t| parse_text(t).unwrap_or_else(unreadable_state))
        } else {
            None
        };
        let (mut library, created) = Library::create(
            catalog(scenario["catalog"].as_str().unwrap()),
            state.as_ref(),
            &mut host,
        )
        .unwrap();
        assert_eq!(
            canonical(&issues(&created)),
            scenario["createIssuesJson"].as_str().unwrap(),
            "{name} create"
        );
        assert_eq!(
            utf16(&library.state_json()),
            scenario["initialStateJson"].as_str().unwrap(),
            "{name} initial state"
        );
        assert_eq!(
            library.catalog_fingerprint(),
            scenario["fingerprint"].as_str().unwrap()
        );
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {index} {}", step["opJson"]);
            let op = parse(step["opJson"].as_str().unwrap()).unwrap();
            let expect = |key: &str| step[key].as_str().unwrap().to_owned();
            match utf16(&member(&op, "op")).as_str() {
                "install" => {
                    let o = library
                        .install_printer(
                            &member(&op, "vendor"),
                            &member(&op, "model"),
                            &texts(field(&op, "variants").unwrap()),
                            &mut host,
                        )
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "setInstalled" => {
                    let o = library
                        .set_installed(&selections(field(&op, "selections").unwrap()), &mut host)
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "uninstall" => {
                    let o = library
                        .uninstall_printer(&member(&op, "vendor"), &member(&op, "model"), &mut host)
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "create" => {
                    let o = library
                        .create_custom_preset(&draft(field(&op, "draft").unwrap()), &mut host)
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "update" => {
                    let o = library
                        .update_custom_preset(
                            &member(&op, "vendor"),
                            kind(&member(&op, "presetKind")),
                            &member(&op, "name"),
                            &draft_update(field(&op, "draft").unwrap()),
                            &mut host,
                        )
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "delete" => {
                    let o = library
                        .delete_custom_preset(
                            &member(&op, "vendor"),
                            kind(&member(&op, "presetKind")),
                            &member(&op, "name"),
                            &mut host,
                        )
                        .unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "import" => {
                    let bundle = parse_text(&utf16(&member(&op, "bundle")));
                    let o = library.import_bundle(bundle.as_ref(), &mut host).unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                }
                "export" => {
                    let at = optional(&op, "exportedAt").unwrap_or_else(|| host.now());
                    assert_eq!(
                        utf16(&library.export_bundle(&at)),
                        expect("bundle"),
                        "{label}"
                    );
                }
                "plan" => {
                    let next = catalog(&utf16(&member(&op, "catalog")));
                    let p = library.plan_catalog_update(next, &mut host).unwrap();
                    assert_eq!(plan(&p), expect("planJson"), "{label}");
                }
                "apply" => {
                    let next = catalog(&utf16(&member(&op, "catalog")));
                    let (o, updated) = library.apply_catalog_update(next, &mut host).unwrap();
                    assert_eq!(outcome(&o), expect("resultJson"), "{label}");
                    assert_eq!(o.ok, updated.is_some());
                    if let Some(updated) = updated {
                        library = updated;
                    }
                    assert_eq!(library.catalog_fingerprint(), expect("fingerprint"));
                }
                "bases" => {
                    let ids: Vec<String> = library
                        .base_presets_for(
                            kind(&member(&op, "kind")),
                            optional(&op, "printerId").map(|t| utf16(&t)).as_deref(),
                            optional(&op, "processId").map(|t| utf16(&t)).as_deref(),
                        )
                        .into_iter()
                        .map(|n| n.id.clone())
                        .collect();
                    let expected: Vec<String> = step["ids"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().to_owned())
                        .collect();
                    assert_eq!(ids, expected, "{label}");
                }
                "inventory" => {
                    let i = library.inventory(&mut host).unwrap();
                    assert_eq!(inventory(&i), expect("inventoryJson"), "{label}");
                }
                "views" => {
                    assert_eq!(
                        library.is_configured(),
                        step["configured"].as_bool().unwrap(),
                        "{label}"
                    );
                    let vendors: Vec<String> = library
                        .installed_vendors()
                        .iter()
                        .map(|v| utf16(v))
                        .collect();
                    assert_eq!(serde_json::json!(vendors), step["vendors"], "{label}");
                    for k in Kind::ALL {
                        let names: Vec<String> = library
                            .custom_presets(Some(k))
                            .map(|p| utf16(&p.name))
                            .collect();
                        assert_eq!(
                            serde_json::json!(names),
                            step["customs"][k.as_str()],
                            "{label}"
                        );
                    }
                    assert_eq!(
                        fnv1a64_text(&stable_stringify(&library.compose_catalog())),
                        expect("composedDigest"),
                        "{label}"
                    );
                    assert_eq!(
                        graph_digest(library.graph()),
                        expect("graphDigest"),
                        "{label}"
                    );
                }
                other => panic!("unknown op {other}"),
            }
            assert_eq!(
                utf16(&library.state_json()),
                expect("stateJson"),
                "{label} state"
            );
            steps += 1;
        }
        assert_eq!(
            reads.get() as u64,
            scenario["clockReads"].as_u64().unwrap(),
            "{name} clock reads"
        );
    }
    assert_eq!(steps, 131);
}

#[test]
fn override_helpers_match_the_browser() {
    let f = corpus();
    for case in f["coerceCases"].as_array().unwrap() {
        let inherited = case["inheritedJson"].as_str().map(|j| parse(j).unwrap());
        let result =
            coerce_override_value(inherited.as_ref(), &units(case["text"].as_str().unwrap()));
        assert_eq!(
            canonical(&result),
            case["resultJson"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in f["formatCases"].as_array().unwrap() {
        let value = case["valueJson"].as_str().map(|j| parse(j).unwrap());
        assert_eq!(
            utf16(&format_override_value(value.as_ref())),
            case["text"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in f["stableCases"].as_array().unwrap() {
        let value = parse(case["valueJson"].as_str().unwrap()).unwrap();
        let stable = stable_stringify(&value);
        assert_eq!(utf16(&stable), case["text"].as_str().unwrap());
        assert_eq!(fnv1a64_text(&stable), case["digest"].as_str().unwrap());
    }
    for case in f["digestCases"].as_array().unwrap() {
        let input: Vec<u16> = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect();
        assert_eq!(fnv1a64_text(&input), case["digest"].as_str().unwrap());
    }
    assert_eq!(f["coerceCases"].as_array().unwrap().len(), 22);
    assert_eq!(f["formatCases"].as_array().unwrap().len(), 12);
}
