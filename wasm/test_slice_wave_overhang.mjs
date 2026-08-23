// Test wave-overhang slicing in WASM with Andersons and Kaiser algorithms.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const createSlic3r = (await import(join(here, "dist/slic3r.mjs"))).default;

const stl = readFileSync(join(here, "../docs/slicer/models/3dbenchy.stl"));

console.log("loading WASM slicer module...");
const mod = await createSlic3r();
console.log("module ready:", mod.versionString());

async function sliceWithOverrides(overrides, label) {
  mod.FS.writeFile("/tmp/wave_in.stl", new Uint8Array(stl));
  const t0 = Date.now();
  console.log(`[${label}] starting slice...`);
  mod.startSliceFile("/tmp/wave_in.stl", 4, JSON.stringify(overrides));
  const gcode = await new Promise((res, rej) => {
    const t = setInterval(() => {
      const o = mod.pollSlice();
      if (o) {
        clearInterval(t);
        o.startsWith("ORCAXR_ERROR") ? rej(new Error(o)) : res(o);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(t);
      rej(new Error(`[${label}] timeout`));
    }, 300000);
  });
  console.log(`[${label}] sliced OK in ${Date.now() - t0} ms, ${(gcode.length / 1024) | 0} KB`);
  return gcode;
}

// 1. Andersons Algorithm Test
{
  const overrides = {
    wave_overhangs: "1",
    wave_overhang_algorithm: "andersons",
    wave_overhang_debug_gcode: "1",
    wave_overhang_print_speed: "35",
    wave_overhang_travel_speed: "80",
    wave_overhang_fan_speed: "90",
    wave_overhang_aux_fan_speed: "50",
    wave_overhang_floor_layers: "3",
    wave_overhang_floor_use_hilbert: "1",
    wave_overhang_floor_hilbert_layers: "2",
    wave_overhang_floor_hilbert_density: "95",
    wave_overhang_floor_print_speed: "40",
    wave_overhang_floor_perimeter_speed: "30",
    wave_overhang_floor_fan_speed: "85",
    wave_overhang_min_wave_time: "0.5",
    wave_overhang_min_layer_time: "1.0",
    wave_overhang_end_retract_length: "0.8",
  };

  const gcode = await sliceWithOverrides(overrides, "Andersons");
  assert(gcode.includes("; WAVE_OVERHANG_BUILD"), "Missing WAVE_OVERHANG_BUILD in G-code header");
  assert(gcode.includes("; WAVE_OVERHANG_CONFIG"), "Missing WAVE_OVERHANG_CONFIG in G-code header");
  assert(gcode.includes("algo=andersons"), "Header should declare algo=andersons");
  console.log("Andersons test passed!");
}

// 2. Kaiser LaSO Algorithm Test
{
  const overrides = {
    wave_overhangs: "1",
    wave_overhang_algorithm: "kaiser",
    wave_overhang_ring_overlap: "0.4",
    wave_overhang_debug_gcode: "1",
    wave_overhang_print_speed: "30",
    wave_overhang_travel_speed: "70",
    wave_overhang_fan_speed: "100",
    wave_overhang_floor_layers: "2",
  };

  const gcode = await sliceWithOverrides(overrides, "Kaiser");
  assert(gcode.includes("; WAVE_OVERHANG_BUILD"), "Missing WAVE_OVERHANG_BUILD in G-code header");
  assert(gcode.includes("; WAVE_OVERHANG_CONFIG"), "Missing WAVE_OVERHANG_CONFIG in G-code header");
  assert(gcode.includes("algo=kaiser"), "Header should declare algo=kaiser");
  console.log("Kaiser test passed!");
}

console.log("ALL WAVE OVERHANG WASM TESTS PASSED!");
process.exit(0);
