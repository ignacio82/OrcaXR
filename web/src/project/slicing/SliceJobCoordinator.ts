import { canonicalStringify, cloneJson, deepFreeze } from '../domain/canonical';
import type { PlateId } from '../domain/ids';
import type { CancellationToken, ProjectSerializerPort, SerializedProject } from '../ports';
import { Sha256SliceContentHasher } from './hash';
import { projectPlateArchiveForSlice } from './plateProjection';
import {
  CanonicalSlicePreflightValidator,
  type CanonicalSlicePreflightPort,
  type CanonicalSlicePreflightResult,
} from './preflight';
import { validatedSnapshot } from './source';
import {
  SLICE_PROTOCOL_VERSION,
  type CanonicalProjectSliceGuard,
  type CanonicalProjectSliceSnapshot,
  type CanonicalProjectSliceSourcePort,
  type CanonicalSliceJobResult,
  type SliceContentHasherPort,
  type SliceJobHandle,
  type SliceJobOptions,
  type SliceJobPhase,
  type SliceJobScope,
  type SliceJobStatus,
  type SliceJobSubscriber,
  type SliceFilamentProfileReference,
  type SlicePlateResult,
  type SliceProfileReference,
  type SliceProfileSnapshot,
  type SliceProfileResolverPort,
  type SliceResultPublisherPort,
  type SliceRouteAdapterPort,
  type SliceRouteMetadata,
  type SliceRouteProgress,
  type SliceRouteRequest,
  type SliceRouteResponse,
} from './types';

export class SliceJobCancelledError extends Error {
  constructor(message = 'Slice job cancelled') {
    super(message);
    this.name = 'SliceJobCancelledError';
  }
}

export class SliceJobTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs} ms`);
    this.name = 'SliceJobTimeoutError';
  }
}

export class StaleSliceCompletionError extends Error {
  constructor() {
    super('Slice completed for a stale canonical project or asset bundle');
    this.name = 'StaleSliceCompletionError';
  }
}

export class SupersededSliceJobError extends Error {
  constructor() {
    super('Slice job was superseded by a newer job for the same plate');
    this.name = 'SupersededSliceJobError';
  }
}

export class SliceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SliceProtocolError';
  }
}

export class SlicePreflightError extends Error {
  readonly result: CanonicalSlicePreflightResult;

  constructor(result: CanonicalSlicePreflightResult) {
    const first = result.issues.find((issue) => issue.severity === 'error');
    super(
      `Slice preflight blocked plate ${result.plateId} with ${result.blockingCount} error${
        result.blockingCount === 1 ? '' : 's'
      }.${first ? ` ${first.message}` : ''}`,
    );
    this.name = 'SlicePreflightError';
    this.result = deepFreeze(cloneJson(result));
  }
}

export class SliceRouteError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SliceRouteError';
  }
}

export class SliceRouteCancellationError extends Error {
  constructor(
    message: string,
    readonly cancellationConfirmed: boolean,
    readonly cancellationReason?: Error,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SliceRouteCancellationError';
  }
}

export interface CanonicalSliceJobCoordinatorOptions {
  source: CanonicalProjectSliceSourcePort;
  serializer: ProjectSerializerPort;
  profiles: SliceProfileResolverPort;
  route: SliceRouteAdapterPort;
  preflight?: CanonicalSlicePreflightPort;
  publisher?: SliceResultPublisherPort;
  hasher?: SliceContentHasherPort;
  createJobId?: (sequence: number) => string;
  now?: () => string;
  defaults?: SliceJobOptions;
}

interface MutableJob {
  id: string;
  scope: SliceJobScope;
  status: SliceJobStatus;
  controller: AbortController;
  options: Required<SliceJobOptions>;
}

const DEFAULT_OPTIONS: Required<SliceJobOptions> = {
  maxAttempts: 2,
  preflightTimeoutMs: 10_000,
  attemptTimeoutMs: 120_000,
  serializationTimeoutMs: 30_000,
  recoveryTimeoutMs: 10_000,
};

/**
 * Revisioned project-slice orchestration. It accepts only canonical graph and
 * asset snapshots, always serializes a compatible 3MF, and publishes only
 * results that still own every requested plate at the captured revision.
 */
export class CanonicalSliceJobCoordinator {
  private readonly routeMetadata: SliceRouteMetadata;
  private readonly hasher: SliceContentHasherPort;
  private readonly preflight: CanonicalSlicePreflightPort;
  private readonly subscribers = new Set<SliceJobSubscriber>();
  private readonly activeJobs = new Map<string, MutableJob>();
  private readonly issuedJobIds = new Set<string>();
  private readonly latestOwnerByPlate = new Map<PlateId, string>();
  private latestResult?: CanonicalSliceJobResult;
  private sequence = 0;

  constructor(private readonly options: CanonicalSliceJobCoordinatorOptions) {
    assertRouteMetadata(options.route.metadata);
    assertRouteCancellation(options.route.cancellation);
    this.routeMetadata = deepFreeze(cloneJson(options.route.metadata));
    this.hasher = options.hasher ?? new Sha256SliceContentHasher();
    this.preflight = options.preflight ?? new CanonicalSlicePreflightValidator();
  }

  startCurrentPlate(options?: SliceJobOptions): SliceJobHandle {
    return this.start('current-plate', options);
  }

  startAllPlates(options?: SliceJobOptions): SliceJobHandle {
    return this.start('all-plates', options);
  }

  subscribe(subscriber: SliceJobSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  getActiveJobs(): SliceJobStatus[] {
    return [...this.activeJobs.values()].map((job) => cloneStatus(job.status));
  }

  getLatestResult(): CanonicalSliceJobResult | undefined {
    return this.latestResult ? cloneJobResult(this.latestResult) : undefined;
  }

  cancelAll(reason = 'All slice jobs cancelled'): void {
    for (const job of this.activeJobs.values()) this.requestCancellation(job, reason);
  }

  private start(scope: SliceJobScope, overrides: SliceJobOptions | undefined): SliceJobHandle {
    const archive = validatedSnapshot(this.options.source.capture());
    const plateIds = selectPlateIds(archive.state.activePlateId, archive.state.plates, scope);
    const sequence = ++this.sequence;
    const id = this.options.createJobId?.(sequence) ?? `slice-${sequence}`;
    if (!id || this.issuedJobIds.has(id)) throw new Error(`Slice job ID must be unique: ${id}`);
    this.issuedJobIds.add(id);
    const controller = new AbortController();
    const job: MutableJob = {
      id,
      scope,
      controller,
      options: normalizedOptions(this.options.defaults, overrides),
      status: {
        id,
        scope,
        phase: 'queued',
        sourceRevision: archive.sourceRevision,
        sourceHash: archive.sourceHash,
        sourceAssetHash: archive.sourceAssetHash,
        plateIds,
        completedPlateCount: 0,
        totalPlateCount: plateIds.length,
        attempt: 0,
      },
    };
    this.activeJobs.set(id, job);
    for (const plateId of plateIds) this.latestOwnerByPlate.set(plateId, id);
    this.emit(job);

    const completion = Promise.resolve()
      .then(() => this.run(job, archive))
      .then((result) => {
        this.transition(job, 'completed');
        return result;
      })
      .catch((error: unknown) => {
        this.fail(job, error);
        throw error;
      })
      .finally(() => {
        this.activeJobs.delete(job.id);
        for (const plateId of job.status.plateIds) {
          if (this.latestOwnerByPlate.get(plateId) === job.id) this.latestOwnerByPlate.delete(plateId);
        }
      });

    return {
      id,
      completion,
      cancel: (reason = 'Slice job cancelled') => {
        this.requestCancellation(job, reason);
      },
      getStatus: () => cloneStatus(job.status),
    };
  }

  private async run(job: MutableJob, archive: CanonicalProjectSliceSnapshot): Promise<CanonicalSliceJobResult> {
    const plates: SlicePlateResult[] = [];
    const allSerializerWarnings: string[] = [];

    for (const plateId of job.status.plateIds) {
      this.assertFresh(job, archive);
      job.status = {
        ...job.status,
        phase: 'preflighting',
        activePlateId: plateId,
        attempt: 0,
        progressPercent: undefined,
        progressMessage: undefined,
      };
      this.emit(job);
      const preflight = validatedPreflight(
        await runAbortable(
          job.controller.signal,
          job.options.preflightTimeoutMs,
          new SliceJobTimeoutError('Plate preflight', job.options.preflightTimeoutMs),
          () => Promise.resolve(this.preflight.evaluate(archive, plateId)),
        ),
        plateId,
      );
      this.assertFresh(job, archive);
      if (!preflight.canSlice) throw new SlicePreflightError(preflight);

      job.status = {
        ...job.status,
        phase: 'serializing',
        activePlateId: plateId,
        attempt: 0,
        progressPercent: undefined,
        progressMessage: undefined,
      };
      this.emit(job);

      const projection = projectPlateArchiveForSlice(archive, plateId);
      const serialized = await runAbortable(
        job.controller.signal,
        job.options.serializationTimeoutMs,
        new SliceJobTimeoutError('Plate serialization', job.options.serializationTimeoutMs),
        (signal) => this.options.serializer.serialize(projection.archive, cancellationToken(signal)),
      );
      validateSerializedProject(serialized, projection.archive.sourceRevision, projection.archive.sourceHash);
      this.assertFresh(job, archive);

      const serializerWarnings = uniqueWarnings(serialized.warnings ?? []);
      allSerializerWarnings.push(...serializerWarnings);
      const projectBytes = serialized.bytes.slice();
      const inputHash = await this.hasher.digest(projectBytes);
      this.assertFresh(job, archive);
      const profiles = validatedProfiles(await this.options.profiles.capture(archive.state, plateId), archive.state);
      this.assertFresh(job, archive);
      const plate = await this.executePlate(
        job,
        plateId,
        projectBytes,
        inputHash,
        archive,
        profiles,
        preflight,
        serializerWarnings,
      );
      plates.push(plate);
      job.status = {
        ...job.status,
        completedPlateCount: plates.length,
        activePlateId: undefined,
        attempt: 0,
        progressPercent: undefined,
        progressMessage: undefined,
      };
      this.emit(job);
    }

    this.assertFresh(job, archive);
    const serializerWarnings = uniqueWarnings(allSerializerWarnings);
    const result: CanonicalSliceJobResult = {
      protocolVersion: SLICE_PROTOCOL_VERSION,
      jobId: job.id,
      scope: job.scope,
      sourceRevision: archive.sourceRevision,
      sourceHash: archive.sourceHash,
      sourceAssetHash: archive.sourceAssetHash,
      route: cloneJson(this.routeMetadata),
      serializerWarnings,
      warnings: uniqueWarnings([...serializerWarnings, ...plates.flatMap((plate) => plate.warnings)]),
      plates,
      completedAt: this.options.now?.() ?? new Date().toISOString(),
    };

    // Store and publish defensive copies only after the final freshness check.
    this.latestResult = cloneJobResult(result);
    this.options.publisher?.publish(cloneJobResult(result));
    return cloneJobResult(result);
  }

  private async executePlate(
    job: MutableJob,
    plateId: PlateId,
    projectBytes: Uint8Array,
    inputHash: string,
    archive: CanonicalProjectSliceSnapshot,
    profiles: SliceProfileSnapshot,
    preflight: CanonicalSlicePreflightResult,
    serializerWarnings: readonly string[],
  ): Promise<SlicePlateResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= job.options.maxAttempts; attempt += 1) {
      this.assertFresh(job, archive);
      job.status = {
        ...job.status,
        phase: attempt === 1 ? 'submitting' : 'retrying',
        activePlateId: plateId,
        attempt,
        progressPercent: undefined,
        progressMessage: undefined,
      };
      this.emit(job);
      const request = routeRequest(
        job,
        attempt,
        plateId,
        projectBytes,
        inputHash,
        archive,
        profiles,
        this.routeMetadata,
      );
      try {
        const response = await runRouteAbortable(
          job.controller.signal,
          job.options.attemptTimeoutMs,
          new SliceJobTimeoutError('Slice route attempt', job.options.attemptTimeoutMs),
          this.options.route.cancellation,
          (signal) =>
            this.options.route.execute(request, signal, (progress) =>
              this.reportRouteProgress(job, plateId, attempt, progress),
            ),
        );
        this.assertFresh(job, archive);
        validateRouteResponse(response, request, this.routeMetadata);
        const gcode = response.gcode.slice();
        const outputHash = await this.hasher.digest(gcode);
        this.assertFresh(job, archive);
        return {
          plateId,
          projectInputHash: inputHash,
          outputHash,
          profiles: cloneJson(profiles),
          preflightIssues: cloneJson(preflight.issues),
          serializerWarnings: [...serializerWarnings],
          gcode,
          warnings: uniqueWarnings([
            ...preflight.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
            ...response.warnings,
          ]),
          statistics: deepFreeze(cloneJson(response.statistics)),
          attempts: attempt,
        };
      } catch (error) {
        if (
          error instanceof SliceRouteCancellationError &&
          (!error.cancellationConfirmed || job.controller.signal.aborted)
        ) {
          throw error;
        }
        if (job.controller.signal.aborted) throw abortReason(job.controller.signal);
        this.assertFresh(job, archive);
        lastError = error;
        const timedOut =
          error instanceof SliceJobTimeoutError ||
          (error instanceof SliceRouteCancellationError && error.cancellationReason instanceof SliceJobTimeoutError);
        const retryable = timedOut || (error instanceof SliceRouteError && error.retryable);
        const adapterRetryable = this.options.route.isRetryable?.(error) ?? false;
        if (attempt >= job.options.maxAttempts || (!retryable && !adapterRetryable)) throw error;
        if (this.options.route.recover) {
          await runAbortable(
            job.controller.signal,
            job.options.recoveryTimeoutMs,
            new SliceJobTimeoutError('Slice route recovery', job.options.recoveryTimeoutMs),
            (signal) =>
              this.options.route.recover!(
                {
                  jobId: job.id,
                  plateId,
                  failedAttempt: attempt,
                  reason: timedOut ? 'timeout' : 'retryable-error',
                },
                signal,
              ),
          );
        }
      }
    }
    throw lastError ?? new SliceRouteError('Slice route exhausted without a result');
  }

  private assertFresh(job: MutableJob, guard: CanonicalProjectSliceGuard): void {
    if (job.controller.signal.aborted) throw abortReason(job.controller.signal);
    if (!this.options.source.isCurrent(guard)) throw new StaleSliceCompletionError();
    for (const plateId of job.status.plateIds) {
      if (this.latestOwnerByPlate.get(plateId) !== job.id) throw new SupersededSliceJobError();
    }
  }

  private transition(job: MutableJob, phase: SliceJobPhase): void {
    job.status = {
      ...job.status,
      phase,
      activePlateId: undefined,
      attempt: 0,
      progressPercent: undefined,
      progressMessage: undefined,
    };
    this.emit(job);
  }

  private requestCancellation(job: MutableJob, reason: string): void {
    if (job.controller.signal.aborted) return;
    job.status = {
      ...job.status,
      phase: 'cancelling',
      progressPercent: undefined,
      progressMessage: undefined,
    };
    this.emit(job);
    job.controller.abort(new SliceJobCancelledError(reason));
  }

  private fail(job: MutableJob, error: unknown): void {
    const phase: SliceJobPhase =
      error instanceof SliceRouteCancellationError
        ? error.cancellationConfirmed
          ? error.cancellationReason instanceof SliceJobTimeoutError
            ? 'timed-out'
            : 'cancelled'
          : 'failed'
        : error instanceof SliceJobCancelledError
          ? 'cancelled'
          : error instanceof SliceJobTimeoutError
            ? 'timed-out'
            : error instanceof StaleSliceCompletionError || error instanceof SupersededSliceJobError
              ? 'stale'
              : 'failed';
    job.status = {
      ...job.status,
      phase,
      activePlateId: undefined,
      progressPercent: undefined,
      progressMessage: undefined,
      cancellationConfirmed: error instanceof SliceRouteCancellationError ? error.cancellationConfirmed : undefined,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    };
    this.emit(job);
  }

  private reportRouteProgress(job: MutableJob, plateId: PlateId, attempt: number, progress: SliceRouteProgress): void {
    if (
      this.activeJobs.get(job.id) !== job ||
      job.controller.signal.aborted ||
      job.status.activePlateId !== plateId ||
      job.status.attempt !== attempt ||
      (job.status.phase !== 'submitting' && job.status.phase !== 'retrying')
    ) {
      return;
    }
    const percent =
      typeof progress.percent === 'number' && Number.isFinite(progress.percent)
        ? Math.min(100, Math.max(0, progress.percent))
        : undefined;
    const message =
      typeof progress.message === 'string'
        ? progress.message
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 160) || undefined
        : undefined;
    if (percent === undefined && message === undefined) return;
    job.status = {
      ...job.status,
      ...(percent === undefined ? {} : { progressPercent: percent }),
      ...(message === undefined ? {} : { progressMessage: message }),
    };
    this.emit(job);
  }

  private emit(job: MutableJob): void {
    const status = cloneStatus(job.status);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(status);
      } catch {
        // Status observers cannot affect slice job semantics.
      }
    }
  }
}

function selectPlateIds(
  activePlateId: PlateId,
  plates: readonly { id: PlateId; order: number; printable: boolean }[],
  scope: SliceJobScope,
): PlateId[] {
  if (scope === 'current-plate') {
    const active = plates.find((plate) => plate.id === activePlateId);
    if (!active) throw new Error(`Active plate ${activePlateId} does not exist`);
    if (!active.printable) throw new Error(`Active plate ${activePlateId} is not printable`);
    return [active.id];
  }
  const printable = [...plates]
    .filter((plate) => plate.printable)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((plate) => plate.id);
  if (printable.length === 0) throw new Error('Project has no printable plates');
  return printable;
}

function routeRequest(
  job: MutableJob,
  attempt: number,
  plateId: PlateId,
  projectBytes: Uint8Array,
  inputHash: string,
  archive: CanonicalProjectSliceSnapshot,
  profiles: SliceProfileSnapshot,
  metadata: SliceRouteMetadata,
): SliceRouteRequest {
  const project = Object.freeze({
    bytes: projectBytes.slice(),
    mediaType: 'model/3mf' as const,
    inputHash,
    sourceRevision: archive.sourceRevision,
    sourceHash: archive.sourceHash,
    sourceAssetHash: archive.sourceAssetHash,
  });
  return Object.freeze({
    protocolVersion: SLICE_PROTOCOL_VERSION,
    jobId: job.id,
    attempt,
    plateId,
    project,
    profiles: deepFreeze(cloneJson(profiles)),
    engine: deepFreeze(cloneJson(metadata.engine)),
  });
}

function validateSerializedProject(result: SerializedProject, revision: number, hash: string): void {
  if (result.sourceRevision !== revision || result.sourceHash !== hash) {
    throw new SliceProtocolError('Serializer returned a different project revision/hash');
  }
  if (result.mediaType !== 'model/3mf') {
    throw new SliceProtocolError(`Canonical slicing requires model/3mf, received ${result.mediaType}`);
  }
  if (result.bytes.byteLength === 0) throw new SliceProtocolError('Serializer returned an empty project archive');
}

function validateRouteResponse(
  response: SliceRouteResponse,
  request: SliceRouteRequest,
  route: SliceRouteMetadata,
): void {
  if (response.protocolVersion !== SLICE_PROTOCOL_VERSION) {
    throw new SliceProtocolError(`Route returned protocol ${response.protocolVersion}`);
  }
  if (response.jobId !== request.jobId || response.plateId !== request.plateId) {
    throw new SliceProtocolError('Route response belongs to another job or plate');
  }
  if (response.inputHash !== request.project.inputHash) {
    throw new SliceProtocolError('Route response does not match the submitted project bytes');
  }
  if (canonicalStringify(response.engine) !== canonicalStringify(route.engine)) {
    throw new SliceProtocolError('Route response engine identity differs from the requested engine');
  }
  if (!(response.gcode instanceof Uint8Array) || response.gcode.byteLength === 0) {
    throw new SliceProtocolError('Route returned empty G-code');
  }
}

function validatedProfiles(
  profile: SliceProfileSnapshot,
  state: ReturnType<typeof validatedSnapshot>['state'],
): SliceProfileSnapshot {
  if (!profile || !Array.isArray(profile.references)) {
    throw new SliceProtocolError('Profile snapshot references are malformed');
  }
  if (!isCanonicalSha256(profile.effectiveConfigHash)) {
    throw new SliceProtocolError('Effective profile config hash must be a canonical SHA-256 identity');
  }

  const references: SliceProfileReference[] = [];
  for (const candidate of profile.references as readonly unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new SliceProtocolError('Profile references are malformed');
    }
    const reference = candidate as Record<string, unknown>;
    if (
      typeof reference.id !== 'string' ||
      reference.id.length === 0 ||
      reference.id.trim() !== reference.id ||
      !isCanonicalSha256(reference.hash)
    ) {
      throw new SliceProtocolError('Profile references require canonical IDs and SHA-256 hashes');
    }
    if (reference.kind === 'filament') {
      if (!Number.isSafeInteger(reference.tool) || (reference.tool as number) < 0) {
        throw new SliceProtocolError('Filament profile references require a non-negative engine tool slot');
      }
      references.push({
        kind: 'filament',
        id: reference.id,
        hash: reference.hash,
        tool: reference.tool as number,
      });
    } else if (reference.kind === 'printer' || reference.kind === 'process') {
      if (Object.hasOwn(reference, 'tool')) {
        throw new SliceProtocolError('Only filament profile references may carry an engine tool slot');
      }
      references.push({ kind: reference.kind, id: reference.id, hash: reference.hash });
    } else {
      throw new SliceProtocolError('Profile reference kind is unsupported');
    }
  }

  const printerReferences = references.filter((reference) => reference.kind === 'printer');
  const processReferences = references.filter((reference) => reference.kind === 'process');
  if (printerReferences.length !== 1 || processReferences.length !== 1) {
    throw new SliceProtocolError('Profile snapshot requires exactly one printer and one process reference');
  }
  const printer = printerReferences[0];
  const process = processReferences[0];
  const expectedPrinterId = state.printer.profileId?.trim() || 'canonical:effective-printer';
  const expectedProcessId = configString(state.config.print_settings_id) || 'canonical:effective-process';
  if (printer.id !== expectedPrinterId || process.id !== expectedProcessId) {
    throw new SliceProtocolError('Printer or process profile ID differs from the current canonical state');
  }
  const canonicalPrinterHash = canonicalExplicitHash(state.printer.profileHash);
  if (canonicalPrinterHash !== undefined && printer.hash !== canonicalPrinterHash) {
    throw new SliceProtocolError('Profile snapshot omits the canonical printer profile hash');
  }

  const expectedFilaments = [
    ...state.filaments.physical.map((filament, tool) => ({
      tool,
      id: filament.presetId?.trim() || filament.id,
      hash: canonicalExplicitHash(filament.presetHash),
    })),
    ...state.filaments.mixed
      .filter((filament) => filament.enabled)
      .map((filament, index) => ({
        tool: state.filaments.physical.length + index,
        id: filament.id,
        hash: undefined,
      })),
  ];
  const filamentReferences = references.filter(
    (reference): reference is SliceFilamentProfileReference => reference.kind === 'filament',
  );
  if (filamentReferences.length !== expectedFilaments.length) {
    throw new SliceProtocolError('Profile snapshot does not cover every configured engine filament slot');
  }
  const filamentByTool = new Map<number, SliceFilamentProfileReference>();
  for (const reference of filamentReferences) {
    if (reference.tool >= expectedFilaments.length || filamentByTool.has(reference.tool)) {
      throw new SliceProtocolError('Filament profile tool slots must be unique and dense');
    }
    filamentByTool.set(reference.tool, reference);
  }
  const orderedFilaments = expectedFilaments.map((expected) => {
    const reference = filamentByTool.get(expected.tool);
    if (!reference) throw new SliceProtocolError('Filament profile tool slots must be unique and dense');
    if (reference.id !== expected.id) {
      throw new SliceProtocolError(`Engine filament slot ${expected.tool} differs from the current canonical state`);
    }
    if (expected.hash !== undefined && reference.hash !== expected.hash) {
      throw new SliceProtocolError(`Engine filament slot ${expected.tool} omits its canonical profile hash`);
    }
    return reference;
  });

  return deepFreeze(
    cloneJson({
      references: [printer, process, ...orderedFilaments],
      effectiveConfigHash: profile.effectiveConfigHash,
    }),
  );
}

function isCanonicalSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function canonicalExplicitHash(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && isCanonicalSha256(normalized) ? normalized : undefined;
}

function configString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validatedPreflight(result: CanonicalSlicePreflightResult, plateId: PlateId): CanonicalSlicePreflightResult {
  if (!result || result.plateId !== plateId) {
    throw new SliceProtocolError('Preflight result belongs to another plate');
  }
  if (
    !Array.isArray(result.issues) ||
    !Array.isArray(result.printableInstanceIds) ||
    !Array.isArray(result.usedFilamentIds)
  ) {
    throw new SliceProtocolError('Preflight result is malformed');
  }
  const ids = new Set<string>();
  for (const issue of result.issues) {
    if (
      !issue.id?.trim() ||
      !issue.code?.trim() ||
      !issue.message?.trim() ||
      !issue.help?.trim() ||
      (issue.severity !== 'warning' && issue.severity !== 'error') ||
      !Array.isArray(issue.entities) ||
      !Array.isArray(issue.actions)
    ) {
      throw new SliceProtocolError('Preflight issue is malformed');
    }
    if (ids.has(issue.id)) throw new SliceProtocolError(`Preflight repeats issue ID ${issue.id}`);
    ids.add(issue.id);
  }
  const blockingCount = result.issues.filter((issue) => issue.severity === 'error').length;
  if (result.blockingCount !== blockingCount || result.canSlice !== (blockingCount === 0)) {
    throw new SliceProtocolError('Preflight blocking summary differs from its issue set');
  }
  return deepFreeze(cloneJson(result));
}

function assertRouteMetadata(metadata: SliceRouteMetadata): void {
  if (metadata.protocolVersion !== SLICE_PROTOCOL_VERSION) {
    throw new SliceProtocolError(`Unsupported slice route protocol ${metadata.protocolVersion}`);
  }
  if (!metadata.id || !metadata.engine.commit || !metadata.engine.artifactHash) {
    throw new SliceProtocolError('Slice route requires ID, engine commit, and artifact hash');
  }
}

function assertRouteCancellation(cancellation: SliceRouteAdapterPort['cancellation']): void {
  if (!cancellation) return;
  if (
    cancellation.mode !== 'confirmed-cleanup' ||
    !Number.isSafeInteger(cancellation.cleanupTimeoutMs) ||
    cancellation.cleanupTimeoutMs <= 0 ||
    cancellation.cleanupTimeoutMs > 120_000
  ) {
    throw new SliceProtocolError('Confirmed route cleanup requires a timeout from 1 to 120000 ms');
  }
}

function normalizedOptions(
  base: SliceJobOptions | undefined,
  overrides: SliceJobOptions | undefined,
): Required<SliceJobOptions> {
  const result = { ...DEFAULT_OPTIONS, ...base, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

function cancellationToken(signal: AbortSignal): CancellationToken {
  return {
    get aborted() {
      return signal.aborted;
    },
    get reason() {
      const reason = signal.reason;
      return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
    },
  };
}

async function runAbortable<T>(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutError: SliceJobTimeoutError,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw abortReason(parent);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await raceAbort(operationPromise, controller.signal);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', forwardAbort);
  }
}

async function runRouteAbortable<T>(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutError: SliceJobTimeoutError,
  cancellation: SliceRouteAdapterPort['cancellation'],
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!cancellation) return runAbortable(parent, timeoutMs, timeoutError, operation);
  if (parent.aborted) {
    const reason = abortReason(parent);
    throw new SliceRouteCancellationError('Slice route was cancelled before submission', true, reason, {
      cause: reason,
    });
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const settled = settlePromise(operationPromise);
  try {
    const first = await raceSettlementWithAbort(settled, controller.signal);
    if (first.kind === 'value') return first.value;
    if (first.kind === 'error') throw first.error;

    const cancellationReason = abortReason(controller.signal);
    const cleanup = await settleWithin(settled, cancellation.cleanupTimeoutMs);
    if (cleanup.kind === 'cleanup-timeout') {
      throw new SliceRouteCancellationError(
        `Slice route did not confirm cleanup within ${cancellation.cleanupTimeoutMs} ms`,
        false,
        cancellationReason,
      );
    }
    if (cleanup.kind === 'value') {
      throw new SliceRouteCancellationError(
        'Slice route returned a result after abort without confirming cleanup',
        false,
        cancellationReason,
      );
    }
    if (cleanup.error instanceof SliceRouteCancellationError) throw cleanup.error;
    throw new SliceRouteCancellationError(
      'Slice route rejected after abort without confirming cleanup',
      false,
      cancellationReason,
      { cause: cleanup.error },
    );
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', forwardAbort);
  }
}

type Settled<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };

function settlePromise<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
}

function raceSettlementWithAbort<T>(
  settled: Promise<Settled<T>>,
  signal: AbortSignal,
): Promise<Settled<T> | { kind: 'abort' }> {
  if (signal.aborted) return Promise.resolve({ kind: 'abort' });
  return new Promise((resolve) => {
    const aborted = () => {
      cleanup();
      resolve({ kind: 'abort' });
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    void settled.then((outcome) => {
      cleanup();
      resolve(outcome);
    });
  });
}

function settleWithin<T>(
  settled: Promise<Settled<T>>,
  timeoutMs: number,
): Promise<Settled<T> | { kind: 'cleanup-timeout' }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'cleanup-timeout' }), timeoutMs);
    void settled.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new SliceJobCancelledError(String(signal.reason ?? 'cancelled'));
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

function cloneStatus(status: SliceJobStatus): SliceJobStatus {
  return { ...status, plateIds: [...status.plateIds] };
}

function cloneJobResult(result: CanonicalSliceJobResult): CanonicalSliceJobResult {
  return {
    ...result,
    route: cloneJson(result.route),
    serializerWarnings: [...result.serializerWarnings],
    warnings: [...result.warnings],
    plates: result.plates.map((plate) => ({
      ...plate,
      profiles: cloneJson(plate.profiles),
      preflightIssues: cloneJson(plate.preflightIssues),
      serializerWarnings: [...plate.serializerWarnings],
      gcode: plate.gcode.slice(),
      warnings: [...plate.warnings],
      statistics: cloneJson(plate.statistics),
    })),
  };
}
