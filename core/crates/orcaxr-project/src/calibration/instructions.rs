use super::types::{CalibrationJobPlan, CalibrationResultField};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationBandInstruction {
    pub ordinal: usize,
    pub label: String,
    pub parameter_key: String,
    pub value: Value,
    pub unit: Option<String>,
    pub z_range_mm: Option<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationInstructions {
    pub title: String,
    pub bands: Vec<CalibrationBandInstruction>,
    pub measurements: Vec<CalibrationResultField>,
    pub writes_to: Vec<String>,
    pub layout: String,
}

fn layout_of(plan: &CalibrationJobPlan) -> &'static str {
    let stacked = plan.effects.iter().any(|e| e.z_range_mm.is_some());
    let placed = plan.effects.iter().any(|e| e.z_range_mm.is_none());
    if stacked && placed {
        "mixed"
    } else if stacked {
        "stacked-by-height"
    } else {
        "placed-across-the-bed"
    }
}

pub fn calibration_instructions(plan: &CalibrationJobPlan) -> CalibrationInstructions {
    let bands = plan
        .effects
        .iter()
        .enumerate()
        .map(|(index, effect)| CalibrationBandInstruction {
            ordinal: index + 1,
            label: effect.label.clone(),
            parameter_key: effect.parameter_key.clone(),
            value: effect.value.clone(),
            unit: effect.unit.clone(),
            z_range_mm: effect.z_range_mm,
        })
        .collect();

    let writes_to = plan
        .preset_targets
        .iter()
        .map(|target| format!("{}: {}", target.scope, target.key))
        .collect();

    CalibrationInstructions {
        title: plan.label.clone(),
        bands,
        measurements: plan.result_fields.clone(),
        writes_to,
        layout: layout_of(plan).to_string(),
    }
}

pub fn describe_band_location(band: &CalibrationBandInstruction, layout: &str) -> String {
    if let Some(z) = band.z_range_mm {
        format!("{}–{} mm from the bed", z[0], z[1])
    } else if layout == "placed-across-the-bed" {
        format!("piece {} on the plate", band.ordinal)
    } else {
        format!("piece {} (not stacked by height)", band.ordinal)
    }
}
