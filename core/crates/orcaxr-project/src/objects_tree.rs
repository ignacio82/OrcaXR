//! The Objects tree (`web/src/project/objects/projection.ts`, `view.ts` and
//! `selectionRequest.ts`): every plate, object, part, instance, settings and
//! height-range row the panels list, with its label, indicators and search
//! text; the rows visible under a host's expansion, filter, selection and
//! focus; and the selection that activating a row commits.
//!
//! Search text is folded by the host ([`SearchFolding`]: NFKD, then US-English
//! lowercase; ASCII is folded here, as both steps only lowercase it), then
//! loses combining diacritics (U+0300–U+036F), is trimmed and has whitespace
//! runs collapsed to one space. `objectTreeExchange.ts` answers the same wire
//! requests.
use crate::{
    facets::node_budget,
    ids::FilamentId,
    js_math::convert::{is_space, js_keys, number_to_string, to_fixed, trim_utf16},
    model::{
        ConfigMap, FacetAnnotations, LayerRange, ProjectObject, ProjectPlate, ProjectState,
        ProjectVolume, VolumeRole,
    },
    settings::editor::SearchFolding,
};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};
use std::collections::{HashMap, HashSet};

/// The most rows one page may hold.
pub const MAX_PAGE: u64 = 64;

/// A row's canonical entity, or a synthetic row's owner.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Entity {
    Plate(Vec<u16>),
    Object(Vec<u16>),
    Volume(Vec<u16>),
    Instance(Vec<u16>),
    LayerRange(Vec<u16>),
}
impl Entity {
    /// The browser's row key for this entity (`entityRowKey`).
    fn row_key(&self) -> Vec<u16> {
        let (kind, id) = match self {
            Self::Plate(id) => ("plate", id),
            Self::Object(id) => ("object", id),
            Self::Volume(id) => ("volume", id),
            Self::Instance(id) => ("instance", id),
            Self::LayerRange(id) => ("layer-range", id),
        };
        cat(&[&u(kind), &u(":"), id])
    }
}

/// `ObjectTreeRowKind`, without the diagnostic rows production never adds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Plate,
    Object,
    Volume,
    InstanceGroup,
    Instance,
    Settings,
    LayerGroup,
    LayerRange,
}

/// `ObjectTreeFilamentBadge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filament {
    pub id: Vec<u16>,
    pub name: Vec<u16>,
    pub color: Vec<u16>,
    pub mixed: bool,
    pub inherited: bool,
}
/// `ObjectTreePaintIndicators`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Paint {
    pub color_facets: usize,
    pub support_facets: usize,
}
/// `ObjectTreeIndicators` without host-supplied status (production supplies none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Indicators {
    pub printable: Option<bool>,
    pub filament: Option<Filament>,
    pub paint: Option<Paint>,
    pub editable: bool,
    pub settings_count: Option<usize>,
    pub volume_role: Option<VolumeRole>,
}
impl Indicators {
    fn editable() -> Self {
        Self {
            printable: None,
            filament: None,
            paint: None,
            editable: true,
            settings_count: None,
            volume_role: None,
        }
    }
}

/// `ObjectTreeRow`; parent and children are row positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub key: Vec<u16>,
    pub kind: RowKind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub label: Vec<u16>,
    pub description: Option<Vec<u16>>,
    /// Present only when selecting this row selects a distinct entity.
    pub entity: Option<Entity>,
    /// A synthetic row's canonical context.
    pub owner: Option<Entity>,
    pub indicators: Indicators,
    /// The search words before folding.
    search: Vec<u16>,
    default_expanded: bool,
}

/// `ObjectTreeProjection`: rows in the order the browser adds them.
#[derive(Debug, Clone)]
pub struct Projection {
    rows: Vec<Row>,
    roots: Vec<usize>,
    by_key: HashMap<Vec<u16>, usize>,
    by_entity: HashMap<Entity, usize>,
}

/// The tree's share of a selection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub refs: Vec<Entity>,
    pub primary: Option<Entity>,
}

/// `ObjectTreeViewOptions`. `expanded: None` is the projection's default.
#[derive(Debug, Clone, Copy)]
pub struct ViewOptions<'a> {
    pub expanded: Option<&'a HashSet<Vec<u16>>>,
    pub filter: &'a [u16],
    pub selection: &'a Selection,
    pub focused: Option<&'a [u16]>,
}

/// Whether a row shows children: `accessibility.expanded`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expansion {
    Leaf,
    Collapsed,
    Expanded,
}
/// `ObjectTreeVisibleRow`, as a position in the projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisibleRow {
    pub row: usize,
    pub matched: bool,
    pub focused: bool,
    pub selected: bool,
    pub level: usize,
    pub position: usize,
    pub set_size: usize,
    pub expansion: Expansion,
}
/// `ObjectTreeView`.
#[derive(Debug, Clone)]
pub struct View {
    pub rows: Vec<VisibleRow>,
    /// A position in `rows`.
    pub focus: Option<usize>,
    pub filter_active: bool,
    index: HashMap<usize, usize>,
}

/// `ObjectTreeSelectionMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Replace,
    Toggle,
    Range,
}
/// The selection a row commits, and the anchor the next range measures from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub refs: Vec<Entity>,
    pub primary: Option<Entity>,
    pub anchor: Option<Vec<u16>>,
}

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal<E> {
    /// A page larger than [`MAX_PAGE`].
    InvalidRequest,
    /// The host's folding failed.
    Host(E),
}
impl<E> Refusal<E> {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Host(_) => "host_policy_failed",
        }
    }
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn count_text(n: usize) -> Vec<u16> {
    u(&n.to_string())
}
fn plural(n: usize, word: &str) -> Vec<u16> {
    u(&format!("{n} {word}{}", if n == 1 { "" } else { "s" }))
}
fn config_keys(config: &ConfigMap) -> Vec<&Vec<u16>> {
    match config.value() {
        Value::Object(fields) => js_keys(fields),
        _ => Vec::new(),
    }
}
fn config_len(config: &ConfigMap) -> usize {
    match config.value() {
        Value::Object(fields) => fields.len(),
        _ => 0,
    }
}
/// `formatMm`: integers as `String(value)`, others to three decimals without
/// trailing zeros.
fn format_mm(value: f64) -> Vec<u16> {
    if value.is_finite() && value.trunc() == value {
        return u(&number_to_string(value));
    }
    let fixed = to_fixed(value, 3);
    let trimmed = fixed.trim_end_matches('0');
    u(trimmed.strip_suffix('.').unwrap_or(trimmed))
}
/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => *n != 0.0 && !n.is_nan(),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&u(name)),
        _ => None,
    }
}
/// `facetRefinementAssignedLeafCount`: assigned leaves in pre-order, within
/// the channel's node budget.
fn assigned_leaves(encoding: &Value) -> usize {
    let triangles = match field(encoding, "triangleCount") {
        Some(Value::Number(n)) => *n,
        _ => f64::NAN,
    };
    let budget = node_budget(triangles);
    let mut stack: Vec<&Value> = match field(encoding, "splits") {
        Some(Value::Array(splits)) => splits
            .iter()
            .rev()
            .filter_map(|split| field(split, "node"))
            .collect(),
        _ => Vec::new(),
    };
    let (mut seen, mut count) = (0.0, 0);
    while seen < budget {
        let Some(node) = stack.pop() else { break };
        if !matches!(node, Value::Object(_)) {
            continue;
        }
        seen += 1.0;
        if matches!(field(node, "kind"), Some(Value::String(kind)) if *kind == u("leaf")) {
            let state = field(node, "state").and_then(|s| field(s, "kind"));
            if matches!(state, Some(Value::String(kind)) if *kind == u("assigned")) {
                count += 1;
            }
            continue;
        }
        if let Some(Value::Array(children)) = field(node, "children") {
            stack.extend(children.iter().rev());
        }
    }
    count
}
/// One channel's painted facets: refined leaves when the channel is refined,
/// else the triangles of its sparse assignments.
fn channel_facets(annotations: &FacetAnnotations, channel: &str, sparse: &Value) -> usize {
    if let Some(encoding) = annotations
        .refinement
        .as_ref()
        .and_then(|r| field(r.value(), channel))
        .filter(|e| truthy(e))
    {
        return assigned_leaves(encoding);
    }
    match sparse {
        Value::Array(entries) => entries
            .iter()
            .map(|entry| match field(entry, "triangles") {
                Some(Value::Array(t)) => t.len(),
                _ => 0,
            })
            .sum(),
        _ => 0,
    }
}
fn paint<'a>(volumes: impl Iterator<Item = &'a FacetAnnotations>) -> Paint {
    let mut total = Paint {
        color_facets: 0,
        support_facets: 0,
    };
    for annotations in volumes {
        total.color_facets += channel_facets(annotations, "color", annotations.color.value());
        total.support_facets += channel_facets(annotations, "support", annotations.support.value());
    }
    total
}
fn filament_badge(
    state: &ProjectState,
    id: Option<&FilamentId>,
    inherited: bool,
) -> Option<Filament> {
    let id = id?;
    let units = id.as_utf16();
    if let Some(physical) = state
        .filaments
        .physical
        .iter()
        .find(|f| f.id.as_utf16() == units)
    {
        return Some(Filament {
            id: units.to_vec(),
            name: physical.name.units().to_vec(),
            color: physical.color.units().to_vec(),
            mixed: false,
            inherited,
        });
    }
    Some(
        match state
            .filaments
            .mixed
            .iter()
            .find(|f| f.id.as_utf16() == units)
        {
            Some(mixed) => Filament {
                id: units.to_vec(),
                name: mixed.name.units().to_vec(),
                color: mixed.display_color.units().to_vec(),
                mixed: true,
                inherited,
            },
            None => Filament {
                id: units.to_vec(),
                name: u("Missing filament"),
                color: u("#808080"),
                mixed: false,
                inherited,
            },
        },
    )
}
/// `resolveFilament`'s badge: a child's own filament, else the object's, which
/// is then inherited.
fn child_badge(
    state: &ProjectState,
    object: &ProjectObject,
    local: Option<&FilamentId>,
) -> Option<Filament> {
    match local {
        Some(id) => filament_badge(state, Some(id), false),
        None => filament_badge(state, object.filament_id.as_ref(), true),
    }
}

struct Builder<'s> {
    state: &'s ProjectState,
    projection: Projection,
}
struct Draft {
    key: Vec<u16>,
    kind: RowKind,
    parent: Option<usize>,
    label: Vec<u16>,
    description: Option<Vec<u16>>,
    entity: Option<Entity>,
    owner: Option<Entity>,
    indicators: Indicators,
    search: Vec<Vec<u16>>,
    default_expanded: bool,
}
impl Draft {
    fn new(key: Vec<u16>, kind: RowKind, parent: Option<usize>, label: Vec<u16>) -> Self {
        Self {
            key,
            kind,
            parent,
            label,
            description: None,
            entity: None,
            owner: None,
            indicators: Indicators::editable(),
            search: Vec::new(),
            default_expanded: false,
        }
    }
}
impl Builder<'_> {
    fn add(&mut self, draft: Draft) -> usize {
        let index = self.projection.rows.len();
        // `row()`: the search words, then the description (or nothing).
        let mut words = draft.search;
        words.push(draft.description.clone().unwrap_or_default());
        let search = words.join(&0x20);
        self.projection.by_key.insert(draft.key.clone(), index);
        if let Some(entity) = &draft.entity {
            self.projection.by_entity.insert(entity.clone(), index);
        }
        match draft.parent {
            Some(parent) => self.projection.rows[parent].children.push(index),
            None => self.projection.roots.push(index),
        }
        self.projection.rows.push(Row {
            key: draft.key,
            kind: draft.kind,
            parent: draft.parent,
            children: Vec::new(),
            label: draft.label,
            description: draft.description,
            entity: draft.entity,
            owner: draft.owner,
            indicators: draft.indicators,
            search,
            default_expanded: draft.default_expanded,
        });
        index
    }

    fn plate(&mut self, plate: &ProjectPlate) {
        let entity = Entity::Plate(plate.id.as_utf16().to_vec());
        let mut row = Draft::new(
            entity.row_key(),
            RowKind::Plate,
            None,
            plate.name.units().to_vec(),
        );
        row.description = Some(plural(plate.objects.len(), "object"));
        row.indicators.printable = Some(plate.printable);
        row.search = vec![
            plate.name.units().to_vec(),
            plate.id.as_utf16().to_vec(),
            u("plate"),
        ];
        row.entity = Some(entity);
        row.default_expanded = true;
        let key = self.add(row);
        for object in plate.objects.iter() {
            self.object(plate, object, key);
        }
    }

    fn object(&mut self, plate: &ProjectPlate, object: &ProjectObject, parent: usize) {
        let entity = Entity::Object(object.id.as_utf16().to_vec());
        let mut row = Draft::new(
            entity.row_key(),
            RowKind::Object,
            Some(parent),
            object.name.units().to_vec(),
        );
        row.description = Some(cat(&[
            &plural(object.volumes.len(), "part"),
            &u(", "),
            &plural(object.instances.len(), "instance"),
        ]));
        row.indicators.printable =
            Some(plate.printable && object.instances.iter().any(|i| i.printable));
        row.indicators.filament = filament_badge(self.state, object.filament_id.as_ref(), false);
        row.indicators.paint = Some(paint(object.volumes.iter().map(|v| &*v.annotations)));
        row.search = vec![
            object.name.units().to_vec(),
            object.id.as_utf16().to_vec(),
            u("object"),
        ];
        row.search
            .extend(config_keys(&object.config).into_iter().cloned());
        row.entity = Some(entity.clone());
        row.default_expanded = true;
        let key = self.add(row);

        for volume in object.volumes.iter() {
            self.volume(object, volume, key);
        }

        let group = cat(&[&u("instance-group:"), object.id.as_utf16()]);
        let mut row = Draft::new(
            group,
            RowKind::InstanceGroup,
            Some(key),
            cat(&[
                &u("Instances ("),
                &count_text(object.instances.len()),
                &u(")"),
            ]),
        );
        row.owner = Some(entity.clone());
        row.search = vec![u("instances"), object.name.units().to_vec()];
        let group = self.add(row);
        for (index, instance) in object.instances.iter().enumerate() {
            let entity = Entity::Instance(instance.id.as_utf16().to_vec());
            let trimmed = instance
                .name
                .as_ref()
                .map(|n| trim_utf16(n.units()).to_vec());
            let label = match trimmed {
                Some(name) if !name.is_empty() => name,
                _ => cat(&[&u("Instance "), &count_text(index + 1)]),
            };
            let mut row = Draft::new(
                entity.row_key(),
                RowKind::Instance,
                Some(group),
                label.clone(),
            );
            row.indicators.printable = Some(plate.printable && instance.printable);
            row.indicators.filament = filament_badge(self.state, object.filament_id.as_ref(), true);
            row.search = vec![
                label,
                instance.id.as_utf16().to_vec(),
                object.name.units().to_vec(),
                u("instance"),
            ];
            row.entity = Some(entity);
            self.add(row);
        }

        self.settings(&entity, &object.config, key);

        let group = cat(&[&u("layer-group:"), object.id.as_utf16()]);
        let mut row = Draft::new(
            group,
            RowKind::LayerGroup,
            Some(key),
            cat(&[
                &u("Layer ranges ("),
                &count_text(object.layer_ranges.len()),
                &u(")"),
            ]),
        );
        row.owner = Some(entity);
        row.search = vec![
            u("layer ranges"),
            u("height ranges"),
            object.name.units().to_vec(),
        ];
        let group = self.add(row);
        let mut ranges: Vec<&LayerRange> = object.layer_ranges.iter().map(|r| &**r).collect();
        ranges.sort_by(|a, b| {
            a.min_z_mm
                .get()
                .partial_cmp(&b.min_z_mm.get())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.as_utf16().cmp(b.id.as_utf16()))
        });
        for range in ranges {
            self.layer_range(object, range, group);
        }
    }

    fn volume(&mut self, object: &ProjectObject, volume: &ProjectVolume, parent: usize) {
        let entity = Entity::Volume(volume.id.as_utf16().to_vec());
        let role = u(volume.role.as_str());
        let mut row = Draft::new(
            entity.row_key(),
            RowKind::Volume,
            Some(parent),
            volume.name.units().to_vec(),
        );
        row.description = Some(role.clone());
        row.indicators.filament = child_badge(self.state, object, volume.filament_id.as_ref());
        row.indicators.paint = Some(paint(std::iter::once(&*volume.annotations)));
        row.indicators.settings_count = Some(config_len(&volume.config));
        row.indicators.volume_role = Some(volume.role);
        row.search = vec![
            volume.name.units().to_vec(),
            volume.id.as_utf16().to_vec(),
            role,
        ];
        row.search
            .extend(config_keys(&volume.config).into_iter().cloned());
        row.entity = Some(entity.clone());
        let key = self.add(row);
        self.settings(&entity, &volume.config, key);
    }

    fn layer_range(&mut self, object: &ProjectObject, range: &LayerRange, parent: usize) {
        let entity = Entity::LayerRange(range.id.as_utf16().to_vec());
        let label = cat(&[
            &format_mm(range.min_z_mm.get()),
            &u("\u{2013}"),
            &format_mm(range.max_z_mm.get()),
            &u(" mm"),
        ]);
        let mut row = Draft::new(
            entity.row_key(),
            RowKind::LayerRange,
            Some(parent),
            label.clone(),
        );
        row.indicators.filament = child_badge(self.state, object, range.filament_id.as_ref());
        row.indicators.settings_count = Some(config_len(&range.config));
        row.search = vec![
            label,
            range.id.as_utf16().to_vec(),
            u("layer range"),
            u("height range"),
        ];
        row.search
            .extend(config_keys(&range.config).into_iter().cloned());
        row.entity = Some(entity);
        self.add(row);
    }

    fn settings(&mut self, owner: &Entity, config: &ConfigMap, parent: usize) {
        let count = config_len(config);
        let parent_key = self.projection.rows[parent].key.clone();
        let mut row = Draft::new(
            cat(&[&u("settings:"), &parent_key]),
            RowKind::Settings,
            Some(parent),
            if count == 0 {
                u("Settings")
            } else {
                cat(&[&u("Settings ("), &count_text(count), &u(")")])
            },
        );
        row.description = Some(if count == 0 {
            u("Inherited defaults")
        } else {
            plural(count, "local override")
        });
        row.owner = Some(owner.clone());
        row.indicators.settings_count = Some(count);
        row.search = vec![u("settings"), u("overrides")];
        row.search.extend(config_keys(config).into_iter().cloned());
        self.add(row);
    }
}

impl Projection {
    /// `projectObjectsTree(state)`: plates by order (then ID), each with its
    /// objects; an object's parts (each with its settings), instances, own
    /// settings and height ranges (by lower bound, then ID).
    pub fn new(state: &ProjectState) -> Self {
        let mut builder = Builder {
            state,
            projection: Projection {
                rows: Vec::new(),
                roots: Vec::new(),
                by_key: HashMap::new(),
                by_entity: HashMap::new(),
            },
        };
        let mut plates: Vec<&ProjectPlate> = state.plates.iter().map(|p| &**p).collect();
        plates.sort_by(|a, b| {
            a.order
                .get()
                .partial_cmp(&b.order.get())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.as_utf16().cmp(b.id.as_utf16()))
        });
        for plate in plates {
            builder.plate(plate);
        }
        builder.projection
    }
    pub fn rows(&self) -> &[Row] {
        &self.rows
    }
    pub fn roots(&self) -> &[usize] {
        &self.roots
    }
    pub fn row(&self, key: &[u16]) -> Option<usize> {
        self.by_key.get(key).copied()
    }

    /// `buildObjectTreeView`: the rows a panel shows, depth first. A filter's
    /// tokens must all occur in a row's search text; matching rows show with
    /// their ancestors and descendants, every branch open. Focus is the
    /// requested row, else the primary selection's, else the first, among
    /// those visible.
    pub fn view<F: SearchFolding>(
        &self,
        options: ViewOptions<'_>,
        folding: &mut F,
    ) -> Result<View, F::Error> {
        let query = search_text(options.filter, folding)?;
        let tokens: Vec<&[u16]> = if query.is_empty() {
            Vec::new()
        } else {
            query.split(|unit| *unit == 0x20).collect()
        };
        let mut matched = vec![false; self.rows.len()];
        let included = if tokens.is_empty() {
            None
        } else {
            let mut included = vec![false; self.rows.len()];
            for (index, row) in self.rows.iter().enumerate() {
                let text = search_text(&row.search, folding)?;
                if tokens.iter().all(|token| contains(&text, token)) {
                    matched[index] = true;
                }
            }
            for index in (0..self.rows.len()).filter(|i| matched[*i]) {
                let mut current = Some(index);
                while let Some(row) = current {
                    included[row] = true;
                    current = self.rows[row].parent;
                }
                let mut stack = vec![index];
                while let Some(row) = stack.pop() {
                    included[row] = true;
                    stack.extend(&self.rows[row].children);
                }
            }
            Some(included)
        };
        let visible = |row: &usize| included.as_ref().is_none_or(|set| set[*row]);
        let expanded = |row: &Row| match options.expanded {
            Some(keys) => keys.contains(&row.key),
            None => row.default_expanded,
        };
        let selected: HashSet<&Entity> = options.selection.refs.iter().collect();

        let mut rows = Vec::new();
        let mut pending = vec![(
            self.roots
                .iter()
                .copied()
                .filter(visible)
                .collect::<Vec<_>>(),
            0,
            1,
        )];
        // Depth first through sibling lists; each frame remembers its next sibling.
        while let Some((siblings, next, level)) = pending.pop() {
            let Some(&index) = siblings.get(next) else {
                continue;
            };
            let row = &self.rows[index];
            let children: Vec<usize> = row.children.iter().copied().filter(visible).collect();
            let open = !children.is_empty() && (included.is_some() || expanded(row));
            rows.push(VisibleRow {
                row: index,
                matched: matched[index],
                focused: false,
                selected: row.entity.as_ref().is_some_and(|e| selected.contains(e)),
                level,
                position: next + 1,
                set_size: siblings.len(),
                expansion: if row.children.is_empty() {
                    Expansion::Leaf
                } else if open {
                    Expansion::Expanded
                } else {
                    Expansion::Collapsed
                },
            });
            pending.push((siblings, next + 1, level));
            if open {
                pending.push((children, 0, level + 1));
            }
        }
        let index: HashMap<usize, usize> =
            rows.iter().enumerate().map(|(i, r)| (r.row, i)).collect();
        let shown = |row: Option<usize>| row.and_then(|r| index.get(&r).copied());
        let primary = options
            .selection
            .primary
            .as_ref()
            .and_then(|p| self.by_entity.get(p).copied());
        let focus = shown(options.focused.and_then(|key| self.row(key)))
            .or_else(|| shown(primary))
            .or(if rows.is_empty() { None } else { Some(0) });
        if let Some(focus) = focus {
            rows[focus].focused = true;
        }
        Ok(View {
            rows,
            focus,
            filter_active: !tokens.is_empty(),
            index,
        })
    }

    /// `objectTreeSelectionRequest` then `resolveObjectTreeSelection`: the
    /// selection activating a visible row commits, or `None` when the row is
    /// not visible or selects no entity.
    pub fn select(
        &self,
        view: &View,
        key: &[u16],
        mode: Mode,
        anchor: Option<&[u16]>,
        selection: &Selection,
    ) -> Option<Selected> {
        let target_index = view.index.get(&self.row(key)?).copied()?;
        let target = self.rows[view.rows[target_index].row].entity.clone()?;
        Some(match mode {
            Mode::Replace => Selected {
                refs: vec![target.clone()],
                primary: Some(target),
                anchor: Some(key.to_vec()),
            },
            Mode::Range => {
                let anchor_index = anchor
                    .and_then(|key| self.row(key))
                    .and_then(|row| view.index.get(&row).copied());
                let refs = match anchor_index {
                    None => vec![target.clone()],
                    Some(anchor_index) => {
                        let (start, end) = (
                            anchor_index.min(target_index),
                            anchor_index.max(target_index),
                        );
                        let mut refs: Vec<Entity> = Vec::new();
                        for visible in &view.rows[start..=end] {
                            if let Some(entity) = &self.rows[visible.row].entity
                                && !refs.contains(entity)
                            {
                                refs.push(entity.clone());
                            }
                        }
                        refs
                    }
                };
                Selected {
                    refs,
                    primary: Some(target),
                    anchor: anchor.map(<[u16]>::to_vec),
                }
            }
            Mode::Toggle => {
                let mut refs = selection.refs.clone();
                let found = refs.iter().position(|r| *r == target);
                let primary = match found {
                    Some(index) => {
                        refs.remove(index);
                        match &selection.primary {
                            Some(existing) if refs.contains(existing) => Some(existing.clone()),
                            _ => refs.last().cloned(),
                        }
                    }
                    None => {
                        refs.push(target.clone());
                        Some(target)
                    }
                };
                Selected {
                    refs,
                    primary,
                    anchor: Some(key.to_vec()),
                }
            }
        })
    }
}

/// `normalizeSearch` over the host's folding.
fn search_text<F: SearchFolding>(text: &[u16], folding: &mut F) -> Result<Vec<u16>, F::Error> {
    let folded = if text.iter().all(|unit| *unit < 0x80) {
        text.iter()
            .map(|&unit| {
                if (0x41..=0x5a).contains(&unit) {
                    unit + 0x20
                } else {
                    unit
                }
            })
            .collect()
    } else {
        folding.fold(text)?
    };
    let stripped: Vec<u16> = folded
        .into_iter()
        .filter(|unit| !(0x300..=0x36f).contains(unit))
        .collect();
    let space = |unit: u16| char::from_u32(u32::from(unit)).is_some_and(is_space);
    let mut out = Vec::with_capacity(stripped.len());
    let mut in_space = false;
    for &unit in trim_utf16(&stripped) {
        if space(unit) {
            if !in_space {
                out.push(0x20);
            }
            in_space = true;
        } else {
            out.push(unit);
            in_space = false;
        }
    }
    Ok(out)
}
fn contains(text: &[u16], token: &[u16]) -> bool {
    token.is_empty() || text.windows(token.len()).any(|window| window == token)
}

fn entity_from_wire(entity: &wire::SelectionEntity) -> Option<Entity> {
    match entity {
        wire::SelectionEntity::Plate(id) => Some(Entity::Plate(id.clone())),
        wire::SelectionEntity::Object(id) => Some(Entity::Object(id.clone())),
        wire::SelectionEntity::Volume(id) => Some(Entity::Volume(id.clone())),
        wire::SelectionEntity::Instance(id) => Some(Entity::Instance(id.clone())),
        wire::SelectionEntity::LayerRange(id) => Some(Entity::LayerRange(id.clone())),
        wire::SelectionEntity::Project(_) | wire::SelectionEntity::Filament(_) => None,
    }
}
fn entity_wire(entity: &Entity) -> wire::ObjectTreeEntity {
    match entity {
        Entity::Plate(id) => wire::ObjectTreeEntity::Plate(id.clone()),
        Entity::Object(id) => wire::ObjectTreeEntity::Object(id.clone()),
        Entity::Volume(id) => wire::ObjectTreeEntity::Volume(id.clone()),
        Entity::Instance(id) => wire::ObjectTreeEntity::Instance(id.clone()),
        Entity::LayerRange(id) => wire::ObjectTreeEntity::LayerRange(id.clone()),
    }
}
fn optional_entity(entity: Option<&Entity>) -> wire::OptionalObjectTreeEntity {
    match entity {
        Some(entity) => wire::OptionalObjectTreeEntity::Value(entity_wire(entity)),
        None => wire::OptionalObjectTreeEntity::Absent(wire::Empty {}),
    }
}
fn optional_text(text: Option<&[u16]>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn wire_text(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}
fn role_wire(role: VolumeRole) -> wire::VolumeRoleName {
    match role {
        VolumeRole::Model => wire::VolumeRoleName::Model,
        VolumeRole::NegativeVolume => wire::VolumeRoleName::NegativeVolume,
        VolumeRole::ParameterModifier => wire::VolumeRoleName::ParameterModifier,
        VolumeRole::SupportBlocker => wire::VolumeRoleName::SupportBlocker,
        VolumeRole::SupportEnforcer => wire::VolumeRoleName::SupportEnforcer,
    }
}
fn row_wire(projection: &Projection, visible: &VisibleRow) -> wire::ObjectTreeRow {
    let row = &projection.rows[visible.row];
    let i = &row.indicators;
    wire::ObjectTreeRow {
        key: row.key.clone(),
        kind: match row.kind {
            RowKind::Plate => wire::ObjectTreeRowKind::Plate,
            RowKind::Object => wire::ObjectTreeRowKind::Object,
            RowKind::Volume => wire::ObjectTreeRowKind::Volume,
            RowKind::InstanceGroup => wire::ObjectTreeRowKind::InstanceGroup,
            RowKind::Instance => wire::ObjectTreeRowKind::Instance,
            RowKind::Settings => wire::ObjectTreeRowKind::Settings,
            RowKind::LayerGroup => wire::ObjectTreeRowKind::LayerGroup,
            RowKind::LayerRange => wire::ObjectTreeRowKind::LayerRange,
        },
        parent_key: optional_text(row.parent.map(|p| &projection.rows[p].key[..])),
        label: row.label.clone(),
        description: optional_text(row.description.as_deref()),
        entity: optional_entity(row.entity.as_ref()),
        owner: optional_entity(row.owner.as_ref()),
        indicators: wire::ObjectTreeIndicators {
            printable: match i.printable {
                None => wire::ObjectTreePrintable::Unknown,
                Some(true) => wire::ObjectTreePrintable::Printable,
                Some(false) => wire::ObjectTreePrintable::NotPrintable,
            },
            filament: match &i.filament {
                Some(f) => wire::OptionalObjectTreeFilament::Value(wire::ObjectTreeFilament {
                    id: f.id.clone(),
                    name: f.name.clone(),
                    color: f.color.clone(),
                    mixed: f.mixed,
                    inherited: f.inherited,
                }),
                None => wire::OptionalObjectTreeFilament::Absent(wire::Empty {}),
            },
            paint: match i.paint {
                Some(p) => wire::OptionalObjectTreePaint::Value(wire::ObjectTreePaint {
                    color_facet_count: p.color_facets as u64,
                    support_facet_count: p.support_facets as u64,
                }),
                None => wire::OptionalObjectTreePaint::Absent(wire::Empty {}),
            },
            editable: i.editable,
            settings_count: match i.settings_count {
                Some(n) => wire::OptionalCounter::Value(n as u64),
                None => wire::OptionalCounter::Absent(wire::Empty {}),
            },
            volume_role: match i.volume_role {
                Some(role) => wire::OptionalVolumeRoleName::Value(role_wire(role)),
                None => wire::OptionalVolumeRoleName::Absent(wire::Empty {}),
            },
        },
        matched_filter: visible.matched,
        focused: visible.focused,
        selected: visible.selected,
        level: visible.level as u64,
        position_in_set: visible.position as u64,
        set_size: visible.set_size as u64,
        expansion: match visible.expansion {
            Expansion::Leaf => wire::ObjectTreeRowExpansion::Leaf,
            Expansion::Collapsed => wire::ObjectTreeRowExpansion::Collapsed,
            Expansion::Expanded => wire::ObjectTreeRowExpansion::Expanded,
        },
    }
}

/// Answer one `ObjectTreeRequest` against a project's state.
pub fn answer<F: SearchFolding>(
    state: &ProjectState,
    request: &wire::ObjectTreeRequest,
    folding: &mut F,
) -> Result<wire::ObjectTreeReply, Refusal<F::Error>> {
    if let wire::ObjectTreeOperation::Page(page) = &request.operation
        && page.count > MAX_PAGE
    {
        return Err(Refusal::InvalidRequest);
    }
    let projection = Projection::new(state);
    let selection = Selection {
        refs: request
            .selection
            .iter()
            .filter_map(entity_from_wire)
            .collect(),
        primary: match &request.primary {
            wire::OptionalSelectionEntity::Value(entity) => entity_from_wire(entity),
            wire::OptionalSelectionEntity::Absent(_) => None,
        },
    };
    let expanded: Option<HashSet<Vec<u16>>> = match &request.expansion {
        wire::ObjectTreeExpansion::Default(_) => None,
        wire::ObjectTreeExpansion::Keys(keys) => Some(keys.iter().cloned().collect()),
    };
    let view = projection
        .view(
            ViewOptions {
                expanded: expanded.as_ref(),
                filter: &request.filter_query,
                selection: &selection,
                focused: wire_text(&request.focused_key),
            },
            folding,
        )
        .map_err(Refusal::Host)?;
    Ok(match &request.operation {
        wire::ObjectTreeOperation::Page(page) => {
            let start = usize::try_from(page.start)
                .unwrap_or(usize::MAX)
                .min(view.rows.len());
            let end = start
                .saturating_add(page.count as usize)
                .min(view.rows.len());
            wire::ObjectTreeReply::Page(wire::ObjectTreePage {
                total_rows: view.rows.len() as u64,
                focus_key: optional_text(
                    view.focus
                        .map(|f| &projection.rows[view.rows[f].row].key[..]),
                ),
                filter_active: view.filter_active,
                rows: view.rows[start..end]
                    .iter()
                    .map(|v| row_wire(&projection, v))
                    .collect(),
            })
        }
        wire::ObjectTreeOperation::Select(select) => {
            let mode = match select.mode {
                wire::ObjectTreeSelectionMode::Replace => Mode::Replace,
                wire::ObjectTreeSelectionMode::Toggle => Mode::Toggle,
                wire::ObjectTreeSelectionMode::Range => Mode::Range,
            };
            match projection.select(
                &view,
                &select.key,
                mode,
                wire_text(&select.anchor_key),
                &selection,
            ) {
                Some(selected) => wire::ObjectTreeReply::Selected(wire::ObjectTreeSelection {
                    refs: selected.refs.iter().map(entity_wire).collect(),
                    primary: optional_entity(selected.primary.as_ref()),
                    anchor_key: optional_text(selected.anchor.as_deref()),
                }),
                None => wire::ObjectTreeReply::Ignored(wire::Empty {}),
            }
        }
    })
}
