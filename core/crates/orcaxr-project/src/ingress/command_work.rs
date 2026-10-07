//! Guarded bulk command preparation, separate from the finished session pool.
//! Uploads are explicit owners on preparation tasks. Their global permit follows
//! parsing and sealed work until admission/cancel/drop, including failed admission.
//! A guard retains immutable source state, not the live session. Hosts cancel
//! preparation tasks on lifetime changes; final admission always rechecks it.
use super::json::{JsonInput, JsonInputError, JsonLimits};
use crate::{
    clipboard::ClipboardData,
    commands::{
        IndependentObjectIds,
        staged::{CaptureError, CapturedCommand, StagedWork},
    },
    host_layout::{MAX_BUDGET, MAX_SUPPORTED_DEPTH},
    ids::*,
    model::{Decode, Number, ProjectInstance, ProjectObject, Text},
    session::{LocalGuard, ProjectSession},
    staging_layout as layout,
    validation::TimestampPolicy,
};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Debug)]
pub enum CommandInputError {
    InvalidOptions,
    InvalidShape,
    InvalidVersion,
    InvalidPhase,
    ForeignClipboard,
    Limit,
    Json(JsonInputError),
    Capture(CaptureError),
    Session(wire::SessionError),
}
impl CommandInputError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidOptions => "invalid_options",
            Self::InvalidVersion => "invalid_version",
            Self::InvalidPhase => "input_state",
            Self::ForeignClipboard => "foreign_clipboard",
            Self::Limit
            | Self::Json(JsonInputError::Limit)
            | Self::Capture(CaptureError::Limit) => "resource_limit",
            Self::Json(JsonInputError::InvalidOffset) => "invalid_offset",
            Self::Json(JsonInputError::InvalidChunk) => "invalid_chunk",
            Self::Session(wire::SessionError::Stale) => "stale",
            Self::Session(wire::SessionError::Disposed) => "disposed",
            Self::Session(wire::SessionError::ResourceLimit) => "resource_limit",
            _ => "invalid_command",
        }
    }
}
impl fmt::Display for CommandInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for CommandInputError {}

static PREPARATIONS: AtomicUsize = AtomicUsize::new(0);
struct Permit;
impl Permit {
    fn new() -> Result<Self, CommandInputError> {
        PREPARATIONS
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < layout::MAX_PREPARATIONS).then_some(n + 1)
            })
            .map_err(|_| CommandInputError::Limit)?;
        Ok(Self)
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        PREPARATIONS.fetch_sub(1, Ordering::Relaxed);
    }
}
enum State {
    Reading(JsonInput),
    Sealed(StagedWork),
    Terminal,
}
pub struct CommandUpload {
    state: State,
    guard: Option<LocalGuard>,
    limits: layout::InputOptions,
    clipboard: Option<Arc<ClipboardData>>,
    // Last: input and captured source are destroyed before freeing this permit.
    permit: Option<Permit>,
}
impl CommandUpload {
    pub fn new(
        guard: LocalGuard,
        bytes: usize,
        limits: layout::InputOptions,
    ) -> Result<Self, CommandInputError> {
        if [
            limits.bytes,
            limits.nodes,
            limits.text_units,
            limits.number_bytes,
            limits.depth,
            limits.commands,
            limits.input_units,
        ]
        .iter()
        .any(|&n| n > MAX_BUDGET)
            || limits.depth > MAX_SUPPORTED_DEPTH
            || limits.number_bytes == 0
        {
            return Err(CommandInputError::InvalidOptions);
        }
        let permit = Permit::new()?;
        let input = JsonInput::new(
            bytes,
            JsonLimits {
                max_bytes: limits.bytes,
                max_nodes: limits.nodes,
                max_text_units: limits.text_units,
                max_number_bytes: limits.number_bytes,
                max_depth: limits.depth,
            },
        )
        .map_err(CommandInputError::Json)?;
        Ok(Self {
            state: State::Reading(input),
            guard: Some(guard),
            limits,
            clipboard: None,
            permit: Some(permit),
        })
    }
    /// A clipboard copy survives source edits. Paste preparation binds a fresh
    /// destination guard and the same repository owner, without exporting bytes.
    pub fn new_clipboard<P: TimestampPolicy>(
        session: &ProjectSession<P>,
        guard: LocalGuard,
        clipboard: Arc<ClipboardData>,
        bytes: usize,
        limits: layout::InputOptions,
    ) -> Result<Self, CommandInputError> {
        if !session.is_current(&guard) {
            return Err(CommandInputError::Session(wire::SessionError::Stale));
        }
        if !session.assets().owns_selection(clipboard.assets()) {
            return Err(CommandInputError::ForeignClipboard);
        }
        let mut input = Self::new(guard, bytes, limits)?;
        input.clipboard = Some(clipboard);
        Ok(input)
    }
    pub fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), CommandInputError> {
        let State::Reading(input) = &mut self.state else {
            return Err(CommandInputError::InvalidPhase);
        };
        let result = input.append(offset, bytes);
        if matches!(result, Err(e) if !matches!(e, JsonInputError::InvalidChunk | JsonInputError::InvalidOffset))
        {
            self.cancel();
        }
        result.map_err(CommandInputError::Json)
    }
    /// Parsing finalization, typed decoding and input measurement belong on the
    /// preparation executor, never in the live authority's submission callback.
    pub fn seal(&mut self) -> Result<(), CommandInputError> {
        if !matches!(self.state, State::Reading(_)) {
            return Err(CommandInputError::InvalidPhase);
        }
        let State::Reading(input) = std::mem::replace(&mut self.state, State::Terminal) else {
            unreachable!()
        };
        let result = input
            .finish()
            .map_err(CommandInputError::Json)
            .and_then(|v| {
                work(
                    v,
                    self.limits.commands,
                    self.limits.input_units as u64,
                    self.clipboard.as_ref(),
                )
            });
        self.clipboard = None;
        match result {
            Ok(work) => {
                self.state = State::Sealed(work);
                Ok(())
            }
            Err(error) => {
                self.cancel();
                Err(error)
            }
        }
    }
    pub fn units(&self) -> Result<u64, CommandInputError> {
        match &self.state {
            State::Sealed(work) => Ok(work.units()),
            _ => Err(CommandInputError::InvalidPhase),
        }
    }
    pub fn command_count(&self) -> Result<usize, CommandInputError> {
        match &self.state {
            State::Sealed(work) => Ok(work.command_count()),
            _ => Err(CommandInputError::InvalidPhase),
        }
    }
    pub fn cancel(&mut self) {
        self.state = State::Terminal;
        self.guard = None;
        self.clipboard = None;
        self.permit = None;
    }
    /// One-use handoff. Keep the preparation permit while the destination checks
    /// the original guard and charges its finished-input pool. Every failure
    /// consumes/releases the upload too; nothing is rebased or retried.
    pub fn admit<P: TimestampPolicy>(
        mut self,
        session: &mut ProjectSession<P>,
    ) -> Result<u64, CommandInputError> {
        let State::Sealed(work) = std::mem::replace(&mut self.state, State::Terminal) else {
            return Err(CommandInputError::InvalidPhase);
        };
        session
            .stage(
                self.guard.as_ref().ok_or(CommandInputError::InvalidPhase)?,
                work,
            )
            .map_err(CommandInputError::Session)
    }
}
fn array(value: Value, length: usize) -> Result<std::vec::IntoIter<Value>, CommandInputError> {
    match value {
        Value::Array(v) if v.len() == length => Ok(v.into_iter()),
        _ => Err(CommandInputError::InvalidShape),
    }
}
fn tag(value: &Value) -> Option<usize> {
    match value {
        Value::Number(n)
            if n.is_finite() && n.fract() == 0.0 && (0.0..=MAX_BUDGET as f64).contains(n) =>
        {
            Some(*n as usize)
        }
        _ => None,
    }
}
fn decode<T: Decode>(v: Value) -> Result<T, CommandInputError> {
    T::from_value(v).map_err(|_| CommandInputError::InvalidShape)
}
fn nullable<T: Decode>(v: Value) -> Result<Option<T>, CommandInputError> {
    if matches!(v, Value::Null) {
        Ok(None)
    } else {
        decode(v).map(Some)
    }
}
fn list<T: Decode>(value: Value) -> Result<Vec<T>, CommandInputError> {
    let Value::Array(values) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    values.into_iter().map(decode).collect()
}
fn work(
    value: Value,
    max_commands: usize,
    max_units: u64,
    clipboard: Option<&Arc<ClipboardData>>,
) -> Result<StagedWork, CommandInputError> {
    let mut root = array(value, layout::ENVELOPE_LENGTH)?;
    if tag(&root.next().unwrap()) != Some(layout::VERSION) {
        return Err(CommandInputError::InvalidVersion);
    }
    let Value::Array(values) = root.next().unwrap() else {
        return Err(CommandInputError::InvalidShape);
    };
    let kind = values
        .first()
        .and_then(tag)
        .ok_or(CommandInputError::InvalidShape)?;
    match kind {
        layout::WORK_SINGLE => {
            let mut values = array(Value::Array(values), layout::WORK_SINGLE_LENGTH)?;
            values.next();
            if max_commands == 0 {
                return Err(CommandInputError::Limit);
            }
            Ok(StagedWork::single(command(
                values.next().unwrap(),
                max_units,
                clipboard,
            )?))
        }
        layout::WORK_TRANSACTION => {
            let mut values = array(Value::Array(values), layout::WORK_TRANSACTION_LENGTH)?;
            values.next();
            let label = decode::<Text>(values.next().unwrap())?;
            let Value::Array(commands) = values.next().unwrap() else {
                return Err(CommandInputError::InvalidShape);
            };
            if commands.len() > max_commands {
                return Err(CommandInputError::Limit);
            }
            let commands = commands
                .into_iter()
                .map(|v| command(v, max_units, clipboard))
                .collect::<Result<Vec<_>, _>>()?;
            StagedWork::transaction(label, commands, max_units).map_err(CommandInputError::Capture)
        }
        _ => Err(CommandInputError::InvalidShape),
    }
}
fn command(
    value: Value,
    max_units: u64,
    clipboard: Option<&Arc<ClipboardData>>,
) -> Result<CapturedCommand, CommandInputError> {
    let Value::Array(values) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    let kind = values
        .first()
        .and_then(tag)
        .ok_or(CommandInputError::InvalidShape)?;
    match kind {
        layout::COMMAND_CLIPBOARD_PASTE => {
            let clipboard = clipboard.ok_or(CommandInputError::InvalidShape)?;
            let mut v = array(Value::Array(values), layout::COMMAND_CLIPBOARD_PASTE_LENGTH)?;
            v.next();
            let ids = IndependentObjectIds {
                object_id: decode(v.next().unwrap())?,
                volume_ids: list(v.next().unwrap())?,
                instance_ids: list(v.next().unwrap())?,
                layer_range_ids: list(v.next().unwrap())?,
            };
            let destination = nullable(v.next().unwrap())?;
            CapturedCommand::clipboard_paste(clipboard.clone(), ids, destination, max_units)
                .map_err(CommandInputError::Capture)
        }
        layout::COMMAND_CREATE_INSTANCE => {
            let mut v = array(Value::Array(values), layout::COMMAND_CREATE_INSTANCE_LENGTH)?;
            v.next();
            let object = decode::<ObjectId>(v.next().unwrap())?;
            let record = Arc::new(decode::<ProjectInstance>(v.next().unwrap())?);
            let index = nullable::<Number>(v.next().unwrap())?;
            CapturedCommand::instance(object, record, index, max_units)
                .map_err(CommandInputError::Capture)
        }
        layout::COMMAND_PASTE_OBJECT => {
            let mut v = array(Value::Array(values), layout::COMMAND_PASTE_OBJECT_LENGTH)?;
            v.next();
            let template = Arc::new(decode::<ProjectObject>(v.next().unwrap())?);
            let ids = IndependentObjectIds {
                object_id: decode(v.next().unwrap())?,
                volume_ids: list(v.next().unwrap())?,
                instance_ids: list(v.next().unwrap())?,
                layer_range_ids: list(v.next().unwrap())?,
            };
            let destination = nullable(v.next().unwrap())?;
            let name = nullable(v.next().unwrap())?;
            CapturedCommand::paste(template, ids, destination, name, max_units)
                .map_err(CommandInputError::Capture)
        }
        layout::COMMAND_INTENT => {
            let mut v = array(Value::Array(values), layout::COMMAND_INTENT_LENGTH)?;
            v.next();
            let Value::String(units) = v.next().unwrap() else {
                return Err(CommandInputError::InvalidShape);
            };
            if units.len() > wire::MAX_BYTES {
                return Err(CommandInputError::Limit);
            }
            if units.iter().any(|&n| n > 127) {
                return Err(CommandInputError::InvalidShape);
            }
            let json: String = units.into_iter().map(|n| char::from(n as u8)).collect();
            CapturedCommand::intent(&json, max_units).map_err(CommandInputError::Capture)
        }
        _ => Err(CommandInputError::InvalidShape),
    }
}
