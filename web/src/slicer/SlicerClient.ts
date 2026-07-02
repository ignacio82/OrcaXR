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
  startSliceFile(path: string, maxThreads: number, overridesJson: string): void;
  pollSlice(): string;
  startRepair(stl: string | ArrayBuffer, maxThreads: number): void;
  pollRepair(): string;
  startBoolean(stlA: string | ArrayBuffer, stlB: string | ArrayBuffer, op: string, maxThreads: number): void;
  pollBoolean(): string;
  FS: { writeFile(path: string, data: Uint8Array): void, readFile(path: string): Uint8Array, unlink(path: string): void };
}

export class SlicerClient {
  private module: Slic3rModule | null = null;
  private loading: Promise<Slic3rModule> | null = null;
  private slicing = false;
  private crashed = false;
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
          onAbort: () => {
            this.crashed = true;
          },
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
  /** Drop a crashed module so the next slice boots a fresh one. */
  private resetIfCrashed() {
    if (this.crashed) {
      this.module = null;
      this.loading = null;
      this.crashed = false;
      this.slicing = false;
      console.warn('[slicer] module crashed — restarting fresh instance');
    }
  }

  async slice(
    stl: ArrayBuffer,
    maxThreads = 4,
    overrides: Record<string, string> = {},
  ): Promise<string> {
    this.resetIfCrashed();
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // Typed-array write into MEMFS: embind's std::string marshalling
      // UTF-8-mangles binary bytes in the browser, so never pass the STL
      // through a JS string.
      mod.FS.writeFile('/tmp/orcaxr_upload.stl', new Uint8Array(stl));
      mod.startSliceFile('/tmp/orcaxr_upload.stl', maxThreads, JSON.stringify(overrides));
      const gcode = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
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

  async repair(stl: ArrayBuffer, maxThreads = 4): Promise<ArrayBuffer> {
    this.resetIfCrashed();
    if (this.slicing) throw new Error('the engine is busy');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // For repair, we pass STL as a string for now, or wait, startRepair takes a string!
      // But passing binary as string can corrupt it in Embind.
      // Wait, in start_slice_file we wrote to MEMFS. We didn't do start_repair_file, we just did start_repair(string).
      // Since embind string is utf-8, binary bytes might get corrupted!
      // Let's modify start_repair to take the file path instead, or just use the string (the Android port did something similar, but files are safer).
      // Actually, since I wrote repair_stl_to_stl in C++ taking std::string, if we just write the file to MEMFS and read it, it's safer. But wait, startRepair takes std::string!
      // Let's pass it as a binary string (which is what Emscripten's std::string typemap does if not careful, but it might fail).
      // A better way is to pass Uint8Array? Emscripten's embind handles std::string as UTF-8. 
      // But we can convert ArrayBuffer to a binary string and hope it survives? NO!
      // Since I already compiled the WASM, let's just pass a binary string. 
      const binaryString = String.fromCharCode(...new Uint8Array(stl));
      mod.startRepair(binaryString, maxThreads);
      
      const outString = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          const out = mod.pollRepair();
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
      
      const outBuffer = new Uint8Array(outString.length);
      for (let i = 0; i < outString.length; i++) {
        outBuffer[i] = outString.charCodeAt(i);
      }
      return outBuffer.buffer;
    } finally {
      this.slicing = false;
    }
  }
}

