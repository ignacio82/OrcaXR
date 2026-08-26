import { sha256Bytes } from '../../slicer/Utf8Sha256';
import type { SliceContentHasherPort } from './types';

/**
 * SHA-256 over route, artifact, and output evidence.
 *
 * Web Crypto is used where it exists because it is the faster path, but it is
 * not required. `crypto.subtle` is only exposed in a **secure context**, and the
 * deployment this app is built for is not one: the all-in-one server publishes
 * the UI over plain HTTP on a LAN address, and only `localhost` is special-cased
 * into secure-context treatment. So every slice from another machine on the
 * network failed with "Web Crypto SHA-256 is unavailable" — a hard stop, for a
 * digest the app can perfectly well compute itself.
 *
 * These digests are **content identities** — which project produced which
 * artifact — not authentication or secrecy. The in-repo implementation returns
 * byte-identical values, so an artifact hashed on one origin still matches the
 * same artifact hashed on another.
 */
export class Sha256SliceContentHasher implements SliceContentHasherPort {
  async digest(bytes: Uint8Array): Promise<string> {
    const copy = Uint8Array.from(bytes);
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return sha256Bytes(copy);
    const digest = await subtle.digest('SHA-256', copy);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
}
