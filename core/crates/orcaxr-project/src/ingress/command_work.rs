//! Guarded bulk command preparation, separate from the finished session pool.
//! Uploads are explicit owners on preparation tasks. Their global permit follows
//! parsing and sealed work until admission/cancel/drop, including failed admission.
//! A guard retains immutable source state, not the live session. Hosts cancel
//! preparation tasks on lifetime changes; final admission always rechecks it.
use super::json::{JsonInput, JsonInputError, JsonLimits, MAX_CHUNK_BYTES};
use crate::{
    assets::AssetPayload,
    clipboard::ClipboardData,
    commands::{
        BooleanGuard, BooleanOp, FacetRefinement, IndependentObjectIds, PartPlacement, Recipe,
        SeparatedObject, SplitPart, StagedAsset, TopologyGuard, VolumeSplitGuard,
        staged::{CaptureError, CapturedCommand, StagedWork},
    },
    host_layout::{MAX_BUDGET, MAX_SUPPORTED_DEPTH},
    ids::*,
    model::{
        Decode, EmbossSvgPart, EmbossTextConfiguration, Number, ProjectInstance, ProjectObject,
        ProjectState, ProjectVolume, SourceAssetDescriptor, Text, Transform,
    },
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
    /// A declared payload index that does not exist or is already present, or
    /// bytes that do not match their descriptor (that payload is discarded).
    InvalidAsset,
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
            Self::InvalidAsset => "invalid_asset",
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
    /// Decoded; declared payloads are still arriving.
    Awaiting(Box<Awaiting>),
    Sealed(StagedWork),
    Terminal,
}
/// One payload a command record declared by its descriptor.
struct Declared {
    descriptor: Value,
    length: usize,
    payload: Option<StagedAsset>,
}
struct Awaiting {
    plan: Plan,
    declared: Vec<Declared>,
    active: Option<(usize, Vec<u8>)>,
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
            limits.assets,
            limits.asset_bytes,
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
        let mut declarations = Declarations {
            list: Vec::new(),
            max_assets: self.limits.assets,
            max_bytes: self.limits.asset_bytes,
            total: 0,
        };
        let max_units = self.limits.input_units as u64;
        let result = input
            .finish()
            .map_err(CommandInputError::Json)
            .and_then(|v| {
                work(
                    v,
                    self.limits.commands,
                    max_units,
                    self.clipboard.as_ref(),
                    &mut declarations,
                )
            })
            .and_then(|plan| {
                if declarations.list.is_empty() {
                    plan.build(&[], max_units)
                        .map(State::Sealed)
                        .map_err(CommandInputError::Capture)
                } else {
                    Ok(State::Awaiting(Box::new(Awaiting {
                        plan,
                        declared: declarations.list,
                        active: None,
                    })))
                }
            });
        self.clipboard = None;
        match result {
            Ok(state) => {
                self.state = state;
                Ok(())
            }
            Err(error) => {
                self.cancel();
                Err(error)
            }
        }
    }
    /// Payloads the sealed records declared, in first-declaration order: none
    /// once the work is complete.
    pub fn asset_count(&self) -> Result<usize, CommandInputError> {
        match &self.state {
            State::Awaiting(awaiting) => Ok(awaiting.declared.len()),
            State::Sealed(_) => Ok(0),
            _ => Err(CommandInputError::InvalidPhase),
        }
    }
    /// Start one declared payload, returning its exact byte length. One payload
    /// is active at a time; its storage is reserved before any byte arrives.
    pub fn begin_asset(&mut self, index: usize) -> Result<usize, CommandInputError> {
        let State::Awaiting(awaiting) = &mut self.state else {
            return Err(CommandInputError::InvalidPhase);
        };
        if awaiting.active.is_some() {
            return Err(CommandInputError::InvalidPhase);
        }
        let declared = awaiting
            .declared
            .get(index)
            .filter(|d| d.payload.is_none())
            .ok_or(CommandInputError::InvalidAsset)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(declared.length)
            .map_err(|_| CommandInputError::Limit)?;
        let length = declared.length;
        awaiting.active = Some((index, bytes));
        Ok(length)
    }
    pub fn append_asset(&mut self, offset: usize, bytes: &[u8]) -> Result<(), CommandInputError> {
        let State::Awaiting(awaiting) = &mut self.state else {
            return Err(CommandInputError::InvalidPhase);
        };
        let Some((index, received)) = awaiting.active.as_mut() else {
            return Err(CommandInputError::InvalidPhase);
        };
        if offset != received.len() {
            return Err(CommandInputError::Json(JsonInputError::InvalidOffset));
        }
        let remaining = awaiting.declared[*index].length - received.len();
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES || bytes.len() > remaining {
            return Err(CommandInputError::Json(JsonInputError::InvalidChunk));
        }
        received.extend_from_slice(bytes);
        Ok(())
    }
    pub fn cancel_asset(&mut self) {
        if let State::Awaiting(awaiting) = &mut self.state {
            awaiting.active = None;
        }
    }
    /// Validate the active payload against its descriptor (a mismatch discards
    /// only that payload). The last payload completes the work: its commands are
    /// prepared here, on the preparation task, and a refusal cancels the upload.
    pub fn finish_asset(&mut self) -> Result<(), CommandInputError> {
        let State::Awaiting(awaiting) = &mut self.state else {
            return Err(CommandInputError::InvalidPhase);
        };
        let Some((index, received)) = &awaiting.active else {
            return Err(CommandInputError::InvalidPhase);
        };
        if received.len() != awaiting.declared[*index].length {
            return Err(CommandInputError::InvalidPhase);
        }
        let (index, bytes) = awaiting.active.take().expect("active payload checked");
        let declared = &mut awaiting.declared[index];
        let staged = StagedAsset::new(AssetPayload {
            descriptor: declared.descriptor.clone(),
            bytes,
        })
        .map_err(|_| CommandInputError::InvalidAsset)?;
        declared.payload = Some(staged);
        if awaiting.declared.iter().any(|d| d.payload.is_none()) {
            return Ok(());
        }
        let State::Awaiting(awaiting) = std::mem::replace(&mut self.state, State::Terminal) else {
            unreachable!()
        };
        let assets = awaiting
            .declared
            .into_iter()
            .map(|d| d.payload.expect("every payload is present"))
            .collect::<Vec<_>>();
        match awaiting.plan.build(&assets, self.limits.input_units as u64) {
            Ok(work) => {
                self.state = State::Sealed(work);
                Ok(())
            }
            Err(error) => {
                self.cancel();
                Err(CommandInputError::Capture(error))
            }
        }
    }
    pub fn units(&self) -> Result<u64, CommandInputError> {
        match &self.state {
            State::Sealed(work) => Ok(work.units()),
            _ => Err(CommandInputError::InvalidPhase),
        }
    }
    /// Payload bytes the sealed work holds (each distinct payload once).
    pub fn asset_bytes(&self) -> Result<u64, CommandInputError> {
        match &self.state {
            State::Sealed(work) => Ok(work.asset_bytes()),
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
/// Payloads declared while decoding, deduplicated by ID (one ID, one
/// descriptor), within the upload's payload count and byte budgets.
struct Declarations {
    list: Vec<Declared>,
    max_assets: usize,
    max_bytes: usize,
    total: usize,
}
impl Declarations {
    fn declare(&mut self, descriptor: Value) -> Result<usize, CommandInputError> {
        let typed = SourceAssetDescriptor::from_value(descriptor.clone())
            .map_err(|_| CommandInputError::InvalidShape)?;
        if let Some(index) = self.list.iter().position(|d| {
            matches!(&d.descriptor, Value::Object(f) if f.get(&u("id")) == Some(&Value::String(typed.id.as_utf16().to_vec())))
        }) {
            return if self.list[index].descriptor == descriptor {
                Ok(index)
            } else {
                Err(CommandInputError::InvalidShape)
            };
        }
        let length = typed.byte_length.get();
        if length.fract() != 0.0 || length < 0.0 || length > self.max_bytes as f64 {
            return Err(CommandInputError::Limit);
        }
        let length = length as usize;
        self.total = self
            .total
            .checked_add(length)
            .filter(|&total| total <= self.max_bytes)
            .ok_or(CommandInputError::Limit)?;
        if self.list.len() >= self.max_assets {
            return Err(CommandInputError::Limit);
        }
        self.list.push(Declared {
            descriptor,
            length,
            payload: None,
        });
        Ok(self.list.len() - 1)
    }
}
fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

type Build = Box<dyn FnOnce(&[StagedAsset]) -> Result<CapturedCommand, CaptureError> + Send>;
type BuildWork = Box<dyn FnOnce(&[StagedAsset], u64) -> Result<StagedWork, CaptureError> + Send>;
/// Decoded work, built once every declared payload is present.
enum Plan {
    Single(Build),
    Transaction {
        label: Text,
        commands: Vec<Build>,
    },
    /// Work that is not a list of commands: split to objects, refined facets.
    Whole(BuildWork),
}
impl Plan {
    fn build(self, assets: &[StagedAsset], max_units: u64) -> Result<StagedWork, CaptureError> {
        match self {
            Self::Single(build) => Ok(StagedWork::single(build(assets)?)),
            Self::Transaction { label, commands } => StagedWork::transaction(
                label,
                commands
                    .into_iter()
                    .map(|build| build(assets))
                    .collect::<Result<Vec<_>, _>>()?,
                max_units,
            ),
            Self::Whole(build) => build(assets, max_units),
        }
    }
}

fn work(
    value: Value,
    max_commands: usize,
    max_units: u64,
    clipboard: Option<&Arc<ClipboardData>>,
    declarations: &mut Declarations,
) -> Result<Plan, CommandInputError> {
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
            Ok(Plan::Single(command(
                values.next().unwrap(),
                max_units,
                clipboard,
                declarations,
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
                .map(|v| command(v, max_units, clipboard, declarations))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Plan::Transaction { label, commands })
        }
        layout::WORK_SPLIT_TO_OBJECTS => {
            let mut values = array(Value::Array(values), layout::WORK_SPLIT_TO_OBJECTS_LENGTH)?;
            values.next();
            if max_commands < 2 {
                return Err(CommandInputError::Limit);
            }
            let guard = split_guard(values.next().unwrap())?;
            let parts = pending_parts(values.next().unwrap(), declarations)?;
            let identities = separated(values.next().unwrap())?;
            Ok(Plan::Whole(Box::new(move |assets, max_units| {
                StagedWork::split_to_objects(
                    guard,
                    resolve_parts(parts, assets),
                    identities,
                    max_units,
                )
            })))
        }
        layout::WORK_FACET_REFINEMENT => {
            let mut values = array(Value::Array(values), layout::WORK_FACET_REFINEMENT_LENGTH)?;
            values.next();
            if max_commands == 0 {
                return Err(CommandInputError::Limit);
            }
            let mut guard = object(
                values.next().unwrap(),
                &[
                    "revision",
                    "hash",
                    "volumeId",
                    "topologyRevision",
                    "triangleCount",
                ],
            )?
            .into_iter();
            let revision = number(guard.next().unwrap())?;
            if revision < 0.0
                || revision.fract() != 0.0
                || revision > crate::store::MAX_REVISION as f64
            {
                return Err(CommandInputError::InvalidShape);
            }
            let hash = string(guard.next().unwrap())?;
            let volume = decode::<VolumeId>(guard.next().unwrap())?;
            let topology_revision = number(guard.next().unwrap())?;
            let triangle_count = number(guard.next().unwrap())?;
            let channel = string(values.next().unwrap())?;
            let channel = crate::facets::Channel::ALL
                .into_iter()
                .find(|c| c.name().encode_utf16().eq(channel.iter().copied()))
                .ok_or(CommandInputError::InvalidShape)?;
            let Value::Array(roots) = values.next().unwrap() else {
                return Err(CommandInputError::InvalidShape);
            };
            let roots = roots
                .iter()
                .map(crate::facets::Node::from_value)
                .collect::<Option<Vec<_>>>()
                .ok_or(CommandInputError::InvalidShape)?;
            let label = nullable::<Text>(values.next().unwrap())?;
            let request = FacetRefinement {
                revision: revision as u64,
                hash,
                volume,
                topology_revision,
                triangle_count,
                channel,
                roots,
                label,
            };
            Ok(Plan::Whole(Box::new(move |_, max_units| {
                StagedWork::facet_refinement(request, max_units)
            })))
        }
        _ => Err(CommandInputError::InvalidShape),
    }
}
/// A JSON object with exactly these fields, in this order.
fn object(value: Value, names: &[&str]) -> Result<Vec<Value>, CommandInputError> {
    let Value::Object(mut fields) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    if fields.len() != names.len() {
        return Err(CommandInputError::InvalidShape);
    }
    names
        .iter()
        .map(|name| {
            fields
                .remove(&u(name))
                .ok_or(CommandInputError::InvalidShape)
        })
        .collect()
}
fn string(value: Value) -> Result<Vec<u16>, CommandInputError> {
    match value {
        Value::String(units) => Ok(units),
        _ => Err(CommandInputError::InvalidShape),
    }
}
fn number(value: Value) -> Result<f64, CommandInputError> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(n),
        _ => Err(CommandInputError::InvalidShape),
    }
}
fn topology_guard(value: Value) -> Result<TopologyGuard, CommandInputError> {
    let mut v = object(
        value,
        &[
            "volumeId",
            "assetId",
            "assetDigest",
            "topologyRevision",
            "triangleCount",
        ],
    )?
    .into_iter();
    Ok(TopologyGuard {
        volume_id: string(v.next().unwrap())?,
        asset_id: string(v.next().unwrap())?,
        asset_digest: string(v.next().unwrap())?,
        topology_revision: number(v.next().unwrap())?,
        triangle_count: number(v.next().unwrap())?,
    })
}
fn boolean_guard(value: Value) -> Result<BooleanGuard, CommandInputError> {
    let mut v = object(
        value,
        &[
            "targetInstanceId",
            "targetVolumeId",
            "targetAssetId",
            "targetAssetDigest",
            "targetTopologyRevision",
            "targetTriangleCount",
            "otherInstanceId",
        ],
    )?
    .into_iter();
    Ok(BooleanGuard {
        target_instance_id: string(v.next().unwrap())?,
        target_volume_id: string(v.next().unwrap())?,
        target_asset_id: string(v.next().unwrap())?,
        target_asset_digest: string(v.next().unwrap())?,
        target_topology_revision: number(v.next().unwrap())?,
        target_triangle_count: number(v.next().unwrap())?,
        other_instance_id: string(v.next().unwrap())?,
    })
}
fn split_guard(value: Value) -> Result<VolumeSplitGuard, CommandInputError> {
    let mut v = object(
        value,
        &[
            "volumeId",
            "assetId",
            "assetDigest",
            "topologyRevision",
            "triangleCount",
            "volumeFingerprint",
        ],
    )?
    .into_iter();
    Ok(VolumeSplitGuard {
        volume_id: string(v.next().unwrap())?,
        asset_id: string(v.next().unwrap())?,
        asset_digest: string(v.next().unwrap())?,
        topology_revision: number(v.next().unwrap())?,
        triangle_count: number(v.next().unwrap())?,
        volume_fingerprint: string(v.next().unwrap())?,
    })
}
struct PendingPart {
    volume_id: Vec<u16>,
    slot: usize,
    transform: Transform,
    source_triangles: Vec<f64>,
}
fn pending_parts(
    value: Value,
    declarations: &mut Declarations,
) -> Result<Vec<PendingPart>, CommandInputError> {
    let Value::Array(parts) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    parts
        .into_iter()
        .map(|part| {
            let mut v = object(
                part,
                &[
                    "volumeId",
                    "descriptor",
                    "transform",
                    "sourceTriangleIndices",
                ],
            )?
            .into_iter();
            let volume_id = string(v.next().unwrap())?;
            let slot = declarations.declare(v.next().unwrap())?;
            let transform = decode::<Transform>(v.next().unwrap())?;
            let Value::Array(triangles) = v.next().unwrap() else {
                return Err(CommandInputError::InvalidShape);
            };
            Ok(PendingPart {
                volume_id,
                slot,
                transform,
                source_triangles: triangles
                    .into_iter()
                    .map(number)
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect()
}
fn resolve_parts(parts: Vec<PendingPart>, assets: &[StagedAsset]) -> Vec<SplitPart> {
    parts
        .into_iter()
        .map(|part| SplitPart {
            volume_id: part.volume_id,
            asset: assets[part.slot].clone(),
            transform: part.transform,
            source_triangles: part.source_triangles,
        })
        .collect()
}
fn separated(value: Value) -> Result<Vec<SeparatedObject>, CommandInputError> {
    let Value::Array(identities) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    identities
        .into_iter()
        .map(|identity| {
            let mut v =
                object(identity, &["sourceVolumeId", "objectId", "instanceIds"])?.into_iter();
            Ok(SeparatedObject {
                source_volume: decode(v.next().unwrap())?,
                object: decode(v.next().unwrap())?,
                instances: list(v.next().unwrap())?,
            })
        })
        .collect()
}
fn placement(value: Value) -> Result<PartPlacement, CommandInputError> {
    let mut v = object(value, &["objectId", "volumeId", "assetId", "transform"])?.into_iter();
    Ok(PartPlacement {
        object: decode(v.next().unwrap())?,
        volume: decode(v.next().unwrap())?,
        asset: decode(v.next().unwrap())?,
        transform: decode(v.next().unwrap())?,
    })
}
fn command(
    value: Value,
    max_units: u64,
    clipboard: Option<&Arc<ClipboardData>>,
    declarations: &mut Declarations,
) -> Result<Build, CommandInputError> {
    let Value::Array(values) = value else {
        return Err(CommandInputError::InvalidShape);
    };
    let kind = values
        .first()
        .and_then(tag)
        .ok_or(CommandInputError::InvalidShape)?;
    let fields = |length: usize| array(Value::Array(values), length);
    let build: Build = match kind {
        layout::COMMAND_CLIPBOARD_PASTE => {
            let clipboard = clipboard.ok_or(CommandInputError::InvalidShape)?.clone();
            let mut v = fields(layout::COMMAND_CLIPBOARD_PASTE_LENGTH)?;
            v.next();
            let ids = IndependentObjectIds {
                object_id: decode(v.next().unwrap())?,
                volume_ids: list(v.next().unwrap())?,
                instance_ids: list(v.next().unwrap())?,
                layer_range_ids: list(v.next().unwrap())?,
            };
            let destination = nullable(v.next().unwrap())?;
            Box::new(move |_| {
                CapturedCommand::clipboard_paste(clipboard, ids, destination, max_units)
            })
        }
        layout::COMMAND_CREATE_INSTANCE => {
            let mut v = fields(layout::COMMAND_CREATE_INSTANCE_LENGTH)?;
            v.next();
            let object = decode::<ObjectId>(v.next().unwrap())?;
            let record = Arc::new(decode::<ProjectInstance>(v.next().unwrap())?);
            let index = nullable::<Number>(v.next().unwrap())?;
            Box::new(move |_| CapturedCommand::instance(object, record, index, max_units))
        }
        layout::COMMAND_PASTE_OBJECT => {
            let mut v = fields(layout::COMMAND_PASTE_OBJECT_LENGTH)?;
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
            Box::new(move |_| CapturedCommand::paste(template, ids, destination, name, max_units))
        }
        layout::COMMAND_INTENT => {
            let mut v = fields(layout::COMMAND_INTENT_LENGTH)?;
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
            Box::new(move |_| CapturedCommand::intent(&json, max_units))
        }
        layout::COMMAND_ADD_OBJECT => {
            let mut v = fields(layout::COMMAND_ADD_OBJECT_LENGTH)?;
            v.next();
            let plate = decode::<PlateId>(v.next().unwrap())?;
            let object = Arc::new(decode::<ProjectObject>(v.next().unwrap())?);
            Box::new(move |_| CapturedCommand::add_object(plate, object, max_units))
        }
        layout::COMMAND_ADD_OBJECT_WITH_ASSET => {
            let mut v = fields(layout::COMMAND_ADD_OBJECT_WITH_ASSET_LENGTH)?;
            v.next();
            let plate = decode::<PlateId>(v.next().unwrap())?;
            let object = Arc::new(decode::<ProjectObject>(v.next().unwrap())?);
            let slot = declarations.declare(v.next().unwrap())?;
            Box::new(move |assets| {
                CapturedCommand::add_object_with_asset(
                    plate,
                    object,
                    assets[slot].clone(),
                    max_units,
                )
            })
        }
        layout::COMMAND_ADD_VOLUME => {
            let mut v = fields(layout::COMMAND_ADD_VOLUME_LENGTH)?;
            v.next();
            let object = decode::<ObjectId>(v.next().unwrap())?;
            let volume = Arc::new(decode::<ProjectVolume>(v.next().unwrap())?);
            let slot = declarations.declare(v.next().unwrap())?;
            Box::new(move |assets| {
                CapturedCommand::add_volume(object, volume, assets[slot].clone(), max_units)
            })
        }
        layout::COMMAND_REPLACE_VOLUME_MESH => {
            let mut v = fields(layout::COMMAND_REPLACE_VOLUME_MESH_LENGTH)?;
            v.next();
            let guard = topology_guard(v.next().unwrap())?;
            let slot = declarations.declare(v.next().unwrap())?;
            Box::new(move |assets| {
                CapturedCommand::replace_volume_mesh(guard, assets[slot].clone(), max_units)
            })
        }
        layout::COMMAND_MESH_BOOLEAN => {
            let mut v = fields(layout::COMMAND_MESH_BOOLEAN_LENGTH)?;
            v.next();
            let guard = boolean_guard(v.next().unwrap())?;
            let slot = declarations.declare(v.next().unwrap())?;
            let op = match string(v.next().unwrap())?.as_slice() {
                units if units == u("UNION").as_slice() => BooleanOp::Union,
                units if units == u("A_NOT_B").as_slice() => BooleanOp::ANotB,
                units if units == u("INTERSECTION").as_slice() => BooleanOp::Intersection,
                _ => return Err(CommandInputError::InvalidShape),
            };
            Box::new(move |assets| {
                CapturedCommand::mesh_boolean(guard, assets[slot].clone(), op, max_units)
            })
        }
        layout::COMMAND_SPLIT_VOLUME_TO_PARTS => {
            let mut v = fields(layout::COMMAND_SPLIT_VOLUME_TO_PARTS_LENGTH)?;
            v.next();
            let guard = split_guard(v.next().unwrap())?;
            let parts = pending_parts(v.next().unwrap(), declarations)?;
            Box::new(move |assets| {
                CapturedCommand::split_volume_to_parts(
                    guard,
                    resolve_parts(parts, assets),
                    max_units,
                )
            })
        }
        layout::COMMAND_ADD_SVG_PART => {
            let mut v = fields(layout::COMMAND_ADD_SVG_PART_LENGTH)?;
            v.next();
            let placement = placement(v.next().unwrap())?;
            let slot = declarations.declare(v.next().unwrap())?;
            let drawing = declarations.declare(v.next().unwrap())?;
            let triangles = number(v.next().unwrap())?;
            let part = Arc::new(decode::<EmbossSvgPart>(v.next().unwrap())?);
            let name = decode::<Text>(v.next().unwrap())?;
            Box::new(move |assets| {
                let recipe = Recipe::Svg {
                    drawing: Some(assets[drawing].clone()),
                    part,
                };
                CapturedCommand::add_drawn_part(
                    placement,
                    assets[slot].clone(),
                    triangles,
                    recipe,
                    Some(name),
                    max_units,
                )
            })
        }
        layout::COMMAND_EDIT_SVG_PART => {
            let mut v = fields(layout::COMMAND_EDIT_SVG_PART_LENGTH)?;
            v.next();
            let volume = decode::<VolumeId>(v.next().unwrap())?;
            let slot = declarations.declare(v.next().unwrap())?;
            let triangles = number(v.next().unwrap())?;
            let part = Arc::new(decode::<EmbossSvgPart>(v.next().unwrap())?);
            Box::new(move |assets| {
                let recipe = Recipe::Svg {
                    drawing: None,
                    part,
                };
                CapturedCommand::recut_part(
                    volume,
                    assets[slot].clone(),
                    triangles,
                    recipe,
                    max_units,
                )
            })
        }
        layout::COMMAND_ADD_EMBOSS_TEXT => {
            let mut v = fields(layout::COMMAND_ADD_EMBOSS_TEXT_LENGTH)?;
            v.next();
            let placement = placement(v.next().unwrap())?;
            let configuration = Arc::new(decode::<EmbossTextConfiguration>(v.next().unwrap())?);
            let slot = declarations.declare(v.next().unwrap())?;
            let triangles = number(v.next().unwrap())?;
            Box::new(move |assets| {
                CapturedCommand::add_drawn_part(
                    placement,
                    assets[slot].clone(),
                    triangles,
                    Recipe::Text(configuration),
                    None,
                    max_units,
                )
            })
        }
        layout::COMMAND_EDIT_EMBOSS_TEXT => {
            let mut v = fields(layout::COMMAND_EDIT_EMBOSS_TEXT_LENGTH)?;
            v.next();
            let volume = decode::<VolumeId>(v.next().unwrap())?;
            let configuration = Arc::new(decode::<EmbossTextConfiguration>(v.next().unwrap())?);
            let slot = declarations.declare(v.next().unwrap())?;
            let triangles = number(v.next().unwrap())?;
            Box::new(move |assets| {
                CapturedCommand::recut_part(
                    volume,
                    assets[slot].clone(),
                    triangles,
                    Recipe::Text(configuration),
                    max_units,
                )
            })
        }
        layout::COMMAND_REPLACE_PROJECT => {
            let mut v = fields(layout::COMMAND_REPLACE_PROJECT_LENGTH)?;
            v.next();
            let state = decode::<ProjectState>(v.next().unwrap())?;
            let label = nullable::<Text>(v.next().unwrap())?;
            Box::new(move |_| CapturedCommand::replace_project(state, label, max_units))
        }
        _ => return Err(CommandInputError::InvalidShape),
    };
    Ok(build)
}
