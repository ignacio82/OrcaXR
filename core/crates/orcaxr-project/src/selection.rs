//! Stable selection ownership, independent of renderer and project history.
//! Changes are immutable post-commit receipts for the session's dispatch path.
use crate::{ids::*, model::*};
use std::{collections::BTreeSet, fmt, sync::Arc};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SelectionRef {
    Project,
    Plate(PlateId),
    Object(ObjectId),
    Volume(VolumeId),
    Instance(InstanceId),
    LayerRange(LayerRangeId),
    Filament(FilamentId),
}
impl SelectionRef {
    /// The browser's `SelectionRef.kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Plate(_) => "plate",
            Self::Object(_) => "object",
            Self::Volume(_) => "volume",
            Self::Instance(_) => "instance",
            Self::LayerRange(_) => "layer-range",
            Self::Filament(_) => "filament",
        }
    }
    /// The referenced entity ID; the project has none.
    pub fn id(&self) -> Option<&[u16]> {
        match self {
            Self::Project => None,
            Self::Plate(id) => Some(id.as_utf16()),
            Self::Object(id) => Some(id.as_utf16()),
            Self::Volume(id) => Some(id.as_utf16()),
            Self::Instance(id) => Some(id.as_utf16()),
            Self::LayerRange(id) => Some(id.as_utf16()),
            Self::Filament(id) => Some(id.as_utf16()),
        }
    }
    pub fn exists(&self, state: &ProjectState) -> bool {
        match self {
            Self::Project => true,
            Self::Plate(id) => find_plate(state, id).is_some(),
            Self::Object(id) => find_object(state, id).is_some(),
            Self::Volume(id) => find_volume(state, id).is_some(),
            Self::Instance(id) => find_instance(state, id).is_some(),
            Self::LayerRange(id) => find_layer_range(state, id).is_some(),
            Self::Filament(id) => {
                state
                    .filaments
                    .physical
                    .iter()
                    .any(|f| f.id.as_utf16() == id.as_utf16())
                    || state
                        .filaments
                        .mixed
                        .iter()
                        .any(|f| f.id.as_utf16() == id.as_utf16())
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionSnapshot {
    refs: Arc<[SelectionRef]>,
    primary: Option<SelectionRef>,
}
impl SelectionSnapshot {
    pub fn refs(&self) -> &[SelectionRef] {
        &self.refs
    }
    pub fn primary(&self) -> Option<&SelectionRef> {
        self.primary.as_ref()
    }
}
#[must_use = "the session must consume the selection change before acknowledging the operation"]
#[derive(Debug, Clone)]
pub struct SelectionChange {
    previous: SelectionSnapshot,
    current: SelectionSnapshot,
}
impl SelectionChange {
    pub fn previous(&self) -> &SelectionSnapshot {
        &self.previous
    }
    pub fn current(&self) -> &SelectionSnapshot {
        &self.current
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidPrimary;
impl fmt::Display for InvalidPrimary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Primary selection must be part of the selection set")
    }
}
impl std::error::Error for InvalidPrimary {}

#[derive(Debug, Default)]
pub struct SelectionStore {
    current: SelectionSnapshot,
}
impl SelectionStore {
    pub fn snapshot(&self) -> SelectionSnapshot {
        self.current.clone()
    }
    pub fn set(
        &mut self,
        refs: &[SelectionRef],
        primary: Option<SelectionRef>,
    ) -> Result<Option<SelectionChange>, InvalidPrimary> {
        let refs = unique(refs);
        let primary = primary.or_else(|| refs.last().cloned());
        if primary.as_ref().is_some_and(|p| !refs.contains(p)) {
            return Err(InvalidPrimary);
        }
        Ok(self.commit(SelectionSnapshot {
            refs: refs.into(),
            primary,
        }))
    }
    pub fn add(&mut self, item: SelectionRef, make_primary: bool) -> Option<SelectionChange> {
        let mut refs = self.current.refs.to_vec();
        if !refs.contains(&item) {
            refs.push(item.clone());
        }
        let primary = if make_primary {
            Some(item)
        } else {
            self.current.primary.clone()
        };
        self.commit(SelectionSnapshot {
            refs: refs.into(),
            primary,
        })
    }
    pub fn toggle(&mut self, item: SelectionRef) -> Option<SelectionChange> {
        if !self.current.refs.contains(&item) {
            return self.add(item, true);
        }
        let refs = self
            .current
            .refs
            .iter()
            .filter(|r| **r != item)
            .cloned()
            .collect::<Vec<_>>();
        let primary = if self.current.primary.as_ref().is_some_and(|p| *p != item) {
            self.current.primary.clone()
        } else {
            refs.last().cloned()
        };
        self.commit(SelectionSnapshot {
            refs: refs.into(),
            primary,
        })
    }
    pub fn clear(&mut self) -> Option<SelectionChange> {
        self.commit(SelectionSnapshot::default())
    }
    /// Browser restore calls set: an absent primary selects the last item, even
    /// for a snapshot produced by add(makePrimary=false) on an empty selection.
    pub fn restore(&mut self, snapshot: &SelectionSnapshot) -> Option<SelectionChange> {
        self.set(snapshot.refs(), snapshot.primary.clone())
            .expect("opaque snapshot primary is a member")
    }
    pub fn prune(&mut self, state: &ProjectState) -> Option<SelectionChange> {
        let refs = self
            .current
            .refs
            .iter()
            .filter(|r| r.exists(state))
            .cloned()
            .collect::<Vec<_>>();
        let primary = self
            .current
            .primary
            .as_ref()
            .filter(|p| refs.contains(p))
            .cloned()
            .or_else(|| refs.last().cloned());
        self.commit(SelectionSnapshot {
            refs: refs.into(),
            primary,
        })
    }
    fn commit(&mut self, next: SelectionSnapshot) -> Option<SelectionChange> {
        if next == self.current {
            return None;
        }
        let previous = std::mem::replace(&mut self.current, next);
        Some(SelectionChange {
            previous,
            current: self.current.clone(),
        })
    }
}
fn unique(refs: &[SelectionRef]) -> Vec<SelectionRef> {
    let mut seen = BTreeSet::new();
    refs.iter().filter(|r| seen.insert(*r)).cloned().collect()
}
