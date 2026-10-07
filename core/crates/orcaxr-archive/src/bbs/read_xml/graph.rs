//! Bounded cross-part reference validation and 3MF component expansion.
//!
//! Inputs are already structurally admitted `Part` values. Production paths
//! are package-member names, never filesystem paths. This module does not
//! decode BBS annotations or create canonical project records.
use super::part::{BuildItem, Component, Object, Part};
use crate::validate_package_path;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_COMPONENT_GRAPH_DEPTH: usize = 64;
pub const MAX_COMPONENT_GRAPH_EXPANSION: usize = 16_384;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub parts: usize,
    pub objects: usize,
    pub build_items: usize,
    pub references: usize,
    pub depth: usize,
    pub expansion: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            parts: 128,
            objects: 100_000,
            build_items: 100_000,
            references: 1_000_000,
            depth: MAX_COMPONENT_GRAPH_DEPTH,
            expansion: MAX_COMPONENT_GRAPH_EXPANSION,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ObjectRef {
    pub model_path: String,
    pub object_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ComponentEdgeRef {
    pub source: ObjectRef,
    pub component_index: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedLeaf {
    pub object: ObjectRef,
    /// Component transforms composed from the selected build object to this
    /// mesh leaf. The build item's transform remains on `ResolvedBuildItem`.
    pub transform: [f64; 16],
    /// Identifies the component edge that directly references this mesh. Its
    /// unknown attributes remain owned by the source part and are not copied
    /// once per expanded build occurrence.
    pub component_edge: Option<ComponentEdgeRef>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedBuildItem {
    pub item: BuildItem,
    pub object: ObjectRef,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedGraph {
    /// Sorted package paths referenced from the root model part.
    pub external_model_paths: Vec<String>,
    /// One entry per unique root object referenced by the build list.
    pub roots: BTreeMap<ObjectRef, Vec<ResolvedLeaf>>,
    /// Build order and duplicates are preserved; roots point into `roots`.
    pub build: Vec<ResolvedBuildItem>,
    pub reachable_mesh_objects: BTreeSet<ObjectRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Limits,
    Allocation,
    InvalidRootPath,
    InvalidModelPath,
    ExternalPathOnNonRoot,
    RootPathConflict,
    MissingRootPart,
    MissingPart,
    MissingObject,
    Cycle,
    Depth,
    Expansion,
    EmptyGraph,
    TransformOverflow,
}

/// Validate every reference in every supplied part, then expand the unique
/// build roots. `parts` keys are archive member paths without a leading slash.
pub fn resolve(
    root_path: &str,
    parts: &BTreeMap<String, Part>,
    limits: Limits,
) -> Result<ResolvedGraph, Error> {
    if limits.parts == 0
        || limits.objects == 0
        || limits.build_items == 0
        || limits.references == 0
        || limits.expansion == 0
        || limits.depth > MAX_COMPONENT_GRAPH_DEPTH
        || limits.expansion > MAX_COMPONENT_GRAPH_EXPANSION
        || parts.len() > limits.parts
    {
        return Err(Error::Limits);
    }
    validate_member_path(root_path).map_err(|_| Error::InvalidRootPath)?;
    if !root_path.to_ascii_lowercase().ends_with(".model") {
        return Err(Error::InvalidRootPath);
    }
    let root = parts.get(root_path).ok_or(Error::MissingRootPart)?;
    let mut object_count = 0usize;
    let mut index = BTreeMap::<ObjectRef, &Object>::new();
    let mut referenced = Vec::<ObjectRef>::new();
    let mut external_paths = BTreeSet::<String>::new();

    for (model_path, part) in parts {
        validate_member_path(model_path).map_err(|_| Error::InvalidModelPath)?;
        if !model_path.to_ascii_lowercase().ends_with(".model") {
            return Err(Error::InvalidModelPath);
        }
        object_count = object_count
            .checked_add(part.objects.len())
            .ok_or(Error::Limits)?;
        if object_count > limits.objects {
            return Err(Error::Limits);
        }
        for object in &part.objects {
            let key = ObjectRef {
                model_path: model_path.clone(),
                object_id: object.id,
            };
            if index.insert(key, object).is_some() {
                return Err(Error::MissingObject);
            }
            for component in &object.components {
                let reference =
                    reference_for(model_path, root_path, component, &mut external_paths)?;
                if referenced.len() >= limits.references {
                    return Err(Error::Limits);
                }
                referenced.try_reserve(1).map_err(|_| Error::Allocation)?;
                referenced.push(reference);
            }
        }
    }
    let root_build_count = root.build.len();
    if root_build_count > limits.build_items {
        return Err(Error::Limits);
    }
    let mut build = Vec::new();
    build
        .try_reserve(root_build_count)
        .map_err(|_| Error::Allocation)?;
    let mut root_refs = BTreeSet::new();
    for item in &root.build {
        let object = reference_for(root_path, root_path, item, &mut external_paths)?;
        if referenced.len() >= limits.references {
            return Err(Error::Limits);
        }
        referenced.try_reserve(1).map_err(|_| Error::Allocation)?;
        referenced.push(object.clone());
        root_refs.insert(object.clone());
        build.push(ResolvedBuildItem {
            item: item.clone(),
            object,
        });
    }

    for reference in referenced {
        if !parts.contains_key(&reference.model_path) {
            return Err(Error::MissingPart);
        }
        if !index.contains_key(&reference) {
            return Err(Error::MissingObject);
        }
    }

    let mut roots = BTreeMap::new();
    let mut reachable_mesh_objects = BTreeSet::new();
    let mut expansion = 0usize;
    for reference in root_refs {
        let mut leaves = Vec::new();
        let mut stack = BTreeSet::new();
        expand(
            &reference,
            identity(),
            0,
            &index,
            &mut stack,
            &mut leaves,
            &mut expansion,
            limits,
            None,
        )?;
        if leaves.is_empty() {
            return Err(Error::EmptyGraph);
        }
        for leaf in &leaves {
            reachable_mesh_objects.insert(leaf.object.clone());
        }
        roots.insert(reference, leaves);
    }

    let mut external_model_paths = external_paths.into_iter().collect::<Vec<_>>();
    external_model_paths.sort_by(|left, right| utf16_cmp(left, right));
    Ok(ResolvedGraph {
        external_model_paths,
        roots,
        build,
        reachable_mesh_objects,
    })
}

fn reference_for(
    source_path: &str,
    root_path: &str,
    reference: &impl HasReference,
    external_paths: &mut BTreeSet<String>,
) -> Result<ObjectRef, Error> {
    let model_path = match reference.model_path() {
        None => source_path.to_owned(),
        Some(_) if source_path != root_path => return Err(Error::ExternalPathOnNonRoot),
        Some(raw) => {
            let path = normalize_production_path(raw, root_path)?;
            external_paths.insert(path.clone());
            path
        }
    };
    Ok(ObjectRef {
        model_path,
        object_id: reference.object_id(),
    })
}

trait HasReference {
    fn object_id(&self) -> u64;
    fn model_path(&self) -> Option<&str>;
}
impl HasReference for Component {
    fn object_id(&self) -> u64 {
        self.object_id
    }
    fn model_path(&self) -> Option<&str> {
        self.model_path.as_deref()
    }
}
impl HasReference for BuildItem {
    fn object_id(&self) -> u64 {
        self.object_id
    }
    fn model_path(&self) -> Option<&str> {
        self.model_path.as_deref()
    }
}

pub fn normalize_production_path(raw: &str, root_path: &str) -> Result<String, Error> {
    if raw.is_empty() || raw.starts_with("//") {
        return Err(Error::InvalidModelPath);
    }
    let path = raw.strip_prefix('/').unwrap_or(raw);
    validate_member_path(path).map_err(|_| Error::InvalidModelPath)?;
    if !path.to_ascii_lowercase().ends_with(".model") {
        return Err(Error::InvalidModelPath);
    }
    if path == root_path {
        return Err(Error::RootPathConflict);
    }
    Ok(path.to_owned())
}

fn validate_member_path(path: &str) -> Result<(), crate::Error> {
    validate_package_path(path, 512)
}

#[allow(clippy::too_many_arguments)]
fn expand(
    reference: &ObjectRef,
    transform: [f64; 16],
    depth: usize,
    index: &BTreeMap<ObjectRef, &Object>,
    stack: &mut BTreeSet<ObjectRef>,
    leaves: &mut Vec<ResolvedLeaf>,
    expansion: &mut usize,
    limits: Limits,
    component_edge: Option<ComponentEdgeRef>,
) -> Result<(), Error> {
    if depth > limits.depth {
        return Err(Error::Depth);
    }
    *expansion = expansion.checked_add(1).ok_or(Error::Expansion)?;
    if *expansion > limits.expansion {
        return Err(Error::Expansion);
    }
    if stack.contains(reference) {
        return Err(Error::Cycle);
    }
    let object = index.get(reference).ok_or(Error::MissingObject)?;
    if object.mesh.is_some() {
        leaves.try_reserve(1).map_err(|_| Error::Allocation)?;
        leaves.push(ResolvedLeaf {
            object: reference.clone(),
            transform,
            component_edge,
        });
        return Ok(());
    }
    if object.components.is_empty() {
        return Err(Error::EmptyGraph);
    }
    stack.insert(reference.clone());
    for (component_index, component) in object.components.iter().enumerate() {
        let child = ObjectRef {
            model_path: component
                .model_path
                .as_deref()
                .map(|path| normalize_production_path(path, &reference.model_path))
                .transpose()?
                .unwrap_or_else(|| reference.model_path.clone()),
            object_id: component.object_id,
        };
        let composed = multiply(transform, component.transform)?;
        expand(
            &child,
            composed,
            depth + 1,
            index,
            stack,
            leaves,
            expansion,
            limits,
            Some(ComponentEdgeRef {
                source: reference.clone(),
                component_index,
            }),
        )?;
    }
    stack.remove(reference);
    Ok(())
}

fn identity() -> [f64; 16] {
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]
}

fn multiply(left: [f64; 16], right: [f64; 16]) -> Result<[f64; 16], Error> {
    let mut output = [0.0; 16];
    for row in 0..4 {
        for column in 0..4 {
            for inner in 0..4 {
                output[row * 4 + column] += left[row * 4 + inner] * right[inner * 4 + column];
            }
        }
    }
    if output.iter().any(|value| !value.is_finite()) {
        return Err(Error::TransformOverflow);
    }
    Ok(output)
}

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bbs::read_xml::part::{Mesh, Unit};

    const ROOT: &str = "3D/3dmodel.model";
    fn matrix(x: f64) -> [f64; 16] {
        let mut matrix = identity();
        matrix[3] = x;
        matrix
    }
    fn leaf(id: u64) -> Object {
        Object {
            id,
            name: format!("Leaf {id}"),
            material_index: None,
            mesh: Some(Mesh {
                positions: vec![],
                triangles: vec![],
                annotations: crate::bbs::read_xml::part::MeshAnnotations::empty(0).unwrap(),
                facet_extension_attributes: vec![],
            }),
            components: vec![],
            extension_attributes: vec![],
        }
    }
    fn assembly(id: u64, components: Vec<Component>) -> Object {
        Object {
            id,
            name: format!("Assembly {id}"),
            material_index: None,
            mesh: None,
            components,
            extension_attributes: vec![],
        }
    }
    fn component(id: u64, path: Option<&str>, x: f64) -> Component {
        Component {
            object_id: id,
            model_path: path.map(str::to_owned),
            transform: matrix(x),
            extension_attributes: vec![],
        }
    }
    fn part(objects: Vec<Object>, build: Vec<BuildItem>) -> Part {
        Part {
            title: String::new(),
            title_text_units: 0,
            unit: Unit::Millimeter,
            materials: vec![],
            objects,
            build,
            facet_encoded_bytes: 0,
            facet_refinement_nodes: 0,
            facet_materialization_units: 0,
            extension_attribute_count: 0,
            extension_attribute_text_units: 0,
        }
    }
    fn item(id: u64) -> BuildItem {
        BuildItem {
            object_id: id,
            model_path: None,
            transform: matrix(10.0),
            printable: true,
            extension_attributes: vec![],
        }
    }

    #[test]
    fn resolves_internal_and_production_paths_with_composed_component_transforms() {
        let mut parts = BTreeMap::new();
        parts.insert(
            ROOT.to_owned(),
            part(
                vec![assembly(
                    10,
                    vec![component(2, Some("/3D/Objects/Leaf.model"), 4.0)],
                )],
                vec![item(10)],
            ),
        );
        parts.insert(
            "3D/Objects/Leaf.model".to_owned(),
            part(vec![leaf(2)], vec![]),
        );
        let graph = resolve(ROOT, &parts, Limits::default()).unwrap();
        assert_eq!(graph.external_model_paths, ["3D/Objects/Leaf.model"]);
        assert_eq!(graph.build.len(), 1);
        assert_eq!(graph.roots.len(), 1);
        let resolved = &graph.roots[&ObjectRef {
            model_path: ROOT.to_owned(),
            object_id: 10,
        }];
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].object.model_path, "3D/Objects/Leaf.model");
        assert_eq!(resolved[0].object.object_id, 2);
        assert_eq!(resolved[0].transform[3], 4.0);
        assert_eq!(graph.reachable_mesh_objects.len(), 1);
    }

    #[test]
    fn rejects_cycles_missing_references_and_invalid_production_paths() {
        let mut cyclic = BTreeMap::new();
        cyclic.insert(
            ROOT.to_owned(),
            part(
                vec![
                    assembly(1, vec![component(2, None, 0.0)]),
                    assembly(2, vec![component(1, None, 0.0)]),
                ],
                vec![item(1)],
            ),
        );
        assert_eq!(resolve(ROOT, &cyclic, Limits::default()), Err(Error::Cycle));

        let mut missing = BTreeMap::new();
        missing.insert(
            ROOT.to_owned(),
            part(
                vec![assembly(
                    1,
                    vec![component(2, Some("/3D/Missing.model"), 0.0)],
                )],
                vec![item(1)],
            ),
        );
        assert_eq!(
            resolve(ROOT, &missing, Limits::default()),
            Err(Error::MissingPart)
        );

        let mut unsafe_path = BTreeMap::new();
        unsafe_path.insert(
            ROOT.to_owned(),
            part(
                vec![assembly(
                    1,
                    vec![component(2, Some("/3D/../Bad.model"), 0.0)],
                )],
                vec![item(1)],
            ),
        );
        assert_eq!(
            resolve(ROOT, &unsafe_path, Limits::default()),
            Err(Error::InvalidModelPath)
        );
    }

    #[test]
    fn graph_depth_and_expansion_are_caller_budgeted() {
        let mut nested = BTreeMap::new();
        nested.insert(
            ROOT.to_owned(),
            part(
                vec![
                    assembly(1, vec![component(2, None, 0.0)]),
                    assembly(2, vec![component(3, None, 0.0)]),
                    leaf(3),
                ],
                vec![item(1)],
            ),
        );
        let limits = Limits {
            depth: 1,
            ..Limits::default()
        };
        assert_eq!(resolve(ROOT, &nested, limits), Err(Error::Depth));
        let limits = Limits {
            expansion: 2,
            ..Limits::default()
        };
        assert_eq!(resolve(ROOT, &nested, limits), Err(Error::Expansion));
    }
}
