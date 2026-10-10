//! G-code bytes to the UTF-16 the parser reads, exactly as the browser reads
//! a G-code file (`TextDecoder('utf-8', { fatal: false })`): the WHATWG UTF-8
//! decoder, so each maximal malformed subsequence becomes one U+FFFD and a
//! byte that cannot continue a sequence is read again on its own, with one
//! leading byte-order mark dropped. Streaming gives the same text however
//! the bytes are split, so a native host can decode as it reads.

/// One stream's decoder; feed chunks in order, the last with `last = true`.
#[derive(Debug)]
pub struct Utf8Decoder {
    code_point: u32,
    seen: u8,
    needed: u8,
    lower: u8,
    upper: u8,
    /// Whether the first code point has been decided on (BOM or not).
    started: bool,
}

impl Default for Utf8Decoder {
    fn default() -> Self {
        Self {
            code_point: 0,
            seen: 0,
            needed: 0,
            lower: 0x80,
            upper: 0xBF,
            started: false,
        }
    }
}

const REPLACEMENT: u32 = 0xFFFD;

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// A decoder for bytes from the middle of a stream, starting where the
    /// whole stream's decoder starts a fresh sequence: a byte-order mark
    /// there is text, not a mark to drop.
    pub(crate) fn fragment() -> Self {
        Self {
            started: true,
            ..Self::default()
        }
    }

    /// Decode `bytes`, appending UTF-16 to `out`; `last` ends the stream, so
    /// an unfinished sequence becomes U+FFFD.
    pub fn decode(&mut self, bytes: &[u8], last: bool, out: &mut Vec<u16>) {
        let mut index = 0;
        while index < bytes.len() {
            let byte = bytes[index];
            if self.needed == 0 {
                index += 1;
                match byte {
                    0x00..=0x7F => self.emit(u32::from(byte), out),
                    0xC2..=0xDF => self.begin(1, u32::from(byte & 0x1F)),
                    0xE0..=0xEF => {
                        if byte == 0xE0 {
                            self.lower = 0xA0;
                        }
                        if byte == 0xED {
                            self.upper = 0x9F;
                        }
                        self.begin(2, u32::from(byte & 0x0F));
                    }
                    0xF0..=0xF4 => {
                        if byte == 0xF0 {
                            self.lower = 0x90;
                        }
                        if byte == 0xF4 {
                            self.upper = 0x8F;
                        }
                        self.begin(3, u32::from(byte & 0x07));
                    }
                    _ => self.emit(REPLACEMENT, out),
                }
                continue;
            }
            if !(self.lower..=self.upper).contains(&byte) {
                // Not a continuation here: the sequence so far is one error,
                // and this byte starts over (it is not consumed).
                self.reset();
                self.emit(REPLACEMENT, out);
                continue;
            }
            index += 1;
            self.lower = 0x80;
            self.upper = 0xBF;
            self.code_point = (self.code_point << 6) | u32::from(byte & 0x3F);
            self.seen += 1;
            if self.seen == self.needed {
                let code_point = self.code_point;
                self.reset();
                self.emit(code_point, out);
            }
        }
        if last && self.needed != 0 {
            self.reset();
            self.emit(REPLACEMENT, out);
        }
    }

    fn begin(&mut self, needed: u8, bits: u32) {
        self.needed = needed;
        self.code_point = bits;
    }

    fn reset(&mut self) {
        self.code_point = 0;
        self.seen = 0;
        self.needed = 0;
        self.lower = 0x80;
        self.upper = 0xBF;
    }

    fn emit(&mut self, code_point: u32, out: &mut Vec<u16>) {
        if !self.started {
            self.started = true;
            if code_point == 0xFEFF {
                return;
            }
        }
        if code_point >= 0x10000 {
            let offset = code_point - 0x10000;
            out.push(0xD800 | (offset >> 10) as u16);
            out.push(0xDC00 | (offset & 0x3FF) as u16);
        } else {
            out.push(code_point as u16);
        }
    }
}

/// Decode a whole file.
pub fn decode_utf8(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(bytes.len());
    Utf8Decoder::new().decode(bytes, true, &mut out);
    out
}
