//! `PrintJobStatus.ts`: what the machine is doing, projected from the exact
//! Klipper objects Moonraker reports. A full query seeds the model and
//! `notify_status_update` patches merge into it field by field, nested records
//! too (Moonraker sends only what changed); every reading is projected afresh.
//! A field the printer does not report stays absent rather than defaulting,
//! so a surface can tell "not printing" from "not known".
use orcaxr_contracts::{
    CoreError,
    canonical::{JsonLimits, Value, parse_javascript},
    project_intent_types as wire,
};
use std::collections::BTreeMap;

/// The Klipper objects the model reads (`PRINT_JOB_OBJECTS`): the query
/// requests them and a host subscribes to them.
pub const OBJECTS: [&str; 6] = [
    "webhooks",
    "print_stats",
    "virtual_sdcard",
    "display_status",
    "extruder",
    "heater_bed",
];
/// `PRINT_JOB_QUERY_PATH`.
pub const QUERY_PATH: &str =
    "/printer/objects/query?webhooks&print_stats&virtual_sdcard&display_status&extruder&heater_bed";
/// Bounds on one reply or event's text. They exceed what the browser
/// transport admits (2 MiB replies, sockets of 1 Mi UTF-16 units), so any
/// message the browser reads is read here too.
pub const LIMITS: JsonLimits = JsonLimits {
    bytes: 4 * 1024 * 1024,
    nodes: 1_000_000,
    depth: 128,
};

type Record = BTreeMap<Vec<u16>, Value>;

/// `PrintJobStatusModel`: accumulated object state and its latest projection.
#[derive(Debug, Clone)]
pub struct JobStatus {
    raw: BTreeMap<Vec<u16>, Record>,
    current: wire::PrintJobSnapshot,
}
impl Default for JobStatus {
    fn default() -> Self {
        Self {
            raw: BTreeMap::new(),
            current: empty(),
        }
    }
}

/// Why a reading was refused; the model is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The text is not JSON, or exceeds [`LIMITS`] (the parser's code).
    Json(&'static str),
    /// The host's clock is not a finite number.
    InvalidTime,
}
impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Json(code) => code,
            Self::InvalidTime => "invalid_request",
        }
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn empty() -> wire::PrintJobSnapshot {
    snapshot(&BTreeMap::new(), 0.0)
}
fn read(text: &str, now: f64) -> Result<Value, Refusal> {
    if !now.is_finite() {
        return Err(Refusal::InvalidTime);
    }
    parse_javascript(text, LIMITS).map_err(|e: CoreError| Refusal::Json(e.code))
}
fn field<'a>(record: Option<&'a Record>, name: &str) -> Option<&'a Value> {
    record.and_then(|r| r.get(&units(name)))
}

impl JobStatus {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn snapshot(&self) -> &wire::PrintJobSnapshot {
        &self.current
    }
    pub fn reset(&mut self) -> &wire::PrintJobSnapshot {
        *self = Self::default();
        &self.current
    }
    /// Seed from a `/printer/objects/query` result, whose `status` maps each
    /// object: earlier readings are dropped first, so nothing is inherited.
    pub fn apply_query(
        &mut self,
        text: &str,
        now: f64,
    ) -> Result<&wire::PrintJobSnapshot, Refusal> {
        let payload = read(text, now)?;
        self.raw.clear();
        let status = match &payload {
            Value::Object(payload) => match payload.get(&units("status")) {
                Some(Value::Object(status)) => Some(status),
                _ => None,
            },
            _ => None,
        };
        Ok(self.apply_status(status, now))
    }
    /// Apply one `notify_status_update` params array (`[status, eventtime]`),
    /// or a bare status. `None` when it concerns none of [`OBJECTS`] (as an
    /// own key), leaving the model as it was.
    pub fn apply_notification(
        &mut self,
        text: &str,
        now: f64,
    ) -> Result<Option<&wire::PrintJobSnapshot>, Refusal> {
        let params = read(text, now)?;
        let status = match &params {
            Value::Array(items) => items.first(),
            other => Some(other),
        };
        let Some(Value::Object(status)) = status else {
            return Ok(None);
        };
        if !status
            .keys()
            .any(|key| OBJECTS.iter().any(|o| *key == units(o)))
        {
            return Ok(None);
        }
        Ok(Some(self.apply_status(Some(status), now)))
    }
    fn apply_status(&mut self, status: Option<&Record>, now: f64) -> &wire::PrintJobSnapshot {
        for (object, value) in status.into_iter().flatten() {
            // Objects the projection never reads would accumulate unobserved.
            let Value::Object(patch) = value else {
                continue;
            };
            if OBJECTS.iter().any(|o| *object == units(o)) {
                merge(self.raw.entry(object.clone()).or_default(), patch);
            }
        }
        self.current = snapshot(&self.raw, now);
        &self.current
    }
}

/// One patch merged into an accumulated record; nested records (notably
/// `print_stats.info`) merge field by field, so a reported layer keeps the
/// total reported earlier. Every key, `__proto__` included, is data.
fn merge(previous: &mut Record, patch: &Record) {
    for (key, value) in patch {
        match (previous.get_mut(key), value) {
            (Some(Value::Object(existing)), Value::Object(nested)) => merge(existing, nested),
            _ => {
                previous.insert(key.clone(), value.clone());
            }
        }
    }
}

fn finite(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}
fn optional(value: Option<f64>) -> wire::OptionalFinite {
    match value {
        Some(value) => wire::OptionalFinite::Value(value),
        None => wire::OptionalFinite::Absent(wire::Empty {}),
    }
}
fn text(value: Option<&Value>, allow_empty: bool) -> wire::OptionalText {
    match value {
        Some(Value::String(s)) if allow_empty || !s.is_empty() => {
            wire::OptionalText::Value(s.clone())
        }
        _ => wire::OptionalText::Absent(wire::Empty {}),
    }
}
/// A whole number of at least zero (`positiveInteger`, which admits 0).
fn count(value: Option<&Value>) -> Option<f64> {
    finite(value).filter(|n| n.trunc() == *n && *n >= 0.0)
}
fn temperature(record: Option<&Record>) -> wire::OptionalPrintJobTemperature {
    match finite(field(record, "temperature")) {
        Some(actual_c) => wire::OptionalPrintJobTemperature::Value(wire::PrintJobTemperature {
            actual_c,
            target_c: finite(field(record, "target")).unwrap_or(0.0),
        }),
        None => wire::OptionalPrintJobTemperature::Absent(wire::Empty {}),
    }
}
/// `normalizeState`: the reported state lowercased, `canceled` read as
/// `cancelled`, anything else unknown.
fn state(value: Option<&Value>) -> wire::PrintJobState {
    let lowered = match value {
        Some(Value::String(s)) => String::from_utf16(s)
            .map(|s| s.to_lowercase())
            .unwrap_or_default(),
        _ => String::new(),
    };
    match lowered.as_str() {
        "printing" => wire::PrintJobState::Printing,
        "paused" => wire::PrintJobState::Paused,
        "complete" => wire::PrintJobState::Complete,
        "cancelled" | "canceled" => wire::PrintJobState::Cancelled,
        "error" => wire::PrintJobState::Error,
        "standby" => wire::PrintJobState::Standby,
        _ => wire::PrintJobState::Unknown,
    }
}
/// `estimateRemaining`: file-progress extrapolation, withheld while heat-up
/// and start G-code dominate (2% or less) or once the file is done.
fn remaining(progress: Option<f64>, duration: Option<f64>) -> Option<f64> {
    let (progress, duration) = (progress?, duration?);
    if progress <= 0.02 || progress >= 1.0 || duration <= 0.0 {
        return None;
    }
    let remaining = duration / progress - duration;
    (remaining.is_finite() && remaining >= 0.0).then_some(remaining)
}

/// `projectPrintJobSnapshot`.
fn snapshot(raw: &BTreeMap<Vec<u16>, Record>, now: f64) -> wire::PrintJobSnapshot {
    let object = |name: &str| raw.get(&units(name));
    let stats = object("print_stats");
    let virtual_sd = object("virtual_sdcard");
    let display = object("display_status");
    let info = match field(stats, "info") {
        Some(Value::Object(info)) => Some(info),
        _ => None,
    };
    let progress =
        finite(field(virtual_sd, "progress")).or_else(|| finite(field(display, "progress")));
    let print_duration = finite(field(stats, "print_duration"));
    wire::PrintJobSnapshot {
        state: state(field(stats, "state")),
        klippy_state: text(field(object("webhooks"), "state"), true),
        filename: text(field(stats, "filename"), false),
        virtual_sd_active: match field(virtual_sd, "is_active") {
            Some(Value::Bool(active)) => wire::OptionalFlag::Value(*active),
            _ => wire::OptionalFlag::Absent(wire::Empty {}),
        },
        message: text(field(stats, "message"), false),
        progress: optional(progress.map(|p| p.clamp(0.0, 1.0))),
        current_layer: optional(count(field(info, "current_layer"))),
        total_layers: optional(count(field(info, "total_layer"))),
        print_duration_s: optional(print_duration),
        total_duration_s: optional(finite(field(stats, "total_duration"))),
        filament_used_mm: optional(finite(field(stats, "filament_used"))),
        estimated_remaining_s: optional(remaining(progress, print_duration)),
        extruder: temperature(object("extruder")),
        bed: temperature(object("heater_bed")),
        updated_at_ms: now,
    }
}
