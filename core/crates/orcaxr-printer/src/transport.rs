//! `MoonrakerTransport.ts`: the connection to one Moonraker, as an effect
//! machine. The host performs the I/O — HTTP requests and their bodies, one
//! WebSocket at a time, timers — and the machine decides everything else:
//! the REST handshake before any socket, the socket's identify and object
//! subscription, heartbeats and their deadline, reconnects with jittered
//! backoff until the policy is exhausted, request deadlines that grow with a
//! body's declared length, the bounds on what a reply may be, and which
//! failures abort what.
//!
//! Each input answers a `MoonrakerTransportStep`: its outputs in order
//! (requests and body reads to perform, a socket to open, frames to send,
//! sockets to close, timers to arm, state transitions, notifications, and
//! the two questions asked synchronously — a socket and a random number),
//! the timers cleared, the requests and body reads aborted (fail them; never
//! answer them), diagnostics, the task the input started and the tasks that
//! finished. A socket or a random number is answered before anything else.
use crate::moonraker::{self, Credentials, fault, safe_operation_name};
use orcaxr_contracts::{
    canonical::{JsonLimits, Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::convert::{json_stringify, utf16_number};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll, Waker},
};
use url::Url;
use wire::{
    ConnectionStatus as Status, MoonrakerErrorCode as Code, MoonrakerTransportFault as Fault,
};

const MAX_JSON_RESPONSE: usize = 2 * 1024 * 1024;
/// Text a host received past this many UTF-16 units decides every outcome
/// by its length alone: a reply is refused unread, a socket frame ignored,
/// and a refused response's detail reads only its first 2,048 units. A host
/// may pass just the first `MAX_TEXT_UNITS + 1` units of such text.
pub const MAX_TEXT_UNITS: usize = MAX_JSON_RESPONSE;
const _: () = assert!(MAX_SOCKET_MESSAGE <= MAX_TEXT_UNITS && 2048 < MAX_TEXT_UNITS);
const MAX_DOWNLOAD: f64 = 256.0 * 1024.0 * 1024.0;
const MINIMUM_TRANSFER_BYTES_PER_SECOND: f64 = 256.0 * 1024.0;
const MAXIMUM_REQUEST_DEADLINE_MS: f64 = 60.0 * 60_000.0;
const MAX_SOCKET_MESSAGE: usize = 1024 * 1024;
/// Requests in flight at once: it bounds what one step reports when a
/// session ends with all of them.
const MAX_ACTIVE_REQUESTS: usize = 512;
const MAX_PROTOCOL_OBJECTS: usize = 20_000;
const INTERNAL: u64 = 1 << 52;
/// Replies and frames are bounded above; the parser's bounds sit past them.
const LIMITS: JsonLimits = JsonLimits {
    bytes: 8 * 1024 * 1024,
    nodes: 4_000_000,
    depth: 512,
};

fn t(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn utf16(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}
fn read_text(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}
fn read_finite(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(value) => Some(*value),
        wire::OptionalFinite::Absent(_) => None,
    }
}
fn lock<T>(shared: &Mutex<T>) -> MutexGuard<'_, T> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}
fn refuse(code: Code, operation: &str) -> Fault {
    fault(code, operation, None, None, None)
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&t(name)),
        _ => None,
    }
}
fn status_of(state: &wire::MoonrakerConnectionState) -> Status {
    use wire::MoonrakerConnectionState as S;
    match state {
        S::Disconnected(_) => Status::Disconnected,
        S::Connecting(_) => Status::Connecting,
        S::Connected(_) => Status::Connected,
        S::Reconnecting(_) => Status::Reconnecting,
        S::Error(_) => Status::Error,
    }
}

/// Why `resolve` did not take an answer. Nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Nothing awaits that effect id (never issued, answered, or aborted).
    NotPending,
    /// The answer is of another kind than the effect awaits.
    Mismatch,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::NotPending => "not_pending",
            Refusal::Mismatch => "mismatch",
        }
    }
}

// --- Configuration ---------------------------------------------------------------------------------

struct Config {
    http: String,
    socket_url: String,
    same_origin: bool,
    request_timeout_ms: f64,
    socket_open_timeout_ms: f64,
    heartbeat_interval_ms: f64,
    heartbeat_timeout_ms: f64,
    reconnect: wire::MoonrakerReconnectPolicy,
    version: ([f64; 3], f64),
    client_name: String,
    client_version: String,
}
/// `positiveDuration`: a configured patience, within five minutes.
fn positive_duration(value: &wire::OptionalFinite, fallback: f64) -> Result<f64, Fault> {
    match read_finite(value) {
        None => Ok(fallback),
        Some(v) if v > 0.0 && v <= 300_000.0 => Ok(v.floor()),
        Some(_) => Err(refuse(Code::InvalidRequest, "configure_transport")),
    }
}
/// `safeClientField`.
fn client_field(value: &wire::OptionalText, fallback: &str) -> String {
    let Some(value) = read_text(value) else {
        return fallback.to_owned();
    };
    let ok = (1..=64).contains(&value.len())
        && value.iter().all(|&u| {
            u < 0x80 && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b' ' | b'.' | b'_' | b'-')
        });
    if ok {
        utf16(value)
    } else {
        fallback.to_owned()
    }
}
fn config(input: &wire::MoonrakerTransportConfig) -> Result<Config, Fault> {
    let endpoint = moonraker::endpoint(&wire::MoonrakerEndpointRequest {
        input: input.endpoint.clone(),
        default_port: input.default_port.clone(),
        same_origin_proxy: input.same_origin_proxy.clone(),
        page_origin: input.page_origin.clone(),
    })?;
    let request_timeout_ms = positive_duration(&input.request_timeout_ms, 10_000.0)?;
    let socket_open_timeout_ms = positive_duration(&input.socket_open_timeout_ms, 8_000.0)?;
    let heartbeat_interval_ms = positive_duration(&input.heartbeat_interval_ms, 15_000.0)?;
    let heartbeat_timeout_ms = positive_duration(&input.heartbeat_timeout_ms, 5_000.0)?;
    let reconnect = match moonraker::reconnect_policy(&input.reconnect) {
        wire::MoonrakerReconnectPolicyReply::Policy(policy) => policy,
        wire::MoonrakerReconnectPolicyReply::Refused(fault) => return Err(fault),
    };
    let version = moonraker::version_policy(&input.version_policy)?;
    Ok(Config {
        http: utf16(&endpoint.transport_http_url),
        socket_url: utf16(&endpoint.web_socket_url),
        same_origin: endpoint.uses_same_origin_proxy,
        request_timeout_ms,
        socket_open_timeout_ms,
        heartbeat_interval_ms,
        heartbeat_timeout_ms,
        reconnect,
        version,
        client_name: client_field(&input.client_name, "OrcaXR"),
        client_version: client_field(&input.client_version, "0.1.0"),
    })
}

// --- Effects, signals and tasks ----------------------------------------------------------------

enum Answer {
    Headers {
        status: f64,
        content_length: Option<Vec<u16>>,
    },
    Failed,
    Aborted,
    Text(String),
    Bytes(f64),
    Created,
    Unavailable,
    Broken,
    Random(f64),
    /// An internal wait: the socket opened, or why it did not.
    Opened(Result<(), Fault>),
    /// An internal wait: a promise another task settles.
    Settled(Result<Reply, Fault>),
}
#[derive(Clone)]
enum Reply {
    Handshake(wire::MoonrakerHandshake),
    Value(Value),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Fetch,
    /// A body read as text, answered by `resolve_text`.
    Text,
    /// A body read as bytes, answered by its length.
    Bytes,
    Socket,
    Random,
    Internal,
}
struct Pending {
    kind: Kind,
    owner: u64,
    answer: Option<Answer>,
}

enum Listener {
    /// `controller.abort()` for a request.
    Abort(u64),
    /// `connect`'s `onExternalAbort`.
    External { session: u64 },
    /// `openSocket`'s `onAbort`.
    SocketOpen { waiter: u64 },
    /// The request or body read a request's own signal carries.
    Effect(u64),
}
#[derive(Default)]
struct Signal {
    aborted: bool,
    listeners: Vec<(u64, Listener)>,
}
enum Timer {
    Request(u64),
    SocketOpen(u64),
    Heartbeat {
        session: u64,
        epoch: u64,
    },
    HeartbeatTimeout {
        session: u64,
        epoch: u64,
        socket: u64,
        id: String,
    },
    Reconnect {
        session: u64,
    },
}
#[derive(Default)]
struct Request {
    timed_out: bool,
}
enum Handlers {
    None,
    Opening {
        waiter: u64,
        timeout: u64,
        signal: Option<(u64, u64)>,
    },
    Live {
        session: u64,
        epoch: u64,
    },
}
struct Socket {
    ready_state: u8,
    handlers: Handlers,
}
struct PromiseSlot {
    result: Option<Result<Reply, Fault>>,
    /// When it settled, among all promises: `Promise.all` rejects with the
    /// first rejection to settle.
    order: u64,
    waiters: Vec<u64>,
}

type Task = Pin<Box<dyn Future<Output = wire::MoonrakerTaskResult> + Send>>;

struct Shared {
    config: Config,
    credentials: Credentials,
    state: wire::MoonrakerConnectionState,
    generation: u64,
    socket_epoch: u64,
    desired: bool,
    disposed: bool,
    listening: bool,
    /// Result texts by the executor key that produced them, until the task
    /// is reported; then by task id until the host takes them.
    produced: BTreeMap<u64, String>,
    results: BTreeMap<u64, String>,
    /// Notification params by notification id, until the host takes them.
    params: BTreeMap<u64, String>,
    next_notification: u64,
    session_controller: Option<u64>,
    connect_promise: Option<u64>,
    socket: Option<u64>,
    reconnect_attempt: f64,
    reconnect_timer: Option<u64>,
    heartbeat_timer: Option<u64>,
    heartbeat_timeout_timer: Option<u64>,
    heartbeat_request: Option<String>,
    rpc_sequence: u64,
    subscription: Option<Vec<wire::MoonrakerSubscriptionEntry>>,
    active: Vec<u64>,
    now: f64,

    signals: BTreeMap<u64, Signal>,
    timers: BTreeMap<u64, Timer>,
    requests: BTreeMap<u64, Request>,
    sockets: BTreeMap<u64, Socket>,
    promises: BTreeMap<u64, PromiseSlot>,
    pending: BTreeMap<u64, Pending>,
    task_signals: BTreeMap<u64, u64>,
    spawned: VecDeque<(u64, Task)>,
    ready: VecDeque<u64>,
    current: u64,
    reported: BTreeMap<u64, u64>,
    next_effect: u64,
    next_timer: u64,
    next_task: u64,
    next_key: u64,
    next_internal: u64,

    outputs: Vec<wire::MoonrakerTransportOutput>,
    cleared: Vec<u64>,
    aborted: Vec<u64>,
    logs: Vec<wire::MoonrakerLog>,
    finished: Vec<wire::MoonrakerTaskFinished>,
    task: Option<u64>,
}

impl Shared {
    fn signal(&mut self) -> u64 {
        self.next_internal += 1;
        let id = self.next_internal;
        self.signals.insert(id, Signal::default());
        id
    }
    fn listen(&mut self, signal: u64, listener: Listener) -> u64 {
        self.next_internal += 1;
        let id = self.next_internal;
        if let Some(s) = self.signals.get_mut(&signal) {
            s.listeners.push((id, listener));
        }
        id
    }
    fn unlisten(&mut self, signal: u64, listener: u64) {
        if let Some(s) = self.signals.get_mut(&signal) {
            s.listeners.retain(|(id, _)| *id != listener);
        }
    }
    fn aborted(&self, signal: u64) -> bool {
        self.signals.get(&signal).is_some_and(|s| s.aborted)
    }
    /// `AbortController.abort()`: listeners fire once, in the order they
    /// were added.
    fn abort(&mut self, signal: u64) {
        let listeners = match self.signals.get_mut(&signal) {
            Some(s) if !s.aborted => {
                s.aborted = true;
                std::mem::take(&mut s.listeners)
            }
            _ => return,
        };
        for (_, listener) in listeners {
            match listener {
                Listener::Abort(controller) => self.abort(controller),
                Listener::External { session } => {
                    if self.generation == session {
                        self.disconnect(wire::MoonrakerDisconnectReason::Cancelled);
                    }
                }
                Listener::SocketOpen { waiter } => {
                    self.finish_open(waiter, Err(refuse(Code::Cancelled, "open_websocket")));
                }
                Listener::Effect(effect) => {
                    if self
                        .pending
                        .get(&effect)
                        .is_some_and(|p| p.answer.is_none())
                    {
                        self.aborted.push(effect);
                        self.settle(effect, Answer::Aborted);
                    }
                }
            }
        }
    }
    fn settle(&mut self, id: u64, answer: Answer) {
        if let Some(pending) = self.pending.get_mut(&id) {
            pending.answer = Some(answer);
            let owner = pending.owner;
            self.ready.push_back(owner);
        }
    }
    fn internal_wait(&mut self) -> u64 {
        self.next_internal += 1;
        // Above every effect id, which the host sees: the two share `pending`.
        let id = INTERNAL + self.next_internal;
        self.pending.insert(
            id,
            Pending {
                kind: Kind::Internal,
                owner: self.current,
                answer: None,
            },
        );
        id
    }
    fn set_timer(&mut self, timer: Timer, delay_ms: f64) -> u64 {
        self.next_timer += 1;
        let id = self.next_timer;
        self.outputs.push(wire::MoonrakerTransportOutput::SetTimer(
            wire::MoonrakerTimer {
                timer: id,
                delay_ms,
            },
        ));
        self.timers.insert(id, timer);
        id
    }
    fn clear_timer(&mut self, id: u64) {
        if self.timers.remove(&id).is_some() {
            self.cleared.push(id);
        }
    }
    fn transition(&mut self, state: wire::MoonrakerConnectionState) {
        self.state = state.clone();
        if self.listening {
            self.outputs
                .push(wire::MoonrakerTransportOutput::State(state));
        }
    }
    fn log(
        &mut self,
        event: wire::MoonrakerDiagnosticEvent,
        level: wire::MoonrakerLogLevel,
        error: Option<&Fault>,
        attempt: Option<f64>,
    ) {
        self.logs.push(wire::MoonrakerLog {
            timestamp_ms: self.now,
            level,
            event,
            state: status_of(&self.state),
            generation: self.generation,
            attempt: match attempt {
                Some(a) => wire::OptionalFinite::Value(a),
                None => wire::OptionalFinite::Absent(wire::Empty {}),
            },
            error: match error {
                Some(e) => wire::OptionalMoonrakerTransportFault::Value(e.clone()),
                None => wire::OptionalMoonrakerTransportFault::Absent(wire::Empty {}),
            },
        });
    }
    fn connected(&self) -> bool {
        status_of(&self.state) == Status::Connected
    }
    fn current_socket(&self, session: u64, epoch: u64, socket: u64) -> bool {
        self.generation == session && self.socket_epoch == epoch && self.socket == Some(socket)
    }
    fn assert_current_session(&self, session: u64, operation: &str) -> Result<(), Fault> {
        let live = self.session_controller.is_some_and(|c| !self.aborted(c));
        if self.generation != session || !self.desired || !live {
            Err(refuse(Code::Cancelled, operation))
        } else {
            Ok(())
        }
    }
    fn send_json(&mut self, socket: u64, text: String) -> Result<(), Fault> {
        if self.sockets.get(&socket).map(|s| s.ready_state) != Some(1) {
            return Err(refuse(Code::WebsocketFailed, "websocket_send"));
        }
        self.outputs
            .push(wire::MoonrakerTransportOutput::SocketSend(
                wire::MoonrakerSocketText {
                    socket,
                    text: t(&text),
                },
            ));
        Ok(())
    }
    fn send_identify(&mut self, socket: u64) -> Result<(), Fault> {
        let text = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"server.connection.identify\",\"params\":{{\"client_name\":{},\"version\":{},\"type\":\"web\",\"url\":\"https://orcaxr.org\"}}}}",
            quote(&self.config.client_name),
            quote(&self.config.client_version)
        );
        self.send_json(socket, text)
    }
    fn send_subscription(&mut self, socket: u64) -> Result<(), Fault> {
        let Some(entries) = &self.subscription else {
            return Ok(());
        };
        let objects = entries
            .iter()
            .map(|entry| {
                let fields = match &entry.fields {
                    wire::OptionalTextList::Value(fields) => format!(
                        "[{}]",
                        fields
                            .iter()
                            .map(|f| quote(&utf16(f)))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    wire::OptionalTextList::Absent(_) => "null".to_owned(),
                };
                format!("{}:{}", quote(&utf16(&entry.name)), fields)
            })
            .collect::<Vec<_>>()
            .join(",");
        self.rpc_sequence += 1;
        let text = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"printer.objects.subscribe\",\"params\":{{\"objects\":{{{objects}}}}},\"id\":{}}}",
            self.rpc_sequence
        );
        self.send_json(socket, text)
    }
    fn clear_heartbeat(&mut self) {
        if let Some(timer) = self.heartbeat_timer.take() {
            self.clear_timer(timer);
        }
        if let Some(timer) = self.heartbeat_timeout_timer.take() {
            self.clear_timer(timer);
        }
        self.heartbeat_request = None;
    }
    fn schedule_heartbeat(&mut self, session: u64, epoch: u64) {
        self.clear_heartbeat();
        let interval = self.config.heartbeat_interval_ms;
        self.heartbeat_timer = Some(self.set_timer(Timer::Heartbeat { session, epoch }, interval));
    }
    fn teardown_socket(&mut self, close: bool) {
        self.clear_heartbeat();
        let Some(socket) = self.socket.take() else {
            return;
        };
        let Some(state) = self.sockets.get_mut(&socket) else {
            return;
        };
        state.handlers = Handlers::None;
        if close && state.ready_state < 2 {
            state.ready_state = 3;
            self.outputs
                .push(wire::MoonrakerTransportOutput::SocketClose(
                    wire::MoonrakerSocketClose {
                        socket,
                        code: 1000,
                        reason: t("client disconnect"),
                    },
                ));
        }
    }
    fn abort_active(&mut self) {
        for controller in self.active.clone() {
            self.abort(controller);
        }
    }
    fn teardown_resources(&mut self, close: bool) {
        if let Some(timer) = self.reconnect_timer.take() {
            self.clear_timer(timer);
        }
        if let Some(controller) = self.session_controller {
            self.abort(controller);
        }
        self.session_controller = None;
        self.abort_active();
        self.teardown_socket(close);
    }
    /// `failSession`: a session that cannot be re-established is over, and
    /// so is everything in flight on it — as when the first connect fails.
    fn fail_session(&mut self, session: u64, error: Fault) {
        self.desired = false;
        self.teardown_resources(true);
        self.transition(wire::MoonrakerConnectionState::Error(
            wire::MoonrakerFailedState {
                generation: session,
                error,
            },
        ));
    }
    fn disconnect(&mut self, reason: wire::MoonrakerDisconnectReason) {
        if let wire::MoonrakerConnectionState::Disconnected(d) = &self.state
            && !self.desired
            && d.reason == reason
        {
            return;
        }
        self.generation += 1;
        self.desired = false;
        self.connect_promise = None;
        self.teardown_resources(true);
        let generation = self.generation;
        self.transition(wire::MoonrakerConnectionState::Disconnected(
            wire::MoonrakerDisconnected { generation, reason },
        ));
        self.log(
            wire::MoonrakerDiagnosticEvent::Disconnected,
            wire::MoonrakerLogLevel::Info,
            None,
            None,
        );
    }
    /// `openSocket`'s `finish`.
    fn finish_open(&mut self, waiter: u64, outcome: Result<(), Fault>) {
        let Some(socket) = self
            .sockets
            .iter()
            .find(|(_, s)| matches!(s.handlers, Handlers::Opening { waiter: w, .. } if w == waiter))
            .map(|(id, _)| *id)
        else {
            return;
        };
        let Some(state) = self.sockets.get_mut(&socket) else {
            return;
        };
        let Handlers::Opening {
            timeout, signal, ..
        } = std::mem::replace(&mut state.handlers, Handlers::None)
        else {
            return;
        };
        self.clear_timer(timeout);
        if let Some((signal, listener)) = signal {
            self.unlisten(signal, listener);
        }
        self.settle(waiter, Answer::Opened(outcome));
    }
    fn resolve_promise(&mut self, id: u64, result: Result<Reply, Fault>) {
        self.next_internal += 1;
        let order = self.next_internal;
        if let Some(slot) = self.promises.get_mut(&id) {
            slot.result = Some(result.clone());
            slot.order = order;
            let waiters = std::mem::take(&mut slot.waiters);
            for waiter in waiters {
                self.settle(waiter, Answer::Settled(result.clone()));
            }
        }
    }
}
/// `JSON.stringify` of a string.
fn quote(text: &str) -> String {
    String::from_utf16_lossy(&json_stringify(&Value::String(t(text))))
}

/// One effect or internal wait: issued on its first poll.
type Issue = Box<dyn FnOnce(&mut Shared) -> u64 + Send>;
struct Ask {
    shared: Arc<Mutex<Shared>>,
    issue: Option<Issue>,
    id: u64,
}
impl Future for Ask {
    type Output = (u64, Answer);
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<(u64, Answer)> {
        let this = &mut *self;
        let mut s = lock(&this.shared);
        if let Some(issue) = this.issue.take() {
            this.id = issue(&mut s);
        }
        if s.pending.get(&this.id).is_some_and(|p| p.answer.is_some())
            && let Some(Pending {
                answer: Some(answer),
                ..
            }) = s.pending.remove(&this.id)
        {
            return Poll::Ready((this.id, answer));
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
    /// An effect the host answers.
    fn effect(
        &self,
        kind: Kind,
        output: impl FnOnce(u64) -> wire::MoonrakerTransportOutput + Send + 'static,
        signal: Option<u64>,
    ) -> Ask {
        Ask {
            shared: self.0.clone(),
            issue: Some(Box::new(move |s: &mut Shared| {
                s.next_effect += 1;
                let id = s.next_effect;
                s.outputs.push(output(id));
                let owner = s.current;
                s.pending.insert(
                    id,
                    Pending {
                        kind,
                        owner,
                        answer: None,
                    },
                );
                if let Some(signal) = signal {
                    s.listen(signal, Listener::Effect(id));
                }
                id
            })),
            id: 0,
        }
    }
    /// Wait on an internal outcome registered under `id`.
    fn wait(&self, id: u64) -> Ask {
        Ask {
            shared: self.0.clone(),
            issue: None,
            id,
        }
    }
    fn spawn(&self, task: Task, reported: bool) -> u64 {
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
        key
    }
    /// A promise another task settles; `await` it with [`Flow::join`].
    fn promise(&self) -> u64 {
        let mut s = self.lock();
        s.next_internal += 1;
        let id = s.next_internal;
        s.promises.insert(
            id,
            PromiseSlot {
                result: None,
                order: 0,
                waiters: Vec::new(),
            },
        );
        id
    }
    async fn join(&self, promise: u64) -> Result<Reply, Fault> {
        let waiter = {
            let mut s = self.lock();
            let waiter = s.internal_wait();
            match s.promises.get_mut(&promise) {
                Some(PromiseSlot {
                    result: Some(result),
                    ..
                }) => {
                    let result = result.clone();
                    s.settle(waiter, Answer::Settled(result));
                }
                Some(slot) => slot.waiters.push(waiter),
                None => {}
            }
            waiter
        };
        match self.wait(waiter).await {
            (_, Answer::Settled(result)) => result,
            _ => Err(refuse(Code::Cancelled, "connect")),
        }
    }
}

// --- Requests ---------------------------------------------------------------------------------------

#[derive(Clone)]
struct Options {
    method: Option<Vec<u16>>,
    timeout: wire::MoonrakerDeadline,
    headers: Vec<wire::MoonrakerHeader>,
    accept_bare: bool,
    upload: bool,
    signal: Option<u64>,
}
enum Read {
    Json { accept_bare: bool },
    Download,
}
enum Body {
    Value(Value),
    Bytes(f64),
}

/// `requestDeadline`: the caller's deadline, within an hour; `None` is
/// unbounded.
fn request_deadline(value: &wire::MoonrakerDeadline, fallback: f64) -> Result<Option<f64>, Fault> {
    match value {
        wire::MoonrakerDeadline::Default(_) => Ok(Some(fallback)),
        wire::MoonrakerDeadline::Unbounded(_) => Ok(None),
        wire::MoonrakerDeadline::Ms(v) if *v > 0.0 && *v <= MAXIMUM_REQUEST_DEADLINE_MS => {
            Ok(Some(v.floor()))
        }
        wire::MoonrakerDeadline::Ms(_) => Err(refuse(Code::InvalidRequest, "configure_request")),
    }
}
/// `transferDeadlineMs`: a body gets time to match its declared length.
fn transfer_deadline(content_length: Option<&[u16]>, timeout: f64) -> f64 {
    let declared = content_length.map_or(0.0, utf16_number);
    if !declared.is_finite() || declared <= 0.0 {
        return timeout;
    }
    timeout.max((declared / MINIMUM_TRANSFER_BYTES_PER_SECOND * 1000.0).ceil())
}
/// HTTP whitespace, as `Headers` strips it from a value.
fn header_value(value: &[u16]) -> Vec<u16> {
    let space = |u: &u16| matches!(*u, 0x09 | 0x0a | 0x0d | 0x20);
    let start = value.iter().position(|u| !space(u)).unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|u| !space(u))
        .map_or(start, |i| i + 1);
    value[start..end].to_vec()
}
fn ascii_lower(text: &[u16]) -> Vec<u16> {
    text.iter()
        .map(|&u| {
            if (0x41..=0x5a).contains(&u) {
                u + 32
            } else {
                u
            }
        })
        .collect()
}

/// `fetchWith`: session guard, credentials, deadlines and aborts around one
/// request, and `read` over its reply.
async fn fetch_with(
    flow: &Flow,
    session: u64,
    path: &[u16],
    options: &Options,
    operation: &str,
    read: Read,
    recovery: bool,
) -> Result<Body, Fault> {
    let (controller, timeout_ms, timeout, session_listener, caller_listener, url) = {
        let mut s = flow.lock();
        if recovery {
            if s.disposed || session != s.generation {
                return Err(refuse(Code::Cancelled, operation));
            }
        } else {
            s.assert_current_session(session, operation)?;
        }
        let url = moonraker::join(&s.config.http, path)?;
        let parsed = Url::parse(&url).map_err(|_| refuse(Code::InvalidEndpoint, operation))?;
        if parsed
            .query_pairs()
            .any(|(_, value)| s.credentials.matches(&t(&value)))
        {
            return Err(refuse(Code::InvalidEndpoint, operation));
        }
        moonraker::method_suits(parsed.path(), options.method.as_deref(), operation)?;
        let timeout_ms = request_deadline(&options.timeout, s.config.request_timeout_ms)?;
        if s.active.len() >= MAX_ACTIVE_REQUESTS {
            return Err(refuse(Code::InvalidState, operation));
        }
        let controller = s.signal();
        s.active.push(controller);
        s.requests.insert(controller, Request::default());
        let timeout = timeout_ms.map(|ms| s.set_timer(Timer::Request(controller), ms));
        let session_listener = s
            .session_controller
            .map(|signal| (signal, s.listen(signal, Listener::Abort(controller))));
        let caller_listener = options
            .signal
            .map(|signal| (signal, s.listen(signal, Listener::Abort(controller))));
        (
            controller,
            timeout_ms,
            timeout,
            session_listener,
            caller_listener,
            url,
        )
    };
    let mut body_timeout = None;
    let outcome = fetch_inner(
        flow,
        controller,
        options,
        operation,
        read,
        &url,
        timeout_ms,
        timeout,
        &mut body_timeout,
    )
    .await;
    let mut s = flow.lock();
    let outcome = outcome.map_err(|error| {
        let normalized = match error {
            Some(fault) => fault,
            None => {
                let timed_out = s.requests.get(&controller).is_some_and(|r| r.timed_out);
                if s.aborted(controller) {
                    refuse(
                        if timed_out {
                            Code::Timeout
                        } else {
                            Code::Cancelled
                        },
                        operation,
                    )
                } else {
                    refuse(Code::Network, operation)
                }
            }
        };
        let level = if normalized.recoverable {
            wire::MoonrakerLogLevel::Warn
        } else {
            wire::MoonrakerLogLevel::Error
        };
        s.log(
            wire::MoonrakerDiagnosticEvent::RequestFailed,
            level,
            Some(&normalized),
            None,
        );
        normalized
    });
    if let Some(timer) = timeout {
        s.clear_timer(timer);
    }
    if let Some(timer) = body_timeout {
        s.clear_timer(timer);
    }
    if let Some((signal, listener)) = session_listener {
        s.unlisten(signal, listener);
    }
    if let Some((signal, listener)) = caller_listener {
        s.unlisten(signal, listener);
    }
    s.active.retain(|c| *c != controller);
    outcome
}

/// The `try` of `fetchWith`; `Err(None)` is an error that is not the
/// transport's own, named by how the request ended.
#[allow(clippy::too_many_arguments)]
async fn fetch_inner(
    flow: &Flow,
    controller: u64,
    options: &Options,
    operation: &str,
    read: Read,
    url: &str,
    timeout_ms: Option<f64>,
    timeout: Option<u64>,
    body_timeout: &mut Option<u64>,
) -> Result<Body, Option<Fault>> {
    let (headers, same_origin) = {
        let s = flow.lock();
        // `new Headers(options.headers)`: names lowercase, a repeated name appended.
        let mut headers: BTreeMap<Vec<u16>, Vec<u16>> = BTreeMap::new();
        for header in &options.headers {
            let name = ascii_lower(&header.name);
            let value = header_value(&header.value);
            match headers.get_mut(&name) {
                Some(existing) => {
                    existing.extend(t(", "));
                    existing.extend(value);
                }
                None => {
                    headers.insert(name, value);
                }
            }
        }
        if headers.contains_key(&t("authorization")) || headers.contains_key(&t("x-api-key")) {
            return Err(Some(refuse(Code::InvalidCredentials, operation)));
        }
        headers
            .entry(t("accept"))
            .or_insert_with(|| t("application/json"));
        for header in s.credentials.request_headers() {
            headers.insert(ascii_lower(&header.name), header.value);
        }
        (headers, s.config.same_origin)
    };
    let method = options.method.clone().unwrap_or_else(|| t("GET"));
    let upload = options.upload;
    let url = t(url);
    let (fetch, answer) = flow
        .effect(
            Kind::Fetch,
            move |id| {
                wire::MoonrakerTransportOutput::Fetch(wire::MoonrakerFetch {
                    id,
                    url,
                    method,
                    headers: headers
                        .into_iter()
                        .map(|(name, value)| wire::MoonrakerHeader { name, value })
                        .collect(),
                    body: if upload {
                        wire::MoonrakerRequestBody::Upload
                    } else {
                        wire::MoonrakerRequestBody::None
                    },
                    credentials: if same_origin {
                        wire::MoonrakerCredentialsMode::SameOrigin
                    } else {
                        wire::MoonrakerCredentialsMode::Omit
                    },
                })
            },
            Some(controller),
        )
        .await;
    let (status, content_length) = match answer {
        Answer::Headers {
            status,
            content_length,
        } => (status, content_length),
        _ => return Err(None),
    };
    let read_body = |kind: wire::MoonrakerBodyKind| {
        flow.effect(
            match kind {
                wire::MoonrakerBodyKind::Text => Kind::Text,
                wire::MoonrakerBodyKind::Bytes => Kind::Bytes,
            },
            move |id| {
                wire::MoonrakerTransportOutput::ReadBody(wire::MoonrakerReadBody {
                    id,
                    fetch,
                    kind,
                })
            },
            Some(controller),
        )
    };
    if !(200.0..=299.0).contains(&status) {
        // `readErrorDetail`: a body that cannot be read leaves only the status.
        let detail = match read_body(wire::MoonrakerBodyKind::Text).await.1 {
            Answer::Text(body) => moonraker::error_detail(&t(&body)),
            _ => None,
        };
        let detail = {
            let s = flow.lock();
            detail.map(|d| s.credentials.redact(&d))
        };
        return Err(Some(moonraker::status_fault(
            status,
            operation,
            detail.as_deref(),
        )));
    }
    {
        let mut s = flow.lock();
        if let Some(timer) = timeout {
            s.clear_timer(timer);
        }
        if let Some(ms) = timeout_ms {
            *body_timeout = Some(s.set_timer(
                Timer::Request(controller),
                transfer_deadline(content_length.as_deref(), ms),
            ));
        }
    }
    let invalid = || Err(Some(refuse(Code::InvalidResponse, operation)));
    let declared = content_length.as_deref().map_or(0.0, utf16_number);
    match read {
        Read::Download => {
            if declared.is_finite() && declared > MAX_DOWNLOAD {
                return invalid();
            }
            match read_body(wire::MoonrakerBodyKind::Bytes).await.1 {
                Answer::Bytes(length) if length > MAX_DOWNLOAD => invalid(),
                Answer::Bytes(length) => Ok(Body::Bytes(length)),
                _ => Err(None),
            }
        }
        Read::Json { accept_bare } => {
            if declared.is_finite() && declared > MAX_JSON_RESPONSE as f64 {
                return invalid();
            }
            let text = match read_body(wire::MoonrakerBodyKind::Text).await.1 {
                Answer::Text(text) => text,
                _ => return Err(None),
            };
            if text.encode_utf16().count() > MAX_JSON_RESPONSE {
                return invalid();
            }
            let Ok(envelope) = parse_javascript(&text, LIMITS) else {
                return invalid();
            };
            if !matches!(envelope, Value::Object(_)) {
                return invalid();
            }
            if field(&envelope, "error").is_some() {
                return Err(Some(refuse(Code::ProtocolError, operation)));
            }
            match field(&envelope, "result") {
                Some(result) => Ok(Body::Value(result.clone())),
                None if accept_bare => Ok(Body::Value(envelope)),
                None => invalid(),
            }
        }
    }
}

async fn fetch_result(
    flow: &Flow,
    session: u64,
    path: &[u16],
    options: &Options,
    operation: &str,
    recovery: bool,
) -> Result<Value, Fault> {
    match fetch_with(
        flow,
        session,
        path,
        options,
        operation,
        Read::Json {
            accept_bare: options.accept_bare,
        },
        recovery,
    )
    .await?
    {
        Body::Value(value) => Ok(value),
        Body::Bytes(_) => Err(refuse(Code::InvalidResponse, operation)),
    }
}

// --- Connections --------------------------------------------------------------------------------

/// What an internal task (never reported) ends with.
fn done() -> wire::MoonrakerTaskResult {
    wire::MoonrakerTaskResult::Result(wire::MoonrakerResultText { units: 4 })
}
/// A task's result: its JSON text kept for the host to take, its length in
/// the step. Texts and params leave by `take_*`, never inside a step, so a
/// step stays within the contract however large a reply is.
fn produced(s: &mut Shared, value: &Value) -> wire::MoonrakerTaskResult {
    let units = json_stringify(value);
    let length = units.len() as u64;
    // `json_stringify` escapes lone surrogates, so the text is well formed.
    s.produced
        .insert(s.current, String::from_utf16_lossy(&units));
    wire::MoonrakerTaskResult::Result(wire::MoonrakerResultText { units: length })
}
fn plain() -> Options {
    Options {
        method: None,
        timeout: wire::MoonrakerDeadline::Default(wire::Empty {}),
        headers: Vec::new(),
        accept_bare: false,
        upload: false,
        signal: None,
    }
}

/// `Promise.all` over promise slots: every value, or the first rejection to
/// settle.
async fn all(flow: &Flow, promises: &[u64]) -> Result<Vec<Value>, Fault> {
    loop {
        let waiter = {
            let mut s = flow.lock();
            let mut values = Vec::new();
            let mut failure: Option<(u64, Fault)> = None;
            for promise in promises {
                match s
                    .promises
                    .get(promise)
                    .and_then(|p| p.result.clone().map(|r| (r, p.order)))
                {
                    Some((Ok(Reply::Value(value)), _)) => values.push(value),
                    Some((Err(fault), order)) => {
                        if failure.as_ref().is_none_or(|(first, _)| order < *first) {
                            failure = Some((order, fault));
                        }
                    }
                    _ => {}
                }
            }
            if let Some((_, fault)) = failure {
                return Err(fault);
            }
            if values.len() == promises.len() {
                return Ok(values);
            }
            let waiter = s.internal_wait();
            for promise in promises {
                if let Some(slot) = s.promises.get_mut(promise)
                    && slot.result.is_none()
                {
                    slot.waiters.push(waiter);
                }
            }
            waiter
        };
        flow.wait(waiter).await;
    }
}

async fn perform_handshake(flow: &Flow, session: u64) -> Result<wire::MoonrakerHandshake, Fault> {
    let mut promises = Vec::new();
    for (path, operation) in [
        ("/server/info", "handshake_server"),
        ("/printer/info", "handshake_printer"),
    ] {
        let promise = flow.promise();
        promises.push(promise);
        let fetching = flow.clone();
        flow.spawn(
            Box::pin(async move {
                let result = fetch_result(&fetching, session, &t(path), &plain(), operation, false)
                    .await
                    .map(Reply::Value);
                fetching.lock().resolve_promise(promise, result);
                done()
            }),
            false,
        );
    }
    let values = all(flow, &promises).await?;
    let policy = flow.lock().config.version;
    moonraker::read_handshake(&values[0], &values[1], policy)
}

async fn open_socket(flow: &Flow, session: u64) -> Result<(u64, u64), Fault> {
    let url = t(&flow.lock().config.socket_url);
    let (socket, answer) = flow
        .effect(
            Kind::Socket,
            move |id| {
                wire::MoonrakerTransportOutput::OpenSocket(wire::MoonrakerSocketOpen { id, url })
            },
            None,
        )
        .await;
    match answer {
        Answer::Created => {}
        Answer::Unavailable => return Err(refuse(Code::WebsocketUnavailable, "open_websocket")),
        _ => return Err(refuse(Code::WebsocketFailed, "open_websocket")),
    }
    let (epoch, waiter) = {
        let mut s = flow.lock();
        s.socket_epoch += 1;
        let epoch = s.socket_epoch;
        s.socket = Some(socket);
        s.sockets.insert(
            socket,
            Socket {
                ready_state: 0,
                handlers: Handlers::None,
            },
        );
        let signal = s.session_controller;
        let waiter = s.internal_wait();
        let timeout = s.config.socket_open_timeout_ms;
        let timeout = s.set_timer(Timer::SocketOpen(waiter), timeout);
        let listener =
            signal.map(|signal| (signal, s.listen(signal, Listener::SocketOpen { waiter })));
        if let Some(state) = s.sockets.get_mut(&socket) {
            state.handlers = Handlers::Opening {
                waiter,
                timeout,
                signal: listener,
            };
        }
        (epoch, waiter)
    };
    let outcome = match flow.wait(waiter).await.1 {
        Answer::Opened(outcome) => outcome,
        _ => Err(refuse(Code::Cancelled, "open_websocket")),
    };
    let mut s = flow.lock();
    if let Err(fault) = outcome {
        if s.socket == Some(socket) {
            s.teardown_socket(true);
        }
        return Err(fault);
    }
    s.assert_current_session(session, "open_websocket")?;
    if s.socket != Some(socket) || s.socket_epoch != epoch {
        return Err(refuse(Code::Cancelled, "open_websocket"));
    }
    if let Some(state) = s.sockets.get_mut(&socket) {
        state.handlers = Handlers::Live { session, epoch };
    }
    Ok((socket, epoch))
}

/// `establishConnection`: the REST handshake, then the socket, its identify
/// and subscription.
async fn establish(
    flow: &Flow,
    session: u64,
    reconnecting: bool,
) -> Result<wire::MoonrakerHandshake, Fault> {
    let operation = if reconnecting { "reconnect" } else { "connect" };
    flow.lock().assert_current_session(session, operation)?;
    let handshake = perform_handshake(flow, session).await?;
    flow.lock().assert_current_session(session, operation)?;
    let (socket, epoch) = open_socket(flow, session).await?;
    let mut s = flow.lock();
    s.assert_current_session(session, operation)?;
    if s.socket != Some(socket) || s.socket_epoch != epoch {
        return Err(refuse(Code::Cancelled, operation));
    }
    let sent = s.send_identify(socket).is_ok() && s.send_subscription(socket).is_ok();
    if !sent {
        s.teardown_socket(true);
        return Err(refuse(Code::WebsocketFailed, operation));
    }
    let now = s.now;
    s.reconnect_attempt = 0.0;
    s.transition(wire::MoonrakerConnectionState::Connected(
        wire::MoonrakerConnected {
            generation: session,
            socket_epoch: epoch,
            connected_at_ms: now,
            last_heartbeat_at_ms: now,
            handshake: handshake.clone(),
        },
    ));
    s.schedule_heartbeat(session, epoch);
    s.log(
        wire::MoonrakerDiagnosticEvent::Connected,
        wire::MoonrakerLogLevel::Info,
        None,
        None,
    );
    Ok(handshake)
}

async fn connect(flow: Flow, signal: Option<u64>) -> wire::MoonrakerTaskResult {
    let refused = wire::MoonrakerTaskResult::Refused;
    enum Start {
        Done(wire::MoonrakerTaskResult),
        Join(u64),
        Session(u64, Option<(u64, u64)>),
    }
    let start = {
        let mut s = flow.lock();
        if s.disposed {
            Start::Done(refused(refuse(Code::InvalidState, "connect")))
        } else if let wire::MoonrakerConnectionState::Connected(c) = &s.state {
            Start::Done(wire::MoonrakerTaskResult::Handshake(c.handshake.clone()))
        } else if let Some(promise) = s.connect_promise {
            Start::Join(promise)
        } else if signal.is_some_and(|signal| s.aborted(signal)) {
            Start::Done(refused(refuse(Code::Cancelled, "connect")))
        } else {
            // `prepareNewSession`.
            s.desired = false;
            s.generation += 1;
            s.teardown_resources(true);
            s.reconnect_attempt = 0.0;
            let session = s.generation;
            s.desired = true;
            let controller = s.signal();
            s.session_controller = Some(controller);
            s.transition(wire::MoonrakerConnectionState::Connecting(
                wire::MoonrakerConnecting {
                    generation: session,
                    attempt: 0,
                },
            ));
            s.log(
                wire::MoonrakerDiagnosticEvent::ConnectionAttempt,
                wire::MoonrakerLogLevel::Info,
                None,
                None,
            );
            let external =
                signal.map(|signal| (signal, s.listen(signal, Listener::External { session })));
            Start::Session(session, external)
        }
    };
    let (session, external) = match start {
        Start::Done(result) => return result,
        // A connect in flight is shared, its outcome as it is.
        Start::Join(promise) => {
            return match flow.join(promise).await {
                Ok(Reply::Handshake(handshake)) => wire::MoonrakerTaskResult::Handshake(handshake),
                Ok(Reply::Value(_)) => refused(refuse(Code::InvalidResponse, "connect")),
                Err(fault) => refused(fault),
            };
        }
        Start::Session(session, external) => (session, external),
    };
    let promise = flow.promise();
    flow.lock().connect_promise = Some(promise);
    let establishing = flow.clone();
    flow.spawn(
        Box::pin(async move {
            let result = establish(&establishing, session, false)
                .await
                .map(Reply::Handshake);
            establishing.lock().resolve_promise(promise, result);
            done()
        }),
        false,
    );
    let result = flow.join(promise).await;
    let mut s = flow.lock();
    let outcome = match result {
        Ok(Reply::Handshake(handshake)) => wire::MoonrakerTaskResult::Handshake(handshake),
        Ok(Reply::Value(_)) => refused(refuse(Code::InvalidResponse, "connect")),
        Err(fault) => {
            if s.generation != session || fault.code == Code::Cancelled {
                refused(refuse(Code::Cancelled, "connect"))
            } else {
                s.desired = false;
                s.teardown_resources(true);
                s.transition(wire::MoonrakerConnectionState::Error(
                    wire::MoonrakerFailedState {
                        generation: session,
                        error: fault.clone(),
                    },
                ));
                refused(fault)
            }
        }
    };
    if let Some((signal, listener)) = external {
        s.unlisten(signal, listener);
    }
    if s.connect_promise == Some(promise) {
        s.connect_promise = None;
    }
    outcome
}

/// `scheduleReconnect`: the next attempt after a jittered delay, until the
/// policy is exhausted.
async fn schedule_reconnect(flow: &Flow, session: u64, last_error: Fault) {
    let attempt = {
        let mut s = flow.lock();
        if !s.desired || s.generation != session {
            return;
        }
        if let Some(timer) = s.reconnect_timer.take() {
            s.clear_timer(timer);
        }
        let attempt = s.reconnect_attempt + 1.0;
        if attempt > s.config.reconnect.maximum_attempts {
            s.fail_session(session, refuse(Code::ReconnectExhausted, "reconnect"));
            return;
        }
        s.reconnect_attempt = attempt;
        attempt
    };
    let (_, answer) = flow
        .effect(
            Kind::Random,
            |id| wire::MoonrakerTransportOutput::Random(wire::MoonrakerRandom { id }),
            None,
        )
        .await;
    let random = match answer {
        Answer::Random(value) => value,
        _ => 0.0,
    };
    let mut s = flow.lock();
    let delay = moonraker::reconnect_delay(&wire::MoonrakerReconnectDelayRequest {
        attempt,
        policy: s.config.reconnect.clone(),
        random,
    });
    s.transition(wire::MoonrakerConnectionState::Reconnecting(
        wire::MoonrakerReconnecting {
            generation: session,
            attempt: attempt as u64,
            delay_ms: delay,
            last_error: last_error.clone(),
        },
    ));
    s.log(
        wire::MoonrakerDiagnosticEvent::ReconnectScheduled,
        wire::MoonrakerLogLevel::Warn,
        Some(&last_error),
        Some(attempt),
    );
    s.reconnect_timer = Some(s.set_timer(Timer::Reconnect { session }, delay));
}

async fn run_reconnect(flow: Flow, session: u64) -> wire::MoonrakerTaskResult {
    {
        let mut s = flow.lock();
        if !s.desired || s.generation != session {
            return done();
        }
        let attempt = s.reconnect_attempt;
        s.log(
            wire::MoonrakerDiagnosticEvent::ConnectionAttempt,
            wire::MoonrakerLogLevel::Info,
            None,
            Some(attempt),
        );
    }
    let Err(fault) = establish(&flow, session, true).await else {
        return done();
    };
    {
        let mut s = flow.lock();
        if !s.desired || s.generation != session || fault.code == Code::Cancelled {
            return done();
        }
        if !fault.recoverable {
            s.fail_session(session, fault);
            return done();
        }
    }
    schedule_reconnect(&flow, session, fault).await;
    done()
}

impl Flow {
    /// `handleSocketLoss`, from a handler that runs to completion: what
    /// `scheduleReconnect` asks synchronously is asked before anything else.
    fn loss(&self, session: u64, epoch: u64, socket: u64, error: Fault) {
        {
            let mut s = self.lock();
            if !s.current_socket(session, epoch, socket) {
                return;
            }
            // Only the socket is lost: HTTP work in flight belongs to the
            // session, and only the session's failure ends it.
            s.teardown_socket(true);
            if !s.desired || s.generation != session {
                return;
            }
        }
        let flow = self.clone();
        self.spawn(
            Box::pin(async move {
                schedule_reconnect(&flow, session, error).await;
                done()
            }),
            false,
        );
    }
    fn send_heartbeat(&self, session: u64, epoch: u64) {
        let failed = {
            let mut s = self.lock();
            let Some(socket) = s.socket else {
                return;
            };
            if !s.current_socket(session, epoch, socket) || !s.connected() {
                return;
            }
            s.rpc_sequence += 1;
            let id = format!("orcaxr-heartbeat-{session}-{epoch}-{}", s.rpc_sequence);
            s.heartbeat_request = Some(id.clone());
            let text = format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"server.info\",\"id\":{}}}",
                quote(&id)
            );
            if s.send_json(socket, text).is_err() {
                Some(socket)
            } else {
                let timeout = s.config.heartbeat_timeout_ms;
                s.heartbeat_timeout_timer = Some(s.set_timer(
                    Timer::HeartbeatTimeout {
                        session,
                        epoch,
                        socket,
                        id,
                    },
                    timeout,
                ));
                None
            }
        };
        if let Some(socket) = failed {
            self.loss(
                session,
                epoch,
                socket,
                refuse(Code::WebsocketFailed, "heartbeat_send"),
            );
        }
    }
    fn message(&self, session: u64, epoch: u64, socket: u64, text: &str) {
        let mut s = self.lock();
        if !s.current_socket(session, epoch, socket) {
            return;
        }
        let warn = |s: &mut Shared| {
            s.log(
                wire::MoonrakerDiagnosticEvent::ProtocolWarning,
                wire::MoonrakerLogLevel::Warn,
                None,
                None,
            );
        };
        if text.encode_utf16().count() > MAX_SOCKET_MESSAGE {
            return warn(&mut s);
        }
        let Ok(message) = parse_javascript(text, LIMITS) else {
            return warn(&mut s);
        };
        if !matches!(message, Value::Object(_)) {
            return warn(&mut s);
        }
        if let Some(heartbeat) = s.heartbeat_request.clone()
            && matches!(field(&message, "id"), Some(Value::String(id)) if *id == t(&heartbeat))
        {
            if field(&message, "error").is_some() {
                drop(s);
                return self.loss(
                    session,
                    epoch,
                    socket,
                    refuse(Code::WebsocketFailed, "heartbeat_response"),
                );
            }
            s.heartbeat_request = None;
            if let Some(timer) = s.heartbeat_timeout_timer.take() {
                s.clear_timer(timer);
            }
            if let wire::MoonrakerConnectionState::Connected(connected) = &s.state {
                let mut connected = connected.clone();
                connected.last_heartbeat_at_ms = s.now;
                s.transition(wire::MoonrakerConnectionState::Connected(connected));
            }
            s.schedule_heartbeat(session, epoch);
            return;
        }
        let Some(Value::String(method)) = field(&message, "method") else {
            return;
        };
        let valid = (1..=128).contains(&method.len()) && method.iter().all(|&u| {
            u < 0x80
                && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.' | b'-')
        });
        if !valid {
            return;
        }
        let params = field(&message, "params");
        if params.is_some_and(|p| objects(p) > MAX_PROTOCOL_OBJECTS) {
            return warn(&mut s);
        }
        if s.listening {
            let now = s.now;
            let method = method.clone();
            s.next_notification += 1;
            let id = s.next_notification;
            let text = params.map_or_else(|| t("null"), json_stringify);
            s.params.insert(id, String::from_utf16_lossy(&text));
            s.outputs.push(wire::MoonrakerTransportOutput::Notification(
                wire::MoonrakerNotification {
                    id,
                    method,
                    received_at_ms: now,
                    generation: session,
                    socket_epoch: epoch,
                },
            ));
        }
    }
}
/// `freezeProtocolValue`'s count: objects and arrays in a value.
fn objects(value: &Value) -> usize {
    let mut count = 0;
    let mut pending = vec![value];
    while let Some(current) = pending.pop() {
        match current {
            Value::Object(fields) => {
                count += 1;
                pending.extend(fields.values());
            }
            Value::Array(items) => {
                count += 1;
                pending.extend(items.iter());
            }
            _ => {}
        }
        if count > MAX_PROTOCOL_OBJECTS {
            break;
        }
    }
    count
}

// --- Tasks the host starts ---------------------------------------------------------------------------

async fn request(
    flow: Flow,
    path: Vec<u16>,
    options: Options,
    operation: Option<Vec<u16>>,
    default: &'static str,
    read_bytes: bool,
) -> wire::MoonrakerTaskResult {
    let refused = wire::MoonrakerTaskResult::Refused;
    let raw = operation.map_or_else(|| default.to_owned(), |o| utf16(&o));
    let generation = {
        let s = flow.lock();
        if s.disposed
            || !matches!(
                status_of(&s.state),
                Status::Connected | Status::Reconnecting
            )
        {
            return refused(refuse(Code::InvalidState, &raw));
        }
        if !read_bytes && options.signal.is_some_and(|signal| s.aborted(signal)) && !options.upload
        {
            return refused(refuse(Code::Cancelled, &raw));
        }
        s.generation
    };
    let operation = utf16(&safe_operation_name(&t(&raw)));
    let body = if read_bytes {
        fetch_with(
            &flow,
            generation,
            &path,
            &options,
            &operation,
            Read::Download,
            false,
        )
        .await
    } else {
        fetch_result(&flow, generation, &path, &options, &operation, false)
            .await
            .map(Body::Value)
    };
    let body = match body {
        Ok(body) => body,
        Err(fault) => return refused(fault),
    };
    if flow.lock().generation != generation {
        return refused(refuse(Code::Cancelled, &operation));
    }
    match body {
        Body::Value(value) => produced(&mut flow.lock(), &value),
        Body::Bytes(length) => wire::MoonrakerTaskResult::Bytes(length as u64),
    }
}

async fn recovery(flow: Flow, command: Vec<u16>, signal: Option<u64>) -> wire::MoonrakerTaskResult {
    let refused = wire::MoonrakerTaskResult::Refused;
    let operation = "printer_recovery";
    let (generation, path) = {
        let s = flow.lock();
        if s.disposed {
            return refused(refuse(Code::InvalidState, operation));
        }
        if signal.is_some_and(|signal| s.aborted(signal)) {
            return refused(refuse(Code::Cancelled, operation));
        }
        let path = if command == t("emergency-stop") {
            "/printer/emergency_stop"
        } else if command == t("firmware-restart") {
            "/printer/firmware_restart"
        } else {
            return refused(refuse(Code::InvalidRequest, operation));
        };
        (s.generation, path)
    };
    let options = Options {
        method: Some(t("POST")),
        signal,
        ..plain()
    };
    let value = match fetch_result(&flow, generation, &t(path), &options, operation, true).await {
        Ok(value) => value,
        Err(fault) => return refused(fault),
    };
    let mut s = flow.lock();
    if s.disposed || generation != s.generation || signal.is_some_and(|signal| s.aborted(signal)) {
        return refused(refuse(Code::Cancelled, operation));
    }
    produced(&mut s, &value)
}

// --- The transport --------------------------------------------------------------------------------

/// A caller's abort signal by name: `none`, `live` (it may abort later,
/// through [`MoonrakerTransport::abort`]) or `aborted` (it already has).
pub fn signal_named(name: &str) -> Option<wire::MoonrakerSignal> {
    match name {
        "none" => Some(wire::MoonrakerSignal::None),
        "live" => Some(wire::MoonrakerSignal::Live),
        "aborted" => Some(wire::MoonrakerSignal::Aborted),
        _ => None,
    }
}
/// A reason a caller may disconnect for: `user`, `cancelled` or `disposed`.
pub fn reason_named(name: &str) -> Option<wire::MoonrakerDisconnectReason> {
    match name {
        "user" => Some(wire::MoonrakerDisconnectReason::User),
        "cancelled" => Some(wire::MoonrakerDisconnectReason::Cancelled),
        "disposed" => Some(wire::MoonrakerDisconnectReason::Disposed),
        _ => None,
    }
}

/// `MoonrakerTransport`: one printer's connection — the REST handshake, the
/// JSON-RPC socket, its heartbeat and reconnects — and every HTTP request,
/// upload, download and recovery command. Each call answers a
/// [`wire::MoonrakerTransportStep`]: what the host must do (fetch, read a
/// body, open or write a socket, arm or clear a timer, draw a random number),
/// the tasks that finished, the effects to fail as aborted, and diagnostics.
pub struct MoonrakerTransport {
    shared: Arc<Mutex<Shared>>,
    tasks: BTreeMap<u64, Task>,
}
impl MoonrakerTransport {
    /// A transport for one endpoint; its configuration is checked as the
    /// browser checks it. Also answers the first state.
    pub fn new(
        input: &wire::MoonrakerTransportConfig,
    ) -> Result<(Self, wire::MoonrakerConnectionState), Fault> {
        let config = config(input)?;
        let state = wire::MoonrakerConnectionState::Disconnected(wire::MoonrakerDisconnected {
            generation: 0,
            reason: wire::MoonrakerDisconnectReason::Initial,
        });
        let shared = Shared {
            config,
            credentials: Credentials::default(),
            state: state.clone(),
            generation: 0,
            socket_epoch: 0,
            desired: false,
            disposed: false,
            listening: true,
            produced: BTreeMap::new(),
            results: BTreeMap::new(),
            params: BTreeMap::new(),
            next_notification: 0,
            session_controller: None,
            connect_promise: None,
            socket: None,
            reconnect_attempt: 0.0,
            reconnect_timer: None,
            heartbeat_timer: None,
            heartbeat_timeout_timer: None,
            heartbeat_request: None,
            rpc_sequence: 0,
            subscription: None,
            active: Vec::new(),
            now: 0.0,
            signals: BTreeMap::new(),
            timers: BTreeMap::new(),
            requests: BTreeMap::new(),
            sockets: BTreeMap::new(),
            promises: BTreeMap::new(),
            pending: BTreeMap::new(),
            task_signals: BTreeMap::new(),
            spawned: VecDeque::new(),
            ready: VecDeque::new(),
            current: 0,
            reported: BTreeMap::new(),
            next_effect: 0,
            next_timer: 0,
            next_task: 0,
            next_key: 0,
            next_internal: 0,
            outputs: Vec::new(),
            cleared: Vec::new(),
            aborted: Vec::new(),
            logs: Vec::new(),
            finished: Vec::new(),
            task: None,
        };
        Ok((
            MoonrakerTransport {
                shared: Arc::new(Mutex::new(shared)),
                tasks: BTreeMap::new(),
            },
            state,
        ))
    }
    fn flow(&self) -> Flow {
        Flow(self.shared.clone())
    }
    fn at(&self, now: f64) {
        if now.is_finite() {
            lock(&self.shared).now = now;
        }
    }
    /// The JSON text of finished task `task`'s result (`JSON.parse` reads it
    /// as the browser's value), once.
    pub fn take_result(&mut self, task: u64) -> Option<String> {
        lock(&self.shared).results.remove(&task)
    }
    /// The JSON text of notification `id`'s params, once.
    pub fn take_params(&mut self, id: u64) -> Option<String> {
        lock(&self.shared).params.remove(&id)
    }
    pub fn state(&self) -> wire::MoonrakerConnectionState {
        lock(&self.shared).state.clone()
    }
    /// Whether an API key or a bearer token is set.
    pub fn credential_metadata(&self) -> (bool, bool) {
        let s = lock(&self.shared);
        (
            s.credentials.has_api_key(),
            s.credentials.has_bearer_token(),
        )
    }
    pub fn set_credentials(
        &mut self,
        credentials: &wire::MoonrakerCredentials,
        now: f64,
    ) -> Result<(), Fault> {
        self.at(now);
        let store = Credentials::set(credentials)?;
        lock(&self.shared).credentials = store;
        Ok(())
    }
    pub fn clear_credentials(&mut self, now: f64) {
        self.at(now);
        lock(&self.shared).credentials = Credentials::default();
    }
    /// The objects the socket subscribes to; `None` subscribes to nothing.
    pub fn set_subscription(
        &mut self,
        entries: Option<&[wire::MoonrakerSubscriptionEntry]>,
        now: f64,
    ) -> Result<wire::MoonrakerTransportStep, Fault> {
        self.at(now);
        let entries = entries.map(moonraker::subscription).transpose()?;
        let failed = {
            let mut s = lock(&self.shared);
            s.subscription = entries;
            match s.socket {
                Some(socket) if s.connected() => s
                    .send_subscription(socket)
                    .is_err()
                    .then(|| (s.generation, s.socket_epoch, socket)),
                _ => None,
            }
        };
        if let Some((generation, epoch, socket)) = failed {
            self.flow().loss(
                generation,
                epoch,
                socket,
                refuse(Code::WebsocketFailed, "object_subscription"),
            );
        }
        Ok(self.advance())
    }
    fn signal_for(&self, signal: wire::MoonrakerSignal) -> Option<u64> {
        let mut s = lock(&self.shared);
        match signal {
            wire::MoonrakerSignal::None => None,
            wire::MoonrakerSignal::Live => Some(s.signal()),
            wire::MoonrakerSignal::Aborted => {
                let signal = s.signal();
                s.abort(signal);
                Some(signal)
            }
        }
    }
    fn start(&mut self, task: Task, signal: Option<u64>) -> wire::MoonrakerTransportStep {
        let flow = self.flow();
        flow.spawn(task, true);
        if let Some(signal) = signal {
            let mut s = lock(&self.shared);
            let id = s.task.unwrap_or_default();
            s.task_signals.insert(id, signal);
        }
        self.advance()
    }
    pub fn connect(
        &mut self,
        signal: wire::MoonrakerSignal,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let signal = self.signal_for(signal);
        let task = Box::pin(connect(self.flow(), signal));
        self.start(task, signal)
    }
    pub fn disconnect(
        &mut self,
        reason: wire::MoonrakerDisconnectReason,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        lock(&self.shared).disconnect(reason);
        self.advance()
    }
    pub fn dispose(&mut self, now: f64) -> wire::MoonrakerTransportStep {
        self.at(now);
        {
            let mut s = lock(&self.shared);
            if !s.disposed {
                s.disconnect(wire::MoonrakerDisconnectReason::Disposed);
                s.credentials = Credentials::default();
                s.listening = false;
                s.subscription = None;
                s.disposed = true;
            }
        }
        self.advance()
    }
    fn options(
        &self,
        options: &wire::MoonrakerRequestOptions,
        upload: bool,
    ) -> (Options, Option<Vec<u16>>) {
        let signal = self.signal_for(options.signal);
        (
            Options {
                method: if upload {
                    Some(t("POST"))
                } else {
                    read_text(&options.method).map(<[u16]>::to_vec)
                },
                timeout: options.timeout_ms.clone(),
                headers: options.headers.clone(),
                accept_bare: upload || options.accept_bare_envelope,
                upload,
                signal,
            },
            read_text(&options.operation).map(<[u16]>::to_vec),
        )
    }
    pub fn request(
        &mut self,
        request: &wire::MoonrakerRequest,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let (options, operation) = self.options(&request.options, false);
        let signal = options.signal;
        let task = Box::pin(self::request(
            self.flow(),
            request.path.clone(),
            options,
            operation,
            "request",
            false,
        ));
        self.start(task, signal)
    }
    /// A file upload: the body is the host's, posted as given.
    pub fn upload(
        &mut self,
        request: &wire::MoonrakerRequest,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let (options, operation) = self.options(&request.options, true);
        let signal = options.signal;
        let task = Box::pin(self::request(
            self.flow(),
            request.path.clone(),
            options,
            operation,
            "upload",
            false,
        ));
        self.start(task, signal)
    }
    /// A file download: the bytes stay the host's; only their length is read.
    pub fn download(
        &mut self,
        request: &wire::MoonrakerRequest,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let (options, operation) = self.options(&request.options, false);
        let signal = options.signal;
        let task = Box::pin(self::request(
            self.flow(),
            request.path.clone(),
            options,
            operation,
            "download",
            true,
        ));
        self.start(task, signal)
    }
    /// Emergency stop or firmware restart, which need no handshake or socket.
    pub fn recovery(
        &mut self,
        request: &wire::MoonrakerRecoveryRequest,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let signal = self.signal_for(request.signal);
        let task = Box::pin(self::recovery(self.flow(), request.command.clone(), signal));
        self.start(task, signal)
    }
    /// The caller's own signal for task `task` aborts.
    pub fn abort(&mut self, task: u64, now: f64) -> wire::MoonrakerTransportStep {
        self.at(now);
        {
            let mut s = lock(&self.shared);
            if let Some(signal) = s.task_signals.get(&task).copied() {
                s.abort(signal);
            }
        }
        self.advance()
    }
    pub fn resolve(
        &mut self,
        id: u64,
        outcome: wire::MoonrakerTransportOutcome,
        now: f64,
    ) -> Result<wire::MoonrakerTransportStep, Refusal> {
        use wire::MoonrakerTransportOutcome as O;
        let answer = match outcome {
            O::Headers(headers) => Answer::Headers {
                status: headers.status,
                content_length: read_text(&headers.content_length).map(<[u16]>::to_vec),
            },
            O::Failed(_) => Answer::Failed,
            O::Bytes(length) => Answer::Bytes(length as f64),
            O::Created(_) => Answer::Created,
            O::Unavailable(_) => Answer::Unavailable,
            O::Broken(_) => Answer::Broken,
            O::Random(value) => Answer::Random(value),
        };
        self.answer(id, answer, now)
    }
    /// A body read as text, answered.
    pub fn resolve_text(
        &mut self,
        id: u64,
        text: &str,
        now: f64,
    ) -> Result<wire::MoonrakerTransportStep, Refusal> {
        self.answer(id, Answer::Text(text.to_owned()), now)
    }
    fn answer(
        &mut self,
        id: u64,
        answer: Answer,
        now: f64,
    ) -> Result<wire::MoonrakerTransportStep, Refusal> {
        {
            let mut s = lock(&self.shared);
            let Some((kind, owner, answered)) = s
                .pending
                .get(&id)
                .map(|p| (p.kind, p.owner, p.answer.is_some()))
            else {
                return Err(Refusal::NotPending);
            };
            if answered || kind == Kind::Internal {
                return Err(Refusal::NotPending);
            }
            let fits = matches!(
                (&answer, kind),
                (Answer::Failed, Kind::Fetch | Kind::Text | Kind::Bytes)
                    | (Answer::Headers { .. }, Kind::Fetch)
                    | (Answer::Text(_), Kind::Text)
                    | (Answer::Bytes(_), Kind::Bytes)
                    | (
                        Answer::Created | Answer::Unavailable | Answer::Broken,
                        Kind::Socket
                    )
                    | (Answer::Random(_), Kind::Random)
            );
            if !fits {
                return Err(Refusal::Mismatch);
            }
            if now.is_finite() {
                s.now = now;
            }
            s.settle(id, answer);
            if matches!(kind, Kind::Socket | Kind::Random) {
                // Asked synchronously: what follows comes before anything else.
                s.ready.retain(|key| *key != owner);
                s.ready.push_front(owner);
            }
        }
        Ok(self.advance())
    }
    pub fn socket_open(&mut self, socket: u64, now: f64) -> wire::MoonrakerTransportStep {
        self.socket_event(socket, now, 1, None)
    }
    pub fn socket_error(&mut self, socket: u64, now: f64) -> wire::MoonrakerTransportStep {
        self.socket_event(socket, now, 3, Some("websocket_event"))
    }
    pub fn socket_close(&mut self, socket: u64, now: f64) -> wire::MoonrakerTransportStep {
        self.socket_event(socket, now, 3, Some("websocket_close"))
    }
    fn socket_event(
        &mut self,
        socket: u64,
        now: f64,
        ready_state: u8,
        loss: Option<&str>,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let live = {
            let mut s = lock(&self.shared);
            let Some(state) = s.sockets.get_mut(&socket) else {
                drop(s);
                return self.advance();
            };
            state.ready_state = ready_state;
            match state.handlers {
                Handlers::Opening { waiter, .. } => {
                    let outcome = match loss {
                        None => Ok(()),
                        Some(_) => Err(refuse(Code::WebsocketFailed, "open_websocket")),
                    };
                    s.finish_open(waiter, outcome);
                    None
                }
                Handlers::Live { session, epoch } => {
                    loss.map(|operation| (session, epoch, operation))
                }
                Handlers::None => None,
            }
        };
        if let Some((session, epoch, operation)) = live {
            self.flow().loss(
                session,
                epoch,
                socket,
                refuse(Code::WebsocketFailed, operation),
            );
        }
        self.advance()
    }
    pub fn socket_message(
        &mut self,
        socket: u64,
        text: &str,
        now: f64,
    ) -> wire::MoonrakerTransportStep {
        self.at(now);
        let live = match lock(&self.shared).sockets.get(&socket).map(|s| &s.handlers) {
            Some(Handlers::Live { session, epoch }) => Some((*session, *epoch)),
            _ => None,
        };
        if let Some((session, epoch)) = live {
            self.flow().message(session, epoch, socket, text);
        }
        self.advance()
    }
    pub fn timer(&mut self, timer: u64, now: f64) -> wire::MoonrakerTransportStep {
        self.at(now);
        let fired = lock(&self.shared).timers.remove(&timer);
        let flow = self.flow();
        match fired {
            Some(Timer::Request(controller)) => {
                let mut s = flow.lock();
                if let Some(request) = s.requests.get_mut(&controller) {
                    request.timed_out = true;
                }
                s.abort(controller);
            }
            Some(Timer::SocketOpen(waiter)) => {
                flow.lock()
                    .finish_open(waiter, Err(refuse(Code::Timeout, "open_websocket")));
            }
            Some(Timer::Heartbeat { session, epoch }) => {
                flow.lock().heartbeat_timer = None;
                flow.send_heartbeat(session, epoch);
            }
            Some(Timer::HeartbeatTimeout {
                session,
                epoch,
                socket,
                id,
            }) => {
                let error = {
                    let mut s = flow.lock();
                    if !s.current_socket(session, epoch, socket)
                        || s.heartbeat_request.as_deref() != Some(&id)
                    {
                        None
                    } else {
                        let error = refuse(Code::HeartbeatTimeout, "heartbeat");
                        s.log(
                            wire::MoonrakerDiagnosticEvent::HeartbeatTimeout,
                            wire::MoonrakerLogLevel::Warn,
                            Some(&error),
                            None,
                        );
                        Some(error)
                    }
                };
                if let Some(error) = error {
                    flow.loss(session, epoch, socket, error);
                }
            }
            Some(Timer::Reconnect { session }) => {
                flow.lock().reconnect_timer = None;
                let reconnecting = flow.clone();
                flow.spawn(Box::pin(run_reconnect(reconnecting, session)), false);
            }
            None => {}
        }
        self.advance()
    }

    /// Poll started tasks first, then woken ones in the order they woke,
    /// until every task waits; a socket or random number being asked stops
    /// everything else.
    fn advance(&mut self) -> wire::MoonrakerTransportStep {
        loop {
            let next = {
                let mut s = lock(&self.shared);
                if s.pending
                    .values()
                    .any(|p| matches!(p.kind, Kind::Socket | Kind::Random) && p.answer.is_none())
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
            if let Poll::Ready(result) = task.as_mut().poll(&mut Context::from_waker(Waker::noop()))
            {
                self.tasks.remove(&key);
                let mut s = lock(&self.shared);
                let text = s.produced.remove(&key);
                if let Some(task) = s.reported.remove(&key) {
                    if let (wire::MoonrakerTaskResult::Result(_), Some(text)) = (&result, text) {
                        s.results.insert(task, text);
                    }
                    s.finished
                        .push(wire::MoonrakerTaskFinished { task, result });
                }
            }
        }
        let mut s = lock(&self.shared);
        let mut finished = std::mem::take(&mut s.finished);
        finished.sort_by_key(|f| f.task);
        let mut cleared = std::mem::take(&mut s.cleared);
        cleared.sort_unstable();
        let mut aborted = std::mem::take(&mut s.aborted);
        aborted.sort_unstable();
        let mut logs = std::mem::take(&mut s.logs);
        // Diagnostics of tasks woken together come in an order set by promise
        // depth in the browser; the contract lists them by their encoding.
        logs.sort_by_cached_key(|log| wire::encode_moonraker_log(log).unwrap_or_default());
        wire::MoonrakerTransportStep {
            outputs: std::mem::take(&mut s.outputs),
            cleared,
            aborted,
            logs,
            task: match s.task.take() {
                Some(task) => wire::OptionalCounter::Value(task),
                None => wire::OptionalCounter::Absent(wire::Empty {}),
            },
            finished,
        }
    }
}
