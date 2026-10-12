//! What a slice's output is bound to, and the sidecar published beside it.
//!
//! The browser binds each plate it slices, in its job coordinator, to the
//! state it came from and how it was made (`CanonicalSliceJobResult` and
//! `SlicePlateResult`): the project's revision, store and asset-bundle
//! fingerprints, the hash of the archive the engine read and of the G-code
//! it wrote, the profile snapshot the plate was sliced with, the route's
//! metadata and its engine, the route's statistics and the warnings; and it
//! states which identities a statistics sidecar must carry and how each is
//! spelled (`GcodeStatisticsBinding`). Here, through
//! `SliceSidecarExchange.ts`, exactly as the browser computes them:
//!
//! - [`profiles`]: the effective profile snapshot a plate is sliced with
//!   (`CanonicalStateProfileResolver.capture`): one SHA-256 over the
//!   canonical effective configuration, and a reference for the printer, the
//!   process and each engine filament slot, an explicit canonical hash kept
//!   and any other hashed over its effective profile;
//! - [`validate_binding`]: the output binding, checked as the browser checks
//!   every sidecar's (`validateGcodeStatisticsBinding`), first refusal first;
//! - [`Route`]: the route's metadata (`SliceRouteMetadata`) — the external
//!   server's is made from its endpoint by `orcaxr_printer::slicer::route`;
//!   this device's engine is [`Route::android_native`], the counterpart of the
//!   browser's own `browser-wasm` route.
//!
//! [`sidecar`] assembles the document an Android host publishes beside each
//! plate's G-code (`orcaxr.slice-output`, version 1): the binding, the
//! profiles, the route, the statistics — the route, the published length and
//! the totals the engine wrote into the artifact (`orcaxr_gcode::artifact`,
//! null when a statement was past the metadata bound) — and the warnings, refused unless the binding names the profiles' and
//! the route's identities. The exchange is canonical JSON ([`profiles_json`],
//! [`binding_json`], [`sidecar_json`]); a malformed request is
//! `invalid_request`.
use crate::{
    ids::PlateId,
    js_math::convert::trim_utf16,
    model::{Decode, Encode, ProjectState, find_plate},
};
use orcaxr_contracts::canonical::{Value, parse};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io};

/// Why a request could not be read.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// The sidecar document's schema and version.
pub const SCHEMA: &str = "orcaxr.slice-output";
pub const VERSION: f64 = 1.0;
/// `SLICE_PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION: f64 = 1.0;
/// `GCODE_STATISTICS_HARD_CAPS.textCharacters`: a binding text's bound, in UTF-16 units.
pub const MAX_TEXT_UNITS: usize = 512;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn text(value: &str) -> Value {
    Value::String(units(value))
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| "output_limit")?;
    String::from_utf8(bytes).map_err(|_| "output_limit")
}
fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
/// The request's members, exactly `keys`.
fn members(value: Value, keys: &[&str]) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    match value {
        Value::Object(fields)
            if fields.len() == keys.len()
                && keys.iter().all(|k| fields.contains_key(&units(k))) =>
        {
            Ok(fields)
        }
        _ => Err(INVALID_REQUEST),
    }
}
fn take(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str) -> Value {
    fields.remove(&units(key)).unwrap_or(Value::Null)
}
fn error(message: &[u16]) -> Result<String, &'static str> {
    canonical(&object([("error", Value::String(message.to_vec()))]))
}

/// A digest sink: canonical JSON is hashed as it is written, never held.
struct Hasher(Sha256);
impl io::Write for Hasher {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
/// `sha256:` and the SHA-256 of the value's canonical JSON as UTF-8 (`digestCanonical`).
pub fn digest_canonical(value: &Value) -> io::Result<String> {
    let mut sink = Hasher(Sha256::new());
    value.write_canonical(&mut sink)?;
    Ok(format!("sha256:{}", hex(&sink.0.finalize())))
}

/// `/^sha256:[0-9a-f]{64}$/`.
pub fn is_sha256(units: &[u16]) -> bool {
    lower_hex_after(units, "sha256:", 64)
}
/// `/^fnv1a64:[0-9a-f]{16}$/`.
pub fn is_fnv1a64(units: &[u16]) -> bool {
    lower_hex_after(units, "fnv1a64:", 16)
}
/// `/^[0-9a-f]{40}$/`: a full Git commit.
pub fn is_commit(units: &[u16]) -> bool {
    lower_hex_after(units, "", 40)
}
fn lower_hex_after(text: &[u16], prefix: &str, digits: usize) -> bool {
    let prefix = units(prefix);
    text.len() == prefix.len() + digits
        && text.starts_with(&prefix)
        && text[prefix.len()..]
            .iter()
            .all(|&u| matches!(u, 0x30..=0x39 | 0x61..=0x66))
}

// --- The profile snapshot ---------------------------------------------------------------------

/// `SliceProfileReference['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Printer,
    Process,
    Filament,
}
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Printer => "printer",
            Self::Process => "process",
            Self::Filament => "filament",
        }
    }
}

/// `SliceProfileReference`: a profile's identity and hash, and the engine
/// tool slot a filament fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub kind: Kind,
    pub id: Vec<u16>,
    pub hash: String,
    pub tool: Option<usize>,
}

/// `SliceProfileSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profiles {
    pub references: Vec<Reference>,
    pub effective_config_hash: String,
}
impl Profiles {
    /// `{"effectiveConfigHash","references":[{"hash","id","kind","tool"?}]}`.
    pub fn to_value(&self) -> Value {
        let references = self.references.iter().map(|reference| {
            let mut fields = BTreeMap::from([
                (units("hash"), text(&reference.hash)),
                (units("id"), Value::String(reference.id.clone())),
                (units("kind"), text(reference.kind.as_str())),
            ]);
            if let Some(tool) = reference.tool {
                fields.insert(units("tool"), Value::Number(tool as f64));
            }
            Value::Object(fields)
        });
        object([
            ("effectiveConfigHash", text(&self.effective_config_hash)),
            ("references", Value::Array(references.collect())),
        ])
    }
}

fn value(field: &dyn Encode) -> Value {
    field
        .to_value()
        .expect("a decoded project encodes as finite JSON")
}
fn optional<T: Encode>(field: &Option<T>) -> Value {
    field.as_ref().map_or(Value::Null, |v| value(v))
}
/// `value?.trim()`, absent when there is no value.
fn trimmed<T: AsRef<[u16]>>(field: Option<T>) -> Option<Vec<u16>> {
    field.map(|v| trim_utf16(v.as_ref()).to_vec())
}

/// `canonicalProfileHash`: an explicit canonical hash as it is, else the
/// SHA-256 of the effective profile and whatever was stated.
fn canonical_profile_hash(explicit: Option<&[u16]>, effective_profile: Value) -> String {
    let normalized = trimmed(explicit).filter(|v| !v.is_empty());
    if let Some(hash) = normalized.as_ref().filter(|v| is_sha256(v)) {
        return String::from_utf16(hash).expect("a canonical hash is ASCII");
    }
    digest(object([
        ("schema", text("orcaxr.slice-profile-reference.v1")),
        (
            "explicitHash",
            normalized.map_or(Value::Null, Value::String),
        ),
        ("effectiveProfile", effective_profile),
    ]))
}
fn digest(value: Value) -> String {
    digest_canonical(&value).expect("a profile is finite JSON")
}

/// `CanonicalStateProfileResolver.capture`: the profile snapshot [plate] is
/// sliced with, or the browser's words for an unknown plate.
pub fn profiles(state: &ProjectState, plate_id: &PlateId) -> Result<Profiles, Vec<u16>> {
    let Some(plate) = find_plate(state, plate_id) else {
        let mut message = units("Cannot resolve slice profiles for unknown plate ");
        message.extend_from_slice(plate_id.as_utf16());
        return Err(message);
    };
    let objects = plate.objects.iter().map(|o| {
        let volumes = o.volumes.iter().map(|v| {
            object([
                ("id", value(&v.id)),
                ("role", value(&v.role)),
                ("config", value(&v.config)),
                ("filamentId", optional(&v.filament_id)),
            ])
        });
        let ranges = o.layer_ranges.iter().map(|r| {
            object([
                ("id", value(&r.id)),
                ("minZMm", value(&r.min_z_mm)),
                ("maxZMm", value(&r.max_z_mm)),
                ("config", value(&r.config)),
                ("filamentId", optional(&r.filament_id)),
            ])
        });
        object([
            ("id", value(&o.id)),
            ("config", value(&o.config)),
            ("filamentId", optional(&o.filament_id)),
            ("volumes", Value::Array(volumes.collect())),
            ("layerRanges", Value::Array(ranges.collect())),
        ])
    });
    let effective = object([
        ("printer", value(&state.printer)),
        ("projectConfig", value(&state.config)),
        (
            "plate",
            object([
                ("id", value(&plate.id)),
                ("config", value(&plate.config)),
                ("objects", Value::Array(objects.collect())),
            ]),
        ),
        ("filaments", value(&state.filaments)),
    ]);
    let effective_config_hash = digest(effective);

    let mut references = Vec::new();
    let printer_id = trimmed(state.printer.profile_id.as_ref().map(|t| t.units()))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| units("canonical:effective-printer"));
    references.push(Reference {
        kind: Kind::Printer,
        hash: canonical_profile_hash(
            state.printer.profile_hash.as_ref().map(|t| t.units()),
            object([
                ("kind", text("printer")),
                ("id", Value::String(printer_id.clone())),
                ("printer", value(&state.printer)),
                ("projectConfig", value(&state.config)),
            ]),
        ),
        id: printer_id,
        tool: None,
    });

    // `configString(state.config.print_settings_id)`.
    let process_id = match state.config.value() {
        Value::Object(config) => match config.get(&units("print_settings_id")) {
            Some(Value::String(id)) => Some(trim_utf16(id).to_vec()),
            _ => None,
        },
        _ => None,
    }
    .filter(|v| !v.is_empty())
    .unwrap_or_else(|| units("canonical:effective-process"));
    references.push(Reference {
        kind: Kind::Process,
        hash: digest(object([
            ("kind", text("process")),
            ("id", Value::String(process_id.clone())),
            ("projectConfig", value(&state.config)),
            ("plateConfig", value(&plate.config)),
        ])),
        id: process_id,
        tool: None,
    });

    for (tool, filament) in state.filaments.physical.iter().enumerate() {
        let id = trimmed(filament.preset_id.as_ref().map(|t| t.units()))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| filament.id.as_utf16().to_vec());
        references.push(Reference {
            kind: Kind::Filament,
            hash: canonical_profile_hash(
                filament.preset_hash.as_ref().map(|t| t.units()),
                object([
                    ("kind", text("physical-filament")),
                    ("id", Value::String(id.clone())),
                    ("material", value(&filament.material)),
                    ("vendor", optional(&filament.vendor)),
                    ("nozzleDiameterMm", optional(&filament.nozzle_diameter_mm)),
                    ("config", value(&filament.config)),
                ]),
            ),
            id,
            tool: Some(tool),
        });
    }
    let mut tool = state.filaments.physical.len();
    for filament in state.filaments.mixed.iter().filter(|f| f.enabled) {
        let id = filament.id.as_utf16().to_vec();
        references.push(Reference {
            kind: Kind::Filament,
            hash: digest(object([
                ("kind", text("mixed-filament")),
                ("id", Value::String(id.clone())),
                ("name", value(&filament.name)),
                ("displayColor", value(&filament.display_color)),
                ("components", value(&filament.components)),
                ("distribution", value(&filament.distribution)),
                ("fullSpectrum", optional(&filament.full_spectrum)),
                ("config", value(&filament.config)),
            ])),
            id,
            tool: Some(tool),
        });
        tool += 1;
    }
    Ok(Profiles {
        references,
        effective_config_hash,
    })
}

/// A snapshot as its reply document, or `{"error"}`.
pub fn profiles_reply(profiles: Result<Profiles, Vec<u16>>) -> Result<String, &'static str> {
    match profiles {
        Ok(profiles) => canonical(&profiles.to_value()),
        Err(message) => error(&message),
    }
}

/// `{"plateId","stateJson"}` → the plate's profile snapshot, or `{"error"}`.
pub fn profiles_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["plateId", "stateJson"])?;
    let (Value::String(plate), Value::String(state)) =
        (take(&mut fields, "plateId"), take(&mut fields, "stateJson"))
    else {
        return Err(INVALID_REQUEST);
    };
    let plate = PlateId::try_from_utf16(plate).map_err(|_| INVALID_REQUEST)?;
    let state = String::from_utf16(&state).map_err(|_| INVALID_REQUEST)?;
    let state = ProjectState::from_value(read(&state)?).map_err(|_| INVALID_REQUEST)?;
    profiles_reply(profiles(&state, &plate))
}
// --- The output binding -----------------------------------------------------------------------

/// `GcodeStatisticsBinding`'s fields, in the order the browser lists them.
pub const BINDING_FIELDS: [&str; 10] = [
    "jobId",
    "plateId",
    "sourceRevision",
    "sourceHash",
    "sourceAssetHash",
    "projectInputHash",
    "gcodeOutputHash",
    "effectiveConfigHash",
    "engineCommit",
    "engineArtifactHash",
];

/// `boundedText`: 1 to 512 UTF-16 units, as trimmed as it is.
pub fn is_bounded_text(units: &[u16]) -> bool {
    (1..=MAX_TEXT_UNITS).contains(&units.len()) && trim_utf16(units).len() == units.len()
}
/// `Number.isSafeInteger(value) && value >= 0`.
pub fn is_safe_count(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&value)
}

/// `validateGcodeStatisticsBinding`: the first reason [binding] does not
/// bind an output as a statistics sidecar's binding must, in the browser's
/// words, labelled `label`.
pub fn validate_binding(binding: &Value, label: &str) -> Result<(), Vec<u16>> {
    let refuse = |what: &str| Err(units(&format!("{label}{what}")));
    let fields = match binding {
        Value::Object(fields) => fields,
        Value::Array(_) => return refuse(" must be a plain JSON object"),
        _ => return refuse(" is missing"),
    };
    if fields.len() != BINDING_FIELDS.len()
        || !fields
            .keys()
            .all(|key| BINDING_FIELDS.iter().any(|name| units(name) == *key))
    {
        return refuse(" fields are missing or unknown");
    }
    let field = |name: &str| &fields[&units(name)];
    let string = |name: &str| match field(name) {
        Value::String(units) => Some(units.as_slice()),
        _ => None,
    };
    for name in ["jobId", "plateId"] {
        if !string(name).is_some_and(is_bounded_text) {
            return refuse(&format!(
                ".{name} must be a bounded non-empty canonical string"
            ));
        }
    }
    if !matches!(field("sourceRevision"), Value::Number(n) if is_safe_count(*n)) {
        return refuse(
            ".sourceRevision must be a non-negative safe integer inside the bounded domain",
        );
    }
    if !string("engineCommit").is_some_and(is_bounded_text) {
        return refuse(".engineCommit must be a bounded non-empty canonical string");
    }
    for name in ["sourceHash", "sourceAssetHash"] {
        if !string(name).is_some_and(is_fnv1a64) {
            return refuse(&format!(".{name} must be a canonical FNV-1a identity"));
        }
    }
    for name in [
        "projectInputHash",
        "gcodeOutputHash",
        "effectiveConfigHash",
        "engineArtifactHash",
    ] {
        if !string(name).is_some_and(is_sha256) {
            return refuse(&format!(".{name} must be a SHA-256 identity"));
        }
    }
    if !string("engineCommit").is_some_and(is_commit) {
        return refuse(".engineCommit must be a full Git commit");
    }
    Ok(())
}

/// `{"binding"}` → `{"valid":true}`, or `{"error"}` naming the first refusal.
pub fn binding_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["binding"])?;
    match validate_binding(&take(&mut fields, "binding"), "binding") {
        Ok(()) => canonical(&object([("valid", Value::Bool(true))])),
        Err(message) => error(&message),
    }
}

// --- The route --------------------------------------------------------------------------------

/// `SliceEngineMetadata`: the engine a route runs, as attested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    pub commit: Vec<u16>,
    pub artifact_hash: Vec<u16>,
}

/// `SliceRouteKind`, for the routes an Android host slices on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    ExternalServer,
    AndroidNative,
}
impl RouteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExternalServer => "external-server",
            Self::AndroidNative => "android-native",
        }
    }
}

/// `SliceRouteMetadata` (its `protocolVersion` is always [`PROTOCOL_VERSION`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub id: Vec<u16>,
    pub kind: RouteKind,
    pub engine: Engine,
}

/// `validatedExternalEngine`'s words.
pub const UNATTESTED_ENGINE: &str =
    "External canonical slicing requires attested engine commit and artifact hash.";
/// Why this device's engine cannot be a route's.
pub const UNIDENTIFIED_ENGINE: &str =
    "This device's slicing engine requires a full commit and a SHA-256 artifact hash.";

impl Route {
    /// This device's engine, as the browser names its own (`browser-wasm`):
    /// `slicer-client:android-native:<artifactHash>`, its engine the packaged
    /// build's commit and SHA-256 identity.
    pub fn android_native(engine: Engine) -> Result<Self, &'static str> {
        if !is_commit(&engine.commit) || !is_sha256(&engine.artifact_hash) {
            return Err(UNIDENTIFIED_ENGINE);
        }
        let mut id = units("slicer-client:android-native:");
        id.extend_from_slice(&engine.artifact_hash);
        Ok(Self {
            id,
            kind: RouteKind::AndroidNative,
            engine,
        })
    }

    /// `{"engine":{"artifactHash","commit"},"id","kind","protocolVersion"}`.
    pub fn to_value(&self) -> Value {
        object([
            (
                "engine",
                object([
                    (
                        "artifactHash",
                        Value::String(self.engine.artifact_hash.clone()),
                    ),
                    ("commit", Value::String(self.engine.commit.clone())),
                ]),
            ),
            ("id", Value::String(self.id.clone())),
            ("kind", text(self.kind.as_str())),
            ("protocolVersion", Value::Number(PROTOCOL_VERSION)),
        ])
    }

    /// A route's metadata read back, as [`to_value`](Self::to_value) writes it.
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Object(fields) = value else {
            return None;
        };
        let keys = ["engine", "id", "kind", "protocolVersion"];
        if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
            return None;
        }
        let string = |value: Option<&Value>| match value {
            Some(Value::String(units)) => Some(units.clone()),
            _ => None,
        };
        let Some(Value::Object(engine)) = fields.get(&units("engine")) else {
            return None;
        };
        if engine.len() != 2 {
            return None;
        }
        let engine = Engine {
            commit: string(engine.get(&units("commit")))?,
            artifact_hash: string(engine.get(&units("artifactHash")))?,
        };
        if fields.get(&units("protocolVersion")) != Some(&Value::Number(PROTOCOL_VERSION)) {
            return None;
        }
        let kind = string(fields.get(&units("kind")))?;
        let id = string(fields.get(&units("id")))?;
        let route = if kind == units("android-native") {
            Self::android_native(engine).ok()?
        } else if kind == units("external-server") {
            let prefix = units("slicer-client:external-server:");
            if id.len() <= prefix.len()
                || !id.starts_with(&prefix)
                || trim_utf16(&engine.commit).is_empty()
                || trim_utf16(&engine.artifact_hash).is_empty()
            {
                return None;
            }
            Self {
                id: id.clone(),
                kind: RouteKind::ExternalServer,
                engine,
            }
        } else {
            return None;
        };
        (route.id == id).then_some(route)
    }
}

/// `{"engine":{"artifactHash","commit"}}` → this device's route metadata, or `{"error"}`.
pub fn native_route_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["engine"])?;
    let engine = read_engine(take(&mut fields, "engine"))?;
    match Route::android_native(engine) {
        Ok(route) => canonical(&route.to_value()),
        Err(message) => error(&units(message)),
    }
}
/// `{"artifactHash","commit"}` as an [`Engine`].
pub fn read_engine(value: Value) -> Result<Engine, &'static str> {
    let mut engine = members(value, &["artifactHash", "commit"])?;
    match (
        take(&mut engine, "commit"),
        take(&mut engine, "artifactHash"),
    ) {
        (Value::String(commit), Value::String(artifact_hash)) => Ok(Engine {
            commit,
            artifact_hash,
        }),
        _ => Err(INVALID_REQUEST),
    }
}

// --- The sidecar ------------------------------------------------------------------------------

/// The engine's totals as `orcaxr_gcode::artifact::ArtifactSummary` serializes them.
const SUMMARY_NUMBERS: [&str; 6] = [
    "totalWeightG",
    "totalCost",
    "toolChanges",
    "layerCount",
    "estimatedSeconds",
    "firstLayerSeconds",
];
const TOOL_NUMBERS: [&str; 3] = ["lengthMm", "volumeCm3", "weightG"];
const TOOL_TEXTS: [&str; 2] = ["colorHex", "material"];

fn is_summary(value: &Value) -> bool {
    let Value::Object(fields) = value else {
        return false;
    };
    let number = |v: &Value| matches!(v, Value::Number(n) if n.is_finite());
    fields.iter().all(|(key, v)| {
        let key = String::from_utf16_lossy(key);
        match key.as_str() {
            "empty" => matches!(v, Value::Bool(_)),
            "perTool" => matches!(v, Value::Array(tools) if tools.iter().enumerate().all(|(index, tool)| {
                let Value::Object(tool) = tool else { return false };
                tool.get(&units("toolIndex")) == Some(&Value::Number(index as f64))
                    && tool.iter().all(|(k, v)| {
                        let k = String::from_utf16_lossy(k);
                        k == "toolIndex"
                            || (TOOL_NUMBERS.contains(&k.as_str()) && number(v))
                            || (TOOL_TEXTS.contains(&k.as_str()) && matches!(v, Value::String(_)))
                    })
            })),
            name => SUMMARY_NUMBERS.contains(&name) && number(v),
        }
    }) && fields.contains_key(&units("empty"))
        && fields.contains_key(&units("perTool"))
}

fn is_profiles(value: &Value) -> Option<Vec<u16>> {
    let fields = members(value.clone(), &["effectiveConfigHash", "references"]).ok()?;
    let Some(Value::String(hash)) = fields.get(&units("effectiveConfigHash")) else {
        return None;
    };
    let Some(Value::Array(references)) = fields.get(&units("references")) else {
        return None;
    };
    let mut counts = [0usize; 2];
    let mut tools = Vec::new();
    for reference in references {
        let Value::Object(reference) = reference else {
            return None;
        };
        let string = |key: &str| match reference.get(&units(key)) {
            Some(Value::String(units)) => Some(units.as_slice()),
            _ => None,
        };
        let kind = string("kind")?;
        let filament = kind == units("filament");
        // `validatedProfiles`: a non-empty canonical ID and a SHA-256 hash.
        if !string("id").is_some_and(|id| !id.is_empty() && trim_utf16(id).len() == id.len())
            || !string("hash").is_some_and(is_sha256)
            || reference.len() != if filament { 4 } else { 3 }
        {
            return None;
        }
        if filament {
            let Some(Value::Number(tool)) = reference.get(&units("tool")) else {
                return None;
            };
            if !is_safe_count(*tool) {
                return None;
            }
            tools.push(*tool);
        } else if kind == units("printer") {
            counts[0] += 1;
        } else if kind == units("process") {
            counts[1] += 1;
        } else {
            return None;
        }
    }
    // One printer, one process, and filament slots dense from 0.
    tools.sort_by(f64::total_cmp);
    let dense = tools.iter().enumerate().all(|(i, t)| *t == i as f64);
    (is_sha256(hash) && counts == [1, 1] && dense).then(|| hash.clone())
}

/// What [`sidecar`] assembles a document from.
pub struct SidecarInput {
    pub binding: Value,
    pub profiles: Value,
    pub route: Value,
    pub gcode_bytes: Value,
    pub summary: Value,
    pub warnings: Value,
}

/// The `orcaxr.slice-output` document published beside a plate's G-code,
/// or the first reason its parts do not bind one output.
pub fn sidecar(input: SidecarInput) -> Result<Value, Vec<u16>> {
    let refuse = |what: &str| Err(units(what));
    validate_binding(&input.binding, "binding")?;
    let Some(effective) = is_profiles(&input.profiles) else {
        return refuse("profiles must be a slice profile snapshot");
    };
    let Some(route) = Route::from_value(&input.route) else {
        return refuse("route must be the metadata of an Android slice route");
    };
    if !matches!(input.gcode_bytes, Value::Number(n) if is_safe_count(n)) {
        return refuse("gcodeBytes must be a non-negative safe integer");
    }
    // Null when the artifact's colour or material statement was past the metadata bound.
    if input.summary != Value::Null && !is_summary(&input.summary) {
        return refuse("summary must be the totals the engine wrote into the artifact, or null");
    }
    if !matches!(&input.warnings, Value::Array(w) if w.iter().all(|w| matches!(w, Value::String(_))))
    {
        return refuse("warnings must be a list of texts");
    }
    let Value::Object(binding) = &input.binding else {
        unreachable!("a validated binding is an object")
    };
    let bound = |name: &str| binding.get(&units(name));
    if bound("effectiveConfigHash") != Some(&Value::String(effective)) {
        return refuse(
            "binding.effectiveConfigHash is not the effective configuration the plate was sliced with",
        );
    }
    if bound("engineCommit") != Some(&Value::String(route.engine.commit.clone()))
        || bound("engineArtifactHash") != Some(&Value::String(route.engine.artifact_hash.clone()))
    {
        return refuse("binding's engine is not the route's engine");
    }
    Ok(object([
        ("schema", text(SCHEMA)),
        ("version", Value::Number(VERSION)),
        ("binding", input.binding),
        ("profiles", input.profiles),
        ("route", input.route),
        (
            "statistics",
            object([
                ("route", text(route.kind.as_str())),
                ("gcodeBytes", input.gcode_bytes),
                ("summary", input.summary),
            ]),
        ),
        ("warnings", input.warnings),
    ]))
}

/// `{"binding","gcodeBytes","profiles","route","summary","warnings"}` → the
/// sidecar document, or `{"error"}`.
pub fn sidecar_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &[
            "binding",
            "gcodeBytes",
            "profiles",
            "route",
            "summary",
            "warnings",
        ],
    )?;
    let input = SidecarInput {
        binding: take(&mut fields, "binding"),
        profiles: take(&mut fields, "profiles"),
        route: take(&mut fields, "route"),
        gcode_bytes: take(&mut fields, "gcodeBytes"),
        summary: take(&mut fields, "summary"),
        warnings: take(&mut fields, "warnings"),
    };
    match sidecar(input) {
        Ok(document) => canonical(&document),
        Err(message) => error(&message),
    }
}
