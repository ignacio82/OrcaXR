use super::EntryStream;
use crate::{CHUNK_BYTES, Error, Result, check_cancel};
use std::io::{self, Read, Write};

/// Private generated-output sink. `write` reports mismatches without failing, so
/// the complete producer still validates its input/output budgets. Archive/I/O or
/// cancellation failures are sticky and available through `failure`; errors from
/// the writer redact underlying private host messages. Equality is only returned
/// after the unread archive tail passes CRC/length/DEFLATE terminal checks.
pub struct EntryComparison<'a, R, C> {
    stream: EntryStream<'a, R>,
    cancelled: C,
    buffer: Vec<u8>,
    equal: bool,
    failure: Option<Error>,
}
impl<'a, R: Read, C: FnMut() -> bool> EntryComparison<'a, R, C> {
    pub(super) fn new(stream: EntryStream<'a, R>, cancelled: C) -> Self {
        Self {
            stream,
            cancelled,
            buffer: vec![0; CHUNK_BYTES],
            equal: true,
            failure: None,
        }
    }
    pub fn failure(&self) -> Option<Error> {
        self.failure
    }
    pub fn finish(mut self) -> Result<bool> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.equal
            && self
                .stream
                .read_chunk(&mut self.buffer[..1], &mut self.cancelled)?
                != 0
        {
            self.equal = false;
        }
        self.stream.finish(&mut self.cancelled)?;
        Ok(self.equal)
    }
    fn compare(&mut self, bytes: &[u8]) -> Result<()> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        for mut chunk in bytes.chunks(CHUNK_BYTES) {
            check_cancel(&mut self.cancelled)?;
            while self.equal && !chunk.is_empty() {
                let n = self
                    .stream
                    .read_chunk(&mut self.buffer[..chunk.len()], &mut self.cancelled)?;
                if n == 0 || self.buffer[..n] != chunk[..n] {
                    self.equal = false;
                }
                chunk = &chunk[n..];
            }
        }
        check_cancel(&mut self.cancelled)
    }
}
impl<R: Read, C: FnMut() -> bool> Write for EntryComparison<'_, R, C> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Err(error) = self.compare(bytes) {
            self.failure = Some(error);
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.write(&[]).map(|_| ())
    }
}
