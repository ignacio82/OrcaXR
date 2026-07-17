import type { McpToolArguments, McpToolHandler, McpToolHost, McpToolInputSchema } from './McpToolHost';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_REGISTRATION_RESPONSE_LENGTH = 32_768;
const MAX_WIRE_MESSAGE_LENGTH = 1_000_000;

export const WEBMCP_CLI_PACKAGE = '@jason.today/webmcp@0.1.13';

export type WebMcpConnectionState = 'idle' | 'registering' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WebMcpStatus {
  state: WebMcpConnectionState;
  message: string;
}

export type WebMcpErrorCode =
  'cancelled' | 'invalid_token' | 'unsupported_server' | 'registration_failed' | 'connection_failed' | 'timeout';

export class WebMcpConnectionError extends Error {
  constructor(
    readonly code: WebMcpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WebMcpConnectionError';
  }
}

interface SocketMessageEvent {
  data: unknown;
}

interface SocketCloseEvent {
  code: number;
  reason: string;
}

/** Narrow socket surface, exported so the protocol can be tested without a network. */
export interface WebMcpSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface OrcaWebMcpClientOptions {
  /** Defaults to the page host and is the channel identity in WebMCP 0.1.13. */
  pageHost?: () => string;
  /** Test/platform seam. Production uses the browser's native WebSocket. */
  socketFactory?: (url: string) => WebMcpSocket;
  connectionTimeoutMs?: number;
  /** Remote endpoints are opt-in; the supported npx bridge is loopback-only. */
  allowRemoteServer?: boolean;
  onStatus?: (status: Readonly<WebMcpStatus>) => void;
  onError?: (error: Error) => void;
}

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  handler: McpToolHandler;
}

interface ConnectionToken {
  encoded: string;
  server: URL;
  registrationToken: string;
}

interface WireMessage {
  type?: unknown;
  id?: unknown;
  tool?: unknown;
  arguments?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, 240);
  return cleaned || fallback;
}

function formatHost(host: string): string {
  const formatted = host.trim().replace(/[.:]/g, '_');
  if (!formatted || formatted.length > 255 || formatted.includes('/')) {
    throw new WebMcpConnectionError('connection_failed', 'The browser host cannot form a WebMCP channel.');
  }
  return formatted;
}

function decodeBase64Utf8(encoded: string): string {
  const compact = encoded.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  // Avoid spreading a potentially large token into the call stack.
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  );
}

function endpoint(base: URL, pathname: string): URL {
  const url = new URL(base);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url;
}

function nativeSocketFactory(url: string): WebMcpSocket {
  return new WebSocket(url) as unknown as WebMcpSocket;
}

/**
 * Locally bundled client for the @jason.today/webmcp 0.1.13 browser wire
 * protocol. OrcaXR owns the UI; this class owns only registration and tools.
 */
export class OrcaWebMcpClient implements McpToolHost {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly pageHost: () => string;
  private readonly socketFactory: (url: string) => WebMcpSocket;
  private readonly connectionTimeoutMs: number;
  private readonly allowRemoteServer: boolean;
  private readonly onStatus?: OrcaWebMcpClientOptions['onStatus'];
  private readonly onError?: OrcaWebMcpClientOptions['onError'];

  private channelSocket: WebMcpSocket | null = null;
  private registrationSocket: WebMcpSocket | null = null;
  private cancelPending: (() => void) | null = null;
  private attempt = 0;
  private connected = false;
  private currentStatus: WebMcpStatus = { state: 'idle', message: 'WebMCP is ready.' };

  constructor(options: OrcaWebMcpClientOptions = {}) {
    this.pageHost = options.pageHost ?? (() => window.location.host);
    this.socketFactory = options.socketFactory ?? nativeSocketFactory;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowRemoteServer = options.allowRemoteServer ?? false;
    this.onStatus = options.onStatus;
    this.onError = options.onError;

    if (!Number.isFinite(this.connectionTimeoutMs) || this.connectionTimeoutMs <= 0) {
      throw new RangeError('connectionTimeoutMs must be a positive finite number.');
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get status(): Readonly<WebMcpStatus> {
    return this.currentStatus;
  }

  registerTool(name: string, description: string, inputSchema: McpToolInputSchema, handler: McpToolHandler): void {
    const normalizedName = name.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalizedName)) {
      throw new TypeError(`Invalid MCP tool name: ${normalizedName || '(empty)'}`);
    }
    if (inputSchema.type !== 'object' || !isRecord(inputSchema.properties)) {
      throw new TypeError(`MCP tool ${normalizedName} must declare an object input schema.`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`MCP tool ${normalizedName} must provide a handler.`);
    }

    const tool: RegisteredTool = {
      name: normalizedName,
      description: description.trim() || `Tool: ${normalizedName}`,
      inputSchema,
      handler,
    };
    this.tools.set(normalizedName, tool);

    if (this.connected) this.sendToolRegistration(tool);
  }

  async connect(encodedToken: string): Promise<void> {
    const attempt = ++this.attempt;
    this.cancelPending?.();
    this.cancelPending = null;
    this.closeSockets();
    this.connected = false;

    try {
      const connection = this.decodeConnectionToken(encodedToken);
      const channelHost = formatHost(this.pageHost());
      this.setStatus('registering', 'Registering this browser tab with WebMCP…');
      const sessionToken = await this.register(connection, channelHost, attempt);
      this.assertCurrentAttempt(attempt);

      this.setStatus('connecting', 'Connecting the WebMCP tool channel…');
      await this.openChannel(connection.server, channelHost, sessionToken, attempt);
    } catch (value) {
      const error = toError(value, 'WebMCP connection failed.');
      if (error instanceof WebMcpConnectionError && error.code === 'cancelled') throw error;
      if (attempt !== this.attempt) {
        throw new WebMcpConnectionError('cancelled', 'WebMCP connection cancelled.', { cause: error });
      }

      this.connected = false;
      this.closeSockets();
      this.setStatus('error', error.message);
      this.reportError(error);
      throw error;
    }
  }

  disconnect(message = 'WebMCP disconnected.'): void {
    ++this.attempt;
    this.cancelPending?.();
    this.cancelPending = null;
    this.connected = false;
    this.closeSockets();
    this.setStatus('disconnected', message);
  }

  private decodeConnectionToken(encodedToken: string): ConnectionToken {
    const encoded = encodedToken.trim();
    if (!encoded || encoded.length > MAX_TOKEN_LENGTH) {
      throw new WebMcpConnectionError('invalid_token', 'Enter a valid WebMCP connection token.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decodeBase64Utf8(encoded));
    } catch (error) {
      throw new WebMcpConnectionError('invalid_token', 'The WebMCP token is malformed.', { cause: error });
    }
    if (!isRecord(payload) || typeof payload.server !== 'string' || typeof payload.token !== 'string') {
      throw new WebMcpConnectionError('invalid_token', 'The WebMCP token is missing server details.');
    }
    if (!payload.token || payload.token.length > 4_096) {
      throw new WebMcpConnectionError('invalid_token', 'The WebMCP registration token is invalid.');
    }

    let server: URL;
    try {
      server = new URL(payload.server);
    } catch (error) {
      throw new WebMcpConnectionError('unsupported_server', 'The WebMCP server address is invalid.', { cause: error });
    }
    if (server.protocol !== 'ws:' && server.protocol !== 'wss:') {
      throw new WebMcpConnectionError('unsupported_server', 'WebMCP requires a WebSocket server.');
    }
    if (server.username || server.password || server.search || server.hash) {
      throw new WebMcpConnectionError(
        'unsupported_server',
        'The WebMCP server address contains unsupported credentials or parameters.',
      );
    }
    if (server.pathname !== '/' && server.pathname !== '') {
      throw new WebMcpConnectionError('unsupported_server', 'The WebMCP server must use its origin URL.');
    }
    if (!this.allowRemoteServer && !isLoopback(server.hostname)) {
      throw new WebMcpConnectionError('unsupported_server', 'Only a local WebMCP bridge is allowed.');
    }

    return { encoded, server, registrationToken: payload.token };
  }

  private register(connection: ConnectionToken, channelHost: string, attempt: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebMcpSocket;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (this.cancelPending === cancel) this.cancelPending = null;
        callback();
      };
      const fail = (error: WebMcpConnectionError) => settle(() => reject(error));
      const cancel = () => fail(new WebMcpConnectionError('cancelled', 'WebMCP connection cancelled.'));
      this.cancelPending = cancel;

      try {
        socket = this.socketFactory(endpoint(connection.server, '/register').toString());
        this.registrationSocket = socket;
      } catch (error) {
        fail(
          new WebMcpConnectionError('registration_failed', 'Could not open the WebMCP registration channel.', {
            cause: error,
          }),
        );
        return;
      }

      timer = setTimeout(() => {
        fail(new WebMcpConnectionError('timeout', 'WebMCP registration timed out.'));
        this.closeSocket(socket);
      }, this.connectionTimeoutMs);

      socket.onopen = () => {
        if (attempt !== this.attempt) return cancel();
        try {
          socket.send(
            encodeBase64Utf8(
              JSON.stringify({
                server: connection.server.toString().replace(/\/$/, ''),
                token: connection.registrationToken,
                host: channelHost,
              }),
            ),
          );
        } catch (error) {
          fail(
            new WebMcpConnectionError('registration_failed', 'Could not send WebMCP registration.', { cause: error }),
          );
        }
      };
      socket.onmessage = (event) => {
        if (attempt !== this.attempt) return cancel();
        try {
          if (typeof event.data !== 'string') throw new TypeError('Non-text registration response.');
          if (event.data.length > MAX_REGISTRATION_RESPONSE_LENGTH)
            throw new RangeError('Oversized registration response.');
          const message: unknown = JSON.parse(event.data);
          if (!isRecord(message)) throw new TypeError('Invalid registration response.');
          if (message.type === 'registerSuccess') {
            if (typeof message.token !== 'string' || message.token.length === 0 || message.token.length > 4_096) {
              throw new TypeError('Invalid WebMCP session token.');
            }
            const sessionToken = message.token;
            settle(() => {
              this.closeSocket(socket);
              if (this.registrationSocket === socket) this.registrationSocket = null;
              resolve(sessionToken);
            });
            return;
          }
          if (message.type === 'error') {
            fail(
              new WebMcpConnectionError(
                'registration_failed',
                safeMessage(message.message, 'WebMCP rejected the registration token.'),
              ),
            );
          }
        } catch (error) {
          fail(
            new WebMcpConnectionError('registration_failed', 'WebMCP returned an invalid registration response.', {
              cause: error,
            }),
          );
        }
      };
      socket.onerror = () =>
        fail(new WebMcpConnectionError('registration_failed', 'Could not reach the local WebMCP bridge.'));
      socket.onclose = (event) => {
        if (!settled) {
          fail(
            new WebMcpConnectionError(
              'registration_failed',
              event.reason
                ? safeMessage(event.reason, 'WebMCP registration closed.')
                : 'WebMCP registration closed unexpectedly.',
            ),
          );
        }
      };
    });
  }

  private openChannel(server: URL, channelHost: string, sessionToken: string, attempt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const channelUrl = endpoint(server, `/${channelHost}`);
      channelUrl.searchParams.set('token', sessionToken);
      let socket: WebMcpSocket;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (this.cancelPending === cancel) this.cancelPending = null;
        callback();
      };
      const fail = (error: WebMcpConnectionError) => settle(() => reject(error));
      const cancel = () => fail(new WebMcpConnectionError('cancelled', 'WebMCP connection cancelled.'));
      this.cancelPending = cancel;

      try {
        socket = this.socketFactory(channelUrl.toString());
        this.channelSocket = socket;
      } catch (error) {
        fail(
          new WebMcpConnectionError('connection_failed', 'Could not open the WebMCP tool channel.', { cause: error }),
        );
        return;
      }

      timer = setTimeout(() => {
        fail(new WebMcpConnectionError('timeout', 'The WebMCP tool channel timed out.'));
        this.closeSocket(socket);
      }, this.connectionTimeoutMs);

      socket.onopen = () => {
        if (attempt !== this.attempt) return cancel();
        opened = true;
        this.connected = true;
        this.tools.forEach((tool) => this.sendToolRegistration(tool));
        this.setStatus('connected', 'WebMCP connected to this browser tab.');
        settle(resolve);
      };
      socket.onmessage = (event) => {
        if (attempt !== this.attempt || typeof event.data !== 'string') return;
        try {
          if (event.data.length > MAX_WIRE_MESSAGE_LENGTH) {
            throw new RangeError("WebMCP message exceeded OrcaXR's size limit.");
          }
          const message: unknown = JSON.parse(event.data);
          if (isRecord(message)) void this.handleMessage(message);
        } catch (error) {
          const protocolError = toError(error, 'WebMCP returned an invalid message.');
          this.setStatus('error', 'The WebMCP bridge sent an invalid message.');
          this.reportError(protocolError);
        }
      };
      socket.onerror = () => {
        const error = new WebMcpConnectionError(
          'connection_failed',
          opened ? 'The WebMCP connection encountered an error.' : 'Could not connect to the local WebMCP bridge.',
        );
        if (!opened) fail(error);
        else {
          this.setStatus('error', error.message);
          this.reportError(error);
        }
      };
      socket.onclose = (event) => {
        if (this.channelSocket === socket) this.channelSocket = null;
        if (!opened) {
          fail(
            new WebMcpConnectionError(
              'connection_failed',
              event.reason
                ? safeMessage(event.reason, 'WebMCP connection closed.')
                : 'WebMCP connection closed before it was ready.',
            ),
          );
          return;
        }
        if (attempt !== this.attempt) return;
        this.connected = false;
        this.setStatus('disconnected', 'WebMCP disconnected.');
      };
    });
  }

  private async handleMessage(message: WireMessage): Promise<void> {
    switch (message.type) {
      case 'callTool':
        await this.handleToolCall(message);
        break;
      case 'listTools':
        this.send({
          id: message.id,
          type: 'listToolsResponse',
          tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        break;
      case 'ping':
        this.send({ type: 'pong', id: message.id, timestamp: Date.now() });
        break;
      case 'error': {
        const error = new Error(safeMessage(message.message, 'The WebMCP bridge reported an error.'));
        this.setStatus('error', error.message);
        this.reportError(error);
        break;
      }
      // Welcome and registration acknowledgements require no response.
      case 'welcome':
      case 'toolRegistered':
        break;
      default:
        break;
    }
  }

  private async handleToolCall(message: WireMessage): Promise<void> {
    const id = message.id;
    if (typeof message.tool !== 'string' || !this.tools.has(message.tool)) {
      this.send({ id, type: 'toolResponse', error: 'Tool not found.' });
      return;
    }

    const tool = this.tools.get(message.tool)!;
    const arguments_: McpToolArguments = isRecord(message.arguments) ? message.arguments : {};
    try {
      const result = await tool.handler(arguments_);
      if (!this.send({ id, type: 'toolResponse', result })) {
        this.send({ id, type: 'toolResponse', error: 'Tool returned an invalid response.' });
      }
    } catch (value) {
      this.reportError(toError(value, `MCP tool ${tool.name} failed.`));
      this.send({ id, type: 'toolResponse', error: 'Tool execution failed.' });
    }
  }

  private sendToolRegistration(tool: RegisteredTool): void {
    this.send({
      type: 'registerTool',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }

  private send(message: Record<string, unknown>): boolean {
    const socket = this.channelSocket;
    if (!this.connected || !socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.reportError(toError(error, 'Could not send a WebMCP message.'));
      return false;
    }
  }

  private assertCurrentAttempt(attempt: number): void {
    if (attempt !== this.attempt) {
      throw new WebMcpConnectionError('cancelled', 'WebMCP connection cancelled.');
    }
  }

  private closeSockets(): void {
    const registration = this.registrationSocket;
    const channel = this.channelSocket;
    this.registrationSocket = null;
    this.channelSocket = null;
    if (registration) this.closeSocket(registration);
    if (channel && channel !== registration) this.closeSocket(channel);
  }

  private closeSocket(socket: WebMcpSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
      try {
        socket.close(1000, 'OrcaXR closed the WebMCP connection.');
      } catch {
        // The browser may already be tearing the socket down.
      }
    }
  }

  private setStatus(state: WebMcpConnectionState, message: string): void {
    this.currentStatus = { state, message };
    try {
      this.onStatus?.(this.currentStatus);
    } catch {
      // A rendering callback must never break the protocol lifecycle.
    }
  }

  private reportError(error: Error): void {
    try {
      this.onError?.(error);
    } catch {
      // A diagnostic callback must never break the protocol lifecycle.
    }
  }
}
