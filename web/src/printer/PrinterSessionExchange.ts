/**
 * The production `PrinterSessionController` driven through the hosts' shared
 * session contract. Its transport is scripted: opening one is a question the
 * script answers at once with the transport's state, and every connect,
 * request, recovery command and confirmation dialog is answered later, one
 * input at a time; transport state changes and notifications are inputs too.
 * Each input is recorded with the step it produced and the session's view
 * after it (or, for a query, its reply), so the Rust core
 * (`orcaxr_printer::session`) can be fed the same inputs and must answer the
 * same.
 */
import type {
  ProjectConnectionSignalWire,
  ProjectPrintJobCommandIntentWire,
  ProjectPrintJobCommandWire,
  ProjectPrintJobConfirmReplyWire,
  ProjectPrintJobExecuteRequestWire,
  ProjectPrintJobIntentReplyWire,
  ProjectPrinterSelectionWire,
  ProjectPrinterSessionEffectWire,
  ProjectPrinterSessionLeaseReplyWire,
  ProjectPrinterSessionLeaseWire,
  ProjectPrinterSessionOutcomeWire,
  ProjectPrinterSessionPendingEffectWire,
  ProjectPrinterSessionStepWire,
  ProjectPrinterSessionViewWire,
  ProjectPrinterTaskFinishedWire,
  ProjectPrinterTaskResultWire,
} from '../../../contracts/generated/project-intents';
import {
  MoonrakerTransportError,
  type MoonrakerConnectionState,
  type MoonrakerErrorCode,
  type MoonrakerHandshake,
  type MoonrakerNotification,
} from './MoonrakerTypes';
import type { MoonrakerObjectSubscription } from './MoonrakerTransport';
import { PrintJobCommandError } from './PrintJobControl';
import { PRINT_JOB_OBJECTS } from './PrintJobStatus';
import { printJobSnapshotWire } from './PrintJobStatusExchange';
import {
  printJobCommandDescriptorWire,
  printJobCommandFromWire,
  printJobCommandRefusalWire,
  printJobCommandWire,
} from './PrinterControlExchange';
import {
  PrinterSessionController,
  type PrinterSelection,
  type PrinterSessionLease,
  type PrinterSessionTransport,
  type PrintJobCommandIntent,
  type PrintJobConfirmation,
} from './PrinterSessionController';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const text = (value: string | undefined) => (value === undefined ? absent : { value: units(value) });
const moonrakerCode = (wire: string): MoonrakerErrorCode =>
  wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) as MoonrakerErrorCode;
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

export type PrinterSessionInputWire =
  | { readonly select: ProjectPrinterSelectionWire }
  | { readonly clear: Record<string, never> }
  | { readonly dispose: Record<string, never> }
  | { readonly connect: Record<string, never> }
  | { readonly refresh: Record<string, never> }
  | { readonly execute: ProjectPrintJobExecuteRequestWire }
  | { readonly state: { readonly transport: number; readonly signal: ProjectConnectionSignalWire } }
  | {
      readonly notification: {
        readonly transport: number;
        readonly method: string;
        readonly params: string;
        readonly now: number;
      };
    }
  | { readonly resolve: { readonly id: number; readonly outcome: ProjectPrinterSessionOutcomeWire } }
  | { readonly reply: { readonly id: number; readonly text: string; readonly now: number } }
  | { readonly captureIntent: ProjectPrintJobCommandWire }
  | { readonly confirm: number }
  | { readonly captureLease: Record<string, never> }
  | { readonly leaseCurrent: ProjectPrinterSessionLeaseWire };

export interface PrinterSessionRecord {
  readonly input: PrinterSessionInputWire;
  readonly step?: ProjectPrinterSessionStepWire;
  readonly view?: ProjectPrinterSessionViewWire;
  readonly refused?: string;
  readonly intent?: ProjectPrintJobIntentReplyWire;
  readonly token?: ProjectPrintJobConfirmReplyWire;
  readonly lease?: ProjectPrinterSessionLeaseReplyWire;
  readonly current?: boolean;
}

export interface PrinterSessionEffectRecord {
  readonly id: number;
  readonly effect: ProjectPrinterSessionEffectWire;
}

/** Answers opening a transport, which the controller does synchronously. */
export interface PrinterSessionScript {
  open(effect: PrinterSessionEffectRecord): ProjectConnectionSignalWire;
}

interface Awaited {
  readonly effect: PrinterSessionEffectRecord;
  readonly kind: 'connect' | 'transport' | 'confirm';
  readonly operation: string;
  readonly settle: (outcome: { value: unknown } | { error: unknown }) => void;
}

const REFUSED = { notPending: 'not_pending', mismatch: 'mismatch', disposed: 'disposed' } as const;
/** An intent id this session never issued stands for an intent it never made. */
const forged = (): PrintJobCommandIntent =>
  Object.freeze({
    printerId: 'forged',
    printerLabel: 'forged',
    generation: -1,
    command: 'cancel',
    observedState: 'unknown',
  });

function selectionWire(selection: PrinterSelection): ProjectPrinterSelectionWire {
  return {
    id: units(selection.id),
    name: text(selection.name),
    endpoint: units(selection.endpoint),
    port: selection.port,
    apiKey: text(selection.apiKey),
  };
}
function selectionFromWire(wire: ProjectPrinterSelectionWire): PrinterSelection {
  const name = 'value' in wire.name ? fromUnits(wire.name.value) : undefined;
  const apiKey = 'value' in wire.apiKey ? fromUnits(wire.apiKey.value) : undefined;
  return {
    id: fromUnits(wire.id),
    endpoint: fromUnits(wire.endpoint),
    port: wire.port,
    ...(name === undefined ? {} : { name }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}
/** The fields the controller reads; the rest of a connected state is inert here. */
function connectionState(signal: ProjectConnectionSignalWire): MoonrakerConnectionState {
  const socketEpoch = 'value' in signal.socketEpoch ? signal.socketEpoch.value : undefined;
  return {
    status: signal.status,
    generation: signal.generation,
    ...(socketEpoch === undefined ? {} : { socketEpoch }),
  } as unknown as MoonrakerConnectionState;
}

export class PrinterSessionRecorder {
  readonly records: PrinterSessionRecord[] = [];
  readonly controller: PrinterSessionController<ScriptedTransport>;
  private readonly awaiting = new Map<number, Awaited>();
  private readonly transports = new Map<number, ScriptedTransport>();
  private readonly intents = new Map<number, PrintJobCommandIntent>();
  private readonly intentIds = new Map<PrintJobCommandIntent, number>();
  private readonly tokens = new Map<number, PrintJobConfirmation>();
  private readonly leases: { readonly wire: string; readonly lease: PrinterSessionLease<ScriptedTransport> }[] = [];
  private readonly epochs = new WeakMap<AbortSignal, number>();
  private nextEffect = 0;
  private nextTransport = 0;
  private nextTask = 0;
  private nextIntent = 0;
  private nextToken = 0;
  private nextEpoch = 0;
  private changed = 0;
  private issued: ProjectPrinterSessionPendingEffectWire[] = [];
  private withdrawn: number[] = [];
  private closed: number[] = [];
  private aborted: number[] = [];
  private finished: ProjectPrinterTaskFinishedWire[] = [];
  private task: number | undefined;
  private input: PrinterSessionInputWire | undefined;
  private clock = 0;
  private readonly restore: () => void;

  constructor(private readonly script: PrinterSessionScript) {
    // Epochs are the controller's AbortControllers: number them as they are
    // made, and note each abort, so a step can say which epochs ended.
    const Native = globalThis.AbortController;
    const now = Date.now;
    const made = (signal: AbortSignal) => {
      const epoch = this.nextEpoch++;
      this.epochs.set(signal, epoch);
      signal.addEventListener('abort', () => this.aborted.push(epoch), { once: true });
    };
    class Epoch extends Native {
      constructor() {
        super();
        made(this.signal);
      }
    }
    globalThis.AbortController = Epoch;
    Date.now = () => this.clock;
    this.restore = () => {
      globalThis.AbortController = Native;
      Date.now = now;
    };
    this.controller = new PrinterSessionController((selection) => this.open(selection));
    this.controller.subscribe(() => this.changed++);
  }

  /** Put back the global clock and AbortController. */
  close(): void {
    this.restore();
  }

  pending(): PrinterSessionEffectRecord[] {
    return [...this.awaiting.values()].map((awaited) => awaited.effect);
  }
  operationOf(id: number): string | undefined {
    return this.awaiting.get(id)?.operation;
  }

  // --- Inputs that step ------------------------------------------------------------------

  async select(selection: ProjectPrinterSelectionWire): Promise<void> {
    this.input = { select: selection };
    try {
      this.controller.select(selectionFromWire(selection));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Printer session is disposed.') throw error;
      return this.refuse(REFUSED.disposed);
    }
    await this.finish();
  }
  async clear(): Promise<void> {
    this.input = { clear: {} };
    this.controller.clear();
    await this.finish();
  }
  async dispose(): Promise<void> {
    this.input = { dispose: {} };
    this.controller.dispose();
    await this.finish();
  }
  async connect(): Promise<void> {
    this.input = { connect: {} };
    this.start(this.controller.connect());
    await this.finish();
  }
  async refresh(): Promise<void> {
    this.input = { refresh: {} };
    this.start(this.controller.refresh());
    await this.finish();
  }
  async execute(request: ProjectPrintJobExecuteRequestWire): Promise<void> {
    this.input = { execute: request };
    const intent = this.intents.get(request.intent) ?? forged();
    const confirmation = request.confirmation;
    this.start(
      this.controller.execute(
        intent,
        'token' in confirmation
          ? (this.tokens.get(confirmation.token) ?? ({ intent } as PrintJobConfirmation))
          : 'dialog' in confirmation
            ? (asked, signal) =>
                this.later({ confirmCommand: this.intentWire(asked) }, 'confirm', '', signal) as Promise<boolean>
            : undefined,
      ),
    );
    await this.finish();
  }
  async state(transport: number, signal: ProjectConnectionSignalWire): Promise<void> {
    this.input = { state: { transport, signal } };
    this.transports.get(transport)?.transition(connectionState(signal));
    await this.finish();
  }
  async notification(transport: number, method: string, params: string, now: number): Promise<void> {
    this.input = { notification: { transport, method, params, now } };
    this.clock = now;
    this.transports.get(transport)?.notify({
      method,
      params: JSON.parse(params),
      receivedAtMs: now,
      generation: 0,
      socketEpoch: 0,
    });
    await this.finish();
  }
  async resolve(id: number, outcome: ProjectPrinterSessionOutcomeWire): Promise<void> {
    this.input = { resolve: { id, outcome } };
    const awaited = this.awaiting.get(id);
    if (!awaited) return this.refuse(REFUSED.notPending);
    const fits =
      awaited.kind === 'connect'
        ? 'connected' in outcome || 'failed' in outcome
        : awaited.kind === 'confirm'
          ? 'confirmed' in outcome
          : 'failed' in outcome;
    if (!fits) return this.refuse(REFUSED.mismatch);
    this.awaiting.delete(id);
    if ('connected' in outcome) awaited.settle({ value: {} as MoonrakerHandshake });
    else if ('confirmed' in outcome) awaited.settle({ value: outcome.confirmed });
    else if ('failed' in outcome) {
      const failure = outcome.failed;
      awaited.settle({
        error:
          'value' in failure.code
            ? new MoonrakerTransportError(moonrakerCode(failure.code.value), awaited.operation, {
                ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
                ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
              })
            : new Error('request failed'),
      });
    }
    await this.finish();
  }
  /** A request's reply: Moonraker's `result`, as JSON text, received at `now`. */
  async reply(id: number, body: string, now: number): Promise<void> {
    this.input = { reply: { id, text: body, now } };
    this.clock = now;
    const awaited = this.awaiting.get(id);
    if (!awaited) return this.refuse(REFUSED.notPending);
    if (awaited.kind !== 'transport') return this.refuse(REFUSED.mismatch);
    this.awaiting.delete(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      awaited.settle({ error: new MoonrakerTransportError('invalid_response', awaited.operation) });
      await this.finish();
      return;
    }
    awaited.settle({ value: parsed });
    await this.finish();
  }

  // --- Queries ---------------------------------------------------------------------------

  captureIntent(command: ProjectPrintJobCommandWire): void {
    let reply: ProjectPrintJobIntentReplyWire;
    try {
      const intent = this.controller.captureIntent(printJobCommandFromWire(command));
      const id = ++this.nextIntent;
      this.intents.set(id, intent);
      this.intentIds.set(intent, id);
      reply = { intent: this.intentWire(intent) };
    } catch (error) {
      reply = { refused: printJobCommandRefusalWire(error) };
    }
    this.records.push({ input: { captureIntent: command }, intent: reply });
  }
  confirm(id: number): void {
    let reply: ProjectPrintJobConfirmReplyWire;
    try {
      const confirmation = this.controller.confirm(this.intents.get(id) ?? forged());
      const token = ++this.nextToken;
      this.tokens.set(token, confirmation);
      reply = { token };
    } catch (error) {
      reply = { refused: printJobCommandRefusalWire(error) };
    }
    this.records.push({ input: { confirm: id }, token: reply });
  }
  captureLease(): void {
    let reply: ProjectPrinterSessionLeaseReplyWire;
    try {
      const lease = this.controller.captureLease();
      const wire: ProjectPrinterSessionLeaseWire = {
        printerId: units(lease.printerId),
        label: units(lease.label),
        generation: lease.generation,
        transport: lease.transport.id,
      };
      this.leases.push({ wire: JSON.stringify(wire), lease });
      reply = { lease: wire };
    } catch (error) {
      reply = { refused: { text: units((error as Error).message) } };
    }
    this.records.push({ input: { captureLease: {} }, lease: reply });
  }
  leaseCurrent(wire: ProjectPrinterSessionLeaseWire): void {
    const found = this.leases.find((entry) => entry.wire === JSON.stringify(wire));
    if (!found) throw new Error('Only a captured lease can be checked');
    let current = true;
    try {
      found.lease.assertCurrent();
    } catch {
      current = false;
    }
    this.records.push({ input: { leaseCurrent: wire }, current });
  }

  // --- The scripted transport's side ----------------------------------------------------------

  private open(selection: PrinterSelection): ScriptedTransport {
    const id = ++this.nextTransport;
    const record = this.issue({ openTransport: { transport: id, selection: selectionWire(selection) } });
    this.push();
    const signal = this.script.open(record);
    this.input = { resolve: { id: record.id, outcome: { state: signal } } };
    const transport = new ScriptedTransport(this, id, connectionState(signal));
    this.transports.set(id, transport);
    return transport;
  }

  /** @internal */
  later(
    effect: ProjectPrinterSessionEffectWire,
    kind: Awaited['kind'],
    operation: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('An effect issued on an aborted epoch is unrecorded');
    const record = this.issue(effect);
    return new Promise((resolve, reject) => {
      const settle = (outcome: { value: unknown } | { error: unknown }) =>
        'value' in outcome ? resolve(outcome.value) : reject(outcome.error);
      this.awaiting.set(record.id, { effect: record, kind, operation, settle });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.awaiting.delete(record.id)) return;
          this.withdrawn.push(record.id);
          // The transport fails what an aborted signal carried; a dialog is
          // dropped by the controller itself.
          if (kind === 'transport') reject(new MoonrakerTransportError('cancelled', operation));
        },
        { once: true },
      );
    });
  }
  /** @internal */
  epochOf(signal: AbortSignal | undefined): number {
    const epoch = signal && this.epochs.get(signal);
    if (epoch === undefined) throw new Error('A request outside any epoch');
    return epoch;
  }
  /** @internal */
  transportClosed(id: number): void {
    this.closed.push(id);
  }

  private intentWire(intent: PrintJobCommandIntent): ProjectPrintJobCommandIntentWire {
    const job = intent.job;
    return {
      id: this.intentIds.get(intent) ?? 0,
      printerId: units(intent.printerId),
      printerLabel: units(intent.printerLabel),
      generation: intent.generation,
      command: printJobCommandWire(intent.command),
      displayedFilename: text(intent.displayedFilename),
      observedState: intent.observedState,
      job: job
        ? {
            value: {
              jobId: units(job.jobId),
              startedAt: job.startedAt,
              filename: units(job.filename),
              size: job.size,
              modified: job.modified,
            },
          }
        : absent,
    };
  }

  private start(task: Promise<unknown>): void {
    const id = ++this.nextTask;
    this.task = id;
    task.then(
      () => this.finished.push({ task: id, result: { done: {} } }),
      (error: unknown) => {
        const result: ProjectPrinterTaskResultWire =
          error instanceof PrintJobCommandError
            ? { refused: printJobCommandRefusalWire(error) }
            : { failed: { text: units(error instanceof Error ? error.message : String(error)) } };
        this.finished.push({ task: id, result });
      },
    );
  }

  private issue(effect: ProjectPrinterSessionEffectWire): PrinterSessionEffectRecord {
    const record = { id: ++this.nextEffect, effect };
    this.issued.push(record);
    return record;
  }

  private refuse(code: string): void {
    this.records.push({ input: this.input!, refused: code });
  }

  private view(): ProjectPrinterSessionViewWire {
    const snapshot = this.controller.snapshot;
    return {
      generation: this.controller.generation,
      snapshot: snapshot ? { value: printJobSnapshotWire(snapshot) } : absent,
      availability: this.controller.availability().map(printJobCommandDescriptorWire),
    };
  }

  private push(): void {
    this.records.push({
      input: this.input!,
      step: {
        changed: this.changed,
        effects: this.issued,
        withdrawn: this.withdrawn,
        closed: this.closed,
        aborted: this.aborted,
        task: this.task === undefined ? absent : { value: this.task },
        // Tasks woken together finish in an order set by promise depth; the
        // contract lists them by task.
        finished: [...this.finished].sort((a, b) => a.task - b.task),
      },
      view: this.view(),
    });
    this.changed = 0;
    this.issued = [];
    this.withdrawn = [];
    this.closed = [];
    this.aborted = [];
    this.finished = [];
    this.task = undefined;
  }

  private async finish(): Promise<void> {
    await drain();
    this.push();
  }
}

/** A transport whose every exchange is an effect of the recorder. */
class ScriptedTransport implements PrinterSessionTransport {
  private readonly stateListeners = new Set<(state: MoonrakerConnectionState) => void>();
  private readonly notificationListeners = new Set<(notification: MoonrakerNotification) => void>();
  constructor(
    private readonly recorder: PrinterSessionRecorder,
    readonly id: number,
    public state: MoonrakerConnectionState,
  ) {}
  connect(): Promise<MoonrakerHandshake> {
    return this.recorder.later(
      { connect: { transport: this.id } },
      'connect',
      'connect',
    ) as Promise<MoonrakerHandshake>;
  }
  dispose(): void {
    this.recorder.transportClosed(this.id);
  }
  setObjectSubscription(subscription: MoonrakerObjectSubscription | null): void {
    if (subscription !== PRINT_JOB_OBJECTS) throw new Error('The session subscribes to exactly the status objects');
  }
  subscribeState(listener: (state: MoonrakerConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }
  subscribeNotifications(listener: (notification: MoonrakerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  transition(state: MoonrakerConnectionState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
  notify(notification: MoonrakerNotification): void {
    for (const listener of [...this.notificationListeners]) listener(notification);
  }
  requestRecoveryCommand(command: 'emergency-stop' | 'firmware-restart', signal?: AbortSignal): Promise<unknown> {
    return this.recorder.later(
      { recovery: { transport: this.id, epoch: this.recorder.epochOf(signal), command: printJobCommandWire(command) } },
      'transport',
      command,
      signal,
    );
  }
  request<T>(
    path: string,
    options?: { readonly signal?: AbortSignal; readonly operation?: string; readonly method?: string },
  ): Promise<T> {
    return this.recorder.later(
      {
        request: {
          transport: this.id,
          epoch: this.recorder.epochOf(options?.signal),
          send: {
            path: units(path),
            method: units(options?.method ?? 'GET'),
            operation: units(options?.operation ?? ''),
            timeoutMs: absent,
          },
        },
      },
      'transport',
      options?.operation ?? '',
      options?.signal,
    ) as Promise<T>;
  }
}
