//! Pinned BBS facet hex codec, sharing the canonical sparse facet tree model.
//! All output is provisional until success; callers discard it after any error.
use orcaxr_contracts::canonical::Value;
use orcaxr_project::facets::{MAX_DEPTH, Node, NodeKind, PaintValue, State};
use std::{fmt, io};

pub const MAX_ROOT_NODES: usize = 1_000_000;
pub const MAX_AGGREGATE_NODES: usize = 256_000_000;
const HEX: &[u8; 16] = b"0123456789ABCDEF";
const CHUNK: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Limits,
    Hex,
    EncodedSize,
    NodeLimit,
    DepthLimit,
    Truncated,
    Split,
    Tree,
    State,
    Trailing,
    Cancelled,
    OutputLimit,
    Io(io::ErrorKind),
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "bbs_facet_{self:?}")
    }
}
impl std::error::Error for Error {}

/// A package-wide budget shared by every explicitly encoded paint root and
/// channel. Missing paint attributes consume nothing. Failure/cancel does not
/// refund work; failed imports must discard their privately staged trees.
#[derive(Debug)]
pub struct DecodeBudget {
    remaining: i64,
}
impl DecodeBudget {
    pub fn new(nodes: usize) -> Result<Self, Error> {
        if nodes > MAX_AGGREGATE_NODES {
            return Err(Error::Limits);
        }
        Ok(Self {
            remaining: nodes as i64,
        })
    }
    pub fn remaining_nodes(&self) -> i64 {
        self.remaining
    }
    fn charge(&mut self, count: &mut usize) -> Result<(), Error> {
        self.remaining = self.remaining.saturating_sub(1);
        *count += 1;
        if self.remaining < 0 || *count > MAX_ROOT_NODES {
            return Err(Error::NodeLimit);
        }
        Ok(())
    }
}
fn check(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
fn output(
    out: &mut impl io::Write,
    mut bytes: &[u8],
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    while !bytes.is_empty() {
        check(cancelled)?;
        match out.write(bytes) {
            Ok(0) => return Err(Error::Io(io::ErrorKind::WriteZero)),
            Ok(n) => {
                bytes = bytes
                    .get(n..)
                    .ok_or(Error::Io(io::ErrorKind::InvalidData))?
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(Error::Io(e.kind())),
        }
    }
    check(cancelled)
}

/// The XML owner supplies decoded attribute bytes and an explicit input cap.
/// Only uppercase ASCII hex is accepted. The callback owns channel/slot mapping;
/// zero always denotes unpainted and never invokes it.
pub fn decode(
    encoded: &[u8],
    max_encoded_bytes: usize,
    budget: &mut DecodeBudget,
    mut assigned: impl FnMut(u8) -> Option<PaintValue>,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Node, Error> {
    check(&mut cancelled)?;
    if encoded.len() > max_encoded_bytes {
        return Err(Error::EncodedSize);
    }
    if encoded.is_empty() {
        return Err(Error::Hex);
    }
    for chunk in encoded.chunks(CHUNK) {
        check(&mut cancelled)?;
        if !chunk
            .iter()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(b))
        {
            return Err(Error::Hex);
        }
    }
    if encoded.len() as u64 > budget.remaining.max(1) as u64 * 18 {
        return Err(Error::EncodedSize);
    }
    struct Reader<'a, M, C> {
        input: &'a [u8],
        cursor: usize,
        count: usize,
        budget: &'a mut DecodeBudget,
        map: &'a mut M,
        cancelled: &'a mut C,
    }
    impl<M: FnMut(u8) -> Option<PaintValue>, C: FnMut() -> bool> Reader<'_, M, C> {
        fn next(&mut self) -> Result<u8, Error> {
            self.cursor = self.cursor.checked_sub(1).ok_or(Error::Truncated)?;
            let b = self.input[self.cursor];
            Ok(if b <= b'9' { b - b'0' } else { b - b'A' + 10 })
        }
        fn node(&mut self, depth: usize) -> Result<Node, Error> {
            check(self.cancelled)?;
            self.budget.charge(&mut self.count)?;
            let code = self.next()?;
            let sides = code & 3;
            if sides == 0 {
                let mut state = u16::from(code >> 2);
                if code & 12 == 12 {
                    let mut extensions = 0;
                    let mut extra = self.next()?;
                    while extra == 15 {
                        extensions += 1;
                        if extensions > 17 {
                            return Err(Error::State);
                        }
                        extra = self.next()?;
                    }
                    state = 3 + extensions * 15 + u16::from(extra);
                }
                if state > 255 {
                    return Err(Error::State);
                }
                Ok(Node::leaf(if state == 0 {
                    State::Unpainted
                } else {
                    State::Assigned((self.map)(state as u8).ok_or(Error::State)?)
                }))
            } else {
                if depth >= MAX_DEPTH {
                    return Err(Error::DepthLimit);
                }
                let special = code >> 2;
                if special > 2 || (sides == 3 && special != 0) {
                    return Err(Error::Split);
                }
                let mut children = Vec::with_capacity(usize::from(sides) + 1);
                for _ in 0..=sides {
                    children.push(self.node(depth + 1)?);
                }
                children.reverse();
                Node::split(sides, special, children).map_err(|_| Error::Split)
            }
        }
    }
    let mut reader = Reader {
        input: encoded,
        cursor: encoded.len(),
        count: 0,
        budget,
        map: &mut assigned,
        cancelled: &mut cancelled,
    };
    let root = reader.node(0)?;
    if reader.cursor != 0 {
        return Err(Error::Trailing);
    }
    check(reader.cancelled)?;
    Ok(root)
}

/// Borrow either a computation tree or the canonical JSON refinement payload.
/// Persisted projection does not first clone/convert a second paint tree.
#[derive(Clone, Copy)]
pub enum Tree<'a> {
    Computed(&'a Node),
    Persisted(&'a Value),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Paint<'a> {
    Text(&'a [u16]),
    Bool(bool),
}
enum Children<'a> {
    Computed(&'a [Node]),
    Persisted(&'a [Value]),
}
impl<'a> Children<'a> {
    fn len(&self) -> usize {
        match self {
            Self::Computed(v) => v.len(),
            Self::Persisted(v) => v.len(),
        }
    }
    fn get(&self, i: usize) -> Tree<'a> {
        match self {
            Self::Computed(v) => Tree::Computed(&v[i]),
            Self::Persisted(v) => Tree::Persisted(&v[i]),
        }
    }
}
enum View<'a> {
    Leaf(Option<Paint<'a>>),
    Split(u8, u8, Children<'a>),
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    let mut key = [0u16; 12];
    for (i, b) in name.bytes().enumerate() {
        key[i] = u16::from(b);
    }
    fields.get(&key[..name.len()])
}
fn named(value: Option<&Value>, name: &str) -> bool {
    matches!(value,Some(Value::String(v)) if v.iter().copied().eq(name.encode_utf16()))
}
impl<'a> Tree<'a> {
    fn view(self) -> Result<View<'a>, Error> {
        match self {
            Self::Computed(node) => Ok(match node.kind() {
                NodeKind::Leaf(State::Unpainted) => View::Leaf(None),
                NodeKind::Leaf(State::Assigned(v)) => View::Leaf(Some(match v {
                    PaintValue::Text(v) => Paint::Text(v),
                    PaintValue::Bool(v) => Paint::Bool(*v),
                })),
                NodeKind::Split {
                    split_sides,
                    special_side,
                    children,
                } => View::Split(*split_sides, *special_side, Children::Computed(children)),
            }),
            Self::Persisted(v) => {
                if named(field(v, "kind"), "leaf") {
                    let state = field(v, "state").ok_or(Error::Tree)?;
                    if named(field(state, "kind"), "unpainted") {
                        return Ok(View::Leaf(None));
                    }
                    if !named(field(state, "kind"), "assigned") {
                        return Err(Error::Tree);
                    }
                    Ok(View::Leaf(Some(match field(state, "value") {
                        Some(Value::String(v)) => Paint::Text(v),
                        Some(Value::Bool(v)) => Paint::Bool(*v),
                        _ => return Err(Error::State),
                    })))
                } else {
                    if !named(field(v, "kind"), "split") {
                        return Err(Error::Tree);
                    }
                    let number = |name| match field(v, name) {
                        Some(Value::Number(n))
                            if n.is_finite() && n.fract() == 0.0 && (0.0..=3.0).contains(n) =>
                        {
                            Ok(*n as u8)
                        }
                        _ => Err(Error::Split),
                    };
                    let sides = number("splitSides")?;
                    let special = number("specialSide")?;
                    let Some(Value::Array(children)) = field(v, "children") else {
                        return Err(Error::Split);
                    };
                    if !(1..=3).contains(&sides)
                        || special > 2
                        || (sides == 3 && special != 0)
                        || children.len() != usize::from(sides) + 1
                    {
                        return Err(Error::Split);
                    }
                    Ok(View::Split(sides, special, Children::Persisted(children)))
                }
            }
        }
    }
}

/// Emit exact uppercase BBS hex using a fixed 4 KiB buffer and a depth-bounded
/// traversal stack. No output or metadata is published by this method. Failure
/// may follow writes; the host must discard its entire provisional output.
pub fn write<'a>(
    root: Tree<'a>,
    mut assigned: impl FnMut(Paint<'a>) -> Option<u8>,
    out: &mut impl io::Write,
    max_output_bytes: usize,
    mut cancelled: impl FnMut() -> bool,
) -> Result<usize, Error> {
    enum Step<'a> {
        Node(Tree<'a>, usize),
        Marker(u8),
    }
    let mut pending = vec![Step::Node(root, 0)];
    let mut buffer = [0; CHUNK];
    let mut used = 0;
    let mut written = 0usize;
    let mut count = 0;
    let mut emit = |bytes: &[u8], cancelled: &mut _| -> Result<(), Error> {
        check(cancelled)?;
        written = written
            .checked_add(bytes.len())
            .filter(|&v| v <= max_output_bytes)
            .ok_or(Error::OutputLimit)?;
        for &b in bytes {
            buffer[used] = b;
            used += 1;
            if used == CHUNK {
                check(cancelled)?;
                output(out, &buffer, cancelled)?;
                used = 0;
                check(cancelled)?;
            }
        }
        Ok(())
    };
    while let Some(step) = pending.pop() {
        check(&mut cancelled)?;
        match step {
            Step::Marker(v) => emit(&[HEX[usize::from(v)]], &mut cancelled)?,
            Step::Node(node, depth) => {
                count += 1;
                if count > MAX_ROOT_NODES {
                    return Err(Error::NodeLimit);
                }
                match node.view()? {
                    View::Leaf(value) => {
                        let state = match value {
                            None => 0,
                            Some(v) => assigned(v).ok_or(Error::State)?,
                        };
                        emit(encode_leaf(state).as_bytes(), &mut cancelled)?;
                    }
                    View::Split(sides, special, children) => {
                        if depth >= MAX_DEPTH {
                            return Err(Error::DepthLimit);
                        }
                        pending.push(Step::Marker((special << 2) | sides));
                        for i in (0..children.len()).rev() {
                            pending.push(Step::Node(children.get(i), depth + 1));
                        }
                    }
                }
            }
        }
    }
    check(&mut cancelled)?;
    if used != 0 {
        output(out, &buffer[..used], &mut cancelled)?;
    }
    check(&mut cancelled)?;
    Ok(written)
}

/// Visit borrowed assigned leaves without constructing another tree. The host
/// supplies the remaining aggregate node budget; a single root retains the
/// codec's own depth/node ceiling. Preparation discards all results on failure.
pub fn visit_assigned<'a>(
    root: Tree<'a>,
    max_nodes: usize,
    mut visit: impl FnMut(Paint<'a>),
    mut cancelled: impl FnMut() -> bool,
) -> Result<usize, Error> {
    fn walk<'a>(
        node: Tree<'a>,
        depth: usize,
        count: &mut usize,
        max: usize,
        visit: &mut impl FnMut(Paint<'a>),
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        check(cancelled)?;
        *count += 1;
        if *count > max {
            return Err(Error::NodeLimit);
        }
        match node.view()? {
            View::Leaf(Some(value)) => visit(value),
            View::Leaf(None) => {}
            View::Split(_, _, children) => {
                if depth >= MAX_DEPTH {
                    return Err(Error::DepthLimit);
                }
                for i in 0..children.len() {
                    walk(children.get(i), depth + 1, count, max, visit, cancelled)?;
                }
            }
        }
        Ok(())
    }
    let mut count = 0;
    walk(
        root,
        0,
        &mut count,
        max_nodes.min(MAX_ROOT_NODES),
        &mut visit,
        &mut cancelled,
    )?;
    check(&mut cancelled)?;
    Ok(count)
}
/// Compact leaf wire text; consumers still enforce their material-state limit.
/// State zero denotes unpainted. No per-triangle tree or String is allocated.
pub struct LeafText {
    bytes: [u8; 18],
    len: usize,
}
impl LeafText {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}
pub fn encode_leaf(state: u8) -> LeafText {
    let mut bytes = [b'F'; 18];
    let len = if state <= 2 {
        bytes[0] = HEX[usize::from(state << 2)];
        1
    } else {
        let n = usize::from(state - 3);
        bytes[0] = HEX[n % 15];
        let end = 1 + n / 15;
        bytes[end] = b'C';
        end + 1
    };
    LeafText { bytes, len }
}
