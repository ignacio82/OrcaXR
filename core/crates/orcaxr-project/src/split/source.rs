//! What "Split to Objects" and "Split to Parts" would split (`SplitSource.ts`,
//! through `SplitSourceExchange.ts`): the object holding the selected
//! instance, read from the canonical state as the workspace reads it before
//! it splits — the confirmation it shows, and the checks it makes again when
//! it commits — or the workspace's refusal in its own words, in its order:
//!
//! - an instance the project no longer has (worded per split);
//! - an object with no volume, a volume that is not a model, or a volume
//!   below three facets, none of which a split could keep; and, splitting to
//!   objects, which replaces the object, height ranges or object extension
//!   data no promotion distributes (an import's `orcaxr:importSource`
//!   provenance is copied to every object; Split to Parts keeps the object
//!   and all it carries);
//! - a single volume beyond the workspace's synchronous triangle limit
//!   (counts written as `toLocaleString('en-US')` writes them), painted, or
//!   carrying opaque triangle-indexed 3MF metadata;
//! - splitting to parts, an object that already has several.
//!
//! The exchange is canonical JSON over a captured project:
//! `{"instanceId","target","triangleLimit"}` answers `{"source": {...}}` or
//! `{"refusal": message}`.
use crate::commands::has_undistributed_object_extension;
use crate::model::{ProjectObject, ProjectPlate, ProjectState, VolumeRole};
use crate::validation::has_assignments;
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";

const CORE_FACET_ATTRIBUTES_KEY: &str =
    "https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes";

/// Which split reads the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Separate objects (`split_to_objects`).
    Objects,
    /// Parts of the same object (`split_to_parts`).
    Parts,
}

/// How the object splits: its existing volumes promoted, or its one volume
/// separated by connected body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    ExistingVolumes,
    ConnectedComponents,
}

impl Strategy {
    fn name(self) -> &'static str {
        match self {
            Self::ExistingVolumes => "existing-volumes",
            Self::ConnectedComponents => "connected-components",
        }
    }
}

/// The object a split replaces, as the workspace's confirmation describes it.
pub struct Source<'a> {
    pub plate: &'a ProjectPlate,
    pub object: &'a ProjectObject,
    pub strategy: Strategy,
    /// Every volume's triangles, summed in volume order.
    pub triangle_count: f64,
}

fn text(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn u(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

/// A count as `Number.prototype.toLocaleString('en-US')` writes a
/// non-negative safe integer: its digits in groups of three.
fn grouped(value: f64) -> Vec<u16> {
    let digits = format!("{}", value as u64);
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    u(&out)
}

/// `assertSplitSource`: the workspace's refusals before `target`'s split.
/// Both refuse what the volumes would lose; only Split to Objects, which
/// replaces the object, refuses what the object carries and no promotion
/// distributes.
pub fn check_object(
    object: &ProjectObject,
    target: Target,
    triangle_limit: f64,
) -> Result<(), Vec<u16>> {
    if object.volumes.is_empty() {
        return Err(u("Split to Objects requires at least one model volume"));
    }
    if object.volumes.iter().any(|v| v.role != VolumeRole::Model) {
        return Err(u(
            "Split to Objects cannot discard modifier, negative, support-enforcer, or support-blocker volumes",
        ));
    }
    if object
        .volumes
        .iter()
        .any(|v| v.source.triangle_count.get() < 3.0)
    {
        return Err(u(
            "Split to Objects cannot preserve volumes or connected components below three facets",
        ));
    }
    if target == Target::Objects && !object.layer_ranges.is_empty() {
        return Err(u(
            "Split to Objects requires an explicit layer-range distribution before promotion",
        ));
    }
    if target == Target::Objects && has_undistributed_object_extension(object) {
        return Err(u(
            "Split to Objects requires an explicit object-extension distribution before promotion",
        ));
    }
    let [volume] = &object.volumes[..] else {
        return Ok(());
    };
    let triangles = volume.source.triangle_count.get();
    if triangles > triangle_limit {
        return Err(text(&[
            &u("Split to Objects is limited to "),
            &grouped(triangle_limit),
            &u(
                " triangles while connected-component analysis remains synchronous; this model has ",
            ),
            &grouped(triangles),
        ]));
    }
    if has_assignments(&volume.annotations) {
        return Err(u(
            "Split to Objects cannot yet remap painted facet annotations onto connected components; clear or preserve them explicitly first",
        ));
    }
    if volume.extension_data.as_ref().is_some_and(|data| {
        matches!(data.value(), Value::Object(fields) if fields.contains_key(&u(CORE_FACET_ATTRIBUTES_KEY)))
    }) {
        return Err(u(
            "Split to Objects cannot preserve opaque triangle-indexed 3MF extension metadata without an explicit facet map",
        ));
    }
    Ok(())
}

/// `splitSourceOf`: the object instance `instance_id` places, as `target`
/// would split it, or the workspace's refusal.
pub fn source<'a>(
    state: &'a ProjectState,
    instance_id: &[u16],
    target: Target,
    triangle_limit: f64,
) -> Result<Source<'a>, Vec<u16>> {
    let found = state.plates.iter().find_map(|plate| {
        plate.objects.iter().find_map(|object| {
            object
                .instances
                .iter()
                .any(|instance| instance.id.as_utf16() == instance_id)
                .then_some((&**plate, &**object))
        })
    });
    let Some((plate, object)) = found else {
        return Err(match target {
            Target::Objects => text(&[
                &u("Selected instance "),
                instance_id,
                &u(" is no longer in the canonical project"),
            ]),
            Target::Parts => text(&[&u("Selected instance "), instance_id, &u(" not found")]),
        });
    };
    check_object(object, target, triangle_limit)?;
    let volumes = object.volumes.len();
    if target == Target::Parts && volumes != 1 {
        return Err(text(&[
            &u("Object \""),
            object.name.units(),
            &u(&format!("\" already has {volumes} parts")),
        ]));
    }
    Ok(Source {
        plate,
        object,
        strategy: if volumes > 1 {
            Strategy::ExistingVolumes
        } else {
            Strategy::ConnectedComponents
        },
        triangle_count: object
            .volumes
            .iter()
            .fold(0.0, |total, v| total + v.source.triangle_count.get()),
    })
}

fn members(value: Value) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let names = ["instanceId", "target", "triangleLimit"].map(u);
    if fields.len() != names.len() || !names.iter().all(|name| fields.contains_key(name)) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}

fn string(value: &[u16]) -> Value {
    Value::String(value.to_vec())
}

/// `splitSourceExchange`: `{"instanceId","target","triangleLimit"}` →
/// `{"source": {"instanceIds","objectId","objectName","plateId","strategy",
/// "triangleCount","volumeIds"}}` or `{"refusal": message}`, canonical JSON.
pub fn source_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let mut fields = members(parse(request).map_err(|_| INVALID_REQUEST)?)?;
    let Some(Value::String(instance_id)) = fields.remove(&u("instanceId")) else {
        return Err(INVALID_REQUEST);
    };
    let target = match fields.remove(&u("target")) {
        Some(Value::String(name)) if name == u("objects") => Target::Objects,
        Some(Value::String(name)) if name == u("parts") => Target::Parts,
        _ => return Err(INVALID_REQUEST),
    };
    // `Number.isSafeInteger(triangleLimit) && triangleLimit >= 1`.
    let limit = match fields.remove(&u("triangleLimit")) {
        Some(Value::Number(n))
            if n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n) =>
        {
            n
        }
        _ => return Err(INVALID_REQUEST),
    };
    let reply = match source(state, &instance_id, target, limit) {
        Err(message) => Value::Object(BTreeMap::from([(u("refusal"), Value::String(message))])),
        Ok(source) => {
            let object = source.object;
            Value::Object(BTreeMap::from([(
                u("source"),
                Value::Object(BTreeMap::from([
                    (
                        u("instanceIds"),
                        Value::Array(
                            object
                                .instances
                                .iter()
                                .map(|i| string(i.id.as_utf16()))
                                .collect(),
                        ),
                    ),
                    (u("objectId"), string(object.id.as_utf16())),
                    (u("objectName"), string(object.name.units())),
                    (u("plateId"), string(source.plate.id.as_utf16())),
                    (u("strategy"), Value::String(u(source.strategy.name()))),
                    (u("triangleCount"), Value::Number(source.triangle_count)),
                    (
                        u("volumeIds"),
                        Value::Array(
                            object
                                .volumes
                                .iter()
                                .map(|v| string(v.id.as_utf16()))
                                .collect(),
                        ),
                    ),
                ])),
            )]))
        }
    };
    let mut bytes = Vec::new();
    reply
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::grouped;

    #[test]
    fn counts_group_as_en_us_writes_them() {
        let text = |n: f64| String::from_utf16(&grouped(n)).unwrap();
        assert_eq!(text(0.0), "0");
        assert_eq!(text(999.0), "999");
        assert_eq!(text(1000.0), "1,000");
        assert_eq!(text(50_000.0), "50,000");
        assert_eq!(text(1_234_567.0), "1,234,567");
        assert_eq!(text(9_007_199_254_740_991.0), "9,007,199,254,740,991");
    }
}
