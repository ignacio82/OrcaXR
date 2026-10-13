/**
 * File → Export Diagnostics… as an exchange: the browser's own bundle, its
 * privacy preview and its recorded events (`DiagnosticsBundle.ts`) behind
 * JSON requests a host can send, so another shell writes the same bytes from
 * the same facts. Objects are read in the input interface's order, and only
 * the keys it declares, with their kinds; anything else is refused.
 */
import { canonicalStringify } from '../project/domain/canonical';
import {
  buildDiagnosticsBundle,
  describeDiagnosticsBundle,
  diagnosticEntry,
  diagnosticSecrets,
  serializeDiagnosticsBundle,
  type DiagnosticEntry,
  type DiagnosticLevel,
  type DiagnosticsInput,
} from './DiagnosticsBundle';

type Kind = 'text' | 'number' | 'flag' | 'texts';
type Record_ = Record<string, unknown>;

const LEVELS: readonly DiagnosticLevel[] = ['info', 'warning', 'error'];

function isObject(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ofKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'flag':
      return typeof value === 'boolean';
    case 'texts':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

/** [value]'s declared keys in [keys]' order, each of its kind; an absent optional one left out. */
function section(value: unknown, keys: readonly (readonly [string, Kind, boolean])[]): Record_ {
  if (!isObject(value)) throw new RangeError('invalid_request');
  for (const key of Object.keys(value)) if (!keys.some(([k]) => k === key)) throw new RangeError('invalid_request');
  const out: Record_ = {};
  for (const [key, kind, required] of keys) {
    if (!(key in value)) {
      if (required) throw new RangeError('invalid_request');
      continue;
    }
    if (!ofKind(value[key], kind)) throw new RangeError('invalid_request');
    out[key] = kind === 'texts' ? [...(value[key] as string[])] : value[key];
  }
  return out;
}

function entry(value: unknown): DiagnosticEntry {
  const read = section(value, [
    ['atMs', 'number', true],
    ['level', 'text', true],
    ['scope', 'text', true],
    ['message', 'text', true],
  ]);
  if (!LEVELS.includes(read.level as DiagnosticLevel)) throw new RangeError('invalid_request');
  return read as unknown as DiagnosticEntry;
}

/** A request's `DiagnosticsInput`, its objects in the interface's order. */
function readInput(value: unknown): DiagnosticsInput {
  if (!isObject(value)) throw new RangeError('invalid_request');
  const known = ['appVersion', 'engine', 'browser', 'xr', 'printer', 'capabilities', 'performance', 'project', 'log'];
  for (const key of Object.keys(value)) if (!known.includes(key)) throw new RangeError('invalid_request');
  if (typeof value.appVersion !== 'string' || !Array.isArray(value.log)) throw new RangeError('invalid_request');
  const read: Record_ = {
    appVersion: value.appVersion,
    engine: section(value.engine, [
      ['commit', 'text', true],
      ['route', 'text', true],
      ['externalAttested', 'flag', false],
    ]),
    browser: section(value.browser, [
      ['userAgent', 'text', true],
      ['language', 'text', true],
      ['hardwareConcurrency', 'number', false],
      ['deviceMemoryGb', 'number', false],
      ['crossOriginIsolated', 'flag', false],
    ]),
  };
  if ('xr' in value)
    read.xr = section(value.xr, [
      ['supported', 'flag', true],
      ['sessionActive', 'flag', true],
    ]);
  if ('printer' in value)
    read.printer = section(value.printer, [
      ['configured', 'flag', true],
      ['connected', 'flag', true],
      ['capabilities', 'texts', false],
      ['jobState', 'text', false],
    ]);
  read.capabilities = section(value.capabilities, [
    ['actionCount', 'number', true],
    ['unavailableCount', 'number', true],
  ]);
  if ('performance' in value)
    read.performance = section(value.performance, [
      ['usedHeapMb', 'number', false],
      ['totalHeapMb', 'number', false],
      ['uptimeSeconds', 'number', false],
    ]);
  if ('project' in value)
    read.project = section(value.project, [
      ['plateCount', 'number', true],
      ['objectCount', 'number', true],
      ['volumeCount', 'number', true],
      ['triangleCount', 'number', true],
      ['physicalFilamentCount', 'number', true],
      ['mixedFilamentCount', 'number', true],
      ['paintedVolumeCount', 'number', true],
      ['objectNames', 'texts', true],
    ]);
  read.log = value.log.map(entry);
  return read as unknown as DiagnosticsInput;
}

/**
 * `{"input": DiagnosticsInput, "includeModelNames"}` → the bundle as the
 * browser writes it (`file`), its privacy preview (`description`) and the
 * entries it keeps (`logEntries`), as canonical JSON; null when malformed.
 */
export function diagnosticsBundleExchange(requestJson: string): string | null {
  try {
    const request: unknown = JSON.parse(requestJson);
    if (!isObject(request) || Object.keys(request).length !== 2 || typeof request.includeModelNames !== 'boolean') {
      return null;
    }
    const bundle = buildDiagnosticsBundle(readInput(request.input), { includeModelNames: request.includeModelNames });
    return canonicalStringify({
      description: describeDiagnosticsBundle(bundle),
      file: serializeDiagnosticsBundle(bundle),
      logEntries: bundle.log.length,
    });
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * `{"atMs","level","message","scope","secrets"}` → the entry a recorder
 * keeps of that event with those secrets set, as canonical JSON; null when
 * malformed.
 */
export function diagnosticEntryExchange(requestJson: string): string | null {
  try {
    const request = section(JSON.parse(requestJson), [
      ['atMs', 'number', true],
      ['level', 'text', true],
      ['message', 'text', true],
      ['scope', 'text', true],
      ['secrets', 'texts', true],
    ]);
    if (!LEVELS.includes(request.level as DiagnosticLevel)) return null;
    return canonicalStringify(
      diagnosticEntry(
        request.atMs as number,
        request.level as DiagnosticLevel,
        request.scope as string,
        request.message as string,
        diagnosticSecrets(request.secrets as string[]),
      ),
    );
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** What a bundle states of the catalogue: its actions and how many are unavailable. */
export function diagnosticsCapabilities(actions: readonly { readonly capability: { readonly status: string } }[]): {
  actionCount: number;
  unavailableCount: number;
} {
  return {
    actionCount: actions.length,
    unavailableCount: actions.filter((action) => action.capability.status === 'unavailable').length,
  };
}

/** `{"actionCount","engineCommit","unavailableCount"}`: the catalogue's counts and the engine build the client accepts. */
export function diagnosticsFactsExchange(
  actions: readonly { readonly capability: { readonly status: string } }[],
  engineCommit: string,
): string {
  return canonicalStringify({ ...diagnosticsCapabilities(actions), engineCommit });
}
