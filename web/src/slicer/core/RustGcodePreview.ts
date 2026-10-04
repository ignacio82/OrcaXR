import initialize, { core_info, GcodeSession } from '../../../../core/browser/orcaxr_core.js';
import { CORE_BROWSER_ASSET } from '../../../../core/browser/asset';
import {
  CORE_ABI_VERSION,
  PROTOCOL_VERSION,
  CANONICAL_ENCODING_VERSION,
  MAX_INPUT_BYTES,
  MAX_REQUEST_BYTES,
} from '../../../../contracts/generated/core';
import { sha256Bytes } from '../Utf8Sha256';
import { GcodePreviewController, type GcodePreviewSessionSource } from '../GcodePreviewController';
import { CoreGcodeSource } from './CoreGcodeSource';
import type { GcodeSourceOptions } from './GcodeRequests';

interface Asset {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Own a bounded response before checking its digest. No executable bytes are
 * instantiated on a length, HTTP, identity or host/core handshake mismatch. */
export async function fetchCoreAsset(asset: Asset, base: URL, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const url = new URL(asset.path, base);
  if (
    url.origin !== base.origin ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > 8 * 1024 * 1024
  )
    throw new Error('Invalid shared core asset identity');
  const response = await fetcher(url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || !response.body)
    throw new Error('The shared preview component could not be loaded. Reopen the file to retry.');
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
      throw new Error('The shared preview component has an incompatible length.');
    const bytes = new Uint8Array(asset.bytes);
    let used = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.length > bytes.length - used)
        throw new Error('The shared preview component exceeds its size limit.');
      bytes.set(next.value, used);
      used += next.value.length;
    }
    if (used !== bytes.length || sha256Bytes(bytes) !== `sha256:${asset.sha256}`)
      throw new Error('The shared preview component does not match this application. Reload to update it.');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function checkCoreHandshake(text: string): void {
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
    throw new Error('The shared preview component is incompatible with this application.');
}

export async function createRustGcodePreview(
  gcode: string,
  source: GcodePreviewSessionSource,
  options: GcodeSourceOptions = {},
): Promise<GcodePreviewController> {
  const base = new URL(import.meta.env.BASE_URL, globalThis.location.origin);
  await fetchCoreAsset(CORE_BROWSER_ASSET.manifest, base);
  const bytes = await fetchCoreAsset(CORE_BROWSER_ASSET.wasm, base);
  await initialize({ module_or_path: bytes });
  checkCoreHandshake(core_info());
  const owner = new CoreGcodeSource(GcodeSession, gcode, options);
  try {
    const index = { ...owner.index, entries: [...owner.entries()] };
    return GcodePreviewController.fromComputation(
      index,
      (window) => owner.openWindow(window),
      source,
      () => owner.dispose(),
    );
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
