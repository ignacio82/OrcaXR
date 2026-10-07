//! Bounded streaming model XML validation. Events are provisional until finish;
//! this is syntax/namespace admission, not 3MF graph or project admission.
pub mod graph;
pub mod package;
pub mod part;
mod tag;
mod text;
use std::{
    collections::BTreeMap,
    fmt,
    io::{self, Write},
};
use tag::{AttributeRecord, Frame};
const CHUNK: usize = 4096;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub text_units: usize,
    /// One markup tag or entity; comments, CDATA and processing instructions stream.
    pub token_bytes: usize,
    pub elements: usize,
    pub attributes: usize,
    pub depth: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    ResourceLimit,
    Utf8,
    XmlCharacter,
    Syntax,
    Namespace,
    Cancelled,
}
pub enum Error<E> {
    Input(Failure),
    Visitor(E),
}
impl<E> From<Failure> for Error<E> {
    fn from(value: Failure) -> Self {
        Self::Input(value)
    }
}
impl<E> fmt::Debug for Error<E> {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(e) => write!(out, "model_xml_{e:?}"),
            Self::Visitor(_) => out.write_str("model_xml_visitor_failed"),
        }
    }
}
impl<E> fmt::Display for Error<E> {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, out)
    }
}
impl<E> std::error::Error for Error<E> {}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Receipt {
    pub input_bytes: usize,
    pub text_units: usize,
    pub elements: usize,
    pub attributes: usize,
    pub max_depth: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct Attribute<'a> {
    /// Original qualified spelling, preserved for extension round trips.
    pub name: &'a str,
    /// Local part after the optional prefix.
    pub local_name: &'a str,
    /// Namespace URI, if the attribute is prefixed or is an xmlns declaration.
    /// The default namespace does not apply to unprefixed attributes.
    pub namespace: Option<&'a str>,
    pub value: &'a str,
}
#[derive(Clone, Copy, Debug)]
pub struct Tag<'a> {
    pub raw: &'a str,
    /// Original qualified spelling.
    pub name: &'a str,
    pub self_closing: bool,
    attributes: &'a [AttributeRecord],
    namespaces: &'a BTreeMap<String, Vec<String>>,
}
/// Decode the five predefined or numeric XML entities in a previously
/// scanner-validated text span. The bound applies to each encoded entity token.
pub fn decode_text(raw: &str, entity_limit: usize) -> Result<String, Failure> {
    Ok(text::decode(raw, entity_limit)?.unwrap_or_else(|| raw.to_owned()))
}
#[derive(Clone, Copy, Debug)]
pub enum Event<'a> {
    Open(Tag<'a>),
    Close {
        raw: &'a str,
        name: &'a str,
    },
    /// Raw text contains only complete, validated entity references.
    Text(&'a str),
    /// The browser replaces comments, CDATA and processing instructions by spaces.
    Ignored {
        text_units: usize,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Text,
    Prefix,
    Tag,
    Comment,
    Cdata,
    Instruction,
}

/// Write decompressed bytes directly into this private scanner. Ignoring a Write
/// error cannot make finish succeed. Finish validates EOF and returns the original
/// typed callback failure; Debug/Display never format that private error. Dropping
/// performs no callbacks and establishes no proof. A host owns blocking I/O and
/// discards every staged event after input, callback or cancellation failure.
pub struct Scanner<V, C, E> {
    limits: Limits,
    visit: V,
    cancelled: C,
    failure: Option<Error<E>>,
    receipt: Receipt,
    utf8: text::Utf8,
    first: bool,
    dtd: text::Dtd,
    mode: Mode,
    buffer: String,
    quote: Option<char>,
    entity_start: Option<usize>,
    brackets: u8,
    ignored_units: usize,
    tail: u8,
    stack: Vec<Frame>,
    namespaces: BTreeMap<String, Vec<String>>,
    root_count: usize,
    attributes: Vec<AttributeRecord>,
    attribute_order: Vec<usize>,
    expanded_order: Vec<usize>,
}
impl<V, C, E> Scanner<V, C, E>
where
    V: FnMut(Event<'_>) -> Result<(), E>,
    C: FnMut() -> bool,
{
    pub fn new(limits: Limits, cancelled: C, visit: V) -> Self {
        Self {
            limits,
            visit,
            cancelled,
            failure: None,
            receipt: Receipt::default(),
            utf8: Default::default(),
            first: true,
            dtd: Default::default(),
            mode: Mode::Text,
            buffer: String::new(),
            quote: None,
            entity_start: None,
            brackets: 0,
            ignored_units: 0,
            tail: 0,
            stack: vec![],
            namespaces: BTreeMap::from([(
                "xml".into(),
                vec!["http://www.w3.org/XML/1998/namespace".into()],
            )]),
            root_count: 0,
            attributes: vec![],
            attribute_order: vec![],
            expanded_order: vec![],
        }
    }
    pub fn failure(&self) -> Option<&Error<E>> {
        self.failure.as_ref()
    }
    fn check(&mut self) -> Result<(), Error<E>> {
        if (self.cancelled)() {
            Err(Failure::Cancelled.into())
        } else {
            Ok(())
        }
    }
    fn emit(&mut self, event: Event<'_>) -> Result<(), Error<E>> {
        self.check()?;
        (self.visit)(event).map_err(Error::Visitor)
    }
    fn flush_text(&mut self) -> Result<(), Error<E>> {
        if self.entity_start.is_some() {
            return Err(Failure::Syntax.into());
        }
        if !self.buffer.is_empty() {
            self.check()?;
            (self.visit)(Event::Text(&self.buffer)).map_err(Error::Visitor)?;
            self.buffer.clear();
        }
        Ok(())
    }
    fn flush_ignored(&mut self) -> Result<(), Error<E>> {
        if self.ignored_units > 0 {
            self.emit(Event::Ignored {
                text_units: self.ignored_units,
            })?;
            self.ignored_units = 0;
        }
        Ok(())
    }
    fn character(&mut self, c: char) -> Result<(), Error<E>> {
        if self.first {
            self.first = false;
            if c == '\u{feff}' {
                return Ok(());
            }
        }
        charge(
            &mut self.receipt.text_units,
            c.len_utf16(),
            self.limits.text_units,
        )?;
        if !text::xml_character(c as u32) {
            return Err(Failure::XmlCharacter.into());
        }
        match self.mode {
            Mode::Text => {
                if c == '<' {
                    self.flush_text()?;
                    self.buffer.push(c);
                    self.brackets = 0;
                    self.mode = Mode::Prefix;
                } else {
                    if self.stack.is_empty() && !text::whitespace(c) {
                        return Err(Failure::Syntax.into());
                    }
                    if c == '>' && self.brackets == 2 {
                        return Err(Failure::Syntax.into());
                    }
                    self.brackets = if c == ']' {
                        (self.brackets + 1).min(2)
                    } else {
                        0
                    };
                    if c == '&' {
                        if self.entity_start.is_some() {
                            return Err(Failure::Syntax.into());
                        }
                        self.entity_start = Some(self.buffer.len());
                    }
                    self.buffer.push(c);
                    if let Some(start) = self.entity_start {
                        if self.buffer.len() - start > self.limits.token_bytes {
                            return Err(Failure::ResourceLimit.into());
                        }
                        if c == ';' {
                            text::entity(&self.buffer[start..])?;
                            self.entity_start = None;
                        }
                    }
                    if self.buffer.len() >= CHUNK && self.entity_start.is_none() {
                        self.flush_text()?;
                    }
                }
            }
            Mode::Prefix => {
                self.buffer.push(c);
                match self.buffer.as_str() {
                    "<!--" => self.begin_ignored(Mode::Comment)?,
                    "<![CDATA[" => {
                        if self.stack.is_empty() {
                            return Err(Failure::Syntax.into());
                        }
                        self.begin_ignored(Mode::Cdata)?;
                    }
                    "<?" => self.begin_ignored(Mode::Instruction)?,
                    prefix if prefix.starts_with("<!") => {
                        if !["<!--", "<![CDATA["].iter().any(|s| s.starts_with(prefix)) {
                            return Err(Failure::Syntax.into());
                        }
                    }
                    _ => {
                        self.mode = Mode::Tag;
                        // This character may already end a malformed/empty tag.
                        self.tag_character(c)?;
                    }
                }
                if self.mode == Mode::Tag && self.buffer.len() > self.limits.token_bytes {
                    return Err(Failure::ResourceLimit.into());
                }
            }
            Mode::Tag => {
                self.buffer.push(c);
                if self.buffer.len() > self.limits.token_bytes {
                    return Err(Failure::ResourceLimit.into());
                }
                self.tag_character(c)?;
            }
            Mode::Comment | Mode::Cdata | Mode::Instruction => {
                self.ignored_units += c.len_utf16();
                let end = match self.mode {
                    Mode::Comment => {
                        if c == '-' {
                            self.tail += 1;
                            if self.tail > 3 {
                                return Err(Failure::Syntax.into());
                            }
                            false
                        } else if c == '>' && self.tail >= 2 {
                            true
                        } else {
                            if self.tail >= 2 {
                                return Err(Failure::Syntax.into());
                            }
                            self.tail = 0;
                            false
                        }
                    }
                    Mode::Cdata => {
                        if c == '>' && self.tail == 2 {
                            true
                        } else {
                            self.tail = if c == ']' { (self.tail + 1).min(2) } else { 0 };
                            false
                        }
                    }
                    Mode::Instruction => {
                        let end = c == '>' && self.tail == 1;
                        self.tail = u8::from(c == '?');
                        end
                    }
                    _ => unreachable!(),
                };
                if end || self.ignored_units >= CHUNK {
                    self.flush_ignored()?;
                }
                if end {
                    self.mode = Mode::Text;
                    self.tail = 0;
                }
            }
        }
        Ok(())
    }
    fn begin_ignored(&mut self, mode: Mode) -> Result<(), Error<E>> {
        self.ignored_units = self.buffer.encode_utf16().count();
        self.buffer.clear();
        self.mode = mode;
        self.tail = 0;
        Ok(())
    }
    fn tag_character(&mut self, c: char) -> Result<(), Error<E>> {
        if let Some(q) = self.quote {
            if c == q {
                self.quote = None;
            } else if c == '<' || c == '>' {
                return Err(Failure::Syntax.into());
            }
        } else if c == '\'' || c == '"' {
            self.quote = Some(c);
        } else if c == '>' {
            self.finish_tag()?;
            self.mode = Mode::Text;
            self.buffer.clear();
        }
        Ok(())
    }
    fn byte(&mut self, b: u8) -> Result<(), Error<E>> {
        charge(&mut self.receipt.input_bytes, 1, self.limits.input_bytes)?;
        self.dtd.byte(b)?;
        if let Some(c) = self.utf8.byte(b)? {
            self.character(c)?;
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Receipt, Error<E>> {
        if let Some(error) = self.failure.take() {
            return Err(error);
        }
        self.check()?;
        self.utf8.finish()?;
        self.dtd.finish()?;
        if self.mode != Mode::Text {
            return Err(Failure::Syntax.into());
        }
        self.flush_text()?;
        if !self.stack.is_empty() || self.root_count != 1 {
            return Err(Failure::Syntax.into());
        }
        self.check()?;
        Ok(self.receipt)
    }
}
impl<V, C, E> Write for Scanner<V, C, E>
where
    V: FnMut(Event<'_>) -> Result<(), E>,
    C: FnMut() -> bool,
{
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.failure.is_some() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let result = (|| {
            self.check()?;
            for (i, &b) in bytes.iter().enumerate() {
                if i % CHUNK == 0 {
                    self.check()?;
                }
                self.byte(b)?;
            }
            self.check()
        })();
        if let Err(error) = result {
            self.failure = Some(error);
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.failure.is_some() {
            Err(io::ErrorKind::InvalidData.into())
        } else {
            Ok(())
        }
    }
}
fn charge(value: &mut usize, n: usize, max: usize) -> Result<(), Failure> {
    *value = value
        .checked_add(n)
        .filter(|v| *v <= max)
        .ok_or(Failure::ResourceLimit)?;
    Ok(())
}
