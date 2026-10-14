//! "Import geometry only" for a 3MF project (`GeometryMergeParser`).
//!
//! Deserializes the 3MF package (both canonical and foreign BBS) and merges its
//! objects and meshes into the base project's active plate. Plates, settings,
//! filaments, custom G-code and thumbnails are dropped with notices. Deduplicates
//! identical mesh assets, renames colliding objects and centers merged geometry on the bed.
use super::{
    Limits, Malformed,
    host::{Base, Failure, Ids, Request, Xoshiro},
    stage::IdKind,
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::{AssetPayload, content_digest},
    ids::{AssetId, InstanceId, ObjectId, VolumeId},
    import::{self, Parsed, Prepared, Source},
    model::{
        AssetOrigin, AssetProvenance, ExtraFields, JsonObject, Number,
        ProjectInstance, ProjectObject, Text, Encode,
    },
    validation::TimestampPolicy,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}

fn s(text: &str) -> Value {
    Value::String(key(text))
}

fn u(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&key(name)),
        _ => None,
    }
}

fn record<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (key(k), v)).collect())
}

fn unique_name(name: &str, used: &HashSet<String>) -> String {
    if !used.contains(name) {
        return name.to_string();
    }
    for attempt in 2..1000 {
        let candidate = format!("{name} ({attempt})");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    format!("{name} ({})", used.len() + 1)
}

fn center_merged(merged: &mut [ProjectObject], bed: [f64; 4]) {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for object in merged.iter() {
        for instance in object.instances.iter() {
            let t = instance.transform.translation_mm;
            let x = t[0].get();
            let y = t[1].get();
            if x < min_x { min_x = x; }
            if x > max_x { max_x = x; }
            if y < min_y { min_y = y; }
            if y > max_y { max_y = y; }
        }
    }
    if !min_x.is_finite() || !min_y.is_finite() {
        return;
    }
    let delta_x = (bed[0] + bed[2]) / 2.0 - (min_x + max_x) / 2.0;
    let delta_y = (bed[1] + bed[3]) / 2.0 - (min_y + max_y) / 2.0;
    for object in merged.iter_mut() {
        let mut new_instances = Vec::new();
        for instance in object.instances.iter() {
            let mut next_inst = instance.as_ref().clone();
            let t = next_inst.transform.translation_mm;
            next_inst.transform.translation_mm = [
                Number::new(t[0].get() + delta_x).unwrap(),
                Number::new(t[1].get() + delta_y).unwrap(),
                t[2],
            ];
            new_instances.push(Arc::new(next_inst));
        }
        object.instances = new_instances.into();
    }
}

pub fn prepare<P: TimestampPolicy>(
    bytes: &[u8],
    request: &Request,
    _limits: &Limits,
    base: &Base,
    timestamps: &mut P,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Prepared, Failure> {
    if bytes.is_empty() {
        return Err(Failure::Unsupported(super::Unsupported::EmptyInput));
    }
    let cursor = std::io::Cursor::new(bytes);
    let archive = crate::Archive::open(cursor, crate::ZipLimits::default(), &mut cancelled)
        .map_err(|e| match e {
            crate::Error::Cancelled => Failure::Cancelled,
            _ => Failure::Malformed(Malformed::Truncated),
        })?;
    let policy_limits = crate::policy::Policy::default().open();
    let completed = crate::open::open(archive, policy_limits, timestamps, &mut cancelled)
        .map_err(|e| match e {
            crate::canonical::Error::Failure(crate::canonical::Failure::Cancelled) => Failure::Cancelled,
            _ => Failure::Malformed(Malformed::InvalidSyntax),
        })?;

    if cancelled() {
        return Err(Failure::Cancelled);
    }

    let source_state = completed.project().state();
    let source_assets = completed.assets();
    let warnings = completed.warnings();

    let mut state = base.state.clone();
    if state.plates.is_empty() {
        return Err(Failure::State);
    }
    let plate_idx = state
        .plates
        .iter()
        .position(|p| p.id == state.active_plate_id)
        .unwrap_or(0);

    let mut assets = base.assets.clone();
    let mut imported_asset_ids = Vec::new();
    let mut repairs = Vec::new();
    let mut dropped_fields = Vec::new();
    let mut diagnostics = Vec::new();

    let mut notice_index = 0usize;
    let mut next_notice_id = |prefix: &str| -> Vec<u16> {
        notice_index += 1;
        format!("geometry-import-{prefix}-{notice_index}")
            .encode_utf16()
            .collect()
    };

    let mut id_count = 0usize;
    let mut random = match &request.ids {
        Ids::Uuid(seed) => Some(Xoshiro(if *seed == [0; 4] { [1, 0, 0, 0] } else { *seed })),
        Ids::Counter(_) => None,
    };
    let mut next_id = |kind: IdKind| -> Vec<u16> {
        id_count += 1;
        match (&request.ids, &mut random) {
            (_, Some(random)) => random.uuid(),
            (Ids::Counter(namespace), _) => format!("import:{namespace}:{}-{id_count}", kind.code())
                .encode_utf16()
                .collect(),
            _ => unreachable!(),
        }
    };

    let mut asset_map: HashMap<AssetId, AssetId> = HashMap::new();
    let mut used_names: HashSet<String> = state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter().map(|o| String::from_utf16_lossy(o.name.units())))
        .collect();
    let mut merged: Vec<ProjectObject> = Vec::new();
    let mut new_descriptors = Vec::new();

    let empty_config = JsonObject::new(Value::Object(BTreeMap::new())).unwrap();

    for source_plate in source_state.plates.iter() {
        for object in source_plate.objects.iter() {
            if cancelled() {
                return Err(Failure::Cancelled);
            }
            let mut volumes = Vec::new();
            for volume in object.volumes.iter() {
                let payload = source_assets.get(&volume.source.asset_id);
                let descriptor = source_state
                    .source_assets
                    .iter()
                    .find(|d| d.id == volume.source.asset_id);
                let (Some(payload), Some(descriptor)) = (payload, descriptor) else {
                    return Err(Failure::State);
                };
                let target_asset_id = match asset_map.get(&volume.source.asset_id) {
                    Some(id) => id.clone(),
                    None => {
                        let desc_val = descriptor.as_ref().to_value().map_err(|_| Failure::Encoding)?;
                        let desc_digest = field(&desc_val, "digest");
                        let desc_mesh = field(&desc_val, "mesh");
                        let existing = assets.iter().find(|candidate| {
                            let cand_kind = field(&candidate.descriptor, "kind");
                            let cand_digest = field(&candidate.descriptor, "digest");
                            let cand_mesh = field(&candidate.descriptor, "mesh");
                            cand_kind == Some(&s("mesh"))
                                && cand_digest.is_some()
                                && cand_digest == desc_digest
                                && cand_mesh == desc_mesh
                        });
                        let target_id = if let Some(existing) = existing {
                            let existing_id: Vec<u16> = match &existing.descriptor {
                                Value::Object(fields) => match fields.get(&key("id")) {
                                    Some(Value::String(id)) => id.clone(),
                                    _ => next_id(IdKind::Asset),
                                },
                                _ => next_id(IdKind::Asset),
                            };
                            let target_id = AssetId::try_from_utf16(existing_id).map_err(|_| Failure::Encoding)?;
                            let notice_id = next_notice_id("dedup");
                            let obj_name = String::from_utf16_lossy(object.name.units());
                            let vol_name = String::from_utf16_lossy(volume.name.units());
                            let path = format!("$.objects[{obj_name}].volumes[{vol_name}]")
                                .encode_utf16()
                                .collect::<Vec<_>>();
                            let msg = format!("Reused the identical mesh already stored as {}", String::from_utf16_lossy(target_id.as_utf16()))
                                .encode_utf16()
                                .collect::<Vec<_>>();
                            repairs.push(record([
                                ("id", u(&notice_id)),
                                ("kind", s("asset-deduplication")),
                                ("path", u(&path)),
                                ("message", u(&msg)),
                                ("requiresConfirmation", Value::Bool(false)),
                            ]));
                            target_id
                        } else {
                            let target_id = AssetId::try_from_utf16(next_id(IdKind::Asset)).map_err(|_| Failure::Encoding)?;
                            let mut next_desc = descriptor.as_ref().clone();
                            next_desc.id = target_id.clone();
                            next_desc.provenance = Some(Arc::new(AssetProvenance {
                                source: AssetOrigin::Import,
                                uri: None,
                                imported_at: Some(Text::new(request.imported_at.clone())),
                                extra: ExtraFields::default(),
                            }));
                            let desc_value = next_desc.to_value().map_err(|_| Failure::Encoding)?;
                            assets.push(AssetPayload {
                                descriptor: desc_value,
                                bytes: payload.bytes.clone(),
                            });
                            new_descriptors.push(Arc::new(next_desc));
                            imported_asset_ids.push(target_id.clone());
                            target_id
                        };
                        asset_map.insert(volume.source.asset_id.clone(), target_id.clone());
                        target_id
                    }
                };
                let mut next_volume = volume.as_ref().clone();
                next_volume.id = VolumeId::try_from_utf16(next_id(IdKind::Volume)).map_err(|_| Failure::Encoding)?;
                next_volume.source.asset_id = target_asset_id;
                next_volume.filament_id = None;
                next_volume.config = empty_config.clone();
                volumes.push(Arc::new(next_volume));
            }
            if volumes.is_empty() {
                continue;
            }
            let original_name = String::from_utf16_lossy(object.name.units());
            let name = unique_name(&original_name, &used_names);
            if name != original_name {
                let notice_id = next_notice_id("rename");
                let path = format!("$.objects[{original_name}]").encode_utf16().collect::<Vec<_>>();
                let msg = format!("Renamed imported object \"{original_name}\" to \"{name}\" because that name is already used")
                    .encode_utf16()
                    .collect::<Vec<_>>();
                repairs.push(record([
                    ("id", u(&notice_id)),
                    ("kind", s("identifier-remap")),
                    ("path", u(&path)),
                    ("message", u(&msg)),
                    ("before", u(&original_name.encode_utf16().collect::<Vec<_>>())),
                    ("after", u(&name.encode_utf16().collect::<Vec<_>>())),
                    ("requiresConfirmation", Value::Bool(false)),
                ]));
            }
            used_names.insert(name.clone());

            let instances: Vec<Arc<ProjectInstance>> = object
                .instances
                .iter()
                .map(|inst: &Arc<ProjectInstance>| {
                    let mut next_inst = inst.as_ref().clone();
                    next_inst.id = InstanceId::try_from_utf16(next_id(IdKind::Instance)).unwrap();
                    Arc::new(next_inst)
                })
                .collect();

            let ext_data = {
                let mut src = BTreeMap::new();
                src.insert(key("filename"), Value::String(request.filename.clone()));
                src.insert(key("format"), Value::String(key("project-3mf")));
                src.insert(key("mode"), Value::String(key("geometry-only")));
                src.insert(key("importedAt"), Value::String(request.imported_at.clone()));
                let mut ext = BTreeMap::new();
                ext.insert(key("orcaxr:importSource"), Value::Object(src));
                Some(JsonObject::new(Value::Object(ext)).unwrap())
            };

            let mut next_object = object.as_ref().clone();
            next_object.id = ObjectId::try_from_utf16(next_id(IdKind::Object)).map_err(|_| Failure::Encoding)?;
            next_object.name = Text::from_utf8(&name);
            next_object.config = empty_config.clone();
            next_object.filament_id = None;
            next_object.volumes = volumes.into();
            next_object.instances = instances.into();
            next_object.layer_ranges = Arc::new([]);
            next_object.extension_data = ext_data;
            merged.push(next_object);
        }
    }

    if merged.is_empty() {
        return Err(Failure::Malformed(Malformed::NoGeometry));
    }

    if let Some(bed) = request.placement.bed_area_mm {
        center_merged(&mut merged, bed);
    }

    let mut plates = state.plates.to_vec();
    let mut active_plate = plates[plate_idx].as_ref().clone();
    let mut objs = active_plate.objects.to_vec();
    objs.extend(merged.into_iter().map(Arc::new));
    active_plate.objects = objs.into();
    plates[plate_idx] = Arc::new(active_plate);
    state.plates = plates.into();

    let mut desc_list = state.source_assets.to_vec();
    desc_list.extend(new_descriptors);
    state.source_assets = desc_list.into();
    state.updated_at = Text::new(request.imported_at.clone());

    let discarded: [(&str, usize, &str); 5] = [
        (
            "plates",
            source_state.plates.len().saturating_sub(1),
            "Extra plates were not imported; every object joined the active plate",
        ),
        (
            "filaments",
            source_state.filaments.physical.len() + source_state.filaments.mixed.len(),
            "The source filament library and its per-part assignments were not imported",
        ),
        (
            "project-settings",
            match source_state.config.value() {
                Value::Object(f) => f.len(),
                _ => 0,
            },
            "Source project settings were not imported",
        ),
        (
            "custom-gcode",
            source_state.custom_gcode.len(),
            "Source custom G-code was not imported",
        ),
        (
            "thumbnails",
            source_state.thumbnails.len(),
            "Source thumbnails were not imported",
        ),
    ];
    for (field_name, count, msg) in discarded {
        if count > 0 {
            let text = format!("{msg} ({count}).").encode_utf16().collect::<Vec<_>>();
            dropped_fields.push(record([
                ("id", u(&next_notice_id(field_name))),
                ("path", u(&request.filename)),
                ("field", s(field_name)),
                ("message", u(&text)),
            ]));
        }
    }

    for warning in crate::text::import_warnings(source_state, warnings) {
        diagnostics.push(record([
            ("id", u(&next_notice_id("warning"))),
            ("severity", s("info")),
            ("code", s("bbs-import-warning")),
            ("path", u(&request.filename)),
            ("message", u(&warning)),
        ]));
    }

    let parsed = Parsed {
        state,
        assets,
        imported_asset_ids,
        repairs,
        conflicts: Vec::new(),
        dropped_fields,
        diagnostics,
    };
    let source = Source {
        filename: request.filename.clone(),
        media_type: None,
        uri: None,
        imported_at: request.imported_at.clone(),
    };
    let base_content: HashMap<Vec<u16>, String> = base
        .assets
        .iter()
        .filter_map(|a| match &a.descriptor {
            Value::Object(fields) => match fields.get(&key("id")) {
                Some(Value::String(id)) => Some((id.clone(), content_digest(&a.bytes))),
                _ => None,
            },
            _ => None,
        })
        .collect();

    import::prepare(
        parsed,
        &source,
        &base_content,
        base.revision,
        &base.hash,
        false,
        timestamps,
    )
    .map_err(|_| Failure::Timestamp)
}
