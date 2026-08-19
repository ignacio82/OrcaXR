/**
 * The active language, and how a surface reads a message from it (P10.4).
 *
 * One instance holds the whole app's language state. Shells subscribe rather
 * than re-reading, because a language switch has to repaint everything at once:
 * a menu that keeps its old labels until it next opens is a worse failure than
 * not switching at all, since the operator cannot tell which parts took effect.
 *
 * Three decisions are worth stating.
 *
 * **A missing message renders its English source, and reports.** Twenty
 * catalogues will always be behind the reference; the alternative — an id, or a
 * blank — turns an untranslated string into a broken screen. Misses are
 * counted so a test can require zero for the languages that claim completeness,
 * which is where the strictness belongs.
 *
 * **Catalogues are fetched, not bundled — the English one included.** Every
 * message's English is already in the bundle, at its call site, as the `source`
 * argument `t` falls back to; a compiled-in reference would be a second copy of
 * text the app already has, paid for by every operator on every load. So the
 * app is never wordless while a catalogue is in flight, and `en.json` is
 * fetched only by what needs the whole set at once: the pseudo-locales.
 *
 * **Nothing here reaches canonical state.** This module formats for display
 * only; `src/project/` may not import it, and the architecture check enforces
 * that. Locale-dependent bytes in a saved project were a real defect once
 * already, and the guard is what keeps localization from reintroducing it.
 */

import { formatMessage, type FormatProblem, type MessageValues } from './icu';
import {
  fallbackChain,
  findLocale,
  isPseudoLocale,
  localeDirection,
  negotiateLocale,
  REFERENCE_LOCALE,
  selectableLocales,
  type LocaleDefinition,
  type TextDirection,
} from './locales';
import { pseudoCatalog } from './pseudo';

export type MessageCatalog = Readonly<Record<string, string>>;

export interface LocalizerOptions {
  /**
   * The English reference, when the caller already has it. Optional because
   * the English lives at each call site: `t` falls back to its `source`
   * argument, so an app with no reference in hand still renders English.
   */
  readonly reference?: MessageCatalog;
  readonly locale?: string;
  /** Loads a catalogue for a locale. Absent means reference-only (tests, SSR). */
  readonly load?: (locale: string) => Promise<MessageCatalog>;
  readonly onProblem?: (problem: FormatProblem) => void;
}

export interface LocaleChange {
  readonly locale: string;
  readonly direction: TextDirection;
  readonly definition: LocaleDefinition | undefined;
}

export type LocaleListener = (change: LocaleChange) => void;

export class Localizer {
  private reference: MessageCatalog;
  private readonly catalogs = new Map<string, MessageCatalog>();
  private readonly listeners = new Set<LocaleListener>();
  private readonly loader?: (locale: string) => Promise<MessageCatalog>;
  private readonly onProblem?: (problem: FormatProblem) => void;
  private readonly misses = new Map<string, Set<string>>();
  private active: string;
  private chain: readonly string[];
  private pending?: string;

  constructor(options: LocalizerOptions) {
    this.reference = options.reference ?? {};
    this.loader = options.load;
    this.onProblem = options.onProblem;
    if (options.reference) this.catalogs.set(REFERENCE_LOCALE, options.reference);
    this.active = findLocale(options.locale ?? REFERENCE_LOCALE)?.id ?? REFERENCE_LOCALE;
    this.chain = fallbackChain(this.active);
    if (isPseudoLocale(this.active) && options.reference) {
      this.catalogs.set(this.active, pseudoCatalog(options.reference, this.active));
    }
  }

  get locale(): string {
    return this.active;
  }

  get direction(): TextDirection {
    return localeDirection(this.active);
  }

  get definition(): LocaleDefinition | undefined {
    return findLocale(this.active);
  }

  /** Languages a picker offers. Pseudo-locales appear only where asked for. */
  available(includePseudo = false): readonly LocaleDefinition[] {
    return selectableLocales(includePseudo);
  }

  /** True once this locale's catalogue is in memory and `t` will not fall back wholesale. */
  isLoaded(locale: string = this.active): boolean {
    return this.catalogs.has(findLocale(locale)?.id ?? locale);
  }

  /**
   * Render one message.
   *
   * `source` is the English text, written at the call site. It is both the
   * fallback and what the extractor records, so the reference catalogue cannot
   * drift from the code: there is only one copy of the English.
   */
  t(id: string, source: string, values?: MessageValues): string {
    const message = this.lookup(id) ?? source;
    return formatMessage(message, {
      locale: this.active,
      values,
      id,
      onProblem: this.onProblem,
    });
  }

  /** Look up without formatting, for a caller that already has the values applied. */
  message(id: string): string | undefined {
    return this.lookup(id);
  }

  private lookup(id: string): string | undefined {
    let found: string | undefined;
    for (const locale of this.chain) {
      const text = this.catalogs.get(locale)?.[id];
      if (typeof text === 'string' && text.length > 0) {
        found = text;
        break;
      }
      // Recorded against the *active* locale even when a fallback supplies the
      // text, because "German renders English here" is precisely the fact the
      // completeness gate needs; a chain that silently repaired it would report
      // a full catalogue that is not one.
      if (locale === this.active && this.active !== REFERENCE_LOCALE) this.recordMiss(this.active, id);
    }
    return found ?? this.reference[id];
  }

  private recordMiss(locale: string, id: string): void {
    const set = this.misses.get(locale) ?? new Set<string>();
    set.add(id);
    this.misses.set(locale, set);
  }

  /** Message ids this locale had no translation for. The completeness gate reads it. */
  missingMessages(locale: string = this.active): readonly string[] {
    return Object.freeze([...(this.misses.get(locale) ?? [])].sort());
  }

  /**
   * Switch language.
   *
   * The catalogue is loaded *before* the active locale moves, so a slow network
   * shows the current language rather than a screen of English on the way to
   * German. A switch that fails leaves the previous language in place and says
   * so, because half-applying a language is not a state anyone can work in.
   */
  async setLocale(request: string): Promise<boolean> {
    const target = findLocale(request)?.id;
    if (!target) {
      this.onProblem?.({ code: 'unknown-format', message: `No catalogue for locale "${request}"` });
      return false;
    }
    if (target === this.active) return true;
    if (!this.catalogs.has(target)) {
      if (isPseudoLocale(target)) {
        // Derived, not fetched — a transform of the reference, so there is no
        // `en-XA.json` to go stale against the strings it is meant to test.
        // It does need the whole reference, which is the one case that fetches
        // English rather than relying on the call sites.
        const reference = await this.ensureReference();
        if (!reference) return false;
        this.catalogs.set(target, pseudoCatalog(reference, target));
      } else if (this.loader) {
        this.pending = target;
        try {
          const catalog = await this.loader(target);
          // A second switch may have started while this one was in flight; the
          // later request wins, and this result is kept for when it is asked
          // for rather than thrown away.
          this.catalogs.set(target, catalog);
          if (this.pending !== target) return false;
        } catch (error) {
          this.onProblem?.({
            code: 'unknown-format',
            message: `Could not load ${target}: ${error instanceof Error ? error.message : String(error)}`,
          });
          return false;
        } finally {
          if (this.pending === target) this.pending = undefined;
        }
      } else if (target !== REFERENCE_LOCALE) {
        this.onProblem?.({ code: 'unknown-format', message: `No loader configured for "${target}"` });
        return false;
      }
    }
    this.apply(target);
    return true;
  }

  /**
   * The full English catalogue, fetched on first need.
   *
   * Only the pseudo-locales need it: ordinary rendering falls back to the
   * source text written at each call site, which is already in the bundle.
   */
  private async ensureReference(): Promise<MessageCatalog | undefined> {
    if (Object.keys(this.reference).length > 0) return this.reference;
    if (!this.loader) {
      this.onProblem?.({ code: 'unknown-format', message: 'No loader configured for the English catalogue' });
      return undefined;
    }
    try {
      this.reference = await this.loader(REFERENCE_LOCALE);
      this.catalogs.set(REFERENCE_LOCALE, this.reference);
      return this.reference;
    } catch (error) {
      this.onProblem?.({
        code: 'unknown-format',
        message: `Could not load the English catalogue: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  /** Switch to a catalogue already in hand — the synchronous path tests use. */
  setCatalog(locale: string, catalog: MessageCatalog): void {
    const target = findLocale(locale)?.id ?? locale;
    this.catalogs.set(target, catalog);
    this.apply(target);
  }

  private apply(locale: string): void {
    this.active = locale;
    this.chain = fallbackChain(locale);
    const change: LocaleChange = Object.freeze({
      locale,
      direction: localeDirection(locale),
      definition: findLocale(locale),
    });
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Repaint on language change. Returns an unsubscribe. */
  subscribe(listener: LocaleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Choose a language from the browser's stated preferences.
   *
   * Applied only when the operator has not chosen one: a stored choice is a
   * decision, and re-deriving from `navigator.languages` on every load would
   * quietly overrule it whenever they used a different device.
   */
  async adoptPreferred(preferred: readonly string[]): Promise<boolean> {
    return this.setLocale(negotiateLocale(preferred));
  }
}

/**
 * Fetch a catalogue the way the app ships them: one JSON file per locale beside
 * the build, verified to be an object of strings before it is trusted. A
 * catalogue is remote data and a malformed one must not put `undefined` into a
 * label.
 */
export function createCatalogLoader(base = 'l10n/', fetchImpl: typeof fetch = fetch) {
  return async (locale: string): Promise<MessageCatalog> => {
    const response = await fetchImpl(`${base}${locale}.json`);
    if (!response.ok) throw new Error(`${locale} catalogue is not available (${response.status})`);
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${locale} catalogue is not an object`);
    }
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[id] = value;
    }
    return Object.freeze(out);
  };
}
