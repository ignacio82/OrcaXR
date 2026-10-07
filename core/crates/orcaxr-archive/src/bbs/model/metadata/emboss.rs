use super::*;
pub(super) fn prepare(volume: &ProjectVolume, budget: &mut Budget) -> Result<(), Error> {
    if let Some(c) = &volume.emboss_text {
        for v in [
            &c.text,
            &c.style_name,
            &c.font_descriptor,
            &c.font_descriptor_type,
        ] {
            budget.text(v.units())?;
        }
        for v in [&c.family, &c.face_name, &c.style, &c.weight]
            .into_iter()
            .flatten()
        {
            budget.text(v.units())?;
        }
    } else if let Some(svg) = &volume.emboss_svg
        && let Some(path) = &svg.source_path
    {
        budget.text(path.units())?;
    }
    Ok(())
}
fn attribute<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    prefix: &'static str,
    v: &[u16],
) -> Result<(), Error> {
    w.literal(prefix)?;
    w.emboss_attribute(v)?;
    w.literal("\"")?;
    Ok(())
}
fn number<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    prefix: &'static str,
    v: f64,
) -> Result<(), Error> {
    w.literal(prefix)?;
    w.codec_bytes(numbers::emboss(v).map_err(xml::Error::Number)?.as_bytes())?;
    w.literal("\"")?;
    Ok(())
}
pub(super) fn write<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    v: &ProjectVolume,
    drawing_ids: &BTreeSet<&[u16]>,
) -> Result<(), Error> {
    if let Some(c) = &v.emboss_text {
        attribute(w, "   <slic3rpe:text text=\"", c.text.units())?;
        attribute(w, " style_name=\"", c.style_name.units())?;
        attribute(w, " font_descriptor=\"", c.font_descriptor.units())?;
        if c.font_descriptor_type.units().is_empty() {
            w.literal(" font_descriptor_type=\"undefined\"")?;
        } else {
            attribute(
                w,
                " font_descriptor_type=\"",
                c.font_descriptor_type.units(),
            )?;
        }
        let font = &c.font;
        for (prefix, n) in [
            (" char_gap=\"", font.char_gap_mm),
            (" line_gap=\"", font.line_gap_mm),
        ] {
            if n.get() != 0.0 {
                number(w, prefix, n.get())?;
            }
        }
        number(w, " line_height=\"", font.line_height_mm.get())?;
        for (prefix, n) in [(" boldness=\"", font.boldness_mm), (" skew=\"", font.skew)] {
            if n.get() != 0.0 {
                number(w, prefix, n.get())?;
            }
        }
        if font.per_glyph {
            w.literal(" per_glyph=\"1\"")?;
        }
        w.literal(" horizontal=\"")?;
        w.literal(font.horizontal.as_str())?;
        w.literal("\" vertical=\"")?;
        w.literal(match font.vertical {
            EmbossVerticalAlign::Top => "top",
            EmbossVerticalAlign::Center => "middle",
            EmbossVerticalAlign::Bottom => "bottom",
        })?;
        w.literal("\"")?;
        if font.collection.get() != 0.0 {
            w.literal(" collection=\"")?;
            w.number(font.collection.get())?;
            w.literal("\"")?;
        }
        for (prefix, v) in [
            (" family=\"", &c.family),
            (" face_name=\"", &c.face_name),
            (" style=\"", &c.style),
            (" weight=\"", &c.weight),
        ] {
            if let Some(v) = v
                && !v.units().is_empty()
            {
                attribute(w, prefix, v.units())?;
            }
        }
        w.literal("/>\n   <slic3rpe:shape")?;
        number(w, " depth=\"", c.projection.depth_mm.get())?;
        if c.projection.use_surface {
            w.literal(" use_surface=\"1\"")?;
        }
        w.literal("/>\n")?;
    } else if let Some(svg) = &v.emboss_svg {
        w.literal("   <slic3rpe:shape")?;
        if drawing_ids.contains(svg.drawing_asset_id.as_utf16()) {
            if let Some(path) = &svg.source_path
                && !path.units().is_empty()
            {
                attribute(w, " filepath=\"", path.units())?;
            }
            attribute(w, " filepath3mf=\"", svg.path_in_3mf.units())?;
        }
        number(w, " depth=\"", svg.depth_mm.get())?;
        if svg.use_surface {
            w.literal(" use_surface=\"1\"")?;
        }
        w.literal("/>\n")?;
    }
    Ok(())
}
