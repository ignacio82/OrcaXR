/* tslint:disable */
/* eslint-disable */

/**
 * Own in a task worker. wasm-bindgen copies each input chunk and each output
 * packet; callers transfer the resulting owned buffer, never a borrowed view.
 */
export class GcodeSession {
    free(): void;
    [Symbol.dispose](): void;
    append(offset: number, units: Uint16Array): void;
    constructor(version: number, source_units: number, options: string);
    page(start: number, count: number): string;
    seal(): string;
    /**
     * Case-insensitive line search over the sealed source, bounded by `limit`.
     */
    textSearch(query: Uint16Array, limit: number): string;
    /**
     * Readable source lines with the browser viewer's clamping; JSON text is
     * UTF-16 code units. Non-finite or nonpositive counts return no lines.
     */
    textWindow(from: number, count: number): string;
    view(request: string): Uint8Array;
    whole(): Uint8Array;
    window(first: number, last: number): Uint8Array;
}

export function core_info(): string;

export function evaluate(request: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_gcodesession_free: (a: number, b: number) => void;
    readonly core_info: () => [number, number];
    readonly evaluate: (a: number, b: number) => [number, number];
    readonly gcodesession_append: (a: number, b: number, c: number, d: number) => [number, number];
    readonly gcodesession_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly gcodesession_page: (a: number, b: number, c: number) => [number, number, number, number];
    readonly gcodesession_seal: (a: number) => [number, number, number, number];
    readonly gcodesession_textSearch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly gcodesession_textWindow: (a: number, b: number, c: number) => [number, number, number, number];
    readonly gcodesession_view: (a: number, b: number, c: number) => [number, number, number, number];
    readonly gcodesession_whole: (a: number) => [number, number, number, number];
    readonly gcodesession_window: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
