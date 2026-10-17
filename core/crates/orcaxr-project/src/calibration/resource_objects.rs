use super::types::CalibrationPlanEffect;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceObjectMatch {
    pub object_name: String,
    pub object_index: usize,
    pub effect: CalibrationPlanEffect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceObjectMapping {
    pub matches: Vec<ResourceObjectMatch>,
    pub problems: Vec<String>,
}

pub fn flow_patch_ratio(object_name: &str) -> Option<f64> {
    let trimmed = object_name.trim();
    let rest = trimmed.strip_prefix("flowrate_")?;
    let (is_negative, num_str) = if let Some(stripped) = rest.strip_prefix('m') {
        (true, stripped)
    } else {
        (false, rest)
    };

    if num_str.is_empty() {
        return None;
    }

    if num_str.contains('.') {
        let val = crate::js_math::convert::parse_float(num_str);
        if !val.is_finite() {
            return None;
        }
        Some(if is_negative { 1.0 - val } else { 1.0 + val })
    } else {
        let val = crate::js_math::convert::parse_float(num_str);
        if !val.is_finite() {
            return None;
        }
        Some(if is_negative { 1.0 - val / 100.0 } else { 1.0 + val / 100.0 })
    }
}

fn same_ratio(left: f64, right: f64) -> bool {
    (left - right).abs() < 1e-9
}

pub fn match_flow_patches(
    object_names: &[String],
    effects: &[CalibrationPlanEffect],
) -> ResourceObjectMapping {
    let mut problems = Vec::new();
    let mut matches = Vec::new();
    let mut used_effects = HashSet::new();

    for (object_index, object_name) in object_names.iter().enumerate() {
        let ratio = match flow_patch_ratio(object_name) {
            Some(r) => r,
            None => {
                problems.push(format!("“{object_name}” is not a flow patch name, so nothing can say what it should print at"));
                continue;
            }
        };

        let mut candidates = Vec::new();
        for (index, effect) in effects.iter().enumerate() {
            if let Some(val) = effect.value.as_f64()
                && same_ratio(val, ratio) {
                    candidates.push((index, effect));
                }
        }

        if candidates.is_empty() {
            problems.push(format!("“{object_name}” wants a flow ratio of {ratio}, which this plan does not contain"));
            continue;
        }
        if candidates.len() > 1 {
            problems.push(format!("“{object_name}” matches {} effects at {ratio}; the plan is ambiguous", candidates.len()));
            continue;
        }

        let (idx, effect) = candidates[0];
        used_effects.insert(idx);
        matches.push(ResourceObjectMatch {
            object_name: object_name.clone(),
            object_index,
            effect: effect.clone(),
        });
    }

    for (index, effect) in effects.iter().enumerate() {
        if !used_effects.contains(&index) {
            let val_str = match &effect.value {
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
            problems.push(format!("no piece on the plate prints at {val_str}, so that band would be missing"));
        }
    }

    let final_matches = if problems.is_empty() { matches } else { vec![] };
    ResourceObjectMapping {
        matches: final_matches,
        problems,
    }
}
