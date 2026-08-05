import type { Action } from './ActionRegistry';

export interface ParsedShortcut {
  readonly source: string;
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Stable comparison key; modifier order never depends on authored text. */
  readonly canonical: string;
  readonly display: string;
}

export interface ShortcutCatalogEntry extends ParsedShortcut {
  readonly actionId: string;
  readonly actionLabel: string;
  readonly unavailable: boolean;
}

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

const MODIFIERS = new Map<string, 'ctrl' | 'meta' | 'alt' | 'shift'>([
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['meta', 'meta'],
  ['cmd', 'meta'],
  ['command', 'meta'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['shift', 'shift'],
]);

const NAMED_KEYS = new Map<string, string>([
  ['del', 'Delete'],
  ['delete', 'Delete'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['space', ' '],
  ['spacebar', ' '],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['arrowup', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['arrowleft', 'ArrowLeft'],
  ['arrowright', 'ArrowRight'],
]);

/**
 * Parse the deliberately small registry shortcut grammar. Invalid declarations
 * are release-time errors; a malformed shortcut must never become a surprising
 * runtime gesture.
 */
export function parseShortcut(source: string): ParsedShortcut {
  if (!source.trim()) throw new Error('Shortcut declaration is empty');
  const tokens = source.split('+').map((token) => token.trim());
  if (tokens.some((token) => !token)) throw new Error(`Shortcut "${source}" contains an empty token`);

  const flags = { ctrl: false, meta: false, alt: false, shift: false };
  let key: string | undefined;
  for (const token of tokens) {
    const modifier = MODIFIERS.get(token.toLowerCase());
    if (modifier) {
      if (flags[modifier]) throw new Error(`Shortcut "${source}" repeats ${modifier}`);
      flags[modifier] = true;
      continue;
    }
    if (key !== undefined) throw new Error(`Shortcut "${source}" declares more than one key`);
    key = normalizeKey(token);
  }
  if (key === undefined) throw new Error(`Shortcut "${source}" has no key`);
  if (isModifierKey(key)) throw new Error(`Shortcut "${source}" cannot use a bare modifier as its key`);

  return Object.freeze({
    source,
    key,
    ...flags,
    canonical: canonicalShortcut(key, flags),
    display: displayShortcut(key, flags),
  });
}

/**
 * Build the only keyboard catalog from action metadata and reject ambiguous
 * gestures up front. Registry order is retained for deterministic help output.
 */
export function buildShortcutCatalog(actions: readonly Action[]): readonly ShortcutCatalogEntry[] {
  const entries: ShortcutCatalogEntry[] = [];
  const ownerByGesture = new Map<string, string>();
  for (const action of actions) {
    for (const source of action.shortcuts ?? []) {
      const parsed = parseShortcut(source);
      const owner = ownerByGesture.get(parsed.canonical);
      if (owner && owner !== action.id) {
        throw new Error(`Shortcut ${parsed.display} is assigned to both ${owner} and ${action.id}`);
      }
      ownerByGesture.set(parsed.canonical, action.id);
      entries.push(
        Object.freeze({
          ...parsed,
          actionId: action.id,
          actionLabel: action.label,
          unavailable: action.capability.status === 'unavailable' || action.capability.status === 'blocked',
        }),
      );
    }
  }
  return Object.freeze(entries);
}

/** Return the exact registry entry for an event, or undefined for no gesture. */
export function matchShortcut(
  catalog: readonly ShortcutCatalogEntry[],
  event: ShortcutKeyEvent,
): ShortcutCatalogEntry | undefined {
  if (
    event.repeat ||
    event.isComposing ||
    event.key === 'Dead' ||
    event.key === 'Unidentified' ||
    isModifierKey(event.key)
  )
    return undefined;
  const key = normalizeKey(event.key);
  const canonical = canonicalShortcut(key, {
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
  return catalog.find((entry) => entry.canonical === canonical);
}

/** Text entry owns printable/action keys; global shortcuts must stay outside it. */
export function isShortcutEditingTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]',
    ),
  );
}

export function shortcutHelpRows(actions: readonly Action[]): readonly {
  readonly actionId: string;
  readonly actionLabel: string;
  readonly displays: readonly string[];
  readonly unavailable: boolean;
}[] {
  const entries = buildShortcutCatalog(actions);
  const rows = new Map<
    string,
    {
      actionId: string;
      actionLabel: string;
      displays: string[];
      unavailable: boolean;
    }
  >();
  for (const entry of entries) {
    const row = rows.get(entry.actionId) ?? {
      actionId: entry.actionId,
      actionLabel: entry.actionLabel,
      displays: [],
      unavailable: entry.unavailable,
    };
    row.displays.push(entry.display);
    rows.set(entry.actionId, row);
  }
  return Object.freeze(
    [...rows.values()].map((row) =>
      Object.freeze({
        ...row,
        displays: Object.freeze([...row.displays]),
      }),
    ),
  );
}

/** WAI-ARIA serialization for the same strict registry declarations. */
export function ariaShortcutValue(shortcuts: readonly string[] | undefined): string | undefined {
  if (!shortcuts?.length) return undefined;
  return shortcuts
    .map((source) => {
      const shortcut = parseShortcut(source);
      const parts: string[] = [];
      if (shortcut.ctrl) parts.push('Control');
      if (shortcut.meta) parts.push('Meta');
      if (shortcut.alt) parts.push('Alt');
      if (shortcut.shift) parts.push('Shift');
      parts.push(
        shortcut.key === ' ' ? 'Space' : shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key,
      );
      return parts.join('+');
    })
    .join(' ');
}

function normalizeKey(value: string): string {
  if (value === ' ') return ' ';
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Shortcut key is empty');
  const named = NAMED_KEYS.get(trimmed.toLowerCase());
  if (named !== undefined) return named;
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) return trimmed.toLowerCase();
  throw new Error(`Unsupported shortcut key "${value}"`);
}

function isModifierKey(key: string): boolean {
  return MODIFIERS.has(key.toLowerCase());
}

function canonicalShortcut(
  key: string,
  flags: Readonly<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }>,
): string {
  return `${flags.ctrl ? 1 : 0}${flags.meta ? 1 : 0}${flags.alt ? 1 : 0}${flags.shift ? 1 : 0}:${key}`;
}

function displayShortcut(
  key: string,
  flags: Readonly<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }>,
): string {
  const parts: string[] = [];
  if (flags.ctrl) parts.push('Ctrl');
  if (flags.meta) parts.push('⌘');
  if (flags.alt) parts.push('Alt');
  if (flags.shift) parts.push('Shift');
  parts.push(key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}
