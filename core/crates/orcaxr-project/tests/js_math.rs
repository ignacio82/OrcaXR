//! `js_math` against V8 (`js-math-vectors.json`): sin/cos through every glibc
//! range-reduction branch, fdlibm exp, acos, asin and atan2 and V8's hypot, compared as bit
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

#[test]
fn asin_matches_v8_bit_for_bit() {
    let rows = corpus()["asin"].as_array().unwrap().clone();
    assert!(rows.len() > 3_000);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::asin(x), f(&row[1])), "asin({x:e})");
    }
}

#[test]
fn atan2_matches_v8_bit_for_bit() {
    let rows = corpus()["atan2"].as_array().unwrap().clone();
    assert!(rows.len() > 3_000);
    for row in rows {
        let (y, x) = (f(&row[0][0]), f(&row[0][1]));
        assert!(
            same(js_math::atan2(y, x), f(&row[1])),
            "atan2({y:e}, {x:e})"
        );
    }
}

#[test]
fn pow_matches_v8_bit_for_bit() {
    let rows = corpus()["pow"].as_array().unwrap().clone();
    assert!(rows.len() > 7_000);
    let mut wrong = Vec::new();
    for row in rows {
        let (x, y) = (f(&row[0][0]), f(&row[0][1]));
        let actual = js_math::pow(x, y);
        if !same(actual, f(&row[1])) {
            wrong.push(format!(
                "pow({x:e}, {y:e}) = {actual:e}, V8 {:e}",
                f(&row[1])
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} differ: {:?}",
        wrong.len(),
        &wrong[..wrong.len().min(5)]
    );
}

#[test]
fn sort_leaves_the_order_v8_leaves_with_an_intransitive_comparator() {
    let rows = corpus()["sort"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 260);
    let compare = |left: &(f64, usize), right: &(f64, usize)| {
        if left.0 + 1e-6 < right.0 {
            -1.0
        } else if right.0 + 1e-6 < left.0 {
            1.0
        } else {
            left.1 as f64 - right.1 as f64
        }
    };
    // (Rust's own sort refuses such a comparator outright.)
    for row in rows {
        let mut entries: Vec<(f64, usize)> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, value)| (f(value), index))
            .collect();
        js_math::sort::sort_by(&mut entries, compare);
        let order: Vec<u64> = entries.iter().map(|entry| entry.1 as u64).collect();
        let expected: Vec<u64> = row[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(order, expected, "length {}", order.len());
    }
}

#[test]
fn cbrt_matches_v8_bit_for_bit() {
    let rows = corpus()["cbrt"].as_array().unwrap().clone();
    assert!(rows.len() > 3_000);
    for row in rows {
        let x = f(&row[0]);
        assert!(same(js_math::cbrt(x), f(&row[1])), "cbrt({x:e})");
    }
}
