//! `PrintJobControl.ts` and the action half of `PrinterStatusSummary.ts`:
//! which lifecycle commands the printer's reported state allows, what sending
//! one does or why it is refused, the sentence a failed send reports, the
//! guarded actions a compact surface offers, and the hold-to-confirm gesture.
//! Availability comes from the machine's reported state, never from what this
//! client last asked for.
use crate::status::is_active;
use orcaxr_contracts::project_intent_types as wire;

pub use wire::PrintJobCommand as Command;

/// Every command, in the order surfaces list them.
pub const COMMANDS: [Command; 5] = [
    Command::Pause,
    Command::Resume,
    Command::Cancel,
    Command::EmergencyStop,
    Command::FirmwareRestart,
];

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn optional(text: Option<Vec<u16>>) -> wire::OptionalText {
    match text {
        Some(text) => wire::OptionalText::Value(text),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn read(text: &wire::OptionalText) -> Option<&[u16]> {
    match text {
        wire::OptionalText::Value(text) => Some(text),
        wire::OptionalText::Absent(_) => None,
    }
}

/// The Moonraker endpoint each command posts to.
pub fn path(command: Command) -> &'static str {
    match command {
        Command::Pause => "/printer/print/pause",
        Command::Resume => "/printer/print/resume",
        Command::Cancel => "/printer/print/cancel",
        Command::EmergencyStop => "/printer/emergency_stop",
        Command::FirmwareRestart => "/printer/firmware_restart",
    }
}
pub fn label(command: Command) -> &'static str {
    match command {
        Command::Pause => "Pause print",
        Command::Resume => "Resume print",
        Command::Cancel => "Cancel print",
        Command::EmergencyStop => "Emergency stop",
        Command::FirmwareRestart => "Restart firmware",
    }
}
/// The browser's command name (`emergency-stop`, …).
fn name(command: Command) -> &'static str {
    match command {
        Command::Pause => "pause",
        Command::Resume => "resume",
        Command::Cancel => "cancel",
        Command::EmergencyStop => "emergency-stop",
        Command::FirmwareRestart => "firmware-restart",
    }
}
/// Moving a real machine in a way the operator cannot undo.
pub fn destructive(command: Command) -> bool {
    !matches!(command, Command::Pause | Command::Resume)
}
/// `isPrinterRecoveryCommand`: reachable without a successful status query.
pub fn recovery(command: Command) -> bool {
    matches!(command, Command::EmergencyStop | Command::FirmwareRestart)
}
/// `PRINTER_HOLD_MS`: long enough that a brush past a controller ray cannot
/// complete one, short enough not to fight someone watching a print fail.
pub fn hold_ms(command: Command) -> u64 {
    match command {
        Command::Pause | Command::Resume => 0,
        Command::Cancel | Command::FirmwareRestart => 800,
        Command::EmergencyStop => 1200,
    }
}
fn confirmation(command: Command) -> Option<&'static str> {
    match command {
        Command::Cancel => Some("Keep holding to stop this print. It cannot be resumed."),
        Command::EmergencyStop => {
            Some("Keep holding to halt the printer. Klipper then needs a firmware restart.")
        }
        Command::FirmwareRestart => Some("Keep holding to restart the firmware."),
        Command::Pause | Command::Resume => None,
    }
}
fn state_name(state: wire::PrintJobState) -> &'static str {
    match state {
        wire::PrintJobState::Standby => "standby",
        wire::PrintJobState::Printing => "printing",
        wire::PrintJobState::Paused => "paused",
        wire::PrintJobState::Complete => "complete",
        wire::PrintJobState::Cancelled => "cancelled",
        wire::PrintJobState::Error => "error",
        wire::PrintJobState::Unknown => "unknown",
    }
}

/// `printJobCommandAvailability`.
pub fn availability(
    observed: Option<&wire::PrintJobSnapshot>,
) -> Vec<wire::PrintJobCommandDescriptor> {
    let describe =
        |command: Command, allowed: bool, reason: Vec<u16>| wire::PrintJobCommandDescriptor {
            command,
            label: units(label(command)),
            destructive: destructive(command),
            allowed,
            reason: optional((!allowed).then_some(reason)),
        };
    let Some(snapshot) = observed.filter(|s| s.state != wire::PrintJobState::Unknown) else {
        let reason = units("The printer has not reported a job state yet.");
        // A machine whose state is unreadable is exactly when a hard stop
        // must still be offered.
        return COMMANDS
            .iter()
            .map(|&c| describe(c, recovery(c), reason.clone()))
            .collect();
    };
    let klippy = read(&snapshot.klippy_state);
    let ready = klippy.is_some_and(|k| *k == units("ready"));
    // A template literal spells an absent state `undefined`.
    let not_ready = [
        units("Klipper reports \""),
        klippy.map_or_else(|| units("undefined"), <[u16]>::to_vec),
        units("\"; it must be ready first."),
    ]
    .concat();
    let busy = units(&format!("The printer is {}.", state_name(snapshot.state)));
    let reason = if ready { busy } else { not_ready };
    let state = snapshot.state;
    vec![
        describe(
            Command::Pause,
            ready && state == wire::PrintJobState::Printing,
            reason.clone(),
        ),
        describe(
            Command::Resume,
            ready && state == wire::PrintJobState::Paused,
            reason.clone(),
        ),
        describe(Command::Cancel, ready && is_active(state), reason),
        describe(Command::EmergencyStop, true, Vec::new()),
        describe(Command::FirmwareRestart, true, Vec::new()),
    ]
}

/// What `executePrintJobCommand` sends for a command, or its refusal: the
/// reported state must allow it, and an expected file must still be the one
/// running (a stale panel never pauses a job started after it was drawn).
pub fn plan(request: &wire::PrintJobCommandCheckRequest) -> wire::PrintJobCommandPlan {
    let observed = match &request.observed {
        wire::OptionalPrintJobSnapshot::Value(snapshot) => Some(snapshot),
        wire::OptionalPrintJobSnapshot::Absent(_) => None,
    };
    let command = request.command;
    let descriptor = availability(observed)
        .into_iter()
        .find(|d| d.command == command)
        .expect("every command is described");
    if !descriptor.allowed {
        let reason = read(&descriptor.reason).map_or_else(
            || units("the printer state does not allow it."),
            <[u16]>::to_vec,
        );
        return refused(
            wire::PrintJobCommandErrorCode::NotAllowed,
            [units(label(command)), units(" is not available: "), reason].concat(),
        );
    }
    if let Some(expected) = read(&request.expected_filename) {
        let running = observed.and_then(|s| read(&s.filename));
        if running != Some(expected) {
            return refused(
                wire::PrintJobCommandErrorCode::JobChanged,
                [
                    units("The printer is running \""),
                    running.map_or_else(|| units("an unknown file"), <[u16]>::to_vec),
                    units("\", not \""),
                    expected.to_vec(),
                    units("\"; nothing was sent."),
                ]
                .concat(),
            );
        }
    }
    wire::PrintJobCommandPlan::Send(wire::PrintJobCommandSend {
        path: units(path(command)),
        // Every lifecycle command is a POST; Moonraker answers a GET with 405.
        method: units("POST"),
        operation: units(&format!("print_{}", name(command).replacen('-', "_", 1))),
    })
}
fn refused(code: wire::PrintJobCommandErrorCode, message: Vec<u16>) -> wire::PrintJobCommandPlan {
    wire::PrintJobCommandPlan::Refused(wire::PrintJobCommandRefusal { code, message })
}

/// Moonraker's own error code (`invalid_endpoint`, …) as the transport names it.
pub fn moonraker_code(code: wire::MoonrakerErrorCode) -> &'static str {
    use wire::MoonrakerErrorCode as C;
    match code {
        C::InvalidEndpoint => "invalid_endpoint",
        C::InvalidCredentials => "invalid_credentials",
        C::InvalidState => "invalid_state",
        C::InvalidRequest => "invalid_request",
        C::Cancelled => "cancelled",
        C::Timeout => "timeout",
        C::Network => "network",
        C::AuthRequired => "auth_required",
        C::Forbidden => "forbidden",
        C::HttpError => "http_error",
        C::InvalidResponse => "invalid_response",
        C::ProtocolError => "protocol_error",
        C::VersionUnsupported => "version_unsupported",
        C::WebsocketUnavailable => "websocket_unavailable",
        C::WebsocketFailed => "websocket_failed",
        C::HeartbeatTimeout => "heartbeat_timeout",
        C::ReconnectExhausted => "reconnect_exhausted",
    }
}

/// `MoonrakerTransportError`'s message for each code.
pub fn moonraker_message(code: wire::MoonrakerErrorCode) -> &'static str {
    use wire::MoonrakerErrorCode as C;
    match code {
        C::InvalidEndpoint => "The Moonraker endpoint is invalid or unsafe.",
        C::InvalidCredentials => "The Moonraker credentials are invalid.",
        C::InvalidState => "The Moonraker operation is not valid in the current connection state.",
        C::InvalidRequest => "The Moonraker operation was given an invalid argument.",
        C::Cancelled => "The Moonraker operation was cancelled.",
        C::Timeout => "The Moonraker operation timed out.",
        C::Network => "Moonraker could not be reached.",
        C::AuthRequired => "Moonraker requires authentication.",
        C::Forbidden => "Moonraker rejected the authenticated request.",
        C::HttpError => "Moonraker returned an HTTP error.",
        C::InvalidResponse => "Moonraker returned an invalid response.",
        C::ProtocolError => "Moonraker returned a protocol error.",
        C::VersionUnsupported => "The Moonraker API version is not supported.",
        C::WebsocketUnavailable => "WebSocket support is unavailable in this browser.",
        C::WebsocketFailed => "The Moonraker WebSocket connection failed.",
        C::HeartbeatTimeout => "The Moonraker WebSocket heartbeat timed out.",
        C::ReconnectExhausted => "Moonraker reconnection attempts were exhausted.",
    }
}

/// The sentence a send reports when the transport fails it, or when the
/// operator cancelled it in flight.
pub fn failure(request: &wire::PrintJobCommandFailureRequest) -> wire::PrintJobCommandRefusal {
    let label = label(request.command);
    if request.cancelled {
        return wire::PrintJobCommandRefusal {
            code: wire::PrintJobCommandErrorCode::Cancelled,
            message: units(&format!("{label} cancelled.")),
        };
    }
    let cause = match request.transport_code {
        wire::OptionalMoonrakerErrorCode::Value(code) => moonraker_code(code),
        wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
    };
    wire::PrintJobCommandRefusal {
        code: wire::PrintJobCommandErrorCode::RequestFailed,
        message: units(&format!("{label} failed ({cause}).")),
    }
}

/// `guardedPrinterActions`: what the printer permits, as a compact surface may
/// offer it. A stale reading holds back ordinary commands; recovery commands
/// never depend on a successful status query.
pub fn guarded(request: &wire::GuardedPrinterActionsRequest) -> Vec<wire::GuardedPrinterAction> {
    let stale_reason = read(&request.stale_reason).map_or_else(
        || units("The printer cannot confirm its state right now, so commands are held back."),
        <[u16]>::to_vec,
    );
    request
        .descriptors
        .iter()
        .map(|d| {
            let held_back = request.stale && !recovery(d.command);
            let reason = if held_back {
                Some(stale_reason.clone())
            } else {
                // An empty reason is no reason.
                read(&d.reason)
                    .filter(|r| !r.is_empty())
                    .map(<[u16]>::to_vec)
            };
            wire::GuardedPrinterAction {
                command: d.command,
                label: d.label.clone(),
                enabled: d.allowed && (!request.stale || recovery(d.command)),
                reason: optional(reason),
                hold_ms: hold_ms(d.command),
                confirmation: optional(confirmation(d.command).map(units)),
                destructive: d.destructive,
            }
        })
        .collect()
}

/// `HoldToConfirm`: a press, then a release at least the action's hold later,
/// fires it; an early release fires nothing; a zero hold fires on release.
/// Each call takes the host's clock once (the browser's reads it as needed).
#[derive(Debug, Clone, Default)]
pub struct HoldToConfirm {
    holding: Option<(Command, f64, u64)>,
}
impl HoldToConfirm {
    pub fn new() -> Self {
        Self::default()
    }
    /// Begin a hold on an enabled action; a disabled one changes nothing.
    pub fn press(
        &mut self,
        action: &wire::GuardedPrinterAction,
        now: f64,
    ) -> wire::HoldToConfirmState {
        if action.enabled {
            self.holding = Some((action.command, now, action.hold_ms));
        }
        self.poll(now)
    }
    /// The hold so far, for a ring or a bar.
    pub fn poll(&self, now: f64) -> wire::HoldToConfirmState {
        match self.holding {
            Some((command, started, required)) => wire::HoldToConfirmState {
                phase: wire::HoldToConfirmPhase::Holding,
                progress: if required == 0 {
                    1.0
                } else {
                    ((now - started) / required as f64).clamp(0.0, 1.0)
                },
                command: wire::OptionalPrintJobCommand::Value(command),
            },
            None => idle(),
        }
    }
    /// End the gesture: the command to run, or none when held too briefly.
    pub fn release(&mut self, now: f64) -> wire::HoldToConfirmRelease {
        let Some((command, started, required)) = self.holding.take() else {
            return wire::HoldToConfirmRelease {
                command: wire::OptionalPrintJobCommand::Absent(wire::Empty {}),
                state: idle(),
            };
        };
        if now - started >= required as f64 {
            wire::HoldToConfirmRelease {
                command: wire::OptionalPrintJobCommand::Value(command),
                state: wire::HoldToConfirmState {
                    phase: wire::HoldToConfirmPhase::Fired,
                    progress: 1.0,
                    command: wire::OptionalPrintJobCommand::Absent(wire::Empty {}),
                },
            }
        } else {
            wire::HoldToConfirmRelease {
                command: wire::OptionalPrintJobCommand::Absent(wire::Empty {}),
                state: idle(),
            }
        }
    }
    /// Abandon the gesture: a pointer that left the control, a lost ray.
    pub fn cancel(&mut self) -> wire::HoldToConfirmState {
        self.holding = None;
        idle()
    }
}
fn idle() -> wire::HoldToConfirmState {
    wire::HoldToConfirmState {
        phase: wire::HoldToConfirmPhase::Idle,
        progress: 0.0,
        command: wire::OptionalPrintJobCommand::Absent(wire::Empty {}),
    }
}
