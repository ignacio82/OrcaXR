use super::*;
use std::io::Write;
/// Deterministic OPC authoring from an exact final member inventory. It neither
/// allocates payload copies nor authorizes a package with omitted project parts.
pub struct Authoring {
    relationships: Result<Vec<Relationship>, Error>,
    types: Result<Vec<ContentType>, Error>,
    members: BTreeSet<Vec<u16>>,
    limits: Limits,
}
impl Authoring {
    pub fn new<'a>(
        state: &ProjectState,
        members: impl IntoIterator<Item = &'a str>,
        limits: Limits,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, Error> {
        let mut budget = Budget::new(limits)?;
        check(&mut cancelled)?;
        let relationships = preserved_relationships(state, &mut budget, &mut cancelled);
        let types = preserved_types(state, &mut budget, &mut cancelled);
        for error in [relationships.as_ref().err(), types.as_ref().err()]
            .into_iter()
            .flatten()
        {
            if matches!(error, Error::ResourceLimit | Error::Cancelled) {
                return Err(*error);
            }
        }
        let mut paths = BTreeSet::new();
        for path in members {
            check(&mut cancelled)?;
            budget.record()?;
            let p = units(path);
            budget.text(p.len())?;
            if !path_valid(&p) {
                return Err(Error::UnsafeTarget);
            }
            paths.insert(p);
        }
        Ok(Self {
            relationships,
            types,
            members: paths,
            limits,
        })
    }
    /// Provisional output; callers discard the entire private stream on failure.
    /// Returned warnings describe preserved links omitted from this projection.
    pub fn write_relationships(
        &self,
        source: Source,
        out: &mut impl Write,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Vec<Warning>, Error> {
        let mut rows = Vec::new();
        let mut dropped = Vec::new();
        if source == Source::Root {
            if !self.members.contains(&units(MODEL))
                || !self.members.contains(&units(ENVELOPE_PATH))
            {
                return Err(Error::MissingMember);
            }
            for (id, kind, target) in [
                ("rel-3dmodel", MODEL_TYPE, "/3D/3dmodel.model"),
                (
                    "rel-orcaxr-project",
                    STATE_TYPE,
                    "/Metadata/orcaxr/project-v1.json",
                ),
            ] {
                rows.push(Relationship {
                    source,
                    id: Text::from_utf8(id),
                    kind: Text::from_utf8(kind),
                    target: Text::from_utf8(target),
                    external: false,
                });
            }
        }
        for r in self.relationships.as_ref().map_err(|e| *e)? {
            check(&mut cancelled)?;
            if r.external
                || self
                    .members
                    .contains(&resolve_target(r.source, r.target.units())?)
            {
                if r.source == source {
                    rows.push(r.clone());
                }
            } else {
                dropped.push(r.target.clone());
            }
        }
        let mut ids = BTreeSet::new();
        for r in &rows {
            if !ids.insert(r.id.clone()) {
                return Err(Error::DuplicateRelationshipId);
            }
        }
        rows.sort_by(|a, b| {
            a.id.cmp(&b.id)
                .then(a.kind.cmp(&b.kind))
                .then(a.target.cmp(&b.target))
        });
        let mut writer = Output::new(out, self.limits.output_bytes, &mut cancelled);
        writer.bytes(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n")?;
        for r in rows {
            writer.bytes(b" <Relationship Id=\"")?;
            writer.attribute(r.id.units())?;
            writer.bytes(b"\" Type=\"")?;
            writer.attribute(r.kind.units())?;
            writer.bytes(b"\" Target=\"")?;
            writer.attribute(r.target.units())?;
            writer.bytes(if r.external {
                b"\" TargetMode=\"External\"/>\n"
            } else {
                b"\"/>\n"
            })?;
        }
        writer.bytes(b"</Relationships>\n")?;
        writer.finish()?;
        // Browser model-part authoring intentionally discards the shared warning
        // collector; the root writer reports omissions across both source parts.
        if source == Source::Root && !dropped.is_empty() {
            let count = dropped.len();
            dropped.sort();
            dropped.dedup();
            Ok(vec![Warning::DroppedRelationships {
                targets: dropped,
                count,
            }])
        } else {
            Ok(vec![])
        }
    }
    pub fn write_content_types(
        &self,
        out: &mut impl Write,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<(), Error> {
        let mut types = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        for entry in self.types.as_ref().map_err(|e| *e)? {
            check(&mut cancelled)?;
            match entry {
                ContentType::Default { extension, kind } => {
                    types.insert(lower_ascii(extension.units()), kind.clone());
                }
                ContentType::Override { part_name, kind } => {
                    overrides.insert(part_name.clone(), kind.clone());
                }
            }
        }
        for (ext, kind) in [
            (
                "rels",
                "application/vnd.openxmlformats-package.relationships+xml",
            ),
            (
                "model",
                "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
            ),
        ] {
            let ext = units(ext);
            if types.get(&ext).is_some_and(|v| !eq(v.units(), kind)) {
                return Err(Error::ContentType);
            }
            types.insert(ext, Text::from_utf8(kind));
        }
        for path in &self.members {
            check(&mut cancelled)?;
            if eq(path, CONTENT_TYPES) {
                continue;
            }
            if let Some(ext) = default_extension(path) {
                types
                    .entry(ext)
                    .or_insert_with(|| Text::from_utf8(media_type(path)));
            } else {
                let mut part = Vec::with_capacity(path.len() + 1);
                part.push(47);
                part.extend_from_slice(path);
                overrides
                    .entry(Text::new(part))
                    .or_insert_with(|| Text::from_utf8(media_type(path)));
            }
        }
        overrides.insert(
            Text::from_utf8(&format!("/{ENVELOPE_PATH}")),
            Text::from_utf8(STATE_CONTENT_TYPE),
        );
        let mut writer = Output::new(out, self.limits.output_bytes, &mut cancelled);
        writer.bytes(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n")?;
        for (ext, kind) in types {
            writer.bytes(b" <Default Extension=\"")?;
            writer.attribute(&ext)?;
            writer.bytes(b"\" ContentType=\"")?;
            writer.attribute(kind.units())?;
            writer.bytes(b"\"/>\n")?;
        }
        for (part, kind) in overrides {
            writer.bytes(b" <Override PartName=\"")?;
            writer.attribute(part.units())?;
            writer.bytes(b"\" ContentType=\"")?;
            writer.attribute(kind.units())?;
            writer.bytes(b"\"/>\n")?;
        }
        writer.bytes(b"</Types>\n")?;
        writer.finish()?;
        Ok(())
    }
}
struct Output<'a, W, C> {
    out: &'a mut W,
    remaining: usize,
    buffer: Vec<u8>,
    cancelled: &'a mut C,
}
impl<'a, W: Write, C: FnMut() -> bool> Output<'a, W, C> {
    fn new(out: &'a mut W, remaining: usize, cancelled: &'a mut C) -> Self {
        Self {
            out,
            remaining,
            buffer: Vec::with_capacity(crate::CHUNK_BYTES),
            cancelled,
        }
    }
    fn bytes(&mut self, b: &[u8]) -> Result<(), Error> {
        check(self.cancelled)?;
        self.remaining = self
            .remaining
            .checked_sub(b.len())
            .ok_or(Error::ResourceLimit)?;
        let mut b = b;
        while !b.is_empty() {
            let n = b.len().min(crate::CHUNK_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&b[..n]);
            b = &b[n..];
            if self.buffer.len() == crate::CHUNK_BYTES {
                self.finish()?;
            }
        }
        check(self.cancelled)
    }
    fn finish(&mut self) -> Result<(), Error> {
        check(self.cancelled)?;
        if !self.buffer.is_empty() {
            self.out
                .write_all(&self.buffer)
                .map_err(|e| Error::Io(e.kind()))?;
            self.buffer.clear();
        }
        check(self.cancelled)
    }
    fn attribute(&mut self, units: &[u16]) -> Result<(), Error> {
        for c in std::char::decode_utf16(units.iter().copied()) {
            let c = c.map_err(|_| Error::XmlCharacter)?;
            if (c as u32) < 32 && !matches!(c, '\t' | '\n' | '\r')
                || matches!(c, '\u{fffe}' | '\u{ffff}')
            {
                return Err(Error::XmlCharacter);
            }
            let escaped: Option<&[u8]> = match c {
                '&' => Some(b"&amp;".as_slice()),
                '"' => Some(b"&quot;"),
                '\'' => Some(b"&apos;"),
                '<' => Some(b"&lt;"),
                '>' => Some(b"&gt;"),
                _ => None,
            };
            if let Some(v) = escaped {
                self.bytes(v)?;
            } else {
                self.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
            }
        }
        Ok(())
    }
}
