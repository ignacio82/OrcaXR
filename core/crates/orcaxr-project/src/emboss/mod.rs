//! Text embossing over a live session (`embossExchange.ts` over `emboss.ts`):
//! a recipe and the host's glyph outlines (already flattened to contours in
//! font units, keyed by code point) laid out, triangulated and extruded
//! (`mesh::extrude`), then staged as a new text part or a re-cut of one.
//!
//! A host without a font stack of its own reads the operator's font file
//! with [`font`] (the browser's TrueType reader) and cuts a recipe with it
//! ([`prepare_text`], `embossFontExchange.ts`).
pub mod font;
use crate::assets::AssetPayload;
use crate::commands::staged::{CaptureError, CapturedCommand, StagedWork};
use crate::commands::{PartPlacement, Recipe, StagedAsset};
use crate::drawn::{self, stable, units};
use crate::ids::AssetId;
use crate::js_math::{self, convert};
use crate::mesh::extrude::{Extruded, extrude};
use crate::model::{Decode, EmbossTextConfiguration};
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

pub use crate::drawn::{Error, MAX_PAGE};

/// The asset ID a preview is encoded under until staging names it.
const PREVIEW_ASSET_ID: &str = "import:emboss:preview";

struct Glyph {
    advance: f64,
    contours: Vec<Vec<[f64; 2]>>,
}

/// One recipe's mesh, encoded but not yet named, or why there is none.
pub struct PreparedEmboss {
    outcome: Result<Prepared, wire::EmbossRefusal>,
}

struct Prepared {
    configuration: Arc<EmbossTextConfiguration>,
    triangles: u64,
    vertices: u64,
    missing: Vec<u64>,
    open_edges: u64,
    coincident_edges: u64,
    preview: AssetPayload,
    digest: Vec<u16>,
}

fn refused(code: wire::EmbossRefusalCode, message: impl AsRef<str>) -> wire::EmbossRefusal {
    wire::EmbossRefusal {
        code,
        message: units(message.as_ref()),
    }
}

/// The recipe as the model records it, optional faces only when given.
fn configuration(wire: &wire::EmbossConfiguration) -> EmbossTextConfiguration {
    let text = |units: &[u16]| Value::String(units.to_vec());
    let key = |name: &str| units(name);
    let font = &wire.font;
    let mut fields: BTreeMap<Vec<u16>, Value> = BTreeMap::new();
    fields.insert(key("text"), text(&wire.text));
    fields.insert(key("styleName"), text(&wire.style_name));
    fields.insert(key("fontDescriptor"), text(&wire.font_descriptor));
    fields.insert(key("fontDescriptorType"), text(&wire.font_descriptor_type));
    let align = |name: &str| Value::String(units(name));
    let font_fields: BTreeMap<Vec<u16>, Value> = [
        ("charGapMm", Value::Number(font.char_gap_mm)),
        ("lineGapMm", Value::Number(font.line_gap_mm)),
        ("lineHeightMm", Value::Number(font.line_height_mm)),
        ("boldnessMm", Value::Number(font.boldness_mm)),
        ("skew", Value::Number(font.skew)),
        ("perGlyph", Value::Bool(font.per_glyph)),
        (
            "horizontal",
            align(match font.horizontal {
                wire::EmbossHorizontalAlign::Left => "left",
                wire::EmbossHorizontalAlign::Center => "center",
                wire::EmbossHorizontalAlign::Right => "right",
            }),
        ),
        (
            "vertical",
            align(match font.vertical {
                wire::EmbossVerticalAlign::Top => "top",
                wire::EmbossVerticalAlign::Center => "center",
                wire::EmbossVerticalAlign::Bottom => "bottom",
            }),
        ),
        ("collection", Value::Number(font.collection)),
    ]
    .into_iter()
    .map(|(k, v)| (key(k), v))
    .collect();
    fields.insert(key("font"), Value::Object(font_fields));
    fields.insert(
        key("projection"),
        Value::Object(
            [
                ("depthMm", Value::Number(wire.projection.depth_mm)),
                ("useSurface", Value::Bool(wire.projection.use_surface)),
            ]
            .into_iter()
            .map(|(k, v)| (key(k), v))
            .collect(),
        ),
    );
    for (name, value) in [
        ("family", &wire.family),
        ("faceName", &wire.face_name),
        ("style", &wire.style),
        ("weight", &wire.weight),
    ] {
        if let wire::OptionalText::Value(units) = value {
            fields.insert(key(name), text(units));
        }
    }
    EmbossTextConfiguration::from_value(Value::Object(fields))
        .expect("a wire recipe has the model's shape")
}

/// `assertEmbossConfiguration`.
fn check(configuration: &EmbossTextConfiguration) -> Result<(), wire::EmbossRefusal> {
    use wire::EmbossRefusalCode as Code;
    if configuration.text.units().is_empty() {
        return Err(refused(
            Code::InvalidConfiguration,
            "Embossed text cannot be empty",
        ));
    }
    let font = &configuration.font;
    for (field, value) in [
        ("lineHeightMm", font.line_height_mm),
        ("charGapMm", font.char_gap_mm),
        ("lineGapMm", font.line_gap_mm),
        ("boldnessMm", font.boldness_mm),
        ("skew", font.skew),
    ] {
        if !value.get().is_finite() {
            return Err(refused(
                Code::InvalidConfiguration,
                format!("{field} must be finite"),
            ));
        }
    }
    if font.line_height_mm.get() <= 0.0 {
        return Err(refused(
            Code::InvalidConfiguration,
            "Line height must be greater than zero",
        ));
    }
    if !convert::is_safe_integer(font.collection.get()) || font.collection.get() < 0.0 {
        return Err(refused(
            Code::InvalidConfiguration,
            "Font collection index must be a non-negative integer",
        ));
    }
    let depth = configuration.projection.depth_mm.get();
    if !depth.is_finite() || depth <= 0.0 {
        return Err(refused(
            Code::InvalidConfiguration,
            "Emboss depth must be greater than zero",
        ));
    }
    Ok(())
}

/// The UTF-16 code points of `text`, a lone surrogate standing for itself.
fn code_points(text: &[u16]) -> Vec<u64> {
    char::decode_utf16(text.iter().copied())
        .map(|unit| match unit {
            Ok(c) => u64::from(u32::from(c)),
            Err(error) => u64::from(error.unpaired_surrogate()),
        })
        .collect()
}

/// `buildEmbossedMesh`: lines laid out downward, aligned, then extruded.
fn build(
    configuration: &EmbossTextConfiguration,
    units_per_em: f64,
    glyphs: &HashMap<u64, Glyph>,
) -> Result<(Extruded, Vec<u64>), wire::EmbossRefusal> {
    use wire::EmbossRefusalCode as Code;
    check(configuration)?;
    if !units_per_em.is_finite() || units_per_em <= 0.0 {
        return Err(refused(
            Code::UnsupportedFont,
            "The font declares no usable units per em",
        ));
    }
    let font = &configuration.font;
    let (line_height, char_gap, line_gap, skew) = (
        font.line_height_mm.get(),
        font.char_gap_mm.get(),
        font.line_gap_mm.get(),
        font.skew.get(),
    );
    let scale = line_height / units_per_em;
    let mut missing = Vec::new();
    let mut seen_missing = HashSet::new();
    let lines: Vec<&[u16]> = configuration.text.units().split(|&u| u == 0x0a).collect();
    let mut placed: Vec<(Vec<Vec<[f64; 2]>>, f64)> = Vec::new();
    for line in &lines {
        let mut contours = Vec::new();
        let mut pen = 0.0f64;
        for code_point in code_points(line) {
            let Some(glyph) = glyphs.get(&code_point) else {
                if seen_missing.insert(code_point) {
                    missing.push(code_point);
                }
                continue;
            };
            for contour in &glyph.contours {
                let points: Vec<[f64; 2]> = contour
                    .iter()
                    .map(|&[x, y]| {
                        let scaled_y = y * scale;
                        // Upstream stores skew as a ratio along X by height.
                        [pen + x * scale + scaled_y * skew, scaled_y]
                    })
                    .collect();
                if points.len() >= 3 {
                    contours.push(points);
                }
            }
            pen += glyph.advance * scale + char_gap;
        }
        placed.push((contours, js_math::max(0.0, pen - char_gap)));
    }
    let line_step = line_height + line_gap;
    let count = lines.len() as f64;
    let total_height = count * line_height + js_math::max(0.0, count - 1.0) * line_gap;
    let widest = placed
        .iter()
        .fold(0.0, |widest, (_, width)| js_math::max(widest, *width));
    let mut all = Vec::new();
    for (line_index, (contours, width)) in placed.iter().enumerate() {
        use crate::model::{EmbossHorizontalAlign as H, EmbossVerticalAlign as Vt};
        let dx = match font.horizontal {
            H::Left => 0.0,
            H::Right => widest - width,
            H::Center => (widest - width) / 2.0,
        };
        let origin_x = if font.horizontal == H::Left {
            0.0
        } else {
            -widest / 2.0 + dx
        };
        let top = match font.vertical {
            Vt::Top => 0.0,
            Vt::Bottom => total_height,
            Vt::Center => total_height / 2.0,
        };
        let baseline = top - line_index as f64 * line_step - line_height;
        for contour in contours {
            all.push(
                contour
                    .iter()
                    .map(|&[x, y]| [x + origin_x, y + baseline])
                    .collect::<Vec<_>>(),
            );
        }
    }
    let mesh = extrude(&all, configuration.projection.depth_mm.get());
    if mesh.indices.is_empty() {
        return Err(refused(
            Code::NoGlyphs,
            if missing.is_empty() {
                "This text produced no outline to emboss"
            } else {
                "The chosen font has no glyph for any character in this text"
            },
        ));
    }
    Ok((mesh, missing))
}

/// `prepareEmbossWire`.
pub fn prepare(request: &wire::EmbossRequest) -> PreparedEmboss {
    PreparedEmboss {
        outcome: prepared(request),
    }
}

fn prepared(request: &wire::EmbossRequest) -> Result<Prepared, wire::EmbossRefusal> {
    let configuration = configuration(&request.configuration);
    // A later outline for a code point wins, as the browser's map keeps it.
    let mut glyphs = HashMap::new();
    for glyph in &request.font.glyphs {
        glyphs.insert(
            glyph.code_point,
            Glyph {
                advance: glyph.advance,
                contours: glyph
                    .contours
                    .iter()
                    .map(|contour| contour.iter().map(|p| [p[0], p[1]]).collect())
                    .collect(),
            },
        );
    }
    cut(configuration, request.font.units_per_em, &glyphs)
}

/// `prepareEmbossTextWire`: a recipe cut with a font the host read. The
/// recipe is checked first; then every character's outline is read in the
/// order the cut looks it up, the first that cannot be read refusing the cut.
pub fn prepare_text(font: &font::Font, request: &wire::EmbossTextRequest) -> PreparedEmboss {
    PreparedEmboss {
        outcome: prepared_text(font, request),
    }
}

fn prepared_text(
    font: &font::Font,
    request: &wire::EmbossTextRequest,
) -> Result<Prepared, wire::EmbossRefusal> {
    let configuration = configuration(&request.configuration);
    check(&configuration)?;
    let mut glyphs = HashMap::new();
    for code_point in font::code_points(configuration.text.units()) {
        if let Some(outline) = font
            .outline(code_point)
            .map_err(|unreadable| unreadable.refusal())?
        {
            glyphs.insert(
                u64::from(code_point),
                Glyph {
                    advance: outline.advance,
                    contours: outline.contours,
                },
            );
        }
    }
    cut(configuration, f64::from(font.units_per_em()), &glyphs)
}

/// The cut of a checked recipe with its glyphs, encoded under the preview ID.
fn cut(
    configuration: EmbossTextConfiguration,
    units_per_em: f64,
    glyphs: &HashMap<u64, Glyph>,
) -> Result<Prepared, wire::EmbossRefusal> {
    let (mesh, missing) = build(&configuration, units_per_em, glyphs)?;
    let first_line = configuration
        .text
        .units()
        .split(|&u| u == 0x0a)
        .next()
        .unwrap_or_default();
    let stem = &first_line[..first_line.len().min(40)];
    let filename: Vec<u16> = if stem.is_empty() {
        units("text")
    } else {
        stem.to_vec()
    }
    .into_iter()
    .chain(units(".emboss"))
    .collect();
    let encoded = drawn::encode_cut(PREVIEW_ASSET_ID, &mesh.positions, &mesh.indices, filename)
        .map_err(|message| refused(wire::EmbossRefusalCode::InvalidMesh, message))?;
    Ok(Prepared {
        configuration: Arc::new(configuration),
        triangles: (mesh.indices.len() / 3) as u64,
        vertices: (mesh.positions.len() / 3) as u64,
        missing,
        open_edges: mesh.open_edges,
        coincident_edges: mesh.coincident_edges,
        preview: encoded.payload,
        digest: encoded.digest,
    })
}

impl PreparedEmboss {
    /// `EmbossReply`: the cut's summary, or the refusal.
    pub fn reply(&self) -> wire::EmbossReply {
        match &self.outcome {
            Err(refusal) => wire::EmbossReply::Refused(refusal.clone()),
            Ok(p) => wire::EmbossReply::Prepared(wire::EmbossPreview {
                triangle_count: p.triangles,
                vertex_count: p.vertices,
                missing_code_points: p.missing.clone(),
                open_edge_count: p.open_edges,
                coincident_edge_count: p.coincident_edges,
                digest: p.digest.clone(),
                byte_length: p.preview.bytes.len() as u64,
            }),
        }
    }

    /// Bytes `start..start + count` of the cut's indexed-mesh payload.
    pub fn mesh(&self, start: u64, count: u64) -> Result<&[u8], Error> {
        let prepared = self.outcome.as_ref().map_err(|_| Error::Invalid)?;
        drawn::page(&prepared.preview.bytes, start, count)
    }

    /// A new text part of an object, or a re-cut of an existing one.
    pub fn work(&self, stage: &wire::EmbossStage, max_units: u64) -> Result<StagedWork, Error> {
        let prepared = self.outcome.as_ref().map_err(|_| Error::Invalid)?;
        let asset_id = match stage {
            wire::EmbossStage::Add(add) => &add.asset_id,
            wire::EmbossStage::Edit(edit) => &edit.asset_id,
        };
        let id: AssetId = stable(asset_id)?;
        let asset =
            StagedAsset::new(drawn::named(&prepared.preview, &id)).map_err(|_| Error::Invalid)?;
        let recipe = Recipe::Text(prepared.configuration.clone());
        let triangles = prepared.triangles as f64;
        let captured = match stage {
            wire::EmbossStage::Add(add) => {
                let placement = PartPlacement {
                    object: stable(&add.object_id)?,
                    volume: stable(&add.volume_id)?,
                    asset: id,
                    transform: drawn::transform(&add.transform)?,
                };
                CapturedCommand::add_drawn_part(
                    placement, asset, triangles, recipe, None, max_units,
                )
            }
            wire::EmbossStage::Edit(edit) => CapturedCommand::recut_part(
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
