//! Variable and adaptive layer-height profiles (`objects/layerHeightProfile.ts`),
//! the browser's port of the pinned `Slicing.cpp` / `SlicingAdaptive.cpp`. A
//! profile is upstream's flat `[z0, h0, z1, h1, …]` list.
//!
//! Arithmetic follows the browser expression by expression through
//! [`crate::js_math`] (V8's `Math`). Do not reassociate or fuse anything here;
//! profiles are compared bit for bit with the browser.
use crate::js_math::{self, max as js_max, min as js_min};

/// Pinned `EPSILON` from libslic3r.
const EPSILON: f64 = 1e-4;
/// Pinned `LAYER_HEIGHT_CHANGE_STEP`.
const LAYER_HEIGHT_CHANGE_STEP: f64 = 0.05;
/// Pinned resampling step of the manual editor, in millimetres.
const RESAMPLE_STEP_MM: f64 = 0.1;
/// Pinned number of smoothing rounds, in both the editor and the smoother.
const SMOOTHING_ROUNDS: usize = 6;
/// Work bounds shared with the browser (`MAX_*` in `layerHeightProfile.ts`).
pub const MAX_OBJECT_HEIGHT_MM: f64 = 10_000.0;
pub const MAX_PROFILE_LAYERS: f64 = 1_000_000.0;
pub const MAX_SMOOTHING_RADIUS: f64 = 100.0;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub layer_height_mm: f64,
    pub min_layer_height_mm: f64,
    pub max_layer_height_mm: f64,
    pub first_object_layer_height_mm: f64,
    pub first_object_layer_height_fixed: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct Parameters {
    pub limits: Limits,
    pub object_height_mm: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Increase,
    Decrease,
    Reduce,
    Smooth,
}
#[derive(Clone, Copy, Debug)]
pub struct Edit {
    pub z_mm: f64,
    pub thickness_delta_mm: f64,
    pub band_width_mm: f64,
    pub action: Action,
}
#[derive(Clone, Copy, Debug)]
pub struct Smoothing {
    pub radius: f64,
    pub keep_min: bool,
}
/// `LayerHeightProfileError`: the browser's message, verbatim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileError(pub String);
fn refuse<T>(message: impl Into<String>) -> Result<T, ProfileError> {
    Err(ProfileError(message.into()))
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
fn clamp(value: f64, low: f64, high: f64) -> f64 {
    js_min(js_max(value, low), high)
}
/// A JavaScript array read: past the end is `undefined`, which is NaN in arithmetic.
fn at(values: &[f64], index: usize) -> f64 {
    values.get(index).copied().unwrap_or(f64::NAN)
}

pub fn assert_parameters(p: &Parameters) -> Result<(), ProfileError> {
    let l = &p.limits;
    let finite = [
        l.layer_height_mm,
        l.min_layer_height_mm,
        l.max_layer_height_mm,
        l.first_object_layer_height_mm,
        p.object_height_mm,
    ];
    if !finite.iter().all(|v| v.is_finite()) {
        return refuse("Slicing parameters must all be finite");
    }
    if l.min_layer_height_mm <= 0.0 || l.max_layer_height_mm < l.min_layer_height_mm {
        return refuse("Layer height limits must be positive with max at least min");
    }
    if l.layer_height_mm <= 0.0 || l.first_object_layer_height_mm <= 0.0 {
        return refuse("Layer heights must be positive");
    }
    if p.object_height_mm <= 0.0 {
        return refuse("An object with no height has no layers to edit");
    }
    if p.object_height_mm > MAX_OBJECT_HEIGHT_MM {
        return refuse("An object taller than 10000 mm cannot be layered");
    }
    let thinnest = js_min(l.min_layer_height_mm, l.first_object_layer_height_mm);
    if p.object_height_mm / thinnest > MAX_PROFILE_LAYERS {
        return refuse("A layer height profile is limited to 1000000 layers");
    }
    Ok(())
}
fn assert_profile(profile: &[f64]) -> Result<(), ProfileError> {
    if profile.len() < 4 || !profile.len().is_multiple_of(2) {
        return refuse("A layer height profile is at least two z/height pairs");
    }
    if !profile.iter().all(|v| v.is_finite()) {
        return refuse("A layer height profile must be finite throughout");
    }
    Ok(())
}

/// `baseLayerHeightProfile`: the flat profile an object starts from.
pub fn base_profile(p: &Parameters) -> Result<Vec<f64>, ProfileError> {
    assert_parameters(p)?;
    let l = &p.limits;
    let mut profile = Vec::with_capacity(6);
    if l.first_object_layer_height_fixed {
        profile.extend([0.0, l.first_object_layer_height_mm]);
        profile.extend([
            l.first_object_layer_height_mm,
            l.first_object_layer_height_mm,
        ]);
    } else {
        profile.extend([0.0, l.layer_height_mm]);
    }
    profile.extend([p.object_height_mm, l.layer_height_mm]);
    Ok(profile)
}

/// `layerHeightAt`: the interpolated height at `z`.
pub fn height_at(profile: &[f64], z: f64, fallback: f64) -> f64 {
    let mut index = 0;
    while index < profile.len() {
        if index + 2 == profile.len() {
            return at(profile, index + 1);
        }
        if at(profile, index + 2) > z {
            let (z1, h1) = (at(profile, index), at(profile, index + 1));
            let (z2, h2) = (at(profile, index + 2), at(profile, index + 3));
            return if z2 == z1 {
                h1
            } else {
                lerp(h1, h2, (z - z1) / (z2 - z1))
            };
        }
        index += 2;
    }
    fallback
}

/// The raised cosine both editor passes use over the band.
fn band_cosine(zz: f64, z: f64, band: f64) -> f64 {
    js_math::cos((2.0 * std::f64::consts::PI * (zz - z)) / band)
}

/// `adjustLayerHeightProfile`: one manual edit, exactly as the pinned editor.
pub fn adjust(profile: &[f64], p: &Parameters, edit: &Edit) -> Result<Vec<f64>, ProfileError> {
    assert_parameters(p)?;
    assert_profile(profile)?;
    let l = &p.limits;
    let span_low = if l.first_object_layer_height_fixed {
        l.first_object_layer_height_mm
    } else {
        0.0
    };
    let span_high = p.object_height_mm;
    let z = edit.z_mm;
    if z < span_low || z > span_high {
        return Ok(profile.to_vec());
    }
    let current = height_at(profile, z, l.layer_height_mm);
    let mut delta = edit.thickness_delta_mm;
    if matches!(edit.action, Action::Increase | Action::Decrease) {
        if edit.action == Action::Decrease {
            delta = -delta;
        }
        if delta > 0.0 {
            if current >= l.max_layer_height_mm - EPSILON {
                return Ok(profile.to_vec());
            }
            delta = js_min(delta, l.max_layer_height_mm - current);
        } else {
            if current <= l.min_layer_height_mm + EPSILON {
                return Ok(profile.to_vec());
            }
            delta = js_max(delta, l.min_layer_height_mm - current);
        }
    } else {
        delta = js_min(delta.abs(), (l.layer_height_mm - current).abs());
        if delta < EPSILON {
            return Ok(profile.to_vec());
        }
    }

    let band = edit.band_width_mm;
    let lo = js_max(span_low, z - 0.5 * band);
    // The upper side is deliberately unbounded so an edit can reach the top point.
    let hi = z + 0.5 * band;

    let mut index = 0;
    while index < profile.len() && at(profile, index) < lo {
        index += 2;
    }
    index = index.saturating_sub(2);
    let mut next: Vec<f64> = profile[..(index + 2).min(profile.len())].to_vec();
    let resampled_start = next.len();
    let mut zz = lo;
    let last = |next: &Vec<f64>| at(next, next.len().wrapping_sub(2));
    loop {
        let following = index + 2;
        let (z1, h1) = (at(profile, index), at(profile, index + 1));
        let mut height = h1;
        if following < profile.len() {
            let (z2, h2) = (at(profile, following), at(profile, following + 1));
            height = if z2 == z1 {
                h1
            } else {
                lerp(h1, h2, (zz - z1) / (z2 - z1))
            };
        }
        let weight = if (zz - z).abs() < 0.5 * band {
            0.5 + 0.5 * band_cosine(zz, z, band)
        } else {
            0.0
        };
        match edit.action {
            Action::Increase | Action::Decrease => height += weight * delta,
            Action::Reduce => {
                let to_base = height - l.layer_height_mm;
                let step = weight * delta;
                height += if to_base.abs() > step {
                    if to_base > 0.0 { -step } else { step }
                } else {
                    -to_base
                };
            }
            // Applied after resampling.
            Action::Smooth => {}
        }
        height = clamp(height, l.min_layer_height_mm, l.max_layer_height_mm);

        if zz == span_high {
            // The last point of the profile replaces any point that reached it.
            if last(&next) + EPSILON > zz {
                next.pop();
                next.pop();
            }
            next.extend([zz, height]);
            index = profile.len();
            break;
        }
        if last(&next) + EPSILON < zz {
            next.extend([zz, height]);
        }
        if zz >= hi {
            break;
        }
        zz = js_min(zz + RESAMPLE_STEP_MM, span_high);
        index = following;
        while index < profile.len() && at(profile, index) < zz {
            index += 2;
        }
        index = index.saturating_sub(2);
    }

    index += 2;
    let resampled_end = next.len();
    if index < profile.len() {
        next.extend_from_slice(&profile[index..]);
    } else if last(&next) + 0.5 * EPSILON < span_high {
        next.extend_from_slice(&profile[profile.len() - 2..]);
    }
    if edit.action != Action::Smooth {
        return Ok(next);
    }

    // Six weighted passes over the resampled window only.
    let start = if resampled_start == 0 {
        1
    } else {
        resampled_start
    };
    let end = if resampled_end == next.len() {
        resampled_end.wrapping_sub(2)
    } else {
        resampled_end
    };
    let mut smoothed = next.clone();
    for _ in 0..SMOOTHING_ROUNDS {
        let previous = smoothed.clone();
        let mut i = start;
        while i < end {
            let zi = at(&previous, i);
            let t = if (zi - z).abs() < 0.5 * band {
                0.25 + 0.25 * band_cosine(zi, z, band)
            } else {
                0.0
            };
            let value = if i == 0 {
                (1.0 - t) * at(&previous, i + 1) + t * at(&previous, i + 3)
            } else if i + 1 == previous.len() {
                (1.0 - t) * at(&previous, i + 1) + t * at(&previous, i - 1)
            } else {
                (1.0 - t) * at(&previous, i + 1)
                    + 0.5 * t * (at(&previous, i - 1) + at(&previous, i + 3))
            };
            // `smoothed[i + 1] = …` past the end would grow a JS array; the
            // window never reaches it.
            if let Some(slot) = smoothed.get_mut(i + 1) {
                *slot = value;
            }
            i += 2;
        }
    }
    Ok(smoothed)
}

/// `smoothHeightProfile`: the pinned biased Gaussian, six rounds.
pub fn smooth(profile: &[f64], p: &Parameters, s: &Smoothing) -> Result<Vec<f64>, ProfileError> {
    assert_parameters(p)?;
    assert_profile(profile)?;
    // `!(radius <= MAX)`: NaN is refused too.
    if s.radius.is_nan() || s.radius > MAX_SMOOTHING_RADIUS {
        return refuse("Smoothing radius must be at most 100");
    }
    let mut result = profile.to_vec();
    for _ in 0..SMOOTHING_ROUNDS {
        result = gauss_blur(&result, p, s);
    }
    Ok(result)
}

fn gauss_blur(profile: &[f64], p: &Parameters, s: &Smoothing) -> Vec<f64> {
    let l = &p.limits;
    // The fixed first layer is left exactly as it is.
    let skip = if l.first_object_layer_height_fixed {
        4
    } else {
        0
    };
    if (profile.len() as f64) - (skip as f64) < 6.0 {
        return profile.to_vec();
    }
    // `Math.max(Math.trunc(radius), 1)`; the radius is at most 100 here.
    let radius = js_max(s.radius.trunc(), 1.0) as usize;
    let kernel = gauss_kernel(radius);
    let two_radius = 2 * radius;
    let mut result: Vec<f64> = profile[..skip].to_vec();
    let delta_h = l.max_layer_height_mm - l.min_layer_height_mm;
    let inverse_delta_h = if delta_h != 0.0 { 1.0 / delta_h } else { 1.0 };
    let max_dz_band = radius as f64 * l.layer_height_mm;
    let mut i = skip;
    while i < profile.len() {
        let (zi, hi) = (profile[i], at(profile, i + 1));
        let mut height = 0.0;
        let mut weight_total = 0.0;
        let begin = i.saturating_sub(two_radius).max(skip);
        let end = (i + two_radius).min(profile.len() - 2);
        let mut j = begin;
        while j <= end {
            // `radius + (j - i) / 2`, an exact integer.
            let kernel_index = radius + j / 2 - i / 2;
            let dz = (zi - profile[j]).abs();
            if dz * l.layer_height_mm <= max_dz_band {
                let dh = (l.max_layer_height_mm - profile[j + 1]).abs();
                let weight = kernel[kernel_index] * (dh * inverse_delta_h).sqrt();
                height += weight * profile[j + 1];
                weight_total += weight;
            }
            j += 2;
        }
        let mut value = clamp(
            if weight_total == 0.0 {
                hi
            } else {
                height / weight_total
            },
            l.min_layer_height_mm,
            l.max_layer_height_mm,
        );
        if s.keep_min {
            value = js_min(value, hi);
        }
        result.extend([zi, value]);
        i += 2;
    }
    result
}

fn gauss_kernel(radius: usize) -> Vec<f64> {
    let size = 2 * radius + 1;
    let r = radius as f64;
    let sigma = 0.3 * (r - 1.0) + 0.8;
    let two_square_sigma = 2.0 * sigma * sigma;
    let inverse_root = 1.0 / (std::f64::consts::PI * two_square_sigma).sqrt();
    (0..size)
        .map(|i| {
            let x = i as f64 - r;
            inverse_root * js_math::exp((-x * x) / two_square_sigma)
        })
        .collect()
}

/// One triangle reduced to what the adaptive slicer needs from it.
struct Face {
    z_min: f64,
    z_max: f64,
    normal_cos: f64,
    normal_sin: f64,
}

/// `adaptiveLayerHeightProfile` over positions and triangle indices.
pub fn adaptive(
    positions: &[[f64; 3]],
    indices: &[u32],
    p: &Parameters,
    quality: f64,
) -> Result<Vec<f64>, ProfileError> {
    assert_parameters(p)?;
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return refuse("Adaptive quality must be between 0 and 1");
    }
    let l = &p.limits;
    let faces = prepare_faces(positions, indices);
    let mut profile = vec![0.0, l.first_object_layer_height_mm];
    if l.first_object_layer_height_fixed {
        profile.extend([
            l.first_object_layer_height_mm,
            l.first_object_layer_height_mm,
        ]);
    }
    let mut print_z = l.first_object_layer_height_mm;
    let mut cursor = 0usize;
    while print_z + EPSILON < p.object_height_mm {
        let mut height = next_layer_height(&faces, p, print_z, quality, &mut cursor);
        // Upstream refuses a step change larger than this.
        let previous = profile[profile.len() - 1];
        if previous < height && height - previous > LAYER_HEIGHT_CHANGE_STEP {
            height = previous + LAYER_HEIGHT_CHANGE_STEP;
        } else if previous > height && previous - height > LAYER_HEIGHT_CHANGE_STEP {
            height = previous - LAYER_HEIGHT_CHANGE_STEP;
        }
        profile.extend([print_z, height]);
        print_z += height;
    }
    let gap = p.object_height_mm - profile[profile.len() - 2];
    if gap > 0.0 {
        profile.extend([
            p.object_height_mm,
            clamp(gap, l.min_layer_height_mm, l.max_layer_height_mm),
        ]);
    }
    Ok(profile)
}

fn prepare_faces(positions: &[[f64; 3]], indices: &[u32]) -> Vec<Face> {
    let mut faces = Vec::with_capacity(indices.len() / 3);
    for triangle in indices.chunks_exact(3) {
        let vertex = |i: u32| positions.get(i as usize);
        let (Some(a), Some(b), Some(c)) = (
            vertex(triangle[0]),
            vertex(triangle[1]),
            vertex(triangle[2]),
        ) else {
            continue;
        };
        let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        let mut nx = uy * vz - uz * vy;
        let mut ny = uz * vx - ux * vz;
        let mut nz = ux * vy - uy * vx;
        let length = js_math::hypot(&[nx, ny, nz]);
        if length == 0.0 {
            continue;
        }
        nx /= length;
        ny /= length;
        nz /= length;
        faces.push(Face {
            z_min: js_min(js_min(a[2], b[2]), c[2]),
            z_max: js_max(js_max(a[2], b[2]), c[2]),
            normal_cos: nz.abs(),
            normal_sin: js_math::hypot(&[nx, ny]),
        });
    }
    // `left.zMin - right.zMin || left.zMax - right.zMax` with V8's stable sort.
    faces.sort_by(|left, right| {
        let by = |d: f64| d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        by(left.z_min - right.z_min).then_with(|| by(left.z_max - right.z_max))
    });
    faces
}

fn next_layer_height(
    faces: &[Face],
    p: &Parameters,
    print_z: f64,
    quality: f64,
    cursor: &mut usize,
) -> f64 {
    let l = &p.limits;
    let mut height = l.max_layer_height_mm;
    let max_surface_deviation = if quality < 0.5 {
        lerp(l.min_layer_height_mm, l.layer_height_mm, 2.0 * quality)
    } else {
        lerp(
            l.max_layer_height_mm,
            l.layer_height_mm,
            2.0 * (1.0 - quality),
        )
    };
    let mut ordered = *cursor;
    let mut first_hit = false;
    while ordered < faces.len() {
        let face = &faces[ordered];
        if face.z_min >= print_z {
            break;
        }
        if face.z_max > print_z {
            if !first_hit {
                first_hit = true;
                *cursor = ordered;
            }
            // A facet that merely touches this Z would otherwise force a tiny layer.
            if face.z_max >= print_z + EPSILON {
                height = js_min(height, slope_height(face, max_surface_deviation));
            }
        }
        ordered += 1;
    }
    height = js_max(height, l.min_layer_height_mm);
    if height > l.min_layer_height_mm {
        while ordered < faces.len() {
            let face = &faces[ordered];
            if face.z_min >= print_z + height {
                break;
            }
            if face.z_max >= print_z + EPSILON {
                let reduced = slope_height(face, max_surface_deviation);
                let z_diff = face.z_min - print_z;
                if reduced < z_diff {
                    height = z_diff;
                } else if reduced < height {
                    height = reduced;
                }
            }
            ordered += 1;
        }
        height = js_max(height, l.min_layer_height_mm);
    }
    height
}

/// Upstream's surface-error metric.
fn slope_height(face: &Face, max_surface_deviation: f64) -> f64 {
    let sloped = if face.normal_cos > 1e-5 {
        1.44 * max_surface_deviation * (face.normal_sin / face.normal_cos).sqrt()
    } else {
        f64::INFINITY
    };
    js_min(max_surface_deviation / 0.184, sloped)
}
