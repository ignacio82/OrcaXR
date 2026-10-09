import {
  CORE_ABI_VERSION,
  PROTOCOL_VERSION,
  CANONICAL_ENCODING_VERSION,
  MAX_INPUT_BYTES,
  MAX_REQUEST_BYTES,
} from '../../../../contracts/generated/core';
import { sha256Bytes } from '../Utf8Sha256';

/** A packaged core file (`core/browser/**\/asset.ts`): its path, length and digest. */
export interface CoreAsset {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Which shared component is loading, for the sentences an operator reads. */
export interface CoreAssetLoad {
  /** The largest file this component may be. */
  readonly maxBytes: number;
  readonly component: 'preview' | 'printer';
}

const PREVIEW: CoreAssetLoad = { maxBytes: 8 * 1024 * 1024, component: 'preview' };

const SENTENCES = {
  preview: {
    unavailable: 'The shared preview component could not be loaded. Reopen the file to retry.',
    length: 'The shared preview component has an incompatible length.',
    limit: 'The shared preview component exceeds its size limit.',
    identity: 'The shared preview component does not match this application. Reload to update it.',
  },
  printer: {
    unavailable: 'The shared printer component could not be loaded. Reconnect the printer to retry.',
    length: 'The shared printer component has an incompatible length.',
    limit: 'The shared printer component exceeds its size limit.',
    identity: 'The shared printer component does not match this application. Reload to update it.',
  },
} as const;

/** Own a bounded response before checking its digest. No executable bytes are
 * instantiated on a length, HTTP, identity or host/core handshake mismatch. */
export async function fetchCoreAsset(
  asset: CoreAsset,
  base: URL,
  fetcher: typeof fetch = fetch,
  load: CoreAssetLoad = PREVIEW,
): Promise<Uint8Array> {
  const say = SENTENCES[load.component];
  const url = new URL(asset.path, base);
  if (
    url.origin !== base.origin ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > load.maxBytes
  )
    throw new Error('Invalid shared core asset identity');
  const response = await fetcher(url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(say.unavailable);
  const length = response.headers.get('Content-Length');
  const reader = response.body.getReader();
  try {
    const encoding = response.headers.get('Content-Encoding');
    // Fetch exposes decoded bytes, while Content-Length may describe a gzip/br
    // transfer. The bounded reader and digest always check the decoded asset.
    if (
      (!encoding || encoding === 'identity') &&
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) !== asset.bytes)
    )
      throw new Error(say.length);
    const bytes = new Uint8Array(asset.bytes);
    let used = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.length > bytes.length - used) throw new Error(say.limit);
      bytes.set(next.value, used);
      used += next.value.length;
    }
    if (used !== bytes.length || sha256Bytes(bytes) !== `sha256:${asset.sha256}`) throw new Error(say.identity);
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function checkCoreHandshake(text: string, component: CoreAssetLoad['component'] = 'preview'): void {
  if (text.length > 1024) throw new Error('Invalid shared core handshake');
  const info = JSON.parse(text);
  const expected = {
    coreAbiVersion: CORE_ABI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    canonicalEncodingVersion: CANONICAL_ENCODING_VERSION,
    maxInputBytes: MAX_INPUT_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
  };
  if (
    !info ||
    typeof info !== 'object' ||
    Object.keys(info).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(([key, value]) => info[key] === value)
  )
    throw new Error(`The shared ${component} component is incompatible with this application.`);
}
