//! Canonical-envelope staging and completion. The intermediate retains all
//! members until `complete` reconciles/adopts them into a prepared document.
//! Admission/hashing belongs on the host's preparation task, off live authority.
pub(crate) mod complete;
mod legacy;
mod stream;
pub use complete::{CompleteLimits, CompletedCanonicalArchive, ImportWarning};
pub mod write;

use crate::{Archive, Entry, EntryReceipt, validate_package_path};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::{AssetLease, AssetRepository},
    ids::AssetId,
    ingress::{AssetInputError, DocumentError, ProjectBundleInput, ProjectInputLimits},
    model::{Decode, ProjectData, ProjectState},
    validation::{TimestampPolicy, ValidatedProject},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{self, Read, Seek, Write},
};

pub const ENVELOPE_PATH: &str = "Metadata/orcaxr/project-v1.json";
pub const ENVELOPE_FORMAT: &str = "https://orcaxr.martinez.fyi/3mf/project/1";
pub(crate) const STRUCTURAL: &[&str] = &[
    ENVELOPE_PATH,
    "[Content_Types].xml",
    "_rels/.rels",
    "3D/3dmodel.model",
    "3D/_rels/3dmodel.model.rels",
    "Metadata/project_settings.config",
    "Metadata/model_settings.config",
    "Metadata/layer_config_ranges.xml",
    "Metadata/custom_gcode_per_layer.xml",
    "Metadata/brim_ear_points.txt",
    "Metadata/layer_heights_profile.txt",
];

const fn ascii<const N: usize>(value: &str) -> [u16; N] {
    let mut result = [0; N];
    let mut i = 0;
    while i < N {
        result[i] = value.as_bytes()[i] as u16;
        i += 1;
    }
    result
}
macro_rules! k {
    ($value:literal) => {
        &ascii::<{ $value.len() }>($value) as &[u16]
    };
}
use k;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Archive(crate::Error),
    Opc(crate::opc::Error),
    Json(orcaxr_project::ingress::json::JsonInputError),
    MissingEnvelope,
    Envelope,
    UnsafeKey,
    Migration,
    Mapping,
    MissingMember,
    BlobMismatch,
    ResourceLimit,
    Bbs(crate::bbs::model::Error),
    Settings(crate::bbs::model::settings::Error),
    /// Foreign BBS/3MF import without an OrcaXR envelope.
    Foreign(crate::bbs::foreign::Failure),
    Bundle,
    Cancelled,
}
/// Private paths, identifiers and host timestamp error messages never appear in
/// Debug/Display. Service errors remain distinguishable from invalid documents.
pub enum Error<E> {
    Failure(Failure),
    Document(DocumentError<E>),
    Asset(AssetInputError),
}
impl<E> From<Failure> for Error<E> {
    fn from(e: Failure) -> Self {
        Self::Failure(e)
    }
}
impl<E> fmt::Debug for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failure(e) => fmt::Debug::fmt(e, f),
            Self::Document(e) => fmt::Debug::fmt(e, f),
            Self::Asset(e) => fmt::Debug::fmt(e, f),
        }
    }
}
impl<E> fmt::Display for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl<E> std::error::Error for Error<E> {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MigrationCounts {
    pub dense_channels: usize,
    pub false_fuzzy_assignments: usize,
}
/// Entry indexes refer to this retained archive only. They are never entity IDs.
pub struct AssetMapping {
    pub asset_id: AssetId,
    pub entry: usize,
}

pub struct CanonicalArchiveSource<R> {
    archive: Archive<R>,
    project: ValidatedProject,
    assets: AssetRepository,
    mappings: Vec<AssetMapping>,
    migrations: MigrationCounts,
    unsupported_digests: Vec<usize>,
}
impl<R: Read + Seek> CanonicalArchiveSource<R> {
    /// Consume staged ownership while merging OPC metadata. Failure or cancellation
    /// discards this private source; no live document or completed import exists.
    /// BBS regeneration and unknown-member adoption must still follow this step.
    pub fn reconcile_opc<P: TimestampPolicy>(
        mut self,
        limits: crate::opc::Limits,
        timestamps: &mut P,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<(Self, Vec<crate::opc::Warning>), Error<P::Error>> {
        let merged = crate::opc::read(
            &mut self.archive,
            self.project.state(),
            limits,
            &mut cancelled,
        )
        .map_err(Failure::Opc)?;
        let mut candidate = self.project.to_candidate();
        drop(self.project);
        let warnings = merged.apply(&mut candidate).map_err(Failure::Opc)?;
        check_cancel(&mut cancelled)?;
        self.project = admit(candidate, timestamps)?;
        check_cancel(&mut cancelled)?;
        Ok((self, warnings))
    }
    /// Consume a privately staged immutable archive. Every member must pass CRC
    /// and length validation, including unowned members. No partial result escapes
    /// on cancellation, budget, migration, timestamp, graph or asset failure.
    pub fn decode<P: TimestampPolicy>(
        mut archive: Archive<R>,
        limits: ProjectInputLimits,
        timestamps: &mut P,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error<P::Error>> {
        check_cancel(&mut cancelled)?;
        let envelope_index = archive
            .entries()
            .iter()
            .position(|e| !e.is_directory() && e.path() == ENVELOPE_PATH)
            .ok_or(Failure::MissingEnvelope)?;
        let length = usize::try_from(archive.entries()[envelope_index].bytes())
            .map_err(|_| Failure::Json(orcaxr_project::ingress::json::JsonInputError::Limit))?;
        let mut json = stream::JsonSink::new(length, limits.document)?;
        let read = archive.read_entry(envelope_index, &mut json, &mut cancelled);
        if let Some(error) = json.failure() {
            return Err(Failure::Json(error).into());
        }
        read.map_err(Failure::Archive)?;
        let root = json.finish()?;
        safe_tree(&root, &mut cancelled)?;
        let Value::Object(mut fields) = root else {
            return Err(Failure::Envelope.into());
        };
        if !matches!(fields.get(k!("format")),Some(Value::String(v)) if v.iter().copied().eq(ENVELOPE_FORMAT.encode_utf16()))
            || fields.get(k!("version")) != Some(&Value::Number(1.0))
        {
            return Err(Failure::Envelope.into());
        }
        let mut state = fields.remove(k!("state")).ok_or(Failure::Envelope)?;
        if !matches!(state, Value::Object(_)) {
            return Err(Failure::Envelope.into());
        }
        let Some(Value::Array(raw_mappings)) = fields.remove(k!("assetEntries")) else {
            return Err(Failure::Envelope.into());
        };
        // Unknown envelope fields were inspected, but are not part of schema-1 state.
        drop(fields);
        let dense_channels = legacy::dense(&mut state, &mut cancelled)?;
        let old_false = legacy::coerce_false(&mut state, &mut cancelled)?;
        let state = ProjectState::from_value(state)
            .map_err(|e| Error::Document(DocumentError::Shape(e)))?;
        let mut project = admit(state, timestamps)?;
        check_cancel(&mut cancelled)?;
        if !old_false.is_empty() {
            let mut candidate = project.to_candidate();
            drop(project);
            legacy::remove_false(&mut candidate, &old_false, &mut cancelled)?;
            project = admit(candidate, timestamps)?;
        }
        let migrations = MigrationCounts {
            dense_channels,
            false_fuzzy_assignments: old_false.len(),
        };
        let mut bundle = ProjectBundleInput::from_admitted(project, limits)
            .map_err(|_| Error::Document(DocumentError::AssetBudget))?;
        let members = archive
            .entries()
            .iter()
            .enumerate()
            .filter(|(_, e)| !e.is_directory())
            .map(|(i, e)| (e.path(), i))
            .collect::<BTreeMap<_, _>>();
        let descriptors = bundle.project().state().source_assets.clone();
        let declared = descriptors
            .iter()
            .map(|d| d.id.clone())
            .collect::<BTreeSet<_>>();
        if raw_mappings.len() != declared.len() {
            return Err(Failure::Mapping.into());
        }
        let mut mappings = Vec::with_capacity(raw_mappings.len());
        let mut by_id = BTreeMap::new();
        let mut paths = BTreeSet::new();
        for mapping in raw_mappings {
            check_cancel(&mut cancelled)?;
            let Value::Object(mut fields) = mapping else {
                return Err(Failure::Mapping.into());
            };
            let Some(Value::String(id)) = fields.remove(k!("assetId")) else {
                return Err(Failure::Mapping.into());
            };
            let Some(Value::String(path)) = fields.remove(k!("path")) else {
                return Err(Failure::Mapping.into());
            };
            let id = AssetId::try_from_utf16(id).map_err(|_| Failure::Mapping)?;
            let path = package_path(&path)?;
            if !declared.contains(&id)
                || STRUCTURAL.contains(&path.as_str())
                || !paths.insert(path.clone())
                || by_id.contains_key(&id)
            {
                return Err(Failure::Mapping.into());
            }
            let entry = *members.get(path.as_str()).ok_or(Failure::MissingMember)?;
            by_id.insert(id.clone(), entry);
            mappings.push(AssetMapping {
                asset_id: id,
                entry,
            });
        }
        // Resolve declared blobs before payload allocation. Their actual bytes
        // are compared against the admitted asset with no second payload buffer.
        let mut blobs = Vec::new();
        for blob in bundle.project().state().extension_blobs.iter() {
            let path = package_path(blob.path.units())?;
            let entry = *members.get(path.as_str()).ok_or(Failure::MissingMember)?;
            blobs.push((blob.asset_id.clone(), entry));
        }
        drop(members);
        let mut verified = vec![false; archive.entries().len()];
        verified[envelope_index] = true;
        let mut unsupported_digests = Vec::new();
        for (ordinal, descriptor) in descriptors.iter().enumerate() {
            check_cancel(&mut cancelled)?;
            let entry = by_id[&descriptor.id];
            if archive.entries()[entry].bytes() as f64 != descriptor.byte_length.get() {
                return Err(Failure::Archive(crate::Error::SizeMismatch).into());
            }
            bundle.begin_asset(&descriptor.id).map_err(Error::Asset)?;
            let mut output = stream::AssetSink::new(&mut bundle);
            let read = archive.read_entry(entry, &mut output, &mut cancelled);
            if let Some(error) = output.failure.take() {
                return Err(Error::Asset(error));
            }
            read.map_err(Failure::Archive)?;
            bundle.finish_asset().map_err(Error::Asset)?;
            verified[entry] = true;
            if !descriptor.digest.units().starts_with(k!("fnv1a64:")) {
                unsupported_digests.push(ordinal);
            }
        }
        let (project, assets) = bundle.finish().map_err(Error::Asset)?;
        for (asset, entry) in blobs {
            check_cancel(&mut cancelled)?;
            let lease = assets.peek(&asset).ok_or(Failure::Mapping)?;
            if archive.entries()[entry].bytes() != lease.bytes().len() as u64 {
                return Err(Failure::BlobMismatch.into());
            }
            let mut output = stream::CompareSink::new(lease.bytes());
            let read = archive.read_entry(entry, &mut output, &mut cancelled);
            if output.mismatch {
                return Err(Failure::BlobMismatch.into());
            }
            read.map_err(Failure::Archive)?;
            verified[entry] = true;
        }
        for (index, verified) in verified.iter().enumerate() {
            if !verified {
                archive
                    .read_entry(index, &mut io::sink(), &mut cancelled)
                    .map_err(Failure::Archive)?;
            }
        }
        check_cancel(&mut cancelled)?;
        Ok(Self {
            archive,
            project,
            assets,
            mappings,
            migrations,
            unsupported_digests,
        })
    }
    pub fn project(&self) -> &ValidatedProject {
        &self.project
    }
    pub fn asset(&self, id: &AssetId) -> Option<AssetLease> {
        self.assets.peek(id)
    }
    pub fn mappings(&self) -> &[AssetMapping] {
        &self.mappings
    }
    pub fn migrations(&self) -> MigrationCounts {
        self.migrations
    }
    /// Source declaration ordinals whose digest scheme was not verified. Their
    /// CRC and byte length were verified; callers must retain that distinction.
    pub fn unsupported_digest_indices(&self) -> &[usize] {
        &self.unsupported_digests
    }
    pub fn entries(&self) -> &[Entry] {
        self.archive.entries()
    }
    pub fn read_member(
        &mut self,
        index: usize,
        out: &mut impl Write,
        cancelled: impl FnMut() -> bool,
    ) -> crate::Result<EntryReceipt> {
        self.archive.read_entry(index, out, cancelled)
    }
}
fn admit<P: TimestampPolicy>(
    state: ProjectState,
    timestamps: &mut P,
) -> Result<ValidatedProject, Error<P::Error>> {
    let data = ProjectData::new(state).map_err(|_| Error::Document(DocumentError::Encoding))?;
    ValidatedProject::new(data, timestamps)
        .map_err(|e| Error::Document(DocumentError::Admission(e)))
}
fn check_cancel(cancelled: &mut impl FnMut() -> bool) -> Result<(), Failure> {
    if cancelled() {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn package_path(units: &[u16]) -> Result<String, Failure> {
    let path = String::from_utf16(units).map_err(|_| Failure::Mapping)?;
    validate_package_path(&path, 512).map_err(Failure::Archive)?;
    Ok(path)
}
fn safe_tree(value: &Value, cancelled: &mut impl FnMut() -> bool) -> Result<(), Failure> {
    check_cancel(cancelled)?;
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if [k!("__proto__"), k!("prototype"), k!("constructor")].contains(&key.as_slice()) {
                    return Err(Failure::UnsafeKey);
                }
                safe_tree(child, cancelled)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                safe_tree(child, cancelled)?;
            }
        }
        _ => {}
    }
    Ok(())
}
