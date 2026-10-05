// Copyright 2011 the V8 project authors. All rights reserved.
// Rust adaptation of the V8 date parser in Node v22.21.0. BSD-3-Clause terms
// and upstream source attribution are in core/licenses/V8-BSD.txt and NOTICE.md.
//! V8-compatible timestamp syntax, with host timezone conversion kept explicit.
//!
//! `Date.parse` permits implementation-specific legacy syntax. This implements
//! the pinned V8 grammar, not every JavaScript engine's undocumented extensions.
//! It retains UTF-16/NUL behavior, legacy dates, overflow days, two-digit years,
//! fractional seconds and numeric timezone offsets. No string is normalized.
//!
//! A local result needs the host's local-to-UTC conversion (including its DST
//! disambiguation and historical timezone rules). UTC is never an implicit
//! fallback. Resolver failure is distinct from a syntactically invalid date.
use crate::ids::ecmascript_whitespace;

const DAY_MS: i64 = 86_400_000;
const MAX_MS: i64 = 100_000_000 * DAY_MS;
const MAX_LOCAL_MS: i64 = MAX_MS + 30 * DAY_MS;

/// V8's legacy timezone overflow check depends on its tagged integer width.
/// Chromium with pointer compression uses Smi31; uncompressed 64-bit Node uses
/// Smi32. Require the host to choose explicitly rather than using Rust's usize.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V8IntegerMode {
    Smi31,
    Smi32,
}
impl V8IntegerMode {
    fn maximum(self) -> u32 {
        match self {
            Self::Smi31 => (1 << 30) - 1,
            Self::Smi32 => (1 << 31) - 1,
        }
    }
}

/// A local civil date/time represented as milliseconds from the Unix epoch
/// *without* a timezone adjustment. The parser normalizes overflow days first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalDateTime(i64);
impl LocalDateTime {
    pub fn civil_milliseconds(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp(Parsed);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parsed {
    Utc(i64),
    Local(LocalDateTime),
}
impl Timestamp {
    /// Return a clipped UTC timestamp, calling the resolver only for a local
    /// input. Propagate unavailable timezone services as `Err`, not invalid
    /// project data. Values beyond ECMAScript's TimeClip range return `Ok(None)`.
    pub fn resolve<E>(
        self,
        local_to_utc: impl FnOnce(LocalDateTime) -> Result<i64, E>,
    ) -> Result<Option<i64>, E> {
        let milliseconds = match self.0 {
            Parsed::Utc(value) => value,
            Parsed::Local(value) => local_to_utc(value)?,
        };
        Ok(clip(milliseconds))
    }

    pub fn local(self) -> Option<LocalDateTime> {
        match self.0 {
            Parsed::Local(value) => Some(value),
            Parsed::Utc(_) => None,
        }
    }
}
fn clip(value: i64) -> Option<i64> {
    (-MAX_MS..=MAX_MS).contains(&value).then_some(value)
}

/// Parse without allocating or accessing the process timezone. An explicit UTC
/// offset is applied and TimeClip-checked here. A local timestamp is range-checked
/// before invoking a host resolver through [`Timestamp::resolve`].
pub fn parse(input: &[u16], integers: V8IntegerMode) -> Option<Timestamp> {
    let mut scanner = Scanner::new(input);
    let mut day = Day::default();
    let mut time = Time::default();
    let mut zone = Zone::default();
    let mut token = iso(&mut scanner, &mut day, &mut time, &mut zone)?;
    let mut read_number = day.len != 0;
    while token != Token::End {
        match token {
            Token::Number(n, _) => {
                read_number = true;
                if scanner.skip(b':') {
                    if scanner.skip(b':') {
                        if time.len != 0 {
                            return None;
                        }
                        time.push(n);
                        time.push(0);
                    } else {
                        if !time.push(n) {
                            return None;
                        }
                        scanner.skip(b'.');
                    }
                } else if scanner.skip(b'.') && time.expecting(n) {
                    time.push(n);
                    let ms = milliseconds(scanner.next())?;
                    time.finish(ms);
                } else if zone.expecting(n) {
                    zone.minute = Some(n);
                } else if time.expecting(n) {
                    time.finish(n);
                    if !matches!(scanner.peek, Token::End | Token::Whitespace)
                        && !scanner.peek.is_z()
                        && scanner.peek.sign().is_none()
                    {
                        return None;
                    }
                } else {
                    if !day.push(n) {
                        return None;
                    }
                    scanner.skip(b'-');
                }
            }
            Token::Word(word, _) => match word {
                Word::AmPm(offset) if time.len != 0 => time.hour_offset = Some(offset),
                Word::Month(month) => {
                    day.month = Some(month);
                    scanner.skip(b'-');
                }
                Word::Zone(offset) if read_number => zone.set(offset),
                _ => {
                    if read_number || matches!(scanner.peek, Token::Number(..)) {
                        return None;
                    }
                }
            },
            Token::Symbol(b'+' | b'-') if zone.is_utc() || time.len != 0 => {
                zone.sign = token.sign();
                let (n, len) = if let Token::Number(n, len) = scanner.peek {
                    scanner.next();
                    (n, len)
                } else {
                    (0, 0)
                };
                read_number = true;
                if scanner.peek == Token::Symbol(b':') {
                    zone.hour = Some(n);
                    zone.minute = None;
                } else if len == 1 || len == 2 {
                    zone.hour = Some(n);
                    zone.minute = Some(0);
                } else if len == 3 || len == 4 {
                    zone.hour = Some(n / 100);
                    zone.minute = Some(n % 100);
                } else {
                    return None;
                }
            }
            Token::Symbol(b'+' | b'-' | b')') if read_number => return None,
            _ => {}
        }
        token = scanner.next();
    }
    let (year, month, date) = day.components()?;
    let civil = days(year, month, date)? * DAY_MS + time.milliseconds()?;
    if let Some(offset) = zone.offset(integers)? {
        clip(civil - offset * 1000).map(|value| Timestamp(Parsed::Utc(value)))
    } else {
        (-MAX_LOCAL_MS..=MAX_LOCAL_MS)
            .contains(&civil)
            .then_some(Timestamp(Parsed::Local(LocalDateTime(civil))))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Word {
    Invalid,
    Month(i32),
    AmPm(i32),
    Zone(i32),
    Time,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Number(i32, usize),
    Word(Word, usize),
    Symbol(u8),
    Whitespace,
    Unknown,
    End,
}
impl Token {
    fn sign(self) -> Option<i32> {
        match self {
            Self::Symbol(b'+') => Some(1),
            Self::Symbol(b'-') => Some(-1),
            _ => None,
        }
    }
    fn fixed(self, len: usize, min: i32, max: i32) -> Option<i32> {
        match self {
            Self::Number(n, l) if l == len && (min..=max).contains(&n) => Some(n),
            _ => None,
        }
    }
    fn is_z(self) -> bool {
        self == Self::Word(Word::Zone(0), 1)
    }
}

struct Scanner<'a> {
    input: &'a [u16],
    position: usize,
    peek: Token,
}
impl<'a> Scanner<'a> {
    fn new(input: &'a [u16]) -> Self {
        let mut result = Self {
            input,
            position: 0,
            peek: Token::End,
        };
        result.peek = result.scan();
        result
    }
    fn current(&self) -> u16 {
        self.input.get(self.position).copied().unwrap_or(0)
    }
    fn next(&mut self) -> Token {
        let result = self.peek;
        self.peek = self.scan();
        result
    }
    fn skip(&mut self, symbol: u8) -> bool {
        if self.peek == Token::Symbol(symbol) {
            self.next();
            true
        } else {
            false
        }
    }
    fn scan(&mut self) -> Token {
        let ch = self.current();
        if ch == 0 {
            return Token::End;
        }
        let start = self.position;
        if digit(ch) {
            let mut n = 0;
            while self.current() == b'0' as u16 {
                self.position += 1;
            }
            let significant_start = self.position;
            while digit(self.current()) {
                if self.position - significant_start < 9 {
                    n = n * 10 + i32::from(self.current() - 48);
                }
                self.position += 1;
            }
            return Token::Number(n, self.position - start);
        }
        if matches!(ch, 0x3a | 0x2d | 0x2b | 0x2e | 0x29) {
            self.position += 1;
            return Token::Symbol(ch as u8);
        }
        if ch >= 0x41 && !word_space(ch) {
            let mut prefix = [0u16; 3];
            while self.current() >= 0x41 && !word_space(self.current()) {
                if self.position - start < 3 {
                    prefix[self.position - start] = self.current() | 0x20;
                }
                self.position += 1;
            }
            let len = self.position - start;
            return Token::Word(keyword(prefix, len), len);
        }
        if ecmascript_whitespace(ch) {
            self.position += 1;
            return Token::Whitespace;
        }
        if ch == 0x28 {
            let mut balance = 0usize;
            loop {
                match self.current() {
                    0x28 => balance += 1,
                    0x29 => balance -= 1,
                    _ => {}
                }
                self.position += 1;
                if balance == 0 || self.current() == 0 {
                    break;
                }
            }
        } else {
            self.position += 1;
        }
        Token::Unknown
    }
}
fn digit(ch: u16) -> bool {
    (0x30..=0x39).contains(&ch)
}
// V8's word scanner distinguishes WhiteSpace from LineTerminator. U+2028 and
// U+2029 can therefore be part of a legacy word even though trim removes them.
fn word_space(ch: u16) -> bool {
    ecmascript_whitespace(ch) && !matches!(ch, 0x0a | 0x0d | 0x2028 | 0x2029)
}
fn keyword(prefix: [u16; 3], len: usize) -> Word {
    const MONTHS: [&[u8; 3]; 12] = [
        b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov",
        b"dec",
    ];
    for (i, month) in MONTHS.iter().enumerate() {
        if prefix == month.map(u16::from) {
            return Word::Month(i as i32 + 1);
        }
    }
    if len > 3 {
        return Word::Invalid;
    }
    for (name, word) in [
        (b"am\0", Word::AmPm(0)),
        (b"pm\0", Word::AmPm(12)),
        (b"ut\0", Word::Zone(0)),
        (b"utc", Word::Zone(0)),
        (b"z\0\0", Word::Zone(0)),
        (b"gmt", Word::Zone(0)),
        (b"cdt", Word::Zone(-5)),
        (b"cst", Word::Zone(-6)),
        (b"edt", Word::Zone(-4)),
        (b"est", Word::Zone(-5)),
        (b"mdt", Word::Zone(-6)),
        (b"mst", Word::Zone(-7)),
        (b"pdt", Word::Zone(-7)),
        (b"pst", Word::Zone(-8)),
        (b"t\0\0", Word::Time),
    ] {
        if prefix == name.map(u16::from) {
            return word;
        }
    }
    Word::Invalid
}

#[derive(Default)]
struct Day {
    values: [i32; 3],
    len: usize,
    month: Option<i32>,
    iso: bool,
}
impl Day {
    fn push(&mut self, n: i32) -> bool {
        if self.len == 3 {
            return false;
        }
        self.values[self.len] = n;
        self.len += 1;
        true
    }
    fn components(mut self) -> Option<(i32, i32, i32)> {
        if self.len == 0 {
            return None;
        }
        while self.len < 3 {
            self.push(1);
        }
        let [a, b, c] = self.values;
        let (mut year, month, day) = match self.month {
            None if self.iso || !is_day(a) => (a, b, c),
            None => (c, a, b),
            Some(month) if !is_day(a) => (a, month, b),
            Some(month) => (b, month, a),
        };
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        ((1..=12).contains(&month) && is_day(day)).then_some((year, month, day))
    }
}
fn is_day(n: i32) -> bool {
    (1..=31).contains(&n)
}
#[derive(Default)]
struct Time {
    values: [i32; 4],
    len: usize,
    hour_offset: Option<i32>,
}
impl Time {
    fn push(&mut self, n: i32) -> bool {
        if self.len == 4 {
            return false;
        }
        self.values[self.len] = n;
        self.len += 1;
        true
    }
    fn finish(&mut self, n: i32) {
        if self.push(n) {
            while self.len < 4 {
                self.push(0);
            }
        }
    }
    fn expecting(&self, n: i32) -> bool {
        match self.len {
            1 | 2 => (0..=59).contains(&n),
            3 => (0..=999).contains(&n),
            _ => false,
        }
    }
    fn milliseconds(self) -> Option<i64> {
        let [mut h, m, s, ms] = self.values;
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&h) {
                return None;
            }
            h = h % 12 + offset;
        }
        if (!(0..=23).contains(&h)
            || !(0..=59).contains(&m)
            || !(0..=59).contains(&s)
            || !(0..=999).contains(&ms))
            && (h != 24 || m != 0 || s != 0 || ms != 0)
        {
            return None;
        }
        Some(i64::from(h) * 3_600_000 + i64::from(m) * 60_000 + i64::from(s) * 1000 + i64::from(ms))
    }
}
#[derive(Default)]
struct Zone {
    sign: Option<i32>,
    hour: Option<i32>,
    minute: Option<i32>,
}
impl Zone {
    fn set(&mut self, offset: i32) {
        self.sign = Some(if offset < 0 { -1 } else { 1 });
        self.hour = Some(offset.abs());
        self.minute = Some(0);
    }
    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }
    fn expecting(&self, n: i32) -> bool {
        self.hour.is_some() && self.minute.is_none() && (0..=59).contains(&n)
    }
    fn offset(self, integers: V8IntegerMode) -> Option<Option<i64>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        // Upstream intentionally uses unsigned wrapping before the Smi check.
        let seconds = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        (seconds <= integers.maximum()).then_some(Some(i64::from(seconds) * i64::from(sign)))
    }
}
fn milliseconds(token: Token) -> Option<i32> {
    let Token::Number(n, len) = token else {
        return None;
    };
    Some(match len {
        1 => n * 100,
        2 => n * 10,
        3 => n,
        _ => n / 10i32.pow((len.min(9) - 3) as u32),
    })
}

// None is terminal ISO failure. Otherwise continue the legacy parser with the
// unconsumed token and the composers already filled by the ISO prefix.
fn iso(
    scanner: &mut Scanner<'_>,
    day: &mut Day,
    time: &mut Time,
    zone: &mut Zone,
) -> Option<Token> {
    if let Some(sign) = scanner.peek.sign() {
        let sign_token = scanner.next();
        let Some(year) = scanner.peek.fixed(6, 0, 999999) else {
            return Some(sign_token);
        };
        scanner.next();
        if sign < 0 && year == 0 {
            return Some(sign_token);
        }
        day.push(sign * year);
    } else if let Some(year) = scanner.peek.fixed(4, 0, 9999) {
        scanner.next();
        day.push(year);
    } else {
        return Some(scanner.next());
    }
    if scanner.skip(b'-') {
        let Some(month) = scanner.peek.fixed(2, 1, 12) else {
            return Some(scanner.next());
        };
        scanner.next();
        day.push(month);
        if scanner.skip(b'-') {
            let Some(date) = scanner.peek.fixed(2, 1, 31) else {
                return Some(scanner.next());
            };
            scanner.next();
            day.push(date);
        }
    }
    if !matches!(scanner.peek, Token::Word(Word::Time, _)) {
        if scanner.peek != Token::End {
            return Some(scanner.next());
        }
    } else {
        scanner.next();
        let hour = scanner.peek.fixed(2, 0, 24)?;
        scanner.next();
        time.push(hour);
        if !scanner.skip(b':') {
            return None;
        }
        let max = if hour == 24 { 0 } else { 59 };
        let minute = scanner.peek.fixed(2, 0, max)?;
        scanner.next();
        time.push(minute);
        if scanner.skip(b':') {
            let second = scanner.peek.fixed(2, 0, max)?;
            scanner.next();
            time.push(second);
            if scanner.skip(b'.') {
                if hour == 24 && !matches!(scanner.peek, Token::Number(0, _)) {
                    return None;
                }
                time.push(milliseconds(scanner.next())?);
            }
        }
        if scanner.peek.is_z() {
            scanner.next();
            zone.set(0);
        } else if let Some(sign) = scanner.peek.sign() {
            scanner.next();
            zone.sign = Some(sign);
            if let Some(hm) = scanner.peek.fixed(4, 0, 9999) {
                scanner.next();
                if hm / 100 > 23 || hm % 100 > 59 {
                    return None;
                }
                zone.hour = Some(hm / 100);
                zone.minute = Some(hm % 100);
            } else {
                zone.hour = Some(scanner.peek.fixed(2, 0, 23)?);
                scanner.next();
                if !scanner.skip(b':') {
                    return None;
                }
                zone.minute = Some(scanner.peek.fixed(2, 0, 59)?);
                scanner.next();
            }
        }
        if scanner.peek != Token::End {
            return None;
        }
    }
    if zone.hour.is_none() && time.len == 0 {
        zone.set(0);
    }
    day.iso = true;
    Some(Token::End)
}

// Proleptic Gregorian calendar. Month/day were checked syntactically, but a day
// such as February 31 deliberately rolls into March as in MakeDay, not rejected.
fn days(year: i32, month: i32, day: i32) -> Option<i64> {
    if !(-1_000_000..=1_000_000).contains(&year) {
        return None;
    }
    let before_year = |year: i64| {
        365 * year + (year - 1).div_euclid(4) - (year - 1).div_euclid(100)
            + (year - 1).div_euclid(400)
    };
    let prior_months = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month as usize - 1];
    let leap_day = i64::from(month > 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    Some(
        before_year(i64::from(year)) - before_year(1970) + prior_months + leap_day + i64::from(day)
            - 1,
    )
}
