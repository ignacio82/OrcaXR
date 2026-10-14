//! The File menu's model exports and the names its outputs are offered under,
//! as the browser writes them (`stlExport.ts`, `outputNames.ts`, the project
//! serializer's `suggestedProjectFilename`; hosts' contract
//! `modelExportExchange.ts`):
//!
//! - Export as one STL…: the selected instances on the active plate (else
//!   every instance on it) merged into one binary STL, positive model parts
//!   only, each vertex through its part's and its instance's transforms in
//!   binary64 and stored as binary32, the winding reversed under an odd
//!   number of mirrors, a refusal in the browser's words;
//! - Export all objects as STLs…: one binary STL per instance in the
//!   browser's own deterministic ZIP ([`crate::fflate`]), byte for byte;
//! - Export as 3MF…: the project's package as the browser's serializer
//!   writes it ([`crate::package::write_capture_browser`]: the same members
//!   through fflate's ZIP), byte for byte, offered under the project's name;
//! - the names: a plate's G-code and toolpaths (runs outside
//!   `A–Z a–z 0–9 . _ -` become `_`), and the STL's and project's suggested
//!   file names (controls to `-`, NFKC, the extension and reserved characters
//!   and trailing dots and spaces removed, trimmed, 120 UTF-16 units).
//!
//! NFKC is ICU4X's (Unicode 17); the browser's is its runtime's ICU. They
//! agree on every character both versions encode.
use crate::fflate::Zip;
use icu_normalizer::ComposingNormalizerBorrowed;
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::AssetLease,
    export::ExportCapture,
    ids::AssetId,
    js_math::{self, convert::trim_utf16},
    mesh::{IndexedMesh, decode_indexed},
    model::{
        Encode, ProjectInstance, ProjectObject, ProjectPlate, ProjectState, ProjectVolume,
        Transform, VolumeRole,
    },
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{self, Write},
};

/// The single Download / Export G-code… file.
pub const GCODE_DOWNLOAD_FILENAME: &str = "orcaxr.gcode";
/// File → Export Config…'s file.
pub const CONFIG_EXPORT_FILENAME: &str = "orcaxr_config.json";
/// A request the exchange cannot read.
pub const INVALID_REQUEST: &str = "invalid_request";

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Each run of units outside `keep` becomes one `_`.
fn runs(name: &[u16], keep: impl Fn(u16) -> bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(name.len());
    let mut replacing = false;
    for &unit in name {
        if keep(unit) {
            out.push(unit);
            replacing = false;
        } else if !replacing {
            out.push(u16::from(b'_'));
            replacing = true;
        }
    }
    out
}
fn ascii(unit: u16, extra: &[u8]) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}
fn plate_stem(name: Option<&[u16]>) -> Vec<u16> {
    runs(name.unwrap_or(&units("plate")), |u| ascii(u, b"._-"))
}

/// Download All Plates: `<plate>.gcode` (`plate` for a plate the project no longer has).
pub fn plate_gcode_filename(plate_name: Option<&[u16]>) -> Vec<u16> {
    let mut out = plate_stem(plate_name);
    out.extend(".gcode".encode_utf16());
    out
}

/// File → Export Toolpaths as OBJ…: `<plate>_toolpaths.obj`.
pub fn toolpath_obj_filename(plate_name: Option<&[u16]>) -> Vec<u16> {
    let mut out = plate_stem(plate_name);
    out.extend("_toolpaths.obj".encode_utf16());
    out
}

/// `String.prototype.normalize('NFKC')`: a lone surrogate is a starter with
/// no decomposition that nothing composes with, so the text either side of
/// one normalizes alone.
fn nfkc(text: &[u16]) -> Vec<u16> {
    let normalizer = ComposingNormalizerBorrowed::new_nfkc();
    let mut out = Vec::with_capacity(text.len());
    for piece in char::decode_utf16(text.iter().copied())
        .collect::<Vec<_>>()
        .split_inclusive(Result::is_err)
    {
        let (valid, lone) = match piece.split_last() {
            Some((Err(e), rest)) => (rest, Some(e.unpaired_surrogate())),
            _ => (piece, None),
        };
        let chunk: String = valid.iter().map(|c| *c.as_ref().expect("valid")).collect();
        out.extend(normalizer.normalize(&chunk).encode_utf16());
        out.extend(lone);
    }
    out
}

/// `suggestedStlFilename` / `suggestedProjectFilename`.
fn suggested(name: &[u16], extension: &str, fallback: &str) -> Vec<u16> {
    let without_controls: Vec<u16> = name
        .iter()
        .map(|&u| if u <= 0x1f { u16::from(b'-') } else { u })
        .collect();
    let mut stem = nfkc(&without_controls);
    // `.replace(/\.<extension>$/i, '')`: the case-folding of a non-Unicode regex is ASCII.
    let dotted = units(&format!(".{extension}"));
    if stem.len() >= dotted.len()
        && stem[stem.len() - dotted.len()..]
            .iter()
            .zip(&dotted)
            .all(|(a, b)| u8::try_from(*a).is_ok_and(|a| a.eq_ignore_ascii_case(&(*b as u8))))
    {
        stem.truncate(stem.len() - dotted.len());
    }
    for unit in &mut stem {
        if u8::try_from(*unit).is_ok_and(|b| b"<>:\"/\\|?*".contains(&b)) {
            *unit = u16::from(b'-');
        }
    }
    while stem
        .last()
        .is_some_and(|&u| u == u16::from(b'.') || u == u16::from(b' '))
    {
        stem.pop();
    }
    let trimmed = trim_utf16(&stem);
    let mut out = trimmed[..trimmed.len().min(120)].to_vec();
    if out.is_empty() {
        out = units(fallback);
    }
    out.extend(dotted);
    out
}

/// The name a merged STL is offered under.
pub fn suggested_stl_filename(name: &[u16]) -> Vec<u16> {
    suggested(name, "stl", "OrcaXR-model")
}

/// The name a saved (or exported) project is offered under.
pub fn suggested_project_filename(name: &[u16]) -> Vec<u16> {
    suggested(name, "3mf", "OrcaXR-project")
}

/// A ZIP member's or archive's stem: runs outside `a–z A–Z 0–9 _ -` become
/// `_`, none at either end, else [fallback].
fn archive_stem(name: &[u16], fallback: &str) -> Vec<u16> {
    let replaced = runs(name, |u| ascii(u, b"_-"));
    let underscore = u16::from(b'_');
    let start = replaced
        .iter()
        .position(|&u| u != underscore)
        .unwrap_or(replaced.len());
    let end = replaced
        .iter()
        .rposition(|&u| u != underscore)
        .map_or(start, |i| i + 1);
    if start == end {
        units(fallback)
    } else {
        replaced[start..end].to_vec()
    }
}

/// An instance ID as UTF-16 text: any text a host names, an unknown one matching nothing.
pub type InstanceText = Vec<u16>;

/// `findInstance`.
fn find<'a>(
    state: &'a ProjectState,
    id: &[u16],
) -> Option<(&'a ProjectPlate, &'a ProjectObject, &'a ProjectInstance)> {
    state.plates.iter().find_map(|plate| {
        plate.objects.iter().find_map(|object| {
            object
                .instances
                .iter()
                .find(|i| i.id.as_utf16() == id)
                .map(|i| (&**plate, &**object, &**i))
        })
    })
}

fn find_volume<'a>(
    state: &'a ProjectState,
    id: &[u16],
) -> Option<(&'a ProjectPlate, &'a ProjectObject, &'a ProjectVolume)> {
    state.plates.iter().find_map(|plate| {
        plate.objects.iter().find_map(|object| {
            object
                .volumes
                .iter()
                .find(|v| v.id.as_utf16() == id)
                .map(|v| (&**plate, &**object, &**v))
        })
    })
}

/// The selected instances on the active plate, in selection order (repeats kept).
pub fn selected_active_plate_instances(
    state: &ProjectState,
    selected: &[InstanceText],
) -> Vec<InstanceText> {
    selected
        .iter()
        .filter(|id| find(state, id).is_some_and(|(plate, _, _)| plate.id == state.active_plate_id))
        .cloned()
        .collect()
}

/// Every instance on the active plate, in plate order.
pub fn active_plate_instances(state: &ProjectState) -> Vec<InstanceText> {
    state
        .plates
        .iter()
        .find(|plate| plate.id == state.active_plate_id)
        .map(|plate| {
            plate
                .objects
                .iter()
                .flat_map(|o| o.instances.iter().map(|i| i.id.as_utf16().to_vec()))
                .collect()
        })
        .unwrap_or_default()
}

/// File → Export as one STL…'s instances: the selected ones on the active plate, else all of it.
pub fn stl_export_instances(state: &ProjectState, selected: &[InstanceText]) -> Vec<InstanceText> {
    let chosen = selected_active_plate_instances(state, selected);
    if chosen.is_empty() {
        active_plate_instances(state)
    } else {
        chosen
    }
}

/// Why an export wrote nothing: the browser's refusal, or the destination's failure.
#[derive(Debug)]
pub enum Failure {
    Refused(Vec<u16>),
    Io(io::Error),
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
fn refused(parts: &[&[u16]]) -> Failure {
    Failure::Refused(parts.concat())
}
fn refuse(text: &str) -> Failure {
    Failure::Refused(units(text))
}

/// A written export: what the File menu says of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Exported {
    pub filename: Vec<u16>,
    pub media_type: &'static str,
    pub triangle_count: u64,
    pub instance_count: u64,
    /// The instances it holds, as chosen.
    pub instance_ids: Vec<InstanceText>,
    /// The file's length.
    pub bytes: u64,
}

/// One part of one instance, ready to write.
struct Prepared {
    asset: usize,
    volume: [f64; 4],
    instance: [f64; 4],
    volume_transform: Transform,
    instance_transform: Transform,
    reverse: bool,
}

fn handedness(transform: &Transform) -> f64 {
    let s = transform.scale.map(|v| v.get());
    if s[0] * s[1] * s[2] < 0.0 { -1.0 } else { 1.0 }
}

/// `rotateVector`'s normalized quaternion, or the browser's refusal.
fn unit_quaternion(transform: &Transform) -> Result<[f64; 4], Failure> {
    let q = transform.rotation.map(|v| v.get());
    let length = js_math::hypot(&q);
    if !length.is_finite() || length == 0.0 {
        return Err(refuse("A canonical transform quaternion must be non-zero"));
    }
    Ok(q.map(|v| v / length))
}

/// `applyTransform`: scale, rotate (`rotateVector`), translate.
fn apply(point: [f64; 3], transform: &Transform, [x, y, z, w]: [f64; 4]) -> [f64; 3] {
    let s = transform.scale.map(|v| v.get());
    let t = transform.translation_mm.map(|v| v.get());
    let v = [point[0] * s[0], point[1] * s[1], point[2] * s[2]];
    let uv = [
        y * v[2] - z * v[1],
        z * v[0] - x * v[2],
        x * v[1] - y * v[0],
    ];
    let uuv = [
        y * uv[2] - z * uv[1],
        z * uv[0] - x * uv[2],
        x * uv[1] - y * uv[0],
    ];
    let rotated = [
        v[0] + 2.0 * (w * uv[0] + uuv[0]),
        v[1] + 2.0 * (w * uv[1] + uuv[1]),
        v[2] + 2.0 * (w * uv[2] + uuv[2]),
    ];
    [rotated[0] + t[0], rotated[1] + t[1], rotated[2] + t[2]]
}

/// `triangleNormal`: unit, `-0` written as `0`, a degenerate triangle's zero.
fn normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let l = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let r = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        l[1] * r[2] - l[2] * r[1],
        l[2] * r[0] - l[0] * r[2],
        l[0] * r[1] - l[1] * r[0],
    ];
    let length = js_math::hypot(&n);
    if length == 0.0 {
        return [0.0; 3];
    }
    n.map(|v| {
        let v = v / length;
        if v == 0.0 { 0.0 } else { v }
    })
}

const HEADER: &[u8] = b"OrcaXR canonical binary STL";

/// `exportCanonicalInstancesAsBinaryStl`: [instance_ids] merged into one
/// binary STL written to [out]; answers its triangle count. Every refusal
/// precedes the first byte written.
pub fn write_binary_stl(
    state: &ProjectState,
    assets: &dyn Fn(&AssetId) -> Option<AssetLease>,
    instance_ids: &[InstanceText],
    out: &mut dyn Write,
) -> Result<u64, Failure> {
    if instance_ids.is_empty() {
        return Err(refuse("STL export requires at least one instance"));
    }
    let descriptors: HashMap<&[u16], _> = state
        .source_assets
        .iter()
        .map(|d| (d.id.as_utf16(), d))
        .collect();
    let mut seen = HashSet::new();
    let mut meshes: Vec<IndexedMesh> = Vec::new();
    let mut decoded: HashMap<Vec<u16>, usize> = HashMap::new();
    let mut prepared: Vec<Prepared> = Vec::new();
    let mut triangles: u64 = 0;
    for id in instance_ids {
        if !seen.insert(id.as_slice()) {
            return Err(refused(&[
                &units("STL export contains duplicate instance "),
                id,
            ]));
        }
        let Some((_, object, instance)) = find(state, id) else {
            return Err(refused(&[&units("Unknown instance "), id]));
        };
        for volume in object.volumes.iter() {
            if volume.role == VolumeRole::NegativeVolume {
                return Err(refused(&[
                    &units("Volume "),
                    volume.id.as_utf16(),
                    &units(" requires canonical CSG before STL export"),
                ]));
            }
            if volume.role != VolumeRole::Model {
                continue;
            }
            let asset_id = &volume.source.asset_id;
            let descriptor = descriptors.get(asset_id.as_utf16());
            let payload = assets(asset_id);
            let (Some(descriptor), Some(payload)) = (descriptor, payload) else {
                return Err(refused(&[
                    &units("Volume "),
                    volume.id.as_utf16(),
                    &units(" references missing asset "),
                    asset_id.as_utf16(),
                ]));
            };
            if descriptor.to_value().ok().as_ref() != Some(payload.descriptor()) {
                return Err(refused(&[
                    &units("Asset repository metadata differs for "),
                    asset_id.as_utf16(),
                ]));
            }
            let mesh = match decoded.get(asset_id.as_utf16()) {
                Some(&index) => index,
                None => {
                    let mesh = decode_indexed(&payload)
                        .map_err(|message| Failure::Refused(units(&message)))?;
                    meshes.push(mesh);
                    decoded.insert(asset_id.as_utf16().to_vec(), meshes.len() - 1);
                    meshes.len() - 1
                }
            };
            let count = (meshes[mesh].indices.len() / 3) as u64;
            if count as f64 != volume.source.triangle_count.get() {
                return Err(refused(&[
                    &units("Volume "),
                    volume.id.as_utf16(),
                    &units(" triangle count differs from its canonical mesh"),
                ]));
            }
            triangles += count;
            if triangles > 0xffff_ffff {
                return Err(refuse("Binary STL triangle count exceeds the format limit"));
            }
            prepared.push(Prepared {
                asset: mesh,
                volume: [0.0; 4],
                instance: [0.0; 4],
                volume_transform: volume.transform.clone(),
                instance_transform: instance.transform.clone(),
                reverse: handedness(&volume.transform) * handedness(&instance.transform) < 0.0,
            });
        }
    }
    if triangles == 0 {
        return Err(refuse(
            "Selected instances contain no positive model triangles",
        ));
    }
    // The browser normalizes each quaternion as it writes the first vertex it moves.
    for part in &mut prepared {
        if !meshes[part.asset].indices.is_empty() {
            part.volume = unit_quaternion(&part.volume_transform)?;
            part.instance = unit_quaternion(&part.instance_transform)?;
        }
    }
    let mut buffer = Vec::with_capacity(65_536);
    let mut header = [0u8; 84];
    header[..HEADER.len()].copy_from_slice(HEADER);
    header[80..].copy_from_slice(&(triangles as u32).to_le_bytes());
    buffer.extend_from_slice(&header);
    for part in &prepared {
        let mesh = &meshes[part.asset];
        let moved: Vec<[f64; 3]> = mesh
            .positions
            .iter()
            .map(|&p| {
                apply(
                    apply(p, &part.volume_transform, part.volume),
                    &part.instance_transform,
                    part.instance,
                )
            })
            .collect();
        for triangle in mesh.indices.chunks_exact(3) {
            let (second, third) = if part.reverse {
                (triangle[2], triangle[1])
            } else {
                (triangle[1], triangle[2])
            };
            let a = moved[triangle[0] as usize];
            let b = moved[second as usize];
            let c = moved[third as usize];
            for vector in [normal(a, b, c), a, b, c] {
                for value in vector {
                    buffer.extend_from_slice(&(value as f32).to_le_bytes());
                }
            }
            buffer.extend_from_slice(&[0, 0]);
            if buffer.len() >= 65_536 - 50 {
                out.write_all(&buffer)?;
                buffer.clear();
            }
        }
    }
    out.write_all(&buffer)?;
    Ok(triangles)
}

/// Write a single volume's canonical mesh as a binary STL in volume-local coordinates
/// (no volume or instance transforms applied). Answers its triangle count.
pub fn write_volume_binary_stl(
    state: &ProjectState,
    assets: &dyn Fn(&AssetId) -> Option<AssetLease>,
    volume_id: &[u16],
    out: &mut dyn Write,
) -> Result<u64, Failure> {
    let Some((_, _object, volume)) = find_volume(state, volume_id) else {
        return Err(refused(&[&units("Unknown volume "), volume_id]));
    };
    if volume.role == VolumeRole::NegativeVolume {
        return Err(refused(&[
            &units("Volume "),
            volume.id.as_utf16(),
            &units(" requires canonical CSG before STL export"),
        ]));
    }
    if volume.role != VolumeRole::Model {
        return Err(refuse("Repair requires a model volume"));
    }
    let asset_id = &volume.source.asset_id;
    let descriptors: HashMap<&[u16], _> = state
        .source_assets
        .iter()
        .map(|d| (d.id.as_utf16(), d))
        .collect();
    let descriptor = descriptors.get(asset_id.as_utf16());
    let payload = assets(asset_id);
    let (Some(descriptor), Some(payload)) = (descriptor, payload) else {
        return Err(refused(&[
            &units("Volume "),
            volume.id.as_utf16(),
            &units(" references missing asset "),
            asset_id.as_utf16(),
        ]));
    };
    if descriptor.to_value().ok().as_ref() != Some(payload.descriptor()) {
        return Err(refused(&[
            &units("Asset repository metadata differs for "),
            asset_id.as_utf16(),
        ]));
    }
    let mesh = decode_indexed(&payload)
        .map_err(|message| Failure::Refused(units(&message)))?;
    let triangles = (mesh.indices.len() / 3) as u64;
    if triangles as f64 != volume.source.triangle_count.get() {
        return Err(refused(&[
            &units("Volume "),
            volume.id.as_utf16(),
            &units(" triangle count differs from its canonical mesh"),
        ]));
    }
    if triangles == 0 {
        return Err(refuse("Volume contains no positive model triangles"));
    }
    if triangles > 0xffff_ffff {
        return Err(refuse("Binary STL triangle count exceeds the format limit"));
    }
    let mut buffer = Vec::with_capacity(65_536);
    let mut header = [0u8; 84];
    header[..HEADER.len()].copy_from_slice(HEADER);
    header[80..].copy_from_slice(&(triangles as u32).to_le_bytes());
    buffer.extend_from_slice(&header);
    for triangle in mesh.indices.chunks_exact(3) {
        let a = mesh.positions[triangle[0] as usize];
        let b = mesh.positions[triangle[1] as usize];
        let c = mesh.positions[triangle[2] as usize];
        for vector in [normal(a, b, c), a, b, c] {
            for value in vector {
                buffer.extend_from_slice(&(value as f32).to_le_bytes());
            }
        }
        buffer.extend_from_slice(&[0, 0]);
        if buffer.len() >= 65_536 - 50 {
            out.write_all(&buffer)?;
            buffer.clear();
        }
    }
    out.write_all(&buffer)?;
    Ok(triangles)
}

/// File → Export as one STL…: [instance_ids] as one STL under the browser's name.
pub fn write_stl_file(
    state: &ProjectState,
    assets: &dyn Fn(&AssetId) -> Option<AssetLease>,
    instance_ids: &[InstanceText],
    out: &mut dyn Write,
) -> Result<Exported, Failure> {
    let triangles = write_binary_stl(state, assets, instance_ids, out)?;
    let single = if instance_ids.len() == 1 {
        find(state, &instance_ids[0])
    } else {
        None
    };
    let name = match single {
        Some((_, object, instance)) => instance.name.as_ref().unwrap_or(&object.name).units(),
        None => state.name.units(),
    };
    Ok(Exported {
        filename: suggested_stl_filename(name),
        media_type: "model/stl",
        triangle_count: triangles,
        instance_count: instance_ids.len() as u64,
        instance_ids: instance_ids.to_vec(),
        bytes: 84 + 50 * triangles,
    })
}

/// File → Export all objects as STLs…: [instance_ids] (none: the active
/// plate's) one STL each in the browser's ZIP, written to [out]; a lone
/// instance is its own STL.
pub fn write_stl_archive(
    state: &ProjectState,
    assets: &dyn Fn(&AssetId) -> Option<AssetLease>,
    instance_ids: &[InstanceText],
    out: &mut dyn Write,
) -> Result<Exported, Failure> {
    let ids = if instance_ids.is_empty() {
        active_plate_instances(state)
    } else {
        instance_ids.to_vec()
    };
    if ids.is_empty() {
        return Err(refuse("No models to export"));
    }
    if ids.len() == 1 {
        return write_stl_file(state, assets, &ids, out);
    }
    let mut zip = Zip::default();
    let mut used: HashSet<Vec<u16>> = HashSet::new();
    let mut triangles = 0;
    for id in &ids {
        let Some((_, object, instance)) = find(state, id) else {
            continue;
        };
        // `instance.name || object.name || 'model'`.
        let model = units("model");
        let name = [
            instance.name.as_ref().map_or(&[][..], |n| n.units()),
            object.name.units(),
            &model,
        ]
        .into_iter()
        .find(|n| !n.is_empty())
        .unwrap_or(&model);
        let base = archive_stem(name, "model");
        let member = |counter: Option<u32>| {
            let mut file = base.clone();
            if let Some(counter) = counter {
                file.extend(format!("_{counter}").encode_utf16());
            }
            file.extend(".stl".encode_utf16());
            file
        };
        // Member names are ASCII, so `toLowerCase` is ASCII.
        let lower = |file: &[u16]| {
            file.iter()
                .map(|&u| u8::try_from(u).map_or(u, |b| u16::from(b.to_ascii_lowercase())))
                .collect::<Vec<_>>()
        };
        let mut filename = member(None);
        let mut counter = 2;
        while used.contains(&lower(&filename)) {
            filename = member(Some(counter));
            counter += 1;
        }
        used.insert(lower(&filename));
        let mut bytes = Vec::new();
        triangles += write_binary_stl(state, assets, std::slice::from_ref(id), &mut bytes)?;
        let path = String::from_utf16(&filename).expect("ASCII member names");
        zip.add(&path, &bytes)
            .map_err(|e| Failure::Io(io::Error::other(e)))?;
    }
    let mut stem_source = state.name.units();
    let models = units("models");
    if stem_source.is_empty() {
        stem_source = &models;
    }
    let mut filename = archive_stem(stem_source, "models");
    filename.extend("_stls.zip".encode_utf16());
    let bytes = zip.finish(out).map_err(|e| match e {
        crate::Error::Io(kind) => Failure::Io(kind.into()),
        other => Failure::Io(io::Error::other(other)),
    })?;
    Ok(Exported {
        filename,
        media_type: "application/zip",
        triangle_count: triangles,
        instance_count: ids.len() as u64,
        instance_ids: ids,
        bytes,
    })
}

/// What an STL export request asks for (`modelExportExchange.ts`'s `{"archive","selectedInstanceIds"}`).
#[derive(Debug, Clone, PartialEq)]
pub struct StlRequest {
    pub archive: bool,
    pub selected: Vec<InstanceText>,
}

fn fields(request: &str, keys: &[&str]) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INVALID_REQUEST);
    }
    let Ok(Value::Object(fields)) = parse(request) else {
        return Err(INVALID_REQUEST);
    };
    if fields.len() != keys.len() || keys.iter().any(|k| !fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}

impl StlRequest {
    pub fn parse(request: &str) -> Result<Self, &'static str> {
        let fields = fields(request, &["archive", "selectedInstanceIds"])?;
        let Some(Value::Bool(archive)) = fields.get(&units("archive")) else {
            return Err(INVALID_REQUEST);
        };
        let Some(Value::Array(selected)) = fields.get(&units("selectedInstanceIds")) else {
            return Err(INVALID_REQUEST);
        };
        let selected = selected
            .iter()
            .map(|id| match id {
                Value::String(units) => Ok(units.clone()),
                _ => Err(INVALID_REQUEST),
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            archive: *archive,
            selected,
        })
    }
}

/// One STL export of [state]: the file to [out] and what to say of it, or the browser's refusal.
pub fn export_stl(
    state: &ProjectState,
    assets: &dyn Fn(&AssetId) -> Option<AssetLease>,
    request: &StlRequest,
    out: &mut dyn Write,
) -> Result<Exported, Failure> {
    if request.archive {
        let chosen = selected_active_plate_instances(state, &request.selected);
        write_stl_archive(state, assets, &chosen, out)
    } else {
        write_stl_file(
            state,
            assets,
            &stl_export_instances(state, &request.selected),
            out,
        )
    }
}

fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes).expect("canonical JSON is UTF-8")
}
fn object<const N: usize>(members: [(&str, Value); N]) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}

/// The exchange's reply for an export's outcome (an I/O failure is the host's, never a reply).
pub fn stl_reply(outcome: &Result<Exported, Failure>) -> Option<String> {
    match outcome {
        Ok(exported) => Some(canonical(&object([
            ("filename", Value::String(exported.filename.clone())),
            (
                "instanceCount",
                Value::Number(exported.instance_count as f64),
            ),
            (
                "instanceIds",
                Value::Array(
                    exported
                        .instance_ids
                        .iter()
                        .map(|id| Value::String(id.clone()))
                        .collect(),
                ),
            ),
            ("mediaType", Value::String(units(exported.media_type))),
            (
                "triangleCount",
                Value::Number(exported.triangle_count as f64),
            ),
        ]))),
        Err(Failure::Refused(message)) => Some(canonical(&object([(
            "error",
            Value::String(message.clone()),
        )]))),
        Err(Failure::Io(_)) => None,
    }
}

/// The exchange's reply for volume STL export: `{"triangleCount":...}` or `{"error":"..."}`.
pub fn volume_stl_reply(outcome: &Result<u64, Failure>) -> Option<String> {
    match outcome {
        Ok(triangles) => Some(canonical(&object([
            ("triangleCount", Value::Number(*triangles as f64)),
        ]))),
        Err(Failure::Refused(message)) => Some(canonical(&object([(
            "error",
            Value::String(message.clone()),
        )]))),
        Err(Failure::Io(_)) => None,
    }
}

/// `stlExportExchange` on a captured project: the reply, with the file in [out].
pub fn stl_export_json(
    capture: &ExportCapture,
    request: &str,
    out: &mut dyn Write,
) -> Result<String, &'static str> {
    let request = StlRequest::parse(request)?;
    let outcome = export_stl(
        capture.project().state(),
        &|id| capture.asset_by_id(id),
        &request,
        out,
    );
    stl_reply(&outcome).ok_or("export_io")
}

/// Export as 3MF… of [capture]: the browser's package to [out], under
/// [limits] (the browser's archive budgets), and the reply
/// `{"filename","mediaType","warnings"}` — the serializer's sorted, unique
/// warnings — or `{"refused":<code>}` for a project the browser refuses to
/// save too (a refusal precedes the first byte). An I/O failure of [out] is
/// the host's, never a reply.
pub fn project_archive_json(
    capture: &ExportCapture,
    limits: crate::package::Limits,
    out: &mut dyn Write,
) -> Result<String, crate::package::Error> {
    let state = capture.project().state();
    match crate::package::write_capture_browser(capture, out, limits, || false) {
        Ok(receipt) => Ok(canonical(&object([
            (
                "filename",
                Value::String(suggested_project_filename(state.name.units())),
            ),
            ("mediaType", Value::String(units("model/3mf"))),
            (
                "warnings",
                Value::Array(
                    crate::text::package_warnings(state, &receipt.warnings)
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            ),
        ]))),
        Err(crate::package::Error::Io(kind)) => Err(crate::package::Error::Io(kind)),
        Err(crate::package::Error::Zip(crate::Error::Io(kind))) => {
            Err(crate::package::Error::Io(kind))
        }
        Err(error) => Ok(canonical(&object([(
            "refused",
            Value::String(units(crate::policy::save_code(error))),
        )]))),
    }
}

/// `exportNameExchange`: `{"kind","name"}` → `{"filename"}`.
pub fn export_name_json(request: &str) -> Result<String, &'static str> {
    let fields = fields(request, &["kind", "name"])?;
    let name = match fields.get(&units("name")) {
        Some(Value::String(name)) => Some(name.as_slice()),
        Some(Value::Null) => None,
        _ => return Err(INVALID_REQUEST),
    };
    let Some(Value::String(kind)) = fields.get(&units("kind")) else {
        return Err(INVALID_REQUEST);
    };
    let filename = match String::from_utf16(kind).as_deref() {
        Ok("plate-gcode") => plate_gcode_filename(name),
        Ok("toolpath-obj") => toolpath_obj_filename(name),
        Ok("stl") => suggested_stl_filename(name.ok_or(INVALID_REQUEST)?),
        Ok("project") => suggested_project_filename(name.ok_or(INVALID_REQUEST)?),
        _ => return Err(INVALID_REQUEST),
    };
    Ok(canonical(&object([("filename", Value::String(filename))])))
}

/// Export Diagnostics…'s project shape (`diagnosticsProjectSummaryOf`):
/// counts and object names, never geometry, as canonical JSON
/// `{"mixedFilamentCount","objectCount","objectNames","paintedVolumeCount",
/// "physicalFilamentCount","plateCount","triangleCount","volumeCount"}`.
pub fn diagnostics_summary_json(state: &ProjectState) -> String {
    let objects: Vec<&ProjectObject> = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter().map(|object| &**object))
        .collect();
    let volumes: Vec<_> = objects
        .iter()
        .flat_map(|object| object.volumes.iter())
        .collect();
    let painted = volumes
        .iter()
        .filter(
            |volume| matches!(volume.annotations.color.value(), Value::Array(a) if !a.is_empty()),
        )
        .count();
    let count = |n: usize| Value::Number(n as f64);
    canonical(&object([
        ("mixedFilamentCount", count(state.filaments.mixed.len())),
        ("objectCount", count(objects.len())),
        (
            "objectNames",
            Value::Array(
                objects
                    .iter()
                    .map(|o| Value::String(o.name.units().to_vec()))
                    .collect(),
            ),
        ),
        ("paintedVolumeCount", count(painted)),
        (
            "physicalFilamentCount",
            count(state.filaments.physical.len()),
        ),
        ("plateCount", count(state.plates.len())),
        (
            "triangleCount",
            // `reduce((total, volume) => total + volume.source.triangleCount, 0)`.
            Value::Number(
                volumes
                    .iter()
                    .fold(0.0, |total, v| total + v.source.triangle_count.get()),
            ),
        ),
        ("volumeCount", count(volumes.len())),
    ]))
}
