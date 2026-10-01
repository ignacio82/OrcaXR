import { t } from '../l10n/t';
import type { FeatureDefinition } from './FeatureInitialization';
const LABELS: Readonly<Record<string, () => string>> = {
  'printer-storage': () => t('startup.feature.printerStorage', 'Printer files'),
  'printer-console': () => t('startup.feature.printerConsole', 'Printer console'),
  'printer-history': () => t('startup.feature.printerHistory', 'Printer history'),
  'printer-camera-panel': () => t('startup.feature.printerCameraPanel', 'Printer camera controls'),
  'calibration-history': () => t('startup.feature.calibrationHistory', 'Calibration history'),
  'preset-library': () => t('startup.feature.presetLibrary', 'Preset library'),
  'smart-paint-panel': () => t('startup.feature.smartPaintPanel', 'Smart Paint controls'),
  'measure-panel': () => t('startup.feature.measurePanel', 'Measurement controls'),
  'gcode-panel': () => t('startup.feature.gcodePanel', 'G-code inspector'),
  'calibration-parameters': () => t('startup.feature.calibrationParameters', 'Calibration controls'),
  'calibration-session': () => t('startup.feature.calibrationSession', 'Calibration session'),
  'simplify-panel': () => t('startup.feature.simplifyPanel', 'Simplify controls'),
  'brim-ears-panel': () => t('startup.feature.brimEarsPanel', 'Brim controls'),
  'emboss-panel': () => t('startup.feature.embossPanel', 'Emboss controls'),
  'svg-panel': () => t('startup.feature.svgPanel', 'SVG controls'),
  'layer-events': () => t('startup.feature.layerEvents', 'Layer events'),
  'wave-overhangs': () => t('startup.feature.waveOverhangs', 'Wave overhang controls'),
  'external-slicer-controls': () => t('startup.feature.externalSlicerControls', 'External slicer controls'),
  simulator: () => t('startup.feature.simulator', 'Desktop simulator'),
  workspace: () => t('startup.feature.workspace', 'Workspace'),
  shell: () => t('startup.feature.shell', 'Application controls'),
  profiles: () => t('startup.feature.profiles', 'Printer profiles'),
  settings: () => t('startup.feature.settings', 'Settings schema'),
  camera: () => t('startup.feature.camera', 'Camera'),
  ai: () => t('startup.feature.ai', 'AI integration'),
  printer: () => t('startup.feature.printer', 'Printer connection'),
  xr: () => t('startup.feature.xr', 'Immersive XR'),
};
/** Resolve the current locale on both surfaces without changing health identities. */
export function initializationFeatureLabel(feature: FeatureDefinition): string {
  return LABELS[feature.id]?.() ?? feature.label;
}
