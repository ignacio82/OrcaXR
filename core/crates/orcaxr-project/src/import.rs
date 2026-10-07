//! The transactional import contract (`ProjectImportCoordinator`): a parsed
//! candidate is normalised (asset declarations checked, imported provenance
//! completed, byte-identical assets consolidated and references aliased, the
//! graph validated), previewed with every notice, and committed only after
//! explicit confirmation of the required acknowledgements against an unchanged
//! base, as one undoable history entry. Notice identifiers, paths and messages
//! are the browser's, so hosts present the same preview.
use crate::{
    assets::{AssetPayload, content_digest},
    ids::AssetId,
    model::{Decode, Encode, ProjectData, ProjectState},
    validation::{TimestampPolicy, ValidatedProject, validate_project},
};
use orcaxr_contracts::canonical::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Where an import came from. `imported_at` is the host's clock reading.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub filename: Vec<u16>,
    pub media_type: Option<Vec<u16>>,
    pub uri: Option<Vec<u16>>,
    pub imported_at: Vec<u16>,
}

/// A parser's candidate: the complete next state and every asset payload it
/// needs (the base project's included), plus canonical-JSON notices.
#[derive(Clone)]
pub struct Parsed {
    pub state: ProjectState,
    pub assets: Vec<AssetPayload>,
    pub imported_asset_ids: Vec<AssetId>,
    pub repairs: Vec<Value>,
    pub conflicts: Vec<Value>,
    pub dropped_fields: Vec<Value>,
    pub diagnostics: Vec<Value>,
}

/// A normalised candidate with its preview. `project` is present only when the
/// final graph is admitted; a blocked preview can never be committed.
#[derive(Clone)]
pub struct Prepared {
    pub preview: Value,
    pub state: Value,
    pub assets: Vec<AssetPayload>,
    project: Option<ValidatedProject>,
    blocked: bool,
    required: Vec<Vec<u16>>,
    label: Vec<u16>,
}
impl Prepared {
    pub fn is_blocked(&self) -> bool {
        self.blocked
    }
    /// Notice IDs the operator must acknowledge, sorted.
    pub fn required_acknowledgements(&self) -> &[Vec<u16>] {
        &self.required
    }
    /// The history label, `Import <filename>`.
    pub fn label(&self) -> &[u16] {
        &self.label
    }
}

/// Why a confirmation is refused before anything changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfirmError {
    /// The preview has unresolved conflicts or error diagnostics.
    Blocked,
    /// Required acknowledgements are missing (sorted).
    Missing(Vec<Vec<u16>>),
    /// The project or its assets changed after the preview was prepared.
    Stale,
}

fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}
fn s(text: &str) -> Value {
    Value::String(key(text))
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&key(name)),
        _ => None,
    }
}
fn string(value: &Value) -> Option<&[u16]> {
    match value {
        Value::String(units) => Some(units),
        _ => None,
    }
}
fn record<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (key(k), v)).collect())
}
/// ECMAScript `String(value)` for the identifiers and numbers these messages quote.
fn display(value: Option<&Value>) -> Vec<u16> {
    match value {
        Some(Value::String(units)) => units.clone(),
        Some(Value::Number(n)) => {
            let mut out = Vec::new();
            Value::Number(*n)
                .write_canonical(&mut out)
                .expect("in-memory number");
            out.into_iter().map(u16::from).collect()
        }
        Some(Value::Bool(b)) => key(if *b { "true" } else { "false" }),
        Some(Value::Null) => key("null"),
        None => key("undefined"),
        Some(other) => {
            let mut out = Vec::new();
            other.write_canonical(&mut out).expect("in-memory value");
            String::from_utf8_lossy(&out).encode_utf16().collect()
        }
    }
}
struct Text(Vec<u16>);
impl Text {
    fn new(prefix: &str) -> Self {
        Self(key(prefix))
    }
    fn s(mut self, text: &str) -> Self {
        self.0.extend(text.encode_utf16());
        self
    }
    fn u(mut self, units: &[u16]) -> Self {
        self.0.extend_from_slice(units);
        self
    }
    fn n(self, value: usize) -> Self {
        self.s(&value.to_string())
    }
    fn v(self) -> Value {
        Value::String(self.0)
    }
}

struct Notices {
    repairs: Vec<Value>,
    conflicts: Vec<Value>,
    dropped: Vec<Value>,
    diagnostics: Vec<Value>,
}
impl Notices {
    fn ids(&self) -> impl Iterator<Item = &[u16]> {
        self.repairs
            .iter()
            .chain(&self.conflicts)
            .chain(&self.dropped)
            .chain(&self.diagnostics)
            .filter_map(|n| field(n, "id").and_then(string))
    }
    /// `coordinator:<stem>:<n>`, the first sequence number not already used.
    fn next_id(&self, stem: &str) -> Value {
        let existing: HashSet<&[u16]> = self.ids().collect();
        let mut sequence = 1usize;
        loop {
            let candidate = Text::new("coordinator:").s(stem).s(":").n(sequence).0;
            if !existing.contains(candidate.as_slice()) {
                return Value::String(candidate);
            }
            sequence += 1;
        }
    }
    fn error(&mut self, stem: &str, code: &str, path: Value, message: Value) {
        let id = self.next_id(stem);
        self.diagnostics.push(record([
            ("id", id),
            ("severity", s("error")),
            ("code", s(code)),
            ("path", path),
            ("message", message),
        ]));
    }
}

/// `!value.trim()`.
fn is_blank(units: &[u16]) -> bool {
    units.iter().all(|&u| crate::ids::ecmascript_whitespace(u))
}
/// ECMAScript truthiness for the JSON values these notices carry.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(units)) => !units.is_empty(),
        Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(),
        _ => true,
    }
}

/// Normalise a parsed candidate exactly like the browser coordinator, then
/// build its preview. `base_content` maps the base project's asset IDs to their
/// content digests; `stale` reports a base that changed during parsing.
#[allow(clippy::too_many_arguments)]
pub fn prepare<P: TimestampPolicy>(
    parsed: Parsed,
    source: &Source,
    base_content: &HashMap<Vec<u16>, String>,
    base_revision: u64,
    base_hash: &str,
    stale: bool,
    timestamps: &mut P,
) -> Result<Prepared, P::Error> {
    let mut state = parsed.state.to_value().expect("in-memory state");
    let mut assets = parsed.assets;
    let mut notices = Notices {
        repairs: parsed.repairs,
        conflicts: parsed.conflicts,
        dropped: parsed.dropped_fields,
        diagnostics: parsed.diagnostics,
    };
    let mut imported_count = 0usize;
    let mut deduplicated = 0usize;

    // Notice identities.
    {
        let mut seen = HashSet::new();
        let ids: Vec<Option<Vec<u16>>> = notices
            .repairs
            .iter()
            .chain(&notices.conflicts)
            .chain(&notices.dropped)
            .chain(&notices.diagnostics)
            .map(|n| field(n, "id").and_then(string).map(<[u16]>::to_vec))
            .collect();
        for id in ids {
            let id = id.unwrap_or_default();
            if is_blank(&id) || seen.contains(&id) {
                let message = if is_blank(&id) {
                    Text::new("Import notice IDs cannot be empty").v()
                } else {
                    Text::new("Duplicate import notice ID ").u(&id).v()
                };
                notices.error(
                    "invalid-notice",
                    "invalid-import-notice-id",
                    s("notices"),
                    message,
                );
            }
            seen.insert(id);
        }
    }

    let imported: Vec<Vec<u16>> = {
        let mut seen = HashSet::new();
        parsed
            .imported_asset_ids
            .iter()
            .map(|id| id.as_utf16().to_vec())
            .filter(|id| seen.insert(id.clone()))
            .collect()
    };
    let imported_set: HashSet<&[u16]> = imported.iter().map(Vec::as_slice).collect();
    let declarations: Vec<Value> = match field(&state, "sourceAssets") {
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    let mut declared: HashMap<Vec<u16>, (usize, Value)> = HashMap::new();
    for (index, descriptor) in declarations.iter().enumerate() {
        let id = display(field(descriptor, "id"));
        match declared.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => notices.error(
                "duplicate-state-asset",
                "duplicate-asset-id",
                Text::new("sourceAssets[").n(index).s("].id").v(),
                Text::new("Asset ID ")
                    .u(entry.key())
                    .s(" is declared more than once")
                    .v(),
            ),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((index, descriptor.clone()));
            }
        }
    }
    let mut payloads: HashMap<Vec<u16>, usize> = HashMap::new();
    for (index, payload) in assets.iter().enumerate() {
        let id = display(field(&payload.descriptor, "id"));
        if payloads.contains_key(&id) {
            notices.error(
                "duplicate-payload-asset",
                "duplicate-asset-payload",
                Text::new("assets[").n(index).s("].descriptor.id").v(),
                Text::new("Asset payload ")
                    .u(&id)
                    .s(" is returned more than once")
                    .v(),
            );
            continue;
        }
        payloads.insert(id.clone(), index);
        match declared.get(&id) {
            None => notices.error(
                "undeclared-payload",
                "undeclared-asset-payload",
                Text::new("assets[").n(index).s("]").v(),
                Text::new("Asset payload ")
                    .u(&id)
                    .s(" has no sourceAssets declaration")
                    .v(),
            ),
            Some((_, descriptor)) if *descriptor != payload.descriptor => notices.error(
                "asset-metadata-mismatch",
                "asset-metadata-mismatch",
                Text::new("assets[").n(index).s("].descriptor").v(),
                Text::new("Asset payload metadata for ")
                    .u(&id)
                    .s(" differs from canonical state")
                    .v(),
            ),
            _ => {}
        }
        let length = field(&payload.descriptor, "byteLength");
        if length != Some(&Value::Number(payload.bytes.len() as f64)) {
            notices.error(
                "asset-length",
                "asset-byte-length-mismatch",
                Text::new("assets[").n(index).s("].bytes").v(),
                Text::new("Asset ")
                    .u(&id)
                    .s(" declares ")
                    .u(&display(length))
                    .s(" bytes but contains ")
                    .n(payload.bytes.len())
                    .v(),
            );
        }
        if let Some(digest) = field(&payload.descriptor, "digest").and_then(string)
            && digest.starts_with(&key("fnv1a64:"))
            && *digest != key(&content_digest(&payload.bytes))
        {
            notices.error(
                "asset-digest",
                "asset-digest-mismatch",
                Text::new("assets[").n(index).s("].descriptor.digest").v(),
                Text::new("Asset ")
                    .u(&id)
                    .s(" does not match its declared digest")
                    .v(),
            );
        }
    }
    for (index, descriptor) in declarations.iter().enumerate() {
        let id = display(field(descriptor, "id"));
        if !payloads.contains_key(&id) {
            notices.error(
                "missing-payload",
                "missing-asset-payload",
                Text::new("sourceAssets[").n(index).s("]").v(),
                Text::new("Asset ").u(&id).s(" has no payload").v(),
            );
        }
    }
    for id in &imported {
        if !payloads.contains_key(id) {
            notices.error(
                "unknown-imported-asset",
                "unknown-imported-asset",
                s("importedAssetIds"),
                Text::new("Imported asset ID ")
                    .u(id)
                    .s(" does not name a returned payload")
                    .v(),
            );
        }
    }

    // Complete imported provenance in both the payload and its declaration.
    for id in &imported {
        let (Some(&payload), Some((index, _))) = (payloads.get(id), declared.get(id)) else {
            continue;
        };
        let descriptor = imported_descriptor(&assets[payload].descriptor, source);
        assets[payload].descriptor = descriptor.clone();
        if let Some(Value::Array(list)) = field_mut(&mut state, "sourceAssets") {
            list[*index] = descriptor;
        }
    }

    // Consolidate byte-identical assets.
    struct Item {
        payload: usize,
        imported: bool,
        order: usize,
    }
    let mut groups: Vec<(String, Vec<Item>)> = Vec::new();
    let mut by_digest: HashMap<String, usize> = HashMap::new();
    for (order, payload) in assets.iter().enumerate() {
        let digest = content_digest(&payload.bytes);
        let id = display(field(&payload.descriptor, "id"));
        let item = Item {
            payload: order,
            imported: imported_set.contains(id.as_slice()),
            order,
        };
        match by_digest.get(&digest) {
            Some(&group) => groups[group].1.push(item),
            None => {
                by_digest.insert(digest.clone(), groups.len());
                groups.push((digest, vec![item]));
            }
        }
    }
    let semantic = |descriptor: &Value| {
        record([
            (
                "kind",
                field(descriptor, "kind").cloned().unwrap_or(Value::Null),
            ),
            (
                "mediaType",
                field(descriptor, "mediaType")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "mesh",
                field(descriptor, "mesh").cloned().unwrap_or(Value::Null),
            ),
        ])
    };
    let mut aliases: HashMap<Vec<u16>, Vec<u16>> = HashMap::new();
    let mut mapped_imported: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut finals: Vec<(usize, AssetPayload)> = Vec::new();
    for (digest, items) in &groups {
        let first = &assets[items[0].payload];
        let bytes_match = items.iter().all(|i| assets[i.payload].bytes == first.bytes);
        let key_value = semantic(&first.descriptor);
        let metadata_match = items
            .iter()
            .all(|i| semantic(&assets[i.payload].descriptor) == key_value);
        if !bytes_match {
            notices.error(
                "content-digest-collision",
                "asset-content-digest-collision",
                s("assets"),
                Text::new("Assets sharing computed digest ")
                    .s(digest)
                    .s(" contain different bytes")
                    .v(),
            );
        } else if !metadata_match {
            let ids: Vec<Vec<u16>> = items
                .iter()
                .map(|i| display(field(&assets[i.payload].descriptor, "id")))
                .collect();
            notices.error(
                "asset-semantic-conflict",
                "asset-digest-semantic-conflict",
                s("sourceAssets"),
                Text::new("Byte-identical assets ")
                    .u(&ids.join(&[0x2c, 0x20][..]))
                    .s(" have incompatible kinds or mesh metadata")
                    .v(),
            );
        }
        let id_of = |i: &Item| display(field(&assets[i.payload].descriptor, "id"));
        if !(bytes_match && metadata_match) {
            for item in items {
                let id = id_of(item);
                aliases.insert(id.clone(), id.clone());
                finals.push((item.order, assets[item.payload].clone()));
                if item.imported {
                    mapped_imported.insert(id);
                }
            }
            continue;
        }
        let canonical = items
            .iter()
            .find(|i| !i.imported && base_content.get(&id_of(i)) == Some(digest))
            .unwrap_or(&items[0]);
        let metadata = items.iter().find(|i| i.imported).unwrap_or(canonical);
        let canonical_id = id_of(canonical);
        let mut descriptor = assets[metadata.payload].descriptor.clone();
        if let Value::Object(fields) = &mut descriptor {
            fields.insert(key("id"), Value::String(canonical_id.clone()));
            fields.insert(
                key("byteLength"),
                Value::Number(assets[canonical.payload].bytes.len() as f64),
            );
        }
        let payload = AssetPayload {
            descriptor,
            bytes: assets[canonical.payload].bytes.clone(),
        };
        for item in items {
            aliases.insert(id_of(item), canonical_id.clone());
            if item.imported {
                mapped_imported.insert(canonical_id.clone());
            }
            if std::ptr::eq(item, metadata) {
                continue;
            }
            let kept = provenance_of(&assets[metadata.payload].descriptor);
            let discarded = provenance_of(&assets[item.payload].descriptor);
            if matches!(&discarded, Value::Object(f) if !f.is_empty()) && kept != discarded {
                let id = notices.next_id("deduplicated-provenance");
                notices.dropped.push(record([
                    ("id", id),
                    ("path", Text::new("sourceAssets[id=").u(&id_of(item)).s("]").v()),
                    ("field", s("sourceFilename/provenance")),
                    (
                        "message",
                        Text::new("Duplicate asset metadata was superseded by the provenance retained for ")
                            .u(&canonical_id)
                            .v(),
                    ),
                    ("value", discarded),
                    ("requiresConfirmation", Value::Bool(false)),
                ]));
            }
        }
        if items.len() > 1 {
            let id = notices.next_id("asset-deduplication");
            notices.repairs.push(record([
                ("id", id),
                ("kind", s("asset-deduplication")),
                ("path", s("sourceAssets")),
                (
                    "message",
                    Text::new("")
                        .n(items.len())
                        .s(" byte-identical assets were consolidated as ")
                        .u(&canonical_id)
                        .v(),
                ),
                (
                    "before",
                    Value::Array(items.iter().map(|i| Value::String(id_of(i))).collect()),
                ),
                ("after", Value::String(canonical_id.clone())),
            ]));
            deduplicated += items.len() - 1;
        }
        finals.push((items.iter().map(|i| i.order).min().unwrap_or(0), payload));
    }
    finals.sort_by_key(|(order, _)| *order);
    let assets: Vec<AssetPayload> = finals.into_iter().map(|(_, p)| p).collect();
    if let Value::Object(fields) = &mut state {
        fields.insert(
            key("sourceAssets"),
            Value::Array(assets.iter().map(|a| a.descriptor.clone()).collect()),
        );
    }
    imported_count += mapped_imported.len();
    rewrite_references(&mut state, &aliases);

    // Graph validation, then the browser repository's restore checks.
    let candidate = ProjectState::from_value(state.clone())
        .ok()
        .and_then(|s| ProjectData::new(s).ok());
    let mut admitted = None;
    match &candidate {
        Some(data) => {
            let report = validate_project(data, timestamps)?;
            for issue in report.issues() {
                let id = notices.next_id(&format!("validation-{}", issue.code));
                notices.diagnostics.push(record([
                    ("id", id),
                    ("severity", s(issue.severity.as_str())),
                    ("code", s(issue.code)),
                    ("path", Value::String(issue.path.units().to_vec())),
                    ("message", Value::String(issue.message.units().to_vec())),
                ]));
            }
            if report.is_valid() {
                admitted = Some(ValidatedProject::new(data.clone(), timestamps).map_err(
                    |e| match e {
                        crate::validation::AdmissionError::Timestamp(e) => e,
                        crate::validation::AdmissionError::Invalid(_) => {
                            unreachable!("validated above")
                        }
                    },
                ));
            }
        }
        None => notices.error(
            "invalid-shape",
            "invalid-project-shape",
            s("$"),
            Text::new("The staged import is not a valid project document").v(),
        ),
    }
    let admitted = admitted.transpose()?;
    if let Some(message) = repository_error(&assets, &state) {
        notices.error(
            "invalid-staged-assets",
            "invalid-staged-asset-repository",
            s("assets"),
            Value::String(message),
        );
    }
    if stale {
        let id = notices.next_id("stale-base");
        notices.diagnostics.push(record([
            ("id", id),
            ("severity", s("error")),
            ("code", s("stale-import-base")),
            ("path", s("$")),
            (
                "message",
                s("The project changed while the import was being parsed; prepare a new preview"),
            ),
        ]));
    }

    // Preview.
    let plates = match field(&state, "plates") {
        Some(Value::Array(plates)) => plates.as_slice(),
        _ => &[],
    };
    let objects: usize = plates
        .iter()
        .map(|p| match field(p, "objects") {
            Some(Value::Array(o)) => o.len(),
            _ => 0,
        })
        .sum();
    let unresolved = notices
        .conflicts
        .iter()
        .any(|c| !truthy(field(c, "resolution")));
    let blocked = unresolved
        || notices
            .diagnostics
            .iter()
            .any(|d| field(d, "severity") == Some(&s("error")));
    let required = required_acknowledgements(&notices);
    let mut source_value = BTreeMap::new();
    source_value.insert(key("filename"), Value::String(source.filename.clone()));
    if let Some(media) = &source.media_type {
        source_value.insert(key("mediaType"), Value::String(media.clone()));
    }
    if let Some(uri) = &source.uri {
        source_value.insert(key("uri"), Value::String(uri.clone()));
    }
    source_value.insert(key("importedAt"), Value::String(source.imported_at.clone()));
    let preview = record([
        ("source", Value::Object(source_value)),
        ("mode", s("merge")),
        ("baseRevision", Value::Number(base_revision as f64)),
        ("baseHash", s(base_hash)),
        (
            "projectName",
            field(&state, "name").cloned().unwrap_or(Value::Null),
        ),
        (
            "counts",
            record([
                ("plates", Value::Number(plates.len() as f64)),
                ("objects", Value::Number(objects as f64)),
                ("assets", Value::Number(assets.len() as f64)),
                ("importedAssets", Value::Number(imported_count as f64)),
                ("deduplicatedAssets", Value::Number(deduplicated as f64)),
            ]),
        ),
        ("blocked", Value::Bool(blocked)),
        (
            "requiredAcknowledgementIds",
            Value::Array(required.iter().cloned().map(Value::String).collect()),
        ),
        ("repairs", Value::Array(notices.repairs)),
        ("conflicts", Value::Array(notices.conflicts)),
        ("droppedFields", Value::Array(notices.dropped)),
        ("diagnostics", Value::Array(notices.diagnostics)),
    ]);
    Ok(Prepared {
        preview,
        state,
        assets,
        project: if blocked { None } else { admitted },
        blocked,
        required,
        label: Text::new("Import ").u(&source.filename).0,
    })
}

fn field_mut<'a>(value: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    match value {
        Value::Object(fields) => fields.get_mut(&key(name)),
        _ => None,
    }
}

/// `normalizeImportedDescriptor`.
fn imported_descriptor(descriptor: &Value, source: &Source) -> Value {
    let mut out = descriptor.clone();
    let Value::Object(fields) = &mut out else {
        return out;
    };
    let filename = key("sourceFilename");
    if matches!(fields.get(&filename), None | Some(Value::Null)) {
        fields.insert(filename, Value::String(source.filename.clone()));
    }
    let provenance = key("provenance");
    match fields.get(&provenance).cloned() {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {
            let mut p = BTreeMap::new();
            p.insert(key("source"), s("import"));
            if let Some(uri) = source.uri.as_ref().filter(|u| !u.is_empty()) {
                p.insert(key("uri"), Value::String(uri.clone()));
            }
            p.insert(key("importedAt"), Value::String(source.imported_at.clone()));
            fields.insert(provenance, Value::Object(p));
        }
        Some(Value::Object(mut p)) if p.get(&key("source")) == Some(&s("import")) => {
            if !truthy(p.get(&key("uri")))
                && let Some(uri) = source.uri.as_ref().filter(|u| !u.is_empty())
            {
                p.insert(key("uri"), Value::String(uri.clone()));
            }
            if !truthy(p.get(&key("importedAt"))) {
                p.insert(key("importedAt"), Value::String(source.imported_at.clone()));
            }
            fields.insert(provenance, Value::Object(p));
        }
        _ => {}
    }
    out
}

fn provenance_of(descriptor: &Value) -> Value {
    let mut out = BTreeMap::new();
    for name in ["sourceFilename", "provenance"] {
        if let Some(value) = field(descriptor, name) {
            out.insert(key(name), value.clone());
        }
    }
    Value::Object(out)
}

fn rewrite_references(state: &mut Value, aliases: &HashMap<Vec<u16>, Vec<u16>>) {
    let resolve = |value: &mut Value| {
        if let Value::String(id) = value
            && let Some(alias) = aliases.get(id)
        {
            *id = alias.clone();
        }
    };
    let Value::Object(root) = state else { return };
    if let Some(Value::Array(plates)) = root.get_mut(&key("plates")) {
        for plate in plates {
            if let Some(Value::Array(objects)) = field_mut(plate, "objects") {
                for object in objects {
                    if let Some(Value::Array(volumes)) = field_mut(object, "volumes") {
                        for volume in volumes {
                            if let Some(id) =
                                field_mut(volume, "source").and_then(|s| field_mut(s, "assetId"))
                            {
                                resolve(id);
                            }
                        }
                    }
                }
            }
        }
    }
    for list in ["thumbnails", "extensionBlobs"] {
        if let Some(Value::Array(items)) = root.get_mut(&key(list)) {
            for item in items {
                if let Some(id) = field_mut(item, "assetId") {
                    resolve(id);
                }
            }
        }
    }
}

/// The browser repository's `restore` and bundle checks, with its messages.
fn repository_error(assets: &[AssetPayload], state: &Value) -> Option<Vec<u16>> {
    let mut restored: HashMap<Vec<u16>, &AssetPayload> = HashMap::new();
    for asset in assets {
        let id = display(field(&asset.descriptor, "id"));
        if restored.contains_key(&id) {
            return Some(Text::new("Asset snapshot contains duplicate ID ").u(&id).0);
        }
        if field(&asset.descriptor, "byteLength") != Some(&Value::Number(asset.bytes.len() as f64))
        {
            return Some(
                Text::new("Asset snapshot has invalid byte length for ")
                    .u(&id)
                    .0,
            );
        }
        if let Some(digest) = field(&asset.descriptor, "digest").and_then(string)
            && digest.starts_with(&key("fnv1a64:"))
            && *digest != key(&content_digest(&asset.bytes))
        {
            return Some(Text::new("Asset snapshot has invalid digest for ").u(&id).0);
        }
        restored.insert(id, asset);
    }
    let declarations = match field(state, "sourceAssets") {
        Some(Value::Array(list)) => list.as_slice(),
        _ => &[],
    };
    if restored.len() != declarations.len() {
        return Some(key(
            "Canonical asset declarations and payloads differ in length",
        ));
    }
    for descriptor in declarations {
        let id = display(field(descriptor, "id"));
        if restored
            .get(&id)
            .is_none_or(|p| p.descriptor != *descriptor)
        {
            return Some(Text::new("Canonical asset bundle differs for ").u(&id).0);
        }
    }
    None
}

/// `collectRequiredAcknowledgements`: lossy or reinterpreting notices need a
/// human; lossless repairs opt in. Sorted, unique.
fn required_acknowledgements(notices: &Notices) -> Vec<Vec<u16>> {
    let id = |n: &Value| {
        field(n, "id")
            .and_then(string)
            .map(<[u16]>::to_vec)
            .unwrap_or_default()
    };
    let mut out = BTreeSet::new();
    for repair in &notices.repairs {
        if field(repair, "requiresConfirmation") == Some(&Value::Bool(true)) {
            out.insert(id(repair));
        }
    }
    for conflict in &notices.conflicts {
        if truthy(field(conflict, "resolution"))
            && field(conflict, "requiresConfirmation") != Some(&Value::Bool(false))
        {
            out.insert(id(conflict));
        }
    }
    for dropped in &notices.dropped {
        if field(dropped, "requiresConfirmation") != Some(&Value::Bool(false)) {
            out.insert(id(dropped));
        }
    }
    out.into_iter().collect()
}

/// `PreparedProjectImport.confirm` checks, in the browser's order, before the
/// session commits. `current` is whether the base is still export-current.
pub fn check_confirmation(
    prepared: &Prepared,
    acknowledged: &[Vec<u16>],
    current: bool,
) -> Result<(), ConfirmError> {
    if prepared.blocked {
        return Err(ConfirmError::Blocked);
    }
    let acknowledged: HashSet<&[u16]> = acknowledged.iter().map(Vec::as_slice).collect();
    let missing: Vec<Vec<u16>> = prepared
        .required
        .iter()
        .filter(|id| !acknowledged.contains(id.as_slice()))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(ConfirmError::Missing(missing));
    }
    if !current {
        return Err(ConfirmError::Stale);
    }
    Ok(())
}

/// The admitted graph and final payloads, available only for an unblocked preview.
pub(crate) fn into_commit(
    prepared: Prepared,
) -> Option<(ValidatedProject, Vec<AssetPayload>, Vec<u16>)> {
    Some((prepared.project?, prepared.assets, prepared.label))
}
