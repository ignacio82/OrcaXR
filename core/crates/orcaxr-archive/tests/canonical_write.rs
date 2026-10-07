use orcaxr_archive::canonical::{
    ENVELOPE_PATH,
    write::{self, Error, Limits},
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    ids::AssetId,
    model::{Decode, Encode, ProjectData, ProjectState},
    validation::ValidatedProject,
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Write},
};
fn limits() -> Limits {
    Limits {
        assets: 4096,
        path_bytes: 512,
        state_nodes: 8_000_000,
        state_depth: 256,
        output_bytes: 64 << 20,
    }
}
fn admit(state: ProjectState) -> ValidatedProject {
    ValidatedProject::new(ProjectData::new(state).unwrap(), &mut |text: &[u16]| {
        Ok::<_, ()>(
            text.iter()
                .copied()
                .eq("2026-07-17T00:00:00.000Z".encode_utf16()),
        )
    })
    .unwrap()
}
fn source() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-model-vectors.json"
    ))
    .unwrap()
}
fn baseline() -> ValidatedProject {
    admit(
        ProjectState::from_value(
            parse(source()["cases"][0]["stateJson"].as_str().unwrap()).unwrap(),
        )
        .unwrap(),
    )
}
#[test]
fn complete_envelopes_match_independent_full_browser_exports() {
    let references: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/package-vectors.json"
    ))
    .unwrap();
    let sources: BTreeMap<_, Json> = [
        (
            "package-input",
            include_str!("../../../../testdata/cross-platform/package-input-vectors.json"),
        ),
        (
            "bbs-model",
            include_str!("../../../../testdata/cross-platform/bbs-model-vectors.json"),
        ),
        (
            "bbs-metadata",
            include_str!("../../../../testdata/cross-platform/bbs-metadata-vectors.json"),
        ),
        (
            "bbs-settings",
            include_str!("../../../../testdata/cross-platform/bbs-settings-vectors.json"),
        ),
    ]
    .into_iter()
    .map(|(n, s)| (n, serde_json::from_str(s).unwrap()))
    .collect();
    let mut count = 0;
    for row in references["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("members").is_some())
    {
        let input = &sources[row["source"].as_str().unwrap()]["cases"]
            [row["index"].as_u64().unwrap() as usize];
        let project = admit(
            ProjectState::from_value(parse(input["stateJson"].as_str().unwrap()).unwrap()).unwrap(),
        );
        let mappings: Vec<_> = row["mappings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    AssetId::try_from_utf16(
                        m["assetId"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                    )
                    .unwrap(),
                    m["path"].as_str().unwrap(),
                )
            })
            .collect();
        // The encoder owns canonical ID ordering, not caller enumeration order.
        let maps: Vec<_> = mappings.iter().rev().map(|(id, p)| (id, *p)).collect();
        let mut output = vec![];
        let bytes = write::envelope(&project, &maps, &mut output, limits(), || false)
            .unwrap_or_else(|e| panic!("{}: {e:?}", row["name"]));
        let expected = row["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["path"] == ENVELOPE_PATH)
            .unwrap();
        assert_eq!(
            bytes,
            expected["bytes"].as_u64().unwrap() as usize,
            "{}",
            row["name"]
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(&output)),
            expected["sha256"].as_str().unwrap(),
            "{}",
            row["name"]
        );
        count += 1;
    }
    assert_eq!(
        count,
        references["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r.get("members").is_some())
            .count()
    );
}
#[test]
fn mappings_limits_unsafe_keys_and_depth_fail_without_a_successful_receipt() {
    let base = baseline();
    let id = &base.state().source_assets[0].id;
    assert_eq!(
        write::envelope(&base, &[], &mut vec![], limits(), || false),
        Err(Error::Mapping)
    );
    for path in ["../escape", "Metadata/model_settings.config", ENVELOPE_PATH] {
        assert_eq!(
            write::envelope(&base, &[(id, path)], &mut vec![], limits(), || false),
            Err(Error::Path)
        );
    }
    for field in 0..5 {
        let mut l = limits();
        match field {
            0 => l.assets = 0,
            1 => l.path_bytes = 1,
            2 => l.state_nodes = 1,
            3 => l.state_depth = 0,
            _ => l.output_bytes = 1,
        };
        assert!(write::envelope(&base, &[(id, "asset.bin")], &mut vec![], l, || false).is_err());
    }
    for key in ["__proto__", "prototype", "constructor"] {
        let Value::Object(mut fields) = base.state().to_value().unwrap() else {
            panic!()
        };
        fields.insert(
            "extra".encode_utf16().collect(),
            Value::Object(BTreeMap::from([(
                key.encode_utf16().collect(),
                Value::Bool(true),
            )])),
        );
        let project = admit(ProjectState::from_value(Value::Object(fields)).unwrap());
        assert_eq!(
            write::envelope(
                &project,
                &[(&project.state().source_assets[0].id, "asset.bin")],
                &mut vec![],
                limits(),
                || false
            ),
            Err(Error::UnsafeKey)
        );
    }
    // The state root is depth 0; its extra value is depth 1.
    for (depth, allowed) in [(254, true), (255, true), (256, false)] {
        let mut nested = Value::Null;
        for _ in 0..depth {
            nested = Value::Array(vec![nested]);
        }
        let Value::Object(mut fields) = base.state().to_value().unwrap() else {
            panic!()
        };
        fields.insert("extra".encode_utf16().collect(), nested);
        let project = admit(ProjectState::from_value(Value::Object(fields)).unwrap());
        let result = write::envelope(
            &project,
            &[(&project.state().source_assets[0].id, "asset.bin")],
            &mut vec![],
            limits(),
            || false,
        );
        assert_eq!(result.is_ok(), allowed, "{depth}: {result:?}");
    }
}
#[test]
fn short_interrupted_and_failed_host_output_stays_private_and_cancellable() {
    struct Host {
        bytes: Vec<u8>,
        calls: usize,
        forever: bool,
        private: bool,
    }
    impl Write for Host {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.private {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private credential path",
                ));
            }
            if self.forever || self.calls % 3 == 1 {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = b.len().min(7);
            self.bytes.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host owns flush")
        }
    }
    let project = baseline();
    let mappings = [(&project.state().source_assets[0].id, "asset.bin")];
    let mut expected = vec![];
    write::envelope(&project, &mappings, &mut expected, limits(), || false).unwrap();
    let mut host = Host {
        bytes: vec![],
        calls: 0,
        forever: false,
        private: false,
    };
    write::envelope(&project, &mappings, &mut host, limits(), || false).unwrap();
    assert_eq!(host.bytes, expected);
    for private in [false, true] {
        let mut host = Host {
            bytes: vec![],
            calls: 0,
            forever: true,
            private,
        };
        let mut calls = 0;
        let result = write::envelope(&project, &mappings, &mut host, limits(), || {
            calls += 1;
            calls > 100_000
        });
        assert_eq!(
            result,
            Err(if private {
                Error::Io(io::ErrorKind::PermissionDenied)
            } else {
                Error::Cancelled
            })
        );
        assert!(!format!("{result:?}").contains("credential"));
    }
    assert_eq!(
        write::envelope(&project, &mappings, &mut &mut [][..], limits(), || false),
        Err(Error::Io(io::ErrorKind::WriteZero))
    );
}
