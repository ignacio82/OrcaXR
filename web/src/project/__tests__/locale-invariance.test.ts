import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Bbs3mfProjectSerializer, compareCanonicalText, projectFingerprint } from '../index';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * P10.4's sharpest clause: locale never changes config serialization.
 *
 * `localeCompare` collates by the runtime's locale — in Swedish 'ä' sorts
 * after 'z', in German it sorts with 'a' — so ordering anything that reaches a
 * saved project by it makes the bytes depend on the machine that produced
 * them. Two operators would then get different files from the same project,
 * and a hash-guarded artifact would disagree with itself across a locale
 * change.
 */

function accentedFixture() {
  const fixture = createProjectFixture();
  const names = ['Ärm', 'Zebra', 'apple', 'Öl', 'Ångström'];
  const objects = fixture.state.plates.flatMap((plate) => plate.objects);
  objects.forEach((object, index) => {
    object.name = names[index % names.length];
    object.volumes.forEach((volume, position) => {
      volume.name = names[(index + position + 1) % names.length];
    });
  });
  fixture.state.filaments.physical.forEach((filament, index) => {
    filament.name = names[(index + 2) % names.length];
  });
  return fixture;
}

async function serializeToBase64(): Promise<string> {
  const fixture = accentedFixture();
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 1,
    sourceHash: projectFingerprint(fixture.state),
  });
  return Buffer.from(archive.bytes).toString('base64');
}

await test('serialized bytes do not change when the runtime collates differently', async () => {
  const base = await serializeToBase64();

  // Emulate a locale that sorts accented letters after 'z'. Stubbing the
  // method is the only reliable way to change collation inside one process.
  const original = String.prototype.localeCompare;
  const swedishLike = function (this: string, other: string): number {
    const rank = (value: string) => value.replace(/[äÄöÖåÅ]/g, (character) => `￿${character}`);
    const left = rank(String(this));
    const right = rank(String(other));
    return left < right ? -1 : left > right ? 1 : 0;
  } as typeof String.prototype.localeCompare;

  try {
    String.prototype.localeCompare = swedishLike;
    const underOtherLocale = await serializeToBase64();
    assert.equal(underOtherLocale, base, 'the same project must produce the same archive on every machine');
  } finally {
    String.prototype.localeCompare = original;
  }
});

await test('the fingerprint is locale-invariant too', async () => {
  const fixture = accentedFixture();
  const base = projectFingerprint(fixture.state);
  const original = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function () {
      // A collation that reverses everything would reorder any sort using it.
      return -1;
    } as typeof String.prototype.localeCompare;
    assert.equal(projectFingerprint(accentedFixture().state), base);
  } finally {
    String.prototype.localeCompare = original;
  }
});

await test('no canonical source orders by the runtime locale', () => {
  // A guard rather than a snapshot: the two tests above only catch a leak the
  // fixture happens to exercise, and the next `localeCompare` someone adds may
  // sort user-supplied names where the difference is real.
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== '__tests__') walk(path);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (readFileSync(path, 'utf8').includes('.localeCompare(')) offenders.push(path);
    }
  };
  walk('src/project');
  assert.deepEqual(
    offenders,
    [],
    `canonical ordering must use compareCanonicalText, not the runtime locale: ${offenders.join(', ')}`,
  );
});

await test('compareCanonicalText orders by code unit, consistently', () => {
  assert.equal(compareCanonicalText('a', 'b'), -1);
  assert.equal(compareCanonicalText('b', 'a'), 1);
  assert.equal(compareCanonicalText('a', 'a'), 0);
  // Uppercase sorts before lowercase by code unit; a locale collator would
  // usually interleave them, which is precisely the difference being avoided.
  assert.equal(compareCanonicalText('Z', 'a'), -1);
  assert.equal(compareCanonicalText('ä', 'z'), 1, 'accented letters sort by code point, not by language');
});

console.log(`\nLocale invariance: ${passed} tests passed.`);
