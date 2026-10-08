//! `paintPalette.ts`: the canonical filament library as the painting palette.
//! Entries keep stable IDs, so a stroke never stores a transient index, and
//! mixed recipes keep their own badge, gradient and summary instead of
//! collapsing into a predicted swatch.
use crate::{
    js_math::convert::number_to_string,
    model::{Filaments, MixedDistribution, MixedFilament, PhysicalFilament},
};
use std::collections::{BTreeMap, BTreeSet};

const DEFAULT_COLOR: &str = "#9aa0a6";

/// `PaintPaletteEntryKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Default,
    Physical,
    Mixed,
}
impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Physical => "physical",
            Self::Mixed => "mixed",
        }
    }
}
/// `PaintPaletteEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `None` is the unpainted, inheriting entry.
    pub filament_id: Option<Vec<u16>>,
    pub kind: EntryKind,
    pub name: Vec<u16>,
    pub display_color: Vec<u16>,
    pub gradient: Option<Vec<Vec<u16>>>,
    pub badge: Vec<u16>,
    pub recipe_summary: Option<Vec<u16>>,
    pub keyboard_number: Option<u32>,
    pub engine_slot: Option<usize>,
    pub selectable: bool,
    pub unavailable_reason: Option<Vec<u16>>,
}
/// `PaintPalette`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    pub entries: Vec<Entry>,
    pub physical_count: usize,
    pub enabled_mixed_count: usize,
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn hex(units: &[u16]) -> bool {
    units
        .iter()
        .all(|u| matches!(u, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66))
}
fn lower(units: &[u16]) -> Vec<u16> {
    units
        .iter()
        .map(|u| {
            if (0x41..=0x5a).contains(u) {
                u + 0x20
            } else {
                *u
            }
        })
        .collect()
}
/// `normalizeColor`: `#rrggbb` in lower case; three-digit and eight-digit
/// forms expand or drop alpha; anything else is the default swatch.
fn normalize_color(color: &[u16]) -> Vec<u16> {
    let trimmed = crate::js_math::convert::trim_utf16(color);
    let hash = trimmed.first() == Some(&u16::from(b'#'));
    match trimmed.len() {
        7 if hash && hex(&trimmed[1..]) => lower(trimmed),
        4 if hash && hex(&trimmed[1..]) => {
            let mut out = vec![u16::from(b'#')];
            for u in &trimmed[1..] {
                out.extend([*u, *u]);
            }
            lower(&out)
        }
        9 if hash && hex(&trimmed[1..]) => lower(&trimmed[..7]),
        _ => units(DEFAULT_COLOR),
    }
}
fn color_or_default(color: Option<&[u16]>) -> Vec<u16> {
    match color {
        Some(c) if !c.is_empty() => normalize_color(c),
        _ => units(DEFAULT_COLOR),
    }
}

/// `componentIds`: component filaments, then gradient components, first
/// occurrences, non-empty.
fn component_ids(recipe: &MixedFilament) -> Vec<Vec<u16>> {
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    let gradient = recipe
        .full_spectrum
        .as_ref()
        .map(|fs| {
            fs.gradient_component_ids
                .iter()
                .map(|id| id.as_utf16().to_vec())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for id in recipe
        .components
        .iter()
        .map(|c| c.filament_id.as_utf16().to_vec())
        .chain(gradient)
    {
        if !id.is_empty() && seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    ids
}
fn describe_missing(recipe: &MixedFilament, physical: &[&PhysicalFilament]) -> Option<Vec<u16>> {
    let known: BTreeSet<&[u16]> = physical.iter().map(|f| f.id.as_utf16()).collect();
    let missing = component_ids(recipe)
        .iter()
        .filter(|id| !known.contains(id.as_slice()))
        .count();
    (missing > 0).then(|| {
        units(&format!(
            "This recipe references {missing} filament{} that the project no longer has.",
            if missing == 1 { "" } else { "s" }
        ))
    })
}
fn gradient_stops(recipe: &MixedFilament, physical: &[&PhysicalFilament]) -> Vec<Vec<u16>> {
    // The last filament with an ID wins, as a `Map` built from the list does.
    let by_id: BTreeMap<&[u16], Vec<u16>> = physical
        .iter()
        .map(|f| (f.id.as_utf16(), color_or_default(Some(f.color.units()))))
        .collect();
    let stops: Vec<Vec<u16>> = component_ids(recipe)
        .iter()
        .filter_map(|id| by_id.get(id.as_slice()).cloned())
        .filter(|c| !c.is_empty())
        .collect();
    if stops.len() > 1 { stops } else { Vec::new() }
}
fn mode_badge(recipe: &MixedFilament) -> &'static str {
    match recipe.distribution {
        MixedDistribution::Ratio(_) => "Ratio",
        MixedDistribution::Cycle(_) => "Cycle",
        MixedDistribution::Match(_) => "Match",
        MixedDistribution::Gradient(_) => "Gradient",
    }
}
/// V8's `Math.round`.
fn round(x: f64) -> f64 {
    let up = x.ceil();
    if up - 0.5 > x { up - 1.0 } else { up }
}
/// `summarizeRecipe`.
fn summarize(recipe: &MixedFilament, physical: &[&PhysicalFilament]) -> Option<Vec<u16>> {
    let labels: BTreeMap<&[u16], Vec<u16>> = physical
        .iter()
        .map(|f| {
            (
                f.id.as_utf16(),
                units(&format!("T{}", number_to_string(f.tool_id.get()))),
            )
        })
        .collect();
    let label =
        |id: &[u16], fallback: &[u16]| labels.get(id).cloned().unwrap_or_else(|| fallback.to_vec());
    let join = |parts: Vec<Vec<u16>>, separator: &str| {
        let mut out = Vec::new();
        for (i, part) in parts.into_iter().enumerate() {
            if i > 0 {
                out.extend(units(separator));
            }
            out.extend(part);
        }
        out
    };
    match recipe.distribution {
        MixedDistribution::Gradient(_) => {
            let ids: Vec<Vec<u16>> = match recipe.full_spectrum.as_ref() {
                Some(fs) if !fs.gradient_component_ids.is_empty() => fs
                    .gradient_component_ids
                    .iter()
                    .map(|id| id.as_utf16().to_vec())
                    .collect(),
                _ => recipe
                    .components
                    .iter()
                    .map(|c| c.filament_id.as_utf16().to_vec())
                    .collect(),
            };
            let named: Vec<Vec<u16>> = ids.iter().map(|id| label(id, id)).collect();
            return (named.len() >= 2)
                .then(|| join(vec![named[0].clone(), named[1].clone()], " \u{2192} "));
        }
        MixedDistribution::Cycle(_) => {
            let groups = recipe
                .full_spectrum
                .as_ref()
                .map(|fs| {
                    fs.manual_pattern_groups
                        .iter()
                        .map(|group| {
                            join(
                                group
                                    .iter()
                                    .map(|id| label(id.as_utf16(), &units("?")))
                                    .collect(),
                                " ",
                            )
                        })
                        .filter(|g| !g.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !groups.is_empty() {
                let mut out = units("Pattern ");
                out.extend(join(groups, ", "));
                return Some(out);
            }
        }
        _ => {}
    }
    if recipe.components.is_empty() {
        return None;
    }
    let total: f64 = recipe.components.iter().map(|c| c.weight.get()).sum();
    if total <= 0.0 {
        return Some(join(
            recipe
                .components
                .iter()
                .map(|c| label(c.filament_id.as_utf16(), &units("?")))
                .collect(),
            " + ",
        ));
    }
    Some(join(
        recipe
            .components
            .iter()
            .map(|c| {
                let share = round(c.weight.get() / total * 100.0);
                let mut out = units(&format!("{}% ", number_to_string(share)));
                out.extend(label(c.filament_id.as_utf16(), &units("?")));
                out
            })
            .collect(),
        " / ",
    ))
}

/// `projectPaintPalette` over a project's filament library. `include_unavailable` keeps disabled recipes and
/// recipes with missing components as unselectable rows.
pub fn project_palette(filaments: &Filaments, include_unavailable: bool) -> Palette {
    let mut physical: Vec<&PhysicalFilament> = filaments.physical.iter().map(|f| &**f).collect();
    // A stable sort by tool, as `Array.prototype.sort` is.
    physical.sort_by(|a, b| {
        a.tool_id
            .get()
            .partial_cmp(&b.tool_id.get())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let all_physical: Vec<&PhysicalFilament> = filaments.physical.iter().map(|f| &**f).collect();
    let mixed: Vec<&MixedFilament> = filaments.mixed.iter().map(|f| &**f).collect();
    let deleted =
        |recipe: &MixedFilament| recipe.full_spectrum.as_ref().is_some_and(|fs| fs.deleted);
    let enabled_mixed_count = mixed.iter().filter(|r| r.enabled && !deleted(r)).count();
    let mut entries = vec![Entry {
        filament_id: None,
        kind: EntryKind::Default,
        name: units("Default (inherit)"),
        display_color: physical
            .first()
            .map_or_else(|| units(DEFAULT_COLOR), |f| f.color.units().to_vec()),
        gradient: None,
        badge: units("0"),
        recipe_summary: None,
        keyboard_number: None,
        engine_slot: None,
        selectable: true,
        unavailable_reason: None,
    }];
    for (index, filament) in physical.iter().enumerate() {
        entries.push(Entry {
            filament_id: Some(filament.id.as_utf16().to_vec()),
            kind: EntryKind::Physical,
            name: if filament.name.units().is_empty() {
                units(&format!(
                    "Filament {}",
                    number_to_string(filament.tool_id.get())
                ))
            } else {
                filament.name.units().to_vec()
            },
            display_color: color_or_default(Some(filament.color.units())),
            gradient: None,
            badge: units(&format!("T{}", number_to_string(filament.tool_id.get()))),
            recipe_summary: (!filament.material.units().is_empty())
                .then(|| filament.material.units().to_vec()),
            keyboard_number: (index < 9).then_some(index as u32 + 1),
            engine_slot: Some(index + 1),
            selectable: true,
            unavailable_reason: None,
        });
    }
    let mut enabled_ordinal = 0;
    for recipe in mixed {
        if deleted(recipe) {
            continue;
        }
        let issue = describe_missing(recipe, &all_physical);
        let selectable = recipe.enabled && issue.is_none();
        if !selectable && !include_unavailable {
            continue;
        }
        let stops = gradient_stops(recipe, &all_physical);
        let slot = recipe.enabled.then(|| physical.len() + 1 + enabled_ordinal);
        if recipe.enabled {
            enabled_ordinal += 1;
        }
        let display = if recipe.display_color.units().is_empty() {
            stops.first().map(|s| s.as_slice())
        } else {
            Some(recipe.display_color.units())
        };
        entries.push(Entry {
            filament_id: Some(recipe.id.as_utf16().to_vec()),
            kind: EntryKind::Mixed,
            name: if recipe.name.units().is_empty() {
                units("Virtual filament")
            } else {
                recipe.name.units().to_vec()
            },
            display_color: color_or_default(display),
            gradient: (stops.len() > 1).then_some(stops),
            badge: units(mode_badge(recipe)),
            recipe_summary: summarize(recipe, &all_physical),
            keyboard_number: None,
            engine_slot: slot,
            selectable,
            unavailable_reason: (!selectable).then(|| {
                issue.unwrap_or_else(|| {
                    units("This virtual filament is disabled and cannot be painted.")
                })
            }),
        });
    }
    // Keyboard numbers follow displayed order across physical and mixed rows.
    let mut next = 1;
    for entry in &mut entries {
        if entry.kind == EntryKind::Default || !entry.selectable || next > 9 {
            continue;
        }
        entry.keyboard_number = Some(next);
        next += 1;
    }
    Palette {
        entries,
        physical_count: physical.len(),
        enabled_mixed_count,
    }
}

/// The palette as a generated contract value.
pub fn wire_palette(palette: &Palette) -> orcaxr_contracts::project_intent_types::PaintPalette {
    use orcaxr_contracts::project_intent_types as wire;
    let text = |units: Option<&[u16]>| match units {
        Some(u) => wire::OptionalText::Value(u.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    };
    let counter = |n: Option<u64>| match n {
        Some(n) => wire::OptionalCounter::Value(n),
        None => wire::OptionalCounter::Absent(wire::Empty {}),
    };
    wire::PaintPalette {
        entries: palette
            .entries
            .iter()
            .map(|e| wire::PaintPaletteEntry {
                filament_id: text(e.filament_id.as_deref()),
                kind: match e.kind {
                    EntryKind::Default => wire::PaintPaletteKind::Default,
                    EntryKind::Physical => wire::PaintPaletteKind::Physical,
                    EntryKind::Mixed => wire::PaintPaletteKind::Mixed,
                },
                name: e.name.clone(),
                display_color: e.display_color.clone(),
                gradient: match &e.gradient {
                    Some(stops) => wire::OptionalTextList::Value(stops.clone()),
                    None => wire::OptionalTextList::Absent(wire::Empty {}),
                },
                badge: e.badge.clone(),
                recipe_summary: text(e.recipe_summary.as_deref()),
                keyboard_number: counter(e.keyboard_number.map(u64::from)),
                engine_slot: counter(e.engine_slot.map(|n| n as u64)),
                selectable: e.selectable,
                unavailable_reason: text(e.unavailable_reason.as_deref()),
            })
            .collect(),
        physical_count: palette.physical_count as u64,
        enabled_mixed_count: palette.enabled_mixed_count as u64,
    }
}
