import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { readSafeZip, writeDeterministicZip } from '../serialization/deterministicZip';

const files = new Map([
  ['a.txt', new Uint8Array([1, 2, 3])],
  ['\ufeffa.txt', new Uint8Array([4, 5, 6])],
  ['\ufeff\ufeffa.txt', new Uint8Array([7, 8, 9])],
  ['__proto__', new Uint8Array([10])],
]);
const archive = writeDeterministicZip(files);
const restored = readSafeZip(archive);
assert.deepEqual([...restored.keys()].sort(), [...files.keys()].sort());
for (const [name, bytes] of files) assert.deepEqual(restored.get(name), bytes);
archive.fill(0);
for (const [name, bytes] of files) assert.deepEqual(restored.get(name), bytes);
console.log('Deterministic ZIP member names and output ownership: passed.');

const dishonest = writeDeterministicZip(new Map([['payload.txt', new Uint8Array(4096)]]));
const view = new DataView(dishonest.buffer);
const central = view.getUint32(dishonest.length - 22 + 16, true);
// A dishonest size plus the CRC of its first byte used to pass after fflate
// silently truncated expansion to the supplied one-byte output buffer.
view.setUint32(22, 1, true);
view.setUint32(central + 24, 1, true);
view.setUint32(14, 0xd202ef8d, true);
view.setUint32(central + 16, 0xd202ef8d, true);
assert.throws(() => readSafeZip(dishonest), /unexpected size/);
console.log('Deterministic ZIP dishonest expansion is rejected: passed.');

const directory = zipSync({ 'folder/': new Uint8Array([1, 2, 3]) });
directory[30 + 'folder/'.length] = 0xff; // Reserved DEFLATE block type.
assert.throws(() => readSafeZip(directory), /Invalid or corrupt ZIP/);
console.log('Deterministic ZIP validates discarded directory payloads: passed.');
