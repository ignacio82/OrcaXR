//! File → Export Config… (`exportConfigJson` over `OrcaWorkspace.profile`,
//! `ConfigIO.ts`): the active catalog profile as the browser writes it —
//! `JSON.stringify({orcaxr_config: 1, machineName, processName, filamentName,
//! config}, null, 2)` — byte for byte.
//!
//! The browser's `config` is `{...machine, ...process, ...filament}` of the
//! presets' flattened configurations, each flattening its preset's
//! `{...parentEffective, ...raw}` in that object's own property order. The
//! compiled catalog keeps configurations as sorted maps, so the order is
//! recovered from the catalog's own JSON ([`KeyOrders`], recorded as it is
//! parsed): a parent's keys in its order, then the keys a preset adds in the
//! order its JSON object lists them, array-index keys first as JavaScript
//! orders them. A preset whose order was not recorded (a catalog composed from
//! parsed values) lists its keys in UTF-16 order.
use crate::{
    ingress::json::{ObjectOrder, js_property_order},
    js_math::convert::json_stringify,
    settings::{
        catalog::Profile,
        presets::{PresetGraph, PresetNode},
    },
};
use orcaxr_contracts::canonical::Value;
use std::collections::{HashMap, HashSet};

/// A preset object's place in a catalog's JSON: its vendor, kind list and name.
type PresetKey = (Vec<u16>, Vec<u16>, Vec<u16>);

/// The property order of every preset object of a catalog's JSON, by vendor, kind and name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyOrders {
    by_preset: HashMap<PresetKey, Vec<Vec<u16>>>,
}

impl KeyOrders {
    /// From the orders a catalog's parse recorded; a repeated name keeps the
    /// first, as the preset graph keeps the first of two equal names.
    pub fn new(orders: Vec<ObjectOrder>) -> Self {
        let mut by_preset = HashMap::new();
        for order in orders {
            if let Some(name) = order.name {
                by_preset
                    .entry((order.group, order.list, name))
                    .or_insert(order.keys);
            }
        }
        Self { by_preset }
    }

    fn raw(&self, node: &PresetNode) -> Option<&Vec<Vec<u16>>> {
        self.by_preset.get(&(
            node.vendor.clone(),
            node.kind.as_str().encode_utf16().collect(),
            node.name.clone(),
        ))
    }
}

/// `{...a, ...b}`'s keys: a's, then b's new ones, in JavaScript's own-property order.
fn spread(
    into: &mut Vec<Vec<u16>>,
    seen: &mut HashSet<Vec<u16>>,
    keys: impl IntoIterator<Item = Vec<u16>>,
) {
    for key in keys {
        if seen.insert(key.clone()) {
            into.push(key);
        }
    }
}

/// A preset's effective property order: its parent's, then its own new keys.
fn effective(
    graph: &PresetGraph,
    node: &PresetNode,
    orders: Option<&KeyOrders>,
    depth: usize,
) -> Vec<Vec<u16>> {
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    if let Some(parent) = node.parent_id.as_deref().and_then(|id| graph.get(id))
        && depth < 1024
    {
        spread(
            &mut keys,
            &mut seen,
            effective(graph, parent, orders, depth + 1),
        );
    }
    let own = match orders.and_then(|o| o.raw(node)) {
        Some(order) => order.clone(),
        // Unrecorded: the raw object's keys as a parsed canonical object lists them.
        None => js_property_order(node.raw.keys().cloned().collect()),
    };
    spread(&mut keys, &mut seen, own);
    js_property_order(keys)
}

fn quote(units: &[u16]) -> String {
    String::from_utf16(&json_stringify(&Value::String(units.to_vec())))
        .expect("JSON.stringify escapes lone surrogates")
}

/// The Export Config… file of [profile] in [graph] (its compiled catalog), with
/// the property orders [orders] recorded from the catalog's JSON.
pub fn config_json(profile: &Profile, graph: &PresetGraph, orders: Option<&KeyOrders>) -> String {
    let parts = profile.parts();
    let ids = [
        &profile.machine_preset_id,
        &profile.process_preset_id,
        &profile.filament_preset_id,
    ];
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    for (id, part) in ids.into_iter().zip(parts.iter()) {
        let flattened: Vec<Vec<u16>> = match graph.get(id) {
            Some(node) => effective(graph, node, orders, 0)
                .into_iter()
                .filter(|key| part.contains_key(key))
                .collect(),
            None => part.keys().cloned().collect(),
        };
        spread(&mut keys, &mut seen, flattened);
    }
    let keys = js_property_order(keys);
    let config = profile.config();
    let mut out = String::from("{\n  \"orcaxr_config\": 1,\n");
    for (label, value) in [
        ("machineName", &profile.machine_name),
        ("processName", &profile.process_name),
        ("filamentName", &profile.filament_name),
    ] {
        out.push_str(&format!("  \"{label}\": {},\n", quote(value)));
    }
    if keys.is_empty() {
        out.push_str("  \"config\": {}\n}");
        return out;
    }
    out.push_str("  \"config\": {\n");
    for (index, key) in keys.iter().enumerate() {
        let value = config.get(key).map(Vec::as_slice).unwrap_or(&[]);
        out.push_str(&format!(
            "    {}: {}{}\n",
            quote(key),
            quote(value),
            if index + 1 < keys.len() { "," } else { "" }
        ));
    }
    out.push_str("  }\n}");
    out
}
