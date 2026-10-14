use super::types::CalibrationJobPlan;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineProgramOptions {
    pub layer_height_mm: f64,
    pub line_width_mm: f64,
    pub filament_diameter_mm: f64,
    pub print_feed_mm_per_min: f64,
    pub travel_feed_mm_per_min: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineProgram {
    pub body: String,
    pub lines: usize,
    pub filament_mm: f64,
    pub missing: Vec<String>,
}

fn round_decimals(value: f64, decimals: u32) -> String {
    let fixed = crate::js_math::convert::to_fixed(value, decimals);
    let num = crate::js_math::convert::parse_float(&fixed);
    crate::js_math::convert::number_to_string(num)
}

pub fn extrusion_for_line(
    length_mm: f64,
    layer_height_mm: f64,
    line_width_mm: f64,
    filament_diameter_mm: f64,
) -> Result<f64, String> {
    let filament_area = std::f64::consts::PI * (filament_diameter_mm / 2.0).powi(2);
    if !(filament_area > 0.0) {
        return Err("Filament diameter must be positive".to_string());
    }
    Ok((length_mm * line_width_mm * layer_height_mm) / filament_area)
}

pub fn pressure_advance_line_program(
    plan: &CalibrationJobPlan,
    options: &LineProgramOptions,
) -> Result<LineProgram, String> {
    let lines: Vec<_> = plan.effects.iter().filter(|e| e.line_mm.is_some()).collect();
    if lines.is_empty() {
        return Err(format!("{} has no lines to draw", plan.definition_id));
    }

    let mut heights = HashSet::new();
    for effect in &lines {
        let z_bits = effect.line_mm.as_ref().unwrap().start[2].to_bits();
        heights.insert(z_bits);
    }
    if heights.len() != 1 {
        return Err(format!(
            "{} draws at {} heights; this generator is for one-layer sweeps",
            plan.definition_id,
            heights.len()
        ));
    }
    if lines.len() != plan.effects.len() {
        return Err(format!(
            "{} mixes line effects with others; nothing was generated",
            plan.definition_id
        ));
    }

    let z = f64::from_bits(*heights.iter().next().unwrap());
    let mut out = vec![
        format!("; OrcaXR calibration body: {}", plan.definition_id),
        format!("; {} lines at z {} mm — machine preamble NOT included", lines.len(), z),
        "G90".to_string(),
        "M83".to_string(),
    ];
    let mut filament_mm = 0.0;

    for effect in &lines {
        let line = effect.line_mm.as_ref().unwrap();
        let length = (line.end[0] - line.start[0]).hypot(line.end[1] - line.start[1]);
        let extrusion = extrusion_for_line(
            length,
            options.layer_height_mm,
            options.line_width_mm,
            options.filament_diameter_mm,
        )?;
        filament_mm += extrusion;

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

        out.push(format!("; {} ({} = {})", effect.label, effect.parameter_key, val_str));
        if let Some(cmd) = &effect.custom_gcode {
            let trimmed = cmd.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
        out.push(format!(
            "G0 X{} Y{} Z{} F{}",
            round_decimals(line.start[0], 3),
            round_decimals(line.start[1], 3),
            round_decimals(z, 3),
            options.travel_feed_mm_per_min
        ));
        out.push(format!(
            "G1 X{} Y{} E{} F{}",
            round_decimals(line.end[0], 3),
            round_decimals(line.end[1], 3),
            round_decimals(extrusion, 5),
            options.print_feed_mm_per_min
        ));
    }

    Ok(LineProgram {
        body: format!("{}\n", out.join("\n")),
        lines: lines.len(),
        filament_mm,
        missing: vec![
            "machine start G-code, including bed mesh calibration and nozzle cleaning".to_string(),
            "bed and nozzle heating for the chosen filament".to_string(),
            "machine end G-code".to_string(),
        ],
    })
}
