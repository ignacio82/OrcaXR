use super::*;
use orcaxr_contracts::canonical::Value;
use orcaxr_project::model::SourceAssetDescriptor;
pub(super) fn admit<'a>(
    state: &'a ProjectState,
    assets: impl IntoIterator<Item = AssetLease>,
    limits: Limits,
    budget: &mut Budget,
    warnings: &mut Vec<Warning<'a>>,
    c: &mut impl FnMut() -> bool,
) -> Result<BTreeMap<&'a AssetId, AssetLease>, Error> {
    let mut declared = BTreeMap::new();
    for (i, d) in state.source_assets.iter().enumerate() {
        check(c)?;
        budget.record()?;
        for t in [d.id.as_utf16(), d.digest.units(), d.media_type.units()] {
            budget.text(t.len())?;
        }
        if !d
            .digest
            .units()
            .starts_with(&[102, 110, 118, 49, 97, 54, 52, 58])
        {
            push(
                warnings,
                Warning::UnsupportedDigest { asset: i },
                limits.warnings,
            )?;
        }
        declared.insert(&d.id, d);
    }
    let mut result = BTreeMap::new();
    let mut remaining = limits.total_asset_bytes;
    for asset in assets {
        check(c)?;
        budget.record()?;
        if asset.bytes().len() > limits.asset_bytes {
            return Err(Error::ResourceLimit);
        }
        remaining = remaining
            .checked_sub(asset.bytes().len())
            .ok_or(Error::ResourceLimit)?;
        let d = declared.get(asset.id()).ok_or(Error::AssetMembership)?;
        if !d
            .matches_value(asset.descriptor())
            .map_err(|_| Error::AssetMetadata)?
        {
            return Err(Error::AssetMetadata);
        }
        if result.insert(&d.id, asset).is_some() {
            return Err(Error::AssetMembership);
        }
    }
    if result.len() != declared.len() {
        return Err(Error::AssetMembership);
    }
    Ok(result)
}
pub(super) fn paths<'a>(
    state: &'a ProjectState,
    assets: &BTreeMap<&AssetId, AssetLease>,
    members: &mut BTreeMap<String, Member>,
    limits: Limits,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<Vec<(&'a AssetId, String)>, Error> {
    let mut candidates: BTreeMap<&AssetId, Vec<String>> = BTreeMap::new();
    for blob in state.extension_blobs.iter() {
        check(c)?;
        budget.record()?;
        candidates.entry(&blob.asset_id).or_default().push(path(
            blob.path.units(),
            limits,
            budget,
        )?);
    }
    for paths in candidates.values_mut() {
        check(c)?;
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    }
    let mut thumbnails = BTreeMap::new();
    for (index, t) in state.thumbnails.iter().enumerate() {
        check(c)?;
        budget.record()?;
        thumbnails.insert(&t.asset_id, (index, t));
    }
    let mut plate_orders = BTreeMap::new();
    for plate in state.plates.iter() {
        check(c)?;
        budget.record()?;
        plate_orders.insert(&plate.id, plate.order.get());
    }
    let mut used: BTreeSet<_> = members.keys().cloned().collect();
    used.extend([opc::ROOT_RELS, opc::CONTENT_TYPES, canonical::ENVELOPE_PATH].map(str::to_owned));
    let mut descriptors: Vec<_> = state.source_assets.iter().collect();
    descriptors.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    let mut result = vec![];
    for (index, d) in descriptors.into_iter().enumerate() {
        check(c)?;
        budget.record()?;
        let mut chosen = candidates
            .get(&d.id)
            .and_then(|values| {
                values
                    .iter()
                    .find(|p| !used.contains(*p) && !canonical::STRUCTURAL.contains(&p.as_str()))
            })
            .cloned();
        if chosen.is_none()
            && eq(d.media_type.units(), "image/png")
            && let Some((ordinal, thumbnail)) = thumbnails.get(&d.id)
        {
            let order = thumbnail
                .plate_id
                .as_ref()
                .and_then(|id| plate_orders.get(id))
                .copied()
                .unwrap_or(*ordinal as f64)
                + 1.0;
            let mut number = Vec::new();
            Value::Number(order).write_canonical(&mut number)?;
            let candidate = format!(
                "Metadata/plate_{}.png",
                String::from_utf8(number).map_err(|_| Error::Path)?
            );
            if !used.contains(&candidate) {
                chosen = Some(candidate);
            }
        }
        let chosen = match chosen {
            Some(p) => p,
            None => fallback(d, index, c)?,
        };
        crate::validate_package_path(&chosen, limits.zip.zip.path_bytes.min(512))
            .map_err(|_| Error::Path)?;
        budget.text(chosen.len())?;
        if !used.insert(chosen.clone()) {
            return Err(Error::Collision);
        }
        members.insert(chosen.clone(), Member::Data(assets[&d.id].clone()));
        result.push((&d.id, chosen));
    }
    Ok(result)
}
fn extension(d: &SourceAssetDescriptor) -> &'static str {
    for (kind, suffix) in [
        ("image/png", "png"),
        ("image/jpeg", "jpg"),
        ("image/webp", "webp"),
        ("application/json", "json"),
        ("application/xml", "xml"),
        ("text/xml", "xml"),
        ("text/plain", "txt"),
    ] {
        if d.media_type.units().len() == kind.len()
            && d.media_type
                .units()
                .iter()
                .zip(kind.bytes())
                .all(|(&a, b)| a == u16::from(b) || a == u16::from(b.to_ascii_uppercase()))
        {
            return suffix;
        }
    }
    "bin"
}
fn fallback(
    d: &SourceAssetDescriptor,
    index: usize,
    c: &mut impl FnMut() -> bool,
) -> Result<String, Error> {
    let mut label = [0u8; 64];
    let mut used = 0;
    let mut separator = false;
    for (i, &u) in d.digest.units().iter().enumerate() {
        if i % crate::CHUNK_BYTES == 0 {
            check(c)?;
        }
        if let Ok(b) = u8::try_from(u)
            && b.is_ascii_alphanumeric()
        {
            if separator && used > 0 && used < 64 {
                label[used] = b'-';
                used += 1;
            }
            if used < 64 {
                label[used] = b;
                used += 1;
            }
            separator = false;
        } else {
            separator = true;
        }
    }
    let label = if used == 0 {
        "asset"
    } else {
        std::str::from_utf8(&label[..used]).unwrap()
    };
    let mut hash = 0xcbf29ce484222325u64;
    for (i, scalar) in char::decode_utf16(d.digest.units().iter().copied()).enumerate() {
        if i % crate::CHUNK_BYTES == 0 {
            check(c)?;
        }
        let scalar = scalar.unwrap_or(char::REPLACEMENT_CHARACTER);
        let mut bytes = [0; 4];
        for b in scalar.encode_utf8(&mut bytes).bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!(
        "Metadata/orcaxr/assets/{:04}-{label}-{hash:016x}.{}",
        index + 1,
        extension(d)
    ))
}
