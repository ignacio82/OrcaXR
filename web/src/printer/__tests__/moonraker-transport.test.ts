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

console.log('Moonraker transport tests passed');
