// File → Export Config… references from the production browser
// (`exportProfileConfigJson` in ConfigIO.ts over `ProfileCatalog`'s compiled
// profiles, as `OrcaWorkspace.exportActiveConfig` writes `orcaxr_config.json`):
// every profile of the bundled catalog (each file's SHA-256 and length) and
// every profile of synthetic catalogs written as text (each whole file): keys
// repeated within a preset (the first place, the last value), a child's and a
// later preset's keys after the ones they share, values with quotes, controls,
// line breaks, non-ASCII, emoji and an escaped lone surrogate, numbers,
// booleans, arrays of both separators and nulls. The shared core builds each
// catalog from the same JSON text and writes the same bytes (Rust, WASM in
// Node and Chrome, and JNI).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { exportProfileConfigJson } from "../../web/src/features/ConfigIO.ts";
import { ProfileCatalog } from "../../web/src/slicer/ProfileLoader.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const utf8 = (text) => Buffer.byteLength(text, "utf8");

const catalogPath = "web/public/profiles/catalog.json";
const bundledText = read(catalogPath);
const bundled = ProfileCatalog.fromRaw(JSON.parse(bundledText));
const profiles = bundled.profiles.map((profile, index) => {
  const file = exportProfileConfigJson(profile);
  return { index, id: profile.id, sha256: digest(file), bytes: utf8(file) };
});
assert.ok(profiles.length > 1000);

// Written as text: JSON.parse keeps a repeated key's first place and its last value.
const syntheticTexts = [
  String.raw`{"Acme": {
  "machine": [
    {"name": "Root", "from": "system", "instantiation": "false",
     "printable_area": ["0x0", "200x0", "200x200", "0x200"], "nozzle_diameter": ["0.4"],
     "machine_start_gcode": "G28 ; \"home\"\n\tM104 S{temp}\u0001 ☃ 😀 \ud800 end \\ /",
     "printer_notes": "root", "extruder_colour": ["#FF0000"], "printable_height": 180},
    {"name": "Printer A", "inherits": "Root", "from": "system", "instantiation": "true",
     "printer_notes": "child first", "nozzle_diameter": ["0.4", "0.4"], "printable_height": "250",
     "printer_notes": "repeated: the last value", "machine_end_gcode": "M84\r\n", "auxiliary_fan": true},
    {"name": "Printer B", "inherits": "Printer A", "from": "system", "instantiation": "true",
     "extruder_colour": ["#00FF00", "#0000FF"], "bed_exclude_area": [], "machine_start_gcode": null}
  ],
  "process": [
    {"name": "Fine", "from": "system", "compatible_printers": ["Printer A", "Printer B"], "wall_loops": "3",
     "layer_height": "0.12", "sparse_infill_density": "15%", "printer_notes": "process", "layer_height": 0.1},
    {"name": "Draft @Acme", "inherits": "Fine", "from": "system", "layer_height": 0.3, "wall_loops": 2}
  ],
  "filament": [
    {"name": "PLA @Acme", "from": "system", "compatible_printers": ["Printer A", "Printer B"],
     "filament_type": ["PLA"], "nozzle_temperature": [210, 215], "filament_colour": ["#00FF00"],
     "filament_start_gcode": ["; start\n", "; two"], "wall_loops": "2"},
    {"name": "Silk PLA @Acme", "inherits": "PLA @Acme", "from": "system", "filament_type": ["PLA"],
     "filament_colour": ["#C0C0C0"], "nozzle_temperature": [220, 225]}
  ]
}}`,
  String.raw`{"Solo": {
  "machine": [{"name": "Lonely é", "from": "system", "instantiation": "true", "printer_notes": ""}],
  "process": [{"name": "Only", "from": "system", "compatible_printers": ["Lonely é"]}],
  "filament": [{"name": "Plain", "from": "system", "compatible_printers": ["Lonely é"]}]
}}`,
];
const synthetic = syntheticTexts.map((catalogText) => {
  const catalog = ProfileCatalog.fromRaw(JSON.parse(catalogText));
  assert.ok(catalog.profiles.length > 0, "a synthetic catalog compiles no profile");
  return {
    catalogText,
    profiles: catalog.profiles.map((profile, index) => ({ index, id: profile.id, json: exportProfileConfigJson(profile) })),
  };
});

const sources = [
  "tools/cross-platform/config-export-vectors.mjs",
  "web/src/features/ConfigIO.ts",
  "web/src/slicer/ProfileLoader.ts",
  "web/src/slicer/profileKeys.ts",
  "web/src/settings/presets/PresetGraph.ts",
  catalogPath,
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: digest(read(path)) })),
      bundled: { catalog: catalogPath, profiles },
      synthetic,
    },
    null,
    2,
  ) + "\n";
const path = new URL("testdata/cross-platform/config-export-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Config export reference drift");
console.log(
  `config exports: ${profiles.length} bundled profiles, ` +
    `${synthetic.reduce((n, s) => n + s.profiles.length, 0)} synthetic in ${synthetic.length} catalogs`,
);
