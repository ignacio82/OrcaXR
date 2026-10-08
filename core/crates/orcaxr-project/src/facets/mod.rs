//! Sparse facet paint and bounded subdivision trees. Canonical storage keeps
//! only subdivided source facets; dense roots are an explicitly budgeted,
//! temporary editing representation. This is computation, not a project codec.
pub mod overlay;
pub mod paint_stroke;
pub mod palette;
pub mod region;
pub mod region_exchange;
pub mod stroke;
mod validation;
pub use validation::{Issue, ValidationOptions, validate_refinement};

use orcaxr_contracts::canonical::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub const ENCODING_VERSION: u32 = 2;
pub const MAX_DEPTH: usize = 64;
pub const MIN_NODE_BUDGET: f64 = 1_000_000.0;
pub const NODES_PER_TRIANGLE: f64 = 32.0;

/// The reference's per-channel expansion budget. Import owners apply separate
/// package-wide encoded-byte, refinement-node and annotation budgets.
pub fn node_budget(triangle_count: f64) -> f64 {
    if triangle_count.is_nan() {
        return f64::NAN;
    }
    MIN_NODE_BUDGET.max(triangle_count.trunc().max(0.0) * NODES_PER_TRIANGLE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Color,
    Support,
    Seam,
    FuzzySkin,
    Brim,
}
impl Channel {
    pub const ALL: [Self; 5] = [
        Self::Color,
        Self::Support,
        Self::Seam,
        Self::FuzzySkin,
        Self::Brim,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Color => "color",
            Self::Support => "support",
            Self::Seam => "seam",
            Self::FuzzySkin => "fuzzySkin",
            Self::Brim => "brim",
        }
    }
    fn accepts_raw(self, value: &Value, filaments: Option<&BTreeSet<Vec<u16>>>) -> bool {
        match (self, value) {
            (Self::Color, Value::String(text)) => filaments.is_none_or(|ids| ids.contains(text)),
            (Self::Support, Value::String(text)) => {
                text_eq(text, "enforce") || text_eq(text, "block")
            }
            (Self::Seam, Value::String(text)) => text_eq(text, "prefer") || text_eq(text, "avoid"),
            (Self::FuzzySkin, Value::Bool(true)) | (Self::Brim, Value::Bool(_)) => true,
            _ => false,
        }
    }
    fn accepts(self, value: &PaintValue, filaments: Option<&BTreeSet<Vec<u16>>>) -> bool {
        match (self, value) {
            (Self::Color, PaintValue::Text(text)) => {
                filaments.is_none_or(|ids| ids.contains(text.as_ref()))
            }
            (Self::Support, PaintValue::Text(text)) => {
                text_eq(text, "enforce") || text_eq(text, "block")
            }
            (Self::Seam, PaintValue::Text(text)) => {
                text_eq(text, "prefer") || text_eq(text, "avoid")
            }
            (Self::FuzzySkin, PaintValue::Bool(true)) | (Self::Brim, PaintValue::Bool(_)) => true,
            _ => false,
        }
    }
}

/// All five persisted paint channels use only text or boolean values. Text is
/// immutable UTF-16; cloning an assignment never copies a filament identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum PaintValue {
    Text(Arc<[u16]>),
    Bool(bool),
}
impl PaintValue {
    pub fn text(value: impl Into<Arc<[u16]>>) -> Self {
        Self::Text(value.into())
    }
    pub fn to_value(&self) -> Value {
        match self {
            Self::Text(v) => Value::String(v.to_vec()),
            Self::Bool(v) => Value::Bool(*v),
        }
    }
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::String(v) => Some(Self::Text(v.as_slice().into())),
            Value::Bool(v) => Some(Self::Bool(*v)),
            _ => None,
        }
    }
    fn canonical_key(&self) -> Vec<u16> {
        let mut bytes = Vec::new();
        self.to_value()
            .write_canonical(&mut bytes)
            .expect("finite paint scalar");
        String::from_utf8(bytes)
            .expect("canonical UTF-8")
            .encode_utf16()
            .collect()
    }
}

/// Finite nonnegative ECMAScript integer. Keeping binary64 avoids introducing a
/// new safe-integer/32-bit persisted limit. Dense materialization is separately
/// checked against an explicit host budget and addressable allocation length.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Triangle(f64);
impl Triangle {
    pub fn new(value: f64) -> Result<Self, FacetError> {
        if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
            return Err(FacetError::InvalidTriangle);
        }
        Ok(Self(if value == 0.0 { 0.0 } else { value }))
    }
    pub fn number(self) -> f64 {
        self.0
    }
}
impl Eq for Triangle {}
impl Ord for Triangle {
    fn cmp(&self, rhs: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&rhs.0)
    }
}
impl PartialOrd for Triangle {
    fn partial_cmp(&self, rhs: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(rhs))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Unpainted,
    Assigned(PaintValue),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Leaf(State),
    Split {
        split_sides: u8,
        special_side: u8,
        children: Vec<Node>,
    },
}
/// Private construction keeps every tree acyclic and at most 64 split levels.
/// Access is read-only; shared mutable/cyclic JavaScript nodes have no analogue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    kind: NodeKind,
    depth: usize,
}
impl Node {
    pub fn leaf(state: State) -> Self {
        Self {
            kind: NodeKind::Leaf(state),
            depth: 0,
        }
    }
    pub fn split(
        split_sides: u8,
        special_side: u8,
        children: Vec<Self>,
    ) -> Result<Self, FacetError> {
        if !(1..=3).contains(&split_sides)
            || special_side > 2
            || (split_sides == 3 && special_side != 0)
            || children.len() != usize::from(split_sides) + 1
        {
            return Err(FacetError::InvalidTopology);
        }
        let depth = 1 + children.iter().map(|v| v.depth).max().unwrap_or(0);
        if depth > MAX_DEPTH {
            return Err(FacetError::DepthLimit);
        }
        Ok(Self {
            kind: NodeKind::Split {
                split_sides,
                special_side,
                children,
            },
            depth,
        })
    }
    pub fn kind(&self) -> &NodeKind {
        &self.kind
    }
    pub fn to_value(&self) -> Value {
        match &self.kind {
            NodeKind::Leaf(state) => {
                object([("kind", string("leaf")), ("state", state_value(state))])
            }
            NodeKind::Split {
                split_sides,
                special_side,
                children,
            } => object([
                ("kind", string("split")),
                ("splitSides", Value::Number(f64::from(*split_sides))),
                ("specialSide", Value::Number(f64::from(*special_side))),
                (
                    "children",
                    Value::Array(children.iter().map(Self::to_value).collect()),
                ),
            ]),
        }
    }
    /// A selector node from JSON with exactly its fields: kinds, topology and
    /// scalar paint values. Whether a value suits its channel is the
    /// validators' concern, as in the browser's refined commit.
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Object(fields) = value else {
            return None;
        };
        if is_text(field(value, "kind"), "leaf") {
            let state = field(value, "state")?;
            let Value::Object(state_fields) = state else {
                return None;
            };
            if fields.len() != 2 {
                return None;
            }
            let state = if is_text(field(state, "kind"), "unpainted") && state_fields.len() == 1 {
                State::Unpainted
            } else if is_text(field(state, "kind"), "assigned") && state_fields.len() == 2 {
                State::Assigned(PaintValue::from_value(field(state, "value")?)?)
            } else {
                return None;
            };
            return Some(Self::leaf(state));
        }
        if !is_text(field(value, "kind"), "split") || fields.len() != 4 {
            return None;
        }
        let sides = number(field(value, "splitSides"))?;
        let special = number(field(value, "specialSide"))?;
        if !(0.0..=3.0).contains(&sides)
            || sides.fract() != 0.0
            || !(0.0..=2.0).contains(&special)
            || special.fract() != 0.0
        {
            return None;
        }
        let children = array(field(value, "children"))?
            .iter()
            .map(Self::from_value)
            .collect::<Option<Vec<_>>>()?;
        Self::split(sides as u8, special as u8, children).ok()
    }
    fn from_validated(value: &Value) -> Self {
        if is_text(field(value, "kind"), "leaf") {
            let state = field(value, "state").expect("validated state");
            Self::leaf(if is_text(field(state, "kind"), "unpainted") {
                State::Unpainted
            } else {
                State::Assigned(
                    PaintValue::from_value(field(state, "value").expect("validated value"))
                        .expect("validated paint scalar"),
                )
            })
        } else {
            Self::split(
                number(field(value, "splitSides")).unwrap() as u8,
                number(field(value, "specialSide")).unwrap() as u8,
                array(field(value, "children"))
                    .unwrap()
                    .iter()
                    .map(Self::from_validated)
                    .collect(),
            )
            .expect("validated topology")
        }
    }
    fn normalize(self) -> Self {
        let NodeKind::Split {
            split_sides,
            special_side,
            children,
        } = self.kind
        else {
            return self;
        };
        let children: Vec<_> = children.into_iter().map(Self::normalize).collect();
        if let NodeKind::Leaf(first) = &children[0].kind
            && children
                .iter()
                .all(|v| matches!(&v.kind, NodeKind::Leaf(state) if state == first))
        {
            return Self::leaf(first.clone());
        }
        Self::split(split_sides, special_side, children)
            .expect("normalization cannot deepen a tree")
    }
    fn map(&self, remap: &mut impl FnMut(&PaintValue) -> PaintValue) -> Self {
        match &self.kind {
            NodeKind::Leaf(State::Unpainted) => Self::leaf(State::Unpainted),
            NodeKind::Leaf(State::Assigned(value)) => Self::leaf(State::Assigned(remap(value))),
            NodeKind::Split {
                split_sides,
                special_side,
                children,
            } => Self::split(
                *split_sides,
                *special_side,
                children.iter().map(|v| v.map(remap)).collect(),
            )
            .expect("mapping preserves topology"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub value: PaintValue,
    pub triangles: Vec<Triangle>,
}
impl Assignment {
    pub fn to_value(&self) -> Value {
        object([
            ("value", self.value.to_value()),
            (
                "triangles",
                Value::Array(self.triangles.iter().map(|v| Value::Number(v.0)).collect()),
            ),
        ])
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub triangle: Triangle,
    pub node: Node,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoding {
    triangle_count: Triangle,
    splits: Vec<Split>,
}
impl Encoding {
    pub fn triangle_count(&self) -> Triangle {
        self.triangle_count
    }
    pub fn splits(&self) -> &[Split] {
        &self.splits
    }
    pub fn split_at(&self, triangle: Triangle) -> Option<&Node> {
        self.splits
            .binary_search_by_key(&triangle, |v| v.triangle)
            .ok()
            .map(|i| &self.splits[i].node)
    }
    pub fn to_value(&self) -> Value {
        object([
            ("version", Value::Number(f64::from(ENCODING_VERSION))),
            ("triangleCount", Value::Number(self.triangle_count.0)),
            (
                "splits",
                Value::Array(
                    self.splits
                        .iter()
                        .map(|v| {
                            object([
                                ("triangle", Value::Number(v.triangle.0)),
                                ("node", v.node.to_value()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
    pub fn visit_assigned(&self, mut visitor: impl FnMut(&PaintValue, &str)) {
        fn walk(node: &Node, path: &str, visitor: &mut impl FnMut(&PaintValue, &str)) {
            match &node.kind {
                NodeKind::Leaf(State::Assigned(value)) => {
                    visitor(value, &format!("{path}.state.value"))
                }
                NodeKind::Leaf(State::Unpainted) => {}
                NodeKind::Split { children, .. } => {
                    for (i, child) in children.iter().enumerate() {
                        walk(child, &format!("{path}.children[{i}]"), visitor);
                    }
                }
            }
        }
        for (i, split) in self.splits.iter().enumerate() {
            walk(&split.node, &format!("splits[{i}].node"), &mut visitor);
        }
    }
    pub fn assigned_leaf_count(&self) -> usize {
        fn count(node: &Node) -> usize {
            match &node.kind {
                NodeKind::Leaf(State::Assigned(_)) => 1,
                NodeKind::Leaf(State::Unpainted) => 0,
                NodeKind::Split { children, .. } => children.iter().map(count).sum(),
            }
        }
        self.splits.iter().map(|v| count(&v.node)).sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FacetError {
    InvalidTriangle,
    InvalidTopology,
    InvalidValue,
    DepthLimit,
    NodeLimit,
    DenseLimit,
    MaterializationLimit,
    AllocationFailed,
}
impl std::fmt::Display for FacetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidTriangle => "invalid facet index or count",
            Self::InvalidTopology => "invalid facet split topology",
            Self::InvalidValue => "invalid facet channel value",
            Self::DepthLimit => "facet split depth exceeds limit",
            Self::NodeLimit => "facet node expansion exceeds limit",
            Self::DenseLimit => "dense facet roots exceed the host budget",
            Self::MaterializationLimit => {
                "facet annotation materialization exceeds the host budget"
            }
            Self::AllocationFailed => "cannot allocate dense facet roots",
        })
    }
}
impl std::error::Error for FacetError {}

/// A validated computation view of one channel. It does not own mesh bytes or
/// replace the complete persisted annotations object (including unknown fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetChannel {
    channel: Channel,
    triangle_count: Triangle,
    assignments: Vec<Assignment>,
    encoding: Option<Encoding>,
}
impl FacetChannel {
    pub fn assignments(&self) -> &[Assignment] {
        &self.assignments
    }
    pub fn encoding(&self) -> Option<&Encoding> {
        self.encoding.as_ref()
    }
    pub fn triangle_count(&self) -> Triangle {
        self.triangle_count
    }
    /// Validates borrowed canonical values before constructing an owned view.
    /// No stateless JSON parser or its depth/size budgets is applied here.
    pub fn decode(
        channel: Channel,
        assignments: &Value,
        encoding: Option<&Value>,
        options: &ValidationOptions<'_>,
    ) -> Result<Self, Vec<Issue>> {
        let options = &ValidationOptions {
            require_split: true,
            ..*options
        };
        let mut issues = validation::validate_assignments(channel, assignments, options);
        if let Some(value) = encoding {
            issues.extend(validate_refinement(channel, value, assignments, options));
        }
        if Triangle::new(options.triangle_count).is_err() {
            issues.push(Issue::new(
                "invalid-triangle-count",
                options.path,
                "Triangle count must be a finite non-negative integer",
            ));
        }
        if !issues.is_empty() {
            return Err(issues);
        }
        let triangle_count = Triangle::new(options.triangle_count).unwrap();
        let assignments = array(Some(assignments))
            .unwrap()
            .iter()
            .map(|v| Assignment {
                value: PaintValue::from_value(field(v, "value").unwrap()).unwrap(),
                triangles: array(field(v, "triangles"))
                    .unwrap()
                    .iter()
                    .map(|v| Triangle::new(number(Some(v)).unwrap()).unwrap())
                    .collect(),
            })
            .collect();
        let encoding = encoding.map(|v| Encoding {
            triangle_count,
            splits: array(field(v, "splits"))
                .unwrap()
                .iter()
                .map(|split| Split {
                    triangle: Triangle::new(number(field(split, "triangle")).unwrap()).unwrap(),
                    node: Node::from_validated(field(split, "node").unwrap()),
                })
                .collect(),
        });
        Ok(Self {
            channel,
            triangle_count,
            assignments,
            encoding,
        })
    }
    pub fn to_value(&self) -> Value {
        let mut fields = BTreeMap::from([(
            "assignments".encode_utf16().collect(),
            Value::Array(self.assignments.iter().map(Assignment::to_value).collect()),
        )]);
        if let Some(encoding) = &self.encoding {
            fields.insert("encoding".encode_utf16().collect(), encoding.to_value());
        }
        Value::Object(fields)
    }
    /// Count the sparse records and tree nodes an annotation serializer must
    /// materialize. This matches the project importer's shared annotation-work
    /// budget without expanding every mesh triangle into a dense root array.
    pub fn checked_materialization_units(&self) -> Option<usize> {
        let assignments = self
            .assignments
            .iter()
            .try_fold(0usize, |total, assignment| {
                total
                    .checked_add(1)?
                    .checked_add(assignment.triangles.len())
            })?;
        self.encoding
            .as_ref()
            .map_or(Some(assignments), |encoding| {
                encoding
                    .splits
                    .iter()
                    .try_fold(assignments, |total, split| {
                        total.checked_add(node_units(&split.node)?)
                    })
            })
    }
    /// Consumes a temporary selector result and preserves every collapsed value.
    pub fn from_roots(
        channel: Channel,
        roots: Vec<Node>,
        filaments: Option<&BTreeSet<Vec<u16>>>,
    ) -> Result<Self, FacetError> {
        let triangle_count = Triangle::new(roots.len() as f64)?;
        validate_nodes(channel, roots.iter(), triangle_count.0, filaments)?;
        let mut groups = BTreeMap::new();
        let mut splits = Vec::new();
        for (i, root) in roots.into_iter().enumerate() {
            let triangle = Triangle(i as f64);
            match root.normalize() {
                Node {
                    kind: NodeKind::Leaf(State::Assigned(value)),
                    ..
                } => add_group(&mut groups, triangle, value),
                Node {
                    kind: NodeKind::Leaf(State::Unpainted),
                    ..
                } => {}
                node => splits.push(Split { triangle, node }),
            }
        }
        Ok(Self {
            channel,
            triangle_count,
            assignments: sorted_groups(groups),
            encoding: (!splits.is_empty()).then_some(Encoding {
                triangle_count,
                splits,
            }),
        })
    }
    /// Consume only explicitly decoded roots, in strictly increasing source
    /// triangle order. Missing facets stay unpainted without a dense root array.
    /// Uniform splits normalize into whole-facet assignments exactly as in the
    /// dense selector path. Import owners separately budget decoding/expansion.
    pub fn from_sparse_roots(
        channel: Channel,
        triangle_count: Triangle,
        roots: Vec<Split>,
        filaments: Option<&BTreeSet<Vec<u16>>>,
    ) -> Result<Self, FacetError> {
        Self::from_sparse_roots_with_budget(channel, triangle_count, roots, filaments, usize::MAX)
    }
    /// As `from_sparse_roots`, while refusing before sparse annotation records
    /// exceed the caller's materialization budget.
    pub fn from_sparse_roots_with_budget(
        channel: Channel,
        triangle_count: Triangle,
        roots: Vec<Split>,
        filaments: Option<&BTreeSet<Vec<u16>>>,
        maximum_materialization_units: usize,
    ) -> Result<Self, FacetError> {
        let mut previous = None;
        for root in &roots {
            if root.triangle >= triangle_count || previous.is_some_and(|p| root.triangle <= p) {
                return Err(FacetError::InvalidTriangle);
            }
            previous = Some(root.triangle);
        }
        validate_nodes(
            channel,
            roots.iter().map(|r| &r.node),
            triangle_count.0,
            filaments,
        )?;
        let mut groups = BTreeMap::new();
        let mut splits = Vec::new();
        let mut materialization_units = 0usize;
        for Split { triangle, node } in roots {
            match node.normalize() {
                Node {
                    kind: NodeKind::Leaf(State::Assigned(value)),
                    ..
                } => {
                    let new_group = !groups.contains_key(&value);
                    charge_materialization(
                        &mut materialization_units,
                        1 + usize::from(new_group),
                        maximum_materialization_units,
                    )?;
                    add_group(&mut groups, triangle, value);
                }
                Node {
                    kind: NodeKind::Leaf(State::Unpainted),
                    ..
                } => {}
                node => {
                    charge_materialization(
                        &mut materialization_units,
                        node_units(&node).ok_or(FacetError::MaterializationLimit)?,
                        maximum_materialization_units,
                    )?;
                    splits
                        .try_reserve(1)
                        .map_err(|_| FacetError::AllocationFailed)?;
                    splits.push(Split { triangle, node });
                }
            }
        }
        Ok(Self {
            channel,
            triangle_count,
            assignments: sorted_groups(groups),
            encoding: (!splits.is_empty()).then_some(Encoding {
                triangle_count,
                splits,
            }),
        })
    }
    /// The caller supplies the maximum temporary root count; a large declared
    /// mesh count alone never requests an unbounded native allocation.
    pub fn expand(&self, maximum_roots: usize) -> Result<Vec<Node>, FacetError> {
        let count = self.triangle_count.0;
        if count >= usize::MAX as f64 || count > maximum_roots as f64 {
            return Err(FacetError::DenseLimit);
        }
        let count = count as usize;
        if count > maximum_roots {
            return Err(FacetError::DenseLimit);
        }
        let mut roots = Vec::new();
        roots
            .try_reserve_exact(count)
            .map_err(|_| FacetError::AllocationFailed)?;
        roots.resize_with(count, || Node::leaf(State::Unpainted));
        for assignment in &self.assignments {
            for triangle in &assignment.triangles {
                roots[triangle.0 as usize] = Node::leaf(State::Assigned(assignment.value.clone()));
            }
        }
        if let Some(encoding) = &self.encoding {
            for split in &encoding.splits {
                roots[split.triangle.0 as usize] = split.node.clone();
            }
        }
        Ok(roots)
    }
    /// Maps both sparse halves atomically. A split that becomes uniform moves
    /// into the whole-facet assignments instead of silently losing its paint.
    pub fn remap(
        &self,
        mut remap: impl FnMut(&PaintValue) -> PaintValue,
        filaments: Option<&BTreeSet<Vec<u16>>>,
    ) -> Result<Self, FacetError> {
        let mut values = BTreeMap::new();
        for assignment in &self.assignments {
            let value = remap(&assignment.value);
            if !self.channel.accepts(&value, filaments) {
                return Err(FacetError::InvalidValue);
            }
            for triangle in &assignment.triangles {
                values.insert(*triangle, value.clone());
            }
        }
        let mut splits = Vec::new();
        if let Some(encoding) = &self.encoding {
            for split in &encoding.splits {
                let node = split.node.map(&mut remap);
                validate_nodes(
                    self.channel,
                    std::iter::once(&node),
                    self.triangle_count.0,
                    filaments,
                )?;
                match node.normalize() {
                    Node {
                        kind: NodeKind::Leaf(State::Assigned(value)),
                        ..
                    } => {
                        values.insert(split.triangle, value);
                    }
                    Node {
                        kind: NodeKind::Leaf(State::Unpainted),
                        ..
                    } => {
                        values.remove(&split.triangle);
                    }
                    node => splits.push(Split {
                        triangle: split.triangle,
                        node,
                    }),
                }
            }
        }
        let mut groups = BTreeMap::new();
        for (triangle, value) in values {
            add_group(&mut groups, triangle, value);
        }
        Ok(Self {
            channel: self.channel,
            triangle_count: self.triangle_count,
            assignments: sorted_groups(groups),
            encoding: (!splits.is_empty()).then_some(Encoding {
                triangle_count: self.triangle_count,
                splits,
            }),
        })
    }
    /// Whole-facet strokes discard refinement only on covered facets. The caller
    /// separately owns the stroke's replacement whole-facet assignments.
    pub fn without_splits(&self, triangles: &BTreeSet<Triangle>) -> Self {
        let mut result = self.clone();
        if let Some(encoding) = &mut result.encoding {
            encoding.splits.retain(|v| !triangles.contains(&v.triangle));
            if encoding.splits.is_empty() {
                result.encoding = None;
            }
        }
        result
    }
}

fn validate_nodes<'a>(
    channel: Channel,
    roots: impl Iterator<Item = &'a Node>,
    count: f64,
    filaments: Option<&BTreeSet<Vec<u16>>>,
) -> Result<(), FacetError> {
    let budget = node_budget(count);
    let mut nodes = 0usize;
    fn walk(
        node: &Node,
        channel: Channel,
        filaments: Option<&BTreeSet<Vec<u16>>>,
        nodes: &mut usize,
        budget: f64,
    ) -> Result<(), FacetError> {
        *nodes += 1;
        if *nodes as f64 > budget {
            return Err(FacetError::NodeLimit);
        }
        match &node.kind {
            NodeKind::Leaf(State::Assigned(value)) if !channel.accepts(value, filaments) => {
                Err(FacetError::InvalidValue)
            }
            NodeKind::Split { children, .. } => {
                for child in children {
                    walk(child, channel, filaments, nodes, budget)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    for root in roots {
        walk(root, channel, filaments, &mut nodes, budget)?;
    }
    Ok(())
}
fn node_units(node: &Node) -> Option<usize> {
    match &node.kind {
        NodeKind::Leaf(_) => Some(1),
        NodeKind::Split { children, .. } => children
            .iter()
            .try_fold(1usize, |total, child| total.checked_add(node_units(child)?)),
    }
}
fn charge_materialization(
    used: &mut usize,
    units: usize,
    maximum: usize,
) -> Result<(), FacetError> {
    *used = used
        .checked_add(units)
        .filter(|next| *next <= maximum)
        .ok_or(FacetError::MaterializationLimit)?;
    Ok(())
}

/// `collapseFacetRefinementRoots`: dense per-facet roots into sparse
/// whole-facet assignments and the subdivided facets alone, without validating
/// values (the browser's refined commit validates the result afterwards).
pub fn collapse_roots(roots: Vec<Node>) -> (Vec<Assignment>, Option<Encoding>) {
    let triangle_count = Triangle(roots.len() as f64);
    let mut groups = BTreeMap::new();
    let mut splits = Vec::new();
    for (i, root) in roots.into_iter().enumerate() {
        let triangle = Triangle(i as f64);
        match root.normalize() {
            Node {
                kind: NodeKind::Leaf(State::Assigned(value)),
                ..
            } => add_group(&mut groups, triangle, value),
            Node {
                kind: NodeKind::Leaf(State::Unpainted),
                ..
            } => {}
            node => splits.push(Split { triangle, node }),
        }
    }
    (
        sorted_groups(groups),
        (!splits.is_empty()).then_some(Encoding {
            triangle_count,
            splits,
        }),
    )
}
fn add_group(groups: &mut BTreeMap<PaintValue, Assignment>, triangle: Triangle, value: PaintValue) {
    groups
        .entry(value.clone())
        .or_insert_with(|| Assignment {
            value,
            triangles: Vec::new(),
        })
        .triangles
        .push(triangle);
}
fn sorted_groups(groups: BTreeMap<PaintValue, Assignment>) -> Vec<Assignment> {
    let mut assignments: Vec<_> = groups.into_values().collect();
    // Serialize one key per distinct paint value, never per assigned triangle.
    assignments.sort_by_cached_key(|assignment| assignment.value.canonical_key());
    assignments
}

fn state_value(state: &State) -> Value {
    match state {
        State::Unpainted => object([("kind", string("unpainted"))]),
        State::Assigned(value) => {
            object([("kind", string("assigned")), ("value", value.to_value())])
        }
    }
}
fn string(value: &str) -> Value {
    Value::String(value.encode_utf16().collect())
}
fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    if let Value::Object(fields) = value {
        // All internal field names are short ASCII constants. No allocation
        // is needed for each property of each refinement node.
        let mut units = [0u16; 32];
        assert!(name.is_ascii() && name.len() <= units.len());
        for (unit, byte) in units.iter_mut().zip(name.bytes()) {
            *unit = u16::from(byte);
        }
        fields.get(&units[..name.len()])
    } else {
        None
    }
}
fn number(value: Option<&Value>) -> Option<f64> {
    if let Some(Value::Number(v)) = value {
        Some(*v)
    } else {
        None
    }
}
fn array(value: Option<&Value>) -> Option<&[Value]> {
    if let Some(Value::Array(v)) = value {
        Some(v)
    } else {
        None
    }
}
fn text_eq(value: &[u16], text: &str) -> bool {
    value.iter().copied().eq(text.encode_utf16())
}
fn is_text(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(v)) if text_eq(v, text))
}
