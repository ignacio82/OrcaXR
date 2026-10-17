//! `PrintStartOptions.ts` and the pure half of `PrintJobSubmission.ts`: what
//! the printer can be asked to do around a print and how, whether it can
//! accept a job right now, the name an upload is stored under, the identity of
//! a stored file, and how a transport failure is put to an operator.
//!
//! An option is offered only when the printer's own answer supports it; a
//! printer nobody asked is unknown, never "cannot". Readiness names the exact
//! reported state, and an unreadable state is itself a blocker.
use crate::{control::moonraker_code, status::LIMITS};
use orcaxr_contracts::{
    canonical::{Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::convert::{encode_uri_component, is_space, trim_utf16};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn absent_text() -> wire::OptionalText {
    wire::OptionalText::Absent(wire::Empty {})
}
fn some_text(text: Vec<u16>) -> wire::OptionalText {
    wire::OptionalText::Value(text)
}
fn field<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(fields)) => fields.get(&units(name)),
        _ => None,
    }
}
fn parsed(text: &str) -> Option<Value> {
    parse_javascript(text, LIMITS).ok()
}

/// `(payload).result ?? payload`, for objects only.
fn result_or_payload(payload: &Value) -> Option<&Value> {
    match payload {
        Value::Object(_) => match field(Some(payload), "result") {
            Some(Value::Null) | None => Some(payload),
            Some(result) => Some(result),
        },
        _ => None,
    }
}
/// `readStringArray`: the strings of `result[key]`, when it is an array.
fn string_array(payload: &Value, key: &str) -> wire::OptionalTextList {
    let list = result_or_payload(payload)
        .filter(|r| matches!(r, Value::Object(_) | Value::Array(_)))
        .and_then(|r| field(Some(r), key))
        .and_then(|v| match v {
            Value::Array(items) => Some(
                items
                    .iter()
                    .filter_map(|i| match i {
                        Value::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        });
    match list {
        Some(list) => wire::OptionalTextList::Value(list),
        None => wire::OptionalTextList::Absent(wire::Empty {}),
    }
}

fn unknown_list() -> wire::OptionalTextList {
    wire::OptionalTextList::Absent(wire::Empty {})
}
/// `/printer/objects/list`: the configured objects, or unknown.
pub fn printer_objects(text: &str) -> wire::OptionalTextList {
    parsed(text).map_or_else(unknown_list, |payload| printer_objects_of(&payload))
}
pub(crate) fn printer_objects_of(payload: &Value) -> wire::OptionalTextList {
    string_array(payload, "objects")
}
/// `/server/info`: the installed components, or unknown.
pub fn server_components(text: &str) -> wire::OptionalTextList {
    parsed(text).map_or_else(unknown_list, |payload| server_components_of(&payload))
}
pub(crate) fn server_components_of(payload: &Value) -> wire::OptionalTextList {
    string_array(payload, "components")
}
/// `/printer/gcode/help`: an object of `{ COMMAND: description }`; its names,
/// in UTF-16 order (they are only ever tested for membership).
pub fn gcode_commands(text: &str) -> wire::OptionalTextList {
    parsed(text).map_or_else(unknown_list, |payload| gcode_commands_of(&payload))
}
pub(crate) fn gcode_commands_of(payload: &Value) -> wire::OptionalTextList {
    match result_or_payload(payload) {
        Some(Value::Object(fields)) => {
            wire::OptionalTextList::Value(fields.keys().cloned().collect())
        }
        _ => unknown_list(),
    }
}

/// `normalize`: each name's first whitespace-separated word, lowercased.
fn section_names(list: &wire::OptionalTextList) -> Option<Vec<Vec<u16>>> {
    match list {
        wire::OptionalTextList::Value(names) => Some(
            names
                .iter()
                .map(|name| {
                    let end = name
                        .iter()
                        .position(|&u| char::from_u32(u32::from(u)).is_some_and(is_space))
                        .unwrap_or(name.len());
                    // `toLowerCase` with the pinned Unicode data every port shares.
                    orcaxr_project::js_math::case::lower(&name[..end])
                })
                .collect(),
        ),
        wire::OptionalTextList::Absent(_) => None,
    }
}
const LEVELING_COMMANDS: [&str; 2] = ["BED_MESH_CALIBRATE", "G29"];
/// A mesh probe legitimately takes minutes; it must not be cut off as a hang.
const LEVELING_TIMEOUT_MS: f64 = 15.0 * 60.0 * 1000.0;

/// `assessPrintStartOptions`: levelling when the printer names a mesh section
/// or a levelling command, a timelapse when Moonraker has the component; a
/// question nobody asked stays unknown.
pub fn start_options(report: &wire::PrinterCapabilityReport) -> Vec<wire::PrintStartOption> {
    let objects = section_names(&report.objects);
    let commands = section_names(&report.commands);
    let components = section_names(&report.components);
    let has = |set: &Option<Vec<Vec<u16>>>, name: &str| {
        set.as_ref().is_some_and(|s| s.contains(&units(name)))
    };
    let command = commands.as_ref().and_then(|_| {
        LEVELING_COMMANDS
            .into_iter()
            .find(|c| has(&commands, &c.to_lowercase()))
    });
    let has_mesh = has(&objects, "bed_mesh");
    let leveling_known = objects.is_some() || commands.is_some();
    let leveling_available = command.is_some() || has_mesh;
    let leveling_command = command.or(has_mesh.then_some(LEVELING_COMMANDS[0]));
    let timelapse_known = components.is_some();
    let timelapse_available = has(&components, "timelapse");
    vec![
        wire::PrintStartOption {
            id: wire::PrintStartOptionId::BedLeveling,
            label: units("Calibrate the build plate first"),
            detail: units(&match leveling_command {
                Some(c) => {
                    format!("Homes the printer and runs {c} before the print starts.")
                }
                None => "Homes the printer and probes the plate before the print starts.".into(),
            }),
            available: leveling_available,
            reason: units(&if !leveling_known {
                "Connect the printer to find out whether it can probe its plate.".into()
            } else if leveling_available {
                if has_mesh {
                    "The printer reports a bed_mesh section.".into()
                } else {
                    format!(
                        "The printer reports the {} command.",
                        leveling_command.unwrap_or_default()
                    )
                }
            } else {
                "This printer reports no bed_mesh section and no levelling command, so it cannot probe its plate.".to_string()
            }),
            default_enabled: false,
            command: match leveling_command {
                Some(c) => some_text(units(c)),
                None => absent_text(),
            },
        },
        wire::PrintStartOption {
            id: wire::PrintStartOptionId::Timelapse,
            label: units("Record a timelapse"),
            detail: units(
                "Asks Moonraker to record a frame per layer and assemble a video when the print finishes.",
            ),
            available: timelapse_available,
            reason: units(if !timelapse_known {
                "Connect the printer to find out whether it can record a timelapse."
            } else if timelapse_available {
                "Moonraker reports the timelapse component."
            } else {
                "This Moonraker has no timelapse component installed, so it cannot record one."
            }),
            default_enabled: false,
            command: absent_text(),
        },
    ]
}

fn option_name(id: wire::PrintStartOptionId) -> &'static str {
    match id {
        wire::PrintStartOptionId::BedLeveling => "bed-leveling",
        wire::PrintStartOptionId::Timelapse => "timelapse",
    }
}
/// `planPrintPreparation`: the chosen options in machine order (timelapse is
/// a setting, levelling moves the head and runs last), each checked against
/// what the printer offered.
pub fn preparation_plan(request: &wire::PrintPreparationPlanRequest) -> wire::PrintPreparationPlan {
    let refused = |id, message: Vec<u16>| {
        wire::PrintPreparationPlan::Refused(wire::PrintStartOptionRefusal {
            option_id: id,
            message,
        })
    };
    // `new Map(...)`: the last option offered under an id wins.
    let offered = |id| request.options.iter().rev().find(|o| o.id == id);
    let mut chosen: Vec<wire::PrintStartOptionId> = Vec::new();
    for &id in &request.enabled {
        if !chosen.contains(&id) {
            chosen.push(id);
        }
    }
    for &id in &chosen {
        match offered(id) {
            Some(option) if option.available => {}
            Some(option) => return refused(id, option.reason.clone()),
            None => {
                return refused(
                    id,
                    units(&format!(
                        "No print option named {} was offered.",
                        option_name(id)
                    )),
                );
            }
        }
    }
    let mut steps = Vec::new();
    if chosen.contains(&wire::PrintStartOptionId::Timelapse) {
        steps.push(wire::PrintPreparationStep {
            id: wire::PrintStartOptionId::Timelapse,
            label: units("timelapse setup"),
            kind: wire::PrintPreparationStepKind::Timelapse,
            command: absent_text(),
        });
    }
    if chosen.contains(&wire::PrintStartOptionId::BedLeveling) {
        let command =
            offered(wire::PrintStartOptionId::BedLeveling).and_then(|o| match &o.command {
                wire::OptionalText::Value(c) => Some(c.clone()),
                wire::OptionalText::Absent(_) => None,
            });
        let Some(command) =
            command.filter(|c| LEVELING_COMMANDS.iter().any(|known| *c == units(known)))
        else {
            return refused(
                wire::PrintStartOptionId::BedLeveling,
                units("The printer never named a supported levelling command."),
            );
        };
        steps.push(wire::PrintPreparationStep {
            id: wire::PrintStartOptionId::BedLeveling,
            label: units("bed levelling"),
            kind: wire::PrintPreparationStepKind::Leveling,
            command: some_text(command),
        });
    }
    wire::PrintPreparationPlan::Steps(steps)
}

/// What `executePrintPreparationStep` posts for one step.
pub fn preparation_send(step: &wire::PrintPreparationStep) -> wire::PrinterSend {
    match step.kind {
        wire::PrintPreparationStepKind::Timelapse => wire::PrinterSend {
            path: units("/machine/timelapse/settings?enabled=true"),
            method: units("POST"),
            operation: units("timelapse_enable"),
            timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
        },
        wire::PrintPreparationStepKind::Leveling => {
            let command = match &step.command {
                wire::OptionalText::Value(c) => c.clone(),
                wire::OptionalText::Absent(_) => units("undefined"),
            };
            let script = if command.starts_with(&units("G28")) {
                command
            } else {
                let mut s = units("G28\n");
                s.extend(command);
                s
            };
            let encoded = encode_uri_component(&script).unwrap_or_default();
            wire::PrinterSend {
                path: units(&format!("/printer/gcode/script?script={encoded}")),
                method: units("POST"),
                operation: units("bed_leveling"),
                timeout_ms: wire::OptionalFinite::Value(LEVELING_TIMEOUT_MS),
            }
        }
    }
}

fn readiness_failure(cause: &str) -> wire::PrintReadiness {
    wire::PrintReadiness {
        known: false,
        ready: false,
        blockers: vec![wire::PrintReadinessBlocker {
            code: wire::PrintReadinessBlockerCode::StateUnavailable,
            message: units(&format!("The printer did not report its state ({cause}).")),
        }],
        klippy_state: absent_text(),
        print_state: absent_text(),
        current_filename: absent_text(),
        virtual_sd_active: wire::OptionalFlag::Absent(wire::Empty {}),
    }
}
/// `queryPrintReadiness` when the query itself failed.
pub fn readiness_unavailable(request: &wire::PrintReadinessFailure) -> wire::PrintReadiness {
    readiness_failure(match request.transport_code {
        wire::OptionalMoonrakerErrorCode::Value(code) => moonraker_code(code),
        wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
    })
}
/// `queryPrintReadiness` over the query's reply: every blocker names the exact
/// reported state; an unrecognized one is itself a blocker.
pub fn readiness(text: &str) -> wire::PrintReadiness {
    match parsed(text) {
        Some(payload) => readiness_of(&payload),
        // The transport refuses a reply that is not JSON.
        None => readiness_failure("invalid_response"),
    }
}
pub(crate) fn readiness_of(payload: &Value) -> wire::PrintReadiness {
    fn record(v: Option<&Value>) -> Option<&Value> {
        v.filter(|v| matches!(v, Value::Object(_)))
    }
    let status = record(field(Some(payload), "status"));
    let webhooks = record(field(status, "webhooks"));
    let stats = record(field(status, "print_stats"));
    let text_of = |v: Option<&Value>| match v {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let klippy = text_of(field(webhooks, "state"));
    let print = text_of(field(stats, "state"));
    let filename = text_of(field(stats, "filename"));
    let virtual_sd = match field(record(field(status, "virtual_sdcard")), "is_active") {
        Some(Value::Bool(active)) => Some(*active),
        _ => None,
    };
    let one_of = |value: &Option<Vec<u16>>, set: &[&str]| {
        value
            .as_ref()
            .is_some_and(|v| set.iter().any(|s| *v == units(s)))
    };
    let recognized_klippy = one_of(&klippy, &["ready", "startup", "shutdown", "error"]);
    let recognized_print = one_of(
        &print,
        &[
            "standby",
            "printing",
            "paused",
            "complete",
            "cancelled",
            "error",
        ],
    );
    let known = recognized_klippy && recognized_print && virtual_sd.is_some();
    let mut blockers = Vec::new();
    let blocker = |code, message: Vec<u16>| wire::PrintReadinessBlocker { code, message };
    if !recognized_klippy {
        blockers.push(blocker(
            wire::PrintReadinessBlockerCode::StateUnavailable,
            units("The printer did not report a recognized Klipper state."),
        ));
    } else if klippy.as_deref() != Some(&units("ready")[..]) {
        blockers.push(blocker(
            wire::PrintReadinessBlockerCode::KlippyNotReady,
            [
                units("Klipper reports \""),
                klippy.clone().unwrap_or_default(),
                units("\"; it must be ready before a job is sent."),
            ]
            .concat(),
        ));
    }
    match (recognized_print, virtual_sd) {
        (true, Some(active)) if !one_of(&print, &["standby", "complete", "cancelled"]) || active => {
            blockers.push(blocker(
                wire::PrintReadinessBlockerCode::PrinterBusy,
                [
                    units("The printer reports "),
                    print.clone().unwrap_or_default(),
                    match filename.as_ref().filter(|f| !f.is_empty()) {
                        Some(f) => [units(" \""), f.clone(), units("\"")].concat(),
                        None => Vec::new(),
                    },
                    if active { units(" with an active virtual SD card") } else { Vec::new() },
                    units("."),
                ]
                .concat(),
            ));
        }
        (true, Some(_)) => {}
        _ => blockers.push(blocker(
            wire::PrintReadinessBlockerCode::StateUnavailable,
            units("The printer must report a recognized print state and whether its virtual SD card is active."),
        )),
    }
    let present = |v: Option<Vec<u16>>| match v.filter(|v| !v.is_empty()) {
        Some(v) => some_text(v),
        None => absent_text(),
    };
    wire::PrintReadiness {
        known,
        ready: blockers.is_empty(),
        blockers,
        klippy_state: present(klippy),
        print_state: present(print),
        current_filename: present(filename),
        virtual_sd_active: match virtual_sd {
            Some(active) => wire::OptionalFlag::Value(active),
            None => wire::OptionalFlag::Absent(wire::Empty {}),
        },
    }
}

fn safe_name(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x2e | 0x5f | 0x2d)
}
/// `sanitizeGcodeFilename`: the last path segment, its extension replaced by
/// `.gcode`, runs of characters Klipper refuses as `_`, no leading `_` or `.`,
/// at most 110 units before the extension.
pub fn sanitize_filename(filename: &[u16]) -> Vec<u16> {
    let segment = filename
        .rsplit(|&u| u == u16::from(b'/') || u == u16::from(b'\\'))
        .next()
        .unwrap_or(filename);
    let base = trim_utf16(segment);
    let suffix = units(".gcode");
    let gcode = base.len() >= suffix.len()
        && base[base.len() - suffix.len()..]
            .iter()
            .zip(&suffix)
            .all(|(&a, &b)| a < 0x80 && (a as u8).to_ascii_lowercase() == b as u8);
    let stem = if gcode {
        &base[..base.len() - suffix.len()]
    } else {
        match base.iter().rposition(|&u| u == u16::from(b'.')) {
            Some(dot) => &base[..dot],
            None => base,
        }
    };
    let mut safe: Vec<u16> = Vec::with_capacity(stem.len());
    let mut in_run = false;
    for &unit in stem {
        if safe_name(unit) {
            safe.push(unit);
            in_run = false;
        } else if !in_run {
            // One `_` per run of refused characters.
            safe.push(u16::from(b'_'));
            in_run = true;
        }
    }
    let start = safe
        .iter()
        .position(|&u| u != u16::from(b'_') && u != u16::from(b'.'))
        .unwrap_or(safe.len());
    let safe = &safe[start..(start + 110).min(safe.len())];
    if safe.is_empty() {
        units("orcaxr_print.gcode")
    } else {
        [safe, &suffix[..]].concat()
    }
}

/// `summarizeServerDetail`: a server's error text as one short printable line.
fn server_detail(text: &[u16]) -> Option<Vec<u16>> {
    let mut collapsed: Vec<u16> = Vec::with_capacity(text.len());
    for decoded in char::decode_utf16(text.iter().copied()) {
        let (code, encoded): (u32, Vec<u16>) = match decoded {
            Ok(c) => (c as u32, c.encode_utf16(&mut [0; 2]).to_vec()),
            Err(lone) => (
                u32::from(lone.unpaired_surrogate()),
                vec![lone.unpaired_surrogate()],
            ),
        };
        if code >= 0x20 && code != 0x7f {
            collapsed.extend(encoded);
        } else if collapsed.last() != Some(&0x20) {
            collapsed.push(0x20);
        }
    }
    let mut spaced: Vec<u16> = Vec::with_capacity(collapsed.len());
    for unit in collapsed {
        let space = char::from_u32(u32::from(unit)).is_some_and(is_space);
        if space {
            if spaced.last() != Some(&0x20) {
                spaced.push(0x20);
            }
        } else {
            spaced.push(unit);
        }
    }
    let trimmed = trim_utf16(&spaced).to_vec();
    if trimmed.is_empty() {
        None
    } else if trimmed.len() > 200 {
        Some([&trimmed[..197], &units("...")[..]].concat())
    } else {
        Some(trimmed)
    }
}
/// `describeTransportFailure`: the server's own words first, the status beside
/// them; anything that is not a transport error is "request failed".
pub fn describe_failure(request: &wire::TransportFailure) -> Vec<u16> {
    let wire::OptionalMoonrakerErrorCode::Value(code) = request.code else {
        return units("request failed");
    };
    let code = units(moonraker_code(code));
    let status = match request.http_status {
        wire::OptionalFinite::Value(s) if s.trunc() == s && (100.0..=599.0).contains(&s) => {
            units(&format!("HTTP {s}"))
        }
        _ => Vec::new(),
    };
    let detail = match &request.detail {
        wire::OptionalText::Value(d) => server_detail(d),
        wire::OptionalText::Absent(_) => None,
    };
    match (detail, status.is_empty()) {
        (None, true) => code,
        (None, false) => [code, units(", "), status].concat(),
        (Some(detail), true) => [code, units(": "), detail].concat(),
        (Some(detail), false) => [status, units(": "), detail].concat(),
    }
}

/// `readPrintFileIdentity` over a metadata reply for `filename`.
pub fn file_identity(text: &str, filename: &[u16]) -> wire::PrintFileIdentityReply {
    match parsed(text) {
        Some(value) => file_identity_of(&value, filename),
        None => file_identity_of(&Value::Null, filename),
    }
}
pub(crate) fn file_identity_of(value: &Value, filename: &[u16]) -> wire::PrintFileIdentityReply {
    let unreliable = || {
        wire::PrintFileIdentityReply::Unreliable(wire::PrinterText {
            text: [
                units("The printer did not report reliable metadata for "),
                filename.to_vec(),
                units("."),
            ]
            .concat(),
        })
    };
    let named = matches!(field(Some(value), "filename"), Some(Value::String(f)) if f == filename);
    let number = |name| match field(Some(value), name) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    };
    match (named, number("size"), number("modified")) {
        (true, Some(size), Some(modified))
            if size.trunc() == size
                && size.abs() <= 9_007_199_254_740_991.0
                && size >= 0.0
                && modified.is_finite()
                && modified >= 0.0 =>
        {
            wire::PrintFileIdentityReply::Identity(wire::PrintFileIdentity {
                filename: filename.to_vec(),
                size,
                modified,
            })
        }
        _ => unreliable(),
    }
}
