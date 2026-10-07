//! Single-owner canonical state publication. A commit returns an immutable change
//! for the session to project/dispatch after publication, with no host callback,
//! retained event queue, asset ownership or history policy inside the store.
use crate::{
    model::{ProjectData, ProjectState, Text},
    validation::{AdmissionError, TimestampPolicy, ValidatedProject},
};
pub use orcaxr_contracts::project_intent_types::{Counter, DirtyCategory};
use std::{fmt, sync::Arc};

/// Session protocol counters must remain exactly representable by JavaScript.
/// This is a runtime lifetime limit, not a persisted project numeric limit.
pub const MAX_REVISION: Counter = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRevisionGuard {
    pub revision: Counter,
    pub hash: Text,
}

#[derive(Debug, Clone)]
pub struct ProjectSnapshot {
    project: ValidatedProject,
    revision: Counter,
}
impl ProjectSnapshot {
    pub fn project(&self) -> &ValidatedProject {
        &self.project
    }
    pub fn state(&self) -> &ProjectState {
        self.project.state()
    }
    pub fn revision(&self) -> Counter {
        self.revision
    }
    pub fn hash(&self) -> &str {
        self.project.fingerprint()
    }
    pub fn guard(&self) -> ProjectRevisionGuard {
        ProjectRevisionGuard {
            revision: self.revision,
            hash: Text::from_utf8(self.hash()),
        }
    }
}

/// Owned metadata is immutable once captured in a receipt. Duplicate categories
/// and their order are preserved here; history owns dirty-token deduplication.
#[derive(Debug, Clone, Default)]
pub struct ReplaceOptions {
    pub reason: Option<Text>,
    pub dirty_categories: Option<Arc<[DirtyCategory]>>,
}

#[must_use = "the session must consume the committed change before acknowledging the operation"]
#[derive(Debug, Clone)]
pub struct ProjectChange {
    previous: ProjectSnapshot,
    current: ProjectSnapshot,
    reason: Text,
    dirty_categories: Arc<[DirtyCategory]>,
}
impl ProjectChange {
    pub fn previous(&self) -> &ProjectSnapshot {
        &self.previous
    }
    pub fn current(&self) -> &ProjectSnapshot {
        &self.current
    }
    pub fn reason(&self) -> &Text {
        &self.reason
    }
    pub fn dirty_categories(&self) -> &[DirtyCategory] {
        &self.dirty_categories
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevisionExhausted;
impl fmt::Display for RevisionExhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Project revision capacity exhausted")
    }
}
impl std::error::Error for RevisionExhausted {}

pub enum ReplaceError<E> {
    Admission(AdmissionError<E>),
    RevisionExhausted,
}
impl<E> fmt::Debug for ReplaceError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admission(error) => fmt::Debug::fmt(error, f),
            Self::RevisionExhausted => fmt::Debug::fmt(&RevisionExhausted, f),
        }
    }
}
impl<E> fmt::Display for ReplaceError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admission(error) => fmt::Display::fmt(error, f),
            Self::RevisionExhausted => fmt::Display::fmt(&RevisionExhausted, f),
        }
    }
}
impl<E> std::error::Error for ReplaceError<E> {}

/// Mutations require exclusive ownership. Low-level guards compare revision and
/// hash only, as in the browser; session generation/owner/asset/history guards
/// must be checked by the command gateway before using this store.
#[derive(Debug)]
pub struct ProjectStore {
    current: ProjectSnapshot,
}
impl ProjectStore {
    pub fn new(project: ValidatedProject) -> Self {
        Self {
            current: ProjectSnapshot {
                project,
                revision: 0,
            },
        }
    }
    pub fn admit<P: TimestampPolicy>(
        candidate: ProjectData,
        timestamps: &mut P,
    ) -> Result<Self, AdmissionError<P::Error>> {
        ValidatedProject::new(candidate, timestamps).map(Self::new)
    }
    /// Opaque immutable graph/proof ownership is shared, never publicly cloned
    /// into a mutable graph or rehashed on snapshot reads.
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.current.clone()
    }
    pub fn is_current(&self, guard: &ProjectRevisionGuard) -> bool {
        guard.revision == self.current.revision
            && guard
                .hash
                .units()
                .iter()
                .copied()
                .eq(self.current.hash().encode_utf16())
    }
    pub fn has_same_content(&self, candidate: &ProjectData) -> bool {
        self.current.project.data().same_content(candidate)
    }
    /// The future transaction owner must preflight enough capacity for all its
    /// publications AND rollback before its first mutation. This does not reserve
    /// a separate clock or allow another owner to mutate concurrently.
    pub fn ensure_revision_capacity(&self, publications: Counter) -> Result<(), RevisionExhausted> {
        if publications > MAX_REVISION - self.current.revision {
            Err(RevisionExhausted)
        } else {
            Ok(())
        }
    }
    pub fn replace<P: TimestampPolicy>(
        &mut self,
        candidate: ProjectData,
        options: ReplaceOptions,
        timestamps: &mut P,
    ) -> Result<ProjectChange, ReplaceError<P::Error>> {
        let project =
            ValidatedProject::new(candidate, timestamps).map_err(ReplaceError::Admission)?;
        self.replace_validated(project, options)
            .map_err(|_| ReplaceError::RevisionExhausted)
    }
    /// Even an equal candidate or the exact current allocation gets a new
    /// revision. Command-specific no-op policy belongs above this boundary.
    pub fn replace_validated(
        &mut self,
        project: ValidatedProject,
        options: ReplaceOptions,
    ) -> Result<ProjectChange, RevisionExhausted> {
        self.ensure_revision_capacity(1)?;
        let change = ProjectChange {
            previous: self.current.clone(),
            current: ProjectSnapshot {
                project,
                revision: self.current.revision + 1,
            },
            reason: options
                .reason
                .unwrap_or_else(|| Text::from_utf8("replace-state")),
            dirty_categories: options
                .dirty_categories
                .unwrap_or_else(|| vec![DirtyCategory::ProjectData].into()),
        };
        self.current = change.current.clone();
        Ok(change)
    }
    /// Restore content/proof, never an old revision; rollback emits an empty
    /// category list and leaves dirty-token restoration to history.
    pub fn restore(
        &mut self,
        project: ValidatedProject,
        reason: Option<Text>,
    ) -> Result<ProjectChange, RevisionExhausted> {
        self.replace_validated(
            project,
            ReplaceOptions {
                reason: Some(reason.unwrap_or_else(|| Text::from_utf8("atomic-rollback"))),
                dirty_categories: Some(Arc::from([])),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_counter_exhaustion_never_reuses_a_revision_or_publishes() {
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/project-intents.json"))
                .unwrap();
        assert_eq!(
            schema["definitions"]["Counter"]["max"].as_u64(),
            Some(MAX_REVISION)
        );
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../testdata/cross-platform/project-validation-vectors.json"
        ))
        .unwrap();
        let case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "base")
            .unwrap();
        use crate::model::Decode;
        let state = ProjectState::from_value(
            orcaxr_contracts::canonical::parse(case["stateJson"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let mut policy = |_: &[u16]| Ok::<_, ()>(true);
        let mut store = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
        store.current.revision = MAX_REVISION - 1;
        let saved = store.snapshot();
        assert!(store.ensure_revision_capacity(2).is_err());
        assert!(store.ensure_revision_capacity(u64::MAX).is_err());
        let change = store.restore(saved.project.clone(), None).unwrap();
        assert_eq!(change.current().revision(), MAX_REVISION);
        let guard = store.snapshot().guard();
        assert!(
            store
                .replace_validated(saved.project.clone(), ReplaceOptions::default())
                .is_err()
        );
        assert!(store.restore(saved.project, None).is_err());
        assert!(store.is_current(&guard));
        assert!(store.ensure_revision_capacity(0).is_ok());
    }
}
