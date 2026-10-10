//! Canonical-package OPC metadata compatibility. The legacy tag scanner matches
//! the existing browser contract; it is not a general XML parser or BBS loader.
//! It never resolves external entities or performs network/filesystem extraction.
mod scan;
mod write;
use crate::{Archive, canonical::ENVELOPE_PATH};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::{JsonObject, ProjectState, Text};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{Read, Seek},
};
pub use write::Authoring;
pub const MODEL: &str = "3D/3dmodel.model";
pub const ROOT_RELS: &str = "_rels/.rels";
pub const MODEL_RELS: &str = "3D/_rels/3dmodel.model.rels";
pub const CONTENT_TYPES: &str = "[Content_Types].xml";
pub const RELATIONSHIPS_KEY: &str = "https://orcaxr.martinez.fyi/3mf/project/1/opc-relationships";
pub const CONTENT_TYPES_KEY: &str = "https://orcaxr.martinez.fyi/3mf/project/1/opc-content-types";
const MODEL_TYPE: &str = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const STATE_TYPE: &str = "https://orcaxr.martinez.fyi/3mf/project/1/relationships/project-state";
const STATE_CONTENT_TYPE: &str = "application/vnd.orcaxr.project+json";
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub part_bytes: u64,
    pub tag_bytes: usize,
    pub records: usize,
    pub text_units: usize,
    pub output_bytes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Archive(crate::Error),
    Limits,
    ResourceLimit,
    Utf8,
    DuplicateAttribute,
    CharacterReference,
    PreservedRelationship,
    PreservedContentType,
    DuplicateRelationshipId,
    MissingMember,
    ContentType,
    UnsafeTarget,
    XmlCharacter,
    Cancelled,
    Encoding,
    Io(std::io::ErrorKind),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "opc_{self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Root,
    Model,
}
impl Source {
    pub fn path(self) -> &'static str {
        match self {
            Self::Root => "/",
            Self::Model => MODEL,
        }
    }
    pub fn member(self) -> &'static str {
        match self {
            Self::Root => ROOT_RELS,
            Self::Model => MODEL_RELS,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Warning {
    IncompleteRelationship {
        source: Source,
    },
    MissingRelationshipTarget {
        source: Source,
        id: Text,
        target: Text,
    },
    MissingContentTypes,
    MissingOverride {
        part_name: Text,
    },
    DroppedRelationships {
        targets: Vec<Text>,
        count: usize,
    },
}
#[derive(Debug, Clone)]
struct Relationship {
    source: Source,
    id: Text,
    kind: Text,
    target: Text,
    external: bool,
}
#[derive(Debug, Clone)]
enum ContentType {
    Default { extension: Text, kind: Text },
    Override { part_name: Text, kind: Text },
}
fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn eq(v: &[u16], s: &str) -> bool {
    v.iter().copied().eq(s.encode_utf16())
}
fn field<'a>(v: &'a BTreeMap<Vec<u16>, Value>, name: &str) -> Option<&'a Value> {
    v.get(&units(name))
}
fn text<'a>(v: &'a BTreeMap<Vec<u16>, Value>, name: &str) -> Option<&'a [u16]> {
    match field(v, name) {
        Some(Value::String(v)) => Some(v),
        _ => None,
    }
}
fn object(v: &Value) -> Option<&BTreeMap<Vec<u16>, Value>> {
    match v {
        Value::Object(v) => Some(v),
        _ => None,
    }
}
fn key(parts: &[&[u16]]) -> Vec<u16> {
    let mut result = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i != 0 {
            result.push(0);
        }
        result.extend_from_slice(p);
    }
    result
}
fn check(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
struct Budget {
    limits: Limits,
    records: usize,
    text: usize,
}
impl Budget {
    fn new(limits: Limits) -> Result<Self, Error> {
        if limits.part_bytes == 0
            || limits.part_bytes > 9_007_199_254_740_991
            || limits.tag_bytes == 0
        {
            return Err(Error::Limits);
        }
        Ok(Self {
            limits,
            records: 0,
            text: 0,
        })
    }
    fn record(&mut self) -> Result<(), Error> {
        self.records = self
            .records
            .checked_add(1)
            .filter(|&n| n <= self.limits.records)
            .ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn text(&mut self, n: usize) -> Result<(), Error> {
        self.text = self
            .text
            .checked_add(n)
            .filter(|&n| n <= self.limits.text_units)
            .ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn owned(&mut self, v: &[u16]) -> Result<Text, Error> {
        self.text(v.len())?;
        Ok(Text::new(v.to_vec()))
    }
}
fn extension_valid(v: &[u16]) -> bool {
    !v.is_empty()
        && v[0] <= 127
        && (v[0] as u8).is_ascii_alphanumeric()
        && v.iter().all(|&c| {
            c <= 127 && ((c as u8).is_ascii_alphanumeric() || b"._+-".contains(&(c as u8)))
        })
}
fn lower_ascii(v: &[u16]) -> Vec<u16> {
    v.iter()
        .map(|&c| if (65..=90).contains(&c) { c + 32 } else { c })
        .collect()
}
fn path_valid(v: &[u16]) -> bool {
    if v.is_empty()
        || v.len() > 512
        || v[0] == 47
        || v.iter().any(|&c| c < 32 || c == 127 || c == 92)
        || v.len() >= 2 && v[0] < 128 && (v[0] as u8).is_ascii_alphabetic() && v[1] == 58
    {
        return false;
    }
    if v.split(|&c| c == 47)
        .any(|s| s.is_empty() || eq(s, ".") || eq(s, ".."))
    {
        return false;
    }
    let Ok(path) = String::from_utf16(v) else {
        return false;
    };
    path.len() <= 512
}
pub fn resolve_target(source: Source, target: &[u16]) -> Result<Vec<u16>, Error> {
    let target = &target[..target
        .iter()
        .position(|&v| v == 35 || v == 63)
        .unwrap_or(target.len())];
    let mut segments: Vec<&[u16]> = if target.first() == Some(&47) || source == Source::Root {
        vec![]
    } else {
        vec![&[51, 68]]
    };
    for segment in target.split(|&v| v == 47) {
        if segment.is_empty() || eq(segment, ".") {
            continue;
        }
        if eq(segment, "..") {
            segments.pop().ok_or(Error::UnsafeTarget)?;
            continue;
        }
        if segment.contains(&92) || segment.contains(&0) {
            return Err(Error::UnsafeTarget);
        }
        segments.push(segment);
    }
    let length = segments.iter().map(|s| s.len()).sum::<usize>() + segments.len().saturating_sub(1);
    if length > 512 {
        return Err(Error::UnsafeTarget);
    }
    let mut result = Vec::with_capacity(length);
    for (i, s) in segments.iter().enumerate() {
        if i != 0 {
            result.push(47);
        }
        result.extend_from_slice(s);
    }
    if !path_valid(&result) {
        return Err(Error::UnsafeTarget);
    }
    Ok(result)
}
impl Relationship {
    fn key(&self) -> Vec<u16> {
        key(&[
            &units(self.source.path()),
            self.id.units(),
            self.kind.units(),
            self.target.units(),
            &units(if self.external {
                "External"
            } else {
                "Internal"
            }),
        ])
    }
    fn generated(&self) -> Result<bool, Error> {
        if self.source != Source::Root {
            return Ok(false);
        }
        Ok((eq(self.kind.units(), MODEL_TYPE)
            && eq(&resolve_target(Source::Root, self.target.units())?, MODEL))
            || (eq(self.kind.units(), STATE_TYPE)
                && eq(
                    &resolve_target(Source::Root, self.target.units())?,
                    ENVELOPE_PATH,
                )))
    }
    fn value(self) -> Value {
        record([
            ("source", Value::String(units(self.source.path()))),
            ("id", Value::String(self.id.units().to_vec())),
            ("type", Value::String(self.kind.units().to_vec())),
            ("target", Value::String(self.target.units().to_vec())),
            (
                "targetMode",
                Value::String(units(if self.external {
                    "External"
                } else {
                    "Internal"
                })),
            ),
        ])
    }
}
impl ContentType {
    fn key(&self) -> Vec<u16> {
        match self {
            Self::Default { extension, .. } => {
                key(&[&units("default"), &lower_ascii(extension.units())])
            }
            Self::Override { part_name, .. } => key(&[&units("override"), part_name.units()]),
        }
    }
    fn value(self) -> Value {
        match self {
            Self::Default { extension, kind } => record([
                ("kind", Value::String(units("default"))),
                ("extension", Value::String(extension.units().to_vec())),
                ("contentType", Value::String(kind.units().to_vec())),
            ]),
            Self::Override { part_name, kind } => record([
                ("kind", Value::String(units("override"))),
                ("partName", Value::String(part_name.units().to_vec())),
                ("contentType", Value::String(kind.units().to_vec())),
            ]),
        }
    }
}
fn record<const N: usize>(v: [(&str, Value); N]) -> Value {
    Value::Object(v.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn metadata<'a>(state: &'a ProjectState, name: &str) -> Option<&'a Value> {
    state
        .extension_data
        .as_ref()
        .and_then(|v| object(v.value()))
        .and_then(|v| field(v, name))
}
fn preserved_relationships(
    state: &ProjectState,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Vec<Relationship>, Error> {
    let Some(raw) = metadata(state, RELATIONSHIPS_KEY) else {
        return Ok(vec![]);
    };
    let Value::Array(raw) = raw else {
        return Err(Error::PreservedRelationship);
    };
    let mut result = Vec::new();
    for row in raw {
        check(cancelled)?;
        budget.record()?;
        let o = object(row).ok_or(Error::PreservedRelationship)?;
        let source = match text(o, "source") {
            Some(v) if eq(v, "/") => Source::Root,
            Some(v) if eq(v, MODEL) => Source::Model,
            _ => return Err(Error::PreservedRelationship),
        };
        let get = |name| {
            text(o, name)
                .filter(|v| !v.is_empty())
                .ok_or(Error::PreservedRelationship)
        };
        let external = match get("targetMode")? {
            v if eq(v, "Internal") => false,
            v if eq(v, "External") => true,
            _ => return Err(Error::PreservedRelationship),
        };
        let row = Relationship {
            source,
            id: budget.owned(get("id")?)?,
            kind: budget.owned(get("type")?)?,
            target: budget.owned(get("target")?)?,
            external,
        };
        if !external {
            resolve_target(source, row.target.units())?;
        }
        result.push(row);
    }
    Ok(result)
}
fn preserved_types(
    state: &ProjectState,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Vec<ContentType>, Error> {
    let Some(raw) = metadata(state, CONTENT_TYPES_KEY) else {
        return Ok(vec![]);
    };
    let Value::Array(raw) = raw else {
        return Err(Error::PreservedContentType);
    };
    let mut result = Vec::new();
    for row in raw {
        check(cancelled)?;
        budget.record()?;
        let o = object(row).ok_or(Error::PreservedContentType)?;
        let kind = budget.owned(
            text(o, "contentType")
                .filter(|s| !s.is_empty())
                .ok_or(Error::PreservedContentType)?,
        )?;
        match text(o, "kind") {
            Some(v) if eq(v, "default") => {
                let e = text(o, "extension")
                    .filter(|v| extension_valid(v))
                    .ok_or(Error::PreservedContentType)?;
                result.push(ContentType::Default {
                    extension: budget.owned(e)?,
                    kind,
                });
            }
            Some(v) if eq(v, "override") => {
                let p = text(o, "partName").ok_or(Error::PreservedContentType)?;
                if p.first() != Some(&47) || !path_valid(&p[1..]) {
                    return Err(Error::UnsafeTarget);
                }
                result.push(ContentType::Override {
                    part_name: budget.owned(p)?,
                    kind,
                });
            }
            _ => return Err(Error::PreservedContentType),
        }
    }
    Ok(result)
}
/// Privately collected replacements. Applying consumes metadata so unshared
/// extension data moves unchanged; no mesh or full-state JSON copy is made.
pub struct Merge {
    relationships: Option<Value>,
    types: Option<Value>,
    pub warnings: Vec<Warning>,
}
impl Merge {
    pub fn apply(self, state: &mut ProjectState) -> Result<Vec<Warning>, Error> {
        if self.relationships.is_some() || self.types.is_some() {
            let Value::Object(mut fields) = state
                .extension_data
                .take()
                .map(JsonObject::into_value)
                .unwrap_or_else(|| Value::Object(BTreeMap::new()))
            else {
                unreachable!();
            };
            if let Some(v) = self.relationships {
                fields.insert(units(RELATIONSHIPS_KEY), v);
            }
            if let Some(v) = self.types {
                fields.insert(units(CONTENT_TYPES_KEY), v);
            }
            state.extension_data =
                Some(JsonObject::new(Value::Object(fields)).map_err(|_| Error::Encoding)?);
        }
        Ok(self.warnings)
    }
}
/// Read/merge only the three supported OPC parts. All source members stay owned
/// by Archive and all output remains staged until the caller's final graph proof.
pub fn read<R: Read + Seek>(
    archive: &mut Archive<R>,
    state: &ProjectState,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Merge, Error> {
    let mut budget = Budget::new(limits)?;
    let mut warnings = Vec::new();
    let members = archive
        .entries()
        .iter()
        .enumerate()
        .filter(|(_, e)| !e.is_directory())
        .map(|(i, e)| (units(e.path()), i))
        .collect::<BTreeMap<_, _>>();
    let mut relationships = BTreeMap::new();
    for r in preserved_relationships(state, &mut budget, &mut cancelled)? {
        relationships.insert(r.key(), r);
    }
    for source in [Source::Root, Source::Model] {
        let Some(&index) = members.get(&units(source.member())) else {
            continue;
        };
        let mut ids = BTreeSet::new();
        scan::read(
            archive,
            index,
            scan::Kind::Relationships,
            &mut budget,
            &mut cancelled,
            |_, attrs, _budget| {
                let get = |a: &str, b: &str| {
                    attrs
                        .get(a)
                        .or_else(|| attrs.get(b))
                        .filter(|v| !v.is_empty())
                };
                let (Some(id), Some(kind), Some(target)) = (
                    get("Id", "id"),
                    get("Type", "type"),
                    get("Target", "target"),
                ) else {
                    warnings.push(Warning::IncompleteRelationship { source });
                    return Ok(());
                };
                if !ids.insert(id.clone()) {
                    return Err(Error::DuplicateRelationshipId);
                }
                let external = get("TargetMode", "targetMode")
                    .is_some_and(|v| eq(&lower_ascii(v), "external"));
                let r = Relationship {
                    source,
                    id: Text::new(id.clone()),
                    kind: Text::new(kind.clone()),
                    target: Text::new(target.clone()),
                    external,
                };
                if r.generated()? {
                    return Ok(());
                }
                if !r.external {
                    let target = resolve_target(source, r.target.units())?;
                    if !members.contains_key(&target) {
                        warnings.push(Warning::MissingRelationshipTarget {
                            source,
                            id: r.id.clone(),
                            target: Text::new(target),
                        });
                    }
                }
                relationships.insert(r.key(), r);
                Ok(())
            },
        )?;
    }
    let relationships = (!relationships.is_empty()).then(|| {
        Value::Array(
            relationships
                .into_values()
                .map(Relationship::value)
                .collect(),
        )
    });
    let mut types = BTreeMap::new();
    if let Some(&index) = members.get(&units(CONTENT_TYPES)) {
        for r in preserved_types(state, &mut budget, &mut cancelled)? {
            types.insert(r.key(), r);
        }
        scan::read(
            archive,
            index,
            scan::Kind::ContentTypes,
            &mut budget,
            &mut cancelled,
            |tag, attrs, _budget| {
                let get = |a: &str, b: &str| {
                    attrs
                        .get(a)
                        .or_else(|| attrs.get(b))
                        .filter(|v| !v.is_empty())
                };
                let kind = get("ContentType", "contentType").ok_or(Error::ContentType)?;
                let entry = if tag == scan::Tag::Default {
                    let extension = get("Extension", "extension")
                        .filter(|v| extension_valid(v))
                        .ok_or(Error::ContentType)?;
                    let suffix = [vec![46], lower_ascii(extension)].concat();
                    if let Some(path) = members.keys().find(|p| lower_path(p).ends_with(&suffix))
                        && eq(kind, media_type(path))
                    {
                        return Ok(());
                    }
                    ContentType::Default {
                        extension: Text::new(extension.clone()),
                        kind: Text::new(kind.clone()),
                    }
                } else {
                    let p = get("PartName", "partName").ok_or(Error::ContentType)?;
                    if p.first() != Some(&47) || !path_valid(&p[1..]) {
                        return Err(Error::UnsafeTarget);
                    }
                    if eq(&p[1..], ENVELOPE_PATH) && eq(kind, STATE_CONTENT_TYPE) {
                        return Ok(());
                    }
                    if members.contains_key(&p[1..])
                        && default_extension(&p[1..]).is_none()
                        && eq(kind, media_type(&p[1..]))
                    {
                        return Ok(());
                    }
                    if !members.contains_key(&p[1..]) {
                        warnings.push(Warning::MissingOverride {
                            part_name: Text::new(p.clone()),
                        });
                    }
                    ContentType::Override {
                        part_name: Text::new(p.clone()),
                        kind: Text::new(kind.clone()),
                    }
                };
                types.insert(entry.key(), entry);
                Ok(())
            },
        )?;
    } else {
        warnings.push(Warning::MissingContentTypes);
    }
    check(&mut cancelled)?;
    Ok(Merge {
        relationships,
        types: (!types.is_empty())
            .then(|| Value::Array(types.into_values().map(ContentType::value).collect())),
        warnings,
    })
}
// Persisted declarations use the same pinned Unicode data on every host.
fn lower_path(path: &[u16]) -> Vec<u16> {
    orcaxr_project::js_math::case::lower(path)
}
fn default_extension(path: &[u16]) -> Option<Vec<u16>> {
    let dot = path.iter().rposition(|&c| c == 46)?;
    let extension = lower_path(&path[dot + 1..]);
    extension_valid(&extension).then_some(extension)
}
pub(crate) fn media_type(path: &[u16]) -> &'static str {
    let lower = lower_path(path);
    for (suffix, kind) in [
        (
            ".rels",
            "application/vnd.openxmlformats-package.relationships+xml",
        ),
        (
            ".model",
            "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        ),
        (".json", "application/json"),
        (".xml", "text/xml"),
        (".config", "text/xml"),
        (".txt", "text/plain"),
        (".gcode", "text/plain"),
        (".png", "image/png"),
        (".jpg", "image/jpeg"),
        (".jpeg", "image/jpeg"),
        (".webp", "image/webp"),
    ] {
        if lower.ends_with(&units(suffix)) {
            return kind;
        }
    }
    "application/octet-stream"
}
