/**
 * Printer storage boundary (P9.5).
 *
 * The cases that matter are the ones where a plausible answer is wrong: a file
 * the printer has never scanned (no time, no thumbnail — not a zero), a
 * thumbnail path that is relative to the file's own folder rather than the
 * root, and any operation that could act on a file other than the one named.
 */
import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  PrinterStorageError,
  assertStorageName,
  deletePrinterFile,
  downloadPrinterFile,
  formatStorageSize,
  listPrinterDirectory,
  movePrinterFile,
  parentStorageDirectory,
  readPrinterFileMetadata,
  renamedStoragePath,
  startStoredPrint,
  storageDirectoryOf,
} from '../PrinterStorage';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeTransport {
  readonly calls: { path: string; method?: string }[] = [];
  constructor(
    private readonly replies: Record<string, unknown> = {},
    private readonly failure?: Error,
  ) {}
  async request<T>(path: string, options: { method?: string } = {}): Promise<T> {
    this.calls.push({ path, ...(options.method ? { method: options.method } : {}) });
    if (this.failure) throw this.failure;
    const key = Object.keys(this.replies).find((candidate) => path.startsWith(candidate));
    return (key ? this.replies[key] : {}) as T;
  }
  async download(path: string): Promise<Uint8Array> {
    this.calls.push({ path });
    if (this.failure) throw this.failure;
    return new Uint8Array([1, 2, 3]);
  }
}

await test('lists folders before files and the newest file first', async () => {
  const transport = new FakeTransport({
    '/server/files/directory': {
      dirs: [{ dirname: 'archive', modified: 1_700_000_000, size: 4096 }, { dirname: 'alpha' }, { dirname: '..' }],
      files: [
        { filename: 'older.gcode', modified: 1_700_000_000, size: 1024 },
        { filename: 'newest.gcode', modified: 1_800_000_000, size: 2048 },
        { filename: 'undated.gcode' },
      ],
      disk_usage: { free: 900, total: 1000 },
    },
  });
  const listing = await listPrinterDirectory(transport, 'projects');
  assert.equal(listing.path, 'projects');
  assert.deepEqual(
    listing.directories.map((entry) => entry.path),
    ['projects/alpha', 'projects/archive'],
  );
  assert.deepEqual(
    listing.files.map((entry) => entry.name),
    ['newest.gcode', 'older.gcode', 'undated.gcode'],
  );
  assert.equal(listing.files[0].path, 'projects/newest.gcode');
  // Moonraker reports seconds; a millisecond field that carried seconds would
  // date every file to 1970.
  assert.equal(listing.files[0].modifiedMs, 1_800_000_000_000);
  assert.equal(listing.freeBytes, 900);
  assert.match(transport.calls[0].path, /path=gcodes%2Fprojects&extended=true/);
});

await test('reads metadata without inventing the facts the printer never scanned', async () => {
  const transport = new FakeTransport({
    '/server/files/metadata': {
      size: 5_000_000,
      modified: 1_800_000_000,
      slicer: 'OrcaSlicer',
      estimated_time: 3600,
      filament_weight_total: 42.5,
      thumbnails: [
        { width: 32, height: 32, size: 900, relative_path: '.thumbs/small.png' },
        { width: 300, height: 300, size: 9000, relative_path: '.thumbs/large.png' },
        { width: 64, relative_path: '.thumbs/broken.png' },
      ],
    },
  });
  const metadata = await readPrinterFileMetadata(transport, 'projects/cube.gcode');
  assert.equal(metadata.estimatedSeconds, 3600);
  assert.equal(metadata.filamentWeightG, 42.5);
  assert.equal(metadata.slicerVersion, undefined, 'an unreported version must stay absent');
  assert.equal(metadata.layerHeightMm, undefined);
  // Relative to the file's own folder, largest first, and an entry missing a
  // dimension is dropped rather than guessed at.
  assert.deepEqual(
    metadata.thumbnails.map((entry) => entry.path),
    ['projects/.thumbs/large.png', 'projects/.thumbs/small.png'],
  );
});

await test('an unscanned file reports nothing at all rather than zeroes', async () => {
  const metadata = await readPrinterFileMetadata(new FakeTransport({ '/server/files/metadata': {} }), 'raw.gcode');
  assert.deepEqual(metadata, {
    path: 'raw.gcode',
    thumbnails: [],
  });
});

await test('refuses any target that could act on another file', async () => {
  const transport = new FakeTransport();
  for (const bad of ['', '   ', '../secrets.gcode', 'projects/../../etc/passwd']) {
    await assert.rejects(
      () => deletePrinterFile(transport, bad),
      (error: unknown) => error instanceof PrinterStorageError && error.code === 'invalid-target',
    );
  }
  assert.equal(transport.calls.length, 0, 'a refused target must never reach the printer');
  assert.throws(() => assertStorageName('a/b.gcode'), /folder separator/);
  assert.throws(() => assertStorageName('  '), /empty/);
  await assert.rejects(
    () => movePrinterFile(transport, 'a.gcode', 'a.gcode'),
    (error: unknown) => error instanceof PrinterStorageError && error.code === 'invalid-target',
  );
});

await test('deletes, moves, downloads, and starts exactly the named path', async () => {
  const transport = new FakeTransport();
  await deletePrinterFile(transport, 'projects/my file.gcode');
  await movePrinterFile(transport, 'projects/my file.gcode', 'archive/my file.gcode');
  await downloadPrinterFile(transport, 'projects/my file.gcode');
  await startStoredPrint(transport, 'projects/my file.gcode');
  assert.deepEqual(transport.calls, [
    { path: '/server/files/gcodes/projects/my%20file.gcode', method: 'DELETE' },
    {
      path: '/server/files/move?source=gcodes%2Fprojects%2Fmy%20file.gcode&dest=gcodes%2Farchive%2Fmy%20file.gcode',
      method: 'POST',
    },
    { path: '/server/files/gcodes/projects/my%20file.gcode' },
    { path: '/printer/print/start?filename=projects%2Fmy%20file.gcode', method: 'POST' },
  ]);
});

await test('a rename keeps the file in its own folder', () => {
  assert.equal(renamedStoragePath('projects/cube.gcode', 'tower.gcode'), 'projects/tower.gcode');
  assert.equal(renamedStoragePath('cube.gcode', 'tower.gcode'), 'tower.gcode');
  assert.throws(() => renamedStoragePath('projects/cube.gcode', 'sub/tower.gcode'), /folder separator/);
  assert.equal(storageDirectoryOf('a/b/c.gcode'), 'a/b');
  assert.equal(parentStorageDirectory('a/b'), 'a');
  assert.equal(parentStorageDirectory(''), undefined);
});

await test('names the operation that failed and separates cancellation from failure', async () => {
  const failing = new FakeTransport({}, new MoonrakerTransportError('http_error', 'delete_file'));
  await assert.rejects(
    () => deletePrinterFile(failing, 'gone.gcode'),
    (error: unknown) =>
      error instanceof PrinterStorageError &&
      error.code === 'delete-failed' &&
      /Deleting gone\.gcode/.test(error.message),
  );
  const cancelled = new FakeTransport({}, new MoonrakerTransportError('cancelled', 'start_stored_print'));
  await assert.rejects(
    () => startStoredPrint(cancelled, 'cube.gcode'),
    (error: unknown) => error instanceof PrinterStorageError && error.code === 'cancelled',
  );
  const unreadable = new FakeTransport({ '/server/files/directory': ['not', 'a', 'record'] });
  await assert.rejects(
    () => listPrinterDirectory(unreadable),
    (error: unknown) => error instanceof PrinterStorageError && error.code === 'listing-failed',
  );
});

await test('sizes read as sizes, and a size nobody reported stays unreported', () => {
  assert.equal(formatStorageSize(0), '0 B');
  assert.equal(formatStorageSize(1023), '1023 B');
  assert.equal(formatStorageSize(1536), '1.5 KB');
  assert.equal(formatStorageSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatStorageSize(150 * 1024 * 1024), '150 MB');
  assert.equal(formatStorageSize(undefined), undefined);
  assert.equal(formatStorageSize(Number.NaN), undefined);
});

console.log(`\nPrinter storage: ${passed} tests passed.`);
