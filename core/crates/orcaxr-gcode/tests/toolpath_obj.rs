//! File → Export Toolpaths as OBJ… (`toolpath-obj-vectors.json`, from the
//! browser's `exportToolpathsToObj`): every case's file byte for byte, whole
//! or by SHA-256 and length, from the same text, directly and through a
//! sealed session whatever its options.
use orcaxr_gcode::{Cancellation, Session, toolpath_obj};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/toolpath-obj-vectors.json"
    ))
    .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn expect(case: &Json, written: toolpath_obj::Written, obj: &[u8]) {
    let name = case["name"].as_str().unwrap();
    assert_eq!(
        written.segments,
        case["segments"].as_u64().unwrap(),
        "{name}"
    );
    assert_eq!(written.bytes, obj.len() as u64, "{name}");
    match case["obj"].as_str() {
        Some(whole) => assert_eq!(std::str::from_utf8(obj).unwrap(), whole, "{name}"),
        None => assert_eq!(
            (obj.len() as u64, hex(obj)),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap().to_owned()
            ),
            "{name}"
        ),
    }
}

#[test]
fn every_toolpath_obj_is_the_browsers() {
    let fixture = corpus();
    let cases = fixture["cases"].as_array().unwrap();
    for case in cases {
        let units: Vec<u16> = case["source"].as_str().unwrap().encode_utf16().collect();
        let mut obj = Vec::new();
        let written = toolpath_obj::write(&units, &mut obj, &Cancellation::default()).unwrap();
        expect(case, written, &obj);

        // A session parses for its own windows with its own limits; the export
        // is the browser's parse of the whole source all the same.
        let mut session = Session::new(
            units.len(),
            r#"{"limits":{"records":1,"pathPoints":1}}"#,
            Cancellation::default(),
        )
        .unwrap();
        for (i, chunk) in units.chunks(65536).enumerate() {
            session.append(i * 65536, chunk).unwrap();
        }
        session.seal().unwrap();
        let mut again = Vec::new();
        let written = session.toolpath_obj(&mut again).unwrap();
        expect(case, written, &again);
    }
    assert_eq!(cases.len(), 39);
}

#[test]
fn a_cancelled_or_unsealed_export_writes_nothing_whole() {
    let source: Vec<u16> = "G1 X1 E1\nG1 X2 E2\n".encode_utf16().collect();
    let cancel = Cancellation::default();
    cancel.cancel();
    let mut obj = Vec::new();
    assert!(matches!(
        toolpath_obj::write(&source, &mut obj, &cancel),
        Err(toolpath_obj::Failure::Cancelled)
    ));
    let session = Session::new(source.len(), "{}", Cancellation::default()).unwrap();
    assert_eq!(
        session.toolpath_obj(&mut Vec::new()).unwrap_err().code(),
        "invalid_state"
    );
    // A destination that fails stops the export.
    struct Full;
    impl std::io::Write for Full {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("full"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(matches!(
        toolpath_obj::write(&source, &mut Full, &Cancellation::default()),
        Err(toolpath_obj::Failure::Io(_))
    ));
}
