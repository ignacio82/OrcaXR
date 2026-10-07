//! Immutable command input, measured before it enters a session staging pool.
//! The charge is encoded UTF-16 units, not a claim about resident memory. Hosts
//! still budget their parser/preparation tasks independently. History estimates
//! cannot serve this purpose: an unapplied paste has a history estimate of one.
use super::*;
use orcaxr_contracts::canonical::Value;
use std::io::{self, Write};

#[derive(Debug)]
pub enum CaptureError {
    Limit,
    Encoding,
    Preparation(PreparationError),
    /// One asset ID with different payloads in the same work.
    AssetConflict,
}
impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for CaptureError {}

/// Constructors capture and measure every retained input. Callers cannot forge
/// a smaller charge or mutate the resulting command. Preparation belongs to an
/// owned task; this is not a large synchronous operation for an authority worker.
pub struct CapturedCommand {
    pub(crate) command: PreparedCommand,
    units: u64,
    /// Distinct payloads this command carries, charged by byte length.
    assets: Vec<StagedAsset>,
}
impl CapturedCommand {
    pub fn units(&self) -> u64 {
        self.units
    }
    pub fn asset_bytes(&self) -> u64 {
        self.assets.iter().map(StagedAsset::byte_length).sum()
    }
    fn plain(command: PreparedCommand, units: u64) -> Self {
        Self {
            command,
            units,
            assets: Vec::new(),
        }
    }
    fn with_assets(command: PreparedCommand, units: u64, assets: Vec<StagedAsset>) -> Self {
        let mut distinct: Vec<StagedAsset> = Vec::with_capacity(assets.len());
        for asset in assets {
            if !distinct.iter().any(|a| a.id() == asset.id()) {
                distinct.push(asset);
            }
        }
        Self {
            command,
            units,
            assets: distinct,
        }
    }
    pub fn instance(
        object: ObjectId,
        instance: Arc<ProjectInstance>,
        index: Option<Number>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"createInstance\",")?;
            object.write_json(out)?;
            out.write_all(b",")?;
            instance.write_json(out)?;
            out.write_all(b",")?;
            optional(&index, out)?;
            out.write_all(b"]")
        })?;
        Ok(Self::plain(
            PreparedCommand::create_instance(object, instance, index),
            units,
        ))
    }
    pub fn paste(
        template: Arc<ProjectObject>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"pasteObject\",")?;
            template.write_json(out)?;
            out.write_all(b",")?;
            ids.object_id.write_json(out)?;
            out.write_all(b",")?;
            list(&ids.volume_ids, out)?;
            out.write_all(b",")?;
            list(&ids.instance_ids, out)?;
            out.write_all(b",")?;
            list(&ids.layer_range_ids, out)?;
            out.write_all(b",")?;
            optional(&destination, out)?;
            out.write_all(b",")?;
            optional(&name, out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::paste_object(template, ids, destination, name)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::plain(command, units))
    }
    /// Existing small intents can participate in the same staged transaction.
    /// Their normal strict decoder and resource limits still precede execution.
    pub fn intent(json: &str, max_units: u64) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"intent\",")?;
            out.write_all(json.as_bytes())?;
            out.write_all(b"]")
        })?;
        let command = prepare_intent(json).map_err(CaptureError::Preparation)?;
        Ok(Self::plain(command, units))
    }
    pub fn clipboard_paste(
        clipboard: Arc<crate::clipboard::ClipboardData>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"pasteObjectWithAssets\",")?;
            clipboard.object().write_json(out)?;
            out.write_all(b",")?;
            ids.object_id.write_json(out)?;
            out.write_all(b",")?;
            list(&ids.volume_ids, out)?;
            out.write_all(b",")?;
            list(&ids.instance_ids, out)?;
            out.write_all(b",")?;
            list(&ids.layer_range_ids, out)?;
            out.write_all(b",")?;
            optional(&destination, out)?;
            out.write_all(b",")?;
            list(clipboard.descriptors(), out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::paste_clipboard(clipboard, ids, destination)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::plain(command, units))
    }
    /// `["addObject",plateId,record]`.
    pub fn add_object(
        plate: PlateId,
        object: Arc<ProjectObject>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"addObject\",")?;
            plate.write_json(out)?;
            out.write_all(b",")?;
            object.write_json(out)?;
            out.write_all(b"]")
        })?;
        Ok(Self::plain(
            PreparedCommand::add_object(plate, object),
            units,
        ))
    }
    /// `["addObjectWithAsset",plateId,record,descriptor]`.
    pub fn add_object_with_asset(
        plate: PlateId,
        object: Arc<ProjectObject>,
        asset: StagedAsset,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"addObjectWithAsset\",")?;
            plate.write_json(out)?;
            out.write_all(b",")?;
            object.write_json(out)?;
            out.write_all(b",")?;
            asset.lease().descriptor().write_canonical(&mut &mut *out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::add_object_with_asset(plate, object, asset.clone())
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, vec![asset]))
    }
    /// `["addVolume",objectId,record,descriptor]`.
    pub fn add_volume(
        object: ObjectId,
        volume: Arc<ProjectVolume>,
        asset: StagedAsset,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"addVolume\",")?;
            object.write_json(out)?;
            out.write_all(b",")?;
            volume.write_json(out)?;
            out.write_all(b",")?;
            asset.lease().descriptor().write_canonical(&mut &mut *out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::add_volume(object, volume, asset.clone());
        Ok(Self::with_assets(command, units, vec![asset]))
    }
    /// `["replaceVolumeMesh",guard,descriptor]`.
    pub fn replace_volume_mesh(
        guard: TopologyGuard,
        asset: StagedAsset,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"replaceVolumeMesh\",")?;
            guard.value().write_canonical(&mut &mut *out)?;
            out.write_all(b",")?;
            asset.lease().descriptor().write_canonical(&mut &mut *out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::replace_volume_mesh(guard, asset.clone())
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, vec![asset]))
    }
    /// `["meshBoolean",guard,descriptor,op]`.
    pub fn mesh_boolean(
        guard: BooleanGuard,
        asset: StagedAsset,
        op: BooleanOp,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"meshBoolean\",")?;
            guard.value().write_canonical(&mut &mut *out)?;
            out.write_all(b",")?;
            asset.lease().descriptor().write_canonical(&mut &mut *out)?;
            out.write_all(match op {
                BooleanOp::Union => b",\"UNION\"]".as_slice(),
                BooleanOp::ANotB => b",\"A_NOT_B\"]".as_slice(),
                BooleanOp::Intersection => b",\"INTERSECTION\"]".as_slice(),
            })
        })?;
        let command = PreparedCommand::mesh_boolean(guard, asset.clone(), op)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, vec![asset]))
    }
    /// `["splitVolumeToParts",guard,parts]`.
    pub fn split_volume_to_parts(
        guard: VolumeSplitGuard,
        parts: Vec<SplitPart>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"splitVolumeToParts\",")?;
            guard.value().write_canonical(&mut &mut *out)?;
            out.write_all(b",")?;
            write_parts(&parts, out)?;
            out.write_all(b"]")
        })?;
        let assets = parts.iter().map(|part| part.asset.clone()).collect();
        let command = PreparedCommand::split_volume_to_parts(guard, parts)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, assets))
    }
    /// `["addSvgPart",placement,descriptor,drawing,triangleCount,part,name]` or
    /// `["addEmbossText",placement,configuration,descriptor,triangleCount]`.
    pub fn add_drawn_part(
        placement: PartPlacement,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
        name: Option<Text>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            let svg = matches!(recipe, Recipe::Svg { .. });
            out.write_all(if svg {
                b"[\"addSvgPart\",".as_slice()
            } else {
                b"[\"addEmbossText\",".as_slice()
            })?;
            write_placement(&placement, out)?;
            out.write_all(b",")?;
            match &recipe {
                Recipe::Svg { drawing, part } => {
                    asset.lease().descriptor().write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    optional_descriptor(drawing.as_ref(), out)?;
                    out.write_all(b",")?;
                    Value::Number(triangles).write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    part.write_json(out)?;
                    out.write_all(b",")?;
                    optional(&name, out)?;
                }
                Recipe::Text(configuration) => {
                    configuration.write_json(out)?;
                    out.write_all(b",")?;
                    asset.lease().descriptor().write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    Value::Number(triangles).write_canonical(&mut &mut *out)?;
                }
            }
            out.write_all(b"]")
        })?;
        let mut assets = vec![asset.clone()];
        if let Recipe::Svg {
            drawing: Some(drawing),
            ..
        } = &recipe
        {
            assets.push(drawing.clone());
        }
        let command = PreparedCommand::add_drawn_part(placement, asset, triangles, recipe, name)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, assets))
    }
    /// `["editSvgPart",volumeId,descriptor,triangleCount,part]` or
    /// `["editEmbossText",volumeId,configuration,descriptor,triangleCount]`.
    pub fn recut_part(
        volume: VolumeId,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            match &recipe {
                Recipe::Svg { part, .. } => {
                    out.write_all(b"[\"editSvgPart\",")?;
                    volume.write_json(out)?;
                    out.write_all(b",")?;
                    asset.lease().descriptor().write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    Value::Number(triangles).write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    part.write_json(out)?;
                }
                Recipe::Text(configuration) => {
                    out.write_all(b"[\"editEmbossText\",")?;
                    volume.write_json(out)?;
                    out.write_all(b",")?;
                    configuration.write_json(out)?;
                    out.write_all(b",")?;
                    asset.lease().descriptor().write_canonical(&mut &mut *out)?;
                    out.write_all(b",")?;
                    Value::Number(triangles).write_canonical(&mut &mut *out)?;
                }
            }
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::recut_part(volume, asset.clone(), triangles, recipe)
            .map_err(CaptureError::Preparation)?;
        Ok(Self::with_assets(command, units, vec![asset]))
    }
    /// `["replaceProject",state,label]`.
    pub fn replace_project(
        state: ProjectState,
        label: Option<Text>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"replaceProject\",")?;
            state.write_json(out)?;
            out.write_all(b",")?;
            optional(&label, out)?;
            out.write_all(b"]")
        })?;
        Ok(Self::plain(
            PreparedCommand::replace_project(state, label),
            units,
        ))
    }
}
fn write_placement(placement: &PartPlacement, out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"{\"objectId\":")?;
    placement.object.write_json(out)?;
    out.write_all(b",\"volumeId\":")?;
    placement.volume.write_json(out)?;
    out.write_all(b",\"assetId\":")?;
    placement.asset.write_json(out)?;
    out.write_all(b",\"transform\":")?;
    placement.transform.write_json(out)?;
    out.write_all(b"}")
}
fn optional_descriptor(asset: Option<&StagedAsset>, out: &mut dyn Write) -> io::Result<()> {
    match asset {
        Some(asset) => asset.lease().descriptor().write_canonical(&mut &mut *out),
        None => out.write_all(b"null"),
    }
}
/// `[{"volumeId":..,"descriptor":..,"transform":..,"sourceTriangleIndices":[..]},..]`.
fn write_parts(parts: &[SplitPart], out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"[")?;
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.write_all(b",")?;
        }
        out.write_all(b"{\"volumeId\":")?;
        Value::String(part.volume_id.clone()).write_canonical(&mut &mut *out)?;
        out.write_all(b",\"descriptor\":")?;
        part.asset
            .lease()
            .descriptor()
            .write_canonical(&mut &mut *out)?;
        out.write_all(b",\"transform\":")?;
        part.transform.write_json(out)?;
        out.write_all(b",\"sourceTriangleIndices\":")?;
        Value::Array(
            part.source_triangles
                .iter()
                .map(|&t| Value::Number(t))
                .collect(),
        )
        .write_canonical(&mut &mut *out)?;
        out.write_all(b"}")?;
    }
    out.write_all(b"]")
}
fn write_identities(identities: &[SeparatedObject], out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"[")?;
    for (index, identity) in identities.iter().enumerate() {
        if index > 0 {
            out.write_all(b",")?;
        }
        out.write_all(b"{\"sourceVolumeId\":")?;
        identity.source_volume.write_json(out)?;
        out.write_all(b",\"objectId\":")?;
        identity.object.write_json(out)?;
        out.write_all(b",\"instanceIds\":")?;
        list(&identity.instances, out)?;
        out.write_all(b"}")?;
    }
    out.write_all(b"]")
}
fn list<T: Encode>(values: &[T], out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"[")?;
    for (i, value) in values.iter().enumerate() {
        if i != 0 {
            out.write_all(b",")?;
        }
        value.write_json(out)?;
    }
    out.write_all(b"]")
}
fn optional<T: Encode>(value: &Option<T>, out: &mut dyn Write) -> io::Result<()> {
    match value {
        Some(value) => value.write_json(out),
        None => out.write_all(b"null"),
    }
}

pub struct StagedWork {
    pub(crate) kind: WorkKind,
    units: u64,
    commands: usize,
    asset_bytes: u64,
}
pub(crate) enum WorkKind {
    Single(PreparedCommand),
    Transaction {
        label: Text,
        commands: Vec<PreparedCommand>,
    },
    /// `commitPreparedVolumeSplitToObjects`: checked against the live state
    /// when it runs, then one transaction.
    SplitToObjects(Box<SplitToObjects>),
    /// `commitFacetRefinement`: checked against the live state when it runs;
    /// a result that changes nothing executes nothing.
    FacetRefinement(Box<FacetRefinement>),
}
/// Each distinct payload once; one ID must carry one payload throughout.
fn distinct_bytes<'a>(assets: impl Iterator<Item = &'a StagedAsset>) -> Result<u64, CaptureError> {
    let mut seen: Vec<&StagedAsset> = Vec::new();
    let mut total = 0u64;
    for asset in assets {
        match seen.iter().find(|a| a.id() == asset.id()) {
            Some(existing) => {
                let (a, b) = (existing.lease(), asset.lease());
                if a.descriptor() != b.descriptor() || a.bytes() != b.bytes() {
                    return Err(CaptureError::AssetConflict);
                }
            }
            None => {
                total = total
                    .checked_add(asset.byte_length())
                    .ok_or(CaptureError::Limit)?;
                seen.push(asset);
            }
        }
    }
    Ok(total)
}
impl StagedWork {
    pub fn single(captured: CapturedCommand) -> Self {
        Self {
            units: captured.units,
            commands: 1,
            asset_bytes: captured.asset_bytes(),
            kind: WorkKind::Single(captured.command),
        }
    }
    /// `["splitToObjects",guard,parts,identities]`: one work of two commands.
    pub fn split_to_objects(
        guard: VolumeSplitGuard,
        parts: Vec<SplitPart>,
        identities: Vec<SeparatedObject>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"splitToObjects\",")?;
            guard.value().write_canonical(&mut &mut *out)?;
            out.write_all(b",")?;
            write_parts(&parts, out)?;
            out.write_all(b",")?;
            write_identities(&identities, out)?;
            out.write_all(b"]")
        })?;
        let asset_bytes = distinct_bytes(parts.iter().map(|part| &part.asset))?;
        let work =
            SplitToObjects::new(guard, parts, identities).map_err(CaptureError::Preparation)?;
        Ok(Self {
            units,
            commands: 2,
            asset_bytes,
            kind: WorkKind::SplitToObjects(Box::new(work)),
        })
    }
    /// `["facetRefinement",guard,channel,roots,label]`.
    pub fn facet_refinement(
        request: FacetRefinement,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"facetRefinement\",{\"hash\":")?;
            Value::String(request.hash.clone()).write_canonical(&mut &mut *out)?;
            out.write_all(b",\"revision\":")?;
            Value::Number(request.revision as f64).write_canonical(&mut &mut *out)?;
            out.write_all(b",\"topologyRevision\":")?;
            Value::Number(request.topology_revision).write_canonical(&mut &mut *out)?;
            out.write_all(b",\"triangleCount\":")?;
            Value::Number(request.triangle_count).write_canonical(&mut &mut *out)?;
            out.write_all(b",\"volumeId\":")?;
            request.volume.write_json(out)?;
            out.write_all(b"},")?;
            Value::String(request.channel.name().encode_utf16().collect())
                .write_canonical(&mut &mut *out)?;
            out.write_all(b",[")?;
            for (index, root) in request.roots.iter().enumerate() {
                if index > 0 {
                    out.write_all(b",")?;
                }
                root.to_value().write_canonical(&mut &mut *out)?;
            }
            out.write_all(b"],")?;
            optional(&request.label, out)?;
            out.write_all(b"]")
        })?;
        Ok(Self {
            units,
            commands: 1,
            asset_bytes: 0,
            kind: WorkKind::FacetRefinement(Box::new(request)),
        })
    }
    pub fn asset_bytes(&self) -> u64 {
        self.asset_bytes
    }
    pub fn transaction(
        label: Text,
        commands: Vec<CapturedCommand>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        // Charge the equivalent [label,[captured arguments...]] serialization.
        let mut units = measure(max_units, |out| {
            out.write_all(b"[")?;
            label.write_json(out)?;
            out.write_all(b",[]]")
        })?;
        for (i, command) in commands.iter().enumerate() {
            units = units
                .checked_add(command.units)
                .and_then(|n| n.checked_add(u64::from(i != 0)))
                .filter(|&n| n <= max_units)
                .ok_or(CaptureError::Limit)?;
        }
        let asset_bytes = distinct_bytes(commands.iter().flat_map(|c| c.assets.iter()))?;
        Ok(Self {
            units,
            commands: commands.len(),
            asset_bytes,
            kind: WorkKind::Transaction {
                label,
                commands: commands.into_iter().map(|c| c.command).collect(),
            },
        })
    }
    pub fn units(&self) -> u64 {
        self.units
    }
    pub fn command_count(&self) -> usize {
        self.commands
    }
}

fn measure(
    limit: u64,
    write: impl FnOnce(&mut dyn Write) -> io::Result<()>,
) -> Result<u64, CaptureError> {
    struct Counter {
        units: u64,
        limit: u64,
        exhausted: bool,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            for &byte in bytes {
                let units = if byte & 0xc0 == 0x80 {
                    0
                } else if byte >= 0xf0 {
                    2
                } else {
                    1
                };
                let Some(next) = self.units.checked_add(units).filter(|&n| n <= self.limit) else {
                    self.exhausted = true;
                    return Err(io::Error::other("command input budget exhausted"));
                };
                self.units = next;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        units: 0,
        limit,
        exhausted: false,
    };
    write(&mut counter).map_err(|_| {
        if counter.exhausted {
            CaptureError::Limit
        } else {
            CaptureError::Encoding
        }
    })?;
    Ok(counter.units)
}
