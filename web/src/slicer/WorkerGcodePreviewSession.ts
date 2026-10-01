import { GCODE_PREVIEW_MODES, projectGcodePreview, type GcodePreviewRequest } from './GcodePreviewModel';
import { GCODE_RECORD_KIND_NAMES, RICH_GCODE_HARD_CAPS } from './RichGcodeModel';
import type { RichGcodeParseOptions } from './RichGcodeModel';
import {
  GCODE_PREVIEW_MOVE_FILTERS,
  GCODE_PREVIEW_WINDOW_RECORD_BUDGET,
  type GcodePreviewSessionPort,
  type GcodePreviewSessionSource,
  type GcodePreviewViewPatch,
  type GcodePreviewViewState,
} from './GcodePreviewSession';
import type { PreviewWorkerRequest, PreviewWorkerResponse, PreviewWorkerSnapshot } from './GcodePreviewWorkerProtocol';

export class PreviewRequestCancelledError extends Error {
  constructor() {
    super('The preview request was superseded or cancelled.');
  }
}
export interface PreviewWorkerPort {
  onmessage: ((event: MessageEvent<PreviewWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: PreviewWorkerRequest): void;
  terminate(): void;
}
interface Pending {
  readonly request: PreviewWorkerRequest;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  cancelled: boolean;
}
export interface WorkerPreviewOptions {
  readonly workerFactory?: () => PreviewWorkerPort;
  readonly deadlineMs?: number;
  readonly parseOptions?: RichGcodeParseOptions;
}

/** One source, one active parse, and at most one coalesced pending view. */
export class WorkerGcodePreviewSession implements GcodePreviewSessionPort {
  private snapshot?: PreviewWorkerSnapshot;
  private active?: Pending;
  private queued?: Pending;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private disposed = false;
  private readonly worker: PreviewWorkerPort;
  private readonly abort: () => void;
  private constructor(
    readonly source: GcodePreviewSessionSource,
    private readonly signal: AbortSignal,
    private readonly options: WorkerPreviewOptions,
  ) {
    this.worker =
      options.workerFactory?.() ?? new Worker(new URL('./gcodePreview.worker.ts', import.meta.url), { type: 'module' });
    this.abort = () => this.dispose();
    signal.addEventListener('abort', this.abort, { once: true });
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = () => this.fail(new Error('The G-code preview worker stopped. Reopen the file to retry.'));
    this.worker.onmessageerror = () => this.fail(new Error('The G-code preview worker returned unreadable data.'));
    if (signal.aborted) this.dispose();
  }
  static async create(
    gcode: string,
    source: GcodePreviewSessionSource,
    signal: AbortSignal,
    options: WorkerPreviewOptions = {},
  ): Promise<WorkerGcodePreviewSession> {
    if (signal.aborted) throw new PreviewRequestCancelledError();
    if (gcode.length > RICH_GCODE_HARD_CAPS.inputCharacters)
      throw new Error('This G-code exceeds the bounded preview input size. Open a smaller artifact to preview it.');
    if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0))
      throw new Error('Preview deadline must be positive.');
    const session = new WorkerGcodePreviewSession(source, signal, options);
    try {
      await session.enqueue({
        version: 1,
        id: ++session.sequence,
        type: 'open',
        gcode,
        source,
        options: options.parseOptions,
      });
      if (signal.aborted) throw new PreviewRequestCancelledError();
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
  get model() {
    return this.current().model;
  }
  get summary() {
    return this.current().summary;
  }
  get layerBounds() {
    return this.current().layerBounds;
  }
  get windowState() {
    return this.current().window;
  }
  getView() {
    return this.current().view;
  }
  windowNotice() {
    return this.current().notice;
  }
  inspect() {
    return this.current().inspection;
  }
  project(request?: Partial<GcodePreviewRequest>) {
    if (!request || Object.keys(request).length === 0) return this.current().projection;
    const mask = new Uint8Array(GCODE_RECORD_KIND_NAMES.length).fill(1);
    for (const filter of GCODE_PREVIEW_MOVE_FILTERS)
      mask[filter.kind] = this.getView().moveVisibility[filter.id] ? 1 : 0;
    return projectGcodePreview(this.model, {
      mode: this.getView().mode,
      layerRange: this.getView().layerRange,
      eventVisibility: mask,
      ...request,
    });
  }
  async updateView(patch: GcodePreviewViewPatch): Promise<GcodePreviewViewState> {
    const previous = this.queued?.request;
    if (previous?.type === 'view')
      patch = {
        ...previous.patch,
        ...patch,
        moveVisibility: { ...previous.patch.moveVisibility, ...patch.moveVisibility },
      };
    await this.enqueue({ version: 1, id: ++this.sequence, type: 'view', patch });
    return this.getView();
  }
  dispose(): void {
    this.fail(new PreviewRequestCancelledError());
  }
  private current(): PreviewWorkerSnapshot {
    if (this.disposed || !this.snapshot) throw new Error('The G-code preview is unavailable.');
    return this.snapshot;
  }
  private enqueue(request: PreviewWorkerRequest): Promise<void> {
    if (this.disposed) return Promise.reject(new PreviewRequestCancelledError());
    return new Promise((resolve, reject) => {
      const pending: Pending = { request, resolve, reject, cancelled: false };
      if (this.active) {
        this.active.cancelled = true;
        this.active.reject(new PreviewRequestCancelledError());
        this.queued?.reject(new PreviewRequestCancelledError());
        this.queued = pending;
      } else this.send(pending);
    });
  }
  private send(pending: Pending): void {
    this.active = pending;
    this.timer = setTimeout(
      () => this.fail(new Error('G-code preview timed out. Reopen the file to retry.')),
      this.options.deadlineMs ?? 120_000,
    );
    try {
      this.worker.postMessage(pending.request);
    } catch {
      this.fail(new Error('Could not send G-code to the preview worker.'));
    }
  }
  private receive(response: PreviewWorkerResponse): void {
    if (this.disposed) return;
    const pending = this.active;
    if (
      !pending ||
      response?.version !== 1 ||
      response.id !== pending.request.id ||
      !['ready', 'error'].includes(response.type)
    ) {
      this.fail(new Error('The G-code preview worker returned an invalid response.'));
      return;
    }
    clearTimeout(this.timer);
    this.active = undefined;
    try {
      if (response.type === 'error')
        throw new Error(
          typeof response.message === 'string' ? response.message.slice(0, 512) : 'G-code preview failed.',
        );
      validateSnapshot(response.snapshot);
      if (!pending.cancelled) {
        this.snapshot = response.snapshot;
        pending.resolve();
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('G-code preview failed.'));
      // Invalid data and parse failures terminate the owner, settling queued work too.
      this.fail(error instanceof Error ? error : new Error('G-code preview failed.'));
      return;
    }
    const next = this.queued;
    this.queued = undefined;
    if (next) this.send(next);
  }
  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.abort);
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    try {
      this.worker.terminate();
    } catch {
      /* Still settle every owner below. */
    }
    this.active?.reject(error);
    this.queued?.reject(error);
    this.active = this.queued = undefined;
    this.snapshot = undefined;
  }
}
function validateSnapshot(snapshot: PreviewWorkerSnapshot): void {
  const invalid = () => {
    throw new Error('The G-code preview worker returned an invalid window.');
  };
  const integer = (value: number, maximum: number) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const range = (value: readonly number[]) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => integer(entry, RICH_GCODE_HARD_CAPS.lines)) &&
    value[0] <= value[1];
  const model = snapshot?.model;
  const count = model?.columns?.count;
  if (
    !integer(count, GCODE_PREVIEW_WINDOW_RECORD_BUDGET) ||
    !integer(model?.pathPoints?.count, RICH_GCODE_HARD_CAPS.pathPoints) ||
    !integer(model.recordOffset ?? 0, 0xffff_ffff - count) ||
    !Array.isArray(model.roles) ||
    model.roles.length > RICH_GCODE_HARD_CAPS.roles ||
    !Array.isArray(model.filaments) ||
    model.filaments.length > RICH_GCODE_HARD_CAPS.filaments ||
    !GCODE_PREVIEW_MODES.some((mode) => mode.id === snapshot.view?.mode) ||
    !range(snapshot.layerBounds) ||
    !range(snapshot.view.layerRange) ||
    !snapshot.view.moveVisibility ||
    typeof snapshot.view.singleLayer !== 'boolean' ||
    !snapshot.projection ||
    !['ready', 'unsupported'].includes(snapshot.projection.status) ||
    snapshot.projection.sourceRecordCount !== count ||
    !Array.isArray(snapshot.projection.limitations) ||
    !snapshot.inspection ||
    snapshot.inspection.sourceRecordCount !== count ||
    !Array.isArray(snapshot.inspection.ticks) ||
    snapshot.inspection.ticks.length > count ||
    !Array.isArray(snapshot.inspection.limitations) ||
    !Array.isArray(snapshot.summary?.perTool) ||
    snapshot.summary.perTool.length > 256
  )
    invalid();
  const columns = model.columns;
  const groups = [
    [Uint8Array, ['kind', 'pathKind']],
    [Uint16Array, ['role', 'tool', 'filament']],
    [Uint32Array, ['layer', 'sourceLine', 'sourceStartOffset', 'sourceEndOffset', 'pathPointOffset', 'pathPointCount']],
    [Int32Array, ['commandLineNumber']],
    [
      Float32Array,
      [
        'startX',
        'startY',
        'startZ',
        'endX',
        'endY',
        'endZ',
        'deltaE',
        'feedrateMmPerSecond',
        'widthMm',
        'heightMm',
        'mm3PerMm',
        'volumetricFlowMm3PerSecond',
        'fanPercent',
        'hotendTemperatureC',
        'arcCenterX',
        'arcCenterY',
      ],
    ],
  ] as const;
  for (const [type, keys] of groups)
    for (const key of keys) {
      const column = columns[key];
      if (
        !(column instanceof type) ||
        column.length !== count ||
        column.buffer.byteLength > GCODE_PREVIEW_WINDOW_RECORD_BUDGET * type.BYTES_PER_ELEMENT
      )
        invalid();
    }
  for (const axis of ['x', 'y', 'z'] as const) {
    const values = model.pathPoints[axis];
    if (
      !(values instanceof Float32Array) ||
      values.length !== model.pathPoints.count ||
      values.buffer.byteLength > RICH_GCODE_HARD_CAPS.pathPoints * 4
    )
      invalid();
  }
  if (snapshot.projection.status === 'ready') {
    const projection = snapshot.projection;
    if (
      !integer(projection.count, count) ||
      !Array.isArray(projection.legend) ||
      !(projection.recordIndices instanceof Uint32Array) ||
      projection.recordIndices.length !== projection.count ||
      !(projection.values instanceof Float32Array) ||
      projection.values.length !== projection.count ||
      !(projection.valueValid instanceof Uint8Array) ||
      projection.valueValid.length !== projection.count ||
      !(projection.colorsRgba instanceof Float32Array) ||
      projection.colorsRgba.length !== projection.count * 4
    )
      invalid();
  } else if (!Array.isArray(snapshot.projection.missingMetadata)) invalid();
}
