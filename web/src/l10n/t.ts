/**
 * `t` — how a surface asks for text, from anywhere it draws (P10.4.3).
 *
 * The action catalogue reaches its translations through the registry, which is
 * one seam for two hundred labels. Everything else — a status line, a dialog's
 * prose, a panel heading, a confirmation — is written at the point it is shown,
 * across forty-odd files that have no reason to know about languages. Threading
 * a `Localizer` through every one of their constructors would make the sweep
 * expensive enough that it would not finish, and an unfinished sweep is the
 * thing this is meant to avoid.
 *
 * So the active localizer is installed once by the entry point and read from
 * here. Three properties keep that from being the usual global-state mistake.
 *
 * **It cannot be reached from canonical code.** `src/project/` may not import
 * `src/l10n/`, and `architecture:check` enforces it. The danger with ambient
 * state is that it leaks into a decision that must be reproducible; the layer
 * where that would matter cannot see this module at all.
 *
 * **Nothing has to install it.** With no localizer, `t` returns the English
 * written at the call site — so every headless test, every worker, and every
 * surface constructed before the app boots renders correctly with no setup.
 *
 * **The English is the argument.** `t('gcode.empty', 'No G-code yet')` carries
 * its own source text, which is both the fallback and what the extractor
 * records. There is only ever one copy of the English, so the catalogue cannot
 * drift from the code.
 */

import { formatMessage, type MessageValues } from './icu';
import { REFERENCE_LOCALE } from './locales';
import type { Localizer } from './Localizer';

let active: Localizer | undefined;

/**
 * Install the app's localizer. Called once by the entry point, before any
 * surface is built.
 */
export function installLocalizer(localizer: Localizer | undefined): void {
  active = localizer;
}

/** The localizer in force, if one was installed. */
export function currentLocalizer(): Localizer | undefined {
  return active;
}

/** The active language, for a caller that needs to format something itself. */
export function currentLocale(): string {
  return active?.locale ?? REFERENCE_LOCALE;
}

/**
 * Render one message.
 *
 * `id` is a dotted, stable name and `source` is its English. Both must be
 * string literals: `scripts/generate-messages.mjs` reads them off the syntax
 * tree, and a computed argument is a string that would silently never be
 * translated, which is exactly the failure the extraction gate exists to catch.
 */
export function t(id: string, source: string, values?: MessageValues): string {
  if (active) return active.t(id, source, values);
  // No localizer: still format, so `{count, plural, …}` renders as a sentence
  // rather than as its own syntax. A test that reads a label should see what an
  // operator sees, minus the translation.
  return values === undefined ? source : formatMessage(source, { locale: REFERENCE_LOCALE, values, id });
}
