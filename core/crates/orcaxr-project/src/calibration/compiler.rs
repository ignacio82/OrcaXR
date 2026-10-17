use super::definitions::get_calibration_job_definition;
use super::types::*;
use crate::js_math::convert::{number_to_string, to_fixed};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub const MAX_CALIBRATION_EFFECTS: usize = 512;

fn round(value: f64) -> f64 {
    let epsilon = f64::EPSILON;
    ((value + epsilon) * 1_000_000.0).round() / 1_000_000.0
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                number_to_string(round(f))
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
}

fn format_f64(value: f64) -> String {
    number_to_string(round(value))
}

fn sweep_count(span: f64, step: f64) -> usize {
    ((span / step).round() as isize + 1).max(0) as usize
}

fn ascending_sweep(start: f64, end: f64, step: f64) -> Vec<f64> {
    let count = sweep_count(end - start, step);
    (0..count).map(|i| round(start + (i as f64) * step)).collect()
}

fn descending_sweep(start: f64, end: f64, step: f64) -> Vec<f64> {
    let count = sweep_count(start - end, step);
    (0..count).map(|i| round(start - (i as f64) * step)).collect()
}

fn translation_column(index: usize, count: usize, extent: f64) -> f64 {
    ((index + 1) as f64 * extent) / ((count + 1) as f64)
}

fn selected_tower_envelope(parameters: &BTreeMap<String, CalibrationParameterValue>) -> [f64; 3] {
    if let Some(CalibrationParameterValue::String(m)) = parameters.get("testModel")
        && m == "Fast Tower" {
            return [40.282, 40.261, 60.001];
        }
    [120.001, 120.0, 60.0]
}

fn selected_tower_height(parameters: &BTreeMap<String, CalibrationParameterValue>) -> f64 {
    selected_tower_envelope(parameters)[2]
}

fn layer_effect_count(prerequisites: &CalibrationJobPrerequisites, height_mm: f64) -> usize {
    (height_mm / prerequisites.process.layer_height_mm).ceil() as usize
}

fn volumetric_wall_speed(value: f64, prerequisites: &CalibrationJobPrerequisites) -> f64 {
    let nozzle = prerequisites.nozzle.diameter_mm;
    let line_width = nozzle * 1.75;
    let layer_height = nozzle * 0.8;
    let cross_section = layer_height * (line_width - layer_height)
        + std::f64::consts::PI * (layer_height / 2.0).powi(2);
    value / (cross_section * prerequisites.filament.flow_ratio)
}

fn validate_job_id(job_id: &str, issues: &mut Vec<CalibrationJobValidationIssue>) {
    let valid = !job_id.is_empty()
        && job_id.starts_with("calibration:")
        && job_id[12..].chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && job_id[12..].chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == ':' || c == '-'
        })
        && job_id.len() <= 140;
    if !valid {
        issues.push(CalibrationJobValidationIssue {
            code: "job-id".to_string(),
            path: "$.jobId".to_string(),
            message: "Expected a stable calibration:<id> identity".to_string(),
        });
    }
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f)
}

pub fn create_default_calibration_job_request(
    definition_id: &str,
    prerequisites: &CalibrationJobPrerequisites,
    options_parameters: Option<&BTreeMap<String, CalibrationParameterValue>>,
    execution: Option<CalibrationExecutionMode>,
) -> Result<CalibrationJobRequest, Vec<CalibrationJobValidationIssue>> {
    let definition = get_calibration_job_definition(definition_id).ok_or_else(|| {
        vec![CalibrationJobValidationIssue {
            code: "unknown-definition".to_string(),
            path: "$.definitionId".to_string(),
            message: format!("Unknown calibration {definition_id}"),
        }]
    })?;

    let mut parameters = BTreeMap::new();
    for param in &definition.parameters {
        parameters.insert(param.key.clone(), param.default.clone());
    }

    if let Some(supplied) = options_parameters {
        for (k, v) in supplied {
            parameters.insert(k.clone(), v.clone());
        }
    }

    Ok(CalibrationJobRequest {
        schema_version: CALIBRATION_JOB_SCHEMA_VERSION,
        definition_id: definition.id.clone(),
        definition_version: definition.definition_version,
        definition_fingerprint: definition.fingerprint.clone(),
        execution: execution.unwrap_or(CalibrationExecutionMode::Manual),
        parameters,
        prerequisites: prerequisites.clone(),
    })
}

pub fn compile_calibration_job(
    request: &CalibrationJobRequest,
    job_id: &str,
) -> Result<CalibrationJobPlan, Vec<CalibrationJobValidationIssue>> {
    let mut issues = Vec::new();
    validate_job_id(job_id, &mut issues);

    let definition = match get_calibration_job_definition(&request.definition_id) {
        Some(def) => def,
        None => {
            issues.push(CalibrationJobValidationIssue {
                code: "unknown-definition".to_string(),
                path: "$.definitionId".to_string(),
                message: format!("Unknown calibration {}", request.definition_id),
            });
            return Err(issues);
        }
    };

    if request.schema_version != CALIBRATION_JOB_SCHEMA_VERSION {
        issues.push(CalibrationJobValidationIssue {
            code: "schema-version".to_string(),
            path: "$.schemaVersion".to_string(),
            message: format!("Expected schema version {CALIBRATION_JOB_SCHEMA_VERSION}"),
        });
    }
    if request.definition_version != definition.definition_version {
        issues.push(CalibrationJobValidationIssue {
            code: "definition-version".to_string(),
            path: "$.definitionVersion".to_string(),
            message: format!("Expected definition version {}", definition.definition_version),
        });
    }
    if request.definition_fingerprint != definition.fingerprint {
        issues.push(CalibrationJobValidationIssue {
            code: "definition-fingerprint".to_string(),
            path: "$.definitionFingerprint".to_string(),
            message: "Calibration definition is stale".to_string(),
        });
    }
    if request.execution != CalibrationExecutionMode::Manual {
        issues.push(CalibrationJobValidationIssue {
            code: "automatic-unavailable".to_string(),
            path: "$.execution".to_string(),
            message: "Automatic vendor calibration is unavailable; select the generic manual workflow".to_string(),
        });
    }

    let def_params_map: BTreeMap<&str, &CalibrationParameterDefinition> =
        definition.parameters.iter().map(|p| (p.key.as_str(), p)).collect();

    for key in request.parameters.keys() {
        if !def_params_map.contains_key(key.as_str()) {
            issues.push(CalibrationJobValidationIssue {
                code: "unknown-parameter".to_string(),
                path: format!("$.parameters.{key}"),
                message: "Unknown parameter".to_string(),
            });
        }
    }

    for param in &definition.parameters {
        match request.parameters.get(&param.key) {
            None => {
                issues.push(CalibrationJobValidationIssue {
                    code: "missing-parameter".to_string(),
                    path: format!("$.parameters.{}", param.key),
                    message: "Missing parameter".to_string(),
                });
            }
            Some(val) => {
                let path = format!("$.parameters.{}", param.key);
                if !param.editable && val != &param.default {
                    issues.push(CalibrationJobValidationIssue {
                        code: "fixed-parameter".to_string(),
                        path: path.clone(),
                        message: format!("Fixed parameter must equal {}", serde_json::to_string(&param.default).unwrap_or_default()),
                    });
                }
                match param.kind.as_str() {
                    "choice" => {
                        if let CalibrationParameterValue::String(s) = val {
                            if !param.choices.contains(s) {
                                issues.push(CalibrationJobValidationIssue {
                                    code: "choice".to_string(),
                                    path,
                                    message: format!("Expected one of {}", param.choices.join(", ")),
                                });
                            }
                        } else {
                            issues.push(CalibrationJobValidationIssue {
                                code: "choice".to_string(),
                                path,
                                message: format!("Expected one of {}", param.choices.join(", ")),
                            });
                        }
                    }
                    "boolean" => {
                        if !matches!(val, CalibrationParameterValue::Boolean(_)) {
                            issues.push(CalibrationJobValidationIssue {
                                code: "boolean".to_string(),
                                path,
                                message: "Expected a boolean".to_string(),
                            });
                        }
                    }
                    "number" => {
                        if let CalibrationParameterValue::Number(n) = val {
                            if !n.is_finite() {
                                issues.push(CalibrationJobValidationIssue {
                                    code: "number".to_string(),
                                    path,
                                    message: "Expected a finite number".to_string(),
                                });
                            } else {
                                validate_numeric_range(*n, param, &path, &mut issues);
                            }
                        } else {
                            issues.push(CalibrationJobValidationIssue {
                                code: "number".to_string(),
                                path,
                                message: "Expected a finite number".to_string(),
                            });
                        }
                    }
                    "number-list" => {
                        if let CalibrationParameterValue::NumberList(list) = val {
                            if let Some(max_items) = param.max_items
                                && list.len() > max_items as usize {
                                    issues.push(CalibrationJobValidationIssue {
                                        code: "number-list-count".to_string(),
                                        path: path.clone(),
                                        message: format!("Expected at most {max_items} values"),
                                    });
                                }
                            for (idx, entry) in list.iter().enumerate() {
                                let item_path = format!("{path}[{idx}]");
                                if !entry.is_finite() {
                                    issues.push(CalibrationJobValidationIssue {
                                        code: "number-list-entry".to_string(),
                                        path: item_path,
                                        message: "Expected a finite number".to_string(),
                                    });
                                } else {
                                    validate_numeric_range(*entry, param, &item_path, &mut issues);
                                }
                            }
                        } else {
                            issues.push(CalibrationJobValidationIssue {
                                code: "number-list".to_string(),
                                path,
                                message: "Expected a number list".to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    validate_prerequisites(&request.prerequisites, definition, &mut issues);

    if issues.is_empty() {
        validate_cross_field_parameters(definition, &request.parameters, &request.prerequisites, &mut issues);
    }

    if !issues.is_empty() {
        return Err(issues);
    }

    let effects = build_effects(definition, &request.parameters, &request.prerequisites);
    if effects.is_empty() || effects.len() > MAX_CALIBRATION_EFFECTS {
        return Err(vec![CalibrationJobValidationIssue {
            code: "effect-count".to_string(),
            path: "$.parameters".to_string(),
            message: format!("Calibration must produce between 1 and {MAX_CALIBRATION_EFFECTS} effects"),
        }]);
    }

    let required_envelope_mm = required_envelope(definition, &request.parameters, &request.prerequisites, effects.len());
    let mut envelope_issues = Vec::new();
    validate_required_envelope(required_envelope_mm, definition, &request.prerequisites, &mut envelope_issues);
    if !envelope_issues.is_empty() {
        return Err(envelope_issues);
    }

    let translation_mm = [
        round((request.prerequisites.printer.bed_width_mm - required_envelope_mm[0]) / 2.0),
        round((request.prerequisites.printer.bed_depth_mm - required_envelope_mm[1]) / 2.0),
        0.0,
    ];

    let expected_labels: Vec<String> = effects.iter().map(|e| e.label.clone()).collect();
    let slice_assertions = build_slice_assertions(definition, &effects, &expected_labels, required_envelope_mm);

    Ok(CalibrationJobPlan {
        schema_version: CALIBRATION_JOB_SCHEMA_VERSION,
        job_id: job_id.to_string(),
        definition_id: definition.id.clone(),
        definition_version: definition.definition_version,
        definition_fingerprint: definition.fingerprint.clone(),
        label: definition.label.clone(),
        execution: "manual".to_string(),
        parameters: request.parameters.clone(),
        prerequisites: request.prerequisites.clone(),
        geometry: CalibrationPlanGeometry {
            kind: definition.geometry.kind.clone(),
            resources: definition.geometry.resources.clone(),
            source_envelope_mm: definition.geometry.source_envelope_mm,
            required_envelope_mm,
            translation_mm,
        },
        effects,
        expected_labels,
        slice_assertions,
        result_fields: definition.result_fields.clone(),
        preset_targets: definition.preset_targets.clone(),
        warnings: plan_warnings(definition, &request.parameters),
    })
}

fn validate_numeric_range(
    value: f64,
    definition: &CalibrationParameterDefinition,
    path: &str,
    issues: &mut Vec<CalibrationJobValidationIssue>,
) {
    let range = match &definition.range {
        Some(r) => r,
        None => {
            issues.push(CalibrationJobValidationIssue {
                code: "range-missing".to_string(),
                path: path.to_string(),
                message: "Numeric parameter has no definition range".to_string(),
            });
            return;
        }
    };

    let below = if range.min_inclusive { value < range.min } else { value <= range.min };
    let above = if range.max_inclusive { value > range.max } else { value >= range.max };
    if below || above {
        issues.push(CalibrationJobValidationIssue {
            code: "range".to_string(),
            path: path.to_string(),
            message: format!(
                "Expected {}{}, {}{}",
                if range.min_inclusive { "[" } else { "(" },
                range.min,
                range.max,
                if range.max_inclusive { "]" } else { ")" },
            ),
        });
        return;
    }

    let grid = (value - range.min) / range.step;
    if (grid - grid.round()).abs() > 1e-7 * 1.0f64.max(grid.abs()) {
        issues.push(CalibrationJobValidationIssue {
            code: "step".to_string(),
            path: path.to_string(),
            message: format!("Value must align to step {} from {}", range.step, range.min),
        });
    }
}

fn validate_prerequisites(
    prereqs: &CalibrationJobPrerequisites,
    definition: &CalibrationJobDefinition,
    issues: &mut Vec<CalibrationJobValidationIssue>,
) {
    let strings = [
        ("$.prerequisites.printer.id", prereqs.printer.id.as_str()),
        ("$.prerequisites.printer.manufacturer", prereqs.printer.manufacturer.as_str()),
        ("$.prerequisites.printer.model", prereqs.printer.model.as_str()),
        ("$.prerequisites.filament.id", prereqs.filament.id.as_str()),
        ("$.prerequisites.filament.name", prereqs.filament.name.as_str()),
        ("$.prerequisites.filament.material", prereqs.filament.material.as_str()),
        ("$.prerequisites.process.id", prereqs.process.id.as_str()),
    ];
    for (path, val) in strings {
        if val.trim().is_empty() || val.len() > 256 || has_control_characters(val) {
            issues.push(CalibrationJobValidationIssue {
                code: "identity".to_string(),
                path: path.to_string(),
                message: "Expected a bounded non-empty identifier".to_string(),
            });
        }
    }

    let numerics = [
        ("printer.bedWidthMm", prereqs.printer.bed_width_mm),
        ("printer.bedDepthMm", prereqs.printer.bed_depth_mm),
        ("printer.buildHeightMm", prereqs.printer.build_height_mm),
        ("printer.maxPrintSpeedMmPerS", prereqs.printer.max_print_speed_mm_per_s),
        ("printer.maxAccelerationMmPerS2", prereqs.printer.max_acceleration_mm_per_s2),
        ("nozzle.diameterMm", prereqs.nozzle.diameter_mm),
        ("nozzle.maxLayerHeightMm", prereqs.nozzle.max_layer_height_mm),
        ("filament.flowRatio", prereqs.filament.flow_ratio),
        ("filament.maxVolumetricSpeedMm3PerS", prereqs.filament.max_volumetric_speed_mm3_per_s),
        ("filament.retractionLengthMm", prereqs.filament.retraction_length_mm),
        ("process.layerHeightMm", prereqs.process.layer_height_mm),
        ("process.firstLayerHeightMm", prereqs.process.first_layer_height_mm),
        ("process.lineWidthMm", prereqs.process.line_width_mm),
        ("process.outerWallSpeedMmPerS", prereqs.process.outer_wall_speed_mm_per_s),
        ("process.defaultAccelerationMmPerS2", prereqs.process.default_acceleration_mm_per_s2),
    ];
    for (name, val) in numerics {
        if !val.is_finite() || val <= 0.0 {
            issues.push(CalibrationJobValidationIssue {
                code: "positive-prerequisite".to_string(),
                path: format!("$.prerequisites.{name}"),
                message: "Expected a positive finite number".to_string(),
            });
        }
    }

    let finites = [
        ("nozzle.minTemperatureC", prereqs.nozzle.min_temperature_c),
        ("nozzle.maxTemperatureC", prereqs.nozzle.max_temperature_c),
        ("filament.minTemperatureC", prereqs.filament.min_temperature_c),
        ("filament.maxTemperatureC", prereqs.filament.max_temperature_c),
        ("process.xyHoleCompensationMm", prereqs.process.xy_hole_compensation_mm),
        ("process.xyContourCompensationMm", prereqs.process.xy_contour_compensation_mm),
        ("firmware.maxInputShapingFrequencyHz", prereqs.firmware.max_input_shaping_frequency_hz),
    ];
    for (name, val) in finites {
        if !val.is_finite() {
            issues.push(CalibrationJobValidationIssue {
                code: "finite-prerequisite".to_string(),
                path: format!("$.prerequisites.{name}"),
                message: "Expected a finite number".to_string(),
            });
        }
    }

    if prereqs.nozzle.min_temperature_c >= prereqs.nozzle.max_temperature_c {
        issues.push(CalibrationJobValidationIssue {
            code: "temperature-envelope".to_string(),
            path: "$.prerequisites.nozzle".to_string(),
            message: "Nozzle minimum must be below maximum".to_string(),
        });
    }
    if prereqs.filament.min_temperature_c >= prereqs.filament.max_temperature_c {
        issues.push(CalibrationJobValidationIssue {
            code: "temperature-envelope".to_string(),
            path: "$.prerequisites.filament".to_string(),
            message: "Filament minimum must be below maximum".to_string(),
        });
    }
    if prereqs.process.layer_height_mm > prereqs.nozzle.max_layer_height_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "layer-height".to_string(),
            path: "$.prerequisites.process.layerHeightMm".to_string(),
            message: "Layer height exceeds nozzle maximum".to_string(),
        });
    }
    if prereqs.process.first_layer_height_mm > prereqs.nozzle.max_layer_height_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "first-layer-height".to_string(),
            path: "$.prerequisites.process.firstLayerHeightMm".to_string(),
            message: "First-layer height exceeds nozzle maximum".to_string(),
        });
    }

    let p_def = &definition.prerequisites.printer;
    if prereqs.printer.bed_width_mm < p_def.min_bed_width_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "bed-width".to_string(),
            path: "$.prerequisites.printer.bedWidthMm".to_string(),
            message: format!("Requires at least {} mm", p_def.min_bed_width_mm),
        });
    }
    if prereqs.printer.bed_depth_mm < p_def.min_bed_depth_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "bed-depth".to_string(),
            path: "$.prerequisites.printer.bedDepthMm".to_string(),
            message: format!("Requires at least {} mm", p_def.min_bed_depth_mm),
        });
    }
    if prereqs.printer.build_height_mm < p_def.min_build_height_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "build-height".to_string(),
            path: "$.prerequisites.printer.buildHeightMm".to_string(),
            message: format!("Requires at least {} mm", p_def.min_build_height_mm),
        });
    }
    if prereqs.printer.max_print_speed_mm_per_s < p_def.min_max_print_speed_mm_per_s {
        issues.push(CalibrationJobValidationIssue {
            code: "printer-speed".to_string(),
            path: "$.prerequisites.printer.maxPrintSpeedMmPerS".to_string(),
            message: format!("Requires at least {} mm/s", p_def.min_max_print_speed_mm_per_s),
        });
    }
    if prereqs.printer.max_acceleration_mm_per_s2 < p_def.min_max_acceleration_mm_per_s2 {
        issues.push(CalibrationJobValidationIssue {
            code: "printer-acceleration".to_string(),
            path: "$.prerequisites.printer.maxAccelerationMmPerS2".to_string(),
            message: format!("Requires at least {} mm/s²", p_def.min_max_acceleration_mm_per_s2),
        });
    }

    let n_def = &definition.prerequisites.nozzle;
    if prereqs.nozzle.diameter_mm < n_def.min_diameter_mm || prereqs.nozzle.diameter_mm > n_def.max_diameter_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "nozzle-diameter".to_string(),
            path: "$.prerequisites.nozzle.diameterMm".to_string(),
            message: format!("Expected nozzle diameter in [{}, {}] mm", n_def.min_diameter_mm, n_def.max_diameter_mm),
        });
    }

    if !definition.prerequisites.firmware.allowed_flavors.contains(&prereqs.firmware.flavor) {
        let allowed = definition.prerequisites.firmware.allowed_flavors.iter().map(|f| f.as_str()).collect::<Vec<_>>().join(", ");
        issues.push(CalibrationJobValidationIssue {
            code: "firmware-flavor".to_string(),
            path: "$.prerequisites.firmware.flavor".to_string(),
            message: format!("Calibration supports {allowed}"),
        });
    }

    for cap in &definition.prerequisites.firmware.capabilities {
        let (has, field_name, cap_name) = match cap {
            CalibrationFirmwareCapability::NozzleTemperature => (prereqs.firmware.nozzle_temperature, "nozzleTemperature", "nozzle-temperature"),
            CalibrationFirmwareCapability::PressureAdvance => (prereqs.firmware.pressure_advance, "pressureAdvance", "pressure-advance"),
            CalibrationFirmwareCapability::InputShaping => (prereqs.firmware.input_shaping, "inputShaping", "input-shaping"),
            CalibrationFirmwareCapability::JunctionDeviation => (prereqs.firmware.junction_deviation, "junctionDeviation", "junction-deviation"),
        };
        if !has {
            issues.push(CalibrationJobValidationIssue {
                code: "firmware-capability".to_string(),
                path: format!("$.prerequisites.firmware.{field_name}"),
                message: format!("Firmware does not declare {cap_name}"),
            });
        }
    }
}

fn validate_cross_field_parameters(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prereqs: &CalibrationJobPrerequisites,
    issues: &mut Vec<CalibrationJobValidationIssue>,
) {
    let start = parameters.get("start").and_then(|v| v.as_f64());
    let end = parameters.get("end").and_then(|v| v.as_f64());
    let step = parameters.get("step").and_then(|v| v.as_f64());

    if let (Some(s), Some(e)) = (start, end)
        && definition.id != "temperature-tower" && e <= s {
            issues.push(CalibrationJobValidationIssue {
                code: "sweep-order".to_string(),
                path: "$.parameters.end".to_string(),
                message: "End must be greater than start".to_string(),
            });
        }

    if let (Some(s), Some(e), Some(st)) = (start, end, step) {
        if definition.id == "temperature-tower" {
            if s <= e {
                issues.push(CalibrationJobValidationIssue {
                    code: "sweep-order".to_string(),
                    path: "$.parameters.end".to_string(),
                    message: "Temperature end must be below start".to_string(),
                });
            }
            validate_aligned_span(s - e, st, issues);
        } else {
            if e < s + st {
                issues.push(CalibrationJobValidationIssue {
                    code: "sweep-step".to_string(),
                    path: "$.parameters.end".to_string(),
                    message: "End must include at least one step".to_string(),
                });
            }
            validate_aligned_span(e - s, st, issues);
        }
    }

    if definition.id == "temperature-tower"
        && let (Some(s), Some(e)) = (start, end) {
            let safe_min = prereqs.nozzle.min_temperature_c.max(prereqs.filament.min_temperature_c);
            let safe_max = prereqs.nozzle.max_temperature_c.min(prereqs.filament.max_temperature_c);
            if e < safe_min || s > safe_max {
                issues.push(CalibrationJobValidationIssue {
                    code: "temperature-safety".to_string(),
                    path: "$.parameters".to_string(),
                    message: format!("Temperature sweep must stay within the shared [{safe_min}, {safe_max}] °C envelope"),
                });
            }
        }

    if definition.id.starts_with("pressure-advance-") {
        if let Some(CalibrationParameterValue::NumberList(speeds)) = parameters.get("speeds") {
            for (idx, entry) in speeds.iter().enumerate() {
                if *entry > prereqs.printer.max_print_speed_mm_per_s {
                    issues.push(CalibrationJobValidationIssue {
                        code: "motion-limit".to_string(),
                        path: format!("$.parameters.speeds[{idx}]"),
                        message: format!("Value exceeds {}", prereqs.printer.max_print_speed_mm_per_s),
                    });
                }
            }
        }
        if let Some(CalibrationParameterValue::NumberList(accels)) = parameters.get("accelerations") {
            for (idx, entry) in accels.iter().enumerate() {
                if *entry > prereqs.printer.max_acceleration_mm_per_s2 {
                    issues.push(CalibrationJobValidationIssue {
                        code: "motion-limit".to_string(),
                        path: format!("$.parameters.accelerations[{idx}]"),
                        message: format!("Value exceeds {}", prereqs.printer.max_acceleration_mm_per_s2),
                    });
                }
            }
        }
    }

    if definition.id == "vfa"
        && let Some(e) = end
            && e > prereqs.printer.max_print_speed_mm_per_s {
                issues.push(CalibrationJobValidationIssue {
                    code: "motion-limit".to_string(),
                    path: "$.parameters.end".to_string(),
                    message: "VFA end speed exceeds the printer maximum".to_string(),
                });
            }

    if definition.id == "input-shaping-frequency" {
        for key in &["freqEndX", "freqEndY"] {
            if let Some(val) = parameters.get(*key).and_then(|v| v.as_f64())
                && val > prereqs.firmware.max_input_shaping_frequency_hz {
                    issues.push(CalibrationJobValidationIssue {
                        code: "firmware-frequency".to_string(),
                        path: format!("$.parameters.{key}"),
                        message: "Frequency exceeds the firmware maximum".to_string(),
                    });
                }
        }
        let sx = parameters.get("freqStartX").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ex = parameters.get("freqEndX").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if sx >= ex {
            issues.push(CalibrationJobValidationIssue {
                code: "frequency-order".to_string(),
                path: "$.parameters.freqEndX".to_string(),
                message: "X end frequency must exceed X start".to_string(),
            });
        }
        let sy = parameters.get("freqStartY").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ey = parameters.get("freqEndY").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if sy >= ey {
            issues.push(CalibrationJobValidationIssue {
                code: "frequency-order".to_string(),
                path: "$.parameters.freqEndY".to_string(),
                message: "Y end frequency must exceed Y start".to_string(),
            });
        }
    }

    if definition.id == "input-shaping-damping" {
        for key in &["frequencyX", "frequencyY"] {
            if let Some(val) = parameters.get(*key).and_then(|v| v.as_f64())
                && val > prereqs.firmware.max_input_shaping_frequency_hz {
                    issues.push(CalibrationJobValidationIssue {
                        code: "firmware-frequency".to_string(),
                        path: format!("$.parameters.{key}"),
                        message: "Frequency exceeds the firmware maximum".to_string(),
                    });
                }
        }
    }

    if definition.id == "max-volumetric-speed"
        && let Some(e) = end {
            let max_wall_speed = volumetric_wall_speed(e, prereqs);
            if max_wall_speed > prereqs.printer.max_print_speed_mm_per_s {
                issues.push(CalibrationJobValidationIssue {
                    code: "motion-limit".to_string(),
                    path: "$.parameters.end".to_string(),
                    message: format!("Derived wall speed {} mm/s exceeds the printer maximum", round(max_wall_speed)),
                });
            }
        }

    if definition.id == "tolerance-extension"
        && let Some(CalibrationParameterValue::NumberList(clearances)) = parameters.get("testClearances") {
            let expected = [0.0, 0.05, 0.1, 0.2, 0.3, 0.4];
            let same = clearances.len() == expected.len()
                && clearances.iter().zip(&expected).all(|(a, b)| (a - b).abs() < 1e-9);
            if !same {
                issues.push(CalibrationJobValidationIssue {
                    code: "fixed-clearances".to_string(),
                    path: "$.parameters.testClearances".to_string(),
                    message: "Pinned tolerance clearances cannot change".to_string(),
                });
            }
        }

    let predicted_count = predicted_effect_count(definition, parameters, prereqs);
    if !(1..=MAX_CALIBRATION_EFFECTS).contains(&predicted_count) {
        issues.push(CalibrationJobValidationIssue {
            code: "effect-count".to_string(),
            path: "$.parameters".to_string(),
            message: format!("Parameter range produces {predicted_count} effects; allowed range is 1..{MAX_CALIBRATION_EFFECTS}"),
        });
    }

    if definition.id == "pressure-advance-line" {
        let max_lines = ((prereqs.printer.bed_depth_mm - 10.0) / 3.5).floor() as usize;
        if predicted_count > max_lines {
            issues.push(CalibrationJobValidationIssue {
                code: "bed-fit".to_string(),
                path: "$.parameters".to_string(),
                message: format!("Pressure-advance lines exceed the bed limit of {max_lines}"),
            });
        }
    }
}

fn validate_aligned_span(span: f64, step: f64, issues: &mut Vec<CalibrationJobValidationIssue>) {
    if !step.is_finite() || step <= 0.0 {
        return;
    }
    let count = span / step;
    if (count - count.round()).abs() > 1e-7 * 1.0f64.max(count.abs()) {
        issues.push(CalibrationJobValidationIssue {
            code: "sweep-alignment".to_string(),
            path: "$.parameters.step".to_string(),
            message: "Start/end span must contain a whole number of steps".to_string(),
        });
    }
}

fn predicted_effect_count(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prereqs: &CalibrationJobPrerequisites,
) -> usize {
    match definition.id.as_str() {
        "flow-pass-1" => 9,
        "flow-pass-2" => 10,
        "flow-yolo" => 11,
        "flow-yolo-perfectionist" => 16,
        "tolerance-extension" => {
            if let Some(CalibrationParameterValue::NumberList(c)) = parameters.get("testClearances") {
                c.len()
            } else {
                6
            }
        }
        "junction-deviation" | "input-shaping-frequency" | "input-shaping-damping" => {
            layer_effect_count(prereqs, selected_tower_height(parameters))
        }
        "temperature-tower" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap_or(1.0);
            sweep_count(start - end, step)
        }
        _ => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap_or(1.0);
            sweep_count(end - start, step)
        }
    }
}

fn build_effects(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prerequisites: &CalibrationJobPrerequisites,
) -> Vec<CalibrationPlanEffect> {
    match definition.id.as_str() {
        "temperature-tower" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            descending_sweep(start, end, step)
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    let ord_f = order as f64;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        Some("°C".to_string()),
                        Some([ord_f * 10.0, (ord_f + 1.0) * 10.0]),
                        None,
                        None,
                        vec![CalibrationEngineOverride {
                            scope: "layer".to_string(),
                            key: "nozzle_temperature".to_string(),
                            value: json!(val),
                        }],
                        Some(format!("M104 S{}\n", format_f64(val))),
                    )
                })
                .collect()
        }
        "flow-pass-1" => flow_effects(definition, &[-20.0, -15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0, 20.0], prerequisites, false),
        "flow-pass-2" => flow_effects(definition, &[-9.0, -8.0, -7.0, -6.0, -5.0, -4.0, -3.0, -2.0, -1.0, 0.0], prerequisites, false),
        "flow-yolo" => flow_effects(definition, &[-0.05, -0.04, -0.03, -0.02, -0.01, 0.0, 0.01, 0.02, 0.03, 0.04, 0.05], prerequisites, true),
        "flow-yolo-perfectionist" => flow_effects(
            definition,
            &[-0.04, -0.035, -0.03, -0.025, -0.02, -0.015, -0.01, -0.005, 0.0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035],
            prerequisites,
            true,
        ),
        "pressure-advance-tower" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            ascending_sweep(start, end, step)
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    let ord_f = order as f64;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        None,
                        Some([ord_f, ord_f + 1.0]),
                        None,
                        None,
                        pressure_advance_overrides(val),
                        Some(pressure_advance_gcode(val, &prerequisites.firmware)),
                    )
                })
                .collect()
        }
        "pressure-advance-line" => pressure_advance_lines(definition, parameters, prerequisites, false),
        "pressure-advance-pattern" => pressure_advance_lines(definition, parameters, prerequisites, true),
        "retraction-tower" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            ascending_sweep(start, end, step)
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    let ord_f = order as f64;
                    let min_z = if order == 0 { 0.0 } else { 0.4 + ord_f };
                    let max_z = 0.4 + ord_f + 1.0;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        Some("mm".to_string()),
                        Some([min_z, max_z]),
                        None,
                        None,
                        vec![CalibrationEngineOverride {
                            scope: "layer".to_string(),
                            key: "retraction_length".to_string(),
                            value: json!(val),
                        }],
                        Some(format!("; Calib_Retraction_tower: Z_HEIGHT: {}, length:{}\n", format_f64(min_z), format_f64(val))),
                    )
                })
                .collect()
        }
        "max-volumetric-speed" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            ascending_sweep(start, end, step)
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    let speed = round(volumetric_wall_speed(val, prerequisites));
                    let ord_f = order as f64;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        Some("mm³/s".to_string()),
                        Some([ord_f, ord_f + 1.0]),
                        None,
                        None,
                        vec![CalibrationEngineOverride {
                            scope: "layer".to_string(),
                            key: "outer_wall_speed".to_string(),
                            value: json!(speed),
                        }],
                        None,
                    )
                })
                .collect()
        }
        "vfa" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            ascending_sweep(start, end, step)
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    let ord_f = order as f64;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        Some("mm/s".to_string()),
                        Some([ord_f * 5.0, (ord_f + 1.0) * 5.0]),
                        None,
                        None,
                        vec![CalibrationEngineOverride {
                            scope: "layer".to_string(),
                            key: "outer_wall_speed".to_string(),
                            value: json!(val.round() as i64),
                        }],
                        None,
                    )
                })
                .collect()
        }
        "junction-deviation" => {
            let layer_count = layer_effect_count(prerequisites, selected_tower_height(parameters));
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            (0..layer_count)
                .map(|order| {
                    let ord_f = order as f64;
                    let val = round(start + ((end - start) * (ord_f + 1.0)) / (layer_count as f64));
                    let z_low = ord_f * prerequisites.process.layer_height_mm;
                    let z_high = (ord_f + 1.0) * prerequisites.process.layer_height_mm;
                    make_effect(
                        definition,
                        order as u32,
                        "start",
                        json!(val),
                        Some("mm".to_string()),
                        Some([z_low, z_high]),
                        None,
                        None,
                        vec![CalibrationEngineOverride {
                            scope: "layer".to_string(),
                            key: "default_junction_deviation".to_string(),
                            value: json!(val),
                        }],
                        Some(format!("M205 J{}\n", to_fixed(val, 3))),
                    )
                })
                .collect()
        }
        "input-shaping-frequency" => input_shaping_frequency_effects(definition, parameters, prerequisites),
        "input-shaping-damping" => input_shaping_damping_effects(definition, parameters, prerequisites),
        "tolerance-extension" => {
            let clearances = match parameters.get("testClearances") {
                Some(CalibrationParameterValue::NumberList(c)) => c.clone(),
                _ => vec![0.0, 0.05, 0.1, 0.2, 0.3, 0.4],
            };
            clearances
                .into_iter()
                .enumerate()
                .map(|(order, val)| {
                    make_effect(
                        definition,
                        order as u32,
                        "testClearances",
                        json!(val),
                        Some("mm".to_string()),
                        None,
                        Some([
                            round(translation_column(order, 6, prerequisites.printer.bed_width_mm)),
                            prerequisites.printer.bed_depth_mm / 2.0,
                            0.0,
                        ]),
                        None,
                        vec![],
                        None,
                    )
                })
                .collect()
        }
        _ => vec![],
    }
}

fn flow_effects(
    definition: &CalibrationJobDefinition,
    modifiers: &[f64],
    prerequisites: &CalibrationJobPrerequisites,
    linear: bool,
) -> Vec<CalibrationPlanEffect> {
    modifiers
        .iter()
        .enumerate()
        .map(|(order, modifier)| {
            let val = if linear {
                round((prerequisites.filament.flow_ratio + modifier) / prerequisites.filament.flow_ratio)
            } else {
                round(1.0 + modifier / 100.0)
            };
            make_effect(
                definition,
                order as u32,
                "modifier",
                json!(val),
                None,
                None,
                None,
                None,
                vec![CalibrationEngineOverride {
                    scope: "object".to_string(),
                    key: "print_flow_ratio".to_string(),
                    value: json!(val),
                }],
                None,
            )
        })
        .collect()
}

fn pressure_advance_lines(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prerequisites: &CalibrationJobPrerequisites,
    pattern: bool,
) -> Vec<CalibrationPlanEffect> {
    let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
    let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
    let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
    let values = ascending_sweep(start, end, step);
    let val_count = values.len();
    let columns = if pattern { 1.max(((val_count as f64).sqrt().ceil()) as usize) } else { 1 };
    let rows_total = ((val_count as f64) / (columns as f64)).ceil() as usize;

    values
        .into_iter()
        .enumerate()
        .map(|(order, val)| {
            let row = if pattern { order / columns } else { order };
            let col = if pattern { order % columns } else { 0 };
            let y = if pattern {
                translation_column(row, rows_total, prerequisites.printer.bed_depth_mm)
            } else {
                5.0 + (order as f64) * 3.5
            };
            let start_x = if pattern {
                translation_column(col, columns, prerequisites.printer.bed_width_mm) - 8.0
            } else {
                10.0
            };
            let end_x = if pattern {
                start_x + 16.0
            } else {
                prerequisites.printer.bed_width_mm - 10.0
            };
            make_effect(
                definition,
                order as u32,
                "start",
                json!(val),
                None,
                None,
                None,
                Some(CalibrationLineMm {
                    start: [round(start_x), round(y), 0.2],
                    end: [round(end_x), round(y), 0.2],
                }),
                pressure_advance_overrides(val),
                Some(pressure_advance_gcode(val, &prerequisites.firmware)),
            )
        })
        .collect()
}

fn input_shaping_frequency_effects(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prerequisites: &CalibrationJobPrerequisites,
) -> Vec<CalibrationPlanEffect> {
    let count = layer_effect_count(prerequisites, selected_tower_height(parameters));
    let mut effects = Vec::with_capacity(count);
    let damping = parameters.get("damping").and_then(|v| v.as_f64()).unwrap();
    effects.push(make_effect(
        definition,
        0,
        "damping",
        json!(damping),
        None,
        Some([0.0, prerequisites.process.layer_height_mm]),
        None,
        None,
        vec![],
        Some(input_shaping_gcode("A", damping, 0.0, &prerequisites.firmware)),
    ));

    let freq_start_x = parameters.get("freqStartX").and_then(|v| v.as_f64()).unwrap();
    let freq_end_x = parameters.get("freqEndX").and_then(|v| v.as_f64()).unwrap();
    let freq_start_y = parameters.get("freqStartY").and_then(|v| v.as_f64()).unwrap();
    let freq_end_y = parameters.get("freqEndY").and_then(|v| v.as_f64()).unwrap();

    for order in 1..count {
        let ord_f = order as f64;
        let ratio = if count <= 2 { 0.0 } else { (ord_f - 1.0) / ((count - 2) as f64) };
        let x = round(freq_start_x + (freq_end_x - freq_start_x) * ratio);
        let y = round(freq_start_y + (freq_end_y - freq_start_y) * ratio);
        let same = (x - y).abs() < 1e-9;
        let gcode = if same {
            input_shaping_gcode("A", 0.0, x, &prerequisites.firmware)
        } else {
            format!(
                "{}{}",
                input_shaping_gcode("X", 0.0, x, &prerequisites.firmware),
                input_shaping_gcode("Y", 0.0, y, &prerequisites.firmware)
            )
        };
        let value = if same {
            json!(x)
        } else {
            json!(format!("{}/{}", format_f64(x), format_f64(y)))
        };
        effects.push(make_effect(
            definition,
            order as u32,
            "freqStartX",
            value,
            Some("Hz".to_string()),
            Some([ord_f * prerequisites.process.layer_height_mm, (ord_f + 1.0) * prerequisites.process.layer_height_mm]),
            None,
            None,
            vec![],
            Some(gcode),
        ));
    }
    effects
}

fn input_shaping_damping_effects(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prerequisites: &CalibrationJobPrerequisites,
) -> Vec<CalibrationPlanEffect> {
    let count = layer_effect_count(prerequisites, selected_tower_height(parameters));
    let mut effects = Vec::with_capacity(count);
    let x = parameters.get("frequencyX").and_then(|v| v.as_f64()).unwrap();
    let y = parameters.get("frequencyY").and_then(|v| v.as_f64()).unwrap();
    effects.push(make_effect(
        definition,
        0,
        "frequencyX",
        json!(format!("{}/{}", format_f64(x), format_f64(y))),
        Some("Hz".to_string()),
        Some([0.0, prerequisites.process.layer_height_mm]),
        None,
        None,
        vec![],
        Some(format!(
            "{}{}",
            input_shaping_gcode("X", 0.0, x, &prerequisites.firmware),
            input_shaping_gcode("Y", 0.0, y, &prerequisites.firmware)
        )),
    ));

    let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
    let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();

    for order in 1..count {
        let ord_f = order as f64;
        let damping = round(start + ((end - start) * (ord_f + 1.0)) / (count as f64));
        effects.push(make_effect(
            definition,
            order as u32,
            "start",
            json!(damping),
            None,
            Some([ord_f * prerequisites.process.layer_height_mm, (ord_f + 1.0) * prerequisites.process.layer_height_mm]),
            None,
            None,
            vec![],
            Some(input_shaping_gcode("A", damping, 0.0, &prerequisites.firmware)),
        ));
    }
    effects
}

#[allow(clippy::too_many_arguments)]
fn make_effect(
    definition: &CalibrationJobDefinition,
    order: u32,
    parameter_key: &str,
    value: Value,
    unit: Option<String>,
    z_range_mm: Option<[f64; 2]>,
    position_mm: Option<[f64; 3]>,
    line_mm: Option<CalibrationLineMm>,
    engine_overrides: Vec<CalibrationEngineOverride>,
    custom_gcode: Option<String>,
) -> CalibrationPlanEffect {
    let label = match &unit {
        Some(u) => format!("{} {}", format_value(&value), u),
        None => format_value(&value),
    };
    CalibrationPlanEffect {
        kind: definition.effect_kind,
        order,
        label,
        parameter_key: parameter_key.to_string(),
        value,
        unit,
        z_range_mm: z_range_mm.map(|z| [round(z[0]), round(z[1])]),
        position_mm: position_mm.map(|p| [round(p[0]), round(p[1]), round(p[2])]),
        line_mm: line_mm.map(|l| CalibrationLineMm {
            start: [round(l.start[0]), round(l.start[1]), round(l.start[2])],
            end: [round(l.end[0]), round(l.end[1]), round(l.end[2])],
        }),
        engine_overrides,
        custom_gcode,
    }
}

fn pressure_advance_overrides(value: f64) -> Vec<CalibrationEngineOverride> {
    vec![
        CalibrationEngineOverride {
            scope: "layer".to_string(),
            key: "enable_pressure_advance".to_string(),
            value: json!(true),
        },
        CalibrationEngineOverride {
            scope: "layer".to_string(),
            key: "pressure_advance".to_string(),
            value: json!(value),
        },
    ]
}

fn pressure_advance_gcode(value: f64, firmware: &CalibrationFirmwarePrerequisites) -> String {
    match firmware.flavor {
        CalibrationFirmwareFlavor::Klipper => format!("SET_PRESSURE_ADVANCE ADVANCE={}\n", format_f64(value)),
        CalibrationFirmwareFlavor::Reprap => format!("M572 D0 S{}\n", format_f64(value)),
        CalibrationFirmwareFlavor::Marlin => format!("M900 K{}\n", format_f64(value)),
    }
}

fn input_shaping_gcode(
    axis: &str,
    damping: f64,
    frequency: f64,
    firmware: &CalibrationFirmwarePrerequisites,
) -> String {
    if firmware.flavor == CalibrationFirmwareFlavor::Klipper {
        let mut parts = vec!["SET_INPUT_SHAPER".to_string()];
        let axes: &[&str] = if axis == "A" { &["X", "Y"] } else { &[axis] };
        for cur in axes {
            if frequency > 0.0 {
                parts.push(format!("SHAPER_FREQ_{cur}={}", to_fixed(frequency, 2)));
            }
            if damping > 0.0 {
                parts.push(format!("DAMPING_RATIO_{cur}={}", to_fixed(damping, 3)));
            }
        }
        format!("{}\n", parts.join(" "))
    } else {
        let mut parts = vec!["M593".to_string()];
        if axis != "A" {
            parts.push(axis.to_string());
        }
        if frequency > 0.0 {
            parts.push(format!("F{}", to_fixed(frequency, 2)));
        }
        if damping > 0.0 {
            parts.push(format!("D{}", to_fixed(damping, 3)));
        }
        format!("{}\n", parts.join(" "))
    }
}

fn required_envelope(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
    prerequisites: &CalibrationJobPrerequisites,
    effect_count: usize,
) -> [f64; 3] {
    let source = definition.geometry.source_envelope_mm;
    match definition.id.as_str() {
        "temperature-tower" => [source[0], source[1], (effect_count as f64) * 10.0],
        "pressure-advance-tower" => [source[0], source[1], effect_count as f64],
        "pressure-advance-line" => [
            source[0].min(prerequisites.printer.bed_width_mm - 20.0),
            (effect_count as f64) * 3.5 + 10.0,
            source[2],
        ],
        "pressure-advance-pattern" => {
            let cols = ((effect_count as f64).sqrt().ceil()) as usize;
            let rows = ((effect_count as f64) / (cols as f64)).ceil() as usize;
            [(cols as f64) * 20.0 + 20.0, (rows as f64) * 20.0 + 20.0, source[2]]
        }
        "retraction-tower" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            [source[0], source[1], 1.4 + (end - start) / step]
        }
        "max-volumetric-speed" => {
            let start = parameters.get("start").and_then(|v| v.as_f64()).unwrap();
            let end = parameters.get("end").and_then(|v| v.as_f64()).unwrap();
            let step = parameters.get("step").and_then(|v| v.as_f64()).unwrap();
            [source[0], source[1], (end - start + 1.0) / step]
        }
        "vfa" => [source[0], source[1], (effect_count as f64) * 5.0],
        "junction-deviation" | "input-shaping-frequency" | "input-shaping-damping" => {
            selected_tower_envelope(parameters)
        }
        _ => source,
    }
}

fn validate_required_envelope(
    envelope: [f64; 3],
    definition: &CalibrationJobDefinition,
    prerequisites: &CalibrationJobPrerequisites,
    issues: &mut Vec<CalibrationJobValidationIssue>,
) {
    if envelope.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        issues.push(CalibrationJobValidationIssue {
            code: "geometry-envelope".to_string(),
            path: "$.parameters".to_string(),
            message: "Generated geometry envelope is invalid".to_string(),
        });
    }
    if envelope[0] > prerequisites.printer.bed_width_mm || envelope[1] > prerequisites.printer.bed_depth_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "bed-fit".to_string(),
            path: "$.prerequisites.printer".to_string(),
            message: "Generated calibration does not fit the bed".to_string(),
        });
    }
    if envelope[2] > prerequisites.printer.build_height_mm {
        issues.push(CalibrationJobValidationIssue {
            code: "build-height".to_string(),
            path: "$.prerequisites.printer.buildHeightMm".to_string(),
            message: "Generated calibration exceeds build height".to_string(),
        });
    }
    if definition.geometry.z_trimmable && envelope[2] > definition.geometry.source_envelope_mm[2] + 1e-6 {
        issues.push(CalibrationJobValidationIssue {
            code: "source-height".to_string(),
            path: "$.parameters".to_string(),
            message: "Requested sweep exceeds the pinned source model height".to_string(),
        });
    }
}

fn build_slice_assertions(
    definition: &CalibrationJobDefinition,
    effects: &[CalibrationPlanEffect],
    labels: &[String],
    required_envelope_mm: [f64; 3],
) -> Vec<CalibrationSliceAssertion> {
    let mut override_keys_set = HashSet::new();
    for effect in effects {
        for o in &effect.engine_overrides {
            override_keys_set.insert(o.key.clone());
        }
    }
    let mut override_keys: Vec<String> = override_keys_set.into_iter().collect();
    override_keys.sort();

    let mut gcode_prefixes_set = HashSet::new();
    for effect in effects {
        if let Some(code) = &effect.custom_gcode {
            let trimmed = code.trim();
            if !trimmed.is_empty() && !trimmed.starts_with(';')
                && let Some(prefix) = trimmed.split_whitespace().next() {
                    gcode_prefixes_set.insert(prefix.to_string());
                }
        }
    }
    let mut gcode_prefixes: Vec<String> = gcode_prefixes_set.into_iter().collect();
    gcode_prefixes.sort();

    let actionable_count = effects.iter().filter(|e| {
        !e.engine_overrides.is_empty() || e.custom_gcode.is_some() || e.position_mm.is_some() || e.line_mm.is_some()
    }).count();

    let mut assertions = vec![
        CalibrationSliceAssertion {
            id: "effect-count".to_string(),
            kind: "effect-count".to_string(),
            path: "$.effects.length".to_string(),
            operator: "equals".to_string(),
            expected: json!(effects.len()),
        },
        CalibrationSliceAssertion {
            id: "label-count".to_string(),
            kind: "label-count".to_string(),
            path: "$.expectedLabels.length".to_string(),
            operator: "equals".to_string(),
            expected: json!(labels.len()),
        },
        CalibrationSliceAssertion {
            id: "actionable-effects".to_string(),
            kind: "actionable-effects".to_string(),
            path: "$.effects".to_string(),
            operator: "equals".to_string(),
            expected: json!(actionable_count),
        },
        CalibrationSliceAssertion {
            id: "z-range".to_string(),
            kind: "z-range".to_string(),
            path: "$.geometry.requiredEnvelopeMm[2]".to_string(),
            operator: "less-than-or-equal".to_string(),
            expected: json!(required_envelope_mm[2]),
        },
    ];

    for (idx, res) in definition.geometry.resources.iter().enumerate() {
        assertions.push(CalibrationSliceAssertion {
            id: format!("resource-{idx}"),
            kind: "resource-blob".to_string(),
            path: format!("$.geometry.resources[{idx}].blob"),
            operator: "equals".to_string(),
            expected: json!(res.blob),
        });
    }

    for (idx, key) in override_keys.iter().enumerate() {
        assertions.push(CalibrationSliceAssertion {
            id: format!("override-{idx}"),
            kind: "override-key".to_string(),
            path: "$.effects[].engineOverrides[].key".to_string(),
            operator: "contains".to_string(),
            expected: json!(key),
        });
    }

    for (idx, prefix) in gcode_prefixes.iter().enumerate() {
        assertions.push(CalibrationSliceAssertion {
            id: format!("gcode-{idx}"),
            kind: "gcode-prefix".to_string(),
            path: "$.effects[].customGcode".to_string(),
            operator: "contains".to_string(),
            expected: json!(prefix),
        });
    }

    assertions
}

fn plan_warnings(
    definition: &CalibrationJobDefinition,
    parameters: &BTreeMap<String, CalibrationParameterValue>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if matches!(
        definition.id.as_str(),
        "flow-pass-1"
            | "flow-pass-2"
            | "flow-yolo"
            | "flow-yolo-perfectionist"
            | "pressure-advance-tower"
            | "pressure-advance-line"
            | "pressure-advance-pattern"
    ) {
        warnings.push("Vendor automatic measurement is not inherited; this plan is manual-only.".to_string());
    }
    if definition.id == "junction-deviation"
        && let Some(end) = parameters.get("end").and_then(|v| v.as_f64())
            && end > 0.3 {
                warnings.push("The pinned dialog warns that junction deviation above 0.3 mm may cause layer shifts.".to_string());
            }
    if definition.id == "max-volumetric-speed" {
        warnings.push("Wall-speed overrides use the pinned line-width/layer-height flow conversion and require slice-oracle verification.".to_string());
    }
    warnings
}
