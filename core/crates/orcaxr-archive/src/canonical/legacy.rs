//! Persisted-envelope migrations run on private raw JSON before typed decoding.
//! These mirror the browser's dense-root authority and two-pass fuzzy migration.
use super::{Failure, ascii, k};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;
type Object = BTreeMap<Vec<u16>, Value>;
fn object(value: Value) -> Result<Object, Failure> {
    if let Value::Object(v) = value {
        Ok(v)
    } else {
        Err(Failure::Migration)
    }
}
fn text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value,Some(Value::String(v)) if v.iter().copied().eq(expected.encode_utf16()))
}
fn record<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn string(value: &str) -> Value {
    Value::String(value.encode_utf16().collect())
}
fn take(fields: &mut Object, key: &[u16]) -> Result<Value, Failure> {
    fields.remove(key).ok_or(Failure::Migration)
}
fn normalize(value: Value, cancelled: &mut impl FnMut() -> bool) -> Result<Value, Failure> {
    if cancelled() {
        return Err(Failure::Cancelled);
    }
    let mut node = object(value)?;
    if text(node.get(k!("kind")), "leaf") {
        let mut state = object(take(&mut node, k!("state"))?)?;
        let state = if text(state.get(k!("kind")), "unpainted") {
            record([("kind", string("unpainted"))])
        } else {
            record([
                ("kind", string("assigned")),
                ("value", take(&mut state, k!("value"))?),
            ])
        };
        return Ok(record([("kind", string("leaf")), ("state", state)]));
    }
    let Value::Array(children) = take(&mut node, k!("children"))? else {
        return Err(Failure::Migration);
    };
    let mut children = children
        .into_iter()
        .map(|v| normalize(v, cancelled))
        .collect::<Result<Vec<_>, _>>()?;
    if children.first().is_some_and(|first| {
        let Value::Object(first) = first else {
            return false;
        };
        text(first.get(k!("kind")), "leaf") && children.iter().all(|child| child == &children[0])
    }) {
        return Ok(children.remove(0));
    }
    Ok(record([
        ("kind", string("split")),
        ("splitSides", take(&mut node, k!("splitSides"))?),
        ("specialSide", take(&mut node, k!("specialSide"))?),
        ("children", Value::Array(children)),
    ]))
}
fn collapse(
    roots: Vec<Value>,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(Value, Option<Value>), Failure> {
    let length = roots.len();
    let mut groups = BTreeMap::<Vec<u16>, (Value, Vec<Value>)>::new();
    let mut splits = Vec::new();
    for (index, root) in roots.into_iter().enumerate() {
        let normalized = normalize(root, cancelled)?;
        let Value::Object(mut fields) = normalized else {
            unreachable!();
        };
        if text(fields.get(k!("kind")), "split") {
            splits.push(record([
                ("triangle", Value::Number(index as f64)),
                ("node", Value::Object(fields)),
            ]));
        } else {
            let mut state = object(take(&mut fields, k!("state"))?)?;
            if text(state.get(k!("kind")), "assigned") {
                let value = take(&mut state, k!("value"))?;
                let mut bytes = Vec::new();
                value
                    .write_canonical(&mut bytes)
                    .map_err(|_| Failure::Migration)?;
                let key = String::from_utf8(bytes)
                    .map_err(|_| Failure::Migration)?
                    .encode_utf16()
                    .collect();
                groups
                    .entry(key)
                    .or_insert_with(|| (value, Vec::new()))
                    .1
                    .push(Value::Number(index as f64));
            }
        }
    }
    let assignments = Value::Array(
        groups
            .into_values()
            .map(|(value, triangles)| {
                record([("value", value), ("triangles", Value::Array(triangles))])
            })
            .collect(),
    );
    let encoding = (!splits.is_empty()).then(|| {
        record([
            ("version", Value::Number(2.0)),
            ("triangleCount", Value::Number(length as f64)),
            ("splits", Value::Array(splits)),
        ])
    });
    Ok((assignments, encoding))
}
fn annotations(
    state: &mut Value,
    mut visit: impl FnMut(&mut Object) -> Result<(), Failure>,
) -> Result<(), Failure> {
    let Some(Value::Array(plates)) = field_mut(state, k!("plates")) else {
        return Ok(());
    };
    for plate in plates {
        let Some(Value::Array(objects)) = field_mut(plate, k!("objects")) else {
            continue;
        };
        for object in objects {
            let Some(Value::Array(volumes)) = field_mut(object, k!("volumes")) else {
                continue;
            };
            for volume in volumes {
                if let Some(Value::Object(value)) = field_mut(volume, k!("annotations")) {
                    visit(value)?;
                }
            }
        }
    }
    Ok(())
}
fn field_mut<'a>(value: &'a mut Value, key: &[u16]) -> Option<&'a mut Value> {
    if let Value::Object(v) = value {
        v.get_mut(key)
    } else {
        None
    }
}
pub(super) fn dense(
    state: &mut Value,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<usize, Failure> {
    let mut count = 0;
    annotations(state, |annotations| {
        if cancelled() {
            return Err(Failure::Cancelled);
        }
        let Some(Value::Object(refinement)) = annotations.get(k!("refinement")) else {
            return Ok(());
        };
        let channels = refinement.keys().cloned().collect::<Vec<_>>();
        for channel in channels {
            let Some(Value::Object(refinement)) = annotations.get_mut(k!("refinement")) else {
                unreachable!();
            };
            let Some(Value::Object(encoding)) = refinement.get_mut(&channel) else {
                continue;
            };
            if !matches!(encoding.get(k!("roots")), Some(Value::Array(_))) {
                continue;
            }
            let Value::Array(roots) = encoding.remove(k!("roots")).unwrap() else {
                unreachable!();
            };
            let (assignments, encoding) = collapse(roots, cancelled)?;
            if let Some(encoding) = encoding {
                refinement.insert(channel.clone(), encoding);
            } else {
                refinement.remove(&channel);
            }
            annotations.insert(channel, assignments);
            count += 1;
        }
        if matches!(annotations.get(k!("refinement")),Some(Value::Object(v)) if v.is_empty()) {
            annotations.remove(k!("refinement"));
        }
        Ok(())
    })?;
    Ok(count)
}
/// Temporarily coerce legacy false assignments for validation without allowing
/// invalid triangle indices/references to disappear during the later removal.
pub(super) fn coerce_false(
    state: &mut Value,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Vec<(usize, usize)>, Failure> {
    let mut found = Vec::new();
    let mut ordinal = 0;
    annotations(state, |annotations| {
        if cancelled() {
            return Err(Failure::Cancelled);
        }
        if let Some(Value::Array(assignments)) = annotations.get_mut(k!("fuzzySkin")) {
            for (index, assignment) in assignments.iter_mut().enumerate() {
                if cancelled() {
                    return Err(Failure::Cancelled);
                }
                if let Some(value @ Value::Bool(false)) = field_mut(assignment, k!("value")) {
                    *value = Value::Bool(true);
                    found.push((ordinal, index));
                }
            }
        }
        ordinal += 1;
        Ok(())
    })?;
    Ok(found)
}
pub(super) fn remove_false(
    state: &mut orcaxr_project::model::ProjectState,
    found: &[(usize, usize)],
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(), Failure> {
    use orcaxr_project::model::{Assignments, Decode};
    use std::sync::Arc;
    let mut ordinal = 0;
    let mut next = 0;
    // The earlier typed admission proves every volume has one annotations record.
    for plate in Arc::make_mut(&mut state.plates) {
        for object in Arc::make_mut(&mut Arc::make_mut(plate).objects) {
            for volume in Arc::make_mut(&mut Arc::make_mut(object).volumes) {
                if cancelled() {
                    return Err(Failure::Cancelled);
                }
                if found.get(next).is_some_and(|(o, _)| *o == ordinal) {
                    let annotations = Arc::make_mut(&mut Arc::make_mut(volume).annotations);
                    let Value::Array(entries) = annotations.fuzzy_skin.value() else {
                        unreachable!();
                    };
                    let mut kept = Vec::new();
                    for (index, entry) in entries.iter().enumerate() {
                        if cancelled() {
                            return Err(Failure::Cancelled);
                        }
                        if found.get(next) == Some(&(ordinal, index)) {
                            next += 1;
                        } else {
                            kept.push(entry.clone());
                        }
                    }
                    annotations.fuzzy_skin = Assignments::from_value(Value::Array(kept))
                        .map_err(|_| Failure::Migration)?;
                }
                ordinal += 1;
            }
        }
    }
    Ok(())
}
