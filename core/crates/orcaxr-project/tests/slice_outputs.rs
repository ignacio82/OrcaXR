//! A slice's outputs against the browser (`slice-output-vectors.json`): every
//! `thumbnails` value's requests and problems, every block, every injection —
//! whole, and streamed through an [`Anchor`] in chunks of every size — every
//! thumbnail camera, and every plate a slice of the active plate or of every
//! plate slices, byte for byte; each malformed request is refused.
use orcaxr_project::slicing::{
    plate::plan_json,
    thumbnails::{
        Anchor, INVALID_REQUEST, Insertion, block_json, inject_json, list_json, view_json,
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// One exchange of the corpus: a request in, a reply or a refusal out.
type Exchange = fn(&str) -> Result<String, &'static str>;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-output-vectors.json"
    ))
    .unwrap()
}

fn cases<'a>(corpus: &'a Value, name: &str) -> &'a [Value] {
    corpus[name].as_array().unwrap()
}

#[test]
fn reference_sources_are_current() {
    for source in corpus()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn outputs_match_the_browser() {
    let corpus = corpus();
    let sections: [(&str, Exchange, usize); 5] = [
        ("lists", list_json, 68),
        ("blocks", block_json, 19),
        ("injections", inject_json, 100),
        ("views", view_json, 132),
        ("plans", plan_json, 44),
    ];
    for (section, answer, count) in sections {
        let cases = cases(&corpus, section);
        assert_eq!(cases.len(), count, "{section}");
        for case in cases {
            let request = case["request"].as_str().unwrap();
            assert_eq!(
                answer(request).unwrap(),
                case["reply"].as_str().unwrap(),
                "{section} {}",
                &request[..request.len().min(200)]
            );
        }
    }
    let refusals: [(&str, Exchange, usize); 5] = [
        ("listRefusals", list_json, 4),
        ("blockRefusals", block_json, 8),
        ("injectRefusals", inject_json, 4),
        ("viewRefusals", view_json, 7),
        ("planRefusals", plan_json, 3),
    ];
    for (section, answer, count) in refusals {
        let cases = cases(&corpus, section);
        assert_eq!(cases.len(), count, "{section}");
        for case in cases {
            assert_eq!(
                answer(case["request"].as_str().unwrap()),
                Err(INVALID_REQUEST),
                "{section} {}",
                case["name"]
            );
        }
    }
}

/// A host streams the G-code once; where it puts the blocks must be where the
/// browser's whole-text injection puts them, however the bytes arrive.
#[test]
fn streamed_injection_puts_blocks_where_the_browser_does() {
    let corpus = corpus();
    let mut checked = 0;
    for case in cases(&corpus, "injections") {
        let request: Value = serde_json::from_str(case["request"].as_str().unwrap()).unwrap();
        let gcode = request["gcode"].as_str().unwrap().as_bytes();
        let blocks: Vec<&str> = request["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_str().unwrap())
            .collect();
        let expected: String = serde_json::from_str(case["reply"].as_str().unwrap()).unwrap();
        for chunk in [1, 2, 3, 7, 19, 64, 4096] {
            let mut anchor = Anchor::new();
            for piece in gcode.chunks(chunk) {
                anchor.push(piece);
            }
            assert_eq!(anchor.length(), gcode.len() as u64);
            let written = match anchor.finish(blocks.len()) {
                Insertion::Unchanged => gcode.to_vec(),
                Insertion::At(at) => {
                    let at = at as usize;
                    let mut out = gcode[..at].to_vec();
                    for block in &blocks {
                        out.extend_from_slice(block.as_bytes());
                    }
                    out.extend_from_slice(&gcode[at..]);
                    out
                }
            };
            assert_eq!(written, expected.as_bytes(), "chunks of {chunk}");
            checked += 1;
        }
    }
    assert_eq!(checked, 700);
}
