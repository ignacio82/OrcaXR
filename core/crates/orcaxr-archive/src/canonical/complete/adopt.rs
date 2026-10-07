use super::*;
pub(super) fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}
pub(super) fn imported_id<K>(
    base: &str,
    occupied: &mut BTreeSet<Vec<u16>>,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<EntityId<K>, Failure> {
    let mut suffix = 0usize;
    loop {
        check_cancel(c)?;
        budget.record()?;
        let value = if suffix == 0 {
            base.to_owned()
        } else {
            format!("{base}-{suffix}")
        };
        budget.text(value.len())?;
        let units = value.encode_utf16().collect::<Vec<_>>();
        if occupied.insert(units.clone()) {
            return EntityId::try_from_utf16(units).map_err(|_| Failure::Bundle);
        }
        suffix = suffix.checked_add(1).ok_or(Failure::ResourceLimit)?;
    }
}
pub(super) fn collect_ids(
    state: &ProjectState,
    b: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<BTreeSet<Vec<u16>>, Failure> {
    let mut ids = BTreeSet::new();
    let mut add = |v: &[u16]| -> Result<(), Failure> {
        check_cancel(c)?;
        b.record()?;
        b.text(v.len())?;
        ids.insert(v.to_vec());
        Ok(())
    };
    add(state.id.as_utf16())?;
    for a in state.source_assets.iter() {
        add(a.id.as_utf16())?;
    }
    for a in state.filaments.physical.iter() {
        add(a.id.as_utf16())?;
    }
    for a in state.filaments.mixed.iter() {
        add(a.id.as_utf16())?;
    }
    for a in state.custom_gcode.iter() {
        add(a.id.as_utf16())?;
    }
    for a in state.thumbnails.iter() {
        add(a.id.as_utf16())?;
    }
    for a in state.extension_blobs.iter() {
        add(a.id.as_utf16())?;
    }
    for p in state.plates.iter() {
        add(p.id.as_utf16())?;
        for o in p.objects.iter() {
            add(o.id.as_utf16())?;
            for v in o.volumes.iter() {
                add(v.id.as_utf16())?;
            }
            for i in o.instances.iter() {
                add(i.id.as_utf16())?;
            }
            for r in o.layer_ranges.iter() {
                add(r.id.as_utf16())?;
            }
        }
    }
    Ok(ids)
}
pub(super) fn thumbnail(
    path: &str,
    bytes: &[u8],
    state: &ProjectState,
    b: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<Option<(orcaxr_project::ids::PlateId, u32, u32)>, Failure> {
    let lower = path.to_ascii_lowercase();
    let Some(digits) = lower
        .strip_prefix("metadata/plate_")
        .and_then(|p| p.strip_suffix(".png"))
    else {
        return Ok(None);
    };
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || bytes.len() < 24
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Ok(None);
    }
    let order = digits.parse::<f64>().unwrap_or(f64::INFINITY) - 1.0;
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if !(1..=100_000).contains(&width) || !(1..=100_000).contains(&height) {
        return Ok(None);
    }
    for p in state.plates.iter() {
        check_cancel(c)?;
        b.record()?;
        if p.order.get() == order {
            return Ok(Some((p.id.clone(), width, height)));
        }
    }
    Ok(None)
}
