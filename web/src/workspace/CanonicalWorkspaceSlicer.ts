import { Bbs3mfProjectSerializer } from '../project/serialization/Bbs3mfProjectSerializer';
import {
  CanonicalSliceJobCoordinator,
  type CanonicalSliceJobResult,
  type SliceJobHandle,
  type SliceJobOptions,
  type SliceJobStatus,
  type SliceJobSubscriber,
  type CanonicalSlicePreflightPort,
  type SliceProfileResolverPort,
  type SliceResultPublisherPort,
} from '../project/slicing';
import { CanonicalStateProfileResolver } from '../project/slicing/profileResolver';
import {
  CanonicalSlicerClientRoute,
  type CanonicalProjectSlicerClientPort,
} from '../slicer/CanonicalSlicerClientRoute';
import type { SlicerClientProjectRoute } from '../slicer/SlicerClient';
import type { SliceEngineMetadata } from '../project/slicing/types';
import type { CanonicalWorkspaceController } from './CanonicalWorkspaceController';

export interface CanonicalWorkspaceSlicerOptions {
  readonly workspace: CanonicalWorkspaceController;
  readonly client: CanonicalProjectSlicerClientPort;
  readonly route?: SlicerClientProjectRoute;
  readonly externalEngine?: SliceEngineMetadata;
  readonly maxThreads?: number;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly profiles?: SliceProfileResolverPort;
  readonly preflight?: CanonicalSlicePreflightPort;
  readonly publisher?: SliceResultPublisherPort;
  readonly defaults?: SliceJobOptions;
  readonly createJobId?: (sequence: number) => string;
  readonly now?: () => string;
}

/**
 * Lifecycle owner for the browser slicing boundary. Construction captures one
 * route permanently; preference changes apply only to a later composition.
 */
export class CanonicalWorkspaceSlicer {
  private readonly coordinator: CanonicalSliceJobCoordinator;
  private disposed = false;

  constructor(options: CanonicalWorkspaceSlicerOptions) {
    const route = new CanonicalSlicerClientRoute({
      client: options.client,
      route: options.route,
      externalEngine: options.externalEngine,
      maxThreads: options.maxThreads,
      overrides: options.overrides,
    });
    this.coordinator = new CanonicalSliceJobCoordinator({
      source: options.workspace.createCanonicalSliceSource(),
      serializer: new Bbs3mfProjectSerializer(),
      profiles: options.profiles ?? new CanonicalStateProfileResolver(),
      route,
      preflight: options.preflight,
      publisher: options.publisher,
      defaults: options.defaults,
      createJobId: options.createJobId,
      now: options.now,
    });
  }

  startCurrentPlate(options?: SliceJobOptions): SliceJobHandle {
    this.assertActive();
    return this.coordinator.startCurrentPlate(options);
  }

  startAllPlates(options?: SliceJobOptions): SliceJobHandle {
    this.assertActive();
    return this.coordinator.startAllPlates(options);
  }

  subscribe(subscriber: SliceJobSubscriber): () => void {
    this.assertActive();
    const unsubscribe = this.coordinator.subscribe(subscriber);
    return () => unsubscribe();
  }

  getActiveJobs(): SliceJobStatus[] {
    this.assertActive();
    return this.coordinator.getActiveJobs();
  }

  getLatestResult(): CanonicalSliceJobResult | undefined {
    this.assertActive();
    return this.coordinator.getLatestResult();
  }

  cancelAll(reason = 'Canonical workspace slicer disposed'): void {
    this.assertActive();
    this.coordinator.cancelAll(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coordinator.cancelAll('Canonical workspace slicer disposed');
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('CanonicalWorkspaceSlicer is disposed');
  }
}
