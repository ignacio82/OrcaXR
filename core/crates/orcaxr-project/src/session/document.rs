//! Prepared whole-document replacement. Parsing, graph admission, asset digest
//! checks and bundle fingerprinting belong to the owned preparation task.
use super::*;
use std::sync::Weak;

/// A complete admitted bundle with no mutable public access. Consuming it moves
/// the existing immutable graph and payload records into the destination owner.
pub struct PreparedDocument {
    project: ValidatedProject,
    assets: AssetRepository,
}
impl PreparedDocument {
    pub fn new(project: ValidatedProject, assets: AssetRepository) -> Result<Self, BundleError> {
        check_bundle(&project, &assets)?;
        // Force the cached fingerprint before the authority's commit boundary.
        assets.bundle_fingerprint();
        Ok(Self { project, assets })
    }
}

/// Host-local operation identity. Dropping every ticket invalidates the pending
/// open; the session retains only a weak token, not the old graph or input task.
#[derive(Clone)]
pub struct DocumentOpen {
    guard: LocalGuard,
    operation: Arc<()>,
}
impl<P: TimestampPolicy> ProjectSession<P> {
    pub fn begin_open(&mut self) -> Result<DocumentOpen, wire::SessionError> {
        let guard = self.capture_guard()?;
        let operation = Arc::new(());
        self.open_operation = Arc::downgrade(&operation);
        Ok(DocumentOpen { guard, operation })
    }
    fn owns_open(&self, ticket: &DocumentOpen) -> bool {
        Arc::ptr_eq(&self.owner, &ticket.guard.owner)
            && Weak::ptr_eq(&self.open_operation, &Arc::downgrade(&ticket.operation))
    }
    pub fn is_open_current(&self, ticket: &DocumentOpen) -> bool {
        self.owns_open(ticket) && self.is_export_current(&ticket.guard)
    }
    /// A failed/cancelled newer open never revives the previous operation.
    pub fn cancel_open(&mut self, ticket: &DocumentOpen) -> bool {
        if !self.owns_open(ticket) {
            return false;
        }
        self.open_operation = Weak::new();
        true
    }
    /// Consumes prepared input on every outcome. The host must dispatch every
    /// returned effect before reporting success; this is not an undoable edit.
    pub fn finish_open(
        &mut self,
        ticket: &DocumentOpen,
        document: PreparedDocument,
    ) -> Result<Vec<DomainEvent>, wire::SessionError> {
        let current = self.is_open_current(ticket);
        self.cancel_open(ticket);
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !current {
            return Err(wire::SessionError::Stale);
        }
        self.adopt_document(document, "open-project")
    }
    /// Capture this guard before asynchronous preparation/dirty confirmation.
    /// A failed replacement leaves any in-flight Open operation unchanged.
    pub fn reset_document(
        &mut self,
        guard: &LocalGuard,
        document: PreparedDocument,
    ) -> Result<Vec<DomainEvent>, wire::SessionError> {
        if self.disposed {
            return Err(wire::SessionError::Disposed);
        }
        if !self.is_export_current(guard) {
            return Err(wire::SessionError::Stale);
        }
        let events = self.adopt_document(document, "reset-project")?;
        self.open_operation = Weak::new();
        Ok(events)
    }
    fn adopt_document(
        &mut self,
        document: PreparedDocument,
        reason: &str,
    ) -> Result<Vec<DomainEvent>, wire::SessionError> {
        let events = self
            .bus
            .adopt_document(document.project, document.assets, Text::from_utf8(reason))
            .map_err(|_| wire::SessionError::ResourceLimit)?;
        // Preserve the bounded queue's settlement behavior. Old mutations are
        // stale at run_next; their guards cannot target the replacement graph.
        // Ready/queued work remains charged until release or settlement, matching
        // the browser endpoint; no staged IDs are reused or silently retargeted.
        Ok(events)
    }
}
