/**
 * The Moonraker transport run by the shared core (`orcaxr_printer::transport`
 * through the project WASM): the same connection, handshake, socket,
 * heartbeat, reconnect and request policy the Android app runs, with this
 * class doing only what a browser must — fetch, read bodies, open and write
 * sockets, keep timers, draw random numbers — and translating between the
 * contract and the browser's types. Its public surface is the browser
 * `MoonrakerTransport`'s, which stays as the reference the core is replayed
 * against and as the rollback adapter.
 *
 * Each call into the core answers a step: effects to carry out, effects to
 * abandon, timers to clear, diagnostics and the tasks that finished. Steps are
 * applied strictly in the order the core produced them; an effect the core
 * asks for synchronously (a socket's construction, a random draw) is answered
 * before any listener runs, so nothing else reaches the core in between. A
 * task's result and a notification's params travel beside the step and are
 * taken once.
 */
import {
  decodeProjectMoonrakerConnectionState,
  decodeProjectMoonrakerEndpointReply,
  decodeProjectMoonrakerTransportReply,
  decodeProjectMoonrakerTransportStep,
  decodeProjectMoonrakerTransportStepReply,
  decodeProjectOptionalMoonrakerTransportFault,
  encodeProjectMoonrakerCredentials,
  encodeProjectMoonrakerEndpointRequest,
  encodeProjectMoonrakerObjectSubscription,
  encodeProjectMoonrakerRecoveryRequest,
  encodeProjectMoonrakerRequest,
  encodeProjectMoonrakerTransportConfig,
  encodeProjectMoonrakerTransportOutcome,
  type ProjectMoonrakerConnectionStateWire,
  type ProjectMoonrakerHandshakeWire,
  type ProjectMoonrakerLogWire,
  type ProjectMoonrakerRequestOptionsWire,
  type ProjectMoonrakerSignalWire,
  type ProjectMoonrakerTransportFaultWire,
  type ProjectMoonrakerTransportOutcomeWire,
  type ProjectMoonrakerTransportStepWire,
} from '../../../contracts/generated/project-intents';
import { fetchLocalNetwork } from '../net/LocalNetworkAccess';
import type {
  MoonrakerConnection,
  MoonrakerObjectSubscription,
  MoonrakerRequestOptions,
  MoonrakerScheduler,
  MoonrakerSocket,
  MoonrakerStateListener,
  MoonrakerNotificationListener,
  MoonrakerTransportConfig,
  MoonrakerTransportDependencies,
} from './MoonrakerTransport';
import {
  MoonrakerTransportError,
  type MoonrakerConnectionState,
  type MoonrakerCredentialMetadata,
  type MoonrakerDiagnosticEvent,
  type MoonrakerDisconnectReason,
  type MoonrakerErrorCode,
  type MoonrakerErrorDiagnostic,
  type MoonrakerHandshake,
  type MoonrakerNotification,
  type MoonrakerSessionCredentials,
  type NormalizedMoonrakerEndpoint,
} from './MoonrakerTypes';

/** The shared core's transport machine, as the WASM binding exposes it. */
export interface MoonrakerTransportMachine {
  take_result(task: number): string;
  take_params(id: number): string;
  state(): string;
  has_api_key(): boolean;
  has_bearer_token(): boolean;
  set_credentials(credentials: string, nowMs: number): string;
  clear_credentials(nowMs: number): void;
  set_subscription(entries: string, nowMs: number): string;
  clear_subscription(nowMs: number): string;
  connect(signal: string, nowMs: number): string;
  disconnect(reason: string, nowMs: number): string;
  dispose(nowMs: number): string;
  request(request: string, nowMs: number): string;
  upload(request: string, nowMs: number): string;
  download(request: string, nowMs: number): string;
  recovery(request: string, nowMs: number): string;
  abort(task: number, nowMs: number): string;
  resolve(id: number, outcome: string, nowMs: number): string;
  resolve_text(id: number, text: string, nowMs: number): string;
  socket_open(socket: number, nowMs: number): string;
  socket_error(socket: number, nowMs: number): string;
  socket_close(socket: number, nowMs: number): string;
  socket_message(socket: number, text: string, nowMs: number): string;
  timer(timer: number, nowMs: number): string;
}

/** What the transport needs from the loaded shared core. */
export interface MoonrakerTransportCore {
  readonly MoonrakerTransport: {
    new (config: string): MoonrakerTransportMachine;
    configure(config: string): string;
    max_text_units(): number;
  };
  moonraker_endpoint(request: string): string;
}

type Step = ProjectMoonrakerTransportStepWire;
type Fault = ProjectMoonrakerTransportFaultWire;
type Units = readonly number[];

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const text = (value: string | undefined) => (value === undefined ? absent : { value: units(value) });
const finite = (value: number | undefined) => (value === undefined ? absent : { value });
function fromUnits(value: Units): string {
  let out = '';
  for (let i = 0; i < value.length; i += 8192) out += String.fromCharCode(...value.slice(i, i + 8192));
  return out;
}
const snake = (code: string): string => code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function diagnostic(fault: Fault): MoonrakerErrorDiagnostic {
  return Object.freeze({
    name: 'MoonrakerTransportError',
    code: snake(fault.code) as MoonrakerErrorCode,
    operation: fromUnits(fault.operation),
    recoverable: fault.recoverable,
    ...('value' in fault.httpStatus ? { httpStatus: fault.httpStatus.value } : {}),
    ...('value' in fault.detail ? { detail: fromUnits(fault.detail.value) } : {}),
  });
}

function transportError(fault: Fault): MoonrakerTransportError {
  return new MoonrakerTransportError(snake(fault.code) as MoonrakerErrorCode, fromUnits(fault.operation), {
    recoverable: fault.recoverable,
    ...('value' in fault.httpStatus ? { httpStatus: fault.httpStatus.value } : {}),
    ...('value' in fault.detail ? { detail: fromUnits(fault.detail.value) } : {}),
  });
}

function handshake(wire: ProjectMoonrakerHandshakeWire): MoonrakerHandshake {
  const { server, printer, capabilities } = wire;
  return Object.freeze({
    server: Object.freeze({
      apiVersion: Object.freeze([...server.apiVersion]) as unknown as MoonrakerHandshake['server']['apiVersion'],
      apiVersionString: fromUnits(server.apiVersionString),
      moonrakerVersion: fromUnits(server.moonrakerVersion),
      components: Object.freeze(server.components.map(fromUnits)),
      warnings: Object.freeze(server.warnings.map(fromUnits)),
    }),
    printer: Object.freeze({
      state: fromUnits(printer.state),
      hostname: fromUnits(printer.hostname),
      softwareVersion: fromUnits(printer.softwareVersion),
    }),
    capabilities: Object.freeze({
      websocket: true,
      authorization: capabilities.authorization,
      fileManagement: capabilities.fileManagement,
      jobQueue: capabilities.jobQueue,
      history: capabilities.history,
      webcams: capabilities.webcams,
      powerDevices: capabilities.powerDevices,
      updateManager: capabilities.updateManager,
      announcements: capabilities.announcements,
      database: capabilities.database,
      klippyConnected: capabilities.klippyConnected,
      extensionComponents: Object.freeze(capabilities.extensionComponents.map(fromUnits)),
    }),
  });
}

function connectionState(wire: ProjectMoonrakerConnectionStateWire): MoonrakerConnectionState {
  if ('disconnected' in wire) {
    const { generation, reason } = wire.disconnected;
    return Object.freeze({ status: 'disconnected', generation, reason });
  }
  if ('connecting' in wire)
    return Object.freeze({ status: 'connecting', generation: wire.connecting.generation, attempt: 0 });
  if ('connected' in wire) {
    const state = wire.connected;
    return Object.freeze({
      status: 'connected',
      generation: state.generation,
      socketEpoch: state.socketEpoch,
      connectedAtMs: state.connectedAtMs,
      lastHeartbeatAtMs: state.lastHeartbeatAtMs,
      handshake: handshake(state.handshake),
    });
  }
  if ('reconnecting' in wire) {
    const state = wire.reconnecting;
    return Object.freeze({
      status: 'reconnecting',
      generation: state.generation,
      attempt: state.attempt,
      delayMs: state.delayMs,
      lastError: diagnostic(state.lastError),
    });
  }
  return Object.freeze({ status: 'error', generation: wire.error.generation, error: diagnostic(wire.error.error) });
}

function diagnosticEvent(log: ProjectMoonrakerLogWire): MoonrakerDiagnosticEvent {
  return Object.freeze({
    timestampMs: log.timestampMs,
    level: log.level,
    event: snake(log.event) as MoonrakerDiagnosticEvent['event'],
    state: log.state,
    generation: log.generation,
    ...('value' in log.attempt ? { attempt: log.attempt.value } : {}),
    ...('value' in log.error ? { error: diagnostic(log.error.value) } : {}),
  });
}

/** Protocol values are immutable once received, as the browser transport's are. */
function freeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function defaultSocketFactory(url: string): MoonrakerSocket {
  if (typeof WebSocket === 'undefined') throw new MoonrakerTransportError('websocket_unavailable', 'open_websocket');
  return new WebSocket(url) as unknown as MoonrakerSocket;
}

function defaultScheduler(): MoonrakerScheduler {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

const browserPageOrigin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

interface Task {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Releases the caller's abort listener. */
  readonly release?: () => void;
}

interface Fetch {
  readonly controller: AbortController;
  /** The caller's task, when a request, upload or download issued it. */
  readonly task?: number;
  response?: Response;
  /** The core abandoned it: it is never answered. */
  abandoned?: boolean;
}

export class SharedMoonrakerTransport implements MoonrakerConnection {
  readonly endpoint: NormalizedMoonrakerEndpoint;

  private readonly machine: MoonrakerTransportMachine;
  private readonly textBound: number;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly socketFactory: (url: string) => MoonrakerSocket;
  private readonly scheduler: MoonrakerScheduler;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger?: (event: MoonrakerDiagnosticEvent) => void;
  private readonly stateListeners = new Set<MoonrakerStateListener>();
  private readonly notificationListeners = new Set<MoonrakerNotificationListener>();

  private readonly tasks = new Map<number, Task>();
  /** The task (and upload body) of a fetch a caller's call issued, until it is issued. */
  private readonly hints = new Map<number, { readonly task: number; readonly body?: FormData }>();
  private readonly fetches = new Map<number, Fetch>();
  /** Body reads in flight, by effect id, with the fetch whose body they read. */
  private readonly reads = new Map<number, number>();
  /** Downloaded bytes by task, until the task finishes with their length. */
  private readonly downloads = new Map<number, Uint8Array>();
  private readonly sockets = new Map<number, MoonrakerSocket>();
  private readonly timers = new Map<number, unknown>();
  private readonly queue: Step[] = [];
  private draining = false;
  private current: MoonrakerConnectionState;

  constructor(
    core: MoonrakerTransportCore,
    config: MoonrakerTransportConfig,
    dependencies: MoonrakerTransportDependencies = {},
  ) {
    const pageOrigin = config.pageOrigin ?? browserPageOrigin();
    const policy = config.versionPolicy;
    const wireConfig = encodeProjectMoonrakerTransportConfig({
      endpoint: units(config.endpoint),
      defaultPort: finite(config.defaultPort),
      sameOriginProxy: text(config.sameOriginProxy),
      pageOrigin: text(pageOrigin),
      versionPolicy: {
        minimum: policy?.minimum === undefined ? absent : { value: [...policy.minimum] },
        maximumMajor: finite(policy?.maximumMajor),
      },
      clientName: text(config.clientName),
      clientVersion: text(config.clientVersion),
      requestTimeoutMs: finite(dependencies.requestTimeoutMs),
      socketOpenTimeoutMs: finite(dependencies.socketOpenTimeoutMs),
      heartbeatIntervalMs: finite(dependencies.heartbeatIntervalMs),
      heartbeatTimeoutMs: finite(dependencies.heartbeatTimeoutMs),
      reconnect: {
        initialDelayMs: finite(dependencies.reconnect?.initialDelayMs),
        maximumDelayMs: finite(dependencies.reconnect?.maximumDelayMs),
        maximumAttempts: finite(dependencies.reconnect?.maximumAttempts),
        jitterRatio: finite(dependencies.reconnect?.jitterRatio),
      },
    });
    const reply = decodeProjectMoonrakerTransportReply(core.MoonrakerTransport.configure(wireConfig));
    if ('refused' in reply) throw transportError(reply.refused);
    const endpoint = decodeProjectMoonrakerEndpointReply(
      core.moonraker_endpoint(
        encodeProjectMoonrakerEndpointRequest({
          input: units(config.endpoint),
          defaultPort: finite(config.defaultPort),
          sameOriginProxy: text(config.sameOriginProxy),
          pageOrigin: text(pageOrigin),
        }),
      ),
    );
    if ('refused' in endpoint) throw transportError(endpoint.refused);
    this.endpoint = Object.freeze({
      directHttpUrl: fromUnits(endpoint.endpoint.directHttpUrl),
      transportHttpUrl: fromUnits(endpoint.endpoint.transportHttpUrl),
      webSocketUrl: fromUnits(endpoint.endpoint.webSocketUrl),
      usesSameOriginProxy: endpoint.endpoint.usesSameOriginProxy,
    });
    this.machine = new core.MoonrakerTransport(wireConfig);
    this.textBound = core.MoonrakerTransport.max_text_units();
    this.current = connectionState(reply.state);
    this.fetcher = dependencies.fetch ?? fetchLocalNetwork;
    this.socketFactory = dependencies.socketFactory ?? defaultSocketFactory;
    this.scheduler = dependencies.scheduler ?? defaultScheduler();
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.logger = dependencies.logger;
  }

  get state(): MoonrakerConnectionState {
    return this.current;
  }

  get credentialMetadata(): MoonrakerCredentialMetadata {
    return Object.freeze({ hasApiKey: this.machine.has_api_key(), hasBearerToken: this.machine.has_bearer_token() });
  }

  setSessionCredentials(credentials: MoonrakerSessionCredentials): void {
    const refused = decodeProjectOptionalMoonrakerTransportFault(
      this.machine.set_credentials(
        encodeProjectMoonrakerCredentials({
          apiKey: text(credentials.apiKey),
          bearerToken: text(credentials.bearerToken),
        }),
        this.now(),
      ),
    );
    if ('value' in refused) throw transportError(refused.value);
  }

  clearSessionCredentials(): void {
    this.machine.clear_credentials(this.now());
  }

  subscribeState(listener: MoonrakerStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.current);
    return () => this.stateListeners.delete(listener);
  }

  subscribeNotifications(listener: MoonrakerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  setObjectSubscription(subscription: MoonrakerObjectSubscription | null): void {
    if (subscription === null) {
      this.enqueue(this.machine.clear_subscription(this.now()));
      return;
    }
    // Entries an object would hold: own keys, in their order, `__proto__`
    // included. Fields that are not a list read as an empty field name, which
    // the core refuses as the browser refuses the list.
    const entries = Object.entries(subscription).map(([name, fields]) => ({
      name: units(name),
      fields:
        fields === null
          ? absent
          : { value: (Array.isArray(fields) ? (fields as readonly unknown[]) : ['']).map((f) => units(String(f))) },
    }));
    const reply = decodeProjectMoonrakerTransportStepReply(
      this.machine.set_subscription(encodeProjectMoonrakerObjectSubscription(entries), this.now()),
    );
    if ('refused' in reply) throw transportError(reply.refused);
    this.apply(reply.step);
  }

  connect(options: { readonly signal?: AbortSignal } = {}): Promise<MoonrakerHandshake> {
    const signal = options.signal;
    return this.start(
      () => this.machine.connect(signalName(signal), this.now()),
      signal,
    ) as Promise<MoonrakerHandshake>;
  }

  disconnect(reason: Exclude<MoonrakerDisconnectReason, 'initial'> = 'user'): void {
    this.enqueue(this.machine.disconnect(reason, this.now()));
  }

  dispose(): void {
    this.enqueue(this.machine.dispose(this.now()));
  }

  request<T>(path: string, options: MoonrakerRequestOptions = {}): Promise<T> {
    return this.send<T>('request', path, options);
  }

  upload<T>(path: string, body: FormData, options: MoonrakerRequestOptions = {}): Promise<T> {
    return this.send<T>('upload', path, options, body);
  }

  download(path: string, options: MoonrakerRequestOptions = {}): Promise<Uint8Array> {
    return this.send<Uint8Array>('download', path, options);
  }

  requestRecoveryCommand(command: 'emergency-stop' | 'firmware-restart', signal?: AbortSignal): Promise<unknown> {
    const request = encodeProjectMoonrakerRecoveryRequest({
      command: units(String(command)),
      signal: signalName(signal),
    });
    return this.start(() => this.machine.recovery(request, this.now()), signal);
  }

  private send<T>(
    kind: 'request' | 'upload' | 'download',
    path: string,
    options: MoonrakerRequestOptions,
    body?: FormData,
  ): Promise<T> {
    const operation = options.operation ?? kind;
    let request: string;
    try {
      if (kind !== 'upload' && options.body !== undefined && options.body !== null) {
        throw new MoonrakerTransportError('invalid_request', operation);
      }
      request = encodeProjectMoonrakerRequest({ path: units(path), options: requestOptions(options) });
    } catch (error) {
      return Promise.reject(
        error instanceof MoonrakerTransportError ? error : new MoonrakerTransportError('invalid_request', operation),
      );
    }
    const call =
      kind === 'request'
        ? () => this.machine.request(request, this.now())
        : kind === 'upload'
          ? () => this.machine.upload(request, this.now())
          : () => this.machine.download(request, this.now());
    return this.start(call, options.signal, body) as Promise<T>;
  }

  /** A call that starts a task: its promise settles when the task finishes. */
  private start(call: () => string, signal: AbortSignal | undefined, body?: FormData): Promise<unknown> {
    let step: Step;
    try {
      step = decodeProjectMoonrakerTransportStep(call());
    } catch (error) {
      // As from the browser transport: a call answers with a promise, never a throw.
      return Promise.reject(error);
    }
    if (!('value' in step.task)) {
      this.apply(step);
      return Promise.reject(new MoonrakerTransportError('invalid_state', 'request'));
    }
    const task = step.task.value;
    const settled = new Promise<unknown>((resolve, reject) => {
      let release: (() => void) | undefined;
      if (signal && !signal.aborted) {
        const onAbort = () => this.input(() => this.machine.abort(task, this.now()));
        signal.addEventListener('abort', onAbort, { once: true });
        release = () => signal.removeEventListener('abort', onAbort);
      }
      this.tasks.set(task, { resolve, reject, release });
    });
    // The fetch a request, upload or download issues is in the step that
    // started it; an upload's is the one with a body.
    for (const output of step.outputs) {
      if (!('fetch' in output)) continue;
      const upload = output.fetch.body === 'upload' && body !== undefined;
      this.hints.set(output.fetch.id, upload ? { task, body } : { task });
    }
    this.apply(step);
    return settled;
  }

  /** An event from outside (a fetch, a body, a socket, a timer, an abort). */
  private input(call: () => string): void {
    let json: string;
    try {
      json = call();
    } catch (error) {
      // An answer the core no longer awaits (`not_pending`) changes nothing.
      // Anything else — a trap in the core — must not pass silently.
      if (error === 'not_pending' || error === 'mismatch') return;
      throw error;
    }
    this.enqueue(json);
  }

  private enqueue(json: string): void {
    this.apply(decodeProjectMoonrakerTransportStep(json));
  }

  private apply(step: Step): void {
    this.queue.push(step);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) this.run(next);
    } finally {
      this.draining = false;
    }
  }

  /** One step: effects first (answering a synchronous one at once), then listeners. */
  private run(step: Step): void {
    const notify: (() => void)[] = [];
    let answer: string | undefined;
    for (const output of step.outputs) {
      if ('fetch' in output) this.issue(output.fetch);
      else if ('readBody' in output) this.read(output.readBody.id, output.readBody.fetch, output.readBody.kind);
      else if ('openSocket' in output) answer = this.openSocket(output.openSocket.id, fromUnits(output.openSocket.url));
      else if ('random' in output) answer = this.outcome(output.random.id, { random: this.random() });
      else if ('socketSend' in output) this.socketSend(output.socketSend.socket, fromUnits(output.socketSend.text));
      else if ('socketClose' in output)
        this.socketClose(output.socketClose.socket, output.socketClose.code, fromUnits(output.socketClose.reason));
      else if ('setTimer' in output) this.setTimer(output.setTimer.timer, output.setTimer.delayMs);
      else if ('state' in output) {
        const state = connectionState(output.state);
        notify.push(() => this.transition(state));
      } else {
        const { id, method, receivedAtMs, generation, socketEpoch } = output.notification;
        const notification: MoonrakerNotification = Object.freeze({
          method: fromUnits(method),
          params: freeze(JSON.parse(this.machine.take_params(id))),
          receivedAtMs,
          generation,
          socketEpoch,
        });
        notify.push(() => this.notify(notification));
      }
    }
    for (const timer of step.cleared) {
      if (this.timers.has(timer)) this.scheduler.clearTimeout(this.timers.get(timer));
      this.timers.delete(timer);
    }
    for (const id of step.aborted) this.abandon(id);
    // The core answered the synchronous effect before any listener could reach
    // it; its step runs in the order the core produced it, like every other.
    if (answer !== undefined) this.queue.push(decodeProjectMoonrakerTransportStep(answer));
    for (const run of notify) run();
    for (const log of step.logs) this.log(diagnosticEvent(log));
    for (const { task, result } of step.finished) this.finish(task, result);
  }

  private finish(task: number, result: Step['finished'][number]['result']): void {
    const pending = this.tasks.get(task);
    this.tasks.delete(task);
    const bytes = this.downloads.get(task);
    this.downloads.delete(task);
    for (const [id, entry] of this.fetches) if (entry.task === task) this.fetches.delete(id);
    if (!pending) return;
    pending.release?.();
    if ('handshake' in result) pending.resolve(handshake(result.handshake));
    else if ('result' in result) pending.resolve(JSON.parse(this.machine.take_result(task)));
    else if ('bytes' in result) pending.resolve(bytes ?? new Uint8Array(0));
    else pending.reject(transportError(result.refused));
  }

  private outcome(id: number, outcome: ProjectMoonrakerTransportOutcomeWire): string {
    return this.machine.resolve(id, encodeProjectMoonrakerTransportOutcome(outcome), this.now());
  }

  private issue(fetch: FetchWire): void {
    const hint = this.hints.get(fetch.id);
    this.hints.delete(fetch.id);
    const task = hint?.task;
    const body = hint?.body;
    const controller = new AbortController();
    const entry: Fetch = { controller, ...(task === undefined ? {} : { task }) };
    this.fetches.set(fetch.id, entry);
    const headers = new Headers(
      fetch.headers.map(({ name, value }): [string, string] => [fromUnits(name), fromUnits(value)]),
    );
    const init: RequestInit = {
      method: fromUnits(fetch.method),
      headers,
      signal: controller.signal,
      redirect: 'error',
      credentials: fetch.credentials === 'sameOrigin' ? 'same-origin' : 'omit',
      ...(body === undefined ? {} : { body }),
    };
    let started: Promise<Response>;
    try {
      started = this.fetcher(fromUnits(fetch.url), init);
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (response) => {
        if (entry.abandoned) return;
        entry.response = response;
        const contentLength = response.headers.get('content-length');
        this.input(() =>
          this.outcome(fetch.id, {
            headers: { status: response.status, contentLength: text(contentLength ?? undefined) },
          }),
        );
      },
      () => {
        if (!entry.abandoned) this.input(() => this.outcome(fetch.id, { failed: {} }));
      },
    );
  }

  private read(id: number, fetchId: number, kind: 'text' | 'bytes'): void {
    const entry = this.fetches.get(fetchId);
    this.reads.set(id, fetchId);
    const done = (answer: () => string) => {
      if (!this.reads.has(id)) return;
      this.reads.delete(id);
      this.input(answer);
    };
    const response = entry?.response;
    if (!response) {
      done(() => this.outcome(id, { failed: {} }));
      return;
    }
    if (kind === 'text') {
      response.text().then(
        (body) =>
          done(() =>
            this.machine.resolve_text(
              id,
              body.length > this.textBound ? body.slice(0, this.textBound + 1) : body,
              this.now(),
            ),
          ),
        () => done(() => this.outcome(id, { failed: {} })),
      );
    } else {
      response.arrayBuffer().then(
        (buffer) =>
          done(() => {
            if (entry.task !== undefined) this.downloads.set(entry.task, new Uint8Array(buffer));
            return this.outcome(id, { bytes: buffer.byteLength });
          }),
        () => done(() => this.outcome(id, { failed: {} })),
      );
    }
  }

  /** The core gave up on effect `id`: stop it and never answer it. */
  private abandon(id: number): void {
    const fetch = this.fetches.get(id);
    if (fetch) {
      fetch.abandoned = true;
      fetch.controller.abort();
      return;
    }
    const read = this.reads.get(id);
    if (read !== undefined) {
      this.reads.delete(id);
      this.fetches.get(read)?.controller.abort();
    }
  }

  private openSocket(id: number, url: string): string {
    let socket: MoonrakerSocket;
    try {
      socket = this.socketFactory(url);
    } catch (error) {
      const unavailable = error instanceof MoonrakerTransportError && error.code === 'websocket_unavailable';
      return this.outcome(id, unavailable ? { unavailable: {} } : { broken: {} });
    }
    this.sockets.set(id, socket);
    socket.onopen = () => this.input(() => this.machine.socket_open(id, this.now()));
    socket.onerror = () => this.input(() => this.machine.socket_error(id, this.now()));
    socket.onclose = () => {
      this.retire(id);
      this.input(() => this.machine.socket_close(id, this.now()));
    };
    socket.onmessage = (event) => {
      const data: unknown = event.data;
      // A frame that is not text reads as one that is not JSON: a protocol warning.
      const frame = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : '';
      const bounded = frame.length > this.textBound ? frame.slice(0, this.textBound + 1) : frame;
      this.input(() => this.machine.socket_message(id, bounded, this.now()));
    };
    return this.outcome(id, { created: {} });
  }

  private socketSend(id: number, frame: string): void {
    const socket = this.sockets.get(id);
    try {
      if (!socket || socket.readyState !== 1) throw new Error('not open');
      socket.send(frame);
    } catch {
      // A socket that cannot send is lost; the core hears it after this step.
      queueMicrotask(() => this.input(() => this.machine.socket_error(id, this.now())));
    }
  }

  private socketClose(id: number, code: number, reason: string): void {
    const socket = this.sockets.get(id);
    this.retire(id);
    if (!socket || socket.readyState >= 2) return;
    try {
      socket.close(code, reason);
    } catch {
      // The socket is already unusable; nothing escapes.
    }
  }

  private retire(id: number): void {
    const socket = this.sockets.get(id);
    if (!socket) return;
    this.sockets.delete(id);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private setTimer(timer: number, delayMs: number): void {
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(timer);
      this.input(() => this.machine.timer(timer, this.now()));
    }, delayMs);
    this.timers.set(timer, handle);
  }

  private transition(state: MoonrakerConnectionState): void {
    this.current = state;
    if (state.status === 'disconnected' || state.status === 'error') {
      // Responses of a session that ended are never read.
      for (const [id, entry] of this.fetches) if (entry.task === undefined && entry.response) this.fetches.delete(id);
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // A view listener must not corrupt the transport.
      }
    }
  }

  private notify(notification: MoonrakerNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        this.log(
          Object.freeze({
            timestampMs: this.now(),
            level: 'warn',
            event: 'protocol_warning',
            state: this.current.status,
            generation: this.current.generation,
          }),
        );
      }
    }
  }

  private log(event: MoonrakerDiagnosticEvent): void {
    if (!this.logger) return;
    try {
      this.logger(event);
    } catch {
      // Diagnostics are observational only.
    }
  }
}

type FetchWire = Extract<Step['outputs'][number], { readonly fetch: unknown }>['fetch'];

function signalName(signal: AbortSignal | undefined): ProjectMoonrakerSignalWire {
  return signal === undefined ? 'none' : signal.aborted ? 'aborted' : 'live';
}

function requestOptions(options: MoonrakerRequestOptions): ProjectMoonrakerRequestOptionsWire {
  const deadline = options.timeoutMs;
  return {
    method: text(options.method),
    operation: text(options.operation),
    // A deadline that is not a finite number is refused as one out of range.
    timeoutMs:
      deadline === undefined
        ? { default: {} }
        : deadline === null
          ? { unbounded: {} }
          : { ms: Number.isFinite(deadline) ? deadline : -1 },
    headers: Object.entries(options.headers ?? {}).map(([name, value]) => ({ name: units(name), value: units(value) })),
    acceptBareEnvelope: options.acceptBareEnvelope ?? false,
    signal: signalName(options.signal),
  };
}

/** Reads a connection state the core reports, for hosts that hold its text. */
export function decodeMoonrakerConnectionState(text: string): MoonrakerConnectionState {
  return connectionState(decodeProjectMoonrakerConnectionState(text));
}
