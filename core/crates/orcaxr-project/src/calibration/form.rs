use super::compiler::{compile_calibration_job, create_default_calibration_job_request};
use super::definitions::get_calibration_job_definition;
use super::types::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFormField {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: Option<String>,
    pub editable: bool,
    pub choices: Vec<String>,
    pub range: Option<CalibrationNumericRange>,
    pub max_items: Option<u32>,
    pub text: String,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFormPreview {
    pub fields: Vec<CalibrationFormField>,
    pub plan: Option<CalibrationJobPlan>,
    pub issues: Vec<CalibrationJobValidationIssue>,
}

fn format_param_value(val: &CalibrationParameterValue) -> String {
    match val {
        CalibrationParameterValue::Number(n) => crate::js_math::convert::number_to_string(*n),
        CalibrationParameterValue::String(s) => s.clone(),
        CalibrationParameterValue::Boolean(b) => if *b { "true".to_string() } else { "false".to_string() },
        CalibrationParameterValue::NumberList(list) => {
            list.iter().map(|n| crate::js_math::convert::number_to_string(*n)).collect::<Vec<_>>().join(", ")
        }
    }
}

fn parse_field(
    param: &CalibrationParameterDefinition,
    text: &str,
) -> Result<CalibrationParameterValue, CalibrationJobValidationIssue> {
    let path = format!("$.parameters.{}", param.key);
    let trimmed = text.trim();
    match param.kind.as_str() {
        "boolean" => {
            if trimmed == "true" {
                Ok(CalibrationParameterValue::Boolean(true))
            } else if trimmed == "false" {
                Ok(CalibrationParameterValue::Boolean(false))
            } else {
                Err(CalibrationJobValidationIssue {
                    code: "unreadable-parameter".to_string(),
                    path,
                    message: format!("{} must be true or false", param.label),
                })
            }
        }
        "choice" => {
            if trimmed.is_empty() {
                Err(CalibrationJobValidationIssue {
                    code: "unreadable-parameter".to_string(),
                    path,
                    message: format!("{} needs a choice", param.label),
                })
            } else {
                Ok(CalibrationParameterValue::String(trimmed.to_string()))
            }
        }
        "number" => {
            if trimmed.is_empty() {
                Err(CalibrationJobValidationIssue {
                    code: "unreadable-parameter".to_string(),
                    path,
                    message: format!("{} needs a number", param.label),
                })
            } else {
                let n = crate::js_math::convert::parse_float(trimmed);
                if !n.is_finite() {
                    Err(CalibrationJobValidationIssue {
                        code: "unreadable-parameter".to_string(),
                        path,
                        message: format!("{} is not a number", param.label),
                    })
                } else {
                    Ok(CalibrationParameterValue::Number(n))
                }
            }
        }
        "number-list" => {
            let parts: Vec<&str> = trimmed
                .split(',')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .collect();
            if parts.is_empty() {
                return Ok(CalibrationParameterValue::NumberList(vec![]));
            }
            let mut numbers = Vec::with_capacity(parts.len());
            for part in parts {
                let n = crate::js_math::convert::parse_float(part);
                if !n.is_finite() {
                    return Err(CalibrationJobValidationIssue {
                        code: "unreadable-parameter".to_string(),
                        path,
                        message: format!("{} contains “{part}”, which is not a number", param.label),
                    });
                }
                numbers.push(n);
            }
            Ok(CalibrationParameterValue::NumberList(numbers))
        }
        _ => Ok(CalibrationParameterValue::String(trimmed.to_string())),
    }
}

pub fn build_calibration_form(
    definition_id: &str,
    prerequisites: &CalibrationJobPrerequisites,
    edits: &BTreeMap<String, String>,
    job_id: &str,
) -> CalibrationFormPreview {
    let definition = match get_calibration_job_definition(definition_id) {
        Some(def) => def,
        None => {
            return CalibrationFormPreview {
                fields: vec![],
                plan: None,
                issues: vec![CalibrationJobValidationIssue {
                    code: "unknown-definition".to_string(),
                    path: "$.definitionId".to_string(),
                    message: format!("Unknown calibration {definition_id}"),
                }],
            };
        }
    };

    let mut issues = Vec::new();
    let mut parameters = BTreeMap::new();
    let mut fields = Vec::with_capacity(definition.parameters.len());

    for param in &definition.parameters {
        let default_text = format_param_value(&param.default);
        let text = if param.editable {
            edits.get(&param.key).cloned().unwrap_or(default_text.clone())
        } else {
            default_text.clone()
        };
        let changed = text != default_text;

        match parse_field(param, &text) {
            Ok(val) => {
                parameters.insert(param.key.clone(), val);
            }
            Err(issue) => {
                issues.push(issue);
            }
        }

        fields.push(CalibrationFormField {
            key: param.key.clone(),
            label: param.label.clone(),
            kind: param.kind.clone(),
            unit: param.unit.clone(),
            editable: param.editable,
            choices: param.choices.clone(),
            range: param.range.clone(),
            max_items: param.max_items,
            text,
            changed,
        });
    }

    if !issues.is_empty() {
        return CalibrationFormPreview {
            fields,
            plan: None,
            issues,
        };
    }

    let request = match create_default_calibration_job_request(
        definition_id,
        prerequisites,
        Some(&parameters),
        Some(CalibrationExecutionMode::Manual),
    ) {
        Ok(req) => req,
        Err(err_issues) => {
            return CalibrationFormPreview {
                fields,
                plan: None,
                issues: err_issues,
            };
        }
    };

    match compile_calibration_job(&request, job_id) {
        Ok(plan) => CalibrationFormPreview {
            fields,
            plan: Some(plan),
            issues: vec![],
        },
        Err(err_issues) => CalibrationFormPreview {
            fields,
            plan: None,
            issues: err_issues,
        },
    }
}

pub fn describe_calibration_plan(plan: &CalibrationJobPlan) -> String {
    let [width, depth, height] = plan.geometry.required_envelope_mm;
    format!(
        "{} band{}, {} × {} × {} mm on the bed",
        plan.effects.len(),
        if plan.effects.len() == 1 { "" } else { "s" },
        width,
        depth,
        height
    )
}
