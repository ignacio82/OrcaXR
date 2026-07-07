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
function flatten(leaf, byName) {
  const chain = [];
  let current = leaf;
  let depth = 0;
  while (current && depth < 10) {
    chain.push(current);
    const parent = str(current.inherits);
    current = parent ? byName.get(parent) : undefined;
    depth += 1;
  }
  return {};
}

let count = 0;
for (const cats of Object.values(catalog)) {
  const machines = cats.machine || [];
  const processes = cats.process || [];
  const filaments = cats.filament || [];
  const byName = new Map();
  for (const j of [...machines, ...processes, ...filaments]) {
    const name = str(j.name);
    if (name) byName.set(name, j);
  }
  for (const machine of leavesOf(machines)) {
    const machineCfg = flatten(machine, byName);
    for (const process of leavesOf(processes)) {
      const processCfg = flatten(process, byName);
      for (const filament of leavesOf(filaments)) {
        const filamentCfg = flatten(filament, byName);
        count++;
      }
    }
  }
}
console.log("Total profiles:", count);
