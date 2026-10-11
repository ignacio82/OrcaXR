//! The author dialog's fields and everything the browser's library computes
//! from them (`virtualFilamentLibraryModel.ts`): the fields a dialog opens
//! with, each mode's validation — its located issues, its preview line and,
//! once complete, the validated draft — the Match ranking of the saved and
//! searched candidates, the Ratio and Gradient previews, the triangle
//! picker's coordinates and the rows' one-line summaries.
use super::super::authoring::{self, Input, Projection};
use super::super::cycle_pattern;
use super::super::pigment::{blend_pair, parse_color, to_hex};
use super::super::text::{cat, fixed, is_hex_color, num, u, upper_hex};
use super::{
    Candidate, Choice, Component, Draft, DraftMode, Library, NAME_LIMIT, Row, Units,
    WeightedComponent,
};
use crate::js_math::{self, convert::is_safe_integer, convert::trim_utf16, convert::utf16_number};

/// An author dialog's mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Ratio,
    Cycle,
    Match,
    Gradient,
}
impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ratio => "ratio",
            Self::Cycle => "cycle",
            Self::Match => "match",
            Self::Gradient => "gradient",
        }
    }
    pub fn parse(name: &[u16]) -> Option<Self> {
        [Self::Ratio, Self::Cycle, Self::Match, Self::Gradient]
            .into_iter()
            .find(|mode| u(mode.name()) == name)
    }
    /// `modeLabel`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ratio => "Ratio",
            Self::Cycle => "Cycle",
            Self::Match => "Match",
            Self::Gradient => "Gradient",
        }
    }
}

/// The dialog's fields, exactly as typed (`VirtualFilamentAuthorForm`).
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub name: Units,
    pub display_color: Units,
    pub offset_a: Units,
    pub offset_b: Units,
    pub mode: Mode,
    /// Two or three heads.
    pub ratio_count: u8,
    pub ratio_ids: Vec<Units>,
    pub ratio_mix_b: Units,
    pub ratio_triangle: [Units; 3],
    pub cycle_pattern: Units,
    pub match_target: Units,
    pub match_minimum: Units,
    pub match_selected: Option<Units>,
    pub gradient_ids: [Units; 2],
    pub gradient_a_to_b: bool,
    pub gradient_sublayers: Units,
}

/// The dialog's operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Add,
    Edit,
    Duplicate,
}

/// `VirtualFilamentIssue`: a message, the field it concerns and, for a
/// Cycle pattern, the characters.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub message: Units,
    pub field: Option<Units>,
    pub start_offset: Option<usize>,
    pub end_offset: Option<usize>,
}
fn issue(message: Units, field: &str) -> Issue {
    Issue {
        message,
        field: Some(u(field)),
        start_offset: None,
        end_offset: None,
    }
}

/// What the dialog knows of its Match search.
#[derive(Debug, Clone, PartialEq)]
pub enum Search {
    Pending,
    Ready(Vec<Candidate>),
    Error(Option<Units>),
}

/// One ranked candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct RankView {
    pub candidate: Candidate,
    pub ranked: authoring::Ranked,
}

/// `VirtualFilamentMatchRanking`.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranking {
    pub normalized_target_color: Option<Units>,
    pub ranked: Vec<RankView>,
    pub issues: Vec<Issue>,
}

/// `VirtualFilamentDraftValidation`.
#[derive(Debug, Clone, PartialEq)]
pub struct Validation {
    pub draft: Option<Draft>,
    pub issues: Vec<Issue>,
    pub preview: Units,
    pub ranking: Option<Ranking>,
}

/// `defaultAuthorState`.
pub fn defaults(library: &Library) -> Form {
    let selectable: Vec<&Choice> = library.selectable().collect();
    let first = selectable
        .first()
        .map_or_else(Vec::new, |choice| choice.id.clone());
    let second = selectable
        .get(1)
        .map_or_else(Vec::new, |choice| choice.id.clone());
    let third = selectable
        .get(2)
        .map_or_else(|| first.clone(), |choice| choice.id.clone());
    Form {
        name: u("Virtual filament"),
        display_color: u("#808080"),
        offset_a: u("0"),
        offset_b: u("0"),
        mode: Mode::Ratio,
        ratio_count: 2,
        ratio_ids: vec![first.clone(), second.clone(), third],
        ratio_mix_b: u("50"),
        ratio_triangle: [u("34"), u("33"), u("33")],
        cycle_pattern: Vec::new(),
        match_target: u("#808080"),
        match_minimum: u("10"),
        match_selected: None,
        gradient_ids: [first, second],
        gradient_a_to_b: true,
        gradient_sublayers: u("2"),
    }
}

/// `loadDraft`: a row's recipe in the fields of its mode.
pub fn load(form: &mut Form, draft: &Draft) {
    form.name = draft.name.clone();
    form.display_color = draft.display_color.clone();
    form.offset_a = num(draft.offset_a);
    form.offset_b = num(draft.offset_b);
    match &draft.mode {
        DraftMode::Ratio {
            components,
            mix_b_percent,
            triangle,
            ..
        } => {
            form.mode = Mode::Ratio;
            form.ratio_count = if components.len() == 3 { 3 } else { 2 };
            form.ratio_ids = components.iter().map(|c| c.filament_id.clone()).collect();
            form.ratio_mix_b = num(*mix_b_percent);
            if let Some(weights) = triangle {
                form.ratio_triangle = weights.map(num);
            }
        }
        DraftMode::Cycle { manual_pattern, .. } => {
            form.mode = Mode::Cycle;
            form.cycle_pattern = manual_pattern.clone();
        }
        DraftMode::Match {
            target_color,
            min_component_percent,
            selected_candidate_id,
            ..
        } => {
            form.mode = Mode::Match;
            form.match_target = target_color.clone();
            form.match_minimum = num(*min_component_percent);
            form.match_selected = Some(selected_candidate_id.clone());
        }
        DraftMode::Gradient {
            components,
            a_to_b,
            local_z_max_sublayers,
            ..
        } => {
            form.mode = Mode::Gradient;
            form.gradient_ids = [
                components[0].filament_id.clone(),
                components[1].filament_id.clone(),
            ];
            form.gradient_a_to_b = *a_to_b;
            form.gradient_sublayers = num(*local_z_max_sublayers);
        }
    }
}

/// `authorFormFor`: the fields a dialog opens with for `operation` on `row`.
pub fn opening(library: &Library, operation: Operation, row: Option<&Row>) -> Form {
    let mut form = defaults(library);
    if let Some(row) = row {
        load(&mut form, &row.draft);
        if operation == Operation::Duplicate {
            form.name = duplicate_name(&row.draft.name);
        }
    }
    form
}

/// `duplicateName`.
pub fn duplicate_name(name: &[u16]) -> Units {
    let suffix = u(" copy");
    if name.len() + suffix.len() <= NAME_LIMIT {
        cat(&[name, &suffix])
    } else {
        cat(&[&name[..NAME_LIMIT - suffix.len()], &suffix])
    }
}

/// `validateAuthorForm`.
pub fn validate(form: &Form, library: &Library, search: Option<&Search>) -> Validation {
    let common = common(form);
    match form.mode {
        Mode::Ratio => ratio(form, library, common),
        Mode::Cycle => cycle(form, library, common),
        Mode::Match => match_mode(form, library, common, search),
        Mode::Gradient => gradient(form, library, common),
    }
}

fn common(form: &Form) -> Vec<Issue> {
    let mut issues = Vec::new();
    if form.name.is_empty() {
        issues.push(issue(u("Name is required."), "name"));
    } else if trim_utf16(&form.name) != form.name.as_slice() {
        issues.push(issue(
            u("Name must not start or end with whitespace."),
            "name",
        ));
    } else if form.name.len() > NAME_LIMIT {
        issues.push(issue(u("Name cannot exceed 120 characters."), "name"));
    }
    if !is_hex_color(&form.display_color) {
        issues.push(issue(
            u("Display badge color must be exactly #RRGGBB."),
            "display-color",
        ));
    }
    for (label, field, value) in [
        ("Component A", "component-a-surface-offset", &form.offset_a),
        ("Component B", "component-b-surface-offset", &form.offset_b),
    ] {
        if strict_finite(value)
            .is_none_or(|parsed| parsed.abs() > super::super::recipe::MAX_SURFACE_OFFSET_MM)
        {
            issues.push(issue(
                u(&format!(
                    "{label} surface offset must be a finite number from -2 to +2 mm."
                )),
                field,
            ));
        }
    }
    issues
}

fn offsets(form: &Form) -> (f64, f64) {
    (
        strict_finite(&form.offset_a).expect("validated offset"),
        strict_finite(&form.offset_b).expect("validated offset"),
    )
}

fn ratio(form: &Form, library: &Library, mut issues: Vec<Issue>) -> Validation {
    let count = usize::from(form.ratio_count);
    let selected = &form.ratio_ids[..form.ratio_ids.len().min(count)];
    let components = resolve(selected, library, &mut issues, "ratio-component");
    let mix_b = strict_integer(&form.ratio_mix_b);
    if mix_b.is_none() {
        issues.push(issue(
            u("Component B percent must be an integer from 0 to 100."),
            "ratio-mix-b",
        ));
    }
    let mut triangle = None;
    if count == 3 {
        let parsed: Vec<Option<f64>> = form
            .ratio_triangle
            .iter()
            .map(|text| strict_finite(text))
            .collect();
        if parsed.iter().any(|value| value.is_none_or(|v| v < 0.0)) {
            issues.push(issue(
                u("All three triangle proportions must be finite non-negative numbers."),
                "ratio-weight-0",
            ));
        } else {
            triangle = Some([parsed[0].unwrap(), parsed[1].unwrap(), parsed[2].unwrap()]);
        }
    }
    let mut projection = None;
    if let Some(mix_b) = mix_b
        && components.len() == count
        && (count == 2 || triangle.is_some())
    {
        let result = authoring::project(
            &Input::Ratio {
                component_ids: components.iter().map(|c| c.tool_id).collect(),
                mix_b_percent: mix_b,
                triangle: triangle.map(|t| t.to_vec()),
            },
            library.physical.len() as f64,
        );
        match result.projection {
            Some(found) => projection = Some(found),
            None => issues.extend(result.issues.iter().map(authoring_issue)),
        }
    }
    let preview = match &projection {
        Some(p) if count == 2 => cat(&[
            &u("Exact cadence: A "),
            &num(p.ratio_a),
            &u(if p.ratio_a == 1.0 {
                " layer"
            } else {
                " layers"
            }),
            &u(" / B "),
            &num(p.ratio_b),
            &u(if p.ratio_b == 1.0 {
                " layer"
            } else {
                " layers"
            }),
            &u("; badge "),
            &form.display_color,
            &u("."),
        ]),
        Some(p) => {
            let weights: Units = p
                .gradient_component_weights
                .split(|unit| *unit == u16::from(b'/'))
                .collect::<Vec<_>>()
                .join(&u("% / ")[..]);
            cat(&[
                &u("Exact saved triangle weights: "),
                &weights,
                &u("%; badge "),
                &form.display_color,
                &u("."),
            ])
        }
        None => u("Complete the Ratio recipe to preview its exact pinned-engine fields."),
    };
    let Some(projection) = projection.filter(|_| issues.is_empty()) else {
        return Validation {
            draft: None,
            issues,
            preview,
            ranking: None,
        };
    };
    let (offset_a, offset_b) = offsets(form);
    Validation {
        draft: Some(Draft {
            name: form.name.clone(),
            display_color: form.display_color.clone(),
            offset_a,
            offset_b,
            mode: DraftMode::Ratio {
                components,
                mix_b_percent: mix_b.expect("validated"),
                triangle,
                projection,
            },
        }),
        issues: Vec::new(),
        preview,
        ranking: None,
    }
}

fn cycle(form: &Form, library: &Library, mut issues: Vec<Issue>) -> Validation {
    let available: Vec<u32> = library
        .selectable()
        .map(|choice| choice.tool_id as u32)
        .collect();
    let parsed = cycle_pattern::parse(&form.cycle_pattern, Some(&available));
    for each in &parsed.issues {
        issues.push(Issue {
            message: each.message.clone(),
            field: Some(u("cycle-pattern")),
            start_offset: Some(each.location.start_offset),
            end_offset: Some(each.location.end_offset),
        });
    }
    let mut unique: Vec<u32> = Vec::new();
    for tool in &parsed.sequence {
        if !unique.contains(tool) {
            unique.push(*tool);
        }
    }
    let by_tool = |tool: u32| {
        library
            .physical
            .iter()
            .rev()
            .find(|choice| choice.tool_id == f64::from(tool))
    };
    let components: Vec<Component> = unique
        .iter()
        .filter_map(|tool| {
            by_tool(*tool).map(|choice| Component {
                filament_id: choice.id.clone(),
                tool_id: f64::from(*tool),
            })
        })
        .collect();
    let warning = if unique.len() == 1 {
        " Warning: one distinct head cannot produce a new mixed color."
    } else if unique.len() > 4 {
        " Warning: more than four heads may reduce recipe quality."
    } else {
        ""
    };
    let preview = if parsed.syntax_valid {
        let summary: Vec<Units> = parsed
            .groups
            .iter()
            .enumerate()
            .map(|(index, group)| {
                let names: Vec<Units> = group
                    .tokens
                    .iter()
                    .map(|token| match by_tool(token.tool_id) {
                        Some(choice) => cat(&[
                            &u("H"),
                            &num(f64::from(token.tool_id)),
                            &u(" "),
                            &choice.name,
                        ]),
                        None => cat(&[&u("H"), &num(f64::from(token.tool_id))]),
                    })
                    .collect();
                let joined = names.join(&u(" → ")[..]);
                let joined = if joined.is_empty() {
                    u("empty")
                } else {
                    joined
                };
                cat(&[&u(&format!("group {}: ", index + 1)), &joined])
            })
            .collect();
        let normalized = if parsed.normalized.is_empty() {
            u("(none)")
        } else {
            parsed.normalized.clone()
        };
        cat(&[
            &u("Exact engine pattern: "),
            &normalized,
            &u("; groups: "),
            &summary.join(&u("; ")[..]),
            &u("."),
            &u(warning),
        ])
    } else {
        u("Fix the located pattern errors before this exact sequence can be submitted.")
    };
    if !parsed.ok || !issues.is_empty() {
        return Validation {
            draft: None,
            issues: dedupe(issues),
            preview,
            ranking: None,
        };
    }
    let (offset_a, offset_b) = offsets(form);
    Validation {
        draft: Some(Draft {
            name: form.name.clone(),
            display_color: form.display_color.clone(),
            offset_a,
            offset_b,
            mode: DraftMode::Cycle {
                manual_pattern: form.cycle_pattern.clone(),
                normalized_pattern: parsed.normalized.clone(),
                components,
                groups: parsed
                    .groups
                    .iter()
                    .map(|group| {
                        group
                            .tokens
                            .iter()
                            .map(|token| f64::from(token.tool_id))
                            .collect()
                    })
                    .collect(),
                sequence: parsed
                    .sequence
                    .iter()
                    .map(|tool| f64::from(*tool))
                    .collect(),
            },
        }),
        issues: Vec::new(),
        preview,
        ranking: None,
    }
}

fn match_mode(
    form: &Form,
    library: &Library,
    mut issues: Vec<Issue>,
    search: Option<&Search>,
) -> Validation {
    let minimum = strict_integer(&form.match_minimum);
    if minimum.is_none_or(|m| !(0.0..=50.0).contains(&m)) {
        issues.push(issue(
            u("Minimum component percent must be an integer from 0 to 50."),
            "match-minimum",
        ));
    }
    if let Some(Search::Error(error)) = search {
        issues.push(issue(
            cat(&[
                &u("Pinned Match search is unavailable: "),
                error.as_deref().unwrap_or(&u("Unknown search error")),
            ]),
            "match-candidate",
        ));
    }
    let ranking = match minimum {
        None => Ranking {
            normalized_target_color: None,
            ranked: Vec::new(),
            issues: Vec::new(),
        },
        Some(minimum) => {
            let candidates = match search {
                Some(Search::Ready(found)) => {
                    let mut merged: Vec<Candidate> = Vec::new();
                    for candidate in found.iter().chain(&library.candidates) {
                        if !merged.iter().any(|known| known.id == candidate.id) {
                            merged.push(candidate.clone());
                        }
                    }
                    merged
                }
                _ => library.candidates.clone(),
            };
            rank_supplied(library, &form.match_target, minimum, &candidates)
        }
    };
    issues.extend(ranking.issues.iter().cloned());
    let selected = ranking
        .ranked
        .iter()
        .find(|view| form.match_selected.as_ref() == Some(&view.candidate.id));
    if !ranking.ranked.is_empty() && selected.is_none() {
        issues.push(issue(
            u("Explicitly select one ranked supplied candidate."),
            "match-candidate",
        ));
    }
    let preview = match selected {
        Some(view) => cat(&[
            &u("Selected "),
            view.candidate.label.as_ref().unwrap_or(&view.candidate.id),
            &u(": predicted "),
            &view.ranked.preview_color,
            &u(", target "),
            ranking
                .normalized_target_color
                .as_deref()
                .unwrap_or(&u("undefined")),
            &u(", ΔE2000 "),
            &fixed(view.ranked.delta_e2000, 2),
            &u("."),
        ]),
        None if matches!(search, Some(Search::Pending)) => {
            u("Searching the compatible physical palette for the closest pinned Match recipe.")
        }
        None => {
            u("Enter a valid target and minimum, then explicitly select one supplied candidate.")
        }
    };
    let complete = selected.is_some()
        && minimum.is_some()
        && ranking.normalized_target_color.is_some()
        && issues.is_empty();
    if !complete {
        return Validation {
            draft: None,
            issues: dedupe(issues),
            preview,
            ranking: Some(ranking),
        };
    }
    let view = selected.expect("complete");
    let weights: Vec<f64> = view
        .candidate
        .components
        .iter()
        .map(|(_, weight)| *weight)
        .collect();
    let normalized = authoring::normalize_match_weights(&weights, weights.len())
        .expect("validated candidate weights");
    let components = view
        .candidate
        .components
        .iter()
        .enumerate()
        .map(|(index, (id, _))| {
            let physical = library.choice(id).expect("a selectable head");
            WeightedComponent {
                filament_id: physical.id.clone(),
                tool_id: physical.tool_id,
                weight: normalized[index],
            }
        })
        .collect();
    let (offset_a, offset_b) = offsets(form);
    let draft = Draft {
        name: form.name.clone(),
        display_color: form.display_color.clone(),
        offset_a,
        offset_b,
        mode: DraftMode::Match {
            target_color: form.match_target.clone(),
            normalized_target_color: ranking.normalized_target_color.clone().expect("complete"),
            min_component_percent: minimum.expect("complete"),
            selected_candidate_id: view.candidate.id.clone(),
            preview_color: view.ranked.preview_color.clone(),
            delta_e2000: view.ranked.delta_e2000,
            components,
            projection: view.ranked.projection.clone(),
        },
    };
    Validation {
        draft: Some(draft),
        issues: Vec::new(),
        preview,
        ranking: Some(ranking),
    }
}

fn gradient(form: &Form, library: &Library, mut issues: Vec<Issue>) -> Validation {
    let components = resolve(
        &form.gradient_ids,
        library,
        &mut issues,
        "gradient-component",
    );
    let sublayers = strict_integer(&form.gradient_sublayers);
    if sublayers.is_none_or(|s| s < 2.0) {
        issues.push(issue(
            u("Gradient Local-Z sublayers must be a safe integer of at least 2."),
            "gradient-sublayers",
        ));
    }
    let mut projection: Option<Projection> = None;
    if let Some(sublayers) = sublayers
        && components.len() == 2
        && sublayers >= 2.0
    {
        let result = authoring::project(
            &Input::Gradient {
                component_ids: components.iter().map(|c| c.tool_id).collect(),
                direction: u(if form.gradient_a_to_b {
                    "a-to-b"
                } else {
                    "b-to-a"
                }),
                local_z_max_sublayers: sublayers,
            },
            library.physical.len() as f64,
        );
        match result.projection {
            Some(found) => projection = Some(found),
            None => issues.extend(result.issues.iter().map(authoring_issue)),
        }
    }
    let arrow = if form.gradient_a_to_b {
        "A→B"
    } else {
        "B→A"
    };
    let preview = match &projection {
        Some(p) => u(&format!(
            "{arrow}: component A {}% → {}%; component B {}% → {}%; {} Local-Z sublayers.",
            round_text(p.gradient_start * 100.0),
            round_text(p.gradient_end * 100.0),
            round_text((1.0 - p.gradient_start) * 100.0),
            round_text((1.0 - p.gradient_end) * 100.0),
            String::from_utf16_lossy(&num(p.local_z_max_sublayers)),
        )),
        None => u("Choose two distinct physical heads and at least two Local-Z sublayers."),
    };
    let complete = projection.is_some() && components.len() == 2 && issues.is_empty();
    if !complete {
        return Validation {
            draft: None,
            issues: dedupe(issues),
            preview,
            ranking: None,
        };
    }
    let (offset_a, offset_b) = offsets(form);
    let mut components = components.into_iter();
    Validation {
        draft: Some(Draft {
            name: form.name.clone(),
            display_color: form.display_color.clone(),
            offset_a,
            offset_b,
            mode: DraftMode::Gradient {
                components: [
                    components.next().expect("two"),
                    components.next().expect("two"),
                ],
                a_to_b: form.gradient_a_to_b,
                local_z_max_sublayers: sublayers.expect("complete"),
                projection: projection.expect("complete"),
            },
        }),
        issues: Vec::new(),
        preview,
        ranking: None,
    }
}

/// `rankSuppliedCandidates`.
pub fn rank_supplied(
    library: &Library,
    target: &[u16],
    minimum: f64,
    candidates: &[Candidate],
) -> Ranking {
    let count = library.physical.len() as f64;
    let mut eligible: Vec<&Candidate> = Vec::new();
    for candidate in candidates {
        let selectable = candidate.components.iter().all(|(id, _)| {
            library
                .choice(id)
                .is_some_and(|physical| physical.enabled && physical.compatible)
        });
        if !selectable {
            continue;
        }
        let components: Vec<(f64, f64)> = candidate
            .components
            .iter()
            .filter_map(|(id, weight)| {
                library
                    .choice(id)
                    .map(|physical| (physical.tool_id, *weight))
            })
            .collect();
        let result = authoring::project(
            &Input::Match {
                components,
                target_color: target.to_vec(),
                min_component_percent: minimum,
            },
            count,
        );
        if result.ok {
            eligible.push(candidate);
        }
    }
    let supplied: Vec<authoring::Candidate> = eligible
        .iter()
        .map(|candidate| authoring::Candidate {
            components: candidate
                .components
                .iter()
                .map(|(id, weight)| (library.choice(id).expect("eligible").tool_id, *weight))
                .collect(),
            preview_color: candidate.preview_color.clone(),
        })
        .collect();
    let ranked = authoring::rank(count, target, minimum, &supplied);
    let issues = if ranked.ok {
        Vec::new()
    } else {
        dedupe(ranked.issues.iter().map(authoring_issue).collect())
    };
    Ranking {
        normalized_target_color: ranked.normalized_target_color,
        ranked: ranked
            .candidates
            .into_iter()
            .map(|entry| RankView {
                candidate: eligible[entry.source_index].clone(),
                ranked: entry,
            })
            .collect(),
        issues,
    }
}

/// `matchCandidateTitle` (`index` zero-based).
pub fn candidate_title(index: usize, candidate: &Candidate) -> Units {
    cat(&[
        &u(&format!("#{} · ", index + 1)),
        candidate.label.as_ref().unwrap_or(&candidate.id),
    ])
}

/// `matchCandidateDetail`.
pub fn candidate_detail(view: &RankView, library: &Library) -> Units {
    cat(&[
        &component_summary(&view.candidate.components, library),
        &u(" · predicted "),
        &view.ranked.preview_color,
        &u(" · ΔE2000 "),
        &fixed(view.ranked.delta_e2000, 2),
    ])
}

/// `componentSummary`.
pub fn component_summary(components: &[(Units, f64)], library: &Library) -> Units {
    let weights: Vec<f64> = components.iter().map(|(_, weight)| *weight).collect();
    let normalized =
        authoring::normalize_match_weights(&weights, weights.len()).unwrap_or_default();
    let parts: Vec<Units> = components
        .iter()
        .enumerate()
        .map(|(index, (id, _))| {
            let head = match library.choice(id) {
                Some(physical) => cat(&[&u("H"), &num(physical.tool_id), &u(" "), &physical.name]),
                None => id.clone(),
            };
            cat(&[
                &head,
                &u(" "),
                &num(normalized.get(index).copied().unwrap_or(f64::NAN)),
                &u("%"),
            ])
        })
        .collect();
    cat(&[&u("Saved weights: "), &parts.join(&u(" / ")[..])])
}

/// `draftSummary`: a row's recipe in one line.
pub fn draft_summary(draft: &Draft, library: &Library) -> Units {
    let name_of = |id: &[u16]| {
        library
            .choice(id)
            .map_or_else(|| id.to_vec(), |choice| choice.name.clone())
    };
    match &draft.mode {
        DraftMode::Ratio {
            components,
            mix_b_percent,
            projection,
            ..
        } => {
            let names: Vec<Units> = components.iter().map(|c| name_of(&c.filament_id)).collect();
            let joined = names.join(&u(" + ")[..]);
            if components.len() == 2 {
                cat(&[&joined, &u(" · B "), &num(*mix_b_percent), &u("%")])
            } else {
                cat(&[
                    &joined,
                    &u(" · triangle "),
                    &projection.gradient_component_weights,
                ])
            }
        }
        DraftMode::Cycle {
            normalized_pattern, ..
        } => cat(&[&u("Pattern "), normalized_pattern]),
        DraftMode::Match {
            normalized_target_color,
            preview_color,
            selected_candidate_id,
            ..
        } => cat(&[
            &u("Target "),
            normalized_target_color,
            &u(" · predicted "),
            preview_color,
            &u(" · candidate "),
            selected_candidate_id,
        ]),
        DraftMode::Gradient {
            a_to_b,
            local_z_max_sublayers,
            projection,
            ..
        } => u(&format!(
            "{} · A {}%→{}% · {} sublayers",
            if *a_to_b { "A→B" } else { "B→A" },
            round_text(projection.gradient_start * 100.0),
            round_text(projection.gradient_end * 100.0),
            String::from_utf16_lossy(&num(*local_z_max_sublayers)),
        )),
    }
}

/// `ratioPigmentPreview`: the predicted colour and its line, once the Ratio recipe is complete.
pub fn ratio_preview(form: &Form, library: &Library) -> Option<(Units, Units)> {
    let count = usize::from(form.ratio_count);
    let choices: Vec<Option<&Choice>> = form.ratio_ids[..form.ratio_ids.len().min(count)]
        .iter()
        .map(|id| library.choice(id))
        .collect();
    let (color, method) = if count == 2 {
        let mix_b = strict_integer(&form.ratio_mix_b)?;
        let (Some(Some(first)), Some(Some(second))) = (choices.first(), choices.get(1)) else {
            return None;
        };
        if !(0.0..=100.0).contains(&mix_b) {
            return None;
        }
        (
            u(&blend_pair(&first.color, &second.color, mix_b / 100.0)),
            "pinned two-filament pigment model",
        )
    } else {
        let weights: Vec<Option<f64>> = form
            .ratio_triangle
            .iter()
            .map(|text| strict_finite(text))
            .collect();
        if choices.len() != 3
            || choices.iter().any(Option::is_none)
            || weights.iter().any(|weight| weight.is_none_or(|w| w < 0.0))
        {
            return None;
        }
        let weights: Vec<f64> = weights
            .into_iter()
            .map(|weight| weight.expect("checked"))
            .collect();
        let sum = weights.iter().fold(0.0, |sum, weight| sum + weight);
        if sum <= 0.0 {
            return None;
        }
        let normalized = authoring::normalize_triangle(&weights)?;
        let rgb: Vec<[u8; 3]> = choices
            .iter()
            .map(|choice| parse_color(&choice.expect("checked").color))
            .collect();
        let channel = |c: usize| {
            js_math::round(
                f64::from(rgb[0][c]) * normalized[0]
                    + f64::from(rgb[1][c]) * normalized[1]
                    + f64::from(rgb[2][c]) * normalized[2],
            ) as u8
        };
        (
            u(&to_hex([channel(0), channel(1), channel(2)])),
            "pinned triangle weighted-sRGB preview",
        )
    };
    let text = cat(&[
        &u("Predicted mix "),
        &color,
        &u(&format!(" · {method}. Saved badge remains ")),
        &form.display_color,
        &u("."),
    ]);
    Some((color, text))
}

/// `gradientPreview`: top and bottom colours and the line, once both heads are chosen.
pub fn gradient_preview(form: &Form, library: &Library) -> Option<(Units, Units, Units)> {
    let first = library.choice(&form.gradient_ids[0])?;
    let second = library.choice(&form.gradient_ids[1])?;
    let (top, bottom) = if form.gradient_a_to_b {
        (first, second)
    } else {
        (second, first)
    };
    let text = cat(&[
        &u(if form.gradient_a_to_b {
            "A→B"
        } else {
            "B→A"
        }),
        &u(" vertical preview · A "),
        &u(if form.gradient_a_to_b {
            "80%→20%"
        } else {
            "20%→80%"
        }),
        &u(" · "),
        &first.name,
        &u(" / "),
        &second.name,
    ]);
    Some((top.color.clone(), bottom.color.clone(), text))
}

/// The triangle picker's corners in its 240 × 216 view box.
const VERTICES: [(f64, f64); 3] = [(120.0, 18.0), (18.0, 198.0), (222.0, 198.0)];

/// `triangleMarker`: where the marker sits for the typed proportions, its proportions and what it reads.
pub fn triangle_marker(texts: &[Units; 3]) -> (f64, f64, [f64; 3], Units) {
    let values: Vec<f64> = texts.iter().map(|text| utf16_number(text)).collect();
    let safe: Vec<f64> = values
        .iter()
        .map(|v| if v.is_finite() && *v >= 0.0 { *v } else { 0.0 })
        .collect();
    let total = safe[0] + safe[1] + safe[2];
    let weights = if total <= 0.0 {
        [34.0, 33.0, 33.0]
    } else {
        [
            (safe[0] * 100.0) / total,
            (safe[1] * 100.0) / total,
            (safe[2] * 100.0) / total,
        ]
    };
    let x = (weights[0] * VERTICES[0].0 + weights[1] * VERTICES[1].0 + weights[2] * VERTICES[2].0)
        / 100.0;
    let y = (weights[0] * VERTICES[0].1 + weights[1] * VERTICES[1].1 + weights[2] * VERTICES[2].1)
        / 100.0;
    let text = cat(&[
        &u("A "),
        &fixed(weights[0], 1),
        &u("%, B "),
        &fixed(weights[1], 1),
        &u("%, C "),
        &fixed(weights[2], 1),
        &u("%"),
    ]);
    (x, y, weights, text)
}

/// `triangleWeightTextsAt`: the proportions the picker writes for a point,
/// or none where the barycentric weights are not finite.
pub fn triangle_texts_at(x: f64, y: f64) -> Option<[Units; 3]> {
    let [(ax, ay), (bx, by), (cx, cy)] = VERTICES;
    let denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    let weights = if !denominator.is_finite() || denominator.abs() < f64::EPSILON {
        [34.0, 33.0, 33.0]
    } else {
        let weight_a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        let weight_b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        authoring::normalize_barycentric(&[weight_a, weight_b, 1.0 - weight_a - weight_b])?
            .map(|w| w * 100.0)
    };
    Some(weights.map(|weight| num(utf16_number(&fixed(weight, 2)))))
}

fn resolve(
    ids: &[Units],
    library: &Library,
    issues: &mut Vec<Issue>,
    prefix: &str,
) -> Vec<Component> {
    let mut seen: Vec<&[u16]> = Vec::new();
    let mut components = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let field = format!("{prefix}-{index}");
        let Some(choice) = library.choice(id) else {
            issues.push(issue(
                u(&format!(
                    "Component {} must choose a physical head.",
                    index + 1
                )),
                &field,
            ));
            continue;
        };
        if !choice.enabled {
            issues.push(issue(cat(&[&choice.name, &u(" is disabled.")]), &field));
        }
        if !choice.compatible {
            let reason = match &choice.incompatibility_reason {
                Some(reason) => cat(&[&u(": "), reason]),
                None => u("."),
            };
            issues.push(issue(
                cat(&[&choice.name, &u(" is incompatible"), &reason]),
                &field,
            ));
        }
        if seen.contains(&id.as_slice()) {
            issues.push(issue(
                u("A recipe cannot select the same physical head more than once."),
                &field,
            ));
            continue;
        }
        seen.push(id);
        components.push(Component {
            filament_id: id.clone(),
            tool_id: choice.tool_id,
        });
    }
    components
}

fn authoring_issue(found: &authoring::Issue) -> Issue {
    let path = String::from_utf16_lossy(&found.location.path);
    let field = [
        ("mixBPercent", "ratio-mix-b"),
        ("triangleWeightsPercent", "ratio-weight-0"),
        ("targetColor", "match-target"),
        ("minComponentPercent", "match-minimum"),
        ("localZMaxSublayers", "gradient-sublayers"),
    ]
    .into_iter()
    .find(|(key, _)| path.contains(key))
    .map(|(_, field)| u(field));
    Issue {
        message: found.message.clone(),
        field,
        start_offset: None,
        end_offset: None,
    }
}

/// `dedupeIssues`: the first of each field, characters and message.
pub fn dedupe(issues: Vec<Issue>) -> Vec<Issue> {
    let mut out: Vec<Issue> = Vec::new();
    for each in issues {
        if !out.iter().any(|known| {
            known.field == each.field
                && known.start_offset == each.start_offset
                && known.end_offset == each.end_offset
                && known.message == each.message
        }) {
            out.push(each);
        }
    }
    out
}

/// `parseStrictInteger`: `/^-?\d+$/` and a safe integer.
pub fn strict_integer(value: &[u16]) -> Option<f64> {
    let digits = value.strip_prefix(&[u16::from(b'-')]).unwrap_or(value);
    if digits.is_empty()
        || !digits
            .iter()
            .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
    {
        return None;
    }
    let parsed = utf16_number(value);
    is_safe_integer(parsed).then_some(parsed)
}

/// `parseStrictFinite`: `Number(value)` unless blank or not finite.
pub fn strict_finite(value: &[u16]) -> Option<f64> {
    if trim_utf16(value).is_empty() {
        return None;
    }
    let parsed = utf16_number(value);
    parsed.is_finite().then_some(parsed)
}

/// `normalizeMatchTargetColor`: a strict `#RRGGBB`, upper-cased.
pub fn match_target(value: &[u16]) -> Option<Units> {
    is_hex_color(value).then(|| upper_hex(value))
}

fn round_text(value: f64) -> String {
    String::from_utf16_lossy(&num(js_math::round(value)))
}
