//! Commands that bring whole records, and possibly their own immutable mesh
//! payload, into the project (`AddObjectCommand`, `AddObjectWithAssetCommand`,
//! `AddVolumeCommand`). A payload arrives as a validated lease, so applying and
//! redoing share its record instead of copying its bytes; history still charges
//! the browser's canonical record length plus the payload size.
use super::*;
use crate::assets::{AssetError, AssetLease, AssetPayload};
use crate::selection::SelectionSnapshot;

/// A staged payload: its validated, shareable record and typed descriptor.
#[derive(Clone)]
pub struct StagedAsset {
    lease: AssetLease,
    descriptor: Arc<SourceAssetDescriptor>,
}
impl StagedAsset {
    /// Validate a transfer once: descriptor shape, byte length and digest.
    pub fn new(payload: AssetPayload) -> Result<Self, AssetError> {
        let descriptor = SourceAssetDescriptor::from_value(payload.descriptor.clone())
            .map_err(|_| AssetError::InvalidDescriptor)?;
        let lease = AssetLease::from_payload(payload)?;
        Ok(Self {
            lease,
            descriptor: Arc::new(descriptor),
        })
    }
    /// A record a repository already validated, shared rather than copied.
    pub fn from_lease(lease: AssetLease) -> Result<Self, AssetError> {
        let descriptor = SourceAssetDescriptor::from_value(lease.descriptor().clone())
            .map_err(|_| AssetError::InvalidDescriptor)?;
        Ok(Self {
            lease,
            descriptor: Arc::new(descriptor),
        })
    }
    pub fn id(&self) -> &AssetId {
        self.lease.id()
    }
    pub fn descriptor(&self) -> &Arc<SourceAssetDescriptor> {
        &self.descriptor
    }
    /// The shared record every apply and redo installs.
    pub fn lease(&self) -> &AssetLease {
        &self.lease
    }
    pub fn byte_length(&self) -> u64 {
        self.lease.bytes().len() as u64
    }
    /// `context.assets.put(descriptor, bytes)` for a validated payload: only an
    /// immutable conflict with a different stored record can fail.
    fn install<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        match context.assets_mut().put_lease(&self.lease) {
            Ok(_) => Ok(()),
            Err(AssetError::ImmutableConflict) => Err(CommandError::Domain(text_parts(
                "Immutable asset ",
                self.id().as_utf16(),
                " cannot be replaced",
            ))),
            Err(_) => Err(CommandError::Encoding),
        }
    }
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
/// `projectReferencesAsset`: volumes, thumbnails and extension blobs.
fn references_asset(state: &ProjectState, id: &AssetId) -> bool {
    state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
        .any(|v| v.source.asset_id == *id)
        || state.thumbnails.iter().any(|t| t.asset_id == *id)
        || state.extension_blobs.iter().any(|b| b.asset_id == *id)
}
fn unknown_plate<E>(id: &PlateId) -> CommandError<E> {
    CommandError::Domain(text_parts("Unknown plate ", id.as_utf16(), ""))
}

/// `AddObjectCommand` (no payload) and `AddObjectWithAssetCommand`.
#[derive(Clone)]
pub(super) struct AddObject {
    plate: PlateId,
    object: Arc<ProjectObject>,
    asset: Option<StagedAsset>,
    inserted: bool,
}
impl AddObject {
    pub(super) fn new(
        plate: PlateId,
        object: Arc<ProjectObject>,
        asset: Option<StagedAsset>,
    ) -> Result<(Self, Text), PreparationError> {
        if let Some(asset) = &asset
            && !object
                .volumes
                .iter()
                .any(|v| v.source.asset_id == *asset.id())
        {
            let mut message = u("Object ");
            message.extend_from_slice(object.id.as_utf16());
            message.extend(" does not reference asset ".encode_utf16());
            message.extend_from_slice(asset.id().as_utf16());
            return Err(PreparationError::Domain(Text::new(message)));
        }
        let label = Text::new([&u("Add ")[..], object.name.units()].concat());
        Ok((
            Self {
                plate,
                object,
                asset,
                inserted: false,
            },
            label,
        ))
    }
    pub(super) fn has_asset(&self) -> bool {
        self.asset.is_some()
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let Some(p) = state.plates.iter().position(|plate| plate.id == self.plate) else {
            return Err(unknown_plate(&self.plate));
        };
        if state
            .plates
            .iter()
            .any(|plate| plate.objects.iter().any(|o| o.id == self.object.id))
        {
            return Err(CommandError::Domain(text_parts(
                "Object ",
                self.object.id.as_utf16(),
                " already exists",
            )));
        }
        let mut inserting = false;
        if let Some(asset) = &self.asset {
            let id = asset.id();
            let declared = state.source_assets.iter().find(|d| d.id == *id).cloned();
            if declared.is_some() != context.assets().has(id) {
                return Err(CommandError::Domain(text_parts(
                    "Asset ",
                    id.as_utf16(),
                    " is not declared consistently in the canonical bundle",
                )));
            }
            match declared {
                Some(declared) => {
                    if !declared
                        .matches_value(asset.lease.descriptor())
                        .map_err(|_| CommandError::Encoding)?
                    {
                        return Err(CommandError::Domain(text_parts(
                            "Asset ",
                            id.as_utf16(),
                            " metadata does not match its canonical declaration",
                        )));
                    }
                    asset.install(context)?;
                }
                None => {
                    let digest = asset.descriptor.digest.units();
                    if let Some(duplicate) = state
                        .source_assets
                        .iter()
                        .find(|d| d.digest.units() == digest)
                    {
                        return Err(CommandError::Domain(text_parts(
                            "Asset digest already exists as ",
                            duplicate.id.as_utf16(),
                            "; remap the object before adding it",
                        )));
                    }
                    if let Some(duplicate) = context.assets().find_id_by_digest(digest) {
                        return Err(CommandError::Domain(text_parts(
                            "Asset ",
                            duplicate.as_utf16(),
                            " exists outside the declared project bundle",
                        )));
                    }
                    asset.install(context)?;
                    let mut assets = state.source_assets.to_vec();
                    assets.push(asset.descriptor.clone());
                    state.source_assets = assets.into();
                    inserting = true;
                }
            }
        }
        let mut plates = state.plates.to_vec();
        let plate = Arc::make_mut(&mut plates[p]);
        let mut objects = plate.objects.to_vec();
        objects.push(self.object.clone());
        plate.objects = objects.into();
        state.plates = plates.into();
        context.replace(state, reason, PROJECT)?;
        self.inserted = inserting;
        let selected = match self.object.instances.first() {
            Some(instance) => SelectionRef::Instance(instance.id.clone()),
            None => SelectionRef::Object(self.object.id.clone()),
        };
        context.set_selection(&[selected], None)
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let Some(p) = state.plates.iter().position(|plate| plate.id == self.plate) else {
            return Err(unknown_plate(&self.plate));
        };
        if !state.plates[p]
            .objects
            .iter()
            .any(|o| o.id == self.object.id)
        {
            return Err(CommandError::Domain(text_parts(
                "Object ",
                self.object.id.as_utf16(),
                " is already absent",
            )));
        }
        let mut plates = state.plates.to_vec();
        let plate = Arc::make_mut(&mut plates[p]);
        // The browser filters every match; IDs are unique in a valid graph.
        plate.objects = plate
            .objects
            .iter()
            .filter(|o| o.id != self.object.id)
            .cloned()
            .collect::<Vec<_>>()
            .into();
        state.plates = plates.into();
        let remove = match &self.asset {
            Some(asset) if self.inserted && !references_asset(&state, asset.id()) => {
                state.source_assets = state
                    .source_assets
                    .iter()
                    .filter(|d| d.id != *asset.id())
                    .cloned()
                    .collect::<Vec<_>>()
                    .into();
                Some(asset.id().clone())
            }
            _ => None,
        };
        context.replace(state, reason, PROJECT)?;
        if let Some(id) = remove {
            context.assets_mut().remove(&id);
        }
        Ok(())
    }

    /// The canonical object plus the payload; a payload-free add has no
    /// estimate of its own, which the browser's history charges as one.
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match &self.asset {
            Some(asset) => Ok(canonical_length(self.object.as_ref())? + asset.byte_length()),
            None => Ok(1),
        }
    }
}

/// `AddVolumeCommand`: append a volume (kept in upstream role order) and its
/// payload unless the project already declares that asset.
#[derive(Clone)]
pub(super) struct AddVolume {
    object: ObjectId,
    volume: Arc<ProjectVolume>,
    asset: StagedAsset,
    applied: bool,
    added: bool,
    previous_selection: Option<SelectionSnapshot>,
}
impl AddVolume {
    pub(super) fn new(
        object: ObjectId,
        volume: Arc<ProjectVolume>,
        asset: StagedAsset,
    ) -> (Self, Text) {
        let label = Text::from_utf8(&format!(
            "Add {} to object",
            super::volume_roles::noun(volume.role)
        ));
        (
            Self {
                object,
                volume,
                asset,
                applied: false,
                added: false,
                previous_selection: None,
            },
            label,
        )
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let Some((p, o)) = locate_object(&state, &self.object) else {
            return Err(CommandError::Domain(text_parts(
                "Unknown object ",
                self.object.as_utf16(),
                "",
            )));
        };
        if state
            .plates
            .iter()
            .flat_map(|plate| plate.objects.iter())
            .any(|object| object.volumes.iter().any(|v| v.id == self.volume.id))
        {
            return Err(CommandError::Domain(text_parts(
                "Volume ",
                self.volume.id.as_utf16(),
                " already exists",
            )));
        }
        self.previous_selection = Some(context.selection());
        self.applied = true;
        let mut plates = state.plates.to_vec();
        let plate = Arc::make_mut(&mut plates[p]);
        let mut objects = plate.objects.to_vec();
        let object = Arc::make_mut(&mut objects[o]);
        let mut volumes = object.volumes.to_vec();
        volumes.push(self.volume.clone());
        volumes.sort_by_key(|v| super::volume_roles::rank(v.role));
        object.volumes = volumes.into();
        plate.objects = objects.into();
        state.plates = plates.into();
        if !state.source_assets.iter().any(|d| d.id == *self.asset.id()) {
            let mut assets = state.source_assets.to_vec();
            assets.push(self.asset.descriptor.clone());
            state.source_assets = assets.into();
            self.asset.install(context)?;
            self.added = true;
        }
        context.replace(state, reason, PROJECT)?;
        context.set_selection(&[SelectionRef::Volume(self.volume.id.clone())], None)
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        if !self.applied {
            return Err(CommandError::domain(
                "AddVolumeCommand has not been applied",
            ));
        }
        let mut state = context.snapshot().state().clone();
        let Some((p, o)) = locate_object(&state, &self.object) else {
            return Err(CommandError::Domain(text_parts(
                "Unknown object ",
                self.object.as_utf16(),
                "",
            )));
        };
        let Some(index) = state.plates[p].objects[o]
            .volumes
            .iter()
            .position(|v| v.id == self.volume.id)
        else {
            return Err(CommandError::Domain(text_parts(
                "Volume ",
                self.volume.id.as_utf16(),
                " is missing during undo",
            )));
        };
        let mut plates = state.plates.to_vec();
        let plate = Arc::make_mut(&mut plates[p]);
        let mut objects = plate.objects.to_vec();
        let object = Arc::make_mut(&mut objects[o]);
        let mut volumes = object.volumes.to_vec();
        volumes.remove(index);
        object.volumes = volumes.into();
        plate.objects = objects.into();
        state.plates = plates.into();
        if self.added {
            if let Some(index) = state
                .source_assets
                .iter()
                .position(|d| d.id == *self.asset.id())
            {
                let mut assets = state.source_assets.to_vec();
                assets.remove(index);
                state.source_assets = assets.into();
            }
            context.assets_mut().remove(self.asset.id());
        }
        context.replace(state, reason, PROJECT)?;
        if let Some(selection) = &self.previous_selection {
            context.set_selection(selection.refs(), selection.primary().cloned())?;
        }
        Ok(())
    }

    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        Ok(canonical_length(self.volume.as_ref())? + self.asset.byte_length())
    }
}
