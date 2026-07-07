/**
 * Dedicated Web Worker that hosts the WASM slicer module and runs FullSpectrum
 * PROJECT slices SYNCHRONOUSLY on the worker's OWN thread.
 *
 * Why a worker: a heavy FullSpectrum project slice (hundreds of layers, dozens
 * of virtual mixed filaments) crashes silently when run on an Emscripten *pool
 * pthread* in the browser, yet completes on the module's runtime (main) thread
 * — see project_web_fs_inbrowser_slice. Running the module here, in a dedicated
 * worker, and calling the synchronous `sliceProjectSync` puts the slice on the
 * module's runtime thread (this worker's thread) — so it succeeds — while the
 * page's UI thread stays free. Progress `printErr` lines are posted back to the
 * page as they stream, even though this worker's thread is busy in the slice
 * (postMessage only enqueues to the page; it does not need this thread's loop).
 *
 * The module still spawns its own nested pthread pool from here; under
 * cross-origin isolation (inherited from the page) that works.
 */

interface Slic3rModule {
  versionString(): string;
  sliceProjectSync(path: string, maxThreads: number, overridesJson: string): string;
  FS: { writeFile(path: string, data: Uint8Array): void };
}

type FromWorker =
  | { type: 'progress'; percent: number; message: string }
  | { type: 'done'; id: number; gcode: string }
  | { type: 'error'; id: number; error: string; infra?: boolean };

type ToWorker = {
  type: 'slice';
  id: number;
  moduleUrl: string;
  project: ArrayBuffer;
  maxThreads: number;
  overrides: Record<string, string>;
};

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

let modulePromise: Promise<Slic3rModule> | null = null;

function loadModule(moduleUrl: string): Promise<Slic3rModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = (await import(/* @vite-ignore */ moduleUrl))
        .default as (arg?: object) => Promise<Slic3rModule>;
      return factory({
        printErr: (text: string) => {
          const m = /^\[orcaxr\] (\d+)% (.*)$/.exec(text);
          if (m) post({ type: 'progress', percent: Number(m[1]), message: m[2] });
        },
      });
    })();
  }
  return modulePromise;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type !== 'slice') return;
  const { id, moduleUrl, project, maxThreads, overrides } = msg;

  // A worker context that isn't cross-origin isolated cannot back the module's
  // SharedArrayBuffer pthreads — bail early so the page can fall back.
  if (typeof SharedArrayBuffer === 'undefined' || !(self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated) {
    post({ type: 'error', id, error: 'worker is not cross-origin isolated', infra: true });
    return;
  }

  try {
    const mod = await loadModule(moduleUrl);
    mod.FS.writeFile('/tmp/orcaxr_project.3mf', new Uint8Array(project));
    const out = mod.sliceProjectSync('/tmp/orcaxr_project.3mf', maxThreads, JSON.stringify(overrides));
    if (out.startsWith('ORCAXR_ERROR:')) {
      post({ type: 'error', id, error: out.slice('ORCAXR_ERROR:'.length).trim() });
    } else {
      post({ type: 'done', id, gcode: out });
    }
  } catch (err) {
    // A failure while LOADING the module is infrastructure (bad path, COI,
    // unsupported) → the page should fall back to a main-thread slice.
    const infra = !modulePromise || !(await modulePromise.then(() => true).catch(() => false));
    post({ type: 'error', id, error: String((err as Error)?.message ?? err), infra });
  }
};
