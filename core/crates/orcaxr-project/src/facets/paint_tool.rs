//! The painter's settings (`PaintStrokeService.ts`'s `paintSelectionInputs`,
//! through `PaintToolExchange.ts`): the paint stroke sample one pointer hit
//! makes with the paint tool's settings — the hit's facet, the active tool
//! with its parameters clamped to the pinned gizmo limits and the workspace's
//! defaults filled in, the clipping plane, the transform the hit's placement
//! makes and the overhang gate — or the painter's refusal.
//!
//! A hit's [`Placement`] (the instance's and the part's canonical
//! transforms) places the brush on the bed (`PaintPlacement.ts`'s
//! `placePaintHit`, as Orca's painter gizmo does): the sample's transform is
//! the instance's matrix after the part's, with the matrix's singular values,
//! largest first, as its scaling factors, and Height Range starts at the
//! hit's bed Z. The selector divides the brush radius by the factors only
//! when they agree (a uniform scale under any rotation or mirror) and
//! otherwise selects on the bed, so the sphere is a ball of the set radius in
//! bed millimetres (an ellipsoid in a non-uniformly scaled part's own
//! coordinates), the circle a cylinder of it along the view, and the band a
//! slab of bed Z.
//!
//! The exchange is canonical JSON: [`sample_json`] answers
//! `{"channel","hit","settings","stateOrder"}` with
//! `{"sample":"<PaintStrokeSample wire>"}` or
//! `{"error":"invalid_hit"|"invalid_settings","message"}`; a malformed
//! request is refused as `invalid_request`.
use crate::js_math;
use crate::picking::{compose_parts, multiply};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_contracts::project_intent_types as wire;
use std::collections::BTreeMap;

pub use crate::placement::bed::{INPUT_LIMIT, INVALID_REQUEST, OUTPUT_LIMIT};

/// `ORCA_BRUSH_RADIUS_MIN_MM` and `ORCA_BRUSH_RADIUS_MAX_MM`.
pub const BRUSH_RADIUS_MM: (f64, f64) = (0.4, 8.0);
/// `ORCA_HEIGHT_RANGE_MIN_MM` and `ORCA_HEIGHT_RANGE_MAX_MM`.
pub const HEIGHT_RANGE_MM: (f64, f64) = (0.1, 8.0);
/// `ORCA_SMART_FILL_ANGLE_MIN_DEGREES` and `ORCA_SMART_FILL_ANGLE_MAX_DEGREES`.
pub const SMART_FILL_ANGLE_DEGREES: (f64, f64) = (0.0, 90.0);
/// `ORCA_GAP_AREA_MAX_MM2`.
pub const GAP_AREA_MAX_MM2: f64 = 5.0;
/// `ORCA_OVERHANG_ANGLE_MAX_DEGREES`.
pub const OVERHANG_ANGLE_MAX_DEGREES: f64 = 90.0;
/// The largest integer a JavaScript number holds exactly: the wire's facet counter.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The paint tools (`PaintToolKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Circle,
    Sphere,
    Triangle,
    HeightRange,
    Fill,
    GapFill,
}
impl ToolKind {
    pub const ALL: [Self; 6] = [
        Self::Circle,
        Self::Sphere,
        Self::Triangle,
        Self::HeightRange,
        Self::Fill,
        Self::GapFill,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Circle => "circle",
            Self::Sphere => "sphere",
            Self::Triangle => "triangle",
            Self::HeightRange => "heightRange",
            Self::Fill => "fill",
            Self::GapFill => "gapFill",
        }
    }
}

/// The channels a paint surface authors (`PaintChannel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaintChannel {
    Color,
    Support,
    Seam,
    FuzzySkin,
}
impl PaintChannel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Color => "color",
            Self::Support => "support",
            Self::Seam => "seam",
            Self::FuzzySkin => "fuzzySkin",
        }
    }
    /// The channel a stroke paints; brim has no paint surface.
    pub fn of_channel(channel: super::Channel) -> Option<Self> {
        match channel {
            super::Channel::Color => Some(Self::Color),
            super::Channel::Support => Some(Self::Support),
            super::Channel::Seam => Some(Self::Seam),
            super::Channel::FuzzySkin => Some(Self::FuzzySkin),
            super::Channel::Brim => None,
        }
    }
    fn of(name: &[u16]) -> Option<Self> {
        [Self::Color, Self::Support, Self::Seam, Self::FuzzySkin]
            .into_iter()
            .find(|channel| channel.name().encode_utf16().eq(name.iter().copied()))
    }
}

/// `PaintToolSettings`.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub tool: ToolKind,
    pub radius_mm: Option<f64>,
    pub smart_fill_angle_degrees: Option<f64>,
    pub height_range_mm: Option<f64>,
    pub gap_area_mm2: Option<f64>,
    pub highlight_by_angle_degrees: Option<f64>,
    pub triangle_splitting: Option<bool>,
    pub clipping_plane: Option<wire::FacetClippingPlane>,
}

/// `PaintTargetHit` without its volume: where the pointer met the volume.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub triangle_index: f64,
    /// The hit in volume-local mesh coordinates.
    pub local_point: [f64; 3],
    /// The ray origin in volume-local mesh coordinates.
    pub local_camera_position: [f64; 3],
    /// The previous drag sample, so a dragged brush sweeps a capsule.
    pub previous_local_point: Option<[f64; 3]>,
    /// Where the part sits on the bed; none is a part at the bed's origin,
    /// unscaled and unrotated.
    pub placement: Option<Placement>,
}

/// A canonical transform (`Transform`): translation in millimetres, rotation
/// quaternion `[x, y, z, w]`, scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalTransform {
    pub translation_mm: [f64; 3],
    pub rotation: [f64; 4],
    pub scale: [f64; 3],
}
impl CanonicalTransform {
    pub const IDENTITY: Self = Self {
        translation_mm: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
    };
}

/// `PaintPlacement`: the instance a hit met and the part inside it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub instance: CanonicalTransform,
    pub volume: CanonicalTransform,
}

/// `PlacedPaintHit`: the selector's transform and the hit's bed Z.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub transform: wire::FacetSelectionTransform,
    pub plate_z_mm: f64,
}

/// Sweeps of Jacobi rotations at most; a 3×3 converges in far fewer.
const JACOBI_SWEEPS: usize = 64;

/// `placePaintHit`: the selector's transform for [placement] and the bed Z of
/// [local_point] under it (Orca's `float((trafo * Vec3d(hit)).z())`), or
/// none for a placement that is not finite and invertible.
pub fn place(placement: &Placement, local_point: [f64; 3]) -> Option<Placed> {
    let matrix = |t: &CanonicalTransform| compose_parts(t.translation_mm, t.rotation, t.scale);
    let m = multiply(&matrix(&placement.instance), &matrix(&placement.volume));
    let linear = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
    let translation = [m[12], m[13], m[14]];
    if !m.iter().all(|value| value.is_finite()) {
        return None;
    }
    let scaling_factors = singular_values(&linear);
    if !scaling_factors
        .iter()
        .all(|value| *value > 0.0 && value.is_finite())
    {
        return None;
    }
    let [x, y, z] = local_point.map(|value| value as f32 as f64);
    let plate_z_mm =
        (linear[2][0] * x + linear[2][1] * y + linear[2][2] * z + translation[2]) as f32 as f64;
    Some(Placed {
        transform: wire::FacetSelectionTransform {
            linear: linear.iter().map(|row| row.to_vec()).collect(),
            translation: translation.to_vec(),
            scaling_factors: scaling_factors.to_vec(),
        },
        plate_z_mm,
    })
}

/// The singular values of [linear], largest first: the square roots of the
/// eigenvalues of `LᵀL` by cyclic Jacobi rotations.
fn singular_values(linear: &[[f64; 3]; 3]) -> [f64; 3] {
    let mut a = [[0.0; 3]; 3];
    for (i, row) in a.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = linear[0][i] * linear[0][j]
                + linear[1][i] * linear[1][j]
                + linear[2][i] * linear[2][j];
        }
    }
    for _ in 0..JACOBI_SWEEPS {
        if a[0][1] == 0.0 && a[0][2] == 0.0 && a[1][2] == 0.0 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            let apq = a[p][q];
            if apq == 0.0 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * apq);
            let sign = if theta >= 0.0 { 1.0 } else { -1.0 };
            let t = sign / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for row in a.iter_mut() {
                let (akp, akq) = (row[p], row[q]);
                row[p] = c * akp - s * akq;
                row[q] = s * akp + c * akq;
            }
            let (row_p, row_q) = (a[p], a[q]);
            a[p] = std::array::from_fn(|k| c * row_p[k] - s * row_q[k]);
            a[q] = std::array::from_fn(|k| s * row_p[k] + c * row_q[k]);
            a[p][q] = 0.0;
            a[q][p] = 0.0;
        }
    }
    let mut values =
        [a[0][0], a[1][1], a[2][2]].map(|value| if value > 0.0 { value.sqrt() } else { 0.0 });
    values.sort_by(|first, second| second.total_cmp(first));
    values
}

/// The painter's refusal (`PaintTargetError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    InvalidHit(&'static str),
    InvalidSettings(&'static str),
}
impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidHit(_) => "invalid_hit",
            Self::InvalidSettings(_) => "invalid_settings",
        }
    }
    pub fn message(&self) -> &'static str {
        match self {
            Self::InvalidHit(message) | Self::InvalidSettings(message) => message,
        }
    }
}

/// The browser's `clamp`: `Math.min(maximum, Math.max(minimum, value))`,
/// refusing a non-finite value.
fn clamp(value: f64, minimum: f64, maximum: f64) -> Result<f64, Refusal> {
    if !value.is_finite() {
        return Err(Refusal::InvalidSettings(
            "Paint tool settings must be finite numbers",
        ));
    }
    Ok(js_math::min(maximum, js_math::max(minimum, value)))
}

fn vector(value: [f64; 3]) -> wire::Vector {
    value.to_vec()
}
fn optional_vector(value: Option<[f64; 3]>) -> wire::OptionalVector {
    match value {
        Some(value) => wire::OptionalVector::Value(vector(value)),
        None => wire::OptionalVector::Absent(wire::Empty {}),
    }
}
fn text_value(text: &str) -> wire::PaintValueInput {
    wire::PaintValueInput::Text(text.encode_utf16().collect())
}

/// `paintSelectionInputs` as one sample of a paint stroke: the hit's facet,
/// the active tool (`paintRegionTool`), the clipping plane, the placement and
/// the overhang gate. Gap Fill's colour precedence is [state_order], the
/// palette's displayed filament order; the other channels use their pinned
/// order.
pub fn sample(
    settings: &Settings,
    hit: &Hit,
    channel: PaintChannel,
    state_order: impl FnOnce() -> Vec<Vec<u16>>,
) -> Result<wire::PaintStrokeSample, Refusal> {
    let index = hit.triangle_index;
    if index.fract() != 0.0 || !index.is_finite() || index < 0.0 {
        return Err(Refusal::InvalidHit(
            "The paint hit does not reference a source triangle",
        ));
    }
    let placed = match &hit.placement {
        Some(placement) => Some(place(placement, hit.local_point).ok_or(Refusal::InvalidHit(
            "The paint placement must be finite and invertible",
        ))?),
        None => None,
    };
    let splitting = settings.triangle_splitting == Some(true);
    let (tool, splits) = match settings.tool {
        ToolKind::Triangle => (
            wire::FacetRegionTool::Triangle(wire::FacetRegionTriangle {
                hit: optional_vector(Some(hit.local_point)),
            }),
            false,
        ),
        ToolKind::Circle | ToolKind::Sphere => {
            let brush = wire::FacetRegionBrush {
                center: vector(hit.local_point),
                previous_center: optional_vector(hit.previous_local_point),
                camera_position: vector(hit.local_camera_position),
                radius_mm: clamp(
                    settings.radius_mm.unwrap_or(2.0),
                    BRUSH_RADIUS_MM.0,
                    BRUSH_RADIUS_MM.1,
                )?,
            };
            let tool = if settings.tool == ToolKind::Circle {
                wire::FacetRegionTool::Circle(brush)
            } else {
                wire::FacetRegionTool::Sphere(brush)
            };
            (tool, splitting)
        }
        ToolKind::HeightRange => {
            let start_z_mm = match &placed {
                Some(placed) => placed.plate_z_mm,
                None => hit.local_point[2] as f32 as f64,
            };
            let height_mm = clamp(
                settings.height_range_mm.unwrap_or(1.0),
                HEIGHT_RANGE_MM.0,
                HEIGHT_RANGE_MM.1,
            )?;
            (
                wire::FacetRegionTool::HeightRange(wire::FacetRegionHeightRange {
                    start_z_mm,
                    height_mm,
                }),
                splitting,
            )
        }
        ToolKind::Fill => {
            // `angle <= min ? false : { clamp(angle) }`: NaN is not `<= min`, and its clamp refuses.
            let angle = match settings.smart_fill_angle_degrees {
                Some(angle) if angle > SMART_FILL_ANGLE_DEGREES.0 || angle.is_nan() => {
                    wire::OptionalFinite::Value(clamp(
                        angle,
                        SMART_FILL_ANGLE_DEGREES.0,
                        SMART_FILL_ANGLE_DEGREES.1,
                    )?)
                }
                _ => wire::OptionalFinite::Absent(wire::Empty {}),
            };
            (
                wire::FacetRegionTool::Fill(wire::FacetRegionFill {
                    hit: optional_vector(Some(hit.local_point)),
                    max_adjacent_angle_degrees: angle,
                }),
                false,
            )
        }
        ToolKind::GapFill => {
            let max_area_mm2 = clamp(settings.gap_area_mm2.unwrap_or(2.0), 0.0, GAP_AREA_MAX_MM2)?;
            let state_order = match channel {
                PaintChannel::Color => state_order()
                    .into_iter()
                    .map(wire::PaintValueInput::Text)
                    .collect(),
                PaintChannel::Support => vec![text_value("enforce"), text_value("block")],
                PaintChannel::Seam => vec![text_value("prefer"), text_value("avoid")],
                PaintChannel::FuzzySkin => vec![wire::PaintValueInput::Flag(true)],
            };
            (
                wire::FacetRegionTool::GapFill(wire::FacetRegionGapFill {
                    max_area_mm2,
                    state_order,
                }),
                false,
            )
        }
    };
    // `settings.highlightByAngleDegrees ? clamp(...) : absent`: zero is falsy.
    let highlight = match settings.highlight_by_angle_degrees {
        Some(angle) if angle != 0.0 && !angle.is_nan() => {
            wire::OptionalFinite::Value(clamp(angle, 0.0, OVERHANG_ANGLE_MAX_DEGREES)?)
        }
        _ => wire::OptionalFinite::Absent(wire::Empty {}),
    };
    Ok(wire::PaintStrokeSample {
        seed_triangle: index as u64,
        tool,
        triangle_splitting: splits,
        clipping_plane: match &settings.clipping_plane {
            Some(plane) => wire::OptionalFacetClippingPlane::Value(plane.clone()),
            None => wire::OptionalFacetClippingPlane::Absent(wire::Empty {}),
        },
        transform: match placed {
            Some(placed) => wire::OptionalFacetSelectionTransform::Value(placed.transform),
            None => wire::OptionalFacetSelectionTransform::Absent(wire::Empty {}),
        },
        highlight_by_angle_degrees: highlight,
    })
}

// --- Exchange ------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}
fn members(
    value: Value,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| {
        required
            .iter()
            .chain(optional)
            .any(|k| k.encode_utf16().eq(key.iter().copied()))
    };
    if !fields.keys().all(known) || !required.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn finite(value: &Value) -> Result<f64, &'static str> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(*n),
        _ => Err(INVALID_REQUEST),
    }
}
fn vector_of(value: &Value) -> Result<[f64; 3], &'static str> {
    let Value::Array(items) = value else {
        return Err(INVALID_REQUEST);
    };
    let [x, y, z] = items.as_slice() else {
        return Err(INVALID_REQUEST);
    };
    Ok([finite(x)?, finite(y)?, finite(z)?])
}
fn field<'a>(fields: &'a BTreeMap<Vec<u16>, Value>, key: &str) -> Option<&'a Value> {
    fields.get(&units(key))
}
fn transform_of(value: &Value) -> Result<CanonicalTransform, &'static str> {
    let fields = members(value.clone(), &["rotation", "scale", "translationMm"], &[])?;
    let Some(Value::Array(rotation)) = field(&fields, "rotation") else {
        return Err(INVALID_REQUEST);
    };
    let [x, y, z, w] = rotation.as_slice() else {
        return Err(INVALID_REQUEST);
    };
    Ok(CanonicalTransform {
        translation_mm: vector_of(&fields[&units("translationMm")])?,
        rotation: [finite(x)?, finite(y)?, finite(z)?, finite(w)?],
        scale: vector_of(&fields[&units("scale")])?,
    })
}
fn placement_of(value: &Value) -> Result<Placement, &'static str> {
    let fields = members(value.clone(), &["instance", "volume"], &[])?;
    Ok(Placement {
        instance: transform_of(&fields[&units("instance")])?,
        volume: transform_of(&fields[&units("volume")])?,
    })
}
fn hit_of(value: Value) -> Result<Hit, &'static str> {
    let fields = members(
        value,
        &["localCameraPosition", "localPoint", "triangleIndex"],
        &["placement", "previousLocalPoint"],
    )?;
    let triangle_index = finite(&fields[&units("triangleIndex")])?;
    // The wire's facet counter: anything larger is not a facet any mesh holds.
    if triangle_index.abs() > MAX_SAFE_INTEGER {
        return Err(INVALID_REQUEST);
    }
    Ok(Hit {
        triangle_index,
        local_point: vector_of(&fields[&units("localPoint")])?,
        local_camera_position: vector_of(&fields[&units("localCameraPosition")])?,
        previous_local_point: field(&fields, "previousLocalPoint")
            .map(vector_of)
            .transpose()?,
        placement: field(&fields, "placement").map(placement_of).transpose()?,
    })
}
fn settings_of(value: Value) -> Result<Settings, &'static str> {
    let fields = members(
        value,
        &["tool"],
        &[
            "clippingPlane",
            "gapAreaMm2",
            "heightRangeMm",
            "highlightByAngleDegrees",
            "radiusMm",
            "smartFillAngleDegrees",
            "triangleSplitting",
        ],
    )?;
    let Some(Value::String(tool)) = field(&fields, "tool") else {
        return Err(INVALID_REQUEST);
    };
    let tool = ToolKind::ALL
        .into_iter()
        .find(|kind| kind.name().encode_utf16().eq(tool.iter().copied()))
        .ok_or(INVALID_REQUEST)?;
    let number = |key: &str| field(&fields, key).map(finite).transpose();
    let triangle_splitting = match field(&fields, "triangleSplitting") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Err(INVALID_REQUEST),
    };
    let clipping_plane = match field(&fields, "clippingPlane") {
        None => None,
        Some(plane) => {
            let plane = members(plane.clone(), &["normal", "offset"], &[])?;
            Some(wire::FacetClippingPlane {
                normal: vector(vector_of(&plane[&units("normal")])?),
                offset: finite(&plane[&units("offset")])?,
            })
        }
    };
    Ok(Settings {
        tool,
        radius_mm: number("radiusMm")?,
        smart_fill_angle_degrees: number("smartFillAngleDegrees")?,
        height_range_mm: number("heightRangeMm")?,
        gap_area_mm2: number("gapAreaMm2")?,
        highlight_by_angle_degrees: number("highlightByAngleDegrees")?,
        triangle_splitting,
        clipping_plane,
    })
}

/// A sample request: `{"channel","hit","settings"}`.
#[derive(Debug, Clone, PartialEq)]
pub struct SampleRequest {
    pub channel: PaintChannel,
    pub hit: Hit,
    pub settings: Settings,
}

fn read(request: &str) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    match parse(request).map_err(|_| INVALID_REQUEST)? {
        Value::Object(fields) => Ok(fields),
        _ => Err(INVALID_REQUEST),
    }
}

/// Reads `{"channel","hit","settings","stateOrder"}`.
pub fn read_request(request: &str) -> Result<(SampleRequest, Vec<Vec<u16>>), &'static str> {
    let mut fields = members(
        Value::Object(read(request)?),
        &["channel", "hit", "settings", "stateOrder"],
        &[],
    )?;
    let Some(Value::String(channel)) = field(&fields, "channel") else {
        return Err(INVALID_REQUEST);
    };
    let channel = PaintChannel::of(channel).ok_or(INVALID_REQUEST)?;
    let Some(Value::Array(entries)) = fields.remove(&units("stateOrder")) else {
        return Err(INVALID_REQUEST);
    };
    let state_order = entries
        .into_iter()
        .map(|entry| match entry {
            Value::String(text) => Ok(text),
            _ => Err(INVALID_REQUEST),
        })
        .collect::<Result<_, _>>()?;
    let hit = hit_of(fields.remove(&units("hit")).unwrap_or(Value::Null))?;
    let settings = settings_of(fields.remove(&units("settings")).unwrap_or(Value::Null))?;
    Ok((
        SampleRequest {
            channel,
            hit,
            settings,
        },
        state_order,
    ))
}

/// Reads a stroke's sample, `{"hit","settings"}`: the stroke knows its channel and palette.
pub fn read_stroke_request(request: &str) -> Result<(Hit, Settings), &'static str> {
    let mut fields = members(Value::Object(read(request)?), &["hit", "settings"], &[])?;
    let hit = hit_of(fields.remove(&units("hit")).unwrap_or(Value::Null))?;
    let settings = settings_of(fields.remove(&units("settings")).unwrap_or(Value::Null))?;
    Ok((hit, settings))
}

/// A sample, or the painter's refusal, as the exchange answers it.
pub fn reply_value(
    result: &Result<wire::PaintStrokeSample, Refusal>,
) -> Result<Value, &'static str> {
    Ok(match result {
        Ok(sample) => {
            let text = wire::encode_paint_stroke_sample(sample).map_err(|_| OUTPUT_LIMIT)?;
            Value::Object([(units("sample"), Value::String(units(&text)))].into())
        }
        Err(refusal) => Value::Object(
            [
                (units("error"), Value::String(units(refusal.code()))),
                (units("message"), Value::String(units(refusal.message()))),
            ]
            .into(),
        ),
    })
}

/// `paintToolSampleExchange`: `{"channel","hit","settings","stateOrder"}` →
/// `{"sample"}` or `{"error","message"}`.
pub fn sample_json(request: &str) -> Result<String, &'static str> {
    let (request, state_order) = read_request(request)?;
    canonical(&reply_value(&sample(
        &request.settings,
        &request.hit,
        request.channel,
        || state_order,
    ))?)
}

/// Canonical JSON text of [value].
pub fn canonical_text(value: &Value) -> Result<String, &'static str> {
    canonical(value)
}
