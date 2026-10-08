use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ingress::json::{JsonInput, JsonLimits},
    settings::{
        library::*,
        presets::{AsciiRootCollation, Collation, JsonObject, Kind, NonAsciiText, PresetGraph},
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

/// The host exchange replays every scenario from catalog and stored bytes and
/// matches the browser's contract encodings, as the bindings do.
#[test]
fn host_exchange_matches_the_browser_codecs() {
    use orcaxr_contracts::project_intent_types as wire;
    use orcaxr_project::settings::{catalog_exchange::CatalogUpload, library_exchange::*};
    let f = corpus();
    let limits = JsonLimits {
        max_bytes: 8 << 20,
        max_nodes: 1 << 20,
        max_text_units: 8 << 20,
        max_number_bytes: 64,
        max_depth: 64,
    };
    let bundled = include_bytes!("../../../../web/public/profiles/catalog.json").to_vec();
    let bytes = |name: &str| {
        if name == "bundled" {
            bundled.clone()
        } else {
            f["catalogs"][name].as_str().unwrap().as_bytes().to_vec()
        }
    };
    let upload = |name: &str| {
        let bytes = bytes(name);
        let mut upload = CatalogUpload::new(bytes.len(), limits).unwrap();
        for (i, chunk) in bytes.chunks(65536).enumerate() {
            upload.append(i * 65536, chunk).unwrap();
        }
        upload
    };
    let same = |actual: &str, expected: &str, label: &str| {
        let a: Json = serde_json::from_str(actual).unwrap();
        let e: Json = serde_json::from_str(expected).unwrap();
        assert_eq!(a, e, "{label}");
    };
    let mut replies = 0;
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        // The bindings' host never reads its clock: requests carry `now`.
        let mut host = host(&[], Rc::new(Cell::new(0)));
        let stored: Option<Vec<u8>> = scenario["stateJson"]
            .as_str()
            .or_else(|| scenario.get("storedText").and_then(Json::as_str))
            .map(|t| t.as_bytes().to_vec());
        let mut library = HostLibrary::create(
            upload(scenario["catalog"].as_str().unwrap()),
            stored.as_deref(),
            limits,
            &mut host,
        )
        .unwrap();
        let issues = |library: &HostLibrary, expected: &Json, label: &str| {
            let expected = expected.as_array().unwrap();
            assert_eq!(library.issue_count(), expected.len(), "{label}");
            for (i, json) in expected.iter().enumerate() {
                let issue = library.issue(i).unwrap();
                assert_eq!(
                    wire::encode_library_issue(&issue).unwrap(),
                    json.as_str().unwrap(),
                    "{label} issue {i}"
                );
            }
            assert!(library.issue(expected.len()).is_none());
            expected.len()
        };
        replies += issues(&library, &scenario["wire"]["createIssueJsons"], name);
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {index}");
            let op: Json = serde_json::from_str(step["opJson"].as_str().unwrap()).unwrap();
            let w = &step["wire"];
            let text = |key: &str| w[key].as_str().unwrap().to_owned();
            if let Some(operation) = w["operationJson"].as_str() {
                let operation = wire::decode_library_operation(operation).unwrap();
                let outcome = library.apply(&operation, &mut host).unwrap();
                assert_eq!(
                    wire::encode_library_outcome(&outcome).unwrap(),
                    text("outcomeJson"),
                    "{label}"
                );
                replies += issues(&library, &w["issueJsons"], &label);
            } else {
                match op["op"].as_str().unwrap() {
                    "import" => {
                        let bundle = op["bundle"].as_str().unwrap().as_bytes();
                        let outcome = library.import(bundle, limits, &mut host).unwrap();
                        assert_eq!(
                            wire::encode_library_outcome(&outcome).unwrap(),
                            text("outcomeJson"),
                            "{label}"
                        );
                        replies += issues(&library, &w["issueJsons"], &label);
                    }
                    "export" => {
                        let at = units(w["exportedAt"].as_str().unwrap());
                        let bundle = library.export::<NonAsciiText>(&at, 8 << 20).unwrap();
                        assert_eq!(
                            String::from_utf8(bundle).unwrap(),
                            step["bundle"].as_str().unwrap(),
                            "{label}"
                        );
                        assert!(matches!(
                            library.export::<NonAsciiText>(&at, 1),
                            Err(ExchangeError::OutputLimit)
                        ));
                    }
                    "plan" => {
                        let next = upload(op["catalog"].as_str().unwrap());
                        let plan = library.plan_update(next, &mut host).unwrap();
                        assert_eq!(
                            wire::encode_library_update_plan(&plan).unwrap(),
                            text("planJson"),
                            "{label}"
                        );
                        replies += issues(&library, &w["issueJsons"], &label);
                    }
                    "apply" => {
                        let next = upload(op["catalog"].as_str().unwrap());
                        let outcome = library.apply_update(next, &mut host).unwrap();
                        assert_eq!(
                            wire::encode_library_outcome(&outcome).unwrap(),
                            text("outcomeJson"),
                            "{label}"
                        );
                        replies += issues(&library, &w["issueJsons"], &label);
                    }
                    "bases" => {
                        let request =
                            wire::decode_library_base_request(&text("requestJson")).unwrap();
                        assert_eq!(
                            wire::encode_library_bases(&library.bases(&request)).unwrap(),
                            text("basesJson"),
                            "{label}"
                        );
                    }
                    "inventory" => {
                        let inventory = library.inventory(&mut host).unwrap();
                        same(
                            &wire::encode_library_inventory(&inventory).unwrap(),
                            &text("inventoryJson"),
                            &label,
                        );
                    }
                    "views" => {
                        assert_eq!(
                            wire::encode_library_view(&library.view()).unwrap(),
                            text("viewJson"),
                            "{label}"
                        );
                        let customs = w["customJsons"].as_array().unwrap();
                        for (i, json) in customs.iter().enumerate() {
                            let preset = library.custom_preset(i).unwrap();
                            assert_eq!(
                                wire::encode_library_custom_preset(&preset).unwrap(),
                                json.as_str().unwrap(),
                                "{label} custom {i}"
                            );
                        }
                        assert!(library.custom_preset(customs.len()).is_none());
                        replies += customs.len();
                        let composed = library.catalog(&mut host).unwrap();
                        assert_eq!(
                            composed.preset_count() as u64,
                            w["presetCount"].as_u64().unwrap(),
                            "{label}"
                        );
                    }
                    other => panic!("unknown op {other}"),
                }
            }
            let state = library.state::<NonAsciiText>(8 << 20).unwrap();
            assert_eq!(
                String::from_utf8(state).unwrap(),
                step["stateJson"].as_str().unwrap(),
                "{label} state"
            );
            replies += 2;
        }
    }
    for c in f["wire"]["coerceCases"].as_array().unwrap() {
        let request =
            wire::decode_library_coerce_request(c["requestJson"].as_str().unwrap()).unwrap();
        let reply = coerce::<NonAsciiText>(&request).unwrap();
        assert_eq!(
            wire::encode_library_coerced_value(&reply).unwrap(),
            c["replyJson"].as_str().unwrap()
        );
        replies += 1;
    }
    for c in f["wire"]["formatCases"].as_array().unwrap() {
        let request =
            wire::decode_library_format_request(c["requestJson"].as_str().unwrap()).unwrap();
        let reply = format::<NonAsciiText>(&request).unwrap();
        assert_eq!(
            wire::encode_library_formatted_value(&reply).unwrap(),
            c["replyJson"].as_str().unwrap()
        );
        replies += 1;
    }
    println!("library exchange: {replies} replies");
}

/// Refusals change nothing: malformed requests, budgets, a refused catalog,
/// and host policy failures.
#[test]
fn host_exchange_refuses_without_changing_anything() {
    use orcaxr_contracts::project_intent_types as wire;
    use orcaxr_project::settings::{catalog_exchange::CatalogUpload, library_exchange::*};
    let f = corpus();
    let limits = JsonLimits {
        max_bytes: 1 << 20,
        max_nodes: 1 << 16,
        max_text_units: 1 << 20,
        max_number_bytes: 64,
        max_depth: 64,
    };
    let upload = |text: &str| {
        let mut upload = CatalogUpload::new(text.len(), limits).unwrap();
        upload.append(0, text.as_bytes()).unwrap();
        upload
    };
    let acme = f["catalogs"]["acme"].as_str().unwrap();
    let mut host = host(&[], Rc::new(Cell::new(0)));
    // A system catalog that is not a preset graph refuses creation.
    let broken = f["catalogs"]["broken"].as_str().unwrap();
    assert!(matches!(
        HostLibrary::create(upload(broken), None, limits, &mut host),
        Err(ExchangeError::InvalidCatalog)
    ));
    let mut library = HostLibrary::create(upload(acme), None, limits, &mut host).unwrap();
    let before = library.state::<NonAsciiText>(1 << 20).unwrap();
    // Overrides must be a JSON object.
    for overrides in ["[]", "{", "null"] {
        let operation = wire::LibraryOperation::Create(wire::LibraryCreate {
            draft: wire::LibraryDraft {
                vendor: wire::OptionalText::Absent(wire::Empty {}),
                kind: wire::CatalogPresetKind::Filament,
                name: units("Mine"),
                inherits: units("Acme PLA"),
                overrides_json: wire::OptionalJsonText::Value(units(overrides)),
                license: wire::OptionalText::Absent(wire::Empty {}),
                version: wire::OptionalText::Absent(wire::Empty {}),
                note: wire::OptionalText::Absent(wire::Empty {}),
                source: wire::OptionalProvenanceSource::Absent(wire::Empty {}),
            },
            now: units("2026-08-16T00:00:00.000Z"),
        });
        assert!(matches!(
            library.apply(&operation, &mut host),
            Err(ExchangeError::InvalidRequest)
        ));
    }
    // A bundle over budget refuses; one that is not JSON is an outcome.
    let tight = JsonLimits {
        max_bytes: 4,
        ..limits
    };
    assert!(matches!(
        library.import(b"{\"a\":1}", tight, &mut host),
        Err(ExchangeError::Json(
            orcaxr_project::ingress::json::JsonInputError::Limit
        ))
    ));
    assert!(!library.import(b"{ oops", limits, &mut host).unwrap().ok);
    // Stored text over budget loads as unreadable state.
    let stored = HostLibrary::create(
        upload(acme),
        Some(br#"{"schemaVersion":1}"#),
        tight,
        &mut host,
    )
    .unwrap();
    assert_eq!(
        stored.issue(0).unwrap().code,
        wire::LibraryIssueCode::UnsupportedSchema
    );
    assert!(matches!(
        library.state::<NonAsciiText>(4),
        Err(ExchangeError::OutputLimit)
    ));
    // A collation that fails is the host's error.
    let mut failing = Host {
        collation: Failing,
        clock: Box::new(Vec::new) as Box<dyn FnMut() -> Vec<u16>>,
        timestamps: |_: &[u16]| Ok::<_, &'static str>(true),
    };
    assert!(matches!(
        HostLibrary::create(upload(acme), None, limits, &mut failing),
        Err(ExchangeError::Host("collation"))
    ));
    assert_eq!(library.state::<NonAsciiText>(1 << 20).unwrap(), before);
}
struct Failing;
impl Collation for Failing {
    type Error = &'static str;
    fn compare(&mut self, _: &[u16], _: &[u16]) -> Result<std::cmp::Ordering, &'static str> {
        Err("collation")
    }
}
