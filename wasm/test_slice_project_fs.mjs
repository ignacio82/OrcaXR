// FullSpectrum project slice: a project 3MF with mixed_filament_definitions
// (virtual filaments) sliced via startSliceProject — the embedded project
// config drives the slice, exactly like desktop Snapmaker Orca opening the
// file. Expects REAL multi-tool G-code (the engine is the Snapmaker fork,
// which ships Full Spectrum natively since v2.3.3).
// Usage: node test_slice_project_fs.mjs [path/to/project.3mf]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const createSlic3r = (await import(join(here, "dist/slic3r.mjs"))).default;

const projectPath =
  process.argv[2] ?? join(here, "../web/public/models/multicolor_hexagon.3mf");
const buf = readFileSync(projectPath);

console.log("loading WASM slicer module...");
const mod = await createSlic3r();
console.log("module ready:", mod.versionString());

mod.FS.writeFile("/tmp/orcaxr_proj.3mf", new Uint8Array(buf));
const t0 = Date.now();
mod.startSliceProject(
  "/tmp/orcaxr_proj.3mf",
  Number(process.env.ORCAXR_TBB ?? 4),
  "{}",
);

const gcode = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const out = mod.pollSlice();
    if (out.length > 0) {
      clearInterval(timer);
      resolve(out);
    } else if (Date.now() - t0 > 1_200_000) {
      clearInterval(timer);
      reject(new Error("timed out"));
    }
  }, 200);
});

if (gcode.startsWith("ORCAXR_ERROR:")) {
  console.error("PROJECT SLICE FAILED:", gcode.slice(0, 600));
  process.exit(1);
}
const tools = [...new Set(gcode.match(/^T\d+$/gm) ?? [])].sort();
const toolChanges = (gcode.match(/^T\d+$/gm) ?? []).length;
const layers = (gcode.match(/LAYER_CHANGE|CHANGE_LAYER/g) ?? []).length;
if (process.env.ORCAXR_SAVE) writeFileSync(process.env.ORCAXR_SAVE, gcode);
console.log(
  `project slice OK in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${(gcode.length / 1048576).toFixed(1)} MB, ${layers} layers, ${toolChanges} tool changes, tools ${tools.join(",")}`,
);
if (tools.length < 2) {
  console.error("FAIL: expected multi-tool G-code from a FullSpectrum project");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
