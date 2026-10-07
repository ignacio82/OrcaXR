//! One model-import task for every binding: capture the base on the authority,
//! then decode, stage and preview privately (`import::prepare`), and commit on
//! the authority with the base's guard (`ProjectSession::commit_import`).
//! Failures carry bounded codes; no source path, name or content escapes.
use super::{
    Error, Limits, Malformed, Unsupported,
    stage::{IdKind, Placement, StageError, stage},
};
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types::SessionError;
use orcaxr_project::{
    assets::{AssetPayload, content_digest},
    import::{self, Parsed, Prepared, Source},
    session::{LocalGuard, ProjectSession},
    validation::TimestampPolicy,
};
use std::collections::HashMap;

/// How staged entities get stable IDs.
#[derive(Clone, Debug)]
pub enum Ids {
    /// Production: UUIDv4 from host-seeded entropy (xoshiro256**). The browser
    /// draws UUIDv4 from `Math.random`; any unique source is acceptable.
    Uuid([u64; 4]),
    /// Deterministic replay: `import:<namespace>:<kind>-<n>`.
    Counter(String),
}

/// The base an import is prepared against, captured on the authority.
#[derive(Clone)]
pub struct Base {
    pub guard: LocalGuard,
    revision: u64,
    hash: String,
    state: orcaxr_project::model::ProjectState,
    assets: Vec<AssetPayload>,
}
impl Base {
    pub fn capture<P: TimestampPolicy>(session: &ProjectSession<P>) -> Result<Self, SessionError> {
        let guard = session.capture_guard()?;
        let snapshot = session.snapshot();
        Ok(Self {
            guard,
            revision: snapshot.revision(),
            hash: snapshot.hash().to_owned(),
            state: snapshot.state().clone(),
            // The browser's repository `list()`: ID-ordered copies.
            assets: session.assets().list(),
        })
    }
}

pub struct Request {
    pub filename: Vec<u16>,
    pub imported_at: Vec<u16>,
    pub placement: Placement,
    pub ids: Ids,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Unsupported(Unsupported),
    Malformed(Malformed),
    /// A decoded mesh cannot become a canonical asset (Float32 overflow).
    Encoding,
    /// The staged candidate is not a project, or the base has no plate.
    State,
    Timestamp,
    Cancelled,
}
impl Failure {
    /// `unsupported-format:<reason>`, `malformed-model:<reason>`, …
    pub fn code(self) -> String {
        match self {
            Self::Unsupported(r) => format!("unsupported-format:{}", r.code()),
            Self::Malformed(r) => format!("malformed-model:{}", r.code()),
            Self::Encoding => "unencodable-mesh".into(),
            Self::State => "invalid-import-state".into(),
            Self::Timestamp => "timestamp_service".into(),
            Self::Cancelled => "cancelled".into(),
        }
    }
}

struct Xoshiro([u64; 4]);
impl Xoshiro {
    fn next(&mut self) -> u64 {
        let s = &mut self.0;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }
    fn uuid(&mut self) -> Vec<u16> {
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&self.next().to_le_bytes());
        bytes[8..].copy_from_slice(&self.next().to_le_bytes());
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        )
        .encode_utf16()
        .collect()
    }
}

/// Decode, stage and preview `bytes` against `base`. Synchronous and
/// cooperatively cancellable: run it on the host's owned preparation task.
pub fn prepare<P: TimestampPolicy>(
    bytes: &[u8],
    request: &Request,
    limits: &Limits,
    base: &Base,
    timestamps: &mut P,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Prepared, Failure> {
    let decoded =
        super::decode(bytes, &request.filename, limits, &mut cancelled).map_err(|e| match e {
            Error::Unsupported(reason, _) => Failure::Unsupported(reason),
            Error::Malformed(reason, _) => Failure::Malformed(reason),
            Error::Cancelled => Failure::Cancelled,
        })?;
    let descriptors: Vec<Value> = base.assets.iter().map(|a| a.descriptor.clone()).collect();
    let mut count = 0usize;
    let mut random = match &request.ids {
        Ids::Uuid(seed) => Some(Xoshiro(if *seed == [0; 4] { [1, 0, 0, 0] } else { *seed })),
        Ids::Counter(_) => None,
    };
    let mut next = |kind: IdKind| -> Vec<u16> {
        count += 1;
        match (&request.ids, &mut random) {
            (_, Some(random)) => random.uuid(),
            (Ids::Counter(namespace), _) => format!("import:{namespace}:{}-{count}", kind.code())
                .encode_utf16()
                .collect(),
            _ => unreachable!(),
        }
    };
    let staged = stage(
        &decoded,
        &base.state,
        &descriptors,
        &request.imported_at,
        request.placement,
        &mut next,
        &mut cancelled,
    )
    .map_err(|e| match e {
        StageError::Malformed(reason, _) => Failure::Malformed(reason),
        StageError::Encoding => Failure::Encoding,
        StageError::Cancelled => Failure::Cancelled,
        StageError::NoPlate | StageError::State => Failure::State,
    })?;
    if cancelled() {
        return Err(Failure::Cancelled);
    }
    let base_content: HashMap<Vec<u16>, String> = base
        .assets
        .iter()
        .filter_map(|a| match &a.descriptor {
            Value::Object(fields) => match fields.get(&"id".encode_utf16().collect::<Vec<_>>()) {
                Some(Value::String(id)) => Some((id.clone(), content_digest(&a.bytes))),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let parsed = Parsed {
        state: staged.state,
        assets: base
            .assets
            .iter()
            .cloned()
            .chain(staged.new_assets)
            .collect(),
        imported_asset_ids: staged.imported_asset_ids,
        repairs: staged.repairs,
        conflicts: Vec::new(),
        dropped_fields: staged.dropped_fields,
        diagnostics: staged.diagnostics,
    };
    let source = Source {
        filename: request.filename.clone(),
        media_type: None,
        uri: None,
        imported_at: request.imported_at.clone(),
    };
    import::prepare(
        parsed,
        &source,
        &base_content,
        base.revision,
        &base.hash,
        false,
        timestamps,
    )
    .map_err(|_| Failure::Timestamp)
}
