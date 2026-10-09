/**
 * The production `PrintWorkflowController` driven through the hosts' shared
 * effect contract, step by step. A script answers what the controller asks
 * synchronously (is the session or artifact still current, sixteen random
 * bytes) at the moment it asks; everything it awaits — the session, each
 * request and the upload, the operator's decision — is answered later, one
 * input at a time. Each input and the step it produced is recorded, so the
 * Rust core (`orcaxr_printer::workflow`) can be fed the same inputs and must
 * produce the same steps.
 */
import type {
  ProjectGcodeToolUsageWire,
  ProjectPrintSubmissionErrorCodeWire,
  ProjectPrintSubmissionPhaseWire,
  ProjectPrintWorkflowConfirmationWire,
  ProjectPrintWorkflowDecisionWire,
  ProjectPrintWorkflowEffectWire,
  ProjectPrintWorkflowIntentWire,
  ProjectPrintWorkflowOutcomeWire,
  ProjectPrintWorkflowPendingEffectWire,
  ProjectPrintWorkflowStateWire,
  ProjectPrintWorkflowStepWire,
  ProjectPrinterSendWire,
  ProjectPrinterTextWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import { PrintSubmissionError, type PrintJobIntent, type PrintSubmissionTransport } from './PrintJobSubmission';
import { printStartOptionWire } from './PrintPreparationExchange';
import type { PrintStartOptionId } from './PrintStartOptions';
import { toolUsageFromWire } from './PrintToolMappingExchange';
import {
  PrintWorkflowController,
  type PrintWorkflowConfirmation,
  type PrintWorkflowDecision,
  type PrintWorkflowSession,
} from './PrintWorkflowController';
import { PrinterStorageError } from './PrinterStorage';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const text = (value: string | undefined) => (value === undefined ? absent : { value: units(value) });
const camel = (code: string): string => code.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
const moonrakerCode = (wire: string): MoonrakerErrorCode =>
  wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) as MoonrakerErrorCode;
/** What `PrinterSessionController.captureLease` throws once its lease is stale. */
const LEASE_CHANGED = 'The selected printer or connection changed. Confirm a new send.';
/** `reconcile` races its query against this window; the effect carries it as a deadline. */
const RECONCILE_MS = 3000;

export type PrintWorkflowInputWire =
  | { readonly run: ProjectPrintWorkflowIntentWire }
  | { readonly stored: ProjectPrinterTextWire }
  | { readonly resolve: { readonly id: number; readonly outcome: ProjectPrintWorkflowOutcomeWire } }
  | { readonly reply: { readonly id: number; readonly text: string } }
  | { readonly cancel: Record<string, never> }
  | { readonly dispose: Record<string, never> };

export interface PrintWorkflowRecord {
  readonly input: PrintWorkflowInputWire;
  readonly step?: ProjectPrintWorkflowStepWire;
  readonly refused?: string;
}

export interface PrintWorkflowEffectRecord {
  readonly id: number;
  readonly effect: ProjectPrintWorkflowEffectWire;
}

/** Answers a synchronous question when the controller asks it. */
export interface PrintWorkflowScript {
  now(effect: PrintWorkflowEffectRecord): {
    /** Cancel the operation before answering, as an operator pressing Cancel mid-question. */
    readonly cancelFirst?: boolean;
    readonly outcome: ProjectPrintWorkflowOutcomeWire;
  };
}

interface Awaited {
  readonly effect: PrintWorkflowEffectRecord;
  readonly kind: 'capture' | 'transport' | 'confirm';
  readonly operation: string;
  readonly settle: (outcome: { value: unknown } | { error: unknown }) => void;
}

/** What the contract refuses, by the code bindings throw. */
const REFUSED = { unavailable: 'unavailable', notPending: 'not_pending', mismatch: 'mismatch' } as const;
const UNAVAILABLE = 'A send is unavailable or already pending.';

function confirmationWire(input: PrintWorkflowConfirmation): ProjectPrintWorkflowConfirmationWire {
  const existing = input.overwrite.existing;
  return {
    stored: input.mode === 'stored',
    filename: units(input.filename),
    plateName: units(input.plateName),
    byteLength: input.byteLength,
    endpointLabel: units(input.endpointLabel),
    printerStateLabel: units(input.printerStateLabel),
    toolSummary: units(input.toolSummary),
    blockers: input.blockers.map(units),
    warnings: input.warnings.map(units),
    startOptions: input.startOptions.map(printStartOptionWire),
    overwrite: {
      allowed: input.overwrite.allowed,
      existing: existing
        ? { value: { filename: units(existing.filename), size: existing.size, modified: existing.modified } }
        : absent,
      reason: text(input.overwrite.reason),
      filename: units(input.overwrite.filename),
    },
  };
}

function decisionFromWire(wire: ProjectPrintWorkflowDecisionWire): PrintWorkflowDecision {
  if (wire.choice === 'cancel') return { choice: 'cancel' };
  return {
    choice: wire.choice === 'upload' ? 'upload' : 'upload-and-print',
    overwrite: wire.overwrite,
    startOptions: wire.startOptions.map((id): PrintStartOptionId => (id === 'bedLeveling' ? 'bed-leveling' : id)),
  };
}

function failureFromWire(
  outcome: ProjectPrintWorkflowOutcomeWire,
  operation: string,
): MoonrakerTransportError | Error | undefined {
  if (!('failed' in outcome)) return undefined;
  const failure = outcome.failed;
  if (!('value' in failure.code)) return new Error('request failed');
  return new MoonrakerTransportError(moonrakerCode(failure.code.value), operation, {
    ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
    ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
  });
}

/** Settle every pending promise chain the controller started. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

export class PrintWorkflowRecorder {
  readonly records: PrintWorkflowRecord[] = [];
  private readonly flow: PrintWorkflowController;
  private readonly awaiting = new Map<number, Awaited>();
  private nextId = 0;
  private issued: ProjectPrintWorkflowPendingEffectWire[] = [];
  private notices: ProjectPrintSubmissionPhaseWire[] = [];
  private input: PrintWorkflowInputWire | undefined;
  private signal: AbortSignal | undefined;
  private running = false;
  private disposed = false;
  private final: ProjectPrintWorkflowStateWire | undefined;
  private readonly transport: PrintSubmissionTransport;

  constructor(private readonly script: PrintWorkflowScript) {
    this.transport = {
      request: <T>(
        path: string,
        options?: {
          readonly signal?: AbortSignal;
          readonly operation?: string;
          readonly method?: string;
          readonly timeoutMs?: number | null;
        },
      ) => {
        const send: ProjectPrinterSendWire = {
          path: units(path),
          method: units(options?.method ?? 'GET'),
          operation: units(options?.operation ?? ''),
          timeoutMs: typeof options?.timeoutMs === 'number' ? { value: options.timeoutMs } : absent,
        };
        // `reconcile` is the one query not bound to the operation's signal.
        const effect =
          options?.signal === this.signal
            ? { request: send }
            : { reconcile: { ...send, timeoutMs: { value: RECONCILE_MS } } };
        return this.later(effect, 'transport', options?.operation ?? '') as Promise<T>;
      },
      upload: <T>(path: string, body: FormData, options?: { readonly operation?: string }) => {
        const file = body.get('file') as File;
        const keys = [...body.keys()].sort().join(',');
        if (keys !== (body.has('checksum') ? 'checksum,file,path,print,root' : 'file,path,print,root'))
          throw new Error(`Unrecorded upload fields: ${keys}`);
        const checksum = body.get('checksum');
        return this.later(
          {
            upload: {
              path: units(path),
              operation: units(options?.operation ?? ''),
              root: units(String(body.get('root'))),
              directory: units(String(body.get('path'))),
              print: body.get('print') === 'true',
              checksum: typeof checksum === 'string' ? { value: units(checksum) } : absent,
              filename: units(file.name),
              size: file.size,
            },
          },
          'transport',
          options?.operation ?? '',
        ) as Promise<T>;
      },
    };
    this.flow = new PrintWorkflowController({
      captureSession: (signal) => {
        this.signal = signal;
        return this.later({ captureSession: {} }, 'capture', '') as Promise<PrintWorkflowSession>;
      },
      confirm: (input) =>
        this.later({ confirm: confirmationWire(input) }, 'confirm', '') as Promise<PrintWorkflowDecision>,
      randomBytes: () => {
        const outcome = this.now({ random: {} });
        if (!('random' in outcome)) throw new Error('A random draw is answered with bytes');
        return Uint8Array.from(outcome.random);
      },
    });
  }

  get busy(): boolean {
    return this.running;
  }
  /** Effects waiting for an answer, oldest first. */
  pending(): PrintWorkflowEffectRecord[] {
    return [...this.awaiting.values()].map((awaited) => awaited.effect);
  }
  operationOf(id: number): string | undefined {
    return this.awaiting.get(id)?.operation;
  }

  async run(intent: ProjectPrintWorkflowIntentWire): Promise<void> {
    this.input = { run: intent };
    if (this.disposed || this.flow.busy) return this.unavailable(() => this.flow.run(this.job(intent)));
    this.begin();
    this.settle(
      this.flow.run(this.job(intent), { onPhase: (phase) => this.notices.push(phase) }).then((result) =>
        result
          ? {
              submitted: {
                path: units(result.path),
                root: units(result.root),
                uploadedBytes: result.uploadedBytes,
                verifiedBytes: result.verifiedBytes,
                startedPrint: result.startedPrint,
                renamedFrom: text(result.renamedFrom),
              },
            }
          : { declined: {} },
      ),
    );
    await this.close();
  }

  private job(intent: ProjectPrintWorkflowIntentWire): PrintJobIntent {
    const usage: ProjectGcodeToolUsageWire = intent.usage;
    return {
      filename: fromUnits(intent.filename),
      // Only its UTF-8 length is read: by the confirmation, the check for
      // an empty artifact, and the upload's size.
      gcode: 'x'.repeat(intent.byteLength),
      plateName: fromUnits(intent.plateName),
      usage: toolUsageFromWire(usage),
      artifact: {
        outputHash: fromUnits(intent.outputHash),
        sourceRevision: 1,
        sourceHash: 'source',
        sourceAssetHash: 'assets',
        plateId: 'plate',
      },
      isCurrent: () => {
        const outcome = this.now({ artifactCurrent: {} });
        if (!('current' in outcome)) throw new Error('A currency check is answered with a flag');
        return outcome.current;
      },
    };
  }

  async startStored(path: ProjectPrinterTextWire): Promise<void> {
    this.input = { stored: path };
    if (this.disposed || this.flow.busy) return this.unavailable(() => this.flow.startStored(fromUnits(path.text)));
    this.begin();
    this.settle(
      this.flow
        .startStored(fromUnits(path.text))
        .then((started) => (started === null ? { declined: {} } : { started: { text: units(started) } })),
    );
    await this.close();
  }

  async resolve(id: number, outcome: ProjectPrintWorkflowOutcomeWire): Promise<void> {
    this.input = { resolve: { id, outcome } };
    const awaited = this.awaiting.get(id);
    if (!awaited) return this.refuse(REFUSED.notPending);
    const kind = Object.keys(outcome)[0];
    const fits =
      awaited.kind === 'capture'
        ? kind === 'session' || kind === 'sessionFailed'
        : awaited.kind === 'confirm'
          ? kind === 'decision'
          : kind === 'failed';
    if (!fits) return this.refuse(REFUSED.mismatch);
    this.awaiting.delete(id);
    if ('session' in outcome) awaited.settle({ value: this.lease(fromUnits(outcome.session.text)) });
    else if ('sessionFailed' in outcome) awaited.settle({ error: new Error(fromUnits(outcome.sessionFailed.text)) });
    else if ('decision' in outcome) awaited.settle({ value: decisionFromWire(outcome.decision) });
    else awaited.settle({ error: failureFromWire(outcome, awaited.operation) });
    await this.close();
  }

  /** A transport's reply: Moonraker's `result`, as JSON text. */
  async reply(id: number, body: string): Promise<void> {
    this.input = { reply: { id, text: body } };
    const awaited = this.awaiting.get(id);
    if (!awaited) return this.refuse(REFUSED.notPending);
    if (awaited.kind !== 'transport') return this.refuse(REFUSED.mismatch);
    this.awaiting.delete(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      awaited.settle({ error: new MoonrakerTransportError('invalid_response', awaited.operation) });
      await this.close();
      return;
    }
    awaited.settle({ value: parsed });
    await this.close();
  }

  async cancel(): Promise<void> {
    this.input = { cancel: {} };
    this.flow.cancel();
    this.withdraw();
    await this.close();
  }

  async dispose(): Promise<void> {
    this.input = { dispose: {} };
    this.disposed = true;
    this.flow.dispose();
    this.withdraw();
    await this.close();
  }

  /** `waitForDecision` stops listening once the signal aborts; so does the record. */
  private withdraw(): void {
    if (!this.running) return;
    for (const [id, awaited] of this.awaiting) if (awaited.kind === 'confirm') this.awaiting.delete(id);
  }

  private lease(label: string): PrintWorkflowSession {
    return {
      printerId: 'printer',
      label,
      generation: 1,
      transport: this.transport,
      // The session's own lifetime; a lost session reaches the controller as a cancel.
      signal: new AbortController().signal,
      assertCurrent: () => {
        const outcome = this.now({ sessionCurrent: {} });
        if (!('current' in outcome)) throw new Error('A currency check is answered with a flag');
        if (!outcome.current) throw new Error(LEASE_CHANGED);
      },
    };
  }

  /** Before the controller runs: it may ask its first questions synchronously. */
  private begin(): void {
    this.running = true;
    this.final = undefined;
    this.awaiting.clear();
  }

  private settle(operation: Promise<ProjectPrintWorkflowStateWire>): void {
    operation.then(
      (state) => {
        this.final = state;
      },
      (error: unknown) => {
        if (!(error instanceof PrintSubmissionError || error instanceof PrinterStorageError)) throw error;
        this.final = {
          failed: { code: camel(error.code) as ProjectPrintSubmissionErrorCodeWire, message: units(error.message) },
        };
      },
    );
  }

  private issue(effect: ProjectPrintWorkflowEffectWire): PrintWorkflowEffectRecord {
    const record = { id: ++this.nextId, effect };
    this.issued.push(record);
    return record;
  }

  private later(effect: ProjectPrintWorkflowEffectWire, kind: Awaited['kind'], operation: string): Promise<unknown> {
    const record = this.issue(effect);
    return new Promise((resolve, reject) => {
      this.awaiting.set(record.id, {
        effect: record,
        kind,
        operation,
        settle: (outcome) => ('value' in outcome ? resolve(outcome.value) : reject(outcome.error)),
      });
    });
  }

  /**
   * A synchronous question ends the step: the effect is what the step waits
   * on, and the script's answer is the next step's input.
   */
  private now(effect: ProjectPrintWorkflowEffectWire): ProjectPrintWorkflowOutcomeWire {
    const record = this.issue(effect);
    this.push('pending');
    const answer = this.script.now(record);
    if (answer.cancelFirst) {
      this.input = { cancel: {} };
      this.flow.cancel();
      this.push('pending');
    }
    this.input = { resolve: { id: record.id, outcome: answer.outcome } };
    return answer.outcome;
  }

  private refuse(code: string): void {
    this.records.push({ input: this.input!, refused: code });
  }

  /** The controller's own refusal of a second or disposed operation, checked as it is recorded. */
  private async unavailable(attempt: () => Promise<unknown>): Promise<void> {
    const error = await attempt().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof PrintSubmissionError) || error.code !== 'stale-context' || error.message !== UNAVAILABLE)
      throw new Error(`The controller did not refuse the call: ${String(error)}`);
    this.refuse(REFUSED.unavailable);
  }

  private push(state: 'pending' | ProjectPrintWorkflowStateWire): void {
    const settled = state !== 'pending';
    this.records.push({
      input: this.input!,
      step: {
        phase: this.flow.phase,
        phases: this.notices,
        effects: this.issued,
        state: settled ? state : { pending: {} },
      },
    });
    this.notices = [];
    this.issued = [];
  }

  private async close(): Promise<void> {
    await drain();
    if (this.running && this.final) {
      this.running = false;
      this.awaiting.clear();
      this.push(this.final);
    } else {
      this.push(this.running ? 'pending' : { idle: {} });
    }
  }
}
