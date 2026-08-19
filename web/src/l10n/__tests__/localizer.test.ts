/**
 * Traces for the language a surface renders in (P10.4).
 *
 * What is held here is the behaviour around the edges of a language switch,
 * because those are the states an operator actually hits: a catalogue that is
 * still loading, one that failed, one that is missing a message, and two
 * switches racing each other. The happy path — German catalogue in memory,
 * German label out — is the easy half and the one least likely to break.
 */

import assert from 'node:assert/strict';

import { createCatalogLoader, Localizer, type MessageCatalog } from '../Localizer';
import { fallbackChain, negotiateLocale, PSEUDO_LONG_LOCALE, PSEUDO_RTL_LOCALE, selectableLocales } from '../locales';
import { pseudoLocalize, unpseudo } from '../pseudo';
import type { FormatProblem } from '../icu';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const reference: MessageCatalog = Object.freeze({
  'app.slice': 'Slice',
  'app.objects': '{count, plural, one {# object} other {# objects}}',
  'app.untranslated': 'Only in English',
});

const german: MessageCatalog = Object.freeze({
  'app.slice': 'Aufschneiden',
  'app.objects': '{count, plural, one {# Objekt} other {# Objekte}}',
});

function make(options: Partial<ConstructorParameters<typeof Localizer>[0]> = {}): Localizer {
  return new Localizer({ reference, ...options });
}

/** A localizer with no reference in hand — how the app itself is built. */
function bare(load: (locale: string) => Promise<MessageCatalog>): Localizer {
  return new Localizer({ load });
}

await test('the reference language renders the source text it was given', () => {
  const l10n = make();
  assert.equal(l10n.t('app.slice', 'Slice'), 'Slice');
  assert.equal(l10n.t('app.objects', '', { count: 2 }), '2 objects');
  assert.equal(l10n.locale, 'en');
  assert.equal(l10n.direction, 'ltr');
});

await test('a switched language renders its catalogue, plurals and all', () => {
  const l10n = make();
  l10n.setCatalog('de', german);
  assert.equal(l10n.locale, 'de');
  assert.equal(l10n.t('app.slice', 'Slice'), 'Aufschneiden');
  assert.equal(l10n.t('app.objects', '', { count: 1 }), '1 Objekt');
  assert.equal(l10n.t('app.objects', '', { count: 5 }), '5 Objekte');
});

await test('a message the catalogue lacks falls back to English rather than to an id', () => {
  // The alternative — rendering `app.untranslated`, or nothing — turns one
  // missing string into a screen that looks broken instead of one that looks
  // partly translated, which is what it is.
  const l10n = make();
  l10n.setCatalog('de', german);
  assert.equal(l10n.t('app.untranslated', 'Only in English'), 'Only in English');
  assert.deepEqual(l10n.missingMessages('de'), ['app.untranslated']);
});

await test('an unknown id falls back to the source written at the call site', () => {
  const l10n = make();
  l10n.setCatalog('de', german);
  assert.equal(l10n.t('app.brandNew', 'Brand new'), 'Brand new');
});

await test('subscribers are told the language and its direction, once per switch', () => {
  const l10n = make();
  const seen: string[] = [];
  const stop = l10n.subscribe((change) => seen.push(`${change.locale}:${change.direction}`));
  l10n.setCatalog('de', german);
  l10n.setCatalog('ar-XB', {});
  stop();
  l10n.setCatalog('fr', {});
  assert.deepEqual(seen, ['de:ltr', 'ar-XB:rtl']);
});

await test('a switch loads the catalogue before the language moves', async () => {
  // A slow network must not show a screen of English on the way to German: the
  // active locale only advances once there is something to render in it.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const l10n = make({
    load: async (locale) => {
      await gate;
      return locale === 'de' ? german : {};
    },
  });
  const pending = l10n.setLocale('de');
  assert.equal(l10n.locale, 'en', 'still English while the catalogue is in flight');
  release?.();
  assert.equal(await pending, true);
  assert.equal(l10n.locale, 'de');
  assert.equal(l10n.t('app.slice', 'Slice'), 'Aufschneiden');
});

await test('a failed load leaves the previous language in place and reports', async () => {
  const problems: FormatProblem[] = [];
  const l10n = make({
    load: async () => {
      throw new Error('offline');
    },
    onProblem: (problem) => problems.push(problem),
  });
  assert.equal(await l10n.setLocale('fr'), false);
  assert.equal(l10n.locale, 'en', 'half-applying a language is not a state anyone can work in');
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /offline/);
});

await test('when two switches race, the later request wins', async () => {
  const gates = new Map<string, () => void>();
  const l10n = make({
    load: (locale) =>
      new Promise<MessageCatalog>((resolve) => {
        gates.set(locale, () => resolve(locale === 'de' ? german : { 'app.slice': 'Trancher' }));
      }),
  });
  const first = l10n.setLocale('de');
  const second = l10n.setLocale('fr');
  // The slow one lands first, which is exactly the case that gets this wrong.
  gates.get('de')?.();
  assert.equal(await first, false, 'the superseded switch does not take effect');
  gates.get('fr')?.();
  assert.equal(await second, true);
  assert.equal(l10n.locale, 'fr');
  assert.equal(l10n.t('app.slice', 'Slice'), 'Trancher');
});

await test('a locale nobody offers is refused instead of leaving a blank app', async () => {
  const problems: FormatProblem[] = [];
  const l10n = make({ onProblem: (problem) => problems.push(problem) });
  assert.equal(await l10n.setLocale('kl-GL'), false);
  assert.equal(l10n.locale, 'en');
  assert.equal(problems.length, 1);
});

await test('pseudo-locales are derived from the reference, not fetched', async () => {
  // There is no `en-XA.json` to go stale: it is a transform of the reference,
  // so it cannot fall behind the strings it is meant to be testing.
  const l10n = make();
  assert.equal(await l10n.setLocale(PSEUDO_LONG_LOCALE), true);
  const rendered = l10n.t('app.slice', 'Slice');
  assert.notEqual(rendered, 'Slice');
  assert.equal(unpseudo(rendered), 'Slice');
  assert.equal(l10n.direction, 'ltr');

  assert.equal(await l10n.setLocale(PSEUDO_RTL_LOCALE), true);
  assert.equal(l10n.direction, 'rtl', 'the mirrored pseudo-locale is what exercises RTL layout');
});

await test('an app with no reference in hand still renders English from its call sites', async () => {
  // This is how `main.ts` builds it. Shipping the whole English catalogue in
  // the bundle would be a second copy of text that is already at every call
  // site, paid for by every operator on every load.
  let fetched = 0;
  const l10n = bare(async (locale) => {
    fetched += 1;
    return locale === 'de' ? german : reference;
  });
  assert.equal(l10n.t('app.slice', 'Slice'), 'Slice');
  assert.equal(fetched, 0, 'rendering English fetches nothing');
  assert.equal(await l10n.setLocale('de'), true);
  assert.equal(l10n.t('app.slice', 'Slice'), 'Aufschneiden');
  assert.equal(l10n.t('app.untranslated', 'Only in English'), 'Only in English', 'and still falls back');
});

await test('a pseudo-locale fetches English once, because it needs the whole set', async () => {
  // The one case that genuinely needs the reference: pseudo-localization is a
  // transform *of the catalogue*, not of whatever happens to be on screen.
  const asked: string[] = [];
  const l10n = bare(async (locale) => {
    asked.push(locale);
    return reference;
  });
  assert.equal(await l10n.setLocale(PSEUDO_LONG_LOCALE), true);
  assert.deepEqual(asked, ['en']);
  assert.equal(unpseudo(l10n.t('app.slice', 'Slice')), 'Slice');
  assert.equal(await l10n.setLocale(PSEUDO_RTL_LOCALE), true);
  assert.deepEqual(asked, ['en'], 'the second pseudo-locale reuses it');
});

await test('a pseudo-locale that cannot reach English is refused, not shown half-applied', async () => {
  const problems: FormatProblem[] = [];
  const l10n = new Localizer({
    load: async () => {
      throw new Error('offline');
    },
    onProblem: (problem) => problems.push(problem),
  });
  assert.equal(await l10n.setLocale(PSEUDO_LONG_LOCALE), false);
  assert.equal(l10n.locale, 'en');
  assert.equal(problems.length, 1);
});

await test('a pseudo-locale never falls back through a real language', () => {
  // `ar-XB` means "mirror English". Reading real Arabic for the messages that
  // happen to have it would hide the layout defects the run looks for.
  assert.deepEqual(fallbackChain(PSEUDO_RTL_LOCALE), ['ar-XB', 'en']);
  assert.deepEqual(fallbackChain('zh-Hant'), ['zh-Hant', 'en']);
  assert.deepEqual(fallbackChain('en'), ['en']);
});

await test('a browser preference picks a language by priority, skipping what we cannot serve', () => {
  assert.equal(negotiateLocale(['kl-GL', 'ca', 'es']), 'ca', 'the first preference we can serve wins');
  assert.equal(negotiateLocale(['de-AT']), 'de', 'a region we do not ship falls back to its language');
  assert.equal(negotiateLocale(['zh']), 'zh-Hans', 'a language that needs a script still picks one');
  assert.equal(negotiateLocale(['kl-GL']), 'en');
  assert.equal(negotiateLocale([]), 'en');
});

await test('pseudo-locales are instruments, so a language picker does not offer them', () => {
  const offered = selectableLocales().map((locale) => locale.id);
  assert.ok(offered.includes('de'));
  assert.ok(!offered.includes(PSEUDO_LONG_LOCALE));
  assert.ok(selectableLocales(true).some((locale) => locale.id === PSEUDO_LONG_LOCALE));
  // Every offered language names itself in its own script; a picker that lists
  // "German" to someone who reads only German is a list they cannot use.
  for (const locale of selectableLocales()) {
    assert.ok(locale.endonym.length > 0, `${locale.id} has an endonym`);
    assert.ok(locale.englishName.length > 0, `${locale.id} has an English name`);
  }
});

await test('pseudo-localization expands and brackets while leaving ICU structure alone', () => {
  // Transforming the inside of a plural would produce a message that fails to
  // parse, and the run would then be testing the error path instead of layout.
  const source = '{count, plural, one {# object} other {# objects}}';
  const pseudo = pseudoLocalize(source);
  assert.ok(pseudo.includes('{count, plural,'), 'the placeholder head is untouched');
  assert.ok(pseudo.includes('#'), 'the number marker survives');
  assert.ok(/[äöéñ]/.test(pseudo), 'the branch bodies are accented');
  assert.ok(pseudo.startsWith('⟦') && pseudo.endsWith('⟧'), 'brackets make truncation visible');

  const plain = pseudoLocalize('Slice');
  assert.ok(plain.length > 'Slice'.length + 2, 'expansion is what finds a clipped control');
});

await test('a pseudo-localized message still renders through the real formatter', () => {
  const l10n = make();
  l10n.setCatalog(PSEUDO_LONG_LOCALE, {
    'app.objects': pseudoLocalize('{count, plural, one {# object} other {# objects}}'),
  });
  const rendered = l10n.t('app.objects', '', { count: 3 });
  assert.ok(rendered.includes('3'), 'the count is still substituted');
  assert.ok(unpseudo(rendered).includes('3 objects'), 'and the branch chosen is still the right one');
});

await test('a catalogue arriving from the network is validated before it is trusted', async () => {
  const loader = createCatalogLoader('l10n/', (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('de.json')) {
      // A non-string value must not become a label reading "undefined".
      return new Response(JSON.stringify({ 'app.slice': 'Aufschneiden', 'app.bad': 42 }));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch);
  const catalog = await loader('de');
  assert.deepEqual(catalog, { 'app.slice': 'Aufschneiden' });
  await assert.rejects(loader('fr'), /not available \(404\)/);
});

console.log(`\nLocalizer: ${passed} tests passed.`);
