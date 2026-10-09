//! `PrinterSessionController.ts`: the one owner of a selected printer and of
//! every query, subscription and command in its session.
//!
//! Like `workflow`, it is an effect machine, but with several operations in
//! flight at once: refreshes (asked for, or started by the session itself
//! when it connects or the job changes), connects, and commands. Each runs
//! as a task; every input answers a step naming the effects issued (open a
//! transport, connect, a request, a recovery command, a confirmation
//! dialog), those withdrawn, transports to close, epochs that ended, tasks
//! started and finished, and how many times the session changed.
//!
//! An epoch is the session's abort scope, and equals its generation: every
//! printer switch, reconnect, socket replacement or clear ends one. Its
//! requests and dialogs are withdrawn at once (a request fails as
//! `cancelled`, as the transport fails it) and hosts stop the matching work;
//! a lease captured in it is no longer current.
//!
//! Tasks are polled when their awaited effect settles, in the order the
//! effects settle, and a task the session starts is polled at once, before
//! anything else: what the browser runs synchronously up to its first
//! `await` runs here before any other continuation.
use crate::{
    control::{self, Command, moonraker_message},
    status::{JobStatus, LIMITS, QUERY_PATH, is_active},
};
use orcaxr_contracts::{
    canonical::{Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::convert::{encode_uri_component, trim_utf16};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll, Waker},
};
use wire::{ConnectionStatus as Status, PrintJobCommandErrorCode as Code};

const IDENTITY_HELP: &str = "Cannot identify the running job. Enable Moonraker history and file metadata, then reconnect to refresh the printer status.";
const VERIFYING: &str =
    "Verifying the current printer job. Wait for the status refresh before trying again.";
const CHANGED_DURING_REFRESH: &str = "The printer changed during status refresh.";

/// Why a call was not accepted. Nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No effect with that id is waiting for an answer.
    NotPending,
    /// The outcome does not answer that kind of effect.
    Mismatch,
    /// The session was disposed.
    Disposed,
    /// A clock that is not finite, or notification params that are not JSON.
    InvalidRequest,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::NotPending => "not_pending",
            Refusal::Mismatch => "mismatch",
            Refusal::Disposed => "disposed",
            Refusal::InvalidRequest => "invalid_request",
        }
    }
}

fn t(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn field<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(fields)) => fields.get(&t(name)),
        _ => None,
    }
}
fn record(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| matches!(v, Value::Object(_)))
}
fn text_of(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}
fn optional(text: Option<Vec<u16>>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn refusal(code: Code, message: &str) -> wire::PrintJobCommandRefusal {
    wire::PrintJobCommandRefusal {
        code,
        message: t(message),
    }
}
fn raw(failure: &wire::TransportFailure) -> Vec<u16> {
    t(match failure.code {
        wire::OptionalMoonrakerErrorCode::Value(code) => moonraker_message(code),
        wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
    })
}
/// A command by its wire name (`pause`, `emergencyStop`, …).
pub fn command_named(name: &str) -> Option<Command> {
    Some(match name {
        "pause" => Command::Pause,
        "resume" => Command::Resume,
        "cancel" => Command::Cancel,
        "emergencyStop" => Command::EmergencyStop,
        "firmwareRestart" => Command::FirmwareRestart,
        _ => return None,
    })
}
fn recovery(command: Command) -> bool {
    matches!(command, Command::EmergencyStop | Command::FirmwareRestart)
}

// --- Effects and tasks ---------------------------------------------------------------------

enum Answer {
    State(wire::ConnectionSignal),
    Connected,
    Reply {
        value: Value,
        now: f64,
    },
    Failed(wire::TransportFailure),
    Confirmed(bool),
    /// A dialog whose epoch ended: `Session changed.`
    Withdrawn,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Open,
    Connect,
    Transport,
    Confirm,
}
fn kind(effect: &wire::PrinterSessionEffect) -> Kind {
    use wire::PrinterSessionEffect as E;
    match effect {
        E::OpenTransport(_) => Kind::Open,
        E::Connect(_) => Kind::Connect,
        E::Request(_) | E::Recovery(_) => Kind::Transport,
        E::ConfirmCommand(_) => Kind::Confirm,
    }
}
fn effect_epoch(effect: &wire::PrinterSessionEffect) -> Option<u64> {
    use wire::PrinterSessionEffect as E;
    match effect {
        E::Request(request) => Some(request.epoch),
        E::Recovery(recovery) => Some(recovery.epoch),
        _ => None,
    }
}
fn answers(kind: Kind, answer: &Answer) -> bool {
    match answer {
        Answer::State(_) => kind == Kind::Open,
        Answer::Connected => kind == Kind::Connect,
        Answer::Failed(_) => kind == Kind::Connect || kind == Kind::Transport,
        Answer::Reply { .. } => kind == Kind::Transport,
        Answer::Confirmed(_) => kind == Kind::Confirm,
        Answer::Withdrawn => false,
    }
}

struct Pending {
    kind: Kind,
    /// The epoch whose end withdraws it (requests, recovery commands, dialogs).
    epoch: Option<u64>,
    owner: u64,
    answer: Option<Answer>,
}

type Task = Pin<Box<dyn Future<Output = wire::PrinterTaskResult> + Send>>;
type Model = Arc<Mutex<JobStatus>>;
fn lock<T>(shared: &Mutex<T>) -> MutexGuard<'_, T> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The controller's fields, and the step being gathered.
struct Shared {
    selected: Option<wire::PrinterSelection>,
    transport: Option<u64>,
    generation: u64,
    epoch: u64,
    model: Model,
    snapshot: Option<wire::PrintJobSnapshot>,
    identity: Option<wire::PrintJobIdentity>,
    state: Option<wire::ConnectionSignal>,
    refresh_sequence: u64,
    observation_version: u64,
    status_verified: bool,
    identity_failure: &'static str,
    ordinary_busy: Option<u64>,
    recovery_busy: BTreeMap<u8, u64>,
    intents: BTreeMap<u64, wire::PrintJobCommandIntent>,
    consumed: BTreeSet<u64>,
    /// Live confirmation tokens, each for one intent.
    confirmations: BTreeMap<u64, u64>,
    disposed: bool,

    next_intent: u64,
    next_token: u64,
    next_transport: u64,
    next_effect: u64,
    next_task: u64,
    next_key: u64,
    pending: BTreeMap<u64, Pending>,
    /// Tasks started and not yet polled, polled before anything else.
    spawned: VecDeque<(u64, Task)>,
    /// Tasks whose effect settled, in the order they settled.
    ready: VecDeque<u64>,
    current: u64,
    reported: BTreeMap<u64, u64>,

    changed: u64,
    issued: Vec<wire::PrinterSessionPendingEffect>,
    withdrawn: Vec<u64>,
    closed: Vec<u64>,
    aborted: Vec<u64>,
    task: Option<u64>,
    finished: Vec<wire::PrinterTaskFinished>,
}

fn command_key(command: Command) -> u8 {
    match command {
        Command::Pause => 0,
        Command::Resume => 1,
        Command::Cancel => 2,
        Command::EmergencyStop => 3,
        Command::FirmwareRestart => 4,
    }
}
fn connected(s: &Shared) -> bool {
    s.state
        .as_ref()
        .is_some_and(|state| state.status == Status::Connected)
}
fn emit(s: &mut Shared) {
    // `dispose` drops every listener.
    if !s.disposed {
        s.changed += 1;
    }
}
fn settle(s: &mut Shared, id: u64, answer: Answer) {
    if let Some(pending) = s.pending.get_mut(&id) {
        pending.answer = Some(answer);
        let owner = pending.owner;
        s.ready.push_back(owner);
    }
}
/// End the epoch: what it carried is withdrawn, and everything bound to the
/// old reading is forgotten.
fn invalidate(s: &mut Shared) {
    let ended = s.epoch;
    s.aborted.push(ended);
    let carried: Vec<(u64, Kind)> = s
        .pending
        .iter()
        .filter(|(_, p)| p.epoch == Some(ended) && p.answer.is_none())
        .map(|(id, p)| (*id, p.kind))
        .collect();
    for (id, kind) in carried {
        s.withdrawn.push(id);
        let answer = if kind == Kind::Confirm {
            Answer::Withdrawn
        } else {
            Answer::Failed(wire::TransportFailure {
                code: wire::OptionalMoonrakerErrorCode::Value(wire::MoonrakerErrorCode::Cancelled),
                http_status: wire::OptionalFinite::Absent(wire::Empty {}),
                detail: wire::OptionalText::Absent(wire::Empty {}),
            })
        };
        settle(s, id, answer);
    }
    s.epoch += 1;
    s.generation += 1;
    s.refresh_sequence += 1;
    s.identity = None;
    s.status_verified = false;
    s.ordinary_busy = None;
    s.recovery_busy.clear();
    lock(&s.model).reset();
}
fn clear(s: &mut Shared) {
    invalidate(s);
    if let Some(transport) = s.transport.take() {
        s.closed.push(transport);
    }
    s.selected = None;
    s.state = None;
    s.snapshot = None;
    lock(&s.model).reset();
    emit(s);
}

/// One effect: issued on its first poll, ready once answered or withdrawn.
struct Ask {
    shared: Arc<Mutex<Shared>>,
    effect: Option<wire::PrinterSessionEffect>,
    id: u64,
}
impl Future for Ask {
    type Output = Answer;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Answer> {
        let this = &mut *self;
        let mut s = lock(&this.shared);
        if let Some(effect) = this.effect.take() {
            s.next_effect += 1;
            this.id = s.next_effect;
            let pending = Pending {
                kind: kind(&effect),
                epoch: match &effect {
                    wire::PrinterSessionEffect::ConfirmCommand(_) => Some(s.epoch),
                    other => effect_epoch(other),
                },
                owner: s.current,
                answer: None,
            };
            s.issued.push(wire::PrinterSessionPendingEffect {
                id: this.id,
                effect,
            });
            s.pending.insert(this.id, pending);
            return Poll::Pending;
        }
        if s.pending.get(&this.id).is_some_and(|p| p.answer.is_some())
            && let Some(Pending {
                answer: Some(answer),
                ..
            }) = s.pending.remove(&this.id)
        {
            return Poll::Ready(answer);
        }
        Poll::Pending
    }
}

#[derive(Clone)]
struct Flow(Arc<Mutex<Shared>>);
impl Flow {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        lock(&self.0)
    }
    fn ask(&self, effect: wire::PrinterSessionEffect) -> Ask {
        Ask {
            shared: self.0.clone(),
            effect: Some(effect),
            id: 0,
        }
    }
    /// Start a task; a host's task is reported when it finishes.
    fn spawn(&self, task: Task, reported: bool) {
        let mut s = self.lock();
        s.next_key += 1;
        let key = s.next_key;
        if reported {
            s.next_task += 1;
            let id = s.next_task;
            s.reported.insert(key, id);
            s.task = Some(id);
        }
        s.spawned.push_back((key, task));
    }
    /// `refreshInBackground`.
    fn refresh_in_background(&self) {
        if connected(&self.lock()) {
            let flow = self.clone();
            self.spawn(
                Box::pin(async move {
                    match refresh(&flow).await {
                        Ok(()) => done(),
                        Err(message) => failed(message),
                    }
                }),
                false,
            );
        }
    }
}
fn done() -> wire::PrinterTaskResult {
    wire::PrinterTaskResult::Done(wire::Empty {})
}
fn failed(message: Vec<u16>) -> wire::PrinterTaskResult {
    wire::PrinterTaskResult::Failed(wire::PrinterText { text: message })
}

// --- Readings --------------------------------------------------------------------------------

fn same_job_state(a: Option<&wire::PrintJobSnapshot>, b: &wire::PrintJobSnapshot) -> bool {
    a.is_some_and(|a| {
        a.state == b.state
            && a.filename == b.filename
            && a.klippy_state == b.klippy_state
            && a.virtual_sd_active == b.virtual_sd_active
    })
}
fn same_identity(a: Option<&wire::PrintJobIdentity>, b: Option<&wire::PrintJobIdentity>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            a.job_id == b.job_id
                && a.started_at == b.started_at
                && a.filename == b.filename
                && a.size == b.size
                && a.modified == b.modified
        }
        _ => false,
    }
}
fn positive(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() && *n > 0.0 => Some(*n),
        _ => None,
    }
}
/// `readIdentity`: the running file's metadata names its job, start and size.
fn read_identity(value: &Value, filename: &[u16]) -> Option<wire::PrintJobIdentity> {
    let value = record(Some(value))?;
    if !matches!(field(Some(value), "filename"), Some(Value::String(f)) if f == filename) {
        return None;
    }
    let Some(Value::String(job_id)) = field(Some(value), "job_id") else {
        return None;
    };
    if trim_utf16(job_id).is_empty() {
        return None;
    }
    let started_at = positive(field(Some(value), "print_start_time"))?;
    let modified = positive(field(Some(value), "modified"))?;
    let size = match field(Some(value), "size") {
        Some(Value::Number(n))
            if n.trunc() == *n && n.abs() <= 9_007_199_254_740_991.0 && *n > 0.0 =>
        {
            *n
        }
        _ => return None,
    };
    Some(wire::PrintJobIdentity {
        job_id: job_id.clone(),
        started_at,
        filename: filename.to_vec(),
        size,
        modified,
    })
}
fn uri(units: &[u16]) -> Result<String, Vec<u16>> {
    encode_uri_component(units).map_err(|_| t("URI malformed"))
}

struct Reply {
    value: Value,
    now: f64,
}
struct Fresh {
    model: Model,
    snapshot: wire::PrintJobSnapshot,
    identity: Option<wire::PrintJobIdentity>,
}

/// What `readAuthoritative` captured and re-checks before every request.
struct Reading {
    transport: Option<u64>,
    generation: u64,
    version: u64,
    epoch: u64,
}
impl Reading {
    fn current(&self, flow: &Flow) -> Result<u64, Vec<u16>> {
        let s = flow.lock();
        match self.transport {
            Some(transport)
                if self.epoch == s.epoch
                    && s.generation == self.generation
                    && s.observation_version == self.version
                    && connected(&s) =>
            {
                Ok(transport)
            }
            _ => Err(t(CHANGED_DURING_REFRESH)),
        }
    }
    async fn request(&self, flow: &Flow, path: String) -> Result<Reply, Vec<u16>> {
        let transport = self.current(flow)?;
        let send = wire::PrinterSend {
            path: t(&path),
            method: t("GET"),
            operation: t("print_job_identity"),
            timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
        };
        match flow
            .ask(wire::PrinterSessionEffect::Request(
                wire::PrinterSessionRequest {
                    transport,
                    epoch: self.epoch,
                    send,
                },
            ))
            .await
        {
            Answer::Reply { value, now } => Ok(Reply { value, now }),
            Answer::Failed(failure) => Err(raw(&failure)),
            _ => unreachable!("resolve admits only a reply or failure for a request"),
        }
    }
}

/// `readAuthoritative`: one full query, and for a running job its identity
/// from metadata and history, bracketed by a second metadata read and query
/// so a replacement during the read cannot combine an old row with a new
/// file. `reading` is the refresh that publishes the first query at once.
async fn read_authoritative(
    flow: &Flow,
    epoch: u64,
    reading: Option<u64>,
) -> Result<Fresh, Vec<u16>> {
    let guard = {
        let s = flow.lock();
        Reading {
            transport: s.transport,
            generation: s.generation,
            version: s.observation_version,
            epoch,
        }
    };
    guard.current(flow)?;
    let model: Model = Arc::new(Mutex::new(JobStatus::new()));
    let reply = guard.request(flow, QUERY_PATH.to_owned()).await?;
    let snapshot = lock(&model)
        .apply_query_value(&reply.value, reply.now)
        .clone();
    guard.current(flow)?;
    if let Some(sequence) = reading {
        let mut s = flow.lock();
        if sequence == s.refresh_sequence && epoch == s.epoch {
            if !same_job_state(s.snapshot.as_ref(), &snapshot) {
                s.status_verified = false;
                s.identity = None;
            }
            s.model = model.clone();
            s.snapshot = Some(snapshot.clone());
            emit(&mut s);
        }
    }
    if snapshot.state == wire::PrintJobState::Unknown
        || text_of(&snapshot.klippy_state).is_none()
        || matches!(snapshot.virtual_sd_active, wire::OptionalFlag::Absent(_))
    {
        return Err(t("The printer did not report complete readiness data."));
    }
    if !is_active(snapshot.state) {
        return Ok(Fresh {
            model,
            snapshot,
            identity: None,
        });
    }
    let filename = match text_of(&snapshot.filename) {
        Some(filename) if !filename.is_empty() => filename.to_vec(),
        _ => return Err(t(IDENTITY_HELP)),
    };
    let metadata_path = format!("/server/files/metadata?filename={}", uri(&filename)?);
    let metadata = guard.request(flow, metadata_path.clone()).await?;
    let identity = read_identity(&metadata.value, &filename).ok_or_else(|| t(IDENTITY_HELP))?;
    let history_path = format!("/server/history/job?uid={}", uri(&identity.job_id)?);
    let history = guard.request(flow, history_path).await?;
    let job = record(field(record(Some(&history.value)), "job"));
    let string_is = |name, expected: &[u16]| matches!(field(job, name), Some(Value::String(s)) if s == expected);
    if !(job.is_some()
        && string_is("job_id", &identity.job_id)
        && string_is("filename", &identity.filename)
        && matches!(field(job, "start_time"), Some(Value::Number(n)) if *n == identity.started_at)
        && string_is("status", &t("in_progress"))
        && matches!(field(job, "end_time"), Some(Value::Null))
        && matches!(field(job, "exists"), Some(Value::Bool(true))))
    {
        return Err(t(IDENTITY_HELP));
    }
    let final_metadata = read_identity(&guard.request(flow, metadata_path).await?.value, &filename);
    let final_reply = guard.request(flow, QUERY_PATH.to_owned()).await?;
    let final_snapshot = lock(&model)
        .apply_query_value(&final_reply.value, final_reply.now)
        .clone();
    guard.current(flow)?;
    if !same_identity(Some(&identity), final_metadata.as_ref())
        || !same_job_state(Some(&snapshot), &final_snapshot)
    {
        return Err(t(IDENTITY_HELP));
    }
    Ok(Fresh {
        model,
        snapshot: final_snapshot,
        identity: Some(identity),
    })
}

/// `refresh`: explicit refreshes fail closed, and a superseded one publishes
/// nothing.
async fn refresh(flow: &Flow) -> Result<(), Vec<u16>> {
    let (sequence, epoch) = {
        let mut s = flow.lock();
        s.refresh_sequence += 1;
        (s.refresh_sequence, s.epoch)
    };
    match read_authoritative(flow, epoch, Some(sequence)).await {
        Ok(fresh) => {
            let mut s = flow.lock();
            if sequence != s.refresh_sequence || epoch != s.epoch {
                return Ok(());
            }
            s.model = fresh.model;
            s.snapshot = Some(fresh.snapshot);
            s.identity = fresh.identity;
            s.status_verified = true;
            emit(&mut s);
            Ok(())
        }
        Err(message) => {
            let mut s = flow.lock();
            if sequence == s.refresh_sequence && epoch == s.epoch {
                s.status_verified = false;
                s.identity = None;
                s.identity_failure = IDENTITY_HELP;
                emit(&mut s);
            }
            Err(message)
        }
    }
}

async fn connect(flow: Flow) -> wire::PrinterTaskResult {
    let Some(transport) = flow.lock().transport else {
        return failed(t("Select a printer first."));
    };
    match flow
        .ask(wire::PrinterSessionEffect::Connect(
            wire::PrinterTransportRef { transport },
        ))
        .await
    {
        Answer::Connected => {}
        Answer::Failed(failure) => return failed(raw(&failure)),
        _ => unreachable!("resolve admits only a connection or failure for a connect"),
    }
    let changed = || failed(t("The selected printer changed during connection."));
    if flow.lock().transport != Some(transport) {
        return changed();
    }
    // Also repairs a failed status or identity read while HTTP and the socket
    // stayed connected: pressing Reconnect must refresh those too.
    if !flow.lock().status_verified {
        let _ = refresh(&flow).await;
    }
    if flow.lock().transport != Some(transport) {
        return changed();
    }
    done()
}

/// What `select` does once the host opened the transport: subscribe, and
/// take its state as the first reading.
async fn open(flow: Flow, selection: wire::PrinterSelection) -> wire::PrinterTaskResult {
    let transport = {
        let mut s = flow.lock();
        s.next_transport += 1;
        s.next_transport
    };
    let Answer::State(state) = flow
        .ask(wire::PrinterSessionEffect::OpenTransport(
            wire::PrinterTransportOpen {
                transport,
                selection,
            },
        ))
        .await
    else {
        unreachable!("resolve admits only a state for an opened transport");
    };
    flow.lock().transport = Some(transport);
    transport_state(&flow, state);
    done()
}

/// The transport's state listener.
fn transport_state(flow: &Flow, state: wire::ConnectionSignal) {
    let refresh = {
        let mut s = flow.lock();
        let previous = s.state.clone();
        let changed = match &previous {
            None => true,
            Some(p) => {
                p.status != state.status
                    || p.generation != state.generation
                    || (p.status == Status::Connected
                        && state.status == Status::Connected
                        && p.socket_epoch != state.socket_epoch)
            }
        };
        if changed {
            invalidate(&mut s);
        }
        let was_connected = previous.is_some_and(|p| p.status == Status::Connected);
        let now_connected = state.status == Status::Connected;
        s.state = Some(state);
        emit(&mut s);
        now_connected && !was_connected
    };
    if refresh {
        flow.refresh_in_background();
    }
}

/// The transport's notification listener.
fn notification(flow: &Flow, method: &str, params: &Value, now: f64) {
    if method == "notify_history_changed" {
        {
            let mut s = flow.lock();
            s.identity = None;
            s.observation_version += 1;
            emit(&mut s);
        }
        flow.refresh_in_background();
    }
    let changed = {
        let mut s = flow.lock();
        if method != "notify_status_update" || !connected(&s) {
            return;
        }
        let before = s.snapshot.clone();
        let Some(next) = lock(&s.model.clone())
            .apply_notification_value(params, now)
            .cloned()
        else {
            return;
        };
        let changed = !same_job_state(before.as_ref(), &next)
            || matches!(
                (&next.total_duration_s, before.as_ref().map(|b| &b.total_duration_s)),
                (
                    wire::OptionalFinite::Value(after),
                    Some(wire::OptionalFinite::Value(earlier))
                ) if after < earlier
            );
        s.snapshot = Some(next);
        if changed {
            s.identity = None;
            s.observation_version += 1;
        }
        emit(&mut s);
        changed
    };
    if changed {
        flow.refresh_in_background();
    }
}

// --- Commands ------------------------------------------------------------------------------

enum Fail {
    Command(wire::PrintJobCommandRefusal),
    Other,
}
fn assert_session(
    s: &Shared,
    intent: &wire::PrintJobCommandIntent,
) -> Result<(), wire::PrintJobCommandRefusal> {
    let current = !s.disposed
        && s.transport.is_some()
        && s.selected
            .as_ref()
            .is_some_and(|selected| selected.id == intent.printer_id)
        && intent.generation == s.generation;
    if current {
        Ok(())
    } else {
        Err(refusal(
            Code::SessionChanged,
            "The selected printer or connection changed. Review it and confirm again.",
        ))
    }
}
fn assert_intent(
    s: &Shared,
    id: u64,
) -> Result<wire::PrintJobCommandIntent, wire::PrintJobCommandRefusal> {
    match s.intents.get(&id) {
        Some(intent) if !s.consumed.contains(&id) => {
            assert_session(s, intent)?;
            Ok(intent.clone())
        }
        _ => Err(refusal(
            Code::NotAllowed,
            "This command intent is invalid or was already used.",
        )),
    }
}

async fn execute(flow: Flow, request: wire::PrintJobExecuteRequest) -> wire::PrinterTaskResult {
    let (intent, transport, epoch) = {
        let mut s = flow.lock();
        let intent = match assert_intent(&s, request.intent) {
            Ok(intent) => intent,
            Err(refused) => return wire::PrinterTaskResult::Refused(refused),
        };
        let busy = if recovery(intent.command) {
            s.recovery_busy.contains_key(&command_key(intent.command))
        } else {
            s.ordinary_busy.is_some()
        };
        if busy {
            return wire::PrinterTaskResult::Refused(refusal(
                Code::Busy,
                "A printer command is already pending; nothing else was sent.",
            ));
        }
        s.consumed.insert(request.intent);
        if recovery(intent.command) {
            s.recovery_busy
                .insert(command_key(intent.command), request.intent);
        } else {
            s.ordinary_busy = Some(request.intent);
        }
        let transport = s.transport.unwrap_or_default();
        let epoch = s.epoch;
        emit(&mut s);
        (intent, transport, epoch)
    };
    let mut queried = false;
    let outcome = send(
        &flow,
        &intent,
        &request.confirmation,
        transport,
        epoch,
        &mut queried,
    )
    .await;
    let result = match outcome {
        Ok(()) => done(),
        Err(Fail::Command(refused)) => wire::PrinterTaskResult::Refused(refused),
        Err(Fail::Other) if flow.lock().epoch != epoch => {
            wire::PrinterTaskResult::Refused(refusal(
                Code::SessionChanged,
                "The printer session changed; refresh before trying again.",
            ))
        }
        Err(Fail::Other) => wire::PrinterTaskResult::Refused(refusal(
            Code::RequestFailed,
            "The printer command could not be verified. Refresh the printer status before trying again; the request will not be retried automatically.",
        )),
    };
    let aborted = {
        let mut s = flow.lock();
        let aborted = s.epoch != epoch;
        if queried && !aborted {
            // A completed command or rejected identity leaves the old reading
            // unfit for another gesture until the replacement refresh ends.
            s.refresh_sequence += 1;
            s.status_verified = false;
            s.identity = None;
            s.identity_failure = VERIFYING;
        }
        let key = command_key(intent.command);
        if recovery(intent.command) && s.recovery_busy.get(&key) == Some(&request.intent) {
            s.recovery_busy.remove(&key);
        }
        if s.ordinary_busy == Some(request.intent) {
            s.ordinary_busy = None;
        }
        emit(&mut s);
        aborted
    };
    if !aborted {
        flow.refresh_in_background();
    }
    result
}

async fn send(
    flow: &Flow,
    intent: &wire::PrintJobCommandIntent,
    confirmation: &wire::PrintJobExecuteConfirmation,
    transport: u64,
    epoch: u64,
    queried: &mut bool,
) -> Result<(), Fail> {
    let session = |flow: &Flow| assert_session(&flow.lock(), intent).map_err(Fail::Command);
    if !matches!(intent.command, Command::Pause | Command::Resume) {
        match confirmation {
            wire::PrintJobExecuteConfirmation::Dialog(_) => {
                match flow
                    .ask(wire::PrinterSessionEffect::ConfirmCommand(intent.clone()))
                    .await
                {
                    Answer::Confirmed(true) => {}
                    Answer::Confirmed(false) => {
                        return Err(Fail::Command(refusal(
                            Code::Cancelled,
                            "Command dismissed; nothing was sent.",
                        )));
                    }
                    _ => return Err(Fail::Other),
                }
            }
            wire::PrintJobExecuteConfirmation::Token(token) => {
                let mut s = flow.lock();
                // A token spends only on its own intent.
                if s.confirmations.get(token) == Some(&intent.id) {
                    s.confirmations.remove(token);
                } else {
                    return Err(Fail::Command(confirmation_required()));
                }
            }
            wire::PrintJobExecuteConfirmation::None(_) => {
                return Err(Fail::Command(confirmation_required()));
            }
        }
    }
    session(flow)?;
    if recovery(intent.command) {
        match flow
            .ask(wire::PrinterSessionEffect::Recovery(
                wire::PrinterSessionRecovery {
                    transport,
                    epoch,
                    command: intent.command,
                },
            ))
            .await
        {
            Answer::Reply { .. } => {}
            _ => return Err(Fail::Other),
        }
    } else {
        *queried = true;
        let fresh = read_authoritative(flow, epoch, None)
            .await
            .map_err(|_| Fail::Other)?;
        session(flow)?;
        if !same_identity(
            match &intent.job {
                wire::OptionalPrintJobIdentity::Value(job) => Some(job),
                wire::OptionalPrintJobIdentity::Absent(_) => None,
            },
            fresh.identity.as_ref(),
        ) || intent.displayed_filename != fresh.snapshot.filename
        {
            return Err(Fail::Command(refusal(
                Code::JobChanged,
                "The running job changed after you chose this command. Review the current job and try again.",
            )));
        }
        let plan = control::plan(&wire::PrintJobCommandCheckRequest {
            command: intent.command,
            observed: wire::OptionalPrintJobSnapshot::Value(fresh.snapshot),
            expected_filename: intent.displayed_filename.clone(),
        });
        let send = match plan {
            wire::PrintJobCommandPlan::Send(send) => send,
            wire::PrintJobCommandPlan::Refused(refused) => return Err(Fail::Command(refused)),
        };
        let answer = flow
            .ask(wire::PrinterSessionEffect::Request(
                wire::PrinterSessionRequest {
                    transport,
                    epoch,
                    send: wire::PrinterSend {
                        path: send.path,
                        method: send.method,
                        operation: send.operation,
                        timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
                    },
                },
            ))
            .await;
        if let Answer::Failed(failure) = answer {
            let cancelled = flow.lock().epoch != epoch;
            return Err(Fail::Command(control::failure(
                &wire::PrintJobCommandFailureRequest {
                    command: intent.command,
                    transport_code: failure.code,
                    cancelled,
                },
            )));
        }
    }
    session(flow)
}
fn confirmation_required() -> wire::PrintJobCommandRefusal {
    refusal(
        Code::ConfirmationRequired,
        "Confirm this exact printer command first.",
    )
}

// --- The session --------------------------------------------------------------------------------

/// `PrinterSessionController`.
pub struct PrinterSession {
    shared: Arc<Mutex<Shared>>,
    tasks: BTreeMap<u64, Task>,
}
impl Default for PrinterSession {
    fn default() -> Self {
        Self::new()
    }
}
impl PrinterSession {
    pub fn new() -> Self {
        PrinterSession {
            shared: Arc::new(Mutex::new(Shared {
                selected: None,
                transport: None,
                generation: 0,
                epoch: 0,
                model: Arc::new(Mutex::new(JobStatus::new())),
                snapshot: None,
                identity: None,
                state: None,
                refresh_sequence: 0,
                observation_version: 0,
                status_verified: false,
                identity_failure: IDENTITY_HELP,
                ordinary_busy: None,
                recovery_busy: BTreeMap::new(),
                intents: BTreeMap::new(),
                consumed: BTreeSet::new(),
                confirmations: BTreeMap::new(),
                disposed: false,
                next_intent: 0,
                next_token: 0,
                next_transport: 0,
                next_effect: 0,
                next_task: 0,
                next_key: 0,
                pending: BTreeMap::new(),
                spawned: VecDeque::new(),
                ready: VecDeque::new(),
                current: 0,
                reported: BTreeMap::new(),
                changed: 0,
                issued: Vec::new(),
                withdrawn: Vec::new(),
                closed: Vec::new(),
                aborted: Vec::new(),
                task: None,
                finished: Vec::new(),
            })),
            tasks: BTreeMap::new(),
        }
    }
    fn flow(&self) -> Flow {
        Flow(self.shared.clone())
    }

    /// Choose a printer. The same selection keeps its transport; any other
    /// clears the session and opens a transport for it.
    pub fn select(
        &mut self,
        selection: wire::PrinterSelection,
    ) -> Result<wire::PrinterSessionStep, Refusal> {
        {
            let mut s = lock(&self.shared);
            if s.disposed {
                return Err(Refusal::Disposed);
            }
            let same = s.transport.is_some()
                && s.selected.as_ref().is_some_and(|previous| {
                    previous.id == selection.id
                        && previous.endpoint == selection.endpoint
                        && previous.port == selection.port
                        && previous.api_key == selection.api_key
                });
            if same {
                drop(s);
                return Ok(self.step());
            }
            clear(&mut s);
            s.selected = Some(selection.clone());
        }
        let flow = self.flow();
        let opening = flow.clone();
        flow.spawn(Box::pin(open(opening, selection)), false);
        Ok(self.advance())
    }
    pub fn clear(&mut self) -> wire::PrinterSessionStep {
        clear(&mut lock(&self.shared));
        self.advance()
    }
    pub fn dispose(&mut self) -> wire::PrinterSessionStep {
        {
            let mut s = lock(&self.shared);
            clear(&mut s);
            s.disposed = true;
        }
        self.advance()
    }
    pub fn connect(&mut self) -> wire::PrinterSessionStep {
        let flow = self.flow();
        flow.spawn(Box::pin(connect(flow.clone())), true);
        self.advance()
    }
    pub fn refresh(&mut self) -> wire::PrinterSessionStep {
        let flow = self.flow();
        let refreshing = flow.clone();
        flow.spawn(
            Box::pin(async move {
                match refresh(&refreshing).await {
                    Ok(()) => done(),
                    Err(message) => failed(message),
                }
            }),
            true,
        );
        self.advance()
    }
    /// Run a captured intent, with its confirmation.
    pub fn execute(&mut self, request: wire::PrintJobExecuteRequest) -> wire::PrinterSessionStep {
        let flow = self.flow();
        flow.spawn(Box::pin(execute(flow.clone(), request)), true);
        self.advance()
    }
    /// A transport's state changed; any but the current transport's is ignored.
    pub fn transport_state(
        &mut self,
        transport: u64,
        state: wire::ConnectionSignal,
    ) -> wire::PrinterSessionStep {
        let flow = self.flow();
        if flow.lock().transport == Some(transport) {
            transport_state(&flow, state);
        }
        self.advance()
    }
    /// A notification the transport received: its method and params (JSON),
    /// at the host's `now`.
    pub fn notification(
        &mut self,
        transport: u64,
        method: &str,
        params: &str,
        now: f64,
    ) -> Result<wire::PrinterSessionStep, Refusal> {
        if !now.is_finite() {
            return Err(Refusal::InvalidRequest);
        }
        let params = parse_javascript(params, LIMITS).map_err(|_| Refusal::InvalidRequest)?;
        let flow = self.flow();
        if flow.lock().transport == Some(transport) {
            notification(&flow, method, &params, now);
        }
        Ok(self.advance())
    }
    pub fn resolve(
        &mut self,
        id: u64,
        outcome: wire::PrinterSessionOutcome,
    ) -> Result<wire::PrinterSessionStep, Refusal> {
        use wire::PrinterSessionOutcome as O;
        self.answer(
            id,
            match outcome {
                O::State(state) => Answer::State(state),
                O::Connected(_) => Answer::Connected,
                O::Failed(failure) => Answer::Failed(failure),
                O::Confirmed(confirmed) => Answer::Confirmed(confirmed),
            },
        )
    }
    /// A request's reply (Moonraker's `result`, as JSON) received at `now`;
    /// text that is not JSON is the transport's `invalid_response`.
    pub fn resolve_reply(
        &mut self,
        id: u64,
        text: &str,
        now: f64,
    ) -> Result<wire::PrinterSessionStep, Refusal> {
        if !now.is_finite() {
            return Err(Refusal::InvalidRequest);
        }
        self.answer(
            id,
            match parse_javascript(text, LIMITS) {
                Ok(value) => Answer::Reply { value, now },
                Err(_) => Answer::Failed(wire::TransportFailure {
                    code: wire::OptionalMoonrakerErrorCode::Value(
                        wire::MoonrakerErrorCode::InvalidResponse,
                    ),
                    http_status: wire::OptionalFinite::Absent(wire::Empty {}),
                    detail: wire::OptionalText::Absent(wire::Empty {}),
                }),
            },
        )
    }
    fn answer(&mut self, id: u64, answer: Answer) -> Result<wire::PrinterSessionStep, Refusal> {
        {
            let mut s = lock(&self.shared);
            let Some(pending) = s.pending.get(&id) else {
                return Err(Refusal::NotPending);
            };
            if pending.answer.is_some() {
                return Err(Refusal::NotPending);
            }
            if !answers(pending.kind, &answer) {
                return Err(Refusal::Mismatch);
            }
            let (kind, owner) = (pending.kind, pending.owner);
            settle(&mut s, id, answer);
            if kind == Kind::Open {
                // The browser opens a transport synchronously inside `select`:
                // what it does with the answer comes before anything else.
                s.ready.retain(|key| *key != owner);
                s.ready.push_front(owner);
            }
        }
        Ok(self.advance())
    }

    // --- Queries ----------------------------------------------------------------------------

    pub fn generation(&self) -> u64 {
        lock(&self.shared).generation
    }
    pub fn snapshot(&self) -> Option<wire::PrintJobSnapshot> {
        lock(&self.shared).snapshot.clone()
    }
    /// The commands the session would accept now, each with the reason it
    /// would not.
    pub fn availability(&self) -> Vec<wire::PrintJobCommandDescriptor> {
        availability(&lock(&self.shared))
    }
    pub fn view(&self) -> wire::PrinterSessionView {
        let s = lock(&self.shared);
        wire::PrinterSessionView {
            generation: s.generation,
            snapshot: match &s.snapshot {
                Some(snapshot) => wire::OptionalPrintJobSnapshot::Value(snapshot.clone()),
                None => wire::OptionalPrintJobSnapshot::Absent(wire::Empty {}),
            },
            availability: availability(&s),
        }
    }
    /// `captureIntent`: bound, at press time, to this printer, generation and
    /// running job.
    pub fn capture_intent(&mut self, command: Command) -> wire::PrintJobIntentReply {
        let mut s = lock(&self.shared);
        let action = availability(&s).into_iter().find(|a| a.command == command);
        let Some(selected) = s.selected.clone() else {
            return wire::PrintJobIntentReply::Refused(refusal(
                Code::NotAllowed,
                "Select a printer first.",
            ));
        };
        match action {
            Some(action) if action.allowed => {}
            action => {
                return wire::PrintJobIntentReply::Refused(wire::PrintJobCommandRefusal {
                    code: Code::NotAllowed,
                    message: action
                        .and_then(|a| text_of(&a.reason).map(<[u16]>::to_vec))
                        .unwrap_or_else(|| t("Select a printer first.")),
                });
            }
        }
        s.next_intent += 1;
        let intent = wire::PrintJobCommandIntent {
            id: s.next_intent,
            printer_id: selected.id.clone(),
            printer_label: text_of(&selected.name)
                .map_or_else(|| selected.endpoint.clone(), <[u16]>::to_vec),
            generation: s.generation,
            command,
            displayed_filename: optional(
                s.snapshot
                    .as_ref()
                    .and_then(|snapshot| text_of(&snapshot.filename))
                    .filter(|f| !f.is_empty())
                    .map(<[u16]>::to_vec),
            ),
            observed_state: s
                .snapshot
                .as_ref()
                .map_or(wire::PrintJobState::Unknown, |snapshot| snapshot.state),
            job: match (&s.identity, recovery(command)) {
                (Some(identity), false) => wire::OptionalPrintJobIdentity::Value(identity.clone()),
                _ => wire::OptionalPrintJobIdentity::Absent(wire::Empty {}),
            },
        };
        s.intents.insert(intent.id, intent.clone());
        wire::PrintJobIntentReply::Intent(intent)
    }
    /// `confirm`: a single-use token for exactly this intent.
    pub fn confirm(&mut self, intent: u64) -> wire::PrintJobConfirmReply {
        let mut s = lock(&self.shared);
        if let Err(refused) = assert_intent(&s, intent) {
            return wire::PrintJobConfirmReply::Refused(refused);
        }
        s.next_token += 1;
        let token = s.next_token;
        s.confirmations.insert(token, intent);
        wire::PrintJobConfirmReply::Token(token)
    }
    /// `captureLease`: what a send binds to.
    pub fn capture_lease(&self) -> wire::PrinterSessionLeaseReply {
        let s = lock(&self.shared);
        match (&s.selected, s.transport) {
            (Some(selected), Some(transport)) if connected(&s) => {
                wire::PrinterSessionLeaseReply::Lease(wire::PrinterSessionLease {
                    printer_id: selected.id.clone(),
                    label: text_of(&selected.name)
                        .map_or_else(|| selected.endpoint.clone(), <[u16]>::to_vec),
                    generation: s.generation,
                    transport,
                })
            }
            _ => wire::PrinterSessionLeaseReply::Refused(wire::PrinterText {
                text: t("Connect to the selected printer first."),
            }),
        }
    }
    /// A lease's `assertCurrent`, as a flag.
    pub fn lease_current(&self, lease: &wire::PrinterSessionLease) -> bool {
        let s = lock(&self.shared);
        !s.disposed
            && s.transport == Some(lease.transport)
            && s.generation == lease.generation
            && connected(&s)
    }

    // --- The executor -----------------------------------------------------------------------

    /// Poll started tasks first, then woken ones in the order they woke,
    /// until every task waits on an effect.
    fn advance(&mut self) -> wire::PrinterSessionStep {
        loop {
            let next = {
                let mut s = lock(&self.shared);
                // Nothing else runs while a transport is being opened.
                if s.pending
                    .values()
                    .any(|p| p.kind == Kind::Open && p.answer.is_none())
                {
                    break;
                }
                match s.spawned.pop_front() {
                    Some((key, task)) => Some((key, Some(task))),
                    None => s.ready.pop_front().map(|key| (key, None)),
                }
            };
            let Some((key, started)) = next else {
                break;
            };
            if let Some(task) = started {
                self.tasks.insert(key, task);
            }
            let Some(task) = self.tasks.get_mut(&key) else {
                continue;
            };
            lock(&self.shared).current = key;
            let poll = task.as_mut().poll(&mut Context::from_waker(Waker::noop()));
            if let Poll::Ready(result) = poll {
                self.tasks.remove(&key);
                let mut s = lock(&self.shared);
                if let Some(task) = s.reported.remove(&key) {
                    s.finished.push(wire::PrinterTaskFinished { task, result });
                }
            }
        }
        self.step()
    }
    fn step(&self) -> wire::PrinterSessionStep {
        let mut s = lock(&self.shared);
        let mut finished = std::mem::take(&mut s.finished);
        finished.sort_by_key(|f| f.task);
        wire::PrinterSessionStep {
            changed: std::mem::take(&mut s.changed),
            effects: std::mem::take(&mut s.issued),
            withdrawn: std::mem::take(&mut s.withdrawn),
            closed: std::mem::take(&mut s.closed),
            aborted: std::mem::take(&mut s.aborted),
            task: match s.task.take() {
                Some(task) => wire::OptionalCounter::Value(task),
                None => wire::OptionalCounter::Absent(wire::Empty {}),
            },
            finished,
        }
    }
}

/// `availability`: the reported state's commands, held back while a command
/// is pending, the connection is down, or the running job is unidentified.
fn availability(s: &Shared) -> Vec<wire::PrintJobCommandDescriptor> {
    control::availability(s.snapshot.as_ref())
        .into_iter()
        .map(|action| {
            let reason = if s.selected.is_none() {
                Some("Select a printer first.")
            } else if recovery(action.command) {
                s.recovery_busy
                    .contains_key(&command_key(action.command))
                    .then_some("This recovery command is already pending.")
            } else if s.ordinary_busy.is_some() {
                Some("A printer command is already pending.")
            } else if !connected(s) {
                Some("Reconnect to refresh the printer status.")
            } else if !s.status_verified || s.identity.is_none() {
                Some(s.identity_failure)
            } else {
                None
            };
            match reason {
                Some(reason) => wire::PrintJobCommandDescriptor {
                    allowed: false,
                    reason: wire::OptionalText::Value(t(reason)),
                    ..action
                },
                None => action,
            }
        })
        .collect()
}
