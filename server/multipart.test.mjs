import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import multer from "multer";
import { createSlicerService } from "./server.js";
import { loadServerConfig } from "./security.mjs";

const boundary = "orcaxr-upload-regression";
const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="model.stl"\r\nContent-Type: application/octet-stream\r\n\r\nsolid model\nendsolid model\n\r\n--${boundary}\r\n`;

test("an abort before diskStorage assigns a filename leaves no orphan", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "orcaxr-upload-race-"),
  );
  let assignFilename;
  const enteredStorage = new Promise((resolve) => {
    assignFilename = resolve;
  });
  const storage = multer.diskStorage({
    destination: directory,
    filename: (_req, _file, callback) => assignFilename(callback),
  });
  const handleFile = storage._handleFile.bind(storage);
  let finishStorage;
  const storageFinished = new Promise((resolve) => {
    finishStorage = resolve;
  });
  storage._handleFile = (req, file, callback) =>
    handleFile(req, file, (...args) => {
      callback(...args);
      finishStorage();
    });
  // Hold the async filename callback at exactly the advisory's race window.
  const req = new PassThrough();
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "transfer-encoding": "chunked",
  };
  const completed = new Promise((resolve) =>
    multer({ storage }).single("file")(req, {}, resolve),
  );
  try {
    req.write(filePart);
    const assign = await enteredStorage;
    req.emit("aborted");
    req.destroy();
    assign(null, "delayed-upload");
    assert.ok(await completed);
    await storageFinished;
    // A late write must finish before checking that its cleanup finished too.
    const deadline = Date.now() + 1000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if ((await fs.readdir(directory)).length === 0) break;
    } while (Date.now() < deadline);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    req.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("real server survives malformed fields and repeated disconnected multipart uploads", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "orcaxr-upload-http-"),
  );
  let runs = 0;
  const service = createSlicerService({
    config: {
      ...loadServerConfig({}),
      maxRequestsPerWindow: 100,
      maxSliceRequestsPerWindow: 100,
    },
    uploadDirectory: directory,
    logger: { log() {}, warn() {}, error() {} },
    runner: async () => {
      runs += 1;
    },
  });
  const server = service.start(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 8; i += 1) {
      const req = http.request(`${url}/slice`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
      });
      req.on("error", () => {});
      req.write(filePart);
      // Wait for storage to have an actual file; this is an interrupted upload,
      // not just a TCP connection that never reached the multipart middleware.
      const deadline = Date.now() + 1000;
      while (
        (await fs.readdir(directory)).length === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const stored = await fs.readdir(directory);
      req.destroy();
      assert.equal(stored.length, 1);
      const cleaned = Date.now() + 1000;
      while ((await fs.readdir(directory)).length && Date.now() < cleaned) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(await fs.readdir(directory), []);
    }
    for (const name of [
      "overrides[999999999999999999999]",
      "overrides[__proto__][polluted]",
      "x".repeat(256),
    ]) {
      const body = `${filePart}Content-Disposition: form-data; name="${name}"\r\n\r\n{}\r\n--${boundary}--\r\n`;
      const response = await fetch(`${url}/slice`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      assert.ok(
        response.status >= 400 && response.status < 500,
        `Malformed field ${name} returned ${response.status}`,
      );
      await response.arrayBuffer();
      assert.deepEqual(await fs.readdir(directory), []);
    }
    assert.equal(runs, 0);
    assert.equal({}.polluted, undefined);
    assert.equal((await fetch(`${url}/ping`)).status, 200);
  } finally {
    await service.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
