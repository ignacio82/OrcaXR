//! Immutable mesh-byte admission and borrowed packed access. Graph admission is
//! separate: a declared layout alone does not prove finite vertices/valid indices.
mod bounds;
mod encode;
pub mod extrude;
mod indexed;
pub mod simplify;
pub mod split;
pub mod triangulate;
use crate::assets::AssetLease;
pub use bounds::{Bounds, BoundsLimits, instance_bounds};
pub use encode::{Coordinates, EncodeOptions, encode};
pub use indexed::{IndexedMesh, MeshCounts, decode_indexed, validate_indexed};
use orcaxr_contracts::canonical::Value;
use std::fmt;

const SAFE: f64 = 9_007_199_254_740_991.0;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Limits,
    Layout,
    Positions,
    Indices,
    TriangleCount,
    NonFiniteVertex,
    IndexRange,
    Allocation,
    Cancelled,
    Metadata,
    NoGeometry,
    Transform,
    DuplicateInstance,
    MissingInstance,
    MissingAsset,
    MetadataMismatch,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "mesh_{self:?}")
    }
}
impl std::error::Error for Error {}

/// Explicit host limits. Zero disables nonempty input; no platform RAM budget
/// is inferred from these logical counts. Asset staging has its own limits.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    pub asset_bytes: usize,
    pub vertices: usize,
    pub indices: usize,
}
fn check(cancelled: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = value else {
        return None;
    };
    let mut key = [0u16; 16];
    for (i, b) in name.bytes().enumerate() {
        key[i] = u16::from(b);
    }
    fields.get(&key[..name.len()])
}
fn named(value: Option<&Value>, name: &str) -> bool {
    matches!(value,Some(Value::String(v)) if v.iter().copied().eq(name.encode_utf16()))
}
fn integer(value: Option<&Value>) -> Result<u64, Error> {
    match value {
        Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 && (0.0..=SAFE).contains(n) => {
            Ok(*n as u64)
        }
        _ => Err(Error::Layout),
    }
}
fn safe_size(n: u64) -> Result<u64, Error> {
    if n > 9_007_199_254_740_991 {
        Err(Error::Layout)
    } else {
        Ok(n)
    }
}
#[derive(Debug, Clone, Copy)]
struct Layout {
    offset: usize,
    stride: usize,
    count: usize,
    width: usize,
}
impl Layout {
    fn read(v: &Value, bytes: usize, width: usize) -> Result<Self, Error> {
        let offset = integer(field(v, "byteOffset"))?;
        let length = integer(field(v, "byteLength"))?;
        let count = integer(field(v, "count"))?;
        let components = integer(field(v, "componentCount"))?;
        if components == 0 {
            return Err(Error::Layout);
        }
        let packed = components
            .checked_mul(width as u64)
            .ok_or(Error::Layout)
            .and_then(safe_size)?;
        let stride = match field(v, "byteStride") {
            None | Some(Value::Null) => packed,
            Some(v) => integer(Some(v))?,
        };
        if stride < packed {
            return Err(Error::Layout);
        }
        let end = offset
            .checked_add(length)
            .ok_or(Error::Layout)
            .and_then(safe_size)?;
        let last = if count == 0 {
            offset
        } else {
            offset
                .checked_add((count - 1).checked_mul(stride).ok_or(Error::Layout)?)
                .and_then(|v| v.checked_add(packed))
                .ok_or(Error::Layout)
                .and_then(safe_size)?
        };
        if end > bytes as u64 || last > end {
            return Err(Error::Layout);
        }
        Ok(Self {
            offset: usize::try_from(offset).map_err(|_| Error::Layout)?,
            // An unused stride may exceed wasm32 address space without making
            // an empty/single-element view invalid. Only actual addresses narrow.
            stride: if count <= 1 {
                0
            } else {
                usize::try_from(stride).map_err(|_| Error::Layout)?
            },
            count: usize::try_from(count).map_err(|_| Error::Layout)?,
            width,
        })
    }
}

/// Owns a read-only asset lease and a validated layout, never decoded mesh arrays.
/// Clones retain the byte proof and original record without rescanning or copying.
#[derive(Debug, Clone)]
pub struct Mesh {
    asset: AssetLease,
    positions: Layout,
    indices: Option<Layout>,
    index_count: usize,
}
impl Mesh {
    pub fn open(
        asset: AssetLease,
        limits: Limits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        check(&mut cancelled)?;
        let bytes = asset.bytes();
        if bytes.len() > limits.asset_bytes {
            return Err(Error::Limits);
        }
        let descriptor = asset.descriptor();
        if !named(field(descriptor, "kind"), "mesh") {
            return Err(Error::Layout);
        }
        let mesh = field(descriptor, "mesh").ok_or(Error::Layout)?;
        let p = field(mesh, "positions").ok_or(Error::Positions)?;
        if !named(field(p, "componentType"), "float32") || integer(field(p, "componentCount"))? < 3
        {
            return Err(Error::Positions);
        }
        let positions = Layout::read(p, bytes.len(), 4)?;
        let indices = match field(mesh, "indices") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let width = if named(field(v, "componentType"), "uint16") {
                    2
                } else if named(field(v, "componentType"), "uint32") {
                    4
                } else {
                    return Err(Error::Indices);
                };
                if integer(field(v, "componentCount"))? != 1 {
                    return Err(Error::Indices);
                }
                Some(Layout::read(v, bytes.len(), width)?)
            }
        };
        let index_count = indices.map_or(positions.count, |v| v.count);
        if positions.count > limits.vertices || index_count > limits.indices {
            return Err(Error::Limits);
        }
        if !index_count.is_multiple_of(3)
            || integer(field(mesh, "triangleCount"))? != (index_count / 3) as u64
        {
            return Err(Error::TriangleCount);
        }
        let result = Self {
            asset,
            positions,
            indices,
            index_count,
        };
        for i in 0..result.vertex_count() {
            if i.is_multiple_of(4096) {
                check(&mut cancelled)?;
            }
            if !result.position(i).unwrap().iter().all(|n| n.is_finite()) {
                return Err(Error::NonFiniteVertex);
            }
        }
        for i in 0..index_count {
            if i.is_multiple_of(4096) {
                check(&mut cancelled)?;
            }
            if result.index(i).unwrap() as usize >= result.vertex_count() {
                return Err(Error::IndexRange);
            }
        }
        check(&mut cancelled)?;
        Ok(result)
    }
    pub fn asset(&self) -> &AssetLease {
        &self.asset
    }
    pub fn vertex_count(&self) -> usize {
        self.positions.count
    }
    pub fn triangle_count(&self) -> usize {
        self.index_count / 3
    }
    pub fn index_count(&self) -> usize {
        self.index_count
    }
    pub fn position(&self, index: usize) -> Option<[f32; 3]> {
        if index >= self.vertex_count() {
            return None;
        }
        let at = self.positions.offset + index * self.positions.stride;
        Some(std::array::from_fn(|i| {
            f32::from_le_bytes(
                self.asset.bytes()[at + i * 4..at + i * 4 + 4]
                    .try_into()
                    .unwrap(),
            )
        }))
    }
    pub fn index(&self, index: usize) -> Option<u32> {
        if index >= self.index_count {
            return None;
        }
        Some(match self.indices {
            None => index as u32,
            Some(v) => {
                let at = v.offset + index * v.stride;
                let bytes = &self.asset.bytes()[at..at + v.width];
                if v.width == 2 {
                    u32::from(u16::from_le_bytes(bytes.try_into().unwrap()))
                } else {
                    u32::from_le_bytes(bytes.try_into().unwrap())
                }
            }
        })
    }
    pub fn triangle(&self, index: usize) -> Option<[u32; 3]> {
        if index >= self.triangle_count() {
            return None;
        }
        Some(std::array::from_fn(|i| self.index(index * 3 + i).unwrap()))
    }
    pub fn positions(&self) -> impl ExactSizeIterator<Item = [f32; 3]> + '_ {
        (0..self.vertex_count()).map(|i| self.position(i).unwrap())
    }
    pub fn triangles(&self) -> impl ExactSizeIterator<Item = [u32; 3]> + '_ {
        (0..self.triangle_count()).map(|i| self.triangle(i).unwrap())
    }
    /// Explicit public materialization for consumers requiring expanded xyz.
    /// The returned buffer is independent; normal read/bounds/export uses the view.
    pub fn expand(
        &self,
        max_bytes: usize,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Vec<f32>, Error> {
        check(&mut cancelled)?;
        let count = self.index_count.checked_mul(3).ok_or(Error::Limits)?;
        if count.checked_mul(4).ok_or(Error::Limits)? > max_bytes {
            return Err(Error::Limits);
        }
        let mut out = Vec::new();
        out.try_reserve_exact(count)
            .map_err(|_| Error::Allocation)?;
        for i in 0..self.index_count {
            if i.is_multiple_of(4096) {
                check(&mut cancelled)?;
            }
            out.extend_from_slice(&self.position(self.index(i).unwrap() as usize).unwrap());
        }
        check(&mut cancelled)?;
        Ok(out)
    }
}
