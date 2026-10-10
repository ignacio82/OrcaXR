//! Automatic FullSpectrum pairs (`autoPairProjection.ts`,
//! `autoPairReconciliation.ts`): the stable-ID projection of the pinned
//! `MixedFilamentManager::auto_generate` and the project-model adapter that
//! rebuilds the mixed-filament list from it.
//!
//! Every unordered pair of physical filaments has one base row, keyed by the
//! pair's stable IDs and emitted in the current physical order; rows that no
//! longer name a current pair are dropped, a deleted custom row of automatic
//! origin is a tombstone that keeps its pair from regenerating, and only a
//! genuinely absent pair asks the host for a fresh identity.
use crate::{
    ids::{MixedFilamentId, PhysicalFilamentId},
    model::{Decode, Encode, Filaments, List, MixedFilament, PhysicalFilament, Text},
};
use orcaxr_contracts::canonical::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

/// `MAX_AUTHORING_PHYSICAL_TOOL_ID`: the pinned engine's physical filament limit.
pub const MAX_PHYSICAL: usize = 64;

/// `FullSpectrumAutoPairProjectionRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: MixedFilamentId,
    pub component_a: PhysicalFilamentId,
    pub component_b: PhysicalFilamentId,
    /// Unsigned, non-zero uint64 text persisted by the pinned manager.
    pub upstream_stable_id: Vec<u16>,
    pub enabled: bool,
    pub deleted: bool,
    pub custom: bool,
    pub origin_auto: bool,
}

/// `FullSpectrumAutoPairAllocationContext`.
#[derive(Debug, Clone, Copy)]
pub struct Allocation<'a> {
    pub component_a: &'a PhysicalFilamentId,
    pub component_b: &'a PhysicalFilamentId,
    /// Zero-based ordinal in the complete current C(N,2) pair order.
    pub pair_ordinal: usize,
}

/// The host's source of fresh identities for genuinely absent pairs: a
/// mixed-filament ID and its upstream stable ID, or the host's failure.
pub type Allocator<'a, E> =
    dyn FnMut(Allocation<'_>) -> Result<(MixedFilamentId, Vec<u16>), E> + 'a;

/// Why a projection or reconciliation was refused, or why the host's
/// allocator could not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error<E> {
    /// `FullSpectrumAutoPairProjectionError`, with the browser's message.
    Projection(Vec<u16>),
    /// The host's allocator failed.
    Allocator(E),
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn concat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn refused<E>(parts: &[&[u16]]) -> Error<E> {
    Error::Projection(concat(parts))
}

/// `fullSpectrumStableNumericId`: FNV-1a 64 of the ID's UTF-8 (a lone
/// surrogate as U+FFFD, like `TextEncoder`), never zero, in decimal.
pub fn stable_numeric_id(id: &[u16]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in String::from_utf16_lossy(id).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (if hash == 0 { 1 } else { hash }).to_string()
}

/// `validateUpstreamStableId`.
fn validate_upstream<E>(value: &[u16]) -> Result<(), Error<E>> {
    let decimal = !value.is_empty()
        && (u16::from(b'1')..=u16::from(b'9')).contains(&value[0])
        && value
            .iter()
            .all(|u| (u16::from(b'0')..=u16::from(b'9')).contains(u));
    if !decimal {
        // `JSON.stringify(value)`.
        let quoted = crate::js_math::convert::json_stringify(&Value::String(value.to_vec()));
        return Err(refused(&[
            &units("Upstream stable ID "),
            &quoted,
            &units(" must be non-zero unsigned decimal text"),
        ]));
    }
    let fits =
        value.len() < 20 || (value.len() == 20 && value <= &units("18446744073709551615")[..]);
    if !fits {
        return Err(refused(&[
            &units("Upstream stable ID "),
            value,
            &units(" exceeds uint64"),
        ]));
    }
    Ok(())
}

/// The pair key: the two IDs in UTF-16 order (`stablePairKey`).
fn pair_key(a: &PhysicalFilamentId, b: &PhysicalFilamentId) -> (Vec<u16>, Vec<u16>) {
    let (a, b) = (a.as_utf16(), b.as_utf16());
    if a < b {
        (a.to_vec(), b.to_vec())
    } else {
        (b.to_vec(), a.to_vec())
    }
}

/// `FullSpectrumAutoPairProjectionResult`, less what the adapter never reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    /// Exactly C(N,2) rows in current physical order, hidden tombstones included.
    pub auto_pair_rows: Vec<Row>,
    /// Valid custom rows not consumed as the sole tombstone of a base slot.
    pub custom_rows: Vec<Row>,
    pub created: Vec<MixedFilamentId>,
    /// Invalid or out-of-library rows and duplicate non-custom rows.
    pub dropped: Vec<MixedFilamentId>,
}

/// `regenerateFullSpectrumAutoPairs`. `allocate` answers a fresh identity
/// (mixed ID, upstream stable ID) for a genuinely absent pair. IDs are typed,
/// so the browser's stable-text checks hold by construction.
pub fn regenerate<E>(
    physical: &[PhysicalFilamentId],
    existing: &[Row],
    allocate: &mut Allocator<'_, E>,
) -> Result<Projection, Error<E>> {
    if physical.len() > MAX_PHYSICAL {
        return Err(refused(&[&units(&format!(
            "The pinned engine supports at most {MAX_PHYSICAL} physical filaments"
        ))]));
    }
    let mut seen = BTreeSet::new();
    for id in physical {
        if !seen.insert(id.as_utf16()) {
            return Err(refused(&[
                &units("Duplicate physical filament ID "),
                id.as_utf16(),
            ]));
        }
    }
    let mut used_rows: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut used_upstream: BTreeSet<Vec<u16>> = BTreeSet::new();
    for row in existing {
        if !used_rows.insert(row.id.as_utf16().to_vec()) {
            return Err(refused(&[
                &units("Duplicate mixed filament ID "),
                row.id.as_utf16(),
            ]));
        }
        validate_upstream(&row.upstream_stable_id)?;
        if !used_upstream.insert(row.upstream_stable_id.clone()) {
            return Err(refused(&[
                &units("Duplicate upstream mixed-filament stable ID "),
                &row.upstream_stable_id,
            ]));
        }
    }

    let mut dropped = Vec::new();
    let mut base_by_pair: BTreeMap<(Vec<u16>, Vec<u16>), &Row> = BTreeMap::new();
    let mut custom_in_order: Vec<&Row> = Vec::new();
    let mut tombstones: BTreeMap<(Vec<u16>, Vec<u16>), Vec<&Row>> = BTreeMap::new();
    for row in existing {
        let current = row.component_a != row.component_b
            && seen.contains(row.component_a.as_utf16())
            && seen.contains(row.component_b.as_utf16());
        if !current {
            dropped.push(row.id.clone());
            continue;
        }
        let key = pair_key(&row.component_a, &row.component_b);
        if row.custom {
            custom_in_order.push(row);
            if row.origin_auto && row.deleted {
                tombstones.entry(key).or_default().push(row);
            }
            continue;
        }
        if base_by_pair.contains_key(&key) {
            dropped.push(row.id.clone());
            continue;
        }
        base_by_pair.insert(key, row);
    }

    let mut created = Vec::new();
    let mut auto_pair_rows = Vec::new();
    let mut consumed: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut pair_ordinal = 0;
    for (first, a) in physical.iter().enumerate() {
        for b in &physical[first + 1..] {
            let key = pair_key(a, b);
            let origin = tombstones.get(&key).map_or(&[][..], Vec::as_slice);
            if let Some(base) = base_by_pair.get(&key) {
                let suppressed = !origin.is_empty();
                auto_pair_rows.push(Row {
                    component_a: a.clone(),
                    component_b: b.clone(),
                    enabled: if suppressed || base.deleted {
                        false
                    } else {
                        base.enabled
                    },
                    deleted: suppressed || base.deleted,
                    custom: false,
                    origin_auto: true,
                    ..(*base).clone()
                });
            } else if let Some(blocker) = origin.first() {
                consumed.insert(blocker.id.as_utf16().to_vec());
                auto_pair_rows.push(Row {
                    enabled: false,
                    deleted: true,
                    ..(*blocker).clone()
                });
            } else {
                let (id, upstream) = allocate(Allocation {
                    component_a: a,
                    component_b: b,
                    pair_ordinal,
                })
                .map_err(Error::Allocator)?;
                validate_upstream(&upstream)?;
                if used_rows.contains(id.as_utf16()) {
                    return Err(refused(&[
                        &units("The auto-pair allocator reused mixed filament ID "),
                        id.as_utf16(),
                    ]));
                }
                if used_upstream.contains(&upstream) {
                    return Err(refused(&[
                        &units("The auto-pair allocator reused upstream stable ID "),
                        &upstream,
                    ]));
                }
                used_rows.insert(id.as_utf16().to_vec());
                used_upstream.insert(upstream.clone());
                created.push(id.clone());
                auto_pair_rows.push(Row {
                    id,
                    component_a: a.clone(),
                    component_b: b.clone(),
                    upstream_stable_id: upstream,
                    enabled: true,
                    deleted: false,
                    custom: false,
                    origin_auto: true,
                });
            }
            pair_ordinal += 1;
        }
    }
    let custom_rows = custom_in_order
        .into_iter()
        .filter(|row| !consumed.contains(row.id.as_utf16()))
        .map(|row| Row {
            enabled: if row.deleted { false } else { row.enabled },
            ..row.clone()
        })
        .collect();
    Ok(Projection {
        auto_pair_rows,
        custom_rows,
        created,
        dropped,
    })
}

/// `FullSpectrumAutoPairReconciliation`.
#[derive(Debug, Clone)]
pub struct Reconciliation {
    pub filaments: List<Arc<MixedFilament>>,
    pub changed: bool,
    pub created: Vec<MixedFilamentId>,
    pub dropped: Vec<MixedFilamentId>,
}

fn number(value: f64) -> Value {
    Value::Number(value)
}
fn field(name: &str, value: Value) -> (Vec<u16>, Value) {
    (units(name), value)
}
fn id_value(id: &[u16]) -> Value {
    Value::String(id.to_vec())
}

/// `buildPinnedAutoPair`: the pinned manager's default 1:1 Simple row. An
/// existing row keeps its name, configuration and extension data.
fn pinned_pair(
    row: &Row,
    physical_by_id: &BTreeMap<&[u16], &PhysicalFilament>,
    existing: Option<&MixedFilament>,
) -> Result<MixedFilament, String> {
    let a = physical_by_id
        .get(row.component_a.as_utf16())
        .ok_or("Auto-pair projection references a missing physical filament")?;
    let b = physical_by_id
        .get(row.component_b.as_utf16())
        .ok_or("Auto-pair projection references a missing physical filament")?;
    let name = match existing {
        Some(existing) => existing.name.units().to_vec(),
        None => concat(&[
            &units("Mixed Filament "),
            a.name.units(),
            &units(" + "),
            b.name.units(),
        ]),
    };
    let display = super::pigment::blend_pair(a.color.units(), b.color.units(), 0.5);
    let component = |id: &PhysicalFilamentId| {
        Value::Object(BTreeMap::from([
            field("filamentId", id_value(id.as_utf16())),
            field("weight", number(50.0)),
        ]))
    };
    let recipe = BTreeMap::from([
        field("schemaVersion", number(1.0)),
        field(
            "upstreamStableId",
            Value::String(row.upstream_stable_id.clone()),
        ),
        field("uiMode", number(-1.0)),
        field("componentAId", id_value(a.id.as_utf16())),
        field("componentBId", id_value(b.id.as_utf16())),
        field("ratioA", number(1.0)),
        field("ratioB", number(1.0)),
        field("mixBPercent", number(50.0)),
        field("manualPatternGroups", Value::Array(Vec::new())),
        field("gradientComponentIds", Value::Array(Vec::new())),
        field("gradientComponentWeights", Value::Array(Vec::new())),
        field("pointillismAllFilaments", Value::Bool(false)),
        field("distributionMode", number(2.0)),
        field("localZMaxSublayers", number(0.0)),
        field("gradientEnabled", Value::Bool(false)),
        field("gradientStart", number(0.8)),
        field("gradientEnd", number(0.2)),
        field("componentASurfaceOffsetMm", number(0.0)),
        field("componentBSurfaceOffsetMm", number(0.0)),
        field("deleted", Value::Bool(row.deleted)),
        field("custom", Value::Bool(false)),
        field("originAuto", Value::Bool(true)),
    ]);
    let config = match existing {
        Some(existing) => existing.config.value().clone(),
        None => Value::Object(BTreeMap::new()),
    };
    let mut fields = BTreeMap::from([
        field("id", id_value(row.id.as_utf16())),
        field("name", Value::String(name)),
        field("displayColor", Value::String(units(&display))),
        field(
            "components",
            Value::Array(vec![component(&a.id), component(&b.id)]),
        ),
        field(
            "distribution",
            Value::Object(BTreeMap::from([field(
                "mode",
                Value::String(units("ratio")),
            )])),
        ),
        field("fullSpectrum", Value::Object(recipe)),
        field("config", config),
        field("enabled", Value::Bool(row.enabled)),
    ]);
    if let Some(data) = existing.and_then(|e| e.extension_data.as_ref()) {
        fields.insert(units("extensionData"), data.value().clone());
    }
    MixedFilament::from_value(Value::Object(fields))
        .map_err(|_| "Auto-pair row is not a project record".into())
}

/// `updateCustomLifecycle`: an exact row keeps all of its data but the
/// lifecycle fields the projection decided.
fn lifecycle(existing: &MixedFilament, row: &Row) -> Result<MixedFilament, String> {
    let mut next = existing.clone();
    let recipe = next
        .full_spectrum
        .as_mut()
        .ok_or("Auto-pair projection references a row without exact FullSpectrum state")?;
    let recipe = Arc::make_mut(recipe);
    next.enabled = row.enabled;
    recipe.component_a_id = row.component_a.clone();
    recipe.component_b_id = row.component_b.clone();
    recipe.upstream_stable_id = Text::new(row.upstream_stable_id.clone());
    recipe.deleted = row.deleted;
    recipe.custom = row.custom;
    recipe.origin_auto = row.origin_auto;
    Ok(next)
}

/// `reconcileFullSpectrumAutoPairFilaments`: the base section rebuilt with
/// the pinned defaults, then the custom rows and the rows without exact
/// FullSpectrum state in their input order. `changed` compares the canonical
/// lists. A failure the browser raises as a plain `Error` (unreachable from a
/// typed, decoded project) is reported as a projection refusal too.
pub fn reconcile<E>(
    filaments: &Filaments,
    allocate: &mut Allocator<'_, E>,
) -> Result<Reconciliation, Error<E>> {
    let physical_ids: Vec<PhysicalFilamentId> =
        filaments.physical.iter().map(|f| f.id.clone()).collect();
    let exact: Vec<Row> = filaments
        .mixed
        .iter()
        .filter_map(|filament| {
            let recipe = filament.full_spectrum.as_ref()?;
            Some(Row {
                id: filament.id.clone(),
                component_a: recipe.component_a_id.clone(),
                component_b: recipe.component_b_id.clone(),
                upstream_stable_id: recipe.upstream_stable_id.units().to_vec(),
                enabled: filament.enabled,
                deleted: recipe.deleted,
                custom: recipe.custom,
                origin_auto: recipe.origin_auto,
            })
        })
        .collect();
    let projection = regenerate(&physical_ids, &exact, allocate)?;
    // `new Map(…)`: the last of duplicate IDs wins.
    let physical_by_id: BTreeMap<&[u16], &PhysicalFilament> = filaments
        .physical
        .iter()
        .map(|f| (f.id.as_utf16(), f.as_ref()))
        .collect();
    let existing_by_id: BTreeMap<&[u16], &MixedFilament> = filaments
        .mixed
        .iter()
        .map(|f| (f.id.as_utf16(), f.as_ref()))
        .collect();
    let exact_existing = |id: &MixedFilamentId| {
        existing_by_id
            .get(id.as_utf16())
            .copied()
            .filter(|f| f.full_spectrum.is_some())
            .ok_or_else(|| "Auto-pair projection references a missing exact filament".to_owned())
    };
    let plain = |message: String| Error::Projection(units(&message));
    let mut projected: BTreeMap<Vec<u16>, Arc<MixedFilament>> = BTreeMap::new();
    let mut auto_rows = Vec::with_capacity(projection.auto_pair_rows.len());
    for row in &projection.auto_pair_rows {
        let existing = existing_by_id.get(row.id.as_utf16()).copied();
        let filament = if row.custom {
            lifecycle(exact_existing(&row.id).map_err(plain)?, row)
        } else {
            pinned_pair(row, &physical_by_id, existing)
        }
        .map_err(plain)?;
        let filament = Arc::new(filament);
        projected.insert(row.id.as_utf16().to_vec(), filament.clone());
        auto_rows.push(filament);
    }
    for row in &projection.custom_rows {
        let filament = lifecycle(exact_existing(&row.id).map_err(plain)?, row).map_err(plain)?;
        projected.insert(row.id.as_utf16().to_vec(), Arc::new(filament));
    }
    let custom_ids: BTreeSet<&[u16]> = projection
        .custom_rows
        .iter()
        .map(|row| row.id.as_utf16())
        .collect();
    let mut next = auto_rows;
    for existing in filaments.mixed.iter() {
        if existing.full_spectrum.is_none() {
            next.push(existing.clone());
        } else if custom_ids.contains(existing.id.as_utf16()) {
            next.push(projected[existing.id.as_utf16()].clone());
        }
    }
    let canonical = |list: &[Arc<MixedFilament>]| -> Vec<u8> {
        let mut out = Vec::new();
        out.push(b'[');
        for (index, filament) in list.iter().enumerate() {
            if index > 0 {
                out.push(b',');
            }
            filament
                .write_json(&mut out)
                .expect("project records encode to memory");
        }
        out.push(b']');
        out
    };
    let changed = canonical(&filaments.mixed) != canonical(&next);
    Ok(Reconciliation {
        filaments: next.into(),
        changed,
        created: projection.created,
        dropped: projection.dropped,
    })
}
