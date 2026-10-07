//! Stage decoded models as a merge into an open project (`ModelImportParser`):
//! unit scaling, packed mesh assets with deduplication against the project's
//! existing meshes, unique object names, bed placement, provenance extension
//! data and the decoder's notices as import repairs, dropped fields and
//! diagnostics. Staging is private: the host previews and commits it later.
use super::{Decoded, Format, Malformed, NoticeKind, Role, Transform, text::Message};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::AssetPayload,
    ids::AssetId,
    mesh::{self, Coordinates, EncodeOptions},
    model::{AssetOrigin, AssetProvenance, Decode, Encode, ExtraFields, ProjectState, Text},
};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

/// Kinds requested from the host's stable-ID source, in request order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdKind {
    Asset,
    Volume,
    Object,
    Instance,
}
impl IdKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Volume => "volume",
            Self::Object => "object",
            Self::Instance => "instance",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Placement {
    /// Printable area in millimetres; the import is centred on it as a group.
    pub bed_size_mm: Option<[f64; 2]>,
    /// Rest the import on the bed instead of keeping its source Z.
    pub drop_to_bed: bool,
}

/// A staged merge: the complete candidate state, the new asset payloads (the
/// project's existing payloads are unchanged) and canonical-JSON notice lists.
#[derive(Clone)]
pub struct Staged {
    pub state: ProjectState,
    pub new_assets: Vec<AssetPayload>,
    pub imported_asset_ids: Vec<AssetId>,
    pub repairs: Vec<Value>,
    pub dropped_fields: Vec<Value>,
    pub diagnostics: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageError {
    /// The decoded import produced nothing the project can hold.
    Malformed(Malformed, Format),
    /// The open project has no plate to import into.
    NoPlate,
    /// A decoded mesh cannot be encoded as a canonical asset (for example a
    /// coordinate beyond the Float32 range) or an ID is not stable.
    Encoding,
    /// The staged candidate does not decode as a project.
    State,
    Cancelled,
}

fn s(text: &str) -> Value {
    Value::String(text.encode_utf16().collect())
}
fn u(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn n(value: f64) -> Value {
    Value::Number(value)
}
fn record<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&key(name)),
        _ => None,
    }
}
fn transform_value(t: &Transform) -> Value {
    record([
        (
            "translationMm",
            Value::Array(t.translation_mm.iter().map(|v| n(*v)).collect()),
        ),
        (
            "rotation",
            Value::Array(t.rotation.iter().map(|v| n(*v)).collect()),
        ),
        (
            "scale",
            Value::Array(t.scale.iter().map(|v| n(*v)).collect()),
        ),
    ])
}

struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    min_z: f64,
}
const ZERO: Bounds = Bounds {
    min_x: 0.0,
    max_x: 0.0,
    min_y: 0.0,
    max_y: 0.0,
    min_z: 0.0,
};

/// Bounds of every decoded object including its instance offsets, in mm.
fn import_bounds(decoded: &Decoded) -> Bounds {
    let scale = decoded.unit_scale_to_mm;
    let mut bounds: Option<Bounds> = None;
    for object in &decoded.objects {
        let local = object_bounds(object, scale);
        for instance in &object.instances {
            let [x, y, z] = instance.translation_mm.map(|v| v * scale);
            let shifted = Bounds {
                min_x: local.min_x + x,
                max_x: local.max_x + x,
                min_y: local.min_y + y,
                max_y: local.max_y + y,
                min_z: local.min_z + z,
            };
            bounds = Some(match bounds {
                None => shifted,
                Some(b) => Bounds {
                    min_x: js_min(b.min_x, shifted.min_x),
                    max_x: js_max(b.max_x, shifted.max_x),
                    min_y: js_min(b.min_y, shifted.min_y),
                    max_y: js_max(b.max_y, shifted.max_y),
                    min_z: js_min(b.min_z, shifted.min_z),
                },
            });
        }
    }
    bounds.unwrap_or(ZERO)
}
/// `Math.min`/`Math.max`: NaN wins and -0 orders below +0.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else {
        a.min(b)
    }
}
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else {
        a.max(b)
    }
}
fn object_bounds(object: &super::Object, scale: f64) -> Bounds {
    let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut min_z = f64::INFINITY;
    for volume in &object.volumes {
        for p in volume.mesh.positions.chunks_exact(3) {
            let (x, y, z) = (
                f64::from(p[0]) * scale,
                f64::from(p[1]) * scale,
                f64::from(p[2]) * scale,
            );
            if x < min_x {
                min_x = x;
            }
            if x > max_x {
                max_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if y > max_y {
                max_y = y;
            }
            if z < min_z {
                min_z = z;
            }
        }
    }
    if !min_x.is_finite() {
        return ZERO;
    }
    Bounds {
        min_x,
        max_x,
        min_y,
        max_y,
        min_z,
    }
}

fn unique_name(name: &[u16], used: &HashSet<Vec<u16>>, index: usize) -> Vec<u16> {
    if !used.contains(name) {
        return name.to_vec();
    }
    for attempt in 2..1000 {
        let candidate = Message::default()
            .u(name)
            .s(" (")
            .n(f64::from(attempt))
            .s(")")
            .done();
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    Message::default()
        .u(name)
        .s(" (")
        .n((index + 1) as f64)
        .s("-")
        .n((used.len() + 1) as f64)
        .s(")")
        .done()
}

/// Stage `decoded` into `base`. `existing` holds the project's current asset
/// descriptors (for mesh deduplication); `next_id` is the host's stable-ID source.
pub fn stage(
    decoded: &Decoded,
    base: &ProjectState,
    existing: &[Value],
    imported_at: &[u16],
    placement: Placement,
    next_id: &mut dyn FnMut(IdKind) -> Vec<u16>,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Staged, StageError> {
    let mut state = base.to_value().map_err(|_| StageError::State)?;
    let Value::Object(root) = &mut state else {
        return Err(StageError::State);
    };
    let active = root.get(&key("activePlateId")).cloned();
    let Some(Value::Array(plates)) = root.get(&key("plates")) else {
        return Err(StageError::State);
    };
    let plate_index = plates
        .iter()
        .position(|p| field(p, "id") == active.as_ref())
        .or_else(|| (!plates.is_empty()).then_some(0))
        .ok_or(StageError::NoPlate)?;
    let plate_id = match field(&plates[plate_index], "id") {
        Some(Value::String(id)) => id.clone(),
        _ => return Err(StageError::State),
    };
    let mut used: HashSet<Vec<u16>> = plates
        .iter()
        .filter_map(|p| match field(p, "objects") {
            Some(Value::Array(objects)) => Some(objects),
            _ => None,
        })
        .flatten()
        .filter_map(|o| match field(o, "name") {
            Some(Value::String(name)) => Some(name.clone()),
            _ => None,
        })
        .collect();

    // Candidate meshes: existing payloads, then those this import adds.
    let mut meshes: Vec<(Value, Vec<u16>)> = existing
        .iter()
        .filter(|d| field(d, "kind") == Some(&s("mesh")))
        .filter_map(|d| match (field(d, "digest"), field(d, "id")) {
            (Some(digest), Some(Value::String(id))) => Some((
                record([
                    ("digest", digest.clone()),
                    ("mesh", field(d, "mesh").cloned().unwrap_or(Value::Null)),
                ]),
                id.clone(),
            )),
            _ => None,
        })
        .collect();
    let mut new_assets = Vec::new();
    let mut new_descriptors = Vec::new();
    let mut imported = Vec::new();
    let mut repairs = Vec::new();
    let mut dropped = Vec::new();
    let mut diagnostics = Vec::new();
    let mut staged_objects = Vec::new();
    let bounds = import_bounds(decoded);
    let mut notice_index = 0usize;
    let mut next_notice = |prefix: &str| {
        notice_index += 1;
        Message::new("model-import-")
            .s(prefix)
            .s("-")
            .n(notice_index as f64)
            .done()
    };
    let provenance = Arc::new(AssetProvenance {
        source: AssetOrigin::Import,
        uri: None,
        imported_at: Some(Text::new(imported_at.to_vec())),
        extra: ExtraFields::default(),
    });
    let encode_limits = mesh::Limits {
        asset_bytes: usize::MAX,
        vertices: usize::MAX,
        indices: usize::MAX,
    };
    let scale = decoded.unit_scale_to_mm;

    for (object_index, object) in decoded.objects.iter().enumerate() {
        if cancelled() {
            return Err(StageError::Cancelled);
        }
        let mut volumes = Vec::new();
        for volume in &object.volumes {
            let scaled: Vec<f32>;
            let positions = if scale == 1.0 {
                &volume.mesh.positions
            } else {
                scaled = volume
                    .mesh
                    .positions
                    .iter()
                    .map(|&p| (f64::from(p) * scale) as f32)
                    .collect();
                &scaled
            };
            let encode =
                |id: AssetId, filename: Option<Text>, provenance: Option<Arc<AssetProvenance>>| {
                    mesh::encode(
                        EncodeOptions {
                            id,
                            source_filename: filename,
                            provenance,
                            metadata_bytes: usize::MAX,
                        },
                        Coordinates::Float32(positions),
                        Some(&volume.mesh.indices),
                        encode_limits,
                        || false,
                    )
                    .map_err(|_| StageError::Encoding)
                };
            let staging_id = AssetId::try_from_utf16(key("import:staging:mesh"))
                .map_err(|_| StageError::Encoding)?;
            let staging = encode(staging_id, None, None)?;
            let identity = record([
                (
                    "digest",
                    field(&staging.descriptor, "digest")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                (
                    "mesh",
                    field(&staging.descriptor, "mesh")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
            ]);
            let (asset_id, triangles) = match meshes.iter().find(|(m, _)| *m == identity) {
                Some((m, id)) => {
                    repairs.push(record([
                        ("id", u(&next_notice("dedup"))),
                        ("kind", s("asset-deduplication")),
                        (
                            "path",
                            u(&Message::new("$.plates[")
                                .u(&plate_id)
                                .s("].objects[")
                                .u(&object.name)
                                .s("].volumes[")
                                .u(&volume.name)
                                .s("]")
                                .done()),
                        ),
                        (
                            "message",
                            u(
                                &Message::new("Reused the identical mesh already stored as ")
                                    .u(id)
                                    .done(),
                            ),
                        ),
                        ("requiresConfirmation", Value::Bool(false)),
                    ]));
                    (
                        id.clone(),
                        field(field(m, "mesh").unwrap_or(&Value::Null), "triangleCount").cloned(),
                    )
                }
                None => {
                    let id = next_id(IdKind::Asset);
                    let asset_id =
                        AssetId::try_from_utf16(id.clone()).map_err(|_| StageError::Encoding)?;
                    // An empty filename is omitted, like the browser's spread.
                    let filename =
                        (!decoded.filename.is_empty()).then(|| Text::new(decoded.filename.clone()));
                    let payload = encode(asset_id, filename, Some(provenance.clone()))?;
                    meshes.push((identity, id.clone()));
                    let triangles = field(
                        field(&payload.descriptor, "mesh").unwrap_or(&Value::Null),
                        "triangleCount",
                    )
                    .cloned();
                    new_descriptors.push(payload.descriptor.clone());
                    new_assets.push(payload);
                    imported.push(
                        AssetId::try_from_utf16(id.clone()).map_err(|_| StageError::Encoding)?,
                    );
                    (id, triangles)
                }
            };
            let triangles = triangles.ok_or(StageError::Encoding)?;
            let mut fields = vec![
                ("id", u(&next_id(IdKind::Volume))),
                ("name", u(&volume.name)),
                (
                    "role",
                    s(match volume.role {
                        Role::Model => "model",
                        Role::ParameterModifier => "parameter-modifier",
                    }),
                ),
                (
                    "source",
                    record([
                        ("assetId", u(&asset_id)),
                        ("topologyRevision", n(0.0)),
                        ("triangleCount", triangles),
                    ]),
                ),
                ("transform", transform_value(&super::IDENTITY)),
                ("config", Value::Object(BTreeMap::new())),
                (
                    "annotations",
                    record([
                        ("topologyRevision", n(0.0)),
                        ("color", Value::Array(vec![])),
                        ("support", Value::Array(vec![])),
                        ("seam", Value::Array(vec![])),
                        ("fuzzySkin", Value::Array(vec![])),
                        ("brim", Value::Array(vec![])),
                    ]),
                ),
            ];
            if volume.color_hex.is_some() || volume.material_name.is_some() {
                let mut material = BTreeMap::new();
                if let Some(name) = &volume.material_name {
                    material.insert(key("name"), u(name));
                }
                if let Some(color) = &volume.color_hex {
                    material.insert(key("color"), s(color));
                }
                material.insert(key("format"), s(decoded.format.code()));
                fields.push((
                    "extensionData",
                    record([("orcaxr:sourceMaterial", Value::Object(material))]),
                ));
            }
            volumes.push(Value::Object(
                fields.into_iter().map(|(k, v)| (key(k), v)).collect(),
            ));
        }
        if volumes.is_empty() {
            continue;
        }
        let name = unique_name(&object.name, &used, object_index);
        if name != object.name {
            repairs.push(record([
                ("id", u(&next_notice("rename"))),
                ("kind", s("identifier-remap")),
                (
                    "path",
                    u(&Message::new("$.plates[")
                        .u(&plate_id)
                        .s("].objects[")
                        .n(object_index as f64)
                        .s("]")
                        .done()),
                ),
                (
                    "message",
                    u(&Message::new("Renamed imported object \"")
                        .u(&object.name)
                        .s("\" to \"")
                        .u(&name)
                        .s("\" because that name is already used")
                        .done()),
                ),
                ("before", u(&object.name)),
                ("after", u(&name)),
                ("requiresConfirmation", Value::Bool(false)),
            ]));
        }
        used.insert(name.clone());
        let object_id = next_id(IdKind::Object);
        let count = object.instances.len();
        let instances = object
            .instances
            .iter()
            .enumerate()
            .map(|(i, transform)| {
                let instance_name = if count > 1 {
                    Message::default().u(&name).s(" ").n((i + 1) as f64).done()
                } else {
                    name.clone()
                };
                record([
                    ("id", u(&next_id(IdKind::Instance))),
                    ("name", u(&instance_name)),
                    (
                        "transform",
                        transform_value(&place(transform, &bounds, scale, placement)),
                    ),
                    ("printable", Value::Bool(true)),
                ])
            })
            .collect();
        staged_objects.push(record([
            ("id", u(&object_id)),
            ("name", u(&name)),
            ("config", Value::Object(BTreeMap::new())),
            ("volumes", Value::Array(volumes)),
            ("instances", Value::Array(instances)),
            ("layerRanges", Value::Array(vec![])),
            (
                "extensionData",
                record([(
                    "orcaxr:importSource",
                    record([
                        ("filename", u(&decoded.filename)),
                        ("format", s(decoded.format.code())),
                        ("unit", s(&decoded.source_unit)),
                        ("importedAt", u(imported_at)),
                    ]),
                )]),
            ),
        ]));
    }

    let Some(Value::Array(plates)) = root.get_mut(&key("plates")) else {
        return Err(StageError::State);
    };
    let Value::Object(plate) = &mut plates[plate_index] else {
        return Err(StageError::State);
    };
    let Some(Value::Array(objects)) = plate.get_mut(&key("objects")) else {
        return Err(StageError::State);
    };
    objects.extend(staged_objects);
    if objects.is_empty() {
        return Err(StageError::Malformed(Malformed::NoGeometry, decoded.format));
    }
    if let Some(Value::Array(assets)) = root.get_mut(&key("sourceAssets")) {
        assets.extend(new_descriptors);
    }
    for notice in &decoded.notices {
        let (prefix, list) = match notice.kind {
            NoticeKind::UnitConversion => ("unit", 0),
            NoticeKind::GeometryRepair => ("geometry", 0),
            NoticeKind::DroppedField => ("dropped", 1),
            _ => ("info", 2),
        };
        let id = u(&next_notice(prefix));
        match list {
            0 => repairs.push(record([
                ("id", id),
                ("kind", s(notice.kind.code())),
                ("path", u(&notice.path)),
                ("message", u(&notice.message)),
            ])),
            1 => dropped.push(record([
                ("id", id),
                ("path", u(&notice.path)),
                ("field", s(notice.code)),
                ("message", u(&notice.message)),
            ])),
            _ => diagnostics.push(record([
                ("id", id),
                ("severity", s("info")),
                ("code", s(notice.code)),
                ("path", u(&notice.path)),
                ("message", u(&notice.message)),
            ])),
        }
    }
    root.insert(key("updatedAt"), u(imported_at));
    let state = ProjectState::from_value(state).map_err(|_| StageError::State)?;
    Ok(Staged {
        state,
        new_assets,
        imported_asset_ids: imported,
        repairs,
        dropped_fields: dropped,
        diagnostics,
    })
}

fn place(transform: &Transform, bounds: &Bounds, scale: f64, placement: Placement) -> Transform {
    let mut translation = transform.translation_mm.map(|v| v * scale);
    if let Some([width, depth]) = placement.bed_size_mm {
        translation[0] += width / 2.0 - (bounds.min_x + bounds.max_x) / 2.0;
        translation[1] += depth / 2.0 - (bounds.min_y + bounds.max_y) / 2.0;
    }
    if placement.drop_to_bed {
        translation[2] -= bounds.min_z;
    }
    Transform {
        translation_mm: translation,
        rotation: transform.rotation,
        scale: transform.scale,
    }
}

/// The canonical JSON of the staged state, for previews and comparisons.
pub fn state_json(state: &ProjectState) -> Vec<u8> {
    let mut out = Vec::new();
    state.write_json(&mut out).expect("in-memory state");
    out
}
