//! Foreign BBS metadata members, read exactly as the production browser does.
//!
//! These members are small and fully buffered. Each reader keeps the browser's
//! expression semantics, JavaScript number/string conversions and UTF-16 text,
//! so unusual but accepted files import identically on both hosts. Callers
//! enforce member byte limits before decoding text.
use super::js::{self, is_space};
use super::scan::{self, ScanError, attributes, decode_xml, get};
use super::{Failure, Warning, WarningCode};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;

pub type Config = BTreeMap<Vec<u16>, Value>;
pub const MODEL_SETTINGS_PATH: &str = "Metadata/model_settings.config";
pub const PROJECT_SETTINGS_PATH: &str = "Metadata/project_settings.config";
pub const LAYER_RANGES_PATH: &str = "Metadata/layer_config_ranges.xml";
pub const LAYER_EVENTS_PATH: &str = "Metadata/custom_gcode_per_layer.xml";
pub const BRIM_EAR_POINTS_PATH: &str = "Metadata/brim_ear_points.txt";
pub const LAYER_HEIGHTS_PROFILE_PATH: &str = "Metadata/layer_heights_profile.txt";
const BBS_PLATE_GAP_RATIO: f64 = 0.2;

/// JavaScript `Map` key for a number: SameValueZero, so `-0` equals `0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NumKey(u64);
impl NumKey {
    pub fn new(n: f64) -> Self {
        Self(if n == 0.0 { 0 } else { n.to_bits() })
    }
    pub fn get(self) -> f64 {
        f64::from_bits(self.0)
    }
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn is_key(key: &[u16], name: &str) -> bool {
    key.iter().copied().eq(name.encode_utf16())
}
impl From<ScanError> for Failure {
    fn from(_: ScanError) -> Self {
        Failure::Metadata
    }
}

/// `[...text.matchAll(/<tag\b/gi)].length`.
pub fn count_tags(text: &str, tag: &str) -> usize {
    scan::count_tags(text, tag)
}
/// `TextDecoder('utf-8', { fatal: true })`, which removes one leading BOM.
pub fn decode_text(bytes: &[u8]) -> Result<&str, Failure> {
    let text = std::str::from_utf8(bytes).map_err(|_| Failure::Utf8)?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text))
}

/// `parseScalar`.
pub fn parse_scalar(value: &[u16]) -> Value {
    if is_key(value, "true") {
        return Value::Bool(true);
    }
    if is_key(value, "false") {
        return Value::Bool(false);
    }
    if let Ok(text) = String::from_utf16(value)
        && numeric_literal(&text)
    {
        let n = js::number(&text);
        if n.is_finite() {
            return Value::Number(n);
        }
    }
    Value::String(value.to_vec())
}
/// `/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i`.
fn numeric_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        let n = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return false;
        }
        i += 1 + n;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let n = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return false;
        }
        i += n;
    }
    i == b.len()
}
/// `assignConfigValue`: prototype-shaped keys throw.
pub fn assign(config: &mut Config, key: Vec<u16>, value: Value) -> Result<(), Failure> {
    if is_key(&key, "__proto__") || is_key(&key, "prototype") || is_key(&key, "constructor") {
        return Err(Failure::UnsafeKey);
    }
    config.insert(key, value);
    Ok(())
}
/// `parseMetadataConfig`: every `<metadata key=… value=…>` opening tag. The
/// value is decoded twice, once by `parseAttributes` and again explicitly.
pub fn metadata_config(xml: &str) -> Result<Config, Failure> {
    let mut config = Config::new();
    for source in scan::open_tags(xml, "metadata") {
        let attrs = attributes(source)?;
        if let Some(key) = get(&attrs, "key").filter(|k| !k.is_empty()) {
            let value = decode_xml(get(&attrs, "value").unwrap_or(&[]))?;
            assign(&mut config, key.to_vec(), parse_scalar(&value))?;
        }
    }
    Ok(config)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Model,
    ParameterModifier,
    NegativeVolume,
    SupportEnforcer,
    SupportBlocker,
}
impl Role {
    pub fn from_subtype(value: Option<&[u16]>) -> Self {
        let Some(value) = value else {
            return Self::Model;
        };
        if is_key(value, "modifier") || is_key(value, "modifier_part") {
            Self::ParameterModifier
        } else if is_key(value, "negative_volume") || is_key(value, "negative_part") {
            Self::NegativeVolume
        } else if is_key(value, "support_enforcer") {
            Self::SupportEnforcer
        } else if is_key(value, "support_blocker") {
            Self::SupportBlocker
        } else {
            Self::Model
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::ParameterModifier => "parameter-modifier",
            Self::NegativeVolume => "negative-volume",
            Self::SupportEnforcer => "support-enforcer",
            Self::SupportBlocker => "support-blocker",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SvgReference {
    pub path_in_3mf: String,
    pub source_path: Option<String>,
    pub depth_mm: f64,
    pub use_surface: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PartData {
    pub role: Role,
    pub name: Option<Vec<u16>>,
    pub config: Config,
    /// Canonical `EmbossTextConfiguration` JSON.
    pub emboss_text: Option<Value>,
    pub emboss_svg: Option<SvgReference>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Range {
    pub min_z_mm: f64,
    pub max_z_mm: f64,
    pub config: Config,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PlateMeta {
    pub source_id: f64,
    pub source_id_valid: bool,
    pub name: Vec<u16>,
    pub printable: bool,
    pub config: Config,
    pub assignments: Vec<(NumKey, NumKey)>,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelSettings {
    pub object_config: BTreeMap<NumKey, Config>,
    pub object_names: BTreeMap<NumKey, Vec<u16>>,
    pub part_data: BTreeMap<NumKey, BTreeMap<NumKey, PartData>>,
    pub layer_ranges: BTreeMap<NumKey, Vec<Range>>,
    pub plates: Vec<PlateMeta>,
}

/// `parseModelSettings`. Emboss warnings are appended in document order.
pub fn model_settings(
    bytes: Option<&[u8]>,
    warnings: &mut Vec<Warning>,
) -> Result<ModelSettings, Failure> {
    let mut result = ModelSettings::default();
    let Some(bytes) = bytes else {
        return Ok(result);
    };
    let xml = decode_text(bytes)?;
    for (object_attrs, body) in scan::elements(xml, "object") {
        let attrs = attributes(object_attrs)?;
        let id = js::utf16_number(get(&attrs, "id").unwrap_or(&[]));
        let id = if get(&attrs, "id").is_some() {
            id
        } else {
            f64::NAN
        };
        if !js::is_integer(id) {
            continue;
        }
        let key = NumKey::new(id);
        if result.object_config.contains_key(&key)
            || result.object_names.contains_key(&key)
            || result.part_data.contains_key(&key)
            || result.layer_ranges.contains_key(&key)
        {
            return Err(Failure::DuplicateMetadataObject);
        }
        let prefix = match find_tag(body, "part") {
            Some(at) => &body[..at],
            None => body,
        };
        let mut config = metadata_config(prefix)?;
        let name_key = utf16("name");
        if let Some(Value::String(name)) = config.get(&name_key) {
            result.object_names.insert(key, name.clone());
            config.remove(&name_key);
        }
        result.object_config.insert(key, config);
        let mut parts = BTreeMap::new();
        for (part_attrs, part_body) in scan::elements(body, "part") {
            let part_attrs = attributes(part_attrs)?;
            let part_id = match get(&part_attrs, "id") {
                Some(id) => js::utf16_number(id),
                None => f64::NAN,
            };
            if !js::is_integer(part_id) {
                continue;
            }
            let part_key = NumKey::new(part_id);
            if parts.contains_key(&part_key) {
                return Err(Failure::DuplicateMetadataPart);
            }
            let mut part_config = metadata_config(part_body)?;
            let name = match part_config.get(&name_key) {
                Some(Value::String(name)) => Some(name.clone()),
                _ => None,
            };
            part_config.remove(&name_key);
            part_config.remove(&utf16("matrix"));
            let (emboss_text, emboss_svg) = part_emboss(part_body, id, part_id, warnings)?;
            parts.insert(
                part_key,
                PartData {
                    role: Role::from_subtype(get(&part_attrs, "subtype")),
                    name,
                    config: part_config,
                    emboss_text,
                    emboss_svg,
                },
            );
        }
        if !parts.is_empty() {
            result.part_data.insert(key, parts);
        }
        let mut ranges = Vec::new();
        for (range_attrs, range_body) in scan::elements(body, "layer_range") {
            let range_attrs = attributes(range_attrs)?;
            ranges.push(Range {
                min_z_mm: attribute_number(&range_attrs, "min_z"),
                max_z_mm: attribute_number(&range_attrs, "max_z"),
                config: metadata_config(range_body)?,
            });
        }
        if !ranges.is_empty() {
            result.layer_ranges.insert(key, ranges);
        }
    }
    for (plate_attrs, body) in scan::elements(xml, "plate") {
        let attrs = attributes(plate_attrs)?;
        let config_xml = without_model_instances(body);
        let config = metadata_config(&config_xml)?;
        let attribute_id = get(&attrs, "id").map(js::utf16_number);
        let config_id = config
            .get(&utf16("plater_id"))
            .map(|v| js::value_to_number(Some(v)));
        let source_id = attribute_id
            .or(config_id)
            .unwrap_or((result.plates.len() + 1) as f64);
        let source_id_valid = js::is_integer(source_id)
            && source_id >= 1.0
            && match (attribute_id, config_id) {
                (Some(a), Some(c)) => a == c,
                _ => true,
            };
        let mut assignments = Vec::new();
        for (instance_attrs, nested) in scan::lazy_elements(body, "model_instance") {
            let direct = attributes(instance_attrs)?;
            let nested = metadata_config(nested.unwrap_or(""))?;
            let object_id = match get(&direct, "object_id") {
                Some(v) => js::utf16_number(v),
                None => js::value_to_number(nested.get(&utf16("object_id"))),
            };
            let instance_index = match get(&direct, "instance_id") {
                Some(v) => js::utf16_number(v),
                None => match nested.get(&utf16("instance_id")) {
                    Some(v) => js::value_to_number(Some(v)),
                    None => 0.0,
                },
            };
            if js::is_integer(object_id) && js::is_integer(instance_index) {
                assignments.push((NumKey::new(object_id), NumKey::new(instance_index)));
            }
        }
        let name = match get(&attrs, "name") {
            Some(name) => name.to_vec(),
            None => match config.get(&utf16("plater_name")) {
                Some(v) if !matches!(v, Value::Null) => js::value_to_string(v),
                _ => utf16(&format!("Plate {}", result.plates.len() + 1)),
            },
        };
        let printable = match get(&attrs, "printable") {
            Some(v) => v.to_vec(),
            None => match config.get(&utf16("printable")) {
                Some(v) if !matches!(v, Value::Null) => js::value_to_string(v),
                _ => utf16("1"),
            },
        };
        let mut plate_config = config.clone();
        for key in ["plater_id", "plater_name", "printable"] {
            plate_config.remove(&utf16(key));
        }
        if let Some(locked) = get(&attrs, "locked") {
            plate_config.insert(utf16("locked"), parse_scalar(locked));
        }
        result.plates.push(PlateMeta {
            source_id,
            source_id_valid,
            name,
            printable: !is_key(&printable, "0"),
            config: plate_config,
            assignments,
        });
    }
    Ok(result)
}
/// `Number(attrs.name)` where a missing attribute is `undefined`.
fn attribute_number(attrs: &[(String, Vec<u16>)], name: &str) -> f64 {
    get(attrs, name).map_or(f64::NAN, js::utf16_number)
}
/// First `/<tag\b/i` position.
fn find_tag(text: &str, tag: &str) -> Option<usize> {
    let b = text.as_bytes();
    (0..b.len()).find(|&i| {
        b[i] == b'<'
            && b.len() >= i + 1 + tag.len()
            && b[i + 1..i + 1 + tag.len()].eq_ignore_ascii_case(tag.as_bytes())
            && !text[i + 1 + tag.len()..]
                .chars()
                .next()
                .is_some_and(js::is_word)
    })
}
/// `body.replace(/<model_instance\b[^>]*\/>|<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/gi, '')`.
fn without_model_instances(body: &str) -> String {
    let close = "</model_instance>";
    let b = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        let Some(n) = b[i..].iter().position(|c| *c == b'<') else {
            break;
        };
        let lt = i + n;
        let tag = "model_instance";
        let matches_tag = b.len() >= lt + 1 + tag.len()
            && b[lt + 1..lt + 1 + tag.len()].eq_ignore_ascii_case(tag.as_bytes())
            && !body[lt + 1 + tag.len()..]
                .chars()
                .next()
                .is_some_and(js::is_word);
        if matches_tag {
            let after = lt + 1 + tag.len();
            if let Some(g) = b[after..].iter().position(|c| *c == b'>') {
                let gt = after + g;
                let end = if gt > after && b[gt - 1] == b'/' {
                    Some(gt + 1)
                } else {
                    find_ci(b, gt + 1, close.as_bytes()).map(|e| e + close.len())
                };
                if let Some(end) = end {
                    out.push_str(&body[copied..lt]);
                    copied = end;
                    i = end;
                    continue;
                }
            }
        }
        i = lt + 1;
    }
    out.push_str(&body[copied..]);
    out
}
fn find_ci(text: &[u8], from: usize, literal: &[u8]) -> Option<usize> {
    (from..=text.len().checked_sub(literal.len())?)
        .find(|&i| text[i..i + literal.len()].eq_ignore_ascii_case(literal))
}

// ---- emboss (`readPartEmbossText`, `decodeEmbossTextConfiguration`) ----

const TEXT_TAG: &str = "slic3rpe:text";
const SHAPE_TAG: &str = "slic3rpe:shape";
/// `new RegExp('<tag\\b[^>]*/?>', 'i').exec(body)[0]`.
fn first_open_tag<'a>(body: &'a str, tag: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(n) = body[from..].find('<') {
        let lt = from + n;
        let b = body.as_bytes();
        if b.len() >= lt + 1 + tag.len()
            && b[lt + 1..lt + 1 + tag.len()].eq_ignore_ascii_case(tag.as_bytes())
            && !body[lt + 1 + tag.len()..]
                .chars()
                .next()
                .is_some_and(js::is_word)
        {
            let gt = body[lt..].find('>').map(|g| lt + g)?;
            return Some(&body[lt..=gt]);
        }
        from = lt + 1;
    }
    None
}
/// `new RegExp('\\b' + name + '="([^"]*)"').exec(xml)?.[1]` (case-sensitive).
fn raw_attribute<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(n) = xml[from..].find(&needle) {
        let at = from + n;
        let boundary = !xml[..at].chars().next_back().is_some_and(js::is_word);
        if boundary {
            let start = at + needle.len();
            if let Some(end) = xml[start..].find('"') {
                return Some(&xml[start..start + end]);
            }
            return None;
        }
        from = at + 1;
    }
    None
}
fn unescape(value: &str) -> String {
    value
        .replace("&#10;", "\n")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}
fn emboss_attribute(xml: &str, name: &str) -> Option<String> {
    raw_attribute(xml, name).map(unescape)
}
fn emboss_number(xml: &str, name: &str) -> Option<f64> {
    let raw = emboss_attribute(xml, name)?;
    if js::trim(&raw).is_empty() {
        return None;
    }
    Some(js::number(&raw)).filter(|n| n.is_finite())
}
fn shape_number(xml: &str, name: &str) -> Option<f64> {
    Some(js::number(raw_attribute(xml, name)?)).filter(|n| n.is_finite())
}
fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (utf16(k), v)).collect())
}
fn string(s: &str) -> Value {
    Value::String(utf16(s))
}

type Emboss = (Option<Value>, Option<SvgReference>);
fn part_emboss(
    body: &str,
    object_id: f64,
    part_id: f64,
    warnings: &mut Vec<Warning>,
) -> Result<Emboss, Failure> {
    let shape = first_open_tag(body, SHAPE_TAG);
    let text = first_open_tag(body, TEXT_TAG);
    let prefix = format!(
        "{MODEL_SETTINGS_PATH} object {} part {}: ",
        js::number_to_string(object_id),
        js::number_to_string(part_id)
    );
    let mut warn = |message: String| {
        warnings.push(Warning::new(
            WarningCode::Emboss,
            &format!("{prefix}{message}"),
        ));
    };
    if let Some(text_xml) = text {
        return Ok((emboss_text(text_xml, shape, &mut warn), None));
    }
    let Some(shape) = shape else {
        return Ok((None, None));
    };
    let Some(path_in_3mf) = emboss_attribute(shape, "filepath3mf").filter(|p| !p.is_empty()) else {
        return Ok((None, None));
    };
    let source_path = emboss_attribute(shape, "filepath").filter(|p| !p.is_empty());
    let depth = shape_number(shape, "depth");
    if depth.is_none_or(|d| d <= 0.0) {
        warn(format!(
            "{SHAPE_TAG} has no usable depth; used the pinned default of 1 mm"
        ));
    }
    Ok((
        None,
        Some(SvgReference {
            path_in_3mf,
            source_path,
            depth_mm: depth.filter(|d| *d > 0.0).unwrap_or(1.0),
            use_surface: shape.contains("use_surface=\"1\"")
                && word_boundary_before(shape, "use_surface=\"1\""),
        }),
    ))
}
/// `/\bneedle/` where the needle starts with a word character.
fn word_boundary_before(text: &str, needle: &str) -> bool {
    text.match_indices(needle)
        .any(|(at, _)| !text[..at].chars().next_back().is_some_and(js::is_word))
}
fn emboss_text(
    text_xml: &str,
    shape: Option<&str>,
    warn: &mut impl FnMut(String),
) -> Option<Value> {
    let Some(text) = emboss_attribute(text_xml, "text") else {
        warn(format!(
            "{TEXT_TAG} has no text attribute; the volume is not editable text"
        ));
        return None;
    };
    let Some(line_height) = emboss_number(text_xml, "line_height").filter(|h| *h > 0.0) else {
        warn(format!(
            "{TEXT_TAG} has no usable line_height; the volume is not editable text"
        ));
        return None;
    };
    let horizontal_raw =
        emboss_attribute(text_xml, "horizontal").unwrap_or_else(|| "center".into());
    let horizontal = if matches!(horizontal_raw.as_str(), "left" | "center" | "right") {
        horizontal_raw.clone()
    } else {
        "center".into()
    };
    if horizontal != horizontal_raw {
        warn(format!(
            "Unknown horizontal alignment {horizontal_raw}; used {horizontal}"
        ));
    }
    let vertical_raw = emboss_attribute(text_xml, "vertical").unwrap_or_else(|| "middle".into());
    let vertical = match vertical_raw.as_str() {
        "top" => Some("top"),
        "middle" => Some("center"),
        "bottom" => Some("bottom"),
        _ => None,
    };
    if vertical.is_none() {
        warn(format!(
            "Unknown vertical alignment {vertical_raw}; used center"
        ));
    }
    let depth = shape.and_then(|s| emboss_number(s, "depth"));
    if shape.is_some() && depth.is_none_or(|d| d <= 0.0) {
        warn(format!(
            "{SHAPE_TAG} has no usable depth; used the pinned default of 1 mm"
        ));
    }
    let collection = emboss_number(text_xml, "collection").unwrap_or(0.0).trunc();
    let mut fields = vec![
        ("text", string(&text)),
        (
            "styleName",
            string(&emboss_attribute(text_xml, "style_name").unwrap_or_default()),
        ),
        (
            "fontDescriptor",
            string(&emboss_attribute(text_xml, "font_descriptor").unwrap_or_default()),
        ),
        (
            "fontDescriptorType",
            string(
                &emboss_attribute(text_xml, "font_descriptor_type")
                    .unwrap_or_else(|| "undefined".into()),
            ),
        ),
        (
            "font",
            obj(vec![
                (
                    "charGapMm",
                    Value::Number(emboss_number(text_xml, "char_gap").unwrap_or(0.0)),
                ),
                (
                    "lineGapMm",
                    Value::Number(emboss_number(text_xml, "line_gap").unwrap_or(0.0)),
                ),
                ("lineHeightMm", Value::Number(line_height)),
                (
                    "boldnessMm",
                    Value::Number(emboss_number(text_xml, "boldness").unwrap_or(0.0)),
                ),
                (
                    "skew",
                    Value::Number(emboss_number(text_xml, "skew").unwrap_or(0.0)),
                ),
                (
                    "perGlyph",
                    Value::Bool(emboss_attribute(text_xml, "per_glyph").as_deref() == Some("1")),
                ),
                ("horizontal", string(&horizontal)),
                ("vertical", string(vertical.unwrap_or("center"))),
                (
                    "collection",
                    Value::Number(if collection > 0.0 { collection } else { 0.0 }),
                ),
            ]),
        ),
        (
            "projection",
            obj(vec![
                (
                    "depthMm",
                    Value::Number(depth.filter(|d| *d > 0.0).unwrap_or(1.0)),
                ),
                (
                    "useSurface",
                    Value::Bool(shape.is_some_and(|s| {
                        emboss_attribute(s, "use_surface").as_deref() == Some("1")
                    })),
                ),
            ]),
        ),
    ];
    for (key, attribute) in [
        ("family", "family"),
        ("faceName", "face_name"),
        ("style", "style"),
        ("weight", "weight"),
    ] {
        if let Some(value) = emboss_attribute(text_xml, attribute).filter(|v| !v.is_empty()) {
            fields.push((key, string(&value)));
        }
    }
    Some(obj(fields))
}

// ---- project settings ----

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectSettings {
    pub config: Config,
    pub filament_colors: Vec<Vec<u16>>,
    pub mixed_definitions: Option<Vec<u16>>,
}
/// `parseProjectSettings`. JSON input uses JavaScript `JSON.parse` semantics
/// (duplicate keys keep the last value) and the browser's safe-tree check.
pub fn project_settings(
    bytes: Option<&[u8]>,
    parse_json: impl FnOnce(&str) -> Result<Value, Failure>,
) -> Result<ProjectSettings, Failure> {
    let Some(bytes) = bytes else {
        return Ok(ProjectSettings::default());
    };
    let text = js::trim(decode_text(bytes)?);
    let mut config = Config::new();
    if text.starts_with('{') {
        let parsed = parse_json(text)?;
        safe_tree(&parsed)?;
        let Value::Object(fields) = parsed else {
            return Err(Failure::ProjectSettings);
        };
        for (key, value) in fields {
            if !["type", "name", "from", "version", "inherits"]
                .iter()
                .any(|k| is_key(&key, k))
            {
                assign(&mut config, key, value)?;
            }
        }
    } else {
        for source in scan::open_tags(text, "setting") {
            let attrs = attributes(source)?;
            if let Some(key) = get(&attrs, "key").filter(|k| !k.is_empty()) {
                let value = decode_xml(get(&attrs, "value").unwrap_or(&[]))?;
                assign(&mut config, key.to_vec(), parse_scalar(&value))?;
            }
        }
    }
    let raw = config
        .get(&utf16("filament_colour"))
        .filter(|v| !matches!(v, Value::Null))
        .or_else(|| config.get(&utf16("extruder_colour")));
    let filament_colors = match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) => s
            .split(|u| *u == u16::from(b';'))
            .filter(|p| !p.is_empty())
            .map(<[u16]>::to_vec)
            .collect(),
        _ => Vec::new(),
    };
    let mixed_definitions = match config.get(&utf16("mixed_filament_definitions")) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    Ok(ProjectSettings {
        config,
        filament_colors,
        mixed_definitions,
    })
}
/// `assertSafeJsonTree` with its exact node/depth limits.
fn safe_tree(root: &Value) -> Result<(), Failure> {
    let mut stack = vec![(root, 0usize)];
    let mut nodes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if nodes > 1_000_000 || depth > 256 {
            return Err(Failure::ProjectSettings);
        }
        match value {
            Value::Array(items) => stack.extend(items.iter().map(|v| (v, depth + 1))),
            Value::Object(fields) => {
                for (key, child) in fields {
                    if is_key(key, "__proto__")
                        || is_key(key, "prototype")
                        || is_key(key, "constructor")
                    {
                        return Err(Failure::UnsafeKey);
                    }
                    stack.push((child, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// `printableAreaSize`.
pub fn printable_area_size(value: Option<&Value>) -> Option<(f64, f64)> {
    let entries: Vec<Vec<u16>> = match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) => s
            .split(|u| *u == u16::from(b',') || *u == u16::from(b';'))
            .map(|p| js::trim_utf16(p).to_vec())
            .collect(),
        _ => Vec::new(),
    };
    let mut points = Vec::new();
    for entry in entries {
        let Ok(entry) = String::from_utf16(&entry) else {
            continue;
        };
        if let Some((x, y)) = area_point(&entry) {
            points.push((x, y));
        }
    }
    if points.len() < 2 {
        return None;
    }
    let span = |f: fn(&(f64, f64)) -> f64| {
        let max = points.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
        let min = points.iter().map(f).fold(f64::INFINITY, f64::min);
        max - min
    };
    let (x, y) = (span(|p| p.0), span(|p| p.1));
    (x > 0.0 && y > 0.0).then_some((x, y))
}
/// `/^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*x\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/i`.
fn area_point(s: &str) -> Option<(f64, f64)> {
    let s = s.trim_matches(is_space);
    let (left, right) = {
        // Exactly one separator can satisfy the grammar: numbers have no x.
        let at = s.find(['x', 'X'])?;
        (&s[..at], &s[at + 1..])
    };
    let left = left.trim_end_matches(is_space);
    let right = right.trim_start_matches(is_space);
    if !area_number(left) || !area_number(right) {
        return None;
    }
    let (x, y) = (js::number(left), js::number(right));
    (x.is_finite() && y.is_finite()).then_some((x, y))
}
fn area_number(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let b = s.as_bytes();
    if b.first() == Some(&b'.') {
        return b.len() > 1 && b[1..].iter().all(u8::is_ascii_digit);
    }
    let int = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if int == 0 {
        return false;
    }
    match b.get(int) {
        None => true,
        Some(b'.') => b[int + 1..].iter().all(u8::is_ascii_digit),
        _ => false,
    }
}
/// `bbsVirtualPlateOrigins`, mirroring PartPlateList::compute_origin.
pub fn virtual_plate_origins(count: usize, bed: (f64, f64)) -> Vec<(f64, f64)> {
    let columns = (count as f64).sqrt().ceil() as usize;
    let gap = 1.0 + BBS_PLATE_GAP_RATIO;
    (0..count)
        .map(|index| {
            let row = index / columns.max(1);
            let column = index % columns.max(1);
            let x = column as f64 * bed.0 * gap;
            let y = if row == 0 {
                0.0
            } else {
                -(row as f64) * bed.1 * gap
            };
            (x, y)
        })
        .collect()
}

// ---- separate layer members ----

/// `parseLayerRanges` (`layer_config_ranges.xml`), keyed by the object's
/// 1-based source ordinal as the pinned writer numbers it.
pub fn layer_ranges(bytes: Option<&[u8]>) -> Result<BTreeMap<NumKey, Vec<Range>>, Failure> {
    let mut result = BTreeMap::new();
    let Some(bytes) = bytes else {
        return Ok(result);
    };
    let xml = decode_text(bytes)?;
    for (object_attrs, body) in scan::elements(xml, "object") {
        let id = attribute_number(&attributes(object_attrs)?, "id");
        if !js::is_integer(id) {
            continue;
        }
        let mut ranges = Vec::new();
        for (range_attrs, range_body) in scan::elements(body, "range") {
            let attrs = attributes(range_attrs)?;
            let mut config = Config::new();
            for (option_attrs, option_body) in scan::elements(range_body, "option") {
                let option = attributes(option_attrs)?;
                if let Some(key) = get(&option, "opt_key").filter(|k| !k.is_empty()) {
                    let value = decode_xml(&utf16(option_body))?;
                    assign(&mut config, key.to_vec(), parse_scalar(&value))?;
                }
            }
            ranges.push(Range {
                min_z_mm: attribute_number(&attrs, "min_z"),
                max_z_mm: attribute_number(&attrs, "max_z"),
                config,
            });
        }
        result.insert(NumKey::new(id), ranges);
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerEventType {
    ColorChange,
    Pause,
    ToolChange,
    Template,
    Custom,
}
impl LayerEventType {
    fn from_code(code: f64) -> Option<Self> {
        [
            Self::ColorChange,
            Self::Pause,
            Self::ToolChange,
            Self::Template,
            Self::Custom,
        ]
        .into_iter()
        .zip(0..)
        .find(|(_, c)| f64::from(*c) == code)
        .map(|(t, _)| t)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ColorChange => "color-change",
            Self::Pause => "pause",
            Self::ToolChange => "tool-change",
            Self::Template => "template",
            Self::Custom => "custom",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct LayerEvent {
    pub kind: LayerEventType,
    pub top_z_mm: f64,
    pub code: Vec<u16>,
    pub tool_index: Option<f64>,
    pub color: Option<Vec<u16>>,
    pub message: Option<Vec<u16>>,
}
/// `parseLayerEvents`, keyed by the engine's 1-based plate index.
pub fn layer_events(bytes: Option<&[u8]>) -> Result<BTreeMap<NumKey, Vec<LayerEvent>>, Failure> {
    let mut result = BTreeMap::new();
    let Some(bytes) = bytes else {
        return Ok(result);
    };
    let xml = decode_text(bytes)?;
    let mut fallback = 0usize;
    for (_, body) in scan::elements(xml, "plate") {
        fallback += 1;
        let declared = match scan::open_tags(body, "plate_info").next() {
            Some(source) => attribute_number(&attributes(source)?, "id"),
            None => f64::NAN,
        };
        let plate_index = if js::is_integer(declared) && declared > 0.0 {
            declared
        } else {
            fallback as f64
        };
        let mut events = Vec::new();
        for source in scan::open_tags(body, "layer") {
            let attrs = attributes(source)?;
            let top_z_mm = attribute_number(&attrs, "top_z");
            if !top_z_mm.is_finite() || top_z_mm <= 0.0 {
                continue;
            }
            let gcode = decode_xml(get(&attrs, "gcode").unwrap_or(&[]))?;
            let kind = LayerEventType::from_code(attribute_number(&attrs, "type"))
                .or_else(|| legacy_event_type(&gcode));
            let Some(kind) = kind else { continue };
            let tool_index = attribute_number(&attrs, "extruder");
            let color = decode_xml(get(&attrs, "color").unwrap_or(&[]))?;
            let extra = decode_xml(get(&attrs, "extra").unwrap_or(&[]))?;
            let code = if kind == LayerEventType::Custom {
                if extra.is_empty() {
                    gcode.clone()
                } else {
                    extra.clone()
                }
            } else {
                Vec::new()
            };
            events.push(LayerEvent {
                kind,
                top_z_mm,
                code,
                tool_index: (js::is_integer(tool_index) && tool_index >= 1.0).then_some(tool_index),
                color: (!color.is_empty()).then_some(color),
                message: (kind == LayerEventType::Pause && !extra.is_empty()).then_some(extra),
            });
        }
        if !events.is_empty() {
            result.insert(NumKey::new(plate_index), events);
        }
    }
    Ok(result)
}
fn legacy_event_type(gcode: &[u16]) -> Option<LayerEventType> {
    if is_key(gcode, "M600") {
        Some(LayerEventType::ColorChange)
    } else if is_key(gcode, "M601") {
        Some(LayerEventType::Pause)
    } else if is_key(gcode, "tool_change") {
        Some(LayerEventType::ToolChange)
    } else if !gcode.is_empty() {
        Some(LayerEventType::Custom)
    } else {
        None
    }
}

/// JavaScript `value.length > n ? value.slice(0, n) + suffix : value`.
fn bounded(value: &[u16], n: usize, keep: usize, suffix: &str) -> Vec<u16> {
    if value.len() > n {
        let mut out = value[..keep].to_vec();
        out.extend(suffix.encode_utf16());
        out
    } else {
        value.to_vec()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrimEars {
    pub object_id: f64,
    /// `[x, y, z, headFrontRadius]` per ear.
    pub points: Vec<[f64; 4]>,
}
/// `decodeBrimEarPoints`; warnings carry the browser's member prefix.
pub fn brim_ears(text: &str, warnings: &mut Vec<Warning>) -> Vec<BrimEars> {
    const KEY: &str = "brim_points_format_version=";
    let mut warn = |message: Vec<u16>| {
        let mut text = utf16(&format!("{BRIM_EAR_POINTS_PATH}: "));
        text.extend(message);
        warnings.push(Warning::from_utf16(WarningCode::BrimEars, text));
    };
    let body = text.strip_suffix('\n').unwrap_or(text);
    let mut lines: Vec<&str> = body.split('\n').collect();
    let mut version = 0.0;
    if lines.first().is_some_and(|l| l.contains(KEY)) {
        let first = lines.remove(0);
        let parsed = js::parse_int10(&first[first.find(KEY).unwrap() + KEY.len()..]);
        version = if parsed.is_finite() { parsed } else { 0.0 };
    }
    let mut objects = Vec::new();
    let mut seen = Vec::new();
    for line in lines {
        if js::trim(line).is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        let b80 = |s: &str| bounded(&utf16(s), 80, 80, "…");
        if parts.len() != 2 {
            let mut m = utf16("Error while reading object data: ");
            m.extend(b80(line));
            warn(m);
            continue;
        }
        let id_parts: Vec<&str> = parts[0].split('=').collect();
        if id_parts.len() != 2 {
            let mut m = utf16("Error while reading object id: ");
            m.extend(b80(parts[0]));
            warn(m);
            continue;
        }
        let object_id = js::parse_int10(id_parts[1]);
        if !object_id.is_finite() || object_id == 0.0 {
            let mut m = utf16("Found invalid object id: ");
            m.extend(b80(id_parts[1]));
            warn(m);
            continue;
        }
        if seen.contains(&NumKey::new(object_id)) {
            warn(utf16(&format!(
                "Found duplicated brim ear points for object {}",
                js::number_to_string(object_id)
            )));
            continue;
        }
        seen.push(NumKey::new(object_id));
        let id_text = js::number_to_string(object_id);
        if version != 0.0 {
            warn(utf16(&format!(
                "Unsupported brim_points_format_version {} for object {id_text}",
                js::number_to_string(version)
            )));
            continue;
        }
        let raw: Vec<&str> = parts[1].split(' ').collect();
        let mut points = Vec::new();
        let mut index = 0;
        while index + 3 < raw.len() {
            let values: Vec<f64> = raw[index..index + 4]
                .iter()
                .map(|v| js::parse_float(v))
                .collect();
            index += 4;
            if !values.iter().all(|v| v.is_finite()) {
                warn(utf16(&format!(
                    "Skipped a non-finite brim ear on object {id_text}"
                )));
                continue;
            }
            points.push([values[0], values[1], values[2], values[3]]);
        }
        if !raw.len().is_multiple_of(4) {
            warn(utf16(&format!(
                "Object {id_text} has {} trailing brim-ear value(s) that do not form a point",
                raw.len() % 4
            )));
        }
        if !points.is_empty() {
            objects.push(BrimEars { object_id, points });
        }
    }
    objects
}

#[derive(Clone, Debug, PartialEq)]
pub struct LayerHeights {
    pub object_id: f64,
    pub profile: Vec<f64>,
}
/// `decodeLayerHeightsProfile`.
pub fn layer_heights(text: &str, warnings: &mut Vec<Warning>) -> Vec<LayerHeights> {
    let mut warn = |message: Vec<u16>| {
        let mut text = utf16(&format!("{LAYER_HEIGHTS_PROFILE_PATH}: "));
        text.extend(message);
        warnings.push(Warning::from_utf16(WarningCode::LayerHeights, text));
    };
    let mut entries = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = js::trim(raw);
        if line.is_empty() {
            continue;
        }
        let parsed = line.strip_prefix("object_id=").and_then(|rest| {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0 && rest.as_bytes().get(digits) == Some(&b'|'))
                .then(|| (&rest[..digits], &rest[digits + 1..]))
        });
        // `(.*)$` stops at a line terminator; the split already removed \n,
        // but a lone \r, U+2028 or U+2029 inside the line defeats `$`.
        let parsed = parsed.filter(|(_, values)| !values.contains(['\r', '\u{2028}', '\u{2029}']));
        let Some((digits, values)) = parsed else {
            let mut m =
                utf16("Ignored a layer height profile line that is not object_id=<n>|<values>: ");
            m.extend(bounded(&utf16(line), 80, 77, "..."));
            warn(m);
            continue;
        };
        let object_id = js::number(digits);
        let profile: Vec<f64> = values
            .split(';')
            .filter(|v| !js::trim(v).is_empty())
            .map(js::number)
            .collect();
        if !js::is_safe_integer(object_id) || object_id < 1.0 {
            warn(utf16(&format!(
                "Ignored a layer height profile for an unusable object id {digits}"
            )));
            continue;
        }
        if profile.len() < 4
            || !profile.len().is_multiple_of(2)
            || !profile.iter().all(|v| v.is_finite())
        {
            warn(utf16(&format!(
                "Ignored the layer height profile for object {}: a profile is at least two finite z/height pairs",
                js::number_to_string(object_id)
            )));
            continue;
        }
        entries.push(LayerHeights { object_id, profile });
    }
    entries
}
