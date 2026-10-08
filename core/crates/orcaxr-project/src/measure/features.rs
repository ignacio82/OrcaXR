//! `SurfaceFeatureExtractor` (`measure.ts`), after the pinned `MeasuringImpl`:
//! facets clustered into planes by identical normals, each plane's border
//! walked, borders resolved to circles (or polygon edges about a centre) and
//! edges, with the browser's deterministic algebraic circle fit, and the
//! feature a pick claims chosen as `Measuring::get_feature` does.
use super::pairs::{
    add, cross, dot, is_approx, measure, normalized, orthogonal_unit, scale, squared_norm, sub,
};
use super::{Feature, V};
use crate::js_math;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Pinned `is_same_normal` component tolerance in `update_planes`.
const SAME_NORMAL_TOLERANCE: f64 = 0.001;
/// Pinned circle-fit acceptance in `extract_features`.
const CIRCLE_FIT_MAX_ERROR: f64 = 0.05;
/// Pinned `feature_hover_limit`.
pub const FEATURE_HOVER_LIMIT_MM: f64 = 0.5;

struct Plane {
    facets: Vec<u32>,
    normal: V,
    borders: Vec<Vec<V>>,
    features: OnceLock<Vec<Feature>>,
}

pub struct Extractor {
    vertices: Vec<V>,
    triangles: Vec<[u32; 3]>,
    face_to_plane: Vec<u32>,
    planes: Vec<Plane>,
}

/// A pick on a facet the mesh does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownFace;

impl Extractor {
    /// `None` for a mesh with no facets.
    pub fn new(vertices: Vec<V>, triangles: Vec<[u32; 3]>) -> Option<Self> {
        if triangles.is_empty() {
            return None;
        }
        let normals: Vec<V> = triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|v| vertices[v as usize]);
                normalized(cross(sub(b, a), sub(c, a)))
            })
            .collect();
        let neighbours = neighbours(&triangles);
        let mut extractor = Self {
            vertices,
            face_to_plane: vec![u32::MAX; triangles.len()],
            triangles,
            planes: Vec::new(),
        };
        extractor.build_planes(&normals, &neighbours);
        Some(extractor)
    }

    pub fn plane_count(&self) -> usize {
        self.planes.len()
    }

    /// `update_planes`: a neighbour is queued but only claimed when popped
    /// with the seed's normal, so a differently turned neighbour stays free
    /// to seed its own plane.
    fn build_planes(&mut self, normals: &[V], neighbours: &[[i64; 3]]) {
        // The plane (plus one) a face was last queued for.
        let mut queued = vec![0u32; self.triangles.len()];
        for seed in 0..self.triangles.len() {
            if self.face_to_plane[seed] != u32::MAX {
                continue;
            }
            let index = self.planes.len() as u32;
            let seed_normal = normals[seed];
            let mut facets = Vec::new();
            let mut stack = vec![seed as u32];
            queued[seed] = index + 1;
            while let Some(face) = stack.pop() {
                let f = face as usize;
                if self.face_to_plane[f] != u32::MAX || !same_normal(normals[f], seed_normal) {
                    continue;
                }
                self.face_to_plane[f] = index;
                facets.push(face);
                for &neighbour in &neighbours[f] {
                    if neighbour >= 0 {
                        let n = neighbour as usize;
                        if self.face_to_plane[n] == u32::MAX && queued[n] != index + 1 {
                            queued[n] = index + 1;
                            stack.push(neighbour as u32);
                        }
                    }
                }
            }
            facets.sort_unstable();
            self.planes.push(Plane {
                facets,
                normal: seed_normal,
                borders: Vec::new(),
                features: OnceLock::new(),
            });
        }
        for index in 0..self.planes.len() {
            let borders = self.walk_borders(index as u32, neighbours);
            self.planes[index].borders = borders;
        }
    }

    /// Each plane's boundary loops, following boundary half-edges by their
    /// source vertex in first-seen order; a broken loop is dropped.
    fn walk_borders(&self, index: u32, neighbours: &[[i64; 3]]) -> Vec<Vec<V>> {
        let plane = &self.planes[index as usize];
        let mut sources: Vec<u32> = Vec::new();
        let mut outgoing: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for &face in &plane.facets {
            let triangle = self.triangles[face as usize];
            for side in 0..3 {
                let neighbour = neighbours[face as usize][side];
                if neighbour >= 0 && self.face_to_plane[neighbour as usize] == index {
                    continue;
                }
                let (source, target) = (triangle[side], triangle[(side + 1) % 3]);
                outgoing
                    .entry(source)
                    .or_insert_with(|| {
                        sources.push(source);
                        Vec::new()
                    })
                    .push((source, target));
            }
        }
        let mut borders = Vec::new();
        let mut visited: HashSet<(u32, u32)> = HashSet::new();
        let limit = plane.facets.len() * 3 + 1;
        for &start in &sources {
            for &edge in &outgoing[&start] {
                if visited.contains(&edge) {
                    continue;
                }
                let mut loop_: Vec<u32> = Vec::new();
                let mut current = edge;
                let mut guard = 0;
                while guard <= limit {
                    guard += 1;
                    if !visited.insert(current) {
                        break;
                    }
                    loop_.push(current.0);
                    let next = outgoing
                        .get(&current.1)
                        .and_then(|edges| edges.iter().find(|e| !visited.contains(e)).copied());
                    match next {
                        Some(next) => current = next,
                        None => {
                            // Closed when the next hop is the vertex it started from.
                            if current.1 != start {
                                loop_.clear();
                            }
                            break;
                        }
                    }
                }
                if loop_.len() > 1 {
                    borders.push(loop_.iter().map(|&v| self.vertices[v as usize]).collect());
                }
            }
        }
        borders
    }

    /// `extract_features`: border features, then the plane itself, last.
    fn features(&self, index: usize) -> &[Feature] {
        let plane = &self.planes[index];
        plane.features.get_or_init(|| {
            let mut features = Vec::new();
            let normal = normalized(plane.normal);
            for border in &plane.borders {
                if border.len() <= 1 {
                    continue;
                }
                let mut done = false;
                if border.len() > 4
                    && let Some(fit) = fit_circle(border, normal)
                    && fit.error < CIRCLE_FIT_MAX_ERROR
                {
                    let polygon = border.len() <= 8;
                    let lengths_match = (2..border.len()).all(|i| {
                        is_approx(
                            squared_norm(sub(border[i], border[i - 1])),
                            squared_norm(sub(border[i - 1], border[i - 2])),
                            0.01,
                        )
                    });
                    if lengths_match {
                        if polygon {
                            for i in 0..border.len() {
                                features.push(Feature::Edge {
                                    from: border[if i == 0 { border.len() - 1 } else { i - 1 }],
                                    to: border[i],
                                    extra: Some(fit.center),
                                });
                            }
                        } else {
                            features.push(Feature::Circle {
                                center: fit.center,
                                normal: plane.normal,
                                radius: fit.radius,
                            });
                        }
                        done = true;
                    }
                }
                if !done {
                    for i in 1..border.len() {
                        features.push(Feature::Edge {
                            from: border[i - 1],
                            to: border[i],
                            extra: None,
                        });
                    }
                    features.push(Feature::Edge {
                        from: border[0],
                        to: border[border.len() - 1],
                        extra: None,
                    });
                }
            }
            let mut centre = [0.0; 3];
            let mut count = 0usize;
            for point in plane.borders.iter().flatten() {
                centre = add(centre, *point);
                count += 1;
            }
            let origin = if count > 0 {
                scale(centre, 1.0 / count as f64)
            } else {
                self.centroid(&plane.facets)
            };
            features.push(Feature::Plane {
                index: index as u64,
                normal: plane.normal,
                origin,
            });
            features
        })
    }

    fn centroid(&self, facets: &[u32]) -> V {
        let mut sum = [0.0; 3];
        let mut count = 0usize;
        for &face in facets {
            for vertex in self.triangles[face as usize] {
                sum = add(sum, self.vertices[vertex as usize]);
                count += 1;
            }
        }
        if count == 0 {
            [0.0; 3]
        } else {
            scale(sum, 1.0 / count as f64)
        }
    }

    /// `featureAt` (`Measuring::get_feature`): the closest border feature
    /// within the hover limit (an edge's endpoint when the pick is near one),
    /// otherwise the plane itself.
    pub fn feature_at(
        &self,
        face: u64,
        point: V,
        only_plane: bool,
    ) -> Result<Feature, UnknownFace> {
        let plane = *usize::try_from(face)
            .ok()
            .and_then(|face| self.face_to_plane.get(face))
            .ok_or(UnknownFace)?;
        let features = self.features(plane as usize);
        let (plane_feature, borders) = features.split_last().expect("a plane feature");
        if !only_plane {
            let mut closest: Option<&Feature> = None;
            let mut minimum = f64::INFINITY;
            for feature in borders {
                let Some(strict) = measure(feature, &Feature::Point(point)).strict else {
                    continue;
                };
                if strict.distance < FEATURE_HOVER_LIMIT_MM && strict.distance < minimum {
                    minimum = strict.distance;
                    closest = Some(feature);
                }
            }
            if let Some(closest) = closest {
                if let Feature::Edge { from, to, .. } = *closest {
                    let length_sq = squared_norm(sub(to, from));
                    let limit_sq =
                        js_math::max(0.025 * 0.025, js_math::min(0.5 * 0.5, 0.01 * length_sq));
                    if squared_norm(sub(point, from)) < limit_sq {
                        return Ok(Feature::Point(from));
                    }
                    if squared_norm(sub(point, to)) < limit_sq {
                        return Ok(Feature::Point(to));
                    }
                }
                return Ok(*closest);
            }
        }
        Ok(*plane_feature)
    }
}

fn same_normal(a: V, b: V) -> bool {
    (0..3).all(|k| (a[k] - b[k]).abs() < SAME_NORMAL_TOLERANCE)
}

/// `buildFaceNeighbours`: across each side, the one other face sharing that
/// (undirected) edge, or -1 when the edge is open or shared by more.
fn neighbours(triangles: &[[u32; 3]]) -> Vec<[i64; 3]> {
    let mut by_edge: HashMap<(u32, u32), Vec<(u32, usize)>> = HashMap::new();
    for (face, triangle) in triangles.iter().enumerate() {
        for side in 0..3 {
            let (a, b) = (triangle[side], triangle[(side + 1) % 3]);
            by_edge
                .entry(if a < b { (a, b) } else { (b, a) })
                .or_default()
                .push((face as u32, side));
        }
    }
    let mut neighbours = vec![[-1i64; 3]; triangles.len()];
    for entries in by_edge.values() {
        if let [(f0, s0), (f1, s1)] = entries[..] {
            neighbours[f0 as usize][s0] = i64::from(f1);
            neighbours[f1 as usize][s1] = i64::from(f0);
        }
    }
    neighbours
}

struct Fit {
    center: V,
    radius: f64,
    error: f64,
}

/// The browser's algebraic (Kåsa) least-squares circle in the plane's own
/// frame, with the pinned maximum radial deviation as its error.
fn fit_circle(points: &[V], normal: V) -> Option<Fit> {
    if points.len() < 3 {
        return None;
    }
    let unit = normalized(normal);
    let u = orthogonal_unit(unit);
    let v = cross(unit, u);
    let origin = points[0];
    let planar: Vec<(f64, f64)> = points
        .iter()
        .map(|&point| {
            let local = sub(point, origin);
            (dot(local, u), dot(local, v))
        })
        .collect();
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy, mut sxr, mut syr, mut sr) =
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for &(x, y) in &planar {
        let r = x * x + y * y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sxr += x * r;
        syr += y * r;
        sr += r;
    }
    let n = planar.len() as f64;
    let a11 = 2.0 * (sxx - (sx * sx) / n);
    let a12 = 2.0 * (sxy - (sx * sy) / n);
    let a22 = 2.0 * (syy - (sy * sy) / n);
    let b1 = sxr - (sx * sr) / n;
    let b2 = syr - (sy * sr) / n;
    let determinant = a11 * a22 - a12 * a12;
    if !determinant.is_finite() || determinant.abs() < 1e-12 {
        return None;
    }
    let cx = (b1 * a22 - b2 * a12) / determinant;
    let cy = (a11 * b2 - a12 * b1) / determinant;
    let mut radius = 0.0;
    for &(x, y) in &planar {
        radius += js_math::hypot(&[x - cx, y - cy]);
    }
    radius /= n;
    let mut error = 0.0;
    for &(x, y) in &planar {
        error = js_math::max(error, (js_math::hypot(&[x - cx, y - cy]) - radius).abs());
    }
    if !radius.is_finite() || radius <= 0.0 {
        return None;
    }
    Some(Fit {
        center: add(origin, add(scale(u, cx), scale(v, cy))),
        radius,
        error,
    })
}
