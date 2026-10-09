//! `PrinterCamera.ts`: watching the print.
//!
//! Moonraker reports which cameras a printer has and where their snapshots
//! live; the decisions are where a reported URL points and how a frame is
//! fetched. A relative path belongs to the printer's web origin (nginx on the
//! scheme's default port), with Moonraker's own path kept as a second
//! candidate; an absolute URL on the same host but another port is another
//! service, fetched directly and without the printer's credential; another
//! host is refused, so a camera list never makes this app a request
//! forwarder. Only snapshots are shown, at a bounded rate.
//!
//! A listing is planned, finished and read as storage's is, a frame's fetch
//! planned ([`snapshot_plan`]) and its failure read ([`snapshot_failure`]),
//! and the routes worth trying, the service's description, the poll interval
//! and a fresh frame URL answered — the host fetches and shows the frames.
use crate::moonraker::lower;
use crate::reply::{
    Ending, LIMITS, Value, array, ending, field, joined, optional_reply_text, read_number,
    read_string, record, units,
};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::{convert::number_to_string, round};
use url::Url;
use wire::CameraErrorCode as Code;

/// Frames per second this app fetches at most: each frame is its own request.
pub const MAX_SNAPSHOT_FPS: f64 = 4.0;
/// The slowest rate a camera is polled at.
pub const MIN_SNAPSHOT_FPS: f64 = 0.2;
const DEFAULT_FPS: f64 = 2.0;
/// How long one direct frame may take before it is called a failure: an
/// unreachable LAN port hangs rather than refusing.
pub const SNAPSHOT_TIMEOUT_MS: f64 = 8000.0;

/// The service names Moonraker reports, as the browser spells them.
const SERVICES: &[(&str, wire::CameraService)] = &[
    ("mjpegstreamer", wire::CameraService::Mjpegstreamer),
    (
        "mjpegstreamer-adaptive",
        wire::CameraService::MjpegstreamerAdaptive,
    ),
    ("uv4l-mjpeg", wire::CameraService::Uv4lMjpeg),
    ("hlsstream", wire::CameraService::Hlsstream),
    ("ipstream", wire::CameraService::Ipstream),
    (
        "webrtc-camerastreamer",
        wire::CameraService::WebrtcCamerastreamer,
    ),
    ("webrtc-go2rtc", wire::CameraService::WebrtcGo2rtc),
    ("webrtc-mediamtx", wire::CameraService::WebrtcMediamtx),
];

fn failure(code: Code, message: &[u16]) -> wire::CameraFailure {
    wire::CameraFailure {
        code,
        message: message.to_vec(),
    }
}
fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}
fn optional(value: &wire::OptionalPrinterReplyText) -> Option<&[u16]> {
    match value {
        wire::OptionalPrinterReplyText::Value(v) => Some(v),
        wire::OptionalPrinterReplyText::Absent(_) => None,
    }
}
fn optional_text(value: &wire::OptionalText) -> Option<&[u16]> {
    match value {
        wire::OptionalText::Value(v) => Some(v),
        wire::OptionalText::Absent(_) => None,
    }
}

/// Where a reported camera URL points (`CameraSnapshotSources`).
#[derive(Debug, Default, PartialEq)]
pub struct Sources {
    /// A path on the endpoint, fetched through the transport with the key.
    pub snapshot_path: Option<Vec<u16>>,
    /// A URL on the printer's machine, loaded directly without the key.
    pub snapshot_url: Option<Vec<u16>>,
    /// Why neither is possible, when neither is.
    pub unsupported_reason: Option<Vec<u16>>,
}

/// `new URL(value)`, as a scalar-value string.
fn parse(value: &[u16]) -> Option<Url> {
    Url::parse(&text(value)).ok()
}
/// The URL Standard's `search`: `?` and the query, or nothing for an empty one.
fn search(url: &Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    }
}

/// `resolveCameraSources`: where a reported camera URL points.
pub fn resolve(url: Option<&[u16]>, endpoint: Option<&[u16]>) -> Sources {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return Sources::default();
    };
    let trimmed = orcaxr_project::js_math::convert::trim_utf16(url);
    let endpoint = endpoint.filter(|e| !e.is_empty()).and_then(parse);
    let unreadable = || Sources {
        unsupported_reason: Some(joined(&[
            trimmed,
            &units(" is not a URL this app can read."),
        ])),
        ..Sources::default()
    };
    // `/^https?:\/\//i`
    let lower_prefix = |prefix: &str| {
        trimmed.len() >= prefix.len()
            && trimmed[..prefix.len()]
                .iter()
                .zip(prefix.bytes())
                .all(|(&u, b)| u < 0x80 && (u as u8).to_ascii_lowercase() == b)
    };
    if lower_prefix("http://") || lower_prefix("https://") {
        let Some(parsed) = parse(trimmed) else {
            return unreadable();
        };
        let path = units(&format!("{}{}", parsed.path(), search(&parsed)));
        // Without an endpoint, the only safe reading is a path on whatever the
        // transport is pointed at.
        let Some(endpoint) = endpoint else {
            return Sources {
                snapshot_path: Some(path),
                ..Sources::default()
            };
        };
        let origin = parsed.origin().ascii_serialization();
        let endpoint_origin = endpoint.origin().ascii_serialization();
        if origin == endpoint_origin {
            return Sources {
                snapshot_path: Some(path),
                snapshot_url: Some(units(parsed.as_str())),
                ..Sources::default()
            };
        }
        if parsed.host_str().unwrap_or("") == endpoint.host_str().unwrap_or("") {
            return Sources {
                snapshot_url: Some(units(parsed.as_str())),
                ..Sources::default()
            };
        }
        return Sources {
            unsupported_reason: Some(units(&format!(
                "This camera is served from {origin}, which is not the printer at {endpoint_origin}. OrcaXR only fetches from the printer it is connected to."
            ))),
            ..Sources::default()
        };
    }
    // A path, rooted or bare: `/^[\w./?=&%-]+$/` without one leading `/`.
    let slash = u16::from(b'/');
    let bare = trimmed.strip_prefix(&[slash][..]).unwrap_or(trimmed);
    let allowed = |u: &u16| {
        *u < 0x80 && ((*u as u8).is_ascii_alphanumeric() || b"_./?=&%-".contains(&(*u as u8)))
    };
    if bare.is_empty() || !bare.iter().all(allowed) {
        return unreadable();
    }
    let path = if trimmed.first() == Some(&slash) {
        trimmed.to_vec()
    } else {
        joined(&[&[slash], trimmed])
    };
    let Some(endpoint) = endpoint else {
        return Sources {
            snapshot_path: Some(path),
            ..Sources::default()
        };
    };
    // The printer's web origin: the scheme's default port on the same host.
    Sources {
        snapshot_url: Some(joined(&[
            &units(&format!(
                "{}://{}",
                endpoint.scheme(),
                endpoint.host_str().unwrap_or("")
            )),
            &path,
        ])),
        snapshot_path: Some(path),
        unsupported_reason: None,
    }
}

/// `readCamera`: a record with a name, or nothing.
fn camera(entry: &Value, endpoint: Option<&[u16]>) -> Option<wire::PrinterCamera> {
    record(Some(entry))?;
    let name = read_string(field(entry, "name"))?;
    let raw_service = lower(&read_string(field(entry, "service")).unwrap_or_default());
    let service = SERVICES
        .iter()
        .find(|(spelled, _)| units(spelled) == raw_service)
        .map_or(wire::CameraService::Unknown, |(_, service)| *service);
    let snapshot = resolve(
        read_string(field(entry, "snapshot_url")).as_deref(),
        endpoint,
    );
    let stream_path =
        resolve(read_string(field(entry, "stream_url")).as_deref(), endpoint).snapshot_path;
    let target_fps = read_number(field(entry, "target_fps"))
        .filter(|fps| *fps > 0.0)
        .unwrap_or(DEFAULT_FPS);
    let rotation = read_number(field(entry, "rotation"))
        .filter(|r| *r == 90.0 || *r == 180.0 || *r == 270.0)
        .unwrap_or(0.0);
    let unsupported_reason = (snapshot.snapshot_path.is_none()
        && snapshot.snapshot_url.is_none())
    .then(|| {
        // Without a snapshot endpoint there is no way to fetch a frame with
        // the key in a header, and the alternative leaks it into a URL.
        snapshot.unsupported_reason.clone().unwrap_or_else(|| {
            units("This camera offers only a live stream, which cannot carry the printer API key; OrcaXR shows authenticated snapshots instead.")
        })
    });
    let flag = |name: &str| matches!(field(entry, name), Some(Value::Bool(true)));
    Some(wire::PrinterCamera {
        uid: read_string(field(entry, "uid")).unwrap_or_else(|| name.clone()),
        name,
        service,
        enabled: !matches!(field(entry, "enabled"), Some(Value::Bool(false))),
        snapshot_path: optional_reply_text(snapshot.snapshot_path.filter(|p| !p.is_empty())),
        snapshot_url: optional_reply_text(snapshot.snapshot_url.filter(|u| !u.is_empty())),
        stream_path: optional_reply_text(stream_path.filter(|p| !p.is_empty())),
        target_fps,
        rotation_degrees: rotation,
        flip_horizontal: flag("flip_horizontal"),
        flip_vertical: flag("flip_vertical"),
        unsupported_reason: optional_reply_text(unsupported_reason),
    })
}

/// The listing request.
pub fn list_plan() -> wire::PrinterSend {
    wire::PrinterSend {
        path: units("/server/webcams/list"),
        method: units("GET"),
        operation: units("list_webcams"),
        timeout_ms: wire::OptionalFinite::Absent(wire::Empty {}),
    }
}

/// A listing's result once its exchange ended without a reply to read.
pub fn list_finish(request: &wire::CameraListFinish) -> wire::CameraListResult {
    let failed = wire::CameraListResult::Failed;
    match ending(&request.outcome) {
        Ending::Done => unreadable(),
        Ending::Cancelled => failed(failure(
            Code::Cancelled,
            &units("Reading the printer cameras was cancelled."),
        )),
        Ending::Failed(detail) => failed(failure(
            Code::Unavailable,
            &units(&format!(
                "The printer did not report any cameras ({detail})."
            )),
        )),
    }
}
fn unreadable() -> wire::CameraListResult {
    wire::CameraListResult::Failed(failure(
        Code::Unavailable,
        &units("The printer's camera list was not readable."),
    ))
}

/// `listPrinterCameras`' reading of a `/server/webcams/list` reply.
pub fn list_read(request: &wire::CameraListRequest, reply: &str) -> wire::CameraListResult {
    let Some(payload) = parse_javascript(reply, LIMITS)
        .ok()
        .filter(|p| record(Some(p)).is_some())
    else {
        return unreadable();
    };
    let endpoint = optional_text(&request.endpoint);
    wire::CameraListResult::Cameras(
        array(field(&payload, "webcams"))
            .iter()
            .filter_map(|entry| camera(entry, endpoint))
            .collect(),
    )
}

fn snapshot_path(camera: &wire::PrinterCamera) -> Option<&[u16]> {
    optional(&camera.snapshot_path)
}
fn snapshot_url(camera: &wire::PrinterCamera) -> Option<&[u16]> {
    optional(&camera.snapshot_url)
}

/// `planCameraSnapshot`: the route a frame takes, the mechanism asked for or
/// the first fetchable one.
pub fn snapshot_plan(request: &wire::CameraSnapshotRequest) -> wire::CameraSnapshotPlan {
    let camera = &request.camera;
    let route = match request.mechanism {
        wire::OptionalCameraMechanism::Value(m) => m,
        wire::OptionalCameraMechanism::Absent(_) => {
            if snapshot_url(camera).is_some() {
                wire::CameraMechanism::Direct
            } else {
                wire::CameraMechanism::Transport
            }
        }
    };
    if let (wire::CameraMechanism::Direct, Some(url)) = (route, snapshot_url(camera)) {
        return wire::CameraSnapshotPlan::Direct(wire::CameraDirectFetch {
            url: url.to_vec(),
            timeout_ms: SNAPSHOT_TIMEOUT_MS,
        });
    }
    let Some(path) = snapshot_path(camera) else {
        return wire::CameraSnapshotPlan::Refused(failure(
            Code::NoSnapshot,
            optional(&camera.unsupported_reason)
                .unwrap_or(&units("This camera has no snapshot endpoint.")),
        ));
    };
    if route == wire::CameraMechanism::Image {
        return wire::CameraSnapshotPlan::Refused(failure(
            Code::NoSnapshot,
            &units("An image route is loaded by the browser, not fetched here."),
        ));
    }
    wire::CameraSnapshotPlan::Transport(wire::CameraDownload {
        path: path.to_vec(),
        operation: units("camera_snapshot"),
    })
}

/// `cameraSnapshotFailure`: what a frame's failed fetch reads as (or the
/// refusal its plan was).
pub fn snapshot_failure(request: &wire::CameraSnapshotFinish) -> wire::CameraFailure {
    use wire::CameraSnapshotOutcome as Outcome;
    let camera = &request.request.camera;
    let plan = match snapshot_plan(&request.request) {
        wire::CameraSnapshotPlan::Refused(f) => return f,
        plan => plan,
    };
    if let Outcome::Cancelled(_) = request.outcome {
        return failure(
            Code::Cancelled,
            &units("The snapshot request was cancelled."),
        );
    }
    let failed = |message: Vec<u16>| failure(Code::SnapshotFailed, &message);
    match plan {
        wire::CameraSnapshotPlan::Transport(download) => {
            let code = match &request.outcome {
                Outcome::Transport(wire::OptionalMoonrakerErrorCode::Value(code)) => {
                    crate::control::moonraker_code(*code)
                }
                _ => "request failed",
            };
            failed(joined(&[
                &camera.name,
                &units(" did not return a frame from "),
                &download.path,
                &units(&format!(" ({code}).")),
            ]))
        }
        wire::CameraSnapshotPlan::Direct(direct) => match &request.outcome {
            Outcome::Status(status) => failed(joined(&[
                &camera.name,
                &units(&format!(" answered {} at ", number_to_string(*status))),
                &direct.url,
                &units("."),
            ])),
            Outcome::Timeout(_) => failed(joined(&[
                &camera.name,
                &units(" did not answer at "),
                &direct.url,
                &units(&format!(
                    " within {} seconds.",
                    number_to_string(direct.timeout_ms / 1000.0)
                )),
            ])),
            other => {
                let detail = match other {
                    Outcome::Unreachable(detail) => detail.clone(),
                    _ => units("request failed"),
                };
                failed(joined(&[
                    &camera.name,
                    &units(" could not be read from "),
                    &direct.url,
                    &units(" ("),
                    &detail,
                    &units(
                        "). It is a separate service from Moonraker, so it has to be reachable and allow cross-origin requests.",
                    ),
                ]))
            }
        },
        wire::CameraSnapshotPlan::Refused(f) => f,
    }
}

/// `cameraCanShowFrames`.
pub fn can_show_frames(camera: &wire::PrinterCamera) -> bool {
    snapshot_path(camera).is_some() || snapshot_url(camera).is_some()
}

/// `cameraLoadsAsImage`: an HTTPS page cannot load a plain-HTTP image.
fn loads_as_image(camera: &wire::PrinterCamera, page_protocol: Option<&[u16]>) -> bool {
    let Some(url) = snapshot_url(camera) else {
        return false;
    };
    !(page_protocol == Some(&units("https:")[..]) && url.starts_with(&units("http:")))
}

/// `cameraMechanisms`: how a frame can be obtained, in the order worth trying.
pub fn mechanisms(
    camera: &wire::PrinterCamera,
    page_protocol: Option<&[u16]>,
) -> Vec<wire::CameraMechanism> {
    let as_image = loads_as_image(camera, page_protocol);
    let mut routes = Vec::new();
    if as_image {
        routes.push(wire::CameraMechanism::Image);
    }
    if snapshot_url(camera).is_some() && !as_image {
        routes.push(wire::CameraMechanism::Direct);
    }
    if snapshot_path(camera).is_some() {
        routes.push(wire::CameraMechanism::Transport);
    }
    routes
}

/// `cameraFrameRate`: the rate frames are fetched at, bounded at both ends.
pub fn frame_rate(camera: &wire::PrinterCamera) -> f64 {
    // `Math.min(Math.max(fps, 0.2), 4)` over a finite rate.
    camera.target_fps.clamp(MIN_SNAPSHOT_FPS, MAX_SNAPSHOT_FPS)
}
/// `cameraPollIntervalMs`.
pub fn poll_interval_ms(camera: &wire::PrinterCamera) -> f64 {
    round(1000.0 / frame_rate(camera))
}

/// `describeCameraService`: the service, and how its frames are shown.
pub fn describe(request: &wire::CameraDescribeRequest) -> Vec<u16> {
    let camera = &request.camera;
    let service = match camera.service {
        wire::CameraService::Unknown => "an unrecognised service",
        known => SERVICES
            .iter()
            .find(|(_, service)| *service == known)
            .map_or("an unrecognised service", |(spelled, _)| spelled),
    };
    if !can_show_frames(camera) {
        return units(service);
    }
    let rate = format!("at up to {} fps", number_to_string(frame_rate(camera)));
    let route = match request.route {
        wire::OptionalCameraMechanism::Value(route) => Some(route),
        wire::OptionalCameraMechanism::Absent(_) => {
            mechanisms(camera, optional_text(&request.page_protocol))
                .first()
                .copied()
        }
    };
    units(&if route == Some(wire::CameraMechanism::Transport) {
        format!("{service}, shown as authenticated snapshots {rate}")
    } else {
        format!("{service}, shown as snapshots {rate}")
    })
}

/// `cameraMechanisms` for a request: the camera and the page it is shown on.
pub fn mechanisms_for(request: &wire::CameraMechanismsRequest) -> Vec<wire::CameraMechanism> {
    mechanisms(&request.camera, optional_text(&request.page_protocol))
}

/// [`frame_url`] on the wire.
pub fn frame(request: &wire::CameraFrameRequest) -> wire::OptionalPrinterReplyText {
    optional_reply_text(frame_url(request))
}

/// `cameraDirectFrameUrl`: the camera's own URL made unique per frame.
pub fn frame_url(request: &wire::CameraFrameRequest) -> Option<Vec<u16>> {
    let mut url = parse(snapshot_url(&request.camera)?)?;
    // `searchParams.set`: the first pair of that name takes the value, the
    // others go; the query is serialized again as form data.
    let name = "orcaxr_frame";
    let nonce = text(&request.nonce);
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    match pairs.iter().position(|(key, _)| key == name) {
        Some(first) => {
            pairs[first].1 = nonce;
            let mut index = 0;
            pairs.retain(|(key, _)| {
                let keep = key != name || index == first;
                index += 1;
                keep
            });
        }
        None => pairs.push((name.to_owned(), nonce)),
    }
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(&pairs);
    Some(units(url.as_str()))
}
