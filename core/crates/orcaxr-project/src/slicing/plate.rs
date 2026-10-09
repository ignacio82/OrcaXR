//! One-plate slice projection (`web/src/project/slicing/plateProjection.ts`,
//! `projectPlateArchiveForSlice` and `platePrintOverrides`): the canonical
//! project an engine that always loads plate zero slices for one plate, and
//! the print configuration that plate overrides, as engine wire strings.
//! `plate-projection-vectors.json` pins both against the browser.
use crate::{
    ids::{AssetId, PlateId},
    js_math::convert::value_to_string,
    model::{GcodeScope, Number, ProjectData, ProjectState, find_plate},
    validation::{AdmissionError, TimestampPolicy, ValidatedProject, ValidationReport},
};
use orcaxr_contracts::canonical::Value;
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
impl<T: fmt::Debug> fmt::Display for ProjectionError<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnknownPlate => "plate_projection_unknown_plate",
            Self::PlateNotPrintable => "plate_projection_not_printable",
            Self::MissingAsset(_) => "plate_projection_missing_asset",
            Self::Invalid(_) => "plate_projection_invalid",
            Self::Encoding => "plate_projection_encoding",
            Self::Timestamp(_) => "plate_projection_timestamp",
        })
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
