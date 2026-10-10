//! `String.prototype.toLowerCase` over UTF-16: Unicode 16 default lowercase,
//! Final_Sigma included, pinned to the browser reference corpus
//! (`contracts/opc-lowercase.json`). Ports use it instead of Rust's
//! version-dependent Unicode tables, for persisted OPC names and for matching
//! text the browser lowercases. Lone surrogates pass through unchanged.
use super::case_data::{CASED, EXPANSIONS, IGNORABLE, LOWER};

fn contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    let i = ranges.partition_point(|&(_, end)| end < cp);
    ranges.get(i).is_some_and(|&(start, _)| start <= cp)
}

fn points(input: &[u16]) -> impl Iterator<Item = u32> + Clone + '_ {
    char::decode_utf16(input.iter().copied())
        .map(|c| c.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from))
}

fn emit(cp: u32, output: &mut Vec<u16>) {
    if cp <= 0xffff {
        output.push(cp as u16);
    } else {
        let n = cp - 0x10000;
        output.extend_from_slice(&[(0xd800 + (n >> 10)) as u16, (0xdc00 + (n & 1023)) as u16]);
    }
}

pub fn lower(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut before = false;
    let mut chars = points(input);
    while let Some(cp) = chars.next() {
        // Sigma is non-ignorable, so successive forward context scans never
        // overlap. Both passes together remain linear, without a context buffer.
        if cp == 0x3a3
            && before
            && !chars
                .clone()
                .find(|&c| !contains(IGNORABLE, c))
                .is_some_and(|c| contains(CASED, c))
        {
            emit(0x3c2, &mut output);
        } else if let Some((_, mapped)) = EXPANSIONS.iter().find(|&&(source, _)| source == cp) {
            for &c in *mapped {
                emit(c, &mut output);
            }
        } else {
            let i = LOWER.partition_point(|&(_, end, _, _)| end < cp);
            let mapped = LOWER
                .get(i)
                .filter(|&&(start, _, step, _)| cp >= start && (cp - start) % step == 0)
                .map_or(cp, |&(_, _, _, delta)| {
                    (i64::from(cp) + i64::from(delta)) as u32
                });
            emit(mapped, &mut output);
        }
        // Some characters are both Cased and Case_Ignorable. Unicode's
        // possessive context rule skips those before testing Cased.
        if !contains(IGNORABLE, cp) {
            before = contains(CASED, cp);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn units(value: &Value) -> Vec<u16> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect()
    }

    #[test]
    fn exhaustive_scalars_and_contexts_match_captured_unicode_16() {
        let data: Value =
            serde_json::from_str(include_str!("../../../../../contracts/opc-lowercase.json"))
                .unwrap();
        let mut mappings = data["lower"].as_array().unwrap().iter().peekable();
        let mut count = 0;
        for cp in 0..=0x10ffff {
            let Some(c) = char::from_u32(cp) else {
                continue;
            };
            let input = c.encode_utf16(&mut [0; 2]).to_vec();
            let expected = if mappings
                .peek()
                .is_some_and(|row| row[0].as_u64() == Some(u64::from(cp)))
            {
                let row = mappings.next().unwrap();
                let mut result = Vec::new();
                for n in row[1].as_array().unwrap() {
                    emit(n.as_u64().unwrap() as u32, &mut result);
                }
                result
            } else {
                input.clone()
            };
            assert_eq!(lower(&input), expected, "scalar U+{cp:04X}");
            count += 1;
        }
        assert_eq!(count, 1_112_064);
        assert!(mappings.next().is_none());
        for row in data["contexts"].as_array().unwrap() {
            assert_eq!(lower(&units(&row["input"])), units(&row["output"]));
        }
        for cp in 0xd800..=0xdfff {
            assert_eq!(lower(&[cp]), [cp]);
        }
        // Long ignorable runs must remain linear and preserve combining marks.
        let input = format!(
            "AΣ{}Σ{}",
            "\u{345}".repeat(100_000),
            "\u{345}".repeat(100_000)
        );
        let expected = format!(
            "aσ{}ς{}",
            "\u{345}".repeat(100_000),
            "\u{345}".repeat(100_000)
        );
        assert_eq!(
            lower(&input.encode_utf16().collect::<Vec<_>>()),
            expected.encode_utf16().collect::<Vec<_>>()
        );
    }
}
