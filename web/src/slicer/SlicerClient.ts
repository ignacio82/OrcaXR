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
  startSliceProject(path: string, maxThreads: number, overridesJson: string): void;
  sliceProjectSync(path: string, maxThreads: number, overridesJson: string): string;
  startSlicePainted(posPath: string, filPath: string, filamentCount: number, maxThreads: number, overridesJson: string): void;
  pollSlice(): string;
  startRepair(stl: string | ArrayBuffer, maxThreads: number): void;
  pollRepair(): string;
  startBoolean(stlA: string | ArrayBuffer, stlB: string | ArrayBuffer, op: string, maxThreads: number): void;
  pollBoolean(): string;
  FS: { writeFile(path: string, data: Uint8Array): void, readFile(path: string): Uint8Array, unlink(path: string): void };
}

const EXTERNAL_URL_KEY = 'external_slicer_url';
const EXTERNAL_ENABLED_KEY = 'external_slicer_enabled';

export class SlicerClient {
  private module: Slic3rModule | null = null;
  private loading: Promise<Slic3rModule> | null = null;
  private slicing = false;
  private crashed = false;
  private lastSliceActivity = 0;
  onProgress: ((p: SliceProgress) => void) | null = null;

  // Dedicated worker that hosts a second module instance for FullSpectrum
  // PROJECT slices (async, off the UI thread — see sliceProject / sliceWorker).
  private projectWorker: Worker | null = null;
  private workerJobs = new Map<number, { resolve: (g: string) => void; reject: (e: Error) => void }>();
  private workerJobSeq = 0;

  // ---- External slicer configuration (shared by the 2D + XR UIs) --------
  // Two independent pieces of state: the saved URL (survives being turned
  // off) and an explicit enabled flag. A model is used externally only when
  // a URL is configured AND the flag is on, so the user can keep a server
  // saved while slicing locally, and can delete it outright.
  static getExternalSlicerUrl(): string {
    return localStorage.getItem(EXTERNAL_URL_KEY) || '';
  }

  static setExternalSlicerUrl(url: string): void {
    const v = url.trim();
    if (v) localStorage.setItem(EXTERNAL_URL_KEY, v);
    else localStorage.removeItem(EXTERNAL_URL_KEY);
  }

  static isExternalSlicerEnabled(): boolean {
    // Default ON when a URL exists but the flag was never written (back-compat
    // with configs saved before the toggle existed).
    if (!SlicerClient.getExternalSlicerUrl()) return false;
    return localStorage.getItem(EXTERNAL_ENABLED_KEY) !== 'false';
  }

  static setExternalSlicerEnabled(enabled: boolean): void {
    localStorage.setItem(EXTERNAL_ENABLED_KEY, enabled ? 'true' : 'false');
  }

  /** Forget the configured external slicer entirely. */
  static clearExternalSlicer(): void {
    localStorage.removeItem(EXTERNAL_URL_KEY);
    localStorage.removeItem(EXTERNAL_ENABLED_KEY);
  }

  /** True when the next slice will be dispatched to the external server. */
  static useExternalSlicer(): boolean {
    return !!SlicerClient.getExternalSlicerUrl() && SlicerClient.isExternalSlicerEnabled();
  }

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
        // Emscripten module (it lives in /public/slicer, served as-is). Made
        // base-aware so it resolves under any deploy base: dev ('/') → it sits
        // at /slicer/slic3r.mjs; GitHub Pages ('/slicer/') → /slicer/slicer/…
        // (Emscripten locates slic3r.wasm relative to this .mjs URL.)
        const base = import.meta.env.BASE_URL; // '/' in dev, '/slicer/' on Pages
        const moduleUrl = new URL(`${base}slicer/slic3r.mjs`, window.location.origin).href;
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

  /**
   * Poll an external-server slice job until it finishes, forwarding
   * {percent, message} updates to onProgress, then fetch the G-code.
   */
  private async pollExternalJob(externalUrl: string, jobId: string): Promise<string> {
    let consecutiveFailures = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      let status: { status: string; percent: number; message?: string; error?: string };
      try {
        const res = await fetch(`${externalUrl}/jobs/${jobId}`);
        if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
        status = await res.json();
        consecutiveFailures = 0;
      } catch (e) {
        // Tolerate transient network blips, but don't spin forever if the
        // server vanished mid-slice.
        if (++consecutiveFailures >= 5) {
          throw new Error(`External slicer stopped responding: ${(e as Error).message}`);
        }
        continue;
      }
      if (status.status === 'error') {
        throw new Error(`External Slicer Failed: ${status.error}`);
      }
      if (status.status === 'done') {
        const res = await fetch(`${externalUrl}/jobs/${jobId}/gcode`);
        if (!res.ok) {
          throw new Error(`External Slicer Failed: ${await res.text()}`);
        }
        return await res.text();
      }
      if (this.onProgress) {
        this.onProgress({
          percent: status.percent ?? 0,
          message: status.message || 'Slicing externally...',
        });
      }
    }
  }

  private handleStderr(text: string) {
    // Any engine chatter (progress or the [orcaxr] setup lines) means the
    // slice thread is alive — reset the stall watchdog.
    if (text.startsWith('[orcaxr]')) this.lastSliceActivity = Date.now();
    const m = /^\[orcaxr\] (\d+)% (.*)$/.exec(text);
    if (m && this.onProgress) {
      this.onProgress({ percent: Number(m[1]), message: m[2] });
      return;
    }
    if (text.includes('uncaught exception') || text.includes('memory access out of bounds')) {
      console.error('[slicer] caught fatal worker error in stderr:', text);
      this.crashed = true;
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
    const externalUrl = SlicerClient.useExternalSlicer() ? SlicerClient.getExternalSlicerUrl() : '';
    if (externalUrl) {
      if (this.onProgress) {
        this.onProgress({ percent: 0, message: 'Slicing externally...' });
      }
      const formData = new FormData();
      formData.append('file', new Blob([stl]), 'model.stl');
      formData.append('overrides', JSON.stringify(overrides));

      // Ask for the async job protocol (202 + job id, then progress polling).
      // A legacy server ignores the query flag and answers 200 + G-code
      // directly, so both server generations keep working.
      const res = await fetch(`${externalUrl}/slice?async=1`, {
        method: 'POST',
        body: formData,
      });
      if (res.status === 202) {
        const { job } = (await res.json()) as { job: string };
        return await this.pollExternalJob(externalUrl, job);
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`External Slicer Failed: ${err}`);
      }
      return await res.text();
    }

    // Preflight: the in-browser engine is a -pthread WASM build and its slice
    // runs on a Worker thread, which requires SharedArrayBuffer — only
    // available in a cross-origin-isolated context (COOP+COEP). If isolation
    // isn't active, the slice thread silently never starts and the slice
    // "hangs" at 0% forever with no error. Fail fast with an actionable
    // message instead. (The external-server path above needs none of this.)
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'In-browser slicing needs a cross-origin-isolated context (SharedArrayBuffer), ' +
        'which is not active here (crossOriginIsolated=' + String(globalThis.crossOriginIsolated) +
        ', SharedArrayBuffer=' + (typeof SharedArrayBuffer !== 'undefined') + '). ' +
        'Serve the page with COOP/COEP headers and reload, or configure an external slicer server.',
      );
    }

    this.resetIfCrashed();
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // Typed-array write into MEMFS: embind's std::string marshalling
      // UTF-8-mangles binary bytes in the browser, so never pass the STL
      // through a JS string.
      console.log('[slicer] starting local slice: STL', stl.byteLength, 'bytes,',
        Object.keys(overrides).length, 'overrides, maxThreads', maxThreads);
      mod.FS.writeFile('/tmp/orcaxr_upload.stl', new Uint8Array(stl));
      this.lastSliceActivity = Date.now();
      mod.startSliceFile('/tmp/orcaxr_upload.stl', maxThreads, JSON.stringify(overrides));
      let stallWarned = false;
      const gcode = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          // Stall watchdog: a healthy slice emits its first progress line
          // within a second or two. If nothing has happened for 20s, the
          // engine thread almost certainly failed to start (threading /
          // SharedArrayBuffer) — surface it rather than spin forever.
          const idleMs = Date.now() - this.lastSliceActivity;
          if (!stallWarned && idleMs > 20000) {
            stallWarned = true;
            console.error('[slicer] no engine output for 20s — the slice thread may have failed to start (threading/SharedArrayBuffer). Aborting.');
            if (this.onProgress) this.onProgress({ percent: 0, message: 'engine stalled (no output) — see console' });
            clearInterval(timer);
            this.crashed = true; // force a fresh module next time
            this.resetIfCrashed();
            reject(new Error('slicer produced no output for 20s — the engine thread failed to start. Reload the page; if it persists, use an external slicer server.'));
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

  /**
   * PROJECT slice: the original 3MF (model + embedded project config —
   * including FullSpectrum mixed-filament definitions and per-part virtual
   * extruders) sliced the way desktop Snapmaker Orca opens the same file.
   * External server: the 3MF uploads through the same /slice contract (the
   * server sniffs the ZIP magic and slices it as a project). Local: the
   * engine's startSliceProject loads model AND config via load_bbs_3mf.
   */
  async sliceProject(
    project: ArrayBuffer,
    maxThreads = 4,
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const externalUrl = SlicerClient.useExternalSlicer() ? SlicerClient.getExternalSlicerUrl() : '';
    if (externalUrl) {
      if (this.onProgress) this.onProgress({ percent: 0, message: 'Slicing project externally...' });
      const formData = new FormData();
      formData.append('file', new Blob([project]), 'project.3mf');
      formData.append('overrides', JSON.stringify(overrides));
      const res = await fetch(`${externalUrl}/slice?async=1`, { method: 'POST', body: formData });
      if (res.status === 202) {
        const { job } = (await res.json()) as { job: string };
        return await this.pollExternalJob(externalUrl, job);
      }
      if (!res.ok) throw new Error(`External Slicer Failed: ${await res.text()}`);
      return await res.text();
    }

    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'In-browser slicing needs a cross-origin-isolated context (SharedArrayBuffer). ' +
        'Serve the page with COOP/COEP headers and reload, or configure an external slicer server.',
      );
    }
    if (this.slicing) throw new Error('a slice is already running');
    this.slicing = true;
    try {
      console.log('[slicer] starting local PROJECT slice:', project.byteLength, 'bytes');
      if (this.onProgress) {
        this.onProgress({ percent: 0, message: 'Slicing FullSpectrum project…' });
      }
      // FullSpectrum project slices run on a DEDICATED worker (sliceWorker.ts)
      // via the synchronous sliceProjectSync — this keeps the heavy slice off
      // the page's UI thread (async, non-blocking) while running it on the
      // module's own runtime thread rather than an Emscripten pool pthread,
      // which crashes for heavy FS slices in the browser (see
      // project_web_fs_inbrowser_slice). If the worker path can't run (e.g. no
      // cross-origin isolation inside the worker, or module load fails), fall
      // back to a synchronous main-thread slice — correct, but briefly busy.
      try {
        return await this.sliceProjectInWorker(project, maxThreads, overrides);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('WORKER_INFRA:')) throw e;
        console.warn('[slicer] project worker unavailable, falling back to main-thread slice:', e.message);
        return await this.sliceProjectOnMainThread(project, maxThreads, overrides);
      }
    } finally {
      this.slicing = false;
    }
  }

  /** Run a FullSpectrum project slice on the dedicated worker (async). */
  private sliceProjectInWorker(
    project: ArrayBuffer,
    maxThreads: number,
    overrides: Record<string, string>,
  ): Promise<string> {
    const worker = this.ensureProjectWorker();
    const base = import.meta.env.BASE_URL; // '/' in dev, '/slicer/' on Pages
    const moduleUrl = new URL(`${base}slicer/slic3r.mjs`, self.location.origin).href;
    const id = ++this.workerJobSeq;
    return new Promise<string>((resolve, reject) => {
      this.workerJobs.set(id, { resolve, reject });
      // No transfer: the caller keeps `project` (originalProject) for re-slices;
      // structured clone copies the 3.4 MB buffer, which is negligible.
      worker.postMessage({ type: 'slice', id, moduleUrl, project, maxThreads, overrides });
    });
  }

  private ensureProjectWorker(): Worker {
    if (this.projectWorker) return this.projectWorker;
    const worker = new Worker(new URL('./sliceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (this.onProgress) this.onProgress({ percent: msg.percent, message: msg.message });
        return;
      }
      const job = this.workerJobs.get(msg.id);
      if (!job) return;
      this.workerJobs.delete(msg.id);
      if (msg.type === 'done') job.resolve(msg.gcode);
      else if (msg.type === 'error') job.reject(new Error((msg.infra ? 'WORKER_INFRA:' : '') + msg.error));
    };
    worker.onerror = (e: ErrorEvent) => {
      // The worker itself crashed — reject everything pending as infra failure
      // so callers fall back, and drop it so the next slice recreates it.
      const err = new Error('WORKER_INFRA:slice worker crashed: ' + (e.message || 'unknown'));
      for (const [, job] of this.workerJobs) job.reject(err);
      this.workerJobs.clear();
      this.projectWorker = null;
    };
    this.projectWorker = worker;
    return worker;
  }

  /** Synchronous main-thread project slice (fallback; briefly blocks the UI). */
  private async sliceProjectOnMainThread(
    project: ArrayBuffer,
    maxThreads: number,
    overrides: Record<string, string>,
  ): Promise<string> {
    this.resetIfCrashed();
    const mod = await this.ensureModule();
    mod.FS.writeFile('/tmp/orcaxr_upload.3mf', new Uint8Array(project));
    if (this.onProgress) {
      this.onProgress({ percent: 0, message: 'Slicing FullSpectrum project (this can take a while)…' });
    }
    await new Promise((r) => setTimeout(r, 0)); // let the status paint first
    const out = mod.sliceProjectSync('/tmp/orcaxr_upload.3mf', maxThreads, JSON.stringify(overrides));
    if (out.startsWith('ORCAXR_ERROR:')) throw new Error(out.slice('ORCAXR_ERROR:'.length).trim());
    return out;
  }

  /**
   * Painted (multi-color) slice. `positions` is a Float32 buffer of 9 floats
   * per triangle (printer coords, mm, Z-up); `triFilament` is one 0-based
   * filament index per triangle. The engine splits the mesh into a per-filament
   * volume and emits tool changes — this is how painting a model actually
   * reaches the G-code. Local WASM only (needs cross-origin isolation).
   */
  async slicePainted(
    positions: Float32Array,
    triFilament: Int32Array,
    filamentCount: number,
    maxThreads = 4,
    overrides: Record<string, string> = {},
  ): Promise<string> {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'Painted slicing needs a cross-origin-isolated context (SharedArrayBuffer). ' +
        'Serve the page with COOP/COEP headers and reload.',
      );
    }
    this.resetIfCrashed();
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      const posBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
      const filBytes = new Uint8Array(triFilament.buffer, triFilament.byteOffset, triFilament.byteLength);
      console.log('[slicer] painted slice:', triFilament.length, 'tris,', filamentCount, 'filaments');
      mod.FS.writeFile('/tmp/orcaxr_painted_pos.bin', posBytes);
      mod.FS.writeFile('/tmp/orcaxr_painted_fil.bin', filBytes);
      this.lastSliceActivity = Date.now();
      mod.startSlicePainted(
        '/tmp/orcaxr_painted_pos.bin', '/tmp/orcaxr_painted_fil.bin',
        filamentCount, maxThreads, JSON.stringify(overrides),
      );
      return await this.awaitSliceResult(() => mod.pollSlice());
    } finally {
      this.slicing = false;
    }
  }

  /** Shared poll loop for the async slice path (mono file + painted).
   *  [idleLimitMs] — how long the engine may stay silent before the stall
   *  watchdog declares it dead. Project 3MFs (big zip parse, many meshes,
   *  FullSpectrum tool ordering) legitimately go quiet far longer than a
   *  flat STL slice. */
  private awaitSliceResult(poll: () => string, idleLimitMs = 20000): Promise<string> {
    let stallWarned = false;
    return new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.crashed) {
          clearInterval(timer);
          this.resetIfCrashed();
          reject(new Error('slicer crashed — restarted, please try again'));
          return;
        }
        const idleMs = Date.now() - this.lastSliceActivity;
        if (!stallWarned && idleMs > idleLimitMs) {
          stallWarned = true;
          clearInterval(timer);
          this.crashed = true;
          this.resetIfCrashed();
          reject(new Error(`slicer produced no output for ${Math.round(idleLimitMs / 1000)}s — the engine thread failed to start.`));
          return;
        }
        const out = poll();
        if (out.length > 0) {
          clearInterval(timer);
          if (out.startsWith('ORCAXR_ERROR:')) reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
          else resolve(out);
        }
      }, 100);
    });
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

  /**
   * Boolean CSG (UNION / A_NOT_B / INTERSECTION) of two binary STLs via the
   * WASM engine's mcut path. Returns the result binary STL. Binary bytes go
   * through the same binary-string channel as repair() (embind std::string).
   */
  async boolean(
    stlA: ArrayBuffer,
    stlB: ArrayBuffer,
    op: 'UNION' | 'A_NOT_B' | 'INTERSECTION',
    maxThreads = 4,
  ): Promise<ArrayBuffer> {
    this.resetIfCrashed();
    if (this.slicing) throw new Error('the engine is busy');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      const toBinStr = (b: ArrayBuffer) => {
        const u = new Uint8Array(b);
        let s = '';
        // Chunked to avoid blowing the argument stack on large meshes.
        for (let i = 0; i < u.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
        }
        return s;
      };
      mod.startBoolean(toBinStr(stlA), toBinStr(stlB), op, maxThreads);
      const outString = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          const out = mod.pollBoolean();
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

