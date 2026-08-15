export type MoonrakerConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type MoonrakerErrorCode =
  | 'invalid_endpoint'
  | 'invalid_credentials'
  | 'invalid_state'
  | 'invalid_request'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'auth_required'
  | 'forbidden'
  | 'http_error'
  | 'invalid_response'
  | 'protocol_error'
  | 'version_unsupported'
  | 'websocket_unavailable'
  | 'websocket_failed'
  | 'heartbeat_timeout'
  | 'reconnect_exhausted';

const ERROR_MESSAGES: Readonly<Record<MoonrakerErrorCode, string>> = Object.freeze({
  invalid_endpoint: 'The Moonraker endpoint is invalid or unsafe.',
  invalid_credentials: 'The Moonraker credentials are invalid.',
  invalid_state: 'The Moonraker operation is not valid in the current connection state.',
  invalid_request: 'The Moonraker operation was given an invalid argument.',
  cancelled: 'The Moonraker operation was cancelled.',
  timeout: 'The Moonraker operation timed out.',
  network: 'Moonraker could not be reached.',
  auth_required: 'Moonraker requires authentication.',
  forbidden: 'Moonraker rejected the authenticated request.',
  http_error: 'Moonraker returned an HTTP error.',
  invalid_response: 'Moonraker returned an invalid response.',
  protocol_error: 'Moonraker returned a protocol error.',
  version_unsupported: 'The Moonraker API version is not supported.',
  websocket_unavailable: 'WebSocket support is unavailable in this browser.',
  websocket_failed: 'The Moonraker WebSocket connection failed.',
  heartbeat_timeout: 'The Moonraker WebSocket heartbeat timed out.',
  reconnect_exhausted: 'Moonraker reconnection attempts were exhausted.',
});

export interface MoonrakerErrorDiagnostic {
  readonly name: 'MoonrakerTransportError';
  readonly code: MoonrakerErrorCode;
  readonly operation: string;
  readonly recoverable: boolean;
  readonly httpStatus?: number;
}

/**
 * A deliberately bounded error. It never retains a response body, URL, socket
 * reason, credential, or the original Error object.
 */
export class MoonrakerTransportError extends Error {
  readonly code: MoonrakerErrorCode;
  readonly operation: string;
  readonly recoverable: boolean;
  readonly httpStatus?: number;
  /**
   * What the server itself said, when it said anything.
   *
   * Moonraker explains its refusals in the response body, and discarding that
   * left `http_error` as the whole story — enough to know a send failed, not
   * enough to know a print command had been sent with the wrong HTTP method.
   */
  readonly detail?: string;

  constructor(
    code: MoonrakerErrorCode,
    operation: string,
    options: { readonly recoverable?: boolean; readonly httpStatus?: number; readonly detail?: string } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MoonrakerTransportError';
    this.code = code;
    this.operation = safeOperationName(operation);
    this.recoverable = options.recoverable ?? defaultRecoverability(code);
    if (Number.isInteger(options.httpStatus) && (options.httpStatus ?? 0) >= 100 && (options.httpStatus ?? 0) <= 599) {
      this.httpStatus = options.httpStatus;
    }
    const detail = summarizeServerDetail(options.detail);
    if (detail !== undefined) this.detail = detail;
  }

  toDiagnostic(): MoonrakerErrorDiagnostic {
    return Object.freeze({
      name: 'MoonrakerTransportError',
      code: this.code,
      operation: this.operation,
      recoverable: this.recoverable,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    });
  }

  toJSON(): MoonrakerErrorDiagnostic {
    return this.toDiagnostic();
  }
}

/**
 * Reduce a server's error body to one short, printable line.
 *
 * The body is attacker-adjacent text on the LAN, so it is stripped of control
 * characters and capped rather than trusted: enough to name the cause in a
 * message an operator reads, never enough to reformat that message.
 */
function summarizeServerDetail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Classified by code point rather than by regex: a control character inside a
  // pattern is itself easy to mistype invisibly, which is how an earlier draft
  // of this line silently stripped ordinary punctuation.
  let collapsed = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) collapsed += character;
    else if (!collapsed.endsWith(' ')) collapsed += ' ';
  }
  collapsed = collapsed.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

export function safeOperationName(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : 'request';
}

function defaultRecoverability(code: MoonrakerErrorCode): boolean {
  return (
    code === 'cancelled' ||
    code === 'timeout' ||
    code === 'network' ||
    code === 'websocket_failed' ||
    code === 'heartbeat_timeout'
  );
}

export interface NormalizedMoonrakerEndpoint {
  /** Normalized user-entered endpoint. Never contains credentials or a query. */
  readonly directHttpUrl: string;
  /** Direct endpoint or a validated same-origin proxy base. */
  readonly transportHttpUrl: string;
  /** WebSocket route corresponding to transportHttpUrl. */
  readonly webSocketUrl: string;
  readonly usesSameOriginProxy: boolean;
}

export interface MoonrakerSessionCredentials {
  readonly apiKey?: string;
  readonly bearerToken?: string;
}

export interface MoonrakerCredentialMetadata {
  readonly hasApiKey: boolean;
  readonly hasBearerToken: boolean;
}

export type MoonrakerApiVersion = readonly [major: number, minor: number, patch: number];

export interface MoonrakerVersionPolicy {
  readonly minimum: MoonrakerApiVersion;
  readonly maximumMajor: number;
}

export interface MoonrakerServerHandshake {
  readonly apiVersion: MoonrakerApiVersion;
  readonly apiVersionString: string;
  readonly moonrakerVersion: string;
  readonly components: readonly string[];
  readonly warnings: readonly string[];
}

export interface MoonrakerPrinterHandshake {
  readonly state: string;
  readonly hostname: string;
  readonly softwareVersion: string;
}

export interface MoonrakerCapabilityManifest {
  readonly websocket: true;
  readonly authorization: boolean;
  readonly fileManagement: boolean;
  readonly jobQueue: boolean;
  readonly history: boolean;
  readonly webcams: boolean;
  readonly powerDevices: boolean;
  readonly updateManager: boolean;
  readonly announcements: boolean;
  readonly database: boolean;
  readonly klippyConnected: boolean;
  readonly extensionComponents: readonly string[];
}

export interface MoonrakerHandshake {
  readonly server: MoonrakerServerHandshake;
  readonly printer: MoonrakerPrinterHandshake;
  readonly capabilities: MoonrakerCapabilityManifest;
}

export type MoonrakerDisconnectReason = 'initial' | 'user' | 'cancelled' | 'disposed';

export type MoonrakerConnectionState =
  | {
      readonly status: 'disconnected';
      readonly generation: number;
      readonly reason: MoonrakerDisconnectReason;
    }
  | {
      readonly status: 'connecting';
      readonly generation: number;
      readonly attempt: 0;
    }
  | {
      readonly status: 'connected';
      readonly generation: number;
      readonly socketEpoch: number;
      readonly connectedAtMs: number;
      readonly lastHeartbeatAtMs: number;
      readonly handshake: MoonrakerHandshake;
    }
  | {
      readonly status: 'reconnecting';
      readonly generation: number;
      readonly attempt: number;
      readonly delayMs: number;
      readonly lastError: MoonrakerErrorDiagnostic;
    }
  | {
      readonly status: 'error';
      readonly generation: number;
      readonly error: MoonrakerErrorDiagnostic;
    };

export interface MoonrakerNotification {
  readonly method: string;
  readonly params: unknown;
  readonly receivedAtMs: number;
  readonly generation: number;
  readonly socketEpoch: number;
}

export type MoonrakerDiagnosticEventName =
  | 'connection_attempt'
  | 'connected'
  | 'reconnect_scheduled'
  | 'disconnected'
  | 'request_failed'
  | 'protocol_warning'
  | 'heartbeat_timeout';

export interface MoonrakerDiagnosticEvent {
  readonly timestampMs: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly event: MoonrakerDiagnosticEventName;
  readonly state: MoonrakerConnectionStatus;
  readonly generation: number;
  readonly attempt?: number;
  readonly error?: MoonrakerErrorDiagnostic;
}
