/**
 * Traces for the shipped catalogues and the strings they cover (P10.4).
 *
 * The generator seeds from upstream's twenty reviewed `.po` files, which is a
 * real head start and also a real risk: those translations were written for
 * upstream's controls, and matching on English alone cannot tell a shared label
 * from a coincidence. So what is held here is not "the catalogues are full" —
 * they are not, and pretending otherwise would be the failure mode — but that
 * everything in them is *structurally* safe to render, that nothing was
 * invented, and that no user-facing action string escaped extraction.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildRegistry } from '../../actions/catalog';
import { formatMessage, isValidMessage, messageArguments } from '../icu';
import { Localizer } from '../Localizer';
import { LOCALES, REFERENCE_LOCALE, PSEUDO_LONG_LOCALE, PSEUDO_RTL_LOCALE } from '../locales';
import { pseudoCatalog, unpseudo } from '../pseudo';

let passed = 0;
function test(name: string, run: () => void | string): void {
  const note = run();
  passed += 1;
  console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`);
}

const l10nRoot = resolve(import.meta.dirname, '../../../public/l10n');
// The English catalogue ships as a file rather than a module, so a build does
// not carry a second copy of text that is already at every call site.
const REFERENCE_MESSAGES = JSON.parse(readFileSync(resolve(l10nRoot, 'en.json'), 'utf8')) as Record<string, string>;
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../generated/catalog-manifest.json'), 'utf8'),
) as {
  schemaVersion: number;
  upstream: { commit: string };
  messageCount: number;
  actionMessageCount: number;
  catalogs: { locale: string; blob: string; translated: number; upstreamPath: string }[];
};

const catalogs = new Map<string, Record<string, string>>(
  manifest.catalogs.map((entry) => [
    entry.locale,
    JSON.parse(readFileSync(resolve(l10nRoot, `${entry.locale}.json`), 'utf8')) as Record<string, string>,
  ]),
);

test('every action string is in the reference, by construction', () => {
  // The registry is the one declaration of what OrcaXR can do, so extraction
  // reads it directly. There is no second table to fall behind, and this holds
  // that: adding an action without a message id is not possible, it is a
  // failure here.
  const registry = buildRegistry();
  const missing: string[] = [];
  for (const action of registry.allSource()) {
    const expect = (suffix: string, text: string | undefined) => {
      if (text === undefined) return;
      const id = `action.${action.id}.${suffix}`;
      if (REFERENCE_MESSAGES[id] !== text) missing.push(`${id} (${JSON.stringify(text)})`);
    };
    expect('label', action.label);
    expect('hint', action.hint);
    expect('reason', action.capability.reason);
    expect('xrUnsupported', action.xrUnsupportedReason);
  }
  assert.deepEqual(missing, [], 'run `npm run l10n:sync` after changing an action');
  assert.equal(manifest.actionMessageCount > 0, true);
});

test('the reference is exactly what the manifest says it is', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(Object.keys(REFERENCE_MESSAGES).length, manifest.messageCount);
  for (const [id, source] of Object.entries(REFERENCE_MESSAGES)) {
    assert.ok(source.length > 0, `${id} has text`);
    assert.ok(isValidMessage(source), `${id} is valid ICU: ${JSON.stringify(source)}`);
  }
});

test('every shipped catalogue translates only ids this build has', () => {
  // A stale id is not harmless: it is a translation nobody will ever see,
  // hiding the fact that the string it belonged to went untranslated when it
  // was renamed.
  for (const [locale, catalog] of catalogs) {
    for (const [id, text] of Object.entries(catalog)) {
      assert.ok(id in REFERENCE_MESSAGES, `${locale} translates unknown id ${id}`);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, `${locale}:${id} is empty`);
    }
  }
});

test('no translation drops a placeholder its source needs', () => {
  // The defect this prevents is specific and bad: a translated sentence that
  // lost `{count}` renders "objects will be deleted" with no number in it, and
  // the operator confirms a destructive action without the fact they needed.
  for (const [locale, catalog] of catalogs) {
    for (const [id, text] of Object.entries(catalog)) {
      assert.deepEqual(
        messageArguments(text),
        messageArguments(REFERENCE_MESSAGES[id]),
        `${locale}:${id} changed its arguments`,
      );
    }
  }
});

test('every translation parses, so no language can take a panel down', () => {
  for (const [locale, catalog] of catalogs) {
    for (const [id, text] of Object.entries(catalog)) {
      assert.ok(isValidMessage(text), `${locale}:${id} is not valid ICU: ${JSON.stringify(text)}`);
    }
  }
});

test('every translated message actually renders in its own language', () => {
  // Parsing is not rendering: a message can parse and still fail on a plural
  // category the language has and the translation does not cover.
  const problems: string[] = [];
  for (const [locale, catalog] of catalogs) {
    for (const [id, text] of Object.entries(catalog)) {
      const values: Record<string, string | number> = {};
      for (const name of messageArguments(text)) values[name] = /count|number|total/i.test(name) ? 2 : 'x';
      formatMessage(text, {
        locale,
        values,
        id,
        onProblem: (problem) => problems.push(`${locale}:${id} ${problem.code}: ${problem.message}`),
      });
    }
  }
  assert.deepEqual(problems, []);
});

test('the catalogues are seeded from upstream, not invented', () => {
  // Nothing here is machine-translated. Each catalogue names the pinned `.po`
  // blob it came from, and a Git blob id could only have come from that tree.
  assert.equal(manifest.upstream.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  const expected = LOCALES.filter((locale) => locale.upstreamDirectory && locale.id !== REFERENCE_LOCALE);
  assert.equal(manifest.catalogs.length, expected.length);
  for (const entry of manifest.catalogs) {
    assert.match(entry.blob, /^[0-9a-f]{40}$/, `${entry.locale} records a pinned blob`);
    assert.match(entry.upstreamPath, /^localization\/i18n\//);
    assert.equal(Object.keys(catalogs.get(entry.locale) ?? {}).length, entry.translated);
    assert.ok(existsSync(resolve(l10nRoot, `${entry.locale}.json`)), `${entry.locale} is shipped`);
  }
});

test('coverage is reported honestly, and no language claims to be complete', () => {
  // Recorded rather than asserted upward: the number is what tells the next
  // pass how far there is to go, and a test that demanded 100% here would
  // simply be red for the rest of the project.
  const total = Object.keys(REFERENCE_MESSAGES).length;
  const best = Math.max(...manifest.catalogs.map((entry) => entry.translated));
  assert.ok(best > 0, 'the upstream seed produced something');
  assert.ok(best < total, 'no catalogue is complete, and the plan says so');
  return `${best}/${total} in the fullest language`;
});

test('a switched language renders its translations and falls back for the rest', () => {
  const german = catalogs.get('de');
  assert.ok(german, 'German is shipped');
  const l10n = new Localizer({ reference: REFERENCE_MESSAGES });
  l10n.setCatalog('de', german);
  const [id, translation] = Object.entries(german)[0];
  assert.equal(l10n.t(id, REFERENCE_MESSAGES[id]), translation);
  const untranslated = Object.keys(REFERENCE_MESSAGES).find((key) => !(key in german));
  assert.ok(untranslated);
  assert.equal(l10n.t(untranslated, REFERENCE_MESSAGES[untranslated]), REFERENCE_MESSAGES[untranslated]);
});

test('the whole catalogue survives pseudo-localization in both pseudo-locales', () => {
  // This is the run that finds a clipped control, so it has to cover every
  // message rather than the handful a fixture happens to exercise.
  for (const locale of [PSEUDO_LONG_LOCALE, PSEUDO_RTL_LOCALE]) {
    const catalog = pseudoCatalog(REFERENCE_MESSAGES, locale);
    assert.equal(Object.keys(catalog).length, Object.keys(REFERENCE_MESSAGES).length);
    for (const [id, text] of Object.entries(catalog)) {
      assert.ok(isValidMessage(text), `${locale}:${id} stopped parsing`);
      assert.deepEqual(
        messageArguments(text),
        messageArguments(REFERENCE_MESSAGES[id]),
        `${locale}:${id} lost an argument`,
      );
      assert.equal(unpseudo(text).replace(/\s+/g, ' ').trim(), REFERENCE_MESSAGES[id].replace(/\s+/g, ' ').trim());
    }
  }
});

test('the expanded pseudo-locale is materially longer, which is the point of it', () => {
  const long = pseudoCatalog(REFERENCE_MESSAGES, PSEUDO_LONG_LOCALE);
  const source = Object.values(REFERENCE_MESSAGES).join('').length;
  const expanded = Object.values(long).join('').length;
  assert.ok(expanded > source * 1.25, `expanded ${expanded} vs source ${source}`);
});

test('the whole action catalog renders localized without a single render site changing', () => {
  // The seam is the registry, not the shells: every surface already reads text
  // through `all()` and `get()`, so one change localizes DOM, XR, the palette,
  // and context menus together. A menu that translated while a tooltip did not
  // looks like a broken translation rather than an absent one.
  const registry = buildRegistry();
  const german = catalogs.get('de');
  assert.ok(german);
  const l10n = new Localizer({ reference: REFERENCE_MESSAGES });
  l10n.setCatalog('de', german);
  registry.useTextSource(l10n);

  const translatedId = Object.keys(german)
    .find((id) => id.endsWith('.label'))
    ?.slice('action.'.length, -'.label'.length);
  assert.ok(translatedId, 'at least one action label is translated');
  const action = registry.get(translatedId);
  assert.ok(action);
  assert.equal(action.label, german[`action.${translatedId}.label`]);

  // And the English catalog is still reachable, so a test or a log line can
  // name an action in the language the code was written in.
  assert.notEqual(
    registry.allSource().find((entry) => entry.id === translatedId)?.label,
    action.label,
    'the declared text is unchanged',
  );
});

test('with no text source the registry hands back its declared objects, unchanged', () => {
  // Every headless test builds this registry. Localization must cost them
  // nothing — not an allocation, not a changed identity.
  const registry = buildRegistry();
  const before = registry.all();
  assert.equal(registry.all(), before);
  registry.useTextSource(undefined);
  assert.equal(registry.all(), before);
});

test('English resolves to the declared text, so identity survives the reference language', () => {
  const registry = buildRegistry();
  const l10n = new Localizer({ reference: REFERENCE_MESSAGES });
  const declared = registry.allSource();
  registry.useTextSource(l10n);
  const localized = registry.all();
  for (let index = 0; index < declared.length; index += 1) {
    assert.equal(localized[index], declared[index], `${declared[index].id} was copied for no reason`);
  }
});

console.log(`\nMessage catalogues: ${passed} tests passed (${catalogs.size} languages).`);
