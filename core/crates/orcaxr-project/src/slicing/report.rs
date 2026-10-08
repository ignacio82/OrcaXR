//! The host exchange for a live preflight. A `PreflightRequest` names a plate,
//! its target (the project's own authored configuration, or catalog profile
//! facts) and explicit budgets. The `Report` is read piecewise as generated
//! contract values, so a large result never needs one oversized message.
use super::{
    preflight::{self, ActionId, Code, Error, Issue, Limits, Preflight},
    profile::{self, Derivation, OmissionCode, Profile, Source, Target},
};
use crate::{
    assets::AssetSnapshot,
    ids::PlateId,
    mesh,
    model::Text,
    selection::SelectionRef,
    validation::{Severity, ValidatedProject},
};
use orcaxr_contracts::project_intent_types as wire;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestError {
    /// The plate ID is not a stable entity ID.
    InvalidRequest,
    Preflight(Error),
}
impl fmt::Display for RequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest => f.write_str("invalid_request"),
            Self::Preflight(error) => f.write_str(error.code()),
        }
    }
}
impl std::error::Error for RequestError {}

/// One live preflight: the result plus the derivation that produced its
/// constraints, omissions included.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    preflight: Preflight,
    derivation: Derivation,
}

fn saturating(value: u64) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}
fn optional(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(units) => Some(units),
    }
}
/// A catalog profile carries only the facts the derivation reads.
fn profile(value: &wire::OptionalPreflightProfile) -> Option<Profile> {
    let wire::OptionalPreflightProfile::Value(p) = value else {
        return None;
    };
    let id = |t: &wire::OptionalText| optional(t).map(|u| Text::new(u.to_vec()));
    let config = [
        ("printable_area", &p.printable_area),
        ("printable_height", &p.printable_height),
        ("nozzle_diameter", &p.nozzle_diameter),
        ("filament_type", &p.filament_type),
        (
            "nozzle_temperature_range_low",
            &p.nozzle_temperature_range_low,
        ),
        (
            "nozzle_temperature_range_high",
            &p.nozzle_temperature_range_high,
        ),
    ]
    .into_iter()
    .filter_map(|(key, value)| Some((key.encode_utf16().collect(), optional(value)?.to_vec())))
    .collect();
    Some(Profile {
        machine_preset_id: id(&p.machine_preset_id),
        process_preset_id: id(&p.process_preset_id),
        filament_preset_id: id(&p.filament_preset_id),
        config,
    })
}

/// The catalog target of a request: preset identities and only the facts
/// the derivation reads, the inverse of the request's decoding.
pub fn catalog_target(target: &Target) -> wire::CatalogPreflightTarget {
    let facts = |p: &Option<Profile>| match p {
        None => wire::OptionalPreflightProfile::Absent(wire::Empty {}),
        Some(p) => {
            let id = |t: &Option<Text>| match t {
                Some(t) => wire::OptionalText::Value(t.units().to_vec()),
                None => wire::OptionalText::Absent(wire::Empty {}),
            };
            let fact = |key: &str| match p.config.get(&key.encode_utf16().collect::<Vec<_>>()) {
                Some(value) => wire::OptionalText::Value(value.clone()),
                None => wire::OptionalText::Absent(wire::Empty {}),
            };
            wire::OptionalPreflightProfile::Value(wire::PreflightProfile {
                machine_preset_id: id(&p.machine_preset_id),
                process_preset_id: id(&p.process_preset_id),
                filament_preset_id: id(&p.filament_preset_id),
                printable_area: fact("printable_area"),
                printable_height: fact("printable_height"),
                nozzle_diameter: fact("nozzle_diameter"),
                filament_type: fact("filament_type"),
                nozzle_temperature_range_low: fact("nozzle_temperature_range_low"),
                nozzle_temperature_range_high: fact("nozzle_temperature_range_high"),
            })
        }
    };
    wire::CatalogPreflightTarget {
        tool_count: target.tool_count,
        primary: facts(&target.primary),
        filaments: target.filaments.iter().map(facts).collect(),
    }
}

impl Report {
    /// Derive the request's target, preflight the plate and attest the result.
    pub fn run(
        project: &ValidatedProject,
        assets: &AssetSnapshot,
        request: &wire::PreflightRequest,
        cancelled: impl FnMut() -> bool,
    ) -> Result<Self, RequestError> {
        let plate = PlateId::try_from_utf16(request.plate_id.clone())
            .map_err(|_| RequestError::InvalidRequest)?;
        let budget = &request.budget;
        let max_tools = saturating(budget.tools);
        let target = match &request.target {
            wire::PreflightTarget::Authored(_) => {
                profile::authored_target(project.state(), max_tools)
                    .map_err(RequestError::Preflight)?
            }
            wire::PreflightTarget::Catalog(c) => Target {
                primary: profile(&c.primary),
                filaments: c.filaments.iter().map(profile).collect(),
                tool_count: c.tool_count,
                source: Source::Catalog,
            },
        };
        let limits = Limits {
            mesh: mesh::Limits {
                asset_bytes: saturating(budget.asset_bytes),
                vertices: saturating(budget.vertices),
                indices: saturating(budget.indices),
            },
            assets: saturating(budget.assets),
            vertex_visits: saturating(budget.vertex_visits),
        };
        let (preflight, derivation) = profile::preflight_target(
            project, assets, &plate, &target, limits, max_tools, cancelled,
        )
        .map_err(RequestError::Preflight)?;
        Ok(Self {
            preflight,
            derivation,
        })
    }
    pub fn preflight(&self) -> &Preflight {
        &self.preflight
    }
    pub fn derivation(&self) -> &Derivation {
        &self.derivation
    }
    pub fn summary(&self) -> wire::PreflightSummary {
        let p = &self.preflight;
        wire::PreflightSummary {
            plate_id: p.plate_id.as_utf16().to_vec(),
            can_slice: p.can_slice,
            blocking_count: p.blocking_count as u64,
            issue_count: p.issues.len() as u64,
            omission_count: self.derivation.omissions.len() as u64,
            printable_instance_count: p.printable_instance_ids.len() as u64,
            used_filament_count: p.used_filament_ids.len() as u64,
        }
    }
    pub fn issue(&self, index: usize) -> Option<wire::PreflightIssue> {
        self.preflight.issues.get(index).map(issue)
    }
    pub fn omission(&self, index: usize) -> Option<wire::PreflightOmission> {
        let o = self.derivation.omissions.get(index)?;
        Some(wire::PreflightOmission {
            code: match o.code {
                OmissionCode::MaterialNotDeclared => {
                    wire::PreflightOmissionCode::MaterialNotDeclared
                }
                OmissionCode::TemperatureLowerBoundNotDeclared => {
                    wire::PreflightOmissionCode::TemperatureLowerBoundNotDeclared
                }
                OmissionCode::TemperatureUpperBoundNotDeclared => {
                    wire::PreflightOmissionCode::TemperatureUpperBoundNotDeclared
                }
                OmissionCode::TemperatureRangeInvalid => {
                    wire::PreflightOmissionCode::TemperatureRangeInvalid
                }
            },
            message: o.message.encode_utf16().collect(),
            path: o.path.encode_utf16().collect(),
            tool_id: o.tool_id as u64,
        })
    }
    pub fn printable_instance(&self, index: usize) -> Option<wire::PreflightEntity> {
        let id = self.preflight.printable_instance_ids.get(index)?;
        Some(entity(&SelectionRef::Instance(id.clone())))
    }
    pub fn used_filament(&self, index: usize) -> Option<wire::PreflightEntity> {
        let id = self.preflight.used_filament_ids.get(index)?;
        Some(entity(&SelectionRef::Filament(id.clone())))
    }
}

fn entity(entity: &SelectionRef) -> wire::PreflightEntity {
    let id = |units: &[u16]| units.to_vec();
    match entity {
        SelectionRef::Project => wire::PreflightEntity::Project(wire::Empty {}),
        SelectionRef::Plate(v) => wire::PreflightEntity::Plate(id(v.as_utf16())),
        SelectionRef::Object(v) => wire::PreflightEntity::Object(id(v.as_utf16())),
        SelectionRef::Volume(v) => wire::PreflightEntity::Volume(id(v.as_utf16())),
        SelectionRef::Instance(v) => wire::PreflightEntity::Instance(id(v.as_utf16())),
        SelectionRef::LayerRange(v) => wire::PreflightEntity::LayerRange(id(v.as_utf16())),
        SelectionRef::Filament(v) => wire::PreflightEntity::Filament(id(v.as_utf16())),
    }
}
fn text(value: Option<&Text>) -> wire::OptionalText {
    match value {
        Some(t) => wire::OptionalText::Value(t.units().to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
/// Both enums spell the same browser codes; the contract camel-cases them.
macro_rules! same_variants {
    ($value:expr, $from:ident => $to:path { $($variant:ident),+ $(,)? }) => {{
        use $to as Target;
        match $value { $($from::$variant => Target::$variant),+ }
    }};
}
fn code(code: Code) -> wire::PreflightCode {
    same_variants!(code, Code => wire::PreflightCode {
        InvalidProjectState, UnknownPlate, PlateNotPrintable, NoPrintableInstance,
        EmptyModelMesh, UnreadableModelMesh, InstanceOutsideBuildVolume,
        InstanceBelowBuildPlate, InstanceAabbOverlap, DisabledFilamentAssignment,
        DeletedMixedFilamentAssignment, DisabledMixedComponent, IncompatibleMixedComponents,
        MixedFilamentUnsupportedPrinter, FilamentToolOutOfRange,
        FilamentCountExceedsEngineLimit, GradientRecipeOutOfBounds, FilamentNozzleMismatch,
        UnsupportedFilamentMaterial, InvalidFilamentTemperature,
        FilamentTemperatureOutOfRange, MissingProfileAttestation,
        WipeTowerOutsideBuildVolume, WipeTowerRequiresPhysicalFilament,
        WipeTowerRequiresRelativeE, WipeTowerOozePreventionConflict,
        WipeTowerMixedExtruderDiameters, UnsafeCustomGcode,
    })
}
fn action(id: ActionId) -> wire::PreflightActionId {
    same_variants!(id, ActionId => wire::PreflightActionId {
        Reveal, DropToBed, MoveInsideBuildVolume, ChooseFilament, ChooseProfile,
        EditCustomGcode, DisableWipeTower,
    })
}
fn issue(issue: &Issue) -> wire::PreflightIssue {
    wire::PreflightIssue {
        id: issue.id.units().to_vec(),
        code: code(issue.code),
        detail_code: text(issue.detail.as_ref()),
        severity: match issue.severity {
            Severity::Error => wire::PreflightSeverity::Error,
            Severity::Warning => wire::PreflightSeverity::Warning,
        },
        message: issue.message.units().to_vec(),
        help: issue.help.encode_utf16().collect(),
        path: text(issue.path.as_ref()),
        entities: issue.entities.iter().map(entity).collect(),
        actions: issue
            .actions
            .iter()
            .map(|a| wire::PreflightAction {
                id: action(a.id),
                label: a.label.encode_utf16().collect(),
                entity: match &a.entity {
                    Some(e) => wire::OptionalPreflightEntity::Value(entity(e)),
                    None => wire::OptionalPreflightEntity::Absent(wire::Empty {}),
                },
                setting_key: text(a.setting_key.as_ref()),
            })
            .collect(),
    }
}

impl preflight::Error {
    /// The stable host code for a refused preflight.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Constraints(_) => "invalid_constraints",
            Self::Limits => "resource_limit",
            Self::Cancelled => "cancelled",
            Self::Timestamp(never) => match *never {},
        }
    }
}
