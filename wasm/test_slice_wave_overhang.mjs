// Wave overhangs, end to end in the WASM engine.
//
// The previous version of this file asserted three header strings and never
// ran in a clean clone (it read a model from a path that does not exist), so a
// build whose wave paths printed at full speed, whose debug lines broke the
// Snapmaker U1's header parser, and whose sources were missing passed it. Each
// check here pins one behaviour the port must keep, on geometry built in this
// file so the expected answer is known:
//
//   cantilever  an L-section prism: a 15 mm horizontal shelf off a 10 mm pillar.
//               Its first shelf layer is pure overhang — wave territory.
//   bridge      a 15 mm flat span between two pillars: a simple bridge, which
//               upstream leaves to the bridge pipeline unless told otherwise.
//   mixed       one island carrying both, on the same layer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const createSlic3r = (await import(join(here, "dist/slic3r.mjs"))).default;

// ---- geometry -----------------------------------------------------------------

/** Ear-clip a simple counter-clockwise polygon (2D points) into index triples. */
function triangulate(points) {
  const index = points.map((_, i) => i);
  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => area2(a, b, p) > 0 && area2(b, c, p) > 0 && area2(c, a, p) > 0;
  const triangles = [];
  while (index.length > 3) {
    let clipped = false;
    for (let i = 0; i < index.length; i++) {
      const [ia, ib, ic] = [index[(i + index.length - 1) % index.length], index[i], index[(i + 1) % index.length]];
      const [a, b, c] = [points[ia], points[ib], points[ic]];
      if (area2(a, b, c) <= 0) continue;
      if (index.some((j) => j !== ia && j !== ib && j !== ic && inside(points[j], a, b, c))) continue;
      triangles.push([ia, ib, ic]);
      index.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("triangulate: polygon is not simple and counter-clockwise");
  }
  triangles.push(index);
  return triangles;
}

/** A closed prism's triangles: `profile` is a CCW polygon in the XZ plane, extruded along Y. */
function prismTriangles(profile, depth) {
  const tris = [];
  const at = ([x, z], y) => [x, y, z];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    tris.push([at(a, 0), at(b, 0), at(b, depth)], [at(a, 0), at(b, depth), at(a, depth)]);
  }
  for (const [i, j, k] of triangulate(profile)) {
    tris.push([at(profile[i], 0), at(profile[k], 0), at(profile[j], 0)]);
    tris.push([at(profile[i], depth), at(profile[j], depth), at(profile[k], depth)]);
  }
  return tris;
}

function prismStl(profile, depth) {
  const tris = prismTriangles(profile, depth);
  const buffer = Buffer.alloc(84 + tris.length * 50);
  buffer.writeUInt32LE(tris.length, 80);
  let offset = 84;
  for (const triangle of tris) {
    offset += 12;
    for (const [x, y, z] of triangle) {
      buffer.writeFloatLE(x, offset);
      buffer.writeFloatLE(y, offset + 4);
      buffer.writeFloatLE(z, offset + 8);
      offset += 12;
    }
    offset += 2;
  }
  return buffer;
}

// Shelf from z = 8 to 11 reaching 15 mm past a 10 mm pillar.
const CANTILEVER = [[0, 0], [10, 0], [10, 8], [25, 8], [25, 11], [0, 11]];
const cantilever = prismStl(CANTILEVER, 20);
// A 15 mm span between two 5 mm pillars.
const bridge = prismStl([[0, 0], [5, 0], [5, 8], [20, 8], [20, 0], [25, 0], [25, 11], [0, 11]], 20);
// One island with both: a 15 mm span (x 5..20) and a 15 mm shelf (x 25..40).
const mixed = prismStl([[0, 0], [5, 0], [5, 8], [20, 8], [20, 0], [25, 0], [25, 8], [40, 8], [40, 11], [0, 11]], 20);
const benchy = readFileSync(join(here, "../web/public/models/3dbenchy.stl"));

// ---- engine -------------------------------------------------------------------

const engine = await createSlic3r({ printErr: () => {} });

// Keep every speed the engine computes visible in the G-code: layer-time cooling
// would otherwise rescale feed rates on these small layers and hide whether an
// override applied.
const BASE = { slow_down_for_layer_cooling: "0" };

/** Slice triangles through the painted path, every triangle on `filament` (0-based). */
async function slicePainted(tris, filamentCount, filament, overrides) {
  const positions = new Float32Array(tris.flat(2).map((v, i) => (i % 3 === 2 ? v : v + 100)));
  const owners = new Int32Array(tris.length).fill(filament);
  engine.FS.writeFile("/tmp/wave_pos.bin", new Uint8Array(positions.buffer));
  engine.FS.writeFile("/tmp/wave_fil.bin", new Uint8Array(owners.buffer));
  engine.startSlicePainted("/tmp/wave_pos.bin", "/tmp/wave_fil.bin", filamentCount, 4, JSON.stringify({ ...BASE, ...overrides }));
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const output = engine.pollSlice();
      if (!output) return;
      clearInterval(timer);
      if (output.startsWith("ORCAXR_ERROR")) reject(new Error(output));
      else resolve(output);
    }, 50);
  });
}

async function slice(model, overrides) {
  engine.FS.writeFile("/tmp/wave_in.stl", new Uint8Array(model));
  engine.startSliceFile("/tmp/wave_in.stl", 4, JSON.stringify({ ...BASE, ...overrides }));
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const output = engine.pollSlice();
      if (!output) return;
      clearInterval(timer);
      if (output.startsWith("ORCAXR_ERROR")) reject(new Error(output));
      else resolve(output);
    }, 50);
  });
}

// ---- G-code scanner -----------------------------------------------------------

/**
 * Walk the G-code once and record, per layer, what printed and how: every
 * extruding move with its role, feed rate, fan, and whether it sat inside a
 * `; WAVE_OVERHANG_START/END` block. Handles both relative and absolute E.
 */
function scan(gcode) {
  const layers = [];
  let layer = null;
  let role = "";
  let feed = 0;
  let fan = 0;
  let relative = false;
  let e = 0;
  let inWave = false;
  let wave = null;
  let x = 0;
  const waves = [];
  for (const raw of gcode.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(";Z:")) {
      layer = { z: Number(line.slice(3)), moves: [], roles: new Set() };
      layers.push(layer);
      continue;
    }
    if (line.startsWith(";TYPE:")) {
      role = line.slice(6);
      layer?.roles.add(role);
      continue;
    }
    if (line === "; WAVE_OVERHANG_START") {
      inWave = true;
      wave = { lines: [], extrusions: 0, z: layer?.z };
      waves.push(wave);
      continue;
    }
    if (line === "; WAVE_OVERHANG_END") {
      inWave = false;
      continue;
    }
    if (inWave) wave.lines.push(line);
    if (line === "M83") relative = true;
    if (line === "M82") relative = false;
    if (line.startsWith("M107")) fan = 0;
    const fanMatch = /^M106(?:\s+P0)?\s+S(\d+)/.exec(line);
    if (fanMatch) fan = Number(fanMatch[1]);
    if (/^G92\b/.test(line)) {
      const reset = /E(-?[\d.]+)/.exec(line);
      if (reset) e = Number(reset[1]);
      continue;
    }
    if (!/^G[0123]\b/.test(line)) continue;
    const words = Object.fromEntries([...line.split(";")[0].matchAll(/([XYZEF])(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
    if (words.F !== undefined) feed = words.F;
    if (words.E === undefined) continue;
    const delta = relative ? words.E : words.E - e;
    if (!relative) e = words.E;
    if (words.X !== undefined) x = words.X;
    if (delta > 0 && (words.X !== undefined || words.Y !== undefined)) {
      layer?.moves.push({ role, feed, fan, wave: inWave, x });
      if (inWave) wave.extrusions += 1;
    }
  }
  return { layers, waves };
}

const headerBlock = (gcode) => {
  const start = gcode.indexOf("; HEADER_BLOCK_START");
  const end = gcode.indexOf("; HEADER_BLOCK_END");
  assert.ok(start >= 0 && end > start, "G-code must carry a HEADER_BLOCK");
  return gcode.slice(start, end);
};

const configBlock = (gcode) =>
  Object.fromEntries(
    [...gcode.matchAll(/^; ([a-z0-9_]+) = (.*)$/gm)].map(([, key, value]) => [key, value.trim()]),
  );

const count = (gcode, needle) => gcode.split(needle).length - 1;

let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("wave overhangs (WASM engine)");

// ---- baseline ----------------------------------------------------------------

const off = await slice(cantilever, { wave_overhangs: "0" });
await check("with the master switch off the engine emits no wave paths and the shelf bridges as before", () => {
  assert.equal(count(off, "WAVE_OVERHANG"), 0);
  assert.ok(count(off, ";TYPE:Bridge") > 0, "the shelf's first layer should be a bridge without waves");
});

// ---- defaults ----------------------------------------------------------------

const on = await slice(cantilever, { wave_overhangs: "1" });
const onScan = scan(on);
const waveLayers = [...new Set(onScan.waves.map((w) => w.z))];

await check("waves replace the bridge on the first shelf layer, and only there", () => {
  assert.ok(onScan.waves.length >= 20, `expected a full set of wave lines, got ${onScan.waves.length}`);
  assert.ok(onScan.waves.every((w) => w.extrusions > 0), "every wave block must extrude");
  assert.deepEqual(waveLayers, [8.2]);
  const shelf = onScan.layers.find((l) => l.z === 8.2);
  assert.ok(!shelf.roles.has("Bridge"), "a wave layer must not also bridge");
});

await check("HEADER_BLOCK stays the stock shape; the wave lines follow it (U1 rejects unknown header keys)", () => {
  assert.doesNotMatch(headerBlock(on), /WAVE_OVERHANG/);
  const afterHeader = on.slice(on.indexOf("; HEADER_BLOCK_END")).split("\n").slice(1, 5).join("\n");
  assert.match(afterHeader, /^; WAVE_OVERHANG_BUILD wave_overhangs_version=v0\.4\.0 orca_base=Snapmaker Orca /m);
  assert.match(afterHeader, /^; WAVE_OVERHANG_CONFIG region=0 outer_perim=1 spacing=0\.350 flow_mm3_per_mm=0\.150 speed=2\.0 travel=40\.0 fan=100 floor_layers=2 /m);
  assert.doesNotMatch(on, /algo=/, "the retired algorithm selector must not reappear");
});

await check("every wave extrusion prints at the 2 mm/s default with the part fan at full", () => {
  const waveMoves = onScan.layers.flatMap((l) => l.moves.filter((m) => m.wave));
  assert.ok(waveMoves.length > 0);
  for (const move of waveMoves) {
    assert.equal(move.feed, 120, `wave move at F${move.feed}`);
    assert.equal(move.fan, 255, `wave move with fan S${move.fan}`);
    assert.equal(move.role, "Overhang wall");
  }
});

await check("exactly two solid floor layers above the wave strip, then sparse infill", async () => {
  // Solid infill over the shelf itself (x > 10 mm), ignoring slivers at the pillar edge.
  const shelfSolid = (result, z) =>
    result.layers
      .find((l) => Math.abs(l.z - z) < 1e-6)
      ?.moves.filter((m) => m.role === "Internal solid infill" && m.x > 10.5).length ?? 0;
  assert.ok(shelfSolid(onScan, 8.4) > 20, "floor layer 1 must be solid over the shelf");
  assert.ok(shelfSolid(onScan, 8.6) > 20, "floor layer 2 must be solid over the shelf");
  assert.equal(shelfSolid(onScan, 8.8), 0, "floor_layers=2 is authoritative, not added to bottom shells");
  const zero = scan(await slice(cantilever, { wave_overhangs: "1", wave_overhang_floor_layers: "0" }));
  assert.equal(shelfSolid(zero, 8.4), 0, "floor_layers=0 goes straight to sparse infill");
  const four = scan(await slice(cantilever, { wave_overhangs: "1", wave_overhang_floor_layers: "4" }));
  assert.ok(shelfSolid(four, 9.0) > 20, "floor_layers=4 keeps the fourth layer solid");
  assert.equal(shelfSolid(four, 9.2), 0, "and stops after it");
});

await check("the engine's defaults are exactly the web settings table's, key for key", () => {
  const source = readFileSync(join(here, "../web/src/settings/waveOverhangs.ts"), "utf8");
  const table = new Map(
    [...source.matchAll(/\{\s*key: (?:'([a-z0-9_]+)'|WAVE_MASTER_KEY),\s*group: '[a-z]+',\s*kind: '([a-z]+)',\s*engineDefault: ([^,]+),/g)].map(
      ([, key, kind, value]) => [key ?? "wave_overhangs", { kind, value: value.trim() }],
    ),
  );
  const config = configBlock(on);
  const engineKeys = Object.keys(config).filter(
    (key) => key.startsWith("wave_overhang") || key === "support_remaining_areas_after_wave_overhangs",
  );
  assert.equal(table.size, 38, "the web table must describe all 38 options");
  assert.deepEqual([...table.keys()].sort(), engineKeys.sort());
  for (const [key, { kind, value }] of table) {
    const engine = config[key];
    const expected =
      kind === "bool" ? (value === "true" ? "1" : "0") : kind === "enum" ? value.replace(/'/g, "") : String(Number(value));
    const actual = kind === "int" || kind === "float" ? String(Number(engine)) : engine;
    if (key === "wave_overhangs") assert.equal(config[key], "1");
    else assert.equal(actual, expected, `${key}: engine ${engine}, table ${value}`);
  }
});

// ---- overrides ---------------------------------------------------------------

await check("print speed, fan, travel, and end-of-line retract overrides reach the G-code", async () => {
  const gcode = await slice(cantilever, {
    wave_overhangs: "1",
    wave_overhang_print_speed: "3",
    wave_overhang_fan_speed: "60",
    wave_overhang_travel_speed: "25",
    wave_overhang_end_retract_length: "0.6",
  });
  const result = scan(gcode);
  const waveMoves = result.layers.flatMap((l) => l.moves.filter((m) => m.wave));
  assert.ok(waveMoves.length > 0);
  for (const move of waveMoves) {
    assert.equal(move.feed, 180, `wave move at F${move.feed}`);
    assert.equal(move.fan, 153, `wave move with fan S${move.fan}`);
  }
  assert.ok(gcode.includes("F1500"), "the 25 mm/s wave travel should appear");
  for (const wave of result.waves) {
    const motion = wave.lines.map((line) => line.split(";")[0].trim()).filter((line) => /^G[0-3]\b/.test(line));
    const last = motion.pop();
    assert.match(last, /^G1 E-?[\d.]+ F\d+$/, `wave block ends without a retract: ${last}`);
  }
});

await check("floor perimeter speed applies on floor layers and ramps back over wave_overhang_floor_speed_ramp", async () => {
  const wallFeeds = (result, z) => {
    const layer = result.layers.find((l) => Math.abs(l.z - z) < 1e-6);
    return [...new Set(layer.moves.filter((m) => /wall/.test(m.role)).map((m) => m.feed))];
  };
  const step = scan(await slice(cantilever, { wave_overhangs: "1", wave_overhang_floor_perimeter_speed: "10" }));
  assert.deepEqual(wallFeeds(step, 8.4), [600]);
  assert.deepEqual(wallFeeds(step, 8.6), [600]);
  const ramp = scan(
    await slice(cantilever, {
      wave_overhangs: "1",
      wave_overhang_floor_perimeter_speed: "10",
      wave_overhang_floor_speed_ramp: "2",
    }),
  );
  const first = wallFeeds(ramp, 8.4);
  const second = wallFeeds(ramp, 8.6);
  assert.ok(first.every((f) => f > 600), `ramp layer 1 should be faster than the override: ${first}`);
  assert.ok(
    second.every((f, i) => f > (first[i] ?? first[0])),
    `ramp layer 2 should be faster than layer 1: ${second} vs ${first}`,
  );
});

await check("a Hilbert floor is tagged as a wave floor, so its speed override applies to the floor infill", async () => {
  const result = scan(
    await slice(cantilever, {
      wave_overhangs: "1",
      wave_overhang_floor_use_hilbert: "1",
      wave_overhang_floor_print_speed: "5",
    }),
  );
  for (const z of [8.4, 8.6]) {
    const layer = result.layers.find((l) => Math.abs(l.z - z) < 1e-6);
    const solid = layer.moves.filter((m) => m.role === "Internal solid infill" && m.x > 10.5);
    assert.ok(solid.length > 0, `no floor infill at z=${z}`);
    assert.ok(solid.every((m) => m.feed === 300), `floor infill at z=${z} not at 5 mm/s`);
  }
});

await check("fan and nozzle-temperature overrides hold across a whole run of wave lines (upstream toggled them per line)", async () => {
  const gcode = await slice(cantilever, {
    wave_overhangs: "1",
    wave_overhang_nozzle_temp: "190",
    nozzle_temperature: "215",
    fan_min_speed: "30",
    fan_max_speed: "40",
    overhang_fan_speed: "40",
  });
  assert.equal(count(gcode, "wave-overhang temp override"), 1, "one override per run, not per line");
  assert.equal(count(gcode, "wave-overhang temp restore"), 1, "one restore per run");
  assert.match(gcode, /^M104 S190 ; wave-overhang temp override$/m);
  assert.match(gcode, /^M104 S215 ; wave-overhang temp restore$/m);
  const run = gcode.slice(gcode.indexOf("; WAVE_OVERHANG_START"), gcode.lastIndexOf("; WAVE_OVERHANG_END"));
  const fans = [...run.matchAll(/^M106 S(\d+)/gm)].map(([, speed]) => Number(speed));
  assert.ok(fans.every((speed) => speed === 255), `the fan dropped inside the wave run: ${fans}`);
  const result = scan(gcode);
  assert.ok(result.layers.flatMap((l) => l.moves.filter((m) => m.wave)).every((m) => m.fan === 255));
});

await check("the temperature restore returns the active tool to its own temperature (upstream used filament 1's)", async () => {
  const gcode = await slicePainted(prismTriangles(CANTILEVER, 20), 2, 1, {
    single_extruder_multi_material: "1",
    nozzle_diameter: "0.4",
    filament_colour: "#FF0000;#00FF00",
    nozzle_temperature: "215,235",
    before_layer_change_gcode: "G92 E0\n",
    wave_overhangs: "1",
    wave_overhang_nozzle_temp: "200",
  });
  assert.ok(count(gcode, "; WAVE_OVERHANG_START") > 0);
  assert.match(gcode, /^M104 S200 ; wave-overhang temp override$/m);
  assert.match(gcode, /^M104 S235 ; wave-overhang temp restore$/m);
  assert.doesNotMatch(gcode, /^M104 S215 ; wave-overhang temp restore$/m);
});

// ---- supports ----------------------------------------------------------------

for (const supportType of ["normal(auto)", "tree(auto)"]) {
  await check(`${supportType} supports cover only what the waves did not`, async () => {
    const supports = { enable_support: "1", support_type: supportType };
    const without = await slice(cantilever, { ...supports, wave_overhangs: "0" });
    assert.ok(count(without, ";TYPE:Support") > 0, "the shelf needs support without waves");
    const withWaves = await slice(cantilever, { ...supports, wave_overhangs: "1" });
    assert.equal(count(withWaves, ";TYPE:Support"), 0, "the waves cover the whole shelf");
    const ignoring = await slice(cantilever, {
      ...supports,
      wave_overhangs: "1",
      support_remaining_areas_after_wave_overhangs: "0",
    });
    assert.ok(count(ignoring, ";TYPE:Support") > 0, "with the option off, support ignores wave coverage");
  });
}

// ---- bridges -----------------------------------------------------------------

await check("a simple flat bridge stays a bridge unless instead-of-bridges is on", async () => {
  const plain = await slice(bridge, { wave_overhangs: "1" });
  assert.equal(count(plain, "; WAVE_OVERHANG_START"), 0, "a bridgeable span is left to the bridge pipeline");
  assert.ok(count(plain, ";TYPE:Bridge") > 0);
  const forced = await slice(bridge, { wave_overhangs: "1", wave_overhangs_instead_of_bridges: "1" });
  assert.ok(count(forced, "; WAVE_OVERHANG_START") > 0, "instead-of-bridges waves the span too");
  assert.equal(count(forced, ";TYPE:Bridge"), 0, "and no bridge pattern remains");
});

await check("an island with a skipped bridge and a waved shelf keeps the bridge (upstream carved it away)", async () => {
  const result = scan(await slice(mixed, { wave_overhangs: "1" }));
  const first = result.layers.find((l) => Math.abs(l.z - 8.2) < 1e-6);
  assert.ok(result.waves.length > 0, "the shelf is waved");
  assert.ok(result.waves.every((w) => w.z === 8.2));
  const bridgeLines = first.moves.filter((m) => m.role === "Bridge");
  assert.ok(bridgeLines.length > 20, `the span must still bridge, got ${bridgeLines.length} bridge moves`);
  assert.ok(bridgeLines.every((m) => m.x < 25.5), "bridge lines belong to the span, not the waved shelf");
  const waveMoves = first.moves.filter((m) => m.wave);
  assert.ok(waveMoves.every((m) => m.x > 24), "waves belong to the shelf");
});

await check("tree supports in that island keep the bridge's support and drop the shelf's", async () => {
  const supportSpan = (gcode) => {
    const result = scan(gcode);
    const xs = result.layers
      .filter((l) => l.z >= 7.4 && l.z <= 7.81)
      .flatMap((l) => l.moves.filter((m) => m.role.startsWith("Support")).map((m) => m.x));
    return { min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
  };
  const supports = { enable_support: "1", support_type: "tree(auto)" };
  const without = supportSpan(await slice(mixed, { ...supports, wave_overhangs: "0" }));
  assert.ok(without.max > 30, "without waves the shelf is supported too");
  const withWaves = supportSpan(await slice(mixed, { ...supports, wave_overhangs: "1" }));
  assert.ok(withWaves.n > 0, "the bridge span keeps its support");
  assert.ok(withWaves.max < 21, `no support may remain under the waved shelf, max x ${withWaves.max}`);
});

// ---- real geometry -----------------------------------------------------------

await check("Benchy slices with waves on (degenerate overhang slivers must not crash the port)", async () => {
  const gcode = await slice(benchy, { wave_overhangs: "1", wave_overhang_min_length: "2" });
  assert.ok(count(gcode, "; WAVE_OVERHANG_START") > 0);
  assert.doesNotMatch(headerBlock(gcode), /WAVE_OVERHANG/);
});

console.log(`ALL ${passed} WAVE OVERHANG WASM CHECKS PASSED`);
process.exit(0);
