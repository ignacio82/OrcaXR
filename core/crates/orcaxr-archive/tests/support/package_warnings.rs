//! Test-only rendering of typed diagnostics into the browser's UI vocabulary.
//! Compare UTF-16 units, including lone surrogates. Mesh parser detail is
//! deliberately reduced to the same omitted-volume identity/reason category;
//! parser-specific prose is not a cross-platform contract.
use orcaxr_archive::{
    bbs::model::{self, metadata, settings},
    opc,
    package::Warning,
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::ProjectState;
use std::collections::BTreeSet;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn message(template: &str, args: &[&[u16]]) -> Vec<u16> {
    let parts: Vec<_> = template.split("{}").collect();
    assert_eq!(parts.len(), args.len() + 1);
    let mut out = units(parts[0]);
    for (part, arg) in parts[1..].iter().zip(args) {
        out.extend_from_slice(arg);
        out.extend(part.encode_utf16());
    }
    out
}
pub fn render(state: &ProjectState, warnings: &[Warning<'_>]) -> BTreeSet<Vec<u16>> {
    let mut plates: Vec<_> = state.plates.iter().collect();
    plates.sort_by(|a, b| a.order.get().partial_cmp(&b.order.get()).unwrap());
    let objects: Vec<_> = plates.iter().flat_map(|p| p.objects.iter()).collect();
    warnings.iter().map(|w| match w {
        Warning::UnsupportedDigest { asset } => {
            let d = &state.source_assets[*asset];
            message("Asset {} uses unsupported digest {}; ZIP CRC and byte length were validated", &[d.id.as_utf16(), d.digest.units()])
        }
        Warning::PreservedOriginal { blob } => message("Preserved original {} byte-for-byte; OrcaXR canonical metadata remains authoritative for edits that the BBS fallback importer could not merge safely", &[state.extension_blobs[*blob].path.units()]),
        Warning::UnavailableFilament(id) => message("Filament {} is disabled or cannot be assigned a BBS material slot; its references remain lossless in the OrcaXR extension", &[id]),
        Warning::CustomHooks => units("Custom G-code hooks that are not layer events are preserved losslessly in the OrcaXR extension; the canonical model does not yet carry every BBS field needed to project them"),
        Warning::Extensions => units("Unknown project extensions are retained as package entries and OrcaXR metadata"),
        Warning::Metadata(metadata::Warning::MissingDrawing { plate, object, volume }) => message("SVG part {} has no stored drawing, so its reference was left out", &[state.plates[*plate].objects[*object].volumes[*volume].name.units()]),
        Warning::Model(w) => match w {
            model::Warning::MeshOmitted { object, volume, reason } => message(match reason {
                model::MeshOmission::Missing => "Volume {} has no source asset; omitted from standard 3MF core",
                model::MeshOmission::Invalid(_) => "Volume {} could not be projected into standard 3MF: <invalid mesh>",
            }, &[objects[*object].volumes[*volume].id.as_utf16()]),
            model::Warning::MaterialLimit { count } => message("The pinned BBS color-paint consumer supports 64 material states; slots 65-{} remain lossless only in the OrcaXR extension", &[&units(&count.to_string())]),
            model::Warning::RefinedColor { object, volume, triangle } => message("Volume {} source facet {} has a refined color root with a material state outside 1..64; the entire standard BBS paint_color root was omitted and remains lossless in the OrcaXR extension", &[objects[*object].volumes[*volume].id.as_utf16(), &units(&triangle.to_string())]),
            model::Warning::Brim { object, volume } => {
                let volume = &objects[*object].volumes[*volume];
                let refined = volume.annotations.refinement.as_ref().is_some_and(|r| matches!(r.value(), Value::Object(fields) if fields.contains_key(&units("brim"))));
                message("Volume {} uses{} brim facet annotations; BBS has no standard brim-paint attribute, so they remain lossless only in the OrcaXR extension", &[volume.id.as_utf16(), &units(if refined { " refined" } else { "" })])
            }
            model::Warning::UnavailableColor { .. } | model::Warning::UnavailableAssignment { .. } => panic!("standalone model diagnostic must be replaced by package-wide filament warning"),
        },
        Warning::Settings(w) => match w {
            settings::Warning::RelativeExtruderReset => units("Added \"G92 E0\" to before_layer_change_gcode: this project uses relative extruder addressing but carries no layer G-code, which the engine refuses to slice."),
            settings::Warning::WipeTowerRotations => units("Per-plate wipe-tower rotations are retained in the OrcaXR extension; BBS project settings carry the first enabled rotation"),
            settings::Warning::WipeTowerEnabledStates => units("Per-plate wipe-tower enabled states are retained in the OrcaXR extension; BBS exposes one project-level enable flag"),
            settings::Warning::ApproximateGradient { mixed } => message("Mixed gradient {} has OrcaXR Z-range semantics that are retained in the extension; the BBS row is an approximate display/slicer projection", &[state.filaments.mixed[*mixed].id.as_utf16()]),
            settings::Warning::ApproximateCycle { mixed } => message("Mixed cycle {} retains its millimetre cycle length only in the OrcaXR extension; the BBS row carries an approximate layer pattern", &[state.filaments.mixed[*mixed].id.as_utf16()]),
            settings::Warning::ApproximateMatch { mixed } => message("Mixed match-color target {} is retained in the OrcaXR extension; the BBS row carries its component weights and UI mode", &[state.filaments.mixed[*mixed].id.as_utf16()]),
        },
        Warning::Opc(opc::Warning::DroppedRelationships { targets, count }) => {
            let targets: Vec<_> = targets.iter().map(|t| t.units()).collect();
            let joined = targets.join(&[44, 32][..]);
            message("Dropped {} preserved package relationship(s) whose target is not part of this archive: {}", &[&units(&count.to_string()), &joined])
        }
        Warning::Opc(_) => panic!("import-only diagnostic in package export"),
    }).collect()
}
pub fn expected(state: &ProjectState, rows: &serde_json::Value) -> BTreeSet<Vec<u16>> {
    let prefixes: Vec<_> = state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
        .map(|v| {
            message(
                "Volume {} could not be projected into standard 3MF: ",
                &[v.id.as_utf16()],
            )
        })
        .collect();
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let mut units: Vec<u16> = row
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            if let Some(prefix) = prefixes.iter().find(|prefix| units.starts_with(prefix)) {
                units.truncate(prefix.len());
                units.extend("<invalid mesh>".encode_utf16());
            }
            units
        })
        .collect()
}
