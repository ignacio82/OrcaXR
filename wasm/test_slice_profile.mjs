// Slice the cube with a REAL flattened Centauri Carbon profile.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const profRoot = join(here, '../web/public/profiles/Elegoo');

// Minimal port of the flattener (same semantics as web ProfileLoader).
const keysTs = readFileSync(join(here, '../web/src/slicer/profileKeys.ts'), 'utf8');
const grab = (name) => new Set(JSON.parse(keysTs.split(`${name} = new Set<string>(`)[1].split(');')[0]));
const META = grab('META_KEYS'); const SAFE = grab('SAFE_KEYS');
const str = (v) => v == null ? '' : Array.isArray(v) ? v.map(String).join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v);
const readCat = (cat) => readdirSync(join(profRoot, cat)).filter(f=>f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(profRoot, cat, f), 'utf8')));
const all = [...readCat('machine'), ...readCat('process'), ...readCat('filament')];
const byName = new Map(all.filter(j=>j.name).map(j=>[j.name, j]));
function flatten(leaf) {
  const chain = []; let cur = leaf; let depth = 0;
  while (cur && depth++ < 16) { chain.push(cur); cur = byName.get(str(cur.inherits)); }
  const out = {};
  for (const j of chain.reverse()) for (const [k, v] of Object.entries(j)) {
    if (META.has(k) || !SAFE.has(k)) continue; out[k] = str(v);
  }
  return out;
}
const machine = byName.get('Elegoo Centauri Carbon 0.4 nozzle');
const process_ = [...byName.values()].find(j => /0\.20|0\.2 Standard|Standard/.test(j.name||'') && /process|quality|standard/i.test(JSON.stringify(j.type||j.name)) && str(j.name).includes('0.2'));
const filament = [...byName.values()].find(j => str(j.name).startsWith('Elegoo PLA Matte') && !str(j.name).includes('0.2'));
console.log('machine:', machine?.name, '| process:', process_?.name, '| filament:', filament?.name);
const overrides = { ...flatten(machine), ...flatten(process_), ...flatten(filament) };
console.log('override keys:', Object.keys(overrides).length, 'printable_area:', overrides.printable_area?.slice(0,60));

const createSlic3r = (await import(join(here, 'dist/slic3r.mjs'))).default;
const stl = readFileSync(join(here, '../app/src/main/assets/cube_20mm.stl'));
const mod = await createSlic3r();
mod.FS.writeFile('/tmp/in.stl', new Uint8Array(stl));
const t0 = Date.now();
mod.startSliceFile('/tmp/in.stl', 4, JSON.stringify(overrides));
const gcode = await new Promise((res, rej) => {
  const t = setInterval(() => { const o = mod.pollSlice(); if (o) { clearInterval(t); o.startsWith('ORCAXR_ERROR') ? rej(new Error(o)) : res(o); } }, 100);
  setTimeout(() => { clearInterval(t); rej(new Error('timeout')); }, 300000);
});
console.log(`SLICED OK in ${Date.now()-t0} ms, ${(gcode.length/1024)|0} KB`);
for (const line of gcode.split('\n')) {
  if (/printer_model|nozzle_temperature|curr_bed_type|total layer|filament_type|bed_shape|printable_area/.test(line)) console.log(line);
  if (gcode.indexOf(line) > 4000) break;
}
process.exit(0);
