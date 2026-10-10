//! The hosts' contract for turning a chosen catalog profile into the project's
//! own slicing configuration (`CatalogSlicingConfigurationExchange.ts`): each
//! request and reply is a canonical JSON document, answered by
//! [`super::choices`] and [`super::configuration`] exactly as the browser
//! answers it, and a session commits the result as one undoable
//! "Update slicing configuration" project replacement.
//!
//! A live choice is `{"profile": {"machinePresetId","processPresetId",
//! "filamentPresetId"} | null, "heads": [{"name","presetId"?}], "nozzles":
//! [text], "palette": [{"color","type"}]}`; a profile the catalog no longer
//! holds reads as none. States and configurations travel as canonical JSON
//! text. A malformed request is refused as `invalid_request`.
use super::{
    choices::{self, Head, Outcome, PresetOption, SelectionRequest, Slot},
    configuration::{self, AutoPairPolicy, Configuration, Live},
};
use crate::{
    filaments::auto_pairs::{self, Allocation, stable_numeric_id},
    ids::{IdSource, MixedFilamentId, UuidIdSource},
    model::{Decode, Encode, ProjectData, ProjectState},
    session::ProjectSession,
    settings::catalog::{Profile, ProfileCatalog},
    validation::{AdmissionError, TimestampPolicy, ValidatedProject},
};
use orcaxr_contracts::{
    canonical::{Value, parse},
    project_intent_types::SessionError,
};
use std::collections::BTreeMap;

/// The largest text a request may be: the canonical parser's bound.
pub const MAX_EXCHANGE_BYTES: usize = orcaxr_contracts::generated::MAX_INPUT_BYTES;
/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than [`MAX_EXCHANGE_BYTES`].
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";
/// The host's timestamp service failed while a state was validated.
pub const TIMESTAMP_FAILED: &str = "timestamp_failed";
/// The message of a configuration whose new filament identities ran out of host words.
pub const IDS_EXHAUSTED_MESSAGE: &str =
    "Too few random words were supplied for new filament identities.";
/// The label of a committed configuration.
pub const COMMIT_LABEL: &str = "Update slicing configuration";

type Fields = BTreeMap<Vec<u16>, Value>;
type Answer = Result<String, &'static str>;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn text(value: &str) -> Value {
    Value::String(units(value))
}
fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > MAX_EXCHANGE_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
/// An object with exactly the `required` members and any of the `optional` ones.
fn object(value: Value, required: &[&str], optional: &[&str]) -> Result<Fields, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| {
        required
            .iter()
            .chain(optional)
            .any(|name| name.encode_utf16().eq(key.iter().copied()))
    };
    if !fields.keys().all(known)
        || !required
            .iter()
            .all(|name| fields.contains_key(&units(name)))
    {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut Fields, name: &str) -> Option<Value> {
    fields.remove(&units(name))
}
fn string(value: Option<Value>) -> Result<Vec<u16>, &'static str> {
    match value {
        Some(Value::String(units)) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn list(value: Option<Value>) -> Result<Vec<Value>, &'static str> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(INVALID_REQUEST),
    }
}
fn canonical(value: &Value) -> Answer {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}
fn answer(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Answer {
    canonical(&Value::Object(
        fields.into_iter().map(|(k, v)| (units(k), v)).collect(),
    ))
}
fn refusal(code: &str, message: Vec<u16>) -> Answer {
    answer([("error", text(code)), ("message", Value::String(message))])
}
fn profiles(catalog: Option<&ProfileCatalog>) -> &[Profile] {
    catalog.map_or(&[], ProfileCatalog::profiles)
}

// --- Documents -------------------------------------------------------------------------------

fn option_of(value: Value) -> Result<PresetOption, &'static str> {
    let mut fields = object(value, &["id", "label", "name"], &[])?;
    Ok(PresetOption {
        id: string(take(&mut fields, "id"))?,
        name: string(take(&mut fields, "name"))?,
        label: string(take(&mut fields, "label"))?,
    })
}
fn option_value(option: &PresetOption) -> Value {
    Value::Object(BTreeMap::from([
        (units("id"), Value::String(option.id.clone())),
        (units("label"), Value::String(option.label.clone())),
        (units("name"), Value::String(option.name.clone())),
    ]))
}
fn options_value(options: &[PresetOption]) -> Value {
    Value::Array(options.iter().map(option_value).collect())
}
fn profile_of(
    profiles: &[Profile],
    value: Option<Value>,
) -> Result<Option<&Profile>, &'static str> {
    let value = value.ok_or(INVALID_REQUEST)?;
    if value == Value::Null {
        return Ok(None);
    }
    let mut fields = object(
        value,
        &["filamentPresetId", "machinePresetId", "processPresetId"],
        &[],
    )?;
    let machine = string(take(&mut fields, "machinePresetId"))?;
    let process = string(take(&mut fields, "processPresetId"))?;
    let filament = string(take(&mut fields, "filamentPresetId"))?;
    Ok(profiles.iter().find(|p| {
        units(&p.machine_preset_id) == machine
            && units(&p.process_preset_id) == process
            && units(&p.filament_preset_id) == filament
    }))
}
fn head_of(value: Value) -> Result<Head, &'static str> {
    let mut fields = object(value, &["name"], &["presetId"])?;
    let preset_id = match take(&mut fields, "presetId") {
        Some(value) => Some(string(Some(value))?),
        None => None,
    };
    Ok(Head {
        preset_id,
        name: string(take(&mut fields, "name"))?,
    })
}
fn slot_of(value: Value) -> Result<Slot, &'static str> {
    let mut fields = object(value, &["color", "type"], &[])?;
    Ok(Slot {
        color: string(take(&mut fields, "color"))?,
        kind: string(take(&mut fields, "type"))?,
    })
}
/// A live choice document, its profile looked up in `profiles`.
pub fn live_of<'a>(profiles: &'a [Profile], value: Value) -> Result<Live<'a>, &'static str> {
    let mut fields = object(value, &["heads", "nozzles", "palette", "profile"], &[])?;
    Ok(Live {
        profile: profile_of(profiles, take(&mut fields, "profile"))?,
        heads: list(take(&mut fields, "heads"))?
            .into_iter()
            .map(head_of)
            .collect::<Result<_, _>>()?,
        nozzles: list(take(&mut fields, "nozzles"))?
            .into_iter()
            .map(|n| string(Some(n)))
            .collect::<Result<_, _>>()?,
        palette: list(take(&mut fields, "palette"))?
            .into_iter()
            .map(slot_of)
            .collect::<Result<_, _>>()?,
    })
}
fn live_value(
    profile: Option<&Profile>,
    heads: &[Head],
    nozzles: &[Vec<u16>],
    palette: &[Slot],
) -> Value {
    let profile = match profile {
        None => Value::Null,
        Some(p) => Value::Object(BTreeMap::from([
            (units("filamentPresetId"), text(&p.filament_preset_id)),
            (units("machinePresetId"), text(&p.machine_preset_id)),
            (units("processPresetId"), text(&p.process_preset_id)),
        ])),
    };
    let heads = heads
        .iter()
        .map(|head| {
            let mut fields = BTreeMap::from([(units("name"), Value::String(head.name.clone()))]);
            if let Some(id) = &head.preset_id {
                fields.insert(units("presetId"), Value::String(id.clone()));
            }
            Value::Object(fields)
        })
        .collect();
    let palette = palette
        .iter()
        .map(|slot| {
            Value::Object(BTreeMap::from([
                (units("color"), Value::String(slot.color.clone())),
                (units("type"), Value::String(slot.kind.clone())),
            ]))
        })
        .collect();
    Value::Object(BTreeMap::from([
        (units("heads"), Value::Array(heads)),
        (
            units("nozzles"),
            Value::Array(nozzles.iter().cloned().map(Value::String).collect()),
        ),
        (units("palette"), Value::Array(palette)),
        (units("profile"), profile),
    ]))
}
/// A selection's reply: its feedback and, when it applied, the live choice
/// that results from the palette `live` held.
fn selection_reply(outcome: &Outcome<'_>, live: &Live<'_>) -> Answer {
    let feedback = Value::Object(BTreeMap::from([
        (units("applied"), Value::Bool(outcome.feedback.applied)),
        (
            units("messages"),
            Value::Array(
                outcome
                    .feedback
                    .messages
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        ),
        (units("severity"), text(outcome.feedback.severity.as_str())),
    ]));
    let Some(selected) = &outcome.profiles else {
        return answer([("feedback", feedback)]);
    };
    let profile = selected[0];
    let heads: Vec<Head> = selected
        .iter()
        .map(|p| choices::head_from_profile(Some(p)))
        .collect();
    let slots = choices::resolved_slots(profile, &heads, &live.palette);
    answer([
        ("feedback", feedback),
        (
            "live",
            live_value(Some(profile), &slots.heads, &slots.nozzles, &slots.palette),
        ),
    ])
}
/// A state document, decoded and admitted under `timestamps`.
fn state_of<P: TimestampPolicy>(
    value: Option<Value>,
    timestamps: &mut P,
) -> Result<ProjectState, &'static str> {
    let state = ProjectState::from_value(read(
        &String::from_utf16(&string(value)?).map_err(|_| INVALID_REQUEST)?,
    )?)
    .map_err(|_| INVALID_REQUEST)?;
    let data = ProjectData::new(state).map_err(|_| INVALID_REQUEST)?;
    match ValidatedProject::new(data, timestamps) {
        Ok(project) => Ok(project.state().clone()),
        Err(AdmissionError::Timestamp(_)) => Err(TIMESTAMP_FAILED),
        Err(AdmissionError::Invalid(_)) => Err(INVALID_REQUEST),
    }
}

// --- Exchanges -------------------------------------------------------------------------------

/// `{"machinePresetId"?, "processPresetId"?}` → `{"filaments","machines","processes"}`.
pub fn choices_json(catalog: Option<&ProfileCatalog>, request: &str) -> Answer {
    let mut fields = object(read(request)?, &[], &["machinePresetId", "processPresetId"])?;
    let machine = take(&mut fields, "machinePresetId")
        .map(|v| string(Some(v)))
        .transpose()?;
    let process = take(&mut fields, "processPresetId")
        .map(|v| string(Some(v)))
        .transpose()?;
    let profiles = profiles(catalog);
    // `profileExtruderCount` of the printer's first profile: its machine config is shared.
    let printer = machine
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| {
            profiles
                .iter()
                .find(|p| choices::id_units(&p.machine_preset_id) == id)
        });
    answer([
        (
            "extruders",
            Value::Number(choices::extruder_count(printer) as f64),
        ),
        (
            "machines",
            options_value(&choices::machine_choices(profiles)),
        ),
        (
            "processes",
            options_value(&choices::process_choices(profiles, machine.as_deref())),
        ),
        (
            "filaments",
            options_value(&choices::filament_choices(
                profiles,
                machine.as_deref(),
                process.as_deref(),
            )),
        ),
    ])
}

/// `{"options","query"}` → `{"option": option | null}`.
pub fn match_json(request: &str) -> Answer {
    let mut fields = object(read(request)?, &["options", "query"], &[])?;
    let options = list(take(&mut fields, "options"))?
        .into_iter()
        .map(option_of)
        .collect::<Result<Vec<_>, _>>()?;
    let query = string(take(&mut fields, "query"))?;
    answer([(
        "option",
        choices::match_option(&options, &query).map_or(Value::Null, option_value),
    )])
}

/// `{"live","request":{"machinePresetId"?,"processPresetId"?,"filamentPresetIds"?}}`
/// → `{"feedback":{"applied","messages","severity"},"live"?}`.
pub fn select_json(catalog: Option<&ProfileCatalog>, request: &str) -> Answer {
    let profiles = profiles(catalog);
    let mut fields = object(read(request)?, &["live", "request"], &[])?;
    let live = live_of(profiles, take(&mut fields, "live").ok_or(INVALID_REQUEST)?)?;
    let mut wanted = object(
        take(&mut fields, "request").ok_or(INVALID_REQUEST)?,
        &[],
        &["filamentPresetIds", "machinePresetId", "processPresetId"],
    )?;
    let filaments = match take(&mut wanted, "filamentPresetIds") {
        None => None,
        Some(value) => Some(
            list(Some(value))?
                .into_iter()
                .map(|id| match id {
                    Value::Null => Ok(None),
                    other => string(Some(other)).map(Some),
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
    };
    let request = SelectionRequest {
        machine: take(&mut wanted, "machinePresetId")
            .map(|v| string(Some(v)))
            .transpose()?,
        process: take(&mut wanted, "processPresetId")
            .map(|v| string(Some(v)))
            .transpose()?,
        filaments,
    };
    selection_reply(
        &choices::resolve(catalog, live.profile, &live.heads, &request),
        &live,
    )
}

/// `{"live","machine","process","filament"}`, names as typed → a selection's reply.
pub fn select_by_names_json(catalog: Option<&ProfileCatalog>, request: &str) -> Answer {
    let profiles = profiles(catalog);
    let mut fields = object(
        read(request)?,
        &["filament", "live", "machine", "process"],
        &[],
    )?;
    let live = live_of(profiles, take(&mut fields, "live").ok_or(INVALID_REQUEST)?)?;
    let machine = string(take(&mut fields, "machine"))?;
    let process = string(take(&mut fields, "process"))?;
    let filament = string(take(&mut fields, "filament"))?;
    selection_reply(
        &choices::resolve_by_names(
            catalog,
            live.profile,
            &live.heads,
            &machine,
            &process,
            &filament,
        ),
        &live,
    )
}

/// `{"live"}` → the selection of the catalog's default triple, or `{}` when
/// the catalog has no profile.
pub fn default_selection_json(catalog: Option<&ProfileCatalog>, request: &str) -> Answer {
    let profiles = profiles(catalog);
    let mut fields = object(read(request)?, &["live"], &[])?;
    let live = live_of(profiles, take(&mut fields, "live").ok_or(INVALID_REQUEST)?)?;
    let Some(fallback) = choices::default_profile(profiles) else {
        return answer([]);
    };
    let request = SelectionRequest {
        machine: Some(units(&fallback.machine_preset_id)),
        process: Some(units(&fallback.process_preset_id)),
        filaments: Some(vec![Some(units(&fallback.filament_preset_id))]),
    };
    selection_reply(
        &choices::resolve(catalog, live.profile, &live.heads, &request),
        &live,
    )
}

/// `{"live","stateJson"}` → `{"configurationJson": text | null}` (none without
/// a profile) or `{"error":"orphaned-mixed-component","message"}`.
pub fn configuration_json<P: TimestampPolicy>(
    catalog: Option<&ProfileCatalog>,
    request: &str,
    timestamps: &mut P,
) -> Answer {
    let profiles = profiles(catalog);
    let mut fields = object(read(request)?, &["live", "stateJson"], &[])?;
    let live = live_of(profiles, take(&mut fields, "live").ok_or(INVALID_REQUEST)?)?;
    let state = state_of(take(&mut fields, "stateJson"), timestamps)?;
    match configuration::live_configuration(profiles, &live, &state.filaments) {
        Err(orphaned) => refusal("orphaned-mixed-component", orphaned.message()),
        Ok(None) => answer([("configurationJson", Value::Null)]),
        Ok(Some(configuration)) => {
            let json = canonical(&configuration.to_value().map_err(|_| OUTPUT_LIMIT)?)?;
            answer([("configurationJson", text(&json))])
        }
    }
}

/// The host's random words drawn as the browser's UUID source draws them.
struct Words<'a> {
    words: &'a [f64],
    next: usize,
}
struct Exhausted;
impl Words<'_> {
    fn allocate(&mut self, _: Allocation<'_>) -> Result<(MixedFilamentId, Vec<u16>), Exhausted> {
        let words = self.words.get(self.next..self.next + 16).ok_or(Exhausted)?;
        self.next += 16;
        let mut drawn = words.iter().copied();
        let id: MixedFilamentId = UuidIdSource::new(move || drawn.next().unwrap_or(0.0)).next();
        let upstream = units(&stable_numeric_id(id.as_utf16()));
        Ok((id, upstream))
    }
}
/// `{"enabled","confirmedCounts"}`.
fn policy_of(value: Option<Value>) -> Result<AutoPairPolicy, &'static str> {
    let mut fields = object(
        value.ok_or(INVALID_REQUEST)?,
        &["confirmedCounts", "enabled"],
        &[],
    )?;
    let Some(Value::Bool(enabled)) = take(&mut fields, "enabled") else {
        return Err(INVALID_REQUEST);
    };
    let confirmed_counts = list(take(&mut fields, "confirmedCounts"))?
        .into_iter()
        .map(|count| match count {
            Value::Number(n) => Ok(n),
            _ => Err(INVALID_REQUEST),
        })
        .collect::<Result<_, _>>()?;
    Ok(AutoPairPolicy {
        enabled,
        confirmed_counts,
    })
}
fn auto_pair_refusal(error: auto_pairs::Error<Exhausted>) -> Answer {
    match error {
        auto_pairs::Error::Projection(message) => refusal("auto-pairs", message),
        auto_pairs::Error::Allocator(Exhausted) => {
            refusal("ids-exhausted", units(IDS_EXHAUSTED_MESSAGE))
        }
    }
}

/// `{"autoPairs":{"enabled","confirmedCounts"},"configurationJson","stateJson"}`
/// and the host's random words for new identities (sixteen per identity, as
/// the browser's UUID source draws them) → `{"stateJson"}`, `{"unchanged":true}`
/// or `{"error":"auto-pairs"|"invalid"|"ids-exhausted","message"}`. The next
/// state is admitted under `timestamps`.
pub fn next_state_json<P: TimestampPolicy>(
    request: &str,
    words: &[f64],
    timestamps: &mut P,
) -> Answer {
    let mut fields = object(
        read(request)?,
        &["autoPairs", "configurationJson", "stateJson"],
        &[],
    )?;
    let policy = policy_of(take(&mut fields, "autoPairs"))?;
    let state = state_of(take(&mut fields, "stateJson"), timestamps)?;
    let configuration_text = String::from_utf16(&string(take(&mut fields, "configurationJson"))?)
        .map_err(|_| INVALID_REQUEST)?;
    let configuration =
        Configuration::from_value(read(&configuration_text)?).ok_or(INVALID_REQUEST)?;
    let mut words = Words { words, next: 0 };
    let next =
        configuration::next_state(&state, &configuration, &policy, &mut |a| words.allocate(a))
            .map_err(|_| OUTPUT_LIMIT)?;
    let next = match next {
        Err(error) => return auto_pair_refusal(error),
        Ok(None) => return answer([("unchanged", Value::Bool(true))]),
        Ok(Some(next)) => next,
    };
    let data = ProjectData::new(next).map_err(|_| OUTPUT_LIMIT)?;
    match ValidatedProject::new(data, timestamps) {
        Err(AdmissionError::Timestamp(_)) => Err(TIMESTAMP_FAILED),
        Err(AdmissionError::Invalid(report)) => {
            refusal("invalid", report.user_message().units().to_vec())
        }
        Ok(project) => {
            let mut json = Vec::new();
            project
                .state()
                .write_json(&mut json)
                .map_err(|_| OUTPUT_LIMIT)?;
            answer([(
                "stateJson",
                text(&String::from_utf8(json).map_err(|_| OUTPUT_LIMIT)?),
            )])
        }
    }
}

/// A session's own code for a refusal before anything was staged.
pub fn session_code(error: SessionError) -> &'static str {
    match error {
        SessionError::Disposed => "disposed",
        SessionError::Stale => "stale",
        SessionError::ResourceLimit => "resource_limit",
        _ => INVALID_REQUEST,
    }
}

/// `{"autoPairs","live"}` and the host's random words → the session's live
/// choice staged as one "Update slicing configuration" replacement of its
/// current project, for `executeStaged`: `{"staged": id}`, `{"unchanged":
/// true}` (no profile, or nothing would change), or `{"error":
/// "orphaned-mixed-component"|"auto-pairs"|"ids-exhausted","message"}`. The
/// replacement is validated when it executes. A disposed session, or one
/// without staging room, refuses with its code.
pub fn stage_json<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    catalog: Option<&ProfileCatalog>,
    request: &str,
    words: &[f64],
) -> Answer {
    let profiles = profiles(catalog);
    let mut fields = object(read(request)?, &["autoPairs", "live"], &[])?;
    let policy = policy_of(take(&mut fields, "autoPairs"))?;
    let live = live_of(profiles, take(&mut fields, "live").ok_or(INVALID_REQUEST)?)?;
    let mut words = Words { words, next: 0 };
    let stage = session
        .stage_slicing_configuration(profiles, &live, &policy, &mut |a| words.allocate(a))
        .map_err(session_code)?;
    match stage {
        configuration::Stage::Staged(id) => answer([("staged", Value::Number(id as f64))]),
        configuration::Stage::Unchanged => answer([("unchanged", Value::Bool(true))]),
        configuration::Stage::Orphaned(orphaned) => {
            refusal("orphaned-mixed-component", orphaned.message())
        }
        configuration::Stage::AutoPairs(error) => auto_pair_refusal(error),
    }
}
