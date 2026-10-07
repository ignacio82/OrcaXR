use super::*;
use crate::{
    assets::AssetPayload,
    ids::AssetId,
    model::{AssetProvenance, Encode, Text},
};
use std::io::{self, Write};
use std::sync::Arc;
#[derive(Clone, Copy)]
pub enum Coordinates<'a> {
    Float32(&'a [f32]),
    Float64(&'a [f64]),
}
impl Coordinates<'_> {
    fn len(self) -> usize {
        match self {
            Self::Float32(v) => v.len(),
            Self::Float64(v) => v.len(),
        }
    }
    fn at(self, i: usize) -> f64 {
        match self {
            Self::Float32(v) => f64::from(v[i]),
            Self::Float64(v) => v[i],
        }
    }
}
pub struct EncodeOptions {
    pub id: AssetId,
    pub source_filename: Option<Text>,
    pub provenance: Option<Arc<AssetProvenance>>,
    /// Combined canonical UTF-8 bytes of the supplied ID, filename and provenance.
    /// Checked without copying them, before allocating the mesh output.
    pub metadata_bytes: usize,
}
fn metadata(options: &EncodeOptions, cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    struct Budget<'a, C> {
        remaining: usize,
        cancelled: &'a mut C,
        stop: Option<Error>,
    }
    impl<C: FnMut() -> bool> Write for Budget<'_, C> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.stop = self.stop.or_else(|| {
                if (self.cancelled)() {
                    Some(Error::Cancelled)
                } else if bytes.len() > self.remaining {
                    Some(Error::Limits)
                } else {
                    None
                }
            });
            if self.stop.is_some() {
                return Err(io::ErrorKind::Other.into());
            }
            self.remaining -= bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut budget = Budget {
        remaining: options.metadata_bytes,
        cancelled,
        stop: None,
    };
    let mut write = |value: &dyn Encode| {
        value
            .write_json(&mut budget)
            .map_err(|_| budget.stop.unwrap_or(Error::Metadata))
    };
    write(&options.id)?;
    if let Some(v) = &options.source_filename {
        write(v)?;
    }
    if let Some(v) = &options.provenance {
        write(v.as_ref())?;
    }
    Ok(())
}
fn number(n: usize) -> Value {
    Value::Number(n as f64)
}
fn text(v: &str) -> Value {
    Value::String(v.encode_utf16().collect())
}
fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
/// Canonical little-endian packed encoding, including optional non-indexed input.
/// Writes one owned payload, hashing as it writes. Nothing is published on failure.
pub fn encode(
    options: EncodeOptions,
    positions: Coordinates<'_>,
    indices: Option<&[u32]>,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<AssetPayload, Error> {
    check(&mut cancelled)?;
    metadata(&options, &mut cancelled)?;
    if !positions.len().is_multiple_of(3) {
        return Err(Error::Positions);
    }
    let vertices = positions.len() / 3;
    let index_count = indices.map_or(vertices, <[u32]>::len);
    if !index_count.is_multiple_of(3) {
        return Err(Error::TriangleCount);
    }
    let position_bytes = positions.len().checked_mul(4).ok_or(Error::Limits)?;
    let index_bytes = indices
        .map_or(0, <[u32]>::len)
        .checked_mul(4)
        .ok_or(Error::Limits)?;
    let total = position_bytes
        .checked_add(index_bytes)
        .ok_or(Error::Limits)?;
    if total as u128 > 9_007_199_254_740_991
        || total > limits.asset_bytes
        || vertices > limits.vertices
        || index_count > limits.indices
    {
        return Err(Error::Limits);
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(total)
        .map_err(|_| Error::Allocation)?;
    let mut hash = 0xcbf29ce484222325u64;
    let mut push = |raw: [u8; 4]| {
        for b in raw {
            hash = (hash ^ u64::from(b)).wrapping_mul(0x100000001b3);
        }
        bytes.extend_from_slice(&raw);
    };
    for i in 0..positions.len() {
        if i.is_multiple_of(4096) {
            check(&mut cancelled)?;
        }
        let coordinate = positions.at(i) as f32;
        if !coordinate.is_finite() {
            return Err(Error::NonFiniteVertex);
        }
        push(coordinate.to_le_bytes());
    }
    if let Some(indices) = indices {
        for (i, &index) in indices.iter().enumerate() {
            if i.is_multiple_of(4096) {
                check(&mut cancelled)?;
            }
            if index as usize >= vertices {
                return Err(Error::IndexRange);
            }
            push(index.to_le_bytes());
        }
    }
    let positions = object([
        ("byteOffset", number(0)),
        ("byteLength", number(position_bytes)),
        ("componentType", text("float32")),
        ("componentCount", number(3)),
        ("count", number(vertices)),
    ]);
    let mut mesh = match object([
        ("positions", positions),
        ("triangleCount", number(index_count / 3)),
    ]) {
        Value::Object(v) => v,
        _ => unreachable!(),
    };
    if indices.is_some() {
        mesh.insert(
            "indices".encode_utf16().collect(),
            object([
                ("byteOffset", number(position_bytes)),
                ("byteLength", number(index_bytes)),
                ("componentType", text("uint32")),
                ("componentCount", number(1)),
                ("count", number(index_count)),
            ]),
        );
    }
    let mut descriptor = match object([
        ("id", options.id.to_value().map_err(|_| Error::Metadata)?),
        ("kind", text("mesh")),
        ("digest", text(&format!("fnv1a64:{hash:016x}"))),
        ("byteLength", number(total)),
        ("mediaType", text("application/vnd.orcaxr.indexed-mesh")),
        ("mesh", Value::Object(mesh)),
    ]) {
        Value::Object(v) => v,
        _ => unreachable!(),
    };
    if let Some(filename) = options.source_filename.filter(|v| !v.units().is_empty()) {
        descriptor.insert(
            "sourceFilename".encode_utf16().collect(),
            filename.to_value().map_err(|_| Error::Metadata)?,
        );
    }
    if let Some(provenance) = options.provenance {
        descriptor.insert(
            "provenance".encode_utf16().collect(),
            provenance.to_value().map_err(|_| Error::Metadata)?,
        );
    }
    check(&mut cancelled)?;
    Ok(AssetPayload {
        descriptor: Value::Object(descriptor),
        bytes,
    })
}
