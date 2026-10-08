//! Renderer packets for a mesh asset (`meshPacket.ts`): the geometry the
//! workspace draws, packed for a platform renderer that cannot run three.js.
//!
//! The browser uploads the decoded float32 positions and index with
//! three.js's smooth vertex normals and bounds (`displayGeometry`); those are
//! reproduced bit for bit — each triangle's `cb × ab` added to its corners
//! through float32 storage, then normalized by a reciprocal, and the box and
//! sphere with JavaScript's `min`/`max`. The geometry is then split into
//! chunks of at most a host's vertex limit in triangle order, each with its
//! own vertices (first-use order) and local indices, 16-bit when a chunk can
//! never exceed 65,536 vertices. Normals are the whole mesh's, so a vertex on
//! a chunk seam shades identically on both sides.
//!
//! Packets stay in the asset's millimetres and axes; each platform adapter
//! converts once. Colour, selection and transforms come from the render
//! projection (`render`), paint from overlay packets.
use crate::assets::AssetRepository;
use crate::ids::AssetId;
use crate::js_math;
use crate::mesh::decode_indexed;
use orcaxr_contracts::project_intent_types as wire;

/// Bytes of one chunk-table entry: first triangle, triangles, vertices and
/// byte offset, each a little-endian `u32`.
pub const TABLE_ENTRY_BYTES: usize = 16;
/// The most packet bytes one page returns.
pub const MAX_PAGE: u64 = 16 * 1024 * 1024;
/// Chunks of at most this many vertices index them in 16 bits.
const SHORT_INDEX_VERTICES: u64 = 65_536;
/// The quiet NaN every NaN normal component is written as.
const CANONICAL_NAN: u32 = 0x7fc0_0000;

/// One asset's packet: the reply, and the bytes it describes.
pub struct MeshPacket {
    reply: wire::MeshPacketReply,
    bytes: Vec<u8>,
}

impl MeshPacket {
    /// `MeshPacketReply`: the packet's shape, or why there is none.
    pub fn reply(&self) -> &wire::MeshPacketReply {
        &self.reply
    }
    /// Bytes `start..start + count` of the packet; refused past its end or
    /// beyond one page.
    pub fn bytes(&self, start: u64, count: u64) -> Option<&[u8]> {
        let end = start.checked_add(count)?;
        if count > MAX_PAGE || end > self.bytes.len() as u64 {
            return None;
        }
        Some(&self.bytes[start as usize..end as usize])
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn refused(code: wire::MeshPacketRefusalCode, message: Vec<u16>) -> MeshPacket {
    MeshPacket {
        reply: wire::MeshPacketReply::Refused(wire::MeshPacketRefusal { code, message }),
        bytes: Vec::new(),
    }
}

/// `meshPacketWire`: the packet for one asset of a repository.
pub fn packet(assets: &AssetRepository, request: &wire::MeshPacketRequest) -> MeshPacket {
    let lease = AssetId::try_from_utf16(request.asset_id.clone())
        .ok()
        .and_then(|id| assets.peek(&id));
    let Some(lease) = lease else {
        let mut message = units("Asset bytes are missing for ");
        message.extend_from_slice(&request.asset_id);
        return refused(wire::MeshPacketRefusalCode::UnknownAsset, message);
    };
    let mesh = match decode_indexed(&lease) {
        Ok(mesh) => mesh,
        Err(message) => return refused(wire::MeshPacketRefusalCode::InvalidMesh, units(&message)),
    };
    let positions: Vec<[f32; 3]> = mesh.positions.iter().map(|p| p.map(|v| v as f32)).collect();
    let normals = vertex_normals(&positions, &mesh.indices);
    let packed = pack(
        &positions,
        &normals,
        &mesh.indices,
        request.max_chunk_vertices,
    );
    if packed.bytes.len() as u64 > u64::from(u32::MAX) {
        return refused(
            wire::MeshPacketRefusalCode::TooLarge,
            units("The mesh is too large for one packet"),
        );
    }
    let digest = match lease.descriptor() {
        orcaxr_contracts::canonical::Value::Object(fields) => match fields.get(&units("digest")) {
            Some(orcaxr_contracts::canonical::Value::String(digest)) => digest.clone(),
            _ => unreachable!("a decoded mesh descriptor has a digest"),
        },
        _ => unreachable!("a decoded mesh descriptor is an object"),
    };
    MeshPacket {
        reply: wire::MeshPacketReply::Prepared(wire::MeshPacket {
            asset_id: request.asset_id.clone(),
            digest,
            vertex_count: positions.len() as u64,
            triangle_count: (mesh.indices.len() / 3) as u64,
            bounds: match bounds(&positions) {
                Some(b) => wire::OptionalMeshPacketBounds::Value(wire::MeshPacketBounds {
                    box_min: b.box_min.to_vec(),
                    box_max: b.box_max.to_vec(),
                    sphere_center: b.sphere_center.to_vec(),
                    sphere_radius: b.sphere_radius,
                }),
                None => wire::OptionalMeshPacketBounds::Absent(wire::Empty {}),
            },
            index_bytes: packed.index_bytes,
            chunk_count: packed.chunks as u64,
            byte_length: packed.bytes.len() as u64,
        }),
        bytes: packed.bytes,
    }
}

/// `computeVertexNormals` on an indexed geometry. Each triangle reads its
/// three corners' running sums before writing any, as three.js does, and
/// every sum is stored as float32 between triangles.
pub fn vertex_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut normals = vec![[0f32; 3]; positions.len()];
    let point = |vertex: u32| positions[vertex as usize].map(f64::from);
    for triangle in indices.chunks_exact(3) {
        let (a, b, c) = (triangle[0], triangle[1], triangle[2]);
        let (pa, pb, pc) = (point(a), point(b), point(c));
        let cb = [pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]];
        let ab = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
        let cross = [
            cb[1] * ab[2] - cb[2] * ab[1],
            cb[2] * ab[0] - cb[0] * ab[2],
            cb[0] * ab[1] - cb[1] * ab[0],
        ];
        let sums = [a, b, c].map(|vertex| {
            let n = normals[vertex as usize].map(f64::from);
            [n[0] + cross[0], n[1] + cross[1], n[2] + cross[2]]
        });
        for (vertex, sum) in [a, b, c].into_iter().zip(sums) {
            normals[vertex as usize] = sum.map(|v| v as f32);
        }
    }
    // `normalizeNormals`: `divideScalar(length() || 1)`, a reciprocal multiply.
    for normal in &mut normals {
        let n = normal.map(f64::from);
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let length = if length == 0.0 || length.is_nan() {
            1.0
        } else {
            length
        };
        let scale = 1.0 / length;
        *normal = n.map(|v| (v * scale) as f32);
    }
    normals
}

/// `computeBoundingBox` and `computeBoundingSphere`; none for an empty mesh.
pub struct Bounds {
    pub box_min: [f64; 3],
    pub box_max: [f64; 3],
    pub sphere_center: [f64; 3],
    pub sphere_radius: f64,
}

pub fn bounds(positions: &[[f32; 3]]) -> Option<Bounds> {
    if positions.is_empty() {
        return None;
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            let value = f64::from(position[axis]);
            min[axis] = js_math::min(min[axis], value);
            max[axis] = js_math::max(max[axis], value);
        }
    }
    let center = [0, 1, 2].map(|axis| (min[axis] + max[axis]) * 0.5);
    let mut radius_squared = 0.0;
    for position in positions {
        let d = [0, 1, 2].map(|axis| center[axis] - f64::from(position[axis]));
        radius_squared = js_math::max(radius_squared, d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    }
    Some(Bounds {
        box_min: min,
        box_max: max,
        sphere_center: center,
        sphere_radius: radius_squared.sqrt(),
    })
}

struct Packed {
    bytes: Vec<u8>,
    chunks: usize,
    index_bytes: u64,
}

/// `packMesh`: chunk boundaries first (a triangle starts a new chunk when its
/// new vertices would take the current one past the limit), then the table
/// and each chunk at a 4-byte-aligned offset — positions, normals, indices.
fn pack(
    positions: &[[f32; 3]],
    normals: &[[f32; 3]],
    indices: &[u32],
    max_vertices: u64,
) -> Packed {
    let index_bytes: usize = if max_vertices <= SHORT_INDEX_VERTICES {
        2
    } else {
        4
    };
    let triangles = indices.len() / 3;
    // A vertex is stamped with the chunk that last took it.
    let mut seen = vec![usize::MAX; positions.len()];
    let mut starts: Vec<(usize, u64)> = Vec::new();
    let (mut first, mut used) = (0usize, 0u64);
    for triangle in 0..triangles {
        let corners = &indices[triangle * 3..triangle * 3 + 3];
        let chunk = starts.len();
        let fresh = (0..3)
            .filter(|&corner| {
                let vertex = corners[corner];
                // A degenerate triangle names a vertex twice; count it once.
                seen[vertex as usize] != chunk && !corners[..corner].contains(&vertex)
            })
            .count() as u64;
        if used + fresh > max_vertices {
            starts.push((first, used));
            first = triangle;
            used = 0;
        }
        let current = starts.len();
        for &vertex in corners {
            if seen[vertex as usize] != current {
                seen[vertex as usize] = current;
                used += 1;
            }
        }
    }
    if triangles > first {
        starts.push((first, used));
    }

    // (first triangle, triangles, vertices, byte offset)
    let mut table: Vec<(usize, usize, usize, usize)> = Vec::with_capacity(starts.len());
    let mut offset = starts.len() * TABLE_ENTRY_BYTES;
    for (position, &(first, vertices)) in starts.iter().enumerate() {
        let next = starts
            .get(position + 1)
            .map_or(triangles, |&(next, _)| next);
        let vertices = vertices as usize;
        table.push((first, next - first, vertices, offset));
        offset += (vertices * 24 + (next - first) * 3 * index_bytes).div_ceil(4) * 4;
    }

    let mut bytes = vec![0u8; offset];
    let mut put = |at: usize, value: &[u8]| bytes[at..at + value.len()].copy_from_slice(value);
    let float = |value: f32| {
        if value.is_nan() {
            CANONICAL_NAN.to_le_bytes()
        } else {
            value.to_le_bytes()
        }
    };
    let mut local = vec![0u32; positions.len()];
    seen.fill(usize::MAX);
    for (position, &(first, count, vertices, at)) in table.iter().enumerate() {
        let entry = position * TABLE_ENTRY_BYTES;
        for (slot, value) in [first, count, vertices, at].into_iter().enumerate() {
            put(entry + slot * 4, &(value as u32).to_le_bytes());
        }
        let normals_at = at + vertices * 12;
        let indices_at = at + vertices * 24;
        let mut next = 0u32;
        for triangle in 0..count {
            for corner in 0..3 {
                let vertex = indices[(first + triangle) * 3 + corner] as usize;
                if seen[vertex] != position {
                    seen[vertex] = position;
                    local[vertex] = next;
                    for axis in 0..3 {
                        let slot = next as usize * 12 + axis * 4;
                        put(at + slot, &float(positions[vertex][axis]));
                        put(normals_at + slot, &float(normals[vertex][axis]));
                    }
                    next += 1;
                }
                let target = indices_at + (triangle * 3 + corner) * index_bytes;
                if index_bytes == 2 {
                    put(target, &(local[vertex] as u16).to_le_bytes());
                } else {
                    put(target, &local[vertex].to_le_bytes());
                }
            }
        }
    }
    Packed {
        bytes,
        chunks: table.len(),
        index_bytes: index_bytes as u64,
    }
}
