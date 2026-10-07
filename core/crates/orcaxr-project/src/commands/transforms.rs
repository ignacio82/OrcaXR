use super::objects::{instance, instance_mut};
use super::*;
use std::io::{self, Write};

#[derive(Clone)]
struct Change {
    id: InstanceId,
    transform: Transform,
}
impl Encode for Change {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        out.write_all(b"{\"instanceId\":")?;
        self.id.write_json(out)?;
        out.write_all(b",\"transform\":")?;
        self.transform.write_json(out)?;
        out.write_all(b"}")
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Object(
            [
                ("instanceId".encode_utf16().collect(), self.id.to_value()?),
                (
                    "transform".encode_utf16().collect(),
                    self.transform.to_value()?,
                ),
            ]
            .into(),
        ))
    }
}
#[derive(Clone)]
pub(super) struct TransformCommand {
    batch: bool,
    changes: Arc<[Change]>,
    previous: Option<Arc<[Change]>>,
    key: Text,
}
fn transform(v: wire::Transform) -> Result<Transform, PreparationError> {
    fn tuple<const N: usize>(v: Vec<f64>) -> Result<[Number; N], PreparationError> {
        let values = v
            .into_iter()
            .map(|n| Number::new(n).map_err(|_| PreparationError::InvalidIntent))
            .collect::<Result<Vec<_>, _>>()?;
        values
            .try_into()
            .map_err(|_| PreparationError::InvalidIntent)
    }
    Ok(Transform {
        translation_mm: tuple(v.translation_mm)?,
        rotation: tuple(v.rotation)?,
        scale: tuple(v.scale)?,
        extra: ExtraFields::default(),
    })
}
impl TransformCommand {
    pub(super) fn single(v: wire::SetInstanceTransform) -> Result<Self, PreparationError> {
        let id: InstanceId = id(v.instance_id)?;
        // Preserve the legacy delimiter key, including its possible collisions.
        // A single transform permits an empty gesture ID; the batch does not.
        let key = Text::new(
            "set-instance-transform:"
                .encode_utf16()
                .chain(id.as_utf16().iter().copied())
                .chain([b':' as u16])
                .chain(v.gesture_id)
                .collect::<Vec<_>>(),
        );
        Ok(Self {
            batch: false,
            changes: vec![Change {
                id,
                transform: transform(v.transform)?,
            }]
            .into(),
            previous: None,
            key,
        })
    }
    pub(super) fn batch(v: wire::SetInstanceTransforms) -> Result<Self, PreparationError> {
        // The TypeScript adapter converts all stable IDs before construction.
        let mut changes = v
            .changes
            .into_iter()
            .map(|c| {
                Ok(Change {
                    id: id(c.instance_id)?,
                    transform: transform(c.transform)?,
                })
            })
            .collect::<Result<Vec<_>, PreparationError>>()?;
        if changes.is_empty() {
            return Err(PreparationError::Domain(Text::from_utf8(
                "A batch transform requires at least one instance",
            )));
        }
        if v.gesture_id.is_empty() {
            return Err(PreparationError::Domain(Text::from_utf8(
                "A batch transform gesture ID cannot be empty",
            )));
        }
        let mut seen = BTreeSet::new();
        for c in &changes {
            if !seen.insert(c.id.clone()) {
                return Err(PreparationError::Domain(text_parts(
                    "Batch transform contains duplicate instance ",
                    c.id.as_utf16(),
                    "",
                )));
            }
        }
        changes.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        let value = Value::Array(vec![
            Value::String("set-instance-transforms".encode_utf16().collect()),
            Value::String(v.gesture_id),
            Value::Array(
                changes
                    .iter()
                    .map(|c| Value::String(c.id.as_utf16().to_vec()))
                    .collect(),
            ),
        ]);
        let mut key = vec![];
        value
            .write_canonical(&mut key)
            .map_err(|_| PreparationError::InvalidIntent)?;
        let key = Text::from_utf8(
            std::str::from_utf8(&key).map_err(|_| PreparationError::InvalidIntent)?,
        );
        Ok(Self {
            batch: true,
            changes: changes.into(),
            previous: None,
            key,
        })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(&if self.changes.len() == 1 {
            "Transform instance".into()
        } else {
            format!("Transform {} instances", self.changes.len())
        })
    }
    pub(super) fn reason(&self) -> &'static str {
        if self.batch {
            "set-instance-transforms"
        } else {
            "set-instance-transform"
        }
    }
    pub(super) fn key(&self) -> &Text {
        &self.key
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        // Short-circuit in sorted ID order, like Array.every in the authority.
        for c in self.changes.iter() {
            if instance(state, &c.id)?.transform != c.transform {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let mut previous = Vec::with_capacity(self.changes.len());
        for c in self.changes.iter() {
            let instance = instance_mut(&mut state, &c.id)?;
            let mut transform = instance.transform.clone();
            // The existing batch command's cloneTransform copies only known
            // fields, whereas the single command retains imported extras.
            if self.batch {
                transform.extra = ExtraFields::default();
            }
            previous.push(Change {
                id: c.id.clone(),
                transform,
            });
            instance.transform = c.transform.clone();
        }
        context.replace(state, reason, PROJECT)?;
        self.previous = Some(previous.into());
        Ok(())
    }
    pub(super) fn revert<E>(&self, state: &mut ProjectState) -> Result<(), CommandError<E>> {
        let previous = self.previous.as_ref().ok_or_else(|| {
            unapplied(if self.batch {
                "SetInstanceTransformsCommand"
            } else {
                "SetInstanceTransformCommand"
            })
        })?;
        for c in previous.iter() {
            instance_mut(state, &c.id)?.transform = c.transform.clone();
        }
        Ok(())
    }
    pub(super) fn merge(&self, next: &Self) -> Option<Self> {
        if self.batch != next.batch || self.key != next.key {
            return None;
        }
        let mut merged = next.clone();
        merged.previous = self.previous.clone();
        if !self.batch {
            // Legacy single-command key collisions retain the first target ID.
            merged.changes = vec![Change {
                id: self.changes[0].id.clone(),
                transform: next.changes[0].transform.clone(),
            }]
            .into();
        }
        Some(merged)
    }
    pub(super) fn estimate(&self) -> io::Result<u64> {
        if !self.batch {
            return Ok(256);
        }
        Ok(canonical_length(&self.changes)?
            + match &self.previous {
                Some(v) => canonical_length(v)?,
                None => 1,
            })
    }
}
