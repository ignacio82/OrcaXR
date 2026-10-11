//! The virtual filament library (`virtualFilamentLibraryModel.ts`,
//! `CanonicalVirtualFilamentLibraryAdapter.ts`, `VirtualFilamentMutation.ts`):
//! the library a project shows — its heads in engine order with their
//! compatibility, and its live FullSpectrum recipes projected back to the
//! dialog's validated drafts, checked as the browser's library checks its
//! snapshot — the author dialog's fields and what it computes from them
//! ([`form`]), each library edit's step ([`mutation`]) and the hosts' JSON
//! ([`exchange`]).
pub mod exchange;
pub mod form;
pub mod mutation;

use super::authoring::{self, Input, Projection};
use super::compatibility::material_category;
use super::cycle_pattern;
use super::text::{cat, is_hex_color, num, six_digit, u};
use crate::commands::filament_dependent_paths;
use crate::js_math::{
    self, convert::is_safe_integer, convert::json_stringify, convert::trim_utf16,
};
use crate::model::{MixedDistribution, MixedFilament, ProjectState};
use orcaxr_contracts::canonical::Value;
use std::sync::Arc;

/// `VIRTUAL_FILAMENT_NAME_LIMIT`.
pub const NAME_LIMIT: usize = 120;

/// Text, as UTF-16 units.
pub type Units = Vec<u16>;

/// `VirtualFilamentPhysicalChoice`.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub id: Units,
    pub tool_id: f64,
    pub name: Units,
    pub material: Units,
    pub color: Units,
    pub enabled: bool,
    pub compatible: bool,
    pub incompatibility_reason: Option<Units>,
}

/// `VirtualFilamentValidatedComponent`, with a weight for Match.
#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub filament_id: Units,
    pub tool_id: f64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct WeightedComponent {
    pub filament_id: Units,
    pub tool_id: f64,
    pub weight: f64,
}

/// A validated draft's mode and its fields.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftMode {
    Ratio {
        components: Vec<Component>,
        mix_b_percent: f64,
        triangle: Option<[f64; 3]>,
        projection: Projection,
    },
    Cycle {
        manual_pattern: Units,
        normalized_pattern: Units,
        components: Vec<Component>,
        groups: Vec<Vec<f64>>,
        sequence: Vec<f64>,
    },
    Match {
        target_color: Units,
        normalized_target_color: Units,
        min_component_percent: f64,
        selected_candidate_id: Units,
        preview_color: Units,
        delta_e2000: f64,
        components: Vec<WeightedComponent>,
        projection: Projection,
    },
    Gradient {
        components: [Component; 2],
        a_to_b: bool,
        local_z_max_sublayers: f64,
        projection: Projection,
    },
}
impl DraftMode {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Ratio { .. } => "ratio",
            Self::Cycle { .. } => "cycle",
            Self::Match { .. } => "match",
            Self::Gradient { .. } => "gradient",
        }
    }
}

/// `VirtualFilamentValidatedDraft`.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub name: Units,
    pub display_color: Units,
    pub offset_a: f64,
    pub offset_b: f64,
    pub mode: DraftMode,
}

/// `VirtualFilamentLibraryRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: Units,
    pub enabled: bool,
    pub draft: Draft,
    /// Present only when the recipe is referenced.
    pub dependency_labels: Option<Vec<Units>>,
}

/// `VirtualFilamentMatchCandidate`.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: Units,
    pub label: Option<Units>,
    /// Physical IDs and weights.
    pub components: Vec<(Units, f64)>,
    pub preview_color: Units,
}

/// `VirtualFilamentLibrarySnapshot` without its revision guard.
#[derive(Debug, Clone, PartialEq)]
pub struct Library {
    pub physical: Vec<Choice>,
    pub rows: Vec<Row>,
    pub candidates: Vec<Candidate>,
}

impl Library {
    /// `selectablePhysical`: enabled and compatible heads.
    pub fn selectable(&self) -> impl Iterator<Item = &Choice> {
        self.physical
            .iter()
            .filter(|choice| choice.enabled && choice.compatible)
    }
    /// The first choice with `id`, as a Map built from the choices finds the last; IDs are unique here.
    pub fn choice(&self, id: &[u16]) -> Option<&Choice> {
        self.physical.iter().rev().find(|choice| choice.id == id)
    }
    /// `libraryStatus`.
    pub fn status(&self) -> Units {
        let rows = self.rows.len();
        u(&format!(
            "{rows} virtual {}; {} of {} physical heads selectable.",
            if rows == 1 { "filament" } else { "filaments" },
            self.selectable().count(),
            self.physical.len()
        ))
    }
}

/// A head in engine order (`CanonicalVirtualFilamentLibrarySnapshot.physical`).
struct Head<'s> {
    id: &'s [u16],
    tool: f64,
    name: &'s [u16],
    material: &'s [u16],
    color: &'s [u16],
    enabled: bool,
}

/// The library `state` shows, or why it cannot be shown, in the browser's words.
pub fn library(state: &ProjectState) -> Result<Library, Units> {
    check(project(state)?)
}

/// `projectCanonicalVirtualFilamentLibrary` over the controller's snapshot.
fn project(state: &ProjectState) -> Result<Library, Units> {
    let heads: Vec<Head<'_>> = state
        .filaments
        .physical
        .iter()
        .enumerate()
        .map(|(index, filament)| Head {
            id: filament.id.as_utf16(),
            tool: (index + 1) as f64,
            name: filament.name.units(),
            material: filament.material.units(),
            color: filament.color.units(),
            enabled: filament.enabled,
        })
        .collect();
    let mut physical = Vec::new();
    for head in &heads {
        physical.push(choice(head)?);
    }
    // A Map from the heads: the last head with an ID wins.
    let tool_of = |id: &[u16]| {
        heads
            .iter()
            .rev()
            .find(|head| head.id == id)
            .map(|head| head.tool)
    };
    // The controller's snapshot first: every live recipe (tombstones hidden) with its references.
    let mut live = Vec::new();
    for filament in state.filaments.mixed.iter() {
        if filament
            .full_spectrum
            .as_ref()
            .is_some_and(|recipe| recipe.deleted)
        {
            continue;
        }
        let paths = filament_dependent_paths(state, filament.id.as_utf16())
            .map_err(|message| message.units().to_vec())?;
        live.push((filament, paths));
    }
    let mut rows = Vec::new();
    let mut persisted = Vec::new();
    for (filament, paths) in live {
        // A recipe without exact FullSpectrum state is not listed.
        if filament.full_spectrum.is_none() {
            continue;
        }
        let (row, candidate) = project_row(filament, &paths, heads.len(), &tool_of)?;
        rows.push(row);
        persisted.extend(candidate);
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for candidate in persisted {
        if !candidates.iter().any(|known| known.id == candidate.id) {
            candidates.push(candidate);
        }
    }
    Ok(Library {
        physical,
        rows,
        candidates,
    })
}

/// `toPhysicalChoice`: a blank name or material is none (`Head n`, `Unknown`).
fn choice(head: &Head<'_>) -> Result<Choice, Units> {
    let category = material_category(head.material);
    let material: &[u16] = if trim_utf16(head.material).is_empty() {
        &[]
    } else {
        head.material
    };
    Ok(Choice {
        id: head.id.to_vec(),
        tool_id: head.tool,
        name: if trim_utf16(head.name).is_empty() {
            cat(&[&u("Head "), &num(head.tool)])
        } else {
            head.name.to_vec()
        },
        material: if material.is_empty() {
            u("Unknown")
        } else {
            material.to_vec()
        },
        color: six_digit_or_refuse(head.color)?,
        enabled: head.enabled,
        compatible: category.is_some(),
        incompatibility_reason: category.is_none().then(|| {
            let material = if material.is_empty() {
                u("Unknown material")
            } else {
                material.to_vec()
            };
            cat(&[
                &material,
                &u(" is absent from the pinned compatibility table."),
            ])
        }),
    })
}

/// `normalizeSixDigitColor` of the adapter: refused as an invalid FullSpectrum colour.
fn six_digit_or_refuse(value: &[u16]) -> Result<Units, Units> {
    six_digit(value).ok_or_else(|| {
        cat(&[
            &u("Invalid FullSpectrum color "),
            &json_stringify(&Value::String(value.to_vec())),
        ])
    })
}

/// `projectCanonicalMixedRow`: the recipe's validated draft (and, for Match, its saved candidate).
fn project_row(
    filament: &MixedFilament,
    paths: &[Units],
    physical_count: usize,
    tool_of: &dyn Fn(&[u16]) -> Option<f64>,
) -> Result<(Row, Option<Candidate>), Units> {
    let fs = filament.full_spectrum.as_ref().expect("an exact recipe");
    let id = filament.id.as_utf16();
    let mode = infer_mode(filament);
    let trimmed = trim_utf16(filament.name.units());
    if trimmed.is_empty() {
        return Err(u("Virtual filament name cannot be empty"));
    }
    // Cut to the dialog's limit, then trimmed again: a cut can end on a space.
    let name = trim_utf16(&trimmed[..trimmed.len().min(NAME_LIMIT)]).to_vec();
    let display_color = six_digit_or_refuse(filament.display_color.units())?;
    let require_tool = |physical: &[u16]| {
        tool_of(physical).ok_or_else(|| {
            cat(&[
                &u("Virtual recipe references missing physical filament "),
                physical,
            ])
        })
    };
    let component = |physical: &[u16]| -> Result<Component, Units> {
        Ok(Component {
            filament_id: physical.to_vec(),
            tool_id: require_tool(physical)?,
        })
    };
    let count = physical_count as f64;
    let cannot_project = || {
        cat(&[
            &u("Virtual filament "),
            id,
            &u(" cannot be projected for authoring"),
        ])
    };
    let gradient_ids: Vec<&[u16]> = fs
        .gradient_component_ids
        .iter()
        .map(|id| id.as_utf16())
        .collect();
    let mut candidate = None;
    let draft_mode = match mode {
        "cycle" => {
            let mut groups = Vec::new();
            for group in fs.manual_pattern_groups.iter() {
                let mut tools = Vec::new();
                for physical in group.iter() {
                    tools.push(require_tool(physical.as_utf16())?);
                }
                groups.push(tools);
            }
            let sequence: Vec<f64> = groups.iter().flatten().copied().collect();
            let mut unique: Vec<&[u16]> = Vec::new();
            for physical in fs
                .manual_pattern_groups
                .iter()
                .flat_map(|group| group.iter())
            {
                if !unique.contains(&physical.as_utf16()) {
                    unique.push(physical.as_utf16());
                }
            }
            let components = unique
                .into_iter()
                .map(component)
                .collect::<Result<Vec<_>, _>>()?;
            let pattern = direct_pattern(&groups);
            DraftMode::Cycle {
                manual_pattern: pattern.clone(),
                normalized_pattern: pattern,
                components,
                groups,
                sequence,
            }
        }
        "gradient" => {
            let ids = if gradient_ids.len() == 2 {
                gradient_ids.clone()
            } else {
                vec![fs.component_a_id.as_utf16(), fs.component_b_id.as_utf16()]
            };
            let unique = unique_heads(&ids, 2, 2, "Gradient")?;
            let components = [component(unique[0])?, component(unique[1])?];
            let a_to_b = fs.gradient_start.get() >= fs.gradient_end.get();
            let sublayers = js_math::max(2.0, fs.local_z_max_sublayers.get());
            let projection = authoring::project(
                &Input::Gradient {
                    component_ids: components.iter().map(|c| c.tool_id).collect(),
                    direction: u(if a_to_b { "a-to-b" } else { "b-to-a" }),
                    local_z_max_sublayers: sublayers,
                },
                count,
            )
            .projection
            .ok_or_else(cannot_project)?;
            DraftMode::Gradient {
                components,
                a_to_b,
                local_z_max_sublayers: sublayers,
                projection,
            }
        }
        "match" => {
            let ids: Vec<&[u16]> = if gradient_ids.len() >= 2 {
                gradient_ids.clone()
            } else {
                filament
                    .components
                    .iter()
                    .map(|c| c.filament_id.as_utf16())
                    .collect()
            };
            let ids = unique_heads(&ids, 2, 4, "Match")?;
            let weights = match_weights(filament, &ids)?;
            let mut components = Vec::new();
            for (index, physical) in ids.iter().enumerate() {
                let base = component(physical)?;
                components.push(WeightedComponent {
                    filament_id: base.filament_id,
                    tool_id: base.tool_id,
                    weight: weights[index],
                });
            }
            let target_color = match &filament.distribution {
                MixedDistribution::Match(distribution) => {
                    six_digit_or_refuse(distribution.target_color.units())?
                }
                _ => display_color.clone(),
            };
            let result = authoring::project(
                &Input::Match {
                    components: components.iter().map(|c| (c.tool_id, c.weight)).collect(),
                    target_color: target_color.clone(),
                    min_component_percent: 0.0,
                },
                count,
            );
            let projection = result.projection.ok_or_else(cannot_project)?;
            let normalized = result
                .normalized_target_color
                .unwrap_or_else(|| target_color.clone());
            let candidate_id = cat(&[&u("persisted:"), id]);
            candidate = Some(Candidate {
                id: candidate_id.clone(),
                label: Some(cat(&[&name, &u(" (saved recipe)")])),
                components: components
                    .iter()
                    .map(|c| (c.filament_id.clone(), c.weight))
                    .collect(),
                preview_color: display_color.clone(),
            });
            let delta_e2000 = authoring::color_delta_e2000(&normalized, &display_color)
                .ok_or_else(|| {
                    cat(&[
                        &u("Invalid six-digit RGB color "),
                        &json_stringify(&Value::String(normalized.clone())),
                    ])
                })?;
            DraftMode::Match {
                target_color,
                normalized_target_color: normalized,
                min_component_percent: 0.0,
                selected_candidate_id: candidate_id,
                preview_color: display_color.clone(),
                delta_e2000,
                components,
                projection,
            }
        }
        _ => {
            let ids = if (2..=3).contains(&gradient_ids.len()) {
                gradient_ids.clone()
            } else {
                vec![fs.component_a_id.as_utf16(), fs.component_b_id.as_utf16()]
            };
            let ids = unique_heads(&ids, 2, 3, "Ratio")?;
            let components = ids
                .iter()
                .map(|physical| component(physical))
                .collect::<Result<Vec<_>, _>>()?;
            let triangle = if ids.len() == 3 {
                Some(triangle_weights(filament, &ids)?)
            } else {
                None
            };
            let mix_b_percent = fs.mix_b_percent.get();
            let projection = authoring::project(
                &Input::Ratio {
                    component_ids: components.iter().map(|c| c.tool_id).collect(),
                    mix_b_percent,
                    triangle: triangle.map(|t| t.to_vec()),
                },
                count,
            )
            .projection
            .ok_or_else(cannot_project)?;
            DraftMode::Ratio {
                components,
                mix_b_percent,
                triangle,
                projection,
            }
        }
    };
    Ok((
        Row {
            id: id.to_vec(),
            enabled: filament.enabled,
            draft: Draft {
                name,
                display_color,
                offset_a: fs.component_a_surface_offset_mm.get(),
                offset_b: fs.component_b_surface_offset_mm.get(),
                mode: draft_mode,
            },
            dependency_labels: (!paths.is_empty()).then(|| paths.to_vec()),
        },
        candidate,
    ))
}

/// `inferMode`.
fn infer_mode(filament: &MixedFilament) -> &'static str {
    let fs = filament.full_spectrum.as_ref().expect("an exact recipe");
    match fs.ui_mode.number() as i64 {
        0 => "ratio",
        1 => "cycle",
        2 => "match",
        3 => "gradient",
        _ if !fs.manual_pattern_groups.is_empty()
            || matches!(filament.distribution, MixedDistribution::Cycle(_)) =>
        {
            "cycle"
        }
        _ if fs.gradient_enabled
            || matches!(filament.distribution, MixedDistribution::Gradient(_)) =>
        {
            "gradient"
        }
        _ if matches!(filament.distribution, MixedDistribution::Match(_)) => "match",
        _ => "ratio",
    }
}

/// `uniquePhysicalIds`.
fn unique_heads<'a>(
    ids: &[&'a [u16]],
    minimum: usize,
    maximum: usize,
    label: &str,
) -> Result<Vec<&'a [u16]>, Units> {
    let mut unique: Vec<&[u16]> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id);
        }
    }
    if unique.len() < minimum || unique.len() > maximum {
        let range = if minimum == maximum {
            String::new()
        } else {
            format!("–{maximum}")
        };
        return Err(u(&format!(
            "{label} needs {minimum}{range} unique physical heads"
        )));
    }
    Ok(unique)
}

/// `matchComponentWeights`.
fn match_weights(filament: &MixedFilament, ids: &[&[u16]]) -> Result<Vec<f64>, Units> {
    let fs = filament.full_spectrum.as_ref().expect("an exact recipe");
    let known = |id: &[u16]| {
        filament
            .components
            .iter()
            .rev()
            .find(|c| c.filament_id.as_utf16() == id)
            .map(|c| js_math::round(c.weight.get()))
    };
    let raw: Vec<f64> = if fs.gradient_component_weights.len() == ids.len() {
        fs.gradient_component_weights
            .iter()
            .map(|w| js_math::round(w.get()))
            .collect()
    } else {
        ids.iter()
            .enumerate()
            .map(|(index, id)| match known(id) {
                Some(weight) => weight,
                None => match index {
                    0 => 100.0 - fs.mix_b_percent.get(),
                    1 => fs.mix_b_percent.get(),
                    _ => 0.0,
                },
            })
            .collect()
    };
    authoring::normalize_match_weights(&raw, ids.len()).map_err(u)
}

/// `ratioTriangleWeights`.
fn triangle_weights(filament: &MixedFilament, ids: &[&[u16]]) -> Result<[f64; 3], Units> {
    let fs = filament.full_spectrum.as_ref().expect("an exact recipe");
    let weights: Vec<f64> = if fs.gradient_component_weights.len() == 3 {
        fs.gradient_component_weights
            .iter()
            .map(|w| w.get())
            .collect()
    } else {
        ids.iter()
            .map(|id| {
                filament
                    .components
                    .iter()
                    .rev()
                    .find(|c| c.filament_id.as_utf16() == *id)
                    .map_or(0.0, |c| c.weight.get())
            })
            .collect()
    };
    if weights.len() != 3 || weights.iter().all(|weight| *weight <= 0.0) {
        return Err(cat(&[
            &u("Virtual filament "),
            filament.id.as_utf16(),
            &u(" has invalid Ratio triangle weights"),
        ]));
    }
    Ok([weights[0], weights[1], weights[2]])
}

/// `encodeDirectToolPattern`.
fn direct_pattern(groups: &[Vec<f64>]) -> Units {
    let parts: Vec<Units> = groups
        .iter()
        .map(|group| {
            group
                .iter()
                .flat_map(|tool| {
                    if *tool < 10.0 {
                        num(*tool)
                    } else {
                        cat(&[&u("["), &num(*tool), &u("]")])
                    }
                })
                .collect()
        })
        .collect();
    parts.join(&[u16::from(b',')][..])
}

/// `immutableSnapshot`'s checks of a library the browser renders.
fn check(library: Library) -> Result<Library, Units> {
    let count = library.physical.len();
    if count as f64 > authoring::MAX_PHYSICAL {
        return Err(u("At most 64 physical heads are supported"));
    }
    let mut ids: Vec<&[u16]> = Vec::new();
    let mut tools: Vec<f64> = Vec::new();
    for choice in &library.physical {
        identifier(&choice.id, "physical filament ID")?;
        if ids.contains(&choice.id.as_slice()) {
            return Err(cat(&[&u("Duplicate physical filament ID "), &choice.id]));
        }
        ids.push(&choice.id);
        if !is_safe_integer(choice.tool_id) || choice.tool_id < 1.0 || choice.tool_id > count as f64
        {
            return Err(cat(&[
                &u("Physical tool ID "),
                &num(choice.tool_id),
                &u(&format!(" must be within 1..{count}")),
            ]));
        }
        if tools.contains(&choice.tool_id) {
            return Err(cat(&[
                &u("Duplicate physical tool ID "),
                &num(choice.tool_id),
            ]));
        }
        tools.push(choice.tool_id);
        if trim_utf16(&choice.name).is_empty() || trim_utf16(&choice.material).is_empty() {
            return Err(u("Physical choice labels must not be empty"));
        }
        if !is_hex_color(&choice.color) {
            return Err(cat(&[&u("Invalid physical color "), &choice.color]));
        }
    }
    if (1..=count).any(|tool| !tools.contains(&(tool as f64))) {
        return Err(u(
            "Physical tool IDs must form the contiguous pinned-engine namespace 1..N",
        ));
    }
    let mut candidate_ids: Vec<&[u16]> = Vec::new();
    for candidate in &library.candidates {
        identifier(&candidate.id, "Match candidate ID")?;
        if candidate_ids.contains(&candidate.id.as_slice()) {
            return Err(cat(&[&u("Duplicate Match candidate ID "), &candidate.id]));
        }
        candidate_ids.push(&candidate.id);
        if !is_hex_color(&candidate.preview_color) {
            return Err(cat(&[
                &u("Invalid Match preview color "),
                &candidate.preview_color,
            ]));
        }
        if !(2..=4).contains(&candidate.components.len()) {
            return Err(cat(&[
                &u("Match candidate "),
                &candidate.id,
                &u(" must have two to four components"),
            ]));
        }
        let mut seen: Vec<&[u16]> = Vec::new();
        for (physical, weight) in &candidate.components {
            if !ids.contains(&physical.as_slice()) {
                return Err(cat(&[
                    &u("Match candidate "),
                    &candidate.id,
                    &u(" references unknown physical filament "),
                    physical,
                ]));
            }
            if seen.contains(&physical.as_slice()) {
                return Err(cat(&[
                    &u("Match candidate "),
                    &candidate.id,
                    &u(" repeats physical filament "),
                    physical,
                ]));
            }
            seen.push(physical);
            if !is_safe_integer(*weight) || *weight < 0.0 {
                return Err(cat(&[
                    &u("Match candidate "),
                    &candidate.id,
                    &u(" has an invalid weight"),
                ]));
            }
        }
    }
    let mut row_ids: Vec<&[u16]> = Vec::new();
    for row in &library.rows {
        identifier(&row.id, "virtual filament ID")?;
        if row_ids.contains(&row.id.as_slice()) {
            return Err(cat(&[&u("Duplicate virtual filament ID "), &row.id]));
        }
        row_ids.push(&row.id);
        check_draft(&row.draft, &library.physical)?;
    }
    Ok(library)
}

/// `assertIdentifier`.
fn identifier(value: &[u16], label: &str) -> Result<(), Units> {
    if value.is_empty() || trim_utf16(value) != value || value.len() > 256 {
        return Err(u(&format!("{label} is invalid")));
    }
    Ok(())
}

/// `assertSnapshotDraft`: a row's draft re-derived through the pinned projection.
fn check_draft(draft: &Draft, physical: &[Choice]) -> Result<(), Units> {
    let name = &draft.name;
    if name.is_empty() || trim_utf16(name) != name.as_slice() || name.len() > NAME_LIMIT {
        return Err(u("Virtual filament draft has an invalid name"));
    }
    let refuse = |what: &str| cat(&[&u("Virtual filament "), name, &u(what)]);
    if !is_hex_color(&draft.display_color) {
        return Err(refuse(" has an invalid display color"));
    }
    for offset in [draft.offset_a, draft.offset_b] {
        if !offset.is_finite() || offset.abs() > super::recipe::MAX_SURFACE_OFFSET_MM {
            return Err(refuse(" has an invalid component surface offset"));
        }
    }
    let components =
        |list: &[(&[u16], f64)], minimum: usize, maximum: usize| -> Result<Vec<f64>, Units> {
            if list.len() < minimum || list.len() > maximum {
                return Err(refuse(" has an invalid component count"));
            }
            let mut seen: Vec<&[u16]> = Vec::new();
            let mut tools = Vec::new();
            for (id, tool) in list {
                let known = physical
                    .iter()
                    .rev()
                    .find(|choice| choice.id.as_slice() == *id);
                if known.is_none_or(|choice| choice.tool_id != *tool) || seen.contains(id) {
                    return Err(refuse(" has an invalid physical component"));
                }
                seen.push(id);
                tools.push(*tool);
            }
            Ok(tools)
        };
    let count = physical.len() as f64;
    let mismatched = || refuse(" has a mismatched pinned-engine projection");
    let matching = |projection: &Projection, derived: Option<Projection>| match derived {
        Some(derived) if derived == *projection => Ok(()),
        _ => Err(mismatched()),
    };
    match &draft.mode {
        DraftMode::Ratio {
            components: list,
            mix_b_percent,
            triangle,
            projection,
        } => {
            let pairs: Vec<(&[u16], f64)> = list
                .iter()
                .map(|c| (c.filament_id.as_slice(), c.tool_id))
                .collect();
            let tools = components(&pairs, 2, 3)?;
            let derived = authoring::project(
                &Input::Ratio {
                    component_ids: tools,
                    mix_b_percent: *mix_b_percent,
                    triangle: triangle.map(|t| t.to_vec()),
                },
                count,
            );
            matching(projection, derived.projection)
        }
        DraftMode::Cycle {
            manual_pattern,
            normalized_pattern,
            components: list,
            groups,
            sequence,
        } => {
            let pairs: Vec<(&[u16], f64)> = list
                .iter()
                .map(|c| (c.filament_id.as_slice(), c.tool_id))
                .collect();
            let tools = components(&pairs, 1, authoring::MAX_PHYSICAL as usize)?;
            let available: Vec<u32> = physical
                .iter()
                .map(|choice| choice.tool_id as u32)
                .collect();
            let parsed = cycle_pattern::parse(manual_pattern, Some(&available));
            let parsed_sequence: Vec<f64> = parsed.sequence.iter().map(|t| f64::from(*t)).collect();
            let mut unique: Vec<f64> = Vec::new();
            for tool in &parsed_sequence {
                if !unique.contains(tool) {
                    unique.push(*tool);
                }
            }
            let same_groups = parsed.groups.len() == groups.len()
                && parsed.groups.iter().zip(groups).all(|(group, expected)| {
                    group
                        .tokens
                        .iter()
                        .map(|token| f64::from(token.tool_id))
                        .collect::<Vec<_>>()
                        == *expected
                });
            if !parsed.ok
                || parsed.normalized != *normalized_pattern
                || parsed_sequence != *sequence
                || !same_groups
                || unique != tools
            {
                return Err(refuse(" has an invalid Cycle draft"));
            }
            Ok(())
        }
        DraftMode::Match {
            target_color,
            normalized_target_color,
            min_component_percent,
            selected_candidate_id,
            preview_color,
            delta_e2000,
            components: list,
            projection,
        } => {
            let pairs: Vec<(&[u16], f64)> = list
                .iter()
                .map(|c| (c.filament_id.as_slice(), c.tool_id))
                .collect();
            let tools = components(&pairs, 2, 4)?;
            if selected_candidate_id.is_empty()
                || !is_hex_color(preview_color)
                || !delta_e2000.is_finite()
                || *delta_e2000 < 0.0
            {
                return Err(refuse(" has invalid Match result metadata"));
            }
            let derived = authoring::project(
                &Input::Match {
                    components: tools
                        .iter()
                        .zip(list)
                        .map(|(tool, c)| (*tool, c.weight))
                        .collect(),
                    target_color: target_color.clone(),
                    min_component_percent: *min_component_percent,
                },
                count,
            );
            if derived.normalized_target_color.as_ref() != Some(normalized_target_color) {
                return Err(refuse(" has a mismatched normalized Match target"));
            }
            matching(projection, derived.projection)
        }
        DraftMode::Gradient {
            components: list,
            a_to_b,
            local_z_max_sublayers,
            projection,
        } => {
            let pairs: Vec<(&[u16], f64)> = list
                .iter()
                .map(|c| (c.filament_id.as_slice(), c.tool_id))
                .collect();
            let tools = components(&pairs, 2, 2)?;
            if !is_safe_integer(*local_z_max_sublayers) || *local_z_max_sublayers < 2.0 {
                return Err(refuse(" has an invalid Local-Z sublayer count"));
            }
            let derived = authoring::project(
                &Input::Gradient {
                    component_ids: tools,
                    direction: u(if *a_to_b { "a-to-b" } else { "b-to-a" }),
                    local_z_max_sublayers: *local_z_max_sublayers,
                },
                count,
            );
            matching(projection, derived.projection)
        }
    }
}

/// `MixedFilament` lookups the plans share.
pub(crate) fn mixed<'s>(state: &'s ProjectState, id: &[u16]) -> Option<&'s Arc<MixedFilament>> {
    state
        .filaments
        .mixed
        .iter()
        .find(|filament| filament.id.as_utf16() == id)
}
