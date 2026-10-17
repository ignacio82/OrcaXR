use super::types::{CalibrationJobPlan, CalibrationSliceAssertion};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationAssertionResult {
    pub assertion: CalibrationSliceAssertion,
    pub actual: Value,
    pub satisfied: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationVerification {
    pub satisfied: bool,
    pub results: Vec<CalibrationAssertionResult>,
    pub failures: Vec<CalibrationAssertionResult>,
}

fn compare(operator: &str, actual: &Value, expected: &Value) -> bool {
    if actual.is_null() && !expected.is_null() {
        return false;
    }
    match operator {
        "equals" => actual == expected,
        "less-than-or-equal" => {
            if let (Some(a), Some(e)) = (actual.as_f64(), expected.as_f64()) {
                a <= e
            } else {
                false
            }
        }
        "contains" => {
            if let Some(arr) = actual.as_array() {
                arr.contains(expected)
            } else if let (Some(act_str), Some(exp_str)) = (actual.as_str(), expected.as_str()) {
                act_str.contains(exp_str)
            } else {
                false
            }
        }
        _ => false,
    }
}

fn actual_for(plan: &CalibrationJobPlan, assertion: &CalibrationSliceAssertion) -> Value {
    match assertion.kind.as_str() {
        "effect-count" => Value::from(plan.effects.len()),
        "label-count" => Value::from(plan.expected_labels.len()),
        "actionable-effects" => {
            let count = plan.effects.iter().filter(|e| {
                !e.engine_overrides.is_empty()
                    || e.custom_gcode.is_some()
                    || e.position_mm.is_some()
                    || e.line_mm.is_some()
            }).count();
            Value::from(count)
        }
        "z-range" => Value::from(plan.geometry.required_envelope_mm[2]),
        "resource-blob" => {
            if let Some(prefix) = assertion.path.strip_prefix("$.geometry.resources[")
                && let Some(idx_str) = prefix.strip_suffix("].blob")
                    && let Ok(idx) = idx_str.parse::<usize>()
                        && let Some(res) = plan.geometry.resources.get(idx) {
                            return Value::String(res.blob.clone());
                        }
            Value::Null
        }
        "override-key" => {
            let mut keys = Vec::new();
            for effect in &plan.effects {
                for o in &effect.engine_overrides {
                    keys.push(Value::String(o.key.clone()));
                }
            }
            Value::Array(keys)
        }
        "gcode-prefix" => {
            let texts: Vec<&str> = plan.effects.iter().filter_map(|e| e.custom_gcode.as_deref()).collect();
            Value::String(texts.join("\n"))
        }
        _ => Value::Null,
    }
}

pub fn verify_calibration_plan(plan: &CalibrationJobPlan) -> CalibrationVerification {
    let mut results = Vec::with_capacity(plan.slice_assertions.len());
    let mut failures = Vec::new();

    for assertion in &plan.slice_assertions {
        let actual = actual_for(plan, assertion);
        let satisfied = compare(&assertion.operator, &actual, &assertion.expected);
        let result = CalibrationAssertionResult {
            assertion: assertion.clone(),
            actual,
            satisfied,
        };
        if !satisfied {
            failures.push(result.clone());
        }
        results.push(result);
    }

    CalibrationVerification {
        satisfied: failures.is_empty(),
        results,
        failures,
    }
}

pub fn describe_assertion_failure(result: &CalibrationAssertionResult) -> String {
    let expected = serde_json::to_string(&result.assertion.expected).unwrap_or_default();
    match result.assertion.kind.as_str() {
        "effect-count" => format!("expected {expected} bands, the plan has {}", result.actual),
        "label-count" => format!("expected {expected} labels, the plan has {}", result.actual),
        "actionable-effects" => format!("expected {expected} bands that actually change something, the plan has {}", result.actual),
        "z-range" => format!("the print would be {} mm tall, above the {expected} mm this calibration allows", result.actual),
        "resource-blob" => {
            if result.actual.is_null() {
                format!("this build cannot evaluate the assertion at {}", result.assertion.path)
            } else {
                format!("the geometry is {}, not the audited {expected}", result.actual)
            }
        }
        "override-key" => format!("no band sets {expected}"),
        "gcode-prefix" => format!("no band emits {expected}"),
        _ => format!("assertion {} failed", result.assertion.id),
    }
}
