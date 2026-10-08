//! Placement planning (`placementExchange.ts` over `transformOperations.ts`):
//! the instance transforms the workspace's mirror, reset, centre,
//! scale-to-fit, lay-flat and drop-to-bed edits submit, planned from an
//! acknowledged state and its assets. A plan's changes are one
//! `setInstanceTransforms` intent; drop to bed also reports each instance's
//! lowest point and move. Each refusal carries the browser's code and message,
//! in the browser's order. Bounds walk the browser's way — instances in order,
//! then their model volumes — over the shared mesh arithmetic.
use crate::assets::{AssetRepository, AssetSnapshot};
use crate::ids::InstanceId;
use crate::js_math::{convert::number_to_string, hypot};
use crate::mesh::{Bounds, Error as MeshError, Limits, Mesh};
use crate::model::{Encode, ProjectState, Transform, VolumeRole, find_instance};
use orcaxr_contracts::project_intent_types as wire;
use std::collections::BTreeMap;

pub mod arrange;

pub type Vec3 = [f64; 3];
pub type Quaternion = [f64; 4];

/// One instance's planned transform.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub translation: Vec3,
    pub rotation: Quaternion,
    pub scale: Vec3,
}
impl Pose {
    fn of(transform: &Transform) -> Self {
        Self {
            translation: transform.translation_mm.map(|v| v.get()),
            rotation: transform.rotation.map(|v| v.get()),
            scale: transform.scale.map(|v| v.get()),
        }
    }
}

/// A refusal: the browser's code and message.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: wire::PlacementRefusalCode,
    pub message: String,
}
fn refuse(code: wire::PlacementRefusalCode, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// One instance dropped to the bed.
#[derive(Debug, Clone, PartialEq)]
pub struct Drop {
    pub instance: InstanceId,
    pub min_z_before_mm: f64,
    pub delta_z_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub changes: Vec<(InstanceId, Pose)>,
    pub drops: Vec<Drop>,
}

type Code = wire::PlacementRefusalCode;

/// Answer one request against an acknowledged state and its assets.
pub fn plan(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::PlacementRequest,
) -> Result<Plan, Refusal> {
    let assets = assets.capture_internal();
    let ids = |list: &[Vec<u16>]| -> Vec<Vec<u16>> { list.to_vec() };
    let changes = match request {
        wire::PlacementRequest::Mirror(m) => {
            let axis = match m.axis {
                wire::PlacementAxis::X => 0,
                wire::PlacementAxis::Y => 1,
                wire::PlacementAxis::Z => 2,
            };
            each_instance(state, &ids(&m.instance_ids), |mut pose| {
                pose.scale[axis] = -pose.scale[axis];
                pose
            })?
        }
        wire::PlacementRequest::ResetRotation(s) => {
            each_instance(state, &s.instance_ids, |pose| Pose {
                rotation: [0.0, 0.0, 0.0, 1.0],
                ..pose
            })?
        }
        wire::PlacementRequest::ResetScale(s) => {
            each_instance(state, &s.instance_ids, |pose| Pose {
                scale: [1.0; 3],
                ..pose
            })?
        }
        wire::PlacementRequest::ResetTransform(s) => {
            each_instance(state, &s.instance_ids, |pose| Pose {
                rotation: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0; 3],
                ..pose
            })?
        }
        wire::PlacementRequest::CenterOnPlate(c) => center(
            state,
            &assets,
            &c.instance_ids,
            [c.bed_size_mm[0], c.bed_size_mm[1]],
        )?,
        wire::PlacementRequest::ScaleToFit(s) => scale_to_fit(
            state,
            &assets,
            &s.instance_ids,
            [s.volume_mm[0], s.volume_mm[1], s.volume_mm[2]],
        )?,
        wire::PlacementRequest::LayOnFace(l) => lay_on_face(
            state,
            &assets,
            &l.instance_id,
            [l.local_normal[0], l.local_normal[1], l.local_normal[2]],
        )?,
        wire::PlacementRequest::LayOnFacet(l) => {
            lay_on_facet(state, &assets, &l.instance_id, &l.volume_id, l.triangle)?
        }
        wire::PlacementRequest::DropToBed(s) => {
            return drop_to_bed(state, &assets, &s.instance_ids);
        }
    };
    Ok(Plan {
        changes,
        drops: Vec::new(),
    })
}

/// A plan in the wire's encoding, or the refusal.
pub fn reply(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::PlacementRequest,
) -> wire::PlacementReply {
    match plan(state, assets, request) {
        Ok(plan) => wire::PlacementReply::Plan(wire::PlacementPlan {
            changes: plan
                .changes
                .iter()
                .map(|(id, pose)| wire::InstanceTransform {
                    instance_id: id.as_utf16().to_vec(),
                    transform: wire::Transform {
                        translation_mm: pose.translation.to_vec(),
                        rotation: pose.rotation.to_vec(),
                        scale: pose.scale.to_vec(),
                    },
                })
                .collect(),
            drops: plan
                .drops
                .iter()
                .map(|drop| wire::PlacementDrop {
                    instance_id: drop.instance.as_utf16().to_vec(),
                    min_z_before_mm: drop.min_z_before_mm,
                    delta_z_mm: drop.delta_z_mm,
                })
                .collect(),
        }),
        Err(refusal) => wire::PlacementReply::Refused(wire::PlacementRefusal {
            code: refusal.code,
            message: refusal.message.encode_utf16().collect(),
        }),
    }
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn instance_id(units: &[u16]) -> Option<InstanceId> {
    InstanceId::try_from_utf16(units.to_vec()).ok()
}

/// `eachInstance`: the first occurrence of each ID, in order.
fn each_instance(
    state: &ProjectState,
    ids: &[Vec<u16>],
    map: impl Fn(Pose) -> Pose,
) -> Result<Vec<(InstanceId, Pose)>, Refusal> {
    if ids.is_empty() {
        return Err(refuse(Code::EmptySelection, "Nothing is selected"));
    }
    let mut seen: Vec<&[u16]> = Vec::new();
    let mut changes = Vec::new();
    for id in ids {
        if seen.contains(&id.as_slice()) {
            continue;
        }
        seen.push(id);
        let found = instance_id(id).and_then(|id| find_instance(state, &id).map(|f| (id, f)));
        let Some((id, (_, _, instance))) = found else {
            return Err(refuse(
                Code::UnknownInstance,
                format!("Unknown instance {}", text(id)),
            ));
        };
        changes.push((id, map(Pose::of(&instance.transform))));
    }
    Ok(changes)
}

fn unique(ids: &[Vec<u16>]) -> Vec<Vec<u16>> {
    let mut out: Vec<Vec<u16>> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// `computeCanonicalInstanceBounds` over volumes of the given roles, with one
/// instance's transform optionally replaced (lay-on-face's probe).
fn bounds_with(
    state: &ProjectState,
    assets: &AssetSnapshot,
    ids: &[Vec<u16>],
    probe: Option<(&InstanceId, &Transform)>,
    roles: &[VolumeRole],
) -> Result<Bounds, Refusal> {
    if ids.is_empty() {
        return Err(refuse(
            Code::EmptySelection,
            "Canonical bounds require at least one instance",
        ));
    }
    let mut seen: Vec<&[u16]> = Vec::new();
    let mut meshes: BTreeMap<Vec<u16>, Mesh> = BTreeMap::new();
    let mut result = Bounds::empty();
    for id in ids {
        if seen.contains(&id.as_slice()) {
            return Err(refuse(
                Code::DuplicateInstance,
                format!("Canonical bounds contain duplicate instance {}", text(id)),
            ));
        }
        seen.push(id);
        let found =
            instance_id(id).and_then(|parsed| find_instance(state, &parsed).map(|f| (parsed, f)));
        let Some((parsed, (_, object, instance))) = found else {
            return Err(refuse(
                Code::UnknownInstance,
                format!("Unknown instance {}", text(id)),
            ));
        };
        let instance_transform = match probe {
            Some((target, transform)) if *target == parsed => transform,
            _ => &instance.transform,
        };
        for volume in object.volumes.iter() {
            if !roles.contains(&volume.role) {
                continue;
            }
            let asset = volume.source.asset_id.as_utf16().to_vec();
            let missing = || {
                refuse(
                    Code::MissingAsset,
                    format!(
                        "Volume {} references missing asset {}",
                        text(volume.id.as_utf16()),
                        text(&asset)
                    ),
                )
            };
            let descriptor = state
                .source_assets
                .iter()
                .find(|d| d.id == volume.source.asset_id)
                .ok_or_else(missing)?;
            let lease = assets.peek(&volume.source.asset_id).ok_or_else(missing)?;
            if !descriptor
                .matches_value(lease.descriptor())
                .unwrap_or(false)
            {
                return Err(refuse(
                    Code::AssetMetadata,
                    format!("Asset repository metadata differs for {}", text(&asset)),
                ));
            }
            if !meshes.contains_key(&asset) {
                let unlimited = Limits {
                    asset_bytes: usize::MAX,
                    vertices: usize::MAX,
                    indices: usize::MAX,
                };
                let mesh = Mesh::open(lease, unlimited, || false).map_err(|_| missing())?;
                meshes.insert(asset.clone(), mesh);
            }
            meshes[&asset]
                .accumulate_bounds(&mut result, &volume.transform, instance_transform, || false)
                .map_err(|error| match error {
                    MeshError::Transform => refuse(
                        Code::InvalidRotation,
                        "A canonical transform quaternion must be non-zero",
                    ),
                    _ => refuse(
                        Code::NonFiniteVertex,
                        "Canonical bounds contain a non-finite transformed vertex",
                    ),
                })?;
        }
    }
    result.finish().map_err(|_| {
        refuse(
            Code::NoGeometry,
            "Selected instances contain no bounded mesh geometry",
        )
    })
}

/// Model-volume bounds, as every placement edit measures them.
fn bounds(
    state: &ProjectState,
    assets: &AssetSnapshot,
    ids: &[Vec<u16>],
    probe: Option<(&InstanceId, &Transform)>,
) -> Result<Bounds, Refusal> {
    bounds_with(state, assets, ids, probe, &[VolumeRole::Model])
}

/// `centerInstancesOnPlate`.
fn center(
    state: &ProjectState,
    assets: &AssetSnapshot,
    ids: &[Vec<u16>],
    [bed_x, bed_y]: [f64; 2],
) -> Result<Vec<(InstanceId, Pose)>, Refusal> {
    if ids.is_empty() {
        return Err(refuse(Code::EmptySelection, "Nothing is selected"));
    }
    if !bed_x.is_finite() || !bed_y.is_finite() || bed_x <= 0.0 || bed_y <= 0.0 {
        return Err(refuse(
            Code::InvalidBed,
            "Centring needs a positive printable area",
        ));
    }
    let b = bounds(state, assets, &unique(ids), None)?;
    let delta_x = bed_x / 2.0 - (b.min[0] + b.max[0]) / 2.0;
    let delta_y = bed_y / 2.0 - (b.min[1] + b.max[1]) / 2.0;
    each_instance(state, ids, |pose| Pose {
        translation: [
            pose.translation[0] + delta_x,
            pose.translation[1] + delta_y,
            pose.translation[2],
        ],
        ..pose
    })
}

/// `Math.min` over three values: NaN if any is NaN.
fn js_min3(a: f64, b: f64, c: f64) -> f64 {
    if a.is_nan() || b.is_nan() || c.is_nan() {
        return f64::NAN;
    }
    a.min(b).min(c)
}

/// The pinned tolerance: a hundredth of a millimetre on every side.
const FIT_TOLERANCE_MM: f64 = 0.02;

/// `scaleInstancesToFitPrintVolume`.
fn scale_to_fit(
    state: &ProjectState,
    assets: &AssetSnapshot,
    ids: &[Vec<u16>],
    [volume_x, volume_y, volume_z]: Vec3,
) -> Result<Vec<(InstanceId, Pose)>, Refusal> {
    if ids.is_empty() {
        return Err(refuse(Code::EmptySelection, "Nothing is selected"));
    }
    if ![volume_x, volume_y, volume_z]
        .iter()
        .all(|size| size.is_finite() && *size > 0.0)
    {
        return Err(refuse(
            Code::InvalidBed,
            "Scaling to fit needs a positive printable volume",
        ));
    }
    let unique = unique(ids);
    let b = bounds(state, assets, &unique, None)?;
    let size = [0, 1, 2].map(|k| b.max[k] - b.min[k] + FIT_TOLERANCE_MM);
    if !size
        .iter()
        .all(|extent| extent.is_finite() && *extent > 0.0)
    {
        return Err(refuse(
            Code::DegenerateSelection,
            "The selection has no measurable size",
        ));
    }
    let factor = js_min3(volume_x / size[0], volume_y / size[1], volume_z / size[2]);
    if !factor.is_finite() || factor <= 0.0 {
        return Err(refuse(
            Code::DegenerateSelection,
            "The selection cannot be scaled to this volume",
        ));
    }
    if factor == 1.0 {
        return Ok(Vec::new());
    }
    let centre = [0, 1, 2].map(|k| (b.min[k] + b.max[k]) / 2.0);
    let scaled_min_z = centre[2] - ((b.max[2] - b.min[2]) * factor) / 2.0;
    let delta = [
        volume_x / 2.0 - centre[0],
        volume_y / 2.0 - centre[1],
        -scaled_min_z,
    ];
    each_instance(state, &unique, |pose| Pose {
        translation: [0, 1, 2]
            .map(|k| centre[k] + (pose.translation[k] - centre[k]) * factor + delta[k]),
        scale: pose.scale.map(|s| s * factor),
        ..pose
    })
}

/// `rotateVector`.
pub fn rotate_vector([vx, vy, vz]: Vec3, [x, y, z, w]: Quaternion) -> Vec3 {
    let tx = 2.0 * (y * vz - z * vy);
    let ty = 2.0 * (z * vx - x * vz);
    let tz = 2.0 * (x * vy - y * vx);
    [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx),
    ]
}

/// `multiplyQuaternions`.
pub fn multiply_quaternions(
    [lx, ly, lz, lw]: Quaternion,
    [rx, ry, rz, rw]: Quaternion,
) -> Quaternion {
    [
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ]
}

/// `quaternionBetween`: the shortest arc from one unit vector to another.
pub fn quaternion_between(from: Vec3, to: Vec3) -> Quaternion {
    let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    if dot >= 1.0 - 1e-9 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    if dot <= -1.0 + 1e-9 {
        // Opposite vectors: any perpendicular axis gives a deterministic 180° turn.
        let axis = if from[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let perpendicular = [
            from[1] * axis[2] - from[2] * axis[1],
            from[2] * axis[0] - from[0] * axis[2],
            from[0] * axis[1] - from[1] * axis[0],
        ];
        let length = hypot(&perpendicular);
        return [
            perpendicular[0] / length,
            perpendicular[1] / length,
            perpendicular[2] / length,
            0.0,
        ];
    }
    let cross = [
        from[1] * to[2] - from[2] * to[1],
        from[2] * to[0] - from[0] * to[2],
        from[0] * to[1] - from[1] * to[0],
    ];
    let w = 1.0 + dot;
    let length = hypot(&[cross[0], cross[1], cross[2], w]);
    [
        cross[0] / length,
        cross[1] / length,
        cross[2] / length,
        w / length,
    ]
}

/// `layInstanceOnFace`.
fn lay_on_face(
    state: &ProjectState,
    assets: &AssetSnapshot,
    id: &[u16],
    local_normal: Vec3,
) -> Result<Vec<(InstanceId, Pose)>, Refusal> {
    let found =
        instance_id(id).and_then(|parsed| find_instance(state, &parsed).map(|f| (parsed, f)));
    let Some((parsed, (_, _, instance))) = found else {
        return Err(refuse(
            Code::UnknownInstance,
            format!("Unknown instance {}", text(id)),
        ));
    };
    let length = hypot(&local_normal);
    if !length.is_finite() || length < 1e-9 {
        return Err(refuse(
            Code::InvalidNormal,
            "The chosen facet has no usable normal",
        ));
    }
    let normal = local_normal.map(|v| v / length);
    let pose = Pose::of(&instance.transform);
    let world_normal = rotate_vector(normal, pose.rotation);
    let alignment = quaternion_between(world_normal, [0.0, 0.0, -1.0]);
    let rotation = multiply_quaternions(alignment, pose.rotation);
    let rotated = Pose { rotation, ..pose };
    let probe = transform_with(&instance.transform, &rotated).ok_or_else(|| {
        refuse(
            Code::InvalidRotation,
            "A canonical transform quaternion must be non-zero",
        )
    })?;
    let b = bounds(state, assets, &[id.to_vec()], Some((&parsed, &probe)))?;
    Ok(vec![(
        parsed,
        Pose {
            translation: [
                rotated.translation[0],
                rotated.translation[1],
                rotated.translation[2] - b.min[2],
            ],
            ..rotated
        },
    )])
}

/// A pose over a canonical transform, when every component is finite.
fn transform_with(base: &Transform, pose: &Pose) -> Option<Transform> {
    use crate::model::Number;
    let number = |v: f64| Number::new(v).ok();
    let mut transform = base.clone();
    for k in 0..3 {
        transform.translation_mm[k] = number(pose.translation[k])?;
        transform.scale[k] = number(pose.scale[k])?;
    }
    for k in 0..4 {
        transform.rotation[k] = number(pose.rotation[k])?;
    }
    Some(transform)
}

/// `layInstanceOnFacet`: the facet's normal as three's `Triangle.getNormal`
/// computes it, turned by the volume's rotation into the instance's space.
fn lay_on_facet(
    state: &ProjectState,
    assets: &AssetSnapshot,
    id: &[u16],
    volume_id: &[u16],
    triangle: u64,
) -> Result<Vec<(InstanceId, Pose)>, Refusal> {
    let found = instance_id(id).and_then(|parsed| find_instance(state, &parsed));
    let Some((_, object, _)) = found else {
        return Err(refuse(
            Code::UnknownInstance,
            format!("Unknown instance {}", text(id)),
        ));
    };
    let Some(volume) = object.volumes.iter().find(|v| v.id.as_utf16() == volume_id) else {
        return Err(refuse(
            Code::UnknownVolume,
            format!("Unknown volume {}", text(volume_id)),
        ));
    };
    let unreadable = || {
        refuse(
            Code::InvalidFacet,
            format!("Volume {} has no readable mesh", text(volume.id.as_utf16())),
        )
    };
    let lease = assets
        .peek(&volume.source.asset_id)
        .ok_or_else(unreadable)?;
    let decoded = crate::mesh::decode_indexed(&lease).map_err(|_| unreadable())?;
    let indices = &decoded.indices;
    if triangle.saturating_mul(3).saturating_add(2) >= indices.len() as u64 {
        return Err(refuse(
            Code::InvalidFacet,
            format!(
                "Facet {} is not part of volume {}",
                number_to_string(triangle as f64),
                text(volume.id.as_utf16())
            ),
        ));
    }
    let t = triangle as usize;
    let vertex = |corner: usize| decoded.positions[indices[t * 3 + corner] as usize];
    let (a, b, c) = (vertex(0), vertex(1), vertex(2));
    let cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    let ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = [
        cb[1] * ab[2] - cb[2] * ab[1],
        cb[2] * ab[0] - cb[0] * ab[2],
        cb[0] * ab[1] - cb[1] * ab[0],
    ];
    let length_sq = cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2];
    let inverse = if length_sq > 0.0 {
        1.0 / length_sq.sqrt()
    } else {
        0.0
    };
    let normal = cross.map(|v| v * inverse);
    lay_on_face(
        state,
        assets,
        id,
        rotate_vector(normal, volume.transform.rotation.map(|v| v.get())),
    )
}

/// `dropInstancesToBed`.
fn drop_to_bed(
    state: &ProjectState,
    assets: &AssetSnapshot,
    ids: &[Vec<u16>],
) -> Result<Plan, Refusal> {
    if ids.is_empty() {
        return Err(refuse(Code::EmptySelection, "Nothing is selected"));
    }
    let mut seen: Vec<&[u16]> = Vec::new();
    let mut plan = Plan::default();
    for id in ids {
        if seen.contains(&id.as_slice()) {
            return Err(refuse(
                Code::DuplicateInstance,
                format!("Drop to bed contains duplicate instance {}", text(id)),
            ));
        }
        seen.push(id);
        let found =
            instance_id(id).and_then(|parsed| find_instance(state, &parsed).map(|f| (parsed, f)));
        let Some((parsed, (_, _, instance))) = found else {
            return Err(refuse(
                Code::UnknownInstance,
                format!("Unknown instance {}", text(id)),
            ));
        };
        let b = bounds(state, assets, std::slice::from_ref(id), None)?;
        let min_z = b.min[2];
        let delta = if min_z == 0.0 { 0.0 } else { -min_z };
        let pose = Pose::of(&instance.transform);
        plan.drops.push(Drop {
            instance: parsed.clone(),
            min_z_before_mm: min_z,
            delta_z_mm: delta,
        });
        plan.changes.push((
            parsed,
            Pose {
                translation: [
                    pose.translation[0],
                    pose.translation[1],
                    pose.translation[2] + delta,
                ],
                ..pose
            },
        ));
    }
    Ok(plan)
}
