/**
 * The pinned WASM slicer's Emscripten factory, typed only where callers use it.
 *
 * The engine is a build artifact rather than a source module, so this
 * declaration exists to let tests drive it headlessly without widening the
 * surface: only the entry points the app already calls are described.
 */
export interface OrcaSlicerModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, options?: { encoding?: string }): Uint8Array | string;
    unlink(path: string): void;
  };
  sliceProjectSync(path: string, maxThreads: number, overridesJson: string): string;
  sliceStlToGcode?(path: string, maxThreads: number, overridesJson: string): string;
}

declare function createOrcaSlicerModule(options?: Record<string, unknown>): Promise<OrcaSlicerModule>;
export default createOrcaSlicerModule;
