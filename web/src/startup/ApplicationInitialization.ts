import { FeatureInitializationRegistry, InitializationScope, type InitializationResult } from './FeatureInitialization';

export interface StartupRecoveryPort {
  /** The persistence/navigation owner must guard every reload, including module recovery. */
  reload(): Promise<boolean>;
  report(message: string): void;
}

/** Composition lifetime plus separately owned, retryable feature lifetimes. */
export class ApplicationInitialization {
  readonly registry = new FeatureInitializationRegistry();
  readonly lifetime = new InitializationScope();
  private recovery?: StartupRecoveryPort;
  constructor() {
    for (const [id, label, recovery] of [
      ['workspace', 'Workspace', 'reload'],
      ['shell', 'Application controls', 'reload'],
      ['profiles', 'Printer profiles', 'retry'],
      ['settings', 'Settings schema', 'retry'],
    ] as const)
      this.registry.define({ id, label, core: true, recovery });
    for (const [id, label] of [
      ['camera', 'Camera'],
      ['ai', 'AI integration'],
      ['printer', 'Printer connection'],
      ['xr', 'Immersive XR'],
    ] as const)
      this.registry.define({ id, label });
    this.lifetime.defer(() => this.registry.dispose());
  }
  connectRecovery(port: StartupRecoveryPort): void {
    this.recovery = port;
  }
  mount<T>(
    id: string,
    label: string,
    initialize: (scope: InitializationScope) => T | Promise<T>,
    recovery: 'retry' | 'reload' = 'reload',
  ): Promise<InitializationResult<T>> {
    if (!this.registry.has(id)) this.registry.define({ id, label, recovery });
    return this.registry.run(id, initialize);
  }
  async recover(id?: string): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const failed = this.registry.snapshot.features.filter(
      (feature) => feature.phase === 'failed' && (!id || feature.id === id),
    );
    for (const feature of failed) {
      if (feature.recovery === 'reload') {
        if (!this.recovery) return;
        await this.recovery.reload();
        return;
      }
      const result = await this.registry.retry(feature.id);
      if (!result.ready) this.recovery?.report(result.reason);
    }
  }
  dispose(): void {
    this.lifetime.dispose();
  }
}
