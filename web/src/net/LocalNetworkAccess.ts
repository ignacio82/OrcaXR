export type LocalNetworkAddressSpace = 'local' | 'loopback';

type LocalNetworkRequestInit = RequestInit & {
  targetAddressSpace?: LocalNetworkAddressSpace;
};

function normalizedHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

/** Let the browser own its full special-use IP table instead of duplicating it. */
export function browserClassifiesAddressSpace(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (!host) return false;
  const ipv4 = host.split('.');
  const isIpv4 = ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return isIpv4 || host.includes(':') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

export function localNetworkTargetForRequest(
  input: string | URL,
  secureContext: boolean,
): LocalNetworkAddressSpace | null {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
  if (!secureContext || url.protocol !== 'http:') return null;
  // Chrome already classifies IP literals, localhost and .local. Named LAN
  // hosts need an explicit declaration before mixed-content checks run.
  return browserClassifiesAddressSpace(url.hostname) ? null : 'local';
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const value = input instanceof Request ? input.url : input.toString();
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function createLocalNetworkRequest(
  input: RequestInfo | URL,
  init: RequestInit = {},
  secureContext = globalThis.isSecureContext === true,
): Request {
  const url = requestUrl(input);
  const targetAddressSpace = url ? localNetworkTargetForRequest(url, secureContext) : null;
  if (!targetAddressSpace) return new Request(input, init);
  const localInit: LocalNetworkRequestInit = { ...init, targetAddressSpace };
  return new Request(input, localInit);
}

export function fetchLocalNetwork(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(createLocalNetworkRequest(input, init));
}

/** Keep an explicit scheme; otherwise local service fields conventionally mean HTTP. */
export function normalizeHttpEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const colonCount = (trimmed.match(/:/g) || []).length;
  const bareIpv6 = !hasScheme && colonCount > 1 && !trimmed.startsWith('[');
  const candidate = hasScheme ? trimmed : bareIpv6 ? `http://[${trimmed}]` : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return candidate.replace(/\/+$/, '');
}

/**
 * Whether this page is forbidden from loading `endpoint` at all.
 *
 * An HTTPS page may not load plain HTTP subresources — the browser refuses
 * before any request leaves, so the app sees an opaque `TypeError: Failed to
 * fetch` that looks exactly like a printer being switched off. Chrome relaxes
 * this for a LAN address once Local Network Access is granted; every other
 * engine, and Chrome before that permission, does not.
 */
export function blockedAsMixedContent(endpoint: string): boolean {
  return globalThis.isSecureContext === true && /^http:\/\//i.test(endpoint.trim());
}

export type LocalNetworkPermission = PermissionState | 'unsupported';

/**
 * Whether the browser has been given Local Network Access.
 *
 * Queried rather than requested: the prompt is raised by the request itself, so
 * the only thing worth knowing up front is whether an attempt can succeed —
 * `denied` and `unsupported` mean this page will never reach a plain-HTTP LAN
 * address, and saying so is more use than another failed attempt.
 */
export async function localNetworkPermission(): Promise<LocalNetworkPermission> {
  const permissions = globalThis.navigator?.permissions;
  if (!permissions?.query) return 'unsupported';
  try {
    // Not in every lib.dom yet; an engine that does not know the name throws.
    const status = await permissions.query({ name: 'local-network' } as unknown as PermissionDescriptor);
    return status.state;
  } catch {
    return 'unsupported';
  }
}

export interface LocalNetworkDiagnosis {
  /** One line for the status bar. */
  readonly summary: string;
  /** The whole explanation, for a surface that can hold more than a line. */
  readonly detail: string;
  /** True when no retry can succeed until something outside the app changes. */
  readonly blocked: boolean;
  /**
   * A LAN origin that serves OrcaXR and would remove the problem entirely.
   *
   * Offered as somewhere to *go*, not as text to retype: the whole remedy is
   * one navigation, and asking an operator to copy an address out of an error
   * message is asking them to make a typing mistake.
   */
  readonly openAppAt?: string;
}

/**
 * Say why a LAN address could not be reached, in terms the operator can act on.
 *
 * This exists because the failure that matters most is the one the browser
 * makes unrecognisable. `https://…` reaching for `http://192.168.…` fails
 * identically to a wrong address, an unplugged machine, and a firewall — and
 * the fix for it is not "try again", it is one of three specific moves the
 * operator has to be told about.
 */
export interface LocalNetworkDiagnosisOptions {
  /**
   * A LAN origin that serves OrcaXR itself, if one is configured.
   *
   * The all-in-one server publishes the web app beside the slicer, so opening
   * the app *from* that origin puts the page, the slicer and the printer on the
   * same plain-HTTP footing and removes the problem rather than working around
   * it. When the operator has already told us about such a server, naming it is
   * a far better answer than a general instruction.
   */
  readonly appOrigin?: string;
}

export async function diagnoseLocalNetwork(
  endpoint: string,
  service: string,
  corsSetting: string,
  cause?: unknown,
  options: LocalNetworkDiagnosisOptions = {},
): Promise<LocalNetworkDiagnosis> {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this app';
  const reason = causeText(cause);

  if (!blockedAsMixedContent(endpoint)) {
    const summary = `Could not reach ${endpoint}${reason}.`;
    return {
      summary,
      detail:
        `${summary} Check the ${service} is on this network and reachable at that address, ` +
        `and that ${corsSetting} includes ${origin}.`,
      blocked: false,
    };
  }

  const permission = await localNetworkPermission();
  const canPrompt = permission === 'granted' || permission === 'prompt';
  const host = appOriginOf(options.appOrigin);
  const summary = host
    ? `${origin} cannot reach ${endpoint} over plain HTTP — open OrcaXR at ${host} instead.`
    : canPrompt
      ? `${origin} was refused ${endpoint} — allow Local Network Access, or open OrcaXR over HTTP on your own network.`
      : `${origin} cannot reach ${endpoint}: this browser blocks an HTTPS page from loading plain HTTP.`;

  return {
    summary,
    detail: [
      `${origin} is served over HTTPS, and a browser will not let an HTTPS page load anything over plain HTTP — ` +
        `so ${endpoint} is refused before a request is even sent. That is why this looks the same as a printer ` +
        `that is switched off.`,
      permission === 'granted'
        ? `This browser has granted Local Network Access, so a LAN address should be permitted; if it still fails, ` +
          `the address or the ${service} itself is the problem, and ${corsSetting} must include ${origin}.`
        : permission === 'prompt'
          ? `Chrome can allow it: retry and accept the Local Network Access prompt. Then make sure ${corsSetting} ` +
            `includes ${origin}.`
          : `This browser will not offer a Local Network Access prompt, so no retry here can succeed.`,
      host
        ? `You already run an OrcaXR server at ${host}, and it publishes this app beside the slicer. Open ${host} ` +
          `and the page, the slicer and the printer are all on plain HTTP with nothing cross-origin — the problem ` +
          `stops existing rather than being worked around. The alternative is an HTTPS address for the ${service} ` +
          `(Tailscale Serve is the least work).`
        : `The two routes that always work: open OrcaXR from your own network over HTTP — the OrcaXR server ` +
          `publishes the app beside the slicer, so nothing is cross-origin — or give the ${service} an HTTPS ` +
          `address of its own (Tailscale Serve is the least work) and use that here.`,
      `Whichever you pick, ${corsSetting} has to include the origin you end up on, or the next attempt fails on ` +
        `CORS instead.`,
    ].join('\n\n'),
    blocked: !canPrompt,
    ...(host ? { openAppAt: host } : {}),
  };
}

/** The origin of a configured OrcaXR server, when it is one this page cannot reach. */
function appOriginOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    // Only worth naming when it is the plain-HTTP LAN case this diagnoses.
    return url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function causeText(cause: unknown): string {
  if (!cause) return '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const trimmed = message.trim();
  // `Failed to fetch` is the browser refusing to say why; repeating it adds
  // nothing to a message whose whole job is to say why.
  if (!trimmed || /failed to fetch|load failed|networkerror/i.test(trimmed)) return '';
  return ` (${trimmed})`;
}
