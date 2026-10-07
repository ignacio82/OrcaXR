use crate::{CHUNK_BYTES, Error, Result, ZipLimits, check_cancel, index};
use std::io::{Read, Seek, SeekFrom, Write};
mod stream;
pub use stream::EntryStream;
mod compare;
pub use compare::EntryComparison;

#[derive(Debug)]
pub struct Entry {
    pub(crate) path: String,
    pub(crate) compression: u16,
    pub(crate) compressed: u64,
    pub(crate) uncompressed: u64,
    pub(crate) crc: u32,
    pub(crate) data: u64,
    pub(crate) directory: bool,
}
impl Entry {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn bytes(&self) -> u64 {
        self.uncompressed
    }
    pub fn compressed_bytes(&self) -> u64 {
        self.compressed
    }
    pub fn is_directory(&self) -> bool {
        self.directory
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryReceipt {
    pub bytes: u64,
    pub crc32: u32,
}

/// Owns its source and directory index. The source must be immutable for this
/// owner's lifetime (e.g. an app-private staged file or an owned byte buffer).
/// Provider streams are staged by the host; providers need not support seeking.
pub struct Archive<R> {
    source: R,
    entries: Vec<Entry>,
    bytes: u64,
}
impl<R: Read + Seek> Archive<R> {
    pub fn open(
        mut source: R,
        limits: ZipLimits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self> {
        let limits = limits.validate()?;
        check_cancel(&mut cancelled)?;
        let bytes = source.seek(SeekFrom::End(0))?;
        if bytes > limits.archive_bytes {
            return Err(Error::ResourceLimit);
        }
        let entries = index::inspect(&mut source, bytes, limits, &mut cancelled)?;
        Ok(Self {
            source,
            entries,
            bytes,
        })
    }
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    /// Read one member incrementally from the immutable private source. Bytes
    /// remain provisional until `finish` returns an integrity receipt. Dropping
    /// the stream abandons it; opening another member always seeks independently.
    pub fn stream_entry(
        &mut self,
        index: usize,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<EntryStream<'_, R>> {
        let entry = self.entries.get(index).ok_or(Error::InvalidEntry)?;
        check_cancel(&mut cancelled)?;
        self.source.seek(SeekFrom::Start(entry.data))?;
        check_cancel(&mut cancelled)?;
        EntryStream::new(&mut self.source, entry)
    }
    /// Compare generated output byte-for-byte with an existing member without
    /// retaining either payload. The producer must complete successfully and
    /// the comparison must finish; an early mismatch does not skip tail integrity.
    pub fn compare_entry<C: FnMut() -> bool>(
        &mut self,
        index: usize,
        mut cancelled: C,
    ) -> Result<EntryComparison<'_, R, C>> {
        let stream = self.stream_entry(index, &mut cancelled)?;
        Ok(EntryComparison::new(stream, cancelled))
    }
    /// FNV-1a64 of the exact compressed input, including its complete directory
    /// and trailing bytes. This is the browser import-ID seed, not an integrity
    /// or cryptographic authenticity check. Member CRC/admission remain required.
    pub fn source_fingerprint(&mut self, mut cancelled: impl FnMut() -> bool) -> Result<u64> {
        check_cancel(&mut cancelled)?;
        self.source.seek(SeekFrom::Start(0))?;
        let mut input = vec![0; CHUNK_BYTES];
        let mut remaining = self.bytes;
        let mut hash = 0xcbf29ce484222325u64;
        while remaining > 0 {
            let size = remaining.min(CHUNK_BYTES as u64) as usize;
            checked_read(&mut self.source, &mut input[..size], &mut cancelled)?;
            for &byte in &input[..size] {
                hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
            }
            remaining -= size as u64;
        }
        check_cancel(&mut cancelled)?;
        Ok(hash)
    }
    /// Output is provisional until this call succeeds. CRC or decompression
    /// failure can follow partial output: stage privately, discard on any error,
    /// and never publish a project until every required member is admitted.
    /// Cancellation is checked around bounded reads/decode/writes. The host must
    /// supply I/O deadlines; a blocked Read/Write cannot be interrupted here.
    pub fn read_entry(
        &mut self,
        index: usize,
        output: &mut impl Write,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<EntryReceipt> {
        let mut stream = self.stream_entry(index, &mut cancelled)?;
        let mut expanded = vec![0; CHUNK_BYTES];
        loop {
            let n = stream.read_chunk(&mut expanded, &mut cancelled)?;
            if n == 0 {
                return stream.finish(cancelled);
            }
            output.write_all(&expanded[..n])?;
            check_cancel(&mut cancelled)?;
        }
    }
    pub fn verify_all(&mut self, mut cancelled: impl FnMut() -> bool) -> Result<()> {
        for index in 0..self.entries.len() {
            self.read_entry(index, &mut std::io::sink(), &mut cancelled)?;
        }
        Ok(())
    }
}

pub(crate) fn checked_read(
    source: &mut impl Read,
    output: &mut [u8],
    cancelled: &mut impl FnMut() -> bool,
) -> Result<()> {
    for chunk in output.chunks_mut(CHUNK_BYTES) {
        let mut offset = 0;
        while offset < chunk.len() {
            check_cancel(cancelled)?;
            match source.read(&mut chunk[offset..]) {
                Ok(0) => return Err(Error::Truncated),
                Ok(count) => offset += count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        check_cancel(cancelled)?;
    }
    Ok(())
}
