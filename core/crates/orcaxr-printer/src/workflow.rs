//! `PrintWorkflowController.ts` and the submission it drives
//! (`submitPrintJob`, `preparePrintUpload`, `validatePrintUploadTarget` in
//! `PrintJobSubmission.ts`): the one cancellable owner of sending a sliced
//! artifact to a printer, or of starting a file already stored there.
//!
//! It is an effect machine. Every step returns the effects it needs a host to
//! carry out — capture the session, ask whether that session or the artifact is
//! still current, send one request or the upload, draw random bytes, ask the
//! operator — each under an id the host answers with `resolve`. The order,
//! checks and wording are the browser's: readiness is read before anything is
//! confirmed, nothing is overwritten silently, the stored size is verified
//! before a print starts, every mutation re-reads the printer first, and an
//! ambiguous preparation or start is never retried but reconciled with one
//! bounded query.
//!
//! Hosts own the transport. When the operator cancels, a host fails the
//! requests and upload in flight as `cancelled` (or lets them finish: a reply
//! that arrives anyway is checked like any other). A `reconcile` query is not
//! the operation's: it survives the cancel and runs under its own deadline.
use crate::{control::moonraker_message, preparation as prep, status::LIMITS, tools};
use orcaxr_contracts::{
    canonical::{Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::convert::{
    encode_uri_component, number_to_string, to_fixed, trim_utf16,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll, Waker},
};
use wire::{
    PrintSubmissionErrorCode as Code, PrintSubmissionPhase as Notice, PrintWorkflowPhase as Phase,
};

const GCODE_ROOT: &str = "gcodes";
const READINESS_PATH: &str = "/printer/objects/query?webhooks&print_stats&virtual_sdcard";
/// What a session lease says when its printer or connection changed.
const LEASE_CHANGED: &str = "The selected printer or connection changed. Confirm a new send.";
/// `reconcile`'s cleanup window, independent of the cancelled operation.
const RECONCILE_MS: f64 = 3000.0;

/// Why a call was not accepted. Nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Disposed, or an operation is already running.
    Unavailable,
    /// No effect with that id is waiting for an answer.
    NotPending,
    /// The outcome does not answer that kind of effect.
    Mismatch,
}
impl Refusal {
    /// What bindings throw.
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Unavailable => "unavailable",
            Refusal::NotPending => "not_pending",
            Refusal::Mismatch => "mismatch",
        }
    }
    /// What the browser says when it refuses a second send.
    pub fn message(self) -> &'static str {
        match self {
            Refusal::Unavailable => "A send is unavailable or already pending.",
            Refusal::NotPending => "That effect is not pending.",
            Refusal::Mismatch => "That outcome does not answer that effect.",
        }
    }
}

fn t(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn join(parts: impl IntoIterator<Item = Vec<u16>>, separator: &str) -> Vec<u16> {
    let separator = t(separator);
    let mut out = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(&separator);
        }
        out.extend(part);
    }
    out
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
fn optional(text: Option<Vec<u16>>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
/// `encodeURIComponent`. Every name reaching it is well formed: upload names
/// are sanitized and stored paths pass `storage_path`.
fn encoded(units: &[u16]) -> String {
    encode_uri_component(units).unwrap_or_default()
}

/// `assertStoragePath`: a root-relative path with its surrounding space and
/// slashes removed, refused when it is empty, steps outside the root, or holds
/// a lone surrogate (which has no URL spelling).
pub fn storage_path(path: &[u16], what: &str) -> Result<Vec<u16>, Vec<u16>> {
    let trimmed = trim_utf16(path);
    let slash = u16::from(b'/');
    let start = trimmed
        .iter()
        .position(|&u| u != slash)
        .unwrap_or(trimmed.len());
    let end = trimmed
        .iter()
        .rposition(|&u| u != slash)
        .map_or(start, |i| i + 1);
    let trimmed = &trimmed[start..end];
    if trimmed.is_empty() {
        return Err(t(&format!("{what} is empty.")));
    }
    if trimmed
        .split(|&u| u == slash)
        .any(|segment| segment == t(".") || segment == t(".."))
    {
        return Err(t(&format!(
            "{what} may not step outside the printer's {GCODE_ROOT} folder."
        )));
    }
    if char::decode_utf16(trimmed.iter().copied()).any(|c| c.is_err()) {
        return Err(t(&format!("{what} has a name that is not valid text.")));
    }
    Ok(trimmed.to_vec())
}

// --- Effects ---------------------------------------------------------------------------

/// What answered an effect.
enum Answer {
    Reply(Value),
    Failed(wire::TransportFailure),
    Session(Vec<u16>),
    SessionFailed(Vec<u16>),
    Current(bool),
    Random(Vec<u16>),
    Decision(wire::PrintWorkflowDecision),
    /// `waitForDecision` gave up on the operator: the send was cancelled.
    Withdrawn,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Capture,
    Check,
    Transport,
    Random,
    Confirm,
}
fn kind(effect: &wire::PrintWorkflowEffect) -> Kind {
    use wire::PrintWorkflowEffect as E;
    match effect {
        E::CaptureSession(_) => Kind::Capture,
        E::SessionCurrent(_) | E::ArtifactCurrent(_) => Kind::Check,
        E::Request(_) | E::Reconcile(_) | E::Upload(_) => Kind::Transport,
        E::Random(_) => Kind::Random,
        E::Confirm(_) => Kind::Confirm,
    }
}
fn answers(kind: Kind, answer: &Answer) -> bool {
    match answer {
        Answer::Reply(_) | Answer::Failed(_) => kind == Kind::Transport,
        Answer::Session(_) | Answer::SessionFailed(_) => kind == Kind::Capture,
        Answer::Current(_) => kind == Kind::Check,
        Answer::Random(bytes) => {
            kind == Kind::Random && bytes.len() == 16 && bytes.iter().all(|&b| b <= 0xff)
        }
        Answer::Decision(_) => kind == Kind::Confirm,
        Answer::Withdrawn => false,
    }
}

/// The controller's state, shared by the running operation and its effects.
struct Shared {
    next_id: u64,
    issued: Vec<wire::PrintWorkflowPendingEffect>,
    pending: BTreeMap<u64, (Kind, Option<Answer>)>,
    notices: Vec<Notice>,
    phase: Phase,
    aborted: bool,
}

/// The shared state, locked only between awaits. Nothing panics while holding
/// it, so a poisoned lock still holds consistent state.
fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One effect: issued on its first poll, ready once a host answered it.
struct Ask {
    shared: Arc<Mutex<Shared>>,
    effect: Option<wire::PrintWorkflowEffect>,
    id: u64,
}
impl Future for Ask {
    type Output = Answer;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Answer> {
        let this = &mut *self;
        let mut shared = lock(&this.shared);
        if let Some(effect) = this.effect.take() {
            shared.next_id += 1;
            this.id = shared.next_id;
            let kind = kind(&effect);
            shared.issued.push(wire::PrintWorkflowPendingEffect {
                id: this.id,
                effect,
            });
            if kind == Kind::Confirm && shared.aborted {
                // `waitForDecision` on a signal that is already aborted.
                return Poll::Ready(Answer::Withdrawn);
            }
            shared.pending.insert(this.id, (kind, None));
            return Poll::Pending;
        }
        match shared.pending.get(&this.id) {
            Some((_, Some(_))) => match shared.pending.remove(&this.id) {
                Some((_, Some(answer))) => Poll::Ready(answer),
                _ => Poll::Pending,
            },
            _ => Poll::Pending,
        }
    }
}

/// `Promise.all` over effects: every one is issued, in order, before any is
/// awaited, and the answers come back in the same order.
struct All {
    asks: Vec<Ask>,
    answers: Vec<Option<Answer>>,
}
impl Future for All {
    type Output = Vec<Answer>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Vec<Answer>> {
        let this = &mut *self;
        for (ask, answer) in this.asks.iter_mut().zip(this.answers.iter_mut()) {
            if answer.is_none()
                && let Poll::Ready(ready) = Pin::new(ask).poll(cx)
            {
                *answer = Some(ready);
            }
        }
        if this.answers.iter().all(Option::is_some) {
            Poll::Ready(this.answers.iter_mut().filter_map(Option::take).collect())
        } else {
            Poll::Pending
        }
    }
}

type Reply = Result<Value, wire::TransportFailure>;

#[derive(Clone)]
struct Flow(Arc<Mutex<Shared>>);
impl Flow {
    fn ask(&self, effect: wire::PrintWorkflowEffect) -> Ask {
        Ask {
            shared: self.0.clone(),
            effect: Some(effect),
            id: 0,
        }
    }
    fn aborted(&self) -> bool {
        lock(&self.0).aborted
    }
    /// `phase(value)`: the controller's phase, and the progress notice.
    fn notice(&self, notice: Notice) {
        let mut shared = lock(&self.0);
        shared.phase = match notice {
            Notice::Checking => Phase::Checking,
            Notice::Confirming => Phase::Confirming,
            Notice::Uploading => Phase::Uploading,
            Notice::Verifying => Phase::Verifying,
            Notice::Preparing => Phase::Preparing,
            Notice::Starting => Phase::Starting,
            Notice::Completed => Phase::Completed,
        };
        shared.notices.push(notice);
    }
    /// `this.phaseValue = …`, which notifies nobody.
    fn set(&self, phase: Phase) {
        lock(&self.0).phase = phase;
    }
    async fn check(&self, effect: wire::PrintWorkflowEffect) -> bool {
        match self.ask(effect).await {
            Answer::Current(current) => current,
            _ => unreachable!("resolve admits only a flag for a currency check"),
        }
    }
    async fn transport(&self, effect: wire::PrintWorkflowEffect) -> Reply {
        match self.ask(effect).await {
            Answer::Reply(value) => Ok(value),
            Answer::Failed(failure) => Err(failure),
            _ => unreachable!("resolve admits only a reply or failure for a transport effect"),
        }
    }
    async fn send(&self, send: wire::PrinterSend) -> Reply {
        self.transport(wire::PrintWorkflowEffect::Request(send))
            .await
    }
    async fn all(&self, sends: Vec<wire::PrinterSend>) -> Vec<Reply> {
        let asks = sends
            .into_iter()
            .map(|send| self.ask(wire::PrintWorkflowEffect::Request(send)))
            .collect::<Vec<_>>();
        let answers = (0..asks.len()).map(|_| None).collect();
        All { asks, answers }
            .await
            .into_iter()
            .map(|answer| match answer {
                Answer::Reply(value) => Ok(value),
                Answer::Failed(failure) => Err(failure),
                _ => unreachable!("resolve admits only a reply or failure for a request"),
            })
            .collect()
    }
}

fn request(
    path: &str,
    method: &str,
    operation: &str,
    timeout_ms: Option<f64>,
) -> wire::PrinterSend {
    wire::PrinterSend {
        path: t(path),
        method: t(method),
        operation: t(operation),
        timeout_ms: match timeout_ms {
            Some(ms) => wire::OptionalFinite::Value(ms),
            None => wire::OptionalFinite::Absent(wire::Empty {}),
        },
    }
}
fn get(path: &str, operation: &str) -> wire::PrinterSend {
    request(path, "GET", operation, None)
}
fn metadata(filename: &[u16], operation: &str) -> wire::PrinterSend {
    get(
        &format!("/server/files/metadata?filename={}", encoded(filename)),
        operation,
    )
}
fn start(filename: &[u16], operation: &str) -> wire::PrinterSend {
    request(
        &format!("/printer/print/start?filename={}", encoded(filename)),
        "POST",
        operation,
        None,
    )
}

// --- Errors ----------------------------------------------------------------------------

/// What the browser throws: a `PrintSubmissionError`, or any other error by
/// its message alone.
enum Thrown {
    Submission(Code, Vec<u16>),
    Other(Vec<u16>),
}
fn fail(code: Code, message: &str) -> Thrown {
    Thrown::Submission(code, t(message))
}
/// A transport error that reaches the controller unchanged.
fn raw(failure: &wire::TransportFailure) -> Thrown {
    Thrown::Other(t(match failure.code {
        wire::OptionalMoonrakerErrorCode::Value(code) => moonraker_message(code),
        wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
    }))
}
/// `isCancellation`: the operation was aborted, or the transport says so.
fn cancellation(flow: &Flow, failure: Option<&wire::TransportFailure>) -> bool {
    flow.aborted()
        || failure.is_some_and(|f| {
            f.code == wire::OptionalMoonrakerErrorCode::Value(wire::MoonrakerErrorCode::Cancelled)
        })
}
fn throw_if_cancelled(flow: &Flow) -> Result<(), Thrown> {
    if flow.aborted() {
        Err(fail(Code::Cancelled, "The send was cancelled."))
    } else {
        Ok(())
    }
}

// --- Printer facts ---------------------------------------------------------------------

fn readiness_from(reply: Reply) -> wire::PrintReadiness {
    match reply {
        Ok(value) => prep::readiness_of(&value),
        Err(failure) => prep::readiness_unavailable(&wire::PrintReadinessFailure {
            transport_code: failure.code,
        }),
    }
}
/// `queryPrintReadiness`, which never fails: an unreadable state is a blocker.
async fn query_readiness(flow: &Flow) -> wire::PrintReadiness {
    readiness_from(flow.send(get(READINESS_PATH, "print_readiness")).await)
}

struct Facts {
    readiness: wire::PrintReadiness,
    slots: Option<Vec<wire::MoonrakerFilamentSlot>>,
    options: Vec<wire::PrintStartOption>,
    file_management: bool,
}
/// `readFacts`: readiness (unless the caller just read it), loaded slots and
/// capabilities, asked together; a question that fails is answered "unknown".
async fn read_facts(flow: &Flow, readiness: Option<wire::PrintReadiness>) -> Facts {
    let mut sends = Vec::with_capacity(5);
    if readiness.is_none() {
        sends.push(get(READINESS_PATH, "print_readiness"));
    }
    sends.push(get(
        "/printer/objects/query?print_task_config=&filament_detect=",
        "query_filament_slots",
    ));
    sends.push(get("/printer/objects/list", "printer_objects"));
    sends.push(get("/printer/gcode/help", "gcode_help"));
    sends.push(get("/server/info", "server_info"));
    let mut replies = flow.all(sends).await.into_iter();
    let mut next = || {
        replies.next().unwrap_or(Err(wire::TransportFailure {
            code: wire::OptionalMoonrakerErrorCode::Absent(wire::Empty {}),
            http_status: wire::OptionalFinite::Absent(wire::Empty {}),
            detail: wire::OptionalText::Absent(wire::Empty {}),
        }))
    };
    let readiness = match readiness {
        Some(readiness) => readiness,
        None => readiness_from(next()),
    };
    let slots = match next() {
        Ok(value) => match tools::filament_slots_of(&value) {
            wire::FilamentSlotsReply::Slots(slots) => Some(slots),
            wire::FilamentSlotsReply::InvalidResponse(_) => None,
        },
        Err(_) => None,
    };
    let list = |reply: Reply, parse: fn(&Value) -> wire::OptionalTextList| match reply {
        Ok(value) => parse(&value),
        Err(_) => wire::OptionalTextList::Absent(wire::Empty {}),
    };
    let report = wire::PrinterCapabilityReport {
        objects: list(next(), prep::printer_objects_of),
        commands: list(next(), prep::gcode_commands_of),
        components: list(next(), prep::server_components_of),
    };
    let file_management = matches!(
        &report.components,
        wire::OptionalTextList::Value(components) if components.contains(&t("file_manager"))
    );
    Facts {
        readiness,
        slots,
        options: prep::start_options(&report),
        file_management,
    }
}

fn slots_wire(
    slots: &Option<Vec<wire::MoonrakerFilamentSlot>>,
) -> wire::OptionalMoonrakerFilamentSlots {
    match slots {
        Some(slots) => wire::OptionalMoonrakerFilamentSlots::Value(slots.clone()),
        None => wire::OptionalMoonrakerFilamentSlots::Absent(wire::Empty {}),
    }
}
type SlotIdentity = (Vec<u16>, Option<Vec<u16>>, Vec<u16>, Vec<u16>);
/// `mappingIdentity`: what each tool would print from, compared by value.
fn mapping_identity(
    usage: &wire::GcodeToolUsage,
    slots: &Option<Vec<wire::MoonrakerFilamentSlot>>,
) -> Vec<(u64, Option<SlotIdentity>)> {
    usage
        .tools
        .iter()
        .map(|&tool| {
            let slot = slots
                .as_ref()
                .and_then(|slots| slots.iter().find(|slot| slot.slot_index == tool));
            (
                tool,
                slot.map(|slot| {
                    (
                        slot.material.clone(),
                        match &slot.sub_type {
                            wire::OptionalText::Value(sub) => Some(sub.clone()),
                            wire::OptionalText::Absent(_) => None,
                        },
                        slot.vendor.clone(),
                        slot.color_hex.clone(),
                    )
                }),
            )
        })
        .collect()
}
/// `describeTools`: the tools the artifact uses and what is loaded.
fn describe_tools(
    usage: &wire::GcodeToolUsage,
    slots: &Option<Vec<wire::MoonrakerFilamentSlot>>,
) -> Vec<u16> {
    let count = usage.tools.len();
    let tools = usage
        .tools
        .iter()
        .map(|tool| format!("T{tool}"))
        .collect::<Vec<_>>()
        .join(", ");
    let loaded = slots.as_ref().map(|slots| {
        join(
            slots.iter().map(|slot| {
                cat(&[
                    &t(&format!("H{}: ", slot.slot_index + 1)),
                    &slot.material,
                    &t(" "),
                    &slot.color_hex,
                ])
            }),
            "; ",
        )
    });
    cat(&[
        &t(&format!(
            "{count} tool{} ({tools})",
            if count == 1 { "" } else { "s" }
        )),
        &match loaded {
            Some(loaded) if !loaded.is_empty() => cat(&[&t(" · "), &loaded]),
            _ => t(" · loaded filaments not reported"),
        },
    ])
}

/// `listGcodeFilenames`: every stored path, or a refusal to guess.
async fn list_gcodes(flow: &Flow) -> Result<BTreeSet<Vec<u16>>, Thrown> {
    let listed = flow
        .send(get(
            &format!("/server/files/list?root={GCODE_ROOT}"),
            "list_gcodes",
        ))
        .await;
    let files = match &listed {
        Ok(Value::Array(entries)) => entries
            .iter()
            .map(|entry| match field(Some(entry), "path") {
                Some(Value::String(path)) if !path.is_empty() => Some(path.clone()),
                _ => None,
            })
            .collect::<Option<BTreeSet<_>>>(),
        _ => None,
    };
    files.ok_or_else(|| {
        if cancellation(flow, listed.as_ref().err()) {
            fail(Code::Cancelled, "Send cancelled.")
        } else {
            fail(
                Code::ListingFailed,
                "The printer did not report its file list. Refresh the connection before sending; no file was uploaded.",
            )
        }
    })
}

/// `readPrintFileIdentity`: a transport failure reaches the caller as it is.
async fn read_identity(flow: &Flow, filename: &[u16]) -> Result<wire::PrintFileIdentity, Thrown> {
    let value = flow
        .send(metadata(filename, "print_file_identity"))
        .await
        .map_err(|failure| raw(&failure))?;
    match prep::file_identity_of(&value, filename) {
        wire::PrintFileIdentityReply::Identity(identity) => Ok(identity),
        wire::PrintFileIdentityReply::Unreliable(text) => {
            Err(Thrown::Submission(Code::VerificationFailed, text.text))
        }
    }
}
fn same_file(a: &wire::PrintFileIdentity, b: &wire::PrintFileIdentity) -> bool {
    a.filename == b.filename && a.size == b.size && a.modified == b.modified
}

/// `reconcile`: one readiness query under its own deadline, so an uncertain
/// outcome is reported with what the printer says now. `None` when the
/// session itself changed.
async fn reconcile(flow: &Flow) -> Option<wire::PrintReadiness> {
    if !flow
        .check(wire::PrintWorkflowEffect::SessionCurrent(wire::Empty {}))
        .await
    {
        return None;
    }
    let reply = flow
        .transport(wire::PrintWorkflowEffect::Reconcile(request(
            READINESS_PATH,
            "GET",
            "print_readiness",
            Some(RECONCILE_MS),
        )))
        .await;
    Some(readiness_from(reply))
}

// --- Sending an artifact ---------------------------------------------------------------

struct Overwrite {
    allowed: bool,
    existing: Option<wire::PrintFileIdentity>,
    reason: Option<Vec<u16>>,
}
struct Plan {
    requested: Vec<u16>,
    unique: Vec<u16>,
    overwrite: Overwrite,
}

/// `preparePrintUpload`: a fresh 128-bit name, and the exact file an
/// overwrite would replace, captured before the operator is asked.
async fn prepare_upload(flow: &Flow, filename: &[u16]) -> Result<Plan, Thrown> {
    let requested = prep::sanitize_filename(filename);
    let files = list_gcodes(flow).await?;
    let mut unique = None;
    for _ in 0..16 {
        let Answer::Random(bytes) = flow
            .ask(wire::PrintWorkflowEffect::Random(wire::Empty {}))
            .await
        else {
            unreachable!("resolve admits only 16 bytes for a random draw");
        };
        let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let candidate = cat(&[
            &requested[..requested.len() - ".gcode".len()],
            &t(&format!("_{suffix}.gcode")),
        ]);
        if !files.contains(&candidate) {
            unique = Some(candidate);
            break;
        }
    }
    let Some(unique) = unique else {
        return Err(fail(
            Code::TargetChanged,
            "A unique upload name could not be reserved. Try again.",
        ));
    };
    let mut overwrite = Overwrite {
        allowed: true,
        existing: None,
        reason: None,
    };
    if files.contains(&requested) {
        overwrite = match read_identity(flow, &requested).await {
            Ok(identity) => Overwrite {
                allowed: true,
                existing: Some(identity),
                reason: None,
            },
            Err(_) => Overwrite {
                allowed: false,
                existing: None,
                reason: Some(t(
                    "The existing file metadata is unavailable. Upload with a unique name instead.",
                )),
            },
        };
    }
    throw_if_cancelled(flow)?;
    Ok(Plan {
        requested,
        unique,
        overwrite,
    })
}

/// What the operator confirmed, and what it was confirmed against.
struct Confirmed {
    start_print: bool,
    overwrite: bool,
    chosen: Vec<wire::PrintStartOptionId>,
    preparation: Vec<wire::PrintPreparationStep>,
    plan: Plan,
    options: Vec<wire::PrintStartOption>,
    mapping: Vec<(u64, Option<SlotIdentity>)>,
}

struct Sending {
    flow: Flow,
    intent: wire::PrintWorkflowIntent,
    session: bool,
    uploaded: Option<Vec<u16>>,
}
impl Sending {
    /// The controller's `assertCurrent`.
    async fn current(&self) -> Result<(), Thrown> {
        if self.flow.aborted() {
            return Err(fail(
                Code::Cancelled,
                "The send was cancelled or the printer session changed.",
            ));
        }
        if self.session
            && !self
                .flow
                .check(wire::PrintWorkflowEffect::SessionCurrent(wire::Empty {}))
                .await
        {
            return Err(fail(Code::StaleContext, LEASE_CHANGED));
        }
        if !self
            .flow
            .check(wire::PrintWorkflowEffect::ArtifactCurrent(wire::Empty {}))
            .await
        {
            return Err(fail(
                Code::StaleContext,
                "The sliced artifact is no longer current. Slice and confirm a new send.",
            ));
        }
        Ok(())
    }

    async fn run(&mut self) -> Result<Option<wire::PrintSubmissionResult>, Thrown> {
        let flow = self.flow.clone();
        flow.notice(Notice::Checking);
        self.current().await?;
        let hash = &self.intent.output_hash;
        let prefix = t("sha256:");
        if !(hash.len() == prefix.len() + 64
            && hash.starts_with(&prefix)
            && hash[prefix.len()..]
                .iter()
                .all(|&u| matches!(u, 0x30..=0x39 | 0x61..=0x66)))
        {
            return Err(fail(
                Code::StaleContext,
                "The artifact has no exact content identity.",
            ));
        }
        let label = match flow
            .ask(wire::PrintWorkflowEffect::CaptureSession(wire::Empty {}))
            .await
        {
            Answer::Session(label) => label,
            Answer::SessionFailed(message) => return Err(Thrown::Other(message)),
            _ => unreachable!("resolve admits only a session for a capture"),
        };
        self.session = true;
        self.current().await?;
        let initial = read_facts(&flow, None).await;
        self.current().await?;
        if !initial.readiness.known || !initial.file_management {
            return Err(fail(
                Code::NotReady,
                "The printer must report complete readiness and file-management support before a send can be confirmed.",
            ));
        }
        let plan = prepare_upload(&flow, &self.intent.filename).await?;
        self.current().await?;
        let usage = &self.intent.usage;
        let mapping = tools::mapping(&wire::ToolMappingRequest {
            usage: usage.clone(),
            slots: slots_wire(&initial.slots),
        });
        let initial_mapping = mapping_identity(usage, &initial.slots);
        flow.notice(Notice::Confirming);
        let readiness = &initial.readiness;
        let confirmation = wire::PrintWorkflowConfirmation {
            stored: false,
            filename: plan.unique.clone(),
            plate_name: self.intent.plate_name.clone(),
            byte_length: self.intent.byte_length,
            endpoint_label: label,
            printer_state_label: if readiness.ready {
                cat(&[&t("ready ("), &text_of(&readiness.print_state), &t(")")])
            } else {
                join(readiness.blockers.iter().map(|b| b.message.clone()), " ")
            },
            tool_summary: describe_tools(usage, &initial.slots),
            blockers: mapping
                .blockers
                .iter()
                .map(|n| n.message.clone())
                .chain(readiness.blockers.iter().map(|b| b.message.clone()))
                .collect(),
            warnings: mapping.warnings.iter().map(|n| n.message.clone()).collect(),
            start_options: initial.options.clone(),
            overwrite: wire::PrintOverwrite {
                allowed: plan.overwrite.allowed,
                existing: match &plan.overwrite.existing {
                    Some(identity) => wire::OptionalPrintFileIdentity::Value(identity.clone()),
                    None => wire::OptionalPrintFileIdentity::Absent(wire::Empty {}),
                },
                reason: optional(plan.overwrite.reason.clone()),
                filename: plan.requested.clone(),
            },
        };
        let decision = match flow
            .ask(wire::PrintWorkflowEffect::Confirm(confirmation))
            .await
        {
            Answer::Decision(decision) => decision,
            Answer::Withdrawn => return Err(fail(Code::Cancelled, "Send cancelled.")),
            _ => unreachable!("resolve admits only a decision for a confirmation"),
        };
        self.current().await?;
        if decision.choice == wire::PrintWorkflowDecisionChoice::Cancel {
            flow.set(Phase::Cancelled);
            return Ok(None);
        }
        let start_print = decision.choice == wire::PrintWorkflowDecisionChoice::UploadAndPrint;
        let preparation = if start_print {
            match prep::preparation_plan(&wire::PrintPreparationPlanRequest {
                options: initial.options.clone(),
                enabled: decision.start_options.clone(),
            }) {
                wire::PrintPreparationPlan::Steps(steps) => steps,
                wire::PrintPreparationPlan::Refused(refusal) => {
                    return Err(Thrown::Other(refusal.message));
                }
            }
        } else {
            Vec::new()
        };
        let confirmed = Confirmed {
            start_print,
            overwrite: decision.overwrite,
            chosen: decision.start_options,
            preparation,
            plan,
            options: initial.options,
            mapping: initial_mapping,
        };
        // No currency check after this: once the printer accepted what was
        // confirmed, a later session or artifact change does not undo it.
        self.submit(&confirmed).await.map(Some)
    }

    /// `submitPrintJob`'s `validate`, with the controller's own inside it.
    async fn validate(&self, job: &Confirmed, uploaded: Option<&[u16]>) -> Result<(), Thrown> {
        let flow = &self.flow;
        throw_if_cancelled(flow)?;
        let readiness = query_readiness(flow).await;
        // A query the operator cancelled reads as an unknown state; the cancel
        // is what is reported.
        throw_if_cancelled(flow)?;
        if !readiness.known || (job.start_print && !readiness.ready) {
            return Err(Thrown::Submission(
                Code::NotReady,
                cat(&[
                    &uploaded.map_or_else(Vec::new, |path| {
                        cat(&[path, &t(" is stored, but printing was not started. ")])
                    }),
                    &t("The printer cannot accept this operation: "),
                    &join(readiness.blockers.iter().map(|b| b.message.clone()), " "),
                ]),
            ));
        }
        self.current().await?;
        let current = read_facts(flow, Some(readiness)).await;
        self.current().await?;
        if !current.file_management {
            return Err(fail(
                Code::StaleContext,
                "The printer no longer reports file-management support.",
            ));
        }
        if mapping_identity(&self.intent.usage, &current.slots) != job.mapping {
            return Err(fail(
                Code::StaleContext,
                "The loaded filament mapping changed after confirmation. Review it and confirm a new send.",
            ));
        }
        if job.start_print {
            let mapping = tools::mapping(&wire::ToolMappingRequest {
                usage: self.intent.usage.clone(),
                slots: slots_wire(&current.slots),
            });
            if !mapping.blockers.is_empty() {
                return Err(Thrown::Submission(
                    Code::NotReady,
                    join(mapping.blockers.iter().map(|n| n.message.clone()), " "),
                ));
            }
            for id in &job.chosen {
                let before = job.options.iter().find(|option| option.id == *id);
                let after = current.options.iter().find(|option| option.id == *id);
                let unchanged = match (before, after) {
                    (Some(before), Some(after)) => {
                        before.available && after.available && before.command == after.command
                    }
                    _ => false,
                };
                if !unchanged {
                    return Err(fail(
                        Code::StaleContext,
                        "A chosen preparation option changed after confirmation. Confirm new options before starting.",
                    ));
                }
            }
        }
        throw_if_cancelled(flow)
    }

    /// `validatePrintUploadTarget`: the confirmed name is still free, or the
    /// confirmed file is still exactly the one to replace and is not printing.
    async fn validate_target(&self, job: &Confirmed) -> Result<(), Thrown> {
        let flow = &self.flow;
        let plan = &job.plan;
        let files = list_gcodes(flow).await?;
        if !job.overwrite {
            if files.contains(&plan.unique) {
                return Err(fail(
                    Code::TargetChanged,
                    "The unique upload name was taken after confirmation. Confirm a new send.",
                ));
            }
            return Ok(());
        }
        let changed = || {
            fail(
                Code::TargetChanged,
                "The overwrite target changed after confirmation. Review it again.",
            )
        };
        if !plan.overwrite.allowed {
            return Err(Thrown::Submission(
                Code::TargetChanged,
                plan.overwrite
                    .reason
                    .clone()
                    .unwrap_or_else(|| t("Replacing this file is unavailable.")),
            ));
        }
        if files.contains(&plan.requested) != plan.overwrite.existing.is_some() {
            return Err(changed());
        }
        if let Some(existing) = &plan.overwrite.existing
            && !same_file(existing, &read_identity(flow, &plan.requested).await?)
        {
            return Err(changed());
        }
        let readiness = query_readiness(flow).await;
        throw_if_cancelled(flow)?;
        let state = text_of(&readiness.print_state);
        let active = state == t("printing")
            || state == t("paused")
            || readiness.virtual_sd_active == wire::OptionalFlag::Value(true);
        let names_it = match &readiness.current_filename {
            wire::OptionalText::Value(name) => *name == plan.requested,
            wire::OptionalText::Absent(_) => true,
        };
        if !readiness.known || (active && names_it) {
            return Err(fail(
                Code::TargetChanged,
                "An active file cannot be replaced. Upload with a unique name instead.",
            ));
        }
        Ok(())
    }

    /// `verifyUploadedSize`.
    async fn verify_size(&self, path: &[u16]) -> Result<f64, Thrown> {
        match self.flow.send(metadata(path, "verify_upload")).await {
            Ok(value) => {
                if let Some(Value::Number(size)) = field(record(Some(&value)), "size")
                    && size.is_finite()
                {
                    return Ok(*size);
                }
            }
            Err(failure) => {
                if cancellation(&self.flow, Some(&failure)) {
                    return Err(fail(Code::Cancelled, "Upload cancelled."));
                }
            }
        }
        Err(Thrown::Submission(
            Code::VerificationFailed,
            cat(&[
                &t("The printer did not report a size for "),
                path,
                &t("; the upload could not be verified."),
            ]),
        ))
    }

    /// `validateBeforeMutation`: the stored file and readiness are re-read
    /// before every preparation step and the start.
    async fn before_mutation(
        &self,
        job: &Confirmed,
        retained: &wire::PrintFileIdentity,
        path: &[u16],
    ) -> Result<(), Thrown> {
        self.validate(job, Some(path)).await?;
        let current = read_identity(&self.flow, path).await?;
        if !same_file(retained, &current) {
            return Err(Thrown::Submission(
                Code::TargetChanged,
                cat(&[path, &t(" changed after upload. Nothing else was sent.")]),
            ));
        }
        let fresh = query_readiness(&self.flow).await;
        throw_if_cancelled(&self.flow)?;
        if !fresh.ready {
            return Err(Thrown::Submission(
                Code::NotReady,
                cat(&[
                    path,
                    &t(" is stored, but printer readiness changed. Printing was not started."),
                ]),
            ));
        }
        self.current().await?;
        throw_if_cancelled(&self.flow)
    }

    async fn submit(&mut self, job: &Confirmed) -> Result<wire::PrintSubmissionResult, Thrown> {
        let flow = self.flow.clone();
        let bytes = self.intent.byte_length;
        if bytes == 0 {
            return Err(fail(Code::EmptyArtifact, "The G-code artifact is empty."));
        }
        throw_if_cancelled(&flow)?;
        self.validate(job, None).await?;
        let requested = prep::sanitize_filename(&self.intent.filename);
        if job.plan.requested != requested {
            return Err(fail(
                Code::TargetChanged,
                "The confirmed upload target changed.",
            ));
        }
        let filename = if job.overwrite {
            job.plan.requested.clone()
        } else {
            job.plan.unique.clone()
        };
        self.validate(job, None).await?;
        self.validate_target(job).await?;
        self.current().await?;
        throw_if_cancelled(&flow)?;

        flow.notice(Notice::Uploading);
        self.current().await?;
        throw_if_cancelled(&flow)?;
        let upload = wire::PrinterUpload {
            path: t("/server/files/upload"),
            operation: t("upload_gcode"),
            root: t(GCODE_ROOT),
            directory: Vec::new(),
            print: false,
            checksum: wire::OptionalText::Value(
                self.intent.output_hash["sha256:".len()..].to_vec(),
            ),
            filename: filename.clone(),
            size: bytes,
        };
        let uploaded = match flow
            .transport(wire::PrintWorkflowEffect::Upload(upload))
            .await
        {
            Ok(value) => value,
            Err(failure) => {
                if cancellation(&flow, Some(&failure)) {
                    return Err(fail(Code::Cancelled, "Upload cancelled."));
                }
                return Err(Thrown::Submission(
                    Code::UploadFailed,
                    cat(&[
                        &t("Uploading "),
                        &filename,
                        &t(&format!(
                            " ({} MB) failed (",
                            to_fixed(bytes as f64 / 1_048_576.0, 1)
                        )),
                        &prep::describe_failure(&failure),
                        &t("). Nothing was started; the printer may hold a partial file."),
                    ]),
                ));
            }
        };
        let item = record(field(record(Some(&uploaded)), "item"));
        let is_text = |value: Option<&Value>, expected: &[u16]| matches!(value, Some(Value::String(s)) if s == expected);
        let is_false = |value: Option<&Value>| matches!(value, Some(Value::Bool(false)));
        if !(item.is_some()
            && is_text(field(item, "root"), &t(GCODE_ROOT))
            && is_text(field(item, "path"), &filename)
            && matches!(field(item, "size"), Some(Value::Number(n)) if *n == bytes as f64)
            && is_false(field(Some(&uploaded), "print_started"))
            && is_false(field(Some(&uploaded), "print_queued")))
        {
            return Err(fail(
                Code::VerificationFailed,
                "The upload response did not confirm the requested root, path, byte count, and upload-only mode. Check the printer before trying again.",
            ));
        }
        let path = filename;
        self.uploaded = Some(path.clone());
        flow.notice(Notice::Verifying);
        throw_if_cancelled(&flow)?;
        let verified = self.verify_size(&path).await?;
        if verified != bytes as f64 {
            return Err(fail(
                Code::VerificationFailed,
                &format!(
                    "The printer stored {} bytes but {bytes} were sent; the job was not started.",
                    number_to_string(verified)
                ),
            ));
        }

        self.validate(job, Some(&path)).await?;
        let mut started = false;
        if job.start_print {
            let retained = read_identity(&flow, &path).await?;
            for step in &job.preparation {
                flow.notice(Notice::Preparing);
                // `executePrintPreparationStep`, and the uncertainty it reports.
                self.before_mutation(job, &retained, &path).await?;
                if flow.aborted() {
                    return Err(Thrown::Other(t(moonraker_message(
                        wire::MoonrakerErrorCode::Cancelled,
                    ))));
                }
                if flow.send(prep::preparation_send(step)).await.is_err() {
                    return Err(Thrown::Submission(
                        Code::PreparationUncertain,
                        cat(&[
                            &path,
                            &t(" is stored. The "),
                            &step.label,
                            &t(
                                " request has an uncertain outcome; check fresh printer status before trying again. Nothing was retried.",
                            ),
                        ]),
                    ));
                }
            }
            self.before_mutation(job, &retained, &path).await?;
            flow.notice(Notice::Starting);
            self.current().await?;
            throw_if_cancelled(&flow)?;
            if flow.send(start(&path, "start_print")).await.is_err() {
                return Err(Thrown::Submission(
                    Code::StartUncertain,
                    cat(&[
                        &path,
                        &t(
                            " is stored. The print-start request has an uncertain outcome; check fresh printer status before trying again. It was not retried.",
                        ),
                    ]),
                ));
            }
            started = true;
        }

        flow.notice(Notice::Completed);
        Ok(wire::PrintSubmissionResult {
            renamed_from: optional((path != requested).then_some(requested)),
            path,
            root: t(GCODE_ROOT),
            uploaded_bytes: bytes,
            verified_bytes: bytes,
            started_print: started,
        })
    }
}

fn text_of(text: &wire::OptionalText) -> Vec<u16> {
    match text {
        wire::OptionalText::Value(text) => text.clone(),
        wire::OptionalText::Absent(_) => Vec::new(),
    }
}

/// `run`'s catch: the phase it ends in, a fresh state for an uncertain
/// outcome, the file left behind, and the code.
async fn send_artifact(flow: Flow, intent: wire::PrintWorkflowIntent) -> wire::PrintWorkflowState {
    let mut send = Sending {
        flow: flow.clone(),
        intent,
        session: false,
        uploaded: None,
    };
    let error = match send.run().await {
        Ok(Some(result)) => return wire::PrintWorkflowState::Submitted(result),
        Ok(None) => return wire::PrintWorkflowState::Declined(wire::Empty {}),
        Err(error) => error,
    };
    let (code, message) = match error {
        Thrown::Submission(code, message) => (Some(code), message),
        Thrown::Other(message) => (None, message),
    };
    let uncertain = matches!(
        code,
        Some(Code::PreparationUncertain | Code::StartUncertain)
    );
    flow.set(if uncertain {
        Phase::Uncertain
    } else if flow.aborted() {
        Phase::Cancelled
    } else {
        Phase::Failed
    });
    let status = if uncertain && send.session {
        reconcile(&flow).await
    } else {
        None
    };
    let retained = send.uploaded.map_or_else(Vec::new, |path| {
        cat(&[&t(" Uploaded file: "), &path, &t(".")])
    });
    let reconciled = match status {
        Some(status) if status.known => cat(&[
            &t(" Fresh printer state: "),
            &text_of(&status.print_state),
            &match &status.current_filename {
                wire::OptionalText::Value(name) => cat(&[&t(" ("), name, &t(")")]),
                wire::OptionalText::Absent(_) => Vec::new(),
            },
            &t("."),
        ]),
        _ if uncertain => t(" Current printer state could not be verified."),
        _ => Vec::new(),
    };
    wire::PrintWorkflowState::Failed(wire::PrintWorkflowFailure {
        code: code.unwrap_or(if flow.aborted() {
            Code::Cancelled
        } else {
            Code::StaleContext
        }),
        message: cat(&[&message, &retained, &reconciled]),
    })
}

// --- Starting a stored file ------------------------------------------------------------

fn stored_cancelled(flow: &Flow) -> Result<(), Thrown> {
    if flow.aborted() {
        Err(fail(
            Code::Cancelled,
            "Print cancelled or printer session changed.",
        ))
    } else {
        Ok(())
    }
}
/// `startStored`'s `assertCurrent`, whose lease error passes through as is.
/// The abort is checked again once the session answered: a cancel can land
/// while the host is asking, and the start request is the next thing sent.
async fn stored_current(flow: &Flow) -> Result<(), Thrown> {
    stored_cancelled(flow)?;
    if !flow
        .check(wire::PrintWorkflowEffect::SessionCurrent(wire::Empty {}))
        .await
    {
        return Err(Thrown::Other(t(LEASE_CHANGED)));
    }
    stored_cancelled(flow)
}

async fn reprint(
    flow: &Flow,
    filename: &[u16],
    session: &mut bool,
) -> Result<Option<Vec<u16>>, Thrown> {
    flow.set(Phase::Checking);
    let label = match flow
        .ask(wire::PrintWorkflowEffect::CaptureSession(wire::Empty {}))
        .await
    {
        Answer::Session(label) => label,
        Answer::SessionFailed(message) => return Err(Thrown::Other(message)),
        _ => unreachable!("resolve admits only a session for a capture"),
    };
    *session = true;
    stored_current(flow).await?;
    let readiness = query_readiness(flow).await;
    stored_cancelled(flow)?;
    if !readiness.ready {
        return Err(fail(
            Code::NotReady,
            "The printer must report a ready, idle state before reprinting.",
        ));
    }
    let original = read_identity(flow, filename).await?;
    stored_current(flow).await?;
    flow.set(Phase::Confirming);
    let confirmation = wire::PrintWorkflowConfirmation {
        stored: true,
        filename: filename.to_vec(),
        plate_name: t("Stored file"),
        byte_length: original.size as u64,
        endpoint_label: label,
        printer_state_label: text_of(&readiness.print_state),
        tool_summary: t("Use the filament requirements recorded in this stored G-code."),
        blockers: Vec::new(),
        warnings: vec![t(
            "Check that the loaded filaments match this file before starting.",
        )],
        start_options: Vec::new(),
        overwrite: wire::PrintOverwrite {
            allowed: false,
            existing: wire::OptionalPrintFileIdentity::Value(original.clone()),
            reason: wire::OptionalText::Absent(wire::Empty {}),
            filename: filename.to_vec(),
        },
    };
    let decision = match flow
        .ask(wire::PrintWorkflowEffect::Confirm(confirmation))
        .await
    {
        Answer::Decision(decision) => decision,
        Answer::Withdrawn => return Err(fail(Code::Cancelled, "Send cancelled.")),
        _ => unreachable!("resolve admits only a decision for a confirmation"),
    };
    stored_current(flow).await?;
    if decision.choice != wire::PrintWorkflowDecisionChoice::UploadAndPrint {
        flow.set(Phase::Cancelled);
        return Ok(None);
    }
    if !same_file(&original, &read_identity(flow, filename).await?) {
        return Err(fail(
            Code::TargetChanged,
            "The stored file changed after confirmation. Review it again.",
        ));
    }
    let fresh = query_readiness(flow).await;
    stored_cancelled(flow)?;
    if !fresh.ready {
        return Err(fail(
            Code::NotReady,
            "Printer readiness changed after confirmation. Printing was not started.",
        ));
    }
    stored_current(flow).await?;
    flow.set(Phase::Starting);
    if flow
        .send(start(filename, "start_stored_print"))
        .await
        .is_err()
    {
        return Err(fail(
            Code::StartUncertain,
            "The print-start request has an uncertain outcome. It was not retried.",
        ));
    }
    // Once the printer accepted the start, it has started.
    flow.set(Phase::Completed);
    Ok(Some(filename.to_vec()))
}

async fn start_stored(flow: Flow, filename: Vec<u16>) -> wire::PrintWorkflowState {
    let mut session = false;
    let error = match reprint(&flow, &filename, &mut session).await {
        Ok(Some(path)) => {
            return wire::PrintWorkflowState::Started(wire::PrinterText { text: path });
        }
        Ok(None) => return wire::PrintWorkflowState::Declined(wire::Empty {}),
        Err(error) => error,
    };
    let (code, message) = match error {
        Thrown::Submission(code, message) => (Some(code), message),
        Thrown::Other(message) => (None, message),
    };
    let uncertain = code == Some(Code::StartUncertain);
    flow.set(if uncertain {
        Phase::Uncertain
    } else if flow.aborted() {
        Phase::Cancelled
    } else {
        Phase::Failed
    });
    let status = if uncertain && session {
        reconcile(&flow).await
    } else {
        None
    };
    let reconciled = match status {
        Some(status) if status.known => cat(&[
            &t(" Fresh printer state: "),
            &text_of(&status.print_state),
            &t("."),
        ]),
        _ if uncertain => t(" Current printer state could not be verified."),
        _ => Vec::new(),
    };
    wire::PrintWorkflowState::Failed(wire::PrintWorkflowFailure {
        code: code.unwrap_or(if flow.aborted() {
            Code::Cancelled
        } else {
            Code::StaleContext
        }),
        message: cat(&[&message, &reconciled]),
    })
}

// --- The controller --------------------------------------------------------------------

type Operation = Pin<Box<dyn Future<Output = wire::PrintWorkflowState> + Send>>;

/// `PrintWorkflowController`: one operation at a time, shared by every
/// surface, cancellable at any point.
pub struct PrintWorkflow {
    shared: Arc<Mutex<Shared>>,
    operation: Option<Operation>,
    disposed: bool,
}
impl Default for PrintWorkflow {
    fn default() -> Self {
        Self::new()
    }
}
impl PrintWorkflow {
    pub fn new() -> Self {
        PrintWorkflow {
            shared: Arc::new(Mutex::new(Shared {
                next_id: 0,
                issued: Vec::new(),
                pending: BTreeMap::new(),
                notices: Vec::new(),
                phase: Phase::Idle,
                aborted: false,
            })),
            operation: None,
            disposed: false,
        }
    }
    pub fn busy(&self) -> bool {
        self.operation.is_some()
    }
    pub fn phase(&self) -> Phase {
        lock(&self.shared).phase
    }

    /// Send a sliced artifact: confirm, upload, verify, and optionally prepare
    /// and start it.
    pub fn run(
        &mut self,
        intent: wire::PrintWorkflowIntent,
    ) -> Result<wire::PrintWorkflowStep, Refusal> {
        if self.disposed || self.busy() {
            return Err(Refusal::Unavailable);
        }
        let flow = Flow(self.shared.clone());
        Ok(self.begin(Box::pin(send_artifact(flow, intent))))
    }

    /// Start a file already stored on the printer, after its own confirmation.
    pub fn start_stored(&mut self, path: &[u16]) -> Result<wire::PrintWorkflowStep, Refusal> {
        if self.disposed || self.busy() {
            return Err(Refusal::Unavailable);
        }
        match storage_path(path, "That file") {
            Ok(filename) => {
                let flow = Flow(self.shared.clone());
                Ok(self.begin(Box::pin(start_stored(flow, filename))))
            }
            // Refused before the operation exists, as the browser throws it.
            Err(message) => Ok(self.step(wire::PrintWorkflowState::Failed(
                wire::PrintWorkflowFailure {
                    code: Code::InvalidTarget,
                    message,
                },
            ))),
        }
    }

    /// Answer one effect.
    pub fn resolve(
        &mut self,
        id: u64,
        outcome: wire::PrintWorkflowOutcome,
    ) -> Result<wire::PrintWorkflowStep, Refusal> {
        use wire::PrintWorkflowOutcome as O;
        self.answer(
            id,
            match outcome {
                O::Session(label) => Answer::Session(label.text),
                O::SessionFailed(message) => Answer::SessionFailed(message.text),
                O::Current(current) => Answer::Current(current),
                O::Failed(failure) => Answer::Failed(failure),
                O::Random(bytes) => Answer::Random(bytes),
                O::Decision(decision) => Answer::Decision(decision),
            },
        )
    }
    /// Answer a request or upload with the reply the transport returned
    /// (Moonraker's `result`, as JSON). A reply that is not JSON is what the
    /// transport refuses as `invalid_response`.
    pub fn resolve_reply(
        &mut self,
        id: u64,
        text: &str,
    ) -> Result<wire::PrintWorkflowStep, Refusal> {
        self.answer(
            id,
            match parse_javascript(text, LIMITS) {
                Ok(value) => Answer::Reply(value),
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

    /// Abort the running operation; an open confirmation is withdrawn at once.
    pub fn cancel(&mut self) -> wire::PrintWorkflowStep {
        if self.operation.is_some() {
            let mut shared = lock(&self.shared);
            shared.aborted = true;
            for (kind, answer) in shared.pending.values_mut() {
                if *kind == Kind::Confirm && answer.is_none() {
                    *answer = Some(Answer::Withdrawn);
                }
            }
        }
        self.advance()
    }
    pub fn dispose(&mut self) -> wire::PrintWorkflowStep {
        self.disposed = true;
        self.cancel()
    }

    fn answer(&mut self, id: u64, answer: Answer) -> Result<wire::PrintWorkflowStep, Refusal> {
        if self.operation.is_none() {
            return Err(Refusal::NotPending);
        }
        {
            let mut shared = lock(&self.shared);
            let Some((kind, slot)) = shared.pending.get_mut(&id) else {
                return Err(Refusal::NotPending);
            };
            if slot.is_some() {
                return Err(Refusal::NotPending);
            }
            if !answers(*kind, &answer) {
                return Err(Refusal::Mismatch);
            }
            *slot = Some(answer);
        }
        Ok(self.advance())
    }
    fn begin(&mut self, operation: Operation) -> wire::PrintWorkflowStep {
        {
            let mut shared = lock(&self.shared);
            shared.aborted = false;
            shared.pending.clear();
        }
        self.operation = Some(operation);
        self.advance()
    }
    /// Run the operation until it waits on an effect or ends.
    fn advance(&mut self) -> wire::PrintWorkflowStep {
        let state = match self.operation.as_mut() {
            None => wire::PrintWorkflowState::Idle(wire::Empty {}),
            Some(operation) => {
                match operation
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                {
                    Poll::Pending => wire::PrintWorkflowState::Pending(wire::Empty {}),
                    Poll::Ready(state) => {
                        self.operation = None;
                        // An effect nobody awaits any more (a withdrawn
                        // confirmation) can no longer be answered.
                        lock(&self.shared).pending.clear();
                        state
                    }
                }
            }
        };
        self.step(state)
    }
    fn step(&self, state: wire::PrintWorkflowState) -> wire::PrintWorkflowStep {
        let mut shared = lock(&self.shared);
        wire::PrintWorkflowStep {
            phase: shared.phase,
            phases: std::mem::take(&mut shared.notices),
            effects: std::mem::take(&mut shared.issued),
            state,
        }
    }
}
