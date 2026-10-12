//! The external slicer's policy shared by every host (`web/src/slicer`:
//! `ExternalEngineAttestation.ts`, `ExternalSlicerJobs.ts`): a captured
//! endpoint made canonical; what an engine attestation sends and how its reply
//! reads against the pinned build; what submitting a project and each step of
//! its job send; and how a submission, a status poll, a cancellation and an
//! artifact download read. Hosts own the transport, the bearer token, the
//! poll interval (the browser waits 700 ms) and the cancellation deadline
//! (30 s); they decode each reply body as UTF-8 text, and stream a downloaded
//! artifact once for the facts it is judged by — its length, SHA-256, whether
//! it is UTF-8, and whether that text is blank — so G-code never crosses into
//! the core.
use crate::reply::{LIMITS, Value, field, joined, units};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::convert::trim_utf16;
use std::sync::OnceLock;
use url::Url;
use wire::ExternalSlicerFailureKind as Kind;

/// Where a project is submitted, after the canonical endpoint.
pub const SUBMISSION_PATH: &str = "/slice?async=1";
/// Consecutive status poll failures after which the server is taken to have stopped responding.
pub const MAX_POLL_FAILURES: u64 = 5;
/// How long releasing a validated result may take before the server is left to expire it.
pub const RELEASE_TIMEOUT_MS: f64 = 1000.0;
/// How many times a finished job's artifact is fetched before its download
/// fails. The server keeps a result until it is released or expires and
/// serves it as often as it is asked (a transfer in progress holds it), so a
/// transfer that dropped, came up short or did not match its checksum is
/// fetched again, not sliced again.
pub const MAX_DOWNLOAD_ATTEMPTS: u64 = 3;

const INVALID_ENDPOINT: &str = "The captured external slicer endpoint is invalid.";
const NOT_CANONICAL: &str =
    "Canonical external slicer URLs cannot contain credentials, query parameters, or fragments.";
const INVALID_JOB_ID: &str = "The external slicer returned an invalid job ID.";
const UNCONFIRMED: &str = "Could not confirm external slice cancellation: ";
const UNREADABLE_REPLY: &str = "The server returned an unreadable reply.";
const CANCELLATION_TIMED_OUT: &str = "External slice cancellation confirmation timed out.";
const NOT_UTF8: &str = "External slicer returned an artifact that is not valid UTF-8 text.";

// --- The pinned build ------------------------------------------------------------------------

/// The engine build this client accepts for canonical work, as
/// `pinnedEngineProvenance.ts` pins it (`contracts/pinned-engine-provenance.json`,
/// written and checked by `external-slicer-vectors.mjs`). A WASM server must
/// run exactly these artifacts; a CLI server the pinned commit with exactly
/// these patches.
#[derive(Debug)]
pub struct PinnedProvenance {
    pub commit: String,
    /// The Snapmaker Orca release the CLI engine is built from.
    pub cli_version: String,
    /// WASM artifacts by name and SHA-256, in the order they are compared.
    pub artifacts: Vec<(String, String)>,
    /// `server/patches/` by name and SHA-256, in the order they are applied.
    pub cli_patches: Vec<(String, String)>,
    /// Features each attested engine carries beyond stock Snapmaker Orca.
    pub wasm_features: Vec<String>,
    pub cli_features: Vec<String>,
}

pub fn pinned() -> &'static PinnedProvenance {
    static PINNED: OnceLock<PinnedProvenance> = OnceLock::new();
    PINNED.get_or_init(|| {
        let value = parse_javascript(
            include_str!("../../../../contracts/pinned-engine-provenance.json"),
            LIMITS,
        )
        .expect("the pinned engine provenance is JSON");
        let text = |value: Option<&Value>| match value {
            Some(Value::String(s)) => String::from_utf16(s).expect("pinned text is UTF-16"),
            _ => panic!("the pinned engine provenance names every field"),
        };
        let pairs = |name: &str| match field(&value, name) {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| (text(field(item, "name")), text(field(item, "sha256"))))
                .collect(),
            _ => panic!("the pinned engine provenance lists {name}"),
        };
        let features = |engine: &str| match field(&value, "features").and_then(|f| field(f, engine))
        {
            Some(Value::Array(items)) => items.iter().map(|item| text(Some(item))).collect(),
            _ => panic!("the pinned engine provenance lists {engine} features"),
        };
        PinnedProvenance {
            commit: text(field(&value, "commit")),
            cli_version: text(field(&value, "cliVersion")),
            artifacts: pairs("artifacts"),
            cli_patches: pairs("cliPatches"),
            wasm_features: features("wasm"),
            cli_features: features("cli"),
        }
    })
}

/// `engineSupports`: whether the attested [engine] carries [feature] (e.g. `wave-overhangs`).
pub fn engine_supports(engine: wire::ExternalSlicerEngine, feature: &str) -> bool {
    let features = match engine {
        wire::ExternalSlicerEngine::Wasm => &pinned().wasm_features,
        wire::ExternalSlicerEngine::Cli => &pinned().cli_features,
    };
    features.iter().any(|f| f == feature)
}

// --- Reading replies -------------------------------------------------------------------------

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}
/// `JSON.parse` over a reply body; `None` is the `SyntaxError`.
fn parse(body: &[u16]) -> Option<Value> {
    parse_javascript(&lossy(body), LIMITS).ok()
}
/// `typeof value === 'object' && value !== null`: arrays count.
fn object(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}
fn is_text(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(s)) if *s == units(text))
}
/// Text an operator reads, or nothing when it is not text or is blank.
fn said(value: Option<&Value>) -> Option<&[u16]> {
    match value {
        Some(Value::String(s)) if !trim_utf16(s).is_empty() => Some(s),
        _ => None,
    }
}
fn succeeded(status: u64) -> bool {
    (200..=299).contains(&status)
}
fn http(status: u64) -> Vec<u16> {
    units(&format!("HTTP {status}"))
}
/// `/^[a-f0-9]{64}$/`.
fn is_digest(text: &[u16]) -> bool {
    text.len() == 64 && text.iter().all(|&u| matches!(u, 0x30..=0x39 | 0x61..=0x66))
}
/// `/^[A-Za-z0-9_-]{1,128}$/`: an ID a job URL can carry as it is.
fn is_job_id(text: &[u16]) -> bool {
    (1..=128).contains(&text.len())
        && text.iter().all(|&u| {
            u < 0x80 && matches!(u as u8, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')
        })
}
fn read_optional(value: &wire::OptionalText) -> Option<&[u16]> {
    match value {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}
fn failure(kind: Kind, message: Vec<u16>) -> wire::ExternalSlicerFailure {
    wire::ExternalSlicerFailure { kind, message }
}
fn send(
    method: &str,
    url: Vec<u16>,
    operation: &str,
    timeout_ms: Option<f64>,
) -> wire::ExternalSlicerSend {
    wire::ExternalSlicerSend {
        method: units(method),
        url,
        operation: units(operation),
        timeout_ms: match timeout_ms {
            Some(ms) => wire::OptionalFinite::Value(ms),
            None => wire::OptionalFinite::Absent(wire::Empty {}),
        },
    }
}
/// A refusal's body as its sentence; a blank one reads as its status.
fn refusal(status: u64, body: &[u16]) -> Vec<u16> {
    let reason = if trim_utf16(body).is_empty() {
        http(status)
    } else {
        body.to_vec()
    };
    joined(&[&units("External Slicer Failed: "), &reason])
}

// --- Endpoints -------------------------------------------------------------------------------

/// `normalizeHttpEndpoint`: the trimmed text with its scheme (HTTP when it
/// names none, bracketed when it is a bare IPv6 address) and without trailing
/// slashes, when the URL parser reads it as HTTP(S); nothing otherwise. The
/// text is kept as typed, not as the parser serializes it.
fn normalize_http_endpoint(value: &[u16]) -> Option<Vec<u16>> {
    let trimmed = trim_utf16(value);
    if trimmed.is_empty() {
        return None;
    }
    // `/^[a-z][a-z\d+.-]*:\/\//i`
    let scheme_char = |u: u16| {
        u < 0x80 && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'.' | b'-')
    };
    let has_scheme = trimmed
        .first()
        .is_some_and(|&u| u < 0x80 && (u as u8).is_ascii_alphabetic())
        && {
            let end = trimmed
                .iter()
                .position(|&u| !scheme_char(u))
                .unwrap_or(trimmed.len());
            trimmed[end..].starts_with(&units("://"))
        };
    let colons = trimmed.iter().filter(|&&u| u == u16::from(b':')).count();
    let bare_ipv6 = !has_scheme && colons > 1 && trimmed.first() != Some(&u16::from(b'['));
    let candidate = if has_scheme {
        trimmed.to_vec()
    } else if bare_ipv6 {
        joined(&[&units("http://["), trimmed, &units("]")])
    } else {
        joined(&[&units("http://"), trimmed])
    };
    // `new URL` reads a scalar-value string: a lone surrogate is U+FFFD.
    let parsed = Url::parse(&lossy(&candidate)).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let end = candidate
        .iter()
        .rposition(|&u| u != u16::from(b'/'))
        .map_or(0, |at| at + 1);
    Some(candidate[..end].to_vec())
}

/// `canonicalExternalEndpoint`: the endpoint a captured address names, or why
/// none can be made from it.
fn canonical_endpoint(input: &[u16]) -> Result<Vec<u16>, &'static str> {
    let normalized = normalize_http_endpoint(input).ok_or(INVALID_ENDPOINT)?;
    let endpoint = Url::parse(&lossy(&normalized)).map_err(|_| INVALID_ENDPOINT)?;
    let has = |part: Option<&str>| part.is_some_and(|p| !p.is_empty());
    if !endpoint.username().is_empty()
        || has(endpoint.password())
        || has(endpoint.query())
        || has(endpoint.fragment())
        || normalized
            .iter()
            .any(|&u| u == u16::from(b'?') || u == u16::from(b'#'))
    {
        return Err(NOT_CANONICAL);
    }
    Ok(normalized)
}

/// The canonical endpoint a captured address names, or why none can be made from it.
pub fn endpoint(request: &wire::ExternalSlicerEndpointRequest) -> wire::ExternalSlicerEndpoint {
    match canonical_endpoint(&request.input) {
        Ok(endpoint) => wire::ExternalSlicerEndpoint::Endpoint(endpoint),
        Err(message) => wire::ExternalSlicerEndpoint::Refused(units(message)),
    }
}

// --- Engine attestation ----------------------------------------------------------------------

const UNREACHABLE: &str = "The external slicer could not be reached to check its engine.";

/// What attesting a captured address sends (`GET /engine`), or — when no
/// request can be made — how the attestation reads: as unreachable.
pub fn attestation_plan(
    request: &wire::ExternalSlicerEndpointRequest,
) -> wire::ExternalSlicerAttestationPlan {
    match canonical_endpoint(&request.input) {
        Ok(endpoint) => wire::ExternalSlicerAttestationPlan::Send(send(
            "GET",
            joined(&[&endpoint, &units("/engine")]),
            "engine_attestation",
            None,
        )),
        Err(_) => wire::ExternalSlicerAttestationPlan::Unattested(units(UNREACHABLE)),
    }
}

/// `readEngineAttestation`: an attestation reply read against the pinned build.
pub fn attestation(reply: &wire::ExternalSlicerReply) -> wire::ExternalSlicerAttestation {
    use wire::ExternalSlicerAttestation as Attestation;
    match attested(reply) {
        Ok(attested) => Attestation::Attested(attested),
        Err(reason) => Attestation::Unattested(reason),
    }
}

fn attested(reply: &wire::ExternalSlicerReply) -> Result<wire::ExternalSlicerAttested, Vec<u16>> {
    let refuse = |reason: &str| Err(units(reason));
    let response = match reply {
        wire::ExternalSlicerReply::Failed(_) => return refuse(UNREACHABLE),
        wire::ExternalSlicerReply::Response(response) => response,
    };
    if !succeeded(response.status) {
        // An old server has no /engine route at all; a secured one wants a token first.
        if response.status == 401 || response.status == 403 {
            return refuse(
                "The external slicer requires a token before it will report its engine.",
            );
        }
        return refuse(&format!(
            "The external slicer did not report its engine provenance (HTTP {}); update the slicer server to a build that serves /engine.",
            response.status
        ));
    }
    // A 2xx reply that is not JSON never reached the attestation.
    let Some(record) = parse(&response.body) else {
        return refuse(UNREACHABLE);
    };
    if !object(&record) {
        return refuse("The external slicer returned a malformed engine attestation.");
    }
    if !matches!(field(&record, "attested"), Some(Value::Bool(true))) {
        // A blank reason reads as none, not as an empty refusal.
        return Err(match said(field(&record, "reason")) {
            Some(reason) => reason.to_vec(),
            None => units("It reported no verifiable engine build."),
        });
    }
    let engine = if is_text(field(&record, "engine"), "wasm") {
        wire::ExternalSlicerEngine::Wasm
    } else if is_text(field(&record, "engine"), "cli") {
        wire::ExternalSlicerEngine::Cli
    } else {
        return refuse("The external slicer reported an unsupported engine attestation.");
    };
    if !matches!(field(&record, "schemaVersion"), Some(Value::Number(v)) if *v == 1.0) {
        return refuse("The external slicer reported an unsupported engine attestation.");
    }
    let artifacts = match field(&record, "artifacts") {
        Some(artifacts) if object(artifacts) => artifacts,
        _ => return refuse("The external slicer attested no engine artifacts."),
    };
    let pinned = pinned();
    let commit = field(&record, "upstream").and_then(|upstream| field(upstream, "commit"));
    if !is_text(commit, &pinned.commit) {
        return refuse("The external slicer reports a different pinned engine commit.");
    }
    match engine {
        wire::ExternalSlicerEngine::Wasm => compare_wasm_artifacts(artifacts)?,
        wire::ExternalSlicerEngine::Cli => compare_cli_patches(field(&record, "patches"))?,
    }
    let name = match engine {
        wire::ExternalSlicerEngine::Wasm => "slic3r.wasm",
        wire::ExternalSlicerEngine::Cli => "snapmaker-orca",
    };
    match field(artifacts, name) {
        Some(Value::String(digest)) if is_digest(digest) => Ok(wire::ExternalSlicerAttested {
            commit: units(&pinned.commit),
            artifact_hash: joined(&[&units("sha256:"), digest]),
            engine,
        }),
        _ => refuse("The external slicer reported no complete engine artifact digest."),
    }
}

/// A WASM server must run byte-identical artifacts to the ones this client verified.
fn compare_wasm_artifacts(declared: &Value) -> Result<(), Vec<u16>> {
    for (name, digest) in &pinned().artifacts {
        if !is_text(field(declared, name), digest) {
            return Err(units(&format!(
                "The external slicer runs a different {name} than this build verified."
            )));
        }
    }
    Ok(())
}

/// A CLI server must run the pinned commit with exactly the patches this
/// build knows; an unknown or altered patch is named, not tolerated.
fn compare_cli_patches(reported: Option<&Value>) -> Result<(), Vec<u16>> {
    let Some(Value::Array(entries)) = reported else {
        return Err(units(
            "The external slicer did not report which engine patches it was built with.",
        ));
    };
    let mut applied: Vec<(&[u16], Option<&Value>)> = Vec::with_capacity(entries.len());
    for entry in entries {
        if !object(entry) {
            return Err(units(
                "The external slicer reported a malformed engine patch.",
            ));
        }
        match field(entry, "name") {
            Some(Value::String(name))
                if !applied.iter().any(|(seen, _)| *seen == name.as_slice()) =>
            {
                applied.push((name, field(entry, "sha256")));
            }
            _ => {
                return Err(units(
                    "The external slicer reported malformed or duplicate engine patches.",
                ));
            }
        }
    }
    let pinned = &pinned().cli_patches;
    for (name, digest) in pinned {
        let wanted = units(name);
        match applied.iter().find(|(seen, _)| *seen == wanted.as_slice()) {
            None => {
                return Err(units(&format!(
                    "The external slicer was built without the {name} engine patch."
                )));
            }
            Some((_, sha256)) if !is_text(*sha256, digest) => {
                return Err(units(&format!(
                    "The external slicer carries a different {name} than this build pins."
                )));
            }
            Some(_) => {}
        }
    }
    // Own names only: a name `Object.prototype` carries is as unknown as any other.
    for (name, _) in &applied {
        if !pinned.iter().any(|(known, _)| units(known) == *name) {
            return Err(joined(&[
                &units("The external slicer carries an engine patch this build does not know: "),
                name,
                &units("."),
            ]));
        }
    }
    Ok(())
}

// --- Jobs ------------------------------------------------------------------------------------

/// What submitting a project to a captured address sends (the project archive
/// and its overrides as multipart form fields, which the host builds).
pub fn submit_plan(request: &wire::ExternalSlicerEndpointRequest) -> wire::ExternalSlicerPlan {
    match canonical_endpoint(&request.input) {
        Ok(endpoint) => wire::ExternalSlicerPlan::Send(send(
            "POST",
            joined(&[&endpoint, &units(SUBMISSION_PATH)]),
            "slice_submit",
            None,
        )),
        Err(message) => wire::ExternalSlicerPlan::Refused(failure(Kind::Failed, units(message))),
    }
}

/// What one step of a job sends to the canonical endpoint it was submitted
/// to: a status poll, the artifact download, a cancellation (its status polls
/// are status steps) or a release. A job ID no URL can carry sends nothing:
/// the poll fails, the cancellation is unconfirmed, the release is skipped.
pub fn job_plan(request: &wire::ExternalSlicerJobRequest) -> wire::ExternalSlicerPlan {
    use wire::ExternalSlicerJobStep as Step;
    if !is_job_id(&request.job_id) {
        return wire::ExternalSlicerPlan::Refused(match request.step {
            Step::Cancel => failure(
                Kind::Unconfirmed,
                joined(&[&units(UNCONFIRMED), &units(INVALID_JOB_ID)]),
            ),
            _ => failure(Kind::Failed, units(INVALID_JOB_ID)),
        });
    }
    let url = joined(&[&request.endpoint, &units("/jobs/"), &request.job_id]);
    wire::ExternalSlicerPlan::Send(match request.step {
        Step::Status => send("GET", url, "slice_status", None),
        Step::Artifact => send(
            "GET",
            joined(&[&url, &units("/gcode")]),
            "slice_artifact",
            None,
        ),
        Step::Cancel => send("DELETE", url, "slice_cancel", None),
        Step::Release => send("DELETE", url, "slice_release", Some(RELEASE_TIMEOUT_MS)),
    })
}

/// `readSubmission`: a submission's reply (and its `X-OrcaXR-Job-Id`), when
/// the slice was or was not aborted while the upload was in flight — a job to
/// poll, a job to cancel, an artifact to read (a server without jobs), or a failure.
pub fn submission(read: &wire::ExternalSlicerSubmitRead) -> wire::ExternalSlicerSubmission {
    use wire::ExternalSlicerSubmission as Submission;
    let aborted = read.aborted;
    let response = match &read.reply {
        wire::ExternalSlicerSubmitReply::Failed(detail) => {
            return Submission::Failed(if aborted {
                failure(
                    Kind::Unconfirmed,
                    joined(&[
                        &units("External upload ended before a cancellable job ID was received: "),
                        detail,
                    ]),
                )
            } else {
                failure(Kind::Failed, detail.clone())
            });
        }
        wire::ExternalSlicerSubmitReply::Response(response) => response,
    };
    if response.status == 202 {
        // Not JSON, or not an object, names no job.
        let payload = parse(&response.body);
        let job = payload.as_ref().and_then(|payload| field(payload, "job"));
        return match job {
            Some(Value::String(job)) if !job.is_empty() => {
                if aborted {
                    Submission::Cancel(job.clone())
                } else {
                    Submission::Job(job.clone())
                }
            }
            _ if aborted => Submission::Failed(failure(
                Kind::Unconfirmed,
                units(
                    "External slicer returned no usable job ID, so cancellation could not be confirmed.",
                ),
            )),
            _ => Submission::Failed(failure(
                Kind::Failed,
                units("External slicer returned an invalid async job ID."),
            )),
        };
    }
    if aborted {
        return match read_optional(&response.job_id_header) {
            Some(job) if !job.is_empty() => Submission::Cancel(job.to_vec()),
            _ => Submission::Failed(failure(
                Kind::Unconfirmed,
                units("The external response did not provide a cancellable job ID before abort."),
            )),
        };
    }
    if !succeeded(response.status) {
        return Submission::Failed(failure(
            Kind::Failed,
            refusal(response.status, &response.body),
        ));
    }
    Submission::Artifact(wire::Empty {})
}

const POLL_STATES: [&str; 6] = [
    "queued",
    "running",
    "cancelling",
    "done",
    "error",
    "cancelled",
];

/// `readJobPoll`: one status reply, after `failures` consecutive failed polls.
pub fn poll(read: &wire::ExternalSlicerPollRead) -> wire::ExternalSlicerPollStep {
    use wire::ExternalSlicerPollStep as Step;
    let status = match job_status(&read.reply) {
        Ok(status) => status,
        Err(problem) => {
            let failures = read.failures.saturating_add(1);
            if failures >= MAX_POLL_FAILURES {
                return Step::Failed(failure(
                    Kind::Failed,
                    joined(&[&units("External slicer stopped responding: "), &problem]),
                ));
            }
            return Step::Wait(wire::ExternalSlicerPollWait {
                failures,
                progress: wire::OptionalExternalSlicerProgress::Absent(wire::Empty {}),
            });
        }
    };
    let state = field(&status, "status");
    if is_text(state, "error") {
        // A failure without its reason reads as one, not as "undefined" or nothing.
        let reason = said(field(&status, "error"))
            .map_or_else(|| units("no reason was given"), <[u16]>::to_vec);
        return Step::Failed(failure(
            Kind::Failed,
            joined(&[&units("External Slicer Failed: "), &reason]),
        ));
    }
    if is_text(state, "cancelled") {
        return Step::Failed(failure(
            Kind::Cancelled,
            units("The external slicer job was cancelled."),
        ));
    }
    if is_text(state, "done") {
        return Step::Download(wire::Empty {});
    }
    // Progress is a number and a sentence, whatever else a server sends.
    let percent = match field(&status, "percent") {
        Some(Value::Number(n)) if n.is_finite() => *n,
        _ => 0.0,
    };
    let message = said(field(&status, "message"))
        .map_or_else(|| units("Slicing externally..."), <[u16]>::to_vec);
    Step::Wait(wire::ExternalSlicerPollWait {
        failures: 0,
        progress: wire::OptionalExternalSlicerProgress::Value(wire::ExternalSlicerProgress {
            percent,
            message,
        }),
    })
}

/// A status reply that names a known state, or what was wrong with it.
fn job_status(reply: &wire::ExternalSlicerReply) -> Result<Value, Vec<u16>> {
    let response = match reply {
        wire::ExternalSlicerReply::Failed(detail) => return Err(detail.clone()),
        wire::ExternalSlicerReply::Response(response) => response,
    };
    if !succeeded(response.status) {
        return Err(http(response.status));
    }
    let payload = parse(&response.body).ok_or_else(|| units(UNREADABLE_REPLY))?;
    let known = POLL_STATES
        .iter()
        .any(|state| is_text(field(&payload, "status"), state));
    if !known {
        return Err(units("Unknown job state."));
    }
    Ok(payload)
}

/// `readCancelReply`: one reply while a cancellation is being confirmed (the
/// cancellation's own, then each status poll's), or its deadline passing.
pub fn cancel(read: &wire::ExternalSlicerCancelRead) -> wire::ExternalSlicerCancelStep {
    use wire::ExternalSlicerCancelStep as Step;
    let unconfirmed = |detail: &[u16]| {
        Step::Failed(failure(
            Kind::Unconfirmed,
            joined(&[&units(UNCONFIRMED), detail]),
        ))
    };
    let response = match read {
        wire::ExternalSlicerCancelRead::TimedOut(_) => {
            return Step::Failed(failure(Kind::Unconfirmed, units(CANCELLATION_TIMED_OUT)));
        }
        wire::ExternalSlicerCancelRead::Reply(wire::ExternalSlicerReply::Failed(detail)) => {
            return unconfirmed(detail);
        }
        wire::ExternalSlicerCancelRead::Reply(wire::ExternalSlicerReply::Response(response)) => {
            response
        }
    };
    if !succeeded(response.status) {
        return unconfirmed(&http(response.status));
    }
    let Some(payload) = parse(&response.body) else {
        return unconfirmed(&units(UNREADABLE_REPLY));
    };
    let state = field(&payload, "status");
    if is_text(state, "cancelled") {
        return Step::Confirmed(wire::Empty {});
    }
    for (status, kind) in [
        ("done", Kind::AlreadyDone),
        ("error", Kind::AlreadyFailed),
        ("released", Kind::AlreadyReleased),
    ] {
        if is_text(state, status) {
            return Step::Failed(failure(
                kind,
                units(&format!(
                    "External slice was already {status}; it was not cancelled by this request."
                )),
            ));
        }
    }
    if ["queued", "running", "cancelling"]
        .iter()
        .any(|status| is_text(state, status))
    {
        return Step::Poll(wire::Empty {});
    }
    unconfirmed(&units("The server returned an unknown job state."))
}

/// `readExternalResult`: a downloaded artifact judged by the facts its host
/// computed while streaming it — accepted (and the job then to release, when
/// the transfer named its digest and its job), or why it was retained or refused.
pub fn artifact(read: &wire::ExternalSlicerArtifactRead) -> wire::ExternalSlicerArtifact {
    use wire::ExternalSlicerArtifact as Artifact;
    let refuse = |message: &str| Artifact::Failed(failure(Kind::Failed, units(message)));
    let facts = &read.response;
    if !succeeded(facts.status) {
        return Artifact::Failed(failure(
            Kind::Failed,
            refusal(facts.status, &facts.error_body),
        ));
    }
    let expected = read_optional(&read.expected_job_id);
    let named = read_optional(&facts.job_id_header);
    if let (Some(expected), Some(named)) = (expected, named)
        && !expected.is_empty()
        && !named.is_empty()
        && expected != named
    {
        return refuse(
            "External slicer returned a different job artifact. The result was retained.",
        );
    }
    let job = expected.or(named);
    let digest = read_optional(&facts.sha256_header);
    // The transferred length, not Content-Length, which may describe a compressed body.
    let length_matches = |text: &[u16]| {
        !text.is_empty()
            && text.iter().all(|&u| (0x30..=0x39).contains(&u))
            && lossy(text).trim_start_matches('0') == facts.length.to_string()
    };
    // The server still holds a result whose transfer came up short or did not match: it can be fetched again.
    let retained = |message: &str| Artifact::Failed(failure(Kind::Retained, units(message)));
    if facts.length == 0 || read_optional(&facts.bytes_header).is_some_and(|l| !length_matches(l)) {
        return retained(
            "External slice download was incomplete. The result was retained for retry.",
        );
    }
    if let Some(digest) = digest {
        if !is_digest(digest) {
            return refuse("External slicer returned an invalid artifact checksum.");
        }
        if *digest != facts.sha256 {
            return retained(
                "External slice download checksum did not match. The result was retained for retry.",
            );
        }
    }
    if !facts.utf8 {
        return refuse(NOT_UTF8);
    }
    if facts.blank {
        return refuse("External slicer returned an empty artifact.");
    }
    // Only a result whose transfer identity was verified is released; older servers keep it until it expires.
    let release = job.filter(|job| digest.is_some() && is_job_id(job));
    Artifact::Accepted(wire::ExternalSlicerAccepted {
        release: match release {
            Some(job) => wire::OptionalText::Value(job.to_vec()),
            None => wire::OptionalText::Absent(wire::Empty {}),
        },
    })
}

/// `readDownload`: the `attempt`th download of a finished job's artifact —
/// accepted; fetched again, while attempts remain, after a transfer that
/// failed (the host's sentence) or an artifact the server retained; or failed
/// with the transfer's or the verdict's own words.
pub fn download(read: &wire::ExternalSlicerDownloadRead) -> wire::ExternalSlicerDownloadStep {
    use wire::ExternalSlicerDownloadStep as Step;
    let again = read.attempt < MAX_DOWNLOAD_ATTEMPTS;
    match &read.outcome {
        wire::ExternalSlicerDownloadOutcome::Artifact(wire::ExternalSlicerArtifact::Accepted(
            _,
        )) => Step::Accept(wire::Empty {}),
        wire::ExternalSlicerDownloadOutcome::TransferFailed(_) if again => {
            Step::Refetch(wire::Empty {})
        }
        wire::ExternalSlicerDownloadOutcome::TransferFailed(detail) => {
            Step::Failed(failure(Kind::Failed, detail.clone()))
        }
        wire::ExternalSlicerDownloadOutcome::Artifact(wire::ExternalSlicerArtifact::Failed(
            refused,
        )) => {
            if again && refused.kind == Kind::Retained {
                Step::Refetch(wire::Empty {})
            } else {
                Step::Failed(refused.clone())
            }
        }
    }
}
