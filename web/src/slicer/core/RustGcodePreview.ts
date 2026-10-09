import initialize, { core_info, GcodeSession } from '../../../../core/browser/orcaxr_core.js';
import { CORE_BROWSER_ASSET } from '../../../../core/browser/asset';
import { checkCoreHandshake, fetchCoreAsset } from './CoreAsset';
import { GcodePreviewController, type GcodePreviewSessionSource } from '../GcodePreviewController';
import { CoreGcodeSource } from './CoreGcodeSource';
import type { GcodeSourceOptions } from './GcodeRequests';

export { checkCoreHandshake, fetchCoreAsset } from './CoreAsset';

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
