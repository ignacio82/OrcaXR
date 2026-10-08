use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::AssetRepository,
    filaments::compatibility::{Category, Decision, inspect, material_category},
    ids::*,
    mesh,
    model::*,
    slicing::preflight::*,
    validation::*,
};
use serde_json::Value as Json;
use std::cell::Cell;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-preflight-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn limits() -> Limits {
    Limits {
        mesh: mesh::Limits {
            asset_bytes: 1 << 24,
            vertices: 1 << 20,
            indices: 1 << 22,
        },
        assets: 16,
        vertex_visits: 1 << 20,
    }
}
fn number(value: &Json, key: &str) -> Option<f64> {
    value.get(key).and_then(Json::as_f64)
}
/// The browser's `SlicePreflightConstraints`; `null` slots are absent tools.
fn constraints(case: &Json) -> Constraints {
    let Some(text) = case["constraintsJson"].as_str() else {
        return Constraints::default();
    };
    let v: Json = serde_json::from_str(text).unwrap();
    Constraints {
        build_volume: v.get("buildVolume").map(|b| BuildVolume {
            min_x_mm: number(b, "minXmm").unwrap(),
            max_x_mm: number(b, "maxXmm").unwrap(),
            min_y_mm: number(b, "minYmm").unwrap(),
            max_y_mm: number(b, "maxYmm").unwrap(),
            min_z_mm: number(b, "minZmm"),
            max_z_mm: number(b, "maxZmm").unwrap(),
        }),
        tools: v.get("tools").map_or_else(Vec::new, |tools| {
            tools
                .as_array()
                .unwrap()
                .iter()
                .map(|t| {
                    (!t.is_null()).then(|| ToolConstraints {
                        nozzle_diameter_mm: number(t, "nozzleDiameterMm"),
                        supported_materials: t.get("supportedMaterials").map(|list| {
                            list.as_array()
                                .unwrap()
                                .iter()
                                .map(|m| Text::from_utf8(m.as_str().unwrap()))
                                .collect()
                        }),
                        min_hotend_temperature_c: number(t, "minHotendTemperatureC"),
                        max_hotend_temperature_c: number(t, "maxHotendTemperatureC"),
                    })
                })
                .collect()
        }),
        printer: v.get("printer").map(|p| PrinterCapability {
            physical_tool_count: number(p, "physicalToolCount").unwrap(),
            max_total_filaments: number(p, "maxTotalFilaments"),
        }),
        require_profile_attestation: v
            .get("requireProfileAttestation")
            .is_some_and(|b| b.as_bool().unwrap()),
        custom_gcode_byte_limit: number(&v, "customGcodeByteLimit"),
        geometry_tolerance_mm: number(&v, "geometryToleranceMm"),
    }
}
struct Case {
    name: String,
    data: ProjectData,
    assets: AssetRepository,
    plate: PlateId,
    constraints: Constraints,
}
fn case(json: &Json) -> Case {
    let mut assets = AssetRepository::new();
    for asset in json["assets"].as_array().unwrap() {
        let bytes: Vec<u8> = asset["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes,
            )
            .unwrap();
    }
    Case {
        name: json["name"].as_str().unwrap().to_owned(),
        data: ProjectData::new(
            ProjectState::from_value(parse(json["stateJson"].as_str().unwrap()).unwrap()).unwrap(),
        )
        .unwrap(),
        assets,
        plate: PlateId::try_from_str(json["plateId"].as_str().unwrap()).unwrap(),
        constraints: constraints(json),
    }
}
fn canonical(result: &Preflight) -> String {
    let mut bytes = Vec::new();
    result.to_value().write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn preflight_matches_the_browser_reference_issue_for_issue() {
    let f = corpus();
    let mut codes = std::collections::BTreeSet::new();
    let (mut results, mut refusals) = (0, 0);
    for json in f["cases"].as_array().unwrap() {
        let c = case(json);
        let snapshot = c.assets.capture_internal();
        let result = preflight_candidate(
            &c.data,
            &mut utc(),
            &snapshot,
            &c.plate,
            &c.constraints,
            limits(),
            || false,
        );
        if let Some(message) = json["error"].as_str() {
            match result {
                Err(Error::Constraints(error)) => {
                    assert_eq!(error.to_string(), message, "{}", c.name)
                }
                other => panic!("{}: expected a constraint refusal, got {other:?}", c.name),
            }
            refusals += 1;
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("{}: {e}", c.name));
        assert_eq!(
            canonical(&result),
            json["resultJson"].as_str().unwrap(),
            "{}",
            c.name
        );
        codes.extend(result.issues.iter().map(|i| i.code.as_str()));
        // An admitted project reuses its report and reaches the same result.
        if let Ok(validated) = ValidatedProject::new(c.data.clone(), &mut utc()) {
            let again = preflight(
                &validated,
                &snapshot,
                &c.plate,
                &c.constraints,
                limits(),
                || false,
            )
            .unwrap();
            assert_eq!(again, result, "{}", c.name);
        }
        results += 1;
    }
    assert_eq!((results, refusals), (64, 12));
    assert_eq!(
        serde_json::to_value(&codes).unwrap(),
        f["codes"],
        "every code is replayed"
    );
    assert_eq!(
        Code::ALL
            .iter()
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .len(),
        codes.len()
    );
}

#[test]
fn host_budgets_and_cancellation_refuse_instead_of_reporting() {
    let f = corpus();
    let json = f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "outside-sinking-overlap")
        .unwrap();
    let c = case(json);
    let snapshot = c.assets.capture_internal();
    let run = |limits: Limits, cancel_after: usize| {
        let calls = Cell::new(0);
        preflight_candidate(
            &c.data,
            &mut utc(),
            &snapshot,
            &c.plate,
            &c.constraints,
            limits,
            || {
                calls.set(calls.get() + 1);
                calls.get() > cancel_after
            },
        )
    };
    assert!(run(limits(), usize::MAX).is_ok());
    for narrowed in [
        Limits {
            assets: 0,
            ..limits()
        },
        Limits {
            vertex_visits: 11,
            ..limits()
        },
        Limits {
            mesh: mesh::Limits {
                asset_bytes: 35,
                ..limits().mesh
            },
            ..limits()
        },
    ] {
        assert_eq!(run(narrowed, usize::MAX), Err(Error::Limits));
    }
    // Four instances of one three-vertex mesh: twelve visits fit exactly.
    assert!(
        run(
            Limits {
                vertex_visits: 12,
                assets: 1,
                ..limits()
            },
            usize::MAX
        )
        .is_ok()
    );
    for after in 0..4 {
        assert_eq!(run(limits(), after), Err(Error::Cancelled), "{after}");
    }
}

#[test]
fn constraints_refuse_non_finite_values_json_cannot_carry() {
    let volume = BuildVolume {
        min_x_mm: 0.0,
        max_x_mm: 1.0,
        min_y_mm: 0.0,
        max_y_mm: 1.0,
        min_z_mm: None,
        max_z_mm: 1.0,
    };
    let refuse = |c: Constraints| c.validate().unwrap_err().to_string();
    assert!(
        Constraints {
            build_volume: Some(volume),
            ..Default::default()
        }
        .validate()
        .is_ok()
    );
    for broken in [
        BuildVolume {
            max_x_mm: f64::INFINITY,
            ..volume
        },
        BuildVolume {
            min_z_mm: Some(f64::NAN),
            ..volume
        },
        BuildVolume {
            min_z_mm: Some(1.0),
            ..volume
        },
    ] {
        assert_eq!(
            refuse(Constraints {
                build_volume: Some(broken),
                ..Default::default()
            }),
            "Build volume must contain finite increasing axis bounds"
        );
    }
    assert_eq!(
        refuse(Constraints {
            geometry_tolerance_mm: Some(f64::NAN),
            ..Default::default()
        }),
        "Geometry tolerance must be finite and non-negative"
    );
    assert_eq!(
        refuse(Constraints {
            tools: vec![
                None,
                Some(ToolConstraints {
                    nozzle_diameter_mm: Some(f64::INFINITY),
                    ..Default::default()
                })
            ],
            ..Default::default()
        }),
        "Tool 2 nozzle diameter must be finite and positive"
    );
    assert_eq!(
        refuse(Constraints {
            tools: vec![Some(ToolConstraints {
                max_hotend_temperature_c: Some(f64::NAN),
                ..Default::default()
            })],
            ..Default::default()
        }),
        "Tool 1 hotend temperature range is invalid"
    );
    assert_eq!(
        refuse(Constraints {
            printer: Some(PrinterCapability {
                physical_tool_count: 2.0,
                max_total_filaments: Some(f64::INFINITY),
            }),
            ..Default::default()
        }),
        "Printer filament ceiling must be a positive integer no greater than 64"
    );
}

#[test]
fn compatibility_reports_the_first_refusal_in_component_order() {
    let filament = |id: &str, material: &str| {
        let value = serde_json::json!({
            "id": id, "name": format!("{material} spool"), "toolId": 0,
            "material": material, "color": "#000000", "config": {}, "enabled": true,
        });
        std::sync::Arc::new(
            PhysicalFilament::from_value(parse(&value.to_string()).unwrap()).unwrap(),
        )
    };
    let library = [
        filament("import:f:pla", "PLA"),
        filament("import:f:pc", " pc"),
        filament("import:f:abs", "ABS"),
        filament("import:f:wood", "Wood"),
    ];
    let id = |s: &str| PhysicalFilamentId::try_from_str(s).unwrap();
    assert_eq!(
        inspect(
            &library,
            &[id("import:f:pla"), id("import:f:pc"), id("import:f:pla")]
        ),
        Decision::Allowed(vec![Category::Pla, Category::Pc])
    );
    let Decision::Refused {
        reason,
        first,
        second,
    } = inspect(
        &library,
        &[id("import:f:pc"), id("import:f:pla"), id("import:f:abs")],
    )
    else {
        panic!()
    };
    assert_eq!(
        String::from_utf16(reason.units()).unwrap(),
        "PLA and ABS cannot be mixed by the pinned Snapmaker compatibility matrix."
    );
    assert_eq!(
        (first, second),
        (id("import:f:pla"), Some(id("import:f:abs")))
    );
    let Decision::Refused { reason, .. } =
        inspect(&library, &[id("import:f:missing"), id("import:f:wood")])
    else {
        panic!()
    };
    assert_eq!(
        String::from_utf16(reason.units()).unwrap(),
        "Physical component import:f:missing is missing."
    );
    assert_eq!(
        material_category(&"pva".encode_utf16().collect::<Vec<_>>()),
        Some(Category::Support)
    );
}
