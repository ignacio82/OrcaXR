//! Emboss fonts against the browser's reader: every synthetic font of the
//! corpus is read (or refused) as the browser reads it, a text's outlines
//! answer coordinate for coordinate (or the browser's refusal of the glyph
//! that cannot be read), and every recipe cut with a font answers byte for
//! byte with the browser's mesh.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::emboss::{self, font};
use serde_json::Value;
use std::collections::BTreeMap;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/emboss-font-vectors.json"
    ))
    .unwrap()
}
fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("base64 {c}"),
    } as u32;
    let mut out = Vec::new();
    for chunk in text.trim_end_matches('=').as_bytes().chunks(4) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |word, (i, &c)| word | value(c) << (18 - 6 * i));
        out.extend(&word.to_be_bytes()[1..chunk.len()]);
    }
    out
}
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn fonts_read_and_cut_as_the_browser_reads_them() {
    let f = fixture();
    let files: BTreeMap<&str, Vec<u8>> = f["fonts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|font| {
            (
                font["name"].as_str().unwrap(),
                base64(font["bytes"].as_str().unwrap()),
            )
        })
        .collect();
    let mut handles: BTreeMap<String, font::ReadFont> = BTreeMap::new();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let handle = step["handle"].as_str().unwrap().to_owned();
        let expected = step["reply"].as_str().unwrap();
        let kind = if let Some(request) = step["read"].as_str() {
            let read = font::read(
                &wire::decode_emboss_font_request(request).unwrap(),
                files[step["file"].as_str().unwrap()].clone(),
            );
            assert_eq!(
                wire::encode_emboss_font_reply(&read.reply()).unwrap(),
                expected,
                "step {i}"
            );
            handles.insert(handle, read);
            "read"
        } else if let Some(request) = step["glyphs"].as_str() {
            let request = wire::decode_emboss_glyphs_request(request).unwrap();
            let reply = handles[&handle].font().unwrap().glyphs(&request.text);
            assert_eq!(
                wire::encode_emboss_glyphs_reply(&reply).unwrap(),
                expected,
                "step {i}"
            );
            "glyphs"
        } else {
            let request =
                wire::decode_emboss_text_request(step["prepare"].as_str().unwrap()).unwrap();
            let cut = emboss::prepare_text(handles[&handle].font().unwrap(), &request);
            assert_eq!(
                wire::encode_emboss_reply(&cut.reply()).unwrap(),
                expected,
                "step {i}"
            );
            if let wire::EmbossReply::Prepared(preview) = cut.reply() {
                let mesh = cut.mesh(0, preview.byte_length).unwrap();
                assert_eq!(sha256(mesh), step["mesh"].as_str().unwrap(), "step {i}");
                assert_eq!(
                    step.get("window")
                        .map(|_| sha256(cut.mesh(16, 64).unwrap())),
                    step.get("window").map(|w| w.as_str().unwrap().to_owned()),
                    "step {i}"
                );
            }
            "prepare"
        };
        *counts.entry(kind).or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from([("read", 46), ("glyphs", 29), ("prepare", 20)])
    );
}

#[test]
fn a_cut_from_the_read_outlines_is_the_cut_from_the_font() {
    // The glyph reply is the `GlyphFont` the cut reads: sent back through
    // `prepare`, it cuts the same mesh.
    let f = fixture();
    let sans = f["fonts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|font| font["name"] == "sans")
        .unwrap();
    let font = font::Font::read(base64(sans["bytes"].as_str().unwrap()), 0.0).unwrap();
    let mut compared = 0;
    for step in f["steps"].as_array().unwrap() {
        let (Some(request), "sans") = (step["prepare"].as_str(), step["handle"].as_str().unwrap())
        else {
            continue;
        };
        let request = wire::decode_emboss_text_request(request).unwrap();
        let wire::EmbossGlyphsReply::Glyphs(glyphs) = font.glyphs(&request.configuration.text)
        else {
            panic!("the sample font reads every glyph");
        };
        let direct = emboss::prepare_text(&font, &request);
        let relayed = emboss::prepare(&wire::EmbossRequest {
            configuration: request.configuration.clone(),
            font: glyphs,
        });
        assert_eq!(
            wire::encode_emboss_reply(&direct.reply()).unwrap(),
            wire::encode_emboss_reply(&relayed.reply()).unwrap()
        );
        compared += 1;
    }
    assert_eq!(compared, 9);
}

#[test]
fn a_font_refuses_to_read_past_its_end() {
    for length in 0..64 {
        let bytes = vec![0u8; length];
        assert!(font::Font::read(bytes, 0.0).is_err());
    }
    // A collection header promising more fonts than the file holds.
    let mut ttc = b"ttcf\0\x01\0\0\0\0\0\x02".to_vec();
    ttc.extend([0, 0, 0, 0x7f]);
    assert_eq!(
        font::Font::read(ttc, 1.0).err().unwrap().0,
        "This font file is cut short: its tables point past its end"
    );
}
