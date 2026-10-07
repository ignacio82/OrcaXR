//! Bounded read projections over one immutable admitted revision. No JSON export,
//! geometry copy, authority mutation, callback, or persisted positional identity.
use crate::{model::*, store::ProjectSnapshot};
use orcaxr_contracts::canonical::Value;

macro_rules! query_enum {
    ($name:ident, $($variant:ident = $index:literal => $wire:literal,)*) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        #[repr(u32)]
        pub enum $name { $($variant = $index,)* }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)*];
            pub fn from_index(index: u32) -> Option<Self> {
                match index { $($index => Some(Self::$variant),)* _ => None }
            }
            pub fn as_str(self) -> &'static str { match self { $(Self::$variant => $wire,)* } }
        }
    };
}
macro_rules! kind_fields {
    ($($kind:ident => ([$($required:ident),*], [$($optional:ident),*], [$($text:ident),*]),)*) => {
        pub fn fields(kind: Kind) -> (&'static [NumberField], &'static [NumberField], &'static [TextField]) {
            match kind { $(Kind::$kind => (&[$(NumberField::$required),*], &[$(NumberField::$optional),*], &[$(TextField::$text),*]),)* }
        }
    };
}
macro_rules! relation_kinds {
    ($($relation:ident => ($parent:ident, $child:ident),)*) => {
        pub fn relation_kinds(relation: Relation) -> (Kind, Kind) {
            match relation { $(Relation::$relation => (Kind::$parent, Kind::$child),)* }
        }
    };
}
enum Policy {
    Index,
    Integer,
    Boolean,
    Finite,
    Enum(u32),
    ComponentCount,
}
impl Policy {
    fn accepts(self, value: f64) -> bool {
        value.is_finite()
            && match self {
                Self::Index => {
                    value.fract() == 0.0 && (0.0..=layout::MAX_INDEX as f64).contains(&value)
                }
                Self::Integer => value.fract() == 0.0 && value >= 0.0,
                Self::Boolean => value == 0.0 || value == 1.0,
                Self::Finite => true,
                Self::ComponentCount => value.fract() == 0.0 && (1.0..=4.0).contains(&value),
                Self::Enum(n) => value.fract() == 0.0 && value >= 0.0 && value < f64::from(n),
            }
    }
}
macro_rules! number_policies {
    ($($field:ident => $policy:expr,)*) => {
        pub fn number_valid(field: NumberField, value: f64) -> bool {
            let policy = match field { $(NumberField::$field => $policy,)* };
            policy.accepts(value)
        }
    };
}
enum Constraint {
    Together(&'static [layout::NumberField]),
    Requires(layout::NumberField, layout::NumberField),
    EqualsIfPresent(layout::NumberField, layout::NumberField, f64),
}
impl Constraint {
    fn accepts(&self, values: &[(layout::NumberField, f64)]) -> bool {
        let get = |field| values.iter().find(|v| v.0 == field).map(|v| v.1);
        match self {
            Self::Together(fields) => {
                fields.iter().all(|f| get(*f).is_none()) || fields.iter().all(|f| get(*f).is_some())
            }
            Self::Requires(field, required) => get(*field).is_none() || get(*required).is_some(),
            Self::EqualsIfPresent(field, required, expected) => {
                get(*field).is_none() || get(*required) == Some(*expected)
            }
        }
    }
}
macro_rules! query_constraints {
    ($($kind:ident => [$($constraint:expr),*],)*) => {
        pub(super) fn constraints(kind: Kind) -> &'static [Constraint] {
            match kind { $(Kind::$kind => &[$($constraint),*],)* }
        }
    };
}
pub mod layout {
    use super::{Constraint, Policy};
    include!("layout.rs");
}
use layout::{Kind, NumberField as F, Relation, TextField as T};
pub type Result<V> = std::result::Result<V, &'static str>;

// These addresses are private, validated on construction, and meaningful only
// inside this capture. Commands still use canonical stable IDs and session guards.
#[derive(Debug, Clone, Copy)]
enum Address {
    Project,
    Plate(usize),
    Object(usize, usize),
    Volume(usize, usize, usize),
    Instance(usize, usize, usize),
    LayerRange(usize, usize, usize),
    Physical(usize),
    Mixed(usize),
    Asset(usize),
}
#[derive(Debug, Clone)]
pub struct QueryNode {
    snapshot: ProjectSnapshot,
    address: Address,
}
enum View<'a> {
    Project(&'a ProjectState),
    Plate(&'a ProjectPlate),
    Object(&'a ProjectObject),
    Volume(&'a ProjectObject, &'a ProjectVolume),
    Instance(&'a ProjectPlate, &'a ProjectObject, &'a ProjectInstance),
    LayerRange(&'a ProjectObject, &'a LayerRange),
    Physical(&'a PhysicalFilament),
    Mixed(&'a MixedFilament),
    Asset(&'a SourceAssetDescriptor),
}
impl QueryNode {
    pub fn new(snapshot: ProjectSnapshot) -> Self {
        Self {
            snapshot,
            address: Address::Project,
        }
    }
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.snapshot.clone()
    }
    /// Native consumers can resolve a typed captured object without exposing
    /// positional addresses as UI row numbers or command identities.
    pub(crate) fn object_address(&self) -> Option<(usize, usize)> {
        match self.address {
            Address::Object(plate, object) => Some((plate, object)),
            _ => None,
        }
    }
    pub fn kind(&self) -> Kind {
        match self.address {
            Address::Project => Kind::Project,
            Address::Plate(_) => Kind::Plate,
            Address::Object(..) => Kind::Object,
            Address::Volume(..) => Kind::Volume,
            Address::Instance(..) => Kind::Instance,
            Address::LayerRange(..) => Kind::LayerRange,
            Address::Physical(_) => Kind::PhysicalFilament,
            Address::Mixed(_) => Kind::MixedFilament,
            Address::Asset(_) => Kind::Asset,
        }
    }
    fn view(&self) -> View<'_> {
        let s = self.snapshot.state();
        match self.address {
            Address::Project => View::Project(s),
            Address::Plate(p) => View::Plate(&s.plates[p]),
            Address::Object(p, o) => View::Object(&s.plates[p].objects[o]),
            Address::Volume(p, o, v) => {
                let object = &s.plates[p].objects[o];
                View::Volume(object, &object.volumes[v])
            }
            Address::Instance(p, o, i) => {
                let plate = &s.plates[p];
                let object = &plate.objects[o];
                View::Instance(plate, object, &object.instances[i])
            }
            Address::LayerRange(p, o, r) => {
                let object = &s.plates[p].objects[o];
                View::LayerRange(object, &object.layer_ranges[r])
            }
            Address::Physical(i) => View::Physical(&s.filaments.physical[i]),
            Address::Mixed(i) => View::Mixed(&s.filaments.mixed[i]),
            Address::Asset(i) => View::Asset(&s.source_assets[i]),
        }
    }
    /// Returns borrowed text; hosts can only expose bounded owned chunks. None
    /// preserves optional absence separately from an authored empty string.
    pub fn text(&self, field: T) -> Result<Option<&[u16]>> {
        if !layout::fields(self.kind()).2.contains(&field) {
            return Err("invalid_field");
        }
        let text = match (self.view(), field) {
            (View::Project(v), T::Id) => Some(v.id.as_utf16()),
            (View::Project(v), T::Name) => Some(v.name.units()),
            (View::Project(v), T::ProfileId) => v.printer.profile_id.as_ref().map(Text::units),
            (View::Project(v), T::ProfileHash) => v.printer.profile_hash.as_ref().map(Text::units),
            (View::Plate(v), T::Id) => Some(v.id.as_utf16()),
            (View::Plate(v), T::Name) => Some(v.name.units()),
            (View::Object(v), T::Id) => Some(v.id.as_utf16()),
            (View::Object(v), T::Name) => Some(v.name.units()),
            (View::Object(v), T::LocalFilamentId | T::EffectiveFilamentId) => {
                v.filament_id.as_ref().map(|v| v.as_utf16())
            }
            (View::Volume(_, v), T::Id) => Some(v.id.as_utf16()),
            (View::Volume(_, v), T::Name) => Some(v.name.units()),
            (View::Volume(_, v), T::LocalFilamentId) => {
                v.filament_id.as_ref().map(|v| v.as_utf16())
            }
            (View::Volume(o, v), T::EffectiveFilamentId) => v
                .filament_id
                .as_ref()
                .or(o.filament_id.as_ref())
                .map(|v| v.as_utf16()),
            (View::Volume(_, v), T::AssetId) => Some(v.source.asset_id.as_utf16()),
            (View::Instance(_, _, v), T::Id) => Some(v.id.as_utf16()),
            (View::Instance(_, _, v), T::Name) => v.name.as_ref().map(Text::units),
            (View::Instance(_, o, _), T::EffectiveFilamentId) => {
                o.filament_id.as_ref().map(|v| v.as_utf16())
            }
            (View::LayerRange(_, v), T::Id) => Some(v.id.as_utf16()),
            (View::LayerRange(_, v), T::LocalFilamentId) => {
                v.filament_id.as_ref().map(|v| v.as_utf16())
            }
            (View::LayerRange(o, v), T::EffectiveFilamentId) => v
                .filament_id
                .as_ref()
                .or(o.filament_id.as_ref())
                .map(|v| v.as_utf16()),
            (View::Physical(v), T::Id) => Some(v.id.as_utf16()),
            (View::Physical(v), T::Name) => Some(v.name.units()),
            (View::Physical(v), T::Color) => Some(v.color.units()),
            (View::Physical(v), T::Material) => Some(v.material.units()),
            (View::Physical(v), T::ProfileId) => v.preset_id.as_ref().map(Text::units),
            (View::Physical(v), T::ProfileHash) => v.preset_hash.as_ref().map(Text::units),
            (View::Mixed(v), T::Id) => Some(v.id.as_utf16()),
            (View::Mixed(v), T::Name) => Some(v.name.units()),
            (View::Mixed(v), T::Color) => Some(v.display_color.units()),
            (View::Asset(v), T::Id) => Some(v.id.as_utf16()),
            (View::Asset(v), T::Filename) => v.source_filename.as_ref().map(Text::units),
            (View::Asset(v), T::MediaType) => Some(v.media_type.units()),
            (View::Asset(v), T::Digest) => Some(v.digest.units()),
            _ => return Err("invalid_field"),
        };
        Ok(text)
    }
    pub fn read_text(&self, field: T, start: usize, count: usize) -> Result<Vec<u16>> {
        let text = self.text(field)?.ok_or("missing_field")?;
        let range = range(start, count, text.len(), layout::MAX_TEXT_CHUNK_UNITS)?;
        Ok(text[range].to_vec())
    }
    /// Finite numeric fields only; no names, IDs, settings values, paint arrays,
    /// mesh bytes, or JSON encoding are allocated by this read.
    pub fn metadata(&self) -> Result<Vec<f64>> {
        let mut values = Vec::with_capacity(18);
        let mut add = |field, value| values.push((field, value));
        match self.view() {
            View::Project(v) => {
                add(F::SettingsCount, config_count(&v.config));
                add(F::ToolCount, v.printer.tool_count.get());
                add(F::PlateCount, v.plates.len() as f64);
                add(F::PhysicalCount, v.filaments.physical.len() as f64);
                add(F::MixedCount, v.filaments.mixed.len() as f64);
                add(F::AssetCount, v.source_assets.len() as f64);
            }
            View::Plate(v) => {
                add(F::Order, v.order.get());
                add(F::Printable, u8::from(v.printable).into());
                add(
                    F::Active,
                    u8::from(v.id == self.snapshot.state().active_plate_id).into(),
                );
                add(F::SettingsCount, config_count(&v.config));
                add(F::ObjectCount, v.objects.len() as f64);
            }
            View::Object(v) => {
                add(F::SettingsCount, config_count(&v.config));
                add(F::VolumeCount, v.volumes.len() as f64);
                add(F::InstanceCount, v.instances.len() as f64);
                add(F::RangeCount, v.layer_ranges.len() as f64);
            }
            View::Volume(_, v) => {
                add(F::SettingsCount, config_count(&v.config));
                add(F::Role, enum_index(VolumeRole::VALUES, v.role));
                add(F::TriangleCount, v.source.triangle_count.get());
                add(F::TopologyRevision, v.source.topology_revision.get());
                transform(&mut add, &v.transform);
            }
            View::Instance(p, _, v) => {
                add(F::Printable, u8::from(v.printable).into());
                add(
                    F::EffectivePrintable,
                    u8::from(p.printable && v.printable).into(),
                );
                transform(&mut add, &v.transform);
            }
            View::LayerRange(_, v) => {
                add(F::MinZMm, v.min_z_mm.get());
                add(F::MaxZMm, v.max_z_mm.get());
                add(F::SettingsCount, config_count(&v.config));
            }
            View::Physical(v) => {
                add(F::ToolId, v.tool_id.get());
                add(F::Enabled, u8::from(v.enabled).into());
                add(F::SettingsCount, config_count(&v.config));
                if let Some(n) = v.nozzle_diameter_mm {
                    add(F::NozzleDiameterMm, n.get());
                }
            }
            View::Mixed(v) => {
                add(F::Enabled, u8::from(v.enabled).into());
                add(F::SettingsCount, config_count(&v.config));
                add(F::ComponentCount, v.components.len() as f64);
            }
            View::Asset(v) => {
                add(F::AssetKind, enum_index(SourceAssetKind::VALUES, v.kind));
                add(F::ByteLength, v.byte_length.get());
                if let Some(mesh) = &v.mesh {
                    add(F::TriangleCount, mesh.triangle_count.get());
                    buffer(&mut add, &mesh.positions, false);
                    if let Some(indices) = &mesh.indices {
                        buffer(&mut add, indices, true);
                    }
                }
            }
        }
        values.sort_unstable_by_key(|v| v.0);
        let (required, optional, _) = layout::fields(self.kind());
        if required.iter().any(|f| !values.iter().any(|v| v.0 == *f))
            || values.iter().any(|(f, v)| {
                !layout::number_valid(*f, *v) || (!required.contains(f) && !optional.contains(f))
            })
        {
            return Err("invalid_projection");
        }
        let mut output = Vec::with_capacity(2 + 2 * values.len());
        if !layout::constraints(self.kind())
            .iter()
            .all(|c| c.accepts(&values))
        {
            return Err("invalid_projection");
        }
        output.extend([layout::VERSION as f64, self.kind() as u32 as f64]);
        for (field, value) in values {
            output.extend([field as u32 as f64, value]);
        }
        Ok(output)
    }
    /// Only plate/range lists need an index. Refuse their explicit entry budget
    /// BEFORE allocation/sorting. Other lists retain their canonical array order
    /// with constant-size ownership, even when the collection is very large.
    pub fn children(&self, relation: Relation, max_sort_entries: usize) -> Result<QueryList> {
        if layout::relation_kinds(relation).0 != self.kind() {
            return Err("invalid_relation");
        }
        let len = match (self.view(), relation) {
            (View::Project(v), Relation::Plates) => v.plates.len(),
            (View::Project(v), Relation::PhysicalFilaments) => v.filaments.physical.len(),
            (View::Project(v), Relation::MixedFilaments) => v.filaments.mixed.len(),
            (View::Project(v), Relation::SourceAssets) => v.source_assets.len(),
            (View::Plate(v), Relation::Objects) => v.objects.len(),
            (View::Object(v), Relation::Volumes) => v.volumes.len(),
            (View::Object(v), Relation::Instances) => v.instances.len(),
            (View::Object(v), Relation::LayerRanges) => v.layer_ranges.len(),
            _ => return Err("invalid_relation"),
        };
        if len > layout::MAX_INDEX || max_sort_entries > layout::MAX_INDEX {
            return Err("resource_limit");
        }
        let order = if matches!(relation, Relation::Plates | Relation::LayerRanges) {
            if len > max_sort_entries {
                return Err("resource_limit");
            }
            let mut index = Vec::new();
            index.try_reserve_exact(len).map_err(|_| "resource_limit")?;
            index.extend(0..len);
            match self.view() {
                View::Project(s) => index.sort_unstable_by(|a, b| {
                    let a = &s.plates[*a];
                    let b = &s.plates[*b];
                    a.order
                        .get()
                        .partial_cmp(&b.order.get())
                        .unwrap()
                        .then_with(|| a.id.cmp(&b.id))
                }),
                View::Object(o) => index.sort_unstable_by(|a, b| {
                    let a = &o.layer_ranges[*a];
                    let b = &o.layer_ranges[*b];
                    a.min_z_mm
                        .get()
                        .partial_cmp(&b.min_z_mm.get())
                        .unwrap()
                        .then_with(|| a.id.cmp(&b.id))
                }),
                _ => unreachable!(),
            }
            Some(index)
        } else {
            None
        };
        Ok(QueryList {
            parent: self.clone(),
            relation,
            len,
            order,
        })
    }
}
fn enum_index<T: PartialEq>(values: &[T], value: T) -> f64 {
    values
        .iter()
        .position(|v| *v == value)
        .expect("declared enum") as f64
}
fn config_count(config: &ConfigMap) -> f64 {
    let Value::Object(fields) = config.value() else {
        unreachable!()
    };
    fields.len() as f64
}
fn transform(add: &mut impl FnMut(F, f64), t: &Transform) {
    for (field, value) in [
        F::Tx,
        F::Ty,
        F::Tz,
        F::Qx,
        F::Qy,
        F::Qz,
        F::Qw,
        F::Sx,
        F::Sy,
        F::Sz,
    ]
    .into_iter()
    .zip(
        t.translation_mm
            .iter()
            .chain(t.rotation.iter())
            .chain(t.scale.iter()),
    ) {
        add(field, value.get());
    }
}
fn buffer(add: &mut impl FnMut(F, f64), v: &BufferViewDescriptor, indices: bool) {
    let fields = if indices {
        [
            F::IndicesOffset,
            F::IndicesLength,
            F::IndicesType,
            F::IndicesComponents,
            F::IndicesCount,
            F::IndicesStride,
        ]
    } else {
        [
            F::PositionsOffset,
            F::PositionsLength,
            F::PositionsType,
            F::PositionsComponents,
            F::PositionsCount,
            F::PositionsStride,
        ]
    };
    for (field, value) in fields[..5].iter().zip([
        v.byte_offset.get(),
        v.byte_length.get(),
        enum_index(MeshComponentType::VALUES, v.component_type),
        v.component_count.number(),
        v.count.get(),
    ]) {
        add(*field, value);
    }
    if let Some(stride) = v.byte_stride {
        add(fields[5], stride.get());
    }
}
fn range(
    start: usize,
    count: usize,
    length: usize,
    maximum: usize,
) -> Result<std::ops::Range<usize>> {
    if start > length || count > maximum || count > length - start {
        return Err("invalid_range");
    }
    Ok(start..start + count)
}
#[derive(Debug)]
pub struct QueryList {
    parent: QueryNode,
    relation: Relation,
    len: usize,
    order: Option<Vec<usize>>,
}
impl QueryList {
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.parent.snapshot()
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn node(&self, position: usize) -> Result<QueryNode> {
        if position >= self.len {
            return Err("invalid_range");
        }
        let index = self.order.as_ref().map_or(position, |v| v[position]);
        let address = match (self.parent.address, self.relation) {
            (Address::Project, Relation::Plates) => Address::Plate(index),
            (Address::Project, Relation::PhysicalFilaments) => Address::Physical(index),
            (Address::Project, Relation::MixedFilaments) => Address::Mixed(index),
            (Address::Project, Relation::SourceAssets) => Address::Asset(index),
            (Address::Plate(p), Relation::Objects) => Address::Object(p, index),
            (Address::Object(p, o), Relation::Volumes) => Address::Volume(p, o, index),
            (Address::Object(p, o), Relation::Instances) => Address::Instance(p, o, index),
            (Address::Object(p, o), Relation::LayerRanges) => Address::LayerRange(p, o, index),
            _ => unreachable!(),
        };
        Ok(QueryNode {
            snapshot: self.parent.snapshot(),
            address,
        })
    }
    pub fn page(&self, start: usize, count: usize) -> Result<Vec<f64>> {
        let positions = range(start, count, self.len, layout::MAX_PAGE_ROWS)?;
        let mut output = vec![
            layout::VERSION as f64,
            self.len as f64,
            start as f64,
            count as f64,
        ];
        for position in positions {
            let row = self.node(position)?.metadata()?;
            output.push(row.len() as f64);
            output.extend(row);
        }
        Ok(output)
    }
}
