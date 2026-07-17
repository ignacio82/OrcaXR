import { canonicalStringify, cloneJson, deepFreeze } from '../domain/canonical';
import type { PlateId } from '../domain/ids';
import type { CancellationToken, ProjectSerializerPort, SerializedProject } from '../ports';
import { Sha256SliceContentHasher } from './hash';
import { cloneArchiveSnapshot, validatedSnapshot } from './source';
import {
  SLICE_PROTOCOL_VERSION,
  type CanonicalProjectSliceSourcePort,
  type CanonicalSliceJobResult,
  type SliceContentHasherPort,
  type SliceJobHandle,
  type SliceJobOptions,
  type SliceJobPhase,
  type SliceJobScope,
  type SliceJobStatus,
  type SliceJobSubscriber,
  type SlicePlateResult,
  type SliceProfileSnapshot,
  type SliceProfileResolverPort,
  type SliceResultPublisherPort,
  type SliceRouteAdapterPort,
  type SliceRouteMetadata,
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
    super('Slice completed for a stale canonical project revision');
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

export class SliceRouteError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SliceRouteError';
  }
}

export interface CanonicalSliceJobCoordinatorOptions {
  source: CanonicalProjectSliceSourcePort;
  serializer: ProjectSerializerPort;
  profiles: SliceProfileResolverPort;
  route: SliceRouteAdapterPort;
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
  private readonly subscribers = new Set<SliceJobSubscriber>();
  private readonly activeJobs = new Map<string, MutableJob>();
  private readonly issuedJobIds = new Set<string>();
  private readonly latestOwnerByPlate = new Map<PlateId, string>();
  private latestResult?: CanonicalSliceJobResult;
  private sequence = 0;

  constructor(private readonly options: CanonicalSliceJobCoordinatorOptions) {
    assertRouteMetadata(options.route.metadata);
    this.routeMetadata = deepFreeze(cloneJson(options.route.metadata));
    this.hasher = options.hasher ?? new Sha256SliceContentHasher();
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
    for (const job of this.activeJobs.values()) {
      if (!job.controller.signal.aborted) job.controller.abort(new SliceJobCancelledError(reason));
    }
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
        if (!controller.signal.aborted) controller.abort(new SliceJobCancelledError(reason));
      },
      getStatus: () => cloneStatus(job.status),
    };
  }

  private async run(job: MutableJob, archive: ReturnType<typeof validatedSnapshot>): Promise<CanonicalSliceJobResult> {
    this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
    this.transition(job, 'serializing');
    const serialized = await runAbortable(
      job.controller.signal,
      job.options.serializationTimeoutMs,
      new SliceJobTimeoutError('Project serialization', job.options.serializationTimeoutMs),
      (signal) => this.options.serializer.serialize(cloneArchiveSnapshot(archive), cancellationToken(signal)),
    );
    validateSerializedProject(serialized, archive.sourceRevision, archive.sourceHash);
    this.assertFresh(job, archive.sourceRevision, archive.sourceHash);

    const projectBytes = serialized.bytes.slice();
    const inputHash = await this.hasher.digest(projectBytes);
    this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
    const plates: SlicePlateResult[] = [];

    for (const plateId of job.status.plateIds) {
      this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
      const profiles = validatedProfiles(await this.options.profiles.capture(archive.state, plateId), archive.state);
      const plate = await this.executePlate(job, plateId, projectBytes, inputHash, archive, profiles);
      plates.push(plate);
      job.status = {
        ...job.status,
        completedPlateCount: plates.length,
        activePlateId: undefined,
        attempt: 0,
      };
      this.emit(job);
    }

    this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
    const serializerWarnings = uniqueWarnings(serialized.warnings ?? []);
    const result: CanonicalSliceJobResult = {
      protocolVersion: SLICE_PROTOCOL_VERSION,
      jobId: job.id,
      scope: job.scope,
      sourceRevision: archive.sourceRevision,
      sourceHash: archive.sourceHash,
      route: cloneJson(this.routeMetadata),
      projectInputHash: inputHash,
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
    archive: ReturnType<typeof validatedSnapshot>,
    profiles: SliceProfileSnapshot,
  ): Promise<SlicePlateResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= job.options.maxAttempts; attempt += 1) {
      this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
      job.status = {
        ...job.status,
        phase: attempt === 1 ? 'submitting' : 'retrying',
        activePlateId: plateId,
        attempt,
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
        const response = await runAbortable(
          job.controller.signal,
          job.options.attemptTimeoutMs,
          new SliceJobTimeoutError('Slice route attempt', job.options.attemptTimeoutMs),
          (signal) => this.options.route.execute(request, signal),
        );
        this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
        validateRouteResponse(response, request, this.routeMetadata);
        const gcode = response.gcode.slice();
        const outputHash = await this.hasher.digest(gcode);
        this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
        return {
          plateId,
          projectInputHash: inputHash,
          outputHash,
          profiles: cloneJson(profiles),
          gcode,
          warnings: uniqueWarnings(response.warnings),
          statistics: deepFreeze(cloneJson(response.statistics)),
          attempts: attempt,
        };
      } catch (error) {
        if (job.controller.signal.aborted) throw abortReason(job.controller.signal);
        this.assertFresh(job, archive.sourceRevision, archive.sourceHash);
        lastError = error;
        const timedOut = error instanceof SliceJobTimeoutError;
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

  private assertFresh(job: MutableJob, revision: number, hash: string): void {
    if (job.controller.signal.aborted) throw abortReason(job.controller.signal);
    if (!this.options.source.isCurrent({ revision, hash })) throw new StaleSliceCompletionError();
    for (const plateId of job.status.plateIds) {
      if (this.latestOwnerByPlate.get(plateId) !== job.id) throw new SupersededSliceJobError();
    }
  }

  private transition(job: MutableJob, phase: SliceJobPhase): void {
    job.status = { ...job.status, phase, activePlateId: undefined, attempt: 0 };
    this.emit(job);
  }

  private fail(job: MutableJob, error: unknown): void {
    const phase: SliceJobPhase =
      error instanceof SliceJobCancelledError
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
      errorName: error instanceof Error ? error.name : 'UnknownError',
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
  archive: ReturnType<typeof validatedSnapshot>,
  profiles: SliceProfileSnapshot,
  metadata: SliceRouteMetadata,
): SliceRouteRequest {
  const project = Object.freeze({
    bytes: projectBytes.slice(),
    mediaType: 'model/3mf' as const,
    inputHash,
    sourceRevision: archive.sourceRevision,
    sourceHash: archive.sourceHash,
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
  const references = profile.references.map((reference) => ({ ...reference }));
  if (!profile.effectiveConfigHash) throw new SliceProtocolError('Effective profile config hash is missing');
  for (const reference of references) {
    if (!reference.id || !reference.hash)
      throw new SliceProtocolError('Profile references require stable IDs and hashes');
  }
  const printerHash = state.printer.profileHash;
  const printerId = state.printer.profileId;
  if (
    printerHash &&
    !references.some(
      (reference) =>
        reference.kind === 'printer' && reference.hash === printerHash && (!printerId || reference.id === printerId),
    )
  ) {
    throw new SliceProtocolError('Profile snapshot omits the canonical printer profile hash');
  }
  for (const filament of state.filaments.physical) {
    if (
      filament.enabled &&
      filament.presetHash &&
      !references.some(
        (reference) =>
          reference.kind === 'filament' &&
          reference.hash === filament.presetHash &&
          (!filament.presetId || reference.id === filament.presetId),
      )
    ) {
      throw new SliceProtocolError(`Profile snapshot omits filament profile ${filament.presetId ?? filament.id}`);
    }
  }
  return deepFreeze({ references, effectiveConfigHash: profile.effectiveConfigHash });
}

function assertRouteMetadata(metadata: SliceRouteMetadata): void {
  if (metadata.protocolVersion !== SLICE_PROTOCOL_VERSION) {
    throw new SliceProtocolError(`Unsupported slice route protocol ${metadata.protocolVersion}`);
  }
  if (!metadata.id || !metadata.engine.commit || !metadata.engine.artifactHash) {
    throw new SliceProtocolError('Slice route requires ID, engine commit, and artifact hash');
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
      gcode: plate.gcode.slice(),
      warnings: [...plate.warnings],
      statistics: cloneJson(plate.statistics),
    })),
  };
}
