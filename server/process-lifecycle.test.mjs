import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCliSlice, terminateProcessTree } from "./server.js";
import { waitForChild } from "./owned-process.mjs";

async function live(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertTerminated(pid) {
  assert.equal(await live(pid), false, "the descendant is still running");
  if (process.env.ORCAXR_TEST_REQUIRE_REAP !== "1") return;
  // Qualification runs with docker --init. Assert adoption and reaping too,
  // rather than merely excluding a zombie from the set of running processes.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.stat(`/proc/${pid}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the container init did not reap the adopted descendant");
}

test(
  "termination escalates a surviving group after its leader exits",
  { skip: process.platform !== "linux", timeout: 5000 },
  async () => {
    const descendant = `process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => { process.stdout.write(String(child.pid)); process.exit(0); });
  `,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    leader.stdout.on("data", (chunk) => {
      output += chunk;
    });
    await once(leader, "close");
    const pid = Number(output);
    assert.ok(pid > 1);
    try {
      assert.equal(await live(pid), true);
      await terminateProcessTree(leader, 50);
      await assertTerminated(pid);
    } finally {
      try {
        process.kill(-leader.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  },
);

test(
  "cancellation waits for descendants even when the parent close event arrives first",
  { skip: process.platform !== "linux", timeout: 5000 },
  async () => {
    const descendant = `process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => { process.stdout.write(String(child.pid)); });
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const abort = new AbortController();
    let pid;
    try {
      await assert.rejects(
        waitForChild(
          leader,
          abort.signal,
          (chunk) => {
            pid = Number(chunk.toString());
            abort.abort(
              Object.assign(new Error("Requested cancellation"), {
                code: "SLICE_CANCELLED",
              }),
            );
          },
          100,
        ),
        { code: "SLICE_CANCELLED" },
      );
      assert.ok(pid > 1);
      await assertTerminated(pid);
      assert.ok(leader.exitCode !== null || leader.signalCode !== null);
    } finally {
      try {
        process.kill(-leader.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  },
);

for (const outcome of [
  "success",
  "exit17",
  "signal",
  "missing",
  "oversized",
  "exitBeforePipe",
  "cancel",
]) {
  test(
    `native output requires successful exit: ${outcome}`,
    { skip: process.platform !== "linux", timeout: 5000 },
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "orcaxr-native-test-"),
      );
      const outputPath = path.join(directory, "result.gcode");
      const abort = new AbortController();
      const launch = (_command, args, options) => {
        const out = args[args.indexOf("--outputdir") + 1];
        const fifo = args[args.indexOf("--pipe") + 1];
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
        const fs = require('node:fs');
        if (${JSON.stringify(outcome)} === 'exitBeforePipe') process.exit(17);
        fs.writeFileSync(process.argv[2], ${JSON.stringify("{}\n")});
        if (${JSON.stringify(outcome)} !== 'missing') fs.writeFileSync(process.argv[1] + '/part.gcode', ${JSON.stringify(outcome === "oversized" ? "x".repeat(200) : "G28\n")});
        if (${JSON.stringify(outcome)} === 'signal') process.kill(process.pid, 'SIGTERM');
        else if (${JSON.stringify(outcome)} === 'cancel') { process.stdout.write('cancel-ready'); setInterval(() => {}, 1000); }
        else process.exit(${outcome === "exit17" ? 17 : 0});
      `,
            out,
            fifo,
          ],
          { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (outcome === "cancel")
          child.stdout.once("data", () =>
            abort.abort(new Error("Requested cancellation")),
          );
        return child;
      };
      try {
        const result = runCliSlice(
          {
            modelPath: path.join(directory, "input.3mf"),
            outputPath,
            overrides: {},
            onProgress: () => {},
            signal: abort.signal,
            config: { childKillGraceMs: 50, maxGcodeBytes: 100 },
          },
          launch,
        );
        if (outcome === "success") {
          await result;
          assert.equal(await fs.readFile(outputPath, "utf8"), "G28\n");
        } else {
          await assert.rejects(result);
          await assert.rejects(fs.stat(outputPath), { code: "ENOENT" });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
}
