//! New geometry as the browser creates it: the stock primitives of the
//! `add_primitive_*` actions (`primitives.ts`, three's generators) and the
//! helper-volume cube of `add_modifier`, `add_support_enforcer` and
//! `add_support_blocker` (`CanonicalWorkspaceController.addHelperVolume`), and
//! what each becomes in a project:
//!
//! - a primitive is a new object (`importGeometry` → `prepareGeometryObject`)
//!   named after its file (`cube.stl`), its one model part and one instance
//!   centred on the printable area and resting on the bed
//!   (`geometryBedPlacement`), its mesh
//!   shared with an asset the project already holds with the same bytes and
//!   layout — the first such asset in code-unit ID order — or else a new asset
//!   recording its file and import time;
//! - a helper volume is a cube part of the object the selection's primary
//!   instance, object or part belongs to, named after its role and how many
//!   parts of that role the object already has (`Modifier 2`), on an asset of
//!   its own.
//!
//! IDs are drawn as the browser draws them — a primitive's asset only when no
//! asset is shared, then its object, part and instance; a helper's asset, then
//! its part — from the request's list, and the reply says how many it used.
//! The exchange is canonical JSON; each record travels as the canonical JSON a
//! host stages (`objectJson`, `volumeJson`, `assetJson`), and a payload's
//! bytes come from [`payload_json`]. Refusals carry the browser's words.
pub mod geometry;

use crate::assets::{AssetPayload, AssetRepository};
use crate::ids::{AssetId, is_stable_entity_id};
use crate::js_math;
use crate::mesh::{self, Coordinates, EncodeOptions};
use crate::model::{AssetOrigin, AssetProvenance, ProjectState, Text, VolumeRole};
use crate::placement::Area;
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A request that is not the documented shape (or asks for more IDs than it carries).
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply or payload that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";

/// Upstream's `side`: a primitive's size unless asked otherwise (mm).
pub const PRIMITIVE_SIDE_MM: f64 = 20.0;
/// The helper-volume cube's edge (`addHelperVolume`'s default, mm).
pub const HELPER_VOLUME_SIZE_MM: f64 = 10.0;

names!(
    /// The six stock primitives and the helper-volume cube.
    Shape {
        Cube => "cube",
        Cylinder => "cylinder",
        Sphere => "sphere",
        Cone => "cone",
        Disc => "disc",
        Torus => "torus",
        HelperCube => "helper-cube",
    }
);

impl Shape {
    fn parse(units: &[u16]) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|shape| shape.as_str().encode_utf16().eq(units.iter().copied()))
    }
    /// The file a primitive is imported under (`primitiveFileName`); the helper cube has none.
    pub fn file_name(self) -> Option<String> {
        (self != Self::HelperCube).then(|| format!("{}.stl", self.as_str()))
    }
}

/// A mesh as the browser encodes it: Float32 positions and its index buffer.
pub struct Mesh {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

/// `primitiveGeometry(kind, side)` through `extractTriangleMesh` — welded into
/// one closed surface ([`mesh::weld`]) — or the helper cube
/// (`createPrimitiveCubeGeometry(size)`), as the asset encoder receives it.
pub fn mesh(shape: Shape, size_mm: f64) -> Mesh {
    use geometry::*;
    let radius = 0.5 * size_mm;
    let quarter = std::f64::consts::PI / 2.0;
    let indexed = match shape {
        Shape::HelperCube => return helper_cube(size_mm),
        Shape::Cube => box_geometry(size_mm, size_mm, size_mm),
        Shape::Cylinder => {
            let mut g = cylinder(radius, radius, size_mm, 48);
            g.rotate_x(quarter);
            g
        }
        Shape::Sphere => sphere(radius, 48, 32),
        Shape::Cone => {
            let mut g = cylinder(0.0, radius, size_mm, 48);
            g.rotate_x(quarter);
            g
        }
        Shape::Disc => {
            let mut g = cylinder(radius, radius, 0.2, 48);
            g.rotate_x(quarter);
            g
        }
        Shape::Torus => torus(radius, 0.125 * size_mm, 32, 96),
    };
    // `toNonIndexed()`, then `extractTriangleMesh`: its identity index buffer, welded.
    let soup = indexed.to_non_indexed();
    let corners: Vec<u32> = (0..(soup.len() / 3) as u32).collect();
    let (positions, indices) = mesh::weld::weld(&soup, &corners);
    Mesh { positions, indices }
}

/// `createPrimitiveCubeGeometry(size)`: 24 vertices (four per face, ±size/2)
/// and two triangles a face, as the controller lists them, welded into one
/// closed box ([`mesh::weld`]).
fn helper_cube(size_mm: f64) -> Mesh {
    let h = size_mm / 2.0;
    let corners: [[f64; 3]; 24] = [
        [-h, -h, h],
        [h, -h, h],
        [h, h, h],
        [-h, h, h],
        [-h, -h, -h],
        [-h, h, -h],
        [h, h, -h],
        [h, -h, -h],
        [-h, h, -h],
        [-h, h, h],
        [h, h, h],
        [h, h, -h],
        [-h, -h, -h],
        [h, -h, -h],
        [h, -h, h],
        [-h, -h, h],
        [h, -h, -h],
        [h, h, -h],
        [h, h, h],
        [h, -h, h],
        [-h, -h, -h],
        [-h, -h, h],
        [-h, h, h],
        [-h, h, -h],
    ];
    // Welded as Float32, as `Float32Array.from` rounds each double first.
    let corners: Vec<f32> = corners.iter().flatten().map(|&v| v as f32).collect();
    let faces: Vec<u32> = (0..6u32)
        .flat_map(|face| {
            let at = face * 4;
            [at, at + 1, at + 2, at, at + 2, at + 3]
        })
        .collect();
    let (positions, indices) = mesh::weld::weld(&corners, &faces);
    Mesh { positions, indices }
}

/// The canonical payload of [mesh] under `id` (`encodeIndexedMeshAsset`).
pub fn encode(
    mesh: &Mesh,
    id: AssetId,
    source_filename: Option<Text>,
    provenance: Option<Arc<AssetProvenance>>,
) -> Result<AssetPayload, &'static str> {
    mesh::encode(
        EncodeOptions {
            id,
            source_filename,
            provenance,
            metadata_bytes: usize::MAX,
        },
        Coordinates::Float32(&mesh.positions),
        Some(&mesh.indices),
        mesh::Limits {
            asset_bytes: usize::MAX,
            vertices: usize::MAX,
            indices: usize::MAX,
        },
        || false,
    )
    .map_err(|_| INVALID_REQUEST)
}

/// The bounds three computes over Float32 positions (`computeBoundingBox`):
/// `Math.min`/`Math.max` from ±∞, signed zeros included.
pub fn bounds(positions: &[f32]) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for vertex in positions.chunks_exact(3) {
        for axis in 0..3 {
            let value = f64::from(vertex[axis]);
            min[axis] = js_math::min(min[axis], value);
            max[axis] = js_math::max(max[axis], value);
        }
    }
    (min, max)
}

/// `geometryBedPlacement`: the translation that centres the bounds on the
/// printable `area` (printer mm, `WorkspaceBed.areaMm`: the midpoint of its
/// corners, which a printer may offset from the bed corner) and rests them on
/// the bed.
pub fn bed_placement(positions: &[f32], area: Area) -> [f64; 3] {
    let (min, max) = bounds(positions);
    let center_x = (min[0] + max[0]) / 2.0;
    let center_y = (min[1] + max[1]) / 2.0;
    [
        (area.x_min + area.x_max) / 2.0 - center_x,
        (area.y_min + area.y_max) / 2.0 - center_y,
        -min[2],
    ]
}

// --- Canonical JSON helpers ----------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn string(text: &str) -> Value {
    Value::String(units(text))
}
fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|&v| Value::Number(v)).collect())
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&units(name)),
        _ => None,
    }
}
fn members(
    value: Value,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| required.iter().chain(optional).any(|n| units(n) == *key);
    if !fields.keys().all(known) || !required.iter().all(|n| fields.contains_key(&units(n))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut BTreeMap<Vec<u16>, Value>, name: &str) -> Value {
    fields.remove(&units(name)).unwrap_or(Value::Null)
}
fn finite(value: Value) -> Result<f64, &'static str> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(n),
        _ => Err(INVALID_REQUEST),
    }
}
/// A size: finite and positive.
fn size(value: Value) -> Result<f64, &'static str> {
    let size = finite(value)?;
    if size > 0.0 {
        Ok(size)
    } else {
        Err(INVALID_REQUEST)
    }
}
fn text(value: Value) -> Result<Vec<u16>, &'static str> {
    match value {
        Value::String(units) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}

/// The request's fresh IDs, taken in the browser's drawing order.
struct Ids {
    ids: std::vec::IntoIter<Vec<u16>>,
    used: usize,
}
impl Ids {
    fn read(value: Value) -> Result<Self, &'static str> {
        let Value::Array(items) = value else {
            return Err(INVALID_REQUEST);
        };
        let ids = items.into_iter().map(text).collect::<Result<Vec<_>, _>>()?;
        if !ids.iter().all(|id| is_stable_entity_id(id)) {
            return Err(INVALID_REQUEST);
        }
        Ok(Self {
            ids: ids.into_iter(),
            used: 0,
        })
    }
    fn next(&mut self) -> Result<Vec<u16>, &'static str> {
        self.used += 1;
        self.ids.next().ok_or(INVALID_REQUEST)
    }
}

fn refusal(message: Vec<u16>) -> Result<String, &'static str> {
    canonical(&Value::Object(BTreeMap::from([(
        units("refusal"),
        Value::String(message),
    )])))
}
fn concat(prefix: &str, rest: &[u16]) -> Vec<u16> {
    units(prefix)
        .into_iter()
        .chain(rest.iter().copied())
        .collect()
}

/// `{"kind","sizeMm"}` → the canonical mesh payload's bytes, as the browser
/// stores it (the asset ID it carries is not part of the bytes).
pub fn payload_json(request: &str) -> Result<Vec<u8>, &'static str> {
    let mut fields = members(read(request)?, &["kind", "sizeMm"], &[])?;
    let shape = Shape::parse(&text(take(&mut fields, "kind"))?).ok_or(INVALID_REQUEST)?;
    let size = size(take(&mut fields, "sizeMm"))?;
    let mesh = mesh(shape, size);
    if mesh.positions.iter().any(|v| !v.is_finite()) {
        // `extractTriangleMesh`: 'BufferGeometry positions must be finite'.
        return Err(INVALID_REQUEST);
    }
    let id = AssetId::try_from_str("import:orcaxr:primitive").map_err(|_| OUTPUT_LIMIT)?;
    Ok(encode(&mesh, id, None, None)?.bytes)
}

/// The text of `kind`/`id` primary selection refs a helper volume targets.
struct Primary {
    kind: Vec<u16>,
    id: Vec<u16>,
}
fn primary(value: Value) -> Result<Option<Primary>, &'static str> {
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    let mut fields = members(value, &["id", "kind"], &[])?;
    let kind = text(take(&mut fields, "kind"))?;
    const KINDS: [&str; 7] = [
        "project",
        "plate",
        "object",
        "volume",
        "instance",
        "layer-range",
        "filament",
    ];
    if !KINDS.iter().any(|k| units(k) == kind) {
        return Err(INVALID_REQUEST);
    }
    Ok(Some(Primary {
        kind,
        id: text(take(&mut fields, "id"))?,
    }))
}

fn same(units: &[u16], id: &[u16]) -> bool {
    units == id
}

/// The JSON of a new part's record (`ProjectVolume`): identity transform, no
/// configuration, empty facet annotations at topology revision 0.
fn volume_value(
    id: &[u16],
    name: Vec<u16>,
    role: VolumeRole,
    asset_id: &[u16],
    triangles: usize,
) -> Value {
    object([
        (
            "annotations",
            object([
                ("brim", Value::Array(vec![])),
                ("color", Value::Array(vec![])),
                ("fuzzySkin", Value::Array(vec![])),
                ("seam", Value::Array(vec![])),
                ("support", Value::Array(vec![])),
                ("topologyRevision", Value::Number(0.0)),
            ]),
        ),
        ("config", Value::Object(BTreeMap::new())),
        ("id", Value::String(id.to_vec())),
        ("name", Value::String(name)),
        ("role", string(role.as_str())),
        (
            "source",
            object([
                ("assetId", Value::String(asset_id.to_vec())),
                ("topologyRevision", Value::Number(0.0)),
                ("triangleCount", Value::Number(triangles as f64)),
            ]),
        ),
        ("transform", transform_value([0.0; 3])),
    ])
}

fn transform_value(translation: [f64; 3]) -> Value {
    object([
        ("rotation", numbers(&[0.0, 0.0, 0.0, 1.0])),
        ("scale", numbers(&[1.0, 1.0, 1.0])),
        ("translationMm", numbers(&translation)),
    ])
}

fn mesh_descriptor(descriptor: &Value) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    field(descriptor, "mesh")?
        .write_canonical(&mut bytes)
        .ok()?;
    Some(bytes)
}

/// `findReusableMeshAsset`: the assets declaring the staged digest in
/// code-unit ID order; the first holding the same mesh layout and bytes is
/// shared, and when none does the first one refuses in the browser's words.
fn reusable(assets: &AssetRepository, staged: &AssetPayload) -> Result<Option<AssetId>, Vec<u16>> {
    let digest = field(&staged.descriptor, "digest").cloned();
    let mut matches: Vec<_> = assets
        .ids()
        .filter_map(|id| assets.peek(id))
        .filter(|lease| digest.is_some() && field(lease.descriptor(), "digest") == digest.as_ref())
        .collect();
    if matches.is_empty() {
        return Ok(None);
    }
    matches.sort_by(|a, b| a.id().as_utf16().cmp(b.id().as_utf16()));
    let layout = mesh_descriptor(&staged.descriptor);
    let is_mesh = |descriptor: &Value| {
        matches!(field(descriptor, "kind"), Some(Value::String(kind)) if *kind == units("mesh"))
            && field(descriptor, "mesh").is_some()
    };
    let compatible = |lease: &crate::assets::AssetLease| {
        is_mesh(lease.descriptor())
            && mesh_descriptor(lease.descriptor()) == layout
            && lease.bytes() == staged.bytes.as_slice()
    };
    if let Some(found) = matches.iter().find(|lease| compatible(lease)) {
        return Ok(Some(found.id().clone()));
    }
    let Some(Value::String(digest)) = digest else {
        return Ok(None);
    };
    Err(if is_mesh(matches[0].descriptor()) {
        let mut message = concat("Asset digest ", &digest);
        message.extend(units(" does not identify the same mesh topology"));
        message
    } else {
        let mut message = concat("Asset digest ", &digest);
        message.extend(units(" is already owned by a non-mesh asset"));
        message
    })
}

/// A primitive on a plate (`addPrimitive` → `importGeometry`):
/// `{"areaMm","ids","importedAt","kind","plateId","sizeMm"}` (the area as
/// `{"xMax","xMin","yMax","yMin"}`) →
/// `{"assetJson","idsUsed","objectJson","plateId","reusedAsset"}`, or
/// `{"refusal"}` in the browser's words.
pub fn primitive_object_json(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &str,
) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["areaMm", "ids", "importedAt", "kind", "plateId", "sizeMm"],
        &[],
    )?;
    let shape = Shape::parse(&text(take(&mut fields, "kind"))?).ok_or(INVALID_REQUEST)?;
    let file = shape.file_name().ok_or(INVALID_REQUEST)?;
    let size = size(take(&mut fields, "sizeMm"))?;
    let mut area = members(
        take(&mut fields, "areaMm"),
        &["xMax", "xMin", "yMax", "yMin"],
        &[],
    )?;
    let area = Area {
        x_min: finite(take(&mut area, "xMin"))?,
        y_min: finite(take(&mut area, "yMin"))?,
        x_max: finite(take(&mut area, "xMax"))?,
        y_max: finite(take(&mut area, "yMax"))?,
    };
    let imported_at = text(take(&mut fields, "importedAt"))?;
    let plate_id = match take(&mut fields, "plateId") {
        Value::Null => None,
        Value::String(id) => Some(id),
        _ => return Err(INVALID_REQUEST),
    };
    let mut ids = Ids::read(take(&mut fields, "ids"))?;

    // `prepareGeometryObject`: the plate first, then the mesh and its asset.
    let plate_id = plate_id.unwrap_or_else(|| state.active_plate_id.as_utf16().to_vec());
    if !state
        .plates
        .iter()
        .any(|p| same(p.id.as_utf16(), &plate_id))
    {
        return refusal(concat("Unknown plate ", &plate_id));
    }
    let mesh = mesh(shape, size);
    if mesh.positions.iter().any(|v| !v.is_finite()) {
        return Err(INVALID_REQUEST);
    }
    let translation = bed_placement(&mesh.positions, area);
    let staging = AssetId::try_from_str("import:orcaxr:canonical-workspace-staging")
        .map_err(|_| OUTPUT_LIMIT)?;
    let staged = encode(&mesh, staging, None, None)?;
    let shared = match reusable(assets, &staged) {
        Ok(shared) => shared,
        Err(message) => return refusal(message),
    };
    let name = units(&file);
    let (asset, reused) = match shared {
        Some(id) => {
            let lease = assets.peek(&id).ok_or(OUTPUT_LIMIT)?;
            (lease.descriptor().clone(), true)
        }
        None => {
            let id = AssetId::try_from_utf16(ids.next()?).map_err(|_| INVALID_REQUEST)?;
            let provenance = AssetProvenance {
                source: AssetOrigin::Import,
                uri: None,
                imported_at: Some(Text::new(imported_at)),
                extra: Default::default(),
            };
            let payload = encode(
                &mesh,
                id,
                Some(Text::new(name.clone())),
                Some(Arc::new(provenance)),
            )?;
            (payload.descriptor, false)
        }
    };
    let asset_id = match field(&asset, "id") {
        Some(Value::String(id)) => id.clone(),
        _ => return Err(OUTPUT_LIMIT),
    };
    let triangles = match field(&asset, "mesh").and_then(|mesh| field(mesh, "triangleCount")) {
        Some(Value::Number(count)) => *count as usize,
        _ => return Err(OUTPUT_LIMIT),
    };
    let object_id = ids.next()?;
    let volume_id = ids.next()?;
    let instance_id = ids.next()?;
    let record = object([
        ("config", Value::Object(BTreeMap::new())),
        ("id", Value::String(object_id)),
        (
            "instances",
            Value::Array(vec![object([
                ("id", Value::String(instance_id)),
                ("name", Value::String(name.clone())),
                ("printable", Value::Bool(true)),
                ("transform", transform_value(translation)),
            ])]),
        ),
        ("layerRanges", Value::Array(vec![])),
        ("name", Value::String(name.clone())),
        (
            "volumes",
            Value::Array(vec![volume_value(
                &volume_id,
                name,
                VolumeRole::Model,
                &asset_id,
                triangles,
            )]),
        ),
    ]);
    canonical(&object([
        ("assetJson", Value::String(units(&canonical(&asset)?))),
        ("idsUsed", Value::Number(ids.used as f64)),
        ("objectJson", Value::String(units(&canonical(&record)?))),
        ("plateId", Value::String(plate_id)),
        ("reusedAsset", Value::Bool(reused)),
    ]))
}

/// `addHelperVolume`'s names: "Modifier", "Support Enforcer", …
fn role_name(role: VolumeRole) -> &'static str {
    match role {
        VolumeRole::ParameterModifier => "Modifier",
        VolumeRole::SupportEnforcer => "Support Enforcer",
        VolumeRole::SupportBlocker => "Support Blocker",
        VolumeRole::NegativeVolume => "Negative Volume",
        VolumeRole::Model => "Part",
    }
}

/// A helper volume for the selection's object (`addHelperVolume`):
/// `{"ids","primary","role","sizeMm"}` → `{"assetJson","idsUsed","objectId","volumeJson"}`,
/// or `{"refusal"}` in the browser's words.
pub fn helper_volume_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["ids", "primary", "role", "sizeMm"], &[])?;
    let role = text(take(&mut fields, "role"))?;
    let role = [
        VolumeRole::ParameterModifier,
        VolumeRole::SupportEnforcer,
        VolumeRole::SupportBlocker,
        VolumeRole::NegativeVolume,
    ]
    .into_iter()
    .find(|r| units(r.as_str()) == role)
    .ok_or(INVALID_REQUEST)?;
    let size = size(take(&mut fields, "sizeMm"))?;
    let primary = primary(take(&mut fields, "primary"))?;
    let mut ids = Ids::read(take(&mut fields, "ids"))?;

    let Some(primary) = primary else {
        return refusal(units(
            "Adding a volume requires a selected object or instance",
        ));
    };
    let objects = state.plates.iter().flat_map(|plate| plate.objects.iter());
    let target = match String::from_utf16_lossy(&primary.kind).as_str() {
        "instance" => objects.clone().find(|o| {
            o.instances
                .iter()
                .any(|i| same(i.id.as_utf16(), &primary.id))
        }),
        "object" => objects.clone().find(|o| same(o.id.as_utf16(), &primary.id)),
        "volume" => objects
            .clone()
            .find(|o| o.volumes.iter().any(|v| same(v.id.as_utf16(), &primary.id))),
        _ => None,
    };
    let Some(target) = target else {
        return refusal(units("Target object not found for adding volume"));
    };
    let mesh = mesh(Shape::HelperCube, size);
    if mesh.positions.iter().any(|v| !v.is_finite()) {
        return Err(INVALID_REQUEST);
    }
    let asset_id = ids.next()?;
    let volume_id = ids.next()?;
    let count = target.volumes.iter().filter(|v| v.role == role).count() + 1;
    let asset = encode(
        &mesh,
        AssetId::try_from_utf16(asset_id.clone()).map_err(|_| INVALID_REQUEST)?,
        None,
        None,
    )?;
    let name = units(&format!("{} {count}", role_name(role)));
    let volume = volume_value(&volume_id, name, role, &asset_id, mesh.indices.len() / 3);
    canonical(&object([
        (
            "assetJson",
            Value::String(units(&canonical(&asset.descriptor)?)),
        ),
        ("idsUsed", Value::Number(ids.used as f64)),
        ("objectId", Value::String(target.id.as_utf16().to_vec())),
        ("volumeJson", Value::String(units(&canonical(&volume)?))),
    ]))
}
