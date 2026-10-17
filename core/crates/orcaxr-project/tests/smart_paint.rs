//! Smart Paint proposal parsing, geometric projection, and commit planning tests (P4.9).
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::smart_paint::{
    build_smart_paint_batch, describe_geometry, parse_proposal, project_proposal,
    AI_PAINT_MAX_REGIONS, SmartPaintErrorCode, SmartPaintRegionAssignment,
};

/// 10 mm cube with 12 triangles.
fn cube_mesh() -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let s = 10.0;
    let vertices = vec![
        [0.0, 0.0, 0.0],
        [s, 0.0, 0.0],
        [s, s, 0.0],
        [0.0, s, 0.0],
        [0.0, 0.0, s],
        [s, 0.0, s],
        [s, s, s],
        [0.0, s, s],
    ];
    // -Z bottom: [0, 2, 1], [0, 3, 2]
    // +Z top: [4, 5, 6], [4, 6, 7]
    // -Y: [0, 1, 5], [0, 5, 4]
    // +Y: [3, 7, 6], [3, 6, 2]
    // -X: [0, 4, 7], [0, 7, 3]
    // +X: [1, 2, 6], [1, 6, 5]
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
    ];
    (vertices, triangles)
}

#[test]
fn parses_only_bounded_fully_stated_proposals() {
    let valid_json = r#"{
        "schemaVersion": 1,
        "regions": [
            { "label": "Top face", "confidence": 0.9, "shape": { "kind": "direction", "axis": [0, 0, 1], "maxAngleDeg": 30 } },
            { "label": "Bottom face", "confidence": 0.5, "shape": { "kind": "direction", "axis": [0, 0, -1], "maxAngleDeg": 30 } }
        ]
    }"#;

    let parsed = parse_proposal(valid_json).expect("valid proposal must parse");
    assert_eq!(parsed.regions.len(), 2);
    assert_eq!(parsed.regions[0].id, "ai-region-1");
    assert_eq!(parsed.regions[1].id, "ai-region-2");
    assert_eq!(parsed.regions[0].label, "Top face");
    assert_eq!(parsed.regions[0].confidence, 0.9);

    // Error case assertions matching TypeScript reference test:
    let rejects = vec![
        ("not-json", SmartPaintErrorCode::MalformedProposal),
        (
            r#"{"schemaVersion": 2, "regions": []}"#,
            SmartPaintErrorCode::UnsupportedVersion,
        ),
        (
            r#"{"schemaVersion": 1, "regions": []}"#,
            SmartPaintErrorCode::EmptyProposal,
        ),
        (
            r#"{"schemaVersion": 1, "regions": [{"confidence": 0.5, "shape": {"kind": "box", "min": [0,0,0], "max": [1,1,1]}}]}"#,
            SmartPaintErrorCode::MalformedRegion,
        ),
        (
            r#"{"schemaVersion": 1, "regions": [{"label": "x", "confidence": 1.5, "shape": {"kind": "box", "min": [0,0,0], "max": [1,1,1]}}]}"#,
            SmartPaintErrorCode::MalformedRegion,
        ),
        (
            r#"{"schemaVersion": 1, "regions": [{"label": "x", "confidence": 1.0, "shape": {"kind": "direction", "axis": [0, 0, 0], "maxAngleDeg": 10}}]}"#,
            SmartPaintErrorCode::MalformedRegion,
        ),
        (
            r#"{"schemaVersion": 1, "regions": [{"label": "x", "confidence": 1.0, "shape": {"kind": "box", "min": [0.6, 0, 0], "max": [0.4, 1, 1]}}]}"#,
            SmartPaintErrorCode::MalformedRegion,
        ),
        (
            r#"{"schemaVersion": 1, "regions": [{"label": "x", "confidence": 1.0, "shape": {"kind": "polygon", "points": [[0, 0]]}}]}"#,
            SmartPaintErrorCode::MalformedRegion,
        ),
    ];

    for (raw, expected_code) in rejects {
        let err = parse_proposal(raw).expect_err(&format!("expected error {expected_code:?}"));
        assert_eq!(err.code, expected_code, "failed on input: {raw}");
    }

    // Too many regions
    let many_regions = vec![
        r#"{"label": "r", "confidence": 0.5, "shape": {"kind": "box", "min": [0,0,0], "max": [1,1,1]}}"#;
        AI_PAINT_MAX_REGIONS + 1
    ];
    let too_many_json = format!(
        r#"{{"schemaVersion": 1, "regions": [{}]}}"#,
        many_regions.join(",")
    );
    let err = parse_proposal(&too_many_json).expect_err("should reject > 32 regions");
    assert_eq!(err.code, SmartPaintErrorCode::TooManyRegions);
}

#[test]
fn projects_regions_onto_exact_facets_with_later_overwriting_earlier() {
    let (vertices, triangles) = cube_mesh();

    let proposal_json = r#"{
        "schemaVersion": 1,
        "regions": [
            { "label": "Whole model", "confidence": 0.4, "shape": { "kind": "box", "min": [0, 0, 0], "max": [1, 1, 1] } },
            { "label": "Top face", "confidence": 1.0, "shape": { "kind": "direction", "axis": [0, 0, 1], "maxAngleDeg": 5 } }
        ]
    }"#;

    let proposal = parse_proposal(proposal_json).unwrap();
    let projection = project_proposal(&proposal, &vertices, &triangles, "vol_test", 0)
        .expect("projection must succeed");

    assert_eq!(projection.triangle_count, 12);
    assert_eq!(projection.coverage, 1.0, "box claims every facet");
    assert_eq!(projection.unassigned_triangle_count, 0);

    // The +Z pair (triangles 2 and 3) wins over the box
    assert_eq!(projection.regions[1].triangle_indices, vec![2, 3]);
    assert_eq!(projection.regions[0].triangle_indices.len(), 10);
    assert!(!projection.regions[0].triangle_indices.contains(&2));
    assert!(!projection.regions[0].triangle_indices.contains(&3));

    // Coverage-weighted confidence: (10 * 0.4 + 2 * 1.0) / 12 = 6 / 12 = 0.5
    let expected_conf = (10.0 * 0.4 + 2.0 * 1.0) / 12.0;
    assert!((projection.confidence - expected_conf).abs() < 1e-12);
}

#[test]
fn describes_geometry_dimensions_and_facet_count() {
    let (vertices, triangles) = cube_mesh();
    let desc = describe_geometry(&vertices, &triangles).expect("descriptor");
    assert_eq!(desc["triangleCount"], 12);
    let extent = desc["extentMm"].as_array().expect("extent array");
    assert_eq!(extent.len(), 3);
    assert_eq!(extent[0], 10.0);
    assert_eq!(extent[1], 10.0);
    assert_eq!(extent[2], 10.0);
}

#[test]
fn builds_smart_paint_batch_intent() {
    let (vertices, triangles) = cube_mesh();
    let proposal_json = r#"{
        "schemaVersion": 1,
        "regions": [
            { "label": "Body", "confidence": 0.8, "shape": { "kind": "box", "min": [0, 0, 0], "max": [1, 1, 1] } },
            { "label": "Top", "confidence": 0.95, "shape": { "kind": "direction", "axis": [0, 0, 1], "maxAngleDeg": 10 } }
        ]
    }"#;

    let proposal = parse_proposal(proposal_json).unwrap();
    let projection = project_proposal(&proposal, &vertices, &triangles, "vol_1", 1).unwrap();

    let guard = wire::FacetGuard {
        revision: 42,
        hash: "hash123".encode_utf16().collect(),
        volume_id: "vol_1".encode_utf16().collect(),
        topology_revision: 1,
        triangle_count: 12,
    };

    let assignments = vec![
        SmartPaintRegionAssignment {
            region_id: "ai-region-1".to_string(),
            value: Some("tool_1".to_string()),
            excluded_triangles: vec![],
        },
        SmartPaintRegionAssignment {
            region_id: "ai-region-2".to_string(),
            value: Some("tool_2".to_string()),
            excluded_triangles: vec![],
        },
    ];

    let batch = build_smart_paint_batch(guard, "color", &projection, &assignments)
        .expect("batch must build");

    assert_eq!(batch.version, 1);
    assert_eq!(batch.commands.len(), 2);

    let batch_label = String::from_utf16(&batch.label).unwrap();
    assert_eq!(batch_label, "Smart Paint color facets");

    // Second stroke is for Top (triangles 2 and 3)
    if let wire::Command::FacetStroke(stroke) = &batch.commands[1] {
        assert_eq!(stroke.channel, wire::FacetChannelName::Color);
        if let wire::FacetStrokeOperationInput::Paint(paint) = &stroke.operation {
            assert_eq!(paint.ranges.len(), 1);
            assert_eq!(paint.ranges[0].start, 2);
            assert_eq!(paint.ranges[0].end_exclusive, 4);
            if let wire::PaintValueInput::Text(t) = &paint.value {
                assert_eq!(String::from_utf16(t).unwrap(), "tool_2");
            } else {
                panic!("expected Text paint value");
            }
        } else {
            panic!("expected Paint operation");
        }
    } else {
        panic!("expected FacetStroke command");
    }
}
