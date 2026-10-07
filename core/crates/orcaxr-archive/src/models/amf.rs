//! AMF (ISO/ASTM 52915) meshes, materials and constellation instances. Slic3r/
//! Orca `slic3r.modifier` volume metadata selects modifier roles; every other
//! metadata field is reported as dropped rather than silently ignored.
use super::{
    Cancel, Decoded, Format, IDENTITY, Limits, Malformed, Notice, NoticeKind, Object, Result, Role,
    Transform, Volume, malformed,
    mesh::Builder,
    text::{
        Message, bounded_name, decode_utf8, default_object_name, hex_channel, number, parse_int10,
        trim_utf16, units,
    },
    xml::{self, Element, Handler},
};
use std::collections::{BTreeSet, HashMap, HashSet};

/// AMF units plus the aliases the pinned engine tolerates.
pub(crate) const UNITS: [(&str, f64); 16] = [
    ("millimeter", 1.0),
    ("millimetre", 1.0),
    ("mm", 1.0),
    ("micron", 0.001),
    ("micrometer", 0.001),
    ("meter", 1000.0),
    ("metre", 1000.0),
    ("m", 1000.0),
    ("centimeter", 10.0),
    ("centimetre", 10.0),
    ("cm", 10.0),
    ("inch", 25.4),
    ("in", 25.4),
    ("feet", 304.8),
    ("foot", 304.8),
    ("ft", 304.8),
];

struct AmfVolume {
    name: Option<Vec<u16>>,
    material: Option<Vec<u16>>,
    role: Role,
    triangles: Vec<u32>,
}
struct AmfObject {
    id: Vec<u16>,
    name: Option<Vec<u16>>,
    vertices: Vec<f64>,
    volumes: Vec<AmfVolume>,
}
struct AmfInstance {
    object: Vec<u16>,
    translation: [f64; 3],
    rotation_deg: [f64; 3],
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Owner {
    Amf,
    Object,
    Volume,
    Material,
    Instance,
}

struct State<'a, 'b> {
    limits: &'a Limits,
    cancel: &'a mut Cancel<'b>,
    unit: String,
    objects: Vec<AmfObject>,
    ids: HashSet<Vec<u16>>,
    colors: HashMap<Vec<u16>, String>,
    material_names: HashMap<Vec<u16>, Vec<u16>>,
    instances: Vec<AmfInstance>,
    /// The browser holds references: a nested `<object>` does not move an
    /// already open volume.
    object: Option<usize>,
    volume: Option<(usize, usize)>,
    material: Option<Vec<u16>>,
    instance: bool,
    vertex: [Option<f64>; 3],
    triangle: [Option<f64>; 3],
    color: HashMap<&'static str, f64>,
    metadata_type: Option<Vec<u16>>,
    metadata_owner: Option<Owner>,
    in_coordinates: bool,
    in_color: bool,
    dropped: BTreeSet<Vec<u16>>,
}
fn fail(reason: Malformed) -> super::Error {
    malformed(reason, Format::Amf)
}
fn attribute(element: &Element, name: &str) -> Option<Vec<u16>> {
    element.attributes.get(name).map(|v| trim_utf16(v).to_vec())
}

impl Handler for State<'_, '_> {
    fn open(&mut self, element: &Element) -> Result<()> {
        self.cancel.tick()?;
        match element.local.as_str() {
            "amf" => {
                let declared = element.attributes.get("unit").map_or_else(
                    || units("millimeter"),
                    |v| super::text::lower(trim_utf16(v)),
                );
                let declared = String::from_utf16(&declared).ok();
                match declared.filter(|d| UNITS.iter().any(|(u, _)| u == d)) {
                    Some(unit) => self.unit = unit,
                    None => return Err(fail(Malformed::InvalidSyntax)),
                }
            }
            "object" => {
                if self.objects.len() + 1 > self.limits.max_objects {
                    return Err(fail(Malformed::LimitExceeded));
                }
                let id = attribute(element, "id").filter(|id| !id.is_empty());
                let id = id.ok_or_else(|| fail(Malformed::InvalidSyntax))?;
                if !self.ids.insert(id.clone()) {
                    return Err(fail(Malformed::InvalidSyntax));
                }
                self.objects.push(AmfObject {
                    id,
                    name: None,
                    vertices: Vec::new(),
                    volumes: Vec::new(),
                });
                self.object = Some(self.objects.len() - 1);
            }
            "volume" => {
                let index = self.object.ok_or_else(|| fail(Malformed::InvalidSyntax))?;
                let max = self.limits.max_volumes_per_object;
                let object = &mut self.objects[index];
                if object.volumes.len() + 1 > max {
                    return Err(fail(Malformed::LimitExceeded));
                }
                object.volumes.push(AmfVolume {
                    name: None,
                    material: attribute(element, "materialid").filter(|m| !m.is_empty()),
                    role: Role::Model,
                    triangles: Vec::new(),
                });
                self.volume = Some((index, object.volumes.len() - 1));
            }
            "coordinates" => {
                self.in_coordinates = true;
                self.vertex = [None; 3];
            }
            "triangle" => self.triangle = [None; 3],
            "material" => {
                self.material = attribute(element, "id").filter(|m| !m.is_empty());
                if self.material.is_none() {
                    return Err(fail(Malformed::InvalidSyntax));
                }
            }
            "color" => {
                self.in_color = true;
                self.color.clear();
            }
            "instance" => {
                let object = attribute(element, "objectid").filter(|o| !o.is_empty());
                let object = object.ok_or_else(|| fail(Malformed::InvalidSyntax))?;
                self.instances.push(AmfInstance {
                    object,
                    translation: [0.0; 3],
                    rotation_deg: [0.0; 3],
                });
                self.instance = true;
                if self.instances.len()
                    > self
                        .limits
                        .max_objects
                        .saturating_mul(self.limits.max_instances_per_object)
                {
                    return Err(fail(Malformed::LimitExceeded));
                }
            }
            "metadata" => {
                self.metadata_type = attribute(element, "type");
                self.metadata_owner = Some(if self.instance {
                    Owner::Instance
                } else if self.volume.is_some() {
                    Owner::Volume
                } else if self.object.is_some() {
                    Owner::Object
                } else if self.material.is_some() {
                    Owner::Material
                } else {
                    Owner::Amf
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn text(&mut self, raw: &[u16], parent: &str) -> Result<()> {
        let value = trim_utf16(raw);
        if value.is_empty() {
            return Ok(());
        }
        let number = || number(&String::from_utf16_lossy(value));
        match parent {
            "x" | "y" | "z" if self.in_coordinates => {
                self.vertex[usize::from(parent.as_bytes()[0] - b'x')] = Some(number());
            }
            "v1" | "v2" | "v3" => {
                let index = usize::from(parent.as_bytes()[1] - b'1');
                self.triangle[index] = Some(parse_int10(&String::from_utf16_lossy(value)));
            }
            "r" | "g" | "b" | "a" if self.in_color => {
                let key = match parent {
                    "r" => "r",
                    "g" => "g",
                    "b" => "b",
                    _ => "a",
                };
                self.color.insert(key, number());
            }
            "deltax" | "deltay" | "deltaz" if self.instance => {
                let i = usize::from(parent.as_bytes()[5] - b'x');
                self.instances
                    .last_mut()
                    .expect("open instance")
                    .translation[i] = number();
            }
            "rx" | "ry" | "rz" if self.instance => {
                let i = usize::from(parent.as_bytes()[1] - b'x');
                self.instances
                    .last_mut()
                    .expect("open instance")
                    .rotation_deg[i] = number();
            }
            "metadata" => {
                let Some(kind) = self.metadata_type.clone().filter(|t| !t.is_empty()) else {
                    return Ok(());
                };
                let lowered = super::text::lower(&kind);
                if lowered == units("name") {
                    match self.metadata_owner {
                        Some(Owner::Volume) if self.volume.is_some() => {
                            self.current_volume().expect("open volume").name = Some(value.to_vec());
                        }
                        Some(Owner::Object) if self.object.is_some() => {
                            self.current_object().expect("open object").name = Some(value.to_vec());
                        }
                        Some(Owner::Material) => {
                            if let Some(material) = &self.material {
                                self.material_names.insert(material.clone(), value.to_vec());
                            }
                        }
                        _ => {}
                    }
                } else if lowered == units("slic3r.modifier") && self.volume.is_some() {
                    self.current_volume().expect("open volume").role = if value == units("0") {
                        Role::Model
                    } else {
                        Role::ParameterModifier
                    };
                } else {
                    let owner = match self.metadata_owner.unwrap_or(Owner::Amf) {
                        Owner::Amf => "amf",
                        Owner::Object => "object",
                        Owner::Volume => "volume",
                        Owner::Material => "material",
                        Owner::Instance => "instance",
                    };
                    self.dropped
                        .insert(Message::new(owner).s(":").u(&kind).done());
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, local: &str) -> Result<()> {
        match local {
            "coordinates" => {
                self.in_coordinates = false;
                let vertex = self.vertex;
                let max = self.limits.max_vertices;
                let object = self
                    .current_object()
                    .ok_or_else(|| fail(Malformed::InvalidSyntax))?;
                let [Some(x), Some(y), Some(z)] = vertex else {
                    return Err(fail(Malformed::InvalidSyntax));
                };
                if !(x.is_finite() && y.is_finite() && z.is_finite()) {
                    return Err(fail(Malformed::InvalidGeometry));
                }
                if object.vertices.len() / 3 + 1 > max {
                    return Err(fail(Malformed::LimitExceeded));
                }
                object.vertices.extend_from_slice(&[x, y, z]);
            }
            "triangle" => {
                let triangle = self.triangle;
                let max = self.limits.max_triangles;
                let volume = self
                    .current_volume()
                    .ok_or_else(|| fail(Malformed::InvalidSyntax))?;
                let [Some(a), Some(b), Some(c)] = triangle else {
                    return Err(fail(Malformed::InvalidSyntax));
                };
                if [a, b, c]
                    .iter()
                    .any(|v| !(v.is_finite() && v.fract() == 0.0 && *v >= 0.0))
                {
                    return Err(fail(Malformed::InvalidGeometry));
                }
                if volume.triangles.len() / 3 + 1 > max {
                    return Err(fail(Malformed::LimitExceeded));
                }
                // Indices beyond u32 are rejected later as out of range.
                let clamp = |v: f64| v.min(f64::from(u32::MAX)) as u32;
                volume
                    .triangles
                    .extend_from_slice(&[clamp(a), clamp(b), clamp(c)]);
            }
            "color" => {
                self.in_color = false;
                if let (Some(material), None) = (&self.material, self.volume) {
                    let channel = |key| {
                        hex_channel(
                            self.color
                                .get(key)
                                .copied()
                                .filter(|v| v.is_finite())
                                .unwrap_or(0.0),
                        )
                    };
                    let hex = format!("#{}{}{}", channel("r"), channel("g"), channel("b"));
                    self.colors.insert(material.clone(), hex);
                }
            }
            "volume" => self.volume = None,
            "object" => self.object = None,
            "material" => self.material = None,
            "instance" => self.instance = false,
            "metadata" => {
                self.metadata_type = None;
                self.metadata_owner = None;
            }
            _ => {}
        }
        Ok(())
    }
}
impl State<'_, '_> {
    fn current_object(&mut self) -> Option<&mut AmfObject> {
        self.objects.get_mut(self.object?)
    }
    fn current_volume(&mut self) -> Option<&mut AmfVolume> {
        let (object, volume) = self.volume?;
        self.objects[object].volumes.get_mut(volume)
    }
}

pub(crate) fn decode(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    let text = units(&decode_utf8(bytes));
    let mut state = State {
        limits,
        cancel,
        unit: "millimeter".into(),
        objects: Vec::new(),
        ids: HashSet::new(),
        colors: HashMap::new(),
        material_names: HashMap::new(),
        instances: Vec::new(),
        object: None,
        volume: None,
        material: None,
        instance: false,
        vertex: [None; 3],
        triangle: [None; 3],
        color: HashMap::new(),
        metadata_type: None,
        metadata_owner: None,
        in_coordinates: false,
        in_color: false,
        dropped: BTreeSet::new(),
    };
    xml::scan(&text, limits.max_xml_depth, Format::Amf, &mut state)?;
    if state.objects.is_empty() {
        return Err(fail(Malformed::InvalidSyntax));
    }

    let mut by_object: HashMap<Vec<u16>, Vec<Transform>> = HashMap::new();
    for instance in &state.instances {
        if !state.ids.contains(&instance.object) {
            return Err(fail(Malformed::InvalidSyntax));
        }
        let list = by_object.entry(instance.object.clone()).or_default();
        if list.len() + 1 > limits.max_instances_per_object {
            return Err(fail(Malformed::LimitExceeded));
        }
        list.push(instance_transform(instance));
    }

    let mut notices = Vec::new();
    let mut decoded: Vec<Object> = Vec::new();
    for object in &state.objects {
        let vertex_count = object.vertices.len() / 3;
        let mut volumes = Vec::new();
        for volume in &object.volumes {
            let mut builder = Builder::new(limits, Format::Amf);
            let mut remapped: HashMap<u32, u32> = HashMap::new();
            for triangle in volume.triangles.chunks_exact(3) {
                state.cancel.tick()?;
                let mut resolved = [0; 3];
                for (slot, &source) in resolved.iter_mut().zip(triangle) {
                    if source as usize >= vertex_count {
                        return Err(fail(Malformed::InvalidGeometry));
                    }
                    *slot = match remapped.get(&source) {
                        Some(&index) => index,
                        None => {
                            let at = source as usize * 3;
                            let v = &object.vertices;
                            let index = builder.add_vertex(v[at], v[at + 1], v[at + 2])?;
                            remapped.insert(source, index);
                            index
                        }
                    };
                }
                builder.add_indexed_triangle(resolved)?;
            }
            if builder.triangle_count() == 0 {
                continue;
            }
            notices.extend(builder.repair_notice(filename));
            let material_name = volume.material.as_ref().map(|id| {
                state
                    .material_names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.clone())
            });
            let fallback = Message::default()
                .u(object.name.as_ref().unwrap_or(&object.id))
                .s(" part ")
                .n((volumes.len() + 1) as f64)
                .done();
            volumes.push(Volume {
                name: bounded_name(
                    volume.name.as_deref().or(material_name.as_deref()),
                    fallback,
                    limits,
                ),
                role: volume.role,
                mesh: builder.build()?,
                color_hex: volume
                    .material
                    .as_ref()
                    .and_then(|id| state.colors.get(id).cloned()),
                material_name,
            });
        }
        if volumes.is_empty() {
            continue;
        }
        let fallback = Message::default()
            .u(&default_object_name(filename))
            .s(" ")
            .n((decoded.len() + 1) as f64)
            .done();
        decoded.push(Object {
            name: bounded_name(object.name.as_deref(), fallback, limits),
            volumes,
            instances: by_object
                .get(&object.id)
                .cloned()
                .unwrap_or_else(|| vec![IDENTITY]),
        });
    }
    if decoded.is_empty() {
        return Err(fail(Malformed::InvalidSyntax));
    }

    let scale = UNITS
        .iter()
        .find(|(u, _)| *u == state.unit)
        .map_or(1.0, |(_, s)| *s);
    if scale != 1.0 {
        notices.push(Notice {
            kind: NoticeKind::UnitConversion,
            code: "amf-unit-converted",
            path: filename.to_vec(),
            message: Message::new("Converted ")
                .s(&state.unit)
                .s(" coordinates to millimetres (×")
                .n(scale)
                .s(")")
                .done(),
        });
    }
    for dropped in &state.dropped {
        notices.push(Notice {
            kind: NoticeKind::DroppedField,
            code: "amf-metadata-not-imported",
            path: filename.to_vec(),
            message: Message::new("AMF metadata \"")
                .u(dropped)
                .s("\" is not mapped to a canonical field yet and was not imported")
                .done(),
        });
    }
    if decoded
        .iter()
        .any(|o| o.volumes.iter().any(|v| v.color_hex.is_some()))
    {
        notices.push(Notice {
            kind: NoticeKind::MaterialSubstitution,
            code: "amf-material-colours-retained",
            path: filename.to_vec(),
            message: units("AMF material colours were retained as part metadata; assign filaments to apply them to a print"),
        });
    }
    Ok(Decoded {
        format: Format::Amf,
        filename: filename.to_vec(),
        unit_scale_to_mm: scale,
        source_unit: state.unit,
        objects: decoded,
        notices,
    })
}

fn instance_transform(instance: &AmfInstance) -> Transform {
    let radians = |v: f64| {
        if v.is_finite() {
            (v * std::f64::consts::PI) / 180.0
        } else {
            0.0
        }
    };
    let finite = |v: f64| if v.is_finite() { v } else { 0.0 };
    let [x, y, z] = instance.rotation_deg.map(radians);
    // V8's Math.sin/Math.cos (its vendored glibc, not fdlibm).
    use orcaxr_project::js_math::{cos, sin};
    let (sx, cx) = (sin(x / 2.0), cos(x / 2.0));
    let (sy, cy) = (sin(y / 2.0), cos(y / 2.0));
    let (sz, cz) = (sin(z / 2.0), cos(z / 2.0));
    Transform {
        translation_mm: instance.translation.map(finite),
        rotation: [
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
        ],
        scale: [1.0; 3],
    }
}
