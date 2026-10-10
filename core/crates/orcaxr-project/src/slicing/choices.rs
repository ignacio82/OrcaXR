//! Choosing catalog profiles (`web/src/workspace/CatalogSlicingConfiguration.ts`):
//! the pickers' preset choices and their disambiguated labels, matching a
//! typed name, the catalog's default triple, reconciling a selection into one
//! exact profile per filament slot with the operator's messages, and the
//! workspace's per-slot state after a selection applies.
//! `slicing-configuration-vectors.json` pins every answer against the browser.
use crate::{
    js_math::{
        case::lower,
        convert::{decode_uri_component, json_stringify, trim_utf16, utf16_number},
    },
    settings::{
        catalog::{Profile, ProfileCatalog},
        presets::{Kind, Selection, SelectionRequest as PresetRequest},
    },
};
use orcaxr_contracts::canonical::Value;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn concat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
/// A preset ID as UTF-16; catalog IDs are percent-encoded ASCII.
pub(crate) fn id_units(id: &str) -> Vec<u16> {
    units(id)
}
/// `a.includes(b)` over UTF-16.
fn includes(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

// --- Choices ---------------------------------------------------------------------------------

/// `WorkspacePresetOption`: a preset's ID, exact name and picker label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetOption {
    pub id: Vec<u16>,
    pub name: Vec<u16>,
    pub label: Vec<u16>,
}

/// Distinct options by ID, the first occurrence kept, in catalog order.
fn distinct(options: impl Iterator<Item = PresetOption>) -> Vec<PresetOption> {
    let mut out: Vec<PresetOption> = Vec::new();
    for option in options {
        if !out.iter().any(|seen| seen.id == option.id) {
            out.push(option);
        }
    }
    disambiguate(out)
}

/// `machinePresetChoices`: complete printers in deterministic catalog order.
pub fn machine_choices(profiles: &[Profile]) -> Vec<PresetOption> {
    distinct(profiles.iter().map(|p| PresetOption {
        id: id_units(&p.machine_preset_id),
        name: p.machine_name.clone(),
        label: p.machine_name.clone(),
    }))
}

/// `processPresetChoices`: the processes of one exact printer; none without one.
pub fn process_choices(profiles: &[Profile], machine: Option<&[u16]>) -> Vec<PresetOption> {
    let Some(machine) = machine.filter(|m| !m.is_empty()) else {
        return Vec::new();
    };
    distinct(
        profiles
            .iter()
            .filter(|p| id_units(&p.machine_preset_id) == machine)
            .map(|p| PresetOption {
                id: id_units(&p.process_preset_id),
                name: p.process_name.clone(),
                label: p.process_name.clone(),
            }),
    )
}

/// `filamentPresetChoices`: the filaments of one exact printer/process pair.
pub fn filament_choices(
    profiles: &[Profile],
    machine: Option<&[u16]>,
    process: Option<&[u16]>,
) -> Vec<PresetOption> {
    let (Some(machine), Some(process)) = (
        machine.filter(|m| !m.is_empty()),
        process.filter(|p| !p.is_empty()),
    ) else {
        return Vec::new();
    };
    distinct(
        profiles
            .iter()
            .filter(|p| {
                id_units(&p.machine_preset_id) == machine
                    && id_units(&p.process_preset_id) == process
            })
            .map(|p| PresetOption {
                id: id_units(&p.filament_preset_id),
                name: p.filament_preset_name.clone(),
                label: p.filament_name.clone(),
            }),
    )
}

/// `disambiguatePresetOptionLabels`: a label several options share becomes
/// the option's name, or, when the name is shared too, the name and the
/// vendor its ID encodes.
pub fn disambiguate(options: Vec<PresetOption>) -> Vec<PresetOption> {
    let count = |pick: fn(&PresetOption) -> &[u16], value: &[u16]| {
        options.iter().filter(|o| pick(o) == value).count()
    };
    let labels: Vec<usize> = options
        .iter()
        .map(|o| count(|o| &o.label, &o.label))
        .collect();
    let names: Vec<usize> = options
        .iter()
        .map(|o| count(|o| &o.name, &o.name))
        .collect();
    options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            if labels[index] == 1 {
                return option.clone();
            }
            let label = if names[index] == 1 {
                option.name.clone()
            } else {
                let vendor = vendor_name(&option.id).unwrap_or_else(|| units("another vendor"));
                concat(&[&option.name, &units(" \u{2014} "), &vendor])
            };
            PresetOption {
                label,
                ..option.clone()
            }
        })
        .collect()
}

/// `presetVendorName`: the decoded second `:` segment of a preset ID.
fn vendor_name(id: &[u16]) -> Option<Vec<u16>> {
    let segment = id.split(|u| *u == u16::from(b':')).nth(1)?;
    if segment.is_empty() {
        return None;
    }
    decode_uri_component(segment)
}

/// `matchPresetOption`: a unique exact label, else a unique exact name, else
/// the one option whose name or label contains the query, ignoring case.
pub fn match_option<'a>(options: &'a [PresetOption], query: &[u16]) -> Option<&'a PresetOption> {
    let normalized = lower(trim_utf16(query));
    if normalized.is_empty() {
        return None;
    }
    type Lowered = (Vec<u16>, Vec<u16>);
    let lowered: Vec<Lowered> = options
        .iter()
        .map(|o| (lower(&o.label), lower(&o.name)))
        .collect();
    let unique = |test: &dyn Fn(&Lowered) -> bool| {
        let mut found = lowered.iter().enumerate().filter(|(_, l)| test(l));
        match (found.next(), found.next()) {
            (Some((index, _)), None) => Some(&options[index]),
            _ => None,
        }
    };
    unique(&|(label, _)| *label == normalized)
        .or_else(|| unique(&|(_, name)| *name == normalized))
        .or_else(|| {
            unique(&|(label, name)| includes(name, &normalized) || includes(label, &normalized))
        })
}

/// `ProfileCatalog.find`: the first profile whose machine, process and
/// filament names contain the lower-cased parts.
pub fn find_by_names<'a>(
    profiles: &'a [Profile],
    machine: &[u16],
    process: &[u16],
    filament: &[u16],
) -> Option<&'a Profile> {
    let (m, p, f) = (lower(machine), lower(process), lower(filament));
    profiles.iter().find(|x| {
        includes(&lower(&x.machine_name), &m)
            && includes(&lower(&x.process_name), &p)
            && includes(&lower(&x.filament_name), &f)
    })
}

/// The catalog triple a new document starts from, by name.
pub const DEFAULT_PROFILE: [&str; 3] = [
    "Snapmaker U1 (0.4 nozzle)",
    "0.20 Standard",
    "Snapmaker PLA",
];

/// `catalogDefaultProfile`: the default triple, else the first profile.
pub fn default_profile(profiles: &[Profile]) -> Option<&Profile> {
    let [machine, process, filament] = DEFAULT_PROFILE.map(units);
    find_by_names(profiles, &machine, &process, &filament).or_else(|| profiles.first())
}

// --- Profile facts ---------------------------------------------------------------------------

/// `unambiguousProfileScalar`: one trimmed scalar, not a list.
pub fn unambiguous_scalar(value: Option<&[u16]>) -> Option<Vec<u16>> {
    let value = value?;
    let trimmed = trim_utf16(value);
    if trimmed.is_empty()
        || value
            .iter()
            .any(|u| *u == u16::from(b';') || *u == u16::from(b','))
    {
        return None;
    }
    Some(trimmed.to_vec())
}

/// `profileNozzleForTool`: the tool's positive nozzle diameter as written,
/// the only one of a single-extruder multi-material printer, else `0.4`.
pub fn nozzle_for_tool(profile: Option<&Profile>, tool: usize) -> Vec<u16> {
    let nozzles: Option<Vec<Vec<u16>>> = profile
        .and_then(|p| p.config_value("nozzle_diameter"))
        .map(|value| {
            value
                .split(|u| *u == u16::from(b';') || *u == u16::from(b','))
                .map(trim_utf16)
                .filter(|v| {
                    let n = utf16_number(v);
                    n.is_finite() && n > 0.0
                })
                .map(<[u16]>::to_vec)
                .collect()
        });
    if let Some(nozzle) = nozzles.as_ref().and_then(|n| n.get(tool)) {
        return nozzle.clone();
    }
    let single =
        unambiguous_scalar(profile.and_then(|p| p.config_value("single_extruder_multi_material")))
            .map(|v| lower(&v))
            .is_some_and(|v| v == units("1") || v == units("true"));
    match nozzles {
        Some(n) if n.len() == 1 && single => n[0].clone(),
        _ => units("0.4"),
    }
}

/// `profileExtruderCount`: one per `nozzle_diameter` entry, at least one.
pub fn extruder_count(profile: Option<&Profile>) -> usize {
    match profile.and_then(|p| p.config_value("nozzle_diameter")) {
        Some(value) if !value.is_empty() => {
            value.iter().filter(|u| **u == u16::from(b',')).count() + 1
        }
        _ => 1,
    }
}

/// `HeadFilamentSelection`: one slot's filament, by exact preset when it has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub preset_id: Option<Vec<u16>>,
    pub name: Vec<u16>,
}

/// `headSelectionFromProfile`: a slot holding the profile's own filament.
pub fn head_from_profile(profile: Option<&Profile>) -> Head {
    match profile {
        None => Head {
            preset_id: None,
            name: Vec::new(),
        },
        Some(p) => Head {
            preset_id: Some(id_units(&p.filament_preset_id)).filter(|id| !id.is_empty()),
            name: p.filament_name.clone(),
        },
    }
}

/// `FilamentSlot`: a palette slot's colour and filament type label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub color: Vec<u16>,
    pub kind: Vec<u16>,
}

/// `FILAMENT_PALETTE_MAX_SLOTS`.
pub const MAX_SLOTS: usize = 16;
/// `NEW_FILAMENT_SLOT`.
pub fn new_slot() -> Slot {
    Slot {
        color: units("#cccccc"),
        kind: units("PLA"),
    }
}

/// `LiveProfileSlots`: the palette and each slot's filament and nozzle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slots {
    pub palette: Vec<Slot>,
    pub heads: Vec<Head>,
    pub nozzles: Vec<Vec<u16>>,
}

/// `resolvedProfileSlots`: the palette grows to the profile's extruders,
/// never past its limit; each slot takes its reconciled filament or the
/// profile's own, and its nozzle from the profile.
pub fn resolved_slots(profile: &Profile, resolved: &[Head], palette: &[Slot]) -> Slots {
    let count = extruder_count(Some(profile));
    let mut slots = palette.to_vec();
    while slots.len() < count && slots.len() < MAX_SLOTS {
        slots.push(new_slot());
    }
    let heads = (0..slots.len())
        .map(|index| {
            resolved
                .get(index)
                .cloned()
                .unwrap_or_else(|| head_from_profile(Some(profile)))
        })
        .collect();
    let nozzles = (0..slots.len())
        .map(|tool| nozzle_for_tool(Some(profile), tool))
        .collect();
    Slots {
        palette: slots,
        heads,
        nozzles,
    }
}

/// `synchronizedHeadSlots`: each palette slot's filament and nozzle; extra
/// ones dropped, missing ones the profile's.
pub fn synchronized_heads(
    profile: Option<&Profile>,
    heads: &[Head],
    nozzles: &[Vec<u16>],
    count: usize,
) -> (Vec<Head>, Vec<Vec<u16>>) {
    let mut next_heads = heads[..heads.len().min(count)].to_vec();
    let mut next_nozzles = nozzles[..nozzles.len().min(count)].to_vec();
    while next_heads.len() < count {
        next_heads.push(head_from_profile(profile));
    }
    while next_nozzles.len() < count {
        next_nozzles.push(nozzle_for_tool(profile, next_nozzles.len()));
    }
    (next_heads, next_nozzles)
}

// --- Selection -------------------------------------------------------------------------------

names!(
    /// `WorkspaceProfileSelectionFeedback['severity']`.
    Severity {
        Info => "info",
        Warning => "warning",
        Error => "error",
    }
);

/// `WorkspaceProfileSelectionFeedback`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feedback {
    pub applied: bool,
    pub severity: Severity,
    pub messages: Vec<Vec<u16>>,
}

/// `WorkspaceProfileSelectionRequest`: what to change; absent parts keep the
/// current choice. A `None` filament names no preset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionRequest {
    pub machine: Option<Vec<u16>>,
    pub process: Option<Vec<u16>>,
    pub filaments: Option<Vec<Option<Vec<u16>>>>,
}

/// `ProfileSelectionOutcome`: what to tell the operator and, when it
/// applies, one exact profile per reconciled filament slot, primary first.
#[derive(Debug, Clone)]
pub struct Outcome<'a> {
    pub feedback: Feedback,
    pub profiles: Option<Vec<&'a Profile>>,
}

fn refused<'a>(messages: Vec<Vec<u16>>) -> Outcome<'a> {
    Outcome {
        feedback: Feedback {
            applied: false,
            severity: Severity::Error,
            messages,
        },
        profiles: None,
    }
}

/// `ProfileCatalog.reconcileSelection`'s refusal for a catalog that did not load.
pub const CATALOG_UNAVAILABLE: &str = "The profile catalog has not loaded or failed validation.";

/// `resolveProfileSelection`: reconcile exact graph identities and accept
/// only a complete printer/process/all-slot result; substitutions are
/// reported. `catalog` is `None` when the catalog did not load.
pub fn resolve<'a>(
    catalog: Option<&'a ProfileCatalog>,
    current: Option<&Profile>,
    heads: &[Head],
    request: &SelectionRequest,
) -> Outcome<'a> {
    let lossy = |id: &[u16]| String::from_utf16_lossy(id);
    let machine = request
        .machine
        .clone()
        .or_else(|| current.map(|p| id_units(&p.machine_preset_id)));
    let Some(machine) = machine.filter(|m| !m.is_empty()) else {
        return refused(vec![units(
            "Choose an available printer before selecting process or filament presets.",
        )]);
    };
    let process = request
        .process
        .clone()
        .or_else(|| current.map(|p| id_units(&p.process_preset_id)));
    let filaments: Vec<Option<Vec<u16>>> = request
        .filaments
        .clone()
        .unwrap_or_else(|| heads.iter().map(|h| h.preset_id.clone()).collect());
    let preset_request = PresetRequest {
        printer_id: lossy(&machine),
        process_id: process.filter(|p| !p.is_empty()).map(|p| lossy(&p)),
        filament_ids: filaments.iter().map(|f| f.as_deref().map(lossy)).collect(),
        installed_vendors: None,
    };
    let resolution = match catalog {
        None => Err(CATALOG_UNAVAILABLE),
        Some(catalog) => catalog.reconcile(&preset_request),
    };
    let resolved = match resolution {
        Ok(selection) => selection,
        Err(reason) => return refused(vec![units(reason)]),
    };
    let profiles: &'a [Profile] = catalog.map_or(&[], ProfileCatalog::profiles);
    let messages = reconciliation_messages(profiles, &resolved);
    if !resolved.complete
        || resolved.process.is_none()
        || resolved.filaments.iter().any(Option::is_none)
    {
        return refused(if messages.is_empty() {
            vec![units(
                "No complete compatible process and filament selection exists for this printer.",
            )]
        } else {
            messages
        });
    }
    let process_id = resolved.process.as_ref().map(|p| p.id.as_str());
    let exact: Vec<Option<&'a Profile>> = resolved
        .filaments
        .iter()
        .map(|filament| {
            let filament = filament.as_ref()?;
            profiles.iter().find(|p| {
                p.machine_preset_id == resolved.printer.id
                    && Some(p.process_preset_id.as_str()) == process_id
                    && p.filament_preset_id == filament.id
            })
        })
        .collect();
    if exact.first().is_none_or(Option::is_none) || exact.iter().any(Option::is_none) {
        return refused(vec![units(
            "The resolver produced a combination that is absent from the validated slicing catalog; the prior selection was preserved.",
        )]);
    }
    let warned = !messages.is_empty();
    Outcome {
        feedback: Feedback {
            applied: true,
            severity: if warned {
                Severity::Warning
            } else {
                Severity::Info
            },
            messages: if warned {
                messages
            } else {
                vec![units("Profile selection is compatible.")]
            },
        },
        profiles: Some(exact.into_iter().flatten().collect()),
    }
}

/// `profileReconciliationMessages`, distinct in first-occurrence order.
fn reconciliation_messages(profiles: &[Profile], resolved: &Selection) -> Vec<Vec<u16>> {
    let printer = &resolved.printer.name;
    let process = resolved
        .process
        .as_ref()
        .map_or_else(|| units("the selected process"), |p| p.name.clone());
    let mut messages: Vec<Vec<u16>> = Vec::new();
    for substitution in &resolved.substitutions {
        // An empty ID or display name is falsy in the browser.
        let named = |id: &Option<String>| {
            id.as_deref()
                .filter(|id| !id.is_empty())
                .map(|id| display_name(profiles, substitution.kind, id))
                .filter(|name| !name.is_empty())
        };
        let next = named(&substitution.next_id);
        let previous = named(&substitution.previous_id);
        if substitution.kind == Kind::Process {
            messages.push(match (next, previous) {
                (Some(next), Some(previous)) => concat(&[
                    &previous,
                    &units(" is unavailable for "),
                    printer,
                    &units("; substituted "),
                    &next,
                    &units("."),
                ]),
                (Some(next), None) => concat(&[
                    &units("Selected "),
                    &next,
                    &units(" for "),
                    printer,
                    &units("."),
                ]),
                (None, _) => concat(&[
                    &units("No compatible process preset is available for "),
                    printer,
                    &units("."),
                ]),
            });
            continue;
        }
        let slot = units(&format!(
            "Filament slot {}",
            substitution.slot.unwrap_or(0) + 1
        ));
        messages.push(match (next, previous) {
            (Some(next), Some(previous)) => concat(&[
                &slot,
                &units(": "),
                &previous,
                &units(" is unavailable for "),
                printer,
                &units(" / "),
                &process,
                &units("; substituted "),
                &next,
                &units("."),
            ]),
            (Some(next), None) => concat(&[&slot, &units(": selected "), &next, &units(".")]),
            (None, _) => concat(&[
                &slot,
                &units(": no compatible filament preset is available for "),
                printer,
                &units(" / "),
                &process,
                &units("."),
            ]),
        });
    }
    messages.extend(resolved.diagnostics.iter().map(|d| d.message.clone()));
    let mut distinct: Vec<Vec<u16>> = Vec::with_capacity(messages.len());
    for message in messages {
        if !distinct.contains(&message) {
            distinct.push(message);
        }
    }
    distinct
}

/// `presetDisplayName`: the first catalog profile's name for a preset.
fn display_name(profiles: &[Profile], kind: Kind, id: &str) -> Vec<u16> {
    let profile = profiles.iter().find(|p| {
        if kind == Kind::Process {
            p.process_preset_id == id
        } else {
            p.filament_preset_id == id
        }
    });
    match profile {
        None => units("The previous preset"),
        Some(p) if kind == Kind::Process => p.process_name.clone(),
        Some(p) => p.filament_preset_name.clone(),
    }
}

/// `resolveProfileSelectionByNames`: printer, process and primary filament as
/// typed (blank keeps the current one), matched against the pickers'
/// choices, then reconciled like any other selection.
pub fn resolve_by_names<'a>(
    catalog: Option<&'a ProfileCatalog>,
    current: Option<&Profile>,
    heads: &[Head],
    machine: &[u16],
    process: &[u16],
    filament: &[u16],
) -> Outcome<'a> {
    let profiles: &[Profile] = catalog.map_or(&[], ProfileCatalog::profiles);
    let quoted = |text: &[u16]| json_stringify(&Value::String(text.to_vec()));
    let blank = |text: &[u16]| trim_utf16(text).is_empty();
    let machines = machine_choices(profiles);
    let machine_option = (!blank(machine))
        .then(|| match_option(&machines, machine))
        .flatten();
    if !blank(machine) && machine_option.is_none() {
        return refused(vec![concat(&[
            &units("Printer preset "),
            &quoted(machine),
            &units(" is unavailable."),
        ])]);
    }
    let machine_id = machine_option
        .map(|o| o.id.clone())
        .or_else(|| current.map(|p| id_units(&p.machine_preset_id)));
    let processes = process_choices(profiles, machine_id.as_deref());
    let process_option = (!blank(process))
        .then(|| match_option(&processes, process))
        .flatten();
    if !blank(process) && process_option.is_none() {
        return refused(vec![concat(&[
            &units("Process preset "),
            &quoted(process),
            &units(" is unavailable for the selected printer."),
        ])]);
    }
    let process_id = process_option
        .map(|o| o.id.clone())
        .or_else(|| current.map(|p| id_units(&p.process_preset_id)));
    let filaments = filament_choices(profiles, machine_id.as_deref(), process_id.as_deref());
    let filament_option = (!blank(filament))
        .then(|| match_option(&filaments, filament))
        .flatten();
    if !blank(filament) && filament_option.is_none() {
        return refused(vec![concat(&[
            &units("Filament preset "),
            &quoted(filament),
            &units(" is unavailable for the selected printer and process."),
        ])]);
    }
    let mut filament_ids: Vec<Option<Vec<u16>>> =
        heads.iter().map(|h| h.preset_id.clone()).collect();
    if let Some(option) = filament_option {
        // `filamentPresetIds[0] = …` grows an empty list to one entry.
        if filament_ids.is_empty() {
            filament_ids.push(None);
        }
        filament_ids[0] = Some(option.id.clone());
    }
    resolve(
        catalog,
        current,
        heads,
        &SelectionRequest {
            machine: machine_id.filter(|id| !id.is_empty()),
            process: process_id.filter(|id| !id.is_empty()),
            filaments: Some(filament_ids),
        },
    )
}
