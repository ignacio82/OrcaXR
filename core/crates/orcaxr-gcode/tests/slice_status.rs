//! What the status line says of a finished slice, against the production
//! browser (`slice-status-vectors.json`, from `SliceStatus.ts`): every
//! artifact's size, lines and layers — the engine's stated total, else its
//! markers — exactly, however the artifact is streamed through the tally.
use orcaxr_gcode::artifact::{SliceFigures, SliceTally, slice_figures, summarize};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-status-vectors.json"
    ))
    .unwrap()
}

/// The artifact's bytes, built from its parts as the generator built them.
fn bytes(parts: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        if let Some(text) = part["text"].as_str() {
            out.extend_from_slice(text.as_bytes());
        } else if let Some(text) = part["repeat"].as_str() {
            out.extend_from_slice(
                text.repeat(part["times"].as_u64().unwrap() as usize)
                    .as_bytes(),
            );
        } else {
            out.extend(
                part["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8),
            );
        }
    }
    out
}

fn expected(case: &Value) -> SliceFigures {
    SliceFigures {
        bytes: case["bytes"].as_u64().unwrap(),
        kilobytes: case["kilobytes"].as_str().unwrap().into(),
        lines: case["lines"].as_u64().unwrap(),
        layers: case["layers"].as_str().unwrap().into(),
        stated_layers: case["statedLayers"].as_str().map(Into::into),
        layer_markers: case["layerMarkers"].as_u64().unwrap(),
    }
}

#[test]
fn every_artifact_says_what_the_browser_says() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 40);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = bytes(case["parts"].as_array().unwrap());
        assert_eq!(
            input.len() as u64,
            case["bytes"].as_u64().unwrap(),
            "{name}"
        );
        let want = expected(case);
        assert_eq!(slice_figures(&input), want, "{name}");
        // The stated total is the artifact summary's own.
        assert_eq!(
            summarize(&input)
                .layer_count
                .map(|n| ryu_js::Buffer::new().format(n).to_string()),
            want.stated_layers,
            "{name}"
        );
        // Streamed in any chunks: markers and the trailer span the cuts.
        let sizes: &[usize] = if input.len() <= 8192 {
            &[1, 2, 7, 13, 4096]
        } else {
            &[7, 4093, 65_536, 300_000]
        };
        for &size in sizes {
            let mut tally = SliceTally::new();
            for chunk in input.chunks(size) {
                tally.push(chunk);
            }
            assert_eq!(tally.finish(), want, "{name} in chunks of {size}");
        }
    }
}

#[test]
fn the_tally_keeps_only_what_can_hold_the_trailer() {
    // A long artifact: the stated total in its last lines, markers throughout.
    let mut tally = SliceTally::new();
    let layer = b";LAYER_CHANGE\nG1 Z0.2\nG1 X1 Y1 E0.01\n";
    for _ in 0..100_000 {
        tally.push(layer);
    }
    tally.push(b"; total layers count = 100000\n");
    let figures = tally.finish();
    assert_eq!(figures.layers, "100000");
    assert_eq!(figures.layer_markers, 100_000);
    assert_eq!(figures.lines, 300_002);
    assert_eq!(figures.kilobytes, "3613");
}
