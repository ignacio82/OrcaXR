/**
 * Types for the Moonraker stand-in that both the browser E2E and the printer
 * integration suite drive.
 *
 * The simulator itself stays plain JavaScript because the E2E harness runs it
 * outside the TypeScript build; this declaration exists so a typed test can use
 * it without widening the module to `any` and losing every call-site check.
 */

export interface MoonrakerSimulatorSlot {
  readonly color: string;
  readonly material: string;
  readonly vendor?: string;
}

export interface MoonrakerSimulatorOptions {
  readonly klippy?: string;
  readonly printState?: string;
  readonly currentFilename?: string;
  readonly slots?: readonly MoonrakerSimulatorSlot[];
  /** Report a stored size that differs from the bytes received. */
  readonly reportedSizeDelta?: number;
  readonly allowOrigin?: boolean;
  readonly progress?: number;
  readonly printDurationS?: number;
  readonly filamentUsedMm?: number;
  readonly currentLayer?: number;
  readonly totalLayers?: number;
  readonly nozzleC?: number;
  readonly bedC?: number;
  readonly message?: string;
  readonly files?: readonly string[];
  /** Scan metadata by path, exactly as Moonraker's file manager reports it. */
  readonly metadata?: Readonly<Record<string, Record<string, unknown>>>;
  /** Modification times by path, in seconds since the epoch. */
  readonly modified?: Readonly<Record<string, number>>;
  /** `configfile.settings`, where Klipper reports its macros. */
  readonly configSettings?: Readonly<Record<string, Record<string, unknown>>>;
  /** Canned console replies by command mnemonic; anything else answers `ok`. */
  readonly gcodeResponses?: Readonly<Record<string, string>>;
  /** Recorded jobs, newest first, as Moonraker's history component stores them. */
  readonly history?: readonly Record<string, unknown>[];
  readonly historyTotals?: Readonly<Record<string, number>>;
  /** Cameras the printer reports, in Moonraker's own shape. */
  readonly webcams?: readonly Record<string, unknown>[];
  /** Path the snapshot endpoint answers on; defaults to `/webcam/snapshot`. */
  readonly snapshotPath?: string;
}

export interface MoonrakerSimulator {
  readonly url: string;
  readonly host: string;
  /** Files the printer holds, keyed by root-relative path. */
  readonly stored: Map<string, Uint8Array>;
  readonly requests: string[];
  readonly apiKeys: (string | undefined)[];
  /** Filename of the job that was started, or null. */
  readonly started: string | null;
  /** Lifecycle and file-manager commands received, in order. */
  readonly commands: string[];
  /** How many camera frames have been fetched. */
  readonly snapshotRequests: number;
  readonly state: Record<string, unknown>;
  setSlots(slots: readonly MoonrakerSimulatorSlot[]): void;
  setState(patch: Record<string, unknown>): void;
  /** Put a file on the printer, optionally with the metadata it would have. */
  putFile(
    path: string,
    content?: Uint8Array | string,
    scan?: Record<string, unknown>,
    modifiedSeconds?: number,
  ): void;
  reset(): void;
  close(): Promise<void>;
}

export function startMoonrakerSimulator(options?: MoonrakerSimulatorOptions): Promise<MoonrakerSimulator>;
