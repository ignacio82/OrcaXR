//! Frozen project and asset ownership for background export. Capturing or reading
//! this bundle never changes dirty state; only successful host handoff followed
//! by acknowledgement of the original local guard can establish a checkpoint.
use crate::{
    assets::{AssetLease, AssetSnapshot},
    ids::PlateId,
    session::{LocalGuard, ProjectSession},
    slicing::{
        plate::{ProjectionError, project_plate},
        report::{Report, RequestError},
    },
    store::ProjectSnapshot,
    validation::TimestampPolicy,
};
use orcaxr_contracts::project_intent_types::PreflightRequest;

/// Cloning shares the same frozen project and asset records.
#[derive(Clone)]
pub struct ExportCapture {
    project: ProjectSnapshot,
    assets: AssetSnapshot,
}
impl ExportCapture {
    pub fn new<P: TimestampPolicy>(
        session: &ProjectSession<P>,
        guard: &LocalGuard,
    ) -> Option<Self> {
        session.is_export_current(guard).then(|| Self {
            project: session.snapshot(),
            assets: session.assets().capture_internal(),
        })
    }
    pub fn project(&self) -> &ProjectSnapshot {
        &self.project
    }
    pub fn asset_count(&self) -> usize {
        self.project.state().source_assets.len()
    }
    /// Declaration order, matching the captured canonical document. No lookup
    /// ever consults the live repository after this capture has been created.
    pub fn asset(&self, index: usize) -> Option<AssetLease> {
        let id = &self.project.state().source_assets.get(index)?.id;
        self.assets.peek(id)
    }
    /// The frozen payload of asset `id`, when this capture holds it.
    pub fn asset_by_id(&self, id: &crate::ids::AssetId) -> Option<AssetLease> {
        self.assets.peek(id)
    }
    /// Live slice preflight of exactly this frozen project and its assets.
    /// Synchronous; run it on the export worker with a cancellation check.
    pub fn preflight(
        &self,
        request: &PreflightRequest,
        cancelled: impl FnMut() -> bool,
    ) -> Result<Report, RequestError> {
        Report::run(self.project.project(), &self.assets, request, cancelled)
    }
    /// The one-plate slice capture of `plate_id`
    /// ([`project_plate`](crate::slicing::plate::project_plate)): the
    /// projected project under this capture's revision, reading only the
    /// frozen assets it keeps, so the archive writer packages it as it does
    /// any capture. Its project hash is the projection's own fingerprint (the
    /// archive's `sourceHash`); this capture's guard stays the caller's proof
    /// of the live project it came from. The projection is admitted under
    /// `timestamps`, as the browser re-validates it.
    pub fn plate<P: TimestampPolicy>(
        &self,
        plate_id: &PlateId,
        timestamps: &mut P,
    ) -> Result<Self, ProjectionError<P::Error>> {
        let projection = project_plate(
            self.project.state(),
            plate_id,
            |id| self.assets.peek(id).is_some(),
            timestamps,
        )?;
        Ok(Self {
            project: ProjectSnapshot::derived(projection.project, self.project.revision()),
            assets: self.assets.clone(),
        })
    }
}
