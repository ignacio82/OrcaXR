//! How the shells arrange catalogue actions (`web/src/ui/ActionPresentation.ts`):
//! the command palette's search, a context menu's sections and the model
//! toolbar's runs, so a native shell shows the browser's palette and menus.
//!
//! The palette searches each action's label, id and hint as the shell shows
//! them (its own language), the query trimmed with ECMAScript's whitespace and
//! everything lowercased as `String.prototype.toLowerCase` does
//! ([`crate::js_math::case::lower`]: Unicode 16, Final_Sigma, lone surrogates
//! kept), matching a substring of UTF-16 code units, in the order given. A
//! context menu's sections are the catalogue groups in `GROUPS`' declared
//! order, each keeping the order given; the toolbar's runs are consecutive
//! actions of one group.
//!
//! The exchange is canonical JSON, as `ActionPresentationExchange.ts` answers
//! it: [`palette_json`] reads `{"actions":[{"hint"?,"id","label"}],"query"}`
//! and answers `{"matches":[index]}`; [`groups_json`] reads
//! `{"actions":[id],"layout":"context"|"toolbar"}` and answers
//! `{"groups":[{"actions":[index],"group","label"}]}`. A malformed request, or
//! an action the catalogue does not have, is refused as `invalid_request`.
use crate::js_math::{case::lower, convert::trim_utf16};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_contracts::capabilities::{self, Group};
use std::collections::BTreeMap;

/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";

/// What the palette searches of one action, as the shell shows it (UTF-16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Searchable {
    pub id: Vec<u16>,
    pub label: Vec<u16>,
    pub hint: Option<Vec<u16>>,
}

fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// `paletteMatches`: the positions of the actions whose label, id or hint
/// contains the trimmed, lowercased query, in the order given; every action
/// for an empty query.
pub fn palette_matches(query: &[u16], actions: &[Searchable]) -> Vec<usize> {
    let q = lower(trim_utf16(query));
    if q.is_empty() {
        return (0..actions.len()).collect();
    }
    actions
        .iter()
        .enumerate()
        .filter(|(_, action)| {
            contains(&lower(&action.label), &q)
                || contains(&lower(&action.id), &q)
                || action
                    .hint
                    .as_deref()
                    .is_some_and(|hint| contains(&lower(hint), &q))
        })
        .map(|(index, _)| index)
        .collect()
}

/// `catalogGroups`: a context menu's sections, by the positions of `groups`'
/// members — the groups in `GROUPS`' declared order, empty ones left out.
pub fn catalog_groups(groups: &[Group]) -> Vec<(Group, Vec<usize>)> {
    Group::ORDER
        .into_iter()
        .filter_map(|group| {
            let members: Vec<usize> = groups
                .iter()
                .enumerate()
                .filter(|(_, g)| **g == group)
                .map(|(index, _)| index)
                .collect();
            (!members.is_empty()).then_some((group, members))
        })
        .collect()
}

/// `toolbarRuns`: the runs of consecutive members of one group.
pub fn toolbar_runs(groups: &[Group]) -> Vec<(Group, Vec<usize>)> {
    let mut runs: Vec<(Group, Vec<usize>)> = Vec::new();
    for (index, &group) in groups.iter().enumerate() {
        match runs.last_mut() {
            Some((last, members)) if *last == group => members.push(index),
            _ => runs.push((group, vec![index])),
        }
    }
    runs
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}

fn members(
    value: Value,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| required.iter().chain(optional).any(|n| units(n) == *key);
    if !fields.keys().all(known) || !required.iter().all(|n| fields.contains_key(&units(n))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}

fn text(value: Option<Value>) -> Result<Vec<u16>, &'static str> {
    match value {
        Some(Value::String(text)) => Ok(text),
        _ => Err(INVALID_REQUEST),
    }
}

fn list(value: Option<Value>) -> Result<Vec<Value>, &'static str> {
    match value {
        Some(Value::Array(values)) => Ok(values),
        _ => Err(INVALID_REQUEST),
    }
}

fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}

fn indices(values: &[usize]) -> Value {
    Value::Array(values.iter().map(|&i| Value::Number(i as f64)).collect())
}

/// `commandPaletteExchange`.
pub fn palette_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["actions", "query"], &[])?;
    let query = text(fields.remove(&units("query")))?;
    let actions = list(fields.remove(&units("actions")))?
        .into_iter()
        .map(|entry| {
            let mut entry = members(entry, &["id", "label"], &["hint"])?;
            Ok(Searchable {
                id: text(entry.remove(&units("id")))?,
                label: text(entry.remove(&units("label")))?,
                hint: entry
                    .remove(&units("hint"))
                    .map(|hint| text(Some(hint)))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let reply = BTreeMap::from([(
        units("matches"),
        indices(&palette_matches(&query, &actions)),
    )]);
    canonical(&Value::Object(reply))
}

/// `actionGroupsExchange`.
pub fn groups_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["actions", "layout"], &[])?;
    let layout = text(fields.remove(&units("layout")))?;
    let toolbar = if layout == units("toolbar") {
        true
    } else if layout == units("context") {
        false
    } else {
        return Err(INVALID_REQUEST);
    };
    let groups = list(fields.remove(&units("actions")))?
        .into_iter()
        .map(|id| {
            let id = String::from_utf16(&text(Some(id))?).map_err(|_| INVALID_REQUEST)?;
            capabilities::action(&id)
                .map(|action| action.group)
                .ok_or(INVALID_REQUEST)
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let arranged = if toolbar {
        toolbar_runs(&groups)
    } else {
        catalog_groups(&groups)
    };
    let groups = arranged
        .into_iter()
        .map(|(group, members)| {
            Value::Object(BTreeMap::from([
                (units("actions"), indices(&members)),
                (units("group"), Value::String(units(group.id()))),
                (units("label"), Value::String(units(group.label()))),
            ]))
        })
        .collect();
    canonical(&Value::Object(BTreeMap::from([(
        units("groups"),
        Value::Array(groups),
    )])))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> Vec<u16> {
        units(text)
    }

    #[test]
    fn palette_trims_lowercases_and_keeps_order() {
        let actions = [
            Searchable {
                id: s("add_primitive_cube"),
                label: s("Cube"),
                hint: None,
            },
            Searchable {
                id: s("b"),
                label: s("\u{39f}\u{394}\u{39f}\u{3a3}"),
                hint: Some(s("Mirror the CUBE")),
            },
        ];
        assert_eq!(palette_matches(&s("  "), &actions), [0, 1]);
        assert_eq!(palette_matches(&s(" cUbE\u{3000}"), &actions), [0, 1]);
        assert_eq!(
            palette_matches(&s("\u{3bf}\u{3b4}\u{3bf}\u{3c2}"), &actions),
            [1]
        );
        assert_eq!(
            palette_matches(&s("\u{3bf}\u{3b4}\u{3bf}\u{3c3}"), &actions),
            [0usize; 0]
        );
        assert_eq!(palette_matches(&[0xd800], &actions), [0usize; 0]);
    }

    #[test]
    fn groups_section_and_run() {
        use Group::{Edit, Scene};
        assert_eq!(
            catalog_groups(&[Scene, Edit, Scene]),
            [(Edit, vec![1]), (Scene, vec![0, 2])]
        );
        assert_eq!(
            toolbar_runs(&[Scene, Edit, Scene, Scene]),
            [(Scene, vec![0]), (Edit, vec![1]), (Scene, vec![2, 3])]
        );
        assert!(toolbar_runs(&[]).is_empty());
    }
}
