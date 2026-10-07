//! Deterministic ZIP/ZIP64 output into an empty, private seekable destination.
//! Hosts stage provider output, discard it on any failure, and publish only after
//! successful finalization and their own identity/handoff checks. No Drop writes.
//! Layout: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
use crate::{CHUNK_BYTES, Error as Failure, ZipLimits, check_cancel, validate_package_path};
use flate2::{Compress, Compression as Level, FlushCompress, Status};
use std::{
    fmt,
    io::{self, Seek, SeekFrom, Write},
};

#[derive(Clone, Copy, Debug, Default)]
pub enum Compression {
    #[default]
    Auto,
    Stored,
    Deflate,
}
#[derive(Clone, Copy, Debug)]
pub struct Member<'a> {
    pub path: &'a str,
    pub compression: Compression,
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub zip: ZipLimits,
    pub index_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            zip: ZipLimits::default(),
            index_bytes: 8 << 20,
        }
    }
}
pub enum Error<E> {
    Archive(Failure),
    NonemptyOutput,
    Producer(E),
}
impl<E> fmt::Debug for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Archive(e) => write!(f, "zip_write_{e:?}"),
            Self::NonemptyOutput => f.write_str("zip_write_nonempty_output"),
            Self::Producer(_) => f.write_str("zip_write_producer"),
        }
    }
}
impl<E> fmt::Display for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl<E> std::error::Error for Error<E> {}
impl<E> From<Failure> for Error<E> {
    fn from(e: Failure) -> Self {
        Self::Archive(e)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub bytes: u64,
    pub members: usize,
    pub uncompressed_bytes: u64,
}
struct Record<'a> {
    index: usize,
    member: Member<'a>,
    method: u16,
    local: u64,
    compressed: u64,
    uncompressed: u64,
    crc: u32,
    wide: bool,
}
fn method(member: Member<'_>) -> u16 {
    match member.compression {
        Compression::Stored => 0,
        Compression::Deflate => 8,
        Compression::Auto => {
            let extension = member.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            if ["3mf", "jpg", "jpeg", "mp4", "png", "webp", "zip"]
                .iter()
                .any(|e| extension.eq_ignore_ascii_case(e))
            {
                0
            } else {
                8
            }
        }
    }
}
/// The producer receives its original input ordinal and a bounded member sink.
/// Its writes and flush calls do not change compression chunking. All input
/// names are checked/sorted before output starts. Any swallowed sink error still
/// prevents success. Source/host error messages are never exposed by Debug/Display.
pub fn archive<W: Write + Seek, E>(
    output: &mut W,
    members: &[Member<'_>],
    limits: Limits,
    mut produce: impl FnMut(usize, &mut dyn Write) -> Result<(), E>,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Receipt, Error<E>> {
    let zip = limits.zip.validate()?;
    check_cancel(&mut cancelled)?;
    if members.len() as u64 > zip.entries
        || members
            .len()
            .checked_mul(std::mem::size_of::<Record<'_>>())
            .is_none_or(|n| n > limits.index_bytes)
    {
        return Err(Failure::ResourceLimit.into());
    }
    let mut records = Vec::new();
    records
        .try_reserve_exact(members.len())
        .map_err(|_| Failure::ResourceLimit)?;
    for (index, &member) in members.iter().enumerate() {
        check_cancel(&mut cancelled)?;
        validate_package_path(member.path, zip.path_bytes.min(u16::MAX as u64))?;
        records.push(Record {
            index,
            member,
            method: method(member),
            local: 0,
            compressed: 0,
            uncompressed: 0,
            crc: 0,
            wide: zip.entry_bytes >= u32::MAX as u64 || zip.archive_bytes >= u32::MAX as u64,
        });
    }
    records.sort_unstable_by(|a, b| {
        a.member
            .path
            .encode_utf16()
            .cmp(b.member.path.encode_utf16())
    });
    if records
        .windows(2)
        .any(|w| w[0].member.path == w[1].member.path)
    {
        return Err(Failure::DuplicatePath.into());
    }
    let mut out = Output {
        output,
        cancelled: &mut cancelled,
        position: 0,
        extent: 0,
        limit: zip.archive_bytes,
    };
    if out.seek_raw(SeekFrom::End(0))? != 0 {
        return Err(Error::NonemptyOutput);
    }
    out.seek(0)?;
    let mut total = 0;
    for r in &mut records {
        r.local = out.position;
        local(&mut out, r)?;
        let data = out.position;
        let mut sink = Sink::new(
            &mut out,
            r.method,
            zip.entry_bytes.min(zip.total_uncompressed_bytes - total),
            zip.compression_ratio,
        );
        let result = produce(r.index, &mut sink);
        if let Some(e) = sink.failure {
            return Err(e.into());
        }
        result.map_err(Error::Producer)?;
        let (bytes, crc) = sink.finish()?;
        r.uncompressed = bytes;
        r.crc = crc;
        r.compressed = out.position - data;
        if !r.wide && (r.uncompressed >= u32::MAX as u64 || r.compressed >= u32::MAX as u64) {
            return Err(Failure::ResourceLimit.into());
        }
        total += bytes;
        let end = out.position;
        out.seek(r.local)?;
        local(&mut out, r)?;
        out.seek(end)?;
    }
    let central_start = out.position;
    for r in &records {
        central(&mut out, r)?;
    }
    let central_bytes = out.position - central_start;
    ending(&mut out, records.len() as u64, central_start, central_bytes)?;
    check_cancel(out.cancelled)?;
    Ok(Receipt {
        bytes: out.extent,
        members: records.len(),
        uncompressed_bytes: total,
    })
}
struct Output<'a, W, C> {
    output: &'a mut W,
    cancelled: &'a mut C,
    position: u64,
    extent: u64,
    limit: u64,
}
impl<W: Write + Seek, C: FnMut() -> bool> Output<'_, W, C> {
    fn seek_raw(&mut self, from: SeekFrom) -> Result<u64, Failure> {
        loop {
            check_cancel(self.cancelled)?;
            match self.output.seek(from) {
                Ok(n) => {
                    check_cancel(self.cancelled)?;
                    return Ok(n);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Failure::Io(e.kind())),
            }
        }
    }
    fn seek(&mut self, n: u64) -> Result<(), Failure> {
        if n > self.extent || self.seek_raw(SeekFrom::Start(n))? != n {
            return Err(Failure::Io(io::ErrorKind::InvalidData));
        }
        self.position = n;
        Ok(())
    }
    fn bytes(&mut self, mut bytes: &[u8]) -> Result<(), Failure> {
        let end = self
            .position
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= self.limit)
            .ok_or(Failure::ResourceLimit)?;
        while !bytes.is_empty() {
            check_cancel(self.cancelled)?;
            let n = bytes.len().min(CHUNK_BYTES);
            match self.output.write(&bytes[..n]) {
                Ok(0) => return Err(Failure::Io(io::ErrorKind::WriteZero)),
                Ok(written) if written <= n => {
                    self.position += written as u64;
                    self.extent = self.extent.max(self.position);
                    bytes = &bytes[written..];
                }
                Ok(_) => return Err(Failure::Io(io::ErrorKind::InvalidData)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Failure::Io(e.kind())),
            }
        }
        debug_assert_eq!(self.position, end);
        check_cancel(self.cancelled)
    }
}

enum Field {
    U16(u16),
    U32(u32),
    U64(u64),
}
use Field::{U16, U32, U64};
fn header<W: Write + Seek, C: FnMut() -> bool>(
    o: &mut Output<'_, W, C>,
    fields: &[Field],
) -> Result<(), Failure> {
    // Fixed ZIP records are small. Coalesce their scalar fields into one host
    // write instead of issuing a filesystem syscall for every integer.
    let mut bytes = [0; 128];
    let mut used = 0;
    for field in fields {
        let (n, value) = match *field {
            U16(n) => (2, u64::from(n)),
            U32(n) => (4, u64::from(n)),
            U64(n) => (8, n),
        };
        bytes[used..used + n].copy_from_slice(&value.to_le_bytes()[..n]);
        used += n;
    }
    o.bytes(&bytes[..used])
}
fn local<W: Write + Seek, C: FnMut() -> bool>(
    o: &mut Output<'_, W, C>,
    r: &Record<'_>,
) -> Result<(), Failure> {
    header(
        o,
        &[
            U32(0x04034b50),
            U16(if r.wide { 45 } else { 20 }),
            U16(0x800),
            U16(r.method),
            U16(0),
            U16(33),
            U32(r.crc),
            U32(if r.wide {
                u32::MAX
            } else {
                r.compressed as u32
            }),
            U32(if r.wide {
                u32::MAX
            } else {
                r.uncompressed as u32
            }),
            U16(r.member.path.len() as u16),
            U16(if r.wide { 20 } else { 0 }),
        ],
    )?;
    o.bytes(r.member.path.as_bytes())?;
    if r.wide {
        header(
            o,
            &[U16(1), U16(16), U64(r.uncompressed), U64(r.compressed)],
        )?;
    }
    Ok(())
}
fn central<W: Write + Seek, C: FnMut() -> bool>(
    o: &mut Output<'_, W, C>,
    r: &Record<'_>,
) -> Result<(), Failure> {
    let wide = r.wide || r.local >= u32::MAX as u64;
    header(
        o,
        &[
            U32(0x02014b50),
            U16(0x300 | if wide { 45 } else { 20 }),
            U16(if wide { 45 } else { 20 }),
            U16(0x800),
            U16(r.method),
            U16(0),
            U16(33),
            U32(r.crc),
            U32(if wide { u32::MAX } else { r.compressed as u32 }),
            U32(if wide {
                u32::MAX
            } else {
                r.uncompressed as u32
            }),
            U16(r.member.path.len() as u16),
            U16(if wide { 28 } else { 0 }),
            U16(0),
            U16(0),
            U16(0),
            U32(0o644 << 16),
            U32(if wide { u32::MAX } else { r.local as u32 }),
        ],
    )?;
    o.bytes(r.member.path.as_bytes())?;
    if wide {
        header(
            o,
            &[
                U16(1),
                U16(24),
                U64(r.uncompressed),
                U64(r.compressed),
                U64(r.local),
            ],
        )?;
    }
    Ok(())
}
fn ending<W: Write + Seek, C: FnMut() -> bool>(
    o: &mut Output<'_, W, C>,
    count: u64,
    start: u64,
    length: u64,
) -> Result<(), Failure> {
    let wide = count >= u16::MAX as u64 || start >= u32::MAX as u64 || length >= u32::MAX as u64;
    if wide {
        let offset = o.position;
        header(
            o,
            &[
                U32(0x06064b50),
                U64(44),
                U16(0x32d),
                U16(45),
                U32(0),
                U32(0),
                U64(count),
                U64(count),
                U64(length),
                U64(start),
                U32(0x07064b50),
                U32(0),
                U64(offset),
                U32(1),
            ],
        )?;
    }
    header(
        o,
        &[
            U32(0x06054b50),
            U16(0),
            U16(0),
            U16(if wide { u16::MAX } else { count as u16 }),
            U16(if wide { u16::MAX } else { count as u16 }),
            U32(if wide { u32::MAX } else { length as u32 }),
            U32(if wide { u32::MAX } else { start as u32 }),
            U16(0),
        ],
    )
}
struct Sink<'a, 'o, W, C> {
    out: &'a mut Output<'o, W, C>,
    compressor: Option<Compress>,
    input: Vec<u8>,
    encoded: Vec<u8>,
    used: usize,
    bytes: u64,
    limit: u64,
    data: u64,
    ratio: f64,
    crc: crc32fast::Hasher,
    failure: Option<Failure>,
}
impl<'a, 'o, W: Write + Seek, C: FnMut() -> bool> Sink<'a, 'o, W, C> {
    fn new(out: &'a mut Output<'o, W, C>, method: u16, limit: u64, ratio: f64) -> Self {
        let data = out.position;
        Self {
            out,
            compressor: (method == 8).then(|| Compress::new(Level::new(6), false)),
            input: vec![0; if method == 8 { CHUNK_BYTES } else { 0 }],
            encoded: vec![0; if method == 8 { CHUNK_BYTES } else { 0 }],
            used: 0,
            bytes: 0,
            limit,
            data,
            ratio,
            crc: crc32fast::Hasher::new(),
            failure: None,
        }
    }
    fn compress(&mut self, flush: FlushCompress) -> Result<(), Failure> {
        let mut offset = 0;
        loop {
            check_cancel(self.out.cancelled)?;
            let c = self.compressor.as_mut().unwrap();
            let (before_in, before_out) = (c.total_in(), c.total_out());
            let status = c
                .compress(&self.input[offset..self.used], &mut self.encoded, flush)
                .map_err(|_| Failure::InvalidDeflate)?;
            let consumed = (c.total_in() - before_in) as usize;
            let produced = (c.total_out() - before_out) as usize;
            offset += consumed;
            self.out.bytes(&self.encoded[..produced])?;
            if status == Status::StreamEnd
                || (flush != FlushCompress::Finish
                    && offset == self.used
                    && produced < self.encoded.len())
            {
                break;
            }
            if consumed == 0 && produced == 0 {
                return Err(Failure::InvalidDeflate);
            }
        }
        self.used = 0;
        Ok(())
    }
    fn push(&mut self, bytes: &[u8]) -> Result<usize, Failure> {
        if let Some(e) = self.failure {
            return Err(e);
        }
        check_cancel(self.out.cancelled)?;
        let n = bytes.len().min(CHUNK_BYTES);
        self.bytes = self
            .bytes
            .checked_add(n as u64)
            .filter(|v| *v <= self.limit)
            .ok_or(Failure::ResourceLimit)?;
        self.crc.update(&bytes[..n]);
        if self.compressor.is_none() {
            self.out.bytes(&bytes[..n])?;
        } else {
            let mut rest = &bytes[..n];
            while !rest.is_empty() {
                let n = rest.len().min(CHUNK_BYTES - self.used);
                self.input[self.used..self.used + n].copy_from_slice(&rest[..n]);
                self.used += n;
                rest = &rest[n..];
                if self.used == CHUNK_BYTES {
                    self.compress(FlushCompress::None)?;
                }
            }
        }
        Ok(n)
    }
    fn finish(mut self) -> Result<(u64, u32), Failure> {
        if let Some(e) = self.failure {
            return Err(e);
        }
        check_cancel(self.out.cancelled)?;
        if self.compressor.is_some() {
            // Sync ends on a byte boundary. Empty nonfinal stored blocks can
            // then bound expansion ratio without replay or a full payload copy.
            // See flate2 FlushCompress::Sync and RFC 1951 section 3.2.4.
            self.compress(FlushCompress::Sync)?;
            if self.bytes > 1 << 20 {
                let required = (self.bytes as f64 / self.ratio).ceil() as u64;
                let missing = required.saturating_sub(self.out.position - self.data);
                let blocks = missing.div_ceil(5);
                let mut padding = [0u8; 5 * 1024];
                for block in padding.chunks_exact_mut(5) {
                    block[3] = 255;
                    block[4] = 255;
                }
                let mut left = blocks;
                while left > 0 {
                    let n = left.min(1024) as usize;
                    self.out.bytes(&padding[..n * 5])?;
                    left -= n as u64;
                }
            }
            self.compress(FlushCompress::Finish)?;
        }
        Ok((self.bytes, self.crc.finalize()))
    }
}
impl<W: Write + Seek, C: FnMut() -> bool> Write for Sink<'_, '_, W, C> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.push(bytes).map_err(|e| {
            self.failure = Some(e);
            io::ErrorKind::Other.into()
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        // Flushing a member neither finalizes the archive nor flushes its host.
        let result = if let Some(e) = self.failure {
            Err(e)
        } else {
            check_cancel(self.out.cancelled)
        };
        result.map_err(|e| {
            self.failure = Some(e);
            io::ErrorKind::Other.into()
        })
    }
}
