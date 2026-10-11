//! The manual Cycle grammar (`manualCyclePattern.ts`, after Snapmaker Orca
//! v2.3.4's `normalize_manual_pattern`): compact digits 1–9, `[N]` for IDs up
//! to 99, slash-separated decimal IDs, commas between perimeter groups —
//! parsed into exact groups and the bracket syntax the engine reads, with
//! every problem located by UTF-16 offset. Nothing is collapsed or reordered.
use super::text::{cat, num, u};
use crate::js_math::convert::{json_stringify, utf16_number};
use orcaxr_contracts::canonical::Value;

/// `MAX_MANUAL_CYCLE_TOOL_ID`.
pub const MAX_TOOL: u32 = 99;

/// `ManualCyclePatternLocation`.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub start_offset: usize,
    pub end_offset: usize,
    pub group_index: usize,
    pub token_index: Option<usize>,
}
impl Location {
    pub fn path(&self) -> String {
        match self.token_index {
            None => format!("groups[{}]", self.group_index),
            Some(token) => format!("groups[{}].tokens[{token}]", self.group_index),
        }
    }
}

/// `ManualCyclePatternIssue`.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub message: Vec<u16>,
    pub location: Location,
    pub raw: Option<Vec<u16>>,
    /// The ID a token spelled (binary64, as `Number(digits)` reads it).
    pub tool_id: Option<f64>,
}

/// `ManualCyclePatternToken`.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tool_id: u32,
    pub raw: Vec<u16>,
    pub canonical: Vec<u16>,
    pub location: Location,
}

/// `ManualCyclePatternGroup`.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub index: usize,
    pub raw: Vec<u16>,
    pub start_offset: usize,
    pub end_offset: usize,
    pub tokens: Vec<Token>,
}

/// `ManualCyclePatternParseResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub ok: bool,
    pub syntax_valid: bool,
    pub input: Vec<u16>,
    pub normalized: Vec<u16>,
    pub groups: Vec<Group>,
    pub sequence: Vec<u32>,
    pub issues: Vec<Issue>,
}

/// `parseManualCyclePattern`: `available`, when given, are the one-based IDs
/// the project has; an absent one is an `unknown-tool-id` at its token.
pub fn parse(input: &[u16], available: Option<&[u32]>) -> Parsed {
    let mut issues = Vec::new();
    let mut groups = Vec::new();
    if input.is_empty() {
        issues.push(make(
            "empty-pattern",
            u("Enter at least one physical filament ID."),
            location(0, 0, 0, None),
            None,
            None,
        ));
        return finish(input, groups, issues);
    }
    let comma = u16::from(b',');
    let mut group_start = 0;
    let mut group_index = 0;
    for offset in 0..=input.len() {
        if offset < input.len() && input[offset] != comma {
            continue;
        }
        let raw = input[group_start..offset].to_vec();
        let mut group = Group {
            index: group_index,
            raw: raw.clone(),
            start_offset: group_start,
            end_offset: offset,
            tokens: Vec::new(),
        };
        if raw.is_empty() {
            let at_end = offset == input.len();
            let start = if at_end {
                offset.saturating_sub(1)
            } else {
                offset
            };
            issues.push(make(
                "empty-group",
                u("Each comma-separated perimeter group must contain at least one filament token."),
                location(
                    start,
                    if at_end { offset } else { offset + 1 },
                    group_index,
                    None,
                ),
                None,
                None,
            ));
        } else if raw.contains(&u16::from(b'/')) {
            slash_group(&mut group, available, &mut issues);
        } else {
            compact_group(&mut group, available, &mut issues);
        }
        groups.push(group);
        group_start = offset + 1;
        group_index += 1;
    }
    finish(input, groups, issues)
}

/// `appendManualCycleQuickToken`: the pattern with one more canonical token.
pub fn append_quick_token(input: &[u16], tool_id: u32) -> Option<Vec<u16>> {
    (1..=MAX_TOOL)
        .contains(&tool_id)
        .then(|| cat(&[input, &canonical(tool_id)]))
}

fn compact_group(group: &mut Group, available: Option<&[u32]>, issues: &mut Vec<Issue>) {
    let raw = group.raw.clone();
    let mut local = 0;
    let mut token_index = 0;
    while local < raw.len() {
        let start = group.start_offset + local;
        let width = if (0xd800..0xdc00).contains(&raw[local])
            && raw
                .get(local + 1)
                .is_some_and(|next| (0xdc00..0xe000).contains(next))
        {
            2
        } else {
            1
        };
        let character = &raw[local..local + width];
        let unit = character[0];
        if width == 1 && (u16::from(b'1')..=u16::from(b'9')).contains(&unit) {
            let tool = u32::from(unit - u16::from(b'0'));
            add_token(
                &mut group.tokens,
                character.to_vec(),
                tool,
                start,
                start + 1,
                group.index,
                token_index,
                available,
                issues,
            );
            local += 1;
            token_index += 1;
            continue;
        }
        if width == 1 && unit == u16::from(b'0') {
            issues.push(make(
                "zero-tool-id",
                u("Filament IDs are one-based; replace 0 with an ID from 1 to 99."),
                location(start, start + 1, group.index, Some(token_index)),
                Some(character.to_vec()),
                Some(0.0),
            ));
            local += 1;
            token_index += 1;
            continue;
        }
        if width == 1 && unit == u16::from(b'[') {
            let close = raw[local + 1..]
                .iter()
                .position(|&c| c == u16::from(b']'))
                .map(|p| p + local + 1);
            let Some(close) = close else {
                issues.push(make(
                    "unclosed-bracket",
                    u("Close this multi-digit filament token with ]."),
                    location(start, group.end_offset, group.index, Some(token_index)),
                    Some(raw[local..].to_vec()),
                    None,
                ));
                break;
            };
            let token = raw[local..=close].to_vec();
            explicit_token(
                &token,
                start,
                group.index,
                token_index,
                available,
                issues,
                &mut group.tokens,
            );
            local = close + 1;
            token_index += 1;
            continue;
        }
        issues.push(make(
            "unexpected-character",
            cat(&[
                &u("Unexpected "),
                &json_stringify(&Value::String(character.to_vec())),
                &u("; use digits, [N], slash separators, or commas."),
            ]),
            location(start, start + width, group.index, Some(token_index)),
            Some(character.to_vec()),
            None,
        ));
        local += width;
        token_index += 1;
    }
}

fn slash_group(group: &mut Group, available: Option<&[u32]>, issues: &mut Vec<Issue>) {
    let raw = group.raw.clone();
    let slash = u16::from(b'/');
    let mut segment_start = 0;
    let mut token_index = 0;
    for local in 0..=raw.len() {
        if local < raw.len() && raw[local] != slash {
            continue;
        }
        let token = &raw[segment_start..local];
        if token.is_empty() {
            let at_end = local == raw.len();
            let absolute = group.start_offset + local;
            let start = if at_end {
                group.start_offset.max(absolute.saturating_sub(1))
            } else {
                absolute
            };
            issues.push(make(
                "empty-token",
                u("Each slash must separate two decimal filament IDs."),
                location(
                    start,
                    if at_end { absolute } else { absolute + 1 },
                    group.index,
                    Some(token_index),
                ),
                None,
                None,
            ));
        } else {
            explicit_token(
                token,
                group.start_offset + segment_start,
                group.index,
                token_index,
                available,
                issues,
                &mut group.tokens,
            );
        }
        segment_start = local + 1;
        token_index += 1;
    }
}

#[allow(clippy::too_many_arguments)]
fn explicit_token(
    raw: &[u16],
    start: usize,
    group_index: usize,
    token_index: usize,
    available: Option<&[u32]>,
    issues: &mut Vec<Issue>,
    tokens: &mut Vec<Token>,
) {
    // A single unit cannot both open and close.
    let bracketed = raw.first() == Some(&u16::from(b'[')) && raw.last() == Some(&u16::from(b']'));
    let digits: &[u16] = if bracketed {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    let end = start + raw.len();
    let here = location(start, end, group_index, Some(token_index));
    if bracketed && digits.is_empty() {
        issues.push(make(
            "empty-bracket-token",
            u("Put a filament ID between [ and ]."),
            here,
            Some(raw.to_vec()),
            None,
        ));
        return;
    }
    if digits.is_empty()
        || !digits
            .iter()
            .all(|&unit| (u16::from(b'0')..=u16::from(b'9')).contains(&unit))
    {
        issues.push(make(
            "non-decimal-tool-id",
            u("Filament tokens must contain only ASCII decimal digits."),
            here,
            Some(raw.to_vec()),
            None,
        ));
        return;
    }
    let value = utf16_number(digits);
    if digits.len() > 1 && digits[0] == u16::from(b'0') {
        issues.push(make(
            "leading-zero-tool-id",
            u("Filament IDs cannot contain leading zeroes."),
            here,
            Some(raw.to_vec()),
            Some(value),
        ));
        return;
    }
    if value == 0.0 {
        issues.push(make(
            "zero-tool-id",
            u("Filament IDs are one-based; replace 0 with an ID from 1 to 99."),
            here,
            Some(raw.to_vec()),
            Some(value),
        ));
        return;
    }
    if digits.len() > 2 || value > f64::from(MAX_TOOL) {
        issues.push(make(
            "tool-id-out-of-range",
            cat(&[
                &u("Filament "),
                digits,
                &u(" cannot be encoded; the pinned engine supports IDs 1 to 99."),
            ]),
            here,
            Some(raw.to_vec()),
            Some(value),
        ));
        return;
    }
    add_token(
        tokens,
        raw.to_vec(),
        value as u32,
        start,
        end,
        group_index,
        token_index,
        available,
        issues,
    );
}

#[allow(clippy::too_many_arguments)]
fn add_token(
    tokens: &mut Vec<Token>,
    raw: Vec<u16>,
    tool_id: u32,
    start: usize,
    end: usize,
    group_index: usize,
    token_index: usize,
    available: Option<&[u32]>,
    issues: &mut Vec<Issue>,
) {
    let here = location(start, end, group_index, Some(token_index));
    tokens.push(Token {
        tool_id,
        raw: raw.clone(),
        canonical: canonical(tool_id),
        location: here.clone(),
    });
    if available.is_some_and(|ids| !ids.contains(&tool_id)) {
        issues.push(Issue {
            code: "unknown-tool-id",
            message: cat(&[
                &u("Filament "),
                &num(f64::from(tool_id)),
                &u(" is not available in this project."),
            ]),
            location: here,
            raw: Some(raw),
            tool_id: Some(f64::from(tool_id)),
        });
    }
}

fn finish(input: &[u16], groups: Vec<Group>, issues: Vec<Issue>) -> Parsed {
    let syntax_valid = !issues.iter().any(|issue| issue.code != "unknown-tool-id");
    let sequence: Vec<u32> = groups
        .iter()
        .flat_map(|group| group.tokens.iter().map(|token| token.tool_id))
        .collect();
    let normalized = if syntax_valid {
        let parts: Vec<Vec<u16>> = groups
            .iter()
            .map(|group| {
                group
                    .tokens
                    .iter()
                    .flat_map(|token| token.canonical.clone())
                    .collect()
            })
            .collect();
        parts.join(&[u16::from(b',')][..])
    } else {
        Vec::new()
    };
    Parsed {
        ok: syntax_valid && issues.is_empty(),
        syntax_valid,
        input: input.to_vec(),
        normalized,
        groups,
        sequence,
        issues,
    }
}

fn make(
    code: &'static str,
    message: Vec<u16>,
    location: Location,
    raw: Option<Vec<u16>>,
    tool_id: Option<f64>,
) -> Issue {
    Issue {
        code,
        message,
        location,
        raw,
        tool_id,
    }
}
fn location(
    start_offset: usize,
    end_offset: usize,
    group_index: usize,
    token_index: Option<usize>,
) -> Location {
    Location {
        start_offset,
        end_offset,
        group_index,
        token_index,
    }
}
/// `canonicalToolToken`: a digit, or `[N]` past 9.
fn canonical(tool_id: u32) -> Vec<u16> {
    if tool_id <= 9 {
        num(f64::from(tool_id))
    } else {
        cat(&[&u("["), &num(f64::from(tool_id)), &u("]")])
    }
}
