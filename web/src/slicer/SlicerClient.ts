/**
 * Browser-side client for the OrcaXR WASM slicer (wasm/dist → /slicer/).
 *
 * The module's slice runs on its own pthread (startSlice/pollSlice async
 * API) so the UI thread never blocks; progress arrives by parsing the
 * module's stderr status lines ("[orcaxr] 35% Generating infill…").
 */

export interface SliceProgress {
  percent: number;
  message: string;
}

interface Slic3rModule {
  versionString(): string;
  startSlice(stlBinary: string, maxThreads: number): void;
  startSliceFile(path: string, maxThreads: number): void;
  pollSlice(): string;
  FS: { writeFile(path: string, data: Uint8Array): void };
}

export class SlicerClient {
  private module: Slic3rModule | null = null;
  private loading: Promise<Slic3rModule> | null = null;
  private slicing = false;
  onProgress: ((p: SliceProgress) => void) | null = null;

  async load(): Promise<void> {
    await this.ensureModule();
  }

  get isSlicing(): boolean {
    return this.slicing;
  }

  private ensureModule(): Promise<Slic3rModule> {
    if (this.module) return Promise.resolve(this.module);
    if (!this.loading) {
      this.loading = (async () => {
        // Runtime-computed URL so vite doesn't try to pre-bundle the
        // Emscripten module (it lives in /public, served as-is).
        const moduleUrl = new URL('/slicer/slic3r.mjs', window.location.origin).href;
        const factory = (await import(/* @vite-ignore */ moduleUrl))
          .default as (arg?: object) => Promise<Slic3rModule>;
        const mod = await factory({
          printErr: (text: string) => this.handleStderr(text),
        });
        this.module = mod;
        console.log('[slicer]', mod.versionString());
        return mod;
      })();
    }
    return this.loading;
  }

  private handleStderr(text: string) {
    const m = /^\[orcaxr\] (\d+)% (.*)$/.exec(text);
    if (m && this.onProgress) {
      this.onProgress({ percent: Number(m[1]), message: m[2] });
      return;
    }
    console.log('[slicer]', text);
  }

  /**
   * Slice a binary STL (printer coordinates, mm, Z-up) to G-code text.
   * Rejects with the slicer's error message on failure.
   */
  async slice(stl: ArrayBuffer, maxThreads = 4): Promise<string> {
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // Typed-array write into MEMFS: embind's std::string marshalling
      // UTF-8-mangles binary bytes in the browser, so never pass the STL
      // through a JS string.
      mod.FS.writeFile('/tmp/orcaxr_upload.stl', new Uint8Array(stl));
      mod.startSliceFile('/tmp/orcaxr_upload.stl', maxThreads);
      const gcode = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          const out = mod.pollSlice();
          if (out.length > 0) {
            clearInterval(timer);
            if (out.startsWith('ORCAXR_ERROR:')) {
              reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
            } else {
              resolve(out);
            }
          }
        }, 100);
      });
      return gcode;
    } finally {
      this.slicing = false;
    }
  }
}

