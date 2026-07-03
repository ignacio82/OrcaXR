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

app.post('/slice', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const overrides = req.body.overrides ? JSON.parse(req.body.overrides) : {};
  const configPath = req.file.path + '.json';
  
  try {
    // Write overrides to a JSON config file
    await fs.writeFile(configPath, JSON.stringify(overrides, null, 2));

    const outputPath = req.file.path + '.gcode';

    // Spawn orca-slicer (must be in PATH)
    // Note: Official OrcaSlicer CLI uses: orca-slicer --slice [file] --load [config] --output [output]
    const slicerProcess = spawn('orca-slicer', [
      '--slice', req.file.path,
      '--load', configPath,
      '--output', outputPath
    ]);

    // We can stream stderr as progress updates to the client using Server-Sent Events,
    // but for simplicity, we will just wait for it to finish and return the G-Code.
    // If the client wants progress, we should implement a chunked response or SSE.
    
    // To support progress, we will use HTTP chunked transfer encoding (text/plain)
    // where we emit progress lines, and then finally the G-Code.
    // But sending mixed content (progress + gcode) in one stream is tricky.
    // Let's just send the G-code and let the client know it might take a while.
    
    let stderrData = '';
    slicerProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
      // Optional: log progress
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
      await fs.unlink(req.file.path).catch(() => {});
      await fs.unlink(configPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    });

  } catch (err) {
    res.status(500).send(err.message);
    await fs.unlink(req.file.path).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OrcaXR External Slicer Server running on port ${PORT}`);
  console.log(`Make sure 'orca-slicer' is available in your PATH.`);
});
