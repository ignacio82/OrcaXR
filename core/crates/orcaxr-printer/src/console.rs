//! `PrinterConsole.ts`: typing G-code at a machine that can hurt itself.
//!
//! The work is knowing what a command does before it is sent. Unknown is not
//! safe: anything the console does not recognise — every user macro among
//! them — is `caution`. Context changes the answer: a move mid-print is
//! dangerous. Nothing a printer replies is trusted: transcript lines are
//! redacted on the way in and bounded.
//!
//! A command is named the way Klipper parses the line ([`command_name`]), a
//! script assessed ([`assess`]), an operation (send a script, read the
//! printer's macros) planned, finished and read as storage's are, a macro
//! invocation spelled so Klipper reads its values back exactly
//! ([`invocation`]), and transcript lines redacted and classified.
use crate::moonraker::{redact_text, upper};
use crate::reply::{
    Ending, LIMITS, Value, ending, field, joined, optional_reply_text, record, units,
};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::convert::{encode_uri_component, is_space, trim_utf16};
use std::collections::{BTreeMap, HashSet};
use wire::ConsoleErrorCode as Code;
use wire::GcodeRiskLevel as Level;

/// Moonraker rejects an oversized query string long before Klipper sees it.
pub const MAX_SCRIPT_UNITS: usize = 4096;

/// Commands that can damage the machine, lose a print, or run heaters
/// unattended, with the consequence a confirmation must show.
const DANGEROUS: &[(&str, &str)] = &[
    (
        "M112",
        "Halts the printer immediately; Klipper then stays shut down until a firmware restart.",
    ),
    (
        "M999",
        "Clears an error state and restarts, discarding whatever the printer was doing.",
    ),
    ("RESTART", "Restarts the host; a running print is lost."),
    (
        "FIRMWARE_RESTART",
        "Restarts the MCU connection; a running print is lost.",
    ),
    (
        "M84",
        "Releases the steppers. An unbraked Z axis can drop under the weight of the gantry.",
    ),
    (
        "M18",
        "Releases the steppers. An unbraked Z axis can drop under the weight of the gantry.",
    ),
    (
        "FORCE_MOVE",
        "Moves an axis with the kinematics bypassed — past endstops and into the bed if asked.",
    ),
    (
        "SET_KINEMATIC_POSITION",
        "Tells Klipper the toolhead is somewhere it is not; later moves act on that lie.",
    ),
    (
        "M303",
        "Runs a PID tune, cycling a heater at temperature for several minutes unattended.",
    ),
    (
        "PID_CALIBRATE",
        "Runs a PID tune, cycling a heater at temperature for several minutes unattended.",
    ),
    (
        "BED_MESH_CALIBRATE",
        "Drives the probe toward the bed across the whole surface.",
    ),
    (
        "DELTA_CALIBRATE",
        "Drives the probe toward the bed repeatedly.",
    ),
    ("PROBE", "Drives the probe into the bed until it triggers."),
    (
        "PROBE_ACCURACY",
        "Drives the probe into the bed repeatedly.",
    ),
    (
        "Z_ENDSTOP_CALIBRATE",
        "Drives the toolhead toward the bed with the endstop under test.",
    ),
    ("SDCARD_RESET_FILE", "Clears the loaded job on the printer."),
];
/// Commands that move or heat the machine: real, but ordinary, consequences.
const CAUTION: &[(&str, &str)] = &[
    ("G0", "Moves the toolhead."),
    ("G1", "Moves the toolhead."),
    ("G2", "Moves the toolhead along an arc."),
    ("G3", "Moves the toolhead along an arc."),
    ("G28", "Homes the axes, moving each to its endstop."),
    (
        "G29",
        "Runs bed levelling, moving the toolhead across the bed.",
    ),
    ("M104", "Starts heating the nozzle and returns immediately."),
    ("M109", "Heats the nozzle and waits for the target."),
    ("M140", "Starts heating the bed and returns immediately."),
    ("M190", "Heats the bed and waits for the target."),
    ("SET_HEATER_TEMPERATURE", "Changes a heater target."),
    ("M106", "Changes a fan speed."),
    ("M204", "Changes the acceleration limit for later moves."),
    (
        "SET_VELOCITY_LIMIT",
        "Changes the motion limits for later moves.",
    ),
    ("M24", "Starts or resumes the loaded job."),
    ("M25", "Pauses the loaded job."),
    ("PAUSE", "Pauses the running job."),
    ("RESUME", "Resumes the paused job."),
    (
        "CANCEL_PRINT",
        "Ends the running job; it cannot be resumed.",
    ),
    ("SET_GCODE_OFFSET", "Shifts where later moves are executed."),
];
/// Commands that only report. Everything absent from this list is `caution`.
const SAFE: &[&str] = &[
    "M105",
    "M114",
    "M115",
    "M119",
    "M31",
    "STATUS",
    "HELP",
    "GET_POSITION",
    "QUERY_ENDSTOPS",
    "QUERY_PROBE",
    "DUMP_TMC",
    "BED_MESH_OUTPUT",
    "SHOW",
];

fn lookup(table: &[(&'static str, &'static str)], name: &[u16]) -> Option<&'static str> {
    table
        .iter()
        .find(|(command, _)| units(command) == name)
        .map(|(_, reason)| *reason)
}
fn rank(level: Level) -> u8 {
    match level {
        Level::Safe => 0,
        Level::Caution => 1,
        Level::Dangerous => 2,
    }
}
fn failure(code: Code, message: &[u16]) -> wire::ConsoleFailure {
    wire::ConsoleFailure {
        code,
        message: message.to_vec(),
    }
}
fn is_js_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_space)
}

/// `stripComment`: Klipper's `;` comment and surrounding white space gone.
fn strip_comment(line: &[u16]) -> &[u16] {
    let cut = line
        .iter()
        .position(|unit| *unit == u16::from(b';'))
        .map_or(line, |at| &line[..at]);
    trim_utf16(cut)
}

/// `gcodeCommandName`: the command Klipper runs for one line, uppercased.
///
/// Klipper splits the line into runs of letters (`[A-Z_]+`) or a `*`, and
/// names the command from the first run and the text after it, after a
/// leading `N` line number; older builds skip anything before the first
/// letter, so the line is read the way that runs the most. A line Klipper
/// reads no command from keeps its first token (up to white space or `=`).
pub fn command_name(line: &[u16]) -> Vec<u16> {
    let cleaned = upper(strip_comment(line));
    let letter = |unit: u16| (u16::from(b'A')..=u16::from(b'Z')).contains(&unit);
    // The first three matches of `([A-Z_]+|[A-Z*])`.
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while at < cleaned.len() && matches.len() < 3 {
        let unit = cleaned[at];
        if letter(unit) || unit == u16::from(b'_') {
            let start = at;
            while at < cleaned.len() && (letter(cleaned[at]) || cleaned[at] == u16::from(b'_')) {
                at += 1;
            }
            matches.push((start, at));
        } else if unit == u16::from(b'*') {
            matches.push((at, at + 1));
            at += 1;
        } else {
            at += 1;
        }
    }
    // `parts[k]`: the text between matches (even k) or a match (odd k).
    let part = |k: usize| -> Option<&[u16]> {
        let index = k / 2;
        if k % 2 == 1 {
            matches.get(index).map(|&(s, e)| &cleaned[s..e])
        } else {
            let start = if index == 0 {
                0
            } else {
                matches.get(index - 1)?.1
            };
            let end = matches.get(index).map_or(cleaned.len(), |m| m.0);
            Some(&cleaned[start..end])
        }
    };
    let n = units("N");
    let command = if part(1) == Some(&n[..]) {
        joined(&[part(3).unwrap_or(&[]), trim_utf16(part(4).unwrap_or(&[]))])
    } else {
        joined(&[part(1).unwrap_or(&[]), trim_utf16(part(2).unwrap_or(&[]))])
    };
    if !command.is_empty() {
        return command;
    }
    let end = cleaned
        .iter()
        .position(|&unit| is_js_space(unit) || unit == u16::from(b'='))
        .unwrap_or(cleaned.len());
    cleaned[..end].to_vec()
}

/// `assessGcodeCommand`: what sending `script` at this machine, right now,
/// would do. A script takes the level of its riskiest line.
pub fn assess(script: &[u16], job: Option<wire::PrintJobState>) -> wire::GcodeAssessment {
    let commands: Vec<Vec<u16>> = script
        .split(|unit| *unit == u16::from(b'\n'))
        .map(strip_comment)
        .filter(|line| !line.is_empty())
        .map(command_name)
        .filter(|name| !name.is_empty())
        .collect();
    let Some(first) = commands.first() else {
        return wire::GcodeAssessment {
            command: Vec::new(),
            level: Level::Safe,
            reasons: Vec::new(),
            commands: Vec::new(),
        };
    };
    let mut level = Level::Safe;
    let mut command = first.clone();
    let mut reasons: Vec<Vec<u16>> = Vec::new();
    let mut seen = HashSet::new();
    for name in &commands {
        let dangerous = lookup(DANGEROUS, name);
        let caution = lookup(CAUTION, name);
        let safe = SAFE.iter().any(|known| units(known) == *name);
        let found = if dangerous.is_some() {
            Level::Dangerous
        } else if caution.is_some() || !safe {
            Level::Caution
        } else {
            Level::Safe
        };
        if rank(found) > rank(level) {
            level = found;
            command = name.clone();
        }
        let reason = match (dangerous, caution) {
            (Some(reason), _) | (None, Some(reason)) => Some(units(reason)),
            // A macro is whatever its author wrote; the console cannot know.
            _ if !safe => Some(joined(&[
                name,
                &units(" is not a command this console recognises, so what it does is unknown."),
            ])),
            _ => None,
        };
        if let Some(reason) = reason
            && seen.insert(reason.clone())
        {
            reasons.push(reason);
        }
    }
    // A machine mid-job interleaves anything sent here with the print itself.
    let running = match job {
        Some(wire::PrintJobState::Printing) => Some("printing"),
        Some(wire::PrintJobState::Paused) => Some("paused"),
        _ => None,
    };
    if let Some(state) = running
        && level != Level::Safe
    {
        reasons.push(units(&format!(
            "The printer is {state}; this runs alongside the job and can ruin it."
        )));
        level = Level::Dangerous;
    }
    let mut distinct = HashSet::new();
    wire::GcodeAssessment {
        command,
        level,
        reasons,
        commands: commands
            .iter()
            .filter(|name| distinct.insert((*name).clone()))
            .cloned()
            .collect(),
    }
}

/// `runGcodeScript`'s checks: the trimmed script, or why it cannot be sent.
fn script(text: &[u16]) -> Result<&[u16], wire::ConsoleFailure> {
    let trimmed = trim_utf16(text);
    if trimmed.is_empty() {
        return Err(failure(Code::EmptyScript, &units("Type a command first.")));
    }
    if trimmed.len() > MAX_SCRIPT_UNITS {
        return Err(failure(
            Code::TooLong,
            &units(&format!(
                "That script is {} characters; the printer accepts at most {MAX_SCRIPT_UNITS}.",
                trimmed.len()
            )),
        ));
    }
    // No URL can spell a lone surrogate.
    if encode_uri_component(trimmed).is_err() {
        return Err(failure(
            Code::InvalidScript,
            &units("That script has text that is not valid."),
        ));
    }
    Ok(trimmed)
}

/// What an operation sends, or why it is refused before anything leaves.
pub fn plan(op: &wire::ConsoleOperation) -> wire::ConsolePlan {
    let send = |path: String, method: &str, operation: &str| {
        wire::ConsolePlan::Request(wire::PrinterSend {
            path: units(&path),
            method: units(method),
            operation: units(operation),
            timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
        })
    };
    match op {
        wire::ConsoleOperation::Send(text) => match script(&text.text) {
            Ok(trimmed) => send(
                format!(
                    "/printer/gcode/script?script={}",
                    encode_uri_component(trimmed).unwrap_or_default()
                ),
                "POST",
                "gcode_script",
            ),
            Err(f) => wire::ConsolePlan::Refused(f),
        },
        wire::ConsoleOperation::Macros(_) => send(
            "/printer/objects/query?configfile".to_owned(),
            "GET",
            "list_macros",
        ),
    }
}

/// An operation's result once its exchange ended without a reply to read.
pub fn finish(request: &wire::ConsoleFinish) -> wire::ConsoleResult {
    let failed = wire::ConsoleResult::Failed;
    match &request.operation {
        wire::ConsoleOperation::Send(text) => {
            let trimmed = match script(&text.text) {
                Ok(trimmed) => trimmed,
                Err(f) => return failed(f),
            };
            match ending(&request.outcome) {
                Ending::Done => wire::ConsoleResult::Sent(wire::Empty {}),
                Ending::Cancelled => failed(failure(
                    Code::Cancelled,
                    &units("The command was cancelled before it was sent."),
                )),
                Ending::Failed(detail) => {
                    let name = command_name(trimmed);
                    let named = if name.is_empty() {
                        units("the command")
                    } else {
                        name
                    };
                    failed(failure(
                        Code::SendFailed,
                        &joined(&[
                            &units("The printer refused "),
                            &named,
                            &units(&format!(" ({detail}).")),
                        ]),
                    ))
                }
            }
        }
        wire::ConsoleOperation::Macros(_) => match ending(&request.outcome) {
            Ending::Done => no_configuration(),
            Ending::Cancelled => failed(failure(
                Code::Cancelled,
                &units("Reading the printer configuration was cancelled."),
            )),
            Ending::Failed(detail) => failed(failure(
                Code::MacrosUnavailable,
                &units(&format!(
                    "The printer did not report its configuration ({detail})."
                )),
            )),
        },
    }
}

fn no_configuration() -> wire::ConsoleResult {
    wire::ConsoleResult::Failed(failure(
        Code::MacrosUnavailable,
        &units("The printer reported no configuration to read macros from."),
    ))
}

/// A reply (Moonraker's `result`, as JSON) read as the browser reads it; a
/// sent script's reply carries nothing to read.
pub fn read(op: &wire::ConsoleOperation, reply: &str) -> wire::ConsoleResult {
    if let wire::ConsoleOperation::Send(_) = op {
        return finish(&wire::ConsoleFinish {
            operation: op.clone(),
            outcome: wire::PrinterExchangeOutcome::Done(wire::Empty {}),
        });
    }
    let payload = parse_javascript(reply, LIMITS).ok();
    let settings = record(payload.as_ref())
        .and_then(|p| record(field(p, "status")))
        .and_then(|s| record(field(s, "configfile")))
        .and_then(|c| record(field(c, "settings")));
    let Some(Value::Object(settings)) = settings else {
        return no_configuration();
    };
    wire::ConsoleResult::Macros(macros(settings))
}

/// `/^gcode_macro\s+(.+)$/i`: the name a config section declares.
fn macro_section(section: &[u16]) -> Option<&[u16]> {
    let prefix = units("gcode_macro");
    if section.len() <= prefix.len()
        || !section[..prefix.len()]
            .iter()
            .zip(&prefix)
            .all(|(&u, &p)| u < 0x80 && (u as u8).to_ascii_lowercase() as u16 == p)
    {
        return None;
    }
    let rest = &section[prefix.len()..];
    let spaces = rest.iter().take_while(|&&u| is_js_space(u)).count();
    if spaces == 0 {
        return None;
    }
    // `.` matches anything but a line terminator.
    let terminator = |u: &u16| matches!(*u, 0x0a | 0x0d | 0x2028 | 0x2029);
    let tail = &rest[spaces..];
    if !tail.is_empty() {
        return (!tail.iter().any(terminator)).then_some(tail);
    }
    // All white space: `\s+` gives its last unit back to `.+`.
    let last = &rest[spaces - 1..];
    (spaces >= 2 && !terminator(&last[0])).then_some(last)
}

/// `listPrinterMacros`' reading of `configfile.settings`.
fn macros(settings: &BTreeMap<Vec<u16>, Value>) -> Vec<wire::PrinterMacro> {
    let mut listed: Vec<(&[u16], wire::PrinterMacro)> = Vec::new();
    for (section, value) in settings {
        let Some(declared) = macro_section(section) else {
            continue;
        };
        if record(Some(value)).is_none() {
            continue;
        }
        let name = upper(trim_utf16(declared));
        let body = match field(value, "gcode") {
            Some(Value::String(body)) => body.clone(),
            _ => Vec::new(),
        };
        let description = match field(value, "description") {
            Some(Value::String(text)) => trim_utf16(text).to_vec(),
            _ => Vec::new(),
        };
        let shown = !description.is_empty()
            && crate::moonraker::lower(&description) != units("g-code macro");
        let assessment = assess(&body, None);
        // A macro whose body says nothing recognisable is still unknown, never safe.
        let level = if assessment.level == Level::Safe && trim_utf16(&body).is_empty() {
            Level::Caution
        } else {
            assessment.level
        };
        listed.push((
            section,
            wire::PrinterMacro {
                name,
                description: optional_reply_text(shown.then_some(description)),
                parameters: parameters(&body),
                level,
                reasons: assessment.reasons,
            },
        ));
    }
    // By name, and by section where two name the same macro.
    listed.sort_by(|(left_section, left), (right_section, right)| {
        left.name
            .cmp(&right.name)
            .then_with(|| left_section.cmp(right_section))
    });
    listed.into_iter().map(|(_, m)| m).collect()
}

fn word(unit: u16) -> bool {
    unit < 0x80 && ((unit as u8).is_ascii_alphanumeric() || unit == u16::from(b'_'))
}
fn skip_spaces(text: &[u16], mut at: usize) -> usize {
    while at < text.len() && is_js_space(text[at]) {
        at += 1;
    }
    at
}
fn starts(text: &[u16], at: usize, literal: &str) -> bool {
    let literal = units(literal);
    text.len() >= at + literal.len() && text[at..at + literal.len()] == literal[..]
}

/// One match of `params(?:\.(\w+)|\[\s*['"]([^'"]+)['"]\s*\])(\s*\|\s*default\(([^)]*)\))?`
/// at `at`: the name, the declared default and where the match ends.
fn parameter_at(body: &[u16], at: usize) -> Option<(Vec<u16>, Option<Vec<u16>>, usize)> {
    if !starts(body, at, "params") {
        return None;
    }
    let after = at + 6;
    let quote = |u: u16| u == u16::from(b'\'') || u == u16::from(b'"');
    let (name, end) = if starts(body, after, ".")
        && body
            .get(after + 1)
            .is_some_and(|&u| u < 0x80 && ((u as u8).is_ascii_alphabetic() || u == u16::from(b'_')))
    {
        let start = after + 1;
        let mut end = start + 1;
        while end < body.len() && word(body[end]) {
            end += 1;
        }
        (body[start..end].to_vec(), end)
    } else if starts(body, after, "[") {
        let open = skip_spaces(body, after + 1);
        if !body.get(open).is_some_and(|&u| quote(u)) {
            return None;
        }
        let start = open + 1;
        let mut close = start;
        while close < body.len() && !quote(body[close]) {
            close += 1;
        }
        if close == start || close >= body.len() {
            return None;
        }
        let bracket = skip_spaces(body, close + 1);
        if !starts(body, bracket, "]") {
            return None;
        }
        (body[start..close].to_vec(), bracket + 1)
    } else {
        return None;
    };
    // `(\s*\|\s*default\(([^)]*)\))?`
    let pipe = skip_spaces(body, end);
    if starts(body, pipe, "|") {
        let keyword = skip_spaces(body, pipe + 1);
        if starts(body, keyword, "default(") {
            let start = keyword + 8;
            if let Some(length) = body[start..].iter().position(|&u| u == u16::from(b')')) {
                return Some((
                    name,
                    Some(body[start..start + length].to_vec()),
                    start + length + 1,
                ));
            }
        }
    }
    Some((name, None, end))
}

/// `extractMacroParameters`: what a macro body reads, and what it defaults.
pub fn parameters(body: &[u16]) -> Vec<wire::MacroParameter> {
    let mut found: BTreeMap<Vec<u16>, (Option<Vec<u16>>, bool)> = BTreeMap::new();
    let mut at = 0;
    while at < body.len() {
        let Some((raw, declared, end)) = parameter_at(body, at) else {
            at += 1;
            continue;
        };
        at = end;
        let name = upper(&raw);
        let default = declared.map(|d| unquote(trim_utf16(&d)));
        if let Some((existing, _)) = found.get(&name)
            && (existing.is_some() || default.is_none())
        {
            continue;
        }
        let required = default.is_none();
        found.insert(name, (default, required));
    }
    found
        .into_iter()
        .map(|(name, (default, required))| wire::MacroParameter {
            name,
            default_value: optional_reply_text(default),
            required,
        })
        .collect()
}

/// `unquote`: one pair of matching quotes around a line of text removed.
fn unquote(value: &[u16]) -> Vec<u16> {
    let trimmed = trim_utf16(value);
    let quote = |u: u16| u == u16::from(b'\'') || u == u16::from(b'"');
    if trimmed.len() >= 2
        && quote(trimmed[0])
        && trimmed[0] == trimmed[trimmed.len() - 1]
        && !trimmed[1..trimmed.len() - 1]
            .iter()
            .any(|u| matches!(*u, 0x0a | 0x0d | 0x2028 | 0x2029))
    {
        return trimmed[1..trimmed.len() - 1].to_vec();
    }
    trimmed.to_vec()
}

/// `buildMacroInvocation`: `MACRO NAME=value`, each value spelled so Klipper
/// reads it back exactly, or why it cannot be.
pub fn invocation(request: &wire::MacroInvocationRequest) -> wire::MacroInvocation {
    // A record of the values: the last of a repeated key wins.
    let mut values: BTreeMap<&[u16], &[u16]> = BTreeMap::new();
    for entry in &request.values {
        values.insert(&entry.key, &entry.value);
    }
    let mut script = upper(&request.name);
    for (key, value) in values {
        let value = trim_utf16(value);
        if value.is_empty() {
            continue;
        }
        let parameter = upper(key);
        let unspellable =
            |u: &u16| is_js_space(*u) || matches!(*u, 0x3d | 0x3b | 0x23 | 0x22 | 0x27 | 0x5c);
        if parameter.is_empty() || parameter.iter().any(unspellable) {
            return wire::MacroInvocation::Refused(failure(
                Code::InvalidMacro,
                &joined(&[
                    &parameter,
                    &units(" cannot be written as a parameter name."),
                ]),
            ));
        }
        if value.iter().any(|u| matches!(*u, 0x3b | 0x0d | 0x0a)) {
            return wire::MacroInvocation::Refused(failure(
                Code::InvalidMacro,
                &joined(&[
                    &units("The value for "),
                    &parameter,
                    &units(" holds a \";\" or a line break, which a command line cannot carry."),
                ]),
            ));
        }
        let quoted = value
            .iter()
            .any(|u| is_js_space(*u) || matches!(*u, 0x22 | 0x27 | 0x5c | 0x23));
        script.push(u16::from(b' '));
        script.extend(&parameter);
        script.push(u16::from(b'='));
        if quoted {
            script.push(u16::from(b'"'));
            for &unit in value {
                if unit == u16::from(b'"') || unit == u16::from(b'\\') {
                    script.push(u16::from(b'\\'));
                }
                script.push(unit);
            }
            script.push(u16::from(b'"'));
        } else {
            script.extend(value);
        }
    }
    wire::MacroInvocation::Script(script)
}

fn secrets(list: &[Vec<u16>]) -> Vec<&[u16]> {
    list.iter()
        .map(Vec::as_slice)
        .filter(|s| !s.is_empty())
        .collect()
}

/// `PrinterConsoleLog.append`: a line as the transcript keeps it, redacted on
/// the way in.
pub fn line(request: &wire::ConsoleLineRequest) -> wire::ConsoleLine {
    wire::ConsoleLine {
        kind: request.line.kind,
        text: redact_text(&request.line.text, &secrets(&request.secrets)),
    }
}

/// `PrinterConsoleLog.appendNotification`: the line a `notify_gcode_response`
/// adds, or none.
pub fn notification(
    request: &wire::ConsoleNotificationRequest,
    params: &str,
) -> Option<wire::ConsoleLine> {
    if request.method != units("notify_gcode_response") {
        return None;
    }
    let params = parse_javascript(params, LIMITS).ok()?;
    let line = match &params {
        Value::Array(items) => items.first()?,
        other => other,
    };
    let Value::String(text) = line else {
        return None;
    };
    let trimmed = trim_utf16(text);
    if trimmed.is_empty() {
        return None;
    }
    // `/^(?:!!|Error)/i`
    let error = trimmed.starts_with(&units("!!"))
        || (trimmed.len() >= 5
            && trimmed[..5]
                .iter()
                .zip(units("error"))
                .all(|(&u, e)| u < 0x80 && (u as u8).to_ascii_lowercase() as u16 == e));
    Some(wire::ConsoleLine {
        kind: if error {
            wire::ConsoleLineKind::Error
        } else {
            wire::ConsoleLineKind::Received
        },
        text: redact_text(trimmed, &secrets(&request.secrets)),
    })
}

/// `recentCommands`: what was sent, newest first and without repeats.
pub fn recent(request: &wire::ConsoleRecentRequest) -> Vec<Vec<u16>> {
    let mut seen = HashSet::new();
    let mut commands = Vec::new();
    for line in request.lines.iter().rev() {
        // The limit is finite on the wire, so this is `length < limit` failing.
        if commands.len() as f64 >= request.limit {
            break;
        }
        if line.kind != wire::ConsoleLineKind::Sent || !seen.insert(line.text.clone()) {
            continue;
        }
        commands.push(line.text.clone());
    }
    commands
}
