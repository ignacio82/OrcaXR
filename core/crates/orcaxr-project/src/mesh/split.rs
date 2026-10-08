//! `prepareVolumeSplitComponents` (`splitPreparation.ts`): a mesh's connected
//! components in the pinned `TriangleMesh::split` order, each encoded and
//! recentred on its own bounding box.
//!
//! Faces connect only through oppositely directed shared index edges, scanned
//! in ascending face order (an edge shared by more than two faces links its
//! first free pair). Components are seeded by the first unvisited face and
//! keep their depth-first discovery order; each part's vertices keep their
//! first use. A component of negative pinned signed volume is turned outward,
//! and its float32 arithmetic follows the browser's `Math.fround` steps.
use super::{Coordinates, EncodeOptions, Error, Limits, decode_indexed, encode};
use crate::assets::{AssetLease, AssetPayload};
use crate::js_math;
use crate::model::{AssetOrigin, AssetProvenance, Number, Text, Transform};
use orcaxr_contracts::canonical::Value;
use std::sync::Arc;

/// Why a source does not split, with the browser's message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    InvalidMesh,
    InvalidTransform,
    NotSplittable,
}

/// One component, encoded under the source's asset ID (not yet named).
pub struct Component {
    pub source_triangles: Vec<u32>,
    pub payload: AssetPayload,
    /// The payload's content digest.
    pub digest: Vec<u16>,
    pub vertices: usize,
    pub transform: Transform,
}

fn refuse<T>(code: Refusal, message: impl Into<String>) -> Result<T, (Refusal, String)> {
    Err((code, message.into()))
}

/// The components of `source` under `transform`, the source's own placement.
/// `digest` is its declared digest, which the parts' provenance names.
pub fn components(
    source: &AssetLease,
    digest: &[u16],
    transform: &Transform,
) -> Result<Vec<Component>, (Refusal, String)> {
    // `assertSourceTransform`: shape and finiteness hold by construction. The
    // source's asset ID is stable by construction too.
    if transform.scale.iter().any(|v| v.get().abs() < 1e-12) {
        return refuse(
            Refusal::InvalidTransform,
            "Source split transform scale cannot contain zero",
        );
    }
    let rotation = js_math::hypot(&transform.rotation.map(Number::get));
    if !rotation.is_finite() || rotation < 1e-12 {
        return refuse(
            Refusal::InvalidTransform,
            "Source split transform rotation cannot be zero",
        );
    }
    let mesh = decode_indexed(source).map_err(|message| (Refusal::InvalidMesh, message))?;
    if mesh.indices.is_empty() || mesh.positions.is_empty() {
        return refuse(
            Refusal::InvalidMesh,
            "Split preparation requires a non-empty indexed mesh",
        );
    }
    let triangles: Vec<[u32; 3]> = mesh
        .indices
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let neighbors = neighbors(&triangles, mesh.positions.len())?;
    let components = discover(&neighbors);
    if components.len() < 2 {
        return refuse(
            Refusal::NotSplittable,
            "Source mesh has one shared-edge component and is not splittable",
        );
    }
    let uri: Vec<u16> = "orcaxr:split-to-parts:"
        .encode_utf16()
        .chain(digest.iter().copied())
        .collect();
    let provenance = Arc::new(AssetProvenance {
        source: AssetOrigin::Generated,
        uri: Some(Text::new(uri)),
        imported_at: None,
        extra: Default::default(),
    });
    components
        .into_iter()
        .map(|faces| {
            part(
                &mesh.positions,
                &triangles,
                faces,
                source,
                &provenance,
                transform,
            )
        })
        .collect()
}

/// `buildPinnedFaceNeighbors`: per face, the face across each edge or `None`.
fn neighbors(
    triangles: &[[u32; 3]],
    vertex_count: usize,
) -> Result<Vec<[Option<u32>; 3]>, (Refusal, String)> {
    // Each vertex's faces in ascending order, as one packed table.
    let mut starts = vec![0usize; vertex_count + 1];
    for (face, triangle) in triangles.iter().enumerate() {
        if triangle[0] == triangle[1] || triangle[1] == triangle[2] || triangle[2] == triangle[0] {
            return refuse(
                Refusal::InvalidMesh,
                format!("Source triangle {face} repeats a vertex index"),
            );
        }
        for &vertex in triangle {
            starts[vertex as usize + 1] += 1;
        }
    }
    for vertex in 0..vertex_count {
        starts[vertex + 1] += starts[vertex];
    }
    let mut next = starts.clone();
    let mut faces = vec![0u32; starts[vertex_count]];
    for (face, triangle) in triangles.iter().enumerate() {
        for &vertex in triangle {
            faces[next[vertex as usize]] = face as u32;
            next[vertex as usize] += 1;
        }
    }
    let mut neighbors = vec![[None; 3]; triangles.len()];
    for face in 0..triangles.len() {
        let triangle = triangles[face];
        for edge in 0..3 {
            if neighbors[face][edge].is_some() {
                continue;
            }
            let (start, end) = (triangle[edge], triangle[(edge + 1) % 3]);
            let around = &faces[starts[start as usize]..starts[start as usize + 1]];
            for &other in around {
                if other as usize <= face {
                    continue;
                }
                let other_triangle = triangles[other as usize];
                let Some(other_edge) = other_triangle.iter().position(|&v| v == end) else {
                    continue;
                };
                if other_triangle[(other_edge + 1) % 3] != start
                    || neighbors[other as usize][other_edge].is_some()
                {
                    continue;
                }
                neighbors[face][edge] = Some(other);
                neighbors[other as usize][other_edge] = Some(face as u32);
                break;
            }
        }
    }
    Ok(neighbors)
}

/// `discoverPinnedComponents`: depth-first from each unvisited face.
fn discover(neighbors: &[[Option<u32>; 3]]) -> Vec<Vec<u32>> {
    let mut visited = vec![false; neighbors.len()];
    let mut components = Vec::new();
    for seed in 0..neighbors.len() {
        if visited[seed] {
            continue;
        }
        visited[seed] = true;
        let mut component = vec![seed as u32];
        let mut stack = vec![seed as u32];
        while let Some(face) = stack.pop() {
            for neighbor in neighbors[face as usize].into_iter().flatten() {
                if !visited[neighbor as usize] {
                    visited[neighbor as usize] = true;
                    component.push(neighbor);
                    stack.push(neighbor);
                }
            }
        }
        components.push(component);
    }
    components
}

/// `buildComponentGeometry`, its encoding and `recenteredTransform`.
fn part(
    positions: &[[f64; 3]],
    triangles: &[[u32; 3]],
    faces: Vec<u32>,
    source: &AssetLease,
    provenance: &Arc<AssetProvenance>,
    transform: &Transform,
) -> Result<Component, (Refusal, String)> {
    let mut mapped = std::collections::HashMap::new();
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::with_capacity(faces.len() * 3);
    for &face in &faces {
        for vertex in triangles[face as usize] {
            let index = *mapped.entry(vertex).or_insert_with(|| {
                vertices.push(positions[vertex as usize]);
                (vertices.len() - 1) as u32
            });
            indices.push(index);
        }
    }
    if signed_volume(&vertices, &indices) < 0.0 {
        for triangle in indices.chunks_exact_mut(3) {
            triangle.swap(1, 2);
        }
    }
    let center = center(&vertices);
    let shift = center.map(|c| c as f32);
    let coordinates: Vec<f32> = vertices
        .iter()
        .flat_map(|v| (0..3).map(move |axis| (v[axis] - f64::from(shift[axis])) as f32))
        .collect();
    let payload = encode(
        EncodeOptions {
            id: source.id().clone(),
            source_filename: None,
            provenance: Some(provenance.clone()),
            metadata_bytes: usize::MAX,
        },
        Coordinates::Float32(&coordinates),
        Some(&indices),
        Limits {
            asset_bytes: usize::MAX,
            vertices: usize::MAX,
            indices: usize::MAX,
        },
        || false,
    )
    .map_err(|error| {
        (
            Refusal::InvalidMesh,
            match error {
                // `encodeIndexedMeshAsset`'s refusals; recentring keeps every
                // coordinate within half its component's float32 extent.
                Error::NonFiniteVertex => "Mesh positions must be finite",
                _ => "Mesh payload is too large",
            }
            .to_owned(),
        )
    })?;
    let translation: Vec<f64> = (0..3)
        .map(|axis| transform.translation_mm[axis].get() + center[axis])
        .collect();
    let translation_mm = match translation
        .iter()
        .map(|&v| Number::new(v))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(values) => [values[0], values[1], values[2]],
        Err(_) => {
            return refuse(
                Refusal::InvalidTransform,
                "Recentered split transform is not finite",
            );
        }
    };
    let digest = match &payload.descriptor {
        Value::Object(fields) => match fields.get(&"digest".encode_utf16().collect::<Vec<_>>()) {
            Some(Value::String(units)) => units.clone(),
            _ => unreachable!("an encoded descriptor has a digest"),
        },
        _ => unreachable!("an encoded descriptor is an object"),
    };
    Ok(Component {
        source_triangles: faces,
        payload,
        digest,
        vertices: vertices.len(),
        transform: Transform {
            translation_mm,
            ..transform.clone()
        },
    })
}

/// `pinnedSignedVolume`: each `Math.fround` step in float32 (single float32
/// operations round exactly as their rounded float64 results), except the
/// height, whose three terms the browser sums in float64 before rounding.
/// NaN for a degenerate face, which never turns a component.
fn signed_volume(vertices: &[[f64; 3]], indices: &[u32]) -> f32 {
    let at = |index: u32| vertices[index as usize].map(|c| c as f32);
    let reference = at(indices[0]);
    let mut volume = 0.0f32;
    for triangle in indices.chunks_exact(3) {
        let (first, second, third) = (at(triangle[0]), at(triangle[1]), at(triangle[2]));
        let u = [0, 1, 2].map(|k| second[k] - first[k]);
        let v = [0, 1, 2].map(|k| third[k] - first[k]);
        let c = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let norm = js_math::hypot(&c.map(f64::from)) as f32;
        if norm == 0.0 {
            return f32::NAN;
        }
        let n = c.map(|k| k / norm);
        let area = 0.5 * norm;
        let terms = [0, 1, 2].map(|k| f64::from(n[k] * (first[k] - reference[k])));
        let height = (terms[0] + terms[1] + terms[2]) as f32;
        volume += area * height / 3.0;
    }
    volume
}

/// `boundingBoxCenter` with JavaScript `Math.min`/`Math.max`.
fn center(vertices: &[[f64; 3]]) -> [f64; 3] {
    let mut min = vertices[0];
    let mut max = vertices[0];
    for vertex in &vertices[1..] {
        for axis in 0..3 {
            min[axis] = js_math::min(min[axis], vertex[axis]);
            max[axis] = js_math::max(max[axis], vertex[axis]);
        }
    }
    [0, 1, 2].map(|axis| (min[axis] + max[axis]) / 2.0)
}
