import {
  MoonrakerTransportError,
  type MoonrakerCredentialMetadata,
  type MoonrakerSessionCredentials,
} from './MoonrakerTypes';

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|bearer|authorization|password|secret|credential)/i;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const MAX_CREDENTIAL_LENGTH = 4096;

/** Per-transport memory only. This class intentionally has no serialization API. */
export class MoonrakerSessionCredentialStore {
  #credentials: MoonrakerSessionCredentials = Object.freeze({});

  set(credentials: MoonrakerSessionCredentials): void {
    const apiKey = normalizeCredential(credentials.apiKey);
    const bearerToken = normalizeCredential(credentials.bearerToken);
    if (apiKey && bearerToken) {
      throw new MoonrakerTransportError('invalid_credentials', 'set_credentials');
    }
    this.#credentials = Object.freeze({
      ...(apiKey ? { apiKey } : {}),
      ...(bearerToken ? { bearerToken } : {}),
    });
  }

  clear(): void {
    this.#credentials = Object.freeze({});
  }

  requestHeaders(): Readonly<Record<string, string>> {
    if (this.#credentials.apiKey) return Object.freeze({ 'X-Api-Key': this.#credentials.apiKey });
    if (this.#credentials.bearerToken) {
      return Object.freeze({ Authorization: `Bearer ${this.#credentials.bearerToken}` });
    }
    return Object.freeze({});
  }

  metadata(): MoonrakerCredentialMetadata {
    return Object.freeze({
      hasApiKey: Boolean(this.#credentials.apiKey),
      hasBearerToken: Boolean(this.#credentials.bearerToken),
    });
  }

  matches(value: string): boolean {
    if (value === '') return false;
    if (this.#credentials.apiKey && value === this.#credentials.apiKey) return true;
    return Boolean(
      this.#credentials.bearerToken &&
      (value === this.#credentials.bearerToken || value === `Bearer ${this.#credentials.bearerToken}`),
    );
  }

  redact(value: unknown): unknown {
    const secrets = [this.#credentials.apiKey, this.#credentials.bearerToken].filter((entry): entry is string =>
      Boolean(entry),
    );
    return redactMoonrakerDiagnostic(value, secrets);
  }
}

export function redactMoonrakerDiagnostic(value: unknown, secrets: readonly string[] = []): unknown {
  return redactValue(value, secrets.filter(Boolean), 0, new WeakSet<object>());
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > MAX_CREDENTIAL_LENGTH || value.trim() !== value || hasAsciiControl(value)) {
    throw new MoonrakerTransportError('invalid_credentials', 'set_credentials');
  }
  return value;
}

function redactValue(value: unknown, secrets: readonly string[], depth: number, seen: WeakSet<object>): unknown {
  if (depth > 5) return '<truncated>';
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (typeof value !== 'object') return `<${typeof value}>`;
  if (seen.has(value)) return '<circular>';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => redactValue(entry, secrets, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    output[key] = SENSITIVE_KEY.test(key) ? '<redacted>' : redactValue(entry, secrets, depth + 1, seen);
  }
  return output;
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = replaceAsciiControls(value).replace(URL_PATTERN, '<redacted-url>');
  for (const secret of secrets) result = result.split(secret).join('<redacted>');
  result = result.replace(/\b(?:bearer|x-api-key|api_key|access_token)\s*[:=]\s*\S+/gi, '<redacted>');
  return result.slice(0, 512);
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function replaceAsciiControls(value: string): string {
  let output = '';
  let replacing = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const control = code <= 0x1f || code === 0x7f;
    if (control) {
      if (!replacing) output += ' ';
      replacing = true;
    } else {
      output += value[index];
      replacing = false;
    }
  }
  return output;
}
