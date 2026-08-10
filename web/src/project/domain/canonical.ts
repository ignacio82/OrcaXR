import type { ProjectState } from './model';

export function cloneProjectState(state: ProjectState): ProjectState {
  return cloneJson(state);
}

export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneJson(child);
  return clone as T;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Deterministic JSON: object keys sort lexically while array order remains semantic. */
export function canonicalStringify(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * FNV-1a 64 held as two 32-bit halves.
 *
 * The obvious BigInt loop costs a multiplication object per byte, which is
 * fine for a digest of a few kilobytes and hopeless for a project state of
 * a hundred megabytes. Every intermediate here stays under 2^53, so plain
 * Number arithmetic is exact and the digest is bit-identical to the BigInt
 * form — pinned by test.
 */
class Fnv1a64 {
  private hi = 0xcbf29ce4;
  private lo = 0x84222325;

  update(byte: number): void {
    // 0x100000001b3 = (0x100 << 32) | 0x1b3.
    const lo = (this.lo ^ byte) >>> 0;
    const productLow = lo * 0x1b3;
    const carry = Math.floor(productLow / 0x100000000);
    this.lo = productLow % 0x100000000;
    this.hi = (this.hi * 0x1b3 + lo * 0x100 + carry) % 0x100000000;
  }

  digest(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0');
  }
}

export function fnv1a64(bytes: Uint8Array): string {
  const hash = new Fnv1a64();
  for (const byte of bytes) hash.update(byte);
  return hash.digest();
}

/** FNV-1a 64 of a string's UTF-8, encoded in one streaming pass. */
export function fnv1a64Text(value: string): string {
  const hash = new Fnv1a64();
  forEachUtf8ByteOf(value, (byte) => hash.update(byte));
  return hash.digest();
}

export function projectFingerprint(state: ProjectState): string {
  // Encoded and hashed in one pass. Materializing the UTF-8 of a large painted
  // project as an intermediate array exceeded what a JS array can hold, so a
  // model that opened could not be fingerprinted, and therefore could not be
  // saved.
  return `fnv1a64:${fnv1a64Text(canonicalStringify(state))}`;
}

/** Feed the UTF-8 bytes of `value` to `emit` without building an array. */
export function forEachUtf8ByteOf(value: string, emit: (byte: number) => void): void {
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) {
      emit(codePoint);
    } else if (codePoint <= 0x7ff) {
      emit(0xc0 | (codePoint >> 6));
      emit(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      emit(0xe0 | (codePoint >> 12));
      emit(0x80 | ((codePoint >> 6) & 0x3f));
      emit(0x80 | (codePoint & 0x3f));
    } else {
      emit(0xf0 | (codePoint >> 18));
      emit(0x80 | ((codePoint >> 12) & 0x3f));
      emit(0x80 | ((codePoint >> 6) & 0x3f));
      emit(0x80 | (codePoint & 0x3f));
    }
  }
}
