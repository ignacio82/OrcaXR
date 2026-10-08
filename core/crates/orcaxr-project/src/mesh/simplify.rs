//! `simplifyMesh` (`simplify.ts`): quadric-error edge collapse after the
//! pinned `QuadricEdgeCollapse.cpp` and `GLGizmoSimplify` controls, with the
//! browser's own binary heap and its (error, vertex pair) tie-break, so the
//! same mesh decimates the same way in every binding.
//!
//! Every expression keeps the browser's evaluation order, and its incident
//! sets keep JavaScript insertion order: a face only ever joins a vertex's set
//! once, so an ordered list stands in for each `Set`. A face without a normal
//! adds no plane but still joins its corners' sets, as upstream references
//! every face, so the collapses that reach it rewrite and remove it.
use crate::js_math;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Configuration {
    /// Drive by triangle count instead of quadric error.
    pub use_count: bool,
    /// Percent of triangles to remove; read when `use_count`.
    pub decimate_ratio: f64,
    /// Maximum quadric error; read when not `use_count`.
    pub max_error: f64,
}

pub struct Simplified {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub source_triangles: usize,
    pub max_applied_error: f64,
    pub stopped_on_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    DegenerateMesh,
    InvalidConfiguration,
}

/// `wantedTriangleCount`: a ratio of 0 keeps everything and 100 asks for
/// nothing, rounding as JavaScript's `Math.round` between.
pub fn wanted_triangle_count(
    triangles: usize,
    ratio: f64,
) -> Result<usize, (Refusal, &'static str)> {
    if !ratio.is_finite() {
        return Err((
            Refusal::InvalidConfiguration,
            "Decimate ratio must be finite",
        ));
    }
    if ratio <= 0.0 {
        return Ok(triangles);
    }
    if ratio >= 100.0 {
        return Ok(0);
    }
    Ok(js_round(triangles as f64 * (100.0 - ratio) / 100.0) as usize)
}

/// `Math.round` for a non-negative value: ties toward +∞.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

type Quadric = [f64; 10];

fn plane_quadric(n: [f64; 3], d: f64) -> Quadric {
    let [a, b, c] = n;
    [
        a * a,
        a * b,
        a * c,
        a * d,
        b * b,
        b * c,
        b * d,
        c * c,
        c * d,
        d * d,
    ]
}

fn add(target: &mut Quadric, source: &Quadric) {
    for (t, s) in target.iter_mut().zip(source) {
        *t += s;
    }
}

fn quadric_error(q: &Quadric, p: [f64; 3]) -> f64 {
    let [x, y, z] = p;
    q[0] * x * x
        + 2.0 * q[1] * x * y
        + 2.0 * q[2] * x * z
        + 2.0 * q[3] * x
        + q[4] * y * y
        + 2.0 * q[5] * y * z
        + 2.0 * q[6] * y
        + q[7] * z * z
        + 2.0 * q[8] * z
        + q[9]
}

/// `optimalPosition`: the quadric's solution, or the best of the endpoints
/// and their midpoint when it is singular.
fn optimal(q: &Quadric, a: [f64; 3], b: [f64; 3]) -> ([f64; 3], f64) {
    let (m11, m12, m13, m22, m23, m33) = (q[0], q[1], q[2], q[4], q[5], q[7]);
    let determinant = m11 * (m22 * m33 - m23 * m23) - m12 * (m12 * m33 - m23 * m13)
        + m13 * (m12 * m23 - m22 * m13);
    if determinant.abs() > 1e-12 {
        let (bx, by, bz) = (-q[3], -q[6], -q[8]);
        let position = [
            (bx * (m22 * m33 - m23 * m23) - m12 * (by * m33 - m23 * bz)
                + m13 * (by * m23 - m22 * bz))
                / determinant,
            (m11 * (by * m33 - bz * m23) - bx * (m12 * m33 - m23 * m13)
                + m13 * (m12 * bz - by * m13))
                / determinant,
            (m11 * (m22 * bz - by * m23) - m12 * (m12 * bz - by * m13)
                + bx * (m12 * m23 - m22 * m13))
                / determinant,
        ];
        return (position, js_math::max(0.0, quadric_error(q, position)));
    }
    let midpoint = [0, 1, 2].map(|k| (a[k] + b[k]) / 2.0);
    let mut best = (a, js_math::max(0.0, quadric_error(q, a)));
    for candidate in [b, midpoint] {
        let error = js_math::max(0.0, quadric_error(q, candidate));
        if error < best.1 {
            best = (candidate, error);
        }
    }
    best
}

#[derive(Clone, Copy)]
struct Candidate {
    a: u32,
    b: u32,
    error: f64,
    position: [f64; 3],
    version_a: u32,
    version_b: u32,
}

/// `candidateBefore`: lowest error first, then the lower vertex pair.
fn before(left: &Candidate, right: &Candidate) -> bool {
    if left.error != right.error {
        return left.error < right.error;
    }
    if left.a != right.a {
        return left.a < right.a;
    }
    left.b < right.b
}

fn heap_push(heap: &mut Vec<Candidate>, candidate: Candidate) {
    heap.push(candidate);
    let mut index = heap.len() - 1;
    while index > 0 {
        let parent = (index - 1) >> 1;
        if !before(&heap[index], &heap[parent]) {
            break;
        }
        heap.swap(index, parent);
        index = parent;
    }
}

fn heap_pop(heap: &mut Vec<Candidate>) -> Option<Candidate> {
    let last = heap.pop()?;
    if heap.is_empty() {
        return Some(last);
    }
    let top = std::mem::replace(&mut heap[0], last);
    let mut index = 0;
    loop {
        let left = index * 2 + 1;
        let right = left + 1;
        let mut smallest = index;
        if left < heap.len() && before(&heap[left], &heap[smallest]) {
            smallest = left;
        }
        if right < heap.len() && before(&heap[right], &heap[smallest]) {
            smallest = right;
        }
        if smallest == index {
            break;
        }
        heap.swap(index, smallest);
        index = smallest;
    }
    Some(top)
}

fn normal_of(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<[f64; 3]> {
    let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    let size = js_math::hypot(&n);
    if !size.is_finite() || size == 0.0 {
        return None;
    }
    Some(n.map(|v| v / size))
}

/// Decimate; `cancelled` is polled every 256 collapses tried.
pub fn simplify(
    source_vertices: &[[f64; 3]],
    source_triangles: &[[u32; 3]],
    configuration: Configuration,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Simplified, Option<(Refusal, &'static str)>> {
    // `assertSimplifyConfiguration`.
    if !configuration.decimate_ratio.is_finite() {
        return Err(Some((
            Refusal::InvalidConfiguration,
            "Decimate ratio must be finite",
        )));
    }
    if !configuration.use_count
        && (configuration.max_error.is_nan() || configuration.max_error <= 0.0)
    {
        return Err(Some((
            Refusal::InvalidConfiguration,
            "Maximum error must be greater than zero",
        )));
    }
    let count = source_triangles.len();
    if count == 0 {
        return Err(Some((
            Refusal::DegenerateMesh,
            "A mesh with no facets cannot be simplified",
        )));
    }
    let target = if configuration.use_count {
        wanted_triangle_count(count, configuration.decimate_ratio).map_err(Some)?
    } else {
        0
    };
    let max_error = if configuration.use_count {
        f64::INFINITY
    } else {
        configuration.max_error
    };
    if configuration.use_count && target >= count {
        return Ok(Simplified {
            vertices: source_vertices.to_vec(),
            triangles: source_triangles.to_vec(),
            source_triangles: count,
            max_applied_error: 0.0,
            stopped_on_error: false,
        });
    }

    let mut vertices = source_vertices.to_vec();
    let mut triangles = source_triangles.to_vec();
    let mut removed_triangle = vec![false; triangles.len()];
    let mut removed_vertex = vec![false; vertices.len()];
    let mut version = vec![0u32; vertices.len()];
    let mut quadrics = vec![[0.0f64; 10]; vertices.len()];
    let mut incident: Vec<Vec<u32>> = vec![Vec::new(); vertices.len()];
    for (index, triangle) in triangles.iter().enumerate() {
        // Every face joins its corners' sets, once per distinct corner.
        for (k, &vertex) in triangle.iter().enumerate() {
            if !triangle[..k].contains(&vertex) {
                incident[vertex as usize].push(index as u32);
            }
        }
        let corner = |k: usize| vertices[triangle[k] as usize];
        let Some(normal) = normal_of(corner(0), corner(1), corner(2)) else {
            continue;
        };
        let first = corner(0);
        let offset = -(normal[0] * first[0] + normal[1] * first[1] + normal[2] * first[2]);
        let q = plane_quadric(normal, offset);
        for &vertex in triangle {
            add(&mut quadrics[vertex as usize], &q);
        }
    }

    let mut heap: Vec<Candidate> = Vec::new();
    let push_edge = |heap: &mut Vec<Candidate>,
                     quadrics: &[Quadric],
                     vertices: &[[f64; 3]],
                     removed: &[bool],
                     version: &[u32],
                     a: u32,
                     b: u32| {
        let (ia, ib) = (a as usize, b as usize);
        if a == b || removed[ia] || removed[ib] {
            return;
        }
        let mut combined = quadrics[ia];
        add(&mut combined, &quadrics[ib]);
        let (position, error) = optimal(&combined, vertices[ia], vertices[ib]);
        heap_push(
            heap,
            Candidate {
                a,
                b,
                error,
                position,
                version_a: version[ia],
                version_b: version[ib],
            },
        );
    };
    for triangle in &triangles {
        for side in 0..3 {
            let (a, b) = (triangle[side], triangle[(side + 1) % 3]);
            if a < b {
                push_edge(
                    &mut heap,
                    &quadrics,
                    &vertices,
                    &removed_vertex,
                    &version,
                    a,
                    b,
                );
            }
        }
    }

    let mut live = triangles.len();
    let mut max_applied = 0.0f64;
    let mut stopped_on_error = false;
    let mut iterations = 0u64;
    let mut neighbours: Vec<u32> = Vec::new();
    let mut seen = vec![false; vertices.len()];
    while live > target {
        let Some(candidate) = heap_pop(&mut heap) else {
            break;
        };
        iterations += 1;
        if iterations.is_multiple_of(256) && cancelled() {
            return Err(None);
        }
        let (a, b) = (candidate.a as usize, candidate.b as usize);
        if removed_vertex[a] || removed_vertex[b] {
            continue;
        }
        if candidate.version_a != version[a] || candidate.version_b != version[b] {
            continue;
        }
        if candidate.error >= max_error {
            stopped_on_error = true;
            break;
        }
        if would_flip(
            &vertices,
            &triangles,
            &removed_triangle,
            &incident,
            candidate,
        ) {
            continue;
        }
        // Collapse b into a.
        vertices[a] = candidate.position;
        let qb = quadrics[b];
        add(&mut quadrics[a], &qb);
        removed_vertex[b] = true;
        version[a] += 1;
        let moved = std::mem::take(&mut incident[b]);
        for index in moved {
            let i = index as usize;
            if removed_triangle[i] {
                continue;
            }
            let triangle = &mut triangles[i];
            for corner in triangle.iter_mut() {
                if *corner == candidate.b {
                    *corner = candidate.a;
                }
            }
            if triangle[0] == triangle[1]
                || triangle[1] == triangle[2]
                || triangle[0] == triangle[2]
            {
                removed_triangle[i] = true;
                live -= 1;
                continue;
            }
            debug_assert!(!incident[a].contains(&index));
            incident[a].push(index);
        }
        max_applied = js_math::max(max_applied, candidate.error);

        // Re-price every edge still touching the merged vertex.
        neighbours.clear();
        for &index in &incident[a] {
            if removed_triangle[index as usize] {
                continue;
            }
            for vertex in triangles[index as usize] {
                let v = vertex as usize;
                if vertex != candidate.a && !removed_vertex[v] && !seen[v] {
                    seen[v] = true;
                    neighbours.push(vertex);
                }
            }
        }
        for &neighbour in &neighbours {
            seen[neighbour as usize] = false;
            version[neighbour as usize] += 1;
            push_edge(
                &mut heap,
                &quadrics,
                &vertices,
                &removed_vertex,
                &version,
                candidate.a.min(neighbour),
                candidate.a.max(neighbour),
            );
        }
    }

    // Compact, keeping the surviving order.
    let mut remap = vec![u32::MAX; vertices.len()];
    let mut out_vertices = Vec::new();
    let mut out_triangles = Vec::new();
    for (index, triangle) in triangles.iter().enumerate() {
        if removed_triangle[index] {
            continue;
        }
        out_triangles.push(triangle.map(|vertex| {
            let v = vertex as usize;
            if remap[v] == u32::MAX {
                remap[v] = out_vertices.len() as u32;
                out_vertices.push(vertices[v]);
            }
            remap[v]
        }));
    }
    if out_triangles.is_empty() {
        return Err(Some((
            Refusal::DegenerateMesh,
            "Simplification would remove every facet",
        )));
    }
    Ok(Simplified {
        vertices: out_vertices,
        triangles: out_triangles,
        source_triangles: count,
        max_applied_error: max_applied,
        stopped_on_error,
    })
}

/// `wouldFlip`: a surviving face around either endpoint would lose its
/// normal or turn against it.
fn would_flip(
    vertices: &[[f64; 3]],
    triangles: &[[u32; 3]],
    removed: &[bool],
    incident: &[Vec<u32>],
    candidate: Candidate,
) -> bool {
    let (a, b) = (candidate.a, candidate.b);
    for vertex in [a, b] {
        for &index in &incident[vertex as usize] {
            if removed[index as usize] {
                continue;
            }
            let triangle = triangles[index as usize];
            if triangle.contains(&a) && triangle.contains(&b) {
                continue;
            }
            let corner = |v: u32| vertices[v as usize];
            let Some(before) = normal_of(
                corner(triangle[0]),
                corner(triangle[1]),
                corner(triangle[2]),
            ) else {
                continue;
            };
            let moved = triangle.map(|v| {
                if v == a || v == b {
                    candidate.position
                } else {
                    corner(v)
                }
            });
            let Some(after) = normal_of(moved[0], moved[1], moved[2]) else {
                return true;
            };
            if before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0.0 {
                return true;
            }
        }
    }
    false
}
