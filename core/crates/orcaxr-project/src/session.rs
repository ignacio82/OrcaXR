//! One owned canonical authority and one ordered protocol connection. Submission
//! captures bounded immutable work; the host schedules `run_next` away from its
//! UI thread. Control messages can cancel queued work without executing it.
//! Replies never carry the whole graph. Hosts must consume post-commit effects
//! before acknowledging work, including effects returned with failed commands.
mod document;
mod staging;
use crate::commands::staged::{StagedWork, WorkKind};
use crate::{
    assets::AssetRepository,
    commands::{PreparedCommand, prepare_decoded, prepare_decoded_batch},
    history::{
        CommandBus, CommandError, CommandOutcome, DomainEvent, HistoryOptions, HistorySnapshot,
    },
    ids::{AssetId, is_stable_entity_id},
    model::{Encode, SchemaVersion, Text},
    selection::{SelectionChange, SelectionRef, SelectionSnapshot, SelectionStore},
    store::{ProjectSnapshot, ProjectStore},
    validation::{TimestampPolicy, ValidatedProject},
};
pub use document::{DocumentOpen, PreparedDocument};
use orcaxr_contracts::project_intent_types as wire;
use staging::{StagedResource, StagingPool};
pub use staging::{StagingLimits, StagingUsage};
use std::{collections::VecDeque, fmt, sync::Arc};

/// Matches the current asynchronous browser authority. The generated frame
/// byte/node limits and this queue count jointly bound retained prepared input.
pub const MAX_PENDING: usize = 32;
const DISPLAY_LABEL_UNITS: usize = 256;

/// A host-local save/checkpoint guard cannot be substituted between authorities,
/// even if their generation nonces and visible snapshots happen to match.
#[derive(Clone)]
pub struct LocalGuard {
    owner: Arc<()>,
    project: ProjectSnapshot,
    assets: Text,
    history_revision: u64,
}
impl fmt::Debug for LocalGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalSessionGuard")
            .field("revision", &self.project.revision())
            .field("history_revision", &self.history_revision)
            .finish_non_exhaustive()
    }
}

/// Reply text is bounded by the generated codec. Events are immutable local
/// receipts, not a serializable graph transport or a retained callback queue.
#[must_use = "consume the ordered effects before delivering the reply"]
pub struct Response {
    wire: String,
    events: Vec<DomainEvent>,
}
impl Response {
    pub fn wire(&self) -> &str {
        &self.wire
    }
    pub fn events(&self) -> &[DomainEvent] {
        &self.events
    }
    pub fn into_parts(self) -> (String, Vec<DomainEvent>) {
        (self.wire, self.events)
    }
}
#[must_use = "deliver immediate replies or schedule queued work"]
pub enum Submission {
    Ready(Response),
    Queued { request_id: u64 },
}
enum Operation {
    Staged(StagedResource),
    Execute(PreparedCommand),
    Transaction {
        label: Text,
        commands: Vec<PreparedCommand>,
    },
    Undo,
    Redo,
    Query,
    Cancelled,
    // Constructor/guard failures settle independently of queued cancellation or
    // close, matching a rejected preparation promise in the browser endpoint.
    Rejected(wire::SessionError),
}
struct Pending {
    id: u64,
    guard: Option<wire::SessionGuard>,
    operation: Operation,
}

impl Pending {
    fn release_prepared(&mut self) {
        // Preparation has already failed independently of cancellation. Retain
        // that small error; every other request can release its captured data.
        if !matches!(self.operation, Operation::Rejected(_)) {
            self.guard = None;
            self.operation = Operation::Cancelled;
        }
    }
}

pub struct ProjectSession<P> {
    owner: Arc<()>,
    bus: CommandBus<PreparedCommand, P>,
    generation: [u32; 4],
    last_request: u64,
    ready: bool,
    disposed: bool,
    pending: VecDeque<Pending>,
    staging: StagingPool,
    open_operation: std::sync::Weak<()>,
}
impl<P: TimestampPolicy> ProjectSession<P> {
    /// The host supplies a fresh connection nonce independently of project IDs.
    /// It must not reuse that nonce for another live/reopened connection. Domain
    /// graph admission precedes this check of exact repository membership and
    /// metadata; no public asset copies or hash-only comparisons are used.
    pub fn new(
        project: ValidatedProject,
        selection: SelectionStore,
        assets: AssetRepository,
        timestamps: P,
        options: HistoryOptions,
        generation: [u32; 4],
    ) -> Result<Self, BundleError> {
        check_bundle(&project, &assets)?;
        let mut bus = CommandBus::new(
            ProjectStore::new(project),
            selection,
            assets,
            timestamps,
            options,
        );
        let checkpoint = bus.mark_checkpoint();
        checkpoint
            .result
            .expect("fresh history has checkpoint capacity");
        debug_assert!(checkpoint.events.is_empty());
        Ok(Self {
            owner: Arc::new(()),
            bus,
            generation,
            last_request: 0,
            ready: false,
            disposed: false,
            pending: VecDeque::new(),
            staging: StagingPool::default(),
            open_operation: std::sync::Weak::new(),
        })
    }
    /// Local immutable views for the host's future bounded projections. These
    /// are not a second mutation authority and are never encoded in a reply.
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.bus.snapshot()
    }
    pub fn selection(&self) -> SelectionSnapshot {
        self.bus.selection()
    }
    pub fn history(&self) -> HistorySnapshot {
        self.bus.history()
    }
    pub fn history_revision(&self) -> u64 {
        self.bus.history_revision()
    }
    pub fn assets(&self) -> &AssetRepository {
        self.bus.assets()
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn is_disposed(&self) -> bool {
        self.disposed
    }
    /// Explicit host budget for finished staged input, including queued work.
    /// Default zero disables staging. This does not budget in-flight parsing or
    /// copying before admission, nor persisted graph/history/GPU residency.
    pub fn configure_staging(&mut self, limits: StagingLimits) -> Result<(), wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        self.staging.configure(limits)
    }
    pub fn staging_usage(&self) -> StagingUsage {
        self.staging.usage()
    }
    /// Safe host cleanup after a lost connection: only unconsumed input is
    /// released. A queued/committed operation cannot be undone through this ID.
    pub fn release_staged(&mut self, id: u64) -> bool {
        self.staging.release(id)
    }
    /// The guard must be captured before asynchronous preparation. A stale or
    /// foreign owner cannot attach its work to this session, even with an equal
    /// graph and connection nonce. The generated request consumes the returned
    /// one-use ID; no full record crosses that small request envelope.
    pub fn stage(
        &mut self,
        guard: &LocalGuard,
        work: StagedWork,
    ) -> Result<u64, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !self.is_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        self.staging.stage(guard.clone(), work)
    }
    pub fn capture_guard(&self) -> Result<LocalGuard, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        Ok(LocalGuard {
            owner: self.owner.clone(),
            project: self.bus.snapshot(),
            assets: Text::from_utf8(self.bus.assets().bundle_fingerprint()),
            history_revision: self.bus.history_revision(),
        })
    }
    pub fn is_current(&self, guard: &LocalGuard) -> bool {
        self.is_export_current(guard) && guard.history_revision == self.bus.history_revision()
    }
    /// Export acknowledgement binds the saved graph/assets and local owner.
    /// A history-only change does not alter what was serialized successfully.
    pub fn is_export_current(&self, guard: &LocalGuard) -> bool {
        let now = self.bus.snapshot();
        !self.disposed
            && Arc::ptr_eq(&self.owner, &guard.owner)
            && guard.project.revision() == now.revision()
            && guard.project.hash() == now.hash()
            && guard.project.state().id == now.state().id
            && guard.assets.units().iter().copied().eq(self
                .bus
                .assets()
                .bundle_fingerprint()
                .encode_utf16())
    }
    /// Called only after the host's successful save handoff, against its captured
    /// guard. Serialization alone never acknowledges a checkpoint. The caller
    /// owns the filesystem/download completion policy and dispatches the effects.
    pub fn acknowledge_checkpoint(
        &mut self,
        guard: &LocalGuard,
    ) -> Result<Vec<DomainEvent>, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !self.is_export_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        let result = self.bus.mark_checkpoint();
        result.result.map_err(command_error)?;
        Ok(result.events)
    }
    /// Host-local selection is guard-bound to its source projection. It does not
    /// change the project/history guard, matching the canonical selection owner.
    pub fn select(
        &mut self,
        guard: &LocalGuard,
        refs: &[SelectionRef],
        primary: Option<SelectionRef>,
    ) -> Result<Option<SelectionChange>, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !self.is_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        self.bus
            .set_selection(refs, primary)
            .map_err(|_| wire::SessionError::InvalidRequest)
    }
    /// Close only the connection. Queued requests still settle as disposed;
    /// immutable assets/snapshots remain valid until their owners release them.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.open_operation = std::sync::Weak::new();
        self.staging.clear();
        for pending in &mut self.pending {
            pending.release_prepared();
        }
    }

    pub fn submit(&mut self, text: &str) -> Submission {
        let request = match wire::decode_session_request(text) {
            Ok(request) => request,
            Err(_) => {
                return Submission::Ready(self.error(
                    0,
                    self.generation_vec(),
                    wire::SessionError::InvalidRequest,
                ));
            }
        };
        let id = request.request_id;
        let generation = request.generation;
        let rejected =
            |this: &Self, error| Submission::Ready(this.error(id, generation.clone(), error));
        if !generation
            .iter()
            .copied()
            .eq(self.generation.map(u64::from))
        {
            return rejected(self, wire::SessionError::WrongSession);
        }
        if request.protocol_version != wire::SESSION_VERSION as u64 {
            return rejected(self, wire::SessionError::UnsupportedVersion);
        }
        if self.disposed {
            return rejected(self, wire::SessionError::Disposed);
        }
        if id <= self.last_request {
            return rejected(self, wire::SessionError::DuplicateRequest);
        }
        self.last_request = id;
        let operation = request.operation;
        match operation {
            wire::SessionOperation::Close(_) => {
                self.dispose();
                return Submission::Ready(self.reply(
                    id,
                    generation,
                    wire::SessionResult::Closed(wire::Empty {}),
                    vec![],
                ));
            }
            wire::SessionOperation::Hello(hello) => {
                if hello.min_protocol_version > wire::SESSION_VERSION as u64
                    || hello.max_protocol_version < wire::SESSION_VERSION as u64
                    || hello.min_protocol_version > hello.max_protocol_version
                    || hello.project_schema_version != SchemaVersion::One.number() as u64
                    || hello.intent_version != wire::VERSION as u64
                {
                    return rejected(self, wire::SessionError::UnsupportedVersion);
                }
                self.ready = true;
                return Submission::Ready(self.reply(
                    id,
                    generation,
                    wire::SessionResult::Welcome(wire::Welcome {
                        protocol_version: wire::SESSION_VERSION as u16,
                        project_schema_version: SchemaVersion::One.number() as u64,
                        intent_version: wire::VERSION as u16,
                        max_pending: MAX_PENDING as u64,
                        max_bytes: wire::MAX_BYTES as u64,
                        max_nodes: wire::MAX_NODES as u64,
                    }),
                    vec![],
                ));
            }
            _ => {}
        }
        if !self.ready {
            return rejected(self, wire::SessionError::NotReady);
        }
        if let wire::SessionOperation::Cancel(cancel) = operation {
            let pending = self
                .pending
                .iter_mut()
                .find(|p| p.id == cancel.target_request_id);
            let status = match pending {
                Some(p) => {
                    p.release_prepared();
                    wire::CancelStatus::Requested
                }
                None => wire::CancelStatus::NotPending,
            };
            return Submission::Ready(self.reply(
                id,
                generation,
                wire::SessionResult::Cancelled(status),
                vec![],
            ));
        }
        if let wire::SessionOperation::ReleaseStaged(resource) = operation {
            let released = self.staging.release(resource.staged_id);
            return Submission::Ready(self.reply(
                id,
                generation,
                wire::SessionResult::Released(released),
                vec![],
            ));
        }
        if self.pending.len() >= MAX_PENDING {
            return rejected(self, wire::SessionError::Busy);
        }
        let (guard, operation) = match operation {
            wire::SessionOperation::ExecuteStaged(resource) => (
                None,
                self.staging
                    .take(resource.staged_id)
                    .map(Operation::Staged)
                    .unwrap_or(Operation::Rejected(wire::SessionError::InvalidRequest)),
            ),
            other => prepare_operation(other),
        };
        self.pending.push_back(Pending {
            id,
            guard,
            operation,
        });
        Submission::Queued { request_id: id }
    }
    /// Run one queued operation synchronously on the host's owned worker. No
    /// reentrant host code executes within commit. A later close/cancel cannot
    /// retract this returned acknowledgement or erase already published effects.
    pub fn run_next(&mut self) -> Option<Response> {
        let pending = self.pending.pop_front()?;
        let id = pending.id;
        let generation = self.generation_vec();
        if let Operation::Rejected(error) = pending.operation {
            return Some(self.error(id, generation, error));
        }
        let refused = if self.disposed {
            Some(wire::SessionError::Disposed)
        } else if matches!(pending.operation, Operation::Cancelled) {
            Some(wire::SessionError::Cancelled)
        } else if pending
            .guard
            .as_ref()
            .is_some_and(|g| !self.matches_wire_guard(g))
            || matches!(&pending.operation, Operation::Staged(resource) if !self.is_current(&resource.guard))
        {
            Some(wire::SessionError::Stale)
        } else {
            None
        };
        if let Some(error) = refused {
            return Some(self.error(id, generation, error));
        }
        let result = match pending.operation {
            Operation::Staged(resource) => match resource.work.kind {
                WorkKind::Single(command) => self.bus.execute(command, true),
                WorkKind::Transaction { label, commands } => {
                    self.bus.execute_batch(label, commands)
                }
            },
            Operation::Execute(command) => self.bus.execute(command, true),
            Operation::Transaction { label, commands } => self.bus.execute_batch(label, commands),
            Operation::Undo => self.bus.undo(),
            Operation::Redo => self.bus.redo(),
            Operation::Query => CommandOutcome {
                result: Ok(false),
                events: vec![],
            },
            Operation::Cancelled => unreachable!("cancelled work already settled"),
            Operation::Rejected(_) => unreachable!("rejected preparation already settled"),
        };
        let reply = match result.result {
            Ok(changed) => self.acknowledgement(changed),
            Err(error) => wire::SessionResult::Error(command_error(error)),
        };
        Some(self.reply(id, generation, reply, result.events))
    }
    fn matches_wire_guard(&self, guard: &wire::SessionGuard) -> bool {
        let now = self.bus.snapshot();
        guard.project_id == now.state().id.as_utf16()
            && guard.revision == now.revision()
            && guard.history_revision == self.bus.history_revision()
            && guard
                .semantic_hash
                .iter()
                .copied()
                .eq(now.hash().encode_utf16())
            && guard.asset_fingerprint.iter().copied().eq(self
                .bus
                .assets()
                .bundle_fingerprint()
                .encode_utf16())
    }
    fn generation_vec(&self) -> wire::Generation {
        self.generation.map(u64::from).to_vec()
    }
    fn acknowledgement(&self, changed: bool) -> wire::SessionResult {
        let snapshot = self.bus.snapshot();
        // A persisted ID has no protocol length limit. Refuse the summary before
        // allocating an unbounded copy; then let generated encoding validate the
        // aggregate nodes/bytes and all narrower field bounds.
        if snapshot.state().id.as_utf16().len() > wire::MAX_NODES {
            return wire::SessionResult::ReceiptUnavailable(changed);
        }
        let history = self.bus.history();
        wire::SessionResult::Acknowledged(wire::SessionAcknowledgement {
            guard: wire::SessionGuard {
                project_id: snapshot.state().id.as_utf16().to_vec(),
                revision: snapshot.revision(),
                semantic_hash: snapshot.hash().encode_utf16().collect(),
                asset_fingerprint: self
                    .bus
                    .assets()
                    .bundle_fingerprint()
                    .encode_utf16()
                    .collect(),
                history_revision: self.bus.history_revision(),
            },
            history: wire::SessionHistory {
                undo_count: history.undo_count as u64,
                redo_count: history.redo_count as u64,
                undo_label: label(history.undo_label.as_ref()),
                redo_label: label(history.redo_label.as_ref()),
                dirty_categories: history.dirty_categories.to_vec(),
            },
            changed,
        })
    }
    fn error(&self, id: u64, generation: wire::Generation, error: wire::SessionError) -> Response {
        self.reply(id, generation, wire::SessionResult::Error(error), vec![])
    }
    fn reply(
        &self,
        id: u64,
        generation: wire::Generation,
        result: wire::SessionResult,
        events: Vec<DomainEvent>,
    ) -> Response {
        let changed = match &result {
            wire::SessionResult::Acknowledged(v) => Some(v.changed),
            _ => None,
        };
        let mut reply = wire::SessionReply {
            protocol_version: wire::SESSION_VERSION as u16,
            generation,
            request_id: id,
            result,
        };
        let text = match wire::encode_session_reply(&reply) {
            Ok(text) => text,
            Err(_) => {
                reply.result = wire::SessionResult::ReceiptUnavailable(
                    changed.expect("only an acknowledgement can exceed the response budget"),
                );
                wire::encode_session_reply(&reply).expect("bounded status reply")
            }
        };
        Response { wire: text, events }
    }
}
fn label(text: Option<&Text>) -> wire::DisplayLabel {
    wire::DisplayLabel {
        text: text
            .map(|t| {
                t.units()
                    .iter()
                    .copied()
                    .take(DISPLAY_LABEL_UNITS)
                    .collect()
            })
            .unwrap_or_default(),
        present: text.is_some(),
        truncated: text.is_some_and(|t| t.units().len() > DISPLAY_LABEL_UNITS),
    }
}
fn command_error<E>(error: CommandError<E>) -> wire::SessionError {
    match error {
        CommandError::Capacity => wire::SessionError::ResourceLimit,
        _ => wire::SessionError::CommandFailed,
    }
}
fn prepare_operation(operation: wire::SessionOperation) -> (Option<wire::SessionGuard>, Operation) {
    use wire::SessionOperation as W;
    let invalid = || {
        (
            None,
            Operation::Rejected(wire::SessionError::InvalidRequest),
        )
    };
    match operation {
        W::Execute(v) => {
            if !is_stable_entity_id(&v.guard.project_id) {
                return invalid();
            }
            match prepare_decoded(v.intent.command) {
                Ok(c) => (Some(v.guard), Operation::Execute(c)),
                Err(_) => invalid(),
            }
        }
        W::Transaction(v) => {
            if !is_stable_entity_id(&v.guard.project_id) {
                return invalid();
            }
            match prepare_decoded_batch(v.batch) {
                Ok(b) => (
                    Some(v.guard),
                    Operation::Transaction {
                        label: b.label,
                        commands: b.commands,
                    },
                ),
                Err(_) => invalid(),
            }
        }
        W::Undo(g) | W::Redo(g) if !is_stable_entity_id(&g.project_id) => invalid(),
        W::Undo(g) => (Some(g), Operation::Undo),
        W::Redo(g) => (Some(g), Operation::Redo),
        W::Query(_) => (None, Operation::Query),
        _ => unreachable!("control operations were handled before preparation"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleError {
    Missing(AssetId),
    Metadata(AssetId),
    Undeclared(AssetId),
    Encoding,
}
impl BundleError {
    pub fn user_message(&self) -> Text {
        let (prefix, id) = match self {
            Self::Missing(id) => ("Project bundle is missing source asset ", id),
            Self::Metadata(id) => ("Project bundle metadata differs for source asset ", id),
            Self::Undeclared(id) => ("Project bundle contains undeclared asset ", id),
            Self::Encoding => return Text::from_utf8("Project canonical encoding failed"),
        };
        Text::new(
            prefix
                .encode_utf16()
                .chain(id.as_utf16().iter().copied())
                .collect::<Vec<_>>(),
        )
    }
}
impl fmt::Display for BundleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for BundleError {}
fn check_bundle(project: &ValidatedProject, assets: &AssetRepository) -> Result<(), BundleError> {
    let expected = &project.state().source_assets;
    for descriptor in expected.iter() {
        let payload = assets
            .peek(&descriptor.id)
            .ok_or_else(|| BundleError::Missing(descriptor.id.clone()))?;
        if !descriptor
            .matches_value(payload.descriptor())
            .map_err(|_| BundleError::Encoding)?
        {
            return Err(BundleError::Metadata(descriptor.id.clone()));
        }
    }
    if assets.len() != expected.len() {
        let ids: std::collections::BTreeSet<_> = expected.iter().map(|d| &d.id).collect();
        if let Some(id) = assets.ids().find(|id| !ids.contains(id)) {
            return Err(BundleError::Undeclared(id.clone()));
        }
    }
    Ok(())
}
