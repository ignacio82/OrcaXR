use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::assets::{
    AssetError, AssetLease, AssetPayload, AssetRepository, AssetSnapshot, content_digest,
};
use orcaxr_project::ids::AssetId;
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use std::sync::Arc;

fn canonical(value: &Value) -> String {
    let mut output = Vec::new();
    value.write_canonical(&mut output).unwrap();
    String::from_utf8(output).unwrap()
}
fn units(value: &Json) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| u16::try_from(value.as_u64().unwrap()).unwrap())
        .collect()
}
fn id(value: &Json) -> AssetId {
    AssetId::try_from_utf16(units(value)).unwrap()
}
fn payload(value: &Json) -> AssetPayload {
    AssetPayload {
        descriptor: parse(value["descriptorJson"].as_str().unwrap()).unwrap(),
        bytes: value["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    }
}
fn encode(value: &AssetPayload) -> Json {
    json!({"descriptorJson":canonical(&value.descriptor),"bytes":value.bytes})
}
fn error_code(error: AssetError) -> &'static str {
    match error {
        AssetError::InvalidDescriptor => "invalidDescriptor",
        AssetError::ByteLengthMismatch => "byteLengthMismatch",
        AssetError::DigestMismatch => "digestMismatch",
        AssetError::ImmutableConflict => "immutableConflict",
        AssetError::DuplicateId => "duplicateId",
        AssetError::ForeignSnapshot => "foreignSnapshot",
        AssetError::ForeignSelection => "foreignSelection",
        AssetError::MissingAsset => "missingAsset",
        AssetError::SelectionLimit => "selectionLimit",
    }
}
struct Observations {
    versions: Vec<AssetSnapshot>,
    records: Vec<AssetLease>,
}
impl Observations {
    fn state(&mut self, repository: &AssetRepository) -> Json {
        let version = repository.capture_internal();
        let index = match self
            .versions
            .iter()
            .position(|value| value.same_version(&version))
        {
            Some(index) => index,
            None => {
                self.versions.push(version);
                self.versions.len() - 1
            }
        };
        let entries = repository
            .list()
            .iter()
            .map(|payload| {
                let Value::Object(descriptor) = &payload.descriptor else {
                    panic!()
                };
                let Value::String(units) = &descriptor[&"id".encode_utf16().collect::<Vec<_>>()]
                else {
                    panic!()
                };
                let lease = repository
                    .peek(&AssetId::try_from_utf16(units.clone()).unwrap())
                    .unwrap();
                let record = match self
                    .records
                    .iter()
                    .position(|value| value.same_record(&lease))
                {
                    Some(index) => index,
                    None => {
                        self.records.push(lease);
                        self.records.len() - 1
                    }
                };
                let mut result = encode(payload);
                result["record"] = json!(record + 1);
                result
            })
            .collect::<Vec<_>>();
        json!({"version":index+1,"entries":entries,"fingerprint":repository.bundle_fingerprint()})
    }
}
#[test]
fn replays_every_reference_operation_and_compares_content_identity_errors_and_fingerprints() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/asset-repository-vectors.json"
    ))
    .unwrap();
    let assets = fixture["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(payload)
        .collect::<Vec<_>>();
    let mut repository = AssetRepository::new();
    let mut snapshots = BTreeMap::new();
    let mut captures = BTreeMap::new();
    let mut observed = Observations {
        versions: vec![],
        records: vec![],
    };
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let operation = &step["operation"];
        let name = operation["name"].as_str().unwrap_or("");
        let result: Result<Json, AssetError> = (|| {
            match operation["kind"].as_str().unwrap() {
                "put" => {
                    let asset = &assets[operation["asset"].as_u64().unwrap() as usize];
                    repository.put(&asset.descriptor, &asset.bytes)?;
                }
                "remove" => {
                    repository.remove(&id(&operation["idUtf16"]));
                }
                "snapshot" => {
                    snapshots.insert(name.to_owned(), repository.capture_internal());
                }
                "restoreInternal" => repository.restore_internal(&snapshots[name])?,
                "foreign" => {
                    repository.restore_internal(&AssetRepository::new().capture_internal())?
                }
                "capture" => {
                    captures.insert(name.to_owned(), repository.capture());
                }
                "restoreCapture" => repository.restore(&captures[name])?,
                "restore" => {
                    let values = operation["assets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| assets[v.as_u64().unwrap() as usize].clone())
                        .collect::<Vec<_>>();
                    repository.restore(&values)?;
                }
                "has" => return Ok(json!(repository.has(&id(&operation["idUtf16"])))),
                "get" => {
                    return Ok(repository
                        .get(&id(&operation["idUtf16"]))
                        .as_ref()
                        .map(encode)
                        .unwrap_or(Json::Null));
                }
                "find" => {
                    return Ok(repository
                        .find_by_digest(&units(&operation["digestUtf16"]))
                        .as_ref()
                        .map(encode)
                        .unwrap_or(Json::Null));
                }
                "mutateCopies" => {
                    let mut copies = repository.list();
                    copies.extend(repository.capture());
                    copies.extend(repository.get(&id(&operation["idUtf16"])));
                    copies.extend(repository.find_by_digest(&units(&operation["digestUtf16"])));
                    for copy in &mut copies {
                        copy.bytes.fill(200);
                        let Value::Object(fields) = &mut copy.descriptor else {
                            panic!()
                        };
                        fields.insert(
                            "sourceFilename".encode_utf16().collect(),
                            Value::String("caller mutation".encode_utf16().collect()),
                        );
                    }
                }
                unknown => panic!("Unhandled trace operation {unknown}"),
            }
            Ok(Json::Null)
        })();
        match result {
            Ok(value) => {
                assert!(step["error"].is_null(), "step {index}");
                assert_eq!(value, step["result"], "result step {index}");
            }
            Err(error) => assert_eq!(
                json!(error_code(error)),
                step["error"],
                "error step {index}"
            ),
        }
        assert_eq!(
            observed.state(&repository),
            step["state"],
            "repository state after step {index}"
        );
    }
}

fn descriptor(digest: &str, length: usize) -> Value {
    parse(&format!(r#"{{"id":"import:test:asset","kind":"mesh","digest":"{digest}","byteLength":{length},"mediaType":"application/octet-stream"}}"#)).unwrap()
}
fn field_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Value {
    let Value::Object(fields) = value else {
        panic!()
    };
    fields
        .get_mut(&key.encode_utf16().collect::<Vec<_>>())
        .unwrap()
}
#[test]
fn owned_boundaries_reject_invalid_payloads_atomically_and_never_reveal_private_metadata() {
    let mut repository = AssetRepository::new();
    let descriptor = descriptor("opaque", 3);
    repository.put(&descriptor, &[1, 2, 3]).unwrap();
    let before = repository.capture_internal();
    for invalid in [
        Value::Null,
        Value::Array(vec![]),
        Value::Object(BTreeMap::new()),
    ] {
        assert_eq!(
            repository.put(&invalid, &[]),
            Err(AssetError::InvalidDescriptor)
        );
    }
    let mut invalid = descriptor.clone();
    *field_mut(&mut invalid, "id") = Value::String("private-invalid".encode_utf16().collect());
    let error = repository.put(&invalid, &[1, 2, 3]).unwrap_err();
    assert_eq!(error, AssetError::InvalidDescriptor);
    assert!(!error.to_string().contains("private"));
    *field_mut(&mut invalid, "id") = Value::String("import:test:asset".encode_utf16().collect());
    *field_mut(&mut invalid, "byteLength") = Value::Number(f64::NAN);
    assert_eq!(
        repository.put(&invalid, &[1, 2, 3]),
        Err(AssetError::ByteLengthMismatch)
    );
    let mut invalid = descriptor.clone();
    let Value::Object(fields) = &mut invalid else {
        panic!()
    };
    fields.insert(vec![0xd800], Value::Number(f64::INFINITY));
    assert_eq!(
        repository.put(&invalid, &[1, 2, 3]),
        Err(AssetError::InvalidDescriptor)
    );
    assert!(before.same_version(&repository.capture_internal()));
    let mut returned = repository
        .get(&AssetId::try_from_str("import:test:asset").unwrap())
        .unwrap();
    returned.bytes.fill(0);
    *field_mut(&mut returned.descriptor, "byteLength") = Value::Number(0.0);
    assert_eq!(
        repository.restore(&[returned]),
        Err(AssetError::ByteLengthMismatch)
    );
    assert!(before.same_version(&repository.capture_internal()));
}

#[test]
fn leases_and_snapshots_share_large_payloads_across_branching_and_cross_thread_reads() {
    let bytes = vec![0x8f; 8 * 1024 * 1024];
    let descriptor = descriptor("opaque", bytes.len());
    let id = AssetId::try_from_str("import:test:asset").unwrap();
    let mut repository = AssetRepository::new();
    repository.put(&descriptor, &bytes).unwrap();
    let lease = repository.peek(&id).unwrap();
    assert_ne!(lease.bytes().as_ptr(), bytes.as_ptr());
    let bytes_pointer = lease.bytes().as_ptr();
    let original = repository.capture_internal();
    let fingerprint = repository.bundle_fingerprint().to_owned();
    for _ in 0..100 {
        repository.remove(&id);
        repository.restore_internal(&original).unwrap();
        let current = repository.peek(&id).unwrap();
        assert!(lease.same_record(&current));
        assert_eq!(current.bytes().as_ptr(), bytes_pointer);
        assert_eq!(repository.bundle_fingerprint(), fingerprint);
    }
    let repository = Arc::new(repository);
    let threads = (0..4)
        .map(|_| {
            let owned = Arc::clone(&repository);
            std::thread::spawn(move || owned.bundle_fingerprint().to_owned())
        })
        .collect::<Vec<_>>();
    for thread in threads {
        assert_eq!(thread.join().unwrap(), fingerprint);
    }
    drop(repository);
    assert_eq!(lease.bytes(), bytes);
    assert_eq!(lease.content_digest(), content_digest(&bytes));
}

#[test]
fn canonical_equivalence_preserves_no_op_and_unknown_metadata_participates_in_immutability() {
    let mut repository = AssetRepository::new();
    let descriptor=parse(r#"{"id":"import:test:asset","byteLength":0,"digest":"opaque","metadata":{"zero":-0,"__proto__":{"hidden":true},"2":2,"10":10}}"#).unwrap();
    repository.put(&descriptor, &[]).unwrap();
    let before = repository.capture_internal();
    let equivalent = parse(&canonical(&descriptor)).unwrap();
    assert_eq!(repository.put(&equivalent, &[]), Ok(false));
    assert!(before.same_version(&repository.capture_internal()));
    let different=parse(r#"{"id":"import:test:asset","byteLength":0,"digest":"opaque","metadata":{"zero":0,"2":2,"10":10}}"#).unwrap();
    assert_eq!(
        repository.put(&different, &[]),
        Err(AssetError::ImmutableConflict)
    );
}
