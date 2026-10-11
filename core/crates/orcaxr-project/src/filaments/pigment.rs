//! The pinned `filament_mixer` byte-colour pipeline
//! (`web/src/project/filaments/filamentPigmentMixer.ts`): the degree-four
//! polynomial pigment interpolation, evaluated in the browser's exact
//! operation order, and the pair blend automatic FullSpectrum rows display.
use super::mixer_model::{COEF, INTERCEPT, N_FEATURES, N_INPUTS, POWERS};
use crate::js_math::convert::trim_utf16;

/// `[red, green, blue]` bytes.
pub type Rgb = [u8; 3];

/// `parse_mixed_color`'s teal for anything but `#RRGGBB`.
const INVALID: Rgb = [38, 166, 154];

/// `parseOrcaMixedColor`: `value.trim().toUpperCase()` must read `#` and six
/// hexadecimal digits. Only ASCII `a`–`f` and U+FB00 (`ﬀ`, which upper-cases
/// to `FF`) upper-case into that alphabet, so they are the only lower-case
/// units read; anything else is the fallback.
pub fn parse_color(value: &[u16]) -> Rgb {
    let mut upper = Vec::with_capacity(8);
    for &unit in trim_utf16(value) {
        match unit {
            0x23 | 0x30..=0x39 | 0x41..=0x46 => upper.push(unit as u8),
            0x61..=0x66 => upper.push(unit as u8 - 0x20),
            0xfb00 => upper.extend_from_slice(b"FF"),
            _ => return INVALID,
        }
        if upper.len() > 7 {
            return INVALID;
        }
    }
    let [b'#', digits @ ..] = upper.as_slice() else {
        return INVALID;
    };
    if digits.len() != 6 || digits.contains(&b'#') {
        return INVALID;
    }
    let byte = |pair: &[u8]| {
        let digit = |d: u8| char::from(d).to_digit(16).expect("checked hexadecimal") as u8;
        digit(pair[0]) * 16 + digit(pair[1])
    };
    [
        byte(&digits[0..2]),
        byte(&digits[2..4]),
        byte(&digits[4..6]),
    ]
}

/// `filamentRgbToHex`: `#RRGGBB` in upper case.
pub fn to_hex(rgb: Rgb) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// `mixFilamentPigmentRgb`: `t` becomes a C++ `float` first; at or past
/// either end the end colour is returned unchanged.
pub fn mix(left: Rgb, right: Rgb, t: f64) -> Rgb {
    debug_assert!(t.is_finite(), "pigment mix ratio must be finite");
    let t = f64::from(t as f32);
    if t <= 0.0 {
        return left;
    }
    if t >= 1.0 {
        return right;
    }
    let inputs = [
        f64::from(left[0]),
        f64::from(left[1]),
        f64::from(left[2]),
        f64::from(right[0]),
        f64::from(right[1]),
        f64::from(right[2]),
        t,
    ];
    let mut output = INTERCEPT;
    for feature_index in 0..N_FEATURES {
        let mut feature = 1.0;
        for (input_index, &base) in inputs.iter().enumerate() {
            let exponent = POWERS[feature_index * N_INPUTS + input_index];
            if exponent == 0 {
                continue;
            }
            let mut power = 1.0;
            for _ in 0..exponent {
                power *= base;
            }
            feature *= power;
        }
        let offset = feature_index * 3;
        output[0] += feature * COEF[offset];
        output[1] += feature * COEF[offset + 1];
        output[2] += feature * COEF[offset + 2];
    }
    // `Math.trunc` then clamp to a byte; a saturating cast also maps NaN to 0,
    // which the polynomial never produces from bytes.
    output.map(|channel| channel.trunc().clamp(0.0, 255.0) as u8)
}

/// `blendPairFilamentPigment`.
pub fn blend_pair(left: &[u16], right: &[u16], mix_right: f64) -> String {
    to_hex(mix(parse_color(left), parse_color(right), mix_right))
}

/// `ORCA_INVALID_COLOR_FALLBACK`: what a blend of nothing shows.
pub const FALLBACK: &str = "#26A69A";

/// `blendMultiFilamentPigment`: each positive weight mixed into the colours
/// before it at `fround(weight / total so far)`, in the given order (the
/// polynomial is not associative). Weights must be finite.
pub fn blend_multi(colors: &[(&[u16], f64)]) -> String {
    let mut output: Option<Rgb> = None;
    let mut accumulated = 0.0;
    for &(color, raw) in colors {
        debug_assert!(raw.is_finite(), "pigment component weights must be finite");
        let weight = crate::js_math::max(0.0, raw);
        if weight <= 0.0 {
            continue;
        }
        let next = parse_color(color);
        let Some(current) = output else {
            output = Some(next);
            accumulated = weight;
            continue;
        };
        let total = accumulated + weight;
        if total <= 0.0 {
            continue;
        }
        output = Some(mix(current, next, f64::from((weight / total) as f32)));
        accumulated = total;
    }
    output.map_or_else(|| FALLBACK.to_owned(), to_hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }
    #[test]
    fn colours_parse_as_the_browser_upper_cases_them() {
        assert_eq!(parse_color(&units("#ff8000")), [255, 128, 0]);
        assert_eq!(parse_color(&units(" \u{feff}#Ff8000\u{a0}")), [255, 128, 0]);
        assert_eq!(parse_color(&units("#\u{fb00}0000")), [255, 0, 0]);
        for invalid in [
            "", "#", "ff8000", "#ff800", "#ff80000", "#gg0000", "#ff80 00", "##ff800",
        ] {
            assert_eq!(parse_color(&units(invalid)), INVALID, "{invalid}");
        }
        assert_eq!(
            parse_color(&[0x23, 0xd800, 0x41, 0x41, 0x41, 0x41, 0x41]),
            INVALID
        );
        assert_eq!(to_hex([0, 10, 255]), "#000AFF");
    }
    #[test]
    fn ends_return_their_colour() {
        assert_eq!(mix([1, 2, 3], [4, 5, 6], 0.0), [1, 2, 3]);
        assert_eq!(mix([1, 2, 3], [4, 5, 6], 1.0), [4, 5, 6]);
        // A ratio that rounds to 1 as a float is the right colour.
        assert_eq!(mix([1, 2, 3], [4, 5, 6], 0.999_999_999_9), [4, 5, 6]);
    }
}
