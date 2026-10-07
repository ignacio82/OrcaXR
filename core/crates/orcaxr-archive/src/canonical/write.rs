//! Lossless canonical envelope output over borrowed admitted state. This does
//! not attest asset bytes or publish a completed package/saved checkpoint.
use super::{ENVELOPE_FORMAT, STRUCTURAL};
use crate::{CHUNK_BYTES, validate_package_path};
use orcaxr_contracts::canonical::write_string;
use orcaxr_project::{ids::AssetId, model::Encode, validation::ValidatedProject};
use std::{
    collections::BTreeSet,
    fmt,
    io::{self, Write},
};

#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    pub assets: usize,
    pub path_bytes: usize,
    /// Counts canonical state values, including containers but excluding keys.
    pub state_nodes: usize,
    /// Canonical state root has depth zero; capped at the browser's 256.
    pub state_depth: usize,
    pub output_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Mapping,
    Path,
    ResourceLimit,
    UnsafeKey,
    Encoding,
    Cancelled,
    Io(io::ErrorKind),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "canonical_write_{self:?}")
    }
}
impl std::error::Error for Error {}

/// The package owner supplies exact final asset paths. Source bytes must be
/// separately attested and every mapped member must be present before publishing.
pub fn envelope<W: Write>(
    project: &ValidatedProject,
    mappings: &[(&AssetId, &str)],
    out: &mut W,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<usize, Error> {
    let check = |c: &mut dyn FnMut() -> bool| if c() { Err(Error::Cancelled) } else { Ok(()) };
    check(&mut cancelled)?;
    let state = project.state();
    if mappings.len() > limits.assets || state.source_assets.len() > limits.assets {
        return Err(Error::ResourceLimit);
    }
    if mappings.len() != state.source_assets.len() {
        return Err(Error::Mapping);
    }
    let declarations: BTreeSet<_> = state.source_assets.iter().map(|d| &d.id).collect();
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for &(id, path) in mappings {
        check(&mut cancelled)?;
        validate_package_path(path, limits.path_bytes as u64).map_err(|_| Error::Path)?;
        if STRUCTURAL.contains(&path) {
            return Err(Error::Path);
        }
        if !declarations.contains(id) || !ids.insert(id) || !paths.insert(path) {
            return Err(Error::Mapping);
        }
    }
    // Borrow names/IDs; no canonical graph or asset payload is copied.
    let mut sorted: Vec<_> = mappings.iter().collect();
    sorted.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut sink = Output {
        out,
        cancelled: &mut cancelled,
        limit: limits.output_bytes,
        bytes: 0,
        buffer: vec![0; CHUNK_BYTES],
        used: 0,
        policy: None,
        error: None,
    };
    let result = (|| -> io::Result<()> {
        sink.write_all(b"{\"assetEntries\":[")?;
        for (index, &&(id, path)) in sorted.iter().enumerate() {
            if index > 0 {
                sink.write_all(b",")?;
            }
            sink.write_all(b"{\"assetId\":")?;
            write_string(id.as_utf16(), &mut sink)?;
            sink.write_all(b",\"path\":")?;
            // Path allocation is bounded before conversion; never a payload.
            write_string(&path.encode_utf16().collect::<Vec<_>>(), &mut sink)?;
            sink.write_all(b"}")?;
        }
        sink.write_all(b"],\"format\":\"")?;
        sink.write_all(ENVELOPE_FORMAT.as_bytes())?;
        sink.write_all(b"\",\"state\":")?;
        sink.policy = Some(Tree::new(limits));
        state.write_json(&mut sink)?;
        if !sink.policy.as_ref().unwrap().complete() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        sink.policy = None;
        sink.write_all(b",\"version\":1}\n")
    })();
    if let Some(e) = sink.error {
        return Err(e);
    }
    result.map_err(|e| Error::Io(e.kind()))?;
    sink.drain()?;
    check(sink.cancelled)?;
    Ok(sink.bytes)
}

// The producer above emits canonical JSON only. This small streaming policy
// checks keys/count/depth in that trusted serialization without reconstructing
// the graph. It is deliberately not an untrusted JSON parser. Canonical ASCII
// keys are literal; an escaped key cannot equal one of the three forbidden keys.
struct Tree {
    stack: [u8; 257],
    depth: usize,
    nodes: usize,
    max_nodes: usize,
    max_depth: usize,
    quoted: bool,
    escape: bool,
    key: bool,
    key_bytes: [u8; 12],
    key_len: usize,
    atom: bool,
}
impl Tree {
    fn new(limits: Limits) -> Self {
        Self {
            stack: [0; 257],
            depth: 0,
            nodes: 0,
            max_nodes: limits.state_nodes,
            max_depth: limits.state_depth.min(256),
            quoted: false,
            escape: false,
            key: false,
            key_bytes: [0; 12],
            key_len: 0,
            atom: false,
        }
    }
    fn node(&mut self) -> Result<(), Error> {
        if self.nodes >= self.max_nodes || self.depth > self.max_depth {
            return Err(Error::ResourceLimit);
        }
        self.nodes += 1;
        Ok(())
    }
    fn complete(&self) -> bool {
        self.nodes > 0 && self.depth == 0 && !self.quoted && !self.atom
    }
    fn feed(&mut self, bytes: &[u8]) -> Result<(), Error> {
        for &b in bytes {
            if self.quoted {
                if self.escape {
                    self.escape = false;
                    continue;
                }
                match b {
                    b'\\' => {
                        self.escape = true;
                        self.key_len = 12;
                    }
                    b'"' => {
                        self.quoted = false;
                        if self.key
                            && [b"__proto__".as_slice(), b"prototype", b"constructor"]
                                .contains(&&self.key_bytes[..self.key_len])
                        {
                            return Err(Error::UnsafeKey);
                        }
                    }
                    _ => {
                        if self.key && self.key_len < 12 {
                            self.key_bytes[self.key_len] = b;
                            self.key_len += 1;
                        }
                    }
                }
                continue;
            }
            if self.atom {
                if !matches!(b, b',' | b'}' | b']') {
                    continue;
                }
                self.atom = false;
            }
            match b {
                b'"' => {
                    self.key = self.depth > 0 && self.stack[self.depth - 1] == 1;
                    if !self.key {
                        self.node()?;
                    }
                    self.quoted = true;
                    self.key_len = 0;
                }
                b'{' | b'[' => {
                    self.node()?;
                    self.stack[self.depth] = if b == b'{' { 1 } else { 0 };
                    self.depth += 1;
                }
                b'}' | b']' => {
                    self.depth = self.depth.checked_sub(1).ok_or(Error::Encoding)?;
                }
                b':' => {
                    if self.depth == 0 {
                        return Err(Error::Encoding);
                    }
                    self.stack[self.depth - 1] = 2;
                }
                b',' => {
                    if self.depth == 0 {
                        return Err(Error::Encoding);
                    }
                    if self.stack[self.depth - 1] == 2 {
                        self.stack[self.depth - 1] = 1;
                    }
                }
                b'n' | b't' | b'f' | b'-' | b'0'..=b'9' => {
                    self.node()?;
                    self.atom = true;
                }
                _ => return Err(Error::Encoding),
            }
        }
        Ok(())
    }
}
struct Output<'a, W, C> {
    out: &'a mut W,
    cancelled: &'a mut C,
    limit: usize,
    bytes: usize,
    buffer: Vec<u8>,
    used: usize,
    policy: Option<Tree>,
    error: Option<Error>,
}
impl<W: Write, C: FnMut() -> bool> Output<'_, W, C> {
    fn check(&mut self) -> Result<(), Error> {
        if (self.cancelled)() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    fn drain(&mut self) -> Result<(), Error> {
        let mut offset = 0;
        while offset < self.used {
            self.check()?;
            match self.out.write(&self.buffer[offset..self.used]) {
                Ok(0) => return Err(Error::Io(io::ErrorKind::WriteZero)),
                Ok(n) if n <= self.used - offset => offset += n,
                Ok(_) => return Err(Error::Io(io::ErrorKind::InvalidData)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Error::Io(e.kind())),
            }
        }
        self.used = 0;
        self.check()
    }
    fn push(&mut self, b: &[u8]) -> Result<usize, Error> {
        if let Some(e) = self.error {
            return Err(e);
        }
        self.check()?;
        let n = b.len().min(CHUNK_BYTES);
        if n > self.limit.saturating_sub(self.bytes) {
            return Err(Error::ResourceLimit);
        }
        if let Some(policy) = &mut self.policy {
            policy.feed(&b[..n])?;
        }
        let mut rest = &b[..n];
        while !rest.is_empty() {
            let take = rest.len().min(CHUNK_BYTES - self.used);
            self.buffer[self.used..self.used + take].copy_from_slice(&rest[..take]);
            self.used += take;
            rest = &rest[take..];
            if self.used == CHUNK_BYTES {
                self.drain()?;
            }
        }
        self.bytes += n;
        Ok(n)
    }
}
impl<W: Write, C: FnMut() -> bool> Write for Output<'_, W, C> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.push(b).map_err(|e| {
            self.error = Some(e);
            io::ErrorKind::Other.into()
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        self.check().map_err(|e| {
            self.error = Some(e);
            io::ErrorKind::Other.into()
        })
    }
}
