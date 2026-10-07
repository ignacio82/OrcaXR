use super::*;
use attributes::{Attribute, Name};
use std::io::{self, Write};
#[derive(Clone, Copy)]
enum Content<'a> {
    Text(&'a [u16]),
    Paint(usize, paint::Root<'a>),
}
#[derive(Clone, Copy)]
struct Emission<'a> {
    name: Name<'a>,
    content: Content<'a>,
}
const OBJECT: &[&str] = &["id", "type", "name"];
const VOLUME: &[&str] = &["id", "type", "name", "pid", "pindex"];
const COMPONENT: &[&str] = &["objectid", "transform"];
const BUILD: &[&str] = &["objectid", "transform", "printable"];
const FACET: &[&str] = &[
    "v1",
    "v2",
    "v3",
    "paint_color",
    "paint_supports",
    "paint_seam",
    "paint_fuzzy_skin",
    "paint_fuzzy",
];
impl Authoring<'_> {
    /// Write only 3D/3dmodel.model into a private destination. No durable host
    /// flush, package publication, or dirty-state acknowledgement is performed.
    /// Any failure requires discarding the entire provisional member/package.
    pub fn write(
        &self,
        out: &mut impl Write,
        cancelled: impl FnMut() -> bool,
    ) -> Result<usize, Error> {
        let mut w = xml::Writer::new(
            out,
            xml::Limits {
                output_bytes: self.limits.output_bytes,
                text_units: self.limits.output_bytes,
            },
            cancelled,
        )?;
        let mut scratch = Vec::new();
        w.literal("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" xmlns:ox=\"https://orcaxr.martinez.fyi/3mf/project/1\"")?;
        for (i, namespace) in self.namespaces.iter() {
            w.literal(" xmlns:ext")?;
            w.number(i as f64)?;
            w.literal("=\"")?;
            w.attribute(namespace)?;
            w.literal("\"")?;
        }
        w.literal(">\n <metadata name=\"Title\">")?;
        w.text(self.state.name.units())?;
        w.literal("</metadata>\n <metadata name=\"Application\">BambuStudio-2.3.4</metadata>\n <metadata name=\"BambuStudio:3mfVersion\">1</metadata>\n <metadata name=\"OrcaXR:Generator\">OrcaXR canonical project serializer</metadata>\n")?;
        for (has, line) in self.flags.into_iter().zip([
            " <metadata name=\"BambuStudio:FdmSupportsPaintingVersion\">0</metadata>\n",
            " <metadata name=\"BambuStudio:SeamPaintingVersion\">0</metadata>\n",
            " <metadata name=\"BambuStudio:MmPaintingVersion\">0</metadata>\n",
        ]) {
            if has {
                w.literal(line)?;
            }
        }
        w.literal(" <resources>\n")?;
        if !self.materials.is_empty() {
            w.literal("  <basematerials id=\"")?;
            w.number(self.material_id as f64)?;
            w.literal("\">\n")?;
            for material in &self.materials {
                w.literal("   <base name=\"")?;
                w.attribute(material.name)?;
                w.literal("\" displaycolor=\"")?;
                w.attribute(&material.color)?;
                w.literal("\"/>\n")?;
            }
            w.literal("  </basematerials>\n")?;
        }
        for object in &self.objects {
            for volume in &object.volumes {
                let Some(mesh) = &volume.mesh else {
                    continue;
                };
                w.literal("  <object id=\"")?;
                w.number(volume.id as f64)?;
                w.literal("\" type=\"model\" name=\"")?;
                w.attribute(volume.value.name.units())?;
                w.literal("\" ox:stable-id=\"")?;
                w.attribute(volume.value.id.as_utf16())?;
                w.literal("\"")?;
                if let Some(slot) = volume
                    .value
                    .filament_id
                    .as_ref()
                    .or(object.value.filament_id.as_ref())
                    .and_then(|id| self.slots.get(id.as_utf16()))
                {
                    w.literal(" pid=\"")?;
                    w.number(self.material_id as f64)?;
                    w.literal("\" pindex=\"")?;
                    w.number((slot - 1) as f64)?;
                    w.literal("\"")?;
                }
                self.attributes(&volume.attributes, VOLUME, &mut scratch, &mut w)?;
                w.literal(">\n   <mesh>\n    <vertices>\n")?;
                for vertex in mesh.positions() {
                    w.vertex(vertex)?;
                }
                w.literal("    </vertices>\n    <triangles>\n")?;
                let mut paint = volume.paint.entries.iter().peekable();
                let mut facets = volume.facets.iter().peekable();
                for (index, triangle) in mesh.triangles().enumerate() {
                    w.literal("     <triangle v1=\"")?;
                    w.number(f64::from(triangle[0]))?;
                    w.literal("\" v2=\"")?;
                    w.number(f64::from(triangle[1]))?;
                    w.literal("\" v3=\"")?;
                    w.number(f64::from(triangle[2]))?;
                    w.literal("\"")?;
                    scratch.clear();
                    while paint.peek().is_some_and(|e| e.triangle == index as u64) {
                        let entry = paint.next().unwrap();
                        scratch.push(Emission {
                            name: Name {
                                local: paint::NAMES[entry.channel],
                                prefix: 0,
                            },
                            content: Content::Paint(entry.channel, entry.root),
                        });
                    }
                    while facets.peek().is_some_and(|(t, _)| *t == index as u64) {
                        let (_, attributes) = facets.next().unwrap();
                        for attribute in attributes {
                            if attributes::included(attribute, FACET, true) {
                                self.push(attribute, &mut scratch, &mut w)?;
                            }
                        }
                    }
                    // Stable sort then retain the final duplicate, matching Map.set.
                    scratch.sort_by(|a, b| a.name.compare(b.name));
                    for (i, entry) in scratch.iter().enumerate() {
                        if scratch
                            .get(i + 1)
                            .is_some_and(|next| entry.name.compare(next.name).is_eq())
                        {
                            continue;
                        }
                        self.emit(*entry, &mut w)?;
                    }
                    w.literal("/>\n")?;
                }
                w.literal("    </triangles>\n   </mesh>\n  </object>\n")?;
            }
            if !object.volumes.iter().any(|v| v.mesh.is_some()) {
                continue;
            }
            w.literal("  <object id=\"")?;
            w.number(object.id as f64)?;
            w.literal("\" type=\"model\" name=\"")?;
            w.attribute(object.value.name.units())?;
            w.literal("\" ox:stable-id=\"")?;
            w.attribute(object.value.id.as_utf16())?;
            w.literal("\"")?;
            self.attributes(&object.attributes, OBJECT, &mut scratch, &mut w)?;
            w.literal(">\n   <components>\n")?;
            for volume in object.volumes.iter().filter(|v| v.mesh.is_some()) {
                w.literal("    <component objectid=\"")?;
                w.number(volume.id as f64)?;
                w.literal("\" transform=\"")?;
                w.transform(
                    &volume.value.transform,
                    [0.0, 0.0],
                    xml::MatrixOrder::ThreeMf,
                )?;
                w.literal("\"")?;
                self.attributes(&volume.component, COMPONENT, &mut scratch, &mut w)?;
                w.literal("/>\n")?;
            }
            w.literal("   </components>\n  </object>\n")?;
        }
        w.literal(" </resources>\n <build>\n")?;
        for object in &self.objects {
            if !object.volumes.iter().any(|v| v.mesh.is_some()) {
                continue;
            }
            for instance in &object.instances {
                w.literal("  <item objectid=\"")?;
                w.number(object.id as f64)?;
                w.literal("\" transform=\"")?;
                w.transform(
                    &instance.value.transform,
                    object.origin,
                    xml::MatrixOrder::ThreeMf,
                )?;
                w.literal("\" printable=\"")?;
                w.literal(if instance.value.printable { "1" } else { "0" })?;
                w.literal("\" ox:instance-id=\"")?;
                w.attribute(instance.value.id.as_utf16())?;
                w.literal("\"")?;
                self.attributes(&instance.attributes, BUILD, &mut scratch, &mut w)?;
                w.literal("/>\n")?;
            }
        }
        w.literal(" </build>\n</model>\n")?;
        Ok(w.finish()?)
    }
    fn push<'a, W: Write, C: FnMut() -> bool>(
        &self,
        attribute: &Attribute<'a>,
        scratch: &mut Vec<Emission<'a>>,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        let mut error = None;
        attributes::validate_value(attribute.value, &mut || match w.poll() {
            Ok(()) => false,
            Err(e) => {
                error = Some(e);
                true
            }
        })
        .map_err(|e| error.map_or(e, Error::Xml))?;
        scratch.push(Emission {
            name: self.namespaces.name(attribute),
            content: Content::Text(attribute.value),
        });
        Ok(())
    }
    fn attributes<'a, W: Write, C: FnMut() -> bool>(
        &self,
        attributes: &Attributes<'a>,
        reserved: &[&str],
        scratch: &mut Vec<Emission<'a>>,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        scratch.clear();
        for attr in attributes {
            if attributes::included(attr, reserved, false) {
                self.push(attr, scratch, w)?;
            }
        }
        scratch.sort_unstable_by(|a, b| a.name.compare(b.name));
        for pair in scratch.windows(2) {
            if pair[0].name.compare(pair[1].name).is_eq() {
                return Err(Error::DuplicateAttribute);
            }
        }
        for entry in scratch.iter() {
            self.emit(*entry, w)?;
        }
        Ok(())
    }
    fn emit<W: Write, C: FnMut() -> bool>(
        &self,
        entry: Emission<'_>,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        w.literal(" ")?;
        entry.name.write(w)?;
        w.literal("=\"")?;
        match entry.content {
            Content::Text(v) => w.attribute(v)?,
            Content::Paint(_, paint::Root::Leaf(n)) => {
                w.codec_bytes(facets::encode_leaf(n).as_bytes())?
            }
            Content::Paint(channel, paint::Root::Tree(root)) => {
                // Facet bytes are trusted ASCII from the codec, never imported
                // raw markup. Its 4 KiB writes use this writer's budget/polls.
                struct Sink<'a, 'b, W, C> {
                    writer: &'a mut xml::Writer<'b, W, C>,
                    error: Option<xml::Error>,
                }
                impl<W: Write, C: FnMut() -> bool> Write for Sink<'_, '_, W, C> {
                    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                        match self.writer.codec_bytes(b) {
                            Ok(()) => Ok(b.len()),
                            Err(e) => {
                                self.error = Some(e);
                                Err(io::ErrorKind::Other.into())
                            }
                        }
                    }
                    fn flush(&mut self) -> io::Result<()> {
                        Ok(())
                    }
                }
                let mut sink = Sink {
                    writer: w,
                    error: None,
                };
                let result = facets::write(
                    facets::Tree::Persisted(root),
                    |v| paint::state(channel, v, &self.slots),
                    &mut sink,
                    self.limits.output_bytes,
                    || false,
                );
                if let Some(e) = sink.error {
                    return Err(Error::Xml(e));
                }
                result?;
            }
        }
        w.literal("\"")?;
        Ok(())
    }
}
