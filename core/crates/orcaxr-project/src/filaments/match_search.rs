//! The pinned Match search over a supplied palette (`colorMatchSearch.ts`,
//! after Snapmaker Orca v2.3.4's `MixedColorMatchHelpers.cpp`): every
//! compatible pair coarsely at 5 % steps with a bounded heap of the best 30
//! refined to 1 %, then — unless a pair is already within ΔE 0.5 — triples of
//! the eight heads nearest the target at 10 % refined around the best 20,
//! every preview from the pigment polynomial and every ΔE from the helper's
//! float-staged sRGB → Lab → CIEDE2000, and finally the pinned preference
//! for a pair within 0.5 of a triple.
use super::authoring::{self, Projection};
use super::compatibility::{Category, material_category};
use super::pigment::{blend_multi, blend_pair};
use super::text::{match_hex, u};
use crate::js_math::{self, convert::is_safe_integer};
use std::collections::HashMap;

/// One palette entry: a colour and its pinned `filament_type`.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub color: Vec<u16>,
    pub filament_type: Vec<u16>,
}

/// `SuppliedPaletteMatchIssue`.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub message: &'static str,
    pub path: String,
}

/// `SuppliedPaletteMatchRecipe`.
#[derive(Debug, Clone, PartialEq)]
pub struct Recipe {
    /// `pair` or `triple`.
    pub kind: &'static str,
    /// One-based palette positions and integer percentages.
    pub components: Vec<(f64, f64)>,
    pub preview_color: Vec<u16>,
    pub delta_e2000: Option<f64>,
    pub projection: Projection,
}

/// `SuppliedPaletteMatchSearchStats`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stats {
    pub pair_coarse: u32,
    pub pair_fine: u32,
    pub triple_coarse: u32,
    pub triple_fine: u32,
    pub candidate_pool: Vec<usize>,
    pub early_pair_exit: bool,
}

/// `SuppliedPaletteMatchSearchResult` (its coverage is always the pinned bundled table's).
#[derive(Debug, Clone, PartialEq)]
pub struct Searched {
    pub ok: bool,
    pub normalized_target_color: Option<Vec<u16>>,
    pub recipe: Option<Recipe>,
    pub best_pair: Option<Recipe>,
    pub issues: Vec<Issue>,
    pub stats: Stats,
}

#[derive(Clone)]
struct Internal {
    kind: &'static str,
    ids: Vec<usize>,
    weights: Vec<f64>,
    preview: Vec<u16>,
    delta_e2000: f64,
}

#[derive(Clone, Copy)]
struct PairEntry {
    delta_e2000: f64,
    first: usize,
    second: usize,
    percent: f64,
}
#[derive(Clone, Copy)]
struct TripleEntry {
    delta_e2000: f64,
    first: usize,
    second: usize,
    third: usize,
    first_weight: f64,
    second_weight: f64,
}

/// `searchSuppliedPaletteColorMatch`.
#[allow(clippy::needless_range_loop)] // the pair loop's indices, as in the TS
pub fn search(palette: &[Entry], target_color: &[u16], min_component_percent: f64) -> Searched {
    let mut issues = Vec::new();
    let validated = validate(palette, min_component_percent, &mut issues);
    let target = strict(target_color);
    if target.is_none() {
        issues.push(make(
            "invalid-target-color",
            "Target color must be exactly six hexadecimal RGB digits.",
            "targetColor".into(),
        ));
    }
    let mut stats = Stats::default();
    let (Some((colors, categories)), Some(target)) = (validated, target) else {
        return Searched {
            ok: false,
            normalized_target_color: strict(target_color),
            recipe: None,
            best_pair: None,
            issues,
            stats,
        };
    };

    let target_lab = pinned_lab(&target);
    let palette_lab: Vec<[f64; 3]> = colors.iter().map(|color| pinned_lab(color)).collect();
    let compatible = matrix(&categories);
    let loop_minimum = js_math::max(1.0, clamp(min_component_percent, 0.0, 50.0));
    let mut pair_heap: Heap<PairEntry> = Heap::new(30, |entry| entry.delta_e2000);
    let mut previews: HashMap<(usize, usize, i64), Vec<u16>> = HashMap::new();
    let mut best: Option<Internal> = None;

    let mut pair_preview = |first: usize, second: usize, percent: f64| -> Vec<u16> {
        previews
            .entry((first, second, percent as i64))
            .or_insert_with(|| {
                let ratio = f64::from((f64::from(percent as f32) / f64::from(100f32)) as f32);
                u(&blend_pair(&colors[first - 1], &colors[second - 1], ratio))
            })
            .clone()
    };
    let update = |best: &mut Option<Internal>, candidate: Internal| {
        let replaces = match best {
            None => true,
            Some(current) => candidate.delta_e2000 + 1e-6 < current.delta_e2000,
        };
        if replaces {
            *best = Some(candidate);
        }
    };

    let count = colors.len();
    for first in 0..count {
        for second in first + 1..count {
            if !compatible[first][second] {
                continue;
            }
            let mut percent = loop_minimum;
            while percent <= 100.0 - loop_minimum {
                let preview = pair_preview(first + 1, second + 1, percent);
                let delta_e2000 = pinned_delta_e(target_lab, pinned_lab(&preview));
                stats.pair_coarse += 1;
                update(
                    &mut best,
                    Internal {
                        kind: "pair",
                        ids: vec![first + 1, second + 1],
                        weights: vec![100.0 - percent, percent],
                        preview,
                        delta_e2000,
                    },
                );
                pair_heap.offer(PairEntry {
                    delta_e2000,
                    first: first + 1,
                    second: second + 1,
                    percent,
                });
                percent += 5.0;
            }
        }
    }
    for coarse in pair_heap.drain_worst_first() {
        let minimum = js_math::max(loop_minimum, coarse.percent - 5.0 + 1.0);
        let maximum = js_math::min(100.0 - loop_minimum, coarse.percent + 5.0 - 1.0);
        let mut percent = minimum;
        while percent <= maximum {
            if (percent - loop_minimum) % 5.0 != 0.0 {
                let preview = pair_preview(coarse.first, coarse.second, percent);
                let delta_e2000 = pinned_delta_e(target_lab, pinned_lab(&preview));
                stats.pair_fine += 1;
                update(
                    &mut best,
                    Internal {
                        kind: "pair",
                        ids: vec![coarse.first, coarse.second],
                        weights: vec![100.0 - percent, percent],
                        preview,
                        delta_e2000,
                    },
                );
            }
            percent += 1.0;
        }
    }

    let mut best_pair = best.clone();
    if let Some(pair) = &best_pair
        && pair.delta_e2000 <= 0.5
    {
        stats.early_pair_exit = true;
        let public = public_recipe(
            pair,
            min_component_percent,
            Some(&target),
            Some(pair.delta_e2000),
        );
        return Searched {
            ok: issues.is_empty(),
            normalized_target_color: Some(target),
            recipe: Some(public.clone()),
            best_pair: Some(public),
            issues,
            stats,
        };
    }

    let mut ranked: Vec<(f64, usize)> = palette_lab
        .iter()
        .enumerate()
        .map(|(index, lab)| (pinned_delta_e(target_lab, *lab), index + 1))
        .collect();
    // `left.deltaE2000 - right.deltaE2000 || left.id - right.id`: a total order.
    ranked.sort_by(|left, right| {
        (left.0 - right.0)
            .partial_cmp(&0.0)
            .expect("finite")
            .then(left.1.cmp(&right.1))
    });
    let mut pool: Vec<usize> = ranked
        .iter()
        .take(count.min(8))
        .map(|entry| entry.1)
        .collect();
    pool.sort_unstable();
    stats.candidate_pool = pool.clone();

    if pool.len() >= 3 {
        let mut triple_heap: Heap<TripleEntry> = Heap::new(20, |entry| entry.delta_e2000);
        let evaluate =
            |first: usize, second: usize, third: usize, first_weight: f64, second_weight: f64| {
                let third_weight = 100.0 - first_weight - second_weight;
                let preview = u(&blend_multi(&[
                    (&colors[first - 1], first_weight),
                    (&colors[second - 1], second_weight),
                    (&colors[third - 1], third_weight),
                ]));
                let delta_e2000 = pinned_delta_e(target_lab, pinned_lab(&preview));
                (preview, delta_e2000)
            };
        let triple =
            |first, second, third, first_weight: f64, second_weight: f64, preview, delta_e2000| {
                Internal {
                    kind: "triple",
                    ids: vec![first, second, third],
                    weights: vec![
                        first_weight,
                        second_weight,
                        100.0 - first_weight - second_weight,
                    ],
                    preview,
                    delta_e2000,
                }
            };
        for a in 0..pool.len() {
            for b in a + 1..pool.len() {
                for c in b + 1..pool.len() {
                    let (first, second, third) = (pool[a], pool[b], pool[c]);
                    if !compatible[first - 1][second - 1]
                        || !compatible[second - 1][third - 1]
                        || !compatible[first - 1][third - 1]
                    {
                        continue;
                    }
                    let mut first_weight = loop_minimum;
                    while first_weight <= 100.0 - 2.0 * loop_minimum {
                        let mut second_weight = loop_minimum;
                        while first_weight + second_weight <= 100.0 - loop_minimum {
                            let (preview, delta_e2000) =
                                evaluate(first, second, third, first_weight, second_weight);
                            stats.triple_coarse += 1;
                            update(
                                &mut best,
                                triple(
                                    first,
                                    second,
                                    third,
                                    first_weight,
                                    second_weight,
                                    preview,
                                    delta_e2000,
                                ),
                            );
                            triple_heap.offer(TripleEntry {
                                delta_e2000,
                                first,
                                second,
                                third,
                                first_weight,
                                second_weight,
                            });
                            second_weight += 10.0;
                        }
                        first_weight += 10.0;
                    }
                }
            }
        }
        for coarse in triple_heap.drain_worst_first() {
            let first_minimum = js_math::max(loop_minimum, coarse.first_weight - 10.0 + 1.0);
            let first_maximum =
                js_math::min(100.0 - 2.0 * loop_minimum, coarse.first_weight + 10.0 - 1.0);
            let mut first_weight = first_minimum;
            while first_weight <= first_maximum {
                if (first_weight - loop_minimum) % 10.0 != 0.0 {
                    let second_minimum =
                        js_math::max(loop_minimum, coarse.second_weight - 10.0 + 1.0);
                    let second_maximum = js_math::min(
                        100.0 - first_weight - loop_minimum,
                        coarse.second_weight + 10.0 - 1.0,
                    );
                    let mut second_weight = second_minimum;
                    while second_weight <= second_maximum {
                        if (second_weight - loop_minimum) % 10.0 != 0.0
                            && 100.0 - first_weight - second_weight >= loop_minimum
                        {
                            let (preview, delta_e2000) = evaluate(
                                coarse.first,
                                coarse.second,
                                coarse.third,
                                first_weight,
                                second_weight,
                            );
                            stats.triple_fine += 1;
                            update(
                                &mut best,
                                triple(
                                    coarse.first,
                                    coarse.second,
                                    coarse.third,
                                    first_weight,
                                    second_weight,
                                    preview,
                                    delta_e2000,
                                ),
                            );
                        }
                        second_weight += 1.0;
                    }
                }
                first_weight += 1.0;
            }
        }
    }

    let mut finalized = best;
    if let Some(winner) = finalized.as_mut() {
        winner.delta_e2000 =
            pinned_color_delta_e(&target, &winner.preview).expect("normalized colours");
    }
    if let Some(pair) = best_pair.as_mut() {
        pair.delta_e2000 =
            pinned_color_delta_e(&target, &pair.preview).expect("normalized colours");
        match &finalized {
            None => finalized = Some(pair.clone()),
            Some(winner) if pair.delta_e2000 + 1e-6 < winner.delta_e2000 => {
                finalized = Some(pair.clone())
            }
            Some(winner)
                if winner.kind == "triple" && pair.delta_e2000 <= winner.delta_e2000 + 0.5 =>
            {
                finalized = Some(pair.clone())
            }
            _ => {}
        }
    }
    if finalized.is_none() {
        issues.push(make(
            "no-compatible-recipe",
            "The supplied palette has no compatible two- or three-filament Match recipe.",
            "palette".into(),
        ));
    }
    let recipe = finalized.map(|r| {
        public_recipe(
            &r,
            min_component_percent,
            Some(&target),
            Some(r.delta_e2000),
        )
    });
    Searched {
        ok: issues.is_empty() && recipe.is_some(),
        normalized_target_color: Some(target.clone()),
        recipe,
        best_pair: best_pair.map(|r| {
            public_recipe(
                &r,
                min_component_percent,
                Some(&target),
                Some(r.delta_e2000),
            )
        }),
        issues,
        stats,
    }
}

/// `pinnedColorDeltaE2000`: the helper's float-staged ΔE between two colours.
pub fn pinned_color_delta_e(first: &[u16], second: &[u16]) -> Option<f64> {
    Some(pinned_delta_e(
        pinned_lab(&strict(first)?),
        pinned_lab(&strict(second)?),
    ))
}

/// `makePublicRecipe`: the recipe checked as a Match recipe of its own.
fn public_recipe(
    recipe: &Internal,
    minimum: f64,
    target: Option<&[u16]>,
    known: Option<f64>,
) -> Recipe {
    let components: Vec<(f64, f64)> = recipe
        .ids
        .iter()
        .zip(&recipe.weights)
        .map(|(id, weight)| (*id as f64, *weight))
        .collect();
    let tool_count = recipe.ids.iter().copied().max().unwrap_or(0) as f64;
    let authored = authoring::project(
        &authoring::Input::Match {
            components: components.clone(),
            target_color: target.map_or_else(|| recipe.preview.clone(), <[u16]>::to_vec),
            min_component_percent: minimum,
        },
        tool_count,
    );
    let projection = authored
        .projection
        .filter(|_| authored.ok)
        .expect("Internal Match candidate violated the pinned authoring contract");
    Recipe {
        kind: recipe.kind,
        components,
        preview_color: recipe.preview.clone(),
        delta_e2000: target.map(|target| {
            known.unwrap_or_else(|| pinned_color_delta_e(target, &recipe.preview).expect("colours"))
        }),
        projection,
    }
}

fn validate(
    palette: &[Entry],
    minimum: f64,
    issues: &mut Vec<Issue>,
) -> Option<(Vec<Vec<u16>>, Vec<Category>)> {
    if palette.len() < 2 || palette.len() > authoring::MAX_PHYSICAL as usize {
        issues.push(make(
            "palette-size",
            "Palette must contain 2 to 64 physical filaments.",
            "palette".into(),
        ));
    }
    if !is_safe_integer(minimum) || !(0.0..=50.0).contains(&minimum) {
        issues.push(make(
            "invalid-min-component-percent",
            "Minimum component percent must be an integer from 0 to 50.",
            "minComponentPercent".into(),
        ));
    }
    let mut colors = Vec::new();
    let mut categories = Vec::new();
    for (index, entry) in palette.iter().enumerate() {
        match strict(&entry.color) {
            Some(color) => colors.push(color),
            None => issues.push(make(
                "invalid-palette-color",
                "Palette color must be exactly six hexadecimal RGB digits.",
                format!("palette[{index}].color"),
            )),
        }
        match material_category(&entry.filament_type) {
            Some(category) => categories.push(category),
            None => issues.push(make(
                "invalid-filament-type",
                "Filament type is not classified by the pinned material compatibility table.",
                format!("palette[{index}].filamentType"),
            )),
        }
    }
    issues.is_empty().then_some((colors, categories))
}

/// `buildCompatibilityMatrix`: a head is compatible with itself; others by the pinned table.
fn matrix(categories: &[Category]) -> Vec<Vec<bool>> {
    categories
        .iter()
        .enumerate()
        .map(|(i, first)| {
            categories
                .iter()
                .enumerate()
                .map(|(j, second)| i == j || super::compatibility::compatible(*first, *second))
                .collect()
        })
        .collect()
}

/// `normalizeStrictColor`.
fn strict(value: &[u16]) -> Option<Vec<u16>> {
    match_hex(value)
}

fn f32r(value: f64) -> f64 {
    f64::from(value as f32)
}

/// `pinnedSrgbToLab`: float-staged as the helper stores its intermediates.
fn pinned_lab(color: &[u16]) -> [f64; 3] {
    let rgb = super::pigment::parse_color(color);
    let red = f32r(f64::from(rgb[0]) / 255.0);
    let green = f32r(f64::from(rgb[1]) / 255.0);
    let blue = f32r(f64::from(rgb[2]) / 255.0);
    let linear_red = f32r(pivot_rgb(red));
    let linear_green = f32r(pivot_rgb(green));
    let linear_blue = f32r(pivot_rgb(blue));
    let x = linear3(
        0.412453,
        linear_red,
        0.35758,
        linear_green,
        0.180423,
        linear_blue,
    );
    let y = linear3(
        0.212671,
        linear_red,
        0.71516,
        linear_green,
        0.072169,
        linear_blue,
    );
    let z = linear3(
        0.019334,
        linear_red,
        0.119193,
        linear_green,
        0.950227,
        linear_blue,
    );
    let pivot_x = pivot_xyz(x / 95.047);
    let pivot_y = pivot_xyz(y / 100.0);
    let pivot_z = pivot_xyz(z / 108.883);
    [
        f32r(116.0 * pivot_y - 16.0),
        f32r(500.0 * (pivot_x - pivot_y)),
        f32r(200.0 * (pivot_y - pivot_z)),
    ]
}
fn linear3(a: f64, x: f64, b: f64, y: f64, c: f64, z: f64) -> f64 {
    let first = f32r(f32r(a) * x);
    let second = f32r(f32r(b) * y);
    let third = f32r(f32r(c) * z);
    f32r(f32r(first + second) + third)
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

/// `pinnedDeltaE2000Lab`.
fn pinned_delta_e(first: [f64; 3], second: [f64; 3]) -> f64 {
    let pow = js_math::pow;
    let radians = |degrees: f64| (2.0 * std::f64::consts::PI * degrees) / 360.0;
    let average_l = f32r(f32r(first[0] + second[0]) / 2.0);
    let c1 = f32r((pow(first[1], 2.0) + pow(first[2], 2.0)).sqrt());
    let c2 = f32r((pow(second[1], 2.0) + pow(second[2], 2.0)).sqrt());
    let average_c = f32r(f32r(c1 + c2) / 2.0);
    let average_c7 = pow(average_c, 7.0);
    let g = f32r((1.0 - (average_c7 / (average_c7 + pow(25.0, 7.0))).sqrt()) / 2.0);
    let a1_prime = f32r(first[1] * (1.0 + g));
    let a2_prime = f32r(second[1] * (1.0 + g));
    let c1_prime = f32r((pow(a1_prime, 2.0) + pow(first[2], 2.0)).sqrt());
    let c2_prime = f32r((pow(a2_prime, 2.0) + pow(second[2], 2.0)).sqrt());
    let average_c_prime = f32r(f32r(c1_prime + c2_prime) / 2.0);
    let mut h1_prime =
        f32r((360.0 * js_math::atan2(first[2], a1_prime)) / (2.0 * std::f64::consts::PI));
    let mut h2_prime =
        f32r((360.0 * js_math::atan2(second[2], a2_prime)) / (2.0 * std::f64::consts::PI));
    if h1_prime < 0.0 {
        h1_prime = f32r(h1_prime + 360.0);
    }
    if h2_prime < 0.0 {
        h2_prime = f32r(h2_prime + 360.0);
    }
    let hue_difference = f32r(f32r(h1_prime - h2_prime).abs());
    let average_h_prime = if hue_difference > 180.0 {
        f32r(f32r(f32r(h1_prime + h2_prime) + 360.0) / 2.0)
    } else {
        f32r(f32r(h1_prime + h2_prime) / 2.0)
    };
    let t = f32r(
        1.0 - 0.17 * js_math::cos(radians(f32r(average_h_prime - 30.0)))
            + 0.24 * js_math::cos(radians(f32r(2.0 * average_h_prime)))
            + 0.32 * js_math::cos(radians(f32r(f32r(3.0 * average_h_prime) + 6.0)))
            - 0.2 * js_math::cos(radians(f32r(f32r(4.0 * average_h_prime) - 63.0))),
    );
    let mut delta_h_prime = f32r(h2_prime - h1_prime);
    if delta_h_prime.abs() > 180.0 {
        delta_h_prime = f32r(delta_h_prime + if h2_prime <= h1_prime { 360.0 } else { -360.0 });
    }
    let delta_l_prime = f32r(second[0] - first[0]);
    let delta_c_prime = f32r(c2_prime - c1_prime);
    let chroma_root = f32r(f32r(c1_prime * c2_prime).sqrt());
    delta_h_prime = f32r(2.0 * chroma_root * js_math::sin(radians(delta_h_prime) / 2.0));
    let average_l_minus_50 = average_l - 50.0;
    let s_l = f32r(
        1.0 + (0.015 * pow(average_l_minus_50, 2.0)) / (20.0 + pow(average_l_minus_50, 2.0)).sqrt(),
    );
    let s_c = f32r(1.0 + 0.045 * average_c_prime);
    let s_h = f32r(1.0 + 0.015 * average_c_prime * t);
    let delta_rotation = f32r(30.0 * js_math::exp(-pow((average_h_prime - 275.0) / 25.0, 2.0)));
    let average_c_prime7 = pow(average_c_prime, 7.0);
    let r_c = f32r(2.0 * (average_c_prime7 / (average_c_prime7 + pow(25.0, 7.0))).sqrt());
    let r_t = f32r(-r_c * js_math::sin(2.0 * radians(delta_rotation)));
    let lightness = f32r(delta_l_prime / s_l);
    let chroma = f32r(delta_c_prime / s_c);
    let hue = f32r(delta_h_prime / s_h);
    let rotation = f32r(f32r(r_t * chroma) * hue);
    f32r((pow(lightness, 2.0) + pow(chroma, 2.0) + pow(hue, 2.0) + rotation).sqrt())
}

fn make(code: &'static str, message: &'static str, path: String) -> Issue {
    Issue {
        code,
        message,
        path,
    }
}
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    js_math::min(maximum, js_math::max(minimum, value))
}

/// `BoundedWorstHeap`: the best `capacity` entries by score, kept as a
/// max-heap of the worst first, with the browser's exact sift steps (which
/// decide the order equal scores drain in).
struct Heap<T> {
    values: Vec<T>,
    capacity: usize,
    score: fn(&T) -> f64,
}
impl<T: Copy> Heap<T> {
    fn new(capacity: usize, score: fn(&T) -> f64) -> Self {
        Self {
            values: Vec::new(),
            capacity,
            score,
        }
    }
    fn offer(&mut self, value: T) {
        if self.values.len() < self.capacity {
            self.values.push(value);
            self.bubble_up(self.values.len() - 1);
            return;
        }
        if !self.values.is_empty() && (self.score)(&value) < (self.score)(&self.values[0]) {
            self.values[0] = value;
            self.bubble_down(0);
        }
    }
    fn drain_worst_first(&mut self) -> Vec<T> {
        let mut drained = Vec::new();
        while !self.values.is_empty() {
            let worst = self.values[0];
            let tail = self.values.pop().expect("non-empty");
            if !self.values.is_empty() {
                self.values[0] = tail;
                self.bubble_down(0);
            }
            drained.push(worst);
        }
        drained
    }
    fn bubble_up(&mut self, start: usize) {
        let mut index = start;
        while index > 0 {
            let parent = (index - 1) / 2;
            if (self.score)(&self.values[parent]) < (self.score)(&self.values[index]) {
                self.values.swap(parent, index);
                index = parent;
            } else {
                break;
            }
        }
    }
    fn bubble_down(&mut self, start: usize) {
        let mut index = start;
        loop {
            let left = index * 2 + 1;
            let right = left + 1;
            let mut largest = index;
            if left < self.values.len()
                && (self.score)(&self.values[largest]) < (self.score)(&self.values[left])
            {
                largest = left;
            }
            if right < self.values.len()
                && (self.score)(&self.values[largest]) < (self.score)(&self.values[right])
            {
                largest = right;
            }
            if largest == index {
                return;
            }
            self.values.swap(index, largest);
            index = largest;
        }
    }
}
