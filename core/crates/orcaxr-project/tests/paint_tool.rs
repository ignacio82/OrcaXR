//! The painter's settings and paint colours against the browser: every
//! recorded sample request answers the browser's sample or refusal byte for
//! byte, every colour request the browser's colours, and every malformed
//! request is refused.
use orcaxr_project::facets::{paint_facets, paint_tool};

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/paint-tool-vectors.json"
    ))
    .unwrap()
}

#[test]
fn painter_samples_match_the_browser() {
    let f = corpus();
    let mut answered = 0;
    for section in ["samples", "errors"] {
        for case in f[section].as_array().unwrap() {
            assert_eq!(
                paint_tool::sample_json(case["request"].as_str().unwrap()).as_deref(),
                Ok(case["reply"].as_str().unwrap()),
                "{}",
                case["name"]
            );
            answered += 1;
        }
    }
    for request in f["malformed"].as_array().unwrap() {
        assert_eq!(
            paint_tool::sample_json(request.as_str().unwrap()),
            Err(paint_tool::INVALID_REQUEST),
            "{request}"
        );
    }
    assert_eq!(answered, 427);
    assert_eq!(f["errors"].as_array().unwrap().len(), 10);
    assert_eq!(f["malformed"].as_array().unwrap().len(), 29);
}

#[test]
fn paint_colours_match_the_browser() {
    let f = corpus();
    for case in f["colors"].as_array().unwrap() {
        assert_eq!(
            paint_facets::colors_json(case["request"].as_str().unwrap()).as_deref(),
            Ok(case["reply"].as_str().unwrap()),
            "{}",
            case["name"]
        );
    }
    for request in f["colorRefusals"].as_array().unwrap() {
        assert_eq!(
            paint_facets::colors_json(request.as_str().unwrap()),
            Err(paint_tool::INVALID_REQUEST),
            "{request}"
        );
    }
    assert_eq!(f["colors"].as_array().unwrap().len(), 775);
}

#[test]
fn placements_measure_the_brush_on_the_bed() {
    use paint_tool::{CanonicalTransform, Placement, place};
    let close = |values: &[f64], expected: [f64; 3]| {
        values
            .iter()
            .zip(expected)
            .all(|(value, expected)| (value - expected).abs() < 1e-12)
    };
    let turn = |axis: [f64; 3], angle: f64| {
        let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
        let s = (angle / 2.0).sin() / length;
        [axis[0] * s, axis[1] * s, axis[2] * s, (angle / 2.0).cos()]
    };
    // A uniform 200% instance turned about Z: the factors agree, so the
    // selector divides the radius by 2 in the part; the band starts at the
    // hit's bed Z.
    let uniform = Placement {
        instance: CanonicalTransform {
            translation_mm: [10.0, 0.0, 1.0],
            rotation: turn([0.0, 0.0, 1.0], 0.6),
            scale: [2.0; 3],
        },
        volume: CanonicalTransform::IDENTITY,
    };
    let placed = place(&uniform, [1.0, 2.0, 3.0]).unwrap();
    assert!(close(&placed.transform.scaling_factors, [2.0; 3]));
    assert_eq!(placed.plate_z_mm, 7.0);
    assert_eq!(placed.transform.translation, vec![10.0, 0.0, 1.0]);
    // A part turned inside a (2, 1, 1) instance so its stretch runs along the
    // part's (1, 1, 1) diagonal: the diagonal of Orca's polar scale factor
    // reads (4/3, 4/3, 4/3) there, which would pass for a uniform scale, but
    // the singular values do not, so the selector works on the bed.
    let diagonal = Placement {
        instance: CanonicalTransform {
            scale: [2.0, 1.0, 1.0],
            ..CanonicalTransform::IDENTITY
        },
        volume: CanonicalTransform {
            rotation: turn([0.0, 1.0, -1.0], (1.0 / 3f64.sqrt()).acos()),
            ..CanonicalTransform::IDENTITY
        },
    };
    let placed = place(&diagonal, [0.0; 3]).unwrap();
    assert!(close(&placed.transform.scaling_factors, [2.0, 1.0, 1.0]));
    // Mirrored, the scale is still the same every way.
    let mirrored = Placement {
        instance: CanonicalTransform {
            scale: [-1.5, 1.5, 1.5],
            ..CanonicalTransform::IDENTITY
        },
        volume: CanonicalTransform::IDENTITY,
    };
    let placed = place(&mirrored, [0.0, 0.0, -2.0]).unwrap();
    assert!(close(&placed.transform.scaling_factors, [1.5; 3]));
    assert_eq!(placed.plate_z_mm, -3.0);
    // A flat part cannot place a brush.
    let flat = Placement {
        instance: CanonicalTransform {
            scale: [1.0, 0.0, 1.0],
            ..CanonicalTransform::IDENTITY
        },
        volume: CanonicalTransform::IDENTITY,
    };
    assert_eq!(place(&flat, [0.0; 3]), None);
}
