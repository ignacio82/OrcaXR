//! The pinned authoring projection (`mixedFilamentAuthoring.ts`, after
//! Snapmaker Orca v2.3.4's `MixedFilamentDialog.cpp` and
//! `MixedColorMatchHelpers.cpp`): each mode's checks and its exact engine
//! fields, the Ratio triangle's clamp and wire weights, Match weight
//! normalization and minimums, CIEDE2000 in binary64 and the ranking of
//! supplied, pigment-rendered Match candidates with its ≤ 0.5 pair
//! preference. Numbers stay binary64 as JavaScript reads them, so a
//! fractional or unsafe value is refused in the browser's words.
use super::text::{cat, match_hex, num, u};
use crate::js_math::{self, convert::is_safe_integer};

/// `MAX_AUTHORING_PHYSICAL_TOOL_ID`.
pub const MAX_PHYSICAL: f64 = 64.0;
/// `ORCA_DISTRIBUTION_LAYER_CYCLE` and `ORCA_DISTRIBUTION_SIMPLE`.
pub const LAYER_CYCLE: u8 = 0;
pub const SIMPLE: u8 = 2;

/// `MixedFilamentSerializableProjection` (`custom` is always true).
#[derive(Debug, Clone, PartialEq)]
pub struct Projection {
    pub ui_mode: u8,
    pub component_a: f64,
    pub component_b: f64,
    pub mix_b_percent: f64,
    pub ratio_a: f64,
    pub ratio_b: f64,
    pub manual_pattern: Vec<u16>,
    pub gradient_component_ids: Vec<u16>,
    pub gradient_component_weights: Vec<u16>,
    pub distribution_mode: u8,
    pub local_z_max_sublayers: f64,
    pub gradient_enabled: bool,
    pub gradient_start: f64,
    pub gradient_end: f64,
}

/// `MixedFilamentAuthoringInput`. The gradient direction is text: anything
/// but `a-to-b` and `b-to-a` is refused.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Ratio {
        component_ids: Vec<f64>,
        mix_b_percent: f64,
        triangle: Option<Vec<f64>>,
    },
    Gradient {
        component_ids: Vec<f64>,
        direction: Vec<u16>,
        local_z_max_sublayers: f64,
    },
    Match {
        /// Tool IDs and weights.
        components: Vec<(f64, f64)>,
        target_color: Vec<u16>,
        min_component_percent: f64,
    },
}
impl Input {
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Ratio { .. } => "ratio",
            Self::Gradient { .. } => "gradient",
            Self::Match { .. } => "match",
        }
    }
}

/// `MixedFilamentAuthoringLocation`.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub path: Vec<u16>,
    pub component_index: Option<usize>,
    pub start_offset: Option<usize>,
    pub end_offset: Option<usize>,
}

/// `MixedFilamentAuthoringIssue`.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub message: Vec<u16>,
    pub location: Location,
}

fn issue(code: &'static str, message: Vec<u16>, path: Vec<u16>) -> Issue {
    Issue {
        code,
        message,
        location: Location {
            path,
            component_index: None,
            start_offset: None,
            end_offset: None,
        },
    }
}
fn indexed(code: &'static str, message: Vec<u16>, path: Vec<u16>, index: usize) -> Issue {
    let mut made = issue(code, message, path);
    made.location.component_index = Some(index);
    made
}

/// `MixedFilamentAuthoringResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct Authored {
    pub ok: bool,
    pub mode: &'static str,
    pub projection: Option<Projection>,
    pub normalized_target_color: Option<Vec<u16>>,
    pub issues: Vec<Issue>,
}

/// `projectMixedFilamentAuthoring`.
pub fn project(input: &Input, physical_tool_count: f64) -> Authored {
    let mut issues = Vec::new();
    tool_count(physical_tool_count, &mut issues);
    let mut normalized = None;
    let projection = match input {
        Input::Ratio {
            component_ids,
            mix_b_percent,
            triangle,
        } => ratio(
            component_ids,
            *mix_b_percent,
            triangle.as_deref(),
            physical_tool_count,
            &mut issues,
        ),
        Input::Gradient {
            component_ids,
            direction,
            local_z_max_sublayers,
        } => gradient(
            component_ids,
            direction,
            *local_z_max_sublayers,
            physical_tool_count,
            &mut issues,
        ),
        Input::Match {
            components,
            target_color,
            min_component_percent,
        } => {
            let (projection, target) = match_projection(
                components,
                target_color,
                *min_component_percent,
                physical_tool_count,
                &mut issues,
            );
            normalized = target;
            projection
        }
    };
    let clean = issues.is_empty();
    Authored {
        ok: clean && projection.is_some(),
        mode: input.mode(),
        projection: if clean { projection } else { None },
        normalized_target_color: normalized.filter(|target| !target.is_empty()),
        issues,
    }
}

/// `normalizeRatioTriangleWeights`: none for anything but three finite,
/// non-negative weights with a positive total.
pub fn normalize_triangle(weights: &[f64]) -> Option<[f64; 3]> {
    if weights.len() != 3 || weights.iter().any(|w| !w.is_finite() || *w < 0.0) {
        return None;
    }
    let total = weights[0] + weights[1] + weights[2];
    if total <= 0.0 {
        return None;
    }
    normalize_barycentric(&[weights[0] / total, weights[1] / total, weights[2] / total])
}

/// `normalizeRatioTriangleBarycentricWeights`: four clamp-and-renormalize passes.
pub fn normalize_barycentric(weights: &[f64]) -> Option<[f64; 3]> {
    if weights.len() != 3 || weights.iter().any(|w| !w.is_finite()) {
        return None;
    }
    let [mut first, mut second, mut third] = [weights[0], weights[1], weights[2]];
    for _ in 0..4 {
        first = clamp(first, 0.1, 0.9);
        second = clamp(second, 0.1, 0.9);
        third = clamp(third, 0.1, 0.9);
        let sum = first + second + third;
        if sum > 0.0 {
            first /= sum;
            second /= sum;
            third /= sum;
        }
    }
    Some([first, second, third])
}

/// `ratioTriangleWireWeights`.
fn triangle_wire(weights: &[f64]) -> Option<[f64; 3]> {
    let normalized = normalize_triangle(weights)?;
    let first = lround(normalized[0] * 100.0);
    let second = lround(normalized[1] * 100.0);
    Some([first, second, 100.0 - first - second])
}

/// `normalizeColorMatchWeights`: largest-remainder percentages. Weights that
/// are not safe integers are refused, as the browser throws on them.
pub fn normalize_match_weights(weights: &[f64], count: usize) -> Result<Vec<f64>, &'static str> {
    if weights.iter().any(|w| !is_safe_integer(*w)) {
        return Err("Match weights must be safe integers");
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut out: Vec<f64> = if weights.len() == count {
        weights.to_vec()
    } else {
        vec![(100.0 / count as f64).trunc(); count]
    };
    let mut sum = 0.0;
    for value in out.iter_mut() {
        *value = js_math::max(0.0, *value);
        sum += *value;
    }
    if sum <= 0.0 {
        out.fill(0.0);
        out[0] = 100.0;
        return Ok(out);
    }
    let mut remainders = vec![0.0; count];
    let mut assigned = 0.0;
    for index in 0..count {
        let exact = (100.0 * out[index]) / sum;
        out[index] = exact.floor();
        remainders[index] = exact - out[index];
        assigned += out[index];
    }
    let mut missing = js_math::max(0.0, 100.0 - assigned);
    while missing > 0.0 {
        let mut best = 0;
        let mut best_remainder = -1.0;
        for (index, remainder) in remainders.iter().enumerate() {
            if *remainder > best_remainder {
                best_remainder = *remainder;
                best = index;
            }
        }
        out[best] += 1.0;
        remainders[best] = 0.0;
        missing -= 1.0;
    }
    Ok(out)
}

/// `colorMatchWeightsWithinRange`.
pub fn weights_within_range(weights: &[f64], min_component_percent: f64) -> bool {
    if min_component_percent <= 0.0 {
        return true;
    }
    let minimum = clamp(min_component_percent.trunc(), 0.0, 50.0);
    let mut active = 0;
    for weight in weights {
        if *weight <= 0.0 {
            continue;
        }
        active += 1;
        if *weight < minimum {
            return false;
        }
    }
    active >= 2
}

/// `deltaE2000Lab` in binary64.
pub fn delta_e2000_lab(first: [f64; 3], second: [f64; 3]) -> f64 {
    let [l1, a1, b1] = first;
    let [l2, a2, b2] = second;
    let pow = js_math::pow;
    let average_l = (l1 + l2) / 2.0;
    let c1 = js_math::hypot(&[a1, b1]);
    let c2 = js_math::hypot(&[a2, b2]);
    let average_c = (c1 + c2) / 2.0;
    let average_c7 = pow(average_c, 7.0);
    let g = (1.0 - (average_c7 / (average_c7 + pow(25.0, 7.0))).sqrt()) / 2.0;
    let a1_prime = a1 * (1.0 + g);
    let a2_prime = a2 * (1.0 + g);
    let c1_prime = js_math::hypot(&[a1_prime, b1]);
    let c2_prime = js_math::hypot(&[a2_prime, b2]);
    let average_c_prime = (c1_prime + c2_prime) / 2.0;
    let mut h1_prime = degrees(js_math::atan2(b1, a1_prime));
    let mut h2_prime = degrees(js_math::atan2(b2, a2_prime));
    if h1_prime < 0.0 {
        h1_prime += 360.0;
    }
    if h2_prime < 0.0 {
        h2_prime += 360.0;
    }
    let average_h_prime = if (h1_prime - h2_prime).abs() > 180.0 {
        (h1_prime + h2_prime + 360.0) / 2.0
    } else {
        (h1_prime + h2_prime) / 2.0
    };
    let t = 1.0 - 0.17 * js_math::cos(radians(average_h_prime - 30.0))
        + 0.24 * js_math::cos(radians(2.0 * average_h_prime))
        + 0.32 * js_math::cos(radians(3.0 * average_h_prime + 6.0))
        - 0.2 * js_math::cos(radians(4.0 * average_h_prime - 63.0));
    let mut delta_h_prime = h2_prime - h1_prime;
    if delta_h_prime.abs() > 180.0 {
        delta_h_prime += if h2_prime <= h1_prime { 360.0 } else { -360.0 };
    }
    let delta_l_prime = l2 - l1;
    let delta_c_prime = c2_prime - c1_prime;
    delta_h_prime = 2.0 * (c1_prime * c2_prime).sqrt() * js_math::sin(radians(delta_h_prime) / 2.0);
    let s_l =
        1.0 + (0.015 * pow(average_l - 50.0, 2.0)) / (20.0 + pow(average_l - 50.0, 2.0)).sqrt();
    let s_c = 1.0 + 0.045 * average_c_prime;
    let s_h = 1.0 + 0.015 * average_c_prime * t;
    let delta_theta = 30.0 * js_math::exp(-pow((average_h_prime - 275.0) / 25.0, 2.0));
    let average_c_prime7 = pow(average_c_prime, 7.0);
    let r_c = 2.0 * (average_c_prime7 / (average_c_prime7 + pow(25.0, 7.0))).sqrt();
    let r_t = -r_c * js_math::sin(2.0 * radians(delta_theta));
    let l_term = delta_l_prime / s_l;
    let c_term = delta_c_prime / s_c;
    let h_term = delta_h_prime / s_h;
    (pow(l_term, 2.0) + pow(c_term, 2.0) + pow(h_term, 2.0) + r_t * c_term * h_term).sqrt()
}

/// `colorDeltaE2000` between two colours the Match field accepts; none for another.
pub fn color_delta_e2000(first: &[u16], second: &[u16]) -> Option<f64> {
    Some(delta_e2000_lab(lab(&rgb(first)?), lab(&rgb(second)?)))
}

fn rgb(value: &[u16]) -> Option<[f64; 3]> {
    let normalized = match_hex(value)?;
    let digit = |unit: u16| {
        char::from_u32(u32::from(unit))
            .and_then(|c| c.to_digit(16))
            .expect("hex") as f64
    };
    let byte = |index: usize| digit(normalized[index]) * 16.0 + digit(normalized[index + 1]);
    Some([byte(1), byte(3), byte(5)])
}
fn lab(rgb: &[f64; 3]) -> [f64; 3] {
    let red = pivot_rgb(rgb[0] / 255.0);
    let green = pivot_rgb(rgb[1] / 255.0);
    let blue = pivot_rgb(rgb[2] / 255.0);
    let x = 0.412453 * red + 0.35758 * green + 0.180423 * blue;
    let y = 0.212671 * red + 0.71516 * green + 0.072169 * blue;
    let z = 0.019334 * red + 0.119193 * green + 0.950227 * blue;
    let pivot_x = pivot_xyz(x / 95.047);
    let pivot_y = pivot_xyz(y / 100.0);
    let pivot_z = pivot_xyz(z / 108.883);
    [
        116.0 * pivot_y - 16.0,
        500.0 * (pivot_x - pivot_y),
        200.0 * (pivot_y - pivot_z),
    ]
}
fn pivot_rgb(value: f64) -> f64 {
    (if value > 0.04045 {
        js_math::pow((value + 0.055) / 1.055, 2.4)
    } else {
        value / 12.92
    }) * 100.0
}
fn pivot_xyz(value: f64) -> f64 {
    if value > 0.008856 {
        js_math::cbrt(value)
    } else {
        7.787 * value + 16.0 / 116.0
    }
}
fn radians(degrees: f64) -> f64 {
    (2.0 * std::f64::consts::PI * degrees) / 360.0
}
fn degrees(radians: f64) -> f64 {
    (360.0 * radians) / (2.0 * std::f64::consts::PI)
}

/// One supplied Match candidate: tool IDs and weights, and its pigment-rendered preview.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub components: Vec<(f64, f64)>,
    pub preview_color: Vec<u16>,
}

/// `RankedMatchRecipeCandidate`.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub source_index: usize,
    pub preview_color: Vec<u16>,
    pub delta_e2000: f64,
    pub projection: Projection,
}

/// `MatchRecipeRankingResult` (its coverage is always `supplied-candidates-only`).
#[derive(Debug, Clone, PartialEq)]
pub struct Ranking {
    pub ok: bool,
    pub normalized_target_color: Option<Vec<u16>>,
    pub candidates: Vec<Ranked>,
    pub issues: Vec<Issue>,
}

/// `rankColorMatchCandidates`: each candidate checked as a Match recipe and
/// scored by ΔE2000, sorted as V8 sorts with the 1e-6 tolerance, then the
/// best pair first when a multi-colour winner beats it by no more than 0.5.
pub fn rank(
    physical_tool_count: f64,
    target_color: &[u16],
    min_component_percent: f64,
    candidates: &[Candidate],
) -> Ranking {
    let mut issues = Vec::new();
    tool_count(physical_tool_count, &mut issues);
    minimum_percent(min_component_percent, &mut issues);
    let target = color(
        target_color,
        u("targetColor"),
        "invalid-target-color",
        &mut issues,
    );
    let mut scored: Vec<Ranked> = Vec::new();
    if let (true, Some(target)) = (issues.is_empty(), target.as_ref()) {
        for (index, candidate) in candidates.iter().enumerate() {
            let mut local = Vec::new();
            let (projection, _) = match_projection(
                &candidate.components,
                target,
                min_component_percent,
                physical_tool_count,
                &mut local,
            );
            let prefix = u(&format!("candidates[{index}]."));
            let had_local = !local.is_empty();
            for mut each in local {
                each.location.path = cat(&[&prefix, &each.location.path]);
                issues.push(each);
            }
            let preview = color(
                &candidate.preview_color,
                u(&format!("candidates[{index}].previewColor")),
                "invalid-preview-color",
                &mut issues,
            );
            let (Some(projection), false, Some(preview)) = (projection, had_local, preview) else {
                continue;
            };
            let delta_e2000 = color_delta_e2000(target, &preview).expect("validated colours");
            scored.push(Ranked {
                source_index: index,
                preview_color: preview,
                delta_e2000,
                projection,
            });
        }
    }
    js_math::sort::sort_by(&mut scored, |left, right| {
        if left.delta_e2000 + 1e-6 < right.delta_e2000 {
            -1.0
        } else if right.delta_e2000 + 1e-6 < left.delta_e2000 {
            1.0
        } else {
            left.source_index as f64 - right.source_index as f64
        }
    });
    pair_preference(&mut scored);
    if scored.is_empty() && issues.is_empty() {
        issues.push(issue(
            "no-valid-candidates",
            u("Provide at least one valid, pigment-rendered Match candidate."),
            u("candidates"),
        ));
    }
    Ranking {
        ok: issues.is_empty() && !scored.is_empty(),
        normalized_target_color: target,
        candidates: scored,
        issues,
    }
}

/// `applyPinnedPairPreference`.
fn pair_preference(candidates: &mut Vec<Ranked>) {
    let Some(best) = candidates.first() else {
        return;
    };
    let pair = candidates
        .iter()
        .position(|candidate| candidate.projection.distribution_mode == SIMPLE);
    if let Some(index) = pair
        && index > 0
        && best.projection.distribution_mode != SIMPLE
        && candidates[index].delta_e2000 <= best.delta_e2000 + 0.5
    {
        let pair = candidates.remove(index);
        candidates.insert(0, pair);
    }
}

fn ratio(
    ids: &[f64],
    mix_b_percent: f64,
    triangle: Option<&[f64]>,
    physical_tool_count: f64,
    issues: &mut Vec<Issue>,
) -> Option<Projection> {
    component_ids(ids, 2, 3, physical_tool_count, "componentIds", None, issues);
    percent(mix_b_percent, "mixBPercent", issues);
    if ids.len() == 2 {
        if triangle.is_some() {
            issues.push(issue(
                "unexpected-triangle-weights",
                u("Two-color Ratio uses mixBPercent and must not include triangle weights."),
                u("triangleWeightsPercent"),
            ));
        }
        if !issues.is_empty() {
            return None;
        }
        let (ratio_a, ratio_b) = cadence(mix_b_percent);
        return Some(Projection {
            ui_mode: 0,
            component_a: ids[0],
            component_b: ids[1],
            mix_b_percent,
            ratio_a,
            ratio_b,
            manual_pattern: Vec::new(),
            gradient_component_ids: Vec::new(),
            gradient_component_weights: Vec::new(),
            distribution_mode: SIMPLE,
            local_z_max_sublayers: 0.0,
            gradient_enabled: false,
            gradient_start: 0.8,
            gradient_end: 0.2,
        });
    }
    match triangle {
        None => issues.push(issue(
            "triangle-weights-required",
            u("Three-color Ratio requires exactly three triangle weights."),
            u("triangleWeightsPercent"),
        )),
        Some(weights) => weights_check(weights, 3, "triangleWeightsPercent", None, false, issues),
    }
    let triangle = triangle?;
    if !issues.is_empty() || ids.len() != 3 {
        return None;
    }
    let Some(wire) = triangle_wire(triangle) else {
        issues.push(issue(
            "invalid-weight-total",
            u("Three-color Ratio weights must have a positive total."),
            u("triangleWeightsPercent"),
        ));
        return None;
    };
    Some(Projection {
        ui_mode: 0,
        component_a: ids[0],
        component_b: ids[1],
        mix_b_percent,
        ratio_a: 1.0,
        ratio_b: 1.0,
        manual_pattern: Vec::new(),
        gradient_component_ids: encode_ids(ids),
        gradient_component_weights: join(&wire),
        distribution_mode: LAYER_CYCLE,
        local_z_max_sublayers: 0.0,
        gradient_enabled: false,
        gradient_start: 0.8,
        gradient_end: 0.2,
    })
}

fn gradient(
    ids: &[f64],
    direction: &[u16],
    sublayers: f64,
    physical_tool_count: f64,
    issues: &mut Vec<Issue>,
) -> Option<Projection> {
    component_ids(ids, 2, 2, physical_tool_count, "componentIds", None, issues);
    let a_to_b = direction == u("a-to-b").as_slice();
    if !a_to_b && direction != u("b-to-a").as_slice() {
        issues.push(issue(
            "invalid-gradient-direction",
            u("Gradient direction must be a-to-b or b-to-a."),
            u("direction"),
        ));
    }
    if !is_safe_integer(sublayers) || sublayers < 0.0 {
        issues.push(issue(
            "invalid-sublayer-count",
            u("localZMaxSublayers must be a non-negative safe integer."),
            u("localZMaxSublayers"),
        ));
    }
    if !issues.is_empty() || ids.len() != 2 {
        return None;
    }
    Some(Projection {
        ui_mode: 3,
        component_a: ids[0],
        component_b: ids[1],
        mix_b_percent: 50.0,
        ratio_a: 1.0,
        ratio_b: 1.0,
        manual_pattern: Vec::new(),
        gradient_component_ids: Vec::new(),
        gradient_component_weights: Vec::new(),
        distribution_mode: LAYER_CYCLE,
        local_z_max_sublayers: js_math::max(2.0, sublayers),
        gradient_enabled: true,
        gradient_start: if a_to_b { 0.8 } else { 0.2 },
        gradient_end: if a_to_b { 0.2 } else { 0.8 },
    })
}

/// `projectMatch`: the projection and the normalized target.
fn match_projection(
    components: &[(f64, f64)],
    target_color: &[u16],
    min_component_percent: f64,
    physical_tool_count: f64,
    issues: &mut Vec<Issue>,
) -> (Option<Projection>, Option<Vec<u16>>) {
    let ids: Vec<f64> = components.iter().map(|c| c.0).collect();
    let raw: Vec<f64> = components.iter().map(|c| c.1).collect();
    component_ids(
        &ids,
        2,
        4,
        physical_tool_count,
        "components",
        Some("toolId"),
        issues,
    );
    weights_check(
        &raw,
        components.len(),
        "components",
        Some("weight"),
        true,
        issues,
    );
    minimum_percent(min_component_percent, issues);
    let normalized = color(
        target_color,
        u("targetColor"),
        "invalid-target-color",
        issues,
    );
    if !issues.is_empty() {
        return (None, normalized);
    }
    let weights = normalize_match_weights(&raw, components.len()).expect("checked weights");
    let mut active: Vec<(f64, f64)> = weights
        .iter()
        .enumerate()
        .filter(|(_, weight)| **weight > 0.0)
        .map(|(index, weight)| (ids[index], *weight))
        .collect();
    if !weights_within_range(&weights, min_component_percent) {
        for (index, weight) in weights.iter().enumerate() {
            if *weight > 0.0 && *weight < min_component_percent {
                issues.push(indexed(
                    "component-below-minimum",
                    cat(&[
                        &u("Active Match weight "),
                        &num(*weight),
                        &u("% is below the "),
                        &num(min_component_percent),
                        &u("% minimum."),
                    ]),
                    u(&format!("components[{index}].weight")),
                    index,
                ));
            }
        }
        if active.len() < 2 {
            issues.push(issue(
                "insufficient-active-components",
                u("Match requires at least two active components at the selected minimum."),
                u("components"),
            ));
        }
    }
    if components.len() >= 3 && active.len() < 3 {
        issues.push(issue(
            "insufficient-active-components",
            u("A multi-color Match recipe requires at least three positive components."),
            u("components"),
        ));
    }
    if !issues.is_empty() {
        return (None, normalized);
    }
    if components.len() == 2 {
        return (
            Some(Projection {
                ui_mode: 2,
                component_a: ids[0],
                component_b: ids[1],
                mix_b_percent: weights[1],
                ratio_a: 1.0,
                ratio_b: 1.0,
                manual_pattern: Vec::new(),
                gradient_component_ids: encode_ids(&ids),
                gradient_component_weights: Vec::new(),
                distribution_mode: SIMPLE,
                local_z_max_sublayers: 0.0,
                gradient_enabled: false,
                gradient_start: 0.8,
                gradient_end: 0.2,
            }),
            normalized,
        );
    }
    // A consistent comparator: any stable sort orders it as V8 does.
    active.sort_by(|left, right| {
        (right.1 - left.1)
            .partial_cmp(&0.0)
            .expect("finite")
            .then((left.0 - right.0).partial_cmp(&0.0).expect("finite"))
    });
    let ordered_ids: Vec<f64> = active.iter().map(|c| c.0).collect();
    let ordered_weights: Vec<f64> = active.iter().map(|c| c.1).collect();
    (
        Some(Projection {
            ui_mode: 2,
            component_a: ordered_ids[0],
            component_b: ordered_ids[1],
            mix_b_percent: 50.0,
            ratio_a: 1.0,
            ratio_b: 1.0,
            manual_pattern: Vec::new(),
            gradient_component_ids: encode_ids(&ordered_ids),
            gradient_component_weights: join(&ordered_weights),
            distribution_mode: LAYER_CYCLE,
            local_z_max_sublayers: 0.0,
            gradient_enabled: false,
            gradient_start: 0.8,
            gradient_end: 0.2,
        }),
        normalized,
    )
}

/// `ratioCadence`.
fn cadence(mix_b_percent: f64) -> (f64, f64) {
    if mix_b_percent <= 0.0 {
        return (1.0, 0.0);
    }
    if mix_b_percent >= 100.0 {
        return (0.0, 1.0);
    }
    let percent_a = 100.0 - mix_b_percent;
    let (mut left, mut right) = (percent_a.abs(), mix_b_percent.abs());
    while right != 0.0 {
        (left, right) = (right, left % right);
    }
    (percent_a / left, mix_b_percent / left)
}

fn tool_count(count: f64, issues: &mut Vec<Issue>) {
    if !is_safe_integer(count) || !(2.0..=MAX_PHYSICAL).contains(&count) {
        issues.push(issue(
            "invalid-physical-tool-count",
            u("physicalToolCount must be a safe integer from 2 to 64."),
            u("$options.physicalToolCount"),
        ));
    }
}

fn component_ids(
    ids: &[f64],
    minimum: usize,
    maximum: usize,
    physical_tool_count: f64,
    base: &str,
    nested: Option<&str>,
    issues: &mut Vec<Issue>,
) {
    if ids.len() < minimum || ids.len() > maximum {
        let count = if minimum == maximum {
            format!("exactly {minimum}")
        } else {
            format!("{minimum} to {maximum}")
        };
        issues.push(issue(
            "component-count",
            u(&format!("This mode requires {count} physical components.")),
            u(base),
        ));
    }
    let mut seen: Vec<f64> = Vec::new();
    for (index, id) in ids.iter().copied().enumerate() {
        let path = u(&match nested {
            Some(field) => format!("{base}[{index}].{field}"),
            None => format!("{base}[{index}]"),
        });
        if !is_safe_integer(id) || id < 1.0 || id > physical_tool_count || id > MAX_PHYSICAL {
            issues.push(indexed(
                "invalid-component-id",
                cat(&[
                    &u("Component "),
                    &num(id),
                    &u(" must be a one-based physical tool ID available in this project."),
                ]),
                path,
                index,
            ));
            continue;
        }
        if seen.contains(&id) {
            issues.push(indexed(
                "duplicate-component",
                cat(&[
                    &u("Physical tool "),
                    &num(id),
                    &u(" is already selected; every component must be unique."),
                ]),
                path,
                index,
            ));
        }
        seen.push(id);
    }
}

fn percent(value: f64, path: &str, issues: &mut Vec<Issue>) {
    if !is_safe_integer(value) || !(0.0..=100.0).contains(&value) {
        issues.push(issue(
            "invalid-percent",
            u(&format!("{path} must be an integer from 0 to 100.")),
            u(path),
        ));
    }
}

fn weights_check(
    weights: &[f64],
    expected: usize,
    base: &str,
    nested: Option<&str>,
    integer_only: bool,
    issues: &mut Vec<Issue>,
) {
    if weights.len() != expected {
        issues.push(issue(
            "component-count",
            u(&format!(
                "Expected {expected} weights, received {}.",
                weights.len()
            )),
            u(base),
        ));
    }
    let mut total = 0.0;
    for (index, weight) in weights.iter().copied().enumerate() {
        let path = u(&match nested {
            Some(field) => format!("{base}[{index}].{field}"),
            None => format!("{base}[{index}]"),
        });
        if !weight.is_finite() || weight < 0.0 || (integer_only && !is_safe_integer(weight)) {
            let message = if integer_only {
                "Weights must be finite, non-negative safe integers."
            } else {
                "Weights must be finite and non-negative."
            };
            issues.push(indexed("invalid-weight", u(message), path, index));
        } else {
            total += weight;
        }
    }
    let invalid_total = !total.is_finite() || (integer_only && !is_safe_integer(total));
    if !weights.is_empty() && (total <= 0.0 || invalid_total) {
        issues.push(issue(
            "invalid-weight-total",
            u(if invalid_total {
                "The combined weight must be finite and safely representable."
            } else {
                "At least one weight must be positive."
            }),
            u(base),
        ));
    }
}

fn minimum_percent(value: f64, issues: &mut Vec<Issue>) {
    if !is_safe_integer(value) || !(0.0..=50.0).contains(&value) {
        issues.push(issue(
            "invalid-min-component-percent",
            u("Match minimum component percent must be an integer from 0 to 50."),
            u("minComponentPercent"),
        ));
    }
}

/// `validateColor`: the normalized colour, or an issue spanning the whole value.
fn color(
    value: &[u16],
    path: Vec<u16>,
    code: &'static str,
    issues: &mut Vec<Issue>,
) -> Option<Vec<u16>> {
    if let Some(normalized) = match_hex(value) {
        return Some(normalized);
    }
    let mut made = issue(
        code,
        u("Color must contain exactly six hexadecimal RGB digits, with an optional leading #."),
        path,
    );
    made.location.start_offset = Some(0);
    made.location.end_offset = Some(value.len());
    issues.push(made);
    None
}

/// `encodeGradientComponentIds`: compact digits, or slash-separated past 9.
pub fn encode_ids(ids: &[f64]) -> Vec<u16> {
    let extended = ids.iter().any(|id| *id > 9.0);
    if extended && ids.len() == 1 {
        return cat(&[&u("/"), &num(ids[0])]);
    }
    let parts: Vec<Vec<u16>> = ids.iter().map(|id| num(*id)).collect();
    let separator: &[u16] = if extended { &[0x2f] } else { &[] };
    parts.join(separator)
}
fn join(values: &[f64]) -> Vec<u16> {
    let parts: Vec<Vec<u16>> = values.iter().map(|value| num(*value)).collect();
    parts.join(&[u16::from(b'/')][..])
}
fn lround(value: f64) -> f64 {
    (value + 0.5).floor()
}
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    js_math::min(maximum, js_math::max(minimum, value))
}
