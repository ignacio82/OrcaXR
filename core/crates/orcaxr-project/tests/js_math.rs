//! `js_math` against V8 (`js-math-vectors.json`): sin/cos through every glibc
//! range-reduction branch, fdlibm exp and acos and V8's hypot, compared as bit
//! patterns.
use orcaxr_project::js_math;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/js-math-vectors.json"
    ))
    .unwrap()
}
fn f(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
}
/// Equal bits, except that JavaScript has a single NaN.
fn same(actual: f64, expected: f64) -> bool {
    actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan())
}

#[test]
fn reference_sources_are_current() {
    let corpus = corpus();
    for source in corpus["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap()
        );
    }
}

#[test]
fn sin_and_cos_match_v8_bit_for_bit() {
    let corpus = corpus();
    let rows = corpus["trig"].as_array().unwrap();
    assert!(rows.len() > 10_000);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::sin(x), f(&row[1])), "sin({x:e})");
        assert!(same(js_math::cos(x), f(&row[2])), "cos({x:e})");
    }
}

#[test]
fn exp_matches_v8_bit_for_bit() {
    for row in corpus()["exp"].as_array().unwrap() {
        let x = f(&row[0]);
        assert!(same(js_math::exp(x), f(&row[1])), "exp({x:e})");
    }
}

#[test]
fn acos_matches_v8_bit_for_bit() {
    let rows = corpus()["acos"].as_array().unwrap().clone();
    assert!(rows.len() > 3_000);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::acos(x), f(&row[1])), "acos({x:e})");
    }
}

#[test]
fn tan_matches_v8_bit_for_bit() {
    let rows = corpus()["tan"].as_array().unwrap().clone();
    assert!(rows.len() > 9_000);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::tan(x), f(&row[1])), "tan({x:e})");
    }
}

#[test]
fn round_matches_v8_bit_for_bit() {
    let rows = corpus()["round"].as_array().unwrap().clone();
    assert!(rows.len() > 1_500);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::round(x), f(&row[1])), "round({x:e})");
    }
}

#[test]
fn hypot_matches_v8_bit_for_bit() {
    for row in corpus()["hypot"].as_array().unwrap() {
        let args: Vec<f64> = row[0].as_array().unwrap().iter().map(f).collect();
        assert!(same(js_math::hypot(&args), f(&row[1])), "hypot({args:?})");
    }
}

#[test]
fn min_and_max_keep_javascript_nan_and_signed_zero_rules() {
    assert!(js_math::min(f64::NAN, 1.0).is_nan() && js_math::max(1.0, f64::NAN).is_nan());
    assert!(
        js_math::min(0.0, -0.0).is_sign_negative() && js_math::min(-0.0, 0.0).is_sign_negative()
    );
    assert!(
        js_math::max(0.0, -0.0).is_sign_positive() && js_math::max(-0.0, 0.0).is_sign_positive()
    );
    assert_eq!(js_math::min(2.0, -3.0), -3.0);
    assert_eq!(js_math::max(2.0, -3.0), 2.0);
}
