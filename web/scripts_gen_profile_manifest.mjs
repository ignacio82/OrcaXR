// Build-time: bundle ALL profile JSONs into public/profiles/catalog.json.
// One fetch at runtime — and immune to the vite dev-middleware quirk that
// returns the SPA fallback for URLs whose filenames contain '@'.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'public/profiles';
const catalog = {};
let count = 0;
for (const brand of readdirSync(root)) {
  const bdir = join(root, brand);
  if (!statSync(bdir).isDirectory()) continue;
  catalog[brand] = { machine: [], process: [], filament: [] };
  for (const cat of ['machine', 'process', 'filament']) {
    try {
      for (const f of readdirSync(join(bdir, cat))) {
        if (!f.endsWith('.json')) continue;
        try {
          catalog[brand][cat].push(JSON.parse(readFileSync(join(bdir, cat, f), 'utf8')));
          count++;
        } catch (e) {
          console.warn('skip unparseable', brand, cat, f);
        }
      }
    } catch { /* category missing */ }
  }
}
writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog));
console.log(`catalog.json: ${count} profiles from ${Object.keys(catalog).join(', ')}`);
