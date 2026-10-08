//! Canonical slice preflight (`web/src/project/slicing/preflight.ts`,
//! `runCanonicalSlicePreflight`): a deterministic, read-only check of one plate
//! against the canonical graph, immutable mesh bytes and explicit printer
//! constraints. It never consults a renderer projection and never mutates or
//! silently substitutes project intent. Issue codes, IDs, messages, actions and
//! ordering are the browser's; `slice-preflight-vectors.json` pins them.
use crate::{
    assets::AssetSnapshot,
    filaments::compatibility::{self, Decision},
    ids::{AssetId, FilamentId, InstanceId, PhysicalFilamentId, PlateId},
    js_math::{
        self,
        convert::{
            number_to_string, to_fixed, trim_utf16, utf16_number, value_to_number, value_to_string,
        },
    },
    mesh::{self, Bounds, Mesh},
    model::{
        ConfigMap, Encode, FilamentChild, GcodeScope, MixedFilament, PhysicalFilament, ProjectData,
        ProjectInstance, ProjectObject, ProjectPlate, ProjectState, Text, VolumeRole, find_plate,
        resolve_filament,
    },
    selection::SelectionRef,
    settings::{ConfigResolutionRequest, ConfigView, resolve_config},
    validation::{Severity, TimestampPolicy, ValidatedProject, ValidationReport, validate_project},
};
use orcaxr_contracts::canonical::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    fmt,
    sync::Arc,
};

/// Pinned `MAXIMUM_FILAMENT_NUMBER` (`libslic3r.h`).
pub const PINNED_MAXIMUM_FILAMENT_NUMBER: f64 = 64.0;
/// The clamp `MixedFilamentManager` applies whenever a gradient row is enabled.
const GRADIENT_MIN_RATIO: f64 = 0.01;
const GRADIENT_MAX_RATIO: f64 = 0.99;
/// Pinned `Print::validate()` prime-tower tolerances.
const WIPE_TOWER_FILAMENT_DIAMETER_TOLERANCE: f64 = 0.1;
const WIPE_TOWER_NOZZLE_EPSILON: f64 = 1e-4;
pub const HELP: &str = "Resolve this issue before slicing or sending; the canonical project remains unchanged until an explicit fix runs.";
const SINKING_HELP: &str = "The pinned slicer may clip sinking geometry. Review the placement or explicitly drop the complete model to the bed.";
pub const DEFAULT_CUSTOM_GCODE_LIMIT: f64 = 256.0 * 1024.0;
pub const DEFAULT_GEOMETRY_TOLERANCE_MM: f64 = 1e-5;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

names!(
    /// `SlicePreflightCode`.
    Code {
        InvalidProjectState => "invalid-project-state",
        UnknownPlate => "unknown-plate",
        PlateNotPrintable => "plate-not-printable",
        NoPrintableInstance => "no-printable-instance",
        EmptyModelMesh => "empty-model-mesh",
        UnreadableModelMesh => "unreadable-model-mesh",
        InstanceOutsideBuildVolume => "instance-outside-build-volume",
        InstanceBelowBuildPlate => "instance-below-build-plate",
        InstanceAabbOverlap => "instance-aabb-overlap",
        DisabledFilamentAssignment => "disabled-filament-assignment",
        DeletedMixedFilamentAssignment => "deleted-mixed-filament-assignment",
        DisabledMixedComponent => "disabled-mixed-component",
        IncompatibleMixedComponents => "incompatible-mixed-components",
        MixedFilamentUnsupportedPrinter => "mixed-filament-unsupported-printer",
        FilamentToolOutOfRange => "filament-tool-out-of-range",
        FilamentCountExceedsEngineLimit => "filament-count-exceeds-engine-limit",
        GradientRecipeOutOfBounds => "gradient-recipe-out-of-bounds",
        FilamentNozzleMismatch => "filament-nozzle-mismatch",
        UnsupportedFilamentMaterial => "unsupported-filament-material",
        InvalidFilamentTemperature => "invalid-filament-temperature",
        FilamentTemperatureOutOfRange => "filament-temperature-out-of-range",
        MissingProfileAttestation => "missing-profile-attestation",
        WipeTowerOutsideBuildVolume => "wipe-tower-outside-build-volume",
        WipeTowerRequiresPhysicalFilament => "wipe-tower-requires-physical-filament",
        WipeTowerRequiresRelativeE => "wipe-tower-requires-relative-e",
        WipeTowerOozePreventionConflict => "wipe-tower-ooze-prevention-conflict",
        WipeTowerMixedExtruderDiameters => "wipe-tower-mixed-extruder-diameters",
        UnsafeCustomGcode => "unsafe-custom-gcode",
    }
);
names!(
    /// `SlicePreflightActionId`.
    ActionId {
        Reveal => "reveal",
        DropToBed => "drop-to-bed",
        MoveInsideBuildVolume => "move-inside-build-volume",
        ChooseFilament => "choose-filament",
        ChooseProfile => "choose-profile",
        EditCustomGcode => "edit-custom-gcode",
        DisableWipeTower => "disable-wipe-tower",
    }
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Action {
    pub id: ActionId,
    pub label: &'static str,
    pub entity: Option<SelectionRef>,
    pub setting_key: Option<Text>,
}
fn action(id: ActionId, label: &'static str, entity: Option<&SelectionRef>) -> Action {
    Action {
        id,
        label,
        entity: entity.cloned(),
        setting_key: None,
    }
}
fn setting(id: ActionId, label: &'static str, entity: Option<&SelectionRef>, key: &str) -> Action {
    Action {
        setting_key: Some(Text::from_utf8(key)),
        ..action(id, label, entity)
    }
}

/// `SlicePreflightIssue`. Text is lossless UTF-16 and may carry imported names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// Stable across repeated evaluation of the same canonical fault.
    pub id: Text,
    pub code: Code,
    pub detail: Option<Text>,
    pub severity: Severity,
    pub message: Text,
    pub help: &'static str,
    pub path: Option<Text>,
    pub entities: Vec<SelectionRef>,
    pub actions: Vec<Action>,
}

/// `CanonicalSlicePreflightResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preflight {
    pub plate_id: PlateId,
    pub can_slice: bool,
    pub blocking_count: usize,
    pub issues: Vec<Issue>,
    pub printable_instance_ids: Vec<InstanceId>,
    pub used_filament_ids: Vec<FilamentId>,
}

pub(super) fn object<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(key, value)| value.map(|v| (key.encode_utf16().collect(), v)))
            .collect(),
    )
}
pub(super) fn string(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn entity_value(entity: &SelectionRef) -> Value {
    object([
        (
            "kind",
            Some(string(&entity.kind().encode_utf16().collect::<Vec<_>>())),
        ),
        ("id", entity.id().map(string)),
    ])
}
pub(super) fn ascii(text: &str) -> Value {
    Value::String(text.encode_utf16().collect())
}
impl Issue {
    /// The browser's `SlicePreflightIssue` as canonical JSON.
    pub fn to_value(&self) -> Value {
        object([
            ("id", Some(string(self.id.units()))),
            ("code", Some(ascii(self.code.as_str()))),
            (
                "detailCode",
                self.detail.as_ref().map(|t| string(t.units())),
            ),
            ("severity", Some(ascii(self.severity.as_str()))),
            ("message", Some(string(self.message.units()))),
            ("help", Some(ascii(self.help))),
            ("path", self.path.as_ref().map(|t| string(t.units()))),
            (
                "entities",
                Some(Value::Array(
                    self.entities.iter().map(entity_value).collect(),
                )),
            ),
            (
                "actions",
                Some(Value::Array(
                    self.actions
                        .iter()
                        .map(|a| {
                            object([
                                ("id", Some(ascii(a.id.as_str()))),
                                ("label", Some(ascii(a.label))),
                                ("entity", a.entity.as_ref().map(entity_value)),
                                (
                                    "settingKey",
                                    a.setting_key.as_ref().map(|t| string(t.units())),
                                ),
                            ])
                        })
                        .collect(),
                )),
            ),
        ])
    }
}
impl Preflight {
    /// The browser's `CanonicalSlicePreflightResult` as canonical JSON.
    pub fn to_value(&self) -> Value {
        object([
            ("plateId", Some(string(self.plate_id.as_utf16()))),
            ("canSlice", Some(Value::Bool(self.can_slice))),
            (
                "blockingCount",
                Some(Value::Number(self.blocking_count as f64)),
            ),
            (
                "issues",
                Some(Value::Array(
                    self.issues.iter().map(Issue::to_value).collect(),
                )),
            ),
            (
                "printableInstanceIds",
                Some(Value::Array(
                    self.printable_instance_ids
                        .iter()
                        .map(|id| string(id.as_utf16()))
                        .collect(),
                )),
            ),
            (
                "usedFilamentIds",
                Some(Value::Array(
                    self.used_filament_ids
                        .iter()
                        .map(|id| string(id.as_utf16()))
                        .collect(),
                )),
            ),
        ])
    }
}

/// `RectangularBuildVolume`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BuildVolume {
    pub min_x_mm: f64,
    pub max_x_mm: f64,
    pub min_y_mm: f64,
    pub max_y_mm: f64,
    pub min_z_mm: Option<f64>,
    pub max_z_mm: f64,
}
impl BuildVolume {
    fn min_z(&self) -> f64 {
        self.min_z_mm.unwrap_or(0.0)
    }
}
/// `ToolFilamentConstraints`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolConstraints {
    pub nozzle_diameter_mm: Option<f64>,
    pub supported_materials: Option<Vec<Text>>,
    pub min_hotend_temperature_c: Option<f64>,
    pub max_hotend_temperature_c: Option<f64>,
}
/// `PrinterCapabilityConstraints`: facts the resolved printer declares exactly.
/// FullSpectrum support is never inferred from an authored virtual filament.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrinterCapability {
    pub physical_tool_count: f64,
    /// Ceiling on physical plus enabled virtual filaments (default 64).
    pub max_total_filaments: Option<f64>,
}
/// `SlicePreflightConstraints`. The default evaluates nothing printer-specific,
/// exactly like an absent constraints object.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Constraints {
    pub build_volume: Option<BuildVolume>,
    /// Indexed by the canonical zero-based physical tool ID.
    pub tools: Vec<Option<ToolConstraints>>,
    pub printer: Option<PrinterCapability>,
    pub require_profile_attestation: bool,
    pub custom_gcode_byte_limit: Option<f64>,
    pub geometry_tolerance_mm: Option<f64>,
}

impl Constraints {
    /// `SlicePreflightConstraints` as canonical JSON; absent members are left
    /// out and an absent tool slot is `null`.
    pub fn to_value(&self) -> Value {
        let n = |v: Option<f64>| v.map(Value::Number);
        let volume = |b: &BuildVolume| {
            object([
                ("minXmm", n(Some(b.min_x_mm))),
                ("maxXmm", n(Some(b.max_x_mm))),
                ("minYmm", n(Some(b.min_y_mm))),
                ("maxYmm", n(Some(b.max_y_mm))),
                ("minZmm", n(b.min_z_mm)),
                ("maxZmm", n(Some(b.max_z_mm))),
            ])
        };
        let tool = |t: &Option<ToolConstraints>| {
            t.as_ref().map_or(Value::Null, |t| {
                object([
                    ("nozzleDiameterMm", n(t.nozzle_diameter_mm)),
                    (
                        "supportedMaterials",
                        t.supported_materials.as_ref().map(|list| {
                            Value::Array(list.iter().map(|m| string(m.units())).collect())
                        }),
                    ),
                    ("minHotendTemperatureC", n(t.min_hotend_temperature_c)),
                    ("maxHotendTemperatureC", n(t.max_hotend_temperature_c)),
                ])
            })
        };
        object([
            ("buildVolume", self.build_volume.as_ref().map(volume)),
            (
                "tools",
                (!self.tools.is_empty())
                    .then(|| Value::Array(self.tools.iter().map(tool).collect())),
            ),
            (
                "printer",
                self.printer.as_ref().map(|p| {
                    object([
                        ("physicalToolCount", n(Some(p.physical_tool_count))),
                        ("maxTotalFilaments", n(p.max_total_filaments)),
                    ])
                }),
            ),
            (
                "requireProfileAttestation",
                self.require_profile_attestation
                    .then_some(Value::Bool(true)),
            ),
            ("customGcodeByteLimit", n(self.custom_gcode_byte_limit)),
            ("geometryToleranceMm", n(self.geometry_tolerance_mm)),
        ])
    }
}

/// `assertPreflightConstraints`: malformed constraints are refused instead of
/// silently weakening a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintError {
    BuildVolume,
    Tolerance,
    CustomGcodeLimit,
    ToolCount,
    FilamentCeiling,
    Nozzle(usize),
    Materials(usize),
    Temperature(usize),
}
impl fmt::Display for ConstraintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BuildVolume => {
                f.write_str("Build volume must contain finite increasing axis bounds")
            }
            Self::Tolerance => f.write_str("Geometry tolerance must be finite and non-negative"),
            Self::CustomGcodeLimit => {
                f.write_str("Custom G-code byte limit must be a positive safe integer")
            }
            Self::ToolCount => {
                f.write_str("Printer capability must declare a positive physical tool count")
            }
            Self::FilamentCeiling => write!(
                f,
                "Printer filament ceiling must be a positive integer no greater than {PINNED_MAXIMUM_FILAMENT_NUMBER}"
            ),
            Self::Nozzle(tool) => write!(
                f,
                "Tool {} nozzle diameter must be finite and positive",
                tool + 1
            ),
            Self::Materials(tool) => write!(
                f,
                "Tool {} supported materials must be non-empty strings",
                tool + 1
            ),
            Self::Temperature(tool) => {
                write!(f, "Tool {} hotend temperature range is invalid", tool + 1)
            }
        }
    }
}
impl std::error::Error for ConstraintError {}

fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}
impl Constraints {
    pub fn validate(&self) -> Result<(), ConstraintError> {
        if let Some(volume) = &self.build_volume {
            let axes = [
                volume.min_x_mm,
                volume.max_x_mm,
                volume.min_y_mm,
                volume.max_y_mm,
                volume.min_z(),
                volume.max_z_mm,
            ];
            if !axes.iter().all(|v| v.is_finite())
                || volume.max_x_mm <= volume.min_x_mm
                || volume.max_y_mm <= volume.min_y_mm
                || volume.max_z_mm <= volume.min_z()
            {
                return Err(ConstraintError::BuildVolume);
            }
        }
        if let Some(tolerance) = self.geometry_tolerance_mm
            && !(tolerance.is_finite() && tolerance >= 0.0)
        {
            return Err(ConstraintError::Tolerance);
        }
        if let Some(limit) = self.custom_gcode_byte_limit
            && !(safe_integer(limit) && limit >= 1.0)
        {
            return Err(ConstraintError::CustomGcodeLimit);
        }
        if let Some(printer) = &self.printer {
            if !(safe_integer(printer.physical_tool_count) && printer.physical_tool_count >= 1.0) {
                return Err(ConstraintError::ToolCount);
            }
            if let Some(ceiling) = printer.max_total_filaments
                && !(safe_integer(ceiling)
                    && (1.0..=PINNED_MAXIMUM_FILAMENT_NUMBER).contains(&ceiling))
            {
                return Err(ConstraintError::FilamentCeiling);
            }
        }
        for (index, tool) in self.tools.iter().enumerate() {
            let Some(tool) = tool else { continue };
            if let Some(nozzle) = tool.nozzle_diameter_mm
                && !(nozzle.is_finite() && nozzle > 0.0)
            {
                return Err(ConstraintError::Nozzle(index));
            }
            if tool
                .supported_materials
                .as_ref()
                .is_some_and(|list| list.iter().any(|m| trim_utf16(m.units()).is_empty()))
            {
                return Err(ConstraintError::Materials(index));
            }
            let (minimum, maximum) = (tool.min_hotend_temperature_c, tool.max_hotend_temperature_c);
            if minimum.is_some_and(|v| !v.is_finite())
                || maximum.is_some_and(|v| !v.is_finite())
                || matches!((minimum, maximum), (Some(lo), Some(hi)) if hi < lo)
            {
                return Err(ConstraintError::Temperature(index));
            }
        }
        Ok(())
    }
    /// `constraints?.tools?.[toolId]`: only an integer index names a slot.
    fn tool(&self, tool_id: f64) -> Option<&ToolConstraints> {
        if tool_id < 0.0 || tool_id.fract() != 0.0 || tool_id >= self.tools.len() as f64 {
            return None;
        }
        self.tools[tool_id as usize].as_ref()
    }
}

/// Explicit host budgets for the mesh reads. Exceeding one refuses the whole
/// preflight; it is a host limit, not a project fault.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    pub mesh: mesh::Limits,
    /// Distinct mesh assets decoded for bounds.
    pub assets: usize,
    /// Vertices transformed across every printable instance.
    pub vertex_visits: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error<T = Infallible> {
    Constraints(ConstraintError),
    Limits,
    Cancelled,
    Timestamp(T),
}
impl<T: fmt::Debug> fmt::Display for Error<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Constraints(error) => error.fmt(f),
            Self::Limits => f.write_str("slice_preflight_limits"),
            Self::Cancelled => f.write_str("slice_preflight_cancelled"),
            Self::Timestamp(error) => write!(f, "slice_preflight_timestamp: {error:?}"),
        }
    }
}
impl<T: fmt::Debug> std::error::Error for Error<T> {}
impl Error {
    fn widen<T>(self) -> Error<T> {
        match self {
            Self::Constraints(error) => Error::Constraints(error),
            Self::Limits => Error::Limits,
            Self::Cancelled => Error::Cancelled,
            Self::Timestamp(never) => match never {},
        }
    }
}

/// Preflight an admitted project, reusing its admission report: its warnings
/// still become `invalid-project-state` warnings.
pub fn preflight(
    project: &ValidatedProject,
    assets: &AssetSnapshot,
    plate_id: &PlateId,
    constraints: &Constraints,
    limits: Limits,
    cancelled: impl FnMut() -> bool,
) -> Result<Preflight, Error> {
    constraints.validate().map_err(Error::Constraints)?;
    run(
        project.state(),
        project.report(),
        assets,
        plate_id,
        constraints,
        limits,
        cancelled,
    )
}

/// Preflight any typed candidate, as the browser does: graph errors are
/// reported as blocking `invalid-project-state` issues, not refused.
pub fn preflight_candidate<P: TimestampPolicy>(
    data: &ProjectData,
    timestamps: &mut P,
    assets: &AssetSnapshot,
    plate_id: &PlateId,
    constraints: &Constraints,
    limits: Limits,
    cancelled: impl FnMut() -> bool,
) -> Result<Preflight, Error<P::Error>> {
    constraints.validate().map_err(Error::Constraints)?;
    let report = validate_project(data, timestamps).map_err(Error::Timestamp)?;
    run(
        data.state(),
        &report,
        assets,
        plate_id,
        constraints,
        limits,
        cancelled,
    )
    .map_err(Error::widen)
}

/// UTF-16 message assembly; names and IDs may hold any code units.
#[derive(Default)]
struct Units(Vec<u16>);
impl Units {
    fn s(mut self, text: &str) -> Self {
        self.0.extend(text.encode_utf16());
        self
    }
    fn u(mut self, units: &[u16]) -> Self {
        self.0.extend_from_slice(units);
        self
    }
    fn n(self, value: f64) -> Self {
        self.s(&number_to_string(value))
    }
    fn text(self) -> Text {
        Text::new(self.0)
    }
}
fn s(text: &str) -> Units {
    Units::default().s(text)
}
fn u(units: &[u16]) -> Units {
    Units::default().u(units)
}

struct Draft {
    code: Code,
    detail: Option<Text>,
    severity: Severity,
    message: Text,
    help: &'static str,
    path: Option<Text>,
    entities: Vec<SelectionRef>,
    actions: Vec<Action>,
}
impl Draft {
    fn error(code: Code, message: Text, entities: Vec<SelectionRef>, actions: Vec<Action>) -> Self {
        Self {
            code,
            detail: None,
            severity: Severity::Error,
            message,
            help: HELP,
            path: None,
            entities,
            actions,
        }
    }
    fn detail(mut self, detail: Text) -> Self {
        self.detail = Some(detail);
        self
    }
    fn path(mut self, path: Text) -> Self {
        self.path = Some(path);
        self
    }
    fn warning(mut self) -> Self {
        self.severity = Severity::Warning;
        self
    }
}

/// `addIssue`: the ID joins code, detail, path and entity references.
fn add(issues: &mut Vec<Issue>, draft: Draft) {
    let mut identity = s(draft.code.as_str()).s(":");
    if let Some(detail) = &draft.detail {
        identity = identity.u(detail.units());
    }
    identity = identity.s(":");
    if let Some(path) = &draft.path {
        identity = identity.u(path.units());
    }
    for entity in &draft.entities {
        identity = identity.s(":").s(entity.kind());
        if let Some(id) = entity.id() {
            identity = identity.s(":").u(id);
        }
    }
    issues.push(Issue {
        id: s("slice-preflight:").u(&identity.0).text(),
        code: draft.code,
        detail: draft.detail,
        severity: draft.severity,
        message: draft.message,
        help: draft.help,
        path: draft.path,
        entities: draft.entities,
        actions: draft.actions,
    });
}

/// Insertion-ordered set, as a JavaScript `Set` iterates.
struct Ordered<T> {
    items: Vec<T>,
    seen: BTreeSet<T>,
}
impl<T: Ord + Clone> Ordered<T> {
    fn new() -> Self {
        Self {
            items: Vec::new(),
            seen: BTreeSet::new(),
        }
    }
    fn add(&mut self, item: T) {
        if self.seen.insert(item.clone()) {
            self.items.push(item);
        }
    }
    fn contains(&self, item: &T) -> bool {
        self.seen.contains(item)
    }
}

fn check(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn run(
    state: &ProjectState,
    report: &ValidationReport,
    assets: &AssetSnapshot,
    plate_id: &PlateId,
    constraints: &Constraints,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Preflight, Error> {
    check(&mut cancelled)?;
    let mut issues = Vec::new();
    for issue in report.issues() {
        add(
            &mut issues,
            Draft {
                severity: issue.severity,
                ..Draft::error(
                    Code::InvalidProjectState,
                    issue.message.clone(),
                    vec![],
                    vec![action(
                        ActionId::Reveal,
                        "Reveal invalid project data",
                        None,
                    )],
                )
            }
            .detail(Text::from_utf8(issue.code))
            .path(issue.path.clone()),
        );
    }
    if report.error_count() > 0 {
        return Ok(finish(plate_id, issues, vec![], Ordered::new()));
    }

    let Some(plate) = find_plate(state, plate_id) else {
        add(
            &mut issues,
            Draft::error(
                Code::UnknownPlate,
                s("Plate ")
                    .u(plate_id.as_utf16())
                    .s(" does not exist.")
                    .text(),
                vec![],
                vec![action(ActionId::Reveal, "Show available plates", None)],
            ),
        );
        return Ok(finish(plate_id, issues, vec![], Ordered::new()));
    };
    let plate_entity = SelectionRef::Plate(plate.id.clone());
    if !plate.printable {
        add(
            &mut issues,
            Draft::error(
                Code::PlateNotPrintable,
                u(plate.name.units())
                    .s(" is excluded from printing.")
                    .text(),
                vec![plate_entity.clone()],
                vec![action(
                    ActionId::Reveal,
                    "Reveal plate",
                    Some(&plate_entity),
                )],
            ),
        );
    }
    let printable: Vec<(&ProjectObject, &ProjectInstance)> = plate
        .objects
        .iter()
        .flat_map(|object| {
            object
                .instances
                .iter()
                .filter(|instance| instance.printable)
                .map(move |instance| (object.as_ref(), instance.as_ref()))
        })
        .collect();
    if !plate.objects.is_empty() && printable.is_empty() {
        add(
            &mut issues,
            Draft::error(
                Code::NoPrintableInstance,
                u(plate.name.units())
                    .s(" contains no printable model instance.")
                    .text(),
                vec![plate_entity.clone()],
                vec![action(
                    ActionId::Reveal,
                    "Reveal plate",
                    Some(&plate_entity),
                )],
            ),
        );
    }

    let tolerance = constraints
        .geometry_tolerance_mm
        .unwrap_or(DEFAULT_GEOMETRY_TOLERANCE_MM);
    let mut reader = MeshReader {
        state,
        assets,
        limits,
        meshes: BTreeMap::new(),
        visits: 0,
    };
    let mut bounded = Vec::new();
    for (object, instance) in &printable {
        check(&mut cancelled)?;
        let entity = SelectionRef::Instance(instance.id.clone());
        let empty: Vec<SelectionRef> = object
            .volumes
            .iter()
            .filter(|v| v.role == VolumeRole::Model && v.source.triangle_count.get() == 0.0)
            .map(|v| SelectionRef::Volume(v.id.clone()))
            .collect();
        if !empty.is_empty() {
            let actions = empty
                .iter()
                .map(|v| action(ActionId::Reveal, "Reveal empty volume", Some(v)))
                .collect();
            add(
                &mut issues,
                Draft::error(
                    Code::EmptyModelMesh,
                    u(object.name.units())
                        .s(" contains an empty model mesh.")
                        .text(),
                    empty,
                    actions,
                ),
            );
            continue;
        }
        match reader.instance_bounds(object, instance, &mut cancelled) {
            Ok(bounds) => {
                bounded.push((instance.id.clone(), bounds));
                check_build_volume(&mut issues, &bounds, &entity, constraints, tolerance);
            }
            Err(Failure::Abort(error)) => return Err(error),
            Err(Failure::Unreadable(message)) => add(
                &mut issues,
                Draft::error(
                    Code::UnreadableModelMesh,
                    u(object.name.units())
                        .s(" cannot be decoded from its canonical mesh asset: ")
                        .u(&bounded_message(&message))
                        .text(),
                    vec![entity.clone()],
                    vec![action(ActionId::Reveal, "Reveal model", Some(&entity))],
                ),
            ),
        }
    }

    check_overlaps(&mut issues, &bounded, tolerance);
    let used = collect_used_filaments(plate);
    check_engine_capacity(&mut issues, state, constraints.printer.as_ref());
    let used_physical = check_filaments(&mut issues, state, &used, constraints);
    check_wipe_tower(&mut issues, state, plate, constraints, &used_physical);
    check_custom_gcode(&mut issues, state, plate, constraints);
    check(&mut cancelled)?;

    let mut all = Ordered::new();
    for id in used.items {
        all.add(id);
    }
    for id in used_physical.items {
        all.add(id.as_utf16().to_vec());
    }
    Ok(finish(
        &plate.id,
        issues,
        printable.iter().map(|(_, i)| i.id.clone()).collect(),
        all,
    ))
}

enum Failure {
    Unreadable(Vec<u16>),
    Abort(Error),
}
fn unreadable(text: &str) -> Failure {
    Failure::Unreadable(text.encode_utf16().collect())
}

/// `computeCanonicalInstanceBounds(state, assets, [instance], {volumeRoles:
/// ['model']})` with its refusal messages. A decoded mesh (or its refusal) is
/// kept for the rest of this preflight.
struct MeshReader<'a> {
    state: &'a ProjectState,
    assets: &'a AssetSnapshot,
    limits: Limits,
    meshes: BTreeMap<AssetId, Result<Mesh, String>>,
    visits: usize,
}
impl MeshReader<'_> {
    fn instance_bounds(
        &mut self,
        object: &ProjectObject,
        instance: &ProjectInstance,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<Bounds, Failure> {
        let mut result = Bounds::empty();
        for volume in object
            .volumes
            .iter()
            .filter(|v| v.role == VolumeRole::Model)
        {
            let asset = &volume.source.asset_id;
            // A Map from the descriptor array keeps the last duplicate ID.
            let descriptor = self
                .state
                .source_assets
                .iter()
                .rev()
                .find(|d| &d.id == asset);
            let (Some(descriptor), Some(lease)) = (descriptor, self.assets.peek(asset)) else {
                return Err(Failure::Unreadable(
                    u(&[])
                        .s("Volume ")
                        .u(volume.id.as_utf16())
                        .s(" references missing asset ")
                        .u(asset.as_utf16())
                        .0,
                ));
            };
            if !descriptor
                .matches_value(lease.descriptor())
                .unwrap_or(false)
            {
                return Err(Failure::Unreadable(
                    s("Asset repository metadata differs for ")
                        .u(asset.as_utf16())
                        .0,
                ));
            }
            if !self.meshes.contains_key(asset) {
                if self.meshes.len() >= self.limits.assets {
                    return Err(Failure::Abort(Error::Limits));
                }
                // The browser's decoder decides what is unreadable, in its order.
                let decoded = match mesh::validate_indexed(&lease) {
                    Err(message) => Err(message),
                    Ok(_) => match Mesh::open(lease, self.limits.mesh, &mut *cancelled) {
                        Ok(mesh) => Ok(mesh),
                        Err(mesh::Error::Limits) => return Err(Failure::Abort(Error::Limits)),
                        Err(mesh::Error::Cancelled) => {
                            return Err(Failure::Abort(Error::Cancelled));
                        }
                        Err(other) => Err(other.to_string()),
                    },
                };
                self.meshes.insert(asset.clone(), decoded);
            }
            let mesh = match &self.meshes[asset] {
                Ok(mesh) => mesh,
                Err(message) => return Err(Failure::Unreadable(message.encode_utf16().collect())),
            };
            self.visits = self
                .visits
                .checked_add(mesh.vertex_count())
                .filter(|v| *v <= self.limits.vertex_visits)
                .ok_or(Failure::Abort(Error::Limits))?;
            mesh.accumulate_bounds(
                &mut result,
                &volume.transform,
                &instance.transform,
                &mut *cancelled,
            )
            .map_err(|error| match error {
                mesh::Error::Cancelled => Failure::Abort(Error::Cancelled),
                mesh::Error::Transform => {
                    unreadable("A canonical transform quaternion must be non-zero")
                }
                mesh::Error::NonFiniteVertex => {
                    unreadable("Canonical bounds contain a non-finite transformed vertex")
                }
                other => unreadable(&other.to_string()),
            })?;
        }
        result
            .finish()
            .map_err(|_| unreadable("Selected instances contain no bounded mesh geometry"))
    }
}

/// `boundedMessage`: control whitespace runs become one space, at most 240
/// UTF-16 units survive, and an empty message is named.
fn bounded_message(message: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    let mut run = false;
    for &unit in message {
        if matches!(unit, 0x0d | 0x0a | 0x09) {
            if !run {
                out.push(u16::from(b' '));
            }
            run = true;
        } else {
            out.push(unit);
            run = false;
        }
    }
    out.truncate(240);
    if out.is_empty() {
        out = "unknown mesh error".encode_utf16().collect();
    }
    out
}

fn check_build_volume(
    issues: &mut Vec<Issue>,
    bounds: &Bounds,
    entity: &SelectionRef,
    constraints: &Constraints,
    tolerance: f64,
) {
    let Some(volume) = &constraints.build_volume else {
        return;
    };
    let min_z = volume.min_z();
    if bounds.min[0] < volume.min_x_mm - tolerance
        || bounds.max[0] > volume.max_x_mm + tolerance
        || bounds.min[1] < volume.min_y_mm - tolerance
        || bounds.max[1] > volume.max_y_mm + tolerance
        || bounds.max[2] > volume.max_z_mm + tolerance
    {
        add(
            issues,
            Draft::error(
                Code::InstanceOutsideBuildVolume,
                s("Model bounds ")
                    .s(&format_bounds(bounds))
                    .s(" exceed the configured build volume ")
                    .s(&format_build_volume(volume))
                    .s(".")
                    .text(),
                vec![entity.clone()],
                vec![
                    action(ActionId::Reveal, "Reveal model", Some(entity)),
                    action(
                        ActionId::MoveInsideBuildVolume,
                        "Move inside build volume",
                        Some(entity),
                    ),
                ],
            ),
        );
    }
    if bounds.min[2] < min_z - tolerance {
        add(
            issues,
            Draft {
                help: SINKING_HELP,
                ..Draft::error(
                    Code::InstanceBelowBuildPlate,
                    s("Model extends ")
                        .s(&to_fixed(min_z - bounds.min[2], 3))
                        .s(" mm below the build plate.")
                        .text(),
                    vec![entity.clone()],
                    vec![
                        action(ActionId::Reveal, "Reveal sinking model", Some(entity)),
                        action(ActionId::DropToBed, "Drop model to bed", Some(entity)),
                    ],
                )
            }
            .warning(),
        );
    }
}

/// `Number(value.toFixed(3)).toString()`.
fn format_mm(value: f64) -> String {
    number_to_string(crate::js_math::convert::number(&to_fixed(value, 3)))
}
fn format_bounds(bounds: &Bounds) -> String {
    let axes = |v: &[f64; 3]| v.map(format_mm).join(", ");
    format!("[{}]–[{}] mm", axes(&bounds.min), axes(&bounds.max))
}
fn format_build_volume(v: &BuildVolume) -> String {
    format!(
        "[{}, {}, {}]–[{}, {}, {}] mm",
        format_mm(v.min_x_mm),
        format_mm(v.min_y_mm),
        format_mm(v.min_z()),
        format_mm(v.max_x_mm),
        format_mm(v.max_y_mm),
        format_mm(v.max_z_mm)
    )
}

fn check_overlaps(issues: &mut Vec<Issue>, bounded: &[(InstanceId, Bounds)], tolerance: f64) {
    for (index, (left_id, left)) in bounded.iter().enumerate() {
        for (right_id, right) in &bounded[index + 1..] {
            if !aabb_potentially_overlaps(left, right, tolerance) {
                continue;
            }
            let left_entity = SelectionRef::Instance(left_id.clone());
            let right_entity = SelectionRef::Instance(right_id.clone());
            add(
                issues,
                Draft::error(
                    Code::InstanceAabbOverlap,
                    Text::from_utf8(
                        "Printable model bounds overlap. Exact mesh collision and sequential toolhead clearance still require engine validation.",
                    ),
                    vec![left_entity.clone(), right_entity.clone()],
                    vec![
                        action(ActionId::Reveal, "Reveal first model", Some(&left_entity)),
                        action(ActionId::Reveal, "Reveal second model", Some(&right_entity)),
                    ],
                )
                .warning(),
            );
        }
    }
}
fn aabb_potentially_overlaps(left: &Bounds, right: &Bounds, tolerance: f64) -> bool {
    let span = |axis: usize| {
        js_math::min(left.max[axis], right.max[axis])
            - js_math::max(left.min[axis], right.min[axis])
    };
    span(0) > tolerance && span(1) > tolerance && span(2) >= -tolerance
}

/// `collectUsedFilaments`: every filament a printable object prints with,
/// in first-use order.
fn collect_used_filaments(plate: &ProjectPlate) -> Ordered<Vec<u16>> {
    let mut used = Ordered::new();
    for object in plate.objects.iter() {
        if !object.instances.iter().any(|i| i.printable) {
            continue;
        }
        if let Some(id) = &object.filament_id {
            used.add(id.as_utf16().to_vec());
        }
        for volume in object.volumes.iter() {
            if volume.role != VolumeRole::Model {
                continue;
            }
            if let Some(id) =
                resolve_filament(object, Some(FilamentChild::Volume(volume))).effective
            {
                used.add(id.as_utf16().to_vec());
            }
            if let Value::Array(assignments) = volume.annotations.color.value() {
                for assignment in assignments {
                    if let Some(Value::String(value)) = field(assignment, "value") {
                        used.add(value.clone());
                    }
                }
            }
            if let Some(refinement) = &volume.annotations.refinement
                && let Some(color) = field(refinement.value(), "color")
            {
                visit_assigned_values(color, |value| {
                    if let Value::String(value) = value {
                        used.add(value.clone());
                    }
                });
            }
        }
        for range in object.layer_ranges.iter() {
            if let Some(id) =
                resolve_filament(object, Some(FilamentChild::LayerRange(range))).effective
            {
                used.add(id.as_utf16().to_vec());
            }
        }
    }
    if let Some(tower) = &plate.wipe_tower
        && tower.enabled
        && let Some(id) = &tower.filament_id
    {
        used.add(id.as_utf16().to_vec());
    }
    used
}

/// `visitFacetRefinementAssignedValues` over the stored JSON: pre-order, at
/// most `refinementNodeBudget(triangleCount)` nodes.
fn visit_assigned_values(encoding: &Value, mut visitor: impl FnMut(&Value)) {
    let budget = crate::facets::node_budget(match field(encoding, "triangleCount") {
        Some(Value::Number(n)) => *n,
        _ => f64::NAN,
    });
    let mut stack: Vec<&Value> = match field(encoding, "splits") {
        Some(Value::Array(splits)) => splits
            .iter()
            .rev()
            .filter_map(|s| field(s, "node"))
            .collect(),
        _ => vec![],
    };
    let mut visited = 0usize;
    while (visited as f64) < budget {
        let Some(node) = stack.pop() else { break };
        if !matches!(node, Value::Object(_)) {
            continue;
        }
        visited += 1;
        if text_is(field(node, "kind"), "leaf") {
            if let Some(state) = field(node, "state")
                && text_is(field(state, "kind"), "assigned")
                && let Some(value) = field(state, "value")
            {
                visitor(value);
            }
            continue;
        }
        if let Some(Value::Array(children)) = field(node, "children") {
            stack.extend(children.iter().rev());
        }
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    fields.get(&name.encode_utf16().collect::<Vec<_>>())
}
fn text_is(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(units)) if units.iter().copied().eq(expected.encode_utf16()))
}
fn config<'a>(map: &'a ConfigMap, key: &str) -> Option<&'a Value> {
    field(map.value(), key)
}

fn filament_entity(id: &PhysicalFilamentId) -> SelectionRef {
    SelectionRef::Filament(id.clone().into())
}
fn tools(count: f64) -> &'static str {
    if count == 1.0 { "" } else { "s" }
}

/// `checkFilaments`: returns the physical filaments the plate prints with,
/// directly or as recipe components, in first-use order.
fn check_filaments(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    used: &Ordered<Vec<u16>>,
    constraints: &Constraints,
) -> Ordered<PhysicalFilamentId> {
    // Maps built from the arrays keep the last filament with an ID.
    let physical_by_id = |id: &[u16]| {
        state
            .filaments
            .physical
            .iter()
            .rev()
            .find(|f| f.id.as_utf16() == id)
    };
    let mixed_by_id = |id: &[u16]| {
        state
            .filaments
            .mixed
            .iter()
            .rev()
            .find(|f| f.id.as_utf16() == id)
    };
    let mut used_physical = Ordered::new();
    for id in &used.items {
        if let Some(physical) = physical_by_id(id) {
            used_physical.add(physical.id.clone());
            if !physical.enabled {
                add(
                    issues,
                    disabled_filament(&filament_entity(&physical.id), &physical.name),
                );
            }
            continue;
        }
        let Some(mixed) = mixed_by_id(id) else {
            continue;
        };
        let entity = SelectionRef::Filament(mixed.id.clone().into());
        if !mixed.enabled {
            add(issues, disabled_filament(&entity, &mixed.name));
        }
        if mixed.full_spectrum.as_ref().is_some_and(|r| r.deleted) {
            add(
                issues,
                Draft::error(
                    Code::DeletedMixedFilamentAssignment,
                    s("Assigned virtual filament ")
                        .u(mixed.name.units())
                        .s(" is a deleted tombstone.")
                        .text(),
                    vec![entity.clone()],
                    vec![
                        action(ActionId::Reveal, "Reveal virtual filament", Some(&entity)),
                        action(
                            ActionId::ChooseFilament,
                            "Choose a replacement filament",
                            Some(&entity),
                        ),
                    ],
                ),
            );
        }
        check_mixed_printer_capability(issues, mixed, &entity, constraints.printer.as_ref());
        for component in mixed.components.iter() {
            used_physical.add(component.filament_id.clone());
            let filament = physical_by_id(component.filament_id.as_utf16());
            // A component absent from the library is already a canonical
            // `dangling-mixed-component` error; only availability is left.
            if filament.is_some_and(|f| f.enabled) {
                continue;
            }
            let component_entity = filament_entity(&component.filament_id);
            let name = filament.map_or(component.filament_id.as_utf16(), |f| f.name.units());
            add(
                issues,
                Draft::error(
                    Code::DisabledMixedComponent,
                    u(mixed.name.units())
                        .s(" uses unavailable physical component ")
                        .u(name)
                        .s(".")
                        .text(),
                    vec![entity.clone(), component_entity.clone()],
                    vec![
                        action(ActionId::Reveal, "Reveal virtual filament", Some(&entity)),
                        action(
                            ActionId::ChooseFilament,
                            "Replace unavailable component",
                            Some(&component_entity),
                        ),
                    ],
                ),
            );
        }
        check_mixed_material_compatibility(issues, state, mixed, &entity);
        check_gradient_recipe(issues, state, mixed, &entity, constraints.printer.as_ref());
    }

    let blank = |text: &Option<Text>| {
        text.as_ref()
            .is_none_or(|t| trim_utf16(t.units()).is_empty())
    };
    if constraints.require_profile_attestation
        && (blank(&state.printer.profile_id) || blank(&state.printer.profile_hash))
    {
        add(
            issues,
            Draft::error(
                Code::MissingProfileAttestation,
                Text::from_utf8("The selected printer profile is missing an ID or content hash."),
                vec![],
                vec![action(
                    ActionId::ChooseProfile,
                    "Choose an attested printer profile",
                    None,
                )],
            )
            .detail(Text::from_utf8("printer")),
        );
    }
    for id in &used_physical.items {
        let Some(filament) = physical_by_id(id.as_utf16()) else {
            continue;
        };
        let entity = filament_entity(&filament.id);
        if constraints.require_profile_attestation
            && (blank(&filament.preset_id) || blank(&filament.preset_hash))
        {
            add(
                issues,
                Draft::error(
                    Code::MissingProfileAttestation,
                    u(filament.name.units())
                        .s(" is missing a preset ID or content hash.")
                        .text(),
                    vec![entity.clone()],
                    vec![action(
                        ActionId::ChooseProfile,
                        "Choose an attested filament profile",
                        Some(&entity),
                    )],
                )
                .detail(s("filament-tool-").n(filament.tool_id.get()).text()),
            );
        }
        check_physical_tool_range(issues, filament, &entity, constraints.printer.as_ref());
        if let Some(tool) = constraints.tool(filament.tool_id.get()) {
            check_physical_filament(issues, filament, &entity, tool);
        }
    }
    used_physical
}

fn disabled_filament(entity: &SelectionRef, name: &Text) -> Draft {
    Draft::error(
        Code::DisabledFilamentAssignment,
        s("Assigned filament ")
            .u(name.units())
            .s(" is disabled.")
            .text(),
        vec![entity.clone()],
        vec![
            action(ActionId::Reveal, "Reveal filament", Some(entity)),
            action(
                ActionId::ChooseFilament,
                "Choose a replacement filament",
                Some(entity),
            ),
        ],
    )
}

/// `region_config_from_model_volume` clamps an extruder past the printer's
/// tools back to the first tool: a silent single-tool print. Refuse it.
fn check_physical_tool_range(
    issues: &mut Vec<Issue>,
    filament: &PhysicalFilament,
    entity: &SelectionRef,
    printer: Option<&PrinterCapability>,
) {
    let Some(printer) = printer else { return };
    let tool = filament.tool_id.get();
    if tool < printer.physical_tool_count {
        return;
    }
    add(
        issues,
        Draft::error(
            Code::FilamentToolOutOfRange,
            u(filament.name.units())
                .s(" is assigned to physical tool ")
                .n(tool + 1.0)
                .s(", but the selected printer declares ")
                .n(printer.physical_tool_count)
                .s(" tool")
                .s(tools(printer.physical_tool_count))
                .s(". The engine would silently reassign it to the first tool.")
                .text(),
            vec![entity.clone()],
            vec![
                action(
                    ActionId::ChooseFilament,
                    "Reassign to a declared tool",
                    Some(entity),
                ),
                action(
                    ActionId::ChooseProfile,
                    "Choose a printer with more tools",
                    None,
                ),
            ],
        ),
    );
}

/// A FullSpectrum row resolves to two physical heads; a one-tool target would
/// collapse it rather than report the mismatch.
fn check_mixed_printer_capability(
    issues: &mut Vec<Issue>,
    mixed: &MixedFilament,
    entity: &SelectionRef,
    printer: Option<&PrinterCapability>,
) {
    let Some(printer) = printer else { return };
    if printer.physical_tool_count >= 2.0 {
        return;
    }
    add(
        issues,
        Draft::error(
            Code::MixedFilamentUnsupportedPrinter,
            u(mixed.name.units())
                .s(" is a mixed (FullSpectrum) filament, but the selected printer declares ")
                .n(printer.physical_tool_count)
                .s(" physical tool")
                .s(tools(printer.physical_tool_count))
                .s(". Mixing needs at least two.")
                .text(),
            vec![entity.clone()],
            vec![
                action(
                    ActionId::ChooseFilament,
                    "Assign a physical filament instead",
                    Some(entity),
                ),
                action(ActionId::ChooseProfile, "Choose a multi-tool printer", None),
            ],
        ),
    );
}

/// The pinned `MixedColorMatchHelpers` category matrix.
fn check_mixed_material_compatibility(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    mixed: &MixedFilament,
    entity: &SelectionRef,
) {
    let components: Vec<PhysicalFilamentId> = mixed
        .components
        .iter()
        .filter(|c| {
            state
                .filaments
                .physical
                .iter()
                .any(|f| f.id == c.filament_id)
        })
        .map(|c| c.filament_id.clone())
        .collect();
    if components.len() < 2 {
        return;
    }
    let Decision::Refused {
        reason,
        first,
        second,
    } = compatibility::inspect(&state.filaments.physical, &components)
    else {
        return;
    };
    let mut entities = vec![entity.clone(), filament_entity(&first)];
    if let Some(second) = &second {
        entities.push(filament_entity(second));
    }
    add(
        issues,
        Draft::error(
            Code::IncompatibleMixedComponents,
            u(mixed.name.units())
                .s(" mixes incompatible materials. ")
                .u(reason.units())
                .text(),
            entities,
            vec![
                action(ActionId::Reveal, "Reveal virtual filament", Some(entity)),
                action(
                    ActionId::ChooseFilament,
                    "Choose compatible components",
                    Some(entity),
                ),
            ],
        ),
    );
}

/// Canonical validation accepts gradients the pinned manager still repairs:
/// enabled endpoints clamp into [0.01, 0.99], and component decoding drops
/// duplicates and IDs past the printer's tools. Each would print a mix the
/// project never authored.
fn check_gradient_recipe(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    mixed: &MixedFilament,
    entity: &SelectionRef,
    printer: Option<&PrinterCapability>,
) {
    let Some(recipe) = mixed.full_spectrum.as_deref() else {
        return;
    };
    if !recipe.gradient_enabled {
        return;
    }
    let mut report = |detail: &str, message: Units| {
        add(
            issues,
            Draft::error(
                Code::GradientRecipeOutOfBounds,
                u(mixed.name.units()).s(": ").u(&message.0).text(),
                vec![entity.clone()],
                vec![
                    action(ActionId::Reveal, "Reveal virtual filament", Some(entity)),
                    action(
                        ActionId::ChooseFilament,
                        "Edit the gradient recipe",
                        Some(entity),
                    ),
                ],
            )
            .detail(Text::from_utf8(detail))
            .path(
                s("filaments.mixed.")
                    .u(mixed.id.as_utf16())
                    .s(".fullSpectrum.")
                    .s(detail)
                    .text(),
            ),
        );
    };
    for (name, value) in [
        ("gradientStart", recipe.gradient_start.get()),
        ("gradientEnd", recipe.gradient_end.get()),
    ] {
        if value.is_finite() && !(GRADIENT_MIN_RATIO..=GRADIENT_MAX_RATIO).contains(&value) {
            report(
                name,
                s(name)
                    .s(" is ")
                    .n(value)
                    .s("; the engine clamps an enabled gradient into [")
                    .n(GRADIENT_MIN_RATIO)
                    .s(", ")
                    .n(GRADIENT_MAX_RATIO)
                    .s("]."),
            );
        }
    }
    let mut seen = BTreeSet::new();
    for id in recipe.gradient_component_ids.iter() {
        let Some(filament) = state.filaments.physical.iter().rev().find(|f| &f.id == id) else {
            continue;
        };
        if !seen.insert(id) {
            report(
                "gradientComponentIds",
                s("gradient component ")
                    .u(filament.name.units())
                    .s(" is listed twice; the engine keeps only the first occurrence."),
            );
            continue;
        }
        if let Some(printer) = printer
            && filament.tool_id.get() >= printer.physical_tool_count
        {
            report(
                "gradientComponentIds",
                s("gradient component ")
                    .u(filament.name.units())
                    .s(" sits on tool ")
                    .n(filament.tool_id.get() + 1.0)
                    .s(", beyond the printer's ")
                    .n(printer.physical_tool_count)
                    .s("; the engine drops it while decoding."),
            );
        }
    }
}

/// `MixedFilamentManager::total_filaments` against the engine ceiling.
fn check_engine_capacity(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    printer: Option<&PrinterCapability>,
) {
    let limit = printer
        .and_then(|p| p.max_total_filaments)
        .unwrap_or(PINNED_MAXIMUM_FILAMENT_NUMBER);
    let physical = state.filaments.physical.len() as f64;
    let virtual_count = state
        .filaments
        .mixed
        .iter()
        .filter(|m| m.enabled && !m.full_spectrum.as_ref().is_some_and(|r| r.deleted))
        .count() as f64;
    let total = physical + virtual_count;
    if total <= limit {
        return;
    }
    add(
        issues,
        Draft::error(
            Code::FilamentCountExceedsEngineLimit,
            s("The project declares ")
                .n(physical)
                .s(" physical and ")
                .n(virtual_count)
                .s(" enabled virtual filaments (")
                .n(total)
                .s("); the engine addresses at most ")
                .n(limit)
                .s(".")
                .text(),
            vec![SelectionRef::Project],
            vec![action(
                ActionId::ChooseFilament,
                "Remove or disable filaments",
                None,
            )],
        ),
    );
}

fn check_physical_filament(
    issues: &mut Vec<Issue>,
    filament: &PhysicalFilament,
    entity: &SelectionRef,
    constraint: &ToolConstraints,
) {
    let tool = filament.tool_id.get() + 1.0;
    if let (Some(actual), Some(expected)) = (
        filament.nozzle_diameter_mm.map(|n| n.get()),
        constraint.nozzle_diameter_mm,
    ) && (actual - expected).abs() > 1e-6
    {
        add(
            issues,
            Draft::error(
                Code::FilamentNozzleMismatch,
                u(filament.name.units())
                    .s(" targets a ")
                    .n(actual)
                    .s(" mm nozzle, but tool ")
                    .n(tool)
                    .s(" is configured for ")
                    .n(expected)
                    .s(" mm.")
                    .text(),
                vec![entity.clone()],
                vec![action(
                    ActionId::ChooseProfile,
                    "Choose a compatible filament profile",
                    Some(entity),
                )],
            ),
        );
    }
    if let Some(materials) = &constraint.supported_materials {
        let material = js_lower(trim_utf16(filament.material.units()));
        if !materials
            .iter()
            .any(|m| js_lower(trim_utf16(m.units())) == material)
        {
            let name = if filament.material.units().is_empty() {
                filament.name.units()
            } else {
                filament.material.units()
            };
            add(
                issues,
                Draft::error(
                    Code::UnsupportedFilamentMaterial,
                    u(name)
                        .s(" is not supported on tool ")
                        .n(tool)
                        .s(".")
                        .text(),
                    vec![entity.clone()],
                    vec![action(
                        ActionId::ChooseFilament,
                        "Choose a supported material",
                        Some(entity),
                    )],
                ),
            );
        }
    }
    check_temperatures(issues, filament, entity, constraint);
}

/// `String.prototype.toLowerCase` over UTF-16. A lone surrogate is kept and,
/// being neither cased nor case-ignorable, bounds the final-sigma context.
fn js_lower(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut segment = String::new();
    let flush = |segment: &mut String, out: &mut Vec<u16>| {
        out.extend(segment.to_lowercase().encode_utf16());
        segment.clear();
    };
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => segment.push(c),
            Err(lone) => {
                flush(&mut segment, &mut out);
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    flush(&mut segment, &mut out);
    out
}

fn check_temperatures(
    issues: &mut Vec<Issue>,
    filament: &PhysicalFilament,
    entity: &SelectionRef,
    constraint: &ToolConstraints,
) {
    for key in ["nozzle_temperature", "nozzle_temperature_initial_layer"] {
        let Some(value) = config(&filament.config, key) else {
            continue;
        };
        let path = s("filaments.")
            .u(filament.id.as_utf16())
            .s(".config.")
            .s(key)
            .text();
        let values = config_numbers(Some(value)).filter(|v| !v.is_empty());
        let Some(values) = values else {
            add(
                issues,
                Draft::error(
                    Code::InvalidFilamentTemperature,
                    u(filament.name.units())
                        .s(" has an invalid ")
                        .s(key)
                        .s(" value.")
                        .text(),
                    vec![entity.clone()],
                    vec![setting(
                        ActionId::ChooseProfile,
                        "Choose a valid filament profile",
                        Some(entity),
                        key,
                    )],
                )
                .detail(Text::from_utf8(key))
                .path(path),
            );
            continue;
        };
        let (minimum, maximum) = (
            constraint.min_hotend_temperature_c,
            constraint.max_hotend_temperature_c,
        );
        let Some(out_of_range) = values
            .into_iter()
            .find(|v| minimum.is_some_and(|lo| *v < lo) || maximum.is_some_and(|hi| *v > hi))
        else {
            continue;
        };
        let range = match (minimum, maximum) {
            (Some(lo), Some(hi)) => {
                format!("{}–{} °C range", number_to_string(lo), number_to_string(hi))
            }
            (Some(lo), None) => format!("minimum {} °C", number_to_string(lo)),
            (None, Some(hi)) => format!("maximum {} °C", number_to_string(hi)),
            (None, None) => "configured temperature range".to_owned(),
        };
        add(
            issues,
            Draft::error(
                Code::FilamentTemperatureOutOfRange,
                u(filament.name.units())
                    .s(" requests ")
                    .n(out_of_range)
                    .s(" °C, outside tool ")
                    .n(filament.tool_id.get() + 1.0)
                    .s("'s ")
                    .s(&range)
                    .s(".")
                    .text(),
                vec![entity.clone()],
                vec![setting(
                    ActionId::ChooseProfile,
                    "Choose a temperature-compatible profile",
                    Some(entity),
                    key,
                )],
            )
            .detail(Text::from_utf8(key))
            .path(path),
        );
    }
}

/// `parseConfigNumbers`: an array, a `;`/`,` list or one value, all of whose
/// items must be finite numbers or numeric strings; `None` when any is not.
fn config_numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    let parse = |item: Option<&Value>| match item {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        Some(Value::String(text)) => {
            let text = trim_utf16(text);
            let n = utf16_number(text);
            (!text.is_empty() && n.is_finite()).then_some(n)
        }
        _ => None,
    };
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| parse(Some(item))).collect(),
        Some(Value::String(text)) => text
            .split(|unit| *unit == u16::from(b';') || *unit == u16::from(b','))
            .map(|piece| parse(Some(&Value::String(piece.to_vec()))))
            .collect(),
        other => parse(other).map(|n| vec![n]),
    }
}

/// `parseConfigBoolean`.
fn config_boolean(view: &ConfigView<'_>, key: &str) -> Option<bool> {
    match view.get(&key.encode_utf16().collect::<Vec<_>>())? {
        Value::Bool(value) => Some(*value),
        Value::Number(n) => Some(*n != 0.0),
        Value::String(text) => {
            // No non-ASCII code point lower-cases to these ASCII spellings.
            let text = trim_utf16(text);
            let is = |word: &str| {
                text.len() == word.len()
                    && text.iter().zip(word.bytes()).all(|(unit, byte)| {
                        *unit < 0x80 && (*unit as u8).eq_ignore_ascii_case(&byte)
                    })
            };
            if is("1") || is("true") {
                Some(true)
            } else if is("0") || is("false") {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `wipeTowerFootprintMarginMm`: the brim, plus half the rib width and extra
/// rib length for a rib wall, that the tower prints outside its body.
pub fn wipe_tower_footprint_margin_mm<'a>(get: impl Fn(&str) -> Option<&'a Value>) -> f64 {
    let numeric = |value: Option<&Value>| {
        let parsed = match value {
            Some(Value::Number(n)) => *n,
            Some(Value::Array(items)) => value_to_number(items.first()),
            other => value_to_number(other),
        };
        parsed.is_finite().then_some(parsed)
    };
    let brim = js_math::max(0.0, numeric(get("prime_tower_brim_width")).unwrap_or(0.0));
    let wall = match get("wipe_tower_wall_type") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => value_to_string(value),
    };
    let wall = trim_utf16(&wall);
    let rib = wall.len() == 3
        && wall
            .iter()
            .zip(b"rib")
            .all(|(unit, byte)| *unit < 0x80 && (*unit as u8).eq_ignore_ascii_case(byte));
    if !rib {
        return brim;
    }
    let rib_width = js_math::max(0.0, numeric(get("wipe_tower_rib_width")).unwrap_or(0.0));
    let extra = js_math::max(
        0.0,
        numeric(get("wipe_tower_extra_rib_length")).unwrap_or(0.0),
    );
    brim + rib_width / 2.0 + extra / 2.0
}

fn check_wipe_tower(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    plate: &ProjectPlate,
    constraints: &Constraints,
    used_physical: &Ordered<PhysicalFilamentId>,
) {
    let Some(tower) = plate.wipe_tower.as_deref() else {
        return;
    };
    if !tower.enabled {
        return;
    }
    let plate_entity = SelectionRef::Plate(plate.id.clone());
    check_wipe_tower_feasibility(
        issues,
        state,
        plate,
        &plate_entity,
        constraints,
        used_physical,
    );
    if let Some(volume) = &constraints.build_volume {
        // `{ ...state.config, ...plate.config }`: the plate's key wins.
        let get = |key: &str| config(&plate.config, key).or_else(|| config(&state.config, key));
        let width = match get("prime_tower_width") {
            None | Some(Value::Null) => get("wipe_tower_width"),
            value => value,
        };
        let width = match value_to_number(width) {
            n if n.is_nan() || n == 0.0 => 60.0,
            n => n,
        };
        let margin = wipe_tower_footprint_margin_mm(get);
        let [x, y] = tower.position_mm.map(|n| n.get());
        let (x_min, y_min) = (x - margin, y - margin);
        let (x_max, y_max) = (x + width + margin, y + width + margin);
        if x_min < volume.min_x_mm
            || x_max > volume.max_x_mm
            || y_min < volume.min_y_mm
            || y_max > volume.max_y_mm
        {
            let f = |v: f64| to_fixed(v, 1);
            add(
                issues,
                Draft::error(
                    Code::WipeTowerOutsideBuildVolume,
                    Text::from_utf8(&format!(
                        "Wipe-tower footprint {}–{} × {}–{} mm (origin {}, {} mm, including its brim) leaves the build volume {}–{} × {}–{} mm.",
                        f(x_min),
                        f(x_max),
                        f(y_min),
                        f(y_max),
                        number_to_string(x),
                        number_to_string(y),
                        f(volume.min_x_mm),
                        f(volume.max_x_mm),
                        f(volume.min_y_mm),
                        f(volume.max_y_mm)
                    )),
                    vec![plate_entity.clone()],
                    vec![
                        action(ActionId::Reveal, "Reveal wipe tower", Some(&plate_entity)),
                        action(
                            ActionId::DisableWipeTower,
                            "Disable wipe tower",
                            Some(&plate_entity),
                        ),
                    ],
                ),
            );
        }
    }
    if let Some(id) = &tower.filament_id
        && !state
            .filaments
            .physical
            .iter()
            .any(|f| f.id.as_utf16() == id.as_utf16())
    {
        add(
            issues,
            Draft::error(
                Code::WipeTowerRequiresPhysicalFilament,
                Text::from_utf8(
                    "The wipe tower must use an enabled physical filament, not a virtual recipe.",
                ),
                vec![plate_entity.clone(), SelectionRef::Filament(id.clone())],
                vec![action(
                    ActionId::ChooseFilament,
                    "Choose a physical wipe-tower filament",
                    Some(&plate_entity),
                )],
            ),
        );
    }
}

/// `Print::validate()` prime-tower preconditions: relative extrusion, no ooze
/// prevention with single-extruder multi-material, and the upstream warning
/// for mismatched nozzle or filament diameters across the used tools.
fn check_wipe_tower_feasibility(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    plate: &ProjectPlate,
    plate_entity: &SelectionRef,
    constraints: &Constraints,
    used_physical: &Ordered<PhysicalFilamentId>,
) {
    let request = ConfigResolutionRequest {
        plate_id: &plate.id,
        object_id: None,
        volume_id: None,
        layer_range_id: None,
    };
    if let Ok(resolved) = resolve_config(state, request) {
        let config = &resolved.effective;
        if config_boolean(config, "use_relative_e_distances") == Some(false) {
            add(
                issues,
                Draft::error(
                    Code::WipeTowerRequiresRelativeE,
                    Text::from_utf8(
                        "The wipe tower needs relative extruder addressing (use_relative_e_distances = 1).",
                    ),
                    vec![plate_entity.clone()],
                    vec![
                        setting(
                            ActionId::ChooseProfile,
                            "Enable relative E addressing",
                            None,
                            "use_relative_e_distances",
                        ),
                        action(
                            ActionId::DisableWipeTower,
                            "Disable wipe tower",
                            Some(plate_entity),
                        ),
                    ],
                )
                .path(Text::from_utf8("config.use_relative_e_distances")),
            );
        }
        if config_boolean(config, "ooze_prevention") == Some(true)
            && config_boolean(config, "single_extruder_multi_material") == Some(true)
        {
            add(
                issues,
                Draft::error(
                    Code::WipeTowerOozePreventionConflict,
                    Text::from_utf8(
                        "Ooze prevention only works with the wipe tower when single_extruder_multi_material is off.",
                    ),
                    vec![plate_entity.clone()],
                    vec![
                        setting(
                            ActionId::ChooseProfile,
                            "Turn off ooze prevention",
                            None,
                            "ooze_prevention",
                        ),
                        action(
                            ActionId::DisableWipeTower,
                            "Disable wipe tower",
                            Some(plate_entity),
                        ),
                    ],
                )
                .path(Text::from_utf8("config.ooze_prevention")),
            );
        }
    }

    let mut used: Vec<&Arc<PhysicalFilament>> = state
        .filaments
        .physical
        .iter()
        .filter(|f| used_physical.contains(&f.id))
        .collect();
    // Array.prototype.sort is stable; tool IDs are finite.
    used.sort_by(|a, b| {
        a.tool_id
            .get()
            .partial_cmp(&b.tool_id.get())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let Some((first, rest)) = used.split_first() else {
        return;
    };
    if rest.is_empty() {
        return;
    }
    let nozzle_of = |f: &PhysicalFilament| {
        constraints
            .tool(f.tool_id.get())
            .and_then(|t| t.nozzle_diameter_mm)
            .or(f.nozzle_diameter_mm.map(|n| n.get()))
    };
    let diameter_of = |f: &PhysicalFilament| {
        config_numbers(config(&f.config, "filament_diameter")).and_then(|v| v.first().copied())
    };
    let first_nozzle = nozzle_of(first);
    let first_diameter = diameter_of(first);
    for filament in rest {
        let nozzle_mismatch = matches!((first_nozzle, nozzle_of(filament)),
            (Some(a), Some(b)) if (b - a).abs() > WIPE_TOWER_NOZZLE_EPSILON);
        let diameter_mismatch = matches!((first_diameter, diameter_of(filament)),
            (Some(a), Some(b)) if a != 0.0 && ((b - a) / a).abs() > WIPE_TOWER_FILAMENT_DIAMETER_TOLERANCE);
        if !nozzle_mismatch && !diameter_mismatch {
            continue;
        }
        let entity = filament_entity(&filament.id);
        let (detail, kind) = if nozzle_mismatch {
            ("nozzle_diameter", "nozzle")
        } else {
            ("filament_diameter", "filament")
        };
        add(
            issues,
            Draft::error(
                Code::WipeTowerMixedExtruderDiameters,
                u(filament.name.units())
                    .s(" on tool ")
                    .n(filament.tool_id.get() + 1.0)
                    .s(" uses a different ")
                    .s(kind)
                    .s(" diameter than tool ")
                    .n(first.tool_id.get() + 1.0)
                    .s("; the pinned engine treats that as experimental with the prime tower.")
                    .text(),
                vec![plate_entity.clone(), entity.clone()],
                vec![action(
                    ActionId::ChooseProfile,
                    "Match the tool diameters",
                    Some(&entity),
                )],
            )
            .detail(Text::from_utf8(detail))
            .warning(),
        );
    }
}

fn check_custom_gcode(
    issues: &mut Vec<Issue>,
    state: &ProjectState,
    plate: &ProjectPlate,
    constraints: &Constraints,
) {
    let limit = constraints
        .custom_gcode_byte_limit
        .unwrap_or(DEFAULT_CUSTOM_GCODE_LIMIT);
    for entry in state.custom_gcode.iter() {
        if entry.scope == GcodeScope::Plate && entry.plate_id.as_ref() != Some(&plate.id) {
            continue;
        }
        let code = entry.code.units();
        let nul = code.contains(&0);
        // TextEncoder writes U+FFFD (three bytes) for a lone surrogate.
        let bytes: usize = char::decode_utf16(code.iter().copied())
            .map(|c| c.map_or(3, char::len_utf8))
            .sum();
        if !nul && bytes as f64 <= limit {
            continue;
        }
        let plate_entity = SelectionRef::Plate(plate.id.clone());
        let message = if nul {
            Text::from_utf8(
                "Custom G-code contains a NUL byte and cannot be passed to the engine safely.",
            )
        } else {
            s("Custom G-code is ")
                .n(bytes as f64)
                .s(" bytes; the configured limit is ")
                .n(limit)
                .s(".")
                .text()
        };
        add(
            issues,
            Draft::error(
                Code::UnsafeCustomGcode,
                message,
                vec![plate_entity.clone()],
                vec![Action {
                    setting_key: Some(Text::new(entry.id.as_utf16())),
                    ..action(
                        ActionId::EditCustomGcode,
                        "Edit custom G-code",
                        Some(&plate_entity),
                    )
                }],
            )
            .detail(Text::from_utf8(if nul { "nul-byte" } else { "byte-limit" }))
            .path(s("customGcode.").u(entry.id.as_utf16()).s(".code").text()),
        );
    }
}

/// Errors first, then code and ID in UTF-16 order; ties keep their evaluation
/// order, as the browser's stable sort does.
pub(super) fn sort_issues(issues: &mut [Issue]) {
    let rank = |s: Severity| match s {
        Severity::Error => 0,
        Severity::Warning => 1,
    };
    issues.sort_by(|a, b| {
        rank(a.severity)
            .cmp(&rank(b.severity))
            .then_with(|| a.code.as_str().cmp(b.code.as_str()))
            .then_with(|| a.id.units().cmp(b.id.units()))
    });
}

/// `finish`: sorted issues, sorted printable instances and used filaments.
fn finish(
    plate_id: &PlateId,
    mut issues: Vec<Issue>,
    mut printable: Vec<InstanceId>,
    used: Ordered<Vec<u16>>,
) -> Preflight {
    sort_issues(&mut issues);
    let blocking_count = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    printable.sort_by(|a, b| a.as_utf16().cmp(b.as_utf16()));
    // Admission proves every used value names a filament, so each is stable.
    let mut used_filament_ids: Vec<FilamentId> = used
        .items
        .into_iter()
        .filter_map(|units| FilamentId::try_from_utf16(units).ok())
        .collect();
    used_filament_ids.sort_by(|a, b| a.as_utf16().cmp(b.as_utf16()));
    Preflight {
        plate_id: plate_id.clone(),
        can_slice: blocking_count == 0 && !printable.is_empty(),
        blocking_count,
        issues,
        printable_instance_ids: printable,
        used_filament_ids,
    }
}
