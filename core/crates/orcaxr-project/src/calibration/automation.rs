use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const RESONANCE_ACCELEROMETERS: &[&str] = &["adxl345", "lis2dw", "mpu9250", "icm20948"];

pub const MANUAL_WHY: &str = "The result of this test is read from the printed part, and no printer reports what a human sees. Print it, measure it, and enter the result.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationAutomationRule {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub required_objects: Vec<String>,
    pub any_of_objects: Vec<Vec<String>>,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationAutomationAssessment {
    pub workflow_id: String,
    pub kind: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub missing: Vec<String>,
    pub reason: String,
    pub manual_fallback: bool,
}

pub fn get_calibration_automation_rule(id: &str) -> CalibrationAutomationRule {
    if id == "input-shaping-frequency" || id == "input-shaping-damping" {
        CalibrationAutomationRule {
            kind: "automatic".to_string(),
            command: Some("SHAPER_CALIBRATE".to_string()),
            required_objects: vec!["resonance_tester".to_string()],
            any_of_objects: vec![RESONANCE_ACCELEROMETERS.iter().map(|s| s.to_string()).collect()],
            why: "Klipper sweeps the axis and reads an accelerometer, so the frequency and damping are measured by the machine rather than by eye, and saved with SAVE_CONFIG.".to_string(),
        }
    } else {
        CalibrationAutomationRule {
            kind: "manual".to_string(),
            command: None,
            required_objects: vec![],
            any_of_objects: vec![],
            why: MANUAL_WHY.to_string(),
        }
    }
}

pub fn assess_calibration_automation(
    workflow_id: &str,
    objects: Option<&[String]>,
) -> CalibrationAutomationAssessment {
    let rule = get_calibration_automation_rule(workflow_id);
    if rule.kind == "manual" {
        return CalibrationAutomationAssessment {
            workflow_id: workflow_id.to_string(),
            kind: "manual".to_string(),
            available: false,
            command: None,
            missing: vec![],
            reason: rule.why,
            manual_fallback: true,
        };
    }

    if objects.is_none() {
        return CalibrationAutomationAssessment {
            workflow_id: workflow_id.to_string(),
            kind: "automatic".to_string(),
            available: false,
            command: rule.command,
            missing: vec![],
            reason: "Connect the printer to find out whether it can measure this itself.".to_string(),
            manual_fallback: true,
        };
    }

    let objs = objects.unwrap();
    let mut present = HashSet::new();
    for name in objs {
        if let Some(first) = name.split_whitespace().next() {
            present.insert(first.to_lowercase());
        }
    }

    let mut missing = Vec::new();
    for req in &rule.required_objects {
        if !present.contains(&req.to_lowercase()) {
            missing.push(req.clone());
        }
    }

    for group in &rule.any_of_objects {
        if !group.iter().any(|name| present.contains(&name.to_lowercase())) {
            missing.push(group.join(" or "));
        }
    }

    if missing.is_empty() {
        CalibrationAutomationAssessment {
            workflow_id: workflow_id.to_string(),
            kind: "automatic".to_string(),
            available: true,
            command: rule.command,
            missing: vec![],
            reason: rule.why,
            manual_fallback: true,
        }
    } else {
        CalibrationAutomationAssessment {
            workflow_id: workflow_id.to_string(),
            kind: "automatic".to_string(),
            available: false,
            command: rule.command,
            missing: missing.clone(),
            reason: format!(
                "This printer reports no {}, so it cannot measure this itself. The printed test still applies.",
                missing.join(", ")
            ),
            manual_fallback: true,
        }
    }
}

pub fn parse_printer_objects(payload: &serde_json::Value) -> Option<Vec<String>> {
    let obj = payload.as_object()?;
    let result = obj.get("result").unwrap_or(payload);
    let objects_val = result.as_object()?.get("objects")?.as_array()?;
    let mut names = Vec::new();
    for item in objects_val {
        if let Some(s) = item.as_str() {
            names.push(s.to_string());
        }
    }
    Some(names)
}
