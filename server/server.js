import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const app = express();
app.use(cors());

const upload = multer({ dest: os.tmpdir() });

app.get('/ping', (req, res) => res.send('pong'));

app.post('/slice', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const overrides = req.body.overrides ? JSON.parse(req.body.overrides) : {};
  overrides['from'] = 'project'; // Required by OrcaSlicer to accept the json file
  const configPath = req.file.path + '.json';
  
  try {
    // Write overrides to a JSON config file
    await fs.writeFile(configPath, JSON.stringify(overrides, null, 2));

    const modelPath = req.file.path + '.stl';
    await fs.rename(req.file.path, modelPath);

    const outputPath = req.file.path + '.gcode';
    
    const maxSpaceSize = process.env.MAX_OLD_SPACE_SIZE || '4096';

    // Run the WASM slicer in a separate Node.js process to bypass memory limits
    // --max-old-space-size gives it configured memory
    const slicerProcess = spawn('node', [
      `--max-old-space-size=${maxSpaceSize}`,
      'slice_worker.mjs',
      modelPath,
      configPath,
      outputPath
    ]);

    let stderrData = '';
    slicerProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
      const text = data.toString();
      const m = text.match(/(\d+)%/);
      if (m) console.log(`[slicer] ${m[1]}%`);
    });

    slicerProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const gcode = await fs.readFile(outputPath);
          res.setHeader('Content-Type', 'text/plain');
          res.send(gcode);
        } catch (e) {
          res.status(500).send('Failed to read output G-Code: ' + e.message);
        }
      } else {
        res.status(500).send(`Slicer failed with code ${code}\nStderr:\n${stderrData}`);
      }

      // Cleanup
      await fs.unlink(modelPath).catch(() => {});
      await fs.unlink(configPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    });

  } catch (err) {
    res.status(500).send(err.message);
    await fs.unlink(req.file.path + '.stl').catch(() => {});
    await fs.unlink(req.file.path).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OrcaXR External Slicer Server running on port ${PORT}`);
  console.log(`Make sure 'orca-slicer' is available in your PATH.`);
});
