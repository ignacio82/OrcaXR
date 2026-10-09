/**
 * The printer session run by the shared core (`orcaxr_printer::session`
 * through the printer WASM): one selected printer and every query,
 * subscription and command in its session, with the policy the Android app
 * runs. This class does only what a browser must — open transports and feed
 * their state and notifications in, carry out requests, recovery commands,
 * connects and confirmation dialogs — and translates between the contract and
 * the browser's types. Its public surface is `PrinterSessionController`'s,
 * which stays as the reference the core is replayed against and as the
 * rollback adapter.
 *
 * Steps apply strictly in the order the core produced them. Opening a
 * transport is synchronous: it is answered (with the transport's state)
 * before any listener runs, so nothing else reaches the core in between, as
 * the browser controller opens one inside `select`. An epoch is a generation:
 * its requests and dialogs see their signal abort when the core ends it.
 */
import {
  decodeProjectPrintJobConfirmReply,
  decodeProjectPrintJobIntentReply,
  decodeProjectPrinterSessionLeaseReply,
  decodeProjectPrinterSessionStep,
  decodeProjectPrinterSessionView,
  encodeProjectConnectionSignal,
  encodeProjectPrintJobExecuteRequest,
  encodeProjectPrinterSelection,
  encodeProjectPrinterSessionLease,
  encodeProjectPrinterSessionOutcome,
  type ProjectPrintJobCommandIntentWire,
  type ProjectPrinterSessionEffectWire,
  type ProjectPrinterSessionOutcomeWire,
  type ProjectPrinterSelectionWire,
  type ProjectPrinterSessionStepWire,
  type ProjectPrinterTaskResultWire,
  type ProjectTransportFailureWire,
} from '../../../contracts/generated/project-intents';
import type { MoonrakerTransport } from './MoonrakerTransport';
import { MoonrakerTransportError, type MoonrakerConnectionState, type MoonrakerHandshake } from './MoonrakerTypes';
import { PrintJobCommandError, type PrintJobCommand, type PrintJobCommandDescriptor } from './PrintJobControl';
import { PRINT_JOB_OBJECTS, type PrintJobSnapshot } from './PrintJobStatus';
import type {
  PrintJobCommandIntent,
  PrintJobConfirmation,
  PrinterSelection,
  PrinterSession,
  PrinterSessionLease,
  PrinterSessionTransport,
} from './PrinterSessionController';
import {
  fromUnits,
  optionalTextFromWire,
  optionalTextWire,
  printJobCommandDescriptorFromWire,
  printJobCommandErrorFromWire,
  printJobCommandFromWire,
  printJobCommandWire,
  printJobSnapshotFromWire,
  units,
} from './PrinterWire';

/** The shared core's session machine, as the WASM binding exposes it. */
export interface PrinterSessionMachine {
  select(selection: string): string;
  clear(): string;
  dispose(): string;
  connect(): string;
  refresh(): string;
  execute(request: string): string;
  transport_state(transport: number, signal: string): string;
  notification(transport: number, method: string, params: string, nowMs: number): string;
  resolve(id: number, outcome: string): string;
  resolve_reply(id: number, text: string, nowMs: number): string;
  view(): string;
  capture_intent(command: string): string;
  confirm(intent: number): string;
  capture_lease(): string;
  lease_current(lease: string): boolean;
}

/** What the session needs from the loaded shared core. */
export interface PrinterSessionCore {
  readonly PrinterSession: new () => PrinterSessionMachine;
}

type Step = ProjectPrinterSessionStepWire;
type Dialog = (intent: PrintJobCommandIntent, signal: AbortSignal) => Promise<boolean>;

const absent = { absent: {} } as const;
const camel = (code: string): string => code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const FAILURE_MEMORY = 32;

/** What the core reads of a transport's state. */
function signalWire(state: MoonrakerConnectionState): string {
  return encodeProjectConnectionSignal({
    status: state.status,
    generation: state.generation,
    socketEpoch: state.status === 'connected' ? { value: state.socketEpoch } : absent,
  });
}

/** What the core reads of a failed exchange: its Moonraker code, status and detail. */
function failureWire(error: unknown): ProjectTransportFailureWire {
  if (!(error instanceof MoonrakerTransportError)) return { code: absent, httpStatus: absent, detail: absent };
  return {
    code: { value: camel(error.code) as never },
    httpStatus: error.httpStatus === undefined ? absent : { value: error.httpStatus },
    detail: optionalTextWire(error.detail),
  };
}

interface Task {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly kind: 'connect' | 'refresh' | 'execute';
  readonly command?: PrintJobCommand;
}

interface Hint {
  readonly task: number;
  readonly signal?: AbortSignal;
  readonly dialog?: Dialog;
  readonly intent?: PrintJobCommandIntent;
}

interface View {
  readonly generation: number;
  readonly snapshot: PrintJobSnapshot | null;
  readonly availability: readonly PrintJobCommandDescriptor[];
}

export class SharedPrinterSession<T extends PrinterSessionTransport = MoonrakerTransport> implements PrinterSession<T> {
  private readonly machine: PrinterSessionMachine;
  private readonly listeners = new Set<() => void>();
  private readonly transports = new Map<number, { readonly transport: T; readonly stops: (() => void)[] }>();
  /** The latest state each open transport reported. */
  private readonly states = new Map<number, MoonrakerConnectionState>();
  private current: number | null = null;
  private readonly epochs = new Map<number, AbortController>();
  private readonly tasks = new Map<number, Task>();
  /** The task, caller's signal or dialog of an effect a call issued, until it is carried out. */
  private readonly hints = new Map<number, Hint>();
  private readonly connected = new Map<number, { readonly transport: number; handshake?: MoonrakerHandshake }>();
  private readonly intentIds = new WeakMap<PrintJobCommandIntent, number>();
  private readonly intentsById = new Map<number, WeakRef<PrintJobCommandIntent>>();
  private readonly tokens = new WeakMap<PrintJobConfirmation, number>();
  /** The browser hands a failed exchange's own error on; the core reports its message. */
  private readonly failures = new Map<string, unknown>();
  private readonly queue: Step[] = [];
  private draining = false;
  private viewValue: View;

  constructor(
    core: PrinterSessionCore,
    private readonly createTransport: (selection: PrinterSelection) => T,
  ) {
    this.machine = new core.PrinterSession();
    this.viewValue = this.readView();
  }

  get transport(): T | null {
    return this.current === null ? null : (this.transports.get(this.current)?.transport ?? null);
  }
  get snapshot(): PrintJobSnapshot | null {
    return this.viewValue.snapshot;
  }
  get state(): MoonrakerConnectionState | null {
    return this.current === null ? null : (this.states.get(this.current) ?? null);
  }
  get generation(): number {
    return this.viewValue.generation;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(selection: PrinterSelection): T {
    let json: string;
    try {
      json = this.machine.select(
        encodeProjectPrinterSelection({
          id: units(selection.id),
          name: optionalTextWire(selection.name),
          endpoint: units(selection.endpoint),
          port: selection.port,
          apiKey: optionalTextWire(selection.apiKey),
        }),
      );
    } catch (error) {
      if (error === 'disposed') throw new Error('Printer session is disposed.', { cause: error });
      throw error;
    }
    this.apply(decodeProjectPrinterSessionStep(json));
    return this.transport!;
  }

  connect(signal?: AbortSignal): Promise<{ transport: T; handshake: MoonrakerHandshake }> {
    return this.start(() => this.machine.connect(), 'connect', { signal }) as Promise<{
      transport: T;
      handshake: MoonrakerHandshake;
    }>;
  }

  refresh(): Promise<void> {
    return this.start(() => this.machine.refresh(), 'refresh') as Promise<void>;
  }

  captureLease(): PrinterSessionLease<T> {
    const reply = decodeProjectPrinterSessionLeaseReply(this.machine.capture_lease());
    if ('refused' in reply) throw new Error(fromUnits(reply.refused.text));
    const lease = reply.lease;
    const wire = encodeProjectPrinterSessionLease(lease);
    return Object.freeze({
      printerId: fromUnits(lease.printerId),
      label: fromUnits(lease.label),
      generation: lease.generation,
      transport: this.transports.get(lease.transport)!.transport,
      signal: this.epoch(lease.generation).signal,
      assertCurrent: () => {
        if (!this.machine.lease_current(wire))
          throw new Error('The selected printer or connection changed. Confirm a new send.');
      },
    });
  }

  clear(): void {
    this.apply(decodeProjectPrinterSessionStep(this.machine.clear()));
  }

  dispose(): void {
    this.apply(decodeProjectPrinterSessionStep(this.machine.dispose()));
    this.listeners.clear();
  }

  availability(): readonly PrintJobCommandDescriptor[] {
    return this.viewValue.availability;
  }

  captureIntent(command: PrintJobCommand): PrintJobCommandIntent {
    const reply = decodeProjectPrintJobIntentReply(this.machine.capture_intent(printJobCommandWire(command)));
    if ('refused' in reply) throw this.refusal(reply.refused, command);
    return this.intent(reply.intent);
  }

  confirm(intent: PrintJobCommandIntent): PrintJobConfirmation {
    const reply = decodeProjectPrintJobConfirmReply(this.machine.confirm(this.intentIds.get(intent) ?? 0));
    if ('refused' in reply) throw this.refusal(reply.refused, intent.command);
    const confirmation: PrintJobConfirmation = Object.freeze({ intent });
    this.tokens.set(confirmation, reply.token);
    return confirmation;
  }

  execute(intent: PrintJobCommandIntent, confirmation?: PrintJobConfirmation | Dialog): Promise<void> {
    const token = typeof confirmation === 'object' ? this.tokens.get(confirmation) : undefined;
    const request = encodeProjectPrintJobExecuteRequest({
      // An intent this session never issued stands for one the core never made.
      intent: this.intentIds.get(intent) ?? 0,
      confirmation:
        typeof confirmation === 'function' ? { dialog: {} } : token !== undefined ? { token } : { none: {} },
    });
    return this.start(() => this.machine.execute(request), 'execute', {
      ...(typeof confirmation === 'function' ? { dialog: confirmation } : {}),
      intent,
    }) as Promise<void>;
  }

  // --- Calls that start tasks, and inputs ----------------------------------------------------

  private start(call: () => string, kind: Task['kind'], hint: Omit<Hint, 'task'> = {}): Promise<unknown> {
    let step: Step;
    try {
      step = decodeProjectPrinterSessionStep(call());
    } catch (error) {
      return Promise.reject(error);
    }
    if (!('value' in step.task)) {
      this.apply(step);
      return Promise.reject(new Error('The printer session started no task.'));
    }
    const task = step.task.value;
    const settled = new Promise<unknown>((resolve, reject) => {
      this.tasks.set(task, { resolve, reject, kind, ...(hint.intent ? { command: hint.intent.command } : {}) });
    });
    // The connect or dialog a call issues is in the step that started it.
    for (const { id, effect } of step.effects) {
      if ('connect' in effect || 'confirmCommand' in effect) this.hints.set(id, { ...hint, task });
    }
    this.apply(step);
    return settled;
  }

  /** An event from outside: a transport's state or notification, an answered effect. */
  private input(call: () => string): void {
    let json: string;
    try {
      json = call();
    } catch (error) {
      // An answer the core no longer awaits changes nothing; anything else is a fault.
      if (error === 'not_pending' || error === 'mismatch') return;
      throw error;
    }
    this.apply(decodeProjectPrinterSessionStep(json));
  }

  private answer(id: number, outcome: ProjectPrinterSessionOutcomeWire): void {
    this.input(() => this.machine.resolve(id, encodeProjectPrinterSessionOutcome(outcome)));
  }

  private apply(step: Step): void {
    this.queue.push(step);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) this.run(next);
    } finally {
      this.draining = false;
    }
  }

  /** One step: effects first (opening a transport at once), then listeners and tasks. */
  private run(step: Step): void {
    let opened: string | undefined;
    for (const { id, effect } of step.effects) opened = this.carryOut(id, effect) ?? opened;
    for (const transport of step.closed) this.close(transport);
    // An ended epoch stays recorded, aborted: anything that names it later is too.
    for (const epoch of step.aborted) this.epoch(epoch).abort();
    for (const id of step.withdrawn) this.hints.delete(id);
    // The core's answer to opening a transport is the next step, before
    // anything a listener does reaches it.
    if (opened !== undefined) this.queue.unshift(decodeProjectPrinterSessionStep(opened));
    if (step.changed > 0) {
      this.viewValue = this.readView();
      for (let i = 0; i < step.changed; i++) for (const listener of [...this.listeners]) listener();
    }
    for (const { task, result } of step.finished) this.finish(task, result);
  }

  /** Carries out effect `id`; opening a transport answers at once, with the core's next step. */
  private carryOut(id: number, effect: ProjectPrinterSessionEffectWire): string | undefined {
    const hint = this.hints.get(id);
    this.hints.delete(id);
    if ('openTransport' in effect) return this.open(id, effect.openTransport.transport, effect.openTransport.selection);
    if ('connect' in effect) {
      const transportId = effect.connect.transport;
      const transport = this.transports.get(transportId)?.transport;
      const record = { transport: transportId } as { transport: number; handshake?: MoonrakerHandshake };
      if (hint) this.connected.set(hint.task, record);
      if (!transport) {
        this.answer(id, { failed: failureWire(undefined) });
        return undefined;
      }
      transport.connect(hint?.signal ? { signal: hint.signal } : {}).then(
        (handshake) => {
          record.handshake = handshake;
          this.answer(id, { connected: {} });
        },
        (error: unknown) => {
          this.remember(error);
          this.answer(id, { failed: failureWire(error) });
        },
      );
      return undefined;
    }
    if ('request' in effect) {
      const { transport: transportId, epoch, send } = effect.request;
      const transport = this.transports.get(transportId)?.transport;
      const method = fromUnits(send.method);
      const operation = fromUnits(send.operation);
      const options = {
        signal: this.epoch(epoch).signal,
        ...(method === 'GET' ? {} : { method }),
        ...(operation ? { operation } : {}),
        ...('value' in send.timeoutMs ? { timeoutMs: send.timeoutMs.value } : {}),
      };
      this.exchange(id, () => transport!.request<unknown>(fromUnits(send.path), options));
      return undefined;
    }
    if ('recovery' in effect) {
      const { transport: transportId, epoch, command } = effect.recovery;
      const transport = this.transports.get(transportId)?.transport;
      const recovery = printJobCommandFromWire(command) as 'emergency-stop' | 'firmware-restart';
      this.exchange(id, () => transport!.requestRecoveryCommand(recovery, this.epoch(epoch).signal));
      return undefined;
    }
    // A confirmation dialog for the command a call is executing.
    const wire = effect.confirmCommand;
    const intent = hint?.intent ?? this.intent(wire);
    const asked = hint?.dialog;
    if (!asked) {
      this.answer(id, { confirmed: false });
      return undefined;
    }
    let answered: Promise<boolean>;
    try {
      answered = Promise.resolve(asked(intent, this.epoch(wire.generation).signal));
    } catch (error) {
      answered = Promise.reject(error);
    }
    answered.then(
      (confirmed) => this.answer(id, { confirmed: Boolean(confirmed) }),
      // A dialog that fails sent nothing: it reads as dismissed.
      () => this.answer(id, { confirmed: false }),
    );
    return undefined;
  }

  /** A request or recovery command: its reply (Moonraker's `result`, as JSON) or its failure. */
  private exchange(id: number, send: () => Promise<unknown>): void {
    let sent: Promise<unknown>;
    try {
      sent = send();
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      (result) => this.input(() => this.machine.resolve_reply(id, JSON.stringify(result) ?? 'null', Date.now())),
      (error: unknown) => {
        this.remember(error);
        this.answer(id, { failed: failureWire(error) });
      },
    );
  }

  private open(id: number, transportId: number, selection: ProjectPrinterSelectionWire): string {
    const transport = this.createTransport(this.selectionFromWire(selection));
    const stops: (() => void)[] = [];
    this.transports.set(transportId, { transport, stops });
    this.current = transportId;
    transport.setObjectSubscription(PRINT_JOB_OBJECTS);
    stops.push(
      transport.subscribeNotifications((notification) => {
        if (!this.transports.has(transportId)) return;
        this.input(() =>
          this.machine.notification(
            transportId,
            notification.method,
            JSON.stringify(notification.params) ?? 'null',
            notification.receivedAtMs,
          ),
        );
      }),
    );
    // The first state answers the opening itself; later ones are inputs.
    let opening = true;
    stops.push(
      transport.subscribeState((state) => {
        if (!this.transports.has(transportId)) return;
        this.states.set(transportId, state);
        if (!opening) this.input(() => this.machine.transport_state(transportId, signalWire(state)));
      }),
    );
    opening = false;
    const state = this.states.get(transportId) ?? transport.state;
    this.states.set(transportId, state);
    return this.machine.resolve(
      id,
      encodeProjectPrinterSessionOutcome({ state: JSON.parse(signalWire(state)) as never }),
    );
  }

  private close(transportId: number): void {
    const entry = this.transports.get(transportId);
    if (!entry) return;
    for (const stop of entry.stops.splice(0)) stop();
    this.transports.delete(transportId);
    this.states.delete(transportId);
    if (this.current === transportId) this.current = null;
    entry.transport.dispose();
  }

  private finish(task: number, result: ProjectPrinterTaskResultWire): void {
    const pending = this.tasks.get(task);
    this.tasks.delete(task);
    const connected = this.connected.get(task);
    this.connected.delete(task);
    if (!pending) return;
    if ('done' in result) {
      if (pending.kind === 'connect') {
        pending.resolve({
          transport: connected ? this.transports.get(connected.transport)?.transport : this.transport,
          handshake: connected?.handshake,
        });
      } else pending.resolve(undefined);
    } else if ('refused' in result) {
      pending.reject(this.refusal(result.refused, pending.command));
    } else {
      const message = fromUnits(result.failed.text);
      pending.reject(this.failures.get(message) ?? new Error(message));
    }
  }

  // --- Translation ------------------------------------------------------------------------

  private epoch(epoch: number): AbortController {
    let controller = this.epochs.get(epoch);
    if (!controller) {
      controller = new AbortController();
      this.epochs.set(epoch, controller);
    }
    return controller;
  }

  private remember(error: unknown): void {
    if (!(error instanceof Error)) return;
    this.failures.delete(error.message);
    this.failures.set(error.message, error);
    if (this.failures.size > FAILURE_MEMORY) this.failures.delete(this.failures.keys().next().value!);
  }

  private refusal(
    refused: { readonly code: Parameters<typeof printJobCommandErrorFromWire>[0]; readonly message: readonly number[] },
    command: PrintJobCommand | undefined,
  ): PrintJobCommandError {
    return new PrintJobCommandError(
      fromUnits(refused.message),
      printJobCommandErrorFromWire(refused.code),
      command ?? 'pause',
    );
  }

  /** The browser intent an intent of the core stands for, the same object each time. */
  private intent(wire: ProjectPrintJobCommandIntentWire): PrintJobCommandIntent {
    const known = this.intentsById.get(wire.id)?.deref();
    if (known) return known;
    const displayedFilename = optionalTextFromWire(wire.displayedFilename);
    const job = 'value' in wire.job ? wire.job.value : undefined;
    const intent: PrintJobCommandIntent = Object.freeze({
      printerId: fromUnits(wire.printerId),
      printerLabel: fromUnits(wire.printerLabel),
      generation: wire.generation,
      command: printJobCommandFromWire(wire.command),
      observedState: wire.observedState,
      ...(displayedFilename === undefined ? {} : { displayedFilename }),
      ...(job
        ? {
            job: Object.freeze({
              jobId: fromUnits(job.jobId),
              startedAt: job.startedAt,
              filename: fromUnits(job.filename),
              size: job.size,
              modified: job.modified,
            }),
          }
        : {}),
    });
    this.intentIds.set(intent, wire.id);
    this.intentsById.set(wire.id, new WeakRef(intent));
    return intent;
  }

  private selectionFromWire(wire: ProjectPrinterSelectionWire): PrinterSelection {
    const name = optionalTextFromWire(wire.name);
    const apiKey = optionalTextFromWire(wire.apiKey);
    return Object.freeze({
      id: fromUnits(wire.id),
      ...(name === undefined ? {} : { name }),
      endpoint: fromUnits(wire.endpoint),
      port: wire.port,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  }

  private readView(): View {
    const view = decodeProjectPrinterSessionView(this.machine.view());
    return {
      generation: view.generation,
      snapshot: 'value' in view.snapshot ? Object.freeze(printJobSnapshotFromWire(view.snapshot.value)) : null,
      availability: Object.freeze(
        view.availability.map((descriptor) => Object.freeze(printJobCommandDescriptorFromWire(descriptor))),
      ),
    };
  }
}
