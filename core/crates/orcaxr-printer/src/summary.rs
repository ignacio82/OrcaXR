//! The compact printer status both narrow-touch and XR surfaces render
//! (`PrinterStatusSummary.ts`, with `describePrintJobState` and
//! `formatDuration` from `PrintJobStatus.ts`): one headline, one detail line,
//! the progress the machine reported and, when the session drops, what is
//! known, how old it is and what to do about it. Nothing is invented: a field
//! the printer did not report stays absent; a reading nobody can confirm is
//! marked with its age.
use crate::{control::moonraker_code, status::is_active};
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::js_math::{self, convert::number_to_string};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn optional_text(text: Option<Vec<u16>>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn read(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}
fn finite(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(value) => Some(*value),
        wire::OptionalFinite::Absent(_) => None,
    }
}
/// `String(number)`.
fn number(value: f64) -> String {
    number_to_string(value)
}

/// `describeMoonrakerErrorCode`: the sentence for one transport error.
pub fn describe_error(code: wire::MoonrakerErrorCode) -> &'static str {
    match moonraker_code(code) {
        "invalid_endpoint" => "The Moonraker endpoint is invalid or unsafe.",
        "invalid_credentials" => "The Moonraker credentials are invalid.",
        "invalid_state" => "The Moonraker operation is not valid in the current connection state.",
        "invalid_request" => "The Moonraker operation was given an invalid argument.",
        "cancelled" => "The Moonraker operation was cancelled.",
        "timeout" => "The Moonraker operation timed out.",
        "network" => "Moonraker could not be reached.",
        "auth_required" => "Moonraker requires authentication.",
        "forbidden" => "Moonraker rejected the authenticated request.",
        "http_error" => "Moonraker returned an HTTP error.",
        "invalid_response" => "Moonraker returned an invalid response.",
        "protocol_error" => "Moonraker returned a protocol error.",
        "version_unsupported" => "The Moonraker API version is not supported.",
        "websocket_unavailable" => "WebSocket support is unavailable in this browser.",
        "websocket_failed" => "The Moonraker WebSocket connection failed.",
        "heartbeat_timeout" => "The Moonraker WebSocket heartbeat timed out.",
        _ => "Moonraker reconnection attempts were exhausted.",
    }
}

/// `describePrintJobState`.
pub fn describe_state(snapshot: &wire::PrintJobSnapshot) -> Vec<u16> {
    // Truthiness: an empty name or message reads as none.
    let filename = read(&snapshot.filename).filter(|n| !n.is_empty());
    let with = |prefix: &str, alone: &str| match filename {
        Some(name) => [units(prefix), name.to_vec()].concat(),
        None => units(alone),
    };
    match snapshot.state {
        wire::PrintJobState::Printing => with("Printing ", "Printing"),
        wire::PrintJobState::Paused => with("Paused \u{2014} ", "Paused"),
        wire::PrintJobState::Complete => with("Finished ", "Finished"),
        wire::PrintJobState::Cancelled => units("Cancelled"),
        wire::PrintJobState::Error => match read(&snapshot.message).filter(|m| !m.is_empty()) {
            Some(message) => [units("Error: "), message.to_vec()].concat(),
            None => units("Error"),
        },
        wire::PrintJobState::Standby => units("Idle"),
        wire::PrintJobState::Unknown => units("State not reported"),
    }
}

/// `formatDuration`: `1h 04m` / `12m 30s` / `45s`, or an em dash when there is
/// nothing to show.
pub fn format_duration(seconds: Option<f64>) -> String {
    let Some(seconds) = seconds.filter(|s| s.is_finite() && *s >= 0.0) else {
        return "\u{2014}".into();
    };
    let total = js_math::round(seconds);
    let hours = (total / 3600.0).floor();
    let minutes = ((total % 3600.0) / 60.0).floor();
    let rest = total % 60.0;
    let pad = |n: f64| format!("{:0>2}", number(n));
    if hours > 0.0 {
        format!("{}h {}m", number(hours), pad(minutes))
    } else if minutes > 0.0 {
        format!("{}m {}s", number(minutes), pad(rest))
    } else {
        format!("{}s", number(rest))
    }
}

/// `formatReadingAge`: `40 s ago` / `3 min ago`, once a reading stops being
/// confirmed.
pub fn format_reading_age(age_ms: f64) -> String {
    if !age_ms.is_finite() || age_ms < 0.0 {
        return "just now".into();
    }
    let seconds = js_math::round(age_ms / 1000.0);
    if seconds < 5.0 {
        return "just now".into();
    }
    if seconds < 90.0 {
        return format!("{} s ago", number(seconds));
    }
    let minutes = js_math::round(seconds / 60.0);
    if minutes < 90.0 {
        return format!("{} min ago", number(minutes));
    }
    format!("{} h ago", number(js_math::round(minutes / 60.0)))
}

fn describe_temperature(temperature: &wire::PrintJobTemperature) -> String {
    let actual = format!("{} \u{b0}C", number(js_math::round(temperature.actual_c)));
    if temperature.target_c > 0.0 {
        format!(
            "{actual} \u{2192} {} \u{b0}C",
            number(js_math::round(temperature.target_c))
        )
    } else {
        actual
    }
}

/// A connection that cannot confirm a reading, and why.
fn staleness(connection: Option<&wire::MoonrakerConnectionView>) -> (bool, String) {
    match connection {
        None => (true, "This session is not connected to a printer.".into()),
        Some(wire::MoonrakerConnectionView::Connected(_)) => (false, String::new()),
        Some(wire::MoonrakerConnectionView::Connecting(_)) => {
            (true, "Still connecting to the printer.".into())
        }
        Some(wire::MoonrakerConnectionView::Reconnecting(_)) => {
            (true, "The connection to the printer dropped.".into())
        }
        Some(wire::MoonrakerConnectionView::Error(error)) => {
            (true, describe_error(error.code).into())
        }
        Some(wire::MoonrakerConnectionView::Disconnected(_)) => {
            (true, "The connection to the printer is closed.".into())
        }
    }
}
fn recovery(
    connection: Option<&wire::MoonrakerConnectionView>,
    reason: &str,
) -> Option<wire::PrinterStatusRecovery> {
    let plain = |action: &str, automatic: bool| wire::PrinterStatusRecovery {
        message: units(reason),
        action_label: units(action),
        retry_in_s: wire::OptionalFinite::Absent(wire::Empty {}),
        automatic,
    };
    match connection {
        None | Some(wire::MoonrakerConnectionView::Disconnected(_)) => {
            Some(plain("Connect", false))
        }
        Some(wire::MoonrakerConnectionView::Connected(_)) => None,
        Some(wire::MoonrakerConnectionView::Connecting(_)) => {
            Some(plain("Connecting\u{2026}", true))
        }
        Some(wire::MoonrakerConnectionView::Reconnecting(view)) => {
            Some(wire::PrinterStatusRecovery {
                message: units(&format!(
                    "{reason} Retrying on its own; the print keeps running either way."
                )),
                action_label: units("Reconnect now"),
                retry_in_s: wire::OptionalFinite::Value(js_math::max(
                    0.0,
                    js_math::round(view.delay_ms / 1000.0),
                )),
                automatic: true,
            })
        }
        Some(wire::MoonrakerConnectionView::Error(_)) => Some(plain("Reconnect", false)),
    }
}
fn tone(snapshot: Option<&wire::PrintJobSnapshot>, stale: bool) -> wire::PrinterStatusTone {
    use wire::{PrintJobState as S, PrinterStatusTone as T};
    match snapshot.map(|s| s.state) {
        None | Some(S::Unknown) => T::Unknown,
        Some(S::Error) => T::Danger,
        _ if stale => T::Attention,
        Some(S::Paused) => T::Attention,
        Some(S::Printing) => T::Active,
        _ => T::Idle,
    }
}

/// `summarizePrinterStatus`.
pub fn summarize(request: &wire::PrinterStatusRequest) -> wire::PrinterStatusSummary {
    let snapshot = match &request.snapshot {
        wire::OptionalPrintJobSnapshot::Value(snapshot) => Some(snapshot),
        wire::OptionalPrintJobSnapshot::Absent(_) => None,
    };
    let connection = match &request.connection {
        wire::OptionalMoonrakerConnectionView::Value(connection) => Some(connection),
        wire::OptionalMoonrakerConnectionView::Absent(_) => None,
    };
    let (stale, reason) = staleness(connection);
    if !request.configured {
        return wire::PrinterStatusSummary {
            tone: wire::PrinterStatusTone::Unknown,
            headline: units("No printer configured"),
            detail: units("Add a Moonraker endpoint to monitor a print from here."),
            progress: wire::OptionalFinite::Absent(wire::Empty {}),
            progress_label: optional_text(None),
            stale: true,
            age_label: optional_text(None),
            recovery: wire::OptionalPrinterStatusRecovery::Absent(wire::Empty {}),
            facts: Vec::new(),
            present: false,
        };
    }
    let tone = tone(snapshot, stale);
    let active = snapshot.is_some_and(|s| is_active(s.state));
    let recovery = recovery(connection, &reason);
    let age_label = snapshot
        .filter(|s| stale && s.updated_at_ms > 0.0)
        .map(|s| format_reading_age(request.now_ms - s.updated_at_ms));
    let headline = snapshot.map_or_else(|| units("Printer not reporting"), describe_state);

    let mut facts = Vec::new();
    let mut fact = |label: &str, value: String| {
        facts.push(wire::PrinterStatusFact {
            label: units(label),
            value: units(&value),
        })
    };
    if let Some(s) = snapshot {
        if let (Some(current), Some(total)) = (finite(&s.current_layer), finite(&s.total_layers)) {
            fact("Layer", format!("{} / {}", number(current), number(total)));
        }
        if let Some(elapsed) = finite(&s.print_duration_s) {
            fact("Elapsed", format_duration(Some(elapsed)));
        }
        if let Some(left) = finite(&s.estimated_remaining_s) {
            fact("Left (approx.)", format_duration(Some(left)));
        }
        if let wire::OptionalPrintJobTemperature::Value(t) = &s.extruder {
            fact("Nozzle", describe_temperature(t));
        }
        if let wire::OptionalPrintJobTemperature::Value(t) = &s.bed {
            fact("Bed", describe_temperature(t));
        }
    }

    let progress = snapshot
        .and_then(|s| finite(&s.progress))
        .map(|p| js_math::min(1.0, js_math::max(0.0, p)));
    let progress_label = progress.map(|p| format!("{}%", number(js_math::round(p * 100.0))));
    let remaining = snapshot.and_then(|s| finite(&s.estimated_remaining_s));
    // A lost session claims the detail line: how old the reading is outranks
    // how far along it was.
    let detail = if stale {
        match &age_label {
            Some(age) => units(&format!("Last reading {age}")),
            None => units(&reason),
        }
    } else {
        match (&progress_label, active) {
            (Some(label), true) => match remaining {
                Some(left) => units(&format!(
                    "{label} \u{b7} about {} left",
                    format_duration(Some(left))
                )),
                None => units(label),
            },
            _ => snapshot
                .and_then(|s| read(&s.message))
                .map_or_else(|| units("Nothing running"), <[u16]>::to_vec),
        }
    };
    let present = active
        || tone == wire::PrinterStatusTone::Danger
        || (stale && snapshot.is_some_and(|s| s.state != wire::PrintJobState::Standby));
    wire::PrinterStatusSummary {
        tone,
        headline,
        detail,
        progress: match progress {
            Some(p) => wire::OptionalFinite::Value(p),
            None => wire::OptionalFinite::Absent(wire::Empty {}),
        },
        progress_label: optional_text(progress_label.map(|l| units(&l))),
        stale,
        age_label: optional_text(age_label.map(|l| units(&l))),
        recovery: match recovery {
            Some(r) => wire::OptionalPrinterStatusRecovery::Value(r),
            None => wire::OptionalPrinterStatusRecovery::Absent(wire::Empty {}),
        },
        facts,
        present,
    }
}
