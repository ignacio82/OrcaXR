use orcaxr_archive::{
    Archive, ZipLimits,
    opc::{self, Authoring, Source, Warning},
};
use orcaxr_contracts::canonical::{Value as Canonical, parse};
use orcaxr_project::model::{Decode, Encode, ProjectState};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Cursor, Write};
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/opc-vectors.json"
    ))
    .unwrap()
}
fn limits() -> opc::Limits {
    opc::Limits {
        part_bytes: 4 << 20,
        tag_bytes: 1 << 20,
        records: 4096,
        text_units: 4 << 20,
        output_bytes: 4 << 20,
    }
}
fn bytes(s: &str) -> Vec<u8> {
    s.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn state(c: &Value) -> ProjectState {
    ProjectState::from_value(parse(c["stateJson"].as_str().unwrap()).unwrap()).unwrap()
}
fn archive(c: &Value) -> Archive<Cursor<Vec<u8>>> {
    Archive::open(
        Cursor::new(bytes(c["archiveHex"].as_str().unwrap())),
        ZipLimits::default(),
        || false,
    )
    .unwrap()
}
fn case<'a>(c: &'a Value, name: &str) -> &'a Value {
    c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
}
fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn warn(w: &Warning) -> Vec<u16> {
    let mut result = Vec::new();
    let mut push = |s: &str| result.extend(s.encode_utf16());
    match w {
        Warning::IncompleteRelationship { source } => push(&format!(
            "Ignored an incomplete OPC relationship in {}",
            source.member()
        )),
        Warning::MissingContentTypes => push(
            "3MF is missing [Content_Types].xml; a valid content-type manifest will be generated on save",
        ),
        Warning::MissingRelationshipTarget { source, id, target } => {
            push("Preserved OPC relationship ");
            result.extend(id.units());
            result.extend(units(&format!(" from {}, but target ", source.member())));
            result.extend(target.units());
            result.extend(units(" is missing"));
        }
        Warning::MissingOverride { part_name } => {
            push("Preserved content-type override for missing package part ");
            result.extend(part_name.units());
        }
        Warning::DroppedRelationships { count, targets } => {
            push(&format!(
                "Dropped {count} preserved package relationship(s) whose target is not part of this archive: "
            ));
            for (i, target) in targets.iter().enumerate() {
                if i != 0 {
                    result.extend(units(", "));
                }
                result.extend(target.units());
            }
        }
    }
    result
}
fn warnings(w: &[Warning]) -> Value {
    serde_json::to_value(w.iter().map(warn).collect::<Vec<_>>()).unwrap()
}
#[test]
fn production_merges_warnings_and_deterministic_outputs() {
    let c = corpus();
    let mut mismatches = Vec::new();
    for case in c["cases"].as_array().unwrap() {
        let mut state = state(case);
        let mut archive = archive(case);
        let result = opc::read(&mut archive, &state, limits(), || false);
        let want = &case["expected"];
        if result.is_ok() == want.is_null() {
            mismatches.push(format!("{}: {:?}", case["name"], result.err()));
            continue;
        }
        if want.is_null() {
            continue;
        }
        let warnings_actual = result.unwrap().apply(&mut state).unwrap();
        assert_eq!(
            warnings(&warnings_actual),
            want["warnings"],
            "{}",
            case["name"]
        );
        let mut out = Vec::new();
        state.write_json(&mut out).unwrap();
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            want["stateJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        // The actual remaining member inventory, including unknown parts, is
        // the writer's authority; no generated/opaque member is guessed here.
        let author = Authoring::new(
            &state,
            archive
                .entries()
                .iter()
                .filter(|e| !e.is_directory())
                .map(|e| e.path()),
            limits(),
            || false,
        );
        for name in ["root", "model", "types"] {
            let mut bytes = Vec::new();
            let got = match &author {
                Err(e) => Err(*e),
                Ok(a) => {
                    if name == "types" {
                        a.write_content_types(&mut bytes, || false)
                            .map(|()| Vec::new())
                    } else {
                        a.write_relationships(
                            if name == "root" {
                                Source::Root
                            } else {
                                Source::Model
                            },
                            &mut bytes,
                            || false,
                        )
                    }
                }
            };
            let expected = &want["outputs"][name];
            assert_eq!(
                got.is_ok(),
                !expected.is_null(),
                "{} {name}: {:?}",
                case["name"],
                got.err()
            );
            if !expected.is_null() {
                assert_eq!(
                    std::str::from_utf8(&bytes).unwrap(),
                    expected["text"].as_str().unwrap(),
                    "{} {name}",
                    case["name"]
                );
                assert_eq!(warnings(&got.unwrap()), expected["warnings"]);
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
#[test]
fn target_paths_preserve_browser_utf16_resolution() {
    for c in corpus()["paths"].as_array().unwrap() {
        let source = if c["source"] == "/" {
            Source::Root
        } else {
            Source::Model
        };
        let target = c["target"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect::<Vec<_>>();
        let result = opc::resolve_target(source, &target);
        assert_eq!(result.is_ok(), !c["resolved"].is_null(), "{c:?}");
        if let Ok(result) = result {
            assert_eq!(serde_json::to_value(result).unwrap(), c["resolved"]);
        }
    }
}
#[test]
fn reference_sources_match() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for s in corpus()["sources"].as_array().unwrap() {
        let b = std::fs::read(root.join(s["path"].as_str().unwrap())).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(b)),
            s["sha256"].as_str().unwrap(),
            "{}",
            s["path"]
        );
    }
}
#[test]
fn budgets_cancellation_and_private_io_failures() {
    let corpus = corpus();
    let c = case(&corpus, "generated-baseline");
    let state = state(c);
    for n in 0..5 {
        let mut limits = limits();
        match n {
            0 => limits.part_bytes = 1,
            1 => limits.tag_bytes = 5,
            2 => limits.records = 0,
            3 => limits.text_units = 1,
            _ => limits.tag_bytes = 0,
        };
        assert!(opc::read(&mut archive(c), &state, limits, || false).is_err());
    }
    assert!(matches!(
        opc::read(&mut archive(c), &state, limits(), || true),
        Err(opc::Error::Cancelled)
    ));
    let mut small = limits();
    small.output_bytes = 20;
    let a = Authoring::new(&state, ["3D/3dmodel.model"], small, || false).unwrap();
    assert_eq!(
        a.write_content_types(&mut Vec::new(), || false),
        Err(opc::Error::ResourceLimit)
    );
    struct Bad;
    impl Write for Bad {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private filename",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let a = Authoring::new(&state, ["3D/3dmodel.model"], limits(), || false).unwrap();
    let error = a.write_content_types(&mut Bad, || false).unwrap_err();
    assert_eq!(error, opc::Error::Io(io::ErrorKind::PermissionDenied));
    assert!(!format!("{error:?}").contains("private"));
}
#[test]
fn metadata_consumption_preserves_shared_snapshots_and_unique_payload_allocation() {
    use orcaxr_project::model::JsonObject;
    let raw = parse("{\"data\":[1,2,3]}").unwrap();
    let Canonical::Object(ref fields) = raw else {
        unreachable!()
    };
    let Canonical::Array(ref elements) = fields[&units("data")] else {
        unreachable!()
    };
    let pointer = elements.as_ptr();
    let object = JsonObject::new(raw).unwrap();
    let moved = object.into_value();
    let Canonical::Object(fields) = moved else {
        unreachable!()
    };
    let Canonical::Array(elements) = &fields[&units("data")] else {
        unreachable!()
    };
    assert_eq!(pointer, elements.as_ptr());
    let object = JsonObject::new(Canonical::Object(fields)).unwrap();
    let retained = object.clone();
    let mut private = object.into_value();
    let Canonical::Object(ref mut fields) = private else {
        unreachable!()
    };
    fields.insert(units("new"), Canonical::Bool(true));
    assert_ne!(retained.value(), &private);
}

#[test]
fn staged_reconciliation_revalidates_and_keeps_asset_and_archive_ownership() {
    use orcaxr_archive::canonical::CanonicalArchiveSource;
    use orcaxr_project::ingress::{ProjectInputLimits, json::JsonLimits};
    let corpus = corpus();
    let c = case(&corpus, "preserved-fragment-query-dangling");
    let input = ProjectInputLimits {
        document: JsonLimits {
            max_bytes: 1 << 20,
            max_nodes: 1 << 20,
            max_text_units: 1 << 20,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 4096,
        max_asset_bytes: 1 << 20,
        max_total_asset_bytes: 1 << 20,
    };
    let mut timestamps = |_: &[u16]| Ok::<_, ()>(true);
    let source =
        CanonicalArchiveSource::decode(archive(c), input, &mut timestamps, || false).unwrap();
    let id = source.project().state().source_assets[0].id.clone();
    let lease = source.asset(&id).unwrap();
    let before = source.project().clone();
    let (mut reconciled, report) = source
        .reconcile_opc(limits(), &mut timestamps, || false)
        .unwrap();
    assert_eq!(warnings(&report), c["expected"]["warnings"]);
    assert!(lease.same_record(&reconciled.asset(&id).unwrap()));
    let mut encoded = Vec::new();
    reconciled
        .project()
        .state()
        .write_json(&mut encoded)
        .unwrap();
    assert_eq!(
        std::str::from_utf8(&encoded).unwrap(),
        c["expected"]["stateJson"].as_str().unwrap()
    );
    let mut original = Vec::new();
    before.state().write_json(&mut original).unwrap();
    assert_eq!(
        std::str::from_utf8(&original).unwrap(),
        c["stateJson"].as_str().unwrap()
    );
    let member = reconciled
        .entries()
        .iter()
        .position(|e| e.path() == "Metadata/note.txt")
        .unwrap();
    let mut bytes = Vec::new();
    reconciled
        .read_member(member, &mut bytes, || false)
        .unwrap();
    assert_eq!(bytes, b"opaque fixture");
    let result = reconciled.reconcile_opc(limits(), &mut timestamps, || true);
    assert!(result.is_err());
    assert_eq!(lease.bytes().len(), 36);
}
