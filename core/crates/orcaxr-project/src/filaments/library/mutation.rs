//! A library edit's step (`VirtualFilamentMutation.ts`, after the adapter's
//! `toFullSpectrumRecipeDraft`): the dialog's validated draft converted to a
//! recipe draft on stable IDs, the recipe built or replaced, and the commands
//! one undoable step submits with the label it records — "Add <name>" for an
//! added or duplicated recipe, "Edit mixed filament", "Enable/Disable mixed
//! filament", "Remove mixed filament" for an unreferenced recipe and "Delete
//! mixed filament" for a referenced or automatic one (a tombstone that keeps
//! its references) — or the refusal, in the browser's words.
use super::super::recipe::{self, Distribution, DraftMode as RecipeMode, Recipe, State};
use super::super::text::{cat, u};
use super::{Draft, DraftMode, Units, mixed};
use crate::commands::filament_dependent_paths;
use crate::model::ProjectState;
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;
use std::collections::BTreeMap;

/// One library edit (`VirtualFilamentMutation`), the new filament's ID named by the host.
#[derive(Debug, Clone, PartialEq)]
pub enum Mutation {
    Add {
        draft: Draft,
        new_id: Units,
    },
    Edit {
        filament_id: Units,
        draft: Draft,
    },
    Duplicate {
        source_id: Units,
        draft: Draft,
        new_id: Units,
    },
    SetEnabled {
        filament_id: Units,
        enabled: bool,
    },
    Delete {
        filament_id: Units,
    },
}
impl Mutation {
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Add { .. } => "add",
            Self::Edit { .. } => "edit",
            Self::Duplicate { .. } => "duplicate",
            Self::SetEnabled { .. } => "set-enabled",
            Self::Delete { .. } => "delete",
        }
    }
}

/// What a deletion did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deletion {
    Removed,
    Tombstoned,
}

/// `VirtualFilamentMutationPlan`: the step's label, whether it is one intent
/// or a labelled transaction, its batch, and the outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub label: Units,
    /// One intent (its label the command's own) rather than a transaction.
    pub intent: bool,
    pub batch: wire::Batch,
    pub operation: &'static str,
    pub filament_id: Option<Units>,
    pub deletion: Option<(Deletion, Vec<Units>)>,
}

/// Plans `mutation` on `state`, or answers the refusal.
pub fn plan(state: &ProjectState, mutation: &Mutation) -> Result<Plan, Units> {
    // The adapter resolves recipes on the library's live rows (tombstones hidden).
    let live = |id: &[u16]| -> Result<Units, Units> {
        match mixed(state, id) {
            Some(filament) if !filament.full_spectrum.as_ref().is_some_and(|fs| fs.deleted) => {
                Ok(id.to_vec())
            }
            _ => Err(cat(&[&u("Unknown virtual filament "), id])),
        }
    };
    let physical = &state.filaments.physical;
    match mutation {
        Mutation::Add { draft, new_id } => {
            let recipe_draft = convert(state, draft, None, false)?;
            let built = recipe::create(new_id, physical, &recipe_draft, None)?;
            Ok(add_plan(&built, "add"))
        }
        Mutation::Edit { filament_id, draft } => {
            let id = live(filament_id)?;
            let recipe_draft = convert(state, draft, Some(&id), false)?;
            let current =
                mixed(state, &id).ok_or_else(|| cat(&[&u("Unknown mixed filament "), &id]))?;
            let replacement = recipe::replace(current, physical, &recipe_draft)?;
            let label = u("Edit mixed filament");
            let command = object([(
                "editMixedFilament",
                object([
                    ("mixedFilamentId", text(&id)),
                    ("name", present(text(&replacement.name))),
                    ("displayColor", present(text(&replacement.display_color))),
                    ("components", present(components(&replacement.components))),
                    (
                        "distribution",
                        present(distribution(&replacement.distribution)),
                    ),
                    (
                        "fullSpectrum",
                        present(full_spectrum(&replacement.full_spectrum)),
                    ),
                    ("configJson", absent()),
                ]),
            )]);
            Ok(Plan {
                batch: batch(&label, vec![command]),
                label,
                intent: false,
                operation: "edit",
                filament_id: None,
                deletion: None,
            })
        }
        Mutation::Duplicate {
            source_id,
            draft,
            new_id,
        } => {
            let id = live(source_id)?;
            let recipe_draft = convert(state, draft, Some(&id), true)?;
            let built = recipe::create(new_id, physical, &recipe_draft, None)?;
            Ok(add_plan(&built, "duplicate"))
        }
        Mutation::SetEnabled {
            filament_id,
            enabled,
        } => {
            let id = live(filament_id)?;
            let label = u(if *enabled {
                "Enable mixed filament"
            } else {
                "Disable mixed filament"
            });
            let command = object([(
                "setMixedFilamentEnabled",
                object([
                    ("mixedFilamentId", text(&id)),
                    ("enabled", Value::Bool(*enabled)),
                    ("reason", present(text(&u("virtual-filament-library")))),
                ]),
            )]);
            Ok(Plan {
                batch: batch(&label, vec![command]),
                label,
                intent: true,
                operation: "set-enabled",
                filament_id: None,
                deletion: None,
            })
        }
        Mutation::Delete { filament_id } => {
            let id = live(filament_id)?;
            let filament = mixed(state, &id).expect("a live recipe");
            let paths =
                filament_dependent_paths(state, &id).map_err(|message| message.units().to_vec())?;
            let automatic = filament
                .full_spectrum
                .as_ref()
                .is_some_and(|fs| fs.origin_auto);
            if !paths.is_empty() || automatic {
                let reason = if paths.is_empty() {
                    "delete-auto-pair"
                } else {
                    "delete-with-canonical-dependencies"
                };
                let label = u("Delete mixed filament");
                let command = object([(
                    "tombstoneMixedFilament",
                    object([
                        ("mixedFilamentId", text(&id)),
                        ("reason", present(text(&u(reason)))),
                    ]),
                )]);
                return Ok(Plan {
                    batch: batch(&label, vec![command]),
                    label,
                    intent: false,
                    operation: "delete",
                    filament_id: None,
                    deletion: Some((Deletion::Tombstoned, paths)),
                });
            }
            let label = u("Remove mixed filament");
            let command = object([(
                "removeMixedFilament",
                object([("mixedFilamentId", text(&id))]),
            )]);
            Ok(Plan {
                batch: batch(&label, vec![command]),
                label,
                intent: true,
                operation: "delete",
                filament_id: None,
                deletion: Some((Deletion::Removed, Vec::new())),
            })
        }
    }
}

fn add_plan(built: &Recipe, operation: &'static str) -> Plan {
    let label = cat(&[&u("Add "), &built.name]);
    let filament = object([
        ("mixedFilamentId", text(&built.id)),
        ("name", text(&built.name)),
        ("displayColor", text(&built.display_color)),
        ("components", components(&built.components)),
        ("distribution", distribution(&built.distribution)),
        ("fullSpectrum", present(full_spectrum(&built.full_spectrum))),
        ("configJson", text(&u("{}"))),
        ("enabled", Value::Bool(built.enabled)),
        ("extensionDataJson", absent()),
    ]);
    let command = object([("addMixedFilament", object([("filament", filament)]))]);
    Plan {
        batch: batch(&label, vec![command]),
        label,
        intent: true,
        operation,
        filament_id: Some(built.id.clone()),
        deletion: None,
    }
}

/// `toFullSpectrumRecipeDraft`: the dialog's draft on the project's stable IDs.
fn convert(
    state: &ProjectState,
    draft: &Draft,
    source: Option<&[u16]>,
    preserve_enabled: bool,
) -> Result<recipe::Draft, Units> {
    let physical = &state.filaments.physical;
    let display_color = super::super::text::six_digit(&draft.display_color).ok_or_else(|| {
        cat(&[
            &u("Invalid FullSpectrum color "),
            &crate::js_math::convert::json_stringify(&Value::String(draft.display_color.clone())),
        ])
    })?;
    let enabled = if preserve_enabled {
        source
            .and_then(|id| mixed(state, id))
            .map(|filament| filament.enabled)
    } else {
        None
    };
    let physical_id = |id: &[u16]| -> Result<Units, Units> {
        physical
            .iter()
            .rev()
            .find(|entry| entry.id.as_utf16() == id)
            .map(|entry| entry.id.as_utf16().to_vec())
            .ok_or_else(|| cat(&[&u("Unknown physical filament "), id]))
    };
    let mode = match &draft.mode {
        DraftMode::Ratio {
            components,
            mix_b_percent,
            triangle,
            ..
        } => RecipeMode::Ratio {
            components: components
                .iter()
                .map(|c| physical_id(&c.filament_id))
                .collect::<Result<_, _>>()?,
            mix_b_percent: *mix_b_percent,
            triangle: triangle.map(|t| t.to_vec()),
        },
        DraftMode::Cycle { groups, .. } => RecipeMode::Cycle {
            groups: recipe::stable_cycle_groups(physical, groups)?,
        },
        DraftMode::Match {
            normalized_target_color,
            min_component_percent,
            components,
            ..
        } => RecipeMode::Match {
            components: components
                .iter()
                .map(|c| Ok((physical_id(&c.filament_id)?, c.weight)))
                .collect::<Result<_, Units>>()?,
            target_color: normalized_target_color.clone(),
            min_component_percent: *min_component_percent,
        },
        DraftMode::Gradient {
            components,
            a_to_b,
            local_z_max_sublayers,
            ..
        } => RecipeMode::Gradient {
            components: [
                physical_id(&components[0].filament_id)?,
                physical_id(&components[1].filament_id)?,
            ],
            a_to_b: *a_to_b,
            local_z_max_sublayers: *local_z_max_sublayers,
        },
    };
    Ok(recipe::Draft {
        name: draft.name.clone(),
        display_color,
        enabled,
        offset_a: Some(draft.offset_a),
        offset_b: Some(draft.offset_b),
        mode,
    })
}

// --- The intent wire (`intentWire.ts`): text as UTF-16 unit arrays ------------------------------

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(name, value)| (u(name), value))
            .collect::<BTreeMap<_, _>>(),
    )
}
fn text(units: &[u16]) -> Value {
    Value::Array(
        units
            .iter()
            .map(|unit| Value::Number(f64::from(*unit)))
            .collect(),
    )
}
fn present(value: Value) -> Value {
    object([("value", value)])
}
fn absent() -> Value {
    object([("absent", object([]))])
}
fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|value| Value::Number(*value)).collect())
}
fn components(components: &[(Units, f64)]) -> Value {
    Value::Array(
        components
            .iter()
            .map(|(id, weight)| {
                object([("filamentId", text(id)), ("weight", Value::Number(*weight))])
            })
            .collect(),
    )
}
fn distribution(distribution: &Distribution) -> Value {
    match distribution {
        Distribution::Ratio => object([("ratio", object([]))]),
        Distribution::Cycle => object([("cycle", object([("cycleLengthMm", absent())]))]),
        Distribution::Match { target_color } => {
            object([("match", object([("targetColor", text(target_color))]))])
        }
        Distribution::Gradient {
            start_weights,
            end_weights,
        } => object([(
            "gradient",
            object([
                ("startZMm", absent()),
                ("endZMm", absent()),
                ("startWeights", numbers(start_weights)),
                ("endWeights", numbers(end_weights)),
            ]),
        )]),
    }
}
fn full_spectrum(state: &State) -> Value {
    let ids = |list: &[Units]| Value::Array(list.iter().map(|id| text(id)).collect());
    let ui_mode = match state.ui_mode as i64 {
        0 => "ui0",
        1 => "ui1",
        2 => "ui2",
        3 => "ui3",
        _ => "legacy",
    };
    object([
        ("upstreamStableId", text(&state.upstream_stable_id)),
        ("uiMode", Value::String(u(ui_mode))),
        ("componentAId", text(&state.component_a_id)),
        ("componentBId", text(&state.component_b_id)),
        ("ratioA", Value::Number(state.ratio_a)),
        ("ratioB", Value::Number(state.ratio_b)),
        ("mixBPercent", Value::Number(state.mix_b_percent)),
        (
            "manualPatternGroups",
            Value::Array(
                state
                    .manual_pattern_groups
                    .iter()
                    .map(|group| ids(group))
                    .collect(),
            ),
        ),
        ("gradientComponentIds", ids(&state.gradient_component_ids)),
        (
            "gradientComponentWeights",
            numbers(&state.gradient_component_weights),
        ),
        (
            "distributionMode",
            Value::String(u(if state.distribution_mode == 0.0 {
                "m0"
            } else {
                "m2"
            })),
        ),
        (
            "localZMaxSublayers",
            Value::Number(state.local_z_max_sublayers),
        ),
        ("gradientEnabled", Value::Bool(state.gradient_enabled)),
        ("gradientStart", Value::Number(state.gradient_start)),
        ("gradientEnd", Value::Number(state.gradient_end)),
        ("componentASurfaceOffsetMm", Value::Number(state.offset_a)),
        ("componentBSurfaceOffsetMm", Value::Number(state.offset_b)),
        ("deleted", Value::Bool(state.deleted)),
        ("custom", Value::Bool(state.custom)),
        ("originAuto", Value::Bool(state.origin_auto)),
    ])
}

/// The step's batch, through the shared contract (as `encodeProjectBatch` captures it).
fn batch(label: &[u16], commands: Vec<Value>) -> wire::Batch {
    let value = object([
        ("version", Value::Number(1.0)),
        ("label", text(label)),
        ("commands", Value::Array(commands)),
    ]);
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).expect("in-memory JSON");
    wire::decode_batch(&String::from_utf8(bytes).expect("ASCII JSON"))
        .expect("a planned batch the contract accepts")
}
