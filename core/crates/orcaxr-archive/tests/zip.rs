use orcaxr_archive::{Archive, CHUNK_BYTES, Error, ZipLimits, validate_package_path};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
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
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn limits(value: &Value) -> ZipLimits {
    let mut limits = ZipLimits::default();
    for (key, value) in value.as_object().unwrap() {
        match key.as_str() {
            "maxArchiveBytes" => limits.archive_bytes = value.as_u64().unwrap(),
            "maxEntries" => limits.entries = value.as_u64().unwrap(),
            "maxEntryBytes" => limits.entry_bytes = value.as_u64().unwrap(),
            "maxTotalUncompressedBytes" => {
                limits.total_uncompressed_bytes = value.as_u64().unwrap()
            }
            "maxCompressionRatio" => limits.compression_ratio = value.as_f64().unwrap(),
            "maxPathBytes" => limits.path_bytes = value.as_u64().unwrap(),
            _ => panic!("unexpected limit"),
        }
    }
    limits
}
#[derive(Default)]
struct Output {
    hash: Sha256,
    bytes: u64,
    largest: usize,
}
impl Write for Output {
    fn write(&mut self, value: &[u8]) -> io::Result<usize> {
        assert!(value.len() <= CHUNK_BYTES);
        self.hash.update(value);
        self.bytes += value.len() as u64;
        self.largest = self.largest.max(value.len());
        Ok(value.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn compare(source: impl Read + Seek, options: ZipLimits, expected: &Value) -> Result<(), Error> {
    let mut archive = Archive::open(source, options, || false)?;
    let mut entry = 0;
    for index in 0..archive.entries().len() {
        if archive.entries()[index].is_directory() {
            continue;
        }
        let path = archive.entries()[index].path().to_owned();
        let mut output = Output::default();
        let receipt = archive.read_entry(index, &mut output, || false)?;
        if !expected.is_null() {
            assert_eq!(path, expected[entry]["path"].as_str().unwrap());
            assert_eq!(output.bytes, expected[entry]["bytes"].as_u64().unwrap());
            assert_eq!(receipt.bytes, output.bytes);
            assert_eq!(
                format!("{:x}", output.hash.finalize()),
                expected[entry]["sha256"].as_str().unwrap()
            );
        }
        entry += 1;
    }
    if !expected.is_null() {
        assert_eq!(entry, expected.as_array().unwrap().len());
    }
    Ok(())
}
#[test]
fn browser_container_and_path_reference() {
    let corpus = corpus();
    for case in corpus["cases"].as_array().unwrap() {
        let result = compare(
            Cursor::new(unhex(case["archiveHex"].as_str().unwrap())),
            limits(&case["limits"]),
            &case["entries"],
        );
        assert_eq!(
            result.is_ok(),
            !case["entries"].is_null(),
            "{}: {result:?}",
            case["name"]
        );
    }
    for case in corpus["paths"].as_array().unwrap() {
        let units = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect::<Vec<_>>();
        let accepted =
            String::from_utf16(&units).is_ok_and(|path| validate_package_path(&path, 512).is_ok());
        assert_eq!(accepted, case["accepted"].as_bool().unwrap());
    }
}
#[test]
fn shipped_zip64_calibration_members_match_browser_bytes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for case in corpus()["external"].as_array().unwrap() {
        let path = root.join(case["path"].as_str().unwrap());
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["sha256"].as_str().unwrap()
        );
        compare(
            std::fs::File::open(path).unwrap(),
            ZipLimits::default(),
            &case["entries"],
        )
        .unwrap();
    }
}
struct ShortInput {
    inner: Cursor<Vec<u8>>,
    calls: Rc<Cell<usize>>,
    cap: usize,
}
impl Read for ShortInput {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        assert!(output.len() <= CHUNK_BYTES);
        self.calls.set(self.calls.get() + 1);
        let count = output.len().min(self.cap);
        self.inner.read(&mut output[..count])
    }
}
impl Seek for ShortInput {
    fn seek(&mut self, at: SeekFrom) -> io::Result<u64> {
        self.inner.seek(at)
    }
}
fn example(name: &str) -> Vec<u8> {
    let data = corpus();
    let case = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap();
    unhex(case["archiveHex"].as_str().unwrap())
}
#[test]
fn bounded_io_short_reads_and_cooperative_cancellation() {
    let bytes = example("ratio threshold inclusive");
    let calls = Rc::new(Cell::new(0));
    let input = ShortInput {
        inner: Cursor::new(bytes.clone()),
        calls: calls.clone(),
        cap: 7,
    };
    let mut archive = Archive::open(input, ZipLimits::default(), || false).unwrap();
    let mut output = Output::default();
    archive.read_entry(0, &mut output, || false).unwrap();
    assert_eq!(output.bytes, 1 << 20);
    assert_eq!(output.largest, CHUNK_BYTES);
    assert!(calls.get() > 20);
    let mut archive =
        Archive::open(Cursor::new(bytes.clone()), ZipLimits::default(), || false).unwrap();
    let mut checks = 0;
    let mut partial = Output::default();
    assert_eq!(
        archive.read_entry(0, &mut partial, || {
            checks += 1;
            checks > 15
        }),
        Err(Error::Cancelled)
    );
    assert!(partial.bytes > 0 && partial.bytes < 1 << 20);
    // Cancellation is scoped to this read, not an irreversible poison of the
    // immutable source. A later explicitly requested verification starts anew.
    archive.verify_all(|| false).unwrap();
    assert!(matches!(
        Archive::open(Cursor::new(bytes), ZipLimits::default(), || true),
        Err(Error::Cancelled)
    ));
    let input = ShortInput {
        inner: Cursor::new(example("deflate")),
        calls: calls.clone(),
        cap: 1,
    };
    let start = calls.get();
    assert!(matches!(
        Archive::open(input, ZipLimits::default(), || calls.get() > start + 3),
        Err(Error::Cancelled)
    ));
}
#[test]
fn expansion_size_crc_and_host_io_refuse_without_private_diagnostics() {
    let mut archive = Archive::open(
        Cursor::new(example("crc mismatch both headers")),
        ZipLimits::default(),
        || false,
    )
    .unwrap();
    let mut provisional = Vec::new();
    assert_eq!(
        archive.read_entry(0, &mut provisional, || false),
        Err(Error::ChecksumMismatch)
    );
    assert!(!provisional.is_empty()); // Host must discard provisional staging.
    struct Failed;
    impl Write for Failed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("private document provider details"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut archive = Archive::open(
        Cursor::new(example("deflate")),
        ZipLimits::default(),
        || false,
    )
    .unwrap();
    let error = archive.read_entry(0, &mut Failed, || false).unwrap_err();
    assert_eq!(error, Error::Io(io::ErrorKind::Other));
    assert!(!error.to_string().contains("private"));
    assert_eq!(
        archive.read_entry(99, &mut io::sink(), || false),
        Err(Error::InvalidEntry)
    );
    for ratio in [f64::NAN, f64::INFINITY, 0.9] {
        assert!(matches!(
            Archive::open(
                Cursor::new(example("deflate")),
                ZipLimits {
                    compression_ratio: ratio,
                    ..ZipLimits::default()
                },
                || false
            ),
            Err(Error::InvalidLimits)
        ));
    }
}
#[test]
fn hostile_mutations_and_every_truncation_stay_bounded() {
    let bytes = example("zip64 all");
    for length in 0..bytes.len() {
        assert!(
            Archive::open(
                Cursor::new(bytes[..length].to_vec()),
                ZipLimits::default(),
                || false
            )
            .is_err()
        );
    }
    for index in 0..bytes.len() {
        for bit in 0..8 {
            let mut damaged = bytes.clone();
            damaged[index] ^= 1 << bit;
            let mut checks = 0;
            let mut cancelled = || {
                checks += 1;
                checks > 1000
            };
            if let Ok(mut archive) =
                Archive::open(Cursor::new(damaged), ZipLimits::default(), &mut cancelled)
            {
                let result = archive.verify_all(&mut cancelled);
                assert_ne!(
                    result,
                    Err(Error::Cancelled),
                    "bounded small-input mutation exceeded work allowance"
                );
            }
        }
    }
}

#[test]
fn dishonest_expansion_lengths_are_checked_before_output_publication() {
    let bytes = example("deflate");
    let central = bytes
        .windows(4)
        .position(|v| v == [0x50, 0x4b, 0x01, 0x02])
        .unwrap();
    for expected in [0u32, 24, 26] {
        let mut changed = bytes.clone();
        changed[22..26].copy_from_slice(&expected.to_le_bytes());
        changed[central + 24..central + 28].copy_from_slice(&expected.to_le_bytes());
        let mut archive =
            Archive::open(Cursor::new(changed), ZipLimits::default(), || false).unwrap();
        let mut private = Vec::new();
        assert_eq!(
            archive.read_entry(0, &mut private, || false),
            Err(Error::SizeMismatch)
        );
        assert!(private.len() <= expected as usize);
    }
    // A valid stream ending before its claimed compressed extent cannot hide
    // unconsumed bytes behind an otherwise matching expanded CRC and length.
    let mut changed = bytes.clone();
    changed.insert(central, 0);
    let actual = u32::from_le_bytes(bytes[18..22].try_into().unwrap());
    changed[18..22].copy_from_slice(&(actual + 1).to_le_bytes());
    changed[central + 21..central + 25].copy_from_slice(&(actual + 1).to_le_bytes());
    let end = changed.len() - 22;
    changed[end + 16..end + 20].copy_from_slice(&((central + 1) as u32).to_le_bytes());
    let mut archive = Archive::open(Cursor::new(changed), ZipLimits::default(), || false).unwrap();
    assert_eq!(
        archive.read_entry(0, &mut io::sink(), || false),
        Err(Error::SizeMismatch)
    );
}
