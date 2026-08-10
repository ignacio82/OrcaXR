import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HELP_ALLOWED_ORIGINS,
  HELP_TOPICS,
  TROUBLESHOOTING,
  helpLinks,
  searchHelp,
  troubleshootingFor,
} from '../HelpCatalog';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * The codes preflight can actually emit, read from the source rather than
 * copied. A hand-maintained list would drift the moment a check is added,
 * which is the exact failure this test exists to prevent.
 */
function preflightCodes(): readonly string[] {
  const source = readFileSync('src/project/slicing/preflight.ts', 'utf8');
  const codes = new Set<string>();
  for (const match of source.matchAll(/code: '([a-z0-9-]+)'/g)) codes.add(match[1]);
  return [...codes].sort();
}

test('every preflight issue has troubleshooting, not a generic sentence', () => {
  const codes = preflightCodes();
  assert.ok(codes.length >= 25, `expected the real code set, found ${codes.length}`);

  const missing = codes.filter((code) => troubleshootingFor(code) === undefined);
  assert.deepEqual(
    missing,
    [],
    `these preflight codes have no help; add one to HelpCatalog rather than leaving the generic string: ${missing.join(', ')}`,
  );
});

test('no troubleshooting entry describes an error that cannot happen', () => {
  const codes = new Set(preflightCodes());
  const orphans = TROUBLESHOOTING.filter((topic) => !codes.has(topic.code)).map((topic) => topic.code);
  // A stale entry is its own kind of lie: help for an error the app no longer
  // raises sends someone looking for a control that is not there.
  assert.deepEqual(orphans, [], `troubleshooting exists for codes preflight never emits: ${orphans.join(', ')}`);
});

test('each troubleshooting entry says what happened and what to do', () => {
  for (const topic of TROUBLESHOOTING) {
    assert.ok(topic.title.length > 8, `${topic.code} needs a real title`);
    assert.ok(topic.what.length > 40, `${topic.code} must explain what the check saw`);
    assert.ok(topic.fix.length > 40, `${topic.code} must name a concrete fix`);
    // "Resolve this issue before slicing" is what this replaced.
    assert.equal(/^resolve this issue/i.test(topic.fix), false, `${topic.code} fell back to the generic wording`);
  }
});

test('topics cover every area the plan names', () => {
  const ids = new Set(HELP_TOPICS.map((topic) => topic.id));
  for (const required of [
    'onboarding',
    'shortcuts',
    'fullspectrum',
    'painting',
    'profiles',
    'preview',
    'moonraker',
    'offline-xr',
    'privacy',
    'diagnostics',
    'limitations',
  ]) {
    assert.ok(ids.has(required), `missing help topic: ${required}`);
  }
  for (const topic of HELP_TOPICS) {
    assert.ok(topic.body.length > 80, `${topic.id} needs a body worth reading`);
    assert.ok(topic.keywords.length >= 3, `${topic.id} needs keywords so search can find it`);
  }
});

test('every help link is well-formed and points somewhere we maintain', () => {
  for (const link of helpLinks()) {
    let url: URL;
    assert.doesNotThrow(() => {
      url = new URL(link);
    }, `${link} is not a URL`);
    url = new URL(link);
    assert.equal(url.protocol, 'https:', `${link} must be https`);
    assert.ok(
      HELP_ALLOWED_ORIGINS.some((origin) => link.startsWith(origin)),
      `${link} points outside the maintained set; add the origin deliberately or use a different source`,
    );
  }
});

test('search finds a concept, an error, and an action from one query', () => {
  const actions = [
    { id: 'auto_place_wipe', label: 'Auto-place Wipe Tower', hint: 'Place the wipe tower automatically' },
  ];

  const hits = searchHelp('wipe tower', actions);
  const kinds = new Set(hits.map((hit) => hit.kind));
  // Someone typing "wipe tower" does not know whether their answer is a
  // concept, an error, or a button, so one index serves all three.
  assert.ok(kinds.has('troubleshooting'), 'the wipe-tower errors are findable');
  assert.ok(kinds.has('action'), 'so is the action');

  assert.ok(searchHelp('fullspectrum').some((hit) => hit.id === 'fullspectrum'));
  assert.ok(
    searchHelp('cors').some((hit) => hit.id === 'moonraker'),
    'keywords widen the net beyond the prose',
  );
  assert.ok(searchHelp('token').some((hit) => hit.id === 'privacy'));
});

test('search is case-insensitive and ignores a query too short to mean anything', () => {
  assert.ok(searchHelp('MOONRAKER').length > 0);
  assert.deepEqual(searchHelp('a'), []);
  assert.deepEqual(searchHelp('   '), []);
});

test('help ships with the app rather than being fetched', () => {
  // Offline is a requirement, so a topic that only exists behind a link would
  // be unavailable exactly when someone is troubleshooting a network problem.
  for (const topic of HELP_TOPICS) {
    assert.ok(topic.body.trim().length > 0, `${topic.id} must be readable with no network`);
  }
  for (const topic of TROUBLESHOOTING) {
    assert.ok(topic.fix.trim().length > 0, `${topic.code} must be readable with no network`);
  }
});

console.log(`\nHelp coverage: ${passed} tests passed.`);
