use orcaxr_project::calibration::*;
use serde_json::Value;

const VECTORS_JSON: &str = include_str!("../../../../testdata/cross-platform/calibration-vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS_JSON).expect("valid calibration vectors JSON")
}

fn assert_json_eq(left: &Value, right: &Value, path: &str) {
    match (left, right) {
        (Value::Null, Value::Null) => {}
        (Value::Bool(a), Value::Bool(b)) => {
            assert_eq!(a, b, "Bool mismatch at {path}");
        }
        (Value::Number(a), Value::Number(b)) => {
            let fa = a.as_f64().expect("valid float");
            let fb = b.as_f64().expect("valid float");
            assert!(
                (fa - fb).abs() < 1e-5 || fa == fb,
                "Number mismatch at {path}: {fa} vs {fb}"
            );
        }
        (Value::String(a), Value::String(b)) => {
            assert_eq!(a, b, "String mismatch at {path}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(
                a.len(),
                b.len(),
                "Array length mismatch at {path}: left len {}, right len {}",
                a.len(),
                b.len()
            );
            for (i, (item_a, item_b)) in a.iter().zip(b.iter()).enumerate() {
                assert_json_eq(item_a, item_b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let keys_a: std::collections::BTreeSet<_> = a.keys().collect();
            let keys_b: std::collections::BTreeSet<_> = b.keys().collect();
            assert_eq!(keys_a, keys_b, "Object key mismatch at {path}");
            for k in keys_a {
                assert_json_eq(&a[k], &b[k], &format!("{path}.{k}"));
            }
        }
        _ => {
            panic!(
                "Type mismatch at {path}: left={:?}, right={:?}",
                left, right
            );
        }
    }
}

#[test]
fn definitions_catalog_matches_cross_platform_vectors() {
    let v = vectors();
    let expected_defs = v["definitions"].as_array().unwrap();
    assert_eq!(expected_defs.len(), 15);

    let actual_defs = calibration_job_definitions();
    assert_eq!(actual_defs.len(), 15);

    for expected in expected_defs {
        let id = expected["id"].as_str().unwrap();
        let actual = get_calibration_job_definition(id).expect("definition exists");
        let actual_val = serde_json::to_value(actual).unwrap();
        assert_json_eq(&actual_val, expected, &format!("definition {id}"));
    }
}

#[test]
fn default_plans_compile_matching_cross_platform_vectors() {
    let v = vectors();
    let default_plans = v["defaultPlans"].as_array().unwrap();
    assert_eq!(default_plans.len(), 15);

    for case in default_plans {
        let id = case["id"].as_str().unwrap();
        let request: CalibrationJobRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let expected_plan = &case["plan"];

        let job_id = format!("calibration:default:{id}");
        let compiled = compile_calibration_job(&request, &job_id).expect("compilation succeeds");
        let actual_plan = serde_json::to_value(&compiled).unwrap();

        assert_json_eq(&actual_plan, expected_plan, &format!("default plan {id}"));

        let verification = verify_calibration_plan(&compiled);
        assert!(verification.satisfied, "Plan verification failed for {id}: {:?}", verification.failures);
    }
}

#[test]
fn custom_plans_compile_matching_cross_platform_vectors() {
    let v = vectors();
    let custom_plans = v["customPlans"].as_array().unwrap();
    assert_eq!(custom_plans.len(), 10);

    for case in custom_plans {
        let id = case["id"].as_str().unwrap();
        let expected_plan = &case["plan"];

        let prereqs: CalibrationJobPrerequisites = serde_json::from_value(case["plan"]["prerequisites"].clone()).unwrap();
        let params: std::collections::BTreeMap<String, CalibrationParameterValue> =
            serde_json::from_value(case["params"].clone()).unwrap();

        let req = create_default_calibration_job_request(id, &prereqs, Some(&params), None).unwrap();
        let job_id = format!("calibration:custom:{id}");
        let compiled = compile_calibration_job(&req, &job_id).expect("compilation succeeds");
        let actual_plan = serde_json::to_value(&compiled).unwrap();

        assert_json_eq(&actual_plan, expected_plan, &format!("custom plan {id}"));
    }
}

#[test]
fn rejections_match_cross_platform_vectors() {
    let v = vectors();
    let rejections = v["rejections"].as_array().unwrap();
    assert_eq!(rejections.len(), 8);

    for case in rejections {
        let name = case["name"].as_str().unwrap();
        let expected_issues = case["issues"].as_array().unwrap();

        let actual_issues = match name {
            "unknown_definition" => {
                let dummy_prereqs = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                let req = CalibrationJobRequest {
                    schema_version: 1,
                    definition_id: "unknown-calibration".to_string(),
                    definition_version: 1,
                    definition_fingerprint: "fnv1a64:0000000000000000".to_string(),
                    execution: CalibrationExecutionMode::Manual,
                    parameters: Default::default(),
                    prerequisites: dummy_prereqs,
                };
                compile_calibration_job(&req, "calibration:unknown").unwrap_err()
            }
            "stale_fingerprint" => {
                let dummy_prereqs = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                let mut req = create_default_calibration_job_request("temperature-tower", &dummy_prereqs, None, None).unwrap();
                req.definition_fingerprint = "fnv1a64:deadbeefcafebabe".to_string();
                compile_calibration_job(&req, "calibration:stale").unwrap_err()
            }
            "temp_safety_exceeded" => {
                let dummy_prereqs = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                let mut params = std::collections::BTreeMap::new();
                params.insert("start".to_string(), CalibrationParameterValue::Number(290.0));
                params.insert("end".to_string(), CalibrationParameterValue::Number(250.0));
                params.insert("step".to_string(), CalibrationParameterValue::Number(5.0));
                let req = create_default_calibration_job_request("temperature-tower", &dummy_prereqs, Some(&params), None).unwrap();
                compile_calibration_job(&req, "calibration:hot").unwrap_err()
            }
            "non_integral_step" => {
                let dummy_prereqs = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                let mut params = std::collections::BTreeMap::new();
                params.insert("start".to_string(), CalibrationParameterValue::Number(230.0));
                params.insert("end".to_string(), CalibrationParameterValue::Number(190.0));
                params.insert("step".to_string(), CalibrationParameterValue::Number(7.0));
                let req = create_default_calibration_job_request("temperature-tower", &dummy_prereqs, Some(&params), None).unwrap();
                compile_calibration_job(&req, "calibration:fractional").unwrap_err()
            }
            "bed_overflow" => {
                let mut prereqs: CalibrationJobPrerequisites = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                prereqs.printer.bed_width_mm = 30.0;
                let req = create_default_calibration_job_request("temperature-tower", &prereqs, None, None).unwrap();
                compile_calibration_job(&req, "calibration:cramped").unwrap_err()
            }
            "missing_firmware_capability" => {
                let mut prereqs: CalibrationJobPrerequisites = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                prereqs.firmware.flavor = CalibrationFirmwareFlavor::Klipper;
                prereqs.firmware.pressure_advance = false;
                let req = create_default_calibration_job_request("pressure-advance-tower", &prereqs, None, None).unwrap();
                compile_calibration_job(&req, "calibration:nopa").unwrap_err()
            }
            "wrong_firmware_flavor" => {
                let mut prereqs: CalibrationJobPrerequisites = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                prereqs.firmware.flavor = CalibrationFirmwareFlavor::Klipper;
                prereqs.firmware.junction_deviation = false;
                let req = create_default_calibration_job_request("junction-deviation", &prereqs, None, None).unwrap();
                compile_calibration_job(&req, "calibration:not-marlin").unwrap_err()
            }
            "automatic_unsupported" => {
                let dummy_prereqs = serde_json::from_value(v["defaultPlans"][0]["request"]["prerequisites"].clone()).unwrap();
                let mut req = create_default_calibration_job_request("temperature-tower", &dummy_prereqs, None, None).unwrap();
                req.execution = CalibrationExecutionMode::Automatic;
                compile_calibration_job(&req, "calibration:auto").unwrap_err()
            }
            other => panic!("Unexpected rejection case: {other}"),
        };

        let actual_codes: Vec<&str> = actual_issues.iter().map(|i| i.code.as_str()).collect();
        let expected_codes: Vec<&str> = expected_issues.iter().map(|i| i["code"].as_str().unwrap()).collect();
        assert_eq!(actual_codes, expected_codes, "Issues codes mismatch in {name}");

        let actual_paths: Vec<&str> = actual_issues.iter().map(|i| i.path.as_str()).collect();
        let expected_paths: Vec<&str> = expected_issues.iter().map(|i| i["path"].as_str().unwrap()).collect();
        assert_eq!(actual_paths, expected_paths, "Issues paths mismatch in {name}");
    }
}

#[test]
fn form_previews_match_cross_platform_vectors() {
    let v = vectors();
    let form_previews = v["formPreviews"].as_array().unwrap();
    assert_eq!(form_previews.len(), 17);

    for case in form_previews {
        let id = case["id"].as_str().unwrap();
        let expected_form = &case["form"];
        let prereqs: CalibrationJobPrerequisites = serde_json::from_value(
            if let Some(plan_val) = expected_form.get("plan").and_then(|p| p.as_object()) {
                serde_json::to_value(&plan_val["prerequisites"]).unwrap()
            } else {
                v["defaultPlans"][0]["request"]["prerequisites"].clone()
            }
        ).unwrap();

        let mut edits = std::collections::BTreeMap::new();
        if case["kind"].as_str().unwrap() == "edited" {
            edits.insert("start".to_string(), "235".to_string());
            edits.insert("end".to_string(), "205".to_string());
            edits.insert("step".to_string(), "5".to_string());
        } else if case["kind"].as_str().unwrap() == "unreadable" {
            edits.insert("start".to_string(), "not_a_number".to_string());
            edits.insert("step".to_string(), "".to_string());
        }

        let job_id = if case["kind"].as_str().unwrap() == "edited" {
            "calibration:form:edited"
        } else if case["kind"].as_str().unwrap() == "unreadable" {
            "calibration:form:unreadable"
        } else {
            &format!("calibration:form:{id}")
        };

        let actual_form = build_calibration_form(id, &prereqs, &edits, job_id);
        let actual_val = serde_json::to_value(&actual_form).unwrap();

        assert_json_eq(&actual_val["fields"], &expected_form["fields"], &format!("fields for {id}"));
        assert_json_eq(&actual_val["issues"], &expected_form["issues"], &format!("issues for {id}"));
        if expected_form["plan"].is_null() {
            assert!(actual_val["plan"].is_null());
        } else {
            assert_json_eq(&actual_val["plan"], &expected_form["plan"], &format!("plan for {id}"));
        }
    }
}

#[test]
fn instructions_match_cross_platform_vectors() {
    let v = vectors();
    let instructions = v["instructions"].as_array().unwrap();
    assert_eq!(instructions.len(), 15);

    for case in instructions {
        let id = case["id"].as_str().unwrap();
        let expected_inst = &case["instructions"];

        let plan_case = v["defaultPlans"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap();
        let plan: CalibrationJobPlan = serde_json::from_value(plan_case["plan"].clone()).unwrap();

        let actual_inst = calibration_instructions(&plan);
        let actual_val = serde_json::to_value(&actual_inst).unwrap();

        assert_json_eq(&actual_val, expected_inst, &format!("instructions for {id}"));
    }
}

#[test]
fn history_operations_match_cross_platform_vectors() {
    let v = vectors();
    let hist = &v["history"];

    // 1. Record creation and ID calculation
    let recorded_expected = &hist["recorded"];
    let method: CalibrationMethodDescriptor = serde_json::from_value(serde_json::json!({
        "definitionId": "temperature-tower",
        "definitionVersion": 1,
        "fingerprint": "fnv1a64:c5778c21a78202a0",
        "label": "Temperature",
        "parameters": {
            "filamentType": "PLA",
            "start": 230,
            "end": 190,
            "step": 5
        },
        "resultFields": [
            {
                "key": "bestNozzleTemperatureC",
                "label": "Selected nozzle temperature",
                "unit": "°C",
                "required": true
            }
        ]
    })).unwrap();

    let conditions: CalibrationConditions = serde_json::from_value(serde_json::json!({
        "printerModel": "U1",
        "firmwareFlavor": "klipper",
        "firmwareVersion": "v0.12.0",
        "nozzleDiameterMm": 0.4,
        "filamentMaterial": "PLA",
        "filamentPresetHash": "fnv1a64:1111222233334444",
        "processPresetHash": "fnv1a64:5555666677778888"
    })).unwrap();

    let entry: CalibrationRunEntry = serde_json::from_value(serde_json::json!({
        "operator": "Operator",
        "recordedAt": "2026-10-14T10:00:00Z",
        "measurements": [{ "key": "bestNozzleTemperatureC", "value": 215 }],
        "chosenKey": "bestNozzleTemperatureC",
        "note": "Clean bridging at 215 C",
        "projectHash": "fnv1a64:9999000011112222"
    })).unwrap();

    let recorded_actual = record_calibration_run(&method, &conditions, &entry).unwrap();
    let recorded_actual_val = serde_json::to_value(&recorded_actual).unwrap();
    assert_json_eq(&recorded_actual_val, recorded_expected, "Recorded run mismatch");

    // 2. Secret scan
    let secret_payload = serde_json::json!({
        "authToken": "secret_token_value",
        "serverAddress": "http://192.168.1.50:7125",
        "apiKey": "12345",
        "safeData": "ok",
    });
    let secrets = find_secrets_in_payload(&secret_payload, "$");
    assert_eq!(secrets.len(), 3);

    // 3. Applicability checks
    let app_exact = assess_calibration_applicability(&recorded_actual, &conditions);
    assert_json_eq(&serde_json::to_value(&app_exact).unwrap(), &hist["applicability"]["exact"], "app_exact");

    let mut wrong_nozzle = conditions.clone();
    wrong_nozzle.nozzle_diameter_mm = 0.6;
    let app_nozzle = assess_calibration_applicability(&recorded_actual, &wrong_nozzle);
    assert_json_eq(&serde_json::to_value(&app_nozzle).unwrap(), &hist["applicability"]["wrongNozzle"], "app_nozzle");

    let mut wrong_fil = conditions.clone();
    wrong_fil.filament_material = "PETG".to_string();
    let app_fil = assess_calibration_applicability(&recorded_actual, &wrong_fil);
    assert_json_eq(&serde_json::to_value(&app_fil).unwrap(), &hist["applicability"]["wrongFilament"], "app_fil");

    let mut fw_change = conditions.clone();
    fw_change.firmware_version = "v0.12.1".to_string();
    let app_fw = assess_calibration_applicability(&recorded_actual, &fw_change);
    assert_json_eq(&serde_json::to_value(&app_fw).unwrap(), &hist["applicability"]["firmwareChange"], "app_fw");

    // 4. Comparison
    let mut second_entry = entry.clone();
    second_entry.recorded_at = "2026-10-14T11:00:00Z".to_string();
    second_entry.measurements = vec![CalibrationMeasurement {
        key: "bestNozzleTemperatureC".to_string(),
        value: serde_json::json!(220),
        unit: None,
    }];
    let second_record = record_calibration_run(&method, &conditions, &second_entry).unwrap();
    let comp_same = compare_calibration_records(&recorded_actual, &second_record);
    assert_json_eq(&serde_json::to_value(&comp_same).unwrap(), &hist["comparison"]["same"], "comp_same");

    let third_record = record_calibration_run(&method, &wrong_nozzle, &second_entry).unwrap();
    let comp_diff = compare_calibration_records(&recorded_actual, &third_record);
    assert_json_eq(&serde_json::to_value(&comp_diff).unwrap(), &hist["comparison"]["different"], "comp_diff");

    // 5. Export and Import
    let exported = export_calibration_history(&[recorded_actual.clone(), second_record.clone()], "2026-10-14T11:05:00Z").unwrap();
    let exported_val: Value = serde_json::from_str(&exported).unwrap();
    let expected_export_val: Value = serde_json::from_str(hist["exportJson"].as_str().unwrap()).unwrap();
    assert_json_eq(&exported_val, &expected_export_val, "exportJson semantic mismatch");

    let imported = import_calibration_history(&exported).unwrap();
    assert_eq!(imported.len(), 2);
    let imported_val = serde_json::to_value(&imported).unwrap();
    assert_json_eq(&imported_val, &hist["importRecords"], "importRecords mismatch");
}

#[test]
fn application_rules_and_assessment_match_cross_platform_vectors() {
    let v = vectors();
    let app = &v["application"];
    let rules = app["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 15);

    for r in rules {
        let id = r["id"].as_str().unwrap();
        let expected_rule = &r["rule"];
        let actual_rule = get_calibration_application_rule(id).expect("rule exists");
        let actual_val = serde_json::to_value(&actual_rule).unwrap();
        assert_eq!(&actual_val, expected_rule, "Mismatch in application rule {id}");
    }

    let recorded: CalibrationRecord = serde_json::from_value(v["history"]["recorded"].clone()).unwrap();
    let current: CalibrationConditions = serde_json::from_value(v["history"]["recorded"]["conditions"].clone()).unwrap();
    let plan = plan_calibration_application(&recorded, &current);
    let plan_val = serde_json::to_value(&plan).unwrap();
    assert_eq!(&plan_val, &app["sampleAssessment"], "Mismatch in application sampleAssessment");
}

#[test]
fn automation_rules_and_assessment_match_cross_platform_vectors() {
    let v = vectors();
    let auto_cases = v["automation"].as_array().unwrap();
    assert_eq!(auto_cases.len(), 15);

    for case in auto_cases {
        let id = case["id"].as_str().unwrap();
        let actual_rule = get_calibration_automation_rule(id);
        assert_eq!(serde_json::to_value(&actual_rule).unwrap(), case["rule"]);

        let no_obj = assess_calibration_automation(id, None);
        assert_eq!(serde_json::to_value(&no_obj).unwrap(), case["assessNoObjects"]);

        let with_tester_objs = vec!["resonance_tester".to_string(), "adxl345".to_string()];
        let with_tester = assess_calibration_automation(id, Some(&with_tester_objs));
        assert_eq!(serde_json::to_value(&with_tester).unwrap(), case["assessWithTester"]);

        let missing_sensor_objs = vec!["resonance_tester".to_string()];
        let missing_sensor = assess_calibration_automation(id, Some(&missing_sensor_objs));
        assert_eq!(serde_json::to_value(&missing_sensor).unwrap(), case["assessMissingSensor"]);

        let no_tester_objs = vec!["extruder".to_string(), "heater_bed".to_string()];
        let no_tester = assess_calibration_automation(id, Some(&no_tester_objs));
        assert_eq!(serde_json::to_value(&no_tester).unwrap(), case["assessNoTester"]);
    }
}

#[test]
fn line_programs_match_cross_platform_vectors() {
    let v = vectors();
    let line_programs = &v["linePrograms"];

    let options = LineProgramOptions {
        layer_height_mm: 0.2,
        line_width_mm: 0.42,
        filament_diameter_mm: 1.75,
        print_feed_mm_per_min: 3000.0,
        travel_feed_mm_per_min: 12000.0,
    };

    let line_plan: CalibrationJobPlan = serde_json::from_value(
        v["defaultPlans"].as_array().unwrap().iter().find(|p| p["id"] == "pressure-advance-line").unwrap()["plan"].clone()
    ).unwrap();
    let actual_line = pressure_advance_line_program(&line_plan, &options).unwrap();
    assert_eq!(serde_json::to_value(&actual_line).unwrap(), line_programs["line"]);

    let pattern_plan: CalibrationJobPlan = serde_json::from_value(
        v["defaultPlans"].as_array().unwrap().iter().find(|p| p["id"] == "pressure-advance-pattern").unwrap()["plan"].clone()
    ).unwrap();
    let actual_pattern = pressure_advance_line_program(&pattern_plan, &options).unwrap();
    assert_eq!(serde_json::to_value(&actual_pattern).unwrap(), line_programs["pattern"]);
}

#[test]
fn flow_patch_matching_matches_cross_platform_vectors() {
    let v = vectors();
    let flow_matching = v["flowMatching"].as_array().unwrap();
    assert_eq!(flow_matching.len(), 3);

    for case in flow_matching {
        let name = case["name"].as_str().unwrap();
        let patches: Vec<String> = case["patches"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
        let expected_mapping = &case["mapping"];

        let plan_case = if name == "Orca-LinearFlow" {
            let prereqs: CalibrationJobPrerequisites = serde_json::from_value(
                v["defaultPlans"].as_array().unwrap().iter().find(|p| p["id"] == "flow-yolo").unwrap()["plan"]["prerequisites"].clone()
            ).unwrap();
            let mut prereqs_flow_1 = prereqs.clone();
            prereqs_flow_1.filament.flow_ratio = 1.0;
            let req = create_default_calibration_job_request("flow-yolo", &prereqs_flow_1, None, None).unwrap();
            compile_calibration_job(&req, "calibration:flow-yolo:linear").unwrap()
        } else {
            let id = if name == "flowrate-test-pass1" { "flow-pass-1" } else { "flow-pass-2" };
            let p_val = v["defaultPlans"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()["plan"].clone();
            serde_json::from_value(p_val).unwrap()
        };

        let mapping = match_flow_patches(&patches, &plan_case.effects);
        let mapping_val = serde_json::to_value(&mapping).unwrap();
        assert_json_eq(&mapping_val, expected_mapping, &format!("flow matching for {name}"));
    }
}
