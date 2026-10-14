//! Complete the canonical-envelope import path. Foreign 3MF parsing remains a
//! separate adapter. All work consumes private staging and publishes no live state.
mod adopt;
mod bbs;
use super::{
    CanonicalArchiveSource, Error, Failure, MigrationCounts, STRUCTURAL, admit, check_cancel,
};
use crate::{
    Archive,
    bbs::model::{self, metadata, settings},
    opc,
};
use adopt::{collect_ids, fnv, imported_id, thumbnail};
use bbs::reconcile_bbs;
use orcaxr_project::{
    assets::{AssetLease, AssetPayload, AssetRepository, content_digest},
    ids::{AssetId, EntityId, ExtensionBlobId, ThumbnailId},
    model::*,
    session::PreparedDocument,
    validation::{TimestampPolicy, ValidatedProject},
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Seek, Write},
    sync::Arc,
};

#[derive(Clone, Copy, Debug)]
pub struct CompleteLimits {
    pub records: usize,
    pub text_units: usize,
    pub assets: usize,
    pub asset_bytes: usize,
    pub total_asset_bytes: usize,
    pub warnings: usize,
    /// Aggregate regenerated BBS bytes, including members that are discarded.
    pub regenerated_bytes: usize,
    pub model: model::Limits,
    pub metadata: metadata::Limits,
    pub settings: settings::Limits,
    pub opc: opc::Limits,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ImportWarning {
    DenseChannels(usize),
    FalseFuzzyAssignments(usize),
    UnsupportedDigest {
        asset: usize,
    },
    Opc(opc::Warning),
    UnresolvedPlateCoordinates,
    /// Ordinal in the completed graph, independent of ZIP directory order.
    PreservedOriginal {
        blob: usize,
    },
    PreservedEntries(usize),
    /// Foreign import findings with the browser's exact message text.
    Foreign(crate::bbs::foreign::Warning),
}
/// A complete canonical archive with an admitted graph and exact asset bundle.
/// Its guarded adoption belongs to the host's original Open/reset operation.
pub struct CompletedCanonicalArchive {
    project: ValidatedProject,
    assets: AssetRepository,
    warnings: Vec<ImportWarning>,
    migrations: MigrationCounts,
}
impl CompletedCanonicalArchive {
    pub(crate) fn new(
        project: ValidatedProject,
        assets: AssetRepository,
        warnings: Vec<ImportWarning>,
        migrations: MigrationCounts,
    ) -> Self {
        Self {
            project,
            assets,
            warnings,
            migrations,
        }
    }
    pub fn project(&self) -> &ValidatedProject {
        &self.project
    }
    pub fn assets(&self) -> &AssetRepository {
        &self.assets
    }
    pub fn asset(&self, id: &AssetId) -> Option<AssetLease> {
        self.assets.peek(id)
    }
    pub fn warnings(&self) -> &[ImportWarning] {
        &self.warnings
    }
    pub fn migrations(&self) -> MigrationCounts {
        self.migrations
    }
    pub fn into_prepared(self) -> Result<(PreparedDocument, Vec<ImportWarning>), Failure> {
        let document =
            PreparedDocument::new(self.project, self.assets).map_err(|_| Failure::Bundle)?;
        Ok((document, self.warnings))
    }
}
pub(crate) struct Budget {
    pub(crate) records: usize,
    pub(crate) text: usize,
    pub(crate) warnings: usize,
}
impl Budget {
    pub(crate) fn record(&mut self) -> Result<(), Failure> {
        charge(&mut self.records, 1)
    }
    pub(crate) fn text(&mut self, n: usize) -> Result<(), Failure> {
        charge(&mut self.text, n)
    }
    pub(crate) fn warn(
        &mut self,
        out: &mut Vec<ImportWarning>,
        w: ImportWarning,
    ) -> Result<(), Failure> {
        charge(&mut self.warnings, 1)?;
        out.push(w);
        Ok(())
    }
}
fn charge(left: &mut usize, n: usize) -> Result<(), Failure> {
    *left = left.checked_sub(n).ok_or(Failure::ResourceLimit)?;
    Ok(())
}
impl<R: Read + Seek> CanonicalArchiveSource<R> {
    /// Complete OPC and BBS reconciliation, adopt every remaining file, and admit
    /// the final bundle. Payloads are moved into immutable storage; original
    /// declared leases keep their identity. Failure discards the private result.
    pub fn complete<P: TimestampPolicy>(
        self,
        limits: CompleteLimits,
        timestamps: &mut P,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<CompletedCanonicalArchive, Error<P::Error>> {
        check_cancel(&mut cancelled)?;
        let (mut source, opc_warnings) =
            self.reconcile_opc(limits.opc, timestamps, &mut cancelled)?;
        let mut budget = Budget {
            records: limits.records,
            text: limits.text_units,
            warnings: limits.warnings,
        };
        let mut warnings = Vec::new();
        if source.migrations.dense_channels > 0 {
            budget.warn(
                &mut warnings,
                ImportWarning::DenseChannels(source.migrations.dense_channels),
            )?;
        }
        if source.migrations.false_fuzzy_assignments > 0 {
            budget.warn(
                &mut warnings,
                ImportWarning::FalseFuzzyAssignments(source.migrations.false_fuzzy_assignments),
            )?;
        }
        for warning in opc_warnings {
            budget.warn(&mut warnings, ImportWarning::Opc(warning))?;
        }
        for &asset in &source.unsupported_digests {
            budget.warn(&mut warnings, ImportWarning::UnsupportedDigest { asset })?;
        }
        let preserved = reconcile_bbs(
            &mut source,
            limits,
            &mut warnings,
            &mut budget,
            &mut cancelled,
        )?;
        let owned = source
            .mappings
            .iter()
            .map(|m| m.entry)
            .collect::<BTreeSet<_>>();
        let project = source.project;
        let state = adopt_unowned(
            &mut source.archive,
            project,
            &mut source.assets,
            owned,
            &|path| STRUCTURAL.contains(&path),
            &preserved,
            limits,
            &mut budget,
            &mut warnings,
            &mut cancelled,
        )?;
        check_cancel(&mut cancelled)?;
        let project = admit(state, timestamps)?;
        check_cancel(&mut cancelled)?;
        Ok(CompletedCanonicalArchive {
            project,
            assets: source.assets,
            warnings,
            migrations: source.migrations,
        })
    }
}
fn add_asset_bytes(n: usize, total: &mut usize, l: CompleteLimits) -> Result<(), Failure> {
    if n > l.asset_bytes {
        return Err(Failure::ResourceLimit);
    }
    *total = total
        .checked_add(n)
        .filter(|n| *n <= l.total_asset_bytes)
        .ok_or(Failure::ResourceLimit)?;
    Ok(())
}
/// Adopt every member that is neither owned nor a declared extension blob as an
/// immutable asset and preserved extension blob, in UTF-16 path order with
/// archive-fingerprint IDs. `structural` paths are owned unless their original
/// bytes must be preserved. Budget charges and their order are shared by the
/// canonical and foreign import paths.
#[allow(clippy::too_many_arguments)]
pub(crate) fn adopt_unowned<R: Read + Seek, E>(
    archive: &mut Archive<R>,
    project: ValidatedProject,
    assets: &mut AssetRepository,
    owned: BTreeSet<usize>,
    structural: &dyn Fn(&str) -> bool,
    preserved: &BTreeSet<usize>,
    limits: CompleteLimits,
    budget: &mut Budget,
    warnings: &mut Vec<ImportWarning>,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<ProjectState, Error<E>> {
    let mut occupied = collect_ids(project.state(), budget, cancelled)?;
    let mut owned = owned;
    let mut sorted = Vec::new();
    let mut declared_paths = BTreeSet::new();
    for blob in project.state().extension_blobs.iter() {
        check_cancel(cancelled)?;
        budget.record()?;
        budget.text(blob.path.units().len())?;
        declared_paths.insert(blob.path.units());
    }
    for (index, e) in archive.entries().iter().enumerate() {
        check_cancel(cancelled)?;
        budget.record()?;
        budget.text(e.path().encode_utf16().count())?;
        if e.is_directory() {
            continue;
        }
        if structural(e.path()) && !preserved.contains(&index) {
            owned.insert(index);
        }
        if declared_paths.contains(e.path().encode_utf16().collect::<Vec<_>>().as_slice()) {
            owned.insert(index);
        }
        if !owned.contains(&index) {
            sorted.push(index);
        }
    }
    sorted.sort_unstable_by(|&a, &b| {
        archive.entries()[a]
            .path()
            .encode_utf16()
            .cmp(archive.entries()[b].path().encode_utf16())
    });
    // Full asset count/byte budgets precede allocation of any new payload.
    let mut total = 0usize;
    let existing = project.state().source_assets.len();
    if existing
        .checked_add(sorted.len())
        .is_none_or(|n| n > limits.assets)
    {
        return Err(Failure::ResourceLimit.into());
    }
    for d in project.state().source_assets.iter() {
        check_cancel(cancelled)?;
        budget.record()?;
        let lease = assets.peek(&d.id).ok_or(Failure::Bundle)?;
        add_asset_bytes(lease.bytes().len(), &mut total, limits)?;
    }
    for &i in &sorted {
        let n =
            usize::try_from(archive.entries()[i].bytes()).map_err(|_| Failure::ResourceLimit)?;
        add_asset_bytes(n, &mut total, limits)?;
    }
    let seed = if sorted.is_empty() {
        0
    } else {
        archive
            .source_fingerprint(&mut *cancelled)
            .map_err(Failure::Archive)?
    };
    let mut state = project.to_candidate();
    drop(project);
    let mut descriptors = state.source_assets.to_vec();
    let mut blobs = state.extension_blobs.to_vec();
    let mut thumbnails = state.thumbnails.to_vec();
    for (ordinal, &index) in sorted.iter().enumerate() {
        check_cancel(cancelled)?;
        let entry = &archive.entries()[index];
        let path = entry.path().to_owned();
        let units = path.encode_utf16().collect::<Vec<_>>();
        let length = usize::try_from(entry.bytes()).map_err(|_| Failure::ResourceLimit)?;
        budget.text(
            units
                .len()
                .checked_mul(3)
                .and_then(|n| n.checked_add(4))
                .ok_or(Failure::ResourceLimit)?,
        )?;
        let token = format!("{:016x}-{}", fnv(path.as_bytes()), ordinal + 1);
        let asset_id: AssetId = imported_id(
            &format!("import:zip:{seed:016x}-asset-{token}"),
            &mut occupied,
            budget,
            cancelled,
        )?;
        // Exact reservation prevents a second payload allocation at repository
        // ownership transfer. The reader bounds every provisional append.
        let mut payload = Vec::new();
        payload
            .try_reserve_exact(length)
            .map_err(|_| Failure::ResourceLimit)?;
        archive
            .read_entry(index, &mut payload, &mut *cancelled)
            .map_err(Failure::Archive)?;
        let media = opc::media_type(&units);
        let descriptor = Arc::new(SourceAssetDescriptor {
            id: asset_id.clone(),
            kind: if media.starts_with("image/") {
                SourceAssetKind::Thumbnail
            } else {
                SourceAssetKind::Extension
            },
            digest: Text::from_utf8(&content_digest(&payload)),
            byte_length: Number::new(length as f64).map_err(|_| Failure::ResourceLimit)?,
            media_type: Text::from_utf8(media),
            source_filename: Some(Text::new(units.clone())),
            provenance: Some(Arc::new(AssetProvenance {
                source: AssetOrigin::Import,
                uri: Some(Text::from_utf8(&format!("3mf:{path}"))),
                imported_at: None,
                extra: Default::default(),
            })),
            mesh: None,
            extra: Default::default(),
        });
        if let Some((plate_id, width, height)) =
            thumbnail(&path, &payload, &state, budget, cancelled)?
        {
            let id: ThumbnailId = imported_id(
                &format!("import:zip:{seed:016x}-thumbnail-{token}"),
                &mut occupied,
                budget,
                cancelled,
            )?;
            thumbnails.push(Arc::new(ProjectThumbnail {
                id,
                asset_id: asset_id.clone(),
                plate_id: Some(plate_id),
                width: Number::new(width as f64).unwrap(),
                height: Number::new(height as f64).unwrap(),
                extra: Default::default(),
            }));
        }
        let id: ExtensionBlobId = imported_id(
            &format!("import:zip:{seed:016x}-extension-{token}"),
            &mut occupied,
            budget,
            cancelled,
        )?;
        let original = preserved.contains(&index);
        let mut relationships = vec![Text::from_utf8("orcaxr:preserve-package-entry")];
        if original {
            relationships.push(Text::from_utf8("orcaxr:preserve-original"));
            budget.warn(
                warnings,
                ImportWarning::PreservedOriginal { blob: blobs.len() },
            )?;
        }
        blobs.push(Arc::new(ExtensionBlob {
            id,
            namespace: Text::from_utf8(if original {
                "urn:orcaxr:preserved-bbs-metadata"
            } else {
                "urn:orcaxr:preserved-3mf-entry"
            }),
            path: Text::new(units),
            asset_id,
            relationships: relationships.into(),
            extra: Default::default(),
        }));
        check_cancel(cancelled)?;
        assets
            .put_owned(AssetPayload {
                descriptor: descriptor.to_value().map_err(|_| Failure::Bundle)?,
                bytes: payload,
            })
            .map_err(|e| Error::Asset(orcaxr_project::ingress::AssetInputError::Asset(e)))?;
        descriptors.push(descriptor);
    }
    if !sorted.is_empty() {
        budget.warn(warnings, ImportWarning::PreservedEntries(sorted.len()))?;
    }
    state.source_assets = descriptors.into();
    state.extension_blobs = blobs.into();
    state.thumbnails = thumbnails.into();
    Ok(state)
}
