/**
 * The production `MoonrakerTransport` driven through the hosts' shared
 * transport contract. Every dependency it takes is scripted: `fetch` and each
 * response body, the socket factory and each socket's events, the scheduler,
 * the clock, and randomness. What the transport does is recorded in order —
 * requests and body reads, sockets opened, frames sent, sockets closed,
 * timers armed, state transitions and notifications — with timers cleared,
 * requests aborted and diagnostics alongside, so the Rust core
 * (`orcaxr_printer::transport`) can be fed the same inputs and must produce
 * the same.
 */
import type {
  ProjectConnectionStatusWire,
  ProjectMoonrakerConnectionStateWire,
  ProjectMoonrakerCredentialsWire,
  ProjectMoonrakerLogWire,
  ProjectMoonrakerRecoveryRequestWire,
  ProjectMoonrakerRequestOptionsWire,
  ProjectMoonrakerRequestWire,
  ProjectMoonrakerSignalWire,
  ProjectMoonrakerSubscriptionEntryWire,
  ProjectMoonrakerTaskFinishedWire,
  ProjectMoonrakerTaskResultWire,
  ProjectMoonrakerTransportConfigWire,
  ProjectMoonrakerTransportFaultWire,
  ProjectMoonrakerTransportOutcomeWire,
  ProjectMoonrakerTransportOutputWire,
  ProjectMoonrakerTransportReplyWire,
  ProjectMoonrakerTransportStepWire,
} from '../../../contracts/generated/project-intents';
import { handshakeWire, transportFaultWire } from './MoonrakerPolicyExchange';
import {
  MoonrakerTransport,
  type MoonrakerObjectSubscription,
  type MoonrakerRequestOptions,
  type MoonrakerScheduler,
  type MoonrakerSocket,
} from './MoonrakerTransport';
import {
  MoonrakerTransportError,
  type MoonrakerApiVersion,
  type MoonrakerConnectionState,
  type MoonrakerDiagnosticEvent,
  type MoonrakerErrorDiagnostic,
  type MoonrakerHandshake,
  type MoonrakerNotification,
} from './MoonrakerTypes';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const optional = (value: { value: readonly number[] } | { absent: object }): string | undefined =>
  'value' in value ? fromUnits(value.value) : undefined;
const finite = (value: { value: number } | { absent: object }): number | undefined =>
  'value' in value ? value.value : undefined;
const camel = (text: string): string => text.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A canonical array index, which JavaScript orders first among an object's keys. */
const arrayIndex = (key: string): boolean => /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4294967295;
/**
 * JSON with object keys in the order the shared core keeps them: array
 * indices numerically, then the rest by UTF-16 code unit. A reply's meaning
 * survives; only the order of keys a server happened to send does not.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value);
  const ordered = [...keys.filter(arrayIndex), ...keys.filter((key) => !arrayIndex(key)).sort()];
  const record = value as Record<string, unknown>;
  return `{${ordered.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export type MoonrakerTransportInputWire =
  | { readonly create: ProjectMoonrakerTransportConfigWire }
  | { readonly connect: { readonly signal: ProjectMoonrakerSignalWire } }
  | { readonly disconnect: string }
  | { readonly dispose: Record<string, never> }
  | { readonly credentials: ProjectMoonrakerCredentialsWire }
  | { readonly clearCredentials: Record<string, never> }
  | { readonly subscription: readonly ProjectMoonrakerSubscriptionEntryWire[] | null }
  | { readonly request: ProjectMoonrakerRequestWire }
  | { readonly upload: ProjectMoonrakerRequestWire }
  | { readonly download: ProjectMoonrakerRequestWire }
  | { readonly recovery: ProjectMoonrakerRecoveryRequestWire }
  | { readonly abort: number }
  | { readonly resolve: { readonly id: number; readonly outcome: ProjectMoonrakerTransportOutcomeWire } }
  | { readonly text: { readonly id: number; readonly text: string } }
  | { readonly socketOpen: number }
  | { readonly socketError: number }
  | { readonly socketClose: number }
  | { readonly socketMessage: { readonly socket: number; readonly text: string } }
  | { readonly timer: number };

export interface MoonrakerTransportRecord {
  readonly now: number;
  readonly input: MoonrakerTransportInputWire;
  readonly step?: ProjectMoonrakerTransportStepWire;
  readonly state?: ProjectMoonrakerConnectionStateWire;
  readonly reply?: ProjectMoonrakerTransportReplyWire;
  readonly refused?: ProjectMoonrakerTransportFaultWire | string;
  readonly hasApiKey?: boolean;
  readonly hasBearerToken?: boolean;
  /** The JSON text of each task result in the step, which hosts take apart from it. */
  readonly results?: readonly { readonly task: number; readonly text: string }[];
  /** The JSON text of each notification's params in the step, in output order. */
  readonly params?: readonly string[];
}

/** Answers what the transport asks synchronously: a socket, a random number. */
export interface MoonrakerTransportScript {
  socket(id: number, url: string): 'created' | 'unavailable' | 'broken';
  random(id: number): number;
}

interface Awaited {
  /** What answers it: response headers, or a body read as text or as bytes. */
  readonly kind: 'fetch' | 'text' | 'bytes';
  readonly settle: (outcome: { value: unknown } | { error: unknown }) => void;
}

function faultFromDiagnostic(diagnostic: MoonrakerErrorDiagnostic): ProjectMoonrakerTransportFaultWire {
  const detail = (diagnostic as { detail?: string }).detail;
  return {
    code: camel(diagnostic.code) as ProjectMoonrakerTransportFaultWire['code'],
    operation: units(diagnostic.operation),
    recoverable: diagnostic.recoverable,
    httpStatus: diagnostic.httpStatus === undefined ? absent : { value: diagnostic.httpStatus },
    detail: detail === undefined ? absent : { value: units(detail) },
  };
}
export function connectionStateWire(state: MoonrakerConnectionState): ProjectMoonrakerConnectionStateWire {
  switch (state.status) {
    case 'disconnected':
      return { disconnected: { generation: state.generation, reason: state.reason } };
    case 'connecting':
      return { connecting: { generation: state.generation, attempt: state.attempt } };
    case 'connected':
      return {
        connected: {
          generation: state.generation,
          socketEpoch: state.socketEpoch,
          connectedAtMs: state.connectedAtMs,
          lastHeartbeatAtMs: state.lastHeartbeatAtMs,
          handshake: handshakeWire(state.handshake),
        },
      };
    case 'reconnecting':
      return {
        reconnecting: {
          generation: state.generation,
          attempt: state.attempt,
          delayMs: state.delayMs,
          lastError: faultFromDiagnostic(state.lastError),
        },
      };
    case 'error':
      return { error: { generation: state.generation, error: faultFromDiagnostic(state.error) } };
  }
}
function logWire(event: MoonrakerDiagnosticEvent): ProjectMoonrakerLogWire {
  return {
    timestampMs: event.timestampMs,
    level: event.level,
    event: camel(event.event) as ProjectMoonrakerLogWire['event'],
    state: event.state as ProjectConnectionStatusWire,
    generation: event.generation,
    attempt: event.attempt === undefined ? absent : { value: event.attempt },
    error: event.error === undefined ? absent : { value: faultFromDiagnostic(event.error) },
  };
}

export class MoonrakerTransportRecorder {
  readonly records: MoonrakerTransportRecord[] = [];
  transport: MoonrakerTransport | undefined;
  private readonly awaiting = new Map<number, Awaited>();
  private readonly timers = new Map<number, () => void>();
  private readonly sockets = new Map<number, ScriptedSocket>();
  private readonly signals = new Map<number, AbortController>();
  private nextEffect = 0;
  private nextTimer = 0;
  private nextTask = 0;
  private clock = 0;
  private input: MoonrakerTransportInputWire | undefined;
  private outputs: ProjectMoonrakerTransportOutputWire[] = [];
  private cleared: number[] = [];
  private aborted: number[] = [];
  private logs: ProjectMoonrakerLogWire[] = [];
  private finished: ProjectMoonrakerTaskFinishedWire[] = [];
  private task: number | undefined;
  private results: { task: number; text: string }[] = [];
  private params: string[] = [];
  private nextNotification = 0;

  constructor(private readonly script: MoonrakerTransportScript) {}

  /** Effects waiting for an answer: requests and body reads, oldest first. */
  pending(): { id: number; kind: Awaited['kind'] }[] {
    return [...this.awaiting.entries()].map(([id, awaited]) => ({ id, kind: awaited.kind }));
  }
  liveTimers(): number[] {
    return [...this.timers.keys()];
  }
  /** The output that issued effect `id`. */
  effect(id: number): ProjectMoonrakerTransportOutputWire | undefined {
    return this.effects.get(id);
  }
  socketIds(): number[] {
    return [...this.sockets.keys()];
  }
  private readonly effects = new Map<number, ProjectMoonrakerTransportOutputWire>();

  create(config: ProjectMoonrakerTransportConfigWire, now: number): void {
    this.begin({ create: config }, now);
    const scheduler: MoonrakerScheduler = {
      setTimeout: (callback, delayMs) => {
        const timer = ++this.nextTimer;
        this.outputs.push({ setTimer: { timer, delayMs } });
        this.timers.set(timer, callback);
        return timer;
      },
      clearTimeout: (handle) => {
        if (typeof handle === 'number' && this.timers.delete(handle)) this.cleared.push(handle);
      },
    };
    const minimum = 'value' in config.versionPolicy.minimum ? config.versionPolicy.minimum.value : undefined;
    const maximumMajor = finite(config.versionPolicy.maximumMajor);
    const reconnect = Object.fromEntries(
      (['initialDelayMs', 'maximumDelayMs', 'maximumAttempts', 'jitterRatio'] as const)
        .map((key) => [key, finite(config.reconnect[key])])
        .filter(([, value]) => value !== undefined),
    );
    const defined = <T extends object>(value: T): Partial<T> =>
      Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
    let transport: MoonrakerTransport;
    try {
      transport = new MoonrakerTransport(
        {
          endpoint: fromUnits(config.endpoint),
          ...defined({
            defaultPort: finite(config.defaultPort),
            sameOriginProxy: optional(config.sameOriginProxy),
            clientName: optional(config.clientName),
            clientVersion: optional(config.clientVersion),
          }),
          // The page this runs in has no origin; an absent one stays absent.
          pageOrigin: optional(config.pageOrigin) ?? '',
          versionPolicy: defined({
            minimum: minimum === undefined ? undefined : ([...minimum] as unknown as MoonrakerApiVersion),
            maximumMajor,
          }),
        },
        {
          fetch: (input, init) => this.fetch(String(input), init ?? {}),
          socketFactory: (url) => this.socket(url),
          scheduler,
          now: () => this.clock,
          random: () => this.random(),
          ...defined({
            requestTimeoutMs: finite(config.requestTimeoutMs),
            socketOpenTimeoutMs: finite(config.socketOpenTimeoutMs),
            heartbeatIntervalMs: finite(config.heartbeatIntervalMs),
            heartbeatTimeoutMs: finite(config.heartbeatTimeoutMs),
          }),
          reconnect,
          logger: (event) => this.logs.push(logWire(event)),
        },
      );
    } catch (error) {
      this.records.push({ now, input: this.input!, reply: { refused: transportFaultWire(error) } });
      return;
    }
    this.transport = transport;
    let initial = true;
    transport.subscribeState((state) => {
      // The host reads the first state from the reply instead.
      if (initial) initial = false;
      else this.outputs.push({ state: connectionStateWire(state) });
    });
    transport.subscribeNotifications((notification: MoonrakerNotification) => {
      this.params.push(canonicalJson(notification.params));
      this.outputs.push({
        notification: {
          id: ++this.nextNotification,
          method: units(notification.method),
          receivedAtMs: notification.receivedAtMs,
          generation: notification.generation,
          socketEpoch: notification.socketEpoch,
        },
      });
    });
    this.records.push({ now, input: this.input!, reply: { state: connectionStateWire(transport.state) } });
    this.reset();
  }

  async connect(signal: ProjectMoonrakerSignalWire, now: number): Promise<void> {
    this.begin({ connect: { signal } }, now);
    const transport = this.transport!;
    const controller = this.signalFor(signal);
    this.start(
      transport.connect(controller ? { signal: controller.signal } : {}),
      (handshake) => ({ handshake: handshakeWire(handshake as MoonrakerHandshake) }),
      controller,
    );
    await this.finish();
  }
  async disconnect(reason: string, now: number): Promise<void> {
    this.begin({ disconnect: reason }, now);
    this.transport!.disconnect(reason as 'user' | 'cancelled' | 'disposed');
    await this.finish();
  }
  async dispose(now: number): Promise<void> {
    this.begin({ dispose: {} }, now);
    this.transport!.dispose();
    await this.finish();
  }
  credentials(credentials: ProjectMoonrakerCredentialsWire, now: number): void {
    this.begin({ credentials }, now);
    const apiKey = optional(credentials.apiKey);
    const bearerToken = optional(credentials.bearerToken);
    let refused: ProjectMoonrakerTransportFaultWire | undefined;
    try {
      this.transport!.setSessionCredentials({
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(bearerToken === undefined ? {} : { bearerToken }),
      });
    } catch (error) {
      refused = transportFaultWire(error);
    }
    this.metadata(now, refused);
  }
  clearCredentials(now: number): void {
    this.begin({ clearCredentials: {} }, now);
    this.transport!.clearSessionCredentials();
    this.metadata(now);
  }
  private metadata(now: number, refused?: ProjectMoonrakerTransportFaultWire): void {
    const metadata = this.transport!.credentialMetadata;
    this.records.push({
      now,
      input: this.input!,
      ...(refused ? { refused } : {}),
      hasApiKey: metadata.hasApiKey,
      hasBearerToken: metadata.hasBearerToken,
    });
  }
  async subscription(entries: readonly ProjectMoonrakerSubscriptionEntryWire[] | null, now: number): Promise<void> {
    this.begin({ subscription: entries }, now);
    const object =
      entries === null
        ? null
        : (Object.fromEntries(
            entries.map((entry) => [
              fromUnits(entry.name),
              'value' in entry.fields ? entry.fields.value.map(fromUnits) : null,
            ]),
          ) as MoonrakerObjectSubscription);
    try {
      this.transport!.setObjectSubscription(object);
    } catch (error) {
      this.records.push({ now, input: this.input!, refused: transportFaultWire(error) });
      this.reset();
      return;
    }
    await this.finish();
  }

  async request(request: ProjectMoonrakerRequestWire, now: number): Promise<void> {
    this.begin({ request }, now);
    const { options, controller } = this.options(request.options);
    this.start(
      this.transport!.request(fromUnits(request.path), options),
      (result) => ({ json: canonicalJson(result) }),
      controller,
    );
    await this.finish();
  }
  async upload(request: ProjectMoonrakerRequestWire, now: number): Promise<void> {
    this.begin({ upload: request }, now);
    const { options, controller } = this.options(request.options);
    this.start(
      this.transport!.upload(fromUnits(request.path), new FormData(), options),
      (result) => ({ json: canonicalJson(result) }),
      controller,
    );
    await this.finish();
  }
  async download(request: ProjectMoonrakerRequestWire, now: number): Promise<void> {
    this.begin({ download: request }, now);
    const { options, controller } = this.options(request.options);
    this.start(
      this.transport!.download(fromUnits(request.path), options),
      (bytes) => ({ bytes: (bytes as Uint8Array).byteLength }),
      controller,
    );
    await this.finish();
  }
  async recovery(request: ProjectMoonrakerRecoveryRequestWire, now: number): Promise<void> {
    this.begin({ recovery: request }, now);
    const controller = this.signalFor(request.signal);
    this.start(
      this.transport!.requestRecoveryCommand(
        fromUnits(request.command) as 'emergency-stop' | 'firmware-restart',
        controller?.signal,
      ),
      (result) => ({ json: canonicalJson(result) }),
      controller,
    );
    await this.finish();
  }
  /** The caller's own signal for task `task` aborts. */
  async abort(task: number, now: number): Promise<void> {
    this.begin({ abort: task }, now);
    this.signals.get(task)?.abort();
    await this.finish();
  }

  async resolve(id: number, outcome: ProjectMoonrakerTransportOutcomeWire, now: number): Promise<void> {
    this.begin({ resolve: { id, outcome } }, now);
    const awaited = this.awaiting.get(id);
    // A text body is answered by `text`; a failure answers anything.
    const fits =
      awaited &&
      ('failed' in outcome ||
        (awaited.kind === 'fetch' && 'headers' in outcome) ||
        (awaited.kind === 'bytes' && 'bytes' in outcome));
    if (!awaited) return this.refuse(now, 'not_pending');
    if (!fits) return this.refuse(now, 'mismatch');
    this.awaiting.delete(id);
    if ('headers' in outcome) {
      const { status, contentLength } = outcome.headers;
      awaited.settle({ value: this.response(id, status, optional(contentLength)) });
    } else if ('bytes' in outcome) {
      // Only the length is read; a body past the bound is never allocated.
      const length = outcome.bytes;
      awaited.settle({ value: length > 256 * 1024 * 1024 ? { byteLength: length } : new ArrayBuffer(length) });
    } else awaited.settle({ error: new TypeError('Failed to fetch') });
    await this.finish();
  }
  /** A body read as text, answered. */
  async text(id: number, body: string, now: number): Promise<void> {
    this.begin({ text: { id, text: body } }, now);
    const awaited = this.awaiting.get(id);
    if (!awaited) return this.refuse(now, 'not_pending');
    if (awaited.kind !== 'text') return this.refuse(now, 'mismatch');
    this.awaiting.delete(id);
    awaited.settle({ value: body });
    await this.finish();
  }
  async socketEvent(kind: 'socketOpen' | 'socketError' | 'socketClose', socket: number, now: number): Promise<void> {
    this.begin({ [kind]: socket } as MoonrakerTransportInputWire, now);
    const target = this.sockets.get(socket);
    if (target) {
      if (kind === 'socketOpen') {
        target.readyState = 1;
        target.onopen?.({});
      } else if (kind === 'socketError') {
        target.readyState = 3;
        target.onerror?.({});
      } else {
        target.readyState = 3;
        target.onclose?.({ code: 1006, reason: '' });
      }
    }
    await this.finish();
  }
  async socketMessage(socket: number, text: string, now: number): Promise<void> {
    this.begin({ socketMessage: { socket, text } }, now);
    this.sockets.get(socket)?.onmessage?.({ data: text });
    await this.finish();
  }
  async timer(timer: number, now: number): Promise<void> {
    this.begin({ timer }, now);
    const callback = this.timers.get(timer);
    this.timers.delete(timer);
    callback?.();
    await this.finish();
  }

  /** @internal */
  pushOutput(output: ProjectMoonrakerTransportOutputWire): void {
    this.outputs.push(output);
    const id =
      'fetch' in output
        ? output.fetch.id
        : 'readBody' in output
          ? output.readBody.id
          : 'openSocket' in output
            ? output.openSocket.id
            : undefined;
    if (id !== undefined) this.effects.set(id, output);
  }

  private options(wire: ProjectMoonrakerRequestOptionsWire): {
    options: MoonrakerRequestOptions;
    controller: AbortController | undefined;
  } {
    const controller = this.signalFor(wire.signal);
    const method = optional(wire.method);
    const operation = optional(wire.operation);
    const timeoutMs = 'unbounded' in wire.timeoutMs ? null : 'ms' in wire.timeoutMs ? wire.timeoutMs.ms : undefined;
    return {
      controller,
      options: {
        ...(method === undefined ? {} : { method }),
        ...(operation === undefined ? {} : { operation }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(wire.headers.length === 0
          ? {}
          : { headers: Object.fromEntries(wire.headers.map((h) => [fromUnits(h.name), fromUnits(h.value)])) }),
        ...(wire.acceptBareEnvelope ? { acceptBareEnvelope: true } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      },
    };
  }
  private signalFor(signal: ProjectMoonrakerSignalWire): AbortController | undefined {
    if (signal === 'none') return undefined;
    const controller = new AbortController();
    if (signal === 'aborted') controller.abort();
    return controller;
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    if (init.redirect !== 'error') throw new Error('A transport request must refuse redirects');
    const id = ++this.nextEffect;
    const body =
      init.body === undefined || init.body === null ? 'none' : init.body instanceof FormData ? 'upload' : null;
    if (body === null) throw new Error('Unrecorded request body');
    this.pushOutput({
      fetch: {
        id,
        url: units(url),
        method: units(init.method ?? 'GET'),
        headers: [...new Headers(init.headers)].map(([name, value]) => ({ name: units(name), value: units(value) })),
        body,
        credentials: init.credentials === 'same-origin' ? 'sameOrigin' : 'omit',
      },
    });
    this.fetchSignals.set(id, init.signal ?? undefined);
    return this.awaitEffect(id, 'fetch', init.signal ?? undefined) as Promise<Response>;
  }
  private awaitEffect(id: number, kind: Awaited['kind'], signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted) throw new Error('An effect issued on an aborted signal is unrecorded');
    return new Promise((resolve, reject) => {
      this.awaiting.set(id, {
        kind,
        settle: (outcome) => ('value' in outcome ? resolve(outcome.value) : reject(outcome.error)),
      });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.awaiting.delete(id)) return;
          this.aborted.push(id);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  private response(fetch: number, status: number, contentLength: string | undefined): Response {
    const signal = this.fetchSignals.get(fetch);
    const read = (kind: 'text' | 'bytes') => {
      const id = ++this.nextEffect;
      this.pushOutput({ readBody: { id, fetch, kind } });
      return this.awaitEffect(id, kind, signal);
    };
    return {
      ok: status >= 200 && status <= 299,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-length' ? (contentLength ?? null) : null),
      },
      text: () => read('text'),
      arrayBuffer: () => read('bytes'),
    } as unknown as Response;
  }
  private readonly fetchSignals = new Map<number, AbortSignal | undefined>();

  private socket(url: string): MoonrakerSocket {
    const id = ++this.nextEffect;
    this.pushOutput({ openSocket: { id, url: units(url) } });
    this.push();
    const answer = this.script.socket(id, url);
    this.input = { resolve: { id, outcome: { [answer]: {} } as ProjectMoonrakerTransportOutcomeWire } };
    if (answer === 'unavailable') throw new MoonrakerTransportError('websocket_unavailable', 'open_websocket');
    if (answer === 'broken') throw new Error('socket construction failed');
    const socket = new ScriptedSocket(this, id);
    this.sockets.set(id, socket);
    return socket;
  }
  private random(): number {
    const id = ++this.nextEffect;
    this.outputs.push({ random: { id } });
    this.push();
    const value = this.script.random(id);
    this.input = { resolve: { id, outcome: { random: value } } };
    return value;
  }

  /** A result that is JSON text travels beside the step, its length in it. */
  private start(
    task: Promise<unknown>,
    wire: (value: unknown) => ProjectMoonrakerTaskResultWire | { readonly json: string },
    controller: AbortController | undefined,
  ): void {
    const id = ++this.nextTask;
    this.task = id;
    if (controller) this.signals.set(id, controller);
    task.then(
      (value) => {
        const result = wire(value);
        if ('json' in result) {
          this.results.push({ task: id, text: result.json });
          this.finished.push({ task: id, result: { result: { units: result.json.length } } });
        } else this.finished.push({ task: id, result });
      },
      (error: unknown) => {
        if (!(error instanceof MoonrakerTransportError)) throw error;
        this.finished.push({ task: id, result: { refused: transportFaultWire(error) } });
      },
    );
  }
  private begin(input: MoonrakerTransportInputWire, now: number): void {
    this.input = input;
    this.clock = now;
  }
  private refuse(now: number, code: string): void {
    this.records.push({ now, input: this.input!, refused: code });
    this.reset();
  }
  private reset(): void {
    this.outputs = [];
    this.cleared = [];
    this.aborted = [];
    this.logs = [];
    this.finished = [];
    this.task = undefined;
    this.results = [];
    this.params = [];
  }
  private push(): void {
    this.records.push({
      now: this.clock,
      input: this.input!,
      step: {
        outputs: this.outputs,
        cleared: [...this.cleared].sort((a, b) => a - b),
        aborted: [...this.aborted].sort((a, b) => a - b),
        // Diagnostics of tasks woken together arrive in an order set by
        // promise depth; the contract lists them canonically.
        logs: [...this.logs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        task: this.task === undefined ? absent : { value: this.task },
        finished: [...this.finished].sort((a, b) => a.task - b.task),
      },
      ...(this.transport ? { state: connectionStateWire(this.transport.state) } : {}),
      ...(this.results.length > 0 ? { results: [...this.results].sort((a, b) => a.task - b.task) } : {}),
      ...(this.params.length > 0 ? { params: this.params } : {}),
    });
    this.reset();
  }
  private async finish(): Promise<void> {
    await drain();
    this.push();
  }
}

/** A socket whose frames and closes are outputs of the recorder. */
class ScriptedSocket implements MoonrakerSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;
  constructor(
    private readonly recorder: MoonrakerTransportRecorder,
    readonly id: number,
  ) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('A send on a socket that is not open is unrecorded');
    this.recorder.pushOutput({ socketSend: { socket: this.id, text: units(data) } });
  }
  close(code?: number, reason?: string): void {
    this.recorder.pushOutput({ socketClose: { socket: this.id, code: code ?? 1000, reason: units(reason ?? '') } });
    this.readyState = 3;
  }
}
