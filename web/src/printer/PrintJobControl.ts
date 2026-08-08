import { MoonrakerTransportError } from './MoonrakerTypes';
import { isActivePrintState, type PrintJobSnapshot } from './PrintJobStatus';

/**
 * The lifecycle commands that act on a running machine.
 *
 * `emergency-stop` is deliberately in the same list rather than hidden behind a
 * different mechanism: it is the one control that must work when everything
 * else is refusing, so it stays reachable from the same surface — but it halts
 * Klipper outright and needs a firmware restart afterwards, which is why
 * `firmware-restart` exists here too.
 */
export type PrintJobCommand = 'pause' | 'resume' | 'cancel' | 'emergency-stop' | 'firmware-restart';

export interface PrintJobCommandTransport {
  request<T>(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<T>;
}

export interface PrintJobCommandDescriptor {
  readonly command: PrintJobCommand;
  readonly label: string;
  /** Moving a real machine in a way the operator cannot undo. */
  readonly destructive: boolean;
  /** True when the printer's reported state allows it right now. */
  readonly allowed: boolean;
  /** Why it is not allowed; always names the reported state. */
  readonly reason?: string;
}

export type PrintJobCommandErrorCode = 'not-allowed' | 'job-changed' | 'request-failed' | 'cancelled';

export class PrintJobCommandError extends Error {
  constructor(
    message: string,
    readonly code: PrintJobCommandErrorCode,
    readonly command: PrintJobCommand,
  ) {
    super(message);
    this.name = 'PrintJobCommandError';
  }
}

const PATHS: Readonly<Record<PrintJobCommand, string>> = Object.freeze({
  pause: '/printer/print/pause',
  resume: '/printer/print/resume',
  cancel: '/printer/print/cancel',
  'emergency-stop': '/printer/emergency_stop',
  'firmware-restart': '/printer/firmware_restart',
});

const LABELS: Readonly<Record<PrintJobCommand, string>> = Object.freeze({
  pause: 'Pause print',
  resume: 'Resume print',
  cancel: 'Cancel print',
  'emergency-stop': 'Emergency stop',
  'firmware-restart': 'Restart firmware',
});

/**
 * Which lifecycle commands the printer's own reported state permits.
 *
 * Availability is derived from the machine, never from what this client last
 * asked for: a job started or stopped from the printer's own screen changes
 * these answers exactly as a job started from here does.
 */
export function printJobCommandAvailability(snapshot: PrintJobSnapshot | null): readonly PrintJobCommandDescriptor[] {
  const state = snapshot?.state;
  const klippyReady = snapshot?.klippyState === undefined || snapshot.klippyState === 'ready';
  const describe = (command: PrintJobCommand, allowed: boolean, reason: string): PrintJobCommandDescriptor =>
    Object.freeze({
      command,
      label: LABELS[command],
      destructive: command !== 'pause' && command !== 'resume',
      allowed,
      ...(allowed ? {} : { reason }),
    });

  if (!snapshot || state === undefined || state === 'unknown') {
    const reason = 'The printer has not reported a job state yet.';
    return Object.freeze([
      describe('pause', false, reason),
      describe('resume', false, reason),
      describe('cancel', false, reason),
      // A machine whose state is unreadable is exactly when a hard stop must
      // still be offered.
      describe('emergency-stop', true, reason),
      describe('firmware-restart', true, reason),
    ]);
  }

  const notReady = `Klipper reports "${snapshot.klippyState}"; it must be ready first.`;
  const busyReason = `The printer is ${state}.`;
  return Object.freeze([
    describe('pause', klippyReady && state === 'printing', klippyReady ? busyReason : notReady),
    describe('resume', klippyReady && state === 'paused', klippyReady ? busyReason : notReady),
    describe('cancel', klippyReady && isActivePrintState(state), klippyReady ? busyReason : notReady),
    describe('emergency-stop', true, ''),
    describe('firmware-restart', true, ''),
  ]);
}

export interface PrintJobCommandRequest {
  readonly command: PrintJobCommand;
  /** The state the operator was looking at when they decided. */
  readonly observed: PrintJobSnapshot | null;
  /**
   * Refuse when the printer is no longer running this file. A stale panel must
   * not pause or cancel a job that started after it was drawn.
   */
  readonly expectedFilename?: string;
  readonly signal?: AbortSignal;
}

/**
 * Run one lifecycle command against the printer, guarded by the state the
 * operator actually saw.
 */
export async function executePrintJobCommand(
  transport: PrintJobCommandTransport,
  request: PrintJobCommandRequest,
): Promise<void> {
  const { command } = request;
  const descriptor = printJobCommandAvailability(request.observed).find((entry) => entry.command === command);
  if (!descriptor?.allowed) {
    throw new PrintJobCommandError(
      `${LABELS[command]} is not available: ${descriptor?.reason ?? 'the printer state does not allow it.'}`,
      'not-allowed',
      command,
    );
  }
  if (
    request.expectedFilename !== undefined &&
    request.observed?.filename !== undefined &&
    request.observed.filename !== request.expectedFilename
  ) {
    throw new PrintJobCommandError(
      `The printer is running "${request.observed.filename}", not "${request.expectedFilename}"; nothing was sent.`,
      'job-changed',
      command,
    );
  }

  try {
    await transport.request<unknown>(PATHS[command], {
      operation: `print_${command.replace('-', '_')}`,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (request.signal?.aborted) {
      throw new PrintJobCommandError(`${LABELS[command]} cancelled.`, 'cancelled', command);
    }
    throw new PrintJobCommandError(
      `${LABELS[command]} failed (${error instanceof MoonrakerTransportError ? error.code : 'request failed'}).`,
      'request-failed',
      command,
    );
  }
}
