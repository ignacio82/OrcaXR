//! Signature-first format detection (`detectModelFormat`). Text heuristics read
//! only an 8 KiB probe with the browser's exact regular-expression semantics:
//! ASCII-only case-insensitivity and `\w`/`\b`, ECMAScript `\s`.
use super::{
    Error, Format, Result, Unsupported,
    text::{decode_utf8, file_extension, is_space, lines, trim, units},
};

const ZIP_LOCAL: u32 = 0x0403_4b50;
const ZIP_EMPTY: u32 = 0x0605_4b50;
const ZIP_SPANNED: u32 = 0x0807_4b50;
const PROBE: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    Signature,
    SignatureAndExtension,
    TextHeuristic,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Detection {
    pub format: Format,
    /// Lower-case extension without the dot, or empty (UTF-16).
    pub extension: Vec<u16>,
    pub evidence: Evidence,
    /// Present when this container is recognised but not decodable here.
    pub unsupported: Option<Unsupported>,
}

fn declared(extension: &[u16]) -> Option<Format> {
    let extension = String::from_utf16(extension).ok()?;
    Some(match extension.as_str() {
        "stl" => Format::StlBinary,
        "obj" => Format::Obj,
        "amf" => Format::Amf,
        "amfz" => Format::AmfCompressed,
        "zip" => Format::ZipArchive,
        "3mf" => Format::Project3mf,
        "step" | "stp" => Format::Step,
        "svg" => Format::Svg,
        "gcode" | "gco" | "g" => Format::Gcode,
        _ => return None,
    })
}
fn compatible(declared: Format, detected: Format) -> bool {
    declared == detected
        || matches!(
            (declared, detected),
            (Format::StlBinary, Format::StlAscii)
                | (Format::Amf, Format::AmfCompressed)
                | (Format::AmfCompressed, Format::Amf)
        )
}
fn mismatch(format: Option<Format>) -> Error {
    Error::Unsupported(Unsupported::ExtensionSignatureMismatch, format)
}

pub fn detect(bytes: &[u8], filename: &[u16]) -> Result<Detection> {
    let extension = file_extension(filename);
    if bytes.is_empty() {
        return Err(Error::Unsupported(Unsupported::EmptyInput, None));
    }
    let Some((format, evidence)) = by_signature(bytes, &extension) else {
        return Err(match declared(&extension) {
            Some(format) => mismatch(Some(format)),
            None => Error::Unsupported(Unsupported::UnknownSignature, None),
        });
    };
    if declared(&extension).is_some_and(|d| !compatible(d, format)) {
        return Err(mismatch(Some(format)));
    }
    let unsupported = match format {
        Format::Project3mf => Some(Unsupported::RequiresProjectImport),
        Format::Step => Some(Unsupported::RequiresNativeKernel),
        Format::Svg => Some(Unsupported::RequiresEmbossWorkflow),
        Format::Gcode => Some(Unsupported::NotAModelFormat),
        _ => None,
    };
    Ok(Detection {
        format,
        extension,
        evidence,
        unsupported,
    })
}

fn word32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

fn by_signature(bytes: &[u8], extension: &[u16]) -> Option<(Format, Evidence)> {
    let ext = |name: &str| extension == units(name).as_slice();
    if bytes.len() >= 4 && matches!(word32(bytes, 0), ZIP_LOCAL | ZIP_EMPTY | ZIP_SPANNED) {
        return Some(zip_flavor(bytes, extension));
    }
    if bytes.len() >= 3 && bytes[..3] == [0x1f, 0x8b, 0x08] {
        return Some((Format::AmfCompressed, Evidence::Signature));
    }
    if is_binary_stl(bytes) {
        return Some((Format::StlBinary, Evidence::Signature));
    }
    let Some(probe) = text_probe(bytes) else {
        // A binary .stl whose payload does not add up is still STL, so the
        // decoder can report the exact truncation.
        return (ext("stl") && bytes.len() >= 84)
            .then_some((Format::StlBinary, Evidence::SignatureAndExtension));
    };
    let probe = probe.strip_prefix('\u{feff}').unwrap_or(&probe);
    let trimmed = probe.trim_start_matches(is_space);
    if is_step(trimmed) {
        return Some((Format::Step, Evidence::Signature));
    }
    if trimmed.starts_with('<') {
        return xml_flavor(trimmed);
    }
    if is_ascii_stl(trimmed) {
        return Some((Format::StlAscii, Evidence::Signature));
    }
    if ext("stl") && solid_prefix(trimmed) {
        return Some((Format::StlAscii, Evidence::SignatureAndExtension));
    }
    if is_obj(trimmed) {
        return Some((
            Format::Obj,
            if ext("obj") {
                Evidence::SignatureAndExtension
            } else {
                Evidence::TextHeuristic
            },
        ));
    }
    if is_gcode(trimmed) {
        return Some((Format::Gcode, Evidence::TextHeuristic));
    }
    // Only after every text form is ruled out may a padded binary STL match.
    if is_padded_binary_stl(bytes) {
        return Some((Format::StlBinary, Evidence::Signature));
    }
    None
}

fn zip_flavor(bytes: &[u8], extension: &[u16]) -> (Format, Evidence) {
    let first = first_entry_name(bytes);
    let model_part = first.as_deref().is_some_and(|name| {
        name.len() > "3D/".len() + ".model".len()
            && name.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("3D/"))
            && name
                .get(name.len() - 6..)
                .is_some_and(|s| s.eq_ignore_ascii_case(".model"))
            && !name[3..name.len() - 6].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    });
    if first.as_deref() == Some("[Content_Types].xml") || model_part {
        return (Format::Project3mf, Evidence::Signature);
    }
    if extension == units("amf").as_slice() || extension == units("amfz").as_slice() {
        return (Format::AmfCompressed, Evidence::SignatureAndExtension);
    }
    if extension == units("3mf").as_slice() {
        return (Format::Project3mf, Evidence::SignatureAndExtension);
    }
    (Format::ZipArchive, Evidence::Signature)
}

fn first_entry_name(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 30 || word32(bytes, 0) != ZIP_LOCAL {
        return None;
    }
    let length = usize::from(bytes[26]) | usize::from(bytes[27]) << 8;
    if length == 0 || 30 + length > bytes.len() || length > 1024 {
        return None;
    }
    Some(decode_utf8(&bytes[30..30 + length]))
}

fn xml_flavor(trimmed: &str) -> Option<(Format, Evidence)> {
    let root = first_element_name(trimmed)?;
    let local = root
        .split_once(':')
        .map_or(root, |(_, local)| local)
        .to_ascii_lowercase();
    match local.as_str() {
        "amf" => Some((Format::Amf, Evidence::Signature)),
        "svg" => Some((Format::Svg, Evidence::Signature)),
        _ => None,
    }
}

fn first_element_name(text: &str) -> Option<&str> {
    let mut cursor = 0;
    while cursor < text.len() {
        let open = cursor + text[cursor..].find('<')?;
        let rest = &text[open..];
        if rest.starts_with("<?") || rest.starts_with("<!") {
            cursor = open + 2 + rest[2..].find('>')? + 1;
            continue;
        }
        // /^<\s*([A-Za-z_][\w.:-]*)/
        let name = rest[1..].trim_start_matches(is_space);
        let first = name.chars().next()?;
        if !(first.is_ascii_alphabetic() || first == '_') {
            return None;
        }
        let end = name
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')))
            .unwrap_or(name.len());
        return Some(&name[..end]);
    }
    None
}

fn is_binary_stl(bytes: &[u8]) -> bool {
    if bytes.len() < 84 {
        return false;
    }
    let declared = u64::from(word32(bytes, 80));
    if declared == 0 {
        return bytes.len() == 84;
    }
    if declared > u64::from(u32::MAX) / 50 {
        return false;
    }
    84 + declared * 50 == bytes.len() as u64
}

fn is_padded_binary_stl(bytes: &[u8]) -> bool {
    if bytes.len() < 84 {
        return false;
    }
    let declared = u64::from(word32(bytes, 80));
    let room = (bytes.len() - 84) as u64;
    if declared == 0 || declared * 50 > room {
        return false;
    }
    room - declared * 50 < 50
}

/// `undefined` when the prefix holds bytes no text format may contain.
fn text_probe(bytes: &[u8]) -> Option<String> {
    let probe = &bytes[..bytes.len().min(PROBE)];
    if probe.iter().any(|&b| b < 0x09 || (b > 0x0d && b < 0x20)) {
        return None;
    }
    Some(decode_utf8(probe))
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}
/// ASCII case-insensitive match of `keyword` at `at`.
fn keyword_at(text: &str, at: usize, keyword: &str) -> bool {
    text.as_bytes()
        .get(at..at + keyword.len())
        .is_some_and(|b| b.eq_ignore_ascii_case(keyword.as_bytes()))
}
/// `^keyword\b` (case-insensitive).
fn starts_word(text: &str, keyword: &str) -> bool {
    keyword_at(text, 0, keyword) && !is_word(text[keyword.len()..].chars().next())
}
fn solid_prefix(text: &str) -> bool {
    starts_word(text, "solid")
}
fn is_step(text: &str) -> bool {
    // /^ISO-10303-21\s*;/i or /^STEP;/i
    if keyword_at(text, 0, "ISO-10303-21") {
        return text["ISO-10303-21".len()..]
            .trim_start_matches(is_space)
            .starts_with(';');
    }
    keyword_at(text, 0, "STEP;")
}
/// `\bfirst\s+second\b` (or `\bfirst\b` alone) anywhere, case-insensitively.
fn has_phrase(text: &str, first: &str, second: Option<&str>) -> bool {
    let bytes = text.as_bytes();
    (0..bytes.len()).any(|at| {
        if !keyword_at(text, at, first) || (at > 0 && is_word(Some(bytes[at - 1] as char))) {
            return false;
        }
        let mut end = at + first.len();
        if let Some(second) = second {
            let rest = &text[end..];
            let after_space = rest.trim_start_matches(is_space);
            if after_space.len() == rest.len() {
                return false;
            }
            end += rest.len() - after_space.len();
            if !keyword_at(text, end, second) {
                return false;
            }
            end += second.len();
        }
        !is_word(text[end..].chars().next())
    })
}
fn is_ascii_stl(text: &str) -> bool {
    solid_prefix(text)
        && (has_phrase(text, "facet", Some("normal"))
            || has_phrase(text, "endsolid", None)
            || has_phrase(text, "outer", Some("loop")))
}
/// `trimmed.split(/\r?\n/, n)` lines, each trimmed.
fn probe_lines(text: &str, n: usize) -> impl Iterator<Item = &str> {
    lines(text).take(n).map(trim)
}
fn keyword_then_space(line: &str, keyword: &str) -> bool {
    line.strip_prefix(keyword)
        .is_some_and(|rest| rest.chars().next().is_none_or(is_space))
}
fn is_obj(text: &str) -> bool {
    let (mut vertices, mut structural) = (0, 0);
    for line in probe_lines(text, 400) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if keyword_then_space(line, "v") {
            vertices += 1;
        } else if [
            "vn", "vt", "vp", "f", "o", "g", "s", "usemtl", "mtllib", "l", "p",
        ]
        .iter()
        .any(|k| keyword_then_space(line, k))
        {
            structural += 1;
        } else {
            return false;
        }
    }
    vertices > 0 && vertices + structural >= 3
}
fn is_gcode(text: &str) -> bool {
    probe_lines(text, 80).any(|line| {
        ["G0", "G1", "G28", "G90", "G92", "M104", "M109", "M140"]
            .iter()
            .any(|k| keyword_at(line, 0, k) && !is_word(line[k.len()..].chars().next()))
    })
}
