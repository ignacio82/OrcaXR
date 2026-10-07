//! Readable text over one sealed G-code source (the browser `GcodeDocument`).
//!
//! The index stores one `u32` start per line; windows and searches borrow the
//! immutable UTF-16 source instead of splitting or lowercasing a copy of the
//! whole program. Lines are numbered from 1 and end at `\n`; one trailing `\r`
//! is not part of a line's text, and a final newline does not start a line.
//! Search folds each line independently with ECMAScript `toLowerCase`
//! semantics, so a character whose lowercase form has a different length can
//! never move a result onto another line. Lone surrogates are preserved.
use crate::Cancellation;
use std::sync::Arc;

/// The browser panel's default result cap and hard host request ceilings,
/// from the shared G-code buffer contract. Callers may pass anything smaller.
pub use crate::layout::{MAX_QUERY_UNITS, MAX_SEARCH_LIMIT, MAX_SEARCH_RESULTS};
const CHECK_UNITS: usize = 1 << 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentError {
    ResourceLimit,
    Cancelled,
}

#[derive(Clone, Copy, Debug)]
pub struct WindowLimits {
    pub lines: usize,
    pub units: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Line<'a> {
    pub number: usize,
    pub text: &'a [u16],
}
#[derive(Debug, PartialEq, Eq)]
pub struct Search {
    pub line_numbers: Vec<usize>,
    /// At least one further line matched beyond the limit. Exactly `limit`
    /// matching lines is a complete answer, not a lower bound.
    pub truncated: bool,
}

pub struct Document {
    source: Arc<[u16]>,
    starts: Vec<u32>,
}
impl Document {
    /// Index line starts. Allocation is proportional to the line count and the
    /// source must fit the `u32` offsets the sealed G-code limit guarantees.
    pub fn new(source: Arc<[u16]>, cancellation: &Cancellation) -> Result<Self, DocumentError> {
        if u32::try_from(source.len()).is_err() {
            return Err(DocumentError::ResourceLimit);
        }
        let mut starts = Vec::new();
        starts
            .try_reserve(1)
            .map_err(|_| DocumentError::ResourceLimit)?;
        starts.push(0);
        for (chunk_index, chunk) in source.chunks(CHECK_UNITS).enumerate() {
            if cancellation.is_cancelled() {
                return Err(DocumentError::Cancelled);
            }
            let base = chunk_index * CHECK_UNITS;
            for (i, unit) in chunk.iter().enumerate() {
                if *unit == u16::from(b'\n') {
                    starts
                        .try_reserve(1)
                        .map_err(|_| DocumentError::ResourceLimit)?;
                    starts.push((base + i + 1) as u32);
                }
            }
        }
        // A trailing newline is not a line an operator would count.
        if starts.len() > 1 && *starts.last().unwrap() as usize >= source.len() {
            starts.pop();
        }
        starts.shrink_to_fit();
        Ok(Self { source, starts })
    }
    pub fn line_count(&self) -> usize {
        self.starts.len()
    }
    /// Source length in UTF-16 code units.
    pub fn len(&self) -> usize {
        self.source.len()
    }
    pub fn is_empty(&self) -> bool {
        self.source.is_empty()
    }
    /// One 1-based line without its newline and one trailing carriage return.
    pub fn line(&self, number: usize) -> Option<&[u16]> {
        if number == 0 || number > self.starts.len() {
            return None;
        }
        let begin = self.starts[number - 1] as usize;
        let stop = if number < self.starts.len() {
            self.starts[number] as usize - 1
        } else {
            self.source.len()
        };
        let mut text = &self.source[begin..stop];
        if let Some(rest) = text.strip_suffix(&[u16::from(b'\n')]) {
            text = rest;
        }
        if let Some(rest) = text.strip_suffix(&[u16::from(b'\r')]) {
            text = rest;
        }
        Some(text)
    }
    /// The 1-based line containing a UTF-16 offset.
    pub fn line_at(&self, offset: usize) -> usize {
        self.starts
            .partition_point(|start| *start as usize <= offset)
            .max(1)
    }
    /// Lines `[from, from + count)`, clamped like the browser viewer: a window
    /// past either end shows the nearest real lines rather than failing.
    /// Non-finite or nonpositive counts are empty. The clamped result must fit
    /// the caller's line and text-unit budgets.
    pub fn window(
        &self,
        from: f64,
        count: f64,
        limits: WindowLimits,
    ) -> Result<Vec<Line<'_>>, DocumentError> {
        if !from.is_finite() || !count.is_finite() || count <= 0.0 {
            return Ok(Vec::new());
        }
        let line_count = self.starts.len() as f64;
        let start = 1f64.max(from.floor().min(line_count));
        let end = line_count.min(start + count.floor() - 1.0);
        if end < start {
            return Ok(Vec::new());
        }
        let (start, end) = (start as usize, end as usize);
        if end - start + 1 > limits.lines {
            return Err(DocumentError::ResourceLimit);
        }
        let mut units = 0usize;
        let mut lines = Vec::new();
        lines
            .try_reserve_exact(end - start + 1)
            .map_err(|_| DocumentError::ResourceLimit)?;
        for number in start..=end {
            let text = self.line(number).expect("clamped line");
            units = units
                .checked_add(text.len())
                .filter(|n| *n <= limits.units)
                .ok_or(DocumentError::ResourceLimit)?;
            lines.push(Line { number, text });
        }
        Ok(lines)
    }
    /// Lines containing `query` case-insensitively (ECMAScript `trim` and
    /// `toLowerCase`), in order, each at most once.
    pub fn search(
        &self,
        query: &[u16],
        limit: usize,
        cancellation: &Cancellation,
    ) -> Result<Search, DocumentError> {
        if query.len() > MAX_QUERY_UNITS || limit > MAX_SEARCH_LIMIT {
            return Err(DocumentError::ResourceLimit);
        }
        let mut needle = Vec::new();
        fold_into(trim(query), &mut needle);
        if needle.is_empty() {
            return Ok(Search {
                line_numbers: Vec::new(),
                truncated: false,
            });
        }
        let ascii_needle = needle.iter().all(|u| *u < 0x80);
        let table = prefix_table(&needle);
        let mut folded = Vec::new();
        let mut line_numbers = Vec::new();
        let mut scanned = 0usize;
        for number in 1..=self.starts.len() {
            let line = self.line(number).expect("indexed line");
            scanned += line.len() + 1;
            if scanned >= CHECK_UNITS {
                scanned = 0;
                if cancellation.is_cancelled() {
                    return Err(DocumentError::Cancelled);
                }
            }
            let found = if line.iter().all(|u| *u < 0x80) {
                ascii_needle
                    && contains(
                        line.iter().map(|u| {
                            if (u16::from(b'A')..=u16::from(b'Z')).contains(u) {
                                u + 32
                            } else {
                                *u
                            }
                        }),
                        &needle,
                        &table,
                    )
            } else {
                folded.clear();
                fold_into(line, &mut folded);
                contains(folded.iter().copied(), &needle, &table)
            };
            if !found {
                continue;
            }
            if line_numbers.len() >= limit {
                return Ok(Search {
                    line_numbers,
                    truncated: true,
                });
            }
            line_numbers
                .try_reserve(1)
                .map_err(|_| DocumentError::ResourceLimit)?;
            line_numbers.push(number);
        }
        Ok(Search {
            line_numbers,
            truncated: false,
        })
    }
}

/// ECMAScript WhiteSpace and LineTerminator (`String.prototype.trim`).
fn is_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f
            | 0x3000 | 0xfeff
    )
}
fn trim(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|u| !is_space(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !is_space(*u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}

/// ECMAScript `toLowerCase`: Unicode default lowercasing with the Final_Sigma
/// context, leaving lone surrogates unchanged. A lone surrogate is neither cased
/// nor case-ignorable, so it bounds the sigma context exactly like any other
/// such character; folding each well-formed run separately is equivalent.
pub fn fold_into(units: &[u16], out: &mut Vec<u16>) {
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<u16>| {
        if !run.is_empty() {
            out.extend(run.to_lowercase().encode_utf16());
            run.clear();
        }
    };
    // ASCII letters are cased context for a following or preceding sigma, so
    // runs split only at lone surrogates.
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => run.push(c),
            Err(lone) => {
                flush(&mut run, out);
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    flush(&mut run, out);
}

fn prefix_table(needle: &[u16]) -> Vec<usize> {
    let mut table = vec![0; needle.len()];
    let mut k = 0;
    for i in 1..needle.len() {
        while k > 0 && needle[i] != needle[k] {
            k = table[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        table[i] = k;
    }
    table
}
/// Knuth-Morris-Pratt over a folded unit stream; linear in the line length.
fn contains(haystack: impl Iterator<Item = u16>, needle: &[u16], table: &[usize]) -> bool {
    let mut k = 0;
    for unit in haystack {
        while k > 0 && unit != needle[k] {
            k = table[k - 1];
        }
        if unit == needle[k] {
            k += 1;
            if k == needle.len() {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn document(s: &str) -> Document {
        Document::new(units(s).into(), &Cancellation::default()).unwrap()
    }
    const ALL: WindowLimits = WindowLimits {
        lines: usize::MAX,
        units: usize::MAX,
    };
    #[test]
    fn folding_matches_ecmascript_for_length_changes_sigma_and_surrogates() {
        // Expectations recorded from V8 `String.prototype.toLowerCase`.
        for (input, expected) in [
            (units("İ ΟΔΟΣ ΣΑ \u{212A} Σ"), units("i̇ οδος σα k σ")),
            (units("AΣ"), units("aς")),
            (units("AΣ."), units("aς.")),
            (units("ΣΣ"), units("σς")),
            (vec![0x41, 0xd800, 0x3a3], vec![0x61, 0xd800, 0x3c3]),
            (
                vec![0x41, 0x3a3, 0xd800, 0x42],
                vec![0x61, 0x3c2, 0xd800, 0x62],
            ),
            (vec![0xd800, 0x41, 0xdc00], vec![0xd800, 0x61, 0xdc00]),
        ] {
            let mut out = Vec::new();
            fold_into(&input, &mut out);
            assert_eq!(out, expected, "{input:x?}");
        }
    }
    #[test]
    fn windows_clamp_and_strip_terminators() {
        let doc = document("G28\r\nM104 S230\r\n");
        assert_eq!(doc.line_count(), 2);
        let window = doc.window(0.0, 5.0, ALL).unwrap();
        assert_eq!(window[1].text, units("M104 S230"));
        assert_eq!(doc.window(100.0, 5.0, ALL).unwrap()[0].number, 2);
        assert!(doc.window(1.0, 0.5, ALL).unwrap().is_empty());
        assert_eq!(document("").line_count(), 1);
        assert_eq!(
            doc.window(
                1.0,
                2.0,
                WindowLimits {
                    lines: 1,
                    units: 99
                }
            ),
            Err(DocumentError::ResourceLimit)
        );
    }
    #[test]
    fn search_is_per_line_bounded_and_exact_about_truncation() {
        let doc = document(&format!(
            ";{}\nG1 X1\nG1 X2\nG1 X3\nM104 S200\nG1 X4\n",
            "İ".repeat(20)
        ));
        let c = Cancellation::default();
        assert_eq!(
            doc.search(&units("M104"), 500, &c).unwrap().line_numbers,
            [5]
        );
        assert_eq!(
            doc.search(&units(" g1 "), 500, &c).unwrap().line_numbers,
            [2, 3, 4, 6]
        );
        let exact = doc.search(&units("g1"), 4, &c).unwrap();
        assert!(!exact.truncated);
        let short = doc.search(&units("g1"), 3, &c).unwrap();
        assert_eq!((short.line_numbers.len(), short.truncated), (3, true));
        assert!(
            doc.search(&units("G1 X1\nG1"), 500, &c)
                .unwrap()
                .line_numbers
                .is_empty()
        );
        assert!(
            doc.search(&units("  "), 500, &c)
                .unwrap()
                .line_numbers
                .is_empty()
        );
        assert_eq!(
            doc.search(&vec![u16::from(b'x'); MAX_QUERY_UNITS + 1], 500, &c),
            Err(DocumentError::ResourceLimit)
        );
    }
    #[test]
    fn cancellation_stops_indexing_and_long_searches() {
        let source: Arc<[u16]> = units(&"G1 X1 E0.1\n".repeat(20_000)).into();
        let cancelled = Cancellation::default();
        cancelled.cancel();
        assert_eq!(
            Document::new(source.clone(), &cancelled).err(),
            Some(DocumentError::Cancelled)
        );
        let doc = Document::new(source, &Cancellation::default()).unwrap();
        assert_eq!(doc.line_count(), 20_000);
        assert_eq!(doc.line_at(0), 1);
        assert_eq!(doc.line_at(11), 2);
        assert_eq!(
            doc.search(&units("M104"), 500, &cancelled),
            Err(DocumentError::Cancelled)
        );
    }
}
