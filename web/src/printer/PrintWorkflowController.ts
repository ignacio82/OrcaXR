import {
  preparePrintUpload,
  queryPrintReadiness,
  readPrintFileIdentity,
  samePrintFile,
  submitPrintJob,
  PrintSubmissionError,
  type PrintJobIntent,
  type PrintReadiness,
  type PrintSubmissionPhase,
  type PrintSubmissionRequest,
  type PrintSubmissionResult,
  type PrintSubmissionTransport,
  type PrintUploadPlan,
} from './PrintJobSubmission';
import { queryMoonrakerFilamentSlots, type MoonrakerFilamentSlot } from './MoonrakerFilamentSlots';
import {
  assessPrintStartOptions,
  planPrintPreparation,
  queryPrinterCapabilityReport,
  type PrintStartOption,
  type PrintStartOptionId,
} from './PrintStartOptions';
import { validateToolMapping, type GcodeToolUsage } from './PrintToolMapping';
import { assertStoragePath } from './PrinterStorage';

export interface PrintWorkflowSession {
  readonly printerId: string;
  readonly label: string;
  readonly generation: number;
  readonly transport: PrintSubmissionTransport;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface PrintWorkflowConfirmation {
  readonly mode?: 'stored';
  readonly filename: string;
  readonly plateName: string;
  readonly byteLength: number;
  readonly endpointLabel: string;
  readonly printerStateLabel: string;
  readonly toolSummary: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly startOptions: readonly PrintStartOption[];
  readonly overwrite: PrintUploadPlan['overwrite'] & { readonly filename: string };
}

export type PrintWorkflowDecision =
  | { readonly choice: 'cancel' }
  | {
      readonly choice: 'upload' | 'upload-and-print';
      readonly overwrite: boolean;
      readonly startOptions: readonly PrintStartOptionId[];
    };

export interface PrintWorkflowDependencies {
  captureSession(signal: AbortSignal): Promise<PrintWorkflowSession>;
  confirm(input: PrintWorkflowConfirmation, signal: AbortSignal): Promise<PrintWorkflowDecision>;
  readonly randomBytes?: () => Uint8Array;
}

export interface PrintWorkflowProgress {
  readonly onPhase?: (phase: PrintSubmissionPhase) => void;
  readonly onUploadElapsed?: PrintSubmissionRequest['onUploadElapsed'];
}

interface PrinterFacts {
  readonly readiness: PrintReadiness;
  readonly slots: readonly MoonrakerFilamentSlot[] | undefined;
  readonly options: readonly PrintStartOption[];
  readonly fileManagement: boolean;
}

/** One shared, cancellable owner for DOM and XR submission, including confirmation. */
export class PrintWorkflowController {
  private active: AbortController | null = null;
  private disposed = false;
  private phaseValue: PrintSubmissionPhase | 'idle' | 'cancelled' | 'failed' | 'uncertain' = 'idle';

  constructor(private readonly dependencies: PrintWorkflowDependencies) {}
  get busy(): boolean {
    return this.active !== null;
  }
  get phase() {
    return this.phaseValue;
  }
  cancel(): void {
    this.active?.abort();
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  async run(input: PrintJobIntent, progress: PrintWorkflowProgress = {}): Promise<PrintSubmissionResult | null> {
    if (this.disposed || this.active)
      throw new PrintSubmissionError('A send is unavailable or already pending.', 'stale-context');
    const operation = new AbortController();
    const signal = operation.signal;
    const artifact = Object.freeze({ ...input.artifact });
    const usage: GcodeToolUsage = Object.freeze({
      ...input.usage,
      tools: Object.freeze([...input.usage.tools]),
      declaredColors: Object.freeze([...input.usage.declaredColors]),
      declaredMaterials: Object.freeze([...input.usage.declaredMaterials]),
    });
    const gcode = input.gcode;
    const filename = input.filename;
    const plateName = input.plateName;
    const isCurrent = input.isCurrent;
    this.active = operation;
    let session: PrintWorkflowSession | undefined;
    let uploadedPath: string | undefined;
    const abortSession = () => operation.abort();
    const phase = (value: PrintSubmissionPhase) => {
      this.phaseValue = value;
      progress.onPhase?.(value);
    };
    const assertCurrent = () => {
      if (signal.aborted)
        throw new PrintSubmissionError('The send was cancelled or the printer session changed.', 'cancelled');
      try {
        session?.assertCurrent();
      } catch {
        throw new PrintSubmissionError(
          'The selected printer or connection changed. Confirm a new send.',
          'stale-context',
        );
      }
      if (!isCurrent())
        throw new PrintSubmissionError(
          'The sliced artifact is no longer current. Slice and confirm a new send.',
          'stale-context',
        );
    };
    try {
      phase('checking');
      assertCurrent();
      if (!/^sha256:[a-f0-9]{64}$/.test(artifact.outputHash))
        throw new PrintSubmissionError('The artifact has no exact content identity.', 'stale-context');
      session = await this.dependencies.captureSession(signal);
      session.signal.addEventListener('abort', abortSession, { once: true });
      if (session.signal.aborted) operation.abort();
      assertCurrent();
      const initial = await readFacts(session.transport, signal);
      assertCurrent();
      if (!initial.readiness.known || !initial.fileManagement)
        throw new PrintSubmissionError(
          'The printer must report complete readiness and file-management support before a send can be confirmed.',
          'not-ready',
          initial.readiness.blockers,
        );
      const plan = await preparePrintUpload(session.transport, filename, signal, this.dependencies.randomBytes);
      assertCurrent();
      const mapping = validateToolMapping(usage, initial.slots);
      const initialMapping = mappingIdentity(usage, initial.slots);
      phase('confirming');
      const decision = await waitForDecision(
        this.dependencies.confirm(
          Object.freeze({
            filename: plan.unique,
            plateName,
            byteLength: new Blob([gcode]).size,
            endpointLabel: session.label,
            printerStateLabel: initial.readiness.ready
              ? `ready (${initial.readiness.printState})`
              : initial.readiness.blockers.map((blocker) => blocker.message).join(' '),
            toolSummary: describeTools(usage, initial.slots),
            blockers: Object.freeze([
              ...mapping.blockers.map((notice) => notice.message),
              ...initial.readiness.blockers.map((blocker) => blocker.message),
            ]),
            warnings: Object.freeze(mapping.warnings.map((notice) => notice.message)),
            startOptions: initial.options,
            overwrite: Object.freeze({ ...plan.overwrite, filename: plan.requested }),
          }),
          signal,
        ),
        signal,
      );
      assertCurrent();
      if (decision.choice === 'cancel') {
        this.phaseValue = 'cancelled';
        return null;
      }
      if (decision.choice !== 'upload' && decision.choice !== 'upload-and-print')
        throw new PrintSubmissionError('Confirm a supported send action.', 'stale-context');
      const startPrint = decision.choice === 'upload-and-print';
      const overwrite = decision.overwrite === true;
      const chosen = Object.freeze([...decision.startOptions]);
      const preparation = startPrint ? planPrintPreparation(initial.options, chosen) : [];
      const target = overwrite ? plan.requested : plan.unique;
      const validate: NonNullable<PrintSubmissionRequest['validate']> = async ({ readiness }) => {
        assertCurrent();
        const current = await readFacts(session!.transport, signal, readiness);
        assertCurrent();
        if (!current.fileManagement)
          throw new PrintSubmissionError('The printer no longer reports file-management support.', 'stale-context');
        if (mappingIdentity(usage, current.slots) !== initialMapping)
          throw new PrintSubmissionError(
            'The loaded filament mapping changed after confirmation. Review it and confirm a new send.',
            'stale-context',
          );
        if (startPrint) {
          const mapping = validateToolMapping(usage, current.slots);
          if (mapping.blockers.length)
            throw new PrintSubmissionError(mapping.blockers.map((notice) => notice.message).join(' '), 'not-ready');
          for (const id of chosen) {
            const before = initial.options.find((option) => option.id === id);
            const after = current.options.find((option) => option.id === id);
            if (!before?.available || !after?.available || before.command !== after.command)
              throw new PrintSubmissionError(
                'A chosen preparation option changed after confirmation. Confirm new options before starting.',
                'stale-context',
              );
          }
        }
      };
      const result = await submitPrintJob(session.transport, {
        filename,
        gcode,
        startPrint,
        overwrite,
        preparation,
        uploadPlan: plan,
        checksum: artifact.outputHash.slice('sha256:'.length),
        signal,
        assertCurrent,
        validate,
        onUploadElapsed: progress.onUploadElapsed,
        onPhase: (value) => {
          if (value === 'checking') return;
          if (value === 'verifying') uploadedPath = target;
          phase(value);
        },
      });
      assertCurrent();
      return result;
    } catch (error) {
      const uncertain =
        error instanceof PrintSubmissionError &&
        (error.code === 'preparation-uncertain' || error.code === 'start-uncertain');
      this.phaseValue = uncertain ? 'uncertain' : signal.aborted ? 'cancelled' : 'failed';
      const status = uncertain && session ? await reconcile(session) : undefined;
      const message = error instanceof Error ? error.message : 'The printer did not confirm the send.';
      const retained = uploadedPath ? ` Uploaded file: ${uploadedPath}.` : '';
      const reconciled = status?.known
        ? ` Fresh printer state: ${status.printState}${status.currentFilename ? ` (${status.currentFilename})` : ''}.`
        : uncertain
          ? ' Current printer state could not be verified.'
          : '';
      throw new PrintSubmissionError(
        message + retained + reconciled,
        error instanceof PrintSubmissionError ? error.code : signal.aborted ? 'cancelled' : 'stale-context',
      );
    } finally {
      session?.signal.removeEventListener('abort', abortSession);
      if (this.active === operation) this.active = null;
    }
  }

  /** Reprints share the same operation lock and session-bound confirmation. */
  async startStored(path: string): Promise<string | null> {
    if (this.disposed || this.active)
      throw new PrintSubmissionError('A send is unavailable or already pending.', 'stale-context');
    const filename = assertStoragePath(path, 'That file');
    const operation = new AbortController();
    this.active = operation;
    const signal = operation.signal;
    const abort = () => operation.abort();
    let session: PrintWorkflowSession | undefined;
    const assertCurrent = () => {
      if (signal.aborted) throw new PrintSubmissionError('Print cancelled or printer session changed.', 'cancelled');
      session?.assertCurrent();
    };
    try {
      this.phaseValue = 'checking';
      session = await this.dependencies.captureSession(signal);
      session.signal.addEventListener('abort', abort, { once: true });
      if (session.signal.aborted) operation.abort();
      assertCurrent();
      const readiness = await queryPrintReadiness(session.transport, signal);
      if (!readiness.ready)
        throw new PrintSubmissionError('The printer must report a ready, idle state before reprinting.', 'not-ready');
      const original = await readPrintFileIdentity(session.transport, filename, signal);
      assertCurrent();
      this.phaseValue = 'confirming';
      const decision = await waitForDecision(
        this.dependencies.confirm(
          Object.freeze({
            mode: 'stored',
            filename,
            plateName: 'Stored file',
            byteLength: original.size,
            endpointLabel: session.label,
            printerStateLabel: readiness.printState!,
            toolSummary: 'Use the filament requirements recorded in this stored G-code.',
            blockers: [],
            warnings: ['Check that the loaded filaments match this file before starting.'],
            startOptions: [],
            overwrite: { allowed: false, existing: original, filename },
          }),
          signal,
        ),
        signal,
      );
      assertCurrent();
      if (decision.choice !== 'upload-and-print') {
        this.phaseValue = 'cancelled';
        return null;
      }
      const current = await readPrintFileIdentity(session.transport, filename, signal);
      if (!samePrintFile(original, current))
        throw new PrintSubmissionError(
          'The stored file changed after confirmation. Review it again.',
          'target-changed',
        );
      const fresh = await queryPrintReadiness(session.transport, signal);
      if (!fresh.ready)
        throw new PrintSubmissionError(
          'Printer readiness changed after confirmation. Printing was not started.',
          'not-ready',
        );
      assertCurrent();
      this.phaseValue = 'starting';
      try {
        await session.transport.request(`/printer/print/start?filename=${encodeURIComponent(filename)}`, {
          method: 'POST',
          signal,
          operation: 'start_stored_print',
        });
      } catch {
        throw new PrintSubmissionError(
          'The print-start request has an uncertain outcome. It was not retried.',
          'start-uncertain',
        );
      }
      assertCurrent();
      this.phaseValue = 'completed';
      return filename;
    } catch (error) {
      const uncertain = error instanceof PrintSubmissionError && error.code === 'start-uncertain';
      this.phaseValue = uncertain ? 'uncertain' : signal.aborted ? 'cancelled' : 'failed';
      const status = uncertain && session ? await reconcile(session) : undefined;
      throw new PrintSubmissionError(
        (error instanceof Error ? error.message : 'Reprint failed.') +
          (uncertain
            ? status?.known
              ? ` Fresh printer state: ${status.printState}.`
              : ' Current printer state could not be verified.'
            : ''),
        error instanceof PrintSubmissionError ? error.code : 'stale-context',
      );
    } finally {
      session?.signal.removeEventListener('abort', abort);
      if (this.active === operation) this.active = null;
    }
  }
}

async function readFacts(
  transport: PrintSubmissionTransport,
  signal: AbortSignal,
  readiness?: PrintReadiness,
): Promise<PrinterFacts> {
  const [state, slots, report] = await Promise.all([
    readiness ? Promise.resolve(readiness) : queryPrintReadiness(transport, signal),
    queryMoonrakerFilamentSlots(transport, signal).catch(() => undefined),
    queryPrinterCapabilityReport(transport, signal),
  ]);
  return {
    readiness: state,
    slots,
    options: assessPrintStartOptions(report),
    fileManagement: report.components?.includes('file_manager') === true,
  };
}

function mappingIdentity(usage: GcodeToolUsage, slots: readonly MoonrakerFilamentSlot[] | undefined): string {
  return JSON.stringify(
    usage.tools.map((tool) => {
      const slot = slots?.find((candidate) => candidate.slotIndex === tool);
      return slot ? [tool, slot.material, slot.subType ?? null, slot.vendor, slot.colorHex] : [tool, null];
    }),
  );
}

function describeTools(usage: GcodeToolUsage, slots: readonly MoonrakerFilamentSlot[] | undefined): string {
  const tools = usage.tools.map((tool) => `T${tool}`).join(', ');
  const loaded = slots?.map((slot) => `H${slot.slotIndex + 1}: ${slot.material} ${slot.colorHex}`).join('; ');
  return `${usage.tools.length} tool${usage.tools.length === 1 ? '' : 's'} (${tools})${loaded ? ` · ${loaded}` : ' · loaded filaments not reported'}`;
}

function waitForDecision(answer: Promise<PrintWorkflowDecision>, signal: AbortSignal): Promise<PrintWorkflowDecision> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new PrintSubmissionError('Send cancelled.', 'cancelled'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

/** Reconcile uncertainty using queries only, with a bounded independent cleanup window. */
async function reconcile(session: PrintWorkflowSession): Promise<PrintReadiness | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  session.signal.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    session.assertCurrent();
    return await Promise.race([
      queryPrintReadiness(session.transport, controller.signal),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 3_000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    session.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
