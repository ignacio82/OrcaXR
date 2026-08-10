import { canonicalStringify, fnv1a64Text, forEachUtf8ByteOf } from '../domain/canonical';
import { entityId, type EntityId } from '../domain/ids';
import type { JsonValue } from '../domain/model';

/** Deterministic imported ID with an explicit source namespace. */
export function stableImportedId<Kind extends string>(
  sourceNamespace: string,
  kind: Kind,
  identity: JsonValue,
): EntityId<Kind> {
  const namespace = normalizeNamespace(sourceNamespace);
  const digest = fnv1a64Text(canonicalStringify(identity));
  return entityId<Kind>(`import:${namespace}:${normalizeNamespace(kind)}-${digest}`);
}

export function stableTextDigest(value: string): string {
  return fnv1a64Text(value);
}

/**
 * Streaming structural digest for a migration payload. It avoids building a
 * second giant JSON string for mesh arrays while sorting object keys so a
 * semantically identical persisted payload receives the same source key.
 */
export function stableUnknownDigest(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  const active = new WeakSet<object>();
  const write = (text: string) => {
    forEachUtf8ByteOf(text, (byte) => {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    });
  };
  const visit = (candidate: unknown): void => {
    if (candidate === null) {
      write('null;');
      return;
    }
    const kind = typeof candidate;
    if (kind === 'string') {
      write(`string:${JSON.stringify(candidate)};`);
      return;
    }
    if (kind === 'number') {
      const number = candidate as number;
      write(`number:${Number.isNaN(number) ? 'NaN' : Object.is(number, -0) ? '-0' : String(number)};`);
      return;
    }
    if (kind === 'boolean' || kind === 'undefined' || kind === 'bigint' || kind === 'symbol') {
      write(`${kind}:${String(candidate)};`);
      return;
    }
    if (kind === 'function') {
      write(`function:${String(candidate)};`);
      return;
    }
    if (Array.isArray(candidate)) {
      write(`array:${candidate.length}[`);
      candidate.forEach(visit);
      write('];');
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      const view = candidate as ArrayBufferView;
      write(`view:${candidate.constructor.name}:${view.byteLength}:`);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      write(';');
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      write(`buffer:${candidate.byteLength}:`);
      for (const byte of new Uint8Array(candidate)) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      write(';');
      return;
    }
    const object = candidate as Record<string, unknown>;
    if (active.has(object)) {
      write('cycle;');
      return;
    }
    active.add(object);
    write('object:{');
    for (const key of Object.keys(object).sort()) {
      write(`${JSON.stringify(key)}:`);
      visit(object[key]);
    }
    write('};');
    active.delete(object);
  };
  visit(value);
  return hash.toString(16).padStart(16, '0');
}

function normalizeNamespace(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'legacy';
}
