/**
 * The Moonraker transport's pure policy over the hosts' shared contract:
 * endpoint normalization and request paths (`MoonrakerEndpoint.ts`), session
 * credentials and their redaction (`SessionCredentials.ts`), how a refused
 * response is reported, the handshake, the reconnect policy and its backoff,
 * the object subscription and single-method endpoints
 * (`MoonrakerTransport.ts`). Every answer comes from the production
 * functions; the Rust core answers the same requests
 * (`orcaxr_printer::moonraker`).
 */
import type {
  ProjectMoonrakerCheckReplyWire,
  ProjectMoonrakerCredentialCheckWire,
  ProjectMoonrakerCredentialReplyWire,
  ProjectMoonrakerEndpointReplyWire,
  ProjectMoonrakerEndpointRequestWire,
  ProjectMoonrakerErrorResponseWire,
  ProjectMoonrakerHandshakeReplyWire,
  ProjectMoonrakerHandshakeWire,
  ProjectMoonrakerHandshakeRequestWire,
  ProjectMoonrakerMethodCheckWire,
  ProjectMoonrakerPathReplyWire,
  ProjectMoonrakerPathRequestWire,
  ProjectMoonrakerReconnectDelayRequestWire,
  ProjectMoonrakerReconnectPolicyInputWire,
  ProjectMoonrakerReconnectPolicyReplyWire,
  ProjectMoonrakerSubscriptionEntryWire,
  ProjectMoonrakerSubscriptionReplyWire,
  ProjectMoonrakerTransportFaultWire,
} from '../../../contracts/generated/project-intents';
import { joinMoonrakerEndpointPath, normalizeMoonrakerEndpoint } from './MoonrakerEndpoint';
import {
  assertMethodSuitsEndpoint,
  calculateMoonrakerReconnectDelay,
  cloneObjectSubscription,
  httpStatusError,
  moonrakerErrorDetail,
  normalizeReconnectPolicy,
  normalizeVersionPolicy,
  readMoonrakerHandshake,
  type MoonrakerObjectSubscription,
} from './MoonrakerTransport';
import { MoonrakerTransportError, type MoonrakerApiVersion, type MoonrakerHandshake } from './MoonrakerTypes';
import { MoonrakerSessionCredentialStore } from './SessionCredentials';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const optional = (value: { value: readonly number[] } | { absent: object }): string | undefined =>
  'value' in value ? fromUnits(value.value) : undefined;
const finite = (value: { value: number } | { absent: object }): number | undefined =>
  'value' in value ? value.value : undefined;
const camel = (code: string): string => code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function transportFaultWire(error: unknown): ProjectMoonrakerTransportFaultWire {
  if (!(error instanceof MoonrakerTransportError)) throw error;
  return {
    code: camel(error.code) as ProjectMoonrakerTransportFaultWire['code'],
    operation: units(error.operation),
    recoverable: error.recoverable,
    httpStatus: error.httpStatus === undefined ? absent : { value: error.httpStatus },
    detail: error.detail === undefined ? absent : { value: units(error.detail) },
  };
}

export function answerEndpoint(request: ProjectMoonrakerEndpointRequestWire): ProjectMoonrakerEndpointReplyWire {
  const defaultPort = finite(request.defaultPort);
  const sameOriginProxy = optional(request.sameOriginProxy);
  try {
    const endpoint = normalizeMoonrakerEndpoint(fromUnits(request.input), {
      ...(defaultPort === undefined ? {} : { defaultPort }),
      ...(sameOriginProxy === undefined ? {} : { sameOriginProxy }),
      // The page this runs in has no origin; an absent one stays absent.
      pageOrigin: optional(request.pageOrigin) ?? '',
    });
    return {
      endpoint: {
        directHttpUrl: units(endpoint.directHttpUrl),
        transportHttpUrl: units(endpoint.transportHttpUrl),
        webSocketUrl: units(endpoint.webSocketUrl),
        usesSameOriginProxy: endpoint.usesSameOriginProxy,
      },
    };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}

export function answerPath(request: ProjectMoonrakerPathRequestWire): ProjectMoonrakerPathReplyWire {
  try {
    return { url: { text: units(joinMoonrakerEndpointPath(fromUnits(request.base), fromUnits(request.path))) } };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}

function store(credentials: ProjectMoonrakerCredentialCheckWire['credentials']): MoonrakerSessionCredentialStore {
  const apiKey = optional(credentials.apiKey);
  const bearerToken = optional(credentials.bearerToken);
  const store = new MoonrakerSessionCredentialStore();
  store.set({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(bearerToken === undefined ? {} : { bearerToken }),
  });
  return store;
}

export function answerCredentials(check: ProjectMoonrakerCredentialCheckWire): ProjectMoonrakerCredentialReplyWire {
  let credentials: MoonrakerSessionCredentialStore;
  try {
    credentials = store(check.credentials);
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
  const metadata = credentials.metadata();
  return {
    accepted: {
      headers: Object.entries(credentials.requestHeaders()).map(([name, value]) => ({
        name: units(name),
        value: units(value),
      })),
      hasApiKey: metadata.hasApiKey,
      hasBearerToken: metadata.hasBearerToken,
      matches: check.probes.map((probe) => credentials.matches(fromUnits(probe))),
    },
  };
}

/** A refused response as `fetchWith` reports it: its body read, redacted and summarized. */
export function answerErrorResponse(response: ProjectMoonrakerErrorResponseWire): ProjectMoonrakerTransportFaultWire {
  const body = optional(response.body);
  const detail = store(response.credentials).redact(body === undefined ? undefined : moonrakerErrorDetail(body));
  return transportFaultWire(
    httpStatusError(response.status, fromUnits(response.operation), typeof detail === 'string' ? detail : undefined),
  );
}

export function answerHandshake(request: ProjectMoonrakerHandshakeRequestWire): ProjectMoonrakerHandshakeReplyWire {
  const parse = (text: readonly number[]): unknown => {
    try {
      return JSON.parse(fromUnits(text));
    } catch {
      return null;
    }
  };
  try {
    const minimum = 'value' in request.policy.minimum ? request.policy.minimum.value : undefined;
    const maximumMajor = finite(request.policy.maximumMajor);
    const policy = normalizeVersionPolicy({
      ...(minimum === undefined ? {} : { minimum: [...minimum] as unknown as MoonrakerApiVersion }),
      ...(maximumMajor === undefined ? {} : { maximumMajor }),
    });
    return { handshake: handshakeWire(readMoonrakerHandshake(parse(request.server), parse(request.printer), policy)) };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}

export function handshakeWire(handshake: MoonrakerHandshake): ProjectMoonrakerHandshakeWire {
  const { server, printer, capabilities } = handshake;
  return {
    server: {
      apiVersion: [...server.apiVersion],
      apiVersionString: units(server.apiVersionString),
      moonrakerVersion: units(server.moonrakerVersion),
      components: server.components.map(units),
      warnings: server.warnings.map(units),
    },
    printer: {
      state: units(printer.state),
      hostname: units(printer.hostname),
      softwareVersion: units(printer.softwareVersion),
    },
    capabilities: {
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
      extensionComponents: capabilities.extensionComponents.map(units),
    },
  };
}

export function answerReconnectPolicy(
  input: ProjectMoonrakerReconnectPolicyInputWire,
): ProjectMoonrakerReconnectPolicyReplyWire {
  const fields = {
    initialDelayMs: finite(input.initialDelayMs),
    maximumDelayMs: finite(input.maximumDelayMs),
    maximumAttempts: finite(input.maximumAttempts),
    jitterRatio: finite(input.jitterRatio),
  };
  try {
    const policy = normalizeReconnectPolicy(
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    );
    return { policy: { ...policy } };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}

export function answerReconnectDelay(request: ProjectMoonrakerReconnectDelayRequestWire): number {
  return calculateMoonrakerReconnectDelay(request.attempt, request.policy, request.random);
}

/** The subscription a host would build as an object from these entries, cloned. */
export function answerSubscription(
  entries: readonly ProjectMoonrakerSubscriptionEntryWire[],
): ProjectMoonrakerSubscriptionReplyWire {
  const object = Object.fromEntries(
    entries.map((entry) => [fromUnits(entry.name), 'value' in entry.fields ? entry.fields.value.map(fromUnits) : null]),
  ) as MoonrakerObjectSubscription;
  try {
    return {
      subscription: Object.entries(cloneObjectSubscription(object)).map(([name, fields]) => ({
        name: units(name),
        fields: fields === null ? absent : { value: fields.map(units) },
      })),
    };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}

export function answerMethodCheck(check: ProjectMoonrakerMethodCheckWire): ProjectMoonrakerCheckReplyWire {
  try {
    assertMethodSuitsEndpoint(
      new URL(fromUnits(check.url)).pathname,
      optional(check.method),
      fromUnits(check.operation),
    );
    return { allowed: {} };
  } catch (error) {
    return { refused: transportFaultWire(error) };
  }
}
