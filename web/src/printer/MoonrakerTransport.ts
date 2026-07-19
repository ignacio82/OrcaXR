import { fetchLocalNetwork } from '../net/LocalNetworkAccess';
import { joinMoonrakerEndpointPath, normalizeMoonrakerEndpoint } from './MoonrakerEndpoint';
import { MoonrakerSessionCredentialStore } from './SessionCredentials';
import {
  MoonrakerTransportError,
  safeOperationName,
  type MoonrakerApiVersion,
  type MoonrakerCapabilityManifest,
  type MoonrakerConnectionState,
  type MoonrakerCredentialMetadata,
  type MoonrakerDiagnosticEvent,
  type MoonrakerDiagnosticEventName,
  type MoonrakerDisconnectReason,
  type MoonrakerHandshake,
  type MoonrakerNotification,
  type MoonrakerPrinterHandshake,
  type MoonrakerServerHandshake,
  type MoonrakerSessionCredentials,
  type MoonrakerVersionPolicy,
  type NormalizedMoonrakerEndpoint,
} from './MoonrakerTypes';

const DEFAULT_VERSION_POLICY: MoonrakerVersionPolicy = Object.freeze({
  minimum: Object.freeze([1, 0, 0] as const),
  maximumMajor: 1,
});
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_MESSAGE_CHARS = 1024 * 1024;
const KNOWN_COMPONENTS = new Set([
  'announcements',
  'authorization',
  'database',
  'file_manager',
  'history',
  'job_queue',
  'klippy_apis',
  'machine',
  'power',
  'proc_stats',
  'secrets',
  'shell_command',
  'template',
  'update_manager',
  'webcam',
]);

export interface MoonrakerSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface MoonrakerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MoonrakerReconnectPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
  readonly jitterRatio: number;
}

export interface MoonrakerTransportConfig {
  readonly endpoint: string;
  readonly defaultPort?: number;
  readonly sameOriginProxy?: string;
  readonly pageOrigin?: string;
  readonly versionPolicy?: Partial<MoonrakerVersionPolicy>;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface MoonrakerTransportDependencies {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly socketFactory?: (url: string) => MoonrakerSocket;
  readonly scheduler?: MoonrakerScheduler;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly requestTimeoutMs?: number;
  readonly socketOpenTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnect?: Partial<MoonrakerReconnectPolicy>;
  readonly logger?: (event: MoonrakerDiagnosticEvent) => void;
}

export interface MoonrakerRequestOptions extends Omit<RequestInit, 'signal' | 'headers' | 'redirect' | 'credentials'> {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly operation?: string;
}

export type MoonrakerObjectSubscription = Readonly<Record<string, readonly string[] | null>>;
export type MoonrakerStateListener = (state: MoonrakerConnectionState) => void;
export type MoonrakerNotificationListener = (notification: MoonrakerNotification) => void;

export const DEFAULT_MOONRAKER_RECONNECT_POLICY: MoonrakerReconnectPolicy = Object.freeze({
  initialDelayMs: 500,
  maximumDelayMs: 30_000,
  maximumAttempts: 6,
  jitterRatio: 0.2,
});

export function calculateMoonrakerReconnectDelay(
  attempt: number,
  policy: MoonrakerReconnectPolicy = DEFAULT_MOONRAKER_RECONNECT_POLICY,
  randomValue = Math.random(),
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(30, safeAttempt - 1);
  const base = Math.min(policy.maximumDelayMs, policy.initialDelayMs * 2 ** exponent);
  const random = Math.min(1, Math.max(0, randomValue));
  const jittered = base + base * policy.jitterRatio * (random * 2 - 1);
  return Math.round(Math.min(policy.maximumDelayMs, Math.max(0, jittered)));
}

export class MoonrakerTransport {
  readonly endpoint: NormalizedMoonrakerEndpoint;

  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly socketFactory: (url: string) => MoonrakerSocket;
  private readonly scheduler: MoonrakerScheduler;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly socketOpenTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectPolicy: MoonrakerReconnectPolicy;
  private readonly versionPolicy: MoonrakerVersionPolicy;
  private readonly logger?: (event: MoonrakerDiagnosticEvent) => void;
  private readonly credentials = new MoonrakerSessionCredentialStore();
  private readonly stateListeners = new Set<MoonrakerStateListener>();
  private readonly notificationListeners = new Set<MoonrakerNotificationListener>();
  private readonly activeRequestControllers = new Set<AbortController>();
  private readonly clientName: string;
  private readonly clientVersion: string;

  private stateValue: MoonrakerConnectionState = Object.freeze({
    status: 'disconnected',
    generation: 0,
    reason: 'initial',
  });
  private generation = 0;
  private socketEpoch = 0;
  private desiredConnected = false;
  private disposed = false;
  private sessionController: AbortController | null = null;
  private connectPromise: Promise<MoonrakerHandshake> | null = null;
  private socket: MoonrakerSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private heartbeatTimeoutTimer: unknown = null;
  private heartbeatRequestId: string | null = null;
  private rpcSequence = 0;
  private objectSubscription: MoonrakerObjectSubscription | null = null;

  constructor(config: MoonrakerTransportConfig, dependencies: MoonrakerTransportDependencies = {}) {
    this.endpoint = normalizeMoonrakerEndpoint(config.endpoint, {
      defaultPort: config.defaultPort,
      sameOriginProxy: config.sameOriginProxy,
      pageOrigin: config.pageOrigin,
    });
    this.fetcher = dependencies.fetch ?? fetchLocalNetwork;
    this.socketFactory = dependencies.socketFactory ?? defaultSocketFactory;
    this.scheduler = dependencies.scheduler ?? defaultScheduler();
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.requestTimeoutMs = positiveDuration(dependencies.requestTimeoutMs, 10_000);
    this.socketOpenTimeoutMs = positiveDuration(dependencies.socketOpenTimeoutMs, 8_000);
    this.heartbeatIntervalMs = positiveDuration(dependencies.heartbeatIntervalMs, 15_000);
    this.heartbeatTimeoutMs = positiveDuration(dependencies.heartbeatTimeoutMs, 5_000);
    this.reconnectPolicy = normalizeReconnectPolicy(dependencies.reconnect);
    this.versionPolicy = normalizeVersionPolicy(config.versionPolicy);
    this.logger = dependencies.logger;
    this.clientName = safeClientField(config.clientName ?? 'OrcaXR', 'OrcaXR');
    this.clientVersion = safeClientField(config.clientVersion ?? '0.1.0', '0.1.0');
  }

  get state(): MoonrakerConnectionState {
    return this.stateValue;
  }

  get credentialMetadata(): MoonrakerCredentialMetadata {
    return this.credentials.metadata();
  }

  setSessionCredentials(credentials: MoonrakerSessionCredentials): void {
    this.credentials.set(credentials);
  }

  clearSessionCredentials(): void {
    this.credentials.clear();
  }

  subscribeState(listener: MoonrakerStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.stateValue);
    return () => this.stateListeners.delete(listener);
  }

  subscribeNotifications(listener: MoonrakerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  setObjectSubscription(subscription: MoonrakerObjectSubscription | null): void {
    this.objectSubscription = subscription === null ? null : cloneObjectSubscription(subscription);
    if (this.stateValue.status !== 'connected' || !this.socket) return;
    try {
      this.sendObjectSubscription(this.socket);
    } catch {
      const error = new MoonrakerTransportError('websocket_failed', 'object_subscription');
      this.handleSocketLoss(this.generation, this.socketEpoch, this.socket, error);
    }
  }

  async connect(options: { readonly signal?: AbortSignal } = {}): Promise<MoonrakerHandshake> {
    if (this.disposed) throw new MoonrakerTransportError('invalid_state', 'connect');
    if (this.stateValue.status === 'connected') return this.stateValue.handshake;
    if (this.connectPromise) return this.connectPromise;
    if (options.signal?.aborted) throw new MoonrakerTransportError('cancelled', 'connect');

    this.prepareNewSession();
    const session = this.generation;
    this.desiredConnected = true;
    this.sessionController = new AbortController();
    this.transition(Object.freeze({ status: 'connecting', generation: session, attempt: 0 }));
    this.log('connection_attempt', 'info');

    const onExternalAbort = () => {
      if (this.generation === session) this.disconnect('cancelled');
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const pending = this.establishConnection(session, false);
    this.connectPromise = pending;
    try {
      return await pending;
    } catch (error) {
      const normalized = asTransportError(error, 'connect');
      if (this.generation !== session || normalized.code === 'cancelled') {
        throw new MoonrakerTransportError('cancelled', 'connect');
      }
      this.desiredConnected = false;
      this.teardownConnectionResources(true);
      this.transition(Object.freeze({ status: 'error', generation: session, error: normalized.toDiagnostic() }));
      throw normalized;
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
      if (this.connectPromise === pending) this.connectPromise = null;
    }
  }

  disconnect(reason: Exclude<MoonrakerDisconnectReason, 'initial'> = 'user'): void {
    if (this.stateValue.status === 'disconnected' && !this.desiredConnected && this.stateValue.reason === reason) {
      return;
    }
    this.generation += 1;
    this.desiredConnected = false;
    this.connectPromise = null;
    this.teardownConnectionResources(true);
    this.transition(Object.freeze({ status: 'disconnected', generation: this.generation, reason }));
    this.log('disconnected', 'info');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disconnect('disposed');
    this.credentials.clear();
    this.stateListeners.clear();
    this.notificationListeners.clear();
    this.objectSubscription = null;
    this.disposed = true;
  }

  async request<T>(path: string, options: MoonrakerRequestOptions = {}): Promise<T> {
    if (this.stateValue.status !== 'connected') {
      throw new MoonrakerTransportError('invalid_state', options.operation ?? 'request');
    }
    if (options.signal?.aborted) {
      throw new MoonrakerTransportError('cancelled', options.operation ?? 'request');
    }
    const generation = this.generation;
    const socketEpoch = this.socketEpoch;
    const operation = safeOperationName(options.operation ?? 'request');
    const result = await this.fetchResult<T>(generation, path, options, operation);
    if (this.stateValue.status !== 'connected' || this.generation !== generation || this.socketEpoch !== socketEpoch) {
      throw new MoonrakerTransportError('cancelled', operation);
    }
    return result;
  }

  private prepareNewSession(): void {
    this.desiredConnected = false;
    this.generation += 1;
    this.teardownConnectionResources(true);
    this.reconnectAttempt = 0;
  }

  private async establishConnection(session: number, reconnecting: boolean): Promise<MoonrakerHandshake> {
    this.assertCurrentSession(session, reconnecting ? 'reconnect' : 'connect');
    const handshake = await this.performHandshake(session);
    this.assertCurrentSession(session, reconnecting ? 'reconnect' : 'connect');
    const { socket, epoch } = await this.openSocket(session);
    this.assertCurrentSession(session, reconnecting ? 'reconnect' : 'connect');
    if (this.socket !== socket || this.socketEpoch !== epoch) {
      throw new MoonrakerTransportError('cancelled', reconnecting ? 'reconnect' : 'connect');
    }

    try {
      this.sendIdentify(socket);
      this.sendObjectSubscription(socket);
    } catch {
      this.teardownSocket(true);
      throw new MoonrakerTransportError('websocket_failed', reconnecting ? 'reconnect' : 'connect');
    }

    const connectedAtMs = this.now();
    this.reconnectAttempt = 0;
    this.transition(
      Object.freeze({
        status: 'connected',
        generation: session,
        socketEpoch: epoch,
        connectedAtMs,
        lastHeartbeatAtMs: connectedAtMs,
        handshake,
      }),
    );
    this.scheduleHeartbeat(session, epoch);
    this.log('connected', 'info');
    return handshake;
  }

  private async performHandshake(session: number): Promise<MoonrakerHandshake> {
    const [serverResult, printerResult] = await Promise.all([
      this.fetchResult<unknown>(session, '/server/info', {}, 'handshake_server'),
      this.fetchResult<unknown>(session, '/printer/info', {}, 'handshake_printer'),
    ]);
    const server = parseServerHandshake(serverResult);
    assertSupportedVersion(server.apiVersion, this.versionPolicy);
    const printer = parsePrinterHandshake(printerResult);
    const capabilities = buildCapabilityManifest(server.components, server, printer);
    return Object.freeze({ server, printer, capabilities });
  }

  private async fetchResult<T>(
    session: number,
    path: string,
    options: MoonrakerRequestOptions,
    operation: string,
  ): Promise<T> {
    this.assertCurrentSession(session, operation);
    const url = joinMoonrakerEndpointPath(this.endpoint.transportHttpUrl, path);
    const requestUrl = new URL(url);
    const credentialsInUrl = [...requestUrl.searchParams.values()].some((value) => this.credentials.matches(value));
    if (credentialsInUrl) throw new MoonrakerTransportError('invalid_endpoint', operation);
    const controller = new AbortController();
    this.activeRequestControllers.add(controller);
    let timedOut = false;
    const timeout = this.scheduler.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const abort = () => controller.abort();
    this.sessionController?.signal.addEventListener('abort', abort, { once: true });
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      const headers = new Headers(options.headers);
      if (headers.has('Authorization') || headers.has('X-Api-Key')) {
        throw new MoonrakerTransportError('invalid_credentials', operation);
      }
      if (!headers.has('Accept')) headers.set('Accept', 'application/json');
      for (const [key, value] of Object.entries(this.credentials.requestHeaders())) headers.set(key, value);

      const {
        signal: _ignoredSignal,
        headers: _ignoredHeaders,
        operation: _ignoredOperation,
        ...requestInit
      } = options;
      const response = await this.fetcher(url, {
        ...requestInit,
        headers,
        signal: controller.signal,
        redirect: 'error',
        credentials: this.endpoint.usesSameOriginProxy ? 'same-origin' : 'omit',
      });
      if (!response.ok) throw httpStatusError(response.status, operation);
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
        throw new MoonrakerTransportError('invalid_response', operation);
      }
      const text = await response.text();
      if (text.length > MAX_JSON_RESPONSE_BYTES) throw new MoonrakerTransportError('invalid_response', operation);
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new MoonrakerTransportError('invalid_response', operation);
      }
      if (!isRecord(envelope)) throw new MoonrakerTransportError('invalid_response', operation);
      if ('error' in envelope) throw new MoonrakerTransportError('protocol_error', operation);
      if (!('result' in envelope)) throw new MoonrakerTransportError('invalid_response', operation);
      return envelope.result as T;
    } catch (error) {
      const normalized =
        error instanceof MoonrakerTransportError
          ? error
          : controller.signal.aborted
            ? new MoonrakerTransportError(timedOut ? 'timeout' : 'cancelled', operation)
            : new MoonrakerTransportError('network', operation);
      this.log('request_failed', normalized.recoverable ? 'warn' : 'error', normalized);
      throw normalized;
    } finally {
      this.scheduler.clearTimeout(timeout);
      this.sessionController?.signal.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', abort);
      this.activeRequestControllers.delete(controller);
    }
  }

  private async openSocket(session: number): Promise<{ socket: MoonrakerSocket; epoch: number }> {
    let socket: MoonrakerSocket;
    try {
      socket = this.socketFactory(this.endpoint.webSocketUrl);
    } catch (error) {
      if (error instanceof MoonrakerTransportError) throw error;
      throw new MoonrakerTransportError('websocket_failed', 'open_websocket');
    }
    const epoch = ++this.socketEpoch;
    this.socket = socket;
    const signal = this.sessionController?.signal;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: MoonrakerTransportError) => {
          if (settled) return;
          settled = true;
          this.scheduler.clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(new MoonrakerTransportError('cancelled', 'open_websocket'));
        const timeout = this.scheduler.setTimeout(
          () => finish(new MoonrakerTransportError('timeout', 'open_websocket')),
          this.socketOpenTimeoutMs,
        );
        socket.onopen = () => finish();
        socket.onerror = () => finish(new MoonrakerTransportError('websocket_failed', 'open_websocket'));
        socket.onclose = () => finish(new MoonrakerTransportError('websocket_failed', 'open_websocket'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } catch (error) {
      if (this.socket === socket) this.teardownSocket(true);
      throw error;
    }

    this.assertCurrentSession(session, 'open_websocket');
    if (this.socket !== socket || this.socketEpoch !== epoch) {
      throw new MoonrakerTransportError('cancelled', 'open_websocket');
    }
    socket.onmessage = (event) => this.handleSocketMessage(session, epoch, socket, event.data);
    socket.onerror = () => {
      this.handleSocketLoss(session, epoch, socket, new MoonrakerTransportError('websocket_failed', 'websocket_event'));
    };
    socket.onclose = () => {
      this.handleSocketLoss(session, epoch, socket, new MoonrakerTransportError('websocket_failed', 'websocket_close'));
    };
    return { socket, epoch };
  }

  private sendIdentify(socket: MoonrakerSocket): void {
    this.sendSocketJson(socket, {
      jsonrpc: '2.0',
      method: 'server.connection.identify',
      params: {
        client_name: this.clientName,
        version: this.clientVersion,
        type: 'web',
      },
    });
  }

  private sendObjectSubscription(socket: MoonrakerSocket): void {
    if (!this.objectSubscription) return;
    this.sendSocketJson(socket, {
      jsonrpc: '2.0',
      method: 'printer.objects.subscribe',
      params: { objects: this.objectSubscription },
      id: ++this.rpcSequence,
    });
  }

  private sendSocketJson(socket: MoonrakerSocket, value: unknown): void {
    if (socket.readyState !== 1) throw new MoonrakerTransportError('websocket_failed', 'websocket_send');
    socket.send(JSON.stringify(value));
  }

  private handleSocketMessage(session: number, epoch: number, socket: MoonrakerSocket, data: unknown): void {
    if (!this.isCurrentSocket(session, epoch, socket)) return;
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else {
      this.log('protocol_warning', 'warn');
      return;
    }
    if (text.length > MAX_SOCKET_MESSAGE_CHARS) {
      this.log('protocol_warning', 'warn');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.log('protocol_warning', 'warn');
      return;
    }
    if (!isRecord(message)) {
      this.log('protocol_warning', 'warn');
      return;
    }

    if (this.heartbeatRequestId !== null && message.id === this.heartbeatRequestId) {
      if ('error' in message) {
        this.handleSocketLoss(
          session,
          epoch,
          socket,
          new MoonrakerTransportError('websocket_failed', 'heartbeat_response'),
        );
        return;
      }
      this.heartbeatRequestId = null;
      if (this.heartbeatTimeoutTimer !== null) this.scheduler.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
      if (this.stateValue.status === 'connected') {
        this.transition(Object.freeze({ ...this.stateValue, lastHeartbeatAtMs: this.now() }));
      }
      this.scheduleHeartbeat(session, epoch);
      return;
    }

    if (typeof message.method !== 'string' || !/^[a-z0-9_.-]{1,128}$/i.test(message.method)) return;
    if (!freezeProtocolValue(message.params)) {
      this.log('protocol_warning', 'warn');
      return;
    }
    const notification: MoonrakerNotification = Object.freeze({
      method: message.method,
      params: message.params,
      receivedAtMs: this.now(),
      generation: session,
      socketEpoch: epoch,
    });
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        this.log('protocol_warning', 'warn');
      }
    }
  }

  private scheduleHeartbeat(session: number, epoch: number): void {
    this.clearHeartbeatTimers();
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = null;
      this.sendHeartbeat(session, epoch);
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeat(session: number, epoch: number): void {
    const socket = this.socket;
    if (!socket || !this.isCurrentSocket(session, epoch, socket) || this.stateValue.status !== 'connected') return;
    const id = `orcaxr-heartbeat-${session}-${epoch}-${++this.rpcSequence}`;
    this.heartbeatRequestId = id;
    try {
      this.sendSocketJson(socket, { jsonrpc: '2.0', method: 'server.info', id });
    } catch {
      this.handleSocketLoss(session, epoch, socket, new MoonrakerTransportError('websocket_failed', 'heartbeat_send'));
      return;
    }
    this.heartbeatTimeoutTimer = this.scheduler.setTimeout(() => {
      if (!this.isCurrentSocket(session, epoch, socket) || this.heartbeatRequestId !== id) return;
      const error = new MoonrakerTransportError('heartbeat_timeout', 'heartbeat');
      this.log('heartbeat_timeout', 'warn', error);
      this.handleSocketLoss(session, epoch, socket, error);
    }, this.heartbeatTimeoutMs);
  }

  private handleSocketLoss(
    session: number,
    epoch: number,
    socket: MoonrakerSocket,
    error: MoonrakerTransportError,
  ): void {
    if (!this.isCurrentSocket(session, epoch, socket)) return;
    this.teardownSocket(true);
    this.abortActiveRequests();
    if (!this.desiredConnected || this.generation !== session) return;
    this.scheduleReconnect(session, error);
  }

  private scheduleReconnect(session: number, lastError: MoonrakerTransportError): void {
    if (!this.desiredConnected || this.generation !== session) return;
    if (this.reconnectTimer !== null) this.scheduler.clearTimeout(this.reconnectTimer);
    const attempt = this.reconnectAttempt + 1;
    if (attempt > this.reconnectPolicy.maximumAttempts) {
      this.desiredConnected = false;
      const exhausted = new MoonrakerTransportError('reconnect_exhausted', 'reconnect');
      this.transition(Object.freeze({ status: 'error', generation: session, error: exhausted.toDiagnostic() }));
      return;
    }
    this.reconnectAttempt = attempt;
    const delayMs = calculateMoonrakerReconnectDelay(attempt, this.reconnectPolicy, this.random());
    this.transition(
      Object.freeze({
        status: 'reconnecting',
        generation: session,
        attempt,
        delayMs,
        lastError: lastError.toDiagnostic(),
      }),
    );
    this.log('reconnect_scheduled', 'warn', lastError, attempt);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      void this.runReconnect(session);
    }, delayMs);
  }

  private async runReconnect(session: number): Promise<void> {
    if (!this.desiredConnected || this.generation !== session) return;
    this.log('connection_attempt', 'info', undefined, this.reconnectAttempt);
    try {
      await this.establishConnection(session, true);
    } catch (error) {
      const normalized = asTransportError(error, 'reconnect');
      if (!this.desiredConnected || this.generation !== session || normalized.code === 'cancelled') return;
      if (!normalized.recoverable) {
        this.desiredConnected = false;
        this.transition(Object.freeze({ status: 'error', generation: session, error: normalized.toDiagnostic() }));
        return;
      }
      this.scheduleReconnect(session, normalized);
    }
  }

  private teardownConnectionResources(closeSocket: boolean): void {
    if (this.reconnectTimer !== null) this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.sessionController?.abort();
    this.sessionController = null;
    this.abortActiveRequests();
    this.teardownSocket(closeSocket);
  }

  private teardownSocket(closeSocket: boolean): void {
    this.clearHeartbeatTimers();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (closeSocket && socket.readyState < 2) {
      try {
        socket.close(1000, 'client disconnect');
      } catch {
        // The socket is already unusable; no raw browser error escapes.
      }
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer !== null) this.scheduler.clearTimeout(this.heartbeatTimer);
    if (this.heartbeatTimeoutTimer !== null) this.scheduler.clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
    this.heartbeatRequestId = null;
  }

  private abortActiveRequests(): void {
    for (const controller of this.activeRequestControllers) controller.abort();
  }

  private isCurrentSocket(session: number, epoch: number, socket: MoonrakerSocket): boolean {
    return this.generation === session && this.socketEpoch === epoch && this.socket === socket;
  }

  private assertCurrentSession(session: number, operation: string): void {
    if (
      this.generation !== session ||
      !this.desiredConnected ||
      this.sessionController === null ||
      this.sessionController.signal.aborted
    ) {
      throw new MoonrakerTransportError('cancelled', operation);
    }
  }

  private transition(state: MoonrakerConnectionState): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // A view listener must not corrupt the transport state machine.
      }
    }
  }

  private log(
    event: MoonrakerDiagnosticEventName,
    level: MoonrakerDiagnosticEvent['level'],
    error?: MoonrakerTransportError,
    attempt?: number,
  ): void {
    if (!this.logger) return;
    const record: MoonrakerDiagnosticEvent = Object.freeze({
      timestampMs: this.now(),
      level,
      event,
      state: this.stateValue.status,
      generation: this.generation,
      ...(attempt === undefined ? {} : { attempt }),
      ...(error === undefined ? {} : { error: error.toDiagnostic() }),
    });
    try {
      this.logger(record);
    } catch {
      // Diagnostics are observational only.
    }
  }
}

function defaultSocketFactory(url: string): MoonrakerSocket {
  if (typeof WebSocket === 'undefined') {
    throw new MoonrakerTransportError('websocket_unavailable', 'open_websocket');
  }
  return new WebSocket(url) as unknown as MoonrakerSocket;
}

function defaultScheduler(): MoonrakerScheduler {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 300_000) {
    throw new MoonrakerTransportError('invalid_state', 'configure_transport');
  }
  return Math.floor(value);
}

function normalizeReconnectPolicy(input: Partial<MoonrakerReconnectPolicy> | undefined): MoonrakerReconnectPolicy {
  const policy = {
    ...DEFAULT_MOONRAKER_RECONNECT_POLICY,
    ...input,
  };
  if (
    !Number.isFinite(policy.initialDelayMs) ||
    policy.initialDelayMs < 0 ||
    !Number.isFinite(policy.maximumDelayMs) ||
    policy.maximumDelayMs < policy.initialDelayMs ||
    !Number.isInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 0 ||
    policy.maximumAttempts > 32 ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new MoonrakerTransportError('invalid_state', 'configure_transport');
  }
  return Object.freeze({ ...policy });
}

function normalizeVersionPolicy(input: Partial<MoonrakerVersionPolicy> | undefined): MoonrakerVersionPolicy {
  const minimum = input?.minimum ?? DEFAULT_VERSION_POLICY.minimum;
  const maximumMajor = input?.maximumMajor ?? DEFAULT_VERSION_POLICY.maximumMajor;
  if (!isApiVersion(minimum) || !Number.isInteger(maximumMajor) || maximumMajor < minimum[0]) {
    throw new MoonrakerTransportError('invalid_state', 'configure_transport');
  }
  return Object.freeze({ minimum: Object.freeze([...minimum] as MoonrakerApiVersion), maximumMajor });
}

function parseServerHandshake(value: unknown): MoonrakerServerHandshake {
  if (!isRecord(value)) throw new MoonrakerTransportError('invalid_response', 'handshake_server');
  const apiVersion = parseApiVersion(value.api_version ?? value.api_version_string);
  const components = parseComponents(value.components);
  const rawWarnings = Array.isArray(value.warnings) ? value.warnings : [];
  return Object.freeze({
    apiVersion,
    apiVersionString: apiVersion.join('.'),
    moonrakerVersion: safeProtocolString(value.moonraker_version, 128),
    components,
    warnings: Object.freeze(rawWarnings.length === 0 ? [] : ['server-reported-warnings']),
  });
}

function parsePrinterHandshake(value: unknown): MoonrakerPrinterHandshake {
  if (!isRecord(value)) throw new MoonrakerTransportError('invalid_response', 'handshake_printer');
  return Object.freeze({
    state: safeProtocolString(value.state, 64, 'unknown'),
    hostname: safeProtocolString(value.hostname, 255),
    softwareVersion: safeProtocolString(value.software_version, 128),
  });
}

function buildCapabilityManifest(
  components: readonly string[],
  server: MoonrakerServerHandshake,
  printer: MoonrakerPrinterHandshake,
): MoonrakerCapabilityManifest {
  const set = new Set(components);
  const extensionComponents = components.filter((component) => !KNOWN_COMPONENTS.has(component));
  return Object.freeze({
    websocket: true,
    authorization: set.has('authorization'),
    fileManagement: set.has('file_manager'),
    jobQueue: set.has('job_queue'),
    history: set.has('history'),
    webcams: set.has('webcam'),
    powerDevices: set.has('power'),
    updateManager: set.has('update_manager'),
    announcements: set.has('announcements'),
    database: set.has('database'),
    klippyConnected: server.components.includes('klippy_apis') && printer.state.toLowerCase() === 'ready',
    extensionComponents: Object.freeze(extensionComponents),
  });
}

function parseApiVersion(value: unknown): MoonrakerApiVersion {
  if (Array.isArray(value) && value.length >= 3) {
    const tuple = value.slice(0, 3).map(Number);
    if (isApiVersion(tuple)) return Object.freeze(tuple as unknown as MoonrakerApiVersion);
  }
  if (typeof value === 'string') {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    if (match) {
      const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      if (isApiVersion(tuple)) return Object.freeze(tuple);
    }
  }
  throw new MoonrakerTransportError('invalid_response', 'handshake_server');
}

function parseComponents(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new MoonrakerTransportError('invalid_response', 'handshake_server');
  const result: string[] = [];
  for (const component of value) {
    if (typeof component !== 'string' || !/^[a-z0-9_.-]{1,64}$/i.test(component)) {
      throw new MoonrakerTransportError('invalid_response', 'handshake_server');
    }
    if (!result.includes(component)) result.push(component);
  }
  return Object.freeze(result.sort());
}

function assertSupportedVersion(actual: MoonrakerApiVersion, policy: MoonrakerVersionPolicy): void {
  if (actual[0] > policy.maximumMajor || compareApiVersions(actual, policy.minimum) < 0) {
    throw new MoonrakerTransportError('version_unsupported', 'handshake_version');
  }
}

function compareApiVersions(left: MoonrakerApiVersion, right: MoonrakerApiVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isApiVersion(value: unknown): value is MoonrakerApiVersion {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => Number.isInteger(part) && part >= 0 && part <= 1_000_000)
  );
}

function safeProtocolString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  let output = '';
  for (let index = 0; index < value.length && output.length < maxLength; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x1f && code !== 0x7f) output += value[index];
  }
  return output;
}

function safeClientField(value: string, fallback: string): string {
  return /^[a-z0-9 ._-]{1,64}$/i.test(value) ? value : fallback;
}

function cloneObjectSubscription(subscription: MoonrakerObjectSubscription): MoonrakerObjectSubscription {
  const result = Object.create(null) as Record<string, readonly string[] | null>;
  for (const [objectName, fields] of Object.entries(subscription)) {
    if (
      !/^[a-z0-9_.-]{1,128}$/i.test(objectName) ||
      objectName === '__proto__' ||
      objectName === 'prototype' ||
      objectName === 'constructor'
    ) {
      throw new MoonrakerTransportError('protocol_error', 'object_subscription');
    }
    if (fields === null) {
      result[objectName] = null;
      continue;
    }
    if (!Array.isArray(fields) || fields.some((field) => !/^[a-z0-9_.-]{1,128}$/i.test(field))) {
      throw new MoonrakerTransportError('protocol_error', 'object_subscription');
    }
    result[objectName] = Object.freeze([...new Set(fields)].sort());
  }
  return Object.freeze(result);
}

function httpStatusError(status: number, operation: string): MoonrakerTransportError {
  if (status === 401) return new MoonrakerTransportError('auth_required', operation, { httpStatus: status });
  if (status === 403) return new MoonrakerTransportError('forbidden', operation, { httpStatus: status });
  return new MoonrakerTransportError('http_error', operation, {
    httpStatus: status,
    recoverable: status === 408 || status === 425 || status === 429 || status >= 500,
  });
}

function asTransportError(error: unknown, operation: string): MoonrakerTransportError {
  return error instanceof MoonrakerTransportError
    ? error
    : new MoonrakerTransportError('network', operation, { recoverable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freeze parsed JSON iteratively so one listener cannot alter another's event. */
function freezeProtocolValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 20_000) return false;
    for (const child of Object.values(current)) {
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
    Object.freeze(current);
  }
  return true;
}
