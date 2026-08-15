import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MoonrakerSessionCredentialStore,
  MoonrakerTransport,
  MoonrakerTransportError,
  calculateMoonrakerReconnectDelay,
  joinMoonrakerEndpointPath,
  normalizeMoonrakerEndpoint,
  redactMoonrakerDiagnostic,
  type MoonrakerConnectionState,
  type MoonrakerDiagnosticEvent,
  type MoonrakerReconnectPolicy,
  type MoonrakerScheduler,
  type MoonrakerSocket,
} from '..';
import { uploadDeadlineMs } from '../PrintJobSubmission';

const SERVER_INFO = Object.freeze({
  api_version: [1, 0, 5],
  moonraker_version: 'v0.9.3-1',
  components: ['authorization', 'file_manager', 'history', 'job_queue', 'klippy_apis', 'webcam', 'u1_ext'],
  warnings: [],
});
const PRINTER_INFO = Object.freeze({ state: 'ready', hostname: 'u1-workshop', software_version: 'v0.12.0' });

class ManualScheduler implements MoonrakerScheduler {
  nowMs = 0;
  private sequence = 0;
  private readonly tasks = new Map<number, { readonly delayMs: number; readonly callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.tasks.set(id, { delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  runDelay(delayMs: number): void {
    const task = [...this.tasks.entries()].find(([, candidate]) => candidate.delayMs === delayMs);
    assert.ok(task, `expected a scheduled ${delayMs} ms task; pending: ${this.pendingDelays().join(', ')}`);
    this.tasks.delete(task[0]);
    this.nowMs += delayMs;
    task[1].callback();
  }

  pendingDelays(): number[] {
    return [...this.tasks.values()].map(({ delayMs }) => delayMs).sort((left, right) => left - right);
  }
}

class FakeSocket implements MoonrakerSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  failBeforeOpen(): void {
    this.readyState = 3;
    this.onerror?.({});
  }

  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'secret remote reason' });
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(data: string): void {
    assert.equal(this.readyState, 1);
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

interface FetchObservation {
  readonly url: string;
  readonly headers: Headers;
  readonly signal?: AbortSignal;
}

function resultResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthyFetcher(observations: FetchObservation[] = []) {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input.toString();
    observations.push({ url, headers: new Headers(init.headers), signal: init.signal ?? undefined });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/server/info')) return resultResponse(SERVER_INFO);
    if (pathname.endsWith('/printer/info')) return resultResponse(PRINTER_INFO);
    return resultResponse({ ok: true });
  };
}

function createHarness(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = healthyFetcher(),
  logger?: (event: MoonrakerDiagnosticEvent) => void,
) {
  const scheduler = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const transport = new MoonrakerTransport(
    { endpoint: 'printer.local', clientVersion: 'test' },
    {
      fetch: fetcher,
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      scheduler,
      now: () => scheduler.nowMs,
      random: () => 0.5,
      requestTimeoutMs: 1_000,
      socketOpenTimeoutMs: 500,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 20,
      reconnect: { initialDelayMs: 10, maximumDelayMs: 25, maximumAttempts: 3, jitterRatio: 0 },
      logger,
    },
  );
  return { transport, scheduler, sockets };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function assertErrorCode(code: MoonrakerTransportError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MoonrakerTransportError && error.code === code;
}

async function connectHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  const connecting = harness.transport.connect();
  await waitFor(() => harness.sockets.length === 1, 'WebSocket was not created after the REST handshake');
  harness.sockets[0].open();
  await connecting;
}

{
  assert.deepEqual(normalizeMoonrakerEndpoint('printer.local'), {
    directHttpUrl: 'http://printer.local:7125',
    transportHttpUrl: 'http://printer.local:7125',
    webSocketUrl: 'ws://printer.local:7125/websocket',
    usesSameOriginProxy: false,
  });
  assert.deepEqual(normalizeMoonrakerEndpoint('https://printer.example/moonraker/'), {
    directHttpUrl: 'https://printer.example/moonraker',
    transportHttpUrl: 'https://printer.example/moonraker',
    webSocketUrl: 'wss://printer.example/moonraker/websocket',
    usesSameOriginProxy: false,
  });
  assert.deepEqual(
    normalizeMoonrakerEndpoint('10.0.0.5', {
      sameOriginProxy: '/api/moonraker/u1',
      pageOrigin: 'https://orcaxr.example/slicer/',
    }),
    {
      directHttpUrl: 'http://10.0.0.5:7125',
      transportHttpUrl: 'https://orcaxr.example/api/moonraker/u1',
      webSocketUrl: 'wss://orcaxr.example/api/moonraker/u1/websocket',
      usesSameOriginProxy: true,
    },
  );
  assert.equal(
    joinMoonrakerEndpointPath('https://printer.example/moonraker', '/printer/info'),
    'https://printer.example/moonraker/printer/info',
  );
  assert.throws(
    () => normalizeMoonrakerEndpoint('https://user:secret@printer.example'),
    assertErrorCode('invalid_endpoint'),
  );
  assert.throws(
    () => normalizeMoonrakerEndpoint('https://printer.example?token=secret'),
    assertErrorCode('invalid_endpoint'),
  );
  assert.throws(
    () =>
      normalizeMoonrakerEndpoint('printer.local', {
        sameOriginProxy: 'https://attacker.example/moonraker',
        pageOrigin: 'https://orcaxr.example',
      }),
    assertErrorCode('invalid_endpoint'),
  );
  assert.throws(
    () => joinMoonrakerEndpointPath('https://printer.example', '/server/info?access_token=secret'),
    assertErrorCode('invalid_endpoint'),
  );
}

{
  const policy: MoonrakerReconnectPolicy = {
    initialDelayMs: 100,
    maximumDelayMs: 250,
    maximumAttempts: 4,
    jitterRatio: 0,
  };
  assert.equal(calculateMoonrakerReconnectDelay(1, policy, 0.5), 100);
  assert.equal(calculateMoonrakerReconnectDelay(2, policy, 0.5), 200);
  assert.equal(calculateMoonrakerReconnectDelay(3, policy, 0.5), 250);
  assert.equal(calculateMoonrakerReconnectDelay(30, policy, 0.5), 250);
}

{
  const observations: FetchObservation[] = [];
  const harness = createHarness(healthyFetcher(observations));
  const states: string[] = [];
  harness.transport.subscribeState((state) => states.push(state.status));
  harness.transport.setSessionCredentials({ apiKey: 'session-only-super-secret' });
  harness.transport.setObjectSubscription({ print_stats: ['filename', 'state'], toolhead: null });
  await connectHarness(harness);

  assert.equal(harness.transport.state.status, 'connected');
  if (harness.transport.state.status !== 'connected') assert.fail('transport did not connect');
  assert.deepEqual(harness.transport.credentialMetadata, { hasApiKey: true, hasBearerToken: false });
  assert.equal(harness.transport.state.handshake.server.apiVersionString, '1.0.5');
  assert.equal(harness.transport.state.handshake.capabilities.fileManagement, true);
  assert.equal(harness.transport.state.handshake.capabilities.klippyConnected, true);
  assert.deepEqual(harness.transport.state.handshake.capabilities.extensionComponents, ['u1_ext']);
  assert.deepEqual(states, ['disconnected', 'connecting', 'connected']);
  assert.ok(observations.every(({ headers }) => headers.get('X-Api-Key') === 'session-only-super-secret'));
  assert.ok(observations.every(({ url }) => !url.includes('session-only-super-secret')));
  assert.ok(harness.sockets.every(({ url }) => !url.includes('session-only-super-secret')));
  await assert.rejects(
    harness.transport.request('/server/info?opaque=session-only-super-secret'),
    assertErrorCode('invalid_endpoint'),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    harness.transport.request('/server/info', { signal: cancelled.signal }),
    assertErrorCode('cancelled'),
  );

  const identify = JSON.parse(harness.sockets[0].sent[0]) as Record<string, unknown>;
  const subscription = JSON.parse(harness.sockets[0].sent[1]) as Record<string, unknown>;
  assert.equal(identify.method, 'server.connection.identify');
  assert.equal(subscription.method, 'printer.objects.subscribe');

  const beforeHeartbeat = harness.transport.state.lastHeartbeatAtMs;
  harness.scheduler.runDelay(100);
  const heartbeat = JSON.parse(harness.sockets[0].sent.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(heartbeat.method, 'server.info');
  harness.sockets[0].message({ jsonrpc: '2.0', id: heartbeat.id, result: SERVER_INFO });
  assert.equal(harness.transport.state.status, 'connected');
  if (harness.transport.state.status !== 'connected') assert.fail('heartbeat disconnected the transport');
  assert.ok(harness.transport.state.lastHeartbeatAtMs > beforeHeartbeat);
  harness.transport.dispose();
  assert.deepEqual(harness.transport.credentialMetadata, { hasApiKey: false, hasBearerToken: false });
}

{
  const harness = createHarness();
  await connectHarness(harness);
  harness.scheduler.runDelay(100);
  harness.scheduler.runDelay(20);
  assert.equal(harness.transport.state.status, 'reconnecting');
  if (harness.transport.state.status !== 'reconnecting') assert.fail('heartbeat timeout did not reconnect');
  assert.equal(harness.transport.state.lastError.code, 'heartbeat_timeout');
  harness.transport.dispose();
}

{
  const notifications: string[] = [];
  const harness = createHarness();
  harness.transport.subscribeNotifications((notification) => notifications.push(notification.method));
  await connectHarness(harness);
  const staleHandler = harness.sockets[0].onmessage;
  harness.sockets[0].remoteClose();
  assert.equal(harness.transport.state.status, 'reconnecting');
  if (harness.transport.state.status !== 'reconnecting') assert.fail('transport did not enter reconnecting');
  assert.equal(harness.transport.state.delayMs, 10);
  staleHandler?.({ data: JSON.stringify({ method: 'notify_stale', params: [] }) });
  assert.deepEqual(notifications, [], 'events from the retired socket generation must be ignored');

  const observedDelays = [harness.transport.state.delayMs];
  harness.scheduler.runDelay(10);
  await waitFor(() => harness.sockets.length === 2, 'first reconnect socket was not created');
  harness.sockets[1].failBeforeOpen();
  await waitFor(
    () => harness.transport.state.status === 'reconnecting' && harness.transport.state.attempt === 2,
    'second reconnect was not scheduled',
  );
  if (harness.transport.state.status !== 'reconnecting') assert.fail('expected reconnecting');
  observedDelays.push(harness.transport.state.delayMs);

  harness.scheduler.runDelay(20);
  await waitFor(() => harness.sockets.length === 3, 'second reconnect socket was not created');
  harness.sockets[2].failBeforeOpen();
  await waitFor(
    () => harness.transport.state.status === 'reconnecting' && harness.transport.state.attempt === 3,
    'third reconnect was not scheduled',
  );
  if (harness.transport.state.status !== 'reconnecting') assert.fail('expected reconnecting');
  observedDelays.push(harness.transport.state.delayMs);

  harness.scheduler.runDelay(25);
  await waitFor(() => harness.sockets.length === 4, 'third reconnect socket was not created');
  harness.sockets[3].failBeforeOpen();
  await waitFor(() => harness.transport.state.status === 'error', 'reconnect exhaustion did not enter error');
  assert.deepEqual(observedDelays, [10, 20, 25]);
  const exhaustedState = harness.transport.state as MoonrakerConnectionState;
  assert.equal(exhaustedState.status, 'error');
  if (exhaustedState.status !== 'error') assert.fail('expected error');
  assert.equal(exhaustedState.error.code, 'reconnect_exhausted');
  harness.transport.dispose();
}

{
  const logs: MoonrakerDiagnosticEvent[] = [];
  const maliciousBody = 'api key=session-only-secret at http://10.0.0.5/private';
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Api-Key'), 'session-only-secret');
    if (new URL(input.toString()).pathname.endsWith('/server/info')) {
      return new Response(maliciousBody, { status: 403 });
    }
    return resultResponse(PRINTER_INFO);
  };
  const harness = createHarness(fetcher, (event) => logs.push(event));
  harness.transport.setSessionCredentials({ apiKey: 'session-only-secret' });
  await assert.rejects(harness.transport.connect(), assertErrorCode('forbidden'));
  assert.equal(harness.transport.state.status, 'error');
  const diagnostic = JSON.stringify({ state: harness.transport.state, logs });
  assert.doesNotMatch(diagnostic, /session-only-secret|10\.0\.0\.5|maliciousBody|private/);
  assert.match(diagnostic, /forbidden/);
  harness.transport.dispose();
}

{
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    if (new URL(input.toString()).pathname.endsWith('/server/info')) {
      return resultResponse({ ...SERVER_INFO, api_version: [2, 0, 0] });
    }
    return resultResponse(PRINTER_INFO);
  };
  const harness = createHarness(fetcher);
  await assert.rejects(harness.transport.connect(), assertErrorCode('version_unsupported'));
  assert.equal(harness.sockets.length, 0, 'version negotiation must fail before opening a WebSocket');
  assert.equal(harness.transport.state.status, 'error');
  harness.transport.dispose();
}

{
  const fetcher = (_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('sensitive fetch detail', 'AbortError')), {
        once: true,
      });
    });
  const harness = createHarness(fetcher);
  const controller = new AbortController();
  const connecting = harness.transport.connect({ signal: controller.signal });
  controller.abort();
  await assert.rejects(connecting, assertErrorCode('cancelled'));
  assert.equal(harness.transport.state.status, 'disconnected');
  if (harness.transport.state.status !== 'disconnected') assert.fail('expected disconnected');
  assert.equal(harness.transport.state.reason, 'cancelled');
  harness.transport.dispose();
}

{
  let mutationStarted: (() => void) | undefined;
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname.endsWith('/server/info')) return resultResponse(SERVER_INFO);
    if (pathname.endsWith('/printer/info')) return resultResponse(PRINTER_INFO);
    return new Promise((_resolve, reject) => {
      mutationStarted?.();
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  const harness = createHarness(fetcher);
  await connectHarness(harness);
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  const mutation = harness.transport.request('/printer/print/start', {
    method: 'POST',
    operation: 'start_print',
  });
  await started;
  harness.sockets[0].remoteClose();
  await assert.rejects(mutation, assertErrorCode('cancelled'));
  assert.equal(harness.transport.state.status, 'reconnecting');
  harness.transport.dispose();
}

{
  const store = new MoonrakerSessionCredentialStore();
  store.set({ bearerToken: 'bearer-session-secret' });
  assert.deepEqual(store.metadata(), { hasApiKey: false, hasBearerToken: true });
  assert.deepEqual(store.requestHeaders(), { Authorization: 'Bearer bearer-session-secret' });
  assert.throws(() => store.set({ apiKey: 'one', bearerToken: 'two' }), assertErrorCode('invalid_credentials'));
  const redacted = redactMoonrakerDiagnostic(
    {
      endpoint: 'http://10.0.0.5/path?token=value',
      apiKey: 'bearer-session-secret',
      nested: ['Authorization: Bearer bearer-session-secret'],
    },
    ['bearer-session-secret'],
  );
  const storeRedacted = store.redact({ message: 'Bearer bearer-session-secret' });
  const serialized = JSON.stringify(redacted);
  const storeSerialized = JSON.stringify(storeRedacted);
  assert.doesNotMatch(serialized, /bearer-session-secret|10\.0\.0\.5|token=value/);
  assert.doesNotMatch(storeSerialized, /bearer-session-secret/);
  assert.match(serialized, /redacted/);
  store.clear();

  const credentialSource = readFileSync(new URL('../SessionCredentials.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(credentialSource, /localStorage|sessionStorage|indexedDB/);
}

// A file transfer rides Moonraker's HTTP API, which owes nothing to the
// JSON-RPC socket. Refusing while the socket reconnects is what reported
// "invalid_state" on a send made after a slice long enough for one reconnect.
{
  const harness = createHarness();
  await connectHarness(harness);
  harness.sockets[0].remoteClose();
  assert.equal(harness.transport.state.status, 'reconnecting', 'precondition: the socket is re-establishing');

  const readiness = await harness.transport.request<{ ok: boolean }>('/printer/objects/query', {
    operation: 'print_readiness',
  });
  assert.deepEqual(readiness, { ok: true }, 'a REST query still answers while the socket is down');

  const form = new FormData();
  form.set('file', new Blob(['G28\n'], { type: 'text/plain' }), 'plate.gcode');
  const uploaded = await harness.transport.upload<{ ok: boolean }>('/server/files/upload', form, {
    operation: 'upload_gcode',
  });
  assert.deepEqual(uploaded, { ok: true }, 'and an upload is not refused for it either');
  harness.transport.dispose();
}

// A websocket that reconnects mid-transfer must not discard a finished upload:
// the file is already on the printer, so reporting failure is worse than
// reporting nothing.
{
  let resolveUpload: ((response: Response) => void) | undefined;
  const harness = createHarness(async (input) => {
    if (String(input).includes('/server/files/upload')) {
      return new Promise<Response>((resolve) => {
        resolveUpload = resolve;
      });
    }
    return healthyFetcher()(input);
  });
  await connectHarness(harness);
  const form = new FormData();
  form.set('file', new Blob(['G28\n'], { type: 'text/plain' }), 'plate.gcode');
  const pending = harness.transport.upload<{ ok: boolean }>('/server/files/upload', form, {
    operation: 'upload_gcode',
  });
  await waitFor(() => resolveUpload !== undefined, 'upload did not reach the fetcher');
  // The socket blinks while the bytes are still going out.
  harness.sockets[0].remoteClose();
  resolveUpload?.(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  assert.deepEqual(await pending, { ok: true }, 'the completed upload is kept, not cancelled');
  harness.transport.dispose();
}

// A per-request deadline is a property of the payload, not of the transport's
// configuration. Validating it against the constructor's 5-minute sanity bound
// rejected every print larger than ~67 MB before a byte was sent, and reported
// it as `invalid_state` — a connection-state code for an argument that was
// never out of range.
{
  const harness = createHarness();
  await connectHarness(harness);
  const form = new FormData();
  form.set('file', new Blob(['G28\n'], { type: 'text/plain' }), 'plate.gcode');
  // What a 124 MB print legitimately asks for at the declared floor rate.
  const uploaded = await harness.transport.upload<{ ok: boolean }>('/server/files/upload', form, {
    operation: 'upload_gcode',
    timeoutMs: 526_400,
  });
  assert.deepEqual(uploaded, { ok: true }, 'a long upload deadline is honoured, not rejected');

  // The two modules have to agree about what a large print costs. Checking the
  // real sizes narwhal produces — 95 MB at 0.20 mm, 124 MB at 0.12 mm — against
  // the real transport is what the earlier tests missed: they only ever sent a
  // few megabytes, which stayed under the bound by accident.
  for (const megabytes of [95, 124, 512]) {
    const deadline = uploadDeadlineMs(megabytes * 1048576);
    const big = new FormData();
    big.set('file', new Blob(['G28\n'], { type: 'text/plain' }), 'plate.gcode');
    assert.deepEqual(
      await harness.transport.upload<{ ok: boolean }>('/server/files/upload', big, {
        operation: 'upload_gcode',
        timeoutMs: deadline,
      }),
      { ok: true },
      `a ${megabytes} MB print asks for ${Math.round(deadline / 1000)} s and the transport must accept it`,
    );
  }

  // A deadline that is not a duration is still a caller mistake, and says so.
  await assert.rejects(
    () => harness.transport.request('/printer/info', { operation: 'probe', timeoutMs: -1 }),
    assertErrorCode('invalid_request'),
    'a nonsensical deadline is reported as a bad argument, not a bad connection',
  );
  harness.transport.dispose();
}

// A mutation sent as a GET is answered by real Moonraker with 405. The client
// sent every print command that way, and both test doubles dispatched on the
// pathname alone, so nothing caught it until a printer did.
{
  const harness = createHarness();
  await connectHarness(harness);
  for (const path of [
    '/printer/print/start?filename=plate.gcode',
    '/printer/print/pause',
    '/printer/print/resume',
    '/printer/print/cancel',
    '/printer/emergency_stop',
    '/printer/firmware_restart',
    '/printer/gcode/script?script=M117',
    '/server/files/move?source=gcodes/a&dest=gcodes/b',
  ]) {
    await assert.rejects(
      () => harness.transport.request(path, { operation: 'probe' }),
      assertErrorCode('invalid_request'),
      `${path} must not be reachable as a GET`,
    );
    // The same path with the method Moonraker documents goes through.
    await harness.transport.request(path, { operation: 'probe', method: 'POST' });
  }
  harness.transport.dispose();
}

// A failure the server explained must not be reported as a bare code: the
// explanation is the part that tells an operator what to do next.
{
  const harness = createHarness(async (input) => {
    if (String(input).includes('/printer/print/start')) {
      return new Response(JSON.stringify({ error: { code: 400, message: 'Klippy is not ready' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return healthyFetcher()(input);
  });
  await connectHarness(harness);
  await assert.rejects(
    () => harness.transport.request('/printer/print/start?filename=plate.gcode', { operation: 'x', method: 'POST' }),
    (error: unknown) =>
      error instanceof MoonrakerTransportError &&
      error.code === 'http_error' &&
      error.httpStatus === 400 &&
      error.detail === 'Klippy is not ready',
    "the server's own account of the failure survives",
  );
  harness.transport.dispose();
}

console.log('Moonraker transport tests passed');
