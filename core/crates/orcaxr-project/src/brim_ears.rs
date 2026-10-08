//! Brim-ear detection over a live session (`brimEarExchange.ts` over
//! `brimEarDetection.ts` and `brimEarPreview.ts`).
//!
//! Ears are object-local: the first layer an ear holds is the object's model
//! volumes, each moved by its own transform into object space (composed as
//! three.js does, [`crate::picking::compose`]). Detection cuts that layer just
//! above its base, chains the cut into loops and keeps the outward corners
//! sharp enough to peel, thinned to the sharpest of any cluster; the stranded
//! check names the placed ears whose discs reach neither the layer nor an
//! anchored ear.
use crate::assets::AssetRepository;
use crate::js_math::{self, convert};
use crate::mesh::decode_indexed;
use crate::model::{ProjectState, VolumeRole};
use crate::picking::{apply, compose};
use orcaxr_contracts::project_intent_types as wire;
use std::collections::HashMap;

/// Pinned default cut height above the base.
pub const DEFAULT_SAMPLE_HEIGHT_MM: f64 = 0.2;

type P2 = [f64; 2];

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn refused(code: wire::BrimEarRefusalCode, message: Vec<u16>) -> wire::BrimEarRefusal {
    wire::BrimEarRefusal { code, message }
}

/// `objectModelMesh`: every model volume, in volume order, moved by its own
/// transform into object-local millimetres, as flat positions and indices.
pub fn object_model_mesh(
    state: &ProjectState,
    assets: &AssetRepository,
    object_id: &[u16],
) -> Result<(Vec<f64>, Vec<u32>), wire::BrimEarRefusal> {
    use wire::BrimEarRefusalCode as Code;
    let text = |prefix: &str, id: &[u16], suffix: &str| -> Vec<u16> {
        units(prefix)
            .into_iter()
            .chain(id.iter().copied())
            .chain(units(suffix))
            .collect()
    };
    let object = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .find(|object| object.id.as_utf16() == object_id)
        .ok_or_else(|| refused(Code::UnknownObject, text("Unknown object ", object_id, "")))?;
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for volume in object.volumes.iter() {
        if volume.role != VolumeRole::Model {
            continue;
        }
        let lease = assets.peek(&volume.source.asset_id).ok_or_else(|| {
            refused(
                Code::MissingAsset,
                text("Volume ", volume.id.as_utf16(), " has no stored mesh asset"),
            )
        })?;
        let mesh = decode_indexed(&lease)
            .map_err(|message| refused(Code::InvalidMesh, units(&message)))?;
        let matrix = compose(&volume.transform);
        let offset = (positions.len() / 3) as u32;
        for vertex in &mesh.positions {
            positions.extend(apply(vertex, &matrix));
        }
        indices.extend(mesh.indices.iter().map(|&index| offset + index));
    }
    Ok((positions, indices))
}

/// `key`: rounded endpoints, compared as the strings the browser builds
/// (`-0` and `0` spell alike, as do all NaNs).
fn key(point: P2) -> (u64, u64) {
    let part = |value: f64| {
        let rounded = js_math::round(value * 1e4);
        if rounded == 0.0 {
            0u64
        } else if rounded.is_nan() {
            f64::NAN.to_bits()
        } else {
            rounded.to_bits()
        }
    };
    (part(point[0]), part(point[1]))
}

/// `sliceMeshOutline`: the closed loops a horizontal cut at `z` meets.
pub fn slice_outline(positions: &[f64], indices: &[u32], z: f64) -> Vec<Vec<P2>> {
    let mut segments: Vec<(P2, P2)> = Vec::new();
    for triangle in indices.chunks_exact(3) {
        let corner = |slot: usize| {
            let index = triangle[slot] as usize;
            [
                positions[index * 3],
                positions[index * 3 + 1],
                positions[index * 3 + 2],
            ]
        };
        let vertices = [corner(0), corner(1), corner(2)];
        let mut crossing: Vec<P2> = Vec::with_capacity(3);
        for edge in 0..3 {
            let (a, b) = (vertices[edge], vertices[(edge + 1) % 3]);
            // A vertex exactly on the plane counts once, through the edge
            // that leaves it.
            if (a[2] < z && b[2] >= z) || (b[2] < z && a[2] >= z) {
                let t = (z - a[2]) / (b[2] - a[2]);
                crossing.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        if let [first, second] = crossing[..] {
            segments.push((first, second));
        }
    }
    chain(&segments)
}

/// `chainSegments`: segments chained end to start into loops.
fn chain(segments: &[(P2, P2)]) -> Vec<Vec<P2>> {
    let mut by_start: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        by_start.entry(key(segment.0)).or_default().push(index);
    }
    let mut used = vec![false; segments.len()];
    let mut loops = Vec::new();
    for start in 0..segments.len() {
        if used[start] {
            continue;
        }
        let mut chain = vec![segments[start].0];
        let mut current = start;
        used[current] = true;
        for _ in 0..segments.len() + 1 {
            chain.push(segments[current].1);
            if key(segments[current].1) == key(chain[0]) {
                break;
            }
            let next = by_start
                .get(&key(segments[current].1))
                .and_then(|bucket| bucket.iter().copied().find(|&candidate| !used[candidate]));
            let Some(next) = next else {
                break;
            };
            used[next] = true;
            current = next;
        }
        // Two points cannot enclose anything.
        if chain.len() < 4 {
            continue;
        }
        let closed = drop_collinear(&chain[..chain.len() - 1]);
        if closed.len() >= 3 {
            loops.push(closed);
        }
    }
    loops
}

/// `dropCollinear`: points on the straight run between their neighbours.
fn drop_collinear(chain: &[P2]) -> Vec<P2> {
    let n = chain.len();
    let mut kept = Vec::new();
    for index in 0..n {
        let previous = chain[(index + n - 1) % n];
        let current = chain[index];
        let next = chain[(index + 1) % n];
        let cross = (current[0] - previous[0]) * (next[1] - current[1])
            - (current[1] - previous[1]) * (next[0] - current[0]);
        let scale = js_math::max(
            1.0,
            js_math::hypot(&[next[0] - previous[0], next[1] - previous[1]]),
        );
        if cross.abs() <= 1e-9 * scale {
            continue;
        }
        kept.push(current);
    }
    if kept.len() >= 3 {
        kept
    } else {
        chain.to_vec()
    }
}

/// `signedArea`: positive counter-clockwise.
fn signed_area(polygon: &[P2]) -> f64 {
    let mut total = 0.0;
    for index in 0..polygon.len() {
        let (a, b) = (polygon[index], polygon[(index + 1) % polygon.len()]);
        total += a[0] * b[1] - b[0] * a[1];
    }
    total / 2.0
}

/// `detectOutlineCorners`: outward corners no wider than `max_angle_deg`.
fn outline_corners(polygon: &[P2], max_angle_deg: f64) -> Vec<(P2, f64)> {
    if polygon.len() < 3 {
        return Vec::new();
    }
    // `Math.sign(area) || 1`.
    let area = signed_area(polygon);
    let winding = if area > 0.0 {
        1.0
    } else if area < 0.0 {
        -1.0
    } else {
        1.0
    };
    let n = polygon.len();
    let mut corners = Vec::new();
    for index in 0..n {
        let previous = polygon[(index + n - 1) % n];
        let current = polygon[index];
        let next = polygon[(index + 1) % n];
        let incoming = [current[0] - previous[0], current[1] - previous[1]];
        let outgoing = [next[0] - current[0], next[1] - current[1]];
        let incoming_length = js_math::hypot(&incoming);
        let outgoing_length = js_math::hypot(&outgoing);
        if incoming_length < 1e-9 || outgoing_length < 1e-9 {
            continue;
        }
        let cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
        if cross * winding <= 0.0 {
            continue;
        }
        let dot = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1])
            / (incoming_length * outgoing_length);
        let turn_deg = (js_math::acos(js_math::min(1.0, js_math::max(-1.0, dot))) * 180.0)
            / std::f64::consts::PI;
        let interior_deg = 180.0 - turn_deg;
        if interior_deg > max_angle_deg {
            continue;
        }
        corners.push((current, interior_deg));
    }
    corners
}

/// One detected ear: object-local position, radius and interior angle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ear {
    pub position: [f64; 3],
    pub radius_mm: f64,
    pub angle_deg: f64,
}

pub struct Options {
    pub max_angle_deg: f64,
    pub detection_radius_mm: f64,
    pub head_front_radius_mm: f64,
    pub sample_height_mm: f64,
}

/// `detectBrimEars`: the thinned ears, or why there are none.
pub fn detect(positions: &[f64], indices: &[u32], options: &Options) -> (Vec<Ear>, Option<String>) {
    if positions.len() < 9 {
        return (Vec::new(), Some("The object has no geometry.".into()));
    }
    let (mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY);
    for z in positions.iter().skip(2).step_by(3) {
        min_z = js_math::min(min_z, *z);
        max_z = js_math::max(max_z, *z);
    }
    if max_z.is_nan() || min_z.is_nan() || max_z <= min_z {
        return (
            Vec::new(),
            Some("The object is flat; there is no first layer to hold.".into()),
        );
    }
    let z = min_z + js_math::min(options.sample_height_mm, (max_z - min_z) / 2.0);
    let loops = slice_outline(positions, indices, z);
    if loops.is_empty() {
        return (
            Vec::new(),
            Some("No closed outline could be read from the first layer.".into()),
        );
    }
    let mut detected = Vec::new();
    for outline in &loops {
        for (point, angle_deg) in outline_corners(outline, options.max_angle_deg) {
            detected.push(Ear {
                position: [point[0], point[1], min_z],
                radius_mm: options.head_front_radius_mm,
                angle_deg,
            });
        }
    }
    if detected.is_empty() {
        return (
            Vec::new(),
            Some(format!(
                "No corner is sharper than {}°; this outline has nothing that peels.",
                convert::number_to_string(options.max_angle_deg)
            )),
        );
    }
    (thin(detected, options.detection_radius_mm), None)
}

/// `thinBrimEars`: the sharpest of any cluster within `radius_mm`, after the
/// browser's stable sort by angle, then X, then Y.
fn thin(mut ears: Vec<Ear>, radius_mm: f64) -> Vec<Ear> {
    // `a - b || ...`: a zero or NaN difference falls through to the next key.
    let step = |a: f64, b: f64| {
        let difference = a - b;
        if difference > 0.0 {
            Some(std::cmp::Ordering::Greater)
        } else if difference < 0.0 {
            Some(std::cmp::Ordering::Less)
        } else {
            None
        }
    };
    ears.sort_by(|l, r| {
        step(l.angle_deg, r.angle_deg)
            .or_else(|| step(l.position[0], r.position[0]))
            .or_else(|| step(l.position[1], r.position[1]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<Ear> = Vec::new();
    for candidate in ears {
        let collides = kept.iter().any(|existing| {
            js_math::hypot(&[
                existing.position[0] - candidate.position[0],
                existing.position[1] - candidate.position[1],
            ]) < radius_mm
        });
        if !collides {
            kept.push(candidate);
        }
    }
    kept
}

/// `brimEarOutline`: the loops ears must reach, cut as detection cuts.
pub fn outline(positions: &[f64], indices: &[u32], sample_height_mm: f64) -> Option<Vec<Vec<P2>>> {
    if positions.len() < 9 {
        return None;
    }
    let (mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY);
    for z in positions.iter().skip(2).step_by(3) {
        min_z = js_math::min(min_z, *z);
        max_z = js_math::max(max_z, *z);
    }
    if max_z.is_nan() || min_z.is_nan() || max_z <= min_z {
        return None;
    }
    let z = min_z + js_math::min(sample_height_mm, (max_z - min_z) / 2.0);
    Some(slice_outline(positions, indices, z))
}

fn distance_to_segment_squared(p: P2, a: P2, b: P2) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared == 0.0 {
        0.0
    } else {
        js_math::max(
            0.0,
            js_math::min(
                1.0,
                ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_squared,
            ),
        )
    };
    let (cx, cy) = (a[0] + t * dx, a[1] + t * dy);
    (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy)
}

/// `pointInPolygon`: crossings of the half-line to +X.
fn point_in_polygon(x: f64, y: f64, polygon: &[P2]) -> bool {
    let mut inside = false;
    let mut j = polygon.len() - 1;
    for i in 0..polygon.len() {
        let [xi, yi] = polygon[i];
        let [xj, yj] = polygon[j];
        if (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// A placed ear as the connectivity test sees it.
#[derive(Debug, Clone, Copy)]
pub struct Disc {
    pub x: f64,
    pub y: f64,
    pub radius_mm: f64,
}

fn disc_touches(disc: &Disc, loops: &[Vec<P2>]) -> bool {
    let radius_squared = disc.radius_mm * disc.radius_mm;
    for polygon in loops {
        if polygon.is_empty() {
            continue;
        }
        if point_in_polygon(disc.x, disc.y, polygon) {
            return true;
        }
        let mut j = polygon.len() - 1;
        for i in 0..polygon.len() {
            if distance_to_segment_squared([disc.x, disc.y], polygon[j], polygon[i])
                <= radius_squared
            {
                return true;
            }
            j = i;
        }
    }
    false
}

/// `findDisconnectedBrimEars`: ears reaching neither the layer nor, through
/// overlapping discs, an ear that does.
pub fn stranded(discs: &[Disc], loops: &[Vec<P2>]) -> Vec<usize> {
    let mut anchored: Vec<bool> = discs.iter().map(|disc| disc_touches(disc, loops)).collect();
    let mut grew = true;
    while grew {
        grew = false;
        for i in 0..discs.len() {
            if anchored[i] {
                continue;
            }
            for j in 0..discs.len() {
                if i == j || !anchored[j] {
                    continue;
                }
                let (dx, dy) = (discs[i].x - discs[j].x, discs[i].y - discs[j].y);
                let reach = discs[i].radius_mm + discs[j].radius_mm;
                if dx * dx + dy * dy <= reach * reach {
                    anchored[i] = true;
                    grew = true;
                    break;
                }
            }
        }
    }
    (0..discs.len()).filter(|&i| !anchored[i]).collect()
}

/// `detectObjectBrimEarsWire`.
pub fn detect_wire(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::BrimEarDetectRequest,
) -> wire::BrimEarDetectReply {
    let (positions, indices) = match object_model_mesh(state, assets, &request.object_id) {
        Ok(mesh) => mesh,
        Err(refusal) => return wire::BrimEarDetectReply::Refused(refusal),
    };
    let (ears, reason) = detect(
        &positions,
        &indices,
        &Options {
            max_angle_deg: request.max_angle_deg,
            detection_radius_mm: request.detection_radius_mm,
            head_front_radius_mm: request.head_front_radius_mm,
            sample_height_mm: match request.sample_height_mm {
                wire::OptionalFinite::Value(value) => value,
                wire::OptionalFinite::Absent(_) => DEFAULT_SAMPLE_HEIGHT_MM,
            },
        },
    );
    wire::BrimEarDetectReply::Detected(wire::BrimEarDetection {
        ears: ears
            .iter()
            .map(|ear| wire::DetectedBrimEar {
                position_mm: ear.position.to_vec(),
                head_front_radius_mm: ear.radius_mm,
                angle_deg: ear.angle_deg,
            })
            .collect(),
        reason: match reason {
            Some(reason) => wire::OptionalText::Value(units(&reason)),
            None => wire::OptionalText::Absent(wire::Empty {}),
        },
    })
}

/// `strandedObjectBrimEarsWire`.
pub fn stranded_wire(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::BrimEarStrandedRequest,
) -> wire::BrimEarStrandedReply {
    let (positions, indices) = match object_model_mesh(state, assets, &request.object_id) {
        Ok(mesh) => mesh,
        Err(refusal) => return wire::BrimEarStrandedReply::Refused(refusal),
    };
    let object = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .find(|object| object.id.as_utf16() == request.object_id.as_slice())
        .expect("the mesh came from this object");
    let ears: Vec<Disc> = object
        .brim_ears
        .iter()
        .flat_map(|ears| ears.iter())
        .map(|ear| Disc {
            x: ear.position_mm[0].get(),
            y: ear.position_mm[1].get(),
            radius_mm: ear.head_front_radius_mm.get(),
        })
        .collect();
    let indices = if ears.is_empty() {
        Vec::new()
    } else {
        match outline(&positions, &indices, DEFAULT_SAMPLE_HEIGHT_MM) {
            Some(loops) => stranded(&ears, &loops),
            None => Vec::new(),
        }
    };
    wire::BrimEarStrandedReply::Stranded(wire::BrimEarStranded {
        indices: indices.into_iter().map(|i| i as u64).collect(),
    })
}
