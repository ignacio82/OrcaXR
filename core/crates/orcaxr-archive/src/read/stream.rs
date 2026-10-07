use super::{Entry, EntryReceipt, checked_read};
use crate::{CHUNK_BYTES, Error, Result, check_cancel};
use flate2::{Decompress, FlushDecompress, Status};
use std::io::Read;

/// Bounded pull reader over one indexed member. It borrows the archive exclusively,
/// retains at most one compressed-input chunk plus decoder history, and never
/// buffers a whole member. Errors poison this attempt; retry by opening a new
/// stream. Host I/O deadlines and private provisional-output ownership still apply.
pub struct EntryStream<'a, R> {
    source: &'a mut R,
    entry: &'a Entry,
    decoder: Option<Decompress>,
    input: Vec<u8>,
    start: usize,
    end: usize,
    remaining: u64,
    written: u64,
    crc: crc32fast::Hasher,
    ended: bool,
    receipt: Option<EntryReceipt>,
    failure: Option<Error>,
}
impl<'a, R: Read> EntryStream<'a, R> {
    pub(super) fn new(source: &'a mut R, entry: &'a Entry) -> Result<Self> {
        if entry.compression == 0 && entry.compressed != entry.uncompressed {
            return Err(Error::SizeMismatch);
        }
        Ok(Self {
            source,
            entry,
            decoder: (entry.compression != 0).then(|| Decompress::new(false)),
            input: if entry.compression == 0 {
                vec![]
            } else {
                vec![0; CHUNK_BYTES]
            },
            start: 0,
            end: 0,
            remaining: entry.compressed,
            written: 0,
            crc: crc32fast::Hasher::new(),
            ended: false,
            receipt: None,
            failure: None,
        })
    }
    /// Reads at most CHUNK_BYTES, regardless of output size. For a nonempty
    /// buffer, zero means verified EOF. An empty buffer does not advance or verify
    /// the stream. A final CRC/length failure may follow earlier provisional bytes.
    pub fn read_chunk(
        &mut self,
        output: &mut [u8],
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<usize> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let result = self.read_inner(output, &mut cancelled);
        if let Err(error) = result {
            self.failure = Some(error);
        }
        result
    }
    /// Drain any unread tail and return its CRC/length receipt. Consumers must
    /// call this even after an early comparison mismatch or after reading the
    /// declared byte count: neither establishes the DEFLATE terminal boundary.
    pub fn finish(mut self, mut cancelled: impl FnMut() -> bool) -> Result<EntryReceipt> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        check_cancel(&mut cancelled)?;
        if let Some(receipt) = self.receipt {
            return Ok(receipt);
        }
        let mut buffer = vec![0; CHUNK_BYTES];
        while self.read_chunk(&mut buffer, &mut cancelled)? != 0 {}
        self.receipt.ok_or(Error::Truncated)
    }
    fn read_inner(&mut self, output: &mut [u8], c: &mut impl FnMut() -> bool) -> Result<usize> {
        check_cancel(c)?;
        if self.receipt.is_some() || output.is_empty() {
            return Ok(0);
        }
        if self.ended {
            self.verify()?;
            return Ok(0);
        }
        let size = output.len().min(CHUNK_BYTES);
        let output = &mut output[..size];
        if self.decoder.is_none() {
            let n = self.remaining.min(size as u64) as usize;
            checked_read(self.source, &mut output[..n], c)?;
            self.remaining -= n as u64;
            self.account(&output[..n])?;
            if self.remaining == 0 {
                self.ended = true;
                if n == 0 {
                    self.verify()?;
                }
            }
            return Ok(n);
        }
        loop {
            check_cancel(c)?;
            if self.start == self.end && self.remaining > 0 {
                self.end = self.remaining.min(CHUNK_BYTES as u64) as usize;
                checked_read(self.source, &mut self.input[..self.end], c)?;
                self.remaining -= self.end as u64;
                self.start = 0;
            }
            let decoder = self.decoder.as_mut().expect("compressed stream");
            let before_in = decoder.total_in();
            let before_out = decoder.total_out();
            let status = decoder
                .decompress(
                    &self.input[self.start..self.end],
                    output,
                    FlushDecompress::None,
                )
                .map_err(|_| Error::InvalidDeflate)?;
            let consumed = (decoder.total_in() - before_in) as usize;
            let produced = (decoder.total_out() - before_out) as usize;
            let total_in = decoder.total_in();
            self.start += consumed;
            self.account(&output[..produced])?;
            check_cancel(c)?;
            if status == Status::StreamEnd {
                if total_in != self.entry.compressed {
                    return Err(Error::SizeMismatch);
                }
                self.ended = true;
                if produced == 0 {
                    self.verify()?;
                }
                return Ok(produced);
            }
            if produced != 0 {
                return Ok(produced);
            }
            if consumed == 0 {
                return Err(Error::InvalidDeflate);
            }
        }
    }
    fn account(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() as u64 > self.entry.uncompressed - self.written {
            return Err(Error::SizeMismatch);
        }
        self.written += bytes.len() as u64;
        self.crc.update(bytes);
        Ok(())
    }
    fn verify(&mut self) -> Result<()> {
        if self.written != self.entry.uncompressed {
            return Err(Error::SizeMismatch);
        }
        let crc = self.crc.clone().finalize();
        if crc != self.entry.crc {
            return Err(Error::ChecksumMismatch);
        }
        self.receipt = Some(EntryReceipt {
            bytes: self.written,
            crc32: crc,
        });
        Ok(())
    }
}
