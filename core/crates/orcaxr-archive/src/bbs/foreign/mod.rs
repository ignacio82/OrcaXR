//! Complete import of a standard BBS/3MF package that has no OrcaXR envelope.
//!
//! This ports the production browser's `deserializeForeign` and `importBbsCore`
//! end to end: bounded model structure, BBS metadata members, filament and
//! FullSpectrum identities, plate-local coordinates, canonical state assembly,
//! OPC reconciliation, regenerated-member exclusion, preservation of every other
//! member and graph admission. Metadata members are read exactly as the browser
//! reads them, including its JavaScript number/string conversions, so accepted
//! files import identically on both hosts. Nothing escapes on any failure.
mod assemble;
pub(crate) mod js;
mod metadata;
mod mixed;
mod plates;
mod scan;

use crate::{
    Archive,
    bbs::{
        model::{self, metadata as bbs_metadata, settings},
        read_xml::package,
    },
    canonical::{
        CompleteLimits, CompletedCanonicalArchive, Error, Failure as CanonicalFailure,
        ImportWarning, complete::Budget,
    },
    opc,
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository},
    ingress::json::{JsonInput, JsonInputError, JsonLimits},
    model::{Decode, ProjectData, ProjectState},
    validation::{TimestampPolicy, ValidatedProject},
};
use std::{
    collections::BTreeSet,
    io::{Read, Seek},
};

const SUMMARY: &str = "Imported a 3MF without OrcaXR canonical metadata. Core geometry, transforms, basic BBS settings, plates, and bounded BBS facet trees were recovered; unsupported BBS fields remain preserved as opaque package entries.";
/// Members a foreign import always regenerates rather than preserves.
const ALWAYS_EXCLUDED: [&str; 4] = [
    "[Content_Types].xml",
    "_rels/.rels",
    assemble::CORE_MODEL_PATH,
    "3D/_rels/3dmodel.model.rels",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarningCode {
    Summary,
    Emboss,
    FullSpectrum,
    PlateCoordinates,
    ProductionParts,
    StandalonePart,
    MissingSvg,
    LayerEvents,
    BrimEars,
    LayerHeights,
    Regeneration,
}
/// A typed warning carrying the browser's exact UTF-16 message text, which may
/// quote file content (and therefore lone surrogates) verbatim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    pub code: WarningCode,
    pub text: Vec<u16>,
}
impl Warning {
    pub(crate) fn new(code: WarningCode, text: &str) -> Self {
        Self {
            code,
            text: text.encode_utf16().collect(),
        }
    }
    pub(crate) fn from_utf16(code: WarningCode, text: Vec<u16>) -> Self {
        Self { code, text }
    }
}

/// Redacted failures; no path, name or file content is formatted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Model(package::Error),
    Utf8,
    Metadata,
    UnsafeKey,
    ProjectSettings,
    Json(JsonInputError),
    DuplicateMetadataObject,
    DuplicateMetadataPart,
    PlateMetadata,
    UnassignedBuildItem,
    MissingPrintableArea,
    MixedDefinitions,
    Paint,
    PaintSlot,
    AmbiguousMetadata,
    Graph,
    Transform,
    State,
    ResourceLimit,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub model: package::Limits,
    /// Each standard metadata member after decompression.
    pub metadata_bytes: usize,
    /// `project_settings.config` JSON; the browser's own 1,000,000-node and
    /// 256-depth checks apply in addition.
    pub project_json: JsonLimits,
    /// Aggregate per-volume annotation materialization (the browser default is
    /// 256,000,000).
    pub materialization_units: u64,
    pub complete: CompleteLimits,
}

fn check<E>(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error<E>> {
    if cancelled() {
        Err(CanonicalFailure::Cancelled.into())
    } else {
        Ok(())
    }
}
fn member<R: Read + Seek>(
    archive: &mut Archive<R>,
    path: &str,
    limit: usize,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Option<Vec<u8>>, CanonicalFailure> {
    let Some(index) = archive
        .entries()
        .iter()
        .position(|e| !e.is_directory() && e.path() == path)
    else {
        return Ok(None);
    };
    let length = usize::try_from(archive.entries()[index].bytes())
        .ok()
        .filter(|n| *n <= limit)
        .ok_or(CanonicalFailure::ResourceLimit)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| CanonicalFailure::ResourceLimit)?;
    archive
        .read_entry(index, &mut bytes, &mut *cancelled)
        .map_err(CanonicalFailure::Archive)?;
    Ok(Some(bytes))
}
fn parse_json(text: &str, limits: JsonLimits) -> Result<Value, Failure> {
    let mut input = JsonInput::new(text.len(), limits).map_err(Failure::Json)?;
    for chunk in text.as_bytes().chunks(crate::CHUNK_BYTES) {
        input
            .append(input.received_bytes(), chunk)
            .map_err(Failure::Json)?;
    }
    input.finish().map_err(Failure::Json)
}
fn admit<E>(
    state: ProjectState,
    timestamps: &mut impl TimestampPolicy<Error = E>,
) -> Result<ValidatedProject, Error<E>> {
    let data = ProjectData::new(state)
        .map_err(|_| Error::Document(orcaxr_project::ingress::DocumentError::Encoding))?;
    ValidatedProject::new(data, timestamps)
        .map_err(|e| Error::Document(orcaxr_project::ingress::DocumentError::Admission(e)))
}
fn foreign<E>(failure: Failure) -> Error<E> {
    Error::Failure(CanonicalFailure::Foreign(failure))
}

/// Import one privately staged foreign archive. The result is a completed
/// canonical archive whose guarded adoption belongs to the host's Open/reset.
pub fn import<R: Read + Seek, P: TimestampPolicy>(
    mut archive: Archive<R>,
    limits: Limits,
    timestamps: &mut P,
    mut cancelled: impl FnMut() -> bool,
) -> Result<CompletedCanonicalArchive, Error<P::Error>> {
    check(&mut cancelled)?;
    let hash = format!(
        "{:016x}",
        archive
            .source_fingerprint(&mut cancelled)
            .map_err(CanonicalFailure::Archive)?
    );
    let structure = package::read_model_structure(&mut archive, limits.model, &mut cancelled)
        .map_err(|e| match e {
            package::Error::Cancelled => Error::Failure(CanonicalFailure::Cancelled),
            e => foreign(Failure::Model(e)),
        })?;
    let mut read = |path: &str| member(&mut archive, path, limits.metadata_bytes, &mut cancelled);
    let project_bytes = read(metadata::PROJECT_SETTINGS_PATH)?;
    let model_bytes = read(metadata::MODEL_SETTINGS_PATH)?;
    let ranges_bytes = read(metadata::LAYER_RANGES_PATH)?;
    let events_bytes = read(metadata::LAYER_EVENTS_PATH)?;
    let brim_bytes = read(metadata::BRIM_EAR_POINTS_PATH)?;
    let heights_bytes = read(metadata::LAYER_HEIGHTS_PROFILE_PATH)?;
    check(&mut cancelled)?;

    let mut warnings = vec![Warning::new(WarningCode::Summary, SUMMARY)];
    let project = metadata::project_settings(project_bytes.as_deref(), |text| {
        parse_json(text, limits.project_json)
    })
    .map_err(foreign)?;
    let model = metadata::model_settings(model_bytes.as_deref(), &mut warnings).map_err(foreign)?;
    let build_ids: Vec<u64> = structure
        .graph
        .build
        .iter()
        .map(|b| b.item.object_id)
        .collect();
    let settings_xml = model_bytes
        .as_deref()
        .map(metadata::decode_text)
        .transpose()
        .map_err(foreign)?;
    let plates = plates::coordinates(
        settings_xml,
        &model,
        &build_ids,
        metadata::printable_area_size(project.config.get(&metadata::utf16("printable_area"))),
    )
    .map_err(foreign)?;
    let layer_ranges = metadata::layer_ranges(ranges_bytes.as_deref()).map_err(foreign)?;
    let layer_events = metadata::layer_events(events_bytes.as_deref()).map_err(foreign)?;
    check(&mut cancelled)?;
    let brim = brim_bytes
        .as_deref()
        .map(metadata::decode_text)
        .transpose()
        .map_err(foreign)?;
    let heights = heights_bytes
        .as_deref()
        .map(metadata::decode_text)
        .transpose()
        .map_err(foreign)?;
    let drawing_limit = limits.complete.asset_bytes;
    let mut drawings = |path: &str| -> Result<Option<Vec<u8>>, Failure> {
        member(&mut archive, path, drawing_limit, &mut cancelled).map_err(|e| match e {
            CanonicalFailure::ResourceLimit => Failure::ResourceLimit,
            _ => Failure::State,
        })
    };
    let output = assemble::assemble(
        assemble::Input {
            archive_hash: &hash,
            parts: &structure.parts,
            graph: &structure.graph,
            project,
            model,
            plates,
            layer_ranges,
            layer_events,
            brim_text: brim,
            heights_text: heights,
            max_materialization_units: limits.materialization_units,
        },
        &mut drawings,
        &mut warnings,
    )
    .map_err(foreign)?;
    check(&mut cancelled)?;

    // Consumed members: the core and referenced parts, read metadata and
    // drawings. Only those the canonical writer regenerates stop being carried.
    let present = |archive: &Archive<R>, path: &str| {
        archive
            .entries()
            .iter()
            .any(|e| !e.is_directory() && e.path() == path)
    };
    let mut consumed: BTreeSet<String> = BTreeSet::new();
    consumed.insert(assemble::CORE_MODEL_PATH.to_owned());
    consumed.extend(output.consumed_svg_paths.iter().cloned());
    consumed.extend(structure.graph.external_model_paths.iter().cloned());
    for path in [
        metadata::PROJECT_SETTINGS_PATH,
        metadata::MODEL_SETTINGS_PATH,
        metadata::LAYER_RANGES_PATH,
        metadata::LAYER_EVENTS_PATH,
        metadata::BRIM_EAR_POINTS_PATH,
        metadata::LAYER_HEIGHTS_PROFILE_PATH,
    ] {
        if present(&archive, path) {
            consumed.insert(path.to_owned());
        }
    }

    let state =
        ProjectState::from_value(output.state).map_err(|_| foreign::<P::Error>(Failure::State))?;
    let mut candidate = state;
    let merged = opc::read(
        &mut archive,
        &candidate,
        limits.complete.opc,
        &mut cancelled,
    )
    .map_err(CanonicalFailure::Opc)?;
    let opc_warnings = merged
        .apply(&mut candidate)
        .map_err(CanonicalFailure::Opc)?;
    let mut assets = AssetRepository::new();
    for (descriptor, bytes) in output.assets {
        check(&mut cancelled)?;
        assets
            .put_owned(AssetPayload { descriptor, bytes })
            .map_err(|e| Error::Asset(orcaxr_project::ingress::AssetInputError::Asset(e)))?;
    }
    let project = admit(candidate, timestamps)?;
    check(&mut cancelled)?;

    // `buildBbsCore` decides which consumed members the next save regenerates.
    let mut budget = Budget {
        records: limits.complete.records,
        text: limits.complete.text_units,
        warnings: limits.complete.warnings,
    };
    let mut import_warnings = Vec::new();
    for warning in warnings {
        budget.warn(&mut import_warnings, ImportWarning::Foreign(warning))?;
    }
    for warning in opc_warnings {
        budget.warn(&mut import_warnings, ImportWarning::Opc(warning))?;
    }
    let mut regenerated: BTreeSet<String> = BTreeSet::new();
    {
        let leases = || {
            project
                .state()
                .source_assets
                .iter()
                .filter_map(|d| assets.peek(&d.id))
        };
        match model::Authoring::new(&project, leases(), limits.complete.model, &mut cancelled) {
            Ok(model) => {
                let metadata = bbs_metadata::Authoring::new(
                    &model,
                    leases(),
                    limits.complete.metadata,
                    &mut cancelled,
                )
                .map_err(CanonicalFailure::Bbs)?;
                settings::Authoring::new(&model, limits.complete.settings, &mut cancelled)
                    .map_err(CanonicalFailure::Settings)?;
                // `buildBbsCore` writes every metadata member it regenerates,
                // so a key or value XML 1.0 cannot carry (a control character
                // in a config key, say) refuses the Open there. Planning alone
                // never reaches the writer's character checks; writing the
                // members to nowhere refuses the same packages.
                for member in bbs_metadata::Member::ALL {
                    metadata
                        .write(member, &mut std::io::sink(), &mut cancelled)
                        .map_err(CanonicalFailure::Bbs)?;
                }
                regenerated
                    .extend([model::PATH, settings::PATH, opc::MODEL_RELS].map(str::to_owned));
                for m in bbs_metadata::Member::ALL {
                    if metadata.contains(m) {
                        regenerated.insert(m.path().to_owned());
                    }
                }
                for (path, _) in metadata.drawings() {
                    regenerated.insert(
                        String::from_utf16(path)
                            .map_err(|_| foreign::<P::Error>(Failure::State))?,
                    );
                }
            }
            Err(model::Error::MissingPrintableArea) => {
                let plates = project.state().plates.len();
                budget.warn(
                    &mut import_warnings,
                    ImportWarning::Foreign(Warning::new(
                        WarningCode::Regeneration,
                        &format!(
                            "Imported metadata is preserved as-is because standard BBS metadata cannot be regenerated yet: Cannot project {plates} canonical plates into BBS global build coordinates: project config has no valid printable_area"
                        ),
                    )),
                )?;
            }
            Err(error) => return Err(CanonicalFailure::Bbs(error).into()),
        }
    }
    let mut excluded: BTreeSet<String> = ALWAYS_EXCLUDED.iter().map(|p| (*p).to_owned()).collect();
    for path in &consumed {
        if regenerated.contains(path) {
            excluded.insert(path.clone());
        }
    }
    if regenerated.contains(assemble::CORE_MODEL_PATH) {
        excluded.extend(structure.graph.external_model_paths.iter().cloned());
    }
    let state = crate::canonical::complete::adopt_unowned(
        &mut archive,
        project,
        &mut assets,
        BTreeSet::new(),
        &|path| excluded.contains(path),
        &BTreeSet::new(),
        limits.complete,
        &mut budget,
        &mut import_warnings,
        &mut cancelled,
    )?;
    check(&mut cancelled)?;
    let project = admit(state, timestamps)?;
    check(&mut cancelled)?;
    Ok(CompletedCanonicalArchive::new(
        project,
        assets,
        import_warnings,
        Default::default(),
    ))
}

impl From<Failure> for CanonicalFailure {
    fn from(failure: Failure) -> Self {
        CanonicalFailure::Foreign(failure)
    }
}
