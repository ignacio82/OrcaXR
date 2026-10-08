use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::settings::{catalog::*, presets::*};
use std::cmp::Ordering;

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/preset-catalog-vectors.json"
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
fn utf8(value: &Value) -> String {
    let Value::String(t) = value else { panic!() };
    String::from_utf16(t).unwrap()
}
fn number(n: usize) -> Value {
    Value::Number(n as f64)
}

fn node(n: &PresetNode) -> Value {
    object(vec![
        ("id", Some(string(&n.id))),
        ("vendor", Some(text(&n.vendor))),
        ("kind", Some(string(n.kind.as_str()))),
        ("name", Some(text(&n.name))),
        ("parentId", n.parent_id.as_deref().map(string)),
        ("source", Some(string(n.source.as_str()))),
        ("isSystem", Some(Value::Bool(n.is_system))),
        ("isDefault", Some(Value::Bool(n.is_default))),
        ("isVisible", Some(Value::Bool(n.is_visible))),
        ("effective", Some(Value::Object((*n.effective).clone()))),
    ])
}
fn wire(config: &orcaxr_project::slicing::profile::WireConfig) -> Value {
    Value::Object(config.iter().map(|(k, v)| (k.clone(), text(v))).collect())
}
fn assessment(a: &Assessment) -> Value {
    object(vec![
        ("status", Some(string(a.status.as_str()))),
        ("reason", Some(string(a.reason.as_str()))),
        ("expression", a.expression.as_deref().map(text)),
    ])
}
fn diagnostic(d: &Diagnostic) -> Value {
    object(vec![
        ("code", Some(string(d.code.as_str()))),
        (
            "severity",
            Some(string(if d.error { "error" } else { "warning" })),
        ),
        ("message", Some(text(&d.message))),
        ("machineName", d.machine_name.as_deref().map(text)),
        ("processName", d.process_name.as_deref().map(text)),
        ("presetId", d.preset_id.as_deref().map(string)),
    ])
}
fn selection(s: &Selection) -> Value {
    object(vec![
        ("printer", Some(string(&s.printer.id))),
        (
            "process",
            Some(s.process.as_ref().map_or(Value::Null, |p| string(&p.id))),
        ),
        (
            "filaments",
            Some(Value::Array(
                s.filaments
                    .iter()
                    .map(|f| f.as_ref().map_or(Value::Null, |f| string(&f.id)))
                    .collect(),
            )),
        ),
        (
            "substitutions",
            Some(Value::Array(
                s.substitutions
                    .iter()
                    .map(|x| {
                        object(vec![
                            ("kind", Some(string(x.kind.as_str()))),
                            ("slot", x.slot.map(number)),
                            ("previousId", x.previous_id.as_deref().map(string)),
                            ("nextId", x.next_id.as_deref().map(string)),
                            ("reason", Some(string(x.reason.as_str()))),
                        ])
                    })
                    .collect(),
            )),
        ),
        (
            "diagnostics",
            Some(Value::Array(
                s.diagnostics
                    .iter()
                    .map(|d| {
                        object(vec![
                            ("code", Some(string(d.code.as_str()))),
                            ("presetId", d.preset_id.as_deref().map(string)),
                            ("slot", d.slot.map(number)),
                            ("message", Some(text(&d.message))),
                        ])
                    })
                    .collect(),
            )),
        ),
        ("complete", Some(Value::Bool(s.complete))),
    ])
}
fn request(value: &Value) -> SelectionRequest {
    let strings = |v: &Value| -> Vec<Option<String>> {
        let Value::Array(items) = v else { panic!() };
        items
            .iter()
            .map(|i| (!matches!(i, Value::Null)).then(|| utf8(i)))
            .collect()
    };
    SelectionRequest {
        printer_id: utf8(field(value, "printerId").unwrap()),
        process_id: field(value, "processId").map(utf8),
        filament_ids: field(value, "filamentIds").map_or_else(Vec::new, strings),
        installed_vendors: field(value, "installedVendors").map(|v| {
            let Value::Array(items) = v else { panic!() };
            items
                .iter()
                .map(|i| {
                    let Value::String(t) = i else { panic!() };
                    t.clone()
                })
                .collect()
        }),
    }
}
fn strings(json: &serde_json::Value) -> Vec<&str> {
    json.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn ascii_root_collation_matches_the_browser_locale_compare() {
    let f = corpus();
    let Value::Array(pairs) = parse(f["collationJson"].as_str().unwrap()).unwrap() else {
        panic!()
    };
    for pair in &pairs {
        let Value::Array(p) = pair else { panic!() };
        let (Value::String(a), Value::String(b), Value::Number(sign)) = (&p[0], &p[1], &p[2])
        else {
            panic!()
        };
        let expected = sign.partial_cmp(&0.0).unwrap();
        assert_eq!(
            AsciiRootCollation.compare(a, b),
            Ok(expected),
            "{:?} vs {:?}",
            String::from_utf16_lossy(a),
            String::from_utf16_lossy(b)
        );
    }
    assert!(pairs.len() > 4000);
    assert_eq!(
        AsciiRootCollation.compare(&units("é"), &units("e")),
        Err(NonAsciiText)
    );
    let mut reversed = |a: &[u16], b: &[u16]| Ok::<_, ()>(b.cmp(a));
    assert_eq!(
        reversed.compare(&units("a"), &units("b")),
        Ok(Ordering::Greater)
    );
}

#[test]
fn engine_key_filters_match_the_browser_lists() {
    let f = corpus();
    assert_eq!(META_KEYS, strings(&f["metaKeys"]).as_slice());
    assert_eq!(SAFE_KEYS, strings(&f["safeKeys"]).as_slice());
}

fn replay(name: &str, input: &Value, case: &serde_json::Value) -> (usize, usize) {
    let graph = PresetGraph::build(input, &mut AsciiRootCollation);
    let built = ProfileCatalog::build(input, &mut AsciiRootCollation);
    if let Some(error) = case["graphError"].as_str() {
        let actual = match graph {
            Err(BuildError::Graph(issues)) => object(vec![(
                "issues",
                Some(Value::Array(
                    issues
                        .iter()
                        .map(|i| {
                            object(vec![
                                ("code", Some(string(i.code.as_str()))),
                                ("path", Some(text(&i.path))),
                                ("message", Some(text(&i.message))),
                            ])
                        })
                        .collect(),
                )),
            )]),
            Err(BuildError::MalformedUri) => {
                object(vec![("message", Some(string("URI malformed")))])
            }
            other => panic!("{name}: expected a refusal, got {other:?}"),
        };
        assert_eq!(canonical(&actual), error, "{name}");
        let Err(CatalogError::Invalid(diagnostics)) = built else {
            panic!("{name}")
        };
        assert_eq!(
            canonical(&Value::Array(diagnostics.iter().map(diagnostic).collect())),
            case["catalogError"].as_str().unwrap(),
            "{name}"
        );
        return (0, 0);
    }
    let graph = graph.unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let catalog = built.unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let nodes: Vec<_> = graph.list(None).collect();
    let expected = strings(&case["nodeJsons"]);
    assert_eq!(nodes.len(), expected.len(), "{name}");
    for (n, json) in nodes.iter().zip(expected) {
        assert_eq!(canonical(&node(n)), json, "{name} {}", n.id);
    }
    let auxiliary = Value::Array(
        graph
            .auxiliary()
            .iter()
            .map(|a| {
                object(vec![
                    ("id", Some(string(&a.id))),
                    ("vendor", Some(text(&a.vendor))),
                    ("kind", Some(string(a.kind.as_str()))),
                    ("raw", Some(Value::Object((*a.raw).clone()))),
                ])
            })
            .collect(),
    );
    assert_eq!(
        canonical(&auxiliary),
        case["auxiliaryJson"].as_str().unwrap(),
        "{name}"
    );
    for json in strings(&case["flatJsons"]) {
        let expected = parse(json).unwrap();
        let id = utf8(field(&expected, "id").unwrap());
        let config = flatten(graph.get(&id).unwrap());
        assert_eq!(
            canonical(&wire(&config)),
            canonical(field(&expected, "config").unwrap()),
            "{name} {id}"
        );
    }
    let profiles = Value::Array(
        catalog
            .profiles()
            .iter()
            .map(|p| {
                object(vec![
                    ("id", Some(text(&p.id))),
                    ("displayName", Some(text(&p.display_name))),
                    ("machineName", Some(text(&p.machine_name))),
                    ("processName", Some(text(&p.process_name))),
                    ("filamentName", Some(text(&p.filament_name))),
                    ("filamentPresetName", Some(text(&p.filament_preset_name))),
                    ("filamentVendor", p.filament_vendor.as_deref().map(text)),
                    ("machinePresetId", Some(string(&p.machine_preset_id))),
                    ("processPresetId", Some(string(&p.process_preset_id))),
                    ("filamentPresetId", Some(string(&p.filament_preset_id))),
                ])
            })
            .collect(),
    );
    assert_eq!(
        canonical(&profiles),
        case["profilesJson"].as_str().unwrap(),
        "{name}"
    );
    // Each profile is its three flattenings overlaid in order.
    for p in catalog.profiles() {
        let mut merged = flatten(graph.get(&p.machine_preset_id).unwrap());
        merged.extend(flatten(graph.get(&p.process_preset_id).unwrap()));
        merged.extend(flatten(graph.get(&p.filament_preset_id).unwrap()));
        assert_eq!(p.config(), merged);
    }
    assert_eq!(
        canonical(&Value::Array(
            catalog.diagnostics().iter().map(diagnostic).collect()
        )),
        case["diagnosticsJson"].as_str().unwrap(),
        "{name}"
    );
    for a in case["assessments"].as_array().unwrap() {
        let candidate = graph.get(a["candidate"].as_str().unwrap()).unwrap();
        let printer = graph.get(a["printer"].as_str().unwrap()).unwrap();
        let result = match a["print"].as_str() {
            Some(print) => graph.assess_print(candidate, graph.get(print).unwrap(), printer),
            None => graph.assess_printer(candidate, printer),
        };
        assert_eq!(
            canonical(&assessment(&result)),
            a["resultJson"].as_str().unwrap(),
            "{name} {} on {}",
            candidate.id,
            printer.id
        );
    }
    for s in case["selections"].as_array().unwrap() {
        let request = request(&parse(s["requestJson"].as_str().unwrap()).unwrap());
        let actual = match catalog.reconcile(&request) {
            Ok(result) => selection(&result),
            Err(reason) => object(vec![("unavailable", Some(string(reason)))]),
        };
        assert_eq!(
            canonical(&actual),
            s["resultJson"].as_str().unwrap(),
            "{name} {}",
            s["requestJson"]
        );
    }
    (
        case["assessments"].as_array().unwrap().len(),
        case["selections"].as_array().unwrap().len(),
    )
}

#[test]
fn the_bundled_catalog_compiles_exactly_like_the_browser() {
    let f = corpus();
    let input = parse(include_str!("../../../../web/public/profiles/catalog.json")).unwrap();
    assert_eq!(replay("bundled", &input, &f["real"]), (2699, 58));
    let catalog = ProfileCatalog::build(&input, &mut AsciiRootCollation).unwrap();
    assert_eq!(catalog.profiles().len(), 1482);
}

#[test]
fn synthetic_catalogs_cover_every_refusal_and_selection_rule() {
    let f = corpus();
    let cases = f["cases"].as_object().unwrap();
    let mut replayed = (0, 0);
    for (name, case) in cases {
        let input = parse(case["inputJson"].as_str().unwrap()).unwrap();
        let (assessments, selections) = replay(name, &input, case);
        replayed = (replayed.0 + assessments, replayed.1 + selections);
    }
    assert_eq!(replayed, (429, 12));
    assert_eq!(cases.len(), 9);
}
