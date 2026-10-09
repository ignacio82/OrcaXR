/**
 * The send workflow run by the shared core (`orcaxr_printer::workflow`
 * through the printer WASM): readiness, file management, the confirmation,
 * the unique upload name, the upload and its verification, preparation and
 * the start, with the submission policy the Android app runs. This class does
 * only what a browser must — capture the printer session, ask the operator,
 * send requests and the upload over the session's transport, draw random
 * bytes, and say whether the artifact and session are still current — and
 * translates between the contract and the browser's types. Its public surface
 * is `PrintWorkflowController`'s, which stays as the reference the core is
 * replayed against and as the rollback adapter.
 *
 * Steps apply in the order the core produced them; a question the core asks
 * synchronously (a random draw, whether the artifact or session is current)
 * is answered at once, as the browser controller asks it inline.
 */
import {
  decodeProjectPrintWorkflowStep,
  encodeProjectPrintWorkflowIntent,
  encodeProjectPrintWorkflowOutcome,
  encodeProjectPrinterText,
  type ProjectPrintWorkflowConfirmationWire,
  type ProjectPrintWorkflowEffectWire,
  type ProjectPrintWorkflowOutcomeWire,
  type ProjectPrintWorkflowStateWire,
  type ProjectPrintWorkflowStepWire,
  type ProjectPrinterSendWire,
  type ProjectPrinterUploadWire,
  type ProjectTransportFailureWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError } from './MoonrakerTypes';
import {
  PrintSubmissionError,
  type PrintJobIntent,
  type PrintSubmissionPhase,
  type PrintSubmissionResult,
} from './PrintJobSubmission';
import type { PrintStartOption, PrintStartOptionId } from './PrintStartOptions';
import { PrinterStorageError } from './PrinterStorage';
import type {
  PrintWorkflow,
  PrintWorkflowConfirmation,
  PrintWorkflowDecision,
  PrintWorkflowDependencies,
  PrintWorkflowProgress,
  PrintWorkflowSession,
} from './PrintWorkflowController';
import { fromUnits, optionalTextFromWire, optionalTextWire, units } from './PrinterWire';

/** The shared core's send workflow, as the WASM binding exposes it. */
export interface PrintWorkflowMachine {
  busy(): boolean;
  run(intent: string): string;
  start_stored(path: string): string;
  resolve(id: number, outcome: string): string;
  resolve_reply(id: number, text: string): string;
  cancel(): string;
  dispose(): string;
}

/** What the workflow needs from the loaded shared core. */
export interface PrintWorkflowCore {
  readonly PrintWorkflow: new () => PrintWorkflowMachine;
}

type Step = ProjectPrintWorkflowStepWire;
type Phase = PrintWorkflow['phase'];

const absent = { absent: {} } as const;
const camel = (code: string): string => code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (code: string): string => code.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const UNAVAILABLE = 'A send is unavailable or already pending.';
const START_OPTION: Readonly<Record<string, PrintStartOptionId>> = {
  bedLeveling: 'bed-leveling',
  timelapse: 'timelapse',
};
const START_OPTION_WIRE: Readonly<Record<PrintStartOptionId, 'bedLeveling' | 'timelapse'>> = {
  'bed-leveling': 'bedLeveling',
  timelapse: 'timelapse',
};

/** What the core reads of a failed exchange: its Moonraker code, status and detail. */
function failureWire(error: unknown): ProjectTransportFailureWire {
  if (!(error instanceof MoonrakerTransportError)) return { code: absent, httpStatus: absent, detail: absent };
  return {
    code: { value: camel(error.code) as never },
    httpStatus: error.httpStatus === undefined ? absent : { value: error.httpStatus },
    detail: optionalTextWire(error.detail),
  };
}

function confirmationFromWire(wire: ProjectPrintWorkflowConfirmationWire): PrintWorkflowConfirmation {
  const existing = 'value' in wire.overwrite.existing ? wire.overwrite.existing.value : undefined;
  const reason = optionalTextFromWire(wire.overwrite.reason);
  return Object.freeze({
    ...(wire.stored ? { mode: 'stored' as const } : {}),
    filename: fromUnits(wire.filename),
    plateName: fromUnits(wire.plateName),
    byteLength: wire.byteLength,
    endpointLabel: fromUnits(wire.endpointLabel),
    printerStateLabel: fromUnits(wire.printerStateLabel),
    toolSummary: fromUnits(wire.toolSummary),
    blockers: Object.freeze(wire.blockers.map(fromUnits)),
    warnings: Object.freeze(wire.warnings.map(fromUnits)),
    startOptions: Object.freeze(
      wire.startOptions.map((option): PrintStartOption => {
        const command = optionalTextFromWire(option.command);
        return Object.freeze({
          id: START_OPTION[option.id]!,
          label: fromUnits(option.label),
          detail: fromUnits(option.detail),
          available: option.available,
          reason: fromUnits(option.reason),
          defaultEnabled: option.defaultEnabled,
          ...(command === undefined ? {} : { command }),
        });
      }),
    ),
    overwrite: Object.freeze({
      allowed: wire.overwrite.allowed,
      existing: existing
        ? Object.freeze({ filename: fromUnits(existing.filename), size: existing.size, modified: existing.modified })
        : null,
      ...(reason === undefined ? {} : { reason }),
      filename: fromUnits(wire.overwrite.filename),
    }),
  });
}

function decisionOutcome(decision: PrintWorkflowDecision): ProjectPrintWorkflowOutcomeWire {
  if (decision.choice === 'cancel') return { decision: { choice: 'cancel', overwrite: false, startOptions: [] } };
  return {
    decision: {
      choice: decision.choice === 'upload' ? 'upload' : 'uploadAndPrint',
      overwrite: decision.overwrite === true,
      startOptions: decision.startOptions.map((id) => START_OPTION_WIRE[id]),
    },
  };
}

/** The error a failed operation rejects with, of the class the browser throws it as. */
function failure(code: string, message: string): Error {
  const kebabCode = kebab(code);
  if (kebabCode === 'invalid-target') return new PrinterStorageError(message, 'invalid-target');
  return new PrintSubmissionError(message, kebabCode as ConstructorParameters<typeof PrintSubmissionError>[1]);
}

interface Operation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Aborts what the operation started: its requests, upload, dialog and session capture. */
  readonly controller: AbortController;
  readonly progress: PrintWorkflowProgress;
  readonly intent?: PrintJobIntent;
  readonly bytes?: Uint8Array;
  lease?: PrintWorkflowSession;
  releaseLease?: () => void;
  stopTicking?: () => void;
}

export class SharedPrintWorkflow implements PrintWorkflow {
  private readonly machine: PrintWorkflowMachine;
  private operation: Operation | null = null;
  private phaseValue: Phase = 'idle';
  private readonly queue: Step[] = [];
  private draining = false;

  constructor(
    core: PrintWorkflowCore,
    private readonly dependencies: PrintWorkflowDependencies,
  ) {
    this.machine = new core.PrintWorkflow();
  }

  get busy(): boolean {
    return this.operation !== null;
  }
  get phase(): Phase {
    return this.phaseValue;
  }

  cancel(): void {
    const operation = this.operation;
    if (!operation) return;
    operation.controller.abort();
    this.input(() => this.machine.cancel());
  }

  dispose(): void {
    this.operation?.controller.abort();
    this.input(() => this.machine.dispose());
  }

  run(input: PrintJobIntent, progress: PrintWorkflowProgress = {}): Promise<PrintSubmissionResult | null> {
    const bytes = new TextEncoder().encode(input.gcode);
    const intent = encodeProjectPrintWorkflowIntent({
      filename: units(input.filename),
      byteLength: bytes.byteLength,
      plateName: units(input.plateName),
      usage: {
        tools: [...input.usage.tools],
        multiMaterial: input.usage.multiMaterial,
        declaredColors: input.usage.declaredColors.map(units),
        declaredMaterials: input.usage.declaredMaterials.map(units),
      },
      outputHash: units(input.artifact.outputHash),
    });
    return this.start(() => this.machine.run(intent), {
      progress,
      intent: input,
      bytes,
    }) as Promise<PrintSubmissionResult | null>;
  }

  startStored(path: string): Promise<string | null> {
    const wire = encodeProjectPrinterText({ text: units(path) });
    return this.start(() => this.machine.start_stored(wire), { progress: {} }) as Promise<string | null>;
  }

  private start(call: () => string, context: Pick<Operation, 'progress' | 'intent' | 'bytes'>): Promise<unknown> {
    if (this.operation) return Promise.reject(new PrintSubmissionError(UNAVAILABLE, 'stale-context'));
    let json: string;
    try {
      json = call();
    } catch (error) {
      if (error === 'unavailable') return Promise.reject(new PrintSubmissionError(UNAVAILABLE, 'stale-context'));
      return Promise.reject(error);
    }
    const settled = new Promise<unknown>((resolve, reject) => {
      this.operation = { resolve, reject, controller: new AbortController(), ...context };
    });
    this.apply(decodeProjectPrintWorkflowStep(json));
    return settled;
  }

  /** An answer from outside; one the core no longer awaits changes nothing. */
  private input(call: () => string): void {
    let json: string;
    try {
      json = call();
    } catch (error) {
      if (error === 'not_pending' || error === 'mismatch') return;
      throw error;
    }
    this.apply(decodeProjectPrintWorkflowStep(json));
  }

  private answer(id: number, outcome: ProjectPrintWorkflowOutcomeWire): void {
    this.input(() => this.machine.resolve(id, encodeProjectPrintWorkflowOutcome(outcome)));
  }

  private apply(step: Step): void {
    this.queue.push(step);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) this.run1(next);
    } finally {
      this.draining = false;
    }
  }

  private run1(step: Step): void {
    const operation = this.operation;
    this.phaseValue = step.phase;
    for (const phase of step.phases) operation?.progress.onPhase?.(phase as PrintSubmissionPhase);
    let answered: string | undefined;
    for (const { id, effect } of step.effects) answered = this.carryOut(id, effect, operation) ?? answered;
    // In the order the core produced it: a cancel the question itself caused
    // (a session check can cancel) came first.
    if (answered !== undefined) this.queue.push(decodeProjectPrintWorkflowStep(answered));
    this.settle(step.state, operation);
  }

  /** Carries out effect `id`; a synchronous question answers at once, with the core's next step. */
  private carryOut(
    id: number,
    effect: ProjectPrintWorkflowEffectWire,
    operation: Operation | null,
  ): string | undefined {
    const resolve = (outcome: ProjectPrintWorkflowOutcomeWire) =>
      this.machine.resolve(id, encodeProjectPrintWorkflowOutcome(outcome));
    if (!operation) return undefined;
    const signal = operation.controller.signal;
    if ('random' in effect) {
      const draw = this.dependencies.randomBytes ?? (() => globalThis.crypto.getRandomValues(new Uint8Array(16)));
      return resolve({ random: [...draw()] });
    }
    if ('artifactCurrent' in effect) {
      let current: boolean;
      try {
        current = operation.intent?.isCurrent() ?? false;
      } catch {
        current = false;
      }
      return resolve({ current });
    }
    if ('sessionCurrent' in effect) {
      let current = true;
      try {
        operation.lease?.assertCurrent();
      } catch {
        current = false;
      }
      return resolve({ current: current && operation.lease !== undefined });
    }
    if ('captureSession' in effect) {
      this.dependencies.captureSession(signal).then(
        (lease) => {
          if (this.operation !== operation) return;
          operation.lease = lease;
          // A lost session reaches the core as a cancel, before its answer.
          const lost = () => this.cancel();
          lease.signal.addEventListener('abort', lost, { once: true });
          operation.releaseLease = () => lease.signal.removeEventListener('abort', lost);
          if (lease.signal.aborted) this.cancel();
          this.answer(id, { session: { text: units(lease.label) } });
        },
        (error: unknown) =>
          this.answer(id, { sessionFailed: { text: units(error instanceof Error ? error.message : String(error)) } }),
      );
      return undefined;
    }
    if ('confirm' in effect) {
      let asked: Promise<PrintWorkflowDecision>;
      try {
        asked = this.dependencies.confirm(confirmationFromWire(effect.confirm), signal);
      } catch (error) {
        asked = Promise.reject(error);
      }
      asked.then(
        (decision) => this.answer(id, decisionOutcome(decision)),
        // A dialog that fails sent nothing: it reads as a cancelled send.
        () => this.answer(id, decisionOutcome({ choice: 'cancel' })),
      );
      return undefined;
    }
    if ('request' in effect) {
      this.exchange(id, operation, (transport) => transport.request<unknown>(...this.send(effect.request, signal)));
      return undefined;
    }
    if ('reconcile' in effect) {
      // Not bound to the operation: it carries its own deadline and survives a cancel.
      this.exchange(id, operation, (transport) => transport.request<unknown>(...this.send(effect.reconcile)));
      return undefined;
    }
    this.upload(id, effect.upload, operation, signal);
    return undefined;
  }

  private send(
    send: ProjectPrinterSendWire,
    signal?: AbortSignal,
  ): [string, { signal?: AbortSignal; method?: string; operation?: string; timeoutMs?: number }] {
    const method = fromUnits(send.method);
    const operation = fromUnits(send.operation);
    return [
      fromUnits(send.path),
      {
        ...(signal ? { signal } : {}),
        ...(method === 'GET' ? {} : { method }),
        ...(operation ? { operation } : {}),
        ...('value' in send.timeoutMs ? { timeoutMs: send.timeoutMs.value } : {}),
      },
    ];
  }

  private upload(id: number, upload: ProjectPrinterUploadWire, operation: Operation, signal: AbortSignal): void {
    const bytes = operation.bytes ?? new Uint8Array(0);
    const form = new FormData();
    form.set('root', fromUnits(upload.root));
    form.set('path', fromUnits(upload.directory));
    form.set('print', upload.print ? 'true' : 'false');
    const checksum = optionalTextFromWire(upload.checksum);
    if (checksum !== undefined) form.set('checksum', checksum);
    form.set('file', new Blob([bytes as BlobPart], { type: 'text/plain' }), fromUnits(upload.filename));
    // Elapsed time while the bytes go out: a large upload must not look hung.
    const onElapsed = operation.progress.onUploadElapsed;
    if (onElapsed) {
      const startedAt = Date.now();
      const handle = setInterval(() => onElapsed({ elapsedMs: Date.now() - startedAt, totalBytes: upload.size }), 1000);
      (handle as unknown as { unref?: () => void }).unref?.();
      operation.stopTicking = () => clearInterval(handle);
    }
    const operationName = fromUnits(upload.operation);
    this.exchange(
      id,
      operation,
      (transport) =>
        transport.upload<unknown>(fromUnits(upload.path), form, {
          ...(operationName ? { operation: operationName } : {}),
          timeoutMs: null,
          signal,
        }),
      () => operation.stopTicking?.(),
    );
  }

  /** A request or upload over the session's transport: its reply (`result`, as JSON) or failure. */
  private exchange(
    id: number,
    operation: Operation,
    send: (transport: PrintWorkflowSession['transport']) => Promise<unknown>,
    done?: () => void,
  ): void {
    let sent: Promise<unknown>;
    try {
      sent = send(operation.lease!.transport);
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      (result) => {
        done?.();
        this.input(() => this.machine.resolve_reply(id, JSON.stringify(result) ?? 'null'));
      },
      (error: unknown) => {
        done?.();
        this.answer(id, { failed: failureWire(error) });
      },
    );
  }

  private settle(state: ProjectPrintWorkflowStateWire, operation: Operation | null): void {
    if ('pending' in state || !operation || this.operation !== operation) return;
    this.operation = null;
    operation.stopTicking?.();
    operation.releaseLease?.();
    if ('submitted' in state) {
      const result = state.submitted;
      const renamedFrom = optionalTextFromWire(result.renamedFrom);
      operation.resolve({
        path: fromUnits(result.path),
        root: fromUnits(result.root),
        uploadedBytes: result.uploadedBytes,
        verifiedBytes: result.verifiedBytes,
        startedPrint: result.startedPrint,
        ...(renamedFrom === undefined ? {} : { renamedFrom }),
      } satisfies PrintSubmissionResult);
    } else if ('started' in state) operation.resolve(fromUnits(state.started.text));
    else if ('declined' in state || 'idle' in state) operation.resolve(null);
    else operation.reject(failure(state.failed.code, fromUnits(state.failed.message)));
  }
}
