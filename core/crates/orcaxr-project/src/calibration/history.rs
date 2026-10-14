use super::types::{
    CalibrationJobDefinition, CalibrationJobPrerequisites, CalibrationJobRequest,
    CalibrationParameterValue, CalibrationResultField, CALIBRATION_JOB_DEFINITION_VERSION,
    CALIBRATION_JOB_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const CALIBRATION_HISTORY_SCHEMA_VERSION: u32 = 1;
pub const CALIBRATION_HISTORY_FORMAT: &str = "orcaxr.calibration-history";
pub const MAX_CALIBRATION_RECORDS: usize = 200;
pub const UNKNOWN_CONDITION: &str = "unknown";

pub fn fnv1a64_text(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn canonical_json(value: &Value) -> Result<String, String> {
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let canonical = orcaxr_contracts::canonical::parse(&raw).map_err(|e| format!("{:?}", e))?;
    let mut out = Vec::new();
    canonical.write_canonical(&mut out).map_err(|e| e.to_string())?;
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationConditions {
    pub printer_model: String,
    pub firmware_flavor: String,
    pub firmware_version: String,
    pub nozzle_diameter_mm: f64,
    pub filament_material: String,
    pub filament_preset_hash: String,
    pub process_preset_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationMeasurement {
    pub key: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationChosenResult {
    pub key: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationAppliedPreset {
    pub scope: String,
    pub preset_id: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationRecordArtifacts {
    pub project_hash: String,
    pub gcode_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationRecordMethod {
    pub definition_id: String,
    pub definition_version: u32,
    pub fingerprint: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationRecord {
    pub schema_version: u32,
    pub recorded_at: String,
    pub operator: String,
    pub method: CalibrationRecordMethod,
    pub parameters: BTreeMap<String, CalibrationParameterValue>,
    pub conditions: CalibrationConditions,
    pub artifacts: CalibrationRecordArtifacts,
    pub measurements: Vec<CalibrationMeasurement>,
    pub chosen: Option<CalibrationChosenResult>,
    pub applied_preset: Option<CalibrationAppliedPreset>,
    pub note: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationMethodDescriptor {
    pub definition_id: String,
    pub definition_version: u32,
    pub fingerprint: String,
    pub label: String,
    pub parameters: BTreeMap<String, CalibrationParameterValue>,
    pub result_fields: Vec<CalibrationResultField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationRunEntry {
    pub operator: String,
    pub recorded_at: String,
    pub measurements: Vec<CalibrationMeasurement>,
    pub chosen_key: Option<String>,
    pub applied_preset: Option<CalibrationAppliedPreset>,
    pub note: Option<String>,
    pub project_hash: String,
    pub gcode_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationHistoryIssue {
    pub code: String,
    pub severity: String,
    pub path: String,
    pub message: String,
}

fn issue(code: &str, path: &str, message: &str, severity: &str) -> CalibrationHistoryIssue {
    CalibrationHistoryIssue {
        code: code.to_string(),
        severity: severity.to_string(),
        path: path.to_string(),
        message: message.to_string(),
    }
}

const SECRET_LIKE: &[&str] = &[
    "token",
    "apikey",
    "api_key",
    "secret",
    "password",
    "passwd",
    "credential",
    "authorization",
];

fn looks_secret(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect::<String>()
        .to_lowercase();
    SECRET_LIKE.iter().any(|needle| {
        let needle_norm: String = needle
            .chars()
            .filter(|c| c.is_ascii_alphabetic() || *c == '_')
            .collect::<String>()
            .to_lowercase();
        normalized.contains(&needle_norm)
    })
}

fn looks_host(s: &str) -> bool {
    let lower = s.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ws://")
        || lower.starts_with("wss://")
    {
        return true;
    }
    // IP pattern check: 4 dot-separated 1-3 digit blocks
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.' || bytes[i] == b':') {
                i += 1;
            }
            let part = &s[start..i];
            let dot_count = part.chars().filter(|c| *c == '.').count();
            if dot_count == 3 {
                let segments: Vec<&str> = part.split(':').next().unwrap_or("").split('.').collect();
                if segments.len() == 4 && segments.iter().all(|seg| !seg.is_empty() && seg.len() <= 3 && seg.chars().all(|c| c.is_ascii_digit())) {
                    return true;
                }
            }
        } else {
            i += 1;
        }
    }
    false
}

pub fn find_secrets_in_payload(value: &Value, path: &str) -> Vec<CalibrationHistoryIssue> {
    let mut issues = Vec::new();
    fn visit(node: &Value, at: &str, depth: usize, issues: &mut Vec<CalibrationHistoryIssue>) {
        if depth > 12 {
            return;
        }
        match node {
            Value::String(s) => {
                if looks_host(s) {
                    issues.push(issue(
                        "secret-in-payload",
                        at,
                        &format!("{at} looks like a network address and may not be exported."),
                        "error",
                    ));
                }
            }
            Value::Array(arr) => {
                for (idx, entry) in arr.iter().enumerate() {
                    visit(entry, &format!("{at}[{idx}]"), depth + 1, issues);
                }
            }
            Value::Object(map) => {
                for (key, entry) in map {
                    let child_path = format!("{at}.{key}");
                    if looks_secret(key) {
                        issues.push(issue(
                            "secret-in-payload",
                            &child_path,
                            &format!("{child_path} is credential-shaped and may not be exported."),
                            "error",
                        ));
                        continue;
                    }
                    visit(entry, &child_path, depth + 1, issues);
                }
            }
            _ => {}
        }
    }
    visit(value, path, 0, &mut issues);
    issues
}

pub fn record_calibration_run(
    method: &CalibrationMethodDescriptor,
    conditions: &CalibrationConditions,
    entry: &CalibrationRunEntry,
) -> Result<CalibrationRecord, Vec<CalibrationHistoryIssue>> {
    let mut issues = Vec::new();
    let defined: BTreeMap<&str, &CalibrationResultField> =
        method.result_fields.iter().map(|f| (f.key.as_str(), f)).collect();
    let mut measured = BTreeMap::new();

    for (index, measurement) in entry.measurements.iter().enumerate() {
        let path = format!("$.measurements[{index}]");
        let field = match defined.get(measurement.key.as_str()) {
            Some(f) => f,
            None => {
                issues.push(issue(
                    "unknown-measurement",
                    &path,
                    &format!("{} defines no result field {:?}.", method.label, measurement.key),
                    "error",
                ));
                continue;
            }
        };

        match &measurement.value {
            Value::Number(n) => {
                if !n.as_f64().map_or(false, |f| f.is_finite()) {
                    issues.push(issue("invalid-record", &path, "A measured value must be finite.", "error"));
                    continue;
                }
            }
            Value::String(s) => {
                if s.trim().is_empty() {
                    issues.push(issue("invalid-record", &path, "A measured value must not be empty.", "error"));
                    continue;
                }
            }
            _ => {}
        }

        measured.insert(
            measurement.key.clone(),
            CalibrationMeasurement {
                key: measurement.key.clone(),
                value: measurement.value.clone(),
                unit: field.unit.clone(),
            },
        );
    }

    for field in &method.result_fields {
        if field.required && !measured.contains_key(&field.key) {
            issues.push(issue(
                "missing-measurement",
                &format!("$.measurements.{}", field.key),
                &format!("{} requires {}.", method.label, field.label),
                "error",
            ));
        }
    }

    let mut chosen = None;
    if let Some(chosen_key) = &entry.chosen_key {
        match measured.get(chosen_key) {
            None => {
                issues.push(issue(
                    "unknown-measurement",
                    "$.chosen",
                    &format!("{chosen_key:?} was chosen but never measured; a result must be one of the values taken."),
                    "error",
                ));
            }
            Some(selected) => {
                chosen = Some(CalibrationChosenResult {
                    key: selected.key.clone(),
                    value: selected.value.clone(),
                    unit: selected.unit.clone(),
                });
            }
        }
    }

    if entry.operator.trim().is_empty() {
        issues.push(issue("invalid-record", "$.operator", "A record names who took the measurement.", "error"));
    }

    let val_payload = serde_json::to_value(entry).unwrap_or(Value::Null);
    issues.extend(find_secrets_in_payload(&val_payload, "$.entry"));
    let cond_payload = serde_json::to_value(conditions).unwrap_or(Value::Null);
    issues.extend(find_secrets_in_payload(&cond_payload, "$.conditions"));

    if issues.iter().any(|i| i.severity == "error") {
        return Err(issues);
    }

    let mut measurements_vec: Vec<CalibrationMeasurement> = measured.into_values().collect();
    measurements_vec.sort_by(|a, b| a.key.cmp(&b.key));

    let body = serde_json::json!({
        "schemaVersion": CALIBRATION_HISTORY_SCHEMA_VERSION,
        "recordedAt": entry.recorded_at,
        "operator": entry.operator.trim(),
        "method": {
            "definitionId": method.definition_id,
            "definitionVersion": method.definition_version,
            "fingerprint": method.fingerprint,
            "label": method.label,
        },
        "parameters": method.parameters,
        "conditions": conditions,
        "artifacts": {
            "projectHash": entry.project_hash,
            "gcodeHash": entry.gcode_hash,
        },
        "measurements": measurements_vec,
        "chosen": chosen,
        "appliedPreset": entry.applied_preset,
        "note": entry.note.as_deref().map(|n| n.trim()).filter(|n| !n.is_empty()),
    });

    let canonical_str = canonical_json(&body).unwrap_or_default();
    let id = format!("calib:{}", fnv1a64_text(&canonical_str));

    Ok(CalibrationRecord {
        schema_version: CALIBRATION_HISTORY_SCHEMA_VERSION,
        recorded_at: entry.recorded_at.clone(),
        operator: entry.operator.trim().to_string(),
        method: CalibrationRecordMethod {
            definition_id: method.definition_id.clone(),
            definition_version: method.definition_version,
            fingerprint: method.fingerprint.clone(),
            label: method.label.clone(),
        },
        parameters: method.parameters.clone(),
        conditions: conditions.clone(),
        artifacts: CalibrationRecordArtifacts {
            project_hash: entry.project_hash.clone(),
            gcode_hash: entry.gcode_hash.clone(),
        },
        measurements: measurements_vec,
        chosen,
        applied_preset: entry.applied_preset.clone(),
        note: entry.note.as_deref().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
        id,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationConditionMismatch {
    pub field: String,
    pub recorded: String,
    pub current: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationApplicability {
    pub applicable: bool,
    pub mismatches: Vec<CalibrationConditionMismatch>,
    pub issues: Vec<CalibrationHistoryIssue>,
}

pub fn assess_calibration_applicability(
    record: &CalibrationRecord,
    current: &CalibrationConditions,
) -> CalibrationApplicability {
    let blocking_fields: HashSet<&str> = [
        "printerModel",
        "nozzleDiameterMm",
        "filamentMaterial",
        "filamentPresetHash",
    ]
    .into_iter()
    .collect();

    let rec_conds = [
        ("printerModel", record.conditions.printer_model.as_str()),
        ("firmwareFlavor", record.conditions.firmware_flavor.as_str()),
        ("firmwareVersion", record.conditions.firmware_version.as_str()),
        ("nozzleDiameterMm", &crate::js_math::convert::number_to_string(record.conditions.nozzle_diameter_mm)),
        ("filamentMaterial", record.conditions.filament_material.as_str()),
        ("filamentPresetHash", record.conditions.filament_preset_hash.as_str()),
        ("processPresetHash", record.conditions.process_preset_hash.as_str()),
    ];

    let cur_conds = [
        ("printerModel", current.printer_model.as_str()),
        ("firmwareFlavor", current.firmware_flavor.as_str()),
        ("firmwareVersion", current.firmware_version.as_str()),
        ("nozzleDiameterMm", &crate::js_math::convert::number_to_string(current.nozzle_diameter_mm)),
        ("filamentMaterial", current.filament_material.as_str()),
        ("filamentPresetHash", current.filament_preset_hash.as_str()),
        ("processPresetHash", current.process_preset_hash.as_str()),
    ];

    let mut mismatches = Vec::new();
    for (i, (field, rec_val)) in rec_conds.iter().enumerate() {
        let cur_val = cur_conds[i].1;
        if *rec_val != cur_val {
            mismatches.push(CalibrationConditionMismatch {
                field: field.to_string(),
                recorded: rec_val.to_string(),
                current: cur_val.to_string(),
                blocking: blocking_fields.contains(field),
            });
        }
    }

    let mut issues = Vec::new();
    for m in mismatches.iter().filter(|m| m.blocking) {
        issues.push(issue(
            "condition-mismatch",
            &format!("$.conditions.{}", m.field),
            &format!(
                "This result was measured with {} {}; the project is set to {}.",
                m.field, m.recorded, m.current
            ),
            "error",
        ));
    }
    for m in mismatches.iter().filter(|m| !m.blocking) {
        issues.push(issue(
            "condition-mismatch",
            &format!("$.conditions.{}", m.field),
            &format!("Measured with {} {}; now {}.", m.field, m.recorded, m.current),
            "warning",
        ));
    }

    let applicable = record.chosen.is_some() && !mismatches.iter().any(|m| m.blocking);

    CalibrationApplicability {
        applicable,
        mismatches,
        issues,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationParameterDifference {
    pub key: String,
    pub left: Option<CalibrationParameterValue>,
    pub right: Option<CalibrationParameterValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationMeasurementDifference {
    pub key: String,
    pub left: Option<Value>,
    pub right: Option<Value>,
    pub delta: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationComparison {
    pub same_method: bool,
    pub same_conditions: bool,
    pub condition_differences: Vec<CalibrationConditionMismatch>,
    pub parameter_differences: Vec<CalibrationParameterDifference>,
    pub measurement_differences: Vec<CalibrationMeasurementDifference>,
    pub caveats: Vec<String>,
}

pub fn compare_calibration_records(left: &CalibrationRecord, right: &CalibrationRecord) -> CalibrationComparison {
    let same_method = left.method.definition_id == right.method.definition_id;
    let applicability = assess_calibration_applicability(left, &right.conditions);
    let condition_differences = applicability.mismatches;

    let mut param_keys_set = HashSet::new();
    for k in left.parameters.keys() {
        param_keys_set.insert(k.clone());
    }
    for k in right.parameters.keys() {
        param_keys_set.insert(k.clone());
    }
    let mut param_keys: Vec<String> = param_keys_set.into_iter().collect();
    param_keys.sort();

    let mut parameter_differences = Vec::new();
    for key in param_keys {
        let left_val = left.parameters.get(&key).cloned();
        let right_val = right.parameters.get(&key).cloned();
        if left_val != right_val {
            parameter_differences.push(CalibrationParameterDifference {
                key,
                left: left_val,
                right: right_val,
            });
        }
    }

    let left_meas: BTreeMap<&str, &Value> = left.measurements.iter().map(|m| (m.key.as_str(), &m.value)).collect();
    let right_meas: BTreeMap<&str, &Value> = right.measurements.iter().map(|m| (m.key.as_str(), &m.value)).collect();
    let mut meas_keys_set = HashSet::new();
    for k in left_meas.keys() {
        meas_keys_set.insert(k.to_string());
    }
    for k in right_meas.keys() {
        meas_keys_set.insert(k.to_string());
    }
    let mut meas_keys: Vec<String> = meas_keys_set.into_iter().collect();
    meas_keys.sort();

    let mut measurement_differences = Vec::new();
    for key in meas_keys {
        let l_val = left_meas.get(key.as_str()).copied().cloned();
        let r_val = right_meas.get(key.as_str()).copied().cloned();
        if l_val != r_val {
            let delta = match (&l_val, &r_val) {
                (Some(Value::Number(l)), Some(Value::Number(r))) => {
                    if let (Some(lf), Some(rf)) = (l.as_f64(), r.as_f64()) {
                        Some(rf - lf)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            measurement_differences.push(CalibrationMeasurementDifference {
                key,
                left: l_val,
                right: r_val,
                delta,
            });
        }
    }

    let mut caveats = Vec::new();
    if !same_method {
        caveats.push("These runs used different calibration methods, so their numbers are not comparable.".to_string());
    } else if left.method.fingerprint != right.method.fingerprint {
        caveats.push("The method changed between these runs, so identical numbers may not mean identical geometry.".to_string());
    }
    if condition_differences.iter().any(|d| d.blocking) {
        caveats.push("These runs were measured under different printing conditions.".to_string());
    }
    if !parameter_differences.is_empty() {
        caveats.push("These runs swept different parameter values.".to_string());
    }

    CalibrationComparison {
        same_method,
        same_conditions: condition_differences.is_empty(),
        condition_differences,
        parameter_differences,
        measurement_differences,
        caveats,
    }
}

pub fn can_rerun_calibration(
    record: &CalibrationRecord,
    definition: Option<&CalibrationJobDefinition>,
) -> Vec<CalibrationHistoryIssue> {
    let def = match definition {
        Some(d) if d.id == record.method.definition_id => d,
        _ => {
            return vec![issue(
                "method-changed",
                "$.method.definitionId",
                "That record was produced by a different calibration.",
                "error",
            )];
        }
    };

    if def.fingerprint != record.method.fingerprint {
        return vec![issue(
            "method-changed",
            "$.method.fingerprint",
            &format!(
                "{} has changed since this run; re-running would measure different geometry. Start a fresh run instead of repeating this one.",
                record.method.label
            ),
            "error",
        )];
    }

    vec![]
}

pub fn calibration_rerun_request(
    record: &CalibrationRecord,
    definition: Option<&CalibrationJobDefinition>,
    prerequisites: &CalibrationJobPrerequisites,
) -> Result<CalibrationJobRequest, Vec<CalibrationHistoryIssue>> {
    let blocking = can_rerun_calibration(record, definition);
    if !blocking.is_empty() {
        return Err(blocking);
    }
    let def = definition.unwrap();
    Ok(CalibrationJobRequest {
        schema_version: CALIBRATION_JOB_SCHEMA_VERSION,
        definition_id: record.method.definition_id.clone(),
        definition_version: CALIBRATION_JOB_DEFINITION_VERSION,
        definition_fingerprint: def.fingerprint.clone(),
        execution: super::types::CalibrationExecutionMode::Manual,
        parameters: record.parameters.clone(),
        prerequisites: prerequisites.clone(),
    })
}

fn sort_records(mut records: Vec<CalibrationRecord>) -> Vec<CalibrationRecord> {
    records.sort_by(|a, b| {
        b.recorded_at.cmp(&a.recorded_at).then_with(|| a.id.cmp(&b.id))
    });
    records
}

pub fn export_calibration_history(
    records: &[CalibrationRecord],
    exported_at: &str,
) -> Result<String, Vec<CalibrationHistoryIssue>> {
    let sorted = sort_records(records.to_vec());
    let payload = serde_json::json!({
        "format": CALIBRATION_HISTORY_FORMAT,
        "schemaVersion": CALIBRATION_HISTORY_SCHEMA_VERSION,
        "exportedAt": exported_at,
        "records": sorted,
    });
    let secrets = find_secrets_in_payload(&payload, "$");
    if !secrets.is_empty() {
        return Err(secrets);
    }
    canonical_json(&payload).map_err(|e| vec![issue("export-failed", "$", &e, "error")])
}

pub fn import_calibration_history(
    text: &str,
) -> Result<Vec<CalibrationRecord>, Vec<CalibrationHistoryIssue>> {
    let parsed: Value = serde_json::from_str(text).map_err(|e| {
        vec![issue("invalid-payload", "$", &format!("Not valid JSON: {e}"), "error")]
    })?;

    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return Err(vec![issue("invalid-payload", "$.format", "Not a calibration history export.", "error")]),
    };

    if obj.get("format").and_then(|v| v.as_str()) != Some(CALIBRATION_HISTORY_FORMAT) {
        return Err(vec![issue("invalid-payload", "$.format", "Not a calibration history export.", "error")]);
    }

    let version = obj.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    if version != 0 && version != CALIBRATION_HISTORY_SCHEMA_VERSION as u64 {
        return Err(vec![issue(
            "unsupported-schema",
            "$.schemaVersion",
            &format!("Schema version {version} is not readable by this build (expected {CALIBRATION_HISTORY_SCHEMA_VERSION} or 0)."),
            "error",
        )]);
    }

    let records_val = match obj.get("records").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Err(vec![issue("invalid-payload", "$.records", "records must be an array.", "error")]),
    };

    let mut records: Vec<CalibrationRecord> = Vec::new();
    for (index, entry) in records_val.iter().enumerate() {
        let path = format!("$.records[{index}]");
        match serde_json::from_value::<CalibrationRecord>(entry.clone()) {
            Ok(rec) => records.push(rec),
            Err(e) => {
                return Err(vec![issue("invalid-payload", &path, &format!("Invalid record: {e}"), "error")]);
            }
        }
    }

    let secrets = find_secrets_in_payload(&serde_json::to_value(&records).unwrap_or(Value::Null), "$.records");
    if secrets.iter().any(|s| s.severity == "error") {
        return Err(secrets);
    }

    Ok(sort_records(records))
}
