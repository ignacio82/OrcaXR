//! Project rename and plate wipe-tower placement (`commands.ts`
//! `RenameProjectCommand`, `SetPlateWipeTowerCommand`).
use super::*;

/// `RenameProjectCommand`: no no-op check, so renaming to the same name is
/// still an undoable entry.
#[derive(Clone)]
pub(super) struct RenameProject {
    name: Text,
    previous: Option<Text>,
}
impl RenameProject {
    pub(super) fn new(v: wire::RenameProject) -> Result<Self, PreparationError> {
        if blank(&v.name) {
            return Err(PreparationError::Domain(Text::from_utf8(
                "Project name cannot be empty",
            )));
        }
        Ok(Self {
            name: Text::new(v.name),
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        text_parts("Rename project to ", self.name.units(), "")
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        self.previous = Some(state.name.clone());
        state.name = self.name.clone();
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self
            .previous
            .clone()
            .ok_or_else(|| unapplied("RenameProjectCommand"))?;
        let mut state = context.snapshot().state().clone();
        state.name = previous;
        context.replace(state, reason, PROJECT)
    }
}

/// `SetPlateWipeTowerCommand`: replace or remove one plate's wipe tower.
#[derive(Clone)]
pub(super) struct PlateWipeTower {
    plate: PlateId,
    next: Option<Arc<WipeTowerState>>,
    label: Text,
    previous: Option<Arc<WipeTowerState>>,
}
impl PlateWipeTower {
    pub(super) fn new(v: wire::SetPlateWipeTower) -> Result<Self, PreparationError> {
        let plate = id(v.plate_id)?;
        let next = match v.wipe_tower {
            wire::OptionalWipeTower::Absent(_) => None,
            wire::OptionalWipeTower::Value(w) => {
                let number = |n: f64| Number::new(n).map_err(|_| PreparationError::InvalidIntent);
                let [x, y] = w.position_mm[..] else {
                    return Err(PreparationError::InvalidIntent);
                };
                Some(Arc::new(WipeTowerState {
                    enabled: w.enabled,
                    position_mm: [number(x)?, number(y)?],
                    rotation_deg: number(w.rotation_deg)?,
                    filament_id: match w.filament_id {
                        wire::OptionalId::Absent(_) => None,
                        wire::OptionalId::Value(units) => Some(id(units)?),
                    },
                    extra: ExtraFields::default(),
                }))
            }
        };
        let label = match v.label {
            wire::OptionalText::Value(label) => Text::new(label),
            wire::OptionalText::Absent(_) => {
                Text::from_utf8(if next.as_ref().is_some_and(|w| w.enabled) {
                    "Auto-place wipe tower"
                } else {
                    "Update wipe tower"
                })
            }
        };
        Ok(Self {
            plate,
            next,
            label,
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        self.label.clone()
    }
    fn locate<E>(&self, state: &ProjectState) -> Result<usize, CommandError<E>> {
        state
            .plates
            .iter()
            .position(|p| p.id == self.plate)
            .ok_or_else(|| unknown(&self.plate))
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        let index = self.locate(state)?;
        Ok(state.plates[index].wipe_tower == self.next)
    }
    fn write<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        tower: Option<Arc<WipeTowerState>>,
        reason: Text,
    ) -> Result<Option<Arc<WipeTowerState>>, CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let index = self.locate(&state)?;
        let mut plates = state.plates.to_vec();
        let previous = std::mem::replace(&mut Arc::make_mut(&mut plates[index]).wipe_tower, tower);
        state.plates = plates.into();
        context.replace(state, reason, PROJECT)?;
        Ok(previous)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        self.previous = self.write(context, self.next.clone(), reason)?;
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        self.write(context, self.previous.clone(), reason)
            .map(|_| ())
    }
}

/// `ReconcileFullSpectrumAutoPairsCommand`: replace the whole mixed-filament
/// list with a reconciled one, guarded like the setting overrides.
#[derive(Clone)]
pub(super) struct ReconcileAutoPairs {
    revision: u64,
    hash: Vec<u16>,
    next: List<Arc<MixedFilament>>,
    label: Text,
    previous: Option<List<Arc<MixedFilament>>>,
}
impl ReconcileAutoPairs {
    pub(super) fn new(v: wire::ReconcileAutoPairs) -> Result<Self, PreparationError> {
        let next = v
            .filaments
            .into_iter()
            .map(|f| super::mixed::mixed_filament(f).map(Arc::new))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            revision: v.guard.source_revision,
            hash: v.guard.source_hash,
            next: next.into(),
            label: match v.label {
                wire::OptionalText::Value(label) => Text::new(label),
                wire::OptionalText::Absent(_) => {
                    Text::from_utf8("Reconcile automatic virtual filaments")
                }
            },
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        self.label.clone()
    }
    fn guard<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let snapshot = context.snapshot();
        if snapshot.revision() != self.revision
            || !self.hash.iter().copied().eq(snapshot.hash().encode_utf16())
        {
            return Err(CommandError::domain(
                "Auto-pair reconciliation was prepared for a stale canonical project revision",
            ));
        }
        Ok(())
    }
    pub(super) fn is_noop<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        self.guard(context)?;
        Ok(context.snapshot().state().filaments.mixed == self.next)
    }
    fn replace_mixed<P: TimestampPolicy>(
        context: &mut CommandContext<'_, P>,
        mixed: List<Arc<MixedFilament>>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let mut filaments = state.filaments.clone();
        filaments.mixed = mixed;
        state.filaments = filaments;
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let current = context.snapshot().state().filaments.mixed.clone();
        match &self.previous {
            None => {
                self.guard(context)?;
                self.previous = Some(current);
            }
            Some(previous) if *previous != current => {
                return Err(CommandError::domain(
                    "Automatic virtual filaments changed after reconciliation was prepared",
                ));
            }
            Some(_) => {}
        }
        Self::replace_mixed(context, self.next.clone(), reason)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self.previous.clone().ok_or_else(|| {
            CommandError::domain("ReconcileFullSpectrumAutoPairsCommand has not been applied")
        })?;
        Self::replace_mixed(context, previous, reason)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        let previous = match &self.previous {
            Some(previous) => duplicate::canonical_length(previous)?,
            None => 1,
        };
        Ok(duplicate::canonical_length(&self.next)? + previous)
    }
}
