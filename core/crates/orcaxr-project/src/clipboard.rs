//! Immutable local clipboard data. Only the selected object and its known byte
//! dependencies survive capture; no complete project/repository version is kept.
use crate::{
    assets::{AssetError, AssetRepository, AssetSelection, AssetSnapshot},
    ids::*,
    model::*,
    session::{LocalGuard, ProjectSession},
    staging_layout as layout,
    validation::TimestampPolicy,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardError {
    MissingObject,
    MissingDeclaration,
    MetadataMismatch,
    Asset(AssetError),
}

#[derive(Clone)]
pub struct ClipboardData {
    pub(crate) object: Arc<ProjectObject>,
    pub(crate) assets: AssetSelection,
    pub(crate) descriptors: Arc<[Arc<SourceAssetDescriptor>]>,
}
impl ClipboardData {
    pub fn capture(
        state: &ProjectState,
        assets: &AssetRepository,
        id: &ObjectId,
        max_assets: usize,
        max_bytes: u64,
    ) -> Result<Self, ClipboardError> {
        let object = state
            .plates
            .iter()
            .flat_map(|p| p.objects.iter())
            .find(|o| &o.id == id)
            .cloned()
            .ok_or(ClipboardError::MissingObject)?;
        Self::capture_object(
            state,
            &assets.capture_internal(),
            &object,
            max_assets,
            max_bytes,
        )
    }
    fn capture_object(
        state: &ProjectState,
        assets: &AssetSnapshot,
        object: &Arc<ProjectObject>,
        max_assets: usize,
        max_bytes: u64,
    ) -> Result<Self, ClipboardError> {
        let ids = object_asset_ids(object, max_assets).map_err(ClipboardError::Asset)?;
        let selected = assets
            .capture_selection(&ids, max_assets, max_bytes)
            .map_err(ClipboardError::Asset)?;
        let wanted = ids.iter().collect::<BTreeSet<_>>();
        let mut declared = BTreeMap::new();
        for descriptor in state.source_assets.iter() {
            if wanted.contains(&descriptor.id) {
                declared.entry(&descriptor.id).or_insert(descriptor);
            }
        }
        let mut descriptors = Vec::with_capacity(ids.len());
        for lease in selected.leases() {
            let descriptor = declared
                .get(lease.id())
                .ok_or(ClipboardError::MissingDeclaration)?;
            if !descriptor
                .matches_value(lease.descriptor())
                .map_err(|_| ClipboardError::MetadataMismatch)?
            {
                return Err(ClipboardError::MetadataMismatch);
            }
            descriptors.push(Arc::clone(descriptor));
        }
        Ok(Self {
            object: object.clone(),
            assets: selected,
            descriptors: descriptors.into(),
        })
    }
    pub fn object(&self) -> &Arc<ProjectObject> {
        &self.object
    }
    pub fn assets(&self) -> &AssetSelection {
        &self.assets
    }
    pub fn descriptors(&self) -> &[Arc<SourceAssetDescriptor>] {
        &self.descriptors
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardHostError {
    Stale,
    InvalidOptions,
    InvalidIndex,
    InvalidTarget,
    Limit,
    Capture(ClipboardError),
}
impl ClipboardHostError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Stale => "stale",
            Self::InvalidOptions => "invalid_options",
            Self::InvalidIndex => "invalid_index",
            Self::InvalidTarget => "invalid_clipboard_target",
            Self::Limit | Self::Capture(ClipboardError::Asset(AssetError::SelectionLimit)) => {
                "resource_limit"
            }
            Self::Capture(_) => "invalid_clipboard",
        }
    }
}
static CLIPBOARDS: AtomicUsize = AtomicUsize::new(0);
struct ClipboardPermit;
impl ClipboardPermit {
    fn new() -> Result<Self, ClipboardHostError> {
        CLIPBOARDS
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < layout::MAX_CLIPBOARDS).then_some(n + 1)
            })
            .map_err(|_| ClipboardHostError::Limit)?;
        Ok(Self)
    }
}
impl Drop for ClipboardPermit {
    fn drop(&mut self) {
        CLIPBOARDS.fetch_sub(1, Ordering::Relaxed);
    }
}
/// Bounded host owner, separate from immutable command/history retention. Freeing
/// the host handle releases its permit; accepted work keeps its own data/charge.
/// The guarded positions are capture addresses, never canonical command IDs.
pub struct ClipboardCapture {
    data: Arc<ClipboardData>,
    // Last: release captured data before returning this owner slot.
    _permit: ClipboardPermit,
}
/// A guarded, constant-size capture of immutable source ownership. Object/asset
/// traversal is deferred to capture(), without a live session or repository lock.
/// Its permit is shared with finished clipboard owners and survives conversion.
/// Hosts must recheck their original source guard before publishing the result.
pub struct ClipboardPreparation {
    source: crate::store::ProjectSnapshot,
    assets: AssetSnapshot,
    limits: layout::ClipboardOptions,
    permit: ClipboardPermit,
}
impl ClipboardPreparation {
    pub fn new<P: TimestampPolicy>(
        session: &ProjectSession<P>,
        guard: &LocalGuard,
        limits: layout::ClipboardOptions,
    ) -> Result<Self, ClipboardHostError> {
        if limits.assets > crate::host_layout::MAX_BUDGET
            || limits.bytes > crate::host_layout::MAX_BUDGET
        {
            return Err(ClipboardHostError::InvalidOptions);
        }
        if !session.is_current(guard) {
            return Err(ClipboardHostError::Stale);
        }
        Ok(Self {
            source: session.snapshot(),
            assets: session.assets().capture_internal(),
            limits,
            permit: ClipboardPermit::new()?,
        })
    }
    pub fn capture(
        self,
        node: &crate::query::QueryNode,
    ) -> Result<ClipboardCapture, ClipboardHostError> {
        let source = node.snapshot();
        if source.revision() != self.source.revision()
            || !source.project().same_allocation(self.source.project())
        {
            return Err(ClipboardHostError::Stale);
        }
        let (plate, object) = node
            .object_address()
            .ok_or(ClipboardHostError::InvalidTarget)?;
        self.capture_address(plate, object)
    }
    fn capture_address(
        self,
        plate: usize,
        object: usize,
    ) -> Result<ClipboardCapture, ClipboardHostError> {
        let state = self.source.state();
        let object = state
            .plates
            .get(plate)
            .and_then(|p| p.objects.get(object))
            .ok_or(ClipboardHostError::InvalidIndex)?;
        let data = Arc::new(
            ClipboardData::capture_object(
                state,
                &self.assets,
                object,
                self.limits.assets,
                self.limits.bytes as u64,
            )
            .map_err(ClipboardHostError::Capture)?,
        );
        Ok(ClipboardCapture {
            data,
            _permit: self.permit,
        })
    }
}
impl ClipboardCapture {
    /// Query rows may be sorted. Resolve the captured node's private address,
    /// and require its exact admitted graph/revision plus the current guard.
    pub fn from_query<P: TimestampPolicy>(
        session: &ProjectSession<P>,
        guard: &LocalGuard,
        node: &crate::query::QueryNode,
        limits: layout::ClipboardOptions,
    ) -> Result<Self, ClipboardHostError> {
        ClipboardPreparation::new(session, guard, limits)?.capture(node)
    }
    pub fn new<P: TimestampPolicy>(
        session: &ProjectSession<P>,
        guard: &LocalGuard,
        plate: usize,
        object: usize,
        limits: layout::ClipboardOptions,
    ) -> Result<Self, ClipboardHostError> {
        ClipboardPreparation::new(session, guard, limits)?.capture_address(plate, object)
    }
    pub fn data(&self) -> Arc<ClipboardData> {
        self.data.clone()
    }
    pub fn info(&self) -> [f64; layout::CLIPBOARD_INFO_LENGTH] {
        let mut result = [0.; layout::CLIPBOARD_INFO_LENGTH];
        result[layout::CLIPBOARD_VOLUMES] = self.data.object.volumes.len() as f64;
        result[layout::CLIPBOARD_INSTANCES] = self.data.object.instances.len() as f64;
        result[layout::CLIPBOARD_LAYER_RANGES] = self.data.object.layer_ranges.len() as f64;
        result[layout::CLIPBOARD_ASSETS] = self.data.assets.len() as f64;
        result[layout::CLIPBOARD_BYTES] = self.data.assets.byte_length() as f64;
        result
    }
}
pub(crate) fn object_asset_ids(
    object: &ProjectObject,
    limit: usize,
) -> Result<Vec<AssetId>, AssetError> {
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    for volume in object.volumes.iter() {
        for id in std::iter::once(&volume.source.asset_id)
            .chain(volume.emboss_svg.iter().map(|v| &v.drawing_asset_id))
        {
            if seen.insert(id) {
                if ids.len() == limit {
                    return Err(AssetError::SelectionLimit);
                }
                ids.push(id.clone());
            }
        }
    }
    Ok(ids)
}
pub(crate) fn unreferenced_assets(
    state: &ProjectState,
    candidates: &[AssetId],
) -> BTreeSet<AssetId> {
    let mut unused: BTreeSet<_> = candidates.iter().cloned().collect();
    if unused.is_empty() {
        return unused;
    }
    for volume in state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
    {
        unused.remove(&volume.source.asset_id);
        if let Some(svg) = &volume.emboss_svg {
            unused.remove(&svg.drawing_asset_id);
        }
        if unused.is_empty() {
            return unused;
        }
    }
    for id in state
        .thumbnails
        .iter()
        .map(|v| &v.asset_id)
        .chain(state.extension_blobs.iter().map(|v| &v.asset_id))
    {
        unused.remove(id);
    }
    unused
}
