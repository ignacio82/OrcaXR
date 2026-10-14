use super::history::{assess_calibration_applicability, CalibrationConditions, CalibrationHistoryIssue, CalibrationRecord};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResultBinding {
    pub result_key: String,
    pub preset_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationCompanionOverride {
    pub preset_key: String,
    pub value: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationApplicationRule {
    pub scope: String,
    pub bindings: Vec<CalibrationResultBinding>,
    pub companions: Vec<CalibrationCompanionOverride>,
    pub hand_off: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationOverrideChange {
    pub preset_key: String,
    pub value: String,
    pub because: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationApplicationPlan {
    pub workflow_id: String,
    pub scope: String,
    pub overrides: Vec<CalibrationOverrideChange>,
    pub manual_transfer: Vec<String>,
    pub issues: Vec<CalibrationHistoryIssue>,
    pub applicable: bool,
}

fn binding(result_key: &str, preset_key: &str, note: Option<&str>) -> CalibrationResultBinding {
    CalibrationResultBinding {
        result_key: result_key.to_string(),
        preset_key: preset_key.to_string(),
        note: note.map(|n| n.to_string()),
    }
}

pub fn get_calibration_application_rule(id: &str) -> Option<CalibrationApplicationRule> {
    match id {
        "temperature-tower" => Some(CalibrationApplicationRule {
            scope: "filament".to_string(),
            bindings: vec![
                binding("bestNozzleTemperatureC", "nozzle_temperature", None),
                binding(
                    "bestNozzleTemperatureC",
                    "nozzle_temperature_initial_layer",
                    Some("The first layer takes the same temperature; raise it separately if adhesion needs it."),
                ),
            ],
            companions: vec![],
            hand_off: false,
        }),
        "flow-pass-1" | "flow-pass-2" | "flow-yolo" | "flow-yolo-perfectionist" => Some(CalibrationApplicationRule {
            scope: "filament".to_string(),
            bindings: vec![binding("flowRatio", "filament_flow_ratio", None)],
            companions: vec![],
            hand_off: false,
        }),
        "pressure-advance-tower" | "pressure-advance-line" | "pressure-advance-pattern" => Some(CalibrationApplicationRule {
            scope: "filament".to_string(),
            bindings: vec![binding("pressureAdvanceK", "pressure_advance", None)],
            companions: vec![CalibrationCompanionOverride {
                preset_key: "enable_pressure_advance".to_string(),
                value: "1".to_string(),
                why: "A pressure-advance value is ignored unless pressure advance is enabled for this filament.".to_string(),
            }],
            hand_off: false,
        }),
        "retraction-tower" => Some(CalibrationApplicationRule {
            scope: "printer".to_string(),
            bindings: vec![binding("retractionLengthMm", "retraction_length", None)],
            companions: vec![],
            hand_off: false,
        }),
        "max-volumetric-speed" => Some(CalibrationApplicationRule {
            scope: "filament".to_string(),
            bindings: vec![binding("maxVolumetricSpeedMm3PerS", "filament_max_volumetric_speed", None)],
            companions: vec![],
            hand_off: false,
        }),
        "junction-deviation" => Some(CalibrationApplicationRule {
            scope: "process".to_string(),
            bindings: vec![binding("junctionDeviationMm", "default_junction_deviation", None)],
            companions: vec![],
            hand_off: false,
        }),
        "input-shaping-frequency" => Some(CalibrationApplicationRule {
            scope: "firmware".to_string(),
            bindings: vec![
                binding("frequencyXHz", "input_shaper.frequency_x", None),
                binding("frequencyYHz", "input_shaper.frequency_y", None),
            ],
            companions: vec![],
            hand_off: true,
        }),
        "input-shaping-damping" => Some(CalibrationApplicationRule {
            scope: "firmware".to_string(),
            bindings: vec![binding("dampingRatio", "input_shaper.damping_ratio", None)],
            companions: vec![],
            hand_off: true,
        }),
        "vfa" => Some(CalibrationApplicationRule {
            scope: "process".to_string(),
            bindings: vec![
                binding("artifactFreeSpeedMaxMmPerS", "outer_wall_speed", None),
                binding(
                    "artifactFreeSpeedMaxMmPerS",
                    "inner_wall_speed",
                    Some("Inner walls take the same ceiling; they may safely run faster if the surface allows."),
                ),
            ],
            companions: vec![],
            hand_off: false,
        }),
        "tolerance-extension" => Some(CalibrationApplicationRule {
            scope: "process".to_string(),
            bindings: vec![
                binding("xyHoleCompensationMm", "xy_hole_compensation", None),
                binding("xyContourCompensationMm", "xy_contour_compensation", None),
            ],
            companions: vec![],
            hand_off: false,
        }),
        _ => None,
    }
}

pub fn plan_calibration_application(
    record: &CalibrationRecord,
    current: &CalibrationConditions,
) -> CalibrationApplicationPlan {
    let rule = match get_calibration_application_rule(&record.method.definition_id) {
        Some(r) => r,
        None => {
            return CalibrationApplicationPlan {
                workflow_id: record.method.definition_id.clone(),
                scope: "filament".to_string(),
                overrides: vec![],
                manual_transfer: vec![],
                issues: vec![CalibrationHistoryIssue {
                    code: "method-changed".to_string(),
                    severity: "error".to_string(),
                    path: "$.method".to_string(),
                    message: format!("No preset mapping is defined for {}.", record.method.label),
                }],
                applicable: false,
            };
        }
    };

    let applicability = assess_calibration_applicability(record, current);
    let mut issues = applicability.issues;

    let measured: BTreeMap<&str, &super::history::CalibrationMeasurement> =
        record.measurements.iter().map(|m| (m.key.as_str(), m)).collect();

    let mut overrides = Vec::new();
    let mut transfers = Vec::new();

    for binding in &rule.bindings {
        let measurement = match measured.get(binding.result_key.as_str()) {
            Some(m) => m,
            None => continue,
        };
        let value = match &measurement.value {
            serde_json::Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    crate::js_math::convert::number_to_string(f)
                } else {
                    n.to_string()
                }
            }
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };

        if rule.hand_off {
            let unit_suffix = measurement.unit.as_deref().map(|u| format!(" {u}")).unwrap_or_default();
            transfers.push(format!("{}: {value}{unit_suffix}", binding.preset_key));
            continue;
        }

        let because = match &binding.note {
            Some(note) => format!("Measured {} = {value}. {note}", binding.result_key),
            None => format!("Measured {} = {value}.", binding.result_key),
        };

        overrides.push(CalibrationOverrideChange {
            preset_key: binding.preset_key.clone(),
            value,
            because,
        });
    }

    if rule.hand_off {
        if transfers.is_empty() {
            issues.push(CalibrationHistoryIssue {
                code: "missing-measurement".to_string(),
                severity: "error".to_string(),
                path: "$.measurements".to_string(),
                message: format!("{} recorded no usable result.", record.method.label),
            });
        } else {
            issues.push(CalibrationHistoryIssue {
                code: "condition-mismatch".to_string(),
                severity: "warning".to_string(),
                path: "$.presetTargets".to_string(),
                message: format!(
                    "{} tunes the printer's own configuration, which no slicer preset holds. Copy the values below into the printer and restart its firmware.",
                    record.method.label
                ),
            });
        }
        return CalibrationApplicationPlan {
            workflow_id: record.method.definition_id.clone(),
            scope: rule.scope,
            overrides: vec![],
            manual_transfer: transfers,
            issues,
            applicable: false,
        };
    }

    if overrides.is_empty() {
        issues.push(CalibrationHistoryIssue {
            code: "missing-measurement".to_string(),
            severity: "error".to_string(),
            path: "$.measurements".to_string(),
            message: format!("{} recorded no result that maps to a preset.", record.method.label),
        });
        return CalibrationApplicationPlan {
            workflow_id: record.method.definition_id.clone(),
            scope: rule.scope,
            overrides: vec![],
            manual_transfer: vec![],
            issues,
            applicable: false,
        };
    }

    for companion in &rule.companions {
        overrides.push(CalibrationOverrideChange {
            preset_key: companion.preset_key.clone(),
            value: companion.value.clone(),
            because: companion.why.clone(),
        });
    }

    let applicable = !overrides.is_empty() && !issues.iter().any(|i| i.severity == "error");

    CalibrationApplicationPlan {
        workflow_id: record.method.definition_id.clone(),
        scope: rule.scope,
        overrides,
        manual_transfer: vec![],
        issues,
        applicable,
    }
}

pub fn describe_calibration_application(plan: &CalibrationApplicationPlan) -> String {
    if !plan.manual_transfer.is_empty() {
        let count = plan.manual_transfer.len();
        return format!("Copy {count} value{} into the printer's own configuration.", if count == 1 { "" } else { "s" });
    }
    if plan.overrides.is_empty() {
        return "Nothing to apply.".to_string();
    }
    let parts: Vec<String> = plan.overrides.iter().map(|c| format!("{} = {}", c.preset_key, c.value)).collect();
    format!("Set {} on the {} preset.", parts.join(", "), plan.scope)
}
