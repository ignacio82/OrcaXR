import { WorkerProjectSerializer } from '../project/serialization/WorkerProjectSerializer';
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
  type SliceThumbnailPort,
} from '../slicer/CanonicalSlicerClientRoute';
import type { SlicerClientProjectRoute } from '../slicer/SlicerClient';
import type { SliceEngineMetadata } from '../project/slicing/types';
import type { ProjectSerializerPort } from '../project/ports';
import type { CanonicalWorkspaceController } from './CanonicalWorkspaceController';

export interface CanonicalWorkspaceSlicerOptions {
  readonly workspace: CanonicalWorkspaceController;
  readonly client: CanonicalProjectSlicerClientPort;
  /** Draws the plate for the G-code's thumbnail block; omitted when headless. */
  readonly thumbnails?: SliceThumbnailPort;
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
  /** Dependency seam: hosts without workers, and tests, supply their own. */
  readonly serializer?: ProjectSerializerPort;
}

/**
 * Lifecycle owner for the browser slicing boundary. Construction captures one
 * route permanently; preference changes apply only to a later composition.
 */
export class CanonicalWorkspaceSlicer {
  private readonly coordinator: CanonicalSliceJobCoordinator;
  private readonly ownedSerializer: WorkerProjectSerializer | undefined;
  private disposed = false;

  constructor(options: CanonicalWorkspaceSlicerOptions) {
    const route = new CanonicalSlicerClientRoute({
      client: options.client,
      thumbnails: options.thumbnails,
      route: options.route,
      externalEngine: options.externalEngine,
      maxThreads: options.maxThreads,
      overrides: options.overrides,
    });
    // Authoring a big plate's archive is seconds of pure CPU, so it runs on a
    // worker; the coordinator only ever sees the port.
    this.ownedSerializer = options.serializer ? undefined : new WorkerProjectSerializer();
    this.coordinator = new CanonicalSliceJobCoordinator({
      source: options.workspace.createCanonicalSliceSource(),
      serializer: options.serializer ?? this.ownedSerializer!,
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
    this.ownedSerializer?.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('CanonicalWorkspaceSlicer is disposed');
  }
}
