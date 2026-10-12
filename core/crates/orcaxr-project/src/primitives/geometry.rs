//! three.js r184's generators as the browser's `primitives.ts` calls them,
//! operation for operation: every coordinate is the same double expression in
//! the same order (so signed zeros and roundings agree), stored as three's
//! `Float32BufferAttribute` stores it, and `rotateX` is `Matrix4.makeRotationX`
//! through `Vector3.applyMatrix4`, perspective divide included. Normals and
//! UVs are not built: nothing downstream of the mesh codec reads them.
use crate::js_math::{cos, sin};

/// An indexed three geometry: Float32 positions and its index buffer.
pub struct Indexed {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Indexed {
    fn with_capacity(vertices: usize, indices: usize) -> Self {
        Self {
            positions: Vec::with_capacity(vertices * 3),
            indices: Vec::with_capacity(indices),
        }
    }
    fn vertex(&mut self, x: f64, y: f64, z: f64) {
        // `new Float32BufferAttribute(vertices, 3)`: each double rounded to Float32.
        self.positions.extend([x as f32, y as f32, z as f32]);
    }
    fn vertex_count(&self) -> u32 {
        (self.positions.len() / 3) as u32
    }

    /// `BufferGeometry.rotateX(angle)`: `makeRotationX` applied to every
    /// position, each result stored back as Float32.
    pub fn rotate_x(&mut self, angle: f64) {
        let (c, s) = (cos(angle), sin(angle));
        // Column-major `elements` of `set(1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1)`.
        let e = [
            1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        for vertex in self.positions.chunks_exact_mut(3) {
            let (x, y, z) = (
                f64::from(vertex[0]),
                f64::from(vertex[1]),
                f64::from(vertex[2]),
            );
            let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            vertex[0] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) * w) as f32;
            vertex[1] = ((e[1] * x + e[5] * y + e[9] * z + e[13]) * w) as f32;
            vertex[2] = ((e[2] * x + e[6] * y + e[10] * z + e[14]) * w) as f32;
        }
    }

    /// `toNonIndexed()`: every indexed vertex written out in index order.
    pub fn to_non_indexed(&self) -> Vec<f32> {
        let mut positions = Vec::with_capacity(self.indices.len() * 3);
        for &index in &self.indices {
            let at = index as usize * 3;
            positions.extend_from_slice(&self.positions[at..at + 3]);
        }
        positions
    }
}

/// `new BoxGeometry(width, height, depth)` with one segment a side.
pub fn box_geometry(width: f64, height: f64, depth: f64) -> Indexed {
    #[derive(Clone, Copy)]
    enum Axis {
        X,
        Y,
        Z,
    }
    let mut geometry = Indexed::with_capacity(24, 36);
    let mut plane =
        |u: Axis, v: Axis, w: Axis, udir: f64, vdir: f64, width: f64, height: f64, depth: f64| {
            let (grid_x, grid_y) = (1u32, 1u32);
            let segment_width = width / f64::from(grid_x);
            let segment_height = height / f64::from(grid_y);
            let (width_half, height_half, depth_half) = (width / 2.0, height / 2.0, depth / 2.0);
            let first = geometry.vertex_count();
            for iy in 0..=grid_y {
                let y = f64::from(iy) * segment_height - height_half;
                for ix in 0..=grid_x {
                    let x = f64::from(ix) * segment_width - width_half;
                    let mut vector = [0.0f64; 3];
                    for (axis, value) in [(u, x * udir), (v, y * vdir), (w, depth_half)] {
                        vector[axis as usize] = value;
                    }
                    geometry.vertex(vector[0], vector[1], vector[2]);
                }
            }
            let row = grid_x + 1;
            for iy in 0..grid_y {
                for ix in 0..grid_x {
                    let a = first + ix + row * iy;
                    let b = first + ix + row * (iy + 1);
                    let c = first + (ix + 1) + row * (iy + 1);
                    let d = first + (ix + 1) + row * iy;
                    geometry.indices.extend([a, b, d, b, c, d]);
                }
            }
        };
    use Axis::*;
    plane(Z, Y, X, -1.0, -1.0, depth, height, width); // px
    plane(Z, Y, X, 1.0, -1.0, depth, height, -width); // nx
    plane(X, Z, Y, 1.0, 1.0, width, depth, height); // py
    plane(X, Z, Y, 1.0, -1.0, width, depth, -height); // ny
    plane(X, Y, Z, 1.0, -1.0, width, height, depth); // pz
    plane(X, Y, Z, -1.0, -1.0, width, height, -depth); // nz
    geometry
}

/// `Math.PI * 2`, three's default full turn.
const TURN: f64 = std::f64::consts::PI * 2.0;

/// `new CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)`:
/// one height segment, closed, a full turn from θ = 0. A cone is one with a
/// zero top radius (`ConeGeometry`).
pub fn cylinder(radius_top: f64, radius_bottom: f64, height: f64, radial_segments: u32) -> Indexed {
    let height_segments = 1u32;
    let (theta_start, theta_length) = (0.0f64, TURN);
    let half_height = height / 2.0;
    let mut geometry = Indexed::with_capacity(
        ((radial_segments + 1) * (height_segments + 1) + 2 * (2 * radial_segments + 1)) as usize,
        (radial_segments * 12) as usize,
    );
    // Torso.
    let slope_rows: Vec<Vec<u32>> = (0..=height_segments)
        .map(|y| {
            let v = f64::from(y) / f64::from(height_segments);
            let radius = v * (radius_bottom - radius_top) + radius_top;
            (0..=radial_segments)
                .map(|x| {
                    let u = f64::from(x) / f64::from(radial_segments);
                    let theta = u * theta_length + theta_start;
                    let (sin_theta, cos_theta) = (sin(theta), cos(theta));
                    let index = geometry.vertex_count();
                    geometry.vertex(
                        radius * sin_theta,
                        -v * height + half_height,
                        radius * cos_theta,
                    );
                    index
                })
                .collect()
        })
        .collect();
    for x in 0..radial_segments as usize {
        for y in 0..height_segments as usize {
            let a = slope_rows[y][x];
            let b = slope_rows[y + 1][x];
            let c = slope_rows[y + 1][x + 1];
            let d = slope_rows[y][x + 1];
            if radius_top > 0.0 || y != 0 {
                geometry.indices.extend([a, b, d]);
            }
            if radius_bottom > 0.0 || y != height_segments as usize - 1 {
                geometry.indices.extend([b, c, d]);
            }
        }
    }
    let mut cap = |top: bool| {
        let center_start = geometry.vertex_count();
        let radius = if top { radius_top } else { radius_bottom };
        let sign = if top { 1.0 } else { -1.0 };
        for _ in 1..=radial_segments {
            geometry.vertex(0.0, half_height * sign, 0.0);
        }
        let center_end = geometry.vertex_count();
        for x in 0..=radial_segments {
            let u = f64::from(x) / f64::from(radial_segments);
            let theta = u * theta_length + theta_start;
            let (cos_theta, sin_theta) = (cos(theta), sin(theta));
            geometry.vertex(radius * sin_theta, half_height * sign, radius * cos_theta);
        }
        for x in 0..radial_segments {
            let (c, i) = (center_start + x, center_end + x);
            if top {
                geometry.indices.extend([i, i + 1, c]);
            } else {
                geometry.indices.extend([i + 1, i, c]);
            }
        }
    };
    if radius_top > 0.0 {
        cap(true);
    }
    if radius_bottom > 0.0 {
        cap(false);
    }
    geometry
}

/// `new SphereGeometry(radius, widthSegments, heightSegments)`: the whole sphere.
pub fn sphere(radius: f64, width_segments: u32, height_segments: u32) -> Indexed {
    let width_segments = width_segments.max(3);
    let height_segments = height_segments.max(2);
    let (phi_start, phi_length) = (0.0f64, TURN);
    let (theta_start, theta_length) = (0.0f64, std::f64::consts::PI);
    let theta_end = crate::js_math::min(theta_start + theta_length, std::f64::consts::PI);
    let row = width_segments + 1;
    let mut geometry = Indexed::with_capacity(
        (row * (height_segments + 1)) as usize,
        (width_segments * height_segments * 6) as usize,
    );
    for iy in 0..=height_segments {
        let v = f64::from(iy) / f64::from(height_segments);
        for ix in 0..=width_segments {
            let u = f64::from(ix) / f64::from(width_segments);
            geometry.vertex(
                -radius * cos(phi_start + u * phi_length) * sin(theta_start + v * theta_length),
                radius * cos(theta_start + v * theta_length),
                radius * sin(phi_start + u * phi_length) * sin(theta_start + v * theta_length),
            );
        }
    }
    let at = |iy: u32, ix: u32| iy * row + ix;
    for iy in 0..height_segments {
        for ix in 0..width_segments {
            let a = at(iy, ix + 1);
            let b = at(iy, ix);
            let c = at(iy + 1, ix);
            let d = at(iy + 1, ix + 1);
            if iy != 0 || theta_start > 0.0 {
                geometry.indices.extend([a, b, d]);
            }
            if iy != height_segments - 1 || theta_end < std::f64::consts::PI {
                geometry.indices.extend([b, c, d]);
            }
        }
    }
    geometry
}

/// `new TorusGeometry(radius, tube, radialSegments, tubularSegments)`: a full ring.
pub fn torus(radius: f64, tube: f64, radial_segments: u32, tubular_segments: u32) -> Indexed {
    torus_arc(radius, tube, radial_segments, tubular_segments, TURN)
}

/// `new TorusGeometry(radius, tube, radialSegments, tubularSegments, arc)`:
/// the ring swept through `arc` radians, the tube a full turn.
pub fn torus_arc(
    radius: f64,
    tube: f64,
    radial_segments: u32,
    tubular_segments: u32,
    arc: f64,
) -> Indexed {
    let (theta_start, theta_length) = (0.0f64, TURN);
    let row = tubular_segments + 1;
    let mut geometry = Indexed::with_capacity(
        (row * (radial_segments + 1)) as usize,
        (radial_segments * tubular_segments * 6) as usize,
    );
    for j in 0..=radial_segments {
        let v = theta_start + (f64::from(j) / f64::from(radial_segments)) * theta_length;
        for i in 0..=tubular_segments {
            let u = f64::from(i) / f64::from(tubular_segments) * arc;
            geometry.vertex(
                (radius + tube * cos(v)) * cos(u),
                (radius + tube * cos(v)) * sin(u),
                tube * sin(v),
            );
        }
    }
    for j in 1..=radial_segments {
        for i in 1..=tubular_segments {
            let a = row * j + i - 1;
            let b = row * (j - 1) + i - 1;
            let c = row * (j - 1) + i;
            let d = row * j + i;
            geometry.indices.extend([a, b, d, b, c, d]);
        }
    }
    geometry
}
