/**
 * Stable-ID projection of Snapmaker OrcaSlicer v2.3.4's
 * `MixedFilamentManager::auto_generate`.
 *
 * The pinned manager keys auto rows by transient one-based physical slots.
 * OrcaXR instead keys the unordered pair by stable physical IDs, then emits
 * the C(N,2) base section in the current physical-library order. This keeps
 * recipe identity stable when physical rows move.
 *
 * One deliberate adaptation closes a pinned lifecycle corner: a deleted
 * custom row with `origin_auto=true` is also a tombstone blocker. The desktop
 * delete flow normally converts it to, or pairs it with, a non-custom
 * tombstone before the next regeneration. Treating the intermediate state as
 * a blocker prevents an asynchronous regeneration from briefly resurrecting
 * the deleted auto pair.
 */

import { isStableEntityId, type MixedFilamentId, type PhysicalFilamentId } from '../domain/ids';
import { MAX_AUTHORING_PHYSICAL_TOOL_ID } from './mixedFilamentAuthoring';

export interface FullSpectrumAutoPairProjectionRow {
  readonly id: MixedFilamentId;
  readonly componentAId: PhysicalFilamentId;
  readonly componentBId: PhysicalFilamentId;
  /** Unsigned, non-zero uint64 text persisted by the pinned manager. */
  readonly upstreamStableId: string;
  readonly enabled: boolean;
  readonly deleted: boolean;
  readonly custom: boolean;
  readonly originAuto: boolean;
}

export interface FullSpectrumAutoPairAllocationContext {
  readonly componentAId: PhysicalFilamentId;
  readonly componentBId: PhysicalFilamentId;
  /** Zero-based ordinal in the complete current C(N,2) pair order. */
  readonly pairOrdinal: number;
}

export interface FullSpectrumAutoPairAllocatedIdentity {
  readonly id: MixedFilamentId;
  readonly upstreamStableId: string;
}

export type FullSpectrumAutoPairIdentityAllocator = (
  context: FullSpectrumAutoPairAllocationContext,
) => FullSpectrumAutoPairAllocatedIdentity;

export interface FullSpectrumAutoPairTombstoneSuppression {
  readonly componentAId: PhysicalFilamentId;
  readonly componentBId: PhysicalFilamentId;
  readonly tombstoneId: MixedFilamentId;
  /**
   * `claimed-pair-slot` means no base row existed, so the origin tombstone
   * itself occupies the hidden C(N,2) slot. `forced-base-tombstone` means an
   * existing base row was made deleted/disabled while the custom tombstone
   * remains in the appended custom section.
   */
  readonly resolution: 'claimed-pair-slot' | 'forced-base-tombstone';
}

export interface FullSpectrumAutoPairProjectionResult {
  /** Exactly C(N,2) rows in current physical order, including hidden tombstones. */
  readonly autoPairRows: readonly FullSpectrumAutoPairProjectionRow[];
  /** Valid custom rows not consumed as the sole tombstone for a base slot. */
  readonly customRows: readonly FullSpectrumAutoPairProjectionRow[];
  /** `autoPairRows` followed by `customRows`, matching pinned regeneration order. */
  readonly rows: readonly FullSpectrumAutoPairProjectionRow[];
  readonly createdRowIds: readonly MixedFilamentId[];
  /** Invalid/out-of-library rows and duplicate non-custom auto rows. */
  readonly droppedRowIds: readonly MixedFilamentId[];
  readonly tombstoneSuppressions: readonly FullSpectrumAutoPairTombstoneSuppression[];
}

export class FullSpectrumAutoPairProjectionError extends Error {
  override readonly name = 'FullSpectrumAutoPairProjectionError';
}

/**
 * Rebuild the base auto-pair section without mutating either input.
 *
 * Existing non-custom rows are matched by unordered stable physical IDs. The
 * first duplicate wins, as with the pinned unordered-map insertion. Valid
 * custom rows retain input order. Fresh identities are requested only for a
 * genuinely absent, non-tombstoned base pair.
 */
export function regenerateFullSpectrumAutoPairs(
  physicalIds: readonly PhysicalFilamentId[],
  existingRows: readonly FullSpectrumAutoPairProjectionRow[],
  allocateIdentity: FullSpectrumAutoPairIdentityAllocator,
): FullSpectrumAutoPairProjectionResult {
  validatePhysicalIds(physicalIds);
  const physicalSet = new Set(physicalIds);
  const usedRowIds = new Set<MixedFilamentId>();
  const usedUpstreamStableIds = new Set<string>();
  for (const row of existingRows) {
    validateExistingIdentity(row, usedRowIds, usedUpstreamStableIds);
  }

  const droppedRowIds: MixedFilamentId[] = [];
  const baseByPair = new Map<string, FullSpectrumAutoPairProjectionRow>();
  const customRowsInOrder: FullSpectrumAutoPairProjectionRow[] = [];
  const originTombstonesByPair = new Map<string, FullSpectrumAutoPairProjectionRow[]>();

  for (const source of existingRows) {
    const row = freezeRow(source);
    if (!isValidCurrentPair(row, physicalSet)) {
      droppedRowIds.push(row.id);
      continue;
    }
    const key = stablePairKey(row.componentAId, row.componentBId);
    if (row.custom) {
      customRowsInOrder.push(row);
      if (row.originAuto && row.deleted) {
        const tombstones = originTombstonesByPair.get(key) ?? [];
        tombstones.push(row);
        originTombstonesByPair.set(key, tombstones);
      }
      continue;
    }
    if (baseByPair.has(key)) {
      droppedRowIds.push(row.id);
      continue;
    }
    baseByPair.set(key, row);
  }

  const createdRowIds: MixedFilamentId[] = [];
  const autoPairRows: FullSpectrumAutoPairProjectionRow[] = [];
  const consumedCustomTombstones = new Set<MixedFilamentId>();
  const tombstoneSuppressions: FullSpectrumAutoPairTombstoneSuppression[] = [];
  let pairOrdinal = 0;
  for (let firstIndex = 0; firstIndex < physicalIds.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < physicalIds.length; secondIndex += 1) {
      const componentAId = physicalIds[firstIndex];
      const componentBId = physicalIds[secondIndex];
      const key = stablePairKey(componentAId, componentBId);
      const existingBase = baseByPair.get(key);
      const originTombstones = originTombstonesByPair.get(key) ?? [];

      if (existingBase) {
        const suppressed = originTombstones.length > 0;
        autoPairRows.push(
          freezeRow({
            ...existingBase,
            componentAId,
            componentBId,
            enabled: suppressed || existingBase.deleted ? false : existingBase.enabled,
            deleted: suppressed || existingBase.deleted,
            custom: false,
            originAuto: true,
          }),
        );
        if (suppressed) {
          tombstoneSuppressions.push(
            freezeSuppression({
              componentAId,
              componentBId,
              tombstoneId: originTombstones[0].id,
              resolution: 'forced-base-tombstone',
            }),
          );
        }
        pairOrdinal += 1;
        continue;
      }

      if (originTombstones.length > 0) {
        const blocker = originTombstones[0];
        consumedCustomTombstones.add(blocker.id);
        autoPairRows.push(
          freezeRow({
            ...blocker,
            enabled: false,
            deleted: true,
          }),
        );
        tombstoneSuppressions.push(
          freezeSuppression({
            componentAId,
            componentBId,
            tombstoneId: blocker.id,
            resolution: 'claimed-pair-slot',
          }),
        );
        pairOrdinal += 1;
        continue;
      }

      const context = Object.freeze({ componentAId, componentBId, pairOrdinal });
      const allocated = allocateIdentity(context);
      validateAllocatedIdentity(allocated, usedRowIds, usedUpstreamStableIds);
      const created = freezeRow({
        id: allocated.id,
        componentAId,
        componentBId,
        upstreamStableId: allocated.upstreamStableId,
        enabled: true,
        deleted: false,
        custom: false,
        originAuto: true,
      });
      autoPairRows.push(created);
      createdRowIds.push(created.id);
      usedRowIds.add(created.id);
      usedUpstreamStableIds.add(created.upstreamStableId);
      pairOrdinal += 1;
    }
  }

  const customRows = customRowsInOrder
    .filter((row) => !consumedCustomTombstones.has(row.id))
    .map((row) =>
      freezeRow({
        ...row,
        enabled: row.deleted ? false : row.enabled,
      }),
    );
  const frozenAutoPairRows = Object.freeze(autoPairRows);
  const frozenCustomRows = Object.freeze(customRows);
  return Object.freeze({
    autoPairRows: frozenAutoPairRows,
    customRows: frozenCustomRows,
    rows: Object.freeze([...frozenAutoPairRows, ...frozenCustomRows]),
    createdRowIds: Object.freeze(createdRowIds),
    droppedRowIds: Object.freeze(droppedRowIds),
    tombstoneSuppressions: Object.freeze(tombstoneSuppressions),
  });
}

function validatePhysicalIds(ids: readonly PhysicalFilamentId[]): void {
  if (ids.length > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
    throw new FullSpectrumAutoPairProjectionError(
      `The pinned engine supports at most ${MAX_AUTHORING_PHYSICAL_TOOL_ID} physical filaments`,
    );
  }
  const seen = new Set<PhysicalFilamentId>();
  for (const id of ids) {
    assertStableText(id, 'physical filament ID');
    if (seen.has(id)) {
      throw new FullSpectrumAutoPairProjectionError(`Duplicate physical filament ID ${id}`);
    }
    seen.add(id);
  }
}

function validateExistingIdentity(
  row: FullSpectrumAutoPairProjectionRow,
  usedRowIds: Set<MixedFilamentId>,
  usedUpstreamStableIds: Set<string>,
): void {
  assertStableText(row.id, 'mixed filament ID');
  if (usedRowIds.has(row.id)) {
    throw new FullSpectrumAutoPairProjectionError(`Duplicate mixed filament ID ${row.id}`);
  }
  usedRowIds.add(row.id);
  validateUpstreamStableId(row.upstreamStableId);
  if (usedUpstreamStableIds.has(row.upstreamStableId)) {
    throw new FullSpectrumAutoPairProjectionError(
      `Duplicate upstream mixed-filament stable ID ${row.upstreamStableId}`,
    );
  }
  usedUpstreamStableIds.add(row.upstreamStableId);
}

function validateAllocatedIdentity(
  identity: FullSpectrumAutoPairAllocatedIdentity,
  usedRowIds: ReadonlySet<MixedFilamentId>,
  usedUpstreamStableIds: ReadonlySet<string>,
): void {
  if (!identity || typeof identity !== 'object') {
    throw new FullSpectrumAutoPairProjectionError('The auto-pair allocator returned no identity');
  }
  assertStableText(identity.id, 'allocated mixed filament ID');
  validateUpstreamStableId(identity.upstreamStableId);
  if (usedRowIds.has(identity.id)) {
    throw new FullSpectrumAutoPairProjectionError(`The auto-pair allocator reused mixed filament ID ${identity.id}`);
  }
  if (usedUpstreamStableIds.has(identity.upstreamStableId)) {
    throw new FullSpectrumAutoPairProjectionError(
      `The auto-pair allocator reused upstream stable ID ${identity.upstreamStableId}`,
    );
  }
}

function isValidCurrentPair(
  row: FullSpectrumAutoPairProjectionRow,
  physicalIds: ReadonlySet<PhysicalFilamentId>,
): boolean {
  return (
    row.componentAId !== row.componentBId && physicalIds.has(row.componentAId) && physicalIds.has(row.componentBId)
  );
}

function stablePairKey(first: PhysicalFilamentId, second: PhysicalFilamentId): string {
  return first < second ? JSON.stringify([first, second]) : JSON.stringify([second, first]);
}

function validateUpstreamStableId(value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new FullSpectrumAutoPairProjectionError(
      `Upstream stable ID ${JSON.stringify(value)} must be non-zero unsigned decimal text`,
    );
  }
  if (BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new FullSpectrumAutoPairProjectionError(`Upstream stable ID ${value} exceeds uint64`);
  }
}

function assertStableText(value: string, label: string): void {
  if (!isStableEntityId(value)) {
    throw new FullSpectrumAutoPairProjectionError(`${label} is invalid`);
  }
}

function freezeRow(row: FullSpectrumAutoPairProjectionRow): FullSpectrumAutoPairProjectionRow {
  return Object.freeze({ ...row });
}

function freezeSuppression(
  suppression: FullSpectrumAutoPairTombstoneSuppression,
): FullSpectrumAutoPairTombstoneSuppression {
  return Object.freeze({ ...suppression });
}
