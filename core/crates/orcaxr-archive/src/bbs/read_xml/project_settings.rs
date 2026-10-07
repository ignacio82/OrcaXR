//! Bounded BBS `project_settings.config` projection. Unknown configuration
//! values are preserved; only file-envelope fields are removed from JSON input.
use super::{Event, Failure, Limits as XmlLimits, Scanner};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::ingress::json::{JsonInput, JsonInputError, JsonLimits, MAX_CHUNK_BYTES};
use std::collections::BTreeMap;
use std::io::Write;

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectSettings {
    /// BBS configuration with the outer JSON file-envelope fields removed.
    pub config: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Json(JsonInputError),
    Xml(Failure),
    InvalidRoot,
    UnsafeKey,
    Cancelled,
}

pub fn parse(
    bytes: &[u8],
    json_limits: JsonLimits,
    xml_limits: XmlLimits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<ProjectSettings, Error> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Xml(Failure::Utf8))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.trim_matches(super::text::whitespace);
    if text.is_empty() {
        return Ok(ProjectSettings {
            config: Value::Object(BTreeMap::new()),
        });
    }
    if text.starts_with('{') {
        return parse_json(text.as_bytes(), json_limits, &mut cancelled);
    }
    parse_legacy_xml(text.as_bytes(), xml_limits, &mut cancelled)
}

fn parse_json(
    bytes: &[u8],
    limits: JsonLimits,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<ProjectSettings, Error> {
    let mut input = JsonInput::new(bytes.len(), limits).map_err(Error::Json)?;
    for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        input
            .append(input.received_bytes(), chunk)
            .map_err(Error::Json)?;
    }
    let value = input.finish().map_err(Error::Json)?;
    validate_safe_keys(&value, 0, limits.max_depth, cancelled)?;
    let Value::Object(mut config) = value else {
        return Err(Error::InvalidRoot);
    };
    for reserved in ["type", "name", "from", "version", "inherits"] {
        config.remove(reserved.encode_utf16().collect::<Vec<_>>().as_slice());
    }
    Ok(ProjectSettings {
        config: Value::Object(config),
    })
}

fn validate_safe_keys(
    value: &Value,
    depth: usize,
    maximum_depth: usize,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    if cancelled() {
        return Err(Error::Cancelled);
    }
    if depth > maximum_depth {
        return Err(Error::Json(JsonInputError::Limit));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_safe_keys(value, depth + 1, maximum_depth, cancelled)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if ["__proto__", "prototype", "constructor"]
                    .into_iter()
                    .any(|unsafe_key| key.iter().copied().eq(unsafe_key.encode_utf16()))
                {
                    return Err(Error::UnsafeKey);
                }
                validate_safe_keys(value, depth + 1, maximum_depth, cancelled)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_legacy_xml(
    bytes: &[u8],
    limits: XmlLimits,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<ProjectSettings, Error> {
    let mut builder = LegacySettingsBuilder::default();
    let mut scanner = Scanner::new(limits, cancelled, |event| builder.event(event));
    if scanner.write_all(bytes).is_err() {
        let result = scanner.finish();
        return match result {
            Err(super::Error::Input(Failure::Cancelled)) => Err(Error::Cancelled),
            Err(super::Error::Input(failure)) => Err(Error::Xml(failure)),
            Err(super::Error::Visitor(error)) => Err(error),
            Ok(_) => Err(Error::Xml(Failure::Syntax)),
        };
    }
    scanner.finish().map_err(|error| match error {
        super::Error::Input(Failure::Cancelled) => Error::Cancelled,
        super::Error::Input(failure) => Error::Xml(failure),
        super::Error::Visitor(error) => error,
    })?;
    Ok(ProjectSettings {
        config: Value::Object(builder.config),
    })
}

#[derive(Default)]
struct LegacySettingsBuilder {
    config: BTreeMap<Vec<u16>, Value>,
}
impl LegacySettingsBuilder {
    fn event(&mut self, event: Event<'_>) -> Result<(), Error> {
        let Event::Open(tag) = event else {
            return Ok(());
        };
        if !tag.name.eq_ignore_ascii_case("setting") {
            return Ok(());
        }
        let key = tag
            .attributes()
            .find(|attribute| attribute.namespace.is_none() && attribute.local_name == "key")
            .map(|attribute| attribute.value);
        let Some(key) = key else {
            return Ok(());
        };
        if key.is_empty() {
            return Ok(());
        }
        if ["__proto__", "prototype", "constructor"]
            .into_iter()
            .any(|unsafe_key| key.encode_utf16().eq(unsafe_key.encode_utf16()))
        {
            return Err(Error::UnsafeKey);
        }
        let value = tag
            .attributes()
            .find(|attribute| attribute.namespace.is_none() && attribute.local_name == "value")
            .map_or("", |attribute| attribute.value);
        self.config
            .insert(key.encode_utf16().collect(), parse_scalar(value));
        Ok(())
    }
}

fn parse_scalar(value: &str) -> Value {
    if value == "true" {
        return Value::Bool(true);
    }
    if value == "false" {
        return Value::Bool(false);
    }
    if valid_number(value)
        && let Ok(number) = value.parse::<f64>()
        && number.is_finite()
    {
        return Value::Number(number);
    }
    Value::String(value.encode_utf16().collect())
}

fn valid_number(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut cursor = usize::from(bytes.first() == Some(&b'-'));
    if cursor == bytes.len() {
        return false;
    }
    match bytes.get(cursor) {
        Some(b'0') => cursor += 1,
        Some(b'1'..=b'9') => {
            cursor += 1;
            while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == start {
            return false;
        }
    }
    if bytes
        .get(cursor)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        cursor += 1;
        if bytes
            .get(cursor)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            cursor += 1;
        }
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == start {
            return false;
        }
    }
    cursor == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_limits() -> JsonLimits {
        JsonLimits {
            max_bytes: 1 << 20,
            max_nodes: 100_000,
            max_text_units: 1 << 20,
            max_number_bytes: 128,
            max_depth: 64,
        }
    }
    fn xml_limits(bytes: usize) -> XmlLimits {
        XmlLimits {
            input_bytes: bytes,
            text_units: bytes,
            token_bytes: 64 << 10,
            elements: 100_000,
            attributes: 500_000,
            depth: 128,
        }
    }

    #[test]
    fn bounded_json_strips_envelope_fields_and_rejects_unsafe_nested_keys() {
        let parsed = parse(
            br##"{"type":"project_settings","filament_colour":["#FF0000"],"inherits":"Base","x":true}"##,
            json_limits(),
            xml_limits(1 << 20),
            || false,
        )
        .unwrap();
        let Value::Object(config) = parsed.config else {
            panic!("object config");
        };
        assert!(!config.contains_key(&"type".encode_utf16().collect::<Vec<_>>()));
        assert!(!config.contains_key(&"inherits".encode_utf16().collect::<Vec<_>>()));
        assert_eq!(
            config[&"x".encode_utf16().collect::<Vec<_>>()],
            Value::Bool(true)
        );
        assert_eq!(
            parse(
                br#"{"nested":{"constructor":1}}"#,
                json_limits(),
                xml_limits(1 << 20),
                || false,
            ),
            Err(Error::UnsafeKey)
        );
        assert_eq!(
            parse(
                br#"{"x":[1,2]}"#,
                JsonLimits {
                    max_nodes: 2,
                    ..json_limits()
                },
                xml_limits(1 << 20),
                || false,
            ),
            Err(Error::Json(JsonInputError::Limit))
        );
    }

    #[test]
    fn legacy_settings_xml_matches_scalar_coercion_and_last_key_wins() {
        let parsed = parse(
            b"<config><setting key=\"count\" value=\"2.5e1\"/><setting key=\"flag\" value=\"false\"/><setting key=\"count\" value=\"last\"/></config>",
            json_limits(),
            xml_limits(1024),
            || false,
        )
        .unwrap();
        assert_eq!(
            parsed.config,
            Value::Object(BTreeMap::from([
                (
                    "count".encode_utf16().collect(),
                    Value::String("last".encode_utf16().collect())
                ),
                ("flag".encode_utf16().collect(), Value::Bool(false)),
            ]))
        );
    }
}
