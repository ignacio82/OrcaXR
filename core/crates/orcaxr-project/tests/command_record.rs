use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    commands::*,
    history::*,
    ids::*,
    ingress::{command_record::*, json::*},
    model::*,
    selection::*,
    store::*,
    validation::*,
};
use std::sync::Arc;
fn limits() -> JsonLimits {
    JsonLimits {
        max_bytes: 4 * 1024 * 1024,
        max_nodes: 300_000,
        max_text_units: 2_000_000,
        max_number_bytes: 128,
        max_depth: 64,
    }
}
fn fixture() -> serde_json::Value {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-captured-command-vectors.json"
    ))
    .unwrap();
    f["traces"][0].clone()
}
fn state(f: &serde_json::Value) -> ProjectState {
    ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap()
}
fn encoded(v: &impl Encode) -> Vec<u8> {
    let mut b = vec![];
    v.write_json(&mut b).unwrap();
    b
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok(v.civil_milliseconds()),
    )
}
#[test]
fn record_inputs_preserve_complete_utf16_data_at_every_byte_split() {
    let s = state(&fixture());
    let object = &s.plates[0].objects[0];
    let instance = &object.instances[0];
    let bytes = encoded(instance);
    for split in 0..=bytes.len() {
        let mut input = InstanceInput::new(bytes.len(), limits()).unwrap();
        if split > 0 {
            input.append(0, &bytes[..split]).unwrap();
        }
        if split < bytes.len() {
            input.append(split, &bytes[split..]).unwrap();
        }
        assert_eq!(&input.finish().unwrap(), instance);
    }
    let bytes = encoded(object);
    for split in 0..=bytes.len() {
        let mut input = ObjectInput::new(bytes.len(), limits()).unwrap();
        if split > 0 {
            input.append(0, &bytes[..split]).unwrap();
        }
        if split < bytes.len() {
            input.append(split, &bytes[split..]).unwrap();
        }
        assert_eq!(&input.finish().unwrap(), object);
    }
}
#[test]
fn bulk_limits_are_independent_of_small_request_limits_and_input_chunks_are_owned() {
    let s = state(&fixture());
    let mut instance = (*s.plates[0].objects[0].instances[0]).clone();
    instance.extension_data = Some(
        JsonObject::from_value(Value::Object(
            [
                (
                    "large".encode_utf16().collect(),
                    Value::String(vec![b'x' as u16; 1_100_000]),
                ),
                (
                    "wide".encode_utf16().collect(),
                    Value::Array(vec![Value::Bool(false); 140_000]),
                ),
            ]
            .into(),
        ))
        .unwrap(),
    );
    let source = encoded(&instance);
    assert!(source.len() > 1_048_576);
    assert!(parse(std::str::from_utf8(&source).unwrap()).is_err());
    let mut input = InstanceInput::new(source.len(), limits()).unwrap();
    for (i, chunk) in source.chunks(MAX_CHUNK_BYTES).enumerate() {
        let mut owned = chunk.to_vec();
        input.append(i * MAX_CHUNK_BYTES, &owned).unwrap();
        owned.fill(b'!');
    }
    let captured = input.finish().unwrap();
    assert_eq!(*captured, instance);
    for restricted in [
        JsonLimits {
            max_nodes: 131_072,
            ..limits()
        },
        JsonLimits {
            max_text_units: 1_000_000,
            ..limits()
        },
    ] {
        let mut input = InstanceInput::new(source.len(), restricted).unwrap();
        let mut failed = false;
        for (i, chunk) in source.chunks(MAX_CHUNK_BYTES).enumerate() {
            if let Err(error) = input.append(i * MAX_CHUNK_BYTES, chunk) {
                assert_eq!(error, JsonInputError::Limit);
                failed = true;
                break;
            }
        }
        assert!(failed);
        assert!(matches!(
            input.finish(),
            Err(CommandRecordError::Json(JsonInputError::Failed))
        ));
    }
    assert!(matches!(
        InstanceInput::new(
            source.len(),
            JsonLimits {
                max_bytes: source.len() - 1,
                ..limits()
            }
        ),
        Err(JsonInputError::Limit)
    ));
}
#[test]
fn incomplete_failed_and_malformed_records_never_produce_captures() {
    for json in ["[]", "null", "{}", r#"{"id":"private-invalid-id"}"#] {
        let mut instance = InstanceInput::new(json.len(), limits()).unwrap();
        instance.append(0, json.as_bytes()).unwrap();
        let error = instance.finish().unwrap_err();
        assert!(matches!(error, CommandRecordError::Shape(_)));
        assert!(!format!("{error:?}").contains("private-invalid-id"));
        let mut object = ObjectInput::new(json.len(), limits()).unwrap();
        object.append(0, json.as_bytes()).unwrap();
        assert!(matches!(object.finish(), Err(CommandRecordError::Shape(_))));
    }
    let mut input = InstanceInput::new(3, limits()).unwrap();
    assert_eq!(input.append(1, b"{"), Err(JsonInputError::InvalidOffset));
    assert_eq!(input.received_bytes(), 0);
    assert_eq!(input.append(0, b""), Err(JsonInputError::InvalidChunk));
    input.append(0, b"{").unwrap();
    assert_eq!(input.received_bytes(), 1);
    assert!(matches!(
        input.finish(),
        Err(CommandRecordError::Json(JsonInputError::Incomplete))
    ));
    let mut input = ObjectInput::new(3, limits()).unwrap();
    assert_eq!(input.append(0, b"???"), Err(JsonInputError::InvalidJson));
    assert_eq!(input.append(0, b"{}"), Err(JsonInputError::Failed));
    assert!(matches!(
        input.finish(),
        Err(CommandRecordError::Json(JsonInputError::Failed))
    ));
    let s = state(&fixture());
    let base = encoded(&s.plates[0].objects[0].instances[0]);
    for (field, value) in [
        ("id", serde_json::json!("bad")),
        ("printable", serde_json::Value::Null),
        (
            "transform",
            serde_json::json!({"translationMm":[0,0],"rotation":[0,0,0,1],"scale":[1,1,1]}),
        ),
    ] {
        // The fixture contains escaped lone surrogates, so mutate through the lossless model.
        let mut original = parse(std::str::from_utf8(&base).unwrap()).unwrap();
        let Value::Object(ref mut fields) = original else {
            panic!()
        };
        fields.insert(
            field.encode_utf16().collect(),
            parse(&value.to_string()).unwrap(),
        );
        let mut bytes = vec![];
        original.write_canonical(&mut bytes).unwrap();
        let mut input = InstanceInput::new(bytes.len(), limits()).unwrap();
        input.append(0, &bytes).unwrap();
        assert!(matches!(input.finish(), Err(CommandRecordError::Shape(_))));
    }
}
#[test]
fn persisted_record_duplicate_keys_keep_last_value_and_semantic_checks_wait_for_apply() {
    let s = state(&fixture());
    let bytes = encoded(&s.plates[0].objects[0].instances[0]);
    let mut source = br#"{"printable":true,"printable":false,"#.to_vec();
    source.extend_from_slice(&bytes[1..]);
    let mut input = InstanceInput::new(source.len(), limits()).unwrap();
    input.append(0, &source).unwrap();
    assert_eq!(
        input.finish().unwrap().printable,
        s.plates[0].objects[0].instances[0].printable
    );
    let mut instance = (*s.plates[0].objects[0].instances[0]).clone();
    instance.transform.scale[0] = Number::new(0.0).unwrap();
    let bytes = encoded(&instance);
    let mut input = InstanceInput::new(bytes.len(), limits()).unwrap();
    input.append(0, &bytes).unwrap();
    // Graph admission is exercised by the independent failing command traces.
    assert_eq!(input.finish().unwrap().transform.scale[0].get(), 0.0);
}
#[test]
fn caller_copy_on_write_cannot_change_prepared_instance_or_paste_template() {
    let f = fixture();
    let s = state(&f);
    let object = s.plates[0].objects[0].clone();
    let mut template = object.clone();
    let ids = IndependentObjectIds {
        object_id: ObjectId::try_from_str("import:object:paste").unwrap(),
        volume_ids: object
            .volumes
            .iter()
            .enumerate()
            .map(|(i, _)| VolumeId::try_from_str(&format!("import:volume:paste-{i}")).unwrap())
            .collect(),
        instance_ids: object
            .instances
            .iter()
            .enumerate()
            .map(|(i, _)| InstanceId::try_from_str(&format!("import:instance:paste-{i}")).unwrap())
            .collect(),
        layer_range_ids: object
            .layer_ranges
            .iter()
            .enumerate()
            .map(|(i, _)| LayerRangeId::try_from_str(&format!("import:range:paste-{i}")).unwrap())
            .collect(),
    };
    let pasted_id = ids.object_id.clone();
    let paste = PreparedCommand::paste_object(template.clone(), ids, None, None).unwrap();
    Arc::make_mut(&mut template).name = Text::from_utf8("mutated");
    Arc::make_mut(&mut template).volumes = Arc::from([]);
    let mut instance = object.instances[0].clone();
    Arc::make_mut(&mut instance).id = InstanceId::try_from_str("import:instance:created").unwrap();
    let original = instance.clone();
    let create = PreparedCommand::create_instance(object.id.clone(), instance.clone(), None);
    Arc::make_mut(&mut instance).transform.translation_mm[0] = Number::new(999.0).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(f["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &f["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let store = ProjectStore::admit(ProjectData::new(s).unwrap(), &mut utc()).unwrap();
    let mut bus = CommandBus::new(
        store,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
    );
    assert!(bus.execute(create, true).result.unwrap());
    assert!(Arc::ptr_eq(
        bus.snapshot().state().plates[0].objects[0]
            .instances
            .last()
            .unwrap(),
        &original
    ));
    assert!(bus.execute(paste, true).result.unwrap());
    let current = bus.snapshot();
    let pasted = current.state().plates[0]
        .objects
        .iter()
        .find(|o| o.id == pasted_id)
        .unwrap();
    assert_eq!(
        pasted.name.units(),
        object
            .name
            .units()
            .iter()
            .copied()
            .chain(" copy".encode_utf16())
            .collect::<Vec<_>>()
    );
    assert!(pasted.config.same_allocation(&object.config));
    assert!(Arc::ptr_eq(
        &pasted.volumes[0].annotations,
        &object.volumes[0].annotations
    ));
    assert_eq!(pasted.instances.len(), object.instances.len());
}
