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

/// Why an import commit was refused before anything changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportCommitError {
    Disposed,
    Confirmation(crate::import::ConfirmError),
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
    render: crate::render::RenderFeed,
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
            render: crate::render::RenderFeed::default(),
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
    /// Open a paint stroke on the state `guard` captured, which must still be
    /// current. The stroke samples off the authority and stages its commit
    /// under the same guard ([`Self::stage_paint_stroke`]).
    pub fn paint_stroke(
        &self,
        guard: &LocalGuard,
        request: &wire::PaintStrokeOpen,
    ) -> Result<crate::facets::paint_stroke::PaintStroke, crate::facets::paint_stroke::Refusal>
    {
        use crate::facets::paint_stroke::{PaintStroke, Refusal};
        if self.disposed {
            return Err(Refusal::Disposed);
        }
        if !self.is_current(guard) {
            return Err(Refusal::Stale);
        }
        let mut stroke = PaintStroke::open(&guard.project, self.bus.assets(), request)?;
        stroke.session_guard = Some(guard.clone());
        Ok(stroke)
    }
    /// Prepare one volume's split on the state `guard` captured, which must
    /// still be current: its parts and geometries, or the workspace's refusal
    /// ([`crate::split::VolumeSplit::reply`]). The split stages under the
    /// same guard ([`Self::stage_volume_split`]).
    pub fn volume_split(
        &self,
        guard: &LocalGuard,
        request: &wire::VolumeSplitRequest,
    ) -> Result<crate::split::VolumeSplit, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !self.is_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        let mut split = crate::split::prepare(guard.project.state(), self.bus.assets(), request);
        split.session_guard = Some(guard.clone());
        Ok(split)
    }
    /// Stage a session-prepared split under the host's IDs (`VolumeSplitStage`)
    /// as one edit: parts of the source's object or, with object identities,
    /// one object per part. Staging refuses as stale once anything changed
    /// since the split was prepared, before its names are read; a refused
    /// split or bad names refuse as an invalid request.
    pub fn stage_volume_split(
        &mut self,
        split: &crate::split::VolumeSplit,
        request: &wire::VolumeSplitStage,
    ) -> Result<u64, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        let guard = split
            .session_guard
            .as_ref()
            .ok_or(wire::SessionError::InvalidRequest)?;
        if !self.is_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        let work = split
            .work(
                self.bus.snapshot().state(),
                self.bus.assets(),
                request,
                self.staging.max_units(),
            )
            .map_err(|error| match error {
                crate::split::StageError::Limit => wire::SessionError::ResourceLimit,
                crate::split::StageError::Invalid => wire::SessionError::InvalidRequest,
            })?;
        self.stage(guard, work)
    }
    /// The transforms one placement edit submits, planned from the
    /// acknowledged state (`PlacementRequest` → `PlacementReply`).
    pub fn plan_placement(
        &self,
        request: &wire::PlacementRequest,
    ) -> Result<wire::PlacementReply, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        Ok(crate::placement::reply(
            self.bus.snapshot().state(),
            self.bus.assets(),
            request,
        ))
    }
    /// The plate's wipe tower, auto-placed from the acknowledged state
    /// (`WipeTowerRequest` → `WipeTowerReply`).
    pub fn plan_wipe_tower(
        &self,
        request: &wire::WipeTowerRequest,
    ) -> Result<wire::WipeTowerReply, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        Ok(crate::placement::wipe_tower::plan(
            self.bus.snapshot().state(),
            self.bus.assets(),
            request,
        ))
    }
    /// One plate's arrangement, planned from the acknowledged state
    /// (`ArrangeRequest` → `ArrangeReply`).
    pub fn plan_arrangement(
        &self,
        request: &wire::ArrangeRequest,
    ) -> Result<wire::ArrangeReply, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        Ok(crate::placement::arrange::arrange(
            self.bus.snapshot().state(),
            self.bus.assets(),
            request,
        ))
    }
    /// Copies of one instance laid into a plate's free space
    /// (`BedFillRequest` → `BedFillReply`).
    pub fn plan_bed_fill(
        &self,
        request: &wire::BedFillRequest,
    ) -> Result<wire::BedFillReply, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        Ok(crate::placement::arrange::fill(
            self.bus.snapshot().state(),
            self.bus.assets(),
            request,
        ))
    }
    /// One plate's volumes captured for picking from the acknowledged state;
    /// the scene owns its meshes, so picks run off the session.
    pub fn pick_scene(
        &self,
        request: &wire::PickSceneRequest,
    ) -> Result<crate::picking::PickScene, crate::picking::Refusal> {
        if self.disposed {
            return Err(crate::picking::Refusal::Disposed);
        }
        crate::picking::PickScene::capture(&self.bus.snapshot(), self.bus.assets(), request)
    }
    /// The canonical paint overlay of one volume's channel, drawn from the
    /// acknowledged state; the capture owns its facets and packets.
    pub fn paint_overlay(
        &self,
        request: &wire::PaintOverlayRequest,
    ) -> Result<crate::facets::overlay::Overlay, crate::facets::overlay::Refusal> {
        if self.disposed {
            return Err(crate::facets::overlay::Refusal::Disposed);
        }
        crate::facets::overlay::capture(&self.bus.snapshot(), self.bus.assets(), request)
    }
    /// Stage a session-opened stroke's whole gesture as one edit; `None` when
    /// it touched no facet. Staging refuses as stale once anything changed
    /// since the stroke opened, and the work's facet guard refuses it again
    /// when it runs.
    pub fn stage_paint_stroke(
        &mut self,
        stroke: &crate::facets::paint_stroke::PaintStroke,
        label: Option<Vec<u16>>,
    ) -> Result<Option<u64>, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        let guard = stroke
            .session_guard
            .as_ref()
            .ok_or(wire::SessionError::InvalidRequest)?;
        if !self.is_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        let work = stroke
            .work(label, self.staging.max_units())
            .map_err(|error| match error {
                crate::commands::staged::CaptureError::Limit => wire::SessionError::ResourceLimit,
                _ => wire::SessionError::InvalidRequest,
            })?;
        match work {
            Some(work) => self.stage(guard, work).map(Some),
            None => Ok(None),
        }
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
    /// Commit a previewed import after the browser's confirmation checks, as one
    /// undoable `Import <filename>` entry. `guard` was captured with the base the
    /// preview was prepared from; history-only changes do not make it stale.
    pub fn commit_import(
        &mut self,
        guard: &LocalGuard,
        prepared: crate::import::Prepared,
        acknowledged: &[Vec<u16>],
    ) -> Result<CommandOutcome<P::Error>, ImportCommitError> {
        if self.disposed {
            return Err(ImportCommitError::Disposed);
        }
        crate::import::check_confirmation(&prepared, acknowledged, self.is_export_current(guard))
            .map_err(ImportCommitError::Confirmation)?;
        let (project, payloads, label) = crate::import::into_commit(prepared).ok_or(
            ImportCommitError::Confirmation(crate::import::ConfirmError::Blocked),
        )?;
        Ok(self.bus.execute(
            PreparedCommand::import(Text::new(label), project, payloads),
            false,
        ))
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
        self.render.clear();
        for pending in &mut self.pending {
            pending.release_prepared();
        }
    }
    /// A page of the renderer deltas from the snapshot a host shows to its
    /// target, over acknowledged state only (`render`).
    pub fn render_page(
        &mut self,
        request: &wire::RenderRequest,
    ) -> Result<wire::RenderPage, crate::render::Refusal> {
        if self.disposed {
            return Err(crate::render::Refusal::Disposed);
        }
        let current = self.bus.snapshot();
        self.render.page(&current, request)
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
                WorkKind::FacetRefinement(request) => {
                    match crate::commands::prepare_facet_refinement(&self.bus.snapshot(), *request)
                    {
                        Ok(Some(command)) => self.bus.execute(command, false),
                        Ok(None) => CommandOutcome {
                            result: Ok(false),
                            events: vec![],
                        },
                        Err(error) => CommandOutcome {
                            result: Err(CommandError::Domain(error.user_message())),
                            events: vec![],
                        },
                    }
                }
                // Its checks refuse against the live state without publishing.
                WorkKind::SplitToObjects(work) => match work.prepare(self.bus.snapshot().state()) {
                    Ok(batch) => self.bus.execute_batch(batch.label, batch.commands),
                    Err(error) => CommandOutcome {
                        result: Err(CommandError::Domain(error.user_message())),
                        events: vec![],
                    },
                },
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
