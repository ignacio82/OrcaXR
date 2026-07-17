import { contentDigest, type AssetPayload, type AssetRepository } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze, projectFingerprint } from '../domain/canonical';
import type { ProjectState } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import type { ProjectArchiveSnapshot } from '../ports';
import type { ProjectStorePort } from '../store';
import type { CanonicalProjectSliceSourcePort } from './types';

/** Canonical store/assets adapter. It never consults render or legacy workspace state. */
export class StoreProjectSliceSource implements CanonicalProjectSliceSourcePort {
  constructor(
    private readonly project: ProjectStorePort,
    private readonly assets: AssetRepository,
  ) {}

  capture(): ProjectArchiveSnapshot {
    const snapshot = this.project.getSnapshot();
    return validatedSnapshot({
      state: snapshot.state,
      assets: this.assets.list(),
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
    });
  }

  isCurrent(guard: { revision: number; hash: string }): boolean {
    return this.project.isCurrent(guard);
  }
}

/**
 * Defensively clones a source snapshot and verifies that its state hash and
 * immutable asset bundle describe the same canonical graph.
 */
export function validatedSnapshot(snapshot: ProjectArchiveSnapshot): ProjectArchiveSnapshot {
  assertValidProjectState(snapshot.state);
  const state = deepFreeze(cloneProjectState(snapshot.state));
  const expectedHash = projectFingerprint(state);
  if (snapshot.sourceHash !== expectedHash) {
    throw new Error(`Canonical source hash mismatch: expected ${expectedHash}, received ${snapshot.sourceHash}`);
  }
  if (!Number.isSafeInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 0) {
    throw new Error(`Invalid canonical project revision ${snapshot.sourceRevision}`);
  }
  const assets = validateAssets(state, snapshot.assets);
  return {
    state,
    assets,
    sourceRevision: snapshot.sourceRevision,
    sourceHash: snapshot.sourceHash,
  };
}

export function cloneArchiveSnapshot(snapshot: ProjectArchiveSnapshot): ProjectArchiveSnapshot {
  return {
    state: deepFreeze(cloneProjectState(snapshot.state)),
    assets: snapshot.assets.map(cloneAsset),
    sourceRevision: snapshot.sourceRevision,
    sourceHash: snapshot.sourceHash,
  };
}

function validateAssets(state: ProjectState, inputs: AssetPayload[]): AssetPayload[] {
  const expected = new Map(state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
  const seen = new Set<string>();
  const assets = inputs.map((input) => {
    const descriptor = expected.get(input.descriptor.id);
    if (!descriptor) throw new Error(`Canonical slice bundle contains undeclared asset ${input.descriptor.id}`);
    if (seen.has(input.descriptor.id)) throw new Error(`Canonical slice bundle repeats asset ${input.descriptor.id}`);
    seen.add(input.descriptor.id);
    if (canonicalStringify(descriptor) !== canonicalStringify(input.descriptor)) {
      throw new Error(`Canonical slice asset metadata differs for ${input.descriptor.id}`);
    }
    if (input.bytes.byteLength !== descriptor.byteLength) {
      throw new Error(`Canonical slice asset ${input.descriptor.id} has the wrong byte length`);
    }
    if (descriptor.digest.startsWith('fnv1a64:') && descriptor.digest !== contentDigest(input.bytes)) {
      throw new Error(`Canonical slice asset ${input.descriptor.id} does not match its content digest`);
    }
    return cloneAsset(input);
  });
  for (const descriptor of state.sourceAssets) {
    if (!seen.has(descriptor.id)) throw new Error(`Canonical slice bundle is missing asset ${descriptor.id}`);
  }
  return assets.sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
}

function cloneAsset(asset: AssetPayload): AssetPayload {
  return {
    descriptor: deepFreeze(cloneJson(asset.descriptor)),
    bytes: asset.bytes.slice(),
  };
}
