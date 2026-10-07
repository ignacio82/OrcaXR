//! Immutable data ownership and graph queries, without session authority.
use super::*;

struct Stored {
    state: ProjectState,
    fingerprint: String,
}
/// An immutable typed candidate with a cached canonical identity. It proves no
/// semantic validity: a native session must separately validate references,
/// topology, timestamps/settings and history/command policy before committing.
#[derive(Clone)]
pub struct ProjectData(Arc<Stored>);
impl std::fmt::Debug for ProjectData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectData")
            .field("plates", &self.0.state.plates.len())
            .finish_non_exhaustive()
    }
}
impl ProjectData {
    pub fn new(state: ProjectState) -> io::Result<Self> {
        let fingerprint = project_fingerprint(&state)?;
        Ok(Self(Arc::new(Stored { state, fingerprint })))
    }
    pub fn state(&self) -> &ProjectState {
        &self.0.state
    }
    pub fn fingerprint(&self) -> &str {
        &self.0.fingerprint
    }
    /// Clone the small root record; child nodes and large JSON payloads remain
    /// shared. Arc::make_mut copies only a path an edit actually touches.
    pub fn to_candidate(&self) -> ProjectState {
        self.0.state.clone()
    }
    pub fn same_allocation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    /// Full canonical content equality, including unknown fields. A matching
    /// FNV hash alone is not proof of equality. Typed finite-number equality
    /// preserves canonical +/-0 semantics without allocating serialized graphs.
    pub fn same_content(&self, other: &Self) -> bool {
        self.same_allocation(other) || self.0.state == other.0.state
    }
}
/// Exact browser semantic identity, over every canonical field including
/// timestamps, unknown metadata and array order. No intermediate JSON is built.
pub fn project_fingerprint(state: &ProjectState) -> io::Result<String> {
    struct Fnv(u64);
    impl Write for Fnv {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            for byte in bytes {
                self.0 ^= u64::from(*byte);
                self.0 = self.0.wrapping_mul(0x100000001b3);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut hash = Fnv(0xcbf29ce484222325);
    state.write_json(&mut hash)?;
    Ok(format!("fnv1a64:{:016x}", hash.0))
}

pub fn find_plate<'a>(state: &'a ProjectState, id: &PlateId) -> Option<&'a ProjectPlate> {
    state.plates.iter().find(|v| &v.id == id).map(AsRef::as_ref)
}
pub fn find_object<'a>(
    state: &'a ProjectState,
    id: &ObjectId,
) -> Option<(&'a ProjectPlate, &'a ProjectObject)> {
    for plate in state.plates.iter() {
        if let Some(object) = plate.objects.iter().find(|v| &v.id == id) {
            return Some((plate, object));
        }
    }
    None
}
pub fn find_volume<'a>(
    state: &'a ProjectState,
    id: &VolumeId,
) -> Option<(&'a ProjectPlate, &'a ProjectObject, &'a ProjectVolume)> {
    for plate in state.plates.iter() {
        for object in plate.objects.iter() {
            if let Some(volume) = object.volumes.iter().find(|v| &v.id == id) {
                return Some((plate, object, volume));
            }
        }
    }
    None
}
pub fn find_instance<'a>(
    state: &'a ProjectState,
    id: &InstanceId,
) -> Option<(&'a ProjectPlate, &'a ProjectObject, &'a ProjectInstance)> {
    for plate in state.plates.iter() {
        for object in plate.objects.iter() {
            if let Some(instance) = object.instances.iter().find(|v| &v.id == id) {
                return Some((plate, object, instance));
            }
        }
    }
    None
}
pub fn find_layer_range<'a>(
    state: &'a ProjectState,
    id: &LayerRangeId,
) -> Option<(&'a ProjectPlate, &'a ProjectObject, &'a LayerRange)> {
    for plate in state.plates.iter() {
        for object in plate.objects.iter() {
            if let Some(range) = object.layer_ranges.iter().find(|v| &v.id == id) {
                return Some((plate, object, range));
            }
        }
    }
    None
}
pub fn all_project_objects(state: &ProjectState) -> impl Iterator<Item = &ProjectObject> {
    state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter().map(AsRef::as_ref))
}
pub fn is_topology_current(state: &ProjectState, volume: &VolumeId, revision: Number) -> bool {
    find_volume(state, volume).is_some_and(|(_, _, v)| v.source.topology_revision == revision)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilamentSource {
    None,
    Object,
    Volume,
    LayerRange,
}
#[derive(Debug, PartialEq, Eq)]
pub struct ResolvedFilament<'a> {
    pub effective: Option<&'a FilamentId>,
    pub local: Option<&'a FilamentId>,
    pub inherited: Option<&'a FilamentId>,
    pub source: FilamentSource,
}
pub enum FilamentChild<'a> {
    Volume(&'a ProjectVolume),
    LayerRange(&'a LayerRange),
}
pub fn resolve_filament<'a>(
    object: &'a ProjectObject,
    child: Option<FilamentChild<'a>>,
) -> ResolvedFilament<'a> {
    let (local, source) = match child {
        Some(FilamentChild::Volume(v)) => (v.filament_id.as_ref(), FilamentSource::Volume),
        Some(FilamentChild::LayerRange(v)) => (v.filament_id.as_ref(), FilamentSource::LayerRange),
        None => (None, FilamentSource::None),
    };
    let inherited = object.filament_id.as_ref();
    if let Some(value) = local {
        ResolvedFilament {
            effective: Some(value),
            local: Some(value),
            inherited,
            source,
        }
    } else if let Some(value) = inherited {
        ResolvedFilament {
            effective: Some(value),
            local: None,
            inherited,
            source: FilamentSource::Object,
        }
    } else {
        ResolvedFilament {
            effective: None,
            local: None,
            inherited: None,
            source: FilamentSource::None,
        }
    }
}
