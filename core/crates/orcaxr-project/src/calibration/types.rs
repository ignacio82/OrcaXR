use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CALIBRATION_JOB_SCHEMA_VERSION: u32 = 1;
pub const CALIBRATION_JOB_DEFINITION_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalibrationWorkflowId {
    TemperatureTower,
    FlowPass1,
    FlowPass2,
    FlowYolo,
    FlowYoloPerfectionist,
    PressureAdvanceTower,
    PressureAdvanceLine,
    PressureAdvancePattern,
    RetractionTower,
    MaxVolumetricSpeed,
    JunctionDeviation,
    InputShapingFrequency,
    InputShapingDamping,
    Vfa,
    ToleranceExtension,
}

impl CalibrationWorkflowId {
    pub const ALL: &'static [Self] = &[
        Self::TemperatureTower,
        Self::FlowPass1,
        Self::FlowPass2,
        Self::FlowYolo,
        Self::FlowYoloPerfectionist,
        Self::PressureAdvanceTower,
        Self::PressureAdvanceLine,
        Self::PressureAdvancePattern,
        Self::RetractionTower,
        Self::MaxVolumetricSpeed,
        Self::JunctionDeviation,
        Self::InputShapingFrequency,
        Self::InputShapingDamping,
        Self::Vfa,
        Self::ToleranceExtension,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::TemperatureTower => "temperature-tower",
            Self::FlowPass1 => "flow-pass-1",
            Self::FlowPass2 => "flow-pass-2",
            Self::FlowYolo => "flow-yolo",
            Self::FlowYoloPerfectionist => "flow-yolo-perfectionist",
            Self::PressureAdvanceTower => "pressure-advance-tower",
            Self::PressureAdvanceLine => "pressure-advance-line",
            Self::PressureAdvancePattern => "pressure-advance-pattern",
            Self::RetractionTower => "retraction-tower",
            Self::MaxVolumetricSpeed => "max-volumetric-speed",
            Self::JunctionDeviation => "junction-deviation",
            Self::InputShapingFrequency => "input-shaping-frequency",
            Self::InputShapingDamping => "input-shaping-damping",
            Self::Vfa => "vfa",
            Self::ToleranceExtension => "tolerance-extension",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|id| id.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationExecutionMode {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationFirmwareFlavor {
    Klipper,
    Marlin,
    Reprap,
}

impl CalibrationFirmwareFlavor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Klipper => "klipper",
            Self::Marlin => "marlin",
            Self::Reprap => "reprap",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "klipper" => Some(Self::Klipper),
            "marlin" => Some(Self::Marlin),
            "reprap" => Some(Self::Reprap),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalibrationFirmwareCapability {
    NozzleTemperature,
    PressureAdvance,
    InputShaping,
    JunctionDeviation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationPlanEffectKind {
    Band,
    Object,
    Line,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CalibrationParameterValue {
    String(String),
    Number(f64),
    Boolean(bool),
    NumberList(Vec<f64>),
}

impl CalibrationParameterValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Boolean(b) => Some(*b),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationNumericRange {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub min_inclusive: bool,
    pub max_inclusive: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationParameterDefinition {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: Option<String>,
    pub editable: bool,
    pub default: CalibrationParameterValue,
    pub choices: Vec<String>,
    pub range: Option<CalibrationNumericRange>,
    pub max_items: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPrinterPrerequisiteDefinition {
    pub min_bed_width_mm: f64,
    pub min_bed_depth_mm: f64,
    pub min_build_height_mm: f64,
    pub min_max_print_speed_mm_per_s: f64,
    pub min_max_acceleration_mm_per_s2: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationNozzlePrerequisiteDefinition {
    pub min_diameter_mm: f64,
    pub max_diameter_mm: f64,
    pub requires_temperature_envelope: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFilamentPrerequisiteDefinition {
    pub requires_temperature_envelope: bool,
    pub requires_flow_ratio: bool,
    pub requires_max_volumetric_speed: bool,
    pub requires_retraction_length: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationProcessPrerequisiteDefinition {
    pub requires_layer_height: bool,
    pub requires_line_width: bool,
    pub requires_outer_wall_speed: bool,
    pub requires_acceleration: bool,
    pub requires_xy_compensation: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFirmwarePrerequisiteDefinition {
    pub allowed_flavors: Vec<CalibrationFirmwareFlavor>,
    pub capabilities: Vec<CalibrationFirmwareCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResource {
    pub path: String,
    pub blob: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationGeometryDefinition {
    pub kind: String,
    pub resources: Vec<CalibrationResource>,
    pub source_envelope_mm: [f64; 3],
    pub z_trimmable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResultField {
    pub key: String,
    pub label: String,
    pub unit: Option<String>,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPresetTarget {
    pub scope: String,
    pub key: String,
    pub application: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPrerequisitesDefinition {
    pub printer: CalibrationPrinterPrerequisiteDefinition,
    pub nozzle: CalibrationNozzlePrerequisiteDefinition,
    pub filament: CalibrationFilamentPrerequisiteDefinition,
    pub process: CalibrationProcessPrerequisiteDefinition,
    pub firmware: CalibrationFirmwarePrerequisiteDefinition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJobDefinition {
    pub schema_version: u32,
    pub definition_version: u32,
    pub id: String,
    pub fingerprint: String,
    pub label: String,
    pub source_commit: String,
    pub inventory_effect_categories: Vec<String>,
    pub effect_kind: CalibrationPlanEffectKind,
    pub parameters: Vec<CalibrationParameterDefinition>,
    pub prerequisites: CalibrationPrerequisitesDefinition,
    pub geometry: CalibrationGeometryDefinition,
    pub result_fields: Vec<CalibrationResultField>,
    pub preset_targets: Vec<CalibrationPresetTarget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPrinterPrerequisites {
    pub id: String,
    pub manufacturer: String,
    pub model: String,
    pub bed_width_mm: f64,
    pub bed_depth_mm: f64,
    pub build_height_mm: f64,
    pub max_print_speed_mm_per_s: f64,
    pub max_acceleration_mm_per_s2: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationNozzlePrerequisites {
    pub diameter_mm: f64,
    pub min_temperature_c: f64,
    pub max_temperature_c: f64,
    pub max_layer_height_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFilamentPrerequisites {
    pub id: String,
    pub name: String,
    pub material: String,
    pub min_temperature_c: f64,
    pub max_temperature_c: f64,
    pub flow_ratio: f64,
    pub max_volumetric_speed_mm3_per_s: f64,
    pub retraction_length_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationProcessPrerequisites {
    pub id: String,
    pub layer_height_mm: f64,
    pub first_layer_height_mm: f64,
    pub line_width_mm: f64,
    pub outer_wall_speed_mm_per_s: f64,
    pub default_acceleration_mm_per_s2: f64,
    pub xy_hole_compensation_mm: f64,
    pub xy_contour_compensation_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFirmwarePrerequisites {
    pub flavor: CalibrationFirmwareFlavor,
    pub nozzle_temperature: bool,
    pub pressure_advance: bool,
    pub input_shaping: bool,
    pub junction_deviation: bool,
    pub max_input_shaping_frequency_hz: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJobPrerequisites {
    pub printer: CalibrationPrinterPrerequisites,
    pub nozzle: CalibrationNozzlePrerequisites,
    pub filament: CalibrationFilamentPrerequisites,
    pub process: CalibrationProcessPrerequisites,
    pub firmware: CalibrationFirmwarePrerequisites,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJobRequest {
    pub schema_version: u32,
    pub definition_id: String,
    pub definition_version: u32,
    pub definition_fingerprint: String,
    pub execution: CalibrationExecutionMode,
    pub parameters: BTreeMap<String, CalibrationParameterValue>,
    pub prerequisites: CalibrationJobPrerequisites,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationEngineOverride {
    pub scope: String,
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationLineMm {
    pub start: [f64; 3],
    pub end: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPlanEffect {
    pub kind: CalibrationPlanEffectKind,
    pub order: u32,
    pub label: String,
    pub parameter_key: String,
    pub value: serde_json::Value,
    pub unit: Option<String>,
    pub z_range_mm: Option<[f64; 2]>,
    pub position_mm: Option<[f64; 3]>,
    pub line_mm: Option<CalibrationLineMm>,
    pub engine_overrides: Vec<CalibrationEngineOverride>,
    pub custom_gcode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationSliceAssertion {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub operator: String,
    pub expected: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPlanGeometry {
    pub kind: String,
    pub resources: Vec<CalibrationResource>,
    pub source_envelope_mm: [f64; 3],
    pub required_envelope_mm: [f64; 3],
    pub translation_mm: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJobPlan {
    pub schema_version: u32,
    pub job_id: String,
    pub definition_id: String,
    pub definition_version: u32,
    pub definition_fingerprint: String,
    pub label: String,
    pub execution: String,
    pub parameters: BTreeMap<String, CalibrationParameterValue>,
    pub prerequisites: CalibrationJobPrerequisites,
    pub geometry: CalibrationPlanGeometry,
    pub effects: Vec<CalibrationPlanEffect>,
    pub expected_labels: Vec<String>,
    pub slice_assertions: Vec<CalibrationSliceAssertion>,
    pub result_fields: Vec<CalibrationResultField>,
    pub preset_targets: Vec<CalibrationPresetTarget>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJobValidationIssue {
    pub code: String,
    pub path: String,
    pub message: String,
}
