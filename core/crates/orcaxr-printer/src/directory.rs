//! `PrinterDirectory.ts`: named printers and one default, kept on the device.
//!
//! Each entry owns its address, credential and capability record; nothing
//! carries across a switch. A machine is identified by the endpoint OrcaXR
//! would connect to ([`address`]), so two spellings of one address are one
//! printer, and an address no endpoint can be made from is refused when it is
//! saved. The directory is read from and written to its stored JSON
//! ([`load`], [`save`]) exactly as the browser stores it, and edited by pure
//! steps; the host stores the text, draws ids and keeps credentials.
use crate::reply::{LIMITS, Value, array, field, record, units};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::convert::{json_stringify, number_to_string, trim_utf16};
use std::collections::HashSet;
use wire::PrinterDirectoryErrorCode as Code;

/// Printers one device holds.
pub const MAX_PRINTERS: usize = 16;
/// A name's length in UTF-16 units.
pub const MAX_NAME_UNITS: usize = 64;
/// An address's length in UTF-16 units.
pub const MAX_HOST_UNITS: usize = 2048;
/// Moonraker's port.
pub const DEFAULT_PORT: f64 = 7125.0;
/// Capabilities kept per printer.
const MAX_CAPABILITIES: usize = 32;

fn failure(code: Code, message: &[u16]) -> wire::PrinterDirectoryFailure {
    wire::PrinterDirectoryFailure {
        code,
        message: message.to_vec(),
    }
}
type Step<T> = Result<T, wire::PrinterDirectoryFailure>;

/// `cut`: at most `length` units, never ending on half a character.
fn cut(value: &[u16], length: usize) -> Vec<u16> {
    let mut kept = &value[..value.len().min(length)];
    let high = |u: u16| (0xd800..0xdc00).contains(&u);
    let low = |u: u16| (0xdc00..0xe000).contains(&u);
    if kept.last().is_some_and(|&u| high(u)) && value.get(kept.len()).is_some_and(|&u| low(u)) {
        kept = &kept[..kept.len() - 1];
    }
    kept.to_vec()
}
/// `validPort`: a whole port number.
fn valid_port(value: f64) -> bool {
    value.fract() == 0.0 && (1.0..=65535.0).contains(&value)
}
fn known(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(v) => Some(*v),
        wire::OptionalFinite::Absent(_) => None,
    }
}

fn require_name(value: &[u16]) -> Step<Vec<u16>> {
    let name = cut(trim_utf16(value), MAX_NAME_UNITS);
    if name.is_empty() {
        return Err(failure(
            Code::InvalidName,
            &units("A printer needs a name you will recognise"),
        ));
    }
    Ok(name)
}
fn require_host(value: &[u16]) -> Step<Vec<u16>> {
    let host = cut(trim_utf16(value), MAX_HOST_UNITS);
    if host.is_empty() {
        return Err(failure(
            Code::InvalidEndpoint,
            &units("A printer needs an address"),
        ));
    }
    Ok(host)
}
fn require_port(value: f64) -> Step<f64> {
    if !valid_port(value) {
        return Err(failure(
            Code::InvalidEndpoint,
            &units("That port is not usable"),
        ));
    }
    Ok(value)
}
fn require_tool_count(value: f64) -> Step<f64> {
    // `Number.isSafeInteger` and positive.
    if value.fract() != 0.0 || value <= 0.0 || value > 9_007_199_254_740_991.0 {
        return Err(failure(
            Code::InvalidTools,
            &units("A printer has at least one tool"),
        ));
    }
    Ok(value)
}

/// `printerAddress`: the endpoint a host and port name, or why none can be
/// made from them.
pub fn address(host: &[u16], port: f64) -> Step<Vec<u16>> {
    crate::moonraker::direct_endpoint(host, port)
        .map(|url| units(&url))
        .map_err(|_| {
            failure(
                Code::InvalidEndpoint,
                &[host, &units(" is not an address OrcaXR can connect to")].concat(),
            )
        })
}
/// `sameMachine`: an entry whose address cannot be read is no machine.
fn same_machine(entry: &wire::PrinterEntry, machine: &[u16]) -> bool {
    address(&entry.host, entry.port).is_ok_and(|a| a == machine)
}

/// `readEntry`: a stored entry with an id, a name and an address, or nothing.
fn entry(value: &Value) -> Option<wire::PrinterEntry> {
    record(Some(value))?;
    let text = |name: &str| match field(value, name) {
        Some(Value::String(s)) => Some(s.as_slice()),
        _ => None,
    };
    let id = text("id").unwrap_or_default().to_vec();
    let name = text("name")
        .map(|n| cut(trim_utf16(n), MAX_NAME_UNITS))
        .unwrap_or_default();
    let host = text("host")
        .map(|h| cut(trim_utf16(h), MAX_HOST_UNITS))
        .unwrap_or_default();
    let port = match field(value, "port") {
        Some(Value::Number(p)) if valid_port(*p) => *p,
        _ => DEFAULT_PORT,
    };
    if id.is_empty() || name.is_empty() || host.is_empty() {
        return None;
    }
    let capabilities = match field(value, "capabilities") {
        Some(Value::Array(items)) => wire::OptionalTextList::Value(
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(s) => Some(s.clone()),
                    _ => None,
                })
                .take(MAX_CAPABILITIES)
                .collect(),
        ),
        _ => wire::OptionalTextList::Absent(wire::Empty {}),
    };
    let tool_count = match field(value, "toolCount") {
        Some(Value::Number(n)) if n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0 => {
            wire::OptionalFinite::Value(*n)
        }
        _ => wire::OptionalFinite::Absent(wire::Empty {}),
    };
    Some(wire::PrinterEntry {
        id,
        name,
        host,
        port,
        capabilities,
        tool_count,
    })
}

fn empty() -> wire::PrinterDirectory {
    wire::PrinterDirectory {
        printers: Vec::new(),
        default_id: Vec::new(),
    }
}

/// `loadPrinterDirectory`: the stored text read as a directory; anything
/// unreadable is an empty one, a repeated id keeps its first printer, and a
/// default naming no printer falls to the first.
pub fn load(stored: Option<&str>) -> wire::PrinterDirectory {
    let Some(value) = parse_javascript(stored.unwrap_or("null"), LIMITS)
        .ok()
        .filter(|v| record(Some(v)).is_some())
    else {
        return empty();
    };
    let Some(Value::Array(_)) = field(&value, "printers") else {
        return empty();
    };
    let mut seen = HashSet::new();
    let printers: Vec<wire::PrinterEntry> = array(field(&value, "printers"))
        .iter()
        .filter_map(entry)
        .filter(|e| seen.insert(e.id.clone()))
        .take(MAX_PRINTERS)
        .collect();
    let default_id = match field(&value, "defaultId") {
        Some(Value::String(id)) => id.clone(),
        _ => Vec::new(),
    };
    let default_id = if printers.iter().any(|e| e.id == default_id) {
        default_id
    } else {
        printers.first().map(|e| e.id.clone()).unwrap_or_default()
    };
    wire::PrinterDirectory {
        printers,
        default_id,
    }
}

/// `savePrinterDirectory`: the text the directory is stored as, each entry's
/// keys in one order.
pub fn save(directory: &wire::PrinterDirectory) -> Vec<u16> {
    let quote = |text: &[u16]| json_stringify(&Value::String(text.to_vec()));
    let mut out = units("{\"printers\":[");
    for (index, e) in directory.printers.iter().take(MAX_PRINTERS).enumerate() {
        if index > 0 {
            out.push(u16::from(b','));
        }
        out.extend(units("{\"id\":"));
        out.extend(quote(&e.id));
        out.extend(units(",\"name\":"));
        out.extend(quote(&e.name));
        out.extend(units(",\"host\":"));
        out.extend(quote(&e.host));
        out.extend(units(&format!(",\"port\":{}", number_to_string(e.port))));
        if let wire::OptionalTextList::Value(capabilities) = &e.capabilities {
            out.extend(units(",\"capabilities\":["));
            for (i, capability) in capabilities.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                out.extend(quote(capability));
            }
            out.push(u16::from(b']'));
        }
        if let Some(tools) = known(&e.tool_count) {
            out.extend(units(&format!(
                ",\"toolCount\":{}",
                number_to_string(tools)
            )));
        }
        out.push(u16::from(b'}'));
    }
    out.extend(units("],\"defaultId\":"));
    out.extend(quote(&directory.default_id));
    out.push(u16::from(b'}'));
    out
}

/// `addPrinter`: a new printer under `id`, refusing a second entry for one
/// machine; the first printer becomes the default.
pub fn add(request: &wire::PrinterDirectoryAdd) -> wire::PrinterDirectoryReply {
    reply(add_step(request))
}
fn add_step(request: &wire::PrinterDirectoryAdd) -> Step<wire::PrinterDirectory> {
    let directory = &request.directory;
    let name = require_name(&request.name)?;
    let host = require_host(&request.host)?;
    let port = known(&request.port).unwrap_or(DEFAULT_PORT);
    let port = require_port(port)?;
    let machine = address(&host, port)?;
    if directory.printers.len() >= MAX_PRINTERS {
        return Err(failure(
            Code::TooMany,
            &units(&format!(
                "This device holds at most {MAX_PRINTERS} printers"
            )),
        ));
    }
    if directory.printers.iter().any(|e| same_machine(e, &machine)) {
        return Err(failure(
            Code::Duplicate,
            &units("That address is already saved under another name"),
        ));
    }
    let mut printers = directory.printers.clone();
    printers.push(wire::PrinterEntry {
        id: request.id.clone(),
        name,
        host,
        port,
        capabilities: wire::OptionalTextList::Absent(wire::Empty {}),
        tool_count: wire::OptionalFinite::Absent(wire::Empty {}),
    });
    Ok(wire::PrinterDirectory {
        printers,
        default_id: if directory.default_id.is_empty() {
            request.id.clone()
        } else {
            directory.default_id.clone()
        },
    })
}

fn not_found() -> wire::PrinterDirectoryFailure {
    failure(
        Code::NotFound,
        &units("That printer is not in this directory"),
    )
}
fn reply(step: Step<wire::PrinterDirectory>) -> wire::PrinterDirectoryReply {
    match step {
        Ok(directory) => wire::PrinterDirectoryReply::Directory(directory),
        Err(f) => wire::PrinterDirectoryReply::Refused(f),
    }
}

/// `updatePrinter`: one printer's changes; a changed address must name a
/// machine no other entry does.
pub fn update(request: &wire::PrinterDirectoryUpdate) -> wire::PrinterDirectoryReply {
    reply(update_step(request))
}
fn update_step(request: &wire::PrinterDirectoryUpdate) -> Step<wire::PrinterDirectory> {
    let directory = &request.directory;
    let index = directory
        .printers
        .iter()
        .position(|e| e.id == request.id)
        .ok_or_else(not_found)?;
    let mut next = directory.printers[index].clone();
    if let wire::OptionalText::Value(name) = &request.name {
        next.name = require_name(name)?;
    }
    if let wire::OptionalText::Value(host) = &request.host {
        next.host = require_host(host)?;
    }
    if let Some(port) = known(&request.port) {
        next.port = require_port(port)?;
    }
    if let wire::OptionalTextList::Value(capabilities) = &request.capabilities {
        next.capabilities = wire::OptionalTextList::Value(
            capabilities
                .iter()
                .take(MAX_CAPABILITIES)
                .cloned()
                .collect(),
        );
    }
    if let Some(tools) = known(&request.tool_count) {
        next.tool_count = wire::OptionalFinite::Value(require_tool_count(tools)?);
    }
    let current = &directory.printers[index];
    if next.host != current.host || next.port != current.port {
        let machine = address(&next.host, next.port)?;
        if directory
            .printers
            .iter()
            .enumerate()
            .any(|(position, e)| position != index && same_machine(e, &machine))
        {
            return Err(failure(
                Code::Duplicate,
                &units("Another saved printer already uses that address"),
            ));
        }
    }
    let mut printers = directory.printers.clone();
    printers[index] = next;
    Ok(wire::PrinterDirectory {
        printers,
        default_id: directory.default_id.clone(),
    })
}

/// `removePrinter`: removing the default promotes the first remaining one.
pub fn remove(request: &wire::PrinterDirectorySelect) -> wire::PrinterDirectoryReply {
    let directory = &request.directory;
    let printers: Vec<wire::PrinterEntry> = directory
        .printers
        .iter()
        .filter(|e| e.id != request.id)
        .cloned()
        .collect();
    if printers.len() == directory.printers.len() {
        return wire::PrinterDirectoryReply::Refused(not_found());
    }
    let default_id = if directory.default_id == request.id {
        printers.first().map(|e| e.id.clone()).unwrap_or_default()
    } else {
        directory.default_id.clone()
    };
    wire::PrinterDirectoryReply::Directory(wire::PrinterDirectory {
        printers,
        default_id,
    })
}

/// `setDefaultPrinter`.
pub fn set_default(request: &wire::PrinterDirectorySelect) -> wire::PrinterDirectoryReply {
    let directory = &request.directory;
    if !directory.printers.iter().any(|e| e.id == request.id) {
        return wire::PrinterDirectoryReply::Refused(not_found());
    }
    wire::PrinterDirectoryReply::Directory(wire::PrinterDirectory {
        printers: directory.printers.clone(),
        default_id: request.id.clone(),
    })
}

/// `adoptLegacyEndpoint`: a single legacy endpoint becomes "My printer" in
/// an empty directory; anything unusable leaves the directory as it was.
pub fn adopt(request: &wire::PrinterDirectoryAdopt) -> wire::PrinterDirectory {
    let wire::OptionalLegacyPrinterEndpoint::Value(legacy) = &request.legacy else {
        return request.directory.clone();
    };
    if trim_utf16(&legacy.host).is_empty() || !request.directory.printers.is_empty() {
        return request.directory.clone();
    }
    add_step(&wire::PrinterDirectoryAdd {
        directory: request.directory.clone(),
        name: units("My printer"),
        host: legacy.host.clone(),
        port: wire::OptionalFinite::Value(legacy.port),
        id: request.id.clone(),
    })
    .unwrap_or_else(|_| request.directory.clone())
}
