//! What text embossing (`emboss`) and SVG parts (`svg`) share once a cut is
//! made: its mesh encoded under a placeholder until staging names it, paged
//! out to the host, and the host's placement read from the wire.
use crate::assets::AssetPayload;
use crate::ids::{AssetId, EntityId};
use crate::mesh::{Coordinates, EncodeOptions, Limits, encode};
use crate::model::{Number, Text, Transform};
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;

/// Why a prepared cut does not stage or page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Limit,
}

/// The most mesh bytes one page returns.
pub const MAX_PAGE: u64 = 16 * 1024 * 1024;

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub(crate) fn stable<K>(units: &[u16]) -> Result<EntityId<K>, Error> {
    EntityId::try_from_utf16(units.to_vec()).map_err(|_| Error::Invalid)
}

/// A cut's mesh, encoded under `preview_id`, and its digest.
pub(crate) struct EncodedCut {
    pub payload: AssetPayload,
    pub digest: Vec<u16>,
}

/// `encodeIndexedMeshAsset` for a cut: its coordinate checks, in its order,
/// refuse with the browser's message.
pub(crate) fn encode_cut(
    preview_id: &str,
    positions: &[f64],
    indices: &[u32],
    source_filename: Vec<u16>,
) -> Result<EncodedCut, &'static str> {
    for &coordinate in positions {
        if !coordinate.is_finite() {
            return Err("Mesh positions must be finite");
        }
        if !(coordinate as f32).is_finite() {
            return Err("Mesh positions must fit finite float32");
        }
    }
    let payload = encode(
        EncodeOptions {
            id: AssetId::try_from_str(preview_id).expect("a stable preview ID"),
            source_filename: Some(Text::new(source_filename)),
            provenance: None,
            metadata_bytes: usize::MAX,
        },
        Coordinates::Float64(positions),
        Some(indices),
        Limits {
            asset_bytes: usize::MAX,
            vertices: usize::MAX,
            indices: usize::MAX,
        },
        || false,
    )
    .map_err(|_| "Mesh payload is too large")?;
    let digest = match &payload.descriptor {
        Value::Object(fields) => match fields.get(&units("digest")) {
            Some(Value::String(units)) => units.clone(),
            _ => unreachable!("an encoded descriptor has a digest"),
        },
        _ => unreachable!("an encoded descriptor is an object"),
    };
    Ok(EncodedCut { payload, digest })
}

/// The encoded cut under the asset ID staging names it with.
pub(crate) fn named(cut: &AssetPayload, id: &AssetId) -> AssetPayload {
    let mut descriptor = cut.descriptor.clone();
    if let Value::Object(fields) = &mut descriptor {
        fields.insert(units("id"), Value::String(id.as_utf16().to_vec()));
    }
    AssetPayload {
        descriptor,
        bytes: cut.bytes.clone(),
    }
}

/// Bytes `start..start + count` of an encoded cut.
pub(crate) fn page(bytes: &[u8], start: u64, count: u64) -> Result<&[u8], Error> {
    let end = start.checked_add(count).ok_or(Error::Invalid)?;
    if count > MAX_PAGE || end > bytes.len() as u64 {
        return Err(Error::Invalid);
    }
    Ok(&bytes[start as usize..end as usize])
}

/// A host's placement transform as the model records it.
pub(crate) fn transform(t: &wire::Transform) -> Result<Transform, Error> {
    let number = |v: f64| Number::new(v).map_err(|_| Error::Invalid);
    Ok(Transform {
        translation_mm: [
            number(t.translation_mm[0])?,
            number(t.translation_mm[1])?,
            number(t.translation_mm[2])?,
        ],
        rotation: [
            number(t.rotation[0])?,
            number(t.rotation[1])?,
            number(t.rotation[2])?,
            number(t.rotation[3])?,
        ],
        scale: [
            number(t.scale[0])?,
            number(t.scale[1])?,
            number(t.scale[2])?,
        ],
        extra: Default::default(),
    })
}
