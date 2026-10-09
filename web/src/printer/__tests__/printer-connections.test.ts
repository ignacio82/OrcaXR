import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_PRINTER_ASSET } from '../../../../core/browser/printer/asset';
import { MoonrakerTransport } from '../MoonrakerTransport';
import { PrinterConnections, printerTransportChoice } from '../PrinterConnections';
import { SharedMoonrakerTransport } from '../SharedMoonrakerTransport';
import { loadPrinterCore, type SharedPrinterRuntime } from '../SharedPrinterCore';
import { PrinterSessionController } from '../PrinterSessionController';
import { PrinterSessionSwitch } from '../PrinterSessionSwitch';
import { SharedPrinterSession } from '../SharedPrinterSession';
import { PrintWorkflowController } from '../PrintWorkflowController';
import { PrintWorkflowSwitch } from '../PrintWorkflowSwitch';
import { SharedPrintWorkflow } from '../SharedPrintWorkflow';

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
const runtime = await loadPrinterCore(base, serve());
const shared = runtime.connection(config);
assert.ok(shared instanceof SharedMoonrakerTransport);
assert.equal(shared.state.status, 'disconnected');
assert.equal(shared.endpoint.webSocketUrl, 'ws://printer.local:7125/websocket');
shared.dispose();

// Connections run on the shared core once it has loaded, once.
{
  let loads = 0;
  const connections = new PrinterConnections('shared', async () => {
    loads += 1;
    return runtime;
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
    async (): Promise<SharedPrinterRuntime> => {
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
    return runtime;
  });
  await connections.prepare();
  assert.equal(loads, 0);
  assert.ok(connections.create(config) instanceof MoonrakerTransport);
}

// What waits for the core runs once it has loaded — never for the rollback.
{
  const ran: string[] = [];
  const connections = new PrinterConnections('shared', async () => runtime);
  connections.whenReady(() => ran.push('early'));
  await connections.prepare();
  connections.whenReady(() => ran.push('late'));
  assert.deepEqual(ran, ['early', 'late']);
  const rollback = new PrinterConnections('typescript', async () => runtime);
  rollback.whenReady(() => ran.push('rollback'));
  await rollback.prepare();
  assert.deepEqual(ran, ['early', 'late']);
}

// The session adopts the shared core while nothing is selected; a session in
// use keeps its implementation until it is cleared, then moves.
{
  const open = () => new MoonrakerTransport(config);
  const idle = new PrinterSessionSwitch(new PrinterSessionController(open));
  let emitted = 0;
  idle.subscribe(() => emitted++);
  assert.equal(idle.adopt(runtime.session(open)), true);
  assert.ok(idle.implementation instanceof SharedPrinterSession);
  assert.ok(emitted > 0, 'listeners hear the change of implementation');
  const selected = idle.select({ id: 'p', endpoint: 'printer.local', port: 7125 });
  assert.ok(selected instanceof MoonrakerTransport);
  assert.equal(idle.transport, selected);
  idle.dispose();

  const busy = new PrinterSessionSwitch(new PrinterSessionController(open));
  busy.select({ id: 'p', endpoint: 'printer.local', port: 7125 });
  assert.equal(busy.adopt(runtime.session(open)), false, 'a session in use is not replaced');
  assert.ok(busy.implementation instanceof PrinterSessionController);
  busy.clear();
  assert.ok(busy.implementation instanceof SharedPrinterSession, 'it moves once cleared');
  busy.dispose();
}

// The send workflow adopts the shared core while no send runs; a running send
// finishes where it started, and the next send runs on the core.
{
  let release: (() => void) | undefined;
  const dependencies = {
    captureSession: () =>
      new Promise<never>((_resolve, reject) => {
        release = () => reject(new Error('no printer'));
      }),
    confirm: async () => ({ choice: 'cancel' as const }),
  };
  const workflow = new PrintWorkflowSwitch(new PrintWorkflowController(dependencies));
  const intent = {
    filename: 'part.gcode',
    gcode: 'G28\n',
    plateName: 'Plate',
    usage: { tools: [0], multiMaterial: false, declaredColors: [], declaredMaterials: [] },
    artifact: {
      outputHash: `sha256:${'0'.repeat(64)}`,
      sourceRevision: 1,
      sourceHash: 's',
      sourceAssetHash: 'a',
      plateId: 'p',
    },
    isCurrent: () => true,
  };
  const running = workflow.run(intent);
  running.catch(() => undefined);
  assert.equal(workflow.busy, true);
  assert.equal(workflow.adopt(runtime.workflow(dependencies)), false, 'a running send is not replaced');
  assert.ok(workflow.implementation instanceof PrintWorkflowController);
  release?.();
  await assert.rejects(running);
  const next = workflow.run(intent);
  next.catch(() => undefined);
  assert.ok(workflow.implementation instanceof SharedPrintWorkflow, 'the next send runs on the core');
  await new Promise((resolve) => setTimeout(resolve, 0));
  release?.();
  await assert.rejects(next);
  workflow.dispose();
}

console.log('Printer connections run on the verified shared core, with the browser transport as rollback.');
