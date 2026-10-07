//! Deterministic vertex welder shared by every mesh decoder: vertices merge on
//! exact Float32 bit equality (`Object.is` over Float32-rounded values) and are
//! emitted in first-seen order, so one source always yields identical bytes.
use super::{Format, Malformed, Mesh, Notice, NoticeKind, Result, malformed, text::Message};
use std::collections::HashMap;

pub(crate) struct Builder {
    positions: Vec<f32>,
    indices: Vec<u32>,
    welded: HashMap<[u32; 3], u32>,
    degenerate: usize,
    max_triangles: usize,
    max_vertices: usize,
    format: Format,
}
impl Builder {
    pub fn new(limits: &super::Limits, format: Format) -> Self {
        Self {
            positions: Vec::new(),
            indices: Vec::new(),
            welded: HashMap::new(),
            degenerate: 0,
            max_triangles: limits.max_triangles,
            max_vertices: limits.max_vertices,
            format,
        }
    }
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
    fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }
    /// The finiteness check precedes Float32 rounding, so a finite source value
    /// beyond the Float32 range is stored as an infinity, like the browser.
    pub fn add_vertex(&mut self, x: f64, y: f64, z: f64) -> Result<u32> {
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return Err(malformed(Malformed::InvalidGeometry, self.format));
        }
        let (x, y, z) = (x as f32, y as f32, z as f32);
        let key = [x.to_bits(), y.to_bits(), z.to_bits()];
        if let Some(&index) = self.welded.get(&key) {
            return Ok(index);
        }
        if self.vertex_count() + 1 > self.max_vertices {
            return Err(malformed(Malformed::LimitExceeded, self.format));
        }
        let index = self.vertex_count() as u32;
        self.positions.extend_from_slice(&[x, y, z]);
        self.welded.insert(key, index);
        Ok(index)
    }
    pub fn add_triangle(&mut self, corners: [[f64; 3]; 3]) -> Result<()> {
        let mut resolved = [0; 3];
        for (slot, c) in resolved.iter_mut().zip(corners) {
            *slot = self.add_vertex(c[0], c[1], c[2])?;
        }
        self.push(resolved)
    }
    /// Corners must come from `add_vertex`.
    pub fn add_indexed_triangle(&mut self, corners: [u32; 3]) -> Result<()> {
        self.push(corners)
    }
    fn push(&mut self, [a, b, c]: [u32; 3]) -> Result<()> {
        if a == b || b == c || a == c {
            self.degenerate += 1;
            return Ok(());
        }
        if self.triangle_count() + 1 > self.max_triangles {
            return Err(malformed(Malformed::LimitExceeded, self.format));
        }
        self.indices.extend_from_slice(&[a, b, c]);
        Ok(())
    }
    pub fn build(self) -> Result<Mesh> {
        if self.triangle_count() == 0 {
            return Err(malformed(Malformed::NoGeometry, self.format));
        }
        Ok(Mesh {
            positions: self.positions,
            indices: self.indices,
        })
    }
    pub fn repair_notice(&self, path: &[u16]) -> Option<Notice> {
        (self.degenerate > 0).then(|| Notice {
            kind: NoticeKind::GeometryRepair,
            code: "degenerate-triangles-dropped",
            path: path.to_vec(),
            message: Message::new("Dropped ")
                .n(self.degenerate as f64)
                .s(if self.degenerate == 1 {
                    " degenerate triangle with repeated vertices"
                } else {
                    " degenerate triangles with repeated vertices"
                })
                .done(),
        })
    }
}
