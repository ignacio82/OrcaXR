//! Volumes cut from a recipe that travels with them (`AddSvgPartCommand`,
//! `EditSvgPartCommand`, `AddEmbossTextCommand`, `EditEmbossTextCommand`): the
//! drawing or text stays on the volume so the part can be re-cut, and a re-cut
//! replaces the mesh wholesale with every annotation channel reset.
use super::topology::{domain, empty_annotations, put, u};
use super::*;
use crate::assets::AssetLease;

/// `SvgPlacement` / `EmbossPlacement`.
#[derive(Clone)]
pub struct PartPlacement {
    pub object: ObjectId,
    pub volume: VolumeId,
    pub asset: AssetId,
    pub transform: Transform,
}

/// What a cut is made of: the mesh, the drawing for SVG parts, and the recipe.
#[derive(Clone)]
pub enum Recipe {
    Svg {
        drawing: Option<StagedAsset>,
        part: Arc<EmbossSvgPart>,
    },
    Text(Arc<EmbossTextConfiguration>),
}
impl Recipe {
    fn is_svg(&self) -> bool {
        matches!(self, Self::Svg { .. })
    }
}

/// The browser's `referencesAsset` here: volume meshes only.
fn mesh_referenced(state: &ProjectState, id: &AssetId) -> bool {
    state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
        .any(|v| v.source.asset_id == *id)
}
/// `requireObject`: the first object with this ID in plate order.
fn require_object<E>(
    state: &ProjectState,
    id: &ObjectId,
) -> Result<(usize, usize), CommandError<E>> {
    locate_object(state, id)
        .ok_or_else(|| domain("Object ", id.as_utf16(), " is not in this project"))
}
fn locate_volume(state: &ProjectState, id: &VolumeId) -> Option<(usize, usize, usize)> {
    super::topology::locate_volume(state, id)
}
/// `firstLine`: the text's first line, trimmed, at most 60 UTF-16 units.
fn first_line(text: &[u16]) -> Text {
    let line = text.split(|&c| c == u16::from(b'\n')).next().unwrap_or(&[]);
    let start = line
        .iter()
        .position(|&c| !crate::ids::ecmascript_whitespace(c))
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|&c| !crate::ids::ecmascript_whitespace(c))
        .map_or(start, |i| i + 1);
    let trimmed = &line[start..end.max(start)];
    if trimmed.is_empty() {
        Text::from_utf8("Text")
    } else {
        Text::new(trimmed[..trimmed.len().min(60)].to_vec())
    }
}
fn trim(text: &[u16]) -> &[u16] {
    let start = text
        .iter()
        .position(|&c| !crate::ids::ecmascript_whitespace(c))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|&c| !crate::ids::ecmascript_whitespace(c))
        .map_or(start, |i| i + 1);
    &text[start..end.max(start)]
}
fn number<E>(value: f64) -> Result<Number, CommandError<E>> {
    Number::new(value).map_err(|_| non_serializable())
}
fn edit_object<R>(
    state: &mut ProjectState,
    p: usize,
    o: usize,
    edit: impl FnOnce(&mut Vec<Arc<ProjectVolume>>) -> R,
) -> R {
    super::topology::with_object(state, p, o, |object| {
        let mut volumes = object.volumes.to_vec();
        let result = edit(&mut volumes);
        object.volumes = volumes.into();
        result
    })
}

/// `AddSvgPartCommand` / `AddEmbossTextCommand`.
#[derive(Clone)]
pub(super) struct AddDrawnPart {
    placement: PartPlacement,
    asset: StagedAsset,
    triangles: f64,
    recipe: Recipe,
    name: Text,
    applied: bool,
}
impl AddDrawnPart {
    pub(super) fn new(
        placement: PartPlacement,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
        name: Option<Text>,
    ) -> Result<(Self, Text), PreparationError> {
        if *asset.id() != placement.asset {
            let mut message = u("Prepared asset ");
            message.extend_from_slice(asset.id().as_utf16());
            message.extend(" does not match placement ".encode_utf16());
            message.extend_from_slice(placement.asset.as_utf16());
            return Err(PreparationError::Domain(Text::new(message)));
        }
        let (label, name) = match &recipe {
            Recipe::Svg { .. } => {
                let given = name.map(|n| trim(n.units()).to_vec()).unwrap_or_default();
                (
                    "Add SVG part",
                    if given.is_empty() {
                        Text::from_utf8("SVG part")
                    } else {
                        Text::new(given)
                    },
                )
            }
            Recipe::Text(configuration) => {
                if triangles == 0.0 {
                    return Err(PreparationError::Domain(Text::from_utf8(
                        "This text produced no geometry to add",
                    )));
                }
                ("Add embossed text", first_line(configuration.text.units()))
            }
        };
        Ok((
            Self {
                placement,
                asset,
                triangles,
                recipe,
                name,
                applied: false,
            },
            Text::from_utf8(label),
        ))
    }
    pub(super) fn reason(&self) -> &'static str {
        if self.recipe.is_svg() {
            "add-svg-part"
        } else {
            "add-emboss-text"
        }
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let (p, o) = require_object(&state, &self.placement.object)?;
        if locate_volume(&state, &self.placement.volume).is_some() {
            return Err(domain(
                "Volume ",
                self.placement.volume.as_utf16(),
                " already exists",
            ));
        }
        if !self.recipe.is_svg()
            && state
                .source_assets
                .iter()
                .any(|d| d.id == self.placement.asset)
        {
            return Err(domain(
                "Asset ",
                self.placement.asset.as_utf16(),
                " already exists",
            ));
        }
        let (emboss_text, emboss_svg) = match &self.recipe {
            Recipe::Svg { part, .. } => (None, Some(part.clone())),
            Recipe::Text(configuration) => (Some(configuration.clone()), None),
        };
        let volume = Arc::new(ProjectVolume {
            id: self.placement.volume.clone(),
            name: self.name.clone(),
            role: VolumeRole::Model,
            source: MeshSourceRef {
                asset_id: self.placement.asset.clone(),
                topology_revision: number(0.0)?,
                triangle_count: number(self.triangles)?,
                extra: ExtraFields::default(),
            },
            transform: self.placement.transform.clone(),
            config: JsonObject::new(orcaxr_contracts::canonical::Value::Object(
                Default::default(),
            ))
            .expect("empty object"),
            filament_id: None,
            annotations: empty_annotations(0.0)?,
            emboss_text,
            emboss_svg,
            extension_data: None,
            extra: ExtraFields::default(),
        });
        edit_object(&mut state, p, o, |volumes| volumes.push(volume));
        let mut assets = state.source_assets.to_vec();
        assets.push(self.asset.descriptor().clone());
        if let Recipe::Svg {
            drawing: Some(drawing),
            ..
        } = &self.recipe
        {
            assets.push(drawing.descriptor().clone());
        }
        state.source_assets = assets.into();
        put(context, self.asset.lease())?;
        if let Recipe::Svg {
            drawing: Some(drawing),
            ..
        } = &self.recipe
        {
            put(context, drawing.lease())?;
        }
        context.replace(state, reason, PROJECT)?;
        self.applied = true;
        Ok(())
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        if !self.applied {
            return Err(CommandError::domain(if self.recipe.is_svg() {
                "AddSvgPartCommand has not been applied"
            } else {
                "AddEmbossTextCommand has not been applied"
            }));
        }
        let mut state = context.snapshot().state().clone();
        let (p, o) = require_object(&state, &self.placement.object)?;
        let Some(index) = state.plates[p].objects[o]
            .volumes
            .iter()
            .position(|v| v.id == self.placement.volume)
        else {
            return Err(domain(
                if self.recipe.is_svg() {
                    "SVG volume "
                } else {
                    "Embossed volume "
                },
                self.placement.volume.as_utf16(),
                " is missing during undo",
            ));
        };
        edit_object(&mut state, p, o, |volumes| volumes.remove(index));
        let drawing = match &self.recipe {
            Recipe::Svg {
                drawing: Some(drawing),
                ..
            } => Some(drawing.id().clone()),
            _ => None,
        };
        for id in std::iter::once(&self.placement.asset).chain(drawing.as_ref()) {
            if let Some(index) = state.source_assets.iter().position(|d| d.id == *id) {
                let mut assets = state.source_assets.to_vec();
                assets.remove(index);
                state.source_assets = assets.into();
            }
        }
        let reason = Text::from_utf8(&format!("{}:undo", self.reason()));
        context.replace(state, reason, PROJECT)?;
        context.assets_mut().remove(&self.placement.asset);
        if let Some(drawing) = drawing {
            context.assets_mut().remove(&drawing);
        }
        Ok(())
    }
}

#[derive(Clone)]
struct PreviousCut {
    volume: Arc<ProjectVolume>,
    descriptor_index: Option<usize>,
    removed: Option<(Arc<SourceAssetDescriptor>, AssetLease)>,
}

/// `EditSvgPartCommand` / `EditEmbossTextCommand`.
#[derive(Clone)]
pub(super) struct RecutPart {
    volume: VolumeId,
    asset: StagedAsset,
    triangles: f64,
    recipe: Recipe,
    previous: Option<Arc<PreviousCut>>,
}
impl RecutPart {
    pub(super) fn new(
        volume: VolumeId,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
    ) -> Result<(Self, Text), PreparationError> {
        if !recipe.is_svg() && triangles == 0.0 {
            return Err(PreparationError::Domain(Text::from_utf8(
                "This text produced no geometry to apply",
            )));
        }
        let label = if recipe.is_svg() {
            "Edit SVG part"
        } else {
            "Edit embossed text"
        };
        Ok((
            Self {
                volume,
                asset,
                triangles,
                recipe,
                previous: None,
            },
            Text::from_utf8(label),
        ))
    }
    pub(super) fn reason(&self) -> &'static str {
        if self.recipe.is_svg() {
            "edit-svg-part"
        } else {
            "edit-emboss-text"
        }
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let id = self.volume.as_utf16();
        let Some((p, o, v)) = locate_volume(&state, &self.volume) else {
            return Err(domain("Volume ", id, " is not in this project"));
        };
        let previous = state.plates[p].objects[o].volumes[v].clone();
        match &self.recipe {
            Recipe::Svg { .. } if previous.emboss_svg.is_none() => {
                return Err(domain(
                    "Volume ",
                    id,
                    " is not an SVG part, so its drawing cannot be re-cut",
                ));
            }
            Recipe::Text(_) if previous.emboss_text.is_none() => {
                return Err(domain(
                    "Volume ",
                    id,
                    " is not embossed text, so its recipe cannot be edited",
                ));
            }
            _ => {}
        }
        let old = previous.source.asset_id.clone();
        let descriptor_index = state.source_assets.iter().position(|d| d.id == old);
        let revision = previous.source.topology_revision.get() + 1.0;
        let source = MeshSourceRef {
            asset_id: self.asset.id().clone(),
            topology_revision: number(revision)?,
            triangle_count: number(self.triangles)?,
            extra: ExtraFields::default(),
        };
        let annotations = empty_annotations(revision)?;
        let recipe = self.recipe.clone();
        edit_object(&mut state, p, o, |volumes| {
            let volume = Arc::make_mut(&mut volumes[v]);
            volume.source = source;
            volume.annotations = annotations;
            match recipe {
                Recipe::Svg { part, .. } => volume.emboss_svg = Some(part),
                Recipe::Text(configuration) => {
                    volume.name = first_line(configuration.text.units());
                    volume.emboss_text = Some(configuration);
                }
            }
        });
        if !state.source_assets.iter().any(|d| d.id == *self.asset.id()) {
            let mut assets = state.source_assets.to_vec();
            assets.push(self.asset.descriptor().clone());
            state.source_assets = assets.into();
        }
        let mut removed = None;
        if !mesh_referenced(&state, &old)
            && let Some(index) = descriptor_index
        {
            let descriptor = state.source_assets[index].clone();
            removed = context.assets().peek(&old).map(|lease| (descriptor, lease));
            let mut assets = state.source_assets.to_vec();
            assets.remove(index);
            state.source_assets = assets.into();
        }
        put(context, self.asset.lease())?;
        context.replace(state, reason, PROJECT)?;
        if removed.is_some() {
            context.assets_mut().remove(&old);
        }
        self.previous = Some(Arc::new(PreviousCut {
            volume: previous,
            descriptor_index,
            removed,
        }));
        Ok(())
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let svg = self.recipe.is_svg();
        let Some(previous) = &self.previous else {
            return Err(CommandError::domain(if svg {
                "EditSvgPartCommand has not been applied"
            } else {
                "EditEmbossTextCommand has not been applied"
            }));
        };
        let mut state = context.snapshot().state().clone();
        let id = self.volume.as_utf16();
        let noun = if svg {
            "SVG volume "
        } else {
            "Embossed volume "
        };
        let Some((p, o, v)) = locate_volume(&state, &self.volume) else {
            return Err(domain(noun, id, " is missing during undo"));
        };
        let volume = &state.plates[p].objects[o].volumes[v];
        // `canonicalStringify` of an absent recipe throws before comparing.
        let unchanged = match &self.recipe {
            Recipe::Svg { part, .. } => volume.emboss_svg.as_ref().map(|current| current == part),
            Recipe::Text(configuration) => volume
                .emboss_text
                .as_ref()
                .map(|current| current == configuration),
        };
        match unchanged {
            None => {
                return Err(CommandError::domain(
                    "Canonical JSON cannot contain undefined",
                ));
            }
            Some(false) => return Err(domain(noun, id, " changed before undo")),
            Some(true) => {}
        }
        let restored = previous.volume.clone();
        edit_object(&mut state, p, o, |volumes| volumes[v] = restored);
        if let (Some((descriptor, lease)), Some(index)) =
            (&previous.removed, previous.descriptor_index)
        {
            put(context, lease)?;
            let mut assets = state.source_assets.to_vec();
            assets.insert(index.min(assets.len()), descriptor.clone());
            state.source_assets = assets.into();
        }
        let new = self.asset.id();
        let referenced = mesh_referenced(&state, new);
        if !referenced && let Some(index) = state.source_assets.iter().position(|d| d.id == *new) {
            let mut assets = state.source_assets.to_vec();
            assets.remove(index);
            state.source_assets = assets.into();
        }
        let reason = Text::from_utf8(&format!("{}:undo", self.reason()));
        context.replace(state, reason, PROJECT)?;
        if !referenced {
            context.assets_mut().remove(new);
        }
        Ok(())
    }
}
