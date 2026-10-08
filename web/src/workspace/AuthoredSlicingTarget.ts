import type { CanonicalSlicingConfiguration } from './CanonicalWorkspaceController';
import { serializePrintConfigArray } from '../settings/configSerialization';
import type { SlicerProfile } from '../slicer/ProfileLoader';
import type { LiveProfilePreflightTarget } from './ProfilePreflightConstraints';

/**
 * The preflight target of an imported project that slices as authored: its
 * own embedded printer and filament configuration, projected to engine wire
 * strings, is the attested target. Nothing comes from a catalog.
 */
export function authoredProjectPreflightTarget(
  slicing: Pick<CanonicalSlicingConfiguration, 'printer' | 'config' | 'filaments'>,
): LiveProfilePreflightTarget {
  const toolCount = slicing.printer.toolCount;
  const projectConfig = engineWireConfig(slicing.config as Readonly<Record<string, unknown>>);
  const physical = slicing.filaments.physical.map((filament) => ({
    toolId: filament.toolId,
    material: filament.material,
    config: engineWireConfig(filament.config as Readonly<Record<string, unknown>>),
  }));
  return {
    source: 'authored-project',
    primaryProfile: authoredProjectProfile(projectConfig),
    filamentProfiles: authoredFilamentProfiles(projectConfig, physical, toolCount),
    toolCount,
  };
}

function authoredProjectProfile(config: Record<string, string>): SlicerProfile {
  return {
    id: 'authored-project',
    displayName: 'Imported project',
    machineName: config['printer_settings_id'] ?? 'Imported printer',
    processName: config['print_settings_id'] ?? 'Imported process',
    filamentName: config['filament_settings_id'] ?? 'Imported filament',
    config,
  };
}

function authoredFilamentProfiles(
  projectConfig: Record<string, string>,
  physical: readonly { toolId: number; config: Record<string, string>; material: string }[],
  toolCount: number,
): readonly (SlicerProfile | undefined)[] {
  const byTool = new Map(physical.map((filament) => [filament.toolId, filament]));
  return Object.freeze(
    Array.from({ length: toolCount }, (_unused, toolId) => {
      const filament = byTool.get(toolId);
      if (!filament) return undefined;
      // Project-level filament vectors already carry per-tool values; the
      // per-filament config overrides them where the project set one.
      const config: Record<string, string> = {
        ...projectFilamentConfig(projectConfig, toolId),
        ...filament.config,
      };
      if (filament.material && config['filament_type'] === undefined) config['filament_type'] = filament.material;
      return {
        id: `authored-project-filament-${toolId}`,
        displayName: `Imported filament ${toolId + 1}`,
        machineName: projectConfig['printer_settings_id'] ?? 'Imported printer',
        processName: projectConfig['print_settings_id'] ?? 'Imported process',
        filamentName: `Imported filament ${toolId + 1}`,
        config,
      } satisfies SlicerProfile;
    }),
  );
}

/** Per-tool slice of the project's filament vectors, when it declares them. */
function projectFilamentConfig(config: Record<string, string>, toolId: number): Record<string, string> {
  const perTool: Record<string, string> = {};
  for (const key of ['filament_type', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high']) {
    const value = config[key];
    if (value === undefined) continue;
    const parts = value.includes(';') ? value.split(';') : value.includes(',') ? value.split(',') : [value];
    const entry = parts.length === 1 ? parts[0] : parts[toolId];
    if (entry !== undefined && entry !== '') perTool[key] = entry.trim();
  }
  return perTool;
}

/** Canonical config values projected to their engine wire strings. */
export function engineWireConfig(config: Readonly<Record<string, unknown>>): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    wire[key] = Array.isArray(value)
      ? serializePrintConfigArray(key, value as readonly unknown[])
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  }
  return wire;
}
