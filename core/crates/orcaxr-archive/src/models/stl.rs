//! Binary and ASCII STL as one welded object in assumed millimetres. STL has
//! no units, transforms or materials; the object is named after its file.
use super::{
    Cancel, Decoded, Format, IDENTITY, Limits, Malformed, Notice, NoticeKind, Object, Result, Role,
    Volume, malformed,
    mesh::Builder,
    text::{
        Message, ascii_lower_starts, decode_utf8, default_object_name, lines, number, trim, units,
        words,
    },
};

const HEADER: usize = 84;
const TRIANGLE: usize = 50;

pub(crate) fn decode(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    format: Format,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    let mut builder = Builder::new(limits, format);
    let solids = if format == Format::StlBinary {
        binary(bytes, &mut builder, limits, cancel)?
    } else {
        ascii(bytes, &mut builder, cancel)?
    };
    let mut notices = Vec::new();
    notices.extend(builder.repair_notice(filename));
    if solids.len() > 1 {
        let shown = solids.iter().take(4).map(|s| units(s)).collect::<Vec<_>>();
        notices.push(Notice {
            kind: NoticeKind::GeometryRepair,
            code: "stl-multiple-solids-merged",
            path: filename.to_vec(),
            message: Message::new("Merged ")
                .n(solids.len() as f64)
                .s(" STL solids (")
                .u(&shown.join(&[0x2c, 0x20][..]))
                .s(if solids.len() > 4 { ", …" } else { "" })
                .s(") into one object, as the pinned engine does; use Split to objects to separate them")
                .done(),
        });
    }
    if format == Format::StlBinary
        && let Some(header) = solids.first()
    {
        notices.push(Notice {
            kind: NoticeKind::IgnoredMember,
            code: "stl-binary-header",
            path: filename.to_vec(),
            message: Message::new("Binary STL header: \"")
                .s(header)
                .s("\"")
                .done(),
        });
    }
    notices.push(Notice {
        kind: NoticeKind::AssumedUnit,
        code: "stl-assumed-millimetres",
        path: filename.to_vec(),
        message: units("STL carries no unit; coordinates were imported as millimetres"),
    });
    // Upstream names an imported mesh after its file, never its STL header.
    let name = default_object_name(filename);
    Ok(Decoded {
        format,
        filename: filename.to_vec(),
        unit_scale_to_mm: 1.0,
        source_unit: "millimeter".into(),
        objects: vec![Object {
            name: name.clone(),
            volumes: vec![Volume {
                name,
                role: Role::Model,
                mesh: builder.build()?,
                color_hex: None,
                material_name: None,
            }],
            instances: vec![IDENTITY],
        }],
        notices,
    })
}

fn binary(
    bytes: &[u8],
    builder: &mut Builder,
    limits: &Limits,
    cancel: &mut Cancel,
) -> Result<Vec<String>> {
    if bytes.len() < HEADER {
        return Err(malformed(Malformed::Truncated, Format::StlBinary));
    }
    let declared = u32::from_le_bytes(bytes[80..84].try_into().expect("four bytes")) as usize;
    let available = (bytes.len() - HEADER) / TRIANGLE;
    if declared > available {
        return Err(malformed(Malformed::Truncated, Format::StlBinary));
    }
    if declared > limits.max_triangles {
        return Err(malformed(Malformed::LimitExceeded, Format::StlBinary));
    }
    let float = |at: usize| {
        f64::from(f32::from_le_bytes(
            bytes[at..at + 4].try_into().expect("four bytes"),
        ))
    };
    for triangle in 0..declared {
        cancel.tick()?;
        // Skip the per-facet normal: the engine recomputes it from winding order.
        let base = HEADER + triangle * TRIANGLE + 12;
        let corner = |i: usize| {
            [
                float(base + i * 12),
                float(base + i * 12 + 4),
                float(base + i * 12 + 8),
            ]
        };
        builder.add_triangle([corner(0), corner(1), corner(2)])?;
    }
    // Exporters pad the fixed header with NULs; keep only the leading label.
    let label = decode_utf8(&bytes[..80]);
    let label = label.split('\0').next().unwrap_or("");
    let cleaned: String = label
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || c == '\x7f' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let header = trim(&cleaned);
    Ok(if header.is_empty() {
        vec![]
    } else {
        vec![header.to_owned()]
    })
}

fn ascii(bytes: &[u8], builder: &mut Builder, cancel: &mut Cancel) -> Result<Vec<String>> {
    let fail = |reason| malformed(reason, Format::StlAscii);
    let text = decode_utf8(bytes);
    let mut solids = Vec::new();
    let mut corners: Vec<[f64; 3]> = Vec::with_capacity(3);
    let mut inside = false;
    for raw in lines(&text) {
        cancel.tick()?;
        let line = trim(raw);
        if line.is_empty() {
            continue;
        }
        if ascii_lower_starts(line, "solid") {
            let name = trim(&line[5..]);
            solids.push(if name.is_empty() {
                format!("solid {}", solids.len() + 1)
            } else {
                name.to_owned()
            });
            continue;
        }
        if ascii_lower_starts(line, "endsolid")
            || ascii_lower_starts(line, "outer loop")
            || ascii_lower_starts(line, "endloop")
        {
            continue;
        }
        if ascii_lower_starts(line, "facet") {
            inside = true;
            corners.clear();
            continue;
        }
        if ascii_lower_starts(line, "endfacet") {
            if corners.len() != 3 {
                return Err(fail(Malformed::InvalidSyntax));
            }
            builder.add_triangle([corners[0], corners[1], corners[2]])?;
            corners.clear();
            inside = false;
            continue;
        }
        if ascii_lower_starts(line, "vertex") {
            if !inside {
                return Err(fail(Malformed::InvalidSyntax));
            }
            let parts: Vec<&str> = words(line).take(4).collect();
            if parts.len() < 4 {
                return Err(fail(Malformed::InvalidSyntax));
            }
            let corner = [number(parts[1]), number(parts[2]), number(parts[3])];
            if corner.iter().any(|v| !v.is_finite()) {
                return Err(fail(Malformed::InvalidGeometry));
            }
            if corners.len() == 3 {
                return Err(fail(Malformed::InvalidSyntax));
            }
            corners.push(corner);
            continue;
        }
        return Err(fail(Malformed::InvalidSyntax));
    }
    if inside {
        return Err(fail(Malformed::Truncated));
    }
    Ok(solids)
}
