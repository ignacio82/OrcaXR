//! Surface measurement over a live session (`measureExchange.ts` over
//! `measure.ts`, after the pinned `libslic3r/Measure.cpp`): a volume captured
//! into its plane/border/feature decomposition, picks resolved to the feature
//! the workspace claims (moved into a host frame when asked, with the
//! workspace's one-line readout), and any two features measured to the
//! workspace's distances and angle. A volume, pick or pair the workspace
//! cannot measure refuses with a code and a message.
mod features;
mod pairs;

pub use features::{Extractor, FEATURE_HOVER_LIMIT_MM, UnknownFace};
pub use pairs::{Angle, Distance, EPSILON, Measurement, measure};

use crate::assets::AssetRepository;
use crate::js_math::{self, convert};
use crate::mesh::decode_indexed;
use crate::model::ProjectState;
use orcaxr_contracts::project_intent_types as wire;
use pairs::{is_approx, normalized, sub};

pub type V = [f64; 3];

/// Pinned `SurfaceFeature`, in the frame it was captured or moved into.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Feature {
    Point(V),
    Edge { from: V, to: V, extra: Option<V> },
    Circle { center: V, normal: V, radius: f64 },
    Plane { index: u64, normal: V, origin: V },
}

/// `transformSurfaceFeature`: a volume-local feature moved by a row-major 4x4
/// transform. A circle under a non-uniform scale has no single radius, so it
/// does not move (`None`).
pub fn transform(feature: &Feature, m: &[f64; 16]) -> Option<Feature> {
    let point = |p: V| {
        [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
        ]
    };
    let direction = |v: V| {
        normalized([
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
            m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
        ])
    };
    Some(match *feature {
        Feature::Point(p) => Feature::Point(point(p)),
        Feature::Edge { from, to, extra } => Feature::Edge {
            from: point(from),
            to: point(to),
            extra: extra.map(point),
        },
        Feature::Plane {
            index,
            normal,
            origin,
        } => Feature::Plane {
            index,
            normal: direction(normal),
            origin: point(origin),
        },
        Feature::Circle {
            center,
            normal,
            radius,
        } => {
            let scales = [
                js_math::hypot(&[m[0], m[4], m[8]]),
                js_math::hypot(&[m[1], m[5], m[9]]),
                js_math::hypot(&[m[2], m[6], m[10]]),
            ];
            if !is_approx(scales[0], scales[1], EPSILON)
                || !is_approx(scales[1], scales[2], EPSILON)
            {
                return None;
            }
            Feature::Circle {
                center: point(center),
                normal: direction(normal),
                radius: radius * scales[0],
            }
        }
    })
}

/// `describeSurfaceFeature`: the workspace's one-line readout.
pub fn describe(feature: &Feature) -> String {
    // `${Number(value.toFixed(3))}`
    let mm = |value: f64| convert::number_to_string(convert::number(&convert::to_fixed(value, 3)));
    let list = |v: V| v.map(mm).join(", ");
    match *feature {
        Feature::Point(p) => format!("point ({}) mm", list(p)),
        Feature::Edge { from, to, .. } => {
            format!("edge {} mm long", mm(js_math::hypot(&sub(to, from))))
        }
        Feature::Circle { radius, .. } => format!("circle ⌀{} mm", mm(radius * 2.0)),
        Feature::Plane { normal, .. } => format!("plane facing ({})", list(normal)),
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn vector(v: &[f64]) -> V {
    [v[0], v[1], v[2]]
}
fn finite(values: impl IntoIterator<Item = f64>) -> bool {
    values.into_iter().all(f64::is_finite)
}
fn feature_numbers(feature: &Feature) -> Vec<f64> {
    match *feature {
        Feature::Point(p) => p.to_vec(),
        Feature::Edge { from, to, extra } => {
            let mut values = [from, to].concat();
            values.extend(extra.into_iter().flatten());
            values
        }
        Feature::Circle {
            center,
            normal,
            radius,
        } => [center.as_slice(), normal.as_slice(), &[radius]].concat(),
        Feature::Plane { normal, origin, .. } => [normal, origin].concat(),
    }
}

pub fn feature_to_wire(feature: &Feature) -> wire::SurfaceFeature {
    match *feature {
        Feature::Point(point) => wire::SurfaceFeature::Point(wire::MeasurePoint {
            point: point.to_vec(),
        }),
        Feature::Edge { from, to, extra } => wire::SurfaceFeature::Edge(wire::MeasureEdge {
            from: from.to_vec(),
            to: to.to_vec(),
            extra_point: match extra {
                Some(point) => wire::OptionalVector::Value(point.to_vec()),
                None => wire::OptionalVector::Absent(wire::Empty {}),
            },
        }),
        Feature::Circle {
            center,
            normal,
            radius,
        } => wire::SurfaceFeature::Circle(wire::MeasureCircle {
            center: center.to_vec(),
            normal: normal.to_vec(),
            radius,
        }),
        Feature::Plane {
            index,
            normal,
            origin,
        } => wire::SurfaceFeature::Plane(wire::MeasurePlane {
            index,
            normal: normal.to_vec(),
            origin: origin.to_vec(),
        }),
    }
}

pub fn feature_from_wire(feature: &wire::SurfaceFeature) -> Feature {
    match feature {
        wire::SurfaceFeature::Point(p) => Feature::Point(vector(&p.point)),
        wire::SurfaceFeature::Edge(e) => Feature::Edge {
            from: vector(&e.from),
            to: vector(&e.to),
            extra: match &e.extra_point {
                wire::OptionalVector::Value(point) => Some(vector(point)),
                wire::OptionalVector::Absent(_) => None,
            },
        },
        wire::SurfaceFeature::Circle(c) => Feature::Circle {
            center: vector(&c.center),
            normal: vector(&c.normal),
            radius: c.radius,
        },
        wire::SurfaceFeature::Plane(p) => Feature::Plane {
            index: p.index,
            normal: vector(&p.normal),
            origin: vector(&p.origin),
        },
    }
}

fn refused(code: wire::MeasureRefusalCode, message: Vec<u16>) -> wire::MeasureRefusal {
    wire::MeasureRefusal { code, message }
}

/// One volume's features, captured for picking off the session.
pub struct MeasureVolume {
    outcome: Result<(Extractor, u64), wire::MeasureRefusal>,
}

/// `captureMeasureVolume`, with the browser's checks in its order.
pub fn capture(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::MeasureVolumeRequest,
) -> MeasureVolume {
    MeasureVolume {
        outcome: captured(state, assets, request),
    }
}

fn captured(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::MeasureVolumeRequest,
) -> Result<(Extractor, u64), wire::MeasureRefusal> {
    use wire::MeasureRefusalCode as Code;
    let id = &request.volume_id;
    let text = |prefix: &str, suffix: &str| {
        units(prefix)
            .into_iter()
            .chain(id.iter().copied())
            .chain(units(suffix))
            .collect()
    };
    let volume = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .find(|volume| volume.id.as_utf16() == id.as_slice())
        .ok_or_else(|| refused(Code::UnknownVolume, text("Unknown volume ", "")))?;
    let lease = assets.peek(&volume.source.asset_id).ok_or_else(|| {
        refused(
            Code::MissingAsset,
            text("Volume ", " has no stored mesh asset"),
        )
    })?;
    let mesh =
        decode_indexed(&lease).map_err(|message| refused(Code::InvalidMesh, units(&message)))?;
    let triangles: Vec<[u32; 3]> = mesh
        .indices
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let count = triangles.len() as u64;
    let extractor = Extractor::new(mesh.positions, triangles).ok_or_else(|| {
        refused(
            Code::DegenerateMesh,
            units("A mesh with no facets has nothing to measure"),
        )
    })?;
    Ok((extractor, count))
}

impl MeasureVolume {
    /// `MeasureVolumeReply`: the plane and facet counts, or the refusal.
    pub fn reply(&self) -> wire::MeasureVolumeReply {
        match &self.outcome {
            Ok((extractor, triangles)) => {
                wire::MeasureVolumeReply::Captured(wire::MeasureVolumeSummary {
                    plane_count: extractor.plane_count() as u64,
                    triangle_count: *triangles,
                })
            }
            Err(refusal) => wire::MeasureVolumeReply::Refused(refusal.clone()),
        }
    }

    /// `MeasureVolume.feature`: the workspace's pick at a volume-local point
    /// on a facet, moved by the host's transform when one is given.
    pub fn feature(&self, request: &wire::MeasureFeatureRequest) -> wire::MeasureFeatureReply {
        use wire::MeasureRefusalCode as Code;
        let refuse =
            |code, message: &str| wire::MeasureFeatureReply::Refused(refused(code, units(message)));
        let Ok((extractor, _)) = &self.outcome else {
            // A refused capture has no facets to pick.
            return refuse(
                Code::UnknownFace,
                &format!("Face {} is not in this mesh", request.face_index),
            );
        };
        let Ok(mut feature) = extractor.feature_at(
            request.face_index,
            vector(&request.point),
            request.only_plane,
        ) else {
            return refuse(
                Code::UnknownFace,
                &format!("Face {} is not in this mesh", request.face_index),
            );
        };
        if let wire::OptionalWorldTransform::Value(matrix) = &request.transform {
            let matrix: [f64; 16] = matrix.as_slice().try_into().expect("a 4x4 transform");
            match transform(&feature, &matrix) {
                Some(moved) => feature = moved,
                None => {
                    return refuse(
                        Code::UnevenScale,
                        "That hole is scaled unevenly, so it has no single radius to measure.",
                    );
                }
            }
        }
        if !finite(feature_numbers(&feature)) {
            return refuse(Code::NonFinite, "The picked feature is not finite");
        }
        wire::MeasureFeatureReply::Feature(wire::MeasuredFeature {
            feature: feature_to_wire(&feature),
            summary: units(&describe(&feature)),
        })
    }
}

fn distance_to_wire(distance: Option<Distance>) -> wire::OptionalMeasureDistance {
    match distance {
        Some(d) => wire::OptionalMeasureDistance::Value(wire::MeasureDistance {
            distance: d.distance,
            from: d.from.to_vec(),
            to: d.to.to_vec(),
        }),
        None => wire::OptionalMeasureDistance::Absent(wire::Empty {}),
    }
}

/// `measureFeaturesWire`: the workspace's measurement of a pair.
pub fn measure_wire(request: &wire::MeasureRequest) -> wire::MeasureReply {
    let result = measure(
        &feature_from_wire(&request.first),
        &feature_from_wire(&request.second),
    );
    let mut numbers = Vec::new();
    if let Some(angle) = result.angle {
        numbers.push(angle.angle);
        numbers.extend(angle.center);
        numbers.push(angle.radius);
    }
    for d in [result.infinite, result.strict].into_iter().flatten() {
        numbers.push(d.distance);
        numbers.extend(d.from);
        numbers.extend(d.to);
    }
    numbers.extend(result.xyz.into_iter().flatten());
    if !finite(numbers) {
        return wire::MeasureReply::Refused(refused(
            wire::MeasureRefusalCode::NonFinite,
            units("The measurement is not finite"),
        ));
    }
    wire::MeasureReply::Measured(wire::MeasureResult {
        angle: match result.angle {
            Some(angle) => wire::OptionalMeasureAngle::Value(wire::MeasureAngle {
                angle: angle.angle,
                center: angle.center.to_vec(),
                radius: angle.radius,
                coplanar: angle.coplanar,
            }),
            None => wire::OptionalMeasureAngle::Absent(wire::Empty {}),
        },
        distance_infinite: distance_to_wire(result.infinite),
        distance_strict: distance_to_wire(result.strict),
        distance_xyz: match result.xyz {
            Some(xyz) => wire::OptionalVector::Value(xyz.to_vec()),
            None => wire::OptionalVector::Absent(wire::Empty {}),
        },
        unsupported: result.unsupported,
    })
}
