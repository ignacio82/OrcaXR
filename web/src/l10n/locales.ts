/**
 * The languages OrcaXR offers, and what a locale tag means here (P10.4).
 *
 * The list is not invented. Snapmaker OrcaSlicer ships twenty translated
 * catalogues at the parity commit plus English, and those are the languages a
 * user of the official application already has. Offering a different set would
 * make "the same workflows in the user's language" false for someone the
 * desktop app serves, and offering a language with no catalogue behind it is
 * worse than offering none — it promises a translation and delivers English
 * with a different label on it.
 *
 * Direction is carried here rather than derived at the point of use.
 * `Intl.Locale.prototype.getTextInfo` is not available everywhere OrcaXR runs,
 * and a wrong guess is not a cosmetic defect: it mirrors the entire layout.
 * None of the twenty is RTL, which is a fact about upstream's catalogue and is
 * recorded as such — the RTL path is exercised by the pseudo-locale below
 * rather than left untested because no shipped language needs it.
 */

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleDefinition {
  /** BCP-47 tag. */
  readonly id: string;
  /** Upstream's catalogue directory at the parity commit, when it has one. */
  readonly upstreamDirectory?: string;
  /** The language's name in that language — what a language picker must show. */
  readonly endonym: string;
  /** English name, for operators picking a language they cannot yet read. */
  readonly englishName: string;
  readonly direction: TextDirection;
  /** True for the reference language: its "translation" is the source text. */
  readonly isReference?: boolean;
  /** True for generated locales that are a test instrument, not a language. */
  readonly isPseudo?: boolean;
}

/** The reference language. Every message's source text is written in it. */
export const REFERENCE_LOCALE = 'en';

/**
 * Pseudo-locales, in the shape browsers and CLDR reserve for them (`en-XA`,
 * `ar-XB`). They are how the two layout requirements in P10.4 get tested on
 * every run instead of on the day someone ships a long language:
 * `en-XA` expands and accents every message, `ar-XB` mirrors it right-to-left.
 */
export const PSEUDO_LONG_LOCALE = 'en-XA';
export const PSEUDO_RTL_LOCALE = 'ar-XB';

export const LOCALES: readonly LocaleDefinition[] = Object.freeze([
  {
    id: 'en',
    upstreamDirectory: 'en',
    endonym: 'English',
    englishName: 'English',
    direction: 'ltr',
    isReference: true,
  },
  { id: 'ca', upstreamDirectory: 'ca', endonym: 'Català', englishName: 'Catalan', direction: 'ltr' },
  { id: 'cs', upstreamDirectory: 'cs', endonym: 'Čeština', englishName: 'Czech', direction: 'ltr' },
  { id: 'de', upstreamDirectory: 'de', endonym: 'Deutsch', englishName: 'German', direction: 'ltr' },
  { id: 'es', upstreamDirectory: 'es', endonym: 'Español', englishName: 'Spanish', direction: 'ltr' },
  { id: 'fr', upstreamDirectory: 'fr', endonym: 'Français', englishName: 'French', direction: 'ltr' },
  { id: 'hu', upstreamDirectory: 'hu', endonym: 'Magyar', englishName: 'Hungarian', direction: 'ltr' },
  { id: 'it', upstreamDirectory: 'it', endonym: 'Italiano', englishName: 'Italian', direction: 'ltr' },
  { id: 'ja', upstreamDirectory: 'ja', endonym: '日本語', englishName: 'Japanese', direction: 'ltr' },
  { id: 'ko', upstreamDirectory: 'ko', endonym: '한국어', englishName: 'Korean', direction: 'ltr' },
  { id: 'lt', upstreamDirectory: 'lt', endonym: 'Lietuvių', englishName: 'Lithuanian', direction: 'ltr' },
  { id: 'nl', upstreamDirectory: 'nl', endonym: 'Nederlands', englishName: 'Dutch', direction: 'ltr' },
  { id: 'pl', upstreamDirectory: 'pl', endonym: 'Polski', englishName: 'Polish', direction: 'ltr' },
  {
    id: 'pt-BR',
    upstreamDirectory: 'pt_BR',
    endonym: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    direction: 'ltr',
  },
  { id: 'ru', upstreamDirectory: 'ru', endonym: 'Русский', englishName: 'Russian', direction: 'ltr' },
  { id: 'sv', upstreamDirectory: 'sv', endonym: 'Svenska', englishName: 'Swedish', direction: 'ltr' },
  { id: 'tr', upstreamDirectory: 'tr', endonym: 'Türkçe', englishName: 'Turkish', direction: 'ltr' },
  { id: 'uk', upstreamDirectory: 'uk', endonym: 'Українська', englishName: 'Ukrainian', direction: 'ltr' },
  {
    id: 'zh-Hans',
    upstreamDirectory: 'zh_CN',
    endonym: '简体中文',
    englishName: 'Chinese (Simplified)',
    direction: 'ltr',
  },
  {
    id: 'zh-Hant',
    upstreamDirectory: 'zh_TW',
    endonym: '繁體中文',
    englishName: 'Chinese (Traditional)',
    direction: 'ltr',
  },
  {
    id: PSEUDO_LONG_LOCALE,
    endonym: 'Pseudo (long)',
    englishName: 'Pseudo-localized, expanded',
    direction: 'ltr',
    isPseudo: true,
  },
  {
    id: PSEUDO_RTL_LOCALE,
    endonym: 'Pseudo (RTL)',
    englishName: 'Pseudo-localized, right-to-left',
    direction: 'rtl',
    isPseudo: true,
  },
]);

const BY_ID: ReadonlyMap<string, LocaleDefinition> = new Map(LOCALES.map((locale) => [locale.id, locale]));
const BY_LOWER_ID: ReadonlyMap<string, LocaleDefinition> = new Map(
  LOCALES.map((locale) => [locale.id.toLowerCase(), locale]),
);

/** Locales a language picker offers. Pseudo-locales are instruments, not languages. */
export function selectableLocales(includePseudo = false): readonly LocaleDefinition[] {
  return LOCALES.filter((locale) => includePseudo || !locale.isPseudo);
}

export function findLocale(id: string): LocaleDefinition | undefined {
  return BY_ID.get(id) ?? BY_LOWER_ID.get(id.toLowerCase());
}

export function localeDirection(id: string): TextDirection {
  return findLocale(id)?.direction ?? 'ltr';
}

export function isPseudoLocale(id: string): boolean {
  return findLocale(id)?.isPseudo === true;
}

/**
 * The order a message is looked up in: the exact locale, then progressively
 * shorter tags, then the reference.
 *
 * `zh-Hant-HK` should read `zh-Hant` before falling all the way to English —
 * the alternative is that one unwritten message drops a whole screen back to a
 * language the reader may not have.
 */
export function fallbackChain(id: string): readonly string[] {
  const chain: string[] = [];
  const push = (tag: string) => {
    if (tag && !chain.includes(tag)) chain.push(tag);
  };
  const resolved = findLocale(id);
  push(resolved?.id ?? id);
  const parts = (resolved?.id ?? id).split('-');
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const prefix = parts.slice(0, length).join('-');
    const known = findLocale(prefix);
    // A pseudo-locale must not fall back through its base language: `ar-XB`
    // means "mirror English", and reading real Arabic for the messages that
    // happen to exist would hide exactly the layout defects it looks for.
    if (known && !known.isPseudo) push(known.id);
  }
  push(REFERENCE_LOCALE);
  return Object.freeze(chain);
}

/**
 * Pick the best offered language for a browser's stated preferences.
 *
 * Ordered by the *user's* priority, not ours: someone who lists Catalan before
 * Spanish gets Catalan, and a preference we cannot serve is skipped rather than
 * treated as a reason to stop looking.
 */
export function negotiateLocale(
  preferred: readonly string[],
  offered: readonly LocaleDefinition[] = selectableLocales(),
): string {
  const available = new Map(offered.map((locale) => [locale.id.toLowerCase(), locale.id]));
  for (const request of preferred) {
    const tag = request.trim();
    if (!tag) continue;
    const exact = available.get(tag.toLowerCase());
    if (exact) return exact;
    const parts = tag.split('-');
    // Starts at the full tag rather than at its first prefix: a bare `zh` has
    // no shorter prefix to try, and dropping it to English would be worse than
    // picking one of the two scripts we ship.
    for (let length = parts.length; length >= 1; length -= 1) {
      const prefix = parts.slice(0, length).join('-').toLowerCase();
      const match = available.get(prefix);
      if (match) return match;
      // `zh` alone cannot choose between Hans and Hant, so take the first
      // offered locale in that language rather than dropping to English.
      const byLanguage = offered.find((locale) => locale.id.toLowerCase().startsWith(`${prefix}-`));
      if (byLanguage) return byLanguage.id;
    }
  }
  return REFERENCE_LOCALE;
}
