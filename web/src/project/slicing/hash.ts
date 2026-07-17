import type { SliceContentHasherPort } from './types';

/** Browser/Node SHA-256 hasher used for route, artifact, and output evidence. */
export class Sha256SliceContentHasher implements SliceContentHasherPort {
  async digest(bytes: Uint8Array): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
    const copy = Uint8Array.from(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
}
