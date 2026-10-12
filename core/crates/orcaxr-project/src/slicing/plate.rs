//! One-plate slice projection (`web/src/project/slicing/plateProjection.ts`,
//! `projectPlateArchiveForSlice` and `platePrintOverrides`): the canonical
//! project an engine that always loads plate zero slices for one plate, and
//! the print configuration that plate overrides, as engine wire strings.
//! `plate-projection-vectors.json` pins both against the browser.
use crate::{
    ids::{AssetId, PlateId},
    js_math::convert::value_to_string,
    model::{Decode, Encode, GcodeScope, Number, ProjectData, ProjectState, find_plate},
    validation::{AdmissionError, TimestampPolicy, ValidatedProject, ValidationReport},
};
use orcaxr_contracts::canonical::{Value, parse};
use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    fmt,
    sync::Arc,
};

/// Presentation-only bookkeeping a plate's config also carries: not print
/// configuration, and refused by the engine.
pub const PLATE_NON_PRINT_KEYS: [&str; 4] = ["plater_id", "plater_name", "locked", "printable"];

/// A plate projected for slicing: the source project's guard stays with the
/// caller, separate from this projected state's own fingerprint.
#[derive(Debug, Clone)]
pub struct PlateProjection {
    /// The one-plate project, admitted; its fingerprint is the archive's `sourceHash`.
    pub project: ValidatedProject,
    /// The source assets it keeps, in descriptor order: the payloads the archive carries.
    pub assets: Vec<AssetId>,
}
impl PlateProjection {
    pub fn source_hash(&self) -> &str {
        self.project.fingerprint()
    }
}

/// Why a plate cannot be projected, in the order the browser checks.
#[derive(Debug)]
pub enum ProjectionError<T = Infallible> {
    UnknownPlate,
    PlateNotPrintable,
    /// A kept source asset whose payload the capture does not hold.
    MissingAsset(AssetId),
    /// The projected state fails the graph rules (`assertValidProjectState`).
    Invalid(ValidationReport),
    /// The projected state could not be encoded.
    Encoding,
    Timestamp(T),
}
impl<T> ProjectionError<T> {
    /// The browser's error message, for the plate that was asked for.
    pub fn message(&self, plate_id: &PlateId) -> Vec<u16> {
        let with = |before: &str, id: &[u16], after: &str| {
            let mut text: Vec<u16> = before.encode_utf16().collect();
            text.extend_from_slice(id);
            text.extend(after.encode_utf16());
            text
        };
        match self {
            Self::UnknownPlate => with("Unknown plate ", plate_id.as_utf16(), ""),
            Self::PlateNotPrintable => with("Plate ", plate_id.as_utf16(), " is not printable"),
            Self::MissingAsset(id) => with(
                "One-plate projection is missing source asset ",
                id.as_utf16(),
                "",
            ),
            Self::Invalid(report) => report.user_message().units().to_vec(),
            Self::Encoding => "Projected project state could not be encoded"
                .encode_utf16()
                .collect(),
            Self::Timestamp(_) => "Timestamp validation service failed"
                .encode_utf16()
                .collect(),
        }
    }
}
impl<T> ProjectionError<T> {
    /// The stable refusal code bindings report.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownPlate => "plate_projection_unknown_plate",
            Self::PlateNotPrintable => "plate_projection_not_printable",
            Self::MissingAsset(_) => "plate_projection_missing_asset",
            Self::Invalid(_) => "plate_projection_invalid",
            Self::Encoding => "plate_projection_encoding",
            Self::Timestamp(_) => "plate_projection_timestamp",
        }
    }
}
impl<T: fmt::Debug> fmt::Display for ProjectionError<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl<T: fmt::Debug> std::error::Error for ProjectionError<T> {}

/// `projectPlateArchiveForSlice`: `state` reduced to `plate_id` as plate zero
/// and the active plate; project-scoped custom G-code and this plate's kept,
/// other plates' dropped; thumbnails without a plate or for this one kept;
/// opaque extension blobs dropped (a preserved `model_settings.config` must
/// not replace the freshly generated one-plate metadata); source assets kept
/// only when this plate's volumes or kept thumbnails use them, each of which
/// `has_payload` must hold. The result is admitted under `timestamps`.
pub fn project_plate<P: TimestampPolicy>(
    state: &ProjectState,
    plate_id: &PlateId,
    has_payload: impl Fn(&AssetId) -> bool,
    timestamps: &mut P,
) -> Result<PlateProjection, ProjectionError<P::Error>> {
    let source = find_plate(state, plate_id).ok_or(ProjectionError::UnknownPlate)?;
    if !source.printable {
        return Err(ProjectionError::PlateNotPrintable);
    }
    let mut plate = source.clone();
    plate.order = Number::new(0.0).expect("zero is a project number");
    let mut next = state.clone();
    next.plates = vec![Arc::new(plate)].into();
    next.active_plate_id = plate_id.clone();
    next.custom_gcode = state
        .custom_gcode
        .iter()
        .filter(|entry| match entry.scope {
            GcodeScope::Project => true,
            GcodeScope::Plate => entry.plate_id.as_ref() == Some(plate_id),
        })
        .cloned()
        .collect();
    next.thumbnails = state
        .thumbnails
        .iter()
        .filter(|thumbnail| thumbnail.plate_id.as_ref().is_none_or(|id| id == plate_id))
        .cloned()
        .collect();
    next.extension_blobs = Arc::from([]);
    let referenced: BTreeSet<AssetId> = next
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .map(|volume| volume.source.asset_id.clone())
        .chain(
            next.thumbnails
                .iter()
                .map(|thumbnail| thumbnail.asset_id.clone()),
        )
        .collect();
    next.source_assets = state
        .source_assets
        .iter()
        .filter(|descriptor| referenced.contains(&descriptor.id))
        .cloned()
        .collect();
    let assets: Vec<AssetId> = next
        .source_assets
        .iter()
        .map(|descriptor| descriptor.id.clone())
        .collect();
    if let Some(missing) = assets.iter().find(|id| !has_payload(id)) {
        return Err(ProjectionError::MissingAsset(missing.clone()));
    }
    let data = ProjectData::new(next).map_err(|_| ProjectionError::Encoding)?;
    let project = ValidatedProject::new(data, timestamps).map_err(|error| match error {
        AdmissionError::Timestamp(error) => ProjectionError::Timestamp(error),
        AdmissionError::Invalid(report) => ProjectionError::Invalid(report),
    })?;
    Ok(PlateProjection { project, assets })
}

/// `platePrintOverrides`: the keys `plate_id`'s config overrides, as the
/// engine's wire strings — `String(value)`, an array as its entries'
/// `String`s joined by commas — leaving out [`PLATE_NON_PRINT_KEYS`] and
/// null values. An unknown plate overrides nothing. A key named `__proto__`
/// never appears: the browser assigns into a plain object, where that name is
/// the prototype setter and a string creates no property (no engine setting
/// has that name). Keys are in UTF-16 order; the browser's object keeps
/// insertion order, which a JSON map on the wire does not carry.
pub fn plate_print_overrides(
    state: &ProjectState,
    plate_id: &PlateId,
) -> BTreeMap<Vec<u16>, Vec<u16>> {
    let mut overrides = BTreeMap::new();
    let Some(plate) = find_plate(state, plate_id) else {
        return overrides;
    };
    let Value::Object(entries) = plate.config.value() else {
        return overrides;
    };
    for (key, value) in entries {
        let named = |name: &str| name.encode_utf16().eq(key.iter().copied());
        if PLATE_NON_PRINT_KEYS.iter().any(|name| named(name)) || named("__proto__") {
            continue;
        }
        let text = match value {
            Value::Null => continue,
            Value::Array(items) => {
                let mut joined = Vec::new();
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        joined.push(u16::from(b','));
                    }
                    joined.extend(value_to_string(item));
                }
                joined
            }
            other => value_to_string(other),
        };
        overrides.insert(key.clone(), text);
    }
    overrides
}

// --- Binding exchange ------------------------------------------------------------------------

/// The largest text each argument of a binding exchange may be: the
/// canonical parser's bound. A session's project of any size is projected
/// through its export capture ([`ExportCapture::plate`](crate::export::ExportCapture::plate)).
pub const MAX_EXCHANGE_BYTES: usize = orcaxr_contracts::generated::MAX_INPUT_BYTES;
/// Why a binding exchange could not be answered: its input was not a state
/// document, a plate ID or a list of asset IDs.
pub const INVALID_REQUEST: &str = "invalid_request";
/// An argument longer than [`MAX_EXCHANGE_BYTES`].
pub const INPUT_LIMIT: &str = "input_limit";

fn read(text: &str) -> Result<Value, &'static str> {
    if text.len() > MAX_EXCHANGE_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(text).map_err(|_| INVALID_REQUEST)
}
fn read_state(text: &str) -> Result<ProjectState, &'static str> {
    ProjectState::from_value(read(text)?).map_err(|_| INVALID_REQUEST)
}
/// A plate ID carried as a JSON string, so UTF-16 identities survive a binding.
pub fn read_plate(text: &str) -> Result<PlateId, &'static str> {
    match read(text)? {
        Value::String(units) => PlateId::try_from_utf16(units).map_err(|_| INVALID_REQUEST),
        _ => Err(INVALID_REQUEST),
    }
}
fn read_assets(text: &str) -> Result<BTreeSet<AssetId>, &'static str> {
    let Value::Array(items) = read(text)? else {
        return Err(INVALID_REQUEST);
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(units) => AssetId::try_from_utf16(units).map_err(|_| INVALID_REQUEST),
            _ => Err(INVALID_REQUEST),
        })
        .collect()
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("an answer is finite JSON");
    String::from_utf8(bytes).expect("canonical JSON is UTF-8")
}
fn text(value: &str) -> Value {
    Value::String(value.encode_utf16().collect())
}

/// [`project_plate`] over a state document, for hosts without a session and
/// for the bindings' replays: `plate_id` is a JSON string and `omitted` a JSON
/// array of the source asset IDs whose payloads the host does not hold, so
/// every UTF-16 identity survives. Answers canonical JSON: the projection as
/// `{"assetIds":[…],"sourceHash":"…","stateJson":"…"}` (the projected state as
/// its canonical text, the kept assets in descriptor order), or why it was
/// refused as `{"error":"<code>","message":"…"}`, the browser's message.
pub fn projection_json<P: TimestampPolicy>(
    state: &str,
    plate_id: &str,
    omitted: &str,
    timestamps: &mut P,
) -> Result<String, &'static str> {
    let state = read_state(state)?;
    let plate_id = read_plate(plate_id)?;
    let omitted = read_assets(omitted)?;
    let answer = match project_plate(&state, &plate_id, |id| !omitted.contains(id), timestamps) {
        Ok(projection) => {
            let mut json = Vec::new();
            projection
                .project
                .state()
                .write_json(&mut json)
                .map_err(|_| "output_limit")?;
            let json = String::from_utf8(json).map_err(|_| "output_limit")?;
            let ids = projection
                .assets
                .iter()
                .map(|id| Value::String(id.as_utf16().to_vec()))
                .collect();
            BTreeMap::from([
                ("assetIds", Value::Array(ids)),
                ("sourceHash", text(projection.source_hash())),
                ("stateJson", text(&json)),
            ])
        }
        Err(error) => BTreeMap::from([
            ("error", text(error.code())),
            ("message", Value::String(error.message(&plate_id))),
        ]),
    };
    Ok(canonical(&Value::Object(
        answer
            .into_iter()
            .map(|(name, value)| (name.encode_utf16().collect(), value))
            .collect(),
    )))
}

/// [`plate_print_overrides`] over a state document, `plate_id` a JSON string.
pub fn print_overrides_json(state: &str, plate_id: &str) -> Result<String, &'static str> {
    let state = read_state(state)?;
    let plate_id = read_plate(plate_id)?;
    Ok(overrides_json(&plate_print_overrides(&state, &plate_id)))
}

/// Overrides as the canonical JSON object a slice submission's `overrides`
/// field carries.
pub fn overrides_json(overrides: &BTreeMap<Vec<u16>, Vec<u16>>) -> String {
    canonical(&Value::Object(
        overrides
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    ))
}

// --- Which plates a slice slices -------------------------------------------------------------

/// What a slice covers (`SliceJobScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// "Slice": the active plate.
    CurrentPlate,
    /// "Slice All Plates": every printable plate that holds a model.
    AllPlates,
}

/// The plates a slice of `scope` slices, in slicing order, or the browser's
/// words for why it slices none: the workspace's own refusal when nothing it
/// would slice holds a model (`sliceNow`: "No models to slice.";
/// `sliceAllPlates`: "No printable plate has models to slice."), then the
/// coordinator's `selectPlateIds` — the active plate, which must be
/// printable, or every printable plate holding a model by plate order, then
/// UTF-16 ID.
pub fn slice_plan(state: &ProjectState, scope: Scope) -> Result<Vec<PlateId>, Vec<u16>> {
    let instances = |plate: &crate::model::ProjectPlate| {
        plate
            .objects
            .iter()
            .map(|object| object.instances.len())
            .sum::<usize>()
    };
    let words = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    let active = state
        .plates
        .iter()
        .find(|plate| plate.id == state.active_plate_id);
    match scope {
        Scope::CurrentPlate => {
            let Some(active) = active.filter(|plate| instances(plate) > 0) else {
                return Err(words("No models to slice."));
            };
            if !active.printable {
                let mut message = words("Active plate ");
                message.extend_from_slice(active.id.as_utf16());
                message.extend(words(" is not printable"));
                return Err(message);
            }
            Ok(vec![active.id.clone()])
        }
        Scope::AllPlates => {
            let mut plates: Vec<_> = state
                .plates
                .iter()
                .filter(|plate| plate.printable && instances(plate) > 0)
                .collect();
            if plates.is_empty() {
                return Err(words("No printable plate has models to slice."));
            }
            // `left.order - right.order || compareCanonicalText(left.id, right.id)`.
            plates.sort_by(|a, b| {
                (a.order.get() - b.order.get())
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.id.as_utf16().cmp(b.id.as_utf16()))
            });
            Ok(plates.into_iter().map(|plate| plate.id.clone()).collect())
        }
    }
}

/// `{"scope": "current-plate" | "all-plates", "stateJson"}` →
/// `{"plateIds": [...]}` in slicing order, or `{"refusal": text}`.
pub fn plan_json(request: &str) -> Result<String, &'static str> {
    let Value::Object(mut fields) = read(request)? else {
        return Err(INVALID_REQUEST);
    };
    let key = |name: &str| name.encode_utf16().collect::<Vec<u16>>();
    if fields.len() != 2 {
        return Err(INVALID_REQUEST);
    }
    let scope = match fields.remove(&key("scope")) {
        Some(Value::String(text)) if text == key("current-plate") => Scope::CurrentPlate,
        Some(Value::String(text)) if text == key("all-plates") => Scope::AllPlates,
        _ => return Err(INVALID_REQUEST),
    };
    let Some(Value::String(state)) = fields.remove(&key("stateJson")) else {
        return Err(INVALID_REQUEST);
    };
    let state = String::from_utf16(&state).map_err(|_| INVALID_REQUEST)?;
    Ok(plan_reply(slice_plan(&read_state(&state)?, scope)))
}

/// A plan as its reply document.
pub fn plan_reply(plan: Result<Vec<PlateId>, Vec<u16>>) -> String {
    let (name, value) = match plan {
        Ok(ids) => (
            "plateIds",
            Value::Array(
                ids.iter()
                    .map(|id| Value::String(id.as_utf16().to_vec()))
                    .collect(),
            ),
        ),
        Err(refusal) => ("refusal", Value::String(refusal)),
    };
    canonical(&Value::Object(BTreeMap::from([(
        name.encode_utf16().collect(),
        value,
    )])))
}
