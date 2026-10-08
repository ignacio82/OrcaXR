//! `stepper.ts` and the row model of `scopedStepper.ts`: editing a setting
//! without a keyboard. An option without declared bounds is never stepped.
use super::{
    PRESENTATION, SearchFolding, Surface,
    draft::{DraftEditor, EditorError},
    fields::{Field, Query, Support, query_fields},
    units,
};
use crate::{
    js_math::{
        self,
        convert::{number, number_to_string, parse_float, to_fixed},
    },
    settings::{
        SettingScope,
        options::{
            Definition, Issue, OptionType, OptionValue, Shape, enum_choices, parse_setting_draft,
            serialize_setting_value,
        },
        presets::Collation,
    },
};

/// `StepRefusal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepRefusal {
    NotNumeric,
    Unbounded,
    Unreadable,
    ReadOnly,
}
impl StepRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotNumeric => "not-numeric",
            Self::Unbounded => "unbounded",
            Self::Unreadable => "unreadable",
            Self::ReadOnly => "read-only",
        }
    }
    /// `STEP_REFUSAL_REASON`.
    pub fn reason(self) -> &'static str {
        match self {
            Self::NotNumeric => {
                "This setting is not a bounded number, so it is edited in the settings panel."
            }
            Self::Unbounded => {
                "This setting has no declared limits, so stepping it could reach a value the engine refuses."
            }
            Self::Unreadable => "This setting\u{2019}s current value cannot be read as a number.",
            Self::ReadOnly => "This setting is read-only.",
        }
    }
}
/// A step: the next serialized value, a refusal, or the codec's refusal of
/// the clamped result (the browser throws `SettingsCodecError`).
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Value(Vec<u16>),
    Refused(StepRefusal),
    Codec(Vec<Issue>),
}

/// `Math.log10`, `Math.pow` and `Math.round` as V8 computes them.
fn log10(x: f64) -> f64 {
    libm::log10(x)
}
fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}
/// V8's `Math.round`: ties toward +Infinity, without `x + 0.5` rounding.
fn round(x: f64) -> f64 {
    let up = x.ceil();
    if up - 0.5 > x { up - 1.0 } else { up }
}

/// `stepFor`: a hundredth of the span, snapped to 1, 2 or 5 of a power of ten.
pub fn step_for(minimum: f64, maximum: f64) -> f64 {
    let span = (maximum - minimum).abs();
    if span.is_nan() || span <= 0.0 {
        return 0.0;
    }
    let rough = span / 100.0;
    let magnitude = pow(10.0, log10(rough).floor());
    let ratio = rough / magnitude;
    let snapped = magnitude
        * if ratio >= 5.0 {
            5.0
        } else if ratio >= 2.0 {
            2.0
        } else {
            1.0
        };
    if snapped > 0.0 { snapped } else { span }
}
fn decimals_of(step: f64) -> u32 {
    let text = number_to_string(step);
    text.find('.')
        .map_or(0, |dot| (text.len() - dot - 1) as u32)
}

/// `stepSettingValue`: booleans toggle, enums cycle, bounded scalar numbers
/// step and clamp; everything else refuses with a reason.
pub fn step_value(index: usize, current: &[u16], up: bool) -> Step {
    let d: &Definition = &super::super::options::DEFINITIONS[index];
    if PRESENTATION[index].readonly {
        return Step::Refused(StepRefusal::ReadOnly);
    }
    let direction = if up { 1.0 } else { -1.0 };
    let choices: Vec<&str> = enum_choices(d).map(|(serialized, _)| serialized).collect();
    if !choices.is_empty() {
        let from = choices
            .iter()
            .position(|c| units(c) == current)
            .unwrap_or(0) as isize;
        let n = choices.len() as isize;
        let next = (from + if up { 1 } else { -1 } + n) % n;
        return Step::Value(units(choices[next as usize]));
    }
    if d.option_type == OptionType::CoBool {
        let on = current == units("1").as_slice() || current == units("true").as_slice();
        return Step::Value(units(if on { "0" } else { "1" }));
    }
    if !matches!(
        d.option_type,
        OptionType::CoFloat | OptionType::CoInt | OptionType::CoPercent
    ) {
        return Step::Refused(StepRefusal::NotNumeric);
    }
    let (Some(minimum), Some(maximum)) = (d.min, d.max) else {
        return Step::Refused(StepRefusal::Unbounded);
    };
    let numeric = match parse_setting_draft(d, current) {
        Ok(parsed) => match parsed.value {
            OptionValue::Number(n) => n,
            _ => parse_float(&String::from_utf16_lossy(current)),
        },
        Err(_) => parse_float(&String::from_utf16_lossy(current)),
    };
    if !numeric.is_finite() {
        return Step::Refused(StepRefusal::Unreadable);
    }
    let step = step_for(minimum, maximum);
    if step.is_nan() || step <= 0.0 {
        return Step::Refused(StepRefusal::Unbounded);
    }
    let raw = numeric + direction * step;
    let rounded = number(&to_fixed(raw, decimals_of(step)));
    let integral = if d.option_type == OptionType::CoInt {
        round(rounded)
    } else {
        rounded
    };
    let next = js_math::min(maximum, js_math::max(minimum, integral));
    match serialize_setting_value(d, &OptionValue::Number(next)) {
        Ok(text) => Step::Value(text),
        Err(issues) => Step::Codec(issues),
    }
}

/// `guiSurfaceForScope`: a plate's options live on the plate dialog, every
/// model scope on the process tab.
pub fn surface_for_scope(scope: SettingScope) -> Surface {
    if scope == SettingScope::Plate {
        Surface::Plate
    } else {
        Surface::Process
    }
}

/// `ScopedStepperRowKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Numeric,
    Bool,
    Enum,
    Text,
    ReadOnly,
}
impl RowKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Numeric => "numeric",
            Self::Bool => "bool",
            Self::Enum => "enum",
            Self::Text => "text",
            Self::ReadOnly => "read-only",
        }
    }
}
/// `ScopedStepperRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub field: Field,
    pub group: Vec<u16>,
    pub value: Vec<u16>,
    pub overridden: bool,
    pub refusal: Option<StepRefusal>,
    pub kind: RowKind,
}
/// The rows a keyboard-free surface draws for one target, and how many
/// fields the schema cannot support at all.
#[derive(Debug, Clone, PartialEq)]
pub struct Rows {
    pub rows: Vec<Row>,
    pub unavailable: usize,
}

/// `ScopedSettingsStepper.build`: the DOM panel's query, unavailable fields
/// counted rather than drawn, steppability asked of the stepper itself.
pub fn stepper_rows<E, C, F>(
    editor: &DraftEditor,
    scope: SettingScope,
    collation: &mut C,
    folding: &mut F,
) -> Result<Rows, EditorError<E>>
where
    C: Collation<Error = E>,
    F: SearchFolding<Error = E>,
{
    let query = Query {
        surface: Some(surface_for_scope(scope)),
        scope: (scope != SettingScope::Project).then_some(scope),
        include_unavailable: true,
        include_unknown_applicability: true,
        ..Query::new(editor.mode, editor.technology)
    };
    let fields = query_fields(&query, collation, folding).map_err(EditorError::Collation)?;
    let mut rows = Vec::new();
    let mut unavailable = 0;
    for field in fields {
        if field.support != Support::Implemented {
            unavailable += 1;
            continue;
        }
        let d = field.definition();
        let state = editor.field_state(d.id)?;
        let value = state.serialized.clone().unwrap_or_default();
        let refusal = match step_value(field.index, &value, true) {
            Step::Refused(refusal) => Some(refusal),
            // The browser's serializer throws and the view fails.
            Step::Codec(issues) => return Err(EditorError::Codec(issues)),
            Step::Value(_) => None,
        };
        let numeric = matches!(
            d.option_type,
            OptionType::CoFloat
                | OptionType::CoInt
                | OptionType::CoPercent
                | OptionType::CoFloatOrPercent
        );
        let kind = if PRESENTATION[field.index].readonly {
            RowKind::ReadOnly
        } else if enum_choices(d).next().is_some() {
            RowKind::Enum
        } else if d.option_type == OptionType::CoBool {
            RowKind::Bool
        } else if numeric && d.shape == Shape::Scalar {
            RowKind::Numeric
        } else {
            RowKind::Text
        };
        rows.push(Row {
            group: field.group_label(),
            value,
            overridden: state.has_local_override,
            refusal,
            kind,
            field,
        });
    }
    Ok(Rows { rows, unavailable })
}
