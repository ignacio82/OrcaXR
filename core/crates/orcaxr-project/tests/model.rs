use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::ids::{EntityId, SeededRandom, UuidIdSource};
use orcaxr_project::model::*;
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use std::sync::Arc;
fn fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-model-vectors.json"
    ))
    .unwrap()
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
fn units(value: &Json) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u16)
        .collect()
}
fn id<K>(value: &Json) -> EntityId<K> {
    EntityId::try_from_utf16(units(value)).unwrap()
}
fn model(case: &Json) -> ProjectState {
    ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap()
}
fn number(value: f64) -> Number {
    Number::new(value).unwrap()
}
fn tuple<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn selector_result(value: Option<Value>) -> Json {
    value
        .map(|v| json!(canonical_value(&v)))
        .unwrap_or(Json::Null)
}
#[test]
fn round_trips_every_field_and_unknown_property_with_exact_reference_hashes() {
    let fixtures = fixture();
    for case in fixtures["cases"].as_array().unwrap() {
        let source = model(case);
        assert_eq!(canonical(&source), case["stateJson"], "{}", case["name"]);
        assert_eq!(
            canonical_value(&source.to_value().unwrap()),
            case["stateJson"]
        );
        assert_eq!(project_fingerprint(&source).unwrap(), case["fingerprint"]);
        let data = ProjectData::new(source).unwrap();
        assert_eq!(data.fingerprint(), case["fingerprint"]);
        assert!(data.same_allocation(&data.clone()));
        assert_eq!(
            canonical(&ProjectState::from_value(data.state().to_value().unwrap()).unwrap()),
            case["stateJson"]
        );
    }
}
#[test]
fn all_typed_record_fields_and_optional_presence_match_the_typescript_ast() {
    let fixture = fixture();
    macro_rules! check{($($kind:ident),*$(,)?)=>{$(assert_eq!(json!($kind::field_optionality().into_iter().map(|(name,optional)|json!({"name":name,"optional":optional})).collect::<Vec<_>>()),fixture["records"][stringify!($kind)],"{}",stringify!($kind));)*}}
    check!(
        Transform,
        BufferViewDescriptor,
        IndexedMeshDescriptor,
        AssetProvenance,
        SourceAssetDescriptor,
        MeshSourceRef,
        FacetAnnotations,
        EmbossFontProperty,
        EmbossProjection,
        EmbossTextConfiguration,
        EmbossSvgPart,
        ProjectVolume,
        ProjectInstance,
        LayerRange,
        BrimEarPoint,
        ProjectObject,
        WipeTowerState,
        ProjectPlate,
        PhysicalFilament,
        MixedComponent,
        FullSpectrumRecipeState,
        MixedFilament,
        CustomGcodeLayerEvent,
        CustomGcode,
        ProjectThumbnail,
        ExtensionBlob,
        Printer,
        Filaments,
        ProjectState,
        RatioDistribution,
        CycleDistribution,
        MatchDistribution,
        GradientDistribution
    );
}
#[test]
fn factories_preserve_injected_uuid_consumption_defaults_and_canonical_identity() {
    let fixture = fixture();
    for case in fixture["factories"].as_array().unwrap() {
        let mut ids = UuidIdSource::new(SeededRandom::new(case["seed"].as_f64().unwrap()));
        let state = empty_project(
            &mut ids,
            Text::from_utf8("2026-10-05T01:02:03Z"),
            None,
            None,
            None,
        );
        assert_eq!(canonical(&state), case["stateJson"]);
        assert_eq!(project_fingerprint(&state).unwrap(), case["fingerprint"]);
    }
    assert_eq!(
        canonical(&identity_transform()),
        r#"{"rotation":[0,0,0,1],"scale":[1,1,1],"translationMm":[0,0,0]}"#
    );
}
#[test]
fn graph_queries_and_filament_inheritance_match_reference_results() {
    let fixtures = fixture();
    for case in fixtures["cases"].as_array().unwrap() {
        let state = model(case);
        let queries = &case["selectors"];
        for query in queries["plate"].as_array().unwrap() {
            assert_eq!(
                selector_result(
                    find_plate(&state, &id(&query["idUtf16"])).map(|v| v.to_value().unwrap())
                ),
                query["result"]
            );
        }
        for query in queries["object"].as_array().unwrap() {
            assert_eq!(
                selector_result(
                    find_object(&state, &id(&query["idUtf16"])).map(|(p, o)| tuple([
                        ("plate", p.to_value().unwrap()),
                        ("object", o.to_value().unwrap())
                    ]))
                ),
                query["result"]
            );
        }
        for query in queries["volume"].as_array().unwrap() {
            assert_eq!(
                selector_result(find_volume(&state, &id(&query["idUtf16"])).map(
                    |(p, o, v)| tuple([
                        ("plate", p.to_value().unwrap()),
                        ("object", o.to_value().unwrap()),
                        ("volume", v.to_value().unwrap())
                    ])
                )),
                query["result"]
            );
        }
        for query in queries["instance"].as_array().unwrap() {
            assert_eq!(
                selector_result(
                    find_instance(&state, &id(&query["idUtf16"])).map(|(p, o, v)| tuple([
                        ("plate", p.to_value().unwrap()),
                        ("object", o.to_value().unwrap()),
                        ("instance", v.to_value().unwrap())
                    ]))
                ),
                query["result"]
            );
        }
        for query in queries["range"].as_array().unwrap() {
            assert_eq!(
                selector_result(find_layer_range(&state, &id(&query["idUtf16"])).map(
                    |(p, o, v)| tuple([
                        ("plate", p.to_value().unwrap()),
                        ("object", o.to_value().unwrap()),
                        ("layerRange", v.to_value().unwrap())
                    ])
                )),
                query["result"]
            );
        }
        assert_eq!(
            json!(
                all_project_objects(&state)
                    .map(|v| v.id.as_utf16())
                    .collect::<Vec<_>>()
            ),
            queries["allObjects"]
        );
        for query in queries["topology"].as_array().unwrap() {
            assert_eq!(
                is_topology_current(
                    &state,
                    &id(&query["idUtf16"]),
                    number(query["revision"].as_f64().unwrap())
                ),
                query["current"]
            );
        }
        for query in queries["filaments"].as_array().unwrap() {
            let (_, object) = find_object(&state, &id(&query["objectId"])).unwrap();
            let child = match query["kind"].as_str().unwrap() {
                "volume" => Some(FilamentChild::Volume(
                    find_volume(&state, &id(&query["childId"])).unwrap().2,
                )),
                "range" => Some(FilamentChild::LayerRange(
                    find_layer_range(&state, &id(&query["childId"])).unwrap().2,
                )),
                _ => None,
            };
            let result = resolve_filament(object, child);
            let mut fields = BTreeMap::new();
            for (name, value) in [
                ("effective", result.effective),
                ("local", result.local),
                ("inherited", result.inherited),
            ] {
                if let Some(value) = value {
                    fields.insert(name.encode_utf16().collect(), value.to_value().unwrap());
                }
            }
            let source = match result.source {
                FilamentSource::None => "none",
                FilamentSource::Object => "object",
                FilamentSource::Volume => "volume",
                FilamentSource::LayerRange => "layer-range",
            };
            fields.insert(
                "source".encode_utf16().collect(),
                Text::from_utf8(source).to_value().unwrap(),
            );
            assert_eq!(canonical_value(&Value::Object(fields)), query["result"]);
        }
    }
}
fn fields(value: &mut Value) -> &mut BTreeMap<Vec<u16>, Value> {
    let Value::Object(fields) = value else {
        panic!()
    };
    fields
}
fn key(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
#[test]
fn shape_rejections_are_atomic_do_not_leak_content_and_do_not_claim_semantic_validation() {
    let fixture = fixture();
    let source = model(&fixture["cases"][0]);
    let data = ProjectData::new(source).unwrap();
    let original = data.fingerprint().to_owned();
    for (name, invalid, code) in [
        ("name", Value::Null, ShapeErrorCode::ExpectedText),
        (
            "id",
            Value::String(key("PRIVATE_INVALID_ID")),
            ShapeErrorCode::InvalidId,
        ),
        (
            "schemaVersion",
            Value::Number(2.0),
            ShapeErrorCode::InvalidLiteral,
        ),
        (
            "plates",
            Value::Object(BTreeMap::new()),
            ShapeErrorCode::ExpectedArray,
        ),
        (
            "config",
            Value::Array(vec![]),
            ShapeErrorCode::ExpectedObject,
        ),
        (
            "settingsOverrides",
            Value::Null,
            ShapeErrorCode::ExpectedObject,
        ),
    ] {
        let mut candidate = data.state().to_value().unwrap();
        fields(&mut candidate).insert(key(name), invalid);
        let error = ProjectState::from_value(candidate).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.path, [PathPart::Field(name)]);
        assert!(!error.to_string().contains("PRIVATE"));
        assert_eq!(data.fingerprint(), original);
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(
            Number::new(value).unwrap_err().code,
            ShapeErrorCode::NonFiniteNumber
        );
        let mut candidate = data.state().to_value().unwrap();
        fields(&mut candidate).insert(key("future"), Value::Array(vec![Value::Number(value)]));
        assert_eq!(
            ProjectState::from_value(candidate).unwrap_err().code,
            ShapeErrorCode::NonFiniteNumber
        );
    }
    let mut candidate = data.to_candidate();
    candidate.created_at = Text::from_utf8("not a timestamp");
    candidate.active_plate_id = EntityId::try_from_str("import:plate:missing").unwrap();
    assert!(
        ProjectData::new(candidate).is_ok(),
        "typed candidates are explicitly not semantic project validation"
    );
    let debug = format!("{:?}", data.state());
    assert!(!debug.contains("PRIVATE_MODEL_TEXT"));
    let mut candidate = data.state().to_value().unwrap();
    fields(&mut candidate).remove(&key("name"));
    assert_eq!(
        ProjectState::from_value(candidate).unwrap_err().code,
        ShapeErrorCode::MissingField
    );
    assert!(
        Transform::from_value(
            parse(r#"{"translationMm":[0,0],"rotation":[0,0,0,1],"scale":[1,1,1]}"#).unwrap()
        )
        .is_err()
    );
    assert!(MixedDistribution::from_value(parse(r#"{"mode":"unknown"}"#).unwrap()).is_err());
    assert!(
        MixedDistribution::from_value(
            parse(r#"{"mode":"gradient","startWeights":[],"endWeights":null}"#).unwrap()
        )
        .is_err()
    );
}
#[test]
fn copy_on_write_edits_share_untouched_metadata_and_preserve_old_hashes() {
    let fixture = fixture();
    let data = ProjectData::new(model(&fixture["cases"][0])).unwrap();
    let original = data.fingerprint().to_owned();
    let mut candidate = data.to_candidate();
    assert!(Arc::ptr_eq(&candidate.plates, &data.state().plates));
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut candidate.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let instance = Arc::make_mut(&mut Arc::make_mut(&mut object.instances)[0]);
    instance.transform.translation_mm[0] = number(12.5);
    let changed = ProjectData::new(candidate).unwrap();
    assert_ne!(changed.fingerprint(), original);
    assert_eq!(data.fingerprint(), original);
    let old = &data.state().plates[0].objects[0];
    let new = &changed.state().plates[0].objects[0];
    assert!(Arc::ptr_eq(&old.volumes, &new.volumes));
    assert!(old.config.same_allocation(&new.config));
    assert!(Arc::ptr_eq(
        &data.state().plates[1],
        &changed.state().plates[1]
    ));
    assert_eq!(old.instances[0].transform.translation_mm[0].get(), 0.0);
    assert_eq!(new.instances[0].transform.translation_mm[0].get(), 12.5);
    let mut exported = changed.state().to_value().unwrap();
    fields(&mut exported).insert(key("name"), Value::Null);
    assert_eq!(changed.state().name, data.state().name);
}
#[test]
fn metadata_larger_and_deeper_than_the_stateless_parser_round_trips_without_payload_copy() {
    let fixture = fixture();
    let mut state = model(&fixture["cases"][8]);
    let numbers = Value::Array((0..120_000).map(|i| Value::Number(i as f64)).collect());
    let mut deep = Value::Bool(true);
    for _ in 0..90 {
        deep = Value::Array(vec![deep]);
    }
    state.extension_data =
        Some(JsonObject::new(tuple([("numbers", numbers), ("deep", deep)])).unwrap());
    let data = ProjectData::new(state).unwrap();
    let clone = data.to_candidate();
    assert!(
        clone
            .extension_data
            .as_ref()
            .unwrap()
            .same_allocation(data.state().extension_data.as_ref().unwrap())
    );
    assert_eq!(canonical(&clone), canonical(data.state()));
}
#[test]
fn moving_unknown_fields_between_record_types_cannot_shadow_known_optional_or_required_fields() {
    let mut ids = UuidIdSource::new(SeededRandom::new(1.0));
    let mut state = empty_project(
        &mut ids,
        Text::from_utf8("2026-10-05T00:00:00Z"),
        None,
        None,
        None,
    );
    let other=Transform::from_value(parse(r#"{"translationMm":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1],"name":"unknown here"}"#).unwrap()).unwrap();
    state.extra = other.extra;
    assert!(ProjectData::new(state).is_err());
    let mut printer = Printer::from_value(parse(r#"{"toolCount":1}"#).unwrap()).unwrap();
    let other=Transform::from_value(parse(r#"{"translationMm":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1],"profileId":"unknown here"}"#).unwrap()).unwrap();
    printer.extra = other.extra;
    assert!(printer.to_value().is_err());
}

#[test]
fn literal_domains_match_the_existing_typescript_schema() {
    let fixture = fixture();
    macro_rules! check{($($kind:ident),*$(,)?)=>{$(assert_eq!(json!($kind::VALUES.iter().map(|v|serde_json::from_str::<Json>(&canonical(v)).unwrap()).collect::<Vec<_>>()),fixture["literals"][stringify!($kind)],"{}",stringify!($kind));)*}}
    check!(
        MeshComponentType,
        SourceAssetKind,
        VolumeRole,
        LayerEventType,
        EmbossHorizontalAlign,
        EmbossVerticalAlign,
        ComponentCount,
        FullSpectrumUiMode,
        DistributionMode,
        GcodeScope,
        GcodeTrigger
    );
}
#[test]
fn immutable_edit_traces_match_reference_state_and_fingerprint_after_every_step() {
    let fixture = fixture();
    let original = ProjectData::new(model(&fixture["cases"][0])).unwrap();
    let original_hash = original.fingerprint().to_owned();
    let mut current = original.clone();
    for step in fixture["edits"].as_array().unwrap() {
        let mut next = current.to_candidate();
        match step["operation"].as_str().unwrap() {
            "rename-project" => {
                let mut text: Vec<_> = "renamed".encode_utf16().collect();
                text.push(0xd800);
                next.name = Text::new(text);
            }
            "translate-instance" => {
                let plate = Arc::make_mut(&mut Arc::make_mut(&mut next.plates)[0]);
                let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
                let instance = Arc::make_mut(&mut Arc::make_mut(&mut object.instances)[0]);
                instance.transform.translation_mm[0] = number(12.5);
            }
            "rename-plate" => {
                Arc::make_mut(&mut Arc::make_mut(&mut next.plates)[0]).name =
                    Text::from_utf8("new plate")
            }
            "remove-settings-overrides" => {
                next.settings_overrides = None;
                next.config = next.settings_base_config.clone().unwrap();
            }
            "reverse-plates" => Arc::make_mut(&mut next.plates).reverse(),
            _ => panic!(),
        }
        current = ProjectData::new(next).unwrap();
        assert_eq!(canonical(current.state()), step["stateJson"]);
        assert_eq!(current.fingerprint(), step["fingerprint"]);
        assert_eq!(original.fingerprint(), original_hash);
    }
}

#[test]
fn borrowed_json_comparison_matches_independent_full_canonical_contents() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    for a in cases {
        let typed = model(a);
        for b in cases {
            let value = parse(b["stateJson"].as_str().unwrap()).unwrap();
            assert_eq!(
                typed.matches_value(&value).unwrap(),
                a["stateJson"] == b["stateJson"],
                "{} vs {}",
                a["name"],
                b["name"]
            );
        }
        let value = parse(a["stateJson"].as_str().unwrap()).unwrap();
        let Value::Object(fields) = &value else {
            panic!()
        };
        for key in fields.keys() {
            let mut changed = fields.clone();
            changed.remove(key);
            assert!(
                !typed.matches_value(&Value::Object(changed)).unwrap(),
                "missing field in {}",
                a["name"]
            );
        }
        for wrong in [Value::Null, Value::Bool(false), Value::Array(vec![])] {
            assert!(!typed.matches_value(&wrong).unwrap());
        }
    }
}
