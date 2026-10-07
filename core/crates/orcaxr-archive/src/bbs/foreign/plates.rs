//! BBS plate membership and plate-local origins (`extractBbsPlateLayoutResult`
//! and `importedPlateCoordinates`). Membership comes from
//! `(object_id, instance_id)` metadata against the parsed build list, never from
//! geometry; origins come from the pinned engine's virtual plate grid.
use super::Failure;
use super::assemble::PlateCoordinates;
use super::metadata::{self, Config, ModelSettings, NumKey, PlateMeta, utf16};
use std::collections::{BTreeMap, BTreeSet};

struct Layout {
    plates: Vec<LayoutPlate>,
    unassigned: Vec<usize>,
}
struct LayoutPlate {
    source_id: f64,
    items: Vec<usize>,
    origin: Option<(f64, f64)>,
}

/// Stable numeric sort by `sourceId`, as `Array.prototype.sort` does for the
/// valid inputs that survive the following contiguity check.
fn ordered(plates: &[PlateMeta]) -> Vec<&PlateMeta> {
    let mut ordered: Vec<&PlateMeta> = plates.iter().collect();
    ordered.sort_by(|a, b| {
        a.source_id
            .partial_cmp(&b.source_id)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ordered
}
fn contiguous(plates: &[&PlateMeta]) -> bool {
    plates
        .iter()
        .enumerate()
        .all(|(i, p)| p.source_id_valid && p.source_id == (i + 1) as f64)
}

/// `extractBbsPlateLayoutUnchecked` over the parsed build list; `None` is the
/// browser's invalid/contradictory result.
fn layout(
    settings: &ModelSettings,
    build_object_ids: &[u64],
    printable_area: Option<(f64, f64)>,
) -> Option<Layout> {
    if settings.plates.is_empty() {
        return None;
    }
    let ordered = ordered(&settings.plates);
    if !contiguous(&ordered) {
        return None;
    }
    let mut assignment: BTreeMap<(NumKey, NumKey), usize> = BTreeMap::new();
    let mut conflicting: BTreeSet<(NumKey, NumKey)> = BTreeSet::new();
    let mut plates_by_object: BTreeMap<NumKey, BTreeSet<usize>> = BTreeMap::new();
    for (plate_index, plate) in ordered.iter().enumerate() {
        for &(object, instance) in &plate.assignments {
            let key = (object, instance);
            match assignment.get(&key) {
                None if !conflicting.contains(&key) => {
                    assignment.insert(key, plate_index);
                }
                Some(&previous) if previous != plate_index => {
                    assignment.remove(&key);
                    conflicting.insert(key);
                }
                _ => {}
            }
            plates_by_object
                .entry(object)
                .or_default()
                .insert(plate_index);
        }
    }
    let mut plates: Vec<LayoutPlate> = ordered
        .iter()
        .map(|p| LayoutPlate {
            source_id: p.source_id,
            items: Vec::new(),
            origin: None,
        })
        .collect();
    let mut occurrences: BTreeMap<u64, f64> = BTreeMap::new();
    let mut unassigned = Vec::new();
    for (build_index, &object_id) in build_object_ids.iter().enumerate() {
        let instance = occurrences.entry(object_id).or_insert(0.0);
        let key = (NumKey::new(object_id as f64), NumKey::new(*instance));
        *instance += 1.0;
        // Producers that omit or renumber instance_id but keep every
        // occurrence of an object on one plate get that object-level fallback.
        let plate = assignment.get(&key).copied().or_else(|| {
            plates_by_object
                .get(&key.0)
                .filter(|candidates| candidates.len() == 1)
                .and_then(|candidates| candidates.iter().next().copied())
        });
        match plate.filter(|p| *p < plates.len()) {
            Some(p) => plates[p].items.push(build_index),
            None => unassigned.push(build_index),
        }
    }
    if let Some(bed) = printable_area {
        for (plate, origin) in plates
            .iter_mut()
            .zip(metadata::virtual_plate_origins(ordered.len(), bed))
        {
            plate.origin = Some(origin);
        }
    } else if plates.len() == 1 {
        plates[0].origin = Some((0.0, 0.0));
    }
    Some(Layout { plates, unassigned })
}

/// `importedPlateCoordinates`. `settings_xml` is the decoded member text, used
/// only to count declared `<plate` tags exactly as the browser does.
pub fn coordinates(
    settings_xml: Option<&str>,
    settings: &ModelSettings,
    build_object_ids: &[u64],
    printable_area: Option<(f64, f64)>,
) -> Result<PlateCoordinates, Failure> {
    // extractBbsPlateLayoutResult: absent without member or declared plates;
    // otherwise valid only when every declared plate parsed.
    let extraction = match settings_xml {
        None => Ok(None),
        Some(xml) => {
            let declared = metadata::count_tags(xml, "plate");
            if declared == 0 {
                Ok(None)
            } else {
                match layout(settings, build_object_ids, printable_area) {
                    Some(l) if l.plates.len() == declared => Ok(Some(l)),
                    _ => Err(()),
                }
            }
        }
    };
    let Ok(extraction) = extraction else {
        return Err(Failure::PlateMetadata);
    };
    let items = build_object_ids.len();
    if settings.plates.is_empty() {
        return Ok(PlateCoordinates {
            definitions: vec![PlateMeta {
                source_id: 1.0,
                source_id_valid: true,
                name: utf16("Plate 1"),
                printable: true,
                config: Config::new(),
                assignments: Vec::new(),
            }],
            plate_by_build_item: vec![0; items],
            origins: vec![(0.0, 0.0)],
            normalized_build_items: 0,
        });
    }
    let definitions: Vec<PlateMeta> = ordered(&settings.plates).into_iter().cloned().collect();
    if !contiguous(&definitions.iter().collect::<Vec<_>>()) {
        return Err(Failure::PlateMetadata);
    }
    let Some(layout) = extraction else {
        return Err(Failure::PlateMetadata);
    };
    if layout.plates.len() != definitions.len()
        || layout
            .plates
            .iter()
            .zip(&definitions)
            .any(|(l, d)| l.source_id != d.source_id)
    {
        return Err(Failure::PlateMetadata);
    }
    let mut plate_by_build_item = vec![usize::MAX; items];
    for (plate_index, plate) in layout.plates.iter().enumerate() {
        for &item in &plate.items {
            if item >= items || plate_by_build_item[item] != usize::MAX {
                return Err(Failure::PlateMetadata);
            }
            plate_by_build_item[item] = plate_index;
        }
    }
    if definitions.len() == 1 {
        plate_by_build_item.iter_mut().for_each(|p| *p = 0);
    } else if plate_by_build_item.contains(&usize::MAX) || !layout.unassigned.is_empty() {
        return Err(Failure::UnassignedBuildItem);
    }
    let mut origins = Vec::with_capacity(layout.plates.len());
    for (index, plate) in layout.plates.iter().enumerate() {
        origins.push(match plate.origin {
            Some(origin) => origin,
            None if index == 0 || plate.items.is_empty() => (0.0, 0.0),
            None => return Err(Failure::MissingPrintableArea),
        });
    }
    let normalized_build_items = layout
        .plates
        .iter()
        .zip(&origins)
        .filter(|(_, o)| o.0 != 0.0 || o.1 != 0.0)
        .map(|(p, _)| p.items.len())
        .sum();
    Ok(PlateCoordinates {
        definitions,
        plate_by_build_item,
        origins,
        normalized_build_items,
    })
}
