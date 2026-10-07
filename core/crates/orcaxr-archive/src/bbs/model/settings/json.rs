//! JSON string projection over fixed private output. User text never becomes
//! raw JSON; UTF-16 surrogate halves remain canonical JSON escapes.
use super::*;
use std::io;
const CHUNK: usize = 4096;
pub(super) struct Writer<'a, W, C> {
    out: &'a mut W,
    cancelled: C,
    limit: usize,
    bytes: usize,
    used: usize,
    buffer: [u8; CHUNK],
    failure: Option<Error>,
}
impl<'a, W: Write, C: FnMut() -> bool> Writer<'a, W, C> {
    pub(super) fn new(out: &'a mut W, limit: usize, cancelled: C) -> Result<Self, Error> {
        let mut s = Self {
            out,
            cancelled,
            limit,
            bytes: 0,
            used: 0,
            buffer: [0; CHUNK],
            failure: None,
        };
        s.poll()?;
        Ok(s)
    }
    pub(super) fn poll(&mut self) -> Result<(), Error> {
        if let Some(e) = self.failure {
            return Err(e);
        }
        if (self.cancelled)() {
            self.failure = Some(Error::Cancelled);
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    fn drain(&mut self) -> Result<(), Error> {
        let mut cursor = 0;
        while cursor < self.used {
            self.poll()?;
            match self.out.write(&self.buffer[cursor..self.used]) {
                Ok(0) => return Err(Error::Io(io::ErrorKind::WriteZero)),
                Ok(n) if n <= self.used - cursor => cursor += n,
                Ok(_) => return Err(Error::Io(io::ErrorKind::InvalidData)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Error::Io(e.kind())),
            }
        }
        self.used = 0;
        self.poll()
    }
    /// Codec-generated JSON/ASCII only. Dynamic text uses contents/quoted.
    pub(super) fn raw(&mut self, mut bytes: &[u8]) -> Result<(), Error> {
        let result = (|| {
            self.poll()?;
            self.bytes = self
                .bytes
                .checked_add(bytes.len())
                .filter(|&n| n <= self.limit)
                .ok_or(Error::OutputLimit)?;
            while !bytes.is_empty() {
                let n = bytes.len().min(CHUNK - self.used);
                self.buffer[self.used..self.used + n].copy_from_slice(&bytes[..n]);
                self.used += n;
                bytes = &bytes[n..];
                if self.used == CHUNK {
                    self.drain()?;
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            self.failure = Some(e);
        }
        result
    }
    fn escape_unit(&mut self, unit: u16) -> Result<(), Error> {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        self.raw(&[
            b'\\',
            b'u',
            HEX[usize::from(unit >> 12)],
            HEX[usize::from((unit >> 8) & 15)],
            HEX[usize::from((unit >> 4) & 15)],
            HEX[usize::from(unit & 15)],
        ])
    }
    pub(super) fn contents(&mut self, v: &[u16]) -> Result<(), Error> {
        for c in char::decode_utf16(v.iter().copied()) {
            match c {
                Err(e) => self.escape_unit(e.unpaired_surrogate())?,
                Ok('"') => self.raw(b"\\\"")?,
                Ok('\\') => self.raw(b"\\\\")?,
                Ok('\u{08}') => self.raw(b"\\b")?,
                Ok('\u{0c}') => self.raw(b"\\f")?,
                Ok('\n') => self.raw(b"\\n")?,
                Ok('\r') => self.raw(b"\\r")?,
                Ok('\t') => self.raw(b"\\t")?,
                Ok(c) if c < '\u{20}' => self.escape_unit(c as u16)?,
                Ok(c) => self.raw(c.encode_utf8(&mut [0; 4]).as_bytes())?,
            }
        }
        self.poll()
    }
    pub(super) fn quoted(&mut self, v: &[u16]) -> Result<(), Error> {
        self.raw(b"\"")?;
        self.contents(v)?;
        self.raw(b"\"")
    }
    pub(super) fn number(&mut self, v: f64) -> Result<(), Error> {
        self.raw(numbers::number(v).map_err(Error::Number)?.as_bytes())
    }
    pub(super) fn unsigned(&mut self, mut v: u64) -> Result<(), Error> {
        let mut b = [0; 20];
        let mut i = b.len();
        loop {
            i -= 1;
            b[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        self.raw(&b[i..])
    }
    /// bbsValue inside an already open JSON string. Arrays join recursively;
    /// objects emit canonical JSON, escaped again as the outer string's text.
    pub(super) fn bbs(&mut self, v: &Value) -> Result<(), Error> {
        self.poll()?;
        match v {
            Value::Null => {}
            Value::Bool(v) => self.raw(if *v { b"1" } else { b"0" })?,
            Value::Number(v) => self.number(*v)?,
            Value::String(v) => self.contents(v)?,
            Value::Array(values) => {
                for (i, v) in values.iter().enumerate() {
                    if i != 0 {
                        self.raw(b";")?;
                    }
                    self.bbs(v)?;
                }
            }
            Value::Object(_) => {
                struct Sink<'a, 'b, W, C> {
                    w: &'a mut Writer<'b, W, C>,
                    error: Option<Error>,
                }
                impl<W: Write, C: FnMut() -> bool> Write for Sink<'_, '_, W, C> {
                    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                        let result = (|| {
                            let text = std::str::from_utf8(bytes).map_err(|_| Error::Encoding)?;
                            for c in text.chars() {
                                self.w.contents(c.encode_utf16(&mut [0; 2]))?;
                            }
                            Ok(())
                        })();
                        match result {
                            Ok(()) => Ok(bytes.len()),
                            Err(e) => {
                                self.error = Some(e);
                                Err(io::ErrorKind::Other.into())
                            }
                        }
                    }
                    fn flush(&mut self) -> io::Result<()> {
                        Ok(())
                    }
                }
                let mut sink = Sink {
                    w: self,
                    error: None,
                };
                let result = v.write_canonical(&mut sink);
                if let Some(e) = sink.error {
                    return Err(e);
                }
                result.map_err(|_| Error::Encoding)?;
            }
        }
        Ok(())
    }
    pub(super) fn finish(mut self) -> Result<usize, Error> {
        self.poll()?;
        self.drain()?;
        self.poll()?;
        Ok(self.bytes)
    }
}
