// Build-time: bundle ALL profile JSONs into public/profiles/catalog.json.
// One fetch at runtime — and immune to the vite dev-middleware quirk that
// returns the SPA fallback for URLs whose filenames contain '@'.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = process.argv.includes('--check');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(', ')}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'profiles');
const catalog = {};
let count = 0;
for (const brand of readdirSync(root).sort()) {
  const bdir = join(root, brand);
  if (!statSync(bdir).isDirectory()) continue;
  catalog[brand] = { machine: [], process: [], filament: [] };
  for (const cat of ['machine', 'process', 'filament']) {
    try {
      for (const f of readdirSync(join(bdir, cat)).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          catalog[brand][cat].push(JSON.parse(readFileSync(join(bdir, cat, f), 'utf8')));
          count++;
        } catch {
          console.warn('skip unparseable', brand, cat, f);
        }
      }
    } catch {
      /* category missing */
    }
  }
}

const catalogPath = join(root, 'catalog.json');
const expected = JSON.stringify(catalog);
if (check) {
  if (readFileSync(catalogPath, 'utf8') !== expected) {
    console.error('public/profiles/catalog.json is stale; run `npm run profiles:sync`.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(catalogPath, expected);
}

if (process.exitCode !== 1) {
  console.log(`catalog.json: ${count} profiles from ${Object.keys(catalog).join(', ')}`);
}
