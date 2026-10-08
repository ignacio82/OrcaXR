use super::{
    Issue, Severity, TimestampPolicy, ValidationReport, annotations, layer_event_height_key, mixed,
};
use crate::model::equality::equal_json;
use crate::{
    ids::{EntityId, FilamentId, ecmascript_whitespace},
    model::*,
};
use orcaxr_contracts::canonical::Value;
use std::collections::{BTreeMap, BTreeSet};

/// ProjectData already proves typed structure, finite JSON, valid IDs and
/// serializable extra fields. This checks graph semantics, not unchecked JS
/// object shapes, option-value/profile eligibility or actual asset bytes.
pub fn validate_project<P: TimestampPolicy>(
    data: &ProjectData,
    timestamps: &mut P,
) -> Result<ValidationReport, P::Error> {
    let state = data.state();
    let mut v = Validator {
        issues: vec![],
        ids: BTreeMap::new(),
    };
    v.id(&state.id, "id".into());
    if blank(state.name.units()) {
        v.add("empty-name", "name", "Project name cannot be empty");
    }
    for (name, text) in [
        ("createdAt", &state.created_at),
        ("updatedAt", &state.updated_at),
    ] {
        if !timestamps.is_valid(text.units())? {
            v.add(
                "invalid-timestamp",
                name,
                format!("{name} must be ISO-compatible"),
            );
        }
    }
    let tool_count = state.printer.tool_count.get();
    if !integer(tool_count) || tool_count < 1.0 {
        v.add(
            "invalid-tool-count",
            "printer.toolCount",
            "Printer toolCount must be a positive integer",
        );
    }
    v.config(&state.config, "config");
    if let Some(base) = &state.settings_base_config {
        v.config(base, "settingsBaseConfig");
    }
    if let Some(overrides) = &state.settings_overrides {
        v.config(overrides, "settingsOverrides");
        if state.settings_base_config.is_none() {
            v.add(
                "missing-settings-base-config",
                "settingsBaseConfig",
                "Explicit project setting overrides require an inherited settings base",
            );
        }
    }
    if let Some(base) = &state.settings_base_config
        && !effective_matches(&state.config, base, state.settings_overrides.as_ref())
    {
        v.add(
            "mismatched-effective-settings-config",
            "config",
            "Effective project configuration must equal inherited settings plus explicit overrides",
        );
    }
    let mut assets = BTreeMap::new();
    for (i, asset) in state.source_assets.iter().enumerate() {
        let path = format!("sourceAssets[{i}]");
        v.id(&asset.id, format!("{path}.id"));
        assets.insert(asset.id.as_utf16(), asset.as_ref());
        if blank(asset.digest.units()) {
            v.add(
                "missing-digest",
                format!("{path}.digest"),
                "Asset digest is required",
            );
        }
        if !nonnegative_integer(asset.byte_length.get()) {
            v.add(
                "invalid-byte-length",
                format!("{path}.byteLength"),
                "Asset byteLength must be non-negative",
            );
        }
        mesh(asset, &path, &mut v);
    }
    let mut physical_ids = BTreeSet::new();
    let mut mixed_ids = BTreeSet::new();
    // Existing sparse-refinement validation borrows this one filament index.
    let mut filament_ids = BTreeSet::new();
    let mut tools = BTreeSet::new();
    for (i, filament) in state.filaments.physical.iter().enumerate() {
        let path = format!("filaments.physical[{i}]");
        v.id(&filament.id, format!("{path}.id"));
        physical_ids.insert(filament.id.as_utf16());
        filament_ids.insert(filament.id.as_utf16().to_vec());
        let tool = filament.tool_id.get();
        if !nonnegative_integer(tool) || tool >= tool_count {
            v.add(
                "tool-out-of-range",
                format!("{path}.toolId"),
                format!(
                    "Tool {} is outside [0, {}]",
                    js_number(tool),
                    js_number(tool_count - 1.0)
                ),
            );
        }
        if !tools.insert(number_key(tool)) {
            v.add(
                "duplicate-tool",
                format!("{path}.toolId"),
                format!("Tool {} has multiple physical filaments", js_number(tool)),
            );
        }
        v.config(&filament.config, &format!("{path}.config"));
    }
    for (i, filament) in state.filaments.mixed.iter().enumerate() {
        let path = format!("filaments.mixed[{i}]");
        v.id(&filament.id, format!("{path}.id"));
        mixed_ids.insert(filament.id.as_utf16());
        filament_ids.insert(filament.id.as_utf16().to_vec());
        mixed::shape(filament, &path, &mut v);
        v.config(&filament.config, &format!("{path}.config"));
    }
    mixed::references(&state.filaments.mixed, &physical_ids, &mixed_ids, &mut v);
    let mut plate_ids = BTreeSet::new();
    let mut orders = BTreeSet::new();
    for (pi, plate) in state.plates.iter().enumerate() {
        let pp = format!("plates[{pi}]");
        v.id(&plate.id, format!("{pp}.id"));
        plate_ids.insert(plate.id.as_utf16());
        orders.insert(number_key(plate.order.get()));
        v.config(&plate.config, &format!("{pp}.config"));
        if !nonnegative_integer(plate.order.get()) {
            v.add(
                "invalid-plate-order",
                format!("{pp}.order"),
                "Plate order must be a non-negative integer",
            );
        }
        if let Some(tower) = &plate.wipe_tower {
            filament(
                tower.filament_id.as_ref(),
                &filament_ids,
                &format!("{pp}.wipeTower.filamentId"),
                &mut v,
            );
        }
        for (oi, object) in plate.objects.iter().enumerate() {
            let op = format!("{pp}.objects[{oi}]");
            v.id(&object.id, format!("{op}.id"));
            v.config(&object.config, &format!("{op}.config"));
            filament(
                object.filament_id.as_ref(),
                &filament_ids,
                &format!("{op}.filamentId"),
                &mut v,
            );
            if object.instances.is_empty() {
                v.add(
                    "object-without-instance",
                    format!("{op}.instances"),
                    "An object needs at least one instance",
                );
            }
            if !object.volumes.iter().any(|v| v.role == VolumeRole::Model) {
                v.add(
                    "object-without-model-volume",
                    format!("{op}.volumes"),
                    "An object needs a model volume",
                );
            }
            for (vi, volume) in object.volumes.iter().enumerate() {
                let vp = format!("{op}.volumes[{vi}]");
                v.id(&volume.id, format!("{vp}.id"));
                transform(&volume.transform, &format!("{vp}.transform"), &mut v);
                v.config(&volume.config, &format!("{vp}.config"));
                filament(
                    volume.filament_id.as_ref(),
                    &filament_ids,
                    &format!("{vp}.filamentId"),
                    &mut v,
                );
                let asset = assets.get(volume.source.asset_id.as_utf16());
                if asset.is_none() {
                    v.add(
                        "dangling-asset",
                        format!("{vp}.source.assetId"),
                        "Unknown source asset",
                    );
                }
                if asset.is_none_or(|a| a.kind != SourceAssetKind::Mesh) {
                    v.add(
                        "non-mesh-source",
                        format!("{vp}.source.assetId"),
                        "A volume must reference a mesh asset",
                    );
                }
                if asset
                    .and_then(|a| a.mesh.as_ref())
                    .is_some_and(|m| m.triangle_count != volume.source.triangle_count)
                {
                    v.add(
                        "triangle-count-mismatch",
                        format!("{vp}.source.triangleCount"),
                        "Volume triangle count differs from its asset descriptor",
                    );
                }
                if !nonnegative_integer(volume.source.topology_revision.get()) {
                    v.add(
                        "invalid-topology-revision",
                        format!("{vp}.source.topologyRevision"),
                        "Topology revision must be a non-negative integer",
                    );
                }
                if matches!(
                    volume.role,
                    VolumeRole::NegativeVolume
                        | VolumeRole::SupportEnforcer
                        | VolumeRole::SupportBlocker
                ) && volume.filament_id.is_some()
                {
                    v.add(
                        "incompatible-modifier-filament",
                        format!("{vp}.filamentId"),
                        format!("{} cannot own a filament assignment", volume.role.as_str()),
                    );
                }
                if volume.role != VolumeRole::Model
                    && annotations::has_assignments(&volume.annotations)
                {
                    v.add(
                        "incompatible-modifier-annotations",
                        format!("{vp}.annotations"),
                        format!(
                            "{} cannot own facet paint annotations",
                            volume.role.as_str()
                        ),
                    );
                }
                annotations::validate(
                    &volume.annotations,
                    volume.source.topology_revision.get(),
                    volume.source.triangle_count.get(),
                    &vp,
                    &filament_ids,
                    &mut v,
                );
            }
            for (ii, instance) in object.instances.iter().enumerate() {
                let ip = format!("{op}.instances[{ii}]");
                v.id(&instance.id, format!("{ip}.id"));
                transform(&instance.transform, &format!("{ip}.transform"), &mut v);
            }
            if let Some(ears) = &object.brim_ears {
                for (i, ear) in ears.iter().enumerate() {
                    if ear.head_front_radius_mm.get() <= 0.0 {
                        v.add(
                            "invalid-brim-ear",
                            format!("{op}.brimEars[{i}].headFrontRadiusMm"),
                            "A brim ear needs a positive front radius",
                        );
                    }
                }
            }
            let mut ranges = object.layer_ranges.iter().enumerate().collect::<Vec<_>>();
            // Finite numbers and a stable sort retain JS's +/-0 tie ordering.
            ranges
                .sort_by(|(_, a), (_, b)| a.min_z_mm.get().partial_cmp(&b.min_z_mm.get()).unwrap());
            for (ri, (original, range)) in ranges.iter().enumerate() {
                let rp = format!("{op}.layerRanges[{original}]");
                v.id(&range.id, format!("{rp}.id"));
                if range.min_z_mm.get() < 0.0 || range.max_z_mm.get() <= range.min_z_mm.get() {
                    v.add(
                        "invalid-layer-range",
                        &rp,
                        "Layer range must have 0 <= minZMm < maxZMm",
                    );
                }
                if ri > 0 && range.min_z_mm.get() < ranges[ri - 1].1.max_z_mm.get() {
                    v.add(
                        "overlapping-layer-range",
                        &rp,
                        "Layer ranges on an object may not overlap",
                    );
                }
                v.config(&range.config, &format!("{rp}.config"));
                filament(
                    range.filament_id.as_ref(),
                    &filament_ids,
                    &format!("{rp}.filamentId"),
                    &mut v,
                );
            }
        }
    }
    if !plate_ids.contains(state.active_plate_id.as_utf16()) {
        v.add(
            "dangling-active-plate",
            "activePlateId",
            "Active plate does not exist",
        );
    }
    if orders.len() != state.plates.len() {
        v.add(
            "duplicate-plate-order",
            "plates",
            "Plate order values must be unique",
        );
    }
    let mut heights: BTreeMap<&[u16], BTreeSet<String>> = BTreeMap::new();
    for (i, entry) in state.custom_gcode.iter().enumerate() {
        let p = format!("customGcode[{i}]");
        v.id(&entry.id, format!("{p}.id"));
        if entry.scope == GcodeScope::Plate
            && entry
                .plate_id
                .as_ref()
                .is_none_or(|id| !plate_ids.contains(id.as_utf16()))
        {
            v.add(
                "dangling-gcode-plate",
                format!("{p}.plateId"),
                "Plate-scoped G-code needs an existing plate",
            );
        }
        if entry.scope == GcodeScope::Project && entry.plate_id.is_some() {
            v.add(
                "incompatible-gcode-scope",
                format!("{p}.plateId"),
                "Project-scoped G-code cannot name a plate",
            );
        }
        let Some(event) = &entry.layer_event else {
            continue;
        };
        if entry.scope != GcodeScope::Plate || entry.plate_id.is_none() {
            v.add(
                "layer-event-scope",
                format!("{p}.scope"),
                "A layer event must be scoped to one plate",
            );
        }
        if event.top_z_mm.get() <= 0.0 || event.top_z_mm.get() > 10_000.0 {
            v.add(
                "layer-event-height",
                format!("{p}.layerEvent.topZMm"),
                "Layer-event height must be above the plate and finite",
            );
        }
        if event.kind == LayerEventType::Custom && blank(entry.code.units()) {
            v.add(
                "layer-event-empty-code",
                format!("{p}.code"),
                "A custom layer event needs G-code to emit",
            );
        }
        if event.kind != LayerEventType::Custom && !entry.code.units().is_empty() {
            v.add("layer-event-unexpected-code", format!("{p}.code"), "Only a custom layer event carries its own G-code; the others come from the printer profile");
        }
        if matches!(
            event.kind,
            LayerEventType::ColorChange | LayerEventType::ToolChange
        ) && event
            .tool_index
            .is_none_or(|i| !integer(i.get()) || i.get() < 1.0)
        {
            v.add(
                "layer-event-tool",
                format!("{p}.layerEvent.toolIndex"),
                "Colour and tool changes address a 1-based tool",
            );
        }
        if let Some(plate_id) = &entry.plate_id
            && !heights
                .entry(plate_id.as_utf16())
                .or_default()
                .insert(layer_event_height_key(event.top_z_mm))
        {
            v.add(
                "duplicate-layer-event",
                format!("{p}.layerEvent.topZMm"),
                "One layer event per height on a plate",
            );
        }
    }
    for (i, thumbnail) in state.thumbnails.iter().enumerate() {
        let p = format!("thumbnails[{i}]");
        v.id(&thumbnail.id, format!("{p}.id"));
        if !assets.contains_key(thumbnail.asset_id.as_utf16()) {
            v.add(
                "dangling-asset",
                format!("{p}.assetId"),
                "Unknown thumbnail asset",
            );
        }
        if thumbnail
            .plate_id
            .as_ref()
            .is_some_and(|id| !plate_ids.contains(id.as_utf16()))
        {
            v.add(
                "dangling-thumbnail-plate",
                format!("{p}.plateId"),
                "Unknown thumbnail plate",
            );
        }
        if !integer(thumbnail.width.get())
            || thumbnail.width.get() < 1.0
            || !integer(thumbnail.height.get())
            || thumbnail.height.get() < 1.0
        {
            v.add(
                "invalid-thumbnail-size",
                &p,
                "Thumbnail dimensions must be positive integers",
            );
        }
    }
    for (i, blob) in state.extension_blobs.iter().enumerate() {
        let p = format!("extensionBlobs[{i}]");
        v.id(&blob.id, format!("{p}.id"));
        if !assets.contains_key(blob.asset_id.as_utf16()) {
            v.add(
                "dangling-asset",
                format!("{p}.assetId"),
                "Unknown extension asset",
            );
        }
        if blank(blob.namespace.units()) {
            v.add(
                "missing-extension-namespace",
                format!("{p}.namespace"),
                "Namespace is required",
            );
        }
        if blob.path.units().first() == Some(&47)
            || blob.path.units().split(|c| *c == 47).any(|s| s == [46, 46])
        {
            v.add(
                "unsafe-extension-path",
                format!("{p}.path"),
                "Extension paths must be relative and cannot traverse",
            );
        }
    }
    Ok(ValidationReport(v.issues.into()))
}

pub(super) struct Validator<'a> {
    pub issues: Vec<Issue>,
    ids: BTreeMap<&'a [u16], String>,
}
impl<'a> Validator<'a> {
    pub fn add(&mut self, code: &'static str, path: impl AsRef<str>, message: impl AsRef<str>) {
        self.issues.push(Issue {
            code,
            path: Text::from_utf8(path.as_ref()),
            message: Text::from_utf8(message.as_ref()),
            severity: Severity::Error,
        });
    }
    fn id<K>(&mut self, id: &'a EntityId<K>, path: String) {
        if let Some(previous) = self.ids.get(id.as_utf16()) {
            self.add(
                "duplicate-id",
                &path,
                format!("ID is already used at {previous}"),
            );
        } else {
            self.ids.insert(id.as_utf16(), path);
        }
    }
    fn config(&mut self, config: &ConfigMap, path: &str) {
        for key in fields(config).keys() {
            if blank(key) {
                self.add(
                    "empty-config-key",
                    path,
                    "Configuration keys cannot be empty",
                );
            }
        }
    }
}
pub(super) fn blank(text: &[u16]) -> bool {
    text.iter().all(|c| ecmascript_whitespace(*c))
}
pub(super) fn integer(n: f64) -> bool {
    n.fract() == 0.0
}
pub(super) fn nonnegative_integer(n: f64) -> bool {
    n >= 0.0 && integer(n)
}
pub(super) fn safe_integer(n: f64) -> bool {
    nonnegative_integer(n) && n <= 9_007_199_254_740_991.0
}
pub(super) fn number_key(n: f64) -> u64 {
    if n == 0.0 { 0 } else { n.to_bits() }
}
pub(super) use crate::js_math::convert::number_to_string as js_number;
pub(super) fn fields(value: &JsonObject) -> &BTreeMap<Vec<u16>, Value> {
    let Value::Object(fields) = value.value() else {
        unreachable!("typed JSON object")
    };
    fields
}
fn filament(
    value: Option<&FilamentId>,
    ids: &BTreeSet<Vec<u16>>,
    path: &str,
    v: &mut Validator<'_>,
) {
    if value.is_some_and(|id| !ids.contains(id.as_utf16())) {
        v.add("dangling-filament", path, "Unknown filament reference");
    }
}
fn transform(t: &Transform, path: &str, v: &mut Validator<'_>) {
    if t.scale.iter().any(|c| c.get().abs() < 1e-12) {
        v.add(
            "non-invertible-transform",
            format!("{path}.scale"),
            "Transform scale cannot contain zero",
        );
    }
    let norm = t
        .rotation
        .iter()
        .fold(0.0, |sum, c| sum + c.get() * c.get());
    if !norm.is_finite() || norm < 1e-12 {
        v.add(
            "non-invertible-transform",
            format!("{path}.rotation"),
            "Rotation quaternion cannot be zero",
        );
    }
}
fn mesh(asset: &SourceAssetDescriptor, path: &str, v: &mut Validator<'_>) {
    if asset.kind == SourceAssetKind::Mesh && asset.mesh.is_none() {
        v.add(
            "missing-mesh-layout",
            format!("{path}.mesh"),
            "Mesh asset needs a layout",
        );
    }
    if asset.kind != SourceAssetKind::Mesh && asset.mesh.is_some() {
        v.add(
            "unexpected-mesh-layout",
            format!("{path}.mesh"),
            "Only mesh assets can have a layout",
        );
    }
    let Some(mesh) = &asset.mesh else {
        return;
    };
    if !nonnegative_integer(mesh.triangle_count.get()) {
        v.add(
            "invalid-triangle-count",
            format!("{path}.mesh.triangleCount"),
            "Triangle count must be non-negative",
        );
    }
    for (name, view) in [
        ("positions", Some(&mesh.positions)),
        ("indices", mesh.indices.as_ref()),
    ] {
        let Some(view) = view else {
            continue;
        };
        if view.byte_offset.get() < 0.0
            || view.byte_length.get() < 0.0
            || view.byte_offset.get() + view.byte_length.get() > asset.byte_length.get()
        {
            v.add(
                "buffer-view-out-of-range",
                format!("{path}.mesh.{name}"),
                "Buffer view exceeds asset bounds",
            );
        }
        if !nonnegative_integer(view.count.get()) {
            v.add(
                "invalid-buffer-count",
                format!("{path}.mesh.{name}.count"),
                "Buffer count must be non-negative",
            );
        }
    }
}
fn effective_matches(config: &ConfigMap, base: &ConfigMap, overrides: Option<&ConfigMap>) -> bool {
    let config = fields(config);
    let base = fields(base);
    let overrides = overrides.map(fields);
    let len = base.len()
        + overrides.map_or(0, |o| {
            o.keys().filter(|key| !base.contains_key(*key)).count()
        });
    config.len() == len
        && config.iter().all(|(key, value)| {
            overrides
                .and_then(|o| o.get(key))
                .or_else(|| base.get(key))
                .is_some_and(|expected| equal_json(value, expected))
        })
}
