//! Wipe-tower auto-placement (`wipeTowerPlacement.ts`, through
//! `wipeTowerExchange.ts`): eight candidate corners and edge midpoints of the
//! printable rectangle, scored by the Chebyshev clearance of the tower's whole
//! printed footprint (body plus brim and rib overhang) to every printable part,
//! with the requested bias winning ties within 5 mm. Configuration values are
//! read with JavaScript's coercions (`Number(...)`, `String(...)`, `??`, `||`),
//! exactly as the browser reads them.
use super::{bounds_with, text};
use crate::assets::AssetRepository;
use crate::js_math::convert::{is_space, number, value_to_number, value_to_string};
use crate::model::{ProjectPlate, ProjectState, VolumeRole};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

const COMPARE_EPS_MM: f64 = 5.0;
const PRINTABLE_ROLES: [VolumeRole; 3] = [
    VolumeRole::Model,
    VolumeRole::SupportEnforcer,
    VolumeRole::SupportBlocker,
];

#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x_min: f64,
    y_min: f64,
    x_max: f64,
    y_max: f64,
}
impl Rect {
    fn wire(&self) -> wire::WipeTowerRect {
        wire::WipeTowerRect {
            x_min: self.x_min,
            y_min: self.y_min,
            x_max: self.x_max,
            y_max: self.y_max,
        }
    }
    /// `validBedRect`.
    fn valid(self) -> Option<Self> {
        (self.x_max > self.x_min && self.y_max > self.y_min).then_some(self)
    }
    fn expand(&self, margin: f64) -> Self {
        Self {
            x_min: self.x_min - margin,
            y_min: self.y_min - margin,
            x_max: self.x_max + margin,
            y_max: self.y_max + margin,
        }
    }
}

/// `Math.max` / `Math.min` over two values: NaN if either is NaN.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `aabbLInfClearance`: the Chebyshev gap between two boxes, negative on overlap.
fn clearance(a: &Rect, b: &Rect) -> f64 {
    let dx = js_max(a.x_min - b.x_max, b.x_min - a.x_max);
    let dy = js_max(a.y_min - b.y_max, b.y_min - a.y_max);
    js_max(dx, dy)
}

fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}

/// A configuration value, or `None` for a missing or JSON-null one (`??`).
fn present<'a>(config: &'a Value, name: &str) -> Option<&'a Value> {
    match config {
        Value::Object(fields) => fields.get(&key(name)).filter(|v| !matches!(v, Value::Null)),
        _ => None,
    }
}

/// `numeric`: a number as is, otherwise `Number(value[0])` for an array or
/// `Number(value)`; only a finite result counts.
fn numeric(value: Option<&Value>) -> Option<f64> {
    let parsed = match value {
        Some(Value::Number(n)) => *n,
        Some(Value::Array(items)) => value_to_number(items.first()),
        other => value_to_number(other),
    };
    parsed.is_finite().then_some(parsed)
}

/// `wipeTowerFootprintMarginMm` over the merged plate and project configuration.
fn footprint_margin(state: &ProjectState, plate: &ProjectPlate) -> f64 {
    // `{ ...state.config, ...plate.config }`: the plate's key wins, even null.
    let merged = |name: &str| -> Option<Value> {
        let lookup = |config: &Value| match config {
            Value::Object(fields) => fields.get(&key(name)).cloned(),
            _ => None,
        };
        lookup(plate.config.value()).or_else(|| lookup(state.config.value()))
    };
    let brim = js_max(
        0.0,
        numeric(merged("prime_tower_brim_width").as_ref()).unwrap_or(0.0),
    );
    let wall = match merged("wipe_tower_wall_type") {
        None | Some(Value::Null) => String::new(),
        Some(value) => String::from_utf16_lossy(&value_to_string(&value)),
    };
    let wall: String = wall
        .trim_matches(is_space)
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if wall != "rib" {
        return brim;
    }
    let rib = js_max(
        0.0,
        numeric(merged("wipe_tower_rib_width").as_ref()).unwrap_or(0.0),
    );
    let extra = js_max(
        0.0,
        numeric(merged("wipe_tower_extra_rib_length").as_ref()).unwrap_or(0.0),
    );
    brim + rib / 2.0 + extra / 2.0
}

/// One `NNxNN` coordinate of `printable_area`: `^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*x\s*(...)\s*$/i`.
fn area_point(entry: &str) -> Option<(f64, f64)> {
    fn token(s: &str) -> Option<(&str, &str)> {
        let bytes = s.as_bytes();
        let mut i = 0;
        if bytes.first() == Some(&b'-') {
            i = 1;
        }
        let digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        let mut end = i + digits;
        if digits > 0 {
            if bytes.get(end) == Some(&b'.') {
                end += 1;
                end += bytes[end..]
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
            }
        } else {
            if bytes.get(end) != Some(&b'.') {
                return None;
            }
            let fraction = bytes[end + 1..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            if fraction == 0 {
                return None;
            }
            end += 1 + fraction;
        }
        Some((&s[..end], &s[end..]))
    }
    let rest = entry.trim_start_matches(is_space);
    let (x, rest) = token(rest)?;
    let rest = rest.trim_start_matches(is_space);
    let rest = rest.strip_prefix(['x', 'X'])?;
    let rest = rest.trim_start_matches(is_space);
    let (y, rest) = token(rest)?;
    if !rest.trim_start_matches(is_space).is_empty() {
        return None;
    }
    let (x, y) = (number(x), number(y));
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// `printableAreaRect`: the rectangle a `printable_area` polygon encloses.
fn printable_area_rect(value: Option<&Value>) -> Option<Rect> {
    let entries: Vec<String> = match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(units) => Some(String::from_utf16_lossy(units)),
                _ => None,
            })
            .collect(),
        Some(Value::String(units)) => String::from_utf16_lossy(units)
            .split([',', ';'])
            .map(|entry| entry.trim_matches(is_space).to_owned())
            .collect(),
        _ => Vec::new(),
    };
    let points: Vec<(f64, f64)> = entries.iter().filter_map(|e| area_point(e)).collect();
    if points.len() < 2 {
        return None;
    }
    let fold = |pick: fn(f64, f64) -> f64, get: fn(&(f64, f64)) -> f64| {
        points.iter().map(get).reduce(pick).unwrap_or(f64::NAN)
    };
    Rect {
        x_min: fold(js_min, |p| p.0),
        y_min: fold(js_min, |p| p.1),
        x_max: fold(js_max, |p| p.0),
        y_max: fold(js_max, |p| p.1),
    }
    .valid()
}

/// `printableAreaRect` as `[xMin, yMin, xMax, yMax]`, for the workspace bed.
pub(super) fn printable_area(value: Option<&Value>) -> Option<[f64; 4]> {
    printable_area_rect(value).map(|r| [r.x_min, r.y_min, r.x_max, r.y_max])
}

const LABELS: [&str; 8] = [
    "back-left",
    "back-right",
    "front-left",
    "front-right",
    "back-mid",
    "front-mid",
    "left-mid",
    "right-mid",
];

fn bias_order(bias: &wire::WipeTowerBiasName) -> [&'static str; 8] {
    match bias {
        wire::WipeTowerBiasName::BackLeft | wire::WipeTowerBiasName::LargestClearance => [
            "back-left",
            "back-mid",
            "back-right",
            "left-mid",
            "right-mid",
            "front-left",
            "front-mid",
            "front-right",
        ],
        wire::WipeTowerBiasName::BackRight => [
            "back-right",
            "back-mid",
            "back-left",
            "right-mid",
            "left-mid",
            "front-right",
            "front-mid",
            "front-left",
        ],
        wire::WipeTowerBiasName::FrontLeft => [
            "front-left",
            "front-mid",
            "front-right",
            "left-mid",
            "right-mid",
            "back-left",
            "back-mid",
            "back-right",
        ],
        wire::WipeTowerBiasName::FrontRight => [
            "front-right",
            "front-mid",
            "front-left",
            "right-mid",
            "left-mid",
            "back-right",
            "back-mid",
            "back-left",
        ],
    }
}

/// `planWipeTowerPlacement`.
pub fn plan(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::WipeTowerRequest,
) -> wire::WipeTowerReply {
    let refuse = |code, message: String| {
        wire::WipeTowerReply::Refused(wire::WipeTowerRefusal {
            code,
            message: message.encode_utf16().collect(),
        })
    };
    let Some(plate) = state
        .plates
        .iter()
        .find(|plate| plate.id.as_utf16() == request.plate_id.as_slice())
    else {
        return refuse(
            wire::WipeTowerRefusalCode::UnknownPlate,
            format!("Unknown plate {}", text(&request.plate_id)),
        );
    };
    let optional = |value: &wire::OptionalFinite| match value {
        wire::OptionalFinite::Value(v) => Some(*v),
        wire::OptionalFinite::Absent(_) => None,
    };
    // The printable area is the authority; the legacy extent is the fallback.
    let requested = match &request.bed_rect_mm {
        wire::OptionalWipeTowerRect::Value(r) => Rect {
            x_min: r.x_min,
            y_min: r.y_min,
            x_max: r.x_max,
            y_max: r.y_max,
        }
        .valid(),
        wire::OptionalWipeTowerRect::Absent(_) => None,
    };
    let from_size = match &request.bed_size_mm {
        wire::OptionalPlanarPosition::Value(size) if size[0] > 0.0 && size[1] > 0.0 => Rect {
            x_min: 0.0,
            y_min: 0.0,
            x_max: size[0],
            y_max: size[1],
        }
        .valid(),
        _ => None,
    };
    let area = present(plate.config.value(), "printable_area")
        .or_else(|| present(state.config.value(), "printable_area"));
    let Some(bed) = requested
        .or_else(|| printable_area_rect(area))
        .or(from_size)
    else {
        return refuse(
            wire::WipeTowerRefusalCode::InvalidBed,
            "Wipe-tower placement requires a positive printable area".to_owned(),
        );
    };
    let tower_w = optional(&request.tower_w).unwrap_or_else(|| {
        let width = present(plate.config.value(), "prime_tower_width")
            .or_else(|| present(state.config.value(), "prime_tower_width"))
            .or_else(|| present(plate.config.value(), "wipe_tower_width"))
            .or_else(|| present(state.config.value(), "wipe_tower_width"));
        // `Number(width) || 60`: undefined, zero and NaN fall back.
        let width = value_to_number(width);
        if width == 0.0 || width.is_nan() {
            60.0
        } else {
            width
        }
    });
    let tower_d = optional(&request.tower_d).unwrap_or(tower_w);
    let roles: Vec<VolumeRole> = match &request.volume_roles {
        wire::OptionalVolumeRoleNames::Value(roles) => roles
            .iter()
            .map(|role| match role {
                wire::VolumeRoleName::Model => VolumeRole::Model,
                wire::VolumeRoleName::NegativeVolume => VolumeRole::NegativeVolume,
                wire::VolumeRoleName::ParameterModifier => VolumeRole::ParameterModifier,
                wire::VolumeRoleName::SupportBlocker => VolumeRole::SupportBlocker,
                wire::VolumeRoleName::SupportEnforcer => VolumeRole::SupportEnforcer,
            })
            .collect(),
        wire::OptionalVolumeRoleNames::Absent(_) => PRINTABLE_ROLES.to_vec(),
    };
    let snapshot = assets.capture_internal();
    let mut parts = Vec::new();
    for object in plate.objects.iter() {
        for instance in object.instances.iter() {
            if !instance.printable {
                continue;
            }
            // Skip unreadable or non-printable instances.
            if let Ok(b) = bounds_with(
                state,
                &snapshot,
                &[instance.id.as_utf16().to_vec()],
                None,
                &roles,
            ) {
                parts.push(Rect {
                    x_min: b.min[0],
                    y_min: b.min[1],
                    x_max: b.max[0],
                    y_max: b.max[1],
                });
            }
        }
    }
    let margin = optional(&request.margin_mm).unwrap_or_else(|| footprint_margin(state, plate));
    let safety = optional(&request.safety_mm).unwrap_or(5.0);
    let bias = match &request.bias {
        wire::OptionalWipeTowerBias::Value(bias) => *bias,
        wire::OptionalWipeTowerBias::Absent(_) => wire::WipeTowerBiasName::BackLeft,
    };
    let margin = js_max(0.0, margin);

    // `scoreWipeTower`: the footprint's corners, converted back to the body's.
    let foot_w = tower_w + 2.0 * margin;
    let foot_d = tower_d + 2.0 * margin;
    let inset = 1.0;
    let slack_x = js_max(bed.x_max - bed.x_min - foot_w, 0.0);
    let slack_y = js_max(bed.y_max - bed.y_min - foot_d, 0.0);
    let x_left = bed.x_min + js_min(inset, slack_x);
    let x_right = bed.x_min + js_max(slack_x - inset, 0.0);
    let x_mid = bed.x_min + slack_x / 2.0;
    let y_front = bed.y_min + js_min(inset, slack_y);
    let y_back = bed.y_min + js_max(slack_y - inset, 0.0);
    let y_mid = bed.y_min + slack_y / 2.0;
    let corners = [
        (x_left, y_back),
        (x_right, y_back),
        (x_left, y_front),
        (x_right, y_front),
        (x_mid, y_back),
        (x_mid, y_front),
        (x_left, y_mid),
        (x_right, y_mid),
    ];
    struct Ranked {
        label: &'static str,
        x: f64,
        y: f64,
        clearance: f64,
        footprint: Rect,
    }
    let ranked: Vec<Ranked> = LABELS
        .iter()
        .zip(corners)
        .map(|(&label, (x, y))| {
            let footprint = Rect {
                x_min: x,
                y_min: y,
                x_max: x + foot_w,
                y_max: y + foot_d,
            };
            let guard = footprint.expand(safety);
            let clearance = parts
                .iter()
                .map(|p| clearance(&guard, p))
                .reduce(js_min)
                .unwrap_or(f64::INFINITY);
            Ranked {
                label,
                x,
                y,
                clearance,
                footprint,
            }
        })
        .collect();
    let best = if bias == wire::WipeTowerBiasName::LargestClearance {
        ranked
            .iter()
            .reduce(|a, b| if b.clearance > a.clearance { b } else { a })
    } else {
        let order = bias_order(&bias);
        let rank = |label: &str| order.iter().position(|l| *l == label).unwrap_or(usize::MAX);
        let bucket = |c: f64| ((if c == f64::INFINITY { 1e9 } else { c }) / COMPARE_EPS_MM).trunc();
        let mut sorted: Vec<&Ranked> = ranked.iter().collect();
        sorted.sort_by(|a, b| {
            let (ba, bb) = (bucket(a.clearance), bucket(b.clearance));
            if ba != bb {
                return bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal);
            }
            rank(a.label).cmp(&rank(b.label))
        });
        sorted.first().copied()
    };
    let best = best.expect("eight candidates");
    let tower = plate.wipe_tower.as_deref();
    wire::WipeTowerReply::Plan(wire::WipeTowerPlan {
        pick: wire::WipeTowerPick {
            x_mm: best.x + margin,
            y_mm: best.y + margin,
            clearance_mm: if best.clearance.is_finite() {
                wire::OptionalFinite::Value(best.clearance)
            } else {
                wire::OptionalFinite::Absent(wire::Empty {})
            },
            label: best.label.encode_utf16().collect(),
            footprint: best.footprint.wire(),
        },
        wipe_tower: wire::WipeTowerInput {
            enabled: true,
            position_mm: vec![best.x + margin, best.y + margin],
            rotation_deg: tower.map_or(0.0, |t| t.rotation_deg.get()),
            filament_id: match tower.and_then(|t| t.filament_id.as_ref()) {
                Some(id) => wire::OptionalId::Value(id.as_utf16().to_vec()),
                None => wire::OptionalId::Absent(wire::Empty {}),
            },
        },
    })
}

/// The ghost's height on a plate with no model part above the bed (mm).
pub const GHOST_STAND_IN_MM: f64 = 30.0;
/// The smallest side the ghost's body is drawn with (mm).
pub const GHOST_MIN_WIDTH_MM: f64 = 1.0;

/// The wipe tower the workspace draws on a plate before slicing
/// (`wipeTowerGhost.ts`, through `wipeTowerGhostWire`): the plate's enabled
/// tower as a square body at `wipe_tower_x/y`, as wide as the footprint the
/// preflight checks ([`wipe_tower_footprint`](crate::slicing::preflight::wipe_tower_footprint))
/// and at least [`GHOST_MIN_WIDTH_MM`], rising to the top of the plate's
/// tallest model part (every instance's model parts as placed; an instance
/// whose bounds cannot be read gives none) or [`GHOST_STAND_IN_MM`], with the
/// margin the engine prints outside it. Nothing for a plate without an enabled
/// tower; refused for an unknown plate or a box that is not finite.
pub fn ghost(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::WipeTowerGhostRequest,
) -> wire::WipeTowerGhostReply {
    let refuse = |code, message: String| {
        wire::WipeTowerGhostReply::Refused(wire::WipeTowerGhostRefusal {
            code,
            message: message.encode_utf16().collect(),
        })
    };
    let Some(plate) = state
        .plates
        .iter()
        .find(|plate| plate.id.as_utf16() == request.plate_id.as_slice())
    else {
        return refuse(
            wire::WipeTowerGhostRefusalCode::UnknownPlate,
            format!("Unknown plate {}", text(&request.plate_id)),
        );
    };
    let Some(tower) = plate.wipe_tower.as_deref().filter(|tower| tower.enabled) else {
        return wire::WipeTowerGhostReply::None(wire::Empty {});
    };
    let (width, margin) = crate::slicing::preflight::wipe_tower_footprint(state, plate);
    let snapshot = assets.capture_internal();
    let mut top = f64::NEG_INFINITY;
    for object in plate.objects.iter() {
        for instance in object.instances.iter() {
            if let Ok(bounds) = bounds_with(
                state,
                &snapshot,
                &[instance.id.as_utf16().to_vec()],
                None,
                &[VolumeRole::Model],
            ) {
                top = js_max(top, bounds.max[2]);
            }
        }
    }
    // `!(top > 0)`: no part, or none above the bed.
    let stand_in = top.is_nan() || top <= 0.0;
    let [x, y] = tower.position_mm.map(|n| n.get());
    let ghost = wire::WipeTowerGhost {
        position_mm: vec![x, y],
        width_mm: js_max(GHOST_MIN_WIDTH_MM, width),
        height_mm: if stand_in { GHOST_STAND_IN_MM } else { top },
        stand_in,
        margin_mm: margin,
    };
    if ![x, y, ghost.width_mm, ghost.height_mm, ghost.margin_mm]
        .iter()
        .all(|value| value.is_finite())
    {
        return refuse(
            wire::WipeTowerGhostRefusalCode::NonFinite,
            "The wipe tower has no finite size to draw".to_owned(),
        );
    }
    wire::WipeTowerGhostReply::Ghost(ghost)
}
