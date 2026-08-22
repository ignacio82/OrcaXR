import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/**
 * Endpoints real Moonraker serves for one method only, mirroring its API docs.
 * Anything absent here accepts GET, as Moonraker's query endpoints do.
 */
const REQUIRED_METHODS = Object.freeze({
  '/printer/print/start': 'POST',
  '/printer/print/pause': 'POST',
  '/printer/print/resume': 'POST',
  '/printer/print/cancel': 'POST',
  '/printer/emergency_stop': 'POST',
  '/printer/firmware_restart': 'POST',
  '/printer/restart': 'POST',
  '/printer/gcode/script': 'POST',
  '/server/files/move': 'POST',
  '/server/files/copy': 'POST',
});

/** A real 1x1 PNG, so a camera frame is decoded rather than merely counted. */
const SNAPSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
    progress: options.progress ?? 0,
    printDurationS: options.printDurationS ?? 0,
    filamentUsedMm: options.filamentUsedMm ?? 0,
    currentLayer: options.currentLayer ?? 0,
    totalLayers: options.totalLayers ?? 0,
    nozzleC: options.nozzleC ?? 24.5,
    bedC: options.bedC ?? 23.8,
    message: options.message ?? '',
    /** `configfile.settings`, where Klipper's macros live. */
    configSettings: options.configSettings ?? {},
    /** Canned replies by command mnemonic; anything else answers `ok`. */
    gcodeResponses: options.gcodeResponses ?? {},
    /** Recorded jobs, newest first, exactly as the history component stores them. */
    history: options.history ?? [],
    historyTotals: options.historyTotals ?? {},
    /** Cameras the printer reports, in Moonraker's own shape. */
    webcams: options.webcams ?? [],
    /** Path the snapshot endpoint answers on. */
    snapshotPath: options.snapshotPath ?? '/webcam/snapshot',
  };
  let snapshotRequests = 0;
  const commands = [];
  const stored = new Map();
  const requests = [];
  const apiKeys = [];
  const sockets = new Set();
  let started = null;
  let notificationId = 0;
  for (const name of options.files ?? []) stored.set(name, Buffer.alloc(1));
  /**
   * Scan metadata, keyed by path, exactly as Moonraker's file manager holds it:
   * a file it has never scanned has an entry here only if one was supplied, so
   * "no estimated time" and "no thumbnail" are reachable states rather than
   * assumptions.
   */
  const metadata = new Map(Object.entries(options.metadata ?? {}));
  const modified = new Map(Object.entries(options.modified ?? {}));

  /**
   * Push the objects a state change touched, exactly as Klipper does. Live
   * surfaces are meant to follow these notifications rather than poll, so the
   * simulator has to send them for that path to be exercised at all.
   */
  const notifyStatus = () => {
    if (sockets.size === 0) return;
    notificationId += 1;
    const frame = encodeWebSocketText(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify_status_update',
        params: [jobStatusObjects(state), notificationId],
      }),
    );
    for (const socket of sockets) socket.write(frame);
  };

  /** Klipper's own answer to a console command, pushed over the socket. */
  const notifyGcodeResponse = (line) => {
    if (sockets.size === 0) return;
    notificationId += 1;
    const frame = encodeWebSocketText(
      JSON.stringify({ jsonrpc: '2.0', method: 'notify_gcode_response', params: [line] }),
    );
    for (const socket of sockets) socket.write(frame);
  };

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
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
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

    // Real Moonraker answers 405 when a mutation arrives as a GET. Dispatching
    // on the pathname alone made this simulator more permissive than the server
    // it stands in for, so the whole client sent its print commands as GETs and
    // every test still passed. A double that accepts what the real thing
    // rejects is worse than no double at all.
    const requiredMethod = REQUIRED_METHODS[url.pathname];
    if (requiredMethod !== undefined && request.method !== requiredMethod) {
      response.writeHead(405, { ...cors, 'content-type': 'application/json', allow: requiredMethod });
      response.end(
        JSON.stringify({
          error: { code: 405, message: `Method ${request.method} not allowed`, traceback: null },
        }),
      );
      return;
    }

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
      if (url.searchParams.has('configfile')) {
        return json({ status: { configfile: { settings: state.configSettings } } });
      }
      if (url.searchParams.has('print_task_config')) {
        return json({
          status: {
            print_task_config: {
              filament_color_rgba: state.slots.map((slot) => `${slot.color}FF`),
              filament_type: state.slots.map((slot) => slot.material),
              // The machine reports its own finer grade beside the type, which
              // is what tells Matte from SnapSpeed.
              filament_sub_type: state.slots.map((slot) => slot.subType ?? ''),
              filament_vendor: state.slots.map((slot) => slot.vendor ?? 'Simulator'),
              filament_exist: state.slots.map(() => 1),
            },
          },
        });
      }
      return json({ status: jobStatusObjects(state) });
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
      const path = url.searchParams.get('filename') ?? '';
      return json({
        filename: path,
        size: content.length + state.reportedSizeDelta,
        ...(modified.has(path) ? { modified: modified.get(path) } : {}),
        ...(metadata.get(path) ?? {}),
      });
    }
    // The file manager's browse/rename/delete/download surface. Moonraker
    // exposes directories rather than one flat list, so the simulator does too;
    // a flat stand-in would never exercise folder navigation.
    if (url.pathname === '/server/files/directory') {
      const requested = (url.searchParams.get('path') ?? 'gcodes').replace(/^gcodes\/?/, '').replace(/\/+$/, '');
      const prefix = requested ? `${requested}/` : '';
      const dirs = new Set();
      const files = [];
      for (const [path, content] of stored.entries()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          files.push({
            filename: rest,
            size: content.length,
            modified: modified.get(path) ?? 0,
            permissions: 'rw',
          });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      return json({
        dirs: [...dirs].map((dirname) => ({ dirname, modified: 0, size: 4096, permissions: 'rw' })),
        files,
        disk_usage: { total: 8_000_000_000, used: 1_000_000, free: 7_999_000_000 },
        root_info: { name: 'gcodes', permissions: 'rw' },
      });
    }
    if (url.pathname === '/server/files/move') {
      const source = (url.searchParams.get('source') ?? '').replace(/^gcodes\//, '');
      const dest = (url.searchParams.get('dest') ?? '').replace(/^gcodes\//, '');
      if (!stored.has(source)) {
        response.writeHead(404, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      stored.set(dest, stored.get(source));
      stored.delete(source);
      if (metadata.has(source)) {
        metadata.set(dest, metadata.get(source));
        metadata.delete(source);
      }
      if (modified.has(source)) {
        modified.set(dest, modified.get(source));
        modified.delete(source);
      }
      commands.push(`move:${source}->${dest}`);
      return json({ item: { path: dest, root: 'gcodes' }, source_item: { path: source, root: 'gcodes' } });
    }
    if (url.pathname.startsWith('/server/files/gcodes/')) {
      const path = decodeURIComponent(url.pathname.slice('/server/files/gcodes/'.length));
      const content = stored.get(path);
      if (!content) {
        response.writeHead(404, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (request.method === 'DELETE') {
        stored.delete(path);
        metadata.delete(path);
        modified.delete(path);
        commands.push(`delete:${path}`);
        return json({ item: { path, root: 'gcodes' }, action: 'delete_file' });
      }
      response.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
      response.end(content);
      return;
    }
    // The console: Klipper acknowledges over HTTP and answers over the socket,
    // so a surface that only reads the HTTP reply would show nothing at all.
    if (url.pathname === '/printer/gcode/script') {
      const script = url.searchParams.get('script') ?? '';
      commands.push(`gcode:${script}`);
      const response = state.gcodeResponses[script.split(/\s/)[0].toUpperCase()] ?? 'ok';
      notifyGcodeResponse(response);
      return json('ok');
    }
    // Cameras: the list, plus a snapshot endpoint that answers with real bytes
    // so an authenticated fetch is exercised rather than mocked.
    if (url.pathname === '/server/webcams/list') {
      return json({ webcams: state.webcams });
    }
    if (url.pathname === state.snapshotPath) {
      snapshotRequests += 1;
      response.writeHead(200, { ...cors, 'content-type': 'image/png' });
      response.end(SNAPSHOT_PNG);
      return;
    }
    // The history the machine keeps of its own runs, paged the way Moonraker
    // pages it: a slice of the ordered list plus the total count.
    if (url.pathname === '/server/history/list') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const start = Number(url.searchParams.get('start') ?? '0');
      return json({ count: state.history.length, jobs: state.history.slice(start, start + limit) });
    }
    if (url.pathname === '/server/history/totals') {
      return json({ job_totals: state.historyTotals });
    }
    if (url.pathname === '/printer/print/start') {
      started = url.searchParams.get('filename');
      state.printState = 'printing';
      state.currentFilename = started;
      state.progress = state.progress || 0.12;
      state.printDurationS = state.printDurationS || 240;
      state.currentLayer = state.currentLayer || 11;
      state.totalLayers = state.totalLayers || 98;
      state.nozzleC = 219.6;
      state.bedC = 59.7;
      commands.push('start');
      notifyStatus();
      return json('ok');
    }
    // Lifecycle: the simulator moves its own state the way Klipper would, so a
    // control surface is tested against the state it will actually observe.
    if (url.pathname === '/printer/print/pause') {
      commands.push('pause');
      state.printState = 'paused';
      notifyStatus();
      return json('ok');
    }
    if (url.pathname === '/printer/print/resume') {
      commands.push('resume');
      state.printState = 'printing';
      notifyStatus();
      return json('ok');
    }
    if (url.pathname === '/printer/print/cancel') {
      commands.push('cancel');
      state.printState = 'cancelled';
      notifyStatus();
      return json('ok');
    }
    if (url.pathname === '/printer/emergency_stop') {
      commands.push('emergency-stop');
      state.klippy = 'shutdown';
      state.message = 'Emergency stop requested';
      notifyStatus();
      return json('ok');
    }
    if (url.pathname === '/printer/firmware_restart') {
      commands.push('firmware-restart');
      state.klippy = 'ready';
      state.printState = 'standby';
      state.message = '';
      notifyStatus();
      return json('ok');
    }
    response.writeHead(404, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unknown path' } }));
  }

  // Moonraker's JSON-RPC socket: the transport opens it during the handshake,
  // pushes identify/subscription frames, and then listens for status updates.
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
    // Answer every JSON-RPC call the client makes, including the transport's
    // heartbeat: an unanswered heartbeat makes it declare the socket lost and
    // reconnect, which would hide whether live updates actually work.
    socket.on('data', (chunk) => {
      for (const text of decodeWebSocketFrames(chunk)) {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        if (message && message.id !== undefined) {
          socket.write(encodeWebSocketText(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })));
        }
      }
    });
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
    /** Lifecycle commands the printer received, in order. */
    get commands() {
      return commands;
    },
    get state() {
      return state;
    },
    /** How many camera frames have been fetched, for polling assertions. */
    get snapshotRequests() {
      return snapshotRequests;
    },
    setSlots(slots) {
      state.slots = slots;
    },
    setState(patch) {
      Object.assign(state, patch);
      notifyStatus();
    },
    /** Put a file on the printer, optionally with the scan metadata it would have. */
    putFile(path, content = Buffer.alloc(1), scan = {}, modifiedSeconds) {
      stored.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
      if (Object.keys(scan).length > 0) metadata.set(path, scan);
      if (modifiedSeconds !== undefined) modified.set(path, modifiedSeconds);
    },
    /**
     * Drop every open websocket without stopping the HTTP server, so a client
     * sees exactly what a Wi-Fi blip looks like: the socket goes, the printer
     * keeps printing, and reconnecting works.
     */
    dropSockets() {
      const dropped = sockets.size;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return dropped;
    },
    reset() {
      stored.clear();
      metadata.clear();
      modified.clear();
      requests.length = 0;
      apiKeys.length = 0;
      commands.length = 0;
      started = null;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** The Klipper objects a live job surface reads, in Moonraker's own shape. */
function jobStatusObjects(state) {
  return {
    webhooks: { state: state.klippy },
    print_stats: {
      state: state.printState,
      filename: state.currentFilename,
      print_duration: state.printDurationS,
      total_duration: state.printDurationS,
      filament_used: state.filamentUsedMm,
      message: state.message,
      info: { current_layer: state.currentLayer, total_layer: state.totalLayers },
    },
    virtual_sdcard: { is_active: state.printState === 'printing', progress: state.progress },
    display_status: { progress: state.progress },
    extruder: { temperature: state.nozzleC, target: state.printState === 'printing' ? 220 : 0 },
    heater_bed: { temperature: state.bedC, target: state.printState === 'printing' ? 60 : 0 },
  };
}

/** Read the masked client frames in one chunk; control frames are ignored. */
function decodeWebSocketFrames(chunk) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const opcode = chunk[offset] & 0x0f;
    const masked = (chunk[offset + 1] & 0x80) !== 0;
    let length = chunk[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > chunk.length) break;
      length = chunk.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      // Nothing this client sends is that large; stop rather than guess.
      break;
    }
    let mask;
    if (masked) {
      if (cursor + 4 > chunk.length) break;
      mask = chunk.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > chunk.length) break;
    const payload = Buffer.from(chunk.subarray(cursor, cursor + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    if (opcode === 0x1) messages.push(payload.toString('utf8'));
    offset = cursor + length;
  }
  return messages;
}

/** Minimal unmasked server frame; payloads here stay well under 64 KiB. */
function encodeWebSocketText(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
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
