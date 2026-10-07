//! Host-staged archive bytes, shared by every binding so chunk rules cannot
//! drift. A host either declares the exact length (a browser `File`, a sized
//! document) and the whole buffer is reserved before any chunk arrives, or
//! stages open-ended input (an unsized or nonseekable provider stream) that
//! grows fallibly up to the policy's archive budget. Offsets make retries and
//! out-of-order delivery explicit; a refused chunk is never consumed.
use crate::{archive_layout::MAX_CHUNK_BYTES, policy::Policy};

#[derive(Debug)]
pub struct ArchiveInput {
    bytes: Vec<u8>,
    expected: Option<usize>,
    limit: usize,
}
impl ArchiveInput {
    /// `expected` is the exact archive length, or `None` for open-ended input.
    pub fn new(expected: Option<usize>, policy: &Policy) -> Result<Self, &'static str> {
        Self::bounded(expected, policy.options().archive_bytes)
    }
    /// The same staging rules under an explicit byte budget (model sources).
    pub fn bounded(expected: Option<usize>, limit: usize) -> Result<Self, &'static str> {
        let mut bytes = Vec::new();
        if let Some(expected) = expected {
            if expected == 0 || expected > limit {
                return Err("input_limit");
            }
            bytes
                .try_reserve_exact(expected)
                .map_err(|_| "input_limit")?;
        }
        Ok(Self {
            bytes,
            expected,
            limit,
        })
    }
    /// More bytes than a declared length is malformed input; more than the
    /// budget for open-ended input is a resource refusal.
    pub fn append(&mut self, offset: usize, chunk: &[u8]) -> Result<(), &'static str> {
        if chunk.len() > MAX_CHUNK_BYTES {
            return Err("input_limit");
        }
        if offset != self.bytes.len() {
            return Err("invalid_archive_input");
        }
        let room = self.expected.unwrap_or(self.limit) - self.bytes.len();
        if chunk.len() > room {
            return Err(if self.expected.is_some() {
                "invalid_archive_input"
            } else {
                "input_limit"
            });
        }
        self.bytes
            .try_reserve(chunk.len())
            .map_err(|_| "input_limit")?;
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    /// The complete archive: exactly the declared length, or at least one byte.
    pub fn finish(self) -> Result<Vec<u8>, &'static str> {
        match self.expected {
            Some(expected) if self.bytes.len() != expected => Err("incomplete_archive"),
            None if self.bytes.is_empty() => Err("incomplete_archive"),
            _ => Ok(self.bytes),
        }
    }
}
