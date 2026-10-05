pub mod canonical;
pub mod generated;
pub mod project_intent_types;
pub mod project_intents;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

#[derive(Debug, Serialize)]
pub struct CoreError {
    pub code: &'static str,
    pub message: &'static str,
}

impl CoreError {
    fn invalid_json() -> Self {
        Self {
            code: "invalid_json",
            message: "Input is not valid JSON.",
        }
    }
    fn input_limit() -> Self {
        Self {
            code: "input_limit",
            message: "Input exceeds the supported resource limits.",
        }
    }
    fn non_finite() -> Self {
        Self {
            code: "non_finite_number",
            message: "Canonical numbers must be finite.",
        }
    }
}

pub fn core_info() -> String {
    serde_json::json!({
        "coreAbiVersion": generated::CORE_ABI_VERSION,
        "protocolVersion": generated::PROTOCOL_VERSION,
        "canonicalEncodingVersion": generated::CANONICAL_ENCODING_VERSION,
        "maxRequestBytes": generated::MAX_REQUEST_BYTES,
        "maxInputBytes": generated::MAX_INPUT_BYTES,
    })
    .to_string()
}

/// Bounded, stateless first operation of the shared core. It creates no project.
pub fn evaluate(request: &str) -> String {
    let error_reply = |request_id: Option<&str>, error: CoreError| {
        serde_json::json!({
            "protocolVersion": generated::PROTOCOL_VERSION,
            "requestId": request_id,
            "type": "error",
            "error": error,
        })
        .to_string()
    };
    if request.len() > generated::MAX_REQUEST_BYTES {
        return error_reply(None, CoreError::input_limit());
    }
    let request: generated::CanonicalRequest = match serde_json::from_str(request) {
        Ok(request) => request,
        Err(_) => {
            return error_reply(
                None,
                CoreError {
                    code: "invalid_request",
                    message: "Request does not match the core protocol.",
                },
            );
        }
    };
    if let Err(error) = request.validate() {
        return error_reply(None, error);
    }
    let parsed = match canonical::parse(&request.input) {
        Ok(value) => value,
        Err(error) => return error_reply(Some(&request.request_id), error),
    };
    let mut sink = CanonicalSink::default();
    if parsed.write_canonical(&mut sink).is_err() {
        return error_reply(Some(&request.request_id), CoreError::input_limit());
    }
    let canonical = String::from_utf8(sink.bytes).expect("canonical writer emits UTF-8");
    serde_json::json!({
        "protocolVersion": generated::PROTOCOL_VERSION,
        "requestId": request.request_id,
        "type": "canonicalized",
        "canonical": canonical,
        "semanticHash": format!("fnv1a64:{:016x}", sink.fnv),
        "sha256": format!("{:x}", sink.sha.finalize()),
    })
    .to_string()
}

struct CanonicalSink {
    bytes: Vec<u8>,
    fnv: u64,
    sha: Sha256,
}
impl Default for CanonicalSink {
    fn default() -> Self {
        Self {
            bytes: Vec::new(),
            fnv: 0xcbf29ce484222325,
            sha: Sha256::new(),
        }
    }
}
impl Write for CanonicalSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > generated::MAX_OUTPUT_BYTES {
            return Err(io::Error::other("output limit"));
        }
        for byte in bytes {
            self.fnv = (self.fnv ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        self.sha.update(bytes);
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
