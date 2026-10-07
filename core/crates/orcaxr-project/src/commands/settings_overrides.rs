//! Project and scoped setting overrides (`settingsOverrides.ts`,
//! `scopedOverrides.ts`). Both are prepared against a revision/hash guard: the
//! first apply requires the project to be exactly the snapshot the caller read,
//! and redo requires the stored settings to be what this command left. Maps
//! arrive as canonical JSON text with the browser mapping's refusals.
use super::mixed::json_object as json_text_object;
use super::*;
use crate::settings::SettingScope;
use crate::store::ProjectSnapshot;
use std::collections::BTreeMap;

type Map = BTreeMap<Vec<u16>, Value>;

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn map(object: &JsonObject) -> Map {
    match object.value() {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    }
}
fn object<E>(fields: Map) -> Result<JsonObject, CommandError<E>> {
    JsonObject::new(Value::Object(fields)).map_err(|_| non_serializable())
}
fn blank(units: &[u16]) -> bool {
    units.iter().all(|u| crate::ids::ecmascript_whitespace(*u))
}
#[derive(Clone)]
struct Guard {
    revision: u64,
    hash: Vec<u16>,
}
impl Guard {
    fn new(v: wire::SettingsGuard) -> Self {
        Self {
            revision: v.source_revision,
            hash: v.source_hash,
        }
    }
    fn is_current(&self, snapshot: &ProjectSnapshot) -> bool {
        snapshot.revision() == self.revision
            && self.hash.iter().copied().eq(snapshot.hash().encode_utf16())
    }
}

/// `SetProjectSettingsOverridesCommand`: the complete inherited/override pair
/// and the effective config they spread into.
#[derive(Clone)]
pub(super) struct ProjectSettings {
    guard: Guard,
    base: JsonObject,
    overrides: JsonObject,
    effective: JsonObject,
    previous: Option<Previous>,
}
#[derive(Clone)]
struct Previous {
    config: ConfigMap,
    base: Option<ConfigMap>,
    overrides: Option<ConfigMap>,
}
/// `assertConfigMap`: an object (guaranteed by the JSON text) without blank keys.
fn assert_config(config: &JsonObject, label: &str) -> Result<(), PreparationError> {
    if map(config).keys().any(|key| blank(key)) {
        return Err(PreparationError::Domain(Text::from_utf8(&format!(
            "{label} contains an empty key"
        ))));
    }
    Ok(())
}
impl ProjectSettings {
    pub(super) fn new(v: wire::SetProjectSettingsOverrides) -> Result<Self, PreparationError> {
        let base = json_text_object(v.inherited_config_json)?;
        let overrides = json_text_object(v.overrides_json)?;
        assert_config(&base, "Inherited project configuration")?;
        assert_config(&overrides, "Project setting overrides")?;
        let mut effective = map(&base);
        effective.extend(map(&overrides));
        Ok(Self {
            guard: Guard::new(v.guard),
            base,
            overrides,
            effective: JsonObject::new(Value::Object(effective))
                .map_err(|_| PreparationError::InvalidIntent)?,
            previous: None,
        })
    }
    fn stale<E>() -> CommandError<E> {
        CommandError::domain(
            "Project setting overrides were prepared for a stale canonical project revision",
        )
    }
    pub(super) fn is_noop<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        let snapshot = context.snapshot();
        if !self.guard.is_current(&snapshot) {
            return Err(Self::stale());
        }
        let state = snapshot.state();
        let empty = JsonObject::new(Value::Object(Map::new())).expect("empty object");
        Ok(
            state.settings_base_config.as_ref().unwrap_or(&state.config) == &self.base
                && state.settings_overrides.as_ref().unwrap_or(&empty) == &self.overrides
                && state.config == self.effective,
        )
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let snapshot = context.snapshot();
        let current = snapshot.state();
        match &self.previous {
            None if !self.guard.is_current(&snapshot) => return Err(Self::stale()),
            Some(previous)
                if !(current.config == previous.config
                    && current.settings_base_config == previous.base
                    && current.settings_overrides == previous.overrides) =>
            {
                return Err(CommandError::domain(
                    "Cannot redo project setting overrides because the canonical settings pair diverged",
                ));
            }
            _ => {}
        }
        let mut next = current.clone();
        next.settings_base_config = Some(self.base.clone());
        next.settings_overrides = Some(self.overrides.clone());
        next.config = self.effective.clone();
        let admitted = context.admit(next)?;
        if self.previous.is_none() {
            self.previous = Some(Previous {
                config: current.config.clone(),
                base: current.settings_base_config.clone(),
                overrides: current.settings_overrides.clone(),
            });
        }
        context.replace_validated(admitted, reason, PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self.previous.as_ref().ok_or_else(|| {
            CommandError::domain("SetProjectSettingsOverridesCommand has not been applied")
        })?;
        let mut state = context.snapshot().state().clone();
        state.config = previous.config.clone();
        state.settings_base_config = previous.base.clone();
        state.settings_overrides = previous.overrides.clone();
        context.replace(state, reason, PROJECT)
    }
    /// The three next maps plus the captured previous record
    /// (`{config, hadBaseConfig, baseConfig?, hadOverrides, overrides?}`).
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        let mut total = duplicate::canonical_length(&self.base)?
            + duplicate::canonical_length(&self.overrides)?
            + duplicate::canonical_length(&self.effective)?;
        if let Some(previous) = &self.previous {
            let mut record = Map::from([
                (u("config"), previous.config.value().clone()),
                (u("hadBaseConfig"), Value::Bool(previous.base.is_some())),
                (u("hadOverrides"), Value::Bool(previous.overrides.is_some())),
            ]);
            if let Some(base) = &previous.base {
                record.insert(u("baseConfig"), base.value().clone());
            }
            if let Some(overrides) = &previous.overrides {
                record.insert(u("overrides"), overrides.value().clone());
            }
            total += duplicate::canonical_length(
                &JsonObject::new(Value::Object(record))
                    .map_err(|_| std::io::Error::other("unencodable settings record"))?,
            )?;
        }
        Ok(total)
    }
}

#[derive(Clone)]
enum Target {
    Plate(PlateId),
    Object(ObjectId),
    Part(VolumeId),
    LayerRange(LayerRangeId),
}
impl Target {
    fn scope(&self) -> SettingScope {
        match self {
            Self::Plate(_) => SettingScope::Plate,
            Self::Object(_) => SettingScope::Object,
            Self::Part(_) => SettingScope::Part,
            Self::LayerRange(_) => SettingScope::LayerRange,
        }
    }
    /// The scope as the browser names it in messages.
    fn noun(&self) -> &'static str {
        match self {
            Self::LayerRange(_) => "height range",
            other => other.scope().as_str(),
        }
    }
    fn id(&self) -> &[u16] {
        match self {
            Self::Plate(id) => id.as_utf16(),
            Self::Object(id) => id.as_utf16(),
            Self::Part(id) => id.as_utf16(),
            Self::LayerRange(id) => id.as_utf16(),
        }
    }
}
/// `SetScopedOverridesCommand`: in-scope keys replace the node's overrides;
/// keys the scope does not own are preserved verbatim.
#[derive(Clone)]
pub(super) struct Scoped {
    guard: Guard,
    target: Target,
    next: JsonObject,
    previous: Option<JsonObject>,
}
impl Scoped {
    pub(super) fn new(v: wire::SetScopedOverrides) -> Result<Self, PreparationError> {
        let target = match v.target {
            wire::ScopedTarget::Plate(t) => Target::Plate(id(t.plate_id)?),
            wire::ScopedTarget::Object(t) => Target::Object(id(t.object_id)?),
            wire::ScopedTarget::Part(t) => Target::Part(id(t.volume_id)?),
            wire::ScopedTarget::LayerRange(t) => Target::LayerRange(id(t.layer_range_id)?),
        };
        let overrides = json_text_object(v.overrides_json)?;
        let scope = target.scope();
        // Sorted keys (UTF-16), so the first refusal names the first such key.
        let refused: Vec<&Vec<u16>> = match overrides.value() {
            Value::Object(fields) => fields.keys().filter(|key| !scope.allows(key)).collect(),
            _ => Vec::new(),
        };
        match refused.as_slice() {
            [] => {}
            [key] => {
                return Err(PreparationError::Domain(Text::new(
                    [
                        &key[..],
                        &u(&format!(" cannot be set on a {}", target.noun())),
                    ]
                    .concat(),
                )));
            }
            many => {
                return Err(PreparationError::Domain(Text::from_utf8(&format!(
                    "{} settings cannot be stored at the scope they were given",
                    many.len()
                ))));
            }
        }
        Ok(Self {
            guard: Guard::new(v.guard),
            target,
            next: overrides,
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(&format!("Update {} settings", self.target.noun()))
    }
    fn stale<E>() -> CommandError<E> {
        CommandError::domain(
            "Scoped setting overrides were prepared for a stale canonical project revision",
        )
    }
    fn unknown<E>(&self) -> CommandError<E> {
        let scope = match &self.target {
            Target::LayerRange(_) => "layerRange",
            other => other.scope().as_str(),
        };
        CommandError::Domain(Text::new(
            [
                &u(&format!("No {scope} node matches "))[..],
                self.target.id(),
            ]
            .concat(),
        ))
    }
    /// `resolveTarget(...).stored`.
    fn stored<E>(&self, state: &ProjectState) -> Result<ConfigMap, CommandError<E>> {
        let found = match &self.target {
            Target::Plate(id) => state
                .plates
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.config.clone()),
            Target::Object(id) => state
                .plates
                .iter()
                .flat_map(|p| p.objects.iter())
                .find(|o| &o.id == id)
                .map(|o| o.config.clone()),
            Target::Part(id) => state
                .plates
                .iter()
                .flat_map(|p| p.objects.iter())
                .flat_map(|o| o.volumes.iter())
                .find(|v| &v.id == id)
                .map(|v| v.config.clone()),
            Target::LayerRange(id) => state
                .plates
                .iter()
                .flat_map(|p| p.objects.iter())
                .flat_map(|o| o.layer_ranges.iter())
                .find(|r| &r.id == id)
                .map(|r| r.config.clone()),
        };
        found.ok_or_else(|| self.unknown())
    }
    /// `resolveTarget(...).write`.
    fn write<E>(&self, state: &mut ProjectState, config: ConfigMap) -> Result<(), CommandError<E>> {
        let mut plates = state.plates.to_vec();
        let mut written = false;
        'plates: for plate in plates.iter_mut() {
            if let Target::Plate(id) = &self.target {
                if &plate.id == id {
                    Arc::make_mut(plate).config = config.clone();
                    written = true;
                    break;
                }
                continue;
            }
            let plate = Arc::make_mut(plate);
            let mut objects = plate.objects.to_vec();
            for object in objects.iter_mut() {
                match &self.target {
                    Target::Object(id) if &object.id == id => {
                        Arc::make_mut(object).config = config.clone();
                        written = true;
                    }
                    Target::Part(id) if object.volumes.iter().any(|v| &v.id == id) => {
                        let object = Arc::make_mut(object);
                        let mut volumes = object.volumes.to_vec();
                        let v = volumes.iter().position(|v| &v.id == id).expect("found");
                        Arc::make_mut(&mut volumes[v]).config = config.clone();
                        object.volumes = volumes.into();
                        written = true;
                    }
                    Target::LayerRange(id) if object.layer_ranges.iter().any(|r| &r.id == id) => {
                        let object = Arc::make_mut(object);
                        let mut ranges = object.layer_ranges.to_vec();
                        let r = ranges.iter().position(|r| &r.id == id).expect("found");
                        Arc::make_mut(&mut ranges[r]).config = config.clone();
                        object.layer_ranges = ranges.into();
                        written = true;
                    }
                    _ => {}
                }
                if written {
                    break;
                }
            }
            plate.objects = objects.into();
            if written {
                break 'plates;
            }
        }
        if !written {
            return Err(self.unknown());
        }
        state.plates = plates.into();
        Ok(())
    }
    /// `merged`: out-of-scope stored keys, then every next key.
    fn merged<E>(&self, stored: &ConfigMap) -> Result<ConfigMap, CommandError<E>> {
        let scope = self.target.scope();
        let mut merged: Map = map(stored)
            .into_iter()
            .filter(|(key, _)| !scope.allows(key))
            .collect();
        merged.extend(map(&self.next));
        object(merged)
    }
    pub(super) fn is_noop<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        let snapshot = context.snapshot();
        if !self.guard.is_current(&snapshot) {
            return Err(Self::stale());
        }
        let stored = self.stored(snapshot.state())?;
        Ok(self.merged(&stored)? == stored)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let snapshot = context.snapshot();
        if self.previous.is_none() && !self.guard.is_current(&snapshot) {
            return Err(Self::stale());
        }
        let mut state = snapshot.state().clone();
        let stored = self.stored(&state)?;
        if let Some(previous) = &self.previous
            && &stored != previous
        {
            return Err(CommandError::domain(
                "Cannot redo scoped setting overrides because the stored node config diverged",
            ));
        }
        if self.previous.is_none() {
            self.previous = Some(stored.clone());
        }
        let merged = self.merged(&stored)?;
        self.write(&mut state, merged)?;
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self.previous.clone().ok_or_else(|| {
            CommandError::domain("SetScopedOverridesCommand has not been applied")
        })?;
        let mut state = context.snapshot().state().clone();
        self.write(&mut state, previous)?;
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        let previous = match &self.previous {
            Some(previous) => duplicate::canonical_length(previous)?,
            None => 0,
        };
        Ok(duplicate::canonical_length(&self.next)? + previous)
    }
}
