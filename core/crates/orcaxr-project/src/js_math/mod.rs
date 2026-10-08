//! ECMAScript `Math` exactly as the browser oracle (V8 12.4, Node 22) computes
//! it, for ports whose results are compared bit for bit with the browser.
//!
//! `sin`, `cos` and `exp` are V8's own fdlibm 5.3 port (`fdlibm`); the `libm`
//! crate follows later FreeBSD revisions and differs in the last bit for about
//! one argument in a hundred. `hypot` is V8's scaled, compensated sum, and
//! `min`/`max` keep JavaScript's NaN and signed-zero rules. The
//! `js-math-vectors.json` corpus pins all of this against V8. `convert` holds
//! the matching `Number`/`String`/`toFixed` conversions.
pub mod convert;
mod fdlibm;

pub use fdlibm::{cos, exp, sin};

/// `Math.min(a, b)`: NaN wins, and -0 is below +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN wins, and +0 is above -0.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// V8 `Math.hypot(...values)`: scale by the largest magnitude, then a
/// Kahan-compensated sum of squares. Not chained binary hypot.
pub fn hypot(values: &[f64]) -> f64 {
    let mut largest = 0.0f64;
    let mut nan = false;
    for value in values {
        if value.is_nan() {
            nan = true;
        } else if value.abs() > largest {
            largest = value.abs();
        }
    }
    if largest == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if largest == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in values {
        let n = value.abs() / largest;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * largest
}
