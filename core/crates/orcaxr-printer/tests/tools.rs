//! Tool usage, filament slots and tool mapping against the production browser
//! (`printer-tools-vectors.mjs`). Each artifact is scanned whole and split at
//! several chunk sizes, so a sequence, a line end or a declaration can straddle
//! any two appends.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::tools::{ToolUsageScanner, filament_slots, mapping};
use serde_json::Value as Json;

fn bytes(text: &str) -> Vec<u8> {
    let table = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let clean: Vec<u8> = text.bytes().filter(|&c| c != b'=').map(table).collect();
    clean
        .chunks(4)
        .flat_map(|q| {
            let n = q.iter().fold(0u32, |n, &v| (n << 6) | u32::from(v)) << (6 * (4 - q.len()));
            let all = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
            all[..q.len() - 1].to_vec()
        })
        .collect()
}

#[test]
fn printer_tools_answer_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/printer-tools-vectors.json"
    ))
    .unwrap();
    let usage = corpus["usage"].as_array().unwrap();
    for case in usage {
        let data = bytes(case["bytesBase64"].as_str().unwrap());
        for chunk in [usize::MAX, 1, 2, 3, 5, 64] {
            let mut scanner = ToolUsageScanner::new();
            for piece in data.chunks(chunk.min(data.len().max(1))) {
                scanner.append(piece);
            }
            assert_eq!(
                wire::encode_gcode_tool_usage(&scanner.finish()).unwrap(),
                case["usageJson"].as_str().unwrap(),
                "{} in chunks of {chunk}",
                case["name"]
            );
        }
    }
    let slots = corpus["slots"].as_array().unwrap();
    for case in slots {
        assert_eq!(
            wire::encode_filament_slots_reply(&filament_slots(case["text"].as_str().unwrap()))
                .unwrap(),
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    let mappings = corpus["mapping"].as_array().unwrap();
    for (i, case) in mappings.iter().enumerate() {
        let request =
            wire::decode_tool_mapping_request(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            wire::encode_tool_mapping_report(&mapping(&request)).unwrap(),
            case["replyJson"].as_str().unwrap(),
            "mapping {i}: {}",
            case["requestJson"]
        );
    }
    assert_eq!((usage.len(), slots.len(), mappings.len()), (100, 20, 1552));
}
