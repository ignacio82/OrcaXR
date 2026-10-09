//! `PrinterHistory.ts`: what a printer has already printed — a page of its
//! job records, its totals, and how a panel describes them.
//!
//! A page is a page: the history of a machine in daily service is thousands
//! of jobs, so it pages explicitly, reports the printer's own count, and
//! holds no more rows than it asked for. Reported or absent, never zero: a
//! job Klipper never finished has no end time and no filament total.
//!
//! An operation is planned ([`plan`]: the request to send, or why it is
//! refused), its transport outcome finished ([`finish`]), and a reply read
//! ([`read`]) — the host carries the exchange out.
use crate::reply::{
    Ending, LIMITS, Value, array, ending, field, joined, known, optional, optional_reply_text,
    read_number, read_string, record, units,
};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::{
    convert::{number_to_string, to_fixed},
    round,
};
use wire::PrintHistoryErrorCode as Code;

/// Rows a page holds unless asked otherwise.
pub const DEFAULT_PAGE: f64 = 20.0;
/// Requesting more than this at once is a slow query on a real machine.
pub const MAX_PAGE: f64 = 100.0;

fn failure(code: Code, message: &[u16]) -> wire::PrintHistoryFailure {
    wire::PrintHistoryFailure {
        code,
        message: message.to_vec(),
    }
}

/// `listPrintHistory`'s page checks: the limit and start a request names.
fn page_bounds(
    request: &wire::PrintHistoryPageRequest,
) -> Result<(f64, f64), wire::PrintHistoryFailure> {
    let limit = known(&request.limit).unwrap_or(DEFAULT_PAGE);
    let start = known(&request.start).unwrap_or(0.0);
    if limit.fract() != 0.0 || !(1.0..=MAX_PAGE).contains(&limit) {
        return Err(failure(
            Code::InvalidPage,
            &units(&format!(
                "A history page must hold between 1 and {} jobs.",
                number_to_string(MAX_PAGE)
            )),
        ));
    }
    // `Number.isSafeInteger`: a start any request can spell.
    if start.fract() != 0.0 || start.abs() > 9_007_199_254_740_991.0 || start < 0.0 {
        return Err(failure(
            Code::InvalidPage,
            &units("A history page cannot start before the first job."),
        ));
    }
    Ok((limit, start))
}

/// What an operation sends, or why it is refused before anything leaves.
pub fn plan(op: &wire::PrintHistoryOperation) -> wire::PrintHistoryPlan {
    let send = |path: String, operation: &str| {
        wire::PrintHistoryPlan::Request(wire::PrinterSend {
            path: units(&path),
            method: units("GET"),
            operation: units(operation),
            timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
        })
    };
    match op {
        wire::PrintHistoryOperation::Page(request) => match page_bounds(request) {
            Ok((limit, start)) => send(
                format!(
                    "/server/history/list?limit={}&start={}&order=desc",
                    number_to_string(limit),
                    number_to_string(start)
                ),
                "print_history",
            ),
            Err(f) => wire::PrintHistoryPlan::Refused(f),
        },
        wire::PrintHistoryOperation::Totals(_) => {
            send("/server/history/totals".to_owned(), "print_history_totals")
        }
    }
}

/// The sentence a failed exchange of [`op`] leads with.
fn lead(op: &wire::PrintHistoryOperation) -> &'static str {
    match op {
        wire::PrintHistoryOperation::Page(_) => "The printer did not report its print history",
        wire::PrintHistoryOperation::Totals(_) => "The printer did not report its print totals",
    }
}

/// An operation's result once its exchange ended without a reply to read:
/// the failure it reads as (an exchange that ended with nothing read, as
/// `done`, reads as an unreadable reply).
pub fn finish(request: &wire::PrintHistoryFinish) -> wire::PrintHistoryResult {
    let failed = wire::PrintHistoryResult::Failed;
    let page = match &request.operation {
        wire::PrintHistoryOperation::Page(page) => match page_bounds(page) {
            Ok(_) => true,
            Err(f) => return failed(f),
        },
        wire::PrintHistoryOperation::Totals(_) => false,
    };
    let lead = lead(&request.operation);
    match ending(&request.outcome) {
        Ending::Done => unreadable(page),
        // `historyFailure`: a cancel (the caller's, or the transport's) reads as one.
        Ending::Cancelled => failed(failure(
            Code::Cancelled,
            &units(&format!("{lead}: cancelled.")),
        )),
        Ending::Failed(detail) => failed(failure(
            Code::Unavailable,
            &units(&format!("{lead} ({detail}).")),
        )),
    }
}

/// A reply that is not the record the operation reads.
fn unreadable(page: bool) -> wire::PrintHistoryResult {
    wire::PrintHistoryResult::Failed(failure(
        Code::Unavailable,
        &units(if page {
            "The printer's print history was not readable."
        } else {
            "The printer's print totals were not readable."
        }),
    ))
}

/// A reply (Moonraker's `result`, as JSON) read as the browser reads it.
pub fn read(op: &wire::PrintHistoryOperation, reply: &str) -> wire::PrintHistoryResult {
    let bounds = match op {
        wire::PrintHistoryOperation::Page(page) => match page_bounds(page) {
            Ok(bounds) => Some(bounds),
            Err(f) => return wire::PrintHistoryResult::Failed(f),
        },
        wire::PrintHistoryOperation::Totals(_) => None,
    };
    // Text that is not JSON is no record either.
    let Some(payload) = parse_javascript(reply, LIMITS)
        .ok()
        .filter(|p| record(Some(p)).is_some())
    else {
        return unreadable(bounds.is_some());
    };
    match bounds {
        Some((limit, start)) => page(&payload, limit, start),
        None => totals(&payload),
    }
}

fn page(payload: &Value, limit: f64, start: f64) -> wire::PrintHistoryResult {
    let mut jobs = Vec::new();
    for entry in array(field(payload, "jobs")) {
        if jobs.len() as f64 == limit {
            break;
        }
        if let Some(job) = job(entry) {
            jobs.push(job);
        }
    }
    // A build that omits the count still pages correctly from what it returned.
    let total = read_count(field(payload, "count")).unwrap_or(start + jobs.len() as f64);
    wire::PrintHistoryResult::Page(wire::PrintHistoryPage {
        jobs,
        total,
        start,
        limit,
    })
}

fn totals(payload: &Value) -> wire::PrintHistoryResult {
    let Some(totals) = record(field(payload, "job_totals")) else {
        return unreadable(false);
    };
    let number = |name: &str| optional(read_number(field(totals, name)));
    wire::PrintHistoryResult::Totals(wire::PrintHistoryTotals {
        jobs: optional(read_count(field(totals, "total_jobs"))),
        total_seconds: number("total_time"),
        print_seconds: number("total_print_time"),
        filament_used_mm: number("total_filament_used"),
        longest_job_seconds: number("longest_job"),
        longest_print_seconds: number("longest_print"),
    })
}

/// Outcomes Moonraker records; anything else reads as interrupted, its own
/// word kept visible.
fn status(raw: &[u16]) -> Option<wire::PrintHistoryStatus> {
    use wire::PrintHistoryStatus as S;
    Some(match String::from_utf16(raw).ok()?.as_str() {
        "completed" => S::Completed,
        "cancelled" => S::Cancelled,
        "error" => S::Error,
        "klippy_shutdown" => S::KlippyShutdown,
        "klippy_disconnect" => S::KlippyDisconnect,
        "in_progress" => S::InProgress,
        "interrupted" => S::Interrupted,
        _ => return None,
    })
}

/// `readJob`: a record with a filename, or nothing.
fn job(entry: &Value) -> Option<wire::PrintHistoryJob> {
    record(Some(entry))?;
    let filename = read_string(field(entry, "filename"))?;
    let raw = read_string(field(entry, "status")).unwrap_or_default();
    let known_status = status(&raw);
    let metadata = record(field(entry, "metadata"));
    // The printer's id, unless it is the filename the id falls back to.
    let job_id = read_string(field(entry, "job_id")).filter(|id| *id != filename);
    Some(wire::PrintHistoryJob {
        job_id: optional_reply_text(job_id),
        status: known_status.unwrap_or(wire::PrintHistoryStatus::Interrupted),
        raw_status: optional_reply_text((known_status.is_none() && !raw.is_empty()).then_some(raw)),
        started_at_ms: optional(seconds_to_ms(read_number(field(entry, "start_time")))),
        ended_at_ms: optional(seconds_to_ms(read_number(field(entry, "end_time")))),
        print_seconds: optional(read_number(field(entry, "print_duration"))),
        total_seconds: optional(read_number(field(entry, "total_duration"))),
        filament_used_mm: optional(read_number(field(entry, "filament_used"))),
        file_exists: !matches!(field(entry, "exists"), Some(Value::Bool(false))),
        estimated_seconds: optional(read_number(
            metadata.and_then(|m| field(m, "estimated_time")),
        )),
        filename,
    })
}

/// `secondsToMs`: a positive time, in milliseconds while finite.
fn seconds_to_ms(seconds: Option<f64>) -> Option<f64> {
    seconds
        .filter(|s| *s > 0.0)
        .map(|s| round(s * 1000.0))
        .filter(|ms| ms.is_finite())
}

/// `readCount`: a whole, non-negative, safe number of jobs.
fn read_count(value: Option<&Value>) -> Option<f64> {
    read_number(value).filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
}

/// A job's id: the printer's own, or its filename.
pub fn job_id(job: &wire::PrintHistoryJob) -> &[u16] {
    match &job.job_id {
        wire::OptionalPrinterReplyText::Value(id) => id,
        wire::OptionalPrinterReplyText::Absent(_) => &job.filename,
    }
}

/// `formatHistoryDuration`: `2 h 14 min`; an unreported duration stays
/// unreported, never "0 s".
pub fn duration_text(seconds: f64) -> Option<String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let total = round(seconds);
    let hours = (total / 3600.0).floor();
    let minutes = ((total % 3600.0) / 60.0).floor();
    Some(if hours > 0.0 {
        format!(
            "{} h {} min",
            number_to_string(hours),
            number_to_string(minutes)
        )
    } else if minutes > 0.0 {
        format!("{} min", number_to_string(minutes))
    } else {
        format!("{} s", number_to_string(total))
    })
}

/// `formatFilamentLength`: metres for anything past a metre.
pub fn filament_text(millimetres: f64) -> Option<String> {
    if !millimetres.is_finite() || millimetres < 0.0 {
        return None;
    }
    Some(if millimetres >= 1000.0 {
        format!("{} m", to_fixed(millimetres / 1000.0, 2))
    } else {
        format!("{} mm", number_to_string(round(millimetres)))
    })
}

/// `estimateDelta`: how the print compared with the slicer's estimate, as a
/// signed percentage; nothing unless both exist, the estimate is positive and
/// the gap is a number.
pub fn estimate_delta(job: &wire::PrintHistoryJob) -> Option<f64> {
    let actual = known(&job.print_seconds)?;
    let estimated = known(&job.estimated_seconds).filter(|e| *e > 0.0)?;
    Some((actual - estimated) / estimated * 100.0).filter(|delta| delta.is_finite())
}

/// `describeHistoryStatus`.
pub fn status_text(job: &wire::PrintHistoryJob) -> Vec<u16> {
    use wire::PrintHistoryStatus as S;
    units(match job.status {
        S::Completed => "Completed",
        S::Cancelled => "Cancelled",
        S::Error => "Failed",
        S::KlippyShutdown => "Stopped by a Klipper shutdown",
        S::KlippyDisconnect => "Stopped when Klipper disconnected",
        S::InProgress => "Still running",
        S::Interrupted => match &job.raw_status {
            wire::OptionalPrinterReplyText::Value(raw) => {
                return joined(&[&units("Interrupted ("), raw, &units(")")]);
            }
            wire::OptionalPrinterReplyText::Absent(_) => "Interrupted",
        },
    })
}

/// `describeJobFacts`: one line per job, anything unreported an em dash.
pub fn job_facts(job: &wire::PrintHistoryJob) -> String {
    let missing = "—";
    let shown = |value: Option<String>| value.unwrap_or_else(|| missing.to_owned());
    let mut parts = vec![format!(
        "Printed {}",
        shown(known(&job.print_seconds).and_then(duration_text))
    )];
    if let Some(delta) = estimate_delta(job) {
        let rounded = round(delta);
        parts.push(if rounded == 0.0 {
            "exactly as estimated".to_owned()
        } else {
            format!(
                "{}{}% vs estimate",
                if rounded > 0.0 { "+" } else { "" },
                number_to_string(rounded)
            )
        });
    }
    parts.push(format!(
        "{} filament",
        shown(known(&job.filament_used_mm).and_then(filament_text))
    ));
    parts.join(" · ")
}

/// A job as a panel row shows it: its outcome, its facts and the gap
/// against the estimate.
pub fn job_view(job: &wire::PrintHistoryJob) -> wire::PrintHistoryJobView {
    wire::PrintHistoryJobView {
        status: status_text(job),
        facts: units(&job_facts(job)),
        estimate_delta: optional(estimate_delta(job)),
    }
}

/// `describeHistoryTotals`.
pub fn totals_text(totals: &wire::OptionalPrintHistoryTotals) -> String {
    let wire::OptionalPrintHistoryTotals::Value(totals) = totals else {
        return "Totals not read yet".to_owned();
    };
    let mut parts = Vec::new();
    if let Some(jobs) = known(&totals.jobs) {
        parts.push(format!(
            "{} job{}",
            number_to_string(jobs),
            if jobs == 1.0 { "" } else { "s" }
        ));
    }
    let duration = |value: &wire::OptionalFinite| known(value).and_then(duration_text);
    if let Some(printed) = duration(&totals.print_seconds) {
        parts.push(format!("{printed} printing"));
    }
    if let Some(filament) = known(&totals.filament_used_mm).and_then(filament_text) {
        parts.push(format!("{filament} filament"));
    }
    if let Some(longest) = duration(&totals.longest_print_seconds) {
        parts.push(format!("longest {longest}"));
    }
    if parts.is_empty() {
        "The printer reported no totals".to_owned()
    } else {
        parts.join(" · ")
    }
}

/// JavaScript's `Math.max`: `NaN` wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `historyPageBounds` and `describeHistoryPage`: where a pager stands and
/// what it says.
pub fn page_view(shape: &wire::PrintHistoryPageShape) -> wire::PrintHistoryPageView {
    let page_index = (shape.start / shape.limit).floor();
    let page_count = js_max(1.0, (shape.total / shape.limit).ceil());
    wire::PrintHistoryPageView {
        page_index,
        page_count,
        has_previous: shape.start > 0.0,
        has_next: shape.start + shape.job_count < shape.total,
        previous_start: js_max(0.0, shape.start - shape.limit),
        next_start: shape.start + shape.limit,
        label: units(&format!(
            "Page {} of {} — {} job{}",
            number_to_string(page_index + 1.0),
            number_to_string(page_count),
            number_to_string(shape.total),
            if shape.total == 1.0 { "" } else { "s" }
        )),
    }
}
