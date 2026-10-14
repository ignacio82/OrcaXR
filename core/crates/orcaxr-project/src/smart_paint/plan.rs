//! Building commit intents for Smart Paint operator selections (P4.9).
use orcaxr_contracts::project_intent_types as wire;

use super::types::{SmartPaintProjection, SmartPaintRegionAssignment};

/// Channel identifier as lowercase string ("color", "support", "seam", "fuzzySkin").
pub fn parse_channel(name: &str) -> Option<wire::FacetChannelName> {
    match name {
        "color" => Some(wire::FacetChannelName::Color),
        "support" => Some(wire::FacetChannelName::Support),
        "seam" => Some(wire::FacetChannelName::Seam),
        "fuzzySkin" | "fuzzy_skin" => Some(wire::FacetChannelName::FuzzySkin),
        "brim" => Some(wire::FacetChannelName::Brim),
        _ => None,
    }
}

pub fn channel_label(channel: wire::FacetChannelName) -> &'static str {
    match channel {
        wire::FacetChannelName::Color => "color",
        wire::FacetChannelName::Support => "support",
        wire::FacetChannelName::Seam => "seam",
        wire::FacetChannelName::FuzzySkin => "fuzzy skin",
        wire::FacetChannelName::Brim => "brim",
    }
}

/// Build a batch transaction containing one FacetStroke command per assigned region.
pub fn build_smart_paint_batch(
    guard: wire::FacetGuard,
    channel_name: &str,
    projection: &SmartPaintProjection,
    assignments: &[SmartPaintRegionAssignment],
) -> Result<wire::Batch, &'static str> {
    let channel = parse_channel(channel_name).ok_or("invalid_channel")?;
    if channel == wire::FacetChannelName::Brim {
        return Err("unsupported_channel");
    }

    let mut commands = Vec::new();

    for assignment in assignments {
        let value_str = match &assignment.value {
            Some(v) if !v.trim().is_empty() => v.trim(),
            _ => continue, // unassigned or unpainted regions are not committed
        };

        let region = match projection.regions.iter().find(|r| r.id == assignment.region_id) {
            Some(r) => r,
            None => continue,
        };

        let excluded: std::collections::HashSet<u32> =
            assignment.excluded_triangles.iter().copied().collect();

        let active_triangles: Vec<u32> = region
            .triangle_indices
            .iter()
            .copied()
            .filter(|t| !excluded.contains(t))
            .collect();

        if active_triangles.is_empty() {
            continue;
        }

        let ranges = crate::facets::region::ranges(&active_triangles);
        let ranges_wire: wire::TriangleRanges = ranges
            .iter()
            .map(|&(start, end)| wire::TriangleRangeInput {
                start: start as u64,
                end_exclusive: end as u64,
            })
            .collect();

        let operation = match channel {
            wire::FacetChannelName::Color => {
                if value_str == "unpainted" {
                    wire::FacetStrokeOperationInput::Erase(wire::FacetEraseStroke { ranges: ranges_wire })
                } else {
                    wire::FacetStrokeOperationInput::Paint(wire::FacetPaintStroke {
                        ranges: ranges_wire,
                        value: wire::PaintValueInput::Text(value_str.encode_utf16().collect()),
                    })
                }
            }
            wire::FacetChannelName::Support => {
                let flag = match value_str {
                    "enforce" | "true" => true,
                    "block" | "false" => false,
                    _ => true,
                };
                wire::FacetStrokeOperationInput::Paint(wire::FacetPaintStroke {
                    ranges: ranges_wire,
                    value: wire::PaintValueInput::Flag(flag),
                })
            }
            wire::FacetChannelName::Seam => {
                let flag = match value_str {
                    "prefer" | "true" => true,
                    "avoid" | "false" => false,
                    _ => true,
                };
                wire::FacetStrokeOperationInput::Paint(wire::FacetPaintStroke {
                    ranges: ranges_wire,
                    value: wire::PaintValueInput::Flag(flag),
                })
            }
            wire::FacetChannelName::FuzzySkin => {
                wire::FacetStrokeOperationInput::Paint(wire::FacetPaintStroke {
                    ranges: ranges_wire,
                    value: wire::PaintValueInput::Flag(true),
                })
            }
            wire::FacetChannelName::Brim => return Err("unsupported_channel"),
        };

        let stroke_label: Vec<u16> = format!(
            "Smart Paint {} ({})",
            channel_label(channel),
            region.label
        )
        .encode_utf16()
        .collect();

        commands.push(wire::Command::FacetStroke(wire::FacetStroke {
            guard: guard.clone(),
            channel,
            operation,
            label: wire::OptionalText::Value(stroke_label),
        }));
    }

    if commands.is_empty() {
        return Err("no_active_regions");
    }

    let batch_label: Vec<u16> = format!("Smart Paint {} facets", channel_label(channel))
        .encode_utf16()
        .collect();

    Ok(wire::Batch {
        version: 1,
        label: batch_label,
        commands,
    })
}
