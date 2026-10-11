//! The canonical FullSpectrum recipe (`fullSpectrumRecipe.ts`): a complete
//! mixed-filament row built from an authored draft over the project's stable
//! physical IDs — each mode through the pinned authoring projection, Cycle
//! groups kept exactly, the engine's component pair chosen as the pinned
//! manager chooses it — refused in the browser's words, and the replacement
//! an edit makes of an existing row.
use super::authoring::{self, Input, Projection};
use super::auto_pairs::stable_numeric_id;
use super::compatibility::{Decision, inspect};
use super::text::{cat, num, six_digit, u};
use crate::ids::PhysicalFilamentId;
use crate::js_math::{self, convert::json_stringify, convert::trim_utf16};
use crate::model::{MixedFilament, PhysicalFilament};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

/// `FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM`.
pub const MAX_SURFACE_OFFSET_MM: f64 = 2.0;

/// A draft's mode (`FullSpectrumRecipeDraft`), on stable physical IDs.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftMode {
    Ratio {
        components: Vec<Vec<u16>>,
        mix_b_percent: f64,
        triangle: Option<Vec<f64>>,
    },
    Cycle {
        groups: Vec<Vec<Vec<u16>>>,
    },
    Match {
        components: Vec<(Vec<u16>, f64)>,
        target_color: Vec<u16>,
        min_component_percent: f64,
    },
    Gradient {
        components: [Vec<u16>; 2],
        a_to_b: bool,
        local_z_max_sublayers: f64,
    },
}

/// `FullSpectrumRecipeDraft`.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub name: Vec<u16>,
    pub display_color: Vec<u16>,
    pub enabled: Option<bool>,
    pub offset_a: Option<f64>,
    pub offset_b: Option<f64>,
    pub mode: DraftMode,
}

/// A recipe's distribution.
#[derive(Debug, Clone, PartialEq)]
pub enum Distribution {
    Ratio,
    Cycle,
    Match {
        target_color: Vec<u16>,
    },
    Gradient {
        start_weights: Vec<f64>,
        end_weights: Vec<f64>,
    },
}

/// `FullSpectrumRecipeState` (schema version 1, no pointillism).
#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub upstream_stable_id: Vec<u16>,
    pub ui_mode: f64,
    pub component_a_id: Vec<u16>,
    pub component_b_id: Vec<u16>,
    pub ratio_a: f64,
    pub ratio_b: f64,
    pub mix_b_percent: f64,
    pub manual_pattern_groups: Vec<Vec<Vec<u16>>>,
    pub gradient_component_ids: Vec<Vec<u16>>,
    pub gradient_component_weights: Vec<f64>,
    pub distribution_mode: f64,
    pub local_z_max_sublayers: f64,
    pub gradient_enabled: bool,
    pub gradient_start: f64,
    pub gradient_end: f64,
    pub offset_a: f64,
    pub offset_b: f64,
    pub deleted: bool,
    pub custom: bool,
    pub origin_auto: bool,
}

/// A built row: what `createFullSpectrumMixedFilament` returns (its
/// configuration empty unless it replaces a row).
#[derive(Debug, Clone, PartialEq)]
pub struct Recipe {
    pub id: Vec<u16>,
    pub name: Vec<u16>,
    pub display_color: Vec<u16>,
    pub components: Vec<(Vec<u16>, f64)>,
    pub distribution: Distribution,
    pub full_spectrum: State,
    pub enabled: bool,
}

type Refusal = Vec<u16>;

/// `createFullSpectrumMixedFilament`: `upstream` defaults to the ID's stable number.
pub fn create(
    id: &[u16],
    physical: &[Arc<PhysicalFilament>],
    draft: &Draft,
    upstream: Option<&[u16]>,
) -> Result<Recipe, Refusal> {
    let name = trim_utf16(&draft.name).to_vec();
    let display_color = display_color(&draft.display_color)?;
    if name.is_empty() {
        return Err(u("Virtual filament name cannot be empty"));
    }
    for (label, value) in [
        ("Component A surface offset", draft.offset_a.unwrap_or(0.0)),
        ("Component B surface offset", draft.offset_b.unwrap_or(0.0)),
    ] {
        if !value.is_finite() || value.abs() > MAX_SURFACE_OFFSET_MM {
            return Err(u(&format!("{label} must be within -2 mm and 2 mm")));
        }
    }
    library(physical)?;
    let upstream = upstream.map_or_else(|| u(&stable_numeric_id(id)), <[u16]>::to_vec);
    unsigned64(&upstream)?;
    let (components, distribution, mut state) = match &draft.mode {
        DraftMode::Ratio {
            components,
            mix_b_percent,
            triangle,
        } => {
            let mut tools = Vec::new();
            for (index, id) in components.iter().enumerate() {
                tools.push(enabled_tool(
                    physical,
                    id,
                    &format!("Ratio component {}", index + 1),
                )?);
            }
            let projection = require(
                &Input::Ratio {
                    component_ids: tools,
                    mix_b_percent: *mix_b_percent,
                    triangle: triangle.clone(),
                },
                physical.len(),
            )?;
            let weights = if projection.gradient_component_weights.is_empty() {
                vec![100.0 - projection.mix_b_percent, projection.mix_b_percent]
            } else {
                decode_weights(&projection.gradient_component_weights)
            };
            from_projection(physical, &projection, Distribution::Ratio, weights)?
        }
        DraftMode::Match {
            components,
            target_color,
            min_component_percent,
        } => {
            let mut inputs = Vec::new();
            for (index, (id, weight)) in components.iter().enumerate() {
                inputs.push((
                    enabled_tool(physical, id, &format!("Match component {}", index + 1))?,
                    *weight,
                ));
            }
            let projection = require(
                &Input::Match {
                    components: inputs,
                    target_color: target_color.clone(),
                    min_component_percent: *min_component_percent,
                },
                physical.len(),
            )?;
            let weights = if projection.gradient_component_weights.is_empty() {
                vec![100.0 - projection.mix_b_percent, projection.mix_b_percent]
            } else {
                decode_weights(&projection.gradient_component_weights)
            };
            let target = Distribution::Match {
                target_color: self::display_color(target_color)?,
            };
            from_projection(physical, &projection, target, weights)?
        }
        DraftMode::Gradient {
            components,
            a_to_b,
            local_z_max_sublayers,
        } => {
            let mut tools = Vec::new();
            for (index, id) in components.iter().enumerate() {
                tools.push(enabled_tool(
                    physical,
                    id,
                    &format!("Gradient component {}", index + 1),
                )?);
            }
            let projection = require(
                &Input::Gradient {
                    component_ids: tools,
                    direction: u(if *a_to_b { "a-to-b" } else { "b-to-a" }),
                    local_z_max_sublayers: *local_z_max_sublayers,
                },
                physical.len(),
            )?;
            let (start_weights, end_weights) = if *a_to_b {
                (
                    vec![projection.gradient_start, 1.0 - projection.gradient_start],
                    vec![projection.gradient_end, 1.0 - projection.gradient_end],
                )
            } else {
                (vec![0.2, 0.8], vec![0.8, 0.2])
            };
            from_projection(
                physical,
                &projection,
                Distribution::Gradient {
                    start_weights,
                    end_weights,
                },
                vec![50.0, 50.0],
            )?
        }
        DraftMode::Cycle { groups } => cycle(physical, groups)?,
    };
    let compatibility_ids: Vec<PhysicalFilamentId> = if state.manual_pattern_groups.is_empty() {
        [&state.component_a_id, &state.component_b_id]
            .into_iter()
            .chain(&state.gradient_component_ids)
            .map(|id| PhysicalFilamentId::try_from_utf16(id.clone()).expect("a library head"))
            .collect()
    } else {
        state
            .manual_pattern_groups
            .iter()
            .flatten()
            .map(|id| PhysicalFilamentId::try_from_utf16(id.clone()).expect("a library head"))
            .collect()
    };
    if let Decision::Refused { reason, .. } = inspect(physical, &compatibility_ids) {
        return Err(reason.units().to_vec());
    }
    state.upstream_stable_id = upstream;
    state.offset_a = draft.offset_a.unwrap_or(0.0);
    state.offset_b = draft.offset_b.unwrap_or(0.0);
    Ok(Recipe {
        id: id.to_vec(),
        name,
        display_color,
        components,
        distribution,
        full_spectrum: state,
        enabled: draft.enabled.unwrap_or(true),
    })
}

/// `replaceFullSpectrumMixedFilament`: the row rebuilt from `draft` under its
/// own identity and stable number, keeping its availability unless the draft
/// sets it, and its automatic origin.
pub fn replace(
    current: &MixedFilament,
    physical: &[Arc<PhysicalFilament>],
    draft: &Draft,
) -> Result<Recipe, Refusal> {
    let upstream = match &current.full_spectrum {
        Some(state) => state.upstream_stable_id.units().to_vec(),
        None => u(&stable_numeric_id(current.id.as_utf16())),
    };
    let mut replacement = create(current.id.as_utf16(), physical, draft, Some(&upstream))?;
    if draft.enabled.is_none() {
        replacement.enabled = current.enabled;
    }
    if current
        .full_spectrum
        .as_ref()
        .is_some_and(|state| state.origin_auto)
    {
        replacement.full_spectrum.origin_auto = true;
    }
    Ok(replacement)
}

/// `stableCycleGroupsFromToolIds`: one-based groups on the stable IDs, exactly.
pub fn stable_cycle_groups(
    physical: &[Arc<PhysicalFilament>],
    groups: &[Vec<f64>],
) -> Result<Vec<Vec<Vec<u16>>>, Refusal> {
    library(physical)?;
    if groups.is_empty() || groups.iter().any(Vec::is_empty) {
        return Err(u("Cycle needs at least one non-empty perimeter group"));
    }
    groups
        .iter()
        .enumerate()
        .map(|(group_index, group)| {
            group
                .iter()
                .enumerate()
                .map(|(token_index, tool)| {
                    if !js_math::convert::is_safe_integer(*tool)
                        || *tool < 1.0
                        || *tool > physical.len() as f64
                    {
                        return Err(cat(&[
                            &u(&format!(
                                "Cycle group {} token {} references unknown physical tool ",
                                group_index + 1,
                                token_index + 1
                            )),
                            &num(*tool),
                        ]));
                    }
                    Ok(physical[*tool as usize - 1].id.as_utf16().to_vec())
                })
                .collect()
        })
        .collect()
}

impl Recipe {
    /// The row as the canonical model stores it.
    pub fn to_value(&self) -> Value {
        let mut fields = BTreeMap::from([
            field("id", text(&self.id)),
            field("name", text(&self.name)),
            field("displayColor", text(&self.display_color)),
            field("components", components_value(&self.components)),
            field("distribution", distribution_value(&self.distribution)),
            field("fullSpectrum", state_value(&self.full_spectrum)),
            field("config", Value::Object(BTreeMap::new())),
        ]);
        fields.insert(u("enabled"), Value::Bool(self.enabled));
        Value::Object(fields)
    }
    /// The row as a project record.
    pub fn to_model(&self) -> MixedFilament {
        use crate::model::Decode;
        MixedFilament::from_value(self.to_value()).expect("a complete canonical recipe")
    }
}

fn field(name: &str, value: Value) -> (Vec<u16>, Value) {
    (u(name), value)
}
fn text(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|value| Value::Number(*value)).collect())
}
pub(crate) fn components_value(components: &[(Vec<u16>, f64)]) -> Value {
    Value::Array(
        components
            .iter()
            .map(|(id, weight)| {
                Value::Object(BTreeMap::from([
                    field("filamentId", text(id)),
                    field("weight", Value::Number(*weight)),
                ]))
            })
            .collect(),
    )
}
pub(crate) fn distribution_value(distribution: &Distribution) -> Value {
    Value::Object(match distribution {
        Distribution::Ratio => BTreeMap::from([field("mode", text(&u("ratio")))]),
        Distribution::Cycle => BTreeMap::from([field("mode", text(&u("cycle")))]),
        Distribution::Match { target_color } => BTreeMap::from([
            field("mode", text(&u("match"))),
            field("targetColor", text(target_color)),
        ]),
        Distribution::Gradient {
            start_weights,
            end_weights,
        } => BTreeMap::from([
            field("mode", text(&u("gradient"))),
            field("startWeights", numbers(start_weights)),
            field("endWeights", numbers(end_weights)),
        ]),
    })
}
pub(crate) fn state_value(state: &State) -> Value {
    let ids = |list: &[Vec<u16>]| Value::Array(list.iter().map(|id| text(id)).collect());
    Value::Object(BTreeMap::from([
        field("schemaVersion", Value::Number(1.0)),
        field("upstreamStableId", text(&state.upstream_stable_id)),
        field("uiMode", Value::Number(state.ui_mode)),
        field("componentAId", text(&state.component_a_id)),
        field("componentBId", text(&state.component_b_id)),
        field("ratioA", Value::Number(state.ratio_a)),
        field("ratioB", Value::Number(state.ratio_b)),
        field("mixBPercent", Value::Number(state.mix_b_percent)),
        field(
            "manualPatternGroups",
            Value::Array(
                state
                    .manual_pattern_groups
                    .iter()
                    .map(|group| ids(group))
                    .collect(),
            ),
        ),
        field("gradientComponentIds", ids(&state.gradient_component_ids)),
        field(
            "gradientComponentWeights",
            numbers(&state.gradient_component_weights),
        ),
        field("pointillismAllFilaments", Value::Bool(false)),
        field("distributionMode", Value::Number(state.distribution_mode)),
        field(
            "localZMaxSublayers",
            Value::Number(state.local_z_max_sublayers),
        ),
        field("gradientEnabled", Value::Bool(state.gradient_enabled)),
        field("gradientStart", Value::Number(state.gradient_start)),
        field("gradientEnd", Value::Number(state.gradient_end)),
        field("componentASurfaceOffsetMm", Value::Number(state.offset_a)),
        field("componentBSurfaceOffsetMm", Value::Number(state.offset_b)),
        field("deleted", Value::Bool(state.deleted)),
        field("custom", Value::Bool(state.custom)),
        field("originAuto", Value::Bool(state.origin_auto)),
    ]))
}

/// `requireMixedFilamentAuthoring`: the projection, or the issue (or how many).
fn require(input: &Input, physical_count: usize) -> Result<Projection, Refusal> {
    let authored = authoring::project(input, physical_count as f64);
    match authored.projection {
        Some(projection) if authored.ok => Ok(projection),
        _ if authored.issues.len() == 1 => Err(authored.issues[0].message.clone()),
        _ => Err(u(&format!(
            "Mixed filament authoring has {} validation issues",
            authored.issues.len()
        ))),
    }
}

/// `requireEnabledToolId`: the one-based position of the first head with `id`.
fn enabled_tool(
    physical: &[Arc<PhysicalFilament>],
    id: &[u16],
    label: &str,
) -> Result<f64, Refusal> {
    let Some(index) = physical.iter().position(|entry| entry.id.as_utf16() == id) else {
        return Err(cat(&[
            &u(label),
            &u(" "),
            id,
            &u(" is missing from the physical library"),
        ]));
    };
    if !physical[index].enabled {
        return Err(cat(&[&u(label), &u(" "), id, &u(" is disabled")]));
    }
    Ok((index + 1) as f64)
}

type Built = (Vec<(Vec<u16>, f64)>, Distribution, State);

/// `fromProjection`: the row's components, distribution and engine state.
fn from_projection(
    physical: &[Arc<PhysicalFilament>],
    projection: &Projection,
    distribution: Distribution,
    weights: Vec<f64>,
) -> Result<Built, Refusal> {
    let at = |tool: f64| -> Option<Vec<u16>> {
        (tool >= 1.0 && tool.fract() == 0.0)
            .then(|| physical.get(tool as usize - 1))
            .flatten()
            .map(|entry| entry.id.as_utf16().to_vec())
    };
    let (Some(a), Some(b)) = (at(projection.component_a), at(projection.component_b)) else {
        return Err(u("Projection references a missing tool"));
    };
    let gradient_tools = decode_ids(&projection.gradient_component_ids);
    let ordered: Vec<Vec<u16>> = if gradient_tools.is_empty() {
        vec![a.clone(), b.clone()]
    } else {
        gradient_tools
            .iter()
            .map(|tool| {
                at(*tool).ok_or_else(|| {
                    cat(&[
                        &u("Projection references unknown gradient tool "),
                        &num(*tool),
                    ])
                })
            })
            .collect::<Result<_, _>>()?
    };
    let weights = if weights.len() == ordered.len() {
        weights
    } else {
        (0..ordered.len())
            .map(|index| match index {
                0 => 100.0 - projection.mix_b_percent,
                1 => projection.mix_b_percent,
                _ => 0.0,
            })
            .collect()
    };
    let components = ordered.iter().cloned().zip(weights).collect();
    let state = State {
        upstream_stable_id: Vec::new(),
        ui_mode: f64::from(projection.ui_mode),
        component_a_id: a,
        component_b_id: b,
        ratio_a: projection.ratio_a,
        ratio_b: projection.ratio_b,
        mix_b_percent: projection.mix_b_percent,
        manual_pattern_groups: Vec::new(),
        gradient_component_ids: if ordered.len() > 2
            || !projection.gradient_component_ids.is_empty()
        {
            ordered
        } else {
            Vec::new()
        },
        gradient_component_weights: decode_weights(&projection.gradient_component_weights),
        distribution_mode: f64::from(projection.distribution_mode),
        local_z_max_sublayers: projection.local_z_max_sublayers,
        gradient_enabled: projection.gradient_enabled,
        gradient_start: projection.gradient_start,
        gradient_end: projection.gradient_end,
        offset_a: 0.0,
        offset_b: 0.0,
        deleted: false,
        custom: true,
        origin_auto: false,
    };
    Ok((components, distribution, state))
}

/// `buildCycle`.
fn cycle(physical: &[Arc<PhysicalFilament>], groups: &[Vec<Vec<u16>>]) -> Result<Built, Refusal> {
    if groups.is_empty() || groups.iter().any(Vec::is_empty) {
        return Err(u("Cycle needs at least one non-empty perimeter group"));
    }
    // A Map: insertion order, counts per head.
    let mut counts: Vec<(Vec<u16>, f64)> = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        for (token_index, id) in group.iter().enumerate() {
            enabled_tool(
                physical,
                id,
                &format!("Cycle group {} token {}", group_index + 1, token_index + 1),
            )?;
            match counts.iter_mut().find(|(known, _)| known == id) {
                Some((_, count)) => *count += 1.0,
                None => counts.push((id.clone(), 1.0)),
            }
        }
    }
    let (a, b) = engine_pair(groups, physical)?;
    for id in [&a, &b] {
        if !counts.iter().any(|(known, _)| known == id) {
            counts.push((id.clone(), 0.0));
        }
    }
    let state = State {
        upstream_stable_id: Vec::new(),
        ui_mode: 1.0,
        component_a_id: a,
        component_b_id: b.clone(),
        ratio_a: 1.0,
        ratio_b: 1.0,
        mix_b_percent: mix_b_percent(groups, &b),
        manual_pattern_groups: groups.to_vec(),
        gradient_component_ids: Vec::new(),
        gradient_component_weights: Vec::new(),
        distribution_mode: 2.0,
        local_z_max_sublayers: 0.0,
        gradient_enabled: false,
        gradient_start: 0.8,
        gradient_end: 0.2,
        offset_a: 0.0,
        offset_b: 0.0,
        deleted: false,
        custom: true,
        origin_auto: false,
    };
    Ok((counts, Distribution::Cycle, state))
}

/// `cycleEnginePair`: the first two heads when the pattern uses them, else
/// the pattern's own heads in order, else any other head.
pub(crate) fn engine_pair(
    groups: &[Vec<Vec<u16>>],
    physical: &[Arc<PhysicalFilament>],
) -> Result<(Vec<u16>, Vec<u16>), Refusal> {
    if physical.len() < 2 {
        return Err(u("FullSpectrum requires at least two physical tools"));
    }
    let used = |id: &[u16]| groups.iter().flatten().any(|token| token == id);
    let first_slot = physical[0].id.as_utf16();
    let second_slot = physical[1].id.as_utf16();
    let mut ordered: Vec<&Vec<u16>> = Vec::new();
    for token in groups.iter().flatten() {
        if !ordered.contains(&token) {
            ordered.push(token);
        }
    }
    let mut a: Option<Vec<u16>> = if used(first_slot) {
        Some(first_slot.to_vec())
    } else {
        ordered
            .iter()
            .find(|id| id.as_slice() != second_slot)
            .map(|id| (*id).clone())
    };
    let mut b: Option<Vec<u16>> = if used(second_slot) {
        Some(second_slot.to_vec())
    } else {
        // Before A falls back: an absent A excludes nothing.
        ordered
            .iter()
            .find(|id| a.as_deref() != Some(id.as_slice()))
            .map(|id| (*id).clone())
    };
    let a = a.get_or_insert_with(|| first_slot.to_vec()).clone();
    if b.is_none() {
        b = physical
            .iter()
            .find(|entry| entry.id.as_utf16() != a.as_slice())
            .map(|entry| entry.id.as_utf16().to_vec());
    }
    match b {
        Some(b) if b != a => Ok((a, b)),
        _ => Err(u("FullSpectrum requires two distinct physical tools")),
    }
}

/// `cycleMixBPercent`.
pub(crate) fn mix_b_percent(groups: &[Vec<Vec<u16>>], b: &[u16]) -> f64 {
    if groups.is_empty() {
        return 50.0;
    }
    let mut mean = 0.0;
    for group in groups {
        let count = group.iter().filter(|id| id.as_slice() == b).count() as f64;
        mean += count / group.len() as f64;
    }
    js_math::round((100.0 * mean) / groups.len() as f64)
}

/// `validatePhysicalLibrary`.
fn library(physical: &[Arc<PhysicalFilament>]) -> Result<(), Refusal> {
    if physical.len() < 2 {
        return Err(u("FullSpectrum requires at least two physical tools"));
    }
    if physical.len() > 64 {
        return Err(u("The pinned engine supports at most 64 physical tools"));
    }
    for (index, entry) in physical.iter().enumerate() {
        if physical[..index]
            .iter()
            .any(|earlier| earlier.id == entry.id)
        {
            return Err(cat(&[
                &u("Duplicate physical filament ID "),
                entry.id.as_utf16(),
            ]));
        }
    }
    Ok(())
}

/// `validateUnsigned64`.
fn unsigned64(value: &[u16]) -> Result<(), Refusal> {
    let digits = value
        .iter()
        .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit));
    if value.is_empty() || !digits || (value.len() > 1 && value[0] == u16::from(b'0')) {
        return Err(u("Upstream stable ID must be unsigned decimal text"));
    }
    let text = String::from_utf16_lossy(value);
    if text.parse::<u64>().is_err() {
        return Err(u("Upstream stable ID exceeds uint64"));
    }
    Ok(())
}

/// `normalizeDisplayColor`: `#` and six upper-case digits, any alpha dropped.
fn display_color(value: &[u16]) -> Result<Vec<u16>, Refusal> {
    six_digit(value).ok_or_else(|| {
        cat(&[
            &u("Invalid color "),
            &json_stringify(&Value::String(value.to_vec())),
        ])
    })
}

/// `decodeGradientComponentIds`.
fn decode_ids(value: &[u16]) -> Vec<f64> {
    if value.is_empty() {
        return Vec::new();
    }
    let slash = u16::from(b'/');
    if value.contains(&slash) {
        return value
            .split(|unit| *unit == slash)
            .filter(|part| !part.is_empty())
            .map(js_math::convert::utf16_number)
            .collect();
    }
    value
        .iter()
        .map(|unit| js_math::convert::utf16_number(&[*unit]))
        .collect()
}

/// `decodeWeights`.
fn decode_weights(value: &[u16]) -> Vec<f64> {
    if value.is_empty() {
        return Vec::new();
    }
    value
        .split(|unit| *unit == u16::from(b'/'))
        .map(js_math::convert::utf16_number)
        .collect()
}
