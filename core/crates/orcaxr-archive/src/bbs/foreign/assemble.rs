//! Canonical state assembly for a foreign BBS/3MF package (`importBbsCore`).
//!
//! Inputs are the admitted structural package, its resolved component graph and
//! the decoded metadata members. The output is an unadmitted schema-1 state
//! value with its mesh and drawing payloads; the import owner performs OPC
//! reconciliation, member preservation and admission. Identifiers, ordering and
//! number conversions follow the browser exactly.
use super::js;
use super::metadata::{
    self, Config, ModelSettings, NumKey, PlateMeta, ProjectSettings, Role, utf16,
};
use super::mixed;
use super::scan::decode_xml;
use super::{Failure, Warning, WarningCode};
use crate::bbs::read_xml::{
    graph::{ComponentEdgeRef, ObjectRef, ResolvedGraph},
    part::{ExtensionAttribute, Mesh, Object, Part},
};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    assets::content_digest,
    facets::{FacetChannel, PaintValue},
    model::Number,
    validation::layer_event_height_key,
};
use std::collections::{BTreeMap, BTreeSet};

pub const CORE_MODEL_PATH: &str = "3D/3dmodel.model";
const NS: &str = "https://orcaxr.martinez.fyi/3mf/project/1";
const PAINT_SLOT: &str = "import:3mf:paint-slot-";
/// Project validation's highest layer-event height.
const MAX_LAYER_EVENT_Z_MM: f64 = 10_000.0;

pub struct Input<'a> {
    pub archive_hash: &'a str,
    pub parts: &'a BTreeMap<String, Part>,
    pub graph: &'a ResolvedGraph,
    pub project: ProjectSettings,
    pub model: ModelSettings,
    pub plates: PlateCoordinates,
    pub layer_ranges: BTreeMap<NumKey, Vec<metadata::Range>>,
    pub layer_events: BTreeMap<NumKey, Vec<metadata::LayerEvent>>,
    pub brim_text: Option<&'a str>,
    pub heights_text: Option<&'a str>,
    pub max_materialization_units: u64,
}
pub struct Output {
    pub state: Value,
    /// Mesh payloads in object order, then SVG drawings in first-use order.
    pub assets: Vec<(Value, Vec<u8>)>,
    pub consumed_svg_paths: BTreeSet<String>,
}
/// Plate-local coordinates (`importedPlateCoordinates`).
pub struct PlateCoordinates {
    pub definitions: Vec<PlateMeta>,
    pub plate_by_build_item: Vec<usize>,
    pub origins: Vec<(f64, f64)>,
    pub normalized_build_items: usize,
}

fn s(v: &str) -> Value {
    Value::String(utf16(v))
}
fn obj<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (utf16(k), v)).collect())
}
fn push(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str, value: Value) {
    fields.insert(utf16(key), value);
}
fn fnv(bytes: &[u8]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for b in bytes {
        hash = (hash ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}
/// `objectReferenceToken`.
fn token(r: &ObjectRef) -> String {
    format!("{}-{}", fnv(r.model_path.as_bytes()), r.object_id)
}
fn attrs_value(attrs: &[ExtensionAttribute]) -> Value {
    Value::Array(
        attrs
            .iter()
            .map(|a| {
                obj([
                    ("namespace", s(&a.namespace)),
                    ("name", s(&a.name)),
                    ("value", s(&a.value)),
                ])
            })
            .collect(),
    )
}
/// The browser decodes object and material names a second time and treats an
/// empty name as absent.
fn display_name(name: &str, fallback: impl FnOnce() -> String) -> Result<Vec<u16>, Failure> {
    if name.is_empty() {
        return Ok(utf16(&fallback()));
    }
    decode_xml(&utf16(name)).map_err(|_| Failure::Metadata)
}

/// bbsCore `normalizeColor(color).slice(0, 7)`.
pub fn tool_color(color: &[u16]) -> Vec<u16> {
    let text = String::from_utf16(js::trim_utf16(color)).unwrap_or_default();
    let hex = text.strip_prefix('#').unwrap_or(&text);
    if (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        utf16(&format!("#{}", hex[..6].to_ascii_uppercase()))
    } else {
        utf16("#CCCCCC")
    }
}
/// `perToolConfigValues`.
fn per_tool(config: &Config, key: &str) -> Vec<Vec<u16>> {
    match config.get(&utf16(key)) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|e| match e {
                Value::String(v) => js::trim_utf16(v).to_vec(),
                Value::Null => Vec::new(),
                v => js::value_to_string(v),
            })
            .collect(),
        Some(Value::String(v)) => {
            let separator = [b';', b',']
                .into_iter()
                .find(|c| v.contains(&u16::from(*c)));
            match separator {
                Some(c) => v
                    .split(|u| *u == u16::from(c))
                    .map(|p| js::trim_utf16(p).to_vec())
                    .collect(),
                None => vec![js::trim_utf16(v).to_vec()],
            }
        }
        Some(v) => vec![js::value_to_string(v)],
    }
}

/// Facet annotation materialization units without the browser's early exit,
/// which only shortens a count that already exceeds the limit.
fn materialization_units(channels: [&FacetChannel; 4]) -> u64 {
    channels
        .iter()
        .map(|c| {
            c.checked_materialization_units()
                .map_or(u64::MAX, |n| n as u64)
        })
        .fold(0u64, u64::saturating_add)
}

fn annotations_value(mesh: &Mesh, color: &FacetChannel) -> Value {
    let a = &mesh.annotations;
    let mut fields = BTreeMap::new();
    let mut refinement = BTreeMap::new();
    push(&mut fields, "topologyRevision", Value::Number(0.0));
    for (name, channel) in [
        ("color", color),
        ("support", &a.support),
        ("seam", &a.seam),
        ("fuzzySkin", &a.fuzzy_skin),
    ] {
        push(
            &mut fields,
            name,
            Value::Array(channel.assignments().iter().map(|v| v.to_value()).collect()),
        );
        if let Some(encoding) = channel.encoding() {
            push(&mut refinement, name, encoding.to_value());
        }
    }
    push(&mut fields, "brim", Value::Array(Vec::new()));
    if !refinement.is_empty() {
        push(&mut fields, "refinement", Value::Object(refinement));
    }
    Value::Object(fields)
}

struct Filament {
    id: Vec<u16>,
    name: Vec<u16>,
    color: Vec<u16>,
}
fn slot<'a>(assignment: &[&'a Filament], requested: f64) -> Option<&'a Filament> {
    (js::is_integer(requested) && requested >= 1.0 && requested <= assignment.len() as f64)
        .then(|| assignment[requested as usize - 1])
}

/// Port of `importBbsCore` after its member parsers. `Err` aborts the import.
/// Reads one archive member by path, or `None` when the package lacks it.
pub type MemberReader<'a> = dyn FnMut(&str) -> Result<Option<Vec<u8>>, Failure> + 'a;
pub fn assemble(
    input: Input<'_>,
    files: &mut MemberReader<'_>,
    warnings: &mut Vec<Warning>,
) -> Result<Output, Failure> {
    let hash = input.archive_hash;
    let make_id = |kind: &str, suffix: &str| utf16(&format!("import:3mf:{hash}-{kind}-{suffix}"));
    let root = input.parts.get(CORE_MODEL_PATH).ok_or(Failure::Graph)?;
    // The browser's object Map order: the root part, then referenced parts in
    // UTF-16 path order, each in XML order.
    let mut part_order = vec![CORE_MODEL_PATH];
    part_order.extend(input.graph.external_model_paths.iter().map(String::as_str));
    let mut objects: Vec<(ObjectRef, &Object)> = Vec::new();
    for path in part_order {
        let part = input.parts.get(path).ok_or(Failure::Graph)?;
        for object in &part.objects {
            objects.push((
                ObjectRef {
                    model_path: path.to_owned(),
                    object_id: object.id,
                },
                object,
            ));
        }
    }
    let by_ref: BTreeMap<&ObjectRef, &Object> = objects.iter().map(|(r, o)| (r, *o)).collect();
    let object_name = |o: &Object| display_name(&o.name, || format!("Object {}", o.id));
    let materials: Vec<(Vec<u16>, Vec<u16>)> = root
        .materials
        .iter()
        .enumerate()
        .map(|(i, m)| {
            Ok((
                display_name(&m.name, || format!("Imported tool {}", i + 1))?,
                tool_color(&utf16(&m.display_color)),
            ))
        })
        .collect::<Result<_, Failure>>()?;

    // Physical filaments.
    let project = &input.project;
    let colors: Vec<Vec<u16>> = if !project.filament_colors.is_empty() {
        project
            .filament_colors
            .iter()
            .map(|c| tool_color(c))
            .collect()
    } else if !materials.is_empty() {
        materials.iter().map(|(_, c)| c.clone()).collect()
    } else {
        vec![utf16("#CCCCCC")]
    };
    let types = per_tool(&project.config, "filament_type");
    let names = per_tool(&project.config, "filament_settings_id");
    let low = per_tool(&project.config, "nozzle_temperature_range_low");
    let high = per_tool(&project.config, "nozzle_temperature_range_high");
    let nonempty = |v: &[Vec<u16>], i: usize| v.get(i).filter(|x| !x.is_empty()).cloned();
    let mut physical_values = Vec::new();
    let mut physical = Vec::new();
    for (i, color) in colors.iter().enumerate() {
        let mut cfg = Config::new();
        for (key, values) in [
            ("filament_type", &types),
            ("nozzle_temperature_range_low", &low),
            ("nozzle_temperature_range_high", &high),
        ] {
            if let Some(v) = nonempty(values, i) {
                cfg.insert(utf16(key), Value::String(v));
            }
        }
        let id = make_id("physical-filament", &(i + 1).to_string());
        let name = nonempty(&names, i)
            .or_else(|| materials.get(i).map(|(n, _)| n.clone()))
            .unwrap_or_else(|| utf16(&format!("Imported tool {}", i + 1)));
        physical_values.push(obj([
            ("id", Value::String(id.clone())),
            ("name", Value::String(name.clone())),
            ("toolId", Value::Number(i as f64)),
            (
                "material",
                Value::String(nonempty(&types, i).unwrap_or_else(|| utf16("Unknown"))),
            ),
            ("color", Value::String(color.clone())),
            ("config", Value::Object(cfg)),
            ("enabled", Value::Bool(true)),
        ]));
        physical.push(Filament {
            id,
            name,
            color: color.clone(),
        });
    }
    // FullSpectrum rows.
    let mut mixed_values = Vec::new();
    let mut enabled_mixed = Vec::new();
    if let Some(definitions) = project.mixed_definitions.as_ref().filter(|d| !d.is_empty()) {
        let phys: Vec<mixed::Physical<'_>> = physical
            .iter()
            .map(|p| mixed::Physical {
                id: &p.id,
                color: &p.color,
            })
            .collect();
        let rest: Vec<mixed::Material<'_>> = materials
            .iter()
            .skip(physical.len())
            .map(|(name, color)| mixed::Material { name, color })
            .collect();
        let imported = mixed::import(definitions, &phys, &rest, |row, stable| {
            make_id("mixed-filament", &format!("{}-{stable}", row + 1))
        })?;
        for issue in &imported.issues {
            let mut text = utf16(&format!(
                "FullSpectrum row {} {}: ",
                issue.row_index + 1,
                if issue.error { "error" } else { "warning" }
            ));
            text.extend(&issue.message);
            warnings.push(Warning::from_utf16(WarningCode::FullSpectrum, text));
        }
        for (value, enabled) in imported.filaments.iter().zip(&imported.enabled) {
            if !*enabled {
                continue;
            }
            let field = |k: &str| match value {
                Value::Object(f) => match f.get(&utf16(k)) {
                    Some(Value::String(v)) => v.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            enabled_mixed.push(Filament {
                id: field("id"),
                name: field("name"),
                color: field("displayColor"),
            });
        }
        mixed_values = imported.filaments;
    }
    let assignment: Vec<&Filament> = physical.iter().chain(enabled_mixed.iter()).collect();

    // Resolve color paint slots on every parsed mesh, reachable or not.
    let mut colors_by_ref: BTreeMap<&ObjectRef, FacetChannel> = BTreeMap::new();
    for (r, object) in &objects {
        let Some(mesh) = &object.mesh else { continue };
        let mut missing = false;
        let remapped = mesh
            .annotations
            .color
            .remap(
                |value| {
                    let resolved = match value {
                        PaintValue::Text(units) => String::from_utf16(units)
                            .ok()
                            .and_then(|slot| {
                                slot.strip_prefix(PAINT_SLOT)
                                    .filter(|d| {
                                        !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
                                    })
                                    .map(js::number)
                            })
                            .and_then(|n| slot(&assignment, n)),
                        PaintValue::Bool(_) => None,
                    };
                    match resolved {
                        Some(f) => PaintValue::text(f.id.clone()),
                        None => {
                            missing = true;
                            value.clone()
                        }
                    }
                },
                None,
            )
            .map_err(|_| Failure::Paint)?;
        if missing {
            return Err(Failure::PaintSlot);
        }
        colors_by_ref.insert(r, remapped);
    }
    if mixed_values.is_empty()
        && project
            .mixed_definitions
            .as_ref()
            .is_some_and(|d| !d.is_empty())
    {
        warnings.push(Warning::new(
            WarningCode::FullSpectrum,
            "No valid canonical FullSpectrum rows could be reconstructed; raw definitions remain preserved in config.",
        ));
    }
    if input.plates.normalized_build_items > 0 {
        let n = input.plates.normalized_build_items;
        warnings.push(Warning::new(
            WarningCode::PlateCoordinates,
            &format!(
                "Normalized {n} BBS build transform{} from the virtual multi-plate grid into plate-local printer coordinates",
                if n == 1 { "" } else { "s" }
            ),
        ));
    }
    let external = input.graph.external_model_paths.len();
    if external > 0 {
        warnings.push(Warning::new(
            WarningCode::ProductionParts,
            &format!(
                "Resolved {external} referenced 3MF Production Extension model part{} into the generated core model; the original split members are not kept as a second copy",
                if external == 1 { "" } else { "s" }
            ),
        ));
    }

    // Build groups in first-occurrence order, with per-object occurrence ordinals.
    let mut group_order: Vec<&ObjectRef> = Vec::new();
    let mut groups: BTreeMap<&ObjectRef, Vec<(usize, usize)>> = BTreeMap::new();
    for (build_index, item) in input.graph.build.iter().enumerate() {
        let rows = groups.entry(&item.object).or_insert_with(|| {
            group_order.push(&item.object);
            Vec::new()
        });
        let ordinal = rows.len();
        rows.push((build_index, ordinal));
    }
    // assertUnambiguousTopLevelMetadata
    let mut paths_by_id: BTreeMap<u64, BTreeSet<&str>> = BTreeMap::new();
    for r in &group_order {
        paths_by_id
            .entry(r.object_id)
            .or_default()
            .insert(&r.model_path);
    }
    for (id, paths) in &paths_by_id {
        let key = NumKey::new(*id as f64);
        if paths.len() > 1
            && (input.model.object_config.contains_key(&key)
                || input.model.object_names.contains_key(&key)
                || input.model.part_data.contains_key(&key)
                || input.model.layer_ranges.contains_key(&key))
        {
            return Err(Failure::AmbiguousMetadata);
        }
    }

    // Mesh assets in object order, reachable meshes only.
    let mut assets = Vec::new();
    let mut source_assets = Vec::new();
    let mut mesh_assets: BTreeMap<&ObjectRef, Vec<u16>> = BTreeMap::new();
    for (r, object) in &objects {
        let Some(mesh) = &object.mesh else { continue };
        if !input.graph.reachable_mesh_objects.contains(r) {
            continue;
        }
        let vertices = mesh.positions.len();
        let triangles = mesh.triangles.len();
        let length = vertices
            .checked_mul(12)
            .and_then(|n| n.checked_add(triangles.checked_mul(12)?))
            .ok_or(Failure::ResourceLimit)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| Failure::ResourceLimit)?;
        for p in &mesh.positions {
            for c in p {
                bytes.extend_from_slice(&c.to_le_bytes());
            }
        }
        for t in &mesh.triangles {
            for i in t {
                bytes.extend_from_slice(&i.to_le_bytes());
            }
        }
        let id = make_id("asset", &token(r));
        let (v, t) = (vertices as f64, triangles as f64);
        let descriptor = obj([
            ("id", Value::String(id.clone())),
            ("kind", s("mesh")),
            ("digest", s(&content_digest(&bytes))),
            ("byteLength", Value::Number(length as f64)),
            ("mediaType", s("application/vnd.orcaxr.indexed-mesh")),
            (
                "provenance",
                obj([
                    ("source", s("import")),
                    ("uri", s(&format!("3mf:{}#{}", r.model_path, r.object_id))),
                ]),
            ),
            (
                "mesh",
                obj([
                    (
                        "positions",
                        obj([
                            ("byteOffset", Value::Number(0.0)),
                            ("byteLength", Value::Number(v * 12.0)),
                            ("componentType", s("float32")),
                            ("componentCount", Value::Number(3.0)),
                            ("count", Value::Number(v)),
                        ]),
                    ),
                    (
                        "indices",
                        obj([
                            ("byteOffset", Value::Number(v * 12.0)),
                            ("byteLength", Value::Number(t * 12.0)),
                            ("componentType", s("uint32")),
                            ("componentCount", Value::Number(1.0)),
                            ("count", Value::Number(t * 3.0)),
                        ]),
                    ),
                    ("triangleCount", Value::Number(t)),
                ]),
            ),
        ]);
        mesh_assets.insert(r, id);
        source_assets.push(descriptor.clone());
        assets.push((descriptor, bytes));
    }

    // Plates and objects.
    let coordinates = &input.plates;
    let plate_ids: Vec<Vec<u16>> = (0..coordinates.definitions.len())
        .map(|i| make_id("plate", &(i + 1).to_string()))
        .collect();
    let mut plate_objects: Vec<Vec<Value>> = vec![Vec::new(); plate_ids.len()];
    let mut consumed_svg_paths = BTreeSet::new();
    let mut svg_ids: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut materialized = 0u64;
    let mut source_ordinal = 0.0f64;
    for parent_ref in &group_order {
        let parent = by_ref.get(parent_ref).ok_or(Failure::Graph)?;
        let parent_id = NumKey::new(parent.id as f64);
        let parent_token = token(parent_ref);
        let leaves = input.graph.roots.get(*parent_ref).ok_or(Failure::Graph)?;
        source_ordinal += 1.0;
        let mut plate_order: Vec<usize> = Vec::new();
        let mut by_plate: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
        for &(build_index, ordinal) in &groups[*parent_ref] {
            let plate = coordinates
                .plate_by_build_item
                .get(build_index)
                .copied()
                .unwrap_or(0);
            by_plate
                .entry(plate)
                .or_insert_with(|| {
                    plate_order.push(plate);
                    Vec::new()
                })
                .push((build_index, ordinal));
        }
        for plate_index in plate_order {
            let rows = &by_plate[&plate_index];
            let target = if plate_index < plate_ids.len() {
                plate_index
            } else {
                0
            };
            let mut volumes = Vec::new();
            for (component_index, leaf_ref) in leaves.iter().enumerate() {
                let leaf = by_ref.get(&leaf_ref.object).ok_or(Failure::Graph)?;
                let (Some(mesh), Some(asset_id)) = (&leaf.mesh, mesh_assets.get(&leaf_ref.object))
                else {
                    continue;
                };
                let color = colors_by_ref.get(&leaf_ref.object).ok_or(Failure::Graph)?;
                materialized = materialized.saturating_add(materialization_units([
                    color,
                    &mesh.annotations.support,
                    &mesh.annotations.seam,
                    &mesh.annotations.fuzzy_skin,
                ]));
                if materialized > input.max_materialization_units {
                    return Err(Failure::ResourceLimit);
                }
                let part = input
                    .model
                    .part_data
                    .get(&parent_id)
                    .and_then(|parts| parts.get(&NumKey::new(leaf.id as f64)));
                let mut role = part.map_or(Role::Model, |p| p.role);
                if leaves.len() == 1 && role != Role::Model {
                    warnings.push(Warning::new(
                        WarningCode::StandalonePart,
                        &format!(
                            "Standalone BBS part {} had role {}; imported as a model volume to preserve canonical object invariants",
                            leaf.id,
                            role.as_str()
                        ),
                    ));
                    role = Role::Model;
                }
                let mut volume_config = part.map(|p| p.config.clone()).unwrap_or_default();
                let requested = js::value_to_number(volume_config.get(&utf16("extruder")));
                let filament = if js::is_integer(requested) {
                    slot(&assignment, requested)
                } else {
                    leaf.material_index.and_then(|i| assignment.get(i).copied())
                };
                if filament.is_some() {
                    volume_config.remove(&utf16("extruder"));
                }
                let supports_filament = matches!(role, Role::Model | Role::ParameterModifier);
                let mut extension = BTreeMap::new();
                if !leaf.extension_attributes.is_empty() {
                    push(
                        &mut extension,
                        &format!("{NS}/core-object-attributes"),
                        attrs_value(&leaf.extension_attributes),
                    );
                }
                if let Some(edge) = &leaf_ref.component_edge {
                    let attrs = edge_attributes(&by_ref, edge)?;
                    if !attrs.is_empty() {
                        push(
                            &mut extension,
                            &format!("{NS}/core-component-attributes"),
                            attrs_value(attrs),
                        );
                    }
                }
                if !mesh.facet_extension_attributes.is_empty() {
                    push(
                        &mut extension,
                        &format!("{NS}/core-facet-attributes"),
                        Value::Array(
                            mesh.facet_extension_attributes
                                .iter()
                                .map(|row| {
                                    obj([
                                        ("triangle", Value::Number(row.triangle as f64)),
                                        ("attributes", attrs_value(&row.attributes)),
                                    ])
                                })
                                .collect(),
                        ),
                    );
                }
                if let Some(f) = filament {
                    push(
                        &mut extension,
                        "orcaxr:sourceMaterial",
                        obj([
                            ("color", Value::String(f.color.clone())),
                            ("name", Value::String(f.name.clone())),
                            ("format", s("3mf")),
                        ]),
                    );
                }
                let mut emboss_svg = None;
                if let Some(svg) = part.and_then(|p| p.emboss_svg.as_ref()) {
                    match files(&svg.path_in_3mf)? {
                        Some(drawing) => {
                            let drawing_id = make_id("asset", &format!("svg-{}", svg.path_in_3mf));
                            if svg_ids.insert(drawing_id.clone()) {
                                let file = svg.path_in_3mf.rsplit('/').next().unwrap_or("");
                                let descriptor = obj([
                                    ("id", Value::String(drawing_id.clone())),
                                    ("kind", s("extension")),
                                    ("digest", s(&content_digest(&drawing))),
                                    ("byteLength", Value::Number(drawing.len() as f64)),
                                    ("mediaType", s("image/svg+xml")),
                                    ("sourceFilename", s(file)),
                                ]);
                                source_assets.push(descriptor.clone());
                                assets.push((descriptor, drawing));
                            }
                            let mut fields = BTreeMap::new();
                            push(&mut fields, "pathIn3mf", s(&svg.path_in_3mf));
                            if let Some(source) = &svg.source_path {
                                push(&mut fields, "sourcePath", s(source));
                            }
                            push(&mut fields, "depthMm", Value::Number(svg.depth_mm));
                            push(&mut fields, "useSurface", Value::Bool(svg.use_surface));
                            push(&mut fields, "widthMm", Value::Number(0.0));
                            push(&mut fields, "drawingAssetId", Value::String(drawing_id));
                            emboss_svg = Some(Value::Object(fields));
                            consumed_svg_paths.insert(svg.path_in_3mf.clone());
                        }
                        None => warnings.push(Warning::new(
                            WarningCode::MissingSvg,
                            &format!(
                                "An SVG part references {}, which this package does not contain; its size and depth were kept but it cannot be re-cut",
                                svg.path_in_3mf
                            ),
                        )),
                    }
                }
                let mut volume = BTreeMap::new();
                push(
                    &mut volume,
                    "id",
                    Value::String(make_id(
                        "volume",
                        &format!(
                            "{parent_token}-{}-{}-{}",
                            token(&leaf_ref.object),
                            component_index + 1,
                            plate_index + 1
                        ),
                    )),
                );
                let name = match part.and_then(|p| p.name.clone()) {
                    Some(name) => name,
                    None => object_name(leaf)?,
                };
                push(&mut volume, "name", Value::String(name));
                push(&mut volume, "role", s(role.as_str()));
                push(
                    &mut volume,
                    "source",
                    obj([
                        ("assetId", Value::String(asset_id.clone())),
                        ("topologyRevision", Value::Number(0.0)),
                        ("triangleCount", Value::Number(mesh.triangles.len() as f64)),
                    ]),
                );
                push(&mut volume, "transform", decompose(&leaf_ref.transform)?);
                push(&mut volume, "config", Value::Object(volume_config));
                push(&mut volume, "annotations", annotations_value(mesh, color));
                if let Some(text) = part.and_then(|p| p.emboss_text.clone()) {
                    push(&mut volume, "embossText", text);
                }
                if let Some(svg) = emboss_svg {
                    push(&mut volume, "embossSvg", svg);
                }
                if let (Some(f), true) = (filament, supports_filament) {
                    push(&mut volume, "filamentId", Value::String(f.id.clone()));
                }
                if !extension.is_empty() {
                    push(&mut volume, "extensionData", Value::Object(extension));
                }
                volumes.push(Value::Object(volume));
            }
            if volumes.is_empty() {
                continue;
            }
            let mut object_config = input
                .model
                .object_config
                .get(&parent_id)
                .cloned()
                .unwrap_or_default();
            let imported_ranges = input
                .layer_ranges
                .get(&NumKey::new(source_ordinal))
                .or_else(|| input.model.layer_ranges.get(&parent_id))
                .cloned()
                .unwrap_or_default();
            let mut ranges = Vec::new();
            for (index, range) in imported_ranges.into_iter().enumerate() {
                let mut range_config = range.config;
                let filament = slot(
                    &assignment,
                    js::value_to_number(range_config.get(&utf16("extruder"))),
                );
                if filament.is_some() {
                    range_config.remove(&utf16("extruder"));
                }
                let mut fields = BTreeMap::new();
                push(&mut fields, "minZMm", Value::Number(range.min_z_mm));
                push(&mut fields, "maxZMm", Value::Number(range.max_z_mm));
                push(&mut fields, "config", Value::Object(range_config));
                push(
                    &mut fields,
                    "id",
                    Value::String(make_id(
                        "layer-range",
                        &format!("{parent_token}-{}-{}", plate_index + 1, index + 1),
                    )),
                );
                if let Some(f) = filament {
                    push(&mut fields, "filamentId", Value::String(f.id.clone()));
                }
                ranges.push(Value::Object(fields));
            }
            let origin = coordinates
                .origins
                .get(plate_index)
                .copied()
                .unwrap_or((0.0, 0.0));
            let mut instances = Vec::new();
            for &(build_index, ordinal) in rows {
                let item = &input.graph.build[build_index].item;
                let mut fields = BTreeMap::new();
                push(
                    &mut fields,
                    "id",
                    Value::String(make_id(
                        "instance",
                        &format!("{parent_token}-{}-{}", plate_index + 1, ordinal + 1),
                    )),
                );
                push(
                    &mut fields,
                    "transform",
                    plate_local(&item.transform, origin)?,
                );
                push(&mut fields, "printable", Value::Bool(item.printable));
                if !item.extension_attributes.is_empty() {
                    push(
                        &mut fields,
                        "extensionData",
                        Value::Object(BTreeMap::from([(
                            utf16(&format!("{NS}/core-build-attributes")),
                            attrs_value(&item.extension_attributes),
                        )])),
                    );
                }
                instances.push(Value::Object(fields));
            }
            let object_filament = slot(
                &assignment,
                js::value_to_number(object_config.get(&utf16("extruder"))),
            );
            if object_filament.is_some() {
                object_config.remove(&utf16("extruder"));
            }
            let mut fields = BTreeMap::new();
            push(
                &mut fields,
                "id",
                Value::String(make_id(
                    "object",
                    &format!("{parent_token}-{}", plate_index + 1),
                )),
            );
            let name = match input.model.object_names.get(&parent_id) {
                Some(name) => name.clone(),
                None => object_name(parent)?,
            };
            push(&mut fields, "name", Value::String(name));
            push(&mut fields, "config", Value::Object(object_config));
            push(&mut fields, "volumes", Value::Array(volumes));
            push(&mut fields, "instances", Value::Array(instances));
            push(&mut fields, "layerRanges", Value::Array(ranges));
            if !parent.extension_attributes.is_empty() {
                push(
                    &mut fields,
                    "extensionData",
                    Value::Object(BTreeMap::from([(
                        utf16(&format!("{NS}/core-object-attributes")),
                        attrs_value(&parent.extension_attributes),
                    )])),
                );
            }
            if let Some(f) = object_filament {
                push(&mut fields, "filamentId", Value::String(f.id.clone()));
            }
            plate_objects[target].push(Value::Object(fields));
        }
    }

    let custom_gcode = layer_events(&input.layer_events, &plate_ids, &make_id, warnings);
    // Brim ears and layer-height profiles use the writer's 1-based object order
    // across plates.
    let counts: Vec<usize> = plate_objects.iter().map(Vec::len).collect();
    let ordered_len: usize = counts.iter().sum();
    let locate = |n: f64| -> Option<(usize, usize)> {
        if !(js::is_integer(n) && n >= 1.0 && n <= ordered_len as f64) {
            return None;
        }
        let mut index = n as usize - 1;
        for (p, count) in counts.iter().enumerate() {
            if index < *count {
                return Some((p, index));
            }
            index -= count;
        }
        None
    };
    let mut ears = Vec::new();
    if let Some(text) = input.brim_text {
        for entry in metadata::brim_ears(text, warnings) {
            match locate(entry.object_id) {
                Some(at) => ears.push((at, entry)),
                None => warnings.push(Warning::new(
                    WarningCode::BrimEars,
                    &format!(
                        "{}: object {} is not in this package",
                        metadata::BRIM_EAR_POINTS_PATH,
                        js::number_to_string(entry.object_id)
                    ),
                )),
            }
        }
    }
    for ((p, o), entry) in ears {
        if let Value::Object(fields) = &mut plate_objects[p][o] {
            let points = entry
                .points
                .iter()
                .map(|q| {
                    obj([
                        (
                            "positionMm",
                            Value::Array(vec![
                                Value::Number(q[0]),
                                Value::Number(q[1]),
                                Value::Number(q[2]),
                            ]),
                        ),
                        ("headFrontRadiusMm", Value::Number(q[3])),
                    ])
                })
                .collect();
            push(fields, "brimEars", Value::Array(points));
        }
    }
    let mut profiles = Vec::new();
    if let Some(text) = input.heights_text {
        for entry in metadata::layer_heights(text, warnings) {
            match locate(entry.object_id) {
                Some(at) => profiles.push((at, entry)),
                None => warnings.push(Warning::new(
                    WarningCode::LayerHeights,
                    &format!(
                        "{}: object {} is not in this package",
                        metadata::LAYER_HEIGHTS_PROFILE_PATH,
                        js::number_to_string(entry.object_id)
                    ),
                )),
            }
        }
    }
    for ((p, o), entry) in profiles {
        if let Value::Object(fields) = &mut plate_objects[p][o] {
            push(
                fields,
                "layerHeightProfile",
                Value::Array(entry.profile.iter().map(|v| Value::Number(*v)).collect()),
            );
        }
    }
    let tower = wipe_tower(&project.config, &physical);
    let plates: Vec<Value> = coordinates
        .definitions
        .iter()
        .enumerate()
        .zip(plate_objects)
        .map(|((index, plate), objects)| {
            let mut fields = BTreeMap::new();
            push(&mut fields, "id", Value::String(plate_ids[index].clone()));
            push(
                &mut fields,
                "name",
                Value::String(if plate.name.is_empty() {
                    utf16(&format!("Plate {}", index + 1))
                } else {
                    plate.name.clone()
                }),
            );
            push(&mut fields, "order", Value::Number(index as f64));
            push(&mut fields, "printable", Value::Bool(plate.printable));
            push(&mut fields, "config", Value::Object(plate.config.clone()));
            push(&mut fields, "objects", Value::Array(objects));
            if let Some(tower) = &tower {
                push(&mut fields, "wipeTower", tower.at(index));
            }
            Value::Object(fields)
        })
        .collect();
    let mut state = BTreeMap::new();
    push(&mut state, "schemaVersion", Value::Number(1.0));
    push(&mut state, "id", Value::String(make_id("project", "root")));
    push(
        &mut state,
        "name",
        Value::String(if root.title.is_empty() {
            utf16("Imported 3MF project")
        } else {
            utf16(&root.title)
        }),
    );
    push(&mut state, "createdAt", s("1980-01-01T00:00:00.000Z"));
    push(&mut state, "updatedAt", s("1980-01-01T00:00:00.000Z"));
    push(
        &mut state,
        "printer",
        obj([("toolCount", Value::Number(physical.len().max(1) as f64))]),
    );
    push(&mut state, "config", Value::Object(project.config.clone()));
    push(
        &mut state,
        "activePlateId",
        Value::String(plate_ids[0].clone()),
    );
    push(&mut state, "plates", Value::Array(plates));
    push(
        &mut state,
        "filaments",
        obj([
            ("physical", Value::Array(physical_values)),
            ("mixed", Value::Array(mixed_values)),
        ]),
    );
    push(&mut state, "sourceAssets", Value::Array(source_assets));
    push(&mut state, "customGcode", Value::Array(custom_gcode));
    push(&mut state, "thumbnails", Value::Array(Vec::new()));
    push(&mut state, "extensionBlobs", Value::Array(Vec::new()));
    Ok(Output {
        state: Value::Object(state),
        assets,
        consumed_svg_paths,
    })
}

fn edge_attributes<'a>(
    by_ref: &BTreeMap<&ObjectRef, &'a Object>,
    edge: &ComponentEdgeRef,
) -> Result<&'a [ExtensionAttribute], Failure> {
    by_ref
        .get(&edge.source)
        .and_then(|o| o.components.get(edge.component_index))
        .map(|c| c.extension_attributes.as_slice())
        .ok_or(Failure::Graph)
}

/// `plateLocalTransform(decomposeMatrix(item))`: negative zero becomes zero.
fn plate_local(matrix: &[f64; 16], origin: (f64, f64)) -> Result<Value, Failure> {
    let Value::Object(mut fields) = decompose(matrix)? else {
        return Err(Failure::Transform);
    };
    let x = matrix[3] - origin.0;
    let y = matrix[7] - origin.1;
    fields.insert(
        utf16("translationMm"),
        Value::Array(vec![
            Value::Number(if x == 0.0 { 0.0 } else { x }),
            Value::Number(if y == 0.0 { 0.0 } else { y }),
            Value::Number(matrix[11]),
        ]),
    );
    Ok(Value::Object(fields))
}

/// V8 `Math.hypot`: scaled and Kahan-compensated in argument order.
fn hypot(values: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for v in values {
        if v.is_nan() {
            nan = true;
        } else if v.abs() > max {
            max = v.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `decomposeMatrix` for a row-major affine matrix.
pub fn decompose(m: &[f64; 16]) -> Result<Value, Failure> {
    let mut sx = hypot(&[m[0], m[4], m[8]]);
    let sy = hypot(&[m[1], m[5], m[9]]);
    let sz = hypot(&[m[2], m[6], m[10]]);
    let determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
        + m[2] * (m[4] * m[9] - m[5] * m[8]);
    if determinant < 0.0 {
        sx = -sx;
    }
    // `Math.abs(sx) < 1e-12 || sy < 1e-12 || sz < 1e-12` is false for NaN, so
    // NaN scales pass this check exactly as in the browser.
    if sx.abs() < 1e-12 || sy < 1e-12 || sz < 1e-12 {
        return Err(Failure::Transform);
    }
    let (m00, m01, m02) = (m[0] / sx, m[1] / sy, m[2] / sz);
    let (m10, m11, m12) = (m[4] / sx, m[5] / sy, m[6] / sz);
    let (m20, m21, m22) = (m[8] / sx, m[9] / sy, m[10] / sz);
    let trace = m00 + m11 + m22;
    let (x, y, z, w);
    if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        w = 0.25 * s;
        x = (m21 - m12) / s;
        y = (m02 - m20) / s;
        z = (m10 - m01) / s;
    } else if m00 > m11 && m00 > m22 {
        let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if m11 > m22 {
        let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
    } else {
        let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
    }
    let norm = hypot(&[x, y, z, w]);
    if !norm.is_finite() || norm < 1e-12 {
        return Err(Failure::Transform);
    }
    let n = Value::Number;
    Ok(obj([
        (
            "translationMm",
            Value::Array(vec![n(m[3]), n(m[7]), n(m[11])]),
        ),
        (
            "rotation",
            Value::Array(vec![n(x / norm), n(y / norm), n(z / norm), n(w / norm)]),
        ),
        ("scale", Value::Array(vec![n(sx), n(sy), n(sz)])),
    ]))
}

/// `parseNumericList`.
fn numeric_list(value: Option<&Value>) -> Vec<f64> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| js::value_to_number(Some(v)))
            .filter(|v| v.is_finite())
            .collect(),
        Some(Value::Number(n)) if n.is_finite() => vec![*n],
        Some(Value::String(units)) => {
            // `split(/[,;\s]+/)`: separator runs collapse; edges yield ''.
            let text = String::from_utf16_lossy(units);
            let mut parts = vec![String::new()];
            let mut in_separator = false;
            for c in text.chars() {
                if c == ',' || c == ';' || js::is_space(c) {
                    if !in_separator {
                        parts.push(String::new());
                        in_separator = true;
                    }
                } else {
                    in_separator = false;
                    parts.last_mut().expect("nonempty").push(c);
                }
            }
            parts
                .iter()
                .map(|p| js::number(js::trim(p)))
                .filter(|v| v.is_finite())
                .collect()
        }
        _ => Vec::new(),
    }
}

struct Tower {
    xs: Vec<f64>,
    ys: Vec<f64>,
    rotation: f64,
    filament: Option<Vec<u16>>,
}
impl Tower {
    fn at(&self, index: usize) -> Value {
        let x = self.xs.get(index).copied().unwrap_or(self.xs[0]);
        let y = self.ys.get(index).copied().unwrap_or(self.ys[0]);
        let mut fields = BTreeMap::new();
        push(&mut fields, "enabled", Value::Bool(true));
        push(
            &mut fields,
            "positionMm",
            Value::Array(vec![Value::Number(x), Value::Number(y)]),
        );
        push(&mut fields, "rotationDeg", Value::Number(self.rotation));
        if let Some(id) = &self.filament {
            push(&mut fields, "filamentId", Value::String(id.clone()));
        }
        Value::Object(fields)
    }
}
/// `applyImportedWipeTowers`.
fn wipe_tower(config: &Config, physical: &[Filament]) -> Option<Tower> {
    let enabled = match config.get(&utf16("enable_prime_tower")) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(v)) => v.as_slice() == [u16::from(b'1')],
        Some(Value::Number(n)) => *n == 1.0,
        _ => false,
    };
    if !enabled {
        return None;
    }
    let xs = numeric_list(config.get(&utf16("wipe_tower_x")));
    let ys = numeric_list(config.get(&utf16("wipe_tower_y")));
    if xs.is_empty() || ys.is_empty() {
        return None;
    }
    let rotation = js::value_to_number(config.get(&utf16("wipe_tower_rotation_angle")));
    let rotation = if rotation.is_nan() || rotation == 0.0 {
        0.0
    } else {
        rotation
    };
    let slot_number = js::value_to_number(config.get(&utf16("wipe_tower_filament")));
    let filament =
        (js::is_integer(slot_number) && slot_number >= 1.0 && slot_number <= physical.len() as f64)
            .then(|| physical[slot_number as usize - 1].id.clone());
    Some(Tower {
        xs,
        ys,
        rotation,
        filament,
    })
}

/// `importedLayerEvents`.
fn layer_events(
    events: &BTreeMap<NumKey, Vec<metadata::LayerEvent>>,
    plate_ids: &[Vec<u16>],
    make_id: &dyn Fn(&str, &str) -> Vec<u16>,
    warnings: &mut Vec<Warning>,
) -> Vec<Value> {
    let mut sorted: Vec<(f64, &Vec<metadata::LayerEvent>)> =
        events.iter().map(|(k, v)| (k.get(), v)).collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = Vec::new();
    let mut dropped = 0usize;
    let mut unrepresentable = 0usize;
    for (plate_index, entries) in sorted {
        let plate = (plate_index >= 1.0 && plate_index <= plate_ids.len() as f64)
            .then(|| &plate_ids[plate_index as usize - 1]);
        let Some(plate) = plate else {
            dropped += entries.len();
            continue;
        };
        let mut heights = BTreeSet::new();
        for (position, entry) in entries.iter().enumerate() {
            // Only events the canonical model can hold are imported; source
            // positions keep IDs independent of which neighbours were dropped.
            let height = Number::new(entry.top_z_mm)
                .map(layer_event_height_key)
                .unwrap_or_default();
            let blank = js::trim_utf16(&entry.code).is_empty();
            if entry.top_z_mm > MAX_LAYER_EVENT_Z_MM
                || (entry.kind == metadata::LayerEventType::Custom && blank)
                || (matches!(
                    entry.kind,
                    metadata::LayerEventType::ColorChange | metadata::LayerEventType::ToolChange
                ) && entry.tool_index.is_none())
                || !heights.insert(height)
            {
                unrepresentable += 1;
                continue;
            }
            let mut layer = BTreeMap::new();
            push(&mut layer, "type", s(entry.kind.as_str()));
            push(&mut layer, "topZMm", Value::Number(entry.top_z_mm));
            if let Some(t) = entry.tool_index {
                push(&mut layer, "toolIndex", Value::Number(t));
            }
            if let Some(c) = &entry.color {
                push(&mut layer, "color", Value::String(c.clone()));
            }
            if let Some(m) = &entry.message {
                push(&mut layer, "message", Value::String(m.clone()));
            }
            let mut fields = BTreeMap::new();
            push(&mut fields, "scope", s("plate"));
            push(&mut fields, "trigger", s("before-layer"));
            push(&mut fields, "code", Value::String(entry.code.clone()));
            push(&mut fields, "layerEvent", Value::Object(layer));
            push(
                &mut fields,
                "id",
                Value::String(make_id(
                    "custom-gcode",
                    &format!("{}-{}", js::number_to_string(plate_index), position + 1),
                )),
            );
            push(&mut fields, "plateId", Value::String(plate.clone()));
            out.push(Value::Object(fields));
        }
    }
    if unrepresentable > 0 {
        warnings.push(Warning::new(
            WarningCode::LayerEvents,
            &format!(
                "{unrepresentable} layer event{} could not be represented (a colour or tool change without a tool, a custom event without G-code, or an out-of-range or repeated height) and {} not imported",
                if unrepresentable == 1 { "" } else { "s" },
                if unrepresentable == 1 { "was" } else { "were" }
            ),
        ));
    }
    if dropped > 0 {
        warnings.push(Warning::new(
            WarningCode::LayerEvents,
            &format!(
                "{dropped} layer event{} named a plate this project does not contain and were not imported; the original file remains preserved",
                if dropped == 1 { "" } else { "s" }
            ),
        ));
    }
    out
}
