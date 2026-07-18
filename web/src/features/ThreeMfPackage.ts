import * as fflate from 'fflate';

export type ThreeMfEntries = Record<string, Uint8Array>;

/** Inflate a 3MF once so metadata readers can share the same package entries. */
export function unzip3mfPackage(buf: ArrayBuffer): ThreeMfEntries {
  return fflate.unzipSync(new Uint8Array(buf));
}
