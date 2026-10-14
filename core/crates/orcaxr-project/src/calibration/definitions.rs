use super::types::CalibrationJobDefinition;
use std::sync::LazyLock;

const DEFINITIONS_JSON: &str = include_str!("../../../../../contracts/calibration-definitions.json");

static DEFINITIONS: LazyLock<Vec<CalibrationJobDefinition>> = LazyLock::new(|| {
    serde_json::from_str(DEFINITIONS_JSON)
        .expect("calibration-definitions.json contract must be valid")
});

pub fn calibration_job_definitions() -> &'static [CalibrationJobDefinition] {
    &DEFINITIONS
}

pub fn get_calibration_job_definition(id: &str) -> Option<&'static CalibrationJobDefinition> {
    DEFINITIONS.iter().find(|def| def.id == id)
}
