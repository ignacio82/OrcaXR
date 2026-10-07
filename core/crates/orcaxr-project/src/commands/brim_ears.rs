//! Brim-ear placement (`objects/brimEarCommands.ts`): object-local ear points
//! that reach the engine through `Metadata/brim_ear_points.txt`. The browser's
//! undo quirks are kept: undoing one placement pops the last ear, and undoing a
//! clear that removed nothing publishes no project change.
use super::*;

/// Pinned `GLGizmoBrimEars` head-radius bounds, in millimetres.
const MIN_RADIUS_MM: f64 = 0.1;
const MAX_RADIUS_MM: f64 = 20.0;

#[derive(Clone)]
pub(super) enum BrimEarCommand {
    /// `AddBrimEarCommand`: append one ear; undo pops the last one.
    Add {
        object: ObjectId,
        point: BrimEarPoint,
    },
    /// `AddBrimEarsCommand`: append a detected set as one entry.
    AddMany {
        object: ObjectId,
        points: List<BrimEarPoint>,
        previous: Option<List<BrimEarPoint>>,
    },
    /// `RemoveBrimEarCommand`: remove one ear by index.
    Remove {
        object: ObjectId,
        index: u64,
        removed: Option<(usize, BrimEarPoint)>,
    },
    /// `ClearBrimEarsCommand`: drop every ear on one object.
    Clear {
        object: ObjectId,
        previous: Option<List<BrimEarPoint>>,
    },
}

/// `assertBrimEarPoint`. Three finite coordinates are a wire guarantee.
fn point(ear: wire::BrimEar) -> Result<BrimEarPoint, PreparationError> {
    let radius = ear.head_front_radius_mm;
    if !(MIN_RADIUS_MM..=MAX_RADIUS_MM).contains(&radius) {
        return Err(PreparationError::Domain(Text::from_utf8(
            "A brim ear radius must be between 0.1 and 20 mm",
        )));
    }
    let number = |v: f64| Number::new(v).map_err(|_| PreparationError::InvalidIntent);
    let [x, y, z] = ear.position_mm[..] else {
        return Err(PreparationError::InvalidIntent);
    };
    Ok(BrimEarPoint {
        position_mm: [number(x)?, number(y)?, number(z)?],
        head_front_radius_mm: number(radius)?,
        extra: ExtraFields::default(),
    })
}

impl BrimEarCommand {
    pub(super) fn add(v: wire::AddBrimEar) -> Result<Self, PreparationError> {
        Ok(Self::Add {
            object: id(v.object_id)?,
            point: point(v.ear)?,
        })
    }
    pub(super) fn add_many(v: wire::AddBrimEars) -> Result<Self, PreparationError> {
        let object = id(v.object_id)?;
        if v.ears.is_empty() {
            return Err(PreparationError::Domain(Text::from_utf8(
                "Placing no brim ears is not a change",
            )));
        }
        let points: Vec<BrimEarPoint> = v.ears.into_iter().map(point).collect::<Result<_, _>>()?;
        Ok(Self::AddMany {
            object,
            points: points.into(),
            previous: None,
        })
    }
    pub(super) fn remove(v: wire::RemoveBrimEar) -> Result<Self, PreparationError> {
        Ok(Self::Remove {
            object: id(v.object_id)?,
            index: v.index,
            removed: None,
        })
    }
    pub(super) fn clear(v: wire::ClearBrimEars) -> Result<Self, PreparationError> {
        Ok(Self::Clear {
            object: id(v.object_id)?,
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(match self {
            Self::Add { .. } => "Place brim ear",
            Self::AddMany { .. } => "Place brim ears",
            Self::Remove { .. } => "Remove brim ear",
            Self::Clear { .. } => "Clear brim ears",
        })
    }
    /// Undo publishes under the same reason: the browser has no `revert:` prefix here.
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::Add { .. } => "add-brim-ear",
            Self::AddMany { .. } => "add-brim-ears",
            Self::Remove { .. } => "remove-brim-ear",
            Self::Clear { .. } => "clear-brim-ears",
        }
    }
    fn object(&self) -> &ObjectId {
        match self {
            Self::Add { object, .. }
            | Self::AddMany { object, .. }
            | Self::Remove { object, .. }
            | Self::Clear { object, .. } => object,
        }
    }
    fn locate<E>(&self, state: &ProjectState) -> Result<(usize, usize), CommandError<E>> {
        let object = self.object();
        locate_object(state, object).ok_or_else(|| {
            CommandError::Domain(text_parts("Unknown object ", object.as_utf16(), ""))
        })
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let at = self.locate(&state)?;
        let current = state.plates[at.0].objects[at.1].brim_ears.clone();
        let ears = |list: &Option<List<BrimEarPoint>>| list.as_deref().unwrap_or_default().to_vec();
        let next: Option<List<BrimEarPoint>> = match self {
            Self::Add { point, .. } => {
                let mut next = ears(&current);
                next.push(point.clone());
                Some(next.into())
            }
            Self::AddMany {
                points, previous, ..
            } => {
                *previous = current.clone();
                let mut next = ears(&current);
                next.extend(points.iter().cloned());
                Some(next.into())
            }
            Self::Remove {
                object,
                index,
                removed,
            } => {
                let mut next = ears(&current);
                let position = usize::try_from(*index)
                    .ok()
                    .filter(|i| *i < next.len())
                    .ok_or_else(|| {
                        CommandError::Domain(text_parts(
                            "Object ",
                            object.as_utf16(),
                            &format!(" has no brim ear at index {index}"),
                        ))
                    })?;
                *removed = Some((position, next.remove(position)));
                (!next.is_empty()).then(|| next.into())
            }
            Self::Clear { previous, .. } => {
                *previous = Some(ears(&current).into());
                None
            }
        };
        update_object(&mut state, at, |object| object.brim_ears = next);
        context.replace(state, Text::from_utf8(self.reason()), PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let at = self.locate(&state)?;
        let current = state.plates[at.0].objects[at.1].brim_ears.clone();
        let ears = current.as_deref().unwrap_or_default();
        let next: Option<List<BrimEarPoint>> = match self {
            Self::Add { .. } => {
                let remaining = &ears[..ears.len().saturating_sub(1)];
                (!remaining.is_empty()).then(|| remaining.into())
            }
            Self::AddMany { previous, .. } => previous.clone(),
            Self::Remove { removed, .. } => {
                let Some((index, point)) = removed else {
                    return Ok(());
                };
                let mut next = ears.to_vec();
                next.insert((*index).min(next.len()), point.clone());
                Some(next.into())
            }
            Self::Clear { previous, .. } => match previous {
                Some(previous) if !previous.is_empty() => Some(previous.clone()),
                // Nothing was removed: the browser publishes nothing.
                _ => return Ok(()),
            },
        };
        update_object(&mut state, at, |object| object.brim_ears = next);
        context.replace(state, Text::from_utf8(self.reason()), PROJECT)
    }
}
