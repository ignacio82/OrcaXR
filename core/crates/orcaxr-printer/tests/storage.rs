//! Printer storage against the production browser
//! (`printer-storage-vectors.mjs`): every plan, finish, read and size must be
//! the browser's, byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::{storage, transport};
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}

#[test]
fn printer_storage_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-storage-vectors.json"
    ))
    .unwrap();
    let mut counts = [0usize; 4];
    for case in corpus["plans"].as_array().unwrap() {
        let operation = wire::decode_printer_storage_operation(text(&case["requestJson"])).unwrap();
        let plan = wire::encode_printer_storage_plan(&storage::plan(&operation)).unwrap();
        assert_eq!(
            plan,
            text(&case["replyJson"]),
            "plan {}",
            text(&case["requestJson"])
        );
        counts[0] += 1;
    }
    for case in corpus["finishes"].as_array().unwrap() {
        let request = wire::decode_printer_storage_finish(text(&case["requestJson"])).unwrap();
        let result = wire::encode_printer_storage_result(&storage::finish(&request)).unwrap();
        assert_eq!(
            result,
            text(&case["replyJson"]),
            "finish {}",
            text(&case["requestJson"])
        );
        counts[1] += 1;
    }
    for case in corpus["reads"].as_array().unwrap() {
        let operation =
            wire::decode_printer_storage_operation(text(&case["operationJson"])).unwrap();
        let read = storage::read(&operation, text(&case["reply"]));
        // The paths the browser joined for its entries or thumbnails.
        if let Some(expected) = case["paths"].as_str() {
            assert_eq!(
                paths(&read),
                expected,
                "paths {}",
                text(&case["operationJson"])
            );
        }
        let result = wire::encode_printer_storage_result(&read).unwrap();
        assert_eq!(
            result,
            text(&case["replyJson"]),
            "read {} {}",
            text(&case["operationJson"]),
            &text(&case["reply"])[..text(&case["reply"]).len().min(200)]
        );
        counts[2] += 1;
    }
    for case in corpus["sizes"].as_array().unwrap() {
        let bytes = match &case["bytes"] {
            Json::String(s) => match s.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                _ => f64::NEG_INFINITY,
            },
            number => number.as_f64().unwrap(),
        };
        assert_eq!(
            wire::encode_optional_text(&storage::size(bytes)).unwrap(),
            text(&case["replyJson"]),
            "size {bytes}"
        );
        counts[3] += 1;
    }
    assert_eq!(counts, [218, 1460, 326, 64]);
}

/// A read's paths as the corpus records them: units (`,`) per path (`;`).
fn paths(result: &wire::PrinterStorageResult) -> String {
    let paths: Vec<Vec<u16>> = match result {
        wire::PrinterStorageResult::Listing(listing) => listing
            .directories
            .iter()
            .chain(&listing.files)
            .map(|entry| storage::entry_path(listing, entry))
            .collect(),
        wire::PrinterStorageResult::Metadata(metadata) => metadata
            .thumbnails
            .iter()
            .map(|thumbnail| storage::thumbnail_path(metadata, thumbnail))
            .collect(),
        _ => Vec::new(),
    };
    paths
        .iter()
        .map(|path| {
            path.iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Fills a reply to the transport's bound with `item`s: the most a printer
/// can send in one reply.
fn reply_at_bound(head: &str, item: &str, tail: &str) -> String {
    let budget =
        transport::MAX_TEXT_UNITS - head.encode_utf16().count() - tail.encode_utf16().count();
    let unit = item.encode_utf16().count() + 1;
    let items = vec![item; budget / unit];
    let reply = format!("{head}{}{tail}", items.join(","));
    assert!(reply.encode_utf16().count() <= transport::MAX_TEXT_UNITS);
    assert!(reply.encode_utf16().count() > transport::MAX_TEXT_UNITS - unit - 1);
    reply
}

fn crosses(operation: &wire::PrinterStorageOperation, reply: &str) -> wire::PrinterStorageResult {
    let result = storage::read(operation, reply);
    let json = wire::encode_printer_storage_result(&result).expect("within the bulk tier");
    assert_eq!(wire::decode_printer_storage_result(&json).unwrap(), result);
    result
}

#[test]
fn any_reply_the_transport_admits_crosses_a_binding() {
    // The longest folder a printer holds, of the widest units on the wire.
    let folder: Vec<u16> = vec![0xffff; storage::MAX_PATH_UNITS];
    let list = wire::PrinterStorageOperation::List(wire::PrinterText {
        text: folder.clone(),
    });
    // The most entries one reply can name, folders and files.
    for (head, item) in [
        (r#"{"files":["#, "{\"path\":\"\u{ffff}\"}"),
        (r#"{"dirs":["#, "{\"name\":\"\u{ffff}\"}"),
    ] {
        let reply = reply_at_bound(head, item, "]}");
        let wire::PrinterStorageResult::Listing(listing) = crosses(&list, &reply) else {
            panic!("a listing");
        };
        assert!(listing.files.len() + listing.directories.len() > 160_000);
    }
    // One name as long as a reply can carry.
    let name = "\u{ffff}".repeat(transport::MAX_TEXT_UNITS - 20);
    let wire::PrinterStorageResult::Listing(listing) =
        crosses(&list, &format!(r#"{{"files":[{{"path":"{name}"}}]}}"#))
    else {
        panic!("a listing");
    };
    assert_eq!(listing.files[0].name.len(), transport::MAX_TEXT_UNITS - 20);
    // The most thumbnails, and the longest slicer.
    let mut file = vec![0xffff; storage::MAX_PATH_UNITS - 2];
    file.extend([u16::from(b'/'), u16::from(b'f')]);
    let metadata = wire::PrinterStorageOperation::Metadata(wire::PrinterText { text: file });
    let reply = reply_at_bound(
        r#"{"thumbnails":["#,
        "{\"width\":1,\"height\":1,\"relative_path\":\"\u{ffff}\"}",
        "]}",
    );
    let wire::PrinterStorageResult::Metadata(read) = crosses(&metadata, &reply) else {
        panic!("metadata");
    };
    assert!(read.thumbnails.len() > 40_000);
    crosses(&metadata, &format!(r#"{{"slicer":"{name}"}}"#));
}
