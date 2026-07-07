const fs = require('fs');
const catalog = JSON.parse(fs.readFileSync('web/public/profiles/catalog.json'));
function str(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => `${x}`).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}`;
}
function leavesOf(jsons) {
  const parentNames = new Set(
    jsons.map((j) => str(j.inherits)).filter((s) => s.length > 0)
  );
  return jsons.filter((j) => {
    const name = str(j.name);
    if (!name) return false;
    const inst = j.instantiation;
    if (inst !== undefined) return str(inst) !== 'false';
    return !parentNames.has(name);
  });
}

for (const brand in catalog) {
    const cats = catalog[brand];
    const machines = cats.machine || [];
    const processes = cats.process || [];
    const filaments = cats.filament || [];
    console.log(brand, 'machines:', leavesOf(machines).length, 'processes:', leavesOf(processes).length, 'filaments:', leavesOf(filaments).length);
}
