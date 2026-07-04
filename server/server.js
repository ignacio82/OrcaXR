import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
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
 * Slice with the official OrcaSlicer CLI. The uploaded STL already has
 * transforms baked into printer coordinates, so arranging/orienting is
 * explicitly disabled to preserve placement.
 */
function runCliSlice(modelPath, overrides, onProgress) {
  return new Promise(async (resolve, reject) => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orcaxr-out-'));
    const presets = await writeCliPresets(overrides, outDir);
    const args = [
      '--load-settings', `${presets.machine};${presets.process}`,
      '--load-filaments', presets.filament,
      '--slice', '0',
      '--arrange', '0',
      '--orient', '0',
      '--outputdir', outDir,
      modelPath,
    ];
    const [cmd, cmdArgs] = XVFB_RUN
      ? [XVFB_RUN, ['-a', 'orca-slicer', ...args]]
      : ['orca-slicer', args];

    const proc = spawn(cmd, cmdArgs);
    let log = '';
    const onData = (data) => {
      const text = data.toString();
      log += text;
      const m = text.match(/(\d+)%/);
      if (m) onProgress(Number(m[1]));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => reject(err));
    proc.on('close', async (code) => {
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
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      log += text;
      const m = text.match(/(\d+)%/);
      if (m) onProgress(Number(m[1]));
    });
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

app.post('/slice', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const overrides = req.body.overrides ? JSON.parse(req.body.overrides) : {};
  const configPath = req.file.path + '.json';
  const modelPath = req.file.path + '.stl';
  const outputPath = req.file.path + '.gcode';

  try {
    await fs.rename(req.file.path, modelPath);

    const onProgress = (pct) => console.log(`[slicer:${ENGINE}] ${pct}%`);
    let gcode;
    if (ENGINE === 'wasm') {
      overrides['from'] = 'project'; // the WASM engine's json loader expects it
      await fs.writeFile(configPath, JSON.stringify(overrides, null, 2));
      gcode = await runWasmSlice(modelPath, configPath, outputPath, onProgress);
    } else {
      gcode = await runCliSlice(modelPath, overrides, onProgress);
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(gcode);
  } catch (err) {
    console.error(`[slicer:${ENGINE}] slice failed:`, err.message);
    res.status(500).send(err.message);
  } finally {
    await fs.unlink(modelPath).catch(() => {});
    await fs.unlink(configPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    await fs.unlink(req.file.path).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OrcaXR External Slicer Server running on port ${PORT} (engine: ${ENGINE})`);
  if (ENGINE !== 'wasm') {
    console.log(`Make sure 'orca-slicer' is available in your PATH.`);
  }
});
