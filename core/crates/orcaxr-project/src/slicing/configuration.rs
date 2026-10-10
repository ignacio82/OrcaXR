//! The project's own slicing configuration from a chosen catalog profile
//! (`web/src/workspace/CatalogSlicingConfiguration.ts`: `liveSlicingConfiguration`,
//! `nextSlicingState`, `withReconciledAutoPairs`): the profile's
//! configuration with the palette's colours, one physical filament per
//! palette slot keeping the identity the project gave that tool, and the
//! project state that configuration leads to, its setting overrides overlaid
//! and its automatic FullSpectrum pairs reconciled.
//! `slicing-configuration-vectors.json` pins every answer against the browser.
use super::choices::{
    Head, Slot, find_by_names, head_from_profile, synchronized_heads, unambiguous_scalar,
};
use crate::{
    filaments::auto_pairs,
    ids::PhysicalFilamentId,
    js_math::convert::utf16_number,
    model::{
        ConfigMap, Decode, Encode, Filaments, List, MixedFilament, PhysicalFilament, Printer,
        ProjectState,
    },
    settings::catalog::Profile,
};
use orcaxr_contracts::canonical::Value;
use std::{collections::BTreeMap, io, sync::Arc};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn field(name: &str, value: Value) -> (Vec<u16>, Value) {
    (units(name), value)
}

/// The workspace's live slicing inputs: the selected catalog profile, each
/// palette slot's filament and nozzle, and the palette.
#[derive(Debug, Clone)]
pub struct Live<'a> {
    pub profile: Option<&'a Profile>,
    pub heads: Vec<Head>,
    pub nozzles: Vec<Vec<u16>>,
    pub palette: Vec<Slot>,
}

/// `CanonicalSlicingConfiguration`: a printer, its base configuration,
/// optionally a complete replacement of the project's setting overrides, and
/// both filament lists.
#[derive(Debug, Clone, PartialEq)]
pub struct Configuration {
    pub printer: Printer,
    pub config: ConfigMap,
    pub settings_overrides: Option<ConfigMap>,
    pub physical: List<Arc<PhysicalFilament>>,
    pub mixed: List<Arc<MixedFilament>>,
}
impl Configuration {
    /// The configuration document: `printer`, `config`, `filaments` with
    /// exactly `physical` and `mixed`, and optionally `settingsOverrides`;
    /// `None` for anything else.
    pub fn from_value(value: Value) -> Option<Self> {
        let Value::Object(mut fields) = value else {
            return None;
        };
        let mut take = |name: &str| fields.remove(&units(name));
        let printer = Printer::from_value(take("printer")?).ok()?;
        let config = ConfigMap::from_value(take("config")?).ok()?;
        let settings_overrides = match take("settingsOverrides") {
            Some(value) => Some(ConfigMap::from_value(value).ok()?),
            None => None,
        };
        let Value::Object(mut filaments) = take("filaments")? else {
            return None;
        };
        if !fields.is_empty() {
            return None;
        }
        let mut list = |name: &str| filaments.remove(&units(name));
        let physical = List::<Arc<PhysicalFilament>>::from_value(list("physical")?).ok()?;
        let mixed = List::<Arc<MixedFilament>>::from_value(list("mixed")?).ok()?;
        filaments.is_empty().then_some(Self {
            printer,
            config,
            settings_overrides,
            physical,
            mixed,
        })
    }
    pub fn to_value(&self) -> io::Result<Value> {
        let mut fields = BTreeMap::from([
            field("printer", self.printer.to_value()?),
            field("config", self.config.value().clone()),
            field("filaments", self.filaments().to_value()?),
        ]);
        if let Some(overrides) = &self.settings_overrides {
            fields.insert(units("settingsOverrides"), overrides.value().clone());
        }
        Ok(Value::Object(fields))
    }
    /// The project's filaments this configuration asks for: exactly its two lists.
    fn filaments(&self) -> Filaments {
        Filaments {
            physical: self.physical.clone(),
            mixed: self.mixed.clone(),
            extra: Default::default(),
        }
    }
}

/// A choice that would leave a mixed filament's component without its
/// filament; the operator must remap it first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orphaned(pub PhysicalFilamentId);
impl Orphaned {
    /// The browser's message.
    pub fn message(&self) -> Vec<u16> {
        [
            &units("The selected profile would orphan mixed-filament component ")[..],
            self.0.as_utf16(),
            &units("; remap it before changing profiles."),
        ]
        .concat()
    }
}

fn wire_object(config: impl IntoIterator<Item = (Vec<u16>, Vec<u16>)>) -> Value {
    Value::Object(
        config
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect(),
    )
}

/// `liveSlicingConfiguration`: the exact profile/filament state canonical save
/// and slice consume. Each palette slot is a physical filament: its filament
/// is the slot's exact catalog profile for this printer and process, else the
/// catalog's first name match, else the selected profile; it keeps the
/// identity `previous` gave its tool. Mixed filaments are kept; a choice that
/// orphans one of their components is refused. Nothing without a profile.
pub fn live_configuration(
    profiles: &[Profile],
    live: &Live<'_>,
    previous: &Filaments,
) -> Result<Option<Configuration>, Orphaned> {
    let Some(profile) = live.profile else {
        return Ok(None);
    };
    let slots = &live.palette;
    let (heads, nozzles) =
        synchronized_heads(Some(profile), &live.heads, &live.nozzles, slots.len());
    let mut config = profile.config();
    let colours: Vec<u16> = slots
        .iter()
        .enumerate()
        .flat_map(|(index, slot)| {
            (index > 0)
                .then_some(u16::from(b';'))
                .into_iter()
                .chain(slot.color.iter().copied())
        })
        .collect();
    config.insert(units("filament_colour"), colours.clone());
    config.insert(units("extruder_colour"), colours);
    config.insert(units("printer_settings_id"), profile.machine_name.clone());
    config.insert(units("print_settings_id"), profile.process_name.clone());

    let mut physical = Vec::with_capacity(slots.len());
    for (index, slot) in slots.iter().enumerate() {
        let selection = heads
            .get(index)
            .cloned()
            .unwrap_or_else(|| head_from_profile(Some(profile)));
        let name = if selection.name.is_empty() {
            profile.filament_name.clone()
        } else {
            selection.name.clone()
        };
        // An empty preset ID is falsy: no exact lookup.
        let exact = selection
            .preset_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| {
                profiles.iter().find(|candidate| {
                    candidate.machine_preset_id == profile.machine_preset_id
                        && candidate.process_preset_id == profile.process_preset_id
                        && units(&candidate.filament_preset_id) == id
                })
            });
        let filament_profile = exact
            .or_else(|| {
                find_by_names(
                    profiles,
                    &profile.machine_name,
                    &profile.process_name,
                    &name,
                )
            })
            .unwrap_or(profile);
        let material = exact
            .and_then(|p| unambiguous_scalar(p.config_value("filament_type")))
            .unwrap_or_else(|| slot.kind.clone());
        let nozzle = utf16_number(nozzles.get(index).map_or(&[][..], Vec::as_slice));
        // `presetId ?? (name || undefined)`: an empty preset ID is kept.
        let preset_id = selection
            .preset_id
            .clone()
            .or_else(|| (!name.is_empty()).then(|| name.clone()));
        let id = previous
            .physical
            .iter()
            .rev()
            .find(|f| f.tool_id.get() == index as f64)
            .map_or_else(
                || units(&format!("import:live:filament-slot-{}", index + 1)),
                |f| f.id.as_utf16().to_vec(),
            );
        let mut fields = BTreeMap::from([
            field("id", Value::String(id)),
            field(
                "name",
                Value::String(if name.is_empty() {
                    units(&format!("Filament {}", index + 1))
                } else {
                    name.clone()
                }),
            ),
            field("toolId", Value::Number(index as f64)),
            field(
                "material",
                Value::String(if material.is_empty() {
                    units("Unknown")
                } else {
                    material
                }),
            ),
            field("color", Value::String(slot.color.clone())),
            field("config", wire_object(filament_profile.config())),
            field("enabled", Value::Bool(true)),
        ]);
        if let Some(preset_id) = preset_id {
            fields.insert(units("presetId"), Value::String(preset_id));
        }
        if nozzle.is_finite() && nozzle > 0.0 {
            fields.insert(units("nozzleDiameterMm"), Value::Number(nozzle));
        }
        physical.push(Arc::new(
            PhysicalFilament::from_value(Value::Object(fields))
                .expect("a live physical filament is a project record"),
        ));
    }
    let available = |id: &[u16]| {
        physical.iter().any(|f| f.id.as_utf16() == id)
            || previous.mixed.iter().any(|m| m.id.as_utf16() == id)
    };
    if let Some(component) = previous
        .mixed
        .iter()
        .flat_map(|m| m.components.iter())
        .find(|c| !available(c.filament_id.as_utf16()))
    {
        return Err(Orphaned(component.filament_id.clone()));
    }
    let printer = Printer::from_value(Value::Object(BTreeMap::from([
        field("profileId", Value::String(profile.machine_name.clone())),
        field("toolCount", Value::Number(slots.len().max(1) as f64)),
    ])))
    .expect("a live printer is a project record");
    Ok(Some(Configuration {
        printer,
        config: ConfigMap::from_value(wire_object(config))
            .expect("wire strings are a configuration"),
        settings_overrides: None,
        physical: physical.into(),
        mixed: previous.mixed.clone(),
    }))
}

/// When automatic FullSpectrum pairs regenerate: when enabled, for at most
/// four physical filaments or a count the operator confirmed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AutoPairPolicy {
    pub enabled: bool,
    pub confirmed_counts: Vec<f64>,
}
impl AutoPairPolicy {
    pub fn allowed(&self, physical: usize) -> bool {
        let count = physical as f64;
        self.enabled && (physical <= 4 || self.confirmed_counts.contains(&count))
    }
}

/// Fresh identities for new automatic pairs ([`auto_pairs::Allocator`]).
pub use auto_pairs::Allocator;

/// `withReconciledAutoPairs`: `state` with its automatic pairs reconciled,
/// when the policy allows them. The caller validates the result.
pub fn with_reconciled_auto_pairs<E>(
    mut state: ProjectState,
    policy: &AutoPairPolicy,
    allocate: &mut Allocator<'_, E>,
) -> Result<ProjectState, auto_pairs::Error<E>> {
    if !policy.allowed(state.filaments.physical.len()) {
        return Ok(state);
    }
    let reconciliation = auto_pairs::reconcile(&state.filaments, allocate)?;
    if reconciliation.changed {
        let mut filaments = state.filaments.clone();
        filaments.mixed = reconciliation.filaments;
        state.filaments = filaments;
    }
    Ok(state)
}

fn object(map: &BTreeMap<Vec<u16>, Value>) -> Value {
    Value::Object(map.clone())
}
fn config_map(config: &ConfigMap) -> &BTreeMap<Vec<u16>, Value> {
    match config.value() {
        Value::Object(map) => map,
        _ => unreachable!("a configuration is an object"),
    }
}

/// `nextSlicingState` before validation: the state `configuration` leads to,
/// or `None` when it is the current one. Without `settingsOverrides` the
/// project's own overrides are kept and overlaid on the configuration; with
/// them they are replaced. The printer and filament records are replaced
/// whole. The caller validates the result (`assertValidProjectState`).
pub fn next_state<E>(
    state: &ProjectState,
    configuration: &Configuration,
    policy: &AutoPairPolicy,
    allocate: &mut Allocator<'_, E>,
) -> io::Result<Result<Option<ProjectState>, auto_pairs::Error<E>>> {
    let submits = configuration.settings_overrides.is_some();
    let empty = BTreeMap::new();
    let overrides = match (&configuration.settings_overrides, &state.settings_overrides) {
        (Some(overrides), _) | (None, Some(overrides)) => config_map(overrides),
        (None, None) => &empty,
    };
    let base = config_map(&configuration.config);
    let mut effective = base.clone();
    effective.extend(overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
    let filaments = configuration.filaments();
    let unchanged = state.printer.to_value()? == configuration.printer.to_value()?
        && config_map(state.settings_base_config.as_ref().unwrap_or(&state.config)) == base
        && *config_map(&state.config) == effective
        && state.settings_overrides.as_ref().map_or(&empty, config_map) == overrides
        && state.filaments.to_value()? == filaments.to_value()?;
    if unchanged {
        return Ok(Ok(None));
    }
    let as_config = |map: &BTreeMap<Vec<u16>, Value>| {
        ConfigMap::from_value(object(map)).expect("a configuration object stays one")
    };
    let mut next = state.clone();
    next.printer = configuration.printer.clone();
    next.config = as_config(&effective);
    if submits || state.settings_base_config.is_some() || state.settings_overrides.is_some() {
        next.settings_base_config = Some(configuration.config.clone());
    }
    if submits {
        next.settings_overrides = Some(as_config(overrides));
    }
    next.filaments = filaments;
    Ok(with_reconciled_auto_pairs(next, policy, allocate).map(Some))
}

/// What staging a session's live choice did
/// ([`ProjectSession::stage_slicing_configuration`](crate::session::ProjectSession::stage_slicing_configuration)).
#[derive(Debug)]
pub enum Stage<E> {
    /// One "Update slicing configuration" replacement, staged for `executeStaged`.
    Staged(u64),
    /// No profile is selected, or the project already has this configuration.
    Unchanged,
    Orphaned(Orphaned),
    AutoPairs(auto_pairs::Error<E>),
}

/// `commitLiveSlicingConfiguration` before validation: the configuration a
/// live choice describes against `state`, and the state it leads to.
pub fn commit_state<E>(
    state: &ProjectState,
    profiles: &[Profile],
    live: &Live<'_>,
    policy: &AutoPairPolicy,
    allocate: &mut Allocator<'_, E>,
) -> io::Result<Result<ProjectState, Stage<E>>> {
    let configuration = match live_configuration(profiles, live, &state.filaments) {
        Err(orphaned) => return Ok(Err(Stage::Orphaned(orphaned))),
        Ok(None) => return Ok(Err(Stage::Unchanged)),
        Ok(Some(configuration)) => configuration,
    };
    Ok(match next_state(state, &configuration, policy, allocate)? {
        Err(error) => Err(Stage::AutoPairs(error)),
        Ok(None) => Err(Stage::Unchanged),
        Ok(Some(next)) => Ok(next),
    })
}
