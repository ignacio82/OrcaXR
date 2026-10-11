//! The hosts' contract for the virtual filament library
//! (`VirtualFilamentExchange.ts`): canonical JSON requests and replies,
//! answered byte for byte as the browser answers them. A `library` is the
//! library exchange's own reply; a malformed request is refused as
//! [`INVALID_REQUEST`].
use super::super::authoring::Projection;
use super::super::match_search::{self, Entry};
use super::super::text::{cat, u};
use super::form::{self, Form, Mode, Operation, Search};
use super::mutation::{self, Deletion, Mutation};
use super::{
    Candidate, Choice, Component, Draft, DraftMode, Library, Row, Units, WeightedComponent, library,
};
use crate::model::ProjectState;
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_contracts::project_intent_types as wire;
use std::collections::BTreeMap;

/// Why a request could not be read.
pub const INVALID_REQUEST: &str = "invalid_request";
const INPUT_LIMIT: &str = "input_limit";

type Fields = BTreeMap<Vec<u16>, Value>;
type Read<T> = Result<T, &'static str>;

fn read(request: &str) -> Read<Value> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
/// `object(value, required, optional)`: exactly the required keys and any of the optional ones.
fn object(value: Value, required: &[&str], optional: &[&str]) -> Read<Fields> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| required.iter().chain(optional).any(|name| u(name) == *key);
    if !fields.keys().all(known) || !required.iter().all(|name| fields.contains_key(&u(name))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut Fields, name: &str) -> Option<Value> {
    fields.remove(&u(name))
}
fn text(value: Option<Value>) -> Read<Units> {
    match value {
        Some(Value::String(units)) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn number(value: Option<Value>) -> Read<f64> {
    match value {
        Some(Value::Number(n)) => Ok(n),
        _ => Err(INVALID_REQUEST),
    }
}
fn boolean(value: Option<Value>) -> Read<bool> {
    match value {
        Some(Value::Bool(b)) => Ok(b),
        _ => Err(INVALID_REQUEST),
    }
}
fn list(value: Option<Value>) -> Read<Vec<Value>> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(INVALID_REQUEST),
    }
}
fn texts(value: Option<Value>) -> Read<Vec<Units>> {
    list(value)?
        .into_iter()
        .map(|item| text(Some(item)))
        .collect()
}
fn numbers(value: Option<Value>) -> Read<Vec<f64>> {
    list(value)?
        .into_iter()
        .map(|item| number(Some(item)))
        .collect()
}
fn one_of(value: Option<Value>, choices: &[&str]) -> Read<Units> {
    let chosen = text(value)?;
    if choices.iter().any(|choice| u(choice) == chosen) {
        Ok(chosen)
    } else {
        Err(INVALID_REQUEST)
    }
}
fn optional_text(fields: &mut Fields, name: &str) -> Read<Option<Units>> {
    take(fields, name)
        .map(|value| text(Some(value)))
        .transpose()
}

fn s(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn n(value: f64) -> Value {
    Value::Number(value)
}
fn record<const N: usize>(fields: [(&str, Value); N]) -> Fields {
    fields
        .into_iter()
        .map(|(name, value)| (u(name), value))
        .collect()
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).expect("finite JSON");
    String::from_utf8(bytes).expect("UTF-8 JSON")
}
fn refused(message: &[u16]) -> String {
    canonical(&Value::Object(record([("error", s(message))])))
}

// --- Library documents ---------------------------------------------------------------------------

fn projection_value(p: &Projection) -> Value {
    Value::Object(record([
        ("component_a", n(p.component_a)),
        ("component_b", n(p.component_b)),
        ("custom", Value::Bool(true)),
        ("distribution_mode", n(f64::from(p.distribution_mode))),
        ("gradient_component_ids", s(&p.gradient_component_ids)),
        (
            "gradient_component_weights",
            s(&p.gradient_component_weights),
        ),
        ("gradient_enabled", Value::Bool(p.gradient_enabled)),
        ("gradient_end", n(p.gradient_end)),
        ("gradient_start", n(p.gradient_start)),
        ("local_z_max_sublayers", n(p.local_z_max_sublayers)),
        ("manual_pattern", s(&p.manual_pattern)),
        ("mix_b_percent", n(p.mix_b_percent)),
        ("ratio_a", n(p.ratio_a)),
        ("ratio_b", n(p.ratio_b)),
        ("ui_mode", n(f64::from(p.ui_mode))),
    ]))
}
fn read_projection(value: Option<Value>) -> Read<Projection> {
    let mut f = object(
        value.ok_or(INVALID_REQUEST)?,
        &[
            "component_a",
            "component_b",
            "custom",
            "distribution_mode",
            "gradient_component_ids",
            "gradient_component_weights",
            "gradient_enabled",
            "gradient_end",
            "gradient_start",
            "local_z_max_sublayers",
            "manual_pattern",
            "mix_b_percent",
            "ratio_a",
            "ratio_b",
            "ui_mode",
        ],
        &[],
    )?;
    let ui_mode = number(take(&mut f, "ui_mode"))?;
    let distribution_mode = number(take(&mut f, "distribution_mode"))?;
    if ![0.0, 2.0, 3.0].contains(&ui_mode)
        || ![0.0, 2.0].contains(&distribution_mode)
        || take(&mut f, "custom") != Some(Value::Bool(true))
    {
        return Err(INVALID_REQUEST);
    }
    Ok(Projection {
        ui_mode: ui_mode as u8,
        component_a: number(take(&mut f, "component_a"))?,
        component_b: number(take(&mut f, "component_b"))?,
        mix_b_percent: number(take(&mut f, "mix_b_percent"))?,
        ratio_a: number(take(&mut f, "ratio_a"))?,
        ratio_b: number(take(&mut f, "ratio_b"))?,
        manual_pattern: text(take(&mut f, "manual_pattern"))?,
        gradient_component_ids: text(take(&mut f, "gradient_component_ids"))?,
        gradient_component_weights: text(take(&mut f, "gradient_component_weights"))?,
        distribution_mode: distribution_mode as u8,
        local_z_max_sublayers: number(take(&mut f, "local_z_max_sublayers"))?,
        gradient_enabled: boolean(take(&mut f, "gradient_enabled"))?,
        gradient_start: number(take(&mut f, "gradient_start"))?,
        gradient_end: number(take(&mut f, "gradient_end"))?,
    })
}
fn component_value(c: &Component) -> Value {
    Value::Object(record([
        ("filamentId", s(&c.filament_id)),
        ("toolId", n(c.tool_id)),
    ]))
}
fn read_component(value: Value) -> Read<Component> {
    let mut f = object(value, &["filamentId", "toolId"], &[])?;
    Ok(Component {
        filament_id: text(take(&mut f, "filamentId"))?,
        tool_id: number(take(&mut f, "toolId"))?,
    })
}
fn read_weighted(value: Value) -> Read<WeightedComponent> {
    let mut f = object(value, &["filamentId", "toolId", "weight"], &[])?;
    Ok(WeightedComponent {
        filament_id: text(take(&mut f, "filamentId"))?,
        tool_id: number(take(&mut f, "toolId"))?,
        weight: number(take(&mut f, "weight"))?,
    })
}

/// `draftJson`.
pub fn draft_value(draft: &Draft) -> Value {
    let mut fields = record([
        ("componentASurfaceOffsetMm", n(draft.offset_a)),
        ("componentBSurfaceOffsetMm", n(draft.offset_b)),
        ("displayColor", s(&draft.display_color)),
        ("mode", s(&u(draft.mode.name()))),
        ("name", s(&draft.name)),
    ]);
    let components = |list: &[Component]| Value::Array(list.iter().map(component_value).collect());
    match &draft.mode {
        DraftMode::Ratio {
            components: list,
            mix_b_percent,
            triangle,
            projection,
        } => {
            fields.extend(record([
                ("components", components(list)),
                ("mixBPercent", n(*mix_b_percent)),
                ("projection", projection_value(projection)),
            ]));
            if let Some(weights) = triangle {
                fields.insert(
                    u("triangleWeightsPercent"),
                    Value::Array(weights.iter().map(|w| n(*w)).collect()),
                );
            }
        }
        DraftMode::Cycle {
            manual_pattern,
            normalized_pattern,
            components: list,
            groups,
            sequence,
        } => fields.extend(record([
            ("components", components(list)),
            (
                "groups",
                Value::Array(
                    groups
                        .iter()
                        .map(|group| Value::Array(group.iter().map(|t| n(*t)).collect()))
                        .collect(),
                ),
            ),
            ("manualPattern", s(manual_pattern)),
            ("normalizedPattern", s(normalized_pattern)),
            (
                "sequence",
                Value::Array(sequence.iter().map(|t| n(*t)).collect()),
            ),
        ])),
        DraftMode::Match {
            target_color,
            normalized_target_color,
            min_component_percent,
            selected_candidate_id,
            preview_color,
            delta_e2000,
            components: list,
            projection,
        } => fields.extend(record([
            (
                "components",
                Value::Array(
                    list.iter()
                        .map(|c| {
                            Value::Object(record([
                                ("filamentId", s(&c.filament_id)),
                                ("toolId", n(c.tool_id)),
                                ("weight", n(c.weight)),
                            ]))
                        })
                        .collect(),
                ),
            ),
            ("deltaE2000", n(*delta_e2000)),
            ("minComponentPercent", n(*min_component_percent)),
            ("normalizedTargetColor", s(normalized_target_color)),
            ("previewColor", s(preview_color)),
            ("projection", projection_value(projection)),
            ("selectedCandidateId", s(selected_candidate_id)),
            ("targetColor", s(target_color)),
        ])),
        DraftMode::Gradient {
            components: list,
            a_to_b,
            local_z_max_sublayers,
            projection,
        } => fields.extend(record([
            ("components", components(list)),
            (
                "direction",
                s(&u(if *a_to_b { "a-to-b" } else { "b-to-a" })),
            ),
            ("localZMaxSublayers", n(*local_z_max_sublayers)),
            ("projection", projection_value(projection)),
        ])),
    }
    Value::Object(fields)
}

const COMMON: [&str; 5] = [
    "componentASurfaceOffsetMm",
    "componentBSurfaceOffsetMm",
    "displayColor",
    "mode",
    "name",
];

/// `readDraft`.
pub fn read_draft(value: Option<Value>) -> Read<Draft> {
    let Some(Value::Object(probe)) = value else {
        return Err(INVALID_REQUEST);
    };
    let mode = one_of(
        probe.get(&u("mode")).cloned(),
        &["ratio", "cycle", "match", "gradient"],
    )?;
    let mode = Mode::parse(&mode).expect("a mode");
    let (extra, optional): (&[&str], &[&str]) = match mode {
        Mode::Ratio => (
            &["components", "mixBPercent", "projection"],
            &["triangleWeightsPercent"],
        ),
        Mode::Cycle => (
            &[
                "components",
                "groups",
                "manualPattern",
                "normalizedPattern",
                "sequence",
            ],
            &[],
        ),
        Mode::Match => (
            &[
                "components",
                "deltaE2000",
                "minComponentPercent",
                "normalizedTargetColor",
                "previewColor",
                "projection",
                "selectedCandidateId",
                "targetColor",
            ],
            &[],
        ),
        Mode::Gradient => (
            &[
                "components",
                "direction",
                "localZMaxSublayers",
                "projection",
            ],
            &[],
        ),
    };
    let required: Vec<&str> = COMMON.iter().chain(extra).copied().collect();
    let mut f = object(Value::Object(probe), &required, optional)?;
    let name = text(take(&mut f, "name"))?;
    let display_color = text(take(&mut f, "displayColor"))?;
    let offset_a = number(take(&mut f, "componentASurfaceOffsetMm"))?;
    let offset_b = number(take(&mut f, "componentBSurfaceOffsetMm"))?;
    let draft_mode = match mode {
        Mode::Ratio => {
            let triangle = match take(&mut f, "triangleWeightsPercent") {
                None => None,
                Some(value) => {
                    let weights = numbers(Some(value))?;
                    if weights.len() != 3 {
                        return Err(INVALID_REQUEST);
                    }
                    Some([weights[0], weights[1], weights[2]])
                }
            };
            DraftMode::Ratio {
                components: list(take(&mut f, "components"))?
                    .into_iter()
                    .map(read_component)
                    .collect::<Read<_>>()?,
                mix_b_percent: number(take(&mut f, "mixBPercent"))?,
                triangle,
                projection: read_projection(take(&mut f, "projection"))?,
            }
        }
        Mode::Cycle => DraftMode::Cycle {
            manual_pattern: text(take(&mut f, "manualPattern"))?,
            normalized_pattern: text(take(&mut f, "normalizedPattern"))?,
            components: list(take(&mut f, "components"))?
                .into_iter()
                .map(read_component)
                .collect::<Read<_>>()?,
            groups: list(take(&mut f, "groups"))?
                .into_iter()
                .map(|group| numbers(Some(group)))
                .collect::<Read<_>>()?,
            sequence: numbers(take(&mut f, "sequence"))?,
        },
        Mode::Match => DraftMode::Match {
            target_color: text(take(&mut f, "targetColor"))?,
            normalized_target_color: text(take(&mut f, "normalizedTargetColor"))?,
            min_component_percent: number(take(&mut f, "minComponentPercent"))?,
            selected_candidate_id: text(take(&mut f, "selectedCandidateId"))?,
            preview_color: text(take(&mut f, "previewColor"))?,
            delta_e2000: number(take(&mut f, "deltaE2000"))?,
            components: list(take(&mut f, "components"))?
                .into_iter()
                .map(read_weighted)
                .collect::<Read<_>>()?,
            projection: read_projection(take(&mut f, "projection"))?,
        },
        Mode::Gradient => {
            let components: Vec<Component> = list(take(&mut f, "components"))?
                .into_iter()
                .map(read_component)
                .collect::<Read<_>>()?;
            let [first, second]: [Component; 2] =
                components.try_into().map_err(|_| INVALID_REQUEST)?;
            let direction = one_of(take(&mut f, "direction"), &["a-to-b", "b-to-a"])?;
            DraftMode::Gradient {
                components: [first, second],
                a_to_b: direction == u("a-to-b"),
                local_z_max_sublayers: number(take(&mut f, "localZMaxSublayers"))?,
                projection: read_projection(take(&mut f, "projection"))?,
            }
        }
    };
    Ok(Draft {
        name,
        display_color,
        offset_a,
        offset_b,
        mode: draft_mode,
    })
}

fn choice_value(choice: &Choice) -> Value {
    let mut fields = record([
        ("color", s(&choice.color)),
        ("compatible", Value::Bool(choice.compatible)),
        ("enabled", Value::Bool(choice.enabled)),
        ("id", s(&choice.id)),
        ("material", s(&choice.material)),
        ("name", s(&choice.name)),
        ("toolId", n(choice.tool_id)),
    ]);
    if let Some(reason) = &choice.incompatibility_reason {
        fields.insert(u("incompatibilityReason"), s(reason));
    }
    Value::Object(fields)
}
fn read_choice(value: Value) -> Read<Choice> {
    let mut f = object(
        value,
        &[
            "color",
            "compatible",
            "enabled",
            "id",
            "material",
            "name",
            "toolId",
        ],
        &["incompatibilityReason"],
    )?;
    Ok(Choice {
        id: text(take(&mut f, "id"))?,
        tool_id: number(take(&mut f, "toolId"))?,
        name: text(take(&mut f, "name"))?,
        material: text(take(&mut f, "material"))?,
        color: text(take(&mut f, "color"))?,
        enabled: boolean(take(&mut f, "enabled"))?,
        compatible: boolean(take(&mut f, "compatible"))?,
        incompatibility_reason: optional_text(&mut f, "incompatibilityReason")?,
    })
}
/// `candidateJson`.
pub fn candidate_value(candidate: &Candidate) -> Value {
    let mut fields = record([
        (
            "components",
            Value::Array(
                candidate
                    .components
                    .iter()
                    .map(|(id, weight)| {
                        Value::Object(record([("filamentId", s(id)), ("weight", n(*weight))]))
                    })
                    .collect(),
            ),
        ),
        ("id", s(&candidate.id)),
        ("previewColor", s(&candidate.preview_color)),
    ]);
    if let Some(label) = &candidate.label {
        fields.insert(u("label"), s(label));
    }
    Value::Object(fields)
}
fn read_candidate(value: Value) -> Read<Candidate> {
    let mut f = object(value, &["components", "id", "previewColor"], &["label"])?;
    let components = list(take(&mut f, "components"))?
        .into_iter()
        .map(|component| {
            let mut entry = object(component, &["filamentId", "weight"], &[])?;
            Ok((
                text(take(&mut entry, "filamentId"))?,
                number(take(&mut entry, "weight"))?,
            ))
        })
        .collect::<Read<_>>()?;
    Ok(Candidate {
        id: text(take(&mut f, "id"))?,
        label: optional_text(&mut f, "label")?,
        components,
        preview_color: text(take(&mut f, "previewColor"))?,
    })
}
fn row_value(row: &Row, library: &Library) -> Value {
    let mut fields = record([
        ("draft", draft_value(&row.draft)),
        ("enabled", Value::Bool(row.enabled)),
        ("id", s(&row.id)),
        ("summary", s(&form::draft_summary(&row.draft, library))),
    ]);
    if let Some(labels) = &row.dependency_labels {
        fields.insert(
            u("dependencyLabels"),
            Value::Array(labels.iter().map(|label| s(label)).collect()),
        );
    }
    Value::Object(fields)
}
fn read_row(value: Value) -> Read<Row> {
    let mut f = object(
        value,
        &["draft", "enabled", "id", "summary"],
        &["dependencyLabels"],
    )?;
    text(take(&mut f, "summary"))?;
    Ok(Row {
        id: text(take(&mut f, "id"))?,
        enabled: boolean(take(&mut f, "enabled"))?,
        draft: read_draft(take(&mut f, "draft"))?,
        dependency_labels: take(&mut f, "dependencyLabels")
            .map(|labels| texts(Some(labels)))
            .transpose()?,
    })
}
/// The library exchange's reply.
pub fn library_value(library: &Library) -> Value {
    Value::Object(record([
        (
            "matchCandidates",
            Value::Array(library.candidates.iter().map(candidate_value).collect()),
        ),
        (
            "mixedRows",
            Value::Array(
                library
                    .rows
                    .iter()
                    .map(|row| row_value(row, library))
                    .collect(),
            ),
        ),
        (
            "physicalChoices",
            Value::Array(library.physical.iter().map(choice_value).collect()),
        ),
        ("status", s(&library.status())),
    ]))
}
/// A `library` field.
pub fn read_library(value: Option<Value>) -> Read<Library> {
    let mut f = object(
        value.ok_or(INVALID_REQUEST)?,
        &["matchCandidates", "mixedRows", "physicalChoices", "status"],
        &[],
    )?;
    text(take(&mut f, "status"))?;
    Ok(Library {
        physical: list(take(&mut f, "physicalChoices"))?
            .into_iter()
            .map(read_choice)
            .collect::<Read<_>>()?,
        rows: list(take(&mut f, "mixedRows"))?
            .into_iter()
            .map(read_row)
            .collect::<Read<_>>()?,
        candidates: list(take(&mut f, "matchCandidates"))?
            .into_iter()
            .map(read_candidate)
            .collect::<Read<_>>()?,
    })
}

/// `formJson`.
pub fn form_value(form: &Form) -> Value {
    let mut match_fields = record([
        ("minComponentPercent", s(&form.match_minimum)),
        ("targetColor", s(&form.match_target)),
    ]);
    if let Some(selected) = &form.match_selected {
        match_fields.insert(u("selectedCandidateId"), s(selected));
    }
    Value::Object(record([
        ("componentASurfaceOffsetMm", s(&form.offset_a)),
        ("componentBSurfaceOffsetMm", s(&form.offset_b)),
        (
            "cycle",
            Value::Object(record([("manualPattern", s(&form.cycle_pattern))])),
        ),
        ("displayColor", s(&form.display_color)),
        (
            "gradient",
            Value::Object(record([
                (
                    "componentIds",
                    Value::Array(form.gradient_ids.iter().map(|id| s(id)).collect()),
                ),
                (
                    "direction",
                    s(&u(if form.gradient_a_to_b {
                        "a-to-b"
                    } else {
                        "b-to-a"
                    })),
                ),
                ("localZMaxSublayers", s(&form.gradient_sublayers)),
            ])),
        ),
        ("match", Value::Object(match_fields)),
        ("mode", s(&u(form.mode.name()))),
        ("name", s(&form.name)),
        (
            "ratio",
            Value::Object(record([
                ("componentCount", n(f64::from(form.ratio_count))),
                (
                    "componentIds",
                    Value::Array(form.ratio_ids.iter().map(|id| s(id)).collect()),
                ),
                ("mixBPercent", s(&form.ratio_mix_b)),
                (
                    "triangleWeights",
                    Value::Array(form.ratio_triangle.iter().map(|w| s(w)).collect()),
                ),
            ])),
        ),
    ]))
}
/// `readForm`.
pub fn read_form(value: Option<Value>) -> Read<Form> {
    let mut f = object(
        value.ok_or(INVALID_REQUEST)?,
        &[
            "componentASurfaceOffsetMm",
            "componentBSurfaceOffsetMm",
            "cycle",
            "displayColor",
            "gradient",
            "match",
            "mode",
            "name",
            "ratio",
        ],
        &[],
    )?;
    let mut ratio = object(
        take(&mut f, "ratio").ok_or(INVALID_REQUEST)?,
        &[
            "componentCount",
            "componentIds",
            "mixBPercent",
            "triangleWeights",
        ],
        &[],
    )?;
    let count = number(take(&mut ratio, "componentCount"))?;
    if count != 2.0 && count != 3.0 {
        return Err(INVALID_REQUEST);
    }
    let triangle: [Units; 3] = texts(take(&mut ratio, "triangleWeights"))?
        .try_into()
        .map_err(|_| INVALID_REQUEST)?;
    let mut cycle = object(
        take(&mut f, "cycle").ok_or(INVALID_REQUEST)?,
        &["manualPattern"],
        &[],
    )?;
    let mut matched = object(
        take(&mut f, "match").ok_or(INVALID_REQUEST)?,
        &["minComponentPercent", "targetColor"],
        &["selectedCandidateId"],
    )?;
    let mut gradient = object(
        take(&mut f, "gradient").ok_or(INVALID_REQUEST)?,
        &["componentIds", "direction", "localZMaxSublayers"],
        &[],
    )?;
    let gradient_ids: [Units; 2] = texts(take(&mut gradient, "componentIds"))?
        .try_into()
        .map_err(|_| INVALID_REQUEST)?;
    let name = text(take(&mut f, "name"))?;
    let display_color = text(take(&mut f, "displayColor"))?;
    let offset_a = text(take(&mut f, "componentASurfaceOffsetMm"))?;
    let offset_b = text(take(&mut f, "componentBSurfaceOffsetMm"))?;
    let mode = Mode::parse(&one_of(
        take(&mut f, "mode"),
        &["ratio", "cycle", "match", "gradient"],
    )?)
    .expect("a mode");
    Ok(Form {
        name,
        display_color,
        offset_a,
        offset_b,
        mode,
        ratio_count: count as u8,
        ratio_ids: texts(take(&mut ratio, "componentIds"))?,
        ratio_mix_b: text(take(&mut ratio, "mixBPercent"))?,
        ratio_triangle: triangle,
        cycle_pattern: text(take(&mut cycle, "manualPattern"))?,
        match_target: text(take(&mut matched, "targetColor"))?,
        match_minimum: text(take(&mut matched, "minComponentPercent"))?,
        match_selected: optional_text(&mut matched, "selectedCandidateId")?,
        gradient_ids,
        gradient_a_to_b: one_of(take(&mut gradient, "direction"), &["a-to-b", "b-to-a"])?
            == u("a-to-b"),
        gradient_sublayers: text(take(&mut gradient, "localZMaxSublayers"))?,
    })
}
fn read_search(value: Option<Value>) -> Read<Option<Search>> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => {
            let mut f = object(value, &["candidates", "status"], &["error"])?;
            let status = one_of(take(&mut f, "status"), &["pending", "ready", "error"])?;
            let candidates = list(take(&mut f, "candidates"))?
                .into_iter()
                .map(read_candidate)
                .collect::<Read<Vec<_>>>()?;
            let error = optional_text(&mut f, "error")?;
            Ok(Some(if status == u("pending") {
                Search::Pending
            } else if status == u("ready") {
                Search::Ready(candidates)
            } else {
                Search::Error(error)
            }))
        }
        None => Err(INVALID_REQUEST),
    }
}
fn issue_value(issue: &form::Issue) -> Value {
    let mut fields = record([("message", s(&issue.message))]);
    if let Some(end) = issue.end_offset {
        fields.insert(u("endOffset"), n(end as f64));
    }
    if let Some(field) = &issue.field {
        fields.insert(u("field"), s(field));
    }
    if let Some(start) = issue.start_offset {
        fields.insert(u("startOffset"), n(start as f64));
    }
    Value::Object(fields)
}

// --- Exchanges -----------------------------------------------------------------------------------

/// `{}` → the library `state` shows, or `{"error"}` when it cannot be shown.
pub fn library_json(state: &ProjectState, request: &str) -> Read<String> {
    object(read(request)?, &[], &[])?;
    Ok(match library(state) {
        Ok(library) => canonical(&library_value(&library)),
        Err(message) => refused(&message),
    })
}

/// `{"library","operation","filamentId"}` → the author dialog's opening fields.
pub fn defaults_json(request: &str) -> Read<String> {
    let mut f = object(read(request)?, &["filamentId", "library", "operation"], &[])?;
    let library = read_library(take(&mut f, "library"))?;
    let operation = match String::from_utf16_lossy(&one_of(
        take(&mut f, "operation"),
        &["add", "edit", "duplicate"],
    )?)
    .as_str()
    {
        "add" => Operation::Add,
        "edit" => Operation::Edit,
        _ => Operation::Duplicate,
    };
    let row = match (operation, take(&mut f, "filamentId")) {
        (Operation::Add, Some(Value::Null)) => None,
        (Operation::Add, _) => return Err(INVALID_REQUEST),
        (_, id) => {
            let id = text(id)?;
            Some(
                library
                    .rows
                    .iter()
                    .find(|row| row.id == id)
                    .ok_or(INVALID_REQUEST)?,
            )
        }
    };
    Ok(canonical(&form_value(&form::opening(
        &library, operation, row,
    ))))
}

/// `{"library","form","search"}` → the dialog's issues, preview, draft and mode views.
pub fn form_json(request: &str) -> Read<String> {
    let mut f = object(read(request)?, &["form", "library", "search"], &[])?;
    let library = read_library(take(&mut f, "library"))?;
    let form = read_form(take(&mut f, "form"))?;
    let search = read_search(take(&mut f, "search"))?;
    let validation = form::validate(&form, &library, search.as_ref());
    let mut reply = record([
        (
            "issues",
            Value::Array(validation.issues.iter().map(issue_value).collect()),
        ),
        ("preview", s(&validation.preview)),
    ]);
    if let Some(draft) = &validation.draft {
        reply.insert(u("draft"), draft_value(draft));
    }
    if let Some(ranking) = &validation.ranking {
        let mut fields = record([
            (
                "issues",
                Value::Array(ranking.issues.iter().map(issue_value).collect()),
            ),
            (
                "ranked",
                Value::Array(
                    ranking
                        .ranked
                        .iter()
                        .enumerate()
                        .map(|(index, view)| {
                            Value::Object(record([
                                ("candidateId", s(&view.candidate.id)),
                                ("deltaE2000", n(view.ranked.delta_e2000)),
                                ("detail", s(&form::candidate_detail(view, &library))),
                                ("previewColor", s(&view.ranked.preview_color)),
                                ("title", s(&form::candidate_title(index, &view.candidate))),
                            ]))
                        })
                        .collect(),
                ),
            ),
        ]);
        if let Some(target) = &ranking.normalized_target_color {
            fields.insert(u("normalizedTargetColor"), s(target));
        }
        reply.insert(u("ranking"), Value::Object(fields));
    }
    match form.mode {
        Mode::Ratio => {
            reply.insert(
                u("ratioPreview"),
                match form::ratio_preview(&form, &library) {
                    Some((color, text)) => {
                        Value::Object(record([("color", s(&color)), ("text", s(&text))]))
                    }
                    None => Value::Null,
                },
            );
            if form.ratio_count == 3 {
                let (x, y, weights, text) = form::triangle_marker(&form.ratio_triangle);
                reply.insert(
                    u("triangle"),
                    Value::Object(record([
                        ("valueText", s(&text)),
                        (
                            "weights",
                            Value::Array(weights.iter().map(|w| n(*w)).collect()),
                        ),
                        ("x", n(x)),
                        ("y", n(y)),
                    ])),
                );
            }
        }
        Mode::Gradient => {
            reply.insert(
                u("gradientPreview"),
                match form::gradient_preview(&form, &library) {
                    Some((top, bottom, text)) => Value::Object(record([
                        ("bottom", s(&bottom)),
                        ("text", s(&text)),
                        ("top", s(&top)),
                    ])),
                    None => Value::Null,
                },
            );
        }
        Mode::Match => {
            let target = form::match_target(&form.match_target);
            let minimum =
                form::strict_integer(&form.match_minimum).filter(|m| (0.0..=50.0).contains(m));
            reply.insert(
                u("matchSearch"),
                match (target, minimum) {
                    (Some(target), Some(minimum)) => Value::Object(record([
                        ("minComponentPercent", n(minimum)),
                        ("targetColor", s(&target)),
                    ])),
                    _ => Value::Null,
                },
            );
        }
        Mode::Cycle => {}
    }
    Ok(canonical(&Value::Object(reply)))
}

/// `{"x","y"}` → `{"weights"}` the triangle picker writes, or `{"error"}` off any finite point.
pub fn triangle_json(request: &str) -> Read<String> {
    let mut f = object(read(request)?, &["x", "y"], &[])?;
    let x = number(take(&mut f, "x"))?;
    let y = number(take(&mut f, "y"))?;
    Ok(match form::triangle_texts_at(x, y) {
        Some(weights) => canonical(&Value::Object(record([(
            "weights",
            Value::Array(weights.iter().map(|w| s(w)).collect()),
        )]))),
        None => refused(&u(
            "Ratio triangle requires exactly three finite barycentric weights",
        )),
    })
}

/// `{"library","targetColor","minComponentPercent"}` → `{"candidates"}` the pinned search proposes.
pub fn match_search_json(request: &str) -> Read<String> {
    let mut f = object(
        read(request)?,
        &["library", "minComponentPercent", "targetColor"],
        &[],
    )?;
    let library = read_library(take(&mut f, "library"))?;
    let target = text(take(&mut f, "targetColor"))?;
    let minimum = number(take(&mut f, "minComponentPercent"))?;
    let candidates = search_candidates(&library, &target, minimum);
    Ok(canonical(&Value::Object(record([(
        "candidates",
        Value::Array(candidates.iter().map(candidate_value).collect()),
    )]))))
}

/// The adapter's `searchMatchCandidates`: the search over the enabled, categorized heads
/// (the search's tool N is the Nth), its recipe and best pair as candidates.
pub fn search_candidates(library: &Library, target: &[u16], minimum: f64) -> Vec<Candidate> {
    let eligible: Vec<&Choice> = library
        .physical
        .iter()
        .filter(|choice| {
            choice.enabled
                && super::super::compatibility::material_category(&choice.material).is_some()
        })
        .collect();
    if eligible.len() < 2 {
        return Vec::new();
    }
    let palette: Vec<Entry> = eligible
        .iter()
        .map(|choice| Entry {
            color: super::super::text::six_digit(&choice.color)
                .unwrap_or_else(|| choice.color.clone()),
            filament_type: choice.material.clone(),
        })
        .collect();
    let result = match_search::search(&palette, target, minimum);
    let mut candidates: Vec<Candidate> = Vec::new();
    for recipe in [result.recipe, result.best_pair].into_iter().flatten() {
        let components: Vec<(Units, f64)> = recipe
            .components
            .iter()
            .map(|(tool, weight)| (eligible[*tool as usize - 1].id.clone(), *weight))
            .collect();
        let identity: Vec<Units> = components
            .iter()
            .map(|(id, weight)| cat(&[id, &u("@"), &super::super::text::num(*weight)]))
            .collect();
        let digest_input = cat(&[
            &u(recipe.kind),
            &u(":"),
            &identity.join(&u("+")[..]),
            &u(":"),
            &recipe.preview_color,
        ]);
        let digest = fnv1a64_hex(&String::from_utf16_lossy(&digest_input));
        let candidate = Candidate {
            id: u(&format!("pinned-match:{digest}")),
            label: Some(u(&format!("Pinned {} search", recipe.kind))),
            components,
            preview_color: super::super::text::six_digit(&recipe.preview_color)
                .unwrap_or(recipe.preview_color.clone()),
        };
        if !candidates.iter().any(|known| known.id == candidate.id) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// `fnv1a64` over UTF-8, as 16 hex digits.
fn fnv1a64_hex(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// `{"operation", ...}` on `state` → the step one library edit submits, or `{"error"}`.
pub fn mutation_json(state: &ProjectState, request: &str) -> Read<String> {
    let value = read(request)?;
    let Value::Object(probe) = &value else {
        return Err(INVALID_REQUEST);
    };
    let operation = one_of(
        probe.get(&u("operation")).cloned(),
        &["add", "edit", "duplicate", "set-enabled", "delete"],
    )?;
    let operation = String::from_utf16_lossy(&operation);
    let mutation = match operation.as_str() {
        "add" => {
            let mut f = object(value, &["draft", "newId", "operation"], &[])?;
            Mutation::Add {
                draft: read_draft(take(&mut f, "draft"))?,
                new_id: text(take(&mut f, "newId"))?,
            }
        }
        "edit" => {
            let mut f = object(value, &["draft", "filamentId", "operation"], &[])?;
            Mutation::Edit {
                draft: read_draft(take(&mut f, "draft"))?,
                filament_id: text(take(&mut f, "filamentId"))?,
            }
        }
        "duplicate" => {
            let mut f = object(
                value,
                &["draft", "newId", "operation", "sourceFilamentId"],
                &[],
            )?;
            Mutation::Duplicate {
                draft: read_draft(take(&mut f, "draft"))?,
                new_id: text(take(&mut f, "newId"))?,
                source_id: text(take(&mut f, "sourceFilamentId"))?,
            }
        }
        "set-enabled" => {
            let mut f = object(value, &["enabled", "filamentId", "operation"], &[])?;
            Mutation::SetEnabled {
                enabled: boolean(take(&mut f, "enabled"))?,
                filament_id: text(take(&mut f, "filamentId"))?,
            }
        }
        _ => {
            let mut f = object(value, &["filamentId", "operation"], &[])?;
            Mutation::Delete {
                filament_id: text(take(&mut f, "filamentId"))?,
            }
        }
    };
    let plan = match mutation::plan(state, &mutation) {
        Ok(plan) => plan,
        Err(message) => return Ok(refused(&message)),
    };
    let batch = wire::encode_batch(&plan.batch).map_err(|_| INVALID_REQUEST)?;
    let mut reply = record([
        ("batchJson", s(&u(&batch))),
        ("label", s(&plan.label)),
        ("operation", s(&u(plan.operation))),
        (
            "step",
            s(&u(if plan.intent { "intent" } else { "transaction" })),
        ),
    ]);
    if let Some(id) = &plan.filament_id {
        reply.insert(u("filamentId"), s(id));
    }
    if let Some((deletion, paths)) = &plan.deletion {
        reply.insert(
            u("dependencyPaths"),
            Value::Array(paths.iter().map(|path| s(path)).collect()),
        );
        reply.insert(
            u("outcome"),
            s(&u(match deletion {
                Deletion::Removed => "removed",
                Deletion::Tombstoned => "tombstoned",
            })),
        );
    }
    Ok(canonical(&Value::Object(reply)))
}
