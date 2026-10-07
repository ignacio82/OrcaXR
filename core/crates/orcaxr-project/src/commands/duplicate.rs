use super::*;
use std::io::{self, Write};

#[derive(Clone)]
struct ObjectIds {
    object: ObjectId,
    volumes: Vec<VolumeId>,
    instances: Vec<InstanceId>,
    ranges: Vec<LayerRangeId>,
}
#[derive(Clone)]
pub(super) struct Duplicate {
    source: PlateId,
    plate: PlateId,
    objects: Vec<ObjectIds>,
    gcode: Vec<CustomGcodeId>,
    thumbnails: Vec<ThumbnailId>,
    prepared: Option<Arc<Prepared>>,
    previous: Option<ValidatedProject>,
}
/// Full immutable canonical content, not a hash-only guard and not a retained
/// serialization of the potentially large plate/paint graph.
#[derive(Clone, PartialEq)]
struct Scope {
    plate: Arc<ProjectPlate>,
    gcode: Arc<[Arc<CustomGcode>]>,
    thumbnails: Arc<[Arc<ProjectThumbnail>]>,
}
impl Scope {
    fn capture<E>(state: &ProjectState, id: &PlateId) -> Result<Self, CommandError<E>> {
        Ok(Self {
            plate: state
                .plates
                .iter()
                .find(|p| &p.id == id)
                .cloned()
                .ok_or_else(|| unknown(id))?,
            gcode: state
                .custom_gcode
                .iter()
                .filter(|c| c.scope == GcodeScope::Plate && c.plate_id.as_ref() == Some(id))
                .cloned()
                .collect(),
            thumbnails: state
                .thumbnails
                .iter()
                .filter(|t| t.plate_id.as_ref() == Some(id))
                .cloned()
                .collect(),
        })
    }
    fn write(&self, out: &mut dyn Write) -> io::Result<()> {
        out.write_all(b"{\"customGcode\":")?;
        self.gcode.write_json(out)?;
        out.write_all(b",\"plate\":")?;
        self.plate.write_json(out)?;
        out.write_all(b",\"thumbnails\":")?;
        self.thumbnails.write_json(out)?;
        out.write_all(b"}")
    }
}
struct Prepared {
    source: Scope,
    cloned: Scope,
}
impl Duplicate {
    pub(super) fn new(v: wire::DuplicatePlate) -> Result<Self, PreparationError> {
        // Match preparation order: source, plate, each complete object plan,
        // G-code, then thumbnails. Stable ID errors expose no imported text.
        let source = id(v.source_plate_id)?;
        let plate = id(v.plate_id)?;
        let objects = v
            .objects
            .into_iter()
            .map(|o| {
                Ok(ObjectIds {
                    object: id(o.object_id)?,
                    volumes: ids(o.volume_ids)?,
                    instances: ids(o.instance_ids)?,
                    ranges: ids(o.layer_range_ids)?,
                })
            })
            .collect::<Result<_, PreparationError>>()?;
        Ok(Self {
            source,
            plate,
            objects,
            gcode: ids(v.custom_gcode_ids)?,
            thumbnails: ids(v.thumbnail_ids)?,
            prepared: None,
            previous: None,
        })
    }
    fn all_ids(&self) -> Vec<&[u16]> {
        let mut ids = vec![self.plate.as_utf16()];
        for o in &self.objects {
            ids.push(o.object.as_utf16());
            ids.extend(o.volumes.iter().map(EntityId::as_utf16));
            ids.extend(o.instances.iter().map(EntityId::as_utf16));
            ids.extend(o.ranges.iter().map(EntityId::as_utf16));
        }
        ids.extend(self.gcode.iter().map(EntityId::as_utf16));
        ids.extend(self.thumbnails.iter().map(EntityId::as_utf16));
        ids
    }
    fn prepare<E>(&self, state: &ProjectState, source: Scope) -> Result<Prepared, CommandError<E>> {
        if blank(source.plate.name.units()) {
            return Err(CommandError::Domain(text_parts(
                "Source plate ",
                self.source.as_utf16(),
                " has an empty name and cannot be duplicated",
            )));
        }
        if self.objects.len() != source.plate.objects.len() {
            return Err(CommandError::domain(format!(
                "Duplicate plate ID plan has {} object mappings; source plate requires {}",
                self.objects.len(),
                source.plate.objects.len()
            )));
        }
        for (index, (object, ids)) in source.plate.objects.iter().zip(&self.objects).enumerate() {
            for (kind, expected, actual) in [
                ("volume", object.volumes.len(), ids.volumes.len()),
                ("instance", object.instances.len(), ids.instances.len()),
                ("layer-range", object.layer_ranges.len(), ids.ranges.len()),
            ] {
                if expected != actual {
                    return Err(CommandError::domain(format!(
                        "Duplicate plate ID plan has {actual} {kind} IDs for object {index}; source object requires {expected}"
                    )));
                }
            }
        }
        for (kind, expected, actual) in [
            ("custom G-code", source.gcode.len(), self.gcode.len()),
            ("thumbnail", source.thumbnails.len(), self.thumbnails.len()),
        ] {
            if expected != actual {
                return Err(CommandError::domain(format!(
                    "Duplicate plate ID plan has {actual} {kind} IDs; source plate requires {expected}"
                )));
            }
        }
        available(state, &self.all_ids())?;
        let mut plate = (*source.plate).clone();
        plate.id = self.plate.clone();
        plate.name = text_parts("", source.plate.name.units(), " copy");
        plate.objects = source
            .plate
            .objects
            .iter()
            .zip(&self.objects)
            .map(|(original, ids)| {
                let mut object = (**original).clone();
                object.id = ids.object.clone();
                object.volumes = object
                    .volumes
                    .iter()
                    .zip(&ids.volumes)
                    .map(|(v, id)| {
                        let mut v = (**v).clone();
                        v.id = id.clone();
                        Arc::new(v)
                    })
                    .collect();
                object.instances = object
                    .instances
                    .iter()
                    .zip(&ids.instances)
                    .map(|(v, id)| {
                        let mut v = (**v).clone();
                        v.id = id.clone();
                        Arc::new(v)
                    })
                    .collect();
                object.layer_ranges = object
                    .layer_ranges
                    .iter()
                    .zip(&ids.ranges)
                    .map(|(v, id)| {
                        let mut v = (**v).clone();
                        v.id = id.clone();
                        Arc::new(v)
                    })
                    .collect();
                Arc::new(object)
            })
            .collect();
        let gcode = source
            .gcode
            .iter()
            .zip(&self.gcode)
            .map(|(c, id)| {
                let mut c = (**c).clone();
                c.id = id.clone();
                c.plate_id = Some(self.plate.clone());
                Arc::new(c)
            })
            .collect();
        let thumbnails = source
            .thumbnails
            .iter()
            .zip(&self.thumbnails)
            .map(|(t, id)| {
                let mut t = (**t).clone();
                t.id = id.clone();
                t.plate_id = Some(self.plate.clone());
                Arc::new(t)
            })
            .collect();
        Ok(Prepared {
            source,
            cloned: Scope {
                plate: Arc::new(plate),
                gcode,
                thumbnails,
            },
        })
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let before = context.snapshot();
        let mut state = before.state().clone();
        capacity(&state)?;
        let source = Scope::capture(&state, &self.source)?;
        if self.prepared.as_ref().is_some_and(|p| p.source != source) {
            return Err(CommandError::Domain(text_parts(
                "Source plate ",
                self.source.as_utf16(),
                " changed after its duplicate was prepared",
            )));
        }
        let prepared = match &self.prepared {
            Some(p) => p.clone(),
            None => Arc::new(self.prepare(&state, source.clone())?),
        };
        available(&state, &self.all_ids())?;
        let mut plates = ordered(&state);
        let index = plates
            .iter()
            .position(|p| p.id == self.source)
            .expect("source captured");
        plates.insert(index + 1, prepared.cloned.plate.clone());
        renumber(&mut plates);
        state.plates = plates.into();
        state.custom_gcode = interleave(
            &state.custom_gcode,
            &prepared.cloned.gcode,
            |c| c.scope == GcodeScope::Plate && c.plate_id.as_ref() == Some(&self.source),
            "custom G-code",
        )?;
        state.thumbnails = interleave(
            &state.thumbnails,
            &prepared.cloned.thumbnails,
            |t| t.plate_id.as_ref() == Some(&self.source),
            "thumbnail",
        )?;
        state.active_plate_id = self.plate.clone();
        if plate::<P::Error>(&state, &self.source)? != source.plate.as_ref() {
            return Err(CommandError::Domain(text_parts(
                "Source plate ",
                self.source.as_utf16(),
                " changed while preparing its duplicate",
            )));
        }
        context.replace(state, reason, PROJECT)?;
        select(context, &self.plate)?;
        self.previous = Some(before.project().clone());
        self.prepared = Some(prepared);
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self
            .previous
            .as_ref()
            .filter(|_| self.prepared.is_some())
            .ok_or_else(|| unapplied("DuplicatePlateCommand"))?;
        context.replace_validated(previous.clone(), reason, PROJECT)?;
        context.prune_selection();
        Ok(())
    }
    pub(super) fn estimate(&self) -> io::Result<u64> {
        let previous = match &self.previous {
            Some(p) => canonical_length(p.state())?,
            None => 0,
        };
        let Some(prepared) = &self.prepared else {
            return previous.checked_add(1).ok_or_else(overflow);
        };
        let mut count = Length::default();
        count.write_all(b"{\"customGcode\":")?;
        prepared.cloned.gcode.write_json(&mut count)?;
        count.write_all(b",\"plate\":")?;
        prepared.cloned.plate.write_json(&mut count)?;
        count.write_all(b",\"sourceFingerprint\":\"")?;
        count.nested_string = true;
        prepared.source.write(&mut count)?;
        count.nested_string = false;
        count.write_all(b"\",\"thumbnails\":")?;
        prepared.cloned.thumbnails.write_json(&mut count)?;
        count.write_all(b"}")?;
        previous.checked_add(count.units).ok_or_else(overflow)
    }
}
fn interleave<T: Clone, E>(
    entries: &[Arc<T>],
    clones: &[Arc<T>],
    matches: impl Fn(&T) -> bool,
    kind: &str,
) -> Result<Arc<[Arc<T>]>, CommandError<E>> {
    if clones.is_empty() {
        return Ok(entries.into());
    }
    let mut output = Vec::with_capacity(entries.len() + clones.len());
    let mut next = clones.iter();
    for entry in entries {
        output.push(entry.clone());
        if matches(entry) {
            output.push(
                next.next()
                    .ok_or_else(|| {
                        CommandError::domain(format!(
                            "Prepared plate duplicate is missing a {kind} clone"
                        ))
                    })?
                    .clone(),
            );
        }
    }
    if next.next().is_some() {
        return Err(CommandError::domain(format!(
            "Prepared plate duplicate has excess {kind} clones"
        )));
    }
    Ok(output.into())
}
fn available<E>(state: &ProjectState, ids: &[&[u16]]) -> Result<(), CommandError<E>> {
    available_for(state, ids, "plate duplicate")
}
pub(super) fn available_for<E>(
    state: &ProjectState,
    ids: &[&[u16]],
    scope: &str,
) -> Result<(), CommandError<E>> {
    let mut existing = BTreeSet::from([state.id.as_utf16()]);
    for p in state.plates.iter() {
        existing.insert(p.id.as_utf16());
        for o in p.objects.iter() {
            existing.insert(o.id.as_utf16());
            existing.extend(o.volumes.iter().map(|v| v.id.as_utf16()));
            existing.extend(o.instances.iter().map(|v| v.id.as_utf16()));
            existing.extend(o.layer_ranges.iter().map(|v| v.id.as_utf16()));
        }
    }
    existing.extend(state.filaments.physical.iter().map(|v| v.id.as_utf16()));
    existing.extend(state.filaments.mixed.iter().map(|v| v.id.as_utf16()));
    existing.extend(state.source_assets.iter().map(|v| v.id.as_utf16()));
    existing.extend(state.custom_gcode.iter().map(|v| v.id.as_utf16()));
    existing.extend(state.thumbnails.iter().map(|v| v.id.as_utf16()));
    existing.extend(state.extension_blobs.iter().map(|v| v.id.as_utf16()));
    let mut injected = BTreeSet::new();
    for id in ids {
        if existing.contains(id) {
            return Err(CommandError::Domain(text_parts(
                "Injected ID ",
                id,
                " already exists in the project",
            )));
        }
        if !injected.insert(*id) {
            return Err(CommandError::Domain(text_parts(
                "Injected ID ",
                id,
                &format!(" is duplicated within the {scope}"),
            )));
        }
    }
    Ok(())
}
/// Browser retention accounting uses UTF-16 canonical-string length. Count the
/// stream (including nested sourceFingerprint escaping) without materializing
/// large JSON/paint strings. Encoders produce valid UTF-8 and escape controls.
#[derive(Default)]
struct Length {
    units: u64,
    nested_string: bool,
}
fn overflow() -> io::Error {
    io::Error::other("canonical length overflow")
}
impl Write for Length {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for &byte in bytes {
            let units = if byte & 0xc0 == 0x80 {
                0
            } else if byte >= 0xf0 {
                2
            } else {
                1
            };
            let escaped = u64::from(self.nested_string && matches!(byte, b'"' | b'\\'));
            self.units = self
                .units
                .checked_add(units + escaped)
                .ok_or_else(overflow)?;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn canonical_length(value: &impl Encode) -> io::Result<u64> {
    let mut count = Length::default();
    value.write_json(&mut count)?;
    Ok(count.units)
}
