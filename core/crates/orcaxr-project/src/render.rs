//! The renderer's view of a canonical project and the revisioned deltas a host
//! subscribes to (`renderProjection.ts`). The projection is normalized so one
//! edit changes few records: a plate carries whether it is active, an instance
//! its transform and printable flag, and a volume — once per object — its mesh,
//! role, transform and resolved display colour. Names, paint and settings are
//! other projections; geometry bytes are read from the asset repository.
//!
//! A [`RenderFeed`] answers pages of the change list between two acknowledged
//! snapshots. It retains the snapshots it served, so a host that applied a
//! page's target asks for the next delta from it; a base it no longer holds is
//! answered from empty with no base, which tells the host to rebuild.
use crate::{
    model::{
        FilamentChild, ProjectObject, ProjectState, ProjectVolume, Transform, resolve_filament,
    },
    store::{Counter, ProjectSnapshot},
};
use orcaxr_contracts::project_intent_types as wire;
use std::{collections::HashMap, sync::Arc};

/// The most changes one page may hold.
pub const MAX_PAGE: u64 = 64;
/// Served snapshots a feed keeps as bases and page targets.
pub const RETAINED_SNAPSHOTS: usize = 8;

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A page larger than [`MAX_PAGE`].
    InvalidRequest,
    /// A page target the feed no longer retains; restart from the current one.
    Stale,
    /// The session was disposed.
    Disposed,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Stale => "stale",
            Self::Disposed => "disposed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderPlate {
    pub plate_id: Arc<[u16]>,
    pub order: f64,
    pub printable: bool,
    pub active: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RenderInstance {
    pub instance_id: Arc<[u16]>,
    pub object_id: Arc<[u16]>,
    pub plate_id: Arc<[u16]>,
    pub transform: [[f64; 4]; 3],
    pub printable: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RenderVolume {
    pub volume_id: Arc<[u16]>,
    pub object_id: Arc<[u16]>,
    pub role: crate::model::VolumeRole,
    pub asset_id: Arc<[u16]>,
    pub triangle_count: f64,
    pub transform: [[f64; 4]; 3],
    /// Absent when nothing is assigned: the host keeps its neutral material.
    pub color: Option<Arc<[u16]>>,
}
/// Plates by order; objects, instances and volumes in document order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RenderProjection {
    pub plates: Vec<RenderPlate>,
    pub instances: Vec<RenderInstance>,
    pub volumes: Vec<RenderVolume>,
}
#[derive(Debug, Clone, PartialEq)]
pub enum RenderChange {
    Plate(RenderPlate),
    Instance(RenderInstance),
    Volume(RenderVolume),
    RemovePlate(Arc<[u16]>),
    RemoveInstance(Arc<[u16]>),
    RemoveVolume(Arc<[u16]>),
}

/// The colour of the filament a volume resolves to: a physical tool's own
/// colour, or a mixed recipe's display colour; none when nothing is assigned.
pub fn volume_display_color<'a>(
    state: &'a ProjectState,
    object: &'a ProjectObject,
    volume: &'a ProjectVolume,
) -> Option<&'a [u16]> {
    let id = resolve_filament(object, Some(FilamentChild::Volume(volume))).effective?;
    let id = id.as_utf16();
    if let Some(physical) = state
        .filaments
        .physical
        .iter()
        .find(|f| f.id.as_utf16() == id)
    {
        return Some(physical.color.units());
    }
    state
        .filaments
        .mixed
        .iter()
        .find(|f| f.id.as_utf16() == id)
        .map(|f| f.display_color.units())
}

fn transform(value: &Transform) -> [[f64; 4]; 3] {
    let v3 = |v: &[crate::model::Number; 3]| [v[0].get(), v[1].get(), v[2].get(), 0.0];
    let r = &value.rotation;
    [
        v3(&value.translation_mm),
        [r[0].get(), r[1].get(), r[2].get(), r[3].get()],
        v3(&value.scale),
    ]
}

pub fn project(state: &ProjectState) -> RenderProjection {
    let mut out = RenderProjection::default();
    let mut plates: Vec<_> = state.plates.iter().collect();
    // Plate orders are unique, so the order is total.
    plates.sort_by(|a, b| a.order.get().total_cmp(&b.order.get()));
    let active = state.active_plate_id.as_utf16();
    for plate in plates {
        let plate_id: Arc<[u16]> = plate.id.as_utf16().into();
        out.plates.push(RenderPlate {
            plate_id: plate_id.clone(),
            order: plate.order.get(),
            printable: plate.printable,
            active: plate.id.as_utf16() == active,
        });
        for object in plate.objects.iter() {
            let object_id: Arc<[u16]> = object.id.as_utf16().into();
            for instance in object.instances.iter() {
                out.instances.push(RenderInstance {
                    instance_id: instance.id.as_utf16().into(),
                    object_id: object_id.clone(),
                    plate_id: plate_id.clone(),
                    transform: transform(&instance.transform),
                    printable: instance.printable,
                });
            }
            for volume in object.volumes.iter() {
                out.volumes.push(RenderVolume {
                    volume_id: volume.id.as_utf16().into(),
                    object_id: object_id.clone(),
                    role: volume.role,
                    asset_id: volume.source.asset_id.as_utf16().into(),
                    triangle_count: volume.source.triangle_count.get(),
                    transform: transform(&volume.transform),
                    color: volume_display_color(state, object, volume).map(Into::into),
                });
            }
        }
    }
    out
}

/// The changes that turn `base` (or an empty scene) into `target`: removals
/// first, children before parents, in the base's order; then records that are
/// new or differ, parents before children, in the target's order.
pub fn diff(base: Option<&RenderProjection>, target: &RenderProjection) -> Vec<RenderChange> {
    fn removed<'a, T>(
        previous: Option<&'a [T]>,
        next: &[T],
        key: impl Fn(&T) -> &[u16],
    ) -> impl Iterator<Item = &'a T> {
        let kept: std::collections::HashSet<&[u16]> = next.iter().map(&key).collect();
        let gone: Vec<&'a T> = previous
            .unwrap_or(&[])
            .iter()
            .filter(|r| !kept.contains(key(r)))
            .collect();
        gone.into_iter()
    }
    fn changed<'a, T: PartialEq>(
        previous: Option<&[T]>,
        next: &'a [T],
        key: impl Fn(&T) -> &[u16],
    ) -> impl Iterator<Item = &'a T> {
        let prior: HashMap<&[u16], &T> = previous
            .unwrap_or(&[])
            .iter()
            .map(|r| (key(r), r))
            .collect();
        let fresh: Vec<&'a T> = next
            .iter()
            .filter(|r| prior.get(key(r)).is_none_or(|before| *before != *r))
            .collect();
        fresh.into_iter()
    }
    let mut out = Vec::new();
    out.extend(
        removed(base.map(|b| &b.volumes[..]), &target.volumes, |v| {
            &v.volume_id
        })
        .map(|v| RenderChange::RemoveVolume(v.volume_id.clone())),
    );
    out.extend(
        removed(base.map(|b| &b.instances[..]), &target.instances, |i| {
            &i.instance_id
        })
        .map(|i| RenderChange::RemoveInstance(i.instance_id.clone())),
    );
    out.extend(
        removed(base.map(|b| &b.plates[..]), &target.plates, |p| &p.plate_id)
            .map(|p| RenderChange::RemovePlate(p.plate_id.clone())),
    );
    out.extend(
        changed(base.map(|b| &b.plates[..]), &target.plates, |p| &p.plate_id)
            .map(|p| RenderChange::Plate(p.clone())),
    );
    out.extend(
        changed(base.map(|b| &b.instances[..]), &target.instances, |i| {
            &i.instance_id
        })
        .map(|i| RenderChange::Instance(i.clone())),
    );
    out.extend(
        changed(base.map(|b| &b.volumes[..]), &target.volumes, |v| {
            &v.volume_id
        })
        .map(|v| RenderChange::Volume(v.clone())),
    );
    out
}

/// Pages of revisioned deltas over one session's acknowledged snapshots.
#[derive(Debug, Default)]
pub struct RenderFeed {
    retained: Vec<ProjectSnapshot>,
    cached: Option<(
        Option<ProjectSnapshot>,
        ProjectSnapshot,
        Arc<Vec<RenderChange>>,
    )>,
}
impl RenderFeed {
    pub fn page(
        &mut self,
        current: &ProjectSnapshot,
        request: &wire::RenderRequest,
    ) -> Result<wire::RenderPage, Refusal> {
        if request.count > MAX_PAGE {
            return Err(Refusal::InvalidRequest);
        }
        let target = match &request.target {
            wire::OptionalRenderCursor::Value(cursor) => {
                self.find(current, cursor).ok_or(Refusal::Stale)?
            }
            wire::OptionalRenderCursor::Absent(_) => current.clone(),
        };
        let base = match &request.base {
            wire::OptionalRenderCursor::Value(cursor) => self.find(current, cursor),
            wire::OptionalRenderCursor::Absent(_) => None,
        };
        if let Some(base) = &base {
            self.retain(base);
        }
        self.retain(&target);
        let changes = self.changes(base.as_ref(), &target);
        let start = usize::try_from(request.start)
            .unwrap_or(usize::MAX)
            .min(changes.len());
        let end = start
            .saturating_add(request.count as usize)
            .min(changes.len());
        Ok(wire::RenderPage {
            base: match &base {
                Some(base) => wire::OptionalRenderCursor::Value(cursor(base)),
                None => wire::OptionalRenderCursor::Absent(wire::Empty {}),
            },
            target: cursor(&target),
            total: changes.len() as Counter,
            changes: changes[start..end].iter().map(change_wire).collect(),
        })
    }

    /// Forget every retained snapshot, as on disposal.
    pub fn clear(&mut self) {
        self.retained.clear();
        self.cached = None;
    }

    fn changes(
        &mut self,
        base: Option<&ProjectSnapshot>,
        target: &ProjectSnapshot,
    ) -> Arc<Vec<RenderChange>> {
        if let Some((cached_base, cached_target, changes)) = &self.cached
            && same(cached_target, target)
            && match (cached_base, base) {
                (Some(a), Some(b)) => same(a, b),
                (None, None) => true,
                _ => false,
            }
        {
            return changes.clone();
        }
        let changes = Arc::new(diff(
            base.map(|b| project(b.state())).as_ref(),
            &project(target.state()),
        ));
        self.cached = Some((base.cloned(), target.clone(), changes.clone()));
        changes
    }

    fn find(
        &self,
        current: &ProjectSnapshot,
        cursor: &wire::RenderCursor,
    ) -> Option<ProjectSnapshot> {
        let matches = |s: &ProjectSnapshot| {
            s.revision() == cursor.revision
                && s.hash()
                    .encode_utf16()
                    .eq(cursor.semantic_hash.iter().copied())
        };
        if matches(current) {
            return Some(current.clone());
        }
        self.retained.iter().find(|s| matches(s)).cloned()
    }

    /// Most recently served last; the oldest is released past the bound.
    fn retain(&mut self, snapshot: &ProjectSnapshot) {
        self.retained.retain(|held| !same(held, snapshot));
        self.retained.push(snapshot.clone());
        if self.retained.len() > RETAINED_SNAPSHOTS {
            self.retained.remove(0);
        }
    }
}

fn same(a: &ProjectSnapshot, b: &ProjectSnapshot) -> bool {
    a.revision() == b.revision() && a.hash() == b.hash()
}

fn cursor(snapshot: &ProjectSnapshot) -> wire::RenderCursor {
    wire::RenderCursor {
        revision: snapshot.revision(),
        semantic_hash: snapshot.hash().encode_utf16().collect(),
    }
}

fn transform_wire(t: &[[f64; 4]; 3]) -> wire::Transform {
    wire::Transform {
        translation_mm: t[0][..3].to_vec(),
        rotation: t[1].to_vec(),
        scale: t[2][..3].to_vec(),
    }
}

fn role_wire(role: crate::model::VolumeRole) -> wire::VolumeRoleName {
    use crate::model::VolumeRole as R;
    match role {
        R::Model => wire::VolumeRoleName::Model,
        R::NegativeVolume => wire::VolumeRoleName::NegativeVolume,
        R::ParameterModifier => wire::VolumeRoleName::ParameterModifier,
        R::SupportBlocker => wire::VolumeRoleName::SupportBlocker,
        R::SupportEnforcer => wire::VolumeRoleName::SupportEnforcer,
    }
}

fn change_wire(change: &RenderChange) -> wire::RenderChange {
    match change {
        RenderChange::Plate(p) => wire::RenderChange::Plate(wire::RenderPlate {
            plate_id: p.plate_id.to_vec(),
            order: p.order,
            printable: p.printable,
            active: p.active,
        }),
        RenderChange::Instance(i) => wire::RenderChange::Instance(wire::RenderInstance {
            instance_id: i.instance_id.to_vec(),
            object_id: i.object_id.to_vec(),
            plate_id: i.plate_id.to_vec(),
            transform: transform_wire(&i.transform),
            printable: i.printable,
        }),
        RenderChange::Volume(v) => wire::RenderChange::Volume(wire::RenderVolume {
            volume_id: v.volume_id.to_vec(),
            object_id: v.object_id.to_vec(),
            role: role_wire(v.role),
            asset_id: v.asset_id.to_vec(),
            triangle_count: v.triangle_count as Counter,
            transform: transform_wire(&v.transform),
            color: match &v.color {
                Some(c) => wire::OptionalText::Value(c.to_vec()),
                None => wire::OptionalText::Absent(wire::Empty {}),
            },
        }),
        RenderChange::RemovePlate(id) => wire::RenderChange::RemovePlate(id.to_vec()),
        RenderChange::RemoveInstance(id) => wire::RenderChange::RemoveInstance(id.to_vec()),
        RenderChange::RemoveVolume(id) => wire::RenderChange::RemoveVolume(id.to_vec()),
    }
}
