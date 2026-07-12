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
  const isIpv4 = ipv4.length === 4 && ipv4.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) <= 255
  );
  return (
    isIpv4 ||
    host.includes(':') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  );
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
  const targetAddressSpace = url
    ? localNetworkTargetForRequest(url, secureContext)
    : null;
  if (!targetAddressSpace) return new Request(input, init);
  const localInit: LocalNetworkRequestInit = {...init, targetAddressSpace};
  return new Request(input, localInit);
}

export function fetchLocalNetwork(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(createLocalNetworkRequest(input, init));
}

/** Keep an explicit scheme; otherwise local service fields conventionally mean HTTP. */
export function normalizeHttpEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const colonCount = (trimmed.match(/:/g) || []).length;
  const bareIpv6 = !hasScheme && colonCount > 1 && !trimmed.startsWith('[');
  const candidate = hasScheme
    ? trimmed
    : bareIpv6
      ? `http://[${trimmed}]`
      : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return candidate.replace(/\/+$/, '');
}

export function localNetworkFailureMessage(
  endpoint: string,
  service: string,
  corsSetting: string,
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this app';
  if (globalThis.isSecureContext && /^http:\/\//i.test(endpoint)) {
    return `Could not reach ${endpoint}. Allow OrcaXR Local Network Access, then check ${corsSetting} includes ${origin}. If permission is unavailable or denied, use an HTTPS ${service} URL (for example Tailscale Serve).`;
  }
  return `Could not reach ${endpoint}. Check the ${service} is on this network and ${corsSetting} includes ${origin}.`;
}
