//! Assembly alignment and explosion (`assemblyExchange.ts` over `assembly.ts`):
//! the pinned `GLGizmoAssembly` alignments of two picked surface features as a
//! canonical instance transform for the second pick's instance, which a host
//! commits through the same guarded transform intent a drag uses; which
//! alignments a pair allows (`Measure::get_assembly_action`); and the
//! view-only exploded layout, which never moves canonical geometry.
//!
//! Features are the measure contract's, in the frame the host picked them.
//! Arithmetic keeps the browser's order, its `Math.hypot`/`acos`/`sin`/`cos`
//! (`js_math`) and its quaternion helpers (`placement`).
use crate::js_math;
use crate::placement::{multiply_quaternions, quaternion_between, rotate_vector};
use orcaxr_contracts::project_intent_types as wire;
use std::f64::consts::PI;

type Vec3 = [f64; 3];
type Quaternion = [f64; 4];

/// Pinned guard in `set_to_parallel`: a pair already within this of the
/// target alignment is left alone rather than nudged by a rounding-sized
/// rotation.
pub const ALIGNMENT_EPSILON: f64 = 1e-3;

struct Refusal {
    code: wire::AssemblyRefusalCode,
    message: &'static str,
}
fn refusal(code: wire::AssemblyRefusalCode, message: &'static str) -> Refusal {
    Refusal { code, message }
}
impl Refusal {
    fn wire(self) -> wire::AssemblyRefusal {
        wire::AssemblyRefusal {
            code: self.code,
            message: self.message.encode_utf16().collect(),
        }
    }
}
fn degenerate() -> Refusal {
    refusal(
        wire::AssemblyRefusalCode::DegenerateAxis,
        "A plane normal must be non-zero",
    )
}
fn not_finite() -> Refusal {
    refusal(
        wire::AssemblyRefusalCode::NonFinite,
        "The result is not a finite placement",
    )
}

struct Plane {
    origin: Vec3,
    normal: Vec3,
}
fn plane(feature: &wire::SurfaceFeature) -> Option<Plane> {
    match feature {
        wire::SurfaceFeature::Plane(plane) => Some(Plane {
            origin: vector(&plane.origin),
            normal: vector(&plane.normal),
        }),
        _ => None,
    }
}
fn vector(values: &[f64]) -> Vec3 {
    [values[0], values[1], values[2]]
}
fn require_plane(feature: &wire::SurfaceFeature) -> Result<Plane, Refusal> {
    plane(feature).ok_or_else(|| {
        refusal(
            wire::AssemblyRefusalCode::UnsupportedFeaturePair,
            "This alignment needs a plane as the second feature",
        )
    })
}

/// `AssemblyAvailability`.
#[derive(Default)]
struct Availability {
    can_set_to_parallel: bool,
    can_set_to_center_coincidence: bool,
    can_reverse_feature1: bool,
    can_reverse_feature2: bool,
    can_rotate_around_face_center: bool,
    has_parallel_distance: bool,
    parallel_distance_mm: f64,
    angle_radians: f64,
}

/// `inspectAssemblyActions`: the whole set for two planes only; a plane
/// first may still be reversed.
fn inspect(
    first: &wire::SurfaceFeature,
    second: &wire::SurfaceFeature,
) -> Result<Availability, Refusal> {
    let Some(first) = plane(first) else {
        return Ok(Availability::default());
    };
    let Some(second) = plane(second) else {
        return Ok(Availability {
            can_reverse_feature1: true,
            ..Availability::default()
        });
    };
    let n1 = unit(first.normal)?;
    let n2 = unit(second.normal)?;
    if are_parallel(n1, n2) {
        let projected = project_point_to_plane(second.origin, first.origin, n1);
        let offset = subtract(second.origin, projected);
        let magnitude = length(offset);
        return Ok(Availability {
            can_set_to_parallel: false,
            can_set_to_center_coincidence: true,
            can_reverse_feature1: true,
            can_reverse_feature2: true,
            can_rotate_around_face_center: true,
            has_parallel_distance: true,
            parallel_distance_mm: if dot(offset, n1) < 0.0 {
                -magnitude
            } else {
                magnitude
            },
            angle_radians: 0.0,
        });
    }
    Ok(Availability {
        can_set_to_parallel: true,
        can_set_to_center_coincidence: true,
        can_reverse_feature1: true,
        can_reverse_feature2: true,
        can_rotate_around_face_center: false,
        has_parallel_distance: false,
        parallel_distance_mm: 0.0,
        angle_radians: js_math::acos(clamp(dot(n2, negate(n1)), -1.0, 1.0)),
    })
}

/// `AssemblyPair` → `AssemblyAvailabilityReply`.
pub fn availability_wire(request: &wire::AssemblyPair) -> wire::AssemblyAvailabilityReply {
    match inspect(&request.first, &request.second) {
        Err(refusal) => wire::AssemblyAvailabilityReply::Refused(refusal.wire()),
        Ok(a) if !(a.parallel_distance_mm.is_finite() && a.angle_radians.is_finite()) => {
            wire::AssemblyAvailabilityReply::Refused(not_finite().wire())
        }
        Ok(a) => wire::AssemblyAvailabilityReply::Available(wire::AssemblyAvailability {
            can_set_to_parallel: a.can_set_to_parallel,
            can_set_to_center_coincidence: a.can_set_to_center_coincidence,
            can_reverse_feature1: a.can_reverse_feature1,
            can_reverse_feature2: a.can_reverse_feature2,
            can_rotate_around_face_center: a.can_rotate_around_face_center,
            has_parallel_distance: a.has_parallel_distance,
            parallel_distance_mm: a.parallel_distance_mm,
            angle_radians: a.angle_radians,
        }),
    }
}

#[derive(Clone, Copy)]
struct Pose {
    translation: Vec3,
    rotation: Quaternion,
    scale: Vec3,
}

/// `planAssemblyAlignment`: the moving instance's transform and whether the
/// pair already satisfies the alignment.
fn plan(request: &wire::AssemblyAlignmentRequest) -> Result<(Pose, bool), Refusal> {
    use wire::AssemblyRefusalCode::*;
    let availability = inspect(&request.first, &request.second)?;
    let Some(first) = plane(&request.first) else {
        return Err(refusal(
            UnsupportedFeaturePair,
            "Assembly alignment needs a plane as the first feature",
        ));
    };
    let t = &request.moving_transform;
    let moving = Pose {
        translation: vector(&t.translation_mm),
        rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
        scale: vector(&t.scale),
    };
    let parameter = match &request.parameter {
        wire::OptionalFinite::Value(value) => Some(*value),
        wire::OptionalFinite::Absent(_) => None,
    };
    match request.kind {
        wire::AssemblyAlignmentKind::Parallel => {
            if !availability.can_set_to_parallel {
                return Err(refusal(
                    UnavailableAction,
                    "These planes are already parallel",
                ));
            }
            align_normals(moving, &first, &require_plane(&request.second)?, false)
        }
        wire::AssemblyAlignmentKind::CenterCoincidence => {
            if !availability.can_set_to_center_coincidence {
                return Err(refusal(
                    UnavailableAction,
                    "Centre coincidence needs two picked planes",
                ));
            }
            // Upstream turns the faces to anti-parallel first, then closes the gap.
            let second = require_plane(&request.second)?;
            let (rotated, noop) = align_normals(moving, &first, &second, true)?;
            let moved_origin = apply_delta(second.origin, &moving, &rotated);
            let displacement = subtract(first.origin, moved_origin);
            Ok((
                translate(rotated, displacement),
                noop && length(displacement) <= ALIGNMENT_EPSILON,
            ))
        }
        wire::AssemblyAlignmentKind::ParallelDistance => {
            if !availability.has_parallel_distance {
                return Err(refusal(
                    UnavailableAction,
                    "A parallel distance needs two parallel planes",
                ));
            }
            let Some(distance) = parameter else {
                return Err(refusal(
                    InvalidParameter,
                    "A parallel distance must be a finite number of millimetres",
                ));
            };
            let second = require_plane(&request.second)?;
            let normal1 = unit(first.normal)?;
            let projected = project_point_to_plane(second.origin, first.origin, normal1);
            let target = add(projected, multiply(normal1, distance));
            let displacement = subtract(target, second.origin);
            Ok((
                translate(moving, displacement),
                length(displacement) <= ALIGNMENT_EPSILON,
            ))
        }
        wire::AssemblyAlignmentKind::ReverseRotation => {
            let target = match request.reverse_feature {
                wire::OptionalAssemblyFeature::Value(wire::AssemblyFeature::First) => first,
                _ => require_plane(&request.second)?,
            };
            // Pinned: a half turn about any in-plane axis through the face centre.
            let axis = in_plane_axis(unit(target.normal)?)?;
            if length(axis) < 0.1 {
                return Err(refusal(
                    DegenerateAxis,
                    "This plane has no usable in-plane axis to turn about",
                ));
            }
            Ok((rotate_about_point(moving, target.origin, axis, PI), false))
        }
        wire::AssemblyAlignmentKind::AroundFaceCenter => {
            if !availability.can_rotate_around_face_center {
                return Err(refusal(
                    UnavailableAction,
                    "Rotating around the face centre needs two parallel planes",
                ));
            }
            let Some(degrees) = parameter else {
                return Err(refusal(
                    InvalidParameter,
                    "A face-centre rotation must be a finite number of degrees",
                ));
            };
            let second = require_plane(&request.second)?;
            let radians = (degrees * PI) / 180.0;
            Ok((
                rotate_about_point(moving, second.origin, unit(second.normal)?, radians),
                js_math::sin(radians / 2.0).abs() <= ALIGNMENT_EPSILON,
            ))
        }
    }
}

/// `AssemblyAlignmentRequest` → `AssemblyAlignmentReply`.
pub fn alignment_wire(request: &wire::AssemblyAlignmentRequest) -> wire::AssemblyAlignmentReply {
    match plan(request) {
        Err(refusal) => wire::AssemblyAlignmentReply::Refused(refusal.wire()),
        Ok((pose, _))
            if !pose
                .translation
                .iter()
                .chain(&pose.rotation)
                .chain(&pose.scale)
                .all(|v| v.is_finite()) =>
        {
            wire::AssemblyAlignmentReply::Refused(not_finite().wire())
        }
        Ok((pose, noop)) => wire::AssemblyAlignmentReply::Planned(wire::AssemblyAlignmentPlan {
            transform: wire::Transform {
                translation_mm: pose.translation.to_vec(),
                rotation: pose.rotation.to_vec(),
                scale: pose.scale.to_vec(),
            },
            noop,
        }),
    }
}

/// Pinned `set_to_parallel`: the target is always -normal1; the flag changes
/// only which already-satisfied pair is left alone.
fn align_normals(
    moving: Pose,
    first: &Plane,
    second: &Plane,
    anti_parallel: bool,
) -> Result<(Pose, bool), Refusal> {
    let n1 = unit(first.normal)?;
    let n2 = unit(second.normal)?;
    let alignment = dot(n1, n2);
    let already = if anti_parallel {
        alignment <= -1.0 + ALIGNMENT_EPSILON
    } else {
        alignment >= 1.0 - ALIGNMENT_EPSILON
    };
    if already {
        return Ok((moving, true));
    }
    let delta = quaternion_between(n2, negate(n1));
    Ok((
        Pose {
            rotation: multiply_quaternions(delta, moving.rotation),
            ..moving
        },
        false,
    ))
}

/// Rotate an instance about a world axis through a world point.
fn rotate_about_point(pose: Pose, pivot: Vec3, axis: Vec3, radians: f64) -> Pose {
    let half = radians / 2.0;
    let sin = js_math::sin(half);
    let delta = [
        axis[0] * sin,
        axis[1] * sin,
        axis[2] * sin,
        js_math::cos(half),
    ];
    let offset = subtract(pose.translation, pivot);
    let rotated = rotate_vector(offset, delta);
    Pose {
        translation: add(pivot, rotated),
        rotation: multiply_quaternions(delta, pose.rotation),
        scale: pose.scale,
    }
}

/// Where a world point attached to `before` ends up under `after`.
fn apply_delta(point: Vec3, before: &Pose, after: &Pose) -> Vec3 {
    let local = rotate_vector(
        subtract(point, before.translation),
        conjugate(before.rotation),
    );
    add(after.translation, rotate_vector(local, after.rotation))
}

fn translate(pose: Pose, displacement: Vec3) -> Pose {
    Pose {
        translation: add(pose.translation, displacement),
        ..pose
    }
}

/// `ExplosionRequest` → `ExplosionReply`: view-only offsets away from the
/// parts' centroid; a factor of 1 leaves every part exactly where it is.
pub fn explosion_wire(request: &wire::ExplosionRequest) -> wire::ExplosionReply {
    let factor = request.factor;
    if !factor.is_finite() || factor < 1.0 {
        return wire::ExplosionReply::Refused(
            refusal(
                wire::AssemblyRefusalCode::InvalidParameter,
                "An explosion factor must be a finite number of at least 1",
            )
            .wire(),
        );
    }
    if request.parts.is_empty() {
        return wire::ExplosionReply::Exploded(Vec::new());
    }
    let mut centroid = [0.0; 3];
    for part in &request.parts {
        centroid = add(centroid, vector(&part.center_mm));
    }
    centroid = multiply(centroid, 1.0 / request.parts.len() as f64);
    let mut offsets = Vec::with_capacity(request.parts.len());
    for part in &request.parts {
        let offset = multiply(subtract(vector(&part.center_mm), centroid), factor - 1.0);
        if !offset.iter().all(|v| v.is_finite()) {
            return wire::ExplosionReply::Refused(not_finite().wire());
        }
        offsets.push(wire::ExplosionOffset {
            id: part.id.clone(),
            // `-0` is numerically zero but not `Object.is` zero; normalised.
            offset_mm: offset.map(|v| if v == 0.0 { 0.0 } else { v }).to_vec(),
        });
    }
    wire::ExplosionReply::Exploded(offsets)
}

/// Pinned `get_one_point_in_plane` direction, reduced to the axis it yields.
fn in_plane_axis(normal: Vec3) -> Result<Vec3, Refusal> {
    let direction = if dot(normal, [1.0, 0.0, 0.0]).abs() > 1.0 - 1e-3 {
        [0.0, 1.0, 0.0]
    } else {
        [1.0, 0.0, 0.0]
    };
    unit(subtract(
        direction,
        multiply(normal, dot(direction, normal)),
    ))
}

fn are_parallel(a: Vec3, b: Vec3) -> bool {
    (dot(a, b).abs() - 1.0).abs() < 1e-4
}

fn project_point_to_plane(point: Vec3, origin: Vec3, normal: Vec3) -> Vec3 {
    subtract(
        point,
        multiply(normal, dot(subtract(point, origin), normal)),
    )
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn subtract(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn multiply(a: Vec3, factor: f64) -> Vec3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}
fn negate(a: Vec3) -> Vec3 {
    [-a[0], -a[1], -a[2]]
}
fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn length(a: Vec3) -> f64 {
    js_math::hypot(&a)
}
fn unit(a: Vec3) -> Result<Vec3, Refusal> {
    let size = length(a);
    if !size.is_finite() || size == 0.0 {
        return Err(degenerate());
    }
    Ok([a[0] / size, a[1] / size, a[2] / size])
}
fn conjugate([x, y, z, w]: Quaternion) -> Quaternion {
    [-x, -y, -z, w]
}
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    js_math::min(maximum, js_math::max(minimum, value))
}
