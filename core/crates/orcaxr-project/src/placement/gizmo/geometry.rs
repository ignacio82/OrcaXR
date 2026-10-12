//! The handles `TransformControlsGizmo` builds (three r184): each group's
//! definitions in `setupGizmo`'s order — names in declaration order, each
//! name's entries last first — with the geometry three's generators make,
//! every coordinate stored as `Float32BufferAttribute` stores it, then baked
//! by the entry's position, XYZ Euler rotation and scale (`updateMatrix` then
//! `BufferGeometry.applyMatrix4`, rounded to Float32 again). The drag plane
//! is `PlaneGeometry(100000, 100000, 2, 2)`. Bounding spheres are three's
//! `computeBoundingSphere` over the baked Float32 positions.
use super::math::{
    IDENTITY, IDENTITY_QUATERNION, Matrix, Vec3, ZERO, add, apply, compose, distance_squared,
    from_euler, lerp, normalize, scale,
};
use crate::js_math::{self, cos, pow, sin};
use crate::primitives::geometry::{box_geometry, cylinder, sphere, torus, torus_arc};
use std::f64::consts::PI;
use std::sync::OnceLock;

/// How three draws a handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Mesh,
    /// A `Line`: its positions drawn as one strip.
    Line,
}

/// A material's colour (three's linear working space) and opacity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Material {
    pub color: Vec3,
    pub opacity: f64,
}

/// Baked geometry: Float32 positions, the index (`None` when unindexed) and
/// its bounding sphere.
#[derive(Debug, Clone)]
pub struct Shape {
    pub positions: Vec<f32>,
    pub index: Option<Vec<u32>>,
    pub kind: Kind,
    pub center: Vec3,
    pub radius: f64,
}

impl Shape {
    /// The triangle count three's raycast walks.
    pub fn triangles(&self) -> usize {
        match &self.index {
            Some(index) => index.len() / 3,
            None => self.positions.len() / 9,
        }
    }
    /// Triangle `t`'s corners as doubles.
    pub fn triangle(&self, t: usize) -> [Vec3; 3] {
        let corner = |k: usize| {
            let i = match &self.index {
                Some(index) => index[t * 3 + k] as usize,
                None => t * 3 + k,
            };
            [
                f64::from(self.positions[i * 3]),
                f64::from(self.positions[i * 3 + 1]),
                f64::from(self.positions[i * 3 + 2]),
            ]
        };
        [corner(0), corner(1), corner(2)]
    }
}

/// One handle: its name (the axis it stands for), whether it is a helper,
/// its material and its baked shape.
#[derive(Debug, Clone)]
pub struct Handle {
    pub name: &'static str,
    pub helper: bool,
    pub material: Material,
    pub shape: Shape,
}

/// Every group of every mode (`[translate, rotate, scale]`) and the plane.
#[derive(Debug)]
pub struct Groups {
    pub gizmo: [Vec<Handle>; 3],
    pub picker: [Vec<Handle>; 3],
    pub helper: [Vec<Handle>; 3],
    pub plane: Shape,
}

/// The handles, built once.
pub fn groups() -> &'static Groups {
    static GROUPS: OnceLock<Groups> = OnceLock::new();
    GROUPS.get_or_init(build)
}

// --- Geometry -------------------------------------------------------------------------------

struct Raw {
    positions: Vec<f32>,
    index: Option<Vec<u32>>,
}

impl Raw {
    /// `BufferGeometry.applyMatrix4`: each position through `Vector3.applyMatrix4`, stored as Float32.
    fn apply(mut self, e: &Matrix) -> Self {
        for vertex in self.positions.chunks_exact_mut(3) {
            let p = apply(
                &[
                    f64::from(vertex[0]),
                    f64::from(vertex[1]),
                    f64::from(vertex[2]),
                ],
                e,
            );
            vertex[0] = p[0] as f32;
            vertex[1] = p[1] as f32;
            vertex[2] = p[2] as f32;
        }
        self
    }
    /// `BufferGeometry.translate` (`Matrix4.makeTranslation`).
    fn translate(self, x: f64, y: f64, z: f64) -> Self {
        let mut e = IDENTITY;
        e[12] = x;
        e[13] = y;
        e[14] = z;
        self.apply(&e)
    }
    /// `BufferGeometry.rotateX` (`Matrix4.makeRotationX`).
    fn rotate_x(self, angle: f64) -> Self {
        let (c, s) = (cos(angle), sin(angle));
        let mut e = IDENTITY;
        e[5] = c;
        e[6] = s;
        e[9] = -s;
        e[10] = c;
        self.apply(&e)
    }
    /// `BufferGeometry.rotateY` (`Matrix4.makeRotationY`).
    fn rotate_y(self, angle: f64) -> Self {
        let (c, s) = (cos(angle), sin(angle));
        let mut e = IDENTITY;
        e[0] = c;
        e[2] = -s;
        e[8] = s;
        e[10] = c;
        self.apply(&e)
    }
}

fn indexed(geometry: crate::primitives::geometry::Indexed) -> Raw {
    Raw {
        positions: geometry.positions,
        index: Some(geometry.indices),
    }
}

fn floats(values: &[f64]) -> Vec<f32> {
    values.iter().map(|&v| v as f32).collect()
}

/// `new PolyhedronGeometry(vertices, indices, radius, detail)`: unindexed.
fn polyhedron(vertices: &[f64], indices: &[usize], radius: f64, detail: u32) -> Raw {
    let mut buffer: Vec<f64> = Vec::new();
    let vertex = |i: usize| [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
    for face in indices.chunks_exact(3) {
        let (a, b, c) = (vertex(face[0]), vertex(face[1]), vertex(face[2]));
        // `subdivideFace`.
        let cols = detail + 1;
        let mut v: Vec<Vec<Vec3>> = Vec::new();
        for i in 0..=cols {
            let alpha = f64::from(i) / f64::from(cols);
            let aj = lerp(a, c, alpha);
            let bj = lerp(b, c, alpha);
            let rows = cols - i;
            let mut row = Vec::new();
            for j in 0..=rows {
                if j == 0 && i == cols {
                    row.push(aj);
                } else {
                    row.push(lerp(aj, bj, f64::from(j) / f64::from(rows)));
                }
            }
            v.push(row);
        }
        let i_count = cols as usize;
        for i in 0..i_count {
            for j in 0..(2 * (i_count - i) - 1) {
                let k = j / 2;
                let corners = if j % 2 == 0 {
                    [v[i][k + 1], v[i + 1][k], v[i][k]]
                } else {
                    [v[i][k + 1], v[i + 1][k + 1], v[i + 1][k]]
                };
                for corner in corners {
                    buffer.extend(corner);
                }
            }
        }
    }
    // `applyRadius`: `normalize().multiplyScalar(radius)`.
    for vertex in buffer.chunks_exact_mut(3) {
        let p = scale(normalize([vertex[0], vertex[1], vertex[2]]), radius);
        vertex.copy_from_slice(&p);
    }
    Raw {
        positions: floats(&buffer),
        index: None,
    }
}

/// `new OctahedronGeometry(radius, detail)`.
fn octahedron(radius: f64, detail: u32) -> Raw {
    let vertices = [
        1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0,
    ];
    let indices = [
        0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2,
    ];
    polyhedron(&vertices, &indices, radius, detail)
}

/// `new PlaneGeometry(width, height, widthSegments, heightSegments)`.
fn plane(width: f64, height: f64, grid_x: u32, grid_y: u32) -> Raw {
    let (width_half, height_half) = (width / 2.0, height / 2.0);
    let (grid_x1, grid_y1) = (grid_x + 1, grid_y + 1);
    let segment_width = width / f64::from(grid_x);
    let segment_height = height / f64::from(grid_y);
    let mut vertices = Vec::new();
    for iy in 0..grid_y1 {
        let y = f64::from(iy) * segment_height - height_half;
        for ix in 0..grid_x1 {
            let x = f64::from(ix) * segment_width - width_half;
            vertices.extend([x, -y, 0.0]);
        }
    }
    let mut index = Vec::new();
    for iy in 0..grid_y {
        for ix in 0..grid_x {
            let a = ix + grid_x1 * iy;
            let b = ix + grid_x1 * (iy + 1);
            let c = (ix + 1) + grid_x1 * (iy + 1);
            let d = (ix + 1) + grid_x1 * iy;
            index.extend([a, b, d, b, c, d]);
        }
    }
    Raw {
        positions: floats(&vertices),
        index: Some(index),
    }
}

/// The geometries the gizmo definitions share or create.
#[derive(Clone, Copy)]
enum Base {
    /// `CylinderGeometry(0, 0.04, 0.1, 12)` translated by (0, 0.05, 0).
    Arrow,
    /// `BoxGeometry(0.08, 0.08, 0.08)` translated by (0, 0.04, 0).
    ScaleHandle,
    /// A line from the origin to (1, 0, 0).
    Line,
    /// `CylinderGeometry(0.0075, 0.0075, 0.5, 3)` translated by (0, 0.25, 0).
    Line2,
    /// `CircleGeometry(radius, arc)`: a thin torus turned onto the YZ plane.
    Circle(f64, f64),
    /// A line from the origin to (1, 1, 1).
    TranslateHelper,
    Octahedron(f64, u32),
    Box(f64, f64, f64),
    /// `CylinderGeometry(0.2, 0, 0.6, 4)`.
    Cone,
    Sphere(f64, u32, u32),
    Torus(f64, f64, u32, u32),
}

fn base(base: Base) -> (Raw, Kind) {
    let mesh = |raw| (raw, Kind::Mesh);
    match base {
        Base::Arrow => mesh(indexed(cylinder(0.0, 0.04, 0.1, 12)).translate(0.0, 0.05, 0.0)),
        Base::ScaleHandle => {
            mesh(indexed(box_geometry(0.08, 0.08, 0.08)).translate(0.0, 0.04, 0.0))
        }
        Base::Line => (
            Raw {
                positions: floats(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
                index: None,
            },
            Kind::Line,
        ),
        Base::Line2 => mesh(indexed(cylinder(0.0075, 0.0075, 0.5, 3)).translate(0.0, 0.25, 0.0)),
        Base::Circle(radius, arc) => mesh(
            indexed(torus_arc(radius, 0.0075, 3, 64, arc * PI * 2.0))
                .rotate_y(PI / 2.0)
                .rotate_x(PI / 2.0),
        ),
        Base::TranslateHelper => (
            Raw {
                positions: floats(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]),
                index: None,
            },
            Kind::Line,
        ),
        Base::Octahedron(radius, detail) => mesh(octahedron(radius, detail)),
        Base::Box(w, h, d) => mesh(indexed(box_geometry(w, h, d))),
        Base::Cone => mesh(indexed(cylinder(0.2, 0.0, 0.6, 4))),
        Base::Sphere(r, w, h) => mesh(indexed(sphere(r, w, h))),
        Base::Torus(r, t, rs, ts) => mesh(indexed(torus(r, t, rs, ts))),
    }
}

/// `BufferGeometry.computeBoundingSphere` (through `Box3.setFromBufferAttribute`).
fn bounding_sphere(positions: &[f32]) -> (Vec3, f64) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let point = |v: &[f32]| [f64::from(v[0]), f64::from(v[1]), f64::from(v[2])];
    for v in positions.chunks_exact(3) {
        for ((low, high), value) in min.iter_mut().zip(max.iter_mut()).zip(point(v)) {
            *low = js_math::min(*low, value);
            *high = js_math::max(*high, value);
        }
    }
    let empty = max[0] < min[0] || max[1] < min[1] || max[2] < min[2];
    let center = if empty {
        ZERO
    } else {
        scale(add(min, max), 0.5)
    };
    let mut max_radius_sq = 0.0;
    for v in positions.chunks_exact(3) {
        max_radius_sq = js_math::max(max_radius_sq, distance_squared(center, point(v)));
    }
    (center, max_radius_sq.sqrt())
}

fn shape(raw: Raw, kind: Kind) -> Shape {
    let (center, radius) = bounding_sphere(&raw.positions);
    Shape {
        positions: raw.positions,
        index: raw.index,
        kind,
        center,
        radius,
    }
}

/// One `[object, position, rotation, scale, tag]` definition.
struct Entry {
    base: Base,
    position: Option<Vec3>,
    rotation: Option<Vec3>,
    scale: Option<Vec3>,
}
const fn entry(base: Base, position: Option<Vec3>, rotation: Option<Vec3>) -> Entry {
    Entry {
        base,
        position,
        rotation,
        scale: None,
    }
}

/// `setupGizmo`: each name's entries, last first, baked by their pose.
fn setup(map: Vec<(&'static str, Material, bool, Vec<Entry>)>) -> Vec<Handle> {
    let mut handles = Vec::new();
    for (name, material, helper, entries) in map {
        for entry in entries.iter().rev() {
            let (raw, kind) = base(entry.base);
            let matrix = compose(
                entry.position.unwrap_or(ZERO),
                entry
                    .rotation
                    .map(from_euler)
                    .unwrap_or(IDENTITY_QUATERNION),
                entry.scale.unwrap_or([1.0, 1.0, 1.0]),
            );
            handles.push(Handle {
                name,
                helper,
                material,
                shape: shape(raw.apply(&matrix), kind),
            });
        }
    }
    handles
}

/// `ColorManagement`'s sRGB to linear transfer.
fn srgb_to_linear(c: f64) -> f64 {
    if c < 0.04045 {
        c * 0.0773993808
    } else {
        pow(c * 0.9478672986 + 0.0521327014, 2.4)
    }
}
const fn material(color: Vec3, opacity: f64) -> Material {
    Material { color, opacity }
}
const RED: Vec3 = [1.0, 0.0, 0.0];
const GREEN: Vec3 = [0.0, 1.0, 0.0];
const BLUE: Vec3 = [0.0, 0.0, 1.0];
const WHITE: Vec3 = [1.0, 1.0, 1.0];
/// `materialLib.active`'s colour: what a highlighted handle shows.
pub const YELLOW: Vec3 = [1.0, 1.0, 0.0];

fn build() -> Groups {
    let gray = srgb_to_linear(120.0 / 255.0);
    let invisible = material(WHITE, 0.15);
    let helper = material(WHITE, 0.5);
    let red = material(RED, 1.0);
    let green = material(GREEN, 1.0);
    let blue = material(BLUE, 1.0);
    let red_transparent = material(RED, 0.5);
    let green_transparent = material(GREEN, 0.5);
    let blue_transparent = material(BLUE, 0.5);
    let white_transparent = material(WHITE, 0.25);
    let yellow_transparent = material(YELLOW, 0.25);
    let gray = material([gray, gray, gray], 1.0);

    let half = PI / 2.0;
    let p = |x: f64, y: f64, z: f64| Some([x, y, z]);
    let line = |position: Vec3, rotation: Option<Vec3>| Entry {
        base: Base::Line,
        position: Some(position),
        rotation,
        scale: Some([1e6, 1.0, 1.0]),
    };
    let plain = |base: Base| entry(base, None, None);
    let cone = |position: Vec3, rotation: Option<Vec3>| entry(Base::Cone, Some(position), rotation);

    let gizmo_translate = vec![
        (
            "X",
            red,
            false,
            vec![
                entry(Base::Arrow, p(0.5, 0.0, 0.0), p(0.0, 0.0, -half)),
                entry(Base::Arrow, p(-0.5, 0.0, 0.0), p(0.0, 0.0, half)),
                entry(Base::Line2, p(0.0, 0.0, 0.0), p(0.0, 0.0, -half)),
            ],
        ),
        (
            "Y",
            green,
            false,
            vec![
                entry(Base::Arrow, p(0.0, 0.5, 0.0), None),
                entry(Base::Arrow, p(0.0, -0.5, 0.0), p(PI, 0.0, 0.0)),
                plain(Base::Line2),
            ],
        ),
        (
            "Z",
            blue,
            false,
            vec![
                entry(Base::Arrow, p(0.0, 0.0, 0.5), p(half, 0.0, 0.0)),
                entry(Base::Arrow, p(0.0, 0.0, -0.5), p(-half, 0.0, 0.0)),
                entry(Base::Line2, None, p(half, 0.0, 0.0)),
            ],
        ),
        (
            "XYZ",
            white_transparent,
            false,
            vec![entry(Base::Octahedron(0.1, 0), p(0.0, 0.0, 0.0), None)],
        ),
        (
            "XY",
            blue_transparent,
            false,
            vec![entry(Base::Box(0.15, 0.15, 0.01), p(0.15, 0.15, 0.0), None)],
        ),
        (
            "YZ",
            red_transparent,
            false,
            vec![entry(
                Base::Box(0.15, 0.15, 0.01),
                p(0.0, 0.15, 0.15),
                p(0.0, half, 0.0),
            )],
        ),
        (
            "XZ",
            green_transparent,
            false,
            vec![entry(
                Base::Box(0.15, 0.15, 0.01),
                p(0.15, 0.0, 0.15),
                p(-half, 0.0, 0.0),
            )],
        ),
    ];
    let picker_translate = vec![
        (
            "X",
            invisible,
            false,
            vec![
                cone([0.3, 0.0, 0.0], p(0.0, 0.0, -half)),
                cone([-0.3, 0.0, 0.0], p(0.0, 0.0, half)),
            ],
        ),
        (
            "Y",
            invisible,
            false,
            vec![
                cone([0.0, 0.3, 0.0], None),
                cone([0.0, -0.3, 0.0], p(0.0, 0.0, PI)),
            ],
        ),
        (
            "Z",
            invisible,
            false,
            vec![
                cone([0.0, 0.0, 0.3], p(half, 0.0, 0.0)),
                cone([0.0, 0.0, -0.3], p(-half, 0.0, 0.0)),
            ],
        ),
        (
            "XYZ",
            invisible,
            false,
            vec![plain(Base::Octahedron(0.2, 0))],
        ),
        (
            "XY",
            invisible,
            false,
            vec![entry(Base::Box(0.2, 0.2, 0.01), p(0.15, 0.15, 0.0), None)],
        ),
        (
            "YZ",
            invisible,
            false,
            vec![entry(
                Base::Box(0.2, 0.2, 0.01),
                p(0.0, 0.15, 0.15),
                p(0.0, half, 0.0),
            )],
        ),
        (
            "XZ",
            invisible,
            false,
            vec![entry(
                Base::Box(0.2, 0.2, 0.01),
                p(0.15, 0.0, 0.15),
                p(-half, 0.0, 0.0),
            )],
        ),
    ];
    let helper_translate = vec![
        (
            "START",
            helper,
            true,
            vec![plain(Base::Octahedron(0.01, 2))],
        ),
        ("END", helper, true, vec![plain(Base::Octahedron(0.01, 2))]),
        ("DELTA", helper, true, vec![plain(Base::TranslateHelper)]),
        ("X", helper, true, vec![line([-1e3, 0.0, 0.0], None)]),
        (
            "Y",
            helper,
            true,
            vec![line([0.0, -1e3, 0.0], p(0.0, 0.0, half))],
        ),
        (
            "Z",
            helper,
            true,
            vec![line([0.0, 0.0, -1e3], p(0.0, -half, 0.0))],
        ),
    ];
    let gizmo_rotate = vec![
        (
            "XYZE",
            gray,
            false,
            vec![entry(Base::Circle(0.5, 1.0), None, p(0.0, half, 0.0))],
        ),
        ("X", red, false, vec![plain(Base::Circle(0.5, 0.5))]),
        (
            "Y",
            green,
            false,
            vec![entry(Base::Circle(0.5, 0.5), None, p(0.0, 0.0, -half))],
        ),
        (
            "Z",
            blue,
            false,
            vec![entry(Base::Circle(0.5, 0.5), None, p(0.0, half, 0.0))],
        ),
        (
            "E",
            yellow_transparent,
            false,
            vec![entry(Base::Circle(0.75, 1.0), None, p(0.0, half, 0.0))],
        ),
    ];
    let helper_rotate = vec![("AXIS", helper, true, vec![line([-1e3, 0.0, 0.0], None)])];
    let ring = Base::Torus(0.5, 0.1, 4, 24);
    let picker_rotate = vec![
        (
            "XYZE",
            invisible,
            false,
            vec![plain(Base::Sphere(0.25, 10, 8))],
        ),
        (
            "X",
            invisible,
            false,
            vec![entry(ring, p(0.0, 0.0, 0.0), p(0.0, -half, -half))],
        ),
        (
            "Y",
            invisible,
            false,
            vec![entry(ring, p(0.0, 0.0, 0.0), p(half, 0.0, 0.0))],
        ),
        (
            "Z",
            invisible,
            false,
            vec![entry(ring, p(0.0, 0.0, 0.0), p(0.0, 0.0, -half))],
        ),
        (
            "E",
            invisible,
            false,
            vec![plain(Base::Torus(0.75, 0.1, 2, 24))],
        ),
    ];
    let gizmo_scale = vec![
        (
            "X",
            red,
            false,
            vec![
                entry(Base::ScaleHandle, p(0.5, 0.0, 0.0), p(0.0, 0.0, -half)),
                entry(Base::Line2, p(0.0, 0.0, 0.0), p(0.0, 0.0, -half)),
                entry(Base::ScaleHandle, p(-0.5, 0.0, 0.0), p(0.0, 0.0, half)),
            ],
        ),
        (
            "Y",
            green,
            false,
            vec![
                entry(Base::ScaleHandle, p(0.0, 0.5, 0.0), None),
                plain(Base::Line2),
                entry(Base::ScaleHandle, p(0.0, -0.5, 0.0), p(0.0, 0.0, PI)),
            ],
        ),
        (
            "Z",
            blue,
            false,
            vec![
                entry(Base::ScaleHandle, p(0.0, 0.0, 0.5), p(half, 0.0, 0.0)),
                entry(Base::Line2, p(0.0, 0.0, 0.0), p(half, 0.0, 0.0)),
                entry(Base::ScaleHandle, p(0.0, 0.0, -0.5), p(-half, 0.0, 0.0)),
            ],
        ),
        (
            "XY",
            blue_transparent,
            false,
            vec![entry(Base::Box(0.15, 0.15, 0.01), p(0.15, 0.15, 0.0), None)],
        ),
        (
            "YZ",
            red_transparent,
            false,
            vec![entry(
                Base::Box(0.15, 0.15, 0.01),
                p(0.0, 0.15, 0.15),
                p(0.0, half, 0.0),
            )],
        ),
        (
            "XZ",
            green_transparent,
            false,
            vec![entry(
                Base::Box(0.15, 0.15, 0.01),
                p(0.15, 0.0, 0.15),
                p(-half, 0.0, 0.0),
            )],
        ),
        (
            "XYZ",
            white_transparent,
            false,
            vec![plain(Base::Box(0.1, 0.1, 0.1))],
        ),
    ];
    let picker_scale = vec![
        (
            "X",
            invisible,
            false,
            vec![
                cone([0.3, 0.0, 0.0], p(0.0, 0.0, -half)),
                cone([-0.3, 0.0, 0.0], p(0.0, 0.0, half)),
            ],
        ),
        (
            "Y",
            invisible,
            false,
            vec![
                cone([0.0, 0.3, 0.0], None),
                cone([0.0, -0.3, 0.0], p(0.0, 0.0, PI)),
            ],
        ),
        (
            "Z",
            invisible,
            false,
            vec![
                cone([0.0, 0.0, 0.3], p(half, 0.0, 0.0)),
                cone([0.0, 0.0, -0.3], p(-half, 0.0, 0.0)),
            ],
        ),
        (
            "XY",
            invisible,
            false,
            vec![entry(Base::Box(0.2, 0.2, 0.01), p(0.15, 0.15, 0.0), None)],
        ),
        (
            "YZ",
            invisible,
            false,
            vec![entry(
                Base::Box(0.2, 0.2, 0.01),
                p(0.0, 0.15, 0.15),
                p(0.0, half, 0.0),
            )],
        ),
        (
            "XZ",
            invisible,
            false,
            vec![entry(
                Base::Box(0.2, 0.2, 0.01),
                p(0.15, 0.0, 0.15),
                p(-half, 0.0, 0.0),
            )],
        ),
        (
            "XYZ",
            invisible,
            false,
            vec![entry(Base::Box(0.2, 0.2, 0.2), p(0.0, 0.0, 0.0), None)],
        ),
    ];
    let helper_scale = vec![
        ("X", helper, true, vec![line([-1e3, 0.0, 0.0], None)]),
        (
            "Y",
            helper,
            true,
            vec![line([0.0, -1e3, 0.0], p(0.0, 0.0, half))],
        ),
        (
            "Z",
            helper,
            true,
            vec![line([0.0, 0.0, -1e3], p(0.0, -half, 0.0))],
        ),
    ];
    Groups {
        gizmo: [
            setup(gizmo_translate),
            setup(gizmo_rotate),
            setup(gizmo_scale),
        ],
        picker: [
            setup(picker_translate),
            setup(picker_rotate),
            setup(picker_scale),
        ],
        helper: [
            setup(helper_translate),
            setup(helper_rotate),
            setup(helper_scale),
        ],
        plane: shape(plane(100000.0, 100000.0, 2, 2), Kind::Mesh),
    }
}
