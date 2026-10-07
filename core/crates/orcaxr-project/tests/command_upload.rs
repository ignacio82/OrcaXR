use orcaxr_contracts::{
    canonical::{Value, parse},
    project_intent_types as wire,
};
use orcaxr_project::{
    assets::*, history::*, ids::*, ingress::command_work::*, model::*, selection::*, session::*,
    staging_layout as layout, validation::*,
};
use std::sync::{Arc, Barrier};

fn setup() -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-captured-command-vectors.json"
    ))
    .unwrap();
    let f = &f["traces"][0];
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(f["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &f["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    );
    ProjectSession::new(
        ValidatedProject::new(ProjectData::new(state).unwrap(), &mut policy).unwrap(),
        SelectionStore::default(),
        assets,
        policy,
        HistoryOptions::default(),
        [0, 1, 2, 3],
    )
    .unwrap()
}
fn limits() -> layout::InputOptions {
    layout::InputOptions {
        bytes: 4_000_000,
        nodes: 1_000_000,
        text_units: 4_000_000,
        number_bytes: 1024,
        depth: 128,
        commands: 100,
        input_units: 8_000_000,
        assets: 64,
        asset_bytes: 16_000_000,
    }
}
fn pool() -> StagingLimits {
    StagingLimits {
        max_resources: 4,
        max_commands: 100,
        max_units: 8_000_000,
        max_asset_bytes: 16_000_000,
    }
}
fn json(v: &impl Encode) -> String {
    let mut bytes = vec![];
    v.write_json(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn source<P: TimestampPolicy>(session: &ProjectSession<P>, large: bool) -> String {
    let state = session.snapshot();
    let object = &state.state().plates[0].objects[0];
    let mut record = (*object.instances[0]).clone();
    record.id = InstanceId::try_from_str("import:instance:uploaded").unwrap();
    record.name = Some(Text::new(vec![0xd800, 0, 0xd83d, 0xde00]));
    if large {
        record.extension_data = Some(
            JsonObject::from_value(Value::Object(std::collections::BTreeMap::from([
                (
                    "large".encode_utf16().collect(),
                    Value::String(vec![b'x' as u16; 1_048_600]),
                ),
                (
                    "wide".encode_utf16().collect(),
                    Value::Array(vec![Value::Number(0.); 140_000]),
                ),
            ])))
            .unwrap(),
        );
    }
    format!("[1,[0,[0,{},{},null]]]", json(&object.id), json(&record))
}
fn ready(
    guard: LocalGuard,
    source: &str,
    limits: layout::InputOptions,
) -> Result<CommandUpload, CommandInputError> {
    let mut input = CommandUpload::new(guard, source.len(), limits)?;
    for (i, chunk) in source.as_bytes().chunks(997).enumerate() {
        input.append(i * 997, chunk)?;
    }
    input.seal()?;
    Ok(input)
}
fn code<T>(value: Result<T, CommandInputError>) -> &'static str {
    match value {
        Err(e) => e.code(),
        Ok(_) => panic!("expected refusal"),
    }
}

#[test]
fn bulk_upload_limits_lifetime_guards_and_full_record_execution() {
    let mut owner = setup();
    owner.configure_staging(pool()).unwrap();
    let guard = owner.capture_guard().unwrap();
    let small = source(&owner, false);
    for size in [1, 7, 97, 65536] {
        let mut input = CommandUpload::new(guard.clone(), small.len(), limits()).unwrap();
        assert_eq!(code(input.append(1, b"[")), "invalid_offset");
        assert_eq!(code(input.append(0, b"")), "invalid_chunk");
        for (i, chunk) in small.as_bytes().chunks(size).enumerate() {
            let mut owned = chunk.to_vec();
            input.append(i * size, &owned).unwrap();
            owned.fill(0);
        }
        input.seal().unwrap();
        assert_eq!(input.command_count().unwrap(), 1);
        assert_eq!(code(input.seal()), "input_state");
        let units = input.units().unwrap();
        let id = input.admit(&mut owner).unwrap();
        assert_eq!(owner.staging_usage().units, units);
        assert!(owner.release_staged(id));
    }
    let mut held = (0..layout::MAX_PREPARATIONS)
        .map(|_| ready(guard.clone(), &small, limits()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        code(CommandUpload::new(guard.clone(), small.len(), limits())),
        "resource_limit"
    );
    held[0].cancel();
    let replacement = ready(guard.clone(), &small, limits()).unwrap();
    assert_eq!(code(held[0].seal()), "input_state");
    drop(replacement);
    drop(held);
    let barrier = Arc::new(Barrier::new(layout::MAX_PREPARATIONS + 1));
    let handles = (0..=layout::MAX_PREPARATIONS)
        .map(|_| {
            let guard = guard.clone();
            let barrier = barrier.clone();
            let small = small.clone();
            std::thread::spawn(move || {
                barrier.wait();
                ready(guard, &small, limits())
            })
        })
        .collect::<Vec<_>>();
    let held = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        held.iter().filter(|r| r.is_ok()).count(),
        layout::MAX_PREPARATIONS
    );
    drop(held);

    for invalid in [
        "{}",
        "[2,[0,[2,\"{}\"]]]",
        "[1,[9]]",
        "[1,[0,[9]]]",
        "[1,[0,[0,\"bad\",{},null]]]",
        "[1,[1,\"\",{}]]",
        "[1,[0,[2,\"é\"]]]",
        "[1,[0,[2,\"{}\"],0]]",
    ] {
        assert!(ready(guard.clone(), invalid, limits()).is_err());
    }
    let mut parser = CommandUpload::new(guard.clone(), 3, limits()).unwrap();
    assert_eq!(code(parser.append(0, b"[x]")), "invalid_command");
    assert_eq!(code(parser.seal()), "input_state");
    drop(parser);
    let mut incomplete = CommandUpload::new(guard.clone(), small.len(), limits()).unwrap();
    incomplete.append(0, b"[").unwrap();
    assert_eq!(code(incomplete.seal()), "invalid_command");
    let input = CommandUpload::new(guard.clone(), small.len(), limits()).unwrap();
    assert_eq!(code(input.admit(&mut owner)), "input_state");
    let mut bound = limits();
    bound.bytes = small.len() - 1;
    assert_eq!(
        code(CommandUpload::new(guard.clone(), small.len(), bound)),
        "resource_limit"
    );
    for bound in [
        layout::InputOptions {
            nodes: 1,
            ..limits()
        },
        layout::InputOptions {
            text_units: 1,
            ..limits()
        },
        layout::InputOptions {
            depth: 1,
            ..limits()
        },
        layout::InputOptions {
            commands: 0,
            ..limits()
        },
        layout::InputOptions {
            input_units: 1,
            ..limits()
        },
    ] {
        assert_eq!(code(ready(guard.clone(), &small, bound)), "resource_limit");
    }
    let input = ready(guard.clone(), &small, limits()).unwrap();
    let charge = input.units().unwrap();
    owner
        .configure_staging(StagingLimits {
            max_units: charge - 1,
            ..pool()
        })
        .unwrap();
    assert_eq!(code(input.admit(&mut owner)), "resource_limit");
    owner.configure_staging(pool()).unwrap();
    let input = ready(guard.clone(), &small, limits()).unwrap();
    assert_eq!(code(input.admit(&mut setup())), "stale");
    let input = ready(guard.clone(), &small, limits()).unwrap();
    owner.acknowledge_checkpoint(&guard).unwrap();
    assert_eq!(code(input.admit(&mut owner)), "stale");
    let guard = owner.capture_guard().unwrap();
    let mut other = setup();
    let other_guard = other.capture_guard().unwrap();
    let input = ready(other_guard, &small, limits()).unwrap();
    other.dispose();
    assert_eq!(code(input.admit(&mut other)), "disposed");

    let large = source(&owner, true);
    assert!(large.len() > wire::MAX_BYTES);
    let input = ready(guard, &large, limits()).unwrap();
    let id = input.admit(&mut owner).unwrap();
    let message = |request_id, operation| {
        serde_json::json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":request_id,"operation":operation}).to_string()
    };
    let hello = serde_json::json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}});
    assert!(matches!(
        owner.submit(&message(1, hello)),
        Submission::Ready(_)
    ));
    assert!(matches!(
        owner.submit(&message(
            2,
            serde_json::json!({"executeStaged":{"stagedId":id}})
        )),
        Submission::Queued { .. }
    ));
    let reply = owner.run_next().unwrap();
    assert!(matches!(
        wire::decode_session_reply(reply.wire()).unwrap().result,
        wire::SessionResult::Acknowledged(_)
    ));
    assert_eq!(owner.staging_usage(), StagingUsage::default());
    let state = owner.snapshot();
    let record = state.state().plates[0].objects[0]
        .instances
        .iter()
        .find(|i| {
            i.id.as_utf16()
                == "import:instance:uploaded"
                    .encode_utf16()
                    .collect::<Vec<_>>()
        })
        .unwrap();
    assert_eq!(
        record.name.as_ref().unwrap().units(),
        &[0xd800, 0, 0xd83d, 0xde00]
    );
    assert!(json(record.as_ref()).len() > wire::MAX_BYTES);
    // No failed parse, budget refusal or consumed transfer leaked a preparation permit.
    let guard = owner.capture_guard().unwrap();
    let held = (0..layout::MAX_PREPARATIONS)
        .map(|_| ready(guard.clone(), &small, limits()).unwrap())
        .collect::<Vec<_>>();
    drop(held);
}

#[test]
fn staging_option_decoders_reject_nonfinite_fractional_and_out_of_range_fields() {
    let input = [
        4_000_000.,
        1_000_000.,
        4_000_000.,
        1024.,
        128.,
        100.,
        8_000_000.,
        64.,
        16_000_000.,
    ];
    let pool = [4., 100., 8_000_000., 16_000_000.];
    assert!(layout::decode_input(1., &input).is_some());
    assert!(layout::decode_pool(1., &pool).is_some());
    for version in [0., 2., -1., 0.5, f64::NAN, f64::INFINITY] {
        assert!(layout::decode_input(version, &input).is_none());
        assert!(layout::decode_pool(version, &pool).is_none());
    }
    for values in [&input[..], &pool[..]] {
        for i in 0..values.len() {
            for n in [-1., 0.5, f64::NAN, f64::INFINITY, 4_294_967_296.] {
                let mut invalid = values.to_vec();
                invalid[i] = n;
                if values.len() == input.len() {
                    assert!(layout::decode_input(1., &invalid).is_none());
                } else {
                    assert!(layout::decode_pool(1., &invalid).is_none());
                }
            }
        }
    }
    let mut invalid = input;
    invalid[4] = 129.;
    assert!(layout::decode_input(1., &invalid).is_none());
    invalid = input;
    invalid[3] = 0.;
    assert!(layout::decode_input(1., &invalid).is_none());
    for length in [0, input.len() - 1, input.len() + 1] {
        assert!(layout::decode_input(1., &vec![1.; length]).is_none());
    }
    for length in [0, pool.len() - 1, pool.len() + 1] {
        assert!(layout::decode_pool(1., &vec![1.; length]).is_none());
    }
}

/// An `addVolume` record and its payload from the asset corpus; its object is
/// the shared fixture object this session holds.
fn add_volume_upload() -> (String, Vec<u8>) {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-asset-command-vectors.json"
    ))
    .unwrap();
    let command = f["traces"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["steps"].as_array().unwrap())
        .map(|s| &s["operation"]["command"])
        .find(|c| c["kind"] == "addVolume")
        .unwrap()
        .clone();
    let object: String = command["objectId"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| char::from_u32(n.as_u64().unwrap() as u32).unwrap())
        .collect();
    let json = format!(
        "[1,[0,[{},{},{},{}]]]",
        layout::COMMAND_ADD_VOLUME,
        serde_json::to_string(&object).unwrap(),
        command["recordJson"].as_str().unwrap(),
        command["asset"]["descriptorJson"].as_str().unwrap()
    );
    let bytes = command["asset"]["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    (json, bytes)
}

#[test]
fn payload_uploads_stream_validate_and_refuse() {
    let mut owner = setup();
    owner.configure_staging(pool()).unwrap();
    let guard = owner.capture_guard().unwrap();
    let (json, bytes) = add_volume_upload();
    let sealed = |limits| ready(guard.clone(), &json, limits);

    // Streaming: one payload at a time, at its exact offsets, then validated.
    let mut input = sealed(limits()).unwrap();
    assert_eq!(input.asset_count().unwrap(), 1);
    assert_eq!(code(input.units()), "input_state");
    assert_eq!(code(input.begin_asset(1)), "invalid_asset");
    assert_eq!(code(input.append_asset(0, &bytes[..1])), "input_state");
    assert_eq!(input.begin_asset(0).unwrap(), bytes.len());
    assert_eq!(code(input.begin_asset(0)), "input_state");
    assert_eq!(code(input.append_asset(1, &bytes[..1])), "invalid_offset");
    assert_eq!(code(input.append_asset(0, &[])), "invalid_chunk");
    input.append_asset(0, &bytes[..7]).unwrap();
    assert_eq!(code(input.finish_asset()), "input_state");
    let mut tampered = bytes[7..].to_vec();
    tampered[0] ^= 1;
    input.append_asset(7, &tampered).unwrap();
    // A digest mismatch discards only that payload; the host may stream it again.
    assert_eq!(code(input.finish_asset()), "invalid_asset");
    assert_eq!(input.begin_asset(0).unwrap(), bytes.len());
    for (i, chunk) in bytes.chunks(5).enumerate() {
        input.append_asset(i * 5, chunk).unwrap();
    }
    assert_eq!(code(input.append_asset(bytes.len(), &[0])), "invalid_chunk");
    input.finish_asset().unwrap();
    assert_eq!(input.asset_count().unwrap(), 0);
    assert_eq!(input.command_count().unwrap(), 1);
    assert_eq!(input.asset_bytes().unwrap(), bytes.len() as u64);
    let id = input.admit(&mut owner).unwrap();
    assert_eq!(owner.staging_usage().asset_bytes, bytes.len() as u64);
    assert!(owner.release_staged(id));
    assert_eq!(owner.staging_usage().asset_bytes, 0);

    // Admission needs every payload; it consumes the upload either way.
    assert_eq!(
        code(sealed(limits()).unwrap().admit(&mut owner)),
        "input_state"
    );
    // Upload budgets: payload count and bytes, checked before any byte arrives.
    for bound in [
        layout::InputOptions {
            assets: 0,
            ..limits()
        },
        layout::InputOptions {
            asset_bytes: bytes.len() - 1,
            ..limits()
        },
    ] {
        assert_eq!(code(sealed(bound)), "resource_limit");
    }
    // The pool charges each distinct payload by its length.
    owner
        .configure_staging(StagingLimits {
            max_asset_bytes: bytes.len() as u64 - 1,
            ..pool()
        })
        .unwrap();
    let mut input = sealed(limits()).unwrap();
    input.begin_asset(0).unwrap();
    input.append_asset(0, &bytes).unwrap();
    input.finish_asset().unwrap();
    assert_eq!(code(input.admit(&mut owner)), "resource_limit");
    owner.configure_staging(pool()).unwrap();

    // One asset ID must declare one descriptor throughout an upload.
    let inner = json.trim_start_matches("[1,[0,").trim_end_matches("]]");
    let changed = inner.replacen("\"digest\":", "\"note\":1,\"digest\":", 1);
    assert_ne!(inner, changed);
    let conflict = format!("[1,[1,\"Two volumes\",[{inner},{changed}]]]");
    assert_eq!(
        code(ready(guard.clone(), &conflict, limits())),
        "invalid_command"
    );
    // A refusal while preparing the commands, after the last payload, cancels
    // the whole upload: this guard's volume ID is not stable.
    let descriptor = &inner[inner.rfind(",{").unwrap() + 1..inner.len() - 1];
    let replace = format!(
        "[1,[0,[{},{{\"volumeId\":\"bad\",\"assetId\":\"bad\",\"assetDigest\":\"x\",\"topologyRevision\":0,\"triangleCount\":1}},{descriptor}]]]",
        layout::COMMAND_REPLACE_VOLUME_MESH
    );
    let mut input = ready(guard.clone(), &replace, limits()).unwrap();
    input.begin_asset(0).unwrap();
    input.append_asset(0, &bytes).unwrap();
    assert_eq!(code(input.finish_asset()), "invalid_command");
    assert_eq!(code(input.units()), "input_state");
    assert_eq!(code(input.begin_asset(0)), "input_state");
}
