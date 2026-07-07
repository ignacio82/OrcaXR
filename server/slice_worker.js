const fs = require('fs');
const Slic3rModule = require('../wasm/dist/slic3r_wasm.js');

async function run() {
  const modelPath = process.argv[2];
  const configPath = process.argv[3];
  const outputPath = process.argv[4];

  if (!modelPath || !configPath || !outputPath) {
    console.error('Usage: node slice_worker.js <model.stl> <config.json> <output.gcode>');
    process.exit(1);
  }

  const overridesJson = fs.readFileSync(configPath, 'utf8');
  
  const module = await Slic3rModule();
  
  // Read the STL into WASM FS
  const stlData = fs.readFileSync(modelPath);
  module.FS.writeFile('/model.stl', stlData);

  let outputReady = false;

  // Poll progress
  const interval = setInterval(() => {
    try {
      const line = module.pollSlice();
      if (line) {
        if (line.includes('G-Code saved to')) {
          outputReady = true;
        } else if (line.startsWith('[error]')) {
          console.error(line);
          process.exit(1);
        } else {
          console.log(line); // log to stderr/stdout to trace progress
        }
      }
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }, 100);

  try {
    module.startSliceFile('/model.stl', 4, overridesJson);
    
    // Wait for output
    while (!outputReady) {
      await new Promise(r => setTimeout(r, 200));
    }
    
    // Check if gcode exists
    const gcodeBytes = module.FS.readFile('/model.gcode');
    fs.writeFileSync(outputPath, gcodeBytes);
    
    clearInterval(interval);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
