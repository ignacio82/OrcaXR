//! Project selectors layer only values read by the pinned engine. Foreign values
//! stay in the project and are reported separately from effective/local settings.
use super::*;
use crate::ids::{LayerRangeId, ObjectId, PlateId, VolumeId};
use crate::model::{ProjectState, find_plate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigScopeRef<'a> {
    Project,
    Plate(&'a PlateId),
    Object(&'a ObjectId),
    Volume(&'a VolumeId),
    LayerRange(&'a LayerRangeId),
}
impl<'a> ConfigScopeRef<'a> {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Plate(_) => "plate",
            Self::Object(_) => "object",
            Self::Volume(_) => "volume",
            Self::LayerRange(_) => "layer-range",
        }
    }
    pub fn id(self) -> Option<&'a [u16]> {
        match self {
            Self::Project => None,
            Self::Plate(id) => Some(id.as_utf16()),
            Self::Object(id) => Some(id.as_utf16()),
            Self::Volume(id) => Some(id.as_utf16()),
            Self::LayerRange(id) => Some(id.as_utf16()),
        }
    }
    fn setting_scope(self) -> SettingScope {
        match self {
            Self::Project => SettingScope::Project,
            Self::Plate(_) => SettingScope::Plate,
            Self::Object(_) => SettingScope::Object,
            Self::Volume(_) => SettingScope::Part,
            Self::LayerRange(_) => SettingScope::LayerRange,
        }
    }
}
pub struct ConfigResolutionRequest<'a> {
    pub plate_id: &'a PlateId,
    pub object_id: Option<&'a ObjectId>,
    pub volume_id: Option<&'a VolumeId>,
    pub layer_range_id: Option<&'a LayerRangeId>,
}
pub struct IgnoredScopedSetting<'a> {
    pub key: &'a [u16],
    pub scope: ConfigScopeRef<'a>,
    pub reason: Text,
}
pub struct ResolvedConfig<'a> {
    pub effective: ConfigView<'a>,
    pub inherited: ConfigView<'a>,
    pub local: ConfigView<'a>,
    pub source_by_key: BTreeMap<&'a [u16], ConfigScopeRef<'a>>,
    pub ignored: Vec<IgnoredScopedSetting<'a>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigResolutionError {
    UnknownPlate(PlateId),
    ObjectNotOnPlate(ObjectId, PlateId),
    VolumeRequiresObject,
    VolumeNotOnObject(VolumeId, ObjectId),
    LayerRangeRequiresObject,
    LayerRangeNotOnObject(LayerRangeId, ObjectId),
}
impl ConfigResolutionError {
    /// UI text can contain source IDs. Debug above uses the IDs' redacted form.
    pub fn message(&self) -> Text {
        match self {
            Self::UnknownPlate(id) => text(&[&units("Unknown plate "), id.as_utf16()]),
            Self::ObjectNotOnPlate(id, parent) => text(&[
                &units("Object "),
                id.as_utf16(),
                &units(" is not on plate "),
                parent.as_utf16(),
            ]),
            Self::VolumeRequiresObject => Text::from_utf8("Resolving a volume requires objectId"),
            Self::VolumeNotOnObject(id, parent) => text(&[
                &units("Volume "),
                id.as_utf16(),
                &units(" is not on object "),
                parent.as_utf16(),
            ]),
            Self::LayerRangeRequiresObject => {
                Text::from_utf8("Resolving a layer range requires objectId")
            }
            Self::LayerRangeNotOnObject(id, parent) => text(&[
                &units("Layer range "),
                id.as_utf16(),
                &units(" is not on object "),
                parent.as_utf16(),
            ]),
        }
    }
}
pub fn resolve_config<'a>(
    state: &'a ProjectState,
    request: ConfigResolutionRequest<'_>,
) -> Result<ResolvedConfig<'a>, ConfigResolutionError> {
    let plate = find_plate(state, request.plate_id)
        .ok_or_else(|| ConfigResolutionError::UnknownPlate(request.plate_id.clone()))?;
    let mut scopes = vec![
        (ConfigScopeRef::Project, &state.config),
        (ConfigScopeRef::Plate(&plate.id), &plate.config),
    ];
    let object = if let Some(id) = request.object_id {
        let object = plate
            .objects
            .iter()
            .find(|object| &object.id == id)
            .ok_or_else(|| ConfigResolutionError::ObjectNotOnPlate(id.clone(), plate.id.clone()))?;
        scopes.push((ConfigScopeRef::Object(&object.id), &object.config));
        Some(object)
    } else {
        None
    };
    if let Some(id) = request.volume_id {
        let object = object.ok_or(ConfigResolutionError::VolumeRequiresObject)?;
        let volume = object
            .volumes
            .iter()
            .find(|volume| &volume.id == id)
            .ok_or_else(|| {
                ConfigResolutionError::VolumeNotOnObject(id.clone(), object.id.clone())
            })?;
        scopes.push((ConfigScopeRef::Volume(&volume.id), &volume.config));
    }
    if let Some(id) = request.layer_range_id {
        let object = object.ok_or(ConfigResolutionError::LayerRangeRequiresObject)?;
        let range = object
            .layer_ranges
            .iter()
            .find(|range| &range.id == id)
            .ok_or_else(|| {
                ConfigResolutionError::LayerRangeNotOnObject(id.clone(), object.id.clone())
            })?;
        scopes.push((ConfigScopeRef::LayerRange(&range.id), &range.config));
    }
    let mut effective = ConfigView::default();
    let mut source_by_key = BTreeMap::new();
    let mut ignored = vec![];
    for (scope, config) in &scopes {
        for (key, value) in fields(config) {
            if !scope.setting_scope().allows(key) {
                let allowed: Vec<_> = scopes_for_setting(key).map(SettingScope::as_str).collect();
                let suffix = if allowed.is_empty() {
                    " is not a setting the engine reads from a project node".to_owned()
                } else {
                    format!(
                        " is read from the {} scope, not from the {} scope",
                        allowed.join(", "),
                        scope.setting_scope().as_str()
                    )
                };
                ignored.push(IgnoredScopedSetting {
                    key,
                    scope: *scope,
                    reason: text(&[key, &units(&suffix)]),
                });
                continue;
            }
            effective.0.insert(key.as_slice(), value);
            source_by_key.insert(key.as_slice(), *scope);
        }
    }
    let (last_scope, stored) = scopes.last().expect("project and plate scopes");
    let local = ConfigView(
        fields(stored)
            .iter()
            .filter(|(key, _)| {
                last_scope.setting_scope().allows(key) && effective.0.contains_key(key.as_slice())
            })
            .map(|(key, value)| (key.as_slice(), value))
            .collect(),
    );
    let inherited = ConfigView(
        effective
            .0
            .iter()
            .filter(|(key, _)| !local.0.contains_key(**key))
            .map(|(key, value)| (*key, *value))
            .collect(),
    );
    Ok(ResolvedConfig {
        effective,
        inherited,
        local,
        source_by_key,
        ignored,
    })
}
