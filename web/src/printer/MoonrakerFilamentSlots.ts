import { MoonrakerTransportError } from './MoonrakerTypes';

const MAX_FILAMENT_SLOTS = 32;

export interface MoonrakerRequestPort {
  request<T>(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<T>;
}

export interface MoonrakerFilamentSlot {
  readonly slotIndex: number;
  readonly colorHex: string;
  readonly material: string;
  readonly vendor: string;
}

/** Query Snapmaker's Moonraker extension without leaking its untyped payload into UI code. */
export async function queryMoonrakerFilamentSlots(
  transport: MoonrakerRequestPort,
  signal?: AbortSignal,
): Promise<readonly MoonrakerFilamentSlot[]> {
  const result = await transport.request<unknown>('/printer/objects/query?print_task_config=&filament_detect=', {
    signal,
    operation: 'query_filament_slots',
  });
  return parseMoonrakerFilamentSlots(result);
}

export function parseMoonrakerFilamentSlots(result: unknown): readonly MoonrakerFilamentSlot[] {
  const status = record(result)?.status;
  const config = record(record(status)?.print_task_config);
  if (!config) throw invalidResponse();

  const colors = stringLikeArray(config.filament_color_rgba);
  const types = stringLikeArray(config.filament_type);
  const vendors = stringLikeArray(config.filament_vendor);
  const exists = scalarArray(config.filament_exist);
  if (!colors) throw invalidResponse();

  const slots: MoonrakerFilamentSlot[] = [];
  for (let index = 0; index < Math.min(colors.length, MAX_FILAMENT_SLOTS); index += 1) {
    if (exists && index < exists.length && !loadedValue(exists[index])) continue;
    slots.push(
      Object.freeze({
        slotIndex: index,
        colorHex: normalizedColor(colors[index]),
        material: normalizedMaterial(types?.[index]),
        vendor: safeLabel(vendors?.[index]),
      }),
    );
  }
  return Object.freeze(slots);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalarArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) && value.length <= MAX_FILAMENT_SLOTS * 4 ? value : null;
}

function stringLikeArray(value: unknown): readonly string[] | null {
  const values = scalarArray(value);
  if (!values || values.some((entry) => typeof entry !== 'string' && typeof entry !== 'number')) return null;
  return values.map(String);
}

function loadedValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizedColor(value: string | undefined): string {
  const raw = (value ?? '').trim().replace(/^#/, '');
  const match = /^[0-9a-f]{6}/i.exec(raw);
  return `#${(match?.[0] ?? 'FFFFFF').toUpperCase()}`;
}

/**
 * Reduce a filament name to the family the printer and the slicer can agree on.
 * A slot reported as "PLA-CF" and a profile sliced for "PLA+" are the same
 * material for compatibility purposes, so both sides must normalize identically.
 */
export function normalizeFilamentMaterial(value: string | undefined): string {
  const material = safeLabel(value).toUpperCase();
  for (const known of ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PVA']) {
    if (material.startsWith(known)) return known;
  }
  if (material.startsWith('PA')) return 'PA';
  return material || 'PLA';
}

function normalizedMaterial(value: string | undefined): string {
  return normalizeFilamentMaterial(value);
}

function safeLabel(value: string | undefined): string {
  return [...(value ?? '')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 128);
}

function invalidResponse(): MoonrakerTransportError {
  return new MoonrakerTransportError('invalid_response', 'query_filament_slots');
}
