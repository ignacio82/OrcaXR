import { MoonrakerTransportError, type NormalizedMoonrakerEndpoint } from './MoonrakerTypes';

const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|access[-_]?token|token|authorization|password|secret)/i;

export interface NormalizeMoonrakerEndpointOptions {
  readonly defaultPort?: number;
  readonly sameOriginProxy?: string;
  readonly pageOrigin?: string;
}

/** Normalize one explicit target; this function never performs scheme/port probing. */
export function normalizeMoonrakerEndpoint(
  input: string,
  options: NormalizeMoonrakerEndpointOptions = {},
): NormalizedMoonrakerEndpoint {
  const direct = parseDirectEndpoint(input, options.defaultPort ?? 7125);
  const proxy = options.sameOriginProxy
    ? parseSameOriginProxy(options.sameOriginProxy, options.pageOrigin ?? browserPageOrigin())
    : null;
  const transport = proxy ?? direct;
  const webSocket = new URL(transport);
  webSocket.protocol = webSocket.protocol === 'https:' ? 'wss:' : 'ws:';
  webSocket.pathname = joinPathname(webSocket.pathname, 'websocket');

  return Object.freeze({
    directHttpUrl: direct,
    transportHttpUrl: transport,
    webSocketUrl: stripTrailingSlash(webSocket.toString()),
    usesSameOriginProxy: proxy !== null,
  });
}

export function joinMoonrakerEndpointPath(base: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || containsControlOrSpace(path)) {
    throw new MoonrakerTransportError('invalid_endpoint', 'request_path');
  }

  const queryIndex = path.indexOf('?');
  const rawPathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  for (const segment of rawPathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new MoonrakerTransportError('invalid_endpoint', 'request_path');
    }
    if (decoded === '.' || decoded === '..') {
      throw new MoonrakerTransportError('invalid_endpoint', 'request_path');
    }
  }

  const target = new URL(base);
  target.pathname = joinPathname(target.pathname, rawPathname.replace(/^\/+/, ''));
  target.search = rawQuery;
  for (const key of target.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new MoonrakerTransportError('invalid_endpoint', 'request_path');
    }
  }
  return target.toString();
}

function parseDirectEndpoint(input: string, defaultPort: number): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048 || containsControlOrSpace(trimmed)) {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_endpoint');
  }
  if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_endpoint');
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  const bareIpv6 = !hasScheme && colonCount > 1 && !trimmed.startsWith('[');
  const candidate = hasScheme ? trimmed : bareIpv6 ? `http://[${trimmed}]` : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_endpoint');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_endpoint');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_endpoint');
  }
  if (!hasScheme && !parsed.port) parsed.port = String(defaultPort);
  parsed.pathname = normalizeBasePath(parsed.pathname);
  return stripTrailingSlash(parsed.toString());
}

function parseSameOriginProxy(input: string, pageOrigin: string): string {
  if (!input.trim() || !pageOrigin || containsControlOrSpace(input.trim())) {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_proxy');
  }
  let origin: URL;
  let proxy: URL;
  try {
    origin = new URL(pageOrigin);
    proxy = new URL(input, origin);
  } catch {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_proxy');
  }
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    proxy.origin !== origin.origin ||
    proxy.username ||
    proxy.password ||
    proxy.search ||
    proxy.hash
  ) {
    throw new MoonrakerTransportError('invalid_endpoint', 'normalize_proxy');
  }
  proxy.pathname = normalizeBasePath(proxy.pathname);
  return stripTrailingSlash(proxy.toString());
}

function normalizeBasePath(pathname: string): string {
  const value = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return value === '' ? '/' : value;
}

function joinPathname(base: string, child: string): string {
  const left = base.replace(/\/+$/, '');
  const right = child.replace(/^\/+/, '');
  return `${left}/${right}`.replace(/^\/\//, '/');
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function browserPageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function containsControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}
