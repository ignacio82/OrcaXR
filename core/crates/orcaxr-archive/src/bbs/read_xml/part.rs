//! Bounded streaming projection of the structural 3MF model vocabulary.
//!
//! This layer deliberately does not resolve component graphs or project BBS
//! settings/model metadata. It owns one model part's IDs, geometry, sparse paint
//! and bounded unknown extension attributes; callers must not publish it unless
//! the XML scanner's `finish()` succeeds.
use super::{Event, Tag, decode_text};
use crate::bbs::facets::{self, DecodeBudget, Error as FacetError};
use orcaxr_project::facets::{Channel, FacetChannel, Node, PaintValue, Split, Triangle};
use std::{collections::BTreeSet, str::FromStr, sync::Arc};

pub const PRODUCTION_NAMESPACE: &str =
    "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Limits,
    Allocation,
    Structure,
    DuplicateObjectId,
    InvalidId,
    InvalidNumber,
    InvalidTransform,
    InvalidMeshIndex,
    Annotation,
    UnsupportedUnit,
    EmptyComponents,
    Facet(FacetError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Micron,
    Millimeter,
    Centimeter,
    Inch,
    Foot,
    Meter,
}
impl Unit {
    pub fn from_xml(value: Option<&str>) -> Result<Self, Error> {
        match value.unwrap_or("millimeter").to_ascii_lowercase().as_str() {
            "micron" => Ok(Self::Micron),
            "millimeter" => Ok(Self::Millimeter),
            "centimeter" => Ok(Self::Centimeter),
            "inch" => Ok(Self::Inch),
            "foot" => Ok(Self::Foot),
            "meter" => Ok(Self::Meter),
            _ => Err(Error::UnsupportedUnit),
        }
    }
    pub fn scale_mm(self) -> f64 {
        match self {
            Self::Micron => 0.001,
            Self::Millimeter => 1.0,
            Self::Centimeter => 10.0,
            Self::Inch => 25.4,
            Self::Foot => 304.8,
            Self::Meter => 1000.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    /// Coordinates are converted to millimeters and rounded to binary32 in
    /// source order, matching the browser's packed indexed-mesh asset.
    pub positions: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub annotations: MeshAnnotations,
    pub facet_extension_attributes: Vec<FacetExtensionAttributes>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionAttribute {
    pub namespace: String,
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FacetExtensionAttributes {
    pub triangle: usize,
    pub attributes: Vec<ExtensionAttribute>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeshAnnotations {
    pub color: FacetChannel,
    pub support: FacetChannel,
    pub seam: FacetChannel,
    pub fuzzy_skin: FacetChannel,
}
impl MeshAnnotations {
    pub fn empty(triangle_count: usize) -> Result<Self, Error> {
        let triangle_count =
            Triangle::new(triangle_count as f64).map_err(|_| Error::InvalidMeshIndex)?;
        Self::from_roots(
            triangle_count,
            std::array::from_fn(|_| Vec::new()),
            usize::MAX,
        )
        .map(|(annotations, _)| annotations)
    }
    fn from_roots(
        triangle_count: Triangle,
        roots: [Vec<Split>; 4],
        maximum_materialization_units: usize,
    ) -> Result<(Self, usize), Error> {
        let [color, support, seam, fuzzy_skin] = roots;
        let mut remaining = maximum_materialization_units;
        let color = FacetChannel::from_sparse_roots_with_budget(
            Channel::Color,
            triangle_count,
            color,
            None,
            remaining,
        )
        .map_err(map_facet_channel_error)?;
        debit_materialization(&mut remaining, &color)?;
        let support = FacetChannel::from_sparse_roots_with_budget(
            Channel::Support,
            triangle_count,
            support,
            None,
            remaining,
        )
        .map_err(map_facet_channel_error)?;
        debit_materialization(&mut remaining, &support)?;
        let seam = FacetChannel::from_sparse_roots_with_budget(
            Channel::Seam,
            triangle_count,
            seam,
            None,
            remaining,
        )
        .map_err(map_facet_channel_error)?;
        debit_materialization(&mut remaining, &seam)?;
        let fuzzy_skin = FacetChannel::from_sparse_roots_with_budget(
            Channel::FuzzySkin,
            triangle_count,
            fuzzy_skin,
            None,
            remaining,
        )
        .map_err(map_facet_channel_error)?;
        debit_materialization(&mut remaining, &fuzzy_skin)?;
        let used = maximum_materialization_units
            .checked_sub(remaining)
            .ok_or(Error::Limits)?;
        Ok((
            Self {
                color,
                support,
                seam,
                fuzzy_skin,
            },
            used,
        ))
    }
    pub fn checked_materialization_units(&self) -> Option<usize> {
        [&self.color, &self.support, &self.seam, &self.fuzzy_skin]
            .into_iter()
            .try_fold(0usize, |total, channel| {
                total.checked_add(channel.checked_materialization_units()?)
            })
    }
}

fn map_facet_channel_error(error: orcaxr_project::facets::FacetError) -> Error {
    match error {
        orcaxr_project::facets::FacetError::MaterializationLimit => Error::Limits,
        orcaxr_project::facets::FacetError::AllocationFailed => Error::Allocation,
        _ => Error::Annotation,
    }
}

fn debit_materialization(remaining: &mut usize, channel: &FacetChannel) -> Result<(), Error> {
    *remaining = remaining
        .checked_sub(
            channel
                .checked_materialization_units()
                .ok_or(Error::Limits)?,
        )
        .ok_or(Error::Limits)?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Material {
    pub name: String,
    pub display_color: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Component {
    pub object_id: u64,
    /// Production Extension paths are still raw until the package owner
    /// resolves them against this part's OPC name.
    pub model_path: Option<String>,
    /// Row-major affine 4x4 matrix, with translation already scaled to mm.
    pub transform: [f64; 16],
    pub extension_attributes: Vec<ExtensionAttribute>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    pub id: u64,
    pub name: String,
    pub material_index: Option<usize>,
    pub mesh: Option<Mesh>,
    pub components: Vec<Component>,
    pub extension_attributes: Vec<ExtensionAttribute>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct BuildItem {
    pub object_id: u64,
    pub model_path: Option<String>,
    pub transform: [f64; 16],
    pub printable: bool,
    pub extension_attributes: Vec<ExtensionAttribute>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub title: String,
    /// Raw UTF-16 title-content units before entity decoding, for package-wide
    /// input accounting. Ignored XML spans inside the title count as spaces.
    pub title_text_units: usize,
    pub unit: Unit,
    pub materials: Vec<Material>,
    /// XML order is retained. Object IDs are local to this model part.
    pub objects: Vec<Object>,
    pub build: Vec<BuildItem>,
    pub facet_encoded_bytes: usize,
    pub facet_refinement_nodes: usize,
    pub facet_materialization_units: usize,
    pub extension_attribute_count: usize,
    pub extension_attribute_text_units: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub objects: usize,
    pub vertices: usize,
    pub triangles: usize,
    pub components: usize,
    pub build_items: usize,
    pub materials: usize,
    pub title_text_units: usize,
    /// Aggregate encoded paint-attribute bytes across this package.
    pub facet_encoded_bytes: usize,
    /// Aggregate nodes decoded from explicit BBS facet roots.
    pub facet_refinement_nodes: usize,
    /// Sparse annotation records/tree nodes materialized for canonical state.
    pub facet_materialization_units: usize,
    /// Aggregate unknown object/component/build/facet attributes retained.
    pub extension_attribute_count: usize,
    /// Aggregate UTF-16 units retained for unknown attribute names and values.
    pub extension_attribute_text_units: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Root,
    MetadataTitle,
    Resources,
    Build,
    Materials,
    Base,
    Object,
    Mesh,
    Vertices,
    Vertex,
    Triangles,
    Triangle,
    Components,
    Component,
    Item,
    Other,
}
struct Frame {
    qualified_name: String,
    kind: Kind,
}
struct MeshBuilder {
    positions: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    facet_roots: [Vec<Split>; 4],
    facet_extension_attributes: Vec<FacetExtensionAttributes>,
    annotations: Option<MeshAnnotations>,
}
struct ObjectBuilder {
    id: u64,
    name: String,
    material_index: Option<usize>,
    mesh: Option<MeshBuilder>,
    components: Option<Vec<Component>>,
    extension_attributes: Vec<ExtensionAttribute>,
}

/// Event consumer for one model part. Construct it with caller-owned limits,
/// pass events directly from `Scanner`, finish the scanner, then call `finish`.
pub struct Builder {
    limits: Limits,
    allow_external_paths: bool,
    stack: Vec<Frame>,
    root_seen: bool,
    root_closed: bool,
    resources_seen: bool,
    build_seen: bool,
    title_seen: bool,
    unit: Unit,
    title_raw: String,
    title: String,
    title_units: usize,
    materials: Vec<Material>,
    objects: Vec<Object>,
    object_ids: BTreeSet<u64>,
    current_object: Option<ObjectBuilder>,
    build: Vec<BuildItem>,
    vertices: usize,
    triangles: usize,
    components: usize,
    facet_budget: DecodeBudget,
    facet_encoded_bytes: usize,
    facet_refinement_nodes: usize,
    facet_materialization_units: usize,
    extension_attribute_count: usize,
    extension_attribute_text_units: usize,
}
impl Builder {
    pub fn new(limits: Limits, allow_external_paths: bool) -> Result<Self, Error> {
        let facet_budget =
            DecodeBudget::new(limits.facet_refinement_nodes).map_err(Error::Facet)?;
        Ok(Self {
            limits,
            allow_external_paths,
            stack: Vec::new(),
            root_seen: false,
            root_closed: false,
            resources_seen: false,
            build_seen: false,
            title_seen: false,
            unit: Unit::Millimeter,
            title_raw: String::new(),
            title: String::new(),
            title_units: 0,
            materials: Vec::new(),
            objects: Vec::new(),
            object_ids: BTreeSet::new(),
            current_object: None,
            build: Vec::new(),
            vertices: 0,
            triangles: 0,
            components: 0,
            facet_budget,
            facet_encoded_bytes: 0,
            facet_refinement_nodes: 0,
            facet_materialization_units: 0,
            extension_attribute_count: 0,
            extension_attribute_text_units: 0,
        })
    }

    pub fn event(&mut self, event: Event<'_>) -> Result<(), Error> {
        self.event_with_cancel(event, || false)
    }
    pub fn event_with_cancel(
        &mut self,
        event: Event<'_>,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<(), Error> {
        match event {
            Event::Open(tag) => self.open(tag, &mut cancelled),
            Event::Close { name, .. } => self.close(name),
            Event::Text(raw)
                if self
                    .stack
                    .last()
                    .is_some_and(|f| f.kind == Kind::MetadataTitle) =>
            {
                self.append_title(raw)
            }
            Event::Ignored { text_units }
                if self
                    .stack
                    .last()
                    .is_some_and(|f| f.kind == Kind::MetadataTitle) =>
            {
                self.append_ignored(text_units)
            }
            Event::Text(_) | Event::Ignored { .. } => Ok(()),
        }
    }

    pub fn finish(self) -> Result<Part, Error> {
        if !self.root_seen
            || !self.root_closed
            || !self.resources_seen
            || !self.build_seen
            || !self.stack.is_empty()
            || self.current_object.is_some()
        {
            return Err(Error::Structure);
        }
        Ok(Part {
            title: self.title,
            title_text_units: self.title_units,
            unit: self.unit,
            materials: self.materials,
            objects: self.objects,
            build: self.build,
            facet_encoded_bytes: self.facet_encoded_bytes,
            facet_refinement_nodes: self.facet_refinement_nodes,
            facet_materialization_units: self.facet_materialization_units,
            extension_attribute_count: self.extension_attribute_count,
            extension_attribute_text_units: self.extension_attribute_text_units,
        })
    }

    fn open(&mut self, tag: Tag<'_>, cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
        let parent = self.stack.last().map(|frame| frame.kind);
        let local = tag.local_name();
        // The production browser projection matches unprefixed tag names. XML
        // prefixes are still admitted syntactically, but aren't guessed here.
        let unprefixed = tag.name == local;
        let mut kind = Kind::Other;
        if parent.is_none() {
            if self.root_seen || !unprefixed || !local.eq_ignore_ascii_case("model") {
                return Err(Error::Structure);
            }
            self.root_seen = true;
            self.unit = Unit::from_xml(attribute(tag, "unit", None))?;
            kind = Kind::Root;
        } else if unprefixed {
            match (parent, local.to_ascii_lowercase().as_str()) {
                (Some(Kind::Root), "metadata")
                    if attribute(tag, "name", None) == Some("Title") && !self.title_seen =>
                {
                    self.title_seen = true;
                    kind = Kind::MetadataTitle;
                }
                (Some(Kind::Root), "resources") => {
                    if self.resources_seen {
                        return Err(Error::Structure);
                    }
                    self.resources_seen = true;
                    kind = Kind::Resources;
                }
                (Some(Kind::Root), "build") => {
                    if self.build_seen {
                        return Err(Error::Structure);
                    }
                    self.build_seen = true;
                    kind = Kind::Build;
                }
                (Some(Kind::Resources), "basematerials") => kind = Kind::Materials,
                (Some(Kind::Materials), "base") => {
                    self.push_material(tag)?;
                    kind = Kind::Base;
                }
                (Some(Kind::Resources), "object") => {
                    self.begin_object(tag)?;
                    kind = Kind::Object;
                }
                (Some(Kind::Object), "mesh") => {
                    let object = self.current_object.as_mut().ok_or(Error::Structure)?;
                    if object.mesh.is_some() || object.components.is_some() {
                        return Err(Error::Structure);
                    }
                    object.mesh = Some(MeshBuilder {
                        positions: Vec::new(),
                        triangles: Vec::new(),
                        facet_roots: std::array::from_fn(|_| Vec::new()),
                        facet_extension_attributes: Vec::new(),
                        annotations: None,
                    });
                    kind = Kind::Mesh;
                }
                (Some(Kind::Mesh), "vertices") => kind = Kind::Vertices,
                (Some(Kind::Vertices), "vertex") => {
                    self.push_vertex(tag)?;
                    kind = Kind::Vertex;
                }
                (Some(Kind::Mesh), "triangles") => kind = Kind::Triangles,
                (Some(Kind::Triangles), "triangle") => {
                    self.push_triangle(tag, cancelled)?;
                    kind = Kind::Triangle;
                }
                (Some(Kind::Object), "components") => {
                    let object = self.current_object.as_mut().ok_or(Error::Structure)?;
                    if object.mesh.is_some() || object.components.is_some() {
                        return Err(Error::Structure);
                    }
                    object.components = Some(Vec::new());
                    kind = Kind::Components;
                }
                (Some(Kind::Components), "component") => {
                    self.push_component(tag)?;
                    kind = Kind::Component;
                }
                (Some(Kind::Build), "item") => {
                    self.push_item(tag)?;
                    kind = Kind::Item;
                }
                _ => {}
            }
        }
        self.reserve_stack()?;
        let frame = Frame {
            qualified_name: tag.name.to_owned(),
            kind,
        };
        let qualified_name = frame.qualified_name.clone();
        self.stack.push(frame);
        if tag.self_closing {
            self.close(&qualified_name)?;
        }
        Ok(())
    }

    fn close(&mut self, qualified_name: &str) -> Result<(), Error> {
        let frame = self.stack.pop().ok_or(Error::Structure)?;
        if frame.qualified_name != qualified_name {
            return Err(Error::Structure);
        }
        match frame.kind {
            Kind::Root => self.root_closed = true,
            Kind::MetadataTitle => {
                self.title =
                    decode_text(&self.title_raw, usize::MAX).map_err(|_| Error::Structure)?;
                self.title_raw.clear();
            }
            Kind::Object => self.end_object()?,
            Kind::Mesh => self.validate_mesh()?,
            Kind::Components => {
                if self
                    .current_object
                    .as_ref()
                    .and_then(|object| object.components.as_ref())
                    .is_some_and(Vec::is_empty)
                {
                    return Err(Error::EmptyComponents);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn begin_object(&mut self, tag: Tag<'_>) -> Result<(), Error> {
        if self.current_object.is_some() || self.objects.len() >= self.limits.objects {
            return Err(Error::Limits);
        }
        let id = required_id(attribute(tag, "id", None))?;
        if !self.object_ids.insert(id) {
            return Err(Error::DuplicateObjectId);
        }
        let name = match attribute(tag, "name", None) {
            Some(name) => self.owned_text(name)?,
            None => format!("Object {id}"),
        };
        let material_index = attribute(tag, "pindex", None)
            .map(parse_index)
            .transpose()?;
        let extension_attributes = self.retain_extension_attributes(
            tag,
            &[
                "id",
                "type",
                "name",
                "pid",
                "pindex",
                "thumbnail",
                "partnumber",
            ],
            false,
        )?;
        self.current_object = Some(ObjectBuilder {
            id,
            name,
            material_index,
            mesh: None,
            components: None,
            extension_attributes,
        });
        Ok(())
    }

    fn end_object(&mut self) -> Result<(), Error> {
        let object = self.current_object.take().ok_or(Error::Structure)?;
        let has_components = object.components.is_some();
        let mesh = object
            .mesh
            .map(|mesh| {
                Ok(Mesh {
                    positions: mesh.positions,
                    triangles: mesh.triangles,
                    annotations: mesh.annotations.ok_or(Error::Structure)?,
                    facet_extension_attributes: mesh.facet_extension_attributes,
                })
            })
            .transpose()?;
        let components = object.components.unwrap_or_default();
        if mesh.is_some() == has_components || (has_components && components.is_empty()) {
            return Err(Error::Structure);
        }
        reserve(&mut self.objects, 1, self.limits.objects)?;
        self.objects.push(Object {
            id: object.id,
            name: object.name,
            material_index: object.material_index,
            mesh,
            components,
            extension_attributes: object.extension_attributes,
        });
        Ok(())
    }

    fn validate_mesh(&mut self) -> Result<(), Error> {
        let mesh = self
            .current_object
            .as_ref()
            .and_then(|object| object.mesh.as_ref())
            .ok_or(Error::Structure)?;
        if mesh
            .triangles
            .iter()
            .flatten()
            .any(|&index| index as usize >= mesh.positions.len())
        {
            return Err(Error::InvalidMeshIndex);
        }
        let triangle_count =
            Triangle::new(mesh.triangles.len() as f64).map_err(|_| Error::InvalidMeshIndex)?;
        let roots = {
            let mesh = self
                .current_object
                .as_mut()
                .and_then(|object| object.mesh.as_mut())
                .ok_or(Error::Structure)?;
            std::array::from_fn(|channel| std::mem::take(&mut mesh.facet_roots[channel]))
        };
        let remaining_materialization_units = self
            .limits
            .facet_materialization_units
            .checked_sub(self.facet_materialization_units)
            .ok_or(Error::Limits)?;
        let (annotations, materialization_units) =
            MeshAnnotations::from_roots(triangle_count, roots, remaining_materialization_units)?;
        self.facet_materialization_units = self
            .facet_materialization_units
            .checked_add(materialization_units)
            .filter(|value| *value <= self.limits.facet_materialization_units)
            .ok_or(Error::Limits)?;
        let mesh = self
            .current_object
            .as_mut()
            .and_then(|object| object.mesh.as_mut())
            .ok_or(Error::Structure)?;
        mesh.annotations = Some(annotations);
        Ok(())
    }

    fn push_vertex(&mut self, tag: Tag<'_>) -> Result<(), Error> {
        let unit = self.unit.scale_mm();
        let mut position = [0.0f32; 3];
        for (axis, name) in ["x", "y", "z"].into_iter().enumerate() {
            let raw = attribute(tag, name, None).ok_or(Error::InvalidNumber)?;
            let value = js_number(raw)? * unit;
            if !value.is_finite() {
                return Err(Error::InvalidNumber);
            }
            position[axis] = value as f32;
            if !position[axis].is_finite() {
                return Err(Error::InvalidNumber);
            }
        }
        let mesh = self
            .current_object
            .as_mut()
            .and_then(|object| object.mesh.as_mut())
            .ok_or(Error::Structure)?;
        self.vertices = self.vertices.checked_add(1).ok_or(Error::Limits)?;
        if self.vertices > self.limits.vertices {
            return Err(Error::Limits);
        }
        reserve(&mut mesh.positions, 1, self.limits.vertices)?;
        mesh.positions.push(position);
        Ok(())
    }

    fn push_triangle(
        &mut self,
        tag: Tag<'_>,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        let indices = ["v1", "v2", "v3"].map(|name| {
            attribute(tag, name, None)
                .ok_or(Error::InvalidMeshIndex)
                .and_then(parse_index)
        });
        let triangle = [indices[0]?, indices[1]?, indices[2]?];
        let triangle_index = self
            .current_object
            .as_ref()
            .and_then(|object| object.mesh.as_ref())
            .ok_or(Error::Structure)?
            .triangles
            .len();
        self.triangles = self.triangles.checked_add(1).ok_or(Error::Limits)?;
        if self.triangles > self.limits.triangles {
            return Err(Error::Limits);
        }
        let fuzzy = attribute(tag, "paint_fuzzy_skin", None)
            .filter(|value| !value.is_empty())
            .map(|_| "paint_fuzzy_skin")
            .or_else(|| attribute(tag, "paint_fuzzy", None).map(|_| "paint_fuzzy"));
        let roots = [
            self.decode_facet(tag, "paint_color", Channel::Color, cancelled)?,
            self.decode_facet(tag, "paint_supports", Channel::Support, cancelled)?,
            self.decode_facet(tag, "paint_seam", Channel::Seam, cancelled)?,
            fuzzy
                .map(|name| self.decode_facet(tag, name, Channel::FuzzySkin, cancelled))
                .transpose()?
                .flatten(),
        ];
        let mut known = ["v1", "v2", "v3", "", "", "", ""];
        let mut known_count = 3;
        for (index, name) in [
            Some("paint_color"),
            Some("paint_supports"),
            Some("paint_seam"),
            fuzzy,
        ]
        .into_iter()
        .enumerate()
        {
            if roots[index].is_some() {
                known[known_count] = name.ok_or(Error::Structure)?;
                known_count += 1;
            }
        }
        let extension_attributes =
            self.retain_extension_attributes(tag, &known[..known_count], false)?;
        let mesh = self
            .current_object
            .as_mut()
            .and_then(|object| object.mesh.as_mut())
            .ok_or(Error::Structure)?;
        reserve(&mut mesh.triangles, 1, self.limits.triangles)?;
        mesh.triangles.push(triangle.map(|value| value as u32));
        let triangle = Triangle::new(triangle_index as f64).map_err(|_| Error::InvalidMeshIndex)?;
        for (index, root) in roots.into_iter().enumerate() {
            if let Some(node) = root {
                let values = &mut mesh.facet_roots[index];
                values.try_reserve(1).map_err(|_| Error::Allocation)?;
                values.push(Split { triangle, node });
            }
        }
        if !extension_attributes.is_empty() {
            mesh.facet_extension_attributes
                .try_reserve(1)
                .map_err(|_| Error::Allocation)?;
            mesh.facet_extension_attributes
                .push(FacetExtensionAttributes {
                    triangle: triangle_index,
                    attributes: extension_attributes,
                });
        }
        Ok(())
    }

    fn decode_facet(
        &mut self,
        tag: Tag<'_>,
        name: &str,
        channel: Channel,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<Option<Node>, Error> {
        let Some(encoded) = attribute(tag, name, None) else {
            return Ok(None);
        };
        self.facet_encoded_bytes = self
            .facet_encoded_bytes
            .checked_add(encoded.len())
            .ok_or(Error::Limits)?;
        if self.facet_encoded_bytes > self.limits.facet_encoded_bytes {
            return Err(Error::Limits);
        }
        let remaining_before = self.facet_budget.remaining_nodes();
        let root = facets::decode(
            encoded.as_bytes(),
            self.limits.facet_encoded_bytes,
            &mut self.facet_budget,
            |state| facet_assignment(channel, state),
            &mut *cancelled,
        )
        .map_err(Error::Facet)?;
        let consumed = remaining_before
            .checked_sub(self.facet_budget.remaining_nodes())
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(Error::Limits)?;
        self.facet_refinement_nodes = self
            .facet_refinement_nodes
            .checked_add(consumed)
            .ok_or(Error::Limits)?;
        Ok(Some(root))
    }

    fn push_component(&mut self, tag: Tag<'_>) -> Result<(), Error> {
        let object_id = required_id(attribute(tag, "objectid", None))?;
        let model_path = self.production_path(tag)?;
        let transform = parse_transform(attribute(tag, "transform", None), self.unit.scale_mm())?;
        let extension_attributes =
            self.retain_extension_attributes(tag, &["objectid", "transform"], true)?;
        let components = self
            .current_object
            .as_mut()
            .and_then(|object| object.components.as_mut())
            .ok_or(Error::Structure)?;
        self.components = self.components.checked_add(1).ok_or(Error::Limits)?;
        if self.components > self.limits.components {
            return Err(Error::Limits);
        }
        reserve(components, 1, self.limits.components)?;
        components.push(Component {
            object_id,
            model_path,
            transform,
            extension_attributes,
        });
        Ok(())
    }

    fn push_item(&mut self, tag: Tag<'_>) -> Result<(), Error> {
        if self.build.len() >= self.limits.build_items {
            return Err(Error::Limits);
        }
        let object_id = required_id(attribute(tag, "objectid", None))?;
        let model_path = self.production_path(tag)?;
        let transform = parse_transform(attribute(tag, "transform", None), self.unit.scale_mm())?;
        let extension_attributes =
            self.retain_extension_attributes(tag, &["objectid", "transform", "printable"], true)?;
        reserve(&mut self.build, 1, self.limits.build_items)?;
        self.build.push(BuildItem {
            object_id,
            model_path,
            transform,
            printable: attribute(tag, "printable", None) != Some("0"),
            extension_attributes,
        });
        Ok(())
    }

    fn push_material(&mut self, tag: Tag<'_>) -> Result<(), Error> {
        if self.materials.len() >= self.limits.materials {
            return Err(Error::Limits);
        }
        let name = match attribute(tag, "name", None) {
            Some(name) => self.owned_text(name)?,
            None => format!("Imported tool {}", self.materials.len() + 1),
        };
        let display_color = match attribute(tag, "displaycolor", None) {
            Some(color) => self.owned_text(color)?,
            None => "#CCCCCC".to_owned(),
        };
        reserve(&mut self.materials, 1, self.limits.materials)?;
        self.materials.push(Material {
            name,
            display_color,
        });
        Ok(())
    }

    fn production_path(&self, tag: Tag<'_>) -> Result<Option<String>, Error> {
        let path = tag
            .attributes()
            .find(|attribute| {
                attribute.namespace == Some(PRODUCTION_NAMESPACE) && attribute.local_name == "path"
            })
            .map(|attribute| attribute.value);
        if path.is_some() && !self.allow_external_paths {
            return Err(Error::Structure);
        }
        path.map(|path| self.owned_text(path)).transpose()
    }

    fn retain_extension_attributes(
        &mut self,
        tag: Tag<'_>,
        known_unqualified: &[&str],
        omit_production_path: bool,
    ) -> Result<Vec<ExtensionAttribute>, Error> {
        const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
        const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";
        let mut retained = Vec::new();
        for attribute in tag.attributes() {
            if attribute.namespace == Some(XML_NAMESPACE)
                || attribute.namespace == Some(XMLNS_NAMESPACE)
                || (attribute.namespace.is_none()
                    && known_unqualified.contains(&attribute.local_name))
                || (omit_production_path
                    && attribute.namespace == Some(PRODUCTION_NAMESPACE)
                    && attribute.local_name == "path")
            {
                continue;
            }
            let text_units = attribute
                .namespace
                .map_or(0, |value| value.encode_utf16().count())
                .checked_add(attribute.local_name.encode_utf16().count())
                .and_then(|total| total.checked_add(attribute.value.encode_utf16().count()))
                .ok_or(Error::Limits)?;
            self.extension_attribute_count = self
                .extension_attribute_count
                .checked_add(1)
                .filter(|count| *count <= self.limits.extension_attribute_count)
                .ok_or(Error::Limits)?;
            self.extension_attribute_text_units = self
                .extension_attribute_text_units
                .checked_add(text_units)
                .filter(|units| *units <= self.limits.extension_attribute_text_units)
                .ok_or(Error::Limits)?;
            retained.try_reserve(1).map_err(|_| Error::Allocation)?;
            retained.push(ExtensionAttribute {
                namespace: attribute
                    .namespace
                    .map(copy_text)
                    .transpose()?
                    .unwrap_or_default(),
                name: copy_text(attribute.local_name)?,
                value: copy_text(attribute.value)?,
            });
        }
        Ok(retained)
    }

    fn append_title(&mut self, value: &str) -> Result<(), Error> {
        let units = value.encode_utf16().count();
        self.title_units = self.title_units.checked_add(units).ok_or(Error::Limits)?;
        if self.title_units > self.limits.title_text_units {
            return Err(Error::Limits);
        }
        self.title_raw
            .try_reserve(value.len())
            .map_err(|_| Error::Allocation)?;
        self.title_raw.push_str(value);
        Ok(())
    }
    fn append_ignored(&mut self, units: usize) -> Result<(), Error> {
        self.title_units = self.title_units.checked_add(units).ok_or(Error::Limits)?;
        if self.title_units > self.limits.title_text_units {
            return Err(Error::Limits);
        }
        self.title_raw
            .try_reserve(units)
            .map_err(|_| Error::Allocation)?;
        self.title_raw.extend(std::iter::repeat_n(' ', units));
        Ok(())
    }
    fn owned_text(&self, value: &str) -> Result<String, Error> {
        if value.encode_utf16().count() > self.limits.title_text_units {
            return Err(Error::Limits);
        }
        let mut owned = String::new();
        owned
            .try_reserve(value.len())
            .map_err(|_| Error::Allocation)?;
        owned.push_str(value);
        Ok(owned)
    }
    fn reserve_stack(&mut self) -> Result<(), Error> {
        self.stack.try_reserve(1).map_err(|_| Error::Allocation)
    }
}

fn facet_assignment(channel: Channel, state: u8) -> Option<PaintValue> {
    match (channel, state) {
        (Channel::Color, 1..=64) => Some(paint_text(&format!("import:3mf:paint-slot-{state}"))),
        (Channel::Support, 1) => Some(paint_text("enforce")),
        (Channel::Support, 2) => Some(paint_text("block")),
        (Channel::Seam, 1) => Some(paint_text("prefer")),
        (Channel::Seam, 2) => Some(paint_text("avoid")),
        (Channel::FuzzySkin, 1) => Some(PaintValue::Bool(true)),
        _ => None,
    }
}

fn paint_text(value: &str) -> PaintValue {
    PaintValue::text(Arc::<[u16]>::from(value.encode_utf16().collect::<Vec<_>>()))
}

fn attribute<'a>(tag: Tag<'a>, name: &str, namespace: Option<&str>) -> Option<&'a str> {
    tag.attributes()
        .find(|attribute| attribute.local_name == name && attribute.namespace == namespace)
        .map(|attribute| attribute.value)
}
fn reserve<T>(values: &mut Vec<T>, count: usize, limit: usize) -> Result<(), Error> {
    let next = values.len().checked_add(count).ok_or(Error::Limits)?;
    if next > limit {
        return Err(Error::Limits);
    }
    values.try_reserve(count).map_err(|_| Error::Allocation)
}
fn copy_text(value: &str) -> Result<String, Error> {
    let mut owned = String::new();
    owned
        .try_reserve(value.len())
        .map_err(|_| Error::Allocation)?;
    owned.push_str(value);
    Ok(owned)
}
fn required_id(value: Option<&str>) -> Result<u64, Error> {
    let value = value.ok_or(Error::InvalidId)?;
    let number = js_number(value).map_err(|_| Error::InvalidId)?;
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=MAX_SAFE).contains(&number) {
        return Err(Error::InvalidId);
    }
    Ok(number as u64)
}
fn parse_index(value: &str) -> Result<usize, Error> {
    let number = js_number(value)?;
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if !number.is_finite() || number.fract() != 0.0 || !(0.0..=MAX_SAFE).contains(&number) {
        return Err(Error::InvalidMeshIndex);
    }
    usize::try_from(number as u64).map_err(|_| Error::InvalidMeshIndex)
}
fn js_space(character: char) -> bool {
    matches!(character as u32,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn js_number(value: &str) -> Result<f64, Error> {
    let value = value.trim_matches(js_space);
    if value.is_empty() {
        return Ok(0.0);
    }
    if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return radix_number(digits, 16);
    }
    if let Some(digits) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return radix_number(digits, 2);
    }
    if let Some(digits) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return radix_number(digits, 8);
    }
    f64::from_str(value).map_err(|_| Error::InvalidNumber)
}
fn radix_number(digits: &str, radix: u32) -> Result<f64, Error> {
    if digits.is_empty() {
        return Err(Error::InvalidNumber);
    }
    let mut value = 0.0;
    for digit in digits.chars() {
        let digit = digit.to_digit(radix).ok_or(Error::InvalidNumber)?;
        value = value * f64::from(radix) + f64::from(digit);
    }
    Ok(value)
}
fn parse_transform(value: Option<&str>, unit: f64) -> Result<[f64; 16], Error> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(identity());
    };
    let values = value
        .split(js_space)
        .filter(|part| !part.is_empty())
        .map(js_number)
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() != 12 || values.iter().any(|value| !value.is_finite()) {
        return Err(Error::InvalidTransform);
    }
    let mut matrix = [0.0; 16];
    for (target, source) in [0, 1, 2, 4, 5, 6, 8, 9, 10]
        .into_iter()
        .zip([0, 3, 6, 1, 4, 7, 2, 5, 8])
    {
        matrix[target] = values[source];
    }
    for i in 0..3 {
        matrix[i * 4 + 3] = values[9 + i] * unit;
        if !matrix[i * 4 + 3].is_finite() {
            return Err(Error::InvalidTransform);
        }
    }
    matrix[15] = 1.0;
    Ok(matrix)
}
fn identity() -> [f64; 16] {
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]
}
