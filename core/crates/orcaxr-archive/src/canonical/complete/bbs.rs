use super::*;
// Metadata regeneration must validate all BBS outputs, even when only four
// members participate in preservation. Model/sidecar errors cannot be skipped.
pub(super) fn reconcile_bbs<R: Read + Seek>(
    source: &mut CanonicalArchiveSource<R>,
    l: CompleteLimits,
    w: &mut Vec<ImportWarning>,
    b: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<BTreeSet<usize>, Failure> {
    let state = source.project.state();
    let preserved_paths = [
        settings::PATH,
        metadata::Member::ModelSettings.path(),
        metadata::Member::LayerRanges.path(),
        metadata::Member::LayerEvents.path(),
    ];
    let mut targets = BTreeMap::new();
    for path in preserved_paths {
        if state
            .extension_blobs
            .iter()
            .any(|blob| blob.path.units().iter().copied().eq(path.encode_utf16()))
        {
            continue;
        }
        if let Some(i) = source
            .archive
            .entries()
            .iter()
            .position(|e| !e.is_directory() && e.path() == path)
        {
            targets.insert(path, i);
        }
    }
    let assets = || {
        state
            .source_assets
            .iter()
            .filter_map(|d| source.assets.peek(&d.id))
    };
    let model = match model::Authoring::new(&source.project, assets(), l.model, &mut *c) {
        Ok(model) => model,
        Err(model::Error::MissingPrintableArea) => {
            metadata::check_drawings(state, assets(), l.metadata, &mut *c).map_err(Failure::Bbs)?;
            b.warn(w, ImportWarning::UnresolvedPlateCoordinates)?;
            return Ok(targets.values().copied().collect());
        }
        Err(error) => return Err(Failure::Bbs(error)),
    };
    let metadata =
        metadata::Authoring::new(&model, assets(), l.metadata, &mut *c).map_err(Failure::Bbs)?;
    let settings =
        settings::Authoring::new(&model, l.settings, &mut *c).map_err(Failure::Settings)?;
    let c = RefCell::new(c);
    let mut remaining = l.regenerated_bytes;
    regenerate(
        &mut source.archive,
        None,
        &mut remaining,
        |mut out| {
            model
                .write(&mut out, || (*c.borrow_mut())())
                .map(|_| ())
                .map_err(Failure::Bbs)
        },
        &c,
    )?;
    let mut preserved = BTreeSet::new();
    if !regenerate(
        &mut source.archive,
        targets.get(settings::PATH).copied(),
        &mut remaining,
        |mut out| {
            settings
                .write(&mut out, || (*c.borrow_mut())())
                .map(|_| ())
                .map_err(Failure::Settings)
        },
        &c,
    )? {
        preserved.insert(targets[settings::PATH]);
    }
    for member in metadata::Member::ALL {
        let target = targets.get(member.path()).copied();
        let same = regenerate(
            &mut source.archive,
            target,
            &mut remaining,
            |mut out| {
                metadata
                    .write(member, &mut out, || (*c.borrow_mut())())
                    .map(|_| ())
                    .map_err(Failure::Bbs)
            },
            &c,
        )?;
        if let Some(i) = target
            && (!same || !metadata.contains(member))
        {
            preserved.insert(i);
        }
    }
    Ok(preserved)
}
struct Counted<'a> {
    out: &'a mut dyn Write,
    left: &'a mut usize,
    overrun: bool,
}
impl Write for Counted<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.overrun || bytes.len() > *self.left {
            self.overrun = true;
            return Err(io::ErrorKind::InvalidData.into());
        }
        let n = self.out.write(bytes)?;
        *self.left -= n;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}
fn regenerate<R: Read + Seek, C: FnMut() -> bool>(
    a: &mut Archive<R>,
    target: Option<usize>,
    left: &mut usize,
    produce: impl FnOnce(&mut dyn Write) -> Result<(), Failure>,
    c: &RefCell<&mut C>,
) -> Result<bool, Failure> {
    if let Some(i) = target {
        let mut compare = a
            .compare_entry(i, || (*c.borrow_mut())())
            .map_err(Failure::Archive)?;
        let mut counted = Counted {
            out: &mut compare,
            left,
            overrun: false,
        };
        let result = produce(&mut counted);
        if counted.overrun {
            return Err(Failure::ResourceLimit);
        }
        if let Some(error) = compare.failure() {
            return Err(Failure::Archive(error));
        }
        result?;
        compare.finish().map_err(Failure::Archive)
    } else {
        let mut sink = io::sink();
        let mut counted = Counted {
            out: &mut sink,
            left,
            overrun: false,
        };
        let result = produce(&mut counted);
        if counted.overrun {
            return Err(Failure::ResourceLimit);
        }
        result?;
        Ok(true)
    }
}
