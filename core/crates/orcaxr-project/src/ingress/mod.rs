//! Staged bulk input for native project hosts. No input publishes live state.
pub mod command_record;
pub mod command_work;
pub mod json;

use crate::{
    assets::{AssetError, AssetPayload, AssetRepository},
    ids::AssetId,
    model::{Decode, Encode, ProjectData, ProjectState, ShapeError},
    validation::{AdmissionError, TimestampPolicy, ValidatedProject},
};
use json::{JsonInput, JsonInputError, JsonLimits, MAX_CHUNK_BYTES};
use std::fmt;

#[derive(Debug, Clone, Copy)]
pub struct ProjectInputLimits {
    pub document: JsonLimits,
    pub max_assets: usize,
    pub max_asset_bytes: usize,
    pub max_total_asset_bytes: usize,
}

pub enum DocumentError<E> {
    Json(JsonInputError),
    Shape(ShapeError),
    Admission(AdmissionError<E>),
    AssetBudget,
    Encoding,
}
impl<E> fmt::Debug for DocumentError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => fmt::Debug::fmt(e, f),
            Self::Shape(e) => fmt::Debug::fmt(e, f),
            Self::Admission(e) => fmt::Debug::fmt(e, f),
            Self::AssetBudget => f.write_str("AssetBudget"),
            Self::Encoding => f.write_str("CanonicalEncoding"),
        }
    }
}
impl<E> fmt::Display for DocumentError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl<E> std::error::Error for DocumentError<E> {}

pub struct ProjectInput {
    json: JsonInput,
    limits: ProjectInputLimits,
}
impl ProjectInput {
    pub fn new(bytes: usize, limits: ProjectInputLimits) -> Result<Self, JsonInputError> {
        Ok(Self {
            json: JsonInput::new(bytes, limits.document)?,
            limits,
        })
    }
    pub fn received_bytes(&self) -> usize {
        self.json.received_bytes()
    }
    pub fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), JsonInputError> {
        self.json.append(offset, bytes)
    }
    /// Shape, semantic admission and aggregate asset budgets must all succeed
    /// before payload transfer. The task owns this work; it cannot change an
    /// existing live session even when validation or timezone services fail.
    pub fn finish<P: TimestampPolicy>(
        self,
        timestamps: &mut P,
    ) -> Result<ProjectBundleInput, DocumentError<P::Error>> {
        let value = self.json.finish().map_err(DocumentError::Json)?;
        let state = ProjectState::from_value(value).map_err(DocumentError::Shape)?;
        let project = ProjectData::new(state).map_err(|_| DocumentError::Encoding)?;
        let project =
            ValidatedProject::new(project, timestamps).map_err(DocumentError::Admission)?;
        ProjectBundleInput::from_admitted(project, self.limits)
            .map_err(|_| DocumentError::AssetBudget)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetBudgetError;
impl fmt::Display for AssetBudgetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Declared assets exceed input budgets")
    }
}
impl std::error::Error for AssetBudgetError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetInputError {
    Busy,
    UnknownAsset,
    AlreadyLoaded,
    NoActiveAsset,
    InvalidOffset,
    InvalidChunk,
    Incomplete,
    Allocation,
    Encoding,
    Asset(AssetError),
}
impl fmt::Display for AssetInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Asset input failed ({self:?})")
    }
}
impl std::error::Error for AssetInputError {}
struct PendingAsset {
    id: AssetId,
    length: usize,
    bytes: Vec<u8>,
}

/// Staged canonical graph and its exact declared assets. Only one payload is
/// active at once. Imported bytes are copied once into owned storage, then moved
/// into the immutable repository after digest validation. No live graph exists
/// until the host consumes the complete bundle to create/replace its authority.
pub struct ProjectBundleInput {
    project: ValidatedProject,
    assets: AssetRepository,
    lengths: std::collections::BTreeMap<AssetId, usize>,
    active: Option<PendingAsset>,
}
impl ProjectBundleInput {
    /// Reuse an admitted, immutable graph after persisted-format migration.
    /// Asset count/length/aggregate budgets precede all payload allocation.
    pub fn from_admitted(
        project: ValidatedProject,
        limits: ProjectInputLimits,
    ) -> Result<Self, AssetBudgetError> {
        if project.state().source_assets.len() > limits.max_assets {
            return Err(AssetBudgetError);
        }
        let mut total = 0usize;
        let mut lengths = std::collections::BTreeMap::new();
        for descriptor in project.state().source_assets.iter() {
            let n = descriptor.byte_length.get();
            // Check exact conversion on both 32-bit WASM and 64-bit native hosts.
            if n < 0.0
                || n.fract() != 0.0
                || n > 9_007_199_254_740_991.0
                || n > limits.max_asset_bytes as f64
                || n as usize as f64 != n
            {
                return Err(AssetBudgetError);
            }
            let length = n as usize;
            total = total
                .checked_add(length)
                .filter(|&v| v <= limits.max_total_asset_bytes)
                .ok_or(AssetBudgetError)?;
            lengths.insert(descriptor.id.clone(), length);
        }
        Ok(ProjectBundleInput {
            project,
            assets: AssetRepository::new(),
            lengths,
            active: None,
        })
    }
    pub fn project(&self) -> &ValidatedProject {
        &self.project
    }
    pub fn loaded_assets(&self) -> usize {
        self.assets.len()
    }
    pub fn begin_asset(&mut self, id: &AssetId) -> Result<usize, AssetInputError> {
        if self.active.is_some() {
            return Err(AssetInputError::Busy);
        }
        let length = *self.lengths.get(id).ok_or(AssetInputError::UnknownAsset)?;
        if self.assets.has(id) {
            return Err(AssetInputError::AlreadyLoaded);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| AssetInputError::Allocation)?;
        self.active = Some(PendingAsset {
            id: id.clone(),
            length,
            bytes,
        });
        Ok(length)
    }
    pub fn append_asset(&mut self, offset: usize, bytes: &[u8]) -> Result<(), AssetInputError> {
        let active = self.active.as_mut().ok_or(AssetInputError::NoActiveAsset)?;
        if offset != active.bytes.len() {
            return Err(AssetInputError::InvalidOffset);
        }
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES || bytes.len() > active.length - offset
        {
            return Err(AssetInputError::InvalidChunk);
        }
        active.bytes.extend_from_slice(bytes);
        Ok(())
    }
    pub fn cancel_asset(&mut self) {
        self.active = None;
    }
    /// A digest/encoding failure discards this payload; earlier admitted assets
    /// remain staged and the host may retry. Incomplete transfer remains active.
    pub fn finish_asset(&mut self) -> Result<(), AssetInputError> {
        let active = self.active.as_ref().ok_or(AssetInputError::NoActiveAsset)?;
        if active.bytes.len() != active.length {
            return Err(AssetInputError::Incomplete);
        }
        let active = self.active.take().expect("active transfer checked");
        let descriptor = self
            .project
            .state()
            .source_assets
            .iter()
            .find(|d| d.id == active.id)
            .expect("admitted immutable membership")
            .to_value()
            .map_err(|_| AssetInputError::Encoding)?;
        self.assets
            .put_owned(AssetPayload {
                descriptor,
                bytes: active.bytes,
            })
            .map_err(AssetInputError::Asset)?;
        Ok(())
    }
    pub fn finish(self) -> Result<(ValidatedProject, AssetRepository), AssetInputError> {
        if self.active.is_some() || self.assets.len() != self.lengths.len() {
            return Err(AssetInputError::Incomplete);
        }
        Ok((self.project, self.assets))
    }
}
