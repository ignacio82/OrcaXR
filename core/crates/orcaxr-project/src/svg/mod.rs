//! SVG parts over a live session (`svgPartExchange.ts` over `svgCommands.ts`
//! and `svgShapes.ts`): a drawing's bytes and a recipe cut into a mesh, then
//! staged as a new part of an object or as a re-cut of an SVG part.
//!
//! The drawing is read as the browser reads a picked file (`File.text()`:
//! UTF-8 with a leading byte-order mark dropped and malformed sequences
//! replaced), and that text, re-encoded, is what the part stores. A reply
//! carries the cut's counts and size, the first unsupported features with
//! their total, and the digests of the mesh and of the drawing as stored.
pub mod shapes;

use crate::assets::{AssetPayload, content_digest};
use crate::commands::staged::{CaptureError, CapturedCommand, StagedWork};
use crate::commands::{PartPlacement, Recipe, StagedAsset};
use crate::drawn::{self, Error, stable, units};
use crate::ids::AssetId;
use crate::mesh::extrude::extrude;
use crate::model::{EmbossSvgPart, Number, Text};
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The asset ID a cut is encoded under until staging names it.
const PREVIEW_ASSET_ID: &str = "import:svg:preview";

/// The largest drawing a host may send, in bytes.
pub const MAX_DRAWING_BYTES: usize = 16 * 1024 * 1024;

/// Features a reply lists; `unsupportedCount` counts them all.
pub const MAX_REPLY_FEATURES: usize = 64;
/// UTF-16 units of an element name or detail a reply carries, and of a
/// refusal's message: each can echo arbitrary drawing text.
const MAX_FEATURE_ELEMENT: usize = 64;
const MAX_FEATURE_DETAIL: usize = 512;
const MAX_MESSAGE: usize = 1024;

/// One drawing's cut, encoded but not yet named, or why there is none.
pub struct PreparedSvgPart {
    outcome: Result<Cut, wire::SvgPartRefusal>,
}

struct Cut {
    file_name: Vec<u16>,
    depth_mm: f64,
    use_surface: bool,
    source_path: Option<Vec<u16>>,
    size_mm: [f64; 2],
    unsupported: Vec<shapes::Unsupported>,
    triangles: u64,
    vertices: u64,
    open_edges: u64,
    coincident_edges: u64,
    preview: AssetPayload,
    digest: Vec<u16>,
    drawing: Vec<u8>,
    drawing_digest: Vec<u16>,
}

fn clipped(text: &str, limit: usize) -> Vec<u16> {
    text.encode_utf16().take(limit).collect()
}

fn refused(code: wire::SvgPartRefusalCode, message: &str) -> wire::SvgPartRefusal {
    wire::SvgPartRefusal {
        code,
        message: clipped(message, MAX_MESSAGE),
    }
}

/// `new TextDecoder().decode(bytes)`: a leading byte-order mark is dropped
/// and each maximal malformed subsequence becomes U+FFFD.
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Cut a drawing with a recipe: an `SvgPartRequest` and the file's bytes.
pub fn prepare(request: &wire::SvgPartRequest, drawing: &[u8]) -> PreparedSvgPart {
    PreparedSvgPart {
        outcome: cut(request, drawing),
    }
}

/// `cutSvgDrawing`.
fn cut(request: &wire::SvgPartRequest, drawing: &[u8]) -> Result<Cut, wire::SvgPartRefusal> {
    use wire::SvgPartRefusalCode as Code;
    let source = decode(drawing);
    let depth_mm = request.depth_mm;
    if !depth_mm.is_finite() || depth_mm <= 0.0 {
        return Err(refused(
            Code::InvalidSvg,
            "An SVG part needs a depth greater than zero",
        ));
    }
    let width = match &request.width_mm {
        wire::OptionalFinite::Value(width) => Some(*width),
        wire::OptionalFinite::Absent(_) => None,
    };
    let read = shapes::read(&source, width).map_err(|error| {
        refused(
            match error.code {
                shapes::ErrorCode::InvalidSvg => Code::InvalidSvg,
                shapes::ErrorCode::NoGeometry => Code::NoGeometry,
            },
            &error.message,
        )
    })?;
    if !read.size_mm.iter().all(|size| size.is_finite()) {
        return Err(refused(
            Code::InvalidSvg,
            "That drawing is too large to cut",
        ));
    }
    let mesh = extrude(&read.contours, depth_mm);
    if mesh.indices.is_empty() {
        return Err(refused(
            Code::NoGeometry,
            "That drawing produced no geometry to cut",
        ));
    }
    let encoded = drawn::encode_cut(
        PREVIEW_ASSET_ID,
        &mesh.positions,
        &mesh.indices,
        request.file_name.clone(),
    )
    .map_err(|message| refused(Code::InvalidMesh, message))?;
    let drawing = source.into_bytes();
    Ok(Cut {
        file_name: request.file_name.clone(),
        depth_mm,
        use_surface: request.use_surface,
        source_path: match &request.source_path {
            // An empty path is no path.
            wire::OptionalText::Value(path) if !path.is_empty() => Some(path.clone()),
            _ => None,
        },
        size_mm: read.size_mm,
        unsupported: read.unsupported,
        triangles: (mesh.indices.len() / 3) as u64,
        vertices: (mesh.positions.len() / 3) as u64,
        open_edges: mesh.open_edges,
        coincident_edges: mesh.coincident_edges,
        preview: encoded.payload,
        digest: encoded.digest,
        drawing_digest: units(&content_digest(&drawing)),
        drawing,
    })
}

/// `svgArchivePath`: the part's drawing under its volume, every unit outside
/// `[A-Za-z0-9._-]` replaced (a surrogate pair is two), the name cut to 64.
pub fn archive_path(volume: &[u16], file_name: &[u16]) -> Vec<u16> {
    let safe = |unit: u16| match u8::try_from(unit) {
        Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => unit,
        _ => u16::from(b'_'),
    };
    let mut name: Vec<u16> = file_name.iter().take(64).map(|&u| safe(u)).collect();
    if name.is_empty() {
        name = units("drawing.svg");
    }
    let mut path = units("Metadata/svg/");
    path.extend(volume.iter().map(|&u| safe(u)));
    path.push(u16::from(b'/'));
    path.extend(name);
    path
}

/// `svgPartName`: the file's name without a final `.svg`, or `SVG part`.
pub fn part_name(file_name: &[u16]) -> Vec<u16> {
    let stem = match file_name.len().checked_sub(4) {
        Some(at)
            if file_name[at..]
                .iter()
                .zip(".svg".bytes())
                .all(|(&unit, byte)| {
                    u8::try_from(unit).is_ok_and(|u| u.eq_ignore_ascii_case(&byte))
                }) =>
        {
            &file_name[..at]
        }
        _ => file_name,
    };
    if stem.is_empty() {
        units("SVG part")
    } else {
        stem.to_vec()
    }
}

fn reason(reason: shapes::Reason) -> wire::SvgUnsupportedReason {
    use shapes::Reason::*;
    use wire::SvgUnsupportedReason as Wire;
    match reason {
        NeedsFont => Wire::NeedsFont,
        RasterImage => Wire::RasterImage,
        ExternalReference => Wire::ExternalReference,
        PaintEffect => Wire::PaintEffect,
        StrokeOnly => Wire::StrokeOnly,
        UnsupportedUnit => Wire::UnsupportedUnit,
        UnsupportedCommand => Wire::UnsupportedCommand,
        EmptyShape => Wire::EmptyShape,
        CssSelector => Wire::CssSelector,
    }
}

impl PreparedSvgPart {
    /// `SvgPartReply`: the cut's summary, or the refusal.
    pub fn reply(&self) -> wire::SvgPartReply {
        match &self.outcome {
            Err(refusal) => wire::SvgPartReply::Refused(refusal.clone()),
            Ok(cut) => wire::SvgPartReply::Prepared(wire::SvgPartPreview {
                triangle_count: cut.triangles,
                vertex_count: cut.vertices,
                open_edge_count: cut.open_edges,
                coincident_edge_count: cut.coincident_edges,
                size_mm: cut.size_mm.to_vec(),
                unsupported: cut
                    .unsupported
                    .iter()
                    .take(MAX_REPLY_FEATURES)
                    .map(|feature| wire::SvgUnsupportedFeature {
                        element: clipped(&feature.element, MAX_FEATURE_ELEMENT),
                        reason: reason(feature.reason),
                        detail: clipped(&feature.detail, MAX_FEATURE_DETAIL),
                    })
                    .collect(),
                unsupported_count: cut.unsupported.len() as u64,
                digest: cut.digest.clone(),
                byte_length: cut.preview.bytes.len() as u64,
                drawing_digest: cut.drawing_digest.clone(),
                drawing_byte_length: cut.drawing.len() as u64,
            }),
        }
    }

    /// Bytes `start..start + count` of the cut's indexed-mesh payload.
    pub fn mesh(&self, start: u64, count: u64) -> Result<&[u8], Error> {
        let cut = self.outcome.as_ref().map_err(|_| Error::Invalid)?;
        drawn::page(&cut.preview.bytes, start, count)
    }

    /// A new part of an object, or a re-cut of an existing SVG part, under
    /// the host's IDs (`packageSvgPart`).
    pub fn work(&self, stage: &wire::SvgPartStage, max_units: u64) -> Result<StagedWork, Error> {
        let cut = self.outcome.as_ref().map_err(|_| Error::Invalid)?;
        let (volume_id, asset_id, drawing_id) = match stage {
            wire::SvgPartStage::Add(add) => (&add.volume_id, &add.asset_id, &add.drawing_asset_id),
            wire::SvgPartStage::Edit(edit) => {
                (&edit.volume_id, &edit.asset_id, &edit.drawing_asset_id)
            }
        };
        let asset_id: AssetId = stable(asset_id)?;
        let drawing_id: AssetId = stable(drawing_id)?;
        let number = |v: f64| Number::new(v).map_err(|_| Error::Invalid);
        let part = Arc::new(EmbossSvgPart {
            path_in_3mf: Text::new(archive_path(volume_id, &cut.file_name)),
            drawing_asset_id: drawing_id.clone(),
            source_path: cut.source_path.clone().map(Text::new),
            depth_mm: number(cut.depth_mm)?,
            use_surface: cut.use_surface,
            width_mm: number(cut.size_mm[0])?,
            extra: Default::default(),
        });
        let asset =
            StagedAsset::new(drawn::named(&cut.preview, &asset_id)).map_err(|_| Error::Invalid)?;
        let drawing = StagedAsset::new(AssetPayload {
            descriptor: drawing_descriptor(&drawing_id, cut),
            bytes: cut.drawing.clone(),
        })
        .map_err(|_| Error::Invalid)?;
        let recipe = Recipe::Svg { drawing, part };
        let triangles = cut.triangles as f64;
        let captured = match stage {
            wire::SvgPartStage::Add(add) => CapturedCommand::add_drawn_part(
                PartPlacement {
                    object: stable(&add.object_id)?,
                    volume: stable(&add.volume_id)?,
                    asset: asset_id,
                    transform: drawn::transform(&add.transform)?,
                },
                asset,
                triangles,
                recipe,
                Some(Text::new(part_name(&cut.file_name))),
                max_units,
            ),
            wire::SvgPartStage::Edit(edit) => CapturedCommand::recut_part(
                stable(&edit.volume_id)?,
                asset,
                triangles,
                recipe,
                max_units,
            ),
        };
        captured
            .map(StagedWork::single)
            .map_err(|error| match error {
                CaptureError::Limit => Error::Limit,
                _ => Error::Invalid,
            })
    }
}

/// The stored drawing's descriptor, as `packageSvgPart` writes it.
fn drawing_descriptor(id: &AssetId, cut: &Cut) -> Value {
    let text = |value: &str| Value::String(units(value));
    let fields: BTreeMap<Vec<u16>, Value> = [
        ("id", Value::String(id.as_utf16().to_vec())),
        ("kind", text("extension")),
        ("digest", Value::String(cut.drawing_digest.clone())),
        ("byteLength", Value::Number(cut.drawing.len() as f64)),
        ("mediaType", text("image/svg+xml")),
        ("sourceFilename", Value::String(cut.file_name.clone())),
    ]
    .into_iter()
    .map(|(key, value)| (units(key), value))
    .collect();
    Value::Object(fields)
}
