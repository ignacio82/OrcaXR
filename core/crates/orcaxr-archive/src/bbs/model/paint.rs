use super::*;
#[derive(Clone, Copy)]
pub(super) enum Root<'a> {
    Leaf(u8),
    Tree(&'a Value),
}
#[derive(Clone, Copy)]
pub(super) struct Entry<'a> {
    pub triangle: u64,
    pub channel: usize,
    pub root: Root<'a>,
}
pub(super) struct Paint<'a> {
    pub entries: Vec<Entry<'a>>,
}
pub(super) const NAMES: [&[u16]; 4] = [
    &[112, 97, 105, 110, 116, 95, 99, 111, 108, 111, 114],
    &[
        112, 97, 105, 110, 116, 95, 102, 117, 122, 122, 121, 95, 115, 107, 105, 110,
    ],
    &[112, 97, 105, 110, 116, 95, 115, 101, 97, 109],
    &[
        112, 97, 105, 110, 116, 95, 115, 117, 112, 112, 111, 114, 116, 115,
    ],
];
pub(super) fn state(
    channel: usize,
    value: facets::Paint<'_>,
    slots: &BTreeMap<&[u16], usize>,
) -> Option<u8> {
    match (channel, value) {
        (0, facets::Paint::Text(v)) => slots.get(v).copied().filter(|n| *n <= 64).map(|n| n as u8),
        (1, facets::Paint::Bool(true)) => Some(1),
        (2, facets::Paint::Text(v)) if eq(v, "prefer") => Some(1),
        (2, facets::Paint::Text(v)) if eq(v, "avoid") => Some(2),
        (3, facets::Paint::Text(v)) if eq(v, "enforce") => Some(1),
        (3, facets::Paint::Text(v)) if eq(v, "block") => Some(2),
        _ => None,
    }
}
fn value(v: &Value) -> Result<facets::Paint<'_>, Error> {
    match v {
        Value::String(v) => Ok(facets::Paint::Text(v)),
        Value::Bool(v) => Ok(facets::Paint::Bool(*v)),
        _ => Err(Error::Attribute),
    }
}
impl<'a> Paint<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        annotations: &'a FacetAnnotations,
        slots: &BTreeMap<&[u16], usize>,
        object: usize,
        volume: usize,
        flags: &mut [bool; 3],
        warnings: &mut Vec<Warning>,
        budget: &mut Budget,
        cancelled: &mut impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        let refinement = annotations.refinement.as_ref().map(JsonObject::value);
        let mut entries = Vec::new();
        let mut unavailable = false;
        let channels = [
            ("color", annotations.color.value()),
            ("fuzzySkin", annotations.fuzzy_skin.value()),
            ("seam", annotations.seam.value()),
            ("support", annotations.support.value()),
        ];
        for (channel, (name, assignments)) in channels.into_iter().enumerate() {
            let encoding = refinement.and_then(|v| field(v, name));
            let assignments = array(Some(assignments))?;
            if let Some(flag) = match channel {
                0 => Some(2),
                2 => Some(1),
                3 => Some(0),
                _ => None,
            } {
                flags[flag] |= !assignments.is_empty() || encoding.is_some();
            }
            for assignment in assignments {
                check(cancelled)?;
                budget.record()?;
                let assigned = value(field(assignment, "value").ok_or(Error::Attribute)?)?;
                if let facets::Paint::Text(v) = assigned {
                    budget.text(v)?;
                }
                let mapped = state(channel, assigned, slots);
                if channel == 0 && mapped.is_none() {
                    unavailable = true;
                }
                for triangle in array(field(assignment, "triangles"))? {
                    check(cancelled)?;
                    budget.entry()?;
                    // Admission guarantees unique, in-range indices and disjoint
                    // whole/refined roots. Assignment arrays can be unsorted;
                    // the final sparse index establishes source-facet order.
                    if let (Some(mapped), Value::Number(triangle)) = (mapped, triangle) {
                        entries.push(Entry {
                            triangle: *triangle as u64,
                            channel,
                            root: Root::Leaf(mapped),
                        });
                    }
                }
            }
            for split in array(encoding.and_then(|v| field(v, "splits")))? {
                check(cancelled)?;
                budget.entry()?;
                let Some(Value::Number(triangle)) = field(split, "triangle") else {
                    return Err(Error::Attribute);
                };
                let root = field(split, "node").ok_or(Error::Attribute)?;
                let mut supported = true;
                let mut text_error = None;
                let nodes = facets::visit_assigned(
                    facets::Tree::Persisted(root),
                    budget.remaining.paint_nodes,
                    |v| {
                        if text_error.is_some() {
                            return;
                        }
                        if let facets::Paint::Text(units) = v
                            && let Err(e) = budget.text(units)
                        {
                            text_error = Some(e);
                            return;
                        }
                        supported &= state(channel, v, slots).is_some();
                    },
                    &mut *cancelled,
                )?;
                if let Some(e) = text_error {
                    return Err(e);
                }
                Budget::charge(&mut budget.remaining.paint_nodes, nodes)?;
                if supported {
                    entries.push(Entry {
                        triangle: *triangle as u64,
                        channel,
                        root: Root::Tree(root),
                    });
                } else if channel == 0 {
                    warnings.push(Warning::RefinedColor {
                        object,
                        volume,
                        triangle: *triangle as u64,
                    });
                }
            }
        }
        if unavailable {
            warnings.push(Warning::UnavailableColor { object, volume });
        }
        if !array(Some(annotations.brim.value()))?.is_empty()
            || refinement.and_then(|v| field(v, "brim")).is_some()
        {
            warnings.push(Warning::Brim { object, volume });
        }
        entries.sort_unstable_by_key(|e| (e.triangle, e.channel));
        Ok(Self { entries })
    }
}
