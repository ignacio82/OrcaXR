//! The capability projection over a project session: the registry facts only
//! the canonical session decides (`canonicalUiFacts.ts`), and the host
//! exchange that answers which actions a surface offers and whether the
//! workspace enables them, with the browser's reasons. The host supplies the
//! facts it owns — mode, slicing, printer, startup — and the session supplies
//! the rest, so a host cannot enable an action the project does not allow.
use crate::{
    history::HistorySnapshot,
    model::ProjectState,
    selection::{SelectionRef, SelectionSnapshot},
    session::ProjectSession,
    store::ProjectSnapshot,
    validation::TimestampPolicy,
};
use orcaxr_contracts::{
    capabilities::{
        self as caps, Availability, BootPhase, ContextTarget, Feature, FeaturePhase,
        Initialization, Mode, Prerequisite, PrinterJobState, Reason, Surface, UiState,
    },
    project_intent_types as wire,
};

/// The most actions one page may hold.
pub const MAX_PAGE: usize = 64;

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// An oversized page.
    InvalidRequest,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        "invalid_request"
    }
}

/// `CanonicalUiFacts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    /// Instances on the active plate.
    pub model_count: u64,
    pub plate_count: u64,
    pub has_selection: bool,
    pub has_instance_selection: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
}

/// `canonicalUiFacts`.
pub fn facts(
    state: &ProjectState,
    selection: &SelectionSnapshot,
    history: &HistorySnapshot,
) -> Facts {
    let model_count = state
        .plates
        .iter()
        .find(|plate| plate.id == state.active_plate_id)
        .map_or(0, |plate| {
            plate
                .objects
                .iter()
                .map(|object| object.instances.len() as u64)
                .sum()
        });
    Facts {
        model_count,
        plate_count: state.plates.len() as u64,
        has_selection: !selection.refs().is_empty(),
        has_instance_selection: matches!(selection.primary(), Some(SelectionRef::Instance(_))),
        can_undo: history.undo_count > 0,
        can_redo: history.redo_count > 0,
        dirty: !history.dirty_categories.is_empty(),
    }
}

/// The facts a session's current state decides.
pub fn session_facts<P: TimestampPolicy>(session: &ProjectSession<P>) -> Facts {
    facts(
        session.snapshot().state(),
        &session.selection(),
        &session.history(),
    )
}

macro_rules! bridge {
    ($from:ident, $wire:ty, $native:ty, [$($variant:ident),* $(,)?]) => {
        fn $from(value: &$wire) -> $native {
            match value {
                $(<$wire>::$variant => <$native>::$variant,)*
            }
        }
    };
}
bridge!(
    surface,
    wire::ActionSurface,
    Surface,
    [
        DomScene,
        XrScene,
        DomPrimary,
        DomToolbar,
        DomMenu,
        DomInspector,
        DomContext,
        CommandPalette,
        Keyboard,
        XrPrimary,
        XrToolbar,
        XrMenu,
        XrInspector,
        XrContext,
        Automation,
    ]
);
bridge!(
    context_target,
    wire::ActionContextTarget,
    ContextTarget,
    [Object, Plate]
);
bridge!(mode, wire::WorkspaceMode, Mode, [Prepare, Preview]);
bridge!(
    printer_job_state,
    wire::PrinterJobUiState,
    PrinterJobState,
    [
        Standby,
        Printing,
        Paused,
        Complete,
        Cancelled,
        Error,
        Unknown,
        Disconnected,
    ]
);
bridge!(
    feature_phase,
    wire::StartupFeaturePhase,
    FeaturePhase,
    [Idle, Loading, Ready, Failed]
);
bridge!(
    boot_phase,
    wire::StartupBootPhase,
    BootPhase,
    [Loading, Ready, Degraded, Failed]
);

fn wire_prerequisite(p: Prerequisite) -> wire::ActionPrerequisite {
    use wire::ActionPrerequisite as W;
    match p {
        Prerequisite::HasModel => W::HasModel,
        Prerequisite::HasSelection => W::HasSelection,
        Prerequisite::HasInstanceSelection => W::HasInstanceSelection,
        Prerequisite::HasClipboard => W::HasClipboard,
        Prerequisite::HasGcode => W::HasGcode,
        Prerequisite::PreviewAvailable => W::PreviewAvailable,
        Prerequisite::HasTwoModels => W::HasTwoModels,
        Prerequisite::HasMultiplePlates => W::HasMultiplePlates,
        Prerequisite::NotSlicing => W::NotSlicing,
        Prerequisite::PreflightClear => W::PreflightClear,
        Prerequisite::ProjectionHealthy => W::ProjectionHealthy,
        Prerequisite::PrinterPrinting => W::PrinterPrinting,
        Prerequisite::PrinterPaused => W::PrinterPaused,
        Prerequisite::PrinterJobActive => W::PrinterJobActive,
        Prerequisite::PrinterConnected => W::PrinterConnected,
    }
}

/// The registry state: the session's facts with the host's own.
pub fn ui_state(facts: &Facts, host: &wire::CapabilityHostState) -> UiState {
    UiState {
        initialization: match &host.initialization {
            wire::OptionalStartupSnapshot::Absent(_) => None,
            wire::OptionalStartupSnapshot::Value(s) => Some(Initialization {
                phase: boot_phase(&s.phase),
                features: s
                    .features
                    .iter()
                    .map(|f| Feature {
                        id: f.id.clone(),
                        label: f.label.clone(),
                        phase: feature_phase(&f.phase),
                        reason: f.reason.clone(),
                    })
                    .collect(),
            }),
        },
        mode: mode(&host.mode),
        model_count: facts.model_count,
        plate_count: facts.plate_count,
        has_selection: facts.has_selection,
        simplify_previewing: host.simplify_previewing,
        calibration_session_open: host.calibration_session_open,
        has_instance_selection: facts.has_instance_selection,
        can_undo: facts.can_undo,
        can_redo: facts.can_redo,
        dirty: facts.dirty,
        projection_healthy: host.projection_healthy,
        has_clipboard: host.has_clipboard,
        is_slicing: host.is_slicing,
        gcode_ready: host.gcode_ready,
        preflight_blocked: host.preflight_blocked,
        printer_job_state: printer_job_state(&host.printer_job_state),
    }
}

fn wire_reason(reason: &Reason<'_>) -> wire::CapabilityReason {
    use wire::CapabilityReasonCode as C;
    let code = match reason {
        Reason::UnknownAction => C::UnknownAction,
        Reason::NotOffered(_) => C::NotOffered,
        Reason::XrUnsupported(_) => C::XrUnsupported,
        Reason::NotApplicable => C::NotApplicable,
        Reason::Capability(_) => C::Capability,
        Reason::Unavailable => C::Unavailable,
        Reason::StartupFailed(_) => C::StartupFailed,
        Reason::StartupLoading(_) => C::StartupLoading,
        Reason::Prerequisite(_) => C::Prerequisite,
        Reason::NotAvailable => C::NotAvailable,
    };
    wire::CapabilityReason {
        code,
        prerequisite: match reason {
            Reason::Prerequisite(p) => {
                wire::OptionalActionPrerequisite::Value(wire_prerequisite(*p))
            }
            _ => wire::OptionalActionPrerequisite::Absent(wire::Empty {}),
        },
        text: reason.text(),
    }
}
fn wire_availability(availability: &Availability<'_>) -> wire::ActionAvailability {
    match availability {
        Availability::Enabled => wire::ActionAvailability::Enabled(wire::Empty {}),
        Availability::Disabled(reason) => wire::ActionAvailability::Disabled(wire_reason(reason)),
        Availability::Hidden(reason) => wire::ActionAvailability::Hidden(wire_reason(reason)),
    }
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// One `CapabilityRequest` against a session's current state: a page of the
/// actions a surface offers, of a context menu, or the named actions (an
/// unknown name is hidden), each with its availability.
pub fn page(
    snapshot: &ProjectSnapshot,
    selection: &SelectionSnapshot,
    history: &HistorySnapshot,
    history_revision: u64,
    request: &wire::CapabilityRequest,
) -> Result<wire::CapabilityPage, Refusal> {
    let facts = facts(snapshot.state(), selection, history);
    let state = ui_state(&facts, &request.host);
    let surface = surface(&request.surface);
    let entry = |action: &caps::Action| wire::ActionCapability {
        id: units(action.id),
        label: units(action.label),
        availability: wire_availability(&action.availability(surface, &state)),
    };
    let window = |listed: Vec<&'static caps::Action>, start: u64, count: u64| {
        if count > MAX_PAGE as u64 {
            return Err(Refusal::InvalidRequest);
        }
        let start = usize::try_from(start)
            .unwrap_or(usize::MAX)
            .min(listed.len());
        let end = start.saturating_add(count as usize).min(listed.len());
        Ok((
            listed.len() as u64,
            listed[start..end].iter().map(|a| entry(a)).collect(),
        ))
    };
    let (total, actions) = match &request.query {
        wire::CapabilityQuery::Page(p) => {
            window(caps::for_surface(surface).collect(), p.start, p.count)?
        }
        wire::CapabilityQuery::Context(c) => window(
            caps::for_context(context_target(&c.target), surface).collect(),
            c.start,
            c.count,
        )?,
        wire::CapabilityQuery::Actions(named) => {
            let actions: Vec<_> = named
                .ids
                .iter()
                .map(|id| {
                    match String::from_utf16(id)
                        .ok()
                        .as_deref()
                        .and_then(caps::action)
                    {
                        Some(action) => entry(action),
                        None => wire::ActionCapability {
                            id: id.clone(),
                            label: Vec::new(),
                            availability: wire_availability(&Availability::Hidden(
                                Reason::UnknownAction,
                            )),
                        },
                    }
                })
                .collect();
            (actions.len() as u64, actions)
        }
    };
    Ok(wire::CapabilityPage {
        source_revision: snapshot.revision(),
        history_revision,
        facts: wire::WorkspaceFacts {
            model_count: facts.model_count,
            plate_count: facts.plate_count,
            has_selection: facts.has_selection,
            has_instance_selection: facts.has_instance_selection,
            can_undo: facts.can_undo,
            can_redo: facts.can_redo,
            dirty: facts.dirty,
        },
        total,
        actions,
    })
}

/// [`page`] against a session's current state.
pub fn session_page<P: TimestampPolicy>(
    session: &ProjectSession<P>,
    request: &wire::CapabilityRequest,
) -> Result<wire::CapabilityPage, Refusal> {
    page(
        &session.snapshot(),
        &session.selection(),
        &session.history(),
        session.history_revision(),
        request,
    )
}
