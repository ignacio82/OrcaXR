//! Bounded BBS object/plate metadata prepared against the exact core-model IDs.
//! Members and drawing leases are provisional: complete project settings,
//! canonical preservation, package-path/collision checks and publication belong
//! to the package owner. No project/store authority or saved checkpoint changes.
mod emboss;
mod value;
mod write;
use super::{Authoring as Model, Error, check, eq, field};
use crate::bbs::{numbers, xml};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{assets::AssetLease, model::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Member {
    ModelSettings,
    LayerRanges,
    LayerEvents,
    BrimEars,
    LayerHeights,
}
impl Member {
    pub const ALL: [Self; 5] = [
        Self::ModelSettings,
        Self::LayerRanges,
        Self::LayerEvents,
        Self::BrimEars,
        Self::LayerHeights,
    ];
    pub fn path(self) -> &'static str {
        match self {
            Self::ModelSettings => "Metadata/model_settings.config",
            Self::LayerRanges => "Metadata/layer_config_ranges.xml",
            Self::LayerEvents => "Metadata/custom_gcode_per_layer.xml",
            Self::BrimEars => "Metadata/brim_ear_points.txt",
            Self::LayerHeights => "Metadata/layer_heights_profile.txt",
        }
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    /// All visited records, declarations, supplied assets, points and profile values.
    pub records: usize,
    pub config_nodes: usize,
    /// Recursive configuration depth; clamped to 128 independently of this cap.
    pub config_depth: usize,
    /// Aggregate relevant UTF-16 units, including configuration keys/values.
    pub text_units: usize,
    /// Total bytes retained under distinct drawing paths (even shared leases).
    pub drawing_bytes: usize,
    /// Per-member output budget. The package owner also bounds aggregate output.
    pub output_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warning {
    /// Indices refer to the original canonical plate/object/volume arrays.
    MissingDrawing {
        plate: usize,
        object: usize,
        volume: usize,
    },
}
struct Budget {
    left: Limits,
}
impl Budget {
    fn charge(v: &mut usize, count: usize) -> Result<(), Error> {
        *v = v.checked_sub(count).ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn record(&mut self) -> Result<(), Error> {
        Self::charge(&mut self.left.records, 1)
    }
    fn text(&mut self, units: &[u16]) -> Result<(), Error> {
        Self::charge(&mut self.left.text_units, units.len())
    }
    fn config(
        &mut self,
        v: &Value,
        depth: usize,
        c: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        check(c)?;
        Self::charge(&mut self.left.config_nodes, 1)?;
        if depth > self.left.config_depth.min(128) {
            return Err(Error::ResourceLimit);
        }
        match v {
            Value::String(v) => self.text(v)?,
            Value::Array(values) => {
                for v in values {
                    self.config(v, depth + 1, c)?;
                }
            }
            Value::Object(values) => {
                for (key, v) in values {
                    self.text(key)?;
                    self.config(v, depth + 1, c)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
struct DrawingInput<'a> {
    drawings: BTreeMap<&'a [u16], AssetLease>,
    drawing_ids: BTreeSet<&'a [u16]>,
    warnings: Vec<Warning>,
}
/// Browser drawing gathering precedes plate-origin resolution. Reuse the same
/// policy when canonical import permits unresolved origins but must still reject
/// invalid or colliding drawings.
pub(crate) fn check_drawings(
    state: &ProjectState,
    assets: impl IntoIterator<Item = AssetLease>,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<(), Error> {
    gather_drawings(state, assets, &mut Budget { left: limits }, &mut cancelled).map(|_| ())
}
fn gather_drawings<'a>(
    state: &'a ProjectState,
    assets: impl IntoIterator<Item = AssetLease>,
    budget: &mut Budget,
    mut cancelled: &mut impl FnMut() -> bool,
) -> Result<DrawingInput<'a>, Error> {
    let mut declarations = BTreeMap::new();
    for d in state.source_assets.iter() {
        check(&mut cancelled)?;
        budget.record()?;
        budget.text(d.id.as_utf16())?;
        declarations.insert(d.id.as_utf16(), d);
    }
    let mut supplied = BTreeMap::new();
    for asset in assets {
        check(&mut cancelled)?;
        budget.record()?;
        let d = declarations
            .get(asset.id().as_utf16())
            .ok_or(Error::UnexpectedAsset)?;
        if !d
            .matches_value(asset.descriptor())
            .map_err(|_| Error::AssetMetadata)?
        {
            return Err(Error::AssetMetadata);
        }
        if supplied.insert(d.id.as_utf16(), asset).is_some() {
            return Err(Error::DuplicateAsset);
        }
    }
    let mut drawings = BTreeMap::new();
    let mut drawing_ids = BTreeSet::new();
    let mut warnings = Vec::new();
    // Gathering is in original plate order, independent of numeric model
    // IDs. Repeated paths must have identical bytes; drawings never replace
    // structural members, even ones omitted by this particular projection.
    for (pi, p) in state.plates.iter().enumerate() {
        check(&mut cancelled)?;
        budget.record()?;
        for (oi, o) in p.objects.iter().enumerate() {
            check(&mut cancelled)?;
            budget.record()?;
            for (vi, v) in o.volumes.iter().enumerate() {
                check(&mut cancelled)?;
                budget.record()?;
                if let Some(svg) = &v.emboss_svg {
                    budget.text(svg.path_in_3mf.units())?;
                    budget.text(svg.drawing_asset_id.as_utf16())?;
                    if let Some(asset) = supplied.get(svg.drawing_asset_id.as_utf16()) {
                        if svg.path_in_3mf.units().len() > 512 {
                            return Err(Error::DrawingPath);
                        }
                        let path = String::from_utf16(svg.path_in_3mf.units())
                            .map_err(|_| Error::DrawingPath)?;
                        crate::validate_package_path(&path, 512).map_err(|_| Error::DrawingPath)?;
                        if crate::canonical::STRUCTURAL.contains(&path.as_str()) {
                            return Err(Error::DrawingPath);
                        }
                        if let Some(previous) = drawings.get(svg.path_in_3mf.units()) {
                            let previous: &AssetLease = previous;
                            if previous.bytes().len() != asset.bytes().len() {
                                return Err(Error::DrawingCollision);
                            }
                            if !previous.same_record(asset) {
                                for (a, b) in previous
                                    .bytes()
                                    .chunks(crate::CHUNK_BYTES)
                                    .zip(asset.bytes().chunks(crate::CHUNK_BYTES))
                                {
                                    check(&mut cancelled)?;
                                    if a != b {
                                        return Err(Error::DrawingCollision);
                                    }
                                }
                            }
                        }
                        // Charge the live distinct-path footprint before retaining it.
                        let old = drawings
                            .get(svg.path_in_3mf.units())
                            .map_or(0, |a: &AssetLease| a.bytes().len());
                        budget.left.drawing_bytes += old;
                        Budget::charge(&mut budget.left.drawing_bytes, asset.bytes().len())?;
                        drawings.insert(svg.path_in_3mf.units(), asset.clone());
                        drawing_ids.insert(svg.drawing_asset_id.as_utf16());
                    } else {
                        warnings.push(Warning::MissingDrawing {
                            plate: pi,
                            object: oi,
                            volume: vi,
                        });
                    }
                }
            }
        }
    }
    Ok(DrawingInput {
        drawings,
        drawing_ids,
        warnings,
    })
}
pub struct Authoring<'m, 'a> {
    model: &'m Model<'a>,
    events: Vec<Vec<&'a CustomGcode>>,
    drawings: BTreeMap<&'a [u16], AssetLease>,
    drawing_ids: BTreeSet<&'a [u16]>,
    warnings: Vec<Warning>,
    limits: Limits,
}
impl<'m, 'a> Authoring<'m, 'a> {
    /// Prepare off authority from the same frozen capture used by the model.
    /// Asset membership and full descriptor equality are checked again; neither
    /// that synchronous comparison nor bounded sorting is host interruption.
    pub fn new(
        model: &'m Model<'a>,
        assets: impl IntoIterator<Item = AssetLease>,
        limits: Limits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        check(&mut cancelled)?;
        let mut budget = Budget { left: limits };
        let DrawingInput {
            drawings,
            drawing_ids,
            warnings,
        } = gather_drawings(model.state, assets, &mut budget, &mut cancelled)?;
        for object in &model.objects {
            check(&mut cancelled)?;
            if object.volumes.iter().any(|v| v.mesh.is_some()) {
                budget.text(object.value.name.units())?;
                budget.config(object.value.config.value(), 0, &mut cancelled)?;
                for volume in object.volumes.iter().filter(|v| v.mesh.is_some()) {
                    check(&mut cancelled)?;
                    budget.text(volume.value.name.units())?;
                    budget.config(volume.value.config.value(), 0, &mut cancelled)?;
                    emboss::prepare(volume.value, &mut budget)?;
                }
            }
            for range in object.value.layer_ranges.iter() {
                check(&mut cancelled)?;
                budget.record()?;
                budget.config(range.config.value(), 0, &mut cancelled)?;
            }
            if let Some(points) = &object.value.brim_ears {
                for _ in points.iter() {
                    check(&mut cancelled)?;
                    budget.record()?;
                }
            }
            if let Some(profile) = &object.value.layer_height_profile {
                for _ in profile.iter() {
                    check(&mut cancelled)?;
                    budget.record()?;
                }
            }
        }
        let mut plate_ids = BTreeMap::new();
        let mut events = Vec::new();
        for (index, plate) in model.plates.iter().enumerate() {
            check(&mut cancelled)?;
            budget.text(plate.name.units())?;
            budget.config(plate.config.value(), 0, &mut cancelled)?;
            plate_ids.insert(plate.id.as_utf16(), index);
            events.push(Vec::new());
        }
        for entry in model.state.custom_gcode.iter() {
            check(&mut cancelled)?;
            budget.record()?;
            let Some(event) = &entry.layer_event else {
                continue;
            };
            if entry.scope != GcodeScope::Plate {
                continue;
            }
            let Some(index) = entry
                .plate_id
                .as_ref()
                .and_then(|id| plate_ids.get(id.as_utf16()))
            else {
                continue;
            };
            budget.text(entry.code.units())?;
            for text in [&event.color, &event.message].into_iter().flatten() {
                budget.text(text.units())?;
            }
            events[*index].push(entry.as_ref());
        }
        for events in &mut events {
            check(&mut cancelled)?;
            events.sort_by(|a, b| {
                a.layer_event
                    .as_ref()
                    .unwrap()
                    .top_z_mm
                    .get()
                    .partial_cmp(&b.layer_event.as_ref().unwrap().top_z_mm.get())
                    .unwrap()
            });
        }
        check(&mut cancelled)?;
        Ok(Self {
            model,
            events,
            drawings,
            drawing_ids,
            warnings,
            limits,
        })
    }
    pub fn warnings(&self) -> &[Warning] {
        &self.warnings
    }
    /// Frozen bytes only; the package owner validates safe paths and collisions
    /// against its complete generated/preserved member inventory before writing.
    pub fn drawings(&self) -> impl ExactSizeIterator<Item = (&[u16], &AssetLease)> {
        self.drawings.iter().map(|(path, lease)| (*path, lease))
    }
    pub fn contains(&self, member: Member) -> bool {
        match member {
            Member::ModelSettings => true,
            Member::LayerRanges => self
                .model
                .objects
                .iter()
                .any(|o| !o.value.layer_ranges.is_empty()),
            Member::LayerEvents => self.events.iter().any(|e| !e.is_empty()),
            Member::BrimEars => self
                .model
                .objects
                .iter()
                .any(|o| o.value.brim_ears.as_ref().is_some_and(|v| !v.is_empty())),
            Member::LayerHeights => self.model.objects.iter().any(|o| {
                o.value
                    .layer_height_profile
                    .as_ref()
                    .is_some_and(|v| v.len() >= 4 && v.len().is_multiple_of(2))
            }),
        }
    }
    /// Stream one member without copying configuration/recipe payloads. None
    /// means the browser omits this optional member; no bytes are then written.
    pub fn write(
        &self,
        member: Member,
        out: &mut impl Write,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Option<usize>, Error> {
        check(&mut cancelled)?;
        if !self.contains(member) {
            return Ok(None);
        }
        let mut w = xml::Writer::new(
            out,
            xml::Limits {
                output_bytes: self.limits.output_bytes,
                text_units: self.limits.output_bytes,
            },
            cancelled,
        )?;
        match member {
            Member::ModelSettings => self.model_settings(&mut w)?,
            Member::LayerRanges => self.layer_ranges(&mut w)?,
            Member::LayerEvents => self.layer_events(&mut w)?,
            Member::BrimEars => self.brim_ears(&mut w)?,
            Member::LayerHeights => self.layer_heights(&mut w)?,
        }
        Ok(Some(w.finish()?))
    }
}
