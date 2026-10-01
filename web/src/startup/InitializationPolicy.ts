import type { InitializationSnapshot } from './FeatureInitialization';

/** Printer recovery remains independent of workspace/profile/schema readiness. */
export function initializationBlockReason(
  action: { readonly id: string; readonly group: string },
  snapshot: InitializationSnapshot | undefined,
): string | undefined {
  if (
    !snapshot ||
    action.group === 'help' ||
    action.group === 'system' ||
    action.id.startsWith('printer_') ||
    action.id === 'slice_cancel'
  )
    return;
  const dependencies = ['workspace', 'shell'];
  if (
    action.group === 'slice' ||
    action.group === 'calibration' ||
    action.group === 'filament' ||
    action.id.startsWith('settings_') ||
    action.id.startsWith('presets_') ||
    action.id === 'objects_assign_filament' ||
    action.id === 'auto_place_wipe'
  ) {
    dependencies.push('profiles', 'settings');
  }
  const unavailable = snapshot.features.find(
    (feature) => dependencies.includes(feature.id) && feature.phase !== 'ready',
  );
  if (!unavailable) return;
  return unavailable.phase === 'failed'
    ? `${unavailable.label} is unavailable. ${unavailable.reason} Use startup recovery to try again.`
    : `${unavailable.label} is still loading.`;
}
