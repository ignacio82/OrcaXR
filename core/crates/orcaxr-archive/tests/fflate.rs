//! The browser's compressor (`browser-zip-vectors.json`, from fflate 0.8.3 and
//! `writeDeterministicZip`): every deflate stream and archive byte for byte.
use orcaxr_archive::fflate::{Zip, deflate};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/browser-zip-vectors.json"
    ))
    .unwrap()
}

/// `expand` in browser-zip-vectors.mjs.
fn expand(recipe: &Value) -> Vec<u8> {
    let kind = recipe["kind"].as_str().unwrap();
    let mut x = recipe["seed"].as_u64().unwrap() as u32;
    if x == 0 {
        x = 1;
    }
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let length = recipe["length"].as_u64().unwrap() as usize;
    let mut out = vec![0u8; length];
    match kind {
        "random" => out.iter_mut().for_each(|b| *b = next() as u8),
        "low" => out.iter_mut().for_each(|b| *b = (next() % 5) as u8),
        "runs" => {
            let mut i = 0;
            while i < length {
                let value = next() as u8;
                let run = 1 + next() % 600;
                let mut j = 0;
                while j < run && i < length {
                    out[i] = value;
                    i += 1;
                    j += 1;
                }
            }
        }
        "periodic" => {
            let period = recipe["period"].as_u64().unwrap() as usize;
            let block: Vec<u8> = (0..period).map(|_| next() as u8).collect();
            for (i, b) in out.iter_mut().enumerate() {
                *b = block[i % period];
            }
        }
        "text" => {
            let mut i = 0;
            while i < length {
                let line = format!(
                    "G1 X{} Y{} E{}\n",
                    next() % 25000,
                    next() % 25000,
                    next() % 900
                );
                for &c in line.as_bytes() {
                    if i == length {
                        break;
                    }
                    out[i] = c;
                    i += 1;
                }
            }
        }
        "zeros" => {}
        other => panic!("unknown recipe {other}"),
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn deflate_streams_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["deflates"].as_array().unwrap();
    assert_eq!(cases.len(), 238);
    for case in cases {
        let input = expand(case);
        let level = case["level"].as_u64().unwrap() as u8;
        let output = deflate(&input, level).unwrap();
        assert_eq!(
            (output.len() as u64, hex(&output)),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap().to_owned()
            ),
            "{case}"
        );
    }
}

#[test]
fn archives_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["zips"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let mut zip = Zip::default();
        for member in case["members"].as_array().unwrap() {
            zip.add(member["path"].as_str().unwrap(), &expand(member))
                .unwrap();
        }
        let expected = zip.len();
        let mut output = Vec::new();
        assert_eq!(zip.finish(&mut output).unwrap(), expected);
        assert_eq!(
            (output.len() as u64, hex(&output)),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap().to_owned()
            ),
            "{}",
            case["members"]
        );
        // Every member reads back through the native reader.
        let archive = orcaxr_archive::Archive::open(
            std::io::Cursor::new(output),
            orcaxr_archive::ZipLimits::default(),
            || false,
        )
        .unwrap();
        assert_eq!(
            archive.entries().len(),
            case["members"].as_array().unwrap().len()
        );
    }
}

#[test]
fn refusals() {
    let mut zip = Zip::default();
    zip.add("a.stl", b"x").unwrap();
    assert_eq!(
        zip.add("a.stl", b"y").unwrap_err(),
        orcaxr_archive::Error::DuplicatePath
    );
    for unsafe_path in ["", "/a", "a\\b", "c:x", "a//b", "./a", "a/../b", "a\u{1}"] {
        assert_eq!(
            Zip::default().add(unsafe_path, b"").unwrap_err(),
            orcaxr_archive::Error::UnsafePath,
            "{unsafe_path:?}"
        );
    }
    assert!(deflate(b"x", 10).is_err());
}
