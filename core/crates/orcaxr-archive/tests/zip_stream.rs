use orcaxr_archive::{Archive, CHUNK_BYTES, Error, ZipLimits, write};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    rc::Rc,
};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/archive-vectors.json"
    ))
    .unwrap()
}
fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|v| u8::from_str_radix(std::str::from_utf8(v).unwrap(), 16).unwrap())
        .collect()
}
fn limits(v: &Value) -> ZipLimits {
    let mut l = ZipLimits::default();
    for (k, v) in v.as_object().unwrap() {
        match k.as_str() {
            "maxArchiveBytes" => l.archive_bytes = v.as_u64().unwrap(),
            "maxEntries" => l.entries = v.as_u64().unwrap(),
            "maxEntryBytes" => l.entry_bytes = v.as_u64().unwrap(),
            "maxTotalUncompressedBytes" => l.total_uncompressed_bytes = v.as_u64().unwrap(),
            "maxCompressionRatio" => l.compression_ratio = v.as_f64().unwrap(),
            "maxPathBytes" => l.path_bytes = v.as_u64().unwrap(),
            _ => panic!("unknown policy"),
        }
    }
    l
}
#[test]
fn independent_browser_corpus_through_pull_reads_and_compressed_identity() {
    let data = corpus();
    for case in data["cases"].as_array().unwrap() {
        let result = (|| -> Result<(), Error> {
            let mut a = Archive::open(
                Cursor::new(unhex(case["archiveHex"].as_str().unwrap())),
                limits(&case["limits"]),
                || false,
            )?;
            assert_eq!(
                format!("{:016x}", a.source_fingerprint(|| false)?),
                case["archiveHash"].as_str().unwrap()
            );
            let mut ordinal = 0;
            for i in 0..a.entries().len() {
                let directory = a.entries()[i].is_directory();
                let mut stream = a.stream_entry(i, || false)?;
                assert_eq!(stream.read_chunk(&mut [], || false)?, 0);
                let mut hash = Sha256::new();
                let mut bytes = 0;
                let mut index = 0;
                let mut buffer = vec![0; CHUNK_BYTES + 23];
                loop {
                    let size = [1, 7, 4093, CHUNK_BYTES + 23][index % 4];
                    index += 1;
                    let n = stream.read_chunk(&mut buffer[..size], || false)?;
                    assert!(n <= CHUNK_BYTES);
                    if n == 0 {
                        break;
                    }
                    hash.update(&buffer[..n]);
                    bytes += n as u64;
                }
                let receipt = stream.finish(|| false)?;
                assert_eq!(receipt.bytes, bytes);
                if !directory && !case["entries"].is_null() {
                    let expected = &case["entries"][ordinal];
                    ordinal += 1;
                    assert_eq!(bytes, expected["bytes"].as_u64().unwrap());
                    assert_eq!(
                        format!("{:x}", hash.finalize()),
                        expected["sha256"].as_str().unwrap()
                    );
                }
            }
            Ok(())
        })();
        assert_eq!(
            result.is_ok(),
            !case["entries"].is_null(),
            "{}: {result:?}",
            case["name"]
        );
    }
    for c in data["external"].as_array().unwrap() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(c["path"].as_str().unwrap());
        let mut a = Archive::open(
            std::fs::File::open(path).unwrap(),
            ZipLimits::default(),
            || false,
        )
        .unwrap();
        assert_eq!(
            format!("{:016x}", a.source_fingerprint(|| false).unwrap()),
            c["archiveHash"].as_str().unwrap()
        );
    }
}
fn encoded(payload: &[u8], compression: write::Compression) -> Vec<u8> {
    let mut file = Cursor::new(vec![]);
    write::archive(
        &mut file,
        &[write::Member {
            path: "a",
            compression,
        }],
        write::Limits::default(),
        |_, w| w.write_all(payload),
        || false,
    )
    .unwrap();
    file.into_inner()
}
fn archive(bytes: Vec<u8>) -> Archive<Cursor<Vec<u8>>> {
    Archive::open(Cursor::new(bytes), ZipLimits::default(), || false).unwrap()
}
#[test]
fn exact_comparison_covers_empty_short_long_and_late_differences() {
    for method in [write::Compression::Stored, write::Compression::Deflate] {
        for size in [0, 1, 65535, 65536, 65537, 200001] {
            let payload = (0..size)
                .map(|i| (i * 73 + i / 7) as u8)
                .collect::<Vec<_>>();
            let bytes = encoded(&payload, method);
            let mut a = archive(bytes);
            for chunk in [1, 13, 65535, 65536, 65537, 200001] {
                let mut compare = a.compare_entry(0, || false).unwrap();
                for part in payload.chunks(chunk) {
                    compare.write_all(part).unwrap();
                }
                assert!(compare.finish().unwrap());
            }
            let mut compare = a.compare_entry(0, || false).unwrap();
            compare.write_all(&payload).unwrap();
            compare.write_all(&[42]).unwrap();
            assert!(!compare.finish().unwrap());
            if size > 0 {
                let mut compare = a.compare_entry(0, || false).unwrap();
                compare.write_all(&payload[..size - 1]).unwrap();
                assert!(!compare.finish().unwrap());
                for at in [0, size / 2, size - 1] {
                    let mut compare = a.compare_entry(0, || false).unwrap();
                    compare.write_all(&payload[..at]).unwrap();
                    compare.write_all(&[payload[at] ^ 1]).unwrap();
                    compare.write_all(&payload[at + 1..]).unwrap();
                    assert!(!compare.finish().unwrap());
                }
            }
        }
    }
}
#[test]
fn mismatch_and_declared_length_do_not_hide_invalid_unread_tail() {
    let data = corpus();
    for name in [
        "crc mismatch both headers",
        "dishonest expansion prefix 0",
        "dishonest expansion prefix 1",
    ] {
        let c = data["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap();
        let bytes = unhex(c["archiveHex"].as_str().unwrap());
        for generated in [vec![], vec![255], vec![0; 1 << 17]] {
            let mut a = archive(bytes.clone());
            let mut compare = a.compare_entry(0, || false).unwrap();
            let _ = compare.write_all(&generated);
            assert!(compare.finish().is_err(), "{name}");
        }
        let mut a = archive(bytes);
        let mut stream = a.stream_entry(0, || false).unwrap();
        assert_eq!(stream.read_chunk(&mut [], || false).unwrap(), 0);
        assert!(stream.finish(|| false).is_err());
    }
}
#[test]
fn cancelled_attempts_stay_failed_but_archive_remains_reusable() {
    let bytes = encoded(&vec![42; 1 << 20], write::Compression::Deflate);
    let mut a = archive(bytes);
    let mut stream = a.stream_entry(0, || false).unwrap();
    assert_eq!(stream.read_chunk(&mut [0; 7], || false).unwrap(), 7);
    assert_eq!(
        stream.read_chunk(&mut [0; 7], || true),
        Err(Error::Cancelled)
    );
    assert_eq!(
        stream.read_chunk(&mut [0; 7], || false),
        Err(Error::Cancelled)
    );
    assert_eq!(stream.finish(|| false), Err(Error::Cancelled));
    let flag = Cell::new(false);
    let mut compare = a.compare_entry(0, || flag.get()).unwrap();
    compare.write_all(&[13]).unwrap(); // First-byte mismatch still drains on finish.
    flag.set(true);
    assert_eq!(compare.finish(), Err(Error::Cancelled));
    flag.set(false);
    let mut compare = a.compare_entry(0, || flag.get()).unwrap();
    flag.set(true);
    assert!(compare.write_all(&[42]).is_err());
    flag.set(false);
    assert_eq!(compare.failure(), Some(Error::Cancelled));
    assert!(compare.flush().is_err());
    assert_eq!(compare.finish(), Err(Error::Cancelled));
    a.verify_all(|| false).unwrap();
    let mut stream = a.stream_entry(0, || false).unwrap();
    assert_eq!(stream.read_chunk(&mut [0; 1], || false).unwrap(), 1);
    drop(stream);
    assert_eq!(
        a.stream_entry(0, || false)
            .unwrap()
            .finish(|| false)
            .unwrap()
            .bytes,
        1 << 20
    );
    assert_eq!(a.source_fingerprint(|| true), Err(Error::Cancelled));
    assert!(a.source_fingerprint(|| false).is_ok());
}
struct FaultInput {
    inner: Cursor<Vec<u8>>,
    calls: usize,
    mode: Rc<Cell<u8>>,
}
impl Read for FaultInput {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        assert!(out.len() <= CHUNK_BYTES);
        self.calls += 1;
        match self.mode.get() {
            1 => return Err(io::Error::other("private source details")),
            2 => return Ok(0),
            _ => {}
        }
        if self.calls.is_multiple_of(3) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = out.len().min(3);
        self.inner.read(&mut out[..n])
    }
}
impl Seek for FaultInput {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        self.inner.seek(p)
    }
}
#[test]
fn short_interrupted_and_failed_host_reads_are_bounded_and_redacted() {
    let payload = vec![42; 1 << 17];
    let mode = Rc::new(Cell::new(0));
    let source = FaultInput {
        inner: Cursor::new(encoded(&payload, write::Compression::Deflate)),
        calls: 0,
        mode: mode.clone(),
    };
    let mut a = Archive::open(source, ZipLimits::default(), || false).unwrap();
    let mut compare = a.compare_entry(0, || false).unwrap();
    compare.write_all(&payload).unwrap();
    assert!(compare.finish().unwrap());
    for value in [1, 2] {
        let mut compare = a.compare_entry(0, || false).unwrap();
        mode.set(value);
        let error = compare.write_all(&payload).unwrap_err();
        assert!(!error.to_string().contains("private"));
        let expected = if value == 1 {
            Error::Io(io::ErrorKind::Other)
        } else {
            Error::Truncated
        };
        assert_eq!(compare.failure(), Some(expected));
        mode.set(0);
        assert_eq!(compare.finish(), Err(expected));
        mode.set(value);
        assert_eq!(a.source_fingerprint(|| false), Err(expected));
        mode.set(0);
    }
    a.verify_all(|| false).unwrap();
}
