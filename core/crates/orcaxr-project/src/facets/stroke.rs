//! Whole-facet strokes (`annotations/sparse.ts`): range normalization, the
//! sparse channel stroke and the refinement roots a stroke replaces, with the
//! browser's grouping, ordering and refusals.
use super::*;

/// `TriangleRange`: `[start, end_exclusive)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleRange {
    pub start: f64,
    pub end_exclusive: f64,
}
impl TriangleRange {
    fn contains(&self, triangle: f64) -> bool {
        triangle >= self.start && triangle < self.end_exclusive
    }
}
#[derive(Debug, Clone)]
pub enum StrokeOperation {
    Paint(Vec<TriangleRange>, PaintValue),
    Erase(Vec<TriangleRange>),
    Reset,
}

/// `normalizeTriangleRanges`: each invalid range is one issue; valid ranges are
/// sorted and touching or overlapping ones merged.
pub fn normalize_ranges(
    ranges: &[TriangleRange],
    triangle_count: f64,
) -> Result<Vec<TriangleRange>, usize> {
    let invalid = ranges
        .iter()
        .filter(|r| {
            r.start.fract() != 0.0
                || r.end_exclusive.fract() != 0.0
                || r.start < 0.0
                || r.end_exclusive <= r.start
                || r.end_exclusive > triangle_count
        })
        .count();
    if invalid > 0 {
        return Err(invalid);
    }
    let mut sorted = ranges.to_vec();
    // `left.start - right.start || left.endExclusive - right.endExclusive`, stable.
    sorted.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.end_exclusive
                    .partial_cmp(&b.end_exclusive)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let mut merged: Vec<TriangleRange> = Vec::new();
    for range in sorted {
        match merged.last_mut() {
            Some(previous) if range.start <= previous.end_exclusive => {
                previous.end_exclusive = previous.end_exclusive.max(range.end_exclusive);
            }
            _ => merged.push(range),
        }
    }
    Ok(merged)
}

/// `normalizeChannel`: one group per canonical value in canonical-text order,
/// triangles ascending, empty groups dropped. A repeated triangle is refused.
pub fn normalize_assignments(assignments: &[Assignment]) -> Result<Vec<Assignment>, Triangle> {
    let mut seen = std::collections::BTreeSet::new();
    let mut groups: Vec<(Vec<u16>, Assignment)> = Vec::new();
    for assignment in assignments {
        let key = assignment.value.canonical_key();
        let index = match groups.iter().position(|(k, _)| *k == key) {
            Some(index) => index,
            None => {
                groups.push((
                    key,
                    Assignment {
                        value: assignment.value.clone(),
                        triangles: Vec::new(),
                    },
                ));
                groups.len() - 1
            }
        };
        for triangle in &assignment.triangles {
            if !seen.insert(*triangle) {
                return Err(*triangle);
            }
            groups[index].1.triangles.push(*triangle);
        }
    }
    groups.retain(|(_, a)| !a.triangles.is_empty());
    groups.sort_by(|(a, _), (b, _)| a.cmp(b));
    Ok(groups
        .into_iter()
        .map(|(_, mut assignment)| {
            assignment.triangles.sort();
            assignment
        })
        .collect())
}

/// `applyFacetChannelStroke` on already normalized assignments.
pub fn apply_stroke(
    normalized: &[Assignment],
    ranges: &[TriangleRange],
    paint: Option<&PaintValue>,
) -> Result<Vec<Assignment>, Triangle> {
    if ranges.is_empty() {
        return Ok(normalized.to_vec());
    }
    let covered = |t: &Triangle| ranges.iter().any(|r| r.contains(t.0));
    let mut retained: Vec<Assignment> = normalized
        .iter()
        .map(|a| Assignment {
            value: a.value.clone(),
            triangles: a
                .triangles
                .iter()
                .filter(|t| !covered(t))
                .copied()
                .collect(),
        })
        .filter(|a| !a.triangles.is_empty())
        .collect();
    if let Some(value) = paint {
        let painted: Vec<Triangle> = ranges
            .iter()
            .flat_map(|r| (r.start as u64..r.end_exclusive as u64).map(|t| Triangle(t as f64)))
            .collect();
        let key = value.canonical_key();
        match retained.iter_mut().find(|a| a.value.canonical_key() == key) {
            Some(target) => target.triangles.extend(painted),
            None => retained.push(Assignment {
                value: value.clone(),
                triangles: painted,
            }),
        }
    }
    normalize_assignments(&retained)
}

impl Encoding {
    /// `replaceFacetRefinementRoots`: drop the subdivision of every covered
    /// facet; the rest are normalized, and any that collapse to one leaf are
    /// dropped, as `normalizeFacetRefinementEncoding` does.
    pub fn without_roots(&self, covered: impl Fn(Triangle) -> bool) -> Self {
        let mut splits: Vec<Split> = self
            .splits
            .iter()
            .filter(|s| !covered(s.triangle))
            .filter_map(|s| {
                let node = s.node.clone().normalize();
                matches!(node.kind, NodeKind::Split { .. }).then_some(Split {
                    triangle: s.triangle,
                    node,
                })
            })
            .collect();
        splits.sort_by_key(|s| s.triangle);
        Self {
            triangle_count: self.triangle_count,
            splits,
        }
    }
}
