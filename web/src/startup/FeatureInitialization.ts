export type FeaturePhase = 'idle' | 'loading' | 'ready' | 'failed';
export type BootPhase = 'loading' | 'ready' | 'degraded' | 'failed';
export interface FeatureDefinition {
  readonly id: string;
  readonly label: string;
  readonly core?: boolean;
  readonly recovery?: 'retry' | 'reload';
}
export interface FeatureStatus extends FeatureDefinition {
  readonly phase: FeaturePhase;
  readonly reason: string;
}
export interface InitializationSnapshot {
  readonly phase: BootPhase;
  readonly features: readonly FeatureStatus[];
}
export type InitializationResult<T> =
  { readonly ready: true; readonly value: T } | { readonly ready: false; readonly reason: string };

export class InitializationReloadError extends Error {}

/** Owns resources as soon as they exist; late initialization cannot resurrect a disposed feature. */
export class InitializationScope {
  private abort = new AbortController();
  private disposers: (() => void)[] = [];
  get signal(): AbortSignal {
    return this.abort.signal;
  }
  assertActive(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  defer(dispose: () => void): void {
    if (this.signal.aborted) dispose();
    else this.disposers.push(dispose);
  }
  own<T extends { dispose(): void }>(resource: T): T {
    this.defer(() => resource.dispose());
    this.assertActive();
    return resource;
  }
  async load<T>(pending: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      void pending.catch(() => {});
      this.assertActive();
    }
    let remove = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        const aborted = () => reject(this.signal.reason);
        this.signal.addEventListener('abort', aborted, { once: true });
        remove = () => this.signal.removeEventListener('abort', aborted);
      });
      const value = await Promise.race([pending, cancelled]);
      this.assertActive();
      return value;
    } finally {
      remove();
    }
  }
  async import<T>(pending: Promise<T>): Promise<T> {
    try {
      return await this.load(pending);
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      throw new InitializationReloadError('A feature module could not be loaded. Reload to restore it.', {
        cause: error,
      });
    }
  }
  dispose(reason: Error = new Error('Initialization was cancelled.')): void {
    if (this.signal.aborted) return;
    this.abort.abort(reason);
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        /* Every remaining owned resource must still be released. */
      }
    }
  }
}

type Initializer = (scope: InitializationScope) => unknown | Promise<unknown>;
interface Entry {
  status: FeatureStatus;
  initialize?: Initializer;
  running?: Promise<InitializationResult<unknown>>;
  scope?: InitializationScope;
  value?: unknown;
}

/** Data-only health snapshots shared by the flat shell, XR, and action availability. */
export class FeatureInitializationRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(snapshot: InitializationSnapshot) => void>();
  private disposed = false;
  constructor(private readonly timeoutMs = 30_000) {}

  define(definition: FeatureDefinition): void {
    if (this.disposed) return;
    if (this.entries.has(definition.id)) throw new Error(`Feature ${definition.id} is already defined.`);
    this.entries.set(definition.id, { status: Object.freeze({ ...definition, phase: 'idle', reason: '' }) });
    this.emit();
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  get snapshot(): InitializationSnapshot {
    const features = Object.freeze([...this.entries.values()].map((entry) => entry.status));
    const core = features.filter((feature) => feature.core);
    const phase: BootPhase = core.some((feature) => feature.phase === 'failed')
      ? 'failed'
      : core.some((feature) => feature.phase !== 'ready')
        ? 'loading'
        : features.some((feature) => feature.phase === 'failed')
          ? 'degraded'
          : features.some((feature) => feature.phase === 'loading')
            ? 'loading'
            : 'ready';
    return Object.freeze({ phase, features });
  }
  subscribe(listener: (snapshot: InitializationSnapshot) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  run<T>(id: string, initialize: (scope: InitializationScope) => T | Promise<T>): Promise<InitializationResult<T>> {
    if (this.disposed) return Promise.resolve({ ready: false, reason: 'The application is closed.' });
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown feature ${id}.`);
    if (entry.running) return entry.running as Promise<InitializationResult<T>>;
    if (entry.status.phase === 'ready') return Promise.resolve({ ready: true, value: entry.value as T });
    entry.initialize = initialize;
    const scope = new InitializationScope();
    entry.scope = scope;
    entry.status = Object.freeze({ ...entry.status, phase: 'loading', reason: '' });
    // Assign the single-flight promise before notifying observers, so retry in
    // a subscription cannot start a second initializer.
    entry.running = Promise.resolve().then(async (): Promise<InitializationResult<T>> => {
      const timer = setTimeout(
        () =>
          scope.dispose(
            new Error(`${entry.status.label} did not finish loading. Retry when the connection is available.`),
          ),
        this.timeoutMs,
      );
      try {
        scope.assertActive();
        const value = await scope.load(Promise.resolve(initialize(scope)));
        scope.assertActive();
        if (this.disposed) throw new Error('The application is closed.');
        entry.value = value;
        entry.status = Object.freeze({ ...entry.status, phase: 'ready', reason: '' });
        return { ready: true, value };
      } catch (error) {
        scope.dispose();
        const reason = error instanceof Error ? error.message : 'This feature could not be initialized.';
        if (!this.disposed)
          entry.status = Object.freeze({
            ...entry.status,
            phase: 'failed',
            reason,
            ...(error instanceof InitializationReloadError ? { recovery: 'reload' as const } : {}),
          });
        return { ready: false, reason };
      } finally {
        clearTimeout(timer);
        entry.running = undefined;
        if (!this.disposed) this.emit();
      }
    });
    this.emit();
    return entry.running as Promise<InitializationResult<T>>;
  }
  retry(id: string): Promise<InitializationResult<unknown>> {
    const entry = this.entries.get(id);
    if (!entry?.initialize) return Promise.resolve({ ready: false, reason: 'This feature has not been requested.' });
    return this.run(id, entry.initialize);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const entry of [...this.entries.values()].reverse()) entry.scope?.dispose();
  }
  private emit(): void {
    const state = this.snapshot;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('[orcaxr] startup observer failed', error);
      }
    }
  }
}
