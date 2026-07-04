import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, readFileSync, createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Slicing engine:
//   cli  (default) — official Snapmaker OrcaSlicer AppImage (`orca-slicer` in
//                    PATH). Native x86-64: no wasm32 4GB heap cap, real TBB
//                    threads, and upstream improvements arrive by bumping
//                    ORCA_VERSION in the Dockerfile.
//   wasm           — the same patched-libslic3r WASM build the browser runs,
//                    kept as a parity/debug fallback (SLICER_ENGINE=wasm).
const ENGINE = (process.env.SLICER_ENGINE || 'cli').toLowerCase();

// Orca's CLI still links GUI libs and wants a display for some code paths;
// inside the container we run it under xvfb-run (a virtual framebuffer).
const XVFB_RUN = ['/usr/bin/xvfb-run', '/usr/local/bin/xvfb-run']
  .find((p) => existsSync(p));

const app = express();
app.use(cors());

const upload = multer({ dest: os.tmpdir() });

app.get('/ping', (req, res) => res.send('pong'));

// Which preset type owns each config key, extracted from libslic3r's
// Preset.cpp (s_Preset_printer_options + machine-limits + extruder options,
// and s_Preset_filament_options). Everything else rides in the process file
// — the CLI loads unknown keys with ForwardCompatibilitySubstitutionRule::
// Enable, so a mis-binned key is tolerated, but each file's `type` must be
// one the CLI accepts and `from` must be "user" (server.js used to send
// `from: project`, which --load-settings rejects outright).
const KEY_TYPES = JSON.parse(
  readFileSync(path.join(__dirname, 'preset_key_types.json'), 'utf8'));
const MACHINE_KEYS = new Set(KEY_TYPES.machine);
const FILAMENT_KEYS = new Set(KEY_TYPES.filament);
// FullSpectrum-only keys (virtual mixed filaments, dithering) — patched-fork
// features the stock Snapmaker CLI has no options for. Painted/FS slicing is
// hard-gated to the local WASM engine client-side, so dropping them here only
// silences pointless substitution warnings.
const FS_KEY_RE = /^(mixed_|dithering_|local_z_|infill_filament_|enable_infill_filament_override)/;
// Keys that segfault Snapmaker Orca 2.3.4's CLI config loader (found by
// bisection — `wipe_tower_filament: "0"` crashes load_from_json outright).
const CLI_CRASH_KEYS = new Set(['wipe_tower_filament']);

/**
 * Split the client's flattened machine+process+filament config
 * (ProfileLoader.ts resolves the `inherits` chains browser-side) back into
 * the three typed preset files the OrcaSlicer CLI expects:
 * --load-settings machine.json;process.json --load-filaments filament.json
 */
async function writeCliPresets(overrides, dir) {
  // The CLI's compatibility gate compares the process/filament
  // `compatible_printers` list against the machine's *system* name — which
  // for a `from: user` machine is its (empty) `inherits`, so nothing ever
  // matches. Declaring the machine `from: system` makes its own name the
  // system name, and the explicit compatible_printers lists satisfy the gate.
  const cfgs = {
    machine: { name: 'OrcaXR machine', type: 'machine', from: 'system', inherits: '' },
    process: {
      name: 'OrcaXR process', type: 'process', from: 'user', inherits: '',
      compatible_printers: ['OrcaXR machine'],
    },
    filament: {
      name: 'OrcaXR filament', type: 'filament', from: 'user', inherits: '',
      compatible_printers: ['OrcaXR machine'],
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'from' || key === 'name' || key === 'type' || key === 'inherits') continue;
    if (FS_KEY_RE.test(key) || CLI_CRASH_KEYS.has(key)) continue;
    const bin = MACHINE_KEYS.has(key) ? 'machine'
      : FILAMENT_KEYS.has(key) ? 'filament'
      : 'process';
    cfgs[bin][key] = value;
  }
  const paths = {};
  for (const [type, cfg] of Object.entries(cfgs)) {
    paths[type] = path.join(dir, `${type}.json`);
    await fs.writeFile(paths[type], JSON.stringify(cfg, null, 1));
  }
  return paths;
}

/**
 * Stream the CLI's structured progress. orca-slicer's --pipe option writes
 * newline-delimited JSON ({plate_percent, total_percent, message, …}) to a
 * named pipe; the read end must exist before the CLI tries to open the
 * write end (it opens O_WRONLY|O_NONBLOCK, which fails with ENXIO when
 * nobody is reading — it retries a few times, then slices silently).
 */
function watchProgressPipe(fifoPath, onProgress) {
  const stream = createReadStream(fifoPath);
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    try {
      const j = JSON.parse(line);
      const percent = Number(j.total_percent ?? j.plate_percent);
      if (Number.isFinite(percent)) {
        onProgress(Math.max(0, Math.min(100, percent)), j.message || '');
      }
    } catch { /* partial line or non-JSON chatter — ignore */ }
  });
  stream.on('error', () => {});
  return () => { rl.close(); stream.destroy(); };
}

/**
 * Slice with the official OrcaSlicer CLI. The uploaded STL already has
 * transforms baked into printer coordinates, so arranging/orienting is
 * explicitly disabled to preserve placement.
 */
function runCliSlice(modelPath, overrides, onProgress) {
  return new Promise(async (resolve, reject) => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orcaxr-out-'));
    const presets = await writeCliPresets(overrides, outDir);
    const fifoPath = path.join(outDir, 'progress.pipe');
    await new Promise((res) => spawn('mkfifo', [fifoPath]).on('close', res));
    const stopWatching = watchProgressPipe(fifoPath, onProgress);
    const args = [
      '--load-settings', `${presets.machine};${presets.process}`,
      '--load-filaments', presets.filament,
      '--slice', '0',
      '--arrange', '0',
      '--orient', '0',
      '--pipe', fifoPath,
      '--outputdir', outDir,
      modelPath,
    ];
    const [cmd, cmdArgs] = XVFB_RUN
      ? [XVFB_RUN, ['-a', 'orca-slicer', ...args]]
      : ['orca-slicer', args];

    const proc = spawn(cmd, cmdArgs);
    let log = '';
    const onData = (data) => { log += data.toString(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => { stopWatching(); reject(err); });
    proc.on('close', async (code) => {
      stopWatching();
      try {
        const files = await fs.readdir(outDir);
        const gcodeFile = files.find((f) => f.endsWith('.gcode'));
        if (gcodeFile) {
          // Some Orca versions exit non-zero on post-slice warnings even
          // though the G-code was written — the output file is the truth.
          const gcode = await fs.readFile(path.join(outDir, gcodeFile));
          resolve(gcode);
        } else {
          reject(new Error(`orca-slicer exited with code ${code}, no G-code produced.\nLog:\n${log}`));
        }
      } catch (e) {
        reject(e);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
}

/**
 * Slice with the WASM engine in a child Node process (separate process so
 * --max-old-space-size can exceed the parent's heap; the wasm32 module
 * itself still caps at 4GB).
 */
function runWasmSlice(modelPath, configPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const maxSpaceSize = process.env.MAX_OLD_SPACE_SIZE || '4096';
    const proc = spawn('node', [
      `--max-old-space-size=${maxSpaceSize}`,
      'slice_worker.mjs',
      modelPath,
      configPath,
      outputPath,
    ]);
    let log = '';
    const onData = (data) => {
      const text = data.toString();
      log += text;
      // Engine progress lines look like "[orcaxr] 42% Generating walls".
      const m = text.match(/\[orcaxr\] (\d+)% *([^\n]*)/);
      if (m) onProgress(Number(m[1]), m[2] || '');
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => reject(err));
    proc.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(`WASM slicer exited with code ${code}.\nLog:\n${log}`));
      }
      try {
        resolve(await fs.readFile(outputPath));
      } catch (e) {
        reject(new Error('Failed to read output G-Code: ' + e.message));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Job store. POST /slice?async=1 returns a job id immediately; the client
// polls GET /jobs/:id for {status, percent, message} and fetches the result
// from GET /jobs/:id/gcode. POST /slice without the flag keeps the original
// synchronous contract, so old clients keep working against this server and
// new clients degrade gracefully against old servers (a legacy server
// ignores the query string and answers 200 + G-code instead of 202).
// ---------------------------------------------------------------------------
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

async function runSliceJob(job, modelPath, overrides, configPath, outputPath) {
  const onProgress = (percent, message = '') => {
    job.percent = percent;
    job.message = message;
    console.log(`[slicer:${ENGINE}] ${percent}%${message ? ' ' + message : ''}`);
  };
  try {
    if (ENGINE === 'wasm') {
      overrides['from'] = 'project'; // the WASM engine's json loader expects it
      await fs.writeFile(configPath, JSON.stringify(overrides, null, 2));
      job.gcode = await runWasmSlice(modelPath, configPath, outputPath, onProgress);
    } else {
      job.gcode = await runCliSlice(modelPath, overrides, onProgress);
    }
    job.percent = 100;
    job.status = 'done';
  } catch (err) {
    console.error(`[slicer:${ENGINE}] slice failed:`, err.message);
    job.status = 'error';
    job.error = err.message;
  } finally {
    await fs.unlink(modelPath).catch(() => {});
    await fs.unlink(configPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

app.post('/slice', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  let overrides;
  try {
    overrides = req.body.overrides ? JSON.parse(req.body.overrides) : {};
  } catch (e) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).send('Invalid overrides JSON: ' + e.message);
  }
  const configPath = req.file.path + '.json';
  const modelPath = req.file.path + '.stl';
  const outputPath = req.file.path + '.gcode';
  await fs.rename(req.file.path, modelPath);

  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    percent: 0,
    message: '',
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  const done = runSliceJob(job, modelPath, overrides, configPath, outputPath);

  if (req.query.async === '1') {
    return res.status(202).json({ job: job.id });
  }

  // Legacy synchronous contract.
  await done;
  jobs.delete(job.id);
  if (job.status === 'done') {
    res.setHeader('Content-Type', 'text/plain');
    res.send(job.gcode);
  } else {
    res.status(500).send(job.error);
  }
});

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('No such job.');
  res.json({ status: job.status, percent: job.percent, message: job.message, error: job.error });
});

app.get('/jobs/:id/gcode', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('No such job.');
  if (job.status !== 'done') return res.status(409).send(`Job is ${job.status}.`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(job.gcode);
  jobs.delete(job.id);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OrcaXR External Slicer Server running on port ${PORT} (engine: ${ENGINE})`);
  if (ENGINE !== 'wasm') {
    console.log(`Make sure 'orca-slicer' is available in your PATH.`);
  }
});
