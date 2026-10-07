use orcaxr_archive::bbs::xml::{Error, Limits, Writer};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-xml-vectors.json"
    ))
    .unwrap()
}
fn limits() -> Limits {
    Limits {
        output_bytes: 1 << 20,
        text_units: 1 << 20,
    }
}
fn escaped(units: &[u16], attribute: bool) -> Result<Vec<u8>, Error> {
    let mut out = vec![];
    let mut writer = Writer::new(&mut out, limits(), || false)?;
    if attribute {
        writer.attribute(units)?;
    } else {
        writer.text(units)?;
    }
    let size = writer.finish()?;
    assert_eq!(size, out.len());
    Ok(out)
}
#[test]
fn utf16_preservation_and_xml_escaping_match_browser() {
    for row in corpus()["cases"].as_array().unwrap() {
        let units: Vec<_> = row["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect();
        for (attribute, key) in [(true, "attribute"), (false, "text")] {
            let result = escaped(&units, attribute);
            if row["error"] == true {
                assert_eq!(result, Err(Error::XmlCharacter));
            } else {
                assert_eq!(result.unwrap(), row[key].as_str().unwrap().as_bytes());
            }
        }
    }
}
#[test]
fn every_single_unicode_code_point_matches_browser_xml_rules() {
    let mut hash = Sha256::new();
    let mut accepted = 0;
    let mut refused = 0;
    let mut line = Vec::with_capacity(40);
    for point in 0..=0x10ffff {
        let mut buffer = [0; 2];
        let units = if let Some(c) = char::from_u32(point) {
            c.encode_utf16(&mut buffer)
        } else {
            buffer[0] = point as u16;
            &mut buffer[..1]
        };
        line.clear();
        write!(&mut line, "{point} ").unwrap();
        match escaped(units, true) {
            Err(Error::XmlCharacter) => {
                line.extend_from_slice(b"ERROR\n");
                refused += 1;
            }
            Ok(attribute) => {
                line.extend_from_slice(&attribute);
                line.push(b' ');
                line.extend_from_slice(&escaped(units, false).unwrap());
                line.push(b'\n');
                accepted += 1;
            }
            other => panic!("{point}: {other:?}"),
        }
        hash.update(&line);
    }
    let corpus = corpus();
    let expected = &corpus["scan"];
    assert_eq!(accepted, expected["accepted"].as_u64().unwrap());
    assert_eq!(refused, expected["refused"].as_u64().unwrap());
    assert_eq!(
        format!("{:x}", hash.finalize()),
        expected["sha256"].as_str().unwrap()
    );
}
#[test]
fn byte_and_text_budgets_are_aggregate_and_all_errors_poison_finish() {
    for cap in 0..=10 {
        let mut out = vec![];
        let mut writer = Writer::new(
            &mut out,
            Limits {
                output_bytes: cap,
                text_units: 2,
            },
            || false,
        )
        .unwrap();
        let result = writer
            .attribute(&[38])
            .and_then(|()| writer.attribute(&[38]));
        if cap < 10 {
            assert_eq!(result, Err(Error::OutputLimit));
            assert_eq!(writer.finish(), Err(Error::OutputLimit));
            assert!(out.is_empty());
        } else {
            result.unwrap();
            assert_eq!(writer.finish(), Ok(10));
            assert_eq!(out, b"&amp;&amp;");
        }
    }
    let mut out = vec![];
    let mut writer = Writer::new(
        &mut out,
        Limits {
            output_bytes: 100,
            text_units: 3,
        },
        || false,
    )
    .unwrap();
    writer.attribute(&[0xd83d, 0xde00]).unwrap();
    writer.text(&[65]).unwrap();
    assert_eq!(writer.text(&[66]), Err(Error::TextLimit));
    assert_eq!(writer.literal("ignored"), Err(Error::TextLimit));
    assert_eq!(writer.finish(), Err(Error::TextLimit));
    assert!(out.is_empty());
    let mut writer = Writer::new(&mut out, limits(), || false).unwrap();
    writer.text(&[65]).unwrap();
    assert_eq!(writer.text(&[0]), Err(Error::XmlCharacter));
    assert_eq!(writer.finish(), Err(Error::XmlCharacter));
    assert!(out.is_empty());
    let mut writer = Writer::new(&mut out, limits(), || false).unwrap();
    assert!(matches!(
        writer.number(f64::INFINITY),
        Err(Error::Number(_))
    ));
    assert!(matches!(writer.finish(), Err(Error::Number(_))));
    assert!(out.is_empty());
    {
        let mut writer = Writer::new(&mut out, limits(), || false).unwrap();
        writer.literal("discarded").unwrap();
    }
    assert!(
        out.is_empty(),
        "Drop cannot implicitly publish buffered text"
    );
}
struct Sink {
    bytes: Vec<u8>,
    mode: u8,
    calls: usize,
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        assert!(b.len() <= 4096);
        self.calls += 1;
        match self.mode {
            1 => return Ok(0),
            2 => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private host pathname/token",
                ));
            }
            3 => return Ok(b.len() + 1),
            4 => return Err(io::ErrorKind::Interrupted.into()),
            _ => {}
        }
        if self.calls.is_multiple_of(3) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = b.len().min(17);
        self.bytes.extend_from_slice(&b[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("durable flush belongs to host")
    }
}
#[test]
fn short_writes_retry_cancellation_and_private_io_errors_are_bounded() {
    let input = vec![38; 2000];
    let mut sink = Sink {
        bytes: vec![],
        mode: 0,
        calls: 0,
    };
    let mut writer = Writer::new(&mut sink, limits(), || false).unwrap();
    writer.attribute(&input).unwrap();
    assert_eq!(writer.finish(), Ok(10000));
    assert_eq!(sink.bytes, b"&amp;".repeat(2000));
    assert!(sink.calls > 500);
    for (mode, error) in [
        (1, io::ErrorKind::WriteZero),
        (2, io::ErrorKind::PermissionDenied),
        (3, io::ErrorKind::InvalidData),
    ] {
        let mut sink = Sink {
            bytes: vec![],
            mode,
            calls: 0,
        };
        let mut writer = Writer::new(&mut sink, limits(), || false).unwrap();
        writer.literal("x").unwrap();
        let actual = writer.finish().unwrap_err();
        assert_eq!(actual, Error::Io(error));
        assert!(!actual.to_string().contains("private"));
        assert_eq!(sink.calls, 1);
    }
    let mut polls = 0;
    let mut sink = Sink {
        bytes: vec![],
        mode: 4,
        calls: 0,
    };
    let mut writer = Writer::new(&mut sink, limits(), || {
        polls += 1;
        polls > 20
    })
    .unwrap();
    writer.literal("x").unwrap();
    assert_eq!(writer.finish(), Err(Error::Cancelled));
    assert!(sink.calls > 10 && sink.calls < 20);
    // Text processing must remain cancellable before filling even one buffer.
    let mut polls = 0;
    let mut out = vec![];
    let mut writer = Writer::new(&mut out, limits(), || {
        polls += 1;
        polls > 5
    })
    .unwrap();
    assert_eq!(writer.text(&vec![65; 3000]), Err(Error::Cancelled));
    assert_eq!(writer.finish(), Err(Error::Cancelled));
    assert!(out.is_empty());
}

#[test]
fn cancellation_after_host_write_rejects_finish_and_late_errors_stay_failed() {
    let written = std::cell::Cell::new(false);
    struct CancellingSink<'a>(&'a std::cell::Cell<bool>);
    impl Write for CancellingSink<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.set(true);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host flush")
        }
    }
    let mut sink = CancellingSink(&written);
    let mut writer = Writer::new(&mut sink, limits(), || written.get()).unwrap();
    writer.literal("provisional").unwrap();
    assert_eq!(writer.finish(), Err(Error::Cancelled));
    assert!(written.get());
    let mut output = vec![];
    let mut writer = Writer::new(&mut output, limits(), || false).unwrap();
    writer.text(&vec![65; 4097]).unwrap();
    assert_eq!(writer.attribute(&[0xd800]), Err(Error::XmlCharacter));
    assert_eq!(writer.number(1.0), Err(Error::XmlCharacter));
    assert_eq!(writer.finish(), Err(Error::XmlCharacter));
    assert_eq!(
        output.len(),
        4096,
        "private prefix must be discarded by its owner"
    );
}
#[test]
fn vertex_rows_use_exact_browser_float32_formatting() {
    let numbers: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-number-vectors.json"
    ))
    .unwrap();
    for rows in numbers["mesh"].as_array().unwrap().chunks_exact(3) {
        let mut out = vec![];
        let mut writer = Writer::new(&mut out, limits(), || false).unwrap();
        let xyz = std::array::from_fn(|i| f32::from_bits(rows[i]["bits"].as_u64().unwrap() as u32));
        if rows.iter().any(|r| r["error"] == true) {
            assert!(writer.vertex(xyz).is_err());
            assert!(writer.finish().is_err());
        } else {
            writer.vertex(xyz).unwrap();
            writer.finish().unwrap();
            assert_eq!(
                String::from_utf8(out).unwrap(),
                format!(
                    "     <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>\n",
                    rows[0]["text"].as_str().unwrap(),
                    rows[1]["text"].as_str().unwrap(),
                    rows[2]["text"].as_str().unwrap()
                )
            );
        }
    }
}
#[test]
fn reference_sources_are_current() {
    for (path, digest) in corpus()["sources"].as_object().unwrap() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .join(path),
        )
        .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            digest.as_str().unwrap(),
            "{path}"
        );
    }
}
