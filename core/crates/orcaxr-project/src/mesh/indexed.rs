//! `decodeIndexedMeshAsset` (`meshCodec.ts`) for commands that read geometry:
//! the browser's checks in its order, with its messages. Descriptor fields use
//! JavaScript reads (a missing field is `undefined`, so `undefined < 3` is false
//! while `Number.isSafeInteger(undefined)` fails), so a refusal names the same
//! problem as the browser would.
use crate::assets::AssetLease;
use orcaxr_contracts::canonical::Value;

/// Float32 positions widened exactly, and resolved indices.
pub struct IndexedMesh {
    pub positions: Vec<[f64; 3]>,
    pub indices: Vec<u32>,
}

const SAFE: f64 = 9_007_199_254_740_991.0;

fn field<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    let Some(Value::Object(fields)) = value else {
        return None;
    };
    fields.get(&name.encode_utf16().collect::<Vec<_>>())
}
fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    }
}
fn text_is(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(units)) if units.iter().copied().eq(expected.encode_utf16()))
}
fn safe_integer(value: Option<f64>) -> Option<f64> {
    value.filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE)
}
/// JavaScript truthiness for an object-valued descriptor field.
fn present(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null))
}

/// `validateBufferView`: returns `(byteOffset, stride, count)`.
fn view(
    descriptor: Option<&Value>,
    payload: usize,
    component_bytes: f64,
    label: &str,
) -> Result<(usize, usize, usize), String> {
    let mut values = [0.0; 4];
    for (slot, name) in
        values
            .iter_mut()
            .zip(["byteOffset", "byteLength", "componentCount", "count"])
    {
        *slot = safe_integer(number(field(descriptor, name)))
            .filter(|n| *n >= 0.0)
            .ok_or_else(|| format!("Mesh {label} {name} is invalid"))?;
    }
    let [offset, length, components, count] = values;
    if components < 1.0 {
        return Err(format!("Mesh {label} component count is invalid"));
    }
    let packed = components * component_bytes;
    let stride = match field(descriptor, "byteStride") {
        None | Some(Value::Null) => Some(packed),
        Some(value) => safe_integer(number(Some(value))),
    }
    .filter(|stride| *stride >= packed)
    .ok_or_else(|| format!("Mesh {label} stride is invalid"))?;
    let segment_end = offset + length;
    let last_end = if count == 0.0 {
        offset
    } else {
        offset + (count - 1.0) * stride + packed
    };
    if safe_integer(Some(segment_end)).is_none()
        || safe_integer(Some(last_end)).is_none()
        || segment_end > payload as f64
        || last_end > segment_end
    {
        return Err(format!("Mesh {label} buffer view is outside the payload"));
    }
    // Every address below is inside the payload, so these narrow losslessly.
    Ok((offset as usize, stride as usize, count as usize))
}

/// Counts of a payload that passed every `decodeIndexedMeshAsset` check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshCounts {
    pub vertices: usize,
    pub triangles: usize,
}

pub fn decode_indexed(asset: &AssetLease) -> Result<IndexedMesh, String> {
    let mut mesh = IndexedMesh {
        positions: Vec::new(),
        indices: Vec::new(),
    };
    walk(asset, &mut mesh)?;
    Ok(mesh)
}

/// The same checks, in the same order and with the same messages, without
/// materializing the mesh: commands re-validate stored payloads on every apply.
pub fn validate_indexed(asset: &AssetLease) -> Result<MeshCounts, String> {
    walk(asset, &mut Discard)
}

/// Receives a mesh as it is checked; validation alone keeps nothing.
trait Sink {
    fn vertices(&mut self, _count: usize) {}
    fn vertex(&mut self, _vertex: [f32; 3]) {}
    fn indices(&mut self, _count: usize) {}
    fn index(&mut self, _index: u32) {}
}
struct Discard;
impl Sink for Discard {}
impl Sink for IndexedMesh {
    fn vertices(&mut self, count: usize) {
        self.positions.reserve_exact(count);
    }
    fn vertex(&mut self, vertex: [f32; 3]) {
        self.positions.push(vertex.map(f64::from));
    }
    fn indices(&mut self, count: usize) {
        self.indices.reserve_exact(count);
    }
    fn index(&mut self, index: u32) {
        self.indices.push(index);
    }
}

fn walk(asset: &AssetLease, sink: &mut impl Sink) -> Result<MeshCounts, String> {
    let descriptor = Some(asset.descriptor());
    let bytes = asset.bytes();
    let mesh = field(descriptor, "mesh");
    if !text_is(field(descriptor, "kind"), "mesh") || !present(mesh) {
        return Err("Asset is not an indexed mesh".into());
    }
    if number(field(descriptor, "byteLength")) != Some(bytes.len() as f64) {
        return Err("Mesh payload byte length differs from its descriptor".into());
    }
    if let Some(Value::String(digest)) = field(descriptor, "digest")
        && digest.starts_with(&"fnv1a64:".encode_utf16().collect::<Vec<_>>())
        && !digest
            .iter()
            .copied()
            .eq(asset.content_digest().encode_utf16())
    {
        return Err("Mesh payload content differs from its descriptor digest".into());
    }
    let positions = field(mesh, "positions");
    if !text_is(field(positions, "componentType"), "float32")
        || number(field(positions, "componentCount")).is_some_and(|n| n < 3.0)
    {
        return Err("Mesh positions must be float32 vectors with at least three components".into());
    }
    let (offset, stride, vertex_count) = view(positions, bytes.len(), 4.0, "position")?;
    let float = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
    sink.vertices(vertex_count);
    for index in 0..vertex_count {
        let at = offset + index * stride;
        let vertex = [float(at), float(at + 4), float(at + 8)];
        if !vertex.iter().all(|v| v.is_finite()) {
            return Err("Mesh contains a non-finite vertex".into());
        }
        sink.vertex(vertex);
    }
    let indices_view = field(mesh, "indices");
    let mut outside = false;
    let index_count = if present(indices_view) {
        let kind = field(indices_view, "componentType");
        let width = if text_is(kind, "uint16") {
            2
        } else if text_is(kind, "uint32") {
            4
        } else {
            return Err("Mesh indices must be uint16 or uint32 scalars".into());
        };
        if number(field(indices_view, "componentCount")) != Some(1.0) {
            return Err("Mesh indices must be scalar values".into());
        }
        let (offset, stride, count) = view(indices_view, bytes.len(), width as f64, "index")?;
        sink.indices(count);
        for index in 0..count {
            let at = offset + index * stride;
            let value = if width == 2 {
                u32::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]))
            } else {
                u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
            };
            outside |= value as usize >= vertex_count;
            sink.index(value);
        }
        count
    } else {
        sink.indices(vertex_count);
        (0..vertex_count as u32).for_each(|index| sink.index(index));
        vertex_count
    };
    let triangles = number(field(mesh, "triangleCount"))
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
        .ok_or("Mesh triangle count must be a non-negative integer")?;
    if !index_count.is_multiple_of(3) || (index_count / 3) as f64 != triangles {
        return Err("Mesh index count does not match the declared triangle count".into());
    }
    if outside {
        return Err("Mesh index is outside the vertex buffer".into());
    }
    Ok(MeshCounts {
        vertices: vertex_count,
        triangles: index_count / 3,
    })
}
