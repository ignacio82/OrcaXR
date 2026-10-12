//! The height-range editor (`objects/layerRangeEditor.ts`): one object's
//! ranges in height order with the merge command's decision for the selected
//! range's neighbours, typed bounds and split heights checked before anything
//! is submitted, and what each operation says while it runs and once it is
//! done — canonical JSON requests and replies, in the browser's words
//! (`layerRangeEditorExchange.ts`).
//!
//! - `projection_json` `{"objectId","selectedLayerRangeId"}` (null for none)
//!   → `{"projection"}`: null for an object the project lacks, else
//!   `{"layerRanges","objectId","objectName","selectedLayerRange"?}`, each
//!   range `{"id","label","maxZMm","minZMm"}`;
//! - `bounds_json` `{"excludedId","ranges","rawMax","rawMin"}` →
//!   `{"maxZMm","minZMm","valid":true}` or `{"message","valid":false}`;
//! - `split_json` `{"maxZMm","minZMm","raw"}` → `{"splitZMm","valid":true}`
//!   or `{"message","valid":false}`;
//! - `messages_json` an operation → `{"pending","success"}`.
use crate::{
    commands::inspect_layer_range_merge,
    js_math::convert::{number, trim_utf16},
    model::ProjectState,
};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

pub use crate::placement::bed::{INPUT_LIMIT, INVALID_REQUEST};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn string(text: &str) -> Value {
    Value::String(units(text))
}
fn object<const N: usize>(members: [(&str, Option<Value>); N]) -> Value {
    Value::Object(
        members
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (units(k), v)))
            .collect(),
    )
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes).expect("canonical JSON is UTF-8")
}
fn read(request: &str, keys: &[&str]) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let Ok(Value::Object(fields)) = parse(request) else {
        return Err(INVALID_REQUEST);
    };
    members(fields, keys)
}
fn members(
    fields: BTreeMap<Vec<u16>, Value>,
    keys: &[&str],
) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str) -> Value {
    fields.remove(&units(key)).unwrap_or(Value::Null)
}
fn text(value: Value) -> Result<Vec<u16>, &'static str> {
    match value {
        Value::String(units) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn optional_text(value: Value) -> Result<Option<Vec<u16>>, &'static str> {
    match value {
        Value::Null => Ok(None),
        other => text(other).map(Some),
    }
}
fn finite(value: Value) -> Result<f64, &'static str> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(n),
        _ => Err(INVALID_REQUEST),
    }
}

/// A range as the editor lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct EditorRange {
    pub id: Vec<u16>,
    pub min_z_mm: f64,
    pub max_z_mm: f64,
}

/// `orderLayerRanges`: lower bound, then upper bound, then UTF-16 ID.
pub fn order(ranges: &mut [EditorRange]) {
    ranges.sort_by(|a, b| {
        a.min_z_mm
            .partial_cmp(&b.min_z_mm)
            .filter(|o| o.is_ne())
            .or_else(|| a.max_z_mm.partial_cmp(&b.max_z_mm).filter(|o| o.is_ne()))
            .unwrap_or_else(|| a.id.cmp(&b.id))
    });
}

/// `formatLayerRangeMm`: `Intl.NumberFormat('en-US', {maximumFractionDigits:
/// 4, useGrouping: false})` and " mm". ICU rounds the number's shortest
/// decimal spelling (JavaScript's own digits), not its exact binary value,
/// half away from zero; a negative value keeps its sign, -0 included.
pub fn format_mm(value: f64) -> String {
    format!("{} mm", intl_decimal(value, 4))
}
/// `Intl.NumberFormat('en-US', {maximumFractionDigits, useGrouping: false})`
/// for a finite number.
fn intl_decimal(value: f64, fraction: usize) -> String {
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if value == 0.0 {
        return format!("{sign}0");
    }
    // The shortest round-trip digits and the position of the decimal point.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("scientific notation");
    let mut digits: Vec<u8> = mantissa
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|d| d - b'0')
        .collect();
    let mut point = exponent.parse::<i64>().expect("exponent") + 1;
    let keep = point + fraction as i64;
    if keep < 0 {
        return format!("{sign}0");
    }
    let keep = keep as usize;
    if digits.len() > keep {
        let up = digits[keep] >= 5;
        digits.truncate(keep);
        if up {
            let mut i = digits.len();
            loop {
                if i == 0 {
                    digits.insert(0, 1);
                    point += 1;
                    break;
                }
                i -= 1;
                if digits[i] == 9 {
                    digits[i] = 0;
                } else {
                    digits[i] += 1;
                    break;
                }
            }
        }
    }
    while digits.last() == Some(&0) && (digits.len() as i64) > point.max(0) {
        digits.pop();
    }
    if digits.is_empty() {
        return format!("{sign}0");
    }
    let text = |d: &[u8]| d.iter().map(|d| char::from(b'0' + d)).collect::<String>();
    let out = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), text(&digits))
    } else if (point as usize) >= digits.len() {
        format!(
            "{}{}",
            text(&digits),
            "0".repeat(point as usize - digits.len())
        )
    } else {
        let (whole, part) = digits.split_at(point as usize);
        format!("{}.{}", text(whole), text(part))
    };
    format!("{sign}{out}")
}
/// `formatLayerRangeBounds`.
pub fn format_bounds(min_z_mm: f64, max_z_mm: f64) -> String {
    format!("{}\u{2013}{}", format_mm(min_z_mm), format_mm(max_z_mm))
}

/// `parseLayerRangeInput`: `Number` of the text; blank or non-finite is none.
pub fn parse_input(raw: &[u16]) -> Option<f64> {
    if trim_utf16(raw).is_empty() {
        return None;
    }
    let parsed = number(&String::from_utf16_lossy(raw));
    parsed.is_finite().then_some(parsed)
}

/// `validateLayerRangeBounds`.
pub fn validate_bounds(
    raw_min: &[u16],
    raw_max: &[u16],
    ranges: &[EditorRange],
    excluded: Option<&[u16]>,
) -> Result<(f64, f64), String> {
    let (Some(min), Some(max)) = (parse_input(raw_min), parse_input(raw_max)) else {
        return Err("Enter finite minimum and maximum Z values.".to_owned());
    };
    if min < 0.0 || max <= min {
        return Err("Bounds must satisfy 0 \u{2264} minimum Z < maximum Z.".to_owned());
    }
    if let Some(overlap) = ranges
        .iter()
        .find(|r| Some(r.id.as_slice()) != excluded && min < r.max_z_mm && r.min_z_mm < max)
    {
        return Err(format!(
            "{} overlaps existing {}.",
            format_bounds(min, max),
            format_bounds(overlap.min_z_mm, overlap.max_z_mm)
        ));
    }
    Ok((min, max))
}

/// `validateLayerRangeSplit`.
pub fn validate_split(raw: &[u16], min_z_mm: f64, max_z_mm: f64) -> Result<f64, String> {
    match parse_input(raw) {
        Some(at) if at > min_z_mm && at < max_z_mm => Ok(at),
        _ => Err(format!(
            "Split height must be strictly inside {}.",
            format_bounds(min_z_mm, max_z_mm)
        )),
    }
}

fn range_value(range: &EditorRange) -> Value {
    object([
        ("id", Some(Value::String(range.id.clone()))),
        (
            "label",
            Some(string(&format_bounds(range.min_z_mm, range.max_z_mm))),
        ),
        ("maxZMm", Some(Value::Number(range.max_z_mm))),
        ("minZMm", Some(Value::Number(range.min_z_mm))),
    ])
}

/// `layerRangeEditorProjection` as a reply.
pub fn projection_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let mut fields = read(request, &["objectId", "selectedLayerRangeId"])?;
    let object_id = text(take(&mut fields, "objectId"))?;
    let selected = optional_text(take(&mut fields, "selectedLayerRangeId"))?;
    let Some(found) = state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .find(|o| o.id.as_utf16() == object_id.as_slice())
    else {
        return Ok(canonical(&object([("projection", Some(Value::Null))])));
    };
    let mut ranges: Vec<EditorRange> = found
        .layer_ranges
        .iter()
        .map(|r| EditorRange {
            id: r.id.as_utf16().to_vec(),
            min_z_mm: r.min_z_mm.get(),
            max_z_mm: r.max_z_mm.get(),
        })
        .collect();
    order(&mut ranges);
    let selection = selected.as_ref().and_then(|id| {
        let index = ranges.iter().position(|r| &r.id == id)?;
        let decision = |other: Option<&EditorRange>, direction: &str| match other {
            None => object([
                ("allowed", Some(Value::Bool(false))),
                (
                    "reason",
                    Some(string(&format!("There is no {direction} height range."))),
                ),
            ]),
            Some(other) => match inspect_layer_range_merge(found, id, &other.id) {
                None => object([
                    ("allowed", Some(Value::Bool(true))),
                    ("otherRangeId", Some(Value::String(other.id.clone()))),
                ]),
                Some(reason) => object([
                    ("allowed", Some(Value::Bool(false))),
                    ("otherRangeId", Some(Value::String(other.id.clone()))),
                    ("reason", Some(Value::String(reason.units().to_vec()))),
                ]),
            },
        };
        Some(object([
            ("id", Some(Value::String(id.clone()))),
            ("mergeNext", Some(decision(ranges.get(index + 1), "next"))),
            (
                "mergePrevious",
                Some(decision(
                    index.checked_sub(1).and_then(|i| ranges.get(i)),
                    "previous",
                )),
            ),
        ]))
    });
    Ok(canonical(&object([(
        "projection",
        Some(object([
            (
                "layerRanges",
                Some(Value::Array(ranges.iter().map(range_value).collect())),
            ),
            (
                "objectId",
                Some(Value::String(found.id.as_utf16().to_vec())),
            ),
            (
                "objectName",
                Some(Value::String(found.name.units().to_vec())),
            ),
            ("selectedLayerRange", selection),
        ])),
    )])))
}

fn validity(result: Result<Vec<(&'static str, Value)>, String>) -> String {
    let mut fields: BTreeMap<Vec<u16>, Value> = BTreeMap::new();
    match result {
        Ok(values) => {
            fields.insert(units("valid"), Value::Bool(true));
            for (k, v) in values {
                fields.insert(units(k), v);
            }
        }
        Err(message) => {
            fields.insert(units("valid"), Value::Bool(false));
            fields.insert(units("message"), string(&message));
        }
    }
    canonical(&Value::Object(fields))
}

/// `validateLayerRangeBounds` as a reply.
pub fn bounds_json(request: &str) -> Result<String, &'static str> {
    let mut fields = read(request, &["excludedId", "ranges", "rawMax", "rawMin"])?;
    let excluded = optional_text(take(&mut fields, "excludedId"))?;
    let raw_max = text(take(&mut fields, "rawMax"))?;
    let raw_min = text(take(&mut fields, "rawMin"))?;
    let Value::Array(entries) = take(&mut fields, "ranges") else {
        return Err(INVALID_REQUEST);
    };
    let ranges = entries
        .into_iter()
        .map(|entry| {
            let Value::Object(entry) = entry else {
                return Err(INVALID_REQUEST);
            };
            let mut entry = members(entry, &["id", "maxZMm", "minZMm"])?;
            Ok(EditorRange {
                id: text(take(&mut entry, "id"))?,
                max_z_mm: finite(take(&mut entry, "maxZMm"))?,
                min_z_mm: finite(take(&mut entry, "minZMm"))?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    Ok(validity(
        validate_bounds(&raw_min, &raw_max, &ranges, excluded.as_deref()).map(|(min, max)| {
            vec![
                ("maxZMm", Value::Number(max)),
                ("minZMm", Value::Number(min)),
            ]
        }),
    ))
}

/// `validateLayerRangeSplit` as a reply.
pub fn split_json(request: &str) -> Result<String, &'static str> {
    let mut fields = read(request, &["maxZMm", "minZMm", "raw"])?;
    let max = finite(take(&mut fields, "maxZMm"))?;
    let min = finite(take(&mut fields, "minZMm"))?;
    let raw = text(take(&mut fields, "raw"))?;
    Ok(validity(
        validate_split(&raw, min, max).map(|at| vec![("splitZMm", Value::Number(at))]),
    ))
}

/// `layerRangeOperationMessages` as a reply.
pub fn messages_json(request: &str) -> Result<String, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let Ok(Value::Object(peek)) = parse(request) else {
        return Err(INVALID_REQUEST);
    };
    let kind = match peek.get(&units("kind")) {
        Some(Value::String(kind)) => String::from_utf16_lossy(kind),
        _ => return Err(INVALID_REQUEST),
    };
    let (pending, success) = match kind.as_str() {
        "add" => {
            let mut f = members(peek, &["kind", "maxZMm", "minZMm"])?;
            let bounds = format_bounds(
                finite(take(&mut f, "minZMm"))?,
                finite(take(&mut f, "maxZMm"))?,
            );
            (
                format!("Adding {bounds}\u{2026}"),
                format!("Added {bounds}."),
            )
        }
        "edit" => {
            let mut f = members(
                peek,
                &["fromMaxZMm", "fromMinZMm", "kind", "maxZMm", "minZMm"],
            )?;
            let from = format_bounds(
                finite(take(&mut f, "fromMinZMm"))?,
                finite(take(&mut f, "fromMaxZMm"))?,
            );
            let to = format_bounds(
                finite(take(&mut f, "minZMm"))?,
                finite(take(&mut f, "maxZMm"))?,
            );
            (
                format!("Editing {from}\u{2026}"),
                format!("Updated range boundaries to {to}."),
            )
        }
        "split" => {
            let mut f = members(peek, &["kind", "splitZMm"])?;
            let at = format_mm(finite(take(&mut f, "splitZMm"))?);
            (
                format!("Splitting range at {at}\u{2026}"),
                format!("Split range at {at}."),
            )
        }
        "merge" => {
            let mut f = members(peek, &["direction", "kind"])?;
            let direction = String::from_utf16(&text(take(&mut f, "direction"))?)
                .map_err(|_| INVALID_REQUEST)?;
            if direction != "previous" && direction != "next" {
                return Err(INVALID_REQUEST);
            }
            (
                format!("Merging with the {direction} range\u{2026}"),
                format!("Merged with the {direction} range."),
            )
        }
        "delete" => {
            members(peek, &["kind"])?;
            (
                "Deleting selected range\u{2026}".to_owned(),
                "Deleted selected range.".to_owned(),
            )
        }
        _ => return Err(INVALID_REQUEST),
    };
    Ok(canonical(&object([
        ("pending", Some(string(&pending))),
        ("success", Some(string(&success))),
    ])))
}
