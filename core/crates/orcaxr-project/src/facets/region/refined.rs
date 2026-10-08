//! Refined (subdivided) selection: the TriangleSelector working tree built from
//! a persisted refinement or dense roots, Orca's split/midpoint/neighbour rules,
//! and every tool over leaves, including adaptive splitting under a brush or a
//! height band. Errors raised while the tree is built or walked are the
//! browser's single-issue refusals.
use super::*;
use crate::facets::{ENCODING_VERSION, MAX_DEPTH, node_budget};
use orcaxr_contracts::canonical::Value;
use std::collections::{BTreeMap, BTreeSet};

/// One `(sourceTriangle, path)` leaf key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafRef {
    pub source_triangle: u32,
    pub path: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RefinedLeaf {
    pub source_triangle: u32,
    pub path: Vec<u8>,
    pub vertex_indices: [u32; 3],
    pub state: RegionState,
    pub selected: bool,
}

/// One encoded tree node, as `FacetRefinementNode`.
#[derive(Debug, Clone, PartialEq)]
pub enum EncodedNode {
    Leaf(RegionState),
    Split {
        split_sides: u8,
        special_side: u8,
        children: Vec<EncodedNode>,
    },
}

/// `FacetRefinedSelection`: every working vertex (source vertices first, then
/// midpoints in allocation order), the encoded roots and every leaf in
/// depth-first order with the paint target flags.
#[derive(Debug, Clone, PartialEq)]
pub struct RefinedSelection {
    pub edge_limit_mm: Option<f64>,
    pub vertices: Vec<Vec3>,
    pub roots: Vec<EncodedNode>,
    pub leaves: Vec<RefinedLeaf>,
}

type Neighbors = [i64; 3];

struct Tri {
    vertices: [usize; 3],
    source: usize,
    path: Vec<u8>,
    state: Option<PaintValue>,
    split_sides: u8,
    special_side: u8,
    children: Vec<usize>,
}

struct Workspace {
    vertices: Vec<Vec3>,
    triangles: Vec<Tri>,
    roots: Vec<usize>,
    root_neighbors: Vec<Neighbors>,
    budget: f64,
}

fn issue(code: &'static str, path: &str, message: impl Into<String>) -> RegionError {
    RegionError::Invalid(vec![Issue::new(code, path, message)])
}

// --- Validation of the refinement inputs (`validateRefinementEncoding`) ----

pub(super) fn encoding_issues(request: &Request<'_>, issues: &mut Vec<Issue>) {
    let count = request.guard_triangle_count;
    match request.refined_roots {
        Some(Roots::Json(roots)) => {
            let Value::Array(roots) = roots else {
                issues.push(Issue::new(
                    "invalid-facet-refinement-roots",
                    "refinedRoots",
                    "Dense facet refinement roots must be an array",
                ));
                return;
            };
            dense_issues(roots, count, request.channel, issues);
            return;
        }
        Some(Roots::Nodes(roots)) => {
            dense_issues(roots, count, request.channel, issues);
            return;
        }
        None => {}
    }
    let Some(candidate) = request.refinement else {
        return;
    };
    let Value::Object(encoding) = candidate else {
        issues.push(Issue::new(
            "invalid-facet-refinement",
            "refinement",
            "Facet refinement must be an encoding object",
        ));
        return;
    };
    if field(encoding, "version") != Some(&Value::Number(f64::from(ENCODING_VERSION))) {
        issues.push(Issue::new(
            "invalid-facet-refinement-version",
            "refinement.version",
            format!("Facet refinement version must be {ENCODING_VERSION}"),
        ));
    }
    let Some(Value::Array(splits)) = field(encoding, "splits") else {
        issues.push(Issue::new(
            "invalid-facet-refinement-splits",
            "refinement.splits",
            "Facet refinement splits must be an array",
        ));
        return;
    };
    if field(encoding, "triangleCount") != Some(&Value::Number(count)) {
        issues.push(Issue::new(
            "invalid-facet-refinement-triangle-count",
            "refinement.triangleCount",
            "Facet refinement must declare the source mesh triangle count",
        ));
    }
    let budget = node_budget(count);
    let roots = splits.iter().enumerate().rev().map(|(i, split)| {
        let node = match split {
            Value::Object(fields) => field(fields, "node").unwrap_or(&UNDEFINED),
            other => other,
        };
        (node, NodePath::root(RootPath::Split(i)))
    });
    for (i, split) in splits.iter().enumerate() {
        let triangle = match split {
            Value::Object(fields) => field(fields, "triangle"),
            _ => None,
        };
        let valid = matches!(triangle, Some(Value::Number(t)) if t.fract() == 0.0 && *t >= 0.0 && *t < count);
        if !valid {
            issues.push(Issue::new(
                "invalid-facet-refinement-split-triangle",
                format!("refinement.splits[{i}].triangle"),
                "A refinement split must name a source facet of this mesh",
            ));
        }
    }
    walk_nodes(roots, budget, request.channel, "refinement", issues);
}

/// Dense roots: one per source facet, then every node walked.
fn dense_issues<N: TreeNode>(roots: &[N], count: f64, channel: Channel, issues: &mut Vec<Issue>) {
    if roots.len() as f64 != count {
        issues.push(Issue::new(
            "invalid-facet-refinement-root-count",
            "refinedRoots",
            "Facet refinement must contain exactly one root per source triangle",
        ));
    }
    let roots = roots
        .iter()
        .enumerate()
        .rev()
        .map(|(i, node)| (node, NodePath::root(RootPath::Dense(i))));
    walk_nodes(roots, node_budget(count), channel, "refinedRoots", issues);
}

/// Stands in for a missing JavaScript property.
static UNDEFINED: Value = Value::Null;

type Fields = BTreeMap<Vec<u16>, Value>;

fn field<'a>(fields: &'a Fields, name: &str) -> Option<&'a Value> {
    fields.get(&name.encode_utf16().collect::<Vec<_>>())
}

/// `walkRefinementNodes`: the browser stacks every root and pops the last
/// first, so each root's subtree is walked depth first in reverse root order;
/// `roots` arrives in that order and a node's path is formatted only for an
/// issue.
fn walk_nodes<'n, N: TreeNode + 'n>(
    roots: impl Iterator<Item = (&'n N, NodePath)>,
    budget: f64,
    channel: Channel,
    root_path: &str,
    issues: &mut Vec<Issue>,
) {
    let mut count = 0.0;
    let mut stack: Vec<(&N, NodePath, usize)> = Vec::new();
    for (root, path) in roots {
        stack.push((root, path, 0));
        while let Some((node, path, depth)) = stack.pop() {
            count += 1.0;
            if count > budget {
                issues.push(Issue::new(
                    "facet-refinement-limit-exceeded",
                    root_path,
                    format!(
                        "Facet refinement may contain at most {} nodes",
                        js_number(budget)
                    ),
                ));
                return;
            }
            let (sides, special, children) = match node.shape() {
                Shape::Malformed => {
                    issues.push(Issue::new(
                        "invalid-facet-refinement-node",
                        path.to_string(),
                        "Facet refinement nodes must be objects",
                    ));
                    continue;
                }
                Shape::Leaf(state) => {
                    if !state.valid(channel) {
                        issues.push(Issue::new(
                            "invalid-facet-refinement-state",
                            format!("{path}.state"),
                            format!(
                                "Refined leaf state is invalid for the {} channel",
                                channel.name()
                            ),
                        ));
                    }
                    continue;
                }
                Shape::Unknown => {
                    issues.push(Issue::new(
                        "invalid-facet-refinement-node",
                        format!("{path}.kind"),
                        "Facet refinement node kind must be leaf or split",
                    ));
                    continue;
                }
                Shape::Split {
                    sides,
                    special,
                    children,
                } => (sides, special, children),
            };
            if sides.is_none() {
                issues.push(Issue::new(
                    "invalid-facet-refinement-split",
                    format!("{path}.splitSides"),
                    "Refined split side count must be 1, 2, or 3",
                ));
            }
            if special.is_none() || (sides == Some(3) && special != Some(0)) {
                issues.push(Issue::new(
                    "invalid-facet-refinement-special-side",
                    format!("{path}.specialSide"),
                    "Refined special side must be 0, 1, or 2; a three-side split must use side 0",
                ));
            }
            let Some(children) = children else {
                issues.push(Issue::new(
                    "invalid-facet-refinement-children",
                    format!("{path}.children"),
                    "Refined split children must be an array",
                ));
                continue;
            };
            let Some(sides) = sides else {
                continue;
            };
            if children.len() != usize::from(sides) + 1 {
                issues.push(Issue::new(
                    "invalid-facet-refinement-child-count",
                    format!("{path}.children"),
                    "Refined child count must equal splitSides + 1",
                ));
                continue;
            }
            if depth >= MAX_DEPTH {
                issues.push(Issue::new(
                    "facet-refinement-limit-exceeded",
                    path.to_string(),
                    format!("Facet refinement may contain at most {MAX_DEPTH} split levels"),
                ));
                continue;
            }
            for (i, child) in children.iter().enumerate() {
                stack.push((child, path.child(i as u8), depth + 1));
            }
        }
    }
}

/// Which input a root came from.
#[derive(Debug, Clone, Copy)]
enum RootPath {
    Dense(usize),
    Split(usize),
}
/// A node's place in the request, formatted only for an issue.
#[derive(Debug, Clone)]
struct NodePath {
    root: RootPath,
    children: Vec<u8>,
}
impl NodePath {
    fn root(root: RootPath) -> Self {
        Self {
            root,
            children: Vec::new(),
        }
    }
    fn child(&self, index: u8) -> Self {
        let mut children = self.children.clone();
        children.push(index);
        Self {
            root: self.root,
            children,
        }
    }
}
impl std::fmt::Display for NodePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.root {
            RootPath::Dense(i) => write!(f, "refinedRoots[{i}]")?,
            RootPath::Split(i) => write!(f, "refinement.splits[{i}].node")?,
        }
        for child in &self.children {
            write!(f, ".children[{child}]")?;
        }
        Ok(())
    }
}

/// A refinement node as the selector reads it: host JSON, validated as the
/// browser's raw input, or a tree this core produced.
pub(super) trait TreeNode: Sized {
    fn shape(&self) -> Shape<'_, Self>;
}
pub(super) enum Shape<'n, N> {
    /// Not an object.
    Malformed,
    /// An object whose kind is neither leaf nor split.
    Unknown,
    Leaf(LeafState),
    /// Side counts outside their ranges and non-array children read as `None`.
    Split {
        sides: Option<u8>,
        special: Option<u8>,
        children: Option<&'n [N]>,
    },
}
pub(super) enum LeafState {
    Unpainted,
    /// `None` is a value no channel can hold.
    Assigned(Option<PaintValue>),
    /// Not a state object, or another kind.
    Malformed,
}
impl LeafState {
    /// `isValidRefinementState`.
    fn valid(&self, channel: Channel) -> bool {
        match self {
            Self::Unpainted => true,
            Self::Assigned(Some(value)) => channel_value(channel, value),
            _ => false,
        }
    }
    fn decoded(self) -> Option<PaintValue> {
        match self {
            Self::Assigned(value) => value,
            _ => None,
        }
    }
}
impl TreeNode for Value {
    fn shape(&self) -> Shape<'_, Self> {
        let Value::Object(record) = self else {
            return Shape::Malformed;
        };
        let kind = field(record, "kind");
        if text_is(kind, "leaf") {
            let state = match field(record, "state") {
                Some(Value::Object(state)) => {
                    let kind = field(state, "kind");
                    if text_is(kind, "unpainted") {
                        LeafState::Unpainted
                    } else if text_is(kind, "assigned") {
                        LeafState::Assigned(field(state, "value").and_then(PaintValue::from_value))
                    } else {
                        LeafState::Malformed
                    }
                }
                _ => LeafState::Malformed,
            };
            return Shape::Leaf(state);
        }
        if !text_is(kind, "split") {
            return Shape::Unknown;
        }
        Shape::Split {
            sides: small(field(record, "splitSides"), 1..=3),
            special: small(field(record, "specialSide"), 0..=2),
            children: match field(record, "children") {
                Some(Value::Array(children)) => Some(children),
                _ => None,
            },
        }
    }
}
impl TreeNode for EncodedNode {
    fn shape(&self) -> Shape<'_, Self> {
        match self {
            EncodedNode::Leaf(RegionState::Unpainted) => Shape::Leaf(LeafState::Unpainted),
            EncodedNode::Leaf(RegionState::Assigned(value)) => {
                Shape::Leaf(LeafState::Assigned(Some(value.clone())))
            }
            EncodedNode::Split {
                split_sides,
                special_side,
                children,
            } => Shape::Split {
                sides: (1..=3).contains(split_sides).then_some(*split_sides),
                special: (*special_side <= 2).then_some(*special_side),
                children: Some(children),
            },
        }
    }
}

fn text_is(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(units)) if units.iter().copied().eq(text.encode_utf16()))
}
fn small(value: Option<&Value>, range: std::ops::RangeInclusive<u8>) -> Option<u8> {
    match value {
        Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0 && *n <= 255.0 => {
            let n = *n as u8;
            range.contains(&n).then_some(n)
        }
        _ => None,
    }
}
/// `priorRefinedStates`: assigned states the prior refinement carries; `None`
/// stands for an assigned value no channel can hold.
pub(super) fn prior_assigned_states(request: &Request<'_>) -> Vec<Option<PaintValue>> {
    let mut states = Vec::new();
    match request.refined_roots {
        Some(Roots::Json(Value::Array(roots))) => collect_assigned(roots.iter(), &mut states),
        Some(Roots::Nodes(roots)) => collect_assigned(roots.iter(), &mut states),
        Some(Roots::Json(_)) => {}
        None => {
            if let Some(Value::Object(encoding)) = request.refinement
                && let Some(Value::Array(splits)) = field(encoding, "splits")
            {
                let nodes = splits.iter().map(|split| match split {
                    Value::Object(fields) => field(fields, "node").unwrap_or(&UNDEFINED),
                    _ => &UNDEFINED,
                });
                collect_assigned(nodes, &mut states);
            }
        }
    }
    states
}
fn collect_assigned<'n, N: TreeNode + 'n>(
    roots: impl DoubleEndedIterator<Item = &'n N>,
    states: &mut Vec<Option<PaintValue>>,
) {
    let mut stack = Vec::new();
    for root in roots.rev() {
        stack.push(root);
        while let Some(node) = stack.pop() {
            match node.shape() {
                Shape::Leaf(LeafState::Assigned(value)) => states.push(value),
                Shape::Split {
                    children: Some(children),
                    ..
                } if children.len() <= 4 => stack.extend(children.iter()),
                _ => {}
            }
        }
    }
}

// --- The working tree -------------------------------------------------------

fn build(request: &Request<'_>) -> Result<Workspace, RegionError> {
    let mesh = request.mesh;
    let states = facet_states(request.assignments, mesh.triangles.len());
    let mut workspace = Workspace {
        vertices: mesh.vertices.iter().map(float_vector).collect(),
        triangles: mesh
            .triangles
            .iter()
            .enumerate()
            .map(|(source, t)| Tri {
                vertices: t.map(|v| v as usize),
                source,
                path: Vec::new(),
                state: states[source].clone(),
                split_sides: 0,
                special_side: 0,
                children: Vec::new(),
            })
            .collect(),
        roots: (0..mesh.triangles.len()).collect(),
        root_neighbors: validated_neighbors(mesh),
        budget: node_budget(mesh.triangles.len() as f64),
    };
    match request.refined_roots {
        Some(Roots::Json(Value::Array(roots))) => {
            apply_roots(&mut workspace, roots)?;
            return Ok(workspace);
        }
        Some(Roots::Nodes(roots)) => {
            apply_roots(&mut workspace, roots)?;
            return Ok(workspace);
        }
        _ => {}
    }
    if let Some(Value::Object(encoding)) = request.refinement
        && let Some(Value::Array(splits)) = field(encoding, "splits")
    {
        for split in splits {
            let Value::Object(fields) = split else {
                continue;
            };
            let Some(Value::Number(t)) = field(fields, "triangle") else {
                continue;
            };
            if *t < 0.0 || *t >= workspace.roots.len() as f64 {
                continue;
            }
            let source = *t as usize;
            let neighbors = workspace.root_neighbors[source];
            apply_node(
                &mut workspace,
                source,
                neighbors,
                field(fields, "node").unwrap_or(&UNDEFINED),
                0,
            )?;
        }
    }
    Ok(workspace)
}

fn apply_roots<N: TreeNode>(workspace: &mut Workspace, roots: &[N]) -> Result<(), RegionError> {
    for (source, node) in roots.iter().enumerate() {
        if source >= workspace.roots.len() {
            continue;
        }
        let neighbors = workspace.root_neighbors[source];
        apply_node(workspace, source, neighbors, node, 0)?;
    }
    Ok(())
}

fn apply_node<N: TreeNode>(
    workspace: &mut Workspace,
    triangle: usize,
    neighbors: Neighbors,
    node: &N,
    depth: usize,
) -> Result<(), RegionError> {
    // Validation refused malformed and unknown nodes before the tree is built.
    let (sides, special, children) = match node.shape() {
        Shape::Leaf(state) => {
            workspace.triangles[triangle].state = state.decoded();
            return Ok(());
        }
        Shape::Split {
            sides,
            special,
            children,
        } => (sides, special, children),
        Shape::Malformed | Shape::Unknown => return Ok(()),
    };
    perform_split(
        workspace,
        triangle,
        neighbors,
        sides.unwrap_or(1),
        special.unwrap_or(0),
        depth,
    )?;
    for (i, child) in children.unwrap_or_default().iter().enumerate() {
        let child_triangle = workspace.triangles[triangle].children[i];
        let child_neighbors = child_neighbors(workspace, triangle, neighbors, i)?;
        apply_node(workspace, child_triangle, child_neighbors, child, depth + 1)?;
    }
    Ok(())
}

fn perform_split(
    workspace: &mut Workspace,
    index: usize,
    neighbors: Neighbors,
    sides: u8,
    special: u8,
    depth: usize,
) -> Result<(), RegionError> {
    if depth >= MAX_DEPTH
        || (workspace.triangles.len() + usize::from(sides) + 1) as f64 > workspace.budget
    {
        return Err(issue(
            "facet-refinement-limit-exceeded",
            "refinement",
            format!(
                "Facet refinement exceeds {MAX_DEPTH} levels or {} nodes",
                js_number(workspace.budget)
            ),
        ));
    }
    if workspace.triangles[index].split_sides != 0 {
        return Ok(());
    }
    workspace.triangles[index].split_sides = sides;
    workspace.triangles[index].special_side = special;
    let corners = workspace.triangles[index].vertices;
    let mut rotated: Vec<usize> = (0..3)
        .map(|o| corners[(usize::from(special) + o) % 3])
        .collect();
    let s = usize::from(special);
    let allocate =
        |workspace: &mut Workspace, rotated: &[usize], edge: usize, a: usize, b: usize| {
            midpoint_or_allocate(workspace, neighbors[edge], rotated[a], rotated[b])
        };
    let mut children: Vec<[usize; 3]> = Vec::new();
    match sides {
        1 => {
            let m = allocate(workspace, &rotated, next(s), 2, 1)?;
            rotated.insert(2, m);
            children.push([rotated[0], rotated[1], rotated[2]]);
            children.push([rotated[2], rotated[3], rotated[0]]);
        }
        2 => {
            let m = allocate(workspace, &rotated, s, 1, 0)?;
            rotated.insert(1, m);
            let m = allocate(workspace, &rotated, previous(s), 0, 3)?;
            rotated.insert(4, m);
            children.push([rotated[0], rotated[1], rotated[4]]);
            children.push([rotated[1], rotated[2], rotated[4]]);
            children.push([rotated[2], rotated[3], rotated[4]]);
        }
        _ => {
            let m = allocate(workspace, &rotated, 0, 1, 0)?;
            rotated.insert(1, m);
            let m = allocate(workspace, &rotated, 1, 3, 2)?;
            rotated.insert(3, m);
            let m = allocate(workspace, &rotated, 2, 0, 4)?;
            rotated.insert(5, m);
            children.push([rotated[0], rotated[1], rotated[5]]);
            children.push([rotated[1], rotated[2], rotated[3]]);
            children.push([rotated[3], rotated[4], rotated[5]]);
            children.push([rotated[1], rotated[3], rotated[5]]);
        }
    }
    for vertices in children {
        let child = workspace.triangles.len();
        let parent = &workspace.triangles[index];
        let mut path = parent.path.clone();
        path.push(parent.children.len() as u8);
        let tri = Tri {
            vertices,
            source: parent.source,
            path,
            state: parent.state.clone(),
            split_sides: 0,
            special_side: 0,
            children: Vec::new(),
        };
        workspace.triangles.push(tri);
        workspace.triangles[index].children.push(child);
    }
    Ok(())
}

fn midpoint_or_allocate(
    workspace: &mut Workspace,
    neighbor: i64,
    first: usize,
    second: usize,
) -> Result<usize, RegionError> {
    let existing = triangle_midpoint(workspace, neighbor, first, second)?;
    if existing != -1 {
        return Ok(existing as usize);
    }
    let a = workspace.vertices[first];
    let b = workspace.vertices[second];
    let midpoint = scale(&add(&a, &b), fr(0.5));
    workspace.vertices.push(midpoint);
    Ok(workspace.vertices.len() - 1)
}

fn next(side: usize) -> usize {
    (side + 1) % 3
}
fn previous(side: usize) -> usize {
    (side + 2) % 3
}

fn oriented_edge(tri: &Tri, first: usize, second: usize) -> Result<usize, RegionError> {
    match tri.vertices.iter().position(|&v| v == first) {
        Some(edge) if tri.vertices[(edge + 1) % 3] == second => Ok(edge),
        _ => Err(issue(
            "invalid-facet-refinement-topology",
            "refinement",
            "Refined neighbor topology does not share the expected oriented edge",
        )),
    }
}

fn triangle_midpoint(
    workspace: &Workspace,
    index: i64,
    first: usize,
    second: usize,
) -> Result<i64, RegionError> {
    if index == -1 {
        return Ok(-1);
    }
    let tri = &workspace.triangles[index as usize];
    if tri.split_sides == 0 {
        return Ok(-1);
    }
    let edge = oriented_edge(tri, first, second)?;
    let special = usize::from(tri.special_side);
    let child = |i: usize| &workspace.triangles[tri.children[i]];
    Ok(match tri.split_sides {
        1 => {
            if edge == next(special) {
                child(0).vertices[2] as i64
            } else {
                let c = tri.children[if edge == special { 0 } else { 1 }] as i64;
                return triangle_midpoint(workspace, c, first, second);
            }
        }
        2 => {
            if edge == next(special) {
                return triangle_midpoint(workspace, tri.children[2] as i64, first, second);
            }
            if edge == special {
                child(0).vertices[1] as i64
            } else {
                child(1).vertices[2] as i64
            }
        }
        _ => match edge {
            0 => child(0).vertices[1] as i64,
            1 => child(1).vertices[2] as i64,
            _ => child(2).vertices[2] as i64,
        },
    })
}

fn neighbor_child(
    workspace: &Workspace,
    index: i64,
    first: usize,
    second: usize,
    first_partition: bool,
) -> Result<i64, RegionError> {
    if index == -1 {
        return Ok(-1);
    }
    let tri = &workspace.triangles[index as usize];
    if tri.split_sides == 0 {
        return Ok(-1);
    }
    let edge = oriented_edge(tri, first, second)?;
    let special = usize::from(tri.special_side);
    let pick = |a: usize, b: usize| tri.children[if first_partition { a } else { b }] as i64;
    Ok(match tri.split_sides {
        1 => {
            if edge != next(special) {
                let c = tri.children[if edge == special { 0 } else { 1 }] as i64;
                return neighbor_child(workspace, c, first, second, first_partition);
            }
            pick(0, 1)
        }
        2 => {
            if edge == next(special) {
                return neighbor_child(
                    workspace,
                    tri.children[2] as i64,
                    first,
                    second,
                    first_partition,
                );
            }
            if edge == special {
                pick(0, 1)
            } else {
                pick(2, 0)
            }
        }
        _ => match edge {
            0 => pick(0, 1),
            1 => pick(1, 2),
            _ => pick(2, 0),
        },
    })
}

fn child_neighbors(
    workspace: &Workspace,
    index: usize,
    n: Neighbors,
    child: usize,
) -> Result<Neighbors, RegionError> {
    let tri = &workspace.triangles[index];
    let v = tri.vertices;
    let c = |i: usize| tri.children[i] as i64;
    let nc = |neighbor: i64, a: usize, b: usize, first: bool| {
        neighbor_child(workspace, neighbor, a, b, first)
    };
    let i = usize::from(tri.special_side);
    let j = next(i);
    let k = next(j);
    Ok(match tri.split_sides {
        1 => {
            if child == 0 {
                [n[i], nc(n[j], v[k], v[j], false)?, c(1)]
            } else {
                [nc(n[j], v[k], v[j], true)?, n[k], c(0)]
            }
        }
        2 => match child {
            0 => [
                nc(n[i], v[j], v[i], false)?,
                c(1),
                nc(n[k], v[i], v[k], true)?,
            ],
            1 => [nc(n[i], v[j], v[i], true)?, c(2), c(0)],
            _ => [n[j], nc(n[k], v[i], v[k], false)?, c(1)],
        },
        _ => match child {
            0 => [
                nc(n[0], v[1], v[0], false)?,
                c(3),
                nc(n[2], v[0], v[2], true)?,
            ],
            1 => [
                nc(n[0], v[1], v[0], true)?,
                nc(n[1], v[2], v[1], false)?,
                c(3),
            ],
            2 => [
                nc(n[1], v[2], v[1], true)?,
                nc(n[2], v[0], v[2], false)?,
                c(3),
            ],
            _ => [c(1), c(2), c(0)],
        },
    })
}

fn child_neighbors_propagated(
    tri: &Tri,
    propagated: &Neighbors,
    child: usize,
    child_neighbors: Neighbors,
) -> Neighbors {
    let mut out = child_neighbors;
    let mut replace = |side: usize, parent: usize| {
        if out[side] == -1 {
            out[side] = propagated[parent];
        }
    };
    let i = usize::from(tri.special_side);
    let j = next(i);
    let k = next(j);
    match (tri.split_sides, child) {
        (1, 0) => {
            replace(0, i);
            replace(1, j);
        }
        (1, _) => {
            replace(0, j);
            replace(1, k);
        }
        (2, 0) => {
            replace(0, i);
            replace(2, k);
        }
        (2, 1) => replace(0, i),
        (2, _) => {
            replace(0, j);
            replace(1, k);
        }
        (_, 0) => {
            replace(0, 0);
            replace(2, 2);
        }
        (_, 1) => {
            replace(0, 0);
            replace(1, 1);
        }
        (_, 2) => {
            replace(0, 1);
            replace(1, 2);
        }
        _ => {}
    }
    out
}

struct Tables {
    direct: Vec<Neighbors>,
    propagated: Vec<Neighbors>,
}

fn tables(workspace: &Workspace) -> Result<Tables, RegionError> {
    let mut tables = Tables {
        direct: vec![[-1; 3]; workspace.triangles.len()],
        propagated: vec![[-1; 3]; workspace.triangles.len()],
    };
    let mut stack: Vec<(usize, Neighbors, Neighbors)> = Vec::new();
    for (source, &root) in workspace.roots.iter().enumerate() {
        let n = workspace.root_neighbors[source];
        stack.push((root, n, n));
        while let Some((index, neighbors, inherited)) = stack.pop() {
            tables.direct[index] = neighbors;
            tables.propagated[index] = inherited;
            let tri = &workspace.triangles[index];
            // Children in order: pushed in reverse onto the stack.
            let mut pending = Vec::new();
            for (i, &child) in tri.children.iter().enumerate() {
                let cn = child_neighbors(workspace, index, neighbors, i)?;
                pending.push((
                    child,
                    cn,
                    child_neighbors_propagated(tri, &inherited, i, cn),
                ));
            }
            stack.extend(pending.into_iter().rev());
        }
    }
    Ok(tables)
}

fn subtriangles(
    workspace: &Workspace,
    index: i64,
    first: usize,
    second: usize,
) -> Result<[i64; 2], RegionError> {
    if index == -1 {
        return Ok([-1, -1]);
    }
    let tri = &workspace.triangles[index as usize];
    if tri.split_sides == 0 {
        return Ok([-1, -1]);
    }
    let edge = oriented_edge(tri, first, second)?;
    let special = usize::from(tri.special_side);
    let c = |i: usize| tri.children[i] as i64;
    Ok(match tri.split_sides {
        1 => {
            if edge == next(special) {
                [c(0), c(1)]
            } else {
                [c(if edge == special { 0 } else { 1 }), -1]
            }
        }
        2 => {
            if edge == next(special) {
                [c(2), -1]
            } else if edge == special {
                [c(0), c(1)]
            } else {
                [c(2), c(0)]
            }
        }
        _ => match edge {
            0 => [c(0), c(1)],
            1 => [c(1), c(2)],
            _ => [c(2), c(0)],
        },
    })
}

fn append_touching(
    workspace: &Workspace,
    index: i64,
    first: usize,
    second: usize,
    out: &mut Vec<usize>,
) -> Result<(), RegionError> {
    if index == -1 {
        return Ok(());
    }
    let touching = subtriangles(workspace, index, first, second)?;
    for (sub, first_partition) in [(touching[0], true), (touching[1], false)] {
        if sub == -1 {
            continue;
        }
        if workspace.triangles[sub as usize].split_sides == 0 {
            out.push(sub as usize);
            continue;
        }
        let midpoint = triangle_midpoint(workspace, index, first, second)?;
        if midpoint == -1 {
            append_touching(workspace, sub, first, second, out)?;
        } else {
            let m = midpoint as usize;
            if first_partition {
                append_touching(workspace, sub, first, m, out)?;
            } else {
                append_touching(workspace, sub, m, second, out)?;
            }
        }
    }
    Ok(())
}

fn all_touching(
    workspace: &Workspace,
    index: usize,
    tables: &Tables,
) -> Result<Vec<usize>, RegionError> {
    let v = workspace.triangles[index].vertices;
    let d = tables.direct[index];
    let mut out = Vec::new();
    append_touching(workspace, d[0], v[1], v[0], &mut out)?;
    append_touching(workspace, d[1], v[2], v[1], &mut out)?;
    append_touching(workspace, d[2], v[0], v[2], &mut out)?;
    for &neighbor in &tables.propagated[index] {
        if neighbor != -1 && workspace.triangles[neighbor as usize].split_sides == 0 {
            out.push(neighbor as usize);
        }
    }
    Ok(out)
}

fn resolve_seed(
    workspace: &Workspace,
    source: usize,
    hit: Option<&Vec3>,
) -> Result<usize, RegionError> {
    let root = workspace.roots[source];
    if workspace.triangles[root].split_sides == 0 {
        return Ok(root);
    }
    let Some(hit) = hit else {
        return Err(issue(
            "missing-refinement-hit",
            "tool.hit",
            "A finite local hit is required to resolve a split seed triangle",
        ));
    };
    let resolved = leaf_at_hit(
        workspace,
        root,
        workspace.root_neighbors[source],
        &float_vector(hit),
    )?;
    if resolved != -1 {
        return Ok(resolved as usize);
    }
    Err(issue(
        "invalid-refinement-hit",
        "tool.hit",
        "Refinement hit does not lie in any leaf of the seed triangle",
    ))
}

fn leaf_at_hit(
    workspace: &Workspace,
    index: usize,
    neighbors: Neighbors,
    hit: &Vec3,
) -> Result<i64, RegionError> {
    let tri = &workspace.triangles[index];
    if tri.split_sides == 0 {
        return Ok(if point_inside(workspace, tri, hit) {
            index as i64
        } else {
            -1
        });
    }
    for (i, &child) in tri.children.iter().enumerate() {
        if !point_inside(workspace, &workspace.triangles[child], hit) {
            continue;
        }
        let cn = child_neighbors(workspace, index, neighbors, i)?;
        return leaf_at_hit(workspace, child, cn, hit);
    }
    Ok(-1)
}

fn point_inside(workspace: &Workspace, tri: &Tri, hit: &Vec3) -> bool {
    let [a, b, c] = tri.vertices.map(|v| workspace.vertices[v]);
    let zero = sub(&b, &a);
    let one = sub(&c, &a);
    let two = sub(hit, &a);
    let d00 = dot(&zero, &zero);
    let d01 = dot(&zero, &one);
    let d11 = dot(&one, &one);
    let d20 = dot(&two, &zero);
    let d21 = dot(&two, &one);
    let denominator = sub1(mul(d00, d11), mul(d01, d01));
    let second = fr(sub1(mul(d11, d20), mul(d01, d21)) / denominator);
    let third = fr(sub1(mul(d00, d21), mul(d01, d20)) / denominator);
    let first = sub1(sub1(fr(1.0), second), third);
    [first, second, third]
        .iter()
        .all(|&x| (0.0..=1.0).contains(&x))
}

fn clipped(workspace: &Workspace, index: usize, plane: Option<&ClippingPlane>) -> bool {
    plane.is_some_and(|plane| {
        workspace.triangles[index]
            .vertices
            .iter()
            .any(|&v| point_clipped(&workspace.vertices[v], plane))
    })
}

fn collect_leaves(workspace: &Workspace, index: usize, selected: &mut Vec<bool>) {
    let mut stack = vec![index];
    while let Some(index) = stack.pop() {
        let tri = &workspace.triangles[index];
        if tri.split_sides == 0 {
            mark(selected, index);
        } else {
            stack.extend(tri.children.iter().rev());
        }
    }
}

fn leaf_indices(workspace: &Workspace) -> Vec<usize> {
    let mut leaves = Vec::new();
    for &root in &workspace.roots {
        let mut stack = vec![root];
        while let Some(index) = stack.pop() {
            let tri = &workspace.triangles[index];
            if tri.split_sides == 0 {
                leaves.push(index);
            } else {
                stack.extend(tri.children.iter().rev());
            }
        }
    }
    leaves
}

fn mark(selected: &mut Vec<bool>, index: usize) {
    if index >= selected.len() {
        selected.resize(index + 1, false);
    }
    selected[index] = true;
}

// --- Tools ------------------------------------------------------------------

pub(super) fn select(request: &Request<'_>) -> Result<Selection, RegionError> {
    let mut workspace = build(request)?;
    let mut selected: Vec<bool> = Vec::new();
    let mut edge_limit = None;
    let mut replacements = None;
    let seed = request.seed_triangle as usize;
    match &request.tool {
        Tool::Triangle { hit } => {
            let leaf = resolve_seed(&workspace, seed, hit.as_ref())?;
            mark(&mut selected, leaf);
        }
        Tool::Fill {
            hit,
            edge_detection,
        } => fill(
            request,
            &workspace,
            seed,
            hit.as_ref(),
            *edge_detection,
            &mut selected,
        )?,
        Tool::GapFill {
            max_area_mm2,
            state_order,
        } => {
            replacements = Some(gap_fill(
                &workspace,
                *max_area_mm2,
                state_order,
                &mut selected,
            )?);
        }
        Tool::Circle(brush) | Tool::Sphere(brush) => {
            let kind = if matches!(request.tool, Tool::Circle(_)) {
                BrushKind::Circle
            } else {
                BrushKind::Sphere
            };
            let cursor = resolve_cursor(kind, brush, request.transform.unwrap_or(IDENTITY));
            edge_limit = (brush.triangle_splitting == Some(true))
                .then(|| adaptive_brush_edge_limit(cursor.radius_squared));
            brush_region(request, &mut workspace, &cursor, edge_limit, &mut selected)?;
        }
        Tool::HeightRange {
            start_z_mm,
            height_mm,
            triangle_splitting,
        } => {
            edge_limit = (*triangle_splitting == Some(true)).then(|| fr(0.1));
            height_region(
                request,
                &mut workspace,
                *start_z_mm,
                *height_mm,
                edge_limit,
                &mut selected,
            )?;
        }
    }
    let mut roots: Vec<u32> = selected
        .iter()
        .enumerate()
        .filter(|(_, s)| **s)
        .map(|(i, _)| workspace.triangles[i].source as u32)
        .collect();
    roots.sort_unstable();
    roots.dedup();
    let mut result = selection(roots, request.mesh.triangles.len());
    result.gap_fill_replacements = replacements;
    result.refinement = Some(freeze(&workspace, &selected, edge_limit));
    Ok(result)
}

/// `materializeFacetRefinement`: every persisted leaf, none selected.
pub(super) fn materialize(request: &Request<'_>) -> Result<RefinedSelection, RegionError> {
    let workspace = build(request)?;
    Ok(freeze(&workspace, &[], None))
}

fn fill(
    request: &Request<'_>,
    workspace: &Workspace,
    seed: usize,
    hit: Option<&Vec3>,
    edge_detection: Option<f64>,
    selected: &mut Vec<bool>,
) -> Result<(), RegionError> {
    let seed = resolve_seed(workspace, seed, hit)?;
    let seed_state = workspace.triangles[seed].state.clone();
    let tables = tables(workspace)?;
    let mesh = request.mesh;
    let normals: Option<Vec<Vec3>> = edge_detection.map(|_| {
        mesh.triangles
            .iter()
            .map(|t| face_normal(mesh.vertices, t))
            .collect()
    });
    let limit = edge_detection.map(|d| cos_degrees(d) - TRIANGLE_SELECTOR_EPSILON);
    let mut visited = vec![false; workspace.triangles.len()];
    let mut queue = vec![seed];
    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        if visited[current] {
            continue;
        }
        mark(selected, current);
        for neighbor in all_touching(workspace, current, &tables)? {
            let tri = &workspace.triangles[neighbor];
            if visited[neighbor]
                || tri.split_sides != 0
                || tri.state != seed_state
                || clipped(workspace, neighbor, request.clipping_plane.as_ref())
            {
                continue;
            }
            if let (Some(normals), Some(limit)) = (&normals, limit) {
                let d = dot(
                    &normals[tri.source],
                    &normals[workspace.triangles[current].source],
                )
                .clamp(0.0, 1.0);
                if d < limit {
                    continue;
                }
            }
            queue.push(neighbor);
        }
        visited[current] = true;
    }
    Ok(())
}

fn gap_fill(
    workspace: &Workspace,
    max_area_mm2: f64,
    order: &[PaintValue],
    selected: &mut Vec<bool>,
) -> Result<Vec<GapFillReplacement>, RegionError> {
    let index_of = |state: &Option<PaintValue>| match state {
        None => 0,
        Some(value) => order.iter().position(|o| o == value).map_or(0, |i| i + 1),
    };
    let tables = tables(workspace)?;
    let mut visited = vec![false; workspace.triangles.len()];
    let threshold = fr(max_area_mm2);
    let mut replacements = Vec::new();
    for start in leaf_indices(workspace) {
        if visited[start] {
            continue;
        }
        let source_state = workspace.triangles[start].state.clone();
        let source_index = index_of(&source_state);
        let mut queue = vec![start];
        let mut component = Vec::new();
        let mut neighbor_states = BTreeSet::new();
        let mut head = 0;
        while head < queue.len() {
            let current = queue[head];
            head += 1;
            if visited[current] {
                continue;
            }
            component.push(current);
            for neighbor in all_touching(workspace, current, &tables)? {
                let tri = &workspace.triangles[neighbor];
                if tri.split_sides != 0 {
                    continue;
                }
                if tri.state != source_state {
                    neighbor_states.insert(index_of(&tri.state));
                } else if !visited[neighbor] {
                    queue.push(neighbor);
                }
            }
            visited[current] = true;
        }
        let area = refined_patch_area(workspace, &component);
        let Some(&target) = neighbor_states.first() else {
            continue;
        };
        if area >= threshold {
            continue;
        }
        for &t in &component {
            mark(selected, t);
        }
        let mut sources: Vec<u32> = component
            .iter()
            .map(|&t| workspace.triangles[t].source as u32)
            .collect();
        sources.sort_unstable();
        sources.dedup();
        let state = |index: usize| {
            if index == 0 {
                RegionState::Unpainted
            } else {
                RegionState::Assigned(order[index - 1].clone())
            }
        };
        let ranges = ranges(&sources);
        replacements.push(GapFillReplacement {
            area_mm2: area,
            source: state(source_index),
            target: state(target),
            triangle_indices: sources,
            ranges,
            refined_leaves: Some(
                component
                    .iter()
                    .map(|&t| LeafRef {
                        source_triangle: workspace.triangles[t].source as u32,
                        path: workspace.triangles[t].path.clone(),
                    })
                    .collect(),
            ),
        });
    }
    Ok(replacements)
}

fn refined_patch_area(workspace: &Workspace, triangles: &[usize]) -> f64 {
    let mut total = 0.0;
    for &t in triangles {
        let [a, b, c] = workspace.triangles[t]
            .vertices
            .map(|v| workspace.vertices[v]);
        let doubled = norm(&cross(&sub(&a, &b), &sub(&a, &c)));
        total += fr(doubled / fr(2.0));
        if total >= GAP_AREA_MAX_MM2 {
            break;
        }
    }
    fr(total)
}

fn adaptive_brush_edge_limit(radius_squared: f64) -> f64 {
    fr(fr(fr(fr(radius_squared).sqrt()) / fr(5.0)).min(fr(0.05)))
}

fn brush_region(
    request: &Request<'_>,
    workspace: &mut Workspace,
    cursor: &Cursor,
    edge_limit: Option<f64>,
    selected: &mut Vec<bool>,
) -> Result<(), RegionError> {
    let mesh = request.mesh;
    let filter = overhang_filter(request);
    let normals: Option<Vec<Vec3>> = (cursor.kind == BrushKind::Circle).then(|| {
        mesh.triangles
            .iter()
            .map(|t| face_normal(mesh.vertices, t))
            .collect()
    });
    let count = mesh.triangles.len();
    let mut visited = vec![false; count];
    let mut queue = vec![request.seed_triangle as usize];
    let mut head = 0;
    while head < queue.len() {
        let source = queue[head];
        head += 1;
        if visited[source] {
            continue;
        }
        if !passes_overhang(mesh, source, filter.as_ref()) {
            visited[source] = true;
            continue;
        }
        let root = workspace.roots[source];
        let neighbors = workspace.root_neighbors[source];
        if cursor_triangle(
            workspace,
            root,
            neighbors,
            cursor,
            request.clipping_plane.as_ref(),
            edge_limit,
            selected,
            0,
        )? {
            for &neighbor in &workspace.root_neighbors[source] {
                if neighbor < 0 || visited[neighbor as usize] {
                    continue;
                }
                if let Some(normals) = &normals
                    && !circle_facet_visible(&normals[neighbor as usize], cursor)
                {
                    continue;
                }
                queue.push(neighbor as usize);
            }
        }
        visited[source] = true;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cursor_triangle(
    workspace: &mut Workspace,
    index: usize,
    neighbors: Neighbors,
    cursor: &Cursor,
    plane: Option<&ClippingPlane>,
    edge_limit: Option<f64>,
    selected: &mut Vec<bool>,
    depth: usize,
) -> Result<bool, RegionError> {
    let points = workspace.triangles[index]
        .vertices
        .map(|v| workspace.vertices[v]);
    let inside = points
        .iter()
        .filter(|p| brush_contains(p, cursor, plane))
        .count();
    if inside == 0
        && !pointer_inside_triangle(&points, cursor, &cursor.center)
        && cursor
            .second_center
            .as_ref()
            .is_none_or(|second| !pointer_inside_triangle(&points, cursor, second))
        && !brush_edges_intersect(&points, cursor)
    {
        return Ok(false);
    }
    if inside == 3 {
        collect_leaves(workspace, index, selected);
        return Ok(true);
    }
    let unsplit = workspace.triangles[index].split_sides == 0;
    match edge_limit {
        Some(limit) if unsplit => split_at_limit(
            workspace,
            index,
            neighbors,
            Some(cursor),
            limit,
            depth,
            None,
        )?,
        None if unsplit => mark(selected, index),
        _ => {}
    }
    let children = workspace.triangles[index].children.clone();
    for (i, child) in children.into_iter().enumerate() {
        let cn = child_neighbors(workspace, index, neighbors, i)?;
        cursor_triangle(
            workspace,
            child,
            cn,
            cursor,
            plane,
            edge_limit,
            selected,
            depth + 1,
        )?;
    }
    Ok(true)
}

fn brush_edges_intersect(points: &[Vec3; 3], cursor: &Cursor) -> bool {
    let transformed = points.map(|p| {
        if cursor.uniform {
            float_vector(&p)
        } else {
            transform_point(&cursor.transform, &p)
        }
    });
    (0..3).any(|edge| {
        let (a, b) = (&transformed[edge], &transformed[(edge + 1) % 3]);
        match (&cursor.second_center, cursor.kind) {
            (None, BrushKind::Sphere) => line_touches_sphere(a, b, &cursor.center, cursor.radius),
            (None, BrushKind::Circle) => line_touches_circle(a, b, &cursor.center, cursor),
            (Some(second), BrushKind::Sphere) => {
                line_touches_capsule(a, b, &cursor.center, second, cursor.radius)
            }
            (Some(_), BrushKind::Circle) => line_touches_circle_capsule(a, b, cursor),
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn split_at_limit(
    workspace: &mut Workspace,
    index: usize,
    neighbors: Neighbors,
    cursor: Option<&Cursor>,
    limit: f64,
    depth: usize,
    height_transform: Option<&Transform>,
) -> Result<(), RegionError> {
    let points = workspace.triangles[index].vertices.map(|v| {
        let point = workspace.vertices[v];
        match (cursor, height_transform) {
            (Some(cursor), _) => {
                if cursor.uniform {
                    point
                } else {
                    transform_point(&cursor.transform, &point)
                }
            }
            (None, Some(transform)) => {
                if uniform_scaling(transform) {
                    point
                } else {
                    transform_point(transform, &point)
                }
            }
            (None, None) => point,
        }
    });
    let sides = [
        squared_norm(&sub(&points[2], &points[1])),
        squared_norm(&sub(&points[0], &points[2])),
        squared_norm(&sub(&points[1], &points[0])),
    ];
    let limit_squared = mul(limit, limit);
    let mut to_split = Vec::new();
    let mut keep = 0;
    for (side, &squared) in sides.iter().enumerate() {
        if squared > limit_squared {
            to_split.push(side);
        } else {
            keep = side;
        }
    }
    if to_split.is_empty() {
        return Ok(());
    }
    let count = to_split.len() as u8;
    let special = if count == 2 { keep } else { to_split[0] } as u8;
    perform_split(workspace, index, neighbors, count, special, depth)
}

fn height_contains(point: &Vec3, start: f64, height: f64, transform: &Transform) -> bool {
    let tolerance = fr(0.02);
    let z = transform_point(transform, point)[2];
    let top = add1(add1(start, height), tolerance);
    let bottom = sub1(start, tolerance);
    z > bottom && z < top
}

fn height_edge_intersects(
    workspace: &Workspace,
    index: usize,
    start: f64,
    height: f64,
    transform: &Transform,
) -> bool {
    let z = workspace.triangles[index]
        .vertices
        .map(|v| transform_point(transform, &workspace.vertices[v])[2]);
    let top = add1(add1(start, height), TRIANGLE_SELECTOR_EPSILON);
    let bottom = sub1(start, TRIANGLE_SELECTOR_EPSILON);
    !(z.iter().all(|&z| z < bottom) || z.iter().all(|&z| z > top))
}

fn height_region(
    request: &Request<'_>,
    workspace: &mut Workspace,
    start: f64,
    height: f64,
    edge_limit: Option<f64>,
    selected: &mut Vec<bool>,
) -> Result<(), RegionError> {
    let transform = request.transform.unwrap_or(IDENTITY);
    let filter = overhang_filter(request);
    let mesh = request.mesh;
    let starts: Vec<usize> = (0..workspace.roots.len())
        .filter(|&s| {
            height_edge_intersects(workspace, workspace.roots[s], start, height, &transform)
        })
        .collect();
    let mut visited = vec![false; mesh.triangles.len()];
    for first in starts {
        if visited[first] {
            continue;
        }
        let mut queue = vec![first];
        let mut head = 0;
        while head < queue.len() {
            let source = queue[head];
            head += 1;
            if visited[source] {
                continue;
            }
            if !passes_overhang(mesh, source, filter.as_ref()) {
                visited[source] = true;
                continue;
            }
            let root = workspace.roots[source];
            let neighbors = workspace.root_neighbors[source];
            if height_triangle(
                workspace, root, neighbors, start, height, &transform, edge_limit, selected, 0,
            )? {
                for &neighbor in &workspace.root_neighbors[source] {
                    if neighbor >= 0 && !visited[neighbor as usize] {
                        queue.push(neighbor as usize);
                    }
                }
            }
            visited[source] = true;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn height_triangle(
    workspace: &mut Workspace,
    index: usize,
    neighbors: Neighbors,
    start: f64,
    height: f64,
    transform: &Transform,
    edge_limit: Option<f64>,
    selected: &mut Vec<bool>,
    depth: usize,
) -> Result<bool, RegionError> {
    let inside = workspace.triangles[index]
        .vertices
        .iter()
        .filter(|&&v| height_contains(&workspace.vertices[v], start, height, transform))
        .count();
    if inside == 0 && !height_edge_intersects(workspace, index, start, height, transform) {
        return Ok(false);
    }
    if inside == 3 {
        collect_leaves(workspace, index, selected);
        return Ok(true);
    }
    let unsplit = workspace.triangles[index].split_sides == 0;
    match edge_limit {
        Some(limit) if unsplit => split_at_limit(
            workspace,
            index,
            neighbors,
            None,
            limit,
            depth,
            Some(transform),
        )?,
        None if unsplit => mark(selected, index),
        _ => {}
    }
    let children = workspace.triangles[index].children.clone();
    for (i, child) in children.into_iter().enumerate() {
        let cn = child_neighbors(workspace, index, neighbors, i)?;
        height_triangle(
            workspace,
            child,
            cn,
            start,
            height,
            transform,
            edge_limit,
            selected,
            depth + 1,
        )?;
    }
    Ok(true)
}

fn region_state(state: &Option<PaintValue>) -> RegionState {
    match state {
        None => RegionState::Unpainted,
        Some(value) => RegionState::Assigned(value.clone()),
    }
}

fn freeze(workspace: &Workspace, selected: &[bool], edge_limit: Option<f64>) -> RefinedSelection {
    fn encode(workspace: &Workspace, index: usize) -> EncodedNode {
        let tri = &workspace.triangles[index];
        if tri.split_sides == 0 {
            return EncodedNode::Leaf(region_state(&tri.state));
        }
        EncodedNode::Split {
            split_sides: tri.split_sides,
            special_side: tri.special_side,
            children: tri.children.iter().map(|&c| encode(workspace, c)).collect(),
        }
    }
    RefinedSelection {
        edge_limit_mm: edge_limit,
        vertices: workspace.vertices.clone(),
        roots: workspace
            .roots
            .iter()
            .map(|&r| encode(workspace, r))
            .collect(),
        leaves: leaf_indices(workspace)
            .into_iter()
            .map(|index| {
                let tri = &workspace.triangles[index];
                RefinedLeaf {
                    source_triangle: tri.source as u32,
                    path: tri.path.clone(),
                    vertex_indices: tri.vertices.map(|v| v as u32),
                    state: region_state(&tri.state),
                    selected: selected.get(index).copied().unwrap_or(false),
                }
            })
            .collect(),
    }
}

// --- Commit helpers (`applyFacetRefinedSelection`/`StateUpdates`) ----------

/// One per-leaf paint target, keyed by `(sourceTriangle, path)` as a host
/// sends it (`FacetRefinedStateUpdate`); unchecked numbers are refused.
#[derive(Debug, Clone, PartialEq)]
pub struct StateUpdate {
    pub source_triangle: f64,
    pub path: Vec<f64>,
    pub target: RegionState,
}
impl StateUpdate {
    pub fn new(source_triangle: u32, path: &[u8], target: &RegionState) -> Self {
        Self {
            source_triangle: f64::from(source_triangle),
            path: path.iter().map(|&child| f64::from(child)).collect(),
            target: target.clone(),
        }
    }
}

/// `applyFacetRefinedSelection`: the selector leaves pre-stroke states, so
/// this paints every selected leaf with `target` and collapses each branch it
/// makes homogeneous; an adaptive split the target already matches vanishes.
pub fn apply_selection(
    channel: Channel,
    selection: &RefinedSelection,
    target: &RegionState,
) -> Result<Vec<EncodedNode>, RegionError> {
    let updates: Vec<StateUpdate> = selection
        .leaves
        .iter()
        .filter(|leaf| leaf.selected)
        .map(|leaf| StateUpdate::new(leaf.source_triangle, &leaf.path, target))
        .collect();
    apply_updates(channel, selection, &updates)
}

/// `applyFacetRefinedStateUpdates`: disjoint per-leaf targets, as refined Gap
/// Fill needs, then every now-homogeneous branch collapsed
/// (`remove_useless_children()`). The selection is checked as the browser
/// checks a host's: tree shape and budgets, then its leaf list.
pub fn apply_updates(
    channel: Channel,
    selection: &RefinedSelection,
    updates: &[StateUpdate],
) -> Result<Vec<EncodedNode>, RegionError> {
    let encoded = commit_leaves(channel, selection)?;
    let available: BTreeSet<(u32, Vec<u8>)> = encoded
        .iter()
        .map(|(source, path, _)| (*source, path.clone()))
        .collect();
    let mut targets: BTreeMap<(u32, Vec<u8>), RegionState> = Default::default();
    let mut issues = Vec::new();
    for (index, update) in updates.iter().enumerate() {
        let path = format!("updates[{index}]");
        let in_range = safe_integer(update.source_triangle)
            && update.source_triangle >= 0.0
            && update.source_triangle < selection.roots.len() as f64
            && update
                .path
                .iter()
                .all(|&child| safe_integer(child) && (0.0..=3.0).contains(&child));
        if !in_range {
            issues.push(Issue::new(
                "invalid-refined-leaf-reference",
                path,
                "Refined leaf references require an in-range source triangle and child path",
            ));
            continue;
        }
        if !region_state_valid(channel, &update.target) {
            issues.push(Issue::new(
                "invalid-facet-refinement-state",
                format!("{path}.target"),
                format!(
                    "Refined leaf target is invalid for the {} channel",
                    channel.name()
                ),
            ));
            continue;
        }
        let key = (
            update.source_triangle as u32,
            update.path.iter().map(|&p| p as u8).collect::<Vec<_>>(),
        );
        if !available.contains(&key) {
            issues.push(Issue::new(
                "missing-refined-leaf",
                path,
                "Refined leaf update does not resolve to a leaf in this selector result",
            ));
            continue;
        }
        if targets.contains_key(&key) {
            issues.push(Issue::new(
                "duplicate-refined-leaf-update",
                path,
                "A refined leaf may be updated at most once per commit",
            ));
            continue;
        }
        targets.insert(key, update.target.clone());
    }
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    Ok(selection
        .roots
        .iter()
        .enumerate()
        .map(|(source, root)| apply_node_updates(root, source as u32, &mut Vec::new(), &targets))
        .collect())
}

fn apply_node_updates(
    node: &EncodedNode,
    source: u32,
    path: &mut Vec<u8>,
    targets: &BTreeMap<(u32, Vec<u8>), RegionState>,
) -> EncodedNode {
    match node {
        EncodedNode::Leaf(state) => EncodedNode::Leaf(
            targets
                .get(&(source, path.clone()))
                .unwrap_or(state)
                .clone(),
        ),
        EncodedNode::Split {
            split_sides,
            special_side,
            children,
        } => {
            let children: Vec<EncodedNode> = children
                .iter()
                .enumerate()
                .map(|(i, child)| {
                    path.push(i as u8);
                    let node = apply_node_updates(child, source, path, targets);
                    path.pop();
                    node
                })
                .collect();
            if let Some(EncodedNode::Leaf(first)) = children.first()
                && children
                    .iter()
                    .all(|c| matches!(c, EncodedNode::Leaf(state) if state == first))
            {
                return EncodedNode::Leaf(first.clone());
            }
            EncodedNode::Split {
                split_sides: *split_sides,
                special_side: *special_side,
                children,
            }
        }
    }
}

/// `validateRefinedCommitSelection` over a typed selection: the encoded tree's
/// shape and budget, then its leaves against the selection's leaf list.
fn commit_leaves(
    channel: Channel,
    selection: &RefinedSelection,
) -> Result<Vec<(u32, Vec<u8>, RegionState)>, RegionError> {
    let budget = node_budget(selection.roots.len() as f64);
    let mut issues = Vec::new();
    let mut encoded = Vec::new();
    let mut stack: Vec<(&EncodedNode, u32, Vec<u8>, usize)> = selection
        .roots
        .iter()
        .enumerate()
        .map(|(source, node)| (node, source as u32, Vec::new(), 0))
        .rev()
        .collect();
    let mut count = 0.0;
    while let Some((node, source, path, depth)) = stack.pop() {
        count += 1.0;
        if count > budget {
            issues.push(Issue::new(
                "facet-refinement-limit-exceeded",
                "selection.encoding",
                format!(
                    "Facet refinement may contain at most {} nodes",
                    js_number(budget)
                ),
            ));
            break;
        }
        let node_path = format!(
            "selection.encoding.roots[{source}]{}",
            path.iter()
                .map(|c| format!(".children[{c}]"))
                .collect::<String>()
        );
        match node {
            EncodedNode::Leaf(state) => {
                if region_state_valid(channel, state) {
                    encoded.push((source, path, state.clone()));
                } else {
                    issues.push(Issue::new(
                        "invalid-facet-refinement-state",
                        format!("{node_path}.state"),
                        format!(
                            "Refined leaf state is invalid for the {} channel",
                            channel.name()
                        ),
                    ));
                }
            }
            EncodedNode::Split {
                split_sides,
                special_side,
                children,
            } => {
                if !(1..=3).contains(split_sides)
                    || *special_side > 2
                    || (*split_sides == 3 && *special_side != 0)
                    || children.len() != usize::from(*split_sides) + 1
                {
                    issues.push(Issue::new(
                        "invalid-facet-refinement-split",
                        node_path,
                        "Refined split topology is invalid",
                    ));
                    continue;
                }
                if depth >= MAX_DEPTH {
                    issues.push(Issue::new(
                        "facet-refinement-limit-exceeded",
                        node_path,
                        format!("Facet refinement may contain at most {MAX_DEPTH} split levels"),
                    ));
                    continue;
                }
                for (i, child) in children.iter().enumerate().rev() {
                    let mut child_path = path.clone();
                    child_path.push(i as u8);
                    stack.push((child, source, child_path, depth + 1));
                }
            }
        }
    }
    if issues.is_empty() && selection.leaves.len() != encoded.len() {
        issues.push(Issue::new(
            "invalid-refined-selection-leaves",
            "selection.leaves",
            "Refined selection leaf list must cover every encoded leaf exactly once",
        ));
    }
    if issues.is_empty() {
        for (index, leaf) in selection.leaves.iter().enumerate() {
            let matches = encoded.get(index).is_some_and(|(source, path, state)| {
                leaf.source_triangle == *source && &leaf.path == path && &leaf.state == state
            });
            if !matches {
                issues.push(Issue::new(
                    "invalid-refined-selection-leaves",
                    format!("selection.leaves[{index}]"),
                    "Refined selection leaves must match deterministic encoded leaf order and state",
                ));
            }
        }
    }
    if !issues.is_empty() {
        return Err(RegionError::Invalid(issues));
    }
    Ok(encoded)
}

fn region_state_valid(channel: Channel, state: &RegionState) -> bool {
    match state {
        RegionState::Unpainted => true,
        RegionState::Assigned(value) => channel_value(channel, value),
    }
}
