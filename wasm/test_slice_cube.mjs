// Phase-1 proof: slice the 20 mm calibration cube to G-code inside the
// WASM slicer under Node, using the ASYNC API (startSlice + pollSlice).
// The slice runs on its own pthread; the JS thread stays in the event
// loop so Emscripten can schedule TBB's workers (oneTBB WASM_Support.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const createSlic3r = (await import(join(here, 'dist/slic3r.mjs'))).default;

const stl = readFileSync(join(here, '../app/src/main/assets/cube_20mm.stl'));

console.log('loading WASM slicer module...');
const mod = await createSlic3r();
console.log('module ready:', mod.versionString());

const maxThreads = Number(process.env.ORCAXR_TBB ?? 4);
console.log(`slicing cube_20mm.stl (maxThreads=${maxThreads})...`);
const t0 = Date.now();
mod.startSlice(stl.toString('binary'), maxThreads);

const gcode = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const out = mod.pollSlice();
    if (out.length > 0) {
      clearInterval(timer);
      resolve(out);
    } else if (Date.now() - t0 > 900_000) {
      clearInterval(timer);
      reject(new Error('slice timed out after 900 s'));
    }
  }, 100);
});
const ms = Date.now() - t0;

if (gcode.startsWith('ORCAXR_ERROR:')) {
  console.error('SLICE FAILED:', gcode.slice(0, 500));
  process.exit(1);
}

const lines = gcode.split('\n');
const layers = lines.filter((l) => l.startsWith(';LAYER_CHANGE') || l.includes('CHANGE_LAYER')).length;
console.log(`\nSLICED OK in ${ms} ms`);
console.log(`gcode: ${gcode.length} bytes, ${lines.length} lines, ~${layers} layer changes`);
console.log('--- first 15 lines ---');
console.log(lines.slice(0, 15).join('\n'));
process.exit(0);
