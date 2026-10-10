import initialize, { core_info, GcodeSession } from '../../../../core/browser/orcaxr_core.js';
import { CORE_BROWSER_ASSET } from '../../../../core/browser/asset';
import { checkCoreHandshake, fetchCoreAsset } from './CoreAsset';
import { GcodePreviewController, type GcodePreviewSessionSource } from '../GcodePreviewController';
import { CoreGcodeSource } from './CoreGcodeSource';
import type { GcodeSourceOptions } from './GcodeRequests';
import type { GcodeArtifactSummary } from '../GcodeArtifactSummary';

export { checkCoreHandshake, fetchCoreAsset } from './CoreAsset';

/** The preview over the shared core, and what the artifact states about
 * itself, from the same sealed source; none when the statement is past the
 * metadata bound. */
export async function createRustGcodePreview(
  gcode: string,
  source: GcodePreviewSessionSource,
  options: GcodeSourceOptions = {},
): Promise<{ readonly preview: GcodePreviewController; readonly summary?: GcodeArtifactSummary }> {
  const base = new URL(import.meta.env.BASE_URL, globalThis.location.origin);
  await fetchCoreAsset(CORE_BROWSER_ASSET.manifest, base);
  const bytes = await fetchCoreAsset(CORE_BROWSER_ASSET.wasm, base);
  await initialize({ module_or_path: bytes });
  checkCoreHandshake(core_info());
  const owner = new CoreGcodeSource(GcodeSession, gcode, options);
  try {
    const index = { ...owner.index, entries: [...owner.entries()] };
    let summary: GcodeArtifactSummary | undefined;
    try {
      summary = owner.summary().summary;
    } catch (error) {
      // wasm-bindgen throws the core's refusal code as a string.
      if (error !== 'resource_limit') throw error;
    }
    const preview = GcodePreviewController.fromComputation(
      index,
      (window) => owner.openWindow(window),
      source,
      () => owner.dispose(),
    );
    return { preview, summary };
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
