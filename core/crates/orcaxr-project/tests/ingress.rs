use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    history::HistoryOptions,
    ids::*,
    ingress::{json::*, *},
    model::Encode,
    selection::SelectionStore,
    session::{ProjectSession, Submission},
    validation::*,
};
use serde_json::Value as Json;

fn limits() -> ProjectInputLimits {
    ProjectInputLimits {
        document: JsonLimits {
            max_bytes: 32 * 1024 * 1024,
            max_nodes: 2_000_000,
            max_text_units: 16 * 1024 * 1024,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 100,
        max_asset_bytes: 16 * 1024 * 1024,
        max_total_asset_bytes: 32 * 1024 * 1024,
    }
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    )
}
fn decode(bytes: &[u8], split: usize, limits: JsonLimits) -> Result<Value, JsonInputError> {
    let mut input = JsonInput::new(bytes.len(), limits)?;
    for (i, part) in bytes[..split].chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(i * MAX_CHUNK_BYTES, part)?;
    }
    for (i, part) in bytes[split..].chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(split + i * MAX_CHUNK_BYTES, part)?;
    }
    input.finish()
}
fn canonical(value: &Value) -> String {
    let mut out = vec![];
    value.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn load(source: &str, limits: ProjectInputLimits) -> ProjectBundleInput {
    let mut input = ProjectInput::new(source.len(), limits).unwrap();
    for (i, chunk) in source.as_bytes().chunks(97).enumerate() {
        input.append(i * 97, chunk).unwrap();
    }
    input.finish(&mut utc()).unwrap()
}
fn session_fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-session-vectors.json"
    ))
    .unwrap()
}

#[test]
fn every_byte_split_matches_independent_javascript_lexical_and_canonical_results() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-input-vectors.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let bytes = case["input"].as_str().unwrap().as_bytes();
        for split in 0..=bytes.len() {
            let result = decode(bytes, split, limits().document);
            if let Some(expected) = case["canonical"].as_str() {
                assert_eq!(
                    canonical(&result.unwrap()),
                    expected,
                    "case {} split {split}",
                    case["id"]
                );
            } else {
                assert!(result.is_err(), "case {} split {split}", case["id"]);
            }
        }
        let mut input = JsonInput::new(bytes.len(), limits().document).unwrap();
        let mut failed = false;
        for (i, byte) in bytes.iter().enumerate() {
            if input.append(i, &[*byte]).is_err() {
                failed = true;
                break;
            }
        }
        if let Some(expected) = case["canonical"].as_str() {
            assert_eq!(canonical(&input.finish().unwrap()), expected);
        } else {
            assert!(failed || input.finish().is_err());
        }
    }
}

#[test]
fn utf8_validation_escaping_and_lone_surrogates_survive_chunk_boundaries() {
    // Exhaust every escaped UTF-16 unit, including paired and unpaired surrogates.
    let mut source = String::from("\"");
    for unit in 0..=u16::MAX {
        use std::fmt::Write;
        write!(source, "\\u{unit:04x}").unwrap();
    }
    source.push('"');
    let value = decode(source.as_bytes(), 17, limits().document).unwrap();
    assert_eq!(value, Value::String((0..=u16::MAX).collect()));
    for invalid in [
        vec![0xc0, 0x80],
        vec![0xed, 0xa0, 0x80],
        vec![0xf4, 0x90, 0x80, 0x80],
        vec![0x80],
        vec![0xc2],
        vec![0xe0, 0x80, 0x80],
        vec![0xf0, 0x80, 0x80, 0x80],
        vec![0xe2, 0x28, 0xa1],
        vec![0xff],
        vec![0xf5, 0x80, 0x80, 0x80],
    ] {
        let bytes = [vec![b'"'], invalid, vec![b'"']].concat();
        for split in 0..=bytes.len() {
            assert!(decode(&bytes, split, limits().document).is_err());
        }
    }
}

#[test]
fn explicit_budgets_count_discarded_keys_nodes_and_text_and_refuse_atomically() {
    let l = limits().document;
    assert_eq!(
        decode(b"null", 0, JsonLimits { max_bytes: 3, ..l }),
        Err(JsonInputError::Limit)
    );
    assert!(decode(b"[0,1]", 0, JsonLimits { max_nodes: 3, ..l }).is_ok());
    assert_eq!(
        decode(b"[0,1]", 0, JsonLimits { max_nodes: 2, ..l }),
        Err(JsonInputError::Limit)
    );
    let duplicate = br#"{"x":"a","x":"b"}"#;
    assert!(
        decode(
            duplicate,
            0,
            JsonLimits {
                max_nodes: 3,
                max_text_units: 4,
                ..l
            }
        )
        .is_ok()
    );
    assert_eq!(
        decode(duplicate, 0, JsonLimits { max_nodes: 2, ..l }),
        Err(JsonInputError::Limit)
    );
    assert_eq!(
        decode(
            duplicate,
            0,
            JsonLimits {
                max_text_units: 3,
                ..l
            }
        ),
        Err(JsonInputError::Limit)
    );
    assert!(decode(b"[[]]", 0, JsonLimits { max_depth: 1, ..l }).is_ok());
    assert_eq!(
        decode(b"[[0]]", 0, JsonLimits { max_depth: 1, ..l }),
        Err(JsonInputError::Limit)
    );
    assert_eq!(
        decode(
            b"10",
            0,
            JsonLimits {
                max_number_bytes: 1,
                ..l
            }
        ),
        Err(JsonInputError::Limit)
    );
    assert_eq!(
        decode(
            b"0",
            0,
            JsonLimits {
                max_number_bytes: 0,
                ..l
            }
        ),
        Err(JsonInputError::InvalidLimits)
    );
    assert_eq!(
        decode(
            b"0",
            0,
            JsonLimits {
                max_depth: 129,
                ..l
            }
        ),
        Err(JsonInputError::InvalidLimits)
    );
    let mut input = JsonInput::new(4, l).unwrap();
    assert_eq!(input.append(1, b"nu"), Err(JsonInputError::InvalidOffset));
    assert_eq!(input.append(0, b""), Err(JsonInputError::InvalidChunk));
    assert_eq!(input.append(0, b"null "), Err(JsonInputError::InvalidChunk));
    input.append(0, b"nu").unwrap();
    assert_eq!(input.received_bytes(), 2);
    input.append(2, b"ll").unwrap();
    assert_eq!(input.finish(), Ok(Value::Null));
    let mut input = JsonInput::new(4, l).unwrap();
    assert_eq!(input.append(0, b"bad!"), Err(JsonInputError::InvalidJson));
    assert_eq!(input.append(0, b"null"), Err(JsonInputError::Failed));
    assert_eq!(input.finish(), Err(JsonInputError::Failed));
    assert_eq!(
        JsonInput::new(4, l).unwrap().finish(),
        Err(JsonInputError::Incomplete)
    );
    let mut input = JsonInput::new(MAX_CHUNK_BYTES + 1, l).unwrap();
    assert_eq!(
        input.append(0, &vec![b' '; MAX_CHUNK_BYTES + 1]),
        Err(JsonInputError::InvalidChunk)
    );
    assert_eq!(input.received_bytes(), 0);
    let source = format!("{}0{}", "[".repeat(128), "]".repeat(128));
    assert!(decode(source.as_bytes(), 0, l).is_ok());
    let source = format!("{}0{}", "[".repeat(129), "]".repeat(129));
    assert_eq!(decode(source.as_bytes(), 0, l), Err(JsonInputError::Limit));
    // These operation budgets do not inherit the stateless 100,000-node ceiling.
    let wide = format!("[{}0]", "0,".repeat(100_001));
    assert!(parse(&wide).is_err());
    assert!(decode(wide.as_bytes(), 29, l).is_ok());
    let large = format!("\"{}\"", "x".repeat(2 * 1024 * 1024));
    assert!(parse(&large).is_err());
    assert!(decode(large.as_bytes(), 33, l).is_ok());
}

#[test]
fn actual_reference_documents_and_payloads_create_a_guarded_native_session() {
    let fixture = session_fixture();
    for trace in fixture["traces"].as_array().unwrap() {
        let mut input = load(trace["stateJson"].as_str().unwrap(), limits());
        let id = input.project().state().source_assets[0].id.clone();
        let bytes = trace["asset"]["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        assert_eq!(input.begin_asset(&id).unwrap(), bytes.len());
        for (i, chunk) in bytes.chunks(7).enumerate() {
            input.append_asset(i * 7, chunk).unwrap();
        }
        input.finish_asset().unwrap();
        let (project, assets) = input.finish().unwrap();
        let mut actual_document = vec![];
        project.state().write_json(&mut actual_document).unwrap();
        assert_eq!(
            actual_document,
            trace["stateJson"].as_str().unwrap().as_bytes()
        );
        assert_eq!(
            canonical(assets.peek(&id).unwrap().descriptor()),
            trace["asset"]["descriptorJson"]
        );
        assert_eq!(assets.peek(&id).unwrap().bytes(), bytes);
        assert_eq!(project.fingerprint(), trace["initial"]["snapshot"]["hash"]);
        assert_eq!(assets.bundle_fingerprint(), trace["initial"]["assets"]);
        let mut session = ProjectSession::new(
            project,
            SelectionStore::default(),
            assets,
            utc(),
            HistoryOptions::default(),
            [0, 1, 2147483648, 4294967295],
        )
        .unwrap();
        // Replay the actual first handshake from the independent endpoint trace.
        let source = trace["steps"][0]["requests"][0].as_str().unwrap();
        let Submission::Ready(reply) = session.submit(source) else {
            panic!("expected handshake")
        };
        let expected = &trace["steps"][0]["replies"][0];
        assert_eq!(
            serde_json::from_str::<Json>(reply.wire()).unwrap(),
            *expected
        );
    }
}

#[test]
fn admission_failure_budget_refusal_and_asset_retry_never_publish_partial_bundles() {
    let f = session_fixture();
    let trace = &f["traces"][0];
    let source = trace["stateJson"].as_str().unwrap();
    let mut input = ProjectInput::new(
        source.len(),
        ProjectInputLimits {
            max_assets: 0,
            ..limits()
        },
    )
    .unwrap();
    for (i, c) in source.as_bytes().chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(i * MAX_CHUNK_BYTES, c).unwrap();
    }
    assert!(matches!(
        input.finish(&mut utc()),
        Err(DocumentError::AssetBudget)
    ));
    for policy in [
        ProjectInputLimits {
            max_asset_bytes: 35,
            ..limits()
        },
        ProjectInputLimits {
            max_total_asset_bytes: 35,
            ..limits()
        },
    ] {
        let mut input = ProjectInput::new(source.len(), policy).unwrap();
        for (i, c) in source.as_bytes().chunks(MAX_CHUNK_BYTES).enumerate() {
            input.append(i * MAX_CHUNK_BYTES, c).unwrap();
        }
        assert!(matches!(
            input.finish(&mut utc()),
            Err(DocumentError::AssetBudget)
        ));
    }
    let mut invalid = parse(source).unwrap();
    let Value::Object(fields) = &mut invalid else {
        panic!()
    };
    fields.insert(
        "activePlateId".encode_utf16().collect(),
        Value::String("import:absent:plate".encode_utf16().collect()),
    );
    let invalid = canonical(&invalid);
    let mut input = ProjectInput::new(invalid.len(), limits()).unwrap();
    for (i, c) in invalid.as_bytes().chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(i * MAX_CHUNK_BYTES, c).unwrap();
    }
    assert!(matches!(
        input.finish(&mut utc()),
        Err(DocumentError::Admission(AdmissionError::Invalid(_)))
    ));
    let mut input = ProjectInput::new(source.len(), limits()).unwrap();
    for (i, c) in source.as_bytes().chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(i * MAX_CHUNK_BYTES, c).unwrap();
    }
    assert!(matches!(
        input.finish(&mut |_: &[u16]| Err::<bool, _>("PRIVATE_TIMEZONE_ERROR")),
        Err(DocumentError::Admission(AdmissionError::Timestamp(_)))
    ));
    let mut input = load(source, limits());
    let id = input.project().state().source_assets[0].id.clone();
    assert_eq!(
        input.begin_asset(
            &AssetId::try_from_utf16("import:unknown:a".encode_utf16().collect::<Vec<_>>())
                .unwrap()
        ),
        Err(AssetInputError::UnknownAsset)
    );
    assert_eq!(
        input.append_asset(0, &[0]),
        Err(AssetInputError::NoActiveAsset)
    );
    let bytes = trace["asset"]["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect::<Vec<_>>();
    input.begin_asset(&id).unwrap();
    assert_eq!(input.begin_asset(&id), Err(AssetInputError::Busy));
    assert_eq!(
        input.append_asset(1, &[0]),
        Err(AssetInputError::InvalidOffset)
    );
    assert_eq!(
        input.append_asset(0, &[]),
        Err(AssetInputError::InvalidChunk)
    );
    assert_eq!(input.finish_asset(), Err(AssetInputError::Incomplete));
    input.cancel_asset();
    assert_eq!(input.loaded_assets(), 0);
    input.begin_asset(&id).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    input.append_asset(0, &corrupt).unwrap();
    assert_eq!(
        input.finish_asset(),
        Err(AssetInputError::Asset(AssetError::DigestMismatch))
    );
    assert_eq!(input.loaded_assets(), 0);
    assert_eq!(input.finish_asset(), Err(AssetInputError::NoActiveAsset));
    input.begin_asset(&id).unwrap();
    input.append_asset(0, &bytes).unwrap();
    input.finish_asset().unwrap();
    assert_eq!(input.begin_asset(&id), Err(AssetInputError::AlreadyLoaded));
    let (_, assets) = input.finish().unwrap();
    assert_eq!(assets.peek(&id).unwrap().bytes(), bytes);
    assert!(matches!(
        load(source, limits()).finish(),
        Err(AssetInputError::Incomplete)
    ));
}

#[test]
fn owned_asset_transfer_validates_without_copying_or_weakening_immutability() {
    let bytes = vec![17u8; 8 * 1024 * 1024];
    let pointer = bytes.as_ptr();
    let descriptor = parse(&format!(
        r#"{{"id":"import:asset:owned","byteLength":{},"digest":"{}"}}"#,
        bytes.len(),
        content_digest(&bytes)
    ))
    .unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put_owned(AssetPayload {
            descriptor: descriptor.clone(),
            bytes,
        })
        .unwrap();
    let id =
        AssetId::try_from_utf16("import:asset:owned".encode_utf16().collect::<Vec<_>>()).unwrap();
    let lease = assets.peek(&id).unwrap();
    assert_eq!(lease.bytes().as_ptr(), pointer);
    let version = assets.capture_internal();
    assert!(!assets.put_owned(assets.get(&id).unwrap()).unwrap());
    assert!(version.same_version(&assets.capture_internal()));
    let bad = AssetPayload {
        descriptor: descriptor.clone(),
        bytes: vec![18; lease.bytes().len()],
    };
    assert_eq!(assets.put_owned(bad), Err(AssetError::DigestMismatch));
    let mut conflict = assets.get(&id).unwrap();
    let Value::Object(fields) = &mut conflict.descriptor else {
        panic!()
    };
    fields.insert("foreign".encode_utf16().collect(), Value::Bool(true));
    assert_eq!(
        assets.put_owned(conflict),
        Err(AssetError::ImmutableConflict)
    );
    assert!(version.same_version(&assets.capture_internal()));
    drop(assets);
    assert_eq!(lease.bytes().as_ptr(), pointer);
}

#[test]
fn empty_documents_and_empty_declared_assets_finalize_without_dummy_chunks() {
    let f: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-model-vectors.json"
    ))
    .unwrap();
    let source = f["factories"][0]["stateJson"].as_str().unwrap();
    let (project, assets) = load(
        source,
        ProjectInputLimits {
            max_assets: 0,
            max_asset_bytes: 0,
            max_total_asset_bytes: 0,
            ..limits()
        },
    )
    .finish()
    .unwrap();
    assert!(assets.is_empty());
    assert_eq!(project.fingerprint(), f["factories"][0]["fingerprint"]);
    let mut state = parse(source).unwrap();
    let Value::Object(fields) = &mut state else {
        panic!()
    };
    fields.insert("sourceAssets".encode_utf16().collect(),parse(r#"[{"id":"import:asset:empty","kind":"mesh","mediaType":"application/vnd.orcaxr.indexed-mesh","byteLength":0,"digest":"fnv1a64:cbf29ce484222325","mesh":{"positions":{"byteLength":0,"byteOffset":0,"componentCount":3,"componentType":"float32","count":0},"triangleCount":0}}]"#).unwrap());
    let mut bundle = load(&canonical(&state), limits());
    let id = bundle.project().state().source_assets[0].id.clone();
    assert_eq!(bundle.begin_asset(&id), Ok(0));
    bundle.finish_asset().unwrap();
    let (_, assets) = bundle.finish().unwrap();
    assert!(assets.peek(&id).unwrap().bytes().is_empty());
}
