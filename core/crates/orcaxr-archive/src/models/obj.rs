//! Wavefront OBJ: `o` records become objects and each `usemtl`/`g` section a
//! part, so material boundaries stay independently assignable. OBJ declares no
//! unit, so millimetres are assumed and reported.
use super::{
    Cancel, Decoded, Format, IDENTITY, Limits, Malformed, Notice, NoticeKind, Object, Result, Role,
    Volume, malformed,
    mesh::Builder,
    text::{
        Message, bounded_name, decode_utf8, default_object_name, hex_channel, is_space, lines,
        lower, number, parse_int10, trim, units, words,
    },
};
use std::collections::HashMap;

/// Resolves `mtllib` companions; archives supply their sibling members.
pub(crate) type Companions<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

struct Part {
    name: Vec<u16>,
    material: Option<String>,
    builder: Builder,
}
struct Pending {
    name: Vec<u16>,
    parts: Vec<Part>,
}

pub(crate) fn decode(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    companions: Option<Companions<'_>>,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    let fail = |reason| malformed(reason, Format::Obj);
    let text = decode_utf8(bytes);
    let stem = default_object_name(filename);
    let mut notices = Vec::new();
    let mut vertices: Vec<f64> = Vec::new();
    let mut coloured = 0usize;
    let mut objects: Vec<Pending> = Vec::new();
    let mut materials: HashMap<String, String> = HashMap::new();
    let mut current_object: Option<usize> = None;
    let mut current_part: Option<usize> = None;
    let mut material: Option<String> = None;
    let mut group: Option<String> = None;
    let mut polygons = 0usize;
    let mut curves = 0usize;

    let start_object = |objects: &mut Vec<Pending>, name: &[u16]| -> Result<usize> {
        if objects.len() + 1 > limits.max_objects {
            return Err(fail(Malformed::LimitExceeded));
        }
        let fallback = Message::default()
            .u(&stem)
            .s(" ")
            .n((objects.len() + 1) as f64)
            .done();
        objects.push(Pending {
            name: bounded_name(Some(name), fallback, limits),
            parts: Vec::new(),
        });
        Ok(objects.len() - 1)
    };

    for (index, raw) in lines(&text).enumerate() {
        cancel.tick()?;
        let line_number = index + 1;
        let line = trim(raw.split('#').next().unwrap_or(""));
        if line.is_empty() {
            continue;
        }
        let (keyword, rest) = match line.find(is_space) {
            Some(space) => {
                let after = space + line[space..].chars().next().map_or(0, char::len_utf8);
                (&line[..space], trim(&line[after..]))
            }
            None => (line, ""),
        };
        // Only ASCII spellings lowercase to these ASCII keywords.
        let keyword = if keyword.is_ascii() {
            keyword.to_ascii_lowercase()
        } else {
            String::new()
        };
        match keyword.as_str() {
            "v" => {
                let parts: Vec<&str> = words(rest).collect();
                if parts.len() < 3 {
                    return Err(fail(Malformed::InvalidSyntax));
                }
                let xyz = [number(parts[0]), number(parts[1]), number(parts[2])];
                if xyz.iter().any(|v| !v.is_finite()) {
                    return Err(fail(Malformed::InvalidGeometry));
                }
                if vertices.len() / 3 + 1 > limits.max_vertices {
                    return Err(fail(Malformed::LimitExceeded));
                }
                vertices.extend_from_slice(&xyz);
                // xyzrgb exporters append colours after the coordinates.
                if parts.len() >= 6 {
                    let from = if parts.len() == 7 { 4 } else { 3 };
                    let rgb = &parts[from..(from + 3).min(parts.len())];
                    if rgb.len() == 3 && rgb.iter().all(|v| number(v).is_finite()) {
                        coloured += 1;
                    }
                }
            }
            "vn" | "vt" | "vp" | "s" => {}
            "o" => {
                current_object = Some(start_object(&mut objects, &units(rest))?);
                current_part = None;
                group = None;
            }
            "g" => {
                group = (!rest.is_empty()).then(|| rest.to_owned());
                current_part = None;
            }
            "usemtl" => {
                material = (!rest.is_empty()).then(|| rest.to_owned());
                current_part = None;
            }
            "mtllib" => {
                if !load_materials(rest, filename, companions, &mut materials, &mut notices) {
                    notices.push(Notice {
                        kind: NoticeKind::DroppedField,
                        code: "obj-mtllib-not-loaded",
                        path: Message::default()
                            .u(filename)
                            .s(":")
                            .n(line_number as f64)
                            .done(),
                        message: Message::new("Material library \"")
                            .s(rest)
                            .s("\" is not part of this import, so its colours were not applied")
                            .done(),
                    });
                }
            }
            "l" | "p" | "curv" | "curv2" | "surf" => curves += 1,
            "f" => {
                let corners: Vec<&str> = words(rest).collect();
                if corners.len() < 3 {
                    return Err(fail(Malformed::InvalidSyntax));
                }
                let object = match current_object {
                    Some(object) => object,
                    None => {
                        let object = start_object(&mut objects, &stem)?;
                        current_object = Some(object);
                        current_part = None;
                        object
                    }
                };
                let part = match current_part {
                    Some(part) => part,
                    None => {
                        let pending = &mut objects[object];
                        if pending.parts.len() + 1 > limits.max_volumes_per_object {
                            return Err(fail(Malformed::LimitExceeded));
                        }
                        let fallback = if pending.parts.is_empty() {
                            pending.name.clone()
                        } else {
                            Message::default()
                                .u(&pending.name)
                                .s(" part ")
                                .n((pending.parts.len() + 1) as f64)
                                .done()
                        };
                        let label = material.as_deref().or(group.as_deref()).map(units);
                        pending.parts.push(Part {
                            name: bounded_name(label.as_deref(), fallback, limits),
                            material: material.clone(),
                            builder: Builder::new(limits, Format::Obj),
                        });
                        current_part = Some(pending.parts.len() - 1);
                        pending.parts.len() - 1
                    }
                };
                let declared = vertices.len() / 3;
                let resolved = corners
                    .iter()
                    .map(|corner| vertex_index(corner, declared))
                    .collect::<Result<Vec<_>>>()?;
                if corners.len() > 3 {
                    polygons += 1;
                }
                let at = |i: usize| [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
                let builder = &mut objects[object].parts[part].builder;
                // Fan triangulation matches the pinned engine's OBJ polygons.
                for corner in 1..resolved.len() - 1 {
                    builder.add_triangle([
                        at(resolved[0]),
                        at(resolved[corner]),
                        at(resolved[corner + 1]),
                    ])?;
                }
            }
            _ => return Err(fail(Malformed::InvalidSyntax)),
        }
    }

    let mut decoded = Vec::new();
    for pending in objects {
        let mut volumes = Vec::new();
        for part in pending.parts {
            if part.builder.triangle_count() == 0 {
                continue;
            }
            notices.extend(part.builder.repair_notice(filename));
            let color_hex = part
                .material
                .as_ref()
                .and_then(|m| materials.get(m).cloned());
            volumes.push(Volume {
                name: part.name,
                role: Role::Model,
                mesh: part.builder.build()?,
                color_hex,
                material_name: part.material.as_deref().map(units),
            });
        }
        if !volumes.is_empty() {
            decoded.push(Object {
                name: pending.name,
                volumes,
                instances: vec![IDENTITY],
            });
        }
    }
    if decoded.is_empty() {
        return Err(fail(Malformed::NoGeometry));
    }
    let plural = |n: usize, one: &'static str, many: &'static str| if n == 1 { one } else { many };
    if polygons > 0 {
        notices.push(Notice {
            kind: NoticeKind::GeometryRepair,
            code: "obj-polygons-triangulated",
            path: filename.to_vec(),
            message: Message::new("Triangulated ")
                .n(polygons as f64)
                .s(plural(
                    polygons,
                    " polygon face with a vertex fan",
                    " polygon faces with a vertex fan",
                ))
                .done(),
        });
    }
    if curves > 0 {
        notices.push(Notice {
            kind: NoticeKind::DroppedField,
            code: "obj-non-surface-elements-dropped",
            path: filename.to_vec(),
            message: Message::new("Dropped ")
                .n(curves as f64)
                .s(plural(
                    curves,
                    " line, point, or curve element",
                    " line, point, or curve elements",
                ))
                .s("; only surfaces can be printed")
                .done(),
        });
    }
    if coloured > 0 {
        notices.push(Notice {
            kind: NoticeKind::DroppedField,
            code: "obj-vertex-colours-not-assigned",
            path: filename.to_vec(),
            message: Message::new("Kept geometry from ")
                .n(coloured as f64)
                .s(" coloured vertices, but per-vertex colour is not a canonical filament assignment; paint or assign filaments after import")
                .done(),
        });
    }
    if decoded.iter().any(|o| o.volumes.len() > 1) {
        notices.push(Notice {
            kind: NoticeKind::MaterialSubstitution,
            code: "obj-material-sections-as-parts",
            path: filename.to_vec(),
            message: units(
                "Each OBJ material or group section was imported as a separate part so it stays independently assignable",
            ),
        });
    }
    notices.push(Notice {
        kind: NoticeKind::AssumedUnit,
        code: "obj-assumed-millimetres",
        path: filename.to_vec(),
        message: units("OBJ carries no unit; coordinates were imported as millimetres"),
    });
    Ok(Decoded {
        format: Format::Obj,
        filename: filename.to_vec(),
        unit_scale_to_mm: 1.0,
        source_unit: "millimeter".into(),
        objects: decoded,
        notices,
    })
}

fn vertex_index(corner: &str, declared: usize) -> Result<usize> {
    let raw = corner.split('/').next().unwrap_or("");
    let parsed = parse_int10(raw);
    if !parsed.is_finite() || parsed == 0.0 {
        return Err(malformed(Malformed::InvalidSyntax, Format::Obj));
    }
    let index = if parsed > 0.0 {
        parsed - 1.0
    } else {
        declared as f64 + parsed
    };
    if index < 0.0 || index >= declared as f64 {
        return Err(malformed(Malformed::InvalidGeometry, Format::Obj));
    }
    Ok(index as usize)
}

fn load_materials(
    reference: &str,
    filename: &[u16],
    companions: Option<Companions<'_>>,
    into: &mut HashMap<String, String>,
    notices: &mut Vec<Notice>,
) -> bool {
    let Some(companions) = companions.filter(|_| !reference.is_empty()) else {
        return false;
    };
    let mut loaded = false;
    for name in words(reference) {
        if let Some(bytes) = companions(name) {
            loaded = true;
            parse_library(&decode_utf8(&bytes), into);
        }
    }
    if loaded {
        notices.push(Notice {
            kind: NoticeKind::MaterialSubstitution,
            code: "obj-mtllib-loaded",
            path: filename.to_vec(),
            message: Message::new("Applied diffuse colours from ")
                .s(reference)
                .done(),
        });
    }
    loaded
}

fn parse_library(text: &str, into: &mut HashMap<String, String>) {
    let mut current: Option<String> = None;
    for raw in lines(text) {
        let line = trim(raw.split('#').next().unwrap_or(""));
        if line.is_empty() {
            continue;
        }
        let mut parts = words(line);
        let keyword = parts.next().unwrap_or("");
        let rest: Vec<&str> = parts.collect();
        // `toLowerCase` matters here: U+212A KELVIN SIGN lowercases to `k`.
        let lowered = lower(&units(keyword));
        if lowered == units("newmtl") {
            let name = rest.join(" ");
            let name = trim(&name);
            current = (!name.is_empty()).then(|| name.to_owned());
        } else if lowered == units("kd")
            && let Some(name) = &current
        {
            let rgb: Vec<f64> = rest.iter().take(3).map(|v| number(v)).collect();
            if rgb.len() == 3 && rgb.iter().all(|v| v.is_finite()) {
                into.insert(
                    name.clone(),
                    format!(
                        "#{}{}{}",
                        hex_channel(rgb[0]),
                        hex_channel(rgb[1]),
                        hex_channel(rgb[2])
                    ),
                );
            }
        }
    }
}
