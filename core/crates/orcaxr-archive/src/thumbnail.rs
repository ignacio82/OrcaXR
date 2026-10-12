//! A plate's picture for the G-code's thumbnail block, rendered from the
//! captured project — the browser's `PlateThumbnailRenderer` done in
//! software, so a host without a GPU surface (the Android app's slicing
//! area, its engine's own process) draws it from the very capture the slice
//! archive is written from.
//!
//! What is drawn and how is the browser's: every model part of the plate's
//! printable instances (modifiers, negative volumes and support painters
//! print nothing of their own), each in its filament's colour (the volume's
//! display colour, else the workspace's neutral grey), framed by the shared
//! three-quarter camera ([`frame`]) around the parts' bounds as three.js
//! takes them (each part's local box, transformed), lit by the viewport's
//! hemisphere and key lights through three.js's physically based standard
//! material (roughness 0.72, metalness 0.04), back faces culled, on a
//! transparent background, stored as sRGB. A GPU's pixels are its own, so a
//! picture is like the browser's rather than identical to it; every host
//! running this core writes the same bytes, since all of its arithmetic is
//! IEEE and its trigonometry and powers are the core's own.
use crate::image::{self, Rgba};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::AssetLease,
    export::ExportCapture,
    ids::{AssetId, PlateId},
    js_math,
    mesh::decode_indexed,
    mesh_packet::vertex_normals,
    model::{ProjectState, Transform, VolumeRole},
    render::volume_display_color,
    slicing::thumbnails::{self, FOV_DEG, Format, List, Request, frame},
};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::Arc;

/// The JPEG quality a canvas encodes at by default (`toBlob`'s 0.92).
pub const JPEG_QUALITY: u32 = 92;
/// The workspace's neutral grey for a part no filament colours (`0xb8bec8`).
const NEUTRAL: [u8; 3] = [0xb8, 0xbe, 0xc8];

/// Why a picture could not be drawn: a drawn part's mesh is missing or malformed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    MissingAsset,
    Mesh(String),
}
impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingAsset => "thumbnail_missing_asset",
            Self::Mesh(_) => "thumbnail_invalid_mesh",
        }
    }
}

/// A rendered picture: its file, and how many of its pixels show a model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picture {
    pub image: Vec<u8>,
    pub coverage: u64,
}

/// One mesh, decoded once for every part that places it.
struct Mesh {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    indices: Vec<u32>,
    min: [f64; 3],
    max: [f64; 3],
}

/// A column-major affine transform's upper 3 × 3 and translation.
#[derive(Clone, Copy)]
struct Affine {
    m: [[f64; 3]; 3],
    t: [f64; 3],
}
impl Affine {
    /// `Matrix4.compose` of a canonical transform (its quaternion normalized, as the scene's is).
    fn of(transform: &Transform) -> Self {
        let q = transform.rotation.map(|n| n.get());
        let length = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        let [x, y, z, w] = if length == 0.0 || !length.is_finite() {
            [0.0, 0.0, 0.0, 1.0]
        } else {
            q.map(|v| v / length)
        };
        let s = transform.scale.map(|n| n.get());
        let (x2, y2, z2) = (x + x, y + y, z + z);
        let (xx, xy, xz) = (x * x2, x * y2, x * z2);
        let (yy, yz, zz) = (y * y2, y * z2, z * z2);
        let (wx, wy, wz) = (w * x2, w * y2, w * z2);
        // m[column][row]
        Self {
            m: [
                [(1.0 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0]],
                [(xy - wz) * s[1], (1.0 - (xx + zz)) * s[1], (yz + wx) * s[1]],
                [(xz + wy) * s[2], (yz - wx) * s[2], (1.0 - (xx + yy)) * s[2]],
            ],
            t: transform.translation_mm.map(|n| n.get()),
        }
    }
    /// `self × other`: `other` applied first.
    fn then_after(&self, other: &Affine) -> Affine {
        let mut m = [[0.0; 3]; 3];
        for (column, out) in m.iter_mut().enumerate() {
            *out = self.apply_vector(other.m[column]);
        }
        Affine {
            m,
            t: self.apply(other.t),
        }
    }
    fn apply_vector(&self, v: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|row| {
            self.m[0][row] * v[0] + self.m[1][row] * v[1] + self.m[2][row] * v[2]
        })
    }
    fn apply(&self, v: [f64; 3]) -> [f64; 3] {
        let r = self.apply_vector(v);
        [r[0] + self.t[0], r[1] + self.t[1], r[2] + self.t[2]]
    }
    fn determinant(&self) -> f64 {
        let m = &self.m;
        m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2])
            - m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2])
            + m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2])
    }
    /// The inverse transpose of the 3 × 3, which carries normals, up to a
    /// positive scale (normals are normalized after): its cofactors, turned
    /// round when the determinant is negative.
    fn normal_matrix(&self) -> [[f64; 3]; 3] {
        let a = |r: usize, c: usize| self.m[c][r];
        let others = |i: usize| match i {
            0 => (1, 2),
            1 => (0, 2),
            _ => (0, 1),
        };
        let sign = if self.determinant() < 0.0 { -1.0 } else { 1.0 };
        std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                let (r0, r1) = others(i);
                let (c0, c1) = others(j);
                let minor = a(r0, c0) * a(r1, c1) - a(r0, c1) * a(r1, c0);
                let parity = if (i + j) % 2 == 0 { 1.0 } else { -1.0 };
                sign * parity * minor
            })
        })
    }
}

/// A vertex as drawn: where it lands on screen, its depth, its world position and its normal.
type Projected = ([f64; 2], f64, [f64; 3], [f64; 3]);

/// One drawn part: its mesh where its instance places it, and its colour (linear).
struct Draw {
    mesh: Arc<Mesh>,
    world: Affine,
    normal: [[f64; 3]; 3],
    mirrored: bool,
    colour: [f64; 3],
}

/// What one plate draws, decoded once for each size asked.
pub struct Scene {
    draws: Vec<Draw>,
    /// The parts' bounds in three.js axes (Y up): each part's local box, transformed.
    min: [f64; 3],
    max: [f64; 3],
}

/// `SRGBToLinear`.
fn linear(byte: u8) -> f64 {
    let c = f64::from(byte) / 255.0;
    if c < 0.04045 {
        c * 0.077_399_380_8
    } else {
        js_math::pow(c * 0.947_867_298_6 + 0.052_132_701_4, 2.4)
    }
}
/// What an sRGB render target stores of a linear value.
fn encoded(value: f64) -> u8 {
    let c = value.clamp(0.0, 1.0);
    let s = if c < 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * js_math::pow(c, 1.0 / 2.4) - 0.055
    };
    (s * 255.0).round() as u8
}

/// `new THREE.Color(style)` for the hex a filament carries: `#rgb` or
/// `#rrggbb`; anything else leaves the colour white, as three.js does.
fn colour(style: Option<&[u16]>) -> [u8; 3] {
    let Some(style) = style.filter(|style| !style.is_empty()) else {
        return NEUTRAL;
    };
    let hex: Option<Vec<u8>> = style.strip_prefix(&[u16::from(b'#')]).and_then(|digits| {
        digits
            .iter()
            .map(|&u| char::from_u32(u32::from(u))?.to_digit(16).map(|d| d as u8))
            .collect()
    });
    match hex.as_deref() {
        Some(&[r, g, b]) => [r * 17, g * 17, b * 17],
        Some(&[r1, r0, g1, g0, b1, b0]) => [r1 << 4 | r0, g1 << 4 | g0, b1 << 4 | b0],
        _ => [255, 255, 255],
    }
}

impl Scene {
    /// The parts plate `plate_id` prints, or none when it draws nothing.
    pub fn of(
        state: &ProjectState,
        plate_id: &PlateId,
        asset: impl Fn(&AssetId) -> Option<AssetLease>,
    ) -> Result<Option<Self>, Error> {
        let Some(plate) = state.plates.iter().find(|plate| plate.id == *plate_id) else {
            return Ok(None);
        };
        let mut meshes: BTreeMap<AssetId, Arc<Mesh>> = BTreeMap::new();
        let mut draws = Vec::new();
        if plate.printable {
            for object in plate.objects.iter() {
                for instance in object.instances.iter().filter(|i| i.printable) {
                    let placed = Affine::of(&instance.transform);
                    for volume in object.volumes.iter() {
                        if volume.role != VolumeRole::Model {
                            continue;
                        }
                        let id = &volume.source.asset_id;
                        let mesh = match meshes.get(id) {
                            Some(mesh) => mesh.clone(),
                            None => {
                                let lease = asset(id).ok_or(Error::MissingAsset)?;
                                let mesh = Arc::new(decode(&lease)?);
                                meshes.insert(id.clone(), mesh.clone());
                                mesh
                            }
                        };
                        let world = placed.then_after(&Affine::of(&volume.transform));
                        let srgb = colour(volume_display_color(state, object, volume));
                        draws.push(Draw {
                            mesh,
                            normal: world.normal_matrix(),
                            mirrored: world.determinant() < 0.0,
                            world,
                            colour: srgb.map(linear),
                        });
                    }
                }
            }
        }
        // `Box3.expandByObject`: each part's local box, its eight corners transformed.
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for draw in &draws {
            if draw.mesh.positions.is_empty() {
                continue;
            }
            for corner in 0..8 {
                let local: [f64; 3] = std::array::from_fn(|axis| {
                    if corner >> axis & 1 == 0 {
                        draw.mesh.min[axis]
                    } else {
                        draw.mesh.max[axis]
                    }
                });
                let [x, y, z] = draw.world.apply(local);
                // Printer millimetres (Z up) into three.js axes (Y up, Z toward the front).
                for (axis, value) in [x, z, -y].into_iter().enumerate() {
                    min[axis] = js_math::min(min[axis], value);
                    max[axis] = js_math::max(max[axis], value);
                }
            }
        }
        if draws.is_empty()
            || (0..3).any(|axis| {
                !matches!(
                    max[axis].partial_cmp(&min[axis]),
                    Some(Ordering::Greater | Ordering::Equal)
                )
            })
        {
            return Ok(None);
        }
        Ok(Some(Self { draws, min, max }))
    }

    /// The picture at `request`'s size, in its format.
    pub fn render(&self, request: Request) -> Picture {
        let (rgba, coverage) = self.rasterize(request.width, request.height);
        let image = match request.format {
            Format::Png => image::png(&rgba),
            Format::Jpg => image::jpeg(&rgba, JPEG_QUALITY),
        };
        Picture { image, coverage }
    }

    /// The plate drawn into a `width` × `height` RGBA image.
    pub fn rasterize(&self, width: u32, height: u32) -> (Rgba, u64) {
        let (w, h) = (width as usize, height as usize);
        let aspect = f64::from(width) / f64::from(height);
        let view = frame(self.min, self.max, aspect);
        // Back from three.js axes to printer millimetres.
        let printer = |[x, y, z]: [f64; 3]| [x, -z, y];
        let eye = printer(view.position);
        let target = printer(view.target);
        // `Matrix4.lookAt` with three.js's up (+Y, the printer's +Z).
        let back = normalize(sub(eye, target));
        let right = normalize(cross([0.0, 0.0, 1.0], back));
        let up = cross(back, right);
        let focal = 1.0 / js_math::tan(FOV_DEG * (PI / 180.0) / 2.0);
        let light = normalize([0.5, -0.5, 2.0]);
        let mut depth = vec![f64::INFINITY; w * h];
        let mut colour = vec![[0f64; 3]; w * h];
        let mut covered = vec![false; w * h];
        for draw in &self.draws {
            let mesh = &draw.mesh;
            // Each vertex once: where it lands on screen, its depth, its world position and normal.
            let projected: Vec<Projected> = mesh
                .positions
                .iter()
                .zip(&mesh.normals)
                .map(|(position, normal)| {
                    let world = draw.world.apply(position.map(f64::from));
                    let v = sub(world, eye);
                    let z = -dot(v, back);
                    let x = dot(v, right) / z * focal / aspect;
                    let y = dot(v, up) / z * focal;
                    let n = normal.map(f64::from);
                    let carried = std::array::from_fn(|row| {
                        draw.normal[row][0] * n[0]
                            + draw.normal[row][1] * n[1]
                            + draw.normal[row][2] * n[2]
                    });
                    (
                        [(x + 1.0) * 0.5 * w as f64, (1.0 - y) * 0.5 * h as f64],
                        z,
                        world,
                        carried,
                    )
                })
                .collect();
            for triangle in mesh.indices.chunks_exact(3) {
                let [a, b, c] = [0, 1, 2].map(|i| &projected[triangle[i] as usize]);
                // Everything framed is in front of the camera; anything else is not drawn.
                if !(a.1 > 0.0 && b.1 > 0.0 && c.1 > 0.0) {
                    continue;
                }
                let area = edge(a.0, b.0, c.0);
                // Counter-clockwise in GL's upward NDC is clockwise on this downward screen:
                // a front face (flipped for a mirrored part, as three.js flips its winding).
                let front = if draw.mirrored {
                    area > 0.0
                } else {
                    area < 0.0
                };
                if !front || area == 0.0 {
                    continue;
                }
                let xs = [a.0[0], b.0[0], c.0[0]];
                let ys = [a.0[1], b.0[1], c.0[1]];
                let x0 = (xs.iter().copied().fold(f64::INFINITY, f64::min) - 0.5)
                    .ceil()
                    .max(0.0) as usize;
                let x1 = (xs.iter().copied().fold(f64::NEG_INFINITY, f64::max) - 0.5).floor();
                let y0 = (ys.iter().copied().fold(f64::INFINITY, f64::min) - 0.5)
                    .ceil()
                    .max(0.0) as usize;
                let y1 = (ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) - 0.5).floor();
                if x1 < 0.0 || y1 < 0.0 {
                    continue;
                }
                let x1 = (x1 as usize).min(w - 1);
                let y1 = (y1 as usize).min(h - 1);
                for py in y0..=y1 {
                    for px in x0..=x1 {
                        let p = [px as f64 + 0.5, py as f64 + 0.5];
                        let weights = [edge(b.0, c.0, p), edge(c.0, a.0, p), edge(a.0, b.0, p)];
                        let inside = if area < 0.0 {
                            weights.iter().all(|&e| e <= 0.0)
                        } else {
                            weights.iter().all(|&e| e >= 0.0)
                        };
                        if !inside {
                            continue;
                        }
                        // Perspective-correct: weights over each vertex's depth.
                        let over = [
                            weights[0] / area / a.1,
                            weights[1] / area / b.1,
                            weights[2] / area / c.1,
                        ];
                        let inverse = over[0] + over[1] + over[2];
                        let z = 1.0 / inverse;
                        let at = py * w + px;
                        if z.partial_cmp(&depth[at]) != Some(Ordering::Less) {
                            continue;
                        }
                        depth[at] = z;
                        covered[at] = true;
                        let mix = |va: [f64; 3], vb: [f64; 3], vc: [f64; 3]| {
                            std::array::from_fn(|i| {
                                (va[i] * over[0] + vb[i] * over[1] + vc[i] * over[2]) * z
                            })
                        };
                        let position = mix(a.2, b.2, c.2);
                        let normal = normalize(mix(a.3, b.3, c.3));
                        colour[at] =
                            shade(draw.colour, normal, normalize(sub(eye, position)), light);
                    }
                }
            }
        }
        let mut pixels = vec![0u8; w * h * 4];
        let mut coverage = 0;
        for (at, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            if covered[at] {
                coverage += 1;
                pixel[..3].copy_from_slice(&colour[at].map(encoded));
                pixel[3] = 255;
            }
        }
        (
            Rgba {
                width,
                height,
                pixels,
            },
            coverage,
        )
    }
}

fn decode(lease: &AssetLease) -> Result<Mesh, Error> {
    let mesh = decode_indexed(lease).map_err(Error::Mesh)?;
    let positions: Vec<[f32; 3]> = mesh.positions.iter().map(|p| p.map(|v| v as f32)).collect();
    let normals = vertex_normals(&positions, &mesh.indices);
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for position in &positions {
        for axis in 0..3 {
            let value = f64::from(position[axis]);
            min[axis] = js_math::min(min[axis], value);
            max[axis] = js_math::max(max[axis], value);
        }
    }
    Ok(Mesh {
        positions,
        normals,
        indices: mesh.indices,
        min,
        max,
    })
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn normalize(v: [f64; 3]) -> [f64; 3] {
    let length = dot(v, v).sqrt();
    if length == 0.0 || !length.is_finite() {
        v
    } else {
        v.map(|c| c / length)
    }
}
/// Twice the signed area of `a b p`.
fn edge(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// The viewport's lights on three.js's standard material (roughness 0.72,
/// metalness 0.04): the hemisphere light (sky `0xbbbbbb`, ground `0x888888`,
/// intensity 3) as indirect diffuse, and the white key light (intensity 2)
/// from `(0.5, 2, 0.5)` as direct diffuse and GGX specular. Linear light.
fn shade(albedo: [f64; 3], normal: [f64; 3], view: [f64; 3], light: [f64; 3]) -> [f64; 3] {
    const METALNESS: f64 = 0.04;
    const ROUGHNESS: f64 = 0.72;
    let sky = linear(0xbb) * 3.0;
    let ground = linear(0x88) * 3.0;
    let weight = 0.5 * normal[2] + 0.5;
    let hemisphere = ground + (sky - ground) * weight;
    let dot_nl = dot(normal, light).clamp(0.0, 1.0);
    let irradiance = dot_nl * 2.0;
    // BRDF_GGX.
    let alpha = ROUGHNESS * ROUGHNESS;
    let half = normalize([light[0] + view[0], light[1] + view[1], light[2] + view[2]]);
    let dot_nv = dot(normal, view).clamp(0.0, 1.0);
    let dot_nh = dot(normal, half).clamp(0.0, 1.0);
    let dot_vh = dot(view, half).clamp(0.0, 1.0);
    let a2 = alpha * alpha;
    let gv = dot_nl * (a2 + (1.0 - a2) * dot_nv * dot_nv).sqrt();
    let gl = dot_nv * (a2 + (1.0 - a2) * dot_nl * dot_nl).sqrt();
    let visibility = 0.5 / (gv + gl).max(1e-6);
    let denominator = dot_nh * dot_nh * (a2 - 1.0) + 1.0;
    let distribution = a2 / (PI * denominator * denominator);
    let fresnel = js_math::pow(2.0, (-5.554_73 * dot_vh - 6.983_16) * dot_vh);
    std::array::from_fn(|channel| {
        let diffuse = albedo[channel] * (1.0 - METALNESS);
        let f0 = 0.04 + (albedo[channel] - 0.04) * METALNESS;
        let f = f0 * (1.0 - fresnel) + fresnel;
        hemisphere * diffuse / PI
            + irradiance * diffuse / PI
            + irradiance * f * visibility * distribution
    })
}

/// A capture's pictures: what its project's `thumbnails` value asks for, and
/// each size drawn from its active plate (a one-plate slice capture's only
/// plate) — none for a size when the plate draws nothing.
pub struct Rendered {
    pub list: List,
    pub pictures: Vec<(Request, Picture)>,
}

/// [`Rendered`] of an export capture.
pub fn capture(capture: &ExportCapture) -> Result<Rendered, Error> {
    let state = capture.project().state();
    let list = thumbnails::state_list(state);
    let mut pictures = Vec::new();
    if !list.requests.is_empty()
        && let Some(scene) = Scene::of(state, &state.active_plate_id, |id| capture.asset_by_id(id))?
    {
        for &request in &list.requests {
            let picture = scene.render(request);
            if picture.coverage > 0 {
                pictures.push((request, picture));
            }
        }
    }
    Ok(Rendered { list, pictures })
}

/// [`capture`] as canonical JSON: `{"problems", "thumbnails": [{"block",
/// "coverage", "format", "height", "width"}]}`, each block in the engine's
/// wire format ([`thumbnails::block`]).
pub fn capture_json(capture: &ExportCapture) -> Result<String, Error> {
    let rendered = self::capture(capture)?;
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    let listed = thumbnails::list_value(&rendered.list);
    let Value::Object(mut fields) = listed else {
        unreachable!("a list is an object")
    };
    fields.remove(&units("requests"));
    let pictures = rendered
        .pictures
        .iter()
        .map(|(request, picture)| {
            let Value::Object(mut entry) = thumbnails::request_value(*request) else {
                unreachable!("a request is an object")
            };
            entry.insert(
                units("block"),
                Value::String(units(&thumbnails::block(*request, &picture.image))),
            );
            entry.insert(units("coverage"), Value::Number(picture.coverage as f64));
            Value::Object(entry)
        })
        .collect();
    fields.insert(units("thumbnails"), Value::Array(pictures));
    let mut bytes = Vec::new();
    Value::Object(fields)
        .write_canonical(&mut bytes)
        .expect("a rendering is finite JSON");
    Ok(String::from_utf8(bytes).expect("canonical JSON is UTF-8"))
}
