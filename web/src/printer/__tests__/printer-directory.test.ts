import assert from 'node:assert/strict';

import type { KeyValueStorage } from '../../settings/Preferences';
import {
  EMPTY_PRINTER_DIRECTORY,
  PrinterDirectoryError,
  addPrinter,
  adoptLegacyEndpoint,
  defaultPrinter,
  describeDiscovery,
  loadPrinterDirectory,
  removePrinter,
  savePrinterDirectory,
  setDefaultPrinter,
  updatePrinter,
  type PrinterDirectory,
} from '../PrinterDirectory';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function storage(initial: Record<string, string> = {}): KeyValueStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

function ids(): () => string {
  let next = 0;
  return () => `printer-${++next}`;
}

/** The two machines the acceptance criterion names. */
function workshop(): PrinterDirectory {
  const makeId = ids();
  let directory = addPrinter(EMPTY_PRINTER_DIRECTORY, { name: 'Snapmaker U1', host: 'http://192.168.1.228' }, makeId);
  directory = addPrinter(directory, { name: 'Elegoo Centauri Carbon', host: 'http://192.168.1.51' }, makeId);
  return directory;
}

test('two printers can be added from a clean profile', () => {
  const directory = workshop();
  assert.deepEqual(
    directory.printers.map((entry) => entry.name),
    ['Snapmaker U1', 'Elegoo Centauri Carbon'],
  );
  assert.equal(directory.printers[0].port, 7125, 'Moonraker default');
  // The first printer added becomes the default, so a single-printer install
  // never has to choose one before it can send anything.
  assert.equal(defaultPrinter(directory)?.name, 'Snapmaker U1');
});

test('a printer survives a reload with its own capabilities', () => {
  const store = storage();
  let directory = workshop();
  directory = updatePrinter(directory, directory.printers[0].id, { capabilities: ['print', 'pause'], toolCount: 4 });
  directory = updatePrinter(directory, directory.printers[1].id, { toolCount: 1 });
  savePrinterDirectory(directory, store);

  const reloaded = loadPrinterDirectory(store);
  assert.equal(reloaded.printers.length, 2);
  // Capability and tool count belong to the machine that reported them; a
  // four-tool map leaking onto a one-tool printer is how a job goes wrong.
  assert.deepEqual(reloaded.printers[0].capabilities, ['print', 'pause']);
  assert.equal(reloaded.printers[0].toolCount, 4);
  assert.equal(reloaded.printers[1].capabilities, undefined);
  assert.equal(reloaded.printers[1].toolCount, 1);
  assert.equal(reloaded.defaultId, directory.defaultId);
});

test('switching the default never carries the previous printer’s state', () => {
  let directory = workshop();
  directory = updatePrinter(directory, directory.printers[0].id, { toolCount: 4, capabilities: ['ams'] });
  directory = setDefaultPrinter(directory, directory.printers[1].id);

  const active = defaultPrinter(directory);
  assert.equal(active?.name, 'Elegoo Centauri Carbon');
  assert.equal(active?.toolCount, undefined, 'the other printer’s tool count does not follow the switch');
  assert.equal(active?.capabilities, undefined);
});

test('the same address cannot be saved twice under different names', () => {
  const directory = workshop();
  assert.throws(
    () => addPrinter(directory, { name: 'U1 again', host: 'http://192.168.1.228' }, ids()),
    (error: unknown) => error instanceof PrinterDirectoryError && error.code === 'duplicate',
  );
  // Editing into a collision is refused for the same reason.
  assert.throws(
    () => updatePrinter(directory, directory.printers[1].id, { host: 'http://192.168.1.228' }),
    (error: unknown) => error instanceof PrinterDirectoryError && error.code === 'duplicate',
  );
});

test('removing the default promotes another rather than dangling', () => {
  let directory = workshop();
  const removedId = directory.defaultId;
  directory = removePrinter(directory, removedId);
  assert.equal(directory.printers.length, 1);
  // A default pointing at a deleted printer would resolve to nothing at send
  // time, which is the worst moment to discover it.
  assert.equal(defaultPrinter(directory)?.name, 'Elegoo Centauri Carbon');

  directory = removePrinter(directory, directory.defaultId);
  assert.equal(directory.defaultId, '');
  assert.equal(defaultPrinter(directory), undefined);
});

test('a stored default naming a missing printer is repaired on load', () => {
  const store = storage({
    'orcaxr.printers': JSON.stringify({
      printers: [{ id: 'a', name: 'Real', host: 'http://10.0.0.5', port: 7125 }],
      defaultId: 'gone',
    }),
  });
  assert.equal(loadPrinterDirectory(store).defaultId, 'a');
});

test('an existing single endpoint becomes the first named printer', () => {
  const adopted = adoptLegacyEndpoint(EMPTY_PRINTER_DIRECTORY, { host: 'http://192.168.1.228', port: 7125 }, ids());
  assert.equal(adopted.printers.length, 1);
  assert.equal(adopted.printers[0].name, 'My printer');
  assert.equal(adopted.defaultId, adopted.printers[0].id);

  // Adoption never runs over a directory the operator has already built.
  const existing = workshop();
  assert.equal(adoptLegacyEndpoint(existing, { host: 'http://10.0.0.9', port: 7125 }, ids()), existing);
  assert.equal(adoptLegacyEndpoint(EMPTY_PRINTER_DIRECTORY, undefined, ids()).printers.length, 0);
});

test('unusable input is refused before anything is stored', () => {
  for (const bad of [
    { name: '   ', host: 'http://x' },
    { name: 'ok', host: '  ' },
  ]) {
    assert.throws(() => addPrinter(EMPTY_PRINTER_DIRECTORY, bad, ids()), PrinterDirectoryError);
  }
  assert.throws(
    () => addPrinter(EMPTY_PRINTER_DIRECTORY, { name: 'ok', host: 'http://x', port: 0 }, ids()),
    (error: unknown) => error instanceof PrinterDirectoryError && error.code === 'invalid-endpoint',
  );
  assert.throws(
    () => removePrinter(EMPTY_PRINTER_DIRECTORY, 'nope'),
    (error: unknown) => error instanceof PrinterDirectoryError && error.code === 'not-found',
  );
});

test('a corrupt store yields an empty directory, never junk entries', () => {
  for (const raw of ['not json', 'null', '[]', '{"printers":"no"}', '{"printers":[{"name":"nameless"}]}']) {
    const loaded = loadPrinterDirectory(storage({ 'orcaxr.printers': raw }));
    assert.deepEqual(loaded.printers, [], `"${raw}" must not produce a half-read printer`);
  }
  assert.deepEqual(loadPrinterDirectory(null), EMPTY_PRINTER_DIRECTORY);
});

test('discovery is reported as unavailable with real alternatives', () => {
  const outcome = describeDiscovery();
  assert.equal(outcome.available, false);
  // An empty scan result reads as "you have no printers", which is a worse
  // answer than saying the browser cannot do this.
  assert.match(outcome.reason, /cannot scan/);
  assert.ok(outcome.alternatives.length >= 2);
  assert.match(outcome.alternatives.join(' '), /7125/);
  assert.match(outcome.alternatives.join(' '), /proxy/);
});

console.log(`\nPrinter directory: ${passed} tests passed.`);
