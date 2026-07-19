/**
 * PrintConfig string-vector options (`coStrings`) use `;`; every other
 * PrintConfig vector type uses `,`. This set is derived from the pinned
 * engine-option schema and is checked against every generated PrintConfig
 * vector definition in the ConfigIO unit test.
 *
 * Keep the schema out of the browser bundle: it is intentionally large, while
 * this classifier is needed by lightweight profile/config import paths.
 */
const STRING_VECTOR_KEYS = new Set<string>([
  'adaptive_pressure_advance_model',
  'compatible_machine_expression_group',
  'compatible_printers',
  'compatible_prints',
  'compatible_process_expression_group',
  'default_filament_colour',
  'default_filament_profile',
  'different_settings_to_system',
  'extruder_colour',
  'filament_colour',
  'filament_end_gcode',
  'filament_ids',
  'filament_notes',
  'filament_ramming_parameters',
  'filament_settings_id',
  'filament_start_gcode',
  'filament_type',
  'filament_vendor',
  'inherits_group',
  'post_process',
  'preset_names',
  'print_compatible_printers',
  'small_area_infill_flow_compensation_model',
  'thumb0',
  'thumb1',
  'upward_compatible_machine',
]);

export type PrintConfigCollectionDelimiter = ',' | ';';

/** Return the engine wire delimiter for an array-valued PrintConfig option. */
export function printConfigCollectionDelimiter(key: string): PrintConfigCollectionDelimiter {
  return STRING_VECTOR_KEYS.has(key) ? ';' : ',';
}

/** Serialize an array-valued PrintConfig option without changing its item text. */
export function serializePrintConfigArray(key: string, values: readonly unknown[]): string {
  return values.map((value) => String(value)).join(printConfigCollectionDelimiter(key));
}
