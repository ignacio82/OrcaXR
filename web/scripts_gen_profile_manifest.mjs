// Build-time: generate public/profiles/manifest.json (the browser can't
// list directories). Rerun after adding/removing profile JSONs.
import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'public/profiles';
const manifest = {};
for (const brand of readdirSync(root)) {
  if (!statSync(join(root, brand)).isDirectory()) continue;
  manifest[brand] = {};
  for (const cat of ['machine', 'process', 'filament']) {
    try {
      manifest[brand][cat] = readdirSync(join(root, brand, cat)).filter((f) => f.endsWith('.json'));
    } catch {
      manifest[brand][cat] = [];
    }
  }
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('manifest written:', Object.keys(manifest).join(', '));
