//! `RememberedCredentials.ts`: the printer keys and slicer token remembered
//! on a device, under a switch the operator can turn off and a way to forget
//! them.
//!
//! The record is read from and written to the text the browser stores
//! ([`load`], [`save`]); a host keeps that text where its platform keeps
//! secrets — the browser in its storage, Android sealed by the Keystore. A
//! secret longer than any issued key is dropped rather than stored, at most 32
//! per-printer keys are kept (in key order, so a store's own listing order
//! never matters), and turning remembering off erases what was stored.
use crate::reply::{LIMITS, Value, field, record, units};
use orcaxr_contracts::{canonical::parse_javascript, project_intent_types as wire};
use orcaxr_project::js_math::convert::{js_keys, json_stringify, trim_utf16};
use std::collections::BTreeMap;

/// A secret's length in UTF-16 units: anything longer is not a key anyone
/// issued, but an accidental paste.
pub const MAX_SECRET_UNITS: usize = 4096;
/// Per-printer keys kept.
pub const MAX_PRINTER_KEYS: usize = 32;
/// A per-printer key's printer id, in UTF-16 units.
pub const MAX_KEY_UNITS: usize = 64;

/// `readSecret`: trimmed text, or none for anything else or too long.
fn read_secret(value: Option<&Value>) -> Vec<u16> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = trim_utf16(text);
            if trimmed.len() > MAX_SECRET_UNITS {
                Vec::new()
            } else {
                trimmed.to_vec()
            }
        }
        _ => Vec::new(),
    }
}

/// `readSecretMap` over entries already in key order: the first 32, each id
/// cut to 64 units, empty secrets dropped (a later one replacing a cut id).
/// An id of `__proto__` is dropped too: assigning it on a plain object sets
/// no property.
fn secret_map<'a>(
    entries: impl Iterator<Item = (&'a Vec<u16>, &'a Value)>,
) -> BTreeMap<Vec<u16>, Value> {
    let mut map = BTreeMap::new();
    for (key, entry) in entries.take(MAX_PRINTER_KEYS) {
        let secret = read_secret(Some(entry));
        let id = &key[..key.len().min(MAX_KEY_UNITS)];
        if !secret.is_empty() && id != units("__proto__") {
            map.insert(id.to_vec(), Value::String(secret));
        }
    }
    map
}

/// The map's entries in JavaScript property order, as the record carries them.
fn secrets(map: &BTreeMap<Vec<u16>, Value>) -> Vec<wire::RememberedSecret> {
    js_keys(map)
        .into_iter()
        .map(|key| wire::RememberedSecret {
            key: key.clone(),
            secret: match &map[key] {
                Value::String(s) => s.clone(),
                _ => Vec::new(),
            },
        })
        .collect()
}

fn none() -> wire::RememberedCredentials {
    wire::RememberedCredentials {
        printer_api_key: Vec::new(),
        printer_api_keys: Vec::new(),
        slicer_token: Vec::new(),
        remember: true,
    }
}

/// `loadRememberedCredentials`: the stored text (none: nothing stored) read
/// as the record; anything unreadable remembers nothing.
pub fn load(stored: Option<&str>) -> wire::RememberedCredentials {
    let Some(value) = parse_javascript(stored.unwrap_or("null"), LIMITS)
        .ok()
        .filter(|v| record(Some(v)).is_some())
    else {
        return none();
    };
    let map = match field(&value, "printerApiKeys") {
        Some(Value::Object(fields)) => secret_map(fields.iter()),
        _ => BTreeMap::new(),
    };
    wire::RememberedCredentials {
        printer_api_key: read_secret(field(&value, "printerApiKey")),
        printer_api_keys: secrets(&map),
        slicer_token: read_secret(field(&value, "slicerToken")),
        // Absent means a store written before the switch existed.
        remember: !matches!(field(&value, "remember"), Some(Value::Bool(false))),
    }
}

/// `saveRememberedCredentials`: the text to store, or none to remove what is
/// stored. Remembering off stores the switch and no secret.
pub fn save(credentials: &wire::RememberedCredentials) -> Option<Vec<u16>> {
    let quote = |text: &[u16]| json_stringify(&Value::String(text.to_vec()));
    if !credentials.remember {
        return Some(units(
            "{\"printerApiKey\":\"\",\"printerApiKeys\":{},\"slicerToken\":\"\",\"remember\":false}",
        ));
    }
    let secret = |text: &[u16]| read_secret(Some(&Value::String(text.to_vec())));
    let printer_api_key = secret(&credentials.printer_api_key);
    let slicer_token = secret(&credentials.slicer_token);
    // The record as an object: a repeated id keeps its last secret.
    let mut given = BTreeMap::new();
    for entry in &credentials.printer_api_keys {
        given.insert(entry.key.clone(), Value::String(entry.secret.clone()));
    }
    let map = secret_map(given.iter());
    if printer_api_key.is_empty() && slicer_token.is_empty() && map.is_empty() {
        return None;
    }
    let mut out = units("{\"printerApiKey\":");
    out.extend(quote(&printer_api_key));
    out.extend(units(",\"printerApiKeys\":"));
    out.extend(json_stringify(&Value::Object(map)));
    out.extend(units(",\"slicerToken\":"));
    out.extend(quote(&slicer_token));
    out.extend(units(",\"remember\":true}"));
    Some(out)
}
