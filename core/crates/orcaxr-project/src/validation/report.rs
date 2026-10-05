use super::{timestamp, validate_project};
use crate::model::{ProjectData, ProjectState, Text};
use std::{fmt, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}
impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}
/// UI paths/messages are lossless UTF-16 and may contain private imported data.
/// Debug uses Text's redacted representation; use the fields only for intended UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: &'static str,
    pub path: Text,
    pub message: Text,
    pub severity: Severity,
}
#[derive(Clone, PartialEq, Eq)]
pub struct ValidationReport(pub(super) Arc<[Issue]>);
impl ValidationReport {
    pub fn issues(&self) -> &[Issue] {
        &self.0
    }
    pub fn is_valid(&self) -> bool {
        self.error_count() == 0
    }
    pub fn error_count(&self) -> usize {
        self.0
            .iter()
            .filter(|i| i.severity == Severity::Error)
            .count()
    }
    pub fn user_message(&self) -> Text {
        let mut text = format!("Invalid project state ({} errors)", self.error_count())
            .encode_utf16()
            .collect::<Vec<_>>();
        if let Some(first) = self.0.iter().find(|i| i.severity == Severity::Error) {
            text.extend(": ".encode_utf16());
            text.extend(first.message.units());
            text.extend(" at ".encode_utf16());
            text.extend(first.path.units());
        }
        Text::new(text)
    }
}
impl fmt::Debug for ValidationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ValidationReport")
            .field("issues", &self.0.len())
            .field("errors", &self.error_count())
            .finish()
    }
}
impl fmt::Display for ValidationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid project state ({} errors)", self.error_count())
    }
}

/// A host may use its actual Date.parse implementation, or the pinned V8 grammar
/// with its local timezone adapter. Failures of that service are not invalid data.
pub trait TimestampPolicy {
    type Error;
    fn is_valid(&mut self, text: &[u16]) -> Result<bool, Self::Error>;
}
impl<E, F: FnMut(&[u16]) -> Result<bool, E>> TimestampPolicy for F {
    type Error = E;
    fn is_valid(&mut self, text: &[u16]) -> Result<bool, E> {
        self(text)
    }
}
pub struct V8Timestamps<R> {
    integers: timestamp::V8IntegerMode,
    local_to_utc: R,
}
impl<R> V8Timestamps<R> {
    pub fn new(integers: timestamp::V8IntegerMode, local_to_utc: R) -> Self {
        Self {
            integers,
            local_to_utc,
        }
    }
}
impl<E, R: FnMut(timestamp::LocalDateTime) -> Result<i64, E>> TimestampPolicy for V8Timestamps<R> {
    type Error = E;
    fn is_valid(&mut self, text: &[u16]) -> Result<bool, E> {
        match timestamp::parse(text, self.integers) {
            None => Ok(false),
            Some(value) => value
                .resolve(&mut self.local_to_utc)
                .map(|value| value.is_some()),
        }
    }
}

pub enum AdmissionError<E> {
    Timestamp(E),
    Invalid(ValidationReport),
}
impl<E> fmt::Debug for AdmissionError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timestamp(_) => f.write_str("TimestampServiceError"),
            Self::Invalid(report) => fmt::Debug::fmt(report, f),
        }
    }
}
impl<E> fmt::Display for AdmissionError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timestamp(_) => f.write_str("Timestamp validation service failed"),
            Self::Invalid(report) => fmt::Display::fmt(report, f),
        }
    }
}
impl<E> std::error::Error for AdmissionError<E> {}

/// An immutable candidate admitted by all graph rules and the supplied timestamp
/// policy. Clones retain the proof and fingerprint without revalidating payloads.
/// This owns no revision, subscription, asset repository, command bus or history.
#[derive(Debug, Clone)]
pub struct ValidatedProject {
    data: ProjectData,
    report: ValidationReport,
}
impl ValidatedProject {
    pub fn new<P: TimestampPolicy>(
        data: ProjectData,
        timestamps: &mut P,
    ) -> Result<Self, AdmissionError<P::Error>> {
        let report = validate_project(&data, timestamps).map_err(AdmissionError::Timestamp)?;
        if !report.is_valid() {
            return Err(AdmissionError::Invalid(report));
        }
        Ok(Self { data, report })
    }
    pub fn state(&self) -> &ProjectState {
        self.data.state()
    }
    pub fn fingerprint(&self) -> &str {
        self.data.fingerprint()
    }
    pub fn data(&self) -> &ProjectData {
        &self.data
    }
    pub fn report(&self) -> &ValidationReport {
        &self.report
    }
    pub fn to_candidate(&self) -> ProjectState {
        self.data.to_candidate()
    }
    pub fn same_allocation(&self, other: &Self) -> bool {
        self.data.same_allocation(&other.data)
    }
}
