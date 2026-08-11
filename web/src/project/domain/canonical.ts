import type { ProjectState } from './model';

/**
 * Order two strings the same way on every machine.
 *
 * `localeCompare` collates by the *runtime's* locale — in Swedish 'ä' sorts
 * after 'z', in German it sorts with 'a' — so using it to order anything that
 * reaches a saved project or a generated config makes the output depend on
 * where it was produced. Canonical ordering is by code unit, always.
 */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
 *
 * The per-byte work is written out at every call site rather than funnelled
 * through one `update(byte)` method. A megabyte-scale digest makes that method
 * call the dominant cost: hashing a large project's canonical JSON through it
 * ran at roughly 8 MB/s, which put multiple seconds of hashing on the path of
 * every single canonical commit.
 */
class Fnv1a64 {
  hi = 0xcbf29ce4;
  lo = 0x84222325;

  update(byte: number): void {
    // 0x100000001b3 = (0x100 << 32) | 0x1b3.
    const lo = (this.lo ^ byte) >>> 0;
    // 16-bit limbs so the whole round stays in integer ops. The obvious
    // `Math.floor(lo * 0x1b3 / 2 ** 32)` is a floating-point division per byte,
    // and this hash runs over hundreds of megabytes on import and save.
    const low = (lo & 0xffff) * 0x1b3;
    const high = (lo >>> 16) * 0x1b3 + (low >>> 16);
    this.lo = (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
    this.hi = (Math.imul(this.hi, 0x1b3) + (lo << 8) + (high >>> 16)) >>> 0;
  }

  /** Hash a string's UTF-8 without materializing it as bytes. */
  updateText(value: string): void {
    let hi = this.hi;
    let lo = this.lo;
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      let codePoint = value.charCodeAt(index);
      // The overwhelming majority of canonical JSON is ASCII, so that case
      // pays for one comparison and one inlined round rather than the full
      // surrogate-and-width cascade.
      if (codePoint <= 0x7f) {
        const mixed = (lo ^ codePoint) >>> 0;
        const low = (mixed & 0xffff) * 0x1b3;
        const high = (mixed >>> 16) * 0x1b3 + (low >>> 16);
        lo = (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
        hi = (Math.imul(hi, 0x1b3) + (mixed << 8) + (high >>> 16)) >>> 0;
        continue;
      }
      if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        }
      }
      this.hi = hi;
      this.lo = lo;
      if (codePoint <= 0x7ff) {
        this.update(0xc0 | (codePoint >> 6));
        this.update(0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        this.update(0xe0 | (codePoint >> 12));
        this.update(0x80 | ((codePoint >> 6) & 0x3f));
        this.update(0x80 | (codePoint & 0x3f));
      } else {
        this.update(0xf0 | (codePoint >> 18));
        this.update(0x80 | ((codePoint >> 12) & 0x3f));
        this.update(0x80 | ((codePoint >> 6) & 0x3f));
        this.update(0x80 | (codePoint & 0x3f));
      }
      hi = this.hi;
      lo = this.lo;
    }
    this.hi = hi;
    this.lo = lo;
  }

  digest(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0');
  }
}

export function fnv1a64(bytes: Uint8Array): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const length = bytes.length;
  for (let index = 0; index < length; index += 1) {
    const mixed = (lo ^ bytes[index]) >>> 0;
    const low = (mixed & 0xffff) * 0x1b3;
    const high = (mixed >>> 16) * 0x1b3 + (low >>> 16);
    lo = (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
    hi = (Math.imul(hi, 0x1b3) + (mixed << 8) + (high >>> 16)) >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** FNV-1a 64 of a string's UTF-8, encoded in one streaming pass. */
export function fnv1a64Text(value: string): string {
  const hash = new Fnv1a64();
  hash.updateText(value);
  return hash.digest();
}

export function projectFingerprint(state: ProjectState): string {
  // Encoded and hashed in one pass. Materializing the UTF-8 of a large painted
  // project as an intermediate array exceeded what a JS array can hold, so a
  // model that opened could not be fingerprinted, and therefore could not be
  // saved. The canonical JSON is likewise never materialized as one string:
  // a heavily painted project's canonical form runs to hundreds of megabytes,
  // and allocating it on every commit is what made moving an object feel like
  // the app had hung. Streaming it into the digest is byte-for-byte the same
  // hash — pinned by test.
  const hash = new Fnv1a64();
  hashCanonical(state, hash);
  return `fnv1a64:${hash.digest()}`;
}

/** Emit a safe integer's decimal digits without allocating its string. */
function hashSafeInteger(value: number, hash: Fnv1a64): void {
  let magnitude = value;
  if (magnitude < 0) {
    hash.update(0x2d); // -
    magnitude = -magnitude;
  }
  if (magnitude < 10) {
    hash.update(0x30 + magnitude);
    return;
  }
  let scale = 1;
  while (magnitude / scale >= 10) scale *= 10;
  while (scale >= 1) {
    const digit = Math.floor(magnitude / scale) % 10;
    hash.update(0x30 + digit);
    scale /= 10;
  }
}

/** Feed exactly the characters `canonicalStringify` would produce into `hash`. */
function hashCanonical(value: unknown, hash: Fnv1a64): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    hash.updateText(JSON.stringify(value) as string);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain non-finite numbers');
    // Canonical state is mostly integers — hundreds of thousands of triangle
    // indices in a painted volume — and `JSON.stringify` allocates a string for
    // every one of them. Their decimal form is emitted digit by digit instead;
    // `String(n)` and `JSON.stringify(n)` agree exactly on safe integers, -0
    // included (both give "0").
    if (Number.isSafeInteger(value)) {
      hashSafeInteger(value, hash);
      return;
    }
    hash.updateText(JSON.stringify(value) as string);
    return;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (Array.isArray(value)) {
    hash.update(0x5b); // [
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(0x2c); // ,
      hashCanonical(value[index], hash);
    }
    hash.update(0x5d); // ]
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  hash.update(0x7b); // {
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) hash.update(0x2c); // ,
    hash.updateText(JSON.stringify(keys[index]) as string);
    hash.update(0x3a); // :
    hashCanonical(record[keys[index]], hash);
  }
  hash.update(0x7d); // }
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
