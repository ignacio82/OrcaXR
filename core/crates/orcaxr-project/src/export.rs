//! Frozen project and asset ownership for background export. Capturing or reading
//! this bundle never changes dirty state; only successful host handoff followed
//! by acknowledgement of the original local guard can establish a checkpoint.
use crate::{
    assets::{AssetLease, AssetSnapshot},
    session::{LocalGuard, ProjectSession},
    slicing::report::{Report, RequestError},
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
    /// Live slice preflight of exactly this frozen project and its assets.
    /// Synchronous; run it on the export worker with a cancellation check.
    pub fn preflight(
        &self,
        request: &PreflightRequest,
        cancelled: impl FnMut() -> bool,
    ) -> Result<Report, RequestError> {
        Report::run(self.project.project(), &self.assets, request, cancelled)
    }
}
