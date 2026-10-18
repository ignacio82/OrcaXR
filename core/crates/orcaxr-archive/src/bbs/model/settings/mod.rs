//! Engine-facing project settings from the same frozen model/material mapping.
//! Derived maps/percentages are bounded; configurations, script bodies and exact
//! FullSpectrum recipes remain borrowed. Output is provisional, not a package,
//! engine-profile validation, save acknowledgement or live authority mutation.
mod filament_keys;
mod json;
mod mixed;
mod reset;
mod write;
use super::{Authoring as Model, eq, field, layout};
use crate::bbs::numbers;
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::*;
use std::{
    borrow::Cow,
    collections::BTreeMap,
    fmt,
    io::{self, Write},
};
pub const PATH: &str = "Metadata/project_settings.config";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ResourceLimit,
    OutputLimit,
    Recipe,
    Encoding,
    Number(numbers::Error),
    Cancelled,
    Io(io::ErrorKind),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bbs_settings_{self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    pub records: usize,
    pub config_nodes: usize,
    /// Clamped to 128 independently of the host-supplied limit.
    pub config_depth: usize,
    pub text_units: usize,
    /// Map entries, derived vector elements and mixed-percentage/order scratch.
    pub derived_values: usize,
    pub output_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warning {
    RelativeExtruderReset,
    WipeTowerRotations,
    WipeTowerEnabledStates,
    ApproximateGradient { mixed: usize },
    ApproximateCycle { mixed: usize },
    ApproximateMatch { mixed: usize },
}
struct Budget {
    left: Limits,
}
impl Budget {
    fn charge(v: &mut usize, n: usize) -> Result<(), Error> {
        *v = v.checked_sub(n).ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn record(&mut self) -> Result<(), Error> {
        Self::charge(&mut self.left.records, 1)
    }
    fn text(&mut self, v: &[u16]) -> Result<(), Error> {
        Self::charge(&mut self.left.text_units, v.len())
    }
    fn derived(&mut self, n: usize) -> Result<(), Error> {
        Self::charge(&mut self.left.derived_values, n)
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
            Value::Object(fields) => {
                for (k, v) in fields {
                    self.text(k)?;
                    self.config(v, depth + 1, c)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
fn check(c: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if c() { Err(Error::Cancelled) } else { Ok(()) }
}
#[derive(Clone, Copy)]
enum Atom<'a> {
    Value(&'a Value),
    Text(&'a [u16]),
    Literal(&'static str),
    Number(f64),
    Bool(bool),
    Color([u16; 7]),
    Reset(&'a [u16]),
}
enum Projection<'a> {
    Source(&'a Value),
    Scalar(Atom<'a>),
    Vector(Vec<Atom<'a>>),
    Mixed,
}
impl Projection<'_> {
    fn array_len(&self) -> Option<usize> {
        match self {
            Self::Source(Value::Array(v)) => Some(v.len()),
            Self::Vector(v) => Some(v.len()),
            _ => None,
        }
    }
}
pub struct Authoring<'m, 'a> {
    model: &'m Model<'a>,
    fields: BTreeMap<Cow<'a, [u16]>, Projection<'a>>,
    physical: BTreeMap<&'a [u16], usize>,
    rows: Vec<mixed::Row<'a>>,
    warnings: Vec<Warning>,
    limits: Limits,
}
impl<'m, 'a> Authoring<'m, 'a> {
    /// Run off authority: full borrowed configuration traversal and bounded
    /// numeric sorting are preparation work, not an interruptible transaction.
    pub fn new(
        model: &'m Model<'a>,
        limits: Limits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        check(&mut cancelled)?;
        let mut budget = Budget { left: limits };
        let mut fields = BTreeMap::new();
        budget.config(model.state.config.value(), 0, &mut cancelled)?;
        let Value::Object(config) = model.state.config.value() else {
            return Err(Error::Encoding);
        };
        for (k, v) in config {
            check(&mut cancelled)?;
            budget.derived(1)?;
            fields.insert(Cow::Borrowed(k.as_slice()), Projection::Source(v));
        }
        let mut physical = BTreeMap::new();
        for (i, f) in model.state.filaments.physical.iter().enumerate() {
            check(&mut cancelled)?;
            budget.record()?;
            for text in [
                f.id.as_utf16(),
                f.name.units(),
                f.material.units(),
                f.color.units(),
            ] {
                budget.text(text)?;
            }
            for text in [&f.preset_id, &f.preset_hash, &f.vendor]
                .into_iter()
                .flatten()
            {
                budget.text(text.units())?;
            }
            budget.config(f.config.value(), 0, &mut cancelled)?;
            physical.insert(f.id.as_utf16(), i + 1);
        }
        let mut s = Self {
            model,
            fields,
            physical,
            rows: Vec::new(),
            warnings: Vec::new(),
            limits,
        };
        for (k, v) in [
            ("type", "project_settings"),
            ("name", "project_settings"),
            ("from", "project"),
            ("version", "2.3.4"),
        ] {
            s.set(k, Projection::Scalar(Atom::Literal(v)), &mut budget)?;
        }
        if s.get("curr_bed_type").is_none() {
            if let Some(Value::String(default_bed)) = s.source("default_bed_type") {
                if !default_bed.is_empty() {
                    s.set(
                        "curr_bed_type",
                        Projection::Scalar(Atom::Text(default_bed)),
                        &mut budget,
                    )?;
                }
            }
        }
        for key in [
            "filament_colour",
            "filament_settings_id",
            "filament_ids",
            "filament_type",
            "filament_vendor",
        ] {
            budget.derived(model.state.filaments.physical.len())?;
            let mut rows = Vec::new();
            for f in model.state.filaments.physical.iter() {
                check(&mut cancelled)?;
                rows.push(match key {
                    "filament_colour" => {
                        Atom::Color(layout::color(f.color.units())[..7].try_into().unwrap())
                    }
                    "filament_settings_id" => {
                        Atom::Text(f.preset_id.as_ref().unwrap_or(&f.name).units())
                    }
                    "filament_ids" => Atom::Text(
                        f.preset_hash
                            .as_ref()
                            .or(f.preset_id.as_ref())
                            .map_or(&[], Text::units),
                    ),
                    "filament_type" => Atom::Text(f.material.units()),
                    _ => Atom::Text(f.vendor.as_ref().map_or(&[], Text::units)),
                });
            }
            s.set(key, Projection::Vector(rows), &mut budget)?;
        }
        if let Some(profile) = &model.state.printer.profile_id {
            budget.text(profile.units())?;
            if !profile.units().is_empty() {
                s.set(
                    "printer_settings_id",
                    Projection::Scalar(Atom::Text(profile.units())),
                    &mut budget,
                )?;
            }
        }
        let filaments = &model.state.filaments.physical;
        if !filaments.is_empty() && filaments.iter().all(|f| f.nozzle_diameter_mm.is_some()) {
            budget.derived(filaments.len())?;
            s.set(
                "nozzle_diameter",
                Projection::Vector(
                    filaments
                        .iter()
                        .map(|f| Atom::Number(f.nozzle_diameter_mm.unwrap().get()))
                        .collect(),
                ),
                &mut budget,
            )?;
        }
        s.filament_vectors(&mut budget, &mut cancelled)?;
        s.reset(&mut budget, &mut cancelled)?;
        s.wipe_towers(&mut budget, &mut cancelled)?;
        s.rows = mixed::prepare(
            model.state,
            &s.physical,
            &mut s.warnings,
            &mut budget,
            &mut cancelled,
        )?;
        if !s.rows.is_empty() {
            s.set("mixed_filament_definitions", Projection::Mixed, &mut budget)?;
        }
        check(&mut cancelled)?;
        Ok(s)
    }
    fn set(
        &mut self,
        key: &'static str,
        v: Projection<'a>,
        budget: &mut Budget,
    ) -> Result<(), Error> {
        budget.derived(1)?;
        self.fields
            .insert(Cow::Owned(key.encode_utf16().collect()), v);
        Ok(())
    }
    fn get(&self, key: &str) -> Option<&Projection<'a>> {
        let mut units = [0; 128];
        if key.len() > units.len() {
            return None;
        }
        for (i, b) in key.bytes().enumerate() {
            units[i] = u16::from(b);
        }
        self.fields.get(&units[..key.len()])
    }
    fn source(&self, key: &str) -> Option<&'a Value> {
        match self.get(key) {
            Some(Projection::Source(v)) => Some(v),
            _ => None,
        }
    }
    pub fn warnings(&self) -> &[Warning] {
        &self.warnings
    }
    fn filament_vectors(
        &mut self,
        budget: &mut Budget,
        c: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        let physical = &self.model.state.filaments.physical;
        if physical.is_empty() {
            return Ok(());
        }
        for key in filament_keys::KEYS {
            check(c)?;
            if self.get(key).and_then(Projection::array_len) == Some(physical.len()) {
                continue;
            }
            let base = field(self.model.state.config.value(), key);
            // None is JavaScript undefined; Some(Null) stays a defined fallback.
            let pick = |index: usize, f: &'a PhysicalFilament| -> Option<&'a Value> {
                if let Some(v) = field(f.config.value(), key) {
                    return Some(v);
                }
                match base {
                    Some(Value::Array(v)) => v
                        .get(index)
                        .filter(|v| !matches!(v, Value::Null))
                        .or(v.last()),
                    v => v,
                }
            };
            let mut fallback = None;
            for (i, f) in physical.iter().enumerate() {
                check(c)?;
                if let Some(v) = pick(i, f) {
                    fallback = Some(v);
                    break;
                }
            }
            let Some(fallback) = fallback else {
                continue;
            };
            budget.derived(physical.len())?;
            let mut values = Vec::new();
            for (i, f) in physical.iter().enumerate() {
                check(c)?;
                values.push(Atom::Value(
                    pick(i, f)
                        .filter(|v| !matches!(v, Value::Null))
                        .unwrap_or(fallback),
                ));
            }
            self.set(key, Projection::Vector(values), budget)?;
        }
        Ok(())
    }
    fn wipe_towers(
        &mut self,
        budget: &mut Budget,
        c: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        let mut rotation = None;
        let mut mixed_rotation = false;
        let mut enabled = 0;
        let mut filament = None;
        for p in &self.model.plates {
            check(c)?;
            budget.record()?;
            if let Some(t) = &p.wipe_tower {
                if let Some(id) = &t.filament_id {
                    budget.text(id.as_utf16())?;
                }
                if !t.enabled {
                    continue;
                }
                enabled += 1;
                if rotation.is_some_and(|r| r != t.rotation_deg.get()) {
                    mixed_rotation = true;
                } else if rotation.is_none() {
                    rotation = Some(t.rotation_deg.get());
                }
                if filament.is_none() {
                    filament = t.filament_id.as_ref();
                }
            }
        }
        if enabled == 0 {
            return Ok(());
        }
        self.set(
            "enable_prime_tower",
            Projection::Scalar(Atom::Bool(true)),
            budget,
        )?;
        for (axis, key) in ["wipe_tower_x", "wipe_tower_y"].into_iter().enumerate() {
            budget.derived(self.model.plates.len())?;
            let values = self
                .model
                .plates
                .iter()
                .map(|p| {
                    Atom::Number(
                        p.wipe_tower
                            .as_ref()
                            .map_or(0.0, |t| t.position_mm[axis].get()),
                    )
                })
                .collect();
            self.set(key, Projection::Vector(values), budget)?;
        }
        self.set(
            "wipe_tower_rotation_angle",
            Projection::Scalar(Atom::Number(rotation.unwrap())),
            budget,
        )?;
        if mixed_rotation {
            self.warnings.push(Warning::WipeTowerRotations);
        }
        if enabled < self.model.plates.len() {
            self.warnings.push(Warning::WipeTowerEnabledStates);
        }
        if let Some(slot) = filament.and_then(|id| self.model.slots.get(id.as_utf16())) {
            self.set(
                "wipe_tower_filament",
                Projection::Scalar(Atom::Number(*slot as f64)),
                budget,
            )?;
        }
        Ok(())
    }
}
