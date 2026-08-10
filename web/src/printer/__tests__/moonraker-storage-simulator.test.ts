/**
 * Printer storage against a real Moonraker stand-in (P9.5).
 *
 * The unit suite fakes the transport; this one drives `MoonrakerTransport` over
 * real HTTP against the same simulator the browser E2E uses. That is what
 * proves the parts a fake cannot: DELETE actually reaching the file manager, a
 * thumbnail arriving as bytes rather than JSON, a move that leaves the source
 * gone and the destination present, and a stored file starting a print.
 */
import assert from 'node:assert/strict';

import { startMoonrakerSimulator, type MoonrakerSimulator } from '../../../scripts/moonraker-simulator.mjs';
import {
  MoonrakerTransport,
  PrinterStorageError,
  deletePrinterFile,
  downloadPrinterFile,
  listPrinterDirectory,
  movePrinterFile,
  readPrinterFileMetadata,
  renamedStoragePath,
  startStoredPrint,
  type MoonrakerScheduler,
  type MoonrakerSocket,
} from '..';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class ImmediateSocket implements MoonrakerSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

const realScheduler: MoonrakerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const THUMBNAIL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function withPrinter<T>(
  run: (context: { transport: MoonrakerTransport; sim: MoonrakerSimulator }) => Promise<T>,
): Promise<T> {
  const sim = await startMoonrakerSimulator();
  sim.putFile(
    'projects/tower.gcode',
    Buffer.from('G1 X1\n'),
    {
      estimated_time: 4500,
      filament_weight_total: 18.25,
      slicer: 'OrcaSlicer',
      layer_height: 0.2,
      thumbnails: [{ width: 300, height: 300, size: THUMBNAIL_BYTES.length, relative_path: '.thumbs/tower.png' }],
    },
    1_800_000_000,
  );
  sim.putFile('projects/.thumbs/tower.png', THUMBNAIL_BYTES);
  // A file the printer has never scanned: it has bytes and nothing else.
  sim.putFile('unscanned.gcode', Buffer.from('G1 X2\n'), {}, 1_700_000_000);

  const transport = new MoonrakerTransport(
    { endpoint: sim.url, clientName: 'OrcaXR Web', clientVersion: 'test' },
    { socketFactory: (url) => new ImmediateSocket(url), scheduler: realScheduler, heartbeatIntervalMs: 60_000 },
  );
  transport.setSessionCredentials({ apiKey: 'simulator-key' });
  try {
    await transport.connect();
    return await run({ transport, sim });
  } finally {
    transport.dispose();
    await sim.close();
  }
}

await test('browses the root and its folders as the printer holds them', async () => {
  await withPrinter(async ({ transport }) => {
    const root = await listPrinterDirectory(transport);
    assert.deepEqual(
      root.directories.map((entry) => entry.name),
      ['projects'],
    );
    assert.deepEqual(
      root.files.map((entry) => entry.name),
      ['unscanned.gcode'],
    );
    assert.ok((root.freeBytes ?? 0) > 0, 'the printer reported free space');

    const projects = await listPrinterDirectory(transport, 'projects');
    assert.deepEqual(
      projects.files.map((entry) => entry.path),
      ['projects/tower.gcode'],
    );
    assert.equal(projects.files[0].modifiedMs, 1_800_000_000_000);
  });
});

await test('reads a scanned file fully and an unscanned one honestly', async () => {
  await withPrinter(async ({ transport }) => {
    const scanned = await readPrinterFileMetadata(transport, 'projects/tower.gcode');
    assert.equal(scanned.estimatedSeconds, 4500);
    assert.equal(scanned.filamentWeightG, 18.25);
    assert.equal(scanned.layerHeightMm, 0.2);
    assert.deepEqual(
      scanned.thumbnails.map((entry) => entry.path),
      ['projects/.thumbs/tower.png'],
    );

    const unscanned = await readPrinterFileMetadata(transport, 'unscanned.gcode');
    assert.equal(unscanned.estimatedSeconds, undefined);
    assert.equal(unscanned.filamentWeightG, undefined);
    assert.deepEqual(unscanned.thumbnails, []);
  });
});

await test('fetches a thumbnail as bytes with the session credential attached', async () => {
  await withPrinter(async ({ transport }) => {
    const bytes = await downloadPrinterFile(transport, 'projects/.thumbs/tower.png');
    assert.deepEqual([...bytes], [...THUMBNAIL_BYTES], 'the image arrives intact, not JSON-parsed');
    const gcode = await downloadPrinterFile(transport, 'projects/tower.gcode');
    assert.equal(new TextDecoder().decode(gcode), 'G1 X1\n');
  });
});

await test('renames in place, leaving nothing behind at the old path', async () => {
  await withPrinter(async ({ transport, sim }) => {
    const next = await movePrinterFile(
      transport,
      'projects/tower.gcode',
      renamedStoragePath('projects/tower.gcode', 'tower-v2.gcode'),
    );
    assert.equal(next, 'projects/tower-v2.gcode');
    assert.equal(sim.stored.has('projects/tower.gcode'), false);
    assert.equal(sim.stored.get('projects/tower-v2.gcode')?.toString(), 'G1 X1\n');
    // The metadata followed the file, so the renamed entry is still described.
    const metadata = await readPrinterFileMetadata(transport, 'projects/tower-v2.gcode');
    assert.equal(metadata.estimatedSeconds, 4500);
  });
});

await test('starts a stored file without uploading anything', async () => {
  await withPrinter(async ({ transport, sim }) => {
    const started = await startStoredPrint(transport, 'projects/tower.gcode');
    assert.equal(started, 'projects/tower.gcode');
    assert.equal(sim.started, 'projects/tower.gcode');
    assert.deepEqual(sim.commands, ['start']);
    assert.equal(sim.stored.size, 3, 'nothing was added to the printer');
  });
});

await test('deletes exactly one file and reports a target the printer does not have', async () => {
  await withPrinter(async ({ transport, sim }) => {
    await deletePrinterFile(transport, 'projects/tower.gcode');
    assert.equal(sim.stored.has('projects/tower.gcode'), false);
    assert.equal(sim.stored.has('projects/.thumbs/tower.png'), true, 'a sibling was untouched');
    assert.ok(sim.commands.includes('delete:projects/tower.gcode'));

    await assert.rejects(
      () => deletePrinterFile(transport, 'projects/tower.gcode'),
      (error: unknown) => error instanceof PrinterStorageError && error.code === 'delete-failed',
    );
  });
});

console.log(`\nMoonraker storage simulator: ${passed} tests passed.`);
