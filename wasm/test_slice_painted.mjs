// Repro/regression: PAINTED (multi-material) slice under Node.
// Two stacked 10 mm cubes, bottom = filament 0, top = filament 1 — the
// smallest input that exercises libslic3r's multi-material tool-ordering
// (reorder_extruders_for_minimum_flush_volume and friends), which
// historically hit 32-bit OOBs on wasm32 (cf. patch 0074's crash class).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const createSlic3r = (await import(join(here, "dist/slic3r.mjs"))).default;

// 12 triangles of an axis-aligned box (outward CCW winding).
function boxTris(x0, y0, z0, x1, y1, z1) {
  const q = (a, b, c, d) => [a, b, c, a, c, d]; // quad → 2 tris
  const v = {
    a: [x0, y0, z0],
    b: [x1, y0, z0],
    c: [x1, y1, z0],
    d: [x0, y1, z0],
    e: [x0, y0, z1],
    f: [x1, y0, z1],
    g: [x1, y1, z1],
    h: [x0, y1, z1],
  };
  const faces = [
    q(v.a, v.d, v.c, v.b), // bottom (z0), normal -Z
    q(v.e, v.f, v.g, v.h), // top (z1), normal +Z
    q(v.a, v.b, v.f, v.e), // front (y0)
    q(v.b, v.c, v.g, v.f), // right (x1)
    q(v.c, v.d, v.h, v.g), // back (y1)
    q(v.d, v.a, v.e, v.h), // left (x0)
  ];
  return faces.flat().flat();
}

const bottom = boxTris(110, 110, 0, 130, 130, 10);
const top = boxTris(110, 110, 10, 130, 130, 20);
const positions = new Float32Array([...bottom, ...top]);
const triFilament = new Int32Array(positions.length / 9);
triFilament.fill(0, 0, 12);
triFilament.fill(1, 12);

const overrides = {
  // Mirrors OrcaWorkspace.sliceNow's paintedOverrides. filament_colour is
  // deliberately comma-joined (the historical web bug — ConfigOptionStrings
  // parses it as ONE value): the engine must survive that, not crash.
  single_extruder_multi_material: "1",
  nozzle_diameter: "0.4",
  filament_colour: "#FF0000,#00FF00",
  extruder_colour: "#FF0000,#00FF00",
  flush_volumes_matrix: "0,140,140,0",
  flush_volumes_vector: "140,140",
  enable_prime_tower: process.env.ORCAXR_PRIME_TOWER ?? "0",
  // Real profiles carry a per-layer G92 E0; the wipe tower requires the
  // relative-E mode that this keeps enabled (libslic3r gotcha #15).
  before_layer_change_gcode: "G92 E0\n",
};

console.log("loading WASM slicer module...");
const mod = await createSlic3r();
console.log("module ready:", mod.versionString());

const posBytes = new Uint8Array(positions.buffer);
const filBytes = new Uint8Array(triFilament.buffer);
mod.FS.writeFile("/tmp/orcaxr_painted_pos.bin", posBytes);
mod.FS.writeFile("/tmp/orcaxr_painted_fil.bin", filBytes);

const t0 = Date.now();
mod.startSlicePainted(
  "/tmp/orcaxr_painted_pos.bin",
  "/tmp/orcaxr_painted_fil.bin",
  2,
  Number(process.env.ORCAXR_TBB ?? 4),
  JSON.stringify(overrides),
);

const gcode = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const out = mod.pollSlice();
    if (out.length > 0) {
      clearInterval(timer);
      resolve(out);
    } else if (Date.now() - t0 > 600_000) {
      clearInterval(timer);
      reject(new Error("painted slice timed out after 600 s"));
    }
  }, 100);
});

if (gcode.startsWith("ORCAXR_ERROR:")) {
  console.error("PAINTED SLICE FAILED:", gcode.slice(0, 800));
  process.exit(1);
}
const toolChanges = (gcode.match(/^T\d+/gm) ?? []).length;
const layers = (gcode.match(/; CHANGE_LAYER|;LAYER_CHANGE/g) ?? []).length;
console.log(
  `painted slice OK in ${Date.now() - t0} ms: ${(gcode.length / 1024).toFixed(0)} KB, ${layers} layers, ${toolChanges} tool changes`,
);
if (toolChanges < 1) {
  console.error("FAIL: expected at least one tool change (T0→T1)");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
