//! Plate arrangement and bed fill (`arrange.ts`, through `arrangeExchange.ts`):
//! the deterministic shelf packer over canonical bounds behind "Arrange", and
//! the row-major free-slot fill behind "Fill bed with instances". Neither
//! rotates anything; an arrangement moves only instances whose placement
//! changes and reports those that do not fit, and a fill never moves an
//! existing instance. Each refusal carries the browser's code and message.
use super::{Pose, Refusal, bounds_with, text};
use crate::assets::AssetRepository;
use crate::model::{ProjectState, Transform, VolumeRole};
use orcaxr_contracts::project_intent_types as wire;

pub const DEFAULT_SPACING_MM: f64 = 6.0;
pub const DEFAULT_BED_MARGIN_MM: f64 = 2.0;
pub const DEFAULT_FILL_LIMIT: f64 = 64.0;
/// Footprints below this size are degenerate and left in place.
const MIN_FOOTPRINT_MM: f64 = 1e-6;
const PRINTABLE_ROLES: [VolumeRole; 3] = [
    VolumeRole::Model,
    VolumeRole::SupportEnforcer,
    VolumeRole::SupportBlocker,
];

type Code = wire::ArrangeRefusalCode;

/// `!(extent > MIN_FOOTPRINT_MM)`: too small, or not a number.
fn degenerate(extent: f64) -> bool {
    extent.is_nan() || extent <= MIN_FOOTPRINT_MM
}

fn refuse(code: Code, message: impl Into<String>) -> wire::ArrangeRefusal {
    wire::ArrangeRefusal {
        code,
        message: message.into().encode_utf16().collect(),
    }
}

/// A placement refusal from bounds, in the arrangement's codes.
fn bounds_refusal(refusal: Refusal) -> wire::ArrangeRefusal {
    use wire::PlacementRefusalCode as P;
    let code = match refusal.code {
        P::MissingAsset => Code::MissingAsset,
        P::AssetMetadata => Code::AssetMetadata,
        P::NonFiniteVertex => Code::NonFiniteVertex,
        P::InvalidRotation => Code::InvalidRotation,
        P::UnknownInstance => Code::UnknownInstance,
        _ => Code::NoGeometry,
    };
    refuse(code, refusal.message)
}

/// An axis-aligned rectangle in plate millimetres.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Region {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}
impl Region {
    fn wire(&self) -> wire::ArrangeRegion {
        wire::ArrangeRegion {
            min_x: self.min_x,
            min_y: self.min_y,
            max_x: self.max_x,
            max_y: self.max_y,
        }
    }
    fn inflate(&self, amount: f64) -> Self {
        Self {
            min_x: self.min_x - amount,
            min_y: self.min_y - amount,
            max_x: self.max_x + amount,
            max_y: self.max_y + amount,
        }
    }
    fn overlaps(&self, other: &Self) -> bool {
        self.min_x < other.max_x - MIN_FOOTPRINT_MM
            && other.min_x < self.max_x - MIN_FOOTPRINT_MM
            && self.min_y < other.max_y - MIN_FOOTPRINT_MM
            && other.min_y < self.max_y - MIN_FOOTPRINT_MM
    }
}

struct Constraints {
    bed: [f64; 2],
    spacing: f64,
    margin: f64,
    exclusions: Vec<Region>,
    locked: Vec<Vec<u16>>,
    roles: Vec<VolumeRole>,
}

/// The shared checks, with the operation's own messages.
fn constraints(
    wire: &wire::ArrangeConstraintsInput,
    operation: &str,
    check_exclusions: bool,
) -> Result<Constraints, wire::ArrangeRefusal> {
    let [bed_x, bed_y] = [wire.bed_size_mm[0], wire.bed_size_mm[1]];
    if !bed_x.is_finite() || !bed_y.is_finite() || bed_x <= 0.0 || bed_y <= 0.0 {
        return Err(refuse(
            Code::InvalidBed,
            format!("{operation} needs a positive printable area"),
        ));
    }
    let optional = |value: &wire::OptionalFinite, default: f64| match value {
        wire::OptionalFinite::Value(v) => *v,
        wire::OptionalFinite::Absent(_) => default,
    };
    let spacing = optional(&wire.spacing_mm, DEFAULT_SPACING_MM);
    let margin = optional(&wire.bed_margin_mm, DEFAULT_BED_MARGIN_MM);
    if !spacing.is_finite() || spacing < 0.0 || !margin.is_finite() || margin < 0.0 {
        return Err(refuse(
            Code::InvalidSpacing,
            format!("{operation} spacing and margin must be non-negative"),
        ));
    }
    let exclusions: Vec<Region> = wire
        .exclusions
        .iter()
        .map(|r| Region {
            min_x: r.min_x,
            min_y: r.min_y,
            max_x: r.max_x,
            max_y: r.max_y,
        })
        .collect();
    if check_exclusions
        && exclusions.iter().any(|r| {
            ![r.min_x, r.min_y, r.max_x, r.max_y]
                .iter()
                .all(|v| v.is_finite())
                || r.max_x < r.min_x
                || r.max_y < r.min_y
        })
    {
        return Err(refuse(
            Code::InvalidExclusion,
            "An arrangement exclusion is not a valid rectangle",
        ));
    }
    let roles = match &wire.volume_roles {
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
    Ok(Constraints {
        bed: [bed_x, bed_y],
        spacing,
        margin,
        exclusions,
        locked: wire.locked_instance_ids.clone(),
        roles,
    })
}

fn footprint(bounds: &crate::mesh::Bounds) -> Region {
    Region {
        min_x: bounds.min[0],
        min_y: bounds.min[1],
        max_x: bounds.max[0],
        max_y: bounds.max[1],
    }
}

fn transform_wire(pose: &Pose) -> wire::Transform {
    wire::Transform {
        translation_mm: pose.translation.to_vec(),
        rotation: pose.rotation.to_vec(),
        scale: pose.scale.to_vec(),
    }
}

struct Candidate {
    id: Vec<u16>,
    width: f64,
    depth: f64,
    pose: Pose,
    origin: Region,
}

struct Placement {
    id: Vec<u16>,
    pose: Pose,
    footprint: Region,
}

/// `planPlateArrangement`.
pub fn arrange(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::ArrangeRequest,
) -> wire::ArrangeReply {
    match plan_arrangement(state, assets, request) {
        Ok(arrangement) => wire::ArrangeReply::Arrangement(arrangement),
        Err(refusal) => wire::ArrangeReply::Refused(refusal),
    }
}

fn plan_arrangement(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::ArrangeRequest,
) -> Result<wire::Arrangement, wire::ArrangeRefusal> {
    let plate = state
        .plates
        .iter()
        .find(|plate| plate.id.as_utf16() == request.plate_id.as_slice())
        .ok_or_else(|| {
            refuse(
                Code::UnknownPlate,
                format!("Unknown plate {}", text(&request.plate_id)),
            )
        })?;
    let c = constraints(&request.constraints, "Arrangement", true)?;
    let assets = assets.capture_internal();
    let half = c.spacing / 2.0;
    let mut candidates = Vec::new();
    let mut reserved: Vec<Region> = c.exclusions.clone();
    let mut locked_ids: Vec<Vec<u16>> = Vec::new();
    for object in plate.objects.iter() {
        for instance in object.instances.iter() {
            let id = instance.id.as_utf16().to_vec();
            // A volume with no printable role or unreadable asset is not arrangeable.
            let Ok(bounds) = bounds_with(state, &assets, std::slice::from_ref(&id), None, &c.roles)
            else {
                continue;
            };
            let width = bounds.max[0] - bounds.min[0];
            let depth = bounds.max[1] - bounds.min[1];
            if degenerate(width) || degenerate(depth) {
                continue;
            }
            let origin = footprint(&bounds);
            if c.locked.contains(&id) || !instance.printable {
                locked_ids.push(id);
                reserved.push(origin.inflate(half));
                continue;
            }
            candidates.push(Candidate {
                id,
                width,
                depth,
                pose: Pose::of(&instance.transform),
                origin,
            });
        }
    }
    // Deterministic order: largest depth, then width, then stable ID.
    candidates.sort_by(|left, right| {
        let by = |difference: f64| {
            if difference > 0.0 {
                Some(std::cmp::Ordering::Greater)
            } else if difference < 0.0 {
                Some(std::cmp::Ordering::Less)
            } else {
                None
            }
        };
        by(right.depth - left.depth)
            .or_else(|| by(right.width - left.width))
            .unwrap_or_else(|| left.id.cmp(&right.id))
    });

    let usable = Region {
        min_x: c.margin,
        min_y: c.margin,
        max_x: c.bed[0] - c.margin,
        max_y: c.bed[1] - c.margin,
    };
    let mut placements: Vec<Placement> = Vec::new();
    let mut unplaced: Vec<Vec<u16>> = Vec::new();
    let mut shelf_min_y = usable.min_y;
    let mut shelf_depth = 0.0f64;
    let mut cursor_x = usable.min_x;
    for candidate in candidates {
        let mut placed: Option<Region> = None;
        // Walk shelves left to right, opening a new one when the row is full.
        for _ in 0..2 {
            if placed.is_some() {
                break;
            }
            if cursor_x + candidate.width > usable.max_x + MIN_FOOTPRINT_MM {
                shelf_min_y += if shelf_depth > 0.0 {
                    shelf_depth + c.spacing
                } else {
                    0.0
                };
                shelf_depth = 0.0;
                cursor_x = usable.min_x;
            }
            if cursor_x + candidate.width <= usable.max_x + MIN_FOOTPRINT_MM
                && shelf_min_y + candidate.depth <= usable.max_y + MIN_FOOTPRINT_MM
            {
                let mut slot = Region {
                    min_x: cursor_x,
                    min_y: shelf_min_y,
                    max_x: cursor_x + candidate.width,
                    max_y: shelf_min_y + candidate.depth,
                };
                // Slide right past reserved regions inside this shelf.
                let mut guard = 0;
                while guard < 256 {
                    let Some(blocker) = reserved.iter().find(|r| r.overlaps(&slot.inflate(half)))
                    else {
                        break;
                    };
                    let next_x = blocker.max_x + half;
                    slot = Region {
                        min_x: next_x,
                        max_x: next_x + candidate.width,
                        ..slot
                    };
                    if slot.max_x > usable.max_x + MIN_FOOTPRINT_MM {
                        break;
                    }
                    guard += 1;
                }
                if slot.max_x <= usable.max_x + MIN_FOOTPRINT_MM
                    && !reserved.iter().any(|r| r.overlaps(&slot.inflate(half)))
                {
                    placed = Some(slot);
                    cursor_x = slot.max_x + c.spacing;
                    shelf_depth = shelf_depth.max(candidate.depth);
                } else {
                    // Force a new shelf on the next attempt.
                    cursor_x = usable.max_x + 1.0;
                }
            } else if shelf_min_y + candidate.depth > usable.max_y + MIN_FOOTPRINT_MM {
                break;
            }
        }
        let Some(placed) = placed else {
            unplaced.push(candidate.id);
            continue;
        };
        reserved.push(placed.inflate(half));
        let delta_x = placed.min_x - candidate.origin.min_x;
        let delta_y = placed.min_y - candidate.origin.min_y;
        if delta_x.abs() < MIN_FOOTPRINT_MM && delta_y.abs() < MIN_FOOTPRINT_MM {
            continue;
        }
        let pose = candidate.pose;
        placements.push(Placement {
            id: candidate.id,
            pose: Pose {
                translation: [
                    pose.translation[0] + delta_x,
                    pose.translation[1] + delta_y,
                    pose.translation[2],
                ],
                ..pose
            },
            footprint: placed,
        });
    }
    // Centre the packed block when nothing else reserves space.
    let placements = if reserved.is_empty() || c.exclusions.len() + locked_ids.len() == 0 {
        centre(placements, &usable)
    } else {
        placements
    };
    Ok(wire::Arrangement {
        placements: placements
            .iter()
            .map(|p| wire::ArrangePlacement {
                instance_id: p.id.clone(),
                transform: transform_wire(&p.pose),
                footprint: p.footprint.wire(),
            })
            .collect(),
        unplaced_instance_ids: unplaced,
        locked_instance_ids: locked_ids,
    })
}

/// `centrePlacements`.
fn centre(placements: Vec<Placement>, usable: &Region) -> Vec<Placement> {
    let Some(first) = placements.first() else {
        return placements;
    };
    let block = placements.iter().fold(first.footprint, |b, p| Region {
        min_x: b.min_x.min(p.footprint.min_x),
        min_y: b.min_y.min(p.footprint.min_y),
        max_x: b.max_x.max(p.footprint.max_x),
        max_y: b.max_y.max(p.footprint.max_y),
    });
    let shift_x = (usable.min_x + usable.max_x) / 2.0 - (block.min_x + block.max_x) / 2.0;
    let shift_y = (usable.min_y + usable.max_y) / 2.0 - (block.min_y + block.max_y) / 2.0;
    if shift_x.abs() < MIN_FOOTPRINT_MM && shift_y.abs() < MIN_FOOTPRINT_MM {
        return placements;
    }
    if block.min_x + shift_x < usable.min_x - MIN_FOOTPRINT_MM
        || block.max_x + shift_x > usable.max_x + MIN_FOOTPRINT_MM
        || block.min_y + shift_y < usable.min_y - MIN_FOOTPRINT_MM
        || block.max_y + shift_y > usable.max_y + MIN_FOOTPRINT_MM
    {
        return placements;
    }
    placements
        .into_iter()
        .map(|p| Placement {
            pose: Pose {
                translation: [
                    p.pose.translation[0] + shift_x,
                    p.pose.translation[1] + shift_y,
                    p.pose.translation[2],
                ],
                ..p.pose
            },
            footprint: Region {
                min_x: p.footprint.min_x + shift_x,
                min_y: p.footprint.min_y + shift_y,
                max_x: p.footprint.max_x + shift_x,
                max_y: p.footprint.max_y + shift_y,
            },
            id: p.id,
        })
        .collect()
}

/// `planBedFill`.
pub fn fill(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::BedFillRequest,
) -> wire::BedFillReply {
    match plan_fill(state, assets, request) {
        Ok(fill) => wire::BedFillReply::Fill(fill),
        Err(refusal) => wire::BedFillReply::Refused(refusal),
    }
}

fn plan_fill(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::BedFillRequest,
) -> Result<wire::BedFill, wire::ArrangeRefusal> {
    let plate = state
        .plates
        .iter()
        .find(|plate| plate.id.as_utf16() == request.plate_id.as_slice())
        .ok_or_else(|| {
            refuse(
                Code::UnknownPlate,
                format!("Unknown plate {}", text(&request.plate_id)),
            )
        })?;
    let c = constraints(&request.constraints, "Bed fill", false)?;
    let limit = match request.max_new_instances {
        wire::OptionalFinite::Value(v) => v,
        wire::OptionalFinite::Absent(_) => DEFAULT_FILL_LIMIT,
    };
    if limit.fract() != 0.0 || limit < 1.0 {
        return Err(refuse(
            Code::InvalidLimit,
            "The bed-fill limit must be a positive integer",
        ));
    }
    let source: Option<&Transform> = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.instances.iter())
        .find(|instance| instance.id.as_utf16() == request.instance_id.as_slice())
        .map(|instance| &instance.transform);
    let Some(source) = source else {
        return Err(refuse(
            Code::UnknownInstance,
            format!("Unknown instance {}", text(&request.instance_id)),
        ));
    };
    let source = Pose::of(source);
    let assets = assets.capture_internal();
    let source_bounds = bounds_with(
        state,
        &assets,
        std::slice::from_ref(&request.instance_id),
        None,
        &c.roles,
    )
    .map_err(bounds_refusal)?;
    let width = source_bounds.max[0] - source_bounds.min[0];
    let depth = source_bounds.max[1] - source_bounds.min[1];
    if degenerate(width) || degenerate(depth) {
        return Ok(wire::BedFill {
            placements: Vec::new(),
            withheld_slot_count: 0,
        });
    }
    let half = c.spacing / 2.0;
    let mut reserved: Vec<Region> = c.exclusions.clone();
    for object in plate.objects.iter() {
        for instance in object.instances.iter() {
            // An unreadable instance reserves nothing; the caller already blocks slicing.
            if let Ok(bounds) = bounds_with(
                state,
                &assets,
                &[instance.id.as_utf16().to_vec()],
                None,
                &c.roles,
            ) {
                reserved.push(footprint(&bounds).inflate(half));
            }
        }
    }
    let usable = Region {
        min_x: c.margin,
        min_y: c.margin,
        max_x: c.bed[0] - c.margin,
        max_y: c.bed[1] - c.margin,
    };
    let mut placements = Vec::new();
    let mut withheld = 0u64;
    let mut y = usable.min_y;
    while y + depth <= usable.max_y + MIN_FOOTPRINT_MM {
        let mut x = usable.min_x;
        while x + width <= usable.max_x + MIN_FOOTPRINT_MM {
            let slot = Region {
                min_x: x,
                min_y: y,
                max_x: x + width,
                max_y: y + depth,
            };
            x += width + c.spacing;
            if reserved.iter().any(|r| r.overlaps(&slot.inflate(half))) {
                continue;
            }
            if placements.len() as f64 >= limit {
                withheld += 1;
                continue;
            }
            reserved.push(slot.inflate(half));
            placements.push(wire::BedFillPlacement {
                transform: transform_wire(&Pose {
                    translation: [
                        source.translation[0] + (slot.min_x - source_bounds.min[0]),
                        source.translation[1] + (slot.min_y - source_bounds.min[1]),
                        source.translation[2],
                    ],
                    ..source
                }),
                footprint: slot.wire(),
            });
        }
        y += depth + c.spacing;
    }
    Ok(wire::BedFill {
        placements,
        withheld_slot_count: withheld,
    })
}
