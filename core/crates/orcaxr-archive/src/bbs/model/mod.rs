//! Deterministic standard 3MF model projection from an admitted frozen project.
//! Owns immutable mesh leases, not a live session or completed package. Missing
//! or malformed geometry yields explicit omissions; resource/cancel/metadata
//! failures never become a successful partial projection. Host capture, complete
//! envelope/metadata/ZIP assembly and publication remain separate responsibilities.
mod attributes;
mod layout;
pub mod metadata;
mod paint;
pub mod settings;
mod write;
use super::{facets, xml};
use attributes::{Attributes, Facets, Namespaces};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::AssetLease,
    mesh::{self, Mesh},
    model::*,
    validation::ValidatedProject,
};
use paint::Paint;
use std::{collections::BTreeMap, fmt};
const NS: &str = "https://orcaxr.martinez.fyi/3mf/project/1";
pub const PATH: &str = "3D/3dmodel.model";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ResourceLimit,
    MissingPrintableArea,
    AssetMetadata,
    DuplicateAsset,
    UnexpectedAsset,
    DrawingPath,
    DrawingCollision,
    Attribute,
    FacetIndex,
    DuplicateAttribute,
    Cancelled,
    Mesh(mesh::Error),
    Xml(xml::Error),
    Paint(facets::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bbs_model_{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<xml::Error> for Error {
    fn from(e: xml::Error) -> Self {
        Self::Xml(e)
    }
}
impl From<facets::Error> for Error {
    fn from(e: facets::Error) -> Self {
        Self::Paint(e)
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    pub mesh: mesh::Limits,
    /// Combined visited graph records, declared/supplied assets and extensions.
    pub records: usize,
    /// Combined relevant UTF-16 input units, counted before copying/scanning.
    pub text_units: usize,
    pub paint_entries: usize,
    pub paint_nodes: usize,
    /// Output geometry visits, including repeated use of one shared source mesh.
    pub vertices: usize,
    pub triangles: usize,
    pub output_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshOmission {
    Missing,
    Invalid(mesh::Error),
}
/// Indices are zero-based in canonical sorted-plate/object projection order.
/// These core-model warnings describe omitted standard data, not full-package
/// metadata warnings. Canonical-envelope preservation remains mandatory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warning {
    MeshOmitted {
        object: usize,
        volume: usize,
        reason: MeshOmission,
    },
    MaterialLimit {
        count: usize,
    },
    UnavailableColor {
        object: usize,
        volume: usize,
    },
    RefinedColor {
        object: usize,
        volume: usize,
        triangle: u64,
    },
    Brim {
        object: usize,
        volume: usize,
    },
    UnavailableAssignment {
        object: usize,
        volume: Option<usize>,
    },
}
struct Budget {
    remaining: Limits,
}
impl Budget {
    fn charge(remaining: &mut usize, n: usize) -> Result<(), Error> {
        *remaining = remaining.checked_sub(n).ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn record(&mut self) -> Result<(), Error> {
        Self::charge(&mut self.remaining.records, 1)
    }
    fn text(&mut self, v: &[u16]) -> Result<(), Error> {
        Self::charge(&mut self.remaining.text_units, v.len())
    }
    fn entry(&mut self) -> Result<(), Error> {
        Self::charge(&mut self.remaining.paint_entries, 1)
    }
}
fn check(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
fn eq(units: &[u16], s: &str) -> bool {
    units.iter().copied().eq(s.encode_utf16())
}
fn field<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = v else {
        return None;
    };
    let mut key = [0; 128];
    if name.len() > key.len() {
        return None;
    }
    for (i, b) in name.bytes().enumerate() {
        key[i] = u16::from(b);
    }
    fields.get(&key[..name.len()])
}
fn array(v: Option<&Value>) -> Result<&[Value], Error> {
    match v {
        None => Ok(&[]),
        Some(Value::Array(v)) => Ok(v),
        _ => Err(Error::Attribute),
    }
}
fn text(v: Option<&Value>) -> Result<&[u16], Error> {
    match v {
        Some(Value::String(v)) => Ok(v),
        _ => Err(Error::Attribute),
    }
}
struct Material<'a> {
    name: &'a [u16],
    color: [u16; 9],
}
struct Volume<'a> {
    value: &'a ProjectVolume,
    id: usize,
    mesh: Option<Mesh>,
    attributes: Attributes<'a>,
    component: Attributes<'a>,
    facets: Facets<'a>,
    paint: Paint<'a>,
}
struct Instance<'a> {
    value: &'a ProjectInstance,
    attributes: Attributes<'a>,
}
struct Object<'a> {
    value: &'a ProjectObject,
    plate_index: usize,
    id: usize,
    origin: [f64; 2],
    attributes: Attributes<'a>,
    volumes: Vec<Volume<'a>>,
    instances: Vec<Instance<'a>>,
}
pub struct Authoring<'a> {
    state: &'a ProjectState,
    plates: Vec<&'a ProjectPlate>,
    objects: Vec<Object<'a>>,
    materials: Vec<Material<'a>>,
    slots: BTreeMap<&'a [u16], usize>,
    namespaces: Namespaces<'a>,
    material_id: usize,
    warnings: Vec<Warning>,
    limits: Limits,
    flags: [bool; 3],
}
impl<'a> Authoring<'a> {
    /// Prepare off session authority. Assets must come from the same immutable
    /// export/staging capture. Supplied leases are verified against the entire
    /// declared descriptor (including unknown fields). Descriptor equality and
    /// bounded sorts are synchronous; ingress/capture must bound their data too.
    /// The caller retains graph admission; preparation does not rehash geometry.
    pub fn new(
        project: &'a ValidatedProject,
        assets: impl IntoIterator<Item = AssetLease>,
        limits: Limits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        check(&mut cancelled)?;
        let state = project.state();
        let mut budget = Budget { remaining: limits };
        budget.text(state.name.units())?;
        let mut declarations = BTreeMap::new();
        for descriptor in state.source_assets.iter() {
            check(&mut cancelled)?;
            budget.record()?;
            budget.text(descriptor.id.as_utf16())?;
            declarations.insert(descriptor.id.as_utf16(), descriptor);
        }
        let mut supplied = BTreeMap::new();
        for asset in assets {
            check(&mut cancelled)?;
            budget.record()?;
            let descriptor = declarations
                .get(asset.id().as_utf16())
                .ok_or(Error::UnexpectedAsset)?;
            if !descriptor
                .matches_value(asset.descriptor())
                .map_err(|_| Error::AssetMetadata)?
            {
                return Err(Error::AssetMetadata);
            }
            if supplied.insert(descriptor.id.as_utf16(), asset).is_some() {
                return Err(Error::DuplicateAsset);
            }
        }
        let mut materials = Vec::new();
        let mut slots = BTreeMap::new();
        for (enabled, id, name, color) in state
            .filaments
            .physical
            .iter()
            .map(|f| (true, f.id.as_utf16(), f.name.units(), f.color.units()))
            .chain(state.filaments.mixed.iter().map(|f| {
                (
                    f.enabled,
                    f.id.as_utf16(),
                    f.name.units(),
                    f.display_color.units(),
                )
            }))
        {
            check(&mut cancelled)?;
            budget.record()?;
            if !enabled {
                continue;
            }
            budget.text(id)?;
            budget.text(name)?;
            budget.text(color)?;
            materials.push(Material {
                name,
                color: layout::color(color),
            });
            slots.insert(id, materials.len());
        }
        let mut warnings = Vec::new();
        if materials.len() > 64 {
            warnings.push(Warning::MaterialLimit {
                count: materials.len(),
            });
        }
        let mut plates = Vec::new();
        for plate in state.plates.iter() {
            budget.record()?;
            check(&mut cancelled)?;
            plates.push(plate.as_ref());
        }
        plates.sort_by(|a, b| a.order.get().partial_cmp(&b.order.get()).unwrap());
        let origins = layout::origins(state, &plates, &mut budget, &mut cancelled)?;
        let mut namespaces = Namespaces::default();
        let mut objects = Vec::new();
        let mut cache = BTreeMap::<&[u16], Result<Mesh, MeshOmission>>::new();
        let mut next = 1usize;
        let mut flags = [false; 3];
        for (plate_index, plate) in plates.iter().enumerate() {
            for object in plate.objects.iter() {
                check(&mut cancelled)?;
                budget.record()?;
                budget.text(object.id.as_utf16())?;
                budget.text(object.name.units())?;
                if let Some(id) = &object.filament_id {
                    budget.text(id.as_utf16())?;
                }
                let object_index = objects.len();
                let mut volumes = Vec::new();
                let mut instances = Vec::new();
                let attributes = attributes::read(
                    object.extension_data.as_ref(),
                    attributes::OBJECT,
                    &mut namespaces,
                    &mut budget,
                    &mut cancelled,
                )?;
                if object
                    .filament_id
                    .as_ref()
                    .is_some_and(|id| !slots.contains_key(id.as_utf16()))
                {
                    warnings.push(Warning::UnavailableAssignment {
                        object: object_index,
                        volume: None,
                    });
                }
                for (vi, volume) in object.volumes.iter().enumerate() {
                    check(&mut cancelled)?;
                    budget.record()?;
                    budget.text(volume.id.as_utf16())?;
                    budget.text(volume.name.units())?;
                    let id = next;
                    next = next.checked_add(1).ok_or(Error::ResourceLimit)?;
                    let asset_id = volume.source.asset_id.as_utf16();
                    budget.text(asset_id)?;
                    if let Some(id) = &volume.filament_id {
                        budget.text(id.as_utf16())?;
                    }
                    if !cache.contains_key(asset_id) {
                        let mesh = match supplied.get(asset_id) {
                            None => Err(MeshOmission::Missing),
                            Some(asset) => {
                                match Mesh::open(asset.clone(), limits.mesh, &mut cancelled) {
                                    Ok(mesh) => Ok(mesh),
                                    Err(
                                        e @ (mesh::Error::Limits
                                        | mesh::Error::Allocation
                                        | mesh::Error::Cancelled),
                                    ) => return Err(Error::Mesh(e)),
                                    Err(e) => Err(MeshOmission::Invalid(e)),
                                }
                            }
                        };
                        cache.insert(asset_id, mesh);
                    }
                    let mesh = match &cache[asset_id] {
                        Ok(mesh) => {
                            Budget::charge(&mut budget.remaining.vertices, mesh.vertex_count())?;
                            Budget::charge(&mut budget.remaining.triangles, mesh.triangle_count())?;
                            Some(mesh.clone())
                        }
                        Err(reason) => {
                            warnings.push(Warning::MeshOmitted {
                                object: object_index,
                                volume: vi,
                                reason: *reason,
                            });
                            None
                        }
                    };
                    if volume
                        .filament_id
                        .as_ref()
                        .is_some_and(|id| !slots.contains_key(id.as_utf16()))
                    {
                        warnings.push(Warning::UnavailableAssignment {
                            object: object_index,
                            volume: Some(vi),
                        });
                    }
                    let attributes = attributes::read(
                        volume.extension_data.as_ref(),
                        attributes::OBJECT,
                        &mut namespaces,
                        &mut budget,
                        &mut cancelled,
                    )?;
                    let component = attributes::read(
                        volume.extension_data.as_ref(),
                        attributes::COMPONENT,
                        &mut namespaces,
                        &mut budget,
                        &mut cancelled,
                    )?;
                    let facet_extensions = attributes::facets(
                        volume.extension_data.as_ref(),
                        volume.source.triangle_count.get(),
                        &mut namespaces,
                        &mut budget,
                        &mut cancelled,
                    )?;
                    if let Some(mesh) = &mesh
                        && facet_extensions
                            .iter()
                            .any(|(triangle, _)| *triangle >= mesh.triangle_count() as u64)
                    {
                        return Err(Error::FacetIndex);
                    }
                    let paint = Paint::new(
                        &volume.annotations,
                        &slots,
                        object_index,
                        vi,
                        &mut flags,
                        &mut warnings,
                        &mut budget,
                        &mut cancelled,
                    )?;
                    volumes.push(Volume {
                        value: volume,
                        id,
                        mesh,
                        attributes,
                        component,
                        facets: facet_extensions,
                        paint,
                    });
                }
                for instance in object.instances.iter() {
                    check(&mut cancelled)?;
                    budget.record()?;
                    budget.text(instance.id.as_utf16())?;
                    instances.push(Instance {
                        value: instance,
                        attributes: attributes::read(
                            instance.extension_data.as_ref(),
                            attributes::BUILD,
                            &mut namespaces,
                            &mut budget,
                            &mut cancelled,
                        )?,
                    });
                }
                let id = next;
                next = next.checked_add(1).ok_or(Error::ResourceLimit)?;
                objects.push(Object {
                    value: object,
                    plate_index,
                    id,
                    origin: origins[plate_index],
                    attributes,
                    volumes,
                    instances,
                });
            }
        }
        if next as u64 > 9_007_199_254_740_991 {
            return Err(Error::ResourceLimit);
        }
        namespaces.finish();
        check(&mut cancelled)?;
        Ok(Self {
            state,
            plates,
            objects,
            materials,
            slots,
            namespaces,
            material_id: next,
            warnings,
            limits,
            flags,
        })
    }
    pub fn warnings(&self) -> &[Warning] {
        &self.warnings
    }
}
