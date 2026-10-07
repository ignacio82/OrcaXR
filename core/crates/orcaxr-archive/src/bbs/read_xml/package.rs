//! Bounded ZIP-to-structural-model staging for foreign 3MF packages.
//!
//! This is an import seam, not canonical project admission: BBS metadata and
//! asset construction remain owned by later stages. Parsed paint and unknown
//! extension attributes stay bounded. No result escapes unless every required
//! model part's archive integrity, XML stream and cross-part graph pass limits.
use super::{Failure, Limits as XmlLimits, Scanner, graph, part, project_settings};
use crate::{Archive, Error as ArchiveError};
use orcaxr_project::ingress::json::JsonLimits;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{Read, Seek},
};

pub const ROOT_MODEL_PATH: &str = "3D/3dmodel.model";
pub const PROJECT_SETTINGS_PATH: &str = "Metadata/project_settings.config";
pub use super::project_settings::ProjectSettings;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Applied independently to each decompressed model part.
    pub xml: XmlLimits,
    /// Aggregate geometry/title/facet/extension budgets shared across parts.
    pub part: part::Limits,
    pub graph: graph::Limits,
    pub model_parts: usize,
    pub model_bytes: u64,
    /// Maximum expanded bytes retained from `project_settings.config`.
    pub project_settings_bytes: usize,
    /// Explicit JSON node/text/depth limits for project settings.
    pub project_settings_json: JsonLimits,
}

#[derive(Debug)]
pub struct Package {
    /// Root and referenced external parts only; unrelated `.model` members are
    /// left to the archive owner's preserved-member policy.
    pub parts: BTreeMap<String, part::Part>,
    pub graph: graph::ResolvedGraph,
    pub model_bytes: u64,
    /// Parsed BBS project configuration, when the standard member is present.
    pub project_settings: Option<ProjectSettings>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Archive(ArchiveError),
    Xml(Failure),
    Part(part::Error),
    Graph(graph::Error),
    Limits,
    MissingRootPart,
    ModelPathMismatch,
    ProjectSettings(project_settings::Error),
    Allocation,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Default)]
struct Usage {
    objects: usize,
    vertices: usize,
    triangles: usize,
    components: usize,
    build_items: usize,
    materials: usize,
    title_text_units: usize,
    facet_encoded_bytes: usize,
    facet_refinement_nodes: usize,
    facet_materialization_units: usize,
    extension_attribute_count: usize,
    extension_attribute_text_units: usize,
}
impl Usage {
    fn from_part(value: &part::Part) -> Result<Self, Error> {
        let mut usage = Self {
            objects: value.objects.len(),
            build_items: value.build.len(),
            materials: value.materials.len(),
            title_text_units: value.title_text_units,
            facet_encoded_bytes: value.facet_encoded_bytes,
            facet_refinement_nodes: value.facet_refinement_nodes,
            facet_materialization_units: value.facet_materialization_units,
            extension_attribute_count: value.extension_attribute_count,
            extension_attribute_text_units: value.extension_attribute_text_units,
            ..Self::default()
        };
        for object in &value.objects {
            usage.components = usage
                .components
                .checked_add(object.components.len())
                .ok_or(Error::Limits)?;
            if let Some(mesh) = &object.mesh {
                usage.vertices = usage
                    .vertices
                    .checked_add(mesh.positions.len())
                    .ok_or(Error::Limits)?;
                usage.triangles = usage
                    .triangles
                    .checked_add(mesh.triangles.len())
                    .ok_or(Error::Limits)?;
            }
        }
        Ok(usage)
    }
    fn debit(self, remaining: &mut part::Limits) -> Result<(), Error> {
        remaining.objects = remaining
            .objects
            .checked_sub(self.objects)
            .ok_or(Error::Limits)?;
        remaining.vertices = remaining
            .vertices
            .checked_sub(self.vertices)
            .ok_or(Error::Limits)?;
        remaining.triangles = remaining
            .triangles
            .checked_sub(self.triangles)
            .ok_or(Error::Limits)?;
        remaining.components = remaining
            .components
            .checked_sub(self.components)
            .ok_or(Error::Limits)?;
        remaining.build_items = remaining
            .build_items
            .checked_sub(self.build_items)
            .ok_or(Error::Limits)?;
        remaining.materials = remaining
            .materials
            .checked_sub(self.materials)
            .ok_or(Error::Limits)?;
        remaining.title_text_units = remaining
            .title_text_units
            .checked_sub(self.title_text_units)
            .ok_or(Error::Limits)?;
        remaining.facet_encoded_bytes = remaining
            .facet_encoded_bytes
            .checked_sub(self.facet_encoded_bytes)
            .ok_or(Error::Limits)?;
        remaining.facet_refinement_nodes = remaining
            .facet_refinement_nodes
            .checked_sub(self.facet_refinement_nodes)
            .ok_or(Error::Limits)?;
        remaining.facet_materialization_units = remaining
            .facet_materialization_units
            .checked_sub(self.facet_materialization_units)
            .ok_or(Error::Limits)?;
        remaining.extension_attribute_count = remaining
            .extension_attribute_count
            .checked_sub(self.extension_attribute_count)
            .ok_or(Error::Limits)?;
        remaining.extension_attribute_text_units = remaining
            .extension_attribute_text_units
            .checked_sub(self.extension_attribute_text_units)
            .ok_or(Error::Limits)?;
        Ok(())
    }
}

/// Stream and structurally admit only the root model and referenced external
/// model parts. Archive CRC/decompression, XML syntax and semantic admission are
/// all required before a `Package` is returned.
pub fn read_model_structure<R: Read + Seek, C: FnMut() -> bool>(
    archive: &mut Archive<R>,
    limits: Limits,
    cancelled: C,
) -> Result<Package, Error> {
    if limits.xml.input_bytes == 0
        || limits.xml.text_units == 0
        || limits.xml.token_bytes == 0
        || limits.xml.elements == 0
        || limits.xml.attributes == 0
        || limits.xml.depth == 0
        || limits.model_parts == 0
        || limits.model_bytes == 0
        || limits.graph.parts < 1
    {
        return Err(Error::Limits);
    }
    let cancel = RefCell::new(cancelled);
    let root_index = archive
        .entries()
        .iter()
        .position(|entry| !entry.is_directory() && entry.path() == ROOT_MODEL_PATH)
        .ok_or(Error::MissingRootPart)?;
    let root_bytes = archive.entries()[root_index].bytes();
    if root_bytes > limits.model_bytes {
        return Err(Error::Limits);
    }
    let mut remaining = limits.part;
    let root = read_part(
        archive,
        root_index,
        ROOT_MODEL_PATH,
        true,
        limits,
        &mut remaining,
        &cancel,
    )?;
    let mut parts = BTreeMap::new();
    parts.insert(ROOT_MODEL_PATH.to_owned(), root);
    let mut bytes = root_bytes;
    let mut paths = parts[ROOT_MODEL_PATH]
        .objects
        .iter()
        .flat_map(|object| object.components.iter())
        .filter_map(|component| component.model_path.as_deref())
        .chain(
            parts[ROOT_MODEL_PATH]
                .build
                .iter()
                .filter_map(|item| item.model_path.as_deref()),
        )
        .map(|raw| graph::normalize_production_path(raw, ROOT_MODEL_PATH).map_err(Error::Graph))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    paths.dedup();
    if paths.len().saturating_add(1) > limits.model_parts {
        return Err(Error::Limits);
    }
    for path in paths {
        let Some(index) = archive
            .entries()
            .iter()
            .position(|entry| !entry.is_directory() && entry.path() == path)
        else {
            // Leave absence represented in `parts`; graph admission reports the
            // same missing referenced part as browser model import.
            continue;
        };
        bytes = bytes
            .checked_add(archive.entries()[index].bytes())
            .filter(|total| *total <= limits.model_bytes)
            .ok_or(Error::Limits)?;
        let parsed = read_part(
            archive,
            index,
            &path,
            false,
            limits,
            &mut remaining,
            &cancel,
        )?;
        parts.insert(path, parsed);
    }
    let graph = graph::resolve(ROOT_MODEL_PATH, &parts, limits.graph).map_err(Error::Graph)?;
    let project_settings = read_project_settings(archive, limits, &cancel)?;
    Ok(Package {
        parts,
        graph,
        model_bytes: bytes,
        project_settings,
    })
}

fn read_project_settings<R: Read + Seek, C: FnMut() -> bool>(
    archive: &mut Archive<R>,
    limits: Limits,
    cancelled: &RefCell<C>,
) -> Result<Option<ProjectSettings>, Error> {
    let Some(index) = archive
        .entries()
        .iter()
        .position(|entry| !entry.is_directory() && entry.path() == PROJECT_SETTINGS_PATH)
    else {
        return Ok(None);
    };
    let length = usize::try_from(archive.entries()[index].bytes()).map_err(|_| Error::Limits)?;
    if length > limits.project_settings_bytes {
        return Err(Error::Limits);
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| Error::Allocation)?;
    match archive.read_entry(index, &mut bytes, || (cancelled.borrow_mut())()) {
        Ok(_) => {}
        Err(ArchiveError::Cancelled) => return Err(Error::Cancelled),
        Err(error) => return Err(Error::Archive(error)),
    }
    project_settings::parse(&bytes, limits.project_settings_json, limits.xml, || {
        (cancelled.borrow_mut())()
    })
    .map(Some)
    .map_err(|error| match error {
        project_settings::Error::Cancelled => Error::Cancelled,
        error => Error::ProjectSettings(error),
    })
}

fn read_part<R: Read + Seek, C: FnMut() -> bool>(
    archive: &mut Archive<R>,
    index: usize,
    path: &str,
    allow_external_paths: bool,
    limits: Limits,
    remaining: &mut part::Limits,
    cancelled: &RefCell<C>,
) -> Result<part::Part, Error> {
    let entry = archive.entries().get(index).ok_or(Error::MissingRootPart)?;
    if entry.path() != path {
        return Err(Error::ModelPathMismatch);
    }
    if entry.bytes() > limits.xml.input_bytes as u64 || entry.bytes() > limits.model_bytes {
        return Err(Error::Limits);
    }
    let mut builder = part::Builder::new(*remaining, allow_external_paths).map_err(Error::Part)?;
    let mut scanner = Scanner::new(
        limits.xml,
        || (cancelled.borrow_mut())(),
        |event| builder.event_with_cancel(event, || (cancelled.borrow_mut())()),
    );
    let read = archive.read_entry(index, &mut scanner, || (cancelled.borrow_mut())());
    let scan = scanner.finish();
    match scan {
        Err(super::Error::Input(Failure::Cancelled)) => return Err(Error::Cancelled),
        Err(super::Error::Input(error)) => return Err(Error::Xml(error)),
        Err(super::Error::Visitor(part::Error::Facet(crate::bbs::facets::Error::Cancelled))) => {
            return Err(Error::Cancelled);
        }
        Err(super::Error::Visitor(error)) => return Err(Error::Part(error)),
        Ok(_) => {}
    }
    read.map_err(Error::Archive)?;
    let parsed = builder.finish().map_err(Error::Part)?;
    Usage::from_part(&parsed)?.debit(remaining)?;
    Ok(parsed)
}
