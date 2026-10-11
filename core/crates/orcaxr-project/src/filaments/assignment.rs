//! Which filament each selected scope prints with, and which filaments the
//! project offers (`web/src/workspace/FilamentAssignment.ts`): the snapshot
//! the browser's assignment selector, its selection filament bar and the
//! headset's swatch row read, and the assignments a choice makes of it.
//!
//! An instance stands for its object (upstream has no per-copy filament), so a
//! multi-copy selection collapses to the one scope it is; a plate, or an
//! instance the project lacks, stays explicit as unsupported; an object, part
//! or height range the project lacks is refused in the browser's words.
//! Filaments are listed physical heads by tool, then mixed recipes by name,
//! ties by ID, in code-unit order.
//!
//! The exchange is canonical JSON (`FilamentAssignmentExchange.ts`): a ref is
//! `{"kind","id"}`; [`resolution_json`] answers `{"refs"}` with
//! `{"options","scopes","unsupportedSelection"}` and [`changes_json`] answers
//! `{"entities","filamentId"}` with `{"assignments"}`; a refusal is
//! `{"error": message}`, a malformed request `invalid_request`.
use crate::js_math::convert::{is_integer, number, number_to_string, to_fixed};
use crate::model::{
    LayerRange, MixedDistribution, ProjectInstance, ProjectObject, ProjectState, ProjectVolume,
};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";

/// An Objects-tree ref (`ObjectTreeEntityRef`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RefKind {
    Plate,
    Object,
    Volume,
    Instance,
    LayerRange,
}
impl RefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plate => "plate",
            Self::Object => "object",
            Self::Volume => "volume",
            Self::Instance => "instance",
            Self::LayerRange => "layer-range",
        }
    }
    fn parse(units: &[u16]) -> Option<Self> {
        [
            Self::Plate,
            Self::Object,
            Self::Volume,
            Self::Instance,
            Self::LayerRange,
        ]
        .into_iter()
        .find(|kind| kind.as_str().encode_utf16().eq(units.iter().copied()))
    }
}

/// One selected entity: its kind and stable ID.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Ref {
    pub kind: RefKind,
    pub id: Vec<u16>,
}

/// `CanonicalFilamentAssignmentScope`: an object, part or height range that
/// can take a filament, its own (local), its object's (inherited) and the one
/// it prints with (effective).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub entity: Ref,
    pub object_id: Vec<u16>,
    pub label: Vec<u16>,
    pub local: Option<Vec<u16>>,
    pub inherited: Option<Vec<u16>>,
    pub effective: Option<Vec<u16>>,
}

/// One component of a mixed option's recipe.
#[derive(Debug, Clone, PartialEq)]
pub struct RecipeComponent {
    pub filament_id: Vec<u16>,
    pub name: Vec<u16>,
    pub color: Vec<u16>,
    pub weight: f64,
}

/// `CanonicalFilamentOption`: a physical head or a mixed recipe as the
/// selector lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Option_ {
    pub id: Vec<u16>,
    pub mixed: bool,
    pub name: Vec<u16>,
    pub color: Vec<u16>,
    pub enabled: bool,
    pub material: Option<Vec<u16>>,
    pub preset_id: Option<Vec<u16>>,
    pub tool_id: Option<f64>,
    pub distribution_mode: Option<&'static str>,
    pub recipe: Vec<RecipeComponent>,
    pub warnings: Vec<Vec<u16>>,
}

/// `FilamentAssignmentResolution`: the assignable scopes, what the selection
/// cannot assign, and every filament offered.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub scopes: Vec<Scope>,
    pub unsupported: Vec<Ref>,
    pub options: Vec<Option_>,
}

/// Where one assignment lands (`FilamentAssignmentChange['target']`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Object(Vec<u16>),
    Volume { object: Vec<u16>, volume: Vec<u16> },
    LayerRange { object: Vec<u16>, range: Vec<u16> },
}

/// `FilamentAssignmentChange`: a target and its filament, `None` inheriting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub target: Target,
    pub filament: Option<Vec<u16>>,
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
/// JavaScript truthiness of an optional ID: absent and empty are both false.
fn present(id: Option<&[u16]>) -> Option<Vec<u16>> {
    id.filter(|units| !units.is_empty()).map(<[u16]>::to_vec)
}

fn objects(state: &ProjectState) -> impl Iterator<Item = &Arc<ProjectObject>> {
    state.plates.iter().flat_map(|plate| plate.objects.iter())
}
fn find_object<'s>(state: &'s ProjectState, id: &[u16]) -> Option<&'s ProjectObject> {
    objects(state)
        .find(|object| object.id.as_utf16() == id)
        .map(|object| &**object)
}
fn find_volume<'s>(
    state: &'s ProjectState,
    id: &[u16],
) -> Option<(&'s ProjectObject, &'s ProjectVolume)> {
    objects(state).find_map(|object| {
        object
            .volumes
            .iter()
            .find(|volume| volume.id.as_utf16() == id)
            .map(|volume| (&**object, &**volume))
    })
}
fn find_range<'s>(
    state: &'s ProjectState,
    id: &[u16],
) -> Option<(&'s ProjectObject, &'s LayerRange)> {
    objects(state).find_map(|object| {
        object
            .layer_ranges
            .iter()
            .find(|range| range.id.as_utf16() == id)
            .map(|range| (&**object, &**range))
    })
}
fn find_instance<'s>(
    state: &'s ProjectState,
    id: &[u16],
) -> Option<(&'s ProjectObject, &'s ProjectInstance)> {
    objects(state).find_map(|object| {
        object
            .instances
            .iter()
            .find(|instance| instance.id.as_utf16() == id)
            .map(|instance| (&**object, &**instance))
    })
}

/// `formatZ`: an integral height as JavaScript prints it, else rounded to four decimals.
fn format_z(value: f64) -> Vec<u16> {
    if is_integer(value) {
        u(&number_to_string(value))
    } else {
        u(&number_to_string(number(&to_fixed(value, 4))))
    }
}

/// A scope's local, inherited and effective filament.
type Resolved = (Option<Vec<u16>>, Option<Vec<u16>>, Option<Vec<u16>>);

/// `resolveFilament` over a child's own filament and its object's.
fn resolved(object: &ProjectObject, local: Option<&[u16]>) -> Resolved {
    let inherited = present(object.filament_id.as_ref().map(|id| id.as_utf16()));
    match present(local) {
        Some(own) => (Some(own.clone()), inherited, Some(own)),
        None => (None, inherited.clone(), inherited),
    }
}

/// The ref an assignment acts on: an instance stands for its object.
fn scope_ref(state: &ProjectState, requested: &Ref) -> Ref {
    if requested.kind != RefKind::Instance {
        return requested.clone();
    }
    match find_instance(state, &requested.id) {
        Some((object, _)) => Ref {
            kind: RefKind::Object,
            id: object.id.as_utf16().to_vec(),
        },
        None => requested.clone(),
    }
}

/// The scope a ref names, `Ok(None)` when it cannot take a filament, or the
/// browser's refusal of an entity the project lacks.
fn scope(state: &ProjectState, entity: &Ref) -> Result<Option<Scope>, Vec<u16>> {
    let unknown = |kind: &str| cat(&[&u("Unknown "), &u(kind), &u(" "), &entity.id]);
    Ok(Some(match entity.kind {
        RefKind::Object => {
            let object = find_object(state, &entity.id).ok_or_else(|| unknown("object"))?;
            let local = present(object.filament_id.as_ref().map(|id| id.as_utf16()));
            Scope {
                entity: entity.clone(),
                object_id: object.id.as_utf16().to_vec(),
                label: object.name.units().to_vec(),
                local: local.clone(),
                inherited: None,
                effective: local,
            }
        }
        RefKind::Volume => {
            let (object, volume) =
                find_volume(state, &entity.id).ok_or_else(|| unknown("volume"))?;
            let (local, inherited, effective) =
                resolved(object, volume.filament_id.as_ref().map(|id| id.as_utf16()));
            Scope {
                entity: entity.clone(),
                object_id: object.id.as_utf16().to_vec(),
                label: cat(&[object.name.units(), &u(" / "), volume.name.units()]),
                local,
                inherited,
                effective,
            }
        }
        RefKind::LayerRange => {
            let (object, range) =
                find_range(state, &entity.id).ok_or_else(|| unknown("layer-range"))?;
            let (local, inherited, effective) =
                resolved(object, range.filament_id.as_ref().map(|id| id.as_utf16()));
            Scope {
                entity: entity.clone(),
                object_id: object.id.as_utf16().to_vec(),
                label: cat(&[
                    object.name.units(),
                    &u(" / "),
                    &format_z(range.min_z_mm.get()),
                    &u("\u{2013}"),
                    &format_z(range.max_z_mm.get()),
                    &u(" mm"),
                ]),
                local,
                inherited,
                effective,
            }
        }
        RefKind::Plate | RefKind::Instance => return Ok(None),
    }))
}

/// `filamentAssignmentResolution`: the scopes `refs` can assign (each once,
/// in first-selected order), the refs that cannot take one, and every
/// filament offered; or the browser's refusal of an entity the project lacks.
pub fn resolution(state: &ProjectState, refs: &[Ref]) -> Result<Resolution, Vec<u16>> {
    let mut scopes = Vec::new();
    let mut unsupported = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for requested in refs {
        let entity = scope_ref(state, requested);
        if !seen.insert(entity.clone()) {
            continue;
        }
        match scope(state, &entity)? {
            Some(scope) => scopes.push(scope),
            None => unsupported.push(entity),
        }
    }
    Ok(Resolution {
        scopes,
        unsupported,
        options: options(state),
    })
}

fn mode(distribution: &MixedDistribution) -> &'static str {
    match distribution {
        MixedDistribution::Ratio(_) => "ratio",
        MixedDistribution::Cycle(_) => "cycle",
        MixedDistribution::Match(_) => "match",
        MixedDistribution::Gradient(_) => "gradient",
    }
}

/// `canonicalFilamentOptions`: physical heads by tool (ties by ID), then
/// mixed recipes by name (ties by ID), with the selector's warnings.
pub fn options(state: &ProjectState) -> Vec<Option_> {
    let filaments = &state.filaments;
    // A `Map` built from the list: the last of equal IDs wins.
    let physical_by_id = |id: &[u16]| {
        filaments
            .physical
            .iter()
            .rev()
            .find(|f| f.id.as_utf16() == id)
    };
    let mut physical: Vec<_> = filaments.physical.iter().collect();
    physical.sort_by(|a, b| {
        a.tool_id
            .get()
            .partial_cmp(&b.tool_id.get())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.as_utf16().cmp(b.id.as_utf16()))
    });
    let tool_count = state.printer.tool_count.get();
    let mut listed: Vec<Option_> = physical
        .into_iter()
        .map(|filament| {
            let tool = filament.tool_id.get();
            let mut warnings = Vec::new();
            if !filament.enabled {
                warnings.push(u("This physical filament is disabled."));
            }
            if tool < 0.0 || tool >= tool_count {
                warnings.push(u(&format!(
                    "Tool {} is outside the printer's configured head range.",
                    number_to_string(tool)
                )));
            }
            let preset_id = present(filament.preset_id.as_ref().map(|p| p.units()));
            if preset_id.is_none() {
                warnings.push(u("No filament preset snapshot is linked to this head."));
            }
            Option_ {
                id: filament.id.as_utf16().to_vec(),
                mixed: false,
                name: filament.name.units().to_vec(),
                color: filament.color.units().to_vec(),
                enabled: filament.enabled,
                material: Some(filament.material.units().to_vec()),
                preset_id,
                tool_id: Some(tool),
                distribution_mode: None,
                recipe: Vec::new(),
                warnings,
            }
        })
        .collect();
    let mut mixed: Vec<_> = filaments.mixed.iter().collect();
    mixed.sort_by(|a, b| {
        a.name
            .units()
            .cmp(b.name.units())
            .then_with(|| a.id.as_utf16().cmp(b.id.as_utf16()))
    });
    listed.extend(mixed.into_iter().map(|filament| {
        let mut warnings = Vec::new();
        if !filament.enabled {
            warnings.push(u("This virtual filament is disabled."));
        }
        let recipe = filament
            .components
            .iter()
            .map(|component| {
                let id = component.filament_id.as_utf16();
                let physical = physical_by_id(id);
                match physical {
                    None => warnings.push(cat(&[&u("Recipe component "), id, &u(" is missing.")])),
                    Some(p) if !p.enabled => warnings.push(cat(&[
                        &u("Recipe component "),
                        p.name.units(),
                        &u(" is disabled."),
                    ])),
                    Some(_) => {}
                }
                RecipeComponent {
                    filament_id: id.to_vec(),
                    name: physical.map_or_else(
                        || u("Missing physical filament"),
                        |p| p.name.units().to_vec(),
                    ),
                    color: physical.map_or_else(|| u("#808080"), |p| p.color.units().to_vec()),
                    weight: component.weight.get(),
                }
            })
            .collect();
        let mut materials: Vec<Vec<u16>> = Vec::new();
        for component in filament.components.iter() {
            if let Some(material) = physical_by_id(component.filament_id.as_utf16())
                .map(|p| p.material.units())
                .filter(|m| !m.is_empty())
                && !materials.iter().any(|known| known == material)
            {
                materials.push(material.to_vec());
            }
        }
        materials.sort();
        if materials.len() > 1 {
            warnings.push(cat(&[
                &u("Recipe combines "),
                &materials.join(&u(" and ")[..]),
                &u("; verify material compatibility before slicing."),
            ]));
        }
        Option_ {
            id: filament.id.as_utf16().to_vec(),
            mixed: true,
            name: filament.name.units().to_vec(),
            color: filament.display_color.units().to_vec(),
            enabled: filament.enabled,
            material: (!materials.is_empty()).then(|| materials.join(&u(" + ")[..])),
            preset_id: None,
            tool_id: None,
            distribution_mode: Some(mode(&filament.distribution)),
            recipe,
            warnings,
        }
    }));
    listed
}

/// `filamentAssignmentChanges`: the changes giving every entity `filament`
/// (`None` inherits), refused as the controller refuses them before it
/// submits: no scope, a destination the project lacks or has disabled, an
/// entity it lacks. Only objects, parts and height ranges are entities.
pub fn changes(
    state: &ProjectState,
    entities: &[Ref],
    filament: Option<&[u16]>,
) -> Result<Vec<Change>, Vec<u16>> {
    if entities.is_empty() {
        return Err(u(
            "Filament assignment requires at least one assignable scope",
        ));
    }
    if let Some(id) = filament.filter(|id| !id.is_empty()) {
        let enabled = state
            .filaments
            .physical
            .iter()
            .map(|f| (f.id.as_utf16(), f.enabled))
            .chain(
                state
                    .filaments
                    .mixed
                    .iter()
                    .map(|f| (f.id.as_utf16(), f.enabled)),
            )
            .find(|(candidate, _)| *candidate == id)
            .map(|(_, enabled)| enabled)
            .ok_or_else(|| cat(&[&u("Unknown filament "), id]))?;
        if !enabled {
            return Err(cat(&[&u("Destination filament "), id, &u(" is disabled")]));
        }
    }
    entities
        .iter()
        .map(|entity| {
            let unknown = |kind: &str| cat(&[&u("Unknown "), &u(kind), &u(" "), &entity.id]);
            let target = match entity.kind {
                RefKind::Object => Target::Object(
                    find_object(state, &entity.id)
                        .ok_or_else(|| unknown("object"))?
                        .id
                        .as_utf16()
                        .to_vec(),
                ),
                RefKind::Volume => {
                    let (object, volume) =
                        find_volume(state, &entity.id).ok_or_else(|| unknown("volume"))?;
                    Target::Volume {
                        object: object.id.as_utf16().to_vec(),
                        volume: volume.id.as_utf16().to_vec(),
                    }
                }
                RefKind::LayerRange => {
                    let (object, range) =
                        find_range(state, &entity.id).ok_or_else(|| unknown("layer-range"))?;
                    Target::LayerRange {
                        object: object.id.as_utf16().to_vec(),
                        range: range.id.as_utf16().to_vec(),
                    }
                }
                kind => {
                    return Err(cat(&[
                        &u("Unsupported filament assignment scope "),
                        &u(kind.as_str()),
                    ]));
                }
            };
            Ok(Change {
                target,
                filament: filament.map(<[u16]>::to_vec),
            })
        })
        .collect()
}

// --- Exchange ----------------------------------------------------------------------------------

type Fields = BTreeMap<Vec<u16>, Value>;

fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
fn object(value: Value, keys: &[&str]) -> Result<Fields, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    if fields.len() != keys.len() || !keys.iter().all(|key| fields.contains_key(&u(key))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn string(value: Option<Value>) -> Result<Vec<u16>, &'static str> {
    match value {
        Some(Value::String(units)) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn list(value: Option<Value>) -> Result<Vec<Value>, &'static str> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(INVALID_REQUEST),
    }
}
fn ref_of(value: Value, kinds: &[RefKind]) -> Result<Ref, &'static str> {
    let mut fields = object(value, &["id", "kind"])?;
    let kind = RefKind::parse(&string(fields.remove(&u("kind")))?)
        .filter(|kind| kinds.contains(kind))
        .ok_or(INVALID_REQUEST)?;
    Ok(Ref {
        kind,
        id: string(fields.remove(&u("id")))?,
    })
}
fn text(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn record(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (u(k), v)).collect())
}
fn ref_value(entity: &Ref) -> Value {
    record(vec![
        ("id", text(&entity.id)),
        ("kind", text(&u(entity.kind.as_str()))),
    ])
}
fn option_value(option: &Option_) -> Value {
    let mut fields = vec![
        ("color", text(&option.color)),
        ("enabled", Value::Bool(option.enabled)),
        ("id", text(&option.id)),
        (
            "kind",
            text(&u(if option.mixed { "mixed" } else { "physical" })),
        ),
        ("name", text(&option.name)),
        (
            "recipe",
            Value::Array(
                option
                    .recipe
                    .iter()
                    .map(|c| {
                        record(vec![
                            ("color", text(&c.color)),
                            ("filamentId", text(&c.filament_id)),
                            ("name", text(&c.name)),
                            ("weight", Value::Number(c.weight)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "warnings",
            Value::Array(option.warnings.iter().map(|w| text(w)).collect()),
        ),
    ];
    if let Some(material) = &option.material {
        fields.push(("material", text(material)));
    }
    if let Some(preset) = &option.preset_id {
        fields.push(("presetId", text(preset)));
    }
    if let Some(tool) = option.tool_id {
        fields.push(("toolId", Value::Number(tool)));
    }
    if let Some(mode) = option.distribution_mode {
        fields.push(("distributionMode", text(&u(mode))));
    }
    record(fields)
}
fn scope_value(scope: &Scope) -> Value {
    let mut fields = vec![
        ("entity", ref_value(&scope.entity)),
        ("label", text(&scope.label)),
        ("objectId", text(&scope.object_id)),
    ];
    for (name, id) in [
        ("localFilamentId", &scope.local),
        ("inheritedFilamentId", &scope.inherited),
        ("effectiveFilamentId", &scope.effective),
    ] {
        if let Some(id) = id {
            fields.push((name, text(id)));
        }
    }
    record(fields)
}
fn change_value(change: &Change) -> Value {
    let target = match &change.target {
        Target::Object(object) => record(vec![
            ("kind", text(&u("object"))),
            ("objectId", text(object)),
        ]),
        Target::Volume { object, volume } => record(vec![
            ("kind", text(&u("volume"))),
            ("objectId", text(object)),
            ("volumeId", text(volume)),
        ]),
        Target::LayerRange { object, range } => record(vec![
            ("kind", text(&u("layer-range"))),
            ("layerRangeId", text(range)),
            ("objectId", text(object)),
        ]),
    };
    record(vec![
        (
            "filamentId",
            change.filament.as_deref().map_or(Value::Null, text),
        ),
        ("target", target),
    ])
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}
fn refused(message: Vec<u16>) -> Result<String, &'static str> {
    canonical(&record(vec![("error", Value::String(message))]))
}

const REFS: [RefKind; 5] = [
    RefKind::Plate,
    RefKind::Object,
    RefKind::Volume,
    RefKind::Instance,
    RefKind::LayerRange,
];
const ENTITIES: [RefKind; 3] = [RefKind::Object, RefKind::Volume, RefKind::LayerRange];

/// `filamentAssignmentExchange`: `{"refs"}` against `state` →
/// `{"options","scopes","unsupportedSelection"}` or `{"error"}`.
pub fn resolution_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let mut fields = object(read(request)?, &["refs"])?;
    let refs = list(fields.remove(&u("refs")))?
        .into_iter()
        .map(|value| ref_of(value, &REFS))
        .collect::<Result<Vec<_>, _>>()?;
    match resolution(state, &refs) {
        Err(message) => refused(message),
        Ok(resolution) => canonical(&record(vec![
            (
                "options",
                Value::Array(resolution.options.iter().map(option_value).collect()),
            ),
            (
                "scopes",
                Value::Array(resolution.scopes.iter().map(scope_value).collect()),
            ),
            (
                "unsupportedSelection",
                Value::Array(resolution.unsupported.iter().map(ref_value).collect()),
            ),
        ])),
    }
}

/// `filamentAssignmentChangesExchange`: `{"entities","filamentId"}` against
/// `state` → `{"assignments"}` or `{"error"}`.
pub fn changes_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let mut fields = object(read(request)?, &["entities", "filamentId"])?;
    let entities = list(fields.remove(&u("entities")))?
        .into_iter()
        .map(|value| ref_of(value, &ENTITIES))
        .collect::<Result<Vec<_>, _>>()?;
    let filament = match fields.remove(&u("filamentId")) {
        Some(Value::Null) => None,
        other => Some(string(other)?),
    };
    match changes(state, &entities, filament.as_deref()) {
        Err(message) => refused(message),
        Ok(changes) => canonical(&record(vec![(
            "assignments",
            Value::Array(changes.iter().map(change_value).collect()),
        )])),
    }
}
