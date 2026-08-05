const SHA256_BLOCK_BYTES = 64;

/** Maximum number of UTF-16 code units encoded at once. */
export const UTF8_SHA256_CHUNK_CODE_UNITS = 64 * 1024;

const UTF8_ENCODER = new TextEncoder();

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

class IncrementalSha256 {
  readonly #state = INITIAL_STATE.slice();
  readonly #schedule = new Uint32Array(64);
  readonly #pending = new Uint8Array(SHA256_BLOCK_BYTES);
  #pendingLength = 0;
  #byteLengthLow = 0;
  #byteLengthHigh = 0;
  #finalized = false;

  update(input: Uint8Array): void {
    if (this.#finalized) throw new Error('SHA-256 digest is already finalized');

    const nextLow = this.#byteLengthLow + input.byteLength;
    this.#byteLengthLow = nextLow >>> 0;
    this.#byteLengthHigh = (this.#byteLengthHigh + Math.floor(nextLow / 0x1_0000_0000)) >>> 0;

    let offset = 0;
    if (this.#pendingLength > 0) {
      const copied = Math.min(SHA256_BLOCK_BYTES - this.#pendingLength, input.byteLength);
      this.#pending.set(input.subarray(0, copied), this.#pendingLength);
      this.#pendingLength += copied;
      offset = copied;
      if (this.#pendingLength === SHA256_BLOCK_BYTES) {
        this.#compress(this.#pending, 0);
        this.#pendingLength = 0;
      }
    }

    while (offset + SHA256_BLOCK_BYTES <= input.byteLength) {
      this.#compress(input, offset);
      offset += SHA256_BLOCK_BYTES;
    }

    if (offset < input.byteLength) {
      this.#pending.set(input.subarray(offset), 0);
      this.#pendingLength = input.byteLength - offset;
    }
  }

  digestHex(): string {
    if (this.#finalized) throw new Error('SHA-256 digest is already finalized');
    this.#finalized = true;

    const bitLengthHigh = ((this.#byteLengthHigh << 3) | (this.#byteLengthLow >>> 29)) >>> 0;
    const bitLengthLow = (this.#byteLengthLow << 3) >>> 0;

    this.#pending[this.#pendingLength] = 0x80;
    this.#pendingLength += 1;
    if (this.#pendingLength > 56) {
      this.#pending.fill(0, this.#pendingLength);
      this.#compress(this.#pending, 0);
      this.#pendingLength = 0;
    }

    this.#pending.fill(0, this.#pendingLength, 56);
    this.#writeUint32BigEndian(56, bitLengthHigh);
    this.#writeUint32BigEndian(60, bitLengthLow);
    this.#compress(this.#pending, 0);

    let result = '';
    for (const word of this.#state) result += word.toString(16).padStart(8, '0');
    return result;
  }

  #writeUint32BigEndian(offset: number, value: number): void {
    this.#pending[offset] = value >>> 24;
    this.#pending[offset + 1] = value >>> 16;
    this.#pending[offset + 2] = value >>> 8;
    this.#pending[offset + 3] = value;
  }

  #compress(input: Uint8Array, offset: number): void {
    const words = this.#schedule;
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] =
        ((input[start] << 24) | (input[start + 1] << 16) | (input[start + 2] << 8) | input[start + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = this.#state[0];
    let b = this.#state[1];
    let c = this.#state[2];
    let d = this.#state[3];
    let e = this.#state[4];
    let f = this.#state[5];
    let g = this.#state[6];
    let h = this.#state[7];

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.#state[0] = (this.#state[0] + a) >>> 0;
    this.#state[1] = (this.#state[1] + b) >>> 0;
    this.#state[2] = (this.#state[2] + c) >>> 0;
    this.#state[3] = (this.#state[3] + d) >>> 0;
    this.#state[4] = (this.#state[4] + e) >>> 0;
    this.#state[5] = (this.#state[5] + f) >>> 0;
    this.#state[6] = (this.#state[6] + g) >>> 0;
    this.#state[7] = (this.#state[7] + h) >>> 0;
  }
}

/**
 * Hashes a JavaScript string with the same UTF-8 well-formedness semantics as
 * `TextEncoder.encode(value)`, without allocating one buffer for the full value.
 * The work is CPU-bound despite the Promise API; hash large exports in the slice worker.
 */
export async function sha256Utf8(value: string): Promise<string> {
  const hasher = new IncrementalSha256();
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + UTF8_SHA256_CHUNK_CODE_UNITS, value.length);
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
      end -= 1;
    }
    hasher.update(UTF8_ENCODER.encode(value.slice(offset, end)));
    offset = end;
  }
  return `sha256:${hasher.digestHex()}`;
}
