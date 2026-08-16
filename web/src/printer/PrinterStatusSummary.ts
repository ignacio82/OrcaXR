/**
 * The compact printer status both narrow-touch and XR render (parity P9.7).
 *
 * A phone status bar and an XR card have almost nothing in common except what
 * they have to say, so what they have to say lives here: one headline, one
 * detail line, the progress the machine actually reported, and — when the
 * session drops — what is known, how old it is, and what to do about it.
 *
 * Three rules.
 *
 * Nothing is invented. A field the printer did not report is absent, never a
 * zero, because "0 %" and "not reported" lead to opposite decisions when
 * someone is deciding whether to cancel.
 *
 * A reading nobody can confirm is marked, not hidden. When the socket drops
 * mid-job the last snapshot is still the most useful thing on screen — but it
 * is labelled with its age, and every lifecycle command is refused while it
 * lasts, because a pause that may not have arrived is worse than no pause.
 *
 * Destructive commands are reachable but not trippable. `cancel`,
 * `emergency-stop`, and `firmware-restart` are held rather than tapped, which
 * is the one confirmation gesture a controller ray, a thumb, and a mouse all
 * perform the same way. Pause and resume fire immediately: they are recoverable
 * and being slow to reach them costs prints.
 */

import { describeMoonrakerErrorCode, type MoonrakerConnectionState } from './MoonrakerTypes';
import type { PrintJobCommand, PrintJobCommandDescriptor } from './PrintJobControl';
import { describePrintJobState, formatDuration, isActivePrintState, type PrintJobSnapshot } from './PrintJobStatus';

export type PrinterStatusTone = 'idle' | 'active' | 'attention' | 'danger' | 'unknown';

export interface PrinterStatusFact {
  readonly label: string;
  readonly value: string;
}

export interface PrinterStatusRecovery {
  /** What happened, in the operator's terms. */
  readonly message: string;
  /** Label for the one control that acts on it. */
  readonly actionLabel: string;
  /** Seconds until the transport's own next attempt, when it is already trying. */
  readonly retryInS?: number;
  /** True while the transport is retrying on its own and needs no help. */
  readonly automatic: boolean;
}

export interface PrinterStatusSummary {
  readonly tone: PrinterStatusTone;
  /** One line, short enough for a phone bar and an XR card header. */
  readonly headline: string;
  /** The one number worth glancing at, or why there is not one. */
  readonly detail: string;
  /** 0–1, only when the printer reported it. */
  readonly progress?: number;
  readonly progressLabel?: string;
  /** True when nothing can confirm what is shown right now. */
  readonly stale: boolean;
  /** How old the reading is, once it can no longer be confirmed. */
  readonly ageLabel?: string;
  readonly recovery?: PrinterStatusRecovery;
  readonly facts: readonly PrinterStatusFact[];
  /**
   * Whether a compact surface should show itself unasked. Idle and connected is
   * the one state worth staying out of the way for — preparation is what the
   * screen is for the rest of the time.
   */
  readonly present: boolean;
}

export interface GuardedPrinterAction {
  readonly command: PrintJobCommand;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
  /** Milliseconds the control must be held before it fires; 0 fires on release. */
  readonly holdMs: number;
  /** What the hold is about to do, shown while it is in progress. */
  readonly confirmation?: string;
  readonly destructive: boolean;
}

/**
 * How long each destructive command is held. Long enough that a brush past a
 * controller ray cannot complete one, short enough that someone watching a
 * print go wrong is not fighting the UI.
 */
export const PRINTER_HOLD_MS: Readonly<Record<PrintJobCommand, number>> = Object.freeze({
  pause: 0,
  resume: 0,
  cancel: 800,
  'emergency-stop': 1200,
  'firmware-restart': 800,
});

const HOLD_CONFIRMATION: Readonly<Partial<Record<PrintJobCommand, string>>> = Object.freeze({
  cancel: 'Keep holding to stop this print. It cannot be resumed.',
  'emergency-stop': 'Keep holding to halt the printer. Klipper then needs a firmware restart.',
  'firmware-restart': 'Keep holding to restart the firmware.',
});

/** A connection that cannot confirm a reading, and why. */
function staleness(connection: MoonrakerConnectionState | null): { stale: boolean; reason: string } {
  if (!connection) return { stale: true, reason: 'This session is not connected to a printer.' };
  switch (connection.status) {
    case 'connected':
      return { stale: false, reason: '' };
    case 'connecting':
      return { stale: true, reason: 'Still connecting to the printer.' };
    case 'reconnecting':
      return { stale: true, reason: 'The connection to the printer dropped.' };
    case 'error':
      return { stale: true, reason: describeMoonrakerErrorCode(connection.error.code) };
    default:
      return { stale: true, reason: 'The connection to the printer is closed.' };
  }
}

function recoveryFor(connection: MoonrakerConnectionState | null, reason: string): PrinterStatusRecovery | undefined {
  if (!connection) {
    return Object.freeze({ message: reason, actionLabel: 'Connect', automatic: false });
  }
  switch (connection.status) {
    case 'connected':
      return undefined;
    case 'connecting':
      return Object.freeze({ message: reason, actionLabel: 'Connecting…', automatic: true });
    case 'reconnecting':
      return Object.freeze({
        message: `${reason} Retrying on its own; the print keeps running either way.`,
        actionLabel: 'Reconnect now',
        retryInS: Math.max(0, Math.round(connection.delayMs / 1000)),
        automatic: true,
      });
    case 'error':
      return Object.freeze({ message: reason, actionLabel: 'Reconnect', automatic: false });
    default:
      return Object.freeze({ message: reason, actionLabel: 'Connect', automatic: false });
  }
}

function toneFor(snapshot: PrintJobSnapshot | null, stale: boolean): PrinterStatusTone {
  if (!snapshot || snapshot.state === 'unknown') return 'unknown';
  if (snapshot.state === 'error') return 'danger';
  if (stale) return 'attention';
  if (snapshot.state === 'paused') return 'attention';
  if (snapshot.state === 'printing') return 'active';
  return 'idle';
}

/** `40 s ago` / `3 min ago`; only meaningful once a reading stops being confirmed. */
export function formatReadingAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export interface PrinterStatusInput {
  readonly snapshot: PrintJobSnapshot | null;
  readonly connection: MoonrakerConnectionState | null;
  /** Now, so the age of a stale reading is the caller's clock and not a guess. */
  readonly nowMs: number;
  /** True once the operator has configured an endpoint at all. */
  readonly configured: boolean;
}

/** Project everything a compact surface shows from one live input. */
export function summarizePrinterStatus(input: PrinterStatusInput): PrinterStatusSummary {
  const { snapshot, connection, nowMs, configured } = input;
  const { stale, reason } = staleness(connection);

  if (!configured) {
    return Object.freeze({
      tone: 'unknown' as const,
      headline: 'No printer configured',
      detail: 'Add a Moonraker endpoint to monitor a print from here.',
      stale: true,
      facts: Object.freeze([]),
      present: false,
    });
  }

  const tone = toneFor(snapshot, stale);
  const active = snapshot !== null && isActivePrintState(snapshot.state);
  const recovery = recoveryFor(connection, reason);
  const ageLabel =
    stale && snapshot && snapshot.updatedAtMs > 0 ? formatReadingAge(nowMs - snapshot.updatedAtMs) : undefined;

  const headline = snapshot ? describePrintJobState(snapshot) : 'Printer not reporting';
  const facts: PrinterStatusFact[] = [];
  if (snapshot?.currentLayer !== undefined && snapshot.totalLayers !== undefined) {
    facts.push({ label: 'Layer', value: `${snapshot.currentLayer} / ${snapshot.totalLayers}` });
  }
  if (snapshot?.printDurationS !== undefined) {
    facts.push({ label: 'Elapsed', value: formatDuration(snapshot.printDurationS) });
  }
  if (snapshot?.estimatedRemainingS !== undefined) {
    facts.push({ label: 'Left (approx.)', value: formatDuration(snapshot.estimatedRemainingS) });
  }
  if (snapshot?.extruder) {
    facts.push({ label: 'Nozzle', value: describeTemperature(snapshot.extruder) });
  }
  if (snapshot?.bed) {
    facts.push({ label: 'Bed', value: describeTemperature(snapshot.bed) });
  }

  // The detail line is the one thing someone reads at a glance, so a lost
  // session claims it: how old the reading is outranks how far along it was.
  const progressLabel =
    snapshot?.progress === undefined ? undefined : `${Math.round(Math.min(1, Math.max(0, snapshot.progress)) * 100)}%`;
  const detail = stale
    ? ageLabel
      ? `Last reading ${ageLabel}`
      : reason
    : progressLabel && active
      ? snapshot?.estimatedRemainingS !== undefined
        ? `${progressLabel} · about ${formatDuration(snapshot.estimatedRemainingS)} left`
        : progressLabel
      : (snapshot?.message ?? 'Nothing running');

  return Object.freeze({
    tone,
    headline,
    detail,
    ...(snapshot?.progress === undefined ? {} : { progress: Math.min(1, Math.max(0, snapshot.progress)) }),
    ...(progressLabel ? { progressLabel } : {}),
    stale,
    ...(ageLabel ? { ageLabel } : {}),
    ...(recovery ? { recovery } : {}),
    facts: Object.freeze(facts),
    // Worth showing unasked whenever something is happening, has gone wrong, or
    // can no longer be confirmed. Idle and connected stays out of the way.
    present: active || tone === 'danger' || (stale && snapshot !== null && snapshot.state !== 'standby'),
  });
}

function describeTemperature(temperature: { readonly actualC: number; readonly targetC: number }): string {
  const actual = `${Math.round(temperature.actualC)} °C`;
  return temperature.targetC > 0 ? `${actual} → ${Math.round(temperature.targetC)} °C` : actual;
}

/**
 * Turn what the printer permits into what a compact surface may offer, adding
 * the hold each destructive command needs.
 *
 * A stale reading disables everything: the descriptors were computed from a
 * state nothing can confirm, so acting on them is guessing.
 */
export function guardedPrinterActions(
  descriptors: readonly PrintJobCommandDescriptor[],
  options: { readonly stale: boolean; readonly staleReason?: string } = { stale: false },
): readonly GuardedPrinterAction[] {
  const staleReason =
    options.staleReason ?? 'The printer cannot confirm its state right now, so commands are held back.';
  return Object.freeze(
    descriptors.map((descriptor) =>
      Object.freeze({
        command: descriptor.command,
        label: descriptor.label,
        enabled: descriptor.allowed && !options.stale,
        ...(options.stale ? { reason: staleReason } : descriptor.reason ? { reason: descriptor.reason } : {}),
        holdMs: PRINTER_HOLD_MS[descriptor.command],
        ...(HOLD_CONFIRMATION[descriptor.command] ? { confirmation: HOLD_CONFIRMATION[descriptor.command] } : {}),
        destructive: descriptor.destructive,
      }),
    ),
  );
}

export interface HoldToConfirmClock {
  now(): number;
}

export type HoldToConfirmPhase = 'idle' | 'holding' | 'fired';

export interface HoldToConfirmState {
  readonly phase: HoldToConfirmPhase;
  /** 0–1 of the required hold, for a ring or a bar. */
  readonly progress: number;
  readonly command?: PrintJobCommand;
}

/**
 * The one confirmation gesture every surface can perform.
 *
 * A pointer, a controller trigger, and a pinch all produce press/release with a
 * clock in between, so the rule lives here and each shell only reports events.
 * A hold that is released early fires nothing and says so; a zero-hold command
 * fires on release, which is what makes pause reachable in one tap while cancel
 * is not reachable by accident at all.
 */
export class HoldToConfirm {
  private phase: HoldToConfirmPhase = 'idle';
  private command?: PrintJobCommand;
  private startedAtMs = 0;
  private requiredMs = 0;

  constructor(private readonly clock: HoldToConfirmClock = { now: () => Date.now() }) {}

  /** Begin a hold. Returns the state so a caller can render the first frame. */
  press(action: GuardedPrinterAction): HoldToConfirmState {
    if (!action.enabled) return this.snapshot();
    this.phase = 'holding';
    this.command = action.command;
    this.requiredMs = action.holdMs;
    this.startedAtMs = this.clock.now();
    return this.snapshot();
  }

  /** Sample the hold without ending it; drives the progress a surface draws. */
  poll(): HoldToConfirmState {
    if (this.phase !== 'holding') return this.snapshot();
    return this.snapshot();
  }

  /**
   * End the gesture. Returns the command to run, or undefined when the hold was
   * too short — a released-too-early cancel must run nothing at all.
   */
  release(): { readonly command?: PrintJobCommand; readonly state: HoldToConfirmState } {
    if (this.phase !== 'holding' || !this.command) {
      this.reset();
      return { state: this.snapshot() };
    }
    const held = this.clock.now() - this.startedAtMs;
    const command = this.command;
    const satisfied = held >= this.requiredMs;
    this.phase = satisfied ? 'fired' : 'idle';
    const state = this.snapshot();
    this.reset();
    return satisfied ? { command, state } : { state };
  }

  /** Abandon the gesture — a pointer that left the control, a lost ray. */
  cancel(): HoldToConfirmState {
    this.reset();
    return this.snapshot();
  }

  private reset(): void {
    this.phase = 'idle';
    this.command = undefined;
    this.startedAtMs = 0;
    this.requiredMs = 0;
  }

  private snapshot(): HoldToConfirmState {
    if (this.phase !== 'holding' || !this.command) {
      return Object.freeze({ phase: this.phase, progress: this.phase === 'fired' ? 1 : 0 });
    }
    const elapsed = this.clock.now() - this.startedAtMs;
    const progress = this.requiredMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / this.requiredMs));
    return Object.freeze({ phase: this.phase, progress, command: this.command });
  }
}
