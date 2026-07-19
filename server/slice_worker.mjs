import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function detectSliceInputKind(modelPath, bytes) {
  const extension = path.extname(modelPath).toLowerCase();
  const isZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08));

  if (extension === ".3mf") {
    if (!isZip) throw new Error("3MF input does not have a ZIP signature");
    return "project";
  }
  if (isZip) {
    throw new Error("ZIP project input must use the validated .3mf route");
  }
  if (extension !== ".stl") {
    throw new Error(`Unsupported slicer input extension: ${extension || "(none)"}`);
  }
  return "model";
}

/**
 * Copy one already-validated upload into MEMFS and select the matching WASM
 * entry point. Project 3MFs must retain their embedded graph/config and may
 * never be flattened through the mono STL path.
 */
export function startSliceInput(
  module,
  modelPath,
  bytes,
  overridesJson,
  maxThreads = 4,
) {
  const kind = detectSliceInputKind(modelPath, bytes);
  const inputPath = kind === "project" ? "/tmp/in.3mf" : "/tmp/in.stl";
  module.FS.writeFile(inputPath, new Uint8Array(bytes));

  if (kind === "project") {
    if (typeof module.startSliceProject !== "function") {
      throw new Error("WASM artifact does not expose startSliceProject");
    }
    module.startSliceProject(inputPath, maxThreads, overridesJson);
  } else {
    if (typeof module.startSliceFile !== "function") {
      throw new Error("WASM artifact does not expose startSliceFile");
    }
    module.startSliceFile(inputPath, maxThreads, overridesJson);
  }
  return { kind, inputPath };
}

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

  const modelData = fs.readFileSync(modelPath);
  startSliceInput(module, modelPath, modelData, overridesJson, 4);

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

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
