//! Owned command execution, bounded history and post-commit effects. Commands
//! are trusted Rust values; no callback or renderer crosses a host boundary.
use crate::{assets::*, model::*, selection::*, store::*, validation::*};
use std::{fmt, sync::Arc};

pub enum CommandError<E> {
    Domain(Text),
    Admission(AdmissionError<E>),
    Asset(AssetError),
    Capacity,
    Encoding,
}
impl<E> CommandError<E> {
    pub fn domain(message: impl AsRef<str>) -> Self {
        Self::Domain(Text::from_utf8(message.as_ref()))
    }
    pub fn user_message(&self) -> Text {
        match self {
            Self::Domain(message) => message.clone(),
            Self::Admission(AdmissionError::Invalid(report)) => report.user_message(),
            Self::Admission(AdmissionError::Timestamp(_)) => {
                Text::from_utf8("Timestamp validation service failed")
            }
            Self::Asset(error) => Text::from_utf8(&error.to_string()),
            Self::Capacity => Text::from_utf8("Project command capacity exhausted"),
            Self::Encoding => Text::from_utf8("Project canonical encoding failed"),
        }
    }
}
impl<E> fmt::Debug for CommandError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Domain(_) => f.write_str("CommandDomainError"),
            Self::Admission(e) => fmt::Debug::fmt(e, f),
            Self::Asset(e) => fmt::Debug::fmt(e, f),
            Self::Capacity => f.write_str("CommandCapacityError"),
            Self::Encoding => f.write_str("CommandEncodingError"),
        }
    }
}
impl<E> fmt::Display for CommandError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl<E> std::error::Error for CommandError<E> {}

#[derive(Debug, Clone, PartialEq)]
pub struct HistorySnapshot {
    pub undo_count: usize,
    pub redo_count: usize,
    pub undo_label: Option<Text>,
    pub redo_label: Option<Text>,
    pub dirty_categories: Arc<[DirtyCategory]>,
}
#[derive(Debug, Clone)]
pub enum DomainEvent {
    Project(ProjectChange),
    Selection(SelectionChange),
    History {
        previous: HistorySnapshot,
        current: HistorySnapshot,
    },
}
/// Failures can carry rollback events. The session must consume them even when
/// the command result is an error; delivery can never retract publication.
#[must_use]
pub struct CommandOutcome<E> {
    pub result: Result<bool, CommandError<E>>,
    pub events: Vec<DomainEvent>,
}

pub struct CommandContext<'a, P> {
    project: &'a mut ProjectStore,
    selection: &'a mut SelectionStore,
    assets: &'a mut AssetRepository,
    timestamps: &'a mut P,
    events: &'a mut Vec<DomainEvent>,
    remaining_publications: u64,
}
impl<P: TimestampPolicy> CommandContext<'_, P> {
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.project.snapshot()
    }
    pub fn selection(&self) -> SelectionSnapshot {
        self.selection.snapshot()
    }
    pub fn assets(&self) -> &AssetRepository {
        self.assets
    }
    pub fn assets_mut(&mut self) -> &mut AssetRepository {
        self.assets
    }
    pub fn replace(
        &mut self,
        candidate: ProjectState,
        reason: Text,
        categories: &[DirtyCategory],
    ) -> Result<(), CommandError<P::Error>> {
        let admitted = self.admit(candidate)?;
        self.replace_validated(admitted, reason, categories)
    }
    /// Graph-validate a candidate without publishing it (the browser's
    /// `assertValidProjectState` on a command's next state).
    pub fn admit(
        &mut self,
        candidate: ProjectState,
    ) -> Result<ValidatedProject, CommandError<P::Error>> {
        let data = ProjectData::new(candidate).map_err(|_| CommandError::Encoding)?;
        ValidatedProject::new(data, self.timestamps).map_err(CommandError::Admission)
    }
    pub fn replace_validated(
        &mut self,
        project: ValidatedProject,
        reason: Text,
        categories: &[DirtyCategory],
    ) -> Result<(), CommandError<P::Error>> {
        if self.remaining_publications == 0 {
            return Err(CommandError::Capacity);
        }
        let change = self
            .project
            .replace_validated(
                project,
                ReplaceOptions {
                    reason: Some(reason),
                    dirty_categories: Some(categories.into()),
                },
            )
            .map_err(|_| CommandError::Capacity)?;
        self.remaining_publications -= 1;
        self.events.push(DomainEvent::Project(change));
        Ok(())
    }
    pub fn set_selection(
        &mut self,
        refs: &[SelectionRef],
        primary: Option<SelectionRef>,
    ) -> Result<(), CommandError<P::Error>> {
        let change = self
            .selection
            .set(refs, primary)
            .map_err(|e| CommandError::domain(e.to_string()))?;
        self.record_selection(change);
        Ok(())
    }
    pub fn clear_selection(&mut self) {
        let c = self.selection.clear();
        self.record_selection(c);
    }
    pub fn prune_selection(&mut self) {
        let c = self.selection.prune(self.project.snapshot().state());
        self.record_selection(c);
    }
    fn record_selection(&mut self, change: Option<SelectionChange>) {
        if let Some(c) = change {
            self.events.push(DomainEvent::Selection(c));
        }
    }
}

/// Bounds are enforced by the context, leaving the bus's rollback reservation
/// intact even if a command attempts more publications than it declared.
pub trait ProjectCommand<P: TimestampPolicy>: Clone {
    fn label(&self) -> &Text;
    fn dirty_categories(&self) -> &[DirtyCategory];
    fn publication_bound(&self) -> u64 {
        1
    }
    /// May validate a candidate (hence the mutable context) and may record
    /// state the command must reuse on apply and redo.
    fn is_noop(
        &mut self,
        _context: &mut CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        Ok(false)
    }
    fn apply(&mut self, context: &mut CommandContext<'_, P>) -> Result<(), CommandError<P::Error>>;
    fn revert(&mut self, context: &mut CommandContext<'_, P>)
    -> Result<(), CommandError<P::Error>>;
    fn coalesce_key(&self) -> Option<&Text> {
        None
    }
    fn merge_with(&self, _next: &Self) -> Result<Option<Self>, CommandError<P::Error>> {
        Ok(None)
    }
    fn estimate_bytes(&self) -> Result<u64, CommandError<P::Error>> {
        Ok(1)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HistoryOptions {
    pub max_entries: usize,
    pub max_estimated_bytes: u64,
}
impl Default for HistoryOptions {
    fn default() -> Self {
        Self {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        }
    }
}
#[derive(Clone)]
struct Entry<C> {
    commands: Vec<C>,
    label: Text,
    composite: bool,
    before_selection: SelectionSnapshot,
    after_selection: SelectionSnapshot,
    before_dirty: [u64; 3],
    after_dirty: [u64; 3],
    estimated_bytes: u128,
}
struct AtomicSnapshot {
    project: ValidatedProject,
    selection: SelectionSnapshot,
    assets: AssetSnapshot,
}
pub struct CommandBus<C, P> {
    project: ProjectStore,
    selection: SelectionStore,
    assets: AssetRepository,
    timestamps: P,
    options: HistoryOptions,
    undo: Vec<Entry<C>>,
    redo: Vec<Entry<C>>,
    dirty: [u64; 3],
    checkpoint: [u64; 3],
    token_clock: u64,
    history_revision: u64,
}
impl<C: ProjectCommand<P>, P: TimestampPolicy> CommandBus<C, P> {
    pub fn new(
        project: ProjectStore,
        selection: SelectionStore,
        assets: AssetRepository,
        timestamps: P,
        options: HistoryOptions,
    ) -> Self {
        Self {
            project,
            selection,
            assets,
            timestamps,
            options: HistoryOptions {
                max_entries: options.max_entries.max(1),
                max_estimated_bytes: options.max_estimated_bytes.max(1),
            },
            undo: vec![],
            redo: vec![],
            dirty: [0; 3],
            checkpoint: [0; 3],
            token_clock: 0,
            history_revision: 0,
        }
    }
    pub fn snapshot(&self) -> ProjectSnapshot {
        self.project.snapshot()
    }
    pub fn selection(&self) -> SelectionSnapshot {
        self.selection.snapshot()
    }
    pub fn assets(&self) -> &AssetRepository {
        &self.assets
    }
    pub fn history_revision(&self) -> u64 {
        self.history_revision
    }
    pub fn history(&self) -> HistorySnapshot {
        HistorySnapshot {
            undo_count: self.undo.len(),
            redo_count: self.redo.len(),
            undo_label: self.undo.last().map(|e| e.label.clone()),
            redo_label: self.redo.last().map(|e| e.label.clone()),
            dirty_categories: categories()
                .into_iter()
                .enumerate()
                .filter(|(i, _)| self.dirty[*i] != self.checkpoint[*i])
                .map(|(_, c)| c)
                .collect::<Vec<_>>()
                .into(),
        }
    }
    pub fn set_selection(
        &mut self,
        refs: &[SelectionRef],
        primary: Option<SelectionRef>,
    ) -> Result<Option<SelectionChange>, InvalidPrimary> {
        self.selection.set(refs, primary)
    }
    pub fn execute(&mut self, command: C, coalesce: bool) -> CommandOutcome<P::Error> {
        let mut events = vec![];
        let result = (|| {
            self.preflight(std::slice::from_ref(&command), 1, true)?;
            let before = self.history();
            let atomic = self.capture();
            let Some(entry) = self.apply_one(command, &mut events)? else {
                return Ok(false);
            };
            let merged = if coalesce && self.redo.is_empty() {
                match self.undo.last().filter(|p| {
                    !p.composite
                        && p.commands[0].coalesce_key().is_some_and(|k| {
                            !k.units().is_empty() && Some(k) == entry.commands[0].coalesce_key()
                        })
                }) {
                    Some(previous) => previous.commands[0].merge_with(&entry.commands[0]),
                    None => Ok(None),
                }
            } else {
                Ok(None)
            };
            let merged = match merged {
                Ok(value) => value,
                Err(error) => {
                    self.dirty = entry.before_dirty;
                    self.restore(atomic, "command-apply-rollback", &mut events);
                    return Err(error);
                }
            };
            if let Some(command) = merged {
                match command.estimate_bytes() {
                    Ok(bytes) => {
                        let previous = self.undo.last_mut().unwrap();
                        previous.label = command.label().clone();
                        previous.commands = vec![command];
                        previous.after_selection = entry.after_selection;
                        previous.after_dirty = entry.after_dirty;
                        previous.estimated_bytes = u128::from(bytes.max(1));
                        self.trim();
                    }
                    Err(error) => {
                        self.dirty = entry.before_dirty;
                        self.restore(atomic, "command-apply-rollback", &mut events);
                        return Err(error);
                    }
                }
            } else {
                self.push(entry);
            }
            self.emit_history(before, true, &mut events);
            Ok(true)
        })();
        CommandOutcome { result, events }
    }
    /// Execute already-owned local commands as one history entry. Resource and
    /// label limits belong to the admitting host/protocol, not domain history:
    /// a staged bed fill can exceed the small wire batch's 64 commands. Counter
    /// capacity and rollback publications are still reserved before any edit.
    pub fn execute_batch(&mut self, label: Text, commands: Vec<C>) -> CommandOutcome<P::Error> {
        let mut events = vec![];
        let result = (|| {
            if commands.is_empty() {
                return Ok(false);
            }
            self.preflight(&commands, 2, true)?;
            let before_history = self.history();
            let before_dirty = self.dirty;
            let atomic = self.capture();
            let mut applied = vec![];
            for command in commands {
                match self.apply_one(command, &mut events) {
                    Ok(Some(entry)) => {
                        applied.extend(entry.commands);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        self.restore(atomic, "transaction-rollback", &mut events);
                        self.dirty = before_dirty;
                        return Err(error);
                    }
                }
            }
            let changed = !applied.is_empty();
            let mut bytes = 0u128;
            for command in &applied {
                match command.estimate_bytes() {
                    Ok(size) => bytes += u128::from(size.max(1)),
                    Err(error) => {
                        self.restore(atomic, "transaction-rollback", &mut events);
                        self.dirty = before_dirty;
                        return Err(error);
                    }
                }
            }
            if changed {
                self.push(Entry {
                    commands: applied,
                    label,
                    composite: true,
                    before_selection: atomic.selection,
                    after_selection: self.selection.snapshot(),
                    before_dirty,
                    after_dirty: self.dirty,
                    estimated_bytes: bytes.max(1),
                });
            }
            self.emit_history(before_history, changed, &mut events);
            Ok(changed)
        })();
        CommandOutcome { result, events }
    }
    pub fn undo(&mut self) -> CommandOutcome<P::Error> {
        self.replay(false)
    }
    pub fn redo(&mut self) -> CommandOutcome<P::Error> {
        self.replay(true)
    }
    pub fn mark_checkpoint(&mut self) -> CommandOutcome<P::Error> {
        let mut events = vec![];
        let result = self.ensure_history().map(|_| {
            let before = self.history();
            self.checkpoint = self.dirty;
            self.emit_history(before, true, &mut events);
            true
        });
        CommandOutcome { result, events }
    }
    pub fn clear_history(&mut self, mark_checkpoint: bool) -> CommandOutcome<P::Error> {
        let mut events = vec![];
        let result = self.ensure_history().map(|_| {
            let before = self.history();
            self.undo.clear();
            self.redo.clear();
            if mark_checkpoint {
                self.checkpoint = self.dirty;
            }
            self.emit_history(before, true, &mut events);
            true
        });
        CommandOutcome { result, events }
    }
    /// The session admits the complete immutable bundle before entering here.
    /// All fallible capacity checks precede publication; no timestamp service,
    /// decoder, payload copy or host callback runs during this commit.
    pub(crate) fn adopt_document(
        &mut self,
        project: ValidatedProject,
        assets: AssetRepository,
        reason: Text,
    ) -> Result<Vec<DomainEvent>, CommandError<P::Error>> {
        self.ensure_history()?;
        self.project
            .ensure_revision_capacity(1)
            .map_err(|_| CommandError::Capacity)?;
        let previous = self.history();
        let mut events = Vec::with_capacity(3);
        self.assets.adopt(assets);
        let change = self
            .project
            .replace_validated(
                project,
                ReplaceOptions {
                    reason: Some(reason),
                    dirty_categories: Some(Arc::from([])),
                },
            )
            .expect("document publication capacity preflighted");
        events.push(DomainEvent::Project(change));
        if let Some(change) = self.selection.clear() {
            events.push(DomainEvent::Selection(change));
        }
        self.undo.clear();
        self.redo.clear();
        self.checkpoint = self.dirty;
        self.emit_history(previous, true, &mut events);
        Ok(events)
    }
    fn replay(&mut self, redo: bool) -> CommandOutcome<P::Error> {
        let mut events = vec![];
        let result = (|| {
            let Some(mut entry) = (if redo {
                self.redo.last()
            } else {
                self.undo.last()
            })
            .cloned() else {
                return Ok(false);
            };
            self.preflight(&entry.commands, 1, false)?;
            let before = self.history();
            let atomic = self.capture();
            let count = entry.commands.len();
            for index in 0..count {
                let command = &mut entry.commands[if redo { index } else { count - 1 - index }];
                let bound = command.publication_bound();
                let mut context = self.context(&mut events, bound);
                let result = if redo {
                    command.apply(&mut context)
                } else {
                    command.revert(&mut context)
                };
                if let Err(error) = result {
                    self.restore(
                        atomic,
                        if redo {
                            "command-redo-rollback"
                        } else {
                            "command-revert-rollback"
                        },
                        &mut events,
                    );
                    return Err(error);
                }
            }
            let c = self.selection.restore(if redo {
                &entry.after_selection
            } else {
                &entry.before_selection
            });
            if let Some(c) = c {
                events.push(DomainEvent::Selection(c));
            }
            self.dirty = if redo {
                entry.after_dirty
            } else {
                entry.before_dirty
            };
            if redo {
                self.redo.pop();
                self.undo.push(entry);
            } else {
                self.undo.pop();
                self.redo.push(entry);
            }
            self.emit_history(before, true, &mut events);
            Ok(true)
        })();
        CommandOutcome { result, events }
    }
    fn apply_one(
        &mut self,
        mut command: C,
        events: &mut Vec<DomainEvent>,
    ) -> Result<Option<Entry<C>>, CommandError<P::Error>> {
        let atomic = self.capture();
        let before_dirty = self.dirty;
        let before_selection = atomic.selection.clone();
        let result = (|| {
            let bound = command.publication_bound();
            let mut context = self.context(events, bound);
            if command.is_noop(&mut context)? {
                return Ok(None);
            }
            command.apply(&mut context)?;
            let mut seen = [false; 3];
            for category in command.dirty_categories() {
                let i = category_index(category);
                if !seen[i] {
                    seen[i] = true;
                    self.token_clock += 1;
                    self.dirty[i] = self.token_clock;
                }
            }
            let estimated_bytes = u128::from(command.estimate_bytes()?.max(1));
            Ok(Some(Entry {
                label: command.label().clone(),
                commands: vec![command],
                composite: false,
                before_selection,
                after_selection: self.selection.snapshot(),
                before_dirty,
                after_dirty: self.dirty,
                estimated_bytes,
            }))
        })();
        if result.is_err() {
            self.dirty = before_dirty;
            self.restore(atomic, "command-apply-rollback", events);
        }
        result
    }
    fn context<'a>(
        &'a mut self,
        events: &'a mut Vec<DomainEvent>,
        remaining_publications: u64,
    ) -> CommandContext<'a, P> {
        CommandContext {
            project: &mut self.project,
            selection: &mut self.selection,
            assets: &mut self.assets,
            timestamps: &mut self.timestamps,
            events,
            remaining_publications,
        }
    }
    fn capture(&self) -> AtomicSnapshot {
        AtomicSnapshot {
            project: self.project.snapshot().project().clone(),
            selection: self.selection.snapshot(),
            assets: self.assets.capture_internal(),
        }
    }
    fn restore(&mut self, atomic: AtomicSnapshot, reason: &str, events: &mut Vec<DomainEvent>) {
        self.assets
            .restore_internal(&atomic.assets)
            .expect("same repository owner");
        let change = self
            .project
            .restore(atomic.project, Some(Text::from_utf8(reason)))
            .expect("rollback capacity was reserved");
        events.push(DomainEvent::Project(change));
        if let Some(c) = self.selection.restore(&atomic.selection) {
            events.push(DomainEvent::Selection(c));
        }
    }
    fn ensure_history(&self) -> Result<(), CommandError<P::Error>> {
        if self.history_revision == MAX_REVISION {
            Err(CommandError::Capacity)
        } else {
            Ok(())
        }
    }
    fn preflight(
        &self,
        commands: &[C],
        rollbacks: u64,
        advance_dirty: bool,
    ) -> Result<(), CommandError<P::Error>> {
        self.ensure_history()?;
        let publications = commands
            .iter()
            .try_fold(rollbacks, |total, c| {
                total.checked_add(c.publication_bound())
            })
            .ok_or(CommandError::Capacity)?;
        self.project
            .ensure_revision_capacity(publications)
            .map_err(|_| CommandError::Capacity)?;
        if advance_dirty && commands.len() as u64 > (MAX_REVISION - self.token_clock) / 3 {
            return Err(CommandError::Capacity);
        }
        Ok(())
    }
    fn push(&mut self, entry: Entry<C>) {
        self.undo.push(entry);
        self.redo.clear();
        self.trim();
    }
    fn trim(&mut self) {
        let mut bytes = self.undo.iter().map(|e| e.estimated_bytes).sum::<u128>();
        while self.undo.len() > self.options.max_entries
            || (bytes > u128::from(self.options.max_estimated_bytes) && self.undo.len() > 1)
        {
            bytes -= self.undo.remove(0).estimated_bytes;
        }
    }
    fn emit_history(
        &mut self,
        previous: HistorySnapshot,
        invalidate: bool,
        events: &mut Vec<DomainEvent>,
    ) {
        let current = self.history();
        let changed = current != previous;
        if invalidate || changed {
            self.history_revision += 1;
        }
        if changed {
            events.push(DomainEvent::History { previous, current });
        }
    }
}
fn categories() -> [DirtyCategory; 3] {
    [
        DirtyCategory::ProjectData,
        DirtyCategory::Presets,
        DirtyCategory::PrinterDevice,
    ]
}
fn category_index(category: &DirtyCategory) -> usize {
    match category {
        DirtyCategory::ProjectData => 0,
        DirtyCategory::Presets => 1,
        DirtyCategory::PrinterDevice => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{PreparedCommand, prepare_intent};
    use orcaxr_contracts::canonical::parse;
    #[test]
    fn history_and_dirty_clocks_refuse_before_overflow_without_publishing() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../testdata/cross-platform/project-command-vectors.json"
        ))
        .unwrap();
        let state = ProjectState::from_value(
            parse(fixture["traces"][0]["stateJson"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let command = prepare_intent(&serde_json::json!({"version":1,"command":{"renamePlate":{"plateId":state.active_plate_id.as_utf16(),"name":[110,101,119]}}}).to_string()).unwrap();
        let mut policy = |_: &[u16]| Ok::<_, ()>(true);
        let project = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
        let mut bus = CommandBus::<PreparedCommand, _>::new(
            project,
            SelectionStore::default(),
            AssetRepository::new(),
            policy,
            HistoryOptions::default(),
        );
        bus.history_revision = MAX_REVISION - 1;
        assert!(bus.mark_checkpoint().result.unwrap());
        for outcome in [
            bus.execute(command.clone(), true),
            bus.mark_checkpoint(),
            bus.clear_history(true),
        ] {
            assert!(matches!(outcome.result, Err(CommandError::Capacity)));
            assert!(outcome.events.is_empty());
        }
        assert_eq!(bus.snapshot().revision(), 0);
        assert_eq!(bus.history_revision(), MAX_REVISION);
        let assets_before = bus.assets().capture_internal();
        assert!(matches!(
            bus.adopt_document(
                bus.snapshot().project().clone(),
                AssetRepository::new(),
                Text::from_utf8("reset-project")
            ),
            Err(CommandError::Capacity)
        ));
        assert_eq!(bus.snapshot().revision(), 0);
        assert!(bus.assets().capture_internal().same_version(&assets_before));
        bus.history_revision = 0;
        bus.token_clock = MAX_REVISION - 3;
        assert!(bus.execute(command.clone(), true).result.unwrap());
        assert_eq!(bus.token_clock, MAX_REVISION - 2);
        let before = bus.snapshot();
        let outcome = bus.execute(command, true);
        assert!(matches!(outcome.result, Err(CommandError::Capacity)));
        assert!(outcome.events.is_empty());
        assert_eq!(bus.snapshot().revision(), before.revision());
        assert!(
            bus.undo().result.unwrap(),
            "undo does not allocate a dirty token"
        );
        assert!(bus.redo().result.unwrap(), "redo restores saved tokens");
    }
}
