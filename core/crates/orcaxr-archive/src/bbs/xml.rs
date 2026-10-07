//! Bounded streaming primitives for BBS XML authoring. This is not a complete
//! model/package writer. All bytes remain provisional until the package owner
//! finishes every member; discard the private output on any error.
use super::numbers;
use orcaxr_project::model::Transform;
use std::{fmt, io};
const CHUNK: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    OutputLimit,
    TextLimit,
    XmlCharacter,
    Number(numbers::Error),
    Cancelled,
    Io(io::ErrorKind),
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "bbs_xml_{self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    pub output_bytes: usize,
    /// Aggregate UTF-16 units passed to text/attribute methods, including escapes.
    /// This is input work, not resident memory. Literals and numbers are separate.
    pub text_units: usize,
}
#[derive(Clone, Copy, Debug)]
pub enum MatrixOrder {
    ThreeMf,
    RowMajor4,
}

/// A fixed 4 KiB staging buffer over caller-owned private output. Cancellation
/// is polled during text/geometry writes and on every short/Interrupted retry.
/// Any failure poisons the writer: ignoring an earlier error cannot make finish
/// succeed. Dropping the writer never writes. Durable flush belongs to the host.
pub struct Writer<'a, W, C> {
    out: &'a mut W,
    cancelled: C,
    limits: Limits,
    text_units: usize,
    bytes: usize,
    buffer: [u8; CHUNK],
    used: usize,
    failure: Option<Error>,
}
impl<'a, W: io::Write, C: FnMut() -> bool> Writer<'a, W, C> {
    pub fn new(out: &'a mut W, limits: Limits, cancelled: C) -> Result<Self, Error> {
        let mut writer = Self {
            out,
            cancelled,
            limits,
            text_units: 0,
            bytes: 0,
            buffer: [0; CHUNK],
            used: 0,
            failure: None,
        };
        writer.check()?;
        Ok(writer)
    }
    fn check(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if (self.cancelled)() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    fn perform<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, Error>) -> Result<T, Error> {
        let result = self.check().and_then(|()| f(self));
        if let Err(error) = result {
            self.failure = Some(error);
        }
        result
    }
    fn drain(&mut self) -> Result<(), Error> {
        let mut cursor = 0;
        while cursor < self.used {
            self.check()?;
            match self.out.write(&self.buffer[cursor..self.used]) {
                Ok(0) => return Err(Error::Io(io::ErrorKind::WriteZero)),
                Ok(n) if n <= self.used - cursor => cursor += n,
                Ok(_) => return Err(Error::Io(io::ErrorKind::InvalidData)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Error::Io(e.kind())),
            }
        }
        self.used = 0;
        self.check()
    }
    fn bytes(&mut self, mut bytes: &[u8]) -> Result<(), Error> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .filter(|&n| n <= self.limits.output_bytes)
            .ok_or(Error::OutputLimit)?;
        while !bytes.is_empty() {
            let count = bytes.len().min(CHUNK - self.used);
            self.buffer[self.used..self.used + count].copy_from_slice(&bytes[..count]);
            self.used += count;
            bytes = &bytes[count..];
            if self.used == CHUNK {
                self.drain()?;
            }
        }
        Ok(())
    }
    /// Markup authored in source code only. Imported/user text goes through the
    /// escaping methods; callers must still validate dynamic attribute names.
    pub fn literal(&mut self, markup: &'static str) -> Result<(), Error> {
        self.perform(|s| s.bytes(markup.as_bytes()))
    }
    fn escaped(&mut self, units: &[u16], attribute: bool, emboss: bool) -> Result<(), Error> {
        self.text_units = self
            .text_units
            .checked_add(units.len())
            .filter(|&n| n <= self.limits.text_units)
            .ok_or(Error::TextLimit)?;
        for (i, c) in char::decode_utf16(units.iter().copied()).enumerate() {
            if i.is_multiple_of(256) {
                self.check()?;
            }
            let c = c.map_err(|_| Error::XmlCharacter)?;
            if !valid_character(c) {
                return Err(Error::XmlCharacter);
            }
            match c {
                '&' => self.bytes(b"&amp;")?,
                '<' => self.bytes(b"&lt;")?,
                '>' => self.bytes(b"&gt;")?,
                '"' if attribute => self.bytes(b"&quot;")?,
                '\'' if attribute && !emboss => self.bytes(b"&apos;")?,
                '\n' if emboss => self.bytes(b"&#10;")?,
                _ => {
                    let mut bytes = [0; 4];
                    self.bytes(c.encode_utf8(&mut bytes).as_bytes())?;
                }
            }
        }
        self.check()
    }
    pub fn attribute(&mut self, value: &[u16]) -> Result<(), Error> {
        self.perform(|s| s.escaped(value, true, false))
    }
    pub fn text(&mut self, value: &[u16]) -> Result<(), Error> {
        self.perform(|s| s.escaped(value, false, false))
    }
    /// Pinned emboss attributes encode newlines and leave apostrophes literal.
    /// The same XML character policy and aggregate limits still apply.
    pub fn emboss_attribute(&mut self, value: &[u16]) -> Result<(), Error> {
        self.perform(|s| s.escaped(value, true, true))
    }
    pub fn number(&mut self, value: f64) -> Result<(), Error> {
        self.perform(|s| s.bytes(numbers::number(value).map_err(Error::Number)?.as_bytes()))
    }
    pub fn coordinate(&mut self, value: f32) -> Result<(), Error> {
        self.perform(|s| {
            s.bytes(
                numbers::mesh_coordinate(value)
                    .map_err(Error::Number)?
                    .as_bytes(),
            )
        })
    }
    /// Stream one mesh vertex in the exact standard model indentation/order.
    /// Mesh positions remain in their borrowed packed asset until requested.
    pub fn vertex(&mut self, xyz: [f32; 3]) -> Result<(), Error> {
        self.perform(|s| {
            for (prefix, value) in [b"     <vertex x=\"".as_slice(), b"\" y=\"", b"\" z=\""]
                .into_iter()
                .zip(xyz)
            {
                s.bytes(prefix)?;
                s.bytes(
                    numbers::mesh_coordinate(value)
                        .map_err(Error::Number)?
                        .as_bytes(),
                )?;
            }
            s.bytes(b"\"/>\n")
        })
    }
    pub fn transform(
        &mut self,
        transform: &Transform,
        offset: [f64; 2],
        order: MatrixOrder,
    ) -> Result<(), Error> {
        self.perform(|s| {
            let matrix = numbers::transform_matrix(transform, offset).map_err(Error::Number)?;
            let indices: &[usize] = match order {
                MatrixOrder::ThreeMf => &[0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11],
                MatrixOrder::RowMajor4 => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            };
            for (i, &index) in indices.iter().enumerate() {
                if i != 0 {
                    s.bytes(b" ")?;
                }
                s.bytes(
                    numbers::number(matrix[index])
                        .map_err(Error::Number)?
                        .as_bytes(),
                )?;
            }
            Ok(())
        })
    }
    pub(crate) fn codec_bytes(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.perform(|s| s.bytes(bytes))
    }
    pub(crate) fn poll(&mut self) -> Result<(), Error> {
        self.perform(|_| Ok(()))
    }
    /// Finish the private XML stream. This does not flush/close the caller's
    /// destination, publish an archive, or acknowledge the project as saved.
    pub fn finish(mut self) -> Result<usize, Error> {
        self.perform(|s| s.drain())?;
        Ok(self.bytes)
    }
}

pub(crate) fn valid_character(c: char) -> bool {
    !((c < '\u{20}' && !matches!(c, '\t' | '\n' | '\r')) || matches!(c, '\u{fffe}' | '\u{ffff}'))
}
