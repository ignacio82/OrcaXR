//! `PrinterStorage.ts`: what is already on the printer and what may be done
//! with it — browse a folder, read a file's metadata, download, delete,
//! move or rename, and start a stored file.
//!
//! Every destructive operation names its exact target: a path the listing
//! reported, checked before anything is sent (no traversal, no empty name, no
//! text a URL cannot spell). A missing fact stays missing: a file the printer
//! never scanned has no time and no thumbnail, never a zero.
//!
//! An operation is planned ([`plan`]: the request or download to send, or why
//! it is refused), its transport outcome finished ([`finish`]), and a listing
//! or metadata reply read ([`read`]) — the host carries the exchange out.
use orcaxr_contracts::{
    canonical::{JsonLimits, Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::{
    convert::{encode_uri_component, number_to_string, to_fixed, trim_utf16},
    round,
};
use std::cmp::Ordering;
use wire::PrinterStorageErrorCode as Code;

/// The Moonraker file root this module browses.
pub const GCODE_ROOT: &str = "gcodes";
/// The longest path a printer can hold, in UTF-16 units: Linux paths are at
/// most 4,096 bytes and no unit takes less than one, so nothing a printer
/// stores is longer. It bounds every request and sentence a path is written
/// into.
pub const MAX_PATH_UNITS: usize = 4096;
/// A reply is read whole whenever the transport admits it (2 Mi UTF-16
/// units): a long listing is a long listing, not an unreadable one.
pub const LIMITS: JsonLimits = JsonLimits {
    bytes: 8 * 1024 * 1024,
    nodes: 4_000_000,
    depth: 512,
};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn failure(code: Code, message: &[u16]) -> wire::PrinterStorageFailure {
    wire::PrinterStorageFailure {
        code,
        message: message.to_vec(),
    }
}
fn joined(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn is_surrogate(unit: u16) -> bool {
    (0xd800..=0xdfff).contains(&unit)
}
/// `/\p{Surrogate}/u`: a surrogate that is not half of a pair.
fn has_lone_surrogate(units: &[u16]) -> bool {
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if (0xd800..0xdc00).contains(&unit)
            && units
                .get(i + 1)
                .is_some_and(|n| (0xdc00..0xe000).contains(n))
        {
            i += 2;
        } else if is_surrogate(unit) {
            return true;
        } else {
            i += 1;
        }
    }
    false
}

/// `assertStoragePath`: a root-relative path that names something inside
/// the root and that a URL can spell.
pub fn assert_path(path: &[u16], what: &str) -> Result<Vec<u16>, wire::PrinterStorageFailure> {
    let mut trimmed = trim_utf16(path);
    let slash = u16::from(b'/');
    while trimmed.first() == Some(&slash) {
        trimmed = &trimmed[1..];
    }
    while trimmed.last() == Some(&slash) {
        trimmed = &trimmed[..trimmed.len() - 1];
    }
    let refuse = |sentence: String| Err(failure(Code::InvalidTarget, &units(&sentence)));
    if trimmed.is_empty() {
        return refuse(format!("{what} is empty."));
    }
    if trimmed.len() > MAX_PATH_UNITS {
        return refuse(format!(
            "{what} is longer than any path the printer can store."
        ));
    }
    if trimmed
        .split(|unit| *unit == slash)
        .any(|segment| segment == units(".") || segment == units(".."))
    {
        return refuse(format!(
            "{what} may not step outside the printer's {GCODE_ROOT} folder."
        ));
    }
    if has_lone_surrogate(trimmed) {
        return refuse(format!("{what} has a name that is not valid text."));
    }
    Ok(trimmed.to_vec())
}

/// `assertStorageName`: a new name for one file — a bare segment, never a path.
pub fn assert_name(name: &[u16]) -> Result<Vec<u16>, wire::PrinterStorageFailure> {
    let trimmed = trim_utf16(name);
    let refuse = |sentence: &str| Err(failure(Code::InvalidTarget, &units(sentence)));
    if trimmed.is_empty() {
        return refuse("The new name is empty.");
    }
    if trimmed
        .iter()
        .any(|unit| *unit == u16::from(b'/') || *unit == u16::from(b'\\'))
    {
        return refuse("A name may not contain a folder separator; move the file instead.");
    }
    if trimmed == units(".") || trimmed == units("..") {
        return refuse("That name is reserved.");
    }
    Ok(trimmed.to_vec())
}

/// `storageDirectoryOf`: the directory part of a root-relative file path.
pub fn directory_of(path: &[u16]) -> &[u16] {
    match path.iter().rposition(|unit| *unit == u16::from(b'/')) {
        Some(slash) => &path[..slash],
        None => &[],
    }
}
/// `joinStoragePath`.
pub fn join(directory: &[u16], name: &[u16]) -> Vec<u16> {
    if directory.is_empty() {
        name.to_vec()
    } else {
        joined(&[directory, &units("/"), name])
    }
}
/// A listed entry's path: its listing's joined with its name.
pub fn entry_path(
    listing: &wire::PrinterStorageListing,
    entry: &wire::PrinterStorageEntry,
) -> Vec<u16> {
    join(&listing.path, &entry.name)
}
/// A thumbnail's path: its file's folder joined with the path the printer
/// reported relative to it.
pub fn thumbnail_path(
    metadata: &wire::PrinterStorageMetadata,
    thumbnail: &wire::PrinterStorageThumbnail,
) -> Vec<u16> {
    join(directory_of(&metadata.path), &thumbnail.relative_path)
}
/// `renamedStoragePath`: the path a rename lands on, in the file's own folder.
pub fn renamed(path: &[u16], name: &[u16]) -> Result<Vec<u16>, wire::PrinterStorageFailure> {
    let relative = assert_path(path, "That file")?;
    Ok(join(directory_of(&relative), &assert_name(name)?))
}

/// `encodeURIComponent`, of text already refused when it holds a lone surrogate.
fn encoded(units_: &[u16]) -> String {
    encode_uri_component(units_).unwrap_or_default()
}
fn encode_segments(path: &[u16]) -> String {
    path.split(|unit| *unit == u16::from(b'/'))
        .map(encoded)
        .collect::<Vec<_>>()
        .join("/")
}
fn send(path: String, method: &str, operation: &str) -> wire::PrinterStoragePlan {
    wire::PrinterStoragePlan::Request(wire::PrinterSend {
        path: units(&path),
        method: units(method),
        operation: units(operation),
        timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
    })
}

/// The folder a listing names, as `listPrinterDirectory` reads it.
fn folder(path: &[u16]) -> Result<Vec<u16>, wire::PrinterStorageFailure> {
    if path.is_empty() {
        Ok(Vec::new())
    } else {
        assert_path(path, "That folder")
    }
}
/// A move's source and destination, both checked.
type Targets = Result<(Vec<u16>, Vec<u16>), wire::PrinterStorageFailure>;

fn move_targets(source: &[u16], destination: &[u16]) -> Targets {
    let from = assert_path(source, "The file being moved")?;
    let to = assert_path(destination, "The destination")?;
    if from == to {
        return Err(failure(
            Code::InvalidTarget,
            &units("The destination is the file itself."),
        ));
    }
    Ok((from, to))
}
fn move_operation(op: &wire::PrinterStorageOperation) -> Option<Targets> {
    match op {
        wire::PrinterStorageOperation::Move(m) => Some(move_targets(&m.source, &m.destination)),
        wire::PrinterStorageOperation::Rename(r) => {
            Some(renamed(&r.path, &r.name).and_then(|to| move_targets(&r.path, &to)))
        }
        _ => None,
    }
}

/// What an operation sends: a request, a download, or why it is refused
/// before anything leaves.
pub fn plan(op: &wire::PrinterStorageOperation) -> wire::PrinterStoragePlan {
    use wire::PrinterStorageOperation as Op;
    let refused = wire::PrinterStoragePlan::Refused;
    let gcodes = units(GCODE_ROOT);
    match op {
        Op::List(path) => match folder(&path.text) {
            Ok(relative) => {
                let target = if relative.is_empty() {
                    gcodes
                } else {
                    joined(&[&gcodes, &units("/"), &relative])
                };
                send(
                    format!(
                        "/server/files/directory?path={}&extended=true",
                        encoded(&target)
                    ),
                    "GET",
                    "list_directory",
                )
            }
            Err(f) => refused(f),
        },
        Op::Metadata(path) => match assert_path(&path.text, "That file") {
            Ok(relative) => send(
                format!("/server/files/metadata?filename={}", encoded(&relative)),
                "GET",
                "file_metadata",
            ),
            Err(f) => refused(f),
        },
        Op::Download(path) => match assert_path(&path.text, "That file") {
            Ok(relative) => wire::PrinterStoragePlan::Download(wire::PrinterStorageDownload {
                path: units(&format!(
                    "/server/files/{GCODE_ROOT}/{}",
                    encode_segments(&relative)
                )),
                operation: units("download_file"),
            }),
            Err(f) => refused(f),
        },
        Op::Delete(path) => match assert_path(&path.text, "That file") {
            Ok(relative) => send(
                format!("/server/files/{GCODE_ROOT}/{}", encode_segments(&relative)),
                "DELETE",
                "delete_file",
            ),
            Err(f) => refused(f),
        },
        Op::Move(_) | Op::Rename(_) => match move_operation(op).unwrap() {
            Ok((from, to)) => send(
                format!(
                    "/server/files/move?source={}&dest={}",
                    encoded(&joined(&[&gcodes, &units("/"), &from])),
                    encoded(&joined(&[&gcodes, &units("/"), &to])),
                ),
                "POST",
                "move_file",
            ),
            Err(f) => refused(f),
        },
        Op::Start(path) => match assert_path(&path.text, "That file") {
            Ok(relative) => send(
                format!("/printer/print/start?filename={}", encoded(&relative)),
                "POST",
                "start_stored_print",
            ),
            Err(f) => refused(f),
        },
    }
}

/// The sentence a failed operation begins with, and its code.
fn prefix(
    op: &wire::PrinterStorageOperation,
) -> Result<(Vec<u16>, Code), wire::PrinterStorageFailure> {
    use wire::PrinterStorageOperation as Op;
    Ok(match op {
        Op::List(path) => {
            let relative = folder(&path.text)?;
            let named = if relative.is_empty() {
                units(GCODE_ROOT)
            } else {
                relative
            };
            (
                joined(&[&units("The printer could not list "), &named]),
                Code::ListingFailed,
            )
        }
        Op::Metadata(path) => (
            joined(&[
                &units("The printer has no metadata for "),
                &assert_path(&path.text, "That file")?,
            ]),
            Code::MetadataUnavailable,
        ),
        Op::Download(path) => (
            joined(&[
                &units("Downloading "),
                &assert_path(&path.text, "That file")?,
                &units(" failed"),
            ]),
            Code::DownloadFailed,
        ),
        Op::Delete(path) => (
            joined(&[
                &units("Deleting "),
                &assert_path(&path.text, "That file")?,
                &units(" failed"),
            ]),
            Code::DeleteFailed,
        ),
        Op::Move(_) | Op::Rename(_) => {
            let (from, to) = move_operation(op).unwrap()?;
            (
                joined(&[
                    &units("Moving "),
                    &from,
                    &units(" to "),
                    &to,
                    &units(" failed"),
                ]),
                Code::MoveFailed,
            )
        }
        Op::Start(path) => (
            joined(&[
                &units("Starting "),
                &assert_path(&path.text, "That file")?,
                &units(" failed"),
            ]),
            Code::StartFailed,
        ),
    })
}

/// An operation's result once its exchange ended: done (a delete, the path a
/// move landed on, the file a start started), or the failure it reads as. A
/// listing or metadata reply is read with [`read`] instead.
pub fn finish(request: &wire::PrinterStorageFinish) -> wire::PrinterStorageResult {
    use wire::PrinterExchangeOutcome as Outcome;
    use wire::PrinterStorageOperation as Op;
    let failed = wire::PrinterStorageResult::Failed;
    let (lead, code) = match prefix(&request.operation) {
        Ok(prefix) => prefix,
        Err(f) => return failed(f),
    };
    match &request.outcome {
        Outcome::Done(_) => match &request.operation {
            Op::Move(_) | Op::Rename(_) => match move_operation(&request.operation).unwrap() {
                Ok((_, to)) => wire::PrinterStorageResult::Moved(wire::PrinterText { text: to }),
                Err(f) => failed(f),
            },
            Op::Start(path) => match assert_path(&path.text, "That file") {
                Ok(relative) => {
                    wire::PrinterStorageResult::Started(wire::PrinterText { text: relative })
                }
                Err(f) => failed(f),
            },
            _ => wire::PrinterStorageResult::Done(wire::Empty {}),
        },
        // `storageFailure`: a cancel (the caller's, or the transport's) reads as one.
        Outcome::Cancelled(_)
        | Outcome::Failed(wire::TransportFailure {
            code: wire::OptionalMoonrakerErrorCode::Value(wire::MoonrakerErrorCode::Cancelled),
            ..
        }) => failed(failure(
            Code::Cancelled,
            &joined(&[&lead, &units(": cancelled.")]),
        )),
        Outcome::Failed(transport) => {
            let detail = match &transport.code {
                wire::OptionalMoonrakerErrorCode::Value(code) => {
                    crate::control::moonraker_code(*code)
                }
                wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
            };
            failed(failure(
                code,
                &joined(&[&lead, &units(&format!(" ({detail})."))]),
            ))
        }
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&units(name)),
        _ => None,
    }
}
fn record(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| matches!(v, Value::Object(_)))
}
fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}
/// `readString`: text that is not blank, trimmed.
fn read_string(value: Option<&Value>) -> Option<Vec<u16>> {
    match value {
        Some(Value::String(s)) => {
            let trimmed = trim_utf16(s);
            (!trimmed.is_empty()).then(|| trimmed.to_vec())
        }
        _ => None,
    }
}
/// `readNumber`: a finite number.
fn read_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}
/// `readTimestampMs`: seconds since the epoch, in milliseconds while finite.
fn read_timestamp_ms(value: Option<&Value>) -> Option<f64> {
    read_number(value)
        .map(|seconds| round(seconds * 1000.0))
        .filter(|ms| ms.is_finite())
}
fn optional(value: Option<f64>) -> wire::OptionalFinite {
    match value {
        Some(v) => wire::OptionalFinite::Value(v),
        None => wire::OptionalFinite::Absent(wire::Empty {}),
    }
}
fn optional_text(value: Option<Vec<u16>>) -> wire::OptionalText {
    match value {
        Some(v) => wire::OptionalText::Value(v),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn known(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(v) => Some(*v),
        wire::OptionalFinite::Absent(_) => None,
    }
}
/// `byNameAscending`: by UTF-16 code units.
fn by_name(left: &wire::PrinterStorageEntry, right: &wire::PrinterStorageEntry) -> Ordering {
    left.name.cmp(&right.name)
}
/// `byNewestFirst`: newer first (an unknown time as 0), then by name. A
/// comparison JavaScript cannot order (`NaN`) leaves the pair as it was.
fn by_newest(left: &wire::PrinterStorageEntry, right: &wire::PrinterStorageEntry) -> Ordering {
    let difference =
        known(&right.modified_ms).unwrap_or(0.0) - known(&left.modified_ms).unwrap_or(0.0);
    if difference.is_nan() {
        Ordering::Equal
    } else if difference != 0.0 {
        difference.partial_cmp(&0.0).unwrap()
    } else {
        by_name(left, right)
    }
}

/// A listing or metadata reply (Moonraker's `result`, as JSON) read as the
/// browser reads it; any other operation's reply carries nothing to read.
pub fn read(op: &wire::PrinterStorageOperation, reply: &str) -> wire::PrinterStorageResult {
    use wire::PrinterStorageOperation as Op;
    let failed = wire::PrinterStorageResult::Failed;
    let payload = parse_javascript(reply, LIMITS).ok();
    match op {
        Op::List(path) => match folder(&path.text) {
            Ok(relative) => match record(payload.as_ref()) {
                Some(payload) => wire::PrinterStorageResult::Listing(listing(&relative, payload)),
                None => {
                    let named = if relative.is_empty() {
                        units(GCODE_ROOT)
                    } else {
                        relative
                    };
                    failed(failure(
                        Code::ListingFailed,
                        &joined(&[
                            &units("The printer's listing of "),
                            &named,
                            &units(" was not readable."),
                        ]),
                    ))
                }
            },
            Err(f) => failed(f),
        },
        Op::Metadata(path) => match assert_path(&path.text, "That file") {
            Ok(relative) => match record(payload.as_ref()) {
                Some(payload) => wire::PrinterStorageResult::Metadata(metadata(&relative, payload)),
                None => failed(failure(
                    Code::MetadataUnavailable,
                    &joined(&[
                        &units("The printer's metadata for "),
                        &relative,
                        &units(" was not readable."),
                    ]),
                )),
            },
            Err(f) => failed(f),
        },
        _ => finish(&wire::PrinterStorageFinish {
            operation: op.clone(),
            outcome: wire::PrinterExchangeOutcome::Done(wire::Empty {}),
        }),
    }
}

fn listing(relative: &[u16], payload: &Value) -> wire::PrinterStorageListing {
    // An entry's path is the listing's joined with its name ([`join`]), so a
    // listing crosses a binding in a size linear in its reply.
    let entry = |name: Vec<u16>, item: &Value| wire::PrinterStorageEntry {
        name,
        modified_ms: optional(read_timestamp_ms(field(item, "modified"))),
        size_bytes: optional(read_number(field(item, "size"))),
    };
    let mut directories = Vec::new();
    for item in array(field(payload, "dirs")) {
        if !matches!(item, Value::Object(_)) {
            continue;
        }
        let Some(name) =
            read_string(field(item, "dirname")).or_else(|| read_string(field(item, "name")))
        else {
            continue;
        };
        if name == units(".") || name == units("..") {
            continue;
        }
        directories.push(entry(name, item));
    }
    let mut files = Vec::new();
    for item in array(field(payload, "files")) {
        if !matches!(item, Value::Object(_)) {
            continue;
        }
        let Some(name) =
            read_string(field(item, "filename")).or_else(|| read_string(field(item, "path")))
        else {
            continue;
        };
        files.push(entry(name, item));
    }
    // Folders first, then files, each newest first: the file someone just
    // sliced is the one they are looking for.
    directories.sort_by(by_name);
    files.sort_by(by_newest);
    let usage = record(field(payload, "disk_usage"));
    wire::PrinterStorageListing {
        path: relative.to_vec(),
        directories,
        files,
        free_bytes: optional(usage.and_then(|u| read_number(field(u, "free")))),
        total_bytes: optional(usage.and_then(|u| read_number(field(u, "total")))),
    }
}

fn metadata(relative: &[u16], payload: &Value) -> wire::PrinterStorageMetadata {
    let mut thumbnails = Vec::new();
    for item in array(field(payload, "thumbnails")) {
        if !matches!(item, Value::Object(_)) {
            continue;
        }
        let width = read_number(field(item, "width"));
        let height = read_number(field(item, "height"));
        let path = read_string(field(item, "relative_path"));
        let (Some(width), Some(height), Some(path)) = (width, height, path) else {
            continue;
        };
        // `relative_path.replace(/^\.?\//, '')`: one leading `./` or `/`.
        let stripped: &[u16] = if path.starts_with(&units("./")) {
            &path[2..]
        } else if path.starts_with(&units("/")) {
            &path[1..]
        } else {
            &path
        };
        // Its path is the file's folder joined with this ([`thumbnail_path`]).
        thumbnails.push(wire::PrinterStorageThumbnail {
            width,
            height,
            relative_path: stripped.to_vec(),
            size_bytes: optional(read_number(field(item, "size"))),
        });
    }
    // Largest first: a panel showing one wants the best it can get.
    thumbnails.sort_by(|left, right| {
        let difference = right.width * right.height - left.width * left.height;
        if difference.is_nan() {
            Ordering::Equal
        } else {
            difference.partial_cmp(&0.0).unwrap()
        }
    });
    let text_of = |name: &str| match read_string(field(payload, name)) {
        Some(text) => wire::OptionalPrinterReplyText::Value(text),
        None => wire::OptionalPrinterReplyText::Absent(wire::Empty {}),
    };
    let number_of = |name: &str| optional(read_number(field(payload, name)));
    wire::PrinterStorageMetadata {
        path: relative.to_vec(),
        size_bytes: number_of("size"),
        modified_ms: optional(read_timestamp_ms(field(payload, "modified"))),
        slicer: text_of("slicer"),
        slicer_version: text_of("slicer_version"),
        layer_height_mm: number_of("layer_height"),
        object_height_mm: number_of("object_height"),
        filament_total_mm: number_of("filament_total"),
        filament_weight_g: number_of("filament_weight_total"),
        estimated_seconds: number_of("estimated_time"),
        first_layer_bed_temp_c: number_of("first_layer_bed_temp"),
        first_layer_nozzle_temp_c: number_of("first_layer_extr_temp"),
        thumbnails,
    }
}

/// `formatStorageSize`: a size an operator reads; a missing one stays missing.
pub fn size_text(bytes: f64) -> Option<String> {
    if !bytes.is_finite() || bytes < 0.0 {
        return None;
    }
    if bytes < 1024.0 {
        return Some(format!("{} B", number_to_string(bytes)));
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = bytes / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let shown = if value >= 100.0 {
        number_to_string(round(value))
    } else {
        to_fixed(value, 1)
    };
    Some(format!("{shown} {}", UNITS[unit]))
}
/// [`size_text`] on the wire, as the hosts carry it.
pub fn size(bytes: f64) -> wire::OptionalText {
    optional_text(size_text(bytes).map(|text| text.encode_utf16().collect()))
}
