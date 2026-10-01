import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function spawnDetached(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    // The group outlives its leader. Never use exitCode to decide if it exists.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  } catch (error) {
    // If permission was lost, keep ownership until absence can be proved.
    if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
  }
}

async function hasLiveMembers(child) {
  if (!child.pid) return false;
  if (process.platform === "win32")
    return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
  if (process.platform !== "linux") return true;
  // Linux kill(0) includes zombies: they cannot run or hold open our files.
  // The container's init reaps adopted descendants; Node reaps its own child.
  // Any unreadable process record fails closed instead of assuming termination.
  const pids = await fs.readdir("/proc").catch(() => null);
  if (!pids) return true;
  const records = await Promise.all(
    pids
      .filter((name) => /^\d+$/.test(name))
      .map(async (pid) => {
        try {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return (
            Number(fields[2]) === child.pid && !["Z", "X"].includes(fields[0])
          );
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") return false;
          return true;
        }
      }),
  ).catch(() => [true]);
  return records.some(Boolean);
}

/** Linux/container guarantee: don't release a worker while owned group members run. */
export async function terminateProcessTree(child, graceMs = 5000) {
  if (!child?.pid) return;
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("close", resolve));
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (await hasLiveMembers(child)) {
    if (Date.now() >= deadline) break;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  if (await hasLiveMembers(child)) signalGroup(child, "SIGKILL");
  // A task stuck in uninterruptible kernel I/O remains owned and consumes its
  // slot until the kernel actually terminates it. A timeout cannot prove death.
  while (await hasLiveMembers(child)) await delay(25);
  await closed;
}

export async function waitForChild(
  child,
  signal,
  onData = () => {},
  killGraceMs = 5000,
) {
  let termination;
  const stop = () => (termination ??= terminateProcessTree(child, killGraceMs));
  const onAbort = () => {
    void stop().catch(() => {});
  };
  const onExit = () => {
    void stop().catch(() => {});
  };
  const completed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", onExit);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const result = await completed;
    await stop();
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("Slice cancelled"), {
            code: "SLICE_CANCELLED",
          });
    if (result.error) throw result.error;
    return result.code;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    child.removeListener("exit", onExit);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  }
}
