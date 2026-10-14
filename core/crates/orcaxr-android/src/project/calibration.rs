//! Calibration subsystem JNI bindings.
use super::*;
use orcaxr_contracts::generated::MAX_INPUT_BYTES;
use orcaxr_project::calibration::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) fn calibration_definitions(env: &mut JNIEnv<'_>) -> Result<jstring> {
    let defs = calibration_job_definitions();
    let json = serde_json::to_string(&defs).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_compile(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
    job_id: JString<'_>,
) -> Result<jstring> {
    let req_str = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let id_str = bounded_text(env, &job_id, MAX_INPUT_BYTES)?;
    let req: CalibrationJobRequest = serde_json::from_str(&req_str).map_err(|_| "invalid_request")?;
    let reply = match compile_calibration_job(&req, &id_str) {
        Ok(plan) => json!({ "plan": plan, "issues": [] }),
        Err(issues) => json!({ "plan": Value::Null, "issues": issues }),
    };
    let json = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_verify(
    env: &mut JNIEnv<'_>,
    plan: JString<'_>,
) -> Result<jstring> {
    let plan_str = bounded_text(env, &plan, MAX_INPUT_BYTES)?;
    let plan: CalibrationJobPlan = serde_json::from_str(&plan_str).map_err(|_| "invalid_request")?;
    let verification = verify_calibration_plan(&plan);
    let json = serde_json::to_string(&verification).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_form(
    env: &mut JNIEnv<'_>,
    request: JString<'_>,
) -> Result<jstring> {
    let req_str = bounded_text(env, &request, MAX_INPUT_BYTES)?;
    let v: Value = serde_json::from_str(&req_str).map_err(|_| "invalid_request")?;
    let workflow_id = v.get("workflowId").and_then(|x| x.as_str()).ok_or("invalid_request")?;
    let prereqs: CalibrationJobPrerequisites = serde_json::from_value(
        v.get("prerequisites").cloned().unwrap_or(Value::Null),
    ).map_err(|_| "invalid_request")?;
    let edits: BTreeMap<String, String> = serde_json::from_value(
        v.get("edits").cloned().unwrap_or(Value::Null),
    ).unwrap_or_default();
    let job_id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("calibration:form");

    let form = build_calibration_form(workflow_id, &prereqs, &edits, job_id);
    let json = serde_json::to_string(&form).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_instructions(
    env: &mut JNIEnv<'_>,
    plan: JString<'_>,
) -> Result<jstring> {
    let plan_str = bounded_text(env, &plan, MAX_INPUT_BYTES)?;
    let plan: CalibrationJobPlan = serde_json::from_str(&plan_str).map_err(|_| "invalid_request")?;
    let instructions = orcaxr_project::calibration::calibration_instructions(&plan);
    let json = serde_json::to_string(&instructions).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_automation(
    env: &mut JNIEnv<'_>,
    workflow_id: JString<'_>,
    objects: JString<'_>,
) -> Result<jstring> {
    let id_str = bounded_text(env, &workflow_id, MAX_INPUT_BYTES)?;
    let objs_str = bounded_text(env, &objects, MAX_INPUT_BYTES)?;
    let objs: Option<Vec<String>> = serde_json::from_str(&objs_str).ok();
    let assessment = assess_calibration_automation(&id_str, objs.as_deref());
    let json = serde_json::to_string(&assessment).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_application(
    env: &mut JNIEnv<'_>,
    record: JString<'_>,
    conditions: JString<'_>,
) -> Result<jstring> {
    let rec_str = bounded_text(env, &record, MAX_INPUT_BYTES)?;
    let cond_str = bounded_text(env, &conditions, MAX_INPUT_BYTES)?;
    let rec: CalibrationRecord = serde_json::from_str(&rec_str).map_err(|_| "invalid_request")?;
    let cond: CalibrationConditions = serde_json::from_str(&cond_str).map_err(|_| "invalid_request")?;
    let plan = plan_calibration_application(&rec, &cond);
    let json = serde_json::to_string(&plan).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_line_program(
    env: &mut JNIEnv<'_>,
    plan: JString<'_>,
    options: JString<'_>,
) -> Result<jstring> {
    let plan_str = bounded_text(env, &plan, MAX_INPUT_BYTES)?;
    let opt_str = bounded_text(env, &options, MAX_INPUT_BYTES)?;
    let plan: CalibrationJobPlan = serde_json::from_str(&plan_str).map_err(|_| "invalid_request")?;
    let opt: LineProgramOptions = serde_json::from_str(&opt_str).map_err(|_| "invalid_request")?;
    let prog = pressure_advance_line_program(&plan, &opt).map_err(|_| "compilation_failed")?;
    let json = serde_json::to_string(&prog).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_flow_matching(
    env: &mut JNIEnv<'_>,
    patches: JString<'_>,
    effects: JString<'_>,
) -> Result<jstring> {
    let pat_str = bounded_text(env, &patches, MAX_INPUT_BYTES)?;
    let eff_str = bounded_text(env, &effects, MAX_INPUT_BYTES)?;
    let patches_vec: Vec<String> = serde_json::from_str(&pat_str).map_err(|_| "invalid_request")?;
    let effects_vec: Vec<CalibrationPlanEffect> = serde_json::from_str(&eff_str).map_err(|_| "invalid_request")?;
    let mapping = match_flow_patches(&patches_vec, &effects_vec);
    let json = serde_json::to_string(&mapping).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_record(
    env: &mut JNIEnv<'_>,
    method: JString<'_>,
    conditions: JString<'_>,
    entry: JString<'_>,
) -> Result<jstring> {
    let method_str = bounded_text(env, &method, MAX_INPUT_BYTES)?;
    let cond_str = bounded_text(env, &conditions, MAX_INPUT_BYTES)?;
    let entry_str = bounded_text(env, &entry, MAX_INPUT_BYTES)?;
    let m: CalibrationMethodDescriptor = serde_json::from_str(&method_str).map_err(|_| "invalid_request")?;
    let c: CalibrationConditions = serde_json::from_str(&cond_str).map_err(|_| "invalid_request")?;
    let e: CalibrationRunEntry = serde_json::from_str(&entry_str).map_err(|_| "invalid_request")?;
    let reply = match record_calibration_run(&m, &c, &e) {
        Ok(rec) => json!({ "record": rec, "issues": [] }),
        Err(issues) => json!({ "record": Value::Null, "issues": issues }),
    };
    let json = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_assess(
    env: &mut JNIEnv<'_>,
    record: JString<'_>,
    conditions: JString<'_>,
) -> Result<jstring> {
    let rec_str = bounded_text(env, &record, MAX_INPUT_BYTES)?;
    let cond_str = bounded_text(env, &conditions, MAX_INPUT_BYTES)?;
    let r: CalibrationRecord = serde_json::from_str(&rec_str).map_err(|_| "invalid_request")?;
    let c: CalibrationConditions = serde_json::from_str(&cond_str).map_err(|_| "invalid_request")?;
    let app = assess_calibration_applicability(&r, &c);
    let json = serde_json::to_string(&app).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_compare(
    env: &mut JNIEnv<'_>,
    left: JString<'_>,
    right: JString<'_>,
) -> Result<jstring> {
    let l_str = bounded_text(env, &left, MAX_INPUT_BYTES)?;
    let r_str = bounded_text(env, &right, MAX_INPUT_BYTES)?;
    let l: CalibrationRecord = serde_json::from_str(&l_str).map_err(|_| "invalid_request")?;
    let r: CalibrationRecord = serde_json::from_str(&r_str).map_err(|_| "invalid_request")?;
    let comp = compare_calibration_records(&l, &r);
    let json = serde_json::to_string(&comp).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_export(
    env: &mut JNIEnv<'_>,
    records: JString<'_>,
    exported_at: JString<'_>,
) -> Result<jstring> {
    let recs_str = bounded_text(env, &records, MAX_INPUT_BYTES)?;
    let at_str = bounded_text(env, &exported_at, MAX_INPUT_BYTES)?;
    let recs: Vec<CalibrationRecord> = serde_json::from_str(&recs_str).map_err(|_| "invalid_request")?;
    let reply = match export_calibration_history(&recs, &at_str) {
        Ok(text) => json!({ "text": text, "issues": [] }),
        Err(issues) => json!({ "text": Value::Null, "issues": issues }),
    };
    let json = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_import(
    env: &mut JNIEnv<'_>,
    text: JString<'_>,
) -> Result<jstring> {
    let t_str = bounded_text(env, &text, MAX_INPUT_BYTES)?;
    let reply = match import_calibration_history(&t_str) {
        Ok(records) => json!({ "records": records, "issues": [] }),
        Err(issues) => json!({ "records": Value::Null, "issues": issues }),
    };
    let json = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}

pub(super) fn calibration_history_rerun(
    env: &mut JNIEnv<'_>,
    record: JString<'_>,
    prerequisites: JString<'_>,
) -> Result<jstring> {
    let rec_str = bounded_text(env, &record, MAX_INPUT_BYTES)?;
    let prereqs_str = bounded_text(env, &prerequisites, MAX_INPUT_BYTES)?;
    let rec: CalibrationRecord = serde_json::from_str(&rec_str).map_err(|_| "invalid_request")?;
    let prereqs: CalibrationJobPrerequisites = serde_json::from_str(&prereqs_str).map_err(|_| "invalid_request")?;
    let def = get_calibration_job_definition(&rec.method.definition_id);
    let reply = match calibration_rerun_request(&rec, def, &prereqs) {
        Ok(req) => json!({ "request": req, "issues": [] }),
        Err(issues) => json!({ "request": Value::Null, "issues": issues }),
    };
    let json = serde_json::to_string(&reply).map_err(|_| "output_limit")?;
    string(env, json)
}
