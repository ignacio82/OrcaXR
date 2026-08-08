import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A local stand-in for a Moonraker printer, good enough to drive the real send
 * path from a real browser: it answers the handshake, reports state and loaded
 * filament slots, stores uploaded files byte-for-byte, and records what was
 * started.
 *
 * CORS matters here rather than being test scaffolding: the page talks to the
 * printer cross-origin with an `x-api-key` header, so every browser send is
 * preceded by a preflight. A printer that does not allow the page's origin can
 * never be sent to, which is exactly what this simulator reproduces when
 * `allowOrigin` is set to false.
 */
export async function startMoonrakerSimulator(options = {}) {
  const state = {
    klippy: options.klippy ?? 'ready',
    printState: options.printState ?? 'standby',
    currentFilename: options.currentFilename ?? '',
    slots: options.slots ?? [],
    reportedSizeDelta: options.reportedSizeDelta ?? 0,
    allowOrigin: options.allowOrigin ?? true,
  };
  const stored = new Map();
  const requests = [];
  const apiKeys = [];
  let started = null;
  for (const name of options.files ?? []) stored.set(name, Buffer.alloc(1));

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const cors = state.allowOrigin
      ? {
          'access-control-allow-origin': request.headers.origin ?? '*',
          'access-control-allow-headers': 'x-api-key, content-type, authorization',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-max-age': '60',
        }
      : {};
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    requests.push(`${request.method} ${url.pathname}`);
    apiKeys.push(request.headers['x-api-key']);
    const json = (payload, bare = false) => {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify(bare ? payload : { result: payload }));
    };

    if (url.pathname === '/server/info') {
      return json({
        api_version: [1, 0, 5],
        moonraker_version: 'v0.9.3-simulator',
        components: ['authorization', 'file_manager', 'history', 'job_queue', 'klippy_apis'],
        klippy_connected: state.klippy === 'ready',
        klippy_state: state.klippy,
        warnings: [],
      });
    }
    if (url.pathname === '/printer/info') {
      return json({ state: state.klippy, hostname: 'orcaxr-simulator', software_version: 'v0.12.0' });
    }
    if (url.pathname === '/printer/objects/query') {
      if (url.searchParams.has('print_task_config')) {
        return json({
          status: {
            print_task_config: {
              filament_color_rgba: state.slots.map((slot) => `${slot.color}FF`),
              filament_type: state.slots.map((slot) => slot.material),
              filament_vendor: state.slots.map((slot) => slot.vendor ?? 'Simulator'),
              filament_exist: state.slots.map(() => 1),
            },
          },
        });
      }
      return json({
        status: {
          webhooks: { state: state.klippy },
          print_stats: { state: state.printState, filename: state.currentFilename },
          virtual_sdcard: { is_active: state.printState === 'printing' },
        },
      });
    }
    if (url.pathname === '/server/files/list') {
      return json([...stored.entries()].map(([path, content]) => ({ path, size: content.length, modified: 0 })));
    }
    if (url.pathname === '/server/files/upload') {
      const parsed = parseSingleFileMultipart(await readBody(request), request.headers['content-type'] ?? '');
      stored.set(parsed.filename, parsed.content);
      // Moonraker answers uploads with an unwrapped object, unlike every other
      // endpoint; the transport must accept it without loosening the rest.
      return json({ item: { path: parsed.filename, root: 'gcodes' }, print_started: false }, true);
    }
    if (url.pathname === '/server/files/metadata') {
      const content = stored.get(url.searchParams.get('filename') ?? '');
      if (!content) {
        response.writeHead(404, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      return json({ filename: url.searchParams.get('filename'), size: content.length + state.reportedSizeDelta });
    }
    if (url.pathname === '/printer/print/start') {
      started = url.searchParams.get('filename');
      state.printState = 'printing';
      state.currentFilename = started;
      return json('ok');
    }
    response.writeHead(404, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unknown path' } }));
  }

  // Moonraker's JSON-RPC socket: the transport opens it during the handshake
  // and pushes identify/subscription frames, so the simulator only has to
  // complete the upgrade and stay open.
  const sockets = new Set();
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createHash('sha1')
          .update(key + WEBSOCKET_GUID)
          .digest('base64')}`,
        '\r\n',
      ].join('\r\n'),
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.resume();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    stored,
    requests,
    apiKeys,
    get started() {
      return started;
    },
    get state() {
      return state;
    },
    setSlots(slots) {
      state.slots = slots;
    },
    setState(patch) {
      Object.assign(state, patch);
    },
    reset() {
      stored.clear();
      requests.length = 0;
      apiKeys.length = 0;
      started = null;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Minimal multipart reader: enough to prove the exact bytes crossed the wire. */
function parseSingleFileMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  assert.ok(boundary, `expected a multipart boundary in ${contentType}`);
  const delimiter = `--${boundary[1] ?? boundary[2]}`;
  for (const part of body.toString('binary').split(delimiter)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const filename = /filename="([^"]*)"/i.exec(part.slice(0, headerEnd))?.[1];
    if (!filename) continue;
    return {
      filename,
      content: Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary'),
    };
  }
  throw new Error('the upload carried no file part');
}
