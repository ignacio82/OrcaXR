import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const modelPath = process.argv[2];
  const configPath = process.argv[3];
  const outputPath = process.argv[4];

  if (!modelPath || !configPath || !outputPath) {
    console.error(
      "Usage: node slice_worker.js <model.stl> <config.json> <output.gcode>",
    );
    process.exit(1);
  }

  const overridesJson = fs.readFileSync(configPath, "utf8");

  const configuredWasmDir = process.env.ORCAXR_WASM_DIR;
  const candidates = [
    configuredWasmDir,
    path.resolve(__dirname, "wasm/dist"),
    path.resolve(__dirname, "../wasm/dist"),
  ].filter(Boolean);
  const wasmDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "slic3r.mjs")),
  );
  if (!wasmDir) {
    throw new Error(
      `WASM artifacts not found; checked: ${candidates.join(", ")}`,
    );
  }
  const wasmPath = path.join(wasmDir, "slic3r.mjs");
  const createSlic3r = (await import(wasmPath)).default;
  const module = await createSlic3r();

  // Read the STL into WASM FS
  const stlData = fs.readFileSync(modelPath);
  module.FS.writeFile("/tmp/in.stl", new Uint8Array(stlData));

  module.startSliceFile("/tmp/in.stl", 4, overridesJson);

  const gcode = await new Promise((res, rej) => {
    const t = setInterval(() => {
      const o = module.pollSlice();
      if (o) {
        if (o.startsWith("[orcaxr]")) {
          console.log(o); // Progress
        } else if (o.startsWith("ORCAXR_ERROR")) {
          clearInterval(t);
          rej(new Error(o));
        } else {
          clearInterval(t);
          res(o);
        }
      }
    }, 100);
  });

  fs.writeFileSync(outputPath, gcode);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
