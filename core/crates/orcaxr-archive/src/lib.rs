//! Shared archive boundary. Hosts own immutable staged input and private output;
//! this crate performs no filesystem extraction, UI, network or project mutation.
//! Container verification is not canonical-envelope/BBS semantic admission.
pub mod archive_layout;
pub mod bbs;
pub mod canonical;
mod index;
pub mod models;
pub mod opc;
pub mod open;
pub mod package;
pub mod policy;
mod read;
pub mod staged;
pub mod text;
pub mod write;

pub use read::{Archive, Entry, EntryComparison, EntryReceipt, EntryStream};
use std::{fmt, io};

/// Maximum input/output chunk. Decoder history and the bounded directory index
/// have separate costs; this is not a claim about total import memory.
pub const CHUNK_BYTES: usize = 65_536;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Same policy defaults as the existing TypeScript safe ZIP boundary. A host
/// supplies stricter budgets for its staged input and complete import operation.
#[derive(Clone, Copy, Debug)]
pub struct ZipLimits {
    pub archive_bytes: u64,
    pub entries: u64,
    pub entry_bytes: u64,
    pub total_uncompressed_bytes: u64,
    pub compression_ratio: f64,
    pub path_bytes: u64,
}
impl Default for ZipLimits {
    fn default() -> Self {
        Self {
            archive_bytes: 1 << 30,
            entries: 4096,
            entry_bytes: 512 << 20,
            total_uncompressed_bytes: 2 << 30,
            compression_ratio: 1000.0,
            path_bytes: 512,
        }
    }
}
impl ZipLimits {
    pub fn validate(self) -> Result<Self> {
        if [
            self.archive_bytes,
            self.entries,
            self.entry_bytes,
            self.total_uncompressed_bytes,
            self.path_bytes,
        ]
        .iter()
        .any(|v| *v == 0 || *v > MAX_SAFE_INTEGER)
            || !self.compression_ratio.is_finite()
            || self.compression_ratio < 1.0
        {
            return Err(Error::InvalidLimits);
        }
        Ok(self)
    }
}

/// Bounded, redacted failures. Neither private archive paths nor host I/O error
/// messages are formatted into errors that may cross a process/UI boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidLimits,
    UnsafePath,
    Truncated,
    InvalidDirectory,
    Unsupported,
    DuplicatePath,
    OverlappingEntries,
    ResourceLimit,
    SizeMismatch,
    ChecksumMismatch,
    InvalidDeflate,
    Cancelled,
    InvalidEntry,
    Io(io::ErrorKind),
}
pub type Result<T> = std::result::Result<T, Error>;
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "archive_{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        if value.kind() == io::ErrorKind::UnexpectedEof {
            Self::Truncated
        } else {
            Self::Io(value.kind())
        }
    }
}

/// UTF-8 paths are deliberately not normalized. Case, percent escapes, Unicode
/// and distinct names remain distinct, matching the canonical package policy.
pub fn validate_package_path(path: &str, max_bytes: u64) -> Result<()> {
    let bytes = path.as_bytes();
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || bytes.len() as u64 > max_bytes
    {
        return Err(Error::UnsafePath);
    }
    Ok(())
}

fn check_cancel(cancelled: &mut impl FnMut() -> bool) -> Result<()> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
