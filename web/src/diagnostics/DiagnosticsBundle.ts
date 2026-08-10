/**
 * Diagnostics and support export (P11.4).
 *
 * A support bundle is only useful if someone will actually send it, and they
 * will only send it if they can see it first and it does not carry their work.
 * So two rules shape this module:
 *
 * 1. The privacy preview and the export are the *same object*. There is no
 *    summary that could drift from what is written to disk — `buildBundle`
 *    returns the bundle, the preview renders it, and the download serializes
 *    the very thing that was shown.
 * 2. Nothing is included that was not asked for. No G-code, no project
 *    geometry, no tokens, no LAN addresses, and no model names unless the
 *    operator explicitly opts in. Everything else passes through the same
 *    redactor the Moonraker transport already uses on its own diagnostics.
 */

import { redactMoonrakerDiagnostic } from '../printer/SessionCredentials';

/** Bounded so a long session cannot grow the bundle without limit. */
export const MAX_LOG_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 512;

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export interface DiagnosticEntry {
  /** Milliseconds since the recorder started, not a wall clock: no timezone. */
  readonly atMs: number;
  readonly level: DiagnosticLevel;
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * A bounded ring buffer of structured events.
 *
 * Redaction happens on record rather than on export, so a secret never sits in
 * memory inside a diagnostic in the first place and cannot escape through some
 * other reader of this buffer.
 */
export class DiagnosticsRecorder {
  private readonly entries: DiagnosticEntry[] = [];
  private readonly startedAt = Date.now();
  private secrets: readonly string[] = [];

  /** Values to strike from every message, in addition to the pattern rules. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = secrets.filter((secret) => secret.length >= 8);
  }

  record(level: DiagnosticLevel, scope: string, message: string, data?: unknown): void {
    const entry: DiagnosticEntry = {
      atMs: Date.now() - this.startedAt,
      level,
      scope: String(scope).slice(0, 64),
      message: String(redactMoonrakerDiagnostic(message, this.secrets)).slice(0, MAX_MESSAGE_LENGTH),
      ...(data === undefined ? {} : { data: redactMoonrakerDiagnostic(data, this.secrets) }),
    };
    this.entries.push(entry);
    // Oldest first out: a crash is usually near the end of a session.
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
  }

  /** Convenience for the common case of an exception reaching a boundary. */
  recordError(scope: string, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.record('error', scope, message);
  }

  snapshot(): readonly DiagnosticEntry[] {
    return Object.freeze([...this.entries]);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Facts the caller supplies; this module never reaches for globals itself. */
export interface DiagnosticsInput {
  readonly appVersion: string;
  readonly engine: {
    readonly commit: string;
    readonly route: 'browser-wasm' | 'external-server';
    /** Whether an external route proved its engine. Never the endpoint. */
    readonly externalAttested?: boolean;
  };
  readonly browser: {
    readonly userAgent: string;
    readonly language: string;
    readonly hardwareConcurrency?: number;
    readonly deviceMemoryGb?: number;
    readonly crossOriginIsolated?: boolean;
  };
  readonly xr?: {
    readonly supported: boolean;
    readonly sessionActive: boolean;
  };
  readonly printer?: {
    readonly configured: boolean;
    readonly connected: boolean;
    /** Capability names only — never an address or a credential. */
    readonly capabilities?: readonly string[];
    readonly jobState?: string;
  };
  readonly capabilities: {
    readonly actionCount: number;
    readonly unavailableCount: number;
  };
  readonly performance?: {
    readonly usedHeapMb?: number;
    readonly totalHeapMb?: number;
    readonly uptimeSeconds?: number;
  };
  readonly project?: ProjectSummaryInput;
  readonly log: readonly DiagnosticEntry[];
}

export interface ProjectSummaryInput {
  readonly plateCount: number;
  readonly objectCount: number;
  readonly volumeCount: number;
  readonly triangleCount: number;
  readonly physicalFilamentCount: number;
  readonly mixedFilamentCount: number;
  readonly paintedVolumeCount: number;
  /** Only exported when the operator explicitly opts in. */
  readonly objectNames: readonly string[];
}

export interface DiagnosticsOptions {
  /**
   * Include object names. Off by default: a model name is the single most
   * identifying thing in a slicer session, and a support bundle rarely needs
   * it to explain a failure.
   */
  readonly includeModelNames?: boolean;
}

export interface DiagnosticsBundle {
  readonly format: 'orcaxr.diagnostics';
  readonly schemaVersion: 1;
  readonly appVersion: string;
  readonly engine: DiagnosticsInput['engine'];
  readonly browser: DiagnosticsInput['browser'];
  readonly xr?: DiagnosticsInput['xr'];
  readonly printer?: DiagnosticsInput['printer'];
  readonly capabilities: DiagnosticsInput['capabilities'];
  readonly performance?: DiagnosticsInput['performance'];
  readonly project?: Omit<ProjectSummaryInput, 'objectNames'> & { readonly objectNames?: readonly string[] };
  readonly log: readonly DiagnosticEntry[];
  /** What was deliberately left out, so the preview can say so plainly. */
  readonly omitted: readonly string[];
}

/**
 * Assemble the bundle. This is exactly what the preview shows and exactly what
 * gets written, with no second code path between them.
 */
export function buildDiagnosticsBundle(input: DiagnosticsInput, options: DiagnosticsOptions = {}): DiagnosticsBundle {
  const omitted = ['G-code and project geometry', 'printer and slicer addresses', 'API keys and tokens'];
  const includeNames = options.includeModelNames === true;
  if (!includeNames) omitted.push('model and object names');

  const project = input.project
    ? {
        plateCount: input.project.plateCount,
        objectCount: input.project.objectCount,
        volumeCount: input.project.volumeCount,
        triangleCount: input.project.triangleCount,
        physicalFilamentCount: input.project.physicalFilamentCount,
        mixedFilamentCount: input.project.mixedFilamentCount,
        paintedVolumeCount: input.project.paintedVolumeCount,
        ...(includeNames ? { objectNames: input.project.objectNames.slice(0, 64).map(safeName) } : {}),
      }
    : undefined;

  const bundle: DiagnosticsBundle = {
    format: 'orcaxr.diagnostics',
    schemaVersion: 1,
    appVersion: input.appVersion,
    engine: input.engine,
    browser: input.browser,
    ...(input.xr ? { xr: input.xr } : {}),
    ...(input.printer ? { printer: input.printer } : {}),
    capabilities: input.capabilities,
    ...(input.performance ? { performance: input.performance } : {}),
    ...(project ? { project } : {}),
    log: input.log.slice(-MAX_LOG_ENTRIES),
    omitted: Object.freeze(omitted),
  };

  // One final pass over the whole bundle. The recorder already redacts each
  // entry, but state assembled from elsewhere has not been through anything,
  // and an address reaching a support file is exactly what this must prevent.
  return redactMoonrakerDiagnostic(bundle) as DiagnosticsBundle;
}

/** The file an operator downloads, pretty-printed so it can be read before sending. */
export function serializeDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * A short, human-readable account of what the bundle contains and what it
 * leaves out, for the confirmation shown before anything is written.
 */
export function describeDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  const lines = [
    `OrcaXR ${bundle.appVersion} · engine ${bundle.engine.commit.slice(0, 7)} · ${bundle.engine.route}`,
    `${bundle.log.length} log entries, ${bundle.capabilities.actionCount} actions`,
  ];
  if (bundle.project) {
    lines.push(
      `Project shape only: ${bundle.project.plateCount} plate(s), ${bundle.project.objectCount} object(s), ` +
        `${bundle.project.triangleCount} triangles` +
        (bundle.project.objectNames ? `, including ${bundle.project.objectNames.length} name(s)` : ''),
    );
  }
  if (bundle.printer) {
    lines.push(
      `Printer: ${bundle.printer.configured ? 'configured' : 'not configured'}, ${bundle.printer.connected ? 'connected' : 'offline'}`,
    );
  }
  lines.push(`Left out: ${bundle.omitted.join('; ')}.`);
  return lines.join('\n');
}

function safeName(value: string): string {
  return String(redactMoonrakerDiagnostic(value)).slice(0, 120);
}
