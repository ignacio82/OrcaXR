/**
 * Reading upstream's ZIP64 calibration archives (P8.2).
 *
 * The archive reader refused every one of these outright: "ZIP64 archives
 * exceed the supported browser envelope". The refusal was reasonable and the
 * reasoning behind it was not — these files are 150 KB. They are ZIP64 in
 * *form*, because the writer emits the records unconditionally, not in size.
 * So eight calibration workflows were blocked on geometry the reader was
 * declining to open for a reason that did not apply to it.
 *
 * What matters more than opening them is that opening them widened nothing
 * else. Every bound the reader applied before — entry count, directory extent,
 * path safety, compression method, local/central agreement, total size — is
 * applied to the ZIP64 values exactly as it was to the 32-bit ones. These
 * traces hold both halves: the real archives open, and the guards still bite.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { BbsProjectImportParser } from '../import/BbsProjectImportParser';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PUBLIC = resolve(import.meta.dirname, '../../../public/calibration');

/** Every shipped flow resource, and the pieces its plan expects. */
const ARCHIVES = [
  { file: 'flowrate-test-pass1.3mf', objects: 9 },
  { file: 'flowrate-test-pass2.3mf', objects: 10 },
  { file: 'Orca-LinearFlow.3mf', objects: 11 },
  { file: 'Orca-LinearFlow_fine.3mf', objects: 16 },
];

async function parse(file: string): Promise<{ objects: { name: string }[] }> {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, file)));
  const parsed = await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: file,
  } as never);
  const state = (parsed as { state: { plates: { objects: { name: string }[] }[] } }).state;
  return { objects: state.plates.flatMap((plate) => plate.objects) };
}

await test('every shipped calibration archive opens, with the pieces its plan expects', async () => {
  for (const archive of ARCHIVES) {
    assert.ok(existsSync(resolve(PUBLIC, archive.file)), `${archive.file} is shipped`);
    const { objects } = await parse(archive.file);
    assert.equal(objects.length, archive.objects, `${archive.file} carries ${archive.objects} pieces`);
    assert.ok(
      objects.every((object) => object.name.startsWith('flowrate_')),
      `${archive.file} pieces are named for what they print at`,
    );
  }
});

await test('a truncated ZIP64 archive is refused rather than half-read', async () => {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  // Cutting the tail removes the end-of-central-directory records the reader
  // navigates by. Widening ZIP64 support must not have made that survivable.
  const truncated = bytes.subarray(0, bytes.byteLength - 64);
  await assert.rejects(
    new BbsProjectImportParser().parse({ mode: 'replace', bytes: truncated, fileName: 'cut.3mf' } as never),
  );
});

await test('a corrupted ZIP64 record is refused, not followed', async () => {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  const damaged = bytes.slice();
  // Find the ZIP64 end record and break its signature. A reader that followed
  // it anyway would be taking offsets from arbitrary bytes.
  let marker = -1;
  for (let index = damaged.byteLength - 4; index >= 0; index -= 1) {
    if (
      damaged[index] === 0x50 &&
      damaged[index + 1] === 0x4b &&
      damaged[index + 2] === 0x06 &&
      damaged[index + 3] === 0x06
    ) {
      marker = index;
      break;
    }
  }
  assert.ok(marker >= 0, 'the archive has a ZIP64 end record to damage');
  damaged[marker + 3] = 0x07;
  await assert.rejects(
    new BbsProjectImportParser().parse({ mode: 'replace', bytes: damaged, fileName: 'bad.3mf' } as never),
    /ZIP64|ZIP/,
  );
});

console.log(`\nZIP64 calibration archives: ${passed} tests passed.`);
