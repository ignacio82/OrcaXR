use orcaxr_archive::{
    Archive, Error as Failure,
    write::{self, Compression, Limits, Member},
};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};

#[test]
fn actual_zip64_sizes_and_offsets_cross_four_gib_without_payload_storage() {
    // Virtual sparse file: the writer still streams/checksums every byte, but
    // this host stores only headers and the nonzero second member, not 4 GiB.
    #[derive(Default)]
    struct Sparse {
        position: u64,
        length: u64,
        records: Vec<(u64, Vec<u8>)>,
    }
    impl Write for Sparse {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if b.len() != 65536 {
                self.records.push((self.position, b.to_vec()));
            } else {
                assert!(b.iter().all(|v| *v == 0));
            }
            self.position += b.len() as u64;
            self.length = self.length.max(self.position);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host owns flush")
        }
    }
    impl Seek for Sparse {
        fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
            self.position = match from {
                SeekFrom::Start(n) => n,
                SeekFrom::Current(n) => self.position.checked_add_signed(n).unwrap(),
                SeekFrom::End(n) => self.length.checked_add_signed(n).unwrap(),
            };
            Ok(self.position)
        }
    }
    impl Read for Sparse {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            let n = b
                .len()
                .min(self.length.saturating_sub(self.position) as usize);
            b[..n].fill(0);
            for (at, bytes) in &self.records {
                let start = (*at).max(self.position);
                let end = (at + bytes.len() as u64).min(self.position + n as u64);
                if start < end {
                    b[(start - self.position) as usize..(end - self.position) as usize]
                        .copy_from_slice(&bytes[(start - at) as usize..(end - at) as usize]);
                }
            }
            self.position += n as u64;
            Ok(n)
        }
    }
    let members = ["a", "b"].map(|path| Member {
        path,
        compression: Compression::Stored,
    });
    let mut limits = Limits::default();
    limits.zip.archive_bytes = 1 << 33;
    limits.zip.entry_bytes = 1 << 32;
    limits.zip.total_uncompressed_bytes = (1 << 32) + 1;
    let mut output = Sparse::default();
    let receipt = write::archive(
        &mut output,
        &members,
        limits,
        |i, w| {
            if i == 0 {
                for _ in 0..65536 {
                    w.write_all(&[0; 65536])?;
                }
            } else {
                w.write_all(&[42])?;
            }
            Ok::<_, io::Error>(())
        },
        || false,
    )
    .unwrap();
    assert!(receipt.bytes > 1 << 32);
    assert_eq!(receipt.uncompressed_bytes, (1 << 32) + 1);
    assert!(output.records.iter().map(|(_, v)| v.len()).sum::<usize>() < 1024);
    let mut archive = Archive::open(output, limits.zip, || false).unwrap();
    assert_eq!(archive.entries()[0].bytes(), 1 << 32);
    let mut second = vec![];
    archive.read_entry(1, &mut second, || false).unwrap();
    assert_eq!(second, [42]);
}
fn encode(
    files: &[(&str, Vec<u8>)],
    compression: Compression,
    limits: Limits,
    chunks: usize,
) -> Result<Vec<u8>, write::Error<io::Error>> {
    let members: Vec<_> = files
        .iter()
        .map(|(path, _)| Member { path, compression })
        .collect();
    let mut out = Cursor::new(vec![]);
    let receipt = write::archive(
        &mut out,
        &members,
        limits,
        |i, w| {
            for b in files[i].1.chunks(chunks) {
                w.write_all(b)?;
                w.flush()?;
            }
            Ok(())
        },
        || false,
    )?;
    assert_eq!(receipt.bytes, out.get_ref().len() as u64);
    assert_eq!(
        receipt.uncompressed_bytes,
        files.iter().map(|(_, b)| b.len() as u64).sum::<u64>()
    );
    Ok(out.into_inner())
}
#[test]
fn deterministic_names_payloads_and_zip64_members_round_trip() {
    let files = vec![
        ("z.PNG", vec![9; 101]),
        ("__proto__", vec![1, 2]),
        ("𐀀.xml", vec![3; 65539]),
        ("\u{e000}.txt", vec![]),
        ("a.txt", vec![7]),
        ("\u{feff}a.txt", vec![8]),
        ("\u{feff}\u{feff}a.txt", vec![10]),
    ];
    for compression in [Compression::Auto, Compression::Stored, Compression::Deflate] {
        for wide in [false, true] {
            let mut limits = Limits::default();
            if wide {
                limits.zip.archive_bytes = 1 << 33;
            }
            let bytes = encode(&files, compression, limits, usize::MAX).unwrap();
            assert_eq!(bytes, encode(&files, compression, limits, 17).unwrap());
            let mut source = Archive::open(Cursor::new(bytes), limits.zip, || false).unwrap();
            let mut names: Vec<_> = files.iter().map(|(n, _)| *n).collect();
            names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            assert_eq!(
                source
                    .entries()
                    .iter()
                    .map(|e| e.path())
                    .collect::<Vec<_>>(),
                names
            );
            for i in 0..source.entries().len() {
                let expected = files
                    .iter()
                    .find(|(n, _)| *n == source.entries()[i].path())
                    .unwrap();
                let mut output = vec![];
                source.read_entry(i, &mut output, || false).unwrap();
                assert_eq!(output, expected.1);
            }
        }
    }
}
#[test]
fn compression_ratio_padding_remains_readable_with_the_same_limits() {
    let files = vec![("large.txt", vec![0; 2 * 1024 * 1024])];
    for ratio in [1.0, 7.25, 1000.0] {
        let mut limits = Limits::default();
        limits.zip.compression_ratio = ratio;
        let bytes = encode(&files, Compression::Deflate, limits, 7919).unwrap();
        let mut source = Archive::open(Cursor::new(bytes), limits.zip, || false).unwrap();
        assert!(
            source.entries()[0].bytes() as f64 / source.entries()[0].compressed_bytes() as f64
                <= ratio
        );
        let mut output = vec![];
        source.read_entry(0, &mut output, || false).unwrap();
        assert_eq!(output, files[0].1);
    }
}
#[test]
fn zero_members_and_zip64_directory_count_boundary() {
    let empty = encode(&[], Compression::Stored, Limits::default(), 1).unwrap();
    assert_eq!(empty.len(), 22);
    for count in [65534, 65535, 65536] {
        let names: Vec<_> = (0..count).map(|i| format!("member-{i:05}")).collect();
        let members: Vec<_> = names
            .iter()
            .map(|path| Member {
                path,
                compression: Compression::Stored,
            })
            .collect();
        let mut limits = Limits::default();
        limits.zip.entries = 70000;
        let mut out = Cursor::new(vec![]);
        write::archive(&mut out, &members, limits, |_, _| Ok::<_, ()>(()), || false).unwrap();
        let source = Archive::open(out, limits.zip, || false).unwrap();
        assert_eq!(source.entries().len(), count);
    }
}
#[test]
fn paths_budgets_producer_errors_and_swallowed_errors_never_succeed() {
    let files = vec![("one", vec![1; 20]), ("two", vec![2; 30])];
    for field in 0..6 {
        let mut l = Limits::default();
        match field {
            0 => l.index_bytes = 1,
            1 => l.zip.entries = 1,
            2 => l.zip.entry_bytes = 19,
            3 => l.zip.total_uncompressed_bytes = 49,
            4 => l.zip.archive_bytes = 21,
            _ => l.zip.path_bytes = 2,
        }
        assert!(
            encode(&files, Compression::Stored, l, 7).is_err(),
            "{field}"
        );
    }
    for path in ["", "../a", "/a", "a//b", "a\\b", "C:x", "x\0y"] {
        assert!(encode(&[(path, vec![])], Compression::Stored, Limits::default(), 1).is_err());
    }
    assert!(matches!(
        encode(
            &[("a", vec![]), ("a", vec![])],
            Compression::Stored,
            Limits::default(),
            1
        ),
        Err(write::Error::Archive(Failure::DuplicatePath))
    ));
    let member = [Member {
        path: "a",
        compression: Compression::Stored,
    }];
    let error = write::archive(
        &mut Cursor::new(vec![]),
        &member,
        Limits::default(),
        |_, w| {
            w.write_all(b"private").unwrap();
            Err("private producer credentials")
        },
        || false,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "zip_write_producer");
    let mut limits = Limits::default();
    limits.zip.entry_bytes = 1;
    assert!(matches!(
        write::archive(
            &mut Cursor::new(vec![]),
            &member,
            limits,
            |_, w| {
                let _ = w.write_all(b"too long");
                Ok::<_, ()>(())
            },
            || false
        ),
        Err(write::Error::Archive(Failure::ResourceLimit))
    ));
    let mut nonempty = Cursor::new(vec![1, 2, 3]);
    assert!(matches!(
        write::archive(
            &mut nonempty,
            &member,
            limits,
            |_, _| Ok::<_, ()>(()),
            || false
        ),
        Err(write::Error::NonemptyOutput)
    ));
    assert_eq!(nonempty.into_inner(), [1, 2, 3]);
}
#[test]
fn short_interrupted_writes_and_seeks_are_cancellable_and_redacted() {
    struct Output {
        data: Cursor<Vec<u8>>,
        calls: usize,
        forever: bool,
        private: bool,
    }
    impl Write for Output {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.private {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private path credential",
                ));
            }
            if self.forever || self.calls % 3 == 1 {
                return Err(io::ErrorKind::Interrupted.into());
            }
            assert!(b.len() <= 65536);
            self.data.write(&b[..b.len().min(3)])
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host owns flush")
        }
    }
    impl Seek for Output {
        fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
            self.calls += 1;
            if self.calls % 3 == 1 {
                return Err(io::ErrorKind::Interrupted.into());
            }
            self.data.seek(p)
        }
    }
    let members = [Member {
        path: "x",
        compression: Compression::Deflate,
    }];
    let mut out = Output {
        data: Cursor::new(vec![]),
        calls: 0,
        forever: false,
        private: false,
    };
    write::archive(
        &mut out,
        &members,
        Limits::default(),
        |_, w| w.write_all(b"data"),
        || false,
    )
    .unwrap();
    assert_eq!(
        out.data.into_inner(),
        encode(
            &[("x", b"data".to_vec())],
            Compression::Deflate,
            Limits::default(),
            1
        )
        .unwrap()
    );
    for private in [false, true] {
        let mut out = Output {
            data: Cursor::new(vec![]),
            calls: 0,
            forever: true,
            private,
        };
        let mut polls = 0;
        let e = write::archive(
            &mut out,
            &members,
            Limits::default(),
            |_, w| w.write_all(b"data"),
            || {
                polls += 1;
                polls > 100
            },
        )
        .unwrap_err();
        if private {
            assert!(matches!(
                e,
                write::Error::Archive(Failure::Io(io::ErrorKind::PermissionDenied))
            ));
        } else {
            assert!(matches!(e, write::Error::Archive(Failure::Cancelled)));
        }
        assert!(!e.to_string().contains("private"));
    }
}
