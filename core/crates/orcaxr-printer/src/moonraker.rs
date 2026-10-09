//! The pure half of `MoonrakerTransport.ts`, `MoonrakerEndpoint.ts`,
//! `SessionCredentials.ts` and `MoonrakerTypes.ts`: how an entered endpoint
//! becomes the URLs a transport uses, how a request path joins it, the
//! session credentials and how they are kept out of URLs and error text, the
//! handshake a connection reads, the reconnect policy and its backoff, the
//! object subscription, which endpoints take one method only, and how a
//! refused response is reported.
//!
//! URLs follow the WHATWG URL Standard, as the browser's `new URL` does.
use crate::status::LIMITS;
use orcaxr_contracts::{
    canonical::{Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_project::js_math::{
    self,
    convert::{is_space, trim_utf16, value_to_number},
};
use url::Url;
use wire::MoonrakerErrorCode as Code;

fn t(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn utf16(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}
fn optional_text(text: Option<Vec<u16>>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
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
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&t(name)),
        _ => None,
    }
}

// --- Errors ------------------------------------------------------------------------------------

/// `safeOperationName`: a short lowercase identifier, or `request`.
pub fn safe_operation_name(value: &[u16]) -> Vec<u16> {
    let lowered = lower(trim_utf16(value));
    let ok = !lowered.is_empty()
        && lowered.len() <= 64
        && lowered[0] < 0x80
        && (lowered[0] as u8).is_ascii_lowercase()
        && lowered[1..].iter().all(|&u| {
            u < 0x80 && matches!(u as u8, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-')
        });
    if ok { lowered } else { t("request") }
}
fn recoverable_by_default(code: Code) -> bool {
    matches!(
        code,
        Code::Cancelled
            | Code::Timeout
            | Code::Network
            | Code::WebsocketFailed
            | Code::HeartbeatTimeout
    )
}
/// `new MoonrakerTransportError(code, operation, options)`.
pub fn fault(
    code: Code,
    operation: &str,
    recoverable: Option<bool>,
    http_status: Option<f64>,
    detail: Option<&[u16]>,
) -> wire::MoonrakerTransportFault {
    wire::MoonrakerTransportFault {
        code,
        operation: safe_operation_name(&t(operation)),
        recoverable: recoverable.unwrap_or_else(|| recoverable_by_default(code)),
        http_status: match http_status {
            Some(s) if s.trunc() == s && (100.0..=599.0).contains(&s) => {
                wire::OptionalFinite::Value(s)
            }
            _ => wire::OptionalFinite::Absent(wire::Empty {}),
        },
        detail: optional_text(detail.and_then(summarize_detail)),
    }
}
fn refuse(code: Code, operation: &str) -> wire::MoonrakerTransportFault {
    fault(code, operation, None, None, None)
}
/// `summarizeServerDetail`: a server's error text as one short printable line.
pub(crate) fn summarize_detail(text: &[u16]) -> Option<Vec<u16>> {
    let mut collapsed: Vec<u16> = Vec::with_capacity(text.len());
    for decoded in char::decode_utf16(text.iter().copied()) {
        let (code, encoded): (u32, Vec<u16>) = match decoded {
            Ok(c) => (c as u32, c.encode_utf16(&mut [0; 2]).to_vec()),
            Err(lone) => (
                u32::from(lone.unpaired_surrogate()),
                vec![lone.unpaired_surrogate()],
            ),
        };
        if code >= 0x20 && code != 0x7f {
            collapsed.extend(encoded);
        } else if collapsed.last() != Some(&0x20) {
            collapsed.push(0x20);
        }
    }
    let mut spaced: Vec<u16> = Vec::with_capacity(collapsed.len());
    for unit in collapsed {
        if char::from_u32(u32::from(unit)).is_some_and(is_space) {
            if spaced.last() != Some(&0x20) {
                spaced.push(0x20);
            }
        } else {
            spaced.push(unit);
        }
    }
    let trimmed = trim_utf16(&spaced).to_vec();
    if trimmed.is_empty() {
        None
    } else if trimmed.len() > 200 {
        Some([&trimmed[..197], &t("...")[..]].concat())
    } else {
        Some(trimmed)
    }
}

/// `String.prototype.toLowerCase`; lone surrogates pass through.
pub(crate) fn lower(text: &[u16]) -> Vec<u16> {
    map_case(text, |s| s.to_lowercase())
}
/// `String.prototype.toUpperCase`; lone surrogates pass through.
pub(crate) fn upper(text: &[u16]) -> Vec<u16> {
    map_case(text, |s| s.to_uppercase())
}
fn map_case(text: &[u16], map: fn(&str) -> String) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut run = String::new();
    for decoded in char::decode_utf16(text.iter().copied()) {
        match decoded {
            Ok(c) => run.push(c),
            Err(lone) => {
                out.extend(map(&run).encode_utf16());
                run.clear();
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    out.extend(map(&run).encode_utf16());
    out
}

// --- Endpoints -----------------------------------------------------------------------------------

fn control_or_space(units: &[u16]) -> bool {
    units.iter().any(|&u| u <= 0x20 || u == 0x7f)
}
/// `normalizeBasePath`: no doubled or trailing slashes; `/` at least.
fn normalize_base_path(path: &str) -> String {
    let mut single = String::with_capacity(path.len());
    for c in path.chars() {
        if c == '/' && single.ends_with('/') {
            continue;
        }
        single.push(c);
    }
    let value = single.trim_end_matches('/');
    if value.is_empty() {
        "/".to_owned()
    } else {
        value.to_owned()
    }
}
/// `joinPathname`.
fn join_pathname(base: &str, child: &str) -> String {
    let joined = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        child.trim_start_matches('/')
    );
    match joined.strip_prefix("//") {
        Some(rest) => format!("/{rest}"),
        None => joined,
    }
}
fn strip_trailing_slash(value: &str) -> String {
    value.strip_suffix('/').unwrap_or(value).to_owned()
}
/// `url.search` and `url.hash` are empty both when absent and when empty.
fn has(part: Option<&str>) -> bool {
    part.is_some_and(|p| !p.is_empty())
}

fn direct_endpoint(
    input: &[u16],
    default_port: f64,
) -> Result<String, wire::MoonrakerTransportFault> {
    let invalid = || refuse(Code::InvalidEndpoint, "normalize_endpoint");
    let trimmed = trim_utf16(input);
    if trimmed.is_empty() || trimmed.len() > 2048 || control_or_space(trimmed) {
        return Err(invalid());
    }
    if !(default_port.trunc() == default_port && (1.0..=65535.0).contains(&default_port)) {
        return Err(invalid());
    }
    // `/^[a-z][a-z\d+.-]*:\/\//i`
    let has_scheme = trimmed
        .first()
        .is_some_and(|&u| u < 0x80 && (u as u8).is_ascii_alphabetic())
        && {
            let rest = trimmed
            .iter()
            .skip(1)
            .position(|&u| !(u < 0x80 && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'.' | b'-')))
            .map_or(trimmed.len(), |i| i + 1);
            trimmed[rest..].starts_with(&t("://"))
        };
    let colons = trimmed.iter().filter(|&&u| u == u16::from(b':')).count();
    let bare_ipv6 = !has_scheme && colons > 1 && trimmed.first() != Some(&u16::from(b'['));
    let text = utf16(trimmed);
    let candidate = if has_scheme {
        text
    } else if bare_ipv6 {
        format!("http://[{text}]")
    } else {
        format!("http://{text}")
    };
    // `new URL` reads a scalar-value string: a lone surrogate is U+FFFD.
    let mut parsed = Url::parse(&candidate).map_err(|_| invalid())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(invalid());
    }
    if !parsed.username().is_empty()
        || has(parsed.password())
        || has(parsed.query())
        || has(parsed.fragment())
        || parsed.host_str().is_none_or(str::is_empty)
    {
        return Err(invalid());
    }
    // An empty `?` or `#` passes the checks above but would stay in the URL,
    // and a WebSocket refuses any URL with a fragment.
    parsed.set_query(None);
    parsed.set_fragment(None);
    // The parser forgets a port equal to the scheme's default, so ask the
    // text: `printer:80` must not become `printer:7125`.
    if !has_scheme && parsed.port().is_none() && !typed_port(&candidate) {
        parsed
            .set_port(Some(default_port as u16))
            .map_err(|_| invalid())?;
    }
    let path = normalize_base_path(parsed.path());
    parsed.set_path(&path);
    Ok(strip_trailing_slash(parsed.as_str()))
}

fn proxy_endpoint(
    input: &[u16],
    page_origin: &[u16],
) -> Result<String, wire::MoonrakerTransportFault> {
    let invalid = || refuse(Code::InvalidEndpoint, "normalize_proxy");
    let trimmed = trim_utf16(input);
    if trimmed.is_empty() || page_origin.is_empty() || control_or_space(trimmed) {
        return Err(invalid());
    }
    let input = utf16(input);
    let origin = Url::parse(&utf16(page_origin)).map_err(|_| invalid())?;
    let mut proxy = origin.join(&input).map_err(|_| invalid())?;
    if (origin.scheme() != "http" && origin.scheme() != "https")
        || proxy.origin().ascii_serialization() != origin.origin().ascii_serialization()
        || !proxy.username().is_empty()
        || has(proxy.password())
        || has(proxy.query())
        || has(proxy.fragment())
    {
        return Err(invalid());
    }
    proxy.set_query(None);
    proxy.set_fragment(None);
    let path = normalize_base_path(proxy.path());
    proxy.set_path(&path);
    Ok(strip_trailing_slash(proxy.as_str()))
}
/// Whether the authority of `candidate` (`http://…`) names a port.
fn typed_port(candidate: &str) -> bool {
    let rest = candidate.strip_prefix("http://").unwrap_or(candidate);
    let authority = rest.split(['/', '\\', '?', '#']).next().unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(_) => authority.find(']').map_or("", |at| &authority[at + 1..]),
        None => authority,
    };
    host.rfind(':').is_some_and(|colon| colon < host.len() - 1)
}

/// `normalizeMoonrakerEndpoint`: one explicit target, never probed.
pub fn normalize_endpoint(
    request: &wire::MoonrakerEndpointRequest,
) -> wire::MoonrakerEndpointReply {
    match endpoint(request) {
        Ok(endpoint) => wire::MoonrakerEndpointReply::Endpoint(endpoint),
        Err(fault) => wire::MoonrakerEndpointReply::Refused(fault),
    }
}
pub fn endpoint(
    request: &wire::MoonrakerEndpointRequest,
) -> Result<wire::NormalizedMoonrakerEndpoint, wire::MoonrakerTransportFault> {
    let direct = direct_endpoint(
        &request.input,
        read_finite(&request.default_port).unwrap_or(7125.0),
    )?;
    let proxy = match read_text(&request.same_origin_proxy).filter(|p| !p.is_empty()) {
        Some(proxy) => Some(proxy_endpoint(
            proxy,
            read_text(&request.page_origin).unwrap_or(&[]),
        )?),
        None => None,
    };
    let transport = proxy.clone().unwrap_or_else(|| direct.clone());
    let mut socket =
        Url::parse(&transport).map_err(|_| refuse(Code::InvalidEndpoint, "normalize_endpoint"))?;
    let scheme = if socket.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    let _ = socket.set_scheme(scheme);
    let path = join_pathname(socket.path(), "websocket");
    socket.set_path(&path);
    Ok(wire::NormalizedMoonrakerEndpoint {
        direct_http_url: t(&direct),
        transport_http_url: t(&transport),
        web_socket_url: t(&strip_trailing_slash(socket.as_str())),
        uses_same_origin_proxy: proxy.is_some(),
    })
}

/// `decodeURIComponent`; `None` is the `URIError`.
fn decode_uri_component(units: &[u16]) -> Option<Vec<u16>> {
    let hex = |at: usize| -> Option<u8> {
        if units.get(at) != Some(&u16::from(b'%')) {
            return None;
        }
        let digit = |u: Option<&u16>| u.and_then(|&u| char::from_u32(u32::from(u))?.to_digit(16));
        Some((digit(units.get(at + 1))? * 16 + digit(units.get(at + 2))?) as u8)
    };
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        if units[at] != u16::from(b'%') {
            out.push(units[at]);
            at += 1;
            continue;
        }
        let first = hex(at)?;
        at += 3;
        let count = match first {
            0x00..=0x7f => {
                out.push(u16::from(first));
                continue;
            }
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut bytes = vec![first];
        for _ in 1..count {
            let byte = hex(at)?;
            if byte & 0xc0 != 0x80 {
                return None;
            }
            bytes.push(byte);
            at += 3;
        }
        out.extend(std::str::from_utf8(&bytes).ok()?.encode_utf16());
    }
    Some(out)
}
/// `SENSITIVE_QUERY_KEY` (ASCII case-insensitive, anywhere in the key).
fn sensitive_query_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "apikey",
        "api-key",
        "api_key",
        "accesstoken",
        "access-token",
        "access_token",
        "token",
        "authorization",
        "password",
        "secret",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

/// `joinMoonrakerEndpointPath`: a rooted path, no traversal, no credential in
/// the query.
pub fn join_path(request: &wire::MoonrakerPathRequest) -> wire::MoonrakerPathReply {
    match join(&utf16(&request.base), &request.path) {
        Ok(url) => wire::MoonrakerPathReply::Url(wire::PrinterText { text: t(&url) }),
        Err(fault) => wire::MoonrakerPathReply::Refused(fault),
    }
}
pub fn join(base: &str, path: &[u16]) -> Result<String, wire::MoonrakerTransportFault> {
    let invalid = || refuse(Code::InvalidEndpoint, "request_path");
    let slash = u16::from(b'/');
    if path.first() != Some(&slash)
        || path.get(1) == Some(&slash)
        || path.contains(&u16::from(b'\\'))
        || control_or_space(path)
    {
        return Err(invalid());
    }
    let question = path.iter().position(|&u| u == u16::from(b'?'));
    let (raw_path, raw_query) = match question {
        Some(at) => (&path[..at], &path[at + 1..]),
        None => (path, &[][..]),
    };
    for segment in raw_path.split(|&u| u == slash) {
        let decoded = decode_uri_component(segment).ok_or_else(invalid)?;
        if decoded == t(".") || decoded == t("..") {
            return Err(invalid());
        }
    }
    let raw_path = utf16(raw_path);
    let raw_query = utf16(raw_query);
    let mut target = Url::parse(base).map_err(|_| invalid())?;
    let joined = join_pathname(target.path(), raw_path.trim_start_matches('/'));
    target.set_path(&joined);
    // The `search` setter: empty clears it, and one leading `?` is dropped.
    if raw_query.is_empty() {
        target.set_query(None);
    } else {
        target.set_query(Some(raw_query.strip_prefix('?').unwrap_or(&raw_query)));
    }
    if target
        .query_pairs()
        .any(|(key, _)| sensitive_query_key(&key))
    {
        return Err(invalid());
    }
    Ok(target.into())
}

// --- Credentials -------------------------------------------------------------------------------------

/// `MoonrakerSessionCredentialStore`: per-transport memory only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Credentials {
    api_key: Option<Vec<u16>>,
    bearer_token: Option<Vec<u16>>,
}
fn normalize_credential(
    value: &wire::OptionalText,
) -> Result<Option<Vec<u16>>, wire::MoonrakerTransportFault> {
    let Some(value) = read_text(value).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 4096
        || trim_utf16(value) != value
        || value.iter().any(|&u| u <= 0x1f || u == 0x7f)
    {
        return Err(refuse(Code::InvalidCredentials, "set_credentials"));
    }
    Ok(Some(value.to_vec()))
}
impl Credentials {
    pub fn set(
        credentials: &wire::MoonrakerCredentials,
    ) -> Result<Self, wire::MoonrakerTransportFault> {
        let api_key = normalize_credential(&credentials.api_key)?;
        let bearer_token = normalize_credential(&credentials.bearer_token)?;
        if api_key.is_some() && bearer_token.is_some() {
            return Err(refuse(Code::InvalidCredentials, "set_credentials"));
        }
        Ok(Credentials {
            api_key,
            bearer_token,
        })
    }
    /// The header the session's requests carry, if any.
    pub fn request_headers(&self) -> Vec<wire::MoonrakerHeader> {
        if let Some(key) = &self.api_key {
            vec![wire::MoonrakerHeader {
                name: t("X-Api-Key"),
                value: key.clone(),
            }]
        } else if let Some(token) = &self.bearer_token {
            vec![wire::MoonrakerHeader {
                name: t("Authorization"),
                value: [&t("Bearer ")[..], token].concat(),
            }]
        } else {
            Vec::new()
        }
    }
    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
    }
    pub fn has_bearer_token(&self) -> bool {
        self.bearer_token.is_some()
    }
    /// Whether a value is the credential itself (so a URL must not carry it).
    pub fn matches(&self, value: &[u16]) -> bool {
        if value.is_empty() {
            return false;
        }
        if self.api_key.as_deref() == Some(value) {
            return true;
        }
        self.bearer_token.as_ref().is_some_and(|token| {
            value == &token[..] || value == [&t("Bearer ")[..], token].concat()
        })
    }
    /// `redact` over a server's text: no control runs, URLs, secrets or
    /// credential-shaped assignments, at most 512 units.
    pub fn redact(&self, text: &[u16]) -> Vec<u16> {
        let secrets: Vec<&[u16]> = [self.api_key.as_deref(), self.bearer_token.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        redact_string(text, &secrets)
    }
}
pub fn credential_check(check: &wire::MoonrakerCredentialCheck) -> wire::MoonrakerCredentialReply {
    match Credentials::set(&check.credentials) {
        Ok(store) => wire::MoonrakerCredentialReply::Accepted(wire::MoonrakerCredentialAnswer {
            headers: store.request_headers(),
            has_api_key: store.has_api_key(),
            has_bearer_token: store.has_bearer_token(),
            matches: check.probes.iter().map(|p| store.matches(p)).collect(),
        }),
        Err(fault) => wire::MoonrakerCredentialReply::Refused(fault),
    }
}

fn js_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_space)
}
fn word(u: u16) -> bool {
    u < 0x80 && ((u as u8).is_ascii_alphanumeric() || u == u16::from(b'_'))
}
fn ascii_ci_at(text: &[u16], at: usize, needle: &str) -> bool {
    let needle = needle.as_bytes();
    at + needle.len() <= text.len()
        && text[at..at + needle.len()]
            .iter()
            .zip(needle)
            .all(|(&u, &n)| u < 0x80 && (u as u8).to_ascii_lowercase() == n)
}
/// `/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi` → `<redacted-url>`.
fn redact_urls(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let boundary = at == 0 || !word(text[at - 1]);
        let scheme = if boundary && word(text[at]) {
            ["https", "http", "wss", "ws"]
                .iter()
                .find(|s| ascii_ci_at(text, at, s) && ascii_ci_at(text, at + s.len(), "://"))
                .map(|s| s.len() + 3)
        } else {
            None
        };
        if let Some(prefix) = scheme {
            let rest = &text[at + prefix..];
            let body = rest
                .iter()
                .position(|&u| js_space(u) || matches!(u, 0x22 | 0x27 | 0x3c | 0x3e))
                .unwrap_or(rest.len());
            if body > 0 {
                out.extend(t("<redacted-url>"));
                at += prefix + body;
                continue;
            }
        }
        out.push(text[at]);
        at += 1;
    }
    out
}
/// `/\b(?:bearer|x-api-key|api_key|access_token)\s*[:=]\s*\S+/gi` → `<redacted>`.
fn redact_assignments(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    'scan: while at < text.len() {
        let boundary = at == 0 || !word(text[at - 1]);
        if boundary && word(text[at]) {
            for name in ["bearer", "x-api-key", "api_key", "access_token"] {
                if !ascii_ci_at(text, at, name) {
                    continue;
                }
                let mut cursor = at + name.len();
                while cursor < text.len() && js_space(text[cursor]) {
                    cursor += 1;
                }
                if cursor >= text.len() || !matches!(text[cursor], 0x3a | 0x3d) {
                    continue;
                }
                cursor += 1;
                while cursor < text.len() && js_space(text[cursor]) {
                    cursor += 1;
                }
                let start = cursor;
                while cursor < text.len() && !js_space(text[cursor]) {
                    cursor += 1;
                }
                if cursor == start {
                    // Spaces given back by `\s*` are no `\S+`: no match here.
                    continue;
                }
                out.extend(t("<redacted>"));
                at = cursor;
                continue 'scan;
            }
        }
        out.push(text[at]);
        at += 1;
    }
    out
}
fn replace_controls(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut replacing = false;
    for &u in text {
        if u <= 0x1f || u == 0x7f {
            if !replacing {
                out.push(0x20);
            }
            replacing = true;
        } else {
            out.push(u);
            replacing = false;
        }
    }
    out
}
fn replace_all(text: &[u16], needle: &[u16], with: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if text[at..].starts_with(needle) {
            out.extend_from_slice(with);
            at += needle.len();
        } else {
            out.push(text[at]);
            at += 1;
        }
    }
    out
}
/// `redactMoonrakerDiagnostic` over text: no control runs, URLs, `secrets`
/// (none empty) or credential-shaped assignments, at most 512 units.
pub fn redact_text(text: &[u16], secrets: &[&[u16]]) -> Vec<u16> {
    redact_string(text, secrets)
}
fn redact_string(text: &[u16], secrets: &[&[u16]]) -> Vec<u16> {
    let mut result = redact_urls(&replace_controls(text));
    for secret in secrets {
        result = replace_all(&result, secret, &t("<redacted>"));
    }
    let mut result = redact_assignments(&result);
    result.truncate(512);
    result
}

/// `readErrorDetail` over a refused response's text: Moonraker's own message
/// when the body is its JSON error, else the text itself.
pub fn error_detail(body: &[u16]) -> Option<Vec<u16>> {
    let text = &body[..body.len().min(2048)];
    if trim_utf16(text).is_empty() {
        return None;
    }
    if let Ok(parsed) = parse_javascript(&String::from_utf16_lossy(text), LIMITS)
        && String::from_utf16(text).is_ok()
    {
        let string = |v: Option<&Value>| match v {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        let error = field(&parsed, "error");
        if let Some(message) = string(error) {
            return Some(message);
        }
        if let Some(message) = error
            .filter(|e| matches!(e, Value::Object(_)))
            .and_then(|e| string(field(e, "message")))
        {
            return Some(message);
        }
        if let Some(message) = string(field(&parsed, "message")) {
            return Some(message);
        }
    }
    Some(text.to_vec())
}
/// `httpStatusError` for a refused response, its text read, redacted and
/// summarized.
pub fn error_response(response: &wire::MoonrakerErrorResponse) -> wire::MoonrakerTransportFault {
    let store = Credentials::set(&response.credentials).unwrap_or_default();
    let detail = read_text(&response.body)
        .and_then(error_detail)
        .map(|detail| store.redact(&detail));
    status_fault(
        response.status,
        &utf16(&response.operation),
        detail.as_deref(),
    )
}
pub fn status_fault(
    status: f64,
    operation: &str,
    detail: Option<&[u16]>,
) -> wire::MoonrakerTransportFault {
    let code = match status {
        401.0 => Code::AuthRequired,
        403.0 => Code::Forbidden,
        _ => Code::HttpError,
    };
    let recoverable = (code == Code::HttpError)
        .then_some(status == 408.0 || status == 425.0 || status == 429.0 || status >= 500.0);
    fault(code, operation, recoverable, Some(status), detail)
}

// --- Handshake -----------------------------------------------------------------------------------

fn api_version(values: &[f64]) -> Option<[f64; 3]> {
    (values.len() == 3
        && values
            .iter()
            .all(|&v| v.trunc() == v && (0.0..=1_000_000.0).contains(&v)))
    .then(|| [values[0], values[1], values[2]])
}
fn parse_api_version(value: Option<&Value>) -> Option<[f64; 3]> {
    match value {
        Some(Value::Array(items)) if items.len() >= 3 => api_version(
            &items[..3]
                .iter()
                .map(|v| value_to_number(Some(v)))
                .collect::<Vec<_>>(),
        ),
        Some(Value::String(text)) => {
            // `/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/` over the trimmed text.
            let text = trim_utf16(text);
            let mut parts = Vec::new();
            let mut at = 0;
            for index in 0..3 {
                let start = at;
                while at < text.len() && (0x30..=0x39).contains(&text[at]) {
                    at += 1;
                }
                if at == start {
                    return None;
                }
                parts.push(js_math::convert::utf16_number(&text[start..at]));
                if index < 2 {
                    if text.get(at) != Some(&u16::from(b'.')) {
                        return None;
                    }
                    at += 1;
                }
            }
            let rest = &text[at..];
            let tail_ok = rest.is_empty()
                || (matches!(rest[0], 0x2d | 0x2b)
                    && !rest[1..]
                        .iter()
                        .any(|&u| matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)));
            if !tail_ok {
                return None;
            }
            api_version(&parts)
        }
        _ => None,
    }
}
fn component_name(text: &[u16]) -> bool {
    (1..=64).contains(&text.len())
        && text.iter().all(|&u| {
            u < 0x80
                && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.' | b'-')
        })
}
/// `safeProtocolString`.
fn safe_protocol_string(value: Option<&Value>, max: usize, fallback: &str) -> Vec<u16> {
    let Some(Value::String(text)) = value else {
        return t(fallback);
    };
    let mut out = Vec::new();
    for &u in text {
        if out.len() >= max {
            break;
        }
        if u > 0x1f && u != 0x7f {
            out.push(u);
        }
    }
    out
}
const KNOWN_COMPONENTS: [&str; 15] = [
    "announcements",
    "authorization",
    "database",
    "file_manager",
    "history",
    "job_queue",
    "klippy_apis",
    "machine",
    "power",
    "proc_stats",
    "secrets",
    "shell_command",
    "template",
    "update_manager",
    "webcam",
];
/// `normalizeVersionPolicy`: the supported API range.
pub(crate) fn version_policy(
    input: &wire::MoonrakerVersionPolicyInput,
) -> Result<([f64; 3], f64), wire::MoonrakerTransportFault> {
    let minimum = match &input.minimum {
        wire::OptionalMoonrakerApiVersionInput::Value(values) => api_version(values),
        wire::OptionalMoonrakerApiVersionInput::Absent(_) => Some([1.0, 0.0, 0.0]),
    };
    let maximum_major = read_finite(&input.maximum_major).unwrap_or(1.0);
    match minimum {
        Some(minimum) if maximum_major.trunc() == maximum_major && maximum_major >= minimum[0] => {
            Ok((minimum, maximum_major))
        }
        _ => Err(refuse(Code::InvalidRequest, "configure_transport")),
    }
}
/// The handshake a connection reads from `/server/info` and `/printer/info`.
pub fn handshake(request: &wire::MoonrakerHandshakeRequest) -> wire::MoonrakerHandshakeReply {
    let parse = |text: &[u16]| parse_javascript(&utf16(text), LIMITS).unwrap_or(Value::Null);
    match version_policy(&request.policy).and_then(|policy| {
        read_handshake(&parse(&request.server), &parse(&request.printer), policy)
    }) {
        Ok(handshake) => wire::MoonrakerHandshakeReply::Handshake(handshake),
        Err(fault) => wire::MoonrakerHandshakeReply::Refused(fault),
    }
}
/// `readMoonrakerHandshake`.
pub fn read_handshake(
    server: &Value,
    printer: &Value,
    (minimum, maximum_major): ([f64; 3], f64),
) -> Result<wire::MoonrakerHandshake, wire::MoonrakerTransportFault> {
    let invalid = || refuse(Code::InvalidResponse, "handshake_server");
    if !matches!(server, Value::Object(_)) {
        return Err(invalid());
    }
    let version = match field(server, "api_version") {
        None | Some(Value::Null) => field(server, "api_version_string"),
        some => some,
    };
    let version = parse_api_version(version).ok_or_else(invalid)?;
    let Some(Value::Array(listed)) = field(server, "components") else {
        return Err(invalid());
    };
    // Moonraker lists a few dozen; a server listing more is not one.
    if listed.len() > 256 {
        return Err(invalid());
    }
    let mut components: Vec<Vec<u16>> = Vec::new();
    for component in listed {
        let Value::String(name) = component else {
            return Err(invalid());
        };
        if !component_name(name) {
            return Err(invalid());
        }
        if !components.contains(name) {
            components.push(name.clone());
        }
    }
    components.sort();
    let warned = matches!(field(server, "warnings"), Some(Value::Array(w)) if !w.is_empty());
    let compare = version
        .iter()
        .zip(minimum.iter())
        .find(|(a, b)| a != b)
        .map_or(0.0, |(a, b)| a - b);
    if version[0] > maximum_major || compare < 0.0 {
        return Err(refuse(Code::VersionUnsupported, "handshake_version"));
    }
    if !matches!(printer, Value::Object(_)) {
        return Err(refuse(Code::InvalidResponse, "handshake_printer"));
    }
    let printer = wire::MoonrakerPrinterHandshake {
        state: safe_protocol_string(field(printer, "state"), 64, "unknown"),
        hostname: safe_protocol_string(field(printer, "hostname"), 255, ""),
        software_version: safe_protocol_string(field(printer, "software_version"), 128, ""),
    };
    let has = |name: &str| components.contains(&t(name));
    let capabilities = wire::MoonrakerCapabilityManifest {
        authorization: has("authorization"),
        file_management: has("file_manager"),
        job_queue: has("job_queue"),
        history: has("history"),
        webcams: has("webcam"),
        power_devices: has("power"),
        update_manager: has("update_manager"),
        announcements: has("announcements"),
        database: has("database"),
        klippy_connected: has("klippy_apis") && lower(&printer.state) == t("ready"),
        extension_components: components
            .iter()
            .filter(|c| !KNOWN_COMPONENTS.iter().any(|k| t(k) == **c))
            .cloned()
            .collect(),
    };
    let version_string = version
        .iter()
        .map(|v| js_math::convert::number_to_string(*v))
        .collect::<Vec<_>>()
        .join(".");
    Ok(wire::MoonrakerHandshake {
        server: wire::MoonrakerServerHandshake {
            api_version: version.to_vec(),
            api_version_string: t(&version_string),
            moonraker_version: safe_protocol_string(field(server, "moonraker_version"), 128, ""),
            components,
            warnings: if warned {
                vec![t("server-reported-warnings")]
            } else {
                Vec::new()
            },
        },
        printer,
        capabilities,
    })
}

// --- Reconnects, subscriptions and methods ----------------------------------------------------------

/// `normalizeReconnectPolicy`.
pub fn reconnect_policy(
    input: &wire::MoonrakerReconnectPolicyInput,
) -> wire::MoonrakerReconnectPolicyReply {
    let policy = wire::MoonrakerReconnectPolicy {
        initial_delay_ms: read_finite(&input.initial_delay_ms).unwrap_or(500.0),
        maximum_delay_ms: read_finite(&input.maximum_delay_ms).unwrap_or(30_000.0),
        maximum_attempts: read_finite(&input.maximum_attempts).unwrap_or(6.0),
        jitter_ratio: read_finite(&input.jitter_ratio).unwrap_or(0.2),
    };
    let valid = policy.initial_delay_ms >= 0.0
        && policy.maximum_delay_ms >= policy.initial_delay_ms
        && policy.maximum_attempts.trunc() == policy.maximum_attempts
        && (0.0..=32.0).contains(&policy.maximum_attempts)
        && (0.0..=1.0).contains(&policy.jitter_ratio);
    if valid {
        wire::MoonrakerReconnectPolicyReply::Policy(policy)
    } else {
        wire::MoonrakerReconnectPolicyReply::Refused(refuse(
            Code::InvalidRequest,
            "configure_transport",
        ))
    }
}
/// `calculateMoonrakerReconnectDelay`: exponential, capped, with jitter.
pub fn reconnect_delay(request: &wire::MoonrakerReconnectDelayRequest) -> f64 {
    let policy = &request.policy;
    let attempt = js_math::max(1.0, request.attempt.floor());
    let exponent = js_math::min(30.0, attempt - 1.0);
    let base = js_math::min(
        policy.maximum_delay_ms,
        policy.initial_delay_ms * exponent.exp2(),
    );
    let random = js_math::min(1.0, js_math::max(0.0, request.random));
    let jittered = base + base * policy.jitter_ratio * (random * 2.0 - 1.0);
    js_math::round(js_math::min(
        policy.maximum_delay_ms,
        js_math::max(0.0, jittered),
    ))
}

fn protocol_name(text: &[u16]) -> bool {
    (1..=128).contains(&text.len())
        && text.iter().all(|&u| {
            u < 0x80
                && matches!(u as u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.' | b'-')
        })
}
/// A canonical array index, which a JavaScript object orders first.
fn array_index(key: &[u16]) -> Option<u64> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value = 0u64;
    for &u in key {
        value = value * 10 + u64::from(char::from_u32(u32::from(u))?.to_digit(10)?);
    }
    (value < 4_294_967_295).then_some(value)
}
/// `cloneObjectSubscription` over the entries of the object a host built:
/// its key order (array indices first), the last value for a repeated name,
/// each field list deduplicated and sorted.
pub fn subscription(
    entries: &[wire::MoonrakerSubscriptionEntry],
) -> Result<Vec<wire::MoonrakerSubscriptionEntry>, wire::MoonrakerTransportFault> {
    let refused = || refuse(Code::ProtocolError, "object_subscription");
    let mut object: Vec<wire::MoonrakerSubscriptionEntry> = Vec::new();
    for entry in entries {
        match object.iter_mut().find(|e| e.name == entry.name) {
            Some(existing) => existing.fields = entry.fields.clone(),
            None => object.push(entry.clone()),
        }
    }
    object.sort_by_key(|e| array_index(&e.name).map_or((1, 0), |i| (0, i)));
    for entry in &mut object {
        let name = &entry.name;
        if !protocol_name(name)
            || *name == t("__proto__")
            || *name == t("prototype")
            || *name == t("constructor")
        {
            return Err(refused());
        }
        if let wire::OptionalTextList::Value(fields) = &mut entry.fields {
            if fields.iter().any(|f| !protocol_name(f)) {
                return Err(refused());
            }
            fields.sort();
            fields.dedup();
        }
    }
    Ok(object)
}
pub fn subscription_reply(
    entries: &[wire::MoonrakerSubscriptionEntry],
) -> wire::MoonrakerSubscriptionReply {
    match subscription(entries) {
        Ok(object) => wire::MoonrakerSubscriptionReply::Subscription(object),
        Err(fault) => wire::MoonrakerSubscriptionReply::Refused(fault),
    }
}

const METHOD_ONLY: [(&str, &str); 10] = [
    ("/printer/print/start", "POST"),
    ("/printer/print/pause", "POST"),
    ("/printer/print/resume", "POST"),
    ("/printer/print/cancel", "POST"),
    ("/printer/emergency_stop", "POST"),
    ("/printer/firmware_restart", "POST"),
    ("/printer/restart", "POST"),
    ("/printer/gcode/script", "POST"),
    ("/server/files/move", "POST"),
    ("/server/files/copy", "POST"),
];
/// `assertMethodSuitsEndpoint`: a mutation sent as a GET is refused before
/// it leaves.
pub fn method_suits(
    pathname: &str,
    method: Option<&[u16]>,
    operation: &str,
) -> Result<(), wire::MoonrakerTransportFault> {
    let path = if pathname.len() > 1 {
        pathname.strip_suffix('/').unwrap_or(pathname)
    } else {
        pathname
    };
    let Some((_, required)) = METHOD_ONLY.iter().find(|(p, _)| *p == path) else {
        return Ok(());
    };
    if upper(method.unwrap_or(&t("GET"))) != t(required) {
        return Err(refuse(Code::InvalidRequest, operation));
    }
    Ok(())
}
pub fn method_check(check: &wire::MoonrakerMethodCheck) -> wire::MoonrakerCheckReply {
    let pathname = Url::parse(&utf16(&check.url))
        .map(|u| u.path().to_owned())
        .unwrap_or_default();
    match method_suits(
        &pathname,
        read_text(&check.method),
        &utf16(&check.operation),
    ) {
        Ok(()) => wire::MoonrakerCheckReply::Allowed(wire::Empty {}),
        Err(fault) => wire::MoonrakerCheckReply::Refused(fault),
    }
}
