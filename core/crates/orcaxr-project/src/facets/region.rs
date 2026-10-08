//! Facet region selection on source facets (`FacetRegionSelection.ts`, the
//! pinned Snapmaker Orca `TriangleSelector`): topological face neighbours,
//! Triangle, state-aware bucket Fill with the smart-fill angle and clipping,
//! Height Range and Gap Fill. Requests are validated with the browser's issue
//! codes, paths, messages and order.
//!
//! Upstream computes in Eigen `Vec3f`; the browser reproduces that in doubles
//! with explicit `Math.fround`. This port mirrors the browser operation by
//! operation — every value is an `f64` holding a float32 — so thresholds land
//! on the same side. `Math.cos` is the fdlibm port.
//!
//! Brushes (Circle, Sphere) and refined (subdivided) selection are not ported
//! yet; a request that needs them is refused with [`RegionError::Unsupported`].
use super::validation::Issue;
use super::{Channel, PaintValue};
use crate::js_math;

pub const TRIANGLE_SELECTOR_EPSILON: f64 = 1e-4;
pub const SMART_FILL_ANGLE_MIN_DEGREES: f64 = 0.0;
pub const SMART_FILL_ANGLE_MAX_DEGREES: f64 = 90.0;
pub const HEIGHT_RANGE_MIN_MM: f64 = 0.1;
pub const HEIGHT_RANGE_MAX_MM: f64 = 8.0;
pub const GAP_AREA_MIN_MM2: f64 = 0.0;
pub const GAP_AREA_MAX_MM2: f64 = 5.0;
pub const OVERHANG_ANGLE_MIN_DEGREES: f64 = 0.0;
pub const OVERHANG_ANGLE_MAX_DEGREES: f64 = 90.0;

pub type Vec3 = [f64; 3];

/// Volume-local vertices and triangles, as decoded from a mesh asset.
#[derive(Debug, Clone, Copy)]
pub struct Mesh<'a> {
    pub vertices: &'a [Vec3],
    /// Vertex indices; host input, so validated like the browser's numbers.
    pub triangles: &'a [[f64; 3]],
}

/// `normal · point − offset > 0` clips; points on the plane stay live.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClippingPlane {
    pub normal: Vec3,
    pub offset: f64,
}

/// Row-major linear part, translation and the exact absolute scaling factors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub linear: [Vec3; 3],
    pub translation: Vec3,
    pub scaling_factors: Vec3,
}
pub const IDENTITY: Transform = Transform {
    linear: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    translation: [0.0; 3],
    scaling_factors: [1.0; 3],
};

#[derive(Debug, Clone, PartialEq)]
pub enum Tool {
    Triangle {
        hit: Option<Vec3>,
    },
    Fill {
        hit: Option<Vec3>,
        /// The smart-fill maximum adjacent angle, when edge detection is on.
        edge_detection: Option<f64>,
    },
    HeightRange {
        start_z_mm: f64,
        height_mm: f64,
        triangle_splitting: Option<bool>,
    },
    GapFill {
        max_area_mm2: f64,
        /// Assigned states in pinned order; unpainted is implicit state zero.
        state_order: Vec<PaintValue>,
    },
    /// Circle or Sphere: not ported yet.
    Brush,
}

/// One channel's assignments as canonical state stores them.
#[derive(Debug, Clone, PartialEq)]
pub struct Assignment {
    pub value: PaintValue,
    pub triangles: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub mesh: Mesh<'a>,
    pub channel: Channel,
    /// The annotations' own topology revision and the channel's assignments.
    pub annotations_topology_revision: f64,
    pub assignments: &'a [Assignment],
    pub guard_topology_revision: f64,
    pub guard_triangle_count: f64,
    pub seed_triangle: f64,
    pub tool: Tool,
    pub clipping_plane: Option<ClippingPlane>,
    pub transform: Option<Transform>,
    pub highlight_by_angle_degrees: Option<f64>,
    /// The request carries prior refinement or dense refined roots: refined
    /// selection, not ported yet. Canonical annotations are admitted state, so
    /// only the selected channel is re-checked here.
    pub refined: bool,
}

/// `{ kind: 'unpainted' }` or `{ kind: 'assigned', value }`.
#[derive(Debug, Clone, PartialEq)]
pub enum RegionState {
    Unpainted,
    Assigned(PaintValue),
}

#[derive(Debug, Clone, PartialEq)]
pub struct GapFillReplacement {
    pub area_mm2: f64,
    pub source: RegionState,
    pub target: RegionState,
    /// In connected-component (breadth-first) order, as the browser reports.
    pub triangle_indices: Vec<u32>,
    pub ranges: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub triangle_indices: Vec<u32>,
    /// `[start, endExclusive)` runs.
    pub ranges: Vec<(u32, u32)>,
    pub gap_fill_replacements: Option<Vec<GapFillReplacement>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RegionError {
    /// `FacetAnnotationValidationError` with the browser's issues.
    Invalid(Vec<Issue>),
    /// `StaleFacetAnnotationResultError('topology')`.
    StaleTopology,
    /// Brushes and refined selection are not ported yet.
    Unsupported,
}

/// `buildOrcaFaceNeighbors`: `its_face_neighbors` from the pinned revision.
/// Connectivity is topological — two faces share the same vertex indices in
/// opposite winding — and a non-manifold edge pairs the first still-unpaired
/// later face.
pub fn face_neighbors(mesh: Mesh<'_>) -> Result<Vec<[i64; 3]>, RegionError> {
    let issues = mesh_issues(mesh);
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    Ok(validated_neighbors(mesh))
}

/// `selectFacetRegion` for source facets.
pub fn select(request: &Request<'_>) -> Result<Selection, RegionError> {
    if request.refined || matches!(request.tool, Tool::Brush) {
        return Err(RegionError::Unsupported);
    }
    if let Tool::HeightRange {
        triangle_splitting: Some(true),
        ..
    } = request.tool
    {
        return Err(RegionError::Unsupported);
    }
    let issues = request_issues(request);
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    let issues = mesh_issues(request.mesh);
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    if request.annotations_topology_revision != request.guard_topology_revision
        || request.mesh.triangles.len() as f64 != request.guard_triangle_count
    {
        return Err(RegionError::StaleTopology);
    }
    let issues = annotation_issues(request);
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    let count = request.mesh.triangles.len();
    let seed = request.seed_triangle as usize;
    match &request.tool {
        Tool::Triangle { .. } => Ok(selection(vec![seed as u32], count)),
        Tool::Fill { edge_detection, .. } => Ok(fill(request, seed, *edge_detection)),
        Tool::HeightRange {
            start_z_mm,
            height_mm,
            ..
        } => Ok(height_range(request, *start_z_mm, *height_mm)),
        Tool::GapFill {
            max_area_mm2,
            state_order,
        } => Ok(gap_fill(request, *max_area_mm2, state_order)),
        Tool::Brush => Err(RegionError::Unsupported),
    }
}

fn fill(request: &Request<'_>, seed: usize, edge_detection: Option<f64>) -> Selection {
    let mesh = request.mesh;
    let count = mesh.triangles.len();
    let neighbors = validated_neighbors(mesh);
    let states = facet_states(request.assignments, count);
    let normals: Option<Vec<Vec3>> = edge_detection.map(|_| {
        mesh.triangles
            .iter()
            .map(|t| face_normal(mesh.vertices, t))
            .collect()
    });
    let angle_limit =
        edge_detection.map(|degrees| cos_degrees(degrees) - TRIANGLE_SELECTOR_EPSILON);
    let mut visited = vec![false; count];
    let mut selected = vec![false; count];
    let mut queue = vec![seed];
    let mut head = 0;
    let seed_state = states[seed].clone();
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        if visited[current] {
            continue;
        }
        selected[current] = true;
        for &neighbor in &neighbors[current] {
            if neighbor < 0 {
                continue;
            }
            let neighbor = neighbor as usize;
            if visited[neighbor]
                || states[neighbor] != seed_state
                || facet_clipped(mesh, neighbor, request.clipping_plane.as_ref())
            {
                continue;
            }
            if let (Some(normals), Some(limit)) = (&normals, angle_limit) {
                let d = dot(&normals[neighbor], &normals[current]).clamp(0.0, 1.0);
                if d < limit {
                    continue;
                }
            }
            queue.push(neighbor);
        }
        visited[current] = true;
    }
    selection(flagged(&selected), count)
}

fn height_range(request: &Request<'_>, start_z_mm: f64, height_mm: f64) -> Selection {
    let mesh = request.mesh;
    let transform = request.transform.unwrap_or(IDENTITY);
    let filter = overhang_filter(request);
    let start = fr(start_z_mm);
    let height = fr(height_mm);
    let bottom = fr(start - TRIANGLE_SELECTOR_EPSILON);
    let top = fr(fr(start + height) + TRIANGLE_SELECTOR_EPSILON);
    let mut indices = Vec::new();
    for (index, triangle) in mesh.triangles.iter().enumerate() {
        let z = triangle.map(|v| transform_point(&transform, &mesh.vertices[v as usize])[2]);
        let below = z.iter().all(|&z| z < bottom);
        let above = z.iter().all(|&z| z > top);
        if !below && !above && passes_overhang(mesh, index, filter.as_ref()) {
            indices.push(index as u32);
        }
    }
    selection(indices, mesh.triangles.len())
}

fn gap_fill(request: &Request<'_>, max_area_mm2: f64, order: &[PaintValue]) -> Selection {
    let mesh = request.mesh;
    let count = mesh.triangles.len();
    let neighbors = validated_neighbors(mesh);
    let states = facet_states(request.assignments, count);
    // State zero is unpainted; the rest follow the pinned order.
    let index_of = |state: &Option<PaintValue>| match state {
        None => 0,
        Some(value) => order.iter().position(|o| o == value).map_or(0, |i| i + 1),
    };
    let state_index: Vec<usize> = states.iter().map(index_of).collect();
    let threshold = fr(max_area_mm2);
    let mut visited = vec![false; count];
    let mut changed = vec![false; count];
    let mut replacements = Vec::new();
    for start in 0..count {
        if visited[start] {
            continue;
        }
        let source = state_index[start];
        let mut queue = vec![start];
        let mut component: Vec<usize> = Vec::new();
        let mut neighbor_states = std::collections::BTreeSet::new();
        let mut head = 0;
        while head < queue.len() {
            let current = queue[head];
            head += 1;
            if visited[current] {
                continue;
            }
            component.push(current);
            for &neighbor in &neighbors[current] {
                if neighbor < 0 {
                    continue;
                }
                let neighbor = neighbor as usize;
                let neighbor_state = state_index[neighbor];
                if neighbor_state != source {
                    // Pinned code records neighbour states before checking visited.
                    neighbor_states.insert(neighbor_state);
                } else if !visited[neighbor] {
                    queue.push(neighbor);
                }
            }
            visited[current] = true;
        }
        let area = gap_patch_area(mesh, &component);
        let Some(&target) = neighbor_states.first() else {
            continue;
        };
        if area >= threshold {
            continue;
        }
        let state = |index: usize| {
            if index == 0 {
                RegionState::Unpainted
            } else {
                RegionState::Assigned(order[index - 1].clone())
            }
        };
        for &triangle in &component {
            changed[triangle] = true;
        }
        let indices: Vec<u32> = component.iter().map(|&t| t as u32).collect();
        let ranges = ranges(&indices);
        replacements.push(GapFillReplacement {
            area_mm2: area,
            source: state(source),
            target: state(target),
            triangle_indices: indices,
            ranges,
        });
    }
    let mut result = selection(flagged(&changed), count);
    result.gap_fill_replacements = Some(replacements);
    result
}

/// `orcaGapPatchArea`: halved cross-product norms accumulated in double,
/// capped at the UI maximum rather than the live threshold.
fn gap_patch_area(mesh: Mesh<'_>, triangles: &[usize]) -> f64 {
    let mut total = 0.0;
    for &index in triangles {
        let [a, b, c] = mesh.triangles[index].map(|v| float_vector(&mesh.vertices[v as usize]));
        let doubled = norm(&cross(&sub(&a, &b), &sub(&a, &c)));
        total += fr(doubled / fr(2.0));
        if total >= GAP_AREA_MAX_MM2 {
            break;
        }
    }
    fr(total)
}

struct OverhangFilter {
    world_normal_z_limit: f64,
    normal_matrix: [Vec3; 3],
}
fn overhang_filter(request: &Request<'_>) -> Option<OverhangFilter> {
    let angle = request.highlight_by_angle_degrees.unwrap_or(0.0);
    // This equality check, rather than <=, is pinned in select_patch().
    if angle == 0.0 {
        return None;
    }
    let transform = request.transform.unwrap_or(IDENTITY);
    Some(OverhangFilter {
        world_normal_z_limit: fr(-cos_degrees(angle)),
        normal_matrix: inverse_transpose_double_then_float(&transform.linear),
    })
}
fn passes_overhang(mesh: Mesh<'_>, triangle: usize, filter: Option<&OverhangFilter>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    let local = face_normal(mesh.vertices, &mesh.triangles[triangle]);
    let world = normalize(&multiply_matrix_vector(&filter.normal_matrix, &local));
    world[2] < filter.world_normal_z_limit
}

fn facet_states(assignments: &[Assignment], count: usize) -> Vec<Option<PaintValue>> {
    let mut states = vec![None; count];
    for assignment in assignments {
        for &triangle in &assignment.triangles {
            states[triangle as usize] = Some(assignment.value.clone());
        }
    }
    states
}

fn flagged(flags: &[bool]) -> Vec<u32> {
    flags
        .iter()
        .enumerate()
        .filter(|(_, f)| **f)
        .map(|(i, _)| i as u32)
        .collect()
}

/// `selectionFromIndices`: indices as given, ranges from their sorted set.
fn selection(indices: Vec<u32>, _count: usize) -> Selection {
    let ranges = ranges(&indices);
    Selection {
        triangle_indices: indices,
        ranges,
        gap_fill_replacements: None,
    }
}

/// `triangleRangesFromIndices` for in-range indices.
pub fn ranges(indices: &[u32]) -> Vec<(u32, u32)> {
    let mut sorted = indices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for triangle in sorted {
        match out.last_mut() {
            Some(range) if range.1 == triangle => range.1 += 1,
            _ => out.push((triangle, triangle + 1)),
        }
    }
    out
}

fn validated_neighbors(mesh: Mesh<'_>) -> Vec<[i64; 3]> {
    let triangles: Vec<[usize; 3]> = mesh
        .triangles
        .iter()
        .map(|t| t.map(|v| v as usize))
        .collect();
    let mut vertex_faces = vec![Vec::new(); mesh.vertices.len()];
    for (face, triangle) in triangles.iter().enumerate() {
        for &vertex in triangle {
            vertex_faces[vertex].push(face);
        }
    }
    let mut neighbors = vec![[-1i64; 3]; triangles.len()];
    for (face, triangle) in triangles.iter().enumerate() {
        for edge in 0..3 {
            if neighbors[face][edge] != -1 {
                continue;
            }
            let first = triangle[edge];
            let second = triangle[(edge + 1) % 3];
            for &other_face in &vertex_faces[first] {
                if other_face <= face {
                    continue;
                }
                let other = &triangles[other_face];
                let Some(second_index) = other.iter().position(|&v| v == second) else {
                    continue;
                };
                if other[(second_index + 1) % 3] != first
                    || neighbors[other_face][second_index] != -1
                {
                    continue;
                }
                neighbors[face][edge] = other_face as i64;
                neighbors[other_face][second_index] = face as i64;
                break;
            }
        }
    }
    neighbors
}

fn facet_clipped(mesh: Mesh<'_>, triangle: usize, plane: Option<&ClippingPlane>) -> bool {
    let Some(plane) = plane else {
        return false;
    };
    mesh.triangles[triangle]
        .iter()
        .any(|&v| point_clipped(&mesh.vertices[v as usize], plane))
}
fn point_clipped(point: &Vec3, plane: &ClippingPlane) -> bool {
    sub1(
        dot(&float_vector(&plane.normal), &float_vector(point)),
        plane.offset,
    ) > 0.0
}

// --- Validation -----------------------------------------------------------

fn request_issues(request: &Request<'_>) -> Vec<Issue> {
    let mut issues = Vec::new();
    let guard_ok = safe_integer(request.guard_topology_revision)
        && request.guard_topology_revision >= 0.0
        && safe_integer(request.guard_triangle_count)
        && request.guard_triangle_count >= 0.0;
    if !guard_ok {
        issues.push(Issue::new(
            "invalid-facet-selection-guard",
            "guard",
            "Topology revision and triangle count must be non-negative safe integers",
        ));
    }
    if !matches!(request.tool, Tool::GapFill { .. })
        && (!safe_integer(request.seed_triangle)
            || request.seed_triangle < 0.0
            || request.seed_triangle >= request.guard_triangle_count)
    {
        issues.push(Issue::new(
            "invalid-seed-triangle",
            "seedTriangle",
            format!(
                "Seed triangle must be in [0, {}]",
                js_number(request.guard_triangle_count - 1.0)
            ),
        ));
    }
    if let Some(angle) = request.highlight_by_angle_degrees
        && (!angle.is_finite()
            || !(OVERHANG_ANGLE_MIN_DEGREES..=OVERHANG_ANGLE_MAX_DEGREES).contains(&angle))
    {
        issues.push(Issue::new(
            "invalid-overhang-highlight-angle",
            "highlightByAngleDegrees",
            "Overhang highlight angle must be finite and in [0, 90] degrees",
        ));
    }
    let hit_issue = |hit: &Option<Vec3>, issues: &mut Vec<Issue>| {
        if let Some(hit) = hit
            && !finite_float_vector(hit)
        {
            issues.push(Issue::new(
                "invalid-refinement-hit",
                "tool.hit",
                "Refinement hit must contain three finite float32 coordinates",
            ));
        }
    };
    match &request.tool {
        Tool::Fill {
            hit,
            edge_detection,
        } => {
            hit_issue(hit, &mut issues);
            if let Some(angle) = edge_detection
                && (!angle.is_finite()
                    || !(SMART_FILL_ANGLE_MIN_DEGREES..=SMART_FILL_ANGLE_MAX_DEGREES)
                        .contains(angle))
            {
                issues.push(Issue::new(
                    "invalid-smart-fill-angle",
                    "tool.edgeDetection.maxAdjacentAngleDegrees",
                    "Smart-fill angle must be finite and in [0, 90] degrees",
                ));
            }
        }
        Tool::HeightRange {
            start_z_mm,
            height_mm,
            ..
        } => {
            if !finite_float(*start_z_mm) {
                issues.push(Issue::new(
                    "invalid-height-range-start",
                    "tool.startZMm",
                    "Height-range start Z must be a finite float32 value",
                ));
            }
            if !height_mm.is_finite()
                || !(HEIGHT_RANGE_MIN_MM..=HEIGHT_RANGE_MAX_MM).contains(height_mm)
            {
                issues.push(Issue::new(
                    "invalid-height-range-height",
                    "tool.heightMm",
                    "Height range must be finite and in [0.1, 8] mm",
                ));
            }
            if finite_float(*start_z_mm)
                && height_mm.is_finite()
                && !fr(fr(*start_z_mm) + fr(*height_mm)).is_finite()
            {
                issues.push(Issue::new(
                    "invalid-height-range-bounds",
                    "tool",
                    "Height-range bounds must remain finite in float32 arithmetic",
                ));
            }
        }
        Tool::GapFill {
            max_area_mm2,
            state_order,
        } => {
            if !max_area_mm2.is_finite()
                || !(GAP_AREA_MIN_MM2..=GAP_AREA_MAX_MM2).contains(max_area_mm2)
            {
                issues.push(Issue::new(
                    "invalid-gap-fill-area",
                    "tool.maxAreaMm2",
                    "Gap Fill area must be finite and in [0, 5] mm²",
                ));
            }
            let mut seen: Vec<&PaintValue> = Vec::new();
            for (index, state) in state_order.iter().enumerate() {
                let path = format!("tool.stateOrder[{index}]");
                if !channel_value(request.channel, state) {
                    issues.push(Issue::new(
                        "invalid-gap-fill-state",
                        path,
                        format!(
                            "Gap Fill state is invalid for the {} channel",
                            request.channel.name()
                        ),
                    ));
                    continue;
                }
                if seen.contains(&state) {
                    issues.push(Issue::new(
                        "duplicate-gap-fill-state",
                        path,
                        "Gap Fill state order must not contain duplicate values",
                    ));
                }
                seen.push(state);
            }
            for (index, assignment) in request.assignments.iter().enumerate() {
                if !seen.contains(&&assignment.value) {
                    issues.push(Issue::new(
                        "missing-gap-fill-state",
                        format!("{}[{index}].value", request.channel.name()),
                        "Every assigned facet state must have a pinned numeric position in tool.stateOrder",
                    ));
                }
            }
        }
        Tool::Triangle { hit } => hit_issue(hit, &mut issues),
        Tool::Brush => {}
    }
    if let Some(plane) = &request.clipping_plane
        && (!finite_float_vector(&plane.normal)
            || !finite_float(plane.offset)
            || squared_norm(&float_vector(&plane.normal)) == 0.0)
    {
        issues.push(Issue::new(
            "invalid-facet-clipping-plane",
            "clippingPlane",
            "Clipping plane must have a non-zero finite float32 normal and finite float32 offset",
        ));
    }
    if let Some(transform) = &request.transform
        && !transform_valid(transform)
    {
        issues.push(Issue::new(
            "invalid-facet-selection-transform",
            "transform",
            "Facet selection transform must be finite, invertible, and have positive scaling factors",
        ));
    }
    issues
}

fn transform_valid(transform: &Transform) -> bool {
    let shape = transform.linear.iter().all(finite_float_vector)
        && finite_float_vector(&transform.translation)
        && transform
            .scaling_factors
            .iter()
            .all(|f| f.is_finite() && *f > 0.0);
    if !shape {
        return false;
    }
    let determinant = determinant(&transform.linear);
    determinant != 0.0
        && determinant.is_finite()
        && inverse_transpose(&transform.linear)
            .iter()
            .all(finite_float_vector)
}

fn mesh_issues(mesh: Mesh<'_>) -> Vec<Issue> {
    let mut issues = Vec::new();
    for (index, vertex) in mesh.vertices.iter().enumerate() {
        if !finite_float_vector(vertex) {
            issues.push(Issue::new(
                "invalid-facet-mesh-vertex",
                format!("mesh.vertices[{index}]"),
                "Facet mesh vertices must contain three finite float32 coordinates",
            ));
        }
    }
    let vertices = mesh.vertices.len() as f64;
    for (index, triangle) in mesh.triangles.iter().enumerate() {
        if triangle
            .iter()
            .any(|&v| !safe_integer(v) || v < 0.0 || v >= vertices)
        {
            issues.push(Issue::new(
                "invalid-facet-mesh-triangle",
                format!("mesh.triangles[{index}]"),
                "Facet mesh triangles must contain three in-range vertex indices",
            ));
        }
    }
    issues
}

/// `validateFacetAnnotations` for the selected channel's assignments.
fn annotation_issues(request: &Request<'_>) -> Vec<Issue> {
    let name = request.channel.name();
    let count = request.guard_triangle_count;
    let mut issues = Vec::new();
    let mut seen = vec![false; count as usize];
    for (index, assignment) in request.assignments.iter().enumerate() {
        if !channel_value(request.channel, &assignment.value) {
            issues.push(Issue::new(
                "invalid-facet-value",
                format!("{name}[{index}].value"),
                format!("Invalid {name} annotation value"),
            ));
        }
        for (t, &triangle) in assignment.triangles.iter().enumerate() {
            if triangle.fract() != 0.0 || triangle < 0.0 || triangle >= count {
                issues.push(Issue::new(
                    "facet-index-out-of-range",
                    format!("{name}[{index}].triangles[{t}]"),
                    format!("Triangle must be in [0, {}]", js_number(count - 1.0)),
                ));
                continue;
            }
            let slot = &mut seen[triangle as usize];
            if *slot {
                issues.push(Issue::new(
                    "duplicate-facet-assignment",
                    format!("{name}[{index}].triangles[{t}]"),
                    format!(
                        "Triangle {} is assigned twice in {name}",
                        js_number(triangle)
                    ),
                ));
            }
            *slot = true;
        }
    }
    issues
}

fn channel_value(channel: Channel, value: &PaintValue) -> bool {
    match (channel, value) {
        (Channel::Color, PaintValue::Text(_)) => true,
        (Channel::Support, PaintValue::Text(t)) => units_eq(t, "enforce") || units_eq(t, "block"),
        (Channel::Seam, PaintValue::Text(t)) => units_eq(t, "prefer") || units_eq(t, "avoid"),
        (Channel::FuzzySkin, PaintValue::Bool(b)) => *b,
        (Channel::Brim, PaintValue::Bool(_)) => true,
        _ => false,
    }
}
fn units_eq(units: &[u16], text: &str) -> bool {
    units.iter().copied().eq(text.encode_utf16())
}

fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
use crate::js_math::convert::number_to_string as js_number;

// --- Float32 arithmetic, as the browser writes it ----------------------------

/// `Math.fround`.
fn fr(value: f64) -> f64 {
    value as f32 as f64
}
fn finite_float(value: f64) -> bool {
    value.is_finite() && fr(value).is_finite()
}
fn finite_float_vector(vector: &Vec3) -> bool {
    vector.iter().all(|&v| finite_float(v))
}
fn float_vector(vector: &Vec3) -> Vec3 {
    vector.map(fr)
}
fn mul(a: f64, b: f64) -> f64 {
    fr(fr(a) * fr(b))
}
fn add1(a: f64, b: f64) -> f64 {
    fr(fr(a) + fr(b))
}
fn sub1(a: f64, b: f64) -> f64 {
    fr(fr(a) - fr(b))
}
fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [sub1(a[0], b[0]), sub1(a[1], b[1]), sub1(a[2], b[2])]
}
fn dot(a: &Vec3, b: &Vec3) -> f64 {
    add1(add1(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]))
}
fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        sub1(mul(a[1], b[2]), mul(a[2], b[1])),
        sub1(mul(a[2], b[0]), mul(a[0], b[2])),
        sub1(mul(a[0], b[1]), mul(a[1], b[0])),
    ]
}
fn squared_norm(v: &Vec3) -> f64 {
    dot(v, v)
}
fn norm(v: &Vec3) -> f64 {
    fr(squared_norm(v).sqrt())
}
fn normalize(v: &Vec3) -> Vec3 {
    let squared = add1(add1(mul(v[0], v[0]), mul(v[1], v[1])), mul(v[2], v[2]));
    let length = fr(squared.sqrt());
    [fr(v[0] / length), fr(v[1] / length), fr(v[2] / length)]
}
/// `orcaFaceNormal`: upstream normalizes twice.
fn face_normal(vertices: &[Vec3], triangle: &[f64; 3]) -> Vec3 {
    let [a, b, c] = triangle.map(|v| vertices[v as usize]);
    let u = sub(&b, &a);
    let v = sub(&c, &b);
    normalize(&normalize(&cross(&u, &v)))
}
fn cos_degrees(degrees: f64) -> f64 {
    let radians = fr(mul(fr(std::f64::consts::PI), fr(degrees)) / fr(180.0));
    fr(js_math::cos(radians))
}
fn transform_point(transform: &Transform, point: &Vec3) -> Vec3 {
    let p = float_vector(point);
    [0, 1, 2].map(|row| {
        add1(
            dot(&float_vector(&transform.linear[row]), &p),
            transform.translation[row],
        )
    })
}
fn multiply_matrix_vector(matrix: &[Vec3; 3], vector: &Vec3) -> Vec3 {
    let v = float_vector(vector);
    [
        dot(&matrix[0], &v),
        dot(&matrix[1], &v),
        dot(&matrix[2], &v),
    ]
}
fn cofactors(first: &Vec3, second: &Vec3, third: &Vec3) -> [Vec3; 3] {
    [
        [
            sub1(mul(second[1], third[2]), mul(second[2], third[1])),
            sub1(mul(second[2], third[0]), mul(second[0], third[2])),
            sub1(mul(second[0], third[1]), mul(second[1], third[0])),
        ],
        [
            sub1(mul(first[2], third[1]), mul(first[1], third[2])),
            sub1(mul(first[0], third[2]), mul(first[2], third[0])),
            sub1(mul(first[1], third[0]), mul(first[0], third[1])),
        ],
        [
            sub1(mul(first[1], second[2]), mul(first[2], second[1])),
            sub1(mul(first[2], second[0]), mul(first[0], second[2])),
            sub1(mul(first[0], second[1]), mul(first[1], second[0])),
        ],
    ]
}
fn determinant(matrix: &[Vec3; 3]) -> f64 {
    let [first, second, third] = matrix.map(|row| float_vector(&row));
    dot(&first, &cofactors(&first, &second, &third)[0])
}
fn inverse_transpose(matrix: &[Vec3; 3]) -> [Vec3; 3] {
    let [first, second, third] = matrix.map(|row| float_vector(&row));
    let det = determinant(matrix);
    cofactors(&first, &second, &third).map(|row| row.map(|v| fr(fr(v) / det)))
}
/// Upstream inverts the double matrix, then casts it to float.
fn inverse_transpose_double_then_float(matrix: &[Vec3; 3]) -> [Vec3; 3] {
    let [f, s, t] = *matrix;
    let rows = [
        [
            s[1] * t[2] - s[2] * t[1],
            s[2] * t[0] - s[0] * t[2],
            s[0] * t[1] - s[1] * t[0],
        ],
        [
            f[2] * t[1] - f[1] * t[2],
            f[0] * t[2] - f[2] * t[0],
            f[1] * t[0] - f[0] * t[1],
        ],
        [
            f[1] * s[2] - f[2] * s[1],
            f[2] * s[0] - f[0] * s[2],
            f[0] * s[1] - f[1] * s[0],
        ],
    ];
    let det = f[0] * rows[0][0] + f[1] * rows[0][1] + f[2] * rows[0][2];
    rows.map(|row| row.map(|v| fr(v / det)))
}
