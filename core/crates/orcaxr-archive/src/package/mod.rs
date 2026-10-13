//! Complete private BBS/canonical package output from one admitted immutable
//! capture. This layer owns inventory/collision policy, not provider publication,
//! save acknowledgements, live revisions or application bindings.
mod assets;
mod warnings;
use crate::{
    bbs::model::{self, metadata, settings},
    canonical, opc, write as zip,
};
use orcaxr_project::{
    assets::AssetLease,
    ids::AssetId,
    model::{Encode, ProjectState},
    validation::ValidatedProject,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{self, Seek, Write},
};
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub records: usize,
    pub text_units: usize,
    pub asset_bytes: usize,
    pub total_asset_bytes: usize,
    pub warnings: usize,
    pub model: model::Limits,
    pub metadata: metadata::Limits,
    pub settings: settings::Limits,
    pub opc: opc::Limits,
    pub envelope: canonical::write::Limits,
    pub zip: zip::Limits,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ResourceLimit,
    AssetMembership,
    AssetMetadata,
    Path,
    Collision,
    Cancelled,
    NonemptyOutput,
    Io(io::ErrorKind),
    Model(model::Error),
    Settings(settings::Error),
    Opc(opc::Error),
    Envelope(canonical::write::Error),
    Zip(crate::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "package_{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<model::Error> for Error {
    fn from(v: model::Error) -> Self {
        Self::Model(v)
    }
}
impl From<settings::Error> for Error {
    fn from(v: settings::Error) -> Self {
        Self::Settings(v)
    }
}
impl From<opc::Error> for Error {
    fn from(v: opc::Error) -> Self {
        Self::Opc(v)
    }
}
impl From<canonical::write::Error> for Error {
    fn from(v: canonical::write::Error) -> Self {
        Self::Envelope(v)
    }
}
impl From<io::Error> for Error {
    fn from(v: io::Error) -> Self {
        Self::Io(v.kind())
    }
}
#[derive(PartialEq, Eq)]
pub enum Warning<'a> {
    Model(model::Warning),
    Metadata(metadata::Warning),
    Settings(settings::Warning),
    Opc(opc::Warning),
    UnsupportedDigest { asset: usize },
    PreservedOriginal { blob: usize },
    UnavailableFilament(&'a [u16]),
    CustomHooks,
    Extensions,
}
impl fmt::Debug for Warning<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("package_warning")
    }
}
#[derive(Debug)]
pub struct Receipt<'a> {
    pub zip: zip::Receipt,
    pub warnings: Vec<Warning<'a>>,
}
enum Member {
    Model,
    Settings,
    Metadata(metadata::Member),
    Data(AssetLease),
    Envelope,
    ModelRels,
    RootRels,
    Types,
}
struct Budget {
    records: usize,
    text: usize,
}
impl Budget {
    fn record(&mut self) -> Result<(), Error> {
        self.records = self.records.checked_sub(1).ok_or(Error::ResourceLimit)?;
        Ok(())
    }
    fn text(&mut self, n: usize) -> Result<(), Error> {
        self.text = self.text.checked_sub(n).ok_or(Error::ResourceLimit)?;
        Ok(())
    }
}
fn check(c: &mut impl FnMut() -> bool) -> Result<(), Error> {
    if c() { Err(Error::Cancelled) } else { Ok(()) }
}
fn eq(v: &[u16], s: &str) -> bool {
    v.iter().copied().eq(s.encode_utf16())
}
fn push<'a>(warnings: &mut Vec<Warning<'a>>, w: Warning<'a>, limit: usize) -> Result<(), Error> {
    if warnings.len() >= limit {
        return Err(Error::ResourceLimit);
    }
    warnings.push(w);
    Ok(())
}
fn preserved(path: &str) -> bool {
    matches!(
        path,
        "Metadata/project_settings.config"
            | "Metadata/model_settings.config"
            | "Metadata/layer_config_ranges.xml"
            | "Metadata/custom_gcode_per_layer.xml"
    )
}
fn path(units: &[u16], limits: Limits, budget: &mut Budget) -> Result<String, Error> {
    budget.text(units.len())?;
    let max = limits.zip.zip.path_bytes.min(512);
    if units.len() as u64 > max {
        return Err(Error::Path);
    }
    let value = String::from_utf16(units).map_err(|_| Error::Path)?;
    crate::validate_package_path(&value, max).map_err(|_| Error::Path)?;
    Ok(value)
}
/// Background export of one session-owned frozen bundle. The host retains its
/// original export guard and owns private staging, flush/close and publication;
/// this function cannot acknowledge a saved checkpoint or consult live state.
pub fn write_capture<'a, W: Write + Seek>(
    capture: &'a orcaxr_project::export::ExportCapture,
    output: &mut W,
    limits: Limits,
    cancelled: impl FnMut() -> bool,
) -> Result<Receipt<'a>, Error> {
    write(
        capture.project().project(),
        (0..capture.asset_count()).filter_map(|i| capture.asset(i)),
        output,
        limits,
        cancelled,
    )
}
/// Assets must be immutable leases from the same capture as `project`. Exact
/// membership/descriptors are checked before output; repository admission already
/// proves lengths and supported digests. All writes remain private until success.
pub fn write<'a, W: Write + Seek>(
    project: &'a ValidatedProject,
    assets: impl IntoIterator<Item = AssetLease>,
    output: &mut W,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Receipt<'a>, Error> {
    package(
        project,
        assets.into_iter().collect(),
        Target::Native(output),
        limits,
        &mut cancelled,
    )
}

/// The same package, written as the browser's serializer writes it: every
/// member through fflate's compressor and ZIP ([`crate::fflate`]), so a
/// project the browser would save is these bytes exactly — Export as 3MF….
/// Each member is produced whole before it is compressed (the browser holds
/// the whole archive); only compressed members are held until [output] gets
/// the archive, which needs no seeking.
pub fn write_browser<'a>(
    project: &'a ValidatedProject,
    assets: impl IntoIterator<Item = AssetLease>,
    output: &mut dyn Write,
    limits: Limits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Receipt<'a>, Error> {
    package(
        project,
        assets.into_iter().collect(),
        Target::Browser(output),
        limits,
        &mut cancelled,
    )
}

/// [`write_browser`] of an export capture.
pub fn write_capture_browser<'a>(
    capture: &'a orcaxr_project::export::ExportCapture,
    output: &mut dyn Write,
    limits: Limits,
    cancelled: impl FnMut() -> bool,
) -> Result<Receipt<'a>, Error> {
    write_browser(
        capture.project().project(),
        (0..capture.asset_count()).filter_map(|i| capture.asset(i)),
        output,
        limits,
        cancelled,
    )
}

/// A seekable destination, as one type: the package writer is compiled once
/// for every caller (the WASM project set counts its bytes).
trait SeekWrite: Write + Seek {}
impl<T: Write + Seek> SeekWrite for T {}

/// Where a package goes: the native writer's seekable destination, or the browser's compressor.
enum Target<'o> {
    Native(&'o mut dyn SeekWrite),
    Browser(&'o mut dyn Write),
}

fn package<'a>(
    project: &'a ValidatedProject,
    assets: Vec<AssetLease>,
    target: Target<'_>,
    limits: Limits,
    mut cancelled: &mut dyn FnMut() -> bool,
) -> Result<Receipt<'a>, Error> {
    check(&mut cancelled)?;
    let mut budget = Budget {
        records: limits.records,
        text: limits.text_units,
    };
    let state = project.state();
    let mut warnings = vec![];
    let assets = assets::admit(
        state,
        assets,
        limits,
        &mut budget,
        &mut warnings,
        &mut cancelled,
    )?;
    let model = model::Authoring::new(
        project,
        assets.values().cloned(),
        limits.model,
        &mut cancelled,
    )?;
    let metadata = metadata::Authoring::new(
        &model,
        assets.values().cloned(),
        limits.metadata,
        &mut cancelled,
    )?;
    let settings = settings::Authoring::new(&model, limits.settings, &mut cancelled)?;
    for &w in model.warnings() {
        // The model exposes local omissions for standalone callers. Package
        // warnings report unavailable filament IDs once across every reference
        // scope; the material-count warning already covers slots above 64.
        if matches!(
            w,
            model::Warning::UnavailableAssignment { .. } | model::Warning::UnavailableColor { .. }
        ) {
            continue;
        }
        push(&mut warnings, Warning::Model(w), limits.warnings)?;
    }
    for &w in metadata.warnings() {
        push(&mut warnings, Warning::Metadata(w), limits.warnings)?;
    }
    for &w in settings.warnings() {
        push(&mut warnings, Warning::Settings(w), limits.warnings)?;
    }
    warnings::global(state, &mut warnings, limits, &mut budget, &mut cancelled)?;
    let mut members = BTreeMap::from([
        (model::PATH.to_owned(), Member::Model),
        (settings::PATH.to_owned(), Member::Settings),
        (opc::MODEL_RELS.to_owned(), Member::ModelRels),
    ]);
    for m in metadata::Member::ALL {
        if metadata.contains(m) {
            members.insert(m.path().to_owned(), Member::Metadata(m));
        }
    }
    for (name, asset) in metadata.drawings() {
        check(&mut cancelled)?;
        budget.record()?;
        members.insert(
            path(name, limits, &mut budget)?,
            Member::Data(asset.clone()),
        );
    }
    let mappings = assets::paths(
        state,
        &assets,
        &mut members,
        limits,
        &mut budget,
        &mut cancelled,
    )?;
    let mut blobs: Vec<_> = state.extension_blobs.iter().enumerate().collect();
    for (_, blob) in &blobs {
        check(&mut cancelled)?;
        budget.record()?;
        budget.text(blob.id.as_utf16().len())?;
    }
    blobs.sort_by(|a, b| a.1.path.cmp(&b.1.path).then(a.1.id.cmp(&b.1.id)));
    let mut blob_paths = BTreeSet::new();
    for (index, blob) in blobs {
        check(&mut cancelled)?;
        let name = path(blob.path.units(), limits, &mut budget)?;
        if !blob_paths.insert(name.clone()) {
            return Err(Error::Collision);
        }
        if canonical::STRUCTURAL.contains(&name.as_str()) && !preserved(&name) {
            return Err(Error::Path);
        }
        let asset = assets.get(&blob.asset_id).ok_or(Error::AssetMembership)?;
        if let Some(existing) = members.get(&name) {
            let mut comparison = Compare {
                expected: asset.bytes(),
                offset: 0,
                equal: true,
            };
            generated(
                existing,
                &model,
                &metadata,
                &settings,
                &mut comparison,
                &mut cancelled,
            )?;
            if comparison.equal && comparison.offset == asset.bytes().len() {
                continue;
            }
            if !(preserved(&name)
                && blob
                    .relationships
                    .iter()
                    .any(|r| eq(r.units(), "orcaxr:preserve-original")))
            {
                return Err(Error::Collision);
            }
            push(
                &mut warnings,
                Warning::PreservedOriginal { blob: index },
                limits.warnings,
            )?;
        }
        members.insert(name, Member::Data(asset.clone()));
    }
    // Preserve the browser's authoring stages: model relationships precede the
    // envelope, root relationships precede their own member/content-type part.
    let model_rels = opc::Authoring::new(
        state,
        members.keys().map(String::as_str),
        limits.opc,
        &mut cancelled,
    )?;
    members.insert(canonical::ENVELOPE_PATH.to_owned(), Member::Envelope);
    let root_rels = opc::Authoring::new(
        state,
        members.keys().map(String::as_str),
        limits.opc,
        &mut cancelled,
    )?;
    members.insert(opc::ROOT_RELS.to_owned(), Member::RootRels);
    let types = opc::Authoring::new(
        state,
        members.keys().map(String::as_str),
        limits.opc,
        &mut cancelled,
    )?;
    members.insert(opc::CONTENT_TYPES.to_owned(), Member::Types);
    if members.len() as u64 > limits.zip.zip.entries {
        return Err(Error::ResourceLimit);
    }
    let entries: Vec<_> = members.iter().collect();
    let zip_members: Vec<_> = entries
        .iter()
        .map(|(p, _)| zip::Member {
            path: p.as_str(),
            compression: zip::Compression::Auto,
        })
        .collect();
    let maps: Vec<_> = mappings.iter().map(|(id, p)| (*id, p.as_str())).collect();
    let cancellation = RefCell::new(cancelled);
    let mut produce = |i: usize, mut out: &mut dyn Write| {
        let mut c = || (cancellation.borrow_mut())();
        match entries[i].1 {
            Member::Envelope => {
                canonical::write::envelope(project, &maps, &mut out, limits.envelope, &mut c)?;
            }
            Member::ModelRels => {
                model_rels.write_relationships(opc::Source::Model, &mut out, &mut c)?;
            }
            Member::RootRels => {
                for w in root_rels.write_relationships(opc::Source::Root, &mut out, &mut c)? {
                    push(&mut warnings, Warning::Opc(w), limits.warnings)?;
                }
            }
            Member::Types => types.write_content_types(&mut out, &mut c)?,
            member => generated(member, &model, &metadata, &settings, &mut out, &mut c)?,
        }
        Ok::<_, Error>(())
    };
    let zip = match target {
        Target::Native(mut output) => {
            match zip::archive(&mut output, &zip_members, limits.zip, &mut produce, || {
                (cancellation.borrow_mut())()
            }) {
                Ok(v) => v,
                Err(zip::Error::Producer(e)) => return Err(e),
                Err(zip::Error::Archive(e)) => return Err(Error::Zip(e)),
                Err(zip::Error::NonemptyOutput) => return Err(Error::NonemptyOutput),
            }
        }
        Target::Browser(output) => {
            let mut archive = crate::fflate::Zip::new(limits.zip.zip);
            let mut uncompressed = 0u64;
            for (i, member) in zip_members.iter().enumerate() {
                if (cancellation.borrow_mut())() {
                    return Err(Error::Zip(crate::Error::Cancelled));
                }
                let mut bytes = Vec::new();
                produce(i, &mut bytes)?;
                uncompressed += bytes.len() as u64;
                archive.add(member.path, &bytes).map_err(Error::Zip)?;
            }
            let members = zip_members.len();
            let bytes = archive.finish(output).map_err(Error::Zip)?;
            zip::Receipt {
                bytes,
                members,
                uncompressed_bytes: uncompressed,
            }
        }
    };
    Ok(Receipt { zip, warnings })
}
fn generated<W: Write>(
    member: &Member,
    model: &model::Authoring<'_>,
    metadata: &metadata::Authoring<'_, '_>,
    settings: &settings::Authoring<'_, '_>,
    out: &mut W,
    c: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    match member {
        Member::Model => {
            model.write(out, c)?;
        }
        Member::Settings => {
            settings.write(out, c)?;
        }
        Member::Metadata(m) => {
            metadata.write(*m, out, c)?;
        }
        Member::Data(a) => {
            for b in a.bytes().chunks(crate::CHUNK_BYTES) {
                check(c)?;
                out.write_all(b)?;
            }
        }
        _ => return Err(Error::Collision),
    }
    Ok(())
}
struct Compare<'a> {
    expected: &'a [u8],
    offset: usize,
    equal: bool,
}
impl Write for Compare<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let end = self
            .offset
            .checked_add(b.len())
            .ok_or(io::ErrorKind::InvalidData)?;
        self.equal &= self.expected.get(self.offset..end) == Some(b);
        self.offset = end;
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
