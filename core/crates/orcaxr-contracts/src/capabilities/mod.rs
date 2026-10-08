//! The action catalog and its availability rules (`ActionRegistry`): which
//! surfaces offer an action, and whether a workspace state enables it, with
//! the browser's reason when it does not. The catalog, the vocabularies, the
//! prerequisite rules and every enablement rule are generated from the
//! production registry; startup gating ports `initializationBlockReason`.
mod generated;

pub use generated::{
    ACTIONS, BootPhase, ContextTarget, FeaturePhase, Group, Mode, Prerequisite, PrinterJobState,
    Status, Surface,
};

/// One catalog action as the registry resolved it.
#[derive(Debug)]
pub struct Action {
    pub id: &'static str,
    pub label: &'static str,
    pub group: Group,
    pub surfaces: &'static [Surface],
    pub context: &'static [ContextTarget],
    pub status: Status,
    /// Shown verbatim when the status disables the action.
    pub reason: Option<&'static str>,
    pub prerequisites: &'static [Prerequisite],
    pub xr_unsupported_reason: Option<&'static str>,
    enabled: Option<fn(&UiState) -> bool>,
    visible: Option<fn(&UiState) -> bool>,
}

/// One startup feature's status. Text is UTF-16, as the host supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feature {
    pub id: Vec<u16>,
    pub label: Vec<u16>,
    pub phase: FeaturePhase,
    pub reason: Vec<u16>,
}

/// The application's startup snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Initialization {
    pub phase: BootPhase,
    pub features: Vec<Feature>,
}

/// The workspace facts availability reads (`UiStateShape`). Optional browser
/// flags are false when absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiState {
    pub initialization: Option<Initialization>,
    pub mode: Mode,
    pub model_count: u64,
    pub plate_count: u64,
    pub has_selection: bool,
    pub simplify_previewing: bool,
    pub calibration_session_open: bool,
    pub has_instance_selection: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub projection_healthy: bool,
    pub has_clipboard: bool,
    pub is_slicing: bool,
    pub gcode_ready: bool,
    pub preflight_blocked: bool,
    pub printer_job_state: PrinterJobState,
}

impl Default for UiState {
    /// `INITIAL_UI_STATE`: every prerequisite unmet.
    fn default() -> Self {
        Self {
            initialization: None,
            mode: Mode::Prepare,
            model_count: 0,
            plate_count: 1,
            has_selection: false,
            simplify_previewing: false,
            calibration_session_open: false,
            has_instance_selection: false,
            can_undo: false,
            can_redo: false,
            dirty: false,
            projection_healthy: true,
            has_clipboard: false,
            is_slicing: false,
            gcode_ready: false,
            preflight_blocked: false,
            printer_job_state: PrinterJobState::Disconnected,
        }
    }
}

/// Why an action is hidden or disabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason<'a> {
    UnknownAction,
    /// The surface does not offer the action.
    NotOffered(Surface),
    /// An XR surface, for an action withheld from the headset.
    XrUnsupported(&'static str),
    /// The action's visibility rule hides it.
    NotApplicable,
    /// The declared capability status disables the action.
    Capability(&'static str),
    /// A disabling status declared without a reason.
    Unavailable,
    /// A startup feature the action depends on failed.
    StartupFailed(&'a Feature),
    /// A startup feature the action depends on is not ready yet.
    StartupLoading(&'a Feature),
    Prerequisite(Prerequisite),
    /// The action's enablement rule refuses the state.
    NotAvailable,
}

impl Reason<'_> {
    /// The browser's text.
    pub fn text(&self) -> Vec<u16> {
        let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
        match self {
            Self::UnknownAction => units("Unknown action."),
            Self::NotOffered(surface) => units(&format!("Not offered on {}.", surface.id())),
            Self::XrUnsupported(text) | Self::Capability(text) => units(text),
            Self::NotApplicable => units("Not applicable in the current workspace state."),
            Self::Unavailable => units("Unavailable."),
            Self::StartupFailed(feature) => {
                let mut text = feature.label.clone();
                text.extend(units(" is unavailable. "));
                text.extend(&feature.reason);
                text.extend(units(" Use startup recovery to try again."));
                text
            }
            Self::StartupLoading(feature) => {
                let mut text = feature.label.clone();
                text.extend(units(" is still loading."));
                text
            }
            Self::Prerequisite(p) => units(p.reason()),
            Self::NotAvailable => units("Not available in the current workspace state."),
        }
    }
}

/// An action's availability on one surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability<'a> {
    Hidden(Reason<'a>),
    Disabled(Reason<'a>),
    Enabled,
}

impl Surface {
    fn is_xr(self) -> bool {
        self.id().starts_with("xr-")
    }
}

impl Action {
    pub fn offered_on(&self, surface: Surface) -> bool {
        self.surfaces.contains(&surface)
    }

    /// `ActionRegistry.availability`.
    pub fn availability<'a>(&self, surface: Surface, state: &'a UiState) -> Availability<'a> {
        if !self.offered_on(surface) {
            return Availability::Hidden(match self.xr_unsupported_reason {
                Some(reason) if surface.is_xr() => Reason::XrUnsupported(reason),
                _ => Reason::NotOffered(surface),
            });
        }
        if self.visible.is_some_and(|visible| !visible(state)) {
            return Availability::Hidden(Reason::NotApplicable);
        }
        if matches!(self.status, Status::Unavailable | Status::Blocked) {
            return Availability::Disabled(
                self.reason.map_or(Reason::Unavailable, Reason::Capability),
            );
        }
        if let Some(reason) = initialization_block_reason(self, state.initialization.as_ref()) {
            return Availability::Disabled(reason);
        }
        if let Some(p) = self.prerequisites.iter().find(|p| !p.met(state)) {
            return Availability::Disabled(Reason::Prerequisite(*p));
        }
        if self.enabled.is_some_and(|enabled| !enabled(state)) {
            return Availability::Disabled(Reason::NotAvailable);
        }
        Availability::Enabled
    }
}

/// The catalog action with this id.
pub fn action(id: &str) -> Option<&'static Action> {
    ACTIONS.iter().find(|a| a.id == id)
}

/// `availability` by id; an unknown id is hidden.
pub fn availability<'a>(id: &str, surface: Surface, state: &'a UiState) -> Availability<'a> {
    action(id).map_or(Availability::Hidden(Reason::UnknownAction), |a| {
        a.availability(surface, state)
    })
}

/// `forSurface`: the actions a surface offers, in catalog order.
pub fn for_surface(surface: Surface) -> impl Iterator<Item = &'static Action> {
    ACTIONS.iter().filter(move |a| a.offered_on(surface))
}

/// `forContext`: what a context menu on a target offers, in catalog order.
pub fn for_context(
    target: ContextTarget,
    surface: Surface,
) -> impl Iterator<Item = &'static Action> {
    for_surface(surface).filter(move |a| a.context.contains(&target))
}

/// `initializationBlockReason`: the first startup feature an action depends
/// on that is not ready. Help, system, printer and slice-cancel actions never
/// wait; slicing, calibration, filament, settings and preset actions also
/// wait for profiles and the settings schema.
pub fn initialization_block_reason<'a>(
    action: &Action,
    snapshot: Option<&'a Initialization>,
) -> Option<Reason<'a>> {
    let snapshot = snapshot?;
    if matches!(action.group, Group::Help | Group::System)
        || action.id.starts_with("printer_")
        || action.id == "slice_cancel"
    {
        return None;
    }
    let extended = matches!(
        action.group,
        Group::Slice | Group::Calibration | Group::Filament
    ) || action.id.starts_with("settings_")
        || action.id.starts_with("presets_")
        || action.id == "objects_assign_filament"
        || action.id == "auto_place_wipe";
    let depends = |id: &[u16]| {
        let core: &[&str] = if extended {
            &["workspace", "shell", "profiles", "settings"]
        } else {
            &["workspace", "shell"]
        };
        core.iter().any(|d| d.encode_utf16().eq(id.iter().copied()))
    };
    let feature = snapshot
        .features
        .iter()
        .find(|f| depends(&f.id) && f.phase != FeaturePhase::Ready)?;
    Some(if feature.phase == FeaturePhase::Failed {
        Reason::StartupFailed(feature)
    } else {
        Reason::StartupLoading(feature)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hides(_: &UiState) -> bool {
        false
    }

    /// The paths no catalog action takes today, against the browser's text.
    #[test]
    fn visibility_rules_and_reasonless_statuses_read_as_the_browser() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../testdata/cross-platform/action-capability-vectors.json"
        ))
        .unwrap();
        let text = |key: &str| -> Vec<u16> {
            corpus["syntheticReasons"][key]
                .as_str()
                .unwrap()
                .encode_utf16()
                .collect()
        };
        let base = action("edit_undo").unwrap();
        let state = UiState::default();
        let hidden = Action {
            visible: Some(hides),
            ..*base
        };
        let Availability::Hidden(reason) = hidden.availability(Surface::DomMenu, &state) else {
            panic!("a visibility rule hides");
        };
        assert_eq!(reason, Reason::NotApplicable);
        assert_eq!(reason.text(), text("notApplicable"));
        let blocked = Action {
            status: Status::Blocked,
            reason: None,
            ..*base
        };
        let Availability::Disabled(reason) = blocked.availability(Surface::DomMenu, &state) else {
            panic!("a blocked status disables");
        };
        assert_eq!(reason, Reason::Unavailable);
        assert_eq!(reason.text(), text("unavailable"));
    }
}
