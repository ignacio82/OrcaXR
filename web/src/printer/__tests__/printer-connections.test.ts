import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_PRINTER_ASSET } from '../../../../core/browser/printer/asset';
import { MoonrakerTransport } from '../MoonrakerTransport';
import { PrinterConnections, printerTransportChoice } from '../PrinterConnections';
import { SharedMoonrakerTransport } from '../SharedMoonrakerTransport';
import { loadPrinterCore, type SharedConnectionFactory } from '../SharedPrinterCore';

const config = { endpoint: 'printer.local', clientVersion: 'test' };

// The shared core is the default; the browser transport is the rollback,
// asked for by the query (which wins) or the stored preference.
assert.equal(printerTransportChoice('', null), 'shared');
assert.equal(printerTransportChoice('?printer-transport=typescript', null), 'typescript');
assert.equal(printerTransportChoice('', 'typescript'), 'typescript');
assert.equal(printerTransportChoice('?printer-transport=shared', 'typescript'), 'shared');
assert.equal(printerTransportChoice('?printer-transport=other', null), 'shared');

// The packaged printer core loads through the verified loader, with the bytes
// a service worker or the server would hand it.
const public_ = (path: string) => readFileSync(new URL(`../../../public/${path}`, import.meta.url));
const serve = (tamper = false) =>
  (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const asset = [CORE_PRINTER_ASSET.manifest, CORE_PRINTER_ASSET.wasm].find((a) => url.pathname === `/app/${a.path}`);
    if (!asset) return new Response(null, { status: 404 });
    const bytes = new Uint8Array(public_(asset.path));
    if (tamper && asset === CORE_PRINTER_ASSET.wasm) bytes[bytes.length - 1] ^= 1;
    return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  }) as typeof fetch;
const base = new URL('https://orcaxr.example/app/');
await assert.rejects(
  loadPrinterCore(base, serve(true)),
  /The shared printer component does not match this application/,
  'tampered bytes never run',
);
const factory = await loadPrinterCore(base, serve());
const shared = factory(config);
assert.ok(shared instanceof SharedMoonrakerTransport);
assert.equal(shared.state.status, 'disconnected');
assert.equal(shared.endpoint.webSocketUrl, 'ws://printer.local:7125/websocket');
shared.dispose();

// Connections run on the shared core once it has loaded, once.
{
  let loads = 0;
  const connections = new PrinterConnections('shared', async () => {
    loads += 1;
    return factory;
  });
  assert.equal(connections.implementation, 'typescript', 'nothing has loaded yet');
  await Promise.all([connections.prepare(), connections.prepare()]);
  assert.equal(loads, 1);
  assert.equal(connections.implementation, 'shared');
  assert.ok(connections.create(config) instanceof SharedMoonrakerTransport);
}

// A core that cannot load leaves printing to the browser transport, and says so.
{
  const warnings: unknown[] = [];
  const failure = new Error('offline and never cached');
  const connections = new PrinterConnections(
    'shared',
    async (): Promise<SharedConnectionFactory> => {
      throw failure;
    },
    (_message, error) => warnings.push(error),
  );
  await connections.prepare();
  assert.deepEqual(warnings, [failure]);
  assert.equal(connections.loadFailure, failure);
  assert.ok(connections.create(config) instanceof MoonrakerTransport);
}

// The rollback never loads the core.
{
  let loads = 0;
  const connections = new PrinterConnections('typescript', async () => {
    loads += 1;
    return factory;
  });
  await connections.prepare();
  assert.equal(loads, 0);
  assert.ok(connections.create(config) instanceof MoonrakerTransport);
}

console.log('Printer connections run on the verified shared core, with the browser transport as rollback.');
