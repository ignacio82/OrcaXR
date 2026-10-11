//! Ray picking in printer space (`picking.ts`): the nearest front-facing
//! facet of a plate's volumes a ray meets. Each volume's matrix is its
//! instance's transform then its own, composed, multiplied and inverted as
//! three.js does for the workspace's display meshes, and the ray meets each
//! facet with three's `Ray.intersectTriangle` with back faces culled. Ties go
//! to the earlier volume in plate order, then the lower facet.
//!
//! A [`PickScene`] captures one plate's volumes — decoded meshes shared by
//! asset, matrices and their inverses — so a host picks every pointer move
//! off the session until the project changes. Each mesh builds a bounding
//! volume hierarchy on first use; it prunes with a relative slack and padded
//! boxes and decides between near candidates by the reference's own world
//! distance, so it answers exactly as the brute-force reference does.
use crate::store::ProjectSnapshot;
use crate::{assets::AssetRepository, mesh::decode_indexed, model::Transform, model::VolumeRole};
use orcaxr_contracts::project_intent_types as wire;
use std::sync::{Arc, OnceLock};

pub type Vec3 = [f64; 3];
/// Column-major, as three's `Matrix4.elements`.
pub type Matrix = [f64; 16];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    UnknownPlate,
    /// A volume's mesh asset is missing or not a readable indexed mesh.
    InvalidMesh,
    Disposed,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownPlate => "unknown_plate",
            Self::InvalidMesh => "invalid_mesh",
            Self::Disposed => "disposed",
        }
    }
}

/// `Matrix4.compose` after `Quaternion.fromArray(...).normalize()`.
pub fn compose(transform: &Transform) -> Matrix {
    compose_parts(
        transform.translation_mm.map(|v| v.get()),
        transform.rotation.map(|v| v.get()),
        transform.scale.map(|v| v.get()),
    )
}

/// [`compose`] of a canonical transform's translation (mm), rotation
/// quaternion `[x, y, z, w]` and scale.
pub fn compose_parts(translation_mm: Vec3, rotation: [f64; 4], scale: Vec3) -> Matrix {
    let [mut x, mut y, mut z, mut w] = rotation;
    let l = (x * x + y * y + z * z + w * w).sqrt();
    if l == 0.0 {
        (x, y, z, w) = (0.0, 0.0, 0.0, 1.0);
    } else {
        let l = 1.0 / l;
        (x, y, z, w) = (x * l, y * l, z * l, w * l);
    }
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    let [sx, sy, sz] = scale;
    let [px, py, pz] = translation_mm;
    [
        (1.0 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.0,
        (xy - wz) * sy,
        (1.0 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0.0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1.0 - (xx + yy)) * sz,
        0.0,
        px,
        py,
        pz,
        1.0,
    ]
}

/// `Matrix4.multiplyMatrices(a, b)`.
pub fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let [
        a11,
        a21,
        a31,
        a41,
        a12,
        a22,
        a32,
        a42,
        a13,
        a23,
        a33,
        a43,
        a14,
        a24,
        a34,
        a44,
    ] = *a;
    let [
        b11,
        b21,
        b31,
        b41,
        b12,
        b22,
        b32,
        b42,
        b13,
        b23,
        b33,
        b43,
        b14,
        b24,
        b34,
        b44,
    ] = *b;
    [
        a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
        a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
        a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
        a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
        a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
        a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
        a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
        a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
        a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
        a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
        a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
        a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
        a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
        a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
        a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
        a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
    ]
}

/// `Matrix4.invert()`: a singular matrix inverts to zeros.
pub fn invert(te: &Matrix) -> Matrix {
    let [
        n11,
        n21,
        n31,
        n41,
        n12,
        n22,
        n32,
        n42,
        n13,
        n23,
        n33,
        n43,
        n14,
        n24,
        n34,
        n44,
    ] = *te;
    let t1 = n11 * n22 - n21 * n12;
    let t2 = n11 * n32 - n31 * n12;
    let t3 = n11 * n42 - n41 * n12;
    let t4 = n21 * n32 - n31 * n22;
    let t5 = n21 * n42 - n41 * n22;
    let t6 = n31 * n42 - n41 * n32;
    let t7 = n13 * n24 - n23 * n14;
    let t8 = n13 * n34 - n33 * n14;
    let t9 = n13 * n44 - n43 * n14;
    let t10 = n23 * n34 - n33 * n24;
    let t11 = n23 * n44 - n43 * n24;
    let t12 = n33 * n44 - n43 * n34;
    let det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
    if det == 0.0 {
        return [0.0; 16];
    }
    let d = 1.0 / det;
    [
        (n22 * t12 - n32 * t11 + n42 * t10) * d,
        (n31 * t11 - n21 * t12 - n41 * t10) * d,
        (n24 * t6 - n34 * t5 + n44 * t4) * d,
        (n33 * t5 - n23 * t6 - n43 * t4) * d,
        (n32 * t9 - n12 * t12 - n42 * t8) * d,
        (n11 * t12 - n31 * t9 + n41 * t8) * d,
        (n34 * t3 - n14 * t6 - n44 * t2) * d,
        (n13 * t6 - n33 * t3 + n43 * t2) * d,
        (n12 * t11 - n22 * t9 + n42 * t7) * d,
        (n21 * t9 - n11 * t11 - n41 * t7) * d,
        (n14 * t5 - n24 * t3 + n44 * t1) * d,
        (n23 * t3 - n13 * t5 - n43 * t1) * d,
        (n22 * t8 - n12 * t10 - n32 * t7) * d,
        (n11 * t10 - n21 * t8 + n31 * t7) * d,
        (n24 * t2 - n14 * t4 - n34 * t1) * d,
        (n13 * t4 - n23 * t2 + n33 * t1) * d,
    ]
}

/// `Vector3.applyMatrix4`.
pub fn apply(v: &Vec3, e: &Matrix) -> Vec3 {
    let [x, y, z] = *v;
    let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    [
        (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
        (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
        (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
    ]
}

/// `Vector3.normalize`: `divideScalar(length || 1)`.
fn normalize(v: &Vec3) -> Vec3 {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let s = 1.0
        / if length == 0.0 || length.is_nan() {
            1.0
        } else {
            length
        };
    [v[0] * s, v[1] * s, v[2] * s]
}

/// `Vector3.transformDirection`.
fn transform_direction(v: &Vec3, e: &Matrix) -> Vec3 {
    let [x, y, z] = *v;
    normalize(&[
        e[0] * x + e[4] * y + e[8] * z,
        e[1] * x + e[5] * y + e[9] * z,
        e[2] * x + e[6] * y + e[10] * z,
    ])
}

fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
/// `Vector3.crossVectors(a, b)`.
fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// `Ray.intersectTriangle(a, b, c, true)`: the distance along the ray.
pub fn intersect_triangle(
    origin: &Vec3,
    direction: &Vec3,
    a: &Vec3,
    b: &Vec3,
    c: &Vec3,
) -> Option<f64> {
    let edge1 = sub(b, a);
    let edge2 = sub(c, a);
    let normal = cross(&edge1, &edge2);
    let ddn = dot(direction, &normal);
    // Front sides only: a ray along the normal meets a back face, and a ray
    // in the facet's plane meets nothing.
    if ddn.is_nan() || ddn >= 0.0 {
        return None;
    }
    let sign = -1.0;
    let ddn = -ddn;
    let diff = sub(origin, a);
    let ddqxe2 = sign * dot(direction, &cross(&diff, &edge2));
    if ddqxe2 < 0.0 {
        return None;
    }
    let dde1xq = sign * dot(direction, &cross(&edge1, &diff));
    if dde1xq < 0.0 {
        return None;
    }
    if ddqxe2 + dde1xq > ddn {
        return None;
    }
    let qdn = -sign * dot(&diff, &normal);
    if qdn < 0.0 {
        return None;
    }
    Some(qdn / ddn)
}

/// `Ray.at(t)`: `direction * t + origin`.
fn at(origin: &Vec3, direction: &Vec3, t: f64) -> Vec3 {
    [
        direction[0] * t + origin[0],
        direction[1] * t + origin[1],
        direction[2] * t + origin[2],
    ]
}

/// The relative slack within which the hierarchy keeps near candidates, far
/// wider than the rounding that could reorder them by world distance.
const SLACK: f64 = 1e-9;
const LEAF: usize = 8;

/// One decoded mesh and, once a pick needs it, its bounding volume hierarchy.
struct SceneMesh {
    positions: Vec<Vec3>,
    indices: Vec<u32>,
    hierarchy: OnceLock<Hierarchy>,
}
impl SceneMesh {
    fn triangle(&self, triangle: usize) -> [Vec3; 3] {
        let i = &self.indices[triangle * 3..triangle * 3 + 3];
        [
            self.positions[i[0] as usize],
            self.positions[i[1] as usize],
            self.positions[i[2] as usize],
        ]
    }
    fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

struct Node {
    min: Vec3,
    max: Vec3,
    /// A leaf's facets are `order[start..start + count]`; an inner node's
    /// children are `start` and `count`.
    start: usize,
    count: usize,
    leaf: bool,
}
struct Hierarchy {
    nodes: Vec<Node>,
    order: Vec<u32>,
}
impl Hierarchy {
    /// Median splits on the longest centroid axis; boxes are padded so a
    /// facet the exact test meets is never pruned by box rounding.
    fn build(mesh: &SceneMesh) -> Self {
        let count = mesh.triangle_count();
        let mut order: Vec<u32> = (0..count as u32).collect();
        let centroids: Vec<Vec3> = (0..count)
            .map(|t| {
                let [a, b, c] = mesh.triangle(t);
                [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0)
            })
            .collect();
        let mut nodes = Vec::new();
        // (node, start, end)
        let mut stack = vec![(0usize, 0usize, count)];
        nodes.push(Node {
            min: [0.0; 3],
            max: [0.0; 3],
            start: 0,
            count: 0,
            leaf: true,
        });
        while let Some((index, start, end)) = stack.pop() {
            let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            let (mut cmin, mut cmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for &t in &order[start..end] {
                for v in mesh.triangle(t as usize) {
                    for k in 0..3 {
                        min[k] = min[k].min(v[k]);
                        max[k] = max[k].max(v[k]);
                    }
                }
                let c = centroids[t as usize];
                for k in 0..3 {
                    cmin[k] = cmin[k].min(c[k]);
                    cmax[k] = cmax[k].max(c[k]);
                }
            }
            for k in 0..3 {
                let pad = (min[k].abs().max(max[k].abs()) * SLACK).max(1e-12);
                min[k] -= pad;
                max[k] += pad;
            }
            if end - start <= LEAF {
                nodes[index] = Node {
                    min,
                    max,
                    start,
                    count: end - start,
                    leaf: true,
                };
                continue;
            }
            let axis = (0..3)
                .max_by(|&a, &b| (cmax[a] - cmin[a]).total_cmp(&(cmax[b] - cmin[b])))
                .unwrap_or(0);
            let middle = start + (end - start) / 2;
            order[start..end].select_nth_unstable_by(middle - start, |&a, &b| {
                centroids[a as usize][axis].total_cmp(&centroids[b as usize][axis])
            });
            let (left, right) = (nodes.len(), nodes.len() + 1);
            for _ in 0..2 {
                nodes.push(Node {
                    min: [0.0; 3],
                    max: [0.0; 3],
                    start: 0,
                    count: 0,
                    leaf: true,
                });
            }
            nodes[index] = Node {
                min,
                max,
                start: left,
                count: right,
                leaf: false,
            };
            stack.push((right, middle, end));
            stack.push((left, start, middle));
        }
        Self { nodes, order }
    }

    /// The entry distance of a ray into a node's box, or `None` past it.
    /// An undefined slab (a zero direction on the box plane) never prunes.
    fn entry(node: &Node, origin: &Vec3, inverse: &Vec3) -> Option<f64> {
        let (mut near, mut far) = (0.0f64, f64::INFINITY);
        for k in 0..3 {
            let a = (node.min[k] - origin[k]) * inverse[k];
            let b = (node.max[k] - origin[k]) * inverse[k];
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            if !lo.is_nan() {
                near = near.max(lo);
            }
            if !hi.is_nan() {
                far = far.min(hi);
            }
        }
        (near <= far).then_some(near)
    }

    /// Every facet whose ray distance is within [`SLACK`] of the nearest.
    fn candidates(&self, mesh: &SceneMesh, origin: &Vec3, direction: &Vec3) -> Vec<(f64, usize)> {
        let inverse = direction.map(|d| 1.0 / d);
        let mut best = f64::INFINITY;
        let bound = |best: f64| best + best.abs() * SLACK + 1e-12;
        let mut found = Vec::new();
        let mut stack = vec![0usize];
        while let Some(index) = stack.pop() {
            let node = &self.nodes[index];
            let Some(entry) = Self::entry(node, origin, &inverse) else {
                continue;
            };
            if entry > bound(best) {
                continue;
            }
            if node.leaf {
                for &t in &self.order[node.start..node.start + node.count] {
                    let [a, b, c] = mesh.triangle(t as usize);
                    if let Some(distance) = intersect_triangle(origin, direction, &a, &b, &c) {
                        if distance < best {
                            best = distance;
                        }
                        found.push((distance, t as usize));
                    }
                }
            } else {
                stack.push(node.count);
                stack.push(node.start);
            }
        }
        found.retain(|&(distance, _)| distance <= bound(best));
        found
    }
}

struct SceneVolume {
    object_id: Vec<u16>,
    instance_id: Vec<u16>,
    volume_id: Vec<u16>,
    matrix: Matrix,
    inverse: Matrix,
    mesh: Arc<SceneMesh>,
}

/// One plate's volumes captured for picking, in plate order: objects, then
/// instances, then volumes.
pub struct PickScene {
    volumes: Vec<SceneVolume>,
}

/// One pick.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub volume: usize,
    pub triangle: usize,
    pub point: Vec3,
    pub local_point: Vec3,
    pub local_origin: Vec3,
    pub distance: f64,
}

impl PickScene {
    pub fn capture(
        snapshot: &ProjectSnapshot,
        assets: &AssetRepository,
        request: &wire::PickSceneRequest,
    ) -> Result<Self, Refusal> {
        let state = snapshot.state();
        let plate = state
            .plates
            .iter()
            .find(|plate| plate.id.as_utf16() == request.plate_id.as_slice())
            .ok_or(Refusal::UnknownPlate)?;
        let mut meshes: Vec<(Vec<u16>, Arc<SceneMesh>)> = Vec::new();
        let mut volumes = Vec::new();
        for object in plate.objects.iter() {
            for instance in object.instances.iter() {
                let instance_matrix = compose(&instance.transform);
                for volume in object.volumes.iter() {
                    if request.models_only && volume.role != VolumeRole::Model {
                        continue;
                    }
                    let asset = volume.source.asset_id.as_utf16().to_vec();
                    let mesh = match meshes.iter().find(|(id, _)| *id == asset) {
                        Some((_, mesh)) => mesh.clone(),
                        None => {
                            let lease = assets
                                .peek(&volume.source.asset_id)
                                .ok_or(Refusal::InvalidMesh)?;
                            let decoded =
                                decode_indexed(&lease).map_err(|_| Refusal::InvalidMesh)?;
                            let mesh = Arc::new(SceneMesh {
                                positions: decoded.positions,
                                indices: decoded.indices,
                                hierarchy: OnceLock::new(),
                            });
                            meshes.push((asset, mesh.clone()));
                            mesh
                        }
                    };
                    let matrix = multiply(&instance_matrix, &compose(&volume.transform));
                    volumes.push(SceneVolume {
                        object_id: object.id.as_utf16().to_vec(),
                        instance_id: instance.id.as_utf16().to_vec(),
                        volume_id: volume.id.as_utf16().to_vec(),
                        inverse: invert(&matrix),
                        matrix,
                        mesh,
                    });
                }
            }
        }
        Ok(Self { volumes })
    }

    /// The nearest front-facing facet a printer-space ray meets.
    pub fn nearest(&self, origin: &Vec3, direction: &Vec3) -> Option<Hit> {
        let direction = normalize(direction);
        let mut best: Option<Hit> = None;
        for (index, volume) in self.volumes.iter().enumerate() {
            let local_origin = apply(origin, &volume.inverse);
            let local_direction = transform_direction(&direction, &volume.inverse);
            let hierarchy = volume
                .mesh
                .hierarchy
                .get_or_init(|| Hierarchy::build(&volume.mesh));
            let mut candidates =
                hierarchy.candidates(&volume.mesh, &local_origin, &local_direction);
            // The reference walks facets in order; equal distances keep the first.
            candidates.sort_by_key(|&(_, triangle)| triangle);
            for (t, triangle) in candidates {
                let local_point = at(&local_origin, &local_direction, t);
                let point = apply(&local_point, &volume.matrix);
                let d = sub(&point, origin);
                let distance = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if best.as_ref().is_some_and(|best| {
                    distance.partial_cmp(&best.distance) != Some(std::cmp::Ordering::Less)
                }) {
                    continue;
                }
                best = Some(Hit {
                    volume: index,
                    triangle,
                    point,
                    local_point,
                    local_origin,
                    distance,
                });
            }
        }
        best
    }

    pub fn pick(&self, ray: &wire::PickRay) -> wire::PickReply {
        let vector = |v: &[f64]| [v[0], v[1], v[2]];
        match self.nearest(&vector(&ray.origin), &vector(&ray.direction)) {
            None => wire::PickReply::Miss(wire::Empty {}),
            Some(hit) => {
                let volume = &self.volumes[hit.volume];
                wire::PickReply::Hit(wire::PickHit {
                    object_id: volume.object_id.clone(),
                    instance_id: volume.instance_id.clone(),
                    volume_id: volume.volume_id.clone(),
                    triangle: hit.triangle as u64,
                    point: hit.point.to_vec(),
                    local_point: hit.local_point.to_vec(),
                    local_origin: hit.local_origin.to_vec(),
                    distance: hit.distance,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference's walk: every facet in order, the strictly nearer kept.
    fn exhaustive(mesh: &SceneMesh, origin: &Vec3, direction: &Vec3) -> Option<(f64, usize)> {
        let mut best: Option<(f64, usize)> = None;
        for triangle in 0..mesh.triangle_count() {
            let [a, b, c] = mesh.triangle(triangle);
            if let Some(t) = intersect_triangle(origin, direction, &a, &b, &c)
                && best.is_none_or(|(d, _)| t < d)
            {
                best = Some((t, triangle));
            }
        }
        best
    }

    fn nearest(mesh: &SceneMesh, origin: &Vec3, direction: &Vec3) -> Option<(f64, usize)> {
        let hierarchy = mesh.hierarchy.get_or_init(|| Hierarchy::build(mesh));
        let mut candidates = hierarchy.candidates(mesh, origin, direction);
        candidates.sort_by_key(|&(_, triangle)| triangle);
        candidates.into_iter().fold(
            None,
            |best: Option<(f64, usize)>, (t, triangle)| match best {
                Some((d, _)) if t >= d => best,
                _ => Some((t, triangle)),
            },
        )
    }

    /// A height field of `n`×`n` cells: many coplanar facets and shared
    /// vertices, so straight-down rays at grid points meet exact ties.
    fn grid(n: usize) -> SceneMesh {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for y in 0..=n {
            for x in 0..=n {
                let height = if (x / 7 + y / 5) % 2 == 0 { 0.0 } else { 0.5 };
                positions.push([x as f64, y as f64, height]);
            }
        }
        let at = |x: usize, y: usize| (y * (n + 1) + x) as u32;
        for y in 0..n {
            for x in 0..n {
                indices.extend([at(x, y), at(x + 1, y), at(x + 1, y + 1)]);
                indices.extend([at(x, y), at(x + 1, y + 1), at(x, y + 1)]);
            }
        }
        SceneMesh {
            positions,
            indices,
            hierarchy: OnceLock::new(),
        }
    }

    #[test]
    fn the_hierarchy_answers_as_the_exhaustive_walk() {
        let mesh = grid(96);
        let mut seed = 0x1234_5678u64;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut agreed = 0;
        for i in 0..4000 {
            let (origin, direction) = if i % 4 == 0 {
                // Straight down onto grid points and edges: exact ties.
                let x = (random() * 96.0).floor() + if i % 8 == 0 { 0.0 } else { 0.5 };
                let y = (random() * 96.0).floor();
                ([x, y, 10.0], [0.0, 0.0, -1.0])
            } else {
                let origin = [
                    random() * 140.0 - 20.0,
                    random() * 140.0 - 20.0,
                    5.0 + random() * 40.0,
                ];
                let target = [random() * 96.0, random() * 96.0, random() * 0.5];
                (origin, normalize(&sub(&target, &origin)))
            };
            assert_eq!(
                nearest(&mesh, &origin, &direction),
                exhaustive(&mesh, &origin, &direction),
                "ray {i}"
            );
            agreed += 1;
        }
        assert_eq!(agreed, 4000);
    }
}
