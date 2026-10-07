use orcaxr_contracts::canonical::parse;
use orcaxr_project::{assets::*, history::*, model::*, selection::*, store::*, validation::*};
use std::{cell::Cell, rc::Rc};
#[derive(Clone, Copy, PartialEq)]
enum Failure {
    None,
    Noop,
    Apply,
    Revert,
    Estimate,
    Merge,
    MergedEstimate,
    Overpublish,
}
#[derive(Clone)]
struct Command {
    label: Text,
    key: Option<Text>,
    previous: Option<ValidatedProject>,
    categories: Vec<DirtyCategory>,
    failure: Rc<Cell<Failure>>,
    merged: bool,
    noop: bool,
    bytes: u64,
    bound: u64,
    remove_asset: bool,
}
impl Command {
    fn new(name: &str) -> Self {
        Self {
            label: Text::from_utf8(name),
            key: None,
            previous: None,
            categories: vec![DirtyCategory::ProjectData],
            failure: Rc::new(Cell::new(Failure::None)),
            merged: false,
            noop: false,
            bytes: 1,
            bound: 1,
            remove_asset: false,
        }
    }
}
fn failed<E>() -> CommandError<E> {
    CommandError::domain("PRIVATE_COMMAND_ERROR")
}
impl<P: TimestampPolicy> ProjectCommand<P> for Command {
    fn label(&self) -> &Text {
        &self.label
    }
    fn dirty_categories(&self) -> &[DirtyCategory] {
        &self.categories
    }
    fn publication_bound(&self) -> u64 {
        self.bound
    }
    fn coalesce_key(&self) -> Option<&Text> {
        self.key.as_ref()
    }
    fn is_noop(&self, _: &CommandContext<'_, P>) -> Result<bool, CommandError<P::Error>> {
        if self.failure.get() == Failure::Noop {
            Err(failed())
        } else {
            Ok(self.noop)
        }
    }
    fn apply(&mut self, context: &mut CommandContext<'_, P>) -> Result<(), CommandError<P::Error>> {
        let original = context.snapshot();
        self.previous = Some(original.project().clone());
        if self.remove_asset {
            context
                .assets_mut()
                .remove(&original.state().source_assets[0].id);
        }
        context.clear_selection();
        let mut candidate = original.state().clone();
        candidate.name = self.label.clone();
        context.replace(
            candidate,
            Text::from_utf8("fault-command"),
            &self.categories,
        )?;
        if self.failure.get() == Failure::Overpublish {
            context.replace_validated(
                original.project().clone(),
                Text::from_utf8("unreserved"),
                &self.categories,
            )?;
        }
        if self.failure.get() == Failure::Apply {
            return Err(failed());
        }
        Ok(())
    }
    fn revert(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        context.clear_selection();
        let previous = self.previous.clone().unwrap();
        context
            .assets_mut()
            .remove(&previous.state().source_assets[0].id);
        context.replace_validated(previous, Text::from_utf8("revert-fault"), &self.categories)?;
        if self.failure.get() == Failure::Revert {
            return Err(failed());
        }
        Ok(())
    }
    fn merge_with(&self, next: &Self) -> Result<Option<Self>, CommandError<P::Error>> {
        if next.failure.get() == Failure::Merge {
            return Err(failed());
        }
        let mut merged = next.clone();
        merged.previous = self.previous.clone();
        merged.merged = true;
        Ok(Some(merged))
    }
    fn estimate_bytes(&self) -> Result<u64, CommandError<P::Error>> {
        if self.failure.get() == Failure::Estimate
            || (self.merged && self.failure.get() == Failure::MergedEstimate)
        {
            Err(failed())
        } else {
            Ok(self.bytes)
        }
    }
}
fn fixture() -> (
    ProjectStore,
    AssetRepository,
    impl TimestampPolicy<Error = ()>,
) {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-command-vectors.json"
    ))
    .unwrap();
    let trace = &f["traces"][0];
    let state =
        ProjectState::from_value(parse(trace["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    );
    let project = ProjectStore::admit(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(trace["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &trace["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    (project, assets, policy)
}
fn bus(options: HistoryOptions) -> CommandBus<Command, impl TimestampPolicy<Error = ()>> {
    let (project, assets, policy) = fixture();
    let mut selection = SelectionStore::default();
    selection
        .set(
            &[SelectionRef::Plate(
                project.snapshot().state().active_plate_id.clone(),
            )],
            None,
        )
        .unwrap();
    CommandBus::new(project, selection, assets, policy, options)
}
fn reasons(events: &[DomainEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            DomainEvent::Project(c) => Some(String::from_utf16(c.reason().units()).unwrap()),
            _ => None,
        })
        .collect()
}
#[test]
fn failures_restore_assets_selection_graph_history_and_keep_rollback_effects() {
    for failure in [
        Failure::Noop,
        Failure::Apply,
        Failure::Estimate,
        Failure::Overpublish,
    ] {
        let mut bus = bus(HistoryOptions::default());
        let before = bus.snapshot();
        let selected = bus.selection();
        let history = bus.history();
        let asset = bus
            .assets()
            .peek(&before.state().source_assets[0].id)
            .unwrap();
        let mut command = Command::new("changed");
        command.remove_asset = true;
        command.failure.set(failure);
        let outcome = bus.execute(command, true);
        let error = outcome.result.unwrap_err();
        assert!(!format!("{error:?} {error}").contains("PRIVATE"));
        assert!(bus.snapshot().project().same_allocation(before.project()));
        assert_eq!(
            bus.snapshot().revision(),
            if failure == Failure::Noop { 1 } else { 2 }
        );
        assert_eq!(bus.selection(), selected);
        assert_eq!(bus.history(), history);
        assert_eq!(bus.history_revision(), 0);
        assert!(bus.assets().peek(asset.id()).unwrap().same_record(&asset));
        assert_eq!(
            reasons(&outcome.events).last().unwrap(),
            "command-apply-rollback"
        );
        assert!(
            !outcome
                .events
                .iter()
                .any(|e| matches!(e, DomainEvent::History { .. }))
        );
    }
}
#[test]
fn failed_batch_performs_inner_and_outer_rollback_and_restores_start_selection() {
    let mut bus = bus(HistoryOptions::default());
    let before = bus.snapshot();
    let selected = bus.selection();
    let first = Command::new("first");
    let second = Command::new("second");
    second.failure.set(Failure::Apply);
    let outcome = bus.execute_batch(Text::from_utf8("Atomic"), vec![first, second]);
    assert!(outcome.result.is_err());
    assert_eq!(
        reasons(&outcome.events),
        [
            "fault-command",
            "fault-command",
            "command-apply-rollback",
            "transaction-rollback"
        ]
    );
    assert!(bus.snapshot().project().same_allocation(before.project()));
    assert_eq!(bus.snapshot().revision(), 4);
    assert_eq!(bus.selection(), selected);
    assert_eq!(bus.history().undo_count, 0);
    assert!(bus.history().dirty_categories.is_empty());
}
#[test]
fn failed_undo_redo_leave_entries_and_asset_identity_available_for_retry() {
    let mut bus = bus(HistoryOptions::default());
    let command = Command::new("changed");
    let failure = command.failure.clone();
    assert!(bus.execute(command, true).result.unwrap());
    let before = bus.snapshot();
    let history = bus.history();
    let revision = bus.history_revision();
    let asset = bus
        .assets()
        .peek(&before.state().source_assets[0].id)
        .unwrap();
    failure.set(Failure::Revert);
    let outcome = bus.undo();
    assert!(outcome.result.is_err());
    assert_eq!(
        reasons(&outcome.events),
        ["revert-fault", "command-revert-rollback"]
    );
    assert!(bus.snapshot().project().same_allocation(before.project()));
    assert_eq!(bus.history(), history);
    assert_eq!(bus.history_revision(), revision);
    assert!(bus.assets().peek(asset.id()).unwrap().same_record(&asset));
    failure.set(Failure::None);
    assert!(bus.undo().result.unwrap());
    let before = bus.snapshot();
    let history = bus.history();
    let revision = bus.history_revision();
    failure.set(Failure::Apply);
    let outcome = bus.redo();
    assert!(outcome.result.is_err());
    assert_eq!(
        reasons(&outcome.events),
        ["fault-command", "command-redo-rollback"]
    );
    assert!(bus.snapshot().project().same_allocation(before.project()));
    assert_eq!(bus.history(), history);
    assert_eq!(bus.history_revision(), revision);
    failure.set(Failure::None);
    assert!(bus.redo().result.unwrap());
    assert_eq!(bus.snapshot().state().name, Text::from_utf8("changed"));
}
#[test]
fn coalescing_preserves_gesture_start_selection_and_checkpoint_tokens() {
    let mut bus = bus(HistoryOptions::default());
    let original = bus.snapshot();
    let selected = bus.selection();
    let mut first = Command::new("gesture 1");
    first.key = Some(Text::from_utf8("gesture"));
    assert!(bus.execute(first.clone(), true).result.unwrap());
    assert!(bus.mark_checkpoint().result.unwrap());
    let mut next = first;
    next.label = Text::from_utf8("gesture 2");
    assert!(bus.execute(next, true).result.unwrap());
    assert_eq!(bus.history().undo_count, 1);
    assert_eq!(
        bus.history().dirty_categories.as_ref(),
        &[DirtyCategory::ProjectData]
    );
    assert!(bus.undo().result.unwrap());
    assert!(bus.snapshot().project().same_allocation(original.project()));
    assert_eq!(bus.selection(), selected);
    assert!(
        !bus.history().dirty_categories.is_empty(),
        "undo past a mid-gesture checkpoint remains dirty"
    );
    assert!(bus.redo().result.unwrap());
    assert_eq!(bus.snapshot().state().name, Text::from_utf8("gesture 2"));
}
#[test]
fn failed_merge_or_merged_estimate_restores_prior_entry() {
    for failure in [Failure::Merge, Failure::MergedEstimate] {
        let mut bus = bus(HistoryOptions::default());
        let original = bus.snapshot();
        let mut first = Command::new("first");
        first.key = Some(Text::from_utf8("gesture"));
        assert!(bus.execute(first.clone(), true).result.unwrap());
        let before = bus.snapshot();
        let history = bus.history();
        let revision = bus.history_revision();
        let mut next = first;
        next.label = Text::from_utf8("next");
        next.failure = Rc::new(Cell::new(failure));
        let outcome = bus.execute(next, true);
        assert!(outcome.result.is_err());
        assert!(bus.snapshot().project().same_allocation(before.project()));
        assert_eq!(bus.history(), history);
        assert_eq!(bus.history_revision(), revision);
        assert_eq!(
            reasons(&outcome.events),
            ["fault-command", "command-apply-rollback"]
        );
        assert!(bus.undo().result.unwrap());
        assert!(bus.snapshot().project().same_allocation(original.project()));
    }
}
#[test]
fn category_tokens_deduplicate_restore_and_equal_history_still_invalidates() {
    let mut bus = bus(HistoryOptions {
        max_entries: 1,
        max_estimated_bytes: 1,
    });
    let mut c = Command::new("same");
    c.categories = vec![
        DirtyCategory::PrinterDevice,
        DirtyCategory::Presets,
        DirtyCategory::PrinterDevice,
    ];
    assert!(bus.execute(c.clone(), false).result.unwrap());
    assert_eq!(
        bus.history().dirty_categories.as_ref(),
        &[DirtyCategory::Presets, DirtyCategory::PrinterDevice]
    );
    let h = bus.history();
    let revision = bus.history_revision();
    let result = bus.execute(c, false);
    assert!(result.result.unwrap());
    assert_eq!(bus.history(), h);
    assert_eq!(bus.history_revision(), revision + 1);
    assert!(
        !result
            .events
            .iter()
            .any(|e| matches!(e, DomainEvent::History { .. }))
    );
    assert!(bus.mark_checkpoint().result.unwrap());
    let revision = bus.history_revision();
    let result = bus.mark_checkpoint();
    assert!(result.result.unwrap());
    assert!(result.events.is_empty());
    assert_eq!(bus.history_revision(), revision + 1);
    assert!(bus.undo().result.unwrap());
    assert_eq!(
        bus.history().dirty_categories.as_ref(),
        &[DirtyCategory::Presets, DirtyCategory::PrinterDevice]
    );
    assert!(bus.redo().result.unwrap());
    assert!(bus.history().dirty_categories.is_empty());
}
#[test]
fn reservations_refuse_before_mutation_and_noops_keep_history() {
    let mut bus = bus(HistoryOptions::default());
    let original = bus.snapshot();
    let mut c = Command::new("capacity");
    c.bound = u64::MAX;
    let outcome = bus.execute(c, true);
    assert!(matches!(outcome.result, Err(CommandError::Capacity)));
    assert!(outcome.events.is_empty());
    assert_eq!(bus.snapshot().revision(), 0);
    assert!(bus.snapshot().project().same_allocation(original.project()));
    let mut noop = Command::new("noop");
    noop.noop = true;
    let result = bus.execute_batch(Text::from_utf8("Only noops"), vec![noop.clone(), noop]);
    assert!(!result.result.unwrap());
    assert!(result.events.is_empty());
    assert_eq!(bus.history_revision(), 0);
}
