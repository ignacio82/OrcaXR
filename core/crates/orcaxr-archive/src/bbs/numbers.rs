//! Browser-compatible numeric projection for BBS XML. Mesh coordinates are
//! float32; canonical transform/layer values retain double precision. These
//! fixed-size results never allocate XML or one String per mesh coordinate.
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::Transform;
use std::{fmt, io};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    NonFinite,
    Rotation,
    Formatting,
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "bbs_number_{self:?}")
    }
}
impl std::error::Error for Error {}

/// Owned immutable stack text. Only this module can create/mutate it; no public
/// Write implementation can inject invalid bytes into a formatted result.
#[derive(Clone)]
pub struct NumericText(Buffer);
impl NumericText {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}
#[derive(Clone)]
struct Buffer {
    bytes: [u8; 64],
    len: usize,
}
impl Buffer {
    fn new() -> Self {
        Self {
            bytes: [0; 64],
            len: 0,
        }
    }
    pub fn as_str(&self) -> &str {
        // Both writers below accept only formatter-generated ASCII.
        std::str::from_utf8(self.as_bytes()).expect("numeric ASCII")
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
    fn append(&mut self, bytes: &[u8]) -> bool {
        let Some(end) = self
            .len
            .checked_add(bytes.len())
            .filter(|&n| n <= self.bytes.len())
        else {
            return false;
        };
        self.bytes[self.len..end].copy_from_slice(bytes);
        self.len = end;
        true
    }
}
impl fmt::Write for Buffer {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        if self.append(text.as_bytes()) {
            Ok(())
        } else {
            Err(fmt::Error)
        }
    }
}
impl io::Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.append(bytes) {
            Ok(bytes.len())
        } else {
            Err(io::ErrorKind::WriteZero.into())
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl fmt::Debug for NumericText {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.as_str().fmt(out)
    }
}

/// ECMAScript String(number), including its exponent thresholds and -0 -> 0.
pub fn number(value: f64) -> Result<NumericText, Error> {
    if !value.is_finite() {
        return Err(Error::NonFinite);
    }
    let mut result = Buffer::new();
    Value::Number(value)
        .write_canonical(&mut result)
        .map_err(|_| Error::Formatting)?;
    Ok(NumericText(result))
}

/// ECMAScript toFixed(6), including ties away from zero, signed rounded zero,
/// and the ordinary number representation at magnitudes of at least 10^21.
pub fn fixed6(value: f64) -> Result<NumericText, Error> {
    fixed(value, 6)
}

/// ECMAScript toFixed(4), used by BBS mixed gradients and surface offsets.
pub fn fixed4(value: f64) -> Result<NumericText, Error> {
    fixed(value, 4)
}

fn fixed(value: f64, decimals: u32) -> Result<NumericText, Error> {
    use fmt::Write;
    if !value.is_finite() {
        return Err(Error::NonFinite);
    }
    if value.abs() >= 1e21 {
        return number(value);
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1 << 52 };
    // Exact |value| * 10^decimals (four or six). Below 10^21 a rounding carry
    // fit in u128. Multiplication in f64 would round before the required step.
    let scale = 10u128.pow(decimals);
    let numerator = u128::from(mantissa) * scale;
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let rounded = if shift >= 0 {
        numerator << shift
    } else {
        let right = (-shift) as u32;
        if right >= 128 {
            0
        } else {
            (numerator + (1u128 << (right - 1))) >> right
        }
    };
    let mut result = Buffer::new();
    write!(
        &mut result,
        "{}{}.{:0width$}",
        if value < 0.0 { "-" } else { "" },
        rounded / scale,
        rounded % scale,
        width = decimals as usize
    )
    .map_err(|_| Error::Formatting)?;
    Ok(NumericText(result))
}

/// Emboss persistence applies Number(value.toFixed(6)) before String(number).
pub fn emboss(value: f64) -> Result<NumericText, Error> {
    let fixed = fixed6(value)?;
    number(fixed.as_str().parse().map_err(|_| Error::Formatting)?)
}

/// Exact halfway test for rounding a positive binary32 to a decimal coefficient
/// times 10^exponent. Rust formats ties to even; JS toPrecision chooses the
/// larger magnitude. Compare odd significands without floating point rounding.
fn halfway(value: f32, coefficient: u64, exponent: i32) -> bool {
    let bits = value.to_bits();
    let field = (bits >> 23) & 255;
    let mut significand = bits & 0x7f_ffff;
    let mut binary_exponent = if field == 0 {
        -149
    } else {
        significand |= 1 << 23;
        field as i32 - 150
    };
    let trailing = significand.trailing_zeros();
    significand >>= trailing;
    binary_exponent += trailing as i32;
    if binary_exponent != exponent - 1 {
        return false;
    }
    let middle = 2 * u128::from(coefficient) + 1;
    if exponent >= 0 {
        // exponent <= 38; at most nine coefficient digits, fits in u128.
        u128::from(significand) == middle * 5_u128.pow(exponent as u32)
    } else {
        // 5^14 already exceeds the largest possible midpoint coefficient.
        exponent >= -13 && u128::from(significand) * 5_u128.pow((-exponent) as u32) == middle
    }
}

/// Exact production-browser policy: try decimal precisions 1..9, choosing the
/// first rounded candidate that converts back to this float32, then print that
/// candidate as an ECMAScript double. A generic shortest-f32 formatter is not
/// equivalent at all power-of-two boundaries.
pub fn mesh_coordinate(value: f32) -> Result<NumericText, Error> {
    use fmt::Write;
    if !value.is_finite() {
        return Err(Error::NonFinite);
    }
    if value == 0.0 {
        return number(0.0);
    }
    let magnitude = value.abs();
    // No decimal with fewer significant digits than Rust's shortest float32
    // can round-trip. Use that length only as a lower bound: its digits are NOT
    // the browser's rounded candidate (see the power-of-two regression cases).
    let mut shortest = Buffer::new();
    write!(&mut shortest, "{magnitude:e}").map_err(|_| Error::Formatting)?;
    let minimum = shortest
        .as_str()
        .split_once('e')
        .ok_or(Error::Formatting)?
        .0
        .bytes()
        .filter(u8::is_ascii_digit)
        .count();
    for precision in minimum..=9 {
        let mut scientific = Buffer::new();
        write!(
            &mut scientific,
            "{:.*e}",
            precision - 1,
            f64::from(magnitude)
        )
        .map_err(|_| Error::Formatting)?;
        let (mantissa, scale) = scientific
            .as_str()
            .split_once('e')
            .ok_or(Error::Formatting)?;
        let scale: i32 = scale.parse().map_err(|_| Error::Formatting)?;
        let mut coefficient = 0_u64;
        for b in mantissa.bytes().filter(|&b| b != b'.') {
            coefficient = coefficient * 10 + u64::from(b - b'0');
        }
        let exponent = scale - precision as i32 + 1;
        if halfway(magnitude, coefficient, exponent) {
            coefficient += 1;
        }
        let mut candidate = Buffer::new();
        write!(&mut candidate, "{coefficient}e{exponent}").map_err(|_| Error::Formatting)?;
        let candidate: f64 = candidate.as_str().parse().map_err(|_| Error::Formatting)?;
        if candidate as f32 == magnitude {
            return number(if value.is_sign_negative() {
                -candidate
            } else {
                candidate
            });
        }
    }
    Err(Error::Formatting)
}

/// BBS row-major 4x4 matrix. Translation offsets are plate origins in mm.
/// Invalid or overflowing inputs never produce partially valid transforms.
pub fn transform_matrix(transform: &Transform, offset: [f64; 2]) -> Result<[f64; 16], Error> {
    let q = transform.rotation.map(|n| n.get());
    // Pinned V8 four-argument Math.hypot, not chained binary hypot. Preserve
    // scaled compensated addition and subsequent operation order exactly.
    let max = q.iter().map(|v| v.abs()).fold(0.0, f64::max);
    if max == 0.0 || !max.is_finite() {
        return Err(Error::Rotation);
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in q {
        let n = value.abs() / max;
        let term = n * n - compensation;
        let next = sum + term;
        compensation = (next - sum) - term;
        sum = next;
    }
    let norm = sum.sqrt() * max;
    if norm == 0.0 || !norm.is_finite() {
        return Err(Error::Rotation);
    }
    let [x, y, z, w] = q.map(|n| n / norm);
    let [sx, sy, sz] = transform.scale.map(|n| n.get());
    let [tx, ty, tz] = transform.translation_mm.map(|n| n.get());
    let result = [
        (1.0 - 2.0 * (y * y + z * z)) * sx,
        2.0 * (x * y - z * w) * sy,
        2.0 * (x * z + y * w) * sz,
        tx + offset[0],
        2.0 * (x * y + z * w) * sx,
        (1.0 - 2.0 * (x * x + z * z)) * sy,
        2.0 * (y * z - x * w) * sz,
        ty + offset[1],
        2.0 * (x * z - y * w) * sx,
        2.0 * (y * z + x * w) * sy,
        (1.0 - 2.0 * (x * x + y * y)) * sz,
        tz,
        0.0,
        0.0,
        0.0,
        1.0,
    ];
    if result.iter().any(|n| !n.is_finite()) {
        return Err(Error::NonFinite);
    }
    Ok(result)
}

/// 3MF's column-wise 3x4 ordering, distinct from BBS metadata's row-major 4x4.
pub fn transform_3mf(transform: &Transform, offset: [f64; 2]) -> Result<[f64; 12], Error> {
    let matrix = transform_matrix(transform, offset)?;
    Ok([0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11].map(|i| matrix[i]))
}
