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
  return {};
}

let profiles = [];
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
    for (const process of leavesOf(processes)) {
      for (const filament of leavesOf(filaments)) {
        const machineName = str(machine.name);
        const processName = str(process.name);
        const filamentName = str(filament.name);
        const processShort = processName.split('@')[0].trim();
        const filamentShort = filamentName.split('@')[0].trim();
        profiles.push({
          machineName,
          processName,
          filamentName: filamentShort,
        });
      }
    }
  }
}

function find(machine, process, filament) {
    const m = machine.toLowerCase();
    const p = process.toLowerCase();
    const f = filament.toLowerCase();
    return (
      profiles.find(
        (x) =>
          x.machineName.toLowerCase().includes(m) &&
          x.processName.toLowerCase().includes(p) &&
          x.filamentName.toLowerCase().includes(f),
      ) || null
    );
}
console.log(find('Snapmaker U1 (0.4 nozzle)', '0.20 Standard', 'Snapmaker PLA'));
