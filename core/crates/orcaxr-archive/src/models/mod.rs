//! Signature-first model decoding: binary/ASCII STL, OBJ, AMF, compressed AMF
//! and ZIP archives of those formats, ported from the production browser's
//! `decodeModelImport` and verified against its corpus
//! (`testdata/cross-platform/model-import-vectors.json`). Content signatures
//! always choose the decoder; an extension only breaks ties and a contradiction
//! is refused, never reinterpreted. Every decoder observation becomes a notice
//! with the browser's exact UTF-16 text. Errors carry the browser's reason and
//! format codes; their prose is the host's. Decoding is synchronous and
//! cooperatively cancellable: run it on an owned import task.
mod amf;
mod detect;
pub mod host;
pub mod layout;
mod mesh;
mod obj;
pub mod stage;
mod stl;
mod text;
mod xml;

pub use detect::{Detection, Evidence, detect};

use crate::{Archive, ZipLimits};
use std::io::Cursor;
use text::{Message, file_extension, lower, units};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    StlBinary,
    StlAscii,
    Obj,
    Amf,
    AmfCompressed,
    ZipArchive,
    Project3mf,
    Step,
    Svg,
    Gcode,
}
impl Format {
    pub fn code(self) -> &'static str {
        match self {
            Self::StlBinary => "stl-binary",
            Self::StlAscii => "stl-ascii",
            Self::Obj => "obj",
            Self::Amf => "amf",
            Self::AmfCompressed => "amf-compressed",
            Self::ZipArchive => "zip-archive",
            Self::Project3mf => "project-3mf",
            Self::Step => "step",
            Self::Svg => "svg",
            Self::Gcode => "gcode",
        }
    }
}

/// A recognised container this decoder cannot turn into geometry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    EmptyInput,
    UnknownSignature,
    ExtensionSignatureMismatch,
    RequiresProjectImport,
    RequiresNativeKernel,
    RequiresEmbossWorkflow,
    NotAModelFormat,
}
impl Unsupported {
    pub fn code(self) -> &'static str {
        match self {
            Self::EmptyInput => "empty-input",
            Self::UnknownSignature => "unknown-signature",
            Self::ExtensionSignatureMismatch => "extension-signature-mismatch",
            Self::RequiresProjectImport => "requires-project-import",
            Self::RequiresNativeKernel => "requires-native-kernel",
            Self::RequiresEmbossWorkflow => "requires-emboss-workflow",
            Self::NotAModelFormat => "not-a-model-format",
        }
    }
}

/// A recognised container that failed to decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Malformed {
    Truncated,
    InvalidSyntax,
    InvalidGeometry,
    NoGeometry,
    LimitExceeded,
    UnsafeArchive,
}
impl Malformed {
    pub fn code(self) -> &'static str {
        match self {
            Self::Truncated => "truncated",
            Self::InvalidSyntax => "invalid-syntax",
            Self::InvalidGeometry => "invalid-geometry",
            Self::NoGeometry => "no-geometry",
            Self::LimitExceeded => "limit-exceeded",
            Self::UnsafeArchive => "unsafe-archive",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unsupported(Unsupported, Option<Format>),
    Malformed(Malformed, Option<Format>),
    Cancelled,
}
pub type Result<T> = std::result::Result<T, Error>;
pub(crate) fn malformed(reason: Malformed, format: Format) -> Error {
    Error::Malformed(reason, Some(format))
}

/// Hard caps that keep hostile or accidental inputs bounded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_triangles: usize,
    pub max_vertices: usize,
    pub max_objects: usize,
    pub max_volumes_per_object: usize,
    pub max_instances_per_object: usize,
    pub max_archive_members: usize,
    pub max_name_length: usize,
    pub max_xml_depth: usize,
}
/// The browser's defaults.
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 512 << 20,
            max_triangles: 8_000_000,
            max_vertices: 24_000_000,
            max_objects: 4096,
            max_volumes_per_object: 512,
            max_instances_per_object: 4096,
            max_archive_members: 512,
            max_name_length: 200,
            max_xml_depth: 64,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Model,
    ParameterModifier,
}
/// Welded indexed triangles in source units (Float32 positions).
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Volume {
    pub name: Vec<u16>,
    pub role: Role,
    pub mesh: Mesh,
    /// `#rrggbb` when the source carried an explicit per-volume colour.
    pub color_hex: Option<String>,
    /// Source material/appearance name, for provenance and warnings.
    pub material_name: Option<Vec<u16>>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub translation_mm: [f64; 3],
    pub rotation: [f64; 4],
    pub scale: [f64; 3],
}
pub const IDENTITY: Transform = Transform {
    translation_mm: [0.0; 3],
    rotation: [0.0, 0.0, 0.0, 1.0],
    scale: [1.0; 3],
};
#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    pub name: Vec<u16>,
    pub volumes: Vec<Volume>,
    /// At least one placement in source units; AMF constellations may repeat.
    pub instances: Vec<Transform>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    UnitConversion,
    AssumedUnit,
    DroppedField,
    IgnoredMember,
    GeometryRepair,
    MaterialSubstitution,
    LimitWarning,
}
impl NoticeKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::UnitConversion => "unit-conversion",
            Self::AssumedUnit => "assumed-unit",
            Self::DroppedField => "dropped-field",
            Self::IgnoredMember => "ignored-member",
            Self::GeometryRepair => "geometry-repair",
            Self::MaterialSubstitution => "material-substitution",
            Self::LimitWarning => "limit-warning",
        }
    }
}
/// One observation surfaced through the import preview; nothing is silent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub kind: NoticeKind,
    /// Stable machine-readable code, e.g. `obj-mtllib-not-loaded`.
    pub code: &'static str,
    /// Source-relative location.
    pub path: Vec<u16>,
    pub message: Vec<u16>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub format: Format,
    pub filename: Vec<u16>,
    /// Multiplier converting source coordinates to millimetres; decoders report
    /// it instead of pre-multiplying.
    pub unit_scale_to_mm: f64,
    pub source_unit: String,
    pub objects: Vec<Object>,
    pub notices: Vec<Notice>,
}

/// Cooperative cancellation polled at bounded intervals.
pub(crate) struct Cancel<'a> {
    cancelled: &'a mut dyn FnMut() -> bool,
    count: u32,
}
impl Cancel<'_> {
    pub fn tick(&mut self) -> Result<()> {
        self.count = self.count.wrapping_add(1);
        if self.count.is_multiple_of(4096) && (self.cancelled)() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    fn check(&mut self) -> Result<()> {
        if (self.cancelled)() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Model containers this decoder turns into geometry.
pub const SUPPORTED_EXTENSIONS: [&str; 5] = ["stl", "obj", "amf", "amfz", "zip"];

/// Decode one model source named `filename` (UTF-16, as the host received it).
pub fn decode(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Decoded> {
    let mut cancel = Cancel {
        cancelled: &mut cancelled,
        count: 0,
    };
    cancel.check()?;
    let decoded = decode_with(bytes, filename, limits, 0, None, &mut cancel)?;
    cancel.check()?;
    Ok(decoded)
}

fn decode_with(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    depth: usize,
    companions: Option<obj::Companions<'_>>,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    if bytes.len() > limits.max_bytes {
        return Err(Error::Malformed(Malformed::LimitExceeded, None));
    }
    let detection = detect(bytes, filename)?;
    if let Some(reason) = detection.unsupported {
        return Err(Error::Unsupported(reason, Some(detection.format)));
    }
    match detection.format {
        Format::StlBinary | Format::StlAscii => {
            stl::decode(bytes, filename, limits, detection.format, cancel)
        }
        Format::Obj => obj::decode(bytes, filename, limits, companions, cancel),
        Format::Amf => amf::decode(bytes, filename, limits, cancel),
        Format::AmfCompressed => compressed_amf(bytes, filename, limits, cancel),
        Format::ZipArchive => archive(bytes, filename, limits, depth, cancel),
        other => Err(Error::Unsupported(
            Unsupported::UnknownSignature,
            Some(other),
        )),
    }
}

fn compressed_amf(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    let (inner, name) = if bytes.first() == Some(&0x1f) {
        (gunzip(bytes, limits, cancel)?, gzip_member_name(filename))
    } else {
        let mut members = read_members(bytes, limits, cancel)?;
        let mut candidates: Vec<usize> = (0..members.len())
            .filter(|&i| file_extension(&members[i].0) == units("amf"))
            .collect();
        if candidates.len() != 1 {
            return Err(malformed(Malformed::InvalidSyntax, Format::AmfCompressed));
        }
        let (name, bytes) = members.swap_remove(candidates.remove(0));
        (bytes, name)
    };
    let mut decoded = amf::decode(&inner, &name, limits, cancel)?;
    decoded.format = Format::AmfCompressed;
    decoded.filename = filename.to_vec();
    decoded.notices.push(Notice {
        kind: NoticeKind::IgnoredMember,
        code: "amf-compressed-member",
        path: filename.to_vec(),
        message: Message::new("Decompressed AMF member \"")
            .u(&name)
            .s("\"")
            .done(),
    });
    Ok(decoded)
}

/// `filename.replace(/\.(amfz|gz)$/i, '') || filename`.
fn gzip_member_name(filename: &[u16]) -> Vec<u16> {
    for suffix in [".amfz", ".gz"] {
        let n = suffix.len();
        if filename.len() >= n
            && filename[filename.len() - n..]
                .iter()
                .zip(suffix.bytes())
                .all(|(&u, b)| u < 0x80 && (u as u8).eq_ignore_ascii_case(&b))
        {
            let stem = &filename[..filename.len() - n];
            return if stem.is_empty() {
                filename.to_vec()
            } else {
                stem.to_vec()
            };
        }
    }
    filename.to_vec()
}

/// fflate `gunzipSync`: header fields are skipped, only the first member
/// inflates, and the output is sized by the trailer's length field without a
/// CRC check: longer content is truncated to it, and an empty deflate body
/// yields that many zero bytes. The trailer never sizes an allocation here;
/// content beyond the budget is still inflated (cancellably) to find late
/// corruption. One refusal differs only in its format code: fflate rejects a
/// stored block that overflows the trailer length (`amf-compressed`), while
/// this truncates it and the AMF decoder refuses the prefix (`amf`).
fn gunzip(bytes: &[u8], limits: &Limits, cancel: &mut Cancel) -> Result<Vec<u8>> {
    let syntax = || malformed(Malformed::InvalidSyntax, Format::AmfCompressed);
    let limit = || malformed(Malformed::LimitExceeded, Format::AmfCompressed);
    if bytes.len() < 3 || bytes[..3] != [0x1f, 0x8b, 0x08] {
        return Err(syntax());
    }
    let at = |i: usize| bytes.get(i).copied().unwrap_or(0);
    let flags = at(3);
    let mut start = 10usize;
    if flags & 4 != 0 {
        start += (usize::from(at(10)) | usize::from(at(11)) << 8) + 2;
    }
    let mut strings = usize::from(flags >> 3 & 1) + usize::from(flags >> 4 & 1);
    while strings > 0 {
        if at(start) == 0 {
            strings -= 1;
        }
        start += 1;
    }
    start += usize::from(flags & 2);
    if start + 8 > bytes.len() {
        return Err(syntax());
    }
    let declared =
        u32::from_le_bytes(bytes[bytes.len() - 4..].try_into().expect("four bytes")) as usize;
    let input = &bytes[start..bytes.len() - 8];
    if input.is_empty() {
        return if declared > limits.max_bytes {
            Err(limit())
        } else {
            Ok(vec![0; declared])
        };
    }
    let keep = declared.min(limits.max_bytes.saturating_add(1));
    let mut inflater = flate2::Decompress::new(false);
    let mut output = Vec::new();
    let mut chunk = vec![0u8; 64 << 10];
    loop {
        cancel.check()?;
        let consumed = inflater.total_in() as usize;
        let produced = inflater.total_out();
        let status = inflater
            .decompress(
                &input[consumed..],
                &mut chunk,
                flate2::FlushDecompress::None,
            )
            .map_err(|_| syntax())?;
        let written = (inflater.total_out() - produced) as usize;
        let room = keep - output.len();
        output.extend_from_slice(&chunk[..written.min(room)]);
        match status {
            flate2::Status::StreamEnd => break,
            _ if written == 0 && inflater.total_in() as usize == consumed => return Err(syntax()),
            _ => {}
        }
    }
    if output.len() > limits.max_bytes {
        return Err(limit());
    }
    Ok(output)
}

/// ZIP members in central-directory order under the browser's safe-ZIP policy.
fn read_members(
    bytes: &[u8],
    limits: &Limits,
    cancel: &mut Cancel,
) -> Result<Vec<(Vec<u16>, Vec<u8>)>> {
    let unsafe_archive = || malformed(Malformed::UnsafeArchive, Format::ZipArchive);
    let zip = ZipLimits {
        archive_bytes: limits.max_bytes as u64,
        entries: limits.max_archive_members as u64,
        entry_bytes: 512 << 20,
        total_uncompressed_bytes: 2048 << 20,
        compression_ratio: 1000.0,
        path_bytes: 512,
    };
    let mut archive =
        Archive::open(Cursor::new(bytes), zip, || false).map_err(|_| unsafe_archive())?;
    let mut members = Vec::new();
    for index in 0..archive.entries().len() {
        cancel.check()?;
        let entry = &archive.entries()[index];
        if entry.is_directory() {
            continue;
        }
        let path = units(entry.path());
        let mut data = Vec::new();
        archive
            .read_entry(index, &mut data, || false)
            .map_err(|_| unsafe_archive())?;
        members.push((path, data));
    }
    Ok(members)
}

/// Every supported member decodes as one atomic import; a failing member fails
/// the archive, and unsupported members are reported, never reinterpreted.
fn archive(
    bytes: &[u8],
    filename: &[u16],
    limits: &Limits,
    depth: usize,
    cancel: &mut Cancel,
) -> Result<Decoded> {
    if depth > 0 {
        return Err(malformed(Malformed::UnsafeArchive, Format::ZipArchive));
    }
    let members = read_members(bytes, limits, cancel)?;
    let lowered: Vec<Vec<u16>> = members.iter().map(|(path, _)| lower(path)).collect();
    let resolve = |name: &str| -> Option<Vec<u8>> {
        let target = lower(&units(name.strip_prefix("./").unwrap_or(name)));
        let suffix: Vec<u16> = std::iter::once(u16::from(b'/'))
            .chain(target.iter().copied())
            .collect();
        members
            .iter()
            .zip(&lowered)
            .find(|(_, path)| **path == target || path.ends_with(&suffix))
            .map(|((_, bytes), _)| bytes.clone())
    };
    let mut order: Vec<usize> = (0..members.len()).collect();
    order.sort_by(|&a, &b| members[a].0.cmp(&members[b].0));

    let mut notices = Vec::new();
    let mut objects = Vec::new();
    let mut decoded_members = 0usize;
    let mut source_unit = String::from("millimeter");
    for index in order {
        cancel.check()?;
        let (path, member) = &members[index];
        let extension = file_extension(path);
        let supported = SUPPORTED_EXTENSIONS.iter().any(|e| units(e) == extension);
        if !supported || extension == units("zip") {
            let reason = if extension.is_empty() {
                Message::new("it has no model extension")
            } else {
                Message::new(".")
                    .u(&extension)
                    .s(" members are not model sources")
            };
            notices.push(Notice {
                kind: NoticeKind::IgnoredMember,
                code: "archive-member-skipped",
                path: path.clone(),
                message: Message::new("Skipped \"")
                    .u(path)
                    .s("\"; ")
                    .u(&reason.done())
                    .done(),
            });
            continue;
        }
        let decoded = decode_with(member, path, limits, depth + 1, Some(&resolve), cancel)?;
        decoded_members += 1;
        if decoded.unit_scale_to_mm != 1.0 {
            // Archives may mix units; each member is converted before merging.
            let scale = decoded.unit_scale_to_mm;
            source_unit.clone_from(&decoded.source_unit);
            objects.extend(
                decoded
                    .objects
                    .into_iter()
                    .map(|object| scale_object(object, scale)),
            );
            notices.push(Notice {
                kind: NoticeKind::UnitConversion,
                code: "archive-member-unit-converted",
                path: path.clone(),
                message: Message::new("Converted ")
                    .s(&decoded.source_unit)
                    .s(" member coordinates to millimetres (×")
                    .n(scale)
                    .s(")")
                    .done(),
            });
        } else {
            objects.extend(decoded.objects);
        }
        notices.extend(
            decoded
                .notices
                .into_iter()
                .filter(|n| n.code != "archive-member-unit-converted"),
        );
        if objects.len() > limits.max_objects {
            return Err(malformed(Malformed::LimitExceeded, Format::ZipArchive));
        }
    }
    if decoded_members == 0 || objects.is_empty() {
        return Err(malformed(Malformed::NoGeometry, Format::ZipArchive));
    }
    notices.insert(
        0,
        Notice {
            kind: NoticeKind::IgnoredMember,
            code: "archive-members-imported",
            path: filename.to_vec(),
            message: Message::new("Imported ")
                .n(decoded_members as f64)
                .s(if decoded_members == 1 {
                    " model member from the archive as one transaction"
                } else {
                    " model members from the archive as one transaction"
                })
                .done(),
        },
    );
    Ok(Decoded {
        format: Format::ZipArchive,
        filename: filename.to_vec(),
        unit_scale_to_mm: 1.0,
        source_unit,
        objects,
        notices,
    })
}

/// Pre-multiply a member so mixed-unit archives share one scale.
fn scale_object(mut object: Object, scale: f64) -> Object {
    for volume in &mut object.volumes {
        for value in &mut volume.mesh.positions {
            *value = (f64::from(*value) * scale) as f32;
        }
    }
    for instance in &mut object.instances {
        for value in &mut instance.translation_mm {
            *value *= scale;
        }
    }
    object
}
