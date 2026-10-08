//! Engine-option storage contracts and the settings value codec
//! (`web/src/settings/editor/codec.ts` and `configBridge.ts`). The table is
//! generated from the browser's pinned schema; the codec parses, validates and
//! serializes engine wire values with the browser's own checks, order and
//! messages. Defaults and GUI layout stay in the browser schema for now.
mod generated;
pub use generated::{DEFINITIONS, SCHEMA_SHA256, SCHEMA_VERSION, SOURCE_COMMIT};

use crate::{
    js_math::convert::{json_stringify, number, number_to_string, trim_utf16},
    model::ConfigMap,
};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionType {
    CoNone,
    CoFloat,
    CoFloats,
    CoInt,
    CoInts,
    CoString,
    CoStrings,
    CoPercent,
    CoPercents,
    CoFloatOrPercent,
    CoFloatsOrPercents,
    CoPoint,
    CoPoints,
    CoPoint3,
    CoBool,
    CoBools,
    CoEnum,
    CoEnums,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    None,
    Float,
    Int,
    String,
    FloatOrPercent,
    Point2,
    Point3,
    Bool,
    Enum,
}
impl ValueType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Float => "float",
            Self::Int => "int",
            Self::String => "string",
            Self::FloatOrPercent => "float-or-percent",
            Self::Point2 => "point2",
            Self::Point3 => "point3",
            Self::Bool => "bool",
            Self::Enum => "enum",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Scalar,
    Vector,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Percent {
    None,
    Percent,
    FloatOrPercent,
}

/// One engine `ConfigOptionDef` storage contract with its bounds and enum
/// domain. Several definitions may share a key (with different owners).
#[derive(Debug, PartialEq)]
pub struct Definition {
    pub id: &'static str,
    pub key: &'static str,
    pub owner: &'static str,
    pub option_type: OptionType,
    pub value_type: ValueType,
    pub shape: Shape,
    pub nullable: bool,
    pub percent: Percent,
    pub collection_delimiter: Option<&'static str>,
    pub component_delimiter: Option<&'static str>,
    pub nil_token: Option<&'static str>,
    pub percent_suffix: Option<&'static str>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub enum_values: &'static [&'static str],
    pub enum_labels: &'static [&'static str],
}

/// `EngineOptionCatalog.all(key)`: every definition of a key, in schema order.
pub fn definitions(key: &[u16]) -> impl Iterator<Item = &'static Definition> + '_ {
    DEFINITIONS
        .iter()
        .filter(move |d| d.key.encode_utf16().eq(key.iter().copied()))
}

/// `EngineOptionValue`.
#[derive(Debug, Clone, PartialEq)]
pub enum OptionValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(Vec<u16>),
    FloatOrPercent { percent: bool, value: f64 },
    List(Vec<OptionValue>),
}

impl OptionValue {
    /// The browser's JSON form of an `EngineOptionValue`.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(b) => Value::Bool(*b),
            Self::Number(n) => Value::Number(*n),
            Self::Text(t) => Value::String(t.clone()),
            Self::FloatOrPercent { percent, value } => Value::Object(BTreeMap::from([
                (units("percent"), Value::Bool(*percent)),
                (units("value"), Value::Number(*value)),
            ])),
            Self::List(items) => Value::Array(items.iter().map(Self::to_value).collect()),
        }
    }
}

/// `SettingsValidationIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: &'static str,
    pub path: String,
    pub message: Vec<u16>,
}
fn issue(code: &'static str, path: &str, message: impl AsRef<str>) -> Issue {
    Issue {
        code,
        path: path.to_owned(),
        message: message.as_ref().encode_utf16().collect(),
    }
}

/// `enumChoicesFor`: each serialized token with its label, or the token itself.
pub fn enum_choices(definition: &Definition) -> impl Iterator<Item = (&'static str, &'static str)> {
    let labels = definition.enum_labels;
    definition
        .enum_values
        .iter()
        .enumerate()
        .map(move |(i, value)| (*value, labels.get(i).copied().unwrap_or(value)))
}
fn is_enum_token(definition: &Definition, token: &[u16]) -> bool {
    definition
        .enum_values
        .iter()
        .any(|v| v.encode_utf16().eq(token.iter().copied()))
}

/// `codecContractIssue`: a storage contract this codec cannot honour.
pub fn contract_issue(d: &Definition) -> Option<&'static str> {
    use ValueType as V;
    if d.value_type == V::None || d.option_type == OptionType::CoNone {
        return Some("unsupported-none-value");
    }
    if d.nullable && d.nil_token != Some("nil") {
        return Some("nullable-without-nil-token");
    }
    let point = matches!(d.value_type, V::Point2 | V::Point3);
    if d.shape == Shape::Scalar {
        if d.collection_delimiter.is_some() {
            return Some("scalar-with-collection-delimiter");
        }
        if point {
            if d.component_delimiter != Some(",") {
                return Some("point-component-delimiter");
            }
        } else if d.component_delimiter.is_some() {
            return Some("scalar-with-component-delimiter");
        }
    } else if point {
        if d.collection_delimiter != Some(",") || d.component_delimiter != Some("x") {
            return Some("point-vector-delimiter");
        }
    } else {
        let string = d.value_type == V::String;
        if d.collection_delimiter != Some(if string { ";" } else { "," }) {
            return Some(if string {
                "string-vector-must-use-semicolon"
            } else {
                "numeric-vector-must-use-comma"
            });
        }
        if d.component_delimiter.is_some() {
            return Some("unexpected-component-delimiter");
        }
    }
    if d.percent == Percent::None && d.percent_suffix.is_some() {
        return Some("unexpected-percent-suffix");
    }
    if d.percent != Percent::None && d.percent_suffix != Some("%") {
        return Some("percent-without-percent-suffix");
    }
    if d.value_type == V::Enum && d.enum_values.is_empty() {
        return Some("enum-domain-missing");
    }
    None
}
fn contract_refusal(contract: &str) -> Vec<Issue> {
    vec![issue(
        // The code is the contract name itself.
        CONTRACTS
            .iter()
            .find(|c| **c == contract)
            .copied()
            .unwrap_or("contract"),
        "$",
        format!("Schema storage contract is unsupported: {contract}"),
    )]
}
const CONTRACTS: &[&str] = &[
    "unsupported-none-value",
    "nullable-without-nil-token",
    "scalar-with-collection-delimiter",
    "point-component-delimiter",
    "scalar-with-component-delimiter",
    "point-vector-delimiter",
    "string-vector-must-use-semicolon",
    "numeric-vector-must-use-comma",
    "unexpected-component-delimiter",
    "unexpected-percent-suffix",
    "percent-without-percent-suffix",
    "enum-domain-missing",
];

/// A parsed, validated draft with its canonical engine wire text.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub value: OptionValue,
    pub serialized: Vec<u16>,
}

/// `parseSettingDraft`: parse engine wire text, validate it and re-serialize.
pub fn parse_setting_draft(definition: &Definition, raw: &[u16]) -> Result<Parsed, Vec<Issue>> {
    if let Some(contract) = contract_issue(definition) {
        return Err(contract_refusal(contract));
    }
    let draft = |message: Vec<u16>| {
        vec![Issue {
            code: "invalid-draft",
            path: "$".into(),
            message,
        }]
    };
    let value = parse_value(definition, raw).map_err(draft)?;
    let issues = validate_setting_value(definition, &value);
    if !issues.is_empty() {
        return Err(issues);
    }
    // A thrown codec error joins its issue messages with "; ".
    let serialized =
        serialize_setting_value(definition, &value).map_err(|issues| draft(joined(&issues)))?;
    Ok(Parsed { value, serialized })
}
/// `SettingsCodecError.message`.
pub fn joined(issues: &[Issue]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, issue) in issues.iter().enumerate() {
        if i > 0 {
            out.extend("; ".encode_utf16());
        }
        out.extend_from_slice(&issue.message);
    }
    out
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn split<'a>(raw: &'a [u16], delimiter: &str) -> Vec<&'a [u16]> {
    // Every delimiter in the table is one ASCII character.
    let d = u16::from(delimiter.as_bytes()[0]);
    raw.split(|u| *u == d).collect()
}
fn parse_value(d: &Definition, raw: &[u16]) -> Result<OptionValue, Vec<u16>> {
    if d.shape == Shape::Scalar {
        return parse_atomic(d, raw, d.value_type);
    }
    if raw.is_empty() {
        return Ok(OptionValue::List(Vec::new()));
    }
    split(raw, d.collection_delimiter.expect("checked contract"))
        .into_iter()
        .map(|entry| parse_atomic(d, entry, d.value_type))
        .collect::<Result<_, _>>()
        .map(OptionValue::List)
}
fn ascii_eq_ignore_case(text: &[u16], word: &str) -> bool {
    // No non-ASCII code point lower-cases to these ASCII spellings.
    text.len() == word.len()
        && text
            .iter()
            .zip(word.bytes())
            .all(|(u, b)| *u < 0x80 && (*u as u8).eq_ignore_ascii_case(&b))
}
fn parse_atomic(
    d: &Definition,
    raw: &[u16],
    value_type: ValueType,
) -> Result<OptionValue, Vec<u16>> {
    if d.nullable
        && let Some(nil) = d.nil_token
        && trim_utf16(raw).iter().copied().eq(nil.encode_utf16())
    {
        return Ok(OptionValue::Null);
    }
    match value_type {
        ValueType::Bool => {
            let text = trim_utf16(raw);
            if ascii_eq_ignore_case(text, "1") || ascii_eq_ignore_case(text, "true") {
                Ok(OptionValue::Bool(true))
            } else if ascii_eq_ignore_case(text, "0") || ascii_eq_ignore_case(text, "false") {
                Ok(OptionValue::Bool(false))
            } else {
                Err(units("Boolean values must be 1, 0, true, or false"))
            }
        }
        ValueType::Int => parse_integer(raw).map(OptionValue::Number),
        ValueType::Float => parse_number(strip_required_percent(d, raw)).map(OptionValue::Number),
        ValueType::FloatOrPercent => {
            let trimmed = trim_utf16(raw);
            let percent = trimmed.last() == Some(&u16::from(b'%'));
            let body = if percent {
                &trimmed[..trimmed.len() - 1]
            } else {
                trimmed
            };
            Ok(OptionValue::FloatOrPercent {
                percent,
                value: parse_number(body)?,
            })
        }
        ValueType::String => Ok(OptionValue::Text(raw.to_vec())),
        ValueType::Enum => {
            let token = trim_utf16(raw);
            if !is_enum_token(d, token) {
                let mut message = units("Unknown enum token ");
                message.extend(json_stringify(&Value::String(token.to_vec())));
                return Err(message);
            }
            Ok(OptionValue::Text(token.to_vec()))
        }
        ValueType::Point2 => parse_point(raw, 2, d.component_delimiter.expect("checked contract")),
        ValueType::Point3 => parse_point(raw, 3, d.component_delimiter.expect("checked contract")),
        ValueType::None => Err(units("Options without a value shape cannot be edited")),
    }
}
fn strip_required_percent<'a>(d: &Definition, raw: &'a [u16]) -> &'a [u16] {
    let trimmed = trim_utf16(raw);
    if d.percent != Percent::Percent {
        return trimmed;
    }
    let suffix = units(d.percent_suffix.expect("checked contract"));
    trimmed.strip_suffix(suffix.as_slice()).unwrap_or(trimmed)
}
fn ascii_digits(text: &[u16]) -> usize {
    text.iter()
        .take_while(|u| (0x30..=0x39).contains(*u))
        .count()
}
/// `/^[+-]?\d+$/`, then `Number`; only safe integers survive.
fn parse_integer(raw: &[u16]) -> Result<f64, Vec<u16>> {
    let trimmed = trim_utf16(raw);
    let body = match trimmed.first() {
        Some(0x2b | 0x2d) => &trimmed[1..],
        _ => trimmed,
    };
    if body.is_empty() || ascii_digits(body) != body.len() {
        return Err(units("Expected an ASCII base-10 integer"));
    }
    let value = number(&String::from_utf16_lossy(trimmed));
    if !(value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0) {
        return Err(units("Integer is outside the safe range"));
    }
    Ok(value)
}
/// `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/`, then a finite `Number`.
fn parse_number(raw: &[u16]) -> Result<f64, Vec<u16>> {
    let trimmed = trim_utf16(raw);
    let mut rest = match trimmed.first() {
        Some(0x2b | 0x2d) => &trimmed[1..],
        _ => trimmed,
    };
    let whole = ascii_digits(rest);
    rest = &rest[whole..];
    let mut fraction = 0;
    let mut point = false;
    if rest.first() == Some(&0x2e) {
        point = true;
        fraction = ascii_digits(&rest[1..]);
        rest = &rest[1 + fraction..];
    }
    let mantissa = whole > 0 || (point && fraction > 0);
    if mantissa && matches!(rest.first(), Some(0x65 | 0x45)) {
        let mut exponent = &rest[1..];
        if matches!(exponent.first(), Some(0x2b | 0x2d)) {
            exponent = &exponent[1..];
        }
        let digits = ascii_digits(exponent);
        rest = if digits > 0 {
            &exponent[digits..]
        } else {
            rest
        };
    }
    if !mantissa || !rest.is_empty() {
        return Err(units("Expected an ASCII decimal number"));
    }
    let value = number(&String::from_utf16_lossy(trimmed));
    if !value.is_finite() {
        return Err(units("Number must be finite"));
    }
    Ok(value)
}
fn parse_point(raw: &[u16], dimensions: usize, delimiter: &str) -> Result<OptionValue, Vec<u16>> {
    let components = split(raw, delimiter);
    if components.len() != dimensions {
        return Err(units(&format!("Expected {dimensions} point components")));
    }
    components
        .into_iter()
        .map(|c| parse_number(c).map(OptionValue::Number))
        .collect::<Result<_, _>>()
        .map(OptionValue::List)
}

/// `validateSettingValue`.
pub fn validate_setting_value(d: &Definition, value: &OptionValue) -> Vec<Issue> {
    if let Some(contract) = contract_issue(d) {
        return contract_refusal(contract);
    }
    let mut issues = Vec::new();
    if d.shape == Shape::Vector {
        let OptionValue::List(entries) = value else {
            return vec![issue(
                "expected-vector",
                "$",
                format!("Expected a {} vector", d.value_type.as_str()),
            )];
        };
        for (i, entry) in entries.iter().enumerate() {
            validate_atomic(d, entry, &format!("$[{i}]"), d.value_type, &mut issues);
        }
    } else {
        validate_atomic(d, value, "$", d.value_type, &mut issues);
    }
    issues
}
fn safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}
fn validate_atomic(
    d: &Definition,
    value: &OptionValue,
    path: &str,
    value_type: ValueType,
    issues: &mut Vec<Issue>,
) {
    use OptionValue as O;
    if *value == O::Null {
        if !d.nullable {
            issues.push(issue("not-nullable", path, "This setting is not nullable"));
        }
        return;
    }
    match value_type {
        ValueType::Bool => {
            if !matches!(value, O::Bool(_)) {
                issues.push(issue("expected-bool", path, "Expected a boolean"));
            }
        }
        ValueType::Int => match value {
            O::Number(n) if safe_integer(*n) => bounds(d, *n, path, issues),
            _ => issues.push(issue("expected-int", path, "Expected a safe integer")),
        },
        ValueType::Float => match value {
            O::Number(n) if n.is_finite() => bounds(d, *n, path, issues),
            _ => issues.push(issue("expected-float", path, "Expected a finite number")),
        },
        ValueType::FloatOrPercent => match value {
            O::FloatOrPercent { value, .. } if value.is_finite() => bounds(d, *value, path, issues),
            _ => issues.push(issue(
                "expected-float-or-percent",
                path,
                "Expected an absolute or percent value",
            )),
        },
        ValueType::String => {
            if !matches!(value, O::Text(_)) {
                issues.push(issue("expected-string", path, "Expected text"));
            }
        }
        ValueType::Enum => {
            if !matches!(value, O::Text(t) if is_enum_token(d, t)) {
                issues.push(issue(
                    "invalid-enum",
                    path,
                    "Value is not in the generated enum domain",
                ));
            }
        }
        ValueType::Point2 => validate_point(d, value, 2, path, issues),
        ValueType::Point3 => validate_point(d, value, 3, path, issues),
        ValueType::None => issues.push(issue(
            "unsupported-none-value",
            path,
            "Options without a value shape cannot be edited",
        )),
    }
}
fn validate_point(
    d: &Definition,
    value: &OptionValue,
    dimensions: usize,
    path: &str,
    issues: &mut Vec<Issue>,
) {
    let components = match value {
        OptionValue::List(items)
            if items.len() == dimensions
                && items
                    .iter()
                    .all(|c| matches!(c, OptionValue::Number(n) if n.is_finite())) =>
        {
            items
        }
        _ => {
            issues.push(issue(
                "invalid-point",
                path,
                format!("Expected a {dimensions}-component finite point"),
            ));
            return;
        }
    };
    for (i, component) in components.iter().enumerate() {
        if let OptionValue::Number(n) = component {
            bounds(d, *n, &format!("{path}[{i}]"), issues);
        }
    }
}
fn bounds(d: &Definition, value: f64, path: &str, issues: &mut Vec<Issue>) {
    if let Some(minimum) = d.min
        && value < minimum
    {
        issues.push(issue(
            "below-minimum",
            path,
            format!("Value must be at least {}", number_to_string(minimum)),
        ));
    }
    if let Some(maximum) = d.max
        && value > maximum
    {
        issues.push(issue(
            "above-maximum",
            path,
            format!("Value must be at most {}", number_to_string(maximum)),
        ));
    }
}

/// `serializeSettingValue`: the engine wire text of a valid value. A refusal
/// carries the issues a thrown `SettingsCodecError` would.
pub fn serialize_setting_value(
    d: &Definition,
    value: &OptionValue,
) -> Result<Vec<u16>, Vec<Issue>> {
    let issues = validate_setting_value(d, value);
    if !issues.is_empty() {
        return Err(issues);
    }
    if d.shape == Shape::Vector {
        let OptionValue::List(entries) = value else {
            unreachable!("validated vector")
        };
        let delimiter = units(d.collection_delimiter.expect("checked contract"));
        let mut out = Vec::new();
        for (i, entry) in entries.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(&delimiter);
            }
            out.extend(serialize_atomic(d, entry)?);
        }
        return Ok(out);
    }
    serialize_atomic(d, value)
}
/// `numberText`: -0 prints as 0, everything else as `String(number)`.
fn number_text(value: f64) -> Vec<u16> {
    units(&number_to_string(if value == 0.0 { 0.0 } else { value }))
}
fn serialize_atomic(d: &Definition, value: &OptionValue) -> Result<Vec<u16>, Vec<Issue>> {
    use OptionValue as O;
    if *value == O::Null {
        return Ok(units(d.nil_token.expect("validated nullable")));
    }
    let suffix = || units(d.percent_suffix.unwrap_or(""));
    Ok(match (d.value_type, value) {
        (ValueType::Bool, O::Bool(b)) => units(if *b { "1" } else { "0" }),
        (ValueType::Int | ValueType::Float, O::Number(n)) => {
            let mut text = number_text(*n);
            if d.percent == Percent::Percent {
                text.extend(suffix());
            }
            text
        }
        (ValueType::FloatOrPercent, O::FloatOrPercent { percent, value }) => {
            let mut text = number_text(*value);
            if *percent {
                text.extend(suffix());
            }
            text
        }
        (ValueType::String | ValueType::Enum, O::Text(text)) => {
            if d.shape == Shape::Vector
                && let Some(delimiter) = d.collection_delimiter
                && text.contains(&u16::from(delimiter.as_bytes()[0]))
            {
                let mut message = units("A vector item cannot contain its ");
                message.extend(json_stringify(&Value::String(units(delimiter))));
                message.extend(units(" delimiter"));
                return Err(vec![Issue {
                    code: "unrepresentable-delimiter",
                    path: "$".into(),
                    message,
                }]);
            }
            text.clone()
        }
        (ValueType::Point2 | ValueType::Point3, O::List(components)) => {
            let delimiter = units(d.component_delimiter.expect("checked contract"));
            let mut out = Vec::new();
            for (i, c) in components.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(&delimiter);
                }
                if let O::Number(n) = c {
                    out.extend(number_text(*n));
                }
            }
            out
        }
        _ => {
            return Err(vec![issue(
                "unsupported-none-value",
                "$",
                "Options without a value shape cannot be serialized",
            )]);
        }
    })
}

/// `SettingsConfigDecodeDiagnostic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub key: Vec<u16>,
    pub code: &'static str,
    pub message: Vec<u16>,
}
/// `DecodedSettingsConfig`: the editable, generated subset of a configuration.
/// Unknown and undecodable values stay in the canonical map, read-only.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DecodedConfig {
    pub values: BTreeMap<Vec<u16>, OptionValue>,
    pub diagnostics: Vec<Diagnostic>,
    pub unknown_keys: Vec<Vec<u16>>,
}

/// `isEngineOptionValue` and its conversion: JSON scalars, arrays of values
/// and exact `{ percent, value }` objects.
pub fn option_value(value: &Value) -> Option<OptionValue> {
    Some(match value {
        Value::Null => OptionValue::Null,
        Value::Bool(b) => OptionValue::Bool(*b),
        Value::Number(n) => OptionValue::Number(*n),
        Value::String(text) => OptionValue::Text(text.clone()),
        Value::Array(items) => {
            OptionValue::List(items.iter().map(option_value).collect::<Option<_>>()?)
        }
        Value::Object(fields) => {
            let field = |name: &str| fields.get(&units(name));
            match (fields.len(), field("percent"), field("value")) {
                (2, Some(Value::Bool(percent)), Some(Value::Number(value)))
                    if value.is_finite() =>
                {
                    OptionValue::FloatOrPercent {
                        percent: *percent,
                        value: *value,
                    }
                }
                _ => return None,
            }
        }
    })
}

/// `decodeValue`: wire text parses as a draft; any other JSON value must be
/// an engine-option value that validates and serializes.
fn decode_value(d: &Definition, raw: &Value) -> Option<Parsed> {
    if let Value::String(text) = raw {
        return parse_setting_draft(d, text).ok();
    }
    let value = option_value(raw)?;
    if !validate_setting_value(d, &value).is_empty() {
        return None;
    }
    let serialized = serialize_setting_value(d, &value).ok()?;
    Some(Parsed { value, serialized })
}

/// `decodeSettingsConfig`, keys in canonical UTF-16 order.
pub fn decode_settings_config(config: &ConfigMap) -> DecodedConfig {
    let mut decoded = DecodedConfig::default();
    let Value::Object(fields) = config.value() else {
        return decoded;
    };
    // A canonical map already iterates its keys in UTF-16 order.
    for (key, raw) in fields {
        let candidates: Vec<&Definition> = definitions(key).collect();
        if candidates.is_empty() {
            decoded.unknown_keys.push(key.clone());
            continue;
        }
        let results: Vec<Parsed> = candidates
            .iter()
            .filter_map(|d| decode_value(d, raw))
            .collect();
        let message = |before: &str, after: &str| {
            let mut text = units(before);
            text.extend_from_slice(key);
            text.extend(units(after));
            text
        };
        let Some(first) = results.first() else {
            decoded.diagnostics.push(Diagnostic {
                key: key.clone(),
                code: "invalid-wire-value",
                message: message(
                    "The stored value for ",
                    " does not satisfy any generated definition and remains read-only.",
                ),
            });
            continue;
        };
        if results.iter().any(|r| !same(r, first)) {
            decoded.diagnostics.push(Diagnostic {
                key: key.clone(),
                code: "ambiguous-definition",
                message: message(
                    "The generated definitions for ",
                    " decode the stored value differently; it remains read-only.",
                ),
            });
            continue;
        }
        decoded.values.insert(key.clone(), first.value.clone());
    }
    decoded
}
/// The browser compares `JSON.stringify([value, serialized])`; JSON prints -0
/// as 0, which `==` on numbers already treats as equal.
fn same(left: &Parsed, right: &Parsed) -> bool {
    left.serialized == right.serialized && left.value == right.value
}

/// One change of a `SettingsDraftCommit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Set {
        key: Vec<u16>,
        serialized: Option<Vec<u16>>,
    },
    Remove {
        key: Vec<u16>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitError {
    EmptyKey,
    Repeated(Vec<u16>),
    Unserialized(Vec<u16>),
}
impl CommitError {
    /// The browser's error message.
    pub fn message(&self) -> Vec<u16> {
        let with = |before: &str, key: &[u16], after: &str| {
            let mut text = units(before);
            text.extend_from_slice(key);
            text.extend(units(after));
            text
        };
        match self {
            Self::EmptyKey => units("Settings commit contains an empty key"),
            Self::Repeated(key) => with("Settings commit changes ", key, " more than once"),
            Self::Unserialized(key) => with(
                "Settings commit has no serialized engine value for ",
                key,
                "",
            ),
        }
    }
}
/// `applySettingsCommitToConfig`: one validated commit on the raw override
/// map. Unknown and uneditable values survive; nothing is rebuilt from the
/// editor's typed subset.
pub fn apply_settings_commit(
    previous: &ConfigMap,
    changes: &[Change],
) -> Result<BTreeMap<Vec<u16>, Value>, CommitError> {
    let Value::Object(fields) = previous.value() else {
        unreachable!("configuration maps are objects")
    };
    let mut next = fields.clone();
    let mut seen = std::collections::BTreeSet::new();
    for change in changes {
        let key = match change {
            Change::Set { key, .. } | Change::Remove { key } => key,
        };
        if trim_utf16(key).is_empty() {
            return Err(CommitError::EmptyKey);
        }
        if !seen.insert(key.clone()) {
            return Err(CommitError::Repeated(key.clone()));
        }
        match change {
            Change::Remove { key } => {
                next.remove(key);
            }
            Change::Set { key, serialized } => {
                let Some(serialized) = serialized else {
                    return Err(CommitError::Unserialized(key.clone()));
                };
                next.insert(key.clone(), Value::String(serialized.clone()));
            }
        }
    }
    Ok(next)
}
