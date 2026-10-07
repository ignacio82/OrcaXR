use super::*;
impl Authoring<'_, '_> {
    pub(super) fn model_settings<W: Write, C: FnMut() -> bool>(
        &self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        w.literal("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n")?;
        for object in &self.model.objects {
            w.poll()?;
            if !object.volumes.iter().any(|v| v.mesh.is_some()) {
                continue;
            }
            w.literal(" <object id=\"")?;
            w.number(object.id as f64)?;
            w.literal("\">\n")?;
            value::text(w, "name", object.value.name.units(), 2)?;
            if let Some(slot) = object
                .value
                .filament_id
                .as_ref()
                .and_then(|id| self.model.slots.get(id.as_utf16()))
            {
                value::number(w, "extruder", *slot as f64, 2)?;
            }
            value::config(w, &object.value.config, 2, false)?;
            for volume in &object.volumes {
                w.poll()?;
                if volume.mesh.is_none() {
                    continue;
                }
                w.literal("  <part id=\"")?;
                w.number(volume.id as f64)?;
                w.literal("\" subtype=\"")?;
                w.literal(match volume.value.role {
                    VolumeRole::Model => "normal_part",
                    VolumeRole::ParameterModifier => "modifier_part",
                    VolumeRole::NegativeVolume => "negative_part",
                    VolumeRole::SupportEnforcer => "support_enforcer",
                    VolumeRole::SupportBlocker => "support_blocker",
                })?;
                w.literal("\">\n")?;
                value::text(w, "name", volume.value.name.units(), 3)?;
                value::static_start(w, "matrix", 3)?;
                w.transform(
                    &volume.value.transform,
                    [0.0, 0.0],
                    xml::MatrixOrder::RowMajor4,
                )?;
                value::end(w)?;
                if let Some(slot) = volume
                    .value
                    .filament_id
                    .as_ref()
                    .and_then(|id| self.model.slots.get(id.as_utf16()))
                {
                    value::number(w, "extruder", *slot as f64, 3)?;
                }
                value::config(w, &volume.value.config, 3, false)?;
                emboss::write(w, volume.value, &self.drawing_ids)?;
                w.literal("   <mesh_stat edges_fixed=\"0\" degenerate_facets=\"0\" facets_removed=\"0\" facets_reversed=\"0\" backwards_edges=\"0\"/>\n  </part>\n")?;
            }
            w.literal(" </object>\n")?;
        }
        let mut identify = 1usize;
        let mut objects = self.model.objects.iter().peekable();
        for (index, plate) in self.model.plates.iter().enumerate() {
            w.literal(" <plate>\n")?;
            value::number(w, "plater_id", plate.order.get() + 1.0, 2)?;
            value::text(w, "plater_name", plate.name.units(), 2)?;
            value::static_start(w, "locked", 2)?;
            match field(plate.config.value(), "locked") {
                None | Some(Value::Null) => w.literal("0")?,
                Some(v) => value::bbs(w, v, true)?,
            }
            value::end(w)?;
            value::number(w, "printable", if plate.printable { 1.0 } else { 0.0 }, 2)?;
            value::config(w, &plate.config, 2, true)?;
            while objects.peek().is_some_and(|o| o.plate_index == index) {
                let object = objects.next().unwrap();
                w.poll()?;
                if !object.volumes.iter().any(|v| v.mesh.is_some()) {
                    continue;
                }
                for (ii, _) in object.instances.iter().enumerate() {
                    w.literal("  <model_instance>\n")?;
                    value::number(w, "object_id", object.id as f64, 3)?;
                    value::number(w, "instance_id", ii as f64, 3)?;
                    value::number(w, "identify_id", identify as f64, 3)?;
                    identify = identify
                        .checked_add(1)
                        .filter(|n| *n as u64 <= 9_007_199_254_740_991)
                        .ok_or(Error::ResourceLimit)?;
                    w.literal("  </model_instance>\n")?;
                }
            }
            w.literal(" </plate>\n")?;
        }
        w.literal(" <assemble/>\n</config>\n")?;
        Ok(())
    }
    pub(super) fn layer_ranges<W: Write, C: FnMut() -> bool>(
        &self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        w.literal("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<objects>\n")?;
        const EXTRUDER: &[u16] = &[101, 120, 116, 114, 117, 100, 101, 114];
        fn option<W: Write, C: FnMut() -> bool>(
            w: &mut xml::Writer<'_, W, C>,
            key: &[u16],
            v: &Value,
        ) -> Result<(), Error> {
            w.literal("   <option opt_key=\"")?;
            w.attribute(key)?;
            w.literal("\">")?;
            value::bbs(w, v, false)?;
            w.literal("</option>\n")?;
            Ok(())
        }
        for (index, object) in self.model.objects.iter().enumerate() {
            w.poll()?;
            if object.value.layer_ranges.is_empty() {
                continue;
            }
            w.literal(" <object id=\"")?;
            w.number((index + 1) as f64)?;
            w.literal("\">\n")?;
            for range in object.value.layer_ranges.iter() {
                w.literal("  <range min_z=\"")?;
                w.number(range.min_z_mm.get())?;
                w.literal("\" max_z=\"")?;
                w.number(range.max_z_mm.get())?;
                w.literal("\">\n")?;
                let slot = range
                    .filament_id
                    .as_ref()
                    .and_then(|id| self.model.slots.get(id.as_utf16()));
                let mut pending = slot;
                let Value::Object(fields) = range.config.value() else {
                    return Err(Error::Attribute);
                };
                for (key, v) in fields {
                    if key.as_slice() >= EXTRUDER
                        && let Some(slot) = pending.take()
                    {
                        option(w, EXTRUDER, &Value::Number(*slot as f64))?;
                    }
                    if slot.is_some() && key.as_slice() == EXTRUDER {
                        continue;
                    }
                    option(w, key, v)?;
                }
                if let Some(slot) = pending {
                    option(w, EXTRUDER, &Value::Number(*slot as f64))?;
                }
                w.literal("  </range>\n")?;
            }
            w.literal(" </object>\n")?;
        }
        w.literal("</objects>\n")?;
        Ok(())
    }
    pub(super) fn layer_events<W: Write, C: FnMut() -> bool>(
        &self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        w.literal("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<custom_gcodes_per_layer>\n")?;
        for (plate, events) in self.model.plates.iter().zip(&self.events) {
            w.poll()?;
            if events.is_empty() {
                continue;
            }
            w.literal("<plate>\n<plate_info id=\"")?;
            w.number(plate.order.get() + 1.0)?;
            w.literal("\"/>\n")?;
            for entry in events {
                let event = entry.layer_event.as_ref().unwrap();
                let (code, legacy) = match event.kind {
                    LayerEventType::ColorChange => (0.0, "M600"),
                    LayerEventType::Pause => (1.0, "M601"),
                    LayerEventType::ToolChange => (2.0, "tool_change"),
                    LayerEventType::Template => (3.0, ""),
                    LayerEventType::Custom => (4.0, ""),
                };
                w.literal("<layer top_z=\"")?;
                w.number(event.top_z_mm.get())?;
                w.literal("\" type=\"")?;
                w.number(code)?;
                w.literal("\" extruder=\"")?;
                w.number(event.tool_index.map_or(1.0, Number::get))?;
                w.literal("\" color=\"")?;
                w.attribute(event.color.as_ref().map_or(&[], Text::units))?;
                w.literal("\" extra=\"")?;
                if event.kind == LayerEventType::Custom {
                    w.attribute(entry.code.units())?;
                } else {
                    w.attribute(event.message.as_ref().map_or(&[], Text::units))?;
                }
                w.literal("\" gcode=\"")?;
                if event.kind == LayerEventType::Custom {
                    w.attribute(entry.code.units())?;
                } else {
                    w.literal(legacy)?;
                }
                w.literal("\"/>\n")?;
            }
            w.literal("<mode value=\"MultiExtruder\"/>\n</plate>\n")?;
        }
        w.literal("</custom_gcodes_per_layer>\n")?;
        Ok(())
    }
    pub(super) fn brim_ears<W: Write, C: FnMut() -> bool>(
        &self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        w.literal("brim_points_format_version=0\n")?;
        for (index, object) in self.model.objects.iter().enumerate() {
            w.poll()?;
            let Some(points) = &object.value.brim_ears else {
                continue;
            };
            if points.is_empty() {
                continue;
            }
            w.literal("object_id=")?;
            w.number((index + 1) as f64)?;
            w.literal("|")?;
            for (pi, point) in points.iter().enumerate() {
                for (i, value) in point
                    .position_mm
                    .iter()
                    .chain(std::iter::once(&point.head_front_radius_mm))
                    .enumerate()
                {
                    if pi != 0 || i != 0 {
                        w.literal(" ")?;
                    }
                    w.codec_bytes(
                        numbers::fixed6(value.get())
                            .map_err(xml::Error::Number)?
                            .as_bytes(),
                    )?;
                }
            }
            w.literal("\n")?;
        }
        Ok(())
    }
    pub(super) fn layer_heights<W: Write, C: FnMut() -> bool>(
        &self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        for (index, object) in self.model.objects.iter().enumerate() {
            w.poll()?;
            let Some(profile) = &object.value.layer_height_profile else {
                continue;
            };
            if profile.len() < 4 || !profile.len().is_multiple_of(2) {
                continue;
            }
            w.literal("object_id=")?;
            w.number((index + 1) as f64)?;
            w.literal("|")?;
            for (i, v) in profile.iter().enumerate() {
                if i != 0 {
                    w.literal(";")?;
                }
                w.codec_bytes(
                    numbers::fixed6(v.get())
                        .map_err(xml::Error::Number)?
                        .as_bytes(),
                )?;
            }
            w.literal("\n")?;
        }
        Ok(())
    }
}
