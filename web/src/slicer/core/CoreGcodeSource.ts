import { GCODE_LAYOUT } from '../../../../contracts/generated/gcode-layout';
import type { GcodeIndexEntryMetadata } from '../../../../contracts/generated/gcode-metadata';
import { RICH_GCODE_HARD_CAPS } from '../RichGcodeModel';
import type { GcodePreviewRequest } from '../GcodePreviewModel';
import type { GcodePlaybackOptions } from '../GcodeInspectionModel';
import {
  decodeGcodeModel,
  decodeGcodeIndex,
  decodeGcodeIndexPage,
  decodeGcodeSummary,
  decodeGcodePreview,
  decodeGcodeInspection,
  decodeGcodePlayback,
} from './GcodePackets';
import {
  checkedGcodeWindow,
  encodeGcodeOptions,
  encodeGcodePreview,
  encodeGcodeInspection,
  type GcodeSourceOptions,
  type GcodeWindowSelector,
  type GcodeSourceInspection,
} from './GcodeRequests';

/** Structural interface to the pinned, initialized wasm-bindgen module. Asset
 * loading/handshake belongs to the worker composition root, not this owner. */
export interface GcodeCoreBinding {
  append(offset: number, units: Uint16Array): void;
  seal(): string;
  page(start: number, count: number): string;
  summary(): string;
  whole(): Uint8Array;
  window(first: number, last: number): Uint8Array;
  view(request: string): Uint8Array;
  free(): void;
}
export type GcodeCoreConstructor = new (version: number, sourceLength: number, options: string) => GcodeCoreBinding;

/** Synchronous computation owner for a disposable task worker. It retains no
 * JS source string or rich columns. Rust owns its immutable source/index and
 * one parsed window; callers own every decoded output/transfer. */
export class CoreGcodeSource {
  private binding: GcodeCoreBinding | undefined;
  readonly index: ReturnType<typeof decodeGcodeIndex>;

  constructor(Binding: GcodeCoreConstructor, source: string, options: GcodeSourceOptions = {}) {
    if (typeof source !== 'string' || source.length > RICH_GCODE_HARD_CAPS.inputCharacters)
      throw new Error('This G-code exceeds the bounded preview input size.');
    // Fully validate/encode before a constructor can reserve source memory.
    const encoded = encodeGcodeOptions(options);
    const binding = (this.binding = new Binding(GCODE_LAYOUT.version, source.length, encoded));
    try {
      const chunk = new Uint16Array(Math.min(source.length, GCODE_LAYOUT.maxChunkUnits));
      for (let offset = 0; offset < source.length; offset += chunk.length) {
        const count = Math.min(chunk.length, source.length - offset);
        for (let i = 0; i < count; i++) chunk[i] = source.charCodeAt(offset + i);
        binding.append(offset, chunk.subarray(0, count));
      }
      const index = decodeGcodeIndex(binding.seal(), source.length);
      // The parser charges at least 256 bytes for each checkpoint against its
      // 64 MiB index budget. Refuse impossible counts before host pagination.
      if (index.entryCount > 1 + (64 * 1024 * 1024) / 256) throw new Error('Invalid shared G-code index count');
      for (const warning of index.warnings) {
        Object.freeze(warning.message);
        Object.freeze(warning);
      }
      Object.freeze(index.warnings);
      Object.freeze(index.limits);
      this.index = Object.freeze(index);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private active(): GcodeCoreBinding {
    if (!this.binding) throw new Error('Shared G-code source is closed');
    return this.binding;
  }

  /** Pagination is sequential so each page can validate source/prefix
   * continuity. The caller may retain these small entries, never checkpoints. */
  *entries(): Generator<Readonly<GcodeIndexEntryMetadata>, void> {
    let previous: GcodeIndexEntryMetadata | undefined;
    for (let start = 0; start < this.index.entryCount; start += GCODE_LAYOUT.maxIndexPageEntries) {
      const count = Math.min(GCODE_LAYOUT.maxIndexPageEntries, this.index.entryCount - start);
      const page = decodeGcodeIndexPage(this.active().page(start, count), this.index, previous);
      if (page.length !== count) throw new Error('Invalid shared G-code index page length');
      for (const entry of page) {
        this.active();
        previous = Object.freeze(entry);
        yield previous;
      }
    }
    if (this.index.complete && previous!.endOffsetExclusive !== this.index.sourceLength)
      throw new Error('Invalid shared G-code index coverage');
  }

  /** What the artifact states about itself and the preview panel's wording of
   * it, from the shared core; a statement past the metadata bound is refused
   * as `resource_limit`, leaving the source usable. */
  summary() {
    return decodeGcodeSummary(this.active().summary());
  }

  /** A frame binds every view query to this immutable source and exact selector.
   * Finish queries before transferring its buffer. A new frame after transfer
   * gets fresh host bytes while Rust can reuse its one parsed window. */
  openWindow(selector: GcodeWindowSelector) {
    const window = checkedGcodeWindow(selector, this.index.entryCount);
    const binding = this.active();
    const model = decodeGcodeModel(window.length ? binding.window(...window) : binding.whole());
    if (model.sourceLength !== this.index.sourceLength) throw new Error('Invalid shared G-code source identity');
    const query = (encoded: string) => {
      this.active();
      // Even an empty model owns a nonempty packet. Do not validate a response
      // against detached columns or pretend a transferred frame is reusable.
      if (!model.columns.kind.buffer.byteLength) throw new Error('Shared G-code frame was transferred');
      return binding.view(encoded);
    };
    return Object.freeze({
      model,
      window,
      project: (request: GcodePreviewRequest) => decodeGcodePreview(query(encodeGcodePreview(window, request)), model),
      inspect: (request: GcodeSourceInspection = {}, includeSource = false) =>
        decodeGcodeInspection(query(encodeGcodeInspection(window, request, includeSource)), model),
      playback: (request: GcodeSourceInspection, playback: GcodePlaybackOptions, includeSource = false) =>
        decodeGcodePlayback(query(encodeGcodeInspection(window, request, includeSource, playback)), model),
    });
  }

  dispose(): void {
    const binding = this.binding;
    this.binding = undefined;
    // Raw wasm-bindgen free() is not idempotent. Clear ownership first, even if
    // a damaged binding throws during release.
    binding?.free();
  }
}
