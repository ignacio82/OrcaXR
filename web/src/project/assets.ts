import { canonicalStringify, cloneJson, fnv1a64 } from './domain/canonical';
import type { AssetId } from './domain/ids';
import type { SourceAssetDescriptor } from './domain/model';

export interface AssetPayload {
  descriptor: SourceAssetDescriptor;
  bytes: Uint8Array;
}

export interface AssetRepositorySnapshot {
  readonly entries: AssetPayload[];
}

export interface AssetRepository {
  has(id: AssetId): boolean;
  get(id: AssetId): AssetPayload | undefined;
  put(descriptor: SourceAssetDescriptor, bytes: Uint8Array): void;
  remove(id: AssetId): void;
  list(): AssetPayload[];
  findByDigest(digest: string): AssetPayload | undefined;
  capture(): AssetRepositorySnapshot;
  restore(snapshot: AssetRepositorySnapshot): void;
}

export function contentDigest(bytes: Uint8Array): string {
  return `fnv1a64:${fnv1a64(bytes)}`;
}

/**
 * Immutable-by-contract byte repository. Reads and snapshots return copies;
 * replacing an existing ID with different metadata or bytes is rejected.
 */
export class InMemoryAssetRepository implements AssetRepository {
  private entries = new Map<AssetId, AssetPayload>();

  has(id: AssetId): boolean {
    return this.entries.has(id);
  }

  get(id: AssetId): AssetPayload | undefined {
    const entry = this.entries.get(id);
    return entry ? clonePayload(entry) : undefined;
  }

  put(descriptor: SourceAssetDescriptor, bytes: Uint8Array): void {
    if (descriptor.byteLength !== bytes.byteLength) {
      throw new Error(
        `Asset ${descriptor.id} declares ${descriptor.byteLength} bytes but received ${bytes.byteLength}`,
      );
    }
    if (descriptor.digest.startsWith('fnv1a64:') && descriptor.digest !== contentDigest(bytes)) {
      throw new Error(`Asset ${descriptor.id} content does not match its digest`);
    }
    const next = { descriptor: cloneJson(descriptor), bytes: bytes.slice() };
    const existing = this.entries.get(descriptor.id);
    if (existing) {
      if (!samePayload(existing, next)) {
        throw new Error(`Immutable asset ${descriptor.id} cannot be replaced`);
      }
      return;
    }
    this.entries.set(descriptor.id, next);
  }

  remove(id: AssetId): void {
    this.entries.delete(id);
  }

  list(): AssetPayload[] {
    return Array.from(this.entries.values(), clonePayload).sort((a, b) =>
      a.descriptor.id.localeCompare(b.descriptor.id),
    );
  }

  findByDigest(digest: string): AssetPayload | undefined {
    const entry = Array.from(this.entries.values()).find((candidate) => candidate.descriptor.digest === digest);
    return entry ? clonePayload(entry) : undefined;
  }

  capture(): AssetRepositorySnapshot {
    return { entries: this.list() };
  }

  restore(snapshot: AssetRepositorySnapshot): void {
    const restored = new Map<AssetId, AssetPayload>();
    for (const entry of snapshot.entries) {
      if (restored.has(entry.descriptor.id)) {
        throw new Error(`Asset snapshot contains duplicate ID ${entry.descriptor.id}`);
      }
      if (entry.descriptor.byteLength !== entry.bytes.byteLength) {
        throw new Error(`Asset snapshot has invalid byte length for ${entry.descriptor.id}`);
      }
      if (entry.descriptor.digest.startsWith('fnv1a64:') && entry.descriptor.digest !== contentDigest(entry.bytes)) {
        throw new Error(`Asset snapshot has invalid digest for ${entry.descriptor.id}`);
      }
      restored.set(entry.descriptor.id, clonePayload(entry));
    }
    this.entries = restored;
  }
}

function clonePayload(payload: AssetPayload): AssetPayload {
  return { descriptor: cloneJson(payload.descriptor), bytes: payload.bytes.slice() };
}

function samePayload(left: AssetPayload, right: AssetPayload): boolean {
  if (canonicalStringify(left.descriptor) !== canonicalStringify(right.descriptor)) return false;
  if (left.bytes.byteLength !== right.bytes.byteLength) return false;
  return left.bytes.every((byte, index) => byte === right.bytes[index]);
}
