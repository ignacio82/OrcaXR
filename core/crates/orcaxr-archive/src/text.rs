//! Warning text exactly as the production browser shows it, for host UIs.
//!
//! Archive diagnostics stay typed inside the core so private paths and names are
//! never formatted into errors. Hosts that present warnings use these renderers,
//! which return the browser's sorted, de-duplicated UTF-16 messages; some quote
//! project text and may contain lone surrogates. A mesh-parser failure keeps the
//! browser's omitted-volume identity but not parser-specific prose.
use crate::{
    bbs::model::{self, metadata, settings},
    canonical::ImportWarning,
    opc, package,
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::ProjectState;
use std::collections::BTreeSet;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn message(template: &str, args: &[&[u16]]) -> Vec<u16> {
    let mut parts = template.split("{}");
    let mut out = units(parts.next().unwrap_or(""));
    for (arg, part) in args.iter().zip(parts) {
        out.extend_from_slice(arg);
        out.extend(part.encode_utf16());
    }
    out
}
fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 { one.into() } else { many.into() }
}

fn opc_warning(w: &opc::Warning) -> Vec<u16> {
    match w {
        opc::Warning::IncompleteRelationship { source } => units(&format!(
            "Ignored an incomplete OPC relationship in {}",
            source.member()
        )),
        opc::Warning::MissingContentTypes => units(
            "3MF is missing [Content_Types].xml; a valid content-type manifest will be generated on save",
        ),
        opc::Warning::MissingRelationshipTarget { source, id, target } => [
            units("Preserved OPC relationship "),
            id.units().to_vec(),
            units(&format!(" from {}, but target ", source.member())),
            target.units().to_vec(),
            units(" is missing"),
        ]
        .concat(),
        opc::Warning::MissingOverride { part_name } => [
            units("Preserved content-type override for missing package part "),
            part_name.units().to_vec(),
        ]
        .concat(),
        opc::Warning::DroppedRelationships { targets, count } => {
            let targets: Vec<_> = targets.iter().map(|t| t.units()).collect();
            let joined = targets.join(&[44, 32][..]);
            message(
                "Dropped {} preserved package relationship(s) whose target is not part of this archive: {}",
                &[&units(&count.to_string()), &joined],
            )
        }
    }
}

/// Open warnings for a completed archive's state, sorted and de-duplicated.
pub fn import_warnings(state: &ProjectState, warnings: &[ImportWarning]) -> Vec<Vec<u16>> {
    let set: BTreeSet<Vec<u16>> = warnings
        .iter()
        .map(|w| match w {
            ImportWarning::DenseChannels(n) => units(&format!(
                "Converted {n} facet refinement channel{} from the per-triangle encoding to the subdivided-facet encoding",
                plural(*n, "", "s")
            )),
            ImportWarning::FalseFuzzyAssignments(n) => units(&format!(
                "Removed {n} legacy false fuzzy-skin facet assignment{}; false represented the inherited/unpainted state",
                plural(*n, "", "s")
            )),
            ImportWarning::UnsupportedDigest { asset } => {
                let d = &state.source_assets[*asset];
                message(
                    "Asset {} uses unsupported digest {}; ZIP CRC and byte length were validated",
                    &[d.id.as_utf16(), d.digest.units()],
                )
            }
            ImportWarning::UnresolvedPlateCoordinates => units(&format!(
                "Opened the canonical OrcaXR envelope safely, but standard BBS metadata cannot be regenerated until its plate coordinates are resolvable: Cannot project {} canonical plates into BBS global build coordinates: project config has no valid printable_area",
                state.plates.len()
            )),
            ImportWarning::PreservedOriginal { blob } => message(
                "Detected externally modified {}; preserving its original bytes as opaque BBS metadata",
                &[state.extension_blobs[*blob].path.units()],
            ),
            ImportWarning::PreservedEntries(n) => units(&format!(
                "Preserved {n} package entr{} as opaque canonical assets",
                plural(*n, "y", "ies")
            )),
            ImportWarning::Opc(o) => opc_warning(o),
            ImportWarning::Foreign(f) => f.text.clone(),
        })
        .collect();
    set.into_iter().collect()
}

/// Save warnings for the written project, sorted and de-duplicated.
pub fn package_warnings(state: &ProjectState, warnings: &[package::Warning<'_>]) -> Vec<Vec<u16>> {
    let mut plates: Vec<_> = state.plates.iter().collect();
    plates.sort_by(|a, b| a.order.get().total_cmp(&b.order.get()));
    let objects: Vec<_> = plates.iter().flat_map(|p| p.objects.iter()).collect();
    let volume_id = |object: usize, volume: usize| -> Vec<u16> {
        objects
            .get(object)
            .and_then(|o| o.volumes.get(volume))
            .map_or_else(Vec::new, |v| v.id.as_utf16().to_vec())
    };
    let set: BTreeSet<Vec<u16>> = warnings
        .iter()
        .map(|w| match w {
            package::Warning::UnsupportedDigest { asset } => {
                let d = &state.source_assets[*asset];
                message(
                    "Asset {} uses unsupported digest {}; ZIP CRC and byte length were validated",
                    &[d.id.as_utf16(), d.digest.units()],
                )
            }
            package::Warning::PreservedOriginal { blob } => message(
                "Preserved original {} byte-for-byte; OrcaXR canonical metadata remains authoritative for edits that the BBS fallback importer could not merge safely",
                &[state.extension_blobs[*blob].path.units()],
            ),
            package::Warning::UnavailableFilament(id) => message(
                "Filament {} is disabled or cannot be assigned a BBS material slot; its references remain lossless in the OrcaXR extension",
                &[id],
            ),
            package::Warning::CustomHooks => units(
                "Custom G-code hooks that are not layer events are preserved losslessly in the OrcaXR extension; the canonical model does not yet carry every BBS field needed to project them",
            ),
            package::Warning::Extensions => {
                units("Unknown project extensions are retained as package entries and OrcaXR metadata")
            }
            package::Warning::Metadata(metadata::Warning::MissingDrawing {
                plate,
                object,
                volume,
            }) => message(
                "SVG part {} has no stored drawing, so its reference was left out",
                &[state.plates[*plate].objects[*object].volumes[*volume].name.units()],
            ),
            package::Warning::Model(w) => match w {
                model::Warning::MeshOmitted {
                    object,
                    volume,
                    reason,
                } => message(
                    match reason {
                        model::MeshOmission::Missing => {
                            "Volume {} has no source asset; omitted from standard 3MF core"
                        }
                        model::MeshOmission::Invalid(_) => {
                            "Volume {} could not be projected into standard 3MF: invalid mesh"
                        }
                    },
                    &[&volume_id(*object, *volume)],
                ),
                model::Warning::MaterialLimit { count } => message(
                    "The pinned BBS color-paint consumer supports 64 material states; slots 65-{} remain lossless only in the OrcaXR extension",
                    &[&units(&count.to_string())],
                ),
                model::Warning::RefinedColor {
                    object,
                    volume,
                    triangle,
                } => message(
                    "Volume {} source facet {} has a refined color root with a material state outside 1..64; the entire standard BBS paint_color root was omitted and remains lossless in the OrcaXR extension",
                    &[&volume_id(*object, *volume), &units(&triangle.to_string())],
                ),
                model::Warning::Brim { object, volume } => {
                    let refined = objects
                        .get(*object)
                        .and_then(|o| o.volumes.get(*volume))
                        .and_then(|v| v.annotations.refinement.as_ref())
                        .is_some_and(|r| {
                            matches!(r.value(), Value::Object(fields) if fields.contains_key(&units("brim")))
                        });
                    message(
                        "Volume {} uses{} brim facet annotations; BBS has no standard brim-paint attribute, so they remain lossless only in the OrcaXR extension",
                        &[
                            &volume_id(*object, *volume),
                            &units(if refined { " refined" } else { "" }),
                        ],
                    )
                }
                // Package Save replaces these model-local notices with one
                // package-wide filament warning; standalone callers see this.
                model::Warning::UnavailableColor { .. }
                | model::Warning::UnavailableAssignment { .. } => units(
                    "A filament reference cannot be assigned a BBS material slot; it remains lossless in the OrcaXR extension",
                ),
            },
            package::Warning::Settings(w) => match w {
                settings::Warning::RelativeExtruderReset => units(
                    "Added \"G92 E0\" to before_layer_change_gcode: this project uses relative extruder addressing but carries no layer G-code, which the engine refuses to slice.",
                ),
                settings::Warning::WipeTowerRotations => units(
                    "Per-plate wipe-tower rotations are retained in the OrcaXR extension; BBS project settings carry the first enabled rotation",
                ),
                settings::Warning::WipeTowerEnabledStates => units(
                    "Per-plate wipe-tower enabled states are retained in the OrcaXR extension; BBS exposes one project-level enable flag",
                ),
                settings::Warning::ApproximateGradient { mixed } => message(
                    "Mixed gradient {} has OrcaXR Z-range semantics that are retained in the extension; the BBS row is an approximate display/slicer projection",
                    &[state.filaments.mixed[*mixed].id.as_utf16()],
                ),
                settings::Warning::ApproximateCycle { mixed } => message(
                    "Mixed cycle {} retains its millimetre cycle length only in the OrcaXR extension; the BBS row carries an approximate layer pattern",
                    &[state.filaments.mixed[*mixed].id.as_utf16()],
                ),
                settings::Warning::ApproximateMatch { mixed } => message(
                    "Mixed match-color target {} is retained in the OrcaXR extension; the BBS row carries its component weights and UI mode",
                    &[state.filaments.mixed[*mixed].id.as_utf16()],
                ),
            },
            package::Warning::Opc(o) => opc_warning(o),
        })
        .collect();
    set.into_iter().collect()
}
