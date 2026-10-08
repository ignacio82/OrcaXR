use super::*;
use crate::{
    assets::AssetSnapshot,
    ids::InstanceId,
    model::{Encode, ProjectState, Transform, VolumeRole, find_instance},
};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}
impl Bounds {
    /// The accumulator before any vertex: infinite and refused by `finish`.
    pub fn empty() -> Self {
        Self {
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        }
    }
    /// Refuse an accumulator that never saw a finite vertex.
    pub fn finish(self) -> Result<Self, Error> {
        if self.min.iter().chain(&self.max).all(|v| v.is_finite()) {
            Ok(self)
        } else {
            Err(Error::NoGeometry)
        }
    }
}
struct Trs {
    scale: [f64; 3],
    translation: [f64; 3],
    rotation: [f64; 4],
}
impl Trs {
    fn new(v: &Transform) -> Result<Self, Error> {
        let q = v.rotation.map(|n| n.get());
        // Scaled, compensated sum in the pinned V8 four-argument Math.hypot
        // order. Do not replace with chained binary hypot or fused arithmetic.
        let max = q.iter().map(|v| v.abs()).fold(0.0, f64::max);
        if max == 0.0 || !max.is_finite() {
            return Err(Error::Transform);
        }
        let mut sum = 0.0;
        let mut compensation = 0.0;
        for value in q {
            let n = value.abs() / max;
            let term = n * n - compensation;
            let next = sum + term;
            compensation = (next - sum) - term;
            sum = next;
        }
        let length = sum.sqrt() * max;
        if !length.is_finite() || length == 0.0 {
            return Err(Error::Transform);
        }
        Ok(Self {
            scale: v.scale.map(|n| n.get()),
            translation: v.translation_mm.map(|n| n.get()),
            rotation: q.map(|n| n / length),
        })
    }
    fn apply(&self, v: [f64; 3]) -> [f64; 3] {
        let [qx, qy, qz, qw] = self.rotation;
        let [x, y, z] = std::array::from_fn(|i| v[i] * self.scale[i]);
        let uvx = qy * z - qz * y;
        let uvy = qz * x - qx * z;
        let uvz = qx * y - qy * x;
        let uuvx = qy * uvz - qz * uvy;
        let uuvy = qz * uvx - qx * uvz;
        let uuvz = qx * uvy - qy * uvx;
        [
            x + 2.0 * (qw * uvx + uuvx) + self.translation[0],
            y + 2.0 * (qw * uvy + uuvy) + self.translation[1],
            z + 2.0 * (qw * uvz + uuvz) + self.translation[2],
        ]
    }
}
fn accumulate(
    mesh: &Mesh,
    bounds: &mut Bounds,
    volume: &Transform,
    instance: &Transform,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    let volume = Trs::new(volume)?;
    let instance = Trs::new(instance)?;
    for (i, v) in mesh.positions().enumerate() {
        if i.is_multiple_of(4096) {
            check(cancelled)?;
        }
        let point = instance.apply(volume.apply(v.map(f64::from)));
        if !point.iter().all(|v| v.is_finite()) {
            return Err(Error::NonFiniteVertex);
        }
        for (axis, &v) in point.iter().enumerate() {
            if v < bounds.min[axis] {
                bounds.min[axis] = v;
            }
            if v > bounds.max[axis] {
                bounds.max[axis] = v;
            }
        }
    }
    check(cancelled)
}
impl Mesh {
    /// Exact vertex bounds after volume then instance TRS, including unused
    /// vertices. No box-corner approximation or transformed vertex array.
    pub fn bounds(
        &self,
        volume: &Transform,
        instance: &Transform,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Bounds, Error> {
        check(&mut cancelled)?;
        let mut result = Bounds::empty();
        accumulate(self, &mut result, volume, instance, &mut cancelled)?;
        result.finish()
    }
    /// Widen `bounds` by this mesh after volume then instance TRS. Callers
    /// that union several volumes report a failure at the volume that caused it.
    pub fn accumulate_bounds(
        &self,
        bounds: &mut Bounds,
        volume: &Transform,
        instance: &Transform,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<(), Error> {
        accumulate(self, bounds, volume, instance, &mut cancelled)
    }
}
#[derive(Debug, Clone, Copy, Default)]
pub struct BoundsLimits {
    pub mesh: Limits,
    pub selected: usize,
    pub assets: usize,
    pub vertex_visits: usize,
}
/// Read captured project/asset state on a preparation worker. Full descriptor
/// agreement precedes geometry use. No live revision is inferred or published.
pub fn instance_bounds(
    state: &ProjectState,
    assets: &AssetSnapshot,
    selected: &[InstanceId],
    roles: Option<&[VolumeRole]>,
    limits: BoundsLimits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Bounds, Error> {
    check(&mut cancelled)?;
    if selected.len() > limits.selected {
        return Err(Error::Limits);
    }
    if selected.is_empty() {
        return Err(Error::NoGeometry);
    }
    let mut seen = BTreeSet::new();
    let mut meshes = BTreeMap::new();
    let mut visits = 0usize;
    let mut result = Bounds::empty();
    for id in selected {
        check(&mut cancelled)?;
        if !seen.insert(id) {
            return Err(Error::DuplicateInstance);
        }
        let (_, object, instance) = find_instance(state, id).ok_or(Error::MissingInstance)?;
        for volume in object.volumes.iter() {
            check(&mut cancelled)?;
            if roles.is_some_and(|v| !v.contains(&volume.role)) {
                continue;
            }
            let descriptor = state
                .source_assets
                .iter()
                .find(|d| d.id == volume.source.asset_id)
                .ok_or(Error::MissingAsset)?;
            if !meshes.contains_key(&volume.source.asset_id) {
                if meshes.len() >= limits.assets {
                    return Err(Error::Limits);
                }
                let lease = assets
                    .peek(&volume.source.asset_id)
                    .ok_or(Error::MissingAsset)?;
                if !descriptor
                    .matches_value(lease.descriptor())
                    .map_err(|_| Error::Metadata)?
                {
                    return Err(Error::MetadataMismatch);
                }
                meshes.insert(
                    volume.source.asset_id.clone(),
                    Mesh::open(lease, limits.mesh, &mut cancelled)?,
                );
            }
            let mesh = &meshes[&volume.source.asset_id];
            visits = visits
                .checked_add(mesh.vertex_count())
                .filter(|v| *v <= limits.vertex_visits)
                .ok_or(Error::Limits)?;
            accumulate(
                mesh,
                &mut result,
                &volume.transform,
                &instance.transform,
                &mut cancelled,
            )?;
        }
    }
    check(&mut cancelled)?;
    result.finish()
}
